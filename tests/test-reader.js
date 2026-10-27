'use strict';
/* Tests for the reader-view stack: link normalization, the DuckDuckGo
 * fan-out, the network blocklist, readability helpers, the keyless Gemini
 * web driver and the animated loader. ALL OFFLINE — fetch is injected or
 * stubbed, never real network.
 * Run: node --test tests/test-reader.js
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const realFetch = global.fetch;
afterEach(() => {
  if (global.fetch !== realFetch) global.fetch = realFetch;
});

// ============================================================
// links.js
// ============================================================
describe('links: cleanLinks', () => {
  const { cleanLinks, unseenRows, urlSet } = require('../src/links');
  it('absolutizes relative hrefs and derives the domain', () => {
    const rows = cleanLinks([{ href: '/docs', title: 'Docs' }], 10, 'https://example.com/guide/');
    assert.equal(rows[0].url, 'https://example.com/docs');
    assert.equal(rows[0].domain, 'example.com');
  });
  it('unwraps redirectors and dedupes by FINAL url', () => {
    const rows = cleanLinks(
      [
        { href: 'https://www.google.com/url?q=https://real.site/a', title: 'A' },
        { href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Freal.site%2Fa', title: 'A again' },
      ],
      10,
      'https://duckduckgo.com/'
    );
    assert.equal(rows.length, 1, 'same target, one row');
    assert.equal(rows[0].url, 'https://real.site/a');
  });
  it('keeps mailto (system mail client), drops other schemes', () => {
    const rows = cleanLinks(
      [
        { href: 'mailto:hi@example.com', title: 'Mail' },
        { href: 'tel:+15551234', title: 'Call' },
        { href: 'javascript:void(0)', title: 'Nope' },
      ],
      10,
      'https://example.com'
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].domain, 'email');
  });
  it('honours the limit and never throws on junk input', () => {
    assert.equal(cleanLinks(new Array(50).fill({ href: 'https://a.com/x', title: 'dup' }), 10, 'https://a.com').length, 1);
    assert.deepEqual(cleanLinks([{ href: '' }, { title: 'no href' }, null, 'nope'], 10, 'https://a.com'), []);
    assert.deepEqual(cleanLinks(undefined, 10, 'nonsense'), []);
  });
  it('unseenRows appends only new urls, preserving order', () => {
    const seen = urlSet([{ url: 'https://a.com/1' }]);
    const fresh = unseenRows(
      [
        { url: 'https://a.com/1', title: 'dup' },
        { url: 'https://a.com/2', title: 'new' },
        { url: 'https://a.com/3', title: 'newer' },
      ],
      seen
    );
    assert.deepEqual(fresh.map((r) => r.url), ['https://a.com/2', 'https://a.com/3']);
    assert.equal(seen.size, 3);
  });
});

// ============================================================
// searchFill.js — the "more than 10 links" machinery
// ============================================================
describe('searchFill: planOffsets', () => {
  const { planOffsets, PER_PAGE } = require('../src/searchFill');
  it('never refetches page one (offset 0)', () => {
    assert.deepEqual(planOffsets(0, 25), [10, 20, 30]);
    assert.deepEqual(planOffsets(10, 25), [10, 20]);
  });
  it('starts at the first page we do not have', () => {
    assert.deepEqual(planOffsets(11, 50), [20, 30, 40, 50]);
    assert.deepEqual(planOffsets(30, 50), [30, 40]);
  });
  it('no pages when we already have enough', () => {
    assert.deepEqual(planOffsets(50, 50), []);
    assert.deepEqual(planOffsets(60, 50), []);
  });
  it('respects the fetch budget', () => {
    assert.equal(planOffsets(10, 100).length <= 6, true);
    assert.deepEqual(planOffsets(10, 100, { maxFetches: 2 }), [10, 20]);
  });
  it('a page is ten results', () => assert.equal(PER_PAGE, 10));
});

describe('searchFill: parsing', () => {
  const { parseDdgRows, formBody } = require('../src/searchFill');
  const html = `
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">First <b>result</b></a>
    <a class="result__snippet" href="#">A snippet that is definitely longer than forty characters for sure.</a>
    <a rel="nofollow" class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo">Second result</a>`;
  it('reads title + href + snippet out of DDG markup', () => {
    const rows = parseDdgRows(html);
    assert.equal(rows.length, 2);
    assert.match(rows[0].href, /example\.com%2Fone|example.com%2Fone/);
    assert.equal(rows[0].title, 'First result');
    assert.ok(rows[0].snippet.includes('snippet'));
  });
  it('survives empty/garbage html', () => {
    assert.deepEqual(parseDdgRows(''), []);
    assert.deepEqual(parseDdgRows('<div>nothing here</div>'), []);
  });
  it('form body carries the offset DDG actually honours (POST, not GET)', () => {
    assert.equal(formBody('cats', 20), 'q=cats&s=20&kl=wt-wt&df=');
  });
});

describe('searchFill: fillResults', () => {
  const { fillResults } = require('../src/searchFill');
  const page = (host, n, from = 0) => {
    let h = '';
    for (let i = from; i < from + n; i++) {
      h += `<a class="result__a" href="https://${host}/p${i}">${host} page ${i}</a>`;
    }
    return h;
  };
  it('pages past 10, dedupes, and reports completion', async () => {
    const fetchFn = async (url, opts) => {
      const offset = Number(String(opts.body).match(/s=(\d+)/)[1]);
      return { ok: true, text: async () => page(`site${offset}`, 10, offset) };
    };
    const seen = new Set(Array.from({ length: 10 }, (_, i) => `https://site0/p${i}`));
    const r = await fillResults('q', { have: 10, want: 30, seen, fetchFn });
    assert.equal(r.rows.length, 20);
    assert.equal(r.done, true);
    assert.ok(r.rows.every((x) => !x.url.startsWith('https://site0/')));
  });
  it('falls back to query VARIATIONS when pagination repeats itself', async () => {
    // Page 2+ returns page 1 again (what DDG does when it runs out), so
    // dedupe yields nothing and the variation path takes over.
    const fetchFn = async (url, opts) => {
      const body = String(opts.body);
      const q = decodeURIComponent((body.match(/q=([^&]*)/) || [])[1] || '');
      if (q === 'q') return { ok: true, text: async () => page('same', 10, 0) };
      return { ok: true, text: async () => page(`v${q.slice(0, 3).replace(/\W/g, '')}`, 5) };
    };
    const seen = new Set(Array.from({ length: 10 }, (_, i) => `https://same/p${i}`));
    const r = await fillResults('q', { have: 10, want: 25, seen, fetchFn, maxFetches: 5 });
    assert.ok(r.rows.length > 0, 'variation queries contributed links');
    assert.ok(r.rows.every((x) => !x.url.includes('/same/')), 'every added row is a different page');
  });
  it('stops quietly on network failure', async () => {
    const fetchFn = async () => { throw new Error('offline'); };
    const r = await fillResults('q', { have: 10, want: 50, seen: new Set(), fetchFn });
    assert.deepEqual(r.rows, []);
  });
  it('an empty query is a no-op (no network at all)', async () => {
    let calls = 0;
    const r = await fillResults('', { fetchFn: async () => { calls++; return { ok: true, text: async () => '' }; } });
    assert.deepEqual(r.rows, []);
    assert.equal(r.done, true);
    assert.equal(calls, 0, 'no fetch for a blank query');
  });
});

describe('searchFill: queryVariants', () => {
  const { queryVariants } = require('../src/searchFill');
  it('uses autocomplete phrases, never the query itself', async () => {
    const fetchFn = async () => ({ ok: true, json: async () => [{ phrase: 'node tui browser' }, { phrase: 'tui browser config' }] });
    const out = await queryVariants('tui browser', { fetchFn });
    assert.ok(out.includes('node tui browser'));
    assert.ok(!out.includes('tui browser'), 'the original query is not a variation');
  });
  it('falls back to year/review when autocomplete is empty', async () => {
    const fetchFn = async () => ({ ok: true, json: async () => [] });
    const year = String(new Date().getFullYear());
    const out = await queryVariants('chawan', { fetchFn });
    assert.ok(out.includes(`chawan ${year}`));
    assert.ok(out.includes('chawan review'));
  });
  it('never throws on a dead network', async () => {
    const out = await queryVariants('x', { fetchFn: async () => { throw new Error('offline'); } });
    assert.ok(Array.isArray(out) && out.length > 0, 'deterministic fallbacks still arrive');
  });
  it('empty query yields nothing', async () => {
    assert.deepEqual(await queryVariants(''), []);
  });
});

describe('browser: error text never says [object Object]', () => {
  const { errText } = require('../src/browser');
  it('unwraps every shape a rejection can take', () => {
    assert.equal(errText(new Error('boom')), 'boom');
    assert.equal(errText('plain string'), 'plain string');
    assert.equal(errText({ message: 'has message' }), 'has message');
    assert.equal(errText({ error: 'nested string' }), 'nested string');
    assert.equal(errText({ error: { message: 'deep message' } }), 'deep message');
  });
  it('summarises a fieldless object instead of printing [object Object]', () => {
    const out = errText({ ok: false, rows: 3, why: 'nothing found' });
    assert.ok(!out.includes('[object'), out);
    assert.ok(out.includes('why: nothing found'), out);
  });
  it('falls back with a real sentence, never the literal', () => {
    assert.equal(errText(null), 'unknown error');
    assert.equal(errText(undefined, 'fallback used'), 'fallback used');
    assert.equal(errText({}), 'unknown error');
    assert.ok(!errText({}).includes('['));
  });
  it('strips Playwright ANSI call-log codes from the message', () => {
    // Real shape from the first-search failure: the call log embeds dim codes.
    const msg = 'page.goto: net::ERR_ABORTED at https://example.com/page\n'
      + 'Call log:\n\u001b[2m - navigating to "https://example.com/page", waiting until "domcontentloaded"\u001b[22m';
    const out = errText(new Error(msg));
    assert.ok(!out.includes('\u001b'), out);
    assert.ok(out.startsWith('page.goto: net::ERR_ABORTED'), out);
    assert.ok(out.includes('waiting until "domcontentloaded"'), out);
  });
});

describe('browser: one-tab budget (RAM guard)', () => {
  const { Browser } = require('../src/browser');
  const mk = () => new Browser({ profileDir: '/tmp/opencode/tui-test-none' });
  it('closes every page that is not the main one', () => {
    const b = mk();
    let closed = 0;
    b.page = { close: async () => { closed += 1; } };
    b.context = { pages: () => [b.page, { close: async () => { closed += 1; } }, { close: async () => { closed += 1; } }] };
    assert.equal(b.enforcePageBudget(), 2);
  });
  it('is a no-op without a context, and never throws on a broken one', () => {
    const b = mk();
    assert.equal(b.enforcePageBudget(), 0);
    b.context = { pages: () => { throw new Error('gone'); } };
    assert.equal(b.enforcePageBudget(), 0);
  });
  it('never closes the main page', async () => {
    const b = mk();
    let mainClosed = false;
    b.page = { close: async () => { mainClosed = true; } };
    b.context = { pages: () => [b.page] };
    b.enforcePageBudget();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(mainClosed, false);
  });
});

// ============================================================
// blocklist.js — video is never fetched, trackers never fetched
// ============================================================
describe('blocklist: media', () => {
  const { isMediaUrl } = require('../src/blocklist');
  it('blocks video and audio by extension', () => {
    for (const u of [
      'https://cdn.site/a.mp4',
      'https://cdn.site/a.webm?token=1',
      'https://cdn.site/a.m3u8',
      'https://cdn.site/a.mp4#t=10',
    ]) assert.equal(isMediaUrl(u), true, u);
  });
  it('blocks by mime query hint', () => {
    assert.equal(isMediaUrl('https://cdn.site/stream?mime=video/mp4'), true);
  });
  it('never blocks an HTML page', () => {
    for (const u of ['https://example.com/a', 'https://example.com/a.html', 'https://example.com/a.mp4.html']) {
      assert.equal(isMediaUrl(u), false, u);
    }
  });
});

describe('blocklist: trackers', () => {
  const { isTrackerUrl, TRACKER_PATH } = require('../src/blocklist');
  it('blocks ad/analytics hosts and their subdomains', () => {
    for (const u of [
      'https://doubleclick.net/pixel',
      'https://www.google-analytics.com/collect',
      'https://stats.g.doubleclick.net/x',
      'https://connect.facebook.net/en_US/sdk.js',
    ]) assert.equal(isTrackerUrl(u), true, u);
  });
  it('blocks first-party beacon paths but never the page API', () => {
    assert.equal(isTrackerUrl('https://en.wikipedia.org/w/api.php?action=jsedit'), false, 'page API stays');
    assert.equal(isTrackerUrl('https://en.wikipedia.org/beacon/mw-static/abc'), true);
    assert.equal(isTrackerUrl('https://site.com/analytics.js'), true);
    assert.ok(TRACKER_PATH instanceof RegExp);
  });
  it('never blocks ordinary content', () => {
    for (const u of [
      'https://en.wikipedia.org/wiki/Bliss_(program)',
      'https://github.com/nodejs/node',
      'https://cdn.site/lib.js',
      'https://blog.rust-lang.org/2024/09/05/Rust-1.81.0.html',
    ]) assert.equal(isTrackerUrl(u), false, u);
  });
  it('fails open on unparseable urls', () => {
    assert.equal(isTrackerUrl('not a url'), false);
    assert.equal(isTrackerUrl(''), false);
  });
});

// ============================================================
// readability.js — the pure helpers around the vendored engine
// ============================================================
describe('readability: helpers', () => {
  const { readingTime, promoteLeadHeading, heroFrom, heroCandidates, readabilityBundle } = require('../src/readability');
  it('ships the vendored bundle (Firefox Reader View engine)', () => {
    const src = readabilityBundle();
    assert.ok(src.length > 1000, 'bundle is readable');
    assert.ok(src.includes('Readability'));
  });
  it('reading time rounds up, never returns 0 for text', () => {
    assert.equal(readingTime(''), 0);
    assert.equal(readingTime('one two three'), 1);
    assert.equal(readingTime(Array.from({ length: 600 }, () => 'word').join(' ')), 3);
  });
  it('promotes a lead h2 when readability swallowed the h1', () => {
    const out = promoteLeadHeading('<div><h2>Getting started</h2><p>text</p></div>');
    assert.ok(out.includes('<h1>Getting started</h1>'));
  });
  it('leaves an article that already has an h1 alone', () => {
    const html = '<h1>Title</h1><h2>Section</h2>';
    assert.equal(promoteLeadHeading(html), html);
  });
  it('skips an over-long lead heading (it is prose, not a title)', () => {
    const long = `<h2>${'x'.repeat(200)}</h2>`;
    assert.equal(promoteLeadHeading(long), long);
  });
  it('prefers real photos over decorative logos', () => {
    const meta = { 'og:image': 'https://site.com/static/images/footer/wikimedia-button.svg' };
    const imgs = [{ src: 'https://site.com/content/photo.jpg' }];
    assert.equal(heroFrom(meta, imgs)[0], 'https://site.com/content/photo.jpg');
  });
  it('no hero when the only art is decorative — but the gallery still gets it', () => {
    const meta = { 'og:image': 'https://site.com/logo.svg' };
    assert.deepEqual(heroFrom(meta, []), []);
    assert.deepEqual(heroCandidates(meta, []), ['https://site.com/logo.svg']);
  });
  it('ignores non-http candidates and duplicates', () => {
    assert.deepEqual(heroFrom({ 'og:image': 'data:image/png;base64,AAA' }, []), []);
    assert.equal(heroFrom({ 'og:image': 'https://a.com/x.png' }, [{ src: 'https://a.com/x.png' }]).length, 1);
  });
});

// ============================================================
// openrouter.js — /ai's transport: prompt style + free models
// ============================================================
describe('openrouter: prompt style', () => {
  const { buildPrompt, buildMessages, STYLE, ANSWER_STYLE, DEFAULT_MODEL, FREE_MODELS } = require('../src/openrouter');
  it('asks for bullets and bans markdown links', () => {
    const p = buildPrompt('summarise', 'Some page text that is definitely here.');
    assert.ok(p.includes('Some page text'));
    assert.ok(p.includes('- '), 'bullet contract');
    assert.ok(/no markdown links/i.test(p));
    assert.ok(/This website states/.test(STYLE), 'narrates what the page says');
  });
  it('answers standalone when no page is open', () => {
    const p = buildPrompt('why is the sky blue?', '');
    assert.ok(p.includes('why is the sky blue?'));
    assert.ok(p.includes(STYLE));
  });
  it('every curated model is a :free id with an attribution label', () => {
    assert.ok(FREE_MODELS.length >= 3, 'a real list for /settings to cycle');
    for (const m of FREE_MODELS) {
      assert.match(m.id, /:free$/, `${m.id} must be a :free model`);
      assert.ok(m.label && m.label.length, `${m.id} needs a label`);
    }
    assert.ok(FREE_MODELS.some((m) => m.id === DEFAULT_MODEL), 'the default is curated');
  });
  it('omitted style is the page STYLE prompt', () => {
    const p = buildPrompt('why is the sky blue?', 'Some page text.');
    assert.ok(p.includes(STYLE));
    assert.ok(!p.includes('terminal reader'), 'no answer-style leak into page asks');
  });
  it('ANSWER_STYLE asks for a full terminal-shaped answer', () => {
    const p = buildPrompt('what is godot?', '', ANSWER_STYLE);
    assert.ok(p.includes('what is godot?'));
    assert.ok(p.includes('### SECTION HEADINGS'), 'sections allowed');
    assert.ok(!p.includes(STYLE), 'page-bullet contract not mixed in');
    assert.ok(p.includes('GO DEEP'), 'deep answer mandated');
    assert.ok(p.includes('SUB-BULLETS'), 'sub-bullets allowed');
    const c = buildMessages('what is godot?', '', [], ANSWER_STYLE);
    assert.ok(String(c[c.length - 1].content).includes('### SECTION HEADINGS'));
  });
  it('history turns become user/assistant messages; only the newest carries the page', () => {
    const c = buildMessages('and why?', '', [{ q: 'why is the sky blue?', a: 'Rayleigh scattering.' }], STYLE);
    assert.equal(c[0].role, 'system', 'environment preamble first');
    assert.equal(c[1].role, 'user');
    assert.equal(c[2].role, 'assistant');
    assert.equal(c[2].content, 'Rayleigh scattering.');
    assert.equal(c[3].role, 'user');
    const withCtx = buildMessages('q2', 'PAGE-TEXT-MARKER', [{ q: 'q1', a: 'a1' }], STYLE);
    assert.ok(!withCtx[withCtx.length - 1].content.includes('PAGE-TEXT-MARKER'), 'old turns carry no context');
    const fresh = buildMessages('q2', 'PAGE-TEXT-MARKER', [], STYLE);
    assert.ok(fresh[fresh.length - 1].content.includes('PAGE-TEXT-MARKER'), 'the first turn keeps the page');
  });
  it('modelLabel is the attribution name ("— by nemotron 120b")', () => {
    const { modelLabel } = require('../src/openrouter');
    assert.equal(modelLabel('nvidia/nemotron-3-super-120b-a12b:free'), 'nemotron 120b');
    assert.equal(modelLabel(''), 'nemotron 120b', 'empty falls back to the default label');
    assert.equal(modelLabel(null), 'nemotron 120b');
    assert.equal(modelLabel('acme/foo-bar-9b:free'), 'foo bar 9b', 'custom ids derive a tidy label');
  });
});

describe('openrouter: askAi errors name the exact problem', () => {
  const { askAi } = require('../src/openrouter');
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const okBody = (text, model) => ({ ok: true, status: 200, json: async () => ({ model, choices: [{ message: { role: 'assistant', content: text } }] }) });
  const errBody = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) });
  it('a real answer comes back with the model that produced it', async () => {
    global.fetch = async () => okBody('Godot is an engine.', 'nvidia/nemotron-3-super-120b-a12b:free');
    const r = await askAi('what is godot?', { apiKey: 'sk-or-fake-test-key-000' });
    assert.equal(r.ok, true);
    assert.equal(r.text, 'Godot is an engine.');
    assert.equal(r.model, 'nvidia/nemotron-3-super-120b-a12b:free');
  });
  it('sends the model, the bearer key, and hits the chat completions endpoint', async () => {
    let seenUrl = '';
    let seenOpts = null;
    global.fetch = async (url, opts) => { seenUrl = String(url); seenOpts = opts; return okBody('ok', 'acme/foo-bar-9b:free'); };
    await askAi('q', { apiKey: 'sk-or-fake-test-key-000', model: 'acme/foo-bar-9b:free' });
    assert.equal(seenUrl, 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(seenOpts.body);
    assert.equal(body.model, 'acme/foo-bar-9b:free', 'the chosen model travels');
    assert.equal(body.messages[body.messages.length - 1].role, 'user');
    assert.match(seenOpts.headers.Authorization, /^Bearer sk-or-fake-test-key-000$/);
  });
  it('no key at all → setup instructions, zero network', async () => {
    let called = 0;
    global.fetch = async () => { called++; return okBody('x'); };
    const r = await askAi('hi?', { apiKey: '' });
    assert.equal(r.ok, false);
    assert.match(r.error, /openrouter\.ai\/keys/, 'points at the real key source');
    assert.match(r.error, /ai-key/, 'says how to save it');
    assert.equal(called, 0);
  });
  it('429 names the free-tier throttle and the model picker', async () => {
    global.fetch = async () => errBody(429, 'Rate limit exceeded');
    const r = await askAi('hi?', { apiKey: 'sk-or-fake-test-key-000' });
    assert.equal(r.ok, false);
    assert.match(r.error, /rate-limiting/);
    assert.match(r.error, /settings/);
  });
  it('401/403 name a refused key and where to fix it', async () => {
    global.fetch = async () => errBody(401, 'No auth credentials found');
    const r = await askAi('hi?', { apiKey: 'sk-or-fake-test-key-000' });
    assert.match(r.error, /refused the key/);
    assert.match(r.error, /ai-key/);
  });
  it('404 says the model is unavailable and to pick another', async () => {
    global.fetch = async () => errBody(404, 'No endpoints found');
    const r = await askAi('hi?', { apiKey: 'sk-or-fake-test-key-000' });
    assert.match(r.error, /unavailable on OpenRouter/);
    assert.match(r.error, /Pick another in \/settings/);
  });
  it('402 explains credits vs free models', async () => {
    global.fetch = async () => errBody(402, 'Insufficient credits');
    const r = await askAi('hi?', { apiKey: 'sk-or-fake-test-key-000' });
    assert.match(r.error, /out of credits/);
  });
  it('500/503 say outage', async () => {
    global.fetch = async () => errBody(503, 'backend oops');
    const r = await askAi('hi?', { apiKey: 'sk-or-fake-test-key-000' });
    assert.match(r.error, /outage/);
  });
  it('an empty answer is an honest error, not an empty box', async () => {
    global.fetch = async () => okBody('   ', 'x/y:free');
    const r = await askAi('hi?', { apiKey: 'sk-or-fake-test-key-000' });
    assert.equal(r.ok, false);
    assert.match(r.error, /empty response/);
  });
  it('abort says timed out with seconds', async () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    global.fetch = async () => { throw e; };
    const r = await askAi('hi?', { apiKey: 'sk-or-fake-test-key-000', timeoutMs: 15000 });
    assert.match(r.error, /timed out after 15s/);
  });
});

// ============================================================
// ai.js — bullets, and never a raw URL in the digest
// ============================================================
describe('ai: digest bullets', () => {
  const { summarizeResults, bulletize } = require('../src/ai');
  const results = [
    { title: 'Terminal browsers in 2026', snippet: 'Terminal browsers now render images inline and block trackers by default for less memory use.' },
    { title: 'Why text browsers matter', snippet: 'Text browsers are fast on slow links and never download video bytes into memory at all.' },
    { title: 'Notes on reading mode', snippet: 'Reader mode strips navigation chrome so the article itself is what you actually read.' },
  ];
  it('renders as bullet points', () => {
    const out = summarizeResults(results);
    assert.ok(out.startsWith('The results say:'));
    assert.ok(out.includes('• '));
    assert.ok(out.split('\n').length >= 2);
  });
  it('never leaks markdown links or raw URLs into the bar', () => {
    const out = bulletize('See [the docs](https://example.com/docs) and https://raw.example.com/page for more.');
    assert.ok(!out.includes('https://'), out);
    assert.ok(out.includes('the docs'), out);
  });
  it('a single result yields no digest rather than a fake answer', () => {
    assert.equal(summarizeResults([{ title: 'one', snippet: 'too short' }]), '');
  });
});

// ============================================================
// ai.js — question-shaped queries trigger real answers
// ============================================================
describe('ai: looksLikeQuestion', () => {
  const { looksLikeQuestion } = require('../src/ai');
  it('fires on questions', () => {
    for (const q of [
      'what is godot', 'what is godot?', 'why is the sky blue',
      'is github down', 'how do I cook rice?', 'who won the match',
      'explain photosynthesis', 'tell me about godot', 'how',
      'difference between cats and dogs', '¿qué es godot?',
    ]) {
      assert.equal(looksLikeQuestion(q), true, `should fire: ${JSON.stringify(q)}`);
    }
  });
  it('stays quiet on navigation/keywords/operators', () => {
    for (const q of [
      '', '   ', 'godot engine tutorial', 'weather tokyo', 'github',
      'example.com', 'example.com/docs/install', 'cat site:github.com',
      'filetype:pdf godot manual', 'x'.repeat(200),
    ]) {
      assert.equal(looksLikeQuestion(q), false, `should not fire: ${JSON.stringify(q).slice(0, 60)}`);
    }
  });
  it('never throws on junk', () => {
    assert.equal(looksLikeQuestion(null), false);
    assert.equal(looksLikeQuestion(undefined), false);
    assert.equal(looksLikeQuestion(42), false);
  });
});

// ============================================================
// pretty.js — accessibility chrome never opens an article
// ============================================================
describe('pretty: chrome lines dropped', () => {
  const { renderHtmlText, isChromeLine } = require('../src/pretty');
  it('recognises skip links', () => {
    for (const l of ['Jump to content [https://a.com]', 'Skip to navigation [https://a.com]', 'Back to top [https://a.com]']) {
      assert.equal(isChromeLine(l), true, l);
    }
    assert.equal(isChromeLine('Jump to conclusions requires evidence [https://a.com]'), false);
    assert.equal(isChromeLine('The team jumped to a conclusion.'), false);
  });
  it('strips them from the rendered article', () => {
    const html = '<div><a href="#content">Jump to content</a><p>The real first paragraph of this article.</p></div>';
    const out = renderHtmlText(html);
    assert.ok(!/Jump to content/.test(out), out);
    assert.ok(out.includes('real first paragraph'));
  });
});

// ============================================================
// ui loader frame + answer tidy (pure; no screen needed)
// ============================================================
describe('ui: the loading wave', () => {
  const { waveFrame, waveFrames, WAVE_FRAMES, WAVE_MS, WAVE_MOTIF, WAVE_CYCLE } = require('../src/ui');
  it('uses the designed frame set (20 frames per loop)', () => {
    assert.equal(WAVE_FRAMES, 20);
    assert.equal(WAVE_MOTIF.length, 20);
    assert.equal([...WAVE_CYCLE].length, 20);
  });
  it('reproduces the artwork it was designed from', () => {
    // The user's 20-cell cycle, verbatim: 7 up, 3 high ███, 7 down,
    // 3 low ▁▁▁ — frame n is the nth left-rotation.
    assert.equal(waveFrame(0), '▁▂▃▄▅▆▇███▇▆▅▄▃▂▂▁▁▁', 'frame 1');
    assert.equal(waveFrame(1), '▂▃▄▅▆▇███▇▆▅▄▃▂▂▁▁▁▁', 'frame 2');
    assert.equal(waveFrame(2), '▃▄▅▆▇███▇▆▅▄▃▂▂▁▁▁▁▂', 'frame 3');
  });
  it('the loop closes exactly (frame 20 hands back to frame 0)', () => {
    assert.equal(waveFrame(20), waveFrame(0));
    assert.equal(waveFrame(41), waveFrame(1));
    assert.equal(waveFrame(-1), waveFrame(19));
  });
  it('tiles edge-to-edge at any requested width, no spaces', () => {
    for (const w of [5, 20, 40, 77, 80, 200]) {
      for (let i = 0; i < WAVE_FRAMES; i++) {
        const f = waveFrame(i, w);
        assert.equal([...f].length, w, `frame ${i} at width ${w}`);
        assert.ok(!f.includes(' '), `no gaps at width ${w}`);
      }
    }
    assert.equal(waveFrame(0, 0).length, 20, 'no width = the 20-cell cycle');
  });
  it('only ramp characters (renders in any terminal)', () => {
    for (const ch of waveFrame(3, 60)) {
      assert.ok('▁▂▃▄▅▆▇█'.includes(ch), `unexpected glyph U+${ch.codePointAt(0).toString(16)}`);
    }
  });
  it('travels: the loop closes cleanly instead of jumping', () => {
    const t = waveFrames();
    assert.equal(t.length, WAVE_FRAMES);
    assert.notEqual(t[1], t[0], 'each frame is a step further along');
    // Including the seam (last -> first): a rotation moves every column by
    // exactly one level, so the diff is large but UNIFORM — the old
    // non-periodic motif snapped copies against each other instead.
    let seamDiff = 0;
    const a = t[t.length - 1];
    const b = t[0];
    for (let x = 0; x < a.length; x++) if (a[x] !== b[x]) seamDiff++;
    assert.ok(seamDiff > 0, 'seam advances, not a duplicate frame');
  });
  it('ticks at a calm human speed', () => {
    assert.ok(WAVE_MS >= 40 && WAVE_MS <= 120, `${WAVE_MS}ms per frame`);
  });
  it('survives junk input', () => {
    assert.doesNotThrow(() => waveFrame(NaN, 0));
    assert.doesNotThrow(() => waveFrame(undefined, -5));
    assert.doesNotThrow(() => waveFrames('abc'));
  });
  it('the timer only steps the frame table (no missing symbols)', () => {
    // A missing constant here crashed the running app on every tick.
    const src = require('fs').readFileSync(require.resolve('../src/ui'), 'utf8');
    const tick = src.slice(src.indexOf('loader.timer = setInterval'), src.indexOf('WAVE_TICK_MS);'));
    assert.ok(tick.includes('loader.frame'), 'the tick advances the frame index');
    assert.ok(!/WAVE_STEP|WAVE_PHASE/.test(tick), 'the tick references nothing undefined');
  });
});

describe('ui: loader frame shape', () => {
  const { loaderFrame, waveFrame } = require('../src/ui');
  const { visLen } = require('../src/beautify');
  it('has a status line and a full-width wave line (footer slot)', () => {
    const art = loaderFrame(2, 'Loading video', 'resolving stream', 40);
    const lines = art.split('\n');
    assert.equal(lines.length, 2, 'status / wave, got: ' + JSON.stringify(art));
    assert.ok(lines[0].includes('Loading video'));
    // The wave is the one and only loading animation: no braille spinner
    // anywhere in the loader frame.
    assert.ok(!/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(art), 'no braille spinner in loader frame');
    assert.ok(lines[0].includes('resolving stream'), 'stage shares the status line');
    // The wave line is the full width, edge-to-edge, no spaces.
    const bar = lines[1];
    assert.equal([...bar].length, 40, 'wave spans the whole width');
    assert.ok(!bar.includes(' '), 'no gaps in the wave');
    assert.ok(bar.includes('▃'), 'frame 2 starts at ▃');
    assert.equal(bar, waveFrame(2, 40));
    // Theme color uses blessed's -fg tag form (bare {#hex} tags emit a
    // junk SGR and render uncolored — the old "themes look the same" bug).
    assert.ok(art.includes('-fg}'), 'content color tags carry -fg');
    assert.ok(!art.includes('@ACCENT@'));
    assert.ok(!art.includes('undefined'));
  });
  it('animates across frames and never exceeds the width', () => {
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const art = loaderFrame(i, 'x', 'y', 30);
      seen.add(art);
      for (const line of art.split('\n')) {
        assert.ok(visLen(line) <= 30, `line too wide: ${line}`);
      }
    }
    assert.ok(seen.size > 1, 'frames actually change');
  });
  it('survives junk input', () => {
    assert.doesNotThrow(() => loaderFrame(0, '', '', 0));
    assert.doesNotThrow(() => loaderFrame(-5, null, undefined, NaN));
  });
});

describe('ui: answers are tidy (no ugly [links])', () => {
  const { tidyAnswer } = require('../src/ui');
  it('collapses markdown links to their label and drops raw URLs', () => {
    const out = tidyAnswer('Read [the docs](https://example.com/a) or https://example.com/b today.');
    assert.ok(!out.includes('https://'), out);
    assert.ok(out.includes('the docs'));
  });
  it('normalises every bullet marker to •', () => {
    assert.equal(tidyAnswer('- one\n* two\n• three'), '• one\n• two\n• three');
  });
  it('never turns a mid-sentence dash into a bullet', () => {
    assert.equal(tidyAnswer('well-known - not a bullet'), 'well-known - not a bullet');
  });
  it('collapses blank runs and trailing space', () => {
    assert.equal(tidyAnswer('a   \n\n\n\nb'), 'a\n\nb');
  });
  it('handles empty input', () => {
    assert.equal(tidyAnswer(''), '');
    assert.equal(tidyAnswer(null), '');
  });
});