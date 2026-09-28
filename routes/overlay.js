import { Router } from 'express';
import { createWriteStream, existsSync, unlinkSync } from 'fs';
import { pipeline } from 'stream/promises';
import fetch from 'node-fetch';
import path from 'path';
import { randomBytes } from 'crypto';
import { uploadToStorage } from '../pipeline/storage.js';
import { upsertRender, getRender } from '../pipeline/firestore.js';
import { enqueue } from '../pipeline/jobQueue.js';

const router = Router();
const TEMP_DIR = '/tmp/ttchop_overlay';
const OVERLAY_SERVER = 'http://localhost:3001';

function ensureTempDir() {
  if (!existsSync(TEMP_DIR)) {
    import('child_process').then(({ execSync }) => execSync(`mkdir -p ${TEMP_DIR}`));
  }
}

// POST /overlay/create
// Body: { renderId, product?, videoUrl?, overlayTemplate, mascotSegments?, needsCharacter?, language?, voiceId?, scriptTemplate? }
// Calls overlay-server /render-data, uploads result, updates Firestore
// mascotSegments: opcional — se propaga sin tocar hacia overlay-server /render-data.
// needsCharacter: opcional — si true, al terminar encadena a /character/create (personaje
// animado con Rive) igual que /collage/create encadena aquí con needsOverlay.
// product/videoUrl: opcionales si renderId ya tiene un render de collage guardado —
// se leen de Firestore (videoUrl del collage, inputs.collage.product/language/voiceId).
// Así se puede re-disparar SOLO el overlay mandando nada más { renderId, projectId }.
router.post('/create', async (req, res) => {
  let { renderId, product, videoUrl, overlayTemplate, mascotSegments, needsCharacter = false, language, voiceId, scriptTemplate } = req.body;
  // projectId: a qué proyecto (ttchop / ttchop2) escribir. Si viene encadenado
  // desde /collage/create (_fromCollage), collage.js ya lo propagó en el body.
  const { projectId } = req.body;

  if (!renderId) {
    return res.status(400).json({ error: 'renderId es requerido' });
  }

  // Resumir desde un render existente: si falta product/videoUrl, sacarlos del doc
  // guardado por /collage/create (videoUrl del collage, inputs.collage para lo demás).
  if (!product || !videoUrl) {
    const existing = await getRender(renderId, projectId);
    if (!existing) {
      return res.status(400).json({ error: 'product y videoUrl son requeridos (no hay render previo con ese renderId para resumir)' });
    }
    const savedCollage = existing.inputs?.collage || {};
    // Preferir la URL propia guardada por collage sobre el `videoUrl` de nivel
    // superior del doc — ese campo se sobreescribe con la salida de CADA etapa
    // (incluido el personaje), así que un resume posterior podría componer el
    // overlay sobre un video que ya tiene el personaje pegado encima. Mismo bug
    // de cascada que se arregló en character.js — ver workflow.html.
    videoUrl = videoUrl || savedCollage.videoUrl || existing.videoUrl;
    product = product || savedCollage.product;
    language = language ?? savedCollage.language;
    voiceId = voiceId ?? savedCollage.voiceId;
    mascotSegments = mascotSegments ?? savedCollage.mascotSegments;
    scriptTemplate = scriptTemplate ?? savedCollage.collageTemplate?.content;
  }

  const jobId = randomBytes(6).toString('hex');
  const outPath = path.join(TEMP_DIR, `overlay_${jobId}.mp4`);

  // Create render doc immediately so it appears in Renders tab right away
  // (skip if this is a chained overlay from collage — collage already wrote the doc)
  if (!req.body._fromCollage) {
    await upsertRender({
      taskId: renderId,
      status: 'pending',
      type: 'overlay',
      productId: product?.id || null,
      productName: product?.name || null,
      userId: req.body.userId || null,
      projectId,
      inputs: { overlay: { product, mascotSegments, needsCharacter, language, voiceId, scriptTemplate } },
    });
  } else {
    // Encadenado desde collage — el doc ya existe, solo agregamos inputs.overlay
    // (guardar el resumen por si luego se quiere re-disparar solo esta etapa).
    await upsertRender({
      taskId: renderId,
      status: 'processing',
      projectId,
      inputs: { overlay: { product, mascotSegments, needsCharacter, language, voiceId, scriptTemplate } },
    });
  }

  const queuePos = enqueue(jobId, async () => {
    try {
      if (!existsSync(TEMP_DIR)) {
        const { execSync } = await import('child_process');
        execSync(`mkdir -p ${TEMP_DIR}`);
      }

      const market = product.region === 'mx' ? 'mx' : 'jp';
      console.log(`[${jobId}] Overlay START | renderId: ${renderId} | market: ${market}`);

      const overlayRes = await fetch(`${OVERLAY_SERVER}/render-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrl,
          product: {
            name: product.name,
            description: product.description,
            price: null,
            region: product.region,
          },
          template: 'default',
          market,
          ...(mascotSegments && { mascotSegments }),
        }),
        timeout: 600_000,
      });

      if (!overlayRes.ok) {
        const err = await overlayRes.text();
        throw new Error(`overlay-server error ${overlayRes.status}: ${err.slice(0, 200)}`);
      }

      // Leer headers de base overlay y mascotSegments antes de consumir el body
      const baseOverlayUrl   = overlayRes.headers.get('x-base-overlay-url') || null;
      const mascotSegsHeader = overlayRes.headers.get('x-mascot-segments')  || null;
      let savedMascotSegments = null;
      if (mascotSegsHeader) {
        try { savedMascotSegments = JSON.parse(Buffer.from(mascotSegsHeader, 'base64').toString()); } catch {}
      }

      const fileStream = createWriteStream(outPath);
      await pipeline(overlayRes.body, fileStream);
      console.log(`[${jobId}] Overlay rendered — uploading...`);

      const filename = `overlay_${jobId}.mp4`;
      const publicUrl = await uploadToStorage(outPath, filename, projectId);
      console.log(`[${jobId}] Uploaded: ${publicUrl}`);

      // inputs.overlay.videoUrl: la salida REAL del overlay, guardada aparte del
      // campo `videoUrl` de nivel superior (ese se sobreescribe con la salida del
      // personaje después) — mismo motivo que inputs.collage.videoUrl en collage.js:
      // evita que un resume de /character/create componga sobre un video que ya
      // tiene un personaje pegado encima.
      const overlayInputs = { product, mascotSegments, needsCharacter, language, voiceId, scriptTemplate, videoUrl: publicUrl };
      if (needsCharacter) {
        await upsertRender({
          taskId: renderId,
          status: 'overlay_done',
          videoUrl: publicUrl,
          type: 'collage+overlay+character',
          productId: product?.id || null,
          productName: product?.name || null,
          projectId,
          ...(baseOverlayUrl      && { baseOverlayUrl }),
          ...(savedMascotSegments && { mascotSegments: savedMascotSegments }),
          inputs: { overlay: overlayInputs },
        });
        console.log(`[${jobId}] Overlay done — encadenando /character/create...`);
        fetch('http://localhost:3002/character/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ renderId, product, videoUrl: publicUrl, language, voiceId, projectId, scriptTemplate, _fromOverlay: true }),
        }).then(async r => {
          if (!r.ok) {
            const err = await r.text();
            console.error(`[${jobId}] Character dispatch error: ${err.slice(0, 200)}`);
            await upsertRender({ taskId: renderId, status: 'failed', errorMessage: `Character dispatch failed: ${err.slice(0, 200)}`, projectId });
          }
        }).catch(async err => {
          console.error(`[${jobId}] Character dispatch threw:`, err.message);
          await upsertRender({ taskId: renderId, status: 'failed', errorMessage: `Character dispatch failed: ${err.message}`, projectId });
        });
      } else {
        await upsertRender({
          taskId: renderId,
          status: 'done',
          videoUrl: publicUrl,
          type: 'overlay',
          productId: product?.id || null,
          productName: product?.name || null,
          projectId,
          ...(baseOverlayUrl      && { baseOverlayUrl }),
          ...(savedMascotSegments && { mascotSegments: savedMascotSegments }),
          inputs: { overlay: overlayInputs },
        });
      }

      console.log(`[${jobId}] DONE`);
    } catch (err) {
      console.error(`[${jobId}] ERROR:`, err.message);
      try {
        await upsertRender({
          taskId: renderId,
          status: 'failed',
          errorMessage: err.message,
          type: 'overlay',
          productId: product?.id || null,
          productName: product?.name || null,
          projectId,
        });
      } catch (_) {}
    } finally {
      if (existsSync(outPath)) unlinkSync(outPath);
    }
  });

  res.json({ status: 'pending', renderId, jobId, queuePosition: queuePos });
});

export default router;
