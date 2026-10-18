"""Meetup acceptance tests: temporary stores, mocked threads and providers, no network."""
import io
import json
import threading
from datetime import datetime, timedelta, timezone
import unittest
from test_support import HermeticTestCase
from unittest.mock import patch

import meetups
import scenes
import server
import test_scenes


class MeetupTests(HermeticTestCase):
    record = test_scenes.SceneTests.record

    def setUp(self):
        state_patch = patch.dict(server.STATE)
        state_patch.start()
        self.addCleanup(state_patch.stop)
        test_scenes.SceneTests.setUp(self)
        self.meetups = meetups.Meetups(vars(server))
        patcher = patch.object(server, 'MEETUPS', self.meetups)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.config['meetups'] = dict(meetups.DEFAULTS, pace_seconds=0)
        self.addCleanup(server.ACTIVE.clear)
        server.ACTIVE.set()
        self.end_at = None
        self.provider_prompts = []
        self.gains = []
        self.failures = set()

    def provider(self, agent, prompt, timeout, images=None):
        self.provider_prompts.append((agent['name'], prompt))
        if agent['name'] in self.failures:
            raise RuntimeError('mock provider failure')
        if prompt.startswith('Summarize this completed in-person scene:'):
            names = prompt.split('Participants: ')[1].split('.')[0].split(', ')
            records = [dict(self.record(n, text='We shared coffee and returned from the cafe.'), about=[x for x in names]) for n in names if n != 'Mystery']
            return json.dumps(dict(message='They talked at the cafe, then returned.', memory='Summary.',
                                   remember=records, bond_gains=self.gains, to=None))
        # A normal call uses the same structured parser, including optional choices.
        end = self.end_at is not None and sum('AUTONOMOUS IN-PERSON SCENE:' in p for _, p in self.provider_prompts) >= self.end_at
        return json.dumps(dict(message=f'*I take a seat.* Hello from {agent["name"]}.', memory='A shared moment.',
                               remember=[dict(self.record(), about=['Iris', 'Milo'])],
                               resolve=[], to=None, end_scene=end))

    def invite(self, source='Iris', target='Milo', **changes):
        data = dict(to=target, kind='hangout', where='The cafe', when='now', note='Coffee together?')
        data.update(changes)
        return self.meetups.invite(source, data, self.config)

    def accept(self, invite):
        return self.meetups.answer(invite['to'], dict(id=invite['id'], answer='accept'), self.config)

    def advance(self, count):
        for _ in range(count):
            server.append('Mystery', 'Another room message.')

    def start(self, **changes):
        invite = self.invite(**changes)
        self.accept(invite)
        self.meetups.tick(self.config)
        return self.manager.list()[0]['id']

    def step(self, scene_id):
        if scene_id not in self.manager.jobs:
            self.meetups.tick(self.config)
        self.meetups.work(scene_id)
        return self.manager.get(scene_id)

    def test_invite_validation_all_eligibility_sites(self):
        for source, target, expected in [('Iris', 'Theo', 'hangout'), ('Theo', 'Milo', 'hangout'),
                                          ('Iris', 'Milo', 'date')]:
            with self.subTest(source=source, target=target):
                result = self.invite(source, target, kind='date')
                self.assertEqual(result['kind'], expected)
                self.meetups.answer(target, dict(id=result['id'], answer='decline'))
        human = next(a for a in self.config['agents'] if a['name'] == 'Milo')
        human.update(kind='ship_ai', sibling=None)
        self.advance(20)
        result = self.invite(kind='date')
        self.assertEqual(result['kind'], 'hangout')
        self.meetups.answer('Milo', dict(id=result['id'], answer='decline'))
        self.advance(20)
        result = self.invite('Milo', 'Mystery', kind='date')
        self.assertEqual(result['kind'], 'hangout')

    def test_asymmetric_preference_and_sibling_guards(self):
        other = next(a for a in self.config['agents'] if a['name'] == 'Milo')
        other['attracted_to'] = ['male']
        self.assertEqual(self.invite(kind='date')['kind'], 'hangout')
        self.meetups.save([])
        other['attracted_to'] = ['female']
        other['sibling'] = 'Iris'
        self.assertEqual(self.invite(kind='date')['kind'], 'hangout')

    def test_invalid_unavailable_and_one_open_invite(self):
        for data in (dict(to='Nobody'), dict(to='Iris'), dict(where=''), dict(where=[]),
                     dict(kind='wrong'), dict(when='yesterday'), dict(note=[])):
            self.assertIsNone(self.invite(**data))
        first = self.invite()
        self.assertIsNone(self.invite(target='Nora'))
        self.accept(first)
        self.assertIsNone(self.invite(target='Nora'))
        self.manager.create(dict(participants=['Nora'], title='Away', location='Garden'))
        self.assertIsNone(self.invite('Theo', 'Nora'))
        self.assertIsNone(self.invite('Nora', 'Mystery'))
        next(a for a in self.config['agents'] if a['name'] == 'Theo')['enabled'] = False
        self.assertIsNone(self.invite('Theo', 'Mystery'))

    def test_active_boundaries_from_either_perspective_and_resolution(self):
        for owner, target in [('Iris', 'Milo'), ('Milo', 'Iris'), ('Iris', 'Mystery')]:
            with self.subTest(owner=owner, target=target):
                record = dict(segment='boundaries', about=[target], text=f'{target} asked for space.',
                              tags=['space'], importance=5, status='open')
                store = server.life_store(owner)
                store.apply([record], source_id=owner + target, embed=False)
                invite_target = 'Mystery' if target == 'Mystery' else 'Milo'
                self.assertIsNone(self.invite(target=invite_target))
                ids = [r['id'] for r in store.load_segment('boundaries')]
                store.apply(resolve=ids, embed=False)  # Not the stater: stays open.
                self.assertIsNone(self.invite(target=invite_target))
                lifted = dict(id='99', name=target, text='You can talk to me again.', time='2999-01-01T00:00:00+00:00')
                store.apply(resolve=ids, embed=False, visible=[lifted])
                result = self.invite(target=invite_target)
                self.assertIsNotNone(result)
                self.meetups.save([])

    def test_accept_decline_expiry_cooldown_and_identity(self):
        invite = self.invite()
        with self.assertRaises(scenes.SceneError):
            self.meetups.answer('Nora', dict(id=invite['id'], answer='accept'))
        self.meetups.answer('Milo', dict(id=invite['id'], answer='decline', note='Not today.'))
        self.assertIsNone(self.invite())
        self.advance(19)
        self.assertIsNone(self.invite())
        self.advance(1)
        invite = self.invite()
        self.advance(29)
        self.assertEqual(self.meetups.public()['invites'][-1]['status'], 'pending')
        self.advance(1)
        self.assertEqual(self.meetups.public()['invites'][-1]['status'], 'expired')
        with self.assertRaises(scenes.SceneError):
            self.accept(invite)
        fresh = self.invite()
        accepted = self.accept(fresh)
        self.assertEqual(accepted['status'], 'accepted')
        with self.assertRaises(scenes.SceneError):
            self.accept(fresh)
        self.advance(31)
        self.assertEqual(self.meetups.public()['invites'][-1]['status'], 'accepted')

    def test_mystery_accept_is_regular_user_scene_even_paused(self):
        server.ACTIVE.clear()
        invite = self.invite(target='Mystery', when='later')
        row = self.accept(invite)
        scene = self.manager.get(row['scene_id'])
        self.assertEqual(row['status'], 'started')
        self.assertFalse(scene.get('autonomous', False))
        self.assertEqual(scene['participants'], ['Iris'])
        self.manager.post(scene['id'], dict(text='The sky turns silver.'))
        self.manager.work(scene['id'], 'reply')
        prompt = self.invoke.call_args.args[1]
        self.assertIn('like a game master', prompt)

    def test_now_and_later_due_timing_free_participants(self):
        invite = self.invite(when='later')
        row = self.accept(invite)
        self.assertEqual(row['due_message'], self.meetups.count() + 15)
        self.advance(14)
        self.meetups.tick()
        self.assertFalse(self.manager.list())
        self.advance(1)
        server.STATE['speaker'] = 'Iris'
        self.meetups.tick()
        self.assertFalse(self.manager.list())
        server.STATE['speaker'] = None
        self.meetups.tick()
        self.assertEqual(len(self.manager.list()), 1)
        self.assertEqual(self.meetups.load()[0]['status'], 'started')

    def test_alternation_natural_goodbye_and_minimum(self):
        self.end_at = 1
        scene_id = self.start()
        for index in range(4):
            scene = self.step(scene_id)
            self.assertEqual(scene['status'], 'ended' if index == 3 else 'active')
        self.assertEqual([m['name'] for m in scene['messages'] if m['kind'] == 'chat'], ['Iris', 'Milo', 'Iris', 'Milo'])
        self.assertEqual(scene['exchanges'], 4)
        prompts = [p for _, p in self.provider_prompts if 'AUTONOMOUS IN-PERSON SCENE:' in p]
        self.assertIn('briefly set the place and mood', prompts[0])
        self.assertIn('Hello from Iris', prompts[1])
        self.assertIn('Mystery is not present', prompts[0])
        self.assertNotIn('like a game master', prompts[0])
        self.assertFalse(self.manager.away_reason('Iris'))

    def test_hard_cap_records_and_mutual_bonus(self):
        self.gains = [dict(names=['Iris', 'Milo'], like=9), dict(names=['Iris', 'Mystery'], like=25)]
        scene_id = self.start()
        self.assertIn('Milo', self.manager.away_reason('Iris'))
        for _ in range(12):
            scene = self.step(scene_id)
        self.assertEqual(scene['status'], 'ended')
        self.assertEqual(scene['exchanges'], 12)
        scores = server.relationship_state()
        for owner, target in [('Iris', 'Milo'), ('Milo', 'Iris')]:
            self.assertEqual(scores[owner][target]['like'], 9)
            records = server.life_store(owner).load_segment('events')
            self.assertTrue(any(r['source_id'] == scene_id for r in records))
            self.assertTrue(all(r['text'].startswith('We met in person:') for r in records))
        self.assertNotIn('Mystery', scores['Iris'])
        self.assertIn('are back', server.history()[-1]['text'])

    def test_pause_resume_pacing_and_disabled(self):
        self.config['meetups']['pace_seconds'] = 5
        invite = self.invite()
        self.accept(invite)
        server.ACTIVE.clear()
        self.meetups.tick()
        self.assertFalse(self.manager.list())
        server.ACTIVE.set()
        self.meetups.tick()
        scene_id = self.manager.list()[0]['id']
        server.ACTIVE.clear()  # Pause after reservation, before worker starts.
        self.meetups.work(scene_id)
        self.assertEqual(self.invoke.call_count, 0)
        server.ACTIVE.set()
        with patch.object(meetups.time, 'time', return_value=100):
            self.step(scene_id)
        with patch.object(meetups.time, 'time', return_value=104):
            self.meetups.tick()
            self.assertNotIn(scene_id, self.manager.jobs)
        with patch.object(meetups.time, 'time', return_value=105):
            self.meetups.tick()
            self.assertIn(scene_id, self.manager.jobs)
        self.config['meetups']['enabled'] = False
        self.meetups.work(scene_id)
        self.assertEqual(self.manager.meta(scene_id)['exchanges'], 1)
        self.assertIsNone(self.invite('Nora', 'Theo'))

    def test_single_concurrency_daily_cap_and_restart(self):
        self.config['meetups']['max_per_day'] = 1
        self.end_at = 4
        scene_id = self.start()
        self.accept(self.invite('Nora', 'Theo'))
        for _ in range(3):
            self.meetups.tick()
        self.assertEqual(len(self.manager.list()), 1)
        self.assertEqual(len(self.manager.jobs), 1)
        # Metadata alone is sufficient to resume; no in-memory runner state required.
        self.manager.jobs.clear()
        self.meetups = meetups.Meetups(vars(server))
        server.MEETUPS = self.meetups
        for _ in range(4):
            self.step(scene_id)
        self.meetups.tick()
        self.assertEqual(len(self.manager.list()), 1)
        self.config['meetups']['max_per_day'] = 2
        self.meetups.tick()
        self.assertEqual(len(self.manager.list()), 2)

    def test_failure_twice_closes_with_fallback_records(self):
        scene_id = self.start()
        self.failures.add('Iris')
        with self.assertLogs('meetups', level='ERROR'):
            self.step(scene_id)
            self.step(scene_id)
            scene = self.step(scene_id)
        self.assertEqual(scene['status'], 'ended')
        self.assertEqual(scene['failures'], {'Iris': 2})
        self.assertIn('Hello from Milo', scene['summary'])
        self.assertNotIn('mock provider failure', scene['summary'])
        for owner in ['Iris', 'Milo']:
            records = server.life_store(owner).load_segment('events')
            self.assertTrue(any(r['source_id'] == scene_id for r in records))
        self.assertFalse(self.manager.away_reason('Iris'))

    def test_existing_provider_fallback_used_in_scene(self):
        real_provider = self.provider
        def provider(agent, *args, **kwargs):
            if agent['provider'] != 'cursor':
                raise RuntimeError('primary unavailable')
            return real_provider(agent, *args, **kwargs)
        self.invoke.side_effect = provider
        scene_id = self.start()
        scene = self.step(scene_id)
        self.assertEqual(scene['messages'][0]['served_by'], 'cursor/auto')
        self.assertFalse(scene['failures'])

    def test_join_idempotent_moves_participant_prompt_and_private_watch(self):
        scene_id = self.start(visibility='private')
        self.assertEqual(server.history(), [])
        self.assertEqual(self.meetups.public()['live'][0]['id'], scene_id)
        self.manager.jobs.clear()
        with self.assertRaises(scenes.SceneError):
            self.manager.post(scene_id, dict(text='I walk in.'))
        self.meetups.join(scene_id)
        self.meetups.join(scene_id)
        self.manager.post(scene_id, dict(text='*I take my own seat.* Hello.'))
        self.assertFalse(self.manager.jobs)
        self.assertEqual(len(self.manager.messages(scene_id)), 2)
        self.assertEqual(self.manager.messages(scene_id)[-1]['kind'], 'chat')
        scene = self.step(scene_id)
        prompt = self.invoke.call_args.args[1]
        self.assertIn('Mystery joined', prompt)
        self.assertIn('never a game master', prompt)
        self.assertIn('I take my own seat', prompt)
        self.assertIn('Mystery', self.manager.away_reason('Iris'))
        self.assertEqual(scene['exchanges'], 1)

    def test_optional_turn_choices_survive_parser_and_prompt(self):
        invite = dict(to='Milo', kind='hangout', where='Garden', when='now', note='A walk?')
        self.invoke.side_effect = None
        self.invoke.return_value = json.dumps(dict(message='Want a walk?', memory='I want a walk.', to=None, invite=invite))
        agent = self.agent
        turn = server.serve_turn(agent, 'test', [], self.config, self.config['agents'], None, True)
        self.assertEqual(len(turn), 8)
        self.assertEqual(turn.choices['invite'], invite)
        self.meetups.choices('Iris', turn, self.config)
        row = self.meetups.load()[0]
        milo = next(a for a in self.config['agents'] if a['name'] == 'Milo')
        prompt = server.make_prompt(milo, [], self.config['agents'], config=self.config)
        self.assertIn('PENDING INVITATION from Iris', prompt)
        reply = meetups.Turn((), dict(invite_reply=dict(id=row['id'], answer='accept')))
        self.meetups.choices('Milo', reply, self.config)
        self.assertEqual(self.meetups.load()[0]['status'], 'accepted')
        self.meetups.choices('Milo', reply, self.config)  # Stale optional reply ignored.

    def test_real_room_turn_persists_optional_invite(self):
        self.config['agents'] = [self.agent]
        server.STATE.update(turns=0, limit=24, speaker=None)
        self.invoke.side_effect = None
        self.invoke.return_value = json.dumps(dict(message='Want to meet?', memory='I want to meet Mystery.',
                                                   to=None, invite=dict(to='Mystery', where='Garden', kind='hangout')))
        server.run_turn(self.config)
        self.assertEqual(self.meetups.load()[0]['to'], 'Mystery')
        self.assertEqual(server.history()[-1]['name'], 'Iris')

    def request(self, path, method='GET', body=None, origin=None):
        class Handler:
            def __init__(self):
                encoded = json.dumps(body).encode() if body is not None else b''
                self.headers = {'Host': 'localhost:8765', 'Content-Length': str(len(encoded))}
                if origin:
                    self.headers['Origin'] = origin
                self.rfile = io.BytesIO(encoded)
            def send_json(self, data, code=200):
                self.result = code, data
            def send_payload(self, data, mime, code=200):
                self.result = code, data
        handler = Handler()
        self.assertTrue(self.meetups.handle(handler, path, method))
        return handler.result

    def test_routes_origin_validation_and_join(self):
        invite = self.invite(target='Mystery')
        path = '/api/meetups/invites/' + invite['id'] + '/reply'
        self.assertEqual(self.request('/api/meetups')[0], 200)
        self.assertEqual(self.request('/meetups.js')[0], 200)
        self.assertEqual(self.request(path, 'POST', dict(answer='accept'), 'http://elsewhere')[0], 403)
        self.assertEqual(self.request(path, 'POST', [])[0], 400)
        self.assertEqual(self.request(path, 'POST', dict(answer='wrong'))[0], 400)
        self.assertEqual(self.request(path, 'POST', dict(answer='decline'))[0], 200)
        self.assertEqual(self.request(path, 'POST', dict(answer='accept'))[0], 409)
        scene_id = self.start()
        self.assertEqual(self.request('/api/meetups/scenes/' + scene_id + '/join', 'POST', {})[0], 200)

    def test_join_during_real_provider_call_preserves_membership(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        real_provider = self.provider
        real_work = self.meetups.work
        def provider(*args, **kwargs):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('test provider not released')
            return real_provider(*args, **kwargs)
        def work(scene_id):
            try:
                real_work(scene_id)
            finally:
                finished.set()
        self.invoke.side_effect = provider
        with patch.object(threading.Thread, 'start', test_scenes.THREAD_START), patch.object(self.meetups, 'work', side_effect=work):
            scene_id = self.start()
            try:
                self.assertTrue(entered.wait(2))
                # These read/write calls prove the room lock is released during provider work.
                self.assertTrue(self.manager.get(scene_id)['busy'])
                self.meetups.join(scene_id)
                server.ACTIVE.clear()
            finally:
                release.set()
                self.assertTrue(finished.wait(3))
        self.assertTrue(self.manager.meta(scene_id)['mystery_joined'])
        self.assertFalse(self.manager.jobs)
        server.ACTIVE.set()
        self.invoke.side_effect = self.provider
        self.step(scene_id)
        self.assertIn('Mystery joined', self.invoke.call_args.args[1])

    def test_pause_during_goodbye_defers_summary_until_resume(self):
        self.end_at = 4
        scene_id = self.start()
        for _ in range(3):
            self.step(scene_id)
        real_provider = self.provider
        def provider(*args, **kwargs):
            result = real_provider(*args, **kwargs)
            server.ACTIVE.clear()
            return result
        self.invoke.side_effect = provider
        scene = self.step(scene_id)
        self.assertTrue(scene['closing'])
        self.assertEqual(scene['status'], 'active')
        self.assertEqual(self.invoke.call_count, 4)
        self.meetups.tick()
        self.assertEqual(self.invoke.call_count, 4)
        self.invoke.side_effect = self.provider
        server.ACTIVE.set()
        scene = self.step(scene_id)
        self.assertEqual(scene['status'], 'ended')
        self.assertEqual(self.invoke.call_count, 5)

    def test_availability_and_boundaries_rechecked_for_due_promises(self):
        row = self.accept(self.invite())
        busy = self.manager.create(dict(participants=['Milo'], title='Busy', location='Garden'))
        self.meetups.tick()
        self.assertEqual(len(self.manager.list()), 1)
        self.assertFalse(self.manager.list()[0].get('autonomous'))
        busy.update(status='ended')
        self.manager.save(busy)
        record = dict(segment='boundaries', about=['Iris'], text='Iris asked for space.',
                      tags=['space'], importance=5, status='open')
        server.life_store('Milo').apply([record], source_id='new-boundary', embed=False)
        self.meetups.tick()
        self.assertEqual(self.meetups.load()[0]['status'], 'expired')
        self.assertEqual(len(self.manager.list()), 1)

    def test_daily_cap_resets_next_calendar_day(self):
        self.config['meetups']['max_per_day'] = 1
        self.end_at = 4
        scene_id = self.start()
        for _ in range(4):
            self.step(scene_id)
        self.accept(self.invite('Nora', 'Theo'))
        self.meetups.tick()
        self.assertEqual(len(self.manager.list()), 1)
        old = self.manager.meta(scene_id)
        old['started_at'] = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        self.manager.save(old)
        self.meetups.tick()
        self.assertEqual(len(self.manager.list()), 2)

    def test_autonomous_participants_excluded_from_room_scheduler(self):
        self.start()
        remaining = server.available_agents(self.config['agents'], self.config)
        self.assertFalse({'Iris', 'Milo'} & {a['name'] for a in remaining})
        for _ in range(8):
            self.assertNotIn(server.choose_next([], self.config['agents']), ['Iris', 'Milo'])

    def test_partial_optional_summary_records_preserve_message_and_valid_records(self):
        self.end_at = 4
        scene_id = self.start()
        for _ in range(3):
            self.step(scene_id)
        real_provider = self.provider
        def provider(agent, prompt, *args, **kwargs):
            if prompt.startswith('Summarize this completed'):
                return json.dumps(dict(message='A moment together.', memory='Summary.',
                                       remember=[self.record('Iris')], to=None))
            return real_provider(agent, prompt, *args, **kwargs)
        self.invoke.side_effect = provider
        scene = self.step(scene_id)
        self.assertEqual(scene['status'], 'ended')
        self.assertEqual(scene['summary'], 'A moment together.')
        self.assertTrue(any(r['source_id'] == scene_id for r in server.life_store('Iris').load_segment('events')))
        self.assertFalse(any(r['source_id'] == scene_id for r in server.life_store('Milo').load_segment('events')))

    def test_settings_validation(self):
        for invalid in [dict(enabled=1), dict(max_per_day=-1), dict(min_exchanges=3),
                        dict(max_exchanges=13), dict(pace_seconds=-1)]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                meetups.settings(dict(meetups=invalid))


if __name__ == '__main__':
    unittest.main()
