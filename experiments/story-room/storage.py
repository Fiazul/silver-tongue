"""Shared durable-file helpers: unique-temp atomic writes and cross-process locks (stdlib, POSIX).

Every JSON/state file that is rewritten in place goes through atomic_write(): a uniquely
named temporary file in the same directory is written, fsynced and os.replace()d over
the target, so two writers can never clobber each other's half-written temp file.

Read-modify-write sequences that another *process* can also perform (life stores are
written by backfill_memory.py as well as the server) additionally hold an exclusive
fcntl.flock on a sidecar lock file. ProcessLock is reentrant inside one process: nested
acquisitions from the same thread share one flock, other threads wait on the in-process
RLock first, so a second open file description can never self-deadlock on flock.
"""
import fcntl
import os
from pathlib import Path
import tempfile
import threading

_REGISTRY = {}
_REGISTRY_LOCK = threading.Lock()


def atomic_write(path, text, encoding='utf-8'):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding=encoding) as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


class ProcessLock:
    """Exclusive flock on one lock file, reentrant within this process."""

    def __init__(self, path):
        self.path = Path(path)
        self.thread_lock = threading.RLock()
        self.depth = 0
        self.fd = None

    def acquire(self, blocking=True):
        if not self.thread_lock.acquire(blocking):
            return False
        try:
            if self.depth == 0:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
                except BlockingIOError:
                    os.close(fd)
                    self.thread_lock.release()
                    return False
                except BaseException:
                    os.close(fd)
                    raise
                self.fd = fd
            self.depth += 1
            return True
        except BaseException:
            self.thread_lock.release()
            raise

    def release(self):
        try:
            self.depth -= 1
            if self.depth == 0:
                fd, self.fd = self.fd, None
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                finally:
                    os.close(fd)
        finally:
            self.thread_lock.release()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *_):
        self.release()


def process_lock(path):
    """One shared ProcessLock per lock-file path, so separate objects nest safely."""
    key = os.path.abspath(path)
    with _REGISTRY_LOCK:
        lock = _REGISTRY.get(key)
        if lock is None:
            lock = _REGISTRY[key] = ProcessLock(key)
        return lock


def lock_for(path):
    """Sidecar lock for a single shared file: data/x.json -> data/.x.json.lock."""
    path = Path(path)
    return process_lock(path.with_name('.' + path.name + '.lock'))


class Combined:
    """Acquire locks in a fixed order (room lock first, then file lock); release in reverse."""

    def __init__(self, *locks):
        self.locks = locks

    def acquire(self, blocking=True):
        entered = []
        try:
            for lock in self.locks:
                if not lock.acquire(blocking):
                    break
                entered.append(lock)
            else:
                return True
        except BaseException:
            for lock in reversed(entered):
                lock.release()
            raise
        for lock in reversed(entered):
            lock.release()
        return False

    def release(self):
        for lock in reversed(self.locks):
            lock.release()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *_):
        self.release()

