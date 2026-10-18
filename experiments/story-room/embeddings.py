"""Small best-effort Ollama embedding client; no credentials or dependencies."""
import json
import logging
import health
import math
import threading
import time
from http.client import HTTPException
from urllib.request import Request, urlopen
from urllib.parse import urlparse

LOG = logging.getLogger(__name__)
DEFAULTS = dict(provider='ollama', url='http://127.0.0.1:11434', model='nomic-embed-text',
                enabled=False, timeout=3, keyword_weight=.5, semantic_weight=.5, min_similarity=.5)
LOCK = threading.Lock()
BREAKS = {}
BUSY = set()


def settings(config=None):
    return dict(DEFAULTS, **(config or {}))


def validate(config):
    if config is not None and not isinstance(config, dict):
        raise ValueError('embeddings must be an object')
    c = settings(config)
    if (c['provider'] != 'ollama' or not isinstance(c['url'], str) or urlparse(c['url']).scheme not in ('http', 'https')
            or not urlparse(c['url']).netloc or not isinstance(c['model'], str) or not c['model'].strip()
            or type(c['enabled']) is not bool):
        raise ValueError('Invalid embeddings provider/url/model/enabled')
    for key in ('timeout', 'keyword_weight', 'semantic_weight', 'min_similarity'):
        if type(c[key]) not in (int, float) or not math.isfinite(c[key]):
            raise ValueError('Invalid embeddings ' + key)
    if not 0 < c['timeout'] <= 3 or min(c['keyword_weight'], c['semantic_weight']) < 0 or c['keyword_weight'] + c['semantic_weight'] <= 0 or not 0 <= c['min_similarity'] <= 1:
        raise ValueError('Invalid embeddings timeout/weights/similarity')
    return c


def valid_vector(vector):
    return (isinstance(vector, list) and bool(vector) and
            all(type(v) in (int, float) and math.isfinite(v) for v in vector) and
            any(v != 0 for v in vector))


def embed(inputs, config):
    """Inputs carry task prefixes; requests contain at most 16 inputs each."""
    c = settings(config)
    if not c['enabled'] or not inputs:
        return None
    key = (c['url'], c['model'])
    with LOCK:
        if BREAKS.get(key, 0) > time.monotonic() or key in BUSY:
            return None
        BUSY.add(key)
    try:
        vectors = []
        dimension = None
        for offset in range(0, len(inputs), 16):
            chunk = inputs[offset:offset + 16]
            request = Request(c['url'].rstrip('/') + '/api/embed',
                              data=json.dumps({'model': c['model'], 'input': chunk, 'keep_alive': '30m'}).encode(),
                              headers={'Content-Type': 'application/json'}, method='POST')
            with urlopen(request, timeout=c['timeout']) as response:
                batch = json.load(response)['embeddings']
            if (not isinstance(batch, list) or len(batch) != len(chunk) or
                    not all(valid_vector(v) for v in batch) or len({len(v) for v in batch}) != 1 or
                    (dimension is not None and len(batch[0]) != dimension)):
                raise ValueError('Invalid embedding vectors')
            dimension = len(batch[0])
            vectors.extend(batch)
        return vectors
    except (OSError, HTTPException, ValueError, KeyError, TypeError) as exc:
        with LOCK:
            BREAKS[key] = time.monotonic() + 60
        health.emit('embeddings_fallback', reason='using keyword retrieval for 60 seconds')
        LOG.warning('Embeddings unavailable; using keywords for 60s: %s', exc)
        return None
    finally:
        with LOCK:
            BUSY.discard(key)


def cosine(left, right):
    if not valid_vector(left) or not valid_vector(right) or len(left) != len(right):
        return 0.
    norm = math.sqrt(sum(x*x for x in left) * sum(x*x for x in right))
    return max(-1., min(1., sum(x*y for x, y in zip(left, right)) / norm)) if norm else 0.
