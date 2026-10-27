'use strict';

// RSS 2.0 / Atom reading for /feeds. Everything here is pure except
// fetchFeed, which takes an injectable fetch + TTL cache so tests never
// touch the network. Nothing throws or rejects: callers get
// { ok:false, error } instead. Output is plain text for the TUI (items
// carry their links; the picker decides how to paint them).

const FETCH_TIMEOUT_MS = 8000;
const MAX_ITEMS = 60;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 32;
const USER_AGENT = 'tui-browser';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// HTML entities -> text: named (the common set), decimal and hex numeric.
// Unknown entities pass through untouched (never eat feed text).
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return m;
      }
    })
    .replace(/&#(\d+);/g, (m, d) => {
      try {
        return String.fromCodePoint(Number(d));
      } catch {
        return m;
      }
    })
    .replace(/&([a-z][a-z0-9]*);/gi, (m, n) => {
      const v = ENTITIES[n.toLowerCase()];
      return v !== undefined ? v : m;
    });
}

// Human text for a feed field: unwraps a whole-CDATA value, drops
// script/style bodies whole, strips tags, decodes entities and squeezes
// whitespace. Never throws; junk in -> '' out rather than raw markup.
function stripTags(s) {
  let t = String(s == null ? '' : s);
  const cdata = t.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) t = cdata[1];
  t = t
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  t = decodeEntities(t);
  return t.replace(/\s+/g, ' ').trim();
}

// First <name> inner text from a block, attributes/CDATA tolerated.
// '' when the tag is absent (or self-closing).
function tagInner(block, names) {
  for (const n of names) {
    const m = String(block || '').match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}>`, 'i'));
    if (m) return m[1];
  }
  return '';
}

// Item link: RSS puts it in the element text, Atom in <link href="…"/>
// (alternate rel wins; feeds often carry self/enclosure links too).
// '' when nothing usable is present.
function linkOf(block) {
  const text = stripTags(tagInner(block, ['link']));
  if (/^https?:\/\//i.test(text)) return text;
  const tags = String(block || '').match(/<link\b[^>]*\/?>/gi) || [];
  let fallback = '';
  for (const tag of tags) {
    const href = (tag.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (!/^https?:\/\//i.test(href)) continue;
    const rel = (tag.match(/rel\s*=\s*["']([^"']+)["']/i) || [])[1] || 'alternate';
    if (/alternate/i.test(rel)) return decodeEntities(href);
    if (!fallback) fallback = decodeEntities(href);
  }
  return fallback;
}

// Any common feed date field -> 'YYYY-MM-DD'; junk and '' -> ''.
function parseDate(s) {
  const raw = stripTags(s);
  if (!raw) return '';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

// parseFeed(xml) -> { ok:true, title, items } | { ok:false, error }.
// Items: { title, link, date, summary } — all strings, missing fields
// degrade to '' (never undefined). RSS <item> and Atom <entry> both work;
// the item cap bounds memory for giant feeds.
function parseFeed(xml) {
  const raw = String(xml == null ? '' : xml);
  if (!raw.trim()) return { ok: false, error: 'empty feed' };
  const isAtom = /<feed\b/i.test(raw);
  const blocks = raw.match(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1>/gi) || [];
  // RSS: title lives on the channel, not the whole document. Atom: first
  // <title> in the feed element is the feed's own.
  const head = isAtom ? raw : (raw.match(/<channel\b[^>]*>([\s\S]*?)<\/channel>/i) || [null, ''])[1];
  const title = stripTags(tagInner(head, ['title'])).slice(0, 200);
  const items = [];
  for (const b of blocks.slice(0, MAX_ITEMS)) {
    const t = stripTags(tagInner(b, ['title'])).slice(0, 200);
    const link = linkOf(b);
    if (!t && !link) continue;
    items.push({
      title: t || link,
      link,
      date: parseDate(tagInner(b, ['pubDate', 'published', 'updated', 'dc:date'])),
      summary: stripTags(tagInner(b, ['description', 'summary', 'content', 'content:encoded'])).slice(0, 300),
    });
  }
  if (!items.length && !title) return { ok: false, error: 'not a feed (no items found)' };
  return { ok: true, title: title || 'Feed', items };
}

// Map-backed TTL cache: size-capped (oldest inserted evicted first) and
// clock-injectable so tests travel through time without sleeping.
function createFeedCache(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const ttlMs = Number.isFinite(o.ttlMs) ? Math.max(0, o.ttlMs) : CACHE_TTL_MS;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { at: now(), value });
      while (entries.size > CACHE_MAX) entries.delete(entries.keys().next().value);
    },
  };
}

// fetchFeed(url, opts) -> Promise<{ ok:true, title, items, cached } |
// { ok:false, error }>. opts: { fetchImpl, timeoutMs = 8000, cache }.
// The timeout is raced (a fetch that ignores aborts still settles); the
// UA header rides along because several feeds 403 without one. Never
// throws or rejects.
async function fetchFeed(url, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'not a feed url' };

  const cache = o.cache && typeof o.cache.get === 'function' ? o.cache : null;
  if (cache) {
    let hit;
    try {
      hit = cache.get(target);
    } catch {
      hit = undefined;
    }
    if (hit && Array.isArray(hit.items)) {
      return { ok: true, title: hit.title, items: hit.items.map((x) => ({ ...x })), cached: true };
    }
  }

  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : typeof fetch === 'function' ? fetch : null;
  if (!fetchImpl) return { ok: false, error: 'fetch unavailable' };
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : FETCH_TIMEOUT_MS;
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  let timedOut = false;

  try {
    const res = await Promise.race([
      Promise.resolve(
        fetchImpl(target, {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
          },
          signal: ac ? ac.signal : undefined,
        })
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          if (ac) ac.abort();
          reject(new Error('timed out'));
        }, timeoutMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }),
    ]);

    const status = Number(res && res.status);
    const good = Number.isFinite(status) ? status >= 200 && status < 300 : !!(res && res.ok === true);
    if (!res || !good) return { ok: false, error: `HTTP ${Number.isFinite(status) ? status : 0}` };

    let text;
    try {
      text = await res.text();
    } catch {
      return { ok: false, error: timedOut ? 'timed out' : 'unreadable body' };
    }
    const parsed = parseFeed(text);
    if (!parsed.ok) return parsed;
    if (cache && typeof cache.set === 'function') {
      try {
        cache.set(target, { title: parsed.title, items: parsed.items });
      } catch {
        /* cache is best-effort */
      }
    }
    return { ok: true, title: parsed.title, items: parsed.items, cached: false };
  } catch (err) {
    if (timedOut || (err && err.name === 'AbortError')) return { ok: false, error: 'timed out' };
    return { ok: false, error: err && err.message ? String(err.message) : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { MAX_ITEMS, stripTags, decodeEntities, parseFeed, createFeedCache, fetchFeed };
