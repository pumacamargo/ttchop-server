import fetch from 'node-fetch';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';

const BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

export async function textToSpeech({ text, voiceId, outputPath }) {
  const res = await fetch(
    `${BASE_URL}/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text, model_id: 'eleven_v3' }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs error ${res.status}: ${err.slice(0, 200)}`);
  }

  await pipeline(res.body, createWriteStream(outputPath));
  return outputPath;
}
