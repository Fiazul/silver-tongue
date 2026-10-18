"""Offline route breaker and ordered failover regression tests."""
import io
import json
import time
import threading
import unittest
from test_support import HermeticTestCase
from unittest.mock import MagicMock, patch

import server
import test_scenes


class RecoveryTests(HermeticTestCase):
    def setUp(self):
        test_scenes.SceneTests.setUp(self)
        self.config['fallback'] = [dict(provider='cursor', model='auto'),
                                   dict(provider='cursor', model='composer-2.5'),
                                   dict(provider='opencode', model='opencode/mimo-v2.6-flash-free')]
        self.agent = next(a for a in self.config['agents'] if a['name'] == 'Milo')
        self.calls = []
        self.failures = {}
        self.now = time.time()
        for target, attr, value in ((server.time, 'time', lambda: self.now),
                                    (server, 'quota_reset', lambda *args: self.now + 3600)):
            patcher = patch.object(target, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(server.ACTIVE.clear)

    def provider(self, agent, prompt, timeout, images=None):
        key = server.route_key(agent['provider'], agent['model'])
        self.calls.append(key)
        if key in self.failures:
            raise self.failures[key]
        return json.dumps(dict(message='Still here.', memory='I joined in.', to=None))

    def serve(self):
        return server.serve_turn(self.agent, 'prompt', [], self.config, self.config['agents'], None, False)

    def exhaust(self, agent=None):
        agent = agent or self.agent
        server.record_failure(agent['provider'], server.ProviderError('quota', 'usage limit'), agent['model'])
        return server.route_key(agent['provider'], agent['model'])

    def test_trial_is_due_after_five_minutes_and_only_one_claim(self):
        key = self.exhaust()
        self.assertEqual(server.PROVIDER_TRIALS[key]['at'], self.now + 300)
        self.assertFalse(server.provider_ready(self.agent['provider'], self.agent['model']))
        self.now += 300
        self.assertEqual(server.provider_state(self.agent['provider'], self.agent['model']), 'trial pending')
        self.assertTrue(server.claim_route(self.agent['provider'], self.agent['model']))
        self.assertFalse(server.claim_route(self.agent['provider'], self.agent['model']))
        self.assertEqual(server.route_status(self.agent['provider'], self.agent['model'])['state'], 'trial in progress')

    def test_failed_trials_back_off_five_ten_twenty_and_cap_at_reset(self):
        key = self.exhaust()
        reset = server.PROVIDER_EXHAUSTED[key]
        for expected in (600, 1200, 1200):
            self.now = server.PROVIDER_TRIALS[key]['at']
            self.assertTrue(server.claim_route(self.agent['provider'], self.agent['model']))
            server.record_failure(self.agent['provider'], server.ProviderError('quota', 'out of usage'), self.agent['model'])
            self.assertEqual(server.PROVIDER_TRIALS[key]['backoff'], expected)
            self.assertEqual(server.PROVIDER_TRIALS[key]['at'], min(reset, self.now + expected))
            self.assertEqual(server.PROVIDER_EXHAUSTED[key], reset)

    def test_short_reset_wins_and_seven_day_cap_remains(self):
        with patch.object(server, 'quota_reset', return_value=self.now + 40):
            key = self.exhaust()
        self.assertEqual(server.PROVIDER_TRIALS[key]['at'], self.now + 40)
        self.now += 40
        self.assertTrue(server.provider_ready(self.agent['provider'], self.agent['model']))
        from datetime import datetime, timezone
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.assertEqual(REAL_QUOTA('reset 2030-01-01T00:00:00Z', now), now.timestamp() + 7 * 86400)

    def test_success_recovers_every_character_sharing_route(self):
        key = self.exhaust()
        self.now += 300
        self.serve()
        self.assertEqual(self.calls, [key])
        self.assertNotIn(key, server.PROVIDER_TRIALS)
        self.assertNotIn(key, server.PROVIDER_EXHAUSTED)
        for agent in self.config['agents']:
            if agent['provider'] == 'codex':
                self.assertTrue(server.reachable(agent, dict(fallback=None)))

    def test_bad_reply_clears_quota_and_unexpected_failure_releases_claim(self):
        key = self.exhaust()
        self.now += 300
        with patch.object(server, 'validated_turn', side_effect=ValueError('bad JSON')):
            with self.assertRaises(ValueError):
                server.serve_turn(self.agent, 'prompt', [], dict(self.config, fallback=None), self.config['agents'], None, False)
        self.assertNotIn(key, server.PROVIDER_EXHAUSTED)
        key = self.exhaust()
        self.now += 300
        with patch.object(server, 'validated_turn', side_effect=AttributeError('unexpected')):
            with self.assertRaises(AttributeError):
                self.serve()
        self.assertFalse(server.PROVIDER_TRIALS[key]['inflight'])
        self.assertGreater(server.PROVIDER_TRIALS[key]['at'], self.now)

    def test_cursor_auto_exhaustion_falls_through_to_composer_then_opencode(self):
        quota = server.ProviderError('quota', 'out of included usage')
        self.failures.update({'codex/gpt-6-luna': quota, 'cursor/auto': quota})
        turn = self.serve()
        self.assertEqual(turn[-1], 'cursor/composer-2.5')
        self.assertEqual(self.calls, ['codex/gpt-6-luna', 'cursor/auto', 'cursor/composer-2.5'])
        self.calls.clear()
        self.failures['cursor/composer-2.5'] = quota
        turn = self.serve()
        self.assertEqual(turn[-1], 'opencode/opencode/mimo-v2.6-flash-free')
        self.assertEqual(self.calls, ['cursor/composer-2.5', 'opencode/opencode/mimo-v2.6-flash-free'])

    def test_legacy_object_null_duplicate_and_list_validation(self):
        self.assertEqual(server.fallbacks_for(self.agent, dict(fallback=dict(provider='cursor', model='auto'))),
                         [dict(provider='cursor', model='auto')])
        self.assertEqual(server.fallbacks_for(dict(self.agent, fallback=None), self.config), [])
        self.assertEqual(len(server.fallbacks_for(self.agent, dict(fallback=[self.agent, *self.config['fallback'], self.config['fallback'][0]]))), 3)
        for value in ([dict(provider='cursor')], [None], 'cursor', [dict(provider='unknown', model='auto')]):
            bad = dict(self.config, fallback=value)
            with self.subTest(value=value), patch.object(server.CONFIG.__class__, 'read_text', return_value=json.dumps(bad)):
                # load_config is mocked by the scene fixture: call the original saved below.
                with self.assertRaises(ValueError):
                    REAL_LOAD()

    def test_retry_now_clears_shared_character_breaks_and_respects_inflight(self):
        key = self.exhaust()
        for name in ('Milo', 'Nora'):
            server.CHARACTER_BREAKS[name] = time.monotonic() + 60
        server.retry_provider(self.agent['provider'], self.agent['model'], self.config, 'Nora')
        self.assertTrue(server.provider_ready(self.agent['provider'], self.agent['model']))
        self.assertNotIn('Milo', server.CHARACTER_BREAKS)
        self.assertNotIn('Nora', server.CHARACTER_BREAKS)
        server.claim_route(self.agent['provider'], self.agent['model'])
        server.retry_provider(self.agent['provider'], self.agent['model'], self.config)
        self.assertTrue(server.PROVIDER_TRIALS[key]['inflight'])
        with self.assertRaises(ValueError):
            server.retry_provider('cursor', 'unknown-model', self.config)

    def test_sweeps_skip_trials_and_pick_first_fully_ready_fallback(self):
        self.config['memory_sweep'] = dict(enabled=True, every=1, provider='fallback')
        route = self.config['fallback'][0]
        key = self.exhaust(route)
        self.now += 300
        import memory_sweep
        with patch.object(memory_sweep, 'maybe_schedule') as schedule:
            server.schedule_memory_sweeps(self.config)
        self.assertTrue(schedule.called)
        self.assertTrue(all(c.args[1]['model'] == 'composer-2.5' for c in schedule.call_args_list))
        self.assertFalse(server.PROVIDER_TRIALS[key]['inflight'])

    def test_retry_route_uses_shared_origin_guard_and_accepts_post(self):
        # Real handler, in-memory request/response (no socket needed).
        payload = json.dumps(dict(provider='codex', model='gpt-6-luna')).encode()
        handler = object.__new__(server.Handler)
        handler.path = '/api/providers/retry'
        handler.headers = {'Host': 'localhost:8765', 'Origin': 'http://evil.test', 'Content-Length': str(len(payload))}
        handler.server = type('Server', (), {'server_port': 8765})()
        handler.rfile = io.BytesIO(payload)
        with patch.object(handler, 'send_json') as send:
            handler.do_POST()
            self.assertEqual(send.call_args.args[1], 403)
        handler.headers['Origin'] = 'http://localhost:8765'
        with patch.object(handler, 'send_json') as send:
            handler.do_POST()
            self.assertIn('providers', send.call_args.args[0])
        self.assertEqual(server.provider_state('codex', 'gpt-6-luna'), 'trial pending')

    def test_cursor_diagnostics_are_quota_but_model_text_is_never_evidence(self):
        cursor = dict(self.agent, provider='cursor', model='auto')
        samples = [
            ('You are out of usage on your plan', '', 1, 'quota'),
            ('Included usage exhausted', '', 0, 'quota'),
            (json.dumps(dict(type='error', message='exceeded your plan limit')), '', 1, 'quota'),
            ('\n'.join([json.dumps(dict(type='system', message='starting')), json.dumps(dict(type='error', message='out of usage'))]), '', 1, 'quota'),
            (json.dumps(dict(type='result', result='My included usage of tea is exceeded')), 'segfault', 1, 'crash'),
        ]
        for stdout, stderr, code, category in samples:
            proc = MagicMock()
            proc.__enter__.return_value = proc
            proc.communicate.return_value = (stdout, stderr)
            proc.returncode = code
            with self.subTest(stdout=stdout), patch.object(server.subprocess, 'Popen', return_value=proc), patch.object(server.shutil, 'which', return_value='/usr/bin/cursor-agent'):
                with self.assertRaises(server.ProviderError) as caught:
                    REAL_INVOKE(cursor, 'prompt', 1)
                self.assertEqual(server.classify_failure(caught.exception), category)

    def test_all_invocation_paths_share_one_subprocess_slot(self):
        first, second_started, release = threading.Event(), threading.Event(), threading.Event()
        stats = dict(running=0, peak=0)
        counter_lock = threading.Lock()
        def fake(*args):
            with counter_lock:
                stats['running'] += 1
                stats['peak'] = max(stats['peak'], stats['running'])
            first.set()
            release.wait(2)
            with counter_lock:
                stats['running'] -= 1
            return 'answer'
        def second():
            second_started.set()
            REAL_INVOKE(self.agent, 'second', 1)
        with patch.object(server, '_invoke', side_effect=fake):
            one = threading.Thread(target=REAL_INVOKE, args=(self.agent, 'first', 1))
            two = threading.Thread(target=second)
            try:
                test_scenes.THREAD_START(one)
                self.assertTrue(first.wait(1))
                test_scenes.THREAD_START(two)
                self.assertTrue(second_started.wait(1))
            finally:
                release.set()
                one.join(2)
                two.join(2)
        self.assertEqual(stats['peak'], 1)
        self.assertFalse(one.is_alive() or two.is_alive())


REAL_LOAD = server.load_config
REAL_QUOTA = server.quota_reset

REAL_INVOKE = server.invoke
