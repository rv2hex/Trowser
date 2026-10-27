'use strict';
/* Comprehensive unit tests for tui-browser (node:test + assert, no new deps).
 * Order: happy path -> edge cases -> error cases -> integration.
 * Run: npm test  (node --test tests/)
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------- helpers ----------
function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-test-'));
  return path.join(dir, name);
}
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tui-test-'));
}

// Save/restore globals mutated by tests
const realFetch = global.fetch;
afterEach(() => {
  if (global.fetch !== realFetch) global.fetch = realFetch;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.KITTY_WINDOW_ID;
});

// ============================================================
// navigation.js
// ============================================================
describe('navigation: Navigator happy path', () => {
  const { Navigator } = require('../src/navigation');
  it('navigates and tracks back/forward', () => {
    const n = new Navigator({ file: null });
    n.navigate('https://a.com');
    n.navigate('https://b.com');
    assert.deepEqual(n.getHistory(), ['https://a.com', 'https://b.com']);
    assert.equal(n.back(), 'https://a.com');
    assert.equal(n.canGoBack(), false);
    assert.equal(n.canGoForward(), true);
    assert.equal(n.forward(), 'https://b.com');
  });
  it('getHistory returns a copy', () => {
    const { Navigator } = require('../src/navigation');
    const n = new Navigator({ file: null });
    n.navigate('https://a.com');
    const h = n.getHistory();
    h.push('https://evil.com');
    assert.deepEqual(n.getHistory(), ['https://a.com']);
  });
  it('currentUrl follows the cursor, not the stack tail', () => {
    const { Navigator } = require('../src/navigation');
    const n = new Navigator({ file: null });
    assert.equal(n.currentUrl(), '');
    n.navigate('https://a.com');
    n.navigate('https://b.com');
    n.navigate('https://c.com');
    assert.equal(n.currentUrl(), 'https://c.com');
    n.back();
    assert.equal(n.currentUrl(), 'https://b.com');
    n.back();
    assert.equal(n.currentUrl(), 'https://a.com');
    n.forward();
    assert.equal(n.currentUrl(), 'https://b.com');
  });
});

describe('navigation: edge cases', () => {
  const { Navigator } = require('../src/navigation');
  it('back/forward at bounds return null', () => {
    const n = new Navigator({ file: null });
    assert.equal(n.back(), null);
    assert.equal(n.forward(), null);
    n.navigate('https://a.com');
    assert.equal(n.back(), null);
    assert.equal(n.forward(), null);
  });
  it('new navigation drops forward history', () => {
    const n = new Navigator({ file: null });
    n.navigate('https://a.com');
    n.navigate('https://b.com');
    n.back();
    n.navigate('https://c.com');
    assert.deepEqual(n.getHistory(), ['https://a.com', 'https://c.com']);
    assert.equal(n.forward(), null);
  });
  it('redirects are tracked separately from history', () => {
    const n = new Navigator({ file: null });
    n.redirect('https://r.com');
    assert.deepEqual(n.getRedirects(), ['https://r.com']);
    assert.deepEqual(n.getHistory(), []);
  });
  it('caps history at 200 entries', () => {
    const n = new Navigator({ file: null });
    for (let i = 0; i < 250; i++) n.navigate(`https://x.com/${i}`);
    assert.equal(n.getHistory().length, 200);
    assert.equal(n.getHistory()[199], 'https://x.com/249');
  });
  it('coerces non-string urls to string', () => {
    const n = new Navigator({ file: null });
    n.navigate(123);
    assert.deepEqual(n.getHistory(), ['123']);
  });
});

describe('navigation: persistence + corrupt files', () => {
  const { Navigator } = require('../src/navigation');
  it('saves and reloads history from disk', () => {
    const f = tmpFile('history.json');
    const a = new Navigator({ file: f });
    a.navigate('https://a.com');
    a.navigate('https://b.com');
    const b = new Navigator({ file: f });
    assert.deepEqual(b.getHistory(), ['https://a.com', 'https://b.com']);
    assert.equal(b.back(), 'https://a.com');
  });
  it('corrupt file starts empty and never throws', () => {
    const f = tmpFile('history.json');
    fs.writeFileSync(f, '{{not json');
    const n = new Navigator({ file: f });
    assert.deepEqual(n.getHistory(), []);
  });
  it('non-array JSON starts empty', () => {
    const f = tmpFile('history.json');
    fs.writeFileSync(f, JSON.stringify({ hi: 1 }));
    const n = new Navigator({ file: f });
    assert.deepEqual(n.getHistory(), []);
  });
  it('missing file starts empty', () => {
    const n = new Navigator({ file: path.join(tmpDir(), 'nope', 'history.json') });
    assert.deepEqual(n.getHistory(), []);
  });
});

// ============================================================
// themes.js
// ============================================================
describe('themes: happy path', () => {
  const { themeNames, themeList, getTheme, HIGHLIGHTED, isHighlightedTheme, isTransparentTheme } = require('../src/themes');
  it('ships every opencode theme plus white', () => {
    const names = themeNames();
    assert.ok(names.length >= 70, `expected the full opencode set, got ${names.length}`);
    for (const want of ['white', 'tokyonight', 'catppuccin', 'gruvbox', 'nord', 'dracula', 'matrix', 'github', 'rosepine', 'kanagawa', 'one-dark', 'synthwave84']) {
      assert.ok(names.includes(want), `missing ${want}`);
    }
  });
  it('every palette is complete and sane', () => {
    for (const name of themeNames()) {
      const t = getTheme(name);
      for (const k of ['bg', 'fg', 'border', 'muted', 'accent', 'alt']) {
        assert.ok(k in t, `${name} misses ${k}`);
      }
      for (const k of ['fg', 'border', 'muted', 'accent', 'alt']) {
        assert.match(String(t[k]), /^#[0-9a-f]{6}$/i, `${name}.${k} is not a hex color: ${t[k]}`);
      }
      assert.ok(t.bg === null || /^#[0-9a-f]{6}$/i.test(String(t.bg)), `${name}.bg`);
    }
  });
  it('uses TWO strong colors per theme (primary + accent)', () => {
    let twoTone = 0;
    for (const name of themeNames()) {
      const t = getTheme(name);
      if (t.accent !== t.alt) twoTone++;
    }
    assert.ok(twoTone >= 20, `expected many two-tone palettes, got ${twoTone}`);
  });
  it('has a transparent twin for every colored theme', () => {
    const names = themeNames();
    for (const name of names.filter((n) => n !== 'white' && !n.endsWith('-t'))) {
      const twin = `${name}-t`;
      assert.ok(names.includes(twin), `missing transparent twin ${twin}`);
      assert.equal(isTransparentTheme(twin), true, `${twin} must be transparent`);
      assert.equal(getTheme(twin).bg, null);
      assert.equal(getTheme(twin).accent, getTheme(name).accent, 'same colors, just no background');
    }
  });
  it('marks a handful of vivid themes as highlighted', () => {
    assert.ok(HIGHLIGHTED.length >= 4);
    for (const n of HIGHLIGHTED) assert.ok(isHighlightedTheme(n), n);
    assert.equal(isHighlightedTheme('nord'), false);
  });
  it('picker order: highlighted first, white last, nothing twice', () => {
    const list = themeList();
    assert.equal(list.length, themeNames().length);
    assert.equal(new Set(list).size, list.length, 'no duplicates');
    assert.equal(list[list.length - 1], 'white');
    assert.equal(list[0], HIGHLIGHTED[0], 'highlighted pinned to the top');
  });
  it('returns palette with name + roles', () => {
    const t = getTheme('dracula');
    assert.equal(t.name, 'dracula');
    for (const k of ['bg', 'fg', 'border', 'muted', 'accent', 'alt']) assert.ok(k in t, k);
  });
  it('white theme is transparent bg', () => {
    assert.equal(getTheme('white').bg, null);
  });
});

describe('themes: edge + error', () => {
  const { getTheme } = require('../src/themes');
  it('unknown name falls back to white', () => {
    const t = getTheme('nope');
    assert.equal(t.name, 'white');
    assert.equal(t.bg, null);
  });
  it('undefined/null fall back to white', () => {
    assert.equal(getTheme(undefined).name, 'white');
    assert.equal(getTheme(null).name, 'white');
    assert.equal(getTheme('').name, 'white');
  });
});

// ============================================================
// config.js
// ============================================================
describe('config: happy path', () => {
  const { loadConfig, saveConfig, DEFAULTS } = require('../src/config');
  it('defaults when no file', () => {
    assert.deepEqual(loadConfig(path.join(tmpDir(), 'missing.json')), { ...DEFAULTS });
  });
  it('round-trips theme + pageSize + quality', () => {
    const f = tmpFile('config.json');
    saveConfig({ theme: 'dracula', pageSize: 25, quality: '720' }, f);
    assert.deepEqual(loadConfig(f), { theme: 'dracula', pageSize: 25, quality: '720', vo: 'auto', idleTeardownMin: 0, quitPlayer: 'ask', readerMode: 'reader', glow: false, restoreSession: false, aiModel: '' });
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(raw.theme, 'dracula');
    assert.equal(raw.quality, '720');
  });
  it('old configs without quality gain the default', () => {
    const f = tmpFile('config.json');
    saveConfig({ theme: 'dracula', pageSize: 25 }, f);
    assert.deepEqual(loadConfig(f), { theme: 'dracula', pageSize: 25, quality: '480', vo: 'auto', idleTeardownMin: 0, quitPlayer: 'ask', readerMode: 'reader', glow: false, restoreSession: false, aiModel: '' });
  });
  it('vo round-trips; bad values fall back to auto', () => {
    const f = tmpFile('config.json');
    saveConfig({ theme: 'white', pageSize: 50, quality: '480', vo: 'xv' }, f);
    assert.equal(loadConfig(f).vo, 'xv');
    fs.writeFileSync(f, JSON.stringify({ theme: 'white', pageSize: 50, quality: '480', vo: 'wayland' }));
    assert.equal(loadConfig(f).vo, 'auto');
  });
  it('retired keys are ignored, defaults survive', () => {
    const f = tmpFile('config.json');
    fs.writeFileSync(f, JSON.stringify({ theme: 'dracula', pageSize: 25, quality: '480', googleClientId: 'whatever' }));
    assert.deepEqual(loadConfig(f), { theme: 'dracula', pageSize: 25, quality: '480', vo: 'auto', idleTeardownMin: 0, quitPlayer: 'ask', readerMode: 'reader', glow: false, restoreSession: false, aiModel: '' });
  });
  it('restoreSession is opt-in: boolean round-trips, junk ignored', () => {
    const f = tmpFile('config.json');
    saveConfig({ theme: 'white', pageSize: 50, quality: '480', restoreSession: true }, f);
    assert.equal(loadConfig(f).restoreSession, true, 'ON survives the round trip');
    fs.writeFileSync(f, JSON.stringify({ theme: 'white', restoreSession: 'yes' }));
    assert.equal(loadConfig(f).restoreSession, false, 'non-boolean junk => default off');
  });
  it('configFile respects XDG_CONFIG_HOME', () => {
    const { configFile } = require('../src/config');
    const d = tmpDir();
    process.env.XDG_CONFIG_HOME = d;
    assert.equal(configFile(), path.join(d, 'tui-browser', 'config.json'));
  });
});

describe('config: validation + corrupt input', () => {
  const { loadConfig } = require('../src/config');
  it('rejects unknown theme, keeps default', () => {
    const f = tmpFile('config.json');
    fs.writeFileSync(f, JSON.stringify({ theme: 'nope', pageSize: 25 }));
    assert.equal(loadConfig(f).theme, 'white');
  });
  it('rejects bad pageSize, keeps default', () => {
    const f = tmpFile('config.json');
    fs.writeFileSync(f, JSON.stringify({ theme: 'dracula', pageSize: 999 }));
    const c = loadConfig(f);
    assert.equal(c.pageSize, 50);
    assert.equal(c.theme, 'dracula');
  });
  it('corrupt JSON yields defaults', () => {
    const f = tmpFile('config.json');
    fs.writeFileSync(f, 'not-json{{{');
    assert.deepEqual(loadConfig(f), { theme: 'white', pageSize: 50, quality: '480', vo: 'auto', idleTeardownMin: 0, quitPlayer: 'ask', readerMode: 'reader', glow: false, restoreSession: false, aiModel: '' });
  });
  it('non-object JSON yields defaults', () => {
    const f = tmpFile('config.json');
    fs.writeFileSync(f, JSON.stringify([1, 2]));
    assert.deepEqual(loadConfig(f), { theme: 'white', pageSize: 50, quality: '480', vo: 'auto', idleTeardownMin: 0, quitPlayer: 'ask', readerMode: 'reader', glow: false, restoreSession: false, aiModel: '' });
  });
  it('saveConfig never throws on bad path', () => {
    const { saveConfig } = require('../src/config');
    // A regular file as parent fails fast with ENOTDIR (never use /proc:
    // mkdir under /proc hangs instead of throwing).
    const blocker = tmpFile('blocker.json');
    fs.writeFileSync(blocker, 'x');
    assert.doesNotThrow(() => saveConfig({ theme: 'white', pageSize: 50 }, path.join(blocker, 'config.json')));
  });
  it('quality validation: bad levels fall back, numbers snap', () => {
    const { loadConfig } = require('../src/config');
    const f = tmpFile('config.json');
    fs.writeFileSync(f, JSON.stringify({ theme: 'white', pageSize: 50, quality: 'nope' }));
    assert.equal(loadConfig(f).quality, '480');
    fs.writeFileSync(f, JSON.stringify({ theme: 'white', pageSize: 50, quality: '720p' }));
    assert.equal(loadConfig(f).quality, '720');
  });
});

describe('quality: formats + cycle (data saver)', () => {
  const q = require('../src/quality');
  it('formats are merge-capable at every level (video+audio pair)', () => {
    assert.equal(q.ytdlFormat('360'), 'bestvideo[height<=360]+bestaudio/best[height<=360]/best');
    assert.equal(q.ytdlFormat('480'), 'bestvideo[height<=480]+bestaudio/best[height<=480]/best');
    assert.ok(q.ytdlFormat('720').includes('+bestaudio'));
    assert.ok(q.ytdlFormat('best').includes('+bestaudio'));
  });
  it('normalize empty -> null, cycle wraps best->360', () => {
    assert.equal(q.normalizeQuality(''), null);
    assert.equal(q.normalizeQuality('480p'), '480');
    assert.equal(q.cycleQuality('best'), '360');
  });
  it('direct args: single URL plays, pair maps audio-file, junk null', () => {
    assert.deepEqual(q.mpvDirectArgs(['https://cdn.github.com/v.mp4']), ['--fullscreen', 'https://cdn.github.com/v.mp4']);
    assert.deepEqual(q.mpvDirectArgs(['https://cdn.github.com/v.mp4', 'https://cdn.github.com/a.m4a']), ['--fullscreen', 'https://cdn.github.com/v.mp4', '--audio-file=https://cdn.github.com/a.m4a']);
    assert.equal(q.mpvDirectArgs(['nope']), null);
  });
  it('vo: normalize + describe, unknown falls back to auto', () => {
    assert.deepEqual(q.VOS, ['auto', 'gpu', 'xv', 'x11', 'drm']);
    assert.equal(q.normalizeVo('XV'), 'xv');
    assert.equal(q.normalizeVo('nope'), null);
    assert.equal(q.normalizeVo(''), null);
    assert.equal(q.describeVo('auto'), 'auto (gpu → xv → x11 fallbacks)');
    assert.equal(q.describeVo('x11'), 'x11 (pinned)');
  });
  it('queue args: merge format, android as fallback (never the pin), JS solver, deduped, capped, junk null', () => {
    assert.deepEqual(
      q.mpvQueueArgs(['https://a.com/1', 'https://a.com/1', 'ftp://x', '', 'https://a.com/2'], '480'),
      ['--fullscreen', '--ytdl-format=bestvideo[height<=480]+bestaudio/best[height<=480]/best', '--ytdl-raw-options-append=extractor-args=youtube:player_client=default,android', '--ytdl-raw-options-append=js-runtimes=node', '--ytdl-raw-options-append=remote-components=ejs:github', 'https://a.com/1', 'https://a.com/2']
    );
    assert.equal(q.mpvQueueArgs([], '480'), null);
    assert.equal(q.mpvQueueArgs(['nope'], '480'), null);
  });
  it('ladder: sticky first, canonical order, android always last', () => {
    assert.deepEqual(q.YT_CLIENTS, ['default', 'tv', 'web', 'ios', 'mweb', 'android']);
    assert.deepEqual(q.clientLadder(''), ['default', 'tv', 'web', 'ios', 'mweb', 'android']);
    assert.deepEqual(q.clientLadder('tv'), ['tv', 'default', 'web', 'ios', 'mweb', 'android']);
    assert.deepEqual(q.clientLadder('default'), ['default', 'tv', 'web', 'ios', 'mweb', 'android']);
    assert.deepEqual(q.clientLadder('android'), ['default', 'tv', 'web', 'ios', 'mweb', 'android']);
    assert.deepEqual(q.clientLadder('junk'), ['default', 'tv', 'web', 'ios', 'mweb', 'android']);
  });
  it('resolve args: JS runtime + solver flags, client pin except default, droppable', () => {
    const js = q.resolveArgs('best', 'tv', { js: true });
    assert.ok(js.includes('--js-runtimes') && js.includes('node'));
    assert.ok(js.includes('--remote-components') && js.includes('ejs:github'));
    assert.ok(js.includes('youtube:player_client=tv'));
    assert.ok(!q.resolveArgs('best', 'default', { js: true }).includes('youtube:player_client=default'));
    assert.ok(!q.resolveArgs('best', 'tv', { js: false }).includes('--js-runtimes'));
  });
  it('resolve output parse + 429 detection + better-candidate choice', () => {
    assert.deepEqual(q.parseResolveOutput('1080\nhttps://v/a\nhttps://v/b\n'), { height: 1080, urls: ['https://v/a', 'https://v/b'] });
    assert.deepEqual(q.parseResolveOutput('https://v/a\n'), { height: 0, urls: ['https://v/a'] });
    assert.deepEqual(q.parseResolveOutput(''), { height: 0, urls: [] });
    assert.equal(q.isRateLimited('ERROR: HTTP Error 429: Too Many Requests'), true);
    assert.equal(q.isRateLimited('ERROR: unable to download'), false);
    // In-bounds wins; ties prefer the merge pair; overshoot -> smaller.
    const a = { height: 360, urls: ['u'], client: 'android', merge: false };
    const b = { height: 1080, urls: ['u', 'a'], client: 'default', merge: true };
    assert.equal(q.pickBetter(b, a, 1080), true);
    assert.equal(q.pickBetter(a, b, 1080), false);
    const c = { height: 1080, urls: ['u'], client: 'default', merge: false };
    assert.equal(q.pickBetter({ ...c, merge: true }, c, 1080), true);
    const over = { height: 2160, urls: ['u'], client: 'default', merge: false };
    assert.equal(q.pickBetter(over, { height: 1080, urls: ['u'], client: 'default', merge: false }, 360), false);
    assert.equal(q.pickBetter({ height: 1080, urls: ['u'], client: 'default', merge: false }, over, 360), true);
  });
  it('early stop: exact cap, 1080 best, default cross-check, android ends, attempt cap', () => {
    const stop = (o) => q.shouldStop({ want: '1080', best: null, attempts: 1, lastClient: 'default', ...o });
    assert.equal(stop({ best: { height: 1080, client: 'default' }, attempts: 1 }), true);
    assert.equal(stop({ best: { height: 720, client: 'default' }, attempts: 1 }), false);
    assert.equal(stop({ best: { height: 720, client: 'default' }, attempts: 2 }), true);
    assert.equal(stop({ best: { height: 720, client: 'tv' }, attempts: 2 }), false);
    assert.equal(stop({ best: { height: 360, client: 'android' }, attempts: 6, lastClient: 'android' }), true);
    assert.equal(stop({ best: { height: 720, client: 'tv' }, attempts: 4 }), true);
    assert.equal(stop({ best: null, lastClient: 'tv' }), false);
    assert.equal(stop({ best: null, lastClient: 'android' }), true);
    assert.equal(q.shouldStop({ want: 'best', best: { height: 1080, client: 'tv' }, attempts: 2, lastClient: 'tv' }), true);
    // Data saver: an overshoot is not a hit — android's in-range 360 is.
    assert.equal(q.shouldStop({ want: '480', best: { height: 1080, client: 'default' }, attempts: 2, lastClient: 'tv' }), false);
    assert.equal(q.shouldStop({ want: '480', best: { height: 1080, client: 'default' }, attempts: 4, lastClient: 'mweb' }), false);
    assert.equal(q.shouldStop({ want: '480', best: { height: 1080, client: 'default' }, attempts: 6, lastClient: 'android' }), true);
    assert.equal(q.shouldStop({ want: '480', best: { height: 360, client: 'android' }, attempts: 6, lastClient: 'android' }), true);
  });
  it('retry policy: android consolation retried for >360 requests only', () => {
    assert.equal(q.wantsPrimaryRetry({ height: 360, client: 'android' }, '1080'), true);
    assert.equal(q.wantsPrimaryRetry({ height: 360, client: 'android' }, 'best'), true);
    assert.equal(q.wantsPrimaryRetry({ height: 360, client: 'android' }, '360'), false);
    assert.equal(q.wantsPrimaryRetry({ height: 720, client: 'default' }, '1080'), false);
    assert.equal(q.wantsPrimaryRetry(null, '1080'), false);
  });
});

// ============================================================
// suggest.js
// ============================================================
describe('suggest: looksLikeURL', () => {
  const { looksLikeURL } = require('../src/suggest');
  it('happy: bare domain, full URL, path', () => {
    assert.equal(looksLikeURL('github.com'), true);
    assert.equal(looksLikeURL('https://github.com/sindresorhus/awesome'), true);
    assert.equal(looksLikeURL('http://a.b.co/p?q=1'), true);
  });
  it('edge: trims, rejects queries with spaces', () => {
    assert.equal(looksLikeURL('  github.com  '), true);
    assert.equal(looksLikeURL('how to bake bread'), false);
    assert.equal(looksLikeURL(''), false);
    assert.equal(looksLikeURL(null), false);
    assert.equal(looksLikeURL('localhost'), false); // no dot
  });
});

describe('suggest: rankHistory', () => {
  const { rankHistory } = require('../src/suggest');
  const H = ['https://a.com/', 'https://b.com/cats', 'https://a.com/dogs'];
  it('happy: empty query returns most-recent-first', () => {
    const out = rankHistory(H, '');
    assert.equal(out[0].url, 'https://a.com/dogs');
    assert.equal(out.length, 3);
    assert.ok(out.every((r) => r.kind === 'history'));
  });
  it('filters by query substring', () => {
    const out = rankHistory(H, 'cats');
    assert.equal(out.length, 1);
    assert.equal(out[0].url, 'https://b.com/cats');
  });
  it('dedupes repeat visits', () => {
    const out = rankHistory(['https://a.com', 'https://a.com', 'https://b.com'], '');
    assert.equal(out.length, 2);
  });
  it('prefix matches rank first', () => {
    const out = rankHistory(['https://zzz.com/aaa', 'https://aaa.com/'], 'aaa');
    assert.equal(out[0].url, 'https://aaa.com/');
  });
  it('edge: bad history input, invalid urls skipped, limit honored', () => {
    assert.deepEqual(rankHistory(null, ''), []);
    assert.deepEqual(rankHistory('nope', ''), []);
    assert.deepEqual(rankHistory(['not a url', 123, null], ''), []);
    const big = Array.from({ length: 20 }, (_, i) => `https://x.com/${i}`);
    assert.equal(rankHistory(big, '', 5).length, 5);
  });
});

describe('suggest: fetchWebSuggest', () => {
  const { fetchWebSuggest } = require('../src/suggest');
  it('happy: maps phrases to search rows', async () => {
    global.fetch = async () => ({ ok: true, json: async () => [{ phrase: 'cats' }, { phrase: 'cats cute' }] });
    const out = await fetchWebSuggest('cats');
    assert.deepEqual(out, [
      { label: 'cats', url: null, kind: 'search' },
      { label: 'cats cute', url: null, kind: 'search' },
    ]);
  });
  it('error: non-ok / non-array / network failure yield []', async () => {
    global.fetch = async () => ({ ok: false });
    assert.deepEqual(await fetchWebSuggest('x'), []);
    global.fetch = async () => ({ ok: true, json: async () => ({ nope: 1 }) });
    assert.deepEqual(await fetchWebSuggest('x'), []);
    global.fetch = async () => { throw new Error('down'); };
    assert.deepEqual(await fetchWebSuggest('x'), []);
  });
  it('error: blank phrases filtered', async () => {
    global.fetch = async () => ({ ok: true, json: async () => [{ phrase: ' ' }, { phrase: '' }, {}, { phrase: 'ok' }] });
    assert.deepEqual(await fetchWebSuggest('x'), [{ label: 'ok', url: null, kind: 'search' }]);
  });
});

describe('suggest: getSuggestions integration', () => {
  const { getSuggestions } = require('../src/suggest');
  it('empty input returns history only (no network)', async () => {
    let called = false;
    global.fetch = async () => { called = true; throw new Error('must not fetch'); };
    const out = await getSuggestions('   ', ['https://a.com']);
    assert.equal(called, false);
    assert.equal(out[0].url, 'https://a.com');
  });
  it('URL input offers direct URL first without network', async () => {
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, json: async () => [] }; };
    const out = await getSuggestions('github.com', []);
    assert.equal(called, false);
    assert.equal(out[0].url, 'https://github.com');
    assert.equal(out[0].kind, 'url');
  });
  it('does not duplicate direct URL already in history', async () => {
    global.fetch = async () => ({ ok: true, json: async () => [] });
    const out = await getSuggestions('https://a.com', ['https://a.com']);
    assert.equal(out.filter((r) => r.url === 'https://a.com').length, 1);
  });
  it('search merges web + history, dedupes, caps at 8', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => Array.from({ length: 10 }, (_, i) => ({ phrase: `q result ${i}` })),
    });
    const out = await getSuggestions('q', ['https://q.com']);
    assert.ok(out.length <= 8);
    const keys = out.map((r) => r.url || r.label);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('suggest: getCommandSuggestions', () => {
  const { getCommandSuggestions, COMMANDS } = require('../src/suggest');
  it('bare slash lists the everyday commands, each tagged with its section', () => {
    const out = getCommandSuggestions('/');
    const core = COMMANDS.filter((c) => !c.palette);
    assert.equal(out.length, core.length);
    assert.ok(out.every((r) => r.kind === 'command' && r.label.startsWith('/') && r.section));
    assert.ok(out.some((r) => r.label === '/yt <query>'));
    assert.ok(out.length < COMMANDS.length, 'the everyday view is a subset, not the whole catalog');
  });
  it('settings-hub commands never appear; setup ones only while typing', () => {
    const bare = getCommandSuggestions('/');
    assert.ok(!bare.some((r) => /^\/(quality|login|logout|register|resend)\b/.test(r.label)), 'settings-hub commands stay out');
    assert.ok(!bare.some((r) => /^\/(ai-key|cookies)\b/.test(r.label)), 'setup commands wait for typing');
    assert.deepEqual(getCommandSuggestions('/qual'), [], '/quality is settings-owned now');
    assert.deepEqual(getCommandSuggestions('/log'), []);
    const typed = getCommandSuggestions('/ai-k');
    assert.ok(typed.some((r) => r.label.startsWith('/ai-key')), 'typing reaches setup commands');
    assert.ok(getCommandSuggestions('/coo').some((r) => r.label.startsWith('/cookies')), '/cookies too');
  });
  it('prefix filters; alias shotcuts resolves', () => {
    assert.ok(getCommandSuggestions('/sho').some((r) => r.label === '/shortcuts'));
    const aliased = getCommandSuggestions('/shotcuts');
    assert.ok(aliased.some((r) => r.label === '/shortcuts'));
  });
  it('typing is fuzzy from two letters: subsequences find commands', () => {
    assert.ok(getCommandSuggestions('/gme').some((r) => r.label.startsWith('/game')), '/gme finds /game');
    assert.ok(getCommandSuggestions('/stngs').some((r) => r.label.startsWith('/settings')), '/stngs finds /settings');
    assert.ok(getCommandSuggestions('/hlp').some((r) => r.label.startsWith('/help')), '/hlp finds /help');
    // Prefix matches always lead the fuzzy tail.
    const ga = getCommandSuggestions('/gam');
    assert.ok(ga.length && ga[0].label.startsWith('/game'), 'prefix outranks fuzzy');
    // A single letter stays a pure prefix game: no fuzzy wall of rows.
    const qPrefix = COMMANDS.filter((c) => c.palette !== 'hidden' && (c.name.startsWith('q') || c.aliases.some((a) => a.startsWith('q')))).length;
    assert.equal(getCommandSuggestions('/q').length, qPrefix, 'single letters do not fuzzy');
    // Hidden (settings-owned) commands never leak through the fuzzy path.
    assert.deepEqual(getCommandSuggestions('/qulty'), [], 'hidden /quality stays hidden');
  });
  it('takesArg rows carry <name> placeholder', () => {
    const rows = getCommandSuggestions('/fin');
    const find = rows.find((r) => r.label === '/find <text>');
    assert.ok(find, `expected /find in ${JSON.stringify(rows.map((r) => r.label))}`);
  });
  it('retired commands are gone from the palette; /settings is the hub', () => {
    assert.ok(getCommandSuggestions('/settings').some((r) => r.label === '/settings'), '/settings lives');
    // Settings-owned names are NEVER listed — not as prefix, not as fuzzy.
    const hiddenNames = ['/vo', '/links', '/themes', '/gpt', '/gemini', '/quality', '/login', '/logout'];
    for (const input of ['/vo', '/links', '/themes', '/gpt', '/gemini']) {
      const rows = getCommandSuggestions(input);
      for (const h of hiddenNames) {
        assert.ok(
          !rows.some((r) => r.label === h || r.label.startsWith(h + ' ')),
          `${input} must not list ${h}`
        );
      }
    }
    // Fuzzy hits on visible commands still work from short fragments.
    assert.ok(getCommandSuggestions('/vo').some((r) => r.label === '/videos'), '/vo fuzzily finds /videos');
    assert.ok(getCommandSuggestions('/ai').some((r) => r.label.startsWith('/ai')), '/ai is back (OpenRouter)');
  });
  it('unknown prefix yields []', () => {
    assert.deepEqual(getCommandSuggestions('/zzzzzz'), []);
  });
});

describe('suggest: local-first phase + abort', () => {
  const suggestMod = require('../src/suggest');
  it('getLocalSuggestions is sync and never touches the network', () => {
    let called = false;
    global.fetch = async () => { called = true; throw new Error('must not fetch'); };
    assert.deepEqual(suggestMod.getLocalSuggestions('', ['https://a.com'])[0].url, 'https://a.com');
    assert.equal(suggestMod.getLocalSuggestions('github.com', [])[0].url, 'https://github.com');
    const rows = suggestMod.getLocalSuggestions('cats', ['https://cats.com/x']);
    assert.ok(rows.some((r) => r.url === 'https://cats.com/x'));
    assert.equal(called, false);
  });
  it('getLocalSuggestions matches the async path for empty/URL input', async () => {
    global.fetch = async () => { throw new Error('must not fetch'); };
    for (const input of ['', '   ', 'github.com', 'https://github.com/sindresorhus/awesome']) {
      assert.deepEqual(
        await suggestMod.getSuggestions(input, ['https://github.com/sindresorhus/awesome']),
        suggestMod.getLocalSuggestions(input, ['https://github.com/sindresorhus/awesome'])
      );
    }
  });
  it('pre-aborted caller signal yields history-only rows', async () => {
    global.fetch = (url, { signal } = {}) => {
      // Faithful to real fetch: an aborted signal rejects immediately.
      if (signal && signal.aborted) return Promise.reject(new Error('aborted'));
      return Promise.resolve({ ok: true, json: async () => [{ phrase: 'web' }] });
    };
    const ctl = new AbortController();
    ctl.abort();
    const out = await suggestMod.getSuggestions('cats', ['https://cats.com/'], 8, { signal: ctl.signal });
    assert.ok(out.every((r) => r.label !== 'web'));
    assert.ok(out.some((r) => r.url === 'https://cats.com/'));
  });
  it('default web timeout is ~1s (slow networks fail fast)', async () => {
    global.fetch = (url, { signal } = {}) => new Promise((_, reject) => {
      if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const t0 = Date.now();
    assert.deepEqual(await suggestMod.fetchWebSuggest('cats'), []);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
  });
});

// ============================================================
// commands.js
// ============================================================
function mockDeps(over = {}) {
  const calls = { content: [], theme: null, saved: null, shutdown: null, loginForms: [], identity: null, toasts: [], pageSize: null, readMode: null, refills: [], mails: [], statuses: [] };
  const ui = {
    setCenterContent: (text, links) => calls.content.push({ text, links }),
    applyTheme: (n) => { calls.theme = n; },
    showLoginForm: (opts) => { calls.loginForms.push(opts); },
    setIdentity: (n, e) => { calls.identity = [n, e]; },
    playHighlightedVideo: () => false,
    setPageSize: (n) => { calls.pageSize = n; },
    setStatus: (t) => { calls.statuses.push(String(t)); },
    clearStatus: () => { calls.statuses.push('[clear]'); },
  };
  const browser = { profileDir: '/tmp/prof', profileReady: () => false, close: async () => {} };
  const navigator = { getHistory: () => ['https://a.com', 'https://b.com'] };
  const config = { theme: 'white', pageSize: 50 };
  // Mail stub: OTP/login tests must never open a real SMTP connection.
  const mail = {
    sendMail: async (msg) => {
      calls.mails.push({ ...msg });
      return { ok: true };
    },
  };
  return {
    calls,
    deps: {
      ui, browser, navigator, config, mail,
      saveConfig: (c) => { calls.saved = { ...c }; },
      shutdown: (code) => { calls.shutdown = code; },
      setReadMode: (m) => { calls.readMode = m; },
      refillLinks: (n) => { calls.refills.push(n); },
      ...over,
    },
  };
}
describe('commands: happy path', () => {
  const { routeCommand } = require('../src/commands');
  it('/help, /shortcuts, /pets render inline', () => {
    for (const cmd of ['/help', '/shortcuts', '/pets']) {
      const { calls, deps } = mockDeps();
      routeCommand(cmd, deps);
      assert.equal(calls.content.length, 1);
      assert.ok(calls.content[0].text.length > 5);
    }
  });
  it('/links shows the current size and the accepted values', () => {
    const { calls, deps } = mockDeps();
    routeCommand('/links', deps);
    const t = calls.content.map((c) => c.text).join('\n');
    assert.ok(t.includes('Links per page: 50'), t);
    assert.ok(t.includes('10|25|50|100'), t);
  });
  it('/links <n> sets the page size, persists it and refills the open list', () => {
    for (const n of [10, 25, 50, 100]) {
      const { calls, deps } = mockDeps();
      routeCommand(`/links ${n}`, deps);
      assert.equal(calls.pageSize, n);
      assert.equal(deps.config.pageSize, n);
      assert.equal(calls.saved.pageSize, n);
      assert.deepEqual(calls.refills, [n]);
    }
  });
  it('/links rejects values outside the supported sizes', () => {
    for (const bad of ['7', '999', 'many']) {
      const { calls, deps } = mockDeps();
      routeCommand(`/links ${bad}`, deps);
      assert.equal(calls.pageSize, null, `${bad} must not change page size`);
      assert.equal(deps.config.pageSize, 50);
      assert.equal(calls.refills.length, 0);
      assert.ok(calls.content.map((c) => c.text).join('').includes('Unknown count'));
    }
  });
  it('/read switches view mode (reader default, raw escape hatch)', () => {
    const a = mockDeps();
    routeCommand('/read', a.deps);
    assert.equal(a.calls.readMode, 'reader');
    const b = mockDeps();
    routeCommand('/read raw', b.deps);
    assert.equal(b.calls.readMode, 'raw');
  });
  describe('/home resets the browser before going home', () => {
  const { routeCommand } = require('../src/commands');
  it('resets first, then navigates home', async () => {
    const order = [];
    const { deps } = mockDeps({
      resetBrowser: async () => { order.push('reset'); return true; },
      navigate: (u) => { order.push(`nav:${u}`); },
    });
    routeCommand('/home', deps);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, ['reset', 'nav:https://html.duckduckgo.com/html/']);
  });
  it('still goes home when the reset fails (never strands the user)', async () => {
    const order = [];
    const { deps } = mockDeps({
      resetBrowser: async () => { order.push('reset-failed'); throw new Error('nope'); },
      navigate: (u) => { order.push('nav'); },
    });
    routeCommand('/home', deps);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, ['reset-failed', 'nav']);
  });
  it('without a reset dep it simply navigates (older wiring stays safe)', () => {
    let nav = '';
    const { deps } = mockDeps({ navigate: (u) => { nav = u; } });
    routeCommand('/home', deps);
    assert.equal(nav, 'https://html.duckduckgo.com/html/');
  });
});

describe('/ai answers via OpenRouter, or it says why not', () => {
    const or = require('../src/openrouter');
    const painted = (calls) => calls.content.map((c) => c.text).join('\n');

    it('bare /ai with nothing open shows the usage hint', () => {
      const { calls, deps } = mockDeps();
      routeCommand('/ai', deps);
      assert.match(painted(calls), /summarizes it|ask: \/ai/i);
    });
    it('with no key it prints real setup instructions, never a fake answer', async () => {
      const { calls, deps } = mockDeps({ askAi: async () => ({ ok: false, error: or.AI_NO_KEY, text: '' }) });
      await routeCommand('/ai what is this?', deps);
      const out = painted(calls);
      assert.match(out, /openrouter\.ai\/keys/, 'points at the real key source');
      assert.match(out, /ai-key/, 'says how to save it');
      assert.match(out, /settings/i, 'and where the model picker lives');
      assert.doesNotMatch(out, /too little text/i, 'the old dead-end message is gone');
    });
    it('the answer is painted and signed with the model that produced it', async () => {
      const { calls, deps } = mockDeps({
        askAi: async () => ({ ok: true, error: '', text: 'Nemotron says hi.', model: 'nvidia/nemotron-3-super-120b-a12b:free' }),
      });
      await routeCommand('/ai say hi', deps);
      const out = painted(calls);
      assert.match(out, /Nemotron says hi\./, 'the answer text lands');
      assert.match(out, /— by nemotron 120b/, 'signed: — by <model>');
    });
    it('an article passes page context to the model', async () => {
      let seen = null;
      const { deps } = mockDeps({
        askAi: async (q, opts) => { seen = { q, opts }; return { ok: true, error: '', text: 'ok' }; },
      });
      deps.ui.getPageText = () => 'Page words about penguins. '.repeat(10); // >200 chars
      await routeCommand('/ai what does it say?', deps);
      assert.ok(seen && seen.opts && seen.opts.context && seen.opts.context.length > 200, 'page context passed');
    });
    it('a failure is painted honestly, not swallowed', async () => {
      const { calls, deps } = mockDeps({ askAi: async () => ({ ok: false, error: 'rate limited: slow down' }) });
      await routeCommand('/ai hi', deps);
      assert.match(painted(calls), /rate limited: slow down/);
    });
    it('a slow free model shows live progress instead of looking hung', async () => {
      let seen = null;
      const { calls, deps } = mockDeps({
        askAi: (q, opts) => {
          seen = opts;
          if (typeof opts.onDelta === 'function') {
            opts.onDelta('- first part');
            opts.onDelta('- first part, second part');
          }
          return Promise.resolve({ ok: true, error: '', text: '- first part, second part', model: 'x:free' });
        },
      });
      await routeCommand('/ai explain turtles', deps);
      assert.equal(typeof seen.onDelta, 'function', 'streaming progress wired to the transport');
      assert.ok(
        calls.statuses.some((s) => /Receiving answer… \d+ chars/.test(s)),
        'status line reports received chars: ' + JSON.stringify(calls.statuses)
      );
    });
    it('the answer view labels the model in its head (visible without scrolling)', async () => {
      const views = [];
      const { deps } = mockDeps({
        ui: {
          setStatus: () => {},
          clearStatus: () => {},
          showGeminiView: (text, title, model) => views.push({ text, title, model }),
        },
        askAi: async () => ({ ok: true, error: '', text: 'A real answer.', model: 'nvidia/nemotron-3-super-120b-a12b:free' }),
      });
      await routeCommand('/ai explain turtles', deps);
      assert.ok(views.length > 0, 'answer view painted');
      assert.equal(views.at(-1).model, 'nvidia/nemotron-3-super-120b-a12b:free', 'model handed to the view head');
    });
    it('/ai clear resets the thread', () => {
      const { calls, deps } = mockDeps();
      routeCommand('/ai clear', deps);
      assert.match(painted(calls), /Conversation cleared/i);
    });
    it('/gemini is retired (not in the catalog) but redirects the question to /ai', async () => {
      const { findSpec } = require('../src/commandSpec');
      assert.equal(findSpec('gemini'), null, '/gemini must not resolve anymore');
      const { calls, deps } = mockDeps({ askAi: async () => ({ ok: true, error: '', text: 'Redirected answer.' }) });
      await routeCommand('/gemini why is the sky blue?', deps);
      const out = painted(calls);
      assert.match(out, /retired/i, 'says it is retired');
      assert.match(out, /Redirected answer\./, 'still answers through /ai');
    });
  });
  it('retired commands no longer resolve (no theme change, no settings view)', () => {
    const { findSpec } = require('../src/commandSpec');
    for (const cmd of ['/theme dracula', '/gpt hi', '/pollinations hi']) {
      const { calls, deps } = mockDeps();
      routeCommand(cmd, deps);
      assert.equal(calls.theme, null, `${cmd} must not apply a theme`);
      assert.equal(calls.pageSize, null, `${cmd} must not touch page size`);
      // The only thing painted is the "unknown command" hint.
      const painted = calls.content.map((c) => c.text).join('\n');
      assert.match(painted, /Unknown command|did you mean|\/help/i, `${cmd} should only hint`);
      const bare = cmd.split(' ')[0].replace(/^\//, '');
      assert.equal(findSpec(bare), null, `/${bare} should not be in the catalog`);
    }
  });
  it('/profile shows profile/session/history', () => {
    const { calls, deps } = mockDeps();
    routeCommand('/profile', deps);
    const t = calls.content[0].text;
    assert.ok(t.includes('Profile:'));
    assert.ok(t.includes('History: 2 pages'));
  });
  it('/quit shuts down', () => {
    const { calls, deps } = mockDeps();
    routeCommand('/quit', deps);
    assert.equal(calls.shutdown, 0);
  });
  it('/profile shows account + session info when signed in', () => {
    const accts = require('../src/accounts');
    process.env.XDG_CONFIG_HOME = tmpDir();
    try {
      accts.register({ name: 'Ada', gmail: 'ada@gmail.com', number: '+123456', password: 'password123' });
      accts.signInSession('ada@gmail.com');
      const { calls, deps } = mockDeps();
      routeCommand('/profile', deps);
      const t = calls.content[0].text;
      assert.ok(t.includes('Ada <ada@gmail.com>'));
      assert.ok(t.includes('Number: +123456'));
      assert.ok(t.includes('Registered:'));
      assert.ok(t.includes('History: 2 pages'));
    } finally {
      accts.signOutSession();
    }
  });
  it('/register runs the full wizard and signs in (emailed code)', async () => {
    const accts = require('../src/accounts');
    process.env.XDG_CONFIG_HOME = tmpDir();
    try {
      const { calls, deps } = mockDeps();
      routeCommand('/register', deps);
      assert.equal(calls.loginForms[0].step, 'name');
      calls.loginForms[0].callback('Ada');
      calls.loginForms[1].callback('ada@gmail.com');
      calls.loginForms[2].callback('+123456');
      // The code step is live and a code was issued for the gmail.
      assert.equal(calls.loginForms[3].step, 'otp');
      const otp = accts.peekOtp('ada@gmail.com').otp;
      assert.match(otp, /^\d{6}$/);
      calls.loginForms[3].callback(otp);
      calls.loginForms[4].callback('password123');
      calls.loginForms[5].callback('password123');
      assert.deepEqual(calls.identity, ['Ada', 'ada@gmail.com']);
      assert.ok(calls.content.some((c) => c.text.includes('Registered as Ada')));
      assert.equal(accts.currentSession(), 'ada@gmail.com');
      // The code email was sent to the gmail (never a real SMTP socket in tests).
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(calls.mails.length, 1);
      assert.equal(calls.mails[0].to, 'ada@gmail.com');
      assert.ok(calls.mails[0].text.includes(otp));
    } finally {
      accts.signOutSession();
    }
  });
  it('/register validates each step, the code, and the password confirm', () => {
    process.env.XDG_CONFIG_HOME = tmpDir();
    const { calls, deps } = mockDeps();
    routeCommand('/register', deps);
    calls.loginForms[0].callback('Ada');
    calls.loginForms[1].callback('bad-mail');
    assert.ok(calls.loginForms.at(-1).prompt.includes('Invalid Gmail'));
    calls.loginForms.at(-1).callback('ada@gmail.com');
    calls.loginForms.at(-1).callback('12');
    assert.ok(calls.loginForms.at(-1).prompt.includes('Invalid number'));
    calls.loginForms.at(-1).callback('+123456');
    // A wrong code re-prompts the code step (wizard stays alive).
    calls.loginForms.at(-1).callback('000000');
    assert.ok(calls.loginForms.at(-1).prompt.includes('did not match'));
    const otp = require('../src/accounts').peekOtp('ada@gmail.com').otp;
    calls.loginForms.at(-1).callback(otp);
    calls.loginForms.at(-1).callback('short');
    assert.ok(calls.loginForms.at(-1).prompt.includes('8 characters'));
    calls.loginForms.at(-1).callback('password123');
    calls.loginForms.at(-1).callback('different1');
    assert.ok(calls.loginForms.at(-1).prompt.includes('did not match'));
    assert.equal(calls.content.length, 0); // nothing painted until done
  });
});

describe('commands: edge + error', () => {
  const { routeCommand } = require('../src/commands');
  it('unknown command hints /help', () => {
    const { calls, deps } = mockDeps();
    routeCommand('/nope', deps);
    assert.ok(calls.content[0].text.includes('/help'));
  });
  it('/vo shows status, rejects junk, pins driver', () => {
    const { calls, deps } = mockDeps();
    routeCommand('/vo', deps);
    assert.ok(calls.content[0].text.includes('auto (gpu'));
    const bad = mockDeps();
    routeCommand('/vo wayland', bad.deps);
    assert.ok(bad.calls.content[0].text.includes('Unknown video output'));
    const good = mockDeps();
    routeCommand('/vo xv', good.deps);
    assert.equal(good.deps.config.vo, 'xv');
    assert.ok(good.calls.content[0].text.includes('xv (pinned)'));
  });
  it('forgiving alias /shotcuts works', () => {
    const { calls, deps } = mockDeps();
    routeCommand('/shotcuts', deps);
    assert.equal(calls.content.length, 1);
  });
  it('case-insensitive + extra whitespace', () => {
    const { calls, deps } = mockDeps();
    routeCommand('  /HELP  ', deps);
    assert.equal(calls.content.length, 1);
  });
  it('/play with nothing playable hints', () => {
    const { calls, deps } = mockDeps();
    routeCommand('/play', deps);
    assert.ok(calls.content[0].text.includes('Nothing playable'));
  });
  it('/play delegates when video highlighted', () => {
    const { calls, deps } = mockDeps({ ui: null });
    const { calls: c2, deps: d2 } = mockDeps();
    d2.ui.playHighlightedVideo = () => true;
    routeCommand('/play', d2);
    assert.equal(c2.content.length, 0);
    void calls;
  });
  it('/yt with a watch URL plays directly via playUrl', () => {
    const played = [];
    const { calls, deps } = mockDeps({ playUrl: (u) => { played.push(u); } });
    routeCommand('/yt https://www.youtube.com/watch?v=dQw4w9WgXcQ', deps);
    assert.deepEqual(played, ['https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
    assert.equal(calls.content.length, 0);
  });
  it('/yt watch URL without playUrl dep explains instead of throwing', () => {
    const { calls, deps } = mockDeps();
    assert.doesNotThrow(() => routeCommand('/yt https://youtu.be/dQw4w9WgXcQ', deps));
    assert.ok(calls.content.some((c) => c.text.includes('mpv')));
  });
  it('/login signs in with gmail + emailed code', async () => {
    const accts = require('../src/accounts');
    process.env.XDG_CONFIG_HOME = tmpDir();
    try {
      accts.register({ name: 'Ada', gmail: 'ada@gmail.com', number: '+123456', password: 'password123' });
      const { calls, deps } = mockDeps();
      routeCommand('/login', deps);
      calls.loginForms[0].callback('ada@gmail.com');
      assert.equal(calls.loginForms[1].step, 'otp');
      const otp = accts.peekOtp('ada@gmail.com').otp;
      calls.loginForms[1].callback(otp);
      assert.deepEqual(calls.identity, ['Ada', 'ada@gmail.com']);
      assert.ok(calls.content.some((c) => c.text.includes('Signed in as Ada')));
      assert.equal(accts.currentSession(), 'ada@gmail.com');
      // The code email went out (stubbed) and the code is single-use.
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(calls.mails.length, 1);
      assert.ok(calls.mails[0].text.includes(otp));
      assert.equal(accts.peekOtp('ada@gmail.com'), null);
    } finally {
      accts.signOutSession();
    }
  });
  it('/login rejects bad codes generically; unregistered gmail needs /register; Esc cancels', async () => {
    const accts = require('../src/accounts');
    process.env.XDG_CONFIG_HOME = tmpDir();
    try {
      accts.register({ name: 'Ada', gmail: 'ada@gmail.com', number: '+123456', password: 'password123' });
      const { calls, deps } = mockDeps();
      routeCommand('/login', deps);
      calls.loginForms[0].callback('ada@gmail.com');
      calls.loginForms[1].callback('000000'); // always wrong (codes are 100000+)
      // Wrong code re-prompts (wizard stays alive) instead of aborting.
      assert.equal(calls.loginForms.length, 3);
      assert.ok(calls.loginForms[2].prompt.includes('did not match'));
      assert.equal(calls.identity, null);
      assert.equal(accts.currentSession(), null);
      // Correct code for an UNregistered gmail: told to /register instead.
      const u = mockDeps();
      routeCommand('/login', u.deps);
      u.calls.loginForms[0].callback('nobody@gmail.com');
      const uotp = accts.peekOtp('nobody@gmail.com').otp;
      u.calls.loginForms[1].callback(uotp);
      assert.ok(u.calls.content.some((c) => c.text.includes('/register')));
      assert.equal(accts.currentSession(), null);
      const c2 = mockDeps();
      routeCommand('/login', c2.deps);
      c2.calls.loginForms[0].callback(null); // Esc
      assert.equal(c2.calls.content.length, 0);
      assert.equal(c2.calls.loginForms.length, 1);
    } finally {
      accts.signOutSession();
    }
  });
  it('/resend issues a fresh code (gmail arg or signed-in) and emails it', async () => {
    const accts = require('../src/accounts');
    process.env.XDG_CONFIG_HOME = tmpDir();
    try {
      // No argument and nobody signed in: usage, no mail.
      const miss = mockDeps();
      routeCommand('/resend', miss.deps);
      assert.ok(miss.calls.content.some((c) => c.text.includes('Usage: /resend')));
      assert.equal(miss.calls.mails.length, 0);
      // Explicit gmail: replaces any pending code and mails the new one.
      const first = accts.requestOtp('ada@gmail.com').otp;
      const r = mockDeps();
      routeCommand('/resend ada@gmail.com', r.deps);
      const fresh = accts.peekOtp('ada@gmail.com').otp;
      assert.notEqual(fresh, first);
      await new Promise((res) => setTimeout(res, 0));
      assert.equal(r.calls.mails.length, 1);
      assert.equal(r.calls.mails[0].to, 'ada@gmail.com');
      assert.ok(r.calls.mails[0].text.includes(fresh));
      // Signed in with no argument: defaults to the session gmail.
      accts.signInSession('ada@gmail.com');
      const s = mockDeps();
      routeCommand('/resend', s.deps);
      await new Promise((res) => setTimeout(res, 0));
      assert.equal(s.calls.mails.length, 1);
      assert.equal(s.calls.mails[0].to, 'ada@gmail.com');
    } finally {
      accts.signOutSession();
    }
  });
  it('/resend reports a failed send loudly (code stays usable)', async () => {
    const accts = require('../src/accounts');
    process.env.XDG_CONFIG_HOME = tmpDir();
    const r = mockDeps({ mail: { sendMail: async () => ({ ok: false, error: 'SMTP 535' }) } });
    routeCommand('/resend ada@gmail.com', r.deps);
    await new Promise((res) => setTimeout(res, 0));
    assert.ok(r.calls.content.some((c) => c.text.includes('Email failed')));
    assert.ok(r.calls.content.some((c) => c.text.includes(accts.peekOtp('ada@gmail.com').otp)));
  });
  it('/logout signs out and wipes profile dir', async () => {
    const accts = require('../src/accounts');
    const { Browser } = require('../src/browser');
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'x.txt'), 'hi');
    accts.signInSession('ada@gmail.com');
    try {
      const { calls, deps } = mockDeps();
      deps.browser.profileDir = dir;
      // stub close to avoid real browser
      routeCommand('/logout', deps);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(fs.existsSync(dir), false);
      assert.ok(calls.content.some((c) => c.text.includes('Signed out ada@gmail.com')));
      assert.ok(calls.content.some((c) => c.text.includes('wiped')));
      assert.deepEqual(calls.identity, ['', '']);
      assert.equal(accts.currentSession(), null);
    } finally {
      accts.signOutSession();
    }
    void Browser;
  });
});

// ============================================================
// image.js
// ============================================================
describe('image: detectImageSupport', () => {
  const { detectImageSupport } = require('../src/image');
  it('kitty/ghostty/wezterm/konsole map to kitty', () => {
    assert.equal(detectImageSupport({ KITTY_WINDOW_ID: '1' }), 'kitty');
    assert.equal(detectImageSupport({ GHOSTTY_RESOURCES_DIR: 'x' }), 'kitty');
    assert.equal(detectImageSupport({ WEZTERM_PANE: '1' }), 'kitty');
    assert.equal(detectImageSupport({ KONSOLE_VERSION: '1' }), 'kitty');
    assert.equal(detectImageSupport({ TERM: 'xterm-kitty' }), 'kitty');
    assert.equal(detectImageSupport({ TERM_PROGRAM: 'WezTerm' }), 'kitty');
  });
  it('unknown terminals get none (text fallback)', () => {
    assert.equal(detectImageSupport({}), 'none');
    assert.equal(detectImageSupport({ TERM: 'xterm-256color' }), 'none');
    assert.equal(detectImageSupport(null), 'none');
  });
});

describe('image: kittyChunks', () => {
  const { kittyChunks } = require('../src/image');
  it('single small payload ends with m=0', () => {
    const parts = kittyChunks(Buffer.from('hi').toString('base64'));
    assert.equal(parts.length, 1);
    assert.ok(parts[0].includes('m=0;'));
    assert.ok(parts[0].startsWith('\x1b_G'));
    assert.ok(parts[0].endsWith('\x1b\\'));
  });
  it('large payload splits; all but last carry m=1', () => {
    const big = 'A'.repeat(9000);
    const parts = kittyChunks(big);
    assert.ok(parts.length >= 3);
    assert.ok(parts.slice(0, -1).every((p) => p.includes('m=1;')));
    assert.ok(parts[parts.length - 1].includes('m=0;'));
    // Single-dim default (no-stretch): c= only, never c=+r= together.
    assert.ok(parts[0].includes('c=30') && !parts[0].includes('r='));
    assert.equal(parts.join('').replace(/\x1b_Ga=T,f=100(,c=\d+)?(,r=\d+)?,m=[01];/g, '').replace(/\x1b\\/g, ''), big);
  });
  it('honors cols/rows', () => {
    const parts = kittyChunks('QQ==', { cols: 10, rows: 5 });
    assert.ok(parts[0].includes('c=10,r=5'));
  });
  it('single-dim output never stretches (fitOverlay contract)', () => {
    const { fitOverlay } = require('../src/image');
    for (const size of [{ w: 1280, h: 720 }, { w: 720, h: 1280 }, { w: 800, h: 800 }]) {
      const dims = fitOverlay(size, { maxCols: 30, maxRows: 12 });
      assert.equal(Object.keys(dims).length, 1);
      const seq = kittyChunks('QQ==', dims)[0];
      assert.ok(!(seq.includes('c=') && seq.includes('r=')), `must not contain both c= and r=: ${seq}`);
    }
  });
});

describe('image: fetchBytes + showThumbnail + clearImages', () => {
  const { fetchBytes, showThumbnail, clearImages } = require('../src/image');
  function sseBody(chunks) {
    return {
      getReader: () => {
        let i = 0;
        return {
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
          cancel: async () => {},
        };
      },
    };
  }
  it('fetchBytes happy: concatenates image bytes', async () => {
    global.fetch = async () => ({
      ok: true,
      body: sseBody([Buffer.from([1, 2]), Buffer.from([3])]),
      headers: { get: () => 'image/png' },
    });
    const b = await fetchBytes('https://x/y.png');
    assert.deepEqual([...b], [1, 2, 3]);
  });
  it('fetchBytes rejects: non-ok, non-image, oversize, network error', async () => {
    global.fetch = async () => ({ ok: false, body: null, headers: { get: () => null } });
    assert.equal(await fetchBytes('https://x'), null);
    global.fetch = async () => ({ ok: true, body: sseBody([Buffer.from('hi')]), headers: { get: () => 'text/html' } });
    assert.equal(await fetchBytes('https://x'), null);
    global.fetch = async () => ({
      ok: true,
      body: sseBody([Buffer.alloc(10)]),
      headers: { get: () => 'image/png' },
    });
    assert.equal(await fetchBytes('https://x', { maxBytes: 5 }), null);
    global.fetch = async () => { throw new Error('down'); };
    assert.equal(await fetchBytes('https://x'), null);
  });
  it('clearImages writes kitty delete and never throws', () => {
    const orig = process.stdout.write;
    let got = '';
    process.stdout.write = (s) => { got += s; return true; };
    try {
      clearImages();
      assert.ok(got.includes('a=d'));
    } finally { process.stdout.write = orig; }
    assert.doesNotThrow(() => {
      process.stdout.write = () => { throw new Error('gone'); };
      try { clearImages(); } finally { process.stdout.write = orig; }
    });
  });
  it('showThumbnail guards: no support / bad coords / fetch fail', async () => {
    assert.equal(await showThumbnail('https://x/y.png', { row: 1, col: 1 }), false); // TERM has no graphics
    const { detectImageSupport: _d } = require('../src/image');
    void _d;
  });
});

describe('image: bounded caches + in-flight dedupe', () => {
  const img = require('../src/image');
  function pngBytes(w = 100, h = 50) {
    const b = Buffer.alloc(32);
    b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  }
  function sseBody(chunks) {
    return {
      getReader: () => {
        let i = 0;
        return {
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
          cancel: async () => {},
        };
      },
    };
  }

  it('cache:true dedupes two concurrent fetches of the same URL', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, body: sseBody([pngBytes()]), headers: { get: () => 'image/png' } };
    };
    const [a, b] = await Promise.all([
      img.fetchBytes('https://x/dup.png', { cache: true }),
      img.fetchBytes('https://x/dup.png', { cache: true }),
    ]);
    assert.equal(calls, 1, 'one socket for the ASCII + graphics queues');
    assert.equal(a, b, 'both callers share the same buffer');
    assert.ok(img.cacheStats().bytesEntries >= 1);
  });

  it('display PNGs are cached per box (second paint never re-encodes)', async () => {
    process.env.KITTY_WINDOW_ID = '1';
    global.fetch = async () => ({ ok: true, body: sseBody([pngBytes(120, 60)]), headers: { get: () => 'image/png' } });
    const orig = process.stdout.write;
    process.stdout.write = () => true;
    try {
      const before = img.cacheStats().displayEntries;
      const opts = { row: 3, col: 3, cols: 10, rows: 5, cache: true };
      assert.equal(await img.showThumbnail('https://x/one.png', opts), true);
      assert.equal(await img.showThumbnail('https://x/one.png', opts), true);
      assert.equal(img.cacheStats().displayEntries, before + 1, 'one cached display PNG');
    } finally {
      process.stdout.write = orig;
      delete process.env.KITTY_WINDOW_ID;
    }
  });
});

// ============================================================
// browser.js (no real Firefox launch)
// ============================================================
describe('browser: profile + constructor', () => {
  const { Browser, defaultProfileDir } = require('../src/browser');
  it('defaultProfileDir respects XDG', () => {
    const d = tmpDir();
    process.env.XDG_CONFIG_HOME = d;
    assert.equal(defaultProfileDir(), path.join(d, 'tui-browser', 'profile'));
  });
  it('constructor defaults: headless true, Chrome engine, custom profileDir', () => {
    const b = new Browser({ profileDir: '/tmp/x' });
    assert.equal(b.headless, true);
    assert.equal(b.engine, 'chrome');
    assert.equal(b.profileDir, '/tmp/x');
    const c = new Browser({ headless: false, profileDir: '/tmp/y' });
    assert.equal(c.headless, false);
    assert.equal(new Browser({ engine: 'firefox', profileDir: '/tmp/z' }).engine, 'firefox');
  });
  it('profileReady false when empty; true for firefox + chromium layouts', () => {
    const b = new Browser({ profileDir: tmpDir() });
    assert.equal(b.profileReady(), false);
    const d2 = tmpDir();
    fs.writeFileSync(path.join(d2, 'cookies.sqlite'), 'x');
    assert.equal(new Browser({ profileDir: d2 }).profileReady(), true);
    const d3 = tmpDir();
    fs.mkdirSync(path.join(d3, 'Default', 'Network'), { recursive: true });
    fs.writeFileSync(path.join(d3, 'Default', 'Network', 'Cookies'), 'x');
    assert.equal(new Browser({ profileDir: d3 }).profileReady(), true);
  });
  it('wipeProfile removes dir; static with default does not throw', () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, 'f'), 'x');
    Browser.wipeProfile(d);
    assert.equal(fs.existsSync(d), false);
    assert.doesNotThrow(() => Browser.wipeProfile(tmpDir()));
  });
  it('close on never-opened browser is safe; relaunch flag flips', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    await b.close();
    assert.equal(b.context, null);
  });
});

describe('browser: navigate guards (no init)', () => {
  const { Browser } = require('../src/browser');
  it('invalid URL and non-http(s) never launch a browser', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    let launched = false;
    b.init = async () => { launched = true; };
    assert.deepEqual(await b.navigate('::::'), { text: 'Error: invalid URL' });
    assert.deepEqual(await b.navigate('ftp://x.com'), { text: 'Error: only http(s) URLs are supported' });
    assert.equal(launched, false);
  });
  it('page.goto failure surfaces as text error', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => {};
    b.page = { goto: async () => { throw new Error('boom'); } };
    const r = await b.navigate('https://github.com');
    assert.ok(r.text.includes('boom'));
  });
  it('a stalled navigation is closed after the deadline (RAM guard)', async () => {
    const b = new Browser({ profileDir: tmpDir(), navTimeoutMs: 60 });
    b.init = async () => {};
    let closed = false;
    b.page = {
      goto: () => new Promise(() => {}), // never resolves: stalled load
      isClosed: () => closed,
      close: async () => { closed = true; },
    };
    const r = await b.navigate('https://slow.example');
    assert.match(String(r.text), /timed out after \d+s/i);
    assert.equal(closed, true, 'stalled page must be closed to free RAM');
    assert.equal(b.page, null, 'page slot cleared for recreation');
  });
  it('a superseded navigation never closes the page a newer one is using', async () => {
    const b = new Browser({ profileDir: tmpDir(), navTimeoutMs: 60 });
    b.init = async () => {};
    let closed = false;
    const page = {
      goto: () => new Promise(() => {}), // stalls
      isClosed: () => closed,
      close: async () => { closed = true; },
    };
    b.page = page;
    const stale = b.navigate('https://stall.example'); // this generation
    await new Promise((r) => setTimeout(r, 20));
    b._navGen = (b._navGen || 0) + 1; // a newer navigation takes over (reuses the page)
    const r = await stale;
    assert.match(String(r.text), /timed out after \d+s/i);
    assert.equal(closed, false, 'must not close the page the newer nav now drives');
    assert.equal(b.page, page, 'page stays in the slot for the newer nav');
  });
});

function mockPageForNavigate(kind) {
  // Inspects the evaluate callback source to return per-stage values.
  // Order matters: the readability extractor embeds the word "consent"
  // (cookie-banner regex), so match its specific markers first and the
  // generic consent-wall markers only for the actual wall probe.
  return {
    goto: async () => {},
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
    url: () => 'https://github.com/',
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes('document.body ?')) throw new Error('no dom'); // settle poll: break immediately
      if (src.includes('captchaIndicators')) {
        return kind === 'captcha';
      }
      if (src.includes('consent.google') || src.includes('indicators')) {
        if (kind === 'blocked') return 'js-wall';
        return null;
      }
      if (src.includes('CAPTCHA detected')) return 'captcha here';
      if (src.includes('cloneNode')) return { text: 'hello world', spans: [{ t: 'hello', url: null }] };
      // link extraction queries
      if (src.includes('.result__a') || src.includes('div.g')) return [];
      if (src.includes('a[href]')) return [];
      return null;
    },
  };
}
describe('browser: navigate branches with mocked page', () => {
  const { Browser } = require('../src/browser');
  it('blocked page returns honest blocked message', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => {};
    b.page = mockPageForNavigate('blocked');
    b.extractPageLinks = async () => [];
    const r = await b.navigate('https://github.com');
    assert.ok(r.blocked.includes('real (non-headless) browser'));
  });
  it('captcha returns trimmed message', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => {};
    b.page = mockPageForNavigate('captcha');
    b.extractPageLinks = async () => [];
    const r = await b.navigate('https://github.com');
    assert.ok(r.captcha.includes('captcha'));
  });
  it('plain page returns text + spans + links', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => {};
    b.page = mockPageForNavigate('text');
    b.extractPageLinks = async () => [{ title: 't', url: 'https://a.com', domain: 'a.com' }];
    const r = await b.navigate('https://github.com');
    assert.equal(r.text, 'hello world');
    assert.equal(r.links.length, 1);
  });
  it('duckduckgo search with results returns structured list', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => {};
    b.page = {
      goto: async () => {},
      url: () => 'https://html.duckduckgo.com/html/?q=cats',
      evaluate: async (fn) => {
        const src = String(fn);
        if (src.includes('consent') || src.includes('indicators')) return null;
        if (src.includes('captchaIndicators')) return false;
        if (src.includes('.result__a')) return [{ title: 'Cute cats', href: 'https://cats.com' }];
        if (src.includes('a[href]')) return [{ title: 'x', href: 'https://cats.com' }];
        return null;
      },
    };
    const r = await b.navigate('https://html.duckduckgo.com/html/?q=cats');
    assert.ok(Array.isArray(r.results));
    assert.ok(r.results.length >= 1);
    // YouTube twin is prepended for web searches with a query
    assert.ok(r.results[0].url.includes('youtube.com'));
  });
  it('search with zero hits falls through to text dump', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => {};
    b.page = {
      goto: async () => {},
      url: () => 'https://html.duckduckgo.com/html/?q=zzz',
      evaluate: async (fn) => {
        const src = String(fn);
        if (src.includes('document.body ?')) throw new Error('no dom');
        if (src.includes('captchaIndicators')) return false;
        if (src.includes('cloneNode')) return { text: 'fallback text', spans: [] };
        if (src.includes('consent.google') || src.includes('indicators')) return null;
        if (src.includes('.result__a') || src.includes('div.g')) return [];
        if (src.includes('a[href]')) return [];
        return null;
      },
    };
    const r = await b.navigate('https://html.duckduckgo.com/html/?q=zzz');
    assert.equal(r.text, 'fallback text');
  });
  it('readability scorer prefers a real article over nav soup', async () => {
    // Runs the REAL in-page extractor against a stub document: the only
    // DOM API it touches is provided, everything else is production code.
    const para =
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(
        4
      );
    const articleText = `${para}\ncommodo-article-marker\n${para}`;
    const cand = ({ text, cls = '', paras = [], links = [] }) => ({
      innerText: text,
      id: '',
      className: cls,
      querySelectorAll: (sel) => {
        if (sel === 'a') return links;
        if (sel === 'p' || sel === 'p, li') return paras;
        return [];
      },
    });
    const article = cand({
      text: articleText,
      cls: 'post entry-content',
      paras: [{ innerText: para, querySelectorAll: () => [] }],
    });
    const clone = {
      innerText: `${'nav home about contact login signup '}\nnavsoup-marker`,
      querySelectorAll: (sel) => (String(sel).includes('main') ? [article] : []),
    };
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => {};
    b.page = {
      goto: async () => {},
      url: () => 'https://github.com/',
      evaluate: async (fn) => {
        const src = String(fn);
        if (src.includes('document.body ?')) throw new Error('no dom');
        if (src.includes('captchaIndicators')) return false;
        if (src.includes('consent.google') || src.includes('indicators')) return null;
        if (src.includes('a[href]')) return [];
        if (src.includes('cloneNode')) {
          const prev = global.document;
          global.document = { body: { innerText: 42, cloneNode: () => clone } };
          try {
            return fn();
          } finally {
            if (prev === undefined) delete global.document;
            else global.document = prev;
          }
        }
        return null;
      },
    };
    const r = await b.navigate('https://github.com');
    assert.ok(r.text.includes('commodo-article-marker'));
    assert.ok(!r.text.includes('navsoup-marker'));
    assert.ok(Array.isArray(r.spans));
  });
  it('link-soup and class-penalized candidates fall back to the body', async () => {
    const para = 'Real sentence here, with commas, rhythm, and cadence. '.repeat(8);
    const soup = {
      innerText: `${para}\nsoup-article-marker`,
      id: '',
      className: 'sidebar widget',
      querySelectorAll: (sel) => {
        if (sel === 'a') return [{ innerText: 'x'.repeat(260) }];
        if (sel === 'p' || sel === 'p, li') return [{ innerText: para, querySelectorAll: () => [] }];
        return [];
      },
    };
    const fallbackBody = `${'Fallback body prose, calm and steady, line after line. '.repeat(8)}\nfallback-body-marker`;
    const clone = {
      innerText: fallbackBody,
      querySelectorAll: (sel) => (String(sel).includes('main') ? [soup] : []),
    };
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => {};
    b.page = {
      goto: async () => {},
      url: () => 'https://github.com/',
      evaluate: async (fn) => {
        const src = String(fn);
        if (src.includes('document.body ?')) throw new Error('no dom');
        if (src.includes('captchaIndicators')) return false;
        if (src.includes('consent.google') || src.includes('indicators')) return null;
        if (src.includes('a[href]')) return [];
        if (src.includes('cloneNode')) {
          const prev = global.document;
          global.document = { body: { innerText: 42, cloneNode: () => clone } };
          try {
            return fn();
          } finally {
            if (prev === undefined) delete global.document;
            else global.document = prev;
          }
        }
        return null;
      },
    };
    const r = await b.navigate('https://github.com');
    assert.ok(r.text.includes('fallback-body-marker'));
    assert.ok(!r.text.includes('soup-article-marker'));
  });
});

describe('browser: extractors never throw', () => {
  const { Browser } = require('../src/browser');
  it('extractResults / extractPageLinks return [] on evaluate failure', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.page = { evaluate: async () => { throw new Error('x'); }, url: () => 'https://a.com' };
    assert.deepEqual(await b.extractResults(), []);
    assert.deepEqual(await b.extractPageLinks(), []);
    assert.deepEqual(await b.extractYouTubeResults(), []);
  });
  it('extractors unwrap /url?q= and /l/?uddg= redirects, dedupe, drop non-http', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.page = {
      url: () => 'https://www.google.com/search?q=x',
      evaluate: async () => ([
        { title: 'r', href: '/url?q=https://real.com/&sa=t' },
        { title: 'r2', href: 'https://real.com/' },
        { title: '', href: 'javascript:void(0)' },
        { title: '', href: '' },
      ]),
    };
    const out = await b.extractResults();
    assert.equal(out.length, 1);
    assert.equal(out[0].url, 'https://real.com/');
  });
});

// ============================================================
// accounts.js (local accounts, scrypt vault)
// ============================================================
describe('accounts: validators + hashing', () => {
  const accts = require('../src/accounts');
  it('name/gmail/number validation', () => {
    assert.equal(accts.validName(' Ada '), 'Ada');
    assert.equal(accts.validName('   '), '');
    assert.equal(accts.validGmail('Ada@Gmail.COM'), 'ada@gmail.com');
    assert.equal(accts.validGmail('nope'), '');
    assert.equal(accts.validGmail('a@b'), '');
    assert.equal(accts.validNumber('+1 234-567'), '+1 234-567');
    assert.equal(accts.validNumber('12'), '');
    assert.equal(accts.validNumber(''), '');
  });
  it('scrypt hashes verify; salts differ', () => {
    const h1 = accts.hashPassword('password123', 's1');
    assert.equal(h1, accts.hashPassword('password123', 's1'));
    assert.notEqual(h1, accts.hashPassword('password123', 's2'));
    assert.notEqual(h1, accts.hashPassword('other', 's1'));
    assert.equal(h1.length, 128); // 64 bytes hex
  });
});

describe('accounts: register + verify + vault', () => {
  const accts = require('../src/accounts');
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = tmpDir();
    accts.signOutSession();
  });
  const good = { name: 'Ada', gmail: 'ada@gmail.com', number: '+123456', password: 'password123' };
  it('register validates every field', () => {
    assert.equal(accts.register({ ...good, name: ' ' }).error, 'Enter a name.');
    assert.equal(accts.register({ ...good, gmail: 'bad' }).error, 'Enter a valid Gmail address.');
    assert.equal(accts.register({ ...good, number: 'x' }).error, 'Enter a valid number.');
    const short = accts.register({ ...good, password: '123' });
    assert.ok(short.error.includes('8 characters'));
    assert.equal(accts.loadAccounts().length, 0); // nothing persisted
  });
  it('register round-trips with 0600 vault; gmail unique; no salt/hash leak', () => {
    const res = accts.register(good);
    assert.equal(res.ok, true);
    assert.deepEqual(Object.keys(res.account).sort(), ['createdAt', 'dob', 'gmail', 'lastLoginAt', 'name', 'number']);
    assert.equal(fs.statSync(accts.accountsFile()).mode & 0o777, 0o600);
    const dup = accts.register({ ...good, name: 'Other' });
    assert.ok(dup.error.includes('already registered'));
    const upper = accts.register({ ...good, gmail: 'ADA@GMAIL.COM', name: 'Other' });
    assert.ok(upper.error.includes('already registered'));
    assert.equal(accts.loadAccounts().length, 1);
  });
  it('register fails loudly when the vault cannot persist', () => {
    const blocker = path.join(tmpDir(), 'blocker.json');
    fs.writeFileSync(blocker, 'x');
    const res = accts.register(good, path.join(blocker, 'a.json'));
    assert.equal(res.ok, false);
    assert.ok(res.error.includes('Could not save'));
  });
  it('verify: success updates lastLogin; failures are generic', async () => {
    accts.register(good);
    const before = accts.loadAccounts()[0].lastLoginAt;
    await new Promise((r) => setTimeout(r, 5));
    const ok = accts.verify({ gmail: 'ADA@gmail.com', password: 'password123' });
    assert.equal(ok.ok, true);
    assert.equal(ok.account.gmail, 'ada@gmail.com');
    assert.ok(accts.loadAccounts()[0].lastLoginAt >= before);
    for (const bad of [
      { gmail: 'ada@gmail.com', password: 'wrongpass1' },
      { gmail: 'nobody@gmail.com', password: 'password123' },
      { gmail: 'bad', password: 'password123' },
      { gmail: 'ada@gmail.com', password: '' },
    ]) {
      const r = accts.verify(bad);
      assert.equal(r.ok, false);
      assert.equal(r.error, 'Gmail and password did not match.');
    }
  });
  it('corrupt vault loads empty; session signs in/out', () => {
    const f = tmpFile('accounts.json');
    fs.writeFileSync(f, '{{{');
    assert.deepEqual(accts.loadAccounts(f), []);
    assert.deepEqual(accts.loadAccounts(f + '.missing'), []);
    assert.equal(accts.currentSession(), null);
    accts.signInSession('ADA@Gmail.COM');
    assert.equal(accts.currentSession(), 'ada@gmail.com');
    accts.signOutSession();
    assert.equal(accts.currentSession(), null);
  });
});

describe('scopes: picker + bangs build the right searches', () => {
  const scopes = require('../src/scopes');
  it('scopeKeys lists web first, then every known scope', () => {
    assert.deepEqual(scopes.scopeKeys(), ['', 'wiki', 'gh', 'so', 'hn']);
  });
  it('scopeHint uses the bang spelling; labels are human', () => {
    assert.equal(scopes.scopeHint('wiki'), '>wiki');
    assert.equal(scopes.scopeHint(''), 'web');
    assert.equal(scopes.scopeHint('nope'), 'web');
    assert.equal(scopes.scopeLabel('wiki'), 'Wikipedia');
    assert.equal(scopes.scopeLabel(''), 'the web');
  });
  it('parseBang: known aliases, domains, and rejects', () => {
    assert.deepEqual(scopes.parseBang('>wiki einstein'), { scope: 'wiki', query: 'einstein' });
    assert.deepEqual(scopes.parseBang('>W cats'), { scope: 'wiki', query: 'cats' });
    assert.deepEqual(scopes.parseBang('>github react hooks'), { scope: 'gh', query: 'react hooks' });
    assert.deepEqual(scopes.parseBang('>example.com term'), { scope: 'example.com', query: 'term' });
    assert.equal(scopes.parseBang('>wiki'), null); // no query
    assert.equal(scopes.parseBang('>notabang nope'), null); // unknown token, not a domain
    assert.equal(scopes.parseBang('wiki einstein'), null); // no bang at all
    assert.equal(scopes.parseBang(''), null);
  });
  it('normalizeBangInput: extra >s collapse; parseBang tolerates the typo', () => {
    assert.equal(scopes.normalizeBangInput('>>wiki'), '>wiki');
    assert.equal(scopes.normalizeBangInput('  >>>gh react  '), '>gh react');
    assert.equal(scopes.normalizeBangInput('>w'), '>w');
    assert.equal(scopes.normalizeBangInput('plain'), 'plain');
    assert.equal(scopes.normalizeBangInput(''), '');
    // `>>wiki einstein` (fat-fingered scope) is the same intent as `>wiki`.
    assert.deepEqual(scopes.parseBang('>>wiki einstein'), { scope: 'wiki', query: 'einstein' });
    assert.deepEqual(scopes.parseBang('>>>gh react hooks'), { scope: 'gh', query: 'react hooks' });
    assert.deepEqual(scopes.parseBang('>>>wiki einstein '), { scope: 'wiki', query: 'einstein' }); // chaos P2 input
    assert.equal(scopes.parseBang('>>wiki'), null); // still no query
    assert.equal(scopes.parseBang('>  spaced'), null, 'spaces before the scope token never resolve');
    assert.equal(scopes.parseBang('>notascope reaction'), null, 'unknown scope with a query never resolves');
  });
  it('scopedSearchUrl: wiki uses the Go handshake; others their own search', () => {
    assert.ok(scopes.scopedSearchUrl('wiki', 'einstein').includes('en.wikipedia.org/w/index.php?search=einstein&go=Go'));
    assert.ok(scopes.scopedSearchUrl('gh', 'react').startsWith('https://github.com/search?q=react'));
    assert.ok(scopes.scopedSearchUrl('so', 'js map').startsWith('https://stackoverflow.com/search?q=js%20map'));
    assert.ok(scopes.scopedSearchUrl('hn', 'lisp').startsWith('https://hn.algolia.com/?q=lisp'));
    assert.equal(scopes.scopedSearchUrl('', 'x'), null);
    assert.equal(scopes.scopedSearchUrl('wiki', ''), null);
  });
  it('wikiOpensearchUrl + firstWikiResult take the TOP result, safely', () => {
    const u = scopes.wikiOpensearchUrl('einstein');
    assert.ok(u.startsWith('https://en.wikipedia.org/w/api.php?action=opensearch&search=einstein'));
    assert.equal(scopes.firstWikiResult([['einstein'], ['Einstein'], [''], ['https://en.wikipedia.org/wiki/Albert_Einstein']]), 'https://en.wikipedia.org/wiki/Albert_Einstein');
    // Garbage shapes never throw and never navigate somewhere unexpected.
    assert.equal(scopes.firstWikiResult(null), null);
    assert.equal(scopes.firstWikiResult({}), null);
    assert.equal(scopes.firstWikiResult([[], [], [], ['http://evil.example/x']]), null);
    assert.equal(scopes.firstWikiResult([[], [], [], []]), null);
    assert.equal(scopes.wikiOpensearchUrl(''), null);
  });
});

describe('accounts: email OTP store', () => {
  const accts = require('../src/accounts');
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = tmpDir();
  });
  it('requestOtp issues a 6-digit code in a 0600 store; peek reads it', () => {
    const res = accts.requestOtp('ada@gmail.com');
    assert.equal(res.ok, true);
    assert.match(res.otp, /^\d{6}$/);
    assert.equal(accts.peekOtp('ada@gmail.com').otp, res.otp);
    assert.equal(fs.statSync(accts.otpFile()).mode & 0o777, 0o600);
    assert.equal(accts.requestOtp('bad').ok, false);
  });
  it('a re-request replaces the old code (newest email always wins)', () => {
    const a = accts.requestOtp('ada@gmail.com').otp;
    const b = accts.requestOtp('ada@gmail.com').otp;
    assert.notEqual(a, b);
    assert.equal(accts.peekOtp('ada@gmail.com').otp, b);
    // The replaced code no longer verifies.
    assert.equal(accts.verifyOtp({ gmail: 'ada@gmail.com', otp: a }).ok, false);
  });
  it('verifyOtp: single-use, generic failures, expiry clears the code', () => {
    const { otp } = accts.requestOtp('ada@gmail.com');
    // Wrong shape / wrong code: generic failure, code still pending.
    for (const bad of ['', '12345', 'abcdef', '000000']) {
      const r = accts.verifyOtp({ gmail: 'ada@gmail.com', otp: bad });
      assert.equal(r.ok, false);
      assert.ok(accts.peekOtp('ada@gmail.com'));
    }
    // No code requested for that gmail: named failure.
    const none = accts.verifyOtp({ gmail: 'nobody@gmail.com', otp: '123456' });
    assert.equal(none.ok, false);
    assert.ok(none.error.includes('No code'));
    // Correct code verifies ONCE (deleted) and returns the account when one exists.
    accts.register({ name: 'Ada', gmail: 'ada@gmail.com', number: '+123456', password: 'password123' });
    const ok = accts.verifyOtp({ gmail: 'Ada@Gmail.com', otp });
    assert.equal(ok.ok, true);
    assert.equal(ok.account.gmail, 'ada@gmail.com');
    assert.equal(accts.peekOtp('ada@gmail.com'), null);
    assert.equal(accts.verifyOtp({ gmail: 'ada@gmail.com', otp }).ok, false);
  });
  it('registration verifies a code before any account exists', () => {
    const { otp } = accts.requestOtp('new@gmail.com');
    const ok = accts.verifyOtp({ gmail: 'new@gmail.com', otp });
    assert.equal(ok.ok, true);
    assert.equal(ok.account, null); // no account yet — registration's case
  });
  it('an expired code fails loudly and is cleared', () => {
    process.env.XDG_CONFIG_HOME = tmpDir();
    const { otp } = accts.requestOtp('ada@gmail.com');
    // Backdate the stored expiry past the TTL.
    const f = accts.otpFile();
    const store = JSON.parse(fs.readFileSync(f, 'utf8'));
    store['ada@gmail.com'].expiry = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(f, JSON.stringify(store));
    const r = accts.verifyOtp({ gmail: 'ada@gmail.com', otp });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('expired'));
    assert.equal(accts.peekOtp('ada@gmail.com'), null);
  });
  it('clearOtp drops a pending code', () => {
    accts.requestOtp('ada@gmail.com');
    assert.equal(accts.clearOtp('ada@gmail.com'), true);
    assert.equal(accts.peekOtp('ada@gmail.com'), null);
    assert.equal(accts.clearOtp('ada@gmail.com'), false);
    assert.equal(accts.clearOtp('bad'), false);
  });
  it('a corrupt OTP store behaves as empty (never throws)', () => {
    const f = accts.otpFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'not json');
    assert.equal(accts.peekOtp('ada@gmail.com'), null);
    assert.equal(accts.verifyOtp({ gmail: 'ada@gmail.com', otp: '123456' }).ok, false);
    const r = accts.requestOtp('ada@gmail.com');
    assert.equal(r.ok, true);
  });
});

// ============================================================
// auth.js entry points
// ============================================================
describe('auth: handleAuthArgs', () => {
  const { Browser } = require('../src/browser');
  let exitCode, logged;
  const realExit = process.exit;
  const realLog = console.log;
  const realErr = console.error;
  beforeEach(() => {
    exitCode = null; logged = [];
    process.exit = (c) => { exitCode = c; throw new Error(`exit:${c}`); };
    console.log = (...a) => logged.push(a.join(' '));
    console.error = (...a) => logged.push(a.join(' '));
  });
  afterEach(() => {
    process.exit = realExit;
    console.log = realLog;
    console.error = realErr;
  });
  it('no auth flags -> false, no exit', () => {
    const { handleAuthArgs } = require('../src/auth');
    assert.equal(handleAuthArgs([]), false);
    assert.equal(handleAuthArgs(['https://x.com']), false);
    assert.equal(exitCode, null);
  });
  it('--logout wipes default profile and exits 0', () => {
    const { handleAuthArgs } = require('../src/auth');
    const d = tmpDir();
    process.env.XDG_CONFIG_HOME = d;
    const prof = path.join(d, 'tui-browser', 'profile');
    fs.mkdirSync(prof, { recursive: true });
    fs.writeFileSync(path.join(prof, 'cookies.sqlite'), 'x');
    assert.throws(() => handleAuthArgs(['--logout']), /exit:0/);
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(prof), false);
    assert.ok(logged.join('\n').includes('Wiped'));
    void Browser;
  });
  it('--login/--headed flags removed (Google gone)', () => {
    const { handleAuthArgs } = require('../src/auth');
    assert.equal(handleAuthArgs(['--login']), false);
    assert.equal(handleAuthArgs(['--headed']), false);
    assert.equal(exitCode, null);
  });
});

// ============================================================
// ui.js: pure helper + TUI integration (real blessed)
// ============================================================
describe('ui: rowIndexFromY pure mapping', () => {
  const { rowIndexFromY } = require('../src/ui');
  it('maps body-relative y + scroll - headers to row', () => {
    assert.equal(rowIndexFromY(2, 0, 2), 0);
    assert.equal(rowIndexFromY(5, 10, 2), 13);
    assert.equal(rowIndexFromY(0, 0, 2), -2);
  });
});

describe('ui: createUI integration', () => {
  const blessed = require('blessed');
  const { createUI } = require('../src/ui');
  let screens = [];
  function makeUI(handlers = {}, opts = { theme: 'white', pageSize: 50 }) {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 'test' });
    screens.push(screen);
    const calls = {};
    const ui = createUI(screen, {
      onOmniSubmit: (...a) => { calls.submit = a; },
      onSuggest: (...a) => { calls.suggest = a; },
      onLinkPick: (...a) => { calls.pick = a; },
      onLinkPreview: (...a) => { calls.preview = a; },
      onPlayVideo: (...a) => { calls.play = a; },
      onHistoryBack: () => { calls.back = true; },
      onHistoryForward: () => { calls.fwd = true; },
      onEscape: () => { calls.esc = true; },
      onQuit: () => { calls.quit = true; },
      onSettingsChange: () => {},
      ...handlers,
    }, opts);
    return { screen, ui, calls };
  }
  afterEach(() => {
    for (const s of screens) { try { s.destroy(); } catch {} }
    screens = [];
  });

  it('boots, setURL + setCenterContent + showLinkPicker do not throw', () => {
    const { ui } = makeUI();
    assert.doesNotThrow(() => {
      ui.setURL('https://github.com');
      ui.setCenterContent('hello {red} world', []);
      ui.showLinkPicker([{ title: 'a', url: 'https://a.com', domain: 'a.com' }]);
    });
    assert.equal(ui.isPickerOpen(), true);
  });
  it('escTags: page content with braces never corrupts render', () => {
    const { ui, screen } = makeUI();
    ui.setCenterContent('{red} evil {/} {open}', []);
    screen.render(); // would throw/corrupt on unescaped tags
  });
  it('applyTheme switches palette; unknown theme safe via getThemeName', () => {
    const { ui } = makeUI();
    ui.applyTheme('dracula');
    assert.equal(ui.getThemeName(), 'dracula');
    ui.setPageSize(25);
    ui.showLinkPicker(Array.from({ length: 60 }, (_, i) => ({ title: `t${i}`, url: `https://a.com/${i}`, domain: 'a.com' })));
  });
  it('appendLinks grows the list without moving the cursor', () => {
    const { ui, screen } = makeUI();
    const rows = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, url: `https://a.com/${i}`, domain: 'a.com' }));
    ui.showLinkPicker(rows);
    screen.emit('keypress', null, { name: 'down', full: 'down' });
    screen.emit('keypress', null, { name: 'down', full: 'down' });
    const before = ui.visibleRows().length;
    const added = ui.appendLinks([
      { title: 'new one', url: 'https://b.com/1', domain: 'b.com' },
      { title: 'dupe', url: 'https://a.com/0', domain: 'a.com' },
    ], true);
    assert.equal(added, 1, 'only the unseen row is added');
    assert.equal(ui.visibleRows().length, before + 1);
    assert.equal(ui.appendLinks([], true), 0, 'empty append is a no-op');
  });
  it('/themes changes the theme LIVE on the arrow keys (no Enter)', () => {
    const saved = [];
    const { ui, screen } = makeUI({ onThemeChange: (n) => saved.push(n) });
    assert.equal(typeof ui.showThemes, 'function');
    assert.equal(ui.showThemes(), true);
    assert.equal(ui.isThemesOpen(), true);
    const before = ui.getThemeName();
    screen.emit('keypress', null, { name: 'down', full: 'down' });
    const after = ui.getThemeName();
    assert.notEqual(after, before, 'one arrow press repaints the app');
    assert.deepEqual(saved, [after], 'and persists it without a confirm key');
    screen.emit('keypress', null, { name: 'right', full: 'right' });
    assert.equal(saved.length, 2, 'every move saves');
    assert.notEqual(ui.getThemeName(), after);
    screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    assert.equal(ui.isThemesOpen(), false, 'esc closes, keeping what was chosen');
  });
it('/themes starts at the top when the current theme is the white fallback', () => {
    const { ui, screen } = makeUI({ onThemeChange: () => {} });
    ui.showThemes();
    const { themeList } = require('../src/themes');
    assert.notEqual(themeList()[0], 'white', 'white is parked last, never the start');
    screen.emit('keypress', null, { name: 'down', full: 'down' });
    assert.equal(ui.getThemeName(), themeList()[1], 'the first arrow press does something');
    ui.closeThemes();
  });
it('the wave rides the bottom and never wipes the page', () => {
    const { ui, screen } = makeUI();
    assert.equal(ui.isLoading(), false);
    ui.setCenterContent('A wiki article about penguins living happily together forever.', []);
    assert.equal(ui.showLoading('Loading video', 'resolving stream', 'yt-dlp is picking a 480p format…'), true);
    assert.equal(ui.isLoading(), true);
    assert.equal(ui.setLoadingStage('starting playback', 'handing over to mpv'), true);
    const texts = [];
    (function walk(el) {
      if (!el || !el.children) return;
      for (const c of el.children) {
        const t = typeof c.getContent === 'function' ? c.getContent() : '';
        if (typeof t === 'string' && t.trim()) texts.push(t);
        walk(c);
      }
    })(screen);
    const body = texts.join('\n');
    assert.ok(body.includes('Loading video'), `title painted: ${body.slice(0, 120)}`);
    assert.ok(!body.includes('{bold}'), `tags must not leak: ${body.slice(0, 160)}`);
    // The wave is the one and only loading animation: no braille spinner
    // may appear while the loader is up (single-animation rule).
    assert.ok(!/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(body), 'no spinner while wave loads');
    // getContent() returns tag-PARSED lines (SGR, incl. 38;2 on truecolor
    // terminals): strip SGR before asserting the wave run.
    const plain = body.replace(/\[[0-9;]*m/g, '').replace(/\{[^}]*\}/g, '');
    assert.ok(/[▁▂▃▄▅▆▇█]{10,}/.test(plain), 'full-width wave run visible');
    // Headless boxes truncate the status line to ~20 cells, so stage
    // CONTENT is proven on the pure loaderFrame (width 40); here assert
    // the live status-line format painted: title + joined stage parts.
    assert.ok(/Loading video ·/.test(body), 'status line painted with stage join');
    // The wave lives at the BOTTOM of the web view: the article that was
    // already on screen must survive a load untouched.
    assert.ok(body.includes('penguins'), 'page above the wave is untouched');
    ui.hideLoading();
    assert.equal(ui.isLoading(), false);
  });
  it('setBlockedCount + resetFocus are safe', () => {
    const { ui } = makeUI();
    ui.setBlockedCount(0);
    ui.setBlockedCount(37);
    ui.setBlockedCount('nope');
    ui.resetFocus();
  });
  it('renderSuggestRows drops stale ids', () => {
    const { ui } = makeUI({
      onSuggest: () => {},
    });
    // id guard: only the latest seq paints; stale render is a no-op
    ui.renderSuggestRows([{ label: 'new', url: null, kind: 'search' }], 9999);
  });
  it('captcha + login form + redirect paths are safe', () => {
    const { ui } = makeUI();
    ui.showCaptcha('solve me');
    ui.showLoginForm({ step: 'email', prompt: 'Email: ', censor: false, callback: () => {} });
    ui.redirectToBrowser('https://github.com');
    ui.redirectToBrowser('::::'); // invalid -> no-op
    ui.redirectToBrowser('ftp://x.com'); // non-http -> no-op
  });
  it('setIdentity paints account identity; empty restores placeholder', () => {
    const { ui } = makeUI();
    assert.doesNotThrow(() => {
      ui.setIdentity('Ada', 'ada@gmail.com');
      ui.setIdentity('', '');
      ui.setIdentity(null, 'ada@gmail.com');
      ui.setIdentity('Ada', null);
    });
  });
  it('keypress q on empty bar types (no quit); ctrl+q quits everywhere', () => {
    const { screen, ui, calls } = makeUI();
    ui.setURL(''); // empty bar
    screen.emit('keypress', 'q', { name: 'q', full: 'q' });
    assert.equal(calls.quit, undefined);
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.deepEqual(calls.submit[0], 'q');
    const r2 = makeUI();
    r2.screen.emit('keypress', null, { name: 'q', full: 'C-q', ctrl: true });
    assert.equal(r2.calls.quit, true);
    void ui;
  });
});


// ============================================================
// browser.js importCookiesFile
// ============================================================
describe('browser: importCookiesFile', () => {
  const { Browser } = require('../src/browser');
  function rig(cookiesJson) {
    const f = tmpFile('cookies.json');
    fs.writeFileSync(f, typeof cookiesJson === 'string' ? cookiesJson : JSON.stringify(cookiesJson));
    const added = [];
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => {};
    b.context = { addCookies: async (cs) => { added.push(...cs); } };
    return { b, f, added };
  }
  it('imports array + storageState shapes; skips junk', async () => {
    const { b, f, added } = rig([
      { name: 'SID', value: 'x', domain: '.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: 9999999999 },
      { name: 'u', value: 'v', url: 'https://github.com/' },
      { name: '', value: 'nope' },
      { name: 'noloc', value: 'v' },
      null,
    ]);
    const out = await b.importCookiesFile(f);
    assert.deepEqual(out, { imported: 2, skipped: 3 });
    assert.equal(added.length, 2);
    assert.equal(added[0].domain, '.google.com');
    assert.equal(added[1].url, 'https://github.com/');
    const { b: b2, f: f2 } = rig({ cookies: [{ name: 'a', value: 'b', domain: 'e.com' }] });
    b2.init = async () => {};
    const added2 = [];
    b2.context = { addCookies: async (cs) => { added2.push(...cs); } };
    assert.deepEqual(await b2.importCookiesFile(f2), { imported: 1, skipped: 0 });
  });
  it('missing file, bad JSON, empty, and all-junk throw plain errors', async () => {
    const b = new Browser({ profileDir: tmpDir() });
    b.init = async () => { throw new Error('must not init'); };
    await assert.rejects(() => b.importCookiesFile('/nope/missing.json'), /Cannot read/);
    const bad = tmpFile('c.json');
    fs.writeFileSync(bad, '{{{');
    await assert.rejects(() => b.importCookiesFile(bad), /Cannot read/);
    const empty = tmpFile('c.json');
    fs.writeFileSync(empty, '[]');
    await assert.rejects(() => b.importCookiesFile(empty), /No cookies found/);
    const junk = tmpFile('c.json');
    fs.writeFileSync(junk, JSON.stringify([{ nope: 1 }]));
    await assert.rejects(() => b.importCookiesFile(junk), /No usable cookies/);
  });
});

// ============================================================
// pets.js (live mood pet + bundled fallback)
// ============================================================
describe('pets: entities + pools + random pick', () => {
  const pets = require('../src/pets');
  it('decodeEntities handles named, decimal, and hex refs', () => {
    assert.equal(pets.decodeEntities('(>_<)'), '(>_<)');
    assert.equal(pets.decodeEntities('&#x27;'), "'");
    assert.equal(pets.decodeEntities('&#39;'), "'");
    assert.equal(pets.decodeEntities('&#65;'), 'A');
    assert.equal(pets.decodeEntities('&quot;hi&quot; &amp; bye'), '"hi" & bye');
    assert.equal(pets.decodeEntities(null), '');
  });
  it('six moods with non-empty clean pools', () => {
    assert.deepEqual(pets.moodNames(), ['happy', 'sad', 'thinking', 'love', 'troubled', 'sleepy']);
    for (const m of pets.moodNames()) {
      assert.ok(pets.FALLBACK[m].length > 0, m);
      for (const face of pets.FALLBACK[m]) {
        assert.ok(face.length > 0 && face.length <= 60, face);
        assert.ok(!/&\w+;|&#\d+;/.test(face), `undecoded entity in ${face}`);
      }
    }
  });
  it('petFor is seeded-random; unknown mood falls back to happy', () => {
    const seq = [0, 0.5, 0.999];
    let i = 0;
    const rand = () => seq[i++ % seq.length];
    assert.equal(pets.petFor('sad', rand), pets.FALLBACK.sad[0]);
    assert.equal(pets.petFor('sad', rand), pets.FALLBACK.sad[Math.floor(0.5 * pets.FALLBACK.sad.length)]);
    assert.ok(pets.FALLBACK.happy.includes(pets.petFor('nope', () => 0)));
    assert.ok(pets.FALLBACK.happy.includes(pets.petFor(null, () => 0)));
  });
  it('moodForEvent maps browser events; unknown is happy', () => {
    assert.equal(pets.moodForEvent('error'), 'sad');
    assert.equal(pets.moodForEvent('invalid'), 'sad');
    assert.equal(pets.moodForEvent('blocked'), 'troubled');
    assert.equal(pets.moodForEvent('captcha'), 'troubled');
    assert.equal(pets.moodForEvent('loading'), 'thinking');
    assert.equal(pets.moodForEvent('login'), 'love');
    assert.equal(pets.moodForEvent('whatever'), 'happy');
    assert.equal(pets.moodForEvent(''), 'happy');
  });
});

describe('pets: live fetch + cache', () => {
  const pets = require('../src/pets');
  it('decodes + caps + caches in memory (one fetch)', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return { ok: true, json: async () => ['(a)', '(&gt;)', '', 42, 'x'.repeat(61)] };
    };
    const d = tmpDir();
    process.env.XDG_CONFIG_HOME = d;
    try {
      const list = await pets.loadLiveMood('sad');
      assert.deepEqual(list, ['(a)', '(>)']);
      assert.equal(calls, 1);
      assert.deepEqual(await pets.loadLiveMood('sad'), ['(a)', '(>)']);
      assert.equal(calls, 1); // memory cache: no second fetch
      assert.ok(fs.existsSync(path.join(d, 'tui-browser', 'kaomoji-sad.json')));
    } finally {
      delete process.env.XDG_CONFIG_HOME;
    }
  });
  it('unknown mood, fetch failure, and bad JSON yield null', async () => {
    assert.equal(await pets.loadLiveMood('nope'), null);
    global.fetch = async () => { throw new Error('down'); };
    process.env.XDG_CONFIG_HOME = tmpDir();
    try {
      assert.equal(await pets.loadLiveMood('love'), null);
      global.fetch = async () => ({ ok: false });
      assert.equal(await pets.loadLiveMood('love'), null);
      global.fetch = async () => ({ ok: true, json: async () => ({}) });
      assert.equal(await pets.loadLiveMood('love'), null);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
    }
  });
  it('primePets never throws and never blocks', async () => {
    global.fetch = async () => { throw new Error('offline'); };
    await assert.doesNotReject(async () => {
      pets.primePets();
      await new Promise((r) => setTimeout(r, 20));
    });
  });
});

describe('commands: /pets moods', () => {
  const { routeCommand } = require('../src/commands');
  function mockPetsDeps() {
    const calls = { content: [] };
    return {
      calls,
      deps: {
        ui: { setCenterContent: (t) => calls.content.push(String(t)) },
        browser: {}, navigator: { getHistory: () => [] }, config: {},
        saveConfig: () => {}, shutdown: () => {},
      },
    };
  }
  it('/pets shows a happy pet; /pets sad shows a sad one; bad mood lists moods', async () => {
    // Offline pools (TUI_TEST skips priming; live cache empty here).
    const a = mockPetsDeps();
    routeCommand('/pets', a.deps);
    assert.ok(a.calls.content[0].includes('(happy'));
    const b = mockPetsDeps();
    routeCommand('/pets sad', b.deps);
    const lines = b.calls.content[0].split('\n');
    assert.ok(lines[0].trim().length > 0, 'a pet face paints');
    assert.ok(b.calls.content[0].endsWith('(sad)'));
    const c = mockPetsDeps();
    routeCommand('/pets grumpy', c.deps);
    assert.ok(c.calls.content[0].includes('happy, sad'));
  });
});

describe('ui: youtube fast list enter plays the pick, tab previews thumb', () => {
  const blessed = require('blessed');
  const { createUI } = require('../src/ui');
  let screens = [];
  function makeYtUI(handlers = {}) {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 'test' });
    screens.push(screen);
    const calls = {};
    const ui = createUI(screen, {
      onOmniSubmit: (...a) => { calls.submit = a; },
      onSuggest: (...a) => { calls.suggest = a; },
      onLinkPick: (...a) => { calls.pick = a; },
      onPlayVideo: (...a) => { calls.play = a; },
      onHistoryBack: () => { calls.back = true; },
      onHistoryForward: () => { calls.fwd = true; },
      onEscape: () => { calls.esc = true; },
      onQuit: () => { calls.quit = true; },
      onSettingsChange: () => {},
      ...handlers,
    }, { theme: 'white', pageSize: 50 });
    return { screen, ui, calls };
  }
  afterEach(() => {
    for (const s of screens) { try { s.destroy(); } catch {} }
    screens = [];
  });
  const rows = () => ([
    { title: 'song one', url: 'https://www.youtube.com/watch?v=AAA111BBBB22', domain: 'youtube.com', thumb: 'https://i.ytimg.com/vi/AAA111BBBB22/hqdefault.jpg' },
    { title: 'song two', url: 'https://www.youtube.com/watch?v=CCC333DDDD44', domain: 'youtube.com', thumb: 'https://i.ytimg.com/vi/CCC333DDDD44/hqdefault.jpg' },
  ]);
  it('enter plays ONLY the highlighted video (the queue stays explicit)', () => {
    const { screen, ui, calls } = makeYtUI();
    ui.showYouTubePicker(rows(), 'songs');
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.ok(calls.play, 'onPlayVideo fired');
    assert.equal(calls.play[0], 'https://www.youtube.com/watch?v=AAA111BBBB22');
    assert.deepEqual(calls.play[1], [], 'the rest of the list never queues uninvited');
    assert.equal(calls.play[2], 'song one', 'title rides along for the Queued flash');
  });
  it('tab on a data-url thumb renders ascii art without throwing', async () => {
    // Force a plain terminal so the ASCII fallback (not Kitty overlay) runs.
    const savedEnv = {};
    for (const k of ['KITTY_WINDOW_ID', 'KITTY_PID', 'GHOSTTY_RESOURCES_DIR', 'WEZTERM_PANE', 'KONSOLE_VERSION', 'ITERM_SESSION_ID']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    try {
      const { screen, ui } = makeYtUI();
      const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      ui.showYouTubePicker([{ title: 'tiny', url: 'https://www.youtube.com/watch?v=AAA111BBBB22', domain: 'youtube.com', thumb: png1x1 }], 'tiny');
      assert.doesNotThrow(() => screen.emit('keypress', null, { name: 'tab', full: 'tab' }));
      await new Promise((r) => setTimeout(r, 800));
      const texts = [];
      (function walk(el) {
        try {
          if (typeof el.getContent === 'function') texts.push(String(el.getContent()));
        } catch {}
        (el.children || []).forEach(walk);
      })(screen);
      const body = texts.join('\n');
      assert.ok(body.includes('[thumb:'), 'thumbnail marker painted, got: ' + JSON.stringify(body.slice(0, 120)));
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
  it('tab with no thumbnail flashes instead of dying silently', () => {
    const { screen, ui } = makeYtUI();
    ui.showYouTubePicker([{ title: 'nothumb', url: 'https://www.youtube.com/watch?v=AAA111BBBB22', domain: 'youtube.com' }], 'q');
    assert.doesNotThrow(() => screen.emit('keypress', null, { name: 'tab', full: 'tab' }));
  });
});

describe('ui: slash commands typed over open views see the view (ai/play/copy)', () => {
  const blessed = require('blessed');
  const { createUI } = require('../src/ui');
  const { routeCommand } = require('../src/commands');
  const { Navigator } = require('../src/navigation');
  let screens = [];
  function makeWiredUI() {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 'test' });
    screens.push(screen);
    const calls = { play: null, quit: false, submits: [] };
    const navigator = new Navigator({ file: null });
    let ui = null;
    const deps = () => ({
      ui,
      browser: { profileDir: '/tmp/prof', profileReady: () => false, close: async () => {} },
      navigator,
      config: { theme: 'white', pageSize: 50, quality: '480', vo: 'auto' },
      saveConfig: () => {},
      shutdown: () => {},
      navigate: () => {},
      playUrl: (u) => { calls.playUrl = u; },
      getQueue: () => [],
      mpvNext: async () => false,
      mpvStop: async () => false,
    });
    ui = createUI(screen, {
      onOmniSubmit: (value) => {
        calls.submits.push(value);
        if (String(value || '').trim().startsWith('/')) routeCommand(value, deps());
      },
      onSuggest: () => {},
      onLinkPick: () => {},
      onPlayVideo: (url, queue) => { calls.play = [url, queue]; },
      onHistoryBack: () => {},
      onHistoryForward: () => {},
      onEscape: () => {},
      onQuit: () => { calls.quit = true; },
      onSettingsChange: () => {},
    }, { theme: 'white', pageSize: 50 });
    return { screen, ui, calls };
  }
  function bodyText(screen) {
    const texts = [];
    (function walk(el) {
      try {
        if (typeof el.getContent === 'function') texts.push(String(el.getContent()));
      } catch {}
      (el.children || []).forEach(walk);
    })(screen);
    return texts.join('\n');
  }
  // Type a slash command from whatever view is open, exactly like a user:
  // '/' snapshots the view, chars fill the bar, Enter submits.
  function typeSlash(screen, cmd) {
    screen.emit('keypress', '/', { name: 'slash', full: '/' });
    for (const ch of String(cmd).replace(/^\//, '')) {
      screen.emit('keypress', ch, { name: ch, full: ch });
    }
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
  }
  afterEach(() => {
    for (const s of screens) { try { s.destroy(); } catch {} }
    screens = [];
  });
  const ARTICLE = [
    'Python is a high-level general-purpose programming language.',
    'It was created by Guido van Rossum and first released in 1991.',
    'Python emphasizes code readability with its notable use of significant indentation.',
    'Its language constructs and object-oriented approach help programmers write clear code.',
    'Python is dynamically typed and garbage-collected for memory management.',
    'The Python Package Index hosts hundreds of thousands of third-party libraries.',
  ].join(' ');
  const linkRows = () => ([
    { title: 'Cats are small carnivorous mammals kept as beloved pets worldwide', url: 'https://example.com/cats', domain: 'example.com' },
    { title: 'Dogs are loyal domesticated animals known for companionship daily', url: 'https://example.com/dogs', domain: 'example.com' },
    { title: 'Birds are feathered vertebrates that mostly sustain in the sky', url: 'https://example.com/birds', domain: 'example.com' },
  ]);
  it('Alt+Up over an open article shows the source view (no key → local digest)', () => {
    const { screen, ui } = makeWiredUI();
    const or = require('../src/openrouter');
    const realResolve = or.resolveKey;
    try {
      or.resolveKey = () => ''; // force the no-key local path (no network)
      ui.setCenterContent(ARTICLE, []);
      assert.ok(String(ui.getPageText()).length > 100, 'page text is open underneath');
      screen.emit('keypress', null, { name: 'up', full: 'M-up', alt: true });
      const body = bodyText(screen);
      assert.ok(!body.includes('Nothing open to summarize'), 'must not claim nothing is open, got: ' + JSON.stringify(body.slice(0, 200)));
      assert.ok(body.includes('AI answer'), 'fullscreen article answer painted, got: ' + JSON.stringify(body.slice(0, 200)));
    } finally {
      or.resolveKey = realResolve;
    }
  });
  it('Alt+Up over an open link list shows the real answer fullscreen', () => {
    const { screen, ui } = makeWiredUI();
    assert.equal(ui.showLinkPicker(linkRows(), null, 'The results say:\n• Cats are small carnivores kept as pets.\n• Dogs are loyal domesticated companions.'), true);
    ui.setAiAnswer('A rich real answer about cats.');
    screen.emit('keypress', null, { name: 'up', full: 'M-up', alt: true });
    assert.equal(ui.isAiVisible(), true);
    assert.ok(bodyText(screen).includes('AI answer'), 'full answer painted, got: ' + JSON.stringify(bodyText(screen).slice(0, 200)));
  });
  it('Alt+Up on a list prefers the REAL answer over the stale extractive digest', () => {
    const { screen, ui } = makeWiredUI();
    ui.showLinkPicker(linkRows(), null, 'The results say:\n• an extractive bullet that must NOT win.');
    ui.setAiAnswer('Godot is a free and open-source game engine with a node-and-scene system.');
    screen.emit('keypress', null, { name: 'up', full: 'M-up', alt: true });
    const body = bodyText(screen).replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(body.includes('node-and-scene'), 'the real reply is shown fullscreen, got: ' + JSON.stringify(body.slice(0, 200)));
    assert.ok(!body.includes('extractive bullet'), 'the extractive digest must not win');
  });
  it('Alt+Up on an article asks the real LLM and paints its reply', async () => {
    const { screen, ui } = makeWiredUI();
    const or = require('../src/openrouter');
    const realResolve = or.resolveKey;
    const realAsk = or.askAi;
    try {
      or.resolveKey = () => 'AQ.fake-test-key-000';
      let asked = null;
      let resolveReply;
      const gate = new Promise((r) => { resolveReply = r; });
      or.askAi = (q, opts) => { asked = { q, opts }; return gate; };
      ui.setCenterContent('Python is a high-level programming language used widely in data science.', []);
      screen.emit('keypress', null, { name: 'up', full: 'M-up', alt: true });
      assert.ok(bodyText(screen).includes('thinking'), 'placeholder shown while asking');
      assert.ok(asked && /summar/i.test(asked.q), 'asked the AI to summarize');
      assert.ok(asked.opts && asked.opts.style, 'a style contract is passed');
      resolveReply({ ok: true, error: '', text: 'This page explains that Python is a high-level language.\n\n- widely used\n- readable' });
      await gate;
      await new Promise((r) => setImmediate(r));
      const body = bodyText(screen).replace(/\x1b\[[0-9;]*m/g, '');
      // Wrapping can split the phrase across rows and the row border sits
      // between them: strip box art, then compare flat whitespace.
      const flat = body.replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');
      assert.ok(flat.includes('high-level language'), 'real reply painted fullscreen');
      assert.ok(!body.includes('thinking'), 'placeholder replaced');
    } finally {
      or.resolveKey = realResolve;
      or.askAi = realAsk;
    }
  });
  it('the /ai answer view head carries the model (never below the fold)', () => {
    const { screen, ui } = makeWiredUI();
    ui.showGeminiView('A long real answer.\n\n- one\n- two', 'Answer', 'nvidia/nemotron-3-super-120b-a12b:free');
    const head = bodyText(screen).replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(head.includes('Answer — by nemotron 120b'), 'head labels the model, got: ' + JSON.stringify(head.slice(0, 160)));
    // No model (errors, hints): plain head — no dangling attribution.
    ui.showGeminiView('AI request failed: no connection', 'Answer');
    const plain = bodyText(screen).replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(!plain.includes('— by'), 'no model, no attribution');
  });
  it('setAiAnswer fills the bottom box (real answer, model title, line cap)', () => {
    const { screen, ui } = makeWiredUI();
    ui.showLinkPicker(linkRows(), null, 'extractive digest that must not show');
    assert.equal(ui.isAiVisible(), false, 'no box until there is a real answer');
    ui.setAiAnswer('**Godot** is a popular, free game engine.\n\n### Key Features\n\n- free and open source\n- tiny download under 100 MB', { model: 'nvidia/nemotron-3-super-120b-a12b:free' });
    const all = bodyText(screen).replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(all.includes('AI answer — by'), 'title carries the model ("— by …"), got: ' + JSON.stringify(all.slice(0, 120)));
    assert.ok(all.includes('Godot'), 'answer rendered');
    assert.ok(!all.includes('**Godot**'), 'no raw markdown markers');
    assert.ok(!all.includes('extractive digest'), 'the old extractive box is gone');
    assert.ok(!all.includes('━━━ AI answer ━━━'), 'no top-of-list AI header anymore');
    assert.equal(ui.isAiVisible(), true, 'the bottom box owns the real answer');
    // The box caps at AI_ANSWER_LINES rows: the tail is only via Alt+Up.
    assert.ok(!all.includes('download'), 'line cap trims the tail in the box');
    screen.emit('keypress', null, { name: 'up', full: 'M-up', alt: true });
    const full = bodyText(screen).replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(full.includes('download'), 'Alt+Up reveals the full response');
  });
  it('setAiAnswer with no list is a no-op, never throws', () => {
    const { screen, ui } = makeWiredUI();
    assert.doesNotThrow(() => ui.setAiAnswer('hello'));
    assert.ok(!bodyText(screen).includes('AI answer'), 'nothing painted without a list');
  });
  it('pending and error share the bottom box', () => {
    const { screen, ui } = makeWiredUI();
    ui.showLinkPicker(linkRows(), null, 'The results say:\n• Cats are small carnivores kept as pets.');
    ui.setAiAnswerPending();
    assert.ok(bodyText(screen).includes('thinking'), 'pending placeholder visible');
    assert.equal(ui.isAiVisible(), true, 'box shows while thinking');
    ui.setAiAnswerError('your free API quota is over');
    const body = bodyText(screen);
    assert.ok(body.includes('AI answer failed'), 'error surfaced');
    assert.ok(/quota/i.test(body), 'exact reason shown (may wrap)');
    assert.equal(ui.isAiVisible(), true, 'box shows the error');
  });
  it('AI answer box: rounded corners, every row the same width (markdown + wide chars)', () => {
    const { screen, ui } = makeWiredUI();
    const { visLen, visibleCells, verifyBoxContainment } = require('../src/beautify');
    // Pure model: a wide char costs 2 cells, so the box math must stay exact
    // even where the terminal layer may fall back (emoji -> '?' under
    // blessed fullUnicode:false).
    assert.equal(visibleCells('日本語 😀'), 9, 'CJK = 2 cells each, emoji = 2');
    const findContent = (needle) => {
      let found = '';
      (function walk(el) {
        try {
          if (typeof el.getContent === 'function' && String(el.getContent()).includes(needle)) found = String(el.getContent());
        } catch { /* best effort */ }
        (el.children || []).forEach(walk);
      })(screen);
      return found;
    };
    ui.showLinkPicker(linkRows(), null, 'digest');
    ui.setAiAnswer('**Bold** words and a sentence long enough to wrap across the inner border neatly.\n\n## Heading here\n\n- bullet one carrying plenty of words so it wraps\n- bullet two\n\n日本語 かな 汉字 wide chars keep the border straight', { model: 'nvidia/nemotron-3-super-120b-a12b:free' });
    // The bar element is the only one carrying the Alt+Up trailer.
    const bar = findContent('Alt+Up full response');
    const boxLines = bar.split('\n').filter((l) => /^[╭│╰]/.test(l));
    assert.ok(boxLines.length >= 4, 'box painted, got: ' + JSON.stringify(bar.slice(0, 140)));
    assert.ok(boxLines[0].startsWith('╭─ '), 'rounded top corner: ' + JSON.stringify(boxLines[0]));
    assert.ok(boxLines[boxLines.length - 1].startsWith('╰'), 'rounded bottom corner: ' + JSON.stringify(boxLines[boxLines.length - 1]));
    assert.ok(!bar.includes('╔') && !bar.includes('┌─'), 'no heavy/square dressing anymore');
    const w = visLen(boxLines[0]);
    assert.ok(w >= 24, 'sane box width');
    for (const l of boxLines) assert.equal(visLen(l), w, 'row must be exactly ' + w + ' cells: ' + JSON.stringify(l));
    const check = verifyBoxContainment(boxLines.join('\n'), w);
    assert.ok(check.ok, 'containment checker clean: ' + JSON.stringify(check.violations));
    const plain = bar.replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(!plain.includes('**'), 'bold markers rendered, not printed');
    assert.ok(!plain.includes('## '), 'heading markers rendered, not printed');
    // Fullscreen (Alt+Up) uses the same art, uncapped.
    screen.emit('keypress', null, { name: 'up', full: 'M-up', alt: true });
    const full = findContent('Esc collapse');
    const fLines = full.split('\n').filter((l) => /^[╭│╰]/.test(l));
    assert.ok(fLines.length > boxLines.length, 'fullscreen shows more rows than the capped bar');
    const fw = visLen(fLines[0]);
    for (const l of fLines) assert.equal(visLen(l), fw, 'fullscreen row must be exactly ' + fw + ' cells: ' + JSON.stringify(l));
    assert.ok(verifyBoxContainment(fLines.join('\n'), fw).ok, 'fullscreen containment clean');
    const fplain = full.replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(fplain.includes('• '), 'dash bullets become bullet glyphs');
  });
  it('/read does not open a digest and leaves the page mounted', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent(ARTICLE, []);
    typeSlash(screen, '/read');
    assert.ok(bodyText(screen).includes('Python'), 'article still mounted, got: ' + JSON.stringify(bodyText(screen).slice(0, 120)));
    assert.equal(ui.isAiVisible(), false);
  });
  it('/ai typed over an open page shows setup text when no key is saved (no fake digest)', async () => {
    const { screen, ui } = makeWiredUI();
    const or = require('../src/openrouter');
    const realAsk = or.askAi;
    try {
      or.askAi = async () => ({ ok: false, error: or.AI_NO_KEY, text: '' }); // no network
      ui.setCenterContent(ARTICLE, []);
      typeSlash(screen, '/ai');
      await new Promise((r) => setImmediate(r));
      const body = bodyText(screen).replace(/\x1b\[[0-9;]*m/g, '');
      assert.match(body, /OpenRouter API key|openrouter\.ai\/keys/, 'the setup text is what a keyless user sees, got: ' + JSON.stringify(body.slice(0, 160)));
      assert.equal(ui.isAiVisible(), false, 'no digest may open');
    } finally {
      or.askAi = realAsk;
    }
  });
  it('/play typed over an open video list hands off instead of hinting', () => {
    const { screen, ui, calls } = makeWiredUI();
    ui.showLinkPicker([
      { title: 'song one', url: 'https://www.youtube.com/watch?v=AAA111BBBB22', domain: 'youtube.com', video: true },
      { title: 'song two', url: 'https://www.youtube.com/watch?v=CCC333DDDD44', domain: 'youtube.com', video: true },
    ]);
    typeSlash(screen, '/play');
    assert.ok(calls.play, 'onPlayVideo fired');
    assert.equal(calls.play[0], 'https://www.youtube.com/watch?v=AAA111BBBB22');
  });
  it('q types on an empty bar (queen finalize); ctrl+q quits instead', () => {
    const { screen, calls } = makeWiredUI();
    for (const ch of 'queen') screen.emit('keypress', ch, { name: ch, full: ch });
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.equal(calls.quit, false);
    assert.equal(calls.submits.at(-1), 'queen');
    const r2 = makeWiredUI();
    r2.screen.emit('keypress', null, { name: 'q', full: 'C-q', ctrl: true });
    assert.equal(r2.calls.quit, true);
  });
  it('bare /copy typed over an open list copies the highlighted link', async () => {
    const { screen, ui } = makeWiredUI();
    // Stub the clipboard (instant, offline): assert the highlighted URL is
    // what gets handed to it, not pixels in a 1-col headless footer.
    const clip = require('../src/clipboard');
    const real = clip.copyText;
    const seen = [];
    clip.copyText = (t) => { seen.push(String(t)); return Promise.resolve({ ok: true, method: 'test', error: '' }); };
    try {
      ui.showLinkPicker(linkRows());
      typeSlash(screen, '/copy');
      for (let i = 0; i < 20 && !seen.length; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(seen[0], 'https://example.com/cats');
    } finally {
      clip.copyText = real;
    }
    void ui;
  });
});

describe('beautify: markdown-lite to blessed tags', () => {
  const { inlineMd, blockMd } = require('../src/beautify');
  it('inline: bold, code, italic, links, strike', () => {
    assert.equal(inlineMd('**bold**'), '{bold}bold{/}');
    assert.equal(inlineMd('`code`'), '{inverse}code{/}');
    assert.equal(inlineMd('*it*'), '{underline}it{/}');
    assert.equal(inlineMd('[T](https://x.com/a)'), '{bold}{underline}T{/} (https://x.com/a)');
    assert.equal(inlineMd('~~gone~~ here'), 'gone here');
  });
  it('inline: math and snake_case pass through intact', () => {
    assert.equal(inlineMd('a * b = c'), 'a * b = c');
    assert.equal(inlineMd('some_variable_name'), 'some_variable_name');
    assert.equal(inlineMd('plain text'), 'plain text');
    assert.equal(inlineMd(''), '');
  });
  it('block: headings, lists, quotes, fences, rules', () => {
    assert.equal(blockMd('# Title'), '{bold}Title{/}');
    assert.equal(blockMd('## Sub head here'), '{bold}Sub head here{/}');
    assert.equal(blockMd('- item'), '• item');
    assert.equal(blockMd('1. first'), '1. first');
    assert.equal(blockMd('> quoted'), '│ quoted');
    assert.equal(blockMd('```\ncode()\n```'), '  code()');
    assert.equal(blockMd('---'), '─'.repeat(40));
  });
  it('block: pipe tables align, separator dropped', () => {
    const out = blockMd('| a | bb |\n|---|---|\n| c | d |');
    assert.ok(out.includes('a') && out.includes('bb') && out.includes('|'), 'rows kept, got: ' + JSON.stringify(out));
    assert.ok(!out.includes('---'), 'separator row dropped');
  });
  it('block: box borders and blanks survive; never throws', () => {
    assert.equal(blockMd('┌──┐\n│ hi │\n└──┘'), '┌──┐\n│ hi │\n└──┘');
    assert.equal(blockMd('a\n\n\n\nb'), 'a\n\nb');
    assert.doesNotThrow(() => blockMd(null));
    assert.doesNotThrow(() => inlineMd(undefined));
  });
});

describe('ui: ai fullscreen releases keys + article markdown paints', () => {
  const blessed = require('blessed');
  const { createUI } = require('../src/ui');
  const { routeCommand } = require('../src/commands');
  const { Navigator } = require('../src/navigation');
  let screens = [];
  function makeWiredUI() {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 'test' });
    screens.push(screen);
    const calls = { submits: [] };
    const navigator = new Navigator({ file: null });
    let ui = null;
    const deps = () => ({
      ui,
      browser: { profileDir: '/tmp/prof', profileReady: () => false, close: async () => {} },
      navigator,
      config: { theme: 'white', pageSize: 50, quality: '480', vo: 'auto' },
      saveConfig: () => {},
      shutdown: () => {},
      navigate: () => {},
      playUrl: () => {},
      getQueue: () => [],
      mpvNext: async () => false,
      mpvStop: async () => false,
    });
    ui = createUI(screen, {
      onOmniSubmit: (value) => {
        calls.submits.push(value);
        if (String(value || '').trim().startsWith('/')) routeCommand(value, deps());
      },
      onSuggest: () => {},
      onLinkPick: () => {},
      onPlayVideo: () => {},
      onHistoryBack: () => {},
      onHistoryForward: () => {},
      onEscape: () => {},
      onQuit: () => {},
      onSettingsChange: () => {},
    }, { theme: 'white', pageSize: 50 });
    return { screen, ui, calls };
  }
  function bodyText(screen) {
    const texts = [];
    (function walk(el) {
      try {
        if (typeof el.getContent === 'function') texts.push(String(el.getContent()));
      } catch {}
      (el.children || []).forEach(walk);
    })(screen);
    return texts.join('\n');
  }
  function typeSlash(screen, cmd) {
    screen.emit('keypress', '/', { name: 'slash', full: '/' });
    for (const ch of String(cmd).replace(/^\//, '')) {
      screen.emit('keypress', ch, { name: ch, full: ch });
    }
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
  }
  afterEach(() => {
    for (const s of screens) { try { s.destroy(); } catch {} }
    screens = [];
  });
  const ARTICLE = [
    'Python is a high-level general-purpose programming language used widely.',
    'It was created by Guido van Rossum and first released in the year 1991.',
    'Python emphasizes code readability with its notable use of indentation.',
    'Its constructs and object-oriented approach help programmers write clear code.',
    'Python is dynamically typed and garbage-collected for memory management.',
    'The Python Package Index hosts hundreds of thousands of useful libraries.',
  ].join(' ');
  it('/ commands work after the Alt+Up full answer (no trap)', () => {
    const w = makeWiredUI();
    const or = require('../src/openrouter');
    const realResolve = or.resolveKey;
    try {
      or.resolveKey = () => ''; // local path, no network
      w.ui.setCenterContent(ARTICLE, []);
      w.screen.emit('keypress', null, { name: 'up', full: 'M-up', alt: true });
      assert.ok(bodyText(w.screen).includes('AI answer'), 'full answer open');
    } finally {
      or.resolveKey = realResolve;
    }
    typeSlash(w.screen, '/help');
    assert.ok(bodyText(w.screen).includes('/quit'), '/help ran after the fullscreen answer');
  });
  it('article markdown paints as blessed tags, not raw markers', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent('# Big Title\n\nSome **bold claim** and `code here`.\n\n- first point\n- second point', []);
    const body = bodyText(screen);
    // blessed getContent returns rendered escapes: [1m = bold, [7m = inverse.
    assert.ok(body.includes('\x1b[1mBig Title'), 'heading bold, got: ' + JSON.stringify(body.slice(0, 200)));
    assert.ok(body.includes('\x1b[1mbold claim'), 'inline bold');
    assert.ok(body.includes('\x1b[7mcode here'), 'inline code');
    assert.ok(body.includes('• first point'), 'list bullet');
    assert.ok(!body.includes('**bold claim**'), 'no raw markers left');
  });
  it('summarizer no longer clamps at ten sentences', () => {
    const { summarize, splitSentences } = require('../src/ai');
    const sentences = [
      'Cats navigate rooftops at midnight while hunting restless pigeons silently.',
      'Dogs herd sheep across muddy highland pastures every rainy morning.',
      'Birds migrate southward over frozen lakes before winter storms arrive.',
      'Fish spawn upstream beneath waterfalls during spring flood season yearly.',
      'Oak trees drop acorns onto forest floors throughout windy autumn months.',
      'Rivers carve canyons through sandstone cliffs over countless millennia.',
      'Clouds gather above mountain peaks before releasing heavy evening rainfall.',
      'Masons cut granite blocks for cathedral walls using chisels and hammers.',
      'Engineers raise suspension bridges across wide river estuaries nowadays.',
      'Astronomers track comets through telescopes from desert observatories nightly.',
      'Gardeners prune roses and lavender hedges behind cottage walls each June.',
      'Nomads cross deserts riding camels loaded with carpets and copper pots.',
      'Sailors navigate oceans steering schooners past reefs and rocky islands.',
      'Farmers harvest wheat fields with combines under scorching August sunlight.',
      'Beekeepers collect honey from hives hidden among orchard blossoms yearly.',
      'Librarians catalog manuscripts inside vaulted archives beneath old universities.',
      'Chefs simmer broth with leeks, thyme, and pepper in copper stockpots.',
      'Climbers ascend glaciers roped together against avalanches and crevasses.',
      'Divers explore coral reefs photographing turtles, rays, and reef sharks.',
      'Potters fire clay vessels inside brick kilns until glazes turn glossy.',
    ];
    const out = summarize(sentences.join(' '), { maxSentences: 30, maxChars: 50000 });
    assert.ok(splitSentences(out).length > 10, 'more than ten sentences kept, got ' + splitSentences(out).length);
  });
});

describe('pretty: own article renderer (no cli-html)', () => {
  const { renderPretty, renderHtmlText, extractLinkLines, stripAnsi } = require('../src/pretty');
  it('renders headings, links with urls, bullets; no ANSI residue', async () => {
    const html = '<article><h1>Linux</h1><p>Linux is <strong>great</strong>. See <a href="https://example.com/cats">cats</a>.</p><ul><li>free</li><li>open</li></ul></article>';
    const out = await renderPretty(html);
    assert.ok(out && out.length > 50, 'pretty text produced');
    assert.ok(out.includes('# Linux'), 'heading kept, got: ' + JSON.stringify(out.slice(0, 120)));
    assert.ok(out.includes('[https://example.com/cats]'), 'link url marker kept');
    assert.ok(out.includes('free'), 'list kept');
    assert.ok(!out.includes('\x1b'), 'no ANSI residue');
  });
  it('keeps emphasis markers, fences code, borders tables, decodes entities', () => {
    const html = '<h2>Sub</h2><p>A <strong>bold</strong> and <em>it</em> and <code>code</code> &amp; entities.</p><pre><code>x = 1</code></pre><table><tr><th>a</th><th>bb</th></tr><tr><td>c</td><td>d</td></tr></table><script>evil()</script>';
    const out = renderHtmlText(html);
    assert.ok(out.includes('## Sub'), 'h2 marker kept for boxes');
    assert.ok(out.includes('**bold**'), 'bold markers kept');
    assert.ok(out.includes('*it*'), 'italic markers kept');
    assert.ok(out.includes('`code`'), 'code markers kept');
    assert.ok(out.includes('& entities'), 'entity decoded');
    assert.ok(out.includes('```'), 'code fenced');
    assert.ok(out.includes('┌') && out.includes('│') && out.includes('a') && out.includes('bb'), 'bordered table kept');
    assert.ok(!out.includes('evil()'), 'script dropped');
  });
  it('short/empty html yields null; never throws', async () => {
    assert.equal(await renderPretty(''), null);
    assert.equal(await renderPretty('<p>hi</p>'), null);
    assert.equal(await renderPretty(null), null);
  });
  it('extractLinkLines maps first url per line', () => {
    const rows = extractLinkLines('see cats [https://a.com/x] now\nno link here\n[a](https://b.com/y)');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].line, 0);
    assert.equal(rows[0].url, 'https://a.com/x');
    assert.deepEqual(extractLinkLines(''), []);
  });
  it('stripAnsi removes SGR sequences', () => {
    assert.equal(stripAnsi('a\x1b[90mb\x1b[39mc'), 'abc');
  });
});

describe('beautify: sub-topic boxes, markerless links', () => {
  const { boxSections, pairLinks, boxRowOverflow } = require('../src/beautify');
  const sample = [
    '# Cats',
    '',
    'Intro line here.',
    '',
    '## History',
    '',
    'See cats [https://example.com/cats] and dogs [https://example.com/dogs] today.',
    '',
    '- first point',
    '> noted',
    '',
    '## Care',
    '',
    'Feed them well daily.',
  ].join('\n');
  it('link words rendered (no underline in boxes), no visible urls/refs/rails', () => {
    const r = boxSections(sample, { width: 76 });
    assert.equal(r.boxed, true);
    assert.ok(r.text.includes('╭─ History'), 'rounded top border with title');
    assert.ok(r.text.includes('╰'), 'rounded bottom border');
    assert.ok(r.text.includes('See cats'), 'label present without underline, got: ' + JSON.stringify(r.text.slice(0, 500)));
    assert.ok(!r.text.includes('{underline}'), 'no underline tags in boxed content');
    assert.ok(!r.text.includes('[https://'), 'no visible url markers');
    assert.ok(!r.text.includes('[1]'), 'no numeric refs');
    assert.ok(!r.text.includes('example.com/cats'), 'no links rail');
    assert.ok(r.text.includes('│ noted'), 'quote rail inside boxes');
    assert.ok(r.text.includes('• first point'), 'bullets normalized inside boxes');
    assert.deepEqual(r.linkLines.map((l) => l.url), ['https://example.com/cats', 'https://example.com/dogs']);
  });
  it('link mapping points at exact emitted rows', () => {
    const r = boxSections(sample, { width: 76 });
    const rows = r.text.split('\n');
    for (const l of r.linkLines) {
      assert.ok(l.line >= 0 && l.line < rows.length, 'row in range');
    }
    const first = r.linkLines[0];
    assert.ok(rows[first.line].includes('cats'), 'first link row holds its label');
  });
  it('section without links renders padded single column', () => {
    const r = boxSections('# T\n\n## Care\n\nFeed them well daily.\n', { width: 60 });
    assert.equal(r.boxed, true);
    assert.ok(r.text.includes('╭─ Care'), 'box present');
    assert.equal(r.linkLines.length, 0);
    for (const row of r.text.split('\n').filter((l) => l.startsWith('│'))) {
      assert.equal((row.match(/│/g) || []).length, 2, 'borders only, no middle divider: ' + JSON.stringify(row));
    }
  });
  it('no h2 passes through untouched; never throws', () => {
    const { boxSections: bs } = require('../src/beautify');
    const plain = 'Just some\ntext here.';
    const r = bs(plain, { width: 76 });
    assert.equal(r.boxed, false);
    assert.equal(r.text, plain);
    assert.doesNotThrow(() => bs(null));
  });
  it('pairLinks: paired, lone, and plain lines', () => {
    const a = pairLinks('See cats [https://a.com/x] now');
    assert.equal(a.t, '{underline}See cats{/} now');
    assert.deepEqual(a.urls, ['https://a.com/x']);
    const b = pairLinks('[https://a.com/y]');
    assert.equal(b.t, '');
    assert.deepEqual(b.urls, ['https://a.com/y']);
    const c = pairLinks('plain text');
    assert.equal(c.t, 'plain text');
    assert.deepEqual(c.urls, []);
  });
  it('boxRowOverflow: 0 when rows fit, positive overhang otherwise', () => {
    const { boxRowOverflow: over } = require('../src/beautify');
    assert.equal(over('╭─ T ─╮\n│ hi │\n╰────╯', 10), 0);
    assert.ok(over('╭─ T ─╮\n│ hi │\n╰────╯', 5) > 0);
    assert.equal(over('plain\ntext', 3), 0);
  });
  it('every box row fits its width exactly (borders never overrun)', () => {
    const vis = (s) => [...String(s).replace(/\{open\}|\{close\}/g, 'x').replace(/\{[^}]*\}/g, '')].length;
    const pretty = [
      '# T', '', 'Intro line.',
      '## Sec',
      'Body with a veryveryveryveryveryveryveryveryveryveryveryvery longwordhere.',
      '```', 'const x = "averyveryveryveryveryveryveryveryveryveryveryverylongstring";', '```',
      'See [https://example.com/very/long/path/that/keeps/going/on/forever/more] here.',
    ].join('\n');
    for (const W of [76, 60, 44]) {
      const r = boxSections(pretty, { width: W });
      assert.equal(r.boxed, true);
      for (const row of r.text.split('\n')) {
        if (/^[╭╰│]/.test(row)) assert.ok(vis(row) <= W, `row fits ${W}: ` + JSON.stringify(row.slice(0, 60)));
      }
      for (const t of r.text.split('\n').filter((l) => l.startsWith('╭'))) {
        assert.equal(vis(t), W, 'top border exact width');
      }
    }
  });
});

describe('ui: slash palette overlay keeps the page', () => {
  const blessed = require('blessed');
  const { createUI } = require('../src/ui');
  const { routeCommand } = require('../src/commands');
  const { Navigator } = require('../src/navigation');
  let screens = [];
  function makeWiredUI() {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 'test' });
    screens.push(screen);
    const calls = { submits: [] };
    const navigator = new Navigator({ file: null });
    let ui = null;
    const deps = () => ({
      ui,
      browser: { profileDir: '/tmp/prof', profileReady: () => false, close: async () => {} },
      navigator,
      config: { theme: 'white', pageSize: 50, quality: '480', vo: 'auto' },
      saveConfig: () => {},
      shutdown: () => {},
      navigate: () => {},
      playUrl: () => {},
      getQueue: () => [],
      mpvNext: async () => false,
      mpvStop: async () => false,
    });
    ui = createUI(screen, {
      onOmniSubmit: (value) => {
        calls.submits.push(value);
        if (String(value || '').trim().startsWith('/')) routeCommand(value, deps());
      },
      onSuggest: (text, id) => {
        const v = String(text || '');
        if (v.trim().startsWith('/')) {
          const { getCommandSuggestions } = require('../src/suggest');
          ui.renderSuggestRows(getCommandSuggestions(v).map((r) => ({
            title: r.label, domain: r.domain, url: r.url, kind: r.kind, section: r.section,
          })), id);
        }
      },
      onLinkPick: () => {},
      onPlayVideo: () => {},
      onHistoryBack: () => {},
      onHistoryForward: () => {},
      onEscape: () => {},
      onQuit: () => {},
      onSettingsChange: () => {},
    }, { theme: 'white', pageSize: 50 });
    return { screen, ui, calls };
  }
  function bodyText(screen) {
    const texts = [];
    (function walk(el) {
      try {
        if (typeof el.getContent === 'function') texts.push(String(el.getContent()));
      } catch {}
      (el.children || []).forEach(walk);
    })(screen);
    // Strip rendered ANSI: highlight tags split substrings like `/yt`.
    return texts.join('\n').replace(/\[[0-9;]*m/g, '');
  }
  afterEach(() => {
    for (const s of screens) { try { s.destroy(); } catch {} }
    screens = [];
  });
  const ARTICLE = 'A wiki article about penguins living happily together forever.';
  it('palette hidden at boot; / paints the grouped, capped palette over the page', () => {
    const { screen, ui } = makeWiredUI();
    assert.equal(ui.isCommandPaletteVisible(), false);
    ui.setCenterContent(ARTICLE, []);
    screen.emit('keypress', '/', { name: 'slash', full: '/' });
    assert.equal(ui.isCommandPaletteVisible(), true);
    const body = bodyText(screen);
    assert.ok(body.includes('penguins'), 'article still mounted underneath');
    assert.ok(body.includes('/yt'), 'first command shown');
    assert.ok(body.includes('· media'), 'section header shown');
    assert.ok(!body.includes('/quit'), 'windowed: later sections wait their turn');
    assert.ok(!body.includes('/quality') && !body.includes('/login'), 'settings-hub commands never listed');
  });
  it('/read runs from the overlay without destroying the page first', () => {
    const { screen, ui, calls } = makeWiredUI();
    ui.setCenterContent(ARTICLE, []);
    screen.emit('keypress', '/', { name: 'slash', full: '/' });
    for (const ch of 'read') screen.emit('keypress', ch, { name: ch, full: ch });
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.equal(calls.submits.at(-1), '/read');
    assert.equal(ui.isCommandPaletteVisible(), false);
    assert.ok(bodyText(screen).includes('penguins'), 'article still mounted after /read');
  });
  it('arrows walk the palette; enter runs the highlighted command', () => {
    const { screen, ui, calls } = makeWiredUI();
    ui.setCenterContent(ARTICLE, []);
    screen.emit('keypress', '/', { name: 'slash', full: '/' });
    screen.emit('keypress', null, { name: 'down', full: 'down' });
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    // 2nd catalog row is /videos with no videos open -> honest hint.
    assert.ok(bodyText(screen).includes('No videos'), 'highlighted command ran, got: ' + JSON.stringify(calls.submits));
    assert.equal(ui.isCommandPaletteVisible(), false);
  });
  it('esc hides the palette, clears the bar, page intact', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent(ARTICLE, []);
    screen.emit('keypress', '/', { name: 'slash', full: '/' });
    assert.equal(ui.isCommandPaletteVisible(), true);
    screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    assert.equal(ui.isCommandPaletteVisible(), false);
    assert.ok(bodyText(screen).includes('penguins'), 'article intact after cancel');
  });
  it('plain queries never open the palette', () => {
    const { screen, ui } = makeWiredUI();
    for (const ch of 'cats') screen.emit('keypress', ch, { name: ch, full: ch });
    assert.equal(ui.isCommandPaletteVisible(), false);
  });
  it('idle boot / paints the grouped palette into the body, capped, no overlay', async () => {
    const { screen, ui } = makeWiredUI();
    screen.emit('keypress', '/', { name: 'slash', full: '/' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ui.isCommandPaletteVisible(), false);
    const body = bodyText(screen);
    assert.ok(body.includes('/yt'), 'palette head shown');
    assert.ok(body.includes('· media'), 'sections in the body view too');
    assert.ok(!body.includes('/quit'), 'capped: the tail is reached by arrowing');
    assert.ok(!body.includes('/login'), 'settings-hub commands stay out');
  });
  it('overlay ends with a disconnect rule under the palette', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent(ARTICLE, []);
    screen.emit('keypress', '/', { name: 'slash', full: '/' });
    assert.equal(ui.isCommandPaletteVisible(), true);
    const rule = bodyText(screen).split('\n').some((l) => /^─{10,}$/.test(l.trim()));
    assert.ok(rule, 'disconnect rule painted under suggestions');
  });
  it('/game opens the piano: box, stats, lane keys play, esc restores the page', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent(ARTICLE, []);
    screen.emit('keypress', '/', { name: 'slash', full: '/' });
    for (const ch of 'game') screen.emit('keypress', ch, { name: ch, full: ch });
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.equal(ui.isGameOpen(), true, 'the piano cabinet opened from /game');
    let body = bodyText(screen);
    assert.ok(body.includes('Piano —'), 'rounded box title');
    assert.ok(body.includes('Random songs — '), 'plain /game is random by default');
    const allNames = ['Prelude', 'Ode to Joy', 'Für Elise', 'Tetris', 'Moonlight', 'Twinkle', 'Jingle', 'Rush E', 'Megalovania', 'Mario'];
    assert.ok(allNames.some((n) => body.includes('Piano — ' + n)), 'one of the ten songs is playing');
    assert.ok(body.includes('SCORE 0'), 'stats row');
    assert.ok(body.includes('LIVES ♥'), 'lives on the stats row');
    // The hearts must not skew the box: every painted row reaches the same
    // right-border column (hearts once measured two cells wide, which
    // pulled the stats row's border three cells in).
    {
      const lines = body.split('\n');
      const top = lines.findIndex((l) => l.includes('╭'));
      const bot = lines.findIndex((l, i) => i > top && l.includes('╰'));
      assert.ok(top >= 0 && bot > top, 'the box is on screen');
      const left = lines[top].indexOf('╭');
      const right = lines[top].indexOf('╮');
      assert.ok(right > left + 2, 'the top edge has both corners');
      for (let i = top + 1; i <= bot; i++) {
        assert.equal(lines[i][left], i === bot ? '╰' : '│', `left border, row ${i - top}`);
        assert.equal(lines[i][right], i === bot ? '╯' : '│', `right border, row ${i - top}: ${JSON.stringify(lines[i])}`);
      }
    }
    assert.ok(body.includes('A S D F'), 'controls are spelled out');
    // Every lane key (and r) must stay inside the modal — a press with no
    // ball near the line is free, so an empty board eats them quietly.
    for (const ch of 'asdfjkl;') screen.emit('keypress', ch, { name: ch, full: ch });
    screen.emit('keypress', 'r', { name: 'r', full: 'r' });
    body = bodyText(screen);
    assert.ok(body.includes('SCORE 0'), 'still a live field after lane keys/restart');
    assert.ok(ui.isGameOpen(), 'lane keys and r do not close the arcade');
    screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    assert.equal(ui.isGameOpen(), false, 'esc closes the arcade');
    assert.ok(bodyText(screen).includes('penguins'), 'page restored underneath');
  });
  it('the piano takes m mute, p free play and the song digits', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent(ARTICLE, []);
    screen.emit('keypress', '/', { name: 'slash', full: '/' });
    for (const ch of 'game') screen.emit('keypress', ch, { name: ch, full: ch });
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.equal(ui.isGameOpen(), true);
    let body = bodyText(screen);
    assert.ok(body.includes('A S D F'), 'lane keys are spelled out (hint survives)');
    assert.ok(!body.includes('muted'), 'starts unmuted');
    screen.emit('keypress', 'm', { name: 'm', full: 'm' });
    body = bodyText(screen);
    assert.ok(body.includes('muted'), 'mute state shows on the hint');
    screen.emit('keypress', 'm', { name: 'm', full: 'm' });
    body = bodyText(screen);
    assert.ok(!body.includes('muted'), 'm toggles back');
    assert.ok(ui.isGameOpen(), 'm does not close the piano');
    screen.emit('keypress', 'p', { name: 'p', full: 'p' });
    body = bodyText(screen);
    assert.ok(body.includes('FREE PLAY'), 'p toggles free play');
    assert.ok(body.includes('Piano — free play'), 'free-play title');
    screen.emit('keypress', 'p', { name: 'p', full: 'p' });
    body = bodyText(screen);
    assert.ok(!body.includes('FREE PLAY'), 'p toggles back to songs');
    screen.emit('keypress', '2', { name: '2', full: '2' });
    body = bodyText(screen);
    assert.ok(body.includes('Ode to Joy'), '2 starts song 2');
    screen.emit('keypress', '3', { name: '3', full: '3' });
    body = bodyText(screen);
    assert.ok(body.includes('Elise'), '3 starts Für Elise');
    screen.emit('keypress', '4', { name: '4', full: '4' });
    body = bodyText(screen);
    assert.ok(body.includes('Tetris'), '4 starts the Tetris theme');
    screen.emit('keypress', '9', { name: '9', full: '9' });
    body = bodyText(screen);
    assert.ok(body.includes('Megalovania'), '9 starts Megalovania');
    screen.emit('keypress', '0', { name: '0', full: '0' });
    body = bodyText(screen);
    assert.ok(body.includes('Mario'), '0 starts the tenth song');
    screen.emit('keypress', '*', { name: '*', full: '*' });
    body = bodyText(screen);
    assert.ok(body.includes('Random songs — '), '* turns on random songs');
    screen.emit('keypress', '5', { name: '5', full: '5' });
    body = bodyText(screen);
    assert.ok(body.includes('Moonlight'), 'a digit takes over from random');
    assert.ok(ui.isGameOpen(), 'song picks do not close the piano');
    screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    assert.equal(ui.isGameOpen(), false, 'esc closes the piano');
  });
  it('/game free opens free play, /game 2 and /game 10 start songs', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent(ARTICLE, []);
    const run = (text) => {
      screen.emit('keypress', '/', { name: 'slash', full: '/' });
      for (const ch of text) screen.emit('keypress', ch, { name: ch === ' ' ? 'space' : ch, full: ch });
      screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    };
    run('game free');
    assert.equal(ui.isGameOpen(), true, '/game free opens the cabinet');
    assert.ok(bodyText(screen).includes('FREE PLAY'), 'free-play mode');
    screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    assert.equal(ui.isGameOpen(), false);
    run('game 2');
    assert.equal(ui.isGameOpen(), true);
    assert.ok(bodyText(screen).includes('Ode to Joy'), '/game 2 starts song 2');
    screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    run('game 10');
    assert.equal(ui.isGameOpen(), true, '/game 10 opens the piano');
    assert.ok(bodyText(screen).includes('Mario'), '/game 10 starts the tenth song');
    screen.emit('keypress', null, { name: 'escape', full: 'escape' });
  });
  it('showGame without a kind is the offline consolation: the piano cabinet', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent(ARTICLE, []);
    assert.equal(ui.showGame({ head: 'Error: no internet', note: 'No internet — the arcade works offline. Esc returns to the error.' }), true);
    assert.equal(ui.isGameOpen(), true, 'offline errors land on the piano cabinet');
    const body = bodyText(screen);
    assert.ok(body.includes('Piano —'), 'same cabinet as /game');
    assert.ok(body.includes('no internet'), 'the error text stays as the header');
    screen.emit('keypress', 'q', { name: 'q', full: 'q' }); // non-lane key -> search
    assert.equal(ui.isGameOpen(), false);
  });
  it('typing a non-lane key at the piano escapes into a fresh search', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent(ARTICLE, []);
    screen.emit('keypress', '/', { name: 'slash', full: '/' });
    for (const ch of 'game') screen.emit('keypress', ch, { name: ch, full: ch });
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.equal(ui.isGameOpen(), true);
    screen.emit('keypress', 'c', { name: 'c', full: 'c' });
    assert.equal(ui.isGameOpen(), false, 'typing closed the arcade');
    assert.ok(bodyText(screen).includes('penguins'), 'page intact behind the search');
  });
  it('/pong opens the table: box, stats, keys nudge, esc restores the page', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent(ARTICLE, []);
    screen.emit('keypress', '/', { name: 'slash', full: '/' });
    for (const ch of 'pong') screen.emit('keypress', ch, { name: ch, full: ch });
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.equal(ui.isGameOpen(), true, 'pong opened from /pong');
    let body = bodyText(screen);
    assert.ok(body.includes('Pong'), 'rounded box title');
    assert.ok(body.includes('LEVEL 1'), 'stats row');
    assert.ok(body.includes('YOU 0'), 'match score');
    assert.ok(body.includes('▌'), 'player paddle is on the field');
    assert.ok(body.includes('↑/↓'), 'controls are spelled out');
    // Play keys must not close the table (↑/↓, k/j, r all stay inside).
    screen.emit('keypress', null, { name: 'down', full: 'down' });
    screen.emit('keypress', 'k', { name: 'k', full: 'k' });
    screen.emit('keypress', 'r', { name: 'r', full: 'r' });
    body = bodyText(screen);
    assert.ok(body.includes('LEVEL 1'), 'still a live table after nudging/restart');
    assert.ok(ui.isGameOpen(), 'r restarts the run, it does not close');
    screen.emit('keypress', null, { name: 'escape', full: 'escape' });
    assert.equal(ui.isGameOpen(), false, 'esc closes pong');
    assert.ok(bodyText(screen).includes('penguins'), 'page restored underneath');
  });
  it('/pingpong alias opens the same table; typing escapes into search', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent(ARTICLE, []);
    screen.emit('keypress', '/', { name: 'slash', full: '/' });
    for (const ch of 'pingpong') screen.emit('keypress', ch, { name: ch, full: ch });
    screen.emit('keypress', null, { name: 'enter', full: 'enter' });
    assert.equal(ui.isGameOpen(), true, 'alias /pingpong opens the table');
    assert.ok(bodyText(screen).includes('LEVEL 1'));
    screen.emit('keypress', 'x', { name: 'x', full: 'x' });
    assert.equal(ui.isGameOpen(), false, 'typing closed the table');
    assert.ok(bodyText(screen).includes('penguins'), 'page intact behind the search');
  });
  it('the footer clock ticks HH:MM and the dashboard heading carries a date stamp', () => {
    const { screen, ui } = makeWiredUI();
    assert.match(bodyText(screen), /\b\d{2}:\d{2}\b/, 'footer clock painted');
    ui.showHome([{ title: 'Example', url: 'https://example.com', domain: 'example.com' }]);
    assert.match(bodyText(screen), /\b\d{2}:\d{2}\b/, 'dashboard stamp painted');
    const { formatClock, formatDateShort } = require('../src/ui');
    assert.equal(formatClock(new Date(2026, 9, 16, 9, 5)), '09:05', 'zero-padded 24h');
    assert.equal(formatClock(new Date(2026, 9, 16, 23, 59)), '23:59');
    assert.equal(formatDateShort(new Date(2026, 9, 16)), 'Fri 16 Oct');
  });
  it('the now-playing row docks above the hint row and clears on empty', () => {
    const { screen, ui } = makeWiredUI();
    ui.setCenterContent(ARTICLE, []);
    assert.equal(ui.setNowPlaying('♪ 1:22 / 3:40 · Test Track · 720p'), true);
    const body = bodyText(screen);
    assert.ok(body.includes('♪ 1:22 / 3:40'), 'row painted with player truth');
    assert.ok(body.includes('Test Track'), 'title on the row');
    ui.setNowPlaying('');
    assert.ok(!bodyText(screen).includes('Test Track'), 'cleared row leaves no chrome');
  });
});

describe('ui: pretty article view wins over spans', () => {
  const blessed = require('blessed');
  const { createUI } = require('../src/ui');
  let screens = [];
  function makeUI() {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 'test' });
    screens.push(screen);
    const ui = createUI(screen, {
      onOmniSubmit: () => {},
      onSuggest: () => {},
      onLinkPick: () => {},
      onPlayVideo: () => {},
      onHistoryBack: () => {},
      onHistoryForward: () => {},
      onEscape: () => {},
      onQuit: () => {},
      onSettingsChange: () => {},
    }, { theme: 'white', pageSize: 50 });
    return { screen, ui };
  }
  function bodyText(screen) {
    const texts = [];
    (function walk(el) {
      try {
        if (typeof el.getContent === 'function') texts.push(String(el.getContent()));
      } catch {}
      (el.children || []).forEach(walk);
    })(screen);
    return texts.join('\n');
  }
  afterEach(() => {
    for (const s of screens) { try { s.destroy(); } catch {} }
    screens = [];
  });
  const PRETTY = [
    '# Linux',
    '',
    'Linux is great.',
    '',
    '## History',
    '',
    'Created by Linus [https://en.wikipedia.org/wiki/Linus_Torvalds] in 1991.',
  ].join('\n');
  it('spans + pretty shows the boxed pretty view (the wiki bug)', () => {
    const { screen, ui } = makeUI();
    ui.setCenterContent('fallback text', [{ title: 'l', url: 'https://x.com', domain: 'x.com' }],
      [{ t: 'old spans view text here', url: null }], { images: [], videos: [] }, null, null, PRETTY);
    const body = bodyText(screen);
    assert.ok(body.includes('╭─ History'), 'sub-topic box painted, got: ' + JSON.stringify(body.slice(0, 300)));
    assert.ok(!body.includes('old spans view text here'), 'spans view replaced');
    assert.ok(body.includes('Linus'), 'content kept');
  });
  it('spans without pretty keep the classic view', () => {
    const { screen, ui } = makeUI();
    ui.setCenterContent('fallback text', [],
      [{ t: 'classic spans view text here', url: null }], { images: [], videos: [] }, null, null, null);
    assert.ok(bodyText(screen).includes('classic spans view text here'));
  });
  it('boxes have breathing room: blank padded rows inside', () => {
    const { screen, ui } = makeUI();
    ui.setCenterContent('fallback', [], [], { images: [], videos: [] }, null, null, PRETTY);
    const rows = bodyText(screen).split('\n');
    const pad = rows.filter((l) => /^│\s+│$/.test(l.replace(/\x1b\[[0-9;]*m/g, '')));
    assert.ok(pad.length >= 2, 'top + bottom padding rows, got: ' + JSON.stringify(rows.slice(0, 12).join('|').slice(0, 300)));
  });
  it('boxes survive Esc-restore (showText repaints pretty)', () => {
    const { screen, ui } = makeUI();
    ui.setCenterContent('fallback', [], [], { images: [], videos: [] }, null, null, PRETTY);
    ui.resetFocus();
    assert.ok(bodyText(screen).includes('╭─ History'), 'boxes kept after restore');
  });
  it('tab into images keeps boxes and shows the split divider', () => {
    const { screen, ui } = makeUI();
    ui.setCenterContent('fallback', [], [],
      { images: [{ src: 'https://x.com/a.png', alt: 'pic' }], videos: [] }, null, null, PRETTY);
    // Tab straight from the article: split opens, body re-measures narrow.
    screen.emit('keypress', null, { name: 'tab', full: 'tab' });
    assert.ok(ui.isGalleryOpen(), 'split open');
    assert.ok(ui.isSplitVisible(), 'vertical divider visible between webview and image');
    assert.ok(bodyText(screen).includes('╭─ History'), 'boxes kept after split opens');
  });
});

describe('download: dir override (default ~/Downloads)', () => {
  const dl = require('../src/downloads');
  function stubFetchBytes(byte = 7) {
    global.fetch = async () => ({
      ok: true,
      body: {
        getReader: () => {
          let i = 0;
          return {
            read: async () => (i++ === 0 ? { done: false, value: Buffer.from([byte]) } : { done: true, value: undefined }),
            cancel: async () => {},
          };
        },
      },
      headers: { get: () => 'image/png' },
    });
  }
  it('expandHome handles ~, ~/x, absolute', () => {
    const os = require('node:os');
    assert.equal(dl.expandHome('~'), os.homedir());
    assert.equal(dl.expandHome('~/pics'), path.join(os.homedir(), 'pics'));
    assert.equal(dl.expandHome('/tmp/x'), '/tmp/x');
  });
  it('dest dir (existing, trailing slash, fresh nested) all land inside', async () => {
    stubFetchBytes();
    const base = tmpDir();
    const existing = path.join(base, 'pics');
    fs.mkdirSync(existing);
    const r1 = await dl.downloadUrl('https://x.com/a.png', { dest: existing });
    assert.equal(r1.ok, true);
    assert.ok(r1.path.startsWith(existing + path.sep), r1.path);
    assert.ok(fs.existsSync(r1.path));
    const r2 = await dl.downloadUrl('https://x.com/b.png', { dest: existing + path.sep });
    assert.equal(r2.ok, true);
    assert.ok(r2.path.startsWith(existing + path.sep), r2.path);
    const fresh = path.join(base, 'new', 'deep') + path.sep;
    const r3 = await dl.downloadUrl('https://x.com/c.png', { dest: fresh });
    assert.equal(r3.ok, true);
    assert.ok(r3.path.startsWith(path.join(base, 'new', 'deep') + path.sep), r3.path);
    assert.ok(fs.existsSync(r3.path));
  });
  it('no dest defaults under ~/Downloads', async () => {
    stubFetchBytes();
    const home = tmpDir();
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const r = await dl.downloadUrl('https://x.com/d.png', {});
      assert.equal(r.ok, true);
      assert.ok(r.path.startsWith(path.join(home, 'Downloads') + path.sep), r.path);
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
    }
  });
  it('/download <n> [<dir>] routes the dir through', async () => {
    stubFetchBytes();
    const { routeCommand } = require('../src/commands');
    const dir = tmpDir();
    const { calls, deps } = mockDeps();
    deps.ui.galleryRows = () => [{ title: '1. pic', url: 'https://x.com/p.png', domain: 'x.com' }];
    deps.ui.videoRows = () => [];
    routeCommand(`/download 1 ${dir}`, deps);
    let body = '';
    for (let i = 0; i < 40 && !body.includes(dir); i++) {
      await new Promise((r) => setTimeout(r, 100));
      body = calls.content.map((c) => c.text).join('\n');
    }
    assert.ok(body.includes(dir), 'saved path under dir, got: ' + JSON.stringify(body.slice(0, 200)));
    assert.ok(body.includes('Saved:'), 'success message');
  });
});

describe('yt: sameVideoUrl identity', () => {
  const yt = require('../src/yt');
  it('youtube forms compare by id', () => {
    assert.equal(yt.sameVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ'), true);
    assert.equal(yt.sameVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ?x=1'), true);
    assert.equal(yt.sameVideoUrl('https://www.youtube.com/watch?v=AAA111BBBB22', 'https://www.youtube.com/watch?v=CCC333DDDD44'), false);
  });
  it('non-youtube compares exact, empty never matches', () => {
    assert.equal(yt.sameVideoUrl('https://cdn.com/v.mp4', 'https://cdn.com/v.mp4'), true);
    assert.equal(yt.sameVideoUrl('https://cdn.com/a.mp4', 'https://cdn.com/b.mp4'), false);
    assert.equal(yt.sameVideoUrl('', 'https://cdn.com/v.mp4'), false);
    assert.equal(yt.sameVideoUrl(null, null), false);
  });
});

describe('ui: showVideos marks now playing', () => {
  const blessed = require('blessed');
  const { createUI } = require('../src/ui');
  let screens = [];
  function makeUI() {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 'test' });
    screens.push(screen);
    const ui = createUI(screen, {
      onOmniSubmit: () => {},
      onSuggest: () => {},
      onLinkPick: () => {},
      onPlayVideo: () => {},
      onHistoryBack: () => {},
      onHistoryForward: () => {},
      onEscape: () => {},
      onQuit: () => {},
      onSettingsChange: () => {},
    }, { theme: 'white', pageSize: 50 });
    return { screen, ui };
  }
  function bodyText(screen) {
    const texts = [];
    (function walk(el) {
      try {
        if (typeof el.getContent === 'function') texts.push(String(el.getContent()));
      } catch {}
      (el.children || []).forEach(walk);
    })(screen);
    return texts.join('\n');
  }
  afterEach(() => {
    for (const s of screens) { try { s.destroy(); } catch {} }
    screens = [];
  });
  const MEDIA = {
    images: [],
    videos: [
      { src: 'https://www.youtube.com/watch?v=AAA111BBBB22', title: 'song one' },
      { src: 'https://www.youtube.com/watch?v=CCC333DDDD44', title: 'song two' },
    ],
  };
  it('matching row gets ▶, others untouched; no mark unchanged', () => {
    const { screen, ui } = makeUI();
    ui.setCenterContent('article', [], [], MEDIA, null, null, null);
    assert.equal(ui.showVideos({ url: 'https://youtu.be/CCC333DDDD44' }), true);
    const body = bodyText(screen);
    assert.ok(body.includes('▶ 2. song'), 'now-playing marked, got: ' + JSON.stringify(body.slice(0, 300)));
    assert.ok(!body.includes('▶ 1.'), 'only the match marked');
    const r2 = makeUI();
    r2.ui.setCenterContent('article', [], [], MEDIA, null, null, null);
    assert.equal(r2.ui.showVideos(null), true);
    assert.ok(!bodyText(r2.screen).includes('▶'), 'no mark without state');
  });
  it('direct-stream mark falls back to the queued head', () => {
    const { screen, ui } = makeUI();
    ui.setCenterContent('article', [], [], MEDIA, null, null, null);
    ui.showVideos({ url: 'https://rr1---sn.googlevideo.com/videoplayback?x=1', fallbackUrl: 'https://www.youtube.com/watch?v=AAA111BBBB22' });
    assert.ok(bodyText(screen).includes('▶ 1. song'), 'fallback marks the queued head');
  });
});

describe('commands: /videos now-playing wiring', () => {
  const { routeCommand } = require('../src/commands');
  const tick = () => new Promise((r) => setTimeout(r, 20));
  it('live player answer wins over the queued head', async () => {
    const { calls, deps } = mockDeps();
    let mark = null;
    deps.ui.showVideos = (m) => { mark = m; return true; };
    deps.getNowPlaying = () => ({ url: 'https://www.youtube.com/watch?v=AAA111BBBB22', title: '' });
    deps.mpvNowPlaying = async () => ({ url: 'https://www.youtube.com/watch?v=CCC333DDDD44', title: 'two', paused: false });
    routeCommand('/videos', deps);
    await tick();
    await tick();
    assert.ok(mark, 'showVideos called');
    assert.equal(mark.url, 'https://www.youtube.com/watch?v=CCC333DDDD44');
    assert.equal(mark.fallbackUrl, 'https://www.youtube.com/watch?v=AAA111BBBB22');
    void calls;
  });
  it('no live answer keeps the queued head; empty shows hint', async () => {
    const { calls, deps } = mockDeps();
    let mark = 'unset';
    deps.ui.showVideos = (m) => { mark = m; return true; };
    deps.getNowPlaying = () => ({ url: 'https://cdn.com/v.mp4', title: '' });
    deps.mpvNowPlaying = async () => null;
    routeCommand('/videos', deps);
    await tick();
    await tick();
    assert.equal(mark && mark.url, 'https://cdn.com/v.mp4');
    const c2 = mockDeps();
    c2.deps.ui.showVideos = () => false;
    routeCommand('/videos', c2.deps);
    assert.ok(c2.calls.content.some((c) => c.text.includes('No videos on this page')));
    void calls;
  });
});

describe('commands: /bookmark merge + /video alias', () => {
  const { routeCommand } = require('../src/commands');
  it('/bookmark <title> saves the open page (whole arg is the title)', () => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpDir();
    try {
      const { calls, deps } = mockDeps({ currentUrl: () => 'https://example.com/article' });
      routeCommand('/bookmark My Great Title', deps);
      const list = require('../src/downloads').loadBookmarks();
      const hit = list.find((b) => b.url === 'https://example.com/article');
      assert.ok(hit, 'bookmark saved by the singular alias');
      assert.equal(hit.title, 'My Great Title', 'the whole arg is the title');
      assert.ok(calls.content.some((c) => String(c.text).includes('Webpage added to bookmarks')), JSON.stringify(calls.content));
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
    }
  });
  it('/bookmarks add <title> does the same; bare /bookmarks lists', () => {
    const oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpDir();
    try {
      const { calls, deps } = mockDeps({ currentUrl: () => 'https://example.com/two' });
      routeCommand('/bookmarks add Second Title', deps);
      assert.ok(require('../src/downloads').loadBookmarks().some((b) => b.url === 'https://example.com/two'));
      const l = mockDeps();
      routeCommand('/bookmarks', l.deps);
      assert.ok(l.calls.content.some((c) => String(c.text).includes('Second Title')), JSON.stringify(l.calls.content));
      void calls;
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
    }
  });
  it('/video routes into the videos handler (forgiving alias)', () => {
    const { calls, deps } = mockDeps();
    deps.ui.showVideos = () => false;
    routeCommand('/video', deps);
    assert.ok(calls.content.some((c) => String(c.text).includes('No videos on this page')), JSON.stringify(calls.content));
  });
});

// ============================================================
// image.js — local-file bytes (PDF pages) + fullscreen fitting
// ============================================================
describe('image: local files + overlay fitting', () => {
  const image = require('../src/image');
  it('fetchBytes reads an absolute local path without any fetch', async () => {
    const f = path.join(tmpDir(), 'pixel.png');
    fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]));
    const buf = await image.fetchBytes(f, { cache: true });
    assert.ok(buf && buf.length === 16, 'bytes came from disk');
    assert.equal(buf.contentType, 'image/png', 'format sniffed');
  });
  it('fetchBytes refuses missing files and oversized files', async () => {
    assert.equal(await image.fetchBytes(path.join(tmpDir(), 'nope.png')), null);
    const big = path.join(tmpDir(), 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(4096));
    assert.equal(await image.fetchBytes(big, { maxBytes: 1024 }), null, 'bounded by maxBytes');
  });
  it('fitOverlay: cap:false escapes the 60x40 thumbnail clamp (fullscreen)', () => {
    const wide = { w: 10000, h: 500 };
    assert.deepEqual(image.fitOverlay(wide, { maxCols: 200, maxRows: 100, cap: false }), { cols: 200 });
    assert.deepEqual(image.fitOverlay(wide, { maxCols: 200, maxRows: 100, cap: true }), { cols: 60 });
  });
  it('cellFootprint derives the free dimension from the native aspect', () => {
    assert.deepEqual(image.cellFootprint({ w: 100, h: 100 }, { cols: 20 }), { cols: 20, rows: 10 });
    assert.deepEqual(image.cellFootprint({ w: 200, h: 100 }, { rows: 10 }), { cols: 40, rows: 10 });
    assert.deepEqual(image.cellFootprint(null, { cols: 30 }), { cols: 30, rows: 15 });
  });
  it('applyRotation: 0 is a pass-through; undecodable bytes never throw', async () => {
    const junk = Buffer.from('not-a-real-png');
    assert.equal(await image.applyRotation(junk, 0), junk, '0° returns the same buffer');
    assert.equal(await image.applyRotation(junk, 90), junk, 'undecodable input falls back untouched');
    assert.equal(await image.applyRotation(null, 90), null);
  });
  it('applyRotation: 90° swaps the pixel dimensions (real sharp)', async () => {
    let sharp = null;
    try { sharp = require('sharp'); } catch { /* no decoder: pass-through covered above */ }
    if (!sharp) return;
    const png = await sharp({ create: { width: 4, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
    assert.deepEqual(image.pngSize(png), { w: 4, h: 2 });
    const rot = await image.applyRotation(png, 90);
    assert.deepEqual(image.pngSize(rot), { w: 2, h: 4 }, 'dimensions swap');
  });
});
