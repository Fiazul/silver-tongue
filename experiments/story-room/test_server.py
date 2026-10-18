import json
from pathlib import Path
import tempfile
import unittest
from test_support import HermeticTestCase, romance_cast
from unittest.mock import patch

import server


class RoomTests(HermeticTestCase):
    def setUp(self):
        from datetime import datetime, timezone
        clock_patch = patch.object(server.TIMEKEEPER, 'clock', return_value=datetime(2026, 10, 16, 6, tzinfo=timezone.utc))
        clock_patch.start()
        self.addCleanup(clock_patch.stop)
        cooldowns = patch.dict(server.PROVIDER_BREAKS, {}, clear=True)
        cooldowns.start()
        self.addCleanup(cooldowns.stop)
        for state in (server.PROVIDER_EXHAUSTED, server.PROVIDER_TRIALS, server.CHARACTER_BREAKS):
            patcher = patch.dict(state, {}, clear=True)
            patcher.start()
            self.addCleanup(patcher.stop)
        scores = tempfile.TemporaryDirectory()
        self.addCleanup(scores.cleanup)
        patcher = patch.object(server.relationships, 'FILE', Path(scores.name)/'relationships.json')
        patcher.start()
        self.addCleanup(patcher.stop)
        memory_patch = patch.object(server, 'MEMORY', Path(scores.name)/'memories.json')
        memory_patch.start()
        self.addCleanup(memory_patch.stop)
        reset_patch = patch.object(server, 'RESETS', Path(scores.name)/'character-resets.json')
        reset_patch.start()
        self.addCleanup(reset_patch.stop)

    def tearDown(self):
        server.ACTIVE.clear()
        server.STOP.clear()
        if hasattr(server, 'WAKE'):
            server.WAKE.clear()
        server.STATE.update(speaker=None, turns=0, limit=12, reason="Ready")

    def provider_process(self, provider, reply=None, error=None, returncode=0):
        from unittest.mock import MagicMock
        proc = MagicMock()
        proc.__enter__.return_value = proc
        proc.returncode = returncode
        if error:
            output = json.dumps({'type': 'turn.failed' if provider == 'codex' else 'error', 'error': error})
        elif provider in ('claude', 'agy', 'cursor'):
            output = json.dumps({'type': 'result', 'result': json.dumps(reply)})
        elif provider == 'codex':
            output = json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': json.dumps(reply)}})
        else:
            output = json.dumps({'type': 'text', 'part': {'text': json.dumps(reply)}})
        proc.communicate.return_value = (output, 'misleading skill warning' if returncode else '')
        return proc

    def fallback_config(self, provider='claude'):
        agent = next(a for a in server.load_config()['agents'] if a['provider'] == provider).copy()
        agent['enabled'] = True
        return {'agents': [agent], 'fallback': {'provider': 'cursor', 'model': 'auto'}}

    def test_all_providers_share_quota_classifier(self):
        examples = ['api_error_status:429 usage_limit_reached', 'turn.failed: You have hit your usage limit',
                    'RESOURCE_EXHAUSTED: quota exhausted', 'free-tier rejection', 'Cursor usage limit reached']
        for text in examples:
            with self.subTest(text=text):
                self.assertEqual(server.classify_failure(RuntimeError(text)), 'quota')
        self.assertEqual(server.classify_failure(server.ProviderTimeout('slow')), 'timeout')
        self.assertEqual(server.classify_failure(RuntimeError('exited 1')), 'crash')
        self.assertEqual(server.classify_failure(ValueError('wrong DM recipient')), 'bad_reply')

    def test_claude_429_marks_exhausted_until_provider_reset_and_serves_cursor(self):
        from datetime import datetime, timezone
        config = self.fallback_config()
        now = datetime(2026, 10, 15, 11, 0, tzinfo=timezone.utc)
        failure = self.provider_process('claude', error={'api_error_status': 429, 'api_error': 'usage_limit_reached',
            'result': "You've hit your session limit · resets 9:10pm (Asia/Seoul)"}, returncode=1)
        reply = {'message': 'Still here.', 'memory': 'I greeted the room.', 'to': None}
        good = self.provider_process('cursor', reply)
        expected = datetime(2026, 10, 15, 12, 10, tzinfo=timezone.utc).timestamp()
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, 'LOG', Path(tmp)/'messages.jsonl'), \
             patch.object(server, 'MEMORY', Path(tmp)/'memories.json'), \
             patch.object(server.time, 'time', return_value=now.timestamp()), \
             patch.object(server, 'datetime', wraps=datetime) as date, \
             patch.object(server.subprocess, 'Popen', side_effect=[failure, good]) as launch:
            date.now.return_value = now
            server.ACTIVE.set()
            server.run_turn(config)
            self.assertEqual(server.PROVIDER_EXHAUSTED[server.route_key('claude', config['agents'][0]['model'])], expected)
            self.assertEqual(launch.call_count, 2)
            self.assertEqual(server.history()[-1]['served_by'], 'cursor/auto')
            self.assertTrue(server.ACTIVE.is_set())
            status = server.character_status(config['agents'][0], config)
            self.assertTrue(status['enabled'])
            self.assertIn('Claude quota reached until 21:10', status['away_reason'])
            self.assertIn('using Cursor', status['away_reason'])

    def test_each_primary_crash_serves_same_character_using_cursor(self):
        reply = {'message': 'Hello.', 'memory': 'I said hello.', 'to': None}
        for provider in ('claude', 'codex', 'agy', 'opencode'):
            with self.subTest(provider=provider), tempfile.TemporaryDirectory() as tmp, \
                 patch.object(server, 'LOG', Path(tmp)/'messages.jsonl'), \
                 patch.object(server, 'MEMORY', Path(tmp)/'memories.json'), \
                 patch.object(server.subprocess, 'Popen', side_effect=[self.provider_process(provider, error='crashed', returncode=1), self.provider_process('cursor', reply)]) as launch:
                config = self.fallback_config(provider)
                server.STATE.update(turns=0, speaker=None, limit=12)
                server.ACTIVE.set()
                server.run_turn(config)
                self.assertEqual(server.history()[-1]['name'], config['agents'][0]['name'])
                self.assertEqual(server.history()[-1]['served_by'], 'cursor/auto')
                self.assertEqual(launch.call_count, 2)
                self.assertEqual(launch.call_args_list[0].kwargs['cwd'], launch.call_args_list[0].kwargs['env']['PWD'])
                self.assertTrue(server.ACTIVE.is_set())

    def test_timeout_kills_process_group_then_fallback_serves(self):
        config = self.fallback_config('opencode')
        failed = self.provider_process('opencode')
        failed.communicate.side_effect = [server.subprocess.TimeoutExpired('opencode', 45), ('', '')]
        reply = {'message': 'Made it.', 'memory': 'I joined the room.', 'to': None}
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, 'LOG', Path(tmp)/'messages.jsonl'), \
             patch.object(server, 'MEMORY', Path(tmp)/'memories.json'), \
             patch.object(server.os, 'killpg') as kill, \
             patch.object(server.subprocess, 'Popen', side_effect=[failed, self.provider_process('cursor', reply)]):
            server.ACTIVE.set()
            server.run_turn(config)
            kill.assert_called_once_with(failed.pid, server.signal.SIGKILL)
            self.assertIn(server.route_key('opencode', 'opencode/mimo-v2.6-flash-free'), server.PROVIDER_BREAKS)
            self.assertEqual(server.history()[-1]['served_by'], 'cursor/auto')
            self.assertIn(config['agents'][0], server.available_agents(config['agents'], config))
            self.assertTrue(server.ACTIVE.is_set())

    def test_failed_fallback_breaks_only_character(self):
        config = self.fallback_config()
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, 'LOG', Path(tmp)/'messages.jsonl'), \
             patch.object(server.subprocess, 'Popen', side_effect=[self.provider_process('claude', error='crashed', returncode=1), self.provider_process('cursor', error='crashed', returncode=1)]):
            server.ACTIVE.set()
            server.run_turn(config)
            self.assertTrue(server.ACTIVE.is_set())
            self.assertIn(config['agents'][0]['name'], server.CHARACTER_BREAKS)
            self.assertEqual([m['kind'] for m in server.history()], ['error'])
            self.assertEqual(server.available_agents(config['agents'], config), [])
            server.run_turn(config)
            self.assertTrue(server.ACTIVE.is_set())

    def test_exhausted_provider_skips_primary_subprocess(self):
        config = self.fallback_config()
        server.PROVIDER_EXHAUSTED['claude'] = server.time.time() + 1800
        reply = {'message': 'Hello.', 'memory': 'I greeted everyone.', 'to': None}
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, 'LOG', Path(tmp)/'messages.jsonl'), \
             patch.object(server, 'MEMORY', Path(tmp)/'memories.json'), \
             patch.object(server.subprocess, 'Popen', return_value=self.provider_process('cursor', reply)) as launch:
            server.ACTIVE.set()
            server.run_turn(config)
            self.assertEqual(launch.call_count, 1)
            self.assertTrue(launch.call_args.args[0][0].endswith('cursor-agent'))
            self.assertEqual(server.history()[-1]['served_by'], 'cursor/auto')

    def test_bad_content_uses_fallback_without_saving_primary_state(self):
        config = self.fallback_config()
        valid = {'message': 'Hi.', 'memory': 'Good memory.', 'to': None}
        variants = [dict(valid, message=''), dict(valid, memory=''), dict(valid, to='Nobody')]
        for bad in variants:
            server.CHARACTER_BREAKS.clear()
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as tmp, \
                 patch.object(server, 'LOG', Path(tmp)/'messages.jsonl'), \
                 patch.object(server, 'remember') as remember, \
                 patch.object(server, 'invoke', side_effect=lambda agent, *args, **kwargs: json.dumps(valid if agent['provider'] == 'cursor' else bad)) as invoke:
                server.STATE.update(speaker=None, turns=0)
                server.ACTIVE.set()
                server.run_turn(config)
                self.assertEqual(server.history()[-1]['served_by'], 'cursor/auto')
                remember.assert_called_once_with(config['agents'][0]['name'], 'Good memory.')
                self.assertLessEqual(invoke.call_count, 3)
        extras = [dict(attachments=['/etc/passwd']), dict(attachments='bad'),
                  dict(scores={'Mystery': {'like': 1501, 'dislike': 0}})]
        for extra in extras:
            with self.subTest(extra=extra), patch.object(server, 'invoke', return_value=json.dumps(dict(valid, **extra))):
                reply = server.serve_turn(config['agents'][0], 'fixture prompt', [], config,
                                          config['agents'], None, False)
                self.assertEqual(reply[0], valid['message'])
                self.assertIsNone(reply[-1])  # Optional extras do not force a fallback.
                self.assertEqual(reply[2], [])
                if 'scores' in extra:
                    self.assertEqual(reply[4]['Mystery']['like'], 1500)

    def test_garbled_reply_repairs_once_then_falls_back(self):
        config = self.fallback_config()
        reply = json.dumps({'message': 'Hi.', 'memory': 'I greeted everyone.', 'to': None})
        with patch.object(server, 'invoke', side_effect=['{"message":', '{"message":', reply]) as invoke:
            result = server.serve_turn(config['agents'][0], 'Same prompt', [], config, config['agents'], None, False)
            self.assertEqual(result[-1], 'cursor/auto')
            self.assertEqual(invoke.call_count, 3)
            self.assertEqual(invoke.call_args_list[0].args[1], invoke.call_args_list[2].args[1])

    def test_fallback_override_and_null_disable(self):
        config = self.fallback_config()
        agent = dict(config['agents'][0], fallback=None)
        self.assertIsNone(server.fallback_for(agent, config))
        agent['fallback'] = {'provider': 'codex', 'model': 'gpt-6-luna'}
        self.assertEqual(server.fallback_for(agent, config), agent['fallback'])
        server.PROVIDER_EXHAUSTED['claude'] = server.time.time() + 10
        agent['fallback'] = None
        self.assertEqual(server.available_agents([agent], config), [])

    def test_actor_repair_shares_single_timeout_budget(self):
        clock = [100.0]
        timeouts = []
        def invoke(agent, prompt, timeout, **kwargs):
            timeouts.append(timeout)
            clock[0] += 8
            return '{"message":' if len(timeouts) == 1 else '{"message":"ok"}'
        with patch.object(server.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(server, 'invoke', side_effect=invoke):
            server.actor_result(self.fallback_config()['agents'][0], 'prompt', 10, [])
        self.assertEqual(timeouts, [10, 2])

    def test_effort_flags_default_global_and_character_overrides(self):
        reply = dict(message='Hello.', memory='I said hello.', to=None)
        cases = [({}, {}, 'low'), ({}, {'effort': 'medium'}, 'medium'),
                 ({'effort': 'low'}, {'effort': 'medium'}, 'low'),
                 ({'effort': 'medium'}, {}, 'medium')]
        for provider in ('claude', 'codex', 'agy'):
            for override, config, expected in cases:
                with self.subTest(provider=provider, override=override, config=config):
                    agent = dict(name='Test', provider=provider, model='test-model', **override)
                    with patch.object(server, 'load_config', return_value=config), \
                         patch.object(server.subprocess, 'Popen', return_value=self.provider_process(provider, reply)) as launch:
                        server.invoke(agent, 'prompt', 5)
                    argv = launch.call_args.args[0]
                    if provider == 'codex':
                        self.assertIn('model_reasoning_effort=' + json.dumps(expected), argv)
                    else:
                        self.assertEqual(argv[argv.index('--effort') + 1], expected)
        for provider in ('cursor', 'opencode'):
            with patch.object(server, 'load_config', return_value={'effort': 'medium'}), \
                 patch.object(server.subprocess, 'Popen', return_value=self.provider_process(provider, reply)) as launch:
                server.invoke(dict(name='Test', provider=provider, model='test-model', effort='medium'), 'prompt', 5)
            self.assertNotIn('--effort', launch.call_args.args[0])

    def test_effort_and_memory_config_validation(self):
        jiwoo = dict(name='Ji-woo', provider='claude', model='fixture-sonnet', effort='medium',
                    gender='female', personality='A fixture character.', enabled=True)
        config = dict(agents=[jiwoo], effort='low')
        self.assertEqual(server.effort_for(jiwoo, config), 'medium')
        for provider, value in (('claude', 'ultra'), ('agy', 'ultra'), ('codex', 'banana')):
            with self.assertRaises(ValueError):
                server.effort_for(dict(provider=provider, effort=value), {})
        self.assertEqual(server.effort_for(dict(provider='codex', effort='ultra'), {}), 'ultra')
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, 'CONFIG', Path(tmp) / 'agents.json'):
            for field, bad in (('embeddings', {'enabled': True, 'timeout': 4}),
                               ('memory_sweep', {'enabled': True, 'every': 0}),
                               ('effort', 'banana')):
                changed = dict(config, **{field: bad})
                if field == 'effort':
                    changed['agents'] = [{k: v for k, v in jiwoo.items() if k != 'effort'}]
                server.CONFIG.write_text(json.dumps(changed))
                with self.subTest(field=field), self.assertRaises(ValueError):
                    server.load_config()

    def test_cursor_flags_images_and_isolation(self):
        agent = dict(self.fallback_config()['agents'][0], provider='cursor', model='auto')
        with patch.object(server.subprocess, 'Popen', return_value=self.provider_process('cursor', {'message': 'hello'})) as launch:
            server.invoke(agent, 'Hello', 5, [Path('/tmp/picture.png')])
            argv, kwargs = launch.call_args.args[0], launch.call_args.kwargs
            for flag in ('--print', '--trust', '--model', '--image'):
                self.assertIn(flag, argv)
            for flag in ('--force', '--yolo', '--auto-review', '--approve-mcps'):
                self.assertNotIn(flag, argv)
            self.assertEqual(argv[argv.index('--mode')+1], 'ask')
            self.assertTrue(kwargs['env']['CURSOR_CONFIG_DIR'].startswith(kwargs['cwd']))
            self.assertTrue(kwargs['env']['CURSOR_DATA_DIR'].startswith(kwargs['cwd']))

    def test_codex_preserves_user_home_auth_and_structured_failure(self):
        agent = self.fallback_config('codex')['agents'][0]
        with patch.dict(server.os.environ, {'HOME': '/tmp/original-home', 'CODEX_HOME': '/tmp/original-codex'}), \
             patch.object(server.shutil, 'copyfile') as copy_auth, \
             patch.object(server.subprocess, 'Popen', return_value=self.provider_process('codex', error='usage limit reached', returncode=1)) as launch:
            with self.assertRaisesRegex(RuntimeError, 'usage limit reached'):
                server.invoke(agent, 'Hi', 5)
            env = launch.call_args.kwargs['env']
            self.assertEqual(env['HOME'], '/tmp/original-home')
            self.assertEqual(env['CODEX_HOME'], '/tmp/original-codex')
            copy_auth.assert_not_called()

    def test_codex_five_hour_errors_are_quota_with_reset(self):
        from datetime import datetime, timezone
        now = datetime(2026, 10, 15, 11, 0, tzinfo=timezone.utc)
        expected = datetime(2026, 10, 15, 12, 10, tzinfo=timezone.utc).timestamp()
        agent = self.fallback_config('codex')['agents'][0]
        for event_type in ('turn.failed', 'error'):
            for message in ("You've hit your 5-hour limit. Try again at 9:10pm (Asia/Seoul)",
                            'Usage-limit reached; resets 2026-10-15T12:10:00Z'):
                proc = self.provider_process('codex', error=message, returncode=1)
                proc.communicate.return_value = (json.dumps({'type': event_type, 'error': {'message': message}}),
                                                 'failed to load skill: missing field description')
                with self.subTest(event=event_type, message=message), \
                     patch.object(server.subprocess, 'Popen', return_value=proc), \
                     patch.object(server, 'datetime', wraps=datetime) as date:
                    date.now.return_value = now
                    with self.assertRaises(RuntimeError) as caught:
                        server.invoke(agent, 'Hi', 5)
                    self.assertNotIn('missing field description', str(caught.exception))
                    self.assertEqual(server.record_failure('codex', caught.exception), 'quota')
                    self.assertEqual(server.PROVIDER_EXHAUSTED['codex'], expected)

    def test_quota_reset_fallback_and_expiry(self):
        from datetime import datetime, timezone
        now = datetime(2026, 10, 15, 13, 0, tzinfo=timezone.utc)
        self.assertEqual(server.quota_reset('quota', now), now.timestamp()+1800)
        self.assertEqual(server.quota_reset('reset 2026-10-15T14:00:00Z', now), now.timestamp()+3600)
        self.assertEqual(server.quota_reset('resets 9:10pm (Asia/Seoul)', now), now.timestamp()+23*3600+10*60)
        server.PROVIDER_EXHAUSTED['claude'] = 0
        self.assertTrue(server.provider_ready('claude'))


    def test_wrong_dm_recipient_falls_back_to_same_dm_sender(self):
        config = self.fallback_config()
        focus = {'id': '1', 'name': 'Mystery', 'text': 'Hi', 'channel': 'dm', 'to': 'Kim Min-jun'}
        bad = json.dumps({'message': 'Hello', 'memory': 'Bad memory', 'to': 'Ji-woo'})
        good = json.dumps({'message': 'Hey', 'memory': 'Good memory', 'to': 'Mystery'})
        with patch.object(server, 'invoke', side_effect=[bad, good]) as invoke:
            result = server.serve_turn(config['agents'][0], 'Prompt', [], config, config['agents'], focus, False)
            self.assertEqual(result[3], 'Mystery')
            self.assertEqual(result[-1], 'cursor/auto')
            self.assertEqual(invoke.call_count, 2)

    def test_other_character_continues_after_both_providers_fail(self):
        config = self.fallback_config()
        config['agents'].append(server.load_config()['agents'][1])
        good = json.dumps({'message': 'Hello', 'memory': 'I greeted the group', 'to': None})
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, 'LOG', Path(tmp)/'messages.jsonl'), \
             patch.object(server, 'MEMORY', Path(tmp)/'memories.json'), \
             patch.object(server, 'choose_next', side_effect=['Kim Min-jun', 'Ji-woo']), \
             patch.object(server, 'invoke', side_effect=[RuntimeError('primary crashed'), RuntimeError('fallback crashed'), good]) as invoke:
            server.ACTIVE.set()
            server.run_turn(config)
            server.run_turn(config)
            self.assertEqual(server.history()[-1]['name'], 'Ji-woo')
            self.assertEqual(server.history()[-1]['kind'], 'chat')
            self.assertEqual(invoke.call_count, 3)
            self.assertTrue(server.ACTIVE.is_set())

    def test_primary_repair_cannot_consume_fallback_budget(self):
        config = self.fallback_config('opencode')
        clock = [100.0]
        observed = []
        def invoke(agent, prompt, timeout, **kwargs):
            observed.append((agent['provider'], timeout))
            if agent['provider'] == 'opencode':
                clock[0] += 30
                return '{"message":'
            return '{"message":"Hey", "memory":"I said hello"}'
        with patch.object(server.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(server, 'invoke', side_effect=invoke):
            result = server.serve_turn(config['agents'][0], 'Prompt', [], config, config['agents'], None, False)
            self.assertEqual(result[-1], 'cursor/auto')
            self.assertEqual(observed, [('opencode', 45), ('opencode', 15), ('cursor', 90)])

    def test_malformed_provider_event_shapes_are_bad_replies(self):
        for provider in ('claude', 'codex', 'agy', 'opencode', 'cursor'):
            for output in ('null', '[1]', '7', '"oops"'):
                with self.subTest(provider=provider, output=output), self.assertRaises(ValueError):
                    server.parse_reply(provider, output)


    def test_mentions_match_whole_names(self):
        self.assertEqual(server.mentions("@Ji-wooExtra, meet @The Landlady!", ["Ji-woo", "The Landlady"]), ["The Landlady"])

    def test_complete_reply_is_not_cut_at_a_word_or_character_limit(self):
        message = "Alex, I'm not asking you to fix it alone. Are you safe right now, or still in the engine room? I can wait until you're somewhere quiet."
        self.assertEqual(server.compact_message(message), message)

    def test_everyone_gets_a_turn_before_repeating(self):
        agents = [{"name": n} for n in ["Kim Min-jun", "Ji-woo", "Grandpa Park"]]
        messages = [{"name": "Kim Min-jun", "text": "Hello everyone"}, {"name": "Ji-woo", "text": "How is the evening?"}]
        self.assertEqual(server.choose_next(messages, agents), "Grandpa Park")

    def test_direct_mention_overrides_turn_balancing(self):
        agents = [{'name': n} for n in ['Kim Min-jun', 'Ji-woo', 'Grandpa Park']]
        messages = [{'id': '1', 'name': 'Kim Min-jun', 'text': '@Ji-woo hi'},
                    {'id': '2', 'name': 'Ji-woo', 'text': '@Kim Min-jun your turn'}]
        self.assertEqual(server.choose_next(messages, agents), 'Kim Min-jun')

    def test_actor_mention_loop_leaves_room_for_an_independent_turn(self):
        agents = [{'name': n} for n in ['Kim Min-jun', 'Ji-woo', 'Grandpa Park']]
        messages = [{'id': str(i), 'name': 'Grandpa Park' if i % 2 else 'Kim Min-jun', 'text': '@Kim Min-jun hi' if i % 2 else '@Grandpa Park hi', 'channel': 'group'} for i in range(1, 4)]
        self.assertEqual(server.choose_next(messages, agents), 'Kim Min-jun')
        messages.append({'id': '4', 'name': 'Mystery', 'text': '@Kim Min-jun urgent question', 'channel': 'group'})
        self.assertEqual(server.choose_next(messages, agents), 'Kim Min-jun')

    def test_character_reset_excludes_old_history_and_reply_requests(self):
        agents = server.load_config()['agents']
        jiwoo = next(a for a in agents if a['name'] == 'Ji-woo')
        server.RESETS.write_text(json.dumps({'Ji-woo': 100}))
        messages = [{'id': '99', 'name': 'Mystery', 'text': '@Ji-woo OLD_PRIVATE_STORY', 'channel': 'dm', 'to': 'Ji-woo'},
                    {'id': '101', 'name': 'Kim Min-jun', 'text': 'NEW_SHARED_HELLO', 'channel': 'group'}]
        prompt = server.make_prompt(jiwoo, messages, agents)
        self.assertNotIn('OLD_PRIVATE_STORY', prompt)
        self.assertIn('NEW_SHARED_HELLO', prompt)
        self.assertIsNone(server.priority_turn(messages, agents))

    def test_new_question_is_not_answered_by_an_older_inflight_reply(self):
        agents = [{'name': n} for n in ['The Corner Shop Clerk', 'The Landlady', 'Kim Min-jun']]
        messages = [{'id': '1', 'name': 'Mystery', 'text': 'the corner shop clerk what game are you making?'},
                    {'id': '2', 'name': 'The Corner Shop Clerk', 'text': 'Old topic', 'reply_to': 'older'},
                    {'id': '3', 'name': 'The Landlady', 'text': '@Kim Min-jun hello'}]
        name, focus = server.priority_turn(messages, agents)
        self.assertEqual((name, focus['id']), ('The Corner Shop Clerk', '1'))

    def test_answering_latest_dm_does_not_resurrect_older_messages(self):
        agents = [{'name': 'Ji-woo'}]
        messages = [{'id': '1', 'name': 'Mystery', 'text': 'Fine', 'channel': 'dm', 'to': 'Ji-woo'},
                    {'id': '2', 'name': 'Mystery', 'text': 'Here are the logs', 'channel': 'dm', 'to': 'Ji-woo'},
                    {'id': '3', 'name': 'Mystery', 'text': 'Why do you want the logs?', 'channel': 'dm', 'to': 'Ji-woo'},
                    {'id': '4', 'name': 'Ji-woo', 'text': 'I wanted to understand them.', 'channel': 'dm', 'to': 'Mystery', 'reply_to': '3'}]
        self.assertIsNone(server.priority_turn(messages, agents))

    def test_mention_interrupts_normal_delay(self):
        import time
        server.ACTIVE.set()
        server.WAKE.set()
        started = time.monotonic()
        server.wait_for_turn(15)
        self.assertLess(time.monotonic()-started, 0.1)

    def test_private_exchange_returns_turn_to_other_group_members(self):
        agents = server.load_config()['agents']
        messages = [{'id': '1', 'name': 'Ji-woo', 'text': 'hello', 'channel': 'dm', 'to': 'The Man in a Suit', 'targets': ['The Man in a Suit']},
                    {'id': '2', 'name': 'The Man in a Suit', 'text': 'hey', 'channel': 'dm', 'to': 'Ji-woo', 'reply_to': '1', 'targets': ['Ji-woo']}]
        self.assertEqual(server.priority_turn(messages, agents)[0], 'Ji-woo')
        for _ in range(20):  # Every random fairness branch must exclude disabled cast.
            self.assertNotIn(server.choose_next(messages, agents), ('Ji-woo', 'The Man in a Suit', 'The Copy Shop Man', 'Su-jin'))
        messages.append({'id': '3', 'name': 'Mystery', 'text': '@Ji-woo quick question', 'channel': 'group'})
        self.assertEqual(server.priority_turn(messages, agents)[0], 'Ji-woo')

    def test_group_slot_generates_a_public_message(self):
        agents = server.load_config()['agents']
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(server, 'LOG', Path(tmp)/'messages.jsonl'), \
             patch.object(server, 'MEMORY', Path(tmp)/'memories.json'), \
             patch.object(server, 'invoke', return_value=json.dumps({'message': 'Anyone else hungry?', 'memory': 'I asked the group about food.', 'to': None})) as invoke:
            server.append('Ji-woo', 'hello', recipient='The Man in a Suit')
            server.append('The Man in a Suit', 'hey', recipient='Ji-woo', reply_to=server.history()[0]['id'])
            server.ACTIVE.set()
            server.run_turn({'agents': agents})
            self.assertEqual(server.history()[-1]['channel'], 'group')
            self.assertIn('GROUP TURN', invoke.call_args.args[1])

    def test_romantic_ranking_excludes_siblings_and_same_gender(self):
        agents = romance_cast()
        avery = agents[0]
        scores = server.relationships.propose(avery, {'Blair': {'like': 100, 'dislike': 0}, 'Drew': {'like': 80, 'dislike': 5}, 'Casey': {'like': 90, 'dislike': 30}}, agents)
        self.assertEqual(server.relationships.favorites(avery, scores, agents), ['Casey'])
        server.relationships.save('Avery', scores)
        self.assertEqual(server.relationships.load()['Avery'], scores)
        self.assertNotIn('Invented', server.relationships.propose(avery, {'Invented': {'like': 100, 'dislike': 0}}, agents))

    def test_story_cast_never_opts_into_romance(self):
        config = server.load_config()
        root = Path(server.__file__).resolve().parent
        story = [json.loads(path.read_text()) for path in sorted((root / 'characters').glob('*.json'))]
        for agent in config['agents'] + story:
            with self.subTest(agent=agent['name']):
                self.assertEqual(server.relationships.preference(agent), [])
                self.assertEqual(server.relationships.romantic_targets(agent, config['agents'], config), set())
        for agent in config['agents']:
            prompt = server.make_prompt(agent, [], config['agents'], config=config)
            self.assertNotIn('Your ONLY possible romantic interests', prompt)
            self.assertIn('All your relationships are platonic', prompt)
            self.assertNotIn('marriage-ready', prompt)
        # A character without the field stays platonic too: romance is opt-in.
        self.assertEqual(server.relationships.preference(dict(name='New', gender='male')), [])

    def test_scoring_sibling_does_not_stop_the_room(self):
        agents = server.load_config()['agents']
        reply = json.dumps({'message': 'Ji-woo, did you grade the furniture too?', 'memory': 'I teased my sister Ji-woo.', 'to': None,
                            'scores': {'Ji-woo': {'like': 75, 'dislike': 20}}})
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(server, 'LOG', Path(tmp)/'messages.jsonl'), \
             patch.object(server, 'MEMORY', Path(tmp)/'memories.json'), \
             patch.object(server, 'choose_next', return_value='Kim Min-jun'), \
             patch.object(server, 'invoke', return_value=reply):
            server.ACTIVE.set()
            server.run_turn({'agents': agents})
            self.assertTrue(server.ACTIVE.is_set())
            self.assertEqual(server.history()[-1]['kind'], 'chat')
            self.assertEqual(server.relationships.load()['Kim Min-jun']['Ji-woo'], {'like': 75, 'dislike': 20})

    def test_mystery_can_be_scored_and_saved(self):
        agents = server.load_config()['agents']
        suit = next(a for a in agents if a['name'] == 'The Man in a Suit')
        scores = server.relationships.propose(suit, {'Mystery': {'like': 72, 'dislike': 9}}, agents)
        server.relationships.save('The Man in a Suit', scores)
        self.assertEqual(server.relationships.load()['The Man in a Suit']['Mystery'], {'like': 72, 'dislike': 9})

    def test_scores_change_tone_without_turning_family_or_friends_into_crushes(self):
        agents = server.load_config()['agents']
        jiwoo = next(a for a in agents if a['name'] == 'Ji-woo')
        low = server.relationships.tone_guidance(jiwoo, {'Mystery': {'like': 20, 'dislike': 2}}, agents)
        high = server.relationships.tone_guidance(jiwoo, {'Mystery': {'like': 93, 'dislike': 2}, 'Kim Min-jun': {'like': 95, 'dislike': 0}}, agents)
        self.assertIn('Mystery: neutral', low)
        self.assertIn('Mystery: close', high)
        self.assertIn('Kim Min-jun: family', high)
        self.assertNotIn('Kim Min-jun: close', high)
        suit = next(a for a in agents if a['name'] == 'The Man in a Suit')
        self.assertIn('Ji-woo: close friendship', server.relationships.tone_guidance(suit, {'Ji-woo': {'like': 95, 'dislike': 0}}, agents))
        self.assertIn('reserved', server.relationships.tone_guidance(jiwoo, {'Mystery': {'like': 93, 'dislike': 80}}, agents))

    def test_interest_over_one_hundred_can_express_marriage_readiness(self):
        agents = romance_cast()
        config = dict(server.load_config(), agents=agents)
        blair = agents[1]
        scores = server.relationships.propose(blair, {'Mystery': {'like': 125, 'dislike': 5}, 'Avery': {'like': 140, 'dislike': 0}}, agents)
        guidance = server.relationships.tone_guidance(blair, scores, agents, config)
        self.assertIn('Mystery: marriage-ready', guidance)
        self.assertIn('Avery: family', guidance)
        self.assertNotIn('Avery: marriage-ready', guidance)
        self.assertEqual(server.relationships.propose(blair, {'Mystery': {'like': 1501, 'dislike': 0}}, agents)['Mystery']['like'], 1500)
        # The story cast at the same score stays a close, platonic bond.
        story = server.load_config()
        jiwoo = next(a for a in story['agents'] if a['name'] == 'Ji-woo')
        self.assertNotIn('marriage-ready', server.relationships.tone_guidance(jiwoo, scores, story['agents'], story))

    def test_net_above_120_means_loving_the_conversation(self):
        agents = server.load_config()['agents']
        jiwoo = next(a for a in agents if a['name'] == 'Ji-woo')
        self.assertIn('love talking', server.relationships.tone_guidance(jiwoo, {'Mystery': {'like': 130, 'dislike': 2}}, agents))
        self.assertNotIn('love talking', server.relationships.tone_guidance(jiwoo, {'Mystery': {'like': 130, 'dislike': 10}}, agents))

    def test_preferences_decide_favorites(self):
        agents = romance_cast()
        casey, blair = agents[2], agents[1]
        self.assertEqual(server.relationships.favorites(casey, {'Blair': {'like': 95, 'dislike': 0}, 'Avery': {'like': 60, 'dislike': 0}}, agents), ['Avery'])
        self.assertEqual(server.relationships.favorites(blair, {'Casey': {'like': 95, 'dislike': 0}, 'Drew': {'like': 60, 'dislike': 0}}, agents), ['Casey'])


    def test_mystery_dm_reply_stays_private_and_can_see_its_image(self):
        agent = server.load_config()['agents'][0]
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(server, 'LOG', Path(tmp)/'messages.jsonl'), \
             patch.object(server, 'MEMORY', Path(tmp)/'memories.json'), \
             patch.object(server.chat_images, 'DIRECTORY', Path(tmp)/'uploads'), \
             patch.object(server, 'invoke', return_value=json.dumps({'message': 'Hey, who are you?', 'memory': 'Mystery sent me a portrait.', 'to': 'Mystery'})) as invoke:
            import base64
            original = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDAAAAABJRU5ErkJggg==')
            path = server.chat_images.store('data:image/png;base64,'+base64.b64encode(original).decode())
            question = server.append('Mystery', 'What do you think?', recipient=agent['name'], attachments=[path])
            server.ACTIVE.set()
            server.run_turn({'agents': [agent]})
            message = server.history()[-1]
            self.assertEqual((message['channel'], message['to'], message['reply_to']), ('dm', 'Mystery', question['id']))
            self.assertEqual(invoke.call_args.kwargs['images'], [Path(path)])
            other = server.load_config()['agents'][2]
            self.assertNotIn(path, server.make_prompt(other, server.history(), [agent, other]))
            self.assertEqual(server.attachment_path(path).read_bytes(), original)
            with self.assertRaises(ValueError):
                server.chat_images.store('data:image/png;base64,'+base64.b64encode(b'not a valid image').decode())
            with self.assertRaises(ValueError):
                server.project_tools.image_path(Path(path))

    def test_claude_error_is_not_a_message(self):
        with self.assertRaises(RuntimeError):
            server.parse_reply("claude", json.dumps({"is_error": True, "result": "quota exceeded"}))

    def test_codex_only_exposes_final_answer(self):
        events = [{"type": "item.completed", "item": {"type": "reasoning", "text": "hidden"}},
                  {"type": "item.completed", "item": {"type": "agent_message", "text": "Hi Ji-woo"}},
                  {"type": "turn.completed"}]
        self.assertEqual(server.parse_reply("codex", "\n".join(map(json.dumps, events))), "Hi Ji-woo")

    def test_opencode_does_not_accept_partial_failure(self):
        events = [{"type": "text", "part": {"text": "partial"}},
                  {"type": "error", "error": {"message": "rate limited"}}]
        with self.assertRaises(RuntimeError):
            server.parse_reply("opencode", "\n".join(map(json.dumps, events)))

    def test_empty_response_rejected(self):
        with self.assertRaises(RuntimeError):
            server.parse_reply("claude", '{"is_error":false,"result":""}')

    def test_opencode_chat_runs_in_explicit_isolated_directory(self):
        agent = next(a for a in server.load_config()['agents'] if a['name'] == 'The Man in a Suit')
        output = json.dumps({'type': 'text', 'part': {'text': '{"message":"hello"}'}})
        with patch.object(server.subprocess, 'Popen') as launch:
            proc = launch.return_value.__enter__.return_value
            proc.communicate.return_value = (output, '')
            proc.returncode = 0
            server.invoke(agent, 'One chat reply.', 45)
            argv = launch.call_args.args[0]
            kwargs = launch.call_args.kwargs
            self.assertIn('--dir', argv)
            self.assertEqual(argv[argv.index('--dir') + 1], kwargs['cwd'])
            self.assertEqual(kwargs['env']['PWD'], kwargs['cwd'])
            self.assertEqual(argv[argv.index('--agent') + 1], 'room-chat')
            config = json.loads(kwargs['env']['OPENCODE_CONFIG_CONTENT'])
            self.assertIn('room-chat', config['agent'])
            self.assertNotIn('steps', config['agent']['room-chat'])
            self.assertEqual(config['permission'], 'ask')
            proc.returncode = 1
            proc.communicate.return_value = ('', 'Unexpected error: database is locked')
            with self.assertRaises(server.EmptyReply):
                server.invoke(agent, 'One chat reply.', 45)

    def test_empty_provider_reply_is_retried_once(self):
        agent = next(a for a in server.load_config()['agents'] if a['name'] == 'The Corner Shop Clerk')
        reply = json.dumps({'message': 'Hey there.', 'memory': 'I said hello.', 'to': None})
        with patch.object(server, 'invoke', side_effect=[server.EmptyReply('Provider returned no usable reply'), reply]) as invoke:
            self.assertEqual(server.actor_result(agent, 'Reply as The Corner Shop Clerk.', 45, [])['message'], 'Hey there.')
            self.assertEqual(invoke.call_count, 2)
            self.assertIn('Do not use native tools', invoke.call_args.args[1])

    def test_session_budget_stops_real_calls(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, "LOG", Path(tmp)/"messages.jsonl"), \
             patch.object(server, "remember"), patch.object(server, "invoke", return_value=json.dumps({"message":"@Ji-woo coffee?", "memory":"I invited Ji-woo for coffee.","thread_done":True})) as invoke:
            config = {"agents": [server.load_config()["agents"][0]], "timeout_seconds": 5}
            server.STATE.update(turns=0, limit=2, speaker=None)
            server.ACTIVE.set()
            for _ in range(4):
                server.run_turn(config)
            self.assertEqual(invoke.call_count, 2)
            self.assertFalse(server.ACTIVE.is_set())
            self.assertEqual(len(server.history()), 2)

    def test_provider_failure_skips_character_without_fake_reply(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, "LOG", Path(tmp)/"messages.jsonl"), \
             patch.object(server, "invoke", side_effect=RuntimeError("quota")):
            server.ACTIVE.set()
            server.run_turn({"agents": [server.load_config()["agents"][0]]})
            self.assertTrue(server.ACTIVE.is_set())
            self.assertIn("Kim Min-jun", server.CHARACTER_BREAKS)
            self.assertEqual(server.history()[0]["kind"], "error")
            self.assertIn("quota", server.STATE["reason"])

    def test_timeout_temporarily_skips_provider_and_other_people_continue(self):
        agents = server.load_config()['agents']
        reply = json.dumps({'message': 'Coffee, anyone?', 'memory': 'I offered coffee.', 'to': None})
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(server, 'LOG', Path(tmp)/'messages.jsonl'), \
             patch.object(server, 'MEMORY', Path(tmp)/'memories.json'), \
             patch.object(server, 'invoke', side_effect=[server.ProviderTimeout('opencode timed out after45s'), reply]) as invoke:
            server.append('Mystery', '@The Man in a Suit hello')
            server.ACTIVE.set()
            server.run_turn({'agents': agents})
            self.assertTrue(server.ACTIVE.is_set())
            self.assertIn(server.route_key('opencode', 'opencode/mimo-v2.6-flash-free'), server.PROVIDER_BREAKS)
            self.assertNotIn('The Man in a Suit', [a['name'] for a in server.available_agents(agents)])
            self.assertNotIn('The Corner Shop Clerk', [a['name'] for a in server.available_agents(agents)])
            suit = server.character_status(next(a for a in agents if a['name'] == 'The Man in a Suit'))
            self.assertFalse(suit['enabled'])
            self.assertGreater(suit['retry_in_seconds'], 0)
            self.assertIn('Temporary break', suit['away_reason'])
            server.run_turn({'agents': agents})
            self.assertTrue(server.ACTIVE.is_set())
            self.assertNotEqual(invoke.call_args.args[0]['provider'], 'opencode')
            self.assertEqual(server.STATE['turns'], 1)
            self.assertEqual(server.history()[-1]['kind'], 'chat')
            server.PROVIDER_BREAKS[server.route_key('opencode', 'opencode/mimo-v2.6-flash-free')] = 0
            server.CHARACTER_BREAKS['The Man in a Suit'] = 0
            self.assertIn('The Man in a Suit', [a['name'] for a in server.available_agents(agents)])

    def test_malformed_actor_json_is_repaired_before_saving_one_message(self):
        agents = server.load_config()['agents']
        reply = json.dumps({'message': 'Anyone want coffee?', 'memory': 'I offered coffee.', 'to': None})
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(server, 'LOG', Path(tmp)/'messages.jsonl'), \
             patch.object(server, 'MEMORY', Path(tmp)/'memories.json'), \
             patch.object(server, 'choose_next', return_value='The Man in a Suit'), \
             patch.object(server, 'invoke', side_effect=['{"message":"hi" "memory":"oops"}', reply]) as invoke:
            server.ACTIVE.set()
            server.run_turn({'agents': agents})
            self.assertEqual(invoke.call_count, 2)
            self.assertTrue(server.ACTIVE.is_set())
            self.assertEqual(len(server.history()), 1)
            self.assertEqual(server.history()[0]['text'], 'Anyone want coffee?')
            self.assertIn('JSON REPAIR', invoke.call_args.args[1])

    def test_json_repair_is_bounded_and_never_posts_invalid_reply(self):
        agents = server.load_config()['agents']
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(server, 'LOG', Path(tmp)/'messages.jsonl'), \
             patch.object(server, 'MEMORY', Path(tmp)/'memories.json'), \
             patch.object(server, 'choose_next', return_value='The Man in a Suit'), \
             patch.object(server, 'invoke', return_value='{"message":') as invoke:
            server.ACTIVE.set()
            server.run_turn({'agents': agents})
            self.assertEqual(invoke.call_count, 2)
            self.assertTrue(server.ACTIVE.is_set())
            self.assertIn('The Man in a Suit', server.CHARACTER_BREAKS)
            self.assertEqual([m['kind'] for m in server.history()], ['error'])
            self.assertFalse(server.MEMORY.exists())

    def test_paused_room_never_invokes(self):
        server.ACTIVE.clear()
        with patch.object(server, "invoke") as invoke:
            server.run_turn({"agents": [server.load_config()["agents"][0]]})
            invoke.assert_not_called()

    def test_dm_is_visible_only_to_its_participants(self):
        agents = server.load_config()['agents'][:4]
        messages = [
            {'name': 'Kim Min-jun', 'text': 'PUBLIC_HELLO', 'channel': 'group'},
            {'name': 'Kim Min-jun', 'text': 'PRIVATE_INVITE', 'channel': 'dm', 'to': 'The Landlady'},
        ]
        with patch.object(server, 'memories', return_value={}):
            for a in agents:
                prompt = server.make_prompt(a, messages, agents)
                self.assertIn('PUBLIC_HELLO', prompt)
                if a['name'] in ('Kim Min-jun', 'The Landlady'):
                    self.assertIn('PRIVATE_INVITE', prompt)
                else:
                    self.assertNotIn('PRIVATE_INVITE', prompt)

    def test_dm_route_and_memory_are_saved_together(self):
        agents = server.load_config()['agents'][:4]
        reply = json.dumps({'message': 'Fancy a walk?', 'memory': 'I invited The Landlady for a walk.', 'to': 'The Landlady', 'scores': {'The Landlady': {'like': 120, 'dislike': 0}}})
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(server, 'LOG', Path(tmp)/'messages.jsonl'), \
             patch.object(server, 'MEMORY', Path(tmp)/'memories.json'), \
             patch.object(server, 'choose_next', return_value='Kim Min-jun'), \
             patch.object(server, 'invoke', return_value=reply):
            server.ACTIVE.set()
            server.run_turn({'agents': agents})
            saved = server.history()[0]
            self.assertEqual((saved['channel'], saved['to']), ('dm', 'The Landlady'))
            self.assertEqual(server.memories()['Kim Min-jun'], 'I invited The Landlady for a walk.')


if __name__ == "__main__":
    unittest.main()
