"""Low-affection host initiative: fake clocks, temporary stores, mocked providers."""
from datetime import timedelta
import json
import unittest
from test_support import HermeticTestCase
from unittest.mock import patch

import engagement
import server
import test_followup


class HostInitiativeTests(HermeticTestCase):
    setUp = test_followup.FollowupTests.setUp
    provider = test_followup.FollowupTests.provider
    setup_pair = test_followup.FollowupTests.setup_pair
    run_reply = test_followup.FollowupTests.run_reply

    def ready(self, quiet=True):
        self.setup_pair()
        server.set_quiet_room(quiet)
        server.relationships.save('Vella', {'Iris': dict(like=5, dislike=0)})
        # A closed, unrelated outgoing message starts the idle clock, not a conversation.
        server.append('Vella', 'See you later.', recipient='Mystery', thread_done=True)
        self.now += timedelta(minutes=10)

    def target(self):
        return server.host_friendly_target(self.host, server.history(), self.config)

    def test_idle_clock_without_room_activity_in_both_modes(self):
        for quiet in (True, False):
            with self.subTest(quiet=quiet), patch.object(server, 'LOG', server.MEMORY.parent / f'messages-{quiet}.jsonl'):
                self.ready(quiet)
                server.STATE.update(turns=0, limit=100, evening_complete=False)
                server.ACTIVE.set()
                before = len(server.history())
                self.now -= timedelta(seconds=1)
                self.assertIsNone(self.target())
                self.now += timedelta(seconds=1)
                self.assertEqual(len(server.history()), before)
                self.assertEqual(self.target(), 'Iris')
                posted = self.run_reply('Vella', 'Iris')
                self.assertTrue(posted['host_initiative'])
                self.assertEqual(posted['channel'], 'dm')
                self.assertEqual(server.STATE['turns'], 0)
                self.assertIn('FRIENDLY HOST INITIATIVE', self.invoke.call_args.args[1])
                self.run_reply('Iris')
                self.run_reply('Vella', done=True)

    def test_empty_history_has_startup_idle_window(self):
        self.setup_pair()
        server.relationships.save('Vella', {'Iris': dict(like=5, dislike=0)})
        self.assertIsNone(self.target())
        self.now += timedelta(minutes=10)
        self.assertEqual(server.history(), [])
        self.assertEqual(self.target(), 'Iris')
        self.run_reply('Vella', 'Iris')

    def test_pair_silence_in_both_directions(self):
        self.ready()
        contact = server.append('Iris', 'Hi Vella.', recipient='Vella')
        self.now += timedelta(minutes=19, seconds=59)
        self.assertNotEqual(self.target(), 'Iris')
        self.now += timedelta(seconds=1)
        self.assertEqual(self.target(), 'Iris')
        server.append('Vella', 'Hi.', recipient='Iris', reply_to=contact['id'], thread_done=True)
        self.now += timedelta(minutes=10)
        self.assertNotEqual(self.target(), 'Iris')
        self.now += timedelta(minutes=10)
        self.assertEqual(self.target(), 'Iris')

    def test_sleep_disabled_away_and_boundaries(self):
        self.ready()
        self.agent['routine'] = {'sleep': '11:00-15:00'}
        self.assertNotEqual(self.target(), 'Iris')
        self.agent['routine'] = {}
        self.agent['enabled'] = False
        self.assertNotEqual(self.target(), 'Iris')
        self.agent['enabled'] = True
        with patch.object(server.SCENES, 'away_reason', side_effect=lambda name: 'in person' if name == 'Iris' else ''):
            self.assertNotEqual(self.target(), 'Iris')
        server.life_store('Iris').apply([dict(segment='boundaries', about=['Vella'],
            text='Vella, give me space.', tags=['space'], importance=5, status='open')], source_id='space', embed=False)
        self.assertNotEqual(self.target(), 'Iris')
        self.host['routine'] = {'sleep': '11:00-15:00'}
        self.assertIsNone(self.target())

    def test_two_unanswered_stop_until_reply(self):
        self.ready()
        for _ in range(2):
            server.append('Vella', 'Want company?', recipient='Iris', initiative=True, host_initiative=True)
            self.now += timedelta(minutes=21)
        self.assertNotEqual(self.target(), 'Iris')
        server.append('Iris', 'Yes, please.', recipient='Vella', thread_done=True)
        self.now += timedelta(minutes=20)
        self.assertEqual(self.target(), 'Iris')

    def test_six_per_pair_per_local_day_with_replies(self):
        self.ready()
        self.now -= timedelta(hours=3)
        for _ in range(6):
            server.append('Vella', 'Hello.', recipient='Iris', initiative=True, host_initiative=True)
            server.append('Iris', 'Hello back.', recipient='Vella', thread_done=True)
            self.now += timedelta(minutes=21)
        self.assertNotEqual(self.target(), 'Iris')
        self.now += timedelta(days=1)
        self.assertEqual(self.target(), 'Iris')

    def test_pause_and_completed_evening(self):
        self.ready()
        server.ACTIVE.clear()
        server.STATE.update(evening_complete=False, turns=0, limit=1)
        before = len(server.history())
        server.run_turn(self.config)
        self.assertEqual(len(server.history()), before)
        server.STATE.update(evening_complete=True, turns=1)
        self.run_reply('Vella', 'Iris')
        self.assertEqual(server.STATE['turns'], 1)
        self.assertFalse(server.ACTIVE.is_set())

    def test_outreach_cannot_post_publicly_or_switch_recipients(self):
        self.ready()
        self.invoke.side_effect = None
        before = len(server.history())
        for recipient in (None, 'Mystery'):
            self.invoke.return_value = json.dumps(dict(message='Hello.', memory='A hello.', to=recipient))
            server.run_turn(self.config)
            self.assertEqual(len(server.history()), before)
            self.assertEqual(server.STATE['turns'], 0)
            self.assertIn('PRIVATE ONLY', self.invoke.call_args.args[1])

    def test_recipient_sleep_rechecked_after_provider_returns(self):
        self.ready()
        before = len(server.history())
        def provider(*args, **kwargs):
            self.agent['routine'] = {'sleep': '11:00-15:00'}
            return json.dumps(dict(message='Want company?', memory='A thought.', to='Iris'))
        self.invoke.side_effect = provider
        server.run_turn(self.config)
        self.assertEqual(len(server.history()), before)
        self.assertEqual(server.STATE['turns'], 0)

    def test_no_new_non_host_initiative_and_generic_host(self):
        self.ready()
        self.host['host_level'] = False
        self.assertIsNone(self.target())
        self.assertIsNone(server.host_friendly_turn(server.history(), self.config['agents'], self.config))
        self.host['host_level'] = True
        self.host['name'] = 'OtherHost'
        server.relationships.save('OtherHost', {'Iris': dict(like=5, dislike=0)})
        self.assertIsNone(self.target())
        self.now += timedelta(minutes=10)
        self.assertEqual(self.target(), 'Iris')

    def test_per_agent_settings_and_normal_rotation_cannot_bypass_idle(self):
        self.ready(False)
        self.host['host_initiative'] = dict(idle_minutes=30, contact_minutes=40, daily_pair_cap=3, unanswered_cap=1)
        self.assertIsNone(self.target())
        with patch.object(server, 'choose_next', return_value='Vella'):
            before = self.invoke.call_count
            server.run_turn(dict(self.config, agents=[self.host]))
            self.assertEqual(self.invoke.call_count, before)
        self.now += timedelta(minutes=20)
        self.assertEqual(self.target(), 'Iris')
        self.host['host_initiative']['enabled'] = False
        self.assertIsNone(self.target())
        for bad in (None, {'idle_minutes': 0}, {'contact_minutes': True}, {'daily_pair_cap': 1.5},
                    {'unanswered_cap': -1}, {'enabled': 'yes'}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                engagement.host_settings(dict(host_initiative=bad))
