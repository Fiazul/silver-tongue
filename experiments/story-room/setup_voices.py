#!/usr/bin/env python3
"""Download the cast's Piper voices; reuse installed voices where available."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/'
VOICE_DIR = ROOT / 'data' / 'voices'
SHARED = Path.home() / '.local' / 'share' / 'piper'


def main():
    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    with urlopen(BASE + 'voices.json', timeout=30) as response:
        catalog = json.load(response)
    cast = json.loads((ROOT / 'agents.json').read_text())['agents']
    names = sorted({a['voice'] for a in cast})

    def download(name):
        for remote, info in catalog[name]['files'].items():
            filename = Path(remote).name
            if filename == 'MODEL_CARD':
                destination = VOICE_DIR / (name + '.MODEL_CARD')
            else:
                destination = VOICE_DIR / filename
            shared = SHARED / filename
            if filename != 'MODEL_CARD' and shared.exists() and shared.stat().st_size == info['size_bytes']:
                continue
            if destination.exists() and destination.stat().st_size == info['size_bytes']:
                continue
            temporary = destination.with_suffix(destination.suffix + '.part')
            digest = hashlib.md5()
            with urlopen(BASE + remote, timeout=120) as response, temporary.open('wb') as out:
                while block := response.read(1024 * 1024):
                    out.write(block)
                    digest.update(block)
            if temporary.stat().st_size != info['size_bytes'] or digest.hexdigest() != info['md5_digest']:
                temporary.unlink(missing_ok=True)
                raise RuntimeError(f'Download verification failed: {name}')
            temporary.replace(destination)
        print(f'Ready: {name}', flush=True)

    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(download, names))
    print(f'All {len(cast)} character voices are ready.', flush=True)


if __name__ == '__main__':
    main()
