import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import launch_story

try:
    import story_edition
except ImportError:
    story_edition = None


class BibleTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(story_edition, 'Story edition bible is not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        self.life = self.data / 'life' / 'Ji-woo'
        self.life.mkdir(parents=True)
        self.config = {'agents': [{'name': 'Ji-woo', 'age': 27, 'personality': 'Precise and curious.',
                                  'appearance': 'An apron at the stall.', 'sibling': 'Kim Min-jun'}]}
        self.write(self.data / 'memories.json', {'Ji-woo': 'I remember the stall.'})
        self.write(self.data / 'relationships.json', {'Ji-woo': {'Mystery': {'like': 240, 'dislike': 2}},
                                                     'Kim Min-jun': {'Mystery': {'like': 20}}})

    def write(self, path, value):
        path.write_text(json.dumps(value))

    def test_profile_and_attributed_continuity_have_separate_sources(self):
        bible = story_edition.build_bible(self.root, self.config)
        jiwoo = bible['characters'][0]
        self.assertEqual(jiwoo['personality'], 'Precise and curious.')
        self.assertEqual(jiwoo['memory'], 'I remember the stall.')
        self.assertEqual(jiwoo['sources']['profile'], 'agents.json')
        self.assertEqual(jiwoo['sources']['memory'], 'data/memories.json')
        self.assertEqual(list(jiwoo['relationships']), ['Mystery'])
        self.assertEqual(jiwoo['relationships']['Mystery']['like'], 240)
        self.assertEqual(bible['player']['name'], 'Player')

    def test_superseded_records_and_pre_reset_evidence_are_excluded(self):
        self.write(self.data / 'character-resets.json', {'Ji-woo': 100})
        self.write(self.life / 'index.json', {'boundary': 100})
        self.write(self.life / 'milestones.json', [
            {'id': 'old', 'source_id': '80', 'text': 'Before reset'},
            {'id': 'replaced', 'source_id': '120', 'text': 'Obsolete', 'superseded': True},
            {'id': 'current', 'source_id': '140', 'text': 'New observatory visit', 'importance': 5}])
        jiwoo = story_edition.build_bible(self.root, self.config)['characters'][0]
        self.assertEqual([r['id'] for r in jiwoo['memories']], ['current'])
        self.assertEqual(jiwoo['memories'][0]['source'], 'data/life/Ji-woo/milestones.json')

    def test_reset_with_stale_store_excludes_all_old_scene_memories(self):
        self.write(self.data / 'character-resets.json', {'Ji-woo': 100})
        self.write(self.life / 'index.json', {'boundary': 0})
        self.write(self.life / 'events.json', [{'id': 'scene', 'source_id': 'abcdef', 'text': 'Old scene'}])
        self.assertEqual(story_edition.build_bible(self.root, self.config)['characters'][0]['memories'], [])

    def test_record_at_reset_boundary_matches_engine_visibility(self):
        self.write(self.data / 'character-resets.json', {'Ji-woo': 100})
        self.write(self.life / 'index.json', {'boundary': 100})
        self.write(self.life / 'milestones.json', [{'id': 'first', 'source_id': '100', 'text': 'First valid memory'}])
        records = story_edition.build_bible(self.root, self.config)['characters'][0]['memories']
        self.assertEqual([record['id'] for record in records], ['first'])

    def test_missing_memories_remain_unknown_and_markdown_has_provenance(self):
        (self.data / 'memories.json').unlink()
        bible = story_edition.build_bible(self.root, self.config)
        self.assertEqual(bible['characters'][0]['memory'], '')
        output = story_edition.markdown(bible)
        self.assertIn('## Ji-woo', output)
        self.assertIn('agents.json', output)
        self.assertIn('not established', output.lower())

    def test_non_get_routes_and_unknown_static_paths_are_not_claimed(self):
        self.assertFalse(story_edition.handle({}, None, '/unrelated'))


class LauncherTests(unittest.TestCase):
    def test_foreign_service_non_object_json_is_not_a_story_instance(self):
        from io import BytesIO
        for payload in [b'[]', b'null']:
            with self.subTest(payload=payload), patch.object(launch_story, 'urlopen', return_value=BytesIO(payload)):
                self.assertFalse(launch_story.existing_edition('http://127.0.0.1:8876'))

    def test_alternate_port_server_is_reused_from_desktop_default(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            (root / 'data/server.pid').write_text(json.dumps({'pid': 1234, 'port': 8877}))
            with patch.object(launch_story, 'ROOT', root), patch.object(
                    launch_story, 'existing_edition', side_effect=lambda url: url.endswith(':8877')), patch.object(
                    launch_story.subprocess, 'Popen', side_effect=AssertionError('Must reuse the running story server')):
                self.assertEqual(launch_story.launch(8876, False), 'http://127.0.0.1:8877')

    def test_stale_or_invalid_port_record_does_not_override_live_requested_port(self):
        for record in [{'port': 8877}, {'port': 'not-a-port'}, []]:
            with self.subTest(record=record), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'data').mkdir()
                (root / 'data/server.pid').write_text(json.dumps(record))
                with patch.object(launch_story, 'ROOT', root), patch.object(
                        launch_story, 'existing_edition', side_effect=lambda url: url.endswith(':8876')), patch.object(
                        launch_story.subprocess, 'Popen', side_effect=AssertionError('Already running')):
                    self.assertEqual(launch_story.launch(8876, False), 'http://127.0.0.1:8876')


if __name__ == '__main__':
    unittest.main()
