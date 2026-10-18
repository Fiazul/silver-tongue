"""Regression tests for the review findings (H1-H2, M1-M3, L1-L10) and the quiet room.

Each test targets the defect CATEGORY (every site), using temporary stores, a mocked
provider and no network. See README "Robustness rules" for the policies tested here."""
from datetime import datetime, timedelta, timezone
import http.client
import http.server
import json
import logging
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from test_support import HermeticTestCase, romance_cast
from unittest.mock import MagicMock, patch

import backfill_memory
import engagement
import life_memory
import meetups
import memory_sweep
import relationships
import scenes
import server
import storage
import test_meetups

ROOT = Path(__file__).resolve().parent
REAL_INVOKE = server.invoke  # The scene fixture replaces server.invoke with a mock provider.
NOW = datetime(2026, 10, 15, 16, 0, tzinfo=timezone.utc)


def boundary(stater, about, text=None, **changes):
    value = dict(segment='boundaries', about=about, text=text or f'{stater} asked for space.',
                 tags=['space'], importance=5, status='open', stated_by=stater)
    value.update(changes)
    return value


class Fixture(HermeticTestCase):
    """Meetup/scene fixture: temp data, mocked provider, cast all enabled, Mystery is male."""
    setUp = test_meetups.MeetupTests.setUp
    record = test_meetups.MeetupTests.record
    invite = test_meetups.MeetupTests.invite
    accept = test_meetups.MeetupTests.accept
    start = test_meetups.MeetupTests.start
    step = test_meetups.MeetupTests.step
    provider = test_meetups.MeetupTests.provider

    def cast_member(self, name):
        return next(a for a in self.config['agents'] if a['name'] == name)

    def reply_with(self, **reply):
        base = dict(message='Hello there.', memory='I said hello.', to=None)
        base.update(reply)
        self.invoke.side_effect = lambda *a, **k: json.dumps(base)


# ---- H1: atomic writes and cross-process store locking ---------------------------------------------------
CHILD = r'''
import sys, threading
sys.path.insert(0, sys.argv[1])
import life_memory
store = life_memory.Store(sys.argv[2], 'Ji-woo', threading.RLock(), embedding_config={'enabled': False})
for i in range(40):
    store.apply([dict(segment='events', about=['Mystery'], text=f'child event {i}', tags=['child'],
                      importance=2, status='open')], source_id=f'c{i}', embed=False)
'''


class AtomicStorageTests(HermeticTestCase):
    def test_no_fixed_temp_names_anywhere(self):
        # Category guard: every rewrite goes through storage.atomic_write (unique mkstemp names).
        offenders = []
        for path in list(ROOT.glob('*.py')) + list((ROOT / 'tools').glob('*.py')):
            if path.name.startswith('test_'):
                continue
            text = path.read_text(encoding='utf-8')
            if re.search(r"with_suffix\('\.tmp'\)", text):
                offenders.append(path.name)
        self.assertEqual(offenders, [])

    def test_atomic_write_concurrent_writers_leave_valid_file_and_no_temps(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'shared.json'
            def writer(n):
                for i in range(50):
                    storage.atomic_write(target, json.dumps({'writer': n, 'i': i, 'pad': 'x' * 2000}))
            threads = [threading.Thread(target=writer, args=(n,)) for n in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            self.assertIn(json.loads(target.read_text())['writer'], range(4))
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()), ['shared.json'])

    def test_store_read_modify_write_is_safe_across_processes(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = life_memory.Store(tmp, 'Ji-woo', threading.RLock(), embedding_config={'enabled': False})
            child = subprocess.Popen([sys.executable, '-c', CHILD, str(ROOT), tmp])
            for i in range(40):
                store.apply([dict(segment='events', about=['Mystery'], text=f'parent event {i}', tags=['parent'],
                                  importance=2, status='open')], source_id=f'p{i}', embed=False)
            self.assertEqual(child.wait(60), 0)
            self.assertEqual(len(store.index()['records']), 80)
            self.assertEqual(len(store.load_segment('events')), 80)
            self.assertTrue(store.has_source('c39') and store.has_source('p0'))
            self.assertFalse(store.has_source('nope'))

    def test_process_lock_is_reentrant_and_excludes_other_processes(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = storage.process_lock(Path(tmp) / '.lock')
            probe = ('import fcntl, os, sys; fd = os.open(sys.argv[1], os.O_RDWR)\n'
                     'try:\n fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); print("free")\n'
                     'except BlockingIOError:\n print("held")')
            with lock, lock:  # Nested in one thread: no self-deadlock.
                held = subprocess.run([sys.executable, '-c', probe, str(Path(tmp) / '.lock')],
                                      capture_output=True, text=True, timeout=30).stdout.strip()
            free = subprocess.run([sys.executable, '-c', probe, str(Path(tmp) / '.lock')],
                                  capture_output=True, text=True, timeout=30).stdout.strip()
            self.assertEqual((held, free), ('held', 'free'))

    def test_backfill_refuses_to_write_while_server_is_live(self):
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = Path(tmp) / 'server.pid'
            with patch.object(server, 'PIDFILE', pidfile):
                self.assertIsNone(backfill_memory.server_live(port=1))
                pidfile.write_text(json.dumps(dict(pid=server.os.getpid(), port=8765)))
                self.assertIn('server pid', backfill_memory.server_live(port=1))
            listener = socket.socket()
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            try:
                with patch.object(server, 'PIDFILE', Path(tmp) / 'missing.pid'):
                    self.assertIn('listening', backfill_memory.server_live(port=listener.getsockname()[1]))
            finally:
                listener.close()
        with patch('sys.argv', ['backfill_memory.py', 'The Merchant']), \
             patch.object(backfill_memory, 'server_live', return_value='server pid 1'), \
             patch.object(backfill_memory, 'backfill', side_effect=AssertionError('wrote while live')), \
             patch('sys.stderr'):
            with self.assertRaises(SystemExit) as caught:
                backfill_memory.main()
            self.assertEqual(caught.exception.code, 2)


# ---- H2: core note merge keeps new information ---------------------------------------------------------------
class GuardedNoteTests(HermeticTestCase):
    def test_new_note_survives_a_full_old_note(self):
        old = ' '.join(f'Old fact number {i} stays true.' for i in range(20))  # 120 words
        self.assertEqual(len(old.split()), 120)
        merged = server.guarded_note(old, 'I now love The Landlady and we are engaged. Kim Min-jun moved out.')
        self.assertTrue(merged.startswith('I now love The Landlady and we are engaged. Kim Min-jun moved out.'))
        self.assertLessEqual(len(merged.split()), 120)
        self.assertIn('Old fact number 0 stays true.', merged)
        self.assertNotIn('Old fact number 19 ', merged)  # Older sentences fill only the remaining room.

    def test_ordinary_rewrite_is_kept_as_written(self):
        self.assertEqual(server.guarded_note('A b c.', 'Now I feel different about everything here.'),
                         'Now I feel different about everything here.')


# ---- M1: quota classification only from provider error text --------------------------------------------------
class FailureClassificationTests(HermeticTestCase):
    def setUp(self):
        for state in (server.PROVIDER_EXHAUSTED, server.PROVIDER_BREAKS, server.PROVIDER_TRIALS):
            patcher = patch.dict(state, {}, clear=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_agent_message_text_never_marks_quota(self):
        repro = RuntimeError('codex exited 1: stdout={"type":"item.completed","item":{"type":"agent_message",'
                             '"text":"The Merchant: LEDGER 2031-04-02T08:00Z — rice quota nominal"}} stderr=segfault')
        self.assertEqual(server.classify_failure(repro), 'crash')
        self.assertEqual(server.classify_failure(ValueError("No valid chat reply: 'rate limit' in her line")), 'bad_reply')
        self.assertEqual(server.classify_failure(server.EmptyReply('quota')), 'bad_reply')
        self.assertEqual(server.classify_failure(ValueError('timed out waiting')), 'bad_reply')

    def run_codex(self, stdout, stderr, returncode=1):
        proc = MagicMock()
        proc.__enter__.return_value = proc
        proc.returncode = returncode
        proc.communicate.return_value = (stdout, stderr)
        agent = dict(name='The Merchant', provider='codex', model='m')
        with patch.object(server.subprocess, 'Popen', return_value=proc), \
             patch.object(server.shutil, 'which', return_value='/usr/bin/codex'), \
             patch.object(server, 'load_config', return_value={'agents': [], 'effort': 'low'}):
            with self.assertRaises(RuntimeError) as caught:
                server.invoke(agent, 'Hi', 5)
        return caught.exception

    def test_invoke_failure_with_agent_text_in_stdout_is_a_crash(self):
        stdout = json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message',
                             'text': 'The Merchant: LEDGER 2031-04-02T08:00Z — rice quota nominal, rate limit fine'}})
        exc = self.run_codex(stdout, 'Segmentation fault')
        self.assertEqual(server.record_failure('codex', exc), 'crash')
        self.assertNotIn('codex', server.PROVIDER_EXHAUSTED)
        exc = self.run_codex(stdout, 'Error: You have hit your usage limit. Try again at 9:10pm (Asia/Seoul)')
        with patch.object(server, 'datetime', wraps=datetime) as date:
            date.now.return_value = NOW
            self.assertEqual(server.record_failure('codex', exc), 'quota')
        self.assertEqual(server.PROVIDER_EXHAUSTED['codex'], datetime(2026, 10, 15, 12, 10, tzinfo=timezone.utc).timestamp() + 86400)

    def test_structured_provider_error_shapes_are_quota(self):
        shapes = [
            ('claude', json.dumps({'type': 'result', 'is_error': True, 'api_error_status': 429,
                                   'result': "You've hit your session limit · resets 9:10pm (Asia/Seoul)"})),
            ('cursor', json.dumps({'type': 'result', 'is_error': True, 'result': 'Cursor usage limit reached'})),
            ('codex', json.dumps({'type': 'turn.failed', 'error': {'message': 'usage_limit_reached'}})),
            ('opencode', json.dumps({'type': 'error', 'error': {'name': 'APIError', 'data': {'message': 'Rate limit exceeded'}}})),
        ]
        for provider, output in shapes:
            with self.subTest(provider=provider), self.assertRaises(server.ProviderError) as caught:
                server.parse_reply(provider, output)
            self.assertEqual(server.classify_failure(caught.exception), 'quota')
        # A successful claude result whose TEXT mentions quota is a reply, not an error.
        self.assertIn('quota', server.parse_reply('claude', json.dumps({'type': 'result', 'result': 'My quota of tea.'})))

    def test_reset_time_only_next_to_reset_wording_and_capped(self):
        self.assertEqual(server.quota_reset('LEDGER 2031-04-02T08:00Z rice quota nominal', NOW), NOW.timestamp() + 1800)
        self.assertEqual(server.quota_reset('limit; resets 2026-10-15T17:00:00Z', NOW), NOW.timestamp() + 3600)
        self.assertEqual(server.quota_reset('try again after 2026-10-15T17:00:00Z', NOW), NOW.timestamp() + 3600)
        self.assertEqual(server.quota_reset('resets 2031-04-02T08:00Z', NOW), (NOW + timedelta(days=7)).timestamp())


# ---- M2: two-way boundaries everywhere; only the stater lifts --------------------------------------------------
class BoundaryTests(Fixture):
    def test_room_dm_honours_a_boundary_recorded_only_by_the_recipient(self):
        server.life_store('Grandpa Park').apply([boundary('Grandpa Park', ['Ji-woo'], 'Grandpa Park asked Ji-woo for space.')], embed=False)
        relationships.save('Ji-woo', {'Grandpa Park': {'like': 120, 'dislike': 0}})
        self.assertTrue(server.blocked_between('Ji-woo', 'Grandpa Park', self.config))
        self.assertTrue(server.blocked_between('Grandpa Park', 'Ji-woo', self.config))
        self.reply_with(message='Grandpa Park, can we talk privately?', to='Grandpa Park')
        with patch.object(server, 'choose_next', return_value='Ji-woo'):
            server.run_turn(self.config)
        self.assertEqual(self.invoke.call_count, 1)
        self.assertEqual([m for m in server.history() if m['kind'] == 'chat'], [])
        self.assertIn('giving Grandpa Park space', server.STATE['reason'])
        self.assertIsNone(self.invite('Ji-woo', 'Grandpa Park'))
        self.assertIn('boundary', server.TIMEKEEPER.apply('Ji-woo', meetups.Turn((), dict(calls=[dict(
            fn='set_alarm', at='07:00', to='Grandpa Park', intent='Hi')])), self.config)[0])

    def test_only_the_stater_or_their_visible_lifting_message_resolves(self):
        store = server.life_store('Ji-woo')
        store.apply([boundary('Mystery', ['Mystery'], 'Mystery asked Ji-woo for space.'),
                     boundary('Ji-woo', ['Mystery'], 'Ji-woo asked Mystery for space.', tags=['no-contact'])], embed=False)
        theirs, mine = sorted(store.load_segment('boundaries'), key=lambda r: r['stated_by'])[::-1]
        self.assertEqual((theirs['stated_by'], mine['stated_by']), ('Mystery', 'Ji-woo'))
        unrelated = dict(name='Kim Min-jun', text='You can message me again.', time='2999-01-01T00:00:00+00:00')
        store.apply(resolve=[theirs['id'], mine['id']], embed=False, visible=[unrelated])
        status = {r['id']: r['status'] for r in store.load_segment('boundaries')}
        self.assertEqual((status[theirs['id']], status[mine['id']]), ('open', 'resolved'))
        stale = dict(name='Mystery', text='You can message me again.', time='2000-01-01T00:00:00+00:00')
        store.apply(resolve=[theirs['id']], embed=False, visible=[stale])
        self.assertEqual(store.load_segment('boundaries')[0]['status'], 'open')
        lifted = dict(name='Mystery', text="It's okay to talk again, Ji-woo. I'm ready to talk.",
                      time='2999-01-01T00:00:00+00:00')
        store.apply(resolve=[theirs['id']], embed=False, visible=[lifted])
        self.assertTrue(all(r['status'] == 'resolved' for r in store.load_segment('boundaries')))

    def test_scene_participant_cannot_resolve_someone_elses_boundary(self):
        server.life_store('Ji-woo').apply([boundary('Mystery', ['Mystery'])], embed=False)
        record_id = server.life_store('Ji-woo').load_segment('boundaries')[0]['id']
        scene = self.manager.create(dict(participants=['Ji-woo'], title='Walk', location='Garden'))
        self.reply_with(message='*I walk.*', resolve=[record_id])
        self.manager.post(scene['id'], {'text': 'We walk on.'})
        test_meetups.test_scenes.SceneTests.drain(self, scene['id'])
        self.assertEqual(server.life_store('Ji-woo').load_segment('boundaries')[0]['status'], 'open')


# ---- M3: Mystery's configured gender gates romance --------------------------------------------------------------
class MysteryPreferenceTests(Fixture):
    def test_story_cast_is_never_romantic_toward_mystery(self):
        scores = {'Mystery': dict(like=900, dislike=0, mood=dict.fromkeys(relationships.MOOD_KEYS, 5))}
        for member in self.config['agents']:
            tone = relationships.tone_guidance(member, scores, self.config['agents'], self.config)
            for tier in ('soulbond', 'devoted partner', 'deep love', 'marriage-ready', 'You love Mystery'):
                self.assertNotIn(tier, tone)
            self.assertFalse(self.meetups.eligible(member, 'Mystery', self.config))

    def test_avery_never_romantic_toward_male_mystery_blair_is(self):
        self.config['agents'] = romance_cast()
        avery, blair = self.cast_member('Avery'), self.cast_member('Blair')
        self.assertEqual(relationships.mystery_gender(self.config), 'male')
        scores = {'Mystery': dict(like=900, dislike=0, mood=dict.fromkeys(relationships.MOOD_KEYS, 5))}
        avery_tone = relationships.tone_guidance(avery, scores, self.config['agents'], self.config)
        for tier in ('soulbond', 'devoted partner', 'deep love', 'marriage-ready', 'You love Mystery'):
            self.assertNotIn(tier, avery_tone)
        self.assertIn('platonic', avery_tone)
        self.assertIn('soulbond', relationships.tone_guidance(blair, scores, self.config['agents'], self.config))
        for score in (101, 121, 201):
            s = {'Mystery': dict(like=score, dislike=0)}
            self.assertNotIn('marriage-ready', relationships.tone_guidance(avery, s, self.config['agents'], self.config))
            self.assertNotIn('want a committed future', relationships.tone_guidance(avery, s, self.config['agents'], self.config))
        store = server.life_store('Avery')
        self.assertEqual(engagement.heart(avery, {'Mystery': dict(like=300, dislike=0)}, self.config['agents'], store, self.config), '')
        self.assertIn('Unspoken love: you love Mystery',
                      engagement.heart(blair, {'Mystery': dict(like=300, dislike=0)}, self.config['agents'], store, self.config))
        self.assertIn('outside your romantic preference', relationships.mystery_guard(avery, self.config))
        self.assertEqual(relationships.mystery_guard(blair, self.config), '')
        self.assertIn('outside your romantic preference', server.make_prompt(avery, [], self.config['agents'], config=self.config))

    def test_date_invites_to_mystery_follow_preference(self):
        self.config['agents'] = romance_cast()
        self.assertFalse(self.meetups.eligible(self.cast_member('Avery'), 'Mystery', self.config))
        self.assertTrue(self.meetups.eligible(self.cast_member('Blair'), 'Mystery', self.config))
        self.assertEqual(self.invite('Avery', 'Mystery', kind='date')['kind'], 'hangout')
        self.assertEqual(self.invite('Blair', 'Mystery', kind='date')['kind'], 'date')
        unknown = dict(self.config, mystery=None)
        self.assertFalse(self.meetups.eligible(self.cast_member('Blair'), 'Mystery', unknown))
        self.assertNotIn('soulbond', relationships.tone_guidance(self.cast_member('Blair'), {'Mystery': dict(like=900, dislike=0)},
                                                                 self.config['agents'], unknown))

    def test_config_validation(self):
        for bad in ('male', {'gender': ''}, {'gender': 5}, ['male']):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                relationships.mystery_gender({'mystery': bad})
        self.assertIsNone(relationships.mystery_gender({'mystery': {'gender': None}}))


# ---- L1, L2, L7, L9, L10: provider plumbing ---------------------------------------------------------------------------
class ProviderPlumbingTests(Fixture):
    def test_fallback_drops_primary_effort_and_timeout(self):
        agent = dict(self.cast_member('Ji-woo'), effort='xhigh', timeout_seconds=7)
        seen = []
        def capture(agent, effective, *args):
            seen.append(effective)
            return meetups.Turn(('Hi.', 'note', [], None, {}, None, None))
        server.PROVIDER_EXHAUSTED['claude'] = time.time() + 600
        with patch.object(server, 'validated_turn', side_effect=capture):
            server.serve_turn(agent, 'prompt', [], self.config, self.config['agents'], None, False)
        self.assertEqual((seen[0]['provider'], seen[0]['effort']), ('cursor', 'low'))
        self.assertNotIn('timeout_seconds', seen[0])
        self.assertEqual(server.fallback_agent(agent, {'provider': 'codex', 'model': 'm', 'effort': 'high'})['effort'], 'high')

    def test_side_effect_failure_after_posting_is_not_a_provider_failure(self):
        self.reply_with(message='Hi Mystery.', remember=[self.record()])
        with patch.object(server, 'choose_next', return_value='Ji-woo'), \
             patch.object(life_memory.Store, 'apply', side_effect=RuntimeError('disk full')), \
             patch.object(self.meetups, 'choices', side_effect=OSError('broken')), \
             self.assertLogs('scenes', level='ERROR'):
            server.run_turn(self.config)
        rows = server.history()
        self.assertEqual([(m['name'], m['kind']) for m in rows], [('Ji-woo', 'chat')])
        self.assertEqual(server.CHARACTER_BREAKS, {})
        self.assertEqual(self.invoke.call_count, 1)

    def test_meetup_side_effect_failure_still_counts_as_a_successful_exchange(self):
        scene_id = self.start()
        with patch.object(server.relationships, 'save', side_effect=OSError('broken')), self.assertLogs('scenes', level='ERROR'):
            meta = self.step(scene_id)
        self.assertEqual((meta['exchanges'], meta['failures']), (1, {}))
        self.assertEqual([m['kind'] for m in meta['messages']], ['chat'])

    def test_room_error_text_is_concise_and_diagnostics_go_to_the_log(self):
        failure = server.ProviderError('claude exited 1: stdout={"path": "/home/secret/.config"} stderr=boom', 'boom')
        self.invoke.side_effect = failure
        with patch.object(server, 'choose_next', return_value='Ji-woo'), \
             self.assertLogs('server', level='WARNING') as logs:
            server.run_turn(self.config)
        error = server.history()[-1]
        self.assertEqual(error['kind'], 'error')
        self.assertEqual(error['text'], 'Ji-woo is taking a 60s break (provider error); other characters can continue.')
        self.assertNotIn('/home', server.STATE['reason'])
        self.assertIn('/home/secret', '\n'.join(logs.output))

    def test_timeout_never_waits_forever_on_escaped_pipes(self):
        proc = MagicMock()
        proc.__enter__.return_value = proc
        proc.__exit__.return_value = False  # Like Popen: never swallow the raised error.
        proc.communicate.side_effect = [subprocess.TimeoutExpired('x', 1), subprocess.TimeoutExpired('x', 5)]
        with patch.object(server.subprocess, 'Popen', return_value=proc), \
             patch.object(server.shutil, 'which', return_value='/usr/bin/claude'), \
             patch.object(server.os, 'killpg'):
            with self.assertRaises(server.ProviderTimeout):
                REAL_INVOKE(self.cast_member('Ji-woo'), 'Hi', 1)
        self.assertEqual(proc.communicate.call_args_list[1].kwargs, {'timeout': 5})
        proc.stdout.close.assert_called()
        proc.stderr.close.assert_called()

    def test_speaker_released_and_loop_survives_unexpected_errors(self):
        with patch.object(server, 'choose_next', return_value='Ji-woo'), \
             patch.object(server, 'make_prompt', side_effect=AttributeError('bug')):
            with self.assertRaises(AttributeError):
                server.run_turn(self.config)
        self.assertIsNone(server.STATE['speaker'])

    def test_memory_sweeps_respect_and_record_fallback_failures(self):
        self.config['memory_sweep'] = dict(enabled=True, every=1, provider='fallback')
        server.PROVIDER_EXHAUSTED['cursor'] = time.time() + 600
        with patch.object(memory_sweep, 'maybe_schedule') as schedule:
            server.schedule_memory_sweeps(self.config)
        schedule.assert_not_called()
        server.PROVIDER_EXHAUSTED.clear()
        for i in range(3):
            server.append('Mystery', f'@Ji-woo message {i}')
        quota = server.ProviderError('cursor exited 1', '{"is_error": true, "result": "Cursor usage limit reached"}')
        self.invoke.side_effect = quota
        with patch.object(memory_sweep, 'COOLDOWNS', {}), self.assertLogs('memory_sweep', level='WARNING'):
            thread = memory_sweep.maybe_schedule(
                self.cast_member('Ji-woo'), server.fallback_agent(self.cast_member('Ji-woo'), self.config['fallback']),
                self.config['memory_sweep'], server.history(), server.life_store('Ji-woo', self.config), server.invoke,
                on_failure=lambda exc: server.record_failure('cursor', exc))
            test_meetups.test_scenes.THREAD_START(thread)  # The fixture stubs Thread.start.
            thread.join(10)
        self.assertGreater(server.PROVIDER_EXHAUSTED['cursor'], time.time())


# ---- L3, L4, L8: scenes and meetups ------------------------------------------------------------------------------------
class SceneLifecycleTests(Fixture):
    def store_texts(self, name, scene_id):
        store = server.life_store(name)
        return [r['text'] for s in life_memory.SEGMENTS for r in store.load_segment(s) if r['source_id'] == scene_id]

    def test_summary_retry_and_fallback_never_duplicate_records(self):
        scene_id = self.start()
        with patch.object(server.relationships, 'award_scene', side_effect=OSError('scores locked')):
            with self.assertRaises(OSError):
                self.manager.summarize(scene_id)
        first = self.store_texts('Ji-woo', scene_id)
        self.assertEqual(len(first), 1)
        self.assertTrue(self.manager.meta(scene_id)['records_applied'])
        # A retry worded differently, then the fallback after another failure: still one record each.
        original = self.provider
        self.invoke.side_effect = lambda *args, **kwargs: original(*args, **kwargs).replace('coffee', 'tea')
        with patch.object(server.relationships, 'award_scene', side_effect=OSError('scores locked')), \
             self.assertLogs('meetups', level='ERROR'):
            self.meetups.close(scene_id)
        self.assertEqual(self.store_texts('Ji-woo', scene_id), first)
        self.assertEqual(len(self.store_texts('Grandpa Park', scene_id)), 1)
        self.assertNotIn('tea', ' '.join(self.store_texts('Ji-woo', scene_id)))
        self.assertEqual(self.manager.meta(scene_id)['status'], 'ended')

    def test_invite_is_marked_started_before_scene_metadata(self):
        invite = self.invite()
        self.accept(invite)
        with patch.object(self.manager, 'save', side_effect=OSError('crash while saving meta')):
            with self.assertRaises(OSError):
                self.meetups.tick(self.config)
        self.assertEqual(self.meetups.load()[0]['status'], 'started')
        self.meetups.tick(self.config)
        self.assertEqual(self.manager.list(), [])  # No duplicate launch from the same invitation.

    def test_existing_scene_for_invite_is_never_launched_again(self):
        invite = self.invite()
        self.accept(invite)
        self.manager.save(dict(id='a' * 32, title='x', kind='hangout', location='cafe', participants=['Ji-woo', 'Grandpa Park'],
                               visibility='private', status='ended', started_at=scenes.now(), ended_at=None,
                               summary='', autonomous=True, invite_id=invite['id']))
        self.meetups.tick(self.config)
        self.assertEqual(len(self.manager.list()), 1)
        self.assertEqual(self.meetups.load()[0]['status'], 'started')

    def test_scene_create_rejects_disabled_or_unreachable_characters(self):
        self.cast_member('The Landlady')['enabled'] = False
        with self.assertRaises(scenes.SceneError) as caught:
            self.manager.create(dict(participants=['The Landlady'], title='Walk', location='Garden'))
        self.assertEqual(caught.exception.code, 409)
        server.PROVIDER_EXHAUSTED.update(claude=time.time() + 600, cursor=time.time() + 600)
        with self.assertRaises(scenes.SceneError) as caught:
            self.manager.create(dict(participants=['Ji-woo'], title='Walk', location='Garden'))
        self.assertIn('provider unavailable', str(caught.exception))
        server.PROVIDER_EXHAUSTED.pop('cursor')
        self.assertEqual(self.manager.create(dict(participants=['Ji-woo'], title='Walk', location='Garden'))['status'], 'active')


# ---- L5: caches ---------------------------------------------------------------------------------------------------------
class CacheTests(Fixture):
    def test_history_parsed_once_until_the_log_changes(self):
        server.append('Mystery', 'one')
        reads = []
        original = Path.read_text
        def counting(path, *args, **kwargs):
            if path == server.LOG:
                reads.append(path)
            return original(path, *args, **kwargs)
        with patch.object(Path, 'read_text', counting):
            server.history()
            server.history()
            self.assertEqual(server.message_count(), 1)
            self.assertEqual(len(reads), 1)
            server.append('Mystery', 'two')
            self.assertEqual([m['text'] for m in server.history()], ['one', 'two'])
            self.assertEqual(len(reads), 2)

    def test_scene_list_cached_until_saved(self):
        scene = self.manager.create(dict(participants=['Ji-woo'], title='Walk', location='Garden'))
        self.manager.list()
        with patch.object(Path, 'glob', side_effect=AssertionError('re-scanned')):
            self.assertEqual(self.manager.away_reason('Ji-woo'), 'In a scene with Mystery')
            self.manager.list()
        meta = self.manager.meta(scene['id'])
        meta['status'] = 'ended'
        self.manager.save(meta)
        self.assertEqual(self.manager.away_reason('Ji-woo'), '')

    def test_meetup_tick_without_invites_never_reads_the_room_log(self):
        with patch.object(server, 'history', side_effect=AssertionError('read the log')):
            self.meetups.tick(self.config)


# ---- L6: Host / Origin -----------------------------------------------------------------------------------------------------
class HttpGuardTests(Fixture):
    def handler(self, port=8765, **headers):
        handler = MagicMock()
        handler.server.server_address = ('127.0.0.1', port)
        handler.headers = headers
        return handler

    def test_shared_guard_rules(self):
        guard = scenes.request_refused
        self.assertIsNone(guard(self.handler(Host='127.0.0.1:8765')))
        self.assertIsNone(guard(self.handler(Host='localhost:8765'), write=True))
        self.assertIsNone(guard(self.handler(Host='localhost:8765', Origin='http://127.0.0.1:8765'), write=True))
        self.assertEqual(guard(self.handler(Host='evil.example:8765')), 'unknown host refused')
        self.assertEqual(guard(self.handler(Host='127.0.0.1:9999')), 'unknown host refused')
        self.assertEqual(guard(self.handler(Host='127.0.0.1:8765', Origin='http://evil.example'), write=True),
                         'foreign origin refused')
        self.assertEqual(guard(self.handler(Host='127.0.0.1:8765', Origin='null'), write=True), 'foreign origin refused')
        self.assertEqual(guard(self.handler(Host='127.0.0.1:8765', **{'Sec-Fetch-Site': 'cross-site'}), write=True),
                         'cross-site request refused')

    def test_live_http_server_applies_guard_to_every_route(self):
        # Single-threaded server: the fixture stubs Thread.start, so start this one directly.
        httpd = http.server.HTTPServer(('127.0.0.1', 0), server.Handler)
        port = httpd.server_address[1]
        test_meetups.test_scenes.THREAD_START(threading.Thread(target=httpd.serve_forever, daemon=True))
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        def request(method, path, body=None, **headers):
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
            payload = json.dumps(body).encode() if body is not None else None
            connection.request(method, path, body=payload, headers=dict({'Content-Type': 'application/json'}, **headers))
            response = connection.getresponse()
            data = response.read()
            connection.close()
            return response.status, data
        host = f'127.0.0.1:{port}'
        self.assertEqual(request('GET', '/api/status', Host=f'rebind.example:{port}')[0], 403)
        self.assertEqual(request('GET', '/api/scenes', Host='evil.example')[0], 403)
        self.assertEqual(request('GET', '/api/status', Host=host)[0], 200)
        for path in ('/api/quiet', '/api/scenes', '/api/alarms/a12345678/cancel', '/api/control'):
            self.assertEqual(request('POST', path, {'quiet': True}, Host=host, Origin='http://evil.example')[0], 403)
        status, body = request('POST', '/api/quiet', {'quiet': True}, Host=host, Origin=f'http://{host}')
        self.assertEqual((status, json.loads(body)['quiet_room']), (200, True))
        status, body = request('POST', '/api/quiet', {'quiet': False}, Host=f'localhost:{port}')
        self.assertEqual((status, json.loads(body)['quiet_room']), (200, False))
        self.assertEqual(request('POST', '/api/quiet', {'quiet': 'yes'}, Host=host)[0], 400)


# ---- Quiet room ---------------------------------------------------------------------------------------------------------------
class QuietRoomTests(Fixture):
    def setUp(self):
        super().setUp()
        server.STATE.update(turns=0, limit=24, speaker=None)
        server.set_quiet_room(True)

    def chat(self, name, text, **fields):
        return server.append(name, text, recipient=fields.pop('to', None), **fields)

    def test_toggle_persists_and_is_reported(self):
        path = server.room_state_path()
        self.assertEqual(json.loads(path.read_text())['quiet_room'], True)
        self.assertTrue(server.status()['quiet_room'])
        server.set_quiet_room(False)
        self.assertFalse(server.quiet_room())
        self.assertFalse(server.status()['quiet_room'])
        with self.assertRaises(ValueError):
            server.set_quiet_room('on')

    def test_scheduler_only_picks_mystery_focused_turns(self):
        agents = self.config['agents']
        self.chat('Kim Min-jun', '@Ji-woo want to hear a joke?')
        self.chat('Ji-woo', 'Grandpa Park, come here.')
        messages = server.history()
        self.assertIsNotNone(server.priority_turn(messages, agents))  # Cast chatter is pending...
        self.assertIsNone(server.quiet_turn(messages, agents))  # ...but quiet ignores it.
        dm = self.chat('Mystery', 'Hey, are you awake?', to='The Landlady')
        name, focus, mode = server.quiet_turn(server.history(), agents)
        self.assertEqual((name, focus['id'], mode), ('The Landlady', dm['id'], 'reply'))

    def test_unaddressed_mystery_group_message_gets_exactly_one_reply_and_no_follow_on(self):
        self.chat('Kim Min-jun', 'The Landlady, did you eat?')
        self.chat('Mystery', 'Evening, everyone.')
        self.reply_with(message='Evening! @Kim Min-jun say hi to our guest.')
        server.ACTIVE.set()
        server.run_turn(self.config)
        replies = [m for m in server.history() if m['name'] not in ('Mystery', 'Kim Min-jun')]
        self.assertEqual(len(replies), 1)
        self.assertEqual(self.invoke.call_count, 1)
        self.assertIn('QUIET ROOM', self.invoke.call_args.args[1])
        server.run_turn(self.config)  # The @Kim Min-jun mention from a character does not trigger Kim Min-jun.
        self.assertEqual(self.invoke.call_count, 1)
        self.assertIn('Quiet room', server.STATE['reason'])

    def test_cast_dm_drafts_are_dropped_while_quiet(self):
        self.chat('Mystery', '@Ji-woo what do you think of Grandpa Park?')
        relationships.save('Ji-woo', {'Grandpa Park': {'like': 120, 'dislike': 0}})
        self.reply_with(message='Grandpa Park, psst.', to='Grandpa Park')
        server.ACTIVE.set()
        server.run_turn(self.config)
        self.assertEqual([m['name'] for m in server.history()], ['Mystery'])
        self.assertEqual(server.STATE['turns'], 1)

    def test_outreach_to_mystery_only(self):
        for i in range(10):
            self.chat('Mystery' if i == 0 else 'Kim Min-jun', f'line {i}')
        relationships.save('Ji-woo', {'Grandpa Park': {'like': 300, 'dislike': 0}})
        self.assertIsNone(server.quiet_turn(server.history(), self.config['agents']))  # No longing turn to cast.
        relationships.save('Ji-woo', {'Mystery': {'like': 300, 'dislike': 0}, 'Grandpa Park': {'like': 300, 'dislike': 0}})
        name, focus, mode = server.quiet_turn(server.history(), self.config['agents'])
        self.assertEqual((name, focus, mode), ('Ji-woo', None, 'outreach'))
        self.reply_with(message='I missed you.', to='Mystery')
        server.ACTIVE.set()
        server.run_turn(self.config)
        self.assertEqual((server.history()[-1]['name'], server.history()[-1]['to']), ('Ji-woo', 'Mystery'))
        self.assertIn('QUIET ROOM OUTREACH', self.invoke.call_args.args[1])
        self.assertNotIn('YOUR HEART: You miss Grandpa Park', self.invoke.call_args.args[1])

    def test_meetups_pause_for_characters_but_not_for_mystery(self):
        invite = self.invite()
        self.meetups.choices('Grandpa Park', meetups.Turn((), dict(invite_reply=dict(id=invite['id'], answer='accept'))), self.config)
        self.meetups.choices('The Landlady', meetups.Turn((), dict(invite=dict(to='Kim Min-jun', where='park'))), self.config)
        self.meetups.choices('Kim Min-jun', meetups.Turn((), dict(invite=dict(to='Mystery', where='park'))), self.config)
        rows = self.meetups.load()
        self.assertEqual([(r['from'], r['to'], r['status']) for r in rows],
                         [('Ji-woo', 'Grandpa Park', 'pending'), ('Kim Min-jun', 'Mystery', 'pending')])
        self.accept(invite)
        self.meetups.tick(self.config)
        self.assertEqual(self.manager.list(), [])  # Accepted cast invitation waits while quiet.
        server.set_quiet_room(False)
        self.meetups.tick(self.config)
        scene_id = self.manager.list()[0]['id']
        self.manager.jobs.clear()
        server.set_quiet_room(True)
        self.meetups.tick(self.config)
        self.assertNotIn(scene_id, self.manager.jobs)  # Character-only scene paused.
        self.meetups.join(scene_id)
        self.meetups.tick(self.config)
        self.assertIn(scene_id, self.manager.jobs)  # Mystery joined: it continues.


if __name__ == '__main__':
    unittest.main()
