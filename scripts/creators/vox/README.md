# Offline creator-video helpers

Helpers reutilizables para un collage VOX u otro montaje editorial. No contienen
medios, secretos, rutas de un caso ni código de producción. No llaman ElevenLabs,
Kie, Firebase, TikTok, FTP ni a un tracker. No generan narración nueva al repetir.
El caso y sus fuentes/licencias se archivan fuera del repo, en su sourcepackage.

## Entorno

Python 3, FFmpeg/ffprobe en PATH. `clean_chroma.py` y sus tests requieren Pillow y
NumPy ya disponibles. En vps-tools se probaron con `/usr/bin/python3` (Pillow del
sistema y NumPy 1.21.5). No se modifica el entorno ni se instala nada al ejecutar.

## 1. Corregir un alfa sin agujerear el mango de un objeto

    /usr/bin/python3 clean_chroma.py original_fullres.png clean.png --report alpha.json

Se mide el color de borde (verde o magenta), se trabaja a resolución original,
se conserva el componente principal y se rellenan agujeros cerrados accidentales.
El despill modifica solamente el canal dominante en el borde; nunca resta un
vector RGB a todo el objeto. No se añade una trama de ruido a la opacidad.

Úsalo para UN objeto sólido sobre chroma uniforme. No para cabello fino, vidrio,
varios sujetos, diseños con huecos intencionales o fotos de fondo natural: puede
rellenar esos huecos o descartar componentes. Revisa contra negro, blanco y magenta
antes de aprobar. Se preserva la foto de entrada; salida y métricas son nuevas.

## 2. Unir audios EXISTENTES y medir el reloj real

    python3 assemble_voice.py narration_dir output_dir --factor 1.5 --fps 30

`narration_dir` contiene `lines.json` (array de strings) y `line_01.mp3` ...
`line_NN.mp3`. Primero valida TODOS los inputs; si falta uno, falla sin crear
la salida ni intentar TTS. Los MP3 originales no se sobrescriben.

Cada línea completa se decodifica a PCM mono 44100 Hz/16 bit, se aplica exactamente
un `atempo` local con el factor EXPLÍCITO y se concatena sin trim, gain, música ni
silencios nuevos. Produce WAVs por línea, `joined_raw.wav`, `joined_paced.wav` y
`alignment.json`: muestras reales, duración medida, char/s, peak/clipping, hashes
y el frame count `ceil(samples / rate * fps)`. Repetir sólo reprocesa audio local.
Los WAVs de output_dir se reconstruyen. No son timestamps fonéticos ni una garantía
de pronunciación: el alineado fino de captions sigue siendo editorial.

El factor no presupone que la API haya producido velocidad natural. Archiva aparte
voiceID, modelo, settings realmente enviados y facturación verificable de la
solicitud original. La función TTS versionada en `../tts/tts_lines.mjs` no es
idempotente y SÍ gasta por llamada: este helper NO la invoca ni cambia su default.

## 3. Verificar que el montaje no conserve el reloj de otra voz

    python3 validate_timeline.py config.json alignment.json --scenes 8 --captions 45 --output qa.json

Esquema mínimo de config: `duration`, `frames`, `fps`, `scenes` con `start`, `end`,
`captions: [{at, text}]` y opcional `voice_lines: [1, 2]`. Valida continuidad,
frames basados en PCM, captions ordenados dentro de escena, conteos y cobertura
de todas las líneas. No inspecciona píxeles ni valida claims/producto; hay que
revisar el MP4 final además. El fondo negro intencional no equivale a frame vacío.

## Tests offline

    /usr/bin/python3 -m unittest discover -s . -v

Prueban chroma verde/magenta, preservación de blancos y fuentes, eliminación de
islas/agujeros, ensamblaje local idempotente con MP3s sintéticos, inputs faltantes,
reloj PCM, gaps, cobertura de voz y captions inválidos. Los archivos temporales
respetan TMPDIR. No se commitea media ni se hace deploy/restart.

## Integración con HyperFrames

Estos helpers no cambian de motor. Para cualquier comando Node/CLI de HyperFrames,
incluyendo lint, snapshot y render, usar `DO_NOT_TRACK=1` explícitamente. Esa
variable no prueba por sí sola ausencia de toda telemetría de dependencias; el
network QA de la composición es una comprobación distinta. La adaptación del kit
VOX, sus licencias y la fuente exacta viven en el paquete reproducible del caso,
no se empujan al upstream de terceros.
