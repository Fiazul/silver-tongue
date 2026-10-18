"""Hermetic regression coverage for visible photo references and re-sharing."""
import base64
import json
from types import SimpleNamespace
from unittest.mock import patch

import photo_stash
import server
from test_support import HermeticTestCase

PNG = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\nfixture photo').decode()


class PhotoReferenceTests(HermeticTestCase):
    def setUp(self):
        self.config = server.load_config()
        self.config['embeddings'] = {'enabled': False}
        self.agent = next(a for a in self.config['agents'] if a['name'] == 'Ji-woo')
        self.stash = photo_stash.Stash(server.DATA, 'The Merchant')
        item = self.stash.add(dict(image=PNG, description='Ji-woo beside the stream at sunrise',
                                   audience=[], note='PRIVATE HINT'), ['Ji-woo'])
        self.path = str(self.stash.path(item))
        self.recalled = SimpleNamespace(block='', records=[], images=[], recall=False)
        for name, options in [('load_config', {'return_value': self.config}), ('observe_message', {})]:
            patcher = patch.object(server, name, **options)
            patcher.start()
            self.addCleanup(patcher.stop)

    def scene(self, participants=None):
        with patch.object(server, 'resting_reason', return_value=''), patch.object(server, 'reachable', return_value=True):
            return server.SCENES.create(dict(participants=participants or ['Ji-woo'], kind='hangout',
                                             title='Stream visit', location='Stream'))

    def reply(self, prompt, token, focus=None):
        result = dict(message='Here is that photo.', memory='We shared a photo.',
                      attachments=[token], to='Mystery' if focus else None)
        with patch.object(server, 'invoke', return_value=json.dumps(result)):
            return server.serve_turn(self.agent, prompt, [], self.config, self.config['agents'], focus, not focus)

    def token(self, prompt):
        import re
        match = re.search(r'\bimg:\d+\b', prompt)
        self.assertIsNotNone(match, prompt)
        return match[0]

    def assert_prompt(self, prompt):
        self.assertIn('IMAGES YOU HAVE SEEN', prompt)
        self.assertIn('Ji-woo beside the stream at sunrise', prompt)
        self.assertIn('never invent photos or details in them', prompt)
        self.assertNotIn(self.path, prompt)
        self.assertNotIn(str(server.DATA), prompt)
        self.assertNotIn('PRIVATE HINT', prompt)
        self.assertRegex(prompt, r'\[image #\d+: Ji-woo beside the stream at sunrise\]')

    def test_scene_label_and_cross_character_stash_reshare(self):
        meta = self.scene()
        server.SCENES.append(meta['id'], 'The Merchant', 'A candid.', attachments=[self.path])
        rows = server.SCENES.messages(meta['id'])
        prompt = server.SCENES.prompt(self.agent, meta, rows, self.config, self.recalled, '')
        self.assert_prompt(prompt)
        turn = self.reply(prompt, self.token(prompt))
        self.assertEqual(turn[2], [self.path])
        posted = server.SCENES.append(meta['id'], 'Ji-woo', turn[0], attachments=turn[2])
        self.assertEqual(server.turn_images([posted], self.recalled), [server.attachment_path(self.path)])

    def test_dm_label_reshare_and_recipient_vision(self):
        focus = server.append('Mystery', 'Show this again.', recipient='Ji-woo', attachments=[self.path])
        prompt = server.make_prompt(self.agent, server.history(), self.config['agents'], focus, config=self.config)
        self.assert_prompt(prompt)
        turn = self.reply(prompt, self.token(prompt), focus)
        self.assertEqual(turn[2], [self.path])
        posted = server.append('Ji-woo', turn[0], recipient='Mystery', attachments=turn[2])
        self.assertEqual(server.turn_images([posted], self.recalled), [server.attachment_path(self.path)])

    def test_unseen_dm_reference_ignored_message_kept(self):
        focus = server.append('Mystery', 'Secret photo.', recipient='The Merchant', attachments=[self.path])
        merchant = next(a for a in self.config['agents'] if a['name'] == 'The Merchant')
        token = self.token(server.make_prompt(merchant, server.history(), self.config['agents'], focus, config=self.config))
        prompt = server.make_prompt(self.agent, server.history(), self.config['agents'], config=self.config)
        with self.assertLogs('server', level='WARNING'):
            turn = self.reply(prompt, token)
        self.assertEqual(turn[2], [])
        self.assertEqual(turn[0], 'Here is that photo.')

    def test_meetup_renderer_and_cross_context_stability(self):
        focus = server.append('Mystery', 'Look.', recipient='Ji-woo', attachments=[self.path])
        room = server.make_prompt(self.agent, server.history(), self.config['agents'], focus, config=self.config)
        meta = self.scene()
        meta.update(autonomous=True, mystery_joined=True, exchanges=1)
        row = server.SCENES.append(meta['id'], 'Mystery', 'Again.', attachments=[self.path])
        prompt = server.MEETUPS.scene_prompt(self.agent, meta, [row], self.config, self.recalled, '')
        self.assert_prompt(prompt)
        self.assertEqual(self.token(room), self.token(prompt))

    def test_private_scene_is_not_authority_for_nonparticipant(self):
        meta = self.scene(['The Merchant'])
        server.SCENES.append(meta['id'], 'The Merchant', 'Private.', attachments=[self.path])
        merchant = next(a for a in self.config['agents'] if a['name'] == 'The Merchant')
        token = next(iter(server.image_references(merchant).entries))
        with self.assertLogs('server', level='WARNING'):
            turn = self.reply(server.image_references(self.agent).prompt(), token)
        self.assertEqual(turn[2], [])
        self.assertEqual(turn[0], 'Here is that photo.')

    def test_reset_or_missing_file_revokes_reference(self):
        row = server.append('Mystery', 'Photo.', recipient='Ji-woo', attachments=[self.path])
        token = next(iter(server.image_references(self.agent).entries))
        with patch.object(server, 'reset_boundaries', return_value={'Ji-woo': int(row['id']) + 1}):
            with self.assertLogs('server', level='WARNING'):
                self.assertEqual(self.reply('', token)[2], [])
        from pathlib import Path
        Path(self.path).unlink()  # Disposable fixture only.
        with self.assertLogs('server', level='WARNING'):
            self.assertEqual(self.reply('', token)[2], [])

    def test_catalog_caps_recent_images_and_ids_survive_new_history(self):
        first = None
        for index in range(10):
            image = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\nfixture' + bytes([index])).decode()
            path = server.chat_images.store(image)
            server.append('Mystery', 'Photo.', recipient='Ji-woo', attachments=[path])
            if first is None:
                first = next(iter(server.image_references(self.agent).entries))
        photos = server.image_references(self.agent)
        self.assertEqual(len(photos.prompt().split('IMAGES YOU HAVE SEEN')[1].splitlines()[1:]), 8)
        self.assertIn(first, photos.entries)
        self.assertNotIn(first + ' →', photos.prompt())
        self.assertEqual(self.reply(photos.prompt(), first)[2], [photos.entries[first][0]])

    def test_alarm_room_and_scene_use_labels_and_reshare_real_images(self):
        server.append('Mystery', 'Photo.', recipient='Ji-woo', attachments=[self.path])
        token = next(iter(server.image_references(self.agent).entries))
        alarm = dict(created_at='2026-10-16T00:00:00+00:00', to='Mystery', channel='dm', intent='Share the photo')
        prompts = []
        def provider(agent, prompt, timeout, images=None):
            prompts.append(prompt)
            self.assertEqual(images, [server.attachment_path(self.path)])
            return json.dumps(dict(message='Here.', memory='We share photos.', attachments=[token], to='Mystery' if 'Send it privately' in prompt else None))
        with patch.object(server, 'invoke', side_effect=provider), patch.object(server.TIMEKEEPER, 'spawn'):
            posted = server.TIMEKEEPER.room_turn(alarm, self.agent, self.config)
            self.assertEqual(posted['attachments'], [self.path])
            meta = self.scene()
            server.SCENES.append(meta['id'], 'Mystery', 'Photo.', attachments=[self.path])
            posted = server.TIMEKEEPER.scene_turn(alarm, self.agent, meta, self.config)
            self.assertEqual(posted['attachments'], [self.path])
        self.assertEqual(len(prompts), 2)
        for prompt in prompts:
            self.assert_prompt(prompt)
