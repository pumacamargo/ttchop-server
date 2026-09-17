import { Router } from 'express';
import { createWriteStream, existsSync, unlinkSync } from 'fs';
import { pipeline } from 'stream/promises';
import fetch from 'node-fetch';
import path from 'path';
import { randomBytes } from 'crypto';
import { uploadToStorage } from '../pipeline/storage.js';
import { upsertRender } from '../pipeline/firestore.js';
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
// Body: { renderId, product, videoUrl, overlayTemplate, mascotSegments? }
// Calls overlay-server /render-data, uploads result, updates Firestore
// mascotSegments: opcional — se propaga sin tocar hacia overlay-server /render-data.
router.post('/create', async (req, res) => {
  const { renderId, product, videoUrl, overlayTemplate, mascotSegments } = req.body;
  // projectId: a qué proyecto (ttchop / ttchop2) escribir. Si viene encadenado
  // desde /collage/create (_fromCollage), collage.js ya lo propagó en el body.
  const { projectId } = req.body;

  if (!renderId || !product || !videoUrl) {
    return res.status(400).json({ error: 'renderId, product y videoUrl son requeridos' });
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

      const fileStream = createWriteStream(outPath);
      await pipeline(overlayRes.body, fileStream);
      console.log(`[${jobId}] Overlay rendered — uploading...`);

      const filename = `overlay_${jobId}.mp4`;
      const publicUrl = await uploadToStorage(outPath, filename, projectId);
      console.log(`[${jobId}] Uploaded: ${publicUrl}`);

      await upsertRender({
        taskId: renderId,
        status: 'done',
        videoUrl: publicUrl,
        type: 'overlay',
        productId: product?.id || null,
        productName: product?.name || null,
        projectId,
      });

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
