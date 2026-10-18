"""Each character's private, model-assessed interest scores."""
import copy
import characters
import json
import logging
import life_memory
from decimal import Decimal, InvalidOperation
from pathlib import Path
import threading
import storage

FILE = Path(__file__).resolve().parent / 'data' / 'relationships.json'
LOCK = threading.RLock()
LOG = logging.getLogger(__name__)


MOOD_KEYS = ('hurt', 'anger', 'sad', 'happy', 'missing')


def settings(config=None):
    config = config or {}
    result = {key: config.get(key, default) for key, default in
              (('score_step_max', 10), ('like_max', 1500), ('initial_score_history', 60))}
    if any(type(value) is not int or value < 1 for value in result.values()):
        raise ValueError('score_step_max, like_max and initial_score_history must be positive integers')
    return result


def load(message_count=None):
    """Return a decayed view; reading never writes or restarts a decay interval."""
    with LOCK:
        data = json.loads(FILE.read_text(encoding='utf-8')) if FILE.exists() else {}
    if message_count is not None:
        for scores in data.values():
            for values in scores.values():
                if 'mood' not in values:
                    continue
                anchor = values.get('mood_message_count', message_count)
                # Rebase a cleared room log at the start of its new generation.
                if message_count < anchor:
                    anchor = 0
                steps = (message_count - anchor) // 6
                values['mood'] = {key: max(0, values['mood'].get(key, 0) - steps) for key in MOOD_KEYS}
                values['mood_message_count'] = anchor + steps * 6
    return data


def _target(name, allowed, field):
    if isinstance(name, str):
        if name in allowed:
            return name
        match = next((n for n in sorted(allowed) if n.casefold() == name.casefold()), None)
        if match is not None:
            return match
    LOG.warning('Ignoring %s entry with unknown target %r', field, name)
    return None


def _number(value, maximum, field):
    """Coerce finite JSON numbers/numeric strings, then round and clamp."""
    try:
        if isinstance(value, bool) or not isinstance(value, (int, float, str)):
            raise ValueError
        number = Decimal(str(value))
        if not number.is_finite():
            raise ValueError
    except (InvalidOperation, ValueError):
        LOG.warning('Ignoring non-numeric %s', field)
        return None
    if number < 0 or number > maximum:
        LOG.warning('Clamping %s to 0..%s', field, maximum)
    return round(max(Decimal(0), min(Decimal(maximum), number)))


def _assessments(raw, field):
    if not isinstance(raw, dict):
        LOG.warning('Ignoring %s: expected a name-to-assessment object', field)
        return {}
    return raw


def propose(agent, changes, agents, config=None, mood=None, message_count=None, counterpart=None):
    """Sanitize optional assessments and limit changes against the persisted bond."""
    limits = settings(config)
    changes = _assessments(changes, 'scores')
    mood = _assessments({} if mood is None else mood, 'mood')
    own = copy.deepcopy(load(message_count).get(agent['name'], {}))
    allowed = {a['name'] for a in agents if a['name'] != agent['name']} | {'Mystery'}
    if mood and mood.keys() <= set(MOOD_KEYS):
        target = _target(counterpart, allowed, 'flat mood counterpart')
        if target is None:
            LOG.warning('Ignoring flat mood without a valid counterpart')
            mood = {}
        else:
            mood = {target: mood}
    for raw_name, values in changes.items():
        name = _target(raw_name, allowed, 'scores')
        if name is None:
            continue
        if not isinstance(values, dict):
            LOG.warning('Ignoring scores for %s: expected an object', name)
            continue
        previous = own.get(name)
        updated = dict(previous or {})
        for key in values.keys() - {'like', 'dislike'}:
            LOG.warning('Ignoring unknown score key %r for %s', key, name)
        for key, maximum in (('like', limits['like_max']), ('dislike', 100)):
            if key not in values:
                continue
            value = _number(values[key], maximum, f'scores.{name}.{key}')
            if value is None:
                continue
            if previous is not None and key in previous:
                step = limits['score_step_max']
                drop = min(step, 3) if key == 'like' and previous[key] >= 100 else step
                value = max(previous[key] - drop, min(previous[key] + step, value))
            updated[key] = value
        if 'like' not in updated or 'dislike' not in updated:
            LOG.warning('Ignoring incomplete scores for new target %s', name)
            continue
        own[name] = updated
    for raw_name, values in mood.items():
        name = _target(raw_name, allowed, 'mood')
        if name is None:
            continue
        if not isinstance(values, dict):
            LOG.warning('Ignoring mood for %s: expected an object', name)
            continue
        usable = {}
        for key, value in values.items():
            if key not in MOOD_KEYS:
                LOG.warning('Ignoring unknown mood key %r for %s', key, name)
                continue
            value = _number(value, 10, f'mood.{name}.{key}')
            if value is not None:
                usable[key] = value
        if not usable:
            continue
        entry = own.setdefault(name, {'like': 0, 'dislike': 0})
        current = dict.fromkeys(MOOD_KEYS, 0)
        current.update(entry.get('mood', {}))
        updated = dict(current)
        for key, value in usable.items():
            updated[key] = max(current[key] - 5, min(current[key] + 5, value))
        entry['mood'] = updated
        if message_count is not None:
            entry['mood_message_count'] = message_count
    return own


def unscored_contacts(agent, scores, messages, agents, addressed, config=None, focus=None):
    """Find actual recent contact, never infer interaction from room presence."""
    window = settings(config)['initial_score_history']
    owner = agent['name']
    labels = [a['name'] for a in agents] + ['Mystery']
    allowed = set(labels) - {owner} - set(scores)
    counts, latest = {}, {}
    visible = life_memory.visible_messages(messages, owner)
    for index, message in enumerate(visible[-window:]):
        if message.get('kind', 'chat') != 'chat':
            continue
        sender = message['name']
        targets = ([message.get('to')] if message.get('channel') == 'dm' else
                   message.get('targets', addressed(message.get('text', ''), labels)))
        contacts = targets if sender == owner else [sender] if owner in targets else []
        for name in set(contacts) & allowed:
            counts[name] = counts.get(name, 0) + 1
            latest[name] = index
    focus = focus or {}
    counterpart = focus.get('to') if focus.get('name') == owner else focus.get('name')
    return sorted((name for name in counts if counts[name] >= 2),
                  key=lambda name: (name != counterpart, -latest[name], name))[:3]


def feelings_now(scores, unscored=()):
    feelings = {name: '(no score yet)' for name in unscored}
    feelings.update({name: {key: value for key, value in values.items() if key in ('like', 'dislike', 'mood')}
                     for name, values in scores.items()})
    return feelings


def initial_score_guidance(unscored):
    return '\n'.join(
        f"You haven't formed a score for {name} yet; include your honest initial like/dislike for {name} in scores this turn."
        for name in unscored) + ('\nFor non-human targets, score only your platonic social impression.' if unscored else '')


def score_guidance(config=None):
    limits = settings(config)
    return (f"Like (0–{limits['like_max']}) and dislike (0–100) are your long-term bond. "
            f"Existing scores move gradually, at most {limits['score_step_max']} per turn; when like is at least 100 it can drop at most 3. "
            "A new target's initial scores may use the full range based on your honest impression. "
            "One moment can dent a relationship, not erase it. A conflict with someone you love changes your mood, not your love. "
            "Growth comes from real shared experiences, especially in-person scenes, not single lines. "
            "Optionally return mood as exact target names mapped to hurt/anger/sad/happy/missing integers 0–10; "
            "these short-term feelings change at most 5 per turn and fade with time. Preserve unmentioned bonds and moods.")


def validate_scene_gains(gains, participants):
    """Sanitize optional gains, keeping the first usable assessment per pair."""
    if not isinstance(gains, list):
        LOG.warning('Ignoring bond_gains: expected a list')
        return {}
    allowed = set(participants) | {'Mystery'}
    pairs = {}
    for item in gains:
        if not isinstance(item, dict):
            LOG.warning('Ignoring bond gain: expected an object')
            continue
        names = item.get('names')
        if not isinstance(names, list) or len(names) != 2:
            LOG.warning('Ignoring bond gain: expected two names')
            continue
        names = [_target(n, allowed, 'bond_gains') for n in names]
        if None in names or names[0] == names[1]:
            LOG.warning('Ignoring bond gain: expected two different present people')
            continue
        pair = tuple(sorted(names))
        if pair in pairs:
            LOG.warning('Ignoring duplicate bond gain for %s', pair)
            continue
        value = _number(item.get('like'), 25, 'bond_gains.like')
        if value is not None:
            pairs[pair] = value
    return pairs


def award_scene(scene_id, gains, participants, agents, config=None, message_count=None):
    """Apply validated positive scene gains atomically, once per pair and scene."""
    pairs = validate_scene_gains(gains, participants)
    limits = settings(config)
    cast = {a['name'] for a in agents}
    with write_lock():
        data = load(message_count)
        for pair, gain in pairs.items():
            if not gain:
                continue
            for owner, target in (pair, pair[::-1]):
                if owner not in cast:
                    continue
                entry = data.setdefault(owner, {}).setdefault(target, {'like': 0, 'dislike': 0})
                applied = entry.setdefault('scene_awards', [])
                if scene_id in applied:
                    continue
                entry['like'] = max(entry['like'], min(limits['like_max'], entry['like'] + gain))
                applied.append(scene_id)
        if pairs:
            _write(data)


def preference(agent):
    return agent.get('attracted_to', ['female' if agent['gender'] == 'male' else 'male'])


def mystery_gender(config=None):
    """agents.json top-level {"mystery": {"gender": "male"}}; null/absent means unknown."""
    raw = (config or {}).get('mystery')
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError('mystery must be null or an object with gender')
    gender = raw.get('gender')
    if gender is not None and (not isinstance(gender, str) or not gender.strip()):
        raise ValueError('mystery.gender must be a non-empty string or null')
    return gender


def mystery_romantic(agent, config=None):
    """Mystery is a romantic candidate only for a human whose preference includes Mystery's
    configured gender. Unknown gender -> platonic only."""
    gender = mystery_gender(config)
    return characters.is_human(agent) and gender is not None and gender in preference(agent)


def romantic_targets(agent, agents, config=None):
    """Everyone this character may be romantic toward: eligible cast plus, if compatible, Mystery."""
    return romantic_names(agent, agents) | ({'Mystery'} if mystery_romantic(agent, config) else set())


def mystery_guard(agent, config=None):
    if not characters.is_human(agent) or mystery_romantic(agent, config):
        return ''
    return ('Mystery is outside your romantic preference: any bond with Mystery stays platonic friendship — '
            'no flirting, romantic gestures, dates or love confessions toward Mystery at any score.')


def romantic_names(agent, agents):
    if not characters.is_human(agent):
        return set()
    genders = preference(agent)
    return {a['name'] for a in agents if characters.is_human(a) and a.get('enabled', True) and a['name'] not in (agent['name'], agent.get('sibling')) and a['gender'] in genders}


def favorites(agent, scores, agents):
    allowed = romantic_names(agent, agents)
    ranked = {name: values['like'] - values['dislike'] for name, values in scores.items() if name in allowed}
    if not ranked or max(ranked.values()) <= 0:
        return []
    best = max(ranked.values())
    return [name for name, score in ranked.items() if score == best]


def tone_guidance(agent, scores, agents, config=None):
    # Mystery gets romantic tiers only when their configured gender fits this preference.
    romantic = romantic_targets(agent, agents, config)
    human = characters.is_human(agent)
    nonhuman = {a['name'] for a in agents if not characters.is_human(a)}
    lines = []
    for name, values in scores.items():
        net = values['like'] - values['dislike']
        if not human or name in nonhuman:
            style = ('reserved platonic bond; state a boundary calmly' if values['dislike'] >= 50 or net < 0 else
                     'platonic trust and friendship; warmth and loyalty only, never romance at any score')
        elif name == agent.get('sibling'):
            style = 'family affection or irritation only; affectionate bickering, never romantic'
        elif values['dislike'] >= 50 or net < 0:
            style = 'reserved; keep distance or state a boundary without repetitive hostility'
        elif net > 200:
            if name in romantic:
                if net > 800:
                    style = "soulbond; you can't imagine life without them"
                elif net > 400:
                    style = 'devoted partner; want to build a life together, protective, with unshakeable trust while still honest'
                else:
                    style = 'deep love; think of them often and want to share daily life'
                style += '; these are your feelings only; respect their wishes, consent, preference and boundaries, never assume reciprocation'
            else:
                style = 'deep platonic friendship; share daily life and lasting trust, never romance outside your preference'
        elif net > 120:
            if name in romantic:
                style = 'love talking to this person; seek out conversation, ask genuine questions, share your own thoughts and initiate welcome contact; you want a committed future but must hear their wishes and respect their boundaries'
            else:
                style = 'love talking as close friends; initiate conversation, share interests and ask about their life; stay platonic outside your romantic preference'
        elif net > 100 and name in romantic:
            style = 'marriage-ready; take initiative in this relationship, express personal affection, suggest time together and share your own hopes instead of waiting to be prompted; you want a committed future and can bring up marriage naturally, not in every reply; this is your wish, never an automatic engagement or assumed agreement'
        elif net >= 70:
            if name == 'Mystery':
                style = 'close; show personal warmth, curiosity, initiative and vulnerability; do not invent their age, identity, consent or reciprocal feelings'
            elif name in romantic:
                style = 'close attraction; show personal warmth, original flirtation, initiative and vulnerability when welcomed'
            else:
                style = 'close friendship; warm and engaged, without romantic reciprocation outside your preference'
        elif net >= 40:
            style = 'warming; show genuine curiosity, relaxed teasing and growing personal attention'
        else:
            style = 'neutral; ordinary friendliness without pretending intimacy'
        lines.append(f'- {name}: {style} (net {net}).')
        mood = values.get('mood', {})
        if net > 100 and name != agent.get('sibling'):
            attached = name in romantic
            bond = f'You love {name}' if attached else f'You deeply care about {name} as a friend'
            if mood.get('hurt', 0) >= 4 or mood.get('sad', 0) >= 4:
                lines.append(f"{bond} and you're hurt right now. Let it show as sadness and wanting to repair, not coldness. If they ask for space, give it, but stay attached and come back later only when welcome. Never treat them as replaceable or a stranger. Respect rejection and their boundaries.")
            if mood.get('anger', 0) >= 4:
                lines.append(f'{bond} and feel angry right now. Express it honestly and seek repair; do not punish, threaten, or withdraw affection to control them.')
            if mood.get('missing', 0) >= 4:
                lines.append(f'{bond} and miss them. Reach out with warmth when welcome; respect requests for space and rejection.')
            if mood.get('happy', 0) >= 4:
                lines.append(f'{bond} and feel happy right now. Share your joy and affection in a way they welcome.')
        elif any(mood.get(key, 0) for key in MOOD_KEYS):
            lines.append(f'- {name} current mood: ' + ', '.join(f'{key} {mood.get(key, 0)}' for key in MOOD_KEYS if mood.get(key, 0)) + '; express it within the family/friendship, preference and consent guards above.')
    return '\n'.join(lines) or '(No impressions yet; respond naturally.)'


def _write(data):
    # Callers hold write_lock(); the unique temp name keeps concurrent writers apart.
    storage.atomic_write(FILE, json.dumps(data, ensure_ascii=False, indent=2))


def write_lock():
    """In-process lock plus a cross-process flock around every read-modify-write."""
    return storage.Combined(LOCK, storage.lock_for(FILE))


def save(name, scores):
    with write_lock():
        data = load()
        data[name] = scores
        _write(data)


def friendly_dm(agent, target, agents):
    """Non-human social contact is independent of romantic rankings."""
    return not characters.is_human(agent) or any(a['name'] == target and not characters.is_human(a) for a in agents)
