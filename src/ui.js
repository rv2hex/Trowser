'use strict';

const blessed = require('blessed');
const anim = require('./anim');
const { getTheme } = require('./themes');
const { detectImageSupport, detectGraphics, bestImageMode, recommendTerminal, showThumbnail, showIterm2, getImageAscii, prefetchImages, clearImages, fetchBytes, pngSize, toDisplayPng } = require('./image');
const { blockMd, inlineMd, boxSections, pairLinks, boxRowOverflow, wrapVis, verifyBoxContainment, visibleCells } = require('./beautify');

// Animated loader art, module-level so it can be exercised without a
// screen (see tests/test-reader.js). NOTE: the braille spinner table was
// retired with the single-animation rule (HANDOVER §6.3) — the wave is the
// only loading animation. The footer status spinner (SPIN_FRAMES, ui
// scope) stays for non-loader statuses only.
// Wave animation, module-level so it can be tested without a screen.
//
// The design is one 20-cell periodic cycle: it rises ▁→▇ (7 cells), holds
// a 3-cell ███ crest, falls ▇→▂ (7 cells, the ▂ doubling), and rests on a
// 3-cell ▁▁▁ trough — the same count of high blocks as low blocks. Frame n
// is a left-rotation by (n % 20), so frame 20 === frame 0 and the loop
// closes exactly. Because the cycle is periodic, tiling it across any width
// is seamless: every tile shares the same phase, so nothing snaps at a seam.
//
// Two things make it read as a wave instead of noise:
//   * every frame is one cell further along than the last (no stutter),
//   * the loop closes exactly (frame 20 hands back to frame 0), so the
//     seam is invisible no matter how many times it repeats.
//
// FRAMES, NOT ALGORITHM (CPU rule): the 20 rotations are computed ONCE at
// module load into WAVE_MOTIF. The 60 ms tick only indexes precomputed
// tables — no rotation or tiling math on the hot path.
const WAVE_CYCLE = '▁▂▃▄▅▆▇███▇▆▅▄▃▂▂▁▁▁'; // exactly 20 cells
function normFrame(i) {
  const n = Math.trunc(Number(i) || 0);
  return ((n % WAVE_MOTIF_LEN) + WAVE_MOTIF_LEN) % WAVE_MOTIF_LEN;
}
// Table-build helper ONLY: rotates the cycle for the one-time module-load
// table and for per-width (re)builds. Never called on the animation tick.
function rotateCycle(n) {
  const cells = [...WAVE_CYCLE];
  const k = ((Math.trunc(Number(n) || 0)) % cells.length + cells.length) % cells.length;
  return cells.slice(k).concat(cells.slice(0, k)).join('');
}
const WAVE_MOTIF_LEN = [...WAVE_CYCLE].length; // 20
const WAVE_MOTIF = Array.from({ length: WAVE_MOTIF_LEN }, (_, n) => rotateCycle(n));
const WAVE_FRAMES = WAVE_MOTIF.length; // 20 frames per loop
const WAVE_MS = 60; // 20 x 60ms = a smooth 1.2s loop

/**
 * One animation frame, tiled edge-to-edge across `width` cells.
 *
 * Pure table lookup: the returned string comes from the precomputed
 * per-width table (built once, cached). No rotation or tiling math runs
 * here — the tick path is one index.
 *
 * The cycle is periodic, so tiling is seamless at any width. No gaps,
 * no spaces: the wave takes all the space given to it. Widths below
 * the 20-cell cycle truncate the rotated frame (never space-padded).
 *
 * @param {number} i      frame index (wraps on its own)
 * @param {number} width  view width in cells (defaults to the cycle)
 */
function waveFrame(i, width) {
  const idx = normFrame(i);
  const w = Number(width) > 0 ? Math.floor(Number(width)) : 0;
  if (!w) return WAVE_MOTIF[idx];
  return waveFrames(w)[idx];
}

// Tile one precomputed rotation to a width. Table-BUILD time only
// (per-width cache misses, theme/resize invalidations) — never on tick.
function tileMotifFrame(idx, w) {
  const cells = [...WAVE_MOTIF[idx]];
  if (w <= 0 || w === cells.length) return WAVE_MOTIF[idx];
  if (w < cells.length) return cells.slice(0, w).join('');
  let out = WAVE_MOTIF[idx];
  while ([...out].length < w) out += WAVE_MOTIF[idx];
  return [...out].slice(0, w).join('');
}

// Frame tables are cached per width: pointless to rebuild 20 frames on
// every tick.
const waveTableCache = new Map();

/**
 * The whole animation as a table of frames, one loop long.
 * @returns {string[]}
 */
function waveFrames(width) {
  const w = Number(width) > 0 ? Math.floor(Number(width)) : 0;
  const key = String(w);
  const hit = waveTableCache.get(key);
  if (hit) return hit;
  const out = [];
  for (let n = 0; n < WAVE_FRAMES; n++) out.push(tileMotifFrame(n, w));
  waveTableCache.set(key, out);
  return out;
}

// Strip the link noise that makes AI answers ugly: markdown links
// `[text](url)` collapse to `text`, bare URLs disappear, and every
// bullet-ish marker (-, *, •) becomes a real •. Pure string work.
function tidyAnswer(text) {
  let out = String(text || '');
  try {
    out = out
      .replace(/\[([^\]\n]{1,120})\]\((https?:[^)\s]+)\)/g, '$1')
      .replace(/\[([^\]\n]{1,120})\]\[[^\]\n]*\]/g, '$1')
      .replace(/(^|[\s(])https?:\/\/\S+/g, '$1')
      .replace(/\r/g, '');
    // Bullet markers → • (only at line start, never inside a sentence).
    out = out.replace(/^(\s*)[-*•]\s+/gm, '$1• ');
    out = out
      .split('\n')
      .map((l) => l.replace(/[ \t]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
  } catch {
    /* best effort */
  }
  return out.trim();
}

// Loader art for frame n: status line + full-width wave. Two lines,
// pure, never throws, no line wider than `width`. The wave line is
// exactly `width` cells of the periodic cycle — edge-to-edge, no spaces —
// so it reads as one travelling shimmer at any bar width. The footer owns
// this art: while it paints, the hint footer stays hidden (one bottom
// slot, never stacked chrome).
function loaderFrame(n, title, stage, width, accent = 'white') {
  const w = Math.max(20, Number(width) || 60);
  const i = Math.max(0, Number(n) || 0);
  const bar = waveFrame(i, w);
  const head = String(title || 'Loading').trim().slice(0, w);
  const step = String(stage || 'working…').trim().slice(0, w);
  // No spinner glyph here: the wave IS the single loading animation.
  return [`{bold}${head}{/} · {${accent}-fg}${step}{/}`, bar].join('\n');
}

// Two-tone wave line: trough cells (▁▂▃▄) in `alt`, crest cells
// (▅▆▇█) in `accent`. Pure: same width contract as waveFrame —
// exactly `width` visible cells. Tagged frame tables per
// (width, accent, alt) are cached so a tick is one lookup.
const waveTaggedCache = new Map();
function waveLineTagged(i, width, accent, alt) {
  const w = Math.max(1, Math.floor(Number(width) || 0));
  const a = String(accent || 'white');
  const b = String(alt || a);
  const key = `${w}|${a}|${b}`;
  let table = waveTaggedCache.get(key);
  if (!table) {
    table = [];
    for (let n = 0; n < WAVE_FRAMES; n++) {
      const cells = [...WAVE_MOTIF[n]];
      const tiled = [];
      for (let x = 0; x < w; x++) tiled.push(cells[x % cells.length]);
      let line = '';
      let run = '';
      let runCrest = null;
      const flush = () => {
        if (run) line += `{${runCrest ? a : b}-fg}${run}{/}`;
        run = '';
      };
      for (const ch of tiled) {
        const crest = '\u2585\u2586\u2587\u2588'.includes(ch);
        if (runCrest === null) runCrest = crest;
        if (crest !== runCrest) flush();
        runCrest = crest;
        run += ch;
      }
      flush();
      table.push(line);
    }
    waveTaggedCache.set(key, table);
  }
  const idx = ((Math.trunc(Number(i) || 0)) % WAVE_FRAMES + WAVE_FRAMES) % WAVE_FRAMES;
  return table[idx];
}

// Music visualizer: equalizer BARS, not a wave — shown in the wave's
// bottom slot while mpv plays (HANDOVER §6.5). FRAMES, NOT ALGORITHM
// (CPU rule): 24 frames of bar heights are baked once per
// (width, accent, alt) into vizTableCache; the ~90 ms tick is one index.
// Deterministic (seeded PRNG, no Math.random): the same frame always
// renders the same bars, so tests are stable and repaints are cheap.
// Heights are temporally smoothed (each frame blends two PRNG draws) so
// columns pulse instead of flickering, and per-column phases differ so
// the result never reads as a travelling ramp like the loader wave.
const VIZ_LEVELS = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];
const VIZ_FRAMES = 24;
const VIZ_MS = 90;
function vizPRNG(seed) {
  let s = (Math.trunc(Number(seed) || 0) >>> 0) || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const vizTableCache = new Map();
// Numeric base table behind both render paths: frames of per-column levels
// 0..7 from the same seeded PRNG draws. Shape is precomputed once per
// width (frames-not-algo); the tick only indexes it. The synthetic path
// renders levels directly, the reactive path scales them through an
// integer gain LUT driven by live loudness energy.
const vizBaseCache = new Map();
function vizBaseTable(width) {
  const w = Math.max(1, Math.floor(Number(width) || 0));
  let table = vizBaseCache.get(w);
  if (!table) {
    table = [];
    for (let n = 0; n < VIZ_FRAMES; n++) {
      const rnd = vizPRNG(0x51ab000 + n * 131);
      const draws = [];
      for (let x = 0; x < w; x++) draws.push(rnd());
      const rndPrev = vizPRNG(0x51ab000 + ((n + VIZ_FRAMES - 1) % VIZ_FRAMES) * 131);
      const prev = [];
      for (let x = 0; x < w; x++) prev.push(rndPrev());
      const levels = [];
      for (let x = 0; x < w; x++) {
        levels.push(Math.min(7, Math.floor(((draws[x] + prev[x]) / 2) * 8)));
      }
      table.push(levels);
    }
    vizBaseCache.set(w, table);
  }
  return table;
}
function renderVizLevels(levels, accent, alt) {
  const a = String(accent || 'white');
  const b = String(alt || a);
  let line = '';
  let run = '';
  let runHigh = null;
  const flush = () => {
    if (run) line += `{${runHigh ? a : b}-fg}${run}{/}`;
    run = '';
  };
  for (let x = 0; x < levels.length; x++) {
    const lvl = levels[x];
    const ch = VIZ_LEVELS[lvl];
    const high = lvl >= 4;
    if (runHigh === null) runHigh = high;
    if (high !== runHigh) flush();
    runHigh = high;
    run += ch;
  }
  flush();
  return line;
}
// Reactive spectrum render: real per-band 0..1 levels (low → high
// frequency) resampled to the line width by bucket-averaging, then mapped
// to block heights through the shared tag renderer. Deterministic per
// input — same bands always paint the same bars.
function renderVizBands(bands, width, accent, alt) {
  const w = Math.max(1, Math.floor(Number(width) || 0));
  const n = Array.isArray(bands) ? bands.length : 0;
  if (!n) return renderVizLevels(new Array(w).fill(0), accent, alt);
  const levels = [];
  for (let x = 0; x < w; x++) {
    const lo = Math.floor((x * n) / w);
    const hi = Math.max(lo + 1, Math.floor(((x + 1) * n) / w));
    let sum = 0;
    for (let k = lo; k < hi && k < n; k++) {
      const v = Number(bands[k]);
      sum += Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    }
    levels.push(Math.max(0, Math.min(7, Math.round((sum / (hi - lo)) * 7))));
  }
  return renderVizLevels(levels, accent, alt);
}
const VIZ_GAIN_STEPS = 8;
// Live loudness 0..1 → integer gain step 0..7 (quantized so the tick path
// stays table lookups: one LUT index per column, no float math per tick).
function vizEnergyToStep(e) {
  try {
    const v = Number(e);
    if (!Number.isFinite(v) || v <= 0) return 0;
    if (v >= 1) return VIZ_GAIN_STEPS - 1;
    return Math.round(v * (VIZ_GAIN_STEPS - 1));
  } catch {
    return 0;
  }
}
// Gain LUT: silence keeps 25% of the shape (bars still breathe so the slot
// never looks dead); full energy renders the base shape untouched.
function vizGainLevel(base, step) {
  const b = Math.max(0, Math.min(7, Math.trunc(Number(base) || 0)));
  const s = Math.max(0, Math.min(VIZ_GAIN_STEPS - 1, Math.trunc(Number(step) || 0)));
  return Math.max(0, Math.min(7, Math.round(b * (0.25 + (0.75 * s) / (VIZ_GAIN_STEPS - 1)))));
}
// Reactive render: same precomputed shape as vizLineTagged, heights scaled
// by live energy. Deterministic per (frame, width, step): no RNG on tick.
function vizEnergyLine(i, width, accent, alt, energy) {
  const w = Math.max(1, Math.floor(Number(width) || 0));
  const table = vizBaseTable(w);
  const idx = ((Math.trunc(Number(i) || 0)) % VIZ_FRAMES + VIZ_FRAMES) % VIZ_FRAMES;
  const step = vizEnergyToStep(energy);
  return renderVizLevels(table[idx].map((lvl) => vizGainLevel(lvl, step)), accent, alt);
}
function vizLineTagged(i, width, accent, alt) {
  const w = Math.max(1, Math.floor(Number(width) || 0));
  const a = String(accent || 'white');
  const b = String(alt || a);
  const key = `${w}|${a}|${b}`;
  let table = vizTableCache.get(key);
  if (!table) {
    table = [];
    const base = vizBaseTable(w);
    for (let n = 0; n < VIZ_FRAMES; n++) table.push(renderVizLevels(base[n], a, b));
    vizTableCache.set(key, table);
  }
  const idx = ((Math.trunc(Number(i) || 0)) % VIZ_FRAMES + VIZ_FRAMES) % VIZ_FRAMES;
  return table[idx];
}

// Single-box browser chrome: one rounded frame holding an account header,
// two separators, an always-typable omnibox with a Search button, and a
// body area. No popups, no hint bars. Keys: arrows/Enter/Space/Esc/q/F2.
const ACCOUNT = 'TrowserBrowser@User.com'; // placeholder until login wiring
// Header identity pill: keeps the name/email clear of the right border with
// a couple of inset spaces and a leading separator (reads as "— gmail ─╮"
// instead of text glued to the corner).
function identityLabel(name, email) {
  const n = String(name || '').trim().slice(0, 40);
  const e = String(email || '').trim().slice(0, 60);
  const who = n || e ? `${n}${n && e ? ' ' : ''}${e ? `<${e}>` : ''}` : ACCOUNT;
  return `  · ${who}  `;
}

// All boxes go through here so blessed invariants hold in one place:
// - `ch` is always a real 1-char string (never undefined -> null cell -> draw crash)
// - `content` is always a string
// - only the real `tags` flag is forwarded (blessed has no `tag` option)
function makeBox(opts) {
  const { padding, ...rest } = opts;
  return blessed.box({
    align: 'left',
    valign: 'top',
    ch: ' ',
    tags: false,
    padding: padding || 0,
    ...rest,
    ch: rest.ch || ' ',
    content: typeof rest.content === 'string' ? rest.content : String(rest.content ?? ''),
  });
}

function sanitizeLine(s) {
  return String(s ?? '').replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '');
}

// Escape blessed tag braces in untrusted text. MUST wrap every dynamic
// string painted into a tags:true widget, or `{red}` in page content would
// parse as markup (and stray `{` can corrupt the render buffer).
function escTags(s) {
  // Single pass: chained replaces would escape their own insertions.
  return String(s ?? '').replace(/[{}]/g, (m) => (m === '{' ? '{open}' : '{close}'));
}

// Pure hex -> {r,g,b} for the truecolor patch below. Returns null for
// anything that is not a 3- or 6-digit hex.
function hexToRgbTriplet(h) {
  try {
    const s = String(h || '').trim().replace(/^#/, '');
    const full = /^[0-9a-f]{3}$/i.test(s)
      ? s.split('').map((c) => c + c).join('')
      : /^[0-9a-f]{6}$/i.test(s) ? s : null;
    if (!full) return null;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  } catch {
    return null;
  }
}

// Whether this process runs on a truecolor terminal. Conservative gate:
// only when COLORTERM explicitly advertises it.
function hasTruecolor() {
  try {
    return /truecolor|24bit/i.test(String(process.env.COLORTERM || ''));
  } catch {
    return false;
  }
}

// Wrap screen.program._attr so `#rrggbb fg|bg` emits 38;2/48;2 SGR on
// truecolor terminals instead of being quantized to xterm-256. Runtime
// monkey-patch (not a node_modules edit) so reinstalls can't lose it.
// Idempotent per program; returns true when the patch is active.
function enableTruecolor(screen) {
  try {
    const prog = screen && screen.program;
    if (!prog || typeof prog._attr !== 'function' || prog._truecolorPatched) {
      return !!(prog && prog._truecolorPatched);
    }
    if (!hasTruecolor()) return false;
    const orig = prog._attr;
    prog._attr = function (param, val) {
      try {
        if (typeof param === 'string' && val !== false) {
          const m = /^(#[0-9a-f]{3,6})\s+(fg|bg)$/i.exec(param.trim());
          if (m) {
            const rgb = hexToRgbTriplet(m[1]);
            if (rgb) return `\x1b[${m[2].toLowerCase() === 'bg' ? 48 : 38};2;${rgb.r};${rgb.g};${rgb.b}m`;
          }
        }
      } catch { /* fall through to stock path */ }
      return orig.call(this, param, val);
    };
    prog._truecolorPatched = true;
    return true;
  } catch {
    return false;
  }
}

// Pure picker grid: names + live width -> row descriptors. Module-level
// so narrow-terminal layout is unit-testable without a screen. Each cell
// is 28 visible cells (22 name + 1 space + 5 swatch `██ ██`); under 62
// cells wide the grid collapses to one column so rows never wrap.
function themeGrid(names, W, currentName, alt) {
  const { isHighlightedTheme, isTransparentTheme, getTheme } = require('./themes');
  const list = Array.isArray(names) ? names : [];
  const CELL = 28;
  const swatch = (name) => {
    try {
      const pal = getTheme(name);
      const a = String(pal.accent || '#ffffff');
      const b = String(pal.alt || a);
      return `{#${a}-fg}██{/} {#${b}-fg}██{/}`;
    } catch {
      return '██ ██';
    }
  };
  const cellFor = (name) => {
    if (!name) return ' '.repeat(CELL);
    const star = isHighlightedTheme(name) ? '*' : ' ';
    const dot = isTransparentTheme(name) ? 'o' : ' ';
    const label = `${star}${dot} ${name}`.slice(0, 22).padEnd(22);
    const cell = `${label} ${swatch(name)}`;
    return name === currentName ? `{${alt}-fg}{inverse} ${cell} {/}` : cell;
  };
  const rows = [];
  if (Math.max(30, Number(W) || 30) < 62) {
    list.forEach((name, i) => rows.push({ label: cellFor(name), index: i, rightIndex: -1 }));
  } else {
    const half = Math.ceil(list.length / 2);
    const left = list.slice(0, half);
    const right = list.slice(half);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      rows.push({ label: cellFor(left[i]) + cellFor(right[i]), index: left[i] ? list.indexOf(left[i]) : -1, rightIndex: right[i] ? list.indexOf(right[i]) : -1 });
    }
  }
  return rows;
}
// Truncate to `w` TERMINAL CELLS (wide CJK/emoji count 2), keeping
// blessed tags intact. Module-level so tests can pin the width contract
// directly; the UI closure uses this same function everywhere.
function truncateVisual(s, w) {
  try {
    const { visibleCells: vc, fitVis: fv } = require('./beautify');
    const str = String(s ?? '');
    if (vc(str) <= w) return str;
    return `${fv(str, Math.max(0, w - 1))}…`;
  } catch {
    return String(s ?? '');
  }
}

// Center one already-tagged line inside `width` terminal cells. Tags
// don't count toward the padding (except {open}/{close} = 1 cell each),
// wide chars count 2. Lines wider than `width` are truncated first so a
// centered rule can never cross the box border (BUG-2 H4). Module-level
// for the same reason as truncateVisual.
function centerTagged(ln, width) {
  try {
    const { visibleCells: vc, fitVis: fv } = require('./beautify');
    const w = Math.max(10, Number(width) || 10);
    const s = String(ln ?? '');
    const fit = vc(s) > w ? fv(s, w) : s;
    const vis = vc(fit);
    return `${' '.repeat(Math.max(0, Math.floor((w - vis) / 2)))}${fit}`;
  } catch {
    return String(ln ?? '');
  }
}

// Rounded (btop-style) corners, owned end-to-end (see repaintChrome):
// the frame has NO blessed border; all four edges + corners are content
// we paint ourselves, so every edge cell is asserted in tests. Corner
// glyphs are single-width, safe with `fullUnicode:false`, and need a
// terminal font with U+256D coverage (e.g. a Nerd Font) to look right.
const CORNER_TL = '╭';
const CORNER_TR = '╮';
const CORNER_BL = '╰';
const CORNER_BR = '╯';
const EDGE_H = '─';
const EDGE_V = '│';

// Pure click mapping, unit-tested: body-RELATIVE y (callers subtract
// body.lpos.yi from blessed's absolute coords) + scroll offset + header
// lines -> 0-based row index into the window.
function rowIndexFromY(y, scrollOffset, headerLines) {
  return y - headerLines + scrollOffset;
}

const TOP_SEP = '─';
const BOT_SEP = '─';

function createUI(screen, handlers, opts) {
  const {
    onOmniSubmit,
    onSuggest,
    onLinkPick,
    onPlayVideo,
    onPlayQueue,
    onQualityCycle,
    onHistoryBack,
    onHistoryForward,
    onEscape,
    onQuit,
    onThemeChange,
  } = handlers;
  const options = opts || {};

  let theme = getTheme(options.theme);
  let pageSize = options.pageSize || 50;
  // Truecolor passthrough (BUG-1 R1): blessed 0.1.81 quantizes every hex
  // to xterm-256 (near-black theme backgrounds all land in the same few
  // cells, so themes look identical). When the terminal advertises
  // truecolor (COLORTERM=truecolor/24bit), #rrggbb fg/bg params bypass
  // colors.match and emit 38;2/48;2 directly. One patch point covers
  // both style.* colors (via fg()/bg()) and {#hex-fg} content tags —
  // both funnel through program._attr. Anything else (or any failure)
  // falls back to blessed's stock 256-color path, never malformed SGR.
  const truecolorOn = enableTruecolor(screen);
  // Reader-mode article header (title / byline / site / reading time) and
  // hero art URL, set by setCenterContent for the current page only.
  let lastReader = null;
  let lastHero = '';
  // Per-page blocked-request count for the footer badge (fonts, media,
  // trackers refused by the browser).
  let blockedPage = 0;
  let blockedTotal = 0;
  let shieldGlow = null; // glow timer while the tracker badge is "working"
  // Reader mode is the default; /read raw flips it for the current page.
  let readMode = 'reader';
  // /themes picker: the highlighted theme is applied LIVE (no Enter), and
  // `saved` remembers the view underneath so Esc/close restores it.
  const themeState = { open: false, cursor: 0, saved: null };
  // False while the search fan-out still has more to fetch (keeps the
  // "… load more" tail honest until the budget runs out).
  let fillDone = true;
  // True when the background fan-out died (network/bot-wall): the tail
  // row says so instead of the list silently sticking at 10 links.
  // Cleared by every new search (showLinkPicker).
  let fillStalled = false;

  // Logical focus. The omnibox keeps DOM focus throughout, so typing works
  // everywhere with zero focus juggling.
  let focused = 'input'; // 'input' | 'links' | 'content' | 'form'
  // Home-only footer (P1): the hint row exists on the home view; everywhere
  // else the bottom belongs to content/loader/visualizer. Toasts and
  // statuses reveal it transiently (then updateHint re-hides it).
  let homeView = true;
  // Home search scope (the sticky picker): '' = whole web, else a scopes.js
  // key ('wiki'|'gh'|'so'|'hn'). Persists across visits — the user picks it
  // once and every dashboard search honours it until changed (←/→) or a
  // typed bang overrides it.
  let homeScope = '';
  // ★ footer marker: true while the current page is in the bookmark store.
  let bookmarkedPage = false;
  // /settings panel state (declared here so setFocus can clear it safely:
  // a focus change away from settings must never leave a ghost panel that
  // swallows keys).
  let settingsState = null;
  let suggestRows = [];
  let listLinks = [];
  let listCursor = 0;
  let listStart = 0;
  let lastText = '';
  // Now-playing row text (footer, above the hint row). Empty = hidden.
  let npText = '';
  let lastSpans = null;
  let lastLinks = [];
  // Pretty article source (cli-html text) for the boxed view. Kept alongside
  // lastText so Esc/restore/resize can repaint boxes re-measured to the
  // live webview width instead of dropping back to plain text.
  let lastPretty = null;
  // Page gallery (reader-style: images travel with the article).
  // lastMedia = { images: [{ src, alt }], videos: [{ src, poster, title }] }.
  let lastMedia = { images: [], videos: [] };
  let lastAi = '';
  // Model that produced lastAi (an OpenRouter id like '…:free'), shown as
  // "AI answer — by <label>" in the box title. Empty for hints/errors.
  let lastAiModel = '';
  let lastSummary = '';
  let summaryVisible = false;
  // Fullscreen AI view (Alt+Up on a search list): the digest takes the
  // whole body until Esc / Alt+Down / Alt+Up collapses it back to the bar.
  let aiExpanded = false;
  // Stale-guard for the async REAL-AI fullscreen (Alt+Up on an article):
  // a reply that lands after collapse / a new open is dropped.
  let aiFullToken = 0;
  let mediaCursor = -1;
  // Media-split state: the right 60/40 pane shows THIS page's media — images
  // AND videos in one combined list (images first, then videos). `mediaKind`
  // is what the pane is currently showing.
  let mediaKind = 'image';
  function mediaList() {
    try {
      const m = lastMedia || {};
      const out = [];
      (Array.isArray(m.images) ? m.images : []).forEach((im) => {
        if (im && im.src) out.push({ kind: 'image', src: im.src, alt: String(im.alt || '').slice(0, 120) });
      });
      (Array.isArray(m.videos) ? m.videos : []).forEach((v) => {
        if (v && v.src) out.push({ kind: 'video', src: v.src, poster: v.poster || null, title: String(v.title || '').slice(0, 120) });
      });
      return out;
    } catch { return []; }
  }
  let suggestTimer = null;
  let suggestSeq = 0;
  // Query that produced `suggestRows`. Kept next to the rows so a rendered
  // row can show WHY it matched (Google underlines the matched substring).
  let suggestQuery = '';
  // YouTube fast-list mode (/yt): title-only rows with bound thumbnails.
  // Enter always plays in mpv, never navigates to watch-page text.
  let ytMode = false;
  let ytQuery = '';
  // Single-flight for Enter confirms (see confirmLinkList).
  let lastConfirm = { url: '', at: 0 };
  // Form mode state (for login wizard)
  let formState = { step: null, email: '', password: '', callback: null };

  // Command-mode snapshot: typing `/` from a page paints suggestions into
  // the body, which would destroy the view. Snapshot it on entry so Esc
  // (or an empty cancel) restores the exact page; submitting clears it
  // because the command owns the screen from there.
  let cmdSnapshot = null;
  // Focus the submitted slash command was typed over ('links' | 'content'
  // | null). submitOmni captures cmdSnapshot.focused before dropping the
  // snapshot and clears this right after onOmniSubmit returns: slash
  // handlers run synchronously, so focus-gated helpers (showAiSummary,
  // playHighlightedVideo, linkAt) see the view underneath instead of the
  // transient 'input' focus of the command bar. Keyboard flows never set
  // it, so they behave exactly as before.
  let submitFocus = null;

  // Effective focus for slash-command handlers: the view a typed command
  // was submitted over, falling back to live focus everywhere else.
  function effFocus() {
    if ((focused === 'input' || focused === 'form') && (submitFocus === 'links' || submitFocus === 'content')) {
      return submitFocus;
    }
    return focused;
  }

  function snapshotCommandView() {
    if (focused === 'input' || cmdSnapshot) return;
    try {
      const content = typeof body.getContent === 'function' ? body.getContent() : body.content || '';
      let scroll = 0;
      try {
        const h = body.height || 10;
        scroll = body.getScrollHeight() > h ? Math.max(0, body.childBase || 0) : 0;
      } catch { /* top */ }
      cmdSnapshot = {
        focused, content: String(content),
        cursor: listCursor, start: listStart, scroll,
        aiExpanded, summaryVisible,
      };
    } catch { cmdSnapshot = null; }
  }

  function restoreCommandView() {
    const s = cmdSnapshot;
    cmdSnapshot = null;
    if (!s) return false;
    try {
      aiExpanded = !!s.aiExpanded;
      summaryVisible = !!s.summaryVisible;
      setFocus(s.focused === 'input' ? 'content' : s.focused);
      listCursor = s.cursor || 0;
      listStart = s.start || 0;
      body.setContent(s.content || '');
      scrollBodyTo(s.scroll || 0);
      return true;
    } catch {
      try { showText(); } catch { /* never throw */ }
      return true;
    }
  }

  // Content-view snapshot for OVERLAY views (the /bookmarks + /history
  // pickers, the gallery/videos panes, the theater rail). Stores the exact
  // rendered body plus the list state, so Esc from an overlay returns to the
  // page pixel-for-pixel — the bug where running a list command "made the
  // webpage disappear". Distinct from cmdSnapshot: a command SUBMIT consumes
  // that one, so it cannot serve the post-command return.
  let contentSnapshot = null;
  // Bumped on every real page paint (setCenterContent): lets submitOmni tell
  // "the command navigated" from "the command only painted an overlay", so a
  // gallery open underneath survives /download, /bookmark, /copy, /pets, …
  let pageSeq = 0;
  // Snapshot of any open 60/40 media split (gallery or theater) taken when a
  // command-driven view opens over it. Restored afterwards if the command did
  // not paint a new page — otherwise typing /download made the image vanish.
  let mediaSnapshot = null;
  function snapshotMediaSplit() {
    if (mediaSnapshot) return; // keep the outermost
    mediaSnapshot = {
      galleryOpen,
      mediaCursor,
      galleryReturn,
      theaterOpen,
      theaterCursor,
      theaterList: theaterOpen ? theaterList.slice() : null,
    };
  }
  function restoreMediaSplit() {
    const s = mediaSnapshot;
    mediaSnapshot = null;
    if (!s) return false;
    try {
      if (s.theaterOpen && Array.isArray(s.theaterList)) {
        openTheater(s.theaterList);
        return true;
      }
      if (s.galleryOpen) {
        openGallery(s.mediaCursor);
        return true;
      }
    } catch { return false; }
    return false;
  }
  function snapshotContentView() {
    if (contentSnapshot) return; // keep the outermost view
    try {
      // A command runs while the logical focus is still 'input' (the bar),
      // with the suggestion rows painted into the body. The view to save is
      // the one UNDERNEATH (effFocus), so re-render the page first and store
      // that focus — otherwise Esc would "restore" the suggestion rows.
      const fv = effFocus();
      if (fv === 'content' && (focused === 'input' || focused === 'form')) {
        try { showText(); } catch { /* best effort */ }
      }
      const content = typeof body.getContent === 'function' ? body.getContent() : body.content || '';
      let scroll = 0;
      try {
        const h = body.height || 10;
        scroll = body.getScrollHeight() > h ? Math.max(0, body.childBase || 0) : 0;
      } catch { /* top */ }
      contentSnapshot = {
        focused: fv === 'input' || fv === 'form' ? 'content' : fv,
        content: String(content),
        cursor: listCursor,
        start: listStart,
        scroll,
        links: fv === 'links' ? listLinks.slice() : null,
        heading: listHeading,
      };
    } catch { contentSnapshot = null; }
  }
  function clearContentView() { contentSnapshot = null; }
  function clearMediaSplit() { mediaSnapshot = null; }
  function restoreContentView() {
    const s = contentSnapshot;
    contentSnapshot = null;
    if (!s) return false;
    try {
      if (s.focused === 'links' && Array.isArray(s.links)) {
        listLinks = s.links;
        lastLinks = s.links;
        listHeading = s.heading || '';
        listCursor = s.cursor || 0;
        listStart = s.start || 0;
        setFocus('links');
        paintList(true);
        return true;
      }
      listHeading = s.heading || '';
      setFocus(s.focused === 'input' || s.focused === 'form' || s.focused === 'themes' ? 'content' : s.focused);
      body.setContent(s.content || '');
      scrollBodyTo(s.scroll || 0);
      screen.render();
      return true;
    } catch {
      try { showText(); } catch { /* never throw */ }
      return true;
    }
  }
  // Content view: track which lines are links for click navigation
  let contentLinkLines = [];

  function themedBg() {
    return theme.bg ? { bg: theme.bg } : {};
  }

  // ── The one frame (borderless — edges are owned content, see below) ──
  const frame = makeBox({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    content: '',
  });

  // Owned border: 4 edge boxes + corner glyphs baked into the top/bottom
  // strings. No blessed border, no overlay timing — repaintChrome() owns
  // every edge cell and tests assert them all.
  const edgeTop = makeBox({
    parent: frame,
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: '',
    style: { fg: theme.border, ...themedBg() },
  });
  const edgeBottom = makeBox({
    parent: frame,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: '',
    style: { fg: theme.border, ...themedBg() },
  });
  const edgeLeft = makeBox({
    parent: frame,
    top: 1,
    left: 0,
    width: 1,
    height: '100%-2',
    content: '',
    style: { fg: theme.border, ...themedBg() },
  });
  const edgeRight = makeBox({
    parent: frame,
    top: 1,
    right: 0,
    width: 1,
    height: '100%-2',
    content: '',
    style: { fg: theme.border, ...themedBg() },
  });

  // Inner container: everything else lives strictly inside the ring, so no
  // widget can ever paint over an edge cell.
  const inner = makeBox({
    parent: frame,
    top: 1,
    left: 1,
    width: '100%-2',
    height: '100%-2',
    content: '',
  });

  const header = makeBox({
    parent: inner,
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    align: 'right',
    content: identityLabel(),
    style: { fg: theme.muted, ...themedBg() },
  });

  const sep1 = makeBox({
    parent: inner,
    top: 1,
    left: 0,
    width: '100%',
    height: 1,
    content: '',
    style: { fg: theme.muted, ...themedBg() },
  });

  const omni = blessed.textbox({
    parent: inner,
    top: 2,
    left: 1,
    width: '100%-14',
    height: 1,
    keyable: false,
    style: {
      fg: theme.fg,
      ...themedBg(),
    },
  });

  const searchBtn = makeBox({
    parent: inner,
    top: 2,
    left: '100%-12',
    width: 11,
    height: 1,
    content: '[ Search ]',
    tags: false,
    mouse: true,
    // No autofocus: blessed bubbles 'element click' up to screen, which
    // would steal DOM focus, blur the omnibox, and fire a phantom cancel
    // that clobbers the current view. We focusField() explicitly instead.
    autoFocus: false,
    style: { fg: theme.accent, bold: true, ...themedBg() },
  });
  searchBtn.on('click', () => {
    focusField();
    submitOmni(true);
  });

  // Command-line rule: same light glyph as sep1, but the theme's border
  // color so it matches the frame instead of reading as bold content.
  const sep2 = makeBox({
    parent: inner,
    top: 3,
    left: 0,
    width: '100%',
    height: 1,
    content: '',
    style: { fg: theme.border, ...themedBg() },
  });

  const body = makeBox({
    parent: inner,
    top: 4,
    left: 0,
    width: '100%',
    bottom: 0,
    content: '',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    autoFocus: false,
    style: { fg: theme.fg, ...themedBg() },
  });

  // Fixed AI bar: the REAL LLM answer, pinned above the bottom edge on
  // search result lists (the body shortens while it shows). Title row +
  // up to AI_ANSWER_LINES answer lines + border + the Alt+Up hint row.
  const AI_ANSWER_LINES = 5;
  const AI_BAR_H = AI_ANSWER_LINES + 3; // 8
  const aiBar = makeBox({
    parent: inner,
    bottom: 1,
    left: 0,
    width: '100%',
    height: AI_BAR_H,
    content: '',
    tags: true,
    hidden: true,
    style: { fg: theme.fg, ...themedBg() },
  });

  // Footer slot: the loader and the visualizer live IN the footer —
  // one bottom slot, one occupant. Loading takes two rows (status line
  // with title · stage · Ns, then the full-width two-tone wave); the
  // visualizer takes one (bars only). The hint footer shows only when
  // neither is active. The page above never moves.
  const LOAD_H = 2; // loader: status + wave
  const VIZ_H = 1; // visualizer: bars only
  const loadBar = makeBox({
    parent: inner,
    bottom: 0,
    left: 0,
    width: '100%',
    height: LOAD_H,
    content: '',
    tags: true,
    hidden: true,
    style: { fg: theme.fg, ...themedBg() },
  });

  // Image pane: right-side 40% gallery view, shown ONLY while browsing
  // images (Tab / gallery Enter / /img). The webview keeps the left 60%.
  // Images render centered in the pane at full pane width, aspect kept.
  const imgPane = makeBox({
    parent: inner,
    top: 4,
    left: '60%',
    width: '40%',
    bottom: 1,
    content: '',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    autoFocus: false,
    hidden: true,
    style: { fg: theme.accent, ...themedBg() },
  });
  // Clicking the pane steps to the next image (same as Tab).
  imgPane.on('click', () => {
    focusField();
    if (galleryOpen) galleryStep(1);
  });

  // Gallery-view state. galleryReq is a freshness guard: rapid Tabbing
  // fires overlapping fetches, and only the latest may paint (same idea
  // as navSeq in index.js). galleryReturn restores list vs article view.
  let galleryOpen = false;
  let galleryReturn = 'content';
  let galleryReq = 0;
  // True while THIS gallery fetch owns the wave loader (P3). Newest
  // request wins via galleryReq — same ownership rule as the old spinner.
  let galleryLoading = false;
  // Pane-image rotation (ctrl+r). Keyed to the current src so stepping to
  // another photo starts upright, while a repaint of the same photo keeps it.
  let galleryRotate = 0;
  let galleryRotateSrc = '';

  // One-line context hint footer: always shows what Enter/Tab///ai do
  // RIGHT NOW, so keys never need memorising. Owned chrome — the body
  // always reserves this row via layoutBody().
  const hintBar = makeBox({
    parent: inner,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: '',
    tags: false,
    style: { fg: theme.muted, ...themedBg() },
  });

  // Tracker-shield badge (bottom-right, always visible). Created AFTER
  // hintBar so it paints on top of the hint row's right edge. Never steals
  // clicks (mouse off) and never hides.
  const shieldBar = makeBox({
    parent: inner,
    bottom: 0,
    right: 1,
    width: 12,
    height: 1,
    content: '',
    tags: true,
    style: { fg: theme.muted, ...themedBg() },
  });

  // Clock badge (bottom-right, left of the tracker shield): the always-on
  // "time" widget. One unref'd 30 s timer refreshes it, and the dashboard
  // heading gets the same stamp while the dashboard is on screen. render()
  // diffs cells, so an idle app pays nothing visible.
  const clockBar = makeBox({
    parent: inner,
    bottom: 0,
    right: 13,
    width: 6,
    height: 1,
    content: formatClock(),
    tags: false,
    style: { fg: theme.muted, ...themedBg() },
  });

  let clockTimer = null;
  function refreshClock() {
    try {
      const t = formatClock();
      if (clockBar.getContent() !== t) clockBar.setContent(t);
      if (homeView && listHeading) {
        listHeading = homeHeading();
        paintList(true);
      }
      screen.render();
    } catch { /* the clock is best-effort */ }
  }
  function startClock() {
    if (clockTimer) return clockTimer;
    clockTimer = setInterval(() => {
      try {
        if (screen.destroyed) {
          clearInterval(clockTimer);
          clockTimer = null;
          return;
        }
        refreshClock();
      } catch { /* tick is best-effort */ }
    }, 30000);
    if (clockTimer && typeof clockTimer.unref === 'function') clockTimer.unref();
    refreshClock();
    return clockTimer;
  }

  // Now-playing row: mpv truth (title · position · quality) mirrored from
  // the running player by one 1.5 s poll in index.js. Hidden unless there
  // is a player, so an idle app pays zero rows and zero paint; the row
  // docks above whatever the footer slot shows (see layoutBody).
  const npBar = makeBox({
    parent: inner,
    bottom: 1,
    left: 0,
    width: '100%',
    height: 1,
    content: '',
    tags: false,
    style: { fg: theme.muted, ...themedBg() },
  });
  npBar.hidden = true;

  // Plain text only (no blessed tags): '♪ 1:22 / 3:40 · Title · 720p'.
  // Empty clears and hides the row; the dock re-computes on every change.
  function setNowPlaying(text) {
    try {
      const t = String(text || '').trim();
      npText = t;
      // No manual truncation: the row is width:100% and blessed clips at
      // paint time, so no width source is trusted here (test harnesses and
      // headless screens report bogus widths).
      npBar.setContent(t ? ` ${t}` : '');
      npBar.hidden = !t;
      layoutBody();
      screen.render();
      return true;
    } catch {
      return false;
    }
  }

  // Command palette overlay: sectioned command rows + a disconnect rule
  // for `/` typed while browsing (the page stays mounted underneath —
  // typing `/` never destroys the view). The window is capped so the
  // catalog never floods the screen; arrows walk it. Idle boots with no
  // view keep the legacy body list instead (see paintSuggest). Never
  // steals clicks or DOM focus (mouse off).
  const cmdBar = makeBox({
    parent: inner,
    top: 4,
    left: 0,
    width: '100%',
    height: 4,
    content: '',
    tags: true,
    mouse: false,
    autoFocus: false,
    hidden: true,
    style: { fg: theme.fg, ...themedBg() },
  });

  // Slash-bar mode: the omnibox holds `/…`, so suggestions are command
  // rows for the overlay instead of web rows for the body.
  function isCommandMode() {
    try {
      return focused === 'input' && /^\s*\//.test(omni.getValue());
    } catch {
      return false;
    }
  }

  // Painted palette lines for a row set: section headers are inserted at
  // paint time (suggestRows stays pure, so cursor math, Enter and
  // submitFocus keep indexing plain rows). Returns a window that always
  // contains the cursor and never exceeds maxLines.
  function paletteLines(rows, maxLines) {
    const out = [];
    const headerAt = new Set();
    const lineOfRow = new Map();
    let last = '';
    for (let i = 0; i < rows.length; i++) {
      const sec = String((rows[i] && rows[i].section) || '');
      if (sec && sec !== last) {
        headerAt.add(out.length);
        // Underline rides the muted colour so a header stays a header even
        // in the white theme, where muted == fg and colour alone said
        // nothing (the '· ' prefix was doing all the work).
        out.push(`  {${theme.muted}-fg}{underline}· ${escTags(sec.toLowerCase())}{/}`);
        last = sec;
      }
      lineOfRow.set(i, out.length);
      out.push(rowLine(rows[i], i === listCursor, { highlight: true }));
    }
    const cap = Math.max(1, Math.floor(maxLines) || 1);
    const ci = lineOfRow.has(listCursor) ? lineOfRow.get(listCursor) : 0;
    let start = ci >= cap ? ci - cap + 1 : 0;
    // Never open the window on a row whose section header is one line up.
    if (start > 0 && headerAt.has(start - 1)) start -= 1;
    return { lines: out.slice(start, start + cap), cursorLine: ci - start, total: out.length };
  }

  function paintCommandPalette() {
    try {
      const rows = Array.isArray(suggestRows) ? suggestRows : [];
      clampCursor(rows);
      // Short window: the palette organizes, it must not fill the screen.
      const maxLines = Math.max(4, Math.min(10, (screen.height || 24) - 10));
      const { lines } = paletteLines(rows, maxLines);
      // Disconnect rule: marks where the palette ends and the untouched
      // page underneath begins. Never selectable (cursor math ignores it).
      const rule = '─'.repeat(Math.max(10, rowWidth()));
      cmdBar.setContent((lines.join('\n') + (lines.length ? '\n' : '') + rule).slice(0, 2000) || '(no commands)');
      cmdBar.height = Math.max(2, lines.length + 1);
      cmdBar.hidden = false;
    } catch { /* palette is best-effort */ }
  }

  function hideCommandPalette() {
    try {
      cmdBar.hidden = true;
    } catch { /* best effort */ }
  }

  function updateHint() {
    // Single owner for the footer; called from setFocus (the single owner
    // for focus transitions). Plain text only — never throws, never renders
    // (the next paint shows it). Yields to a live status (spinner owns row).
    try {
      if (typeof statusTimer !== 'undefined' && statusTimer) return;
      try { if (typeof toastTimer !== 'undefined' && toastTimer) return; } catch { /* no toast yet */ }
      // Footer-content rule: hints show ONLY when the footer slot is idle.
      // Off-home the row stays hidden (P1); while the loader or visualizer
      // owns the slot, hints wait — one bottom slot, never stacked chrome.
      if (!homeView || loader.active || viz.active) {
        try { hintBar.hidden = true; hintBar.setContent(''); } catch { /* best effort */ }
        return;
      }
      try { hintBar.hidden = false; } catch { /* best effort */ }
      const w = Math.max(10, (screen.width || 80) - 4);
      let h;
      if (theaterOpen) h = 'up/down pick related · enter play in mpv · esc close';
      else if (galleryOpen) h = 'tab/S-tab next image · ctrl+f zoom · esc close gallery';
      else if (focused === 'gallerygrid') h = 'arrows move · enter open · ctrl+f fullscreen · esc close';
      else if (aiExpanded) h = 'esc collapse · up/down/pgup/pgdn scroll · /help works';
      else if (focused === 'input') h = '/help · type to search · down search · tab complete · enter open · ctrl+q quit';
      else if (focused === 'links' && ytMode) h = 'up/down pick video · enter fullscreen in mpv · tab thumb · esc page · /yt new search';
      else if (focused === 'links' && homeView) h = '←/→ pick search scope · type a query · enter searches it · >wiki einstein too · enter opens';
      else if (focused === 'links') h = 'enter open/play · tab thumb · alt+up full answer · /ai ask · alt+left/right history';
      else if (focused === 'themes') h = 'up/down change the theme live · esc done';
      else if (focused === 'content') h = 'enter links · tab gallery · alt+up summary · /ai ask · /find';
      else h = '/help for commands';
      // Reading position, only once the user has actually scrolled a page.
      if (focused === 'content' && !aiExpanded) {
        const pos = scrollPosition();
        if (pos && pos.percent > 0) h += ` · ${pos.percent}%`;
      }
      // ★ while the current page is bookmarked (so the save is not forgotten).
      // The tracker count lives in the always-on shield badge, not here.
      hintBar.setContent(composeFooter(`${bookmarkedPage ? '★ ' : ''}${h}`, '', w));
    } catch { /* footer is best-effort */ }
  }

  // Left hint, right badge, single row, single space between when narrow.
  // Pure string work (no blessed) so it can be reasoned about (and tested).
  function composeFooter(left, badge, width) {
    const w = Math.max(10, Number(width) || 10);
    const l = truncateVisual(String(left || ''), w);
    const b = String(badge || '');
    if (!b) return l;
    const bl = [...b].length;
    if (bl >= w - 1) return truncateVisual(b, w);
    const room = w - [...l].length - bl;
    if (room < 2) return truncateVisual(`${l} ${b}`, w);
    return `${l}${' '.repeat(room)}${b}`;
  }

  // Where the user is in the article: { top, total, percent } or null when
  // nothing is scrollable (lists, info views).
  // Scroll + repaint + refresh the reading position in the footer. Single
// owner so every paging key updates the "42%" indicator identically.
function scrollMoved() {
  try {
    updateHint();
  } catch { /* hint is best-effort */ }
  screen.render();
}

function scrollPosition() {
    try {
      const h = Math.max(1, body.height || 1);
      const total = body.getScrollHeight();
      if (total <= h + 1) return null;
      const top = Math.max(0, body.childBase || 0);
      const percent = Math.min(100, Math.round((top / Math.max(1, total - h)) * 100));
      return { top, total, percent };
    } catch {
      return null;
    }
  }


  // ---- live status: one-line infinite spinner, real action text ----
  // Footer-owned: setStatus(text) starts the braille spinner ticking in the
  // hint row; clearStatus() stops it and restores the contextual hint.
  // flashStatus(text) shows a transient note that auto-clears. All timers
  // are unref'd so a missed clear can never hold the process open, and
  // updateHint() yields while a status is live (spinner owns the row).
  const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let statusTimer = null;
  let statusWatchdog = null;
  let statusText = '';
  let statusFrame = 0;

  function paintStatus() {
    try {
      const w = Math.max(10, (screen.width || 80) - 4);
      hintBar.setContent(truncateVisual(`${SPIN_FRAMES[statusFrame % SPIN_FRAMES.length]} ${statusText}`, w));
      screen.render();
    } catch { /* footer is best-effort */ }
  }

  function setStatus(text) {
    try {
      statusText = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'working…';
      // Transient reveal: a status owns the footer row even off-home; the
      // layout reserves it and updateHint re-hides it on clear (P1).
      try { hintBar.hidden = false; layoutBody(); } catch { /* best effort */ }
      // One animation only: while the wave loader is up, the footer shows
      // static text and never starts its braille spinner.
      try {
        if (typeof loader !== 'undefined' && loader && loader.active) {
          const w = Math.max(10, (screen.width || 80) - 4);
          hintBar.setContent(truncateVisual(statusText, w));
          screen.render();
          return;
        }
      } catch { /* loader check is best-effort */ }
      statusFrame = 0;
      if (!statusTimer) {
        try {
          statusTimer = setInterval(() => {
            statusFrame += 1;
            paintStatus();
          }, 100);
        } catch {
          statusTimer = null;
        }
        if (statusTimer && typeof statusTimer.unref === 'function') {
          try {
            statusTimer.unref();
          } catch { /* keep ticking */ }
        }
      }
      // Safety watchdog: no spinner may own the footer forever (gallery
      // bug class). Expire after 10s so the hint always comes back.
      try {
        if (statusWatchdog) clearTimeout(statusWatchdog);
        statusWatchdog = setTimeout(() => {
          try { clearStatus(); } catch { /* best effort */ }
        }, 10000);
        if (statusWatchdog && typeof statusWatchdog.unref === 'function') {
          try { statusWatchdog.unref(); } catch { /* keep ticking */ }
        }
      } catch { /* watchdog is best-effort */ }
      paintStatus();
    } catch { /* never break the caller */ }
  }

  // Home-only footer (P1): index.js reports every navigation; the hint
  // row exists on the home view, everywhere else the bottom belongs to
  // content/loader/visualizer. Toasts and statuses still reveal it
  // transiently (they unhide it; updateHint re-hides on clear).
  function setHomeMode(on) {
    try {
      homeView = !!on;
      updateHint();
      layoutBody();
      screen.render();
      return true;
    } catch { return false; }
  }

  function clearStatus() {
    try {
      if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
      }
      try {
        if (statusWatchdog) { clearTimeout(statusWatchdog); statusWatchdog = null; }
      } catch { /* best effort */ }
      statusText = '';
      updateHint();
      try { layoutBody(); } catch { /* reservation may shrink */ }
      screen.render();
    } catch { /* best effort */ }
  }

  // Transient non-destructive feedback: footer text that auto-restores the
  // hint, never touches page state (body/links/media). Preferred over
  // setCenterContent for command confirmations, misses and usage hints.
  let toastTimer = null;
  function toast(text, ms) {
    try {
      const msg = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'done';
      // A toast preempts any spinner: the spinner's job is over when we
      // report its outcome.
      try {
        if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
        if (statusWatchdog) { clearTimeout(statusWatchdog); statusWatchdog = null; }
        statusText = '';
      } catch { /* best effort */ }
      try {
        if (toastTimer) clearTimeout(toastTimer);
      } catch { /* best effort */ }
      // Claim the footer BEFORE layout: layoutBody() calls updateHint(), and
      // updateHint() yields only to a live timer. Claiming it afterwards
      // left the footer hidden on every non-home page — the toast wrote
      // into a hidden bar, so commands on a page looked like no-ops.
      toastTimer = setTimeout(() => {
        toastTimer = null;
        try { updateHint(); screen.render(); } catch { /* best effort */ }
      }, Math.max(800, Number(ms) || 2800));
      if (toastTimer && typeof toastTimer.unref === 'function') {
        try { toastTimer.unref(); } catch { /* keep ticking */ }
      }
      // Transient reveal (P1): a toast owns the footer row even off-home.
      try { hintBar.hidden = false; layoutBody(); } catch { /* best effort */ }
      const w = Math.max(10, (screen.width || 80) - 4);
      hintBar.setContent(truncateVisual(msg, w));
      try { screen.render(); } catch { /* best effort */ }
      return true;
    } catch { return false; }
  }

  function flashStatus(text, ms) {
    try {
      setStatus(text);
      const t = setTimeout(() => {
        try {
          if (statusText === String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120)) clearStatus();
        } catch { /* best effort */ }
      }, Math.max(500, Number(ms) || 2500));
      if (t && typeof t.unref === 'function') {
        try {
          t.unref();
        } catch { /* best effort */ }
      }
    } catch { /* never break the caller */ }
  }
  // ---- animated loader (bottom of the web view) ----------------------
  // The page stays exactly where it is; a slim wave bar rides the bottom
  // edge while work happens. The wave IS the animation (sine, 8 vertical
  // levels, sub-step phase advance), a braille spinner marks the live
  // stage, and elapsed seconds keep it honest. The art lives at module
  // level (waveFrame/loaderFrame); this owns only the timer and phase.
  let loader = { active: false, title: '', stage: '', frame: 0, timer: null, hint: '', startedAt: 0 };

  // Animation source: the pre-rendered frame table (one full cycle).
  // Stepping a table instead of recomputing a phase every tick is what
  // makes the motion continuous rather than sampled-and-snapped.
  const WAVE_TICK_MS = WAVE_MS;

  // Start the bottom loader. The page underneath is left completely
  // alone (no wipe, no focus steal) - the wave simply appears below it.
  function showLoading(title, stage, hint) {
    try {
      // Loader wins the bottom slot: park the visualizer timer until
      // hideLoading hands the slot back (single-animation rule).
      try { stopVizTimer(); } catch { /* best effort */ }
      loader.active = true;
      loader.title = String(title || 'Loading').replace(/\s+/g, ' ').trim().slice(0, 80);
      loader.stage = String(stage || 'working\u2026').replace(/\s+/g, ' ').trim().slice(0, 80);
      loader.hint = String(hint || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      loader.frame = 0;
      loader.startedAt = Date.now();
      layoutBody();
      if (!loader.timer) {
        // One cell further along every tick: the frame table IS the
        // animation, so stepping it is what makes the wave travel.
        loader.timer = setInterval(() => {
          loader.frame = (loader.frame + 1) % WAVE_FRAMES;
          paintLoading();
        }, WAVE_TICK_MS);
        if (loader.timer && typeof loader.timer.unref === 'function') {
          try { loader.timer.unref(); } catch { /* keep ticking */ }
        }
      }
      paintLoading();
      return true;
    } catch {
      return false;
    }
  }

  // Swap the stage text mid-flight (Resolving -> Downloading -> Launching)
  // without restarting the animation.
  function setLoadingStage(stage, hint) {
    try {
      if (String(hint || '').trim()) loader.hint = String(hint).replace(/\s+/g, ' ').trim().slice(0, 120);
      loader.stage = String(stage || loader.stage).replace(/\s+/g, ' ').trim().slice(0, 80);
      paintLoading();
      return true;
    } catch {
      return false;
    }
  }

  function isLoading() {
    return !!loader.active;
  }

  // Two rows at the very bottom of the web view, inside the footer
  // slot: the live status (title · stage · elapsed), then the full-width
  // two-tone wave. Trough cells use the theme's second colour, crests
  // the primary — a load shows both — and the page above never moves.
  // (The old third row, the loader hint, is gone: the hint footer says
  // the same things when the slot goes idle again.)
  function paintLoading() {
    if (!loader.active) return;
    try {
      // The bar's REAL width (iwidth after the first render), not a guess:
      // guessing truncated the label to nothing in narrow/headless boxes.
      const measured = loadBar && Number(loadBar.iwidth);
      const W = Math.max(24, measured > 4 ? measured : (screen.width || 80) - 2);
      const elapsed = loader.startedAt ? Math.round((Date.now() - loader.startedAt) / 1000) : 0;
      // No spinner glyph: the wave is the one and only loading animation.
      const wave = waveLineTagged(loader.frame, W, theme.accent, theme.alt);
      const stage = [loader.title, loader.stage, `${elapsed}s`]
        .map((v) => String(v || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' \u00b7 ');
      if (loadBar) {
        loadBar.setContent(
          `{${theme.alt}-fg}${escTags(truncateVisual(stage, Math.max(16, W - 4)))}{/}\n${wave}`
        );
        loadBar.hidden = false;
      }
      screen.render();
    } catch { /* loader is best-effort */ }
  }

  function hideLoading() {
    try {
      loader.active = false;
      loader.title = '';
      loader.stage = '';
      loader.hint = '';
      if (loader.timer) {
        clearInterval(loader.timer);
        loader.timer = null;
      }
      // Clear the box so stale text can never resurface (hidden boxes keep
      // content) and no dead row lingers between body and footer.
      if (loadBar) { try { loadBar.setContent(''); } catch {} loadBar.hidden = true; }
      layoutBody();
      // The visualizer owns the bottom slot again once the loader leaves.
      try { if (viz.active) { startVizTimer(); paintViz(); } } catch { /* best effort */ }
      screen.render();
    } catch { /* best effort */ }
  }

  // ---- music visualizer (footer slot while mpv plays) ----------------
  // One row in the footer slot: equalizer bars, nothing else. Precedence:
  // an active page loader always wins — paintViz is a no-op while
  // loader.active, and showLoading parks the viz timer until hideLoading
  // hands the slot back.
  let viz = { active: false, frame: 0, timer: null, paused: false, energy: null, bands: null };
  function startVizTimer() {
    try {
      if (viz.timer || !viz.active || loader.active) return;
      viz.timer = setInterval(() => {
        // Pause freezes the bars (P4): the timer keeps running so resume
        // is instant, but neither frame nor paint advances while paused.
        // Spectrum arrivals (~20 Hz) repaint themselves, so the tick skips
        // while bands are live and only advances the synthetic/envelope
        // animation underneath.
        if (!viz.paused && !viz.bands) {
          viz.frame = (viz.frame + 1) % VIZ_FRAMES;
          paintViz();
        }
      }, VIZ_MS);
      if (viz.timer && typeof viz.timer.unref === 'function') {
        try { viz.timer.unref(); } catch { /* keep ticking */ }
      }
    } catch { /* best effort */ }
  }
  function stopVizTimer() {
    try {
      if (viz.timer) { clearInterval(viz.timer); viz.timer = null; }
    } catch { /* best effort */ }
  }
  function paintViz() {
    if (!viz.active || loader.active) return;
    try {
      const measured = loadBar && Number(loadBar.iwidth);
      const W = Math.max(24, measured > 4 ? measured : (screen.width || 80) - 2);
      // Reactive when live data exists (spectrum bands win over the
      // loudness envelope; both fall back to the synthetic base shape when
      // their tap is missing/stalled — the slot never goes blank).
      const bars = (Array.isArray(viz.bands) && viz.bands.length)
        ? renderVizBands(viz.bands, W, theme.accent, theme.alt)
        : (typeof viz.energy === 'number' && Number.isFinite(viz.energy))
          ? vizEnergyLine(viz.frame, W, theme.accent, theme.alt, viz.energy)
          : vizLineTagged(viz.frame, W, theme.accent, theme.alt);
      if (loadBar) {
        // Bars only: the footer slot is one row while playing. The old
        // title/subhint rows are gone by design (hints return when idle).
        loadBar.setContent(bars);
        loadBar.hidden = false;
      }
      screen.render();
    } catch { /* visualizer is best-effort */ }
  }
  function showVisualizer() {
    try {
      viz.active = true;
      viz.frame = 0;
      viz.paused = false;
      viz.energy = null; // synthetic until the first live reading lands
      viz.bands = null;
      layoutBody();
      startVizTimer();
      paintViz();
      return true;
    } catch { return false; }
  }
  function hideVisualizer() {
    try {
      viz.active = false;
      viz.paused = false;
      viz.energy = null;
      viz.bands = null;
      stopVizTimer();
      if (!loader.active && loadBar) {
        loadBar.setContent('');
        loadBar.hidden = true;
      }
      layoutBody();
      screen.render();
    } catch { /* best effort */ }
  }
  function isVisualizerOn() {
    return !!viz.active;
  }
  // Pause-follow (P4): index.js polls mpv's pause flag over IPC and reports
  // it here — no audio analysis, no extra processes, just one cheap poll.
  function setVizPaused(p) {
    try {
      viz.paused = !!p;
      // Unpausing repaints immediately so resume never lags a tick behind.
      if (!viz.paused) paintViz();
      return true;
    } catch { return false; }
  }
  function isVizPaused() {
    return !!viz.paused;
  }
  // Live loudness from the monitor tap (src/vizAudio energy 0..1): stored
  // and repainted on arrival (~10 Hz). Junk clears back to the synthetic
  // shape — the slot never goes blank. Loader-wins still holds: a reading
  // during load only stores, paintViz stays a no-op until hideLoading.
  function setVizEnergy(e) {
    try {
      const v = Number(e);
      viz.energy = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
      if (viz.active && !viz.paused) paintViz();
      return true;
    } catch { return false; }
  }
  function getVizEnergy() {
    try { return viz.energy; } catch { return null; }
  }
  // Live spectrum from scripts/vizspectrum.py (array of 0..1 band levels,
  // low → high). Stored (clamped copy) and repainted on arrival (~20 Hz).
  // Anything invalid clears back down the fallback chain — the slot never
  // goes blank. Loader-wins holds: readings during load only store.
  function setVizBands(arr) {
    try {
      if (!Array.isArray(arr) || !arr.length || arr.length > 512) {
        viz.bands = null;
      } else {
        const clean = [];
        for (const v of arr) {
          const n = Number(v);
          clean.push(Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
        }
        viz.bands = clean;
      }
      if (viz.active && !viz.paused) paintViz();
      return true;
    } catch { return false; }
  }
  function getVizBands() {
    try { return viz.bands ? [...viz.bands] : null; } catch { return null; }
  }

  // ---- /themes: live picker -----------------------------------------
  // Moving the highlight repaints the ENTIRE app in that theme right
  // away - there is no confirm button. Whatever is highlighted when you
  // leave is what got saved.
  function themeRows() {
    const { themeList } = require('./themes');
    const rows = [{ label: 'Themes - arrow keys change it live', header: true }, { label: '', header: true }];
    const names = themeList();
    const W = Math.max(30, contentWidth());
    for (const r of themeGrid(names, W, theme.name, theme.alt)) rows.push(r);
    rows.push({ label: '  esc / enter - done (already saved)', header: true });
    return rows;
  }

  function paintThemes() {
    if (!themeState.open) return;
    try {
      const rows = themeRows();
      const { themeList } = require('./themes');
      const names = themeList();
      const cur = names[themeState.cursor];
      const lines = rows.map((r) => (r.header ? escTags(r.label) : r.label));
      body.setContent(lines.join('\n'));
      // Keep the cursor row on screen in this two-column grid.
      const row = rows.findIndex((r) => r.index === themeState.cursor || r.rightIndex === themeState.cursor);
      scrollBodyTo(row > 2 ? row - 2 : 0);
      void cur;
      screen.render();
    } catch { /* picker is best-effort */ }
  }

  // Live apply: theme + persist, no confirm step. Repaints the whole app.
  // Theme the box-drawing borders: blockMd/boxSections emit the glyphs plain,
  // so without this article boxes and rules render in the default fg and
  // ignore the theme's border colour. Wrap the Unicode box chars in the
  // theme border tag (ASCII table pipes are left alone).
  function themeBorders(text) {
    // Content borders stay in the default foreground on purpose: tagging
    // them with a mapped colour name rendered BLACK on several terminals and
    // made some themes hard to read. The app chrome (edges) already follows
    // the theme border colour and is readable everywhere.
    return text;
  }

  function applyThemeLive(name) {
    try {
      applyTheme(name);
      if (typeof onThemeChange === 'function') onThemeChange(name);
    } catch { /* theme apply is best-effort */ }
    paintThemes();
  }

  // ---- Rainbow glow (fun mode) ----
  // Cycles the whole app — borders, chrome, accents — through the spectrum.
  // Implemented by mutating the live theme object and repainting the chrome,
  // so every themed surface (lists, boxes, edges) glows too.
  let glowOn = false;
  let glowTimer = null;
  let glowHue = 0;
  function hslToHex(h, s, l) {
    h = ((Number(h) % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, Number(s))) / 100;
    l = Math.max(0, Math.min(100, Number(l))) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${to(r)}${to(g)}${to(b)}`;
  }
  function glowFrame() {
    try {
      glowHue = (glowHue + 5) % 360;
      const base = theme || getTheme('white');
      theme = {
        ...base,
        fg: hslToHex(glowHue, 18, 92),
        muted: hslToHex((glowHue + 30) % 360, 25, 72),
        border: hslToHex((glowHue + 60) % 360, 90, 58),
        accent: hslToHex((glowHue + 180) % 360, 95, 62),
        alt: hslToHex((glowHue + 120) % 360, 60, 66),
      };
      applyThemeChrome();
      screen.render();
    } catch { /* glow is best-effort */ }
  }
  function setGlow(on) {
    try {
      if (!!on === glowOn) { screen.render(); return glowOn; }
      glowOn = !!on;
      try { if (glowTimer) { clearInterval(glowTimer); glowTimer = null; } } catch { /* best effort */ }
      if (glowOn) {
        glowTimer = setInterval(glowFrame, 120);
        if (glowTimer && typeof glowTimer.unref === 'function') glowTimer.unref();
        glowFrame();
      } else {
        // Back to the locked theme (config theme), not a stale palette.
        applyTheme(String((typeof config !== 'undefined' && config && config.theme) || 'white'));
      }
      screen.render();
      return glowOn;
    } catch { return glowOn; }
  }
  function isGlowOn() { return !!glowOn; }

  function showThemes() {
    try {
      if (themeState.open) return true;
      closeGallery();
      closeTheater();
      themeState.saved = { focused, cursor: listCursor, start: listStart };
      themeState.open = true;
      const { themeList } = require('./themes');
      const names = themeList();
      let at = names.indexOf(theme.name);
      // 'white' is parked at the end as the fallback: opening the picker
      // on it would mean every arrow press does nothing. Start at the top.
      if (at < 0 || names[at] === 'white') at = 0;
      themeState.cursor = at;
      setFocus('themes');
      paintThemes();
      return true;
    } catch {
      return false;
    }
  }

  function closeThemes() {
    try {
      const saved = themeState.saved || { focused: 'content', cursor: 0, start: 0 };
      themeState.saved = null;
      themeState.open = false;
      const next = saved.focused === 'themes' ? 'content' : saved.focused;
      setFocus(next);
      listCursor = saved.cursor;
      listStart = saved.start;
      if (next === 'links') paintList(true);
      else if (next === 'input') paintSuggest();
      else showText();
      return true;
    } catch {
      return false;
    }
  }

  function isThemesOpen() {
    return themeState.open;
  }

  // ---- /settings hub ----
  // Boxed sections (soft corners), one row per setting, values cycled with
  // ←/→ (or Enter). The item list is built by commands.js from config, so
  // every change is applied + persisted there via onCycle.
  function settingsBox(section, rows, width) {
    const inner = Math.max(8, width - 4);
    const title = truncateVisual(String(section || ''), Math.max(1, inner - 6));
    const titleLen = [...title].length;
    const pad = (s) => {
      const v = truncateVisual(String(s || ''), inner);
      return `${v}${' '.repeat(Math.max(0, inner - [...v].length))}`;
    };
    // Exact-width geometry: every line must measure `width` cells or the
    // right border drifts (the "broken box" bug).
    //   top    ╭─ title ─…─╮            = 5 + titleLen + dashes
    //   row    │ <inner> │              = inner + 4
    //   bottom ╰────…────╯              = width
    const dashes = Math.max(0, width - 5 - titleLen);
    const out = [`╭─ ${title} ${'─'.repeat(dashes)}╮`];
    for (const r of rows) out.push(`│ ${pad(r)} │`);
    out.push(`╰${'─'.repeat(Math.max(0, width - 2))}╯`);
    return out.join('\n');
  }
  function paintSettings() {
    if (!settingsState) return;
    try {
      const w = Math.max(34, Math.min((screen.width || 80) - 6, 76));
      const blocks = [];
      let section = '';
      let rows = [];
      const flush = () => { if (rows.length) blocks.push(settingsBox(section, rows, w)); rows = []; };
      settingsState.items.forEach((it, i) => {
        const sec = it.section || section;
        if (sec !== section) { flush(); section = sec; }
        const cur = i === settingsState.cursor;
        // value may be a live function (theme/quality/…) so the row always
        // shows the CURRENT setting after a change.
        let valueText = '';
        try {
          const raw = typeof it.value === 'function' ? it.value() : it.value;
          valueText = raw === undefined || raw === null || raw === '' ? '' : ` ‹ ${raw} ›`;
        } catch { valueText = ''; }
        // ASCII cursor: '▶' is ambiguous-width on some terminals and would
        // shift the right border by a cell.
        const label = `${cur ? '>' : ' '} ${it.label}`;
        const padLen = Math.max(1, w - 4 - [...label].length - [...valueText].length);
        rows.push(`${label}${' '.repeat(padLen)}${valueText}`);
      });
      flush();
      body.setContent(themeBorders(blockMd(escTags(blocks.join('\n\n')))));
      scrollBodyTo(Math.max(0, Math.floor(settingsState.cursor / 6) - 1));
      screen.render();
      return true;
    } catch { return false; }
  }
  function showSettings(items, opts) {
    try {
      const list = (Array.isArray(items) ? items : []).filter(Boolean);
      if (!list.length) return false;
      // A media split open underneath is remembered, not destroyed: Esc (or
      // the command finishing) brings the image back.
      snapshotMediaSplit();
      settingsState = { items: list, cursor: 0, onLeave: opts && typeof opts.onLeave === 'function' ? opts.onLeave : null };
      setFocus('settings');
      paintSettings();
      return true;
    } catch { return false; }
  }
  function closeSettings() {
    if (!settingsState) return false;
    const cb = settingsState.onLeave;
    settingsState = null;
    setFocus('content');
    showText();
    if (cb) { try { cb(); } catch { /* best effort */ } }
    return true;
  }
  function isSettingsOpen() { return !!settingsState; }
  function moveSettingsCursor(delta) {
    if (!settingsState) return false;
    const n = settingsState.items.length;
    settingsState.cursor = Math.min(n - 1, Math.max(0, settingsState.cursor + (Number(delta) < 0 ? -1 : 1)));
    paintSettings();
    return true;
  }
  function cycleSetting(dir) {
    try {
      if (!settingsState) return false;
      const it = settingsState.items[settingsState.cursor];
      if (!it) return false;
      if (it.open === 'themes' && typeof showThemes === 'function') {
        showThemes();
        return true;
      }
      if (typeof it.onCycle !== 'function') return false;
      it.onCycle(Number(dir) < 0 ? -1 : 1);
      paintSettings();
      return true;
    } catch { return false; }
  }

  // Enter on a settings row: an item with onSelect opens its editor
  // (name / number / dob / password / API key); an item with onCommit locks
  // it in (applies + persists + confirms); everything else cycles forward.
  function selectSetting() {
    try {
      if (!settingsState) return false;
      const it = settingsState.items[settingsState.cursor];
      if (!it) return false;
      if (typeof it.onSelect === 'function') { it.onSelect(); return true; }
      if (typeof it.onCommit === 'function') {
        try { it.onCommit(); } catch { /* commit is best-effort */ }
        try { paintSettings(); } catch { /* paint is best-effort */ }
        return true;
      }
      return cycleSetting(1);
    } catch { return false; }
  }

  function moveThemeCursor(delta) {
    if (!themeState.open) return;
    try {
      const { themeList } = require('./themes');
      const names = themeList();
      const next = Math.max(0, Math.min(names.length - 1, themeState.cursor + delta));
      if (next === themeState.cursor) return;
      themeState.cursor = next;
      // The whole point: live, no Enter needed.
      applyThemeLive(names[next]);
    } catch { /* picker is best-effort */ }
  }

  // Rounded box for the AI answer — the exact art the article/webpage
  // sections use (beautify.boxSections):
  //   ╭─ title ──────╮
  //   │  text        │
  //   ╰──────────────╯
  // Pipeline: escTags -> blockMd (headings, bullets, quotes, inline emphasis)
  // -> wrapVis per line (cell-accurate, tag-aware) -> pad with visibleCells.
  // Markdown runs BEFORE the box art. The old order boxed the raw text and
  // ran blockMd over the finished box, so every transform that changed a
  // line's width (**bold** losing its markers, CJK/emoji counted as code
  // points) left the right border short — the uneven-box bug. Lines wrap
  // INDIVIDUALLY so bullet points stay bullet points ("• a\n• b" never
  // collapses into one running sentence the way a flat word-wrap does).
  function aiBox(title, text, width, maxTextLines) {
    const { blockMd, wrapVis, fitVis, visibleCells } = require('./beautify');
    const w = Math.max(24, Number(width) || 24);
    const inner = w - 6; // row art: "│  " + text + "  │" = w cells
    const cap = Math.max(1, Number(maxTextLines) || 1);
    // Leading/trailing blanks read as broken art; interior blanks keep the
    // paragraph rhythm blockMd set up.
    const lines = blockMd(escTags(String(text || ''))).split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const rows = [];
    for (const line of lines) {
      for (const r of wrapVis(line, inner)) {
        rows.push(r);
        if (rows.length >= cap) break;
      }
      if (rows.length >= cap) break;
    }
    // Title budget matches the old square box (w - 6 cells), so existing
    // "AI answer — by <model>" truncation behavior is unchanged.
    const t = fitVis(escTags(String(title || 'AI answer').trim()), w - 6) || 'AI answer';
    const out = [`╭─ ${t} ${'─'.repeat(Math.max(1, w - visibleCells(t) - 5))}╮`];
    for (const r of rows) {
      out.push(`│  ${r}${' '.repeat(Math.max(0, inner - visibleCells(r)))}  │`);
    }
    out.push(`╰${'─'.repeat(w - 2)}╯`);
    return out.join('\n');
  }

  function layoutBody() {
    // ONE docking system (P2): every bottom-anchored box gets its `.bottom`
    // here, every repaint — no static `bottom: 1` assumptions, no dead rows.
    // The footer slot is one occupant at a time: loader (2 rows), viz
    // (1 row), or hints (1 row, home-idle only) — never stacked.
    // The now-playing row docks ABOVE the slot while mpv runs.
    // Fullscreen AI owns the whole body (bar hidden underneath it).
    const barOn = summaryVisible && focused === 'links' && !aiExpanded && !!lastAi;
    try {
      // Loader wins the slot; viz paints only when the loader is off.
      // Hint content shows only when the slot is idle (updateHint yields
      // while either animates) — sync it first so the stack math sees it.
      try { updateHint(); } catch { /* footer is best-effort */ }
      const bottomH = loader.active ? LOAD_H : viz.active ? VIZ_H : 0;
      const bottomOn = bottomH > 0;
      const hintOn = !hintBar.hidden;
      const npOn = !!npText;
      const stack = bottomH + (hintOn ? 1 : 0) + (npOn ? 1 : 0);
      body.bottom = (barOn ? AI_BAR_H : 0) + stack;
      if (aiBar) { aiBar.hidden = !barOn; aiBar.bottom = stack; }
      if (loadBar) {
        if (bottomOn) { try { loadBar.height = bottomH; } catch { /* keep construction height */ } }
        loadBar.hidden = !bottomOn; loadBar.bottom = 0;
      }
      if (hintBar) hintBar.bottom = bottomH;
      if (typeof npBar !== 'undefined' && npBar) { npBar.hidden = !npOn; npBar.bottom = bottomH + (hintOn ? 1 : 0); }
      if (typeof shieldBar !== 'undefined' && shieldBar) shieldBar.bottom = bottomH;
      if (typeof imgPane !== 'undefined' && imgPane) imgPane.bottom = stack;
      if (typeof theaterPane !== 'undefined' && theaterPane) theaterPane.bottom = stack;
      if (typeof splitDiv !== 'undefined' && splitDiv) splitDiv.bottom = stack;
    } catch { /* layout is best-effort */ }
  }

  function paintAiBar() {
    try {
      // The bottom box carries the REAL LLM answer (or the key hint / the
      // honest error). The old extractive "AI summary" digest is no longer
      // displayed anywhere.
      if (!(summaryVisible && focused === 'links') || !lastAi || aiExpanded) return;
      const w = Math.max(24, (screen.width || 80) - 4);
      let title = 'AI answer';
      try {
        if (lastAiModel) title = `AI answer — by ${require('./openrouter').modelLabel(lastAiModel)}`;
      } catch { /* keep the plain title */ }
      const box = aiBox(title, lastAi, w, AI_ANSWER_LINES);
      aiBar.setContent(`${themeBorders(box)}\n Alt+Up full response · alt+down hide`);
    } catch { /* bar is best-effort */ }
  }

  // Fullscreen digest: rounded box (same art as the bar and the webpage
  // sections), full body height, Esc / Alt+Down to collapse. Uncapped by
  // design — the whole response scrolls.
  function paintAiFullscreen() {
    try {
      const w = Math.max(24, (screen.width || 80) - 4);
      const h = Math.max(10, (body.height || 12) - 1);
      let title = 'AI answer';
      try {
        if (lastAiModel) title = `AI answer — by ${require('./openrouter').modelLabel(lastAiModel)}`;
      } catch { /* keep the plain title */ }
      const head = `${title} — FULL RESPONSE (${h} rows · Esc to collapse)`;
      body.setContent(themeBorders(`${aiBox(head, lastAi, w, 100000)}\n Full response · ↑/↓/PgUp/PgDn scroll · Esc collapse`));
      scrollBodyTo(0);
    } catch { /* best effort */ }
  }

  function collapseAi() {
    // Dismisses both the fullscreen view and the bottom bar, then repaints
    // whatever the user was looking at (list or article).
    const was = aiExpanded || summaryVisible;
    if (!was) return false;
    aiFullToken++; // cancel any in-flight real-AI reply
    aiExpanded = false;
    summaryVisible = false;
    if (focused === 'links') paintList(true);
    else showText();
    return true;
  }
  // Clicks carry ABSOLUTE screen coords (blessed compares them against
  // el.lpos); convert to body-relative before row mapping. Re-focus the
  // omnibox: clickable elements steal DOM focus, which would kill typing.
  body.on('click', (data) => {
    if (!data) return;
    focusField();
    // A click anywhere collapses the fullscreen digest first.
    if (aiExpanded) {
      collapseAi();
      return;
    }
    const base = body.lpos ? body.lpos.yi : 0;
    const y = typeof data.y === 'number' ? data.y - base : -1;
    if (y < 0) return;

    if (focused === 'links') {
      // Header-aware click mapping: paintList records the exact header
      // height (AI card may be multi-line), YT lists are always 2.
      let scroll = 0;
      try {
        const h = body.height || 10;
        scroll = body.getScrollHeight() <= h ? 0 : Math.max(0, body.childBase || 0);
      } catch {
        scroll = 0;
      }
      const idx = rowIndexFromY(y, scroll, listHeaderLines);
      const { win } = windowOf(listLinks);
      if (idx < 0 || idx >= win.length + (win.length < listLinks.length - listStart ? 1 : 0)) return;
      listCursor = listStart + idx;
      paintList(true);
      confirmLinkList();
      return;
    }

    if (focused === 'content' && contentLinkLines.length > 0) {
      // Content mode: click on a link line to navigate. Content views have
      // no header lines (renderSpans starts at line 0, paintPretty offsets
      // by boxStart only), so the mapping is y + scroll with no subtraction.
      let scroll = 0;
      try {
        const h = body.height || 10;
        scroll = body.getScrollHeight() <= h ? 0 : Math.max(0, body.childBase || 0);
      } catch {
        scroll = 0;
      }
      const lineIdx = y + scroll;
      const linkLine = contentLinkLines.find(l => l.line === lineIdx);
      if (linkLine && linkLine.url) {
        onLinkPick(linkLine.url);
      }
    }
  });

  function applyTheme(name) {
    theme = getTheme(name);
    applyThemeChrome();
  }

  // Nearest blessed colour NAME for a hex (for content borders — blessed
  // tags need a name, not a hex). Pure.
  const COLOR_NAMES = {
    black: [0, 0, 0], red: [255, 0, 0], green: [0, 255, 0], yellow: [255, 255, 0],
    blue: [0, 0, 255], magenta: [255, 0, 255], cyan: [0, 255, 255], white: [255, 255, 255],
    gray: [128, 128, 128], lightred: [255, 128, 128], lightgreen: [128, 255, 128],
    lightyellow: [255, 255, 128], lightblue: [128, 128, 255], lightmagenta: [255, 128, 255],
    lightcyan: [128, 255, 255], lightwhite: [255, 255, 255],
  };
  function colorNameFor(hex) {
    try {
      const h = String(hex || '').replace('#', '');
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      let best = 'white';
      let bestD = Infinity;
      for (const [name, rgb] of Object.entries(COLOR_NAMES)) {
        const d = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
        if (d < bestD) { bestD = d; best = name; }
      }
      return best;
    } catch { return 'white'; }
  }

  // Paint every chrome widget from the live `theme` object (edges, header,
  // separators, bar, body, panes). Shared by applyTheme() and the rainbow
  // glow, which mutates theme.* per frame — so the WHOLE app glows, borders
  // included.
  function applyThemeChrome() {
    edgeTop.style.fg = theme.border;
    edgeBottom.style.fg = theme.border;
    edgeLeft.style.fg = theme.border;
    edgeRight.style.fg = theme.border;
    header.style.fg = theme.muted;
    sep1.style.fg = theme.muted;
    // The rule under the command line matches the theme border (not the
    // muted text color) so it reads as chrome, not content.
    sep2.style.fg = theme.border;
    omni.style.fg = theme.fg;
    searchBtn.style.fg = theme.accent;
    body.style.fg = theme.fg;
    if (aiBar) aiBar.style.fg = theme.fg;
    if (typeof imgPane !== 'undefined' && imgPane) imgPane.style.fg = theme.accent;
    if (typeof theaterPane !== 'undefined' && theaterPane) theaterPane.style.fg = theme.fg;
    if (typeof hintBar !== 'undefined' && hintBar) hintBar.style.fg = theme.muted;
    if (typeof splitDiv !== 'undefined' && splitDiv) splitDiv.style.fg = theme.border;
    if (typeof cmdBar !== 'undefined' && cmdBar) cmdBar.style.fg = theme.fg;
    if (theme.bg) {
      edgeTop.style.bg = theme.bg;
      edgeBottom.style.bg = theme.bg;
      edgeLeft.style.bg = theme.bg;
      edgeRight.style.bg = theme.bg;
      frame.style.bg = theme.bg;
      header.style.bg = theme.bg;
      sep1.style.bg = theme.bg;
      sep2.style.bg = theme.bg;
      omni.style.bg = theme.bg;
      searchBtn.style.bg = theme.bg;
      body.style.bg = theme.bg;
      if (aiBar) aiBar.style.bg = theme.bg;
      if (loadBar) loadBar.style.bg = theme.bg;
      if (typeof imgPane !== 'undefined' && imgPane) imgPane.style.bg = theme.bg;
      if (typeof theaterPane !== 'undefined' && theaterPane) theaterPane.style.bg = theme.bg;
      if (typeof hintBar !== 'undefined' && hintBar) hintBar.style.bg = theme.bg;
      if (typeof splitDiv !== 'undefined' && splitDiv) splitDiv.style.bg = theme.bg;
      if (typeof cmdBar !== 'undefined' && cmdBar) cmdBar.style.bg = theme.bg;
    } else {
      delete edgeTop.style.bg;
      delete edgeBottom.style.bg;
      delete edgeLeft.style.bg;
      delete edgeRight.style.bg;
      delete frame.style.bg;
      delete header.style.bg;
      delete sep1.style.bg;
      delete sep2.style.bg;
      delete omni.style.bg;
      delete searchBtn.style.bg;
      delete body.style.bg;
      if (aiBar) delete aiBar.style.bg;
      if (loadBar) delete loadBar.style.bg;
      if (typeof imgPane !== 'undefined' && imgPane) delete imgPane.style.bg;
      if (typeof theaterPane !== 'undefined' && theaterPane) delete theaterPane.style.bg;
      if (typeof hintBar !== 'undefined' && hintBar) delete hintBar.style.bg;
      if (typeof splitDiv !== 'undefined' && splitDiv) delete splitDiv.style.bg;
      if (typeof cmdBar !== 'undefined' && cmdBar) delete cmdBar.style.bg;
    }
    screen.render();
    return theme.name;
  }

  function setPageSize(n) {
    pageSize = n;
    listStart = 0;
    listCursor = 0;
  }

  // Separators are painted to the exact inner width (a static long string
  // would wrap and push the layout down). Part of repaintChrome() so edges
  // and rules always agree on the width.
  function repaintChrome() {
    const W = screen.width || 80;
    const H = screen.height || 24;
    const hw = Math.max(0, W - 2);
    edgeTop.setContent(hw > 0 ? `${CORNER_TL}${EDGE_H.repeat(hw)}${CORNER_TR}` : '');
    edgeBottom.setContent(hw > 0 ? `${CORNER_BL}${EDGE_H.repeat(hw)}${CORNER_BR}` : '');
    const vh = Math.max(0, H - 2);
    const rail = vh > 0 ? Array(vh).fill(EDGE_V).join('\n') : '';
    edgeLeft.setContent(rail);
    edgeRight.setContent(rail);
    sep1.setContent(TOP_SEP.repeat(hw));
    sep2.setContent(BOT_SEP.repeat(hw));
  }
  repaintChrome();
  screen.on('resize', () => {
    repaintChrome();
    paintSplitDiv();
    // Re-measure boxes to the new webview width so borders never outlive
    // their layout (see contentWidth).
    try {
      if (lastPretty && focused === 'content' && !isPickerOpen()) paintPretty();
    } catch { /* chrome already repainted */ }
    // Graphics overlays are pinned to absolute cells: a resize invalidates
    // every anchor, so re-place the grid photos / fullscreen image.
    try { if (galleryGrid) paintGalleryGrid(); } catch { /* best effort */ }
    try { if (imageFullscreen) paintImageFullscreen(); } catch { /* best effort */ }
    screen.render();
  });

  void header;

  // Focus is blur-safe: focusing an already-focused textbox fires blur
  // -> cancel, so guard it everywhere.
  function focusField() {
    if (screen.focused !== omni) omni.focus();
    showCaret();
  }

  // Owned caret: blessed only shows a textbox cursor while readInput() is
  // active, which we never use (manual editing). So position the terminal
  // cursor at the end of the bar ourselves after every paint. Best-effort:
  // never allowed to break a paint.
  function showCaret() {
    try {
      if (typeof omni._updateCursor === 'function') omni._updateCursor();
      if (screen.program && typeof screen.program.showCursor === 'function') {
        screen.program.showCursor();
      }
    } catch {
      /* invisible caret beats a crashed render */
    }
  }

  // Single owner for focus transitions (also refreshes the footer hint
  // and owns palette visibility: the overlay shows only for slash input).
  function setFocus(mode) {
    // The omnibox mask is a per-step form property: leaving form mode must
    // always unmask, or every later URL/query renders as **** (P0-3).
    try {
      if (mode !== 'form' && omni && omni.censor) omni.censor = false;
    } catch { /* mask is best-effort */ }
    // Leaving the settings panel drops it: a focus change away from settings
    // must never leave a ghost panel that swallows keys.
    if (mode !== 'settings' && settingsState) settingsState = null;
    focused = mode;
    try {
      if (typeof cmdBar !== 'undefined' && cmdBar) {
        // Overlay only over a snapshotted view; idle input paints the body.
        const show = mode === 'input' && /^\s*\//.test(omni.getValue()) && !!cmdSnapshot;
        cmdBar.hidden = !show;
        if (show) paintCommandPalette();
      }
    } catch { /* palette is best-effort */ }
    updateHint();
  }

  // ---- suggestions (the pipe): debounced, stale responses dropped ----
  function scheduleSuggest() {
    if (suggestTimer) clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => {
      suggestTimer = null;
      // Set with the id: a stale response is dropped by the id guard, so
      // rows and this query can never disagree.
      suggestQuery = omni.getValue();
      onSuggest(suggestQuery, ++suggestSeq);
    }, 180);
  }

  // Row normalizer: hostile/plugin rows (null, strings, numbers, huge
  // values) become safe shapes or are dropped. Every list entry point
  // goes through here so rowLine/confirmLinkList never see a null.
  function safeRow(r) {
    if (!r || typeof r !== 'object') return null;
    const url = typeof r.url === 'string' && r.url ? r.url : null;
    const title = String(r.title != null ? r.title : (r.label != null ? r.label : '')).slice(0, 200);
    const domain = String(r.domain || '').slice(0, 120);
    const thumb = typeof r.thumb === 'string' && r.thumb ? r.thumb : null;
    const channel = typeof r.channel === 'string' ? r.channel.slice(0, 60) : '';
    return {
      title: title || domain || url || '(link)',
      domain: domain || (url ? domainOf(url) : ''),
      url,
      kind: typeof r.kind === 'string' ? r.kind : 'search',
      thumb,
      ...(channel ? { channel } : {}),
      ...(Number.isFinite(Number(r.duration)) && Number(r.duration) > 0 ? { duration: Number(r.duration) } : {}),
      ...(r.video ? { video: true } : {}),
      ...(r.image ? { image: true } : {}),
      ...(r.queue ? { queue: true } : {}),
    };
  }

  function renderSuggestRows(rows, id) {
    if (id !== suggestSeq) return; // stale network response
    suggestRows = (Array.isArray(rows) ? rows : []).map((r) => ({
      title: String((r && (r.label != null ? r.label : r.title)) || '').slice(0, 200),
      domain: (r && r.domain) || domainOf(r && r.url),
      url: (r && r.url) || null,
      kind: (r && r.kind) || 'search',
      thumb: (r && r.thumb) || null,
      // Section label for the command palette ('' for web rows: no header).
      section: String((r && r.section) || ''),
    })).filter((r) => r.title || r.url);
    listCursor = 0;
    listStart = 0;
    if (focused === 'input') paintSuggest();
  }

  function domainOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  // ---- row painting (shared by suggestions + link list) ----
  // Rows are truncated to the inner width so a mouse click's y maps exactly
  // to a row (no wrapping ambiguity). Truncation happens on plain text,
  // BEFORE tag escaping, so `{open}` sequences are never split.
  function rowWidth() {
    return Math.max(10, (screen.width || 80) - 6);
  }

  // Live webview width: the body shrinks to 60%-1 while the gallery or
  // theater split owns the right side (with a 1-cell divider between).
  // Box painters must measure this on EVERY paint (never a cached width)
  // or borders outlive their layout and blessed wraps mid-border. Safe to
  // call any time after boot.
  function contentWidth() {
    try {
      const full = Math.max(20, (screen.width || 80) - 6);
      const split = (typeof galleryOpen !== 'undefined' && galleryOpen) ||
        (typeof theaterOpen !== 'undefined' && theaterOpen);
      if (split) return Math.max(20, Math.floor(full * 0.6) - 1);
      return full;
    } catch {
      return 74;
    }
  }

  // Real container width for body content: the live blessed inner width,
  // never the derived contentWidth() alone. contentWidth() reads
  // screen.width (fresh on resize) while body.iwidth lags one render, so
  // after a shrink the stale iwidth is the wide one — taking the MIN is
  // safe under both orderings (a narrower box never escapes; the next
  // paint converges). Blessed wraps scrollable content at full iwidth
  // (no scrollbar object on our body, so no -1; see element.js
  // parseContent margin++), minus 1 if one is ever added. Falls back to
  // contentWidth() headless/early-boot (tests, pre-first-render).
  function bodyInnerWidth() {
    try {
      const derived = contentWidth();
      const iw = Number(body && body.iwidth);
      if (Number.isFinite(iw) && iw > 0) {
        return Math.max(1, Math.min(derived, Math.floor(iw) - (body.scrollbar ? 1 : 0)));
      }
      return derived;
    } catch {
      return 74;
    }
  }

  // Split divider: a visible vertical line between the webview (left) and
  // the image/theater pane (right). Owned chrome — painted on every split
  // toggle and resize, hidden otherwise. Never steals clicks (mouse off).
  const splitDiv = makeBox({
    parent: inner,
    top: 4,
    left: '60%-1',
    width: 1,
    bottom: 1,
    content: '',
    tags: false,
    mouse: false,
    autoFocus: false,
    hidden: true,
    style: { fg: theme.border, ...themedBg() },
  });

  function paintSplitDiv() {
    try {
      const open = (typeof galleryOpen !== 'undefined' && galleryOpen) ||
        (typeof theaterOpen !== 'undefined' && theaterOpen);
      splitDiv.hidden = !open;
      if (!open) return;
      const h = Math.max(1, (screen.height || 24) - 6);
      splitDiv.setContent(Array(h).fill('│').join('\n'));
    } catch { /* chrome is best-effort */ }
  }

  // Truncate to `w` TERMINAL CELLS (wide CJK/emoji count 2), keeping
  // blessed tags intact. The old version counted code points including
  // tag characters, so it over-truncated tagged strings and let wide
  // chars overrun their row (BUG-2 H2, BUG-6).
  // Renders one row. Truncation happens on PLAIN text before any tag is
  // injected, so a mouse click's y still maps to exactly one row and the
  // highlighted substring can never split a tag. If the match would be
  // cut off by truncation we drop the highlight rather than misalign it.
  // `(pdf)` marker for list rows: the user should know a link is a PDF
  // BEFORE opening it (the viewer then renders it in-app, no Chrome).
  // Regex mirrors src/pdf.js isPdfUrl — keep the two in sync.
  function pdfTag(url) {
    try {
      return /\.pdf(\?|#|$)/i.test(new URL(String(url)).pathname) ? '(pdf)' : '';
    } catch {
      return /\.pdf(\?|#|$)/i.test(String(url || '')) ? '(pdf)' : '';
    }
  }

  function rowLine(r, cursor, opts) {
    const safe = r && typeof r === 'object' ? r : {};
    const tag = safe.url ? pdfTag(safe.url) : '';
    const sub = safe.domain ? ` (${safe.domain})${tag}` : tag ? ` ${tag}` : '';
    const plain = sanitizeLine(`${safe.title || ''}${sub}`);
    const w = rowWidth();
    const chars = [...plain];
    const q = opts && opts.highlight ? String(suggestQuery || '').trim().toLowerCase() : '';
    let at = q ? plain.toLowerCase().indexOf(q) : -1;
    // Prefer a word-boundary hit ("foo" in "food truck" beats the "foo" in
    // somehost.com) — matches how a search bar highlights what you typed.
    if (at > 0 && /[a-z0-9]/i.test(plain[at - 1])) {
      const next = plain.toLowerCase().indexOf(q, at + 1);
      if (next >= 0) at = next;
    }
    let text;
    if (at >= 0 && at < w) {
      const cut = chars.length > w ? w - 1 : chars.length;
      const midEnd = Math.min(at + q.length, cut);
      text =
        escTags(plain.slice(0, at)) +
        '{bold}' +
        escTags(plain.slice(at, midEnd)) +
        '{/}' +
        escTags(plain.slice(midEnd, cut)) +
        (chars.length > w ? '…' : '');
    } else {
      text = escTags(truncateVisual(plain, w));
    }
    return `${cursor ? '> ' : '  '}${text}`;
  }

  function windowOf(rows) {
    const win = rows.slice(listStart, listStart + pageSize);
    const remaining = rows.length - (listStart + win.length);
    return { win, remaining, tailIdx: remaining > 0 ? listStart + win.length : -1 };
  }

  function clampCursor(rows) {
    if (listCursor > rows.length - 1) listCursor = Math.max(0, rows.length - 1);
    if (listCursor < 0) listCursor = 0;
    // NOTE: no sliding window — it only moves on explicit "load more".
    if (listCursor < listStart) listStart = listCursor;
  }

  // Centralized scroll: blessed's scrollTo() misbehaves when content is
  // shorter than the viewport (junk offsets that also break click-row
  // mapping), so short content gets a hard zero and only tall content
  // scrolls. Direct childBase/childOffset reset is safe — plain numbers.
  // Also the single place images are cleared: graphics persist outside
  // blessed's buffer, so every repaint (and scroll) must delete them or
  // they smear over the new content.
  function scrollBodyTo(line) {
    tryClearImages();
    // Every repaint re-agrees on layout: the fixed AI bar owns bottom rows
    // on search lists only; articles/settings/forms get the full body back.
    layoutBody();
    try {
      const h = body.height || 10;
      if (body.getScrollHeight() <= h) {
        body.childBase = 0;
        body.childOffset = 0;
      } else {
        body.scrollTo(Math.max(0, line));
      }
    } catch {
      /* best effort on tiny screens */
    }
    screen.render();
  }

  function paintSuggest() {
    clampCursor(suggestRows);
    // Browsing (a snapshotted view underneath): slash input paints the
    // top overlay and the page stays put. Idle (no view open): the same
    // grouped palette straight into the body — window capped so the
    // catalog never floods the screen.
    if (isCommandMode() && cmdSnapshot) {
      paintCommandPalette();
      return;
    }
    hideCommandPalette();
    const maxLines = Math.max(4, Math.min(10, (body.height || 16) - 1));
    const { lines, cursorLine } = paletteLines(suggestRows, maxLines);
    body.setContent(lines.join('\n'));
    scrollBodyTo(Math.max(0, cursorLine - 2));
  }

  // Exact header height of the last list paint (click mapping + scroll).
  // paintList sets it from the real AI line count; YT lists are always 2.
  let listHeaderLines = 2;
  // Overrides the list header text (home dashboard). Empty = default
  // "Links (n)". Reset by every real list setter so it never leaks.
  let listHeading = '';

  function paintList(showCursor) {
    // YouTube fast-list owns its paint: title-only rows so `>` always maps
    // to the thumbnail being previewed.
    if (ytMode) {
      paintYouTubeList(showCursor);
      return;
    }
    clampCursor(listLinks);
    const { win, remaining, tailIdx } = windowOf(listLinks);
    // The REAL answer now lives in the bottom AI box (paintAiBar), not as a
    // header here — the list is just the links, so its header is always 2
    // rows and click/scroll mapping stays trivial. The home dashboard swaps
    // only the heading text (listHeading), never the 2-row geometry. Headings
    // truncate to the body width (guarded: headless screens report width 1 —
    // a bogus width must not chop the heading to 10 cells).
    const rawW = Math.max(Number(body.width) || 0, Number(screen.width) || 0);
    const headW = rawW > 20 ? rawW - 2 : 200;
    const lines = [`{${theme.accent}-fg}${escTags(truncateVisual(listHeading || `Links (${listLinks.length})`, headW))}{/}`, ''];
    listHeaderLines = 2;
    win.forEach((l, i) => lines.push(rowLine(l, showCursor && listStart + i === listCursor)));
    if (remaining > 0) {
      lines.push(`${showCursor && listCursor === tailIdx ? '> ' : '  '}… load more (${remaining} more${fillStalled ? ', fill stalled' : ''})`);
    }
    if (listLinks.length === 0) lines.push('(no links)');
    body.setContent(lines.join('\n') || '(no links)');
    // Fixed bottom AI bar (real answer) — layout + paint live here so every
    // list repaint agrees on where the bar owns rows.
    layoutBody();
    paintAiBar();
    scrollBodyTo(listCursor - listStart + listHeaderLines);
  }

  // Append fan-out rows without disturbing the cursor. Used by the search
  // fill: DDG gives 10, we fetch more in the background, and the list grows
  // under the user's finger. `done` false keeps the "… load more" tail.
  // Returns the number of rows actually added.
  function appendLinks(rows, done) {
    try {
      const incoming = (Array.isArray(rows) ? rows : []).map(safeRow).filter(Boolean);
      if (!incoming.length) return 0;
      const seen = new Set(listLinks.map((r) => r.url));
      const fresh = incoming.filter((r) => !seen.has(r.url));
      if (!fresh.length) return 0;
      listLinks = listLinks.concat(fresh);
      lastLinks = listLinks;
      fillDone = done === undefined ? fillDone : !!done;
      // Fullscreen digest owns the body: a background arrival must never
      // repaint over it (the ALT+UP "loads more links" bug). Rows merge
      // silently and appear on collapse, which always repaints.
      if (aiExpanded) return fresh.length;
      // Cursor and window are untouched on purpose: the highlight must not
      // jump while a background fetch lands.
      if (focused === 'links' || ytMode) paintList(true);
      else body.setContent(body.getContent() || '');
      return fresh.length;
    } catch {
      return 0;
    }
  }

  // The search fan-out died (network/bot-wall/timeout): say so on the
  // tail row instead of silently sticking at 10 links. Cleared by the
  // next showLinkPicker. Never repaints over a fullscreen digest.
  function markFillStalled() {
    try {
      fillStalled = true;
      if (!aiExpanded && (focused === 'links' || ytMode)) paintList(true);
      return true;
    } catch { return false; }
  }

  // Per-page blocked-request count (fonts/media/trackers) → footer badge.
  // Tracker-shield badge: ALWAYS bottom-right, so the blocker is visibly
  // working while browsing. It glows (accent + bold) for ~1.6 s whenever a
  // new request is refused, then settles back to a quiet badge. Counts are
  // session totals; the zero state stays visible but muted.
  function paintShield() {
    try {
      const n = blockedTotal;
      const glowing = !!shieldGlow;
      shieldBar.hidden = false;
      shieldBar.style.fg = glowing ? theme.accent : (n > 0 ? theme.alt : theme.muted);
      shieldBar.style.bg = theme.bg;
      shieldBar.setContent(glowing ? `{bold}⛨ ${n}{/}` : `⛨ ${n}`);
      screen.render();
    } catch { /* badge is best-effort */ }
  }

  function setBlockedCount(n, total) {
    const v = Math.max(0, Number(n) || 0);
    const t = Number.isFinite(Number(total)) ? Math.max(0, Number(total)) : blockedTotal + v;
    const grew = t > blockedTotal;
    blockedPage = v;
    blockedTotal = t;
    if (grew) {
      // Glow in … and out: bright pulse for a moment, then settle.
      try { if (shieldGlow) clearTimeout(shieldGlow); } catch { /* best effort */ }
      shieldGlow = setTimeout(() => {
        shieldGlow = null;
        paintShield();
      }, 1600);
      if (shieldGlow && typeof shieldGlow.unref === 'function') {
        try { shieldGlow.unref(); } catch { /* keep ticking */ }
      }
    }
    paintShield();
    updateHint();
    return blockedPage;
  }

  // Page title for friendly messages (bookmark confirmation, queue flashes).
  function currentTitle() {
    try {
      if (lastReader && lastReader.title) return String(lastReader.title).slice(0, 120);
    } catch { /* best effort */ }
    return '';
  }

  // ★ marker: true while the current page is in the bookmark store.
  function setBookmarked(on) {
    bookmarkedPage = !!on;
    updateHint();
    screen.render();
    return bookmarkedPage;
  }

  // Reader vs raw view for the next paint (owned by index.js, which
  // re-extracts); stored so Esc-restore/resize keep the same look.
  function setReadMode(mode, meta) {
    readMode = mode === 'raw' ? 'raw' : 'reader';
    if (meta && typeof meta === 'object') lastReader = meta;
    return readMode;
  }

  // Title-only YouTube row: `> 3. Actual Video Title` — no domain, no
  // snippet. Numbering matches /watch N and the spoken selector.
  function rowLineYt(r, cursor, absIdx) {
    const safe = r && typeof r === 'object' ? r : {};
    const plain = sanitizeLine(`${Number(absIdx) + 1}. ${safe.title || ''}`);
    const text = escTags(truncateVisual(plain, rowWidth()));
    return `${cursor ? '> ' : '  '}${text}`;
  }

  function paintYouTubeList(showCursor) {
    clampCursor(listLinks);
    const { win, remaining, tailIdx } = windowOf(listLinks);
    const head = `YouTube: ${ytQuery.slice(0, 60)} (${listLinks.length})`;
    const lines = [head, ''];
    listHeaderLines = 2;
    win.forEach((l, i) => {
      const abs = listStart + i;
      lines.push(rowLineYt(l, showCursor && abs === listCursor, abs));
    });
    if (remaining > 0) {
      lines.push(`${showCursor && listCursor === tailIdx ? '> ' : '  '}… load more (${remaining} more)`);
    }
    if (listLinks.length === 0) lines.push('(no videos)');
    body.setContent(lines.join('\n') || '(no videos)');
    // YT lists never show the AI bottom bar — titles only.
    summaryVisible = false;
    aiExpanded = false;
    layoutBody();
    scrollBodyTo(listCursor - listStart + 2);
  }

  function showYouTubePicker(rows, query) {
    const list = (Array.isArray(rows) ? rows : []).map(safeRow).filter(Boolean)
      .map((r) => ({ ...r, video: true }));
    if (list.length === 0) return false;
    ytMode = true;
    ytQuery = String(query || '').trim().slice(0, 80);
    lastPretty = null;
    listLinks = list;
    lastLinks = list;
    lastAi = '';
    lastSummary = '';
    summaryVisible = false;
    aiExpanded = false;
    listCursor = 0;
    listStart = 0;
    setFocus('links');
    paintYouTubeList(true);
    // Warm bytes so first Tab/arrow preview is instant.
    try { prefetchImages(list.slice(0, 6).map((r) => r.thumb).filter(Boolean)); } catch { /* best effort */ }
    // Auto-preview highlighted thumb on graphics terms (bound to `>`).
    try {
      const link = list[0];
      if (link && link.thumb && imageSupport() !== 'none') {
        const a = imageAnchor();
        if (a) showThumbnail(link.thumb, a).catch(() => {});
      }
    } catch { /* preview is best-effort */ }
    return true;
  }

  function isYouTubeMode() {
    return !!ytMode;
  }

  // Arrows only MOVE the highlight — nothing loads until Enter/Space
  // commits the row. (Auto-preview on arrowing is gone by design: it yanked
  // users out of the list and destroyed back-navigation.)
  // Exception: ytMode auto-previews the highlighted thumbnail on graphics
  // terminals (bound to `>`), ASCII terms keep manual Tab to avoid
  // rewriting the list on every arrow.
  function moveCursor(delta) {
    const rows = focused === 'input' ? suggestRows : listLinks;
    const { win, remaining, tailIdx } = windowOf(rows);
    let max = rows.length - 1;
    if (remaining > 0) max = listStart + win.length; // tail row
    listCursor = Math.min(Math.max(listCursor + delta, 0), Math.max(max, 0));
    if (focused === 'input') paintSuggest();
    else {
      // Pseudo-infinite scroll: arrowing DOWN onto the "load more" tail
      // auto-advances instead of parking there. Suggestions and UP moves
      // keep the old stop-and-confirm behavior.
      if (delta > 0 && remaining > 0 && listCursor === tailIdx) {
        advanceWindow();
        return;
      }
      paintList(true);
      if (ytMode && focused === 'links') {
        try {
          const link = highlightedLink();
          if (link && link.thumb && imageSupport() !== 'none') {
            const a = imageAnchor();
            if (a) showThumbnail(link.thumb, a).catch(() => {});
          } else if (link && link.thumb && detectGraphics() === 'iterm2') {
            const a = imageAnchor();
            if (a) showIterm2(link.thumb, a).catch(() => {});
          }
        } catch { /* preview is best-effort */ }
      }
    }
  }

  function advanceWindow() {
    // Next page in, previous page out.
    listStart += pageSize;
    listCursor = listStart;
    paintList(true);
  }

  // Transient image overlay: thumbnails are Kitty-direct writes that live
  // outside blessed's buffer (which strips ESC bytes). Unsupported
  // terminals get a recommendation message instead of silence.
  let imgSupport = null;
  function imageSupport() {
    if (imgSupport === null) imgSupport = detectImageSupport();
    return imgSupport;
  }
  function tryClearImages() {
    if (imageSupport() === 'none') return;
    clearImages();
  }
  // Resolve the highlighted row in links mode, excluding the tail row.
  function highlightedLink() {
    if (effFocus() !== 'links') return null;
    const { win } = windowOf(listLinks);
    if (listCursor >= listStart + win.length) return null;
    return listLinks[listCursor] || null;
  }
  // Absolute 1-based cell for the thumbnail overlay (top-right of body).
  function imageAnchor() {
    try {
      const lpos = body.lpos;
      if (!lpos) return null;
      const cols = 30;
      const rows = 16;
      return {
        row: Math.max(1, lpos.yi + 1),
        col: Math.max(1, lpos.xl - cols - 1),
        cols,
        rows,
      };
    } catch {
      return null;
    }
  }
  // Fire-and-forget: failures (no thumb, no support, fetch abort) leave
  // the list exactly as it was. Graphics terminals get a transient overlay;
  // plain terminals get ASCII art inline (works everywhere). Explicit Tab
  // presses always get an answer: overlay, art, or a flashed reason —
  // thumbnails never die silently. Returns status.
  function showThumbFor(link) {
    if (!link || !link.thumb) {
      try {
        if (typeof flashStatus === 'function') flashStatus('No thumbnail for this item');
      } catch { /* best effort */ }
      return 'no-thumb';
    }
    if (imageSupport() !== 'none') {
      const a = imageAnchor();
      if (!a) {
        try {
          if (typeof flashStatus === 'function') flashStatus('No anchor for thumbnail overlay');
        } catch { /* best effort */ }
        return 'no-anchor';
      }
      showThumbnail(link.thumb, a).catch(() => {
        try {
          if (typeof flashStatus === 'function') flashStatus('Thumbnail load failed');
        } catch { /* best effort */ }
      });
      return 'ok';
    }
    if (detectGraphics() === 'iterm2') {
      const a = imageAnchor();
      if (!a) return 'no-anchor';
      showIterm2(link.thumb, a).catch(() => {
        try {
          if (typeof flashStatus === 'function') flashStatus('Thumbnail load failed');
        } catch { /* best effort */ }
      });
      return 'ok';
    }
    // ASCII fallback: fetch + render as text under the list. Async — the
    // list stays put and the art appends when ready (stale-safe via cursor).
    // Without sharp there is no decoder at all: say so instead of the
    // generic terminal advice.
    try {
      let noDecoder = false;
      try {
        const { detectSharp } = require('./image');
        noDecoder = typeof detectSharp === 'function' && !detectSharp();
      } catch { /* assume decoder present */ }
      const cur = typeof body.getContent === 'function' ? body.getContent() : body.content || '';
      getImageAscii(link.thumb, { width: 48, maxHeight: 16 }).then((art) => {
        try {
          // A fullscreen digest owns the body (ALT+UP race): skip the
          // inline paint instead of wiping the AI view mid-read.
          if (aiExpanded) return;
          if (!art) {
            const why = noDecoder
              ? 'no image decoder: install sharp (npm i sharp) for thumbnails'
              : (recommendTerminal() || 'thumbnail fetch failed');
            body.setContent(`${cur}\n\n[thumb: ${escTags(link.title || link.thumb)}]\n${escTags(why)}`);
          } else {
            body.setContent(`${cur}\n\n[thumb: ${escTags(link.title || '')}]\n${art}`);
          }
          screen.render();
        } catch { /* best effort */ }
      }).catch(() => {});
    } catch {
      /* hint is best-effort */
    }
    return 'ok-ascii';
  }

  // Content-gallery: Tab cycles THIS page's images — graphics overlay on
  // Kitty/iTerm2, ASCII art inline on plain terminals (works everywhere).
  // Returns a status string: ok|ok-ascii|no-anchor|no-media.
  function showPageImage(dir) {
    const imgs = lastMedia && Array.isArray(lastMedia.images) ? lastMedia.images : [];
    if (imgs.length === 0) return 'no-media';
    mediaCursor = ((mediaCursor + (dir < 0 ? -1 : 1)) % imgs.length + imgs.length) % imgs.length;
    const img = imgs[mediaCursor];
    const label = (img.alt || '').trim() || img.src;
    if (imageSupport() !== 'none') {
      const a = imageAnchor();
      if (!a) return 'no-anchor';
      showThumbnail(img.src, a).catch(() => {});
      return 'ok';
    }
    if (detectGraphics() === 'iterm2') {
      const a = imageAnchor();
      if (!a) return 'no-anchor';
      showIterm2(img.src, a).catch(() => {});
      return 'ok';
    }
    try {
      showText();
      const cur = typeof body.getContent === 'function' ? body.getContent() : body.content || '';
      body.setContent(`${cur}\n\n[img ${mediaCursor + 1}/${imgs.length}: ${escTags(label)}]\n(loading art…)`);
      screen.render();
      getImageAscii(img.src, { width: 56, maxHeight: 20 }).then((art) => {
        try {
          // Same ALT+UP race as the thumb path above: never paint over
          // a fullscreen digest; the pane + overlay already updated.
          if (aiExpanded) return;
          const base = typeof body.getContent === 'function' ? body.getContent() : body.content || '';
          body.setContent(art ? `${base}\n${art}` : `${base}\n[no preview — ${escTags(recommendTerminal() || 'fetch failed')}]`);
          screen.render();
        } catch { /* best effort */ }
      }).catch(() => {});
    } catch {
      /* hint is best-effort */
    }
    return 'ok-ascii';
  }

  // ---- 60/40 image gallery ----
  // Tab (or gallery Enter / /img) splits the view: webview keeps the left
  // 60%, imgPane owns the right 40% and ONLY exists in this mode. Images
  // use the full pane width, stay centered, keep native aspect (single
  // Kitty dimension, never both). Every step clears the previous image
  // first, and stale async arrivals are dropped via galleryReq.

  function galleryPaneW() {
    return Math.max(20, Math.floor((screen.width || 80) * 0.4));
  }

  // Absolute pane geometry for overlay writes. Prefers live lpos, falls
  // back to screen estimates (tests / pre-layout / zeroed lpos).
  function galleryDims() {
    const sW = screen.width || 80;
    const sH = screen.height || 24;
    const paneW = galleryPaneW();
    let top = 5;
    let left = Math.max(0, sW - paneW);
    let height = Math.max(8, sH - 6);
    try {
      const lp = imgPane.lpos;
      if (
        lp && Number.isFinite(lp.xi) && Number.isFinite(lp.yi) &&
        Number.isFinite(lp.xl) && Number.isFinite(lp.yl) &&
        lp.xl - lp.xi >= 10 && lp.yl - lp.yi >= 6
      ) {
        left = Math.max(0, lp.xi);
        top = Math.max(1, lp.yi);
        height = Math.max(8, lp.yl - lp.yi);
      }
    } catch { /* estimates stand */ }
    return { top, left, width: paneW, height };
  }

  // Centered anchor + full-pane-width maxes for the overlay protocols.
  // Landscape fills the pane width (height auto = aspect kept); portrait
  // is height-capped and centered horizontally. Mirrors fitOverlay so the
  // estimate matches what the terminal actually renders.
  function galleryAnchor(pngW, pngH) {
    const d = galleryDims();
    const maxCols = Math.max(10, d.width - 2);
    // Title owns row 0; images start 2 lines below it so the title text
    // is never painted under. One row is kept for the hint at the bottom.
    const top = d.top + 3;
    const availH = Math.max(6, d.height - 4);
    const maxRows = Math.max(6, Math.min(40, availH));
    const landscape = !pngW || !pngH || pngW >= pngH;
    if (landscape) {
      const cols = maxCols;
      const estRows = pngW && pngH ? Math.max(1, Math.round((cols * pngH) / pngW / 2)) : 8;
      return {
        row: top + Math.max(0, Math.floor((availH - estRows) / 2)),
        col: d.left + 1,
        cols,
        rows: maxRows,
      };
    }
    const rows = maxRows;
    const estCols = Math.max(4, Math.round((rows * 2 * pngW) / pngH));
    const cols = Math.min(maxCols, estCols);
    const estRows = Math.max(1, Math.round((cols * pngH) / pngW / 2));
    return {
      row: top + Math.max(0, Math.floor((availH - estRows) / 2)),
      col: d.left + 1 + Math.max(0, Math.floor((d.width - 2 - cols) / 2)),
      cols,
      rows,
    };
  }

  function galleryTitle(label, idx, total, tag) {
    const t = tag || 'img';
    return truncateVisual(`[${t} ${idx + 1}/${total}: ${label}]`, Math.max(10, galleryPaneW() - 2));
  }

  function galleryHint(idx, total) {
    return truncateVisual(`Tab next · S-Tab prev · click next · Esc close (${idx + 1}/${total})`, Math.max(10, galleryPaneW() - 2));
  }

  // Center every art line inside the pane width. Pure visual centering —
  // the pixels are untouched, only left padding is added.
  function centerArt(art, width) {
    const w = Math.max(10, Number(width) || 10);
    return String(art || '')
      .split('\n')
      .map((ln) => `${' '.repeat(Math.max(0, Math.floor((w - [...ln].length) / 2)))}${ln}`)
      .join('\n');
  }

  function layoutGallery() {
    // The partition exists only while image browsing. Widths are set on
    // both the live property and options (headless/test-safe either way).
    // Open body is 60%-1: the 1-cell split divider owns the seam column.
    try {
      const w = galleryOpen ? '60%-1' : '100%';
      body.width = w;
      body.options.width = w;
      imgPane.hidden = !galleryOpen;
      paintSplitDiv();
    } catch { /* layout is best-effort */ }
  }

  async function renderGalleryImage(item, idx, total) {
    const isVideo = !!(item && item.kind === 'video');
    const src = (item && item.src) || '';
    if (!src || !galleryOpen) return 'no-media';
    // Rotation is per-photo: stepping to another image starts upright, a
    // repaint of the SAME photo (ctrl+r) keeps its angle.
    if (src !== galleryRotateSrc) { galleryRotateSrc = src; galleryRotate = 0; }
    const n = Math.max(1, Number(total) || 1);
    const pos = Number.isInteger(idx) ? idx : 0;
    const label = isVideo ? (item.title || src) : ((item.alt || '').trim() || src);
    const tag = isVideo ? 'VIDEO' : 'img';
    // Capability decided once per render: 'kitty' | 'iterm2' | 'ascii'.
    const mode = bestImageMode();
    const myReq = ++galleryReq;
    const finishOk = (v) => {
      // Newest fetch owns the loader: only clear when still current.
      settleGalleryLoad();
      try {
        if (myReq === galleryReq && galleryOpen) clearStatus();
      } catch { /* best effort */ }
      return v;
    };
    // Wave loader, delayed 250 ms so cached/instant fetches never flash
    // it (P3: the gallery gets the one loading animation too). The timer
    // and the hide are both owned by the newest request (galleryReq).
    let galleryTimer = null;
    function settleGalleryLoad() {
      try {
        if (galleryTimer) { clearTimeout(galleryTimer); galleryTimer = null; }
      } catch { /* best effort */ }
      try {
        if (galleryLoading && myReq === galleryReq) {
          galleryLoading = false;
          hideLoading();
        }
      } catch { /* best effort */ }
    }
    try {
      galleryTimer = setTimeout(() => {
        try {
          if (myReq === galleryReq && galleryOpen) {
            galleryLoading = true;
            showLoading('Loading image', `${pos + 1} of ${n}…`, label.slice(0, 80));
          }
        } catch { /* loader is best-effort */ }
      }, 250);
      if (galleryTimer && typeof galleryTimer.unref === 'function') {
        try { galleryTimer.unref(); } catch { /* keep ticking */ }
      }
    } catch { /* best effort */ }
    // Clear FIRST so no part of the old image survives the switch.
    try {
      clearImages();
    } catch { /* best effort */ }
    try {
      imgPane.setContent(`${escTags(galleryTitle(label, pos, n, tag))}\n\n${escTags('loading…')}`);
      screen.render();
    } catch { /* best effort */ }
    // Single-animation rule (P3): the wave loader above is the only
    // loading animation — no footer spinner alongside it. The pane keeps
    // its instant title + 'loading…' text; settle paths release the wave.
    let bytes = null;
    try {
      // cache:true — the overlay call below reuses these bytes for free.
      bytes = await fetchBytes(src, { cache: true });
    } catch {
      bytes = null;
    }
    if (myReq !== galleryReq || !galleryOpen) { settleGalleryLoad(); return 'stale'; }
    // Graphics terminals (Kitty/iTerm2): real image only. A failed fetch or
    // overlay becomes a plain pane message — never ASCII art. ASCII is the
    // fallback for terminals that cannot render images at all.
    if (mode !== 'ascii') {
      if (bytes && bytes.length > 0) {
        try {
          const png = await toDisplayPng(bytes);
          const size = (png && pngSize(png)) || null;
          // 90°/270° flips the aspect: size the box from the rotated dims.
          const swap = galleryRotate % 180 !== 0;
          const a = galleryAnchor(swap ? size && size.h : size && size.w, swap ? size && size.w : size && size.h);
          const ok = mode === 'iterm2'
            ? await showIterm2(src, { row: a.row, col: a.col, width: a.cols, height: a.rows, cache: true, rotate: galleryRotate })
            : await showThumbnail(src, { ...a, cache: true, rotate: galleryRotate });
          if (myReq !== galleryReq || !galleryOpen) { settleGalleryLoad(); return 'stale'; }
          if (ok) {
            try {
              imgPane.setContent(`${escTags(galleryTitle(label, pos, n, tag))}\n${escTags(galleryHint(pos, n))}`);
              screen.render();
            } catch { /* best effort */ }
            return finishOk('ok');
          }
        } catch { /* reported below, never ASCII */ }
      }
      try {
        imgPane.setContent(
          `${escTags(galleryTitle(label, pos, n, tag))}\n\n${escTags('Image could not be loaded')}\n${escTags(galleryHint(pos, n))}`
        );
        screen.render();
      } catch { /* best effort */ }
      return finishOk('unsupported');
    }
    // ASCII fallback, centered — works on every terminal without graphics.
    try {
      const art = await getImageAscii(src, {
        width: Math.max(16, galleryPaneW() - 4),
        maxHeight: Math.max(8, galleryDims().height - 4),
      });
      if (myReq !== galleryReq || !galleryOpen) { settleGalleryLoad(); return 'stale'; }
      try {
        if (art) {
          imgPane.setContent(
            `${escTags(galleryTitle(label, pos, n, tag))}\n\n${centerArt(escTags(art), galleryPaneW())}\n${escTags(galleryHint(pos, n))}`
          );
        } else {
          imgPane.setContent(
            `${escTags(galleryTitle(label, pos, n, tag))}\n\n${escTags(recommendTerminal() || 'could not load image')}\n${escTags(galleryHint(pos, n))}`
          );
        }
        try {
          imgPane.scrollTo(0);
        } catch { /* tiny panes */ }
        screen.render();
      } catch { /* best effort */ }
      return finishOk(art ? 'ok-ascii' : 'unsupported');
    } catch {
      settleGalleryLoad();
      try {
        if (myReq === galleryReq && galleryOpen) clearStatus();
      } catch { /* best effort */ }
      return 'unsupported';
    }
  }

  // Video in the split: the poster (graphics) or its ASCII art (plain
  // terms), with a [VIDEO] tag and "Enter plays in mpv". Never throws.
  function renderVideoPane(item, idx, total) {
    const n = Math.max(1, Number(total) || 1);
    const pos = Number.isInteger(idx) ? idx : 0;
    const title = String((item && item.title) || (item && item.src) || 'video').slice(0, 80);
    const poster = item && item.poster ? item.poster : item.src;
    const head = `[VIDEO ${pos + 1}/${n}: ${title}]`;
    const hint = `Enter plays in mpv · Tab next · Esc close (${pos + 1}/${n})`;
    const mode = bestImageMode();
    const myReq = ++galleryReq;
    let galleryTimer = null;
    const settle = () => {
      try { if (galleryTimer) { clearTimeout(galleryTimer); galleryTimer = null; } } catch { /* best effort */ }
      try { if (galleryLoading && galleryReq === myReq) { galleryLoading = false; hideLoading(); } } catch { /* best effort */ }
    };
    try {
      galleryTimer = setTimeout(() => {
        try {
          if (galleryReq === myReq && galleryOpen) {
            galleryLoading = true;
            showLoading('Loading video', `${pos + 1} of ${n}…`, title.slice(0, 80));
          }
        } catch { /* loader is best-effort */ }
      }, 250);
      if (galleryTimer && galleryTimer.unref) galleryTimer.unref();
    } catch { /* best effort */ }
    try { clearImages(); } catch { /* best effort */ }
    // Graphics terminals: real poster only — failure is a plain pane line,
    // never ASCII art. ASCII is the fallback for no-graphics terminals.
    if (mode !== 'ascii') {
      const a = imageAnchor();
      if (!a) {
        settle();
        try {
          imgPane.setContent(`${escTags(galleryTitle(head, pos, n, 'VIDEO'))}\n\n${escTags('Poster unavailable')}\n${escTags(hint)}`);
          screen.render();
        } catch { /* best effort */ }
        return 'unsupported';
      }
      try {
        imgPane.setContent(`${escTags(galleryTitle(head, pos, n, 'VIDEO'))}\n\n${escTags('loading…')}`);
        screen.render();
      } catch { /* best effort */ }
      const p = mode === 'iterm2' ? showIterm2(poster, a) : showThumbnail(poster, a);
      p.then((ok) => {
        if (galleryReq !== myReq || !galleryOpen) { settle(); return; }
        settle();
        try {
          if (ok) {
            imgPane.setContent(`${escTags(galleryTitle(head, pos, n, 'VIDEO'))}\n${escTags(hint)}`);
          } else {
            imgPane.setContent(`${escTags(galleryTitle(head, pos, n, 'VIDEO'))}\n\n${escTags('Poster unavailable')}\n${escTags(hint)}`);
          }
          screen.render();
        } catch { /* best effort */ }
      }).catch(() => { settle(); });
      return 'ok';
    }
    // ASCII fallback for the poster (terminals without graphics only).
    try {
      showText();
      const cur = typeof body.getContent === 'function' ? body.getContent() : body.content || '';
      body.setContent(`${cur}\n\n${escTags(head)}\n(loading art…)`);
      screen.render();
      getImageAscii(poster, { width: Math.max(16, galleryPaneW() - 4), maxHeight: Math.max(8, galleryDims().height - 4) }).then((art) => {
        try {
          if (aiExpanded) return;
          const base = typeof body.getContent === 'function' ? body.getContent() : body.content || '';
          body.setContent(art ? `${base}\n${art}` : `${base}\n[no preview — ${escTags(recommendTerminal() || 'fetch failed')}]`);
          screen.render();
        } catch { /* best effort */ }
      }).catch(() => {});
    } catch { /* hint is best-effort */ }
    return 'ok-ascii';
  }

  // The 60/40 media pane: one combined list of this page's images AND videos.
  // Images render as real graphics when the terminal supports them (ASCII is
  // the no-graphics fallback); videos show their poster with a [VIDEO] tag.
  // Returns 'ok'|'ok-ascii'|'no-media'|'unsupported'.
  function renderMedia(idx) {
    const list = mediaList();
    if (list.length === 0 || !galleryOpen) return Promise.resolve('no-media');
    const n = list.length;
    mediaCursor = ((idx % n) + n) % n;
    const m = list[mediaCursor];
    mediaKind = m.kind;
    if (m.kind === 'video') return Promise.resolve(renderVideoPane(m, mediaCursor, n));
    const imgs = lastMedia && Array.isArray(lastMedia.images) ? lastMedia.images : [];
    const pos = imgs.findIndex((im) => im && im.src === m.src);
    return renderGalleryImage(m, pos >= 0 ? pos : mediaCursor, n);
  }

  function openGallery(idx, opts = {}) {
    const list = mediaList();
    if (list.length === 0) return 'no-media';
    closeTheater();
    const keepSnapshot = !!(opts && opts.keepSnapshot);
    galleryReturn = focused === 'links' || focused === 'content' ? focused : 'content';
    // Coming from the article: remember it so Esc/Tab-out returns to the
    // exact page instead of a blank content view. Returning from the image
    // fullscreen re-opens the pane with the page already restored — keep
    // the snapshot from the first open (never re-capture leftovers).
    if (galleryReturn === 'content' && !keepSnapshot) snapshotContentView();
    galleryOpen = true;
    // The split owns the screen: the search digest bar yields while the
    // pane is open (its text is kept and returns with the list view).
    summaryVisible = false;
    layoutGallery();
    layoutBody();
    // Tab into images re-measures boxes to the narrowed webview and the
    // repaint stays (later Tabs only swap the picture, never the body).
    try {
      if (focused === 'content' && lastPretty) paintPretty();
    } catch { /* gallery still opens */ }
    updateHint();
    screen.render();
    const at = Number.isInteger(idx) ? idx : 0;
    renderMedia(at).catch(() => {});
    return 'ok';
  }

  function closeGallery() {
    if (!galleryOpen) return false;
    galleryOpen = false;
    galleryReq++;
    try {
      if (galleryLoading) { galleryLoading = false; hideLoading(); }
    } catch { /* never strand the wave */ }
    try {
      clearImages();
    } catch { /* best effort */ }
    try { clearStatus(); } catch { /* footer must return to hint */ }
    layoutGallery();
    if (galleryReturn === 'links' && listLinks.length > 0) {
      setFocus('links');
      paintList(true);
    } else if (contentSnapshot) {
      restoreContentView();
    } else {
      setFocus('content');
      showText();
    }
    updateHint();
    return true;
  }

  function galleryStep(dir) {
    if (!galleryOpen) {
      const list = mediaList();
      if (list.length === 0) return 'no-media';
      // First Tab opens at the near end for the direction of travel.
      return openGallery(dir < 0 ? list.length - 1 : 0);
    }
    renderMedia(mediaCursor + (dir < 0 ? -1 : 1)).catch(() => {});
    return 'ok';
  }

  function openGalleryByUrl(url) {
    try {
      const list = mediaList();
      const idx = list.findIndex((m) => m && m.src === url);
      if (idx < 0) return 'no-media';
      return openGallery(idx);
    } catch {
      return 'no-media';
    }
  }

  function isGalleryOpen() {
    return !!galleryOpen;
  }

  // ---- 60/40 YouTube theater ----
  // Watch pages split automatically: player info keeps the left 60%, the
  // related rail owns the right 40%. Same partition rules as the image
  // gallery (Esc-only existence, mutual exclusion), but rows are picked
  // video titles and Enter plays in mpv instead of rendering.
  const theaterPane = makeBox({
    parent: inner,
    top: 4,
    left: '60%',
    width: '40%',
    bottom: 1,
    content: '',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    autoFocus: false,
    hidden: true,
    style: { fg: theme.fg, ...themedBg() },
  });
  theaterPane.on('click', (data) => {
    focusField();
    if (theaterOpen) theaterClick(data);
  });

  let theaterOpen = false;
  let theaterList = [];
  let theaterCursor = 0;

  function theaterPaneW() {
    return Math.max(20, Math.floor((screen.width || 80) * 0.4));
  }

  function layoutTheater() {
    // Same 60/40 geometry contract as layoutGallery; exactly one right
    // pane is ever visible (open functions enforce exclusion).
    try {
      const w = theaterOpen ? '60%-1' : '100%';
      body.width = w;
      body.options.width = w;
      theaterPane.hidden = !theaterOpen;
      paintSplitDiv();
    } catch { /* layout is best-effort */ }
  }

  function paintTheater() {
    if (!theaterOpen) return;
    try {
      const w = theaterPaneW();
      const lines = [
        `Up next (${theaterList.length})`,
        'Enter play · Esc close',
        '',
      ];
      theaterList.forEach((r, i) => {
        const label = truncateVisual(`${r.title || ''}`, Math.max(10, w - 4));
        lines.push(`${i === theaterCursor ? '> ' : '  '}${escTags(label)}`);
      });
      if (theaterList.length === 0) lines.push('(no related videos)');
      theaterPane.setContent(lines.join('\n'));
      try {
        theaterPane.scrollTo(Math.max(0, theaterCursor));
      } catch { /* tiny panes */ }
      screen.render();
    } catch { /* best effort */ }
  }

  function openTheater(rows) {
    const list = (Array.isArray(rows) ? rows : []).map(safeRow).filter((r) => r && r.url);
    if (list.length === 0) return 'no-related';
    closeGallery();
    theaterList = list.slice(0, 20);
    theaterCursor = 0;
    theaterOpen = true;
    layoutTheater();
    // Same re-measure as the gallery split: boxes fit the narrowed webview.
    try {
      if (focused === 'content' && lastPretty) paintPretty();
    } catch { /* theater still opens */ }
    updateHint();
    paintTheater();
    screen.render();
    return 'ok';
  }

  function closeTheater() {
    if (!theaterOpen) return false;
    theaterOpen = false;
    theaterList = [];
    theaterCursor = 0;
    layoutTheater();
    if (focused === 'content') {
      if (contentSnapshot) restoreContentView();
      else showText();
    }
    updateHint();
    return true;
  }

  function theaterMove(delta) {
    if (!theaterOpen || theaterList.length === 0) return 'closed';
    theaterCursor = Math.min(theaterList.length - 1, Math.max(0, theaterCursor + (dirSafe(delta))));
    paintTheater();
    return 'ok';
  }

  function dirSafe(d) {
    const n = Number(d);
    return n < 0 ? -1 : 1;
  }

  function theaterPlay() {
    if (!theaterOpen) return false;
    const row = theaterList[theaterCursor] || null;
    if (!row || !row.url) return false;
    // Same 1s dupe guard as confirmLinkList: key-repeat must not spawn
    // a stack of mpv windows.
    try {
      const now = Date.now();
      if (lastConfirm.url === row.url && now - lastConfirm.at < 1000) return true;
      lastConfirm = { url: row.url, at: now };
    } catch { /* guard is best-effort */ }
    // Only the pick is handed off: the queue holds user picks only,
    // never the rest of the list (unselected videos in /queue = bug).
    if (onPlayVideo) onPlayVideo(row.url, [], row.title);
    return true;
  }

  function theaterClick(data) {
    try {
      if (!data || !theaterOpen) return;
      const base = theaterPane.lpos ? theaterPane.lpos.yi : 0;
      const y = typeof data.y === 'number' ? data.y - base : -1;
      if (y < 0) return;
      let scroll = 0;
      try {
        const h = theaterPane.height || 10;
        scroll = theaterPane.getScrollHeight() <= h ? 0 : Math.max(0, theaterPane.childBase || 0);
      } catch { /* top */ }
      const idx = y - 3 + scroll; // 3 header lines above the rows
      if (idx < 0 || idx >= theaterList.length) return;
      theaterCursor = idx;
      paintTheater();
    } catch { /* best effort */ }
  }

  function isTheaterOpen() {
    return !!theaterOpen;
  }

  // Watch-page pattern (youtube.com/watch|embed|shorts, youtu.be, music):
  // Tab previews its thumbnail, Enter plays that SAME video in mpv.
  // Same rule on every site — video rows always play, image rows show.
  const WATCH_URL = /(youtube\.com\/(watch|embed|shorts)|youtu\.be\/|music\.youtube\.com)/i;
  const DIRECT_MEDIA = /\.(mp4|webm|mov|m4v|mkv|avi|m3u8|mpd)(\?|#|$)/i;

  function confirmLinkList() {
    if (focused !== 'links') return;
    const link = highlightedLink();
    if (!link) {
      advanceWindow();
      return;
    }
    // Single-flight: terminal key-repeat / bubbled keypress+submit used to
    // fire Enter twice -> 2x mpv windows. Same URL within 1s is a dupe.
    const now = Date.now();
    if (lastConfirm.url === link.url && now - lastConfirm.at < 1000) return;
    lastConfirm = { url: link.url, at: now };
    // Queue rows (/queue picker): Enter PLAYS that item now — the running
    // player jumps to it (single player, the old stream swaps out).
    if (link.queue && link.url && typeof onPlayQueue === 'function') {
      onPlayQueue(link.url);
      return;
    }
    // YT fast-list: Enter/Space always plays in mpv, never navigates to
    // watch-page text. Same video Tab previews. ONLY the pick is handed
    // off — the rest of the list never lands in the queue uninvited.
    if (ytMode) {
      if (link.url && onPlayVideo) {
        onPlayVideo(link.url, [], link.title);
        return;
      }
      showText();
      onLinkPick(link.url);
      return;
    }
    // Videos first: Enter plays the same video Tab just previewed.
    // Covers /videos rows, YouTube/music search + watch URLs, embeds.
    if (link.video || (link.url && WATCH_URL.test(link.url))) {
      if (link.url && onPlayVideo) {
        showText();
        onPlayVideo(link.url, [], link.title);
        return;
      }
    }
    // Images AND videos: Enter opens the 60/40 media pane (picture or video
    // poster with a [VIDEO] tag). Thumbs that are not page media keep the
    // old overlay preview.
    if (link.thumb && link.url && !WATCH_URL.test(link.url)) {
      try {
        if (openGalleryByUrl(link.url) === 'ok') return;
        const st = showThumbFor(link);
        if (st === 'ok' || st === 'ok-ascii') return;
      } catch { /* fall through to navigation */ }
    }
    if (link.url && /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i.test(link.url)) {
      try {
        const st = openGalleryByUrl(link.url);
        if (st === 'ok') return;
      } catch { /* fall through */ }
    }
    showText();
    onLinkPick(link.url);
  }

  // Reachable video handoff: most terminals (Konsole default included)
  // cannot send a distinct Shift+Enter, so /play covers the same path.
  // Returns true when a video was handed off.
  function playHighlightedVideo() {
    if (effFocus() !== 'links') return false;
    const link = highlightedLink();
    if (!link || !link.url) return false;
    if (onPlayVideo) onPlayVideo(link.url, [], link.title);
    return true;
  }

  function showLinkPicker(links, ai, summary, opts) {
    // Overlay pickers (/bookmarks, /history) snapshot the view underneath so
    // Esc returns to it; a page-level picker (real search results) owns the
    // screen: any split image/theater pane closes for good (it belonged to
    // the page the user just left) and no stale snapshot resurrects it.
    const overlay = !!(opts && opts.overlay);
    if (overlay) {
      snapshotMediaSplit();
      snapshotContentView();
    } else {
      clearContentView();
      clearMediaSplit();
      closeGallery();
      closeTheater();
    }
    ytMode = false;
    ytQuery = '';
    lastPretty = null;
    listHeading = String((opts && opts.heading) || '');
    listLinks = (Array.isArray(links) ? links : []).map(safeRow).filter(Boolean);
    lastLinks = listLinks;
    lastAi = String(ai || '').trim().slice(0, 8000);
    lastAiModel = ''; // a page AI card has no model label
    lastSummary = String(summary || '').trim().slice(0, 24000);
    // The bottom AI box shows the REAL answer (a page AI card here, then the
    // async LLM reply via setAiAnswer). The extractive digest is no longer
    // displayed anywhere.
    summaryVisible = !!lastAi;
    aiExpanded = false;
    fillStalled = false;
    listCursor = 0;
    listStart = 0;
    if (listLinks.length === 0) return false;
    setFocus('links');
    paintList(true);
    return true;
  }

  // Search AI answer (async): a real LLM answer for a question-shaped
  // query lands here after the results already painted, and OWNS the bottom
  // AI box. The thinking placeholder and the honest error share the same
  // box. Late arrivals never yank the cursor — paintList preserves
  // cursor/window — and cross-page bleed is stopped by the caller's token.
  function setAiAnswer(text, opts) {
    // Real content (answer or error) always replaces the placeholder:
    // stop the thinking dots no matter what lands here.
    stopAiThinking();
    try {
      if (!listLinks.length) return; // not on a results list: ignore
      lastAi = String(text || '').trim().slice(0, 8000);
      // Only a real answer carries a model label; hints/errors/placeholders
      // show the plain title.
      lastAiModel = (opts && opts.model) ? String(opts.model).trim() : '';
      summaryVisible = !!lastAi; // the bottom box owns whatever this is
      if (aiExpanded) paintAiFullscreen();
      else paintList(true);
    } catch { /* answer paint is best-effort */ }
  }
  // Animated "thinking" placeholder (shared anim ticker): the dots travel
  // while a model call is in flight and stop the instant real content
  // replaces the box. The ticker starts with the first subscriber and
  // clears itself when the last one leaves — zero timers at rest.
  const uiTicker = anim.createTicker();
  let aiThinkStop = null;
  function stopAiThinking() {
    if (aiThinkStop) {
      try { aiThinkStop(); } catch { /* best effort */ }
      aiThinkStop = null;
    }
  }
  function paintThinking(frame) {
    try {
      lastAi = `▍ thinking${anim.dots(frame)}`;
      lastAiModel = '';
      summaryVisible = true; // the bottom box owns whatever this is
      if (aiExpanded) paintAiFullscreen();
      else if (listLinks.length) paintList(true);
      else paintAiBar();
    } catch { /* placeholder paint is best-effort */ }
  }
  function startAiThinking() {
    stopAiThinking();
    try {
      aiThinkStop = uiTicker.add((frame) => paintThinking(frame), 400);
    } catch { aiThinkStop = null; }
    paintThinking(0);
  }
  function setAiAnswerPending() {
    startAiThinking();
  }
  function setAiAnswerError(err) {
    setAiAnswer(`AI answer failed: ${String(err || 'unknown error').trim().slice(0, 500)}`);
  }

  function renderSpans(spans) {
    const parts = [];
    let prevUrl = null;
    let inLink = false;
    let linkBuffer = '';
    let linkUrl = null;

    // Reset content link tracking
    contentLinkLines = [];

    let lineIndex = 0;
    for (const s of spans || []) {
      const t = escTags(sanitizeLine(s.t));
      if (!t) continue;
      const isLink = !!s.url;

      if (isLink) {
        if (prevUrl === s.url) {
          // Continuation of same link
          linkBuffer += ' ' + t;
        } else {
          // Flush previous link buffer
          if (inLink && linkBuffer) {
            parts.push(`{underline}${linkBuffer}{/}`);
            // Track this line as a link
            contentLinkLines.push({ line: lineIndex, url: linkUrl, text: linkBuffer });
            lineIndex++;
          }
          inLink = true;
          linkUrl = s.url;
          linkBuffer = t;
        }
      } else {
        // Flush any pending link
        if (inLink && linkBuffer) {
          parts.push(`{underline}${linkBuffer}{/}`);
          // Track this line as a link
          contentLinkLines.push({ line: lineIndex, url: linkUrl, text: linkBuffer });
          lineIndex++;
          linkBuffer = '';
          inLink = false;
          linkUrl = null;
        }
        parts.push(inlineMd(t));
        lineIndex++;
      }
      prevUrl = isLink ? s.url : null;
    }

    // Flush any remaining link
    if (inLink && linkBuffer) {
      parts.push(`{underline}${linkBuffer}{/}`);
      contentLinkLines.push({ line: lineIndex, url: linkUrl, text: linkBuffer });
    }

    // Join with single newlines, but collapse multiple newlines
    let content = parts.join('\n');
    // Collapse 3+ newlines to 2
    content = content.replace(/\n{3,}/g, '\n\n');
    body.setContent(content || '(no content)');
    scrollBodyTo(0);
  }

  function showText() {
    setFocus('content');
    if (lastPretty && paintPretty()) return;
    if (lastSpans && lastSpans.length > 0) {
      renderSpansBody();
      return;
    }
    body.setContent(formatText(escTags(lastText)) || '(nothing open — type to search)');
    scrollBodyTo(0);
  }

  // Article text path: full markdown-lite rendering (headings, lists,
  // quotes, code, tables, emphasis) via beautify.js. Input is already
  // escTags-escaped; blockMd only ADDS real blessed tags.
  function formatText(text) {
    if (!text) return '';
    try {
      return blockMd(String(text)) || '(nothing open — type to search)';
    } catch {
      return String(text) || '(nothing open — type to search)';
    }
  }

  function renderSpansBody() {
    setFocus('content');
    renderSpans(lastSpans);
  }

  function isPickerOpen() {
    return focused === 'links';
  }

  function startFreshSearch() {
    // `/` works from everywhere. Snapshot the page AND any open media split
    // first — suggestions paint over the split, and Esc (or the command
    // finishing) must bring it back. Do NOT close the split here: that made
    // the image vanish before /download.
    // BUGFIX (double-slash): the first `/` was swallowed to clear the bar,
    // forcing a second `/` to actually type it. Seed `/` directly so one
    // keypress opens the command palette.
    snapshotMediaSplit();
    snapshotCommandView();
    if (aiExpanded) collapseAi();
    omni.setValue('/');
    setFocus('input');
    listCursor = 0;
    listStart = 0;
    const id = ++suggestSeq;
    onSuggest('/', id);
    focusField();
    screen.render();
  }

  // --- Focus management: Esc is one step back, idempotent ---
  // The open gallery pane always collapses first — Esc never strands the
  // 60/40 split on screen. Single owner: index.js must NOT also bind Esc
  // (double-fire clobbered every restore with showText).
  // Returns true when something was dismissed.
  let lastEscAt = 0;
  function resetFocus() {
    const now = Date.now();
    // Idempotency: a second Esc within 60ms (double-delivery) is a no-op.
    if (now - lastEscAt < 60) return true;
    lastEscAt = now;
    // A media split a command closed comes back on Esc if no page was painted.
    const pageBeforeEsc = pageSeq;
    if (themeState.open) {
      closeThemes();
      return true;
    }
    if (closeGallery()) return true;
    if (closeTheater()) return true;
    if (aiExpanded) {
      collapseAi();
      return true;
    }
    if (focused === 'form') {
      // Wizard cancel: force-exit even if the step callback swallows null.
      // The callback still runs first so the wizard can clean up its draft.
      try {
        const cb = formState && formState.callback;
        formState.callback = null;
        if (cb) { try { cb(null); } catch { /* wizard cleanup */ } }
      } catch { /* best effort */ }
      try { if (omni) omni.censor = false; } catch { /* best effort */ }
      formState = { step: null, email: '', password: '', callback: null };
      try { omni.setValue(''); } catch { /* best effort */ }
      // Back to the page underneath (or blank input when idle).
      if (cmdSnapshot) { restoreCommandView(); return true; }
      setFocus('content');
      try { showText(); } catch { /* best effort */ }
      return true;
    }
    if (focused === 'input') {
      // Cancelling a command restores the snapshotted page; only an
      // already-empty bar with no snapshot falls through.
      if (cmdSnapshot) {
        restoreCommandView();
        try { omni.setValue(''); } catch { /* bar cleared with palette */ }
        return true;
      }
      if (omni.getValue()) {
        omni.setValue('');
        const id = ++suggestSeq;
        onSuggest('', id);
      }
      return true;
    }
    if (focused === 'links' || focused === 'content') {
      // One step back to the article text (links -> article). When an
      // overlay view is open over the page (bookmarks/history picker, the
      // gallery pane), restore the page exactly instead of repainting it.
      if (contentSnapshot) { restoreContentView(); return true; }
      try { showText(); } catch { /* best effort */ }
      return true;
    }
    // A command closed a media split over a page; Esc brings it back.
    if (pageSeq === pageBeforeEsc && restoreMediaSplit()) return true;
    return false;
  }

  function cancelFormSilent() {
    // Shared wizard-exit used by the form Esc path: callback already ran.
    try { if (omni) omni.censor = false; } catch { /* best effort */ }
    formState = { step: null, email: '', password: '', callback: null };
    try { omni.setValue(''); } catch { /* best effort */ }
    if (cmdSnapshot) { try { restoreCommandView(); } catch { /* best effort */ } return; }
    setFocus('content');
    try { showText(); } catch { /* best effort */ }
  }

  // Single-owner key router. The omnibox keeps DOM focus throughout, so
  // typing works in every mode; arrows are inert in single-line fields.

  // Text editing: owns all character input in input/form modes.
  // We own it because blessed's readInput is one-shot and tears down on
  // every Enter/Esc, which previously broke the bar permanently.
  function editText(ch, key) {
    if (focused !== 'input' && focused !== 'form') return false;
    const k = key || {};
    if (k.ctrl || k.meta) return false;
    // Deletion arrives without a printable char (blessed reports backspace
    // with ch undefined on most terminals), so match it by key name BEFORE
    // the character guards below — otherwise this branch is unreachable and
    // the key falls through to a pointless suggest refresh. `delete` maps
    // to the same action: the bar has no cursor API, end-of-text only.
    if (k.name === 'backspace' || k.name === 'delete') {
      const val = omni.getValue();
      if (val.length > 0) {
        // Code-point-aware: slice() on UTF-16 units would halve a
        // surrogate pair (emoji) and plant a lone surrogate in the bar.
        omni.setValue([...val].slice(0, -1).join(''));
        if (focused === 'input') scheduleSuggest();
        if (focused === 'form') paintForm();
        // Live bar: paint NOW, never wait on the suggest round-trip.
        screen.render();
        showCaret();
      }
      return true;
    }
    // Printable (possibly multi-char: paste/IME commit), including space.
    if (!printableStr(ch)) return false;
    omni.setValue(omni.getValue() + ch);
    if (focused === 'input') scheduleSuggest();
    if (focused === 'form') paintForm();
    // Live bar: paint NOW, never wait on the suggest round-trip.
    screen.render();
    showCaret();
    return true;
  }

  // Type-to-search from anywhere: the char did NOT land in the field
  // (native insertion is off — we never use readInput), so start a fresh
  // query with just this char. Replacing (not appending) is deliberate: the
  // bar usually holds a stale URL out here, and appending would produce a
  // garbage query the user must backspace away. `/` is handled by callers
  // that want a fresh empty bar instead.
  function acceptTypedChar(ch) {
    if (!ch || ch === ' ' || !printableStr(ch)) return false;
    // Fresh typing replaces any open split (gallery or theater).
    closeGallery();
    closeTheater();
    setFocus('input');
    omni.setValue(ch);
    screen.render();
    showCaret();
    scheduleSuggest();
    return true;
  }

  // Single-owner key router. The omnibox keeps DOM focus throughout, so
  // typing works in every mode; arrows are inert in single-line fields.
  // CR delivers TWO keypresses (enter then return); LF delivers linefeed.
  // We normalize to a single Enter and dedupe the twin so one physical
  // press acts exactly once (P0-2). Esc is owned here only (index.js must
  // not also bind it, or every restore is clobbered).
  let lastEnterAt = 0;
  let lastEnterKind = '';
  function isEnterKey(ch, key) {
    const nm = (key && key.name) || '';
    if (nm === 'linefeed') return true; // \n terminals
    if ((key && key.full) === 'enter' || nm === 'enter' || nm === 'kpenter') return true;
    if (nm === 'return' || (key && key.full) === '\r' || ch === '\r') return true;
    return false;
  }
  screen.on('keypress', (ch, key) => {
    if (!key) return;
    // Quit lives on Ctrl+Q and /quit only: bare `q`/`Q` always types
    // (type-to-search), never quits — a query starting with "q" must not
    // kill the app. Ctrl+C is also a quit hatch (terminal convention).
    if (key.ctrl && (key.name === 'q' || ch === '\x11')) {
      onQuit();
      return;
    }
    // Modal choice (quit prompt) owns the keys while it is open: 1..4 picks,
    // Esc cancels. Everything else is swallowed so the modal cannot be
    // navigated around.
    if (choiceState) {
      if (key.full === 'escape') {
        const cb = choiceState.callback;
        choiceState = null;
        try { showText(); } catch { /* best effort */ }
        if (cb) { try { cb(null); } catch { /* best effort */ } }
        return;
      }
      const num = Number(ch);
      if (Number.isInteger(num) && num >= 1 && num <= choiceState.options.length) {
        const pickIdx = num - 1;
        const cb = choiceState.callback;
        choiceState = null;
        try { showText(); } catch { /* best effort */ }
        if (cb) { try { cb(pickIdx); } catch { /* best effort */ } }
        return;
      }
      return;
    }
    // Normalize Enter + dedupe the CR twin. Only the second half of a CR
    // (`return` after `enter`) is the same physical press and is swallowed.
    // The gap is not tiny: while the first navigation launches Chrome,
    // blessed delivers the return half up to ~300ms after the enter half
    // (measured on the first search), so the window has to span the whole
    // trailing press. A bare `return` never arrives on its own — only as
    // the twin half of a `\r` — so a wide window can't swallow a real
    // second press: that one always starts with a fresh `enter`.
    if (isEnterKey(ch, key)) {
      const now = Date.now();
      const kind = (key && key.name) || 'enter';
      if (kind === 'return' && lastEnterKind === 'enter' && (now - lastEnterAt) < 1500) {
        // Twin half — swallow.
        return;
      }
      lastEnterAt = now;
      lastEnterKind = kind;
      // Rewrite linefeed/return to enter shape for the branches below.
      try {
        key = { ...key, name: 'enter', full: (key && key.full && String(key.full).includes('S-')) ? 'S-enter' : 'enter' };
      } catch { /* shape is best-effort */ }
    } else {
      // A non-enter key clears the twin window only once the swallow
      // window has fully lapsed, so a key typed between the halves of a
      // slow CR twin can still not split one press into two.
      try {
        if (Date.now() - lastEnterAt > 1600) lastEnterKind = '';
      } catch { /* best effort */ }
    }
    // The arcade owns the keys while it is open: a modal like the choice
    // prompt. Steer/fire/nudge stay inside; Esc restores what was
    // underneath; `/` and any other typing escape into normal routing.
    if (gameState.open) {
      const g = gameState.game;
      if (key.full === 'escape') {
        closeGame();
        return;
      }
      if (ch === '/') {
        closeGame();
        startFreshSearch();
        return;
      }
      if (gameState.kind === 'pong') {
        const pg = pong();
        const ph = g && g.phase;
        const waiting = ph === 'matchwon' || ph === 'matchlost' || ph === 'reset';
        const up = key.name === 'up' || ch === 'k' || ch === 'K' || ch === 'w' || ch === 'W';
        const down = key.name === 'down' || ch === 'j' || ch === 'J' || ch === 's' || ch === 'S';
        const confirm = key.name === 'enter' || key.name === 'space' || ch === ' ';
        if (waiting) {
          // Between matches any play key continues, so the run never
          // stalls on a key the user hasn't learned yet.
          if (up || down || confirm) {
            if (pg.continueGame(g)) paintGame();
            return;
          }
        } else {
          if (up) {
            if (pg.nudge(g, -1)) paintGame();
            return;
          }
          if (down) {
            if (pg.nudge(g, 1)) paintGame();
            return;
          }
          if (confirm) return; // absorbed: the table is modal
        }
        if (ch === 'r' || ch === 'R') {
          pg.restartRun(g);
          paintGame();
          return;
        }
      } else {
        // The piano: the eight lane keys are the instrument. press() is
        // the judge — a ball near the line scores perfect/great/good, free
        // play answers every press with its note — and every sounding
        // press plays through the speaker (gameAudio, best-effort). m
        // mutes, p swaps free ↔ songs, digits 1-9 (0 = tenth) pick a song,
        // * random songs, r restarts.
        const kb = piano();
        const lane = String(ch || '').toLowerCase();
        const idx = lane.length === 1 ? kb.KEYS.indexOf(lane) : -1;
        if (idx >= 0) {
          const judge = kb.press(g, idx);
          if (judge) {
            try {
              const au = gameAudio();
              if (au) au.play(idx, judge === 'perfect' || judge === 'note');
            } catch { /* sound is best-effort */ }
            paintGame();
          }
          return;
        }
        if (ch === 'm' || ch === 'M') {
          try {
            const au = gameAudio();
            if (au) au.setMuted(!au.isMuted());
          } catch { /* mute is best-effort */ }
          paintGame();
          return;
        }
        if (ch === 'p' || ch === 'P') {
          setPianoMode(!(g && g.free));
          return;
        }
        if (/^[1-9]$/.test(ch) || ch === '0') {
          gameState.free = false; // digits pick a song; 0 is the tenth
          kb.selectSong(g, ch === '0' ? 9 : Number(ch) - 1);
          paintGame();
          return;
        }
        if (ch === '*') {
          gameState.free = false; // random mode plays songs: it leaves free play
          kb.toggleRandom(g);
          paintGame();
          return;
        }
        if (key.name === 'enter' && g && g.over) {
          kb.restart(g);
          paintGame();
          return;
        }
        if (ch === 'r' || ch === 'R') {
          kb.restart(g);
          paintGame();
          return;
        }
        if (key.name === 'space' || ch === ' ') return; // absorbed: the piano is modal
      }
      if (printable(ch) || (printableStr(ch) && !String(ch).includes(' '))) {
        closeGame();
        if (acceptTypedChar(ch)) return;
        return;
      }
      return; // up/down/enter/tab are absorbed: the arcade is modal
    }
    // Text editing first: consume printable/backspace in input/form modes.
    if (editText(ch, key)) return;
    // Alt+Left / Alt+Right = back / forward EVERYWHERE (incl. while typing
    // in the bar). Terminals report it as meta, M- prefix, or xterm
    //CSI `;3` modifier — accept all three so it works across Konsole/Kitty/xterm.
    {
      const seq = (key && key.sequence) || '';
      const full = (key && key.full) || '';
      const isAlt = !!(key && (key.meta || key.alt)) || full.indexOf('M-') === 0 || /;3[ABCD]/.test(seq) || seq.indexOf('\x1b\x1b[') === 0;
      if (isAlt && (key.name === 'left' || key.name === 'right')) {
        if (key.name === 'left') onHistoryBack();
        else onHistoryForward();
        return;
      }
      // Alt+Up shows the REAL AI answer fullscreen (the same text the bottom
      // box holds); Alt+Down / Esc collapse. On articles Alt+Up asks the LLM
      // to summarize the page.
      if (isAlt && (key.name === 'up' || key.name === 'down')) {
        if (key.name === 'down') {
          collapseAi();
          return;
        }
        if (aiExpanded) {
          collapseAi();
          return;
        }
        if (focused === 'links') {
          // Only the real answer (LLM reply / page AI card / key hint) opens
          // — the extractive digest is gone.
          if (lastAi && lastAi.trim()) {
            aiFullToken++; // cancel any in-flight article fetch
            summaryVisible = true;
            aiExpanded = true;
            paintAiFullscreen();
          }
        } else if (focused === 'content') {
          expandArticleSummary(0);
        }
        return;
      }
    }
    // Fullscreen AI owns its keys: scroll with arrows/space/page keys,
    // collapse with Esc (also via resetFocus). Slash and typing collapse
    // back into normal routing first — otherwise no / command works after
    // /ai until Esc (the fullscreen trap).
    if (aiExpanded) {
      if (ch === '/') {
        collapseAi();
        startFreshSearch();
        return;
      }
      if (printable(ch) || (printableStr(ch) && !String(ch).includes(' '))) {
        collapseAi();
        if (acceptTypedChar(ch)) return;
        return;
      }
      const page = Math.max(1, (body.height || 10) - 2);
      if (key.full === 'escape') {
        collapseAi();
        return;
      }
      if (key.full === 'space') {
        body.scroll(key.shift ? -page : page);
        scrollMoved();
        return;
      }
      if (key.name === 'up') {
        body.scroll(-1);
        scrollMoved();
        return;
      }
      if (key.name === 'down') {
        body.scroll(1);
        scrollMoved();
        return;
      }
      if (key.name === 'pageup') {
        body.scroll(-page);
        scrollMoved();
        return;
      }
      if (key.name === 'pagedown') {
        body.scroll(page);
        scrollMoved();
        return;
      }
      // Tab / Enter collapse the digest and continue into normal routing
      // (gallery, preview, open) instead of dying here — background paints
      // must never land on the AI view, but explicit keys still work.
      if (key.full === 'tab' || key.full === 'S-tab' || key.full === 'enter') {
        collapseAi();
      } else {
        return;
      }
    }
    // Theater owns arrows+Enter on watch articles: pick related videos
    // without scrolling the info pane. Esc collapses (also via resetFocus).
    if (theaterOpen && focused === 'content') {
      if (key.full === 'escape') {
        closeTheater();
        return;
      }
      if (key.name === 'up') {
        theaterMove(-1);
        return;
      }
      if (key.name === 'down') {
        theaterMove(1);
        return;
      }
      if (key.full === 'enter') {
        theaterPlay();
        return;
      }
    }
    // History lives on left/right outside input mode (there they edit text).
    // Themes/settings own their own arrows (they change values there), and
    // the gallery grid / fullscreen photo own arrows too — history here
    // would yank the user out of the view they are navigating (real bug:
    // arrows in the grid fired back/forward).
    if ((key.name === 'left' || key.name === 'right') && focused !== 'input' && focused !== 'themes' && focused !== 'settings' && focused !== 'gallerygrid' && focused !== 'imagefs') {
      // Home dashboard: ←/→ drive the sticky search-scope picker (it must
      // stay reachable without touching the omnibox) instead of history.
      if (homeView && focused === 'links') {
        cycleHomeScope(key.name === 'right' ? 1 : -1);
        return;
      }
      if (key.name === 'left') onHistoryBack();
      else onHistoryForward();
      return;
    }
    if (focused === 'gallerygrid') {
      if (key.full === 'escape') { closeGalleryGrid(); return; }
      // `/` (or plain typing) must never die in the grid: close it and hand
      // the keystroke to the omnibox — the same escape hatch settings,
      // themes and the AI view already have.
      if (ch === '/') { closeGalleryGrid(); startFreshSearch(); return; }
      if (printable(ch) || (printableStr(ch) && !String(ch).includes(' '))) {
        closeGalleryGrid();
        if (acceptTypedChar(ch)) return;
        return;
      }
      if (key.ctrl && (key.name === 'f' || ch === '\x06')) { openGalleryGridPhoto(); return; }
      if (key.name === 'left') { moveGalleryGrid(-1, 0); return; }
      if (key.name === 'right') { moveGalleryGrid(1, 0); return; }
      if (key.name === 'up') { moveGalleryGrid(0, -1); return; }
      if (key.name === 'down') { moveGalleryGrid(0, 1); return; }
      if (key.full === 'enter' || key.full === 'space') { openGalleryGridPhoto(); return; }
      return;
    }
    if (focused === 'imagefs') {
      if (key.full === 'escape' || (key.ctrl && (key.name === 'f' || ch === '\x06'))) { closeImageFullscreen(); return; }
      // Ctrl+R: rotate the photo 90° clockwise. Graphics modes re-encode
      // through sharp (kitty and iTerm2 both); ASCII cannot re-render pixels.
      if (key.ctrl && (key.name === 'r' || ch === '\x12')) {
        if (imageSupport() !== 'none') {
          imageFsRotate = (imageFsRotate + 90) % 360;
          try { tryClearImages(); } catch { /* best effort */ }
          paintImageFullscreen();
        } else {
          try { flashStatus('Rotation needs a graphics terminal (kitty/iTerm2)'); } catch { /* best effort */ }
        }
        return;
      }
      // Same escape hatch as the grid: `/` or typing leaves fullscreen.
      if (ch === '/') { closeImageFullscreen(); startFreshSearch(); return; }
      if (printable(ch) || (printableStr(ch) && !String(ch).includes(' '))) {
        closeImageFullscreen();
        if (acceptTypedChar(ch)) return;
        return;
      }
      // Step through the photos without leaving fullscreen. Esc still
      // returns exactly where the view was opened from.
      if (key.name === 'left' || key.name === 'right') {
        try {
          const imgs = lastMedia && Array.isArray(lastMedia.images) ? lastMedia.images : [];
          const i = imgs.findIndex((m) => m && m.src === imageFullscreen);
          if (imgs.length > 1 && i >= 0) {
            const next = (i + (key.name === 'right' ? 1 : -1) + imgs.length) % imgs.length;
            showImageFullscreen(imgs[next].src);
          }
        } catch { /* fullscreen stays on the current photo */ }
        return;
      }
      return;
    }
    if (focused === 'pet') {
      // The pet is a toy: any key closes it.
      closePet();
      return;
    }
    if (focused === 'settings' && settingsState) {
      if (key.full === 'escape') { closeSettings(); return; }
      if (key.name === 'up') { moveSettingsCursor(-1); return; }
      if (key.name === 'down') { moveSettingsCursor(1); return; }
      // ←/→ change the highlighted value; Enter advances/opens the editor.
      if (key.name === 'left') { cycleSetting(-1); return; }
      if (key.name === 'right') { cycleSetting(1); return; }
      if (key.full === 'enter' || key.full === 'space') { selectSetting(); return; }
      // Typing (or /) leaves settings and goes back to browsing — the bar
      // must never be a dead end here.
      if (ch === '/') { closeSettings(); startFreshSearch(); return; }
      if (printable(ch) || (printableStr(ch) && !String(ch).includes(' '))) {
        closeSettings();
        if (acceptTypedChar(ch)) return;
        return;
      }
      return;
    }
    if (focused === 'settings') {
      // Defensive: no panel open — fall through to normal routing.
      if (key.full === 'escape') { resetFocus(); return; }
    }
    if (focused === 'themes') {
      // LIVE picker: arrows repaint everything, no confirm key.
      if (key.full === 'escape' || key.full === 'enter' || key.full === 'space') {
        closeThemes();
        return;
      }
      if (key.name === 'up' || key.name === 'left') { moveThemeCursor(-1); return; }
      if (key.name === 'down' || key.name === 'right') { moveThemeCursor(1); return; }
      if (key.name === 'pageup') { moveThemeCursor(-10); return; }
      if (key.name === 'pagedown') { moveThemeCursor(10); return; }
      if (ch === '/') { closeThemes(); startFreshSearch(); return; }
      if (printable(ch) || (printableStr(ch) && !String(ch).includes(' '))) { closeThemes(); if (acceptTypedChar(ch)) return; return; }
      return;
    }
    if (focused === 'form') {
      // Form mode: the omnibox is the active field (password/OTP).
      // Enter submits the current step; Esc cancels and force-exits even
      // when the wizard callback swallows null (P1-5).
      if (key.full === 'enter') {
        if (formState.callback) formState.callback(omni.getValue());
        return;
      }
      if (key.full === 'escape') {
        try {
          const cb = formState && formState.callback;
          formState.callback = null;
          if (cb) { try { cb(null); } catch { /* wizard cleanup */ } }
        } catch { /* best effort */ }
        cancelFormSilent();
        return;
      }
      // Tab/right are disabled in form mode.
      return;
    }
    if (focused === 'links') {
      if (key.full === 'escape') { resetFocus(); return; }
      // Normalized Enter (CR twin already deduped above; LF mapped).
      const isEnter = key.full === 'enter' || key.full === 'S-enter' || key.name === 'enter';
      if (isEnter || key.full === 'space') {
        // Shift+Enter hands the video to an external player instead of
        // opening its watch page as text.
        if (isEnter && (key.shift || key.full === 'S-enter')) {
          const link = highlightedLink();
          if (link && link.url && onPlayVideo) onPlayVideo(link.url, [], link.title);
          return;
        }
        confirmLinkList();
        return;
      }
      // Tab: image rows open the 60/40 gallery pane; video thumbs keep
      // the transient overlay preview. Letters stay free for type-to-search.
      // A fullscreen digest collapses first (same rule as `/` + typing):
      // gallery paints must never land on top of the AI view.
      if (key.full === 'tab') {
        if (aiExpanded) collapseAi();
        const link = highlightedLink();
        if (link && link.image && link.url) {
          if (openGalleryByUrl(link.url) === 'ok') return;
        }
        if (link) showThumbFor(link);
        return;
      }
      // Arrows move the highlight only; Enter/Space opens the row.
      if (key.name === 'up') {
        moveCursor(-1);
        return;
      }
      if (key.name === 'down') {
        moveCursor(1);
        return;
      }
      if (ch === '/') {
        startFreshSearch();
        return;
      }
      if (printable(ch) || (printableStr(ch) && !String(ch).includes(' '))) {
        // Type-to-search from anywhere (first char preserved — see helper).
        if (acceptTypedChar(ch)) return;
        return;
      }
      return;
    }
    if (focused === 'content') {
      if (key.full === 'escape') { resetFocus(); return; }
      // Ctrl+F: fullscreen the image under the 60/40 pane (PDF pages are
      // images here too). Videos have no still to zoom — point at Enter.
      if (key.ctrl && (key.name === 'f' || ch === '\x06')) {
        if (galleryOpen) {
          const mlist = mediaList();
          const m = mlist[mediaCursor];
          if (m && m.kind === 'image' && m.src) {
            imageFsReturn = 'pane';
            showImageFullscreen(m.src);
            return;
          }
          try { if (typeof flashStatus === 'function') flashStatus('Ctrl+F zooms images — videos play with Enter'); } catch { /* best effort */ }
          return;
        }
        try { if (typeof flashStatus === 'function') flashStatus('No image open — Tab previews images · /gallery shows them all'); } catch { /* best effort */ }
        return;
      }
      // Ctrl+R: rotate the image under the 60/40 pane (same rule as the
      // fullscreen: graphics modes re-encode, ASCII says why it cannot).
      if (key.ctrl && (key.name === 'r' || ch === '\x12')) {
        if (galleryOpen) {
          const mlist = mediaList();
          const m = mlist[mediaCursor];
          if (m && m.kind === 'image' && m.src) {
            if (imageSupport() !== 'none') {
              galleryRotate = (galleryRotate + 90) % 360;
              renderMedia(mediaCursor).catch(() => {});
            } else {
              try { flashStatus('Rotation needs a graphics terminal (kitty/iTerm2)'); } catch { /* best effort */ }
            }
            return;
          }
        }
        try { flashStatus('Ctrl+R rotates an open image — Tab previews one'); } catch { /* best effort */ }
        return;
      }
      // Text-page paging: Space / arrows scroll, never type.
      // Tab opens/steps the 60/40 image gallery pane; Shift+Tab goes back.
      // A fullscreen digest collapses first (same rule as `/` + typing).
      const page = Math.max(1, (body.height || 10) - 2);
      if (key.full === 'tab' || key.full === 'S-tab') {
        if (aiExpanded) collapseAi();
        galleryStep(key.shift || key.full === 'S-tab' ? -1 : 1);
        return;
      }
      if (key.full === 'space') {
        body.scroll(key.shift ? -page : page);
        scrollMoved();
        return;
      }
      if (key.name === 'up') {
        body.scroll(-1);
        scrollMoved();
        return;
      }
      if (key.name === 'down') {
        body.scroll(1);
        scrollMoved();
        return;
      }
      if (key.name === 'pageup') {
        body.scroll(-page);
        scrollMoved();
        return;
      }
      if (key.name === 'pagedown') {
        body.scroll(page);
        scrollMoved();
        return;
      }
      if (key.full === 'enter') {
        // Media pane open on a VIDEO: Enter plays it in mpv — no /play needed.
        if (galleryOpen && mediaKind === 'video') {
          const m = mediaList()[mediaCursor];
          if (m && m.src && typeof onPlayVideo === 'function') {
            onPlayVideo(m.src, [], m.title);
            return;
          }
        }
        // Simplified: Enter shows. Links picker first (normal browsing);
        // with no links but images, Enter renders the first image fullscreen
        // instead of doing nothing.
        if (lastLinks.length > 0) showLinkPicker(lastLinks);
        else if (lastMedia && lastMedia.images && lastMedia.images.length > 0) showImageAt(1);
        return;
      }
      if (ch === '/') {
        startFreshSearch();
        return;
      }
      if (printable(ch) || (printableStr(ch) && !String(ch).includes(' '))) {
        if (acceptTypedChar(ch)) return;
        return;
      }
      return;
    }
    // input mode: the field owns text; arrows are inert single-line;
    // Enter arrives via the submit event below. Esc cancels the command
    // (restoring a snapshotted page) via resetFocus.
    if (key.full === 'escape') {
      resetFocus();
      return;
    }
    if (key.name === 'up') {
      moveCursor(-1);
      return;
    }
    if (key.name === 'down') {
      // Search-bar semantics: arrows walk the suggestions, and one more
      // down past the last row runs the query — so results are reachable
      // without ever pressing Enter.
      if (listCursor < suggestRows.length - 1) {
        moveCursor(1);
        return;
      }
      runSearchFromBar();
      return;
    }
    if (key.full === 'tab') {
      acceptSuggestion();
      return;
    }
    if (key.name === 'right') {
      // Right at the end of the text accepts the highlighted completion.
      if (acceptSuggestion()) return;
    }
    if (key.full === 'enter') {
      submitOmni();
      return;
    }
    scheduleSuggest();
  });

  // Printable test for a whole typed/pasted/IME string: every char must
  // be printable (code point >= 32, not DEL). Single-char fast paths keep
  // working; multi-char commits (CJK IME, paste) used to be dropped by a
  // length===1 guard, so 日本語 never reached the bar (keytest K2).
  function printableStr(s) {
    if (typeof s !== 'string' || !s.length) return false;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp < 32 || cp === 127) return false;
    }
    return true;
  }

  function printable(ch) {
    return !!ch && ch.length === 1 && ch.charCodeAt(0) >= 32 && ch !== ' ';
  }

  // The Search button always submits the bar as a fresh query. Cursor
  // rows belong to Enter (input mode) / confirmLinkList (links mode).
  // Single-flight: blessed fires textbox 'submit' on Enter even while our
  // logical focus is links/content (omnibox keeps DOM focus), which used
  // to double-fire alongside the keypress confirmLinkList -> 2x mpv.
  // Non-input submits are ignored unless they come from the Search button.
  function submitOmni(fromButton) {
    if ((focused !== 'input' && focused !== 'form') && !fromButton) return;
    // Drop any pending suggest fetch: its response would be stale the
    // moment navigation starts (the id guard would drop it anyway, but
    // this saves the network call entirely).
    if (suggestTimer) {
      clearTimeout(suggestTimer);
      suggestTimer = null;
    }
    // The submitted command owns the screen from here — drop the page
    // snapshot (Esc-cancel only applies before submitting). Focus-gated
    // slash handlers (/ai, /play, /copy) read the view underneath via
    // submitFocus, captured here before the drop.
    if (focused === 'input' && cmdSnapshot && (cmdSnapshot.focused === 'links' || cmdSnapshot.focused === 'content')) {
      submitFocus = cmdSnapshot.focused;
    } else {
      submitFocus = null;
    }
    cmdSnapshot = null;
    focusField();
    hideCommandPalette();
    // An image open underneath (gallery pane) survives an overlay command
    // (/download, /bookmark, /copy, /pets, …): if the command did NOT paint a
    // new page, reopen the same image afterwards.
    const galleryWasOpen = galleryOpen ? mediaCursor : -1;
    const pageBefore = pageSeq;
    const row = focused === 'input' ? suggestRows[listCursor] || null : null;
    // A highlighted completion IS the query — unless it is a placeholder
    // row (`<...>` or `[...]` usage), which must never clobber typed
    // arguments (/ai 3, /watch 2, /theme dracula all broke this way).
    // Placeholders fall through to the raw bar text. Same for bang input:
    // an autocomplete row titled "nope" replaced `>nope`, silently dropped
    // the `>` and web-searched the very syntax the app promises to teach.
    const isPlaceholder = row && row.title && (row.title.includes('<') || row.title.includes('['));
    const barText = omni.getValue();
    const isBang = String(barText || '').trim().replace(/^>+/, '>').startsWith('>');
    // A highlighted row IS the query for free-text search. Slash input is
    // different: the typed command and its args always win, because palette
    // titles carry descriptions ("/gallery (list page images…)") and
    // accepting one ran an image search instead of the command. The one
    // exception is completion: a bare/partial slash ("/" or "/vid") takes
    // the highlighted command NAME (never its description).
    const barTrim = String(barText || '').trim();
    const isSlash = barTrim.startsWith('/');
    const barCmd = barTrim.split(/\s+/)[0].toLowerCase();
    const rowCmd = row && row.title ? String(row.title).trim().split(/\s+/)[0].toLowerCase() : '';
    const rowCompletesSlash = row && !row.url && isSlash && !/\s/.test(barTrim) && rowCmd.startsWith('/') && rowCmd !== barCmd && rowCmd.startsWith(barCmd);
    const accepting = isSlash
      ? (rowCompletesSlash ? rowCmd : null)
      : (!isBang && row && !row.url && row.title && !isPlaceholder ? row.title : null);
    const routed = accepting || barText;
    // Capture focus BEFORE the command runs: many commands move focus to the
    // content/grid while painting, and the old post-submit check then left
    // the typed command sitting in the omnibox ("/gallery" stayed visible
    // after the grid opened).
    const wasInput = focused === 'input';
    try {
      onOmniSubmit(routed, row);
    } finally {
      submitFocus = null;
      // A media split open underneath survives an overlay command (/download,
      // /bookmark, /copy, /pets, …) — unless the command painted a new page.
      if (pageSeq === pageBefore) {
        if (restoreMediaSplit()) return;
        if (galleryWasOpen >= 0 && !galleryOpen) {
          try { openGallery(galleryWasOpen); } catch { /* best-effort */ }
        }
      }
    }
    // Slash commands own their args at submit time: clear the bar so the
    // next command starts fresh. A stale bar used to glue commands together
    // ("/ai-key KEY" + "/ai hi" submitted as one value that re-ran
    // ai-key). Raw search text is deliberately left alone (retype
    // refines the query); form mode is left alone (the wizard owns it).
    if (wasInput) {
      try {
        if (String(routed || '').trim().startsWith('/')) {
          omni.setValue('');
          suggestRows = [];
          listCursor = 0;
          listStart = 0;
          hideCommandPalette();
          screen.render();
        }
      } catch { /* bar hygiene is best-effort */ }
    }
  }

  // Down past the last suggestion (or with none) runs the bar as a fresh
  // query and drops into the results — the no-Enter path into browsing.
  function runSearchFromBar() {
    if (suggestTimer) {
      clearTimeout(suggestTimer);
      suggestTimer = null;
    }
    if (!omni.getValue().trim()) return;
    if (focused === 'input' && cmdSnapshot && (cmdSnapshot.focused === 'links' || cmdSnapshot.focused === 'content')) {
      submitFocus = cmdSnapshot.focused;
    } else {
      submitFocus = null;
    }
    cmdSnapshot = null; // navigation owns the screen from here
    focusField();
    hideCommandPalette();
    try {
      onOmniSubmit(omni.getValue(), null);
    } finally {
      submitFocus = null;
    }
  }

  // Tab / right-arrow completion: command rows complete to `/word ` only
  // (never the `<placeholder>` — P1-1), URL rows complete to the URL.
  // Preserves already-typed args: accepting `/yt` when the bar holds
  // `/yt gotham` keeps `gotham`. Returns true when a row was accepted.
  function acceptSuggestion() {
    if (focused !== 'input') return false;
    const row = suggestRows[listCursor];
    if (!row) return false;
    if (row.url) {
      const text = String(row.url).replace(/^https?:\/\//i, '').replace(/\/$/, '');
      if (!text) return false;
      omni.setValue(text);
    } else if (row.kind === 'command') {
      // Command word only: '/watch <n>' -> '/watch ' (typed args preserved).
      const cur = String(omni.getValue() || '');
      const m = String(row.title || '').trim().match(/^\/(\S+)/);
      const word = m ? m[1] : '';
      if (!word) return false;
      const after = cur.replace(/^\s*\/\S*/, '').trim();
      omni.setValue(`/${word}${after ? ' ' + after : ' '}`);
    } else {
      const text = String(row.title || '');
      if (!text) return false;
      omni.setValue(text);
    }
    listCursor = 0;
    listStart = 0;
    focusField();
    scheduleSuggest();
    screen.render();
    try { showCaret(); } catch { /* best effort */ }
    return true;
  }

  // --- Public API (all content coerced to string; never undefined) ---
  omni.on('submit', () => {
    submitOmni();
  });

  // Gallery marker lines in plain-string form (the spans path above keeps
  // objects with urls; text/pretty paints use these strings).
  function mediaMarkerLines() {
    const lines = [];
    try {
      const imgs = lastMedia && Array.isArray(lastMedia.images) ? lastMedia.images : [];
      const vids = lastMedia && Array.isArray(lastMedia.videos) ? lastMedia.videos : [];
      imgs.forEach((im, i) => {
        let host = '';
        try { host = new URL(im.src).hostname.replace(/^www\./, ''); } catch { /* keep blank */ }
        const label = (im.alt || '').trim() || host || `image ${i + 1}`;
        lines.push(`[img ${i + 1}/${imgs.length}: ${label}]`);
      });
      vids.forEach((v, i) => {
        let host = '';
        try { host = new URL(v.src).hostname.replace(/^www\./, ''); } catch { /* keep blank */ }
        const label = (v.title || '').trim() || host || `video ${i + 1}`;
        lines.push(`[video ${i + 1}/${vids.length}: ${label}] — /watch ${i + 1} to play`);
      });
    } catch { /* markers are best-effort */ }
    return lines;
  }

  // Magazine-style article header: title, one muted meta line (site ·
  // byline · reading time), and a rule — all centered, so every site
  // opens like a page instead of a wall of text. Pure string work.
  function readerHeader() {
    const r = lastReader;
    if (!r || !r.title) return '';
    const W = Math.max(12, bodyInnerWidth());
    const meta = [r.site, r.byline, r.readingTime ? `${r.readingTime} min read` : '']
      .map((s) => String(s || '').trim())
      .filter(Boolean)
      .join(' · ');
    const title = truncateVisual(String(r.title).trim().replace(/\s+/g, ' '), W - 4);
    const rule = '─'.repeat(Math.max(4, Math.min(W, 40)));
    return [
      centerTagged(`{bold}${escTags(title)}{/}`, W),
      '',
      meta ? centerTagged(`{${theme.muted}-fg}${escTags(truncateVisual(meta, W - 2))}{/}`, W) : '',
      centerTagged(`{${theme.alt}-fg}${escTags(rule)}{/}`, W),
    ]
      .filter(Boolean)
      .join('\n');
  }

  // Pretty article repaint: sub-topic boxes measured to the LIVE webview
  // width on every call (navigation, Esc-restore, split toggle, resize).
  // Reload-proof: box rows are verified against the live width and the
  // render shrinks until they fit, so boxes always sit right no matter
  // what changed the webview. Returns true when painted.
  function paintPretty(aiCardText) {
    const prettyText = String(lastPretty || '').trim();
    if (prettyText.length <= 50) return false;
    try {
      const head = readerHeader();
      const card = String(aiCardText || '').trim();
      const extra = mediaMarkerLines().join('\n');
      // The box must fit the REAL container (live body width), never a
      // fixed floor: boxSections also clamps to `available` and passes
      // text through unboxed below W=12, so the shrink loop below always
      // terminates with fitting content instead of painting over-wide.
      const avail = Math.max(1, Math.floor(bodyInnerWidth()));
      let W = Math.max(1, Math.min(110, avail));
      let boxed = null;
      let cooked = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        boxed = boxSections(escTags(prettyText), { width: W, available: avail });
        boxed.text = themeBorders(boxed.text);
        const parts = [head, card, boxed.text, extra].filter((p) => p && p.trim());
        cooked = blockMd(parts.join('\n\n'));
        if (!boxed.boxed || boxRowOverflow(cooked, avail) <= 0) break;
        W = Math.max(1, W - 12);
      }
      try {
        if (process.env.TUI_DEBUG_BOX) {
          const v = verifyBoxContainment(cooked, avail);
          if (!v.ok) process.stderr.write(`[box-contain] ${v.violations.length} violations: ${JSON.stringify(v.violations.slice(0, 3))}\n`);
        }
      } catch { /* checker is best-effort */ }
      // Link line numbers shift by everything painted above the boxes.
      const headLines = (head ? head.split('\n').length : 0) + (head ? 1 : 0);
      const cardLines = card ? card.split('\n').length + 1 : 0;
      const boxStart = headLines + cardLines;
      let links = [];
      let shown = cooked;
      if (boxed.boxed && boxed.linkLines.length) {
        links = boxed.linkLines.map((l) => ({ line: l.line + boxStart, url: l.url, text: l.text || '' }));
      } else {
        // No boxes: pair markers per final line (pairing never changes
        // line counts, so indices are exact by construction).
        const rows = cooked.split('\n');
        shown = rows.map((ln, i) => {
          const p = pairLinks(ln);
          p.urls.forEach((u) => links.push({ line: i, url: String(u).slice(0, 300), text: '' }));
          return p.t;
        }).join('\n');
      }
      // Hero art, centered, above the title. Falls through silently when
      // the image can't be fetched/decoded — text always wins.
      const art = heroArt();
      if (art) shown = `${art}\n\n${shown}`;
      body.setContent(shown || '(no content)');
      contentLinkLines = links;
      scrollBodyTo(0);
      return true;
    } catch {
      return false;
    }
  }

  // Hero art for the current page (og:image / lead image). Text NEVER waits
  // for it: maybeShowHero() kicks off an async ASCII render; the article
  // paints immediately, and heroArt() simply returns '' until the art is
  // ready (and forever if it can't be decoded).
  let heroPromise = null;
  let heroRendered = '';

  function maybeShowHero() {
    const url = String(lastHero || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      heroPromise = null;
      heroRendered = '';
      return;
    }
    if (heroPromise && heroPromise._url === url) return;
    const p = Promise.resolve()
      .then(async () => {
        const { getImageAscii } = require('./image');
        const art = await getImageAscii(url, { width: Math.max(28, Math.min(72, contentWidth() - 4)), maxHeight: 18 });
        return typeof art === 'string' ? art : '';
      })
      .catch(() => '');
    p._url = url;
    heroPromise = p;
    p.then((art) => {
      // Stale guard: a newer page (or a re-render) must not paint old art.
      if (heroPromise !== p) return;
      heroRendered = art ? centerArt(art, contentWidth()) : '';
      if (!heroRendered) return;
      try {
        if (focused === 'content' && lastPretty) {
          paintPretty('');
        }
      } catch { /* hero paint is best-effort */ }
    });
  }

  function heroArt() {
    return String(heroRendered || '');
  }

  function setURL(url) {
    omni.setValue(String(url ?? ''));
    screen.render();
  }

  function setCenterContent(text, links, spans, media, ai, summary, pretty, page) {
    // Real page navigation: replaces page state entirely (media/links
    // cleared when the new page has none). Informational commands must
    // use showInfo()/toast() instead so they never destroy the page.
    // Leaving any picker for article text clears YT title-only mode.
    ytMode = false;
    ytQuery = '';
    // Reader metadata + blocked badge travel with the page (index.js).
    lastReader = page && page.reader && typeof page.reader === 'object' ? page.reader : null;
    lastHero = String((page && page.hero && page.hero[0]) || '').trim();
    if (page && page.net) setBlockedCount(Number(page.net.page) || 0, Number(page.net.total));
    // AI card may arrive as 5th arg (index.js) or tucked on media.ai
    // (older callers / tests). Summary likewise: 6th arg or media.summary.
    // AI card paints on top; summary is a bottom box, hidden on articles
    // until /ai (search pickers auto-show theirs — see showLinkPicker).
    const aiText = String(ai || (media && media.ai) || '').trim().slice(0, 8000);
    lastAi = '';
    // A new page replaces any open gallery split and invalidates an overlay
    // snapshot (a real navigation owns the screen; Esc has nothing to undo).
    clearContentView();
    clearMediaSplit();
    pageSeq++;
    closeGallery();
    lastSummary = String(summary || (media && (media.summary || media.aiSummary)) || '').trim().slice(0, 24000);
    summaryVisible = false;
    aiExpanded = false;
    lastText = sanitizeLine(text) || '(no content)';
    lastSpans = Array.isArray(spans) && spans.length > 0 ? spans : null;
    lastLinks = Array.isArray(links) ? links : [];
    // Gallery state: every page carries its own images/videos, so Tab
    // always means "this page's pictures" — no cross-page leakage.
    const imgs = media && Array.isArray(media.images) ? media.images : [];
    const vids = media && Array.isArray(media.videos) ? media.videos : [];
    lastMedia = { images: imgs, videos: vids };
    mediaCursor = -1;
    // YT theater: watch pages with a related rail split 60/40
    // automatically; anything else collapses a stale split.
    try {
      const rel = media && Array.isArray(media.related) ? media.related : [];
      if (media && media.watch && rel.length > 0) openTheater(rel);
      else closeTheater();
    } catch { /* split is best-effort */ }
    // Warm the image cache in the background: first Tab/Enter on art is
    // instant even on slow networks. Never blocks the text paint.
    try { prefetchImages(imgs.slice(0, 6).map((im) => im.src)); } catch { /* best effort */ }
    // Marker lines, reader-style (images listed with the article text).
    const markers = [];
    imgs.forEach((im, i) => {
      let host = '';
      try { host = new URL(im.src).hostname.replace(/^www\./, ''); } catch { /* keep blank */ }
      const label = (im.alt || '').trim() || host || `image ${i + 1}`;
      markers.push({ t: `[img ${i + 1}/${imgs.length}: ${label}]`, url: null });
    });
    vids.forEach((v, i) => {
      let host = '';
      try { host = new URL(v.src).hostname.replace(/^www\./, ''); } catch { /* keep blank */ }
      const label = (v.title || '').trim() || host || `video ${i + 1}`;
      markers.push({ t: `[video ${i + 1}/${vids.length}: ${label}] — /watch ${i + 1} to play`, url: null });
      // Videos join the picker so Enter reaches them; direct files play
      // externally (see index.js onLinkPick), embeds open as pages.
      try {
        lastLinks.push({ title: `[video] ${label}`.slice(0, 80), url: v.src, domain: host });
      } catch { /* picker is best-effort */ }
    });
    setFocus('content');
    // Google AI card on top (cleaner than the raw result soup), then the
    // article, then the /ai summary bottom box when visible. Spans path
    // appends link-free card spans; text path joins with the same
    // dividers so both views agree.
    const aiCard = aiText ? `AI answer\n${aiText}` : '';
    const aiSpans = aiText ? [{ t: '━━━ AI answer ━━━', url: null }, { t: aiText, url: null }, { t: '━━━━━━━━━━━━━━━', url: null }] : [];
    const sumSpans = (summaryVisible && lastSummary)
      ? [{ t: '━━━ AI summary ━━━', url: null }, { t: lastSummary, url: null }, { t: '━━━━━━━━━━━━━━━', url: null }]
      : [];
    // Pretty article view (pretty.js) wins over spans when present:
    // sub-topic boxes measured to the live width, links rail included.
    // Spans stay as the fallback (and feed the Enter picker).
    const prettyText = String(pretty || '').trim();
    lastPretty = prettyText.length > 50 ? prettyText : null;
    if (lastPretty) {
      lastText = lastPretty;
      lastSpans = null;
      paintPretty(aiCard);
      // Hero art above the title, drawn async so text is never delayed.
      maybeShowHero();
      return;
    }
    maybeShowHero();
    if (lastSpans) renderSpans(aiSpans.concat(lastSpans).concat(markers).concat(sumSpans));
    else {
      const extra = markers.map((m) => m.t).join('\n');
      const sumCard = (summaryVisible && lastSummary) ? `━━━ AI summary ━━━\n${lastSummary}\n━━━━━━━━━━━━━━━` : '';
      const parts = [readerHeader(), aiCard, lastText, extra, sumCard].filter((p) => p && p.trim());
      body.setContent(themeBorders(blockMd(escTags(parts.join('\n\n')))));
      // Plain-text path has no per-line link map: clear it so clicks on
      // the new paint cannot fire the previous article's URLs (P1-3).
      contentLinkLines = [];
      scrollBodyTo(0);
    }
  }

  // Informational body view that NEVER destroys page state (P0-5).
  // /help, /profile, /pets, /queue etc. paint here: the body shows the
  // info, but lastText/lastSpans/lastLinks/lastMedia/lastPretty stay
  // intact so /img, /gallery, /watch, Enter and Tab keep working on the
  // page underneath. Esc/showText restores the page. Clears the click
  // map (info has no links) and hides transient AI/theater splits.
  function showInfo(text) {
    try {
      const msg = String(text ?? '').slice(0, 60000) || '(empty)';
      ytMode = false;
      ytQuery = '';
      summaryVisible = false;
      aiExpanded = false;
      // Remember the view underneath so Esc returns to it (a command like
      // /pets must not strand the user on a blank page).
      snapshotContentView();
      try { closeGallery(); } catch { /* best effort */ }
      try { closeTheater(); } catch { /* best effort */ }
      contentLinkLines = [];
      setFocus('content');
      body.setContent(themeBorders(blockMd(escTags(msg))) || '(empty)');
      scrollBodyTo(0);
      return true;
    } catch {
      return false;
    }
  }

  // Bottom AI box: search result lists show the bottom box, articles
  // show the fullscreen digest (both on Alt+Up; /ai is the chat command,
  // /settings → AI picks the free OpenRouter model that answers). Returns
  // 'shown'|'hidden'|'empty'|'search-only'. Never throws.
  // Big article digest for Alt+Up while reading: up to 2000
  // tokens (≈8000 chars) of the current page, shown fullscreen and boxed.
  // Returns 'shown' | 'empty'. Never throws, never touches the bar
  // (articles never grow one).
  // LOCAL extractive digest — the no-key fallback for the fullscreen view.
  function expandArticleSummaryLocal(n) {
    try {
      const { summarize } = require('./ai');
      const count = n && Number(n) > 0 ? Number(n) : 12;
      // Generous budget (~6k tokens default, scales with /ai N): article
      // digests must carry enough detail to understand the page, and the
      // fullscreen view scrolls so length is never a layout problem.
      const budget = n && Number(n) > 0
        ? Math.max(4000, Math.min(40000, Number(n) * 2000))
        : 24000;
      const t = summarize(getPageText(), { maxSentences: count, maxChars: budget });
      if (!t) return 'empty';
      lastAi = t;
      lastAiModel = '';
      summaryVisible = true;
      aiExpanded = true;
      paintAiFullscreen();
      return 'shown';
    } catch {
      return 'empty';
    }
  }

  // Alt+Up on an ARTICLE: a REAL LLM summary of the page via OpenRouter,
  // shown fullscreen (thinking placeholder -> rich reply). The local
  // extractive digest is the fallback ONLY when there is no key / no text.
  function expandArticleSummary(n) {
    let or = null;
    let hasKey = false;
    try {
      or = require('./openrouter');
      hasKey = !!or.resolveKey();
    } catch { hasKey = false; }
    if (!hasKey || !or || typeof or.askAi !== 'function') {
      return expandArticleSummaryLocal(n);
    }
    const pageText = getPageText();
    if (!String(pageText || '').trim()) return expandArticleSummaryLocal(n);
    const token = ++aiFullToken;
    // Immediate fullscreen with an animated placeholder; the reply replaces it.
    aiExpanded = true;
    startAiThinking();
    const question = 'Summarize this page for a reader. Open with one paragraph saying what it is, then the key points as short - bullet points.';
    try {
      or.askAi(question, { context: pageText, style: or.STYLE, timeoutMs: 75000 }).then((r) => {
        if (token !== aiFullToken) return; // collapsed / superseded: drop the reply
        stopAiThinking();
        if (r && r.ok && r.text) { lastAi = r.text; lastAiModel = r.model || ''; }
        else if (r && r.error) { lastAi = `AI summary failed: ${r.error}`; lastAiModel = ''; }
        else { lastAi = 'AI summary returned nothing — try again.'; lastAiModel = ''; }
        if (aiExpanded) paintAiFullscreen();
        else if (summaryVisible) paintAiBar();
      }).catch(() => {
        if (token !== aiFullToken) return;
        stopAiThinking();
        lastSummary = 'AI summary could not reach the AI service.';
        if (aiExpanded) paintAiFullscreen();
      });
    } catch {
      return expandArticleSummaryLocal(n);
    }
    return 'shown';
  }

  function showAiSummary(n) {
    try {
      // Slash-typed over an open view: normalize focus FIRST so the toggle
      // check below sees the real view, not the transient 'input' bar.
      // (Old order collapsed to showText() and destroyed the list — P1-6.)
      const fv0 = effFocus();
      if (focused === 'input' && (fv0 === 'links' || fv0 === 'content')) setFocus(fv0);
      // Toggle off from anywhere (bar, fullscreen, article view).
      if (aiExpanded || summaryVisible) {
        collapseAi();
        return 'hidden';
      }
      const fv = effFocus();
      if (fv === 'links') {
        // Only the REAL answer shows (LLM reply / page AI card / key hint).
        if (lastAi && lastAi.trim()) {
          summaryVisible = true;
          paintList(true);
          return 'shown';
        }
        return 'empty';
      }
      // Reading an article (wiki etc.): summarize THIS page, fullscreen.
      if (fv === 'content') return expandArticleSummary(n);
      return 'search-only';
    } catch {
      return 'empty';
    }
  }

  function isAiVisible() {
    return !!summaryVisible;
  }

  // (centerTagged lives at module scope; the closure uses it directly.)

  // Full AI response view: paints the scrollable body WITHOUT touching
  // lastText/lastSpans, so Esc (resetFocus → showText) restores the page.
  // Answers read as a clean, centered list: title rule, bullet points with
  // breathing room, no leftover markdown, no raw URLs.
  function showGeminiView(text, title, model) {
    try {
      setFocus('content');
      let head = String(title || 'AI answer').trim().slice(0, 80) || 'AI answer';
      // Attribution rides the HEAD: the per-exchange "— by …" line at the
      // end of a long answer sits below the fold, and this view always
      // opens scrolled to the top, so the head is what the user sees.
      try {
        if (model) head = `${head} — by ${require('./openrouter').modelLabel(model)}`.slice(0, 100);
      } catch { /* plain head */ }
      const W = Math.max(30, contentWidth());
      const body_ = tidyAnswer(text);
      const rule = (ch, n) => ch.repeat(Math.max(4, Math.min(W, n)));
      const out = [];
      out.push(centerTagged(`{bold}${escTags(head)}{/}`, W));
      out.push(centerTagged(`{${theme.alt}-fg}${escTags(rule('━', W))}{/}`, W));
      out.push('');
      // Paragraph-ish bullets get an indent; a bullet and the text after it
      // are wrapped and aligned so the block stays readable, not ragged.
      for (const raw of body_.split('\n')) {
        const bullet = /^\s*•\s+/.test(raw);
        const indent = bullet ? '  ' : '';
        const wrapped = wrapVis(escTags(raw.trim()), Math.max(20, W - 2), false);
        wrapped.forEach((line, i) => {
          const text = (bullet && i === 0 ? `• ${line.replace(/^•\s*/, '')}` : line).trimEnd();
          if (!text) {
            out.push('');
            return;
          }
          if (bullet) out.push(`${indent}${text}`);
          else out.push(line);
        });
        if (bullet) out.push('');
      }
      out.push(centerTagged(`{${theme.alt}-fg}${escTags(rule('━', W))}{/}`, W));
      out.push(centerTagged(`{${theme.muted}-fg}${escTags('esc restores the page · /ai asks again')}{/}`, W));
      body.setContent(blockMd(out.join('\n')));
      scrollBodyTo(0);
      return true;
    } catch {
      return false;
    }
  }

  // Current page text for AI context (articles) — truncated by caller.
  function getPageText() {
    try {
      if (lastSpans && lastSpans.length) return lastSpans.map((s) => String(s.t || '')).join('\n');
      return String(lastText || '');
    } catch {
      return '';
    }
  }

  // ---- /game: the offline arcade --------------------------------------
  // The piano (and the pong table) in a rounded box, offered when nothing
  // can load (no internet, a dead-slow timeout, a captcha or bot wall) and
  // on /game any time. The piano falls ● balls to the A S D F J K L ;
  // hit line, judges perfect/great/good, sounds a real note per hit and
  // plays ten songs (digits pick 1-9, 0 for the tenth); /game free skips
  // the balls. It owns the body while
  // open — the head text it was invoked from stays as the box's header,
  // so Esc restores it byte-identical. One unref'd interval repaints the
  // field ~16 fps; it is created on the first open and cleared on close,
  // so an idle app pays nothing and the timer can never keep the process
  // alive on quit.
  const gameState = { open: false, kind: 'piano', head: '', note: '', game: null, timer: null, free: false, song: 0 };
  const PIANO_HINT = 'A S D F · J K L ; — hit the line on the beat · m mute · * random · p free play · / search · esc back';
  const PIANO_FREE_HINT = 'free play — press any key · m mute · p play a song · 1-9,0 pick · * random · / search · esc back';
  const PONG_HINT = '↑/↓ or k/j move · enter continues · r restart run · / search · esc back';

  function piano() {
    return require('./piano'); // lazy: an idle app never loads the arcade
  }

  function pong() {
    return require('./pong'); // lazy: an idle app never loads the table
  }

  // Sound: one lazily created player for the piano (its note WAVs are
  // cached in tmpdir). It never throws; a box with no player is simply
  // silent, and tests/CI stay quiet through TUI_TEST.
  let gamePlayer = null;

  function gameAudio() {
    if (!gamePlayer) {
      try {
        gamePlayer = require('./pianoAudio').createPlayer();
      } catch {
        gamePlayer = null;
      }
    }
    return gamePlayer;
  }

  // The piano wants a square-ish field (the user asked for a box) so the
  // eight lanes stay readable; below ~22 cells of side there is no room
  // for 8 lanes in a square, so it falls back to the classic wide
  // rectangle (pong always uses that). Every mode fits the body: the box
  // is h + 3 rows, plus blank + note + hint, plus a two-row head when the
  // game was invoked from an error page.
  function gameDims() {
    const headLines = gameState.head ? 2 : 0;
    const maxW = Math.max(26, Math.min(64, (screen.width || 80) - 4));
    const availH = Math.max(8, (body.height || 18) - 4 - headLines);
    const side = Math.min(maxW, availH, 40);
    if (gameState.kind === 'piano' && side >= 22) {
      const w = side;
      return { w, inner: w - 6, h: w - 3 };
    }
    const w = maxW;
    const inner = w - 6; // `│  ` + content + padding + `  │`
    const h = Math.max(6, Math.min(11, (body.height || 16) - 7 - headLines));
    return { w, inner, h };
  }

  function ensureGame() {
    const { inner, h } = gameDims();
    const g = gameState.game;
    if (gameState.kind === 'pong') {
      const pg = pong();
      if (!g || g.w !== inner || g.h !== h) {
        // Same run, new arena: a resize keeps the level, lives and score.
        gameState.game = pg.createGame({
          width: inner,
          height: h,
          rng: g && g.rng,
          level: g ? g.level : 1,
          lives: g ? g.lives : undefined,
          you: g ? g.you : 0,
          bot: g ? g.bot : 0,
        });
      }
      return gameState.game;
    }
    const kb = piano();
    const wantFree = !!gameState.free;
    if (!g || g.w !== inner || g.h !== h || !!g.free !== wantFree) {
      let opts;
      if (!g) {
        // Fresh open: the requested mode, and the song the command chose
        // (or the last one played).
        opts = { width: inner, height: h, free: wantFree, song: gameState.song };
      } else if (!!g.free !== wantFree) {
        // Mode swap (e.g. /game free while a song is up): same song,
        // fresh board.
        opts = { width: inner, height: h, free: wantFree, song: g.song };
      } else {
        // Same run, new arena: score, lives, song position, hit count
        // (which drives the speed creep) and the balls in flight survive.
        opts = Object.assign({ width: inner, height: h }, kb.carry(g));
      }
      gameState.game = kb.createGame(opts);
    }
    return gameState.game;
  }

  // p swaps song mode ↔ free play: same song, fresh board either way.
  function setPianoMode(free) {
    const kb = piano();
    const { inner, h } = gameDims();
    const cur = gameState.game;
    gameState.free = !!free;
    gameState.song = cur && Number.isInteger(cur.song) ? cur.song : gameState.song;
    gameState.game = kb.createGame({ width: inner, height: h, free: !!free, song: gameState.song });
    paintGame();
  }

  // The rounded box, the app's box grammar exactly: title on the top edge
  // (budget w - 6 like the AI box), 2-cell gutters, every row exactly `w`
  // cells wide, rounded corners, all glyphs single-cell.
  function gameView() {
    const { visibleCells } = require('./beautify');
    const { w, inner } = gameDims();
    const g = ensureGame();
    let stats;
    let rows;
    let title;
    if (gameState.kind === 'pong') {
      const pg = pong();
      stats = escTags(truncateVisual(pg.describe(g), inner));
      rows = [stats, ...pg.paint(g)];
      title = 'Pong — bots get harder';
    } else {
      const kb = piano();
      stats = escTags(truncateVisual(kb.describe(g), inner));
      rows = [stats, ...kb.paint(g)];
      const songName = (kb.SONGS[g.song] || {}).name || 'song';
      title = g.free ? 'Piano — free play' : `Piano — ${songName}`;
    }
    const shown = truncateVisual(escTags(title), w - 6);
    const dash = Math.max(1, w - visibleCells(shown) - 5);
    const out = [`╭─ ${shown} ${'─'.repeat(dash)}╮`];
    for (const r of rows) {
      const pad = Math.max(0, inner - visibleCells(r));
      out.push(`│  ${r}${' '.repeat(pad)}  │`);
    }
    out.push(`╰${'─'.repeat(w - 2)}╯`);
    return out;
  }

  function paintGame() {
    if (!gameState.open || !gameState.game) return;
    try {
      const W = Math.max(30, contentWidth());
      const lines = [];
      if (gameState.head) lines.push(gameState.head, '');
      for (const l of gameView()) lines.push(centerTagged(l, W));
      lines.push('');
      let note = gameState.note;
      let hint = PIANO_HINT;
      if (gameState.kind === 'pong') {
        try {
          // Between matches the table speaks for itself (win / loss /
          // reset); during play the note set at open explains the rules.
          note = pong().status(gameState.game) || gameState.note;
          hint = PONG_HINT;
        } catch { /* default note/hint */ }
      } else {
        try {
          // Judgment/miss/song flashes and the game-over line speak for
          // themselves; quiet play falls back to the rules note set at open.
          const pg = gameState.game;
          note = piano().status(pg) || gameState.note;
          hint = pg && pg.free ? PIANO_FREE_HINT : PIANO_HINT;
          // Prefix, not suffix: the hint truncates on narrow terminals and
          // the mute state is the one thing that must stay visible.
          if (gamePlayer && gamePlayer.isMuted()) hint = 'muted · ' + hint;
        } catch { /* default note/hint */ }
      }
      if (note) {
        lines.push(centerTagged(`{${theme.muted}-fg}${escTags(note)}{/}`, W));
      }
      lines.push(centerTagged(`{${theme.muted}-fg}${escTags(hint)}{/}`, W));
      body.setContent(lines.join('\n'));
      screen.render();
    } catch { /* the arcade is best-effort */ }
  }

  function showGame(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const kind = o.kind === 'pong' ? 'pong' : 'piano';
    if (kind !== gameState.kind) {
      // A different cabinet means a fresh run — no piano state bleeds
      // into a pong table (or back), and the old interval dies with it.
      gameState.kind = kind;
      gameState.game = null;
      try {
        if (gameState.timer) {
          clearInterval(gameState.timer);
          gameState.timer = null;
        }
      } catch { /* best effort */ }
    }
    gameState.free = kind === 'piano' && !!o.free;
    if (kind === 'piano' && Number.isInteger(o.song) && o.song >= 0 && o.song < piano().SONGS.length) {
      // An explicit song pick is a fresh run on that song, even when a
      // previous piano game is still parked in gameState.
      gameState.song = o.song;
      gameState.game = null;
    }
    gameState.head = o.head ? escTags(String(o.head)) : '';
    gameState.note = o.note
      ? String(o.note).slice(0, 160)
      : kind === 'pong'
        ? 'First to 3 points takes the match — win to face a faster bot; 3 losses restart the run at level 1.'
        : gameState.free
          ? 'Free play — every key is a note (C4 to C5). p starts a song; 1-9 pick one, 0 for the tenth.'
          : 'Notes fall to the keyboard — tap the lane key on the beat. Perfect scores most; three border crashes end the run.';
    // Random songs are the piano's default: a cabinet that starts a FRESH
    // run (no song picked, not free play) rolls straight into a random
    // song. A parked run resumes untouched — a late offline error landing
    // on an open game must never reset the run that is on screen.
    const freshRun = kind === 'piano' && !gameState.free && !Number.isInteger(o.song) && !gameState.game;
    ensureGame();
    if (freshRun && !gameState.game.random) piano().toggleRandom(gameState.game);
    try {
      gameAudio(); // warm the note cache once (~ms; silence is fine)
    } catch { /* sound is best-effort */ }
    gameState.open = true;
    if (!gameState.timer) {
      const tickMs = kind === 'pong' ? pong().TICK_MS : piano().TICK_MS;
      gameState.timer = setInterval(() => {
        try {
          if (!gameState.open || !gameState.game) return;
          if (gameState.kind === 'pong') {
            pong().tick(gameState.game);
          } else {
            const events = piano().tick(gameState.game) || [];
            // A ball shattering on the border gets its soft thud.
            if (events.indexOf('miss') >= 0) {
              try {
                const au = gameAudio();
                if (au) au.thud();
              } catch { /* sound is best-effort */ }
            }
          }
          paintGame();
        } catch { /* tick is best-effort */ }
      }, tickMs);
      if (gameState.timer && typeof gameState.timer.unref === 'function') gameState.timer.unref();
    }
    paintGame();
    return true;
  }

  function closeGame() {
    if (!gameState.open) return false;
    gameState.open = false;
    try {
      if (gameState.timer) {
        clearInterval(gameState.timer);
        gameState.timer = null;
      }
    } catch { /* best effort */ }
    try {
      if (gamePlayer) gamePlayer.stop(); // silence any voices still ringing
    } catch { /* best effort */ }
    try {
      if (gameState.head) {
        body.setContent(gameState.head);
        scrollBodyTo(0);
      } else if (aiExpanded) {
        paintAiFullscreen();
      } else if (lastText) {
        // Whatever text was on screen (article, info card, error) is the
        // view underneath; the dashboard is the only textless view.
        showText();
      } else {
        paintList(true);
      }
      screen.render();
    } catch { /* restore is best-effort */ }
    return true;
  }

  function isGameOpen() {
    return !!gameState.open;
  }

  function showCaptcha(message) {
    closeGallery();
    closeTheater();
    setFocus('content');
    aiExpanded = false;
    lastSpans = null;
    lastLinks = []; // Enter must not open the previous page's links here
    contentLinkLines = [];
    // Plain ASCII on purpose: no double-width emoji, so this path can never
    // plant a bad cell in the render buffer.
    const raw = `[!] CAPTCHA detected\n\n${sanitizeLine(message)}\n\nRedirecting to your default browser...`;
    body.setContent(escTags(raw));
    scrollBodyTo(0);
    // A wall you cannot pass is the perfect moment for the arcade: the
    // message becomes the game's header, so Esc brings it back unchanged.
    try {
      showGame({ head: raw, note: 'A captcha wall blocks the page — arcade while you solve it.' });
    } catch { /* arcade is best-effort */ }
  }

  function redirectToBrowser(url) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    const { execFile } = require('child_process');
    execFile('xdg-open', [parsed.toString()], () => {});
    screen.render();
  }

  // Form echo: the web view shows prompt + typed value + block caret, so
  // eyes stay where the form is (/register, /login). The omnibox remains
  // the input buffer — zero focus juggling, same as before.
  function paintForm() {
    if (focused !== 'form') return;
    const val = omni.getValue();
    const shown = omni.censor ? '*'.repeat([...val].length) : val;
    body.setContent(`${escTags(formState.prompt || '')}${escTags(shown)}▌`);
    scrollBodyTo(0);
  }

  // Show the login form (email -> password -> OTP). The callback receives
  // the submitted value for each step, or null on Esc cancel.
  function showLoginForm(opts) {
    const { step, prompt, callback, censor = false } = opts || {};
    formState = { step, prompt, callback };
    // Toggle password masking first (must be before setValue)
    if (censor && !omni.censor) {
      omni.censor = true;
    } else if (!censor && omni.censor) {
      omni.censor = false;
    }
    // Clear the field so the user starts fresh (prevents /login prefix leak)
    omni.setValue('');
    setFocus('form');
    paintForm();
    focusField();
    screen.render();
  }

  // Simple modal choice (the quit prompt): paints a boxed question into the
  // body and captures 1..4 / Esc. The callback receives the 0-based pick or
  // null on cancel. Used by Ctrl+Q when a video is still playing.
  let choiceState = null;
  function showChoice(opts) {
    try {
      const o = opts || {};
      const options = Array.isArray(o.options) ? o.options.slice(0, 4) : [];
      choiceState = {
        options,
        callback: typeof o.callback === 'function' ? o.callback : null,
      };
      const lines = [String(o.title || 'Choose'), ''];
      options.forEach((op, i) => lines.push(`  ${i + 1}. ${op.label}${op.hint ? `  — ${op.hint}` : ''}`));
      lines.push('');
      if (o.footer) lines.push(`  ${o.footer}`);
      body.setContent(themeBorders(blockMd(escTags(lines.join('\n')))));
      scrollBodyTo(0);
      setFocus('content');
      updateHint();
      screen.render();
      return true;
    } catch { return false; }
  }

  function isChoiceOpen() { return !!choiceState; }

  // Signed-in identity for the header. Set by /login from the Google
  // profile; empty while signed out (placeholder shows instead).
  function setIdentity(name, email) {
    header.setContent(identityLabel(name, email));
    screen.render();
  }

  // Gallery: numbered image list with titles. Mouse/keyboard select a row,
  // Enter (or /img <n>) renders that image (overlay or ASCII). Pure list —
  // the art itself comes from showPageImage/showImageAt.
  function galleryRows() {
    const imgs = lastMedia && Array.isArray(lastMedia.images) ? lastMedia.images : [];
    return imgs.map((im, i) => {
      let host = '';
      try { host = new URL(im.src).hostname.replace(/^www\./, ''); } catch { /* blank */ }
      const label = (im.alt || '').trim() || host || `image ${i + 1}`;
      return { title: `${i + 1}. ${label}`.slice(0, 90), url: im.src, domain: host, thumb: im.src, image: true };
    });
  }

  function showGallery() {
    const rows = galleryRows();
    if (rows.length === 0) {
      setFocus('content');
      showText();
      return false;
    }
    closeGallery();
    closeTheater();
    ytMode = false;
    ytQuery = '';
    lastAi = '';
    lastPretty = null;
    // Media pickers are browsing views: the fixed AI bar stays a search
    // exclusive, so hide it here (summary text itself is kept).
    summaryVisible = false;
    listHeading = '';
    listLinks = rows;
    lastLinks = rows;
    listCursor = 0;
    listStart = 0;
    setFocus('links');
    paintList(true);
    return true;
  }

  // ---- Phone-style gallery grid ----
  // All the page's photos in a navigable grid, like a phone's gallery:
  // arrows move, Enter opens the photo in the 60/40 media pane, Esc closes.
  // Bare /gallery uses this; /gallery <query> is a web image search.
  let galleryGrid = null;
  let galleryGridReturn = null; // cursor to restore when fullscreen closes
  // Slow-link discipline for grid fetches: ONE shared queue per kind with a
  // hard global bound (2 in flight total), a paint generation that drops work
  // for superseded windows (a held arrow key must not fetch scrolled-away
  // rows), per-URL in-flight dedupe, and an art cache so every URL is
  // fetched at most once per session.
  const GRID_FETCH_MAX = 2;
  let gridGen = 0; // bumped by every paint; stale queued tasks are dropped
  const gridThumbBusy = new Map(); // url -> Promise (real graphics, in flight)
  const gridAsciiBusy = new Map(); // url|width -> Promise (placeholders, in flight)
  const gridAsciiArts = new Map(); // url|width -> art (fetched once per session)
  const gridThumbQueue = [];
  const gridAsciiQueue = [];
  let gridThumbActive = 0;
  let gridAsciiActive = 0;

  function gridQueueDrain() {
    // Grid closed: resolve pending queued work so callers never hang.
    while (gridAsciiQueue.length) gridAsciiQueue.shift().done(null);
    while (gridThumbQueue.length) gridThumbQueue.shift().done();
  }
  function showGalleryGrid() {
    try {
      const imgs = lastMedia && Array.isArray(lastMedia.images) ? lastMedia.images : [];
      if (!imgs.length) return false;
      closeGallery();
      closeTheater();
      if (aiExpanded) collapseAi();
      galleryGrid = { cursor: 0 };
      setFocus('gallerygrid');
      paintGalleryGrid();
      return true;
    } catch { return false; }
  }
  function closeGalleryGrid() {
    if (!galleryGrid) return false;
    galleryGrid = null;
    gridQueueDrain();
    // Grid photos live on the graphics layer: delete them or they ghost
    // over whatever text paints next.
    try { tryClearImages(); } catch { /* best effort */ }
    setFocus('content');
    showText();
    return true;
  }
  function isGalleryGridOpen() { return !!galleryGrid; }
  function moveGalleryGrid(dx, dy) {
    if (!galleryGrid) return false;
    const g = galleryGridGeom();
    if (!g.n) return false;
    let cursor = galleryGrid.cursor;
    if (dx) cursor = Math.max(0, Math.min(g.n - 1, cursor + dx));
    if (dy) {
      // Rows have different cell counts now, so vertical movement picks the
      // cell whose horizontal center is nearest the one being left.
      let row = 0;
      for (let r = 0; r < g.rows.length; r++) {
        if (g.rows[r].cells.some((c) => c.i === cursor)) { row = r; break; }
      }
      const target = Math.max(0, Math.min(g.rows.length - 1, row + dy));
      if (target !== row) {
        const from = g.rows[row] ? g.rows[row].cells.find((c) => c.i === cursor) : null;
        const fx = from ? from.x + from.cw / 2 : 0;
        let best = g.rows[target].cells[0];
        let bestD = Infinity;
        for (const c of g.rows[target].cells) {
          const d = Math.abs(c.x + c.cw / 2 - fx);
          if (d < bestD) { bestD = d; best = c; }
        }
        if (best) cursor = best.i;
      }
    }
    galleryGrid.cursor = cursor;
    paintGalleryGrid();
    return true;
  }
  function openGalleryGridPhoto() {
    if (!galleryGrid) return false;
    const imgs = lastMedia && Array.isArray(lastMedia.images) ? lastMedia.images : [];
    const sel = imgs[galleryGrid.cursor];
    galleryGridReturn = galleryGrid.cursor;
    imageFsReturn = 'grid';
    galleryGrid = null;
    setFocus('content');
    if (sel) return showImageFullscreen(sel.src);
    return true;
  }

  // ---- Animated pet view ----
  // The pet bounces through its frames (mood pool, live list when it lands).
  // Any key closes it (it's a toy, not a trap). Easter eggs live in commands.
  let petState = null;
  function showPet(mood, frames) {
    try {
      let list = Array.isArray(frames) && frames.length ? frames : [];
      if (!list.length) {
        try { list = require('./pets').petFrames(mood); } catch { /* fall through */ }
      }
      if (!list.length) return false;
      closeGallery();
      closeTheater();
      if (aiExpanded) collapseAi();
      petState = { mood, frames: list, idx: 0, timer: null };
      setFocus('pet');
      petFrame();
      petState.timer = setInterval(() => {
        if (!petState) return;
        petState.idx = (petState.idx + 1) % petState.frames.length;
        petFrame();
      }, 700);
      if (petState.timer && petState.timer.unref) petState.timer.unref();
      return true;
    } catch { return false; }
  }
  function petFrame() {
    if (!petState) return;
    try {
      const face = petState.frames[petState.idx];
      const bob = petState.idx % 2 === 0 ? '' : '\n';
      const w = Math.max(20, (screen.width || 80) - 4);
      const cap = `${petState.mood} · ${petState.idx + 1}/${petState.frames.length} · any key closes`;
      body.setContent(`${centerArt(escTags(face), w)}\n${bob}${centerArt(escTags(cap), w)}`);
      scrollBodyTo(0);
      screen.render();
    } catch { /* paint is best-effort */ }
  }
  function setPetFrames(frames) {
    try {
      if (petState && Array.isArray(frames) && frames.length) {
        petState.frames = frames;
        petState.idx = 0;
        petFrame();
      }
    } catch { /* best effort */ }
  }
  function closePet() {
    if (!petState) return false;
    const t = petState.timer;
    petState = null;
    try { if (t) clearInterval(t); } catch { /* best effort */ }
    setFocus('content');
    showText();
    return true;
  }
  function isPetOpen() { return !!petState; }

  // ---- PDF split view ----
  // The PDF's page images in the right 60/40 pane (text sits on the left).
  // Ctrl+F fullscreen the current page. Esc closes back to the text.
  function showPdfSplit(pages) {
    try {
      if (!Array.isArray(pages) || !pages.length) return false;
      closeGallery();
      closeTheater();
      lastMedia = { images: pages.map((p) => ({ src: p, alt: 'PDF page' })), videos: [] };
      mediaKind = 'image';
      mediaCursor = 0;
      galleryOpen = true;
      layoutGallery();
      layoutBody();
      renderMedia(0).catch(() => {});
      updateHint();
      screen.render();
      return true;
    } catch { return false; }
  }

  // ---- Fullscreen image view ----
  // The photo fills the whole terminal (graphics overlay) or the body (large
  // ASCII on plain terms). Esc or Ctrl+F closes back to where it came from:
  // the gallery grid (cursor kept) or the 60/40 media pane.
  let imageFullscreen = null;
  let imageFsReturn = null; // 'pane' | 'grid' | null (plain content)
  let imageFsRotate = 0; // ctrl+r rotation, reset on every open
  function showImageFullscreen(src) {
    try {
      if (!src) return false;
      // closeGallery() restores the page and CONSUMES the content snapshot;
      // re-capture it right after so Esc can put the page back once the
      // fullscreen paint has replaced the body (the real bug: the web
      // content was gone after exiting the fullscreen). Only when the pane
      // was actually open — photo stepping re-enters here with the pane
      // already closed, and must not snapshot the fullscreen leftovers.
      const fromPane = imageFsReturn === 'pane' && galleryOpen;
      closeGallery();
      closeTheater();
      if (fromPane) { try { snapshotContentView(); } catch { /* best effort */ } }
      // Grid/pane photos are graphics-layer images: delete them before the
      // fullscreen paint or they smear over it.
      try { tryClearImages(); } catch { /* best effort */ }
      imageFullscreen = src;
      imageFsRotate = 0;
      setFocus('imagefs');
      paintImageFullscreen();
      return true;
    } catch { return false; }
  }
  function closeImageFullscreen() {
    if (!imageFullscreen) return false;
    imageFullscreen = null;
    // Back to the 60/40 pane when Ctrl+F came from there (PDF pages too).
    if (imageFsReturn === 'pane') {
      imageFsReturn = null;
      galleryGridReturn = null;
      try { tryClearImages(); } catch { /* best effort */ }
      // The fullscreen paint replaced the webview with blank+hint lines.
      // Put the real page back BEFORE re-opening the pane and keep the
      // original snapshot (real bug: after Esc the web content was gone —
      // openGallery only repaints when focus is already 'content', and a
      // re-snapshot here would capture the fullscreen leftovers).
      try { if (contentSnapshot) restoreContentView(); } catch { /* best effort */ }
      // Re-capture the restored page so a later pane-Esc still returns to
      // exactly this view (restoreContentView consumed the snapshot).
      try { snapshotContentView(); } catch { /* best effort */ }
      const r = openGallery(mediaCursor, { keepSnapshot: true });
      if (r !== 'no-media') return true;
      setFocus('content');
      showText();
      return true;
    }
    // Back to the gallery grid if we opened from it (same cursor).
    if (galleryGridReturn !== null && lastMedia && Array.isArray(lastMedia.images) && lastMedia.images.length) {
      imageFsReturn = null;
      galleryGrid = { cursor: galleryGridReturn };
      galleryGridReturn = null;
      setFocus('gallerygrid');
      try { paintGalleryGrid(); } catch { /* best effort */ }
      return true;
    }
    imageFsReturn = null;
    galleryGridReturn = null;
    try { tryClearImages(); } catch { /* best effort */ }
    setFocus('content');
    showText();
    return true;
  }
  function isImageFullscreen() { return !!imageFullscreen; }
  function paintImageFullscreen() {
    if (!imageFullscreen) return;
    try {
      const src = imageFullscreen;
      const W = screen.width || 80;
      const H = screen.height || 24;
      let hint = 'Esc / ctrl+f close · ctrl+r rotate';
      try {
        const n = lastMedia && Array.isArray(lastMedia.images) ? lastMedia.images.length : 0;
        if (n > 1) hint = 'Esc / ctrl+f close · ←/→ photos · ctrl+r rotate';
      } catch { /* plain hint stands */ }
      let mode = 'ascii';
      try { mode = bestImageMode(); } catch { /* ascii stands */ }
      if (mode !== 'ascii') {
        try {
          // Anchor at the body's absolute top-left; terminal row 0/col 0 is
          // the omnibox row and an invalid cursor address — never paint there.
          const lpos = body.lpos || null;
          const row = Math.max(1, (lpos ? lpos.yi : 0) + 1);
          const col = Math.max(1, (lpos ? lpos.xi : 0) + 1);
          const a = { row, col, cols: Math.max(10, W - col - 1), rows: Math.max(6, H - row - 2) };
          // Hint on the LAST body line so the photo never covers it.
          const bodyLines = Math.max(1, (body.height || Math.max(4, H - 4)) - 1);
          body.setContent(`${'\n'.repeat(bodyLines - 1)}${centerArt(escTags(hint), W)}`);
          scrollBodyTo(0);
          screen.render();
          const rot = imageFsRotate;
          const p = mode === 'kitty'
            ? showThumbnail(src, { ...a, cap: false, cache: true, center: true, rotate: rot })
            : showIterm2(src, { row: a.row, col: a.col, width: a.cols, height: Math.max(4, a.rows - 1), cache: true, center: true, rotate: rot });
          p.then((ok) => {
            // A rotation or another photo supersedes this result.
            if (ok || imageFullscreen !== src || imageFsRotate !== rot) return;
            // Graphics terminal: a failed photo is a plain line, never ASCII.
            try {
              body.setContent(`${'\n'.repeat(bodyLines - 1)}${centerArt(escTags('Image could not be loaded'), W)}`);
              screen.render();
            } catch { /* best effort */ }
          }).catch(() => {});
          return;
        } catch {
          // Graphics-capable but setup failed: plain error, never ASCII.
          try {
            body.setContent(`\n\n${centerArt(escTags('Image could not be loaded'), W)}\n${centerArt(escTags(hint), W)}`);
            scrollBodyTo(0);
            screen.render();
          } catch { /* best effort */ }
          return;
        }
      }
      // ASCII fallback only for terminals with no image protocol.
      try {
        showText();
        const cur = typeof body.getContent === 'function' ? body.getContent() : body.content || '';
        body.setContent(`${cur}\n\n[FULL: ${escTags(src)}]\n(loading…)`);
        screen.render();
        getImageAscii(src, { width: Math.max(24, W - 6), maxHeight: Math.max(10, H - 6) }).then((art) => {
          try {
            if (aiExpanded) return;
            const base = typeof body.getContent === 'function' ? body.getContent() : body.content || '';
            body.setContent(art ? `${centerArt(escTags(art), W)}\n${centerArt(escTags(hint), W)}` : `${base}\n[no preview — ${escTags(recommendTerminal() || 'fetch failed')}]`);
            screen.render();
          } catch { /* best effort */ }
        }).catch(() => {});
      } catch { /* hint is best-effort */ }
    } catch { /* best effort */ }
  }
  // Grid geometry: a responsive "flex row" table. Every band has the same
  // photo height; each cell's WIDTH comes from its own aspect ratio — a
  // landscape shot spans more columns, a portrait keeps a narrow column and
  // uses the full band height. Rows pack left→right and share out the
  // leftover columns, so the right edge lines up like a real table instead
  // of leaving a ragged hole. Labels ride in the rounded top border.
  const GRID_ART_ROWS = 5; // photo cells per band
  const GRID_BAND = GRID_ART_ROWS + 2; // + rounded top/bottom borders

  function gridImageAspect(im) {
    const w = Number(im && im.w);
    const h = Number(im && im.h);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      // Clamp extremes: one 10:1 banner or 1:10 strip must not own a row.
      return Math.max(0.45, Math.min(3, w / h));
    }
    return 1.5; // unknown dimensions: a classic photo
  }

  function gridImageName(im, i) {
    let name = String((im && im.alt) || '').replace(/\s+/g, ' ').trim();
    if (!name) {
      const src = String((im && im.src) || '');
      if (src.startsWith('data:')) return `image ${i + 1}`;
      try {
        const u = new URL(src);
        name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
      } catch {
        name = src.split('/').filter(Boolean).pop() || '';
      }
      name = name.replace(/[?#].*$/, '').replace(/\.[a-z0-9]{2,5}$/i, '');
    }
    return name || `image ${i + 1}`;
  }

  function galleryGridGeom() {
    const imgs = lastMedia && Array.isArray(lastMedia.images) ? lastMedia.images : [];
    const n = imgs.length;
    const screenW = Math.max(20, screen.width || 80);
    // The body lives inside the frame ring; measuring the live body width
    // (not the screen) is what keeps the last border from wrapping.
    let W = Math.max(20, screenW - 4);
    try {
      const bw = Number(body.width);
      if (Number.isFinite(bw) && bw >= 20) W = Math.min(W, bw);
    } catch { /* keep the screen-based width */ }
    const rows = [];
    let band = [];
    let used = 0;
    for (let i = 0; i < n; i++) {
      const iw = Math.max(10, Math.min(W - 6, Math.round(2 * gridImageAspect(imgs[i]) * GRID_ART_ROWS)));
      const cw = iw + 2;
      if (band.length && used + cw > W) {
        // A little overflow: shrink the row instead of wrapping one photo
        // (wrapping would stretch the remaining four into banner boxes and
        // cost a whole extra band). The photo count stays denser this way.
        if (band.length >= 2 && (used + cw) <= W * 1.12) {
          band.push({ i, cw });
          rows.push({ cells: band, used: used + cw });
          band = [];
          used = 0;
          continue;
        }
        rows.push({ cells: band, used });
        band = [];
        used = 0;
      }
      band.push({ i, cw });
      used += cw;
    }
    if (band.length) rows.push({ cells: band, used });
    for (const row of rows) {
      // Justify multi-cell rows PROPORTIONALLY: equal shares would flatten
      // every photo to the same width and erase the aspect-aware sizing.
      // Overfull-by-a-hair rows shrink to fit; short last rows (scale > 1.6)
      // stay ragged rather than stretching a couple of portraits into
      // banner-width empty frames.
      const scale = row.used > 0 ? W / row.used : 1;
      if (row.cells.length >= 2 && Math.abs(scale - 1) > 0.001 && scale <= 1.6) {
        const parts = row.cells.map((c) => {
          const exact = c.cw * scale;
          return { c, w: Math.floor(exact), frac: exact - Math.floor(exact) };
        });
        let rem = W - parts.reduce((sum, p) => sum + p.w, 0);
        parts.sort((a, b) => b.frac - a.frac);
        for (let k = 0; rem > 0; k = (k + 1) % parts.length) {
          parts[k].w += 1;
          rem--;
        }
        for (const p of parts) p.c.cw = p.w;
      }
      let x = 0;
      for (const cell of row.cells) {
        cell.x = x;
        cell.iw = Math.max(6, cell.cw - 2);
        x += cell.cw;
      }
    }
    const totalRows = Math.max(1, rows.length);
    let visRows;
    try {
      const bh = Number(body.height) > 0 ? Number(body.height) : 18;
      visRows = Math.max(1, Math.floor((bh - 2) / GRID_BAND));
    } catch {
      visRows = 3;
    }
    visRows = Math.max(1, Math.min(visRows, totalRows));
    const cursor = galleryGrid ? galleryGrid.cursor : 0;
    let cursorRow = 0;
    for (let r = 0; r < rows.length; r++) {
      if (rows[r].cells.some((c) => c.i === cursor)) { cursorRow = r; break; }
    }
    let startRow = 0;
    if (totalRows > visRows) {
      startRow = Math.max(0, Math.min(cursorRow - Math.floor(visRows / 2), totalRows - visRows));
    }
    return { imgs, n, W, rows, totalRows, visRows, startRow, cursorRow };
  }

  function gridVisibleCells(g, startRow) {
    const out = [];
    for (let rr = 0; rr < g.visRows; rr++) {
      const band = g.rows[startRow + rr];
      if (!band) break;
      for (const cell of band.cells) {
        const im = g.imgs[cell.i];
        if (im && im.src) out.push({ i: cell.i, rr, cell, src: im.src });
      }
    }
    return out;
  }

  // ASCII placeholders: VISIBLE cells only, two downloads in flight across
  // the whole grid — a 40-photo gallery must never open 40 sockets at once,
  // and neither must a held arrow key. Cached art is reused instantly.
  function gridFetchAscii(g, cells, gen) {
    return new Promise((resolve) => {
      const arts = {};
      if (!cells.length) { resolve(arts); return; }
      let left = cells.length;
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(arts); } };
      for (const view of cells) {
        // Width AND height in the key: a row-height change must not serve
        // art rendered for the old box (the stale-art bug on resize).
        const key = `${view.src}|${view.cell.iw}|${GRID_ART_ROWS}`;
        if (gridAsciiArts.has(key)) {
          arts[view.i] = gridAsciiArts.get(key);
          if (--left <= 0) finish();
          continue;
        }
        gridAsciiQueue.push({
          view, g, gen, key,
          done: (art) => {
            if (art) {
              arts[view.i] = art;
              if (gridAsciiArts.size < 200) gridAsciiArts.set(key, art);
            }
            if (--left <= 0) finish();
          },
        });
      }
      if (!done) gridAsciiPump();
    });
  }

  function gridAsciiPump() {
    while (gridAsciiActive < GRID_FETCH_MAX && gridAsciiQueue.length) {
      const task = gridAsciiQueue.shift();
      // Closed grid or superseded window: drop it (the caller's promise
      // still resolves; draws are token-guarded anyway).
      if (!galleryGrid || task.gen !== gridGen) { task.done(null); continue; }
      const cached = gridAsciiArts.get(task.key);
      if (cached) { task.done(cached); continue; }
      gridAsciiActive++;
      let p = gridAsciiBusy.get(task.key);
      if (!p) {
        p = getImageAscii(task.view.src, { width: task.view.cell.iw, maxHeight: GRID_ART_ROWS })
          .catch(() => null)
          .finally(() => gridAsciiBusy.delete(task.key));
        gridAsciiBusy.set(task.key, p);
      }
      p.then((art) => {
        gridAsciiActive--;
        task.done(art);
        gridAsciiPump();
      });
    }
  }

  // Real photos for graphics terminals: kitty/iTerm2 thumbnails placed on
  // the grid cells — cursor cell first, through the same shared two-slot
  // queue as the placeholders (cache:true so each URL downloads once and
  // repaints re-emit from memory). Each visible cell is queued once per
  // paint; the per-URL in-flight map dedupes the network/decode work.
  function paintGalleryGridGraphics(g, startRow, gen) {
    try {
      const mode = bestImageMode();
      if (mode === 'ascii' || !galleryGrid) return;
      const cells = gridVisibleCells(g, startRow);
      if (!cells.length) return;
      const lpos = body.lpos;
      // Body-relative absolute anchors; if layout hasn't run (headless),
      // fall back to plausible numbers so emissions stay deterministic.
      const topAbs = lpos ? lpos.yi + 1 : 2;
      const leftAbs = lpos ? lpos.xi + 1 : 1;
      const cur = galleryGrid.cursor;
      cells.sort((a, b) => (a.i === cur ? -1 : b.i === cur ? 1 : 0));
      for (const cell of cells) {
        gridThumbQueue.push({ cell, g, gen, mode, topAbs, leftAbs, done: () => {} });
      }
      gridThumbPump();
    } catch { /* best effort */ }
  }

  function gridThumbPump() {
    while (gridThumbActive < GRID_FETCH_MAX && gridThumbQueue.length) {
      const task = gridThumbQueue.shift();
      if (!galleryGrid || task.gen !== gridGen) { task.done(); continue; }
      const { mode, topAbs, leftAbs } = task;
      const view = task.cell;
      // Header (2 lines) + this band's top border + the band's first art row.
      const row = topAbs + 2 + view.rr * GRID_BAND + 1;
      const col = leftAbs + view.cell.x + 1;
      gridThumbActive++;
      let p = gridThumbBusy.get(view.src);
      if (!p) {
        p = (mode === 'iterm2'
          ? showIterm2(view.src, { row, col, width: view.cell.iw, height: GRID_ART_ROWS, cache: true, center: true })
          : showThumbnail(view.src, { row, col, cols: view.cell.iw, rows: GRID_ART_ROWS, cache: true, center: true })
        ).catch(() => false).finally(() => gridThumbBusy.delete(view.src));
        gridThumbBusy.set(view.src, p);
      }
      p.then(() => { gridThumbActive--; task.done(); gridThumbPump(); });
    }
  }

  function paintGalleryGrid() {
    if (!galleryGrid) return;
    try {
      const g = galleryGridGeom();
      const { n, totalRows, visRows, startRow } = g;
      galleryGrid.total = n;
      const cells = gridVisibleCells(g, startRow);
      const gfxMode = bestImageMode() !== 'ascii';
      // Every paint supersedes the last: queued fetches for the old window
      // are dropped and stale draws (old fetch resolving late) are ignored,
      // so a fast scroll never paints the previous window back.
      const gen = ++gridGen;
      const token = (galleryGrid.token = (galleryGrid.token || 0) + 1);
      const head = totalRows > visRows
        ? `Photos (${n}) — rows ${startRow + 1}-${Math.min(totalRows, startRow + visRows)}/${totalRows} · arrows move · enter open · ctrl+f zoom · esc close`
        : `Photos (${n}) — arrows move · enter open · ctrl+f zoom · esc close`;
      const draw = (arts) => {
        if (!galleryGrid || galleryGrid.token !== token) return; // superseded
        const lines = [head, ''];
        for (let rr = 0; rr < visRows; rr++) {
          const band = g.rows[startRow + rr];
          if (!band) break;
          const top = [];
          const mids = Array.from({ length: GRID_ART_ROWS }, () => []);
          const bot = [];
          for (const cell of band.cells) {
            const i = cell.i;
            const cur = i === galleryGrid.cursor;
            const color = cur ? theme.accent : theme.border;
            const name = gridImageName(g.imgs[i], i);
            const num = `${cur ? '>' : ' '}${i + 1}.`;
            const maxLabel = Math.max(1, cell.cw - 5);
            // Narrow (portrait) cells drop the name rather than showing a
            // useless single letter + ellipsis; the number stays.
            const room = maxLabel - num.length - 1;
            const label = room >= 3 ? `${num} ${truncateVisual(name, room)}` : num;
            const shown = truncateVisual(label, maxLabel);
            const labelW = visibleCells(shown);
            const dashes = Math.max(1, cell.cw - 3 - labelW);
            top.push(`{${color}-fg}╭─${escTags(shown)}${'─'.repeat(dashes)}╮{/}`);
            const artLines = String((arts && arts[i]) || '').split('\n');
            // Center the art block both ways (photos are narrower/taller
            // than their cells; graphics mode centers too, so both agree).
            const artH = Math.min(GRID_ART_ROWS, artLines.length);
            const topPad = Math.max(0, Math.floor((GRID_ART_ROWS - artH) / 2));
            for (let r = 0; r < GRID_ART_ROWS; r++) {
              const raw = (r >= topPad && r < topPad + artH) ? (artLines[r - topPad] || '') : '';
              const w = visibleCells(raw);
              const left = Math.max(0, Math.floor((cell.iw - w) / 2));
              const right = Math.max(0, cell.iw - w - left);
              mids[r].push(`{${color}-fg}│{/}${' '.repeat(left)}${escTags(raw)}${' '.repeat(right)}{${color}-fg}│{/}`);
            }
            bot.push(`{${color}-fg}╰${'─'.repeat(Math.max(1, cell.cw - 2))}╯{/}`);
          }
          lines.push(top.join(''), ...mids.map((m) => m.join('')), bot.join(''));
        }
        body.setContent(lines.join('\n'));
        // scrollBodyTo clears the graphics layer; photos are (re)emitted
        // right after the render below so text and images agree.
        scrollBodyTo(0);
        screen.render();
        if (gfxMode) paintGalleryGridGraphics(g, startRow, gen);
      };
      draw({});
      // Graphics terminals get photos ONLY: no ASCII fetch and no second
      // text repaint. The late ASCII draw used to scroll the body (which
      // clears the graphics layer) and paint art over photos that had
      // already arrived — the load/unload ASCII→image flicker. ASCII stays
      // the fallback for terminals that cannot render images at all.
      if (gfxMode || !cells.length) return;
      gridFetchAscii(g, cells, gen).then((arts) => {
        try { draw(arts); } catch { /* best effort */ }
      }).catch(() => {});
    } catch { /* best effort */ }
  }
  // bot walls. Rows are quick links + recent history + bookmarks; the
  // omnibox above stays the search box. Enter opens the highlighted row.
  //
  // The sticky SCOPE PICKER rides in the heading row: [web] >wiki >gh >so
  // >hn, cycled with ←/→, always visible while the dashboard is open. The
  // picked scope is what makes a query open that site's search (Wikipedia:
  // its top result directly) — never "whatever row is highlighted".
  const scopesMod = require('./scopes');
  function homeHeading() {
    const chips = scopesMod.scopeKeys().map((k) => {
      const hint = scopesMod.scopeHint(k);
      return k === homeScope ? `[${hint}]` : hint;
    });
    // The stamp refreshes with the dashboard (and on the clock tick while
    // the dashboard is on screen), so the heading doubles as a clock.
    return `Start · ${formatDateShort()} ${formatClock()} · search in: ${chips.join(' ')} — ←/→ pick · Enter opens (${listLinks.length})`;
  }
  function cycleHomeScope(dir) {
    const keys = scopesMod.scopeKeys();
    const idx = Math.max(0, keys.indexOf(homeScope));
    const next = keys[(idx + (dir >= 0 ? 1 : keys.length - 1)) % keys.length];
    homeScope = next;
    listHeading = homeHeading();
    try { paintList(true); } catch { /* best effort */ }
    try { screen.render(); } catch { /* best effort */ }
    return homeScope;
  }
  function getHomeScope() {
    return homeScope;
  }
  function setHomeScope(key) {
    const keys = scopesMod.scopeKeys();
    homeScope = keys.includes(String(key || '')) ? String(key) : '';
    if (homeView) {
      listHeading = homeHeading();
      try { paintList(true); } catch { /* best effort */ }
      try { screen.render(); } catch { /* best effort */ }
    }
    return homeScope;
  }
  function showHome(rows) {
    // The dashboard is a real view: a page snapshot underneath no longer
    // applies (Esc here must not resurrect an older article).
    clearContentView();
    clearMediaSplit();
    closeGallery();
    closeTheater();
    if (aiExpanded) collapseAi();
    ytMode = false;
    ytQuery = '';
    lastAi = '';
    lastPretty = null;
    lastText = '';
    lastSpans = null;
    lastLinks = [];
    contentLinkLines = [];
    summaryVisible = false;
    const list = (Array.isArray(rows) ? rows : []).map(safeRow).filter(Boolean);
    listLinks = list;
    lastLinks = list;
    listCursor = 0;
    listStart = 0;
    homeView = true;
    listHeading = homeHeading();
    updateHint();
    setFocus('links');
    paintList(true);
    layoutBody();
    screen.render();
    return true;
  }

  // Find-in-page stats for the footer (last search): count + lines scanned
  // + the word. The "/find" response reads like a browser find bar.
  let lastFind = { count: 0, lines: 0, word: '' };
  function findStats() { return { ...lastFind }; }

  // Find-in-page: highlight every case-insensitive hit in the CURRENT
  // body paint (boxes preserved, no newlines added so the click map stays
  // valid). Returns the hit count (0 = nothing painted — lists and empty
  // views are never clobbered). Never destroys the article layout.
  function findInPage(query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return 0;
    lastFind = { count: 0, lines: 0, word: String(query || '').trim().slice(0, 60) };
    try {
      // Only articles are searchable: finding over a list must not replace
      // the list with stale text (P1-3). Slash-typed /find uses effFocus.
      const fv = effFocus();
      if (fv !== 'content') return 0;
      const hay = getPageText();
      if (!String(hay || '').toLowerCase().includes(needle)) return 0;
      let cur = '';
      try {
        cur = typeof body.getContent === 'function' ? body.getContent() : body.content || '';
      } catch { cur = ''; }
      if (!String(cur || '').toLowerCase().includes(needle)) {
        // Body is not the article (e.g. info view): repaint the article
        // first so highlights land on the real layout, not stale text.
        try { showText(); } catch { /* best effort */ }
        try {
          cur = typeof body.getContent === 'function' ? body.getContent() : body.content || '';
        } catch { cur = ''; }
        if (!String(cur || '').toLowerCase().includes(needle)) return 0;
      }
      let count = 0;
      const paintLine = (line) => {
        const out = [];
        const low = String(line).toLowerCase();
        let i = 0;
        for (;;) {
          const at = low.indexOf(needle, i);
          if (at < 0) { out.push(String(line).slice(i)); break; }
          count++;
          out.push(String(line).slice(i, at));
          out.push(`{bold}${String(line).slice(at, at + needle.length)}{/}`);
          i = at + needle.length;
        }
        return out.join('');
      };
      setFocus('content');
      const lines = String(cur).split('\n');
      body.setContent(lines.map(paintLine).join('\n') || '(no content)');
      scrollBodyTo(0);
      lastFind = { count, lines: lines.length, word: String(query || '').trim().slice(0, 60) };
      return count;
    } catch {
      return 0;
    }
  }

  // Video picker: every detected video with its page-given title
  // (YouTube title, anime episode name, og:title...). Selecting a row and
  // pressing Enter plays it in a separate mpv window via onPlayVideo.
  // /watch <n> calls playVideoAt(n) for direct number selection.
  function videoRows() {
    const vids = lastMedia && Array.isArray(lastMedia.videos) ? lastMedia.videos : [];
    return vids.map((v, i) => {
      let host = '';
      try { host = new URL(v.src).hostname.replace(/^www\./, ''); } catch { /* blank */ }
      const label = (v.title || '').trim() || host || `video ${i + 1}`;
      // thumb carries the poster so Tab previews the same video Enter plays.
      return { title: `${i + 1}. ${label}`.slice(0, 90), url: v.src, domain: host, thumb: v.poster || null, video: true };
    });
  }

  // mark ({ url, fallbackUrl }) flags the now-playing row with ▶ — the
  // live mpv answer first, last-known head as fallback (direct-resolve
  // plays hand mpv a stream URL that never matches a row).
  function matchVideoUrl(a, b) {
    if (!a || !b) return false;
    try {
      const yt = require('./yt');
      if (yt && typeof yt.sameVideoUrl === 'function' && yt.sameVideoUrl(a, b)) return true;
    } catch { /* fall through to exact */ }
    try {
      const x = String(a).split('#')[0];
      const y = String(b).split('#')[0];
      return !!x && x === y;
    } catch {
      return false;
    }
  }

  function showVideos(mark) {
    const rows = videoRows().map((r) => {
      try {
        if (mark && r && r.url && (matchVideoUrl(r.url, mark.url) || (mark.fallbackUrl && matchVideoUrl(r.url, mark.fallbackUrl)))) {
          return { ...r, title: `▶ ${r.title}`, nowPlaying: true };
        }
      } catch { /* unmarked */ }
      return r;
    });
    if (rows.length === 0) return false;
    // Opened from an article: remember it so Esc returns to the page.
    if (focused === 'content') snapshotContentView();
    closeGallery();
    closeTheater();
    ytMode = false;
    ytQuery = '';
    lastAi = '';
    lastPretty = null;
    summaryVisible = false;
    listHeading = '';
    listLinks = rows;
    listCursor = 0;
    listStart = 0;
    setFocus('links');
    paintList(true);
    return true;
  }

  // The list actually on screen (P1-4): link picker / YT picker /
  // gallery / videos when browsing a list, article links when reading,
  // suggestions only when truly idle in the bar. Every N-based command
  // (/copy, /download, /watch, /img) resolves against this — never a
  // stale or hidden list.
  function visibleRows() {
    try {
      const fv = effFocus();
      if (fv === 'links') return Array.isArray(listLinks) ? [...listLinks] : [];
      if (fv === 'content') return Array.isArray(lastLinks) ? [...lastLinks] : [];
      if (fv === 'input') return Array.isArray(suggestRows) ? [...suggestRows] : [];
      return Array.isArray(listLinks) ? [...listLinks] : [];
    } catch { return []; }
  }

  // Row accessor for /copy (and friends): Nth row (1-based) of the
  // currently visible list, or the highlighted row when n is omitted.
  // Tail ("load more") rows and rows without URLs resolve to null.
  function linkAt(n) {
    try {
      // Slash-typed over an open list: serve the list underneath, not the
      // bar's suggestion rows (see submitFocus).
      const fv = effFocus();
      if (n === undefined || n === null || n === '') {
        if (fv === 'input') {
          const r = suggestRows[listCursor] || null;
          return r && r.url ? { title: r.title || r.url, url: r.url } : null;
        }
        if (fv === 'content') return null; // articles: no highlight — use /copy <n>
        const link = highlightedLink();
        return link && link.url ? { title: link.title || link.url, url: link.url } : null;
      }
      const rows = visibleRows();
      const idx = Number(n) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) return null;
      const r = rows[idx];
      const url = r && (r.url || null);
      if (!url) return null;
      return { title: (r.title || r.label || url).slice(0, 120), url };
    } catch {
      return null;
    }
  }

  // Play video N (1-based as shown) — the pick only, never the rest of
  // the list. Resolves against the visible list first (YT/gallery/videos
  // picker the user is looking at), then page media. Returns URL.
  function playVideoAt(n) {
    try {
      const idx = Number(n) - 1;
      if (!Number.isInteger(idx) || idx < 0) return null;
      const fv = effFocus();
      if (fv === 'links' && Array.isArray(listLinks) && listLinks[idx]) {
        const r = listLinks[idx];
        const u = r && r.url ? String(r.url) : '';
        const isVideo = !!(r && (r.video || WATCH_URL.test(u) || DIRECT_MEDIA.test(u)));
        if (u && /^https?:\/\//i.test(u) && (isVideo || ytMode)) {
          if (onPlayVideo) onPlayVideo(u, [], r && r.title);
          return u;
        }
        // Non-video row in a mixed list: fall through to page media only
        // when the row itself is not playable (keeps old /watch semantics).
        if (u && isVideo) {
          if (onPlayVideo) onPlayVideo(u, [{ url: u, title: String((r && r.title) || '') }], r && r.title);
          return u;
        }
      }
      const vids = lastMedia && Array.isArray(lastMedia.videos) ? lastMedia.videos : [];
      if (idx < 0 || idx >= vids.length) return null;
      const url = vids[idx].src;
      if (url && onPlayVideo) onPlayVideo(url, [], vids[idx].title);
      return url;
    } catch { return null; }
  }

  // Render image N (1-based as shown) in the 60/40 gallery pane.
  // Resolves against the visible image list first, then page media.
  // Returns 'ok' | 'no-media'.
  function showImageAt(n) {
    try {
      const idx = Number(n) - 1;
      if (!Number.isInteger(idx) || idx < 0) return 'no-media';
      const fv = effFocus();
      if (fv === 'links' && Array.isArray(listLinks) && listLinks.length) {
        const r = listLinks[idx];
        if (r && r.url) {
          // Gallery picker rows carry image:true; YT/video rows are not images.
          if (r.image) {
            const st = openGalleryByUrl(r.url);
            if (st === 'ok') return 'ok';
          } else if (r.thumb && !WATCH_URL.test(String(r.url))) {
            // Search-result thumbnail row: fall through to page media only
            // when it is not a page image.
          } else if (!r.video && /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i.test(String(r.url))) {
            const st = openGalleryByUrl(r.url);
            if (st === 'ok') return 'ok';
          }
          // Visible non-image row: do not silently open page image N.
          if (ytMode || r.video) return 'no-media';
        }
      }
      const imgs = lastMedia && Array.isArray(lastMedia.images) ? lastMedia.images : [];
      if (idx < 0 || idx >= imgs.length) return 'no-media';
      return openGallery(idx);
    } catch { return 'no-media'; }
  }

  // Download target for /download N: the exact visible row (P1-4), or page
  // media (video preferred) when reading an article. Returns URL or null.
  function downloadTargetAt(n) {
    try {
      const idx = Number(n) - 1;
      if (!Number.isInteger(idx) || idx < 0) return null;
      const fv = effFocus();
      if (fv === 'links' && Array.isArray(listLinks) && listLinks[idx] && listLinks[idx].url) {
        return String(listLinks[idx].url);
      }
      if (fv === 'content') {
        const pick = (arr, i) => (Array.isArray(arr) ? arr[Number(i) - 1] : null);
        try {
          const im = pick((galleryRows() || []).map((r) => r.url), n) || null;
          const vd = pick((videoRows() || []).map((r) => r.url), n) || null;
          return vd || im || null;
        } catch { return null; }
      }
      return null;
    } catch { return null; }
  }

  // The image the user is actually looking at right now:
  //   1. gallery pane open -> mediaCursor image (exact),
  //   2. inline art shown on the article (mediaCursor >= 0) -> that image,
  //   3. otherwise the page's first/hero image.
  // Returns the URL string or null. Never throws.
  function currentImageUrl() {
    try {
      const imgs = lastMedia && Array.isArray(lastMedia.images) ? lastMedia.images : [];
      if (!imgs.length) return null;
      const i = mediaCursor >= 0 && mediaCursor < imgs.length ? mediaCursor : 0;
      const im = imgs[i];
      return im && im.src ? String(im.src) : null;
    } catch {
      return null;
    }
  }

  // Initial render: header, separators, plain bar, empty body.
  // No suggestions on boot — rows appear only while typing.
  repaintChrome();
  updateHint();
  paintShield();
  layoutBody();
  omni.setValue('');
  focusField();
  screen.render();

  startClock();
  return {
    setURL,
    renderSuggestRows,
    showLinkPicker,
    showYouTubePicker,
    isYouTubeMode,
    setCenterContent,
    showInfo,
    toast,
    showCaptcha,
    redirectToBrowser,
    showGame,
    closeGame,
    isGameOpen,
    setNowPlaying,
    resetFocus,
    isPickerOpen,
    showThemes,
    closeThemes,
    isThemesOpen,
    setGlow,
    isGlowOn,
    showSettings,
    closeSettings,
    isSettingsOpen,
    paintSettings,
    applyTheme,
    setPageSize,
    appendLinks,
    markFillStalled,
    setBlockedCount,
    currentTitle,
    setBookmarked,
    findStats,
    showChoice,
    isChoiceOpen,
    setReadMode,
    showLoading,
    setLoadingStage,
    hideLoading,
    isLoading,
    showVisualizer,
    hideVisualizer,
    isVisualizerOn,
    setVizPaused,
    isVizPaused,
    setVizEnergy,
    getVizEnergy,
    setVizBands,
    getVizBands,
    loaderFrame,
    showLoginForm,
    playHighlightedVideo,
    showPageImage,
    showGallery,
    showPdfSplit,
    showHome,
    showVideos,
    playVideoAt,
    showImageAt,
    showGalleryGrid,
    closeGalleryGrid,
    isGalleryGridOpen,
    showImageFullscreen,
    isImageFullscreen,
    isHomeOpen: () => !!homeView,
    getHomeScope,
    setHomeScope,
    cycleHomeScope,
    showPet,
    setPetFrames,
    closePet,
    isPetOpen,
    downloadTargetAt,
    currentImageUrl,
    visibleRows,
    linkAt,
    isGalleryOpen,
    isTheaterOpen,
    isSplitVisible: () => {
      try { return !splitDiv.hidden; } catch { return false; }
    },
    isCommandPaletteVisible: () => {
      try { return !cmdBar.hidden; } catch { return false; }
    },
    galleryRows,
    videoRows,
    findInPage,
    showAiSummary,
    isAiVisible,
    showGeminiView,
    getPageText,
    setStatus,
    clearStatus,
    flashStatus,
    setHomeMode,
    getThemeName: () => theme.name,
    isTruecolor: () => !!truecolorOn,
    setIdentity,
    bodyInnerWidth,
    setAiAnswer,
    setAiAnswerPending,
    setAiAnswerError,
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Clock text for the footer badge: 24h HH:MM, zero-padded. Pure so tests
// can pin the format without a fake clock.
function formatClock(d) {
  const t = d instanceof Date ? d : new Date();
  return `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
}

// Compact date for the dashboard heading: "Fri 16 Oct". Pure.
function formatDateShort(d) {
  const t = d instanceof Date ? d : new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[t.getDay()]} ${t.getDate()} ${mons[t.getMonth()]}`;
}

module.exports = { createUI, rowIndexFromY, loaderFrame, tidyAnswer, truncateVisual, centerTagged, waveFrame, waveFrames, waveLineTagged, vizLineTagged, vizEnergyLine, vizEnergyToStep, renderVizBands, themeGrid, enableTruecolor, hasTruecolor, hexToRgbTriplet, WAVE_MOTIF, WAVE_CYCLE, WAVE_FRAMES, WAVE_MS, VIZ_FRAMES, VIZ_MS, VIZ_GAIN_STEPS, formatClock, formatDateShort };
