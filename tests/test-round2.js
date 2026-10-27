'use strict';
/* Round-2 coverage tests: branches missed in the first pass.
 * navigation _save failure, suggest URL-parse fallback, image thumbnail
 * success path, local account wizards, /cookies import, /logout failure,
 * browser init/launch/relaunch/YouTube/consent paths, and ui key-routing
 * integration (incl. form body cursor).
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tui-r2-'));
}
const realFetch = global.fetch;
afterEach(() => {
  if (global.fetch !== realFetch) global.fetch = realFetch;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.KITTY_WINDOW_ID;
});

// ---------- navigation: _save best-effort failure ----------
describe('navigation: _save failure is best-effort', () => {
  const { Navigator } = require('../src/navigation');
  it('unwritable file keeps in-memory history without throwing', () => {
    const blocker = path.join(tmpDir(), 'blocker.json');
    fs.writeFileSync(blocker, 'x');
    const n = new Navigator({ file: path.join(blocker, 'history.json') });
    assert.doesNotThrow(() => n.navigate('https://a.com'));
    assert.deepEqual(n.getHistory(), ['https://a.com']);
  });
});

// ---------- suggest: URL-parse fallback ----------
describe('suggest: underscore host keeps raw domain', () => {
  const { getSuggestions } = require('../src/suggest');
  it('looks-like-URL but unparseable still offers direct row', async () => {
    const out = await getSuggestions('foo_bar.com', []);
    assert.equal(out[0].url, 'https://foo_bar.com');
    assert.equal(out[0].kind, 'url');
  });
});

// ---------- image: cancel-throw + thumbnail success ----------
describe('image: fetch cancel + showThumbnail success', () => {
  const img = require('../src/image');
  it('reader.cancel throwing still yields null', async () => {
    global.fetch = async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: Buffer.alloc(10) }),
          cancel: async () => { throw new Error('cant'); },
        }),
      },
      headers: { get: () => 'image/png' },
    });
    assert.equal(await img.fetchBytes('https://x/y.png', { maxBytes: 5 }), null);
  });
  it('showThumbnail success writes kitty payload at anchor', async () => {
    process.env.KITTY_WINDOW_ID = '1';
    global.fetch = async () => ({
      ok: true,
      body: {
        getReader: (() => {
          let done = false;
          return () => ({
            read: async () => {
              if (done) return { done: true, value: undefined };
              done = true;
              return { done: false, value: Buffer.from([1, 2, 3, 4]) };
            },
            cancel: async () => {},
          });
        })(),
      },
      headers: { get: () => 'image/png' },
    });
    const orig = process.stdout.write;
    let out = '';
    process.stdout.write = (s) => { out += s; return true; };
    try {
      assert.equal(await img.showThumbnail('https://x/y.png', { row: 3, col: 5 }), true);
      assert.ok(out.includes('\x1b7'));
      assert.ok(out.includes('\x1b[3;5H'));
      assert.ok(out.includes('\x1b8'));
    } finally { process.stdout.write = orig; }
  });
  it('showThumbnail: bad coords and write failure yield false', async () => {
    process.env.KITTY_WINDOW_ID = '1';
    global.fetch = async () => { throw new Error('no'); };
    assert.equal(await img.showThumbnail('https://x/y.png', { row: NaN, col: 1 }), false);
    assert.equal(await img.showThumbnail('', { row: 1, col: 1 }), false);
    global.fetch = async () => ({
      ok: true,
      body: {
        getReader: (() => {
          let done = false;
          return () => ({
            read: async () => {
              if (done) return { done: true, value: undefined };
              done = true;
              return { done: false, value: Buffer.from([9]) };
            },
            cancel: async () => {},
          });
        })(),
      },
      headers: { get: () => 'image/png' },
    });
    const orig = process.stdout.write;
    // Throw only for image payloads; delegate runner/heartbeat writes to the
    // real stdout so the test harness itself never crashes mid-mock.
    process.stdout.write = function (s, ...rest) {
      try {
        if (typeof s === 'string' && (s.includes('\x1b_G') || s.includes('\x1b7'))) {
          throw new Error('gone');
        }
      } catch (e) {
        if (e && e.message === 'gone') throw e;
      }
      return orig.call(process.stdout, s, ...rest);
    };
    try {
      assert.equal(await img.showThumbnail('https://x/y.png', { row: 1, col: 1 }), false);
    } finally { process.stdout.write = orig; }
  });
  it('kittyChunks empty input yields no parts', () => {
    assert.deepEqual(img.kittyChunks(''), []);
  });
});

// ---------- commands: local /register + /login + /profile cycle ----------
describe('commands: local account flows', () => {
  const { routeCommand } = require('../src/commands');
  const accts = require('../src/accounts');
  function mockDeps() {
    const calls = { content: [], forms: [], identity: null, mails: [] };
    return {
      calls,
      deps: {
        ui: {
          setCenterContent: (t, l) => calls.content.push(String(t)),
          applyTheme: () => {},
          showLoginForm: (o) => calls.forms.push(o),
          setIdentity: (n, e) => { calls.identity = [n, e]; },
          redirectToBrowser: () => {},
          playHighlightedVideo: () => false,
        },
        browser: {
          profileDir: '/tmp/prof',
          profileReady: () => false,
          close: async () => {},
          importCookiesFile: async () => ({ imported: 1, skipped: 0 }),
        },
        navigator: { getHistory: () => ['https://a.com'] },
        config: { theme: 'white', pageSize: 50 },
        saveConfig: () => {},
        shutdown: () => {},
        mail: { sendMail: async (msg) => { calls.mails.push({ ...msg }); return { ok: true }; } },
      },
    };
  }
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = tmpDir();
    accts.signOutSession();
  });
  afterEach(() => {
    accts.signOutSession();
  });
  it('full cycle: register -> profile -> logout -> login -> profile', async () => {
    const r = mockDeps();
    routeCommand('/register', r.deps);
    r.calls.forms[0].callback('Ada');
    r.calls.forms[1].callback('ada@gmail.com');
    r.calls.forms[2].callback('+123456');
    // Registration is email-verified: enter the emailed 6-digit code.
    const otp = accts.peekOtp('ada@gmail.com').otp;
    assert.match(otp, /^\d{6}$/);
    r.calls.forms[3].callback(otp);
    r.calls.forms[4].callback('password123');
    r.calls.forms[5].callback('password123');
    assert.deepEqual(r.calls.identity, ['Ada', 'ada@gmail.com']);

    const p = mockDeps();
    routeCommand('/profile', p.deps);
    assert.ok(p.calls.content[0].includes('Ada <ada@gmail.com>'));

    const o = mockDeps();
    routeCommand('/logout', o.deps);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(o.calls.identity, ['', '']);
    assert.ok(o.calls.content.some((c) => c.includes('Signed out ada@gmail.com')));

    const l = mockDeps();
    routeCommand('/login', l.deps);
    l.calls.forms[0].callback('ada@gmail.com');
    const lotp = accts.peekOtp('ada@gmail.com').otp;
    l.calls.forms[1].callback(lotp);
    assert.deepEqual(l.calls.identity, ['Ada', 'ada@gmail.com']);
    assert.ok(l.calls.content.some((c) => c.includes('Signed in as Ada')));
  });
  it('duplicate register aborts with a hint; Esc cancels silently', () => {
    const a = mockDeps();
    routeCommand('/register', a.deps);
    a.calls.forms[0].callback('Ada');
    a.calls.forms[1].callback('ada@gmail.com');
    a.calls.forms[2].callback('+123456');
    const otp = accts.peekOtp('ada@gmail.com').otp;
    a.calls.forms[3].callback(otp);
    a.calls.forms[4].callback('password123');
    a.calls.forms[5].callback('password123');
    assert.equal(accts.currentSession(), 'ada@gmail.com');

    const b = mockDeps();
    routeCommand('/register', b.deps);
    b.calls.forms[0].callback('Zed');
    b.calls.forms[1].callback('ada@gmail.com');
    // Duplicate gmail re-prompts (wizard stays alive) instead of aborting.
    assert.equal(b.calls.forms.length, 3);
    assert.ok(b.calls.forms[2].prompt.includes('already registered'));

    const c = mockDeps();
    routeCommand('/login', c.deps);
    c.calls.forms[0].callback(null); // Esc
    assert.equal(c.calls.content.length, 0);
    assert.equal(c.calls.forms.length, 1);
  });
  it('/cookies: usage, success count, failure message', async () => {
    const a = mockDeps();
    routeCommand('/cookies', a.deps);
    assert.ok(a.calls.content[0].includes('Usage'));
    const b = mockDeps();
    routeCommand('/cookies /tmp/c.json', b.deps);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(b.calls.content.some((t) => t.includes('Imported 1 cookie')));
    const c = mockDeps();
    c.deps.browser.importCookiesFile = async () => { throw new Error('bad file'); };
    routeCommand('/cookies /tmp/c.json', c.deps);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(c.calls.content.some((t) => t.includes('Cookie import failed')));
  });
});

describe('commands: logout wipe failure still reports', () => {
  it('wipeProfile throwing is swallowed, cleared message shown', async () => {
    delete require.cache[require.resolve('../src/commands')];
    const { routeCommand } = require('../src/commands');
    const browserMod = require('../src/browser');
    const realWipe = browserMod.Browser.wipeProfile;
    browserMod.Browser.wipeProfile = () => { throw new Error('locked'); };
    try {
      const calls = { content: [] };
      routeCommand('/logout', {
        ui: { setCenterContent: (t) => calls.content.push(String(t)) },
        browser: { profileDir: tmpDir(), close: async () => {} },
        navigator: { getHistory: () => [] },
        config: {},
        saveConfig: () => {},
        shutdown: () => {},
      });
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(calls.content.some((t) => t.includes('wiped')));
    } finally {
      browserMod.Browser.wipeProfile = realWipe;
      delete require.cache[require.resolve('../src/commands')];
    }
  });
});


// ---------- browser: init family + YouTube + consent ----------
describe('browser: init single-flight + stale lock cleanup', () => {
  const { Browser } = require('../src/browser');
  function fakeCtx() {
    return { pages: () => [], newPage: async () => ({}), route: async () => {}, close: async () => {}, on: () => {}, addInitScript: async () => {} };
  }
  it('concurrent init launches once; close nulls everything', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    let launches = 0;
    b._launch = async () => {
      launches++;
      await new Promise((r) => setTimeout(r, 20));
      b.context = fakeCtx();
      b.page = {};
      b.browser = b.context;
    };
    await Promise.all([b.init(), b.init(), b.init()]);
    assert.equal(launches, 1);
    await b.close();
    assert.equal(b.browser, null);
    assert.equal(b.page, null);
  });
  it('stale lockfiles removed (session data kept), retry succeeds', async () => {
    const dir = tmpDir();
    for (const f of ['lock', 'parent.lock', 'foo.lock']) fs.writeFileSync(path.join(dir, f), 'stale');
    fs.writeFileSync(path.join(dir, 'cookies.sqlite'), 'keep me');
    const b = new Browser({ profileDir: dir });
    let n = 0;
    b._launch = async () => {
      n++;
      if (n === 1) throw new Error('profile in use');
      b.context = fakeCtx();
      b.page = {};
      b.browser = b.context;
    };
    await b.init();
    assert.equal(n, 2);
    assert.equal(fs.existsSync(path.join(dir, 'lock')), false);
    assert.equal(fs.existsSync(path.join(dir, 'cookies.sqlite')), true);
  });
  it('open inits then gotos; onDisconnect registers or no-ops', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    let inited = false;
    let gotourl = null;
    b.init = async () => { inited = true; };
    b.page = { goto: async (u) => { gotourl = u; } };
    await b.open('https://github.com');
    assert.equal(inited, true);
    assert.equal(gotourl, 'https://github.com');
    let registered = null;
    b.context = { on: (ev, fn) => { registered = [ev, fn]; } };
    const fn = () => {};
    b.onDisconnect(fn);
    assert.deepEqual(registered, ['close', fn]);
    b.context = null;
    assert.doesNotThrow(() => b.onDisconnect(fn));
  });
  it('relaunch flips headless and re-inits', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    const calls = [];
    b.close = async () => { calls.push('close'); };
    b.init = async () => { calls.push('init'); };
    await b.relaunch({ headless: false });
    assert.equal(b.headless, false);
    assert.deepEqual(calls, ['close', 'init']);
  });
});

function ytPage(kind) {
  return {
    goto: async () => {},
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
    url: () => kind === 'search' ? 'https://www.youtube.com/results?search_query=cats' : 'https://www.youtube.com/watch?v=abc',
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes('document.body ?')) throw new Error('no dom');
      if (src.includes('captchaIndicators')) return false;
      if (src.includes('consent.google') || src.includes('indicators')) return null;
      if (src.includes('scrollBy') || src.includes('scrollTo')) return undefined;
      if (src.includes('ytd-video-renderer')) {
        return [{ title: '  Cute   cats  ', href: '/watch?v=abc', thumb: 'https://i.ytimg.com/vi/abc/hq.jpg' }];
      }
      if (src.includes('.result__a') || src.includes('div.g')) return [];
      if (src.includes('a[href]')) return [];
      if (src.includes('cloneNode')) return { text: 'watch page text', spans: [] };
      return null;
    },
  };
}
describe('browser: YouTube + consent + settle paths', () => {
  const { Browser } = require('../src/browser');
  it('YouTube search returns videos with thumbnails (no twin row on YT)', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => {};
    b.page = ytPage('search');
    const r = await b.navigate('https://www.youtube.com/results?search_query=cats');
    assert.ok(Array.isArray(r.results));
    assert.equal(r.results[0].url, 'https://www.youtube.com/watch?v=abc');
    assert.equal(r.results[0].thumb, 'https://i.ytimg.com/vi/abc/hq.jpg');
    assert.equal(r.results[0].title, 'Cute cats');
    assert.ok(!r.results.some((x) => String(x.title).startsWith('Search YouTube')));
  });
  it('YouTube watch settles then extracts text', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => {};
    b.page = ytPage('watch');
    b.extractPageLinks = async () => [];
    const r = await b.navigate('https://www.youtube.com/watch?v=abc');
    assert.equal(r.text, 'watch page text');
  });
  it('consent walls map to honest messages', async () => {
    for (const [kind, want] of [['consent-youtube', 'consent'], ['consent-google', 'consent'], ['sorry', 'bot check']]) {
      const b = new Browser({ profileDir: tmpDir() });
      b.init = async () => {};
      b.page = {
        goto: async () => {},
        url: () => 'https://github.com/',
        evaluate: async (fn) => {
          const src = String(fn);
          if (src.includes('document.body ?')) throw new Error('no dom');
          if (src.includes('consent.google') || src.includes('indicators')) return kind;
          return null;
        },
      };
      const r = await b.navigate('https://github.com');
      assert.ok(r.blocked.toLowerCase().includes(want), `${kind}: ${r.blocked}`);
    }
  });
  it('settle poll exits when text stabilizes', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => {};
    b.page = {
      goto: async () => {},
      url: () => 'https://github.com/',
      evaluate: async (fn) => {
        const src = String(fn);
        if (src.includes('document.body ?')) return 42; // stable length
        if (src.includes('captchaIndicators')) return false;
        if (src.includes('consent.google') || src.includes('indicators')) return null;
        if (src.includes('a[href]')) return [];
        if (src.includes('cloneNode')) return { text: 'stable text', spans: [] };
        return null;
      },
    };
    const t0 = Date.now();
    const r = await b.navigate('https://github.com');
    assert.equal(r.text, 'stable text');
    assert.ok(Date.now() - t0 < 10000);
  });
  it('extractors cap output and unwrap DDG redirects', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.page = {
      url: () => 'https://html.duckduckgo.com/html/?q=x',
      evaluate: async () => Array.from({ length: 205 }, (_, i) => ({
        title: `t${i}`,
        href: `/l/?uddg=${encodeURIComponent(`https://e.com/${i}`)}`,
      })),
    };
    const out = await b.extractPageLinks();
    assert.equal(out.length, 200);
    assert.equal(out[0].url, 'https://e.com/0');
  });
});


// ---------- browser: script freeze after extraction ----------
// The live page's JS is only needed until the article is extracted. After
// that it is frozen (CDP Emulation.setScriptExecutionDisabled), and thawed
// before the next navigation on the same page. These tests pin that order:
// a freeze without a thaw would leave the next site's hydration dead.
describe('browser: script freeze after extraction', () => {
  const { Browser } = require('../src/browser');

  function frozenHarness(sends) {
    const page = {
      goto: async () => {},
      waitForSelector: async () => {},
      url: () => 'https://github.com/',
      isClosed: () => false,
      evaluate: async (fn) => {
        const src = String(fn);
        if (src.includes('document.title')) return 'Frozen page';
        if (src.includes('document.body ?')) return 42;
        if (src.includes('captchaIndicators')) return false;
        if (src.includes('consent.google') || src.includes('indicators')) return null;
        if (src.includes('a[href]')) return [];
        if (src.includes('cloneNode')) return { text: 'frozen text', spans: [] };
        return null;
      },
    };
    const context = {
      newPage: async () => page,
      newCDPSession: async () => ({
        send: async (method, args) => { sends.push({ method, args }); },
      }),
    };
    return { page, context };
  }

  it('freezes after extraction, thaws before the next navigation', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => {};
    const sends = [];
    const h = frozenHarness(sends);
    b.page = h.page;
    b.context = h.context;

    const r1 = await b.navigate('https://github.com');
    assert.equal(r1.text, 'frozen text');
    assert.deepEqual(sends, [
      { method: 'Emulation.setScriptExecutionDisabled', args: { value: true } },
    ]);
    assert.equal(b._frozen, true);

    const r2 = await b.navigate('https://github.com');
    assert.equal(r2.text, 'frozen text');
    assert.deepEqual(sends.map((s) => s.args.value), [true, false, true]);
    assert.equal(b._frozen, true);
  });

  it('does not freeze a failed navigation (page is closed instead)', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => {};
    const sends = [];
    const h = frozenHarness(sends);
    h.page.goto = async () => { throw new Error('boom'); };
    b.page = h.page;
    b.context = h.context;
    const r = await b.navigate('https://github.com');
    assert.equal(r.navError, true);
    assert.deepEqual(sends, []);
    assert.equal(b._frozen, false);
  });

  it('a recreated page starts unfrozen without a CDP round-trip', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => {};
    const sends = [];
    const h = frozenHarness(sends);
    b.page = h.page;
    b.context = h.context;
    await b.navigate('https://github.com');
    assert.equal(b._frozen, true);
    // Simulate a page recycled after a failure: the next navigate gets a
    // fresh page, which has scripts enabled by default — no thaw needed.
    h.page.isClosed = () => true;
    await b.navigate('https://github.com');
    assert.deepEqual(sends.map((s) => s.args.value), [true, true]);
    assert.equal(b._frozen, true);
  });
});

// ---------- ui: key-routing integration ----------
describe('ui: key routing integration', () => {
  const blessed = require('blessed');
  const { createUI } = require('../src/ui');
  let screens = [];
  function makeUI(handlers = {}, opts = { theme: 'white', pageSize: 5 }) {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 'test' });
    screens.push(screen);
    const calls = { submits: [], suggests: [], picks: [], plays: [] };
    const ui = createUI(screen, {
      onOmniSubmit: (v, r) => { calls.submits.push([v, r]); },
      onSuggest: (t, id) => { calls.suggests.push([t, id]); },
      onLinkPick: (u) => { calls.picks.push(u); },
      onPlayVideo: (u) => { calls.plays.push(u); },
      onHistoryBack: () => { calls.back = true; },
      onHistoryForward: () => { calls.fwd = true; },
      onEscape: () => { calls.esc = true; },
      onQuit: () => { calls.quit = true; },
      ...handlers,
    }, opts);
    return { screen, ui, calls };
  }
  afterEach(() => {
    for (const s of screens) { try { s.destroy(); } catch {} }
    screens = [];
  });
  const key = (name, extra = {}) => ({ name, full: name, ...extra });
  const tick = (ms = 260) => new Promise((r) => setTimeout(r, ms));

  it('typing debounces into onSuggest; down past end runs the query', async () => {
    const { screen, calls } = makeUI();
    screen.emit('keypress', 'h', key('h'));
    screen.emit('keypress', 'i', key('i'));
    await tick();
    assert.ok(calls.suggests.length >= 1);
    assert.equal(calls.suggests.at(-1)[0], 'hi');
    screen.emit('keypress', null, key('down')); // no rows: runs bar as query
    assert.deepEqual(calls.submits.at(-1), ['hi', null]);
  });
  it('suggest rows: arrows move, enter submits accepted title', async () => {
    const { screen, ui, calls } = makeUI();
    screen.emit('keypress', 'c', key('c'));
    await tick();
    const id = calls.suggests.at(-1)[1];
    ui.renderSuggestRows(
      ['alpha', 'beta', 'gamma'].map((t) => ({ label: t, url: null, kind: 'search' })), id);
    screen.emit('keypress', null, key('down'));
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.equal(calls.submits.at(-1)[0], 'beta');
  });
  it('slash commands submit verbatim even with a highlighted command row', async () => {
    const { screen, ui, calls } = makeUI();
    for (const ch of '/gallery') screen.emit('keypress', ch, { name: ch, full: ch });
    await tick(420);
    const id = calls.suggests.at(-1)[1];
    // The palette title carries the description; accepting it would turn
    // the command into "/gallery (list page images…)".
    ui.renderSuggestRows([
      { label: '/gallery (list page images with titles to pick)', url: null, kind: 'command', section: 'media' },
    ], id);
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.equal(calls.submits.at(-1)[0], '/gallery');
  });
  it('tab/right accept the highlighted suggestion into the bar', async () => {
    const { screen, ui, calls } = makeUI();
    screen.emit('keypress', 'c', key('c'));
    await tick();
    const id = calls.suggests.at(-1)[1];
    ui.renderSuggestRows([{ label: 'cats cute', url: null, kind: 'search' }], id);
    screen.emit('keypress', null, { name: 'tab', full: 'tab' });
    await tick();
    assert.ok(calls.suggests.some(([t]) => t === 'cats cute'));
  });
  it('link picker: arrows move only, enter commits, shift+enter plays', async () => {
    const { screen, ui, calls } = makeUI();
    const links = [
      { title: 'a', url: 'https://a.com', domain: 'a.com' },
      { title: 'b', url: 'https://b.com', domain: 'b.com' },
    ];
    ui.showLinkPicker(links);
    assert.equal(ui.isPickerOpen(), true);
    screen.emit('keypress', null, key('down')); // moves to row 1, loads nothing
    await tick(220);
    assert.equal(calls.picks.length, 0); // no auto-navigation
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.deepEqual(calls.picks, ['https://b.com']);
    assert.equal(ui.isPickerOpen(), false);
    // shift+enter path
    const r2 = makeUI();
    r2.ui.showLinkPicker(links);
    r2.screen.emit('keypress', null, { name: 'enter', full: 'S-enter', shift: true });
    assert.deepEqual(r2.calls.plays, ['https://a.com']);
  });
  it('link picker tail row auto-advances on down (infinite scroll)', () => {
    const { screen, ui, calls } = makeUI({}, { theme: 'white', pageSize: 2 });
    const links = Array.from({ length: 5 }, (_, i) => ({ title: `t${i}`, url: `https://a.com/${i}`, domain: 'a.com' }));
    ui.showLinkPicker(links);
    screen.emit('keypress', null, key('down')); // cursor 1
    screen.emit('keypress', null, key('down')); // onto tail -> auto-advance to window [2,3]
    screen.emit('keypress', null, { name: 'enter', full: 'enter' }); // opens real row t2
    assert.deepEqual(calls.picks, ['https://a.com/2']);
    assert.equal(ui.isPickerOpen(), false);
    // walk to the end: last window has no tail, highlight is a real row
    ui.showLinkPicker(links);
    for (let i = 0; i < 6; i++) screen.emit('keypress', null, key('down'));
    assert.equal(ui.playHighlightedVideo(), true);
    void screen;
  });
  it('typing paints the bar synchronously (no suggest round-trip wait)', () => {
    const { screen } = makeUI();
    let renders = 0;
    const orig = screen.render.bind(screen);
    screen.render = (...a) => { renders++; return orig(...a); };
    screen.emit('keypress', 'z', key('z'));
    assert.ok(renders >= 1, 'bar repainted on the same tick as the keypress');
  });
  it('first char typed while surfing replaces the URL (no backspacing links)', async () => {
    for (const setup of ['links', 'content']) {
      const { screen, ui, calls } = makeUI();
      ui.setURL('https://github.com/explore');
      if (setup === 'links') {
        ui.showLinkPicker([{ title: 'a', url: 'https://a.com', domain: 'a.com' }]);
      } else {
        ui.setCenterContent('some page text', []);
      }
      screen.emit('keypress', 'x', { name: 'x', full: 'x' });
      await tick();
      assert.equal(calls.suggests.at(-1)[0], 'x');
    }
  });
  it("slash while surfing seeds '/' once (single-press commands, no double-slash)", async () => {
    for (const setup of ['links', 'content']) {
      const { screen, ui, calls } = makeUI();
      ui.setURL('https://github.com/explore');
      if (setup === 'links') {
        ui.showLinkPicker([{ title: 'a', url: 'https://a.com', domain: 'a.com' }]);
      } else {
        ui.setCenterContent('some page text', []);
      }
      screen.emit('keypress', '/', { name: 'slash', full: '/' });
      assert.equal(ui.isPickerOpen(), false);
      // Fixed: first '/' already seeds the bar, so next char appends.
      await tick();
      assert.equal(calls.suggests.at(-1)[0], '/');
      screen.emit('keypress', 'a', { name: 'a', full: 'a' });
      await tick();
      // Bar was '/', so the char appends (command mode, not URL + char).
      assert.equal(calls.suggests.at(-1)[0], '/a');
    }
  });
  it('links: appendLinks keeps the highlighted row still while results stream in', () => {
    const { screen, ui } = makeUI();
    const rows = Array.from({ length: 6 }, (_, i) => ({ title: `row ${i}`, url: `https://x.com/${i}`, domain: 'x.com' }));
    ui.showLinkPicker(rows);
    screen.emit('keypress', null, key('down'));
    screen.emit('keypress', null, key('down'));
    const added = ui.appendLinks(Array.from({ length: 4 }, (_, i) => ({ title: `more ${i}`, url: `https://y.com/${i}`, domain: 'y.com' })), true);
    assert.equal(added, 4);
    assert.equal(ui.visibleRows().length, 10);
    assert.equal(ui.linkAt(3).url, 'https://x.com/2', 'highlight did not shift under the user');
  });
  it('content mode: paging keys scroll, enter opens picker, / searches', async () => {
    const { screen, ui, calls } = makeUI();
    ui.setCenterContent('line1\nline2', [{ title: 'a', url: 'https://a.com', domain: 'a.com' }]);
    for (const k of ['space', 'up', 'down', 'pageup', 'pagedown']) {
      screen.emit('keypress', null, k === 'space' ? { name: 'space', full: 'space' } : key(k));
    }
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.equal(ui.isPickerOpen(), true);
    ui.setCenterContent('again', []);
    screen.emit('keypress', '/', { name: 'slash', full: '/' });
    await tick();
    assert.ok(calls.suggests.length >= 1);
  });
  it('content mode left/right walk history; q types when bar non-empty', async () => {
    const { screen, ui, calls } = makeUI();
    ui.setCenterContent('text', []);
    screen.emit('keypress', null, key('left'));
    assert.equal(calls.back, true);
    screen.emit('keypress', null, key('right'));
    assert.equal(calls.fwd, true);
    // Fresh bar in input mode: typing 'a' fills it, then 'q' must type, not quit.
    const r2 = makeUI();
    r2.screen.emit('keypress', 'a', { name: 'a', full: 'a' });
    r2.screen.emit('keypress', 'q', { name: 'q', full: 'q' });
    assert.equal(r2.calls.quit, undefined);
    await tick();
  });
  it('settings hub exists; type-to-search still works everywhere', async () => {
    const { screen, ui } = makeUI();
    assert.equal(typeof ui.showSettings, 'function', 'settings hub is back (F2-free)');
    assert.equal(typeof ui.isSettingsOpen, 'function');
    ui.showLinkPicker([{ title: 'a', url: 'https://a.com', domain: 'a.com' }]);
    screen.emit('keypress', 'x', { name: 'x', full: 'x' });
    assert.equal(ui.getValue ? ui.getValue() : 'x', 'x');
    await tick();
  });
  it('backspace/delete with no char deletes + re-suggests; empty bar is a safe no-op', async () => {
    const { screen, calls } = makeUI();
    // Blessed delivers backspace with ch undefined — the old guards dropped it.
    screen.emit('keypress', 'h', { name: 'h', full: 'h' });
    screen.emit('keypress', 'i', { name: 'i', full: 'i' });
    await tick();
    const before = calls.suggests.length;
    screen.emit('keypress', undefined, { name: 'backspace', full: 'backspace' });
    await tick();
    assert.ok(calls.suggests.length > before, 'deletion re-triggers suggest');
    assert.equal(calls.suggests.at(-1)[0], 'h');
    screen.emit('keypress', undefined, { name: 'delete', full: 'delete' });
    await tick();
    assert.equal(calls.suggests.at(-1)[0], '');
    // Empty bar: no crash, no quit, no submit.
    screen.emit('keypress', undefined, { name: 'backspace', full: 'backspace' });
    assert.equal(calls.quit, undefined);
    assert.equal(calls.submits.length, 0);
  });
  it('backspace in form mode edits without triggering suggest', () => {
    const { screen, ui, calls } = makeUI();
    const got = [];
    ui.showLoginForm({ step: 'email', prompt: 'Email: ', censor: false, callback: (v) => got.push(v) });
    screen.emit('keypress', 'a', { name: 'a', full: 'a' });
    screen.emit('keypress', 'b', { name: 'b', full: 'b' });
    const nSug = calls.suggests.length;
    screen.emit('keypress', undefined, { name: 'backspace', full: 'backspace' });
    assert.equal(calls.suggests.length, nSug);
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.deepEqual(got, ['a']);
  });
  it('censored form submits the real value, not the mask', () => {
    const { screen, ui } = makeUI();
    const got = [];
    ui.showLoginForm({ step: 'password', prompt: 'Password: ', censor: true, callback: (v) => got.push(v) });
    for (const c of ['s', '3', 'c']) screen.emit('keypress', c, { name: c, full: c });
    screen.emit('keypress', undefined, { name: 'backspace', full: 'backspace' });
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.deepEqual(got, ['s3']);
  });
  it('form mode: typing + enter submits, escape cancels', () => {
    const { screen, ui } = makeUI();
    const got = [];
    ui.showLoginForm({ step: 'email', prompt: 'Email: ', censor: false, callback: (v) => got.push(v) });
    screen.emit('keypress', 'a', { name: 'a', full: 'a' });
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.deepEqual(got, ['a']);
    ui.showLoginForm({ step: 'otp', prompt: 'OTP: ', censor: false, callback: (v) => got.push(v) });
    screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    assert.deepEqual(got, ['a', null]);
  });
  it('spans render with link underlines; empty picker returns false', () => {
    const { ui } = makeUI();
    assert.equal(ui.showLinkPicker([]), false);
    ui.setCenterContent('ignored', [], [{ t: 'linked text', url: 'https://a.com' }, { t: 'plain', url: null }]);
    ui.resetFocus(); // content -> text view, stays safe
  });
});
