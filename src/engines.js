'use strict';

// Search-engine chain: one place that knows how to build a search URL per
// engine, how to recognize a bot-wall/challenge page, and which fallbacks to
// try when the primary engine refuses an automated search.
//
// Why this module exists: the DuckDuckGo HTML endpoint (DDG_HTML) is the
// fastest no-JS surface, but it intermittently answers automated traffic with
// a "complete the following challenge" page (verified 2026-10-14: the /html/
// root renders near-empty in headless Chrome, and a plain fetch POST returns
// a bot challenge). Instead of dead-ending the user, the browser tries the
// next engine (Bing, then Brave) and only reports failure when the whole
// chain is exhausted. DDG stays the default: it is fastest when it works.
//
// Pure + dependency-free so it unit-tests without a browser.

// Order = preference. Every entry needs a server-rendered results page that
// `browser.js` selectors know how to read (see extractResults).
const ENGINES = [
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    host: (h) => h === 'html.duckduckgo.com' || (h.endsWith('.duckduckgo.com')),
    searchUrl: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    home: 'https://html.duckduckgo.com/html/',
  },
  {
    id: 'bing',
    name: 'Bing',
    host: (h) => h === 'bing.com' || h.endsWith('.bing.com'),
    searchUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    home: 'https://www.bing.com/',
  },
  {
    id: 'brave',
    name: 'Brave',
    host: (h) => h === 'search.brave.com',
    searchUrl: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
    home: 'https://search.brave.com/',
  },
];

// Engines that answered with a challenge in THIS session. Skipped as primary
// fallbacks so a blocked engine is not re-tried on every single search, but
// still usable if the user navigates to it explicitly.
const blocked = new Set();

function markBlocked(id) {
  const e = findById(id);
  if (e) blocked.add(e.id);
  return blocked.size;
}

function unmarkBlocked(id) {
  const e = findById(id);
  if (e) blocked.delete(e.id);
}

function isBlocked(id) {
  return blocked.has(String(id || '').toLowerCase());
}

function resetBlocked() {
  blocked.clear();
}

function findById(id) {
  const want = String(id || '').toLowerCase();
  return ENGINES.find((e) => e.id === want) || null;
}

// The engine that owns a URL, or null (a non-search host, or an unknown
// engine such as a plain google.com/search — treated as no-engine).
function engineForUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  // Only result/search paths count: a DDG help page is not a search surface.
  const path = parsed.pathname.toLowerCase();
  const looksSearch =
    (path === '/html' || path.startsWith('/html/')) ||
    path === '/search' ||
    path === '/results';
  if (!looksSearch) return null;
  return ENGINES.find((e) => e.host(host)) || null;
}

// The user's query, pulled out of a search URL (DDG ?q=, Bing ?q=, Brave ?q=).
function queryOf(url) {
  try {
    const u = new URL(String(url));
    const q = u.searchParams.get('q') || u.searchParams.get('query') || u.searchParams.get('search_query');
    return q ? String(q) : '';
  } catch {
    return '';
  }
}

// Fallback URLs to try AFTER `url` fails, in preference order, skipping
// engines already known-blocked this session and the one that just failed.
// Empty array means "no fallback left" (show the failure honestly).
function fallbacksFor(url) {
  const failed = engineForUrl(url);
  const q = queryOf(url);
  if (!q) return [];
  const out = [];
  for (const e of ENGINES) {
    if (failed && e.id === failed.id) continue;
    if (isBlocked(e.id)) continue;
    out.push({ id: e.id, name: e.name, url: e.searchUrl(q) });
  }
  return out;
}

// True when the navigation target is a search page we know how to fall back
// from. Used by index.js to decide whether the chain applies at all.
function isEngineSearchUrl(url) {
  return !!engineForUrl(url);
}

// Bot-wall / challenge fingerprint. Matches the surfaces DDG, Bing and Brave
// serve to automated traffic. Keyword-based on purpose: selectors rotate, the
// wording is stable. Case-insensitive.
const CHALLENGE_PATTERNS = [
  /unfortunately,?\s+bots use/i,
  /select all squares/i,
  /complete the following challenge/i,
  /confirm this search was made by a human/i,
  /please complete the (following )?challenge/i,
  /verify (that )?you are (a )?human/i,
  /unusual traffic/i,
  /are you a robot/i,
  /enable javascript and cookies to continue/i,
  /verifying your browser/i,
  /attention required/i,
  /just a moment\.\.\./i,
];

// Does this page text look like a bot wall rather than a results page?
function looksLikeChallenge(text) {
  const t = String(text || '');
  if (!t) return false;
  return CHALLENGE_PATTERNS.some((re) => re.test(t));
}

// The meaningful body text of a search result page, used for the honesty
// check below. Kept small so this stays cheap.
function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Phrases a genuine "no results" page uses, so we do not mistake a real
// empty result set for a block.
const NO_RESULTS = [
  'no results',
  'no results found',
  'no results containing',
  'did not match any',
  "didn't match any",
  'your search did not match',
  'there are no results',
];

// Verdict for a completed search navigation:
//   { fallback: true, reason }  -> try the next engine
//   { fallback: false }         -> keep this result as-is
// `blocked` is the browser's challenge/bot-wall flag, `text` the page text,
// `count` the number of extracted result rows.
//
// A 0-row page is only treated as a block when it is ALSO essentially blank:
// several engines legitimately answer a query with a text page and no
// structured rows, and that must keep its old "dump the text" behavior.
function judgeSearch({ blocked, text, count } = {}) {
  const n = Number(count) || 0;
  if (blocked) return { fallback: true, reason: 'challenge' };
  const t = normalizeText(text);
  if (looksLikeChallenge(t)) return { fallback: true, reason: 'challenge' };
  if (n <= 0 && t.length < 40) {
    const honestEmpty = NO_RESULTS.some((p) => t.includes(p));
    if (!honestEmpty) return { fallback: true, reason: 'blank' };
  }
  return { fallback: false, reason: '' };
}

module.exports = {
  ENGINES,
  CHALLENGE_PATTERNS,
  NO_RESULTS,
  findById,
  engineForUrl,
  queryOf,
  fallbacksFor,
  isEngineSearchUrl,
  looksLikeChallenge,
  judgeSearch,
  markBlocked,
  unmarkBlocked,
  isBlocked,
  resetBlocked,
};
