'use strict';

// Regression pin for the lazy-Playwright launch path (src/browser.js).
// History: the speed pack turned `const { chromium } = require('playwright')`
// into a lazy accessor but one line kept the bare `chromium` identifier, so
// EVERY real navigation threw "chromium is not defined". These tests inject
// a fake playwright through require.cache and drive the REAL _launch() so a
// bare-identifier regression fails here instead of in the user's terminal.
// The fake context/page are proxies: unknown members resolve to async
// no-ops, so post-launch setup steps stay harmless and in-process.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpProfile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tui-launch-'));
}

function proxyObj(overrides) {
  return new Proxy(overrides || {}, {
    get(t, p) {
      // Never look thenable (a fake `then` would hang every await) and
      // leave symbols (toStringTag etc.) to normal JS semantics.
      if (typeof p === 'symbol' || p === 'then') return t[p];
      if (p in t) return t[p];
      return async () => {};
    },
  });
}

function makeFakes() {
  const captured = [];
  const page = proxyObj({});
  const ctx = proxyObj({
    pages: () => [page],
    newPage: async () => page,
  });
  const fakePw = {
    chromium: {
      launchPersistentContext: async (dir, opts) => {
        captured.push({ driver: 'chromium', dir, opts });
        return ctx;
      },
    },
    firefox: {
      launchPersistentContext: async (dir, opts) => {
        captured.push({ driver: 'firefox', dir, opts });
        return ctx;
      },
    },
  };
  return { captured, fakePw };
}

async function withFakePlaywright(run) {
  const pwPath = require.resolve('playwright');
  const bPath = require.resolve('../src/browser.js');
  const hadPw = require.cache[pwPath];
  const hadB = require.cache[bPath];
  const { captured, fakePw } = makeFakes();
  require.cache[pwPath] = { id: pwPath, filename: pwPath, loaded: true, exports: fakePw };
  delete require.cache[bPath];
  try {
    const { Browser } = require('../src/browser.js');
    await run({ Browser, captured });
  } finally {
    if (hadPw) require.cache[pwPath] = hadPw;
    else delete require.cache[pwPath];
    if (hadB) require.cache[bPath] = hadB;
    else delete require.cache[bPath];
  }
}

describe('browser: lazy playwright launch path', () => {
  it('chrome engine launches via pw.chromium with channel+privacy args (no bare identifiers)', async () => {
    await withFakePlaywright(async ({ Browser, captured }) => {
      const b = new Browser({ headless: true, profileDir: tmpProfile() });
      let err = null;
      try {
        await b._launch();
      } catch (e) {
        // A missing page method on the proxy would be our fake's fault, not
        // the app's — but the bare-identifier ReferenceError must NOT appear.
        err = e;
      }
      assert.ok(
        !/is not defined/.test(String((err && err.message) || '')),
        `bare identifier crash: ${err && err.message}`
      );
      assert.equal(captured.length, 1, 'one launch call');
      assert.equal(captured[0].driver, 'chromium', 'lazy handle used for chromium');
      assert.equal(captured[0].opts.channel, 'chrome', 'installed Chrome channel');
      assert.deepEqual(captured[0].opts.args, ['--webrtc-ip-handling-policy=default_public_interface_only']);
      assert.equal(captured[0].opts.headless, true);
    });
  });

  it('firefox engine launches via pw.firefox, no chrome channel', async () => {
    await withFakePlaywright(async ({ Browser, captured }) => {
      const b = new Browser({ engine: 'firefox', headless: true, profileDir: tmpProfile() });
      let err = null;
      try {
        await b._launch();
      } catch (e) {
        err = e;
      }
      assert.ok(!/is not defined/.test(String((err && err.message) || '')), `bare identifier crash: ${err && err.message}`);
      assert.equal(captured.length, 1);
      assert.equal(captured[0].driver, 'firefox', 'lazy handle used for firefox');
      assert.ok(!('channel' in captured[0].opts), 'firefox never gets the chrome channel');
      assert.ok(!captured[0].opts.args, 'firefox never gets chromium launch args');
    });
  });

  it('missing Chrome errors map to the install hint, not a raw channel dump', async () => {
    await withFakePlaywright(async ({ Browser, captured }) => {
      const pwPath = require.resolve('playwright');
      // Swap the fake to one that rejects like a channel-less machine.
      require.cache[pwPath].exports.chromium.launchPersistentContext = async () => {
        throw new Error('browserType.launchPersistentContext: Executable doesn\'t exist at /usr/bin/google-chrome');
      };
      const b = new Browser({ headless: true, profileDir: tmpProfile() });
      await assert.rejects(() => b._launch(), /Google Chrome is not installed/);
    });
  });
});

// The first navigation after a browser launch runs against cold Chrome
// (renderer spawn, DNS/TLS warmup, empty cache) and gets a wider goto
// budget; a DOMContentLoaded timeout on a page whose document DID arrive
// is a degraded load, not an error. Only a navigation that never commits
// is a real failure. Regression pin for the user's "first search" timeout.
function makeNavFakes(plan) {
  const gotoCalls = [];
  const queue = plan.slice();
  const page = proxyObj({
    url: () => 'https://duckduckgo.com/?q=pizza',
    isClosed: () => false,
    goto: async (url, opts) => {
      gotoCalls.push({ url, opts });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(url, opts);
      return null;
    },
  });
  const ctx = proxyObj({ pages: () => [page], newPage: async () => page });
  const fakePw = {
    chromium: { launchPersistentContext: async () => ctx },
    firefox: { launchPersistentContext: async () => ctx },
  };
  return { gotoCalls, fakePw };
}

async function withNavFakes(plan, run) {
  const pwPath = require.resolve('playwright');
  const bPath = require.resolve('../src/browser.js');
  const hadPw = require.cache[pwPath];
  const hadB = require.cache[bPath];
  const { gotoCalls, fakePw } = makeNavFakes(plan);
  require.cache[pwPath] = { id: pwPath, filename: pwPath, loaded: true, exports: fakePw };
  delete require.cache[bPath];
  try {
    const { Browser } = require('../src/browser.js');
    await run({ Browser, gotoCalls });
  } finally {
    if (hadPw) require.cache[pwPath] = hadPw;
    else delete require.cache[pwPath];
    if (hadB) require.cache[bPath] = hadB;
    else delete require.cache[bPath];
  }
}

function navTimeout(msg) {
  const e = new Error(msg);
  e.name = 'TimeoutError';
  return e;
}

// Only the goto path is under test: extraction stubs keep the fake page's
// undefined evaluate results from mattering, and readMode 'raw' skips the
// readability round-trip.
function stubExtraction(b) {
  b.readMode = 'raw';
  b.extractPageLinks = async () => [];
  b.extractResults = async () => [];
  b.extractPageMedia = async () => ({ images: [] });
  b.extractAiAnswer = async () => null;
}

describe('browser: cold-start navigation resilience', () => {
  it('the first navigation after a launch gets the cold budget; the next is warm', async () => {
    await withNavFakes([], async ({ Browser, gotoCalls }) => {
      const b = new Browser({ headless: true, profileDir: tmpProfile() });
      stubExtraction(b);
      const r1 = await b.navigate('https://duckduckgo.com/?q=pizza');
      const r2 = await b.navigate('https://duckduckgo.com/?q=pasta');
      assert.ok(!/^Error:/.test(r1.text), `first nav resolved: ${r1.text}`);
      assert.ok(!/^Error:/.test(r2.text), `second nav resolved: ${r2.text}`);
      assert.equal(gotoCalls.length, 2, 'one goto per navigation');
      assert.equal(gotoCalls[0].opts.timeout, 20000, 'cold budget');
      assert.equal(gotoCalls[0].opts.waitUntil, 'domcontentloaded');
      assert.equal(gotoCalls[1].opts.timeout, 10000, 'warm budget');
    });
  });

  it('a committed-but-slow cold load degrades instead of erroring', async () => {
    const timeout = navTimeout(
      'page.goto: Timeout 20000ms exceeded. Call log: navigating to "https://duckduckgo.com/?q=pizza", waiting until "domcontentloaded"'
    );
    await withNavFakes([timeout], async ({ Browser, gotoCalls }) => {
      const b = new Browser({ headless: true, profileDir: tmpProfile() });
      stubExtraction(b);
      const res = await b.navigate('https://duckduckgo.com/?q=pizza');
      assert.equal(gotoCalls.length, 2, 'one commit-retry');
      assert.equal(gotoCalls[0].opts.timeout, 20000);
      assert.equal(gotoCalls[1].opts.waitUntil, 'commit', 'retry waits only for the commit');
      assert.equal(gotoCalls[1].opts.timeout, 8000);
      assert.ok(!/^Error:/.test(res.text), `no error surfaced: ${res.text}`);
    });
  });

  it('a load that never commits still surfaces the original timeout', async () => {
    const first = navTimeout(
      'page.goto: Timeout 20000ms exceeded. Call log: navigating to "https://duckduckgo.com/?q=pizza", waiting until "domcontentloaded"'
    );
    const second = navTimeout(
      'page.goto: Timeout 8000ms exceeded. Call log: navigating to "https://duckduckgo.com/?q=pizza", waiting until "commit"'
    );
    await withNavFakes([first, second], async ({ Browser, gotoCalls }) => {
      const b = new Browser({ headless: true, profileDir: tmpProfile() });
      stubExtraction(b);
      const res = await b.navigate('https://duckduckgo.com/?q=pizza');
      assert.equal(gotoCalls.length, 2);
      assert.ok(/^Error:/.test(res.text), 'error text returned');
      assert.ok(/Timeout 20000ms exceeded/.test(res.text), 'the ORIGINAL timeout is preserved');
      assert.equal(res.navError, true, 'failures are marked so the UI can classify them');
    });
  });

  it('YouTube keeps its own budget and never takes the commit retry', async () => {
    const timeout = navTimeout(
      'page.goto: Timeout 30000ms exceeded. Call log: navigating to "https://www.youtube.com/watch?v=abc123", waiting until "domcontentloaded"'
    );
    await withNavFakes([timeout], async ({ Browser, gotoCalls }) => {
      const b = new Browser({ headless: true, profileDir: tmpProfile() });
      stubExtraction(b);
      const res = await b.navigate('https://www.youtube.com/watch?v=abc123');
      assert.equal(gotoCalls.length, 1, 'no commit retry for YouTube');
      assert.equal(gotoCalls[0].opts.timeout, 30000);
      assert.ok(/^Error:/.test(res.text));
      assert.equal(res.navError, true, 'YouTube timeouts are marked too');
    });
  });
});
