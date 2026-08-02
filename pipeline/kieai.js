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
      imageUrls: Array.isArray(imageUrls) ? imageUrls : [imageUrls],
      model: 'veo3_fast',
      callBackUrl: callBackUrl || `${serverUrl}/ai/callback`,
      aspect_ratio: aspectRatio,
      seeds: Math.floor(Math.random() * 90000) + 10000,
      enableTranslation: true,
      generationType: 'REFERENCE_2_VIDEO',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`kie.ai Veo3 error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data;
}

export async function generateSeedance({ prompt, imageUrls, callBackUrl, aspectRatio = '9:16' }) {
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
        image: images[0],
        aspect_ratio: aspectRatio,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`kie.ai Seedance error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data;
}
