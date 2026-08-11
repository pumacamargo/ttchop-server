import { Router } from 'express';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync, existsSync } from 'fs';

const execAsync = promisify(exec);
import path from 'path';
import { randomBytes } from 'crypto';
import { callLLM, callLLMJson } from '../pipeline/llm.js';
import { textToSpeech } from '../pipeline/elevenlabs.js';
import { uploadToStorage } from '../pipeline/storage.js';
import { upsertRender } from '../pipeline/firestore.js';
import { enqueue } from '../pipeline/jobQueue.js';
import fetch from 'node-fetch';

const router = Router();
const SCRIPTS_DIR = new URL('../scripts', import.meta.url).pathname;
const TEMP_DIR = '/tmp/ttchop_collage';

async function ensureTempDir() {
  if (!existsSync(TEMP_DIR)) await execAsync(`mkdir -p ${TEMP_DIR}`);
}

async function getAudioDuration(audioPath) {
  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`,
    { timeout: 10000 }
  );
  return parseFloat(stdout.trim()) || 0;
}

// POST /collage/dialogue
// Body: { product: { name, description }, collageTemplate: { content }, language }
// Genera el script de voz para ElevenLabs
router.post('/dialogue', async (req, res) => {
  const { product, collageTemplate, language } = req.body;

  if (!product?.name || !collageTemplate?.content) {
    return res.status(400).json({ error: 'product.name y collageTemplate.content son requeridos' });
  }

  try {
    const result = await callLLM({
      system: `You are an expert AI scriptwriter and audio prompt engineer specialized in creating high-quality spoken dialogue and voiceover scripts for ElevenLabs Eleven v3.
Respond ONLY with the final dialogue text — no JSON, no markdown, no explanations.`,
      user: `Generate the final spoken dialogue output based on this information.

PRODUCT INFORMATION:
Name: ${product.name}
Description: ${product.description || ''}

VIDEO/AUDIO TEMPLATE DESCRIPTION:
${collageTemplate.content}

DIALOGUE LANGUAGE: ${language || 'spanish'}

Output ONLY the dialogue text, ready to be sent directly to ElevenLabs.`,
    });

    res.json({ dialogue: result.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /collage/create
// Body: { voiceId, dialogue, sessions, renderId, product, collageTemplate, language, audioDurationSeconds?, needsOverlay? }
// needsOverlay: true → al terminar el collage, encola automáticamente un overlay job
router.post('/create', async (req, res) => {
  const { voiceId, dialogue, sessions, renderId, product, collageTemplate, language, audioDurationSeconds: clientAudioDuration, needsOverlay = false } = req.body;
  // projectId: a qué proyecto (ttchop / ttchop2) escribir. Ausente → default (ttchop).
  const { projectId } = req.body;

  if (!voiceId || !dialogue || !sessions || !renderId) {
    return res.status(400).json({ error: 'voiceId, dialogue, sessions y renderId son requeridos' });
  }

  const jobId = randomBytes(6).toString('hex');
  const audioPath = path.join(TEMP_DIR, `audio_${jobId}.mp3`);
  const recipePath = path.join(TEMP_DIR, `recipe_${jobId}.json`);
  const outputPath = path.join(TEMP_DIR, `collage_${jobId}.mp4`);

  console.log(`[${jobId}] Collage START | renderId: ${renderId} | projectId: ${projectId || 'default'}`);

  // Create render doc immediately so it appears in the Renders tab right away
  await upsertRender({
    taskId: renderId,
    status: 'pending',
    type: needsOverlay ? 'collage+overlay' : 'collage',
    productId: product?.id || null,
    productName: product?.name || null,
    userId: req.body.userId || null,
    projectId,
  });

  // Respond immediately — pipeline runs in queue
  const queuePos = enqueue(jobId, async () => {
    try {
      ensureTempDir();
      await upsertRender({ taskId: renderId, status: 'processing', projectId });

    // 1. ElevenLabs TTS
    console.log(`[${jobId}] TTS...`);
    await textToSpeech({ text: dialogue, voiceId, outputPath: audioPath });

    // 2. Audio duration
    const audioDurationSeconds = clientAudioDuration || await getAudioDuration(audioPath);
    console.log(`[${jobId}] Audio duration: ${audioDurationSeconds}s`);

    // 3. LLM genera ffmpeg recipe
    console.log(`[${jobId}] Generating ffmpeg recipe...`);
    const recipe = await callLLMJson({
      system: `You are an expert video editor generating an ffmpeg edit recipe from clip metadata and an audio track.
Respond ONLY with valid JSON, no markdown, no explanations.`,
      user: `Generate an ffmpeg collage recipe with a 2-part structure.

PRODUCT: ${JSON.stringify(product || {})}

SESSIONS & CLIPS:
${JSON.stringify(sessions.map(s => ({
  ...s,
  videos: (s.videos || []).map(v => {
    const { thumbnailUrl, ...rest } = v;
    return rest;
  })
})))}

COLLAGE TEMPLATE:
${collageTemplate?.content || ''}

LANGUAGE: ${language || 'spanish'}

DIALOGUE (strip emotional tags in brackets):
${dialogue}

AUDIO DURATION: ${audioDurationSeconds}s — EXACT total output duration. The sum of all clip output durations MUST equal exactly ${audioDurationSeconds}s.

== REQUIRED 2-PART STRUCTURE ==

PART 1 — HOOK (first ~3 seconds of output):
- This MUST be a montage of 3 to 5 different clips — NOT a single clip playing for 3 seconds
- Each hook clip segment: 0.5s to 1.0s of output (very short, punchy cuts)
- Pick the single most impressive moment from each of the 3-5 different clips (any part, not just the start)
- Speed: 2.0x to 3.0x per clip — fast and energetic
- Together they sum to exactly 3.0s output
- Goal: like a movie trailer — the viewer sees 3-5 quick flashes of the best moments and wants to keep watching
- Think: which 3-5 moments, if seen in 3 seconds, would make someone stop scrolling?
- role: "hook"

PART 2 — BODY (remaining ${audioDurationSeconds - 3}s of output):
- Use clips in a coherent story order that logically demonstrates the product
- ⚠️ STRICT RULES — both must be respected:
  1. Speed: MINIMUM 1.5x for every body clip — never use speed 1.0. Range: 1.5 to 4.0
  2. Output duration per clip = (trimEnd - trimStart) / speed — MUST be between 2.0s and 3.0s
  Example: 4.5s footage at speed=1.5 → 3.0s output ✅ | 12s footage at speed=4.0 → 3.0s output ✅
- Use enough clips so the TOTAL body output = ${audioDurationSeconds - 3}s
- role: "body"

OUTPUT FORMAT:
{
  "ffmpegRecipe": {
    "meta": { "outputPath": "${outputPath}", "width": 1080, "height": 1920 },
    "audio": { "src": "${audioPath}" },
    "clips": [
      {
        "clipId": "...",
        "role": "hook|body",
        "firebaseUrl": "...",
        "src": "",
        "trimStart": 0.0,
        "trimEnd": 3.0,
        "speed": 2.0
      }
    ]
  }
}`,
    });

    // 4. Validate recipe rules and auto-correct
    const clips = recipe.ffmpegRecipe.clips;
    const clipOutSecs = (c) => (c.trimEnd - c.trimStart) / (c.speed || 1);
    const MAX_BODY_SECS = 3.0;
    const MIN_SPEED = 1.5;

    // 4a. Enforce rules per clip
    const MAX_HOOK_SECS = 1.0;
    let enforced = 0;
    for (const c of clips) {
      if (c.role === 'hook') {
        // Hook clips: max 1.0s output (should be 0.5-1.0s punchy cuts)
        const out = clipOutSecs(c);
        if (out > MAX_HOOK_SECS) {
          console.log(`[${jobId}] FIX hook duration: ${c.clipId} out=${out.toFixed(2)}s → ${MAX_HOOK_SECS}s (speed=${c.speed})`);
          c.trimEnd = c.trimStart + MAX_HOOK_SECS * (c.speed || 1);
          enforced++;
        }
      } else {
        // Treat anything that's not "hook" as body
        if (!c.role || c.role !== 'body') {
          console.log(`[${jobId}] WARNING: clip ${c.clipId} has role="${c.role}" — treating as body`);
          c.role = 'body';
        }
        if ((c.speed || 1) < MIN_SPEED) {
          console.log(`[${jobId}] FIX speed: ${c.clipId} speed=${c.speed} → ${MIN_SPEED}`);
          c.speed = MIN_SPEED;
          enforced++;
        }
        const out = clipOutSecs(c);
        if (out > MAX_BODY_SECS) {
          console.log(`[${jobId}] FIX duration: ${c.clipId} out=${out.toFixed(2)}s → ${MAX_BODY_SECS}s (speed=${c.speed})`);
          c.trimEnd = c.trimStart + MAX_BODY_SECS * (c.speed || 1);
          enforced++;
        }
      }
    }
    if (enforced > 0) console.log(`[${jobId}] Enforced rules on ${enforced} clip(s)`);

    // Log every clip for traceability
    clips.forEach((c, i) => {
      const out = clipOutSecs(c);
      console.log(`[${jobId}] CLIP ${String(i+1).padStart(2,'0')} | ${c.role || '??'} | ${c.clipId} | start=${c.trimStart?.toFixed(2)} end=${c.trimEnd?.toFixed(2)} speed=${c.speed} → out=${out.toFixed(2)}s`);
    });

    // 4b. Fill gap if clips sum < audio duration — cycle random body clips, no consecutive repeats
    let totalOut = clips.reduce((s, c) => s + clipOutSecs(c), 0);
    const gap = audioDurationSeconds - totalOut;
    if (gap > 0.5) {
      console.log(`[${jobId}] Gap: clips=${totalOut.toFixed(1)}s audio=${audioDurationSeconds}s — filling ${gap.toFixed(1)}s`);
      const bodyClips = clips.filter(c => c.role === 'body');
      const pool = bodyClips.length > 0 ? bodyClips : clips;
      // Shuffle pool
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      let remaining = gap;
      let ext = 0;
      let lastId = clips[clips.length - 1]?.clipId;
      let poolIdx = 0;
      while (remaining > 0.3) {
        // Pick next clip that's not the same as the last one
        let pick = shuffled[poolIdx % shuffled.length];
        if (pick.clipId === lastId && shuffled.length > 1) {
          poolIdx++;
          pick = shuffled[poolIdx % shuffled.length];
        }
        const segOut = Math.min(remaining, MAX_BODY_SECS);
        const segSrc = segOut * (pick.speed || 1);
        const newClip = { ...pick, clipId: `${pick.clipId}_ext${++ext}`, trimEnd: pick.trimStart + segSrc };
        clips.push(newClip);
        lastId = newClip.clipId;
        poolIdx++;
        remaining -= segOut;
      }
      totalOut = clips.reduce((s, c) => s + clipOutSecs(c), 0);
      console.log(`[${jobId}] After gap fix: clips=${totalOut.toFixed(1)}s (+${ext} filler clips)`);
    }

    console.log(`[${jobId}] Recipe: ${clips.length} clips, total=${totalOut.toFixed(1)}s, audio=${audioDurationSeconds}s`);

    // 4c. Write recipe JSON
    writeFileSync(recipePath, JSON.stringify(recipe));

    // 5. Run collage_builder.py
    console.log(`[${jobId}] Running collage_builder.py...`);
    const { stdout: pyResult } = await execAsync(
      `python3 ${SCRIPTS_DIR}/collage_builder.py "${recipePath}"`,
      { timeout: 1_200_000 }
    );
    const pyOutput = JSON.parse(pyResult.trim().split('\n').pop());
    if (pyOutput.error) throw new Error(`collage_builder: ${pyOutput.error}`);

    console.log(`[${jobId}] Collage built: ${pyOutput.final_duration_seconds}s`);

    // 6. Upload to Firebase Storage
    console.log(`[${jobId}] Uploading to Firebase Storage...`);
    const filename = `${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}_${jobId}.mp4`;
    const publicUrl = await uploadToStorage(outputPath, filename, projectId);
    console.log(`[${jobId}] Public URL: ${publicUrl}`);

    // 7. Update Firestore
    if (needsOverlay) {
      // Collage done — mark as collage_done, overlay will update to done
      await upsertRender({
        taskId: renderId,
        status: 'collage_done',
        videoUrl: publicUrl,
        type: 'collage+overlay',
        productId: product?.id || null,
        productName: product?.name || null,
        userId: req.body.userId || null,
        projectId,
      });
      console.log(`[${jobId}] Collage done — enqueueing overlay...`);
      // Dispatch overlay job (reuses same renderId so webapp keeps polling)
      // Propagamos projectId para que el overlay encadenado escriba en el mismo proyecto.
      fetch('http://localhost:3002/overlay/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ renderId, product, videoUrl: publicUrl, _fromCollage: true, projectId }),
      }).then(async r => {
        if (!r.ok) {
          const err = await r.text();
          console.error(`[${jobId}] Overlay dispatch error: ${err.slice(0, 200)}`);
          await upsertRender({ taskId: renderId, status: 'failed', errorMessage: `Overlay dispatch failed: ${err.slice(0, 200)}`, projectId });
        }
      }).catch(async err => {
        console.error(`[${jobId}] Overlay dispatch threw:`, err.message);
        await upsertRender({ taskId: renderId, status: 'failed', errorMessage: `Overlay dispatch failed: ${err.message}`, projectId });
      });
    } else {
      await upsertRender({
        taskId: renderId,
        status: 'done',
        videoUrl: publicUrl,
        type: 'collage',
        productId: product?.id || null,
        productName: product?.name || null,
        userId: req.body.userId || null,
        projectId,
      });
    }

    console.log(`[${jobId}] DONE | videoUrl: ${publicUrl}`);

    } catch (err) {
      console.error(`[${jobId}] ERROR:`, err.message);
      try {
        await upsertRender({
          taskId: renderId,
          status: 'failed',
          errorMessage: err.message,
          type: 'collage',
          productId: product?.id || null,
          productName: product?.name || null,
          projectId,
        });
      } catch (_) {}
    } finally {
      for (const f of [audioPath, recipePath, outputPath]) {
        if (f && existsSync(f)) unlinkSync(f);
      }
    }
  });

  res.json({ status: 'pending', renderId, jobId, queuePosition: queuePos });
});

export default router;
