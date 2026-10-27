'use strict';
/* Round-3 follow-through: P1 home-only footer, P2 single docking system,
 * P3 gallery wave loader, P4 visualizer pause-follow.
 * Fresh process (until image stubs must land before src/ui binds its
 * destructured imports). Offline except for explicitly stubbed fetches.
 * Run: node --test --test-force-exit tests/test-round4.js
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ---- stub image I/O BEFORE src/ui binds it (destructured at require) ----
const imgPath = require.resolve('../src/image');
require(imgPath);
const imgExports = require.cache[imgPath].exports;
const realFetchBytes = imgExports.fetchBytes;
const realAscii = imgExports.getImageAscii;
let releaseFetch = null;
let fetchMode = 'pending'; // 'pending' | 'instant-null' (ui binds this ref at require)
imgExports.fetchBytes = () => fetchMode === 'instant-null'
  ? Promise.resolve(null)
  : new Promise((r) => { releaseFetch = r; });
imgExports.getImageAscii = async () => 'ASCIIART';
// This suite tests the no-graphics fallback path. Pin the capability probes
// so the result does not depend on the terminal that runs `npm test`.
imgExports.detectImageSupport = () => 'none';
imgExports.detectGraphics = () => 'none';
imgExports.bestImageMode = () => 'ascii';
afterEach(() => { releaseFetch = null; fetchMode = 'pending'; });

const blessed = require('blessed');
const { createUI } = require('../src/ui');

const stripTags = (s) => String(s).replace(/\{[^}]*\}/g, '').replace(/\x1b\[[0-9;]*m/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let screens = [];
function makeUI(handlers = {}, opts = { theme: 'white', pageSize: 50 }) {
  const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 't' });
  screens.push(screen);
  const calls = {};
  const ui = createUI(screen, {
    onOmniSubmit: (...a) => { calls.submit = a; },
    onSuggest: (...a) => { calls.suggest = a; },
    onLinkPick: (...a) => { calls.pick = a; },
    onPlayVideo: (...a) => { calls.play = a; },
    onHistoryBack: () => { calls.back = true; },
    onHistoryForward: () => { calls.fwd = true; },
    onEscape: () => { calls.esc = true; },
    onQuit: () => { calls.quit = true; },
    onSettingsChange: () => {},
    ...handlers,
  }, opts);
  return { screen, ui, calls };
}
afterEach(() => {
  for (const s of screens) { try { s.destroy(); } catch {} }
  screens = [];
});
function screenText(screen) {
  let out = '';
  (function walk(el) {
    if (!el) return;
    try { if (typeof el.getContent === 'function') out += `${el.getContent()}\n`; } catch {}
    for (const c of el.children || []) walk(c);
  })(screen);
  return stripTags(out);
}

describe('P1: hint footer lives on home only', () => {
  // NOTE: headless screens are 1 col wide, so the footer truncates to ~10
  // cells — assertions use truncation-proof prefixes, never full strings.
  it('boot shows the hint (home default)', () => {
    const { screen } = makeUI();
    assert.ok(screenText(screen).includes('/help'), 'boot footer visible');
  });
  it('off-home hides it; loader sits flush with no hint row', () => {
    const { screen, ui } = makeUI();
    assert.equal(ui.setHomeMode(false), true);
    assert.ok(!screenText(screen).includes('/help'), 'footer hidden off-home');
    ui.setCenterContent('A wiki article about penguins.', []);
    ui.showLoading('Loading page', 'example.com', '');
    const t = screenText(screen);
    assert.ok(!t.includes('/help'), 'no hint row under the loader');
    assert.ok(/[▁▂▃▄▅▆▇█]{10,}/.test(t), 'wave present');
    assert.ok(t.includes('penguins'), 'page intact above');
    ui.hideLoading();
  });
  it('toast reveals the footer transiently off-home, then it re-hides', async () => {
    const { screen, ui } = makeUI();
    ui.setHomeMode(false);
    assert.ok(!screenText(screen).includes('/help'));
    ui.toast('tok12345', 80);
    assert.ok(screenText(screen).includes('tok12345'), 'toast content set');
    // Visibility, not just content: the footer is hidden off-home, and an
    // old ordering bug wrote the toast into that hidden bar (so every
    // command on a page looked like a no-op).
    let bar = null;
    (function walk(el) {
      if (!el) return;
      try { if (String((el.getContent && el.getContent()) || '').includes('tok12345')) bar = el; } catch { /* keep walking */ }
      for (const c of el.children || []) walk(c);
    })(screen);
    assert.ok(bar, 'toast lives in a widget');
    assert.equal(bar.hidden, false, 'toast widget is visible off-home');
    await sleep(1000); // toast floor is max(800, ms)
    assert.ok(!screenText(screen).includes('tok12345'), 'toast released');
    assert.ok(!screenText(screen).includes('/help'), 'footer re-hidden');
  });
  it('home mode brings the footer back', () => {
    const { screen, ui } = makeUI();
    ui.setHomeMode(false);
    assert.ok(!screenText(screen).includes('/help'));
    ui.setHomeMode(true);
    assert.ok(screenText(screen).includes('/help'), 'footer restored on home');
  });
});

describe('P2: one docking system — loader + toast stack without overlap', () => {
  it('toast during load stacks above the wave; both visible, page intact', () => {
    const { screen, ui } = makeUI();
    ui.setHomeMode(false);
    ui.setCenterContent('Penguins everywhere.', []);
    ui.showLoading('Loading page', 'example.com', '');
    ui.toast('tok67890', 5000);
    const t = screenText(screen);
    assert.ok(/[▁▂▃▄▅▆▇█]{10,}/.test(t), 'wave at the very bottom');
    assert.ok(t.includes('tok67890'), 'toast stacked above, not lost');
    assert.ok(t.includes('Penguins everywhere.'), 'body intact');
    ui.hideLoading();
    ui.clearStatus();
  });
  it('layout survives every bar combination without throwing', () => {
    const { ui } = makeUI();
    assert.doesNotThrow(() => {
      ui.setHomeMode(false);
      ui.showLoading('a', 'b', '');
      ui.showVisualizer();
      ui.setHomeMode(true);
      ui.hideLoading();
      ui.hideVisualizer();
      ui.setHomeMode(false);
    });
  });
});

describe('P3: gallery fetch shows the wave loader, releases on every path', () => {
  it('slow fetch: loader with N-of-M appears, then art lands and loader leaves', async () => {
    const { screen, ui } = makeUI();
    ui.setCenterContent('article with pics', [], [],
      { images: [{ src: 'https://x.invalid/a.png', alt: 'pic' }], videos: [] });
    screen.emit('keypress', null, { name: 'tab', full: 'tab' });
    assert.equal(ui.isGalleryOpen(), true);
    await sleep(500); // past the 250 ms delayed-show
    const mid = screenText(screen);
    assert.ok(mid.includes('Loading'), 'loader title shown for slow fetch');
    assert.ok(/[▁▂▃▄▅▆▇█]{10,}/.test(mid), 'wave shown for slow fetch');
    assert.ok(!/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(mid), 'no footer spinner alongside');
    releaseFetch(null); // bytes: null → ASCII fallback path
    await sleep(400);
    const done = screenText(screen);
    assert.ok(!done.includes('Loading'), 'loader released on settle');
    assert.ok(done.includes('ASCIIART'), 'art painted');
  });
  it('instant fetch never flashes the loader', async () => {
    fetchMode = 'instant-null';
    try {
      const { screen, ui } = makeUI();
      ui.setCenterContent('article with pics', [], [],
        { images: [{ src: 'https://x.invalid/b.png', alt: 'pic' }], videos: [] });
      screen.emit('keypress', null, { name: 'tab', full: 'tab' });
      await sleep(600);
      assert.ok(!screenText(screen).includes('Loading'), 'no flash for instant fetch');
    } finally {
      fetchMode = 'pending';
    }
  });
});

describe('P4: visualizer freezes on pause, resumes on play', () => {
  const barsOf = (screen) => {
    // Footer slot, bars only (no title row): first long ramp run wins.
    const t = screenText(screen);
    const m = t.match(/[▁▂▃▄▅▆▇█]{10,}/);
    return m ? m[0] : null;
  };
  it('pause API toggles; frozen bars hold still, live bars advance', async () => {
    const { screen, ui } = makeUI();
    ui.setHomeMode(false);
    ui.showVisualizer();
    assert.equal(ui.isVizPaused(), false);
    const a = barsOf(screen);
    assert.ok(a && a.length > 10, 'bars painted');
    ui.setVizPaused(true);
    assert.equal(ui.isVizPaused(), true);
    await sleep(400);
    assert.equal(barsOf(screen), a, 'paused bars frozen');
    ui.setVizPaused(false);
    assert.equal(ui.isVizPaused(), false);
    await sleep(500);
    assert.notEqual(barsOf(screen), a, 'resumed bars advance');
    ui.hideVisualizer();
  });
});
