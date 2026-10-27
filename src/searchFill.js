'use strict';

// More results than DuckDuckGo HTML gives you.
//
// html.duckduckgo.com serves exactly 10 results per page — I verified it:
// even `&s=10` on the GET is IGNORED, page two only exists as a POST form
// (q + s). That is why searching always topped out at 10 links.
//
// This module fills the list up to the /links page size:
//   1. pages 2, 3, … via the POST form (same query, next 10 each), then
//   2. VARIATIONS of the query — DDG's own related-search terms scraped off
//      page one — so extra links are genuinely different pages instead of
//      page two of the same ten.
//
// Everything here is plain fetch + regex: no second browser, no extra RAM.
// The pure parts (parsing, planning, dedupe) are exported for unit tests.

const DDG_HTML = 'https://html.duckduckgo.com/html/';
const PER_PAGE = 10;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_TIMEOUT_MS = 12000;
// Hard ceiling on extra fetches: 6 requests ≈ 60 extra links, still <5s.
const MAX_EXTRA_FETCHES = 6;
const MAX_VARIANTS = 2;

function formBody(query, offset) {
  return `q=${encodeURIComponent(String(query || ''))}&s=${Number(offset) || 0}&kl=wt-wt&df=`;
}

// Pull result rows out of a DDG HTML page: { title, href, snippet }.
// Regex on purpose (no DOM): the markup is server-rendered and stable, and
// spinning a page up per 10 results would defeat the point.
function parseDdgRows(html) {
  const src = String(html || '');
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const href = decodeHtml(m[1]);
    const title = stripTags(m[2]);
    if (!href || !title) continue;
    // Snippet follows its result block, up to the next result anchor.
    const rest = src.slice(m.index, m.index + 2400);
    const sn = rest.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    out.push({ title, href, snippet: sn ? stripTags(sn[1]).slice(0, 300) : '' });
    if (out.length >= PER_PAGE * 2) break;
  }
  return out;
}

function stripTags(s) {
  return decodeHtml(
    String(s || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** One DDG page: POST with an offset (this is the only way past page one). */
async function fetchDdgPage(query, offset, { fetchFn, timeoutMs = PAGE_TIMEOUT_MS } = {}) {
  const run = typeof fetchFn === 'function' ? fetchFn : fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Number(timeoutMs) || PAGE_TIMEOUT_MS);
  try {
    const res = await run(DDG_HTML, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        Accept: 'text/html',
      },
      body: formBody(query, offset),
    });
    if (!res.ok) return '';
    return String(await res.text());
  } catch {
    return ''; // network hiccup: stop the fan-out quietly
  } finally {
    clearTimeout(t);
  }
}

/**
 * How many extra pages we still need for `want` total results when we
 * already have `have`. Pure, so the pacing is testable.
 * DDG pages hold 10 results and page one is ALWAYS on screen already, so
 * the offsets start at the first page we don't have — never at 0.
 */
function planOffsets(have, want, { maxFetches = MAX_EXTRA_FETCHES } = {}) {
  const haveN = Math.max(0, Number(have) || 0);
  const need = Math.max(0, Number(want || 0) - haveN);
  const pages = Math.min(Math.ceil(need / PER_PAGE), Number(maxFetches) || MAX_EXTRA_FETCHES);
  if (pages <= 0) return [];
  const first = Math.max(PER_PAGE, Math.ceil(haveN / PER_PAGE) * PER_PAGE);
  return Array.from({ length: pages }, (_, i) => first + i * PER_PAGE);
}

/**
 * Variations of the query — the honest way to get MORE links when page 2
 * of DuckDuckGo repeats page 1. Sources, cheapest first:
 *   1. DuckDuckGo's own autocomplete phrases (the same endpoint the search
 *      bar uses; these are real related queries, not guesses).
 *   2. Two deterministic shapes when autocomplete has nothing: the current
 *      year, and "review".
 * Never throws; always returns strings worth searching for.
 */
async function queryVariants(query, { fetchFn, limit = MAX_VARIANTS } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const out = [];
  const seen = new Set([q.toLowerCase()]);
  const push = (t) => {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length < 3 || s.length > 60) return;
    if (seen.has(s.toLowerCase())) return;
    seen.add(s.toLowerCase());
    out.push(s);
  };
  try {
    const run = typeof fetchFn === 'function' ? fetchFn : fetch;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), PAGE_TIMEOUT_MS);
    try {
      const res = await run(`https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`, { signal: ctl.signal });
      if (res && res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) for (const p of data) push(p && p.phrase);
      }
    } finally {
      clearTimeout(t);
    }
  } catch { /* autocomplete is best-effort */ }
  const year = String(new Date().getFullYear());
  push(`${q} ${year}`);
  push(`${q} review`);
  return out.slice(0, Math.max(1, Number(limit) || MAX_VARIANTS));
}

/**
 * Fill up to `want` rows for `query`.
 * @param {object} opts
 * @param {number} opts.have      rows already on screen
 * @param {number} opts.want      target (the /links page size)
 * @param {Set}    opts.seen      urls already displayed (mutated)
 * @param {string[]} [opts.related]  variation queries (else: derived)
 * @param {function} [opts.fetchFn]  injectable for tests
 * @returns {Promise<{rows: Array, done: boolean, fetched: number}>}
 */
async function fillResults(query, { have = 0, want = 50, seen = new Set(), related = [], fetchFn, maxFetches = MAX_EXTRA_FETCHES } = {}) {
  const q = String(query || '').trim();
  // No query, nothing to fan out to. (Callers guard too; this keeps the
  // module honest on its own.)
  if (!q) return { rows: [], done: true, fetched: 0 };
  const { cleanLinks, unseenRows } = require('./links');
  const rows = [];
  const target = Math.max(0, Number(want) || 0);
  let fetched = 0;
  const budget = Math.max(0, Number(maxFetches) || MAX_EXTRA_FETCHES);

  // 1) Same query, next pages first — those are the most relevant links.
  for (const off of planOffsets(have, target, { maxFetches: budget })) {
    if (fetched >= budget || have + rows.length >= target) break;
    fetched++;
    const html = await fetchDdgPage(query, off, { fetchFn });
    if (!html) continue;
    const fresh = unseenRows(cleanLinks(parseDdgRows(html), PER_PAGE * 2, DDG_HTML), seen);
    rows.push(...fresh);
    if (!fresh.length) break; // exhausted (or blocked) — stop here
  }

  // 2) Variations: real related queries (autocomplete phrases), so the extra
  //    links are actually different pages instead of page two again.
  if (have + rows.length < target && budget - fetched > 0) {
    const variants = Array.isArray(related) && related.length
      ? related
      : await queryVariants(query, { fetchFn, limit: budget - fetched });
    for (const v of variants) {
      if (fetched >= budget || have + rows.length >= target) break;
      fetched++;
      const html = await fetchDdgPage(v, 0, { fetchFn });
      if (!html) continue;
      const fresh = unseenRows(cleanLinks(parseDdgRows(html), PER_PAGE, DDG_HTML), seen);
      rows.push(...fresh);
    }
  }

  const trimmed = rows.slice(0, Math.max(0, target - have));
  return { rows: trimmed, done: have + trimmed.length >= target, fetched };
}

module.exports = { DDG_HTML, PER_PAGE, MAX_EXTRA_FETCHES, MAX_VARIANTS, formBody, parseDdgRows, planOffsets, fetchDdgPage, queryVariants, fillResults };