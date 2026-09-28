import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

const RHUBARB_BIN = path.join(process.cwd(), 'bin/rhubarb/rhubarb');

// Rhubarb phoneme → mouth_pos (0-6), validado con aato01_jointtest01.riv
const PHONEME_TO_MOUTH_POS = {
  X: 0, // mouth_idle (silencio)
  A: 1, // mouth_close (m, b, p)
  B: 2, // mouth_nr (n, r, rest)
  C: 3, D: 3, G: 3, // mouth_dst (d, s, t, k, g)
  E: 4, // mouth_ouw (o, u, w)
  H: 5, // mouth_aie (a, i, e)
  F: 6, // mouth_fv (f, v)
};

// brow_pos: 0=idle, 1=surprised, 2=annoyed, 3=sarcasm, 4=curious — BrowTest.jsx
// body_pos: 0=default, 1=fist01, 2=fist02, 3=pointing01, 4=pointing02, 5=hand01, 6=hand02, 7=thinking01, 8=thinking02 — BodyPosTest.jsx
// Mapeo validado con Cacho el 25 sep 2026 sobre MASCOT_EMOTIONS (collage.js).
export const EMOTION_TO_BROW = {
  curious: 4,
  surprised: 1,
  excited: 1,
  happily: 0,
  sarcastically: 3,
  annoyed: 2,
  sighs: 0,
  laughs: 0,
};

export const EMOTION_TO_BODY = {
  curious: 7,
  surprised: 5,
  excited: 2,
  happily: 0,
  sarcastically: 4,
  annoyed: 8,
  sighs: 0,
  laughs: 1,
};

// Corre Rhubarb sobre un WAV y regresa mouthCues en el formato que consume
// el componente de Remotion: [{ start, end, value }] con value = 0-6 (mouth_pos).
// Rhubarb necesita WAV (no mp3) — convertir con ffmpeg antes de llamar esto si hace falta.
export async function getMouthCues(wavPath) {
  if (!existsSync(RHUBARB_BIN)) {
    throw new Error(`Rhubarb binary no encontrado en ${RHUBARB_BIN}`);
  }
  const jsonPath = `${wavPath}.rhubarb.json`;
  try {
    await execFileAsync(RHUBARB_BIN, ['-r', 'phonetic', '-o', jsonPath, wavPath, '--exportFormat', 'json'], {
      timeout: 120_000,
    });
    const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
    return data.mouthCues.map(c => ({
      start: c.start,
      end: c.end,
      value: PHONEME_TO_MOUTH_POS[c.value] ?? 0,
    }));
  } finally {
    if (existsSync(jsonPath)) unlinkSync(jsonPath);
  }
}

// A partir de las líneas que devuelve /collage/dialogue/structured
// ({ text, emotion, startSec, endSec }), arma browCues y bodyCues.
export function buildEmotionCues(lines) {
  const browCues = lines.map(l => ({
    start: l.startSec,
    end: l.endSec,
    value: EMOTION_TO_BROW[l.emotion] ?? 0,
  }));
  const bodyCues = lines.map(l => ({
    start: l.startSec,
    end: l.endSec,
    value: EMOTION_TO_BODY[l.emotion] ?? 0,
  }));
  return { browCues, bodyCues };
}

// is_talking: true en cualquier tramo donde mouth_pos != 0 (silencio)
export function buildTalkingCues(mouthCues) {
  return mouthCues.map(c => ({ start: c.start, end: c.end, talking: c.value !== 0 }));
}

// Cuando el personaje reusa el audio YA sintetizado del collage (mismo diálogo,
// mismo audio real del video final) no hay alignment carácter-por-carácter de
// ElevenLabs para ese audio — solo tenemos el texto completo y la duración real.
// Aproxima startSec/endSec de cada línea repartiendo la duración total en
// proporción a la longitud de texto de cada línea (suficiente para brow/body
// cues, que no necesitan precisión fonética como el lip-sync de Rhubarb).
export function estimateLineTimings(lines, totalDuration) {
  const totalChars = lines.reduce((s, l) => s + l.text.length, 0) || 1;
  let elapsed = 0;
  return lines.map(l => {
    const share = l.text.length / totalChars;
    const start = elapsed;
    const end = elapsed + share * totalDuration;
    elapsed = end;
    return { text: l.text, emotion: l.emotion, startSec: start, endSec: end };
  });
}
