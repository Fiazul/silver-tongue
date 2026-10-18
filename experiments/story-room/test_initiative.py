"""Affection initiative regressions: fake clock, isolated storage, no providers."""
from datetime import timedelta
import json
from unittest.mock import patch
import unittest
from test_support import HermeticTestCase
import test_daily_attention
import engagement
import server


class InitiativeTests(HermeticTestCase):
    setUp = test_daily_attention.DailyAttentionTests.setUp
    provider = test_daily_attention.DailyAttentionTests.provider
    local = test_daily_attention.DailyAttentionTests.local
    # Reuse only the isolated fixture, not its test suite.
    def scores(self, target='Mystery', net=200):
        server.relationships.save('Ji-woo', {target: dict(like=net, dislike=0)})

    def old_contact(self, minutes=26, target='Mystery'):
        message = server.append(target, 'Hello', recipient='Ji-woo')
        message['time'] = (self.now - timedelta(minutes=minutes)).isoformat()
        return [message]

    def test_clock_alone_and_curve(self):
        self.agent['routine'] = {}
        self.scores()
        messages = self.old_contact()
        self.assertEqual(server.longing_for(self.agent, self.config['agents'], messages)[2], 'Mystery')
        self.scores(net=100)
        self.assertIsNone(server.longing_for(self.agent, self.config['agents'], messages))
        self.scores(net=400)
        self.assertIsNotNone(server.longing_for(self.agent, self.config['agents'], messages))
        self.scores(net=99)
        self.assertIsNone(server.longing_for(self.agent, self.config['agents'], messages))

    def test_every_target_including_platonic_and_nonfavorite(self):
        self.agent['routine'] = {}
        for target in ('Mystery', 'The Man in a Suit', 'Kim Min-jun', 'Grandpa Park'):
            with self.subTest(target=target):
                self.scores(target)
                messages = self.old_contact(target=target)
                self.assertEqual(server.longing_for(self.agent, self.config['agents'], messages)[2], target)

    def test_unanswered_boundary_and_daily_cap_for_all_targets(self):
        self.agent['routine'] = {}
        for target in ('Mystery', 'Grandpa Park'):
            with self.subTest(target=target):
                store = server.life_store('Ji-woo')
                messages = [dict(id=str(i), name='Ji-woo', to=target, channel='dm', text='Hello',
                                 initiative=True, time=(self.now-timedelta(minutes=60-i)).isoformat()) for i in range(2)]
                allow = lambda: engagement.may_initiate('Ji-woo', target, messages, store,
                    server.store_for(self.config), now=self.now, config=self.config)
                self.assertFalse(allow())
                messages.append(dict(name=target, channel='group', targets=['Ji-woo'], text='Ji-woo, hi', time=self.now.isoformat()))
                self.assertTrue(allow())
                self.config['initiative'] = {'daily_pair_cap': 2}
                self.assertFalse(allow())
                self.config.pop('initiative')
                store.apply([dict(segment='boundaries', about=[target], text=f'{target} asked for space.',
                                  tags=['space'], importance=5, status='open')], source_id=target, embed=False)
                self.assertFalse(allow())

    def test_actor_target_asleep_and_night_wake_block_outreach(self):
        self.scores('Grandpa Park')
        self.local(1)
        messages = self.old_contact(target='Grandpa Park')
        self.assertIsNone(server.longing_for(self.agent, self.config['agents'], messages))
        self.local(7, 35)
        park = next(a for a in self.config['agents'] if a['name'] == 'Grandpa Park')
        park['routine'] = {'sleep': '01:00-09:00'}
        self.assertIsNone(server.longing_for(self.agent, self.config['agents'], messages))
        self.local(1)
        self.scores()
        messages = [dict(name='Mystery', to='Ji-woo', channel='dm', text='Hey', time=self.now.isoformat())]
        self.assertEqual(server.daily_life.rhythm(self.agent, self.keeper, self.config, messages)['state'], 'woken by Mystery')
        self.assertIsNone(server.longing_for(self.agent, self.config['agents'], messages))

    def test_return_any_channel_once_per_character_and_event(self):
        self.agent['routine'] = {}
        self.scores()
        messages = self.old_contact(minutes=35)
        messages.append(dict(name='Ji-woo', to='Mystery', channel='dm', text='Hi', initiative=True,
                             time=self.now.isoformat()))
        messages.append(dict(name='Mystery', to='Kim Min-jun', channel='dm', text='Back', time=self.now.isoformat()))
        self.assertEqual(server.longing_for(self.agent, self.config['agents'], messages)[1], 'return')
        messages.append(dict(name='Ji-woo', to='Mystery', channel='dm', text='Welcome', initiative=True, time=self.now.isoformat()))
        self.assertIsNone(server.longing_for(self.agent, self.config['agents'], messages))
        # Another character gets their own hello for the same return.
        minjun = next(a for a in self.config['agents'] if a['name'] == 'Kim Min-jun')
        minjun['routine'] = {}
        server.relationships.save('Kim Min-jun', {'Mystery': dict(like=100, dislike=0)})
        # A group return also works and doesn't itself consume anyone's hello.
        messages[-2].update(channel='group', targets=[], to=None)
        self.assertEqual(server.longing_for(minjun, self.config['agents'], messages)[1], 'return')

    def test_morning_hello_highest_net_in_quiet_room_once(self):
        self.local(7, 30)
        server.relationships.save('Ji-woo', {'Mystery': dict(like=200, dislike=0), 'Kim Min-jun': dict(like=300, dislike=0)})
        minjun = next(a for a in self.config['agents'] if a['name'] == 'Kim Min-jun')
        minjun['routine'] = {}
        self.assertEqual(server.longing_for(self.agent, self.config['agents'], [])[2], 'Kim Min-jun')
        server.set_quiet_room(True)
        self.assertEqual(server.quiet_turn([], [self.agent], self.config), ('Ji-woo', None, 'outreach'))
        with patch.object(server, 'invoke', return_value=json.dumps(dict(message='Good morning!', memory='I greeted Mystery.', to='Mystery'))) as invoke:
            server.run_turn(dict(self.config, agents=[self.agent]))
        self.assertEqual(server.history()[-1]['to'], 'Mystery')
        self.assertIn('You just woke; greet them good morning', invoke.call_args.args[1])
        self.assertIsNone(server.longing_for(self.agent, [self.agent], server.history()))

    def test_goodnight_prompt_nudge_all_loved_targets(self):
        for target in ('Mystery', 'The Man in a Suit'):
            self.scores(target, 100)
            focus = dict(id='night', name=target, to='Ji-woo', channel='dm', text='Goodnight, going to sleep.', time=self.now.isoformat())
            prompt = server.make_prompt(self.agent, [focus], self.config['agents'], focus, config=self.config)
            self.assertIn('Consider set_alarm to wake/greet them in the morning', prompt)
            self.assertIn('"calls": []', prompt)
            self.scores(target, 99)
            self.assertNotIn('Consider set_alarm', server.make_prompt(self.agent, [focus], self.config['agents'], focus, config=self.config))

    def test_outreach_after_limit_but_pause_blocks(self):
        self.scores()
        self.agent['routine'] = {}
        # No incoming inbox work; a lone outgoing check-in is old enough for another.
        self.now -= timedelta(minutes=26)
        server.append('Ji-woo', 'Hello', recipient='Mystery', initiative=True)
        self.now += timedelta(minutes=26)
        for quiet in (False, True):
            with self.subTest(quiet=quiet):
                server.set_quiet_room(quiet)
                server.STATE.update(turns=1, limit=1, evening_complete=True)
                server.ACTIVE.clear()
                # Reuse old contact for independent subcases.
                chat = server.history()[:1]
                with patch.object(server, 'history', return_value=chat), patch.object(server, 'invoke', return_value=json.dumps(dict(message='Thinking of you.', memory='I said hi.', to='Mystery'))) as invoke:
                    server.run_turn(dict(self.config, agents=[self.agent]))
                    self.assertEqual(invoke.call_count, 1)
                    self.assertIn('warm, natural and short', invoke.call_args.args[1])
                    self.assertEqual(server.STATE['turns'], 1)
                    server.STATE['evening_complete'] = False
                    server.run_turn(dict(self.config, agents=[self.agent]))
                    self.assertEqual(invoke.call_count, 1)

    def test_alarm_calls_each_provider_and_fallback_persist(self):
        self.local(23)
        focus = server.append('Mystery', 'Goodnight', recipient='Ji-woo')
        self.scores()
        reply = dict(message='I will say hello in the morning.', memory='I planned a morning hello.', to='Mystery',
                     calls=[dict(fn='set_alarm', at='07:30', to='Mystery', intent='Greet them in the morning', channel='dm')])
        # Real invoke + parse_reply + validation + apply; subprocess outputs are provider fixtures.
        for provider in ('claude', 'codex', 'agy', 'opencode', 'cursor', 'fallback'):
            with self.subTest(provider=provider):
                path = server.MEMORY.parent / 'alarms.json'
                path.unlink(missing_ok=True)
                actor = dict(self.agent, provider='claude' if provider == 'fallback' else provider, model='test')
                config = dict(self.config, agents=[actor], fallback={'provider': 'cursor', 'model': 'auto'})
                from unittest.mock import MagicMock
                def proc(route, error=False):
                    mock = MagicMock()
                    mock.__enter__.return_value = mock
                    mock.returncode = 1 if error else 0
                    if error:
                        output = json.dumps(dict(type='error', error='mock unavailable'))
                    elif route in ('claude', 'cursor', 'agy'):
                        output = json.dumps(dict(type='result', result=json.dumps(reply)))
                    elif route == 'codex':
                        output = json.dumps(dict(type='item.completed', item=dict(type='agent_message', text=json.dumps(reply))))
                    else:
                        output = json.dumps(dict(type='text', part=dict(text=json.dumps(reply))))
                    mock.communicate.return_value = (output, '')
                    return mock
                processes = [proc('claude', True), proc('cursor')] if provider == 'fallback' else [proc(provider)]
                # Undo the fixture's invoke mock only for this test; still no process is launched.
                with patch.object(server, 'invoke', ORIGINAL_INVOKE), patch.object(server.subprocess, 'Popen', side_effect=processes), patch.object(server.shutil, 'which', return_value='/mock/cli'):
                    turn = server.serve_turn(actor, 'prompt', [], config, [actor], focus, False)
                    self.assertEqual(turn.choices['calls'], reply['calls'])
                    self.keeper.apply('Ji-woo', turn, config)
                alarms = json.loads(path.read_text())['alarms']
                self.assertEqual(len(alarms), 1)
                self.assertEqual(alarms[0]['to'], 'Mystery')
                server.PROVIDER_BREAKS.clear()
                server.PROVIDER_EXHAUSTED.clear()

    def test_boundaries_in_target_store_block(self):
        self.agent['routine'] = {}
        self.scores('Grandpa Park')
        messages = self.old_contact(target='Grandpa Park')
        server.life_store('Grandpa Park').apply([dict(segment='boundaries', about=['Ji-woo'],
            text='Ji-woo asked for space.', tags=['space'], importance=5, status='open')],
            source_id='space', embed=False)
        self.assertIsNone(server.longing_for(self.agent, self.config['agents'], messages))

    def test_loop_ticks_after_evening_completion_and_pause_during_reply(self):
        server.set_quiet_room(True)
        server.ACTIVE.clear()
        server.STATE['evening_complete'] = True
        server.STOP.clear()
        with patch.object(server, 'run_turn', side_effect=lambda config: server.STOP.set()) as run:
            try:
                server.loop()
                self.assertEqual(run.call_count, 1)
            finally:
                server.STOP.clear()
        self.scores()
        self.agent['routine'] = {}
        self.now -= timedelta(minutes=26)
        server.append('Ji-woo', 'Hello', recipient='Mystery', initiative=True)
        self.now += timedelta(minutes=26)
        server.STATE.update(turns=1, limit=1, evening_complete=True)
        def paused_reply(*args, **kwargs):
            server.STATE['evening_complete'] = False
            server.ACTIVE.clear()
            return json.dumps(dict(message='Hi!', memory='I said hi.', to='Mystery'))
        with patch.object(server, 'invoke', side_effect=paused_reply):
            server.run_turn(dict(self.config, agents=[self.agent]))
        self.assertFalse(server.STATE['evening_complete'])
        self.assertFalse(server.ACTIVE.is_set())

    def test_configurable_curve_missing_and_exact_thresholds(self):
        self.assertAlmostEqual(engagement.wait_minutes(100, {}), 60)
        self.assertAlmostEqual(engagement.wait_minutes(200, {}), 25)
        self.assertLess(engagement.wait_minutes(400, {}), 12)
        self.assertAlmostEqual(engagement.wait_minutes(200, {'mood': {'missing': 10}}), 20)
        self.agent['routine'] = {}
        self.scores()
        self.assertIsNone(server.longing_for(self.agent, self.config['agents'], self.old_contact(minutes=24)))
        self.assertIsNotNone(server.longing_for(self.agent, self.config['agents'], self.old_contact(minutes=25)))
        self.config['initiative'] = {'minutes_at_200': 20}
        self.assertIsNotNone(server.longing_for(self.agent, self.config['agents'], self.old_contact(minutes=21)))
        for invalid in ({'unanswered_cap': 0}, {'daily_pair_cap': 1.5}, {'minutes_at_100': 10}, {'missing_discount': 2}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                engagement.settings({'initiative': invalid})

    def test_all_actors_use_same_time_based_policy(self):
        for actor in self.config['agents']:
            with self.subTest(actor=actor['name']):
                actor['routine'] = {}
                server.relationships.save(actor['name'], {'Mystery': dict(like=200, dislike=0)})
                messages = [dict(name='Mystery', to=actor['name'], channel='dm', text='Hi',
                                 time=(self.now-timedelta(minutes=25)).isoformat())]
                self.assertEqual(server.longing_for(actor, self.config['agents'], messages)[2], 'Mystery')

    def test_normal_outreach_to_family_bypasses_romantic_favorites(self):
        for actor in self.config['agents']:
            actor['routine'] = {}
        self.scores('Kim Min-jun')
        self.now -= timedelta(minutes=26)
        server.append('Ji-woo', 'Hi brother', recipient='Kim Min-jun', initiative=True)
        self.now += timedelta(minutes=26)
        with patch.object(server, 'priority_turn', return_value=None), patch.object(server, 'invoke', return_value=json.dumps(dict(
                message='Breakfast together?', memory='I asked my brother about breakfast.', to='Kim Min-jun'))) as invoke:
            server.run_turn(self.config)
        self.assertEqual(invoke.call_count, 1)
        self.assertEqual(server.history()[-1]['to'], 'Kim Min-jun')
        self.assertEqual(server.STATE['turns'], 0)
        self.assertIn('including friends and family', invoke.call_args.args[1])


ORIGINAL_INVOKE = server.invoke
