'use strict';

// RSS 2.0 / Atom reading (src/feeds.js) for /feeds. The failure modes this
// pins: CDATA-wrapped titles and entity-encoded descriptions must render as
// human text, never raw markup; Atom's multi-<link> entries must pick the
// alternate rel; a feed without dates/descriptions must degrade quietly; a
// giant feed must be capped; a hung fetch must time out fast instead of
// wedging the picker; cache hits and expiry must be observable via the
// injected clock. No test touches the network.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { MAX_ITEMS, stripTags, decodeEntities, parseFeed, createFeedCache, fetchFeed } = require('../src/feeds');

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>Hacker News</title>
<item>
  <title>First &amp; Foremost</title>
  <link>https://example.com/1</link>
  <pubDate>Mon, 02 Feb 2026 10:00:00 GMT</pubDate>
  <description><![CDATA[<p>Hello <b>world</b> — stay a while</p>]]></description>
</item>
<item>
  <title><![CDATA[Naïve & Clean]]></title>
  <link>https://example.com/2</link>
  <description>Plain &amp; simple &#8212; done</description>
</item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
<entry>
  <title>Post One</title>
  <link rel="self" href="https://blog.example.com/feed"/>
  <link rel="alternate" href="https://blog.example.com/one"/>
  <updated>2026-02-03T08:00:00Z</updated>
  <summary>Short take</summary>
</entry>
<entry>
  <title>Post Two</title>
  <link href="https://blog.example.com/two"/>
  <published>2026-02-04T08:00:00Z</published>
</entry>
<entry>
  <title>Title Only</title>
</entry>
</feed>`;

function textResponse(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, text: async () => body };
}

describe('feeds: text helpers', () => {
  it('stripTags unwraps CDATA, drops script/style bodies, decodes entities', () => {
    assert.equal(stripTags('<![CDATA[<p>hi there</p>]]>'), 'hi there');
    assert.equal(stripTags('<script>alert(1)</script>ok'), 'ok');
    assert.equal(stripTags('<style>p{}</style>fine'), 'fine');
    assert.equal(stripTags('A &amp; B &#8212; C &#x27;D&#x27;'), "A & B — C 'D'");
    assert.equal(stripTags(null), '');
    assert.equal(stripTags(undefined), '');
  });

  it('decodeEntities handles named, decimal and hex; unknown pass through', () => {
    assert.equal(decodeEntities('&lt;a&gt; &quot;q&quot; &apos;s&apos;'), '<a> "q" \'s\'');
    assert.equal(decodeEntities('&#39;x&#39;'), "'x'");
    assert.equal(decodeEntities('&#x2F;'), '/');
    assert.equal(decodeEntities('&nosuch; &amp;'), '&nosuch; &');
  });
});

describe('feeds: parseFeed', () => {
  it('parses RSS: title, links, dates, CDATA + entity text', () => {
    const r = parseFeed(RSS);
    assert.equal(r.ok, true);
    assert.equal(r.title, 'Hacker News');
    assert.equal(r.items.length, 2);
    assert.deepEqual(r.items[0], {
      title: 'First & Foremost',
      link: 'https://example.com/1',
      date: '2026-02-02',
      summary: 'Hello world — stay a while',
    });
    assert.equal(r.items[1].title, 'Naïve & Clean');
    assert.equal(r.items[1].date, '');
    assert.equal(r.items[1].summary, 'Plain & simple — done');
  });

  it('parses Atom: alternate link wins, missing pieces degrade to empty strings', () => {
    const r = parseFeed(ATOM);
    assert.equal(r.ok, true);
    assert.equal(r.title, 'Blog');
    assert.equal(r.items.length, 3);
    assert.equal(r.items[0].link, 'https://blog.example.com/one', 'alternate rel wins over self');
    assert.equal(r.items[0].date, '2026-02-03');
    assert.equal(r.items[0].summary, 'Short take');
    assert.equal(r.items[1].link, 'https://blog.example.com/two');
    assert.equal(r.items[1].date, '2026-02-04');
    assert.equal(r.items[2].link, '', 'title-only entry keeps an empty link');
    assert.equal(r.items[2].summary, '');
  });

  it('caps giant feeds at MAX_ITEMS', () => {
    const many = `<rss><channel><title>Big</title>${Array.from({ length: 70 }, (_, i) => `<item><title>t${i}</title><link>https://x.example/${i}</link></item>`).join('')}</channel></rss>`;
    const r = parseFeed(many);
    assert.equal(r.ok, true);
    assert.equal(r.items.length, MAX_ITEMS);
    assert.equal(r.items[0].title, 't0');
  });

  it('rejects non-feeds and empties without throwing', () => {
    assert.equal(parseFeed('').ok, false);
    assert.equal(parseFeed('   ').ok, false);
    const html = parseFeed('<html><body><h1>Just a page</h1></body></html>');
    assert.equal(html.ok, false);
    assert.match(html.error, /not a feed/);
    assert.equal(parseFeed(null).ok, false);
    assert.equal(parseFeed(undefined).ok, false);
  });
});

describe('feeds: cache', () => {
  it('TTL expiry hides entries; oldest-first cap bounds the map', () => {
    let now = 1000;
    const c = createFeedCache({ ttlMs: 100, now: () => now });
    c.set('a', { items: [1] });
    assert.deepEqual(c.get('a'), { items: [1] });
    now += 101;
    assert.equal(c.get('a'), undefined, 'expired read evicts');
    for (let i = 0; i < 40; i++) c.set(`k${i}`, { items: [i] });
    assert.equal(c.get('k0'), undefined, 'oldest evicted past the cap');
    assert.ok(c.get('k39'), 'newest survives');
  });
});

describe('feeds: fetchFeed', () => {
  it('fetches with a UA header and parses; the result is cacheable', async () => {
    const calls = [];
    const cache = createFeedCache({ ttlMs: 60000 });
    const opts = {
      cache,
      fetchImpl: async (url, o) => {
        calls.push({ url, headers: o && o.headers });
        return textResponse(RSS);
      },
    };
    const r1 = await fetchFeed('https://example.com/rss', opts);
    assert.equal(r1.ok, true);
    assert.equal(r1.cached, false);
    assert.equal(r1.title, 'Hacker News');
    assert.equal(r1.items.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.com/rss');
    assert.ok(calls[0].headers['User-Agent'], 'UA header set (some feeds 403 without one)');
    const r2 = await fetchFeed('https://example.com/rss', opts);
    assert.equal(r2.ok, true);
    assert.equal(r2.cached, true);
    assert.equal(calls.length, 1, 'second read came from the cache');
    r2.items[0].title = 'mutated';
    const r3 = await fetchFeed('https://example.com/rss', opts);
    assert.equal(r3.items[0].title, 'First & Foremost', 'cache hands out copies');
  });

  it('settles fast on hung fetches and maps every failure to an error string', async () => {
    const t0 = Date.now();
    const hung = await fetchFeed('https://slow.example/rss', { fetchImpl: () => new Promise(() => {}), timeoutMs: 30 });
    assert.equal(hung.ok, false);
    assert.equal(hung.error, 'timed out');
    assert.ok(Date.now() - t0 < 1000, 'raced timeout, not the fetch');

    const bad = await fetchFeed('https://x.example/rss', { fetchImpl: async () => textResponse('<html>nope</html>') });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /not a feed/);

    const err404 = await fetchFeed('https://x.example/rss', { fetchImpl: async () => textResponse('', 404) });
    assert.equal(err404.ok, false);
    assert.equal(err404.error, 'HTTP 404');

    const thrown = await fetchFeed('https://x.example/rss', { fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
    assert.equal(thrown.ok, false);
    assert.match(thrown.error, /ENOTFOUND/);

    const noUrl = await fetchFeed('not a url', { fetchImpl: async () => textResponse(RSS) });
    assert.equal(noUrl.ok, false);
    assert.equal(noUrl.error, 'not a feed url');
  });
});
