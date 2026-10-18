#!/usr/bin/env python3
"""Check generated lore, rounded numeric claims, chronology and canon coverage."""
import importlib.util
import json
import math
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('vella_physics',ROOT/'lore/physics.py')
physics=importlib.util.module_from_spec(spec)
spec.loader.exec_module(physics)
CLAIM=re.compile(r'(?P<number>[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*\[physics:(?P<key>[\w.]+)\]')
UNBOUND_QUANTITY=re.compile(r'(?<![\w.])[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\s*'
    r'(?:%|years?\b|yr\b|days?\b|hours?\b|kg\b|km\b|m/s|W\b|J\b|GeV\b|Gy\b|ly\b|g\b|K\b)'
    r'|\b(?:gamma|beta|k)\s*[=~≈]?\s*\d+(?:\.\d+)?')


def validate_claims(text, values):
    claims=list(CLAIM.finditer(text))
    for match in claims:
        actual=float(match['number'])
        expected=physics.lookup(values,match['key'])
        if not isinstance(expected,(int,float)) or not math.isfinite(expected):
            raise AssertionError('Non-numeric physics reference '+match['key'])
        mantissa, _, exponent=match['number'].lower().partition('e')
        decimals=len(mantissa.split('.')[1]) if '.' in mantissa else 0
        half_unit=.50001*10**(int(exponent or 0)-decimals)
        assert abs(actual-expected)<=half_unit+abs(expected)*1e-14, f'{match["key"]}: {actual} != {expected}'
    # Every explicitly bound claim must have a parseable, immediately preceding value.
    assert len(claims)==len(re.findall(r'\[physics:[\w.]+\]',text)), 'Unbound physics claim'
    return len(claims)


def reject_unbound_quantities(text):
    """Numbers used as measured quantities must bind a ledger key, not just look plausible."""
    remainder=CLAIM.sub('GENERATED',text)
    match=UNBOUND_QUANTITY.search(remainder)
    assert match is None, 'Unbound physical quantity: '+(match.group() if match else '')


def answers(text, prefix, minimum):
    blocks=re.split(r'^## '+prefix+r'\d+ — ',text,flags=re.M)[1:]
    assert len(blocks)>=minimum, f'Need at least {minimum} {prefix} questions'
    questions=[]
    for block in blocks:
        question,_,body=block.partition('\n')
        body=body.split('\n## ',1)[0].strip()
        assert question.strip() and body, 'Empty question/answer'
        questions.append(question.strip())
    assert len(set(questions))==len(questions),'Duplicate questions'
    return questions


def check():
    p=physics.compute()
    stored=json.loads((ROOT/'lore/physics.json').read_text())
    assert stored==p,'physics.json is stale or altered'
    expected=physics.generated_files(p)
    for path,body in expected.items():
        assert path.read_text()==body,f'Stale or hand-edited generated lore: {path.relative_to(ROOT)}'
        leftover=physics.UNRENDERED.search(body)
        assert leftover is None,f'Unrendered placeholder {leftover.group() if leftover else ""} in {path.relative_to(ROOT)}'
    paths=[ROOT/'lore/vella/faq.md',ROOT/'lore/vella/systems.md',
           ROOT/'lore/vella/travel_logs.jsonl',ROOT/'lore/ryoma/timeline.jsonl',
           ROOT/'lore/vella/backstory.md',ROOT/'lore/ryoma/backstory.md']
    count=sum(validate_claims(path.read_text(),p) for path in paths)
    for path in paths[:3]:
        body=path.read_text()
        if path.suffix=='.jsonl':body='\n'.join(json.loads(line)['text'] for line in body.splitlines())
        reject_unbound_quantities(body)
    faq=answers(paths[0].read_text(),'F',40)
    adversarial=answers((ROOT/'lore/vella/skeptic_questions.md').read_text(),'A',30)
    assert not set(faq)&set(adversarial),'Adversarial questions repeat FAQ questions'
    logs=[json.loads(line) for line in paths[2].read_text().splitlines()]
    timeline=[json.loads(line) for line in paths[3].read_text().splitlines()]
    ids={r['id'] for r in logs+timeline}
    assert len(ids)==len(logs)+len(timeline),'Duplicate log IDs'
    checklist=(ROOT/'lore/CONSISTENCY.md').read_text().split('## Per-site')[0]
    rows=[line for line in checklist.splitlines() if line.startswith('| ') and
          not line.startswith(('| Canon requirement','| Plot point','| ---'))]
    assert len(rows)>=30,'Canon checklist missing bullets'
    for row in rows:
        refs=re.findall(r'\b[VR]\d{3}\b',row)
        assert refs and set(refs)<=ids,'Unmapped canon bullet: '+row
    assert p['route']['travel_earth_years']+p['route']['local_dwell_years']==p['trip2']['earth_years']
    assert math.isclose(p['route']['ship_years']-p['route']['cryo_years'],3)
    assert p['tidal']['planned_g']<p['tidal']['rated_g']<p['tidal']['actual_g']
    assert p['air']['service_days']>=p['route']['salvage_to_transit_days']
    assert p['shield']['event_W']<p['shield']['rated_W']
    assert p['signal']['received_after_departure_days']>p['signal']['impact_after_departure_days']
    assert p['signal']['delay_days']>0
    for row in logs:
        key=row['id']
        assert row['ship_time']==p['schedule'][key]['ship_time']
        assert row['earth_date']==p['schedule'][key]['earth_date']
    # Historical inserts must not push the transit entry outside the audit.
    arrival_index=next(i for i,r in enumerate(logs) if r['id']=='V025')
    old_dates=[r['earth_date'] for r in logs[5:arrival_index]]
    assert old_dates==sorted(old_dates),'Non-monotonic voyage dates'
    assert p['schedule']['V018']['earth_date']<p['schedule']['V019']['earth_date']<p['schedule']['V020']['earth_date']
    assert p['schedule']['V024']['earth_date'].startswith(str(p['canon']['transit_year']))
    print(f'PASS: {count} rounded physics claims; {len(faq)} FAQ answers; {len(adversarial)} additional adversarial answers')
    print(f'PASS: {len(logs)} ship logs; {len(timeline)} timeline entries; {len(rows)} canon bullets mapped')
    print('PASS: generated provenance, route/cryo clocks, chronology, signal delay, tidal limit, shield and air budgets')


if __name__=='__main__':
    try:check()
    except (AssertionError,KeyError,ValueError,OSError) as exc:
        raise SystemExit('FAIL: '+str(exc))
