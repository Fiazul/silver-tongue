#!/usr/bin/env python3
"""Read-only science retrieval evaluation for Vella. No providers, server imports, or store writes.

Checks, per question: the expected authored answers rank in the top 5, raw computed
readouts appear only for numeric asks, the rendered block leaks no FAQ/record ids or
ledger keys (chat-earned records keep their '(#id)' resolve marker by design; seeded lore
never may), and unrelated chat banter is not offered as evidence."""
import argparse
import json
from pathlib import Path
import re

import life_memory

ROOT = Path(__file__).resolve().parent
LEAKED_ID = re.compile(r'\b[FA]\d{3}\b|\[physics:|\(#[0-9a-f]{6,}\)')
BANTER = [
    dict(id='9001', name='Theo', channel='group', kind='chat', text='Iris, you drive like a rocket. Fast and terrifying.'),
    dict(id='9002', name='Iris', channel='group', kind='chat', text='Theo that pasta has more fuel than flavour, honestly.'),
]
# (question, [any-of expected question/heading fragments] per required slot, numeric ask)
CASES = [
    ('@Vella no fusion rocket can reach 0.998c, the rocket equation forbids it. So how did you do it?',
     [['Is your drive accepted physics?', 'Does uniformly reducing all rocket masses help?',
       'The one exotic system: Asterion inertia field'],
      ['Asterion']], False),
    ('@Vella where does your energy actually come from?',
     [['Where does the usable energy come from?']], False),
    ('@Vella at that speed, wouldn’t the interstellar gas and radiation fry everyone aboard?',
     [['What strikes the shield at gamma about twenty-eight?', 'What would an unshielded person receive?',
       'Did you forget Lorentz contraction in particle flux?', 'How can a magnet deflect these protons?']], False),
    ('@Vella what happens if you hit a speck of dust that fast?',
     [['Is a microgram of dust really dangerous?']], False),
    ('@Vella your shield read 117% at Proxima. Isn’t anything over 100% a failure?',
     [['How can a shield display exceed a hundred percent?', 'Was the Proxima event secretly an overload?']], False),
    ('@Vella couldn’t Sirius just have drifted by ordinary proper motion?',
     [['Could ordinary proper motion explain it?']], False),
    ('@Vella does that parallax prove we actually moved light-years?',
     [['Does parallax prove we moved three light-years?']], False),
    ('@Vella why can’t you just skim past a neutron star? Wouldn’t the tides tear the ship apart?',
     [['What is a safe neutron-star distance?', 'What are the tides at closer radii?',
       'Why did a neutron-star flyby kill people if you have inertia damping?']], False),
    ('@Vella is the wormhole your secret engine?',
     [['Are the wormholes your second secret engine?', 'Can seeing a wormhole-like transit prove who built Asterion?']],
     False),
    ('@Vella did cryosleep really stop him aging all those years?',
     [['Why did the first flight age him so little?', 'Could you sneak the repair years into cryo',
       'Does cryo protect against radiation?', 'If Hana’s cryosupport failed, how can Ryoma later sleep?']], False),
    ('@Vella explain the twin paradox: why is the ship clock the one that runs slow?',
     [['Where is the twin-paradox asymmetry?']], False),
    ('@Vella why won’t you leave the atmosphere?',
     [['Why refuse to leave the atmosphere?', 'This sky']], False),
    # Numeric control: a specific quantity may bring a (capped) computed readout.
    ('@Vella what is the photon rocket mass ratio for the first trip?',
     [['961.72']], True),
]


class ReadOnlyStore(life_memory.Store):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Read-only: never create the cross-process lock file inside the data directory.
        self.lock = self.room_lock

    def _write(self, *args, **kwargs):
        raise RuntimeError('Vella evaluation must never write')

    def apply(self, *args, **kwargs):
        raise RuntimeError('Vella evaluation must never write')


def open_store(data, name='Vella', embedding_config=None):
    resets = data / 'character-resets.json'
    boundary = json.loads(resets.read_text()).get(name, 0) if resets.exists() else 0
    return ReadOnlyStore(data / 'life', name, boundary=boundary,
                         embedding_config=embedding_config, vector_writes=False)


def allowed_markers_removed(context):
    """The block minus the '(#id)' resolve markers that retrieval appends to chat-earned
    (non-lore) records by design. Ids or markers inside seeded lore text still count."""
    block = context.block
    for _, record in context.records:
        if not record.get('retrieval_only'):
            block = block.replace(f" (#{record['id']})", '')
    return block


def evaluate(store, cases=CASES, out=print):
    """Return (passed, semantic_used_for_every_query)."""
    hybrid = store.embedding_config['enabled']
    out('MODE: ' + ('hybrid' if hybrid else 'keyword-only'))
    passed, semantic = True, True
    for question, slots, numeric in cases:
        focus = dict(id='9100', name='Iris', to='Vella', channel='group', kind='chat', text=question)
        context = life_memory.retrieval_context(store, BANTER + [focus], focus, kind='ship_ai')
        semantic = semantic and (not hybrid or store.last_semantic)
        top = context.records[:5]
        texts = [r['text'] for _, r in top]
        problems = [f'missing any of {slot[:2]}' for slot in slots
                    if not any(fragment in text for fragment in slot for text in texts)]
        readouts = [r for _, r in context.records if life_memory.is_physics_readout(r)]
        if readouts and not numeric:
            problems.append(f'{len(readouts)} raw readouts on a non-numeric ask')
        if len(readouts) > life_memory.MAX_READOUTS:
            problems.append('readout cap exceeded')
        leak = LEAKED_ID.search(allowed_markers_removed(context))
        if leak:
            problems.append('id leaked in block: ' + leak.group())
        if 'From that conversation' in context.block:
            problems.append('chat banter offered as science evidence')
        out(question)
        for i, (segment, record) in enumerate(top, 1):
            out(f'  {i}. {segment}: {record["text"][:150]}')
        out('  ' + ('PASS' if not problems else 'FAIL: ' + '; '.join(problems)))
        passed = passed and not problems
    return passed, semantic


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=ROOT / 'data')
    parser.add_argument('--config', type=Path, default=ROOT / 'agents.json')
    parser.add_argument('--mode', choices=('both', 'keyword', 'hybrid'), default='both')
    args = parser.parse_args()
    if not (args.data_dir / 'life' / 'Vella' / 'index.json').exists():
        parser.exit(2, f'No Vella store under {args.data_dir}\n')
    ok = True
    if args.mode in ('both', 'keyword'):
        ok = evaluate(open_store(args.data_dir))[0]
    if args.mode in ('both', 'hybrid'):
        config = dict(json.loads(args.config.read_text()).get('embeddings', {}), enabled=True)
        passed, semantic = evaluate(open_store(args.data_dir, embedding_config=config))
        if not semantic:
            print('HYBRID UNAVAILABLE (keyword fallback used for some queries)')
        ok = ok and passed and semantic
    print('ALL PASS' if ok else 'VELLA EVALUATION FAILED')
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
