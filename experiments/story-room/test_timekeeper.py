"""Alarm (time function call) tests: fake clock, temporary stores, mocked provider/subprocess, no network."""
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from test_support import HermeticTestCase
from unittest.mock import patch

import meetups
import server
import test_scenes
import timekeeper

START = datetime(2026, 10, 15, 17, 41, tzinfo=timezone.utc)  # Thursday 23:41 in Asia/Dhaka
NOW_LINE = 'NOW: Thursday 2026-10-15 23:41 (Asia/Dhaka)'


class TimekeeperTests(HermeticTestCase):
    def setUp(self):
        state_patch = patch.dict(server.STATE)
        state_patch.start()
        self.addCleanup(state_patch.stop)
        test_scenes.SceneTests.setUp(self)
        self.addCleanup(server.ACTIVE.clear)
        server.ACTIVE.clear()
        self.now = START
        self.tk = timekeeper.Timekeeper(vars(server), clock=lambda: self.now, spawn=lambda target: target())
        patcher = patch.object(server, 'TIMEKEEPER', self.tk)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.meetups = meetups.Meetups(vars(server))
        patcher = patch.object(server, 'MEETUPS', self.meetups)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.prompts = []
        self.reply = dict(message="Morning, sleepyhead. I'm up, as promised.", memory='I keep my promises.', to=None)
        self.fail_provider = False
        self.run = patch('timekeeper.subprocess.run').start()
        self.popen = patch('timekeeper.subprocess.Popen').start()
        self.audio = patch('timekeeper.speech.audio_for', return_value=Path('/tmp/wake.wav')).start()
        self.addCleanup(patch.stopall)

    def provider(self, agent, prompt, timeout, images=None):
        self.prompts.append((agent['name'], prompt))
        if self.fail_provider:
            raise RuntimeError('mock provider failure')
        return json.dumps(self.reply)

    def calls(self, name, *calls):
        return self.tk.apply(name, meetups.Turn((), dict(calls=list(calls))), self.config)

    def alarm(self, at='07:00', to='Mystery', intent='Wake Ryoma gently', channel='dm', owner='Iris'):
        result = self.calls(owner, dict(fn='set_alarm', at=at, to=to, intent=intent, channel=channel))[0]
        self.assertIn('set_alarm ok', result)
        return result.split()[2]

    def boundary(self, owner, target):
        record = dict(segment='boundaries', about=[target], text=f'{target} asked for space.',
                      tags=['space'], importance=5, status='open')
        server.life_store(owner).apply([record], source_id=owner + target, embed=False)

    def status(self, alarm_id):
        return next(a for a in self.tk.load()['alarms'] if a['id'] == alarm_id)

    def notify_calls(self):
        return [c.args[0] for c in self.run.call_args_list if c.args and c.args[0][0] == 'notify-send']

    # ---- prompts ---------------------------------------------------------------------------
    def test_now_string_in_room_dm_scene_and_meetup_prompts(self):
        room = server.make_prompt(self.agent, [], self.config['agents'], config=self.config)
        self.assertIn(NOW_LINE, room)
        self.assertIn('"fn":"set_alarm"', room)
        focus = dict(id='1', name='Mystery', channel='dm', to='Iris', text='Still up?', kind='chat')
        self.assertIn(NOW_LINE, server.make_prompt(self.agent, [focus], self.config['agents'], focus, config=self.config))
        scene = self.manager.create(dict(participants=['Iris'], kind='hangout', title='Tea', location='Cafe', opening='We sit.'))
        self.manager.reply(scene['id'])
        self.assertTrue(any(NOW_LINE in p for _, p in self.prompts))
        meta = dict(title='Walk', kind='hangout', location='Garden', participants=['Iris', 'Milo'], exchanges=0)
        meetup = self.meetups.scene_prompt(self.agent, meta, [], self.config, SimpleNamespace(block=''), '')
        self.assertIn(NOW_LINE, meetup)
        self.config['timezone'] = 'UTC'
        self.assertIn('NOW: Thursday 2026-10-15 17:41 (UTC)', self.tk.prompt('Iris', self.config))
        for bad in ({'timezone': 'Mars/Base'}, {'timezone': 5}, {'alarm_audio': 'yes'}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                timekeeper.settings(bad)

    # ---- validation ---------------------------------------------------------------------------
    def test_set_alarm_validation_bounds_recipient_channel_and_formats(self):
        cases = [
            (dict(at='23:45'), 'at least 10 minutes'),
            (dict(at='2026-10-23T23:42'), 'within 7 days'),
            (dict(at='tomorrow-ish'), 'could not read'),
            (dict(at='25:00'), 'invalid time'),
            (dict(to='Zed'), 'unknown recipient'),
            (dict(to='Iris'), 'someone else'),
            (dict(channel='email'), 'channel must be'),
            (dict(intent=' '), 'intent is required'),
        ]
        for changes, expected in cases:
            call = dict(fn='set_alarm', at='07:00', to='Mystery', intent='Wake Ryoma', channel='dm', **{})
            call.update(changes)
            with self.subTest(changes=changes):
                self.assertIn(expected, self.calls('Iris', call)[0])
        self.assertEqual(self.tk.load()['alarms'], [])
        # HH:MM is the next occurrence in local time; naive ISO is local; Z/offsets convert.
        first = self.status(self.alarm('07:00'))
        self.assertEqual(first['at'], '2026-10-16T07:00:00+06:00')
        second = self.status(self.alarm('2026-10-16T09:30', intent='Ask about the interview'))
        self.assertEqual(second['at'], '2026-10-16T09:30:00+06:00')
        third = self.status(self.alarm('2026-10-16T06:00:00Z', to='Milo', intent='Check in', channel='group'))
        self.assertEqual(third['at'], '2026-10-16T12:00:00+06:00')
        self.assertEqual(third['channel'], 'group')

    def test_caps_dedupe_and_daily_limit(self):
        self.alarm('07:00', intent='Wake Ryoma gently!')
        self.assertIn('already scheduled', self.calls('Iris', dict(fn='set_alarm', at='07:20', to='Mystery',
                                                                    intent='wake ryoma gently'))[0])
        self.alarm('08:00', intent='Wake Ryoma gently')  # Same intent, outside 30 minutes.
        third = self.alarm('09:00', to='Milo', intent='Ask Milo about breakfast')
        self.assertIn('3 pending', self.calls('Iris', dict(fn='set_alarm', at='10:00', to='Theo', intent='Hi'))[0])
        self.alarm('10:00', to='Theo', intent='Hi', owner='Nora')  # Caps are per character.
        self.assertIn('cancel_alarm ok', self.calls('Iris', dict(fn='cancel_alarm', id=third))[0])
        self.alarm('10:00', to='Theo', intent='Say hi')
        self.calls('Iris', dict(fn='cancel_alarm', id=self.tk.load()['alarms'][-1]['id']))
        self.alarm('10:00', to='Theo', intent='Say hello')
        self.calls('Iris', dict(fn='cancel_alarm', id=self.tk.load()['alarms'][-1]['id']))
        self.alarm('11:00', to='Theo', intent='Say hey')  # Sixth created today (cancelled ones count).
        self.calls('Iris', dict(fn='cancel_alarm', id=self.tk.load()['alarms'][-1]['id']))
        self.assertIn('daily limit', self.calls('Iris', dict(fn='set_alarm', at='12:00', to='Theo', intent='Yo'))[0])
        self.now += timedelta(hours=1)  # 00:41 local: a new calendar day.
        self.alarm('12:00', to='Theo', intent='Yo')

    def test_blocked_contact_from_either_side_and_at_fire_time(self):
        self.boundary('Iris', 'Milo')
        self.assertIn('boundary', self.calls('Iris', dict(fn='set_alarm', at='07:00', to='Milo', intent='Hi'))[0])
        self.boundary('Theo', 'Nora')
        self.assertIn('boundary', self.calls('Nora', dict(fn='set_alarm', at='07:00', to='Theo', intent='Hi'))[0])
        self.boundary('Mina', 'Mystery')
        self.assertIn('boundary', self.calls('Mina', dict(fn='set_alarm', at='07:00', to='Mystery', intent='Hi'))[0])
        alarm_id = self.alarm('07:00', to='Mystery', owner='Nora')
        self.boundary('Nora', 'Mystery')
        self.now = START + timedelta(hours=8)
        self.assertEqual(self.tk.tick(self.config), 'blocked')
        self.assertEqual(self.status(alarm_id)['status'], 'cancelled')
        self.assertEqual(self.prompts, [])

    def test_quiet_room_fires_alarms_to_mystery_and_defers_cast_alarms(self):
        server.set_quiet_room(True)
        cast = self.alarm('07:00', to='Milo', intent='Check on Milo')
        mine = self.alarm('07:30', intent='Wake Ryoma')
        self.now = START + timedelta(hours=7, minutes=50)  # 07:31 local: both are due.
        self.assertEqual(self.tk.tick(self.config), 'fired')
        self.assertEqual((self.status(mine)['status'], self.status(cast)['status']), ('fired', 'pending'))
        self.assertIsNone(self.tk.tick(self.config))
        self.now = START + timedelta(hours=10)  # Over two hours late, but quiet defers instead of sweeping.
        self.assertIsNone(self.tk.tick(self.config))
        self.assertEqual(self.status(cast)['status'], 'pending')
        self.assertEqual(len(self.prompts), 1)
        self.now = START + timedelta(hours=8)  # Quiet ends while the alarm is under two hours late: it fires.
        server.set_quiet_room(False)
        self.assertEqual(self.tk.tick(self.config), 'fired')
        self.assertEqual(server.history()[-1]['to'], 'Milo')

    def test_cancel_list_get_time_and_malformed_calls(self):
        mine = self.alarm('07:00')
        other = self.alarm('07:00', owner='Nora')
        results = self.calls('Iris', dict(fn='cancel_alarm', id=other), dict(fn='list_alarms'), dict(fn='get_time'),
                             dict(fn='launch_rocket'), 'nope', dict(fn='get_time'))
        self.assertIn('no alarm of yours', results[0])
        self.assertEqual(results[1], 'list_alarms: 1 pending (listed under YOUR SCHEDULED ACTIONS)')
        self.assertEqual(results[2], 'get_time: Thursday 2026-10-15 23:41 (Asia/Dhaka)')
        self.assertIn('unknown function', results[3])
        self.assertIn('must be a JSON object', results[4])
        self.assertEqual(results[5], 'only the first 5 calls were run')
        alias = self.calls('Iris', dict(name='cancel_alarm', arguments=dict(id='a00000000')))
        self.assertIn('no alarm of yours', alias[0])
        self.assertIn('must be a list', self.tk.apply('Iris', meetups.Turn((), dict(calls='x')), self.config)[0])
        self.assertIn('cancel_alarm ok', self.calls('Iris', dict(fn='cancel_alarm', id=mine))[0])
        self.assertIn('already cancelled', self.calls('Iris', dict(fn='cancel_alarm', id=mine))[0])
        self.assertEqual(self.status(other)['status'], 'pending')

    # ---- results next turn ------------------------------------------------------------------
    def test_results_and_schedule_surface_on_next_turn_then_clear(self):
        alarm_id = self.alarm('07:00')
        self.calls('Iris', dict(fn='set_alarm', at='23:45', to='Mystery', intent='x'))
        prompt = self.tk.prompt('Iris', self.config)
        self.assertIn(f'YOUR SCHEDULED ACTIONS (private; only you see these): {alarm_id}: Fri 2026-10-16 07:00 → Mystery (dm): Wake Ryoma gently', prompt)
        self.assertIn(f'set_alarm ok: {alarm_id}', prompt)
        self.assertIn('set_alarm rejected: at must be at least 10 minutes', prompt)
        self.assertNotIn('Wake Ryoma', self.tk.prompt('Nora', self.config))
        self.tk.apply('Iris', meetups.Turn(()), self.config)  # The turn that saw the results consumed them.
        prompt = self.tk.prompt('Iris', self.config)
        self.assertNotIn('RESULTS OF YOUR TIME CALLS', prompt)
        self.assertIn(alarm_id, prompt)

    def test_real_room_turn_parses_calls_and_reports_next_turn(self):
        self.config['agents'] = [self.agent]
        server.ACTIVE.set()
        self.reply = dict(message='Goodnight, Ryoma. Sleep properly this time.', memory='I care about Ryoma.',
                          to='Mystery', calls=[dict(fn='set_alarm', at='07:00', to='Mystery',
                                                    intent='Wake him up like I promised', channel='dm')])
        server.append('Mystery', 'Goodnight Iris', recipient='Iris')
        server.run_turn(self.config)
        alarms = self.tk.load()['alarms']
        self.assertEqual([(a['owner'], a['to'], a['intent']) for a in alarms],
                         [('Iris', 'Mystery', 'Wake him up like I promised')])
        self.assertIn(NOW_LINE, self.prompts[0][1])
        self.assertEqual(server.STATE['turns'], 1)
        self.assertIn('set_alarm ok: ' + alarms[0]['id'], self.tk.prompt('Iris', self.config))

    # ---- firing -----------------------------------------------------------------------------
    def test_fire_while_paused_runs_exactly_one_turn_and_wakes_mystery(self):
        self.config['alarm_audio'] = True
        alarm_id = self.alarm('07:00', intent='Wake Ryoma like I promised')
        server.STATE.update(turns=5, limit=24, reason='Paused. Take your time.')
        self.now = START + timedelta(hours=7, minutes=18)  # 06:59 local
        self.assertIsNone(self.tk.tick(self.config))
        self.now = START + timedelta(hours=7, minutes=19)  # 07:00 local
        self.assertEqual(self.tk.tick(self.config), 'fired')
        self.assertEqual(len(self.prompts), 1)
        prompt = self.prompts[0][1]
        self.assertIn('YOUR ALARM (set at Thu 2026-10-15 23:41): Wake Ryoma like I promised.', prompt)
        self.assertIn("It's now Friday 2026-10-16 07:00 (Asia/Dhaka)", prompt)
        self.assertIn('to Mystery, in dm', prompt)
        self.assertFalse(server.ACTIVE.is_set())
        self.assertEqual((server.STATE['turns'], server.STATE['reason'], server.STATE['speaker']),
                         (5, 'Paused. Take your time.', None))
        posted = server.history()[-1]
        self.assertEqual((posted['name'], posted['to'], posted['channel'], posted['alarm']), ('Iris', 'Mystery', 'dm', True))
        self.assertEqual(self.status(alarm_id)['status'], 'fired')
        self.assertEqual(self.status(alarm_id)['message_id'], posted['id'])
        self.assertEqual(self.notify_calls(), [['notify-send', '--app-name=Private Room', '--', 'Iris', posted['text']]])
        self.audio.assert_called_once_with(posted['text'], self.agent['voice'])
        self.assertEqual(self.popen.call_args.args[0], ['paplay', '/tmp/wake.wav'])
        self.assertIsNone(self.tk.tick(self.config))  # Fires once.
        self.assertEqual(len(self.prompts), 1)
        self.assertIn('went off at Fri 2026-10-16 07:00', self.tk.prompt('Iris', self.config))
        self.assertEqual(self.tk.public(self.config)['wakeups'][-1]['id'], posted['id'])

    def test_notification_rules_for_group_and_cast_dm_and_audio_failures_ignored(self):
        self.run.side_effect = FileNotFoundError('notify-send')
        self.audio.side_effect = timekeeper.speech.SpeechError('no voice')
        self.config['alarm_audio'] = True
        self.alarm('07:00', to='Milo', intent='Check on Milo', channel='dm')
        self.alarm('07:30', to='Milo', intent='Toast Milo', channel='group')
        self.alarm('08:00', to='Mystery', intent='Wake the room', channel='group')
        self.now = START + timedelta(hours=9)
        self.assertEqual(self.tk.tick(self.config), 'fired')
        self.assertEqual(server.history()[-1]['to'], 'Milo')
        self.reply = dict(message='Cheers @Milo!', memory='Fine.', to=None)
        self.assertEqual(self.tk.tick(self.config), 'fired')
        self.assertEqual(server.history()[-1]['channel'], 'group')
        self.assertEqual(self.notify_calls(), [])
        self.assertIn('Post it to the GROUP with to=null and address @Milo', self.prompts[-1][1])
        self.reply = dict(message='Rise and shine, @Mystery!', memory='Fine.', to=None)
        self.assertEqual(self.tk.tick(self.config), 'fired')
        self.assertEqual(len(self.notify_calls()), 1)  # Failure ignored; turn still succeeded.
        self.assertEqual([m.get('alarm') for m in server.history()[-3:]], [True, True, True])
        self.popen.assert_not_called()

    def test_busy_slot_retries_every_15_seconds_up_to_10_minutes(self):
        alarm_id = self.alarm('07:00')
        server.STATE['speaker'] = 'Theo'
        self.now = START + timedelta(hours=7, minutes=19)
        self.assertEqual(self.tk.tick(self.config), 'busy')
        self.now += timedelta(seconds=10)
        self.assertIsNone(self.tk.tick(self.config))
        self.now += timedelta(seconds=5)
        self.assertEqual(self.tk.tick(self.config), 'busy')
        server.STATE['speaker'] = None
        self.manager.jobs['x' * 32] = dict(operation='reply', speaker='Milo')  # A scene step in flight.
        self.now += timedelta(seconds=15)
        self.assertEqual(self.tk.tick(self.config), 'busy')
        self.manager.jobs.clear()
        self.now += timedelta(seconds=15)
        self.assertEqual(self.tk.tick(self.config), 'fired')
        self.assertEqual(self.status(alarm_id)['status'], 'fired')
        second = self.alarm('08:30', intent='Second wake-up')
        server.STATE['speaker'] = 'Theo'
        self.now = START + timedelta(hours=8, minutes=49)
        for _ in range(45):
            outcome = self.tk.tick(self.config)
            self.now += timedelta(seconds=15)
            if outcome == 'missed':
                break
        self.assertEqual(outcome, 'missed')
        self.assertEqual(self.status(second)['status'], 'missed')
        self.assertGreaterEqual(parse(self.status(second)['closed_at']) - START - timedelta(hours=8, minutes=49),
                                timedelta(minutes=10))
        self.assertEqual(len(self.prompts), 1)
        self.assertEqual(server.STATE['speaker'], 'Theo')  # Never took the slot from the room.

    def test_scene_queueing_and_in_scene_delivery(self):
        scene = self.manager.create(dict(participants=['Iris'], kind='hangout', title='Tea', location='Cafe'))
        to_milo = self.alarm('07:00', to='Milo', intent='Ask Milo about his race')
        self.now = START + timedelta(hours=7, minutes=19)
        self.assertEqual(self.tk.tick(self.config), 'queued')
        self.assertEqual(self.prompts, [])
        meta = self.manager.meta(scene['id'])
        meta['status'] = 'ended'
        self.manager.save(meta)
        self.now += timedelta(seconds=15)
        self.assertEqual(self.tk.tick(self.config), 'fired')
        self.assertEqual(server.history()[-1]['to'], 'Milo')
        self.assertEqual(self.status(to_milo)['status'], 'fired')
        # Recipient present in the scene: delivered in person; Mystery still gets the desktop wake-up.
        self.now = START + timedelta(hours=7, minutes=49)  # 07:30, Iris has woken.
        scene = self.manager.create(dict(participants=['Iris'], kind='date', title='Dawn', location='Roof'))
        to_mystery = self.alarm('08:00', to='Mystery', intent='Wake Ryoma on the roof')
        to_theo = self.alarm('08:30', to='Theo', intent='Tease Theo')
        self.now = START + timedelta(hours=8, minutes=19)
        before = len(server.history())
        self.assertEqual(self.tk.tick(self.config), 'fired')
        self.assertEqual(len(server.history()), before)
        self.assertEqual(self.manager.messages(scene['id'])[-1]['name'], 'Iris')
        self.assertIn("in person, here in this scene", self.prompts[-1][1])
        self.assertEqual(self.status(to_mystery)['scene_id'], scene['id'])
        self.assertEqual(len(self.notify_calls()), 1)
        self.assertNotIn(scene['id'], self.manager.jobs)
        self.now = START + timedelta(hours=8, minutes=49)
        self.assertEqual(self.tk.tick(self.config), 'queued')
        self.now = START + timedelta(hours=9, minutes=20)  # 30 minutes after due.
        self.assertEqual(self.tk.tick(self.config), 'missed')
        self.assertIn('busy in person', self.tk.prompt('Iris', self.config))
        self.assertEqual(self.status(to_theo)['status'], 'missed')

    def test_provider_failure_retries_once_then_reports(self):
        alarm_id = self.alarm('07:00')
        self.fail_provider = True
        self.now = START + timedelta(hours=7, minutes=19)
        with self.assertLogs('timekeeper', 'WARNING'):
            self.assertEqual(self.tk.tick(self.config), 'failed')
        self.assertEqual(self.status(alarm_id)['status'], 'pending')
        self.assertIsNone(self.tk.tick(self.config))
        self.now += timedelta(seconds=60)
        with self.assertLogs('timekeeper', 'WARNING'):
            self.assertEqual(self.tk.tick(self.config), 'failed')
        self.assertEqual(self.status(alarm_id)['status'], 'failed')
        self.assertIsNone(server.STATE['speaker'])
        self.assertIn('could not be generated', self.tk.prompt('Iris', self.config))
        self.assertFalse(any(m.get('alarm') for m in server.history()))

    # ---- persistence ---------------------------------------------------------------------------
    def test_persistence_restart_and_missed_alarm_policy(self):
        early = self.alarm('00:30', intent='Remind Ryoma to drink water')
        later = self.alarm('01:00', to='Milo', intent='Say goodnight to Milo')
        stuck = self.alarm('01:15', to='Theo', intent='Tease Theo')
        self.tk.update(stuck, status='firing')  # Crashed mid-call.
        self.assertTrue((server.DATA / 'alarms.json').is_file())
        # Restart at 02:36, 2 h 06 m after the first was due: 00:30 is missed, 01:00 and 01:15 fire once.
        self.now = START + timedelta(hours=2, minutes=55)
        restarted = timekeeper.Timekeeper(vars(server), clock=lambda: self.now, spawn=lambda target: target())
        self.tk = restarted
        with patch.object(server, 'TIMEKEEPER', restarted):
            restarted.recover(self.config)
            self.assertEqual(self.status(early)['status'], 'missed')
            self.assertTrue(self.status(later)['late'])
            self.assertEqual(self.status(stuck)['status'], 'pending')
            self.assertEqual(restarted.tick(self.config), 'fired')
            self.assertIn('You are a little late', self.prompts[-1][1])
            self.assertIn('was missed: it was more than two hours late', self.prompts[-1][1])
            self.assertEqual(restarted.tick(self.config), 'fired')
            self.assertIsNone(restarted.tick(self.config))
            self.assertEqual(len(self.prompts), 2)
            self.assertEqual(self.status(later)['status'], 'fired')
            self.assertEqual(self.status(stuck)['status'], 'fired')

    def test_suspended_clock_jump_marks_missed_and_corrupt_file_is_set_aside(self):
        alarm_id = self.alarm('07:00')
        self.now = START + timedelta(hours=10)
        self.assertIsNone(self.tk.tick(self.config))
        self.assertEqual(self.status(alarm_id)['status'], 'missed')
        self.assertEqual(self.prompts, [])
        (server.DATA / 'alarms.json').write_text('{broken', encoding='utf-8')
        with self.assertLogs('timekeeper', 'ERROR'):
            self.assertEqual(self.tk.load()['alarms'], [])
        self.assertEqual(len(list(server.DATA.glob('alarms.corrupt-*.json'))), 1)
        self.alarm('11:00')

    # ---- operator API ---------------------------------------------------------------------------
    def test_operator_list_and_cancel_routes(self):
        alarm_id = self.alarm('07:00')
        handler = FakeHandler()
        self.assertTrue(self.tk.handle(handler, '/api/alarms', 'GET'))
        listed = handler.sent[-1][0]
        self.assertEqual(listed['alarms'][0]['id'], alarm_id)
        self.assertEqual(listed['alarms'][0]['at_local'], 'Fri 2026-10-16 07:00')
        self.assertEqual(listed['now'], 'Thursday 2026-10-15 23:41 (Asia/Dhaka)')
        foreign = FakeHandler(b'{}', origin='http://evil.example')
        self.tk.handle(foreign, f'/api/alarms/{alarm_id}/cancel', 'POST')
        self.assertEqual(foreign.sent[-1][1], 403)
        cancel = FakeHandler(b'{}')
        self.tk.handle(cancel, f'/api/alarms/{alarm_id}/cancel', 'POST')
        self.assertEqual(cancel.sent[-1][0]['alarm']['status'], 'cancelled')
        again = FakeHandler(b'{}')
        self.tk.handle(again, f'/api/alarms/{alarm_id}/cancel', 'POST')
        self.assertEqual(again.sent[-1][1], 409)
        missing = FakeHandler(b'{}')
        self.tk.handle(missing, '/api/alarms/a12345678/cancel', 'POST')
        self.assertEqual(missing.sent[-1][1], 404)
        self.assertIn('was cancelled; it will not go off', self.tk.prompt('Iris', self.config))
        script = FakeHandler()
        self.assertTrue(self.tk.handle(script, '/alarms.js', 'GET'))
        self.assertFalse(self.tk.handle(FakeHandler(), '/api/status', 'GET'))


def parse(value):
    return datetime.fromisoformat(value)


class FakeHandler:
    def __init__(self, body=b'', origin=None):
        self.headers = {'Content-Length': str(len(body)), 'Host': '127.0.0.1:8765'}
        if origin:
            self.headers['Origin'] = origin
        self.rfile = io.BytesIO(body)
        self.sent = []

    def send_json(self, data, code=200):
        self.sent.append((data, code))

    def send_payload(self, payload, content_type, code=200, cache='no-store'):
        self.sent.append((payload, code))


if __name__ == '__main__':
    unittest.main()
