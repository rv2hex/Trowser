'use strict';
/* Phase-0 safety net: truth test + real key-path regressions + status hygiene.
 * ALL OFFLINE: no live sites, no searches, no downloads, no browsing.
 * Run: node --test tests/test-fixes.js  (with the offline fetch guard in
 * low-data environments).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tui-fix-'));
}

// ============================================================
// truth: HELP / SHORTCUTS / footer hints / palette all resolve
// ============================================================
describe('fix: command catalog is the single source of truth', () => {
  const { SPEC, allNames, findSpec } = require('../src/commandSpec');
  const { COMMANDS } = require('../src/suggest');
  const { HELP, SHORTCUTS } = require('../src/commands');

  it('palette lists the everyday catalog; settings-hub commands stay routable but unlisted', () => {
    const specNames = new Set(allNames());
    const palNames = new Set();
    const listed = new Set();
    for (const c of COMMANDS) {
      if (c.palette === 'hidden') continue;
      palNames.add(c.name);
      listed.add(c.name);
      for (const a of c.aliases || []) palNames.add(a);
    }
    // The palette is a subset of what routes...
    for (const n of palNames) assert.ok(specNames.has(n), `palette name "${n}" must route`);
    // ...and every non-hidden spec name (with aliases) is listed.
    const missing = [...specNames].filter((n) => {
      const s = findSpec(n);
      return s && s.palette !== 'hidden' && !palNames.has(n);
    });
    assert.deepEqual(missing, [], `routable but unlisted: ${missing.join(', ')}`);
    // Settings-hub commands: routable, never advertised in the palette.
    assert.ok(specNames.has('quality') && !listed.has('quality'), '/quality routes but /settings owns it');
    assert.ok(!listed.has('login') && !listed.has('register'), 'account rows live in /settings');
    assert.ok(specNames.has('youtube') && specNames.has('yts'), 'yt aliases routed');
    assert.ok(specNames.has('images'), '/images routed');
    assert.ok(specNames.has('dl') && specNames.has('downloads'), '/dl routed');
    assert.ok(specNames.has('bm'), '/bm routed');
    assert.ok(specNames.has('commands'), '/commands routed (footer alias)');
  });

  it('every /token advertised in HELP, SHORTCUTS and footer hints resolves', () => {
    const tokens = new Set();
    // Only real command positions: `/` at a word start (not mid-word like
    // `up/down` or `auto/gpu`).
    const tokRe = /(?:^|[\s(])\/([a-z][a-z0-9-]*)/g;
    for (const src of [HELP, SHORTCUTS]) {
      for (const m of String(src).matchAll(tokRe)) tokens.add(m[1]);
    }
    // Footer hints: slice updateHint out of the source (comments elsewhere
    // may mention non-command /words, so scope the scan to the hint owner).
    const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.js'), 'utf8');
    const start = uiSrc.indexOf('function updateHint()');
    const end = uiSrc.indexOf('\n  }\n', start);
    const hintSrc = uiSrc.slice(start, end);
    for (const m of hintSrc.matchAll(tokRe)) tokens.add(m[1]);
    const missing = [...tokens].filter((t) => !findSpec(t));
    assert.deepEqual(missing, [], `unresolvable advertised commands: ${missing.join(', ')}`);
    assert.ok(tokens.has('help') && tokens.has('yt') && tokens.has('settings'), 'core hints covered');
    // Retired commands must not be advertised anywhere. (/themes is BACK -
    // it is the live picker, not the old settings view.)
    for (const gone of ['theme', 'read', 'gemini', 'gemini-key', 'gpt']) {
      assert.equal(findSpec(gone), null, `/${gone} must not resolve`);
    }
    void SPEC;
  });

  it('no duplicate advertised rows; /play once; merged aliases resolve', () => {
    // The real bug this pins: /play had a second 'advanced' row, so /help
    // and the palette printed it twice. Names + aliases must be unique.
    const counts = new Map();
    for (const c of SPEC) {
      for (const n of [c.name, ...(c.aliases || [])]) counts.set(n, (counts.get(n) || 0) + 1);
    }
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([n]) => n);
    assert.deepEqual(dupes, [], `duplicate advertised names: ${dupes.join(', ')}`);
    const helpPlays = String(HELP).match(/(?:^|[\s(])\/play\b/g) || [];
    assert.equal(helpPlays.length, 1, '/play advertised exactly once in HELP');
    assert.equal(findSpec('bookmark').name, 'bookmarks', '/bookmark is the bookmarks alias');
    assert.equal(findSpec('bm').name, 'bookmarks');
    assert.equal(findSpec('video').name, 'videos', '/video is the videos alias');
    // Every advertised name (except the 'shotcuts' typo normalized in the
    // router) must have a real case label — an alias without one dies in
    // the unknown-command branch (how /bookmark was silently broken).
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands.js'), 'utf8');
    const labels = new Set([...src.matchAll(/case '([a-z0-9-]+)':/g)].map((m) => m[1]));
    const unrouted = allNames().filter((n) => n !== 'shotcuts' && !labels.has(n));
    assert.deepEqual(unrouted, [], `advertised but unrouted: ${unrouted.join(', ')}`);
  });

  it('bare /<name> for every name+alias routes without throwing (offline)', () => {
    const { routeCommand } = require('../src/commands');
    process.env.XDG_CONFIG_HOME = tmpDir();
    const prof = path.join(process.env.XDG_CONFIG_HOME, 'prof');
    fs.mkdirSync(prof, { recursive: true });
    const names = allNames();
    const failures = [];
    for (const name of names) {
      const seen = { n: 0 };
      const ui = {
        showInfo: () => seen.n++, toast: () => seen.n++,
        flashStatus: () => seen.n++, setCenterContent: () => seen.n++,
        showSettings: () => seen.n++, applyTheme: () => seen.n++,
        setPageSize: () => seen.n++,
        showLoginForm: () => seen.n++, setIdentity: () => {},
        playHighlightedVideo: () => false, showVideos: () => false,
        showGallery: () => false, playVideoAt: () => null,
        showImageAt: () => 'no-media', linkAt: () => null,
        galleryRows: () => [], videoRows: () => [],
        downloadTargetAt: () => null, findInPage: () => 0,
        showAiSummary: () => 'empty', getPageText: () => '',
        showGeminiView: () => seen.n++,
        setStatus: () => {}, clearStatus: () => {}, resetFocus: () => {},
      };
      const deps = {
        ui,
        browser: { profileDir: prof, profileReady: () => false, close: async () => {} },
        navigator: { getHistory: () => [] },
        config: { theme: 'white', pageSize: 50, quality: '480', vo: 'auto' },
        saveConfig: () => {}, shutdown: () => seen.n++,
        navigate: () => seen.n++,
        goBack: () => false, goForward: () => false, reload: () => false,
        currentUrl: () => '', openExternal: () => false,
        playUrl: () => seen.n++, getQueue: () => [],
        getNowPlaying: () => null, mpvNowPlaying: async () => null,
        mpvNext: async () => false, mpvStop: async () => false,
      };
      try {
        routeCommand(`/${name}`, deps);
      } catch (e) {
        failures.push(`${name}: threw ${e && e.message}`);
      }
    }
    // yt bare shells yt-dlp --version locally (no network); give it a tick.
    assert.deepEqual(failures, [], failures.join('; '));
    delete process.env.XDG_CONFIG_HOME;
  });
});

// ============================================================
// key paths on the real blessed UI (offline, no navigation)
// ============================================================
describe('fix: real key delivery (CR twin, LF, Esc, q)', () => {
  const blessed = require('blessed');
  const { createUI } = require('../src/ui');
  const { routeCommand } = require('../src/commands');
  const { Navigator } = require('../src/navigation');
  let screens = [];
  function makeWiredUI() {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 'test' });
    screens.push(screen);
    const calls = { submits: [], picks: [], quit: false, suggests: [] };
    const navigator = new Navigator({ file: null });
    let ui = null;
    const deps = () => ({
      ui,
      browser: { profileDir: '/tmp/prof', profileReady: () => false, close: async () => {} },
      navigator,
      config: { theme: 'white', pageSize: 50, quality: '480', vo: 'auto' },
      saveConfig: () => {}, shutdown: () => {},
      navigate: () => {}, playUrl: () => {}, getQueue: () => [],
      mpvNext: async () => false, mpvStop: async () => false,
    });
    ui = createUI(screen, {
      onOmniSubmit: (value) => {
        calls.submits.push(value);
        if (String(value || '').trim().startsWith('/')) routeCommand(value, deps());
      },
      onSuggest: (t) => { calls.suggests.push(t); },
      onLinkPick: (u) => { calls.picks.push(u); },
      onPlayVideo: () => {}, onHistoryBack: () => {}, onHistoryForward: () => {},
      onEscape: () => {}, onQuit: () => { calls.quit = true; },
      onSettingsChange: () => {},
    }, { theme: 'white', pageSize: 50 });
    return { screen, ui, calls };
  }
  function bodyText(screen) {
    const texts = [];
    (function walk(el) {
      try { if (typeof el.getContent === 'function') texts.push(String(el.getContent())); } catch {}
      (el.children || []).forEach(walk);
    })(screen);
    return texts.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  }
  const ARTICLE = [
    'Python is a high-level general-purpose programming language used widely here.',
    'It was created by Guido van Rossum and first released in the year 1991.',
    'Python emphasizes code readability with its notable use of indentation.',
    'Its constructs and object-oriented approach help programmers write clear code.',
  ].join(' ');
  const LINKS = [
    { title: 'alpha result about testing widgets thoroughly today', url: 'https://a.example.com/1', domain: 'a.example.com' },
    { title: 'beta result about testing widgets thoroughly today', url: 'https://b.example.com/2', domain: 'b.example.com' },
  ];
  const afterEach = require('node:test').afterEach;
  afterEach(() => {
    for (const s of screens) { try { s.destroy(); } catch {} }
    screens = [];
  });

  it('one CR on an article opens the picker exactly once (no auto-open of row 0)', () => {
    const { screen, ui, calls } = makeWiredUI();
    ui.setCenterContent(ARTICLE, LINKS.map((l) => ({ ...l })));
    // Real CR delivery: blessed emits enter THEN return for one press.
    screen.emit('keypress', '\r', { name: 'enter', full: 'enter' });
    screen.emit('keypress', '\r', { name: 'return', full: 'return' });
    assert.equal(ui.isPickerOpen(), true);
    assert.deepEqual(calls.picks, [], 'second half of CR must not confirm row 0');
  });

  it('a late CR twin (return half trailing ~300ms) still acts as ONE press', async () => {
    const { screen, calls } = makeWiredUI();
    for (const ch of 'dogs') screen.emit('keypress', ch, { name: ch, full: ch });
    await new Promise((r) => setTimeout(r, 250)); // let suggestions settle
    const n0 = calls.submits.length;
    screen.emit('keypress', '\r', { name: 'enter', full: 'enter' });
    await new Promise((r) => setTimeout(r, 320)); // measured trailing gap
    screen.emit('keypress', '\r', { name: 'return', full: 'return' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls.submits.length - n0, 1, `submits: ${JSON.stringify(calls.submits.slice(n0))}`);
    assert.equal(calls.submits.at(-1), 'dogs');
  });

  it('LF (\\n) submits from the bar', async () => {
    const { screen, calls } = makeWiredUI();
    for (const ch of 'cats') screen.emit('keypress', ch, { name: ch, full: ch });
    screen.emit('keypress', '\n', { name: 'linefeed', full: 'linefeed' });
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(calls.submits.length >= 1, 'linefeed submitted');
    assert.equal(calls.submits.at(-1), 'cats');
  });

  it('Esc over the palette restores the exact list; a second Esc is a no-op', () => {
    const { screen, ui } = makeWiredUI();
    ui.showLinkPicker(LINKS);
    screen.emit('keypress', '/', { name: 'slash', full: '/' });
    assert.equal(ui.isCommandPaletteVisible(), true);
    screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    assert.equal(ui.isCommandPaletteVisible(), false);
    assert.equal(ui.isPickerOpen(), true);
    // Headless screens truncate rows to ~10 cols, so assert on markers
    // that survive truncation, not full titles.
    assert.ok(bodyText(screen).includes('Links (2)'), 'list restored');
    assert.ok(bodyText(screen).includes('alpha res'), 'highlighted row restored');
    screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    assert.equal(ui.isPickerOpen(), true, 'double-Esc must not clobber the restore');
  });

  it('q typed over a list types (never quits)', async () => {
    const { screen, ui, calls } = makeWiredUI();
    ui.showLinkPicker(LINKS);
    screen.emit('keypress', 'q', { name: 'q', full: 'q' });
    assert.equal(calls.quit, false);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(calls.suggests.some((t) => String(t).includes('q')), 'q entered the bar as text');
  });
});

// ============================================================
// status hygiene (offline)
// ============================================================
describe('fix: footer status always clears', () => {
  const blessed = require('blessed');
  const { createUI } = require('../src/ui');
  let screens = [];
  function makeUI() {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 'test' });
    screens.push(screen);
    const ui = createUI(screen, {
      onOmniSubmit: () => {}, onSuggest: () => {}, onLinkPick: () => {},
      onPlayVideo: () => {}, onHistoryBack: () => {}, onHistoryForward: () => {},
      onEscape: () => {}, onQuit: () => {}, onSettingsChange: () => {},
    }, { theme: 'white', pageSize: 50 });
    return { screen, ui };
  }
  function allText(screen) {
    const texts = [];
    (function walk(el) {
      try { if (typeof el.getContent === 'function') texts.push(String(el.getContent())); } catch {}
      (el.children || []).forEach(walk);
    })(screen);
    return texts.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  }
  const afterEach = require('node:test').afterEach;
  afterEach(() => {
    for (const s of screens) { try { s.destroy(); } catch {} }
    screens = [];
  });

  it('setStatus/clearStatus round-trips back to the hint', () => {
    const { screen, ui } = makeUI();
    ui.setStatus('Loading test…');
    assert.ok(allText(screen).includes('Loading'), 'spinner text painted');
    ui.clearStatus();
    assert.ok(allText(screen).includes('/help'), 'hint restored after clear');
  });

  it('gallery spinner clears once the image settles (offline: immediate fail path)', async () => {
    const { screen, ui } = makeUI();
    ui.setCenterContent('article with pics', [], [],
      { images: [{ src: 'https://x.invalid/a.png', alt: 'pic' }], videos: [] });
    // Tab opens the 60/40 split; the fetch fails offline and must still
    // release the footer (finishOk/unsupported paths all clearStatus).
    screen.emit('keypress', null, { name: 'tab', full: 'tab' });
    assert.equal(ui.isGalleryOpen(), true);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (allText(screen).includes('Tab next') || allText(screen).includes('could not load')) break;
    }
    await new Promise((r) => setTimeout(r, 300));
    const t = allText(screen);
    assert.ok(!t.includes('Loading image'), 'spinner released, got: ' + JSON.stringify(t.slice(0, 160)));
  });
});
