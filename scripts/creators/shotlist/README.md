# scripts/creators/shotlist — lista de shots a grabar (HTML con GIF animado)

Toolkit para convertir el **video de referencia de un creador** en una **lista HTML de
shots a grabar**, donde cada shot se ve como **GIF animado de 6 fps** junto a su duración,
encuadre y una línea de acción. Es el paso previo al montaje: primero se graba lo que dice
la lista, después se arma la receta con
[`../build_recipe_from_plan.py`](../build_recipe_from_plan.py).

Estos scripts vivían como one-offs en un directorio efímero (el caso piloto fue
`02_blanket`, 25 tomas). Aquí quedan versionados, **genéricos** y sin nada del caso
hardcodeado: los datos del caso entran por `shotlist.json` y por CLI.

## Flujo completo (orden real de los pasos)

| # | Paso | Script | Corre en | Por qué ahí |
|---|---|---|---|---|
| 1 | Transcribir el audio del video de referencia (ASR) | `transcribe_creator_ref.py` | **PC PumaDeskAsus** | Necesita faster-whisper con CUDA y la credencial SMB del NAS. |
| 2 | Detectar los cortes y sacar un frame por shot | `analyze_ref_shots.py` | **PC PumaDeskAsus** | Lee el video original con ffmpeg (detección de escena). |
| 3 | Recortar cada shot como GIF de 6 fps | `make_shot_gifs.py` | **vps-tools** | Solo necesita ffmpeg. |
| 4 | Generar la lista HTML | `build_shotlist_html.py` | **vps-tools** | Necesita PIL para incrustar las miniaturas. |
| 5 | Publicar la lista y los GIFs | `publish_ftp.py` | **vps-tools** | Ahí vive la credencial FTPS (`/root/.config/ftp/`). |
| 6 | Montaje posterior (receta ffmpeg del edit) | `../build_recipe_from_plan.py` | **vps-projects** | Necesita el mount `/mnt/polaris` y `ffprobe`. |

Los pasos 1–2 corren en la PC porque necesitan el video original; a partir del 3 todo
ocurre en **vps-tools**, así que hay que llevar ahí el video de referencia **y** el
directorio de shots (`intervals.json` + `fNN.jpg`). El paso 6 es otro toolkit
(`scripts/creators/README.md`).

Directorio de trabajo típico (un caso = una carpeta):

```
<caso>/
  ref.mp4                 video de referencia
  shots/
    intervals.json        paso 2
    f01.jpg ... fNN.jpg   paso 2  (un frame por intervalo, en el PUNTO MEDIO)
    sheet.jpg             paso 2  (hoja de contacto para revisar a ojo)
    shotlist.json         escrito a mano a partir de lo que se ve en los frames
    s01.gif ... sNN.gif   paso 3  (uno por toma YA fusionada)
    gifs.json             paso 3  (metadata)
  <caso>_shots.html       paso 4  (se publica junto a shots/)
```

## 1. `transcribe_creator_ref.py` — ASR del video de referencia

```
python transcribe_creator_ref.py <caso> [archivo.mp4]
```

- `<caso>` es la carpeta bajo `creators_research/edits` del NAS; si se omite el archivo,
  toma el único `.mp4` de `<caso>/input`.
- Baja el video del NAS a `D:\staging\<caso>\` y deja `transcript_plain_ja.txt` y
  `transcript_segments_ja.json` (idioma `ja`, faster-whisper `cuda/int8_float16`).
- Las credenciales del NAS llegan como JSON **por stdin** (SSH cifrado); nunca se persisten.
- Requiere el venv `D:\staging\hermes-transcription\venv` con faster-whisper y el modelo
  en `D:\staging\hermes-transcription\model`.

La transcripción sirve para saber **qué dice el creador en cada momento** y así escribir
descripciones de acción útiles en `shotlist.json`.

## 2. `analyze_ref_shots.py` — cortes + un frame por shot

```
python analyze_ref_shots.py <video> <dir_salida> [umbral=0.27]
```

- Detecta los cambios de escena con `select='gt(scene,<umbral>)',showinfo` y arma los
  intervalos (`i`, `start`, `end`, `dur`) más los metadatos del video en `intervals.json`.
- Saca **un `fNN.jpg` por intervalo, en el PUNTO MEDIO del shot**.
- Arma `sheet.jpg`, una hoja de contacto numerada para revisar los cortes a ojo.
- Binarios: `$FFMPEG`/`$FFPROBE` → `D:\staging\creator-av-audit\bin\` → PATH.

En el caso `02_blanket` reproduce exactamente los 26 intervalos del fixture (umbral 0.27,
video de 26.634 s, 720×1280 a 30 fps), incluido el corte falso de 0.033 s del frame 10.

## 3. `make_shot_gifs.py` — un GIF animado por toma

```
python make_shot_gifs.py <video_ref> <dir_shots> <dir_salida_gifs> \
    [ancho=180] [fps=6] [colores=64] [dither=bayer:bayer_scale=3]
```

Receta por defecto (medida y aprobada): **180 px de ancho, 6 fps, 64 colores,
`palettegen`/`paletteuse` con `dither=bayer:bayer_scale=3`, `-loop 0`**. Para las 25 tomas
de `02_blanket` (~26 s) salen **4.09 MB en total** (~90–290 KB por GIF), y el HTML se queda
en ~600 KB.

- Fusiona los cortes falsos (<0.15 s) **igual que el HTML**, así `sNN.gif` es la misma
  toma NN que muestra la página.
- Escribe `gifs.json` con `n`, `fr`, `start`, `end`, `dur`, `file`, `bytes`.
- Sale con código ≠0 si algún GIF falla (no deja huecos en silencio).

## 4. `build_shotlist_html.py` — la lista HTML

```
python build_shotlist_html.py <dir_shots> <salida.html> [caso] [shotlist.json] [prefijo_gifs=shots/]
```

- `<dir_shots>` necesita `intervals.json`, los `fNN.jpg` y (opcional) los `sNN.gif`.
- `shotlist.json` por defecto se busca **dentro de `<dir_shots>`**; se le puede pasar otra
  ruta (p. ej. `shotlist.example.json`).
- `caso` y `prefijo_gifs` tienen valores por defecto (el caso sale del propio JSON).
- Las **miniaturas JPEG van incrustadas en base64** (así el archivo suelto se lee sin
  conexión); los **GIFs NO** (25 GIFs llevarían la página a >10 MB).

Formato de `shotlist.json` (ver `shotlist.example.json`, que trae los datos reales del
caso `02_blanket`: 25 descripciones + 6 grupos):

```json
{
  "case": "02_blanket",
  "by_frame": {
    "1":  {"enc": "Primer plano", "ang": "Cenital", "act": "El peluche en el sillón"},
    "11": {"enc": "Detalle", "act": "Otra cobija: pelo largo gris (comparar)"}
  },
  "groups": [
    {"id": "A", "name": "La cobija", "hint": "presentación, sin manos", "frames": [1, 2, 15]}
  ]
}
```

- `by_frame` y `groups[].frames` van **siempre por índice de frame del ORIGINAL (`fNN`)**.
- `enc` (encuadre) se pinta; `ang` (ángulo) es opcional y se conserva como dato pero no se
  pinta, porque las tarjetas llevan poco texto.

Qué produce el HTML (lo que aprobó Arturo):

- tarjetas **pequeñas** y con **poco texto**: `duración · encuadre` + **una línea** de
  acción, y el **número rojo** (badge) = su lugar en la edición;
- **selector "Agrupado" / "Por orden"** que cambia sin recargar (JS, `innerHTML`);
- cada shot es el **GIF animado** `shots/sNN.gif` (ruta relativa, `loading="lazy"`) con la
  **miniatura JPEG embebida como respaldo** vía `onerror` — si el HTML se abre suelto o el
  GIF no está, se ve igual;
- tema oscuro y responsive (grid `auto-fill`, 880 px máx).

## 5. `publish_ftp.py` — publicar en lemonsushi.com

```
python publish_ftp.py list    [dir_remoto]
python publish_ftp.py put     <archivo_local> <dir_remoto>
python publish_ftp.py putmany <dir_remoto> <archivo_local>...
```

- FTPS explícito (`AUTH TLS` + `PROT P`) contra `lemonsushi.com`, **restringido a**
  `/public_html/uploads/vps2` (cualquier ruta fuera de ahí se rechaza, igual que `..`).
- La credencial sale de `/root/.config/ftp/ftpAccess.txt` (línea 1 usuario, línea 2
  password), abierta con `O_NOFOLLOW` y validando propietario y permisos; **nunca se
  imprime**.
- `put`/`putmany` crean la jerarquía de carpetas, y **verifican releyendo el archivo remoto
  y comparando SHA-256** (`readback=OK`), además de imprimir la URL pública.
- La lista y sus GIFs se publican juntos: el HTML en `<caso>/` y los GIFs en
  `<caso>/shots/` (el HTML los referencia con la ruta relativa `shots/`).

## Pitfalls (aprendidos a golpes en `02_blanket`)

- **Los frames se extraen en el PUNTO MEDIO del shot, no al inicio.** Verificado: el centro
  coincide con lo que realmente se ve en la toma; el primer frame tras el corte es la
  transición y no la representa.
- **No indexar las descripciones por el número ya fusionado.** Un corte falso de 0.03 s
  (el frame 10 de este caso) hace que fusionar renumere los shots y **corre las
  descripciones una toma**: nos pasó que un shot quedó descrito como "celular" donde había
  un **libro**. Las descripciones y los grupos van por `fNN` del original, y por eso el
  frame del corte falso no aparece en `by_frame`.
- **Fusionar los cortes falsos con la misma regla en los dos scripts** (<0.15 s se unen al
  anterior). Si `make_shot_gifs.py` y `build_shotlist_html.py` divergen, `sNN.gif` deja de
  corresponder con la toma NN de la página.
- **Agrupar por tipo de toma** (presentación, persona, detalle, comparación…), no por orden
  de edición: así se graba de corrido sin cambiar de setup cada vez. El número rojo
  conserva el orden de edición dentro de cada grupo.
- **Los GIFs van como archivos aparte**, nunca incrustados en base64 dentro del HTML: 25
  GIFs lo llevan a >10 MB. El HTML se mantiene ligero (~600 KB) con las miniaturas
  embebidas como respaldo.
- **La hoja de contacto no se genera con `ffmpeg -pattern_type glob`**: en algunas builds
  `glob` no está compilado y el comando falla **en silencio** dejando `sheet.jpg` sin
  escribir. Ahora se arma con **PIL** y, si no hay PIL, se cae a ffmpeg **avisando** del
  fallo.
- **Al verificar en Chrome, `canvas.drawImage()` de un GIF animado devuelve siempre el
  primer frame**: no sirve para comprobar que anima. Comprobar con PIL (`n_frames`,
  `info['duration']`, diferencias entre frames) o comparando dos capturas de pantalla.

## Verificación (fixture `02_blanket`)

Regenerado desde el fixture y comparado con la versión publicada aprobada: **25 tomas**,
**6 grupos (A 3 / B 7 / C 5 / D 3 / E 3 / F 4)**, selector de dos modos, y los 25
`s01.gif`…`s25.gif` referenciados por ruta relativa `shots/`. La metadata por toma
(`n`, `fr`, `dur`, `enc`, `ang`, `act`, `gif`, `grp`), `GMETA`, `GORDER` y las 25
miniaturas embebidas salen **byte por byte idénticas** a las del HTML aprobado.
