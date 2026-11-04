# scripts/creators — toolkit para recrear el video de un creador

Herramientas auxiliares para **recrear el edit de un video de creador** (caso
piloto `01_squishy01`): medir el estilo del creador, construir la receta ffmpeg que
alimenta a [`collage_builder.py`](../collage_builder.py), extraer fotogramas de los
clips y mover archivos hacia/desde el NAS.

Estos scripts eran antes one-offs sueltos en un directorio efímero; aquí viven
versionados y **sin rutas del caso hardcodeadas** (todo entra por CLI).

Runbook de referencia (repo Cacho, `/root/cacho`):
`operations/recrear-video-creadores-edits.md`.

## Dónde corre cada cosa

| Script | Corre en | Por qué |
|---|---|---|
| `build_recipe_from_plan.py` | **vps-projects** | Necesita el mount `/mnt/polaris` y `ffprobe`. |
| `measure_caption_style.py` | **vps-projects** | Lee los fotogramas/clips del mount (`ffmpeg` para el path de video). |
| `extract_clip_frames.sh` | **vps-projects** | `ffmpeg`/`ffprobe` sobre los clips del mount. |
| `tts/tts_lines.mjs` | **vps-projects** | Usa el `node_modules` del repo (`node-fetch`) y la API key de `ttchop-server/.env`. |
| `nas/put.py`, `nas/get.py`, `nas/list_dir.py` | **vps-tools** | Ahí vive la credencial pumassh (`/root/.config/pumassh/polaris.json`). |
| `shotlist/analyze_ref_shots.py`, `shotlist/transcribe_creator_ref.py` | **PC PumaDeskAsus** | ffmpeg de escritorio y ASR con CUDA sobre el video original. |
| `shotlist/make_shot_gifs.py`, `shotlist/build_shotlist_html.py`, `shotlist/publish_ftp.py` | **vps-tools** | ffmpeg, PIL y la credencial FTPS viven ahí. |

> Los helpers SMB usan la librería Python `smbclient` (no el mount CIFS). En **vps-tools**
> ya hay un venv listo con ella: `/root/.venvs/nas-smb/bin/python` (si falta en otro host,
> `pip install smbclient`).

## 1. `build_recipe_from_plan.py`

Convierte un *plan* (cuántos segundos debe aportar cada clip) en el objeto
`ffmpegRecipe` que consume `collage_builder.py`. Generaliza el `make_recipe2.py` del
caso `01_squishy01`.

```
python3 build_recipe_from_plan.py \
    --plan plan.example.json \
    --video-dir /mnt/polaris/.../01_squishy01/assets/video \
    --audio    /mnt/polaris/.../01_squishy01/assets/audio/01_squishy01_voice_1p5x_spaced.mp3 \
    --out      recipe.json \
    [--output-video /ruta/out.mp4] [--width 1080] [--height 1920] \
    [--trim-start-ratio 0.35] [--no-absorb]
```

- El **plan** es una lista JSON de pares `[segundos, nombre_de_clip]`
  (ver `plan.example.json`); también acepta `{"plan": [...], "durations": {...}}`.
- Las **duraciones de los clips** se miden con `ffprobe` (no hace falta tabla manual);
  pasa `--durations dur.json` para reutilizar mediciones ya hechas.
- La **duración del audio** se mide con `ffprobe` (`--audio-duration` para forzarla).
- Lógica conservada del original:
  `trimStart = clamp(trim_start_ratio·dur − 0.3, 0, dur − need − 0.1)` y la
  diferencia entre el audio y la suma del plan la **absorbe el último clip**
  (desactívalo con `--no-absorb`).

## 2. `plan.example.json`

El plan real del caso `01_squishy01` (17 clips) con las duraciones reales medidas.
Sirve de plantilla y como fixture de prueba.

## 3. `measure_caption_style.py`

Mide la banda del caption del creador y su centrado.

```
python3 measure_caption_style.py --input <carpeta_de_frames | video.mp4> \
    [--times 1.0,3.5,6.5] [--region 0,0,1,0.65] [--threshold 235] [--min-pixels 5]
```

`--input` puede ser una carpeta de imágenes (mide cada una) o un video (extrae
fotogramas en `--times`; por defecto 5 muestras repartidas en la duración).
`--region` es `x0,y0,x1,y1` (fracciones ≤1 o píxeles). Imprime, por frame, la banda
vertical (`y..y` y su % del alto), el centro, el alto del texto y el centrado
horizontal.

## 4. `extract_clip_frames.sh`

Un frame representativo por clip (omite los ya extraídos; nombra `fNN.jpg`).

```
./extract_clip_frames.sh <clips_dir> <out_dir> [percent=0.35] [scale_width=200] [glob=*.mp4]
```

## 5. `nas/` — helpers SMB

```
python3 nas/list_dir.py <remote_relpath>
python3 nas/get.py <remote_relpath> <local_outpath>
python3 nas/put.py <remote_dir> <local_file>... [--force]
```

- `remote_*` es **relativo al share** (por defecto `\\100.91.254.118\Projects`;
  override con `NAS_SERVER`/`NAS_SHARE`).
- `put.py` **falla** si el archivo remoto ya existe con contenido distinto; usa
  `--force` para sobrescribir. Archivos idénticos se omiten. Cada subida se verifica
  releyendo el remoto y comparando SHA-256.

**Seguridad (igual que los originales):** la credencial se abre con `O_NOFOLLOW` y se
valida (`S_ISREG`, `uid == getuid`, `mode & 0o077 == 0`); **nunca** se imprimen las
credenciales.

## 6. `tts/` — voz de las líneas con el TTS del server

Genera la voz del guion de un caso con el TTS del propio `ttchop-server`
(ElevenLabs, voz **PumaVoice01**), una toma por línea. Corre en **vps-projects**
(necesita el `node_modules` del repo y la API key de `.env`).

```
node tts_lines.mjs <lines.json> <dir_salida> [voiceId]
```

Ver **`tts/README.md`**. Los `.mp3` salen a un directorio de trabajo: **no se commitea media**.

## 7. `shotlist/` — lista de shots a grabar (HTML con GIF animado)

Convierte el video de referencia de un creador en una **lista HTML de shots a grabar**,
con cada shot como **GIF animado de 6 fps**, su duración, encuadre y una línea de acción,
agrupado por tipo de toma. Es el paso previo al montaje: primero se graba lo que dice la
lista, después se arma la receta con `build_recipe_from_plan.py`.

```
transcribe_creator_ref.py <caso> [archivo.mp4]                        # PC  (ASR)
analyze_ref_shots.py <video> <dir_salida> [umbral=0.27]               # PC  (cortes + frames)
make_shot_gifs.py <video> <dir_shots> <dir_gifs> [ancho] [fps] ...    # vps-tools
build_shotlist_html.py <dir_shots> <salida.html> [caso] [json] [pref] # vps-tools
publish_ftp.py {list|put|putmany} ...                                 # vps-tools
```

Los datos del caso (25 descripciones + grupos en el caso piloto `02_blanket`) entran por
un `shotlist.json` junto a los shots — plantilla en `shotlist/shotlist.example.json`.

Ver **`shotlist/README.md`** para el flujo completo, los comandos y los pitfalls
(frames al punto medio del shot, descripciones indexadas por frame del original y no por
el número fusionado, agrupar por tipo de toma, GIFs como archivos aparte con respaldo
embebido, hoja de contacto con PIL en vez de `ffmpeg -pattern_type glob`).
