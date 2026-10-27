'use strict';

// Fast YouTube data plane (no Playwright).
// Pattern borrowed from Siriusmart/youtube-tui + ytfzf: search via API/yt-dlp,
// play via mpv. The headless-Chrome scraper in browser.js stays as fallback.
//
// Chain: yt-dlp ytsearch -> Invidious API -> [] (caller falls back to Playwright).
// All parsers are pure + unit-testable, nothing here throws fatally.

const { execFile } = require('child_process');

const YT_SEARCH_LIMIT_DEFAULT = 30;

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.jing.rocks',
  'https://iv.melmac.space',
];

function buildYouTubeSearchUrl(query) {
  const q = String(query || '').trim().slice(0, 120);
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
}

function videoIdFromUrl(url) {
  try {
    const u = new URL(String(url || ''));
    const h = u.hostname.toLowerCase();
    if (h === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0] || '';
      return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : '';
    }
    if (h === 'youtube.com' || h.endsWith('.youtube.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{6,20}$/.test(v)) return v;
      const m = u.pathname.match(/^\/(shorts|embed|live)\/([A-Za-z0-9_-]{6,20})/);
      if (m) return m[2];
    }
    return '';
  } catch {
    return '';
  }
}

function thumbForVideoId(id) {
  const v = String(id || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(v)) return null;
  // hqdefault (480x360, 4:3) always exists; mqdefault/hq720 variants 404 on old videos.
  return `https://i.ytimg.com/vi/${v}/hqdefault.jpg`;
}

function isYouTubeVideoUrl(url) {
  try {
    const u = new URL(String(url || ''));
    const h = u.hostname.toLowerCase();
    if (h === 'youtu.be') return !!videoIdFromUrl(url);
    if (h === 'youtube.com' || h.endsWith('.youtube.com')) {
      return /^\/(watch|shorts|embed|live)/.test(u.pathname) && !!videoIdFromUrl(url);
    }
    return false;
  } catch {
    return false;
  }
}

// Same-video check for now-playing marking: YouTube URLs compare by video
// id (watch/shorts/embed/youtu.be forms equal), anything else by exact
// URL sans fragment. Pure, never throws.
function sameVideoUrl(a, b) {
  try {
    const ida = videoIdFromUrl(a);
    const idb = videoIdFromUrl(b);
    if (ida && idb) return ida === idb;
  } catch { /* fall through to exact */ }
  try {
    const x = String(a || '').split('#')[0];
    const y = String(b || '').split('#')[0];
    return !!x && x === y;
  } catch {
    return false;
  }
}

// Normalize one yt-dlp --dump-json line (flat or full) into a picker row.
// Returns null for unusable lines. Pure.
function normalizeYtDlpEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const title = String(e.title || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  let id = String(e.id || '').trim();
  let url = String(e.webpage_url || e.url || '').trim();
  // Flat playlist entries give `url: "abcXYZ"` (bare id) instead of full URL.
  if ((!url || !/^https?:\/\//i.test(url)) && /^[A-Za-z0-9_-]{6,20}$/.test(url)) {
    id = url;
    url = `https://www.youtube.com/watch?v=${url}`;
  }
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
    id = videoIdFromUrl(url);
  }
  if (!id) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://www.youtube.com/watch?v=${id}`;
  if (!title) return null;
  // Stable thumbnail: hqdefault (~15KB JPEG) always exists and never
  // expires. The per-format hq720?sqp=... URLs yt-dlp reports are ~4x the
  // bytes (66KB webp), expire, and decode heavier — they caused high data
  // pull with no terminal output. Titles carry the list; thumb is preview.
  const thumb = thumbForVideoId(id);
  const channel = String(e.channel || e.uploader || '').trim().slice(0, 60);
  const row = {
    title,
    url,
    domain: 'youtube.com',
    thumb,
    video: true,
    kind: 'search',
  };
  if (channel) row.channel = channel;
  if (Number.isFinite(Number(e.duration)) && Number(e.duration) > 0) {
    row.duration = Number(e.duration);
  }
  return row;
}

function parseYtDlpOutput(stdout, limit = YT_SEARCH_LIMIT_DEFAULT) {
  const out = [];
  const seen = new Set();
  const lines = String(stdout || '').split('\n');
  for (const line of lines) {
    if (out.length >= limit) break;
    const t = line.trim();
    if (!t || !t.startsWith('{')) continue;
    try {
      const row = normalizeYtDlpEntry(JSON.parse(t));
      if (!row || seen.has(row.url)) continue;
      seen.add(row.url);
      out.push(row);
    } catch { /* skip malformed line */ }
  }
  return out;
}

// Run yt-dlp search. execFn injectable for tests. Never throws.
function searchViaYtDlp(query, { limit = YT_SEARCH_LIMIT_DEFAULT, timeoutMs = 15000, execFn } = {}) {
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return Promise.resolve({ rows: [], source: 'yt-dlp', error: 'empty query' });
  const n = Math.max(1, Math.min(50, Number(limit) || YT_SEARCH_LIMIT_DEFAULT));
  const run = execFn || ((args) => new Promise((resolve) => {
    execFile('yt-dlp', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) resolve({ err: String((err && err.message) || err) });
      else resolve({ stdout: String(stdout || '') });
    });
  }));
  const spec = `ytsearch${n}:${q}`;
  return Promise.resolve()
    .then(() => run(['--dump-json', '--flat-playlist', '--no-playlist', '--ignore-errors', spec]))
    .then((r) => {
      const raw = r && (r.stdout !== undefined ? r.stdout : r);
      if (r && r.err) return { rows: [], source: 'yt-dlp', error: r.err.slice(0, 200) };
      const rows = parseYtDlpOutput(typeof raw === 'string' ? raw : String((r && r.stdout) || ''), n);
      if (rows.length) return { rows, source: 'yt-dlp' };
      return { rows: [], source: 'yt-dlp', error: 'no results' };
    })
    .catch((e) => ({ rows: [], source: 'yt-dlp', error: String((e && e.message) || e).slice(0, 200) }));
}

// Normalize one Invidious search item. Pure, null when unusable.
function normalizeInvidiousItem(it) {
  if (!it || typeof it !== 'object') return null;
  if (String(it.type || 'video') !== 'video') return null;
  const id = String(it.videoId || '').trim();
  const title = String(it.title || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id) || !title) return null;
  // Same stable-thumb rule as normalizeYtDlpEntry: hqdefault only.
  const thumb = thumbForVideoId(id);
  const row = {
    title,
    url: `https://www.youtube.com/watch?v=${id}`,
    domain: 'youtube.com',
    thumb,
    video: true,
    kind: 'search',
  };
  const channel = String(it.author || '').trim().slice(0, 60);
  if (channel) row.channel = channel;
  if (Number.isFinite(Number(it.lengthSeconds)) && Number(it.lengthSeconds) > 0) {
    row.duration = Number(it.lengthSeconds);
  }
  return row;
}

async function searchViaInvidious(query, { limit = YT_SEARCH_LIMIT_DEFAULT, timeoutMs = 5000, fetchFn } = {}) {
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return { rows: [], source: 'invidious', error: 'empty query' };
  const n = Math.max(1, Math.min(50, Number(limit) || YT_SEARCH_LIMIT_DEFAULT));
  const f = fetchFn || global.fetch;
  if (typeof f !== 'function') return { rows: [], source: 'invidious', error: 'no fetch' };
  // Public instances are unreliable (401/403/502/DNS as of Oct 2026), so
  // race them in PARALLEL with a short budget: a dead fallback must fail
  // fast, not hang the picker spinner through sequential 8s timeouts.
  // Single page each — this is a fallback, speed beats depth (yt-dlp gives 30).
  const budget = Math.max(1000, Math.min(8000, Number(timeoutMs) || 5000));
  const fetchOne = async (base) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), budget);
    try {
      const res = await f(`${base}/api/v1/search?q=${encodeURIComponent(q)}&type=video&page=1`, {
        signal: ctl.signal,
        headers: { 'User-Agent': 'tui-browser/0.1', Accept: 'application/json' },
      });
      if (!res || !res.ok) return { base, data: [] };
      const data = await res.json();
      if (!Array.isArray(data)) return { base, data: [] };
      return { base, data };
    } catch {
      return { base, data: [] };
    } finally {
      clearTimeout(t);
    }
  };
  const settled = await Promise.all(INVIDIOUS_INSTANCES.map((b) => fetchOne(b).catch(() => ({ base: b, data: [] }))));
  const rows = [];
  const seen = new Set();
  let winner = '';
  for (const { base, data } of settled) {
    for (const it of data) {
      if (rows.length >= n) break;
      const row = normalizeInvidiousItem(it);
      if (!row || seen.has(row.url)) continue;
      seen.add(row.url);
      if (!winner) {
        try { winner = new URL(base).hostname; } catch { winner = 'invidious'; }
      }
      rows.push(row);
    }
    if (rows.length >= n) break;
  }
  if (rows.length) return { rows, source: `invidious:${winner || 'fallback'}` };
  return { rows: [], source: 'invidious', error: 'no results' };
}

// Fast path: yt-dlp first (best titles + no bot wall), Invidious second.
// Never throws; [] means caller should fall back to Playwright scraping.
async function searchYouTube(query, opts = {}) {
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return { rows: [], source: 'none', error: 'empty query' };
  const viaDlp = await searchViaYtDlp(q, opts).catch(() => ({ rows: [], source: 'yt-dlp' }));
  if (viaDlp && viaDlp.rows && viaDlp.rows.length) return viaDlp;
  const viaInv = await searchViaInvidious(q, opts).catch(() => ({ rows: [], source: 'invidious' }));
  if (viaInv && viaInv.rows && viaInv.rows.length) return viaInv;
  // Combined stage detail so the caller can show WHY nothing came back
  // (yt-dlp SABR/timeout vs dead Invidious) instead of a generic hint.
  const parts = [];
  if (viaDlp && viaDlp.error) parts.push(`yt-dlp: ${viaDlp.error}`);
  if (viaInv && viaInv.error) parts.push(`fallback: ${viaInv.error}`);
  return { rows: [], source: 'none', error: parts.join(' · ').slice(0, 300) || 'no results' };
}

function checkPlayerDeps({ execSyncFn } = {}) {
  const run = execSyncFn || (() => {
    try {
      // Lazy require so tests can inject failures without spawning.
      const { execSync } = require('child_process');
      return execSync;
    } catch {
      return null;
    }
  })();
  const out = { mpv: false, ytdlp: false, detail: '' };
  try {
    const execSync = run;
    if (typeof execSync !== 'function') return out;
    try {
      execSync('mpv --version', { stdio: 'ignore', timeout: 3000 });
      out.mpv = true;
    } catch { /* absent */ }
    try {
      execSync('yt-dlp --version', { stdio: 'ignore', timeout: 3000 });
      out.ytdlp = true;
    } catch { /* absent */ }
    const missing = [];
    if (!out.mpv) missing.push('mpv');
    if (!out.ytdlp) missing.push('yt-dlp');
    out.detail = missing.length
      ? `Missing: ${missing.join(', ')}. Install: sudo apt install mpv yt-dlp (YouTube search still works via fallback, playback needs mpv).`
      : 'mpv + yt-dlp ready.';
  } catch {
    /* best effort */
  }
  return out;
}

module.exports = {
  buildYouTubeSearchUrl,
  videoIdFromUrl,
  thumbForVideoId,
  isYouTubeVideoUrl,
  sameVideoUrl,
  normalizeYtDlpEntry,
  parseYtDlpOutput,
  normalizeInvidiousItem,
  searchViaYtDlp,
  searchViaInvidious,
  searchYouTube,
  checkPlayerDeps,
  YT_SEARCH_LIMIT_DEFAULT,
};
