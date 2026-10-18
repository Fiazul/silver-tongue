import json
from pathlib import Path
import tempfile
import unittest
from test_support import HermeticTestCase, romance_cast
from unittest.mock import patch

import backfill_memory
import engagement
import image_refs
import life_memory
import server


def record(segment='people', text='Mystery is 26 and grew up far from Seoul.', **changes):
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
        self.store = server.life_store('Ji-woo')
        self.agents = server.load_config()['agents']
        self.jiwoo = next(a for a in self.agents if a['name'] == 'Ji-woo')
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
        self.store.apply([record(), record(text='MYSTERY IS 26 AND GREW UP FAR FROM SEOUL!'), record('unknown')], [thread['id']], source_id='2')
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
                          record('events', 'Dinner with The Landlady.', about=['The Landlady'], tags=['date'], importance=2)])
        with patch.object(self.store, 'load_segment', wraps=self.store.load_segment) as load:
            rows, _ = self.store.retrieve('do you remember my age ji-woo?', {'Mystery', 'Ji-woo'})
            self.assertEqual(rows[0][0], 'people')
            self.assertIn('26', rows[0][1]['text'])
            self.assertEqual({c.args[0] for c in load.call_args_list}, set(life_memory.SEGMENTS))

    def test_picture_recall_beats_unrelated_pins(self):
        self.store.apply([record('events', 'Mystery shared candid shots that The Merchant captured, sent as an image attachment.',
                                 tags=['camera', 'candid shots', 'image', 'photos', 'merchant'], importance=2)], source_id='1')
        for i in range(4):
            self.store.apply([record('worries', f'Mystery has not supplied timeline proof {i}. ' +
                'Ji-woo remains concerned about the rent receipt, the name in the textbook, the student ID card, '
                'and whether the neighbours can substantiate the claims made during their discussion. '
                'The matter remains unresolved and she is waiting for clarification.', tags=['timeline'], importance=5)])
        focus = dict(name='Mystery', to='Ji-woo', channel='dm', text='you dont remember the merchant picture i shared?')
        block = life_memory.retrieval_block(self.store, [focus], focus)
        self.assertIn('candid shots', block.splitlines()[0])

    def photo_fixture(self, name='Ji-woo'):
        upload_patch = patch.object(server.chat_images, 'DIRECTORY', self.root / 'uploads')
        upload_patch.start()
        self.addCleanup(upload_patch.stop)
        import base64
        paths = [server.chat_images.store('data:image/png;base64,' + base64.b64encode(
            b'\x89PNG\r\n\x1a\nfixture' + bytes([i])).decode()) for i in range(4)]
        store = server.life_store(name)
        store.apply([record('events', 'Mystery shared candid shots that The Merchant captured, sent as an image attachment.',
                            tags=['camera', 'candid shots', 'image', 'photos', 'merchant'], importance=2)], source_id='1')
        messages = [dict(id='1', name='Mystery', kind='chat', channel='dm', to=name,
                         text='She captured these.', attachments=paths[:3])]
        messages += [dict(id=str(i), name='Kim Min-jun', kind='chat', channel='group', text='Good morning.') for i in range(2, 28)]
        messages.append(dict(id='28', name='Mystery', kind='chat', channel='dm', to=name,
                             text='A recent unrelated photograph.', attachments=[paths[3]]))
        focus = dict(id='29', name='Mystery', kind='chat', channel='dm', to=name,
                     text='you dont remember the merchant picture i shared?')
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
        store = life_memory.Store(self.root / 'reset-life', 'Ji-woo', boundary=10)
        store.apply([record('events', 'Mystery shared a The Merchant photo.', tags=['image', 'merchant'], importance=3)], source_id='1')
        context = life_memory.retrieval_context(store, messages, focus)
        self.assertNotIn(paths[0], context.images)
        hidden = dict(focus, to='Kim Min-jun')
        context = life_memory.retrieval_context(store, [messages[0], hidden], hidden)
        self.assertFalse(context.recall)
        self.assertEqual(context.images, [])

    def test_attachment_only_evidence_and_irrelevant_evidence_threshold(self):
        message = dict(id='1', name='Mystery', to='Ji-woo', channel='dm', text='Here you go.', attachments=['/tmp/fixture.png'])
        focus = dict(name='Mystery', to='Ji-woo', channel='dm', text='Do you remember the picture I showed you?')
        context = life_memory.retrieval_context(self.store, [message, focus], focus)
        self.assertEqual(context.images, ['/tmp/fixture.png'])
        self.assertIn('[image #' + image_refs.token_for('/tmp/fixture.png')[4:] + ': photo from Mystery]', context.block)
        banter = [dict(name='The Landlady', channel='group', text='The Man in a Suit, coffee is ready.'),
                  dict(name='The Man in a Suit', channel='group', text='Ji-woo, do you remember Mystery?')]
        self.assertEqual(life_memory.evidence(banter, 'do you remember our outing?'), [])
        message['text'] = 'A photo from our outing.'
        focus['text'] = 'Do you remember our outing?'
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
        for text in ('remember our outing', 'I forgot that', 'did you forget?', 'recall our walk',
                     'did I send that?', 'did I tell you?', 'did I give you something?', 'did I show it?',
                     'you know what I mean', 'what did i give you?', 'remeber the picutre?'):
            self.assertTrue(life_memory.is_recall_query(text), text)
        for word in ('picture', 'pic', 'pics', 'photo', 'photos', 'image', 'shot', 'snapshot',
                     'selfie', 'candid', 'camera', 'screenshot', 'picutre'):
            self.assertEqual(life_memory.tokens(word), ['image'])
        self.assertEqual(life_memory.tokens('gift present gave giving received'), ['gift'] * 5)
        self.assertEqual(life_memory.tokens('date outing trip went out'), ['date'] * 4)

    def test_recall_expands_event_details_and_caps_background_pins(self):
        for r in [record('milestones', 'Our first outing was at Namsan under the lanterns.', tags=['date', 'namsan', 'lanterns']),
                  record('events', 'Mystery photographed the lanterns at Namsan.', tags=['lanterns', 'photo'], importance=4)]:
            self.store.apply([r])
        for i in range(4):
            self.store.apply([record('worries', f'Mystery owes rent proof {i}.', tags=['rent'], importance=5)])
        focus = dict(name='Mystery', to='Ji-woo', channel='dm', text='do you remember our outing?')
        context = life_memory.retrieval_context(self.store, [focus], focus)
        self.assertEqual([s for s, _ in context.records[:2]], ['milestones', 'events'])
        self.assertLessEqual(sum(s == 'worries' for s, _ in context.records), 2)
        # Recent unrelated messages do not change the query or its ranking.
        noise = [dict(name='Kim Min-jun', channel='group', text='Do you know how old the rent receipt is?')]
        self.assertEqual(life_memory.retrieval_context(self.store, noise + [focus], focus).records, context.records)

    def test_run_turn_passes_recalled_images_to_actor_and_fallback(self):
        _, messages, _, paths = self.photo_fixture()
        server.LOG.write_text(''.join(json.dumps(m) + '\n' for m in messages))
        reply = json.dumps(dict(message='I remember those candid shots.', memory='I remember our outing.', to='Mystery'))
        config = {'agents': [self.jiwoo], 'fallback': {'provider': 'cursor', 'model': 'auto'}}
        with patch.object(server, 'choose_next', return_value='Ji-woo'), \
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
        prompt = server.make_prompt(self.jiwoo, [], self.agents)
        for forbidden in ('YOUR LASTING PRIVATE CHARACTER NOTES', 'your own saved memory',
                          'Your notes are', 'these records and evidence', 'Keep notes about', 'memory is saved locally'):
            self.assertNotIn(forbidden, prompt)
        self.assertIn('Speak from memory in first person', prompt)
        self.assertIn('Your memories that come to mind now:', prompt)
        self.assertIn('Never say the (#reference) markers aloud', prompt)
        block = life_memory.retrieval_block(self.store, [dict(name='Mystery', text='age', channel='dm', to='Ji-woo')])
        self.assertTrue(block.splitlines()[0].endswith('(#' + self.store.load_segment('people')[0]['id'] + ')'))

    def test_open_worries_milestones_and_importance_five_are_pinned(self):
        self.store.apply([record('worries', 'Did The Merchant air hold?', tags=['air'], importance=3),
                          record('milestones', 'Our first walk.', tags=['walk'], importance=4),
                          record('important', 'Keep the blue stone.', tags=['stone'], importance=5)])
        block = life_memory.retrieval_block(self.store, [{'name': 'Mystery', 'text': 'Hello', 'channel': 'dm', 'to': 'Ji-woo'}])
        for expected in ('The Merchant air', 'first walk', 'blue stone'):
            self.assertIn(expected, block)
        self.assertLessEqual(len(block), 1600)

    def test_counterpart_bond_pins_survive_zero_budget_and_do_not_include_other_people(self):
        self.store.apply([record('feelings', 'I love Mystery and want to repair our bond.', importance=2),
                          record('milestones', 'Our first shared voyage.', importance=4),
                          record('feelings', 'I enjoy painting with The Man in a Suit.', about=['The Man in a Suit'], importance=5),
                          record('milestones', 'An unimportant passing joke.', importance=3)], limit=4, embed=False)
        for i in range(6):
            self.store.apply([record('milestones', f'Our shared experience {i}.', importance=5)], embed=False)
        anchors = self.store.prompt_anchors('Mystery')
        self.assertEqual(len(anchors), 3)
        self.assertTrue(any(s == 'feelings' for s, _ in anchors))
        self.assertTrue(all('Mystery' in r['about'] for _, r in anchors))
        self.assertTrue(all(r['importance'] >= 4 for s, r in anchors if s == 'milestones'))
        focus = dict(name='Mystery', text='hello', channel='dm', to='Ji-woo')
        recalled = life_memory.retrieval_context(self.store, [focus], focus, budget=0)
        for _, value in anchors:
            self.assertIn(value['text'], recalled.block)
        self.assertNotIn('painting with The Man in a Suit', recalled.block)

    def test_repeated_sleep_question_adds_prompt_directive(self):
        messages = [dict(name='Ji-woo', to='Mystery', channel='dm', text=text) for text in (
            'And I still need a yes or no on sleep.',
            'Alex, if I forgot something, tell me what it was. And the sleep question still stands: yes or no?',
            'Honestly, not much, Alex. Did you sleep? Yes or no.',
            "Pick me up where? I'm not getting in a car with you until you tell me honestly whether you slept. And no doctor before you explain the Voyager thing.",
            'Explain everything once we meet? Alex, no. Did you sleep? Yes or no.',
            "You're 26 on your own clock. Now, did you sleep? Yes or no.",
        )]
        focus = dict(name='Mystery', to='Ji-woo', channel='dm', text='how about i explain everything once we meet !')
        prompt = server.make_prompt(self.jiwoo, messages + [focus], self.agents, focus)
        self.assertIn('YOU ALREADY ASKED Mystery ABOUT: sleep.', prompt)
        self.assertIn(frozenset({'sleep'}), server.already_asked_topics(self.jiwoo, messages, self.agents)['Mystery'])
        self.assertIn("An unanswered question is not a precondition for the relationship; don't hold plans hostage to it.", prompt)

    def question_fixture(self, person='Mystery', channel='dm', asks=('Did you sleep?', 'I still need a yes or no on sleep.')):
        messages = [dict(id=str(index + 1), kind='chat', name='Ji-woo', to=person if channel == 'dm' else None,
                         channel=channel, text=text if channel == 'dm' else f'@{person} {text}')
                    for index, text in enumerate(asks)]
        focus = dict(id='10', kind='chat', name=person, to='Ji-woo' if channel == 'dm' else None,
                     channel=channel, text='I will pick you up in 10 mins' if channel == 'dm' else '@Ji-woo let us meet')
        return messages + [focus], focus

    def test_single_ask_and_repetition_within_one_message_have_no_directive(self):
        for asks in (('Did you sleep?',), ('Did you sleep? Tell me whether you slept. Yes or no?',)):
            messages, focus = self.question_fixture(asks=asks)
            self.assertEqual(server.already_asked_topics(self.jiwoo, messages, self.agents), {})
            self.assertNotIn('YOU ALREADY ASKED', server.make_prompt(self.jiwoo, messages, self.agents, focus))

    def test_other_counterparts_and_speakers_do_not_count(self):
        messages, focus = self.question_fixture(asks=('Did you sleep?',))
        for person in ('Kim Min-jun', 'Mystery'):
            other = dict(name='Kim Min-jun' if person == 'Mystery' else 'Ji-woo', to=person, channel='dm', text='Did you sleep?')
            self.assertEqual(server.already_asked_topics(self.jiwoo, [other] + messages, self.agents), {})
        other_thread, _ = self.question_fixture(person='Kim Min-jun')
        prompt = server.make_prompt(self.jiwoo, other_thread + messages, self.agents, focus)
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
        parent = dict(id='0', name='Mystery', channel='group', text='Hello Ji-woo')
        messages = [parent] + [dict(id=str(i), name='Ji-woo', channel='group', reply_to='0', text='Did you sleep?')
                               for i in (1, 2)]
        self.assertEqual(server.already_asked_topics(self.jiwoo, messages, self.agents)['Mystery'], [frozenset({'sleep'})])
        for message in messages[1:]:
            message.pop('reply_to')
            message['targets'] = ['Mystery']
        self.assertIn('Mystery', server.already_asked_topics(self.jiwoo, messages, self.agents))
        for message in messages[1:]:
            message['text'] = '@Mystery did you sleep? @Kim Min-jun tell me about the Voyager reactor.'
            message.pop('targets')
        topics = server.already_asked_topics(self.jiwoo, messages, self.agents)
        self.assertEqual(topics['Mystery'], [frozenset({'sleep'})])
        self.assertEqual(topics['Kim Min-jun'], [frozenset({'voyager', 'reactor'})])

    def test_six_message_window_and_reset_end_old_repetition(self):
        messages, focus = self.question_fixture()
        messages[-1:-1] = [dict(name='Ji-woo', to='Mystery', channel='dm', text='I like this place.') for _ in range(6)]
        self.assertEqual(server.already_asked_topics(self.jiwoo, messages, self.agents), {})
        messages, focus = self.question_fixture()
        server.RESETS.write_text(json.dumps({'Ji-woo': 2}))
        self.assertEqual(server.already_asked_topics(self.jiwoo, messages, self.agents), {})

    def test_reactor_and_logs_demands_use_shared_topic_tokens(self):
        for asks, expected in (
                (('Tell me about the Voyager reactor.', 'Answer me about the reactor on Voyager.'), {'voyager', 'reactor'}),
                (("I still need The Merchant's logs.", "Tell me about The Merchant's log."), {'log'}),
                (('Did you sleep?', "I'm not getting in a car until you tell me whether you slept."), {'sleep'})):
            with self.subTest(asks=asks):
                messages, _ = self.question_fixture(asks=asks)
                self.assertEqual(server.already_asked_topics(self.jiwoo, messages, self.agents)['Mystery'], [frozenset(expected)])

    def test_worries_are_labeled_without_losing_recall_or_changing_records(self):
        self.store.apply([
            record('worries', 'Mystery has not answered clearly whether he slept.', tags=['sleep'], importance=3),
            record('worries', 'Mystery may miss home.', tags=['home'], importance=3),
            record('worries', 'Kim Min-jun has not slept.', about=['Kim Min-jun'], tags=['sleep'], importance=3),
            record('worries', 'Mystery slept yesterday.', tags=['sleep'], importance=5, status='resolved'),
        ])
        before = self.store.load_segment('worries')
        messages, focus = self.question_fixture()
        focus['text'] = 'Do you remember what you were worried about, and whether Kim Min-jun slept?'
        block = life_memory.retrieval_block(self.store, messages, focus,
            already_asked={'Mystery': [frozenset({'sleep'})]}, names=['Ji-woo', 'Mystery', 'Kim Min-jun'])
        self.assertIn('whether he slept. (asked already — let it rest unless they bring it up)', block)
        self.assertIn('may miss home. (on your mind — not a question to re-ask each turn)', block)
        self.assertIn('Kim Min-jun has not slept. (on your mind — not a question to re-ask each turn)', block)
        self.assertNotIn('yesterday. (asked already', block)
        self.assertEqual(before, self.store.load_segment('worries'))

    def test_initiative_worry_uses_same_labels(self):
        self.store.apply([record('worries', 'Mystery has not answered clearly whether he slept.', tags=['sleep'], importance=3)])
        direction = engagement.direction(self.jiwoo, 'Mystery', self.store,
                                         {'Mystery': [frozenset({'sleep'})]}, ['Ji-woo', 'Mystery'])
        self.assertIn('(asked already — let it rest unless they bring it up)', direction)
        self.assertNotIn('Pick up this open thread', direction)
        self.assertIn('(on your mind — not a question to re-ask each turn)',
                      engagement.direction(self.jiwoo, 'Mystery', self.store))

    def test_correction_only_for_nagging_and_second_nag_still_posts(self):
        messages, focus = self.question_fixture()
        topics = server.already_asked_topics(self.jiwoo, messages, self.agents)
        clean = ["I'll meet you outside.", "We can discuss sleep when you're ready.",
                 "I'll wait until you're ready to explain your sleep."]
        for first in ['Did you sleep? Yes or no.', 'I still need a yes or no on sleep.',
                      "I'm not coming until you tell me whether you slept."] + clean:
            with self.subTest(first=first):
                replies = [dict(message=first, memory='We are meeting.', to='Mystery'),
                           dict(message='See you in ten.', memory='We are meeting.', to='Mystery')]
                with patch.object(server, 'invoke', side_effect=[json.dumps(r) for r in replies]) as invoke:
                    result = server.serve_turn(self.jiwoo, 'Prompt', [], {'agents': self.agents}, self.agents,
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
             patch.object(server, 'choose_next', return_value='Ji-woo'):
            server.ACTIVE.set()
            server.run_turn({'agents': self.agents})
        self.assertEqual(invoke.call_count, 2)
        self.assertEqual(server.history()[-1]['text'], 'Did you sleep?')
        self.assertEqual(server.history()[-1]['kind'], 'chat')

    def test_correction_failure_uses_fallback_with_fresh_budget(self):
        messages, focus = self.question_fixture()
        topics = server.already_asked_topics(self.jiwoo, messages, self.agents)
        config = {'agents': self.agents, 'fallback': {'provider': 'cursor', 'model': 'auto'}}
        nag = json.dumps(dict(message='Did you sleep?', memory='We are meeting.', to='Mystery'))
        clean = json.dumps(dict(message='See you in ten.', memory='We are meeting.', to='Mystery'))
        with patch.object(server, 'invoke', side_effect=[nag, server.ProviderTimeout('timeout'), clean]) as invoke:
            result = server.serve_turn(self.jiwoo, 'Prompt', [], config, self.agents, focus, False, topics)
        self.assertEqual(invoke.call_count, 3)
        self.assertEqual(result[0], 'See you in ten.')
        self.assertEqual(result[-1], 'cursor/auto')
        self.assertEqual(invoke.call_args_list[0].args[1], invoke.call_args_list[2].args[1])
        # The extra correction call is bounded to once even across providers.
        server.PROVIDER_BREAKS.clear()
        with patch.object(server, 'invoke', side_effect=[nag, server.ProviderTimeout('timeout'), nag]) as invoke:
            result = server.serve_turn(self.jiwoo, 'Prompt', [], config, self.agents, focus, False, topics)
        self.assertEqual(invoke.call_count, 3)
        self.assertEqual(result[0], 'Did you sleep?')

    def test_public_nagging_and_different_recipient(self):
        topics = {'Mystery': [frozenset({'sleep'})]}
        _, focus = self.question_fixture(channel='group')
        self.assertEqual(server.nagging_topics('Did you sleep?', None, focus, topics, self.agents), topics['Mystery'])
        self.assertEqual(server.nagging_topics('@Mystery did you sleep?', None, None, topics, self.agents), topics['Mystery'])
        self.assertEqual(server.nagging_topics('@Kim Min-jun did you sleep?', None, focus, topics, self.agents), [])
        self.assertEqual(server.nagging_topics('@Mystery see you soon. @Kim Min-jun did you sleep?', None, focus, topics, self.agents), [])
        self.assertEqual(server.nagging_topics('Did you sleep?', 'Kim Min-jun', focus, topics, self.agents), [])

    def test_transcript_evidence_visibility_reset_and_dated_snippets(self):
        messages = [dict(id='1', name='Mystery', text='age 99 OLD', channel='dm', to='Ji-woo'),
                    dict(id='11', name='Mystery', text='age 77 SECRET', channel='dm', to='Kim Min-jun'),
                    dict(id='12', name='Mystery', text='age 26 VISIBLE', channel='dm', to='Ji-woo', time='2026-10-15T12:00:00Z'),
                    dict(id='13', name='Kim Min-jun', text='age 28 PUBLIC', channel='group')]
        visible = life_memory.visible_messages(messages, 'Ji-woo', 10)
        snippets = '\n'.join(life_memory.evidence(visible, 'my age?'))
        self.assertNotIn('OLD', snippets)
        self.assertNotIn('SECRET', snippets)
        self.assertIn('26 VISIBLE', snippets)
        self.assertIn('2026-10-15', snippets)
        self.assertIn('PUBLIC', snippets)
        self.store.apply([record()])
        server.RESETS.write_text(json.dumps({'Ji-woo': 10}))
        self.assertEqual(server.life_store('Ji-woo').retrieve('age', {'Mystery'})[0], [])
        server.life_store('Ji-woo').apply([record(text='Mystery likes tea.', tags=['tea'])])
        self.assertEqual([r['text'] for r in server.life_store('Ji-woo').load_segment('people')], ['Mystery likes tea.'])

    def test_raw_transcript_finds_old_age_fact_before_recent_questions(self):
        messages = [dict(name='Mystery', text='I am 26, by my own count and my birthday. The ID card says otherwise.', channel='dm', to='Ji-woo')]
        messages.extend(dict(name='Ji-woo', text='What is your age?', channel='dm', to='Mystery') for _ in range(25))
        focus = dict(name='Mystery', text='do you remember my age?', channel='dm', to='Ji-woo')
        block = life_memory.retrieval_block(self.store, messages + [focus], focus)
        self.assertIn('26', block.splitlines()[0])
        self.assertNotIn('do you remember', block)

    def test_run_turn_persists_and_resolves_and_drops_bad_records(self):
        self.store.apply([record('worries', 'Where is Mystery?', tags=['worry'], importance=3)])
        record_id = self.store.load_segment('worries')[0]['id']
        server.append('Mystery', 'Ji-woo, do you remember my age?', recipient='Ji-woo')
        reply = dict(message='You are 26.', memory=' '.join(['word'] * 140), to='Mystery',
                     remember=[record(), {'segment': 'nonsense'}, {'segment': 'people', 'text': 42}], resolve=[record_id])
        with patch.object(server, 'invoke', return_value=json.dumps(reply)) as invoke:
            server.ACTIVE.set()
            server.run_turn({'agents': [self.jiwoo]})
        self.assertEqual(invoke.call_count, 1)
        self.assertEqual(server.history()[-1]['text'], 'You are 26.')
        self.assertEqual(self.store.load_segment('worries')[0]['status'], 'resolved')
        self.assertEqual(len(self.store.load_segment('people')), 1)
        self.assertEqual(len(server.memories()['Ji-woo'].split()), 120)

    def test_silence_and_ten_message_cooldown(self):
        messages = [dict(name='Ji-woo', to='Mystery', channel='dm', text='hello', initiative=True)]
        self.assertFalse(engagement.may_initiate('Ji-woo', 'Mystery', messages, self.store))
        messages.extend(dict(name='Kim Min-jun', text='hi', channel='group') for _ in range(10))
        self.assertTrue(engagement.may_initiate('Ji-woo', 'Mystery', messages, self.store))
        messages.append(dict(name='Ji-woo', to='Mystery', channel='dm', text='checking in'))
        messages.extend(dict(name='Kim Min-jun', text='hi', channel='group') for _ in range(10))
        self.assertFalse(engagement.may_initiate('Ji-woo', 'Mystery', messages, self.store))
        messages.append(dict(name='Mystery', to='Ji-woo', channel='dm', text='hello'))
        self.assertTrue(engagement.may_initiate('Ji-woo', 'Mystery', messages, self.store))

    def test_contact_cooldown_counts_dm_during_another_persons_turn(self):
        messages = [dict(id='1', name='Kim Min-jun', text='Hello Ji-woo', channel='group'),
                    dict(id='2', name='Ji-woo', to='Mystery', text='Hi', channel='dm', reply_to='1', initiative=False)]
        self.assertFalse(engagement.may_initiate('Ji-woo', 'Mystery', messages, self.store))
        messages[-1].pop('reply_to')
        self.assertFalse(engagement.may_initiate('Ji-woo', 'Mystery', messages, self.store))

    def test_blocked_dm_is_never_made_public_and_direct_reply_allowed(self):
        for _ in range(2):
            server.append('Ji-woo', 'hi', recipient='Mystery', initiative=True)
        server.append('Kim Min-jun', 'hello everyone')
        reply = json.dumps(dict(message='PRIVATE DRAFT', memory='I miss Mystery.', to='Mystery'))
        before = len(server.history())
        with patch.object(server, 'invoke', return_value=reply):
            server.ACTIVE.set()
            server.run_turn({'agents': [self.jiwoo]})
            self.assertEqual(len(server.history()), before)
            server.append('Mystery', 'Hi Ji-woo', recipient='Ji-woo')
            server.run_turn({'agents': [self.jiwoo]})
            self.assertEqual(server.history()[-1]['channel'], 'dm')
            self.assertEqual(server.history()[-1]['text'], 'PRIVATE DRAFT')

    def test_blocked_contacts_skip_without_fallback_or_break(self):
        for target in ('Mystery', 'The Man in a Suit'):
            for use_fallback in (False, True):
                with self.subTest(target=target, fallback=use_fallback):
                    server.LOG.unlink(missing_ok=True)
                    server.STATE.update(speaker=None, turns=0)
                    self.store.apply([record('boundaries', f'{target} asked Ji-woo for space.',
                                             about=[target, 'Ji-woo'], tags=['space'])])
                    reply = dict(message='PRIVATE DRAFT', memory='Do not save this draft.', to=target,
                                 scores={target: {'like': 150, 'dislike': 0}}, remember=[record()])
                    config = {'agents': [self.jiwoo, next(a for a in self.agents if a['name'] == 'The Man in a Suit')],
                              'fallback': {'provider': 'cursor', 'model': 'auto'}}
                    responses = [RuntimeError('primary crashed'), json.dumps(reply)] if use_fallback else [json.dumps(reply)]
                    with patch.object(server, 'choose_next', return_value='Ji-woo'), \
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
                    self.assertEqual(server.STATE['reason'], f'Ji-woo is giving {target} space.')
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
        suit = next(a for a in self.agents if a['name'] == 'The Man in a Suit')
        for target in ('Mystery', 'The Man in a Suit'):
            for channel in ('group', 'dm'):
                with self.subTest(target=target, channel=channel):
                    server.LOG.unlink(missing_ok=True)
                    server.STATE.update(speaker=None, turns=0)
                    self.store.apply([record('boundaries', f'{target} asked Ji-woo for space.',
                                             about=[target, 'Ji-woo'], tags=['space'])])
                    incoming = server.append(target, '@Ji-woo hello', recipient='Ji-woo' if channel == 'dm' else None)
                    reply = json.dumps(dict(message='Hello back.', memory='I answered a direct message.', to=target,
                                            scores={target: {'like': 150, 'dislike': 0}}))
                    with patch.object(server, 'choose_next', return_value='Ji-woo'), \
                         patch.object(server, 'invoke', return_value=reply) as invoke:
                        server.ACTIVE.set()
                        server.run_turn({'agents': [self.jiwoo, suit],
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
        server.append('Mystery', 'PRIVATE OTHER', recipient='Kim Min-jun')
        incoming = server.append('Mystery', 'Ji-woo, I am 26.', recipient='Ji-woo')
        reply = dict(message='Ji-woo: You are 26.', memory=' '.join(['word'] * 140),
                     to='Mystery', remember=[record(), {'segment': 'nonsense'}], resolve=[worry_id])
        config = {'agents': [self.jiwoo], 'fallback': {'provider': 'cursor', 'model': 'auto'}}
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
        self.assertEqual(posted['text'], 'You are 26.')
        self.assertEqual(posted['served_by'], 'cursor/auto')
        self.assertEqual(posted['channel'], 'dm')
        self.assertEqual(posted['to'], 'Mystery')
        saved = self.store.load_segment('people')
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]['source_id'], incoming['id'])
        self.assertEqual(saved[0]['time'], incoming['time'])
        self.assertEqual(saved[0]['known_by'], ['Ji-woo', 'Mystery'])
        self.assertEqual(saved[0]['source_person'], 'Mystery')
        self.assertEqual(saved[0]['source_channel'], 'dm')
        self.assertEqual(self.store.load_segment('worries')[0]['status'], 'resolved')
        self.assertEqual(len(server.memories()['Ji-woo'].split()), 120)
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
                    config = {'agents': [self.jiwoo], 'fallback': {'provider': 'cursor', 'model': 'auto'}}
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
        agents = [a for a in self.agents if a['name'] in ('Ji-woo', 'Kim Min-jun', 'Grandpa Park')]
        server.relationships.save('Ji-woo', {'Mystery': {'like': 150, 'dislike': 3}})
        messages = [dict(id=str(i), name='Grandpa Park' if i % 2 else 'Kim Min-jun', text='hello', channel='group') for i in range(10)]
        self.assertEqual(server.choose_next(messages, agents), 'Ji-woo')
        self.assertEqual(server.longing_for(self.jiwoo, agents, messages)[2], 'Mystery')
        self.assertIn('YOUR HEART', engagement.direction(self.jiwoo, 'Mystery', self.store))
        messages.append(dict(id='20', name='Mystery', text='@Kim Min-jun question', channel='group'))
        self.assertEqual(server.choose_next(messages, agents), 'Kim Min-jun')
        # Ordinary unfocused turns also give longing a selection weight.
        messages[-1] = dict(id='20', name='Kim Min-jun', text='hello', channel='group', initiative=True)
        with patch.object(server.random, 'choices', return_value=['Ji-woo']) as choose:
            self.assertEqual(server.choose_next(messages, agents), 'Ji-woo')
            weights = choose.call_args.kwargs['weights']
            names = choose.call_args.args[0]
            self.assertGreater(weights[names.index('Ji-woo')], weights[names.index('Grandpa Park')])

    def test_boundaries_and_unspoken_love_obey_preferences(self):
        config = server.load_config()
        cast = romance_cast()
        blair, casey = cast[1], cast[2]
        blair_store = server.life_store('Blair')
        scores = {'Mystery': {'like': 150, 'dislike': 3}, 'Avery': {'like': 150, 'dislike': 0}}
        heart = engagement.heart(blair, scores, cast, blair_store, config)
        self.assertIn('Unspoken love: you love Mystery', heart)
        # Unknown Mystery gender (no config) never yields romantic love toward Mystery.
        self.assertNotIn('trust Mystery', engagement.heart(blair, scores, cast, blair_store))
        self.assertNotIn('love Avery', heart)
        # The story cast never opts into romance.
        self.assertNotIn('Unspoken love', engagement.heart(self.jiwoo, {'Mystery': {'like': 150, 'dislike': 3}},
                                                           self.agents, self.store, config))
        self.store.apply([record('boundaries', 'Mystery asked Ji-woo for space.', tags=['space'], importance=5)])
        self.assertFalse(engagement.may_initiate('Ji-woo', 'Mystery', [], self.store))
        self.store.apply([record('boundaries', 'The Man in a Suit said no to the red scarf.', about=['The Man in a Suit'], tags=['scarf'], importance=2)])
        self.assertTrue(engagement.may_initiate('Ji-woo', 'The Man in a Suit', [], self.store))
        boundary = self.store.load_segment('boundaries')[0]
        # Mystery stated it: Ji-woo alone cannot lift it, only Mystery's visible lifting message.
        self.store.apply([], [boundary['id']])
        self.assertFalse(engagement.may_initiate('Ji-woo', 'Mystery', [], self.store))
        lifted = dict(id='99', name='Mystery', channel='dm', to='Ji-woo', text='You can message me again, Ji-woo.',
                      time='2999-01-01T00:00:00+00:00')
        self.store.apply([], [boundary['id']], visible=[lifted])
        self.assertTrue(engagement.may_initiate('Ji-woo', 'Mystery', [], self.store))
        blair_store.apply([record('milestones', 'Blair said I love you to Mystery.', about=['Blair', 'Mystery'], tags=['confession'])])
        self.assertNotIn('Unspoken love', engagement.heart(blair, scores, cast, blair_store, config))
        self.assertNotIn('love Blair', engagement.heart(casey, {'Blair': {'like': 150, 'dislike': 0}}, cast, blair_store))

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
        self.store.apply([record('boundaries', 'The Man in a Suit asked Ji-woo for space.', about=['The Man in a Suit', 'Ji-woo'], tags=['space'])])
        self.assertFalse(engagement.may_initiate('Ji-woo', 'The Man in a Suit', [], self.store))
        server.RESETS.write_text(json.dumps({'Ji-woo': 100}))
        self.assertTrue(engagement.may_initiate('Ji-woo', 'The Man in a Suit', [], server.life_store('Ji-woo')))

    def test_backfill_is_chunked_visible_seeded_and_idempotent(self):
        server.append('Mystery', 'age 26', recipient='Ji-woo')
        server.append('Mystery', 'PRIVATE OTHER', recipient='Kim Min-jun')
        server.remember('Ji-woo', 'CORE NOTE')
        with patch.object(server, 'invoke', return_value=json.dumps({'remember': [record()]})) as invoke:
            result = backfill_memory.backfill(self.jiwoo)
            self.assertIn('CORE NOTE', invoke.call_args.args[1])
            self.assertNotIn('PRIVATE OTHER', invoke.call_args.args[1])
            self.assertEqual(result['counts']['people'], 1)
            self.assertTrue(backfill_memory.backfill(self.jiwoo)['skipped'])
            self.assertEqual(invoke.call_count, 1)
        messages = [dict(text='x' * 700) for _ in range(4)]
        self.assertEqual(len(list(backfill_memory.chunks(messages, 1000))), 4)


if __name__ == '__main__':
    unittest.main()
