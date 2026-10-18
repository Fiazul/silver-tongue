"""Knowledge provenance fixtures: isolated stores, no providers or live data writes."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from test_support import HermeticTestCase
from unittest.mock import patch

import backfill_memory
import knowledge
import life_memory
import meetups
import scenes
import server
import test_meetups
import test_timekeeper


def fact(text="Mystery's real name is Ryoma Tachibana.", **changes):
    return dict(segment='people', about=['Mystery'], text=text, tags=['name', 'Ryoma'], importance=5, **changes)


class KnowledgeTests(HermeticTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.config = server.load_config()
        self.config['embeddings'] = {'enabled': False}
        for agent in self.config['agents']:
            agent['enabled'] = True
        for field, value in (('DATA', self.root), ('LOG', self.root / 'messages.jsonl'),
                             ('MEMORY', self.root / 'memories.json'), ('RESETS', self.root / 'resets.json')):
            p = patch.object(server, field, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(server, 'load_config', return_value=self.config)
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(server.relationships, 'FILE', self.root / 'scores.json')
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(server.ACTIVE.clear)
        self.addCleanup(server.WAKE.clear)
        self.agents = self.config['agents']
        self.iris = next(a for a in self.agents if a['name'] == 'Iris')
        self.mina = next(a for a in self.agents if a['name'] == 'Mina')

    def prompt(self, agent, focus=None):
        return server.make_prompt(agent, server.history(), self.agents, focus, config=self.config)

    def test_unscored_dm_contact_gets_initial_impression_then_stops(self):
        server.append('Vella', 'Hello Iris.', recipient='Iris')
        focus = server.append('Iris', 'Hello Vella.', recipient='Vella')
        prompt = self.prompt(self.iris, focus)
        self.assertIn("You haven't formed a score for Vella yet; include your honest initial like/dislike for Vella in scores this turn.", prompt)
        self.assertIn('"Vella": "(no score yet)"', prompt)
        self.assertIn('platonic social impression', prompt)
        server.relationships.save('Iris', {'Vella': dict(like=45, dislike=0)})
        self.assertNotIn("haven't formed a score for Vella", self.prompt(self.iris, focus))

    def test_contact_nudges_cap_three_prefer_focus_and_require_real_contact(self):
        for name in ('Theo', 'Milo', 'Nora', 'Vella'):
            server.append(name, 'Hello.', recipient='Iris')
            focus = server.append('Iris', 'Hello.', recipient=name)
        server.append('Kai', 'I am here.')  # Mere presence is not interaction.
        server.append('Mina', 'Hello.', recipient='Iris')  # Only one interaction.
        prompt = self.prompt(self.iris, focus)
        nudges = [line for line in prompt.splitlines() if "You haven't formed a score" in line]
        self.assertEqual(len(nudges), 3)
        self.assertIn('for Vella yet', nudges[0])
        self.assertFalse(any('Kai' in line or 'Mina' in line for line in nudges))
        self.config['initial_score_history'] = 2
        self.assertNotIn("You haven't formed a score", self.prompt(self.iris, focus))

    def test_addressed_group_contact_in_both_directions_and_private_visibility(self):
        server.append('Vella', 'Iris, hello.')
        focus = server.append('Iris', 'Vella, hello.')
        server.append('Theo', 'Hello.', recipient='Mina')
        server.append('Mina', 'Hello.', recipient='Theo')
        prompt = self.prompt(self.iris, focus)
        self.assertIn("haven't formed a score for Vella", prompt)
        self.assertNotIn("haven't formed a score for Theo", prompt)
        # The 60-message default includes contacts beyond the displayed transcript.
        for _ in range(21):
            server.append('Kai', 'Just looking around.')
        self.assertIn("haven't formed a score for Vella", self.prompt(self.iris))
        for _ in range(39):
            server.append('Kai', 'Just looking around.')
        self.assertNotIn("haven't formed a score for Vella", self.prompt(self.iris))

    def test_other_listener_prior_acquaintance_respects_viewer_identity_knowledge(self):
        server.append('Mystery', 'My name is Ryoma Tachibana.', recipient='Iris')
        for viewer in (self.iris, self.mina):
            focus = server.append('Vella', 'What do you think of Mystery?', recipient=viewer['name'])
            lines = [line for line in self.prompt(viewer, focus).splitlines()
                     if line.startswith('WHAT Vella KNOWS ABOUT Mystery:')]
            lines = [line for line in lines if 'has known him for years' in line or 'knew Mystery before this room' in line]
            self.assertEqual(len(lines), 1)
            if viewer == self.iris:
                self.assertIn('Vella has known him for years as Ryoma Tachibana, Captain Rook', lines[0])
                self.assertIn('(' + next(a for a in self.agents if a['name'] == 'Vella')['knows_mystery']['relation'] + ')', lines[0])
            else:
                self.assertIn('Vella knew Mystery before this room', lines[0])
                self.assertNotIn('Ryoma', lines[0])
                self.assertNotIn('Captain', lines[0])
            self.assertNotIn("only as 'Mystery'", lines[0])
        focus = server.append('Mina', 'What do you think of Mystery?', recipient='Iris')
        self.assertIn("Mina knows Mystery only as 'Mystery'; Mina doesn't know his name is Ryoma Tachibana", self.prompt(self.iris, focus))

    def test_configured_acquaintance_is_personal_and_merges_learned_names(self):
        vella = next(a for a in self.agents if a['name'] == 'Vella')
        # Also exercise a human: acquaintance is independent of kind and lore flags.
        human = dict(self.iris, knows_mystery=vella['knows_mystery'])
        for agent in (vella, human):
            with self.subTest(name=agent['name']):
                prompt = self.prompt(agent)
                self.assertIn('PRIOR ACQUAINTANCE: You already know Mystery as Ryoma Tachibana, Captain Rook', prompt)
                self.assertIn(vella['knows_mystery']['relation'] + '; address him as Captain', prompt)
                self.assertNotIn('An unidentified speaker', prompt)
                self.assertNotIn('Treat that as an unknown voice', prompt)
                self.assertNotIn('no personal name learned', prompt)
                self.assertNotIn('without inventing their identity', prompt)
                self.assertNotIn('Until Mystery establishes their age or identity', prompt)
                self.assertIn('technical recipient and score key remain Mystery', prompt)
        for ordinary in (self.iris, self.mina):
            prompt = self.prompt(ordinary)
            self.assertIn('An unidentified speaker may initially post under the label Mystery.', prompt)
            self.assertIn('Mystery (no personal name learned)', prompt)
            self.assertNotIn('Ryoma', prompt)
            self.assertNotIn('PRIOR ACQUAINTANCE:', prompt)
            self.assertEqual(server.life_store(ordinary['name']).index(), {})
        store = server.life_store('Vella')
        self.assertEqual(knowledge.roster(store, labels=['Mystery'], agent=vella),
            'Mystery (you know him as Ryoma Tachibana, Captain Rook — your captain; you have flown with him for years; address him as Captain)')
        messages = [dict(name='Mystery', text='Call me Rook.', channel='dm', to='Vella')]
        merged = knowledge.roster(store, messages, ['Mystery'], agent=vella)
        self.assertIn('Ryoma Tachibana, Captain Rook, Rook', merged)
        self.assertEqual(merged.count('Captain Rook'), 1)
        self.assertEqual(store.index(), {})  # Configured acquaintance never creates witness records.
        self.assertEqual(knowledge.prompt(store, [], [], ['Mystery']),
                         knowledge.prompt(store, [], [], ['Mystery'], agent={}))

    def test_private_name_then_confidence_teaches_listener_and_preserves_attribution(self):
        intro = server.append('Mystery', 'My name is Ryoma Tachibana.', recipient='Iris')
        iris_store, mina_store = server.life_store('Iris'), server.life_store('Mina')
        original = iris_store.load_segment('people')[0]
        self.assertEqual(original['known_by'], ['Iris', 'Mystery'])
        self.assertEqual(original['source_channel'], 'dm')
        self.assertEqual(original['source_id'], intro['id'])
        self.assertEqual(mina_store.index(), {})
        focus = server.append('Mina', 'Iris, what do you think of Mystery?', recipient='Iris')
        prompt = self.prompt(self.iris, focus)
        self.assertIn("Mina doesn't know his name is Ryoma", prompt)
        self.assertIn("(Mina doesn't know this)", prompt)
        self.assertIn('WHAT Mina KNOWS ABOUT Mystery:', prompt)
        self.assertNotIn('you know him as Ryoma', self.prompt(self.mina))
        told = server.append('Iris', "Ryoma — that's Mystery's real name — asked me about my garden.", recipient='Mina')
        learned = mina_store.load_segment('people')[0]
        self.assertEqual(learned['known_by'], ['Iris', 'Mina'])
        self.assertEqual(learned['source_person'], 'Iris')
        self.assertEqual(learned['source_channel'], 'dm')
        self.assertEqual(learned['source_id'], told['id'])
        self.assertEqual(mina_store.index()['learned_names']['Mystery'], ['Ryoma'])
        self.assertIn('Mystery (you know him as Ryoma)', self.prompt(self.mina, told))
        self.assertIn('(told by Iris)', self.prompt(self.mina, told))
        self.assertIn('garden', mina_store.load_segment('events')[0]['text'])
        next_focus = server.append('Mina', 'What do you think of Mystery?', recipient='Iris')
        iris_prompt = self.prompt(self.iris, next_focus)
        self.assertIn('Mina knows the name Ryoma', iris_prompt)
        self.assertNotIn("Mina knows Mystery only as 'Mystery'", iris_prompt)
        # Repeated, explicit introductions expand the original witness record.
        server.append('Iris', "Mystery's real name is Ryoma Tachibana.", recipient='Mina')
        original = next(r for r in iris_store.load_segment('people') if r['id'] == original['id'])
        self.assertEqual(original['known_by'], ['Iris', 'Mina', 'Mystery'])
        self.assertEqual(original['source_id'], intro['id'])

    def test_all_characters_observe_only_their_sources_and_learn_arbitrary_aliases(self):
        for agent in self.agents:
            with self.subTest(name=agent['name']):
                source = server.append('Mystery', 'My name is Ryoma Tachibana.', recipient=agent['name'])
                row = server.life_store(agent['name']).load_segment('people')[0]
                self.assertIn(agent['name'], row['known_by'])
                self.assertIn('you know him as Ryoma', self.prompt(agent, source))
        source = server.append('Theo', 'Call me Teddy.', recipient='Iris')
        self.assertEqual(server.life_store('Iris').index()['learned_names']['Theo'], ['Teddy'])
        self.assertNotIn('Teddy', self.prompt(self.mina))
        # A name without an explicit association does not establish an alias.
        self.assertEqual(knowledge.aliases('What do you think of Ryoma?', 'Iris', ['Mystery']), [])

    def test_secret_requests_and_scope_are_stored_and_prompted(self):
        for request in ("Don't tell anyone.", 'Never reveal my name in group.',
                        'Keep my name private.', 'This is just between us.'):
            with self.subTest(request=request):
                source = server.append('Mystery', 'My name is Ryoma Tachibana. ' + request, recipient='Iris')
                server.life_store('Iris').apply([fact(text='A private story: ' + request)],
                    source_id=source['id'], visible=[source], embed=False)
                row = server.life_store('Iris').load_segment('people')[-1]
                self.assertTrue(row['secret'])
                self.assertIn(request.rstrip('.').lower().removeprefix('this is '), row['secret_from'].lower())
                focus = server.append('Mina', 'Tell me about Mystery.', recipient='Iris')
                prompt = self.prompt(self.iris, focus)
                self.assertIn('(asked to keep private:', prompt)
                self.assertIn('Never reveal what you were asked to keep private', prompt)
                self.assertIn("if unclear, don't", prompt)
                self.assertEqual(server.life_store('Mina').index(), {})

    def test_group_snapshot_and_third_party_fact_hints(self):
        source = server.append('Mystery', 'My name is Ryoma Tachibana.')
        present = {a['name'] for a in self.agents} | {'Mystery'}
        self.assertEqual(set(source['known_by']), present)
        for agent in self.agents:
            row = server.life_store(agent['name']).load_segment('people')[0]
            self.assertEqual(set(row['known_by']), present)
            self.assertEqual(row['source_channel'], 'group')
        focus = server.append('Mina', 'What do you think of Mystery?', recipient='Iris')
        self.assertIn('(Mina knows — they were there)', self.prompt(self.iris, focus))
        private = server.append('Mystery', 'I grew up beside the sea.', recipient='Iris')
        server.life_store('Iris').apply([fact(text='Mystery grew up beside the sea.')],
            source_id=private['id'], visible=[private], embed=False)
        prompt = self.prompt(self.iris, focus)
        self.assertIn("(Mina doesn't know this)", prompt)
        # Later arrival cannot see a witnessed group message retroactively.
        self.assertEqual(life_memory.visible_messages([source], 'Newcomer'), [])

    def test_public_reply_accounts_for_every_listener(self):
        server.append('Mystery', 'My name is Ryoma.', recipient='Iris')
        focus = server.append('Mystery', 'Iris, how are you?')
        prompt = self.prompt(self.iris, focus)
        self.assertIn("Mina doesn't know his name is Ryoma", prompt)
        self.assertIn("Theo doesn't know his name is Ryoma", prompt)

    def test_legacy_source_inference_unknown_fallback_and_untrusted_actor_fields(self):
        store = server.life_store('Iris')
        store.apply([fact()], source_id='1', embed=False)
        path = store.directory / 'people.json'
        rows = json.loads(path.read_text())
        rows[0].pop('known_by')
        path.write_text(json.dumps(rows))
        record = store.load_segment('people')[0]
        source = dict(id='1', name='Mystery', to='Iris', channel='dm', text='My name is Ryoma Tachibana.')
        self.assertEqual(knowledge.known_by(record, [source], 'Iris'), {'Mystery', 'Iris'})
        self.assertEqual(knowledge.known_by(record, [], 'Iris'), {'Iris'})
        self.assertIn("Mina doesn't know", knowledge.prompt(store, [source], ['Mina'], ['Mystery']))
        hidden = dict(source, id='2', to='Mina')
        store.apply([fact(text='Another private fact.', known_by=['Mina'], source_id='2', secret=True)],
                    source_id='missing', visible=[hidden], embed=False)
        self.assertEqual(store.load_segment('people')[-1]['known_by'], ['Iris'])
        self.assertNotIn('secret', store.load_segment('people')[-1])

    def test_backfill_and_sweep_publish_source_provenance(self):
        source = dict(id='1', name='Mystery', channel='dm', to='Iris', text="My name is Ryoma. Don't tell anyone.")
        output = json.dumps(dict(remember=[dict(fact(), source_id='1')]))
        extracted = backfill_memory.extract_messages(self.iris, [source], invoke=lambda *args: output)
        backfill_memory.publish(server.life_store('Iris', self.config), extracted)
        row = server.life_store('Iris').load_segment('people')[0]
        self.assertEqual(row['source_person'], 'Mystery')
        self.assertEqual(row['known_by'], ['Iris', 'Mystery'])
        self.assertTrue(row['secret'])

    def test_quiet_start_default_override_persistence_and_opt_out(self):
        for config in ({}, {'quiet_on_start': True}):
            server.set_quiet_room(False)
            server.ACTIVE.set()
            with self.assertLogs('server', level='INFO') as log:
                server.startup_state(config, start=True)
            self.assertTrue(server.quiet_room())
            self.assertTrue(json.loads(server.room_state_path().read_text())['quiet_room'])
            self.assertFalse(server.ACTIVE.is_set())
            self.assertIn('Startup: quiet room ON; evening paused.', log.output[0])
        server.set_quiet_room(False)
        server.startup_state({'quiet_on_start': False}, start=True)
        self.assertFalse(server.quiet_room())
        self.assertTrue(server.ACTIVE.is_set())


class SceneKnowledgeTests(HermeticTestCase):
    setUp = test_meetups.MeetupTests.setUp
    provider = test_meetups.MeetupTests.provider
    record = test_meetups.MeetupTests.record
    invite = test_meetups.MeetupTests.invite
    accept = test_meetups.MeetupTests.accept
    start = test_meetups.MeetupTests.start

    def test_scene_and_meetup_scores_and_listener_acquaintance(self):
        agent = next(a for a in self.config['agents'] if a['name'] == 'Iris')
        for autonomous in (False, True):
            with self.subTest(autonomous=autonomous):
                meta = dict(id='s12345678', participants=['Iris', 'Vella'], title='Talk',
                            kind='hangout', location='garden', autonomous=autonomous, exchanges=2)
                messages = [dict(id=str(i), name=name, text=text, channel='scene',
                                 known_by=['Iris', 'Vella']) for i, name, text in (
                                     (1, 'Vella', 'Iris, hello.'), (2, 'Iris', 'Vella, hello.'))]
                store, recalled, pins = self.manager.recall(agent, meta, messages, self.config)
                prompt = self.manager.prompt(agent, meta, messages, self.config, recalled, pins)
                self.assertIn("haven't formed a score for Vella", prompt)
                self.assertIn('"Vella": "(no score yet)"', prompt)
                self.assertIn('Vella knew Mystery before this room', prompt)
                self.assertNotIn('Ryoma', prompt)
                server.relationships.save('Iris', {'Vella': dict(like=30, dislike=0)})
                prompt = self.manager.prompt(agent, meta, messages, self.config, recalled, pins)
                self.assertNotIn("haven't formed a score for Vella", prompt)
                server.relationships.save('Iris', {})

    def test_scene_and_meetup_prompts_share_knowledge_rules_and_markers(self):
        server.append('Mystery', "My name is Ryoma. Don't reveal it in group.", recipient='Iris')
        agent = next(a for a in self.config['agents'] if a['name'] == 'Iris')
        for autonomous in (False, True):
            with self.subTest(autonomous=autonomous):
                meta = dict(id='s12345678', participants=['Iris', 'Mina'], title='Talk', kind='hangout',
                            location='garden', autonomous=autonomous, exchanges=0)
                store, recalled, pins = self.manager.recall(agent, meta, [], self.config)
                prompt = self.manager.prompt(agent, meta, [], self.config, recalled, pins)
                self.assertIn("Mina doesn't know his name is Ryoma", prompt)
                self.assertIn('Never reveal what you were asked to keep private', prompt)
                self.assertIn('(asked to keep private:', prompt)
                self.assertIn('(Mina doesn\'t know this)', prompt)
        self.assertEqual(server.life_store('Mina').index(), {})

    def test_acquaintance_in_scene_and_meetup_with_and_without_mystery(self):
        vella = next(a for a in self.config['agents'] if a['name'] == 'Vella')
        human = dict(self.config['agents'][0], knows_mystery=vella['knows_mystery'])
        for agent in (vella, human):
            for autonomous, joined in ((False, False), (True, False), (True, True)):
                with self.subTest(name=agent['name'], autonomous=autonomous, joined=joined):
                    meta = dict(id='s12345678', participants=[agent['name'], 'Mina'], title='Talk',
                                kind='hangout', location='garden', autonomous=autonomous,
                                mystery_joined=joined, exchanges=0)
                    _, recalled, pins = self.manager.recall(agent, meta, [], self.config)
                    prompt = self.manager.prompt(agent, meta, [], self.config, recalled, pins)
                    self.assertIn('PRIOR ACQUAINTANCE: You already know Mystery as Ryoma Tachibana, Captain Rook', prompt)
                    self.assertIn('address him as Captain', prompt)
                    self.assertNotIn('no personal name learned', prompt)
                    self.assertNotIn("Mystery's identity/age/gender are only", prompt)
                    self.assertNotIn("Mystery's identity, age and consent are only", prompt)
        self.assertEqual(server.life_store('Mina').index(), {})

    def test_scene_posts_only_teach_participants(self):
        scene = self.manager.create(dict(participants=['Iris', 'Mina'], title='Talk', kind='hangout',
                                         location='garden', visibility='private'))
        posted = self.manager.append(scene['id'], 'Iris', "Mystery's real name is Ryoma.")
        row = server.life_store('Mina').load_segment('people')[0]
        self.assertEqual(row['known_by'], ['Iris', 'Mina', 'Mystery'])
        self.assertEqual(row['source_channel'], 'scene')
        self.assertEqual(row['source_person'], 'Iris')
        self.assertEqual(row['source_id'], posted['id'])
        self.assertEqual(server.life_store('Theo').index(), {})

    def test_scene_summary_provenance_and_meetup_fallback(self):
        scene = self.manager.create(dict(participants=['Iris', 'Mina'], title='Talk', kind='hangout',
                                         location='garden', visibility='private'))
        self.manager.jobs[scene['id']] = dict(operation='end')
        self.manager.summarize(scene['id'])
        for name in ('Iris', 'Mina'):
            rows = server.life_store(name).load_segment('events')
            summary = next(r for r in rows if r['source_id'] == scene['id'])
            self.assertEqual(summary['known_by'], ['Iris', 'Mina', 'Mystery'])
            self.assertEqual(summary['source_channel'], 'scene')
        scene_id = self.start(source='Theo', target='Milo')
        self.manager.append(scene_id, 'Theo', 'Milo, Mystery asked us not to tell anyone about the gift.')
        with patch.object(self.manager, 'summarize', side_effect=ValueError('bad summary')):
            with self.assertLogs('meetups', level='ERROR'):
                self.meetups.close(scene_id)
        for name in ('Theo', 'Milo'):
            summary = next(r for r in server.life_store(name).load_segment('events') if r['source_id'] == scene_id)
            self.assertEqual(summary['known_by'], ['Milo', 'Theo'])
            self.assertEqual(summary['source_channel'], 'scene')
            self.assertTrue(summary['secret'])


class AlarmKnowledgeTests(HermeticTestCase):
    setUp = test_timekeeper.TimekeeperTests.setUp
    provider = test_timekeeper.TimekeeperTests.provider

    def test_acquaintance_in_room_and_scene_alarm_prompts(self):
        agent = next(a for a in self.config['agents'] if a['name'] == 'Iris')
        agent['knows_mystery'] = dict(names=['Ryoma Tachibana', 'Captain Rook'], address='Captain',
                                    relation='your longtime friend')
        alarm = dict(to='Mystery', channel='dm', intent='Say hello', created_at=self.tk.clock().isoformat())
        self.reply = dict(message='Hello, Captain.', memory='We talked.', to='Mystery')
        self.tk.room_turn(alarm, agent, self.config)
        scene = self.manager.create(dict(participants=['Iris'], title='Talk', kind='hangout',
                                         location='garden', visibility='private'))
        self.reply['to'] = None
        self.tk.scene_turn(alarm, agent, scene, self.config)
        self.assertEqual(len(self.prompts), 2)
        for _, prompt in self.prompts:
            self.assertIn('PRIOR ACQUAINTANCE: You already know Mystery as Ryoma Tachibana, Captain Rook', prompt)
            self.assertNotIn('An unidentified speaker', prompt)
            self.assertNotIn('no personal name learned', prompt)

    def test_room_and_scene_alarm_prompt_and_write_provenance(self):
        server.append('Mystery', 'My name is Ryoma.', recipient='Iris')
        agent = next(a for a in self.config['agents'] if a['name'] == 'Iris')
        alarm = dict(to='Mina', channel='dm', intent='Ask Mina for advice', created_at=self.tk.clock().isoformat())
        self.reply = dict(message="Ryoma — that's Mystery's real name — asked me about the garden.",
                          memory='I asked for advice.', to='Mina', remember=[fact(text='I asked Mina for advice.')])
        posted = self.tk.room_turn(alarm, agent, self.config)
        prompt = self.prompts[-1][1]
        self.assertIn("Mina doesn't know his name is Ryoma", prompt)
        self.assertIn('Never reveal what you were asked to keep private', prompt)
        self.assertEqual(server.life_store('Mina').load_segment('people')[0]['source_id'], posted['id'])
        row = next(r for r in server.life_store('Iris').load_segment('people') if r['text'] == 'I asked Mina for advice.')
        self.assertEqual(row['source_channel'], 'dm')
        self.assertEqual(row['known_by'], ['Iris', 'Mina'])
        scene = self.manager.create(dict(participants=['Iris', 'Mina'], title='Talk', kind='hangout',
                                         location='garden', visibility='private'))
        self.reply = dict(message="Mystery's real name is Ryoma.", memory='We talked in person.', to=None,
                          remember=[fact(text='I spoke with Mina in the garden.')])
        posted = self.tk.scene_turn(alarm, agent, scene, self.config)
        self.assertIn('KNOWLEDGE AND CONFIDING:', self.prompts[-1][1])
        row = next(r for r in server.life_store('Iris').load_segment('people') if 'I spoke with Mina' in r['text'])
        self.assertEqual(row['source_channel'], 'scene')
        self.assertEqual(row['known_by'], ['Iris', 'Mina', 'Mystery'])


class AcquaintanceConfigTests(HermeticTestCase):
    def test_load_config_rejects_invalid_shapes(self):
        config = server.load_config()
        invalid = (None, False, [], 'Ryoma', {}, {'names': []}, {'names': 'Ryoma'},
                   {'names': [None]}, {'names': ['']}, {'names': ['  ']}, {'names': [42]},
                   {'names': ['Ryoma'], 'address': None}, {'names': ['Ryoma'], 'address': ''},
                   {'names': ['Ryoma'], 'address': []}, {'names': ['Ryoma'], 'relation': 3},
                   {'names': ['Ryoma'], 'relation': '  '})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'agents.json'
            with patch.object(server, 'CONFIG', path):
                for value in invalid:
                    with self.subTest(value=value):
                        config['agents'][0]['knows_mystery'] = value
                        path.write_text(json.dumps(config))
                        with self.assertRaisesRegex(ValueError, 'knows_mystery'):
                            server.load_config()
                for value in ({'names': ['Ryoma']}, {'names': ['Ryoma'], 'address': 'Captain',
                                                    'relation': 'your captain'}):
                    config['agents'][0]['knows_mystery'] = value
                    path.write_text(json.dumps(config))
                    self.assertEqual(server.load_config()['agents'][0]['knows_mystery'], value)


if __name__ == '__main__':
    unittest.main()
