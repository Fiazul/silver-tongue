import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from test_support import HermeticTestCase
import server

try:
    import story_bible
except ImportError:
    story_bible = None


class EditableBibleTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(story_bible, 'Editable character files are not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'characters').mkdir()
        self.profile = dict(id='minjun', name='Kim Min-jun', gender='male', personality='Observant.',
                            appearance='A grey coat.',
                            backstory='A Korean student learning English.', goals='Practice conversation.',
                            dialogue_style='Plain and curious.', instructions='Do not invent a disappearance.')
        (self.root / 'characters/minjun.json').write_text(json.dumps(self.profile))
        self.config = {'agents': [{'id': 'minjun', 'name': 'Kim Min-jun', 'provider': 'codex', 'model': 'test'}]}
        (self.root / 'world.json').write_text(json.dumps(dict(title='Story room', setting='Seoul, 2000',
                                                public_context='No smartphones.', premise='A stranger wakes here.',
                                                unknowns=[], player={'name': 'You', 'backstory': 'A newcomer.'})))

    def test_editor_save_updates_the_next_runtime_profile_and_survives_reload(self):
        profile = story_bible.profile(self.root, 'minjun')
        story_bible.save_profile(self.root, 'minjun', {'backstory': 'He now teaches at the university.'}, profile['revision'])
        loaded = story_bible.overlay(self.root, self.config)
        self.assertEqual(loaded['agents'][0]['backstory'], 'He now teaches at the university.')
        self.assertEqual(loaded['agents'][0]['name'], 'Kim Min-jun')
        self.assertEqual(loaded['story_world']['setting'], 'Seoul, 2000')

    def test_stale_editor_cannot_overwrite_a_newer_save(self):
        before = story_bible.profile(self.root, 'minjun')['revision']
        story_bible.save_profile(self.root, 'minjun', {'goals': 'Find a job.'}, before)
        with self.assertRaises(story_bible.EditError) as caught:
            story_bible.save_profile(self.root, 'minjun', {'goals': 'Old draft.'}, before)
        self.assertEqual(caught.exception.code, 409)
        self.assertEqual(story_bible.profile(self.root, 'minjun')['goals'], 'Find a job.')

    def test_invalid_edits_and_paths_do_not_change_profile_files(self):
        original = (self.root / 'characters/minjun.json').read_bytes()
        revision = story_bible.profile(self.root, 'minjun')['revision']
        for change in [{'backstory': []}, {'enabled': 'yes'}, {'personality': ''}, {'provider': 'untrusted'}]:
            with self.subTest(change=change), self.assertRaises(story_bible.EditError):
                story_bible.save_profile(self.root, 'minjun', change, revision)
        with self.assertRaises(story_bible.EditError):
            story_bible.profile(self.root, '../agents')
        self.assertEqual((self.root / 'characters/minjun.json').read_bytes(), original)

    def test_only_own_backstory_and_shared_world_enter_identity_prompt(self):
        import characters
        loaded = story_bible.overlay(self.root, self.config)
        actor = loaded['agents'][0]
        prompt = characters.identity(actor)
        self.assertIn('A Korean student learning English.', prompt)
        self.assertIn('Seoul, 2000', prompt)
        self.assertIn('A grey coat.', prompt)
        self.assertNotIn('Ji-woo', prompt)
        self.assertNotIn('The Merchant', prompt)

    def test_multiword_names_work_in_memory_and_stash_without_path_traversal(self):
        import life_memory
        import photo_stash
        self.assertEqual(life_memory.Store(self.root, 'Grandpa Park').directory.name, 'Grandpa Park')
        self.assertEqual(photo_stash.Stash(self.root, 'The landlady').name, 'The landlady')
        with self.assertRaises(ValueError):
            life_memory.Store(self.root, '../escape')

    def test_clearing_optional_appearance_keeps_the_runtime_configuration_valid(self):
        import characters
        revision = story_bible.profile(self.root, 'minjun')['revision']
        saved = story_bible.save_profile(self.root, 'minjun', {'appearance': ''}, revision)
        self.assertNotIn('appearance', saved)
        characters.validate_room_roles(story_bible.overlay(self.root, self.config)['agents'][0])


class MigratedPromptTests(HermeticTestCase):
    def test_real_room_prompt_uses_the_game_prompt_builder(self):
        config = server.load_config()
        config['story_world'] = {'setting': 'Seoul, 2000'}
        actor = dict(config['agents'][0], id='minjun', name='Kim Min-jun')
        config['agents'] = [actor]
        with patch.object(server.story_bible, 'roleplay_prompt', return_value='selected-game-prompt') as build:
            result = server.make_prompt(actor, [], [actor], config=config,
                                        recalled=SimpleNamespace(block='', records=[]))
        self.assertEqual(result, 'selected-game-prompt')
        build.assert_called_once()

    def test_game_world_does_not_break_the_existing_contact_scheduler(self):
        config = server.load_config()
        config['story_world'] = {'setting': 'Seoul, 2000'}
        actor = config['agents'][0]
        with patch.object(server.engagement, 'longing', return_value={}) as contact:
            self.assertEqual(server.longing_for(actor, config['agents'], [], config), {})
        contact.assert_called_once()


if __name__ == '__main__':
    unittest.main()
