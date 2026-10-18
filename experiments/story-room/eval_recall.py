#!/usr/bin/env python3
"""Read-only recall evaluation. No providers, server imports, or store writes."""
import argparse
import json
from pathlib import Path

import life_memory


class ReadOnlyStore(life_memory.Store):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Read-only: never create the cross-process lock file inside the data directory.
        self.lock = self.room_lock

    def _write(self, *args, **kwargs):
        raise RuntimeError('Recall evaluation must never write')

    def apply(self, *args, **kwargs):
        raise RuntimeError('Recall evaluation must never write')


def evaluate(data, embedding_config=None):
    resets = data / 'character-resets.json'
    boundary = json.loads(resets.read_text()).get('Iris', 0) if resets.exists() else 0
    store = ReadOnlyStore(data / 'life', 'Iris', boundary=boundary,
                          embedding_config=embedding_config, vector_writes=False)
    hybrid = bool(embedding_config and embedding_config.get('enabled'))
    print('MODE: ' + ('hybrid' if hybrid else 'keyword-only'))
    messages = [json.loads(line) for line in (data / 'messages.jsonl').read_text().splitlines() if line.strip()]
    records = [(segment, record) for segment in life_memory.SEGMENTS for record in store.load_segment(segment)]
    selectors = {
        'first-date Antarctica': lambda s, r: s == 'milestones' and all(t in r['text'].lower() for t in ('first date', 'antarctica')),
        'aurora outing/photo': lambda s, r: s == 'events' and r['source_id'] == '1792065318425447303',
        'candid-shots event': lambda s, r: s == 'events' and r['source_id'] == '1792061672222550991',
        'Ryoma age 26': lambda s, r: s == 'people' and all(t in r['text'].lower() for t in ('ryoma', '26', 'own clock')),
        'glass flower gift': lambda s, r: s == 'gifts' and all(t in r['text'].lower() for t in ('flower', 'glass petals')),
    }
    expected = {label: {r['id'] for s, r in records if match(s, r)} for label, match in selectors.items()}
    cases = [
        ('do you remember our date?', ['first-date Antarctica', 'aurora outing/photo']),
        ('you dont remember the vella picture i shared?', ['candid-shots event']),
        ('do you remember my age iris?', ['Ryoma age 26']),
        ('what did i give you?', ['glass flower gift']),
        ('do you remember mr whiskers on our date', ['aurora outing/photo']),
    ]
    passed = True
    available = True
    for query, required in cases:
        focus = dict(name='Mystery', to='Iris', channel='dm', kind='chat', text=query)
        context = life_memory.retrieval_context(store, messages + [focus], focus)
        if hybrid and not store.last_semantic:
            available = False
        top = context.records[:5]
        found = {r['id'] for _, r in top}
        ok = all(expected[label] and expected[label] <= found for label in required)
        if 'candid-shots event' in required:
            source = next((m for m in life_memory.visible_messages(messages, 'Iris', boundary)
                           if m.get('id') == '1792061672222550991'), {})
            paths = source.get('attachments', [])
            ok = ok and bool(paths) and any(p in context.images and Path(p).is_file() for p in paths)
        print(query)
        for i, (segment, record) in enumerate(top, 1):
            print(f"  {i}. {segment} #{record['id']}: {record['text']}")
        if context.images:
            print('  Images: ' + ', '.join(context.images))
        status = 'PASS' if ok else 'FAIL'
        if hybrid and not store.last_semantic:
            status = 'UNVERIFIED (keyword fallback ' + status + ')'
        print('  ' + status)
        passed = passed and ok
    print('ALL PASS' if passed and available else 'HYBRID UNAVAILABLE (keyword fallback)' if not available else 'RECALL EVALUATION FAILED')
    return passed and available


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=Path(__file__).resolve().parent / 'data')
    parser.add_argument('--config', type=Path, default=Path(__file__).resolve().parent / 'agents.json')
    parser.add_argument('--mode', choices=('both', 'keyword', 'hybrid'), default='both')
    args = parser.parse_args()
    passed = True
    if args.mode in ('both', 'keyword'):
        passed = evaluate(args.data_dir)
    if args.mode in ('both', 'hybrid'):
        config = json.loads(args.config.read_text()).get('embeddings', {})
        config['enabled'] = True
        passed = evaluate(args.data_dir, config) and passed
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
