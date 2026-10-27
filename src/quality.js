'use strict';

// Playback quality (data saver). Pure + unit-testable.
// Two-stage playback (resolve with yt-dlp, play direct URL in mpv):
// the resolve step walks player clients and takes the best REAL height any
// of them returns; merge pairs (video+audio) play via mpv --audio-file.
// Default 480p.

const QUALITIES = ['360', '480', '720', '1080', 'best'];
const DEFAULT_QUALITY = '480';
// Video output drivers, tried in order. `auto` chains gpu with software
// fallbacks in one spawn (covers init failures); explicit choices pin one
// driver for broken-GPU terminals (Intel MESA black screen etc.).
const VOS = ['auto', 'gpu', 'xv', 'x11', 'drm'];
const DEFAULT_VO = 'auto';
// Windowed player size: what Esc out of the fullscreen player restores to
// (mpv's normal-window geometry; without it mpv came back at its native,
// screen-filling size — user complaint). ~1000px wide keeps the TUI
// visible under the video.
const PLAYER_GEOMETRY = '1000x600';
// Max entries per spawned mpv playlist (command-line length safety).
const QUEUE_LIMIT = 25;

// ---- client ladder (quality resolve) ---------------------------------
// YouTube player clients in quality order. `default` is the richest (DASH/
// HLS up to 4K); `android` is always last because it can only serve the
// progressive 360p (itag 18) file. A client that is merely rate-limited
// must never lose to android.
const YT_CLIENTS = ['default', 'tv', 'web', 'ios', 'mweb', 'android'];
// Stop early after this many attempts once a playable URL is in hand:
// past that point another client almost never improves the height.
const MAX_CLIENT_ATTEMPTS = 4;
// Per-attempt and whole-resolve budgets. Sequential clients need a hard
// total cap — six stalled attempts must not hold the loader for a minute.
const CLIENT_TIMEOUT_MS = 12000;
const RESOLVE_BUDGET_MS = 25000;
// A client that just delivered keeps first try for ten minutes.
const STICKY_CLIENT_MS = 10 * 60 * 1000;
// yt-dlp needs a JS runtime plus the EJS challenge solver for YouTube's
// signature / n challenges. Without them "some formats may be missing"
// (yt-dlp's words) and high-res clients fall back to android's 360p.
// node is already the app's own runtime; the solver lib is cached after
// the first fetch (~/.cache/yt-dlp/challenge-solver).
const JS_RUNTIME_ARGS = ['--js-runtimes', 'node', '--remote-components', 'ejs:github'];
const QUEUE_JS_ARGS = [
  '--ytdl-raw-options-append=js-runtimes=node',
  '--ytdl-raw-options-append=remote-components=ejs:github',
];

// Sequential probe order: the sticky winner (never android) first, then
// the canonical order with android pinned last.
function clientLadder(sticky) {
  const out = [];
  const add = (c) => {
    if (YT_CLIENTS.includes(c) && !out.includes(c)) out.push(c);
  };
  if (sticky && sticky !== 'android') add(sticky);
  for (const c of YT_CLIENTS) add(c);
  return out;
}

// YouTube answers bursts with 429; only the client error text says so.
function isRateLimited(stderr) {
  return /HTTP Error 429|Too Many Requests/i.test(String(stderr || ''));
}

// yt-dlp --print %(height)s --print urls: a bare 3-4 digit line (when the
// height is known) plus up to two direct media URLs.
function parseResolveOutput(stdout) {
  const lines = String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const urls = lines.filter((s) => /^https?:\/\//i.test(s)).slice(0, 2);
  let height = 0;
  for (const l of lines) {
    const m = l.match(/^(\d{3,4})$/);
    if (m) { height = Number(m[1]); break; }
  }
  return { height, urls };
}

// Highest REAL height wins; ties prefer the merge pair (DASH/HLS video
// beats a progressive fallback at the same height — better bitrate).
// When every candidate overshoots the request (rare: no format at or
// below it), the SMALLER one wins so a data-saver level stays honest.
function pickBetter(cand, cur, wantH) {
  if (!cur) return true;
  const inA = cand.height === 0 || cand.height <= wantH;
  const inB = cur.height === 0 || cur.height <= wantH;
  if (inA !== inB) return inA;
  if (cand.height !== cur.height) return inA ? cand.height > cur.height : cand.height < cur.height;
  return !!(cand.merge && !cur.merge);
}

// Early-stop policy for the sequential ladder. Without any playable URL,
// keep walking to android (the reliable last resort). With one in hand:
// stop on an exact cap hit, a 1080p+ "best", the attempt cap, or after
// default was cross-checked once. Android itself always ends the walk.
// An OVERSHOOT (> request) is not a hit for data-saver levels: keep
// looking, because android's progressive 360 is always in range.
function shouldStop({ want, best, attempts, lastClient }) {
  if (!best) return lastClient === 'android';
  const wantH = want === 'best' ? Infinity : (Number(want) || 0);
  if (want === 'best') {
    if (best.height >= 1080) return true;
  } else if (best.height > wantH) {
    return lastClient === 'android';
  } else if (best.height === wantH) {
    return true;
  }
  if (lastClient === 'android') return true;
  if (attempts >= MAX_CLIENT_ATTEMPTS) return true;
  if (best.client === 'default' && attempts >= 2) return true;
  return false;
}

// The classic 429 consolation: android's 360p won only because the rich
// clients were throttled. One deliberate default retry is worth it.
function wantsPrimaryRetry(best, want) {
  if (!best || best.client !== 'android') return false;
  const wantH = want === 'best' ? Infinity : (Number(want) || 0);
  return wantH === Infinity || wantH > 360;
}

// One yt-dlp resolve attempt: format selector, honest height, direct URLs.
// The JS runtime/solver flags can be dropped for older yt-dlp builds that
// do not know them yet (the caller retries once without them).
function resolveArgs(selector, client, opts = {}) {
  const js = opts.js !== false;
  const args = ['--skip-download', '--no-playlist', '--ignore-errors', '-f', selector, '--print', '%(height)s', '--print', 'urls'];
  if (js) args.push(...JS_RUNTIME_ARGS);
  if (client && client !== 'default') args.push('--extractor-args', `youtube:player_client=${client}`);
  return args;
}

function normalizeQuality(v) {
  const raw = String(v == null ? '' : v).trim().toLowerCase().replace(/p$/, '');
  if (!raw) return null;
  if (raw === 'best' || raw === 'highest' || raw === '4k') return 'best';
  if (QUALITIES.includes(raw)) return raw;
  const n = Number(raw);
  if (Number.isFinite(n)) {
    if (n <= 360) return '360';
    if (n <= 480) return '480';
    if (n <= 720) return '720';
    if (n <= 1080) return '1080';
    return 'best';
  }
  return null;
}

function ytdlFormat(q) {
  // Merge-capable at every level: bestvideo+bestaudio lets clients serve
  // real DASH/HLS heights (mpv plays the pair via --audio-file, or stitches
  // it inside its own ytdl hook). The trailing progressive fallbacks keep
  // old or SABR-blocked clients playable at whatever single file they have.
  switch (normalizeQuality(q) || DEFAULT_QUALITY) {
    case '360': return 'bestvideo[height<=360]+bestaudio/best[height<=360]/best';
    case '480': return 'bestvideo[height<=480]+bestaudio/best[height<=480]/best';
    case '720': return 'bestvideo[height<=720]+bestaudio/best[height<=720]/best';
    case '1080': return 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best';
    default: return 'bestvideo+bestaudio/best';
  }
}

function progressiveFormat(q) {
  switch (normalizeQuality(q) || DEFAULT_QUALITY) {
    case '360': return 'best[height<=360]/best';
    case '480': return 'best[height<=480]/best';
    case '720': return 'best[height<=720]/best';
    case '1080': return 'best[height<=1080]/best';
    default: return 'best/best';
  }
}

function mpvArgs(url, quality) {
  // Legacy single-process args (kept for dry-run/tests). Live path uses
  // mpvDirectArgs() with a pre-resolved http URL (no ytdl hook in mpv).
  return ['--fullscreen', `--ytdl-format=${ytdlFormat(quality)}`, String(url)];
}

function mpvDirectArgs(directUrls) {
  const list = (Array.isArray(directUrls) ? directUrls : [directUrls])
    .map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u));
  if (list.length === 0) return null;
  if (list.length === 1) return ['--fullscreen', list[0]];
  // Separate video+audio tracks from `yt-dlp -g -f bestvideo+bestaudio`.
  return ['--fullscreen', list[0], `--audio-file=${list[1]}`];
}

// Up-next queue args: every entry plays through mpv's own ytdl hook, so
// playback starts immediately and rolls into the next video on its own.
// The format is merge-capable (verified: mpv 0.40's embedded ytdl_hook
// stitches requested_formats — HLS video + opus audio both played), and
// the client list tries the modern default clients first with android as
// the fallback for older yt-dlp builds where YouTube forces SABR on the
// default web client. android exposes only itag 18 360p, so it must never
// be the pin — pinning it capped every queued video at 360p. Dedupes,
// validates, caps at QUEUE_LIMIT. Returns null when nothing is playable.
function mpvQueueArgs(urls, quality) {
  const seen = new Set();
  const list = [];
  for (const u of Array.isArray(urls) ? urls : []) {
    const t = String(u || '').trim();
    if (!/^https?:\/\//i.test(t) || seen.has(t)) continue;
    seen.add(t);
    list.push(t);
    if (list.length >= QUEUE_LIMIT) break;
  }
  if (list.length === 0) return null;
  return ['--fullscreen', `--ytdl-format=${ytdlFormat(quality)}`, '--ytdl-raw-options-append=extractor-args=youtube:player_client=default,android', ...QUEUE_JS_ARGS, ...list];
}

function parseDirectUrls(stdout) {
  return String(stdout || '').split('\n').map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s)).slice(0, 2);
}

function cycleQuality(current) {
  const cur = normalizeQuality(current) || DEFAULT_QUALITY;
  const i = QUALITIES.indexOf(cur);
  return QUALITIES[(i + 1) % QUALITIES.length];
}

function describeQuality(q) {
  const n = normalizeQuality(q) || DEFAULT_QUALITY;
  if (n === 'best') return 'best (most data)';
  return `${n}p${n === '360' || n === '480' ? ' (data saver)' : ''}`;
}

function normalizeVo(v) {
  const raw = String(v == null ? '' : v).trim().toLowerCase();
  if (!raw) return null;
  if (VOS.includes(raw)) return raw;
  return null;
}

function describeVo(v) {
  const n = normalizeVo(v) || DEFAULT_VO;
  if (n === 'auto') return 'auto (gpu → xv → x11 fallbacks)';
  return `${n} (pinned)`;
}

module.exports = { QUALITIES, DEFAULT_QUALITY, QUEUE_LIMIT, VOS, DEFAULT_VO, PLAYER_GEOMETRY, YT_CLIENTS, MAX_CLIENT_ATTEMPTS, CLIENT_TIMEOUT_MS, RESOLVE_BUDGET_MS, STICKY_CLIENT_MS, JS_RUNTIME_ARGS, QUEUE_JS_ARGS, clientLadder, isRateLimited, parseResolveOutput, pickBetter, shouldStop, wantsPrimaryRetry, resolveArgs, normalizeVo, describeVo, normalizeQuality, ytdlFormat, progressiveFormat, mpvArgs, mpvDirectArgs, mpvQueueArgs, parseDirectUrls, cycleQuality, describeQuality };
