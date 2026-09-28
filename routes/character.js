import { Router } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import fetch from 'node-fetch';

import { callLLMJson } from '../pipeline/llm.js';
import { textToSpeechWithTimestamps } from '../pipeline/elevenlabs.js';
import { uploadToStorage, uploadFileToStorage } from '../pipeline/storage.js';
import { upsertRender, getRender } from '../pipeline/firestore.js';
import { enqueue } from '../pipeline/jobQueue.js';
import { getMouthCues, buildEmotionCues, estimateLineTimings } from '../pipeline/characterCues.js';
import { MASCOT_EMOTIONS } from './collage.js';

const execAsync = promisify(exec);
const router = Router();
const TEMP_DIR = '/tmp/ttchop_character';
const OVERLAY_SERVER = process.env.OVERLAY_SERVER_URL || 'http://localhost:3001';
const RIV_VERSION = 'aato02.riv'; // ver workflow.html para el historial de versiones

async function ensureTempDir() {
  if (!existsSync(TEMP_DIR)) await execAsync(`mkdir -p ${TEMP_DIR}`);
}

// Blinks periódicos simples, cada ~2.5-3.5s (determinista, no aleatorio real,
// para que el render sea reproducible).
function buildBlinkTimes(duration) {
  const times = [];
  for (let t = 1.4; t < duration - 0.5; t += 2.9) times.push(Number(t.toFixed(2)));
  return times;
}

// POST /character/create
// Body: { renderId, product?, videoUrl?, language?, voiceId?, projectId, userId, scriptTemplate? }
// videoUrl: el video del overlay ya renderizado (salida de /overlay/create), sobre el
// que se va a componer el personaje.
// product/videoUrl/voiceId opcionales si renderId ya tiene un render previo guardado —
// se leen de Firestore (videoUrl más reciente del render, inputs.overlay/inputs.collage
// para product/language/voiceId/scriptTemplate). Así se puede re-disparar SOLO el
// personaje mandando nada más { renderId, projectId }.
router.post('/create', async (req, res) => {
  const { projectId, userId } = req.body;
  let { renderId, product, videoUrl, language, voiceId, scriptTemplate, dialogueText, variant, testSeconds } = req.body;

  if (!renderId) {
    return res.status(400).json({ error: 'renderId es requerido' });
  }

  if (!product || !videoUrl || !voiceId || dialogueText === undefined) {
    const existing = await getRender(renderId, projectId);
    if (!existing) {
      return res.status(400).json({ error: 'product, videoUrl y voiceId son requeridos (no hay render previo con ese renderId para resumir)' });
    }
    const savedOverlay = existing.inputs?.overlay || {};
    const savedCollage = existing.inputs?.collage || {};
    // Preferir la URL propia guardada por overlay/collage sobre el `videoUrl` de
    // nivel superior del doc — ese campo se sobreescribe con la salida del PERSONAJE
    // cada vez que corre esta misma ruta, así que en un resume posterior apuntaría
    // a un video que ya tiene un personaje pegado encima (cascada), no a la base real.
    videoUrl = videoUrl || savedOverlay.videoUrl || savedCollage.videoUrl || existing.videoUrl;
    product = product || savedOverlay.product || savedCollage.product;
    language = language ?? savedOverlay.language ?? savedCollage.language;
    voiceId = voiceId ?? savedOverlay.voiceId ?? savedCollage.voiceId;
    scriptTemplate = scriptTemplate ?? savedOverlay.scriptTemplate ?? savedCollage.collageTemplate?.content;
    // dialogueText: el diálogo que YA se sintetizó y se escucha en el video base
    // (collage). Si existe, el personaje debe hablar exactamente ESE texto —
    // ver estrategia abajo (extrae el audio real del video base en vez de
    // sintetizar uno nuevo, así el diálogo y el lip-sync quedan garantizados
    // idénticos a lo que se escucha en el video final).
    dialogueText = dialogueText ?? savedOverlay.dialogue ?? savedCollage.dialogue;
  }

  if (!product || !videoUrl || !voiceId) {
    return res.status(400).json({ error: 'renderId, product, videoUrl y voiceId son requeridos' });
  }

  const jobId = randomBytes(6).toString('hex');
  const mp3Path = `${TEMP_DIR}/audio_${jobId}.mp3`;
  const wavPath = `${TEMP_DIR}/audio_${jobId}.wav`;
  const resultPath = `${TEMP_DIR}/result_${jobId}.mp4`;

  if (!req.body._fromOverlay) {
    await upsertRender({
      taskId: renderId,
      status: 'pending',
      type: 'character',
      productId: product?.id || null,
      productName: product?.name || null,
      userId: userId || null,
      projectId,
      inputs: { character: { product, videoUrl, language, voiceId, scriptTemplate, dialogueText } },
    });
  } else {
    await upsertRender({
      taskId: renderId,
      status: 'processing',
      projectId,
      inputs: { character: { product, videoUrl, language, voiceId, scriptTemplate, dialogueText } },
    });
  }

  const queuePos = enqueue(jobId, async () => {
    try {
      await ensureTempDir();
      await upsertRender({ taskId: renderId, status: 'processing', type: 'character', projectId });

      let linesOut, duration;

      if (dialogueText) {
        // El diálogo ya existe (viene del collage) y su audio YA está muxeado en el
        // video base (videoUrl) — el personaje debe decir EXACTAMENTE ese texto, y
        // el lip-sync debe sincronizar con ESE audio real, no con uno nuevo. En vez
        // de resintetizar (guion distinto + audio distinto = boca desincronizada,
        // el bug real que reportó Cacho), extraemos el audio real del video base y
        // corremos Rhubarb directo sobre él — sync garantizado con lo que se oye.
        console.log(`[${jobId}] Reusando diálogo del collage (mismo texto, mismo audio real)...`);
        await execAsync(`ffmpeg -v error -y -i "${videoUrl}" -vn "${wavPath}"`, { timeout: 120000 });
        const { stdout: durStr } = await execAsync(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${wavPath}"`,
          { timeout: 10000 }
        );
        duration = parseFloat(durStr.trim());

        // Segmentar el texto EXISTENTE en líneas con emoción — sin reescribir ni
        // una palabra, solo cortar en líneas y clasificar el tono de cada una.
        const segResult = await callLLMJson({
          system: `You split an existing spoken script into short lines and tag each with an emotion.
The input script may already contain inline [tag] markers (e.g. "[excited] some text") — use them as a strong hint for that line's "emotion", but the output "text" field must be the CLEAN spoken words only, with the [tag] markers stripped out.
Respond ONLY with valid JSON, no markdown, no explanations, in this exact shape:
{ "lines": [{ "text": "...", "emotion": "..." }, ...] }
CRITICAL: "text" must be an EXACT substring copy of the input script's WORDS (tags stripped) — do NOT translate, rephrase, summarize, or alter wording in any way. Only split it into shorter lines, strip any [tag] markers, and assign each line an emotion.
Each "emotion" MUST be exactly one of: ${MASCOT_EMOTIONS.join(', ')}.
Concatenating all "text" values (with single spaces between) MUST reproduce the original script's spoken words (tags excluded).`,
          user: `Split this script into short lines, one emotion per line:\n\n${dialogueText}`,
        });
        const lines = Array.isArray(segResult?.lines) ? segResult.lines : [];
        if (lines.length === 0) throw new Error('LLM no pudo segmentar el diálogo existente');
        for (const line of lines) {
          if (!MASCOT_EMOTIONS.includes(line.emotion)) line.emotion = 'curious';
        }
        linesOut = estimateLineTimings(lines, duration);
      } else {
        // Sin diálogo previo (personaje standalone, sin collage de origen) — generar
        // guion propio y sintetizar audio nuevo con ElevenLabs (comportamiento original).
        console.log(`[${jobId}] Generando guion con emociones...`);
        const result = await callLLMJson({
          system: `You are an expert AI scriptwriter and audio prompt engineer specialized in creating high-quality spoken dialogue and voiceover scripts for ElevenLabs Eleven v3.
Respond ONLY with valid JSON, no markdown, no explanations, in this exact shape:
{ "lines": [{ "text": "...", "emotion": "..." }, ...] }
Each "text" is one spoken line of dialogue. Do NOT include emotion tags inside the text itself.
Each "emotion" MUST be exactly one of: ${MASCOT_EMOTIONS.join(', ')}.
Choose the emotion that best matches the tone of that spoken line — it will be injected as a [emotion] voice tag in ElevenLabs to shape the vocal delivery.`,
          user: `Generate the final spoken dialogue output based on this information, broken into short lines with one emotion per line.

PRODUCT INFORMATION:
Name: ${product.name}
Description: ${product.description || ''}

DIALOGUE LANGUAGE: ${language || 'spanish'}
${scriptTemplate ? `\nSCRIPT STYLE TEMPLATE — follow this pacing, tone and structure:\n${scriptTemplate}\n` : ''}
Output ONLY the JSON object described above.`,
        });

        const lines = Array.isArray(result?.lines) ? result.lines : [];
        if (lines.length === 0) throw new Error('LLM no devolvió líneas de diálogo válidas');
        for (const line of lines) {
          if (!MASCOT_EMOTIONS.includes(line.emotion)) line.emotion = 'curious';
        }

        // Texto completo con tags [emotion] + offsets al texto hablado (sin el tag)
        const JOINER = ' ';
        let fullText = '';
        const offsets = [];
        for (const line of lines) {
          const tag = `[${line.emotion}] `;
          const textStart = fullText.length + tag.length;
          fullText += tag + line.text;
          offsets.push({ start: textStart, end: textStart + line.text.length });
          fullText += JOINER;
        }

        console.log(`[${jobId}] Sintetizando voz...`);
        const { audioBase64, alignment } = await textToSpeechWithTimestamps({ text: fullText, voiceId });
        writeFileSync(mp3Path, Buffer.from(audioBase64, 'base64'));

        const charStarts = alignment?.character_start_times_seconds;
        const charEnds = alignment?.character_end_times_seconds;
        if (!Array.isArray(charStarts) || charStarts.length === 0) throw new Error('ElevenLabs no devolvió alignment');
        const lastIdx = charStarts.length - 1;

        linesOut = lines.map((line, i) => {
          const { start, end } = offsets[i];
          const startIdx = Math.min(start, lastIdx);
          const endIdx = Math.min(Math.max(end - 1, startIdx), lastIdx);
          return {
            text: line.text,
            emotion: line.emotion,
            startSec: charStarts[startIdx] ?? 0,
            endSec: charEnds[endIdx] ?? charEnds[lastIdx] ?? 0,
          };
        });
        duration = charEnds[lastIdx];

        console.log(`[${jobId}] Convirtiendo audio y corriendo Rhubarb...`);
        await execAsync(`ffmpeg -v error -y -i "${mp3Path}" "${wavPath}"`, { timeout: 30000 });
      }

      const mouthCues = await getMouthCues(wavPath);

      // 5. brow/body cues desde las líneas
      const { browCues, bodyCues } = buildEmotionCues(linesOut);
      const blinkTimes = buildBlinkTimes(duration);

      // 6. Render + compositing del personaje (ttchop-post)
      console.log(`[${jobId}] Renderizando personaje (ttchop-post)...`);
      const audioBase64Wav = readFileSync(wavPath).toString('base64');
      const charRes = await fetch(`${OVERLAY_SERVER}/character/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrl, audioBase64: audioBase64Wav, audioExt: 'wav',
          duration, mouthCues, browCues, bodyCues, blinkTimes,
          variant, testSeconds,
        }),
        timeout: 1_800_000,
      });
      if (!charRes.ok) {
        const err = await charRes.text();
        throw new Error(`ttchop-post /character/render error ${charRes.status}: ${err.slice(0, 300)}`);
      }
      const { createWriteStream } = await import('fs');
      const { pipeline: streamPipeline } = await import('stream/promises');
      await streamPipeline(charRes.body, createWriteStream(resultPath));

      // 7. Subir video final + audio (persistencia)
      console.log(`[${jobId}] Subiendo resultado...`);
      const filename = `character_${jobId}.mp4`;
      const publicUrl = await uploadToStorage(resultPath, filename, projectId);
      const audioUrl = await uploadFileToStorage(wavPath, `character/audio_${jobId}.wav`, 'audio/wav', projectId);

      // 8. Persistir script + audio + metadata
      await upsertRender({
        taskId: renderId,
        status: 'done',
        videoUrl: publicUrl,
        type: 'character',
        productId: product?.id || null,
        productName: product?.name || null,
        projectId,
        script: linesOut,
        audioUrl,
        characterMeta: {
          voiceId,
          rivVersion: RIV_VERSION,
          duration,
          renderedAt: new Date().toISOString(),
        },
      });

      console.log(`[${jobId}] DONE — ${publicUrl}`);
    } catch (err) {
      console.error(`[${jobId}] ERROR:`, err.message);
      try {
        await upsertRender({ taskId: renderId, status: 'failed', errorMessage: err.message, type: 'character', projectId });
      } catch (_) {}
    } finally {
      for (const f of [mp3Path, wavPath, resultPath]) {
        if (existsSync(f)) unlinkSync(f);
      }
    }
  });

  res.json({ status: 'pending', renderId, jobId, queuePosition: queuePos });
});

export default router;
