'use strict';
/* Handover regression tests (BUG-1..BUG-8 + wave spec + keytest contract).
 * Every bug fixed in this pass has a test here that fails on the old code:
 * - bare {#hex} content tags (junk SGR, themes looked identical)
 * - code-point width measurement (CJK/emoji overran boxes, underline spilled)
 * - wrapVis returning overlong URL rows whole (border overrun)
 * - centerTagged/truncateVisual mis-measurement
 * - 24-frame motif replaced by the user's 14-cell periodic cycle
 * No browser is launched by this file (pure + blessed-screen harnesses).
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { visLen, visibleCells, isWideChar, fitVis, splitVis, wrapVis, boxSections, boxRowOverflow } = require('../src/beautify');
const ui = require('../src/ui');
const { themeList, themeNames, getTheme, HIGHLIGHTED } = require('../src/themes');

describe('handover: cell-accurate measurement (BUG-2 H2, BUG-6)', () => {
  it('visibleCells: ascii 1, CJK/emoji 2, tags 0, escaped braces 1', () => {
    assert.equal(visibleCells('hello'), 5);
    assert.equal(visibleCells('日本語'), 6);
    assert.equal(visibleCells('🎉'), 2);
    assert.equal(visibleCells('{bold}hi{/}'), 2);
    assert.equal(visibleCells('{open}x{close}'), 3);
    assert.equal(visibleCells('a{red-fg}b{/}c'), 3);
    assert.equal(isWideChar('日'), true);
    assert.equal(isWideChar('a'), false);
    assert.equal(visibleCells('♥'), 1, 'the symbol block is one cell (blessed parity)');
    assert.equal(isWideChar('♥'), false);
    assert.equal(visibleCells('SCORE 0 · LIVES ♥♥♥'), 19, 'the stats row has no phantom cells');
  });
  it('visLen is the same cell-accurate function (historic name kept)', () => {
    assert.equal(visLen('日本語'), 6);
    assert.equal(visLen('{bold}hi{/}'), 2);
  });
  it('fitVis never emits a half wide char and keeps tags intact', () => {
    assert.equal(visibleCells(fitVis('日本語', 5)), 4);
    assert.equal(visibleCells(fitVis('日本語', 6)), 6);
    const t = fitVis('{bold}hello world{/}', 8);
    assert.equal(visibleCells(t), 8);
    assert.ok(t.includes('{bold}'), 'opening tag survives');
  });
  it('splitVis chunks overlong words into rows that all fit', () => {
    for (const row of splitVis('abcdefghij', 4)) assert.ok(visibleCells(row) <= 4, row);
    assert.deepEqual(splitVis('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
    for (const row of splitVis('日本語テスト', 5)) assert.ok(visibleCells(row) <= 5, row);
  });
  it('wrapVis never returns a row wider than max (BUG-2 H1)', () => {
    const rows = wrapVis('See [https://example.com/very/long/path/that/keeps/going/on/forever/more] here', 20);
    for (const r of rows) assert.ok(visibleCells(r) <= 20, `overlong row: ${r}`);
    const cjk = wrapVis('日本語のテキストが very long wordswithoutanyspacesinit', 12);
    for (const r of cjk) assert.ok(visibleCells(r) <= 12, `overlong row: ${r}`);
  });
  it('boxSections corpus: every emitted line fits W cells', () => {
    const corpus = [
      '# T', '', 'Plain ascii intro.',
      '## Wide',
      '日本語のテキストと絵文字 🎉 が混ざった長い行です link [https://example.com/a] end.',
      '## Braces',
      'Raw {bold} looking text and {red} markers stay literal.',
      '## Long URL',
      'See [https://example.com/very/long/path/that/keeps/going/on/forever/and/ever/more] here.',
      '```', 'const token = "averyveryveryveryveryveryveryveryveryveryverylongstring";', '```',
      '## Bullets', '- alpha', '- beta with a veryveryveryveryveryveryveryveryveryvery longword',
      '> quoted line',
    ].join('\n');
    for (const W of [40, 60, 76]) {
      const r = boxSections(corpus, { width: W });
      assert.equal(r.boxed, true);
      for (const row of r.text.split('\n')) {
        assert.ok(visibleCells(row) <= W, `W=${W} overrun: ${JSON.stringify(row.slice(0, 80))}`);
      }
      assert.equal(boxRowOverflow(r.text, W) <= 0, true, `overflow at W=${W}`);
    }
  });
});

describe('handover: centering + truncation (BUG-2 H4, BUG-6)', () => {
  it('centerTagged accounts escaped braces and wide chars, never overruns', () => {
    for (const W of [40, 80, 120]) {
      assert.ok(visibleCells(ui.centerTagged('{bold}Title{/}', W)) <= W);
      assert.ok(visibleCells(ui.centerTagged('{open}hi{close}', W)) <= W);
      // {open}/{close} render as real braces: centering must leave room.
      const a = ui.centerTagged('{open}hi{close}', 10);
      const b = ui.centerTagged('     hi     '.trim(), 10);
      assert.ok(visibleCells(a) <= 10 && visibleCells(b) <= 10);
      assert.ok(visibleCells(ui.centerTagged('日本語タイトル', W)) <= W);
      assert.ok(visibleCells(ui.centerTagged('x'.repeat(200), W)) <= W, 'overlong truncates');
    }
  });
  it('truncateVisual is tag-aware and wide-aware', () => {
    assert.equal(ui.truncateVisual('hello world', 8), 'hello w…');
    assert.equal(visibleCells(ui.truncateVisual('{bold}hello world{/}', 8)), 8);
    assert.equal(visibleCells(ui.truncateVisual('日本語テスト', 7)), 7);
    assert.equal(ui.truncateVisual('short', 80), 'short');
  });
});

describe('handover: theme color tags use blessed -fg form (BUG-1 root cause)', () => {
  it('every theme-colored content string carries -fg tags', () => {
    const art = ui.loaderFrame(2, 'Loading', 'stage', 40, '#82aaff');
    assert.ok(art.includes('{#82aaff-fg}'), 'loaderFrame accent tag: ' + JSON.stringify(art));
    const wave = ui.waveLineTagged(0, 20, '#82aaff', '#ff6767');
    assert.ok(wave.includes('{#82aaff-fg}'), 'crest tag');
    assert.ok(wave.includes('{#ff6767-fg}'), 'trough tag');
    assert.equal(visibleCells(wave), 20, 'tagged wave is exactly width cells');
  });
  it('bare {#hex} tags are gone from src (they emit junk SGR 111, not color)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../src/ui'), 'utf8');
    const bare = src.match(/\{[#\$]\{[^}]*\}\}|\{\$\{theme\.[a-z]+\}\}/g) || [];
    assert.deepEqual(bare, [], 'bare hex interpolations remain: ' + JSON.stringify(bare.slice(0, 3)));
  });
});

describe('handover: full-width two-tone wave (spec §2)', () => {
  it('waveLineTagged uses both theme colors and spans exactly width', () => {
    for (const w of [10, 24, 80]) {
      for (let i = 0; i < ui.WAVE_FRAMES; i++) {
        const line = ui.waveLineTagged(i, w, '#82aaff', '#ff6767');
        assert.equal(visibleCells(line), w, `frame ${i} width ${w}`);
      }
    }
  });
  it('loaderFrame is 2 lines: status / full-width wave (footer slot)', () => {
    const art = ui.loaderFrame(0, 'T', 'S', 40);
    assert.equal(art.split('\n').length, 2);
    assert.equal([...art.split('\n')[1]].length, 40);
  });
});

describe('handover: picker grid swatches + narrow layout (Options D, BUG-7)', () => {
  const names = themeList();
  it('every data row carries swatches with balanced tags', () => {
    const rows = ui.themeGrid(names, 80, 'matrix', '#ffffff');
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.ok(r.label.includes('██'), 'swatch present: ' + r.label.slice(0, 40));
      const opens = (r.label.match(/\{(?!\/)[^}]*\}/g) || []).length;
      const closes = (r.label.match(/\{\/\}/g) || []).length;
      assert.ok(closes >= Math.ceil(opens / 2), `tags balance in ${r.label.slice(0, 50)}`);
    }
  });
  it('rows fit their width in both layouts', () => {
    for (const r of ui.themeGrid(names, 80, 'matrix', '#ffffff')) {
      assert.ok(visibleCells(r.label) <= 80, 'two-col fits: ' + r.label.slice(0, 60));
    }
    const narrow = ui.themeGrid(names, 40, 'matrix', '#ffffff');
    assert.equal(narrow.length, names.length, 'one row per theme when narrow');
    for (const r of narrow) {
      assert.ok(visibleCells(r.label) <= 40, 'single-col fits: ' + r.label.slice(0, 60));
    }
  });
});

describe('handover: theme table uniqueness (BUG-5)', () => {
  it('all 75 full fingerprints are unique', () => {
    const fps = new Map();
    for (const n of themeNames()) {
      const t = getTheme(n);
      const fp = [t.bg, t.fg, t.border, t.muted, t.accent, t.alt].join('|');
      assert.ok(!fps.has(fp), `${n} duplicates ${fps.get(fp)}`);
      fps.set(fp, n);
    }
  });
  it('highlighted themes have distinct raw backgrounds', () => {
    const bgs = HIGHLIGHTED.map((n) => getTheme(n).bg);
    assert.equal(new Set(bgs).size, bgs.length, 'highlighted bgs: ' + JSON.stringify(bgs));
  });
});

describe('handover: truecolor patch (BUG-1 Option A)', () => {
  const { hexToRgbTriplet, hasTruecolor, enableTruecolor } = ui;
  it('hexToRgbTriplet parses 3- and 6-digit hex, rejects junk', () => {
    assert.deepEqual(hexToRgbTriplet('#82aaff'), { r: 130, g: 170, b: 255 });
    assert.deepEqual(hexToRgbTriplet('#fff'), { r: 255, g: 255, b: 255 });
    assert.equal(hexToRgbTriplet('nope'), null);
    assert.equal(hexToRgbTriplet(null), null);
  });
  it('hasTruecolor is gated on COLORTERM only', () => {
    const prev = process.env.COLORTERM;
    try {
      process.env.COLORTERM = 'truecolor';
      assert.equal(hasTruecolor(), true);
      process.env.COLORTERM = 'xterm-256color';
      assert.equal(hasTruecolor(), false);
      delete process.env.COLORTERM;
      assert.equal(hasTruecolor(), false);
    } finally {
      if (prev === undefined) delete process.env.COLORTERM;
      else process.env.COLORTERM = prev;
    }
  });
  it('enableTruecolor emits 38;2/48;2 when advertised, stock path otherwise', () => {
    const prev = process.env.COLORTERM;
    const calls = [];
    const fakeProg = {
      _attr(param, val) { calls.push([param, val]); return `stock(${param})`; },
      tput: { colors: 256 },
      term() { return false; },
    };
    try {
      process.env.COLORTERM = 'truecolor';
      assert.equal(enableTruecolor({ program: fakeProg }), true);
      assert.equal(fakeProg._attr('#82aaff fg'), '\x1b[38;2;130;170;255m');
      assert.equal(fakeProg._attr('#000000 bg'), '\x1b[48;2;0;0;0m');
      assert.equal(fakeProg._attr('red'), 'stock(red)', 'non-hex falls through');
      assert.equal(enableTruecolor({ program: fakeProg }), true, 'idempotent');
      const plain = { _attr(p) { return `stock(${p})`; } };
      process.env.COLORTERM = 'xterm-256color';
      delete plain._truecolorPatched;
      assert.equal(enableTruecolor({ program: plain }), false, 'no patch without truecolor');
      assert.equal(plain._attr('#82aaff fg'), 'stock(#82aaff fg)');
    } finally {
      if (prev === undefined) delete process.env.COLORTERM;
      else process.env.COLORTERM = prev;
    }
  });
});

describe('handover: suite launches no real browser (BUG-8)', () => {
  it('no test file references a real engine launch', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname);
    const bad = [];
    // Pattern fragments are concatenated so this file does not literally
    // contain them (it scans itself too).
    const pats = ['chromium' + '.launch', 'firefox' + '.launch', 'playwright' + '.chromium', "require('" + "playwright')", 'require("' + 'playwright")'];
    // test-launch.js is the one documented exception: it drives the REAL
    // _launch() against a fake playwright injected through require.cache
    // (the regression pin for the lazy-load crash) and can never start an
    // engine — the injected stub makes a real launch impossible.
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'test-launch.js')) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const pat of pats) {
        if (src.includes(pat)) bad.push(`${f}: ${pat}`);
      }
    }
    assert.deepEqual(bad, [], 'real-launch references in tests');
  });
});

describe('handover: multi-char + wide-char input reaches the bar (keytest K2/K3)', () => {
  const blessed = require('blessed');
  let screens = [];
  function makeUI(handlers = {}, opts = { theme: 'white', pageSize: 50 }) {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 'test' });
    screens.push(screen);
    const u = ui.createUI(screen, {
      onOmniSubmit: () => {}, onSuggest: () => {}, onLinkPick: () => {},
      onPlayVideo: () => {}, onHistoryBack: () => {}, onHistoryForward: () => {},
      onEscape: () => {}, onQuit: () => {}, ...handlers,
    }, opts);
    return { screen, ui: u };
  }
  afterEach(() => {
    for (const s of screens) { try { s.destroy(); } catch {} }
    screens = [];
  });
  it('IME/paste commit (multi-char) lands in the query intact', async () => {
    const seen = [];
    const { screen } = makeUI({ onSuggest: (q) => seen.push(q) });
    screen.emit('keypress', '日本語', { name: undefined, full: undefined });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(seen.some((q) => String(q).includes('日本語')), 'CJK in app state: ' + JSON.stringify(seen));
  });
  it('backspace deletes one code point (emoji survives as a pair)', async () => {
    const seen = [];
    const { screen } = makeUI({ onSuggest: (q) => seen.push(q) });
    screen.emit('keypress', 'a🎉', { name: undefined, full: undefined });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(seen.some((q) => String(q).includes('a🎉')), 'emoji committed: ' + JSON.stringify(seen));
    screen.emit('keypress', undefined, { name: 'backspace', full: 'backspace' });
    await new Promise((r) => setTimeout(r, 300));
    const last = String(seen.at(-1));
    assert.ok(last.endsWith('a'), `one code point deleted, no lone surrogate: ${JSON.stringify(last)}`);
    assert.ok(!last.includes('�'), 'no replacement char from a halved pair');
  });
  it('control chars are still rejected', () => {
    const seen = [];
    const { screen } = makeUI({ onSuggest: (q) => seen.push(q) });
    screen.emit('keypress', 'a\x01b', { name: undefined, full: undefined });
    assert.equal(seen.length, 0, 'mixed control string dropped');
  });
});

describe('handover: live UI integration (screen harness, no browser)', () => {
  const blessed = require('blessed');
  let screens = [];
  function makeUI(handlers = {}, opts = { theme: 'white', pageSize: 50 }) {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 'test' });
    screens.push(screen);
    const u = ui.createUI(screen, {
      onOmniSubmit: () => {}, onSuggest: () => {}, onLinkPick: () => {},
      onPlayVideo: () => {}, onHistoryBack: () => {}, onHistoryForward: () => {},
      onEscape: () => {}, onQuit: () => {}, ...handlers,
    }, opts);
    return { screen, ui: u };
  }
  afterEach(() => {
    for (const s of screens) { try { s.destroy(); } catch {} }
    screens = [];
  });
  function contentsOf(screen) {
    const texts = [];
    (function walk(el) {
      if (!el || !el.children) return;
      for (const c of el.children) {
        try {
          const t = typeof c.getContent === 'function' ? c.getContent() : '';
          if (typeof t === 'string' && t.trim()) texts.push(t);
        } catch {}
        walk(c);
      }
    })(screen);
    return texts.join('\n');
  }
  it('loader paints a 2-line footer bar (status + wave), page untouched', () => {
    const { ui: u, screen } = makeUI();
    u.setCenterContent('A wiki article about penguins living happily together forever.', []);
    assert.equal(u.showLoading('Loading page', 'fetching text', 'hint here'), true);
    const text = contentsOf(screen);
    assert.ok(text.includes('Loading page'), 'status line shows the title');
    // The loader hint row is gone by design (footer slot): hints wait for
    // idle instead of stacking a third row.
    assert.ok(!text.includes('hint here'), 'no hint row while the slot is busy');
    const stripped = text.replace(/\[[0-9;]*m/g, '').replace(/\{[^}]*\}/g, '');
    assert.ok(/[▁▂▃▄▅▆▇█]{10,}/.test(stripped), 'full-width wave run');
    assert.ok(text.includes('penguins'), 'page above the loader is untouched');
    assert.ok(!text.includes('{bold}'), 'no leaked tags');
    u.hideLoading();
    assert.equal(u.isLoading(), false);
  });
  it('live theme apply changes widget style colors and stays in the picker', () => {
    const saved = [];
    const { ui: u, screen } = makeUI({ onThemeChange: (n) => saved.push(n) });
    assert.equal(u.showThemes(), true);
    screen.emit('keypress', null, { name: 'down', full: 'down' });
    const name = u.getThemeName();
    assert.notEqual(name, 'white');
    assert.deepEqual(saved, [name]);
    assert.equal(u.isTruecolor(), ui.hasTruecolor(), 'truecolor flag mirrors capability');
    assert.equal(u.isThemesOpen(), true, 'picker stays open during live apply');
    screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    assert.equal(u.isThemesOpen(), false);
  });
  it('picker rows show swatches on screen', () => {
    const { ui: u, screen } = makeUI();
    u.showThemes();
    assert.ok(contentsOf(screen).includes('██'), 'swatch blocks painted in the picker');
    u.closeThemes();
  });
});
