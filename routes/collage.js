import { Router } from 'express';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { callLLM, callLLMJson } from '../pipeline/llm.js';
import { textToSpeech } from '../pipeline/elevenlabs.js';
import { uploadToStorage } from '../pipeline/storage.js';
import { upsertRender } from '../pipeline/firestore.js';

const router = Router();
const SCRIPTS_DIR = new URL('../scripts', import.meta.url).pathname;
const TEMP_DIR = '/tmp/ttchop_collage';

function ensureTempDir() {
  if (!existsSync(TEMP_DIR)) execSync(`mkdir -p ${TEMP_DIR}`);
}

function getAudioDuration(audioPath) {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`,
    { timeout: 10000 }
  ).toString().trim();
  return parseFloat(out) || 0;
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
// Body: { voiceId, dialogue, sessions, renderId, product, collageTemplate, language, audioDurationSeconds? }
// Pipeline completo: ElevenLabs TTS → ffmpeg recipe LLM → collage_builder.py → FTP → Firestore
router.post('/create', async (req, res) => {
  const { voiceId, dialogue, sessions, renderId, product, collageTemplate, language, audioDurationSeconds: clientAudioDuration } = req.body;

  if (!voiceId || !dialogue || !sessions || !renderId) {
    return res.status(400).json({ error: 'voiceId, dialogue, sessions y renderId son requeridos' });
  }

  const jobId = randomBytes(6).toString('hex');
  const audioPath = path.join(TEMP_DIR, `audio_${jobId}.mp3`);
  const recipePath = path.join(TEMP_DIR, `recipe_${jobId}.json`);
  const outputPath = path.join(TEMP_DIR, `collage_${jobId}.mp4`);

  console.log(`[${jobId}] Collage START | renderId: ${renderId}`);

  try {
    ensureTempDir();

    // 1. ElevenLabs TTS
    console.log(`[${jobId}] TTS...`);
    await textToSpeech({ text: dialogue, voiceId, outputPath: audioPath });

    // 2. Audio duration
    const audioDurationSeconds = clientAudioDuration || getAudioDuration(audioPath);
    console.log(`[${jobId}] Audio duration: ${audioDurationSeconds}s`);

    // 3. LLM genera ffmpeg recipe
    console.log(`[${jobId}] Generating ffmpeg recipe...`);
    const recipe = await callLLMJson({
      system: `You are an expert video editor generating an ffmpeg edit recipe from clip metadata and an audio track.
Respond ONLY with valid JSON, no markdown, no explanations.`,
      user: `Generate an ffmpeg collage recipe.

PRODUCT: ${JSON.stringify(product || {})}

SESSIONS & CLIPS:
${JSON.stringify(sessions)}

COLLAGE TEMPLATE:
${collageTemplate?.content || ''}

LANGUAGE: ${language || 'spanish'}

DIALOGUE (strip emotional tags in brackets):
${dialogue}

AUDIO DURATION: ${audioDurationSeconds}s — This is the EXACT total video duration. The sum of all clip durations MUST equal exactly ${audioDurationSeconds}s.

OUTPUT FORMAT — respond with this JSON structure:
{
  "ffmpegRecipe": {
    "meta": { "outputPath": "${outputPath}", "width": 1080, "height": 1920 },
    "audio": { "src": "${audioPath}" },
    "clips": [
      {
        "clipId": "...",
        "role": "hook|body|cta",
        "firebaseUrl": "...",
        "src": "",
        "trimStart": 0.0,
        "trimEnd": 3.0,
        "speed": 1.0
      }
    ]
  }
}`,
    });

    // 4. Write recipe JSON
    writeFileSync(recipePath, JSON.stringify(recipe));

    // 5. Run collage_builder.py
    console.log(`[${jobId}] Running collage_builder.py...`);
    const pyResult = execSync(
      `python3 ${SCRIPTS_DIR}/collage_builder.py "${recipePath}"`,
      { timeout: 300_000, encoding: 'utf8' }
    );
    const pyOutput = JSON.parse(pyResult.trim().split('\n').pop());
    if (pyOutput.error) throw new Error(`collage_builder: ${pyOutput.error}`);

    console.log(`[${jobId}] Collage built: ${pyOutput.final_duration_seconds}s`);

    // 6. Upload to Firebase Storage
    console.log(`[${jobId}] Uploading to Firebase Storage...`);
    const filename = `${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}_${jobId}.mp4`;
    const publicUrl = await uploadToStorage(outputPath, filename);
    console.log(`[${jobId}] Public URL: ${publicUrl}`);

    // 7. Update Firestore
    await upsertRender({ taskId: renderId, status: 'done', videoUrl: publicUrl });

    res.json({ status: 'done', videoUrl: publicUrl, renderId, jobId });

  } catch (err) {
    console.error(`[${jobId}] ERROR:`, err.message);
    try {
      await upsertRender({ taskId: renderId, status: 'failed', errorMessage: err.message });
    } catch (_) {}
    res.status(500).json({ error: err.message, jobId });
  } finally {
    for (const f of [audioPath, recipePath, outputPath]) {
      if (f && existsSync(f)) unlinkSync(f);
    }
  }
});

export default router;
