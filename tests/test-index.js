'use strict';
/* Index orchestration tests: routeInput / handleNavigation / playVideo.
 * Isolated in its own file because it mocks `blessed` and `./ui` before
 * requiring `src/index.js` (which boots the TUI on require).
 */
const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let idx; // test seam from src/index.js
let stubs;

before(() => {
  process.env.TUI_TEST = '1';
  process.env.XDG_CONFIG_HOME = require('node:os').tmpdir() + '/tui-idx-' + Date.now();

  // ---- mock blessed BEFORE index requires it ----
  const blessedPath = require.resolve('blessed');
  require('blessed');
  const fakeScreen = {
    width: 80, height: 24, focused: null,
    key: () => {}, on: () => {}, render: () => {}, destroy: () => {},
  };
  require.cache[blessedPath].exports.screen = () => fakeScreen;
  require.cache[blessedPath].exports.box = (opts) => ({
    on: () => {}, setContent: () => {}, render: () => {},
    ...opts,
  });
  require.cache[blessedPath].exports.textbox = (opts) => ({
    on: () => {}, setValue: () => {}, getValue: () => '',
    focus: () => {},
    ...opts,
  });

  // ---- mock ./ui createUI BEFORE index requires it ----
  const uiPath = require.resolve('../src/ui');
  require(uiPath);
  const uiCalls = { center: [], url: [], captcha: 0, redirected: [], picker: [], game: [], theme: null, settings: 0, loginForms: [], suggestRendered: [], ytPicker: [], status: [], viz: [], vizOn: false, aiAnswers: [], pdfSplit: [] };
  const captured = {};
  const fakeUI = {
    setURL: (u) => uiCalls.url.push(u),
    setCenterContent: (t, links, spans) => uiCalls.center.push({ t, links, spans }),
    showCaptcha: () => uiCalls.captcha++,
    redirectToBrowser: (u) => uiCalls.redirected.push(u),
    showLinkPicker: (r) => uiCalls.picker.push(r),
    showGame: (o) => { uiCalls.game.push(o || {}); return true; },
    resetFocus: () => { uiCalls.esc = true; },
    renderSuggestRows: (rows, id) => uiCalls.suggestRendered.push({ rows, id }),
    applyTheme: (n) => { uiCalls.theme = n; },
    showLoginForm: (o) => { uiCalls.loginForms.push(o); },
    playHighlightedVideo: () => false,
    showYouTubePicker: (rows, q) => { uiCalls.ytPicker.push({ rows, q }); },
    setStatus: (t) => { uiCalls.status.push(String(t)); },
    flashStatus: (t) => { uiCalls.status.push(String(t)); },
    clearStatus: () => { uiCalls.status.push('[clear]'); },
    showVisualizer: () => { uiCalls.vizOn = true; uiCalls.viz.push('show'); },
    hideVisualizer: () => { uiCalls.vizOn = false; uiCalls.viz.push('hide'); },
    isVisualizerOn: () => !!uiCalls.vizOn,
    setVizPaused: (p) => { uiCalls.viz.push(p ? 'paused' : 'resumed'); },
    setVizEnergy: () => {},
    setVizBands: () => {},
    setAiAnswer: (t, opts) => uiCalls.aiAnswers.push({ text: String(t), opts: opts || {} }),
    setAiAnswerPending: () => uiCalls.aiAnswers.push({ text: '[pending]', opts: { pending: true } }),
    setAiAnswerError: (e) => uiCalls.aiAnswers.push({ text: `[error] ${e}`, opts: { error: true } }),
    showPdfSplit: (pages) => { uiCalls.pdfSplit.push(pages); return true; },
  };
  require.cache[uiPath].exports.createUI = (screen, handlers) => {
    captured.handlers = handlers;
    return fakeUI;
  };

  // ---- stub Browser network: no real Firefox ----
  const browserMod = require('../src/browser');
  browserMod.Browser.prototype.init = async () => {};
  browserMod.Browser.prototype.close = async () => {};

  idx = require('../src/index.js');
  stubs = { uiCalls, fakeUI, fakeScreen, browserMod, captured };
});

describe('index: handleNavigation happy path', () => {
  it('commits history + paints text for plain pages', async () => {
    const before = idx.navigator.getHistory().length;
    stubs.browserMod.Browser.prototype.navigate = async () => ({ text: 'hello', links: [], spans: [] });
    await idx.handleNavigation('https://github.com');
    assert.equal(idx.navigator.getHistory().length, before + 1);
    const last = stubs.uiCalls.center[stubs.uiCalls.center.length - 1];
    assert.ok(last.t.includes('hello') || stubs.uiCalls.url.length > 0);
  });
  it('every navigation commits history (no preview mode anymore)', async () => {
    stubs.browserMod.Browser.prototype.navigate = async () => ({ text: 'p', links: [] });
    const before = idx.navigator.getHistory().length;
    await idx.handleNavigation('https://preview.com');
    assert.equal(idx.navigator.getHistory().length, before + 1);
  });
});

describe('index: handleNavigation branches', () => {
  it('invalid URL paints hint, no history', async () => {
    const before = idx.navigator.getHistory().length;
    await idx.handleNavigation('::::not a url::::');
    assert.equal(idx.navigator.getHistory().length, before);
    assert.ok(stubs.uiCalls.center.at(-1).t.includes('Invalid URL'));
  });
  it('blocked page paints message without auto-open', async () => {
    stubs.browserMod.Browser.prototype.navigate = async () => ({ blocked: 'walled' });
    const n0 = stubs.uiCalls.center.length;
    await idx.handleNavigation('https://walled.com');
    assert.ok(stubs.uiCalls.center.at(-1).t.startsWith('walled'));
    assert.ok(stubs.uiCalls.center.at(-1).t.includes('\n\n'));
    assert.ok(stubs.uiCalls.center.length > n0);
  });
  it('captcha shows captcha + redirects', async () => {
    stubs.browserMod.Browser.prototype.navigate = async () => ({ captcha: 'solve' });
    const c0 = stubs.uiCalls.captcha;
    await idx.handleNavigation('https://cap.com');
    assert.equal(stubs.uiCalls.captcha, c0 + 1);
    assert.equal(stubs.uiCalls.redirected.at(-1), 'https://cap.com');
  });
  it('results open the link picker', async () => {
    const rows = [{ title: 't', url: 'https://a.com', domain: 'a.com' }];
    stubs.browserMod.Browser.prototype.navigate = async () => ({ results: rows, links: rows });
    await idx.handleNavigation('https://html.duckduckgo.com/html/?q=x');
    assert.deepEqual(stubs.uiCalls.picker.at(-1), rows);
  });
  it('a page that never landed tells the user they are offline and opens the arcade', async () => {
    stubs.browserMod.Browser.prototype.navigate = async () => ({
      text: 'Error: page.goto: Timeout 30000ms exceeded. Call log: navigating to "https://www.youtube.com/", waiting until "domcontentloaded"',
      navError: true,
    });
    const n0 = stubs.uiCalls.center.length;
    const g0 = stubs.uiCalls.game.length;
    await idx.handleNavigation('https://www.youtube.com');
    assert.ok(stubs.uiCalls.center.length > n0, 'the failure paints');
    const last = stubs.uiCalls.center.at(-1);
    assert.ok(last.t.startsWith('Error:'), 'the honest error, not a fake page');
    assert.ok(last.t.includes('domcontentloaded'), 'the real message survives');
    assert.equal(stubs.uiCalls.game.length, g0 + 1, 'the arcade opens as consolation');
    assert.ok(stubs.uiCalls.game.at(-1).head.includes('Error:'), 'the error is the game header');
    assert.ok(/No internet/i.test(stubs.uiCalls.game.at(-1).note), 'the note tells the user they are offline');
  });
  it('an ordinary load failure stays a card — no arcade for a refused host', async () => {
    stubs.browserMod.Browser.prototype.navigate = async () => ({
      text: 'Error: page.goto: net::ERR_CONNECTION_REFUSED',
      navError: true,
    });
    const g0 = stubs.uiCalls.game.length;
    await idx.handleNavigation('https://refused.example');
    assert.ok(stubs.uiCalls.center.at(-1).t.startsWith('Error:'), 'still an honest error card');
    assert.equal(stubs.uiCalls.game.length, g0, 'no arcade for a down site');
  });
  it('question + key: real answer lands in the AI slot (answer style)', async () => {
    const or = require('../src/openrouter');
    const realResolve = or.resolveKey;
    const realAsk = or.askAi;
    try {
      or.resolveKey = () => 'AQ.fake-test-key-000';
      let resolveAnswer;
      const gate = new Promise((r) => { resolveAnswer = r; });
      const asked = [];
      or.askAi = (q, opts) => { asked.push({ q, opts }); return gate; };
      const rows = [{ title: 'Godot engine', url: 'https://godot.org', domain: 'godot.org' }];
      stubs.browserMod.Browser.prototype.navigate = async () => ({ results: rows, links: rows, searchQuery: 'what is godot' });
      stubs.uiCalls.aiAnswers.length = 0;
      await idx.handleNavigation('https://html.duckduckgo.com/html/?q=what+is+godot');
      resolveAnswer({ ok: true, error: '', text: '**Godot** is a game engine.' });
      await gate;
      await new Promise((r) => setImmediate(r));
      assert.equal(asked.length, 1);
      assert.equal(asked[0].q, 'what is godot');
      assert.ok(asked[0].opts && asked[0].opts.style && /terminal reader/.test(asked[0].opts.style), 'answer style passed');
      assert.equal(typeof asked[0].opts.onDelta, 'function', 'streaming progress wired to the search answer');
      assert.equal(asked[0].opts.timeoutMs, or.TIMEOUT_MS, 'generous free-model cap, not the old 75s');
      const landed = stubs.uiCalls.aiAnswers.filter((a) => !a.opts.pending);
      assert.ok(landed.at(-1).text.includes('Godot'), JSON.stringify(landed));
      // A streamed delta fills the box live, before the final signed answer.
      stubs.uiCalls.aiAnswers.length = 0;
      asked[0].opts.onDelta('partial streamed text');
      const streamed = stubs.uiCalls.aiAnswers.at(-1);
      assert.ok(streamed && /partial streamed text/.test(streamed.text), 'streamed delta painted: ' + JSON.stringify(streamed));
    } finally {
      or.resolveKey = realResolve;
      or.askAi = realAsk;
    }
  });
  it('no key: the box points at /settings → AI, API never called', async () => {
    const or = require('../src/openrouter');
    const realResolve = or.resolveKey;
    const realAsk = or.askAi;
    try {
      or.resolveKey = () => '';
      let called = 0;
      or.askAi = () => { called++; return Promise.resolve({ ok: false, error: 'x', text: '' }); };
      const rows = [{ title: 'Godot engine', url: 'https://godot.org', domain: 'godot.org' }];
      stubs.browserMod.Browser.prototype.navigate = async () => ({ results: rows, links: rows, searchQuery: 'what is godot' });
      stubs.uiCalls.aiAnswers.length = 0;
      await idx.handleNavigation('https://html.duckduckgo.com/html/?q=what+is+godot');
      assert.equal(called, 0, 'no API call without a key');
      const hint = stubs.uiCalls.aiAnswers.at(-1);
      assert.ok(hint && /\/settings/.test(hint.text), JSON.stringify(hint));
      assert.match(hint.text, /OpenRouter API key in \/settings/i, 'points at the settings hub');
    } finally {
      or.resolveKey = realResolve;
      or.askAi = realAsk;
    }
  });
  it('non-question query never calls the API', async () => {
    const or = require('../src/openrouter');
    const realAsk = or.askAi;
    try {
      let called = 0;
      or.askAi = () => { called++; return Promise.resolve({ ok: true, error: '', text: 'x' }); };
      const rows = [{ title: 'GitHub', url: 'https://github.com', domain: 'github.com' }];
      stubs.browserMod.Browser.prototype.navigate = async () => ({ results: rows, links: rows, searchQuery: 'github' });
      await idx.handleNavigation('https://html.duckduckgo.com/html/?q=github');
      await new Promise((r) => setImmediate(r));
      assert.equal(called, 0);
    } finally {
      or.askAi = realAsk;
    }
  });
  it('page AI card is replaced by the rich answer (OpenRouter is called)', async () => {
    const or = require('../src/openrouter');
    const realResolve = or.resolveKey;
    const realAsk = or.askAi;
    try {
      or.resolveKey = () => 'AQ.fake-test-key-000';
      let called = 0;
      let resolveAnswer;
      const gate = new Promise((r) => { resolveAnswer = r; });
      or.askAi = (q, opts) => { called++; return gate; };
      const rows = [{ title: 'Godot engine', url: 'https://godot.org', domain: 'godot.org' }];
      stubs.browserMod.Browser.prototype.navigate = async () => ({ results: rows, links: rows, searchQuery: 'what is godot', ai: 'Google says stuff' });
      stubs.uiCalls.aiAnswers.length = 0;
      await idx.handleNavigation('https://html.duckduckgo.com/html/?q=what+is+godot');
      await new Promise((r) => setImmediate(r));
      assert.equal(called, 1, 'rich answer is fetched even with a page card');
      // The pending box is showing; the rich answer replaces it when it lands.
      const pending = stubs.uiCalls.aiAnswers.at(-1);
      assert.ok(pending && /thinking|pending/i.test(pending.text), 'pending placeholder first: ' + JSON.stringify(pending));
      resolveAnswer({ ok: true, error: '', text: 'Godot is a free, open-source engine.', model: 'nvidia/nemotron-3-super-120b-a12b:free' });
      await gate;
      await new Promise((r) => setImmediate(r));
      const landed = stubs.uiCalls.aiAnswers.at(-1);
      assert.ok(landed && /free, open-source/.test(landed.text), 'rich answer replaced the card: ' + JSON.stringify(landed));
    } finally {
      or.resolveKey = realResolve;
      or.askAi = realAsk;
    }
  });
  it('stale answer dropped after navigating away', async () => {
    const or = require('../src/openrouter');
    const realResolve = or.resolveKey;
    const realAsk = or.askAi;
    try {
      or.resolveKey = () => 'AQ.fake-test-key-000';
      let resolveAnswer;
      const gate = new Promise((r) => { resolveAnswer = r; });
      or.askAi = () => gate;
      const rows = [{ title: 'Godot engine', url: 'https://godot.org', domain: 'godot.org' }];
      stubs.browserMod.Browser.prototype.navigate = async () => ({ results: rows, links: rows, searchQuery: 'what is godot' });
      stubs.uiCalls.aiAnswers.length = 0;
      await idx.handleNavigation('https://html.duckduckgo.com/html/?q=what+is+godot');
      stubs.browserMod.Browser.prototype.navigate = async () => ({ text: 'plain page', links: [] });
      await idx.handleNavigation('https://example.com');
      resolveAnswer({ ok: true, error: '', text: 'STALE-ANSWER-MARKER' });
      await gate;
      await new Promise((r) => setImmediate(r));
      assert.ok(!stubs.uiCalls.aiAnswers.some((a) => String(a.text).includes('STALE-ANSWER-MARKER')), 'stale dropped: ' + JSON.stringify(stubs.uiCalls.aiAnswers));
    } finally {
      or.resolveKey = realResolve;
      or.askAi = realAsk;
    }
  });
  it('tracker counts (net) never hijack the bot-wall branch', async () => {
    // Regression: navigate() started returning `blocked: {page,total}`
    // (tracker counts) and the wall check read it as a message, so every
    // page painted "[object Object]" and searches died. Counts now travel
    // as `net`, and the wall check is string-only.
    const rows = [{ title: 't', url: 'https://a.com', domain: 'a.com' }];
    stubs.browserMod.Browser.prototype.navigate = async () => ({ results: rows, links: rows, net: { page: 7, total: 9 } });
    const c0 = stubs.uiCalls.center.length;
    await idx.handleNavigation('https://html.duckduckgo.com/html/?q=y');
    assert.deepEqual(stubs.uiCalls.picker.at(-1), rows, 'the list still opens');
    assert.equal(stubs.uiCalls.center.length, c0, 'nothing painted as text');
  });
  it('a non-string blocked value is ignored, not printed', async () => {
    stubs.browserMod.Browser.prototype.navigate = async () => ({ text: 'real page', links: [], blocked: { page: 3 } });
    await idx.handleNavigation('https://obj.com');
    const painted = stubs.uiCalls.center.at(-1).t;
    assert.ok(!painted.includes('[object'), `painted: ${painted}`);
    assert.ok(painted.includes('real page'), `painted: ${painted}`);
  });
  it('navigation errors paint Error text', async () => {
    stubs.browserMod.Browser.prototype.navigate = async () => { throw new Error('net down'); };
    await idx.handleNavigation('https://err.com');
    assert.ok(stubs.uiCalls.center.at(-1).t.includes('Error'));
  });
  it('stale overlapping navigations: only latest paints', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    stubs.browserMod.Browser.prototype.navigate = async (url) => {
      if (url.includes('slow')) { await gate; }
      calls++;
      return { text: `body ${url}`, links: [] };
    };
    const p1 = idx.handleNavigation('https://slow.com');
    const p2 = idx.handleNavigation('https://fast.com');
    release();
    await Promise.all([p1, p2]);
    assert.equal(calls, 2);
    assert.ok(stubs.uiCalls.center.at(-1).t.includes('fast'));
  });
  it('same-url twin while in flight: one navigation, one history entry', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    stubs.browserMod.Browser.prototype.navigate = async (url) => {
      calls++;
      if (url.includes('twin')) await gate;
      return { text: `body ${url}`, links: [] };
    };
    const before = idx.navigator.getHistory().length;
    const p1 = idx.handleNavigation('https://twin.example.com/page');
    // The CR twin: the same url arrives again while the first goto runs.
    const p2 = idx.handleNavigation('https://twin.example.com/page');
    release();
    await Promise.all([p1, p2]);
    assert.equal(calls, 1, 'twin must not race a second goto');
    assert.equal(idx.navigator.getHistory().length, before + 1, 'no duplicate history entry');
    // Settled: the same url is a normal reload again.
    await idx.handleNavigation('https://twin.example.com/page');
    assert.equal(calls, 2, 'reload after landing still navigates');
  });
});

describe('index: routeInput', () => {
  it('slash command routes to commands (no navigation)', async () => {
    stubs.browserMod.Browser.prototype.navigate = async () => ({ text: 'x', links: [] });
    const n0 = stubs.uiCalls.center.length;
    idx.routeInput('/help', null);
    assert.equal(stubs.uiCalls.center.length, n0 + 1);
  });
  it('highlighted concrete command row wins over partial input', () => {
    const n0 = stubs.uiCalls.center.length;
    idx.routeInput('/the', { kind: 'command', title: '/pets' });
    assert.equal(stubs.uiCalls.center.length, n0 + 1);
  });
  it('placeholder <name> rows fall through to typed value', () => {
    const n0 = stubs.uiCalls.center.length;
    idx.routeInput('/links 50', { kind: 'command', title: '/links [10|25|50|100]' });
    assert.ok(stubs.uiCalls.center.length >= n0); // sets page size or hints, never throws
  });
  it('URL row navigates directly', async () => {
    stubs.browserMod.Browser.prototype.navigate = async () => ({ text: 'row', links: [] });
    await idx.routeInput('whatever', { url: 'https://row.com', title: 'row' });
    assert.ok(stubs.uiCalls.url.includes('https://row.com'));
  });
  it('bare domain becomes https URL; query becomes DDG search', async () => {
    stubs.browserMod.Browser.prototype.navigate = async () => ({ text: 't', links: [] });
    await idx.routeInput('github.com', null);
    assert.ok(stubs.uiCalls.url.includes('https://github.com'));
    await idx.routeInput('how to bake bread', null);
    assert.ok(stubs.uiCalls.url.some((u) => String(u).includes('duckduckgo')));
    // Keep-query: the bar ends holding the search text for one-edit refining.
    assert.equal(stubs.uiCalls.url.at(-1), 'how to bake bread');
  });
  it('empty input is a no-op', async () => {
    const n = stubs.uiCalls.url.length;
    await idx.routeInput('   ', null);
    assert.equal(stubs.uiCalls.url.length, n);
  });
  it('a `>` bang never rides a suggestion row (teaches instead of searching)', async () => {
    const n = stubs.uiCalls.url.length;
    stubs.uiCalls.status.length = 0;
    await idx.routeInput('>nope', { url: 'https://html.duckduckgo.com/html/?q=nope', title: 'nope' });
    assert.equal(stubs.uiCalls.url.length, n, 'no navigation for bang syntax');
    assert.ok(stubs.uiCalls.status.some((s) => s.includes('Unknown scope')), JSON.stringify(stubs.uiCalls.status));
    stubs.uiCalls.status.length = 0;
    await idx.routeInput('>nope cats', { url: 'https://html.duckduckgo.com/html/?q=nope+cats', title: 'nope cats' });
    assert.equal(stubs.uiCalls.url.length, n, 'still no navigation with a query');
    assert.ok(stubs.uiCalls.status.some((s) => s.includes('Unknown scope')));
  });
  it('a valid bang scopes its search even with a row highlighted', async () => {
    const n = stubs.uiCalls.url.length;
    await idx.routeInput('>example.com cats', { url: 'https://html.duckduckgo.com/html/?q=cats', title: 'cats' });
    assert.ok(stubs.uiCalls.url.length > n, 'scoped search navigated');
    const last = String(stubs.uiCalls.url.at(-1));
    assert.ok(last.includes('example.com'), 'the domain scope won: ' + last);
    assert.ok(!/html\.duckduckgo\.com\/html\/\?q=cats$/.test(last), 'the plain DDG row was not picked: ' + last);
  });
});

describe('index: pure helpers normalizeURL + searchURL', () => {
  it('normalizeURL: https passthrough, bare domain, rejects garbage', () => {
    assert.equal(idx.normalizeURL('https://github.com/sindresorhus/awesome'), 'https://github.com/sindresorhus/awesome');
    assert.equal(idx.normalizeURL('github.com'), 'https://github.com');
    assert.equal(idx.normalizeURL('  github.com/a  '), 'https://github.com/a');
    assert.equal(idx.normalizeURL('how to bake'), null);
    assert.equal(idx.normalizeURL(''), null);
    assert.equal(idx.normalizeURL(null), null);
  });
  it('searchURL encodes the query into DDG html endpoint', () => {
    assert.equal(idx.searchURL('cats & dogs'), 'https://html.duckduckgo.com/html/?q=cats%20%26%20dogs');
  });
});

describe('index: playVideo handoff', () => {
  const cp = require('node:child_process');
  let spawned;
  const real = cp.execFile;
  const realSpawn = cp.spawn;
  const { beforeEach, afterEach } = require('node:test');
  beforeEach(() => {
    spawned = [];
    cp.execFile = (cmd, args, opts, cb) => {
      spawned.push([cmd, args]);
      const cbFn = typeof opts === 'function' ? opts : cb;
      if (cmd === 'yt-dlp' && typeof cbFn === 'function') {
        cbFn(null, 'https://cdn.github.com/v.mp4\n', '');
      }
      return { unref: () => {} };
    };
    // Stubbed players carry no pid: every play takes the spawn path here,
    // and no real mpv lingers to flip later plays into enqueue mode.
    cp.spawn = () => ({ stderr: { on: () => {} }, on: () => {}, unref: () => {} });
  });
  afterEach(() => { cp.execFile = real; cp.spawn = realSpawn; });
  it('http(s) resolves via yt-dlp then plays direct URL fullscreen', () => {
    const r = idx.playVideo('https://www.youtube.com/watch?v=1');
    assert.equal(r.ok, true);
    assert.equal(r.method, 'mpv-resolve');
    assert.equal(r.quality, '480');
    assert.ok(spawned.some(([c]) => c === 'yt-dlp'));
  });
  it('dry-run returns resolve args without spawning', () => {
    spawned.length = 0;
    const r = idx.playVideo('https://www.youtube.com/watch?v=dryrun2', { dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.deepEqual(spawned, []);
  });
  it('non-http and invalid URLs spawn nothing', () => {
    idx.playVideo('ftp://x.com/a');
    idx.playVideo('::::');
    idx.playVideo('');
    assert.deepEqual(spawned, []);
  });
  it('resolver spawn failure never opens a browser (stays in TUI)', () => {
    cp.execFile = () => { throw new Error('nothing'); };
    assert.doesNotThrow(() => idx.playVideo('https://github.com/'));
    const r2 = idx.playVideo('https://github.com/');
    assert.equal(r2.ok, true); // resolve kicked off; failure surfaces async, never browser
    assert.equal(r2.method, 'mpv-resolve');
  });
});

describe('index: shutdown + onPlayVideo handler', () => {
  it('shutdown destroys screen, closes browser, exits with code', async () => {
    let destroyed = false;
    let closed = false;
    let code = null;
    const realExit = process.exit;
    process.exit = (c) => { code = c; };
    stubs.fakeScreen.destroy = () => { destroyed = true; };
    const origClose = stubs.browserMod.Browser.prototype.close;
    stubs.browserMod.Browser.prototype.close = async () => { closed = true; };
    try {
      idx.shutdown(0);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(destroyed, true);
      assert.equal(closed, true);
      assert.equal(code, 0);
    } finally {
      process.exit = realExit;
      stubs.browserMod.Browser.prototype.close = origClose;
    }
  });
  it('onPlayVideo resolves http URLs via yt-dlp (no direct mpv, no browser)', () => {
    const cp = require('node:child_process');
    const real = cp.execFile;
    const spawned = [];
    cp.execFile = (cmd, args) => { spawned.push(cmd); return { unref: () => {} }; };
    try {
      stubs.captured.handlers.onPlayVideo('https://vid.com/watch?v=1');
      // Resolves via yt-dlp (never direct mpv); the resolver may try several
      // YouTube clients, so assert yt-dlp is what gets called.
      assert.ok(spawned.length >= 1, 'yt-dlp was called');
      assert.ok(spawned.every((c) => c === 'yt-dlp'), 'only yt-dlp, no direct mpv: ' + JSON.stringify(spawned));
    } finally { cp.execFile = real; }
  });
  it('onQuit shuts down; onOmniSubmit routes input', async () => {
    let code = null;
    const realExit = process.exit;
    process.exit = (c) => { code = c; };
    const origClose = stubs.browserMod.Browser.prototype.close;
    stubs.browserMod.Browser.prototype.close = async () => {};
    try {
      stubs.browserMod.Browser.prototype.navigate = async () => ({ text: 'q', links: [] });
      stubs.captured.handlers.onOmniSubmit('/help', null);
      assert.ok(stubs.uiCalls.center.length > 0);
      stubs.captured.handlers.onQuit();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(code, 0);
    } finally {
      process.exit = realExit;
      stubs.browserMod.Browser.prototype.close = origClose;
    }
  });
});
describe('index: UI event handlers', () => {
  it('onSuggest: empty bar renders blank with same id (no network)', async () => {
    const H = stubs.captured.handlers;
    H.onSuggest('   ', 41);
    assert.deepEqual(stubs.uiCalls.suggestRendered.at(-1), { rows: [], id: 41 });
  });
  it('onSuggest: slash input completes locally', () => {
    const H = stubs.captured.handlers;
    H.onSuggest('/set', 42);
    const got = stubs.uiCalls.suggestRendered.at(-1);
    assert.equal(got.id, 42);
    assert.ok(got.rows.some((r) => r.label.startsWith('/settings')));
  });
  it('onSuggest: query fans out to web + history', async () => {
    const H = stubs.captured.handlers;
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => [{ phrase: 'zz cats' }] });
    try {
      H.onSuggest('zz', 43);
      await new Promise((r) => setTimeout(r, 30));
      const got = stubs.uiCalls.suggestRendered.at(-1);
      assert.equal(got.id, 43);
      assert.ok(got.rows.some((r) => r.label === 'zz cats'));
    } finally { global.fetch = realFetch; }
  });
  it('onSuggest: local rows paint synchronously, web rows merge after', async () => {
    const H = stubs.captured.handlers;
    const realFetch = global.fetch;
    let release;
    const gate = new Promise((r) => { release = r; });
    global.fetch = async () => {
      await gate;
      return { ok: true, json: async () => [{ phrase: 'slow web hit' }] };
    };
    try {
      idx.navigator.navigate('https://github.com/local-only/pets');
      H.onSuggest('pets', 44);
      const sync = stubs.uiCalls.suggestRendered.at(-1);
      assert.equal(sync.id, 44); // phase 1 painted without awaiting fetch
      assert.ok(sync.rows.every((r) => r.label !== 'slow web hit'));
      release();
      await new Promise((r) => setTimeout(r, 30));
      const merged = stubs.uiCalls.suggestRendered.at(-1);
      assert.equal(merged.id, 44);
      assert.ok(merged.rows.some((r) => r.label === 'slow web hit'));
    } finally { global.fetch = realFetch; }
  });
  it('onSuggest: new keystroke aborts the previous web fetch', async () => {
    const H = stubs.captured.handlers;
    const realFetch = global.fetch;
    const signals = [];
    global.fetch = (url, { signal } = {}) => {
      signals.push(signal);
      return new Promise((_, reject) => {
        if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    try {
      H.onSuggest('ab', 45);
      await new Promise((r) => setTimeout(r, 10));
      H.onSuggest('abc', 46);
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(signals.length, 2);
      assert.equal(signals[0].aborted, true); // stale fetch cancelled
      assert.equal(signals[1].aborted, false); // current fetch alive
    } finally { global.fetch = realFetch; }
  });
  it('onLinkPick plays youtube watch URLs instead of navigating', async () => {
    const cp = require('node:child_process');
    const realSpawn = cp.spawn;
    const spawned = [];
    cp.spawn = (cmd, args) => {
      spawned.push([cmd, args]);
      return { stderr: { on: () => {} }, on: () => {}, unref: () => {} };
    };
    const realExec = cp.execFile;
    cp.execFile = (cmd, args, opts, cb) => {
      const cbFn = typeof opts === 'function' ? opts : cb;
      if (cmd === 'yt-dlp' && typeof cbFn === 'function') {
        cbFn(null, 'https://cdn.github.com/v.mp4\n', '');
      }
      return { unref: () => {} };
    };
    try {
      const H = stubs.captured.handlers;
      const before = idx.navigator.getHistory().length;
      H.onLinkPick('https://www.youtube.com/watch?v=jNQXAC9IVRw');
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(spawned.some(([c]) => c === 'mpv'), 'mpv spawned for watch link');
      assert.equal(idx.navigator.getHistory().length, before, 'no history commit');
    } finally {
      cp.spawn = realSpawn;
      cp.execFile = realExec;
    }
  });
  it('onLinkPick navigates; navigation errors paint inline', async () => {
    const H = stubs.captured.handlers;
    stubs.browserMod.Browser.prototype.navigate = async () => ({ text: 'picked', links: [] });
    H.onLinkPick('https://picked.com');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(stubs.uiCalls.url.includes('https://picked.com'));
    stubs.browserMod.Browser.prototype.navigate = async () => { throw new Error('pick fail'); };
    const n0 = stubs.uiCalls.center.length;
    H.onLinkPick('https://fail.com');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(stubs.uiCalls.center.slice(n0).some((c) => String(c.t).includes('pick fail')));
  });
  it('history back/forward handlers move the cursor without pushing entries', async () => {
    const H = stubs.captured.handlers;
    stubs.browserMod.Browser.prototype.navigate = async () => ({ text: 'h', links: [] });
    idx.navigator.navigate('https://h1.com');
    idx.navigator.navigate('https://h2.com');
    idx.navigator.navigate('https://h3.com');
    const stack = idx.navigator.getHistory();
    H.onHistoryBack();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stubs.uiCalls.url.at(-1), 'https://h2.com');
    assert.deepEqual(idx.navigator.getHistory(), stack, 'back must not commit a new entry');
    assert.equal(idx.navigator.currentUrl(), 'https://h2.com');
    // A second back must walk further, not bounce between the last two.
    H.onHistoryBack();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stubs.uiCalls.url.at(-1), 'https://h1.com');
    assert.equal(idx.navigator.currentUrl(), 'https://h1.com');
    // Forward still has the whole tail.
    H.onHistoryForward();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stubs.uiCalls.url.at(-1), 'https://h2.com');
    H.onHistoryForward();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stubs.uiCalls.url.at(-1), 'https://h3.com');
    assert.deepEqual(idx.navigator.getHistory(), stack, 'history intact after back/forward round trip');
  });
  it('onEscape resets focus; the settings view is gone from the handler surface', () => {
    const H = stubs.captured.handlers;
    H.onEscape();
    assert.equal(stubs.uiCalls.esc, true);
    assert.equal(H.onSettingsChange, undefined);
    assert.equal(stubs.fakeUI.showSettings, undefined);
  });
});

describe('index: youtube fast routing', () => {
  const cp = require('node:child_process');
  const realExec = cp.execFile;
  const realSpawn = cp.spawn;
  let spawnedExec;
  let spawnedPlayer;
  const { beforeEach, afterEach } = require('node:test');
  beforeEach(() => {
    spawnedExec = [];
    spawnedPlayer = [];
    cp.execFile = (cmd, args, opts, cb) => {
      spawnedExec.push([cmd, args]);
      const cbFn = typeof opts === 'function' ? opts : cb;
      if (cmd === 'yt-dlp' && typeof cbFn === 'function') {
        cbFn(null, 'https://cdn.github.com/v.mp4\n', '');
      }
      return { unref: () => {} };
    };
    cp.spawn = (cmd, args) => {
      spawnedPlayer.push([cmd, args]);
      return { stderr: { on: () => {} }, on: () => {}, unref: () => {} };
    };
  });
  afterEach(() => {
    cp.execFile = realExec;
    cp.spawn = realSpawn;
  });
  it('typed watch URL plays in mpv without navigating', async () => {
    const before = idx.navigator.getHistory().length;
    await idx.routeInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ', null);
    await idx.getResolvePromise();
    assert.ok(spawnedPlayer.some(([c]) => c === 'mpv'), 'mpv spawned');
    assert.ok(spawnedExec.some(([c]) => c === 'yt-dlp'), 'resolved via yt-dlp');
    assert.equal(idx.navigator.getHistory().length, before, 'no history commit');
  });
  it('suggestion row with watch URL plays instead of navigating', async () => {
    const before = idx.navigator.getHistory().length;
    await idx.routeInput('whatever', { url: 'https://youtu.be/9bZkp7q19f0', title: 'row' });
    await idx.getResolvePromise();
    assert.ok(spawnedPlayer.some(([c]) => c === 'mpv'), 'mpv spawned');
    assert.equal(idx.navigator.getHistory().length, before, 'no history commit');
  });
  it('/results URL runs a /yt search into the picker', async () => {
    const ytPath = require.resolve('../src/yt');
    const realSearch = require.cache[ytPath].exports.searchYouTube;
    require.cache[ytPath].exports.searchYouTube = async () => ({
      rows: [{ title: 'vid', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', domain: 'youtube.com' }],
    });
    try {
      const n0 = stubs.uiCalls.ytPicker.length;
      await idx.routeInput('https://www.youtube.com/results?search_query=cats', null);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(stubs.uiCalls.ytPicker.length, n0 + 1, 'picker shown');
      assert.equal(stubs.uiCalls.ytPicker.at(-1).q, 'cats');
    } finally {
      require.cache[ytPath].exports.searchYouTube = realSearch;
    }
  });
  it('channel URLs still navigate (browseable, not playable)', async () => {
    stubs.browserMod.Browser.prototype.navigate = async () => ({ text: 'chan', links: [] });
    const before = idx.navigator.getHistory().length;
    await idx.routeInput('https://www.youtube.com/@SomeChannel', null);
    assert.equal(idx.navigator.getHistory().length, before + 1, 'history committed');
    assert.ok(!spawnedPlayer.some(([c]) => c === 'mpv'), 'no player spawned');
  });
  it('resolve shows a status spinner first', async () => {
    const n0 = stubs.uiCalls.status.length;
    await idx.routeInput('https://www.youtube.com/watch?v=kJQP7kiw5Fk', null);
    assert.ok(stubs.uiCalls.status.slice(n0).some((t) => /Preparing|Resolving/.test(t)), 'spinner shown');
  });
  it('music.youtube.com/search runs a /yt search into the picker', async () => {
    const ytPath = require.resolve('../src/yt');
    const realSearch = require.cache[ytPath].exports.searchYouTube;
    require.cache[ytPath].exports.searchYouTube = async () => ({
      rows: [{ title: 'song', url: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', domain: 'youtube.com' }],
    });
    try {
      const n0 = stubs.uiCalls.ytPicker.length;
      await idx.routeInput('https://music.youtube.com/search?q=never+gonna', null);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(stubs.uiCalls.ytPicker.length, n0 + 1, 'picker shown like /yt');
      assert.equal(stubs.uiCalls.ytPicker.at(-1).q, 'never gonna');
    } finally {
      require.cache[ytPath].exports.searchYouTube = realSearch;
    }
  });
  it('music.youtube.com/watch plays in mpv without navigating', async () => {
    const before = idx.navigator.getHistory().length;
    await idx.routeInput('https://music.youtube.com/watch?v=dQw4w9WgXcQ', null);
    await idx.getResolvePromise();
    assert.ok(spawnedPlayer.some(([c]) => c === 'mpv'), 'mpv spawned');
    assert.equal(idx.navigator.getHistory().length, before, 'no history commit');
  });
  it('music search without a query still navigates (fail-open)', async () => {
    stubs.browserMod.Browser.prototype.navigate = async () => ({ text: 'music home', links: [] });
    const before = idx.navigator.getHistory().length;
    await idx.routeInput('https://music.youtube.com/search', null);
    assert.equal(idx.navigator.getHistory().length, before + 1, 'history committed');
    assert.ok(!spawnedPlayer.some(([c]) => c === 'mpv'), 'no player spawned');
  });
});

describe('index: mpv vo chain + safe retry', () => {  const cp = require('node:child_process');
  const realExec = cp.execFile;
  const realSpawn = cp.spawn;
  let spawns;
  let handlers;
  const { beforeEach, afterEach } = require('node:test');
  beforeEach(() => {
    spawns = [];
    handlers = [];
    cp.execFile = (cmd, args, opts, cb) => {
      const cbFn = typeof opts === 'function' ? opts : cb;
      if (cmd === 'yt-dlp' && typeof cbFn === 'function') {
        cbFn(null, 'https://cdn.github.com/v.mp4\n', '');
      }
      return { unref: () => {} };
    };
    cp.spawn = (cmd, args) => {
      // mpv spawns only: the pre-warmed viz tap (python3) shares this
      // seam — handlers[0] must stay the player, not the tap.
      const h = {};
      if (cmd === 'mpv') { spawns.push(args); handlers.push(h); }
      return {
        stderr: { on: (ev, fn) => { h['err:' + ev] = fn; } },
        on: (ev, fn) => { h[ev] = fn; },
        unref: () => {},
      };
    };
  });
  afterEach(() => {
    cp.execFile = realExec;
    cp.spawn = realSpawn;
  });
  it('auto vo chains gpu with software fallbacks', async () => {
    idx.playVideo('https://a.com/vo-auto.mp4', {});
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(spawns.length >= 1, 'spawned');
    assert.ok(spawns[0].includes('--vo=gpu,xv,x11'), 'fallback chain present');
  });
  it('fast gpu-flavored death retries once with software output', async () => {
    idx.playVideo('https://a.com/vo-retry.mp4', {});
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(spawns.length, 1);
    handlers[0]['err:data'](Buffer.from('[vo/gpu] Vulkan device creation failed'));
    handlers[0].close(1, null);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(spawns.length, 2, 'retried once');
    assert.ok(spawns[1].includes('--vo=xv,x11'), 'software vo');
    assert.ok(spawns[1].includes('--hwdec=no'), 'software decode');
  });
  it('fast generic death does not retry (single attempt)', async () => {
    idx.playVideo('https://a.com/vo-clean.mp4', {});
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(spawns.length, 1);
    handlers[0].close(1, null);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(spawns.length, 1, 'no retry without gpu signature');
  });
});

describe('index: single player enqueue (play-next, no 2nd window)', () => {
  const cp = require('node:child_process');
  const net = require('node:net');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { beforeEach, afterEach } = require('node:test');
  const FAKE_PID = 987654321;
  let spawns;
  let realSpawn;
  let realKill;
  let server = null;
  let state;
  let commands;
  function sockPath() {
    const base = process.env.XDG_CONFIG_HOME;
    const dir = path.join(base, 'tui-browser');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'mpv.sock');
  }
  function startFakeServer() {
    state = { playlist: [], pos: -1, pid: FAKE_PID };
    commands = [];
    server = net.createServer((c) => {
      let buf = '';
      c.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg = null;
          try { msg = JSON.parse(line); } catch { continue; }
          const id = msg.request_id;
          const cmd = msg.command || [];
          if (id == null) continue;
          commands.push(cmd);
          const reply = (payload) => c.write(`${JSON.stringify({ ...payload, request_id: id })}\n`);
          if (cmd[0] === 'get_property') {
            const key = cmd[1];
            if (key === 'playlist-pos') reply({ data: state.pos, error: 'success' });
            else if (key === 'playlist-count') reply({ data: state.playlist.length, error: 'success' });
            else if (key === 'pid') reply({ data: state.pid, error: 'success' });
            else if (key === 'filename') {
              const cur = state.pos >= 0 ? state.playlist[state.pos] : undefined;
              if (cur === undefined) reply({ error: 'property unavailable' });
              else reply({ data: cur, error: 'success' });
            } else reply({ data: null, error: 'success' });
          } else if (cmd[0] === 'loadfile') {
            state.playlist.push(cmd[1]);
            if (cmd[2] === 'append-play' && state.pos === -1 && state.playlist.length === 1) state.pos = 0;
            reply({ data: { playlist_entry_id: state.playlist.length }, error: 'success' });
          } else if (cmd[0] === 'playlist-move') {
            const [from, to] = [Number(cmd[1]), Number(cmd[2])];
            if (Number.isInteger(from) && Number.isInteger(to) && state.playlist[from] !== undefined) {
              const [item] = state.playlist.splice(from, 1);
              state.playlist.splice(Math.max(0, Math.min(to, state.playlist.length)), 0, item);
            }
            reply({ data: null, error: 'success' });
          } else {
            reply({ data: null, error: 'success' });
          }
        }
      });
    });
    return new Promise((r) => server.listen(sockPath(), r));
  }
  function stopFakeServer() {
    return new Promise((r) => {
      if (!server) return r();
      server.close(() => r());
      server = null;
    });
  }
  beforeEach(() => {
    spawns = [];
    realSpawn = cp.spawn;
    realKill = process.kill;
    cp.spawn = (cmd, args) => {
      // mpv spawns only (see above: the parec viz tap shares this seam).
      if (cmd === 'mpv') spawns.push([cmd, args]);
      return { pid: FAKE_PID, stderr: { on: () => {} }, on: () => {}, unref: () => {} };
    };
    process.kill = (pid, sig) => {
      if (Number(pid) === FAKE_PID && sig === 0) return true;
      return realKill(pid, sig);
    };
  });
  afterEach(async () => {
    cp.spawn = realSpawn;
    process.kill = realKill;
    await stopFakeServer();
  });
  const A = 'https://www.youtube.com/watch?v=AAA111BBBB22';
  const B = 'https://www.youtube.com/watch?v=CCC333DDDD44';
  const C = 'https://www.youtube.com/watch?v=EEE555FFFF66';
  const D = 'https://www.youtube.com/watch?v=GGG777HHHH88';
  it('enter while playing enqueues ONLY the pick (no rest of the list), no new spawn', async () => {
    const r1 = idx.playVideo(A, { queue: [B] });
    assert.equal(r1.method, 'mpv-queue');
    assert.equal(spawns.length, 1, 'first play spawns once');
    assert.deepEqual(idx.getQueue().map((it) => it.url), [A, B]);
    await startFakeServer();
    state.playlist = [A, B];
    state.pos = 0;
    const r2 = idx.playVideo(C, { queue: [D] });
    assert.equal(r2.method, 'mpv-enqueue');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(spawns.length, 1, 'no second mpv window');
    assert.deepEqual(state.playlist, [A, C, B], 'ONLY the pick lands after the current entry');
    assert.deepEqual(idx.getQueue().map((it) => it.url), [A, C, B], 'display queue mirrors player order');
    assert.ok(commands.some((c) => c[0] === 'loadfile' && c[1] === C && c[2] === 'append-play'), 'first append-plays');
    assert.ok(commands.some((c) => c[0] === 'playlist-move'), 'entries moved into place');
  });
  it('dead player pid falls back to a fresh spawn', async () => {
    process.kill = (pid, sig) => {
      if (Number(pid) === FAKE_PID) {
        const e = new Error('no such process');
        e.code = 'ESRCH';
        throw e;
      }
      return realKill(pid, sig);
    };
    const E = 'https://www.youtube.com/watch?v=EEE555FFF56';
    const F = 'https://www.youtube.com/watch?v=GGG555HHH56';
    const G = 'https://www.youtube.com/watch?v=HHH555III56';
    const H = 'https://www.youtube.com/watch?v=III555JJJ56';
    idx.playVideo(E, { queue: [F] });
    assert.equal(spawns.length, 1);
    idx.playVideo(G, { queue: [H] });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(spawns.length, 2, 'dead player spawns fresh (no socket to feed)');
  });
  it('adopts a player that outlived the app (socket probe), then queues into it', async () => {
    // A fresh app process knows no pid; the fixed IPC socket is the only
    // truth. Present the pid as dead until the adoption probe runs.
    await startFakeServer();
    state.playlist = [A];
    state.pos = 0;
    const denyKill = (pid, sig) => {
      if (Number(pid) === FAKE_PID && sig === 0) {
        const e = new Error('no such process');
        e.code = 'ESRCH';
        throw e;
      }
      return realKill(pid, sig);
    };
    process.kill = denyKill;
    const adopted = await idx.adoptRunningPlayer();
    assert.equal(adopted, true, 'player adopted from the socket');
    process.kill = (pid, sig) => (Number(pid) === FAKE_PID && sig === 0 ? true : realKill(pid, sig));
    const r = idx.playVideo(C, { queue: [D] });
    assert.equal(r.method, 'mpv-enqueue', 'Enter queues into the adopted player');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(spawns.length, 0, 'no second mpv window');
    assert.deepEqual(state.playlist, [A, C], 'pick lands after the current entry');
  });
});

describe('index: quality walk — honest height + merge pair', () => {
  const cp = require('node:child_process');
  const { beforeEach, afterEach } = require('node:test');
  const realExec = cp.execFile;
  const realSpawn = cp.spawn;
  let mpvArgs;
  let walkCalls;
  function stubWalk(replies) {
    walkCalls = [];
    cp.execFile = (cmd, args, opts, cb) => {
      const cbFn = typeof opts === 'function' ? opts : cb;
      if (cmd === 'yt-dlp' && typeof cbFn === 'function') {
        walkCalls.push(args);
        const i = args.indexOf('--extractor-args');
        const client = i >= 0 ? String(args[i + 1]).replace('youtube:player_client=', '') : 'default';
        const reply = replies[client] || '';
        if (reply && typeof reply === 'object') cbFn(reply.err || null, reply.stdout || '', reply.stderr || '');
        else cbFn(null, reply, '');
      }
      return { unref: () => {} };
    };
  }
  const clientsSeen = () => walkCalls.map((args) => {
    const i = args.indexOf('--extractor-args');
    return i >= 0 ? String(args[i + 1]).replace('youtube:player_client=', '') : 'default';
  });
  beforeEach(() => {
    mpvArgs = [];
    cp.spawn = (cmd, args) => {
      if (cmd === 'mpv') mpvArgs.push(args);
      return { stderr: { on: () => {} }, on: () => {}, unref: () => {} };
    };
  });
  afterEach(() => { cp.execFile = realExec; cp.spawn = realSpawn; });
  it('takes the highest real height and plays video + --audio-file pair', async () => {
    stubWalk({
      default: '720\nhttps://cdn.example/v720.m3u8\nhttps://cdn.example/a1.m4a\n',
      android: '360\nhttps://cdn.example/v360.mp4\n',
    });
    stubs.uiCalls.status.length = 0;
    idx.playVideo('https://www.youtube.com/watch?v=QUAL1080AAAA', { quality: '1080' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(mpvArgs.length, 1, 'one mpv spawn');
    assert.ok(mpvArgs[0].includes('https://cdn.example/v720.m3u8'), 'video url played');
    assert.ok(mpvArgs[0].some((a) => a === '--audio-file=https://cdn.example/a1.m4a'), 'audio rides --audio-file');
    assert.ok(mpvArgs[0].includes('--geometry=1000x600'), 'Esc out of fullscreen restores a small window: ' + mpvArgs[0].join(' '));
    assert.ok(stubs.uiCalls.status.some((s) => s === 'Playing 720p (wanted 1080p)'), 'honest height: ' + JSON.stringify(stubs.uiCalls.status));
  });
  it('when only android answers, the status says 360p — never the requested lie', async () => {
    stubWalk({ android: '360\nhttps://cdn.example/v360.mp4\n' });
    stubs.uiCalls.status.length = 0;
    idx.playVideo('https://www.youtube.com/watch?v=QUAL360BBBB', { quality: '1080' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(mpvArgs.length, 1);
    assert.ok(mpvArgs[0].includes('https://cdn.example/v360.mp4'));
    assert.ok(stubs.uiCalls.status.some((s) => s === 'Playing 360p (wanted 1080p)'), JSON.stringify(stubs.uiCalls.status));
  });
  it('a data-saver request prefers the in-range candidate over an overshoot', async () => {
    stubWalk({
      default: '1080\nhttps://cdn.example/v1080.m3u8\nhttps://cdn.example/a2.m4a\n',
      android: '360\nhttps://cdn.example/v360.mp4\n',
    });
    stubs.uiCalls.status.length = 0;
    idx.playVideo('https://www.youtube.com/watch?v=QUAL480CCCC', { quality: '480' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(mpvArgs.length, 1);
    assert.ok(mpvArgs[0].includes('https://cdn.example/v360.mp4'), 'in-range 360 wins over 1080 overshoot');
    assert.ok(!mpvArgs[0].some((a) => String(a).includes('v1080')), 'the overshoot is not played');
    assert.ok(stubs.uiCalls.status.some((s) => s === 'Playing 360p (wanted 480p)'), JSON.stringify(stubs.uiCalls.status));
  });
  it('sequential ladder: exact cap hit stops after ONE yt-dlp call, with JS solver flags', async () => {
    stubWalk({ default: '1080\nhttps://cdn.example/v1080-dash.m3u8\nhttps://cdn.example/a3.m4a\n' });
    mpvArgs.length = 0;
    idx.playVideo('https://www.youtube.com/watch?v=SEQD111AAAA', { quality: 'best' });
    await idx.getResolvePromise();
    assert.equal(walkCalls.length, 1, 'one attempt, not a six-way fan-out');
    assert.deepEqual(clientsSeen(), ['default']);
    const args = walkCalls[0];
    assert.ok(args.includes('--js-runtimes') && args.includes('node'), 'node runtime flag: ' + args.join(' '));
    assert.ok(args.includes('--remote-components') && args.includes('ejs:github'), 'EJS solver flag');
    assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=SEQD111AAAA', 'target is last');
    assert.equal(mpvArgs.length, 1);
  });
  it('sequential ladder: default 429 -> tv 1080p, no android, no retry', async () => {
    stubWalk({
      default: { err: new Error('exit 1'), stdout: '', stderr: 'ERROR: HTTP Error 429: Too Many Requests' },
      tv: '1080\nhttps://cdn.example/v1080-tv.m3u8\nhttps://cdn.example/a4.m4a\n',
      android: '360\nhttps://cdn.example/v360.mp4\n',
    });
    mpvArgs.length = 0;
    idx.playVideo('https://www.youtube.com/watch?v=SEQD222BBBB', { quality: 'best' });
    await idx.getResolvePromise();
    assert.deepEqual(clientsSeen(), ['default', 'tv'], 'stops on the first rich success');
    assert.ok(mpvArgs[0].includes('https://cdn.example/v1080-tv.m3u8'));
  });
  it('sequential ladder: all 429 -> android 360, one default retry, throttled toast', async () => {
    const r429 = () => ({ err: new Error('exit 1'), stdout: '', stderr: 'ERROR: HTTP Error 429: Too Many Requests' });
    stubWalk({
      default: r429(), tv: r429(), web: r429(), ios: r429(), mweb: r429(),
      android: '360\nhttps://cdn.example/v360-last.mp4\n',
    });
    mpvArgs.length = 0;
    stubs.uiCalls.status.length = 0;
    idx.playVideo('https://www.youtube.com/watch?v=SEQD333CCCC', { quality: 'best' });
    await idx.getResolvePromise();
    const seen = clientsSeen();
    assert.equal(seen[0], 'tv', 'sticky winner (previous 1080p tv hit) goes first');
    assert.deepEqual(seen.slice(1), ['default', 'web', 'ios', 'mweb', 'android', 'default'], 'android last resort, then one rich retry');
    assert.ok(mpvArgs[0].includes('https://cdn.example/v360-last.mp4'));
    assert.ok(stubs.uiCalls.status.some((s) => /throttled high-res.*360p/.test(s)), 'honest throttled toast: ' + JSON.stringify(stubs.uiCalls.status));
  });
});

describe('index: mpvQuery live player truth', () => {
  const net = require('node:net');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  function tmpSock() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpv-q-'));
    return path.join(dir, 'mpv.sock');
  }
  it('parses split replies, ignores events without request_id', async () => {
    const sock = tmpSock();
    const server = net.createServer((c) => {
      let buf = '';
      c.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg = null;
          try { msg = JSON.parse(line); } catch { continue; }
          const id = msg.request_id;
          const key = msg.command && msg.command[1];
          const payload = JSON.stringify({
            data: key === 'filename' ? 'https://www.youtube.com/watch?v=abc123XYZ01' : key === 'pause' ? false : 't',
            request_id: id,
            error: 'success',
          });
          c.write(payload.slice(0, 10)); // split mid-payload on purpose
          c.write(payload.slice(10) + '\n');
          c.write(JSON.stringify({ event: 'playback-restart' }) + '\n');
        }
      });
    });
    await new Promise((r) => server.listen(sock, r));
    try {
      const out = await idx.mpvQuery(['filename', 'pause'], { sockPath: sock, timeoutMs: 2000 });
      assert.equal(out.filename, 'https://www.youtube.com/watch?v=abc123XYZ01');
      assert.equal(out.pause, false);
    } finally {
      server.close();
    }
  });
  it('null on dead socket and on silent timeout; never throws', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpv-q-'));
    assert.equal(await idx.mpvQuery(['filename'], { sockPath: path.join(dir, 'no.sock'), timeoutMs: 300 }), null);
    const sock = path.join(dir, 'mute.sock');
    const server = net.createServer(() => {});
    await new Promise((r) => server.listen(sock, r));
    try {
      assert.equal(await idx.mpvQuery(['filename'], { sockPath: sock, timeoutMs: 200 }), null);
    } finally {
      server.close();
    }
    assert.equal(await idx.mpvQuery([], { sockPath: sock }), null);
  });
});

describe('index: viz suspends while mpv is fullscreen, resumes windowed', () => {
  const cp = require('node:child_process');
  const net = require('node:net');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { beforeEach, afterEach } = require('node:test');
  const FAKE_PID_BASE = 987654322;
  let fakePid = FAKE_PID_BASE;
  let realSpawn;
  let realKill;
  let realExec;
  let server = null;
  let fsAnswer = { pause: false, fullscreen: true };
  // Tap lifecycle tracking: the spawn stub hands python3/parec viable fake
  // children (stdout.on present, one spectrum frame delivered) so the taps
  // under test are REAL tap objects — suspend must not kill them.
  let tapSpawns = [];
  let tapKills = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function sockPath() {
    const base = process.env.XDG_CONFIG_HOME;
    const dir = path.join(base, 'tui-browser');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'mpv.sock');
  }
  function startFakeServer() {
    return new Promise((resolve, reject) => {
      try { fs.unlinkSync(sockPath()); } catch { /* stale socket */ }
      server = net.createServer((c) => {
        let buf = '';
        c.on('data', (d) => {
          buf += d.toString();
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            let msg = null;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.request_id == null) continue;
            const key = msg.command && msg.command[1];
            const payload = Object.prototype.hasOwnProperty.call(fsAnswer, key)
              ? { data: fsAnswer[key], error: 'success' }
              : { error: 'property unavailable' };
            c.write(`${JSON.stringify({ ...payload, request_id: msg.request_id })}\n`);
          }
        });
      });
      server.on('error', reject);
      server.listen(sockPath(), resolve);
    });
  }
  function stopFakeServer() {
    return new Promise((r) => {
      if (!server) return r();
      server.close(() => r());
      server = null;
    });
  }
  beforeEach(async () => {
    stubs.uiCalls.viz.length = 0;
    stubs.uiCalls.vizOn = false;
    tapSpawns = [];
    tapKills = [];
    // Fresh pid per test: the module remembers the last spawn, and a stale
    // pid that still "answers" would route the next play into the enqueue
    // path (no spawn, no viz) instead of a fresh player.
    fakePid += 1;
    const myPid = fakePid;
    await stopFakeServer();
    await startFakeServer();
    realSpawn = cp.spawn;
    realKill = process.kill;
    realExec = cp.execFile;
    cp.execFile = (cmd, args, opts, cb) => {
      const cbFn = typeof opts === 'function' ? opts : cb;
      if (cmd === 'yt-dlp' && typeof cbFn === 'function') {
        cbFn(null, 'https://cdn.example.com/v.mp4\n', '');
      }
      return { unref: () => {} };
    };
    cp.spawn = (cmd, args) => {
      // mpv carries a pid (liveness); the viz taps get viable fake
      // children so startVizSpectrum/startVizMonitor return live tap
      // objects. python3 delivers one spectrum frame on next tick (the 4 s
      // watchdog sees life and never fires mid-test); kills are recorded
      // so suspend/resume can prove the taps survive.
      if (cmd === 'mpv') {
        return { pid: myPid, stderr: { on: () => {} }, on: () => {}, unref: () => {} };
      }
      if (cmd === 'python3' || cmd === 'parec') {
        tapSpawns.push(cmd);
        const handlers = {};
        const stdout = {
          on: (ev, fn) => { handlers[ev] = fn; return stdout; },
          destroy: () => {},
        };
        if (cmd === 'python3') {
          setTimeout(() => {
            try { handlers.data && handlers.data('500;500;500;500;500;500;500;500\n'); } catch {}
          }, 30);
        }
        return {
          stdout,
          stderr: { on: () => {} },
          on: () => {},
          unref: () => {},
          kill: () => { tapKills.push(cmd); },
        };
      }
      return { stderr: { on: () => {} }, on: () => {}, unref: () => {} };
    };
    process.kill = (pid, sig) => {
      if (Number(pid) === myPid && sig === 0) return true;
      return realKill(pid, sig);
    };
  });
  afterEach(async () => {
    cp.spawn = realSpawn;
    process.kill = realKill;
    cp.execFile = realExec;
    await stopFakeServer();
    // Let any live 1 s poll observe the dead player and tear down (hide)
    // BEFORE the next test clears the viz log — otherwise one test's
    // teardown hide lands in the next test's window.
    await sleep(1200);
  });
  it('fullscreen player parks the viz UI but keeps taps warm', async () => {
    fsAnswer = { pause: false, fullscreen: true };
    idx.playVideo('https://a.example.com/fs-park.mp4', {});
    await sleep(500); // spawn shows, leading tick suspends
    const viz = stubs.uiCalls.viz;
    assert.ok(viz.includes('show'), 'spawn shows the viz first');
    assert.ok(viz.includes('hide'), 'fullscreen suspends it');
    assert.equal(stubs.uiCalls.vizOn, false, 'viz off while fullscreen');
    assert.ok(tapSpawns.includes('python3'), 'spectrum tap started');
    assert.equal(tapKills.length, 0, 'suspend kills no taps (warm for resume)');
  });
  it('leaving fullscreen reuses the warm tap (no second spawn)', async () => {
    fsAnswer = { pause: false, fullscreen: true };
    idx.playVideo('https://a.example.com/fs-resume.mp4', {});
    await sleep(500);
    assert.equal(stubs.uiCalls.vizOn, false, 'parked while fullscreen');
    assert.equal(tapKills.length, 0, 'park killed nothing');
    stubs.uiCalls.viz.length = 0;
    const spawnsBefore = tapSpawns.length;
    tapKills.length = 0;
    fsAnswer = { pause: false, fullscreen: false };
    await sleep(1300); // next 1 s poll tick resumes
    assert.ok(stubs.uiCalls.viz.includes('show'), 'windowed resumes the viz');
    assert.equal(stubs.uiCalls.vizOn, true, 'viz alive again');
    assert.equal(tapSpawns.length, spawnsBefore, 'resume reuses the warm tap');
    assert.equal(tapKills.length, 0, 'the cycle killed nothing');
  });
  it('a missing fullscreen answer never parks (old mpv safe)', async () => {
    fsAnswer = { pause: false }; // no fullscreen key: fail-open
    idx.playVideo('https://a.example.com/fs-legacy.mp4', {});
    await sleep(1300); // spawn + a full poll interval
    assert.ok(stubs.uiCalls.viz.includes('show'), 'viz shown');
    assert.ok(!stubs.uiCalls.viz.includes('hide'), 'never parked without proof');
    assert.equal(stubs.uiCalls.vizOn, true, 'viz stays on');
    assert.equal(tapKills.length, 0, 'steady playback kills nothing');
  });
});

// ============================================================
// round 7: search-engine fallback chain (engines.js + handleNavigation)
// ============================================================
describe('index: search-engine fallback', () => {
  const engines = require('../src/engines');
  afterEach(() => engines.resetBlocked());

  it('a challenged DDG search falls back to Bing; one history entry, results painted', async () => {
    engines.resetBlocked();
    const calls = [];
    stubs.browserMod.Browser.prototype.navigate = async (u) => {
      calls.push(u);
      if (String(u).includes('duckduckgo')) {
        return { searchChallenge: { url: u, host: 'html.duckduckgo.com', text: 'Unfortunately, bots use DuckDuckGo too.' } };
      }
      return { results: [{ title: 'Godot', url: 'https://godotengine.org/', domain: 'godotengine.org' }], links: [] };
    };
    const before = idx.navigator.getHistory().length;
    await idx.handleNavigation('https://html.duckduckgo.com/html/?q=godot');
    assert.equal(calls.length, 2, `two attempts: ${calls.join(' | ')}`);
    assert.match(calls[1], /bing\.com\/search\?q=godot/);
    const h = idx.navigator.getHistory();
    assert.equal(h.length, before + 1, 'engine switch replaces the entry, never appends');
    assert.match(h[h.length - 1], /bing\.com/);
    assert.ok(stubs.uiCalls.picker.at(-1).some((r) => r.url === 'https://godotengine.org/'), 'Bing results painted');
    assert.equal(engines.isBlocked('duckduckgo'), true, 'refused engine remembered');
  });

  it('all engines challenged => one honest message, no challenge page dumped', async () => {
    engines.resetBlocked();
    const calls = [];
    stubs.browserMod.Browser.prototype.navigate = async (u) => {
      calls.push(u);
      return { searchChallenge: { url: u, host: 'whoever', text: 'verify you are a human' } };
    };
    const n = stubs.uiCalls.center.length;
    await idx.handleNavigation('https://html.duckduckgo.com/html/?q=zzz');
    assert.equal(calls.length, 3, 'DDG -> Bing -> Brave all tried');
    const painted = stubs.uiCalls.center.slice(n).map((c) => c.t).join('\n');
    assert.match(painted, /blocking automated searches/i);
    assert.equal(engines.isBlocked('bing') && engines.isBlocked('brave'), true, 'both remembered');
  });

  it('a blank 0-result search page falls back too', async () => {
    engines.resetBlocked();
    const calls = [];
    stubs.browserMod.Browser.prototype.navigate = async (u) => {
      calls.push(u);
      if (String(u).includes('duckduckgo')) return { results: [], links: [], text: '' };
      return { results: [{ title: 'X', url: 'https://x.example/', domain: 'x.example' }], links: [] };
    };
    await idx.handleNavigation('https://html.duckduckgo.com/html/?q=cats');
    assert.equal(calls.length, 2);
    assert.match(calls[1], /bing\.com/);
  });

  it('non-search URLs take exactly one attempt (unchanged behavior)', async () => {
    const calls = [];
    stubs.browserMod.Browser.prototype.navigate = async (u) => { calls.push(u); return { text: 'plain', links: [] }; };
    await idx.handleNavigation('https://example.com/page');
    assert.equal(calls.length, 1);
  });

  it('an engine refused earlier in the session is skipped next time', async () => {
    engines.resetBlocked();
    engines.markBlocked('bing');
    const calls = [];
    stubs.browserMod.Browser.prototype.navigate = async (u) => {
      calls.push(u);
      if (String(u).includes('duckduckgo')) return { searchChallenge: { url: u, host: 'x', text: 'challenge' } };
      return { results: [{ title: 'Y', url: 'https://y.example/', domain: 'y.example' }], links: [] };
    };
    await idx.handleNavigation('https://html.duckduckgo.com/html/?q=dogs');
    assert.equal(calls.length, 2);
    assert.match(calls[1], /search\.brave\.com/, 'Bing skipped, Brave used');
  });
});

describe('index: PDF auto-open (text + pages, engine never launches)', () => {
  const pdfMod = require('../src/pdf');

  it('a .pdf URL renders in-app: extracted text + page images, zero Chrome', async () => {
    const realOpen = pdfMod.openPdf;
    const realNav = stubs.browserMod.Browser.prototype.navigate;
    let engineNav = 0;
    stubs.browserMod.Browser.prototype.navigate = async () => { engineNav++; return { text: 'engine', links: [] }; };
    try {
      pdfMod.openPdf = async () => ({ ok: true, text: 'PDFTEXT-BODY one\ftwo', pages: ['/tmp/pg1.png', '/tmp/pg2.png'] });
      stubs.uiCalls.center.length = 0;
      stubs.uiCalls.pdfSplit.length = 0;
      await idx.handleNavigation('https://example.com/docs/manual.pdf');
      assert.equal(engineNav, 0, 'the browser engine never navigated');
      const last = stubs.uiCalls.center.at(-1);
      assert.ok(last && last.t.includes('PDFTEXT-BODY one'), 'extracted text painted: ' + JSON.stringify((last || {}).t || '').slice(0, 120));
      assert.ok(last.t.includes('page break'), 'form feeds became page breaks');
      assert.equal(stubs.uiCalls.pdfSplit.length, 1, 'the page images opened the 60/40 pane');
      assert.deepEqual(stubs.uiCalls.pdfSplit[0], ['/tmp/pg1.png', '/tmp/pg2.png']);
      assert.ok(stubs.uiCalls.url.includes('https://example.com/docs/manual.pdf'), 'URL bar shows the PDF');
    } finally {
      pdfMod.openPdf = realOpen;
      stubs.browserMod.Browser.prototype.navigate = realNav;
    }
  });

  it('a broken PDF paints an honest error, no engine fallback', async () => {
    const realOpen = pdfMod.openPdf;
    const realNav = stubs.browserMod.Browser.prototype.navigate;
    let engineNav = 0;
    stubs.browserMod.Browser.prototype.navigate = async () => { engineNav++; return { text: 'engine', links: [] }; };
    try {
      pdfMod.openPdf = async () => ({ ok: false, error: 'download failed (404)' });
      stubs.uiCalls.center.length = 0;
      await idx.handleNavigation('https://example.com/missing.pdf');
      assert.equal(engineNav, 0, 'still no Chrome');
      const last = stubs.uiCalls.center.at(-1);
      assert.ok(last && /Could not open PDF: download failed \(404\)/.test(last.t), JSON.stringify((last || {}).t || '').slice(0, 160));
    } finally {
      pdfMod.openPdf = realOpen;
      stubs.browserMod.Browser.prototype.navigate = realNav;
    }
  });

  it('non-PDF URLs take the normal engine path (guard does not overreach)', async () => {
    const realNav = stubs.browserMod.Browser.prototype.navigate;
    let engineNav = 0;
    stubs.browserMod.Browser.prototype.navigate = async () => { engineNav++; return { text: 'plain', links: [] }; };
    try {
      await idx.handleNavigation('https://example.com/notapdf.html');
      assert.equal(engineNav, 1, 'engine navigated once');
    } finally {
      stubs.browserMod.Browser.prototype.navigate = realNav;
    }
  });
});
