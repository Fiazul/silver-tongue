"""Offline coverage for a non-human cast member beside the human story cast."""
from pathlib import Path
import tempfile
import unittest
from test_support import HermeticTestCase
from unittest.mock import patch

import engagement
import life_memory
import relationships
import scenes
import server


class NonHumanTests(HermeticTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config = server.load_config()
        self.config['embeddings'] = {'enabled': False}
        # The story cast is human; a synthetic station AI exercises the non-human rules.
        self.beacon = dict(name='Beacon', kind='station_ai', gender='female', sibling=None, enabled=True,
                           face='◯', color='#79b8ca', tagline='Keeps the lights on.',
                           personality='Precise, dry and helpful.', provider='codex', model='gpt-5.6-terra',
                           presence='You speak through the building intercom.',
                           group_initiative=False, host_level=True, attracted_to=[],
                           routine=dict(maintenance='04:00-04:20', home='the building', day='Building systems.',
                                        sleepy_reply=False))
        self.config['agents'].append(self.beacon)
        self.cast = self.config['agents']
        for agent in self.cast:
            agent['enabled'] = True
        self.manager = scenes.Scenes(vars(server))
        for obj, key, value in (
            (server, 'DATA', self.root), (server, 'LOG', self.root / 'messages.jsonl'),
            (server, 'MEMORY', self.root / 'memories.json'), (server, 'RESETS', self.root / 'resets.json'),
            (server, 'SCENES', self.manager), (server, 'load_config', lambda: self.config),
            (relationships, 'FILE', self.root / 'relationships.json'),
        ):
            patcher = patch.object(obj, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.store = server.life_store('Beacon', self.config)

    def meta(self, actor):
        return dict(title='Rooftop visit', kind='hangout', location='the rooftop', participants=[actor['name']])

    def test_every_cast_member_excludes_nonhumans_from_romance_and_favorites(self):
        for actor in self.cast:
            with self.subTest(actor=actor['name']):
                scores = {a['name']: dict(like=1500, dislike=0) for a in self.cast if a != actor}
                scores['Mystery'] = dict(like=1500, dislike=0)
                self.assertNotIn('Beacon', relationships.romantic_names(actor, self.cast))
                self.assertNotIn('Beacon', relationships.favorites(actor, scores, self.cast))
                if actor == self.beacon:
                    self.assertEqual(relationships.romantic_names(actor, self.cast), set())
                    self.assertEqual(relationships.favorites(actor, scores, self.cast), [])
                    self.assertEqual(engagement.heart(actor, scores, self.cast, self.store), '')
                for score in (0, 40, 70, 101, 121, 201, 401, 801, 1500):
                    target = 'Mystery' if actor == self.beacon else 'Beacon'
                    tone = relationships.tone_guidance(actor, {target: dict(like=score, dislike=0,
                        mood=dict(hurt=5, anger=5, happy=5, missing=5))}, self.cast)
                    self.assertIn('platonic', tone)
                    self.assertNotIn('You love', tone)
                    for forbidden in ('marriage-ready', 'soulbond', 'devoted partner', 'close attraction'):
                        self.assertNotIn(forbidden, tone)
                recalled = life_memory.RetrievalContext('', [], [], False)
                prompt = self.manager.prompt(actor, self.meta(actor), [], self.config, recalled, '')
                interests = prompt.split('Eligible cast romantic interests: ', 1)[1].split('.', 1)[0]
                self.assertNotIn('Beacon', interests)
                self.assertIn('All bonds involving a non-human character stay platonic', prompt)

    def test_null_sibling_missing_age_and_generic_nonhuman_prompts(self):
        actor = self.beacon
        room = server.make_prompt(actor, [], self.cast, config=self.config)
        scene = self.manager.prompt(actor, self.meta(actor), [], self.config,
                                    life_memory.RetrievalContext('', [], [], False), '')
        for prompt in (room, scene):
            self.assertIn('fictional station_ai', prompt)
            self.assertNotIn('fictional human named', prompt)
            self.assertNotIn('age None', prompt)
            self.assertNotIn('sibling is None', prompt)
            self.assertIn('You have no sibling', prompt)
        self.assertIn('Beacon, station_ai, female; sibling: none', room)
        human = dict(self.cast[0], sibling=None)
        self.assertIn('You have no sibling', server.make_prompt(human, [], self.cast, config=self.config))
        self.assertNotIn('physically together, in person', scene)
        with patch.object(server, 'provider_ready', return_value=True):
            status = server.character_status(self.beacon, self.config)
            self.assertEqual(status['kind'], 'station_ai')
            self.assertIsNone(status['age'])
            self.assertIsNone(status['sibling'])
            self.assertFalse(status['voice_ready'])
            self.assertIn(self.beacon, server.available_agents(self.cast, self.config))
            self.assertEqual(server.choose_next([], [self.beacon]), 'Beacon')
        scene = self.manager.create(dict(participants=['Beacon'], kind='hangout', title='Rooftop visit',
                                         location='the rooftop'))
        self.assertEqual(scene['participants'], ['Beacon'])
        self.assertIsNotNone(self.manager.away_reason('Beacon'))

    def test_friendly_nonhuman_dm_and_social_scores_remain_available(self):
        jiwoo = next(a for a in self.cast if a['name'] == 'Ji-woo')
        self.assertTrue(relationships.friendly_dm(jiwoo, 'Beacon', self.cast))
        self.assertTrue(relationships.friendly_dm(self.beacon, 'Ji-woo', self.cast))
        changes = relationships.propose(jiwoo, {'Beacon': dict(like=1500, dislike=0)}, self.cast)
        self.assertEqual(changes['Beacon']['like'], 1500)
        reply = dict(message='Your apology was accepted.', memory='I am warming to Ji-woo.', to='Ji-woo')
        with patch.object(server, 'actor_result', return_value=reply):
            result = server.validated_turn(self.beacon, self.beacon, 'prompt', [], self.config,
                                           self.cast, None, False, server.time.monotonic() + 5)
        self.assertEqual(result[3], 'Ji-woo')


if __name__ == '__main__':
    unittest.main()
