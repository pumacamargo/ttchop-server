import { Router } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';
import fetch from 'node-fetch';
import { pipeline as streamPipeline } from 'stream/promises';

import { getRender, upsertRender } from '../pipeline/firestore.js';
import { uploadToStorage } from '../pipeline/storage.js';
import { enqueue } from '../pipeline/jobQueue.js';

const execAsync = promisify(exec);
const router = Router();
const TEMP_DIR = '/tmp/ttchop_mix';

async function ensureTempDir() {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
}

// Detecta silencios en el audio. Devuelve [{start, end}].
async function detectSilences(audioPath, noiseDb = -35, minDur = 0.1) {
  const { stderr } = await execAsync(
    `ffmpeg -i "${audioPath}" -af "silencedetect=noise=${noiseDb}dB:duration=${minDur}" -f null - 2>&1`,
    { timeout: 30000 }
  );
  const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map(m => parseFloat(m[1]));
  const ends   = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map(m => parseFloat(m[1]));
  return starts.map((s, i) => ({ start: s, end: ends[i] ?? Infinity }));
}

// Devuelve true si el timestamp cae durante habla activa (no en silencio).
function isSpeech(t, silences) {
  return !silences.some(s => t >= s.start && t <= (s.end ?? Infinity));
}

// Dado el script con timestamps y los silencios detectados, calcula los
// puntos de corte para que:
//  - Ningún segmento dure más de maxSecs
//  - Cada corte cae durante habla activa (no en silencio)
//  - Los límites de línea se usan como puntos de corte naturales
function calculateCutPoints(script, totalDuration, silences, maxSecs) {
  const cuts = new Set([0, totalDuration]);

  for (const line of script) {
    const { startSec, endSec } = line;

    // El final de cada línea es un corte natural.
    // Si cae en silencio, retroceder al inicio del silencio (última habla).
    let lineEnd = endSec;
    const silAtEnd = silences.find(s => lineEnd > s.start && lineEnd <= (s.end ?? Infinity));
    if (silAtEnd) lineEnd = silAtEnd.start;
    if (lineEnd > 0.5 && lineEnd < totalDuration - 0.2) cuts.add(parseFloat(lineEnd.toFixed(3)));

    // Si la línea es más larga que maxSecs, insertar cortes intermedios.
    const dur = endSec - startSec;
    if (dur > maxSecs) {
      let t = startSec + maxSecs;
      while (t < endSec - 0.5) {
        // Si t cae en silencio, avanzar al próximo inicio de habla.
        const silAt = silences.find(s => t >= s.start && t <= (s.end ?? Infinity));
        const cutT = silAt ? silAt.end : t;
        if (cutT < endSec - 0.3 && isSpeech(cutT, silences)) {
          cuts.add(parseFloat(cutT.toFixed(3)));
        }
        t = cutT + maxSecs;
      }
    }
  }

  return [...cuts].sort((a, b) => a - b);
}

// POST /mix/create
// Body:
//   renderId         — para leer script y timestamps de Firestore
//   projectId        — ttchop | ttchop2
//   videoUrls        — array de URLs de videos a ciclar (mismo audio, misma duración)
//   maxSegmentSeconds — duración máxima por segmento (default 3)
//   startIndex       — índice del primer video en el ciclo (default 0)
router.post('/create', async (req, res) => {
  const { renderId, projectId, videoUrls, maxSegmentSeconds = 3, startIndex = 0 } = req.body;

  if (!renderId || !videoUrls || videoUrls.length < 2) {
    return res.status(400).json({ error: 'renderId y videoUrls (mínimo 2) son requeridos' });
  }

  const jobId = randomBytes(6).toString('hex');

  const queuePos = enqueue(jobId, async () => {
    try {
      await ensureTempDir();
      await upsertRender({ taskId: renderId, status: 'processing', type: 'mix', projectId });

      // 1. Leer script con timestamps de Firestore
      const existing = await getRender(renderId, projectId);
      if (!existing?.script?.length) {
        throw new Error('No hay script con timestamps en Firestore para este renderId');
      }
      const script = existing.script;
      const totalDuration = script[script.length - 1].endSec;

      // 2. Descargar todos los videos
      console.log(`[${jobId}] Descargando ${videoUrls.length} videos...`);
      const videoPaths = [];
      for (let i = 0; i < videoUrls.length; i++) {
        const p = `${TEMP_DIR}/mix_input_${jobId}_${i}.mp4`;
        const r = await fetch(videoUrls[i]);
        if (!r.ok) throw new Error(`Error descargando video ${i}: HTTP ${r.status}`);
        await streamPipeline(r.body, createWriteStream(p));
        videoPaths.push(p);
      }

      // 3. Extraer audio del primer video para detectar silencios
      const audioPath = `${TEMP_DIR}/mix_audio_${jobId}.wav`;
      await execAsync(`ffmpeg -v error -y -i "${videoPaths[0]}" -vn "${audioPath}"`, { timeout: 60000 });
      const silences = await detectSilences(audioPath);
      console.log(`[${jobId}] Silencios detectados: ${silences.length}`);

      // 4. Calcular puntos de corte
      const cutPoints = calculateCutPoints(script, totalDuration, silences, maxSegmentSeconds);
      console.log(`[${jobId}] Puntos de corte: ${cutPoints.join(', ')}`);

      // 5. Construir filter_complex ciclando entre los videos
      const n = videoPaths.length;
      const filterParts = [];
      const segLabels = [];

      for (let i = 0; i < cutPoints.length - 1; i++) {
        const start = cutPoints[i];
        const end   = cutPoints[i + 1];
        const videoIdx = (startIndex + i) % n;
        const label = `s${i}`;
        filterParts.push(`[${videoIdx}:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[${label}]`);
        segLabels.push(`[${label}]`);
      }

      const concatFilter = `${segLabels.join('')}concat=n=${segLabels.length}:v=1:a=0[vout]`;
      filterParts.push(concatFilter);
      const filterComplex = filterParts.join(';');

      // 6. Armar inputs ffmpeg
      const inputs = videoPaths.map(p => `-i "${p}"`).join(' ');
      const outPath = `${TEMP_DIR}/mix_out_${jobId}.mp4`;

      const cmd = [
        'ffmpeg -y',
        inputs,
        `-filter_complex "${filterComplex}"`,
        '-map "[vout]" -map 0:a',
        '-c:v libx264 -preset fast -crf 18',
        '-c:a aac -b:a 192k',
        `"${outPath}"`,
      ].join(' ');

      console.log(`[${jobId}] Renderizando mix (${segLabels.length} segmentos)...`);
      await execAsync(cmd, { timeout: 300000 });

      // 7. Subir resultado
      const filename = `mix_${jobId}.mp4`;
      const publicUrl = await uploadToStorage(outPath, filename, projectId);

      await upsertRender({
        taskId: renderId,
        status: 'done',
        videoUrl: publicUrl,
        type: 'mix',
        projectId,
        inputs: { mix: { videoUrls, maxSegmentSeconds, startIndex, cutPoints } },
      });

      console.log(`[${jobId}] DONE — ${publicUrl}`);
    } catch (err) {
      console.error(`[${jobId}] mix/create ERROR:`, err.message);
      await upsertRender({ taskId: renderId, status: 'failed', errorMessage: err.message, projectId });
    } finally {
      // Limpiar archivos temporales
      try {
        const files = [
          ...Array.from({ length: videoUrls.length }, (_, i) => `${TEMP_DIR}/mix_input_${jobId}_${i}.mp4`),
          `${TEMP_DIR}/mix_audio_${jobId}.wav`,
          `${TEMP_DIR}/mix_out_${jobId}.mp4`,
        ];
        for (const f of files) { try { if (existsSync(f)) unlinkSync(f); } catch {} }
      } catch {}
    }
  });

  res.json({ status: 'pending', renderId, jobId, queuePosition: queuePos });
});

export default router;
