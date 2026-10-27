'use strict';
/* Graphics-layer gallery tests. Fresh process on purpose: src/image.js is
 * stubbed BEFORE src/ui.js is required (ui destructures its bindings at
 * load), so nothing tries a real kitty escape or a real download — every
 * emission is recorded. The blessed screen drives the real key handling:
 * Tab opens the 60/40 pane, Ctrl+F fullscreens, Esc restores.
 *
 * Slow-link rules under test: visible cells only, one fetch per URL,
 * at most 2 in flight, cursor cell first, cache:true everywhere. */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ---- stub image.js before ui loads it ----
const calls = {
  thumbs: [], ascii: [], cleared: 0,
  maxAsciiInFlight: 0, asciiInFlight: 0,
  maxThumbInFlight: 0, thumbInFlight: 0,
};
const fakeImage = {
  // Mutable terminal mode: tests flip this to 'ascii' to exercise the
  // no-graphics fallback without reloading src/ui.js (bindings are captured
  // at require time, so the functions must read the flag at call time).
  mode: 'kitty',
  detectImageSupport: () => (fakeImage.mode === 'kitty' ? 'kitty' : 'none'),
  detectGraphics: () => (fakeImage.mode === 'kitty' ? 'kitty' : 'none'),
  bestImageMode: () => (fakeImage.mode === 'kitty' ? 'kitty' : 'ascii'),
  detectSharp: () => true,
  recommendTerminal: () => null,
  kittyChunks: () => [],
  pngSize: () => null,
  fitOverlay: () => ({ cols: 10 }),
  clearImages: () => { calls.cleared++; },
  // bytesFor lets a single test make the pane take the graphics path
  // (default: no bytes → ASCII path, same as before).
  bytesFor: null,
  fetchBytes: async (url) => (fakeImage.bytesFor && String(url).includes(fakeImage.bytesFor) ? Buffer.from('png-bytes') : null),
  toDisplayPng: async (b) => b,
  showThumbnail: async (url, opts) => {
    calls.thumbs.push({ url, ...opts });
    calls.thumbInFlight++;
    calls.maxThumbInFlight = Math.max(calls.maxThumbInFlight, calls.thumbInFlight);
    await new Promise((r) => setTimeout(r, 5));
    calls.thumbInFlight--;
    return true;
  },
  showIterm2: async (url, opts) => fakeImage.showThumbnail(url, opts),
  getImageAscii: async (url) => {
    calls.ascii.push(url);
    calls.asciiInFlight++;
    calls.maxAsciiInFlight = Math.max(calls.maxAsciiInFlight, calls.asciiInFlight);
    await new Promise((r) => setTimeout(r, 5));
    calls.asciiInFlight--;
    return '░▒▓\n▓▒░';
  },
  prefetchImages: async () => {},
};
const imgPath = require.resolve('../src/image');
require.cache[imgPath] = { id: imgPath, filename: imgPath, loaded: true, exports: fakeImage };

const blessed = require('blessed');
const { createUI } = require('../src/ui');

let screens = [];
let uis = [];
function makeWiredUI() {
  const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 'gallery-test' });
  screens.push(screen);
  const ui = createUI(screen, {
    onOmniSubmit: () => {}, onSuggest: () => {}, onLinkPick: () => {},
    onPlayVideo: () => {}, onHistoryBack: () => {}, onHistoryForward: () => {},
    onEscape: () => {}, onQuit: () => {}, onSettingsChange: () => {},
  }, { theme: 'white', pageSize: 50 });
  uis.push(ui);
  return { screen, ui };
}
function resetCalls() {
  fakeImage.mode = 'kitty';
  calls.thumbs.length = 0;
  calls.ascii.length = 0;
  calls.cleared = 0;
  calls.maxAsciiInFlight = 0;
  calls.asciiInFlight = 0;
  calls.maxThumbInFlight = 0;
  calls.thumbInFlight = 0;
}
function bodyText(screen) {
  const texts = [];
  (function walk(el) {
    try {
      if (typeof el.getContent === 'function') texts.push(String(el.getContent()));
    } catch { /* hidden widgets */ }
    (el.children || []).forEach(walk);
  })(screen);
  return texts.join('\n');
}
const flush = () => new Promise((r) => setTimeout(r, 40));
const media = (n) => ({
  images: Array.from({ length: n }, (_, i) => ({ src: `https://img.example/i${i}.png`, alt: `photo ${i}` })),
  videos: [],
});
afterEach(() => {
  // Never leak the plain-terminal mode into the next test.
  fakeImage.mode = 'kitty';
  // Stop every instance's grid queues before destroying its screen: a
  // destroyed screen must not keep pumping fetches into the next test.
  for (const u of uis) { try { u.closeGalleryGrid(); } catch { /* gone */ } }
  for (const s of screens) { try { s.destroy(); } catch { /* gone */ } }
  screens = [];
  uis = [];
});

describe('gallery grid: text layer', () => {
  it('paints the photo counter, the cursor marker and the key hints', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(12));
    assert.equal(ui.showGalleryGrid(), true);
    assert.equal(ui.isGalleryGridOpen(), true);
    const body = bodyText(screen);
    assert.match(body, /Photos \(12\)/);
    assert.match(body, /ctrl\+f zoom/);
    assert.match(body, />1/, 'cursor marker on the first cell');
  });
  it('window text says which rows are on screen when the grid scrolls', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(120));
    ui.showGalleryGrid();
    // Move the cursor deep into the list: the window must follow it.
    for (let i = 0; i < 40; i++) screen.emit('keypress', null, { name: 'down', full: 'down' });
    const body = bodyText(screen);
    assert.match(body, /rows \d+-\d+\/\d+/, 'windowed header names the rows');
  });
});

describe('gallery grid: images only on graphics terminals', () => {
  it('never fetches ASCII; real thumbnails own the cells', async () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(12));
    resetCalls();
    ui.showGalleryGrid();
    await flush();
    assert.equal(calls.ascii.length, 0, 'no ASCII on a kitty terminal');
    assert.ok(calls.thumbs.length >= 1, 'real thumbnails emitted');
    assert.ok(calls.maxThumbInFlight <= 2, `at most 2 in flight (saw ${calls.maxThumbInFlight})`);
    const body = bodyText(screen);
    assert.ok(!body.includes('░▒▓') && !body.includes('▓▒░'), 'no ASCII art painted into the grid');
  });
});

describe('gallery grid: ASCII fallback on plain terminals', () => {
  it('fetches ASCII for visible cells only, two at a time, never all 60', async () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(60));
    resetCalls();
    fakeImage.mode = 'ascii';
    ui.showGalleryGrid();
    await flush();
    assert.equal(calls.thumbs.length, 0, 'no graphics emissions without a protocol');
    assert.ok(calls.ascii.length >= 1, 'some cells got art');
    assert.ok(calls.ascii.length < 60, `must not fetch all 60 cells (fetched ${calls.ascii.length})`);
    assert.ok(calls.maxAsciiInFlight <= 2, `at most 2 in flight (saw ${calls.maxAsciiInFlight})`);
    const body = bodyText(screen);
    assert.ok(body.includes('░▒▓') || body.includes('▓▒░'), 'art upgraded into the cells');
  });
  it('an immediate repaint reuses in-flight fetches: one download per URL', async () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(9));
    resetCalls();
    fakeImage.mode = 'ascii';
    ui.showGalleryGrid();
    ui.showGalleryGrid(); // repaint while the first fetch wave is in flight
    await flush();
    const counts = {};
    for (const u of calls.ascii) counts[u] = (counts[u] || 0) + 1;
    assert.ok(Object.keys(counts).length >= 1, 'something was fetched');
    assert.ok(Object.values(counts).every((c) => c === 1), `each URL fetched once: ${JSON.stringify(counts)}`);
  });
  it('a held arrow key never multiplies sockets (shared two-slot queue)', async () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(120));
    resetCalls();
    fakeImage.mode = 'ascii';
    ui.showGalleryGrid();
    for (let i = 0; i < 40; i++) screen.emit('keypress', null, { name: 'down', full: 'down' });
    await flush();
    assert.ok(calls.maxAsciiInFlight <= 2, `global bound holds (saw ${calls.maxAsciiInFlight})`);
    assert.ok(calls.ascii.length < 40 * 2, `no fetch storm for scrolled-away rows (fetched ${calls.ascii.length})`);
  });
});

describe('gallery grid: kitty graphics layer', () => {
  it('emits thumbnails cursor-cell-first, cached, anchored on-screen, two in flight', async () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(6));
    resetCalls();
    ui.showGalleryGrid();
    await flush();
    assert.ok(calls.thumbs.length >= 1, 'kitty thumbnails emitted');
    assert.equal(calls.thumbs[0].url, 'https://img.example/i0.png', 'cursor cell first');
    for (const t of calls.thumbs) {
      assert.equal(t.cache, true, 'cache:true → one download per URL');
      assert.ok(Number.isInteger(t.row) && t.row >= 3, `row anchored (got ${t.row})`);
      assert.ok(Number.isInteger(t.col) && t.col >= 2, `col anchored (got ${t.col})`);
    }
    assert.ok(calls.maxThumbInFlight <= 2, `at most 2 in flight (saw ${calls.maxThumbInFlight})`);
  });
});

describe('gallery grid: keys and lifecycle', () => {
  it('arrows move the cursor between photos (never history)', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(6));
    ui.showGalleryGrid();
    screen.emit('keypress', null, { name: 'right', full: 'right' });
    screen.emit('keypress', null, { name: 'right', full: 'right' });
    const body = bodyText(screen);
    assert.match(body, />3/, 'cursor on the third cell');
    screen.emit('keypress', null, { name: 'left', full: 'left' });
    assert.match(bodyText(screen), />2/, 'left steps back');
  });
  it('ctrl+f fullscreens the cursor photo; esc returns to the grid', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(6));
    ui.showGalleryGrid();
    screen.emit('keypress', null, { name: 'right', full: 'right' });
    screen.emit('keypress', '\x06', { name: 'f', ctrl: true, full: 'C-f' });
    assert.equal(ui.isImageFullscreen(), true, 'fullscreen opened');
    screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    assert.equal(ui.isImageFullscreen(), false);
    assert.equal(ui.isGalleryGridOpen(), true, 'esc lands back on the grid');
  });
  it('enter in the grid opens the cursor photo (same fullscreen)', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(3));
    ui.showGalleryGrid();
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.equal(ui.isImageFullscreen(), true);
  });
  it('closing the grid clears the graphics layer (no ghost photos)', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(4));
    ui.showGalleryGrid();
    const before = calls.cleared;
    ui.closeGalleryGrid();
    assert.ok(calls.cleared > before, 'clearImages emitted');
    assert.equal(ui.isGalleryGridOpen(), false);
  });
});

describe('gallery pane (60/40): tab in, ctrl+f, esc out', () => {
  it('kitty pane reports a failed image as text, never ASCII', async () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(2));
    resetCalls();
    screen.emit('keypress', '\t', { name: 'tab', full: 'tab' });
    await flush();
    assert.equal(calls.ascii.length, 0, 'no ASCII on a graphics terminal');
    const body = bodyText(screen);
    assert.match(body, /Image could not be loaded/, 'plain failure line in the pane');
    assert.ok(!body.includes('░▒▓') && !body.includes('▓▒░'), 'no art in the pane');
  });
  it('plain-terminal pane still falls back to ASCII art', async () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(2));
    resetCalls();
    fakeImage.mode = 'ascii';
    screen.emit('keypress', '\t', { name: 'tab', full: 'tab' });
    await flush();
    assert.ok(calls.ascii.length >= 1, 'ASCII fetched on a no-graphics terminal');
    const body = bodyText(screen);
    assert.ok(body.includes('░▒▓') || body.includes('▓▒░'), 'art appears in the pane');
  });
  it('tab opens the pane; ctrl+f fullscreens; esc restores the pane', async () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(3));
    screen.emit('keypress', '\t', { name: 'tab', full: 'tab' });
    assert.equal(ui.isGalleryOpen(), true, 'pane opened by tab');
    screen.emit('keypress', '\x06', { name: 'f', ctrl: true, full: 'C-f' });
    assert.equal(ui.isImageFullscreen(), true, 'pane photo fullscreened');
    screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    assert.equal(ui.isImageFullscreen(), false);
    assert.equal(ui.isGalleryOpen(), true, 'esc lands back in the pane');
  });
  it('ctrl+f with no image open flashes a hint instead of fullscreening', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], { images: [], videos: [] });
    screen.emit('keypress', '\x06', { name: 'f', ctrl: true, full: 'C-f' });
    assert.equal(ui.isImageFullscreen(), false, 'nothing to fullscreen');
  });
});

describe('pdf pages ride the same graphics path', () => {
  it('showPdfSplit lists the page images in the pane', async () => {
    const { screen, ui } = makeWiredUI();
    assert.equal(ui.showPdfSplit(['/tmp/tui-pdf-t/page-1.png', '/tmp/tui-pdf-t/page-2.png']), true);
    assert.equal(ui.isGalleryOpen(), true, 'PDF pages open the 60/40 pane');
    assert.equal(ui.galleryRows().length, 2, 'both pages listed for /gallery and Tab');
    await flush(); // let renderMedia settle
  });
  it('empty page list is refused, never a broken pane', () => {
    const { screen, ui } = makeWiredUI();
    assert.equal(ui.showPdfSplit([]), false);
    assert.equal(ui.isGalleryOpen(), false);
  });
});

describe('gallery keys: never a dead end, ctrl+r rotate, esc restores the page', () => {
  it('/ in the grid closes it and opens the command bar with "/"', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(4));
    ui.showGalleryGrid();
    assert.equal(ui.isGalleryGridOpen(), true);
    screen.emit('keypress', '/', { name: '/', full: '/' });
    assert.equal(ui.isGalleryGridOpen(), false, 'grid closed');
    assert.ok(screen.focused && typeof screen.focused.getValue === 'function', 'input focused');
    assert.equal(screen.focused.getValue(), '/', 'one keypress types the slash');
  });
  it('typing in the grid closes it and seeds the search with the char', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(4));
    ui.showGalleryGrid();
    screen.emit('keypress', 'c', { name: 'c', full: 'c' });
    assert.equal(ui.isGalleryGridOpen(), false);
    assert.equal(screen.focused.getValue(), 'c');
  });
  it('/ in fullscreen leaves the photo and starts a fresh search', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(3));
    ui.showGalleryGrid();
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.equal(ui.isImageFullscreen(), true);
    screen.emit('keypress', '/', { name: '/', full: '/' });
    assert.equal(ui.isImageFullscreen(), false, 'fullscreen closed');
    assert.equal(screen.focused.getValue(), '/');
  });
  it('fullscreen photos are emitted centered; ctrl+r rotates 90° per press', async () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(3));
    ui.showGalleryGrid();
    resetCalls();
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    await flush();
    const fsThumbs = calls.thumbs.filter((t) => t.cap === false); // fullscreen-only emit
    assert.equal(fsThumbs.length, 1, 'one fullscreen emission');
    assert.equal(fsThumbs[0].center, true, 'dead-center anchor');
    assert.equal(fsThumbs[0].rotate, 0, 'upright on open');
    resetCalls();
    screen.emit('keypress', '\x12', { name: 'r', ctrl: true, full: 'C-r' });
    await flush();
    const rot = calls.thumbs.filter((t) => t.cap === false).at(-1);
    assert.ok(rot, 'photo repainted');
    assert.equal(rot.url, fsThumbs[0].url, 'same photo');
    assert.equal(rot.rotate, 90, 'ctrl+r rotates 90° clockwise');
    assert.equal(rot.center, true, 'stays centered');
    resetCalls();
    screen.emit('keypress', '\x12', { name: 'r', ctrl: true, full: 'C-r' });
    await flush();
    assert.equal(calls.thumbs.filter((t) => t.cap === false).at(-1).rotate, 180, 'cycles 90 → 180');
  });
  it('ctrl+r rotates the pane photo (same rule as fullscreen)', async () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('article text', [], [], media(3));
    screen.emit('keypress', '\t', { name: 'tab', full: 'tab' });
    await flush();
    fakeImage.bytesFor = 'img.example';
    resetCalls();
    screen.emit('keypress', '\x12', { name: 'r', ctrl: true, full: 'C-r' });
    await flush();
    fakeImage.bytesFor = null;
    const t = calls.thumbs.at(-1);
    assert.ok(t, 'pane photo re-emitted through the graphics path');
    assert.equal(t.rotate, 90, 'rotated in the pane too');
  });
  it('esc from the pane fullscreen restores the web content (not blank+hint)', async () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('UNIQUE-ARTICLE-MARKER paragraph', [], [], media(3));
    screen.emit('keypress', '\t', { name: 'tab', full: 'tab' });
    await flush();
    screen.emit('keypress', '\x06', { name: 'f', ctrl: true, full: 'C-f' });
    assert.equal(ui.isImageFullscreen(), true, 'pane photo fullscreened');
    assert.ok(!bodyText(screen).includes('UNIQUE-ARTICLE-MARKER'), 'fullscreen paint replaced the body');
    screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    assert.equal(ui.isImageFullscreen(), false);
    assert.equal(ui.isGalleryOpen(), true, 'pane is back');
    assert.match(bodyText(screen), /UNIQUE-ARTICLE-MARKER/, 'the web content is restored');
  });
});

describe('gallery pane: a new search replaces the page it belonged to', () => {
  it('search results (non-overlay) close the split pane for good', async () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('old page with pictures', [], [], media(3));
    screen.emit('keypress', '\t', { name: 'tab', full: 'tab' });
    await flush();
    assert.equal(ui.isGalleryOpen(), true, 'pane open before the search');
    ui.showLinkPicker([{ title: 'r', url: 'https://r.com', domain: 'r.com' }]);
    assert.equal(ui.isGalleryOpen(), false, 'the search list closed the pane');
    assert.equal(ui.isPickerOpen(), true, 'the results list owns the screen');
  });
  it('overlay pickers (/bookmarks, /history) still keep the pane underneath', async () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('old page with pictures', [], [], media(3));
    screen.emit('keypress', '\t', { name: 'tab', full: 'tab' });
    await flush();
    assert.equal(ui.isGalleryOpen(), true);
    ui.showLinkPicker([{ title: 'b', url: 'https://b.com', domain: 'b.com' }], null, null, { overlay: true });
    assert.equal(ui.isGalleryOpen(), true, 'overlay keeps the pane underneath for Esc restore');
  });
});
