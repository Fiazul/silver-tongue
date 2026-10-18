"""Finite character-led conversations through the real DM posting pipeline."""
from datetime import timedelta
import json
from unittest.mock import patch

import disclosure
import attention
import life_memory
import server
import test_followup
from test_support import HermeticTestCase


class StoryArcTests(HermeticTestCase):
    setUp = test_followup.FollowupTests.setUp
    provider = test_followup.FollowupTests.provider
    setup_pair = test_followup.FollowupTests.setup_pair

    def test_stored_targets_avoid_reparsing_every_historical_message(self):
        def parse(text, names):
            raise AssertionError('Stored addressing already resolves this message')
        row = dict(id='1', name='Beacon', text='Ji-woo, a thought.', channel='group',
                   targets=['Ji-woo'], kind='chat', time=self.now.isoformat())
        box = attention.inbox('Ji-woo', [row], ['Ji-woo', 'Beacon'], parse, now=self.now)
        self.assertEqual(box['pending'][0]['counterpart'], 'Beacon')

    def ready(self):
        self.setup_pair()
        self.arc = dict(id='backstory', lead='Ji-woo', partner='Beacon', enabled=True,
                        pace_seconds=2, goal='Ji-woo takes the lead because she wants to understand Alex.',
                        topics=[dict(question='What happened to his original home?', logs=['M007'])])
        self.config['story_arcs'] = [self.arc]
        self.host['lore_permissions'] = {'Ji-woo': ['all']}
        server.STATE.update(turns=0, limit=1)

    def reply(self, name, target, done=True):
        self.invoke.side_effect = None
        self.invoke.return_value = json.dumps(dict(message='A real new thought.', memory='We are talking.',
                                                   to=target, thread_done=done))
        before = len(server.history())
        server.run_turn(self.config)
        self.assertEqual(len(server.history()), before + 1)
        posted = server.history()[-1]
        self.assertEqual((posted['name'], posted['to']), (name, target))
        return posted

    def test_progresses_without_operator_and_early_goodbye_is_not_completion(self):
        self.ready()
        first = self.reply('Ji-woo', 'Beacon')
        self.assertEqual(first['story_arc'], 'backstory')
        self.assertFalse(first.get('thread_done', False))
        self.assertEqual(server.STATE['turns'], 0)
        self.now += timedelta(seconds=2)
        second = self.reply('Beacon', 'Ji-woo')
        self.assertEqual(second['story_step'], 1)
        self.now += timedelta(seconds=2)
        close = self.reply('Ji-woo', 'Beacon')
        self.assertTrue(close['thread_done'])
        self.now += timedelta(seconds=2)
        last = self.reply('Ji-woo', 'Mystery')
        self.assertTrue(last['thread_done'])
        self.assertEqual(last['story_step'], 3)
        server.run_turn(self.config)
        self.assertEqual(server.history()[-1]['id'], last['id'])

    def test_pause_and_wrong_recipient_do_not_advance(self):
        self.ready()
        server.ACTIVE.clear()
        server.run_turn(self.config)
        self.assertEqual(server.history(), [])
        server.ACTIVE.set()
        self.invoke.side_effect = None
        self.invoke.return_value = json.dumps(dict(message='Wrong destination.', memory='Waiting.', to='Mystery'))
        server.run_turn(self.config)
        self.assertEqual(server.history(), [])
        self.reply('Ji-woo', 'Beacon')

    def test_pacing_does_not_fall_back_to_an_untracked_reply(self):
        self.ready()
        self.reply('Ji-woo', 'Beacon')
        before = len(server.history())
        self.now += timedelta(seconds=1)
        server.run_turn(self.config)
        self.assertEqual(len(server.history()), before)
        self.now += timedelta(seconds=1)
        self.reply('Beacon', 'Ji-woo')

    def test_wrong_recipient_attempts_are_bounded_across_reselection(self):
        self.ready()
        self.invoke.side_effect = None
        self.invoke.return_value = json.dumps(dict(message='I will contact her.', memory='Waiting.', to='Mystery'))
        for _ in range(3):
            server.run_turn(self.config)
        before = self.invoke.call_count
        server.run_turn(self.config)
        self.assertEqual(self.invoke.call_count, before)
        self.assertEqual(server.history(), [])

    def test_explicit_contact_boundary_is_respected(self):
        self.ready()
        server.life_store('Beacon').apply([dict(segment='boundaries', about=['Ji-woo'],
            text='Ji-woo, please give me space.', tags=['space'], importance=5, status='open')],
            source_id='boundary', embed=False)
        before = self.invoke.call_count
        server.run_turn(self.config)
        self.assertEqual(self.invoke.call_count, before)
        self.assertEqual(server.history(), [])

    def test_operator_reply_precedes_story_and_progress_survives_restart(self):
        self.ready()
        incoming = server.append('Mystery', 'Are you there?', recipient='Ji-woo')
        posted = self.reply('Ji-woo', 'Mystery')
        self.assertEqual(posted['reply_to'], incoming['id'])
        self.assertNotIn('story_arc', posted)
        posted = self.reply('Ji-woo', 'Beacon')
        self.assertEqual(posted['story_step'], 0)
        self.now += timedelta(seconds=2)
        # Selection derives only from the transcript, not a live process cursor.
        self.reply('Beacon', 'Ji-woo')

    def test_operator_interrupts_active_pair_even_at_completed_evening(self):
        self.ready()
        self.reply('Ji-woo', 'Beacon')
        self.now += timedelta(seconds=2)
        server.STATE.update(turns=1, limit=1, evening_complete=True)
        server.ACTIVE.clear()
        incoming = server.append('Mystery', 'Ji-woo, are you there?', recipient='Ji-woo')
        posted = self.reply('Ji-woo', 'Mystery')
        self.assertEqual(posted['reply_to'], incoming['id'])
        self.assertNotIn('story_arc', posted)
        self.reply('Beacon', 'Ji-woo')

    def test_final_lead_response_does_not_wait_for_partner_provider(self):
        self.ready()
        self.reply('Ji-woo', 'Beacon')
        self.now += timedelta(seconds=2)
        self.reply('Beacon', 'Ji-woo')
        self.now += timedelta(seconds=2)
        self.reply('Ji-woo', 'Beacon')
        self.host['enabled'] = False
        self.now += timedelta(seconds=2)
        self.reply('Ji-woo', 'Mystery')

    def test_woken_character_waits_without_spending_story_attempts(self):
        self.ready()
        self.agent['routine'] = dict(sleep='00:30-07:30', home='the room behind the stall', day='Cooking',
                                     sleepy_reply=True)
        self.now = self.now.replace(hour=19)  # 04:00 Seoul the next day.
        server.append('Mystery', 'Are you there?', recipient='Ji-woo')
        self.reply('Ji-woo', 'Mystery')
        before = self.invoke.call_count
        for _ in range(4):
            server.run_turn(self.config)
        self.assertEqual(self.invoke.call_count, before)
        self.assertFalse((server.DATA/'story_arcs'/'backstory.json').exists())
        self.now += timedelta(hours=7)
        self.reply('Ji-woo', 'Beacon')

    def test_focused_lore_only_reaches_owner_and_actual_listener_permission_applies(self):
        self.ready()
        secret = dict(segment='events', about=['Beacon'], text='His old home in Busan was lost in the flood.',
                      tags=['home'], importance=5, status='resolved', retrieval_only=True, private=True)
        server.life_store('Beacon').apply([secret], source_id='lore:M007', embed=False)
        self.reply('Ji-woo', 'Beacon')
        self.assertNotIn(secret['text'], self.invoke.call_args.args[1])
        self.now += timedelta(seconds=2)
        self.reply('Beacon', 'Ji-woo')
        self.assertIn(secret['text'], self.invoke.call_args.args[1])
        self.assertNotIn('not yours to share with Ji-woo', self.invoke.call_args.args[1])
        store = server.life_store('Beacon')
        controls = disclosure.overrides(store, [], ['Ji-woo', 'The Corner Shop Clerk'], self.host)
        self.assertTrue(disclosure.allowed(self.host, 'Ji-woo', 'core', {}, controls))
        self.assertFalse(disclosure.allowed(self.host, 'The Corner Shop Clerk', 'core', {}, controls))
