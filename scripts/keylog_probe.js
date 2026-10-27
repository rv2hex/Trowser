#!/usr/bin/env node
'use strict';
// Keyboard matrix probe for the TUI: drives the REAL blessed UI with the
// same keypress shapes blessed delivers, across boot/article/list
// contexts, then types every slash command from the catalog the way a
// user would. Prints ONE JSON document to the file given as argv[1]
// (stdout stays polluted by blessed escape writes — never parse it).
// Exit code is always 0; the python driver interprets results.
// XDG/HOME are redirected to tmpdirs first so no real config is touched.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHIM = fs.mkdtempSync(path.join(os.tmpdir(), 'keylog-'));
process.env.XDG_CONFIG_HOME = path.join(SHIM, 'xdg');
process.env.HOME = path.join(SHIM, 'home');
fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });

const blessed = require('blessed');
const ROOT = path.join(__dirname, '..');
const { createUI } = require(path.join(ROOT, 'src', 'ui'));
const { routeCommand } = require(path.join(ROOT, 'src', 'commands'));
const { getCommandSuggestions } = require(path.join(ROOT, 'src', 'suggest'));
const { Navigator } = require(path.join(ROOT, 'src', 'navigation'));

const results = [];
function rec(caseName, ctx, fn) {
  const r = { case: caseName, ctx, ok: false, detail: '' };
  try {
    fn(r);
    r.ok = true;
  } catch (e) {
    r.ok = false;
    r.detail = String((e && e.message) || e).slice(0, 300);
  }
  results.push(r);
}

let screens = [];
function makeWiredUI() {
  const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 'keylog' });
  screens.push(screen);
  const calls = {
    submits: [], picks: [], plays: [], quits: 0, backs: 0, fwds: 0,
    navigations: [], shutdowns: [], playUrls: [], suggestPaints: 0,
  };
  const navigator = new Navigator({ file: null });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keylog-prof-'));
  let ui = null;
  const deps = () => ({
    ui,
    browser: { profileDir, profileReady: () => false, close: async () => {} },
    navigator,
    config: { theme: 'white', pageSize: 50, quality: '480', vo: 'auto' },
    saveConfig: () => {},
    shutdown: (code) => { calls.shutdowns.push(code); },
    navigate: (u) => { calls.navigations.push(u); },
    goBack: () => { const u = navigator.back(); if (u) calls.backs++; },
    goForward: () => { const u = navigator.forward(); if (u) calls.fwds++; },
    reload: () => {},
    currentUrl: () => '',
    openExternal: () => false,
    playUrl: (u) => { calls.playUrls.push(u); },
    getQueue: () => [],
    mpvNext: async () => false,
    mpvStop: async () => false,
  });
  ui = createUI(screen, {
    onOmniSubmit: (value) => {
      calls.submits.push(String(value));
      if (String(value || '').trim().startsWith('/')) routeCommand(value, deps());
    },
    onSuggest: (text, id) => {
      const v = String(text || '');
      if (v.trim().startsWith('/')) {
        calls.suggestPaints++;
        ui.renderSuggestRows(getCommandSuggestions(v).map((r) => ({
          title: r.label, domain: r.domain, url: r.url, kind: r.kind,
        })), id);
      }
    },
    onLinkPick: (url) => { calls.picks.push(url); },
    onPlayVideo: (url, queue) => { calls.plays.push([url, queue]); },
    onHistoryBack: () => { calls.backs++; },
    onHistoryForward: () => { calls.fwds++; },
    onEscape: () => {},
    onQuit: () => { calls.quits++; },
    
    onQualityCycle: () => {},
  }, { theme: 'white', pageSize: 50 });
  return { screen, ui, calls };
}

function bodyText(screen) {
  const texts = [];
  (function walk(el) {
    try {
      if (typeof el.getContent === 'function') texts.push(String(el.getContent()));
    } catch { /* best effort */ }
    (el.children || []).forEach(walk);
  })(screen);
  return texts.join('\n');
}

function press(screen, ch, key) {
  screen.emit('keypress', ch, key === undefined ? { name: String(ch || '?'), full: String(ch || '?') } : key);
}

function typeText(screen, s) {
  for (const ch of String(s)) press(screen, ch, { name: ch === ' ' ? 'space' : ch, full: ch === ' ' ? 'space' : ch });
}

function typeSlash(screen, cmd) {
  press(screen, '/', { name: 'slash', full: '/' });
  typeText(screen, String(cmd).replace(/^\//, ''));
  press(screen, null, { name: 'enter', full: 'enter' });
}

const K = {
  enter: { name: 'enter', full: 'enter' },
  space: { name: 'space', full: 'space' },
  tab: { name: 'tab', full: 'tab' },
  stab: { name: 'tab', full: 'S-tab', shift: true },
  up: { name: 'up', full: 'up' },
  down: { name: 'down', full: 'down' },
  left: { name: 'left', full: 'left' },
  right: { name: 'right', full: 'right' },
  pageup: { name: 'pageup', full: 'pageup' },
  pagedown: { name: 'pagedown', full: 'pagedown' },
  esc: { name: 'escape', full: 'escape' },
  backspace: { name: 'backspace', full: 'backspace' },
  ctrlQ: { name: 'q', full: 'C-q', ctrl: true },
  altLeft: { name: 'left', full: 'M-left', meta: true },
  altRight: { name: 'right', full: 'M-right', meta: true },
  altUp: { name: 'up', full: 'M-up', meta: true },
  altDown: { name: 'down', full: 'M-down', meta: true },
};

const ARTICLE = [
  'The wiki article about penguins living happily together forever and ever.',
  'Penguins are flightless birds adapted to cold ocean waters worldwide.',
  'They hunt fish and krill while avoiding seals and orcas every single day.',
].join(' ');

const LINK_ROWS = [
  { title: 'First result about penguins and cold places', url: 'https://example.com/penguins', domain: 'example.com' },
  { title: 'Second result about fish and krill food', url: 'https://example.com/fish', domain: 'example.com' },
  { title: 'A video about penguins swimming fast', url: 'https://www.youtube.com/watch?v=AAA111BBBB22', domain: 'youtube.com', video: true },
];

// ---------- Part 1: raw inputs per context ----------
function inputCases() {
  // boot (input focus, empty bar)
  rec('boot: letters submit as typed', 'boot', (r) => {
    const { screen, calls } = makeWiredUI();
    typeText(screen, 'queen');
    press(screen, null, K.enter);
    r.detail = JSON.stringify(calls.submits);
    if (calls.submits.at(-1) !== 'queen') throw new Error('bar did not type queen');
    if (calls.quits) throw new Error('q quit from the bar');
  });
  rec('boot: bare q types, never quits', 'boot', (r) => {
    const { screen, calls } = makeWiredUI();
    press(screen, 'q', { name: 'q', full: 'q' });
    press(screen, null, K.enter);
    if (calls.quits) throw new Error('quit');
    if (calls.submits.at(-1) !== 'q') throw new Error('q did not type, got ' + JSON.stringify(calls.submits));
    r.detail = 'typed q, submitted q';
  });
  rec('boot: backspace edits, ctrl+q quits', 'boot', (r) => {
    const { screen, calls } = makeWiredUI();
    typeText(screen, 'ab');
    press(screen, undefined, K.backspace);
    press(screen, null, K.enter);
    if (calls.submits.at(-1) !== 'a') throw new Error('backspace did not edit, got ' + JSON.stringify(calls.submits));
    press(screen, '\x11', K.ctrlQ);
    if (!calls.quits) throw new Error('ctrl+q did not quit');
  });
  rec('boot: arrows/tab/esc are safe no-ops', 'boot', (r) => {
    const { screen, calls } = makeWiredUI();
    for (const k of [K.up, K.down, K.left, K.right, K.tab, K.esc, K.pageup, K.pagedown]) {
      press(screen, null, k);
    }
    if (calls.quits) throw new Error('unexpected quit');
    if (calls.submits.length) throw new Error('unexpected submit');
    r.detail = 'no crash, no quit, no submit';
  });

  // article open (content focus)
  const openArticle = () => {
    const w = makeWiredUI();
    w.ui.setCenterContent(ARTICLE, []);
    return w;
  };
  rec('article: arrows/space scroll, enter/tab safe', 'article', (r) => {
    const { screen, calls } = openArticle();
    for (const k of [K.up, K.down, K.space, K.pageup, K.pagedown]) press(screen, null, k);
    press(screen, null, K.enter);
    press(screen, null, K.tab);
    if (calls.quits) throw new Error('unexpected quit');
    r.detail = 'scroll keys safe';
  });
  rec('article: q quits (by design), / opens palette, esc keeps page', 'article', (r) => {
    const { screen, calls } = openArticle();
    press(screen, 'q', { name: 'q', full: 'q' });
    if (!calls.quits) throw new Error('bare q outside the bar should quit');
    const w2 = openArticle();
    press(w2.screen, '/', { name: 'slash', full: '/' });
    if (!w2.ui.isCommandPaletteVisible()) throw new Error('palette did not open');
    press(w2.screen, null, K.esc);
    if (w2.ui.isCommandPaletteVisible()) throw new Error('palette stuck open');
    if (!bodyText(w2.screen).includes('penguins')) throw new Error('page lost after esc');
    r.detail = 'q-quit documented; palette open/close, page intact';
  });
  rec('article: alt+left/right history, alt+up digest, ctrl+q quits', 'article', (r) => {
    const { screen, calls } = openArticle();
    press(screen, null, K.altLeft);
    press(screen, null, K.altRight);
    if (!calls.backs || !calls.fwds) throw new Error('history keys dead');
    press(screen, null, K.altUp);
    if (!bodyText(screen).includes('AI SUMMARY')) throw new Error('alt+up digest missing');
    press(screen, null, K.esc);
    press(screen, '\x11', K.ctrlQ);
    if (!calls.quits) throw new Error('ctrl+q did not quit');
  });

  // list open (links focus)
  const openList = () => {
    const w = makeWiredUI();
    w.ui.showLinkPicker(LINK_ROWS);
    return w;
  };
  rec('list: arrows move, enter/space open highlighted', 'list', (r) => {
    const w1 = openList();
    press(w1.screen, null, K.down);
    press(w1.screen, null, K.space);
    if (w1.calls.picks.at(-1) !== 'https://example.com/fish') throw new Error('space did not open row 2, got ' + JSON.stringify(w1.calls.picks));
    const w2 = openList();
    press(w2.screen, null, K.down);
    press(w2.screen, null, K.enter);
    if (w2.calls.picks.at(-1) !== 'https://example.com/fish') throw new Error('enter did not open row 2, got ' + JSON.stringify(w2.calls.picks));
    r.detail = 'space+enter both confirm (fresh views dodge focus flip + dupe guard)';
  });
  rec('list: enter on video row plays externally', 'list', (r) => {
    const { screen, calls } = openList();
    press(screen, null, K.down);
    press(screen, null, K.down);
    press(screen, null, K.enter);
    if (!calls.plays.length || calls.plays[0][0] !== 'https://www.youtube.com/watch?v=AAA111BBBB22') {
      throw new Error('video row did not play, got ' + JSON.stringify(calls.plays));
    }
  });
  rec('list: q quits (by design), / palette, esc back to list', 'list', (r) => {
    const { screen, calls } = openList();
    press(screen, 'q', { name: 'q', full: 'q' });
    if (!calls.quits) throw new Error('bare q outside the bar should quit');
    const w2 = openList();
    press(w2.screen, '/', { name: 'slash', full: '/' });
    if (!w2.ui.isCommandPaletteVisible()) throw new Error('no palette');
    press(w2.screen, null, K.esc);
    if (!w2.ui.isPickerOpen()) throw new Error('list lost after esc');
  });
}

// ---------- Part 2: every /command from the keyboard ----------
const CMD_CASES = [
  // [command to type (with safe args), expect: contentIncludes | flag | none]
  ['/yt', { contentIncludes: '/yt <query>' }],
  ['/youtube', { contentIncludes: '/yt <query>' }],
  ['/yts', { contentIncludes: '/yt <query>' }],
  ['/videos', { contentIncludes: 'No videos on this page' }],
  ['/watch', { contentIncludes: 'No videos on this page' }],
  ['/watch 99', { contentIncludes: 'No video 99' }],
  ['/queue', { contentIncludes: 'Queue is empty' }],
  ['/next', { contentIncludes: 'No player answering', waitMs: 100 }],
  ['/stop', { contentIncludes: 'No player answering', waitMs: 100 }],
  ['/play', { contentIncludes: 'Nothing playable' }],
  ['/gallery', { contentIncludes: 'No images on this page' }],
  ['/images', { contentIncludes: 'No images on this page' }],
  ['/img', { contentIncludes: 'Usage: /img' }],
  ['/img 99', { contentIncludes: 'No image 99' }],
  ['/read', {}],
  ['/read raw', {}],
  ['/links', { contentIncludes: 'Links per page' }],
  ['/links 50', { contentIncludes: 'Links per page' }],
  ['/links 7', { contentIncludes: 'Unknown count' }],
  ['/gemini', { contentIncludes: '/gemini' }],
  ['/gemini-key', { contentIncludes: 'Gemini' }],
  ['/download', { contentIncludes: 'No image on screen' }],
  ['/dl', { contentIncludes: 'No image on screen' }],
  ['/downloads list', { contentIncludes: 'No downloads yet' }],
  ['/download xyz', { contentIncludes: 'Nothing to download' }],
  ['/quality', { contentIncludes: 'Quality:' }],
  ['/quality 480', { contentIncludes: 'Quality:' }],
  ['/quality bogus', { contentIncludes: 'Unknown quality' }],
  ['/vo', { contentIncludes: 'Video output:' }],
  ['/vo x11', { contentIncludes: 'Video output:' }],
  ['/vo bogus', { contentIncludes: 'Unknown video output' }],
  ['/open', { contentIncludes: 'Nothing to open' }],
  ['/open github.com', { navigated: true }],
  ['/back', {}],
  ['/forward', {}],
  ['/reload', {}],
  ['/home', { navigated: true }],
  ['/find', { contentIncludes: 'Usage: /find' }],
  ['/find penguins', {}],
  ['/copy', { contentIncludes: 'Nothing to copy' }],
  ['/mail', { contentIncludes: 'Usage: /mail' }],
  ['/bookmarks', { contentIncludes: 'No bookmarks yet' }],
  ['/bm', { contentIncludes: 'No bookmarks yet' }],
  ['/history', { contentIncludes: 'History is empty' }],
  ['/profile', { contentIncludes: 'Profile:' }],
  ['/pets', { contentIncludes: 'happy' }],
  ['/pets sad', { contentIncludes: 'sad' }],
  ['/pets bogus', { contentIncludes: 'Unknown mood' }],
  ['/shortcuts', { contentIncludes: 'ctrl+q' }],
  ['/shotcuts', { contentIncludes: 'ctrl+q' }],
  ['/help', { contentIncludes: '/quit' }],
  ['/login', { flag: 'form' }],
  ['/register', { flag: 'form' }],
  ['/logout', { contentIncludes: 'Profile wiped', waitMs: 100 }],
  ['/cookies', { contentIncludes: 'Usage: /cookies' }],
  ['/quit', { flag: 'quit' }],
  ['/nope', { contentIncludes: 'Unknown command' }],
  ['//read', {}],
];
const SKIP_NETWORK = ['/gemini hello', '/yt gotham chess', '/download https://x.com/y', '/mail a@b.com', '/cookies /tmp/x'];

function commandCases() {
  const jobs = [];
  for (const [cmd, expect] of CMD_CASES) {
    jobs.push(async () => {
      const r = { case: `cmd ${cmd}`, ctx: 'article', ok: false, detail: '' };
      try {
        const { screen, ui, calls } = makeWiredUI();
        ui.setCenterContent(ARTICLE, []);
        typeSlash(screen, cmd);
        if (expect.waitMs) await new Promise((res) => setTimeout(res, expect.waitMs));
        const body = bodyText(screen);
        if (expect.contentIncludes && !body.includes(expect.contentIncludes)) {
          throw new Error(`missing ${JSON.stringify(expect.contentIncludes)}, got: ` + JSON.stringify(body.slice(0, 250)));
        }
        if (expect.flag === 'form' && body.length < 10) throw new Error('form did not paint');
        if (expect.flag === 'quit' && !calls.shutdowns.length) throw new Error('/quit did not shut down');
        if (expect.navigated && !calls.navigations.length) throw new Error('did not navigate');
        r.ok = true;
        r.detail = 'routed cleanly';
      } catch (e) {
        r.ok = false;
        r.detail = String((e && e.message) || e).slice(0, 300);
      }
      results.push(r);
    });
  }
  // Sequential: blessed screens share the process; parallel builds flake.
  return jobs.reduce((p, j) => p.then(j), Promise.resolve()).then(() => {
    for (const cmd of ['/read', '/play', '/copy', '/watch', '/queue']) {
      rec(`cmd ${cmd} (list ctx)`, 'list', (r) => {
        const { screen, ui } = makeWiredUI();
        ui.showLinkPicker(LINK_ROWS);
        typeSlash(screen, cmd);
        r.detail = 'routed cleanly from list';
      });
    }
  });
}

// Suggest round-trips (backspace must refilter exactly like typing):
// rows are compared tag-stripped, since highlight tags split substrings.
function paletteRows(screen) {
  const texts = [];
  (function walk(el) {
    try {
      if (typeof el.getContent === 'function') texts.push(String(el.getContent()));
    } catch { /* best effort */ }
    (el.children || []).forEach(walk);
  })(screen);
	return texts.join('\n').replace(/\x1b\[[0-9;]*m/g, '').replace(/\{[^}]*\}/g, '');
}

function suggestCases() {
  const jobs = [];
  jobs.push(async () => {
    const r = { case: 'suggest: backspace refilters the palette', ctx: 'input', ok: false, detail: '' };
    try {
      const { screen, ui } = makeWiredUI();
      ui.setCenterContent(ARTICLE.join(' '), []);
      press(screen, '/', { name: 'slash', full: '/' });
      await new Promise((res) => setTimeout(res, 120));
      press(screen, 'l', { name: 'l', full: 'l' });
      press(screen, 'i', { name: 'i', full: 'i' });
      await new Promise((res) => setTimeout(res, 350));
      if (!paletteRows(screen).includes('/links')) throw new Error('typed filter missing');
      press(screen, undefined, { name: 'backspace', full: 'backspace' });
      await new Promise((res) => setTimeout(res, 400));
      const t = paletteRows(screen);
      if (!ui.isCommandPaletteVisible()) throw new Error('palette vanished after backspace');
      if (!t.includes('/links')) throw new Error('backspace did not refilter, got: ' + JSON.stringify(t.slice(0, 200)));
      r.ok = true;
      r.detail = 'type + backspace both refilter';
    } catch (e) {
      r.ok = false;
      r.detail = String((e && e.message) || e).slice(0, 300);
    }
    results.push(r);
  });
  jobs.push(async () => {
    const r = { case: 'suggest: backspace to / restores full list', ctx: 'input', ok: false, detail: '' };
    try {
      const { screen, ui } = makeWiredUI();
      ui.setCenterContent(ARTICLE.join(' '), []);
      press(screen, '/', { name: 'slash', full: '/' });
      await new Promise((res) => setTimeout(res, 120));
      press(screen, 'a', { name: 'a', full: 'a' });
      await new Promise((res) => setTimeout(res, 350));
      press(screen, undefined, { name: 'backspace', full: 'backspace' });
      await new Promise((res) => setTimeout(res, 400));
      const t = paletteRows(screen);
      if (!t.includes('/yt') || !t.includes('/videos')) throw new Error('full list not restored, got: ' + JSON.stringify(t.slice(0, 200)));
      r.ok = true;
      r.detail = 'full list back after delete';
    } catch (e) {
      r.ok = false;
      r.detail = String((e && e.message) || e).slice(0, 300);
    }
    results.push(r);
  });
  return jobs.reduce((p, j) => p.then(j), Promise.resolve());
}

inputCases();
commandCases().then(() => suggestCases()).then(() => {
  for (const cmd of SKIP_NETWORK) {
    results.push({ case: `cmd ${cmd}`, ctx: 'skip', ok: true, skipped: true, detail: 'needs network/file/mail client — exercised live, not headless' });
  }
  const outPath = process.argv[2] || path.join(os.tmpdir(), 'keylog.json');
  fs.writeFileSync(outPath, JSON.stringify({ cases: results }, null, 0));
  for (const s of screens) {
    try { s.destroy(); } catch { /* best effort */ }
  }
  process.exit(0);
});
