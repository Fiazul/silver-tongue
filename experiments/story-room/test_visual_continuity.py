"""Known fictional cast and recent shared experiences survive image DMs."""
import base64
import json
from pathlib import Path
from unittest.mock import patch

import characters
import life_memory
import photo_stash
import server
from test_support import HermeticTestCase

PNG = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\nvisual fixture').decode()


class VisualContinuityTests(HermeticTestCase):
    def setUp(self):
        self.config = server.load_config()
        self.config['embeddings'] = {'enabled': False}
        self.agent = next(a for a in self.config['agents'] if a['name'] == 'Iris')
        self.agent['appearance'] = 'Long lavender hair, gold glasses and a gold cat hair ornament.'
        self.store = server.life_store('Iris', self.config)
        self.focus = dict(id='question', name='Mystery', to='Iris', channel='dm',
            kind='chat', text='what you doing!!', attachments=[], known_by=['Iris','Mystery'])

    def shared_event(self, source_id, text, when, about=None):
        self.store.apply([dict(segment='events', about=about or ['Iris','Mystery'], text=text,
            tags=['date'], importance=4, status='resolved')], source_id=source_id,
            time=when, embed=False, source=dict(id=source_id, name='Room', channel='scene',
                text=text, time=when, known_by=about or ['Iris','Mystery']))

    def test_latest_shared_scene_survives_short_unrelated_dm_and_memory_crowding(self):
        self.shared_event('older', 'We met in person: Our Antarctica date.', '2026-10-15T11:00:00+00:00')
        self.shared_event('latest', 'We met in person: Our Lake Natron date, hand-holding and Vella photos.',
                          '2026-10-16T11:00:00+00:00')
        for i in range(8):
            self.store.apply([dict(segment='worries', about=['Mystery'], text=f'Unanswered technical worry {i}.',
                tags=['technical'], importance=5, status='open')], embed=False)
        result = life_memory.retrieval_context(self.store, [self.focus], self.focus, budget=100,
            names=['Iris','Mystery'], agent=self.agent)
        self.assertIn('Our Lake Natron date', result.block)
        self.assertNotIn('Our Antarctica date', result.block)

    def test_recent_scene_context_is_specific_to_current_counterpart(self):
        self.shared_event('mystery', 'We met in person: OUR PRIVATE DATE.', '2026-10-16T11:00:00+00:00')
        self.shared_event('theo', 'We met in person: A walk with Theo.', '2026-10-16T12:00:00+00:00', ['Iris','Theo'])
        focus = dict(self.focus, name='Theo', to='Iris')
        result = life_memory.retrieval_context(self.store, [focus], focus, budget=100, agent=self.agent)
        self.assertIn('A walk with Theo', result.block)
        # Only the current counterpart's event is reserved, not every private event.
        self.assertNotIn('OUR PRIVATE DATE', result.block)

    def test_own_appearance_is_in_identity_but_not_other_cast_roster(self):
        focus = server.append('Mystery', 'what you doing!!', recipient='Iris')
        prompt = server.make_prompt(self.agent, server.history(), self.config['agents'], focus, config=self.config)
        self.assertIn('Long lavender hair', prompt)
        self.assertNotIn('Long lavender hair', characters.roster(self.agent))

    def test_private_memory_md_always_contains_self_status_and_recent_activity(self):
        self.shared_event('date', 'We met in person: Our Lake Natron date, hand-holding and Vella photos.',
                          '2026-10-16T11:00:00+00:00')
        server.remember('Iris', 'I am Iris. I care deeply about Ryoma and am home after our date.')
        focus = server.append('Mystery', 'hey', recipient='Iris')
        prompt = server.make_prompt(self.agent, server.history(), self.config['agents'], focus, config=self.config)
        path = self.store.directory / 'memory.md'
        self.assertTrue(path.is_file())
        note = path.read_text()
        self.assertIn('Long lavender hair', note)
        self.assertIn('home after our date', note)
        self.assertIn('Our Lake Natron date', note)
        self.assertIn('Our Lake Natron date', prompt)

    def test_private_date_in_self_file_is_not_supplied_to_uninvolved_listener(self):
        self.shared_event('date', 'We met in person: OUR PRIVATE DATE.', '2026-10-16T11:00:00+00:00')
        focus = server.append('Theo', 'hey', recipient='Iris')
        prompt = server.make_prompt(self.agent, server.history(), self.config['agents'], focus, config=self.config)
        self.assertTrue((self.store.directory / 'memory.md').is_file())
        self.assertIn('OUR PRIVATE DATE', (self.store.directory / 'memory.md').read_text())
        # The always-on file must not add private activity into a different listener's context.
        block = prompt.split('PERSONAL CONTINUITY',1)[-1].split('END PERSONAL CONTINUITY',1)[0]
        self.assertNotIn('OUR PRIVATE DATE', block)

    def test_public_name_introduction_does_not_make_private_activity_public(self):
        import self_memory
        self.shared_event('date', 'Mystery introduced himself as Ryoma. We secretly dated at the lake.',
                          '2026-10-16T11:00:00+00:00')
        public = dict(id='intro',name='Mystery',text='My name is Ryoma.',channel='group',known_by=['Iris','Theo','Mystery'])
        block = self_memory.context(self.store,self.agent,'I am Iris.','At home.',['Theo'],[public])
        self.assertNotIn('secretly dated at the lake', block)
        self.assertIn('secretly dated at the lake', (self.store.directory/'memory.md').read_text())

    def saved_photo(self, audience):
        stash = photo_stash.Stash(server.DATA, 'Vella')
        item = stash.add(dict(image=PNG,
            description='Ryoma working at the console while Iris pokes his ear.',
            audience=audience, note='PRIVATE HINT MUST NEVER APPEAR'), ['Iris','Mystery','Vella'])
        path = server.chat_images.store(PNG)
        return stash, item, path

    def test_exact_known_photo_caption_reaches_dm_prompt_without_private_hint(self):
        _, _, path = self.saved_photo(['Iris','Mystery'])
        focus = server.append('Mystery', 'what you doing!!', recipient='Iris', attachments=[path])
        prompt = server.make_prompt(self.agent, server.history(), self.config['agents'], focus, config=self.config)
        self.assertIn('Ryoma working at the console while Iris pokes his ear.', prompt)
        self.assertNotIn('PRIVATE HINT MUST NEVER APPEAR', prompt)

    def test_caption_does_not_leak_to_unapproved_viewer_or_audience(self):
        _, _, path = self.saved_photo(['Iris'])
        focus = server.append('Mystery', 'what you doing!!', recipient='Iris', attachments=[path])
        prompt = server.make_prompt(self.agent, server.history(), self.config['agents'], focus, config=self.config)
        self.assertNotIn('Ryoma working at the console while Iris pokes his ear.', prompt)
        self.assertNotIn('PRIVATE HINT MUST NEVER APPEAR', prompt)

    def test_hidden_dm_image_does_not_supply_its_caption_to_other_character(self):
        _, _, path = self.saved_photo(['Iris','Mystery'])
        server.append('Mystery', 'what you doing!!', recipient='Iris', attachments=[path])
        theo = next(a for a in self.config['agents'] if a['name']=='Theo')
        focus = server.append('Mystery', 'Hi Theo.', recipient='Theo')
        prompt = server.make_prompt(theo, server.history(), self.config['agents'], focus, config=self.config)
        self.assertNotIn('Ryoma working at the console while Iris pokes his ear.', prompt)

    def test_different_image_never_inherits_a_known_caption(self):
        self.saved_photo(['Iris','Mystery'])
        different = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\nother fixture').decode()
        path = server.chat_images.store(different)
        focus = server.append('Mystery', 'what you doing!!', recipient='Iris', attachments=[path])
        prompt = server.make_prompt(self.agent, server.history(), self.config['agents'], focus, config=self.config)
        self.assertNotIn('Ryoma working at the console while Iris pokes his ear.', prompt)

    def test_unrelated_corrupt_stash_cannot_break_known_image_context(self):
        _, _, path = self.saved_photo(['Iris','Mystery'])
        focus = server.append('Mystery', 'what you doing!!', recipient='Iris', attachments=[path])
        broken = server.DATA/'stash'/'Theo'/'stash.json'
        broken.parent.mkdir(parents=True)
        for data in ('{broken', '[{}]', '{"unexpected":true}', '[null]'):
            with self.subTest(data=data):
                broken.write_text(data)
                prompt=server.make_prompt(self.agent,server.history(),self.config['agents'],focus,config=self.config)
                self.assertIn('Ryoma working at the console while Iris pokes his ear.',prompt)
