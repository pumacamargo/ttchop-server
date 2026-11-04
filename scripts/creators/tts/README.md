# scripts/creators/tts — voz de las líneas con el TTS del server

Genera la voz del guion de un caso de creador con el TTS del propio
`ttchop-server` (`pipeline/elevenlabs.js`, ElevenLabs **eleven_v3**): una toma
por línea. Es el paso de voz previo al montaje (la receta con
`build_recipe_from_plan.py` espera el audio ya listo).

Antes era un one-off suelto en `/root/tts_lines.mjs` de vps-projects y se perdía;
aquí vive versionado.

## Dónde corre

**vps-projects**, porque necesita el `node_modules` del repo: `pipeline/elevenlabs.js`
importa `node-fetch`, y además lee la API key de `ttchop-server/.env`.

## Uso

```
node tts_lines.mjs <lines.json> <dir_salida> [voiceId]
```

- `<lines.json>` — array JSON de strings (una línea de guion por elemento).
- `<dir_salida>` — directorio de trabajo; escribe `line_01.mp3`, `line_02.mp3`, ...
- `[voiceId]` — id de voz de ElevenLabs; por defecto **PumaVoice01**
  (`ve7BOdejheJbgrBriBx4`).

Ejemplo:

```
cd /root/projects/ttchop/ttchop-server
node scripts/creators/tts/tts_lines.mjs lines.json /tmp/tts_out
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 /tmp/tts_out/line_01.mp3
```

Funciona invocándolo desde cualquier `cwd`: la raíz del repo se resuelve a partir
de la ruta del propio script. La API key se lee de `.env` y **nunca se imprime**.

## Media

**No se commitea media.** Los `.mp3` se escriben en el `dir_salida` que le pases
(usa un directorio de trabajo temporal o del caso, nunca dentro del repo).
