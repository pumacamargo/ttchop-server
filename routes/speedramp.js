import { Router } from 'express';
import { execSync, spawnSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { uploadToStorage } from '../pipeline/storage.js';
import { upsertRender } from '../pipeline/firestore.js';

const router = Router();
const SCRIPTS_DIR = new URL('../scripts', import.meta.url).pathname;
const TEMP_DIR = '/tmp/ttchop_speedramp';

function ensureTempDir() {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
}

function runPy(script, args = [], opts = {}) {
  const result = spawnSync('python3', [path.join(SCRIPTS_DIR, script), ...args], {
    timeout: opts.timeout || 300000,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${script} failed: ${result.stderr || result.error}`);
  }
  return result.stdout.trim();
}

function downloadFile(url, dest) {
  execSync(`curl -fsSL -o "${dest}" "${url}"`, { timeout: 60000 });
}

/**
 * POST /speedramp/create
 * Body:
 * {
 *   audioUrl: string,          // URL to audio file (mp3/wav)
 *   sessions: [                // video clips to use
 *     {
 *       downloadUrl: string,
 *       duration: number,
 *       trimStart?: number,
 *       trimEnd?: number,
 *       clipId?: string,
 *     }
 *   ],
 *   beatsPerClip?: number,     // how many beats per clip (default: 2)
 *   fps?: number,              // output fps (default: 30)
 *   width?: number,
 *   height?: number,
 *   renderId?: string,
 *   userId?: string,
 *   productId?: string,
 *   productName?: string,
 * }
 */
router.post('/create', async (req, res) => {
  ensureTempDir();
  const jobId = randomBytes(6).toString('hex');
  const jobDir = path.join(TEMP_DIR, jobId);
  mkdirSync(jobDir, { recursive: true });

  try {
    const {
      audioUrl,
      sessions,
      triggersPerClip = 2,
      fps = 30,
      width = 1080,
      height = 1920,
      userId = 'default',
      productId = '',
      productName = '',
    } = req.body;

    if (!audioUrl) return res.status(400).json({ error: 'audioUrl is required' });
    if (!sessions || !sessions.length) return res.status(400).json({ error: 'sessions is required' });

    const renderId = req.body.renderId || `render_sr_${Date.now()}_${jobId}`;

    // 1. Download audio
    const audioExt = audioUrl.includes('.wav') ? 'wav' : 'mp3';
    const audioPath = path.join(jobDir, `audio.${audioExt}`);
    console.log(`[SR ${jobId}] Downloading audio...`);
    downloadFile(audioUrl, audioPath);

    // 2. Detect beats
    console.log(`[SR ${jobId}] Detecting beats...`);
    const beatJson = runPy('beat_detector.py', [audioPath], { timeout: 120000 });
    const beatData = JSON.parse(beatJson);
    console.log(`[SR ${jobId}] BPM: ${beatData.bpm}, beats: ${beatData.beat_count}, duration: ${beatData.duration}s`);

    const triggers = beatData.triggers;
    if (!triggers || triggers.length < 2) {
      return res.status(422).json({ error: 'Could not detect enough triggers in audio' });
    }

    // 3. Build segment boundaries from hybrid triggers
    // Every `triggersPerClip` triggers = one clip change, but always include the drop
    const dropTime = beatData.drop_time;

    // Select which trigger indices become clip boundaries
    const boundaryIndices = new Set();
    boundaryIndices.add(0); // always start at first trigger
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i].type === 'drop') boundaryIndices.add(i); // drop always a boundary
      if (triggers[i].type === 'end') boundaryIndices.add(i);  // always end
      if (i % triggersPerClip === 0) boundaryIndices.add(i);    // every N triggers
    }

    const boundaryList = Array.from(boundaryIndices).sort((a, b) => a - b);

    // Build segments from boundaries
    const segments = [];
    let clipIndex = 0;

    for (let bi = 0; bi < boundaryList.length - 1; bi++) {
      const startTrig = triggers[boundaryList[bi]];
      const endTrig = triggers[boundaryList[bi + 1]];
      const outDuration = endTrig.time - startTrig.time;
      if (outDuration <= 0.1) continue;

      const sess = sessions[clipIndex % sessions.length];
      const trimStart = parseFloat(sess.trimStart ?? 0);
      const clipDur = parseFloat(sess.duration ?? 5);
      const trimEnd = parseFloat(sess.trimEnd ?? clipDur);

      segments.push({
        clipId: sess.clipId || `clip_${clipIndex}`,
        firebaseUrl: sess.downloadUrl || '',
        triggerType: startTrig.type,
        isDrop: startTrig.type === 'drop',
        startTime: Math.round(startTrig.time * 1000) / 1000,
        endTime: Math.round(endTrig.time * 1000) / 1000,
        trimStart,
        trimEnd,
      });
      clipIndex++;
    }

    if (!segments.length) {
      return res.status(422).json({ error: 'No segments could be built from beats + sessions' });
    }

    console.log(`[SR ${jobId}] Built ${segments.length} segments`);

    // 4. Build recipe
    const outputPath = path.join(jobDir, 'output.mp4');
    const recipe = {
      outputPath,
      audioPath,
      fps,
      width,
      height,
      beatInterval: beatData.beat_interval,
      segments,
    };
    const recipePath = path.join(jobDir, 'recipe.json');
    writeFileSync(recipePath, JSON.stringify(recipe, null, 2));

    // 5. Run speed_ramp_builder.py
    console.log(`[SR ${jobId}] Building speed ramp video...`);
    const buildResult = runPy('speed_ramp_builder.py', [recipePath], { timeout: 600000 });
    const buildData = JSON.parse(buildResult);

    if (buildData.error) {
      return res.status(500).json({ error: buildData.error });
    }

    console.log(`[SR ${jobId}] Video done: ${buildData.duration}s`);

    // 6. Upload to Firebase
    console.log(`[SR ${jobId}] Uploading to Firebase...`);
    const remoteFilename = `${renderId}.mp4`;
    const firebaseUrl = await uploadToStorage(outputPath, remoteFilename);

    // 7. Save to Firestore
    await upsertRender({
      taskId: renderId,
      status: 'done',
      videoUrl: firebaseUrl,
      type: 'speed_ramp',
      userId,
      productId,
      productName,
    });

    // Cleanup
    try {
      execSync(`rm -rf "${jobDir}"`);
    } catch (_) {}

    console.log(`[SR ${jobId}] Complete: ${renderId}`);
    res.json({ renderId, videoUrl: firebaseUrl, duration: buildData.duration, bpm: beatData.bpm, segments: segments.length });

  } catch (err) {
    console.error(`[SR ${jobId}] Error:`, err.message);
    try { execSync(`rm -rf "${path.join(TEMP_DIR, jobId)}"`); } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /speedramp/health
 */
router.get('/health', (_, res) => {
  res.json({ status: 'ok', route: '/speedramp' });
});

export default router;
