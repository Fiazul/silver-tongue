"""Rebuild per-character attention from the room log, including across restarts.

Only outgoing messages engage a thread. Reading/scheduling never consumes an inbox.
The log's reply_to and thread_done fields make completion explicit and replayable.
"""
from datetime import datetime, timedelta, timezone
import re

URGENT = re.compile(r'\b(?:help|urgent|emergency|alarm)\b', re.I)
GOODBYE = re.compile(r'\b(?:goodbye|goodnight|good night|bye|talk (?:to you )?later|see you (?:later|tomorrow))\b', re.I)
SILENCE = 6
MENTION_MESSAGES = 20
MENTION_AGE = timedelta(minutes=30)


def net(scores, name):
    score = scores.get(name, {})
    return score.get('like', 0) - score.get('dislike', 0)


def rank(thread, scores):
    if thread['counterpart'] == 'Mystery' or thread.get('host_level', False):
        return (False, -thread['last_incoming'], thread['counterpart'] != 'Mystery', 0)
    return (True, not thread['urgent'],
            net(scores, thread['counterpart']) < 100, thread['arrival'])


def pending_message(pending, newest, room_index, now, prefer_newest=False):
    """Select one focus per counterpart; an unanswered DM keeps its private channel.

    Pending entries are (room index, message, urgency). Public work that the sender
    has moved past expires, while their newest message and private work survive.
    """
    group = pending.get('group')
    if group and group[0] != newest:
        expired = room_index - group[0] >= MENTION_MESSAGES
        try:
            arrived = datetime.fromisoformat(group[1]['time'].replace('Z', '+00:00'))
            expired = expired or now - arrived >= MENTION_AGE
        except (AttributeError, KeyError, TypeError, ValueError):
            pass
        if expired:
            del pending['group']
    if prefer_newest:
        return max(pending.values(), key=lambda item: item[0], default=None)
    return pending.get('dm') or pending.get('group')


def inbox(name, messages, names, addressed, after=lambda message: True, now=None, broadcast=False,
          hosts=('Mystery',), group_initiative=True):
    threads, active, by_id = {}, None, {}
    now = now if now is not None else datetime.now(timezone.utc)
    chat = [m for m in messages if m.get('kind', 'chat') == 'chat' and after(m)]
    newest = {m['name']: i for i, m in enumerate(chat)}
    for index, message in enumerate(chat):
        # Six room messages without a counterpart response release the active thread.
        if active and index - threads[active]['last_incoming'] >= SILENCE:
            active = None
        sender, channel = message['name'], message.get('channel', 'group')
        targets = ([message.get('to')] if channel == 'dm' else
                   message['targets'] if 'targets' in message else addressed(message.get('text', ''), names))
        original = by_id.get(message.get('reply_to'))
        source = original[1] if original else None
        room_broadcast = (broadcast and sender in hosts and channel == 'group' and not targets
                          and (group_initiative or '?' in message.get('text', '')))
        if sender != name and (name in targets or
                room_broadcast or
                (group_initiative and channel == 'group' and source and source['name'] == name
                 and source.get('channel', 'group') == 'group')):
            key = sender
            row = threads.setdefault(key, dict(channel=channel, counterpart=sender,
                arrival=index, arrived_at=message.get('time'), pending=False, engaged=False, urgent=False,
                incoming={}))
            # A completed exchange starts a fresh arrival, while pending messages merge.
            if not row['pending'] and active != key:
                row.update(arrival=index, arrived_at=message.get('time'), urgent=False)
            row.update(message=message, last_message_id=message.get('id'), last_incoming=index, pending=True,
                       urgent=row['urgent'] or bool(message.get('alarm') or URGENT.search(message.get('text', ''))))
            prior = row['incoming'].get(channel)
            urgent = bool(message.get('alarm') or URGENT.search(message.get('text', '')) or (prior and prior[2]))
            row['incoming'][channel] = (index, message, urgent)
        elif sender == name:
            counterpart = message.get('to') if channel == 'dm' else source['name'] if source else None
            if counterpart is None and len(targets) == 1:
                counterpart = targets[0]
            if counterpart and counterpart != name:
                key = counterpart
                row = threads.setdefault(key, dict(channel=channel, counterpart=counterpart,
                    arrival=index, arrived_at=message.get('time'), pending=False, engaged=False,
                    urgent=False, message=source or message, last_message_id=None, last_incoming=index,
                    incoming={}))
                # Consume public work through the answered message, plus private work
                # only when answering a DM. Older in-flight replies preserve newer work.
                if original or not (message.get('reply_to') or message.get('initiative') or message.get('alarm')):
                    cutoff = original[0] if original else index
                    answered_channel = source.get('channel', 'group') if source else channel
                    row['incoming'] = {c: item for c, item in row['incoming'].items()
                                       if item[0] > cutoff or (c == 'dm' and answered_channel != 'dm')}
                row['pending'] = bool(row['incoming'])
                if message.get('thread_done') is True or GOODBYE.search(message.get('text', '')) or (
                        source and GOODBYE.search(source.get('text', ''))):
                    if active == key:
                        active = None
                    row['engaged'] = False
                else:
                    active = key
                    row['engaged'] = True
                if not row['pending']:
                    row['channel'] = channel
        if message.get('id') is not None:
            by_id[message['id']] = (index, message)
    if active and len(chat) - 1 - threads[active]['last_incoming'] >= SILENCE:
        active = None
    for key, row in threads.items():
        selected = pending_message(row['incoming'], newest.get(key), len(chat) - 1, now,
                                   prefer_newest=name in hosts and key == 'Mystery')
        row['pending'] = selected is not None
        if selected:
            index, message, _ = selected
            row.update(channel=message.get('channel', 'group'), message=message,
                       last_message_id=message.get('id'), last_incoming=index,
                       urgent=any(item[2] for item in row['incoming'].values()))
        row['host_level'] = row['counterpart'] in hosts
        row.pop('incoming')
    # Busy persists while waiting, but does not cause duplicate answers to the same message.
    return dict(active=threads.get(active), pending=[r for r in threads.values() if r['pending']])


def next_thread(box, scores, mystery_only=False, hosts=('Mystery',)):
    active = box['active']
    if active:
        if active['pending'] and (not mystery_only or active['counterpart'] in hosts):
            return active
        # Quiet room defers non-host threads; hosts can still be answered.
        if not mystery_only or active['counterpart'] in hosts:
            return None
    rows = [r for r in box['pending'] if not mystery_only or r['counterpart'] in hosts]
    return min(rows, key=lambda row: rank(row, scores)) if rows else None


def busy(box, private=False):
    active = box['active']
    if not active:
        return ''
    return ('busy' if private and active['channel'] == 'dm' else 'talking with ' + active['counterpart'])
