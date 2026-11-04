#!/usr/bin/env node
// Genera la voz de las líneas de un caso con el TTS del propio ttchop-server
// (ElevenLabs, pipeline/elevenlabs.js): una toma por línea del guion.
//
// Uso:  node tts_lines.mjs <lines.json> <dir_salida> [voiceId]
//
//   <lines.json>  array JSON de strings (una línea de guion por elemento).
//   <dir_salida>  directorio de trabajo donde se escriben line_01.mp3, line_02.mp3, ...
//   [voiceId]     id de voz ElevenLabs; por defecto PumaVoice01
//                 (ve7BOdejheJbgrBriBx4, fijado por Cacho).
//
// La API key se lee de ttchop-server/.env (variable ELEVENLABS_API_KEY) y NUNCA
// se imprime. La raíz del repo se resuelve a partir de la ruta de este propio
// script, así que funciona llamándolo desde cualquier cwd, sin rutas absolutas
// hardcodeadas.
//
// Corre en vps-projects y necesita el node_modules del repo (pipeline/elevenlabs.js
// importa `node-fetch`).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');

const DEFAULT_VOICE_ID = 've7BOdejheJbgrBriBx4'; // PumaVoice01 (fijado por Cacho)

const linesFile = process.argv[2];
const outDir = process.argv[3];
const voiceId = process.argv[4] || DEFAULT_VOICE_ID;
if (!linesFile || !outDir) {
  console.error('uso: node tts_lines.mjs <lines.json> <dir_salida> [voiceId]');
  process.exit(1);
}

const envPath = path.join(REPO, '.env');
const envTxt = fs.readFileSync(envPath, 'utf8');
for (const ln of envTxt.split('\n')) {
  const m = ln.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.ELEVENLABS_API_KEY) {
  console.error(`falta ELEVENLABS_API_KEY en ${envPath}`);
  process.exit(1);
}

const { textToSpeech } = await import(path.join(REPO, 'pipeline/elevenlabs.js'));

const lines = JSON.parse(fs.readFileSync(linesFile, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

console.log(`lineas=${lines.length} voice=${voiceId} -> ${outDir}`);
let i = 0;
for (const text of lines) {
  i++;
  const name = `line_${String(i).padStart(2, '0')}`;
  const out = path.join(outDir, `${name}.mp3`);
  await textToSpeech({ text, voiceId, outputPath: out });
  console.log(`${name} ok chars=${text.length} bytes=${fs.statSync(out).size}`);
}
console.log('TTS_LISTO');
