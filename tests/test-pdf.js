'use strict';
/* PDF pipeline tests: URL detection, the /pdf command routing (search only —
 * never a URL opener), and the /settings-independent glue. No network, no
 * poppler: openPdf is stubbed where the navigation glue is exercised
 * (test-index.js). */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isPdfUrl } = require('../src/pdf');
const { routeCommand } = require('../src/commands');

function mockDeps(over = {}) {
  const calls = { content: [], search: [] };
  return {
    calls,
    deps: {
      ui: {
        setCenterContent: (t) => calls.content.push(String(t)),
        toast: (t) => calls.content.push(String(t)),
      },
      browser: { profileDir: '/tmp/prof', profileReady: () => false, close: async () => {} },
      navigator: { getHistory: () => [] },
      config: {},
      saveConfig: () => {},
      shutdown: () => {},
      search: (q) => calls.search.push(q),
      ...over,
    },
  };
}

describe('pdf: isPdfUrl', () => {
  it('detects .pdf pathnames, case-insensitively, with query/hash', () => {
    for (const u of [
      'https://example.com/doc.pdf',
      'https://example.com/DOC.PDF',
      'https://example.com/a/b/c.pdf?token=1&x=2',
      'https://example.com/paper.pdf#page=7',
      'http://cdn.example.com/x/y%20z.pdf',
    ]) assert.equal(isPdfUrl(u), true, u);
  });
  it('never fires on non-pdf paths (query text does not count)', () => {
    for (const u of [
      'https://example.com/',
      'https://example.com/doc.html',
      'https://example.com/pdf',
      'https://example.com/download?file=a.pdf',
      'https://example.com/report.pdfx',
      'not a url', '', null, undefined, 42,
    ]) assert.equal(isPdfUrl(u), false, String(u));
  });
});

describe('/pdf routes to a PDF-only web search', () => {
  it('/pdf <query> → filetype:pdf through the normal search pipeline', () => {
    const { calls, deps } = mockDeps();
    routeCommand('/pdf godot manual', deps);
    assert.deepEqual(calls.search, ['filetype:pdf godot manual']);
  });
  it('multi-word queries keep every word (whitespace normalized upstream)', () => {
    const { calls, deps } = mockDeps();
    routeCommand('/pdf neural  network   survey', deps);
    assert.deepEqual(calls.search, ['filetype:pdf neural network survey']);
  });
  it('bare /pdf teaches instead of searching', () => {
    const { calls, deps } = mockDeps();
    routeCommand('/pdf', deps);
    assert.equal(calls.search.length, 0, 'no search fired');
    assert.match(calls.content.join('\n'), /Usage: \/pdf/);
    assert.match(calls.content.join('\n'), /filetype:pdf/);
  });
  it('without a search dep it says so instead of dying', () => {
    const { calls, deps } = mockDeps({ search: undefined });
    routeCommand('/pdf godot', deps);
    assert.equal(calls.search.length, 0);
    assert.match(calls.content.join('\n'), /Search is not available/);
  });
  it('/gemini-key is retired with a pointer to /ai-key (never a silent no-op)', () => {
    const { calls, deps } = mockDeps();
    routeCommand('/gemini-key sk-or-whatever', deps);
    assert.match(calls.content.join('\n'), /retired/);
    assert.match(calls.content.join('\n'), /ai-key/);
  });
});
