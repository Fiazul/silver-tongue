import json
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import threading
import unittest
from test_support import HermeticTestCase
from unittest.mock import Mock, patch

import life_memory
import memory_sweep
import server
import backfill_memory
import health


def revelation():
    return dict(segment='world', about=['Mystery', 'Iris'],
                text='Mystery says none of us chose to come here and believes the date is not October 15, 2026; he says he is from 2199.',
                tags=['room', 'time', 'arrival'], importance=5, status='open', speaker='Mystery', belief='uncertain')


class MemorySweepTests(HermeticTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        embed = patch.object(life_memory.embeddings, 'embed', return_value=None)
        embed.start()
        self.addCleanup(embed.stop)
        for name, value in (('MEMORY_SWEEPS', {}), ('EVENTS', health.deque(maxlen=50)),
                            ('FAILURE_TIMES', health.deque())):
            patcher = patch.object(health, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for module, field, file in ((server, 'MEMORY', 'memories.json'), (server, 'LOG', 'messages.jsonl'),
                                    (server, 'RESETS', 'resets.json'), (server.relationships, 'FILE', 'relationships.json')):
            p = patch.object(module, field, self.root / file)
            p.start()
            self.addCleanup(p.stop)
        self.store = server.life_store('Iris')
        self.agents = server.load_config()['agents']
        self.iris = next(a for a in self.agents if a['name'] == 'Iris')
        self.worker = dict(self.iris, provider='cursor', model='auto')
        self.store.embedding_config['enabled'] = False
        self.settings = dict(every=8, provider='fallback', enabled=True)
        self.addCleanup(server.ACTIVE.clear)
        self.addCleanup(lambda: server.STATE.update(speaker=None, turns=0, limit=24))
        patcher = patch.dict(memory_sweep.COOLDOWNS, {}, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def messages(self, start=1, end=8):
        return [dict(id=str(i), name='Mystery', to='Iris', channel='dm', kind='chat', text=f'revelation {i}')
                for i in range(start, end + 1)]

    def finish(self, thread):
        self.assertIsNotNone(thread)
        thread.join(3)
        self.assertFalse(thread.is_alive())

    def test_initial_catchup_is_bounded_durable_and_resumes_after_failure(self):
        messages = self.messages(end=877)
        def first_chunk(*args):
            state = self.store._read('state.json', {})
            self.assertEqual(state['watermark'], '757')
            self.assertEqual(len([m for m in messages if int(m['id']) > int(state['watermark'])]), 120)
            return '{"remember": []}'
        invoke = Mock(side_effect=first_chunk)
        with patch.object(health, 'emit') as emit, self.assertLogs('memory_sweep', level='INFO') as logs:
            self.finish(memory_sweep.maybe_schedule(self.iris, self.worker, self.settings,
                        list(reversed(messages)), self.store, invoke))
        state = self.store._read('state.json', {})
        self.assertEqual((state['catchup_skipped'], state['watermark'], state['processed']), (757, '787', 30))
        self.assertEqual(invoke.call_count, 1)
        batch = json.loads(invoke.call_args.args[1].split('Visible historical messages: ', 1)[1])
        self.assertEqual([m['id'] for m in batch], [str(i) for i in range(758, 788)])
        self.assertEqual(invoke.call_args.args[2], 120)
        self.assertTrue(any('757' in line for line in logs.output))
        emit.assert_called_with('memory_sweep_success', 'Iris',
                                'memory sweep processed 30 messages; 90 remaining', chunk_size=30, remaining_backlog=90)
        invoke.side_effect = RuntimeError('provider text must stay private')
        failure = Mock()
        with patch.object(health, 'emit') as emit, self.assertLogs('memory_sweep', level='WARNING'):
            self.finish(memory_sweep.maybe_schedule(self.iris, self.worker, self.settings,
                        messages, self.store, invoke, on_failure=failure))
        self.assertEqual(self.store._read('state.json', {}), state)
        emit.assert_called_with('memory_sweep_failure', 'Iris', 'memory sweep failed; 90 remaining',
                                chunk_size=30, remaining_backlog=90)
        failure.assert_called_once()
        self.assertIsNone(memory_sweep.maybe_schedule(self.iris, self.worker, self.settings,
                          messages, self.store, invoke))
        memory_sweep.COOLDOWNS.clear()
        invoke.side_effect = None
        invoke.return_value = '{"remember": []}'
        for expected in (817, 847, 877):
            self.finish(memory_sweep.maybe_schedule(self.iris, self.worker, self.settings,
                        messages, self.store, invoke))
            self.assertEqual(self.store._read('state.json', {})['watermark'], str(expected))
        self.assertEqual(self.store._read('state.json', {})['processed'], 120)
        self.assertEqual(self.store._read('state.json', {})['catchup_skipped'], 757)

    def test_overrides_and_large_messages_still_make_one_call(self):
        settings = dict(self.settings, max_batch=2, initial_backlog=5, timeout_seconds=7)
        messages = [dict(m, text='long text ' * 3000) for m in self.messages()]
        invoke = Mock(return_value='{"remember": []}')
        self.finish(memory_sweep.maybe_schedule(self.iris, self.worker, dict(settings, every=1),
                    messages, self.store, invoke))
        self.assertEqual(invoke.call_count, 1)
        self.assertEqual(invoke.call_args.args[2], 7)
        state = self.store._read('state.json', {})
        self.assertEqual((state['catchup_skipped'], state['watermark']), (3, '5'))

    def test_existing_state_is_not_recapped_and_small_tail_drains(self):
        with self.store.lock:
            self.store._write('state.json', dict(boundary=self.store.boundary, watermark='1', processed=1))
        invoke = Mock(return_value='{"remember": []}')
        settings = dict(self.settings, max_batch=7, initial_backlog=2)
        for watermark in ('8', '10'):
            self.finish(memory_sweep.maybe_schedule(self.iris, self.worker, settings,
                        self.messages(end=10), self.store, invoke))
            self.assertEqual(self.store._read('state.json', {})['watermark'], watermark)
        self.assertEqual(self.store._read('state.json', {})['catchup_skipped'], 0)

    def test_initial_failure_preserves_catchup_across_retries(self):
        invoke = Mock(side_effect=RuntimeError('timeout'))
        for _ in range(2):
            with self.assertLogs('memory_sweep', level='INFO') as logs:
                self.finish(memory_sweep.maybe_schedule(self.iris, self.worker, self.settings,
                            self.messages(end=877), self.store, invoke))
            state = self.store._read('state.json', {})
            self.assertEqual((state['watermark'], state['catchup_skipped'], state['processed']), ('757', 757, 0))
            memory_sweep.COOLDOWNS.clear()
        self.assertFalse(any('catch-up skipped' in row for row in logs.output))

    def test_health_snapshot_route_and_unavailable_provider_backlogs(self):
        server.LOG.write_text(''.join(json.dumps(m) + '\n' for m in self.messages(end=877)))
        config = dict(agents=[self.iris], memory_sweep=self.settings,
                      fallback=dict(provider='cursor', model='auto'))
        with patch.object(server, 'provider_state', return_value='exhausted'):
            server.schedule_memory_sweeps(config)
        self.assertFalse((self.store.directory / 'state.json').exists())
        self.assertEqual(health.snapshot()['memory_sweeps'], {'Iris': 120})
        invoke = Mock(return_value='{"remember": []}')
        self.finish(memory_sweep.maybe_schedule(self.iris, self.worker, self.settings,
                    self.messages(end=877), self.store, invoke))
        handler = object.__new__(server.Handler)
        handler.path = '/api/health'
        with patch.object(handler, 'refused', return_value=False), patch.object(handler, 'send_json') as send:
            handler.do_GET()
        payload = send.call_args.args[0]
        self.assertEqual(payload['memory_sweeps'], {'Iris': 90})
        self.assertEqual(payload['events'][-1]['event'], 'memory_sweep_success')
        self.assertEqual(payload['events'][-1]['chunk_size'], 30)
        self.assertEqual(payload['events'][-1]['remaining_backlog'], 90)
        self.assertEqual(payload['failures_last_hour'], 0)

    def test_config_defaults_validation_and_server_loading(self):
        self.assertEqual({k: memory_sweep.settings({})[k] for k in
                          ('max_batch', 'initial_backlog', 'timeout_seconds')},
                         dict(max_batch=30, initial_backlog=120, timeout_seconds=120))
        config = server.load_config()
        config['memory_sweep'] = dict(self.settings, max_batch=4, initial_backlog=9, timeout_seconds=2.5)
        with patch.object(server, 'CONFIG', self.root / 'agents.json'):
            server.CONFIG.write_text(json.dumps(config))
            self.assertEqual(server.load_config()['memory_sweep'], config['memory_sweep'])
            for field, value in (('max_batch', 0), ('initial_backlog', True), ('max_batch', 1.5),
                                 ('timeout_seconds', 0), ('timeout_seconds', True),
                                 ('timeout_seconds', float('nan')), ('timeout_seconds', 3601)):
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    memory_sweep.settings(dict(self.settings, **{field: value}))

    def test_watermark_visibility_incremental_batches_and_deduplication(self):
        invoke = Mock(return_value=json.dumps({'remember': [revelation()]}))
        hidden = dict(id='100', name='Mystery', to='Theo', channel='dm', text='PRIVATE SECRET')
        self.finish(memory_sweep.maybe_schedule(self.iris, self.worker, self.settings,
                    self.messages() + [hidden], self.store, invoke))
        self.assertEqual(self.store._read('state.json', {})['watermark'], '8')
        self.assertNotIn('PRIVATE SECRET', invoke.call_args.args[1])
        self.assertEqual(invoke.call_args.args[0]['provider'], 'cursor')
        self.assertIsNone(memory_sweep.maybe_schedule(self.iris, self.worker, self.settings,
                          self.messages(end=15), self.store, invoke))
        self.finish(memory_sweep.maybe_schedule(self.iris, self.worker, self.settings,
                    self.messages(end=16), self.store, invoke))
        batch = json.loads(invoke.call_args.args[1].split('Visible historical messages: ', 1)[1])
        self.assertEqual([m['id'] for m in batch], [str(i) for i in range(9, 17)])
        self.assertEqual(self.store._read('state.json', {})['processed'], 16)
        self.assertEqual(len(self.store.load_segment('world')), 1)

    def test_single_flight_extraction_never_blocks_turn_store_access(self):
        entered, release = threading.Event(), threading.Event()
        def invoke(*args):
            entered.set()
            release.wait(2)
            return json.dumps({'remember': [revelation()]})
        thread = memory_sweep.maybe_schedule(self.iris, self.worker, self.settings, self.messages(), self.store, invoke)
        try:
            self.assertTrue(entered.wait(1))
            self.assertTrue(memory_sweep.EXTRACTION_LOCK.locked())
            self.assertIsNone(memory_sweep.maybe_schedule(self.iris, self.worker, self.settings,
                              self.messages(), self.store, invoke))
            # The extractor owns no store/turn lock while waiting on its provider.
            self.assertTrue(self.store.lock.acquire(blocking=False))
            self.store.lock.release()
            self.assertEqual(self.store.index(), {})
        finally:
            release.set()
            self.finish(thread)

    def test_failure_leaves_watermark_unchanged_and_applies_cooldown(self):
        invoke = Mock(side_effect=RuntimeError('fallback quota'))
        with self.assertLogs('memory_sweep', level='WARNING'):
            self.finish(memory_sweep.maybe_schedule(self.iris, self.worker, self.settings,
                        self.messages(), self.store, invoke))
        self.assertFalse((self.store.directory / 'state.json').exists())
        self.assertEqual(self.store.index(), {})
        self.assertIsNone(memory_sweep.maybe_schedule(self.iris, self.worker, self.settings,
                          self.messages(), self.store, invoke))
        self.assertEqual(invoke.call_count, 1)

    def test_reset_during_extraction_discards_obsolete_results(self):
        entered, release = threading.Event(), threading.Event()
        def invoke(*args):
            entered.set()
            release.wait(2)
            return json.dumps({'remember': [revelation()]})
        thread = memory_sweep.maybe_schedule(self.iris, self.worker, self.settings, self.messages(), self.store, invoke)
        try:
            self.assertTrue(entered.wait(1))
            server.RESETS.write_text(json.dumps({'Iris': 10}))
        finally:
            release.set()
            self.finish(thread)
        self.assertFalse((self.store.directory / 'state.json').exists())
        self.assertFalse((self.store.directory / 'world.json').exists())

    def test_manual_extraction_uses_the_same_global_lock(self):
        called = threading.Event()
        def invoke(*args):
            called.set()
            return json.dumps({'remember': []})
        memory_sweep.EXTRACTION_LOCK.acquire()
        thread = threading.Thread(target=lambda: backfill_memory.extract_messages(
            self.worker, self.messages(), invoke=invoke))
        try:
            thread.start()
            self.assertFalse(called.wait(.05))
        finally:
            memory_sweep.EXTRACTION_LOCK.release()
            self.finish(thread)
        self.assertTrue(called.is_set())

    def test_scheduler_uses_fallback_model_and_its_own_effort(self):
        server.LOG.write_text(''.join(json.dumps(m) + '\n' for m in self.messages()))
        config = dict(agents=[self.iris], memory_sweep=self.settings, fallback=dict(provider='cursor', model='auto'))
        with patch.object(memory_sweep, 'maybe_schedule') as schedule:
            server.schedule_memory_sweeps(config)
        worker = schedule.call_args.args[1]
        self.assertEqual((worker['provider'], worker['model'], worker['effort']), ('cursor', 'auto', 'low'))
        with patch.object(memory_sweep, 'maybe_schedule', side_effect=TypeError('bad optional state')), \
             self.assertLogs('server', level='WARNING'):
            server.schedule_memory_sweeps(config)

    def test_revelation_is_saved_and_world_knowledge_pinned_next_turn(self):
        incoming = self.messages()[0]
        incoming['text'] = 'None of us chose this place. I am from 2199.'
        server.LOG.write_text(json.dumps(incoming) + '\n')
        reply = dict(message='I believe you about arriving here.', memory='I care about Mystery.',
                     to='Mystery', remember=[revelation()])
        server.STATE.update(speaker=None, turns=0, limit=24)
        with patch.object(server, 'invoke', return_value=json.dumps(reply)), \
             patch.object(server.TIMEKEEPER, 'clock', return_value=datetime(2026, 10, 16, 6, tzinfo=timezone.utc)), \
             patch.object(server, 'choose_next', return_value='Iris'):
            server.ACTIVE.set()
            server.run_turn({'agents': self.agents})
        world = self.store.load_segment('world')
        self.assertEqual(len(world), 1)
        self.assertEqual(world[0]['speaker'], 'Mystery')
        focus = dict(name='Mystery', to='Iris', channel='dm', text='Good morning.')
        prompt = server.make_prompt(self.iris, server.history() + [focus], self.agents, focus)
        self.assertIn('About this place and time:', prompt)
        self.assertIn('2199', prompt)
        self.assertIn('said by Mystery; you are unsure', prompt)
        self.assertIn('MUST add a remember entry this turn', prompt)

    def test_world_cap_and_vital_counterpart_memories_survive_small_budget(self):
        for i in range(7):
            self.store.apply([dict(revelation(), text=f'Mystery says the room has property {i}.')])
        for segment in ('people', 'milestones'):
            self.store.apply([dict(segment=segment, about=['Mystery'], text='A vital ' + segment + ' memory.',
                                   tags=['vital'], importance=5, status='resolved')])
        focus = dict(name='Mystery', to='Iris', channel='dm', text='Hello.')
        context = life_memory.retrieval_context(self.store, [focus], focus, budget=40)
        self.assertEqual(sum(s == 'world' for s, _ in context.records), 5)
        for segment in ('people', 'milestones'):
            self.assertIn('A vital ' + segment, context.block)

    def test_core_shrink_guard_preserves_identity_and_adds_novel_sentences(self):
        previous = 'Mr. Whiskers joined our Antarctica date. Mystery gave me a glass flower. I love Mystery. ' + ' '.join(['detail'] * 50)
        server.remember('Iris', previous)
        server.remember('Iris', 'I now believe Mystery came from 2199.')
        combined = server.memories()['Iris']
        for fact in ('Whiskers', 'Antarctica', 'glass flower', 'love Mystery', '2199'):
            self.assertIn(fact, combined)
        self.assertLessEqual(len(combined.split()), 120)
        self.assertEqual(server.guarded_note('old ' * 100, 'new ' * 60), ' '.join(['new'] * 60))
