import 'dotenv/config';
import express from 'express';
import collageRoutes from './routes/collage.js';
import aiRoutes from './routes/ai.js';
import speedRampRoutes from './routes/speedramp.js';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json({ limit: '10mb' }));

app.use('/collage', collageRoutes);
app.use('/ai', aiRoutes);
app.use('/speedramp', speedRampRoutes);

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
});
