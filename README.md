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

## Soporte multi-proyecto (ttchop / ttchop2)

Este servidor atiende dos apps que usan proyectos de Firebase distintos: `ttchop`
(original) y `ttchop2` (nueva). Cómo se elige a cuál escribir:

- Las rutas `/collage/create`, `/overlay/create`, `/ai/generate` y `/speedramp/create`
  leen `projectId` del body. Si viene `"ttchop2"` (y hay credenciales configuradas
  para ese proyecto), el render y el archivo subido a Storage van al Firestore/Storage
  de ttchop2.
- Si `projectId` no viene, viene vacío, o viene con un valor no reconocido, se usa
  **siempre** el proyecto por defecto (`ttchop`) — el comportamiento de siempre, sin
  cambios. Esto es intencional: la app original (`ttchop`) nunca manda `projectId` y
  no se va a actualizar.
- `/ai/callback` lo llama kie.ai directamente y no puede mandar `projectId`. Para
  saber a qué proyecto pertenece el render, el servidor busca el documento
  `renders/{taskId}` en cada proyecto configurado y actualiza donde lo encuentre; si
  no aparece en ninguno, cae al proyecto por defecto.
- El scheduler (`pipeline/scheduler.js`) sondea el Firestore de **todos** los
  proyectos configurados cada 60s, cada uno de forma independiente (un fallo en un
  proyecto no detiene el sondeo de los demás).

Credenciales necesarias por proyecto (ver `.env.example`):
- **ttchop** (default): `FIREBASE_SERVICE_ACCOUNT` / `FIREBASE_SERVICE_ACCOUNT_PATH` + `FIREBASE_STORAGE_BUCKET`
- **ttchop2** (opcional): `FIREBASE_SERVICE_ACCOUNT_TTCHOP2` / `FIREBASE_SERVICE_ACCOUNT_PATH_TTCHOP2` + `FIREBASE_STORAGE_BUCKET_TTCHOP2`

Sin las variables de ttchop2, el servidor funciona exactamente igual que antes de
este soporte multi-proyecto: todo se escribe en ttchop.

## Dependencias del sistema

- Node.js 18+
- Python 3 (para `scripts/collage_builder.py`)
- ffmpeg + ffprobe (para recorte/concat de clips y duración de audio)
- PM2 (producción)

## Puerto

Por defecto: `3002` (configurable via `PORT` en `.env`)

## Cambios 2026-08-06

### /ai/generate — correcciones de formato kie.ai

- **Veo3** (`/veo/generate`): campo `imageUrls` (array, no `imageUrl` singular) — verificado contra el workflow de n8n. Solo la primera imagen se usa.
- **Seedance** (`/jobs/createTask`): campo `reference_image_urls: [images[0]]` — una sola imagen en array. Antes se pasaban todas las imágenes del producto lo que causaba error 422 "Up to 9 images can be uploaded".
- **Error detection**: kie.ai responde HTTP 200 incluso para errores — ahora se verifica `data.code !== 200` y se propaga el error correctamente al cliente.
- **Veo3 payload**: quitados `enableTranslation` y `generationType` (no los manda n8n, causaban rechazo).
- Logging agregado: `[kieai] Veo3 response:` / `[kieai] Seedance response:` en consola.

### /collage/create — encadenamiento con overlay

Nuevo parámetro opcional `needsOverlay: true` en el body. Cuando está activo, al terminar el collage automáticamente encola un job de overlay en ttchop-post con el mismo `renderId`. También acepta `overlayTemplateId` opcional.

### /collage routes — fix status

`status` en Firestore al iniciar un job es ahora `'processing'` (antes `'running'`). El campo `'running'` no era un valor válido para el `StatusBadge` del frontend y causaba crash en la pestaña Renders.
