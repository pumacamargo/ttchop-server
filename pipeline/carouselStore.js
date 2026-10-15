import { getDb, getConfiguredProjects } from './firebase.js';
import { randomBytes } from 'crypto';
import { planCarouselAssetIngestion } from './carouselAssetIngestionPlan.js';
import { stageCarouselAssetWrites, carouselAssetDocumentId } from './carouselAssetTransaction.js';

const COLLECTION = 'carousels';

export function newCarouselId() {
  return `car_${randomBytes(8).toString('hex')}`;
}

// Token por carrusel para el callback de kie.ai (plan TTC-55 §7) — nunca se manda
// al cliente, solo viaja en la callBackUrl que kie.ai llama server-to-server.
export function newCallbackToken() {
  return randomBytes(16).toString('hex');
}

export async function createCarousel(projectId, carousel) {
  const db = getDb(projectId);
  const now = new Date().toISOString();
  await db.collection(COLLECTION).doc(carousel.id).set({ ...carousel, createdAt: now, updatedAt: now });
  return carousel.id;
}

export async function getCarousel(projectId, carouselId) {
  const db = getDb(projectId);
  const snap = await db.collection(COLLECTION).doc(carouselId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

// Lee un carousel_script/carousel_style por id de la colección `templates` (plan
// TTC-55 §4: "El server lee los templates por id y guarda un snapshot" — Fase 3).
// Misma colección que usa webapp2, mismo proyecto que el carrusel (projectId).
export async function getTemplateById(projectId, templateId) {
  const db = getDb(projectId);
  const snap = await db.collection('templates').doc(templateId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

// callbackToken nunca se manda al cliente (regla no negociable del plan TTC-55 §4).
export function toPublicCarousel(carousel) {
  if (!carousel) return null;
  const { callbackToken, ...rest } = carousel;
  return rest;
}

export async function recordSubmittedImageTasks(projectId, carouselId, submissions, { db = getDb(projectId) } = {}) {
  const ref = db.collection(COLLECTION).doc(carouselId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error(`Carousel ${carouselId} not found`);
    const data = snap.data();
    const tasks = { ...(data.kieTasks || {}) }, prompts = { ...(data.imageTaskPrompts || {}) };
    const slides = (data.slides || []).map(s => ({ ...s }));
    let credits = 0;
    let changed = false;
    for (const item of submissions) {
      const prior = prompts[item.taskId];
      if (prior !== undefined && (typeof prior !== 'object' || prior.prompt !== item.prompt || prior.slot !== item.slot || JSON.stringify(prior.slots) !== JSON.stringify(item.slots) || JSON.stringify(prior.imagePrompts) !== JSON.stringify(item.imagePrompts))) throw new Error(`Conflicting attribution for image task ${item.taskId}`);
      if (tasks[item.taskId] !== undefined && tasks[item.taskId] !== item.slot) throw new Error(`Conflicting slot for image task ${item.taskId}`);
      const fresh = prior === undefined;
      if (fresh) {
        prompts[item.taskId] = { taskId: item.taskId, slot: item.slot, slots: [...item.slots], prompt: item.prompt, imagePrompts: item.imagePrompts.map(p => ({ ...p })), submittedAt: new Date().toISOString() };
        changed = true;
      }
      tasks[item.taskId] = item.slot;
      if (!fresh) continue;
      credits += item.creditsEstimate;
      for (const u of item.slideUpdates) { const i = slides.findIndex(s => s.index === u.index); if (i >= 0 && slides[i].bg?.taskId !== item.taskId) slides[i].bg = u.bg; }
    }
    if (changed) tx.set(ref, { slides, kieTasks: tasks, imageTaskPrompts: prompts, cost: { ...(data.cost || {}), credits: (data.cost?.credits || 0) + credits }, updatedAt: new Date().toISOString() }, { merge: true });
    return { kieTasks: tasks, creditsEstimate: credits };
  });
}

export async function updateCarousel(projectId, carouselId, patch) {
  const db = getDb(projectId);
  await db.collection(COLLECTION).doc(carouselId).set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true });
}

// Pure preflight shared by the network resolver and the committing transaction.
// An attributed batch is indivisible: a displaced member invalidates the whole task.
export function backgroundTaskSlots(carousel, taskId, slot) {
  const attribution = carousel?.imageTaskPrompts?.[taskId];
  const indices = attribution?.slots;
  if (!taskId || !Array.isArray(indices) || indices.length === 0 ||
      attribution.slot !== slot || (slot !== 'batch' &&
      (indices.length !== 1 || String(indices[0]) !== slot)) ||
      new Set(indices).size !== indices.length ||
      indices.some(i => !Number.isInteger(i) || i < 0 ||
        !attribution.imagePrompts?.some(p => p.index === i))) {
    return { ok: false, reason: 'stale_task' };
  }
  const slides = carousel?.slides || [];
  const targets = indices.map(index => slides.findIndex(s => s.index === index));
  if (targets.some(i => i < 0 || slides[i].bg?.taskId !== taskId) ||
      new Set(targets).size !== targets.length) return { ok: false, reason: 'stale_task' };
  return { ok: true, targets };
}

// Background completion and composition transition commit in one transaction.
export async function completeBackgroundTask(projectId, carouselId, { taskId, slot, urls, storagePaths }, options = {}) {
  // getDb silently falls back to ttchop on an unknown project: never request it here.
  if (projectId !== 'ttchop2') throw new Error('Carousel assets require project ttchop2');
  if (!options.db && !getConfiguredProjects().includes(projectId)) throw new Error('Missing ttchop2 Firebase credentials');
  const db = options.db ?? getDb(projectId);
  const ref = db.collection(COLLECTION).doc(carouselId);

  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: 'not_found' };
    const data = snap.data();
    if (data.projectId !== projectId || (data.id && data.id !== carouselId)) throw new Error('Carousel project or identity mismatch');
    const checked = backgroundTaskSlots(data, taskId, slot);
    if (!checked.ok) return checked;
    const slides = (data.slides || []).map(s => ({ ...s }));
    const { targets } = checked;
    const alreadyDone = targets.every(i => slides[i].bg?.status === 'done');
    if (!alreadyDone && (!Array.isArray(urls) || !Array.isArray(storagePaths) ||
        urls.length !== targets.length || storagePaths.length !== targets.length ||
        urls.some(u => typeof u !== 'string' || !u.trim()) ||
        storagePaths.some(p => typeof p !== 'string' || !p.trim()))) {
      return { ok: false, reason: 'result_count_mismatch' };
    }
    // Do not replace a completed background, even when another callback raced us.
    if (!alreadyDone) targets.forEach((i, k) => {
      if (slides[i].bg?.status !== 'done') slides[i].bg = {
        ...slides[i].bg, taskId, status: 'done', url: urls[k], storagePath: storagePaths[k],
        attempts: (slides[i].bg?.attempts || 0) + 1,
      };
    });
    const allDone = slides.every(s => s.bg?.status === 'done');
    const startedComposing = !alreadyDone && allDone && data.status === 'generating_images';
    if (!alreadyDone) {
      const update = { slides, updatedAt: new Date().toISOString() };
      if (startedComposing) update.status = 'composing';
      tx.set(ref, update, { merge: true });
    }
    return { ok: true, alreadyDone, allDone, startedComposing };
  });
}

export async function failBackgroundTask(projectId, carouselId, { taskId, slot, errorMessage }, options = {}) {
  if (projectId !== 'ttchop2') throw new Error('Carousel assets require project ttchop2');
  if (!options.db && !getConfiguredProjects().includes(projectId)) throw new Error('Missing ttchop2 Firebase credentials');
  const db = options.db ?? getDb(projectId);
  const ref = db.collection(COLLECTION).doc(carouselId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: 'not_found' };
    const data = snap.data();
    if (data.projectId !== projectId || (data.id && data.id !== carouselId)) throw new Error('Carousel project or identity mismatch');
    const checked = backgroundTaskSlots(data, taskId, slot);
    if (!checked.ok) return checked;
    const slides = (data.slides || []).map(s => ({ ...s }));
    const targetIdxs = checked.targets;

    // Idempotente: no pisar un slot que ya quedó "done" con una falla tardía duplicada.
    const anyAlreadyDone = targetIdxs.some(i => slides[i].bg?.status === 'done');
    if (anyAlreadyDone) return { ok: true, alreadyDone: true, startedComposing: false };

    targetIdxs.forEach(i => {
      slides[i].bg = { ...slides[i].bg, status: 'failed' };
      slides[i].error = errorMessage;
    });

    tx.set(ref, { slides, updatedAt: new Date().toISOString() }, { merge: true });
    return { ok: true, alreadyDone: false, startedComposing: false };
  });
}
