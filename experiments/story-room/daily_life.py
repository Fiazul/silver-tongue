"""Local daily rhythm and compact life context. No model calls or writes."""
from datetime import timedelta
import re
import attention

WINDOW = re.compile(r'^(\d{2}):(\d{2})-(\d{2}):(\d{2})$')


def minutes(value):
    h, m = map(int, value.split(':'))
    if not 0 <= h < 24 or not 0 <= m < 60:
        raise ValueError('routine times must use HH:MM')
    return h * 60 + m


def validate(agent):
    routine = agent.get('routine', {})
    if not isinstance(routine, dict):
        raise ValueError('routine must be an object')
    for key in ('sleep', 'maintenance'):
        value = routine.get(key)
        if value is not None:
            if not isinstance(value, str) or not WINDOW.fullmatch(value):
                raise ValueError(f'routine {key} must be HH:MM-HH:MM')
            start, end = map(minutes, value.split('-'))
            if start == end:
                raise ValueError('routine window must have different start/end times')
    for key in ('home', 'day'):
        if key in routine and (not isinstance(routine[key], str) or not routine[key].strip()):
            raise ValueError(f'routine {key} must be nonempty text')
    for key in ('sleepy_reply', 'woken_by_mystery'):
        if type(routine.get(key, True)) is not bool:
            raise ValueError(f'routine {key} must be boolean')


def rhythm(agent, keeper, config, messages=()):
    now = keeper.local(keeper.clock(), config)
    routine = agent.get('routine', {})
    ship = agent.get('kind') == 'ship_ai'
    window = routine.get('maintenance' if ship else 'sleep')
    result = dict(state='awake', asleep=False, away='', cycle=None, wake=None, now=now)
    if not window:
        return result
    start, end = map(minutes, window.split('-'))
    minute = now.hour * 60 + now.minute
    inside = (minute - start) % 1440 < (end - start) % 1440
    beginning = now.replace(hour=start // 60, minute=start % 60, second=0, microsecond=0)
    if inside:
        if minute < start:
            beginning -= timedelta(days=1)
        result.update(state='maintenance window' if ship else 'asleep', asleep=True,
                      cycle=beginning.isoformat(), wake=window.split('-')[1],
                      away=('Maintenance until ' if ship else 'Asleep until ') + window.split('-')[1])
        if agent.get('kind', 'human') == 'human' and routine.get('woken_by_mystery', True):
            chats = []
            for message in messages:
                if message.get('kind', 'chat') != 'chat':
                    continue
                try:
                    arrived = keeper.local(message['time'], config)
                except (KeyError, ValueError, TypeError, AttributeError):
                    continue
                if beginning <= arrived <= now:
                    chats.append((message, arrived))
            last_own = max((at for m, at in chats if m['name'] == agent['name']), default=beginning)
            recent = now - timedelta(minutes=30)
            incoming = any(m['name'] == 'Mystery' and m.get('channel') == 'dm'
                           and m.get('to') == agent['name'] and at > last_own and at > recent
                           for m, at in chats)
            replied = any(m['name'] == agent['name'] and m.get('channel') == 'dm'
                          and m.get('to') == 'Mystery' and not m.get('alarm') and at > recent for m, at in chats)
            if incoming or replied:
                result.update(state='woken by Mystery', asleep=False, away='')
    elif (start - minute) % 1440 <= 30:
        result['state'] = 'maintenance soon' if ship else 'winding down'
    else:
        wake = now.replace(hour=end // 60, minute=end % 60, second=0, microsecond=0)
        if wake > now:
            wake -= timedelta(days=1)
        # First ordinary reply after wake, including a paused room resumed much later.
        def after_wake(message):
            try:
                return keeper.local(message['time'], config) >= wake
            except (KeyError, ValueError, TypeError):
                return False
        if not any(m['name'] == agent['name'] and not m.get('alarm') and after_wake(m) for m in messages):
            result['state'] = 'maintenance complete' if ship else 'just woke'
    return result


def sleepy_allowed(agent, rhythm, thread, scores, messages):
    if not rhythm['asleep'] or agent.get('kind') == 'ship_ai' or not agent.get('routine', {}).get('sleepy_reply', True):
        return False
    if not thread or thread['channel'] != 'dm':
        return False
    if thread['counterpart'] == 'Mystery' and agent.get('routine', {}).get('woken_by_mystery', True):
        return False
    if thread['counterpart'] != 'Mystery' and attention.net(scores, thread['counterpart']) < 120:
        return False
    return not any(m['name'] == agent['name'] and m.get('sleep_cycle') == rhythm['cycle'] for m in messages)


def life_status(store, scores):
    facts = []
    rows = [(segment, record) for segment in ('milestones', 'world', 'feelings', 'worries')
            for record in store.load_segment(segment) if not record.get('retrieval_only')]
    rows.sort(key=lambda pair: (pair[1].get('time', ''), pair[1].get('importance', 0)), reverse=True)
    for segment, record in rows:
        if segment == 'worries' and record.get('status') != 'open':
            continue
        # A stored belief is not automatically established world fact.
        prefix = 'Belief: ' if segment == 'world' and record.get('belief') != 'believes' else ''
        text = ' '.join(record.get('text', '').split()[:12])
        date = record.get('time', '')[:10]
        facts.append(prefix + text + (f' ({date})' if date else ''))
        if len(facts) == 2:
            break
    if scores:
        closest = max(scores, key=lambda person: attention.net(scores, person))
        if attention.net(scores, closest) >= 120:
            facts.insert(0, f'You love talking with {closest}; this is your feeling, not proof of theirs.')
        elif attention.net(scores, closest) >= 100:
            facts.insert(0, f'You feel close to {closest}.')
    return '; '.join(facts) or 'No established life changes yet.'


def situation(agent, keeper, config, store, scores, messages=(), location=None, scene=False):
    state = rhythm(agent, keeper, config, messages)
    routine = agent.get('routine', {})
    hour = state['now'].hour
    energy = ('resting' if state['asleep'] else 'low, ready for rest' if state['state'] == 'winding down' or hour < 6 or hour >= 23
              else 'nominal' if agent.get('kind') == 'ship_ai' else 'fresh' if hour < 12 else 'steady' if hour < 18 else 'settling')
    if agent.get('kind') == 'ship_ai':
        energy = 'maintenance load' if state['asleep'] else 'nominal'
    place = location or (routine.get('home', 'home') if state['cycle'] else 'the common room')
    place = ' '.join(place.split()[:8])
    activity = 'Duty: ' if agent.get('kind') == 'ship_ai' else 'Day: '
    direction = ("Mystery's message woke you; you're groggy at first, then properly awake while you talk. Other people can wait until morning." if state['state'] == 'woken by Mystery' else
                 'Systems maintenance; handle scheduled duties when needed.' if agent.get('kind') == 'ship_ai' and state['asleep'] else
                 'Wind down; say goodnight naturally if mid-conversation.' if state['state'] == 'winding down' else
                 'One sleepy reply, then rest until wake.' if state['asleep'] and not scene else
                 'Handle your queued messages in attention order.' if state['state'] == 'just woke' else '')
    # NOW comes from the alarm timekeeper, exactly the same configured clock and timezone.
    header = f"SITUATION\nNOW: {keeper.now_text(config)}\nWhere: {place}. State: {state['state']}. Energy: {energy}."
    details = direction + ' ' + activity + routine.get('day', 'Follow your own interests.')
    facts = 'LIFE STATUS: ' + life_status(store, scores)
    # Bound the entire block, while reserving room for actual life changes.
    details = direction if state['state'] == 'woken by Mystery' else ' '.join(details.split()[:20])
    remaining = 80 - len(header.split()) - len(details.split())
    return header + '\n' + details + '\n' + ' '.join(facts.split()[:remaining])
