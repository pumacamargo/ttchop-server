import { Router } from 'express';
import { getAuth } from 'firebase-admin/auth';
import { getCarouselAuthApp, getConfiguredProjects, getDb } from '../pipeline/firebase.js';
import { callLLMJson as defaultCallLLMJson } from '../pipeline/llm.js';
import { IMAGE_MODEL_IDS } from '../pipeline/kieai.js';
import { matchCarouselBackgrounds } from '../pipeline/carouselReuse.js';
import {
  newCarouselId, newCallbackToken, createCarousel as defaultCreateCarousel, getCarousel as defaultGetCarousel, updateCarousel as defaultUpdateCarousel, toPublicCarousel, getTemplateById as defaultGetTemplateById,
} from '../pipeline/carouselStore.js';
import { submitImageBatches as defaultSubmitImageBatches, resolveKieTask as defaultResolveKieTask, triggerComposition as defaultTriggerComposition } from '../pipeline/carouselImages.js';

// Keep callback independent of Firebase ID authentication; every other route is gated.
export function createCarouselRouter(deps = {}) {
const router = Router();
const {
  getCarousel = defaultGetCarousel, createCarousel = defaultCreateCarousel,
  updateCarousel = defaultUpdateCarousel, getTemplateById = defaultGetTemplateById,
  submitImageBatches = defaultSubmitImageBatches, resolveKieTask = defaultResolveKieTask,
  triggerComposition = defaultTriggerComposition, configuredProjects = getConfiguredProjects,
  verifyToken = token => getAuth(getCarouselAuthApp()).verifyIdToken(token),
  getAccount = async (projectId, id) => {
    const snap = await getDb(projectId).collection('tiktok_accounts').doc(id).get();
    return snap.exists ? snap.data() : null;
  },
  deleteCarousel = async (projectId, id) => getDb(projectId).collection('carousels').doc(id).delete(),
  callLLMJson = defaultCallLLMJson,
  generateSlides = args => generateSlidesAndCaption({ ...args, callLLMJson }),
  matchBackgrounds = matchCarouselBackgrounds,
  listCarousels = async (projectId, userId) => {
    const snap = await getDb(projectId).collection('carousels').where('userId', '==', userId).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
} = deps;

function project(req) { return req.method === 'GET' ? req.query.projectId : req.body?.projectId; }
function account(req) { return req.method === 'GET' ? req.query.accountId : req.body?.accountId; }
function general(id) { return id === undefined || id === null || id === ''; }
function sameAccount(a, b) { return general(a) ? general(b) : a === b; }
function owned(doc, req) {
  return doc?.projectId === 'ttchop2' && doc?.userId === req.userId && sameAccount(doc.accountId, account(req));
}
async function requireOwned(req, res) {
  const doc = await getCarousel('ttchop2', req.params.id);
  if (!owned(doc, req)) { res.status(404).json({ error: 'Carrusel no encontrado' }); return null; }
  return doc;
}
router.use(async (req, res, next) => {
  if (req.path === '/callback' && req.method === 'POST') return next();
  const header = req.get('Authorization') || '';
  if (!/^Bearer [^ ]+$/.test(header)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = await verifyToken(header.slice(7));
    if (!decoded?.uid) return res.status(401).json({ error: 'Unauthorized' });
    req.userId = decoded.uid;
  } catch { return res.status(401).json({ error: 'Unauthorized' }); }
  if (project(req) !== 'ttchop2') return res.status(400).json({ error: 'projectId debe ser ttchop2' });
  if (!configuredProjects().includes('ttchop2')) return res.status(503).json({ error: 'ttchop2 no configurado' });
  next();
});

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
async function generateSlidesAndCaption({ script, scriptTemplate, styleTemplate, language, slideCount, callLLMJson }) {
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

async function advanceApproved({ projectId, carouselId, carousel }) {
  let current = carousel;
  if (current.reuseBackgrounds === true) {
    const candidates = (await listCarousels(projectId, current.userId)).filter(c => c.id !== current.id && sameAccount(c.accountId, current.accountId));
    const result = await matchBackgrounds({ targetCarousel: current, targetSlides: current.slides, trustedCandidates: candidates, callLLMJson, getCarousel });
    const matched = new Map(result.matches.map(m => [m.targetSlideIndex, m]));
    const slides = current.slides.map(slide => {
      const match = matched.get(slide.index);
      return match ? { ...slide, bg: { status: 'done', url: match.url, storagePath: match.storagePath } } : slide;
    });
    await updateCarousel(projectId, carouselId, { slides });
    current = { ...current, slides };
    const unmatched = new Set(result.unmatchedSlideIndices);
    if (!unmatched.size) return triggerComposition({ projectId, carouselId });
    return submitImageBatches({ projectId, carouselId, carousel: current, targetSlides: slides.filter(s => unmatched.has(s.index)) });
  }
  return submitImageBatches({ projectId, carouselId, carousel: current });
}

router.post('/create', async (req, res) => {
  const {
    projectId, accountId, script,
    scriptTemplate: inlineScriptTemplate, styleTemplate: inlineStyleTemplate,
    scriptTemplateId, styleTemplateId, language, imageModel = 'seedream-v4',
    slideCount, dryRun, autoApprove, reuseBackgrounds = false,
  } = req.body;

  const userId = req.userId;
  if (!general(accountId)) {
    try {
      const linked = await getAccount(projectId, `${userId}_${accountId}`);
      if (linked?.userId !== userId || linked?.openId !== accountId) return res.status(403).json({ error: 'Cuenta no autorizada' });
    } catch {
      return res.status(500).json({ error: 'Error verificando cuenta' });
    }
  }
  // projectId SIEMPRE explícito — nunca se infiere por default (plan TTC-55 §0.2, regla no negociable del issue).
  if (!projectId) return res.status(400).json({ error: 'projectId es requerido' });
  if (!script) return res.status(400).json({ error: 'script es requerido' });
  if (!LANGUAGES.includes(language)) return res.status(400).json({ error: `language debe ser uno de: ${LANGUAGES.join(', ')}` });
  if (!IMAGE_MODEL_IDS.includes(imageModel)) return res.status(400).json({ error: `imageModel debe ser uno de: ${IMAGE_MODEL_IDS.join(', ')}` });

  let scriptTemplate = inlineScriptTemplate;
  let styleTemplate = inlineStyleTemplate;

  try {
    // Fase 3 (TTC-55 §4): "El server lee los templates por id y guarda un snapshot".
    // scriptTemplateId/styleTemplateId tienen prioridad sobre el inline si ambos llegan.
    if (scriptTemplateId) {
      scriptTemplate = await getTemplateById(projectId, scriptTemplateId);
      if (scriptTemplate?.userId !== userId || scriptTemplate?.type !== 'carousel_script' || (!general(scriptTemplate.accountId) && !sameAccount(scriptTemplate.accountId, accountId))) return res.status(404).json({ error: 'Script template no encontrado' });
    }
    if (styleTemplateId) {
      styleTemplate = await getTemplateById(projectId, styleTemplateId);
      if (styleTemplate?.userId !== userId || styleTemplate?.type !== 'carousel_style' || (!general(styleTemplate.accountId) && !sameAccount(styleTemplate.accountId, accountId))) return res.status(404).json({ error: 'Style template no encontrado' });
    }
  } catch (err) {
    console.error('[carousel] operation failed');
    return res.status(500).json({ error: 'Error procesando carrusel' });
  }

  if (!scriptTemplate?.content) return res.status(400).json({ error: 'scriptTemplate.content es requerido (inline o vía scriptTemplateId)' });
  if (!styleTemplate?.visualBible) return res.status(400).json({ error: 'styleTemplate.visualBible es requerido (inline o vía styleTemplateId)' });

  const finalSlideCount = clampSlideCount(slideCount, scriptTemplate);
  const carouselId = newCarouselId();

  try {
    const { slides: rawSlides, caption, hashtags } = await generateSlides({
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
      reuseBackgrounds: reuseBackgrounds === true,
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
      await advanceApproved({ projectId, carouselId, carousel: fresh });
    }

    const final = await getCarousel(projectId, carouselId);
    res.json({ carouselId, carousel: toPublicCarousel(final) });
  } catch (err) {
    console.error('[carousel] operation failed');
    res.status(500).json({ error: 'Error procesando carrusel' });
  }
});

router.post('/:id/approve-text', async (req, res) => {
  const { id } = req.params;
  const { projectId, slides: editedSlides, caption: editedCaption } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId es requerido' });

  try {
    const carousel = await requireOwned(req, res);
    if (!carousel) return;
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
    await advanceApproved({ projectId, carouselId: id, carousel: fresh });

    const final = await getCarousel(projectId, id);
    res.json({ carousel: toPublicCarousel(final) });
  } catch (err) {
    console.error('[carousel] operation failed');
    res.status(500).json({ error: 'Error procesando carrusel' });
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
    if (projectId !== 'ttchop2' || !configuredProjects().includes('ttchop2')) return res.status(400).json({ error: 'invalid_project' });
    if (!carouselId || !token) {
      console.warn('[carousel/callback] faltan query params', { hasCarouselId: Boolean(carouselId), projectId: typeof projectId === 'string' ? projectId : null, hasToken: Boolean(token) });
      return res.status(400).json({ error: 'c, p y t son requeridos' });
    }

    const carousel = await getCarousel(projectId, carouselId);
    if (!carousel || carousel.projectId !== projectId) {
      console.warn('[carousel/callback] carrusel no encontrado');
      return res.status(404).json({ error: 'not_found' });
    }
    if (typeof token !== 'string' || carousel.callbackToken !== token) {
      console.warn('[carousel/callback] token inválido');
      return res.status(401).json({ error: 'invalid_token' });
    }

    const taskId = req.body?.data?.taskId || req.body?.taskId;
    if (!taskId) return res.status(400).json({ error: 'taskId no encontrado en el body' });

    const result = await resolveKieTask({ projectId, carouselId, taskId, slot });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[carousel] operation failed');
    res.status(500).json({ error: 'Error procesando carrusel' });
  }
});

router.post('/:id/regenerate', async (req, res) => {
  const { id } = req.params;
  const { projectId, slots, what = 'image' } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId es requerido' });
  if (!Array.isArray(slots) || slots.length === 0) return res.status(400).json({ error: 'slots (array de índices) es requerido' });

  try {
    const carousel = await requireOwned(req, res);
    if (!carousel) return;

    if (what === 'compose') {
      await triggerComposition({ projectId, carouselId: id });
      return res.json({ ok: true, what, triggered: true });
    }

    if (what === 'text') {
      const { slides: regenerated } = await generateSlides({
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
    console.error('[carousel] operation failed');
    res.status(500).json({ error: 'Error procesando carrusel' });
  }
});

// Recompone con los mismos fondos — 0 créditos (plan TTC-55 §2).
router.post('/:id/recompose', async (req, res) => {
  const { id } = req.params;
  const { projectId, styleTemplate } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId es requerido' });

  try {
    const carousel = await requireOwned(req, res);
    if (!carousel) return;

    if (styleTemplate?.visualBible) {
      await updateCarousel(projectId, id, {
        styleTemplate: { id: null, title: styleTemplate.title || null, snapshot: styleTemplate },
      });
    }

    await triggerComposition({ projectId, carouselId: id });
    res.json({ ok: true, triggered: true });
  } catch (err) {
    console.error('[carousel] operation failed');
    res.status(500).json({ error: 'Error procesando carrusel' });
  }
});

router.get('/', async (req, res) => {
  try {
    const docs = await listCarousels('ttchop2', req.userId);
    res.json({ carousels: docs.filter(doc => owned(doc, req)).map(toPublicCarousel) });
  } catch { res.status(500).json({ error: 'Error leyendo carruseles' }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const carousel = await requireOwned(req, res);
    if (!carousel) return;
    await deleteCarousel('ttchop2', req.params.id);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Error borrando carrusel' }); }
});

router.get('/:id', async (req, res) => {

  try {
    const carousel = await requireOwned(req, res);
    if (!carousel) return;
    res.json({ carousel: toPublicCarousel(carousel) });
  } catch (err) {
    res.status(500).json({ error: 'Error procesando carrusel' });
  }
});

return router;
}

export default createCarouselRouter();
