import fetch from 'node-fetch';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { generateImage, getTaskRecord, maxBatchForModel, creditsPerImageForModel } from './kieai.js';
import { uploadFileToStorage } from './storage.js';
import { getCarousel, updateCarousel, completeBackgroundTask, failBackgroundTask } from './carouselStore.js';

const TMP_DIR = '/tmp/ttchop_carousel';

const DEFAULT_NEGATIVE =
  'photorealistic photo, no text, no typography, no letters, no words, no signage, no logos, no watermarks, not an illustration, not 3D render';

function serverUrl() {
  return process.env.SERVER_URL || 'http://localhost:3002';
}

function postServerUrl() {
  return process.env.TTCHOP_POST_URL || 'http://localhost:3001';
}

// Agrupa los slides a pedir en lotes de hasta `maxBatch` (6 para Seedream, 1 para
// los demás — ver maxBatchForModel en kieai.js). Cada lote = 1 sola tarea de kie.
export function buildBatches(slides, maxBatch) {
  const batches = [];
  for (let i = 0; i < slides.length; i += maxBatch) {
    batches.push(slides.slice(i, i + maxBatch));
  }
  return batches;
}

// Para batches >1, Seedream solo respeta max_images si el conteo también está
// explícito en el prompt (confirmado en el spike de la Fase 0, ver comentario en
// TTC-56) — por eso se enumera "Image N: ..." por slide dentro del mismo prompt.
function buildBatchPrompt(batch, styleTemplate) {
  const visualBible = styleTemplate.visualBible || '';
  const negative = styleTemplate.negative || DEFAULT_NEGATIVE;

  if (batch.length === 1) {
    return `${visualBible} ${batch[0].imagePrompt} Negative: ${negative}`.trim();
  }

  const enumerated = batch.map((s, i) => `Image ${i + 1}: ${s.imagePrompt}`).join(' ');
  return (
    `Generate exactly ${batch.length} separate images, same visual style and color palette across all of them. ` +
    `${visualBible} ${enumerated} Negative (apply to all): ${negative}`
  ).trim();
}

// Manda a kie.ai las tareas de imagen para `targetSlides` (o todos los slides del
// carrusel si no se pasa). SIEMPRE relee el carrusel completo antes de escribir el
// patch final, para no pisar slides que no están en este lote (clave para que
// /carousel/:id/regenerate con what=image, que solo reenvía algunos slots, no borre
// el resto del arreglo `slides`).
export async function submitImageBatches({ projectId, carouselId, carousel, targetSlides }) {
  const { imageModel, styleTemplate, seed, callbackToken } = carousel;
  const maxBatch = maxBatchForModel(imageModel);
  const slidesToSubmit = targetSlides || carousel.slides;
  const batches = buildBatches(slidesToSubmit, maxBatch);

  const kieTasks = {};
  const bgUpdates = {};
  let creditsEstimate = 0;

  for (const batch of batches) {
    const n = batch.length;
    const prompt = buildBatchPrompt(batch, styleTemplate);
    const slotParam = n > 1 ? 'batch' : String(batch[0].index);
    const callBackUrl = `${serverUrl()}/carousel/callback?c=${carouselId}&p=${encodeURIComponent(projectId)}&slot=${slotParam}&t=${callbackToken}`;

    const res = await generateImage({ imageModel, prompt, n, seed, callBackUrl });
    const taskId = res?.data?.taskId;
    if (!taskId) throw new Error(`kie.ai no devolvió taskId para un lote de ${n} slide(s)`);

    kieTasks[taskId] = slotParam;
    creditsEstimate += creditsPerImageForModel(imageModel) * n;

    const startedAt = new Date().toISOString();
    for (const s of batch) {
      bgUpdates[s.index] = { taskId, status: 'pending', attempts: (s.bg?.attempts || 0) + 1, startedAt };
    }
  }

  const fullCarousel = await getCarousel(projectId, carouselId);
  const slides = fullCarousel.slides.map(s => (bgUpdates[s.index] ? { ...s, bg: bgUpdates[s.index] } : s));

  await updateCarousel(projectId, carouselId, {
    slides,
    kieTasks: { ...(fullCarousel.kieTasks || {}), ...kieTasks },
    cost: { ...(fullCarousel.cost || {}), credits: (fullCarousel.cost?.credits || 0) + creditsEstimate },
  });

  return { kieTasks, creditsEstimate };
}

async function downloadToTmp(url, filename) {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  const destPath = path.join(TMP_DIR, filename);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error descargando imagen de kie.ai: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
  return destPath;
}

function extractResultUrls(record) {
  const data = record?.data || {};
  if (data.resultJson) {
    try {
      const parsed = JSON.parse(data.resultJson);
      if (Array.isArray(parsed.resultUrls)) return parsed.resultUrls;
    } catch {
      // cae al siguiente intento de extracción
    }
  }
  if (Array.isArray(data.response?.resultUrls)) return data.response.resultUrls;
  return [];
}

// Re-verifica una tarea de kie contra /recordInfo (plan TTC-55 §7: "no se confía en
// el body del callback"), descarga cada resultUrl y la vuelve a subir a Firebase
// Storage (las URLs de kie son temporales — plan §0.4). Usado tanto por el callback
// HTTP (routes/carousel.js) como por el sweep (pipeline/scheduler.js); la escritura
// final en Firestore es la misma transacción idempotente en los dos casos, así que
// nunca se duplican entre sí aunque ambos caminos corran para la misma tarea.
export async function resolveKieTask({ projectId, carouselId, taskId, slot }) {
  // Short-circuit antes de pegarle a kie.ai o re-descargar nada: si un callback
  // duplicado (kie reintenta) o el sweep ya encontraron este taskId resuelto, no
  // hay nada que hacer. Evita re-descargar/re-subir imágenes a Storage en cada
  // reintento — la idempotencia de completeBackgroundTask ya cubre la corrección,
  // esto solo evita el trabajo de red redundante.
  const existing = await getCarousel(projectId, carouselId);
  if (existing) {
    const relevant = existing.slides.filter(s => s.bg?.taskId === taskId);
    if (relevant.length > 0 && relevant.every(s => s.bg?.status === 'done')) {
      return { ok: true, failed: false, startedComposing: false, result: { ok: true, alreadyDone: true, allDone: existing.slides.every(s => s.bg?.status === 'done') } };
    }
  }

  const record = await getTaskRecord(taskId);
  const state = record?.data?.state;

  if (state === 'fail') {
    const failMsg = record?.data?.failMsg || 'kie.ai image generation failed';
    const result = await failBackgroundTask(projectId, carouselId, { taskId, slot, errorMessage: failMsg });
    return { ok: true, failed: true, startedComposing: false, result };
  }

  if (state !== 'success') {
    // Todavía procesando (o estado desconocido) — no hacer nada, el sweep reintenta.
    return { ok: true, pending: true, startedComposing: false };
  }

  const resultUrls = extractResultUrls(record);
  if (resultUrls.length === 0) {
    const result = await failBackgroundTask(projectId, carouselId, { taskId, slot, errorMessage: 'kie.ai success sin resultUrls' });
    return { ok: true, failed: true, startedComposing: false, result };
  }

  const uploadedUrls = [];
  const storagePaths = [];
  for (let i = 0; i < resultUrls.length; i++) {
    const localPath = await downloadToTmp(resultUrls[i], `${carouselId}_${taskId}_${i}.png`);
    const storagePath = `carousels/${carouselId}/bg_${slot === 'batch' ? `batch_${taskId}_${i}` : slot}.png`;
    const firebaseUrl = await uploadFileToStorage(localPath, storagePath, 'image/png', projectId);
    uploadedUrls.push(firebaseUrl);
    storagePaths.push(storagePath);
    try { unlinkSync(localPath); } catch {}
  }

  const result = await completeBackgroundTask(projectId, carouselId, { taskId, slot, urls: uploadedUrls, storagePaths });
  if (result.startedComposing) {
    triggerComposition({ projectId, carouselId }).catch(err => {
      console.error(`[carousel] [${carouselId}] triggerComposition error:`, err.message);
    });
  }
  return { ok: true, failed: false, startedComposing: !!result.startedComposing, result };
}

// Encola la composición en ttchop-post (:3001, Fase 2). Si el endpoint todavía no
// existe o la llamada falla, el carrusel se queda en status=composing sin romper
// nada — /carousel/:id/regenerate con what=compose lo puede reintentar luego.
export async function triggerComposition({ projectId, carouselId }) {
  const carousel = await getCarousel(projectId, carouselId);
  if (!carousel) return;

  const slides = (carousel.slides || [])
    .slice()
    .sort((a, b) => a.index - b.index)
    .map(s => ({ index: s.index, bgUrl: s.bg?.url, text: s.text, role: s.role }));

  try {
    const res = await fetch(`${postServerUrl()}/carousel/render-slides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: carouselId, width: 1080, height: 1920, slides, style: carousel.styleTemplate?.snapshot || carousel.styleTemplate }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`ttchop-post /carousel/render-slides error ${res.status}: ${err.slice(0, 300)}`);
    }

    // ttchop-post devuelve un ZIP binario (slide_{index}.png por cada slide) — NO
    // sube a Storage por sí mismo, porque no sabe a qué proyecto (ttchop/ttchop2)
    // pertenece el carrusel. ttchop-server desempaqueta y sube cada archivo con el
    // mismo uploadFileToStorage(projectId) ya probado en la Fase 1.
    const zipBuffer = Buffer.from(await res.arrayBuffer());
    if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
    const zipPath = path.join(TMP_DIR, `${carouselId}_package.zip`);
    writeFileSync(zipPath, zipBuffer);

    const zip = new AdmZip(zipPath);
    const files = [];
    for (const entry of zip.getEntries()) {
      const match = entry.entryName.match(/^slide_(\d+)\.png$/);
      if (!match) continue;
      const index = Number(match[1]);
      const localPath = path.join(TMP_DIR, `${carouselId}_${entry.entryName}`);
      writeFileSync(localPath, entry.getData());
      const storagePath = `carousels/${carouselId}/final/slide_${index}.png`;
      const url = await uploadFileToStorage(localPath, storagePath, 'image/png', projectId);
      files.push({ index, url, storagePath });
      try { unlinkSync(localPath); } catch {}
    }

    const zipStoragePath = `carousels/${carouselId}/package.zip`;
    const packageZipUrl = await uploadFileToStorage(zipPath, zipStoragePath, 'application/zip', projectId);
    try { unlinkSync(zipPath); } catch {}

    await handleComposed({ projectId, carouselId, files, packageZipUrl });
  } catch (err) {
    console.error(`[carousel] [${carouselId}] composición falló (reintentable con /regenerate what=compose):`, err.message);
    await updateCarousel(projectId, carouselId, { errorMessage: `Composición pendiente: ${err.message}` });
  }
}

async function handleComposed({ projectId, carouselId, files, packageZipUrl }) {
  const carousel = await getCarousel(projectId, carouselId);
  if (!carousel) return;
  const slides = carousel.slides.map(s => {
    const file = files.find(f => f.index === s.index);
    return file ? { ...s, final: { url: file.url, storagePath: file.storagePath } } : s;
  });
  await updateCarousel(projectId, carouselId, {
    slides,
    status: 'ready',
    packageZipUrl: packageZipUrl || null,
    errorMessage: null,
  });
}
