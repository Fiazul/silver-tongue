"""Relationship regression tests with isolated storage and no provider calls."""
import json
from pathlib import Path
import tempfile
import unittest
from test_support import HermeticTestCase
from unittest.mock import patch

import relationships
import server

MALE_MYSTERY = {'mystery': {'gender': 'male'}}


class RelationshipTests(HermeticTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for module, name, value in (
                (relationships, 'FILE', self.root / 'relationships.json'),
                (server, 'DATA', self.root),
                (server, 'LOG', self.root / 'messages.jsonl'),
                (server, 'MEMORY', self.root / 'memories.json'),
                (server, 'RESETS', self.root / 'resets.json')):
            patcher = patch.object(module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.config = server.load_config()
        self.config['embeddings'] = {'enabled': False}
        self.agents = self.config['agents']
        self.iris = next(a for a in self.agents if a['name'] == 'Iris')

    def propose(self, changes=None, **kwargs):
        return relationships.propose(self.iris, changes or {}, self.agents, **kwargs)

    def test_initial_non_human_score_is_accepted_without_clamping(self):
        self.assertEqual(self.propose({'Vella': dict(like=75, dislike=2)})['Vella'],
                         dict(like=75, dislike=2))

    def test_initial_score_window_requires_positive_integer(self):
        for invalid in (0, -1, True, '60', 1.5):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                relationships.settings({'initial_score_history': invalid})

    def test_flat_mood_targets_counterpart_for_every_character(self):
        for agent in self.agents:
            result = relationships.propose(agent, {}, self.agents, mood={'happy': 3}, counterpart='Mystery')
            self.assertEqual(result['Mystery']['mood']['happy'], 3)
        with self.assertLogs(relationships.LOG, level='WARNING'):
            self.assertEqual(self.propose(mood={'happy': 3}), {})
        self.assertEqual(self.propose(mood={'Theo': {'happy': 3}}, counterpart='Mystery')['Theo']['mood']['happy'], 3)

    def test_server_threads_dm_partner_and_focus_speaker_to_flat_mood(self):
        reply = dict(message='I am happy.', memory='We talked.', to=None, mood={'happy': 3})
        for focus, public, target in ((dict(name='Mystery', channel='dm'), False, 'Mystery'),
                                      (dict(name='Theo', channel='group'), True, 'Theo'),
                                      (None, False, 'Mystery')):
            with self.subTest(focus=focus), patch.object(server, 'actor_result', return_value=dict(reply, to=target if focus is None else None)):
                turn = server.validated_turn(self.iris, self.iris, '', [], self.config, self.agents,
                                             focus, public, server.time.monotonic() + 10)
            self.assertEqual(turn[4][target]['mood']['happy'], 3)

    def test_love_drop_cap_overrides_general_clamp_at_boundary(self):
        for prior, expected in ((150, 147), (100, 97), (99, 89), (80, 70)):
            with self.subTest(prior=prior):
                relationships.save('Iris', {'Mystery': {'like': prior, 'dislike': 3}})
                proposal = 62 if prior == 150 else 40
                scores = self.propose({'Mystery': {'like': proposal, 'dislike': 6}})
                self.assertEqual(scores['Mystery'], {'like': expected, 'dislike': 6})
                self.assertEqual(relationships.load()['Iris']['Mystery']['like'], prior)

    def test_every_character_and_target_uses_general_clamp_and_new_targets_are_unclamped(self):
        for agent in self.agents:
            targets = [a['name'] for a in self.agents if a != agent] + ['Mystery']
            relationships.save(agent['name'], {name: {'like': 80, 'dislike': 30} for name in targets})
            for like, dislike, expected in ((0, 100, (70, 40)), (1500, 0, (90, 20))):
                proposed = relationships.propose(agent, {n: dict(like=like, dislike=dislike) for n in targets}, self.agents)
                for name in targets:
                    with self.subTest(agent=agent['name'], target=name):
                        self.assertEqual((proposed[name]['like'], proposed[name]['dislike']), expected)
        relationships.save('Iris', {})
        self.assertEqual(self.propose({'Mystery': {'like': 1500, 'dislike': 100}})['Mystery'],
                         {'like': 1500, 'dislike': 100})

    def test_config_overrides_and_existing_score_above_old_ceiling(self):
        relationships.save('Iris', {'Mystery': {'like': 210, 'dislike': 2}, 'Mina': {'like': 80, 'dislike': 20}})
        result = self.propose({'Mystery': {'like': 1500, 'dislike': 100}, 'Mina': {'like': 0, 'dislike': 0}},
                              config={'score_step_max': 7})
        self.assertEqual(result['Mystery'], {'like': 217, 'dislike': 9})
        self.assertEqual(result['Mina'], {'like': 73, 'dislike': 13})
        self.assertEqual(self.propose()['Mystery']['like'], 210)
        self.assertEqual(self.propose({'Mystery': {'like': 62, 'dislike': 2}},
                                     config={'score_step_max': 1})['Mystery']['like'], 209)
        relationships.save('Iris', {})
        self.assertEqual(self.propose({'Mystery': {'like': 1700, 'dislike': 0}}, config={'like_max': 2000})['Mystery']['like'], 1700)
        self.assertEqual(self.propose({'Mystery': {'like': 1501, 'dislike': 0}})['Mystery']['like'], 1500)
        self.assertEqual(self.propose({'Mystery': {'like': 1001, 'dislike': 0}},
                                     config={'like_max': 1000})['Mystery']['like'], 1000)
        for config in ({'score_step_max': True}, {'like_max': 0}, {'score_step_max': 1.5}):
            with self.subTest(config=config), self.assertRaises(ValueError):
                self.propose(config=config)

    def test_mood_is_independent_validated_and_clamped_both_directions(self):
        relationships.save('Iris', {'Mystery': {'like': 210, 'dislike': 2}})
        result = self.propose(mood={'Mystery': dict.fromkeys(relationships.MOOD_KEYS, 10)}, message_count=10)
        self.assertEqual(result['Mystery']['mood'], dict.fromkeys(relationships.MOOD_KEYS, 5))
        self.assertEqual(result['Mystery']['like'], 210)
        relationships.save('Iris', result)
        result = self.propose(mood={'Mystery': {'hurt': 10, 'happy': 7}}, message_count=10)
        self.assertEqual(result['Mystery']['mood']['hurt'], 10)
        self.assertEqual(result['Mystery']['mood']['anger'], 5)
        relationships.save('Iris', result)
        result = self.propose(mood={'Mystery': {'hurt': 0}}, message_count=10)
        self.assertEqual(result['Mystery']['mood']['hurt'], 5)
        for bad in ([], {'Nobody': {'hurt': 1}}, {'Iris': {'hurt': 1}}, {'Mystery': []},
                    {'Mystery': {'hurt': True}}, {'Mystery': {'hurt': 'NaN'}},
                    {'Mystery': {'hurt': {'value': 2}}}, {'Mystery': {'love': 2}}):
            with self.subTest(bad=bad), self.assertLogs(relationships.LOG, level='WARNING'):
                self.assertEqual(self.propose(mood=bad), self.propose())

    def test_optional_scores_and_mood_sanitize_each_key_and_keep_good_entries(self):
        relationships.save('Iris', {'Mystery': {'like': 210, 'dislike': 2}})
        with self.assertLogs(relationships.LOG, level='WARNING'):
            result = self.propose(
                {'mYsTeRy': {'like': '-100', 'dislike': 200.2, 'calm': 1},
                 'nora': {'like': '1600.6', 'dislike': '4.6'},
                 'Nobody': {'like': 10, 'dislike': 0}, 'Theo': [],
                 'Mina': {'like': 8}},
                mood={'mystery': {'hurt': '12.4', 'anger': 2.6, 'sad': '-2',
                                  'happy': '3.4', 'missing': 'bad', 'love': 8},
                      'nora': {'happy': 4.6}, 'Nobody': {'hurt': 5}}, message_count=10)
        self.assertEqual(result['Mystery']['like'], 207)
        self.assertEqual(result['Mystery']['dislike'], 12)
        self.assertEqual(result['Mystery']['mood'],
                         dict(hurt=5, anger=3, sad=0, happy=3, missing=0))
        self.assertEqual(result['Mystery']['mood_message_count'], 10)
        self.assertEqual(result['Nora']['like'], 1500)
        self.assertEqual(result['Nora']['dislike'], 5)
        self.assertEqual(result['Nora']['mood']['happy'], 5)
        self.assertNotIn('Nobody', result)
        self.assertNotIn('Theo', result)
        self.assertNotIn('Mina', result)
        self.assertEqual(relationships.load()['Iris']['Mystery'], {'like': 210, 'dislike': 2})

    def test_partial_scores_keep_previous_and_bad_values_never_raise(self):
        relationships.save('Iris', {'Mystery': {'like': 210, 'dislike': 2}})
        self.assertEqual(self.propose({'Mystery': {'dislike': '4.6'}})['Mystery'],
                         {'like': 210, 'dislike': 5})
        for bad in (None, [], 'bad', True, float('nan'), float('inf'), 'Infinity', {}, '1e999999'):
            with self.subTest(bad=bad), self.assertLogs(relationships.LOG, level='WARNING'):
                result = self.propose({'Mystery': {'like': bad, 'dislike': 'bad'}})
            self.assertEqual(result['Mystery']['dislike'], 2)
            self.assertEqual(result['Mystery']['like'], 220 if bad == '1e999999' else 210)
        for bad in (None, [], 'bad', True):
            with self.subTest(container=bad), self.assertLogs(relationships.LOG, level='WARNING'):
                self.assertEqual(relationships.propose(self.iris, bad, self.agents), self.propose())

    def test_message_survives_malformed_optional_relationship_extras(self):
        reply = dict(message='I am here.', memory='I care.', to=None,
                     scores=['bad'], mood={'mystery': {'hurt': '8.6', 'love': 9}})
        with patch.object(server, 'actor_result', return_value=reply), self.assertLogs(relationships.LOG):
            turn = server.validated_turn(self.iris, self.iris, '', [], self.config, self.agents,
                                         None, True, server.time.monotonic() + 10)
        self.assertEqual(turn[0], 'I am here.')
        self.assertEqual(turn[4]['Mystery']['mood']['hurt'], 5)

    def test_mood_decay_is_lazy_survives_save_and_preserves_fractional_interval(self):
        result = self.propose({'Mystery': {'like': 210, 'dislike': 2}},
                              mood={'Mystery': {'hurt': 5, 'happy': 2}}, message_count=10)
        relationships.save('Iris', result)
        before = relationships.FILE.read_bytes()
        self.assertEqual(relationships.load(15)['Iris']['Mystery']['mood']['hurt'], 5)
        self.assertEqual(relationships.load(16)['Iris']['Mystery']['mood']['hurt'], 4)
        self.assertEqual(relationships.load(22)['Iris']['Mystery']['mood']['happy'], 0)
        self.assertEqual(relationships.FILE.read_bytes(), before)
        relationships.save('Iris', self.propose(message_count=17))
        self.assertEqual(relationships.load(21)['Iris']['Mystery']['mood']['hurt'], 4)
        self.assertEqual(relationships.load(22)['Iris']['Mystery']['mood']['hurt'], 3)
        self.assertEqual(relationships.load(100)['Iris']['Mystery']['mood']['hurt'], 0)
        self.assertEqual(relationships.load(100)['Iris']['Mystery']['like'], 210)

    def test_new_room_log_rebases_mood_decay(self):
        result = self.propose(mood={'Mystery': {'hurt': 5}}, message_count=100)
        relationships.save('Iris', result)
        self.assertEqual(relationships.load(5)['Iris']['Mystery']['mood']['hurt'], 5)
        self.assertEqual(relationships.load(6)['Iris']['Mystery']['mood']['hurt'], 4)

    def test_tiers_keep_sibling_preference_and_consent_guards(self):
        mina = next(a for a in self.agents if a['name'] == 'Mina')
        for score, expected in ((40, 'warming'), (70, 'close'), (101, 'marriage-ready'),
                                (121, 'love talking'), (200, 'love talking'), (201, 'deep love'),
                                (400, 'deep love'), (401, 'devoted partner'), (800, 'devoted partner'), (801, 'soulbond')):
            with self.subTest(score=score):
                tone = relationships.tone_guidance(self.iris, {'Mystery': dict(like=score, dislike=0),
                                                              'Theo': dict(like=score, dislike=0)}, self.agents, MALE_MYSTERY)
                self.assertIn(f'Mystery: {expected}', tone)
                self.assertIn('Theo: family', tone)
                tone = relationships.tone_guidance(mina, {'Iris': dict(like=score, dislike=0)}, self.agents)
                if score > 200:
                    self.assertIn('platonic', tone)
                    self.assertIn('consent', relationships.tone_guidance(self.iris, {'Mystery': dict(like=score, dislike=0)}, self.agents, MALE_MYSTERY))

    def test_love_and_mood_guide_repair_anger_missing_and_happiness(self):
        values = dict(like=210, dislike=2, mood=dict.fromkeys(relationships.MOOD_KEYS, 5))
        tone = relationships.tone_guidance(self.iris, {'Mystery': values}, self.agents, MALE_MYSTERY)
        for phrase in ("You love Mystery and you're hurt right now", 'Never treat them as replaceable',
                       'do not punish', 'miss them', 'Reach out', 'feel happy', 'Respect rejection'):
            self.assertIn(phrase, tone)
        tone = relationships.tone_guidance(self.iris, {'Theo': values}, self.agents)
        self.assertIn('family affection', tone)
        self.assertNotIn('You love Theo', tone)

    def test_prompt_status_and_final_reply_use_current_bond_and_mood(self):
        result = self.propose({'Mystery': {'like': 210, 'dislike': 2}}, mood={'Mystery': {'hurt': 5}}, message_count=0)
        relationships.save('Iris', result)
        server.LOG.write_text(''.join(json.dumps({'name': 'Mystery', 'text': 'hello'}) + '\n' for _ in range(6)))
        prompt = server.make_prompt(self.iris, [], self.agents, config=dict(self.config, like_max=2000))
        for phrase in ('HOW YOU FEEL NOW', '0–2000', '"like": 210', '"hurt": 4',
                       'conflict with someone you love changes your mood, not your love', 'real shared experiences'):
            self.assertIn(phrase, prompt)
        self.assertEqual(server.character_status(self.iris)['preferences']['Mystery']['mood']['hurt'], 4)
        reply = dict(message='That hurt. Can we talk?', memory='I care and feel hurt.', to=None,
                     scores={'Mystery': dict(like=62, dislike=80)}, mood={'Mystery': {'hurt': 10}})
        with patch.object(server, 'actor_result', return_value=reply):
            turn = server.validated_turn(self.iris, self.iris, prompt, [], self.config, self.agents,
                                         None, True, server.time.monotonic() + 10)
        self.assertEqual(turn[4]['Mystery']['like'], 207)
        self.assertEqual(turn[4]['Mystery']['dislike'], 12)
        self.assertEqual(turn[4]['Mystery']['mood']['hurt'], 9)

    def test_scene_gains_validate_pairs_cap_ceiling_and_are_idempotent(self):
        relationships.save('Iris', {'Nora': {'like': 1490, 'dislike': 2}, 'Mystery': {'like': 210, 'dislike': 2}})
        relationships.save('Nora', {'Iris': {'like': 80, 'dislike': 3}})
        gains = [dict(names=['Iris', 'Nora'], like=25), dict(names=['Mystery', 'Iris'], like=25)]
        for _ in range(2):
            relationships.award_scene('scene', gains, ['Iris', 'Nora'], self.agents)
        data = relationships.load()
        self.assertEqual(data['Iris']['Nora']['like'], 1500)
        self.assertEqual(data['Nora']['Iris']['like'], 105)
        self.assertEqual(data['Iris']['Mystery']['like'], 235)
        self.assertEqual(data['Iris']['Mystery']['dislike'], 2)
        self.assertNotIn('Mystery', data)
        for bad in (None, [None], [dict(names=['Iris', 'Nora'], like=True)],
                    [dict(names=['Iris', 'Theo'], like=5)],
                    [dict(names=['Iris', 'Iris'], like=5)],
                    [dict(names=[{}, 'Iris'], like=5)]):
            before = relationships.FILE.read_bytes()
            with self.subTest(bad=bad), self.assertLogs(relationships.LOG, level='WARNING'):
                relationships.award_scene('new', bad, ['Iris', 'Nora'], self.agents)
            self.assertEqual(relationships.FILE.read_bytes(), before)

    def test_scene_gains_keep_good_items_coerce_clamp_and_first_pair(self):
        gains = [None, dict(names=['unknown', 'Iris'], like=4),
                 dict(names=['iris', 'nora'], like='4.6'),
                 dict(names=['Nora', 'Iris'], like=20),
                 dict(names=['Mystery', 'iris'], like=99.2),
                 dict(names=['Mystery', 'nora'], like='-2'),
                 dict(names=['Iris', 'Iris'], like=2)]
        with self.assertLogs(relationships.LOG, level='WARNING'):
            self.assertEqual(relationships.validate_scene_gains(gains, ['Iris', 'Nora']),
                             {('Iris', 'Nora'): 5, ('Iris', 'Mystery'): 25, ('Mystery', 'Nora'): 0})
