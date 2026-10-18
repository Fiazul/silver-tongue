"""Character-scheduled future actions ("alarms") expressed as function calls in the reply JSON.

Validation, persistence in data/alarms.json, the firing thread and wake-up notifications live here.
server.py, scenes.py and meetups.py only call prompt(), apply(), handle(), settings() and start().
"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import json
import logging
import health
import re
import subprocess
import threading
import time
import uuid
from zoneinfo import ZoneInfo

import relationships
import scenes
import speech

DEFAULT_TIMEZONE = 'Asia/Dhaka'
MIN_AHEAD = timedelta(minutes=10)
MAX_AHEAD = timedelta(days=7)
MAX_PENDING = 3
MAX_PER_DAY = 6
DEDUPE_WINDOW = timedelta(minutes=30)
BUSY_RETRY = timedelta(seconds=15)
BUSY_LIMIT = timedelta(minutes=10)
SCENE_LIMIT = timedelta(minutes=30)
MISSED_LIMIT = timedelta(hours=2)
FAILURE_RETRY = timedelta(seconds=60)
MAX_ATTEMPTS = 2
MAX_CALLS = 5
MAX_NOTICES = 12
CHANNELS = ('dm', 'group')
OPEN = ('pending', 'firing')
FUNCTIONS = ('set_alarm', 'cancel_alarm', 'list_alarms', 'get_time')
ID = r'a[0-9a-f]{8}'
MYSTERY_MENTION = re.compile(r'(?<!\w)@Mystery(?!\w)', re.I)
LOG = logging.getLogger(__name__)

RULE = ('TIME CALLS (optional): add "calls": [...] to your JSON to act later. Functions: '
        '{"fn":"set_alarm","at":"YYYY-MM-DDTHH:MM or HH:MM (next occurrence, local time as in NOW)",'
        '"to":"exact name or Mystery","intent":"what you will do then (private note to yourself)","channel":"dm|group"}; '
        '{"fn":"cancel_alarm","id":"..."}; {"fn":"list_alarms"}; {"fn":"get_time"}. '
        'Use set_alarm whenever you intend a later action; a spoken promise alone does not schedule it: wake someone you promised or care about, '
        'follow up, a birthday, a check-in after a hard day. Don\'t over-schedule (10 minutes to 7 days ahead, at most '
        f'{MAX_PENDING} pending). When it is due you get one turn to send that message yourself. You can\'t control '
        'anyone else or promise their actions. Results arrive on your next turn.')


class CallError(ValueError):
    pass


def settings(config):
    """Validate the optional config keys: timezone (IANA name) and alarm_audio (bool)."""
    name = config.get('timezone', DEFAULT_TIMEZONE)
    try:
        if not isinstance(name, str) or not name:
            raise ValueError
        ZoneInfo(name)
    except (KeyError, ValueError, OSError) as exc:
        raise ValueError('timezone must be an IANA name such as Asia/Dhaka') from exc
    audio = config.get('alarm_audio', False)
    if type(audio) is not bool:
        raise ValueError('alarm_audio must be true or false')
    return dict(timezone=name, alarm_audio=audio)


def parse_time(value):
    return datetime.fromisoformat(value)


def normalized(text):
    return ' '.join(re.sub(r'[^\w\s]', ' ', text.lower()).split())


def parse_at(value, now_local):
    """ISO local datetime (naive = configured zone) or HH:MM for its next occurrence."""
    if not isinstance(value, str) or not value.strip():
        raise CallError('at must be a local date-time (YYYY-MM-DDTHH:MM) or HH:MM')
    text = value.strip()
    match = re.fullmatch(r'(\d{1,2}):(\d{2})', text)
    if match:
        hour, minute = int(match[1]), int(match[2])
        if hour > 23 or minute > 59:
            raise CallError(f'invalid time {text!r}')
        candidate = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate <= now_local:
            candidate += timedelta(days=1)
        return candidate
    try:
        parsed = datetime.fromisoformat(re.sub(r'Z$', '+00:00', text))
    except ValueError as exc:
        raise CallError(f'could not read time {text!r}; use YYYY-MM-DDTHH:MM or HH:MM') from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=now_local.tzinfo)
    return parsed.astimezone(now_local.tzinfo)


class Timekeeper:
    def __init__(self, host, clock=None, spawn=None):
        # host is the live server namespace, so config reloads and test patches apply.
        self.host = host
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.spawn = spawn or (lambda target: threading.Thread(target=target, daemon=True).start())
        self.shown = {}
        self.thread = None

    # ---- storage -------------------------------------------------------------------------
    @property
    def lock(self):
        # The room RLock: avoids lock-order inversions with history/life-store reads.
        return self.host['LOCK']

    @property
    def path(self):
        return self.host['DATA'] / 'alarms.json'

    def load(self):
        with self.lock:
            empty = dict(alarms=[], notices={}, seq=0)
            if not self.path.exists():
                return empty
            try:
                data = json.loads(self.path.read_text(encoding='utf-8'))
                if (not isinstance(data, dict) or not isinstance(data.get('alarms'), list)
                        or not isinstance(data.get('notices', {}), dict)):
                    raise ValueError('unexpected alarms.json shape')
            except ValueError:
                backup = self.path.with_name(f'alarms.corrupt-{time.time_ns()}.json')
                self.path.replace(backup)
                LOG.error('Unreadable alarms file moved to %s', backup)
                return empty
            data.setdefault('notices', {})
            data.setdefault('seq', 0)
            return data

    def save(self, data):
        with self.lock:
            scenes.atomic(self.path, json.dumps(data, ensure_ascii=False, indent=2))

    def notice(self, data, name, text):
        data['seq'] += 1
        rows = data['notices'].setdefault(name, [])
        rows.append(dict(seq=data['seq'], text=text[:400]))
        del rows[:-MAX_NOTICES]

    def update(self, alarm_id, notice=None, **fields):
        if fields.get('status') in ('fired', 'missed', 'failed'):
            with self.lock:
                alarm = next((a for a in self.load()['alarms'] if a['id'] == alarm_id), {})
            health.emit('alarm_' + fields['status'], alarm.get('owner', ''), 'scheduled action ' + fields['status'])
        with self.lock:
            data = self.load()
            alarm = next((a for a in data['alarms'] if a['id'] == alarm_id), None)
            if alarm is None:
                return None
            alarm.update(fields)
            if notice:
                self.notice(data, alarm['owner'], notice)
            self.save(data)
            return alarm

    # ---- time helpers -------------------------------------------------------------------
    def zone(self, config):
        return ZoneInfo(settings(config)['timezone'])

    def local(self, value, config):
        moment = parse_time(value) if isinstance(value, str) else value
        return moment.astimezone(self.zone(config))

    def short(self, value, config):
        return self.local(value, config).strftime('%a %Y-%m-%d %H:%M')

    def now_text(self, config):
        now = self.local(self.clock(), config)
        return f"{now.strftime('%A %Y-%m-%d %H:%M')} ({settings(config)['timezone']})"

    # ---- prompt / results ------------------------------------------------------------------
    def prompt(self, name, config=None):
        config = config if config is not None else self.host['load_config']()
        now_line = 'NOW: ' + self.now_text(config)
        try:
            with self.lock:
                data = self.load()
                pending = sorted((a for a in data['alarms'] if a['owner'] == name and a['status'] in OPEN),
                                 key=lambda a: a['at'])
                notices = list(data['notices'].get(name, []))
                if notices:
                    self.shown[name] = max(n['seq'] for n in notices)
        except (OSError, ValueError, KeyError, TypeError):
            LOG.exception('Could not read scheduled actions for %s', name)
            return now_line
        lines = [now_line, RULE, 'YOUR SCHEDULED ACTIONS (private; only you see these): ' +
                 ('none' if not pending else '; '.join(
                     f"{a['id']}: {self.short(a['at'], config)} → {a['to']} ({a['channel']}): {a['intent']}"
                     for a in pending))]
        if notices:
            lines.append('RESULTS OF YOUR TIME CALLS SINCE YOUR LAST TURN: ' + ' | '.join(n['text'] for n in notices))
        return '\n'.join(lines)

    def apply(self, name, turn, config=None):
        """Run calls from a posted reply; consume results that were shown in this turn's prompt."""
        config = config if config is not None else self.host['load_config']()
        choices = getattr(turn, 'choices', None) or {}
        calls = choices.get('calls') if isinstance(choices, dict) else None
        with self.lock:
            data = self.load()
            shown = self.shown.pop(name, 0)
            changed = False
            if shown and data['notices'].get(name):
                rest = [n for n in data['notices'][name] if n['seq'] > shown]
                if rest:
                    data['notices'][name] = rest
                else:
                    data['notices'].pop(name)
                changed = True
            results = [] if calls is None else self.run_calls(data, name, calls, config)
            for result in results:
                self.notice(data, name, result)
                changed = True
            if changed:
                self.save(data)
        return results

    def run_calls(self, data, name, calls, config):
        if not isinstance(calls, list):
            return ['calls ignored: calls must be a list of function calls']
        results = []
        for call in calls[:MAX_CALLS]:
            if not isinstance(call, dict):
                results.append('call ignored: each call must be a JSON object')
                continue
            fn = call.get('fn') or call.get('function') or call.get('name')
            args = next((call[k] for k in ('args', 'arguments') if isinstance(call.get(k), dict)), call)
            try:
                if fn == 'set_alarm':
                    results.append(self.set_alarm(data, name, args, config))
                elif fn == 'cancel_alarm':
                    results.append(self.cancel_alarm(data, name, args, config))
                elif fn == 'list_alarms':
                    count = sum(a['owner'] == name and a['status'] in OPEN for a in data['alarms'])
                    results.append(f'list_alarms: {count} pending (listed under YOUR SCHEDULED ACTIONS)')
                elif fn == 'get_time':
                    results.append('get_time: ' + self.now_text(config))
                else:
                    results.append(f"unknown function {str(fn)[:40]!r}; available: {', '.join(FUNCTIONS)}")
            except CallError as exc:
                results.append(f'{fn} rejected: {exc}')
        if len(calls) > MAX_CALLS:
            results.append(f'only the first {MAX_CALLS} calls were run')
        return results

    def blocked(self, owner, target, config):
        # The room's shared two-way check used for DMs, invitations and meetups.
        return self.host['blocked_between'](owner, target, config)

    def set_alarm(self, data, owner, args, config):
        now = self.clock()
        zone = self.zone(config)
        to, intent, channel = args.get('to'), args.get('intent'), args.get('channel') or 'dm'
        if channel not in CHANNELS:
            raise CallError('channel must be dm or group')
        cast = [a['name'] for a in config['agents']]
        if not isinstance(to, str) or to not in cast + ['Mystery']:
            raise CallError(f'unknown recipient {str(to)[:40]!r}; use an exact cast name or Mystery')
        if to == owner:
            raise CallError('an alarm must be addressed to someone else')
        if not isinstance(intent, str) or not intent.strip():
            raise CallError('intent is required')
        intent = ' '.join(intent.split())[:300]
        at = parse_at(args.get('at'), now.astimezone(zone))
        if at - now < MIN_AHEAD:
            raise CallError('at must be at least 10 minutes from now')
        if at - now > MAX_AHEAD:
            raise CallError('at must be within 7 days')
        if self.blocked(owner, to, config):
            raise CallError(f'a space/no-contact boundary is active between you and {to}; not scheduled')
        mine = [a for a in data['alarms'] if a['owner'] == owner]
        pending = [a for a in mine if a['status'] in OPEN]
        duplicate = next((a for a in pending if a['to'] == to and normalized(a['intent']) == normalized(intent)
                          and abs(parse_time(a['at']) - at) <= DEDUPE_WINDOW), None)
        if duplicate:
            raise CallError(f"already scheduled as {duplicate['id']}")
        if len(pending) >= MAX_PENDING:
            raise CallError(f'you already have {MAX_PENDING} pending alarms; cancel one first')
        today = now.astimezone(zone).date()
        if sum(parse_time(a['created_at']).astimezone(zone).date() == today for a in mine) >= MAX_PER_DAY:
            raise CallError(f'daily limit of {MAX_PER_DAY} alarms reached')
        alarm = dict(id='a' + uuid.uuid4().hex[:8], owner=owner, to=to, intent=intent, channel=channel,
                     at=at.isoformat(), created_at=now.isoformat(), status='pending', attempts=0)
        data['alarms'].append(alarm)
        health.emit('alarm_set', owner, 'alarm scheduled')
        return f"set_alarm ok: {alarm['id']} at {self.short(at, config)} → {to} ({channel})"

    def cancel_alarm(self, data, owner, args, config):
        alarm_id = args.get('id')
        alarm = next((a for a in data['alarms'] if a['id'] == alarm_id and a['owner'] == owner), None)
        if alarm is None:
            raise CallError(f'no alarm of yours with id {str(alarm_id)[:20]!r}')
        if alarm['status'] != 'pending':
            raise CallError(f"{alarm_id} is already {alarm['status']}")
        alarm.update(status='cancelled', closed_at=self.clock().isoformat())
        return f'cancel_alarm ok: {alarm_id} cancelled'

    # ---- firing ------------------------------------------------------------------------------
    def describe(self, alarm, config):
        return f"{alarm['id']} ({self.short(alarm['at'], config)} → {alarm['to']}: {alarm['intent']})"

    def quiet(self):
        return bool(self.host.get('quiet_room', lambda: False)())

    @staticmethod
    def deferred(alarm, quiet):
        """Quiet room defers character-to-character alarms; alarms to Mystery still fire."""
        return quiet and alarm['to'] != 'Mystery'

    def sweep_overdue(self, data, now, config, quiet=False):
        """Alarms more than two hours late (server down, suspended machine) are missed, not fired.

        Alarms deferred by the quiet room are not swept while it stays quiet; once it ends
        they fire if still under two hours late, else they are reported missed."""
        changed = False
        for alarm in data['alarms']:
            if (alarm['status'] == 'pending' and not self.deferred(alarm, quiet)
                    and now - parse_time(alarm['at']) >= MISSED_LIMIT):
                alarm.update(status='missed', closed_at=now.isoformat())
                self.notice(data, alarm['owner'], f'Alarm {self.describe(alarm, config)} was missed: '
                                                  'it was more than two hours late, so it did not fire.')
                health.emit('alarm_missed', alarm['owner'], 'alarm more than two hours late')
                changed = True
        return changed

    def recover(self, config=None):
        """Startup: an interrupted firing becomes pending; alarms <2 h late fire once, older are missed."""
        config = config if config is not None else self.host['load_config']()
        now = self.clock()
        with self.lock:
            data = self.load()
            changed = False
            for alarm in data['alarms']:
                if alarm['status'] == 'firing':
                    alarm['status'] = 'pending'
                    changed = True
            changed = self.sweep_overdue(data, now, config) or changed
            for alarm in data['alarms']:
                if alarm['status'] == 'pending' and parse_time(alarm['at']) <= now:
                    alarm.update(late=True, next_try=None, busy_since=None)
                    changed = True
            if changed:
                self.save(data)

    def start(self):
        self.recover()
        self.thread = threading.Thread(target=self.loop, daemon=True, name='timekeeper')
        self.thread.start()

    def loop(self):
        while not self.host['STOP'].wait(1):
            try:
                self.tick()
            except Exception:
                LOG.exception('Timekeeper tick failed')

    def tick(self, config=None):
        """Fire at most one due alarm. Returns the outcome for that alarm, or None."""
        config = config if config is not None else self.host['load_config']()
        now = self.clock()
        quiet = self.quiet()
        with self.lock:
            data = self.load()
            if self.sweep_overdue(data, now, config, quiet):
                self.save(data)
            due = sorted((a for a in data['alarms'] if a['status'] == 'pending' and parse_time(a['at']) <= now
                          and not self.deferred(a, quiet)
                          and (not a.get('next_try') or parse_time(a['next_try']) <= now)),
                         key=lambda a: a['at'])
        return self.fire(due[0]['id'], config) if due else None

    def scene_for(self, name):
        return next((m for m in self.host['SCENES'].list() if m['status'] == 'active' and name in m['participants']), None)

    def reserve(self, name, scene_id=None):
        """Take the single provider-call slot: no room speaker and no scene/meetup step in flight."""
        host = self.host
        with self.lock:
            if host['STATE'].get('speaker') or any(host['SCENES'].jobs.values()):
                return False
            host['STATE']['speaker'] = name
            if scene_id:
                host['SCENES'].jobs[scene_id] = dict(operation='alarm', speaker=name)
            return True

    def release(self, scene_id=None):
        with self.lock:
            self.host['STATE']['speaker'] = None
            if scene_id:
                self.host['SCENES'].jobs.pop(scene_id, None)
        self.host['WAKE'].set()

    def fire(self, alarm_id, config):
        now = self.clock()
        with self.lock:
            alarm = next((a for a in self.load()['alarms'] if a['id'] == alarm_id), None)
        if alarm is None or alarm['status'] != 'pending':
            return None
        name, to = alarm['owner'], alarm['to']
        enabled = {a['name']: a for a in config['agents'] if a.get('enabled', True)}
        agent = enabled.get(name)
        if agent is None or (to != 'Mystery' and to not in enabled):
            who = 'you were' if agent is None else f'{to} was'
            self.update(alarm_id, f'Alarm {self.describe(alarm, config)} could not run: {who} away.',
                        status='missed', closed_at=now.isoformat())
            return 'missed'
        if self.blocked(name, to, config):
            self.update(alarm_id, f'Alarm {self.describe(alarm, config)} was cancelled: a space/no-contact '
                                  'boundary is now active.', status='cancelled', closed_at=now.isoformat())
            return 'blocked'
        scene = self.scene_for(name)
        if scene:
            present = scene['participants'] + (['Mystery'] if not scene.get('autonomous') or scene.get('mystery_joined') else [])
            if to not in present:
                if now - parse_time(alarm['at']) >= SCENE_LIMIT:
                    self.update(alarm_id, f'Alarm {self.describe(alarm, config)} was missed: you were busy in person.',
                                status='missed', closed_at=now.isoformat())
                    return 'missed'
                self.update(alarm_id, next_try=(now + BUSY_RETRY).isoformat(), queued=True)
                return 'queued'
        scene_id = scene['id'] if scene else None
        if not self.reserve(name, scene_id):
            since = parse_time(alarm['busy_since']) if alarm.get('busy_since') else now
            if now - since >= BUSY_LIMIT:
                self.update(alarm_id, f'Alarm {self.describe(alarm, config)} was missed: the room stayed busy.',
                            status='missed', closed_at=now.isoformat())
                return 'missed'
            self.update(alarm_id, next_try=(now + BUSY_RETRY).isoformat(), busy_since=since.isoformat())
            return 'busy'
        try:
            with self.lock:
                current = next((a for a in self.load()['alarms'] if a['id'] == alarm_id), None)
                if current is None or current['status'] != 'pending':
                    return None  # Cancelled while waiting for the slot.
                self.update(alarm_id, status='firing', attempts=alarm.get('attempts', 0) + 1)
            try:
                posted = (self.scene_turn(alarm, agent, scene, config) if scene
                          else self.room_turn(alarm, agent, config))
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
                health.emit('turn_failure', name, 'scheduled reply failed', category=self.host['classify_failure'](exc))
                LOG.warning('Alarm %s failed: %s', alarm_id, exc)
                if alarm.get('attempts', 0) + 1 < MAX_ATTEMPTS:
                    self.update(alarm_id, status='pending', next_try=(self.clock() + FAILURE_RETRY).isoformat())
                else:
                    self.update(alarm_id, f'Alarm {self.describe(alarm, config)} failed: your message could not be '
                                          'generated.', status='failed', closed_at=self.clock().isoformat())
                return 'failed'
            where = 'in person' if scene else ('in the group' if alarm['channel'] == 'group' else 'by DM')
            self.update(alarm_id, f"Alarm {alarm['id']} went off at {self.short(self.clock(), config)}; "
                                  f'you sent your planned message to {to} {where}.',
                        status='fired', closed_at=self.clock().isoformat(), message_id=posted['id'],
                        scene_id=scene_id)
            return 'fired'
        finally:
            self.release(scene_id)

    def directive(self, alarm, config, in_scene=False):
        to, channel = alarm['to'], alarm['channel']
        text = (f"\nYOUR ALARM (set at {self.short(alarm['created_at'], config)}): {alarm['intent']}. "
                f"It's now {self.now_text(config)}. Do it now — write the message you planned, to {to}, in "
                f"{'person, here in this scene' if in_scene else channel}.")
        if alarm.get('late'):
            text += ' You are a little late: you could not act at the exact time.'
        if in_scene:
            return text
        if channel == 'dm':
            return text + f' Send it privately: set to to "{to}".'
        return text + f' Post it to the GROUP with to=null and address @{to}.'

    def room_turn(self, alarm, agent, config):
        host, name = self.host, agent['name']
        agents = [a for a in config['agents'] if a.get('enabled', True)]
        messages = [m for m in host['history']() if m['kind'] == 'chat']
        dm = alarm['channel'] == 'dm'
        directive = self.directive(alarm, config)
        # A synthetic DM focus pins the recipient; the alarm is the character's own earlier choice.
        focus = dict(name=alarm['to'], channel='dm', text=directive.strip(), id=None) if dm else None
        prompt = host['make_prompt'](agent, messages, agents, focus, config=config) + directive
        turn = host['serve_turn'](agent, prompt, host['turn_images'](host['life_memory'].visible_messages(messages, name),
            SimpleNamespace(images=[], recall=False)), config, agents, focus, not dm)
        body, note, attachments, recipient, scores, records, resolved, served_by = turn
        host['remember'](name, note)
        relationships.save(name, scores)
        posted = host['append'](name, body, recipient=recipient, attachments=attachments, initiative=True,
                                served_by=served_by, alarm=True)
        # Posted: a failing side effect must not mark the alarm failed and re-post it.
        scenes.after_post(name, lambda: host['life_store'](name, config).apply(
                              records, resolved, posted['id'], posted['time'], embed=False,
                              visible=host['life_memory'].visible_messages(messages + [posted], name)),
                          lambda: host['MEETUPS'].choices(name, turn, config),
                          lambda: self.apply(name, turn, config))
        if recipient == 'Mystery' or (recipient is None and MYSTERY_MENTION.search(body)):
            scenes.after_post(name, lambda: self.spawn(lambda: self.notify(agent, body, config)))
        return posted

    def scene_turn(self, alarm, agent, meta, config):
        host, name, manager = self.host, agent['name'], self.host['SCENES']
        messages = manager.messages(meta['id'])
        store, recalled, pins = manager.recall(agent, meta, messages, config)
        prompt = manager.prompt(agent, meta, messages, config, recalled, pins) + self.directive(alarm, config, True)
        turn = host['serve_turn'](agent, prompt, host['turn_images'](messages, recalled), config,
                                  config['agents'], None, True)
        body, note, attachments, _, scores, records, resolved, served_by = turn
        posted = manager.append(meta['id'], name, body, attachments=attachments, served_by=served_by)
        scenes.after_post(name, lambda: host['remember'](name, note),
                          lambda: relationships.save(name, scores),
                          lambda: store.apply(scenes.in_person(records), resolved, posted['id'], posted['time'],
                                              embed=False, visible=messages + [posted], source=messages[-1] if messages else posted),
                          lambda: self.apply(name, turn, config))
        if alarm['to'] == 'Mystery':
            scenes.after_post(name, lambda: self.spawn(lambda: self.notify(agent, body, config)))
        return posted

    def notify(self, agent, body, config):
        """Wake-up on this machine: notify-send, plus the character's Piper voice through paplay when enabled."""
        quiet = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            subprocess.run(['notify-send', '--app-name=Private Room', '--', agent['name'], body[:500]],
                           timeout=10, check=False, **quiet)
        except (OSError, subprocess.SubprocessError) as exc:
            LOG.info('notify-send unavailable: %s', exc)
        if not settings(config)['alarm_audio']:
            return
        try:
            audio = speech.audio_for(body, agent.get('voice'))
            subprocess.Popen(['paplay', str(audio)], start_new_session=True, **quiet)
        except (speech.SpeechError, OSError, subprocess.SubprocessError) as exc:
            LOG.info('Alarm audio unavailable: %s', exc)

    # ---- operator API ------------------------------------------------------------------------------
    def public(self, config):
        with self.lock:
            data = self.load()
        alarms = [dict(a, at_local=self.short(a['at'], config), created_local=self.short(a['created_at'], config))
                  for a in sorted(data['alarms'], key=lambda a: a['at']) if a['status'] in OPEN]
        wakeups = [{k: m.get(k) for k in ('id', 'name', 'text', 'time', 'to', 'channel')}
                   for m in self.host['history']()[-250:]
                   if m.get('alarm') and (m.get('to') == 'Mystery' or
                                          (m.get('channel') == 'group' and MYSTERY_MENTION.search(m.get('text', ''))))]
        return dict(now=self.now_text(config), timezone=settings(config)['timezone'], alarms=alarms,
                    wakeups=wakeups[-10:])

    def cancel(self, alarm_id, config):
        with self.lock:
            data = self.load()
            alarm = next((a for a in data['alarms'] if a['id'] == alarm_id), None)
            if alarm is None:
                raise scenes.SceneError('Alarm not found', 404)
            if alarm['status'] != 'pending':
                raise scenes.SceneError(f"Alarm is already {alarm['status']}", 409)
            alarm.update(status='cancelled', closed_at=self.clock().isoformat())
            self.notice(data, alarm['owner'], f'Alarm {self.describe(alarm, config)} was cancelled; it will not go off.')
            self.save(data)
            return alarm

    def handle(self, handler, path, method):
        if method == 'GET' and path == '/alarms.js':
            handler.send_payload((self.host['ROOT'] / 'web' / 'alarms.js').read_bytes(), 'text/javascript; charset=utf-8')
            return True
        if path != '/api/alarms' and not path.startswith('/api/alarms/'):
            return False
        try:
            config = self.host['load_config']()
            match = re.fullmatch(r'/api/alarms/(' + ID + r')/cancel', path)
            if method == 'GET' and path == '/api/alarms':
                handler.send_json(self.public(config))
            elif method == 'POST' and match:
                refused = scenes.request_refused(handler, write=True)
                if refused:
                    raise scenes.SceneError(refused, 403)
                size = int(handler.headers.get('Content-Length', 0))
                if not 1 <= size <= 4096 or not isinstance(json.loads(handler.rfile.read(size)), dict):
                    raise scenes.SceneError('request must be a small JSON object')
                handler.send_json(dict(alarm=self.cancel(match[1], config)))
            else:
                raise scenes.SceneError('Alarm route not found', 404)
        except scenes.SceneError as exc:
            handler.send_json({'error': str(exc)}, exc.code)
        except (ValueError, TypeError, KeyError, OSError):
            handler.send_json({'error': 'Invalid alarm request'}, 400)
        return True
