"""Offline non-human cast and authored-lore integration coverage."""
import json
import math
import re
from pathlib import Path
import tempfile
import unittest
from test_support import HermeticTestCase
from unittest.mock import patch

import backfill_memory
import characters
import eval_vella
import engagement
import life_memory
import relationships
import scenes
import server

ROOT = Path(__file__).resolve().parent


class VellaTests(HermeticTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        # The real room server may be running during tests; these CLI runs use temp data.
        live = patch.object(backfill_memory, 'server_live', return_value=None)
        live.start()
        self.addCleanup(live.stop)
        self.config = server.load_config()
        self.config['embeddings'] = {'enabled': False}
        self.cast = self.config['agents']
        for agent in self.cast:
            agent['enabled'] = True
        self.vella = next(a for a in self.cast if a['name'] == 'Vella')
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
        self.store = server.life_store('Vella', self.config)

    def focus(self, text):
        return dict(id='1', name='Mystery', to='Vella', channel='dm', text=text,
                    time='2026-10-15T00:00:00+00:00', kind='chat')

    def meta(self, actor):
        return dict(title='Garage visit', kind='hangout', location='lab garage', participants=[actor['name']])

    def test_every_cast_member_excludes_nonhumans_from_romance_and_favorites(self):
        for actor in self.cast:
            with self.subTest(actor=actor['name']):
                scores = {a['name']: dict(like=1500, dislike=0) for a in self.cast if a != actor}
                scores['Mystery'] = dict(like=1500, dislike=0)
                self.assertNotIn('Vella', relationships.romantic_names(actor, self.cast))
                self.assertNotIn('Vella', relationships.favorites(actor, scores, self.cast))
                if actor == self.vella:
                    self.assertEqual(relationships.romantic_names(actor, self.cast), set())
                    self.assertEqual(relationships.favorites(actor, scores, self.cast), [])
                    self.assertEqual(engagement.heart(actor, scores, self.cast, self.store), '')
                for score in (0, 40, 70, 101, 121, 201, 401, 801, 1500):
                    target = 'Mystery' if actor == self.vella else 'Vella'
                    tone = relationships.tone_guidance(actor, {target: dict(like=score, dislike=0,
                        mood=dict(hurt=5, anger=5, happy=5, missing=5))}, self.cast)
                    self.assertIn('platonic', tone)
                    self.assertNotIn('You love', tone)
                    for forbidden in ('marriage-ready', 'soulbond', 'devoted partner', 'close attraction'):
                        self.assertNotIn(forbidden, tone)
                recalled = life_memory.RetrievalContext('', [], [], False)
                prompt = self.manager.prompt(actor, self.meta(actor), [], self.config, recalled, '')
                interests = prompt.split('Eligible cast romantic interests: ', 1)[1].split('.', 1)[0]
                self.assertNotIn('Vella', interests)
                self.assertIn('All bonds involving a non-human character stay platonic', prompt)

    def test_null_sibling_missing_age_and_generic_nonhuman_prompts(self):
        actor = dict(self.vella, name='Beacon', kind='station_ai', sibling=None)
        cast = self.cast + [actor]
        room = server.make_prompt(actor, [], cast, config=self.config)
        scene = self.manager.prompt(actor, self.meta(actor), [], dict(self.config, agents=cast),
                                    life_memory.RetrievalContext('', [], [], False), '')
        for prompt in (room, scene):
            self.assertIn('fictional station_ai', prompt)
            self.assertNotIn('fictional adult human', prompt)
            self.assertNotIn('age None', prompt)
            self.assertNotIn('sibling is None', prompt)
            self.assertIn('You have no sibling', prompt)
        self.assertIn('Beacon, station_ai, female; sibling: none', room)
        human = dict(self.cast[0], sibling=None)
        self.assertIn('You have no sibling', server.make_prompt(human, [], cast, config=self.config))
        self.assertNotIn('physically together, in person', scene)
        with patch.object(server, 'provider_ready', return_value=True), patch.object(server.speech, 'ready', return_value=False):
            status = server.character_status(self.vella, self.config)
            self.assertEqual(status['kind'], 'ship_ai')
            self.assertIsNone(status['age'])
            self.assertIsNone(status['sibling'])
            self.assertIn(self.vella, server.available_agents(self.cast, self.config))
            self.assertEqual(server.choose_next([], [self.vella]), 'Vella')
        scene = self.manager.create(dict(participants=['Vella'], kind='hangout', title='Garage visit',
                                         location='lab garage'))
        self.assertEqual(scene['participants'], ['Vella'])
        self.assertIsNotNone(self.manager.away_reason('Vella'))

    def test_seed_cli_is_offline_and_rejects_other_cast_targets(self):
        with patch('sys.argv', ['backfill_memory.py', '--seed-lore', 'Vella', str(ROOT / 'lore/vella')]), \
             patch.object(server, 'invoke', side_effect=AssertionError('No provider calls')), \
             patch.object(life_memory.embeddings, 'embed', side_effect=AssertionError('No embeddings')), \
             patch('builtins.print'):
            backfill_memory.main()
        self.assertTrue(self.store.index()['records'])
        with patch('sys.argv', ['backfill_memory.py', '--seed-lore', 'Iris', str(ROOT / 'lore/vella')]), \
             patch('sys.stderr'), self.assertRaises(SystemExit) as raised:
            backfill_memory.main()
        self.assertEqual(raised.exception.code, 2)

    def test_seed_idempotency_and_only_target_store_is_written(self):
        first = backfill_memory.seed_lore(self.store, ROOT / 'lore/vella')
        self.assertGreater(first['added'], 60)
        snapshot = {p.name: p.read_bytes() for p in self.store.directory.glob('*.json')}
        second = backfill_memory.seed_lore(self.store, ROOT / 'lore/vella')
        self.assertEqual(second['added'], 0)
        self.assertEqual(snapshot, {p.name: p.read_bytes() for p in self.store.directory.glob('*.json')})
        self.assertEqual([p.name for p in (self.root / 'life').iterdir()], ['Vella'])
        self.assertFalse(server.MEMORY.exists())
        self.assertTrue(all(r.get('retrieval_only') for s in life_memory.SEGMENTS for r in self.store.load_segment(s)))
        self.assertTrue(all(first['counts'][s] for s in ('world', 'events', 'people', 'milestones')))

    def test_private_lore_is_topic_retrieved_and_never_auto_pinned(self):
        backfill_memory.seed_lore(self.store, ROOT / 'lore/vella')
        self.assertEqual(self.store.prompt_anchors('Mystery'), [])
        for recall in (False, True):
            rows, _ = self.store.retrieve('Hello Vella, how are you?', {'Mystery', 'Vella'}, recall=recall)
            self.assertFalse(rows)
            rows, _ = self.store.retrieve('What happened to Earth ozone and the crew?', {'Mystery'}, recall=recall)
            self.assertTrue(any('ozone' in r['text'].lower() for _, r in rows))
        focus = self.focus('Hello Vella, how are you?')
        _, _, pins = self.manager.recall(self.vella, self.meta(self.vella), [focus], self.config)
        self.assertEqual(pins, '')
        for actor in self.cast:
            if actor != self.vella:
                self.assertEqual(server.life_store(actor['name'], self.config).index(), {})
                prompt = server.make_prompt(actor, [], self.cast, config=self.config)
                self.assertNotIn('2090 BA1', prompt)
                self.assertNotIn('born in 2010', prompt)
        prompt = server.make_prompt(self.vella, [], self.cast, config=self.config)
        self.assertNotIn('2090 BA1', prompt)
        self.assertNotIn('born in 2010', prompt)

    def test_relevant_log_ids_and_dates_survive_retrieval_and_prompt_rule(self):
        backfill_memory.seed_lore(self.store, ROOT / 'lore/vella')
        focus = self.focus('Show your shield 117 readout logs at Proxima.')
        recalled = life_memory.retrieval_context(self.store, [focus], focus)
        self.assertIn('LOG V010 [ship', recalled.block)
        self.assertIn(json.loads((ROOT / 'lore/physics.json').read_text())['schedule']['V010']['earth_date'], recalled.block)
        for prompt in (server.make_prompt(self.vella, [focus], self.cast, focus, config=self.config),
                       self.manager.prompt(self.vella, self.meta(self.vella), [focus], self.config, recalled, '')):
            self.assertIn('quote one relevant entry at a time', prompt)
            self.assertIn('LOG ids', prompt)
            self.assertIn('current listener is not allowed by CAPTAIN LOG DISCLOSURE', prompt)
            self.assertIn('Retrieved private lore is knowledge, never permission', prompt)

    def test_friendly_nonhuman_dm_and_social_scores_remain_available(self):
        iris = next(a for a in self.cast if a['name'] == 'Iris')
        self.assertTrue(relationships.friendly_dm(iris, 'Vella', self.cast))
        self.assertTrue(relationships.friendly_dm(self.vella, 'Iris', self.cast))
        changes = relationships.propose(iris, {'Vella': dict(like=1500, dislike=0)}, self.cast)
        self.assertEqual(changes['Vella']['like'], 1500)
        reply = dict(message='Your apology was accepted.', memory='I am warming to Iris.', to='Iris')
        with patch.object(server, 'actor_result', return_value=reply):
            result = server.validated_turn(self.vella, self.vella, 'prompt', [], self.config,
                                           self.cast, None, False, server.time.monotonic() + 5)
        self.assertEqual(result[3], 'Iris')

    def test_lore_schema_counts_final_timeline_and_geometry(self):
        logs = [json.loads(line) for line in (ROOT / 'lore/vella/travel_logs.jsonl').read_text().splitlines()]
        self.assertTrue(25 <= len(logs) <= 40)
        self.assertEqual(len({r['id'] for r in logs}), len(logs))
        for row in logs:
            self.assertTrue({'id', 'ship_time', 'earth_date', 'location', 'type', 'text', 'tags'} <= row.keys())
            self.assertIn(row['type'], ('nav', 'incident', 'salvage', 'personal', 'sensor', 'maintenance'))
        words = (ROOT / 'lore/vella/backstory.md').read_text().split()
        self.assertTrue(600 <= len(words) <= 900)
        timeline = [json.loads(line) for line in (ROOT / 'lore/ryoma/timeline.jsonl').read_text().splitlines()]
        self.assertEqual(timeline[0]['earth_date'], '2010')
        self.assertIn('189', timeline[12]['text'])
        k = 299792458 / 9.81 / (365.25 * 86400)
        self.assertAlmostEqual(4 * k * math.asinh(15 / k), 13.303136, places=5)
        self.assertAlmostEqual(8.6 * math.sin(math.radians(21.88479)), 3.20558, places=5)
        self.assertEqual(len({a['voice'] for a in self.cast}), len(self.cast))


    def test_science_ranking_fixture_passes_eval_without_writes(self):
        backfill_memory.seed_lore(self.store, ROOT / 'lore/vella')
        snapshot = {p.name: p.read_bytes() for p in self.store.directory.glob('*.json')}
        store = eval_vella.ReadOnlyStore(self.root / 'life', 'Vella', embedding_config={'enabled': False},
                                         vector_writes=False)
        lines = []
        passed, _ = eval_vella.evaluate(store, out=lines.append)
        self.assertTrue(passed, '\n'.join(lines))
        self.assertEqual(len(eval_vella.CASES), 13)
        self.assertEqual(snapshot, {p.name: p.read_bytes() for p in self.store.directory.glob('*.json')})
        with self.assertRaises(RuntimeError):
            store.apply([dict(segment='events', about=['Vella'], text='x', tags=['x'], importance=1)])

    def test_seeded_lore_has_no_authoring_ids_and_readouts_are_pooled_apart(self):
        backfill_memory.seed_lore(self.store, ROOT / 'lore/vella')
        rows = [(s, r) for s in life_memory.SEGMENTS for r in self.store.load_segment(s)]
        for _, record in rows:
            self.assertIsNone(re.search(r'\b[FA]\d{3}\b|\[physics:', record['text']), record['text'])
            self.assertNotIn('Generated from the templates', record['text'])
            self.assertNotIn('Consistency repairs', record['text'])
        readouts = [r for s, r in rows if life_memory.is_physics_readout(r)]
        self.assertTrue(readouts)
        self.assertEqual({s for s, r in rows if life_memory.is_physics_readout(r)}, {'reference'})
        self.assertFalse([r for s, r in rows if s == 'reference' and not life_memory.is_physics_readout(r)])
        self.assertTrue(any(r['text'].startswith('Q: Is your drive accepted physics? A: ') for _, r in rows))
        self.assertTrue(any(r['text'].startswith('LOG V010 [ship') for _, r in rows))
        drive = next(r for _, r in rows if r['text'].startswith('Q: Is your drive accepted physics?'))
        self.assertTrue({'asterion', 'drive', 'propulsion', 'fusion'} <= set(drive['tags']))
        oxygen = next(r for _, r in rows if 'oxygen nuclei from electricity' in r['text'])
        self.assertIn('oxygen', oxygen['tags'])
        self.assertFalse([t for t in oxygen['tags'] if re.search(r'\d', t)])

    def test_readouts_only_for_numeric_asks_and_capped_behind_answers(self):
        for text, numeric in [('No fusion rocket can reach 0.998c. So how did you do it?', False),
                              ('Your shield read 117% at Proxima, is that a failure?', False),
                              ('How do you explain the twin paradox?', False),
                              ('What is the photon mass ratio?', True), ('How much power does the field draw?', True),
                              ('Quote the shield readout.', True), ('How far did you turn around?', True)]:
            self.assertEqual(life_memory.asks_for_quantity(text), numeric, text)
        backfill_memory.seed_lore(self.store, ROOT / 'lore/vella')
        for text, numeric in [('How does your shield handle protons?', False),
                              ('How much power does the Asterion field control draw?', True)]:
            focus = self.focus(text)
            context = life_memory.retrieval_context(self.store, [focus], focus, kind='ship_ai')
            kinds = [life_memory.is_physics_readout(r) for _, r in context.records]
            self.assertEqual(any(kinds), numeric, text)
            self.assertLessEqual(sum(kinds), life_memory.MAX_READOUTS)
            if numeric:
                self.assertFalse(kinds[0], 'authored answers come before raw readouts')
            self.assertNotIn('(#', context.block)

    def test_ship_ai_science_evidence_rejects_banter_but_humans_keep_evidence(self):
        backfill_memory.seed_lore(self.store, ROOT / 'lore/vella')
        banter = [dict(id='5', name='Theo', channel='group', kind='chat', text='Iris you drive like a rocket, so fast.'),
                  dict(id='6', name='Iris', channel='group', kind='chat',
                       text='The shield took 117 percent of its proton load at Proxima, Vella logged the shield radiation.')]
        focus = dict(id='7', name='Iris', to='Vella', channel='group', kind='chat',
                     text='@Vella no fusion rocket can reach 0.998c, the rocket equation forbids it. So how did you do it?')
        block = life_memory.retrieval_context(self.store, banter + [focus], focus, kind='ship_ai').block
        self.assertNotIn('From that conversation', block)
        self.assertIn('rocket', life_memory.retrieval_context(self.store, banter + [focus], focus).block)
        shield = dict(focus, text='@Vella how did your shield handle the proton radiation load at Proxima?')
        block = life_memory.retrieval_context(self.store, banter + [shield], shield, kind='ship_ai').block
        self.assertIn('From that conversation', block)
        self.assertNotIn('drive like a rocket', block)

    def test_ship_core_pin_and_science_rule_reach_every_prompt(self):
        core = characters.ship_core(self.vella)
        self.assertLessEqual(len(core.split()), characters.CORE_MAX_WORDS)
        for needle in ('WHAT YOU ARE', 'Asterion', 'fusion', '1,000,000', '150 MW', '117 MW', 'Cryosleep',
                       'Sirius 21.885°', 'atmosphere', 'wormhole'):
            self.assertIn(needle, core)
        self.assertIsNone(re.search(r'\b[FA]\d{3}\b|\[physics:|#', core))
        self.assertEqual(characters.ship_core(self.cast[0]), '')
        self.assertEqual(characters.ship_core(dict(self.vella, name='Beacon')), '')
        rule = characters.memory_rule(self.vella)
        self.assertIn('ONLY when asked for a specific number absent from memory', rule)
        self.assertIn('Never speak record ids, FAQ or question numbers', rule)
        focus = self.focus('How did you get so fast?')
        calls = []
        real = life_memory.retrieval_context
        def spy(*args, **kwargs):
            calls.append(kwargs.get('kind'))
            return real(*args, **kwargs)
        with patch.object(life_memory, 'retrieval_context', side_effect=spy):
            room = server.make_prompt(self.vella, [focus], self.cast, focus, config=self.config)
            _, recalled, _ = self.manager.recall(self.vella, self.meta(self.vella), [focus], self.config)
        self.assertEqual(calls, ['ship_ai', 'ship_ai'])
        scene = self.manager.prompt(self.vella, self.meta(self.vella), [focus], self.config, recalled, '')
        for prompt in (room, scene):
            self.assertEqual(prompt.count('WHAT YOU ARE (always true)'), 1)
        self.assertNotIn('WHAT YOU ARE', server.make_prompt(self.cast[0], [], self.cast, config=self.config))

    def test_replace_reseed_removes_old_lore_keeps_earned_memories_and_is_idempotent(self):
        lore = self.root / 'lore/vella'
        lore.mkdir(parents=True)
        (lore / 'travel_logs.jsonl').write_text('')
        (lore / 'faq.md').write_text('# FAQ\n\nPreamble.\n\n## F001 — Old question?\n\nOld answer about inertia.\n')
        (lore / 'backstory.md').write_text('# Vella\n\n## Origin\n\nBuilt under a canopy.\n')
        backfill_memory.seed_lore(self.store, lore)
        earned = dict(segment='events', about=['Vella', 'Mystery'], text='Mystery told me to talk to Iris.',
                      tags=['iris'], importance=3)
        self.store.apply([earned], source_id='42', embed=False)
        old = next(r for r in self.store.load_segment('important') if 'Old question' in r['text'])
        self.store._write('vectors.json', dict(boundary=0, vectors={old['id']: dict(vector=[1.0])}))
        (lore / 'faq.md').write_text('# FAQ\n\n## F001 — New question?\n\nNew answer about inertia.\n')
        result = backfill_memory.seed_lore(self.store, lore, replace=True)
        self.assertEqual((result['added'], result['removed']), (1, 1))
        index = self.store.index()
        raw = json.loads((self.store.directory / 'important.json').read_text())
        self.assertEqual([r['text'] for r in raw], ['Q: New question? A: New answer about inertia.'])
        self.assertNotIn(old['id'], index['records'])
        self.assertNotIn(old['id'], json.dumps(index['tags']) + json.dumps(index['people']))
        self.assertEqual(json.loads((self.store.directory / 'vectors.json').read_text())['vectors'], {})
        self.assertEqual([r['text'] for r in self.store.load_segment('events')], [earned['text']])
        snapshot = {p.name: p.read_bytes() for p in self.store.directory.glob('*.json')}
        again = backfill_memory.seed_lore(self.store, lore, replace=True)
        self.assertEqual((again['added'], again['removed']), (0, 0))
        self.assertEqual(snapshot, {p.name: p.read_bytes() for p in self.store.directory.glob('*.json')})
        with patch('sys.argv', ['backfill_memory.py', '--replace', 'Vella']), patch('sys.stderr'), \
             self.assertRaises(SystemExit):
            backfill_memory.main()

    def test_chat_extraction_cannot_write_reference_pool(self):
        raw = dict(segment='reference', about=['Vella'], text='Computed reference (x: y): 1.', tags=['x'], importance=3)
        self.assertIsNone(life_memory.Store.validate(raw, '1', 'now'))
        self.assertIsNotNone(life_memory.Store.validate(dict(raw, retrieval_only=True), '1', 'now'))

if __name__ == '__main__':
    unittest.main()
