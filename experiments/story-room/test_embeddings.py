import io
import json
import tempfile
from pathlib import Path
import unittest
from test_support import HermeticTestCase
from unittest.mock import patch
from urllib.error import URLError

import embeddings
import backfill_memory
import life_memory


def memory(text, segment='events', **extra):
    return dict(segment=segment, text=text, about=['Mystery'], tags=['keepsake'],
                importance=3, status='resolved', **extra)



class ReadOnlyStore(life_memory.Store):
    """A store that may read vectors but must never write (read-only inspection)."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.lock = self.room_lock

    def _write(self, *args, **kwargs):
        raise RuntimeError('Read-only store must never write')

    def apply(self, *args, **kwargs):
        raise RuntimeError('Read-only store must never write')

class EmbeddingTests(HermeticTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config = dict(enabled=True, model='nomic-embed-text')
        self.store = life_memory.Store(self.root, 'Ji-woo', embedding_config=self.config)
        for name, value in (('BREAKS', {}), ('BUSY', set())):
            patcher = patch.object(embeddings, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def response(self, vectors):
        return io.BytesIO(json.dumps({'embeddings': vectors}).encode())

    def test_write_batches_documents_with_task_prefix_and_cache_metadata(self):
        with patch.object(embeddings, 'urlopen', return_value=self.response([[1., 0.], [0., 1.]])) as http:
            self.store.apply([memory('Our lanterns keepsake.'), memory('The espresso rematch.')])
        self.assertEqual(http.call_count, 1)
        request = http.call_args.args[0]
        self.assertEqual(request.full_url, 'http://127.0.0.1:11434/api/embed')
        payload = json.loads(request.data)
        self.assertEqual(payload['model'], 'nomic-embed-text')
        self.assertTrue(all(text.startswith('search_document: ') for text in payload['input']))
        self.assertEqual(http.call_args.kwargs['timeout'], 3)
        cache = self.store._read('vectors.json', {})
        self.assertEqual(len(cache['vectors']), 2)
        self.assertTrue(all(v['model'] == 'nomic-embed-text' and len(v['hash']) == 64 for v in cache['vectors'].values()))

    def test_lazy_missing_vectors_and_query_are_one_batch_then_cache_is_reused(self):
        self.store.apply([memory('The lanterns keepsake.')], embed=False)
        with patch.object(embeddings, 'urlopen', side_effect=[self.response([[1., 0.], [1., 0.]]),
                                                           self.response([[1., 0.]])]) as http:
            self.store.retrieve('do you remember that moment?', {'Mystery'})
            self.store.retrieve('do you remember that moment?', {'Mystery'})
        first, second = [json.loads(call.args[0].data)['input'] for call in http.call_args_list]
        self.assertTrue(first[0].startswith('search_query: '))
        self.assertTrue(first[1].startswith('search_document: '))
        self.assertEqual(len(second), 1)
        self.assertTrue(self.store.last_semantic)

    def test_semantics_recover_a_record_with_no_keyword_match(self):
        self.store.apply([memory('Lanterns beside the ice.'), memory('Espresso and pastry.')], embed=False)
        def http(request, timeout):
            texts = json.loads(request.data)['input']
            return self.response([[1., 0.] if t.startswith('search_query: ') or 'Lanterns' in t else [0., 1.] for t in texts])
        with patch.object(embeddings, 'urlopen', side_effect=http):
            rows, _ = self.store.retrieve('do you recall our magical moment?', {'Mystery'})
        self.assertEqual(rows[0][1]['text'], 'Lanterns beside the ice.')

    def test_hash_and_model_changes_reembed_and_read_only_mode_never_writes(self):
        self.store.apply([memory('Lanterns.')], embed=False)
        rows = self.store.load_segment('events')
        with patch.object(embeddings, 'urlopen', side_effect=lambda *a, **k: self.response([[1., 0.]])) as http:
            self.store.ensure_vectors(rows)
            self.store.ensure_vectors(rows)
            rows[0]['text'] = 'Lanterns with our cat.'
            self.store.ensure_vectors(rows)
            self.store.embedding_config['model'] = 'new-model'
            self.store.ensure_vectors(rows)
        self.assertEqual(http.call_count, 3)
        read_only = ReadOnlyStore(self.root, 'Ji-woo', embedding_config=self.config, vector_writes=False)
        with patch.object(embeddings, 'urlopen', return_value=self.response([[1., 0.], [1., 0.]])), \
             patch.object(read_only, '_write', side_effect=AssertionError('write attempted')):
            read_only.retrieve('remember lanterns?', {'Mystery'})
        self.assertTrue(read_only.last_semantic)

    def test_failure_logs_once_and_circuit_breaks_for_sixty_seconds(self):
        with patch.object(embeddings.time, 'monotonic', return_value=100), \
             patch.object(embeddings, 'urlopen', side_effect=URLError('offline')) as http, \
             self.assertLogs('embeddings', level='WARNING') as logs:
            for _ in range(3):
                self.assertIsNone(embeddings.embed(['search_query: date'], self.config))
        self.assertEqual(http.call_count, 1)
        self.assertEqual(len(logs.output), 1)
        with patch.object(embeddings.time, 'monotonic', return_value=161), \
             patch.object(embeddings, 'urlopen', return_value=self.response([[1., 0.]])) as http:
            self.assertEqual(embeddings.embed(['search_query: date'], self.config), [[1., 0.]])
        self.assertEqual(http.call_count, 1)

    def test_malformed_vectors_degrade_and_cache_write_failure_cannot_fail_apply(self):
        with patch.object(embeddings, 'urlopen', return_value=self.response([[0., 0.]])), \
             self.assertLogs('embeddings', level='WARNING'):
            self.assertIsNone(embeddings.embed(['search_query: date'], self.config))
        embeddings.BREAKS.clear()
        original = self.store._write
        def write(file, value):
            if file == 'vectors.json':
                raise OSError('cache read-only')
            return original(file, value)
        with patch.object(self.store, '_write', side_effect=write), \
             patch.object(embeddings, 'urlopen', return_value=self.response([[1., 0.]])), \
             self.assertLogs('life_memory', level='WARNING'):
            self.store.apply([memory('Lanterns.')])
        self.assertEqual(len(self.store.load_segment('events')), 1)

    def test_normalized_hybrid_weights_and_dimensions(self):
        rows = [('events', {'id': str(i)}) for i in range(3)]
        with patch.object(self.store, 'ensure_vectors', return_value=(
                {'0': [0., 1.], '1': [.8, .6], '2': [1., 0.]}, [1., 0.])):
            scores = self.store.hybrid_scores('date', rows, [10, 5, 0])
        for got, expected in zip(scores, [.5, .65, .5]):
            self.assertAlmostEqual(got, expected)
        self.assertEqual(embeddings.cosine([1., 0.], [1.]), 0)

    def test_reset_generation_cannot_write_vectors_or_records(self):
        self.store.generation_check = lambda: 1
        self.store.apply([memory('Old world.')])
        self.assertFalse((self.store.directory / 'index.json').exists())
        with patch.object(embeddings, 'urlopen', return_value=self.response([[1., 0.]])):
            self.store.ensure_vectors([dict(id='old', text='Old world.', tags=[])])
        self.assertFalse((self.store.directory / 'vectors.json').exists())

    def test_embed_only_cli_writes_only_vector_cache_and_never_extracts(self):
        self.store.apply([memory('Lanterns.')], embed=False)
        index_before = (self.store.directory / 'index.json').read_bytes()
        config = {'agents': [dict(name='Ji-woo', provider='claude', model='test')], 'embeddings': self.config}
        with patch('sys.argv', ['backfill_memory.py', '--embed-only', 'Ji-woo']), \
             patch.object(backfill_memory, 'server_live', return_value=None), \
             patch.object(backfill_memory.server, 'load_config', return_value=config), \
             patch.object(backfill_memory.server, 'life_store', return_value=self.store), \
             patch.object(backfill_memory.server, 'invoke', side_effect=AssertionError('extractor invoked')), \
             patch.object(embeddings, 'urlopen', return_value=self.response([[1., 0.]])), \
             patch('sys.stdout', new_callable=io.StringIO) as output:
            backfill_memory.main()
        self.assertTrue(json.loads(output.getvalue())['Ji-woo']['complete'])
        self.assertEqual(index_before, (self.store.directory / 'index.json').read_bytes())
        self.assertTrue((self.store.directory / 'vectors.json').is_file())

    def test_large_embed_chunks_preserve_order_and_keep_model_warm(self):
        inputs = ['search_document: ' + str(i) for i in range(35)]
        def http(request, timeout):
            payload = json.loads(request.data)
            self.assertEqual(payload['keep_alive'], '30m')
            self.assertEqual(timeout, 3)
            return self.response([[int(text.rsplit(' ', 1)[1]) + 1., 1.] for text in payload['input']])
        with patch.object(embeddings, 'urlopen', side_effect=http) as client:
            vectors = embeddings.embed(inputs, self.config)
        self.assertEqual([len(json.loads(call.args[0].data)['input']) for call in client.call_args_list], [16, 16, 3])
        self.assertEqual(vectors, [[i + 1., 1.] for i in range(35)])

    def test_chunk_failure_or_dimension_change_returns_no_partial_result(self):
        for second in (URLError('timed out'), self.response([[1., 0., 0.]])):
            embeddings.BREAKS.clear()
            with self.subTest(second=type(second).__name__), \
                 patch.object(embeddings, 'urlopen', side_effect=[self.response([[1., 0.]] * 16), second]), \
                 self.assertLogs('embeddings', level='WARNING'):
                self.assertIsNone(embeddings.embed(['document'] * 17, self.config))
            self.assertFalse(embeddings.BUSY)
            self.assertTrue(embeddings.BREAKS)

    def test_turn_retrieval_limits_170_missing_docs_and_sweep_finishes_backlog(self):
        self.store.apply([memory(f'Our keepsake number {i}.') for i in range(170)], limit=170, embed=False)
        def http(request, timeout):
            payload = json.loads(request.data)
            self.assertEqual(payload['keep_alive'], '30m')
            self.assertLessEqual(len(payload['input']), 16)
            return self.response([[1., 0.]] * len(payload['input']))
        with patch.object(embeddings, 'urlopen', side_effect=http) as client:
            self.store.retrieve('do you remember our keepsake?', {'Mystery'})
            first = json.loads(client.call_args.args[0].data)['input']
            self.assertEqual(client.call_count, 1)
            self.assertEqual(len(first), 9)
            self.assertTrue(first[0].startswith('search_query: '))
            self.assertEqual(len(self.store._read('vectors.json', {})['vectors']), 8)
            self.store.retrieve('do you remember our keepsake?', {'Mystery'})
            self.assertEqual(len(self.store._read('vectors.json', {})['vectors']), 16)
            self.assertEqual(len(json.loads(client.call_args.args[0].data)['input']), 9)
            client.reset_mock()
            self.assertEqual(self.store.embed_missing(), (170, 170))
            self.assertEqual([len(json.loads(c.args[0].data)['input']) for c in client.call_args_list], [16] * 9 + [10])
            client.reset_mock()
            self.store.retrieve('do you remember our keepsake?', {'Mystery'})
            self.assertEqual(len(json.loads(client.call_args.args[0].data)['input']), 1)

    def test_non_recall_retrieval_and_direct_query_also_limit_missing_documents(self):
        self.store.apply([memory(f'Our keepsake number {i}.') for i in range(30)], limit=30, embed=False)
        def http(request, timeout):
            return self.response([[1., 0.]] * len(json.loads(request.data)['input']))
        with patch.object(embeddings, 'urlopen', side_effect=http) as client:
            self.store.retrieve('keepsake', {'Mystery'}, recall=False)
            self.assertEqual(len(json.loads(client.call_args.args[0].data)['input']), 9)
            self.store.ensure_vectors(self.store.load_segment('events'), query='keepsake', missing_limit=50)
            self.assertEqual(len(json.loads(client.call_args.args[0].data)['input']), 9)
