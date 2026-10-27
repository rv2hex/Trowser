'use strict';
/* Unit tests for src/openrouter.js — the /ai transport. Zero network: HTTP
 * paths run through a stubbed global.fetch, key/config paths through a
 * throwaway XDG_CONFIG_HOME. */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const or = require('../src/openrouter');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'or-test-'));
}

describe('openrouter: key file', () => {
  it('saves 0600, reads back, masks, clears', () => {
    const d = tmpDir();
    const old = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = d;
    try {
      assert.equal(or.loadKey(), '');
      assert.equal(or.saveKey('sk-or-fake-test-key-000'), true);
      assert.equal(or.loadKey(), 'sk-or-fake-test-key-000');
      const kf = path.join(d, 'tui-browser', 'openrouter-key');
      assert.equal(fs.statSync(kf).mode & 0o777, 0o600, '0600 file mode');
      assert.equal(or.maskKey(or.loadKey()), '…-000 (set)');
      or.clearKey();
      assert.equal(or.loadKey(), '');
    } finally {
      if (old === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = old;
    }
  });
  it('resolveKey: explicit wins; explicit empty means no key; env next; file last', () => {
    const d = tmpDir();
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const oldEnv = process.env.OPENROUTER_API_KEY;
    process.env.XDG_CONFIG_HOME = d;
    delete process.env.OPENROUTER_API_KEY;
    try {
      assert.equal(or.resolveKey('sk-or-explicit'), 'sk-or-explicit');
      assert.equal(or.resolveKey(''), '', 'explicit empty never falls back');
      process.env.OPENROUTER_API_KEY = 'sk-or-env-key';
      assert.equal(or.resolveKey(), 'sk-or-env-key', 'env wins over file');
      delete process.env.OPENROUTER_API_KEY;
      or.saveKey('sk-or-file-key');
      assert.equal(or.resolveKey(), 'sk-or-file-key', 'file is the last resort');
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
      if (oldEnv === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = oldEnv;
    }
  });
  it('the setup text names the real key source, the saver, and the hub', () => {
    assert.match(or.AI_NO_KEY, /openrouter\.ai\/keys/);
    assert.match(or.AI_NO_KEY, /ai-key/);
    assert.match(or.AI_NO_KEY, /settings/);
  });
});

describe('openrouter: model pick (config-driven)', () => {
  it('resolveModel: explicit > saved config pick > default', () => {
    const d = tmpDir();
    const oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = d;
    try {
      assert.equal(or.resolveModel('acme/x:free'), 'acme/x:free');
      assert.equal(or.resolveModel(), or.DEFAULT_MODEL, 'no config → the default');
      fs.mkdirSync(path.join(d, 'tui-browser'), { recursive: true });
      fs.writeFileSync(path.join(d, 'tui-browser', 'config.json'), JSON.stringify({ aiModel: 'acme/foo-bar-9b:free' }));
      assert.equal(or.resolveModel(), 'acme/foo-bar-9b:free', 'the saved pick is read fresh');
      assert.equal(or.resolveModel('explicit/wins:free'), 'explicit/wins:free');
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
    }
  });
  it('only :free models are ever used — a paid id is ignored, never sent', () => {
    const d = tmpDir();
    const oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = d;
    try {
      assert.equal(or.isFreeModel('acme/x:free'), true);
      assert.equal(or.isFreeModel('acme/x:FREE'), true, 'case-insensitive suffix');
      assert.equal(or.isFreeModel('acme/x'), false);
      assert.equal(or.isFreeModel('acme/x:paid'), false);
      assert.equal(or.isFreeModel(''), false);
      assert.ok(or.FREE_MODELS.length > 0 && or.FREE_MODELS.every((m) => or.isFreeModel(m.id)), 'catalog is all :free');
      // Explicit paid id → the free default, never the paid model.
      assert.equal(or.resolveModel('openai/gpt-4o'), or.DEFAULT_MODEL);
      // A stale paid pick in config is ignored too.
      fs.mkdirSync(path.join(d, 'tui-browser'), { recursive: true });
      fs.writeFileSync(path.join(d, 'tui-browser', 'config.json'), JSON.stringify({ aiModel: 'anthropic/claude-3-opus' }));
      assert.equal(or.resolveModel(), or.DEFAULT_MODEL, 'paid config pick ignored');
      assert.equal(or.resolveModel('paid/model'), or.DEFAULT_MODEL, 'paid explicit falls back');
      assert.equal(or.resolveModel('acme/good:free'), 'acme/good:free', 'free explicit still wins');
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
    }
  });
});

// ---- askAi transport: streaming, timeouts, honest errors (no network) ----
function sseResponse(chunks, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    body: new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    }),
    text: async () => chunks.join(''),
    json: async () => { throw new Error('not json'); },
  };
}

describe('openrouter: askAi streaming transport', () => {
  // askAi reads the user's real config.json (the saved aiModel pick), so
  // the suite must pin XDG_CONFIG_HOME — a developer with a retired pick
  // on disk made these tests red, and a passing suite must not depend on
  // the box it runs on.
  let oldXdg;
  beforeEach(() => {
    oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpDir();
  });
  afterEach(() => {
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
  });
  it('timeout is generous enough for a real free-model answer', () => {
    // A measured ANSWER_STYLE reply took ~60s on nemotron 120b; the old 60s
    // cap cut answers off right as they finished.
    assert.ok(or.TIMEOUT_MS >= 180000, 'TIMEOUT_MS must leave real free-model latency room');
  });
  it('streams deltas into onDelta and returns the full text + model', async () => {
    const realFetch = global.fetch;
    let sent = null;
    global.fetch = async (url, opts) => {
      sent = JSON.parse(opts.body);
      return sseResponse([
        'data: {"model":"nvidia/nemotron-3-super-120b-a12b:free","choices":[{"delta":{"content":"Hello"}}]}\n\n',
        ': OPENROUTER PROCESSING\n\n',
        'data: {"choices":[{"delta":{"content":", world"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    };
    try {
      const deltas = [];
      const r = await or.askAi('hi', { apiKey: 'sk-fake', onDelta: (t) => deltas.push(t) });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.text, 'Hello, world');
      assert.equal(r.model, 'nvidia/nemotron-3-super-120b-a12b:free');
      assert.deepEqual(deltas, ['Hello', 'Hello, world'], 'progressive deltas in order');
      assert.equal(sent.stream, true, 'stream:true sent to OpenRouter');
      assert.equal(sent.model, or.DEFAULT_MODEL);
    } finally { global.fetch = realFetch; }
  });
  it('every request carries the TUI environment system message first', async () => {
    const realFetch = global.fetch;
    let sent = null;
    global.fetch = async (url, opts) => {
      sent = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ model: 'm:free', choices: [{ message: { content: 'Hi' } }] }) };
    };
    try {
      const r = await or.askAi('hi', { apiKey: 'sk-fake' });
      assert.equal(r.ok, true, r.error);
      assert.ok(Array.isArray(sent.messages) && sent.messages.length >= 2, 'system + user');
      assert.equal(sent.messages[0].role, 'system', 'environment preamble rides first');
      assert.match(sent.messages[0].content, /terminal/);
      assert.match(sent.messages[0].content, /ONE terminal cell wide/);
      assert.equal(sent.messages[1].role, 'user');
    } finally { global.fetch = realFetch; }
  });
  it('buildMessages keeps history order with the preamble ahead of it', () => {
    const msgs = or.buildMessages('and cats?', 'page text', [{ q: 'what is this', a: 'A page.' }], undefined);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[1].role, 'user');
    assert.equal(msgs[1].content, 'what is this', 'history first turn');
    assert.equal(msgs[2].role, 'assistant');
    assert.equal(msgs[3].role, 'user');
    assert.match(msgs[3].content, /and cats\?/);
    assert.ok(!msgs[3].content.includes('page text'), 'older turns drop the page context');
    const solo = or.buildMessages('what is this?', 'SECRET PAGE TEXT', [], undefined);
    assert.equal(solo.length, 2, 'system + one turn');
    assert.match(solo[1].content, /SECRET PAGE TEXT/, 'first turn carries the page context');
  });
  it('non-streaming path is unchanged (plain JSON, no stream flag)', async () => {
    const realFetch = global.fetch;
    let sent = null;
    global.fetch = async (url, opts) => {
      sent = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ model: 'm:free', choices: [{ message: { content: 'Hi there' } }] }) };
    };
    try {
      const r = await or.askAi('hi', { apiKey: 'sk-fake' });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.text, 'Hi there');
      assert.equal(r.model, 'm:free');
      assert.equal(sent.stream, undefined, 'no stream flag without onDelta');
    } finally { global.fetch = realFetch; }
  });
  it('a mid-stream error with no text yet is the honest error', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => sseResponse([
      'data: {"error":{"message":"rate limited upstream"}}\n\n',
    ]);
    try {
      const r = await or.askAi('hi', { apiKey: 'sk-fake', onDelta: () => {} });
      assert.equal(r.ok, false);
      assert.match(r.error, /rate limited upstream/);
    } finally { global.fetch = realFetch; }
  });
  it('an error after partial text keeps what already arrived', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"Half an ans"}}]}\n\n',
      'data: {"error":{"message":"stream died"}}\n\n',
    ]);
    try {
      const r = await or.askAi('hi', { apiKey: 'sk-fake', onDelta: () => {} });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.text, 'Half an ans', 'partial text is kept, not thrown away');
    } finally { global.fetch = realFetch; }
  });
});

// ---- live free-model catalog: the settings picker self-heals ----
function modelsPayload(entries) {
  return { ok: true, status: 200, json: async () => ({ data: entries }) };
}

describe('openrouter: live free-model catalog', () => {
  beforeEach(() => or.clearCatalogCache());
  afterEach(() => or.clearCatalogCache());

  it('keeps only zero-priced, text-output :free models; labels stay tidy', async () => {
    const models = await or.fetchFreeModels({
      fetchFn: async () => modelsPayload([
        { id: 'vendor/chat-9b:free', name: 'Vendor: Chat 9B (free)', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
        { id: 'vendor/paid-9b', name: 'Paid', pricing: { prompt: '0.5', completion: '1' } },
        { id: 'vendor/not-really-free:free', name: 'Almost', pricing: { prompt: '0', completion: '0.2' } },
        { id: 'vendor/music-3:free', name: 'Music 3', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['audio'] } },
        { id: 'vendor/content-safety-guard:free', name: 'Guard', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
        { id: 'vendor/no-pricing:free', name: 'Unknown', pricing: null },
        null,
      ]),
    });
    assert.deepEqual(models.map((m) => m.id), ['vendor/chat-9b:free']);
    assert.equal(models[0].label, 'Chat 9B');
  });

  it('a retired saved pick falls back to the default once the catalog is live', async () => {
    await or.warmFreeModels({
      fetchFn: async () => modelsPayload([
        { id: 'vendor/live-1:free', name: 'Vendor: Live One (free)', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
      ]),
    });
    assert.equal(or.catalogIsLive(), true);
    assert.equal(or.modelCatalog()[0].id, 'vendor/live-1:free');
    assert.equal(or.effectiveModel('vendor/retired:free'), or.DEFAULT_MODEL, 'retired id never answers');
    assert.equal(or.effectiveModel('vendor/live-1:free'), 'vendor/live-1:free', 'live id kept');
    or.clearCatalogCache();
    assert.equal(or.effectiveModel('vendor/retired:free'), 'vendor/retired:free', 'offline keeps the free pick');
  });

  it('a dead fetch never breaks the picker: curated fallback stays', async () => {
    const models = await or.warmFreeModels({ fetchFn: async () => { throw new Error('offline'); } });
    assert.deepEqual(models, []);
    assert.equal(or.catalogIsLive(), false);
    assert.deepEqual(or.modelCatalog().map((m) => m.id), or.FREE_MODELS.map((m) => m.id));
  });

  it('a retired saved model 404 self-heals: one retry with the default', async () => {
    const realFetch = global.fetch;
    const sent = [];
    global.fetch = async (url, opts) => {
      sent.push(JSON.parse(opts.body).model);
      if (sent.length === 1) {
        return { ok: false, status: 404, json: async () => ({ error: { message: 'No allowed providers' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ model: or.DEFAULT_MODEL, choices: [{ message: { content: 'Recovered' } }] }) };
    };
    try {
      const r = await or.askAi('hi', { apiKey: 'sk-fake', model: 'vendor/retired:free' });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.text, 'Recovered');
      assert.deepEqual(sent, ['vendor/retired:free', or.DEFAULT_MODEL], 'exactly one retry with the default');
    } finally { global.fetch = realFetch; }
  });
});
