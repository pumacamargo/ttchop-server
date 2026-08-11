import { Router } from 'express';
import { callLLMJson } from '../pipeline/llm.js';
import { generateVeo3, generateSeedance } from '../pipeline/kieai.js';
import { upsertRender } from '../pipeline/firestore.js';
import { getDb, getConfiguredProjects, DEFAULT_PROJECT_ID } from '../pipeline/firebase.js';

const router = Router();

// kie.ai llama a /ai/callback directamente y NO manda projectId (no lo conoce,
// ni tiene por qué). El render se identifica solo por taskId, así que para
// saber a qué proyecto (ttchop / ttchop2) hay que escribirle, buscamos el
// documento renders/{taskId} en cada proyecto configurado y usamos el primero
// donde exista. El doc pending ya se creó antes en el proyecto correcto — por
// /collage o /ai vía este mismo servidor, o por la webapp directamente vía su
// SDK de Firestore — así que para el momento del callback casi siempre existe.
// Si no aparece en ninguno (caso raro), caemos al proyecto por defecto: es
// preferible escribir en el lugar de siempre que perder el update.
async function findProjectForRender(taskId) {
  if (!taskId) return DEFAULT_PROJECT_ID;
  for (const projectId of getConfiguredProjects()) {
    try {
      const snap = await getDb(projectId).collection('renders').doc(taskId).get();
      if (snap.exists) return projectId;
    } catch (err) {
      console.error(`[ai/callback] error buscando taskId ${taskId} en ${projectId}:`, err.message);
    }
  }
  return DEFAULT_PROJECT_ID;
}

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
  const rawImages = imageUrls || (imageUrl ? [imageUrl] : []);
  const images = (Array.isArray(rawImages) ? rawImages : [rawImages]).filter(Boolean);

  if (!prompt) {
    return res.status(400).json({ error: 'prompt es requerido' });
  }
  if (!images.length) {
    return res.status(400).json({ error: 'El producto no tiene imágenes de model sheet. Súbelas en la sección de Clips del producto.' });
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
    const projectId = await findProjectForRender(taskId);

    await upsertRender({
      taskId,
      status: finalStatus,
      videoUrl,
      errorMessage: isError ? (body.msg || 'Video generation failed') : null,
      projectId,
    });

    // syncScheduledRenderStatus is called automatically inside upsertRender

    res.json({ ok: true, taskId, status: finalStatus });
  } catch (err) {
    console.error('/ai/callback error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
