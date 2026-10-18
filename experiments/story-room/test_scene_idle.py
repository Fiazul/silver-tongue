"""Idle operator-scene dialogue, real storage and scheduling, no live providers."""
from datetime import datetime
import json
from pathlib import Path
from unittest.mock import patch

import chat_images
import scenes
import server
import test_scenes
from test_support import HermeticTestCase


class IdleSceneTests(HermeticTestCase):
    setUp = test_scenes.SceneTests.setUp
    create = test_scenes.SceneTests.create
    drain = test_scenes.SceneTests.drain
    provider = test_scenes.SceneTests.provider
    record = test_scenes.SceneTests.record
    request = test_scenes.SceneTests.request

    def active_scene(self):
        scene = self.create(participants=['Iris', 'Vella'], opening='We watch the lake together.')
        self.drain(scene['id'])
        return scene['id']

    def due(self, sid):
        latest = self.manager.messages(sid)[-1]['time']
        stamp = max(datetime.fromisoformat(latest).timestamp(), self.manager.meta(sid).get('conversation_next_at', 0))
        return patch.object(scenes.time, 'time', return_value=stamp + 21)

    def test_silence_gives_iris_a_turn_after_vella_without_a_user_move(self):
        sid = self.active_scene()
        with self.due(sid):
            self.manager.tick()
            self.manager.tick()
            self.assertEqual(self.manager.jobs[sid]['operation'], 'idle')
            self.drain(sid)
        self.assertEqual([m['name'] for m in self.manager.messages(sid)], ['Mystery', 'Iris', 'Vella', 'Iris'])
        with self.due(sid):
            self.manager.tick()
            self.drain(sid)
        self.assertEqual([m['name'] for m in self.manager.messages(sid)][-2:], ['Iris', 'Vella'])
        self.assertEqual(sum(m['name'] == 'Mystery' for m in self.manager.messages(sid)), 1)

    def test_idle_reply_receives_vellas_latest_photo_and_words(self):
        sid = self.active_scene()
        path = chat_images.store('data:image/png;base64,iVBORw0KGgp0ZXN0aW1hZ2U=')
        self.manager.append(sid, 'Vella', 'Iris, look at this lake photo.', attachments=[path])
        with self.due(sid):
            self.manager.tick()
            self.drain(sid)
        self.assertIn('Vella: Iris, look at this lake photo.', self.invoke.call_args.args[1])
        self.assertEqual(self.invoke.call_args.kwargs['images'], [Path(path)])
        self.assertEqual(self.manager.messages(sid)[-1]['name'], 'Iris')

    def test_background_loop_schedules_operator_scenes_while_room_is_paused(self):
        sid = self.active_scene()
        server.ACTIVE.clear()
        with self.due(sid), patch.object(server.STOP, 'wait', side_effect=[False, True]):
            server.MEETUPS.loop()
        self.assertEqual(self.manager.jobs[sid]['operation'], 'idle')
        self.drain(sid)
        self.assertEqual(self.manager.messages(sid)[-1]['name'], 'Iris')

    def test_no_idle_turn_for_empty_single_paused_ended_or_autonomous_scene(self):
        for mode in ('empty', 'single', 'paused', 'ended', 'autonomous'):
            with self.subTest(mode=mode):
                # Release the participants between cases without a provider call.
                for old in self.manager.list():
                    old['status'] = 'ended'; self.manager.save(old)
                scene = self.create(participants=['Iris'] if mode == 'single' else ['Iris', 'Vella'])
                sid = scene['id']
                if mode != 'empty':
                    self.manager.append(sid, 'Vella' if mode != 'single' else 'Iris', 'Quiet.')
                meta = self.manager.meta(sid)
                if mode == 'paused': meta['conversation_paused'] = True
                if mode == 'ended': meta['status'] = 'ended'
                if mode == 'autonomous': meta['autonomous'] = True
                self.manager.save(meta)
                with patch.object(scenes.time, 'time', return_value=9999999999):
                    self.manager.tick()
                self.assertFalse(self.manager.jobs)

    def test_idle_waits_for_quiet_and_runs_even_when_room_is_paused(self):
        sid = self.active_scene()
        server.ACTIVE.clear()
        self.manager.tick()
        self.assertNotIn(sid, self.manager.jobs)
        with self.due(sid):
            self.manager.tick()
            self.drain(sid)
        self.assertEqual(self.manager.messages(sid)[-1]['name'], 'Iris')

    def test_new_user_move_discards_inflight_idle_draft_and_queues_real_reply(self):
        sid = self.active_scene()
        def interrupted(agent, prompt, timeout, images=None):
            self.manager.post(sid, {'text': 'I have a new plan.'})
            return json.dumps(dict(message='OBSOLETE IDLE DRAFT', memory='Old context.', to=None))
        self.invoke.side_effect = interrupted
        with self.due(sid):
            self.manager.tick()
            self.drain(sid)
        self.assertNotIn('OBSOLETE IDLE DRAFT', [m['text'] for m in self.manager.messages(sid)])
        self.assertEqual(self.manager.messages(sid)[-1]['text'], 'I have a new plan.')
        self.assertEqual(self.manager.get(sid)['operation'], 'reply')
        self.invoke.side_effect = self.provider
        self.drain(sid)
        self.assertEqual([m['name'] for m in self.manager.messages(sid)][-3:], ['Mystery', 'Iris', 'Vella'])

    def test_pause_during_idle_discards_draft_and_resume_waits_again(self):
        sid = self.active_scene()
        def interrupted(agent, prompt, timeout, images=None):
            self.manager.conversation(sid, {'paused': True})
            return json.dumps(dict(message='OBSOLETE PAUSED DRAFT', memory='Quiet.', to=None))
        self.invoke.side_effect = interrupted
        with self.due(sid):
            self.manager.tick()
            self.drain(sid)
            self.manager.tick()
        self.assertFalse(self.manager.jobs)
        self.assertNotIn('OBSOLETE PAUSED DRAFT', [m['text'] for m in self.manager.messages(sid)])
        self.assertTrue(self.manager.get(sid)['conversation_paused'])
        self.manager.conversation(sid, {'paused': False})
        self.manager.tick()
        self.assertFalse(self.manager.jobs)

    def test_end_during_idle_discards_draft_and_queues_summary(self):
        sid = self.active_scene()
        def interrupted(agent, prompt, timeout, images=None):
            self.manager.end(sid)
            return json.dumps(dict(message='OBSOLETE END DRAFT', memory='Quiet.', to=None))
        self.invoke.side_effect = interrupted
        with self.due(sid):
            self.manager.tick()
            self.drain(sid)
        self.assertNotIn('OBSOLETE END DRAFT', [m['text'] for m in self.manager.messages(sid)])
        self.assertEqual(self.manager.get(sid)['operation'], 'end')

    def test_unavailable_or_resting_next_actor_does_not_monologue(self):
        sid = self.active_scene()
        iris = next(a for a in self.config['agents'] if a['name'] == 'Iris')
        for kind in ('disabled', 'unreachable', 'resting'):
            with self.subTest(kind=kind):
                iris['enabled'] = kind != 'disabled'
                with self.due(sid), patch.object(server, 'reachable', side_effect=lambda a,c: kind != 'unreachable' or a['name'] != 'Iris'), patch.object(server, 'resting_reason', side_effect=lambda a,c: 'Asleep' if kind == 'resting' and a['name'] == 'Iris' else ''):
                    self.manager.tick()
                self.assertFalse(self.manager.jobs)

    def test_failed_idle_turn_waits_before_retry_and_does_not_spam_transcript(self):
        sid = self.active_scene()
        before = len(self.manager.messages(sid))
        self.invoke.side_effect = RuntimeError('provider unavailable')
        with self.due(sid), self.assertLogs(level='WARNING'):
            self.manager.tick()
            self.drain(sid)
            self.manager.tick()
        self.assertFalse(self.manager.jobs)
        self.assertEqual(len(self.manager.messages(sid)), before)

    def test_conversation_route_validates_boolean_and_origin(self):
        sid = self.active_scene()
        path = f'/api/scenes/{sid}/conversation'
        self.assertEqual(self.request(path, 'POST', {'paused': True})[0], 200)
        self.assertTrue(self.manager.meta(sid)['conversation_paused'])
        self.assertEqual(self.request(path, 'POST', {'paused': False}, origin='http://evil.test')[0], 403)
        self.assertTrue(self.manager.meta(sid)['conversation_paused'])
        self.assertEqual(self.request(path, 'POST', {'paused': 'false'})[0], 400)
        self.assertEqual(self.request(path, 'POST', {'paused': False})[0], 200)
        self.assertFalse(self.manager.meta(sid)['conversation_paused'])
