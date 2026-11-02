"""Transcribe el video de referencia de un caso de creators_research (genérico).

Uso:
    python transcribe_creator_ref.py <caso> [archivo.mp4]

- <caso> es la carpeta bajo creators_research/edits (p. ej. 02_blanket).
- Si se omite el archivo, se toma el único .mp4 de <caso>/input.
- Las credenciales del NAS llegan como JSON por stdin (SSH cifrado); nunca se persisten.
- Deja el video y los transcripts en D:\\staging\\<caso>\\.

Requisitos en la PC: venv con faster-whisper en D:\\staging\\hermes-transcription\\venv,
modelo en D:\\staging\\hermes-transcription\\model.
"""
import hashlib, json, os, sys
from pathlib import Path

import smbclient
import spnego

native_client = spnego.client
def ntlm_client(*a, **kw):
    kw['options'] = kw.get('options', spnego.NegotiateOptions.none) | spnego.NegotiateOptions.use_ntlm
    return native_client(*a, **kw)
spnego.client = ntlm_client

if len(sys.argv) < 2:
    sys.exit('uso: transcribe_creator_ref.py <caso> [archivo.mp4]')
CASE = sys.argv[1]

SERVER = '100.91.254.118'
SHARE = 'Projects'
NAS_CASE = rf'\\{SERVER}\{SHARE}\Tiktok\hamaca\creators_research\edits\{CASE}'
NAS_INPUT = NAS_CASE + r'\input'

STAGING = Path(r'D:\staging')
MODEL = STAGING / 'hermes-transcription' / 'model'
VENV = STAGING / 'hermes-transcription' / 'venv'


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''):
            h.update(c)
    return h.hexdigest()


creds = json.loads(sys.stdin.read())
smbclient.register_session(SERVER, username=creds['username'], password=creds['password'],
                           encrypt=True, auth_protocol='ntlm', connection_timeout=15)
creds.clear()

if len(sys.argv) >= 3:
    name = sys.argv[2]
else:
    mp4s = [e.name for e in smbclient.scandir(NAS_INPUT) if e.name.lower().endswith('.mp4')]
    if len(mp4s) != 1:
        sys.exit(f'input/ tiene {len(mp4s)} mp4: pasa el nombre explícitamente -> {mp4s}')
    name = mp4s[0]

SRC = NAS_INPUT + '\\' + name
ROOT = STAGING / CASE
ROOT.mkdir(parents=True, exist_ok=True)
local = ROOT / name

st = smbclient.stat(SRC)
with smbclient.open_file(SRC, 'rb') as i, open(local, 'wb') as o:
    while True:
        b = i.read(1 << 20)
        if not b:
            break
        o.write(b)
print('STAGED case=%s file=%s bytes=%d size_matches=%s sha256=%s' % (
    CASE, name, local.stat().st_size, local.stat().st_size == st.st_size, sha(local)), flush=True)

pkg = VENV / 'Lib' / 'site-packages' / 'nvidia'
for dll in (pkg / 'cublas' / 'bin', pkg / 'cudnn' / 'bin'):
    os.add_dll_directory(str(dll)); os.environ['PATH'] = str(dll) + os.pathsep + os.environ['PATH']

import time
from faster_whisper import WhisperModel
model = WhisperModel(str(MODEL), device='cuda', compute_type='int8_float16',
                     cpu_threads=2, num_workers=1, local_files_only=True)
t0 = time.monotonic()
segments, info = model.transcribe(str(local), language='ja', task='transcribe',
                                 beam_size=5, vad_filter=True, condition_on_previous_text=True)
segs = [{'start': round(s.start, 3), 'end': round(s.end, 3), 'text': s.text.strip()} for s in segments]
elapsed = round(time.monotonic() - t0, 2)
plain = '\n'.join(s['text'] for s in segs if s['text'])
(ROOT / 'transcript_plain_ja.txt').write_text(plain + '\n', encoding='utf-8')
(ROOT / 'transcript_segments_ja.json').write_text(json.dumps(
    {'source': name, 'case': CASE, 'language': info.language, 'audio_duration': info.duration,
     'seconds': elapsed, 'segments': segs}, ensure_ascii=False, indent=2), encoding='utf-8')
print('ASR language=%s audio_duration=%.3f elapsed=%.2f segments=%d chars=%d' % (
    info.language, info.duration, elapsed, len(segs), len(plain)), flush=True)
smbclient.reset_connection_cache()
