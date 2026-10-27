'use strict';

// Box-containment checker tests (Part A, step 1): verifyBoxContainment
// proves a painted body string sits right inside its container — borders
// aligned, nothing past the inner width, no escaped continuation lines.

const assert = require('node:assert');
const { describe, it, afterEach } = require('node:test');
const {
  boxSections, blockMd, visLen, stripRawAnsi, verifyBoxContainment, boxRowOverflow,
} = require('../src/beautify');

const CORPUS = [
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

function linkLine(labelLen, urlLen) {
  const label = 'word '.repeat(Math.max(1, Math.ceil(labelLen / 5))).slice(0, labelLen);
  const url = `https://example.com/${'p/'.repeat(Math.max(1, Math.ceil(urlLen / 2))).slice(0, urlLen)}`;
  return `${label} [${url}]`;
}

describe('box containment: healthy boxes verify clean', () => {
  it('corpus boxes fit at 40/80/120', () => {
    for (const W of [40, 80, 120]) {
      const r = boxSections(CORPUS, { width: W });
      assert.equal(r.boxed, true);
      const v = verifyBoxContainment(blockMd(r.text), W);
      assert.equal(v.ok, true, `W=${W}: ${JSON.stringify(v.violations.slice(0, 2))}`);
    }
  });
  it('wrapping links stay contained (short/long/huge labels, bare urls)', () => {
    const cases = [
      linkLine(3, 20),
      linkLine(40, 60),
      linkLine(200, 120),
      '[https://example.com/an/extremely/long/single/url/that/has/no/spaces/at/all/anywhere/xxxxxxxxxxxx]',
      `A markdown [title here](https://example.com/some/path/segment) link inline.`,
      '日本語のリンク [https://example.com/日本語/パス] mixed wide text here.',
      `see [https://a.com/x] and [https://b.com/y] and [https://c.com/z] here now `.repeat(3),
    ];
    for (const line of cases) {
      const r = boxSections(['## Links', '', line, ''].join('\n'), { width: 60 });
      assert.equal(r.boxed, true);
      const v = verifyBoxContainment(blockMd(r.text), 60);
      assert.equal(v.ok, true, `line ${line.slice(0, 40)}…: ${JSON.stringify(v.violations.slice(0, 2))}`);
    }
  });
  it('stripRawAnsi + visibleCells ignore rendered escapes', () => {
    assert.equal(stripRawAnsi('a\x1b[4mb\x1b[mc'), 'abc');
    assert.equal(visLen('│  \x1b[4mRead this\x1b[m  │'), visLen('│  Read this  │'));
  });
  it('boxRowOverflow agrees with the checker on fixtures', () => {
    const r = boxSections(CORPUS, { width: 60 });
    const cooked = blockMd(r.text);
    assert.equal(boxRowOverflow(cooked, 60) <= 0, true);
    assert.equal(verifyBoxContainment(cooked, 60).ok, true);
    assert.ok(boxRowOverflow(cooked, 10) > 0);
    assert.equal(verifyBoxContainment(cooked, 10).ok, false);
  });
});

describe('box containment: broken boxes are named', () => {
  it('right edge past the container is box-row-exceeds-container', () => {
    const bad = '╭─ T ───╮\n│ hi     │\n╰────────╯';
    const v = verifyBoxContainment(bad, 8);
    assert.equal(v.ok, false);
    assert.ok(v.violations.some((x) => x.reason === 'box-row-exceeds-container'), JSON.stringify(v.violations));
  });
  it('non-prefixed over-wide row inside a run is still caught', () => {
    const bad = ['╭─ T ─╮', '│ hi  │', 'this escaped continuation line is way too long', '╰──────╯'].join('\n');
    const v = verifyBoxContainment(bad, 10);
    assert.equal(v.ok, false);
    const hit = v.violations.find((x) => x.line === 2);
    assert.ok(hit && hit.reason === 'content-exceeds-container', JSON.stringify(v.violations));
  });
  it('missing caps and misaligned borders are named', () => {
    const noBottom = '╭─ T ─╮\n│ hi  │';
    assert.ok(verifyBoxContainment(noBottom, 10).violations.some((x) => x.reason === 'run-missing-bottom'));
    const orphan = '│ hi  │\n╰──────╯';
    const vo = verifyBoxContainment(orphan, 10);
    assert.ok(vo.violations.some((x) => x.reason === 'run-missing-top'), JSON.stringify(vo.violations));
    const skewed = '╭─ T ───╮\n│ hi     │\n╰────────╯';
    const vs = verifyBoxContainment(skewed, 20);
    assert.ok(vs.violations.some((x) => x.reason === 'border-misaligned'), JSON.stringify(vs.violations));
  });
  it('plain text wider than the container is content-exceeds-container', () => {
    const v = verifyBoxContainment('short\nthis plain line is definitely too long', 10);
    assert.equal(v.ok, false);
    assert.ok(v.violations.some((x) => x.reason === 'content-exceeds-container'));
  });
  it('never throws on junk', () => {
    assert.doesNotThrow(() => verifyBoxContainment(null, 10));
    assert.doesNotThrow(() => verifyBoxContainment(undefined, 0));
    assert.deepEqual(verifyBoxContainment('', 10), { ok: true, violations: [] });
  });
});

describe('box containment: emphasis never misaligns a box', () => {
  const esc = (s) => String(s).replace(/[{}]/g, (m) => (m === '{' ? '{open}' : '{close}'));
  it('**bold** / *italic* / `code` keep every row exactly W after blockMd', () => {
    const src = [
      '## Emphasis',
      '',
      'Some *italic* words and **bold** words and `code` too, mixed together here.',
      '',
      '- a *bullet* with **emphasis** and more *words* to wrap around the line',
      '',
      '> a *quoted* line with **strong** words',
    ].join('\n');
    for (const W of [40, 60, 80]) {
      const b = boxSections(esc(src), { width: W, available: W });
      const cooked = blockMd(b.text);
      for (const r of cooked.split('\n')) {
        if (/^[╭╰│]/.test(r)) {
          assert.equal(visLen(r), W, `W=${W} misaligned row: ${JSON.stringify(r)}`);
        }
      }
    }
  });
  it('no underline survives in a box (italics become plain, bold/code kept)', () => {
    const src = ['## T', '', 'An *italic* word and **bold** and `code` here.', ''].join('\n');
    const cooked = blockMd(boxSections(esc(src), { width: 60, available: 60 }).text);
    assert.ok(!cooked.includes('{underline}'), 'no underline tags inside boxes');
    assert.ok(cooked.includes('{bold}bold{/}'), 'bold kept');
    assert.ok(cooked.includes('{inverse}code{/}'), 'code kept');
    assert.ok(cooked.includes('An italic word'), 'italic rendered as plain text');
  });
  it('links still pair and stay clickable without an underline', () => {
    const src = ['## Links', '', 'See cats [https://example.com/cats] and *dogs* [https://example.com/dogs] today.', ''].join('\n');
    const b = boxSections(esc(src), { width: 60, available: 60 });
    const cooked = blockMd(b.text);
    assert.ok(!cooked.includes('{underline}'), 'no underline');
    assert.ok(!cooked.includes('example.com'), 'no visible url');
    assert.ok(cooked.includes('See cats and dogs today'), 'labels kept');
    assert.deepEqual(b.linkLines.map((l) => l.url), ['https://example.com/cats', 'https://example.com/dogs']);
  });
});

describe('box containment: live painted article verifies', () => {
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
  function articleBody(screen) {
    let found = '';
    (function walk(el) {
      try {
        if (typeof el.getContent === 'function') {
          const c = String(el.getContent());
          // Article box title rows are `╭─ Title`; chrome edges are
          // unbroken dashes, so this only matches the article body.
          if (/╭─ [^─]/.test(c)) found = found || c;
        }
      } catch {}
      (el.children || []).forEach(walk);
    })(screen);
    return found;
  }
  afterEach(() => {
    for (const s of screens) { try { s.destroy(); } catch {} }
    screens = [];
  });
  it('wrapped-link article body contains at default width', () => {
    const { screen, ui } = makeUI();
    const pretty = [
      '## Alpha', '', 'Intro line.', '',
      `Read this very long linked article title that needs to wrap in the box [https://example.com/quite/long/path/segment].`, '',
      'Tail.',
    ].join('\n');
    ui.setCenterContent('raw', [], null, null, null, null, pretty, null);
    const body = articleBody(screen);
    assert.ok(body.includes('╭─ Alpha'), 'article box painted');
    // blessed getContent carries rendered escapes: the checker must see
    // through them (ANSI-aware) and still verify the box.
    const inner = Math.max(20, (screen.width || 80) - 2);
    const v = verifyBoxContainment(body, inner);
    assert.equal(v.ok, true, JSON.stringify(v.violations.slice(0, 3)));
  });
});
