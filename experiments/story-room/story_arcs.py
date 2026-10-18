"""Bounded, operator-authored conversation goals; progress is actual posted speech."""
from datetime import datetime
import json
import re

import disclosure
import life_memory
import storage


def reserve(root, plan):
    """Bound provider attempts, including after restart; caller holds the room lock."""
    path = root / 'story_arcs' / (plan['arc']['id'] + '.json')
    attempts = json.loads(path.read_text()) if path.exists() else {}
    key = str(plan['step'])
    if attempts.get(key, 0) >= 3:
        return False
    attempts[key] = attempts.get(key, 0) + 1
    storage.atomic_write(path, json.dumps(attempts))
    return True


def validate(config):
    arcs = config.get('story_arcs', [])
    names = {a['name'] for a in config['agents']}
    if not isinstance(arcs, list) or len(arcs) > 8:
        raise ValueError('story_arcs must be a list of at most eight conversations')
    seen = set()
    for arc in arcs:
        if (not isinstance(arc, dict) or not isinstance(arc.get('id'), str)
                or not re.fullmatch(r'[a-z0-9_-]{1,80}', arc['id']) or arc['id'] in seen
                or arc.get('lead') not in names or arc.get('partner') not in names
                or arc['lead'] == arc['partner'] or type(arc.get('enabled', True)) is not bool
                or type(arc.get('pace_seconds', 2)) not in (int, float)
                or not 0 <= arc.get('pace_seconds', 2) <= 60
                or not isinstance(arc.get('goal'), str) or not 1 <= len(arc['goal']) <= 1800
                or not isinstance(arc.get('topics'), list) or not 1 <= len(arc['topics']) <= 16):
            raise ValueError('Invalid bounded story arc')
        seen.add(arc['id'])
        for topic in arc['topics']:
            if (not isinstance(topic, dict) or not isinstance(topic.get('question'), str)
                    or not 1 <= len(topic['question']) <= 600
                    or not isinstance(topic.get('logs', []), list) or len(topic.get('logs', [])) > 8
                    or any(not isinstance(key, str) or not re.fullmatch(r'[VR]\d{3}', key)
                           for key in topic.get('logs', []))):
                raise ValueError('Invalid story arc topic')
            if (not isinstance(topic.get('keywords', []), list) or len(topic.get('keywords', [])) > 6
                    or any(not isinstance(word, str) or not 1 <= len(word) <= 40
                           for word in topic.get('keywords', []))):
                raise ValueError('Invalid story arc supporting keywords')


def select(config, messages, available, now):
    for arc in config.get('story_arcs', []):
        if not arc.get('enabled', True):
            continue
        step, last = 0, None
        limit = 2 * len(arc['topics'])
        for message in messages:
            if message.get('story_arc') != arc['id'] or message.get('story_step') != step:
                continue
            name = arc['lead'] if step >= limit or step % 2 == 0 else arc['partner']
            target = 'Mystery' if step == limit + 1 else arc['partner'] if step >= limit or step % 2 == 0 else arc['lead']
            if message['name'] == name and message.get('channel') == 'dm' and message.get('to') == target:
                step += 1
                last = message
        if step > limit + 1:
            continue
        name = arc['lead'] if step >= limit or step % 2 == 0 else arc['partner']
        target = 'Mystery' if step == limit + 1 else arc['partner'] if step >= limit or step % 2 == 0 else arc['lead']
        required = {name} if target == 'Mystery' else {name, target}
        if not required <= set(available):
            continue
        ready = not last or (now - datetime.fromisoformat(last['time'])).total_seconds() >= arc.get('pace_seconds', 2)
        return dict(arc=arc, step=step, name=name, target=target, closing=step >= limit,
                    final=step == limit + 1, ready=ready)
    return None


def prompt(plan, agent, store, messages, scores):
    arc, step = plan['arc'], plan['step']
    lead, partner = arc['lead'], arc['partner']
    lines = [f"ONGOING PRIVATE STORY GOAL: {arc['goal']}",
             f"This turn: write to {plan['target']} (to=\"{plan['target']}\").",
             'Continue from the actual conversation. Do not mention an arc, steps, a checklist or the operator. '
             'Act now rather than promising to contact someone later.']
    if plan['closing']:
        lines += [f'{lead}: send Ryoma your own considered response to what you actually learned from {partner}. '
                  'Show your feelings, what you have decided, and one concrete next step you choose yourself. '
                  'Do not wait for him to prompt your reaction. Never claim you learned something that was not spoken. '
                  'This ends this finite discussion; set thread_done:true.']
        if not plan['final']:
            lines[-1] = (f'{lead}: before writing Ryoma, respond personally to {partner} about what you learned. '
                         'Say what it changes for you, what you choose to do and why. Let your feelings and '
                         'independent judgment show. Close this conversation warmly; set thread_done:true.')
    else:
        topic = arc['topics'][step // 2]
        lines += ['CURRENT QUESTION TO EXPLORE: ' + topic['question'],
                  'Keep thread_done:false while this discussion is underway. An earlier polite goodbye does not '
                  'resolve the questions you still want answered.']
        if agent['name'] == lead:
            lines += [f'{lead} leads: follow what catches your attention in the last answer and pursue the current '
                      'topic in your own voice. Have your own interpretation, curiosity, joke, objection or desire. '
                      'A specific follow-up question is welcome when you actually want its answer; it is not a '
                      'required ending. Do not recap the whole answer or substitute gratitude and validation for '
                      'a response. Let a painful fact land without automatically finding a comforting lesson. '
                      'Be emotionally involved and playfully persistent through teasing evasions. '
                      'Do not pretend to know hidden facts before hearing them. Your love for Ryoma motivates '
                      'your curiosity without replacing your intelligence, choices or independent voice. '
                      'Use the length the thought needs; no padded word target.']
        else:
            lines += [f'{partner} supports {lead}: let her curiosity and playful prying draw you out. A little dry '
                      'reluctance is in character; follow it with meaningful, permitted information this turn. '
                      'Do not replace a real answer with repeated privacy deflections when permission exists. '
                      'Respond to the actual exchange and current topic using your own knowledge. Give a story '
                      'the detail it needs; a tease or an honest admission can be a single line. Do not pad a '
                      'short thought into an explanation. Quote at most '
                      'one log excerpt; connect facts rather than dumping logs. Distinguish records, claims and '
                      'unknowns. Do not solve the unexplained 340-year discrepancy, wormhole or room origin.']
            controls = disclosure.overrides(store, messages, [lead, partner, 'Mystery'], agent)
            records = [r for segment in life_memory.SEGMENTS for r in store.load_segment(segment)
                       if r.get('source_id') in {'lore:' + key for key in topic.get('logs', [])}
                       or (r.get('retrieval_only') and str(r.get('source_id', '')).endswith('/backstory.md')
                           and any(word.lower() in r['text'].lower() for word in topic.get('keywords', [])))]
            lines.append('YOUR OWN RELEVANT SAVED RECORDS (not yet the listener\'s knowledge):')
            for record in records:
                lines.append(disclosure.marker(agent, [plan['target']], record, scores, controls) + record['text'])
    return '\n'.join(lines)
