"""On-demand local Piper audio, cached outside Git."""
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import unicodedata
import wave

ROOT = Path(__file__).resolve().parent
VOICE_DIR = ROOT / 'data' / 'voices'
AUDIO_DIR = ROOT / 'data' / 'audio'
SHARED = Path.home() / '.local' / 'share' / 'piper'
SPEECH_LOCK = threading.Lock()


class SpeechError(RuntimeError):
    pass


def voice_path(voice):
    if not re.fullmatch(r'[a-z]{2}_[A-Z]{2}-[a-zA-Z0-9_]+-(?:low|medium|high|x_low)', voice or ''):
        raise SpeechError('No valid Piper voice assigned')
    for directory in (VOICE_DIR, SHARED):
        model = directory / (voice + '.onnx')
        if model.is_file() and model.with_suffix('.onnx.json').is_file():
            return model
    raise SpeechError('Voice is not downloaded. Run python3 setup_voices.py.')


def ready(voice):
    try:
        voice_path(voice)
        return bool(shutil.which('piper'))
    except SpeechError:
        return False


def spoken_text(text):
    text = text.replace('@', '')
    text = ''.join(c for c in text if c.isspace() or unicodedata.category(c)[0] in 'LNPZ')
    return ' '.join(text.split())[:1600]


def audio_for(text, voice):
    model = voice_path(voice)
    text = spoken_text(text)
    if not text:
        raise SpeechError('This message has no speakable text')
    key = hashlib.sha256((voice + '\n' + text).encode()).hexdigest()
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    output = AUDIO_DIR / (key + '.wav')
    with SPEECH_LOCK:
        if output.is_file():
            return output
        executable = shutil.which('piper')
        if not executable:
            raise SpeechError('Piper is not installed. Install piper-tts first.')
        temporary = output.with_suffix('.part.wav')
        try:
            env = os.environ.copy()
            env.update(OMP_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2')
            result = subprocess.run([executable, '--model', str(model), '--output-file', str(temporary)],
                                    input=text, text=True, capture_output=True, timeout=60, env=env)
            if result.returncode:
                raise SpeechError('Piper failed: ' + result.stderr[-250:])
            with wave.open(str(temporary), 'rb') as audio:
                if audio.getnframes() < 1 or audio.getsampwidth() != 2:
                    raise SpeechError('Piper did not return valid audio')
            temporary.replace(output)
        except (OSError, subprocess.SubprocessError, wave.Error, EOFError) as exc:
            raise SpeechError('Could not create voice audio: ' + str(exc)) from exc
        finally:
            temporary.unlink(missing_ok=True)
    return output
