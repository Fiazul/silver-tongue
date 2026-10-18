import copy
import json
from pathlib import Path
import tempfile
import unittest

try:
    import journey
except ImportError:
    journey = None


class CombinedJourneyTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(journey, 'The combined-game bridge is missing')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'characters').mkdir()
        for id, name in [('landlady', 'The Landlady'), ('minjun', 'Kim Min-jun'), ('merchant', 'The Merchant')]:
            (self.root / 'characters' / (id + '.json')).write_text(json.dumps({'id': id, 'name': name}))
        self.door = dict(version=1, chapter='door', session='save-one', player='Nadia',
                         day=2, slot=1, wallet=17300, phase='arrival', ready=True,
                         done=['room-wake', 'room-minjun'], observations=[
                             dict(id='first', owner='landlady', speaker='The Landlady', text='Rent is due.'),
                             dict(id='second', owner='minjun', speaker='Mystery', text='My name is Nadia.'),
                         ])

    def test_continue_keeps_the_actual_player_wallet_and_calendar_once(self):
        journey.save_snapshot(self.root, self.door)
        first = journey.continue_story(self.root, 'save-one')
        self.assertEqual(first['chapter'], 'merchant')
        self.assertEqual(first['handoff'], dict(session='save-one', player='Nadia', wallet=17300, day=2, slot=1))
        market = dict(self.door, chapter='merchant', phase='merchant', wallet=27300, ready=False, done=[], observations=[])
        journey.save_snapshot(self.root, market)
        second = journey.continue_story(self.root, 'save-one')
        self.assertEqual(second['merchant']['wallet'], 27300)
        self.assertEqual(second['handoff'], first['handoff'])
        self.assertEqual(journey.load(self.root), second)

    def test_cannot_skip_the_opening_or_continue_another_saved_game(self):
        for changes in [dict(done=[], ready=True), dict(ready=False)]:
            journey.save_snapshot(self.root, dict(self.door, **changes))
            with self.assertRaises(ValueError):
                journey.continue_story(self.root, 'save-one')
        journey.save_snapshot(self.root, self.door)
        with self.assertRaises(ValueError):
            journey.continue_story(self.root, 'another-game')

    def test_each_character_receives_only_their_own_witnessed_gameplay(self):
        journey.save_snapshot(self.root, self.door)
        landlady = journey.context(self.root, {'id': 'landlady'})
        minjun = journey.context(self.root, {'id': 'minjun'})
        self.assertIn('Rent is due.', landlady)
        self.assertNotIn('My name is Nadia.', landlady)
        self.assertIn('My name is Nadia.', minjun)
        self.assertNotIn('Rent is due.', minjun)
        self.assertEqual(journey.context(self.root, {'id': 'merchant'}), '')
        journey.save_snapshot(self.root, self.door)
        self.assertEqual(journey.context(self.root, {'id': 'minjun'}).count('My name is Nadia.'), 1)

    def test_invalid_snapshots_do_not_overwrite_the_last_good_save(self):
        journey.save_snapshot(self.root, self.door)
        original = (self.root / 'data/journey.json').read_bytes()
        for changes in [dict(wallet=-1), dict(wallet=True), dict(day='tomorrow'), dict(session='../escape'),
                        dict(observations=[dict(id='fake', owner='minjun', speaker='The Landlady', text='A secret.')])]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                journey.save_snapshot(self.root, dict(self.door, **changes))
            self.assertEqual((self.root / 'data/journey.json').read_bytes(), original)

    def test_a_new_door_save_does_not_reuse_the_previous_merchant_wallet(self):
        journey.save_snapshot(self.root, self.door)
        journey.continue_story(self.root, 'save-one')
        fresh = journey.save_snapshot(self.root, dict(self.door, session='save-two', wallet=20000, done=[], ready=False, observations=[]))
        self.assertEqual(fresh['chapter'], 'door')
        self.assertIsNone(fresh['handoff'])
        self.assertEqual(fresh['observations'], {})
        self.assertTrue((self.root / 'data/journeys/save-one.json').is_file())

    def test_returning_to_a_previous_arrival_save_restores_its_merchant_chapter(self):
        journey.save_snapshot(self.root, self.door)
        first = journey.continue_story(self.root, 'save-one')
        journey.save_snapshot(self.root, dict(self.door, chapter='merchant', phase='town', wallet=30300, observations=[]))
        journey.save_snapshot(self.root, dict(self.door, session='save-two', ready=False, done=[], observations=[]))
        restored = journey.save_snapshot(self.root, self.door)
        self.assertEqual(restored['chapter'], 'merchant')
        self.assertEqual(restored['handoff'], first['handoff'])
        self.assertEqual(restored['merchant']['wallet'], 30300)
        self.assertIn('Rent is due.', journey.context(self.root, {'id': 'landlady'}))

    def test_confirmed_delivery_outcomes_reach_only_the_merchant(self):
        journey.save_snapshot(self.root, self.door)
        journey.continue_story(self.root, 'save-one')
        receipt = dict(id='receipt', owner='merchant', speaker='Narrator', text='The player delivered the chairs; you paid 5000.')
        journey.save_snapshot(self.root, dict(self.door, chapter='merchant', phase='ending', done=['chairs'], observations=[receipt]))
        self.assertIn('you paid 5000', journey.context(self.root, {'id': 'merchant'}))
        self.assertNotIn('5000', journey.context(self.root, {'id': 'minjun'}))
        self.assertNotIn('5000', journey.context(self.root, {'id': 'landlady'}))

    def test_unreadable_saved_structure_is_preserved_with_recoverable_feedback(self):
        journey.save_snapshot(self.root, self.door)
        path = self.root / 'data/journey.json'
        path.write_text('{"version":1,"observations":[]}')
        before = path.read_bytes()
        with self.assertRaises(ValueError):
            journey.load(self.root)
        self.assertIn('unavailable', journey.context(self.root, {'id': 'minjun'}))
        self.assertEqual(path.read_bytes(), before)

    def test_only_built_game_assets_can_be_served_and_paths_cannot_escape(self):
        site = self.root / 'site'
        (site / 'ko').mkdir(parents=True)
        (site / 'ko/index.html').write_text('The original door opening')
        (self.root / 'secret.py').write_text('must stay private')
        path = journey.asset_path(site, '/game/door/')
        self.assertEqual(path.read_text(), 'The original door opening')
        for route in ['/game/door/../../secret.py', '/game/door/%2e%2e/%2e%2e/secret.py', '/game/secret.py']:
            self.assertIsNone(journey.asset_path(site, route))

    def test_built_pages_come_from_the_checkout_root_two_levels_up(self):
        app = self.root / 'experiments/story-room'
        app.mkdir(parents=True)
        self.assertEqual(journey.site_dir(app), (self.root / 'site').resolve())


if __name__ == '__main__':
    unittest.main()
