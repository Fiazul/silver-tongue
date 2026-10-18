"""Local chat uploads, stored separately from project attachments."""
import base64
import hashlib
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parent / 'data' / 'uploads'
MAX_BYTES = 5 * 1024 * 1024


def store(data_url):
    if not isinstance(data_url, str) or ',' not in data_url:
        raise ValueError('Choose a PNG, JPEG, WebP, or GIF image')
    header, encoded = data_url.split(',', 1)
    formats = {'data:image/png;base64': ('.png', b'\x89PNG\r\n\x1a\n'),
               'data:image/jpeg;base64': ('.jpg', b'\xff\xd8\xff'),
               'data:image/gif;base64': ('.gif', b'GIF'),
               'data:image/webp;base64': ('.webp', b'RIFF')}
    if header not in formats:
        raise ValueError('Choose a PNG, JPEG, WebP, or GIF image')
    try:
        payload = base64.b64decode(encoded, validate=True)
    except ValueError:
        raise ValueError('Invalid image data') from None
    suffix, signature = formats[header]
    if not 12 <= len(payload) <= MAX_BYTES:
        raise ValueError('Images must be under 5 MB')
    if not payload.startswith(signature) or (suffix == '.webp' and payload[8:12] != b'WEBP'):
        raise ValueError('Image format does not match its contents')
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    path = DIRECTORY / (hashlib.sha256(payload).hexdigest() + suffix)
    path.write_bytes(payload)
    return str(path)


def checked(value):
    path = Path(value).resolve(strict=True)
    if path.parent != DIRECTORY.resolve() or len(path.stem) != 64 or any(c not in '0123456789abcdef' for c in path.stem):
        raise ValueError('Invalid uploaded image path')
    if path.suffix not in ('.png', '.jpg', '.gif', '.webp') or path.stat().st_size > MAX_BYTES:
        raise ValueError('Invalid uploaded image')
    return path
