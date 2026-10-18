"""Bounded operational events. Callers supply fixed summaries, never model/provider text."""
from collections import deque
from datetime import datetime, timezone
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import threading
import time

EVENTS = deque(maxlen=50)
FAILURE_TIMES = deque()
LOCK = threading.RLock()
MEMORY_SWEEPS = {}
FAILURES = {'turn_failure', 'provider_break', 'provider_failure', 'memory_sweep_failure',
            'embeddings_fallback', 'alarm_missed', 'alarm_failed'}


def emit(event, character='', reason='', **details):
    with LOCK:
        now = time.time()
        while FAILURE_TIMES and FAILURE_TIMES[0] < now - 3600:
            FAILURE_TIMES.popleft()
        if event in FAILURES:
            FAILURE_TIMES.append(now)
        EVENTS.append(dict(time=datetime.now(timezone.utc).isoformat(), event=event,
                           character=character, reason=reason, **details))


def sweep_backlog(character, remaining):
    with LOCK:
        MEMORY_SWEEPS[character] = remaining


def snapshot():
    with LOCK:
        events = [dict(row) for row in EVENTS]
        cutoff = time.time() - 3600
        while FAILURE_TIMES and FAILURE_TIMES[0] < cutoff:
            FAILURE_TIMES.popleft()
        return dict(events=events, failures_last_hour=len(FAILURE_TIMES), memory_sweeps=dict(MEMORY_SWEEPS))


def configure_logging(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    formatter = logging.Formatter('%(asctime)s %(levelname)s %(name)s: %(message)s')
    if not root.handlers:
        stream = logging.StreamHandler()
        stream.setFormatter(formatter)
        root.addHandler(stream)
    target = str((directory / 'server.log').resolve())
    for handler in root.handlers:
        if isinstance(handler, RotatingFileHandler) and handler.baseFilename == target:
            return handler
    handler = RotatingFileHandler(target, maxBytes=1024 * 1024, backupCount=3, encoding='utf-8')
    handler.setFormatter(formatter)
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    return handler
