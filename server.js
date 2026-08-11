import 'dotenv/config';
import express from 'express';
import collageRoutes from './routes/collage.js';
import aiRoutes from './routes/ai.js';
import speedRampRoutes from './routes/speedramp.js';
import overlayRoutes from './routes/overlay.js';
import { startScheduler } from './pipeline/scheduler.js';

const app = express();
const PORT = process.env.PORT || 3002;

const ALLOWED_ORIGINS = [
  'https://ttchop.web.app',
  'https://ttchop.firebaseapp.com',
  'https://ttchop2.web.app',
  'https://ttchop2.firebaseapp.com',
  'http://localhost:5173',
  'http://localhost:3000',
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '10mb' }));

app.use('/collage', collageRoutes);
app.use('/ai', aiRoutes);
app.use('/speedramp', speedRampRoutes);
app.use('/overlay', overlayRoutes);

app.get('/health', (_, res) => res.json({
  status: 'ok',
  routes: [
    'POST /collage/dialogue',
    'POST /collage/create',
    'POST /ai/prompt',
    'POST /ai/generate',
    'POST /ai/callback',
    'POST /speedramp/create',
  ],
  uptime: process.uptime(),
}));

app.listen(PORT, () => {
  console.log(`ttchop-server 🎬 corriendo en puerto ${PORT}`);
  startScheduler();
});
