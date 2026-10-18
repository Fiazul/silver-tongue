"""Offline room-role regressions; all state and provider calls are isolated."""
import json
from datetime import timedelta
from pathlib import Path
import time
import unittest
from test_support import HermeticTestCase
from unittest.mock import patch

import attention
import characters
import server
import test_scenes


class RoomRoleTests(HermeticTestCase):
    def setUp(self):
        self.read_config = server.load_config
        test_scenes.SceneTests.setUp(self)
        self.vella = next(a for a in self.config['agents'] if a['name'] == 'Vella')
        self.iris = next(a for a in self.config['agents'] if a['name'] == 'Iris')
        self.reply = dict(message='I hear you.', memory='I listened.', to=None, thread_done=True)
        server.STATE.update(speaker=None, turns=0, limit=100)
        server.ACTIVE.set()
        self.addCleanup(server.ACTIVE.clear)
        self.addCleanup(lambda: server.STATE.update(speaker=None, turns=0, limit=24))

    def provider(self, agent, prompt, timeout, images=None):
        return json.dumps(self.reply)

    def turn_as(self, name):
        with patch.object(server, 'choose_next', return_value=name):
            server.run_turn(self.config)

    def focus(self, agent):
        thread = server.thread_for(agent, server.history(), self.config)
        return thread['message'] if thread else None

    def test_vella_configuration_and_generic_boolean_validation(self):
        self.assertIs(self.vella['group_initiative'], False)
        self.assertIs(self.vella['host_level'], True)
        path = Path(self.temp.name) / 'agents.json'
        for field in ('group_initiative', 'host_level'):
            for value in (None, 0, 1, 'false', [], {}):
                with self.subTest(field=field, value=value):
                    config = json.loads(json.dumps(self.config))
                    config['agents'][0][field] = value
                    path.write_text(json.dumps(config))
                    with patch.object(server, 'CONFIG', path), self.assertRaisesRegex(ValueError, field):
                        self.read_config()
            for value in (True, False):
                characters.validate_room_roles(dict(self.iris, **{field: value}))
        characters.validate_room_roles(dict(name='Default'))
        self.assertEqual(characters.host_names([dict(name='Beacon', host_level=True)]), {'Mystery', 'Beacon'})

    def test_never_selects_restricted_character_for_group_initiative(self):
        messages = [dict(name=name, text='hello') for name in ('Iris', 'Mina', 'Theo')]
        self.assertIsNone(server.initiative_turn(messages, [self.vella]))
        self.assertEqual(server.initiative_turn(messages, [self.vella, self.iris]), 'Iris')

    def test_unprompted_public_drafts_are_suppressed_at_every_room_entry(self):
        # Empty room, ordinary independent turn, forced public rotation, and longing.
        for scenario in ('empty', 'independent', 'rotation', 'longing'):
            with self.subTest(scenario=scenario):
                server.LOG.unlink(missing_ok=True)
                if scenario != 'empty':
                    for index in range(10):
                        server.append('Theo', 'Small talk', recipient='Mina' if scenario == 'rotation' else None)
                with patch.object(server, 'longing_for', return_value=(300, 10, 'Mystery') if scenario == 'longing' else None):
                    before = server.history()[:]
                    self.invoke.reset_mock()
                    self.turn_as('Vella')
                    self.assertEqual(server.history(), before)
                    if scenario != 'longing':
                        self.invoke.assert_not_called()  # New private outreach waits for its idle clock.
                        continue
                    prompt = self.invoke.call_args.args[1]
                    self.assertIn('PRIVATE ONLY', prompt)
                    self.assertNotIn('GROUP TURN:', prompt)

    def test_replies_to_mentions_and_name_addresses_generically(self):
        for agent in (self.vella, dict(self.iris, group_initiative=False)):
            self.config['agents'] = [agent]
            for text in (f'@{agent["name"]} hello', f'{agent["name"]}, how are you?',
                         f'What do you think, {agent["name"]}?'):
                with self.subTest(agent=agent['name'], text=text):
                    message = server.append('Mystery', text)
                    self.turn_as(agent['name'])
                    reply = server.history()[-1]
                    self.assertEqual((reply['name'], reply['channel'], reply['reply_to']),
                                     (agent['name'], 'group', message['id']))

    def test_implicit_reply_and_ordinary_broadcast_do_not_engage_vella(self):
        original = server.append('Vella', '@Iris a prior answer')
        server.append('Iris', 'Continuing that thought', reply_to=original['id'])
        server.append('Mystery', 'Good evening everyone.')
        self.assertIsNone(self.focus(self.vella))
        self.assertIsNone(server.thread_for(self.vella, server.history(), self.config, broadcast=True))

    def test_host_room_question_can_engage_vella(self):
        question = server.append('Mystery', 'Everyone, how are you?')
        self.assertEqual(server.thread_for(self.vella, server.history(), self.config, broadcast=True)['message']['id'], question['id'])
        self.turn_as('Vella')
        self.assertEqual(server.history()[-1]['reply_to'], question['id'])
        self.assertEqual(server.history()[-1]['channel'], 'group')

    def test_dm_reply_stays_private_even_when_public_rotation_is_due(self):
        server.append('Iris', 'Private', recipient='Theo')
        server.append('Theo', 'Private', recipient='Iris')
        question = server.append('Mystery', 'Tell me privately', recipient='Vella')
        self.turn_as('Vella')
        reply = server.history()[-1]
        self.assertEqual((reply['channel'], reply['to'], reply['reply_to']), ('dm', 'Mystery', question['id']))

    def test_public_rotation_excludes_restricted_agents_without_pending_replies(self):
        server.append('Iris', 'Private', recipient='Mina')
        server.append('Mina', 'Private', recipient='Iris', reply_to=server.history()[-1]['id'])
        # Vella is last in the cast; this makes the former random-selection bug deterministic.
        with patch.object(server.random, 'choice', side_effect=lambda names: names[-1]):
            picked = server.choose_next(server.history(), self.config['agents'], self.config)
        self.assertNotEqual(picked, 'Vella')
        self.assertNotIn(picked, ('Iris', 'Mina'))
        self.assertTrue(next(a for a in self.config['agents'] if a['name'] == picked).get('group_initiative', True))

    def test_unassigned_room_turns_prefer_group_speakers(self):
        with patch.object(server.random, 'choice', side_effect=lambda names: names[-1]), \
                patch.object(server, 'longing_for', return_value=None):
            self.assertNotEqual(server.choose_next([], self.config['agents'], self.config), 'Vella')
            server.append('Mystery', 'Evening, everyone.')
            self.assertNotEqual(server.choose_next(server.history(), self.config['agents'], self.config), 'Vella')

    def test_independent_dm_is_still_allowed(self):
        self.config['agents'] = [self.vella]
        now = server.TIMEKEEPER.clock()
        with patch.object(server.TIMEKEEPER, 'clock', return_value=now-timedelta(minutes=21)):
            server.append('Vella', 'Earlier hello.', recipient='Mystery', initiative=True, thread_done=True)
        self.reply['to'] = 'Mystery'
        self.turn_as('Vella')
        self.assertEqual((server.history()[-1]['name'], server.history()[-1]['channel']), ('Vella', 'dm'))

    def test_heart_direction_is_private_for_restricted_agents(self):
        self.iris['group_initiative'] = False
        with patch.object(server.engagement, 'heart', return_value='Unspoken love: private feelings'):
            server.append('Mystery', '@Iris answer publicly?')
            self.turn_as('Iris')
            self.assertNotIn('Unspoken love: private feelings', self.invoke.call_args.args[1])
            server.append('Mystery', 'Answer privately?', recipient='Iris')
            self.turn_as('Iris')
            self.assertIn('Unspoken love: private feelings', self.invoke.call_args.args[1])
            self.reply['to'] = 'Mystery'
            self.turn_as('Iris')
            self.assertIn('Unspoken love: private feelings', self.invoke.call_args.args[1])

    def test_quiet_host_replies_and_direct_responses_without_follow_on(self):
        server.set_quiet_room(True)
        question = server.append('Mina', '@Vella can you answer?')
        server.run_turn(self.config)
        vella = server.history()[-1]
        self.assertEqual((vella['name'], vella['reply_to']), ('Vella', question['id']))
        server.LOG.unlink()
        server.append('Vella', '@Iris your thoughts?')
        self.reply['message'] = '@Mina what about you?'
        server.run_turn(self.config)
        iris = server.history()[-1]
        self.assertEqual(iris['name'], 'Iris')
        self.assertEqual(server.history()[-2]['name'], 'Vella')
        calls = self.invoke.call_count
        server.run_turn(self.config)
        self.assertEqual(self.invoke.call_count, calls)
        self.assertIsNone(server.quiet_turn(server.history(), self.config['agents'], self.config))

    def test_quiet_host_dm_can_be_answered_and_cannot_redirect(self):
        server.set_quiet_room(True)
        question = server.append('Vella', 'Can we talk?', recipient='Iris')
        server.run_turn(self.config)
        reply = server.history()[-1]
        self.assertEqual((reply['name'], reply['to'], reply['reply_to']), ('Iris', 'Vella', question['id']))
        server.append('Vella', '@Iris one more thing?')
        server.relationships.save('Iris', {'Mina': dict(like=60, dislike=0)})
        self.reply['to'] = 'Mina'
        before = len(server.history())
        server.run_turn(self.config)
        self.assertEqual(len(server.history()), before)

    def test_quiet_does_not_grant_vella_public_initiative(self):
        server.set_quiet_room(True)
        self.assertIsNone(server.quiet_turn([], self.config['agents'], self.config))
        self.assertIsNone(server.quiet_turn([dict(name='Theo', text='hello')], self.config['agents'], self.config))

    def test_generic_host_can_initiate_when_enabled(self):
        server.set_quiet_room(True)
        self.vella['group_initiative'] = True
        server.run_turn(self.config)
        self.assertEqual((server.history()[-1]['name'], server.history()[-1]['channel']), ('Vella', 'group'))

    def test_quiet_host_longing_is_dm_only_for_vella(self):
        server.set_quiet_room(True)
        self.reply['to'] = 'Iris'
        with patch.object(server, 'longing_for', side_effect=lambda agent, *args:
                          (300, 10, 'Iris') if agent['name'] == 'Vella' else None):
            server.run_turn(self.config)
        self.assertEqual((server.history()[-1]['name'], server.history()[-1]['to']), ('Vella', 'Iris'))

    def test_hosts_share_attention_priority_and_mystery_wins_ties(self):
        server.append('Theo', '@Iris urgent help!')
        server.append('Vella', '@Iris hello')
        self.assertEqual(self.focus(self.iris)['name'], 'Vella')
        server.append('Mystery', '@Iris hello')
        self.assertEqual(self.focus(self.iris)['name'], 'Mystery')
        latest = server.append('Vella', '@Iris latest')
        self.assertEqual(server.priority_turn(server.history(), self.config['agents'], self.config)[1]['id'], latest['id'])
        host = dict(counterpart='Vella', host_level=True, last_incoming=5, urgent=False, arrival=0)
        mystery = dict(host, counterpart='Mystery')
        self.assertLess(attention.rank(mystery, {}), attention.rank(host, {}))

    def test_configured_host_exemption_uses_full_cast_even_when_host_is_away(self):
        server.set_quiet_room(True)
        question = server.append('Vella', '@Iris answer when you can')
        picked = server.quiet_turn(server.history(), [self.iris], self.config)
        self.assertEqual((picked[0], picked[1]['id']), ('Iris', question['id']))

    def test_role_status_and_identity_are_separate(self):
        status = server.character_status(self.vella, self.config)
        self.assertIs(status['host_level'], True)
        self.assertIs(status['group_initiative'], False)
        self.assertEqual(status['kind'], 'ship_ai')
        self.assertFalse(characters.is_human(self.vella))

    def test_group_restriction_does_not_block_scene_validation(self):
        result = server.validated_turn(self.vella, self.vella, 'scene', [], self.config,
                                       self.config['agents'], None, True, time.monotonic() + 60,
                                       scene_participants=['Vella', 'Mystery'])
        self.assertEqual(result[0], 'I hear you.')
        self.assertIsNone(result[3])

    def test_group_alarm_still_posts_without_a_mention_to_vella(self):
        server.set_quiet_room(True)
        alarm = dict(to='Iris', channel='group', intent='Share the planned readout',
                     created_at=server.TIMEKEEPER.clock().isoformat())
        posted = server.TIMEKEEPER.room_turn(alarm, self.vella, self.config)
        self.assertEqual((posted['name'], posted['channel'], posted['alarm']), ('Vella', 'group', True))


if __name__ == '__main__':
    unittest.main()
