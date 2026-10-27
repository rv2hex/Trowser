'use strict';

// Domain-scoped search: the /home dashboard picker plus the `>bang` prefix.
// Pure data + URL building — no TUI, no network (the wiki top-result fetch
// lives in index.js where fetch and navigation are already wired).
//
//   '' = the whole web (no scope). The picker keeps this as the default, so
//   plain searches are plain searches — never a surprise YouTube scope from
//   whatever row happened to be highlighted (the old behaviour).

const SCOPES = [
  { key: 'wiki', bang: 'wiki', aliases: ['w', 'wikipedia'], label: 'Wikipedia' },
  { key: 'gh', bang: 'gh', aliases: ['github'], label: 'GitHub' },
  { key: 'so', bang: 'so', aliases: ['stack', 'stackoverflow'], label: 'Stack Overflow' },
  { key: 'hn', bang: 'hn', aliases: ['yc'], label: 'Hacker News' },
];

function scopeKeys() {
  return ['', ...SCOPES.map((s) => s.key)];
}

function scopeInfo(key) {
  const k = String(key || '').toLowerCase();
  return SCOPES.find((s) => s.key === k || (s.aliases || []).includes(k)) || null;
}

// The chip text: `>wiki` for scoped bangs, `web` for the default scope.
function scopeHint(key) {
  const info = scopeInfo(key);
  return info ? `>${info.bang}` : 'web';
}

function scopeLabel(key) {
  const info = scopeInfo(key);
  return info ? info.label : 'the web';
}

// Collapse a run of leading `>`s into one: `>>wiki x` (fat-fingered scope) is
// the same intent as `>wiki x`. Trims first; leaves everything else alone.
function normalizeBangInput(input) {
  return String(input || '')
    .trim()
    .replace(/^>+/, '>');
}

// Parse a typed bang: `>wiki einstein`, `>gh react hooks`, `>example.com term`.
// Returns { scope, query } or null. A known alias resolves to its key; a
// domain-shaped token stays raw (caller builds a site: search). Extra leading
// `>`s are tolerated (`>>wiki x` parses as `>wiki x`).
function parseBang(input) {
  const v = normalizeBangInput(input);
  const m = v.match(/^>([a-z0-9][a-z0-9.-]*)\s+(\S[\s\S]*)$/i);
  if (!m) return null;
  const token = m[1].toLowerCase();
  const query = m[2].trim();
  if (!query) return null;
  const info = scopeInfo(token);
  if (info) return { scope: info.key, query };
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(token)) return { scope: token, query };
  return null;
}

// On-site search URL for a known scope. Wiki uses the Go handshake so an
// exact title lands on the article directly; index.js upgrades fuzzy queries
// to the real top result via the opensearch API.
function scopedSearchUrl(scopeKey, query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const enc = encodeURIComponent(q);
  switch (String(scopeKey || '').toLowerCase()) {
    case 'wiki':
      return `https://en.wikipedia.org/w/index.php?search=${enc}&go=Go`;
    case 'gh':
      return `https://github.com/search?q=${enc}`;
    case 'so':
      return `https://stackoverflow.com/search?q=${enc}`;
    case 'hn':
      return `https://hn.algolia.com/?q=${enc}`;
    default:
      return null; // unknown / domain scopes are built by the caller
  }
}

// Wikipedia opensearch endpoint: the real top result for a query.
function wikiOpensearchUrl(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  return `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=1&namespace=0&format=json`;
}

// Validate an opensearch answer and take the first result URL. Never throws.
function firstWikiResult(json) {
  try {
    const urls = Array.isArray(json) ? json[3] : null;
    const url = Array.isArray(urls) ? String(urls[0] || '') : '';
    return /^https:\/\/en\.wikipedia\.org\/wiki\/\S+$/.test(url) ? url : null;
  } catch {
    return null;
  }
}

module.exports = {
  SCOPES,
  scopeKeys,
  scopeInfo,
  scopeHint,
  scopeLabel,
  normalizeBangInput,
  parseBang,
  scopedSearchUrl,
  wikiOpensearchUrl,
  firstWikiResult,
};
