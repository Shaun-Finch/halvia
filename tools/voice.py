# One-off: render "Welcome to Halvia" with Piper neural TTS (female voices), save WAVs to media/voice-raw/.
import json, os, subprocess, urllib.request, wave
from piper import PiperVoice
os.makedirs('media/voice-raw', exist_ok=True)
base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/'
voices = {'jenny': 'en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium', 'amy': 'en/en_US/amy/medium/en_US-amy-medium', 'cori': 'en/en_GB/cori/high/en_GB-cori-high', 'kristin': 'en/en_US/kristin/medium/en_US-kristin-medium'}
for name, path in voices.items():
    try:
        for ext in ('.onnx', '.onnx.json'):
            urllib.request.urlretrieve(base + path + ext, name + ext)
        v = PiperVoice.load(name + '.onnx', config_path=name + '.onnx.json')
        with wave.open(f'media/voice-raw/{name}.wav', 'wb') as w:
            v.synthesize_wav('Welcome to Halvia.', w)
        print('ok', name)
    except Exception as e:
        print('fail', name, e)
