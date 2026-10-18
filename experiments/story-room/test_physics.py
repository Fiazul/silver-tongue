"""Independent numerical sanity checks and authored-science retrieval upgrades."""
import contextlib
import io
import json
import math
from pathlib import Path
import tempfile
import unittest
from test_support import HermeticTestCase
from unittest.mock import patch

import backfill_memory
import life_memory
from tools import skeptic_check

physics=skeptic_check.physics
ROOT=Path(__file__).resolve().parent


class PhysicsTests(HermeticTestCase):
    def test_reference_values_and_mass_ratios(self):
        p=physics.compute()
        for key,ship,gamma,beta,turn in [('trip1',13.3,15.5,.99792,28.1),('trip2',15.6,28.1,.99937,52.6)]:
            row=p[key]
            self.assertAlmostEqual(row['ship_years'],ship,delta=.04)
            self.assertAlmostEqual(row['peak_gamma'],gamma,delta=.06)
            self.assertAlmostEqual(row['peak_beta'],beta,delta=.00001)
            self.assertAlmostEqual(row['turnaround_ly'],turn,delta=.04)
            # Independent Earth-time integration of each hyperbolic burn.
            earth=4*physics.K*math.sinh(row['rapidity_per_burn'])
            self.assertAlmostEqual(earth,row['earth_years'])
        self.assertAlmostEqual(p['rocket']['trip1']['photon']['one_way_R'],961.7245,places=3)
        self.assertAlmostEqual(p['rocket']['trip1']['daedalus']['one_way_ln_R'],171.7182,places=3)
        self.assertIsNone(p['rocket']['trip1']['chemical']['one_way_R'])

    def test_actual_route_is_distinct_and_clocks_close(self):
        p=physics.compute();r=p['route']
        self.assertGreater(r['ship_years'],p['trip2']['ship_years'])
        self.assertAlmostEqual(r['travel_earth_years']+r['local_dwell_years'],109)
        self.assertAlmostEqual(r['ship_years']-r['cryo_years'],3)
        for row in r['legs'].values():
            self.assertLess(row['distance_ly'],row['earth_years'])
            self.assertAlmostEqual(2*physics.K*(row['peak_gamma']-1),row['distance_ly'])

    def test_tides_radiation_light_and_air_have_correct_units(self):
        p=physics.compute()
        self.assertAlmostEqual(p['tidal']['at_1000_km_g'],378.8033,places=3)
        self.assertAlmostEqual(p['tidal']['at_50_km_g']/p['tidal']['at_1000_km_g'],8000)
        self.assertGreater(p['medium']['trip2']['dust_J'],2e9)
        self.assertLess(p['medium']['trip2']['dust_J'],3e9)
        self.assertAlmostEqual(p['air']['oxygen_one_kg'],129.5)
        self.assertAlmostEqual(p['air']['same_oxygen_five_hours'],740)
        self.assertAlmostEqual(p['signal']['delay_days']*86400*physics.C,
                               p['signal']['receiver_distance_ly']*physics.LY,delta=1)
        self.assertAlmostEqual(p['sirius']['angle_deg'],21.88479035,places=6)

    def test_checker_rejects_wrong_values_even_with_correct_citation(self):
        p=physics.compute()
        self.assertEqual(skeptic_check.validate_claims('13.3 [physics:trip1.ship_years]',p),1)
        with self.assertRaises(AssertionError):
            skeptic_check.validate_claims('13.4 [physics:trip1.ship_years]',p)
        with self.assertRaises(AssertionError):
            skeptic_check.validate_claims('readout [physics:trip1.ship_years]',p)
        with self.assertRaises(AssertionError):
            skeptic_check.answers('## F001 — Empty\n\n','F',1)
        with self.assertRaises(AssertionError):
            skeptic_check.reject_unbound_quantities('A periapsis of 900 km.')

    def test_repository_skeptic_check(self):
        with contextlib.redirect_stdout(io.StringIO()):
            skeptic_check.check()

    def test_glass_flower_chronology_privacy_and_retrieval(self):
        import disclosure
        p = physics.compute()
        flower = p['flower']
        schedule = p['schedule']
        self.assertLess(schedule['V018']['earth_date'], schedule['V039']['earth_date'])
        self.assertLess(schedule['V039']['earth_date'], schedule['V019']['earth_date'])
        pickup = float(schedule['V039']['ship_time'].split()[0][2:])
        self.assertAlmostEqual(flower['ship_years_to_arrival'], p['route']['ship_years'] - pickup, places=5)
        self.assertEqual(flower['eva_window_minutes'] - flower['breach_minute'], 9)
        logs = [json.loads(line) for line in (ROOT/'lore/vella/travel_logs.jsonl').read_text().splitlines()]
        log = next(row for row in logs if row['id'] == 'V039')
        self.assertEqual(log['type'], 'personal')
        with tempfile.TemporaryDirectory() as tmp:
            store = life_memory.Store(tmp, 'Vella', embedding_config={'enabled': False})
            backfill_memory.seed_lore(store, ROOT/'lore/vella')
            seeded = [row for row in store.load_segment('milestones') if row['source_id'] == 'lore:V039']
            self.assertTrue(seeded)
            self.assertTrue(all(disclosure.sensitivity(row) == 'personal' for row in seeded))
            self.assertTrue(all(row['private'] and row['retrieval_only'] for row in seeded))
            self.assertFalse(disclosure.allowed({'name': 'Vella'}, 'Iris', 'personal', {}, record=seeded[0]))
            rows, _ = store.retrieve('UB-7 glass flower terminator brine glove scar', {'Vella', 'Mystery'}, recall=True)
            self.assertTrue(any(row['source_id'] == 'lore:V039' for _, row in rows))
            self.assertEqual(store.prompt_anchors('Mystery'), [])

    def test_science_seed_retrieves_without_provider_and_retires_old_authored_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            store=life_memory.Store(tmp,'Vella',embedding_config={'enabled':False})
            stale=dict(segment='important',about=['Vella'],text='Obsolete gamma estimate is thirty-six.',
                       tags=['gamma','relativity'],importance=5,status='resolved',retrieval_only=True)
            store.apply([stale],source_id='lore:old-model',embed=False)
            historical=dict(stale,text='Iris discussed a gamma estimate.',retrieval_only=False)
            store.apply([historical],source_id='chat-message',embed=False)
            with patch.object(backfill_memory.server,'invoke',side_effect=AssertionError('offline')):
                first=backfill_memory.seed_lore(store,ROOT/'lore/vella')
                second=backfill_memory.seed_lore(store,ROOT/'lore/vella')
            self.assertGreater(first['added'],100)
            self.assertEqual(second['added'],0)
            all_text=' '.join(r['text'] for s in life_memory.SEGMENTS for r in store.load_segment(s))
            self.assertNotIn('Obsolete gamma',all_text)
            self.assertIn('Iris discussed',all_text)
            for question,needle in [('rocket equation photon mass ratio','961.724'),
                                    ('Sirius parallax displacement','3.205'),
                                    ('Asterion inertia control power','Asterion'),
                                    ('oxygen life support consumption','0.84')]:
                rows,_=store.retrieve(question,{'Vella'},recall=True)
                self.assertTrue(any(needle in r['text'] for _,r in rows),question)
            self.assertEqual(store.prompt_anchors('Mystery'),[])
            rows,_=store.retrieve('Hello Vella how are you?',{'Vella'},recall=True)
            self.assertFalse(any(r.get('retrieval_only') for _,r in rows))
            # Private FAQ contents stay private; public physics is not permission to disclose.
            private=[r for r in store.load_segment('important')
                     if r['text'].startswith('[Captain-private] Q: Why did a neutron-star flyby kill people')]
            self.assertTrue(private)
            self.assertTrue(all(r.get('private') for r in private))

    def test_reseed_revision_can_restore_a_previous_authored_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);lore=root/'lore/vella';lore.mkdir(parents=True)
            (lore/'travel_logs.jsonl').write_text('')
            story=lore/'backstory.md'
            store=life_memory.Store(root/'life','Vella',embedding_config={'enabled':False})
            for text in ('First inertia assumption.', 'Revised inertia assumption.', 'First inertia assumption.'):
                story.write_text('# Inertia\n\n'+text)
                backfill_memory.seed_lore(store,lore)
                active=store.load_segment('world')
                self.assertEqual([r['text'] for r in active],[text])


if __name__=='__main__':unittest.main()
