'use strict';
/* Round 7 — user-centric overhaul:
 *   * context-aware commands (/download no-arg, /open no-arg, /copy page)
 *   * /home -> in-app dashboard (deps.showHome)
 *   * command tiering (/help vs /help all)
 *   * Navigator.replaceCurrent (engine fallback history)
 *   * config idleTeardownMin
 *   * links: Bing redirector unwrap
 * Fresh process (image I/O is stubbed before src/ui binds it).
 * Run: node --test --test-force-exit tests/test-round7.js
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ---- stub image I/O BEFORE src/ui binds its destructured imports ----
const imgPath = require.resolve('../src/image');
require(imgPath);
const imgExports = require.cache[imgPath].exports;
imgExports.fetchBytes = async () => null;
imgExports.getImageAscii = async () => null;

const blessed = require('blessed');
const { createUI } = require('../src/ui');
const { routeCommand } = require('../src/commands');
const { Navigator } = require('../src/navigation');
const { cleanLinks } = require('../src/links');
const { loadConfig, saveConfig } = require('../src/config');

const stripTags = (s) => String(s).replace(/\{[^}]*\}/g, '').replace(/\x1b\[[0-9;]*m/g, '');
const tick = () => new Promise((r) => setImmediate(r));

// ---- downloads / clipboard module stubs (commands.js reads them at call) --
const dlMod = require('../src/downloads');
const clipMod = require('../src/clipboard');
const realDownload = dlMod.downloadUrl;
const realCopy = clipMod.copyText;
const downloads = [];
afterEach(() => {
  dlMod.downloadUrl = realDownload;
  clipMod.copyText = realCopy;
  downloads.length = 0;
});

function deps(over = {}) {
  const calls = { content: [], info: [], toasts: [], navigated: [], home: 0, order: [] };
  const ui = {
    setCenterContent: (text) => calls.content.push(String(text)),
    showInfo: (text) => calls.info.push(String(text)),
    toast: (text) => calls.toasts.push(String(text)),
    flashStatus: (text) => calls.toasts.push(String(text)),
    linkAt: () => null,
    currentImageUrl: () => null,
  };
  return {
    calls,
    ui,
    deps: {
      ui,
      navigate: (u) => { calls.navigated.push(u); calls.order.push(`nav:${u}`); },
      currentUrl: () => 'https://current.example/page',
      ...over,
    },
  };
}

// ============================================================
// /download: context-aware
// ============================================================
describe('/download acts on what is on screen', () => {
  it('no argument downloads the image currently being viewed to ~/Downloads', async () => {
    dlMod.downloadUrl = async (url, opts) => { downloads.push({ url, opts }); return { ok: true, path: '/home/u/Downloads/pic.png', bytes: 42 }; };
    const { calls, ui, deps: d } = deps();
    ui.currentImageUrl = () => 'https://img.example/hero.png';
    routeCommand('/download', d);
    await tick();
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].url, 'https://img.example/hero.png');
    assert.equal(downloads[0].opts.dest, undefined, 'default destination (~/Downloads)');
    assert.ok(calls.toasts.some((t) => /Saved/.test(t)), JSON.stringify(calls.toasts));
  });

  it('no argument, nothing on screen => actionable hint, no download', async () => {
    dlMod.downloadUrl = async () => { throw new Error('should not download'); };
    const { calls, deps: d } = deps();
    routeCommand('/download', d);
    await tick();
    const all = calls.toasts.concat(calls.content).join('\n');
    assert.match(all, /No image on screen|download/i);
    assert.equal(downloads.length, 0);
  });

  it('explicit row number still resolves the visible list', async () => {
    dlMod.downloadUrl = async (url, opts) => { downloads.push({ url, opts }); return { ok: true, path: '/p', bytes: 1 }; };
    const { ui, deps: d } = deps();
    ui.downloadTargetAt = (n) => (n === 2 ? 'https://row2.example/x.zip' : null);
    routeCommand('/download 2', d);
    await tick();
    assert.equal(downloads[0].url, 'https://row2.example/x.zip');
  });

  it('explicit URL still works', async () => {
    dlMod.downloadUrl = async (url) => { downloads.push({ url }); return { ok: true, path: '/p', bytes: 1 }; };
    const { deps: d } = deps();
    routeCommand('/download https://direct.example/f.pdf', d);
    await tick();
    assert.equal(downloads[0].url, 'https://direct.example/f.pdf');
  });
});

// ============================================================
// /open: context-aware
// ============================================================
describe('/open acts on what is on screen', () => {
  it('no argument opens the highlighted row', () => {
    const { ui, calls, deps: d } = deps();
    ui.linkAt = () => ({ url: 'https://highlighted.example/' });
    routeCommand('/open', d);
    assert.deepEqual(calls.navigated, ['https://highlighted.example/']);
  });

  it('no argument falls back to the current page', () => {
    const { calls, deps: d } = deps();
    routeCommand('/open', d);
    assert.deepEqual(calls.navigated, ['https://current.example/page']);
  });

  it('explicit argument is unchanged (URL and search)', () => {
    const { calls, deps: d } = deps();
    routeCommand('/open github.com', d);
    assert.deepEqual(calls.navigated, ['github.com']);
  });
});

// ============================================================
// /copy: page fallback
// ============================================================
describe('/copy copies the page when nothing is highlighted', () => {
  it('no argument + no highlight copies the current URL', async () => {
    let copied = null;
    clipMod.copyText = async (t) => { copied = t; return { ok: true, method: 'test' }; };
    const { deps: d } = deps();
    routeCommand('/copy', d);
    await tick();
    assert.equal(copied, 'https://current.example/page');
  });
});

// ============================================================
// /home -> in-app dashboard
// ============================================================
describe('/home opens the in-app dashboard', () => {
  it('uses deps.showHome and never navigates to a search page', () => {
    const { calls, deps: d } = deps({ showHome: () => { calls.home++; calls.order.push('home'); } });
    routeCommand('/home', d);
    assert.equal(calls.home, 1);
    assert.equal(calls.navigated.length, 0);
  });

  it('after a browser reset it still lands on the dashboard', async () => {
    const { calls, deps: d } = deps({
      showHome: () => { calls.order.push('home'); },
      resetBrowser: async () => { calls.order.push('reset'); return true; },
    });
    routeCommand('/home', d);
    await tick();
    assert.deepEqual(calls.order, ['reset', 'home']);
  });

  it('without a dashboard dep it degrades to the old navigate (tests/older wiring)', () => {
    const { calls, deps: d } = deps();
    routeCommand('/home', d);
    assert.deepEqual(calls.navigated, ['https://html.duckduckgo.com/html/']);
  });
});

// ============================================================
// command tiering
// ============================================================
describe('/help is tiered', () => {
  it('core help hides advanced commands; /help all reveals them', () => {
    const a = deps();
    routeCommand('/help', a.deps);
    const core = a.calls.info.join('\n');
    assert.ok(!core.includes('/vo '), 'core hides /vo');
    assert.ok(core.includes('/download'), 'core keeps everyday commands');
    assert.match(core, /\/help all/, 'points to the full list');

    const b = deps();
    routeCommand('/help all', b.deps);
    const all = b.calls.info.join('\n');
    assert.ok(all.includes('/cookies'), 'all reveals /cookies');
  });
});

// ============================================================
// Navigator.replaceCurrent
// ============================================================
describe('Navigator.replaceCurrent keeps history honest', () => {
  it('replaces the current entry, not appends', () => {
    const n = new Navigator({ file: null });
    n.navigate('https://a');
    n.navigate('https://b');
    n.replaceCurrent('https://b2');
    assert.deepEqual(n.getHistory(), ['https://a', 'https://b2']);
    assert.equal(n.back(), 'https://a');
  });

  it('appends when there is no current entry', () => {
    const n = new Navigator({ file: null });
    n.replaceCurrent('https://first');
    assert.deepEqual(n.getHistory(), ['https://first']);
  });
});

// ============================================================
// config: idleTeardownMin
// ============================================================
describe('config idleTeardownMin', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  it('defaults to 0 (off) and round-trips a valid value', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');
    assert.equal(loadConfig(file).idleTeardownMin, 0);
    saveConfig({ theme: 'white', pageSize: 50, quality: 'best', vo: 'auto', idleTeardownMin: 7 }, file);
    assert.equal(loadConfig(file).idleTeardownMin, 7);
  });
  it('ignores garbage / non-positive values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    const file = path.join(dir, 'config.json');
    for (const bad of [-5, 0, 'x']) {
      fs.writeFileSync(file, JSON.stringify({ idleTeardownMin: bad }));
      assert.equal(loadConfig(file).idleTeardownMin, 0, `"${bad}" => off`);
    }
  });
});

// ============================================================
// links: Bing redirector unwrap
// ============================================================
describe('links unwraps Bing result redirects', () => {
  it('decodes the /ck/a?u=a1<base64> target', () => {
    const href = 'https://www.bing.com/ck/a?!&&p=X&u=a1aHR0cHM6Ly9nb2RvdGVuZ2luZS5vcmcv&ntb=1';
    const rows = cleanLinks([{ href, title: 'Godot' }], 10, 'https://www.bing.com/');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, 'https://godotengine.org/');
    assert.equal(rows[0].domain, 'godotengine.org');
  });
});

// ============================================================
// ui: showHome + currentImageUrl
// ============================================================
describe('ui: home dashboard + current image', () => {
  let screens = [];
  const makeUI = (handlers = {}, opts = { theme: 'white', pageSize: 50 }) => {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 't7' });
    screens.push(screen);
    const ui = createUI(screen, { onOmniSubmit: () => {}, onSuggest: () => {}, onLinkPick: () => {}, ...handlers }, opts);
    return { screen, ui };
  };
  const screenText = (screen) => {
    let out = '';
    (function walk(el) {
      if (!el) return;
      try { if (typeof el.getContent === 'function') out += `${el.getContent()}\n`; } catch {}
      for (const c of el.children || []) walk(c);
    })(screen);
    return stripTags(out);
  };
  afterEach(() => {
    for (const s of screens) { try { s.destroy(); } catch {} }
    screens = [];
  });

  it('showHome paints the rows and the start heading', () => {
    const { screen, ui } = makeUI();
    const ok = ui.showHome([
      { title: 'Wikipedia', url: 'https://en.wikipedia.org/', domain: 'wikipedia.org' },
      { title: 'GitHub', url: 'https://github.com/', domain: 'github.com' },
    ]);
    assert.equal(ok, true);
    const t = screenText(screen);
    assert.ok(t.includes('Start'), 'start heading present');
    assert.ok(t.includes('Wikipedia') && t.includes('GitHub'), 'rows visible');
    // The sticky scope picker rides in the heading: web default, every bang.
    assert.ok(t.includes('[web]'), 'web scope chip active by default');
    assert.ok(t.includes('>wiki') && t.includes('>gh'), 'scope chips visible');
    assert.equal(ui.getHomeScope(), '');
  });

  it('home scope picker cycles, locks, and survives a repaint', () => {
    const { screen, ui } = makeUI();
    ui.showHome([{ title: 'Wikipedia', url: 'https://en.wikipedia.org/' }]);
    assert.equal(ui.setHomeScope('wiki'), 'wiki');
    assert.equal(ui.getHomeScope(), 'wiki');
    let t = screenText(screen);
    assert.ok(t.includes('[>wiki]'), 'picked chip highlighted');
    // Cycle from wiki onward and back around to web.
    assert.equal(ui.cycleHomeScope(1), 'gh');
    assert.equal(ui.cycleHomeScope(1), 'so');
    assert.equal(ui.cycleHomeScope(-1), 'gh');
    ui.setHomeScope('nope'); // unknown keys fall back to web
    assert.equal(ui.getHomeScope(), '');
    // Repaint keeps the picked scope (it "stays" across visits).
    ui.setHomeScope('hn');
    ui.showHome([{ title: 'Wikipedia', url: 'https://en.wikipedia.org/' }]);
    assert.equal(ui.getHomeScope(), 'hn');
    t = screenText(screen);
    assert.ok(t.includes('[>hn]'), 'scope survives showHome repaint');
  });

  it('currentImageUrl returns the page image when no gallery is open', () => {
    const { ui } = makeUI();
    ui.setCenterContent('body', [], [], { images: [
      { src: 'https://img.example/1.png', alt: 'one' },
      { src: 'https://img.example/2.png', alt: 'two' },
    ] }, null, null, null, {});
    assert.equal(ui.currentImageUrl(), 'https://img.example/1.png');
  });

  it('currentImageUrl is null on an image-less page', () => {
    const { ui } = makeUI();
    ui.setCenterContent('body', [], [], { images: [] }, null, null, null, {});
    assert.equal(ui.currentImageUrl(), null);
  });
});

// ============================================================
// round 8: input-lock fixes, /themes removal, gallery survives
// ============================================================
describe('settings: arrows cycle values, no ghost panel', () => {
  let screens = [];
  function makeUI() {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 't8' });
    screens.push(screen);
    const calls = { submits: [] };
    const navigator = new Navigator({ file: null });
    const config = { theme: 'white', pageSize: 50, quality: '480', vo: 'auto', quitPlayer: 'ask' };
    let saved = 0;
    let ui = null;
    const deps = () => ({
      ui, browser: { close: async () => {} }, navigator, config,
      saveConfig: () => { saved++; }, shutdown: () => {}, navigate: () => {},
      currentUrl: () => 'https://en.wikipedia.org/wiki/Linux', getQueue: () => [],
    });
    ui = createUI(screen, {
      onOmniSubmit: (v) => { calls.submits.push(v); if (String(v || '').trim().startsWith('/')) routeCommand(v, deps()); },
      onSuggest: () => {}, onLinkPick: () => {}, onPlayVideo: () => {},
      onHistoryBack: () => {}, onHistoryForward: () => {}, onEscape: () => {}, onQuit: () => {},
    }, { theme: 'white', pageSize: 50 });
    return { screen, ui, calls, config, saved: () => saved, deps };
  }
  afterEach(() => { for (const s of screens) { try { s.destroy(); } catch {} } screens = []; });

  it('the Theme row previews live with arrows and locks on Enter', () => {
    const m = makeUI();
    routeCommand('/settings', m.deps());
    const t0 = m.config.theme;
    m.screen.emit('keypress', null, { name: 'right', full: 'right' });
    // Preview: the row shows a new theme, but nothing is saved yet.
    assert.equal(m.config.theme, t0, 'arrow only previews (not saved)');
    m.screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.notEqual(m.config.theme, t0, 'Enter locks the theme');
  });

  it('the Quality lock toast names the CYCLED value, not the boot one', () => {
    // Regression: lock() snapshotted the value at hub-build time, so
    // cycling 480 -> 720 and pressing Enter toasted "480p (data saver)".
    const m = makeUI();
    routeCommand('/settings', m.deps());
    const seen = [];
    m.ui.toast = (t) => seen.push(String(t));
    m.screen.emit('keypress', null, { name: 'down', full: 'down' }); // Theme -> Glow
    m.screen.emit('keypress', null, { name: 'down', full: 'down' }); // Glow -> Quality
    m.screen.emit('keypress', null, { name: 'right', full: 'right' }); // 480 -> 720
    assert.equal(m.config.quality, '720', 'arrow previews the cycle');
    m.screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.equal(m.config.quality, '720', 'Enter locks the pick');
    assert.ok(
      seen.some((t) => /Quality locked: 720p/.test(t)),
      'toast shows the locked value, got: ' + JSON.stringify(seen)
    );
  });

  it('Esc closes settings and leaves no ghost panel that swallows keys', () => {
    const m = makeUI();
    routeCommand('/settings', m.deps());
    assert.equal(m.ui.isSettingsOpen(), true);
    m.screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    assert.equal(m.ui.isSettingsOpen(), false);
    m.calls.submits.length = 0;
    m.screen.emit('keypress', 'z', { name: 'z', full: 'z' });
    m.screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.deepEqual(m.calls.submits, ['z'], 'typing still works after leaving settings');
  });

  it('keys stay live after an info command (/pets)', () => {
    const m = makeUI();
    routeCommand('/pets happy', m.deps());
    m.screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    m.calls.submits.length = 0;
    m.screen.emit('keypress', 'q', { name: 'q', full: 'q' });
    m.screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.deepEqual(m.calls.submits, ['q'], 'typing works after /pets');
  });

  it('a gallery open underneath survives /download', () => {
    const m = makeUI();
    m.ui.setCenterContent('article', [], [], { images: [{ src: 'https://i.example/a.png' }, { src: 'https://i.example/b.png' }], videos: [] }, null, null, null, {});
    m.screen.emit('keypress', null, { name: 'tab', full: 'tab' });
    assert.equal(m.ui.isGalleryOpen(), true);
    m.screen.emit('keypress', '/', { name: 'slash', full: '/' });
    m.screen.emit('keypress', 'd', { name: 'd', full: 'd' });
    m.screen.emit('keypress', 'l', { name: 'l', full: 'l' });
    m.screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.equal(m.ui.isGalleryOpen(), true, 'image stays on screen after /download');
  });

  it('/themes is gone from the catalog but redirects to /settings', () => {
    const toasts = [];
    const ui = { toast: (t) => toasts.push(String(t)) };
    routeCommand('/themes', { ui, currentUrl: () => '', navigate: () => {} });
    assert.ok(toasts.some((t) => /moved into \/settings/.test(t)), 'points at /settings: ' + JSON.stringify(toasts));
  });
});
