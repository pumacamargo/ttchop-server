import fetch from 'node-fetch';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';

const BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

// Fijado por Cacho el 26-sep-2026 tras comparar controles de audio (ver Telegram).
// Nota: speed=0.5 está por debajo del mínimo documentado por ElevenLabs (0.7) —
// la API no lo rechaza, pero probablemente lo clampea a 0.7 internamente sin avisar.
const VOICE_SETTINGS = {
  stability: 0.0,
  style: 0,
  similarity_boost: 0.0,
  use_speaker_boost: true,
  speed: 0.5,
};

export async function textToSpeech({ text, voiceId, outputPath }) {
  const res = await fetch(
    `${BASE_URL}/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text, model_id: 'eleven_v3', voice_settings: VOICE_SETTINGS }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs error ${res.status}: ${err.slice(0, 200)}`);
  }

  await pipeline(res.body, createWriteStream(outputPath));
  return outputPath;
}

// Igual que textToSpeech pero contra el endpoint /with-timestamps: devuelve el
// audio en base64 + el alignment (timing por carácter), en vez de escribir un
// archivo. No toca la función textToSpeech de arriba (usada por /collage/create).
export async function textToSpeechWithTimestamps({ text, voiceId }) {
  const res = await fetch(
    `${BASE_URL}/${voiceId}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text, model_id: 'eleven_v3', voice_settings: VOICE_SETTINGS }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    audioBase64: data.audio_base64,
    alignment: data.alignment,
    normalizedAlignment: data.normalized_alignment,
  };
}
