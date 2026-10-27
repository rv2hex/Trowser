'use strict';

// /ai answers come from OpenRouter's free tier. One POST to the chat
// completions endpoint, global fetch only, zero new deps. The key lives in
// its own 0600 file (like the old gemini-key) — never in the shared config,
// never echoed back. Every failure returns a plain { ok:false, error } the
// caller paints; nothing throws past askAi().

const fs = require('fs');
const os = require('os');
const path = require('path');

// Curated free models — the OFFLINE fallback. The settings hub cycles the
// LIVE catalog (fetched from OpenRouter and cached, see modelCatalog()) so
// retired ids stop being offered the day they die; this list only has to
// keep working when the fetch fails. It holds ids verified alive right now
// (real incident: 6 of 7 old ids retired upstream, and /settings kept
// cycling them, so every pick 404ed). `label` is the attribution name
// ("— by nemotron 120b") shown on every answer.
const FREE_MODELS = [
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'nemotron 120b' },
  { id: 'nvidia/nemotron-3.5-super-vl:free', label: 'nemotron 3.5 super vl' },
  { id: 'nvidia/nemotron-3.5-lightning:free', label: 'nemotron 3.5 lightning' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'nemotron 3 ultra 550b' },
  { id: 'thinkingmachines/inkling:free', label: 'inkling' },
  { id: 'thinkingmachines/inkling-small:free', label: 'inkling small' },
  { id: 'google/gemma-4-31b-it:free', label: 'gemma 4 31b' },
  { id: 'google/gemma-4-26b-a4b-it:free', label: 'gemma 4 26b' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', label: 'nemotron nano 30b' },
];
const DEFAULT_MODEL = FREE_MODELS[0].id;

// Free models free-style long answers and big models are slow: a real
// ANSWER_STYLE reply measured ~60s on nemotron 120b, so the old 60s cap
// killed answers right as they finished. 180s leaves headroom for the
// 4000-6000 char contract; streamed calls (onDelta) also prove the request
// is alive while it runs.
const TIMEOUT_MS = 180000;
// Bound the output: ~2000 tokens ≈ 6-8k chars of terminal text, which is
// what ANSWER_STYLE requests (4000-6000 chars).
const MAX_OUTPUT_TOKENS = 2048;
const MAX_CONTEXT_CHARS = 4000;

// Output contract, requested on every call (page-aware or standalone):
// lead with one plain sentence saying what the page states, then short
// bullets. No markdown links, no bare URLs, no headings — the terminal
// renderer turns those into ugly `[text](url)` noise.
const STYLE =
  'Reply in at most 6 short bullet points, each line starting with "- ".\n' +
  'Open with one plain sentence saying what the page states (for example: ' +
  '"This website states that …"). Skip that sentence only when there is no page.\n' +
  'No markdown links, no raw URLs, no headings, no bold, no tables.';

// Output contract for standalone search answers (no page): a direct,
// complete explanation shaped for the terminal renderer — lead paragraph,
// then ### sections and - bullets. The renderer already formats all of
// these (blockMd), unlike URLs/tables which it cannot.
const ANSWER_STYLE =
  'Answer the question directly and completely for a terminal reader.\n' +
  'You are an expert. Do not be brief. Do not summarize. Explain fully.\n\n' +
  'STRUCTURE (mandatory):\n' +
  '1. LEAD PARAGRAPH: 2-3 sentences answering the question outright.\n' +
  '2. ### SECTION HEADINGS for each major topic.\n' +
  '3. Under each section: - bullet points. SUB-BULLETS allowed (indent 2 spaces).\n' +
  '4. Use **bold** for key terms, names, versions, concepts INSIDE bullets.\n' +
  '5. GO DEEP: include specifics — versions, APIs, trade-offs, config options,\n' +
  '   gotchas, migration notes, ecosystem context, performance characteristics.\n' +
  '6. FORBIDDEN: markdown links, raw URLs, tables, code fences > 4 lines.\n' +
  '7. LENGTH: 4000-6000 chars for complex topics; scale down for simple.\n' +
  'EXAMPLE TONE: "Godot uses a node-scene system where..." not "Godot has nodes."\n' +
  'If you would write it in good documentation, write it here.';

// Environment preamble, sent as the system message on every call. The
// model is answering inside an app most models have never been in: a
// keyboard-driven, cell-accurate TUI browser on a fixed-width terminal
// grid (btop-style), not a chat window. Saying so up front is what keeps
// answers renderable — short measured lines, one-cell glyphs, no tables
// or links — and stops well-meaning "click here" advice a TUI reader
// cannot follow. Mirrors how OpenCode tells its models where they run;
// keep it one short paragraph, it rides on every request.
const SYSTEM_PROMPT =
  'You are the AI assistant inside tui-browser, a keyboard-driven TUI ' +
  'browser that renders web pages as plain text on a fixed-width terminal ' +
  'grid (btop-style). Your reply is drawn in that cell grid by a small ' +
  'markdown renderer: no images, no tables, no horizontal rules, no ' +
  'markdown links or raw URLs (they cannot be clicked). Prefer lines under ' +
  '90 characters. Unicode is welcome but every glyph must be exactly ONE ' +
  'terminal cell wide (no emoji). The user drives by keyboard and may be ' +
  'offline. Never tell the user to click something. Always follow the ' +
  'output contract given in the user message.';

// Setup text with no key: real instructions, not a dead end. Commands.js
// prints this verbatim and tests assert the essentials stay in it.
const AI_NO_KEY =
  'No OpenRouter API key saved — /ai uses OpenRouter free-tier models.\n\n' +
  'Get a free key at https://openrouter.ai/keys then either:\n' +
  '  /ai-key <your-key>            (saves it, 0600 file)\n' +
  '  /settings → AI → OpenRouter API key   (same thing, in the hub)\n' +
  'Or set OPENROUTER_API_KEY in the environment.\n' +
  'Each answer says which free model produced it; pick one in /settings → AI.';

function keyFile(file) {
  if (file) return file;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'tui-browser', 'openrouter-key');
}

function loadKey(file) {
  try {
    const k = fs.readFileSync(file || keyFile(), 'utf8').trim();
    return k || '';
  } catch {
    return '';
  }
}

// Returns true only when the key actually persisted.
function saveKey(key, file) {
  try {
    const target = file || keyFile();
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, String(key || '').trim(), { mode: 0o600 });
    try {
      fs.chmodSync(target, 0o600);
    } catch { /* writeFileSync mode usually sticks */ }
    return true;
  } catch {
    return false;
  }
}

function clearKey(file) {
  try {
    fs.rmSync(file || keyFile(), { force: true });
  } catch { /* already gone */ }
}

function resolveKey(explicit) {
  // An explicit argument (even '') is authoritative: tests and callers that
  // pass a key must never silently fall back to the environment.
  if (explicit !== undefined && explicit !== null) return String(explicit).trim();
  const env = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (env) return env;
  return loadKey();
}

// Which model answers: explicit > the user's saved pick (config.json) >
// the default. Read fresh from disk each ask so a /settings change applies
// to the very next question, no restart.
// Hard rule: only OpenRouter models marked `:free` are ever used — a stale
// paid id (old config, manual edit, bad caller) is ignored, never sent.
function isFreeModel(id) {
  return /:free$/i.test(String(id || '').trim());
}

// ---- live free-model catalog ----------------------------------------------
// The curated list above WILL go stale (real incident: 6 of 7 ids retired
// upstream and /settings kept cycling them). The catalog self-heals: one
// GET to OpenRouter's model index keeps zero-priced, text-output, :free
// entries, cached in memory for 6 h. The curated list stays the offline
// fallback, so the picker is never empty and never needs the network.
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
let catalogCache = null; // { at, models }

// "NVIDIA: Nemotron 3 Super (free)" → "Nemotron 3 Super". Pure.
function tidyCatalogLabel(name, id) {
  let s = String(name || '').replace(/\s*\(free\)\s*$/i, '').trim();
  const colon = s.indexOf(': ');
  if (colon > 0) s = s.slice(colon + 2);
  s = s.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 48) : modelLabel(id);
}

// One GET to the model index. Injectable fetchFn keeps tests offline.
// Never throws: [] means "use the curated fallback".
async function fetchFreeModels({ fetchFn, timeoutMs = 8000 } = {}) {
  const f = fetchFn || global.fetch;
  if (typeof f !== 'function') return [];
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Math.max(1000, Number(timeoutMs) || 8000));
  try {
    const res = await f('https://openrouter.ai/api/v1/models', {
      signal: ctl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res || !res.ok) return [];
    const data = await res.json();
    const list = data && Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
    const out = [];
    const seen = new Set();
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const id = String(m.id || '').trim();
      if (!id || seen.has(id) || !isFreeModel(id)) continue;
      // Not answer models: safety classifiers / moderation / embeddings /
      // rerankers are priced free and :free-suffixed upstream, but they
      // cannot answer a question — never offer them in /settings.
      if (/content-safety|moderation|embed|rerank/i.test(id)) continue;
      const pr = m.pricing || {};
      // Zero-priced only (the API reports values as strings, "0").
      if (String(pr.prompt) !== '0' || String(pr.completion) !== '0') continue;
      const outs = m.architecture && Array.isArray(m.architecture.output_modalities)
        ? m.architecture.output_modalities
        : null;
      if (outs && outs.length && !outs.includes('text')) continue;
      seen.add(id);
      out.push({ id, label: tidyCatalogLabel(m.name, id) });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

// Refresh in the background (fire-and-forget). Respects the TTL so opening
// /settings repeatedly does NOT hammer the API — and NOTHING fetches until
// a caller asks (no startup network ping in a privacy-centric browser).
function warmFreeModels(deps) {
  if (catalogIsLive()) return Promise.resolve(catalogCache.models.slice());
  return fetchFreeModels(deps)
    .then((models) => {
      if (models && models.length) catalogCache = { at: Date.now(), models };
      return models;
    })
    .catch(() => []);
}

// Sync list for pickers: the last fetched live list if any, curated
// fallback otherwise. Never empty, never throws.
function modelCatalog() {
  if (catalogCache && Array.isArray(catalogCache.models) && catalogCache.models.length) {
    return catalogCache.models.slice();
  }
  return FREE_MODELS.slice();
}

// True only while the cache is FRESH: a stale cache still renders (see
// modelCatalog) but never certifies that a saved pick is still served.
function catalogIsLive() {
  return !!(catalogCache && Array.isArray(catalogCache.models) && catalogCache.models.length
    && Date.now() - catalogCache.at <= CATALOG_TTL_MS);
}

// Which model actually answers a saved pick: free ids missing from a FRESH
// live catalog are retired upstream — fall back to the default instead of
// 404ing forever (real incident: a saved deepseek-r1:free died upstream).
// Offline (no live catalog) the pick is kept: the free-only hard rule
// still holds, and a 404 self-heals at ask time. Pure.
function effectiveModel(id) {
  const s = String(id || '').trim();
  if (!isFreeModel(s)) return DEFAULT_MODEL;
  if (catalogIsLive() && !catalogCache.models.some((m) => m.id === s)) return DEFAULT_MODEL;
  return s;
}

function clearCatalogCache() {
  catalogCache = null;
}

function resolveModel(explicit) {
  const e = String(explicit || '').trim();
  if (isFreeModel(e)) return e;
  try {
    const cfg = require('./config').loadConfig();
    const m = String((cfg && cfg.aiModel) || '').trim();
    if (isFreeModel(m)) return effectiveModel(m);
  } catch { /* defaults win */ }
  return DEFAULT_MODEL;
}

function maskKey(key) {
  const k = String(key || '');
  if (k.length <= 8) return '(set)';
  return `…${k.slice(-4)} (set)`;
}

// Attribution name for an answer: curated label, or a tidy guess for
// custom ids. Pure, never throws. Rendered as "— by <label>".
function modelLabel(id) {
  const s = String(id || '').trim();
  if (!s) return modelLabel(DEFAULT_MODEL);
  const hit = FREE_MODELS.find((m) => m.id === s);
  if (hit) return hit.label;
  // Live-catalog models keep their upstream names ("— by Inkling").
  const live = catalogCache && Array.isArray(catalogCache.models)
    ? catalogCache.models.find((m) => m.id === s)
    : null;
  if (live && live.label) return live.label;
  const tail = s.split('/').pop().replace(/:.*$/, '').replace(/[-_]/g, ' ').trim();
  return tail || 'model';
}

// Pure: wrap the user question with optional page context so answers can
// reference what is on screen. Context is truncated, never the full dump.
// A missing page is normal (standalone question), never an error.
// `style` overrides the output contract (search answers use ANSWER_STYLE);
// omitted it is byte-identical to the historic STYLE prompt.
function buildPrompt(question, context, style) {
  const st = (typeof style === 'string' && style.trim()) ? style : STYLE;
  const q = String(question || '').trim();
  const c = String(context || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CONTEXT_CHARS);
  if (!c) return `${q || 'Say hello in one sentence.'}\n\n${st}`;
  return `Web page the user is reading right now (may be partial):\n"""\n${c}\n"""\n\n${q || 'Summarize what this page says.'}\n\n${st}`;
}

// Pure: fold a reply thread into chat messages. History entries are { q, a }
// with plain strings; newest last. Only the newest turn carries the page
// context (older turns would blow the budget for nothing).
function buildMessages(question, context, history, style) {
  const out = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const ex of Array.isArray(history) ? history : []) {
    const q = String((ex && ex.q) || '').trim().slice(0, 500);
    const a = String((ex && ex.a) || '').trim().slice(0, 2000);
    if (!q || !a) continue;
    out.push({ role: 'user', content: q });
    out.push({ role: 'assistant', content: a });
  }
  // out.length > 1 means history was folded in above; only a first turn
  // carries the page context (older turns would blow the budget for
  // nothing). The system preamble never counts as a turn.
  out.push({ role: 'user', content: buildPrompt(question, out.length > 1 ? '' : context, style) });
  return out;
}

function extractText(data) {
  try {
    const c = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return typeof c === 'string' ? c.trim() : '';
  } catch {
    return '';
  }
}

function errText(err, fallback) {
  const m = String((err && err.message) || '').trim();
  return m || fallback;
}

async function callModel(model, key, messages, signal, maxTokens, stream) {
  return fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      // OpenRouter uses these for its public leaderboard attribution
      // (optional, but free-tier friendly).
      Authorization: `Bearer ${key}`,
      'X-Title': 'TUI Browser',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: Math.min(8192, Math.max(256, Math.floor(Number(maxTokens) || MAX_OUTPUT_TOKENS))),
      ...(stream ? { stream: true } : {}),
    }),
  });
}

// Stream a chat-completions SSE response: accumulate content deltas, hand
// the running text to onDelta, and return the final text. Keep-alive
// comment lines (`: OPENROUTER PROCESSING`), blank lines and the terminal
// `[DONE]` sentinel are ignored. A mid-stream error chunk throws only when
// nothing arrived yet (askAi maps it to the usual honest error); after
// partial text it stops cleanly and keeps what the user already has.
async function readSse(res, onDelta, onModel) {
  let text = '';
  let buf = '';
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  const dec = new TextDecoder();
  const eat = (line) => {
    const s = String(line || '').replace(/\r$/, '');
    if (!s.startsWith('data:')) return; // comments/blank lines
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let obj = null;
    try { obj = JSON.parse(payload); } catch { return; }
    if (obj && obj.model && typeof onModel === 'function') onModel(String(obj.model));
    if (obj && obj.error) {
      if (!text) throw new Error((obj.error && obj.error.message) || 'OpenRouter stream error');
      return;
    }
    const delta = obj && obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content;
    if (typeof delta === 'string' && delta) {
      text += delta;
      try { onDelta(text); } catch { /* listener is best-effort */ }
    }
  };
  if (!reader) {
    // No streaming body (rare): parse whatever SSE text arrived in one piece.
    for (const line of String(await res.text()).split('\n')) eat(line);
    return text;
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      eat(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  }
  buf += dec.decode();
  if (buf) eat(buf);
  return text;
}

async function askAi(question, { context, history, apiKey, model, timeoutMs, style, maxOutputTokens, onDelta } = {}) {
  const key = resolveKey(apiKey);
  if (!key) {
    return { ok: false, error: AI_NO_KEY, text: '' };
  }
  const messages = buildMessages(question, context, history, style);
  if (!messages.length || !String(messages[messages.length - 1].content || '').trim()) {
    return { ok: false, error: 'Ask something: /ai <your question>.', text: '' };
  }
  const usedModel = resolveModel(model);
  const streaming = typeof onDelta === 'function';
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Number(timeoutMs) || TIMEOUT_MS);
  try {
    let attemptModel = usedModel;
    let res = await callModel(attemptModel, key, messages, ctl.signal, maxOutputTokens, streaming);
    // Retired saved pick self-heal: a 404 on a non-default model retries
    // once with the default (nothing streamed back yet, so the retry is
    // clean); the answer reports whichever model really served it.
    if (!res.ok && res.status === 404 && attemptModel !== DEFAULT_MODEL) {
      attemptModel = DEFAULT_MODEL;
      res = await callModel(attemptModel, key, messages, ctl.signal, maxOutputTokens, streaming);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const err = await res.json();
        detail = (err && err.error && err.error.message) ? String(err.error.message).slice(0, 300) : '';
      } catch { /* keep blank */ }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: `OpenRouter refused the key (${res.status}${detail ? `: ${detail}` : ''}). Check /ai-key or /settings → AI.`, text: '' };
      }
      if (res.status === 402) {
        return { ok: false, error: 'OpenRouter says this account is out of credits (402). Free models need none — check your key, or pick a different model in /settings → AI.', text: '' };
      }
      if (res.status === 404) {
        return { ok: false, error: `The model "${modelLabel(attemptModel)}" is unavailable on OpenRouter right now (404${detail ? `: ${detail}` : ''}). Pick another in /settings → AI.`, text: '' };
      }
      if (res.status === 429) {
        return { ok: false, error: `OpenRouter is rate-limiting "${modelLabel(usedModel)}" (429) — free models throttle. Wait a bit or pick another in /settings → AI.`, text: '' };
      }
      if (res.status === 500 || res.status === 502 || res.status === 503) {
        return { ok: false, error: `OpenRouter is having an outage (${res.status}) — try again in a minute.`, text: '' };
      }
      return { ok: false, error: `OpenRouter replied ${res.status}${detail ? `: ${detail}` : ''}.`, text: '' };
    }
    let text = '';
    let seenModel = '';
    if (streaming) {
      text = await readSse(res, onDelta, (m) => { seenModel = m; });
    } else {
      const data = await res.json();
      text = extractText(data);
      seenModel = String((data && data.model) || '');
    }
    if (!text) return { ok: false, error: 'The model returned an empty response. Try rephrasing or another model in /settings → AI.', text: '' };
    return { ok: true, error: '', text: text.slice(0, 30000), model: seenModel || usedModel };
  } catch (err) {
    if (err && (err.name === 'AbortError' || /abort/i.test(String((err && err.message) || '')))) {
      const secs = Math.round((Number(timeoutMs) || TIMEOUT_MS) / 1000);
      return { ok: false, error: `OpenRouter timed out after ${secs}s — check your connection and retry.`, text: '' };
    }
    return { ok: false, error: `OpenRouter request failed: ${errText(err, 'no connection to openrouter.ai')}`, text: '' };
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  FREE_MODELS,
  DEFAULT_MODEL,
  TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  MAX_CONTEXT_CHARS,
  STYLE,
  ANSWER_STYLE,
  SYSTEM_PROMPT,
  AI_NO_KEY,
  keyFile,
  loadKey,
  saveKey,
  clearKey,
  resolveKey,
  resolveModel,
  isFreeModel,
  effectiveModel,
  fetchFreeModels,
  warmFreeModels,
  modelCatalog,
  catalogIsLive,
  clearCatalogCache,
  CATALOG_TTL_MS,
  maskKey,
  modelLabel,
  buildPrompt,
  buildMessages,
  extractText,
  askAi,
};
