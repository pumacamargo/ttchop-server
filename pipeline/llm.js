import fetch from 'node-fetch';

const MODEL = 'openai/o4-mini';
const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function callLLM({ system, user, model = MODEL }) {
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

export async function callLLMJson({ system, user, model = MODEL }) {
  const raw = await callLLM({ system, user, model });
  // Strip code fences first
  let cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/```\s*$/i, '').trim();
  // If there's still non-JSON text around the object/array, extract just the JSON
  const objMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (objMatch) cleaned = objMatch[1];
  return JSON.parse(cleaned);
}
