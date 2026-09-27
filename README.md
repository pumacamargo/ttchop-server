# ttchop-server 🎬

Servidor de producción de video para ttchop. Maneja los pipelines de Collage y AI Video que antes corrían en n8n.

## Acceso público

| Servidor | URL pública | Puerto |
|----------|-------------|--------|
| ttchop-server (collage) | `https://ttchop-server.lemonsushi.com` | 3002 |
| ttchop-post (overlay) | `https://ttchop-post.lemonsushi.com` | 3001 |

Ambos están detrás de nginx con Cloudflare SSL flexible (HTTPS → HTTP al origen). No requieren autenticación adicional desde la red pública.

## Rutas

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/collage/dialogue` | Genera script de voz para ElevenLabs |
| POST | `/collage/create` | Pipeline completo: TTS → LLM recipe → ffmpeg → FTP → Firestore |
| POST | `/overlay/create` | Encola overlay Remotion a ttchop-post |
| POST | `/character/create` | Encola render de personaje animado (lip-sync) |
| POST | `/ai/prompt` | Genera prompt para Seedance/Veo3 |
| POST | `/ai/generate` | Llama a kie.ai (Veo3 o Seedance) |
| POST | `/ai/callback` | Callback de kie.ai cuando el video está listo → Firestore |
| GET | `/health` | Status del servidor |

---

## Guía completa de producción de video

El pipeline tiene tres etapas encadenadas. Cada una puede llamarse de forma independiente o en secuencia.

### Etapa 1 — Collage (ttchop-server:3002)

#### Paso 1: generar el script de voz

```
POST https://ttchop-server.lemonsushi.com/collage/dialogue
```

```json
{
  "product": {
    "id": "prod_xxx",
    "name": "Nombre del producto",
    "description": "Descripción del producto",
    "price": 2980,
    "region": "jp"
  },
  "collageTemplate": "default",
  "language": "jp"
}
```

Respuesta:
```json
{ "dialogue": "Script de voz generado por el LLM..." }
```

> Siempre llamar primero a `/collage/dialogue`. Revisar el script antes de continuar — se puede editar antes de pasarlo al siguiente paso.

**Voice IDs de ElevenLabs:**
| Mercado | Voz | ID |
|---------|-----|----|
| 🇯🇵 JP | Announcer (masculino) | `gU0LNdkMOQCOrPrwtbee` |
| 🇲🇽 MX | Jessica (femenino) | `cgSgspJ2msm6clMCkdW9` |

---

#### Paso 2: crear el collage

```
POST https://ttchop-server.lemonsushi.com/collage/create
```

```json
{
  "renderId": "mi_video_001",
  "voiceId": "gU0LNdkMOQCOrPrwtbee",
  "dialogue": "Script revisado del paso anterior...",
  "language": "jp",
  "collageTemplate": "default",
  "projectId": "ttchop2",
  "product": {
    "id": "prod_xxx",
    "name": "Nombre del producto",
    "description": "Descripción",
    "price": 2980,
    "region": "jp"
  },
  "sessions": [
    {
      "id": "sess_abc123",
      "videos": [
        {
          "id": "vid_001",
          "downloadUrl": "https://firebasestorage.googleapis.com/.../vid_001.mp4?token=...",
          "duration": 12.4
        },
        {
          "id": "vid_002",
          "downloadUrl": "https://firebasestorage.googleapis.com/.../vid_002.mp4?token=...",
          "duration": 8.1
        }
      ]
    }
  ],
  "needsOverlay": true
}
```

> ⚠️ **`sessions` debe incluir `downloadUrl` en cada video** — el LLM que genera el recipe de ffmpeg necesita la URL HTTPS real. Pasar solo IDs hace que el LLM invente URLs `gs://` incorrectas.

> Parámetro opcional `needsOverlay: true`: al terminar el collage, encola automáticamente un job de overlay con el mismo `renderId`. También acepta `overlayTemplateId` opcional.

Respuesta:
```json
{
  "status": "done",
  "videoUrl": "https://lemonsushi.com/.../collage.mp4",
  "renderId": "mi_video_001"
}
```

Pipeline interno:
```
ElevenLabs TTS → audio.mp3
→ ffprobe → duración del audio
→ LLM (Claude Haiku) → ffmpeg recipe JSON
→ collage_builder.py → collage.mp4
→ FTP upload → URL pública
→ Firestore renders/{renderId} { status, videoUrl }
```

---

### Etapa 2 — Overlay (ttchop-post:3001)

Toma el `videoUrl` del collage y le agrega animación Remotion (hook, features, precio, CTA).

#### Opción A: vía ttchop-server (encadenado)

```
POST https://ttchop-server.lemonsushi.com/overlay/create
```

```json
{
  "renderId": "mi_video_001",
  "videoUrl": "https://lemonsushi.com/.../collage.mp4",
  "product": {
    "id": "prod_xxx",
    "name": "Nombre del producto",
    "description": "Descripción",
    "price": 2980,
    "region": "jp"
  },
  "overlayTemplate": "default",
  "language": "jp",
  "projectId": "ttchop2",
  "userId": "fYRxZIHDPLem3mJRmytjqfsEU9n2"
}
```

#### Opción B: directo a ttchop-post

```
POST https://ttchop-post.lemonsushi.com/render-data
```

```json
{
  "videoUrl": "https://lemonsushi.com/.../collage.mp4",
  "product": {
    "id": "prod_xxx",
    "name": "Nombre del producto",
    "description": "Descripción",
    "price": 2980,
    "region": "jp"
  },
  "market": "jp"
}
```

Response: stream MP4 directo (guardar con `curl -o output_overlay.mp4`).

**Reglas de overlay (template `default`):**
- Hook JP: máx 10 chars por línea
- Hook ES: máx 22 chars por línea
- Estructura: Hook (0–3.5s) → Features (4 items) → FloatingReviews → FOMO → CTA con precio
- Nunca inventar descuentos: usar solo datos reales del producto

---

### Etapa 3 — Personaje animado (ttchop-server:3002)

Agrega un personaje 2D con lip-sync sobre el video con overlay. Requiere tener el `videoUrl` del paso de overlay.

```
POST https://ttchop-server.lemonsushi.com/character/create
```

```json
{
  "renderId": "mi_video_001",
  "projectId": "ttchop2",
  "userId": "fYRxZIHDPLem3mJRmytjqfsEU9n2",
  "videoUrl": "https://.../overlay.mp4",
  "product": {
    "id": "prod_xxx",
    "name": "Nombre del producto",
    "description": "Descripción",
    "price": 2980,
    "region": "jp"
  },
  "language": "jp",
  "voiceId": "gU0LNdkMOQCOrPrwtbee"
}
```

Parámetros opcionales:
- `scriptTemplate` — plantilla del guion del personaje
- `dialogueText` — si se proporciona, extrae el audio real del video base para Rhubarb lip-sync en lugar de re-sintetizar (evita desincronía de labios)

> Re-trigger si ya existe un render previo en Firestore:
> ```json
> { "renderId": "mi_video_001", "projectId": "ttchop2" }
> ```

---

### Thumbnail

```bash
python3 /root/projects/ttchop/ttchop-server/scripts/thumbnail_maker.py \
  --product-id prod_xxx --language en
```

Output: `/tmp/thumbnail_prod_xxx_en.jpg`

> El texto de thumbnails siempre en inglés, independientemente del mercado del video.
> La imagen se saca del collage base, nunca del overlay (los gráficos tapan el frame).

---

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

## Qué quedó en n8n

Los nodos de Gemini se quedan en n8n porque usan el nodo nativo:
- `/ttchop_videoMetaExtractor` — análisis de clips individuales
- `/ttchop_video_dissect` — ya lo consume ttchop-post

## AI Video (Veo3 / Seedance)

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
