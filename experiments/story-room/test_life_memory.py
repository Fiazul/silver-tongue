import json
from pathlib import Path
import tempfile
import unittest
from test_support import HermeticTestCase
from unittest.mock import patch

import backfill_memory
import engagement
import image_refs
import life_memory
import server


def record(segment='people', text='Mystery is 26 by their own clock, 340 Earth years.', **changes):
    value = dict(segment=segment, about=['Mystery'], text=text, tags=['age', 'old', 'years', 'birthday', '26'], importance=5, status='open')
    value.update(changes)
    return value


class LifeMemoryTests(HermeticTestCase):
    def setUp(self):
        from datetime import datetime, timezone
        clock_patch = patch.object(server.TIMEKEEPER, 'clock', return_value=datetime(2026, 10, 16, 6, tzinfo=timezone.utc))
        clock_patch.start()
        self.addCleanup(clock_patch.stop)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for module, field, path in ((server, 'MEMORY', 'memories.json'), (server, 'LOG', 'messages.jsonl'),
                                     (server, 'RESETS', 'character-resets.json'), (server.relationships, 'FILE', 'relationships.json')):
            patcher = patch.object(module, field, self.root / path)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.store = server.life_store('Iris')
        self.agents = server.load_config()['agents']
        self.iris = next(a for a in self.agents if a['name'] == 'Iris')
        server.STATE.update(speaker=None, turns=0, limit=12)
        for state in (server.PROVIDER_BREAKS, server.PROVIDER_EXHAUSTED, server.PROVIDER_TRIALS, server.CHARACTER_BREAKS):
            patcher = patch.dict(state, {}, clear=True)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(server.ACTIVE.clear)
        self.addCleanup(server.WAKE.clear)
        self.addCleanup(lambda: server.STATE.update(speaker=None, turns=0, limit=12))

    def test_validation_deduplication_routing_and_resolution(self):
        self.store.apply([record('worries', 'Is Mystery safe?', tags=['safe', 'worry'], importance=4)], source_id='1')
        thread = self.store.load_segment('worries')[0]
        self.store.apply([record(), record(text='MYSTERY IS 26 BY THEIR OWN CLOCK; 340 EARTH YEARS!'), record('unknown')], [thread['id']], source_id='2')
        self.assertEqual(len(self.store.load_segment('people')), 1)
        self.assertEqual(self.store.load_segment('worries')[0]['status'], 'resolved')
        self.assertEqual(self.store.load_segment('people')[0]['source_id'], '2')
        for segment in life_memory.SEGMENTS:
            self.assertTrue((self.store.directory / (segment + '.json')).exists())
        before = len(self.store.index()['records'])
        for bad in (None, {}, 'bad', {'segment': []}, record(about='Mystery'), record(tags=[4]), record(importance=True), record(status='oops'), record(text='')):
            self.store.apply([bad], [None, {}])
        self.store.apply('bad', 'bad')
        self.assertEqual(len(self.store.index()['records']), before)

    def test_recall_age_first_and_all_segments_are_scored(self):
        self.store.apply([record(), record('gifts', 'Mystery gave a blue jewel.', tags=['gift', 'jewel'], importance=2),
                          record('events', 'Dinner with Nora.', about=['Nora'], tags=['date'], importance=2)])
        with patch.object(self.store, 'load_segment', wraps=self.store.load_segment) as load:
            rows, _ = self.store.retrieve('do you remember my age iris?', {'Mystery', 'Iris'})
            self.assertEqual(rows[0][0], 'people')
            self.assertIn('26', rows[0][1]['text'])
            self.assertEqual({c.args[0] for c in load.call_args_list}, set(life_memory.SEGMENTS))

    def test_picture_recall_beats_unrelated_pins(self):
        self.store.apply([record('events', 'Mystery shared candid shots that Vella captured, sent as an image attachment.',
                                 tags=['camera', 'candid shots', 'image', 'photos', 'vella'], importance=2)], source_id='1')
        for i in range(4):
            self.store.apply([record('worries', f'Mystery has not supplied timeline proof {i}. ' +
                'Iris remains concerned about the shield measurement, the reactor limit, the laboratory exhibit, '
                'and whether the vessel crew can substantiate the technical claims made during their discussion. '
                'The matter remains unresolved and she is waiting for clarification.', tags=['timeline'], importance=5)])
        focus = dict(name='Mystery', to='Iris', channel='dm', text='you dont remember the vella picture i shared?')
        block = life_memory.retrieval_block(self.store, [focus], focus)
        self.assertIn('candid shots', block.splitlines()[0])

    def photo_fixture(self, name='Iris'):
        upload_patch = patch.object(server.chat_images, 'DIRECTORY', self.root / 'uploads')
        upload_patch.start()
        self.addCleanup(upload_patch.stop)
        import base64
        paths = [server.chat_images.store('data:image/png;base64,' + base64.b64encode(
            b'\x89PNG\r\n\x1a\nfixture' + bytes([i])).decode()) for i in range(4)]
        store = server.life_store(name)
        store.apply([record('events', 'Mystery shared candid shots that Vella captured, sent as an image attachment.',
                            tags=['camera', 'candid shots', 'image', 'photos', 'vella'], importance=2)], source_id='1')
        messages = [dict(id='1', name='Mystery', kind='chat', channel='dm', to=name,
                         text='She captured these.', attachments=paths[:3])]
        messages += [dict(id=str(i), name='Theo', kind='chat', channel='group', text='Good morning.') for i in range(2, 28)]
        messages.append(dict(id='28', name='Mystery', kind='chat', channel='dm', to=name,
                             text='A recent unrelated photograph.', attachments=[paths[3]]))
        focus = dict(id='29', name='Mystery', kind='chat', channel='dm', to=name,
                     text='you dont remember the vella picture i shared?')
        return store, messages + [focus], focus, paths

    def test_picture_recall_selects_old_source_images_with_cap_and_label(self):
        store, messages, focus, paths = self.photo_fixture()
        context = life_memory.retrieval_context(store, messages, focus)
        self.assertIn('candid shots', context.records[0][1]['text'])
        self.assertEqual(context.images, paths[:2])
        self.assertEqual(server.turn_images(messages, context), [Path(p) for p in paths[:2]])
        self.assertIn('[image #' + image_refs.token_for(paths[0])[4:] + ': photo from Mystery]', context.block)

    def test_recall_image_visibility_for_every_character(self):
        for actor in self.agents:
            with self.subTest(actor=actor['name']):
                store, messages, focus, paths = self.photo_fixture(actor['name'])
                context = life_memory.retrieval_context(store, messages, focus)
                self.assertEqual(context.images, paths[:2])
                messages[0]['to'] = 'NobodyElse'
                context = life_memory.retrieval_context(store, messages, focus)
                self.assertNotIn(paths[0], context.images)
                self.assertNotIn(paths[1], context.images)
                self.assertNotIn('[image #' + image_refs.token_for(paths[0])[4:] + ': photo from Mystery]', context.block)

    def test_pre_reset_and_hidden_focus_cannot_recall_images(self):
        _, messages, focus, paths = self.photo_fixture()
        store = life_memory.Store(self.root / 'reset-life', 'Iris', boundary=10)
        store.apply([record('events', 'Mystery shared a Vella photo.', tags=['image', 'vella'], importance=3)], source_id='1')
        context = life_memory.retrieval_context(store, messages, focus)
        self.assertNotIn(paths[0], context.images)
        hidden = dict(focus, to='Theo')
        context = life_memory.retrieval_context(store, [messages[0], hidden], hidden)
        self.assertFalse(context.recall)
        self.assertEqual(context.images, [])

    def test_attachment_only_evidence_and_irrelevant_evidence_threshold(self):
        message = dict(id='1', name='Mystery', to='Iris', channel='dm', text='Here you go.', attachments=['/tmp/fixture.png'])
        focus = dict(name='Mystery', to='Iris', channel='dm', text='Do you remember the picture I showed you?')
        context = life_memory.retrieval_context(self.store, [message, focus], focus)
        self.assertEqual(context.images, ['/tmp/fixture.png'])
        self.assertIn('[image #' + image_refs.token_for('/tmp/fixture.png')[4:] + ': photo from Mystery]', context.block)
        banter = [dict(name='Nora', channel='group', text='Mina, coffee is ready.'),
                  dict(name='Mina', channel='group', text='Iris, do you remember Mystery?')]
        self.assertEqual(life_memory.evidence(banter, 'do you remember our date?'), [])
        message['text'] = 'A photo from our date.'
        focus['text'] = 'Do you remember our date?'
        self.assertEqual(life_memory.retrieval_context(self.store, [message, focus], focus).images,
                         ['/tmp/fixture.png'])

    def test_non_recall_keeps_router_and_recent_image_priority(self):
        store, messages, focus, paths = self.photo_fixture()
        focus['text'] = 'Nice camera!'
        context = life_memory.retrieval_context(store, messages, focus)
        self.assertFalse(context.recall)
        self.assertEqual(server.turn_images(messages, context)[0], Path(paths[3]))
        with patch.object(store, 'load_segment', wraps=store.load_segment) as load:
            store.retrieve('how old?', {'Mystery'})
        self.assertEqual([c.args[0] for c in load.call_args_list], ['people'])

    def test_recall_routes_are_boosts_and_old_index_synonyms_need_no_rebuild(self):
        self.store.apply([record('events', 'Mystery captured the observatory.', tags=['picutre'], importance=2)])
        # Simulate an index written with the previous tokenizer; recall reads texts/tags.
        index = self.store.index()
        index['tags'] = {}
        self.store._write('index.json', index)
        rows, _ = self.store.retrieve('did I show you a picture?', {'Mystery'})
        self.assertEqual(rows[0][0], 'events')
        self.assertIn('observatory', rows[0][1]['text'])

    def test_recall_modes_and_synonyms(self):
        for text in ('remember our date', 'I forgot that', 'did you forget?', 'recall our walk',
                     'did I send that?', 'did I tell you?', 'did I give you something?', 'did I show it?',
                     'you know what I mean', 'what did i give you?', 'remeber the picutre?'):
            self.assertTrue(life_memory.is_recall_query(text), text)
        for word in ('picture', 'pic', 'pics', 'photo', 'photos', 'image', 'shot', 'snapshot',
                     'selfie', 'candid', 'camera', 'screenshot', 'picutre'):
            self.assertEqual(life_memory.tokens(word), ['image'])
        self.assertEqual(life_memory.tokens('gift present gave giving received'), ['gift'] * 5)
        self.assertEqual(life_memory.tokens('date outing trip went out'), ['date'] * 4)

    def test_recall_expands_event_details_and_caps_background_pins(self):
        for r in [record('milestones', 'Our first date was at Antarctica under the aurora.', tags=['date', 'antarctica', 'aurora']),
                  record('events', 'Mystery photographed the aurora at Antarctica.', tags=['aurora', 'photo'], importance=4)]:
            self.store.apply([r])
        for i in range(4):
            self.store.apply([record('worries', f'Mystery owes shield proof {i}.', tags=['shield'], importance=5)])
        focus = dict(name='Mystery', to='Iris', channel='dm', text='do you remember our date?')
        context = life_memory.retrieval_context(self.store, [focus], focus)
        self.assertEqual([s for s, _ in context.records[:2]], ['milestones', 'events'])
        self.assertLessEqual(sum(s == 'worries' for s, _ in context.records), 2)
        # Recent unrelated messages do not change the query or its ranking.
        noise = [dict(name='Theo', channel='group', text='Do you know how old the shield is?')]
        self.assertEqual(life_memory.retrieval_context(self.store, noise + [focus], focus).records, context.records)

    def test_run_turn_passes_recalled_images_to_actor_and_fallback(self):
        _, messages, _, paths = self.photo_fixture()
        server.LOG.write_text(''.join(json.dumps(m) + '\n' for m in messages))
        reply = json.dumps(dict(message='I remember those candid shots.', memory='I remember our outing.', to='Mystery'))
        config = {'agents': [self.iris], 'fallback': {'provider': 'cursor', 'model': 'auto'}}
        with patch.object(server, 'choose_next', return_value='Iris'), \
             patch.object(server, 'invoke', side_effect=[RuntimeError('primary unavailable'), reply]) as invoke:
            server.ACTIVE.set()
            server.run_turn(config)
        self.assertEqual(invoke.call_count, 2)
        for call in invoke.call_args_list:
            self.assertEqual(call.kwargs['images'], [Path(p) for p in paths[:2]])
            self.assertIn('candid shots', call.args[1])
            self.assertIn('ACTUAL IMAGE INPUTS', call.args[1])
        self.assertEqual(server.history()[-1]['text'], 'I remember those candid shots.')

    def test_memory_prompt_stays_in_world_and_references_are_only_trailing(self):
        self.store.apply([record()])
        prompt = server.make_prompt(self.iris, [], self.agents)
        for forbidden in ('YOUR LASTING PRIVATE CHARACTER NOTES', 'your own saved memory',
                          'Your notes are', 'these records and evidence', 'Keep notes about', 'memory is saved locally'):
            self.assertNotIn(forbidden, prompt)
        self.assertIn('Speak from memory in first person', prompt)
        self.assertIn('Your memories that come to mind now:', prompt)
        self.assertIn('Never say the (#reference) markers aloud', prompt)
        block = life_memory.retrieval_block(self.store, [dict(name='Mystery', text='age', channel='dm', to='Iris')])
        self.assertTrue(block.splitlines()[0].endswith('(#' + self.store.load_segment('people')[0]['id'] + ')'))

    def test_open_worries_milestones_and_importance_five_are_pinned(self):
        self.store.apply([record('worries', 'Did Vella air hold?', tags=['air'], importance=3),
                          record('milestones', 'Our first walk.', tags=['walk'], importance=4),
                          record('important', 'Keep the blue stone.', tags=['stone'], importance=5)])
        block = life_memory.retrieval_block(self.store, [{'name': 'Mystery', 'text': 'Hello', 'channel': 'dm', 'to': 'Iris'}])
        for expected in ('Vella air', 'first walk', 'blue stone'):
            self.assertIn(expected, block)
        self.assertLessEqual(len(block), 1600)

    def test_counterpart_bond_pins_survive_zero_budget_and_do_not_include_other_people(self):
        self.store.apply([record('feelings', 'I love Mystery and want to repair our bond.', importance=2),
                          record('milestones', 'Our first shared voyage.', importance=4),
                          record('feelings', 'I enjoy painting with Mina.', about=['Mina'], importance=5),
                          record('milestones', 'An unimportant passing joke.', importance=3)], limit=4, embed=False)
        for i in range(6):
            self.store.apply([record('milestones', f'Our shared experience {i}.', importance=5)], embed=False)
        anchors = self.store.prompt_anchors('Mystery')
        self.assertEqual(len(anchors), 3)
        self.assertTrue(any(s == 'feelings' for s, _ in anchors))
        self.assertTrue(all('Mystery' in r['about'] for _, r in anchors))
        self.assertTrue(all(r['importance'] >= 4 for s, r in anchors if s == 'milestones'))
        focus = dict(name='Mystery', text='hello', channel='dm', to='Iris')
        recalled = life_memory.retrieval_context(self.store, [focus], focus, budget=0)
        for _, value in anchors:
            self.assertIn(value['text'], recalled.block)
        self.assertNotIn('painting with Mina', recalled.block)

    def test_repeated_sleep_question_adds_prompt_directive(self):
        messages = [dict(name='Iris', to='Mystery', channel='dm', text=text) for text in (
            'And I still need a yes or no on sleep.',
            'Ryoma, if I forgot something, tell me what it was. And the sleep question still stands: yes or no?',
            'Honestly, not much, Ryoma. Did you sleep? Yes or no.',
            "Pick me up where? I'm not getting in a car with you until you tell me honestly whether you slept. And no doctor before you explain the Voyager thing.",
            'Explain everything once we meet? Ryoma, no. Did you sleep? Yes or no.',
            "You're 26 on your own clock. Now, did you sleep? Yes or no.",
        )]
        focus = dict(name='Mystery', to='Iris', channel='dm', text='how about i explain everything once we meet !')
        prompt = server.make_prompt(self.iris, messages + [focus], self.agents, focus)
        self.assertIn('YOU ALREADY ASKED Mystery ABOUT: sleep.', prompt)
        self.assertIn(frozenset({'sleep'}), server.already_asked_topics(self.iris, messages, self.agents)['Mystery'])
        self.assertIn("An unanswered question is not a precondition for the relationship; don't hold plans hostage to it.", prompt)

    def question_fixture(self, person='Mystery', channel='dm', asks=('Did you sleep?', 'I still need a yes or no on sleep.')):
        messages = [dict(id=str(index + 1), kind='chat', name='Iris', to=person if channel == 'dm' else None,
                         channel=channel, text=text if channel == 'dm' else f'@{person} {text}')
                    for index, text in enumerate(asks)]
        focus = dict(id='10', kind='chat', name=person, to='Iris' if channel == 'dm' else None,
                     channel=channel, text='I will pick you up in 10 mins' if channel == 'dm' else '@Iris let us meet')
        return messages + [focus], focus

    def test_single_ask_and_repetition_within_one_message_have_no_directive(self):
        for asks in (('Did you sleep?',), ('Did you sleep? Tell me whether you slept. Yes or no?',)):
            messages, focus = self.question_fixture(asks=asks)
            self.assertEqual(server.already_asked_topics(self.iris, messages, self.agents), {})
            self.assertNotIn('YOU ALREADY ASKED', server.make_prompt(self.iris, messages, self.agents, focus))

    def test_other_counterparts_and_speakers_do_not_count(self):
        messages, focus = self.question_fixture(asks=('Did you sleep?',))
        for person in ('Theo', 'Mystery'):
            other = dict(name='Theo' if person == 'Mystery' else 'Iris', to=person, channel='dm', text='Did you sleep?')
            self.assertEqual(server.already_asked_topics(self.iris, [other] + messages, self.agents), {})
        other_thread, _ = self.question_fixture(person='Theo')
        prompt = server.make_prompt(self.iris, other_thread + messages, self.agents, focus)
        self.assertNotIn('YOU ALREADY ASKED', prompt)

    def test_every_character_and_counterpart_in_dm_and_group(self):
        for actor in self.agents:
            for person in ['Mystery'] + [a['name'] for a in self.agents if a != actor]:
                for channel in ('dm', 'group'):
                    with self.subTest(actor=actor['name'], person=person, channel=channel):
                        messages, focus = self.question_fixture(person, channel)
                        for message in messages[:-1]:
                            message['name'] = actor['name']
                        focus['to'] = actor['name'] if channel == 'dm' else None
                        topics = server.already_asked_topics(actor, messages, self.agents)
                        self.assertEqual(topics[person], [frozenset({'sleep'})])

    def test_group_reply_links_targets_and_multi_address_scoping(self):
        parent = dict(id='0', name='Mystery', channel='group', text='Hello Iris')
        messages = [parent] + [dict(id=str(i), name='Iris', channel='group', reply_to='0', text='Did you sleep?')
                               for i in (1, 2)]
        self.assertEqual(server.already_asked_topics(self.iris, messages, self.agents)['Mystery'], [frozenset({'sleep'})])
        for message in messages[1:]:
            message.pop('reply_to')
            message['targets'] = ['Mystery']
        self.assertIn('Mystery', server.already_asked_topics(self.iris, messages, self.agents))
        for message in messages[1:]:
            message['text'] = '@Mystery did you sleep? @Theo tell me about the Voyager reactor.'
            message.pop('targets')
        topics = server.already_asked_topics(self.iris, messages, self.agents)
        self.assertEqual(topics['Mystery'], [frozenset({'sleep'})])
        self.assertEqual(topics['Theo'], [frozenset({'voyager', 'reactor'})])

    def test_six_message_window_and_reset_end_old_repetition(self):
        messages, focus = self.question_fixture()
        messages[-1:-1] = [dict(name='Iris', to='Mystery', channel='dm', text='I like this place.') for _ in range(6)]
        self.assertEqual(server.already_asked_topics(self.iris, messages, self.agents), {})
        messages, focus = self.question_fixture()
        server.RESETS.write_text(json.dumps({'Iris': 2}))
        self.assertEqual(server.already_asked_topics(self.iris, messages, self.agents), {})

    def test_reactor_and_logs_demands_use_shared_topic_tokens(self):
        for asks, expected in (
                (('Tell me about the Voyager reactor.', 'Answer me about the reactor on Voyager.'), {'voyager', 'reactor'}),
                (("I still need Vella's logs.", "Tell me about Vella's log."), {'log'}),
                (('Did you sleep?', "I'm not getting in a car until you tell me whether you slept."), {'sleep'})):
            with self.subTest(asks=asks):
                messages, _ = self.question_fixture(asks=asks)
                self.assertEqual(server.already_asked_topics(self.iris, messages, self.agents)['Mystery'], [frozenset(expected)])

    def test_worries_are_labeled_without_losing_recall_or_changing_records(self):
        self.store.apply([
            record('worries', 'Mystery has not answered clearly whether he slept.', tags=['sleep'], importance=3),
            record('worries', 'Mystery may miss home.', tags=['home'], importance=3),
            record('worries', 'Theo has not slept.', about=['Theo'], tags=['sleep'], importance=3),
            record('worries', 'Mystery slept yesterday.', tags=['sleep'], importance=5, status='resolved'),
        ])
        before = self.store.load_segment('worries')
        messages, focus = self.question_fixture()
        focus['text'] = 'Do you remember what you were worried about, and whether Theo slept?'
        block = life_memory.retrieval_block(self.store, messages, focus,
            already_asked={'Mystery': [frozenset({'sleep'})]}, names=['Iris', 'Mystery', 'Theo'])
        self.assertIn('whether he slept. (asked already — let it rest unless they bring it up)', block)
        self.assertIn('may miss home. (on your mind — not a question to re-ask each turn)', block)
        self.assertIn('Theo has not slept. (on your mind — not a question to re-ask each turn)', block)
        self.assertNotIn('yesterday. (asked already', block)
        self.assertEqual(before, self.store.load_segment('worries'))

    def test_initiative_worry_uses_same_labels(self):
        self.store.apply([record('worries', 'Mystery has not answered clearly whether he slept.', tags=['sleep'], importance=3)])
        direction = engagement.direction(self.iris, 'Mystery', self.store,
                                         {'Mystery': [frozenset({'sleep'})]}, ['Iris', 'Mystery'])
        self.assertIn('(asked already — let it rest unless they bring it up)', direction)
        self.assertNotIn('Pick up this open thread', direction)
        self.assertIn('(on your mind — not a question to re-ask each turn)',
                      engagement.direction(self.iris, 'Mystery', self.store))

    def test_correction_only_for_nagging_and_second_nag_still_posts(self):
        messages, focus = self.question_fixture()
        topics = server.already_asked_topics(self.iris, messages, self.agents)
        clean = ["I'll meet you outside.", "We can discuss sleep when you're ready.",
                 "I'll wait until you're ready to explain your sleep."]
        for first in ['Did you sleep? Yes or no.', 'I still need a yes or no on sleep.',
                      "I'm not coming until you tell me whether you slept."] + clean:
            with self.subTest(first=first):
                replies = [dict(message=first, memory='We are meeting.', to='Mystery'),
                           dict(message='See you in ten.', memory='We are meeting.', to='Mystery')]
                with patch.object(server, 'invoke', side_effect=[json.dumps(r) for r in replies]) as invoke:
                    result = server.serve_turn(self.iris, 'Prompt', [], {'agents': self.agents}, self.agents,
                                               focus, False, topics)
                self.assertEqual(invoke.call_count, 1 if first in clean else 2)
                self.assertEqual(result[0], first if first in clean else 'See you in ten.')
                if first not in clean:
                    self.assertIn('ALREADY-ASKED CORRECTION: rewrite without asking about sleep; reply to their latest message',
                                  invoke.call_args.args[1])
        # Exercise the real posting path: an uncooperative rewrite must still post.
        server.LOG.write_text(''.join(json.dumps(m) + '\n' for m in messages))
        nag = json.dumps(dict(message='Did you sleep?', memory='We are meeting.', to='Mystery'))
        with patch.object(server, 'invoke', return_value=nag) as invoke, \
             patch.object(server, 'choose_next', return_value='Iris'):
            server.ACTIVE.set()
            server.run_turn({'agents': self.agents})
        self.assertEqual(invoke.call_count, 2)
        self.assertEqual(server.history()[-1]['text'], 'Did you sleep?')
        self.assertEqual(server.history()[-1]['kind'], 'chat')

    def test_correction_failure_uses_fallback_with_fresh_budget(self):
        messages, focus = self.question_fixture()
        topics = server.already_asked_topics(self.iris, messages, self.agents)
        config = {'agents': self.agents, 'fallback': {'provider': 'cursor', 'model': 'auto'}}
        nag = json.dumps(dict(message='Did you sleep?', memory='We are meeting.', to='Mystery'))
        clean = json.dumps(dict(message='See you in ten.', memory='We are meeting.', to='Mystery'))
        with patch.object(server, 'invoke', side_effect=[nag, server.ProviderTimeout('timeout'), clean]) as invoke:
            result = server.serve_turn(self.iris, 'Prompt', [], config, self.agents, focus, False, topics)
        self.assertEqual(invoke.call_count, 3)
        self.assertEqual(result[0], 'See you in ten.')
        self.assertEqual(result[-1], 'cursor/auto')
        self.assertEqual(invoke.call_args_list[0].args[1], invoke.call_args_list[2].args[1])
        # The extra correction call is bounded to once even across providers.
        server.PROVIDER_BREAKS.clear()
        with patch.object(server, 'invoke', side_effect=[nag, server.ProviderTimeout('timeout'), nag]) as invoke:
            result = server.serve_turn(self.iris, 'Prompt', [], config, self.agents, focus, False, topics)
        self.assertEqual(invoke.call_count, 3)
        self.assertEqual(result[0], 'Did you sleep?')

    def test_public_nagging_and_different_recipient(self):
        topics = {'Mystery': [frozenset({'sleep'})]}
        _, focus = self.question_fixture(channel='group')
        self.assertEqual(server.nagging_topics('Did you sleep?', None, focus, topics, self.agents), topics['Mystery'])
        self.assertEqual(server.nagging_topics('@Mystery did you sleep?', None, None, topics, self.agents), topics['Mystery'])
        self.assertEqual(server.nagging_topics('@Theo did you sleep?', None, focus, topics, self.agents), [])
        self.assertEqual(server.nagging_topics('@Mystery see you soon. @Theo did you sleep?', None, focus, topics, self.agents), [])
        self.assertEqual(server.nagging_topics('Did you sleep?', 'Theo', focus, topics, self.agents), [])

    def test_transcript_evidence_visibility_reset_and_dated_snippets(self):
        messages = [dict(id='1', name='Mystery', text='age 99 OLD', channel='dm', to='Iris'),
                    dict(id='11', name='Mystery', text='age 77 SECRET', channel='dm', to='Theo'),
                    dict(id='12', name='Mystery', text='age 26 VISIBLE', channel='dm', to='Iris', time='2026-10-15T12:00:00Z'),
                    dict(id='13', name='Theo', text='age 28 PUBLIC', channel='group')]
        visible = life_memory.visible_messages(messages, 'Iris', 10)
        snippets = '\n'.join(life_memory.evidence(visible, 'my age?'))
        self.assertNotIn('OLD', snippets)
        self.assertNotIn('SECRET', snippets)
        self.assertIn('26 VISIBLE', snippets)
        self.assertIn('2026-10-15', snippets)
        self.assertIn('PUBLIC', snippets)
        self.store.apply([record()])
        server.RESETS.write_text(json.dumps({'Iris': 10}))
        self.assertEqual(server.life_store('Iris').retrieve('age', {'Mystery'})[0], [])
        server.life_store('Iris').apply([record(text='Mystery likes tea.', tags=['tea'])])
        self.assertEqual([r['text'] for r in server.life_store('Iris').load_segment('people')], ['Mystery likes tea.'])

    def test_raw_transcript_finds_old_age_fact_before_recent_questions(self):
        messages = [dict(name='Mystery', text='I am 26 by my own clock, physically and in lived years. 340 is Earth time, not birthdays.', channel='dm', to='Iris')]
        messages.extend(dict(name='Iris', text='What is your age?', channel='dm', to='Mystery') for _ in range(25))
        focus = dict(name='Mystery', text='do you remember my age?', channel='dm', to='Iris')
        block = life_memory.retrieval_block(self.store, messages + [focus], focus)
        self.assertIn('26', block.splitlines()[0])
        self.assertNotIn('do you remember', block)

    def test_run_turn_persists_and_resolves_and_drops_bad_records(self):
        self.store.apply([record('worries', 'Where is Mystery?', tags=['worry'], importance=3)])
        record_id = self.store.load_segment('worries')[0]['id']
        server.append('Mystery', 'Iris, do you remember my age?', recipient='Iris')
        reply = dict(message='26 by your own clock.', memory=' '.join(['word'] * 140), to='Mystery',
                     remember=[record(), {'segment': 'nonsense'}, {'segment': 'people', 'text': 42}], resolve=[record_id])
        with patch.object(server, 'invoke', return_value=json.dumps(reply)) as invoke:
            server.ACTIVE.set()
            server.run_turn({'agents': [self.iris]})
        self.assertEqual(invoke.call_count, 1)
        self.assertEqual(server.history()[-1]['text'], '26 by your own clock.')
        self.assertEqual(self.store.load_segment('worries')[0]['status'], 'resolved')
        self.assertEqual(len(self.store.load_segment('people')), 1)
        self.assertEqual(len(server.memories()['Iris'].split()), 120)

    def test_silence_and_ten_message_cooldown(self):
        messages = [dict(name='Iris', to='Mystery', channel='dm', text='hello', initiative=True)]
        self.assertFalse(engagement.may_initiate('Iris', 'Mystery', messages, self.store))
        messages.extend(dict(name='Theo', text='hi', channel='group') for _ in range(10))
        self.assertTrue(engagement.may_initiate('Iris', 'Mystery', messages, self.store))
        messages.append(dict(name='Iris', to='Mystery', channel='dm', text='checking in'))
        messages.extend(dict(name='Theo', text='hi', channel='group') for _ in range(10))
        self.assertFalse(engagement.may_initiate('Iris', 'Mystery', messages, self.store))
        messages.append(dict(name='Mystery', to='Iris', channel='dm', text='hello'))
        self.assertTrue(engagement.may_initiate('Iris', 'Mystery', messages, self.store))

    def test_contact_cooldown_counts_dm_during_another_persons_turn(self):
        messages = [dict(id='1', name='Theo', text='Hello Iris', channel='group'),
                    dict(id='2', name='Iris', to='Mystery', text='Hi', channel='dm', reply_to='1', initiative=False)]
        self.assertFalse(engagement.may_initiate('Iris', 'Mystery', messages, self.store))
        messages[-1].pop('reply_to')
        self.assertFalse(engagement.may_initiate('Iris', 'Mystery', messages, self.store))

    def test_blocked_dm_is_never_made_public_and_direct_reply_allowed(self):
        for _ in range(2):
            server.append('Iris', 'hi', recipient='Mystery', initiative=True)
        server.append('Theo', 'hello everyone')
        reply = json.dumps(dict(message='PRIVATE DRAFT', memory='I miss Mystery.', to='Mystery'))
        before = len(server.history())
        with patch.object(server, 'invoke', return_value=reply):
            server.ACTIVE.set()
            server.run_turn({'agents': [self.iris]})
            self.assertEqual(len(server.history()), before)
            server.append('Mystery', 'Hi Iris', recipient='Iris')
            server.run_turn({'agents': [self.iris]})
            self.assertEqual(server.history()[-1]['channel'], 'dm')
            self.assertEqual(server.history()[-1]['text'], 'PRIVATE DRAFT')

    def test_blocked_contacts_skip_without_fallback_or_break(self):
        for target in ('Mystery', 'Mina'):
            for use_fallback in (False, True):
                with self.subTest(target=target, fallback=use_fallback):
                    server.LOG.unlink(missing_ok=True)
                    server.STATE.update(speaker=None, turns=0)
                    self.store.apply([record('boundaries', f'{target} asked Iris for space.',
                                             about=[target, 'Iris'], tags=['space'])])
                    reply = dict(message='PRIVATE DRAFT', memory='Do not save this draft.', to=target,
                                 scores={target: {'like': 150, 'dislike': 0}}, remember=[record()])
                    config = {'agents': [self.iris, next(a for a in self.agents if a['name'] == 'Mina')],
                              'fallback': {'provider': 'cursor', 'model': 'auto'}}
                    responses = [RuntimeError('primary crashed'), json.dumps(reply)] if use_fallback else [json.dumps(reply)]
                    with patch.object(server, 'choose_next', return_value='Iris'), \
                         patch.object(server, 'invoke', side_effect=responses) as invoke, \
                         patch.object(server, 'record_failure', wraps=server.record_failure) as failure, \
                         patch.object(server, 'remember') as remember, \
                         patch.object(server.relationships, 'save') as scores, \
                         patch.object(server.life_memory.Store, 'apply') as apply:
                        server.ACTIVE.set()
                        server.run_turn(config)
                    self.assertEqual(invoke.call_count, 2 if use_fallback else 1)
                    self.assertEqual(failure.call_count, 1 if use_fallback else 0)
                    self.assertEqual(server.history(), [])
                    self.assertEqual(server.STATE['reason'], f'Iris is giving {target} space.')
                    self.assertEqual(server.STATE['turns'], 0)
                    self.assertIsNone(server.STATE['speaker'])
                    self.assertTrue(server.ACTIVE.is_set())
                    self.assertEqual(server.CHARACTER_BREAKS, {})
                    self.assertEqual(server.PROVIDER_BREAKS, {})
                    self.assertEqual(server.PROVIDER_EXHAUSTED, {})
                    remember.assert_not_called()
                    scores.assert_not_called()
                    apply.assert_not_called()

    def test_contact_boundary_allows_direct_replies(self):
        mina = next(a for a in self.agents if a['name'] == 'Mina')
        for target in ('Mystery', 'Mina'):
            for channel in ('group', 'dm'):
                with self.subTest(target=target, channel=channel):
                    server.LOG.unlink(missing_ok=True)
                    server.STATE.update(speaker=None, turns=0)
                    self.store.apply([record('boundaries', f'{target} asked Iris for space.',
                                             about=[target, 'Iris'], tags=['space'])])
                    incoming = server.append(target, '@Iris hello', recipient='Iris' if channel == 'dm' else None)
                    reply = json.dumps(dict(message='Hello back.', memory='I answered a direct message.', to=target,
                                            scores={target: {'like': 150, 'dislike': 0}}))
                    with patch.object(server, 'choose_next', return_value='Iris'), \
                         patch.object(server, 'invoke', return_value=reply) as invoke:
                        server.ACTIVE.set()
                        server.run_turn({'agents': [self.iris, mina],
                                         'fallback': {'provider': 'cursor', 'model': 'auto'}})
                    invoke.assert_called_once()
                    self.assertEqual(server.history()[-1]['text'], 'Hello back.')
                    self.assertEqual(server.history()[-1]['to'], target)
                    self.assertEqual(server.history()[-1]['reply_to'], incoming['id'])
                    self.assertEqual(server.STATE['turns'], 1)
                    self.assertEqual(server.CHARACTER_BREAKS, {})

    def test_cursor_served_turn_applies_memories_and_resolves_with_full_prompt(self):
        self.store.apply([record('worries', 'Where is Mystery?', tags=['worry'], importance=3)])
        worry_id = self.store.load_segment('worries')[0]['id']
        server.append('Mystery', 'PRIVATE OTHER', recipient='Theo')
        incoming = server.append('Mystery', 'Iris, I am 26 by my own clock.', recipient='Iris')
        reply = dict(message='Iris: 26 by your own clock.', memory=' '.join(['word'] * 140),
                     to='Mystery', remember=[record(), {'segment': 'nonsense'}], resolve=[worry_id])
        config = {'agents': [self.iris], 'fallback': {'provider': 'cursor', 'model': 'auto'}}
        with patch.object(server, 'invoke', side_effect=[RuntimeError('primary crashed'), json.dumps(reply)]) as invoke:
            server.ACTIVE.set()
            server.run_turn(config)
        self.assertEqual(invoke.call_count, 2)
        self.assertEqual(invoke.call_args_list[1].args[0]['provider'], 'cursor')
        primary_prompt, cursor_prompt = [call.args[1] for call in invoke.call_args_list]
        self.assertEqual(primary_prompt, cursor_prompt)
        for expected in ('WHAT YOU REMEMBER', 'Where is Mystery?', '"remember": []', '"resolve": []',
                         'each with segment', 'CONTACT LIMITS', 'IMMEDIATE REPLY PRIORITY'):
            self.assertIn(expected, cursor_prompt)
        self.assertNotIn('PRIVATE OTHER', cursor_prompt)
        posted = server.history()[-1]
        self.assertEqual(posted['text'], '26 by your own clock.')
        self.assertEqual(posted['served_by'], 'cursor/auto')
        self.assertEqual(posted['channel'], 'dm')
        self.assertEqual(posted['to'], 'Mystery')
        saved = self.store.load_segment('people')
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]['source_id'], incoming['id'])
        self.assertEqual(saved[0]['time'], incoming['time'])
        self.assertEqual(saved[0]['known_by'], ['Iris', 'Mystery'])
        self.assertEqual(saved[0]['source_person'], 'Mystery')
        self.assertEqual(saved[0]['source_channel'], 'dm')
        self.assertEqual(self.store.load_segment('worries')[0]['status'], 'resolved')
        self.assertEqual(len(server.memories()['Iris'].split()), 120)
        self.assertEqual(server.STATE['turns'], 1)
        self.assertEqual(server.CHARACTER_BREAKS, {})

    def test_malformed_optional_memories_do_not_fail_primary_or_cursor_turns(self):
        for use_fallback in (False, True):
            for remember, resolve in (('bad', {}), ([None, {'segment': []}, record(about='Mystery')], [None, {}])):
                with self.subTest(fallback=use_fallback, remember=remember, resolve=resolve):
                    server.LOG.unlink(missing_ok=True)
                    server.STATE.update(speaker=None, turns=0)
                    reply = json.dumps(dict(message='Hello room.', memory='I greeted the room.',
                                            remember=remember, resolve=resolve))
                    responses = [RuntimeError('primary crashed'), reply] if use_fallback else [reply]
                    config = {'agents': [self.iris], 'fallback': {'provider': 'cursor', 'model': 'auto'}}
                    with patch.object(server, 'invoke', side_effect=responses) as invoke:
                        server.ACTIVE.set()
                        server.run_turn(config)
                    self.assertEqual(invoke.call_count, 2 if use_fallback else 1)
                    self.assertEqual([m['kind'] for m in server.history()], ['chat'])
                    self.assertEqual(server.history()[0]['text'], 'Hello room.')
                    self.assertEqual(server.STATE['turns'], 1)
                    self.assertEqual(server.CHARACTER_BREAKS, {})
                    self.assertEqual(self.store.index()['records'], {})

    def test_longing_weights_initiative_and_mystery_priority(self):
        agents = [a for a in self.agents if a['name'] in ('Iris', 'Theo', 'Milo')]
        server.relationships.save('Iris', {'Mystery': {'like': 150, 'dislike': 3}})
        messages = [dict(id=str(i), name='Milo' if i % 2 else 'Theo', text='hello', channel='group') for i in range(10)]
        self.assertEqual(server.choose_next(messages, agents), 'Iris')
        self.assertEqual(server.longing_for(self.iris, agents, messages)[2], 'Mystery')
        self.assertIn('YOUR HEART', engagement.direction(self.iris, 'Mystery', self.store))
        messages.append(dict(id='20', name='Mystery', text='@Theo question', channel='group'))
        self.assertEqual(server.choose_next(messages, agents), 'Theo')
        # Ordinary unfocused turns also give longing a selection weight.
        messages[-1] = dict(id='20', name='Theo', text='hello', channel='group', initiative=True)
        with patch.object(server.random, 'choices', return_value=['Iris']) as choose:
            self.assertEqual(server.choose_next(messages, agents), 'Iris')
            weights = choose.call_args.kwargs['weights']
            names = choose.call_args.args[0]
            self.assertGreater(weights[names.index('Iris')], weights[names.index('Milo')])

    def test_boundaries_and_unspoken_love_obey_preferences(self):
        scores = {'Mystery': {'like': 150, 'dislike': 3}, 'Theo': {'like': 150, 'dislike': 0}}
        config = server.load_config()
        heart = engagement.heart(self.iris, scores, self.agents, self.store, config)
        self.assertIn('Unspoken love: you love Mystery', heart)
        # Unknown Mystery gender (no config) never yields romantic love toward Mystery.
        self.assertNotIn('love Mystery', engagement.heart(self.iris, scores, self.agents, self.store))
        self.assertNotIn('love Theo', heart)
        self.store.apply([record('boundaries', 'Mystery asked Iris for space.', tags=['space'], importance=5)])
        self.assertFalse(engagement.may_initiate('Iris', 'Mystery', [], self.store))
        self.store.apply([record('boundaries', 'Mina said no to the red scarf.', about=['Mina'], tags=['scarf'], importance=2)])
        self.assertTrue(engagement.may_initiate('Iris', 'Mina', [], self.store))
        boundary = self.store.load_segment('boundaries')[0]
        # Mystery stated it: Iris alone cannot lift it, only Mystery's visible lifting message.
        self.store.apply([], [boundary['id']])
        self.assertFalse(engagement.may_initiate('Iris', 'Mystery', [], self.store))
        lifted = dict(id='99', name='Mystery', channel='dm', to='Iris', text='You can message me again, Iris.',
                      time='2999-01-01T00:00:00+00:00')
        self.store.apply([], [boundary['id']], visible=[lifted])
        self.assertTrue(engagement.may_initiate('Iris', 'Mystery', [], self.store))
        self.store.apply([record('milestones', 'Iris said I love you to Mystery.', about=['Iris', 'Mystery'], tags=['confession'])])
        self.assertNotIn('Unspoken love', engagement.heart(self.iris, scores, self.agents, self.store, config))
        mina = next(a for a in self.agents if a['name'] == 'Mina')
        self.assertNotIn('love Iris', engagement.heart(mina, {'Iris': {'like': 150, 'dislike': 0}}, self.agents, self.store))

    def test_each_character_and_segment_is_isolated(self):
        for agent in self.agents:
            store = server.life_store(agent['name'])
            for segment in life_memory.SEGMENTS:
                raw = record(segment, f"{agent['name']} remembers {segment}.", tags=[segment], importance=2)
                if segment in life_memory.LORE_ONLY_SEGMENTS:
                    # Chat extraction may never write the lore-only readout pool.
                    store.apply([raw])
                    self.assertEqual(store.load_segment(segment), [])
                    raw['retrieval_only'] = True
                store.apply([raw])
                self.assertEqual(len(store.load_segment(segment)), 1)
                self.assertIn(agent['name'], store.load_segment(segment)[0]['text'])
            self.assertEqual(len(store.index()['records']), len(life_memory.SEGMENTS))

    def test_cast_space_and_reset_remove_contact_restriction(self):
        self.store.apply([record('boundaries', 'Mina asked Iris for space.', about=['Mina', 'Iris'], tags=['space'])])
        self.assertFalse(engagement.may_initiate('Iris', 'Mina', [], self.store))
        server.RESETS.write_text(json.dumps({'Iris': 100}))
        self.assertTrue(engagement.may_initiate('Iris', 'Mina', [], server.life_store('Iris')))

    def test_backfill_is_chunked_visible_seeded_and_idempotent(self):
        server.append('Mystery', 'age 26', recipient='Iris')
        server.append('Mystery', 'PRIVATE OTHER', recipient='Theo')
        server.remember('Iris', 'CORE NOTE')
        with patch.object(server, 'invoke', return_value=json.dumps({'remember': [record()]})) as invoke:
            result = backfill_memory.backfill(self.iris)
            self.assertIn('CORE NOTE', invoke.call_args.args[1])
            self.assertNotIn('PRIVATE OTHER', invoke.call_args.args[1])
            self.assertEqual(result['counts']['people'], 1)
            self.assertTrue(backfill_memory.backfill(self.iris)['skipped'])
            self.assertEqual(invoke.call_count, 1)
        messages = [dict(text='x' * 700) for _ in range(4)]
        self.assertEqual(len(list(backfill_memory.chunks(messages, 1000))), 4)


if __name__ == '__main__':
    unittest.main()
