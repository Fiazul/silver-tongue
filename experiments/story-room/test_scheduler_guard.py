"""Schedulers keep selection inside their caller's available cast."""
from unittest.mock import patch

import server
from test_support import HermeticTestCase


class SchedulerGuardTests(HermeticTestCase):
    def setUp(self):
        self.config = server.load_config()
        for agent in self.config['agents']:
            agent['enabled'] = True
            agent.pop('routine', None)
        self.merchant = next(a for a in self.config['agents'] if a['name'] == 'The Merchant')
        self.present = [a for a in self.config['agents'] if a['name'] != 'The Merchant']
        server.relationships.save('The Merchant', {'Mystery': {'like': 1500, 'dislike': 0,
                                                       'mood': {'missing': 100}}})

    def selections(self, agents):
        messages = [dict(id=str(i), name='Ji-woo', text='Hello.', kind='chat', channel='group')
                    for i in range(3)]
        return [server.quiet_turn(messages, agents, self.config),
                server.choose_next(messages, agents, self.config),
                server.priority_turn(messages, agents, self.config),
                server.affection_turn(messages, agents, self.config),
                server.host_friendly_turn(messages, agents, self.config),
                server.initiative_turn(messages, agents)]

    def test_absent_high_longing_character_is_never_selected(self):
        allowed = {a['name'] for a in self.present}
        for picked in self.selections(self.present):
            name = picked[0] if isinstance(picked, tuple) else picked
            self.assertTrue(name is None or name in allowed, picked)
        server.ACTIVE.set()
        with patch.object(server, 'available_agents', return_value=self.present), \
             patch.object(server, 'serve_turn') as serve:
            server.set_quiet_room(True)
            server.run_turn(self.config)
        if serve.called:
            self.assertIn(serve.call_args.args[0]['name'], allowed)

    def test_away_high_longing_character_is_never_selected(self):
        self.merchant['group_initiative'] = True
        with patch.object(server.SCENES, 'away_reason', return_value='In a scene'):
            self.assertEqual(self.selections([self.merchant]), [None] * 6)

    def test_run_turn_skips_stale_selection_and_logs_warning(self):
        server.ACTIVE.set()
        with patch.object(server, 'available_agents', return_value=self.present), \
             patch.object(server, 'quiet_room', return_value=True), \
             patch.object(server, 'quiet_turn', return_value=('The Merchant', None, 'outreach')), \
             patch.object(server, 'serve_turn') as serve, \
             self.assertLogs('server', level='WARNING') as logs:
            server.run_turn(self.config)
        self.assertIn('The Merchant', logs.output[0])
        serve.assert_not_called()
        self.assertIsNone(server.STATE['speaker'])
