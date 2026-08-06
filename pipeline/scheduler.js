import { getFirestore } from 'firebase-admin/firestore';
import { ensureFirebase } from './firebase.js';
import fetch from 'node-fetch';

const SERVER_URL = 'http://localhost:3002';
const TICK_MS    = 60_000; // every 60 seconds

// ── Main tick ──────────────────────────────────────────────────────────────────
async function tick() {
  try {
    ensureFirebase();
    const db  = getFirestore();
    const now = new Date().toISOString();

    const snap = await db.collection('scheduled_renders')
      .where('status', '==', 'pending')
      .where('scheduledAt', '<=', now)
      .get();

    if (snap.empty) return;

    console.log(`[scheduler] ${snap.docs.length} job(s) due`);

    for (const docSnap of snap.docs) {
      const job = { id: docSnap.id, ...docSnap.data() };

      // Mark running immediately to prevent double-execution on next tick
      await docSnap.ref.update({ status: 'running', startedAt: now });

      executeJob(db, job, docSnap.ref).catch(async err => {
        console.error(`[scheduler] Job ${job.id} failed:`, err.message);
        await docSnap.ref.update({ status: 'failed', errorMessage: err.message });
      });
    }
  } catch (err) {
    console.error('[scheduler] tick error:', err.message);
  }
}

// ── Execute one scheduled job ──────────────────────────────────────────────────
async function executeJob(db, job, jobRef) {
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

    // Generate dialogue
    console.log(`[scheduler] Generating dialogue for job ${job.id}...`);
    const dialogueRes = await fetch(`${SERVER_URL}/collage/dialogue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product, collageTemplate, language: job.language }),
    });
    if (!dialogueRes.ok) throw new Error(`dialogue error: ${await dialogueRes.text()}`);
    const { dialogue } = await dialogueRes.json();

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
      }),
    });
    if (!createRes.ok) throw new Error(`collage/create error: ${await createRes.text()}`);

  } else if (job.type === 'overlay') {
    // overlay-only needs an existing videoUrl — not supported from scheduler yet
    throw new Error('overlay-only scheduled jobs not supported (no source videoUrl)');
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
