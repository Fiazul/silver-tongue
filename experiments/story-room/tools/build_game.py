#!/usr/bin/env python3
"""Build both playable chapters into the silver-tongue checkout this app lives in.

The app sits at experiments/story-room/; the game is the checkout root, two levels up.
Writes site/ko/ (the door opening) and site/merchant/ (the town) there. The merchant
chapter needs the compiled private merchant core: MERCHANT_CORE_DIST, or a sibling
st-merchant-core checkout's dist/ (the same default packages/market-web/build.mjs uses).
"""
import os
from pathlib import Path
import shutil
import subprocess

APP = Path(__file__).resolve().parents[1]
REPO = APP.parents[1]


def merchant_core():
    configured = os.environ.get('MERCHANT_CORE_DIST')
    core = Path(configured) if configured else REPO.parent / 'st-merchant-core' / 'dist'
    if not (core / 'market.js').is_file():
        raise RuntimeError(f'The compiled private merchant core is missing: no market.js in {core}. '
                           'Build silver-tongue-core first, then set MERCHANT_CORE_DIST to its dist/ directory.')
    return core.resolve()


def build():
    if not (REPO / 'package.json').is_file():
        raise RuntimeError(f'No silver-tongue checkout at {REPO}: this app must stay in experiments/story-room/.')
    core = merchant_core()
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Building the game requires Node 22 or newer on PATH; no node was found.')
    version = subprocess.run([node, '--version'], capture_output=True, text=True, check=True).stdout.strip()
    if int(version.lstrip('v').split('.')[0]) < 22:
        raise RuntimeError(f'Building the game requires Node 22 or newer on PATH; found {version} at {node}.')
    env = dict(os.environ, MERCHANT_CORE_DIST=str(core))
    npm = shutil.which('npm')
    if not npm:
        raise RuntimeError('Building the game requires npm.')
    if not (REPO / 'node_modules/esbuild/package.json').exists():
        # The private core package (@silver-tongue/core) comes from GitHub Packages:
        # GITHUB_PACKAGES_TOKEN must be set (see the root CLAUDE.md).
        subprocess.run([npm, 'ci', '--ignore-scripts'], cwd=REPO, env=env, check=True)
    for script in ('build:course', 'build:experiment'):
        subprocess.run([npm, 'run', script], cwd=REPO, env=env, check=True)
    print(f'Built the door opening and the merchant town in {REPO / "site"}/ (ko/, merchant/).')


if __name__ == '__main__':
    try:
        build()
    except RuntimeError as exc:
        raise SystemExit(str(exc))
