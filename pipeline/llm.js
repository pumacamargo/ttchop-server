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

// Scans for the first balanced {...} or [...] value, respecting string contents (so braces
// inside quoted strings don't throw off the depth count). Unlike a greedy "first { to last }"
// regex, this stops at the END of the first complete value instead of spanning into whatever
// comes after it.
function extractFirstJsonValue(text) {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export async function callLLMJson({ system, user, model = MODEL }) {
  const raw = await callLLM({ system, user, model });
  // Strip code fences first
  const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/```\s*$/i, '').trim();
  // Root cause of render_mv0198il (TTC-36, 2026-10-09): o4-mini sometimes appends a second
  // JSON-like block or trailing prose after the real object. The old "first { to last }"
  // regex greedily spanned across both, producing a concatenated string that failed with
  // "Unexpected non-whitespace character after JSON". Extract only the first balanced value.
  const extracted = extractFirstJsonValue(cleaned);
  const candidate = extracted ?? cleaned;
  try {
    return JSON.parse(candidate);
  } catch (e) {
    throw new Error(`callLLMJson: ${e.message} — raw LLM response (first 500 chars): ${raw.slice(0, 500)}`);
  }
}
