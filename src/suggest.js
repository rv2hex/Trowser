'use strict';

// Suggestion source. browser.js stays driver-only; this module owns ranking
// + the DDG autocomplete fetch. rankHistory() is pure and unit-testable
// without network. Rows: { label, url|null, kind: 'search'|'url'|'history' }.

const SUGGEST_LIMIT = 8;

function looksLikeURL(input) {
  const v = String(input || '').trim();
  if (!v || /\s/.test(v)) return false;
  if (/^https?:\/\//i.test(v)) return true;
  return /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v);
}

// Most-recent-first history filtered by query. Prefix matches first.
function rankHistory(history, input, limit = SUGGEST_LIMIT) {
  const q = String(input || '').trim().toLowerCase();
  const seen = new Set();
  const scored = [];
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const url = String(list[i] || '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    let domain = '';
    try {
      domain = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    const hay = `${url} ${domain}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const score = q && (url.toLowerCase().startsWith(q) || domain.startsWith(q)) ? 0 : 1;
    scored.push({ score, url, domain, idx: i });
  }
  scored.sort((a, b) => a.score - b.score || b.idx - a.idx);
  return scored.slice(0, limit).map((s) => ({ label: s.url, url: s.url, kind: 'history' }));
}

async function fetchWebSuggest(query, { timeoutMs = 1000, signal } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  // A caller (new keystroke) aborting means this result is already stale.
  const onCallerAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  try {
    const res = await fetch(`https://duckduckgo.com/ac/?q=${encodeURIComponent(query)}`, {
      signal: ctl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .map((d) => d && d.phrase)
      .filter((p) => typeof p === 'string' && p.trim().length > 0)
      .map((phrase) => ({ label: phrase.trim(), url: null, kind: 'search' }));
  } catch {
    return [];
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
  }
}

// Sync local phase: history (+ direct URL row), zero network. Render this
// immediately per keystroke; the async web merge follows under the same id.
function getLocalSuggestions(input, history, limit = SUGGEST_LIMIT) {
  const v = String(input || '').trim();
  if (!v) return rankHistory(history, '', limit);
  if (!looksLikeURL(v)) return rankHistory(history, v, limit);
  const out = rankHistory(history, v, limit);
  // Offer exactly what was typed (with scheme) first.
  const direct = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  if (!out.some((r) => r.url === direct)) {
    out.unshift({ label: direct, url: direct, kind: 'url' });
  }
  return out.slice(0, limit);
}

async function getSuggestions(input, history, limit = SUGGEST_LIMIT, opts = {}) {
  const v = String(input || '').trim();
  if (!v || looksLikeURL(v)) return getLocalSuggestions(input, history, limit);
  const web = await fetchWebSuggest(v, opts);
  const seen = new Set();
  const out = [];
  for (const r of [...web, ...rankHistory(history, v, limit)]) {
    const key = r.url || r.label;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

// Slash-command catalog: generated from src/commandSpec.js (single source
// of truth). Local and synchronous: typing `/` never touches the network.
// Rows reuse the suggestion renderer (hint goes in `domain`; `section`
// drives the palette's section headers, `palette` the visibility):
//   ''        - everyday command: listed when the palette opens
//   'search'  - setup/power-user: listed only while typing a search
//   'hidden'  - owned by the /settings hub: never listed by the palette
//               (still routable — /settings + /help all are its home)
const { SPEC } = require('./commandSpec');
const COMMANDS = SPEC.map((c) => ({
  name: c.name,
  hint: c.hint + (c.aliases && c.aliases.length ? ` (aliases: ${c.aliases.map((a) => '/' + a).join(', ')})` : ''),
  takesArg: !!c.usage,
  usage: c.usage || '',
  aliases: c.aliases || [],
  section: c.group || '',
  palette: c.palette || '',
}));

// Greedy subsequence with a tightness score: consecutive runs beat
// scattered hits, early matches beat late ones, short names beat long
// ones. -1 = not a subsequence. Powers the palette's fuzzy fallback.
function fuzzyScore(name, word) {
  let from = 0;
  let score = 0;
  let streak = 0;
  let first = -1;
  for (const ch of word) {
    const at = name.indexOf(ch, from);
    if (at === -1) return -1;
    if (first === -1) first = at;
    if (at === from) {
      streak++;
      score += 2 + streak;
    } else {
      streak = 0;
      score += 1;
    }
    from = at + 1;
  }
  return score + Math.max(0, 8 - first) - (name.length - word.length);
}

function commandRow(c) {
  return {
    label: '/' + c.name + (c.usage ? ' ' + c.usage : ''),
    url: null,
    kind: 'command',
    domain: c.hint,
    section: c.section,
  };
}

// Palette rows for a slash input. Bare `/` shows the everyday set (the
// renderer groups them by section); typing filters core + setup commands.
// Typing is also FUZZY from 2 letters up ('/stngs' finds /settings), but
// prefix matches always outrank fuzzy ones and a single letter stays a
// pure prefix game so the palette never turns into a wall.
// No hard truncation cap here: the UI owns the window, so a future taller
// palette never silently drops rows.
function getCommandSuggestions(input, limit = COMMANDS.length) {
  const word = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^\/+/, '')
    .split(/\s+/)[0];
  if (!word) {
    return COMMANDS.filter((c) => c.palette !== 'hidden' && c.palette !== 'search')
      .slice(0, limit)
      .map(commandRow);
  }
  const isPrefix = (c) => c.name.startsWith(word) || (c.aliases || []).some((a) => a.startsWith(word));
  const visible = COMMANDS.filter((c) => c.palette !== 'hidden');
  const prefix = visible.filter(isPrefix);
  const fuzzy = word.length >= 2
    ? visible
      .filter((c) => !isPrefix(c))
      .map((c) => {
        const best = Math.max(
          fuzzyScore(c.name, word),
          ...(c.aliases || []).map((a) => fuzzyScore(a, word))
        );
        return { c, best };
      })
      .filter((r) => r.best >= 0)
      .sort((a, b) => b.best - a.best)
      .slice(0, 8)
      .map((r) => r.c)
    : [];
  return [...prefix, ...fuzzy]
    .slice(0, limit)
    .map(commandRow);
}

module.exports = { looksLikeURL, rankHistory, fetchWebSuggest, getLocalSuggestions, getSuggestions, getCommandSuggestions, COMMANDS, SUGGEST_LIMIT };
