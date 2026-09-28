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
// ffmpeg escribe silencedetect a stderr; no usar 2>&1 para que llegue correctamente.
async function detectSilences(audioPath, noiseDb = -35, minDur = 0.05) {
  let output = '';
  try {
    const r = await execAsync(
      `ffmpeg -i "${audioPath}" -af "silencedetect=noise=${noiseDb}dB:duration=${minDur}" -f null -`,
      { timeout: 30000 }
    );
    output = r.stderr || r.stdout || '';
  } catch (e) {
    output = e.stderr || e.stdout || '';
  }
  const starts = [...output.matchAll(/silence_start: ([\d.]+)/g)].map(m => parseFloat(m[1]));
  const ends   = [...output.matchAll(/silence_end: ([\d.]+)/g)].map(m => parseFloat(m[1]));
  return starts.map((s, i) => ({ start: s, end: ends[i] ?? Infinity }));
}

// Detecta transientes: momentos donde el audio SUBE sobre -18dB (inicio de sílaba fuerte).
async function detectLoudTransients(audioPath) {
  let output = '';
  try {
    const r = await execAsync(
      `ffmpeg -i "${audioPath}" -af "silencedetect=noise=-18dB:duration=0.02" -f null -`,
      { timeout: 30000 }
    );
    output = r.stderr || r.stdout || '';
  } catch (e) {
    output = e.stderr || e.stdout || '';
  }
  return [...output.matchAll(/silence_end: ([\d.]+)/g)].map(m => parseFloat(m[1]));
}

// Devuelve true si el timestamp cae durante habla activa (no en silencio).
function isSpeech(t, silences) {
  return !silences.some(s => t >= s.start && t <= (s.end ?? Infinity));
}

// Detecta cambios de escena en el video (cortes entre clips del collage).
// Devuelve array de timestamps donde hay un cut visual.
async function detectSceneCuts(videoPath, threshold = 0.25) {
  let output = '';
  try {
    const r = await execAsync(
      `ffmpeg -i "${videoPath}" -vf "select='gt(scene,${threshold})',showinfo" -vsync vfr -f null -`,
      { timeout: 120000 }
    );
    output = r.stderr || r.stdout || '';
  } catch (e) {
    output = e.stderr || e.stdout || '';
  }
  // showinfo imprime "pts_time:X" por cada frame seleccionado
  const timestamps = [...output.matchAll(/pts_time:([\d.]+)/g)].map(m => parseFloat(m[1]));
  // Dedup por si hay frames consecutivos muy juntos (<0.1s)
  return timestamps.filter((t, i) => i === 0 || t - timestamps[i - 1] > 0.1);
}

// Dado un tiempo propuesto t, busca el transiente más cercano dentro de ±windowSec.
// transients: array de timestamps (floats) de inicio de habla fuerte.
function snapToTransient(t, transients, windowSec = 0.5) {
  const nearby = transients.filter(ts => ts >= t - windowSec && ts <= t + windowSec);
  if (nearby.length === 0) return t;
  return nearby.reduce((best, ts) => Math.abs(ts - t) < Math.abs(best - t) ? ts : best, nearby[0]);
}

// Calcula puntos de corte anclados a transientes de audio (inicio de habla fuerte),
// que es donde el volumen SUBE — los cortes más enérgicos y naturales.
function calculateCutPoints(script, totalDuration, silences, transients, maxSecs) {
  const cuts = new Set([0, totalDuration]);

  for (const line of script) {
    const { startSec, endSec } = line;

    // Corte natural al final de cada línea, anclado al transiente más cercano.
    const t = snapToTransient(endSec, transients);
    if (t > 0.5 && t < totalDuration - 0.2) cuts.add(parseFloat(t.toFixed(3)));

    // Si la línea es más larga que maxSecs, insertar cortes intermedios.
    const dur = endSec - startSec;
    if (dur > maxSecs) {
      let cursor = startSec + maxSecs;
      while (cursor < endSec - 0.5) {
        const snapped = snapToTransient(cursor, transients);
        if (snapped > 0.5 && snapped < totalDuration - 0.2) {
          cuts.add(parseFloat(snapped.toFixed(3)));
        }
        cursor = snapped + maxSecs;
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

      // 3. Extraer audio y detectar escenas del primer video (collage)
      const audioPath = `${TEMP_DIR}/mix_audio_${jobId}.wav`;
      await execAsync(`ffmpeg -v error -y -i "${videoPaths[0]}" -vn "${audioPath}"`, { timeout: 60000 });
      const [silences, transients, sceneCuts] = await Promise.all([
        detectSilences(audioPath),
        detectLoudTransients(audioPath),
        detectSceneCuts(videoPaths[0]),
      ]);
      console.log(`[${jobId}] Transientes: ${transients.length} | Scene cuts collage: ${sceneCuts.length} → ${sceneCuts.map(t=>t.toFixed(2)).join(', ')}`);

      // 4. Calcular puntos de corte basados en audio y luego jalarlos al
      //    scene cut del collage más cercano (si hay uno dentro de ±1.2s).
      //    Así el switch de video siempre cae sobre un corte que ya existía en el collage.
      const SCENE_SNAP_WINDOW = 1.2; // segundos de margen para buscar un scene cut cercano
      let rawCuts = calculateCutPoints(script, totalDuration, silences, transients, maxSegmentSeconds);
      const cutPoints = rawCuts.map(t => {
        if (t === 0 || t === totalDuration) return t;
        const nearby = sceneCuts.filter(s => Math.abs(s - t) <= SCENE_SNAP_WINDOW);
        if (nearby.length === 0) return t; // sin scene cut cercano, mantener el original
        // El scene cut más cercano al tiempo propuesto
        const snapped = nearby.reduce((best, s) => Math.abs(s - t) < Math.abs(best - t) ? s : best, nearby[0]);
        return parseFloat(snapped.toFixed(3));
      });
      // Eliminar duplicados que pudieran surgir si dos cuts se jalan al mismo scene cut
      const uniqueCuts = [...new Set(cutPoints)].sort((a, b) => a - b);
      console.log(`[${jobId}] Cortes (raw): ${rawCuts.join(', ')}`);
      console.log(`[${jobId}] Cortes (snapped a scene): ${uniqueCuts.join(', ')}`);

      // 5. Construir filter_complex ciclando entre los videos
      const n = videoPaths.length;
      const filterParts = [];
      const segLabels = [];

      for (let i = 0; i < uniqueCuts.length - 1; i++) {
        const start = uniqueCuts[i];
        const end   = uniqueCuts[i + 1];
        const videoIdx = (startIndex + i) % n;
        const label = `s${i}`;
        filterParts.push(`[${videoIdx}:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[${label}]`);
        segLabels.push(`[${label}]`);
      }

      const concatFilter = `${segLabels.join('')}concat=n=${segLabels.length}:v=1:a=0[vout]`;
      // (uniqueCuts used above, cutPoints alias kept for Firestore save below)
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
        inputs: { mix: { videoUrls, maxSegmentSeconds, startIndex, cutPoints: uniqueCuts, sceneCuts } },
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
