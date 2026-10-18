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


def fact(text="Mystery's real name is Alex Carter.", **changes):
    return dict(segment='people', about=['Mystery'], text=text, tags=['name', 'Alex'], importance=5, **changes)


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
        self.jiwoo = next(a for a in self.agents if a['name'] == 'Ji-woo')
        self.suit = next(a for a in self.agents if a['name'] == 'The Man in a Suit')

    def prompt(self, agent, focus=None):
        return server.make_prompt(agent, server.history(), self.agents, focus, config=self.config)

    def test_unscored_dm_contact_gets_initial_impression_then_stops(self):
        server.append('The Merchant', 'Hello Ji-woo.', recipient='Ji-woo')
        focus = server.append('Ji-woo', 'Hello The Merchant.', recipient='The Merchant')
        prompt = self.prompt(self.jiwoo, focus)
        self.assertIn("You haven't formed a score for The Merchant yet; include your honest initial like/dislike for The Merchant in scores this turn.", prompt)
        self.assertIn('"The Merchant": "(no score yet)"', prompt)
        self.assertIn('platonic social impression', prompt)
        server.relationships.save('Ji-woo', {'The Merchant': dict(like=45, dislike=0)})
        self.assertNotIn("haven't formed a score for The Merchant", self.prompt(self.jiwoo, focus))

    def test_contact_nudges_cap_three_prefer_focus_and_require_real_contact(self):
        for name in ('Kim Min-jun', 'Grandpa Park', 'The Landlady', 'The Merchant'):
            server.append(name, 'Hello.', recipient='Ji-woo')
            focus = server.append('Ji-woo', 'Hello.', recipient=name)
        server.append('The Corner Shop Clerk', 'I am here.')  # Mere presence is not interaction.
        server.append('The Man in a Suit', 'Hello.', recipient='Ji-woo')  # Only one interaction.
        prompt = self.prompt(self.jiwoo, focus)
        nudges = [line for line in prompt.splitlines() if "You haven't formed a score" in line]
        self.assertEqual(len(nudges), 3)
        self.assertIn('for The Merchant yet', nudges[0])
        self.assertFalse(any('The Corner Shop Clerk' in line or 'The Man in a Suit' in line for line in nudges))
        self.config['initial_score_history'] = 2
        self.assertNotIn("You haven't formed a score", self.prompt(self.jiwoo, focus))

    def test_addressed_group_contact_in_both_directions_and_private_visibility(self):
        server.append('The Merchant', 'Ji-woo, hello.')
        focus = server.append('Ji-woo', 'The Merchant, hello.')
        server.append('Kim Min-jun', 'Hello.', recipient='The Man in a Suit')
        server.append('The Man in a Suit', 'Hello.', recipient='Kim Min-jun')
        prompt = self.prompt(self.jiwoo, focus)
        self.assertIn("haven't formed a score for The Merchant", prompt)
        self.assertNotIn("haven't formed a score for Kim Min-jun", prompt)
        # The 60-message default includes contacts beyond the displayed transcript.
        for _ in range(21):
            server.append('The Corner Shop Clerk', 'Just looking around.')
        self.assertIn("haven't formed a score for The Merchant", self.prompt(self.jiwoo))
        for _ in range(39):
            server.append('The Corner Shop Clerk', 'Just looking around.')
        self.assertNotIn("haven't formed a score for The Merchant", self.prompt(self.jiwoo))

    def test_other_listener_prior_acquaintance_respects_viewer_identity_knowledge(self):
        server.append('Mystery', 'My name is Alex Carter.', recipient='Ji-woo')
        for viewer in (self.jiwoo, self.suit):
            focus = server.append('The Merchant', 'What do you think of Mystery?', recipient=viewer['name'])
            lines = [line for line in self.prompt(viewer, focus).splitlines()
                     if line.startswith('WHAT The Merchant KNOWS ABOUT Mystery:')]
            lines = [line for line in lines if 'has known him for years' in line or 'knew Mystery before this room' in line]
            self.assertEqual(len(lines), 1)
            if viewer == self.jiwoo:
                self.assertIn('The Merchant has known him for years as Alex Carter, Mr Carter', lines[0])
                self.assertIn('(' + next(a for a in self.agents if a['name'] == 'The Merchant')['knows_mystery']['relation'] + ')', lines[0])
            else:
                self.assertIn('The Merchant knew Mystery before this room', lines[0])
                self.assertNotIn('Alex', lines[0])
                self.assertNotIn('Carter', lines[0])
            self.assertNotIn("only as 'Mystery'", lines[0])
        focus = server.append('The Man in a Suit', 'What do you think of Mystery?', recipient='Ji-woo')
        self.assertIn("The Man in a Suit knows Mystery only as 'Mystery'; The Man in a Suit doesn't know his name is Alex Carter", self.prompt(self.jiwoo, focus))

    def test_configured_acquaintance_is_personal_and_merges_learned_names(self):
        merchant = next(a for a in self.agents if a['name'] == 'The Merchant')
        # Also exercise a human: acquaintance is independent of kind and lore flags.
        human = dict(self.jiwoo, knows_mystery=merchant['knows_mystery'])
        for agent in (merchant, human):
            with self.subTest(name=agent['name']):
                prompt = self.prompt(agent)
                self.assertIn('PRIOR ACQUAINTANCE: You already know Mystery as Alex Carter, Mr Carter', prompt)
                self.assertIn(merchant['knows_mystery']['relation'] + '; address him as Sir', prompt)
                self.assertNotIn('An unidentified speaker', prompt)
                self.assertNotIn('Treat that as an unknown voice', prompt)
                self.assertNotIn('no personal name learned', prompt)
                self.assertNotIn('without inventing their identity', prompt)
                self.assertNotIn('Until Mystery establishes their age or identity', prompt)
                self.assertIn('technical recipient and score key remain Mystery', prompt)
        for ordinary in (self.jiwoo, self.suit):
            prompt = self.prompt(ordinary)
            self.assertIn('An unidentified speaker may initially post under the label Mystery.', prompt)
            self.assertIn('Mystery (no personal name learned)', prompt)
            self.assertNotIn('Alex', prompt)
            self.assertNotIn('PRIOR ACQUAINTANCE:', prompt)
            self.assertEqual(server.life_store(ordinary['name']).index(), {})
        store = server.life_store('The Merchant')
        self.assertEqual(knowledge.roster(store, labels=['Mystery'], agent=merchant),
            'Mystery (you know him as Alex Carter, Mr Carter — a regular customer; you have traded with him for years; address him as Sir)')
        messages = [dict(name='Mystery', text='Call me Carter.', channel='dm', to='The Merchant')]
        merged = knowledge.roster(store, messages, ['Mystery'], agent=merchant)
        self.assertIn('Alex Carter, Mr Carter, Carter', merged)
        self.assertEqual(merged.count('Mr Carter'), 1)
        self.assertEqual(store.index(), {})  # Configured acquaintance never creates witness records.
        self.assertEqual(knowledge.prompt(store, [], [], ['Mystery']),
                         knowledge.prompt(store, [], [], ['Mystery'], agent={}))

    def test_private_name_then_confidence_teaches_listener_and_preserves_attribution(self):
        intro = server.append('Mystery', 'My name is Alex Carter.', recipient='Ji-woo')
        jiwoo_store, suit_store = server.life_store('Ji-woo'), server.life_store('The Man in a Suit')
        original = jiwoo_store.load_segment('people')[0]
        self.assertEqual(original['known_by'], ['Ji-woo', 'Mystery'])
        self.assertEqual(original['source_channel'], 'dm')
        self.assertEqual(original['source_id'], intro['id'])
        self.assertEqual(suit_store.index(), {})
        focus = server.append('The Man in a Suit', 'Ji-woo, what do you think of Mystery?', recipient='Ji-woo')
        prompt = self.prompt(self.jiwoo, focus)
        self.assertIn("The Man in a Suit doesn't know his name is Alex", prompt)
        self.assertIn("(The Man in a Suit doesn't know this)", prompt)
        self.assertIn('WHAT The Man in a Suit KNOWS ABOUT Mystery:', prompt)
        self.assertNotIn('you know him as Alex', self.prompt(self.suit))
        told = server.append('Ji-woo', "Alex — that's Mystery's real name — asked me about my garden.", recipient='The Man in a Suit')
        learned = suit_store.load_segment('people')[0]
        self.assertEqual(learned['known_by'], ['Ji-woo', 'The Man in a Suit'])
        self.assertEqual(learned['source_person'], 'Ji-woo')
        self.assertEqual(learned['source_channel'], 'dm')
        self.assertEqual(learned['source_id'], told['id'])
        self.assertEqual(suit_store.index()['learned_names']['Mystery'], ['Alex'])
        self.assertIn('Mystery (you know him as Alex)', self.prompt(self.suit, told))
        self.assertIn('(told by Ji-woo)', self.prompt(self.suit, told))
        self.assertIn('garden', suit_store.load_segment('events')[0]['text'])
        next_focus = server.append('The Man in a Suit', 'What do you think of Mystery?', recipient='Ji-woo')
        jiwoo_prompt = self.prompt(self.jiwoo, next_focus)
        self.assertIn('The Man in a Suit knows the name Alex', jiwoo_prompt)
        self.assertNotIn("The Man in a Suit knows Mystery only as 'Mystery'", jiwoo_prompt)
        # Repeated, explicit introductions expand the original witness record.
        server.append('Ji-woo', "Mystery's real name is Alex Carter.", recipient='The Man in a Suit')
        original = next(r for r in jiwoo_store.load_segment('people') if r['id'] == original['id'])
        self.assertEqual(original['known_by'], ['Ji-woo', 'Mystery', 'The Man in a Suit'])
        self.assertEqual(original['source_id'], intro['id'])

    def test_all_characters_observe_only_their_sources_and_learn_arbitrary_aliases(self):
        for agent in self.agents:
            with self.subTest(name=agent['name']):
                source = server.append('Mystery', 'My name is Alex Carter.', recipient=agent['name'])
                row = server.life_store(agent['name']).load_segment('people')[0]
                self.assertIn(agent['name'], row['known_by'])
                self.assertIn('you know him as Alex', self.prompt(agent, source))
        source = server.append('Kim Min-jun', 'Call me Teddy.', recipient='Ji-woo')
        self.assertEqual(server.life_store('Ji-woo').index()['learned_names']['Kim Min-jun'], ['Teddy'])
        self.assertNotIn('Teddy', self.prompt(self.suit))
        # A name without an explicit association does not establish an alias.
        self.assertEqual(knowledge.aliases('What do you think of Alex?', 'Ji-woo', ['Mystery']), [])

    def test_secret_requests_and_scope_are_stored_and_prompted(self):
        for request in ("Don't tell anyone.", 'Never reveal my name in group.',
                        'Keep my name private.', 'This is just between us.'):
            with self.subTest(request=request):
                source = server.append('Mystery', 'My name is Alex Carter. ' + request, recipient='Ji-woo')
                server.life_store('Ji-woo').apply([fact(text='A private story: ' + request)],
                    source_id=source['id'], visible=[source], embed=False)
                row = server.life_store('Ji-woo').load_segment('people')[-1]
                self.assertTrue(row['secret'])
                self.assertIn(request.rstrip('.').lower().removeprefix('this is '), row['secret_from'].lower())
                focus = server.append('The Man in a Suit', 'Tell me about Mystery.', recipient='Ji-woo')
                prompt = self.prompt(self.jiwoo, focus)
                self.assertIn('(asked to keep private:', prompt)
                self.assertIn('Never reveal what you were asked to keep private', prompt)
                self.assertIn("if unclear, don't", prompt)
                self.assertEqual(server.life_store('The Man in a Suit').index(), {})

    def test_group_snapshot_and_third_party_fact_hints(self):
        source = server.append('Mystery', 'My name is Alex Carter.')
        present = {a['name'] for a in self.agents} | {'Mystery'}
        self.assertEqual(set(source['known_by']), present)
        for agent in self.agents:
            row = server.life_store(agent['name']).load_segment('people')[0]
            self.assertEqual(set(row['known_by']), present)
            self.assertEqual(row['source_channel'], 'group')
        focus = server.append('The Man in a Suit', 'What do you think of Mystery?', recipient='Ji-woo')
        self.assertIn('(The Man in a Suit knows — they were there)', self.prompt(self.jiwoo, focus))
        private = server.append('Mystery', 'I grew up beside the sea.', recipient='Ji-woo')
        server.life_store('Ji-woo').apply([fact(text='Mystery grew up beside the sea.')],
            source_id=private['id'], visible=[private], embed=False)
        prompt = self.prompt(self.jiwoo, focus)
        self.assertIn("(The Man in a Suit doesn't know this)", prompt)
        # Later arrival cannot see a witnessed group message retroactively.
        self.assertEqual(life_memory.visible_messages([source], 'Newcomer'), [])

    def test_public_reply_accounts_for_every_listener(self):
        server.append('Mystery', 'My name is Alex.', recipient='Ji-woo')
        focus = server.append('Mystery', 'Ji-woo, how are you?')
        prompt = self.prompt(self.jiwoo, focus)
        self.assertIn("The Man in a Suit doesn't know his name is Alex", prompt)
        self.assertIn("Kim Min-jun doesn't know his name is Alex", prompt)

    def test_legacy_source_inference_unknown_fallback_and_untrusted_actor_fields(self):
        store = server.life_store('Ji-woo')
        store.apply([fact()], source_id='1', embed=False)
        path = store.directory / 'people.json'
        rows = json.loads(path.read_text())
        rows[0].pop('known_by')
        path.write_text(json.dumps(rows))
        record = store.load_segment('people')[0]
        source = dict(id='1', name='Mystery', to='Ji-woo', channel='dm', text='My name is Alex Carter.')
        self.assertEqual(knowledge.known_by(record, [source], 'Ji-woo'), {'Mystery', 'Ji-woo'})
        self.assertEqual(knowledge.known_by(record, [], 'Ji-woo'), {'Ji-woo'})
        self.assertIn("The Man in a Suit doesn't know", knowledge.prompt(store, [source], ['The Man in a Suit'], ['Mystery']))
        hidden = dict(source, id='2', to='The Man in a Suit')
        store.apply([fact(text='Another private fact.', known_by=['The Man in a Suit'], source_id='2', secret=True)],
                    source_id='missing', visible=[hidden], embed=False)
        self.assertEqual(store.load_segment('people')[-1]['known_by'], ['Ji-woo'])
        self.assertNotIn('secret', store.load_segment('people')[-1])

    def test_backfill_and_sweep_publish_source_provenance(self):
        source = dict(id='1', name='Mystery', channel='dm', to='Ji-woo', text="My name is Alex. Don't tell anyone.")
        output = json.dumps(dict(remember=[dict(fact(), source_id='1')]))
        extracted = backfill_memory.extract_messages(self.jiwoo, [source], invoke=lambda *args: output)
        backfill_memory.publish(server.life_store('Ji-woo', self.config), extracted)
        row = server.life_store('Ji-woo').load_segment('people')[0]
        self.assertEqual(row['source_person'], 'Mystery')
        self.assertEqual(row['known_by'], ['Ji-woo', 'Mystery'])
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
        agent = next(a for a in self.config['agents'] if a['name'] == 'Ji-woo')
        for autonomous in (False, True):
            with self.subTest(autonomous=autonomous):
                meta = dict(id='s12345678', participants=['Ji-woo', 'The Merchant'], title='Talk',
                            kind='hangout', location='garden', autonomous=autonomous, exchanges=2)
                messages = [dict(id=str(i), name=name, text=text, channel='scene',
                                 known_by=['Ji-woo', 'The Merchant']) for i, name, text in (
                                     (1, 'The Merchant', 'Ji-woo, hello.'), (2, 'Ji-woo', 'The Merchant, hello.'))]
                store, recalled, pins = self.manager.recall(agent, meta, messages, self.config)
                prompt = self.manager.prompt(agent, meta, messages, self.config, recalled, pins)
                self.assertIn("haven't formed a score for The Merchant", prompt)
                self.assertIn('"The Merchant": "(no score yet)"', prompt)
                self.assertIn('The Merchant knew Mystery before this room', prompt)
                self.assertNotIn('Alex', prompt)
                server.relationships.save('Ji-woo', {'The Merchant': dict(like=30, dislike=0)})
                prompt = self.manager.prompt(agent, meta, messages, self.config, recalled, pins)
                self.assertNotIn("haven't formed a score for The Merchant", prompt)
                server.relationships.save('Ji-woo', {})

    def test_scene_and_meetup_prompts_share_knowledge_rules_and_markers(self):
        server.append('Mystery', "My name is Alex. Don't reveal it in group.", recipient='Ji-woo')
        agent = next(a for a in self.config['agents'] if a['name'] == 'Ji-woo')
        for autonomous in (False, True):
            with self.subTest(autonomous=autonomous):
                meta = dict(id='s12345678', participants=['Ji-woo', 'The Man in a Suit'], title='Talk', kind='hangout',
                            location='garden', autonomous=autonomous, exchanges=0)
                store, recalled, pins = self.manager.recall(agent, meta, [], self.config)
                prompt = self.manager.prompt(agent, meta, [], self.config, recalled, pins)
                self.assertIn("The Man in a Suit doesn't know his name is Alex", prompt)
                self.assertIn('Never reveal what you were asked to keep private', prompt)
                self.assertIn('(asked to keep private:', prompt)
                self.assertIn('(The Man in a Suit doesn\'t know this)', prompt)
        self.assertEqual(server.life_store('The Man in a Suit').index(), {})

    def test_acquaintance_in_scene_and_meetup_with_and_without_mystery(self):
        merchant = next(a for a in self.config['agents'] if a['name'] == 'The Merchant')
        human = dict(self.config['agents'][0], knows_mystery=merchant['knows_mystery'])
        for agent in (merchant, human):
            for autonomous, joined in ((False, False), (True, False), (True, True)):
                with self.subTest(name=agent['name'], autonomous=autonomous, joined=joined):
                    meta = dict(id='s12345678', participants=[agent['name'], 'The Man in a Suit'], title='Talk',
                                kind='hangout', location='garden', autonomous=autonomous,
                                mystery_joined=joined, exchanges=0)
                    _, recalled, pins = self.manager.recall(agent, meta, [], self.config)
                    prompt = self.manager.prompt(agent, meta, [], self.config, recalled, pins)
                    self.assertIn('PRIOR ACQUAINTANCE: You already know Mystery as Alex Carter, Mr Carter', prompt)
                    self.assertIn('address him as Sir', prompt)
                    self.assertNotIn('no personal name learned', prompt)
                    self.assertNotIn("Mystery's identity/age/gender are only", prompt)
                    self.assertNotIn("Mystery's identity, age and consent are only", prompt)
        self.assertEqual(server.life_store('The Man in a Suit').index(), {})

    def test_scene_posts_only_teach_participants(self):
        scene = self.manager.create(dict(participants=['Ji-woo', 'The Man in a Suit'], title='Talk', kind='hangout',
                                         location='garden', visibility='private'))
        posted = self.manager.append(scene['id'], 'Ji-woo', "Mystery's real name is Alex.")
        row = server.life_store('The Man in a Suit').load_segment('people')[0]
        self.assertEqual(row['known_by'], ['Ji-woo', 'Mystery', 'The Man in a Suit'])
        self.assertEqual(row['source_channel'], 'scene')
        self.assertEqual(row['source_person'], 'Ji-woo')
        self.assertEqual(row['source_id'], posted['id'])
        self.assertEqual(server.life_store('Kim Min-jun').index(), {})

    def test_scene_summary_provenance_and_meetup_fallback(self):
        scene = self.manager.create(dict(participants=['Ji-woo', 'The Man in a Suit'], title='Talk', kind='hangout',
                                         location='garden', visibility='private'))
        self.manager.jobs[scene['id']] = dict(operation='end')
        self.manager.summarize(scene['id'])
        for name in ('Ji-woo', 'The Man in a Suit'):
            rows = server.life_store(name).load_segment('events')
            summary = next(r for r in rows if r['source_id'] == scene['id'])
            self.assertEqual(summary['known_by'], ['Ji-woo', 'Mystery', 'The Man in a Suit'])
            self.assertEqual(summary['source_channel'], 'scene')
        scene_id = self.start(source='Kim Min-jun', target='Grandpa Park')
        self.manager.append(scene_id, 'Kim Min-jun', 'Grandpa Park, Mystery asked us not to tell anyone about the gift.')
        with patch.object(self.manager, 'summarize', side_effect=ValueError('bad summary')):
            with self.assertLogs('meetups', level='ERROR'):
                self.meetups.close(scene_id)
        for name in ('Kim Min-jun', 'Grandpa Park'):
            summary = next(r for r in server.life_store(name).load_segment('events') if r['source_id'] == scene_id)
            self.assertEqual(summary['known_by'], ['Grandpa Park', 'Kim Min-jun'])
            self.assertEqual(summary['source_channel'], 'scene')
            self.assertTrue(summary['secret'])


class AlarmKnowledgeTests(HermeticTestCase):
    setUp = test_timekeeper.TimekeeperTests.setUp
    provider = test_timekeeper.TimekeeperTests.provider

    def test_acquaintance_in_room_and_scene_alarm_prompts(self):
        agent = next(a for a in self.config['agents'] if a['name'] == 'Ji-woo')
        agent['knows_mystery'] = dict(names=['Alex Carter', 'Mr Carter'], address='Sir',
                                    relation='your longtime friend')
        alarm = dict(to='Mystery', channel='dm', intent='Say hello', created_at=self.tk.clock().isoformat())
        self.reply = dict(message='Hello, Sir.', memory='We talked.', to='Mystery')
        self.tk.room_turn(alarm, agent, self.config)
        scene = self.manager.create(dict(participants=['Ji-woo'], title='Talk', kind='hangout',
                                         location='garden', visibility='private'))
        self.reply['to'] = None
        self.tk.scene_turn(alarm, agent, scene, self.config)
        self.assertEqual(len(self.prompts), 2)
        for _, prompt in self.prompts:
            self.assertIn('PRIOR ACQUAINTANCE: You already know Mystery as Alex Carter, Mr Carter', prompt)
            self.assertNotIn('An unidentified speaker', prompt)
            self.assertNotIn('no personal name learned', prompt)

    def test_room_and_scene_alarm_prompt_and_write_provenance(self):
        server.append('Mystery', 'My name is Alex.', recipient='Ji-woo')
        agent = next(a for a in self.config['agents'] if a['name'] == 'Ji-woo')
        alarm = dict(to='The Man in a Suit', channel='dm', intent='Ask The Man in a Suit for advice', created_at=self.tk.clock().isoformat())
        self.reply = dict(message="Alex — that's Mystery's real name — asked me about the garden.",
                          memory='I asked for advice.', to='The Man in a Suit', remember=[fact(text='I asked The Man in a Suit for advice.')])
        posted = self.tk.room_turn(alarm, agent, self.config)
        prompt = self.prompts[-1][1]
        self.assertIn("The Man in a Suit doesn't know his name is Alex", prompt)
        self.assertIn('Never reveal what you were asked to keep private', prompt)
        self.assertEqual(server.life_store('The Man in a Suit').load_segment('people')[0]['source_id'], posted['id'])
        row = next(r for r in server.life_store('Ji-woo').load_segment('people') if r['text'] == 'I asked The Man in a Suit for advice.')
        self.assertEqual(row['source_channel'], 'dm')
        self.assertEqual(row['known_by'], ['Ji-woo', 'The Man in a Suit'])
        scene = self.manager.create(dict(participants=['Ji-woo', 'The Man in a Suit'], title='Talk', kind='hangout',
                                         location='garden', visibility='private'))
        self.reply = dict(message="Mystery's real name is Alex.", memory='We talked in person.', to=None,
                          remember=[fact(text='I spoke with The Man in a Suit in the garden.')])
        posted = self.tk.scene_turn(alarm, agent, scene, self.config)
        self.assertIn('KNOWLEDGE AND CONFIDING:', self.prompts[-1][1])
        row = next(r for r in server.life_store('Ji-woo').load_segment('people') if 'I spoke with The Man in a Suit' in r['text'])
        self.assertEqual(row['source_channel'], 'scene')
        self.assertEqual(row['known_by'], ['Ji-woo', 'Mystery', 'The Man in a Suit'])


class AcquaintanceConfigTests(HermeticTestCase):
    def test_load_config_rejects_invalid_shapes(self):
        config = server.load_config()
        invalid = (None, False, [], 'Alex', {}, {'names': []}, {'names': 'Alex'},
                   {'names': [None]}, {'names': ['']}, {'names': ['  ']}, {'names': [42]},
                   {'names': ['Alex'], 'address': None}, {'names': ['Alex'], 'address': ''},
                   {'names': ['Alex'], 'address': []}, {'names': ['Alex'], 'relation': 3},
                   {'names': ['Alex'], 'relation': '  '})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'agents.json'
            with patch.object(server, 'CONFIG', path):
                for value in invalid:
                    with self.subTest(value=value):
                        config['agents'][0]['knows_mystery'] = value
                        path.write_text(json.dumps(config))
                        with self.assertRaisesRegex(ValueError, 'knows_mystery'):
                            server.load_config()
                for value in ({'names': ['Alex']}, {'names': ['Alex'], 'address': 'Sir',
                                                    'relation': 'a regular customer'}):
                    config['agents'][0]['knows_mystery'] = value
                    path.write_text(json.dumps(config))
                    self.assertEqual(server.load_config()['agents'][0]['knows_mystery'], value)


if __name__ == '__main__':
    unittest.main()
