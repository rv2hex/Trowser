'use strict';

// Terminal image layer. Text stays the primary surface: thumbnails are a
// transient overlay for terminals that speak graphics, with a plain-text
// fallback everywhere else.
//
// Why Kitty-direct: Konsole (24.02+) accepts Kitty graphics in
// direct-transmit mode, and Kitty/Ghostty/WezTerm speak it natively. PNG
// bytes pass through untouched, so no decoder and no new dependency.
// Sixel would need an encoder; ASCII conversion would need a decoder.
// Neither cost is justified for thumbnails.
//
// Two hard constraints shape this module:
// 1. blessed owns the screen buffer and `sanitizeLine` strips ESC bytes,
//    so graphics can never travel through body content. All writes here go
//    straight to process.stdout, bypassing blessed.
// 2. blessed repaints text over (or under) graphics on the next render, so
//    every image is transient by design: callers clear on each paint.

const CHUNK_SIZE = 4096;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 1500000;
// Memory budgets. Originals are bounded by BYTES, not entry count: each can
// be up to MAX_BYTES, so "20 entries" could pin 30 MB. Display PNGs are the
// resized output, cached by target box so a repaint (or the fullscreen view)
// never re-decodes the same photo through sharp.
const BYTES_CACHE_MAX_BYTES = 12 * 1024 * 1024;
const BYTES_CACHE_MAX_ITEMS = 48;
const DISPLAY_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const DISPLAY_CACHE_MAX_ITEMS = 96;

// Disk paths (PDF page renders, saved images) are not fetchable URLs, but
// the viewer hands them around like one. Recognize absolute paths and
// file:// URLs so every image surface (pane, fullscreen, gallery grid)
// works for local files exactly like for http(s).
function localFilePath(url) {
  const s = String(url || '');
  if (s.startsWith('file://')) {
    try {
      return require('url').fileURLToPath(s);
    } catch {
      return null;
    }
  }
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  return null;
}

// Capability probe. Conservative on purpose: unknown terminals get 'none'
// and the caller falls back to titles + [alt] text.
function detectImageSupport(env = process.env) {
  const e = env || {};
  if (e.KITTY_WINDOW_ID) return 'kitty';
  if (e.GHOSTTY_RESOURCES_DIR) return 'kitty';
  if (e.WEZTERM_PANE) return 'kitty';
  if (e.KONSOLE_VERSION) return 'kitty';
  const term = String(e.TERM || '').toLowerCase();
  const prog = String(e.TERM_PROGRAM || '').toLowerCase();
  if (term.includes('kitty') || term.includes('ghostty')) return 'kitty';
  if (term.includes('konsole') || prog.includes('konsole')) return 'kitty';
  if (term.includes('wezterm') || prog.includes('wezterm')) return 'kitty';
  return 'none';
}

// Extended graphics probe: kitty | iterm2 | none. ASCII art always works
// (see bufferToAscii) so callers use bestImageMode() when they can fall
// back to text instead of giving up on 'none'.
function detectGraphics(env = process.env) {
  if (detectImageSupport(env) === 'kitty') return 'kitty';
  const e = env || {};
  if (e.ITERM_SESSION_ID) return 'iterm2';
  const prog = String(e.TERM_PROGRAM || '').toLowerCase();
  if (prog === 'iterm.app' || prog.includes('iterm')) return 'iterm2';
  return 'none';
}

// Best mode the current terminal can show: graphics when available,
// otherwise 'ascii' (plain text — works everywhere, zero protocol).
function bestImageMode(env = process.env) {
  const g = detectGraphics(env);
  return g === 'none' ? 'ascii' : g;
}

// Pure: split base64 into Kitty chunk payloads. Unit-testable without a
// terminal. Last chunk carries m=0, the rest m=1.
// Aspect rule: pass exactly ONE of cols/rows and the terminal scales the
// other to preserve the native aspect (no stretch). Passing both forces
// the image into that cell box (distorts non-matching aspects) — callers
// must use fitOverlay() below instead of hardcoding both.
// Default is cols-only (no implicit rows) so fitOverlay() single-dim output
// can never regain a second dimension via defaults.
function kittyChunks(base64, { cols, rows } = {}) {
  if (cols == null && rows == null) cols = 30;
  const parts = [];
  const size = [cols == null ? null : `c=${cols}`, rows == null ? null : `r=${rows}`].filter(Boolean).join(',');
  const head = `a=T,f=100${size ? `,${size}` : ''},m=`;
  for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
    const last = i + CHUNK_SIZE >= base64.length;
    parts.push(`\x1b_G${head}${last ? 0 : 1};${base64.slice(i, i + CHUNK_SIZE)}\x1b\\`);
  }
  return parts;
}

// PNG IHDR size without any dependency (toDisplayPng always emits PNG).
// Returns { w, h } or null for non-PNG / short buffers.
function pngSize(buf) {
  try {
    if (!buf || buf.length < 24) return null;
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || w > 20000 || h > 20000) return null;
    return { w, h };
  } catch {
    return null;
  }
}

// Fit an image into a max cell box WITHOUT stretching: returns a single
// dimension ({ cols } OR { rows }) so the terminal derives the other from
// the native aspect. Never returns both (both forces stretch in Kitty).
// Cell-aware: terminal cells are ~2x as tall as wide, so a cols-constrained
// wide image could still overflow maxRows in row terms — in that case we
// constrain rows instead. Pure + unit-testable.
// `cap` (default true) bounds the box to thumbnail sizes (60x40). Callers
// showing a real fullscreen view pass cap:false so the box is the caller's
// own maxCols/maxRows — a fullscreen photo should fill the screen, not
// stop at thumbnail scale.
const CELL_H_PER_W = 2;
function fitOverlay(size, { maxCols = 30, maxRows = 12, cap = true } = {}) {
  const mc = cap ? Math.max(8, Math.min(60, Number(maxCols) || 30)) : Math.max(8, Number(maxCols) || 30);
  const mr = cap ? Math.max(6, Math.min(40, Number(maxRows) || 12)) : Math.max(6, Number(maxRows) || 12);
  if (!size || !Number.isFinite(size.w) || !Number.isFinite(size.h) || size.w <= 0 || size.h <= 0) {
    return { cols: mc };
  }
  // Rows the image would occupy if we fixed cols=mc (cell-corrected).
  const rowsIfCols = (mc * size.h) / (size.w * CELL_H_PER_W);
  if (rowsIfCols <= mr) return { cols: mc };
  return { rows: mr };
}

function clearImages() {
  // Delete all kitty-transmitted images. Best effort: never throws, so
  // callers can run it unconditionally on every repaint.
  try {
    process.stdout.write('\x1b_Ga=d\x1b\\');
  } catch {
    /* stdout gone — nothing to clear */
  }
}

// Cell footprint of an emitted overlay: we constrain ONE dimension and the
// terminal derives the other from the native aspect (cells are ~2x tall as
// wide). Used to CENTER an image in a box — the anchor is the image's
// top-left, so it must be nudged by half the leftover space.
function cellFootprint(size, dims) {
  const s = size && size.w > 0 && size.h > 0 ? size : null;
  if (dims && dims.cols != null) {
    const cols = Number(dims.cols) || 30;
    if (!s) return { cols, rows: Math.max(1, Math.round(cols / 2)) };
    return { cols, rows: Math.max(1, Math.round((cols * s.h) / (s.w * CELL_H_PER_W))) };
  }
  const rows = Number((dims && dims.rows) || 12) || 12;
  if (!s) return { cols: Math.max(1, rows * 2), rows };
  return { cols: Math.max(1, Math.round((rows * s.w * CELL_H_PER_W) / s.h)), rows };
}

// Rotate a display PNG by `degrees` clockwise (ctrl+r). Sharp-only: with no
// decoder the image is returned untouched — an unrotated photo beats a
// broken one. Pure-ish (async), never throws.
async function applyRotation(png, degrees) {
  const deg = (((Number(degrees) || 0) % 360) + 360) % 360;
  if (!deg) return png;
  try {
    const sharp = require('sharp');
    return await sharp(png, { animated: false }).rotate(deg).png().toBuffer();
  } catch {
    return png;
  }
}

function recommendTerminal(env = process.env) {
  if (detectImageSupport(env) !== 'none') return null;
  const term = String((env || {}).TERM || 'unknown');
  const prog = String((env || {}).TERM_PROGRAM || 'unknown');
  return [
    `Images: graphics protocol not detected (TERM=${term} PROGRAM=${prog}).`,
    'Kitty/Ghostty/WezTerm/Konsole show full thumbnails automatically.',
    'Here you still get: ASCII preview + /gallery + /img <n> + /img save.',
    'Tip: /img 1 renders the first image as text art on any terminal.',
  ].join('\n');
}

// Cached sharp probe: most of the web is JPEG/WebP, which only sharp can
// convert for graphics overlays AND ascii art. Without it, PNGs still pass
// through but everything else degrades to text — callers use this to say
// why instead of painting silent blanks.
let sharpState = null;
function detectSharp() {
  if (sharpState !== null) return sharpState;
  try {
    require('sharp');
    sharpState = true;
  } catch {
    sharpState = false;
  }
  return sharpState;
}

// Magic-byte sniffing: content-type lies (or is missing) on hotlink-
// protected CDNs, so trust the bytes. Returns png|jpeg|gif|webp|bmp|avif
// or 'unknown'. Covers every format sharp can convert for Kitty.
function detectImageFormat(buf) {
  try {
    if (!buf || buf.length < 12) return 'unknown';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
    const head = buf.slice(4, 12).toString('ascii');
    if (head.includes('ftyp')) {
      if (buf.slice(8, 12).toString('ascii').includes('avif')) return 'avif';
      return 'unknown';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// Convert any downloaded image to Kitty-ready PNG bytes (resized to fit).
// sharp is lazy-required so unit tests and minimal installs still run.
// Best-effort: native PNGs pass through; anything sharp can convert is
// converted; anything else falls back to the raw bytes (the fetch layer
// already ensured image/* content-type, so the terminal gets a chance
// instead of a silent false — this keeps mocked + edge bytes testable).
// Uniform scale only: fit:'inside' + withoutEnlargement preserves aspect,
// never stretches. Returns a Buffer or null only when there is nothing to send.
async function toDisplayPng(buf, { maxWidth = 800, maxHeight = 600 } = {}) {
  if (!buf || buf.length === 0) return null;
  const fmt = detectImageFormat(buf);
  if (fmt === 'png') {
    // Even native PNGs are bounded so a 4000px portrait can't overflow the
    // overlay box and read as "stretched". withoutEnlargement keeps small
    // thumbs at original size (no upscale blur).
    try {
      const sharp = require('sharp');
      return await sharp(buf, { animated: false })
        .resize({ width: maxWidth, height: maxHeight, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
    } catch {
      return buf;
    }
  }
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    // No converter: trust the fetch content-type check and transmit raw.
    // Terminals that need PNG may blank — the caller reports a plain
    // failure (ASCII is used only when the terminal has no image protocol).
    return buf;
  }
  try {
    return await sharp(buf, { animated: false }).resize({ width: maxWidth, height: maxHeight, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch {
    // Corrupt/short mocked bytes (e.g. unit tests) or sharp decode miss:
    // return raw so the overlay path stays testable; real failures surface
    // as a blank image, never a crash. ASCII is a no-graphics fallback only.
    return buf;
  }
}

// Cache + in-flight dedupe wrapper. The gallery asks for the same image
// from the ASCII queue and the graphics queue at the same moment; without
// this they open two sockets and hold two copies of the bytes.
async function fetchBytes(url, opts = {}) {
  if (!opts.cache) return fetchBytesOnce(url, opts);
  const key = String(url);
  try {
    const hit = BYTES_CACHE.get(key);
    if (hit && hit.length > 0) {
      BYTES_CACHE.delete(key);
      BYTES_CACHE.set(key, hit);
      return hit;
    }
  } catch { /* cache is best-effort */ }
  const pending = FETCH_INFLIGHT.get(key);
  if (pending) return pending;
  const p = fetchBytesOnce(url, opts).finally(() => { FETCH_INFLIGHT.delete(key); });
  FETCH_INFLIGHT.set(key, p);
  return p;
}

async function fetchBytesOnce(url, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BYTES, referer, cache = false } = {}) {
  // Local file: read straight off disk (bounded), never through fetch().
  const lp = localFilePath(url);
  if (lp) {
    try {
      const st = require('fs').statSync(lp);
      if (!st.isFile() || st.size <= 0 || st.size > maxBytes) return null;
      const buf = require('fs').readFileSync(lp);
      const fmt = detectImageFormat(buf);
      buf.contentType = fmt !== 'unknown' ? `image/${fmt}` : 'application/octet-stream';
      if (cache) rememberBytes(url, buf);
      return buf;
    } catch {
      return null;
    }
  }
  // Opt-in memory cache (gallery sizing + overlay double-fetch): callers
  // that fetch the same URL twice in one flow pass cache:true. Default
  // stays uncached so one-off fetches never serve stale bytes.
  if (cache) {
    try {
      const key = String(url);
      const hit = BYTES_CACHE.get(key);
      if (hit && hit.length > 0) {
        // Touch on hit (delete + set) keeps map order = recency order: true
        // LRU — the images actually being revisited survive eviction.
        BYTES_CACHE.delete(key);
        BYTES_CACHE.set(key, hit);
        return hit;
      }
    } catch { /* cache is best-effort */ }
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let origin = null;
    try { origin = new URL(String(url)).origin; } catch { /* keep null */ }
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        // Browser UA + Accept + Referer: image CDNs (pinimg and friends)
        // 403 bot-like fetches; look like the page's own browser.
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        ...(origin ? { Referer: referer || `${origin}/` } : {}),
      },
    });
    if (!res.ok || !res.body) return null;
    const ctype = String(res.headers.get('content-type') || '');
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* best effort */
        }
        return null;
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    // Trust bytes over headers: accept when EITHER claims image.
    if (ctype && !ctype.startsWith('image/') && detectImageFormat(buf) === 'unknown') return null;
    if (!ctype && detectImageFormat(buf) === 'unknown') return null;
    buf.contentType = ctype;
    if (cache) rememberBytes(url, buf);
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Show an image at an absolute cell (1-based row/col). The caller owns
// positioning (it knows the body geometry); this function only emits.
// Non-PNG sources (JPEG/WebP/GIF — i.e. most of the web) are converted
// via sharp first: Kitty's protocol speaks PNG (f=100), and handing it
// raw JPEG bytes is exactly the old silent-blank bug. Without sharp only
// native PNGs display; anything else returns false honestly.
// Returns true when bytes were written, false on any failure.
async function showThumbnail(url, { row, col, cols = 30, rows = 12, referer, cache = false, cap = true, rotate = 0, center = false } = {}) {
  if (detectImageSupport() === 'none') return false;
  if (!url || !Number.isFinite(row) || !Number.isFinite(col)) return false;
  const bytes = await fetchBytes(url, { referer, cache });
  if (!bytes || bytes.length === 0) return false;
  // Resize to the box being drawn (~14x28 px cells), not always 800x600:
  // a 20x5 grid cell needs a fraction of the pixels, and the smaller PNG
  // is cached for instant repaints. Fullscreen still gets the 800x600 cap.
  const maxW = Math.max(64, Math.min(800, Math.round((Number(cols) || 30) * 14)));
  const maxH = Math.max(64, Math.min(600, Math.round((Number(rows) || 12) * 28)));
  const dkey = displayCacheKey(url, maxW, maxH);
  let png = null;
  try {
    const hit = DISPLAY_CACHE.get(dkey);
    if (hit && hit.length) {
      // Touch on hit: map order stays true recency order for eviction.
      DISPLAY_CACHE.delete(dkey);
      DISPLAY_CACHE.set(dkey, hit);
      png = hit;
    }
  } catch { /* cache miss is fine */ }
  if (!png) {
    png = await toDisplayPng(bytes, { maxWidth: maxW, maxHeight: maxH });
    if (png && png.length) rememberDisplay(dkey, png);
  }
  if (!png || png.length === 0) return false;
  png = await applyRotation(png, rotate);
  // Without sharp, non-PNG bytes would transmit as garbage f=100 and paint
  // a silent blank — fail fast instead so callers fall back to text.
  // (iTerm2 needs no such guard: OSC 1337 sniffs JPEG natively.)
  try {
    if (detectImageFormat(bytes) !== 'png' && !detectSharp()) return false;
  } catch { /* probe is best-effort */ }
  // Native aspect: fit inside the max box, never stretch into it.
  // Same path serves photo, art, and video thumbnails/posters.
  // Fullscreen callers pass cap:false to escape thumbnail clamps.
  let dims;
  try {
    dims = fitOverlay(pngSize(png), { maxCols: cols, maxRows: rows, cap: cap !== false });
  } catch {
    dims = { cols: Number(cols) || 30 };
  }
  // Center inside the box when asked: the anchor IS the image's top-left,
  // so nudge it by half the leftover cells (fullscreen "dead center").
  let anchorRow = row;
  let anchorCol = col;
  if (center) {
    try {
      const f = cellFootprint(pngSize(png), dims);
      anchorRow = row + Math.max(0, Math.floor((Number(rows) - f.rows) / 2));
      anchorCol = col + Math.max(0, Math.floor((Number(cols) - f.cols) / 2));
    } catch { /* uncentered beats unpainted */ }
  }
  try {
    const out =
      '\x1b7' + // save cursor
      `\x1b[${anchorRow};${anchorCol}H` + // move to anchor
      kittyChunks(png.toString('base64'), dims).join('') +
      '\x1b8'; // restore cursor
    process.stdout.write(out);
    return true;
  } catch {
    return false;
  }
}

// ---- Universal fallback: iTerm2 inline + ASCII text (works everywhere) ----

const ASCII_CHARS = ' .:-=+*#%@';
const ASCII_CACHE = new Map(); // url|width -> ascii string (max 30 entries)
const BYTES_CACHE = new Map(); // url -> Buffer (byte-budgeted LRU)
const FETCH_INFLIGHT = new Map(); // url -> Promise<Buffer> (cache:true only)
const DISPLAY_CACHE = new Map(); // url|WxH -> PNG Buffer (byte-budgeted LRU)
let bytesCacheBytes = 0;
let displayCacheBytes = 0;

function asciiCacheKey(url, width) {
  return `${String(url)}|${Number(width) || 0}`;
}

function rememberBytes(url, buf) {
  if (!url || !buf) return;
  try {
    const key = String(url);
    // Delete-before-set: re-remembering a URL refreshes its recency (moves
    // it to the end) instead of leaving the stale insertion order.
    const prev = BYTES_CACHE.get(key);
    if (prev) {
      BYTES_CACHE.delete(key);
      bytesCacheBytes -= prev.length || 0;
    }
    // One image bigger than the whole budget is not worth pinning; the
    // caller still gets the bytes, they just are not remembered.
    if (buf.length > BYTES_CACHE_MAX_BYTES) return;
    while (BYTES_CACHE.size && (bytesCacheBytes + buf.length > BYTES_CACHE_MAX_BYTES || BYTES_CACHE.size >= BYTES_CACHE_MAX_ITEMS)) {
      const first = BYTES_CACHE.keys().next().value;
      if (first === undefined) break;
      const old = BYTES_CACHE.get(first);
      BYTES_CACHE.delete(first);
      bytesCacheBytes -= (old && old.length) || 0;
    }
    if (bytesCacheBytes < 0) bytesCacheBytes = 0;
    BYTES_CACHE.set(key, buf);
    bytesCacheBytes += buf.length;
  } catch { /* cache is best-effort */ }
}

// Same LRU discipline for already-converted display PNGs, with its own
// budget. Keyed by the exact resized box, so a grid thumbnail never evicts
// the fullscreen render of the same photo.
function displayCacheKey(url, maxWidth, maxHeight) {
  return `${String(url)}|${maxWidth}x${maxHeight}`;
}

function rememberDisplay(key, png) {
  if (!key || !png || !png.length) return;
  try {
    const prev = DISPLAY_CACHE.get(key);
    if (prev) {
      DISPLAY_CACHE.delete(key);
      displayCacheBytes -= prev.length || 0;
    }
    if (png.length > DISPLAY_CACHE_MAX_BYTES) return;
    while (DISPLAY_CACHE.size && (displayCacheBytes + png.length > DISPLAY_CACHE_MAX_BYTES || DISPLAY_CACHE.size >= DISPLAY_CACHE_MAX_ITEMS)) {
      const first = DISPLAY_CACHE.keys().next().value;
      if (first === undefined) break;
      const old = DISPLAY_CACHE.get(first);
      DISPLAY_CACHE.delete(first);
      displayCacheBytes -= (old && old.length) || 0;
    }
    if (displayCacheBytes < 0) displayCacheBytes = 0;
    DISPLAY_CACHE.set(key, png);
    displayCacheBytes += png.length;
  } catch { /* cache is best-effort */ }
}

// iTerm2 inline image: OSC 1337 File protocol. Works in iTerm2, WezTerm
// (fallback), VS Code terminal. Pure + unit-testable.
function iterm2Sequence(base64, { width = 'auto', height = 'auto', name = '' } = {}) {
  const b64 = String(base64 || '');
  if (!b64) return '';
  const w = width === 'auto' ? 'auto' : Number(width) || 'auto';
  const h = height === 'auto' ? 'auto' : Number(height) || 'auto';
  let namePart = '';
  try {
    if (name) namePart = `;name=${Buffer.from(String(name)).toString('base64')}`;
  } catch { /* no name */ }
  return `\x1b]1337;File=inline=1;width=${w};height=${h};preserveAspectRatio=1${namePart}:${b64}\x07`;
}

async function showIterm2(url, { row, col, width = 30, height = 12, referer, cache = false, rotate = 0, center = false } = {}) {
  if (detectGraphics() !== 'iterm2') return false;
  if (!url || !Number.isFinite(row) || !Number.isFinite(col)) return false;
  const bytes = await fetchBytes(url, { referer, cache });
  if (!bytes || bytes.length === 0) return false;
  const maxW = Math.max(64, Math.min(800, Math.round((Number(width) || 30) * 14)));
  const maxH = Math.max(64, Math.min(600, Math.round((Number(height) || 12) * 28)));
  const dkey = displayCacheKey(url, maxW, maxH);
  let png = null;
  try {
    const hit = DISPLAY_CACHE.get(dkey);
    if (hit && hit.length) {
      DISPLAY_CACHE.delete(dkey);
      DISPLAY_CACHE.set(dkey, hit);
      png = hit;
    }
  } catch { /* cache miss is fine */ }
  if (!png) {
    png = await toDisplayPng(bytes, { maxWidth: maxW, maxHeight: maxH });
    if (png && png.length) rememberDisplay(dkey, png);
  }
  if (!png || png.length === 0) return false;
  png = await applyRotation(png, rotate);
  // Native aspect: constrain one side, auto the other (plus the protocol's
  // own preserveAspectRatio flag) — never stretch.
  let dims = { width: Number(width) || 30, height: 'auto' };
  let portrait = false;
  try {
    const s = pngSize(png);
    if (s && s.h > s.w) { portrait = true; dims = { width: 'auto', height: Number(height) || 12 }; }
  } catch { /* default stands */ }
  // Center inside the box when asked: the anchor IS the image's top-left,
  // so nudge it by half the leftover cells along the derived dimension.
  let anchorRow = row;
  let anchorCol = col;
  if (center) {
    try {
      const s = pngSize(png);
      if (portrait) {
        const f = cellFootprint(s, { rows: Number(height) || 12 });
        anchorCol = col + Math.max(0, Math.floor(((Number(width) || 30) - f.cols) / 2));
      } else {
        const f = cellFootprint(s, { cols: Number(width) || 30 });
        anchorRow = row + Math.max(0, Math.floor(((Number(height) || 12) - f.rows) / 2));
      }
    } catch { /* uncentered beats unpainted */ }
  }
  try {
    const out =
      '\x1b7' +
      `\x1b[${anchorRow};${anchorCol}H` +
      iterm2Sequence(png.toString('base64'), { ...dims, name: String(url).slice(0, 60) }) +
      '\x1b8';
    process.stdout.write(out);
    return true;
  } catch {
    return false;
  }
}

// Convert decoded bytes to plain-text grayscale art. Uses sharp when
// available (resizes + grayscales + raw pixels); returns null when the
// bytes cannot be decoded. Plain text survives blessed's buffer (no ESC),
// so this is the everywhere-fallback for thumbnails.
async function bufferToAscii(buf, { width = 48, maxHeight = 24 } = {}) {
  if (!buf || buf.length === 0) return null;
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    return null;
  }
  try {
    const w = Math.max(16, Math.min(80, Number(width) || 48));
    const mh = Math.max(4, Math.min(40, Number(maxHeight) || 24));
    // Terminal cells are ~2x as tall as wide: target half-height rows so
    // circles stay round instead of stretching tall (same rule as overlays).
    let targetH = mh;
    try {
      const meta = await sharp(buf, { animated: false }).metadata();
      if (meta && meta.width && meta.height) {
        targetH = Math.max(4, Math.min(mh, Math.round((w * meta.height) / meta.width / 2)));
      }
    } catch { /* fall back to sampling below */ }
    const { data, info } = await sharp(buf, { animated: false })
      .resize({ width: w, height: targetH, fit: 'inside', withoutEnlargement: true })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const iw = info.width || w;
    const ih = info.height || 1;
    const ch = info.channels || 1;
    // Sample rows down to maxHeight so art never floods the body.
    const step = Math.max(1, Math.floor(ih / (Number(maxHeight) || 24)));
    const lines = [];
    for (let y = 0; y < ih; y += step) {
      let line = '';
      for (let x = 0; x < iw; x++) {
        const v = data[(y * iw + x) * ch] || 0;
        line += ASCII_CHARS[Math.min(ASCII_CHARS.length - 1, Math.floor((v / 256) * ASCII_CHARS.length))];
      }
      // Trim trailing blanks so narrow terminals don't wrap.
      lines.push(line.replace(/\s+$/, ''));
      if (lines.length >= (Number(maxHeight) || 24)) break;
    }
    // Drop leading/trailing blank lines (letterboxing).
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) return null;
    return lines.join('\n');
  } catch {
    return null;
  }
}

// Fetch + convert + memoize. Returns the art string or null. Never throws.
async function getImageAscii(url, { width = 48, maxHeight = 24, referer } = {}) {
  const key = asciiCacheKey(url, width);
  if (ASCII_CACHE.has(key)) {
    const hit = ASCII_CACHE.get(key);
    // Touch on hit (delete + set) keeps map order = recency order: true LRU.
    ASCII_CACHE.delete(key);
    ASCII_CACHE.set(key, hit);
    return hit;
  }
  try {
    let bytes = BYTES_CACHE.get(String(url)) || null;
    if (!bytes) {
      // cache:true also dedupes this with the graphics queue's fetch of the
      // same URL, so a grid cell never downloads twice.
      bytes = await fetchBytes(url, { referer, cache: true });
    }
    if (!bytes) return null;
    const art = await bufferToAscii(bytes, { width, maxHeight });
    if (art) {
      try {
        // Delete first so a re-render counts as the newest entry (LRU).
        ASCII_CACHE.delete(key);
        if (ASCII_CACHE.size >= 30) {
          const first = ASCII_CACHE.keys().next().value;
          ASCII_CACHE.delete(first);
        }
        ASCII_CACHE.set(key, art);
      } catch { /* best effort */ }
    }
    return art;
  } catch {
    return null;
  }
}

// Fire-and-forget warmup for this page's images (first N). Never throws,
// never blocks navigation paint — fills BYTES_CACHE for instant /img.
function prefetchImages(urls, { limit = 6 } = {}) {
  try {
    const list = (Array.isArray(urls) ? urls : []).slice(0, Math.max(0, Number(limit) || 6));
    for (const u of list) {
      const src = u && (u.src || u.url || u);
      if (!src || BYTES_CACHE.has(String(src))) continue;
      fetchBytes(src, { cache: true }).catch(() => {});
    }
  } catch { /* best effort */ }
}

// Diagnostics for tests (and /stats if it ever wants real numbers). Entry
// counts plus bytes; both caches evict from the front of their Map.
function cacheStats() {
  return {
    bytesEntries: BYTES_CACHE.size,
    bytesBytes: bytesCacheBytes,
    displayEntries: DISPLAY_CACHE.size,
    displayBytes: displayCacheBytes,
  };
}

module.exports = { detectImageSupport, detectGraphics, bestImageMode, detectSharp, recommendTerminal, kittyChunks, pngSize, fitOverlay, cellFootprint, applyRotation, clearImages, fetchBytes, toDisplayPng, showThumbnail, showIterm2, getImageAscii, prefetchImages, cacheStats };
