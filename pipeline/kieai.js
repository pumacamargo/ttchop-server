import fetch from 'node-fetch';

const BASE_URL = 'https://api.kie.ai/api/v1';

const PRODUCT_FIDELITY_PREFIX =
  'The provided reference image is the single source of truth for the product. ' +
  'Recreate the exact same product shown in the reference image without redesigning, ' +
  'simplifying, or substituting it with a similar item. Preserve its exact shape, ' +
  'proportions, dimensions, colors, materials, textures, branding, logos, labels, ' +
  'printed text (when visible), buttons, handles, straps, zippers, accessories, ' +
  'packaging (if shown), and every distinctive design detail. The product must remain ' +
  'visually identical and consistent throughout the entire video from every camera angle ' +
  'and under every lighting condition. Never replace it with a generic version of the ' +
  'same product category. If there is any conflict between cinematic visuals and product ' +
  'fidelity, always prioritize matching the reference image exactly. ';

function headers() {
  return {
    Authorization: `Bearer ${process.env.KIEAI_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

export async function generateVeo3({ prompt, imageUrls, aspectRatio = '9:16', callBackUrl }) {
  const serverUrl = process.env.SERVER_URL || 'http://localhost:3002';
  const res = await fetch(`${BASE_URL}/veo/generate`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      prompt: PRODUCT_FIDELITY_PREFIX + prompt,
      imageUrls: (Array.isArray(imageUrls) ? imageUrls : [imageUrls]).filter(Boolean).slice(0, 9),
      model: 'veo3_fast',
      callBackUrl: callBackUrl || `${serverUrl}/ai/callback`,
      aspect_ratio: aspectRatio,
      seeds: Math.floor(Math.random() * 90000) + 10000,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`kie.ai Veo3 error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  console.log('[kieai] Veo3 response:', JSON.stringify(data));
  if (data.code !== 200) {
    throw new Error(`kie.ai Veo3 error code ${data.code}: ${data.msg || JSON.stringify(data)}`);
  }
  return data;
}

export async function generateSeedance({ prompt, imageUrls, callBackUrl, aspectRatio = '9:16', resolution = '480p', duration = 15, generateAudio = true }) {
  const serverUrl = process.env.SERVER_URL || 'http://localhost:3002';
  const images = Array.isArray(imageUrls) ? imageUrls : [imageUrls];
  const res = await fetch(`${BASE_URL}/jobs/createTask`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: 'bytedance/seedance-2',
      callBackUrl: callBackUrl || `${serverUrl}/ai/callback`,
      input: {
        prompt: PRODUCT_FIDELITY_PREFIX + prompt,
        reference_image_urls: [images[0]],
        aspect_ratio: aspectRatio,
        resolution,
        duration,
        generate_audio: generateAudio,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`kie.ai Seedance error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  console.log('[kieai] Seedance response:', JSON.stringify(data));
  if (data.code !== 200) {
    throw new Error(`kie.ai Seedance error code ${data.code}: ${data.msg || JSON.stringify(data)}`);
  }
  return data;
}

// ── Carousel image models (TTC-56) ──────────────────────────────────────────────
// Los 3 confirmados en el spike de la Fase 0 (ver comentario en TTC-56): todos usan
// el mismo POST /jobs/createTask genérico, solo cambia `model` y la forma de `input`.
// Tabla aislada para que agregar un modelo nuevo sea agregar una entrada aquí, no
// tocar generateImage. image_size es por modelo porque cada uno usa su propio enum
// de tamaños (confirmado a mano en el spike, no están unificados entre proveedores).
const IMAGE_MODELS = {
  'seedream-v4': {
    model: 'bytedance/seedream-v4-text-to-image',
    creditsPerImage: 5,
    maxBatch: 6,
    buildInput({ prompt, n, seed }) {
      const input = { prompt, image_size: 'portrait_16_9' };
      // Seedream SOLO respeta max_images si el conteo también está explícito en el
      // texto del prompt (confirmado en el spike: con max_images:2 y el prompt sin
      // la instrucción devolvió 1 sola imagen). El prompt ya enumera "Generate
      // exactly N images..." — ver buildBatchPrompt en pipeline/carouselImages.js.
      if (n > 1) input.max_images = Math.min(n, 6);
      // Rango real confirmado en el spike: 0–1,000,000 (no "menor a 1M" como decía
      // el brief original — probar con un seed de 8 dígitos tira 422).
      if (seed != null) input.seed = Math.abs(Number(seed)) % 1_000_000;
      return input;
    },
  },
  'gpt-image-2': {
    model: 'gpt-image-2-text-to-image',
    creditsPerImage: 6,
    maxBatch: 1, // sin batch real en este modelo (confirmado en el spike, usa n:1)
    buildInput({ prompt }) {
      return { prompt, image_size: 'portrait', n: 1 };
    },
  },
  'nano-banana-2': {
    model: 'nano-banana-2',
    creditsPerImage: 8,
    maxBatch: 1, // sin max_images documentado para este modelo
    buildInput({ prompt }) {
      return { prompt, image_size: 'portrait_16_9' };
    },
  },
  'nano-banana-2-lite': {
    model: 'nano-banana-2-lite',
    creditsPerImage: 0, // precio pendiente de confirmar con la API
    maxBatch: 1,
    buildInput({ prompt }) {
      return { prompt, image_size: 'portrait_16_9' };
    },
  },
};

export const IMAGE_MODEL_IDS = Object.keys(IMAGE_MODELS);

export function maxBatchForModel(imageModel) {
  return IMAGE_MODELS[imageModel]?.maxBatch || 1;
}

export function creditsPerImageForModel(imageModel) {
  return IMAGE_MODELS[imageModel]?.creditsPerImage || 0;
}

// generateImage NO lleva PRODUCT_FIDELITY_PREFIX — los carruseles no tienen producto
// de referencia, son fondos fotográficos genéricos dirigidos por un styleTemplate.
export async function generateImage({ imageModel, prompt, n = 1, seed, callBackUrl }) {
  const cfg = IMAGE_MODELS[imageModel];
  if (!cfg) throw new Error(`Modelo de imagen desconocido: ${imageModel}`);

  const input = cfg.buildInput({ prompt, n, seed });
  const res = await fetch(`${BASE_URL}/jobs/createTask`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model: cfg.model, callBackUrl, input }),
  });

  if (!res.ok) {
    await res.text();
    throw new Error(`kie.ai ${cfg.model} error ${res.status}`);
  }

  const data = await res.json();
  console.log(`[kieai] ${cfg.model} createTask response:`, { code: data.code });
  if (data.code !== 200) {
    throw new Error(`kie.ai ${cfg.model} error code ${data.code}`);
  }
  return data;
}

// Re-verificación obligatoria del callback (plan TTC-55 §7: "no se confía en el
// body"). También usado por el sweep de pipeline/scheduler.js para recuperar
// tareas cuyo callback nunca llegó.
export async function getTaskRecord(taskId) {
  const res = await fetch(`${BASE_URL}/jobs/recordInfo?taskId=${taskId}`, { headers: headers() });
  if (!res.ok) {
    await res.text();
    throw new Error(`kie.ai recordInfo error ${res.status}`);
  }
  return res.json();
}
