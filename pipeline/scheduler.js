import { getDb, getConfiguredProjects } from './firebase.js';
import { upsertRender } from './firestore.js';
import fetch from 'node-fetch';

const SERVER_URL = 'http://localhost:3002';
const TICK_MS    = 60_000; // every 60 seconds

// ── Mascot helpers (feature opt-in vía job.mascotEnabled — ver executeJob) ──────
// Mismo formato de doc id que containerDocId() en ttchop2/src/services/databaseService.ts.
function containerDocId(userId, accountId) {
  return accountId ? `${userId}__${accountId}` : userId;
}

// Ciclo de poses por línea de diálogo:
//   slot 0 (0–2s):  imagen 1 de la emoción
//   slot 1 (2–4s):  imagen 2 de la misma emoción
//   slot 2 (4–6s):  imagen 1 de la emoción prima (pausa visual)
//   slot 3 (6–8s):  imagen 2 de la emoción prima
//   slot 4+:        vuelve a imagen 1 de la emoción, etc.
// Si llega una emoción distinta antes de los 2s, esa toma el control.
// Si no hay asset para la emoción, cae a idle.
const POSE_CYCLE_SEC = 4.0;
const PRIMA_EMOTION = {
  happily:      'excited',
  excited:      'curious',
  curious:      'happily',
  surprised:    'excited',
  sarcastically:'annoyed',
  annoyed:      'sarcastically',
  sighs:        'curious',
  laughs:       'happily',
};

function buildMascotSegments(lines, mascotAssets) {
  if (!Array.isArray(mascotAssets) || mascotAssets.length === 0) return [];

  const byEmotion = {};
  for (const a of mascotAssets) {
    if (!byEmotion[a.emotion]) byEmotion[a.emotion] = [];
    byEmotion[a.emotion].push(a);
  }

  const idlePool = [
    ...(byEmotion['idle'] || []),
    ...(byEmotion['idleOpenMouth'] || []),
  ];
  const effectiveIdlePool = idlePool.length > 0
    ? idlePool
    : (byEmotion['curious'] || byEmotion['happily'] || []);

  // Devuelve la secuencia de ciclo para una emoción:
  // [emo[0], emo[1], prima[0], prima[1], emo[0], emo[1], ...]
  function cycleFor(emotion) {
    const pool  = byEmotion[emotion] || [];
    const prima = PRIMA_EMOTION[emotion];
    const pp    = prima ? (byEmotion[prima] || []) : [];
    const seq   = [];
    if (pool.length > 0) seq.push(pool[0]);
    if (pool.length > 1) seq.push(pool[1]); else if (pool.length > 0) seq.push(pool[0]);
    if (pp.length   > 0) seq.push(pp[0]);
    if (pp.length   > 1) seq.push(pp[1]);   else if (pp.length   > 0) seq.push(pp[0]);
    return seq;
  }

  // Build raw segments (1 por línea de diálogo)
  const rawSegs = [];
  for (const line of lines) {
    const pool = byEmotion[line.emotion];
    rawSegs.push({
      startSec: line.startSec,
      endSec:   line.endSec,
      emotion:  line.emotion,
      useIdle:  !pool || pool.length === 0,
    });
  }
  if (rawSegs.length === 0) return [];

  // Prepend idle (mínimo 1s)
  const MIN_IDLE_SEC = 1.0;
  const idleEnd = Math.max(MIN_IDLE_SEC, rawSegs[0].startSec);
  rawSegs.unshift({ startSec: 0, endSec: idleEnd, emotion: 'idle', useIdle: true });
  if (rawSegs[1] && rawSegs[1].startSec < idleEnd) rawSegs[1].startSec = idleEnd;

  // Cerrar gaps
  for (let i = 0; i < rawSegs.length - 1; i++) rawSegs[i].endSec = rawSegs[i + 1].startSec;

  // Expandir cada línea en sub-segmentos de 2s ciclando por la secuencia
  const segments = [];
  const idleCycleState = { idx: 0 };

  for (const raw of rawSegs) {
    let t = raw.startSec;
    let slot = 0; // cada línea reinicia el ciclo en slot 0

    while (t < raw.endSec - 0.05) {
      const end = Math.min(t + POSE_CYCLE_SEC, raw.endSec);
      let asset = null;

      if (raw.useIdle || raw.emotion === 'idle') {
        if (effectiveIdlePool.length > 0) {
          asset = effectiveIdlePool[idleCycleState.idx % effectiveIdlePool.length];
          idleCycleState.idx++;
        }
      } else {
        const cycle = cycleFor(raw.emotion);
        if (cycle.length > 0) asset = cycle[slot % cycle.length];
        slot++;
      }

      if (asset) segments.push({ startSec: t, endSec: end, url: asset.url, type: asset.type, emotion: raw.emotion });
      t = end;
    }
  }

  return segments;
}

// ── Main tick ──────────────────────────────────────────────────────────────────
// Recorre TODOS los proyectos configurados (ttchop, y ttchop2 si tiene
// credenciales) y sondea el Firestore de cada uno por separado. Un fallo
// sondeando un proyecto no debe impedir que se sondeen los demás.
async function tick() {
  for (const projectId of getConfiguredProjects()) {
    try {
      await tickProject(projectId);
    } catch (err) {
      console.error(`[scheduler] [${projectId}] tick error:`, err.message);
    }
  }
}

async function tickProject(projectId) {
  const db  = getDb(projectId);
  const now = new Date().toISOString();

  // Single-field query (no composite index needed); filter scheduledAt in JS
  const snap = await db.collection('scheduled_renders')
    .where('status', '==', 'pending')
    .get();

  const due = snap.docs.filter(d => d.data().scheduledAt <= now);
  if (due.length === 0) return;

  console.log(`[scheduler] [${projectId}] ${due.length} job(s) due`);

  for (const docSnap of due) {
    const job = { id: docSnap.id, ...docSnap.data() };

    // Mark running immediately to prevent double-execution on next tick
    await docSnap.ref.update({ status: 'running', startedAt: now });

    executeJob(db, job, docSnap.ref, projectId).catch(async err => {
      console.error(`[scheduler] [${projectId}] Job ${job.id} failed:`, err.message);
      await docSnap.ref.update({ status: 'failed', errorMessage: err.message });
    });
  }
}

// ── Execute one scheduled job ──────────────────────────────────────────────────
async function executeJob(db, job, jobRef, projectId) {
  // Fetch product
  const productSnap = await db.collection('products').doc(job.productId).get();
  if (!productSnap.exists) throw new Error(`Product ${job.productId} not found`);
  const product = { id: productSnap.id, ...productSnap.data() };

  const renderId = `sched_${job.id}`;

  if (job.type === 'collage' || job.type === 'collage+overlay') {
    // Fetch sessions (full objects with videos/downloadUrls)
    const sessions = [];
    for (const sid of (job.sessionIds || [])) {
      const s = await db.collection('sessions').doc(sid).get();
      if (s.exists) sessions.push({ id: s.id, ...s.data() });
    }
    if (sessions.length === 0) throw new Error('No sessions found for this job');

    // Fetch voice template → voiceId
    let voiceId = null;
    if (job.voiceTemplateId) {
      const t = await db.collection('templates').doc(job.voiceTemplateId).get();
      if (t.exists) voiceId = t.data().voiceId || null;
    }
    if (!voiceId) throw new Error('No voiceId found (check voice template)');

    // Fetch collage template
    let collageTemplate = null;
    if (job.collageTemplateId) {
      const t = await db.collection('templates').doc(job.collageTemplateId).get();
      if (t.exists) collageTemplate = { id: t.id, ...t.data() };
    }

    // Generate dialogue — dos caminos, ambos conviven sin tocarse entre sí:
    let dialogue, audioBase64, mascotSegments;

    if (job.mascotEnabled) {
      // ── Flujo con mascota (opt-in vía job.mascotEnabled) ──────────────────────
      console.log(`[scheduler] Generating structured dialogue (mascot) for job ${job.id}...`);
      const structuredRes = await fetch(`${SERVER_URL}/collage/dialogue/structured`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product, collageTemplate, language: job.language, voiceId }),
      });
      if (!structuredRes.ok) throw new Error(`dialogue/structured error: ${await structuredRes.text()}`);
      const structured = await structuredRes.json();
      audioBase64 = structured.audio;
      dialogue = structured.lines.map(l => l.text).join(' ');

      // mascotAssets vive en brand_concepts del mismo proyecto/db ya obtenido arriba.
      const docId = containerDocId(job.userId, job.accountId);
      const brandSnap = await db.collection('brand_concepts').doc(docId).get();
      const mascotAssets = brandSnap.exists ? (brandSnap.data().mascotAssets || []) : [];
      mascotSegments = buildMascotSegments(structured.lines, mascotAssets);
      console.log(`[scheduler] Job ${job.id}: ${mascotSegments.length}/${structured.lines.length} líneas con mascota`);
    } else {
      // ── Flujo original, sin cambios ────────────────────────────────────────
      console.log(`[scheduler] Generating dialogue for job ${job.id}...`);
      const dialogueRes = await fetch(`${SERVER_URL}/collage/dialogue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product, collageTemplate, language: job.language }),
      });
      if (!dialogueRes.ok) throw new Error(`dialogue error: ${await dialogueRes.text()}`);
      dialogue = (await dialogueRes.json()).dialogue;
    }

    // Enqueue collage (and optional overlay)
    console.log(`[scheduler] Enqueueing collage for job ${job.id} | renderId: ${renderId}`);
    const createRes = await fetch(`${SERVER_URL}/collage/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voiceId,
        dialogue,
        sessions,
        renderId,
        product,
        collageTemplate,
        language: job.language,
        needsOverlay: job.type === 'collage+overlay',
        userId: job.userId,
        projectId,
        ...(audioBase64 && { audioBase64 }),
        ...(mascotSegments && { mascotSegments }),
      }),
    });
    if (!createRes.ok) throw new Error(`collage/create error: ${await createRes.text()}`);

  } else if (job.type === 'overlay') {
    throw new Error('overlay-only scheduled jobs not supported (no source videoUrl)');

  } else if (job.type === 'ai') {
    // Fetch AI template
    let aiTemplate = null;
    if (job.aiTemplateId) {
      const t = await db.collection('templates').doc(job.aiTemplateId).get();
      if (t.exists) aiTemplate = { id: t.id, ...t.data() };
    }
    if (!aiTemplate) throw new Error('No AI template found (check aiTemplateId)');

    // Generate prompt
    console.log(`[scheduler] Generating AI prompt for job ${job.id}...`);
    const promptRes = await fetch(`${SERVER_URL}/ai/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productDescription: `${product.name}. ${product.description || ''}${job.extraNotes ? '. ' + job.extraNotes : ''}`,
        aiTemplate,
        language: job.language,
      }),
    });
    if (!promptRes.ok) throw new Error(`ai/prompt error: ${await promptRes.text()}`);
    const { prompt } = await promptRes.json();

    // Create render doc immediately so it appears in Renders
    await upsertRender({
      taskId: renderId,
      status: 'pending',
      type: 'ai',
      productId: product.id,
      productName: product.name,
      userId: job.userId,
      projectId,
    });

    // Submit to kie.ai
    console.log(`[scheduler] Submitting AI video for job ${job.id} | model: ${job.model || 'seedance'}`);
    const genRes = await fetch(`${SERVER_URL}/ai/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        imageUrls: product.modelSheetUrls || [],
        model: job.model || 'seedance',
        aspectRatio: '9:16',
        projectId,
      }),
    });
    if (!genRes.ok) throw new Error(`ai/generate error: ${await genRes.text()}`);
    const genData = await genRes.json();
    const aiTaskId = genData.data?.taskId || genData.taskId || renderId;
    console.log(`[scheduler] AI job submitted | aiTaskId: ${aiTaskId}`);

    // The callback will update the render doc when the video is ready.
    // If kie.ai returns a different taskId, we need to track it.
    if (aiTaskId !== renderId) {
      await upsertRender({ taskId: aiTaskId, status: 'pending', type: 'ai', productId: product.id, productName: product.name, userId: job.userId, projectId });
      await jobRef.update({ renderId: aiTaskId });
    }
    return; // skip the generic renderId update below
  }

  // Store renderId on the scheduled_render so the webapp can cross-reference
  await jobRef.update({ renderId });
  console.log(`[scheduler] Job ${job.id} dispatched → renderId: ${renderId}`);
}

// ── Export ─────────────────────────────────────────────────────────────────────
export function startScheduler() {
  console.log('[scheduler] Started — polling every 60s');
  tick(); // run once immediately on startup
  setInterval(tick, TICK_MS);
}
