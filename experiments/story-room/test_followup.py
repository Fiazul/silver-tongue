"""Offline follow-up regressions; every store uses the shared temporary fixture."""
from datetime import timedelta
import json
import logging
from pathlib import Path
import tempfile
import time
import unittest
from test_support import HermeticTestCase
from unittest.mock import patch
import health
import server
import test_daily_attention


class FollowupTests(HermeticTestCase):
    setUp = test_daily_attention.DailyAttentionTests.setUp
    provider = test_daily_attention.DailyAttentionTests.provider

    def setup_pair(self):
        self.host = dict(self.agent, name='Vella', kind='ship_ai', host_level=True,
                         group_initiative=False, routine={}, sibling=None)
        self.agent['routine'] = {}
        self.config['agents'] = [self.agent, self.host]
        server.set_quiet_room(True)

    def run_reply(self, name, to=None, done=False):
        self.invoke.side_effect = None
        self.invoke.return_value = json.dumps(dict(message='How are you?', memory='We talked.', to=to, thread_done=done))
        before = len(server.history())
        server.run_turn(self.config)
        self.assertEqual(len(server.history()), before+1)
        self.assertEqual(server.history()[-1]['name'], name)
        return server.history()[-1]

    def test_quiet_host_cast_conversation(self):
        self.setup_pair()
        server.append('Iris', 'Which way do you lean?', recipient='Vella')
        self.run_reply('Vella')
        self.run_reply('Iris')
        self.run_reply('Vella', done=True)
        self.assertIsNone(server.quiet_turn(server.history(), self.config['agents'], self.config))

    def test_waiting_mystery_threads_do_not_block_host_cast_dms(self):
        self.setup_pair()
        for name in ('Vella', 'Iris'):
            question = server.append('Mystery', 'How are you?', recipient=name)
            server.append(name, 'I am okay.', recipient='Mystery', reply_to=question['id'])
        server.append('Iris', 'Which way do you lean?', recipient='Vella')
        self.run_reply('Vella')
        self.run_reply('Iris')
        self.run_reply('Vella', done=True)

    def test_cast_waiting_for_mystery_can_reply_to_host_dm(self):
        self.setup_pair()
        question = server.append('Mystery', 'How are you?', recipient='Iris')
        server.append('Iris', 'I am okay.', recipient='Mystery', reply_to=question['id'])
        server.append('Vella', 'Iris, want some company?', recipient='Iris', initiative=True)
        self.run_reply('Iris')
        self.run_reply('Vella', done=True)

    def test_request_is_private_once_and_exempt(self):
        self.setup_pair()
        request = server.append('Mystery', 'Please talk to Iris properly and spend time with Iris.', recipient='Vella')
        self.run_reply('Vella')
        turns = server.STATE['turns']
        posted = self.run_reply('Vella', 'Iris')
        self.assertEqual(posted['host_request'], request['id'])
        self.assertEqual(server.STATE['turns'], turns)
        self.assertIsNone(server.host_request(self.host, server.history(), self.config))

    def test_request_phrases_human_hosts_and_contact_boundaries(self):
        self.setup_pair()
        self.host['kind'] = 'human'
        for phrase in ('talk to Iris', 'spend time with Iris', 'check on Iris'):
            with self.subTest(phrase=phrase):
                request = server.append('Mystery', phrase, recipient='Vella')
                self.assertEqual(server.host_request(self.host, server.history(), self.config), (request, 'Iris'))
        server.life_store('Iris').apply([dict(segment='boundaries', about=['Vella'],
            text='Vella, please give me space.', tags=['space'], importance=5, status='open')],
            source_id='boundary', embed=False)
        self.assertIsNone(server.host_request(self.host, server.history(), self.config))

    def test_focus_request_schedules_real_host_dm_after_acknowledgement(self):
        self.setup_pair()
        request = server.append('Mystery', 'you win.. just focus on Iris.', recipient='Vella')
        self.run_reply('Vella')
        posted = self.run_reply('Vella', 'Iris')
        self.assertEqual(posted['host_request'], request['id'])
        self.run_reply('Iris')

    def test_requested_human_can_contact_host_in_quiet_room(self):
        self.setup_pair()
        request = server.append('Mystery', 'please talk to Vella about the sky', recipient='Iris')
        self.run_reply('Iris')
        posted = self.run_reply('Iris', 'Vella')
        self.assertEqual(posted['host_request'], request['id'])
        self.assertIn('OUTREACH: Send a private DM to Vella', self.invoke.call_args.args[1])
        self.run_reply('Vella')
        self.run_reply('Iris', done=True)
        self.assertIsNone(server.host_request(self.agent, server.history(), self.config))

    def test_contact_after_request_fulfills_it_without_replaying_old_orders(self):
        self.setup_pair()
        server.append('Mystery', 'talk to Iris', recipient='Vella')
        server.append('Iris', 'Can we talk?', recipient='Vella')
        self.run_reply('Vella')
        self.run_reply('Vella')
        self.assertIsNone(server.host_request(self.host, server.history(), self.config))

    def test_negative_contact_requests_do_not_schedule_outreach(self):
        self.setup_pair()
        for phrase in ("don't talk to Iris", 'do not message Iris', 'never focus on Iris',
                       'Iris said "talk to Iris"', 'Can you explain why you did not talk to Iris?'):
            with self.subTest(phrase=phrase):
                message = dict(id='negative', name='Mystery', to='Vella', channel='dm', text=phrase,
                               time=self.now.isoformat(), kind='chat')
                self.assertIsNone(server.host_request(self.host, [message], self.config))

    def test_new_negative_request_cancels_older_outreach(self):
        self.setup_pair()
        server.append('Mystery', 'talk to Iris', recipient='Vella')
        server.append('Mystery', 'do not message Iris', recipient='Vella')
        self.assertIsNone(server.host_request(self.host, server.history(), self.config))

    def test_newest_mystery_preempts_cast_and_old_private_question(self):
        self.setup_pair()
        old = server.append('Mystery', 'Old question', recipient='Vella')
        server.append('Vella', 'Answered', recipient='Mystery', reply_to=old['id'])
        server.append('Iris', 'Another question', recipient='Vella')
        newest = server.append('Mystery', 'Vella, newest question?', reply_to=None)
        thread = server.thread_for(self.host, server.history(), self.config)
        self.assertEqual(thread['message']['id'], newest['id'])
        self.run_reply('Vella')
        pending = server.attention_for('Vella', server.history(), self.config['agents'])['pending']
        self.assertFalse(any(r['last_message_id'] in (old['id'], newest['id']) for r in pending))

    def test_newest_mystery_channel(self):
        self.setup_pair()
        server.append('Mystery', 'Old private question', recipient='Vella')
        newest = server.append('Mystery', 'Vella, newer public question?')
        self.assertEqual(server.thread_for(self.host, server.history(), self.config)['message']['id'], newest['id'])

    def test_quiet_conversation_cap_closes_naturally(self):
        self.setup_pair()
        for i in range(23):
            sender, peer = ('Iris', 'Vella') if i % 2 == 0 else ('Vella', 'Iris')
            server.append(sender, 'Another thought?', recipient=peer)
        posted = self.run_reply('Vella')
        self.assertTrue(posted['thread_done'])
        self.assertIn('Close warmly and naturally', self.invoke.call_args.args[1])
        self.assertIsNone(server.quiet_turn(server.history(), self.config['agents'], self.config))

    def test_exchange_cap_resets_after_natural_silence(self):
        self.setup_pair()
        old_time = (self.now-timedelta(hours=2)).isoformat()
        old = [dict(id=str(i), name='Iris' if i % 2 == 0 else 'Vella',
                    to='Vella' if i % 2 == 0 else 'Iris', channel='dm', text='A thought?',
                    time=old_time) for i in range(24)]
        incoming = dict(id='new', name='Iris', to='Vella', channel='dm', text='Can we talk?',
                        time=self.now.isoformat())
        messages = old + [incoming]
        self.assertEqual(server.host_exchange_count('Vella', 'Iris', messages), 1)
        self.assertEqual(server.thread_for(self.host, messages, self.config)['message']['id'], 'new')
        incoming['time'] = old_time
        messages = old + [dict(name='Theo', text='Small talk') for _ in range(6)] + [incoming]
        self.assertEqual(server.host_exchange_count('Vella', 'Iris', messages), 1)

    def test_ordinary_quiet_no_group_initiative(self):
        self.setup_pair()
        self.assertIsNone(server.quiet_turn([], [self.agent], self.config))

    def test_optional_extras_preserve_message(self):
        variants = [dict(inspect=42), dict(thread_done='false'), dict(attachments='bad'),
                    dict(attachments=['/etc/passwd', None]), dict(scores={'Mystery': {'like':1501}})]
        for extras in variants:
            with self.subTest(extras=extras):
                result = dict(message='Still here.', memory='I am here.', to=None, **extras)
                with patch.object(server, 'actor_result', return_value=result):
                    reply = server.validated_turn(self.agent, self.agent, '', [], self.config,
                                                  self.config['agents'], None, False, time.monotonic()+10)
                self.assertEqual(reply[0], 'Still here.')
                self.assertEqual(reply[2], [])
                if 'thread_done' in extras:
                    self.assertIs(reply.choices['thread_done'], False)

    def test_attachment_filter_keeps_three_valid(self):
        result = dict(message='Images.', memory='Shared images.', attachments=[None,'bad','a','b','c','d'])
        def image(path):
            if path == 'bad': raise ValueError('bad')
            return Path('/tmp')/path
        with patch.object(server, 'actor_result', return_value=result), patch.object(server.project_tools, 'image_path', side_effect=image):
            reply = server.validated_turn(self.agent, self.agent, '', [], self.config,
                                         self.config['agents'], None, False, time.monotonic()+10)
        self.assertEqual(reply[2], ['/tmp/a','/tmp/b','/tmp/c'])

    def test_bad_inspection_path_preserves_message_without_second_call(self):
        result = dict(message='Still here.', memory='I am here.', inspect=dict(query='project', project='/etc'))
        with patch.object(server, 'actor_result', return_value=result) as actor, patch.object(
                server.project_tools, 'inspect_projects', side_effect=ValueError('invalid project')):
            reply = server.validated_turn(self.agent, self.agent, '', [], self.config,
                                          self.config['agents'], None, False, time.monotonic()+10)
        self.assertEqual(reply[0], 'Still here.')
        actor.assert_called_once()

    def test_autonomous_summary_sanitizes_gains_and_records(self):
        scene = self.manager.create(dict(participants=['Iris', 'Nora'], kind='other',
                                         title='A walk', location='The garden', visibility='private'))
        meta = self.manager.meta(scene['id'])
        meta['autonomous'] = True
        self.manager.save(meta)
        record = dict(participant='Iris', segment='events', about=['Iris', 'Nora'],
                      text='We walked together.', tags=['walk'], importance=3)
        result = dict(message='They walked together.', memory='A walk.', to=None,
                      remember=[None, {}, dict(record, segment=[]), record],
                      bond_gains=[None, {}, dict(names=['Iris', 'Nora'], like=26),
                                  dict(names=['Iris', 'Mystery'], like=20)])
        self.invoke.side_effect = None
        self.invoke.return_value = json.dumps(result)
        self.manager.start(scene['id'], 'end')
        self.manager.summarize(scene['id'])
        self.assertEqual(self.manager.meta(scene['id'])['summary'], result['message'])
        self.assertEqual(self.manager.meta(scene['id'])['status'], 'ended')
        scores = server.relationships.load()
        self.assertEqual(scores['Iris']['Nora']['like'], 25)
        self.assertNotIn('Mystery', scores['Iris'])
        self.assertEqual(len(server.life_store('Iris').load_segment('events')), 1)
        self.assertFalse(server.life_store('Nora').load_segment('events'))

    def test_health_ring_route_and_file(self):
        with patch.object(health, 'EVENTS', health.deque(maxlen=50)), patch.object(health, 'FAILURE_TIMES', health.deque()):
            for i in range(55): health.emit('turn_failure', 'Iris', 'reply was unusable', category='bad_reply')
            payload = health.snapshot()
            self.assertEqual(len(payload['events']), 50)
            self.assertEqual(payload['failures_last_hour'], 55)
            handler = object.__new__(server.Handler)
            handler.path = '/api/health'
            with patch.object(handler, 'refused', return_value=False), patch.object(handler, 'send_json') as send:
                handler.do_GET()
            self.assertEqual(send.call_args.args[0], payload)
        root = logging.getLogger()
        previous_handlers, previous_level = list(root.handlers), root.level
        with tempfile.TemporaryDirectory() as tmp:
            handler = health.configure_logging(tmp)
            try:
                logging.getLogger('server').warning('test diagnostic')
                handler.flush()
                self.assertIn('test diagnostic', (Path(tmp)/'server.log').read_text())
                self.assertEqual(handler.backupCount, 3)
            finally:
                for added in list(root.handlers):
                    if added not in previous_handlers:
                        root.removeHandler(added)
                        added.close()
                root.setLevel(previous_level)

    def test_health_producer_events_keep_diagnostics_private(self):
        with patch.object(health, 'EVENTS', health.deque(maxlen=50)), patch.object(health, 'FAILURE_TIMES', health.deque()):
            server.record_failure('claude', server.ProviderError('private diagnostic', 'quota exhausted'), 'fixture')
            event = health.snapshot()['events'][-1]
            self.assertEqual(event['event'], 'provider_break')
            self.assertEqual(event['reason'], 'quota')
            self.assertIsInstance(event['reset_at'], (int, float))
            calls = server.meetups.Turn((), dict(calls=[dict(fn='set_alarm', at='13:00',
                to='Mystery', intent='private alarm intent', channel='dm')]))
            self.keeper.apply('Iris', calls, self.config)
            alarm = self.keeper.load()['alarms'][0]
            self.keeper.update(alarm['id'], status='fired')
            self.keeper.update(alarm['id'], status='missed')
            events = health.snapshot()['events']
            self.assertEqual([row['event'] for row in events][-3:], ['alarm_set', 'alarm_fired', 'alarm_missed'])
            self.assertNotIn('private', json.dumps(events))
            self.assertNotIn('intent', json.dumps(events))
            with patch.object(health.time, 'time', return_value=time.time()+3601):
                self.assertEqual(health.snapshot()['failures_last_hour'], 0)
