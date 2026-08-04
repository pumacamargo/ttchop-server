#!/usr/bin/env node
/**
 * watch_render.js — Polling de render en Firestore, notifica por Telegram cuando termina.
 * Uso: node watch_render.js <renderId> <chat_id> [intervalo_segundos]
 * Ejemplo: node watch_render.js render_1785816476_monitorarm 6407630145 120
 */

import 'dotenv/config';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import fetch from 'node-fetch';
import path from 'path';
import FormData from 'form-data';
import { createReadStream } from 'fs';

const [,, renderId, chatId, intervalArg] = process.argv;
if (!renderId || !chatId) {
  console.error('Uso: node watch_render.js <renderId> <chat_id> [intervalo_seg]');
  process.exit(1);
}

const INTERVAL_MS = (parseInt(intervalArg) || 120) * 1000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Init Firebase
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const PREFIX = '🤖 watcher:';

async function sendText(text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: `${PREFIX} ${text}` }),
  });
}

async function sendVideo(filePath, caption) {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', `${PREFIX} ${caption}`);
  form.append('video', createReadStream(filePath));
  await fetch(`${TG_API}/sendVideo`, { method: 'POST', body: form });
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  await pipeline(res.body, createWriteStream(dest));
}

async function check() {
  const doc = await db.collection('renders').doc(renderId).get();
  if (!doc.exists) return null;
  return doc.data();
}

async function main() {
  console.log(`⏳ Watching render: ${renderId} (cada ${INTERVAL_MS / 1000}s)`);
  await sendText(`⏳ Monitoring render ${renderId}...`);

  const poll = async () => {
    try {
      const render = await check();
      if (!render) {
        console.log('Render no encontrado todavía...');
        return;
      }

      if (render.status === 'done' && render.videoUrl) {
        console.log(`✅ Done! URL: ${render.videoUrl}`);
        const ext = render.videoUrl.includes('.mp4') ? '.mp4' : '.mp4';
        const tmpPath = `/tmp/watch_${renderId}${ext}`;

        try {
          await downloadFile(render.videoUrl, tmpPath);
          await sendVideo(tmpPath, `✅ ${renderId} listo!`);
          await unlink(tmpPath);
        } catch (e) {
          await sendText(`✅ ${renderId} listo!\n${render.videoUrl}`);
        }
        clearInterval(timer);
        process.exit(0);
      } else if (render.status === 'failed') {
        console.log('❌ Render falló');
        await sendText(`❌ Render ${renderId} falló.`);
        clearInterval(timer);
        process.exit(1);
      } else {
        console.log(`⏳ Status: ${render.status || 'pending'}...`);
      }
    } catch (err) {
      console.error('Poll error:', err.message);
    }
  };

  await poll();
  const timer = setInterval(poll, INTERVAL_MS);
}

main();
