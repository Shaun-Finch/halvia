# One-off: render the cyber-security script line by line with the Piper "Cori" voice (same voice as the intro).
# Saves one WAV per line plus the phonemes Piper used, for lip sync, to media/voice-raw/.
import json, os, urllib.request, wave
from piper import PiperVoice
os.makedirs('media/voice-raw', exist_ok=True)
base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/cori/high/en_GB-cori-high'
for ext in ('.onnx', '.onnx.json'):
    urllib.request.urlretrieve(base + ext, 'cori' + ext)
v = PiperVoice.load('cori.onnx', config_path='cori.onnx.json')
LINES = [
    "Hello. I am a synthetic nurse.",
    "I never get tired. But the systems around me can be hacked.",
    "In twenty seventeen, the Wanna Cry attack hit the N H S. An estimated nineteen thousand appointments were cancelled.",
    "In twenty twenty four, ransomware struck Sinnovis, a London blood testing lab. More than ten thousand appointments, and seventeen hundred procedures, were postponed.",
    "When the screens go dark, care slows down. Patients wait. Records leak.",
    "The defence is not exotic. Patch your systems. Turn on two step sign in. Keep offline backups. Train your people. And rehearse the bad day.",
    "Protect the systems, and you protect the patients.",
    "I am Halvia.",
]
cfg = None
try:
    from piper import SynthesisConfig
    cfg = SynthesisConfig(length_scale=1.1)
except Exception as e:
    print('no SynthesisConfig', e)
meta = []
for i, line in enumerate(LINES):
    name = f'cyber-{i:02d}'
    with wave.open(f'media/voice-raw/{name}.wav', 'wb') as w:
        if cfg is not None:
            v.synthesize_wav(line, w, syn_config=cfg)
        else:
            v.synthesize_wav(line, w)
    try:
        ph = v.phonemize(line)
    except Exception as e:
        ph = []; print('phonemize fail', e)
    meta.append({'file': name + '.wav', 'text': line, 'phonemes': ph})
    print('ok', name)
json.dump(meta, open('media/voice-raw/cyber.json', 'w'), ensure_ascii=False, indent=1)
