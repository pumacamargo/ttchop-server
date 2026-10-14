import { getDb } from './firebase.js';
import { randomBytes } from 'crypto';

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

export async function updateCarousel(projectId, carouselId, patch) {
  const db = getDb(projectId);
  await db.collection(COLLECTION).doc(carouselId).set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true });
}

// Transacción idempotente (plan TTC-55 §7): si kie.ai reintenta el callback, o si
// el sweep de pipeline/scheduler.js recupera la misma tarea más tarde, un taskId
// que ya quedó "done" en sus slots no vuelve a escribir ni a disparar composición.
// `slot` es un índice de slide (tarea de 1 imagen) o el literal 'batch' (tarea con
// max_images>1 — los slides que le pertenecen se identifican por bg.taskId===taskId,
// seteado antes de llamar a kie en pipeline/carouselImages.js:submitImageBatches).
export async function completeBackgroundTask(projectId, carouselId, { taskId, slot, urls, storagePaths }) {
  const db = getDb(projectId);
  const ref = db.collection(COLLECTION).doc(carouselId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: 'not_found' };
    const data = snap.data();
    const slides = (data.slides || []).map(s => ({ ...s }));

    let targetIdxs;
    if (slot === 'batch') {
      targetIdxs = slides
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.bg?.taskId === taskId)
        .sort((a, b) => a.s.index - b.s.index)
        .map(({ i }) => i);
    } else {
      const i = slides.findIndex(s => s.index === Number(slot));
      targetIdxs = i === -1 ? [] : [i];
    }

    if (targetIdxs.length === 0) return { ok: false, reason: 'slot_not_found' };

    const alreadyDone = targetIdxs.every(i => slides[i].bg?.status === 'done' && slides[i].bg?.taskId === taskId);
    if (alreadyDone) {
      return { ok: true, alreadyDone: true, allDone: slides.every(s => s.bg?.status === 'done'), startedComposing: false };
    }

    targetIdxs.forEach((i, k) => {
      slides[i].bg = {
        taskId,
        status: 'done',
        url: urls[k] ?? urls[0],
        storagePath: storagePaths[k] ?? storagePaths[0],
        attempts: (slides[i].bg?.attempts || 0) + 1,
      };
    });

    const allDone = slides.every(s => s.bg?.status === 'done');
    const update = { slides, updatedAt: new Date().toISOString() };
    // Solo la transacción que gana la carrera de completar el ÚLTIMO slot cambia el
    // status — así la composición se encola exactamente una vez (plan TTC-55 §7).
    const startedComposing = allDone && data.status === 'generating_images';
    if (startedComposing) update.status = 'composing';

    tx.set(ref, update, { merge: true });
    return { ok: true, alreadyDone: false, allDone, startedComposing };
  });
}

export async function failBackgroundTask(projectId, carouselId, { taskId, slot, errorMessage }) {
  const db = getDb(projectId);
  const ref = db.collection(COLLECTION).doc(carouselId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: 'not_found' };
    const data = snap.data();
    const slides = (data.slides || []).map(s => ({ ...s }));

    const targetIdxs = slot === 'batch'
      ? slides.map((s, i) => ({ s, i })).filter(({ s }) => s.bg?.taskId === taskId).map(({ i }) => i)
      : (() => { const i = slides.findIndex(s => s.index === Number(slot)); return i === -1 ? [] : [i]; })();

    if (targetIdxs.length === 0) return { ok: false, reason: 'slot_not_found' };

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
