# ttchop-server 🎬

Servidor de producción de video para ttchop. Maneja los pipelines de Collage y AI Video que antes corrían en n8n.

## Rutas

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/collage/dialogue` | Genera script de voz para ElevenLabs |
| POST | `/collage/create` | Pipeline completo: TTS → LLM recipe → ffmpeg → FTP → Firestore |
| POST | `/ai/prompt` | Genera prompt para Seedance/Veo3 |
| POST | `/ai/generate` | Llama a kie.ai (Veo3 o Seedance) |
| POST | `/ai/callback` | Callback de kie.ai cuando el video está listo → Firestore |
| GET | `/health` | Status del servidor |

## Setup

```bash
git clone https://github.com/pumacamargo/ttchop-server.git
cd ttchop-server
npm install
cp .env.example .env
# Editar .env con tus credenciales
pm2 start server.js --name ttchop-server
```

## Variables de entorno

Ver `.env.example` para la lista completa.

Credenciales necesarias:
- `OPENROUTER_API_KEY` — LLM (Claude Haiku)
- `KIEAI_API_KEY` — generación de video AI
- `ELEVENLABS_API_KEY` — TTS
- `FIREBASE_SERVICE_ACCOUNT` o `FIREBASE_SERVICE_ACCOUNT_PATH` — Admin SDK
- `FTP_HOST / FTP_USER / FTP_PASS` — upload de collages
- `SERVER_URL` — URL pública de este servidor (para callbacks de Seedance)

## Qué quedó en n8n

Los nodos de Gemini se quedan en n8n porque usan el nodo nativo:
- `/ttchop_videoMetaExtractor` — análisis de clips individuales
- `/ttchop_video_dissect` — ya lo consume ttchop-post

## Flujos migrados

### /collage/dialogue → /collage/create (flujo de dos pasos)

Siempre llamar primero a `/collage/dialogue` para obtener el script, revisarlo si es necesario, y luego pasarlo como `dialogue` a `/collage/create`. Nunca llamar a `/collage/create` sin el `dialogue` pre-generado.

```
ttchop-webapp
    → POST /collage/dialogue { product, collageTemplate, language }
    ← { dialogue: "Script de voz generado por el LLM..." }

    (opcional: revisar/editar el script antes de continuar)

    → POST /collage/create { voiceId, dialogue, sessions, ... }
```

**Voice IDs de ElevenLabs:**
| Mercado | Voz | ID |
|---------|-----|----|
| 🇯🇵 JP | Announcer (masculino) | `gU0LNdkMOQCOrPrwtbee` |
| 🇲🇽 MX | Jessica (femenino) | `cgSgspJ2msm6clMCkdW9` |

### /collage/create
```
ttchop-webapp
    → POST /collage/create { voiceId, dialogue, sessions, renderId, product, collageTemplate, language }
    → ElevenLabs TTS → audio.mp3
    → ffprobe → duración del audio
    → LLM → ffmpeg recipe JSON
    → collage_builder.py → collage.mp4
    → FTP upload → URL pública
    → Firestore renders/{renderId} { status, videoUrl }
    ← { status: 'done', videoUrl, renderId }
```

> ⚠️ **`sessions` debe incluir `downloadUrl` en cada video** — el LLM que genera el recipe de ffmpeg necesita la URL HTTPS real para descargar los clips. Pasar solo IDs hace que el LLM invente URLs `gs://` incorrectas.
>
> Formato correcto:
> ```json
> {
>   "sessions": [
>     {
>       "id": "sess_abc123",
>       "videos": [
>         { "id": "vid_xxx", "downloadUrl": "https://firebasestorage.../vid_xxx.mp4?...", "duration": 12.4 },
>         { "id": "vid_yyy", "downloadUrl": "https://firebasestorage.../vid_yyy.mp4?...", "duration": 8.1 }
>       ]
>     }
>   ]
> }
> ```

### /ai/prompt
```
ttchop-webapp
    → POST /ai/prompt { productDescription, aiTemplate, language }
    ← { prompt: "..." }
```

### /ai/generate
```
ttchop-webapp
    → POST /ai/generate { prompt, imageUrl, model: 'veo3'|'seedance', aspectRatio? }
    ← { taskId, ... } (respuesta de kie.ai)
```

### /ai/callback
```
kie.ai (automático cuando Seedance termina)
    → POST /ai/callback { code, data: { taskId, resultJson } }
    → Firestore renders/{taskId} { status: 'done', videoUrl }
    ← { ok: true }
```

## Dependencias del sistema

- Node.js 18+
- Python 3 (para `scripts/collage_builder.py`)
- ffmpeg + ffprobe (para recorte/concat de clips y duración de audio)
- PM2 (producción)

## Puerto

Por defecto: `3002` (configurable via `PORT` en `.env`)
