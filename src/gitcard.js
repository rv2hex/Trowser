'use strict';

// Repository info cards for GitHub/GitLab links. Parses a repo URL, asks the
// public HTTPS APIs (api.github.com / gitlab.com — never git, never a clone)
// and formats a small plain-text card. The UI paints the lines verbatim: no
// blessed tags, no ANSI, BMP single-cell glyphs only (★ and · are already
// house glyphs). Everything is pure except fetchRepoCard, which takes an
// injectable fetch + TTL cache so tests never touch the network. Nothing in
// this file throws or rejects: callers get { ok:false, error } instead.

const CARD_WIDTH = 76;
const CACHE_MAX = 64;
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = 'tui-browser';

// Deep-link segments that end the repo part of a URL; the first one at or
// after the repo name (index 2 — a repo may itself be called 'issues' or
// 'tree') turns everything after it into decoration and drops it.
const STRIP_MARKERS = new Set(['tree', 'blob', 'issues', 'pulls', 'releases', 'wiki', 'commits', '-']);

function decodeSegment(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

// 'https://github.com/owner/repo/tree/main' -> { host, owner, repo, path }.
// Accepts http/https, optional www., trailing slash and .git. Deep links
// (/tree /blob /issues /pulls /releases /wiki /commits, GitLab /-/) are
// stripped; path keeps any extra non-marker segments between owner/repo and
// the first marker ('' in the normal case). GitHub is exactly owner/repo
// (2 segments); GitLab groups nest, so owner is the whole namespace.
// Anything that is not a github.com/gitlab.com repo URL -> null.
function parseRepoUrl(input) {
  let u;
  try {
    u = new URL(String(input == null ? '' : input).trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  const host = hostname === 'github.com' ? 'github' : hostname === 'gitlab.com' ? 'gitlab' : '';
  if (!host) return null;

  const segs = u.pathname.split('/').filter(Boolean).map(decodeSegment);
  if (segs.length < 2) return null;

  let stop = segs.length;
  for (let i = 2; i < segs.length; i++) {
    if (STRIP_MARKERS.has(segs[i].toLowerCase())) {
      stop = i;
      break;
    }
  }
  const head = segs.slice(0, stop);

  let owner;
  let repo;
  let path = '';
  if (host === 'github') {
    owner = head[0];
    repo = head[1];
    path = head.slice(2).join('/');
  } else {
    repo = head[head.length - 1];
    owner = head.slice(0, -1).join('/');
  }
  repo = repo.replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  return { host, owner, repo, path };
}

// GitHub: https://api.github.com/repos/owner/repo
// GitLab: https://gitlab.com/api/v4/projects/<owner%2Frepo> (namespace is
// a single URL-encoded path segment). '' for anything unparseable.
function apiUrlFor(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  const owner = String(parsed.owner || '');
  const repo = String(parsed.repo || '');
  if (!owner || !repo) return '';
  if (parsed.host === 'github') return `https://api.github.com/repos/${owner}/${repo}`;
  if (parsed.host === 'gitlab') {
    return `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${owner}/${repo}`)}`;
  }
  return '';
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// First field that is a non-empty string.
function strField(obj, ...names) {
  for (const n of names) {
    const s = str(obj[n]);
    if (s) return s;
  }
  return '';
}

// First countable field; missing/junk -> 0 so callers always get a number.
function countField(obj, ...names) {
  for (const n of names) {
    const v = Number(obj[n]);
    if (Number.isFinite(v)) return v;
  }
  return 0;
}

// GitHub prefers the SPDX id ('MIT'); GitLab's project payload carries the
// human name plus a nickname. 'NOASSERTION' is GitHub's "no license file
// detected" placeholder, not a license worth printing.
function licenseName(lic, host) {
  if (!lic) return '';
  if (typeof lic === 'string') return lic.trim();
  if (typeof lic !== 'object') return '';
  const keys = host === 'gitlab' ? ['name', 'nickname', 'spdx_id'] : ['spdx_id', 'name', 'nickname'];
  for (const k of keys) {
    const s = str(lic[k]);
    if (s && s !== 'NOASSERTION') return s;
  }
  return '';
}

// Normalizes either API's project payload into the card shape. Missing
// fields degrade to '' / 0 (never undefined) and cross-host fallbacks are
// harmless, so a partial or shifted payload still renders a sane card.
function parseRepoJson(host, json) {
  const j = json && typeof json === 'object' ? json : {};
  const h = host === 'gitlab' ? 'gitlab' : 'github';
  const name = strField(j, 'name', 'path');
  const fullName =
    h === 'gitlab'
      ? strField(j, 'path_with_namespace', 'full_name', 'name')
      : strField(j, 'full_name', 'path_with_namespace', 'name');
  const stars = h === 'gitlab' ? countField(j, 'star_count', 'stargazers_count') : countField(j, 'stargazers_count', 'star_count');
  const forks = countField(j, 'forks_count');
  const openIssues = countField(j, 'open_issues_count', 'open_issues');
  const language = strField(j, 'language');
  const license = licenseName(j.license, h);
  const updatedAt =
    h === 'gitlab'
      ? strField(j, 'last_activity_at', 'updated_at', 'pushed_at')
      : strField(j, 'pushed_at', 'updated_at', 'last_activity_at');
  const url = h === 'gitlab' ? strField(j, 'web_url', 'html_url') : strField(j, 'html_url', 'web_url');
  return { host: h, name, fullName, description: strField(j, 'description'), stars, forks, language, license, updatedAt, openIssues, url };
}

// Greedy word wrap, hard-breaking a single word longer than the width so no
// line ever exceeds it. Whitespace runs collapse to one space.
function wrapText(text, width) {
  const w = Math.max(1, Math.floor(width));
  const words = str(text).replace(/\s+/g, ' ').split(' ').filter(Boolean);
  const out = [];
  let cur = '';
  for (const word of words) {
    let chunk = word;
    while (chunk.length > w) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      out.push(chunk.slice(0, w));
      chunk = chunk.slice(w);
    }
    if (!chunk) continue;
    if (!cur) cur = chunk;
    else if (cur.length + 1 + chunk.length <= w) cur += ` ${chunk}`;
    else {
      out.push(cur);
      cur = chunk;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ISO/GitLab timestamps -> 'YYYY-MM-DD'; junk and '' -> '' (line omitted).
function shortDate(v) {
  const s = str(v);
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

// info -> plain text lines: full name, wrapped description, one stats line,
// 'updated <date>', url. Missing parts are dropped whole, never leaving a
// stray or doubled ' · '. Zero counts read as "nothing worth showing" (the
// APIs report 0 for absent fields too), so a sparse repo stays terse.
function formatRepoCard(info) {
  const i = info && typeof info === 'object' ? info : {};
  const lines = [];
  const fullName = str(i.fullName) || str(i.name);
  if (fullName) lines.push(fullName);
  for (const line of wrapText(i.description, CARD_WIDTH)) lines.push(line);

  const stats = [];
  const stars = Number(i.stars);
  if (Number.isFinite(stars) && stars > 0) stats.push(`★ ${stars}`);
  const forks = Number(i.forks);
  if (Number.isFinite(forks) && forks > 0) stats.push(`${forks} ${forks === 1 ? 'fork' : 'forks'}`);
  const language = str(i.language);
  if (language) stats.push(language);
  const license = str(i.license);
  if (license) stats.push(license);
  if (stats.length) lines.push(stats.join(' · '));

  const date = shortDate(i.updatedAt);
  if (date) lines.push(`updated ${date}`);
  const url = str(i.url);
  if (url) lines.push(url);
  return lines;
}

// Map-backed TTL cache: size-capped (oldest inserted evicted first) and
// clock-injectable so tests can travel through time without sleeping.
function createRepoCache(opts) {
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

// url -> Promise<{ ok:true, info, lines, cached } | { ok:false, error }>.
// opts: { fetchImpl, timeoutMs = 8000, cache, now }. The timeout is raced
// (not just an AbortSignal) so a hung fetchImpl still settles. Never
// throws or rejects; every failure is an error string the UI can show.
// `now` is accepted for symmetry with createRepoCache.
async function fetchRepoCard(url, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const parsed = parseRepoUrl(url);
  if (!parsed) return { ok: false, error: 'not a repo url' };
  const key = `${parsed.host}:${parsed.owner}/${parsed.repo}`;

  const cache = o.cache && typeof o.cache === 'object' ? o.cache : null;
  if (cache && typeof cache.get === 'function') {
    let hit;
    try {
      hit = cache.get(key);
    } catch {
      hit = undefined;
    }
    if (hit && hit.info) {
      const info = hit.info;
      const lines = Array.isArray(hit.lines) ? hit.lines.slice() : formatRepoCard(info);
      return { ok: true, info: { ...info }, lines, cached: true };
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
        fetchImpl(apiUrlFor(parsed), {
          // GitHub rejects requests without a User-Agent.
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
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

    let json;
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: timedOut ? 'timed out' : 'bad json' };
    }
    if (!json || typeof json !== 'object') return { ok: false, error: 'bad json' };

    const info = parseRepoJson(parsed.host, json);
    const lines = formatRepoCard(info);
    if (cache && typeof cache.set === 'function') {
      try {
        cache.set(key, { info, lines });
      } catch {
        /* cache is best-effort */
      }
    }
    return { ok: true, info, lines, cached: false };
  } catch (err) {
    if (timedOut || (err && err.name === 'AbortError')) return { ok: false, error: 'timed out' };
    return { ok: false, error: err && err.message ? String(err.message) : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { parseRepoUrl, apiUrlFor, parseRepoJson, formatRepoCard, createRepoCache, fetchRepoCard };
