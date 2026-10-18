"""Personal initiative and enforceable limits on unsolicited contact."""
import re
import math
from datetime import datetime, timezone
import characters
import life_memory
import relationships


def blocked(store, target):
    index = store.index()
    ids = index.get('people', {}).get(target.lower(), {}).get('boundaries', [])
    if not ids:
        return False
    return any(r['id'] in ids and r['status'] == 'open' and
               (set(r['tags']) & {'no-contact', 'space', 'rejection', 'stop', 'no'} or
                any(phrase in r['text'].lower() for phrase in ('asked for space', 'said no to contact', 'said no to pursuit', 'rejected romantic pursuit', 'do not contact', "don't contact", 'leave me alone')))
               for r in store.load_segment('boundaries'))


def blocked_between(store_for, first, second):
    """Two-way: an open space/no-contact boundary in EITHER party's store blocks contact.

    store_for(name) returns that character's life store; Mystery has none."""
    return any(blocked(store_for(owner), other)
               for owner, other in ((first, second), (second, first)) if owner != 'Mystery')


# All autonomous-contact tuning lives here; agents.json may override initiative keys.
DEFAULTS = dict(minutes_at_100=60, minutes_at_200=25, minimum_minutes=10,
                missing_discount=0.2, return_minutes=30, daily_pair_cap=8,
                unanswered_cap=2, legacy_message_gap=8, legacy_cooldown_messages=10)

HOST_DEFAULTS = dict(enabled=True, idle_minutes=10, contact_minutes=20,
                     daily_pair_cap=6, unanswered_cap=2)


def host_settings(agent):
    supplied = agent.get('host_initiative', {})
    if not isinstance(supplied, dict):
        raise ValueError('host_initiative must be an object')
    result = dict(HOST_DEFAULTS, **supplied)
    if type(result['enabled']) is not bool:
        raise ValueError('host_initiative enabled must be boolean')
    for key in ('idle_minutes', 'contact_minutes', 'daily_pair_cap', 'unanswered_cap'):
        value = result[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError('host_initiative ' + key + ' must be positive and finite')
        if key.endswith('_cap') and type(value) is not int:
            raise ValueError('host_initiative ' + key + ' must be an integer')
    return result


def settings(config=None):
    supplied = (config or {}).get('initiative', {})
    if not isinstance(supplied, dict):
        raise ValueError('initiative must be an object')
    result = dict(DEFAULTS, **supplied)
    for key in DEFAULTS:
        value = result[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError('initiative ' + key + ' must be positive and finite')
    if not result['minimum_minutes'] < result['minutes_at_200'] < result['minutes_at_100']:
        raise ValueError('initiative waits must decrease from 100 to 200 to minimum')
    if result['missing_discount'] >= 1:
        raise ValueError('initiative missing_discount must be below 1')
    for key in ('daily_pair_cap', 'unanswered_cap', 'legacy_message_gap', 'legacy_cooldown_messages'):
        if type(result[key]) is not int:
            raise ValueError('initiative ' + key + ' must be an integer')
    return result


def timestamp(message):
    try:
        value = datetime.fromisoformat(message['time'].replace('Z', '+00:00'))
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    except (KeyError, TypeError, ValueError, AttributeError):
        return None


def contact(message, name, target):
    if message.get('channel') == 'dm':
        return {message['name'], message.get('to')} == {name, target}
    other = target if message['name'] == name else name
    addressed = other in message.get('targets', []) or bool(re.search(
        r'(?<!\w)@?' + re.escape(other) + r'(?!\w)', message.get('text', ''), re.I))
    return message['name'] in (name, target) and addressed


def unsolicited(message, by_id):
    original = by_id.get(message.get('reply_to'))
    return (original is None or message.get('initiative', False) or original['name'] != message.get('to'))


def may_initiate(name, target, messages, store, store_for=None, *, now=None, config=None):
    if blocked_between(store_for, name, target) if store_for else blocked(store, target):
        return False
    now = now or datetime.now(timezone.utc)
    limits = settings(config)
    by_id = {m.get('id'): m for m in messages if m.get('id')}
    pair = [(i, m) for i, m in enumerate(messages) if contact(m, name, target)]
    unanswered = 0
    for _, message in reversed(pair):
        if message['name'] == target:
            break
        if message.get('channel') == 'dm' and unsolicited(message, by_id):
            unanswered += 1
    if unanswered >= limits['unanswered_cap']:
        return False
    outgoing = [(i, m) for i, m in pair if m['name'] == name and
                m.get('channel') == 'dm' and unsolicited(m, by_id)]
    if sum(bool(timestamp(m) and timestamp(m).astimezone(now.tzinfo).date() == now.date())
           for _, m in outgoing) >= limits['daily_pair_cap']:
        return False
    # Timestamp-less legacy logs retain a small message fallback. Real logs use time.
    return not any(timestamp(m) is None and len(messages) - i < limits['legacy_cooldown_messages'] for i, m in outgoing)


def wait_minutes(net, values, config=None):
    limits = settings(config)
    floor = limits['minimum_minutes']
    # Exponential decay through both tuning anchors, approaching the minimum smoothly.
    decay = math.log((limits['minutes_at_100'] - floor) / (limits['minutes_at_200'] - floor))
    wait = floor + (limits['minutes_at_100'] - floor) * math.exp(-decay * max(0, net - 100) / 100)
    missing = min(10, max(0, values.get('mood', {}).get('missing', 0)))
    return wait * (1 - limits['missing_discount'] * missing / 10)


def mystery_return(messages, now, config=None):
    posts = [(i, m) for i, m in enumerate(messages)
             if m['name'] == 'Mystery' and timestamp(m) and timestamp(m) <= now]
    for (_, previous), (index, current) in reversed(list(zip(posts, posts[1:]))):
        if (timestamp(current) - timestamp(previous)).total_seconds() >= settings(config)['return_minutes'] * 60:
            return index
    return None


def longing(agent, agents, messages, scores, store, store_for=None, *, now=None,
            config=None, awake=None, morning=False, targets=None):
    now = now or datetime.now(timezone.utc)
    name = agent['name']
    if awake and not awake(name):
        return None
    available = {a['name'] for a in agents if a.get('enabled', True)} | {'Mystery'}
    returned = mystery_return(messages, now, config)
    choices = []
    for target, values in scores.items():
        net = values['like'] - values['dislike']
        if (target == name or target not in available or net < 100 or
                (targets is not None and target not in targets) or
                (awake and target != 'Mystery' and not awake(target)) or
                not may_initiate(name, target, messages, store, store_for, now=now, config=config)):
            continue
        pair = [(i, m) for i, m in enumerate(messages) if contact(m, name, target)]
        last = pair[-1][1] if pair else None
        at = timestamp(last) if last else None
        gap = len(messages) - pair[-1][0] - 1 if pair else len(messages)
        silence = (now - at).total_seconds() / 60 if at else None
        # Log order disambiguates posts sharing a clock tick (including a fake clock).
        hello = target == 'Mystery' and returned is not None and not any(
            m['name'] == name and i >= returned for i, m in pair)
        if morning or hello or (silence is not None and silence >= wait_minutes(net, values, config)) or (
                at is None and gap >= settings(config)['legacy_message_gap']):
            choices.append((net, 'morning' if morning else 'return' if hello else 'missing', target))
    return max(choices, default=None)


def goodnight_nudge(agent, focus, scores):
    if (focus and focus.get('channel') == 'dm' and focus.get('to') == agent['name'] and
            scores.get(focus['name'], {}).get('like', 0) - scores.get(focus['name'], {}).get('dislike', 0) >= 100 and
            re.search(r"\b(?:good\s?night|going to (?:sleep|bed)|off to (?:sleep|bed)|heading to bed)\b", focus.get('text', ''), re.I)):
        return ('Consider set_alarm to wake/greet them in the morning. If you intend a morning hello or promise a wake-up, '
                'record it now in calls with their exact recipient label and a suitable local time; ask about timing if needed.')
    return ''


def heart(agent, scores, agents, store, config=None):
    # Unspoken *love* only toward compatible people; Mystery per the configured gender.
    compatible = relationships.romantic_targets(agent, agents, config)
    milestones = store.load_segment('milestones') if any(
        values['like'] - values['dislike'] > 120 and name in compatible for name, values in scores.items()) else []
    lines = []
    for name, values in scores.items():
        if name not in compatible or values['like'] - values['dislike'] <= 120:
            continue
        confessed = any(name.lower() in {n.lower() for n in r['about']} and
                        (set(r['tags']) & {'confession', 'confessed', 'spoken-love'} or
                         any(p in r['text'].lower() for p in ('confessed love', 'said i love you', 'told them i love')))
                        and not any(p in r['text'].lower() for p in ('not yet', 'unspoken', 'has not', "haven't", 'never confessed'))
                        for r in milestones)
        if not confessed:
            lines.append(f'Unspoken love: you love {name} and have not said it. Show it through care, remembering details, checking in and wanting their time. Saying it aloud is your choice at a moment that feels right. Never assume their feelings, age or consent; existing preference and boundary guards still apply.')
    return '\n'.join(lines)


def direction(agent, target, store, already_asked=None, names=()):
    threads = [r for r in store.load_segment('worries') if r['status'] == 'open' and target.lower() in {n.lower() for n in r['about']}]
    thread = max(threads, key=lambda r: r['importance'], default=None)
    return (f'YOUR HEART: You miss {target}; you have not exchanged messages for a while. Reach out privately to {target} with care and something of your own to share. Keep it warm, natural and short. Vary your opening; never guilt-trip them or mention an unanswered reply. Use a romantic tone only when your existing compatibility rules allow it; otherwise be platonic. Respect their time and boundaries.' +
            (f" On your mind: {thread['text']}" + life_memory.worry_label(thread, already_asked, names) + f" (#{thread['id']})"
             if thread else ''))
