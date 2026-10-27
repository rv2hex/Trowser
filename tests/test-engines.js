'use strict';
/* Search-engine chain (src/engines.js): URL building, redirector/query
 * extraction, bot-wall fingerprinting and the fallback verdict. Pure — no
 * browser, no network. Run: node --test --test-force-exit tests/test-engines.js
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const engines = require('../src/engines');

afterEach(() => engines.resetBlocked());

describe('engines: catalog', () => {
  it('exposes DDG -> Bing -> Brave in preference order', () => {
    assert.deepEqual(engines.ENGINES.map((e) => e.id), ['duckduckgo', 'bing', 'brave']);
    for (const e of engines.ENGINES) {
      assert.ok(e.name && typeof e.searchUrl === 'function', `${e.id} has name + searchUrl`);
      assert.match(e.searchUrl('a b&c'), /^https:\/\/.+\?q=a%20b%26c$/);
    }
  });
});

describe('engines: URL identity', () => {
  it('recognizes engine search URLs, ignores other paths/hosts', () => {
    assert.equal(engines.engineForUrl('https://html.duckduckgo.com/html/?q=x').id, 'duckduckgo');
    assert.equal(engines.engineForUrl('https://www.bing.com/search?q=x').id, 'bing');
    assert.equal(engines.engineForUrl('https://search.brave.com/search?q=x').id, 'brave');
    // Non-search paths and unrelated hosts are not engines.
    assert.equal(engines.engineForUrl('https://duckduckgo.com/about'), null);
    assert.equal(engines.engineForUrl('https://example.com/search?q=x'), null);
    assert.equal(engines.engineForUrl('not a url'), null);
  });

  it('isEngineSearchUrl is the boolean form', () => {
    assert.equal(engines.isEngineSearchUrl('https://www.bing.com/search?q=x'), true);
    assert.equal(engines.isEngineSearchUrl('https://example.com/'), false);
  });

  it('extracts the query from every engine form', () => {
    assert.equal(engines.queryOf('https://html.duckduckgo.com/html/?q=hello+world'), 'hello world');
    assert.equal(engines.queryOf('https://www.bing.com/search?q=hello'), 'hello');
    assert.equal(engines.queryOf('https://search.brave.com/search?q=%C3%A9t%C3%A9'), 'été');
    assert.equal(engines.queryOf('https://example.com/'), '');
    assert.equal(engines.queryOf('nope'), '');
  });
});

describe('engines: fallback ladder', () => {
  it('a DDG search falls back to Bing then Brave, never to itself', () => {
    const f = engines.fallbacksFor('https://html.duckduckgo.com/html/?q=cats');
    assert.deepEqual(f.map((x) => x.id), ['bing', 'brave']);
    assert.match(f[0].url, /bing\.com\/search\?q=cats/);
  });

  it('skips engines already known-blocked this session', () => {
    engines.markBlocked('bing');
    const f = engines.fallbacksFor('https://html.duckduckgo.com/html/?q=cats');
    assert.deepEqual(f.map((x) => x.id), ['brave']);
    assert.equal(engines.isBlocked('bing'), true);
    engines.unmarkBlocked('bing');
    assert.equal(engines.isBlocked('bing'), false);
  });

  it('no query and non-search URLs produce no fallbacks', () => {
    assert.deepEqual(engines.fallbacksFor('https://html.duckduckgo.com/html/'), []);
    assert.deepEqual(engines.fallbacksFor('https://example.com/'), []);
  });
});

describe('engines: challenge fingerprint', () => {
  it('catches the real bot-wall wording', () => {
    assert.equal(engines.looksLikeChallenge('Unfortunately, bots use DuckDuckGo too.'), true);
    assert.equal(engines.looksLikeChallenge('Select all squares containing a duck'), true);
    assert.equal(engines.looksLikeChallenge('Verifying your browser…'), true);
    assert.equal(engines.looksLikeChallenge('We detected unusual traffic from your network'), true);
    assert.equal(engines.looksLikeChallenge('Please complete the following challenge to confirm'), true);
  });

  it('never flags a normal results page', () => {
    assert.equal(engines.looksLikeChallenge('Godot Engine — free and open source game engine'), false);
    assert.equal(engines.looksLikeChallenge(''), false);
  });
});

describe('engines: fallback verdict', () => {
  it('blocked / challenge text => fall back', () => {
    assert.deepEqual(engines.judgeSearch({ blocked: true }), { fallback: true, reason: 'challenge' });
    assert.equal(engines.judgeSearch({ text: 'Unfortunately, bots use DuckDuckGo too.', count: 0 }).fallback, true);
  });

  it('a blank 0-row page falls back', () => {
    assert.deepEqual(engines.judgeSearch({ text: '', count: 0 }), { fallback: true, reason: 'blank' });
  });

  it('a real result set never falls back', () => {
    assert.equal(engines.judgeSearch({ text: 'x'.repeat(500), count: 10 }).fallback, false);
  });

  it('a 0-row page WITH text keeps its text-dump behavior', () => {
    assert.equal(engines.judgeSearch({ text: 'x'.repeat(500), count: 0 }).fallback, false);
  });

  it('an honest "no results" page is not a block', () => {
    assert.equal(engines.judgeSearch({ text: 'No results found for zzz', count: 0 }).fallback, false);
    assert.equal(engines.judgeSearch({ text: 'Your search did not match any documents', count: 0 }).fallback, false);
  });
});
