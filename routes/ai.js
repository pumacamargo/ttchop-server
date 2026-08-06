import { Router } from 'express';
import { callLLMJson } from '../pipeline/llm.js';
import { generateVeo3, generateSeedance } from '../pipeline/kieai.js';
import { upsertRender } from '../pipeline/firestore.js';

const router = Router();

// POST /ai/prompt
// Body: { productDescription, aiTemplate: { content }, language }
// Genera el prompt de video para Seedance/Veo3
router.post('/prompt', async (req, res) => {
  const { productDescription, aiTemplate, language } = req.body;

  if (!productDescription || !aiTemplate?.content) {
    return res.status(400).json({ error: 'productDescription y aiTemplate.content son requeridos' });
  }

  try {
    const result = await callLLMJson({
      system: `You are an expert AI video prompt engineer specialized in creating high-quality prompts for modern AI video generation systems such as Seedance, Veo and similar models.
Respond ONLY with valid JSON, no markdown.`,
      user: `Generate the final video generation output based on this information.

PRODUCT INFORMATION:
Description: ${productDescription}

VIDEO TEMPLATE DESCRIPTION:
${aiTemplate.content}

VIDEO LANGUAGE: ${language || 'spanish'}

Respond with JSON: { "prompt": "...", "notes": "..." }`,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /ai/generate
// Body: { prompt, imageUrl, model: 'veo3'|'seedance', aspectRatio?, duration?, callBackUrl? }
router.post('/generate', async (req, res) => {
  const { prompt, imageUrls, imageUrl, model = 'seedance', aspectRatio, callBackUrl, resolution, duration, generateAudio } = req.body;
  const images = imageUrls || (imageUrl ? [imageUrl] : null);

  if (!prompt || !images?.length) {
    return res.status(400).json({ error: 'prompt e imageUrls son requeridos' });
  }

  try {
    let result;
    if (model === 'veo3') {
      result = await generateVeo3({ prompt, imageUrls: images, aspectRatio, callBackUrl });
    } else {
      result = await generateSeedance({ prompt, imageUrls: images, callBackUrl, aspectRatio, resolution, duration, generateAudio });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /ai/callback
// Callback de kie.ai cuando el video de Seedance está listo
router.post('/callback', async (req, res) => {
  try {
    const body = req.body;
    const data = body.data || {};

    let videoUrl = null;
    if (data.resultJson) {
      videoUrl = JSON.parse(data.resultJson).resultUrls?.[0] || null;
    } else if (data.info?.resultUrls) {
      videoUrl = data.info.resultUrls[0];
    }

    const taskId = data.taskId;
    const isError = body.code !== 200 || !videoUrl;

    const finalStatus = isError ? 'failed' : 'done';

    await upsertRender({
      taskId,
      status: finalStatus,
      videoUrl,
      errorMessage: isError ? (body.msg || 'Video generation failed') : null,
    });

    // syncScheduledRenderStatus is called automatically inside upsertRender

    res.json({ ok: true, taskId, status: finalStatus });
  } catch (err) {
    console.error('/ai/callback error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
