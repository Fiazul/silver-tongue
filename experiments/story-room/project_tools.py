"""Read-only project discovery and image sharing for the fictional cast."""
import json
import mimetypes
import os
from pathlib import Path
import re

ROOTS = ()  # Story edition: the cast cannot inspect any other project on this machine.
PRIVATE_ROOT = Path(__file__).resolve().parent
SKIP = {'.git', '.venv', 'venv', 'node_modules', '__pycache__', 'data', 'dist', 'build', '.next', '.cache', 'all_projects'}
IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp', '.gif'}


def checked_path(value):
    if not isinstance(value, str) and not isinstance(value, Path):
        raise ValueError('Project path must be a string')
    path = Path(value).expanduser().resolve(strict=True)
    if path.is_relative_to(PRIVATE_ROOT):
        raise ValueError('Private Room files and chat uploads are not project assets')
    if not any(path.is_relative_to(root.resolve()) for root in ROOTS):
        raise ValueError('Project inspection is disabled in the story edition')
    if any(part.startswith('.') and part != '.playwright-mcp' for part in path.parts):
        raise ValueError('Hidden/private paths are not available to the cast')
    return path


def image_path(value):
    path = checked_path(value)
    if not path.is_file() or path.suffix.lower() not in IMAGE_SUFFIXES or path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError('Attachment must be an existing project image under 8 MB')
    with path.open('rb') as source:
        header = source.read(12)
    valid = (header.startswith(b'\x89PNG\r\n\x1a\n') or header.startswith(b'\xff\xd8\xff')
             or header.startswith((b'GIF87a', b'GIF89a')) or (header[:4] == b'RIFF' and header[8:12] == b'WEBP'))
    if not valid:
        raise ValueError('Attachment is not a supported image')
    return path


def inspect_projects(query='', project=None):
    if not isinstance(query, str) or len(query) > 200:
        raise ValueError('Inspection query must be a short string')
    if project:
        candidates = [checked_path(project)]
    else:
        candidates = []
        for root in (*ROOTS, *(root / 'all_projects' for root in ROOTS)):
            if root.is_dir():
                candidates.extend(p for p in root.iterdir() if p.is_dir() and not p.name.startswith('.')
                                  and p.name not in SKIP and p.name != 'private_room')
        candidates = list(dict.fromkeys(candidates))
        safe = []
        for candidate in candidates:
            try:
                safe.append(checked_path(candidate))
            except (ValueError, OSError):
                pass
        candidates = safe
    words = set(re.findall(r'[a-z0-9]{3,}', query.lower())) - {'project', 'work', 'making', 'the', 'this'}
    def score(path):
        context = path.name.lower()
        for name in ('README.md', 'readme.md', 'README.txt'):
            readme = path / name
            try:
                if readme.is_file():
                    with checked_path(readme).open(encoding='utf-8', errors='replace') as source:
                        context += ' ' + source.read(2000).lower()
                    break
            except (ValueError, OSError):
                continue
        return sum(4 * bool(re.search(r'\b' + re.escape(word) + r'\b', path.name.lower())) + bool(re.search(r'\b' + re.escape(word) + r'\b', context)) for word in words)
    candidates.sort(key=lambda path: (-score(path), path.name))
    if words:
        matching = [path for path in candidates if score(path) > 0]
        if matching:
            candidates = matching[:3]
        elif not project:
            return {'projects': [{'name': p.name, 'path': str(p)} for p in candidates[:30]],
                    'note': 'No project matched that topic. These are real folders only; no game or image is confirmed. Do not invent a match.'}
    result = []
    for candidate in candidates[:8]:
        candidate = checked_path(candidate)
        if not candidate.is_dir():
            continue
        item = {'name': candidate.name, 'path': str(candidate), 'files': [], 'images': []}
        for filename in ('README.md', 'readme.md', 'README.txt'):
            readme = candidate / filename
            if readme.is_file():
                item['readme_excerpt'] = checked_path(readme).read_text(encoding='utf-8', errors='replace')[:1600]
                break
        for current, directories, files in os.walk(candidate, followlinks=False):
            depth = len(Path(current).relative_to(candidate).parts)
            directories[:] = [d for d in directories if d not in SKIP and (not d.startswith('.') or d == '.playwright-mcp') and depth < 3]
            for filename in sorted(files):
                if filename.startswith('.') or any(secret in filename.lower() for secret in ('credential', 'secret', 'auth.json', '.pem', '.key')):
                    continue
                path = Path(current) / filename
                if len(item['files']) < 40:
                    item['files'].append(str(path.relative_to(candidate)))
                if path.suffix.lower() in IMAGE_SUFFIXES and len(item['images']) < 20:
                    try:
                        item['images'].append(str(image_path(str(path))))
                    except (ValueError, OSError):
                        pass
            if len(item['files']) >= 40 and len(item['images']) >= 20:
                break
        item['images'].sort(key=lambda s: (-sum(word in s.lower() for word in ('screenshot', 'preview', 'capture', 'screen', 'demo')), len(s)))
        item['images'] = item['images'][:5]
        result.append(item)
    return {'projects': result, 'note': 'Real local files, read-only. Image paths may be shared. Do not invent missing screenshots or claim files were changed.'}


def image_mime(path):
    return mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
