#!/usr/bin/env python3
"""Open or start this independent story edition without creating duplicate servers."""
import argparse
import fcntl
import json
from pathlib import Path
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen
import webbrowser

ROOT = Path(__file__).resolve().parent  # experiments/story-room/ in a silver-tongue checkout
EDITION = 'make-it-in-china-room'


def existing_edition(url):
    try:
        with urlopen(url + '/api/edition', timeout=1) as response:
            data = json.load(response)
        return isinstance(data, dict) and data.get('edition') == EDITION and data.get('instance') == str(ROOT)
    except (URLError, TimeoutError, ValueError, OSError):
        return False


def launch(port=8876, open_browser=True):
    repo = ROOT.parents[1]  # the checkout root: package.json and the built site/
    pages = [repo / 'site/ko/index.html', repo / 'site/merchant/index.html']
    if (repo / 'package.json').is_file() and not all(page.is_file() for page in pages):
        if subprocess.run([sys.executable, str(ROOT / 'tools/build_game.py')], cwd=ROOT).returncode:
            raise RuntimeError('Building the game failed; see the message above.')
    (ROOT / 'data').mkdir(exist_ok=True)
    url = f'http://127.0.0.1:{port}'
    with (ROOT / 'data' / '.launcher.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            recorded = json.loads((ROOT / 'data' / 'server.pid').read_text())
            saved_port = recorded.get('port') if isinstance(recorded, dict) else None
            if type(saved_port) is int and 0 < saved_port <= 65535:
                saved_url = f'http://127.0.0.1:{saved_port}'
                if existing_edition(saved_url):
                    url = saved_url
        except (OSError, ValueError):
            pass
        if not existing_edition(url):
            (ROOT / 'logs').mkdir(exist_ok=True)
            with (ROOT / 'logs' / 'launcher.log').open('a') as log:
                child = subprocess.Popen([sys.executable, str(ROOT / 'server.py'), '--port', str(port)],
                                         cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                         start_new_session=True)
            for _ in range(100):
                if existing_edition(url):
                    break
                if child.poll() is not None:
                    raise RuntimeError(f'The story server could not start on port {port}. '
                                       f'See {ROOT / "logs/launcher.log"}. Try --port with a free port.')
                time.sleep(.1)
            else:
                child.terminate()
                raise RuntimeError('The story server did not become ready. See logs/launcher.log.')
    if open_browser:
        webbrowser.open(url)
    return url


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8876)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    try:
        print(launch(args.port, not args.no_browser))
    except (OSError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
