"""Deterministic daily rhythm, attention and prompt privacy integration tests."""
from datetime import datetime, timedelta, timezone
import json
from types import SimpleNamespace
import unittest
from test_support import HermeticTestCase
from unittest.mock import patch

import attention
import daily_life
import meetups
import server
import test_scenes
import timekeeper


class DailyAttentionTests(HermeticTestCase):
    def setUp(self):
        test_scenes.SceneTests.setUp(self)
        self.now = datetime(2026, 10, 16, 3, tzinfo=timezone.utc)  # noon Seoul
        self.keeper = timekeeper.Timekeeper(vars(server), clock=lambda: self.now, spawn=lambda target: target())
        patcher = patch.object(server, 'TIMEKEEPER', self.keeper)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.config['timezone'] = 'Asia/Seoul'
        self.agent = next(a for a in self.config['agents'] if a['name'] == 'Ji-woo')
        self.prompts = []
        self.reply_done = False
        server.STATE.update(speaker=None, turns=0, limit=100)
        server.ACTIVE.set()
        self.addCleanup(server.ACTIVE.clear)
        self.addCleanup(lambda: server.STATE.update(speaker=None, turns=0, limit=24))

    def provider(self, agent, prompt, timeout, images=None):
        self.prompts.append((agent['name'], prompt))
        return json.dumps(dict(message='I hear you.', memory='I listened.', to=None, thread_done=self.reply_done))

    def local(self, hour, minute=0, day=16):
        self.now = datetime(2026, 10, day, hour, minute, tzinfo=self.keeper.zone(self.config)).astimezone(timezone.utc)

    def box(self, name='Ji-woo'):
        return server.attention_for(name, server.history(), self.config['agents'])

    def focus(self, name='Ji-woo'):
        agent = next(a for a in self.config['agents'] if a['name'] == name)
        thread = server.thread_for(agent, server.history(), self.config)
        return thread['message'] if thread else None

    def turn(self):
        with patch.object(server, 'choose_next', side_effect=lambda messages, agents, *args:
                          'Ji-woo' if any(a['name'] == 'Ji-woo' for a in agents) else None):
            server.run_turn(self.config)

    def test_situation_time_location_energy_life_status_and_budget(self):
        store = server.life_store('Ji-woo')
        store.apply([dict(segment='milestones', about=['Ji-woo', 'Mystery'], text='We had our first long talk with Mystery.',
                          tags=['talk'], importance=5, status='resolved')], source_id='date', time=self.now.isoformat(), embed=False)
        for hour, minute, expected, energy in ((12, 0, 'just woke', 'steady'), (0, 5, 'winding down', 'low'), (1, 0, 'asleep', 'resting')):
            self.local(hour, minute)
            block = server.situation(self.agent, self.config)
            self.assertIn('NOW: ' + self.keeper.now_text(self.config), block)
            self.assertIn('State: ' + expected, block)
            self.assertIn(energy, block)
            self.assertIn('first long talk', block)
            self.assertIn('LIFE STATUS:', block)
            self.assertLessEqual(len(block.split()), 80)
            self.assertIn('the room behind the stall' if expected == 'asleep' else 'the common room', block)
        self.local(0, 10)
        self.assertIn('say goodnight naturally', server.make_prompt(self.agent, [], self.config['agents'], config=self.config))
        self.assertIn('Market gate', server.situation(self.agent, self.config, location='Market gate', scene=True))
        self.config['timezone'] = 'UTC'
        self.assertIn('(UTC)', server.situation(self.agent, self.config))

    def test_sleep_window_queues_ordinary_dm_and_wake_replies(self):
        self.local(1)
        dm = server.append('Grandpa Park', 'Can we talk?', recipient='Ji-woo')
        self.assertFalse(server.ordinary_available(self.agent, self.config))
        self.assertIn('Asleep until 07:30', server.character_status(self.agent, self.config)['away_reason'])
        self.turn()
        self.assertEqual(self.prompts, [])
        self.assertEqual(self.box()['pending'][0]['last_message_id'], dm['id'])
        self.local(7, 30)
        self.assertEqual(self.focus()['id'], dm['id'])
        self.turn()
        self.assertEqual(server.history()[-1]['to'], 'Grandpa Park')
        self.assertIn('State: just woke', self.prompts[-1][1])
        self.assertEqual(daily_life.rhythm(self.agent, self.keeper, self.config, server.history())['state'], 'awake')

    def test_mystery_wakes_only_private_thread_and_times_out(self):
        self.local(0, 20)
        old = server.append('Grandpa Park', 'Earlier chat', recipient='Ji-woo')
        server.append('Ji-woo', 'Listening', recipient='Grandpa Park', reply_to=old['id'])
        self.local(1, 20)
        park = server.append('Grandpa Park', 'Can we continue?', recipient='Ji-woo')
        dm = server.append('Mystery', 'Are you there?', recipient='Ji-woo')
        state = daily_life.rhythm(self.agent, self.keeper, self.config, server.history())
        self.assertEqual((state['state'], state['asleep'], state['away']), ('woken by Mystery', False, ''))
        self.assertEqual(self.focus()['id'], dm['id'])
        self.assertEqual(server.choose_next(server.history(), [self.agent], self.config), 'Ji-woo')
        self.assertEqual(server.character_status(self.agent, self.config)['busy'], 'Awake (talking with Mystery)')
        self.turn()
        reply = server.history()[-1]
        self.assertEqual((reply['to'], reply['reply_to']), ('Mystery', dm['id']))
        self.assertNotIn('sleep_cycle', reply)
        self.assertNotIn('SLEEPY REPLY', self.prompts[-1][1])
        self.assertIn("Mystery's message woke you; you're groggy at first, then properly awake while you talk. Other people can wait until morning.", self.prompts[-1][1])
        self.assertTrue(any(r['last_message_id'] == park['id'] for r in self.box()['pending']))
        self.assertIsNone(self.focus())
        status = server.character_status(self.agent, self.config)
        self.assertTrue(status['enabled'])
        self.assertEqual(status['busy'], 'Awake (talking with Mystery)')
        self.assertIsNone(server.choose_next(server.history(), [self.agent], self.config))
        with patch.object(server, 'longing_for', return_value=('desire', 1, 'Mystery')):
            self.assertIsNone(server.quiet_turn(server.history(), [self.agent], self.config))
        self.local(1, 40)
        self.reply_done = True
        dm = server.append('Mystery', 'One more thought', recipient='Ji-woo')
        self.turn()
        self.assertEqual(server.history()[-1]['reply_to'], dm['id'])
        self.assertEqual(len(self.prompts), 2)
        self.local(2, 9)
        self.assertEqual(daily_life.rhythm(self.agent, self.keeper, self.config, server.history())['state'], 'woken by Mystery')
        self.local(2, 10)
        self.assertTrue(daily_life.rhythm(self.agent, self.keeper, self.config, server.history())['asleep'])
        self.assertIn('Asleep until 07:30', server.character_status(self.agent, self.config)['away_reason'])
        self.local(7, 30)
        self.assertEqual(self.focus()['id'], park['id'])

    def test_only_mystery_dm_wakes_not_mentions_or_hosts_or_stale_messages(self):
        self.local(1, 20)
        for sender, recipient in (('Mystery', None), ('Grandpa Park', 'Ji-woo'), ('Mystery', 'The Man in a Suit')):
            server.append(sender, '@Ji-woo hello', recipient=recipient)
        next(a for a in self.config['agents'] if a['name'] == 'Grandpa Park')['host_level'] = True
        self.assertIsNone(self.focus())
        self.assertTrue(daily_life.rhythm(self.agent, self.keeper, self.config, server.history())['asleep'])
        server.append('Mystery', 'Private hello', recipient='Ji-woo')
        self.local(1, 50)
        self.assertIsNone(self.focus())
        self.assertFalse(server.ordinary_available(self.agent, self.config))

    def test_reply_extends_wake_and_cycle_boundaries_are_respected(self):
        self.local(0, 20)
        server.append('Mystery', 'Before bed', recipient='Ji-woo')
        self.local(0, 40)
        self.assertTrue(daily_life.rhythm(self.agent, self.keeper, self.config, server.history())['asleep'])
        server.append('Mystery', 'Wake up', recipient='Ji-woo')
        self.local(0, 50)
        server.append('Ji-woo', 'Here', recipient='Mystery')
        self.local(1, 15)
        self.assertEqual(daily_life.rhythm(self.agent, self.keeper, self.config, server.history())['state'], 'woken by Mystery')
        self.local(1, 20)
        self.assertTrue(daily_life.rhythm(self.agent, self.keeper, self.config, server.history())['asleep'])
        self.local(1, 21)
        server.append('Mystery', 'Again', recipient='Ji-woo')
        self.local(1, 22)
        server.append('Ji-woo', 'Other reply', recipient='Grandpa Park')
        self.assertTrue(daily_life.rhythm(self.agent, self.keeper, self.config, server.history())['asleep'])
        self.local(1, 23, day=17)
        self.assertTrue(daily_life.rhythm(self.agent, self.keeper, self.config, server.history())['asleep'])

    def test_woken_night_blocks_scenes_and_meetup_invitations(self):
        manager = meetups.Meetups(vars(server))
        invite = manager.invite('Ji-woo', dict(to='Mystery', where='Cafe', kind='hangout'), self.config)
        other = manager.invite('Grandpa Park', dict(to='Ji-woo', where='Cafe', kind='hangout'), self.config)
        self.assertIsNotNone(invite)
        self.assertIsNotNone(other)
        self.local(1, 20)
        server.append('Mystery', 'Hello', recipient='Ji-woo')
        self.assertTrue(server.resting_reason(self.agent, self.config))
        with self.assertRaises(server.scenes.SceneError):
            self.manager.create(dict(participants=['Ji-woo'], title='Tea', kind='hangout', location='Cafe'))
        self.assertIsNone(manager.invite('Ji-woo', dict(to='Mystery', where='Cafe'), self.config))
        with self.assertRaises(server.scenes.SceneError):
            manager.answer('Ji-woo', dict(id=other['id'], answer='accept'), self.config)
        self.agent['routine']['woken_by_mystery'] = 'yes'
        with self.assertRaises(ValueError):
            daily_life.validate(self.agent)

    def test_one_sleepy_reply_to_mystery_per_window_persists_in_log(self):
        self.agent['routine']['woken_by_mystery'] = False
        self.local(1)
        server.append('Mystery', 'Still awake?', recipient='Ji-woo')
        self.assertTrue(server.ordinary_available(self.agent, self.config))
        self.turn()
        posted = server.history()[-1]
        self.assertTrue(posted['sleep_cycle'])
        self.assertTrue(posted['thread_done'])
        self.assertIn('SLEEPY REPLY', self.prompts[-1][1])
        server.append('Mystery', 'One more thing', recipient='Ji-woo')
        self.turn()
        self.assertEqual(len(self.prompts), 1)
        self.assertFalse(server.ordinary_available(self.agent, self.config))
        # A newly constructed timekeeper sees the persisted sleep-cycle consumption.
        new_keeper = timekeeper.Timekeeper(vars(server), clock=lambda: self.now)
        state = daily_life.rhythm(self.agent, new_keeper, self.config, server.history())
        self.assertFalse(daily_life.sleepy_allowed(self.agent, state, self.box()['pending'][0], {}, server.history()))
        self.local(7, 30)
        self.turn()
        self.assertEqual(len(self.prompts), 2)
        self.local(1, day=17)
        server.append('Mystery', 'Another night', recipient='Ji-woo')
        self.assertTrue(server.ordinary_available(self.agent, self.config))

    def test_sleepy_close_contact_threshold_and_config_off(self):
        self.agent['routine']['woken_by_mystery'] = False
        self.local(1)
        server.append('The Merchant', 'Need you briefly', recipient='Ji-woo')
        server.relationships.save('Ji-woo', {'The Merchant': dict(like=125, dislike=6)})
        self.assertFalse(server.ordinary_available(self.agent, self.config))
        server.relationships.save('Ji-woo', {'The Merchant': dict(like=126, dislike=6)})
        self.assertTrue(server.ordinary_available(self.agent, self.config))
        self.agent['routine']['sleepy_reply'] = False
        self.assertFalse(server.ordinary_available(self.agent, self.config))
        self.agent['routine']['sleepy_reply'] = True
        self.turn()
        self.assertEqual(server.history()[-1]['to'], 'The Merchant')
        server.append('Mystery', 'Hi', recipient='Ji-woo')
        self.assertFalse(server.ordinary_available(self.agent, self.config))

    def test_wake_queue_mystery_then_urgency_closeness_arrival(self):
        self.local(1)
        self.agent['routine']['sleepy_reply'] = False
        for name in ('Grandpa Park', 'The Merchant', 'Kim Min-jun', 'Mystery'):
            server.append(name, 'urgent help' if name == 'Kim Min-jun' else 'Hello', recipient='Ji-woo')
        server.relationships.save('Ji-woo', {'The Merchant': dict(like=100, dislike=0)})
        self.local(7, 30)
        self.reply_done = True
        for expected in ('Mystery', 'The Merchant', 'Kim Min-jun', 'Grandpa Park'):
            self.assertEqual(self.focus()['name'], expected)
            self.turn()
            self.assertEqual(server.history()[-1]['to'], expected)
        self.assertFalse(self.box()['pending'])

    def test_stickiness_latest_merge_done_and_six_message_silence(self):
        first = server.append('The Merchant', 'How is research?', recipient='Ji-woo')
        self.turn()
        self.assertEqual(self.box()['active']['counterpart'], 'The Merchant')
        server.append('Grandpa Park', 'I have a question', recipient='Ji-woo')
        server.append('The Merchant', 'A new detail', recipient='Ji-woo')
        latest = server.append('The Merchant', 'Actually answer this', recipient='Ji-woo')
        self.assertEqual(len(self.box()['pending']), 2)
        self.assertEqual(self.focus()['id'], latest['id'])
        self.reply_done = True
        self.turn()
        self.assertEqual(server.history()[-1]['to'], 'The Merchant')
        self.assertTrue(server.history()[-1]['thread_done'])
        self.assertEqual(self.focus()['name'], 'Grandpa Park')
        self.reply_done = False
        self.turn()
        server.append('Mystery', 'Waiting for Ji-woo', recipient='Ji-woo')
        self.assertIsNone(self.focus())  # Active Grandpa Park thread waits without repeating an answer.
        for i in range(6):
            server.append('Kim Min-jun', 'Public small talk')
        self.assertEqual(self.focus()['name'], 'Mystery')

    def test_mystery_order_same_thread_merge_and_goodbye(self):
        server.append('Grandpa Park', 'Older', recipient='Ji-woo')
        server.append('Mystery', 'Newer', recipient='Ji-woo')
        latest = server.append('Mystery', 'Latest', recipient='Ji-woo')
        self.assertEqual(len(self.box()['pending']), 2)
        self.assertEqual(self.focus()['id'], latest['id'])
        self.turn()
        server.append('Mystery', 'Goodnight', recipient='Ji-woo')
        self.turn()
        self.assertIsNone(self.box()['active'])
        self.assertEqual(self.focus()['name'], 'Grandpa Park')

    def test_mystery_group_mention_then_dm_replies_to_newest_dm(self):
        self.local(18, 4)
        self.now = self.now.replace(second=54)
        server.append('Mystery', '@The Merchant')
        self.local(18, 47)
        self.now = self.now.replace(second=55)
        dm = server.append('Mystery', 'talked to ji-woo?', recipient='The Merchant')
        self.local(18, 48)
        self.now = self.now.replace(second=23)
        with patch.object(server, 'choose_next', return_value='The Merchant'):
            server.run_turn(self.config)
        reply = server.history()[-1]
        self.assertEqual(reply['channel'], 'dm')
        self.assertEqual(reply['to'], 'Mystery')
        self.assertEqual(reply['reply_to'], dm['id'])
        self.assertEqual(self.box('The Merchant')['pending'], [])

    def test_wake_queue_merges_channels_per_counterpart(self):
        self.local(1)
        self.agent['routine']['sleepy_reply'] = False
        for sender in ('Grandpa Park', 'Mystery'):
            server.append(sender, '@Ji-woo old group question')
        cast_dm = server.append('Grandpa Park', 'Latest cast question', recipient='Ji-woo')
        mystery_dm = server.append('Mystery', 'Latest Mystery question', recipient='Ji-woo')
        self.local(7, 30)
        self.reply_done = True
        self.assertEqual(len(self.box()['pending']), 2)
        for dm in (mystery_dm, cast_dm):
            self.assertEqual(self.focus()['id'], dm['id'])
            self.turn()
            reply = server.history()[-1]
            self.assertEqual((reply['channel'], reply['to'], reply['reply_to']), ('dm', dm['name'], dm['id']))
        self.assertEqual(self.box()['pending'], [])

    def test_scheduler_chooses_newest_mystery_even_over_older_urgency(self):
        server.append('Mystery', 'Urgent help', recipient='Ji-woo')
        newest = server.append('Mystery', 'Latest question', recipient='The Merchant')
        picked = server.priority_turn(server.history(), self.config['agents'], self.config)
        self.assertEqual((picked[0], picked[1]['id']), ('The Merchant', newest['id']))

    def test_sleepy_reply_merges_old_group_with_new_dm(self):
        self.agent['routine']['woken_by_mystery'] = False
        self.local(1)
        server.append('Mystery', '@Ji-woo old group question')
        dm = server.append('Mystery', 'Private question', recipient='Ji-woo')
        server.append('Mystery', '@Ji-woo newer group question')
        self.assertEqual(self.focus()['id'], dm['id'])
        self.turn()
        reply = server.history()[-1]
        self.assertEqual((reply['channel'], reply['reply_to']), ('dm', dm['id']))
        self.assertTrue(reply['sleep_cycle'])

    def test_quiet_room_uses_merged_focus_and_does_not_revive_old_broadcast(self):
        server.set_quiet_room(True)
        server.append('Mystery', '@Ji-woo old question')
        dm = server.append('Mystery', 'New private question', recipient='Ji-woo')
        picked = server.quiet_turn(server.history(), [self.agent], self.config)
        self.assertEqual(picked[1]['id'], dm['id'])
        self.turn()
        self.assertEqual(server.history()[-1]['reply_to'], dm['id'])
        self.assertEqual(server.history()[-1]['channel'], 'dm')
        # An unaddressed public message also belongs to Mystery's merged history.
        server.append('Mystery', 'Anyone here?')
        dm = server.append('Mystery', 'Another private question', recipient='Ji-woo')
        self.reply_done = True
        self.turn()
        self.assertEqual(server.history()[-1]['reply_to'], dm['id'])
        self.assertIsNone(server.quiet_turn(server.history(), [self.agent], self.config))

    def test_quiet_broadcast_expiry_uses_room_clock(self):
        server.set_quiet_room(True)
        server.append('Mystery', 'Anyone here?')
        server.append('Mystery', 'Private note', recipient='Grandpa Park')
        self.now += timedelta(minutes=30)
        self.assertIsNone(server.quiet_turn(server.history(), [self.agent], self.config))

    def test_alarm_preserves_pending_newest_dm_and_scheduled_channel(self):
        server.append('Mystery', '@Ji-woo older question')
        dm = server.append('Mystery', 'Current question', recipient='Ji-woo')
        alarm = dict(owner='Ji-woo', to='Mystery', channel='group', intent='Promised public greeting',
                     created_at=self.now.isoformat())
        self.keeper.room_turn(alarm, self.agent, self.config)
        posted = server.history()[-1]
        self.assertTrue(posted['alarm'])
        self.assertEqual(posted['channel'], 'group')
        self.assertIsNone(posted['reply_to'])
        self.assertEqual(self.focus()['id'], dm['id'])

    def test_active_thread_survives_room_fairness_and_two_dms(self):
        server.append('The Merchant', 'Question', recipient='Ji-woo')
        self.turn()
        server.append('Grandpa Park', 'Wait for me', recipient='Ji-woo')
        server.append('The Merchant', 'Follow up', recipient='Ji-woo')
        self.assertEqual(self.focus()['name'], 'The Merchant')
        # The last two actor messages are DMs; rotate another character, preserving Ji-woo's work.
        selected = server.choose_next(server.history(), self.config['agents'], self.config)
        self.assertNotIn(selected, ('Ji-woo', 'The Merchant'))
        server.append('Kim Min-jun', 'A group thought', thread_done=True)
        with patch.object(server, 'choose_next', return_value='Ji-woo'):
            server.run_turn(self.config)
        self.assertEqual(server.history()[-1]['to'], 'The Merchant')
        self.assertNotIn('GROUP TURN:', self.prompts[-1][1])
        self.assertEqual(self.box()['active']['counterpart'], 'The Merchant')

    def test_busy_visibility_private_dm_and_public_group(self):
        dm = server.append('The Merchant', 'Private question', recipient='Ji-woo')
        self.turn()
        self.assertEqual(server.character_status(self.agent, self.config)['busy'], 'talking with The Merchant')
        public = server.busy_context('Grandpa Park', server.history(), self.config['agents'])
        self.assertIn('Ji-woo is busy', public)
        self.assertNotIn('Ji-woo is talking with The Merchant', public)
        self.assertNotIn('Private question', public)
        server.append('Ji-woo', 'Done', recipient='The Merchant', reply_to=dm['id'], thread_done=True)
        group = server.append('The Merchant', '@Ji-woo public question')
        server.append('Ji-woo', '@The Merchant answer', reply_to=group['id'])
        self.assertIn('Ji-woo is talking with The Merchant', server.busy_context('Grandpa Park', server.history(), self.config['agents']))

    def test_alarms_fire_during_sleep_without_consuming_sleepy_allowance(self):
        self.local(0)
        calls = self.keeper.apply('Ji-woo', meetups.Turn((), {'calls':[dict(fn='set_alarm', at='01:00', to='Mystery', intent='Promised check in', channel='dm')]}), self.config)
        self.assertIn('set_alarm ok', calls[0])
        self.local(1)
        alarm = self.keeper.load()['alarms'][0]
        with patch.object(self.keeper, 'notify'):
            self.assertEqual(self.keeper.fire(alarm['id'], self.config), 'fired')
        self.assertTrue(server.history()[-1]['alarm'])
        self.assertNotIn('sleep_cycle', server.history()[-1])
        self.local(1, 1)
        server.append('Mystery', 'Thanks', recipient='Ji-woo')
        self.assertTrue(server.ordinary_available(self.agent, self.config))

    def test_scene_and_meetup_sleep_gates_keep_alarms_separate(self):
        scene = self.manager.create(dict(participants=['Ji-woo'], title='Late tea', kind='hangout', location='Cafe'))
        self.local(1)
        with self.assertRaises(server.scenes.SceneError) as rejected:
            self.manager.create(dict(participants=['The Man in a Suit'], title='Tea', kind='hangout', location='Cafe'))
        self.assertEqual(rejected.exception.code, 409)
        self.manager.jobs[scene['id']] = dict(operation='reply', speaker=None)
        self.manager.reply(scene['id'])
        self.assertEqual(self.prompts, [])
        self.assertIn('Asleep until', self.manager.messages(scene['id'])[-1]['text'])
        self.manager.jobs.clear()
        # Autonomous scenes retain their exclusive reservation and next speaker while resting.
        meta = self.manager.meta(scene['id'])
        meta.update(autonomous=True, participants=['Ji-woo', 'The Merchant'], exchanges=2, next_turn=0,
                    next_at=0, failures={}, attempts=0)
        self.manager.save(meta)
        manager = meetups.Meetups(vars(server))
        self.manager.jobs[scene['id']] = dict(operation='meetup', speaker=None)
        manager.work(scene['id'])
        updated = self.manager.meta(scene['id'])
        self.assertEqual(updated['exchanges'], 2)
        self.assertEqual(updated['next_turn'], 0)
        self.assertEqual(self.prompts, [])
        self.assertGreater(updated['next_at'], 0)
        # Alarm delivery directly uses the scene path, even while its ordinary turns rest.
        alarm = dict(owner='Ji-woo', to='Mystery', channel='dm', intent='Promised greeting', created_at=self.now.isoformat())
        updated['mystery_joined'] = True
        self.keeper.scene_turn(alarm, self.agent, updated, self.config)
        self.assertTrue(self.prompts)
        self.assertIn('SITUATION', self.prompts[-1][1])
        self.assertIn('Cafe', self.prompts[-1][1])

    def test_ship_maintenance_sleep_windows_validation_and_midnight(self):
        # A machine character keeps a maintenance window instead of sleep.
        ship = dict(name='Beacon', kind='ship_ai', gender='female', sibling=None, enabled=True,
                    provider='codex', model='gpt-5.6-terra', personality='Precise.', tagline='Keeps the lights on.',
                    routine=dict(maintenance='04:00-04:20', home='the building', day='Building systems.',
                                 sleepy_reply=False))
        self.config['agents'].append(ship)
        self.local(1)
        self.assertFalse(daily_life.rhythm(ship, self.keeper, self.config)['asleep'])
        self.local(4, 10)
        status = server.character_status(ship, self.config)
        self.assertIn('Maintenance until 04:20', status['away_reason'])
        self.assertNotIn('Asleep', status['away_reason'])
        self.local(4, 20)
        self.assertTrue(server.ordinary_available(ship, self.config))
        for value in ('25:00-07:00', '00:00-00:00', 'bad'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                daily_life.validate(dict(self.agent, routine=dict(sleep=value)))
        for hour, minute, asleep in ((0,29,False),(0,30,True),(7,29,True),(7,30,False)):
            self.local(hour,minute)
            self.assertEqual(daily_life.rhythm(self.agent, self.keeper, self.config)['asleep'], asleep)
