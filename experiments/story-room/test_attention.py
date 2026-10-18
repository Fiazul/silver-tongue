"""Pure replay regressions for counterpart-first attention and public expiry."""
from datetime import datetime, timedelta, timezone
import unittest
from test_support import HermeticTestCase

import attention


class AttentionReplayTests(HermeticTestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 16, 12, tzinfo=timezone.utc)
        self.messages = []

    def send(self, sender, text='@Ji-woo question?', channel='group', **fields):
        message = dict(id=str(len(self.messages)), name=sender, text=text, kind='chat',
                       channel=channel, time=self.now.isoformat(), to='Ji-woo' if channel == 'dm' else None)
        message.update(fields)
        self.messages.append(message)
        return message

    def box(self):
        return attention.inbox('Ji-woo', self.messages, ['Ji-woo', 'Grandpa Park', 'Mystery'],
                               lambda text, names: [name for name in names if '@' + name in text], now=self.now)

    def focus(self):
        return attention.next_thread(self.box(), {})

    def test_group_then_dm_merges_for_mystery_and_cast(self):
        for sender in ('Mystery', 'Grandpa Park'):
            with self.subTest(sender=sender):
                self.messages = []
                self.send(sender)
                dm = self.send(sender, 'Private question?', 'dm')
                box = self.box()
                self.assertEqual(len(box['pending']), 1)
                self.assertEqual(self.focus()['message'], dm)
                self.send('Ji-woo', 'Answer', 'dm', to=sender, reply_to=dm['id'], thread_done=True)
                self.assertEqual(self.box()['pending'], [])

    def test_newer_group_waits_for_unanswered_dm_then_becomes_focus(self):
        for sender in ('Mystery', 'Grandpa Park'):
            with self.subTest(sender=sender):
                self.messages = []
                dm = self.send(sender, channel='dm')
                group = self.send(sender)
                self.assertEqual(len(self.box()['pending']), 1)
                self.assertEqual(self.focus()['message'], dm)
                self.send('Ji-woo', 'Private answer', 'dm', to=sender, reply_to=dm['id'], thread_done=True)
                self.assertEqual(self.focus()['message'], group)
                self.send('Ji-woo', 'Public answer', reply_to=group['id'], thread_done=True)
                self.assertEqual(self.box()['pending'], [])

    def test_old_public_reply_does_not_consume_or_redirect_pending_dm(self):
        group = self.send('Mystery')
        dm = self.send('Mystery', channel='dm')
        self.send('Ji-woo', 'In-flight group answer', reply_to=group['id'])
        self.assertEqual(len(self.box()['pending']), 1)
        self.assertEqual(self.focus()['message'], dm)
        self.assertEqual(self.box()['active']['channel'], 'dm')

    def test_group_reply_never_acknowledges_unanswered_dm(self):
        dm = self.send('Mystery', channel='dm')
        group = self.send('Mystery')
        self.send('Ji-woo', 'Public answer', reply_to=group['id'], thread_done=True)
        self.assertEqual(self.focus()['message'], dm)

    def test_old_dm_reply_preserves_newest_dm(self):
        old = self.send('Grandpa Park', channel='dm')
        dm = self.send('Grandpa Park', 'New question', 'dm')
        self.send('Ji-woo', 'Older answer', 'dm', to='Grandpa Park', reply_to=old['id'], thread_done=True)
        self.assertEqual(self.focus()['message'], dm)

    def test_reply_to_unavailable_old_message_preserves_pending_dm(self):
        dm = self.send('Grandpa Park', channel='dm')
        self.send('Ji-woo', 'Older answer', 'dm', to='Grandpa Park', reply_to='before-reset', thread_done=True)
        self.assertEqual(self.focus()['message'], dm)

    def test_group_expiry_at_twenty_room_messages(self):
        self.send('Grandpa Park')
        self.send('Grandpa Park', 'Moving on')
        for _ in range(18):
            self.send('Kim Min-jun', 'Small talk')
        self.assertIsNotNone(self.focus())
        self.send('Kim Min-jun', 'Twentieth message')
        self.assertEqual(self.box()['pending'], [])

    def test_group_expiry_at_thirty_minutes_without_new_traffic(self):
        self.send('Grandpa Park')
        self.send('Grandpa Park', 'Moving on')
        self.now += timedelta(minutes=30) - timedelta(seconds=1)
        self.assertIsNotNone(self.focus())
        self.now += timedelta(seconds=1)
        self.assertEqual(self.box()['pending'], [])

    def test_group_expiry_accepts_utc_z_timestamps(self):
        self.send('Grandpa Park', time=self.now.isoformat().replace('+00:00', 'Z'))
        self.send('Grandpa Park', 'Moving on')
        self.now += timedelta(minutes=30)
        self.assertEqual(self.box()['pending'], [])

    def test_newest_counterpart_message_and_dm_do_not_expire(self):
        for channel in ('group', 'dm'):
            with self.subTest(channel=channel):
                self.messages = []
                latest = self.send('Grandpa Park', channel=channel)
                if channel == 'dm':
                    self.send('Grandpa Park', 'Moving on')
                for _ in range(25):
                    self.send('Kim Min-jun', 'Small talk')
                self.now += timedelta(hours=1)
                self.assertEqual(self.focus()['message'], latest)

    def test_missing_timestamp_still_expires_by_message_count(self):
        self.send('Grandpa Park', time=None)
        self.send('Grandpa Park', 'Moving on')
        for _ in range(19):
            self.send('Kim Min-jun', 'Small talk')
        self.assertEqual(self.box()['pending'], [])

    def test_mystery_first_and_newest_mystery_across_characters(self):
        self.send('Grandpa Park', '@Ji-woo urgent help')
        self.send('Mystery', '@Ji-woo urgent help', 'dm')
        older = self.focus()
        self.send('Mystery', '@The Merchant hello', 'dm', to='The Merchant')
        other = attention.inbox('The Merchant', self.messages, ['Ji-woo', 'The Merchant', 'Mystery'],
                                lambda text, names: [], now=self.now)
        merged = dict(active=None, pending=[older, *other['pending']])
        self.assertEqual(attention.next_thread(merged, {})['message']['to'], 'The Merchant')
        self.assertEqual(older['counterpart'], 'Mystery')

    def test_alarm_and_initiative_do_not_consume_pending_questions(self):
        for flag in ('alarm', 'initiative'):
            with self.subTest(flag=flag):
                self.messages = []
                dm = self.send('Mystery', channel='dm')
                self.send('Ji-woo', 'Planned greeting', 'dm', to='Mystery', **{flag: True})
                self.assertEqual(self.focus()['message'], dm)
