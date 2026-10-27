'use strict';
/* Round-2 spec tests: 20-cell wave (frames-not-algo), ONE loading
 * animation, /yt loader, dirty-bar fix (the real /ai-key + /queue
 * bug), music visualizer.
 * Framework: node:test + assert/strict, blessed UI harness (no browser,
 * no network, no real key — the AI-key test uses sk-or-fake-test-key-000).
 * Run: node --test --test-force-exit tests/test-round3.js
 * Full: timeout 400 npm test
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CYCLE = '▁▂▃▄▅▆▇███▇▆▅▄▃▂▂▁▁▁';
const BRAILLE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const stripTags = (s) => String(s).replace(/\{[^}]*\}/g, '').replace(/\x1b\[[0-9;]*m/g, '');

describe('T1: wave art is the exact 20-cell cycle', () => {
  const ui = require('../src/ui');
  it('exports the 20-frame cycle verbatim', () => {
    assert.equal(ui.WAVE_CYCLE, CYCLE);
    assert.equal([...ui.WAVE_CYCLE].length, 20);
    assert.equal(ui.WAVE_FRAMES, 20);
    assert.equal(ui.WAVE_MOTIF.length, 20);
  });
  it('frames 0/1/2 are left-rotations, loop closes at 20', () => {
    assert.equal(ui.waveFrame(0), CYCLE);
    assert.equal(ui.waveFrame(1), [...CYCLE].slice(1).concat([...CYCLE].slice(0, 1)).join(''));
    assert.equal(ui.waveFrame(2), [...CYCLE].slice(2).concat([...CYCLE].slice(0, 2)).join(''));
    assert.equal(ui.waveFrame(20), ui.waveFrame(0));
    assert.equal(ui.waveFrame(41), ui.waveFrame(1));
    assert.equal(ui.waveFrame(-1), ui.waveFrame(19));
  });
  it('tiles exactly width cells, no spaces, ramp glyphs only', () => {
    for (const w of [5, 20, 40, 77, 80, 200]) {
      for (let i = 0; i < 20; i++) {
        const f = ui.waveFrame(i, w);
        assert.equal([...f].length, w, `frame ${i} @${w}`);
        assert.ok(!f.includes(' '), `no gaps @${w}`);
        for (const ch of f) assert.ok('▁▂▃▄▅▆▇█'.includes(ch), `glyph ${ch} @${w}`);
      }
    }
    assert.equal(ui.waveFrame(0, 0).length, 20, 'no width = the 20-cell cycle');
  });
  it('frames-not-algo: the tick path only indexes tables (no rotation/tiling)', () => {
    const src = fs.readFileSync(require.resolve('../src/ui'), 'utf8');
    const wf = src.slice(src.indexOf('function waveFrame'), src.indexOf('function tileMotifFrame'));
    assert.ok(!wf.includes('rotateCycle'), 'waveFrame must not recompute rotations');
    assert.ok(!wf.includes('while ('), 'waveFrame must not re-tile per call');
    // the 60 ms tick: advance the index, repaint — nothing else.
    const tick = src.slice(src.indexOf('loader.timer = setInterval'), src.indexOf('WAVE_TICK_MS);'));
    assert.ok(tick.includes('loader.frame'), 'the tick advances the frame index');
    assert.ok(!tick.includes('rotateCycle'), 'the tick recomputes nothing');
    assert.equal(ui.waveFrame(7, 63), ui.waveFrame(7, 63), 'table-stable');
  });
});

describe('T2: exactly one loading animation (the wave)', () => {
  const blessed = require('blessed');
  const { createUI } = require('../src/ui');
  let screens = [];
  const make = (handlers = {}) => {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 't' });
    screens.push(screen);
    const calls = {};
    const u = createUI(screen, {
      onOmniSubmit: (...a) => { calls.submit = a; },
      onSuggest: (...a) => { calls.suggest = a; },
      onLinkPick: () => {}, onPlayVideo: () => {}, onHistoryBack: () => {},
      onHistoryForward: () => {}, onEscape: () => {}, onQuit: () => {},
      onSettingsChange: () => {}, ...handlers,
    }, { theme: 'white', pageSize: 50 });
    return { screen, ui: u, calls };
  };
  afterEach(() => { for (const s of screens) { try { s.destroy(); } catch {} } screens = []; });
  const screenText = (screen) => {
    let out = '';
    (function walk(el) {
      if (!el) return;
      try { if (typeof el.getContent === 'function') out += `${el.getContent()}\n`; } catch {}
      for (const c of el.children || []) walk(c);
    })(screen);
    return stripTags(out);
  };
  it('no braille spinner while the loader is up', () => {
    const { screen, ui: u } = make();
    u.showLoading('Loading page', 'example.com', 'hint');
    u.setStatus('also loading'); // must NOT start the footer spinner
    assert.ok(!BRAILLE.test(screenText(screen)), 'wave only: no braille spinner on screen');
    u.hideLoading();
  });
  it('the loader status line has no spinner, only title · stage', () => {
    const art = require('../src/ui').loaderFrame(2, 'Loading video', 'resolving', 40);
    assert.ok(!BRAILLE.test(art), 'spinner removed from loader line');
    assert.equal(art.split('\n').length, 2);
    assert.ok(art.split('\n')[0].includes('resolving'));
  });
  it('footer spinner still works when no loader is showing', () => {
    const { screen, ui: u } = make();
    u.setStatus('Resolving stream');
    assert.ok(BRAILLE.test(screenText(screen)), 'spinner allowed without loader');
    u.clearStatus();
  });
});

describe('T3: /yt shows the wave loader', () => {
  const { routeCommand } = require('../src/commands');
  const ytPath = require.resolve('../src/yt');
  require(ytPath); // ensure require.cache entry exists before stubbing
  let saved;
  afterEach(() => { if (saved !== undefined) { require.cache[ytPath].exports.searchYouTube = saved; saved = undefined; } });
  const uiStub = () => {
    const c = { show: [], hide: 0, picker: false, content: [], navigated: false };
    return {
      c,
      ui: {
        showLoading: (...a) => { c.show.push(a); },
        hideLoading: () => { c.hide += 1; },
        setLoadingStage: () => {},
        setStatus: () => {},
        clearStatus: () => {},
        toast: (t) => { c.content.push(String(t)); },
        info: (t) => { c.content.push(String(t)); },
        setCenterContent: (t) => { c.content.push(String(t)); },
        showYouTubePicker: () => { c.picker = true; },
      },
    };
  };
  it('search runs under showLoading and always releases it', async () => {
    saved = require.cache[ytPath].exports.searchYouTube;
    require.cache[ytPath].exports.searchYouTube = async () => ({
      rows: [{ title: 'a', url: 'https://www.youtube.com/watch?v=AAA111BBBB22' }], source: 'yt-dlp',
    });
    const { ui, c } = uiStub();
    routeCommand('/yt gotham chess', { ui });
    assert.equal(c.show.length, 1, 'showLoading fired');
    assert.match(c.show[0][0], /Searching YouTube/);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(c.hide >= 1, 'hideLoading fired on resolve');
    assert.ok(c.picker, 'picker shown');
  });
  it('releases the loader even when search rejects', async () => {
    saved = require.cache[ytPath].exports.searchYouTube;
    require.cache[ytPath].exports.searchYouTube = async () => { throw new Error('sabr'); };
    const { ui, c } = uiStub();
    routeCommand('/yt broken query', { ui, navigate: () => { c.navigated = true; } });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(c.hide >= 1, 'hideLoading fired on reject');
    assert.ok(c.navigated, 'fallback navigate still runs');
  });
});

describe('T5: slash command submit clears the bar (the /gemini-key bug)', () => {
  const blessed = require('blessed');
  const { createUI } = require('../src/ui');
  let screens = [];
  const make = () => {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 't' });
    screens.push(screen);
    const submitted = [];
    const u = createUI(screen, {
      onOmniSubmit: (v) => { submitted.push(v); },
      onSuggest: () => {}, onLinkPick: () => {}, onPlayVideo: () => {},
      onHistoryBack: () => {}, onHistoryForward: () => {}, onEscape: () => {},
      onQuit: () => {}, onSettingsChange: () => {},
    }, { theme: 'white', pageSize: 50 });
    return { screen, ui: u, submitted };
  };
  afterEach(() => { for (const s of screens) { try { s.destroy(); } catch {} } screens = []; });
  const type = (screen, s) => { for (const ch of s) screen.emit('keypress', ch, { name: undefined, full: ch, ch }); };
  const enter = (screen) => screen.emit('keypress', '\r', { name: 'enter', full: 'enter' });

  it('two slash commands in a row route independently', () => {
    const { screen, submitted } = make();
    type(screen, '/help'); enter(screen);
    type(screen, '/links'); enter(screen);
    assert.equal(submitted[0], '/help');
    assert.equal(submitted[1], '/links', 'bar cleared after /help (was: /help/themes)');
  });
  it('/ai-key then /ai — the exact reported repro (was /gemini-key)', () => {
    const { screen, submitted } = make();
    type(screen, '/ai-key sk-or-fake-test-key-000'); enter(screen);
    type(screen, '/ai say hi'); enter(screen);
    assert.ok(submitted[0].startsWith('/ai-key '), 'first submit unchanged');
    assert.equal(submitted[1], '/ai say hi',
      'second command intact (was: "/ai-key sk…/ai say hi" → re-ran ai-key)');
  });
  it('/queue after another command routes clean (T6)', () => {
    const { screen, submitted } = make();
    type(screen, '/help'); enter(screen);
    type(screen, '/queue'); enter(screen);
    assert.equal(submitted[1], '/queue');
  });
  it('raw search text still lives in the bar (not cleared)', () => {
    const { screen, submitted } = make();
    type(screen, 'cats'); enter(screen);
    assert.equal(submitted[0], 'cats', 'search submitted as-is');
  });
});

describe('T5: ai-key save path (fake key only)', () => {
  it('saves, masks and reads back without echoing the key', () => {
    process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-'));
    try {
      const { routeCommand } = require('../src/commands');
      const { loadKey, maskKey } = require('../src/openrouter');
      const toasts = [];
      routeCommand('/ai-key sk-or-fake-test-key-000',
        {
          ui: { toast: (t) => toasts.push(t), info: (t) => toasts.push(t) },
          config: {}, saveConfig() {}, navigator: { getHistory: () => [] }, shutdown() {},
        });
      assert.match(toasts.join('\n'), /OpenRouter key saved/);
      assert.ok(!toasts.join('\n').includes('sk-or-fake-test-key-000'), 'key never echoed');
      assert.equal(maskKey(loadKey()), '…-000 (set)');
      const kf = path.join(process.env.XDG_CONFIG_HOME, 'tui-browser', 'openrouter-key');
      assert.equal(fs.statSync(kf).mode & 0o777, 0o600, '0600 file mode');
    } finally {
      delete process.env.XDG_CONFIG_HOME;
    }
  });
});

describe('T4: visualizer — precomputed bars, not a wave', () => {
  const ui = require('../src/ui');
  it('exports the visualizer frame table; instance exposes the controls', () => {
    // vizLineTagged is the pure precomputed table (module level); the
    // show/hide controls live on the UI instance (they own timers + box).
    assert.equal(typeof ui.vizLineTagged, 'function', 'vizLineTagged exported');
    assert.equal(ui.VIZ_FRAMES, 24);
    assert.ok(ui.VIZ_MS >= 60 && ui.VIZ_MS <= 150, `${ui.VIZ_MS}ms per frame`);
    const blessed = require('blessed');
    const { createUI } = require('../src/ui');
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 't' });
    try {
      const u = createUI(screen, {
        onOmniSubmit: () => {}, onSuggest: () => {}, onLinkPick: () => {},
        onPlayVideo: () => {}, onHistoryBack: () => {}, onHistoryForward: () => {},
        onEscape: () => {}, onQuit: () => {}, onSettingsChange: () => {},
      }, { theme: 'white', pageSize: 50 });
      for (const fn of ['showVisualizer', 'hideVisualizer', 'isVisualizerOn']) {
        assert.equal(typeof u[fn], 'function', `ui.${fn} present`);
      }
    } finally {
      try { screen.destroy(); } catch {}
    }
  });
  it('bars are deterministic, exact-width, and not the wave', () => {
    const a = stripTags(ui.vizLineTagged(0, 40, 'white', 'white'));
    assert.equal(ui.vizLineTagged(0, 40, 'white', 'white') && stripTags(ui.vizLineTagged(0, 40, 'white', 'white')), a, 'stable');
    assert.equal([...a].length, 40, 'exactly width cells');
    for (const ch of a) assert.ok('▁▂▃▄▅▆▇█'.includes(ch), `glyph ${ch}`);
    assert.notEqual(a, ui.waveFrame(0, 40), 'bars ≠ wave frame 0');
    assert.notEqual(
      stripTags(ui.vizLineTagged(1, 40, 'white', 'white')), a, 'frames advance');
    assert.equal(stripTags(ui.vizLineTagged(24, 40, 'white', 'white')), a, 'loop closes at 24');
  });
  it('show/hide paints and releases the bottom slot, loader wins', () => {
    const blessed = require('blessed');
    const { createUI } = require('../src/ui');
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 't' });
    try {
      const u = createUI(screen, {
        onOmniSubmit: () => {}, onSuggest: () => {}, onLinkPick: () => {},
        onPlayVideo: () => {}, onHistoryBack: () => {}, onHistoryForward: () => {},
        onEscape: () => {}, onQuit: () => {}, onSettingsChange: () => {},
      }, { theme: 'white', pageSize: 50 });
      const text = () => {
        let out = '';
        (function walk(el) {
          if (!el) return;
          try { if (typeof el.getContent === 'function') out += `${el.getContent()}\n`; } catch {}
          for (const c of el.children || []) walk(c);
        })(screen);
        return stripTags(out);
      };
      assert.equal(u.isVisualizerOn(), false);
      u.showVisualizer();
      assert.equal(u.isVisualizerOn(), true);
      // Footer slot, bars only: no title row by design (hints return idle).
      const bars = () => {
        const t = text();
        const m = t.match(/[▁▂▃▄▅▆▇█]{10,}/);
        return m ? m[0] : null;
      };
      assert.ok(bars(), 'viz bars painted');
      assert.ok(!text().includes('playing in mpv'), 'no title row in the footer slot');
      u.showLoading('Loading page', 'example.com', '');
      assert.ok(text().includes('Loading page'), 'loader takes the slot');
      u.hideLoading();
      assert.ok(bars(), 'viz resumes after loader');
      u.hideVisualizer();
      assert.equal(u.isVisualizerOn(), false);
      assert.ok(!bars(), 'viz released');
      assert.ok(!BRAILLE.test(text()), 'no spinner left behind');
    } finally {
      try { screen.destroy(); } catch {}
    }
  });
});

describe('T6: background fill never clobbers the AI fullscreen (ALT+UP bug)', () => {
  const blessed = require('blessed');
  const { createUI } = require('../src/ui');
  let screens = [];
  const make = () => {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 't' });
    screens.push(screen);
    const submitted = [];
    const u = createUI(screen, {
      onOmniSubmit: (v) => { submitted.push(v); },
      onSuggest: () => {}, onLinkPick: () => {}, onPlayVideo: () => {},
      onHistoryBack: () => {}, onHistoryForward: () => {}, onEscape: () => {},
      onQuit: () => {}, onSettingsChange: () => {},
    }, { theme: 'white', pageSize: 50 });
    return { screen, ui: u, submitted };
  };
  afterEach(() => { for (const s of screens) { try { s.destroy(); } catch {} } screens = []; });
  const text = (screen) => {
    let out = '';
    (function walk(el) {
      if (!el) return;
      try { if (typeof el.getContent === 'function') out += `${el.getContent()}\n`; } catch {}
      for (const c of el.children || []) walk(c);
    })(screen);
    return stripTags(out);
  };
  const rows = (n, tag) => Array.from({ length: n }, (_, i) => ({
    title: `${tag} result ${i + 1}`,
    url: `https://example.com/${tag}/${i + 1}`,
    domain: 'example.com',
  }));
  const altUp = (screen) => screen.emit('keypress', null,
    { name: 'up', full: 'M-up', meta: true, sequence: '\x1b[1;3A' });
  const esc = (screen) => screen.emit('keypress', null, { name: 'escape', full: 'escape' });

  it('ALT+UP opens the full answer; a background arrival merges silently', () => {
    const { screen, ui: u } = make();
    assert.equal(u.showLinkPicker(rows(10, 'cats'), null, 'Digest words about cats.'), true);
    assert.equal(u.visibleRows().length, 10);
    u.setAiAnswer('A rich real answer about cats.');
    altUp(screen);
    assert.ok(text(screen).includes('AI answer'), 'full answer opened');
    const added = u.appendLinks(rows(5, 'more'), false);
    assert.equal(added, 5, 'rows merged');
    assert.equal(u.visibleRows().length, 15, 'list grew underneath');
    assert.ok(text(screen).includes('AI answer'), 'full answer still on screen (not wiped)');
    assert.ok(!text(screen).includes('more result 1'), 'new rows not painted over the answer');
    esc(screen);
    assert.ok(text(screen).includes('Links (15)'), 'collapsed list shows all rows');
    // Headless test screen is narrow so painted rows truncate — assert the
    // deferred row via state (full title) and paint (truncated prefix).
    assert.ok(u.visibleRows().some((r) => r.title === 'more result 1'), 'deferred row in state');
    assert.ok(text(screen).includes('more resu'), 'deferred rows visible after collapse');
  });
  it('Tab collapses the full answer before opening gallery/preview', () => {
    const { screen, ui: u } = make();
    assert.equal(u.showLinkPicker(rows(3, 'dogs'), null, 'Digest words about dogs.'), true);
    u.setAiAnswer('A real answer about dogs.');
    altUp(screen);
    assert.ok(text(screen).includes('AI answer'), 'full answer open');
    screen.emit('keypress', null, { name: 'tab', full: 'tab' });
    assert.ok(!text(screen).includes('FULL RESPONSE'), 'Tab collapsed the answer first');
    assert.ok(text(screen).includes('Links (3)'), 'list repainted');
  });
  it('a stalled fill says so on the tail row; new search clears it', () => {
    const { screen, ui: u } = make();
    u.setPageSize(5);
    assert.equal(u.showLinkPicker(rows(8, 'birds'), null, 'Digest words.'), true);
    assert.ok(text(screen).includes('… load more (3 more)'), 'tail row present');
    assert.ok(!text(screen).includes('fill stalled'), 'no marker before failure');
    assert.equal(u.markFillStalled(), true);
    assert.ok(text(screen).includes('… load more (3 more, fill stalled)'), 'stall marker shown');
    assert.equal(u.showLinkPicker(rows(8, 'fish'), null, 'Other digest.'), true);
    assert.ok(!text(screen).includes('fill stalled'), 'new search clears the marker');
  });
});

describe('command-line rule matches the theme border', () => {
  it('sep2 is born and kept border-colored (not muted, glyph untouched)', () => {
    const src = fs.readFileSync(require.resolve('../src/ui'), 'utf8');
    const i = src.indexOf('const sep2 = makeBox(');
    assert.ok(i >= 0, 'sep2 exists');
    assert.ok(src.slice(i, src.indexOf('});', i)).includes('fg: theme.border'),
      'sep2 constructor uses theme.border');
    assert.ok(src.includes('sep2.style.fg = theme.border'),
      'applyTheme keeps sep2 on theme.border');
    assert.ok(!src.includes('sep2.style.fg = theme.muted'),
      'sep2 never muted again');
    const g = src.slice(src.indexOf('const BOT_SEP'));
    assert.ok(g.startsWith('const BOT_SEP ='), 'rule glyph constant intact');
  });
});
