#!/usr/bin/env python3
"""Run discovery in a disposable source copy with live state inaccessible.

Copies only source, web assets and test fixtures. Never reads,
chmods or writes the real data/, logs/ or agents.json. An audit hook also denies
opening those paths in both the original tree and the copy (even as root).
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    source = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix='private-room-hermetic-') as temporary:
        root = Path(temporary)
        copy = root / 'repo'
        copy.mkdir()
        for path in source.glob('*.py'):
            shutil.copy2(path, copy / path.name)
        for name in ('web', 'tools', 'tests'):
            shutil.copytree(source / name, copy / name,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        # These are deliberately invalid and unreadable, not snapshots of live state.
        (copy / 'agents.json').write_text('LIVE CONFIG MUST NOT BE READ')
        (copy / 'agents.json').chmod(0)
        (copy / 'data').mkdir(mode=0)
        guard = root / 'guard'
        guard.mkdir()
        (guard / 'sitecustomize.py').write_text('''\
import atexit
import os
from pathlib import Path
import sys

roots = [Path(os.environ['HERMETIC_SOURCE']), Path(os.environ['HERMETIC_COPY'])]
denied = []
def guard(event, args):
    if event != 'open' or not isinstance(args[0], (str, bytes, os.PathLike)):
        return
    path = Path(os.fsdecode(args[0])).resolve()
    for root in roots:
        # Audit events omit os.open's dir_fd. A cleanup open of the relative
        # directory name "data" can belong to a temporary parent, not cwd.
        # Guard file descendants, leaving directory-only opens to permissions.
        if path == root / 'agents.json' or any(
                (root / name) in path.parents for name in ('data', 'logs')):
            denied.append(str(path))
            raise PermissionError('Hermeticity guard: live state is unreadable')
sys.addaudithook(guard)
# Prove the guard is active, including against the original paths, before discovery.
for root in roots:
    for path in (root / 'agents.json', root / 'data' / 'relationships.json'):
        try:
            open(path)
        except PermissionError:
            pass
        else:
            raise AssertionError('Live-state guard was bypassed')
denied.clear()
def report():
    print('Hermeticity guard: %d live-state open attempts during discovery/tests' % len(denied), file=sys.stderr)
    if denied:
        print('Blocked paths: ' + repr(sorted(set(denied))), file=sys.stderr)
atexit.register(report)
''')
        env = dict(os.environ, PYTHONPATH=str(guard), HERMETIC_SOURCE=str(source), HERMETIC_COPY=str(copy))
        print('Disposable copy; original and copied live state blocked by audit hook.', flush=True)
        args = sys.argv[1:] or ['discover', '-q']
        print('Running: python3 -m unittest ' + ' '.join(args), flush=True)
        try:
            return subprocess.run([sys.executable, '-m', 'unittest', *args], cwd=copy, env=env).returncode
        finally:
            # Restore only disposable permissions so TemporaryDirectory can clean up.
            (copy / 'agents.json').chmod(0o600)
            (copy / 'data').chmod(0o700)


if __name__ == '__main__':
    sys.exit(main())
