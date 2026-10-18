"""Offline scene integration tests: isolated storage and mocked provider only."""
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from test_support import HermeticTestCase
from unittest.mock import patch

import chat_images
import scenes
import server

THREAD_START = threading.Thread.start


class SceneTests(HermeticTestCase):
    def setUp(self):
        from datetime import datetime, timezone
        clock_patch = patch.object(server.TIMEKEEPER, 'clock', return_value=datetime(2026, 10, 16, 6, tzinfo=timezone.utc))
        clock_patch.start()
        self.addCleanup(clock_patch.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.config = server.load_config()
        self.config['embeddings'] = {'enabled': False}
        self.config['fallback'] = {'provider': 'cursor', 'model': 'auto'}
        self.config['memory_sweep'] = {'enabled': False}
        for agent in self.config['agents']:
            agent['enabled'] = True
        self.manager = scenes.Scenes(vars(server))
        for obj, name, value in (
                (server, 'DATA', root), (server, 'LOG', root / 'messages.jsonl'),
                (server, 'MEMORY', root / 'memories.json'), (server, 'RESETS', root / 'resets.json'),
                (server, 'SCENES', self.manager), (server.relationships, 'FILE', root / 'scores.json'),
                (chat_images, 'DIRECTORY', root / 'uploads')):
            patcher = patch.object(obj, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for state in (server.PROVIDER_BREAKS, server.PROVIDER_EXHAUSTED, server.PROVIDER_TRIALS, server.CHARACTER_BREAKS):
            patcher = patch.dict(state, {}, clear=True)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(server, 'load_config', return_value=self.config)
        patcher.start()
        self.addCleanup(patcher.stop)
        # Queue jobs deterministically. Each test explicitly drains the real worker function.
        patcher = patch.object(scenes.threading.Thread, 'start')
        self.thread_start = patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(server.WAKE.clear)
        server.STATE['speaker'] = None
        self.agent = next(a for a in self.config['agents'] if a['name'] == 'Iris')
        patcher = patch.object(server, 'invoke', side_effect=self.provider)
        self.invoke = patcher.start()
        self.addCleanup(patcher.stop)

    def record(self, owner=None, segment='events', text='We visited the observation deck.'):
        record = dict(segment=segment, about=['Mystery', 'Iris'], text=text,
                      tags=['ship', 'together'], importance=5, status='resolved')
        if owner:
            record['participant'] = owner
        if segment == 'world':
            record.update(speaker='Mystery', belief='believes')
        return record

    def provider(self, agent, prompt, timeout, images=None):
        if prompt.startswith('Summarize this completed in-person scene:'):
            records = [self.record(name) for name in ('Iris', 'Nora') if name in prompt.split('Participants: ')[1].split('.')[0]]
            return json.dumps(dict(message='We explored the ship together. The stars felt close.',
                                   memory='A shared outing.', remember=records, to=None, scores={}))
        return json.dumps(dict(message='*I step onto the deck.* Come see the stars with me.',
                               memory='I feel closer to Mystery after exploring the ship.',
                               remember=[self.record()], resolve=[], scores={'Mystery': {'like': 115, 'dislike': 0}}, to=None))

    def create(self, **changes):
        data = dict(participants=['Iris'], kind='date', title='Among the stars',
                    location='The ship’s observation deck', visibility='private')
        data.update(changes)
        return self.manager.create(data)

    def drain(self, scene_id):
        operation = self.manager.jobs[scene_id]['operation']
        self.manager.work(scene_id, operation)
        return self.manager.get(scene_id)

    def test_create_post_end_lifecycle_and_storage_isolation(self):
        scene = self.create()
        self.assertEqual(scene['status'], 'active')
        self.assertEqual(scene['messages'], [])
        path = self.manager.root / scene['id']
        self.assertTrue((path / 'meta.json').is_file())
        self.assertTrue((path / 'messages.jsonl').is_file())
        posted = self.manager.post(scene['id'], {'text': 'The hatch opens onto a sea of stars.'})
        self.assertTrue(posted['busy'])
        self.assertEqual(posted['messages'][-1]['kind'], 'narration')
        replied = self.drain(scene['id'])
        self.assertFalse(replied['busy'])
        self.assertEqual([m['name'] for m in replied['messages']], ['Mystery', 'Iris'])
        self.assertIn('Iris', server.memories())
        self.assertEqual(server.relationships.load()['Iris']['Mystery']['like'], 115)
        self.assertEqual(server.history(), [])
        self.manager.end(scene['id'])
        ended = self.drain(scene['id'])
        self.assertEqual(ended['status'], 'ended')
        self.assertTrue(ended['summary'])
        self.assertTrue(ended['ended_at'])
        self.assertEqual(server.history(), [])
        self.assertFalse(self.manager.away_reason('Iris'))
        with self.assertRaises(scenes.SceneError):
            self.manager.post(scene['id'], {'text': 'Another step'})
        self.assertEqual(self.manager.end(scene['id'])['status'], 'ended')

    def test_only_one_active_scene_per_character_and_restart_reservations(self):
        first = self.create()
        with self.assertRaises(scenes.SceneError) as error:
            self.create(participants=['Iris', 'Nora'])
        self.assertEqual(error.exception.code, 409)
        restarted = scenes.Scenes(vars(server))
        self.assertEqual(restarted.away_reason('Iris'), 'On a date with Mystery')
        self.manager.end(first['id'])
        self.drain(first['id'])
        self.assertEqual(self.create()['status'], 'active')

    def test_reservation_checks_group_turn_already_in_flight(self):
        server.STATE['speaker'] = 'Iris'
        try:
            with self.assertRaises(scenes.SceneError) as error:
                self.create()
            self.assertEqual(error.exception.code, 409)
            self.assertEqual(self.manager.list(), [])
        finally:
            server.STATE['speaker'] = None

    def test_all_group_scheduler_sites_exclude_scene_characters_and_cast_shows_reason(self):
        self.create()
        available = server.available_agents(self.config['agents'], self.config)
        self.assertNotIn('Iris', [a['name'] for a in available])
        self.assertIsNone(server.choose_next([], [self.agent]))
        direct = [dict(id='1', name='Mystery', text='Iris, come here', kind='chat', channel='group')]
        self.assertNotEqual(server.choose_next(direct, self.config['agents']), 'Iris')
        status = server.character_status(self.agent, self.config)
        self.assertFalse(status['enabled'])
        self.assertEqual(status['away_reason'], 'On a date with Mystery')
        server.PROVIDER_BREAKS['claude'] = server.time.monotonic() + 100
        self.assertEqual(server.character_status(self.agent, self.config)['away_reason'], 'On a date with Mystery')

    def test_kind_specific_away_reasons(self):
        reasons = {'date': 'On a date', 'hangout': 'Hanging out', 'trip': 'On a trip',
                   'life_event': 'At a life event', 'other': 'In a scene'}
        for kind, prefix in reasons.items():
            with self.subTest(kind=kind):
                scene = self.create(kind=kind)
                self.assertTrue(self.manager.away_reason('Iris').startswith(prefix))
                self.manager.end(scene['id'])
                self.drain(scene['id'])

    def test_announced_and_private_room_lines(self):
        private = self.create()
        self.manager.end(private['id'])
        self.drain(private['id'])
        self.assertEqual(server.history(), [])
        public = self.create(visibility='announced')
        self.assertEqual([m['text'] for m in server.history()], ['Iris left with Mystery.'])
        self.manager.end(public['id'])
        self.drain(public['id'])
        self.assertEqual([m['text'] for m in server.history()], ['Iris left with Mystery.', 'Iris is back.'])
        self.assertTrue(all(m['name'] == 'Room' and m['kind'] == 'system' for m in server.history()))
        self.manager.end(public['id'])
        self.assertEqual(len(server.history()), 2)

    def test_multiple_participants_reply_once_in_order_with_shared_context(self):
        scene = self.create(participants=['Nora', 'Iris'], opening='We arrive at the ship.')
        self.assertTrue(scene['busy'])
        replied = self.drain(scene['id'])
        self.assertEqual([m['name'] for m in replied['messages']], ['Mystery', 'Nora', 'Iris'])
        self.assertEqual(self.invoke.call_count, 2)
        self.assertIn('Nora: *I step onto the deck.*', self.invoke.call_args_list[1].args[1])
        self.assertTrue(all(call.args[2] > 0 for call in self.invoke.call_args_list))

    def test_scene_prompt_gm_yes_and_warmth_guards_core_and_pinned_memory(self):
        store = server.life_store('Iris', self.config)
        for segment in ('world', 'feelings', 'milestones'):
            store.apply([self.record(segment=segment, text=f'Pinned {segment} detail')], embed=False)
        server.remember('Iris', 'Mystery and I trust one another.')
        server.relationships.save('Iris', {'Mystery': {'like': 125, 'dislike': 0}})
        scene = self.create(opening='A starship waits. We can touch it.')
        self.drain(scene['id'])
        prompt = self.invoke.call_args.args[1]
        for rule in ('physically together, in person', 'game master', 'established fact', 'firsthand experience IS the evidence',
                     'Yes, and', 'net >70', 'net >100', 'Never use a full name in every line',
                     'Do not control Mystery', 'SIBLING/PREFERENCE/CONSENT', 'Personality:', self.agent['personality'],
                     'Mystery and I trust one another.', '125', 'Pinned world detail', 'Pinned feelings detail',
                     'Pinned milestones detail', '"memory"', '"remember"', '"resolve"', '"scores"'):
            self.assertIn(rule, prompt)
        for group_rule in ('no narrating actions', 'short chat message', 'YOUR OWN TURN:', 'LOCAL WORK TOOL:'):
            self.assertNotIn(group_rule, prompt)

    def test_last_30_scene_messages_only_and_no_group_or_dm_leak(self):
        server.append('Mystery', 'GROUP SECRET')
        server.append('Mystery', 'DM SECRET', recipient='Iris')
        scene = self.create()
        for i in range(35):
            self.manager.append(scene['id'], 'Mystery', f'Opening move {i}.', 'narration')
        self.manager.post(scene['id'], {'text': 'Current move'})
        self.drain(scene['id'])
        prompt = self.invoke.call_args.args[1]
        transcript = prompt.split('LAST SCENE MESSAGES:')[1].split('Return ONLY JSON:')[0]
        self.assertNotIn('Opening move 0.', transcript)
        self.assertIn('Opening move 34.', transcript)
        self.assertEqual(len(transcript.strip().splitlines()), 30)
        self.assertNotIn('GROUP SECRET', prompt)
        self.assertNotIn('DM SECRET', prompt)

    def test_long_world_pins_cannot_crowd_out_feelings_or_milestones(self):
        store = server.life_store('Iris', self.config)
        records = [self.record(segment='world', text=f'World fact {i}: ' + 'stars ' * 120) for i in range(5)]
        records.extend([self.record(segment='feelings', text='I feel close to Mystery.'),
                        self.record(segment='milestones', text='Our first flight together.')])
        store.apply(records, limit=7, embed=False)
        scene = self.create()
        _, _, pins = self.manager.recall(self.agent, scene, [], self.config)
        self.assertIn('feelings: I feel close to Mystery.', pins)
        self.assertIn('milestones: Our first flight together.', pins)
        self.assertLess(len(pins), 2000)

    def test_end_one_summary_call_records_applied_per_participant_and_deduped(self):
        scene = self.create(participants=['Iris', 'Nora'])
        self.manager.end(scene['id'])
        ended = self.drain(scene['id'])
        self.assertEqual(self.invoke.call_count, 1)
        for name in ('Iris', 'Nora'):
            store = server.life_store(name)
            rows = store.load_segment('events')
            self.assertEqual(len(rows), 1)
            self.assertTrue(rows[0]['text'].startswith('We met in person:'))
            self.assertEqual(rows[0]['source_id'], scene['id'])
            store.apply([self.record(name, text=rows[0]['text'])], embed=False)
            self.assertEqual(len(store.load_segment('events')), 1)
            agent = next(a for a in self.config['agents'] if a['name'] == name)
            question = dict(id='question', name='Mystery', text='Do you remember our ship observation deck outing?',
                            time=scenes.now(), kind='chat', channel='group')
            self.assertIn('We met in person:', server.make_prompt(agent, [question], self.config['agents'], question))
        self.assertEqual(ended['status'], 'ended')

    def test_per_turn_memory_records_also_marked_in_person(self):
        scene = self.create(opening='We enter the ship.')
        self.drain(scene['id'])
        self.assertTrue(server.life_store('Iris').load_segment('events')[0]['text'].startswith('We met in person:'))

    def test_summary_does_not_overwrite_core_notes_or_scores(self):
        server.remember('Iris', 'I am Iris, growing fond of Mystery.')
        server.relationships.save('Iris', {'Mystery': {'like': 125, 'dislike': 0}})
        scene = self.create()
        self.manager.end(scene['id'])
        self.drain(scene['id'])
        self.assertEqual(server.memories()['Iris'], 'I am Iris, growing fond of Mystery.')
        self.assertEqual(server.relationships.load()['Iris']['Mystery']['like'], 125)

    def test_scene_reply_preserves_love_with_mood_and_uses_configured_ceiling(self):
        server.relationships.save('Iris', {'Mystery': {'like': 210, 'dislike': 2}})
        self.invoke.side_effect = None
        self.invoke.return_value = json.dumps(dict(message='*I pause.* That hurt, but I still care.',
            memory='I love Mystery and feel hurt.', scores={'Mystery': {'like': 62, 'dislike': 90}},
            mood={'Mystery': {'hurt': 10}}, to=None))
        scene = self.create(opening='We disagree aboard the ship.')
        self.drain(scene['id'])
        scores = server.relationships.load()['Iris']['Mystery']
        self.assertEqual((scores['like'], scores['dislike']), (207, 12))
        self.assertEqual(scores['mood']['hurt'], 5)
        prompt = self.invoke.call_args.args[1]
        for phrase in ('HOW YOU FEEL NOW', '"like": 210', '0–1500',
                       'conflict with someone you love changes your mood, not your love'):
            self.assertIn(phrase, prompt)

    def test_summary_awards_mutual_scene_gains_once_even_after_metadata_retry(self):
        server.relationships.save('Iris', {'Mystery': {'like': 210, 'dislike': 2},
                                          'Nora': {'like': 1490, 'dislike': 1}})
        server.relationships.save('Nora', {'Iris': {'like': 80, 'dislike': 3}})
        real_provider = self.provider
        def provider(agent, prompt, timeout, images=None):
            result = json.loads(real_provider(agent, prompt, timeout, images))
            result['bond_gains'] = [dict(names=['Iris', 'Mystery'], like=25),
                                    dict(names=['Iris', 'Nora'], like=25)]
            return json.dumps(result)
        self.invoke.side_effect = provider
        scene = self.create(participants=['Iris', 'Nora'])
        self.manager.end(scene['id'])
        original_save = self.manager.save
        def save(meta):
            if meta['status'] == 'ended':
                raise OSError('mock metadata failure after award')
            return original_save(meta)
        with patch.object(self.manager, 'save', side_effect=save), self.assertLogs('scenes', level='ERROR'):
            self.assertEqual(self.drain(scene['id'])['status'], 'active')
        self.manager.end(scene['id'])
        self.assertEqual(self.drain(scene['id'])['status'], 'ended')
        scores = server.relationships.load()
        self.assertEqual(scores['Iris']['Mystery']['like'], 235)
        self.assertEqual(scores['Iris']['Mystery']['dislike'], 2)
        self.assertEqual(scores['Iris']['Nora']['like'], 1500)
        self.assertEqual(scores['Nora']['Iris']['like'], 105)
        self.assertEqual(len(server.life_store('Iris').load_segment('events')), 1)

    def test_invalid_summary_gain_is_clamped_and_summary_preserved(self):
        real_provider = self.provider
        def provider(agent, prompt, timeout, images=None):
            result = json.loads(real_provider(agent, prompt, timeout, images))
            result['bond_gains'] = [dict(names=['Iris', 'Mystery'], like=26)]
            return json.dumps(result)
        self.invoke.side_effect = provider
        scene = self.create()
        self.manager.end(scene['id'])
        self.assertEqual(self.drain(scene['id'])['status'], 'ended')
        self.assertTrue(server.life_store('Iris').index())
        self.assertEqual(server.relationships.load()['Iris']['Mystery']['like'], 25)

    def test_scene_provider_failure_uses_existing_fallback_and_timeouts(self):
        real_provider = self.provider
        def provider(agent, prompt, timeout, images=None):
            if agent['provider'] == 'claude':
                raise server.ProviderTimeout('mock timeout')
            return real_provider(agent, prompt, timeout, images)
        self.invoke.side_effect = provider
        scene = self.create(opening='The hatch opens.')
        replied = self.drain(scene['id'])
        self.assertEqual(self.invoke.call_count, 2)
        self.assertEqual(replied['messages'][-1]['served_by'], 'cursor/auto')
        self.assertLessEqual(self.invoke.call_args_list[0].args[2], server.provider_timeout(self.agent, self.config))
        self.assertLessEqual(self.invoke.call_args_list[1].args[2], 90)

    def test_summary_uses_existing_fallback_path(self):
        real_provider = self.provider
        self.invoke.side_effect = lambda agent, prompt, timeout, images=None: (
            real_provider(agent, prompt, timeout, images) if agent['provider'] == 'cursor'
            else (_ for _ in ()).throw(server.ProviderTimeout('mock timeout')))
        scene = self.create()
        self.manager.end(scene['id'])
        self.assertEqual(self.drain(scene['id'])['status'], 'ended')
        self.assertEqual(self.invoke.call_count, 2)

    def test_all_provider_failures_leave_scene_usable_without_group_error(self):
        self.invoke.side_effect = server.ProviderTimeout('account diagnostics must stay out of transcript')
        scene = self.create(opening='Let us explore.')
        with self.assertLogs('scenes', level='ERROR'):
            result = self.drain(scene['id'])
        self.assertEqual(result['status'], 'active')
        self.assertFalse(result['busy'])
        self.assertEqual(result['messages'][-1]['kind'], 'system')
        self.assertNotIn('account diagnostics', result['messages'][-1]['text'])
        self.assertEqual(server.history(), [])
        server.PROVIDER_BREAKS.clear()
        self.invoke.side_effect = self.provider
        self.manager.post(scene['id'], {'text': 'I try another door.'})
        self.assertEqual(self.drain(scene['id'])['messages'][-1]['name'], 'Iris')

    def test_failed_participant_does_not_skip_other_participants(self):
        real_provider = self.provider
        def provider(agent, prompt, timeout, images=None):
            if agent['name'] == 'Nora':
                raise ValueError('mock invalid output')
            return real_provider(agent, prompt, timeout, images)
        self.invoke.side_effect = provider
        scene = self.create(participants=['Nora', 'Iris'], opening='We arrive.')
        with self.assertLogs('scenes', level='ERROR'):
            result = self.drain(scene['id'])
        self.assertEqual([m['name'] for m in result['messages']], ['Mystery', 'Room', 'Iris'])
        self.assertFalse(result['busy'])

    def test_failed_end_leaves_active_for_retry_and_does_not_announce_return(self):
        scene = self.create(visibility='announced')
        self.invoke.side_effect = RuntimeError('mock crash')
        self.manager.end(scene['id'])
        with self.assertLogs('scenes', level='ERROR'):
            failed = self.drain(scene['id'])
        self.assertEqual(failed['status'], 'active')
        self.assertFalse(failed['busy'])
        self.assertTrue(self.manager.away_reason('Iris'))
        self.assertEqual(len(server.history()), 1)
        self.invoke.side_effect = self.provider
        self.manager.end(scene['id'])
        self.assertEqual(self.drain(scene['id'])['status'], 'ended')
        self.assertEqual(len(server.history()), 2)

    def test_missing_optional_summary_records_preserve_summary(self):
        self.invoke.side_effect = None
        self.invoke.return_value = json.dumps(dict(message='A shared outing.', memory='Summary.',
                                                   remember=[self.record('Iris')], to=None))
        scene = self.create(participants=['Iris', 'Nora'])
        self.manager.end(scene['id'])
        ended = self.drain(scene['id'])
        self.assertEqual(ended['status'], 'ended')
        self.assertTrue(server.life_store('Iris').index())
        self.assertFalse(server.life_store('Nora').index().get('records'))

    def test_busy_scene_refuses_overlapping_move_and_end(self):
        scene = self.create(opening='We arrive.')
        for action in (lambda: self.manager.post(scene['id'], {'text': 'Another move'}), lambda: self.manager.end(scene['id'])):
            with self.assertRaises(scenes.SceneError) as error:
                action()
            self.assertEqual(error.exception.code, 409)
        self.assertEqual(len(self.manager.get(scene['id'])['messages']), 1)

    def test_atomic_message_write_failure_preserves_previous_transcript(self):
        scene = self.create()
        self.manager.append(scene['id'], 'Mystery', 'First move', 'narration')
        with patch.object(scenes.storage.os, 'replace', side_effect=OSError('mock disk failure')):
            with self.assertRaises(OSError):
                self.manager.append(scene['id'], 'Mystery', 'Second move', 'narration')
        self.assertEqual(len(self.manager.get(scene['id'])['messages']), 1)
        self.assertEqual(sorted(p.name for p in self.manager.directory(scene['id']).iterdir()), ['messages.jsonl', 'meta.json'])

    def test_images_use_existing_upload_and_provider_inputs(self):
        scene = self.create()
        image = 'data:image/png;base64,iVBORw0KGgp0ZXN0aW1hZ2U='
        self.manager.post(scene['id'], {'text': '', 'image': image})
        replied = self.drain(scene['id'])
        attachment = replied['messages'][0]['attachments'][0]
        self.assertEqual(chat_images.checked(attachment).parent, chat_images.DIRECTORY)
        self.assertEqual(self.invoke.call_args.kwargs['images'], [Path(attachment)])

    def test_validation_and_invalid_scene_ids(self):
        for data in ({'participants': []}, {'participants': ['Iris', 'Iris']}, {'participants': ['Mystery']},
                     {'participants': [None]}, {'participants': ['Unknown']}, {'kind': 'wrong'},
                     {'visibility': 'public'}, {'title': ''}, {'location': ''}, {'opening': 'x' * 4001}):
            with self.subTest(data=data), self.assertRaises(scenes.SceneError):
                self.create(**data)
        for scene_id in ('../outside', '/tmp', 'a' * 32):
            with self.subTest(scene_id=scene_id), self.assertRaises(scenes.SceneError):
                self.manager.get(scene_id)
        scene = self.create()
        for data in ({'text': ''}, {'text': None}, {'text': 'x' * 4001}, {'image': 'invalid'}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                self.manager.post(scene['id'], data)
        self.assertEqual(self.manager.get(scene['id'])['messages'], [])

    def request(self, path, method='GET', body=None, origin=None):
        class Handler:
            def __init__(self):
                encoded = json.dumps(body).encode() if body is not None else b''
                self.rfile = io.BytesIO(encoded)
                self.headers = {'Content-Length': str(len(encoded)), 'Host': 'localhost:8765'}
                if origin:
                    self.headers['Origin'] = origin
                self.result = None
            def send_json(self, data, code=200):
                self.result = code, data
            def send_payload(self, payload, content_type, code=200):
                self.result = code, payload, content_type
        handler = Handler()
        self.assertTrue(self.manager.handle(handler, path, method))
        return handler.result

    def test_http_routes_json_origin_guard_assets_and_errors(self):
        for path in ('/scenes', '/scene.html', '/scene.js', '/scene.css'):
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 200)
        self.assertEqual(self.request('/api/scenes'), (200, []))
        data = dict(participants=['Iris'], title='A walk', location='Garden')
        self.assertEqual(self.request('/api/scenes', 'POST', data, 'http://elsewhere')[0], 403)
        self.assertEqual(self.request('/api/scenes', 'POST', [])[0], 400)
        code, created = self.request('/api/scenes', 'POST', data)
        self.assertEqual(code, 201)
        path = '/api/scenes/' + created['id']
        self.assertEqual(self.request(path)[0], 200)
        self.assertEqual(self.request(path + '/moves', 'POST', {'text': 'We walk.'})[0], 202)
        self.assertEqual(self.request(path + '/moves', 'POST', {'text': 'Too soon.'})[0], 409)
        self.drain(created['id'])
        self.assertEqual(self.request(path + '/end', 'POST', {})[0], 202)
        self.drain(created['id'])
        self.assertEqual(self.request('/api/scenes/invalid')[0], 404)
        self.assertEqual(self.request(path + '/wrong', 'POST', {})[0], 404)

    def test_scene_audio_attachment_routes_reuse_checked_helpers(self):
        scene = self.create()
        self.manager.post(scene['id'], {'text': 'Look!', 'image': 'data:image/png;base64,iVBORw0KGgp0ZXN0aW1hZ2U='})
        scene = self.drain(scene['id'])
        path = '/api/scenes/' + scene['id']
        image_id, reply_id = [m['id'] for m in scene['messages']]
        self.assertEqual(self.request(path + f'/attachment/{image_id}/0')[0], 200)
        self.assertEqual(self.request(path + f'/attachment/{image_id}/1')[0], 404)
        self.assertEqual(self.request(path + '/attachment/123/0')[0], 404)
        wav = Path(self.temp.name) / 'test.wav'
        wav.write_bytes(b'test audio')
        with patch.object(server.speech, 'audio_for', return_value=wav) as audio:
            self.assertEqual(self.request(path + f'/audio/{reply_id}.wav')[0], 200)
            audio.assert_called_once_with(scene['messages'][1]['text'], self.agent['voice'])
        self.assertEqual(self.request(path + f'/audio/{image_id}.wav')[0], 404)

    def test_active_scenes_sort_first(self):
        ended = self.create()
        self.manager.end(ended['id'])
        self.drain(ended['id'])
        active = self.create(participants=['Nora'])
        self.assertEqual([m['id'] for m in self.manager.list()], [active['id'], ended['id']])

    def test_background_worker_exposes_speaker_and_releases_reservation(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        real_provider = self.provider
        real_work = self.manager.work
        def provider(agent, prompt, timeout, images=None):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('test worker was not released')
            return real_provider(agent, prompt, timeout, images)
        def work(*args):
            try:
                real_work(*args)
            finally:
                finished.set()
        self.invoke.side_effect = provider
        with patch.object(threading.Thread, 'start', THREAD_START), patch.object(self.manager, 'work', side_effect=work):
            scene = self.create(opening='We enter the ship.')
            try:
                self.assertTrue(entered.wait(2))
                active = self.manager.get(scene['id'])
                self.assertTrue(active['busy'])
                self.assertEqual(active['speaker'], 'Iris')
                self.assertEqual(len(active['messages']), 1)
                self.assertEqual(self.request('/api/scenes/' + scene['id'])[0], 200)
            finally:
                release.set()
                self.assertTrue(finished.wait(3))
        self.assertFalse(self.manager.get(scene['id'])['busy'])
        self.assertEqual(self.manager.get(scene['id'])['messages'][-1]['name'], 'Iris')

    def test_real_group_turn_selects_only_remaining_available_characters(self):
        self.create()
        nora = next(a for a in self.config['agents'] if a['name'] == 'Nora')
        config = dict(self.config, agents=[self.agent, nora])
        server.ACTIVE.set()
        server.STATE.update(turns=0, limit=12, speaker=None)
        try:
            server.run_turn(config)
            self.assertEqual(server.history()[-1]['name'], 'Nora')
            self.assertEqual(self.manager.get(self.manager.list()[0]['id'])['messages'], [])
        finally:
            server.ACTIVE.clear()
            server.STATE.update(speaker=None, turns=0, limit=24, reason='Ready')


if __name__ == '__main__':
    unittest.main()
