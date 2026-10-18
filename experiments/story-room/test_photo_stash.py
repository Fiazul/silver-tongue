"""Offline stash API, privacy, pacing and end-to-end image delivery checks."""
import base64
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from test_support import HermeticTestCase
from unittest.mock import patch
import time

import characters
import photo_stash
import image_refs
import scenes
import server

PNG = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'photo bytes').decode()


class StashTests(HermeticTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = server.load_config()
        self.config['embeddings'] = {'enabled': False}
        self.agent = next(a for a in self.config['agents'] if a['name'] == 'Vella')
        self.agent['stash'] = {'min_exchanges': 3, 'chance': 1, 'per_conversation': 1}
        self.stash = photo_stash.Stash(self.root, 'Vella')
        for obj, field, value in [(server, 'DATA', self.root), (server, 'LOG', self.root/'messages.jsonl'),
                (server, 'MEMORY', self.root/'memories.json'), (server, 'RESETS', self.root/'resets.json'),
                (server.relationships, 'FILE', self.root/'scores.json')]:
            p = patch.object(obj, field, value); p.start(); self.addCleanup(p.stop)
        for field, value in [('load_config', self.config), ('observe_message', None)]:
            p = patch.object(server, field, return_value=value); p.start(); self.addCleanup(p.stop)
        self.rows = [dict(id=str(n), name='Iris' if n % 2 else 'Vella', to='Vella' if n % 2 else 'Iris',
                          text='Hello', kind='chat', channel='dm') for n in range(3)]

    def add(self, **changes):
        data = dict(image=PNG, description='Iris and Ryoma on the ship', audience=['Iris'], note='Tease Iris')
        data.update(changes)
        return self.stash.add(data, ['Iris', 'Mystery'])

    def test_validation_all_fields_and_formats(self):
        for changes in [dict(image='data:image/gif;base64,R0lGODlhAAAAAA=='), dict(image='bad'),
                dict(image='data:image/png;base64,!!!!'), dict(description=''), dict(description='x'*401),
                dict(audience=['Unknown']), dict(audience='Iris'), dict(note='x'*401),
                dict(image='data:image/png;base64,'+base64.b64encode(b'wrong format').decode()),
                dict(image='data:image/webp;base64,'+base64.b64encode(b'RIFFxxxxNOPE').decode()),
                dict(image='data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\n'+b'x'*photo_stash.MAX_BYTES).decode())]:
            with self.subTest(changes=list(changes)), self.assertRaises(ValueError):
                data=dict(image=PNG,description='Photo',audience=[],note='');data.update(changes)
                self.stash.add(data,['Iris'])
        for mime, payload in [('jpeg', b'\xff\xd8\xff'+b'x'*12), ('webp',b'RIFFxxxxWEBPxxxx'), ('png',b'\x89PNG\r\n\x1a\n'+b'x'*12)]:
            item=self.stash.add(dict(image=f'data:image/{mime};base64,'+base64.b64encode(payload).decode(),description='Photo'),[])
            self.assertEqual(self.stash.path(item).read_bytes(),payload)

    def test_audience_and_prompt_limit(self):
        for n in range(5): self.add()
        prompt=self.stash.prompt(self.agent,self.rows,['Iris'],rng=lambda:0)
        self.assertEqual(len(photo_stash.DIRECTIVE.findall(prompt)), 1)
        self.assertIn('STASH DROP THIS TURN:',prompt)
        for listeners in [['Mystery'],['Iris','Mystery']]:
            self.assertEqual(self.stash.prompt(self.agent,self.rows,listeners,rng=lambda:0),'')
        self.stash.add(dict(image=PNG,description='For anyone',audience=[]),[])
        self.assertIn('For anyone',self.stash.prompt(self.agent,self.rows,['Iris','Mystery'],rng=lambda:0))
        self.assertEqual(self.stash.prompt(self.agent,self.rows,['Iris'],'group',rng=lambda:0),'')

    def test_pacing_rng_minimum_and_conversation_cap(self):
        self.add(); self.agent['stash']['chance']=.35
        self.assertEqual(self.stash.prompt(self.agent,self.rows[:2],['Iris'],rng=lambda:0),'')
        self.assertEqual(self.stash.prompt(self.agent,self.rows,['Iris'],rng=lambda:.36),'')
        self.assertIn('STASH DROP THIS TURN:',self.stash.prompt(self.agent,self.rows,['Iris'],rng=lambda:.349))
        dropped=dict(self.rows[-1],stash_ids=['used'])
        rows=self.rows+[dropped]
        self.assertEqual(self.stash.prompt(self.agent,rows,['Iris'],rng=lambda:0),'')
        self.agent['stash']['per_conversation']=2
        self.assertIn('STASH DROP THIS TURN:',self.stash.prompt(self.agent,rows,['Iris'],rng=lambda:0))
        self.agent['stash']['per_conversation']=1
        rows.append(dict(self.rows[0],thread_done=True))
        rows+=self.rows
        self.assertIn('STASH DROP THIS TURN:',self.stash.prompt(self.agent,rows,['Iris'],rng=lambda:0))
        self.assertEqual(photo_stash.conversation_messages(self.rows+[dict(name='Nora',channel='group')]*6,'Vella',['Iris'],'dm'),[])

    def test_directive_picks_one_random_eligible_pending_item(self):
        first, second = self.add(), self.add(description='A second photo')
        self.add(audience=['Mystery'])
        with patch.object(photo_stash.random, 'choice', return_value=second) as choose:
            prompt = self.stash.prompt(self.agent, self.rows, ['Iris'], rng=lambda: 0)
        self.assertEqual([i['id'] for i in choose.call_args.args[0]], [first['id'], second['id']])
        self.assertEqual(photo_stash.directive_id(prompt), second['id'])
        self.assertNotIn(first['id'], prompt)
        self.assertIn('in attachments, dropped casually mid-conversation, in character, unannounced', prompt)
        self.assertIn('never explain who gave it to you', prompt)
        self.agent['stash']['chance'] = 0
        self.assertEqual(self.stash.prompt(self.agent, self.rows, ['Iris'], rng=lambda: 0), '')

    def test_ignored_directive_emits_health_event_without_auto_attachment(self):
        photo = self.add()
        prompt = self.stash.prompt(self.agent, self.rows, ['Iris'], rng=lambda: 0)
        reply = dict(message='Hold that pose.', memory='We talked.', to='Iris', attachments=[])
        with patch.object(server, 'invoke', return_value=json.dumps(reply)), \
             patch.object(photo_stash.health, 'emit') as emit:
            turn = server.serve_turn(self.agent, prompt, [], self.config, self.config['agents'],
                                     dict(name='Iris', channel='dm'), False)
        self.assertEqual(turn[2], [])
        emit.assert_called_once_with('stash_directive_ignored', 'Vella', item_id=photo['id'])
        self.assertEqual(self.stash.items()[0]['status'], 'pending')

    def test_explicit_walk_photo_request_selects_matching_photo_despite_random_miss(self):
        self.add(description='A cockpit portrait, sitting inside the ship.', audience=['Iris','Mystery'])
        walk = self.add(description='Our shoreline walk: the captain and Iris walking hand in hand outside.', audience=['Iris','Mystery'])
        self.agent['stash']['chance'] = .35
        rows = self.rows + [dict(id='request', name='Mystery', channel='scene',
            text='Vella, show me the outside walk photo please.')]
        rows = [dict(m, channel='scene', to=None) for m in rows]
        prompt = self.stash.prompt(self.agent, rows, ['Iris','Mystery'], 'scene', rng=lambda: .99)
        self.assertEqual(photo_stash.directive_id(prompt), walk['id'])

    def test_requested_photo_is_attached_even_if_model_only_describes_it(self):
        photo = self.add(description='Our shoreline walk, holding hands outside.', audience=['Iris','Mystery'])
        rows = self.rows + [dict(id='request', name='Mystery', channel='scene',
            text='Please show me the shoreline walk photo.')]
        rows = [dict(m, channel='scene', to=None) for m in rows]
        prompt = self.stash.prompt(self.agent, rows, ['Iris','Mystery'], 'scene', rng=lambda: 0)
        reply = dict(message='Here is the shoreline walk.', memory='We shared a photo.', to=None, attachments=[])
        with patch.object(server, 'invoke', return_value=json.dumps(reply)):
            turn = server.serve_turn(self.agent, prompt, [], self.config, self.config['agents'],
                None, True)
        self.assertEqual(turn[2], ['stash:' + photo['id']])
        self.assertEqual(self.stash.items()[0]['status'], 'pending')
        posted = self.stash.post(self.agent, dict(id='posted',time='now',name='Vella',attachments=turn[2]),
            rows, ['Iris','Mystery'], 'scene', lambda m:m)
        self.assertEqual(posted['attachments'], [str(self.stash.path(photo))])
        self.assertEqual(self.stash.items()[0]['status'], 'dropped')

    def test_refusing_to_see_photo_never_forces_or_randomly_offers_one(self):
        self.add(description='Our shoreline walk.', audience=['Iris','Mystery'])
        for refusal in ("I don't want to see the shoreline walk photo.",
                        'I am not interested in seeing the shoreline walk photo.',
                        'No more walk photos, please.'):
            rows = self.rows + [dict(name='Mystery', text=refusal, channel='scene')]
            with self.subTest(refusal=refusal):
                self.assertEqual(self.stash.prompt(self.agent, rows, ['Iris','Mystery'], 'scene', rng=lambda:0), '')

    def test_named_photo_request_does_not_force_another_characters_photo(self):
        iris = next(a for a in self.config['agents'] if a['name']=='Iris')
        iris['stash'] = dict(min_exchanges=3, chance=.35, per_conversation=1)
        stash = photo_stash.Stash(self.root, 'Iris')
        stash.add(dict(image=PNG, description='Our shoreline walk.', audience=['Vella','Mystery']), ['Vella','Mystery'])
        rows = self.rows + [dict(name='Mystery', text='Vella, show me the shoreline walk photo.', channel='scene')]
        prompt = stash.prompt(iris, rows, ['Vella','Mystery'], 'scene', rng=lambda:.99)
        self.assertEqual(prompt, '')

    def test_explicit_request_still_respects_privacy_stop_and_conversation_cap(self):
        self.add(description='Our shoreline walk.', audience=['Iris'])
        rows = self.rows + [dict(id='request', name='Mystery', channel='scene',
            text='Vella, show us the shoreline walk photo.')]
        rows = [dict(m, channel='scene', to=None) for m in rows]
        self.assertEqual(self.stash.prompt(self.agent, rows, ['Iris','Mystery'], 'scene', rng=lambda:.99), '')
        self.add(description='Our shoreline walk.', audience=['Iris','Mystery'])
        rows[-1]['text'] = "Vella, don't share that walk photo."
        self.assertEqual(self.stash.prompt(self.agent, rows, ['Iris','Mystery'], 'scene', rng=lambda:0), '')
        rows[-1]['text'] = 'Vella, show us the walk photo.'
        rows.append(dict(id='dropped',name='Vella',channel='scene',stash_ids=['used']))
        self.assertEqual(self.stash.prompt(self.agent, rows, ['Iris','Mystery'], 'scene', rng=lambda:0), '')

    def test_scene_directive_validates_delivers_and_reports_omission(self):
        photo = self.stash.add(dict(image=PNG, description='Together aboard', audience=['Iris', 'Mystery']),
                               ['Iris', 'Mystery'])
        manager = scenes.Scenes(vars(server))
        meta = dict(id='a'*32, participants=['Vella', 'Iris'], kind='hangout', title='Ship', location='garage')
        rows = [dict(id=str(i), name='Iris', text='Hello', kind='chat', channel='scene') for i in range(3)]
        recalled = server.life_memory.RetrievalContext('', [], [], False)
        with patch.object(photo_stash.random, 'random', return_value=0):
            prompt = manager.prompt(self.agent, meta, rows, self.config, recalled, '')
        self.assertEqual(photo_stash.directive_id(prompt), photo['id'])
        reply = dict(message='Hold that pose.', memory='A photo together.', to=None,
                     attachments=['stash:' + photo['id']])
        with patch.object(server, 'invoke', return_value=json.dumps(reply)), \
             patch.object(photo_stash.health, 'emit') as emit:
            turn = server.serve_turn(self.agent, prompt, [], self.config, self.config['agents'], None, False)
        emit.assert_not_called()
        item = dict(id='4', time='now', name='Vella', text=turn[0], attachments=turn[2])
        posted = self.stash.post(self.agent, item, rows, ['Iris', 'Mystery'], 'scene', lambda m: m)
        self.assertEqual(posted['attachments'], [str(self.stash.path(photo))])
        reply['attachments'] = []
        with patch.object(server, 'invoke', return_value=json.dumps(reply)), \
             patch.object(photo_stash.health, 'emit') as emit:
            turn = server.serve_turn(self.agent, prompt, [], self.config, self.config['agents'], None, False)
        self.assertEqual(turn[2], [])
        emit.assert_called_once_with('stash_directive_ignored', 'Vella', item_id=photo['id'])

    def test_resolve_post_and_recipient_image(self):
        photo=self.add()
        server.LOG.write_text(''.join(json.dumps(m)+'\n' for m in self.rows))
        prompt=self.stash.prompt(self.agent,self.rows,['Iris'],rng=lambda:0)
        reply=dict(message='Look at this.',memory='I teased Iris.',to='Iris',attachments=['stash:'+photo['id']])
        with patch.object(server,'invoke',return_value=json.dumps(reply)):
            turn=server.validated_turn(self.agent,self.agent,prompt,[],self.config,self.config['agents'],
                dict(name='Iris',channel='dm'),False,time.monotonic()+20)
        posted=server.append('Vella',turn[0],recipient=turn[3],attachments=turn[2])
        self.assertEqual(posted['attachments'],[str(self.stash.path(photo))])
        saved=self.stash.items()[0]
        self.assertEqual((saved['status'],saved['dropped_to'],saved['message_id']),('dropped',['Iris'],posted['id']))
        recalled=SimpleNamespace(images=[],recall=False)
        images=server.turn_images(server.life_memory.visible_messages(server.history(),'Iris'),recalled)
        self.assertEqual(images,[self.stash.path(photo)])
        iris=next(a for a in self.config['agents'] if a['name']=='Iris')
        recipient_prompt=server.make_prompt(iris,server.history(),self.config['agents'],posted,
            recalled=server.life_memory.RetrievalContext('',[],[],False),config=self.config)
        self.assertNotIn(str(self.stash.path(photo)),recipient_prompt)
        self.assertIn(image_refs.token_for(self.stash.path(photo)),recipient_prompt)
        self.assertIn('[image #', recipient_prompt)
        with patch.object(server,'invoke',return_value=json.dumps(dict(message='Oh!',memory='I saw the photo.',to='Vella'))) as invoke:
            server.validated_turn(iris,iris,recipient_prompt,images,self.config,self.config['agents'],
                dict(name='Vella',channel='dm'),False,time.monotonic()+20)
        self.assertEqual(invoke.call_args.kwargs['images'],images)
        self.assertEqual(server.attachment_path(posted['attachments'][0]),self.stash.path(photo))
        with self.assertLogs('photo_stash',level='WARNING'):
            again=server.append('Vella','Another thought.',recipient='Iris',attachments=['stash:'+photo['id']])
        self.assertEqual(again['text'],'Another thought.');self.assertEqual(again['attachments'],[])

    def test_invalid_unoffered_tokens_preserve_message(self):
        for token in ['stash:missing','stash:'+'a'*32]:
            with self.subTest(token=token),patch.object(server,'invoke',return_value=json.dumps(dict(message='Still speaking.',memory='Here.',to='Iris',attachments=[token]))),self.assertLogs('server',level='WARNING'):
                turn=server.validated_turn(self.agent,self.agent,'No stash offered',[],self.config,self.config['agents'],dict(name='Iris',channel='dm'),False,time.monotonic()+20)
                self.assertEqual(turn[0],'Still speaking.');self.assertEqual(turn[2],[])

    def test_post_rechecks_audience_minimum_and_one_per_turn(self):
        first=self.add();second=self.add()
        for listeners,rows in [(['Mystery'],self.rows),(['Iris'],self.rows[:2])]:
            item=dict(id='1',time='now',name='Vella',attachments=['stash:'+first['id']])
            with self.assertLogs('photo_stash',level='WARNING'):
                self.stash.post(self.agent,item,rows,listeners,'dm',lambda m:m)
            self.assertEqual(item['attachments'],[])
        item=dict(id='2',time='now',name='Vella',attachments=['stash:'+first['id'],'stash:'+second['id']])
        with self.assertLogs('photo_stash',level='WARNING'):
            self.stash.post(self.agent,item,self.rows,['Iris'],'dm',lambda m:m)
        self.assertEqual(len(item['attachments']),1)
        self.assertEqual(self.stash.items()[1]['status'],'pending')

    def test_failed_post_does_not_consume(self):
        photo=self.add();item=dict(id='1',time='now',name='Vella',attachments=['stash:'+photo['id']])
        def fail(_):raise OSError('Disk unavailable')
        with self.assertRaises(OSError):self.stash.post(self.agent,item,self.rows,['Iris'],'dm',fail)
        self.assertEqual(self.stash.items()[0]['status'],'pending')

    def handler(self,path,method='GET',data=None,headers=None):
        h=object.__new__(server.Handler)
        encoded=json.dumps(data or {}).encode()
        h.path=path;h.headers={'Host':'127.0.0.1:8765','Content-Length':str(len(encoded)),**(headers or {})}
        h.rfile=io.BytesIO(encoded);h.server=SimpleNamespace(server_address=('127.0.0.1',8765))
        h.send_json=lambda body,code=200:setattr(h,'result',(code,body))
        h.send_payload=lambda body,content_type,*args,**kwargs:setattr(h,'result',(200,body))
        getattr(h,'do_'+method)()
        return h.result

    def test_api_list_upload_thumbnail_delete_reset_and_guards(self):
        base='/api/stash/Vella'
        status,item=self.handler(base,'POST',dict(image=PNG,description='A candid photo',audience=['Iris']))
        self.assertEqual(status,201)
        self.assertEqual(len(self.handler(base)[1]),1)
        self.assertIsInstance(self.handler(base+'/'+item['id']+'/image')[1],bytes)
        self.assertEqual(self.handler(base+'/'+item['id']+'/reset','POST')[0],200)
        for method,path in [('GET',base),('POST',base),('DELETE',base+'/'+item['id'])]:
            self.assertEqual(self.handler(path,method,headers={'Host':'evil.test:8765'})[0],403)
            if method!='GET':
                self.assertEqual(self.handler(path,method,headers={'Origin':'https://evil.test'})[0],403)
                self.assertEqual(self.handler(path,method,headers={'Sec-Fetch-Site':'cross-site'})[0],403)
        self.assertEqual(self.handler(base+'/'+item['id'],'DELETE')[0],200)
        self.assertEqual(self.handler(base)[1],[])
        self.assertTrue((self.stash.directory/item['file']).exists())
        self.assertEqual(self.handler('/api/stash/Unknown')[0],404)
        self.assertEqual(self.handler(base,'POST',dict(image=PNG,description='x'*401))[0],400)

    def test_reset_dropped_and_config_validation(self):
        photo=self.add()
        self.stash.post(self.agent,dict(id='1',time='now',name='Vella',attachments=['stash:'+photo['id']]),self.rows,['Iris'],'dm',lambda m:m)
        item=self.stash.change(photo['id'],True)
        self.assertEqual((item['status'],item['message_id'],item['dropped_to']),('pending',None,[]))
        for config in [None,dict(chance=2),dict(chance=True),dict(min_exchanges=-1),dict(per_conversation='1')]:
            with self.assertRaises(ValueError):characters.validate_room_roles(dict(stash=config))

    def test_scene_post_resolves_and_records_all_listeners(self):
        manager=scenes.Scenes(vars(server))
        photo=self.stash.add(dict(image=PNG,description='Scene photo',audience=['Iris','Mystery']),['Iris','Mystery'])
        meta=dict(id='a'*32,participants=['Vella','Iris'],autonomous=False)
        directory=self.root/'scene';directory.mkdir()
        rows=[dict(name='Mystery',text='Hi',channel='scene',kind='narration')]*3
        with patch.object(manager,'messages',return_value=rows),patch.object(manager,'meta',return_value=meta),patch.object(manager,'directory',return_value=directory):
            posted=manager.append(meta['id'],'Vella','A photo.',attachments=['stash:'+photo['id']])
        self.assertEqual(posted['attachments'],[str(self.stash.path(photo))])
        self.assertEqual(self.stash.items()[0]['dropped_to'],['Iris','Mystery'])

    def test_actual_dm_scene_and_meetup_prompts_keep_stash_private(self):
        photo=self.stash.add(dict(image=PNG,description='A private ship photo',audience=['Iris','Mystery']),['Iris','Mystery'])
        recalled=server.life_memory.RetrievalContext('',[],[],False)
        focus=dict(self.rows[-1],name='Iris',to='Vella')
        with patch.object(photo_stash.random,'random',return_value=0):
            prompt=server.make_prompt(self.agent,self.rows,self.config['agents'],focus,recalled=recalled,config=self.config)
            self.assertIn('stash:'+photo['id'],prompt)
            group=server.make_prompt(self.agent,self.rows,self.config['agents'],None,recalled=recalled,config=self.config)
            self.assertNotIn('STASH DROP THIS TURN:',group)
            manager=scenes.Scenes(vars(server))
            meta=dict(participants=['Vella','Iris'],autonomous=False,kind='hangout',title='Ship',location='garage',exchanges=3)
            messages=[dict(name='Iris',text='Hi',kind='chat',channel='scene')]*3
            self.assertIn('stash:'+photo['id'],manager.prompt(self.agent,meta,messages,self.config,recalled,''))
            meta['autonomous']=True
            self.assertIn('stash:'+photo['id'],server.MEETUPS.scene_prompt(self.agent,meta,messages,self.config,recalled,''))
            # A new listener changes the whole audience, rather than exposing photos to one eligible listener.
            meta['participants'].append('Nora')
            self.assertNotIn('STASH DROP THIS TURN:',server.MEETUPS.scene_prompt(self.agent,meta,messages,self.config,recalled,''))

    def test_stash_path_boundaries_and_health_events(self):
        with patch.object(photo_stash.health,'emit') as emit:
            photo=self.add()
            emit.assert_called_with('stash_added','Vella',item_id=photo['id'])
            self.stash.post(self.agent,dict(id='123',time='now',name='Vella',attachments=['stash:'+photo['id']]),self.rows,['Iris'],'dm',lambda m:m)
            emit.assert_called_with('stash_dropped','Vella',item_id=photo['id'],message_id='123')
        outside=self.root/'outside.png';outside.write_bytes(b'\x89PNG\r\n\x1a\nxxxx')
        with self.assertRaises(ValueError):photo_stash.checked(self.root,outside)
        alias=self.stash.directory/('a'*64+'.png');alias.symlink_to(outside)
        with self.assertRaises(ValueError):photo_stash.checked(self.root,alias)
