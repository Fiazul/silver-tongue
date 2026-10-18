"""Per-test storage isolation, applied before even a subclass's setUp runs.

Keep real load_config validation: only its input file is replaced. Individual
tests can layer their own paths/mocks over these defaults and cleanup normally.
"""
from contextlib import ExitStack
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

import server
import health
import speech

FIXTURE_CONFIG = Path(__file__).resolve().parent / 'tests' / 'fixtures' / 'agents.json'


class HermeticTestCase(unittest.TestCase):
    def run(self, result=None):
        with ExitStack() as stack:
            root = Path(stack.enter_context(tempfile.TemporaryDirectory()))
            data = root / 'data'
            data.mkdir()
            config = root / 'agents.json'
            config.write_bytes(FIXTURE_CONFIG.read_bytes())
            real_popen = subprocess.Popen
            def local_python_only(args, *pos, **kwargs):
                if isinstance(args, (list, tuple)) and args[0] in ('notify-send', 'paplay', 'aplay'):
                    raise FileNotFoundError('System notification/audio disabled in tests')
                if not isinstance(args, (list, tuple)) or args[0] != sys.executable:
                    raise AssertionError('Tests must mock provider/process calls')
                return real_popen(args, *pos, **kwargs)
            stack.enter_context(patch.object(subprocess, 'Popen', local_python_only))
            stack.enter_context(patch.object(server.embeddings, 'urlopen',
                                             side_effect=AssertionError('Tests must mock embedding HTTP calls')))
            for obj, name, value in (
                (server, 'CONFIG', config), (server, 'DATA', data),
                (server, 'LOG', data / 'messages.jsonl'),
                (server, 'MEMORY', data / 'memories.json'),
                (server, 'RESETS', data / 'character-resets.json'),
                (server, 'PIDFILE', data / 'server.pid'),
                (server.relationships, 'FILE', data / 'relationships.json'),
                (server.chat_images, 'DIRECTORY', data / 'uploads'),
                (speech, 'VOICE_DIR', data / 'voices'),
                (speech, 'AUDIO_DIR', data / 'audio'),
                (speech, 'SHARED', data / 'shared-voices'),
                (health, 'EVENTS', health.deque(maxlen=50)),
                (health, 'FAILURE_TIMES', health.deque()),
                (health, 'MEMORY_SWEEPS', {}),
            ):
                stack.enter_context(patch.object(obj, name, value))
            # Managers retain references to server globals; fresh instances also
            # prevent in-memory scene/alarm/meetup jobs leaking between tests.
            for name, factory in (('SCENES', server.scenes.Scenes),
                                  ('MEETUPS', server.meetups.Meetups),
                                  ('TIMEKEEPER', server.timekeeper.Timekeeper)):
                stack.enter_context(patch.object(server, name, factory(vars(server))))
            for name in ('PROVIDER_BREAKS', 'PROVIDER_EXHAUSTED', 'PROVIDER_TRIALS',
                         'CHARACTER_BREAKS', 'HOST_INITIATIVE_STARTED', '_HISTORY_CACHE'):
                stack.enter_context(patch.object(server, name, {}))
            stack.enter_context(patch.dict(server.STATE, dict(
                speaker=None, turns=0, limit=24, evening_complete=False, reason='Ready'), clear=True))
            for name in ('ACTIVE', 'STOP', 'WAKE'):
                stack.enter_context(patch.object(server, name, server.threading.Event()))
            return super().run(result)
