import { Router } from 'express';
import { callLLMJson } from '../pipeline/llm.js';
import { IMAGE_MODEL_IDS } from '../pipeline/kieai.js';
import {
  newCarouselId, newCallbackToken, createCarousel, getCarousel, updateCarousel, toPublicCarousel,
} from '../pipeline/carouselStore.js';
import { submitImageBatches, resolveKieTask, triggerComposition } from '../pipeline/carouselImages.js';

const router = Router();

const LANGUAGES = ['es', 'en', 'ja'];
const DEFAULT_NEGATIVE =
  'photorealistic photo, no text, no typography, no letters, no words, no signage, no logos, no watermarks, not an illustration, not 3D render';
const MIN_SLIDES = 5;
const MAX_SLIDES = 10;
const DEFAULT_SLIDES = 7;

function clampSlideCount(requested, scriptTemplate) {
  const min = scriptTemplate?.slideCount?.min || MIN_SLIDES;
  const max = Math.min(scriptTemplate?.slideCount?.max || MAX_SLIDES, MAX_SLIDES);
  const def = scriptTemplate?.slideCount?.default || DEFAULT_SLIDES;
  const n = Number(requested) || def;
  return Math.max(min, Math.min(max, n));
}

// Genera los textos de los slides + caption con el LLM. imagePrompt SIEMPRE en
// inglés (los modelos de imagen responden mejor en inglés); text/caption en el
// idioma del carrusel. El negative del styleTemplate se agrega a cada imagePrompt
// explícitamente en el prompt del LLM Y otra vez al armar el prompt final de kie
// (pipeline/carouselImages.js:buildBatchPrompt) — doble refuerzo porque el LLM no
// siempre obedece instrucciones de "nunca pidas texto en la imagen" al pie de la letra.
async function generateSlidesAndCaption({ script, scriptTemplate, styleTemplate, language, slideCount }) {
  const negative = styleTemplate.negative || DEFAULT_NEGATIVE;
  const roles = scriptTemplate.roles?.length
    ? scriptTemplate.roles
    : ['hook', ...Array(Math.max(slideCount - 2, 0)).fill('body'), 'cta'];

  const system =
    'You are an expert short-form social media copywriter and visual director. You write TikTok ' +
    '"Photo Mode" carousels designed to stop the scroll and earn follows. Respond ONLY with valid JSON, no markdown.';

  const user = `SCRIPT STRUCTURE (how to turn the raw script into slides):
${scriptTemplate.content}

VISUAL STYLE (shared direction for every slide's imagePrompt):
${styleTemplate.visualBible}
${styleTemplate.imagePromptHints ? `Hints for translating slide text into a scene: ${styleTemplate.imagePromptHints}` : ''}

RAW SCRIPT (source material provided by the user):
${script}

RULES:
- Produce exactly ${slideCount} slides, roles in this order: ${JSON.stringify(roles.slice(0, slideCount))}.
- Every slide "text" and the "caption" must be written in this language: ${language}.
- Every "imagePrompt" must ALWAYS be written in English, regardless of the slide language.
- Each imagePrompt describes a real photographed scene only: camera, lens, lighting, setting, subject. NEVER ask for any text, letters, words, numbers, logos, signage, or watermarks inside the image — the slide text is added later as a separate overlay, never painted into the photo itself.
- Append this exact negative instruction at the end of every imagePrompt: "${negative}"
${scriptTemplate.maxCharsPerSlide ? `- Each slide "text" must be ${scriptTemplate.maxCharsPerSlide} characters or fewer.` : ''}
${scriptTemplate.captionStyle ? `- Caption style: ${scriptTemplate.captionStyle}` : ''}

Respond with JSON exactly like:
{ "slides": [ { "index": 0, "role": "hook", "text": "...", "imagePrompt": "..." } ], "caption": "...", "hashtags": ["..."] }`;

  let result = await callLLMJson({ system, user });

  if (scriptTemplate.maxCharsPerSlide) {
    const violating = (result.slides || []).filter(s => (s.text || '').length > scriptTemplate.maxCharsPerSlide);
    if (violating.length > 0) {
      console.warn(`[carousel] ${violating.length} slide(s) excedieron maxCharsPerSlide, reintentando una vez (plan TTC-55 §5)`);
      const retryUser = `${user}\n\nIMPORTANT: your previous attempt had slide text longer than ${scriptTemplate.maxCharsPerSlide} characters on slide(s) ${violating.map(s => s.index).join(', ')}. Shorten EVERY slide's text to fit the limit this time.`;
      result = await callLLMJson({ system, user: retryUser });
    }
  }

  return result;
}

router.post('/create', async (req, res) => {
  const {
    userId, projectId, accountId, script, scriptTemplate, styleTemplate,
    scriptTemplateId, styleTemplateId, language, imageModel = 'seedream-v4',
    slideCount, dryRun, autoApprove,
  } = req.body;

  if (!userId) return res.status(400).json({ error: 'userId es requerido' });
  // projectId SIEMPRE explícito — nunca se infiere por default (plan TTC-55 §0.2, regla no negociable del issue).
  if (!projectId) return res.status(400).json({ error: 'projectId es requerido' });
  if (!script) return res.status(400).json({ error: 'script es requerido' });
  if (!LANGUAGES.includes(language)) return res.status(400).json({ error: `language debe ser uno de: ${LANGUAGES.join(', ')}` });
  if (!IMAGE_MODEL_IDS.includes(imageModel)) return res.status(400).json({ error: `imageModel debe ser uno de: ${IMAGE_MODEL_IDS.join(', ')}` });

  if (scriptTemplateId || styleTemplateId) {
    return res.status(400).json({ error: 'scriptTemplateId/styleTemplateId aún no se leen de Firestore (llegan en la Fase 3). Por ahora manda scriptTemplate/styleTemplate inline en el body.' });
  }
  if (!scriptTemplate?.content) return res.status(400).json({ error: 'scriptTemplate.content es requerido' });
  if (!styleTemplate?.visualBible) return res.status(400).json({ error: 'styleTemplate.visualBible es requerido' });

  const finalSlideCount = clampSlideCount(slideCount, scriptTemplate);
  const carouselId = newCarouselId();

  try {
    const { slides: rawSlides, caption, hashtags } = await generateSlidesAndCaption({
      script, scriptTemplate, styleTemplate, language, slideCount: finalSlideCount,
    });

    const slides = (rawSlides || []).map((s, i) => ({
      index: s.index ?? i,
      role: s.role || 'body',
      text: s.text || '',
      imagePrompt: s.imagePrompt || '',
      bg: { status: 'none' },
    }));

    const carousel = {
      id: carouselId,
      userId,
      accountId: accountId || null,
      projectId,
      status: 'text_review', // dryRun y la revisión normal se quedan aquí; autoApprove avanza abajo
      script,
      language,
      imageModel,
      scriptTemplate: { id: scriptTemplateId || null, title: scriptTemplate.title || null, snapshot: scriptTemplate },
      styleTemplate: { id: styleTemplateId || null, title: styleTemplate.title || null, snapshot: styleTemplate },
      seed: Math.floor(Math.random() * 1_000_000),
      slides,
      caption: caption || '',
      hashtags: hashtags || [],
      packageZipUrl: null,
      cost: { credits: 0 },
      kieTasks: {},
      callbackToken: newCallbackToken(),
      errorMessage: null,
    };

    await createCarousel(projectId, carousel);

    if (!dryRun && autoApprove) {
      await updateCarousel(projectId, carouselId, { status: 'generating_images' });
      const fresh = await getCarousel(projectId, carouselId);
      await submitImageBatches({ projectId, carouselId, carousel: fresh });
    }

    const final = await getCarousel(projectId, carouselId);
    res.json({ carouselId, carousel: toPublicCarousel(final) });
  } catch (err) {
    console.error('[carousel] /create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/approve-text', async (req, res) => {
  const { id } = req.params;
  const { projectId, slides: editedSlides, caption: editedCaption } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId es requerido' });

  try {
    const carousel = await getCarousel(projectId, id);
    if (!carousel) return res.status(404).json({ error: 'Carrusel no encontrado' });
    if (carousel.status !== 'text_review') {
      return res.status(409).json({ error: `El carrusel está en status "${carousel.status}", no en text_review` });
    }

    let slides = carousel.slides;
    if (Array.isArray(editedSlides)) {
      slides = carousel.slides.map(s => {
        const edit = editedSlides.find(e => e.index === s.index);
        return edit ? { ...s, text: edit.text ?? s.text, imagePrompt: edit.imagePrompt ?? s.imagePrompt } : s;
      });
    }
    const caption = typeof editedCaption === 'string' ? editedCaption : carousel.caption;

    await updateCarousel(projectId, id, { slides, caption, status: 'generating_images' });
    const fresh = await getCarousel(projectId, id);
    await submitImageBatches({ projectId, carouselId: id, carousel: fresh });

    const final = await getCarousel(projectId, id);
    res.json({ carousel: toPublicCarousel(final) });
  } catch (err) {
    console.error('[carousel] /approve-text error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Callback de kie.ai. Verificado e idempotente (plan TTC-55 §7):
// - token por carrusel en la query (nunca en el body)
// - el body NUNCA se usa como fuente de verdad, solo para sacar el taskId
// - recordInfo re-verifica state/resultUrls antes de aceptar nada
// - la escritura final es una transacción (carouselStore.completeBackgroundTask)
router.post('/callback', async (req, res) => {
  const { c: carouselId, p: projectId, slot, t: token } = req.query;
  try {
    if (!carouselId || !projectId || !token) {
      console.warn('[carousel/callback] faltan query params', req.query);
      return res.status(400).json({ error: 'c, p y t son requeridos' });
    }

    const carousel = await getCarousel(projectId, carouselId);
    if (!carousel) {
      console.warn(`[carousel/callback] carrusel no encontrado: ${carouselId} (proyecto ${projectId})`);
      return res.status(404).json({ error: 'not_found' });
    }
    if (carousel.callbackToken !== token) {
      console.warn(`[carousel/callback] token inválido para ${carouselId}`);
      return res.status(401).json({ error: 'invalid_token' });
    }

    const taskId = req.body?.data?.taskId || req.body?.taskId;
    if (!taskId) return res.status(400).json({ error: 'taskId no encontrado en el body' });

    const result = await resolveKieTask({ projectId, carouselId, taskId, slot });
    res.json({ ok: true, taskId, ...result });
  } catch (err) {
    console.error('[carousel/callback] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/regenerate', async (req, res) => {
  const { id } = req.params;
  const { projectId, slots, what = 'image' } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId es requerido' });
  if (!Array.isArray(slots) || slots.length === 0) return res.status(400).json({ error: 'slots (array de índices) es requerido' });

  try {
    const carousel = await getCarousel(projectId, id);
    if (!carousel) return res.status(404).json({ error: 'Carrusel no encontrado' });

    if (what === 'compose') {
      await triggerComposition({ projectId, carouselId: id });
      return res.json({ ok: true, what, triggered: true });
    }

    if (what === 'text') {
      const { slides: regenerated } = await generateSlidesAndCaption({
        script: carousel.script,
        scriptTemplate: carousel.scriptTemplate.snapshot,
        styleTemplate: carousel.styleTemplate.snapshot,
        language: carousel.language,
        slideCount: carousel.slides.length,
      });
      const slides = carousel.slides.map(s => {
        if (!slots.includes(s.index)) return s;
        const fresh = (regenerated || []).find(r => r.index === s.index) || (regenerated || [])[s.index];
        return fresh ? { ...s, text: fresh.text, imagePrompt: fresh.imagePrompt } : s;
      });
      await updateCarousel(projectId, id, { slides });
      const final = await getCarousel(projectId, id);
      return res.json({ ok: true, what, carousel: toPublicCarousel(final) });
    }

    // what === 'image' (default): reenvía SOLO esos slots a kie — 1 tarea individual
    // por slot (nunca batch), para no pagar ni tocar los slides que ya están bien.
    const targets = carousel.slides.filter(s => slots.includes(s.index));
    if (targets.length === 0) return res.status(400).json({ error: 'Ningún slot coincide con los índices del carrusel' });

    await submitImageBatches({ projectId, carouselId: id, carousel, targetSlides: targets });
    await updateCarousel(projectId, id, { status: 'generating_images' });

    const final = await getCarousel(projectId, id);
    res.json({ ok: true, what, carousel: toPublicCarousel(final) });
  } catch (err) {
    console.error('[carousel] /regenerate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Recompone con los mismos fondos — 0 créditos (plan TTC-55 §2).
router.post('/:id/recompose', async (req, res) => {
  const { id } = req.params;
  const { projectId, styleTemplate } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId es requerido' });

  try {
    const carousel = await getCarousel(projectId, id);
    if (!carousel) return res.status(404).json({ error: 'Carrusel no encontrado' });

    if (styleTemplate?.visualBible) {
      await updateCarousel(projectId, id, {
        styleTemplate: { id: null, title: styleTemplate.title || null, snapshot: styleTemplate },
      });
    }

    await triggerComposition({ projectId, carouselId: id });
    res.json({ ok: true, triggered: true });
  } catch (err) {
    console.error('[carousel] /recompose error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'projectId es requerido (query param)' });

  try {
    const carousel = await getCarousel(projectId, id);
    if (!carousel) return res.status(404).json({ error: 'Carrusel no encontrado' });
    res.json({ carousel: toPublicCarousel(carousel) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
