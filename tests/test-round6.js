'use strict';
/* Reactive spectrum v2 (no new system deps): scripts/vizspectrum.py
 * (stdlib + system numpy only) turns the monitor mix into per-band levels;
 * the UI renders real frequency bars, bands winning over the loudness
 * envelope, envelope over synthetic. RMS tap stays as the fallback.
 * Latency fix in the same change: capture measured at 1-6 ms, so the old
 * lag was 100 ms frames + slow attack — attack is now 0.8 (96% in two
 * frames) and spectrum hops at 50 ms.
 * Run: node --test --test-force-exit tests/test-round6.js
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const cp = require('node:child_process');

const audio = require('../src/vizAudio');
const uiMod = require('../src/ui');

const stripTags = (s) => String(s).replace(/\{[^}]*\}/g, '').replace(/\x1b\[[0-9;]*m/g, '');

const SCRIPT = require.resolve('../scripts/vizspectrum.py');
let hasNumpy = false;
try {
  cp.execFileSync('python3', ['-c', 'import numpy'], { timeout: 15000 });
  hasNumpy = true;
} catch { /* suite still proves the Node side without numpy */ }

function sineRaw(freq, secs, amp, sr = 8000) {
  const n = Math.floor(sr * secs);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(32767 * amp * Math.sin((2 * Math.PI * freq * i) / sr)), i * 2);
  }
  return buf;
}
function runScript(raw) {
  return cp.spawnSync('python3', [SCRIPT, '--stdin'], { input: raw, timeout: 30000 });
}
const framesOf = (res) => String(res.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => l.split(';').map(Number));

describe('vizspectrum.py: bass-only bars, no new deps', { skip: !hasNumpy }, () => {
  it('bass lights low bands; treble reads all-zero (default mode)', () => {
    const raw = Buffer.concat([sineRaw(100, 2, 0.8), sineRaw(2000, 2, 0.8)]);
    const res = runScript(raw);
    assert.equal(res.status, 0, `exit 0 (stderr: ${String(res.stderr || '').slice(0, 200)})`);
    const frames = framesOf(res);
    assert.ok(frames.length >= 60 && frames.length <= 100, `${frames.length} frames @20Hz for 4s`);
    for (const f of frames) {
      assert.equal(f.length, 8, '8 bass bands per frame by default');
      for (const v of f) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1000, `0..1000, got ${v}`);
    }
    const bass = frames[10]; // deep in the 100 Hz half
    assert.ok(bass[3] > 800 && bass[4] > 800, `bass bands hot: ${bass}`);
    assert.ok(Math.max(...bass.slice(5)) < 100, `upper bass bands dark: ${bass.slice(5)}`);
    const treb = frames[frames.length - 3]; // deep in the 2 kHz half
    assert.ok(Math.max(...treb) < 100, `treble invisible in bass mode: ${treb}`);
  });
  it('kick hits pulse against quiet (readable beat, not shimmer)', () => {
    const sr = 8000;
    const n = sr * 4;
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let v = 0.25 * Math.sin((2 * Math.PI * 2000 * i) / sr); // constant shimmer
      for (const k of [0, 1, 2, 3]) {
        const dt = t - k;
        if (dt >= 0 && dt < 0.3) v += 0.9 * Math.sin((2 * Math.PI * 60 * i) / sr) * Math.exp(-dt * 18);
      }
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(32767 * v))), i * 2);
    }
    const frames = framesOf(runScript(buf));
    const peaks = frames.map((f) => Math.max(...f));
    assert.ok(Math.max(...peaks) > 700, 'hits punch through');
    assert.ok(peaks.filter((v) => v < 150).length > peaks.length / 2, 'most frames rest quiet');
  });
  it('a 100 ms kick clears fast (sync: ~250 ms tail, not a 550 ms glow)', () => {
    const sr = 8000;
    const n = sr * 4;
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      // One isolated burst at t=2.0–2.1 s inside silence (frame ~40 @20Hz).
      const v = (t >= 2.0 && t < 2.1) ? 0.9 * Math.sin((2 * Math.PI * 60 * i) / sr) : 0;
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(32767 * v))), i * 2);
    }
    const frames = framesOf(runScript(buf));
    assert.ok(Math.max(...frames[39], ...frames[40], ...frames[41]) > 800, 'attack still instant');
    const tail = frames.slice(52); // 500 ms after the burst ended
    assert.ok(tail.length > 10, 'enough tail frames to judge');
    assert.ok(tail.every((f) => Math.max(...f) === 0), 'tail fully clear (no smear into the next beat)');
  });
  it('--full keeps the 16-band spectrum (opt-out pinned)', () => {
    const res = cp.spawnSync('python3', [SCRIPT, '--stdin', '--full'], { input: sineRaw(2000, 2, 0.8), timeout: 30000 });
    assert.equal(res.status, 0);
    const frames = framesOf(res);
    assert.equal(frames[0].length, 16, 'full mode has 16 bands');
    const last = frames[frames.length - 2];
    assert.ok(last[13] > 800, `2 kHz hot in full mode: ${last.slice(12)}`);
  });
  it('no startup flash; silence reads all-zero', () => {
    const raw = Buffer.concat([sineRaw(100, 2, 0.8), sineRaw(2000, 2, 0.8)]);
    const frames = framesOf(runScript(raw));
    const f1 = frames[1]; // second frame: AGC already settled
    assert.ok(Math.max(...f1.slice(6)) < 200, `no full-scale flash on frame 1: ${f1.slice(6)}`);
    const sil = framesOf(runScript(Buffer.alloc(8000 * 2 * 2)));
    assert.ok(sil.length > 0, 'silence still emits frames');
    assert.ok(sil[sil.length - 1].every((v) => v === 0), 'digital silence → all zero');
  });
  it('empty input exits 0 with no frames; source stays light', () => {
    const res = runScript(Buffer.alloc(0));
    assert.equal(res.status, 0);
    assert.equal(framesOf(res).length, 0);
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(!src.includes('import pyaudio') && !src.includes('import sounddevice'), 'no compiled audio bindings');
    assert.ok(src.includes('--stdin'), 'test seam documented');
  });
  it('parec is asked for 25 ms fragments (no multi-second batching)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(src.includes('--latency-msec=25'), 'small fragments requested on the parec argv');
  });
});

describe('vizAudio.createSpectrumMonitor: parsed bands, silent failures', () => {
  it('canned ascii lines arrive as 0..1 arrays; junk skipped', () => {
    const { EventEmitter } = require('node:events');
    const got = [];
    const stdout = new EventEmitter();
    stdout.destroy = () => {};
    const fakeSpawn = (cmd, args) => {
      assert.equal(cmd, 'python3');
      assert.ok(String(args[0]).endsWith('vizspectrum.py'), 'runs the repo script');
      return { stdout, unref: () => {}, kill: () => {}, on: () => {} };
    };
    const tap = audio.createSpectrumMonitor({ onBands: (b) => got.push(b), spawn: fakeSpawn });
    assert.ok(tap, 'tap starts with stubbed spawn');
    stdout.emit('data', Buffer.from('1000;0;500;250;0;0;0;0;0;0;0;0;0;0;0;0\n'));
    stdout.emit('data', Buffer.from('garbage\n1;2;three\n\n')); // skipped silently
    stdout.emit('data', Buffer.from('0;0;0;0;0;0;0;0;0;0;0;0;0;1000;0;0\n'));
    assert.equal(got.length, 2, 'only valid frames delivered');
    assert.deepEqual(got[0].slice(0, 4), [1, 0, 0.5, 0.25]);
    assert.equal(got[1][13], 1);
    tap.stop();
    assert.doesNotThrow(() => tap.stop(), 'double stop safe');
  });
  it('spawn failure returns null, never throws', () => {
    assert.equal(audio.createSpectrumMonitor({ spawn: () => { throw new Error('no python'); } }), null);
    assert.equal(audio.createSpectrumMonitor({ spawn: () => null }), null);
    assert.equal(audio.createSpectrumMonitor({ spawn: () => ({}) }), null, 'no stdout → null');
  });
});

describe('viz render: real bands paint left/right differently', () => {
  it('renderVizBands is exact-width, deterministic, theme-tagged', () => {
    const { renderVizBands } = uiMod;
    assert.equal(typeof renderVizBands, 'function');
    const bass = new Array(16).fill(0); bass[1] = 1; bass[2] = 0.9;
    const treb = new Array(16).fill(0); treb[13] = 1;
    for (const w of [24, 40, 80]) {
      for (const b of [bass, treb]) {
        const f = stripTags(renderVizBands(b, w, 'white', 'white'));
        assert.equal([...f].length, w, `width ${w}`);
        for (const ch of f) assert.ok('▁▂▃▄▅▆▇█'.includes(ch), `glyph ${ch}`);
      }
    }
    assert.equal(renderVizBands(bass, 40, 'white', 'white'),
      renderVizBands(bass, 40, 'white', 'white'), 'stable');
    const hb = (s) => [...s].reduce((n, ch) => n + '▁▂▃▄▅▆▇█'.indexOf(ch), 0);
    const bl = stripTags(renderVizBands(bass, 40, 'white', 'white'));
    const th = stripTags(renderVizBands(treb, 40, 'white', 'white'));
    assert.ok(hb(bl.slice(0, 10)) > hb(bl.slice(30)), 'bass tall on the left');
    assert.ok(hb(th.slice(30)) > hb(th.slice(0, 10)), 'treble tall on the right');
    assert.ok(renderVizBands(bass, 40, 'red', 'blue').includes('{red-fg}'), 'crest uses accent');
  });
  it('attack converges in two frames (the latency fix)', () => {
    assert.equal(audio.smoothEnergy(0, 1), audio.VIZ_ATTACK);
    assert.ok(audio.VIZ_ATTACK >= 0.8, `attack ${audio.VIZ_ATTACK} reaches 96% in two frames`);
    let e = 0;
    e = audio.smoothEnergy(e, 1); e = audio.smoothEnergy(e, 1);
    assert.ok(e > 0.95, `two-frame convergence (${e})`);
  });
});

describe('viz instance: bands win over energy over synthetic', () => {
  const blessed = require('blessed');
  let screens = [];
  const make = () => {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 't' });
    screens.push(screen);
    const u = uiMod.createUI(screen, {
      onOmniSubmit: () => {}, onSuggest: () => {}, onLinkPick: () => {},
      onPlayVideo: () => {}, onHistoryBack: () => {}, onHistoryForward: () => {},
      onEscape: () => {}, onQuit: () => {}, onSettingsChange: () => {},
    }, { theme: 'white', pageSize: 50 });
    return { screen, ui: u };
  };
  afterEach(() => { for (const s of screens) { try { s.destroy(); } catch {} } screens = []; });
  const barsOf = (screen) => {
    let out = '';
    (function walk(el) {
      if (!el) return;
      try { if (typeof el.getContent === 'function') out += `${el.getContent()}\n`; } catch {}
      for (const c of el.children || []) walk(c);
    })(screen);
    // Footer slot, bars only (no title row): first long ramp run wins.
    const m = stripTags(out).match(/[▁▂▃▄▅▆▇█]{10,}/);
    return m ? m[0] : null;
  };
  it('setVizBands paints real bars; readback is a clamped copy', () => {
    const { screen, ui } = make();
    for (const fn of ['setVizBands', 'getVizBands']) {
      assert.equal(typeof ui[fn], 'function', `ui.${fn} present`);
    }
    ui.showVisualizer();
    assert.equal(ui.getVizBands(), null, 'no bands until first frame');
    const bass = new Array(16).fill(0); bass[1] = 1; bass[2] = 0.9;
    ui.setVizEnergy(0.9); // envelope high…
    ui.setVizBands(bass); // …but bands win
    assert.deepEqual(ui.getVizBands(), bass);
    const painted = barsOf(screen);
    assert.ok(painted && painted.length > 10, 'bands painted');
    const hb = (s) => [...s].reduce((n, ch) => n + '▁▂▃▄▅▆▇█'.indexOf(ch), 0);
    assert.ok(hb(painted.slice(0, 10)) > hb(painted.slice(-10)), 'bass shape on screen');
    ui.getVizBands()[0] = 999;
    assert.equal(ui.getVizBands()[0], bass[0], 'copy, not a reference');
    ui.setVizBands('junk');
    assert.equal(ui.getVizBands(), null, 'junk clears to fallback');
    ui.hideVisualizer();
    assert.equal(ui.getVizBands(), null, 'hide resets bands');
  });
  it('loader still wins over bands; pause freezes band frames', async () => {
    const { screen, ui } = make();
    ui.showVisualizer();
    const bass = new Array(16).fill(0); bass[1] = 1;
    ui.setVizBands(bass);
    const live = barsOf(screen);
    assert.ok(live && live.length > 10, 'bands painted');
    ui.showLoading('Loading page', 'example.com', '');
    let walkOut = '';
    (function walk(el) {
      if (!el) return;
      try { if (typeof el.getContent === 'function') walkOut += `${el.getContent()}\n`; } catch {}
      for (const c of el.children || []) walk(c);
    })(screen);
    assert.ok(stripTags(walkOut).includes('Loading page'), 'loader takes the slot');
    assert.ok(barsOf(screen), 'wave holds the slot during load');
    ui.hideLoading();
    assert.equal(barsOf(screen), live, 'bands resume after loader');
    ui.setVizPaused(true);
    ui.setVizBands(new Array(16).fill(1));
    assert.equal(barsOf(screen), live, 'paused bands frozen');
    ui.setVizPaused(false);
    ui.hideVisualizer();
  });
});

describe('viz wiring: spectrum first, RMS fallback, stops everywhere', () => {
  it('spawn path prefers spectrum; every exit stops both taps', () => {
    const src = fs.readFileSync(require.resolve('../src/index'), 'utf8');
    assert.ok(src.includes('startVizSpectrum()'), 'spawn path starts spectrum');
    const stops = (src.match(/stopVizSpectrum\(\)/g) || []).length;
    assert.ok(stops >= 6, `spectrum stops on close+error+poll-death+mpvStop+shutdown+paintFail (found ${stops})`);
    assert.ok(src.includes('startVizMonitor()'), 'RMS fallback retained');
    assert.ok(src.includes('no frames in 4s'), 'watchdog falls back without frames');
    assert.ok(src.includes('VIZ-SPEC'), 'spectrum lifecycle logged');
  });
  it('tap pre-warms during resolve; spawn adopts; failure releases', () => {
    const src = fs.readFileSync(require.resolve('../src/index'), 'utf8');
    const stageAt = src.indexOf("stage('start'");
    const prewarmAt = src.indexOf('startVizSpectrum(); } catch', stageAt);
    assert.ok(stageAt > 0 && prewarmAt > stageAt && prewarmAt - stageAt < 600,
      'pre-warm fires with the resolve stage, not at spawn');
    assert.ok(src.includes('Adopt a pre-warmed tap'), 'spawn adopts instead of restarting');
    const failAt = src.indexOf('release the pre-warmed tap');
    assert.ok(failAt > 0, 'paintFail releases a tap that never reached a player');
  });
});

describe('footer slot: loader 2 rows, viz 1 row, hints only when idle', () => {
  const blessed = require('blessed');
  let screens = [];
  const make = () => {
    const screen = blessed.screen({ smartCSR: true, fullUnicode: false, title: 't' });
    screens.push(screen);
    const u = uiMod.createUI(screen, {
      onOmniSubmit: () => {}, onSuggest: () => {}, onLinkPick: () => {},
      onPlayVideo: () => {}, onHistoryBack: () => {}, onHistoryForward: () => {},
      onEscape: () => {}, onQuit: () => {}, onSettingsChange: () => {},
    }, { theme: 'white', pageSize: 50 });
    return { screen, ui: u };
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
  // The slot box: the visible element carrying a long ramp run (wave or
  // bars — same glyphs, one occupant at a time by construction).
  const slotBox = (screen) => {
    let found = null;
    (function walk(el) {
      if (!el || found) return;
      try {
        if (typeof el.getContent === 'function') {
          const t = stripTags(el.getContent());
          if (/[▁▂▃▄▅▆▇█]{10,}/.test(t)) found = { height: el.height, hidden: !!el.hidden };
        }
      } catch {}
      for (const c of el.children || []) walk(c);
    })(screen);
    return found;
  };
  it('loading takes 2 rows; hints hide on home; page intact', () => {
    const { screen, ui } = make();
    assert.ok(screenText(screen).includes('/help'), 'boot footer visible (home)');
    ui.setCenterContent('A wiki article about penguins.', []);
    ui.showLoading('Loading page', 'example.com', 'some hint');
    const t = screenText(screen);
    assert.ok(t.includes('Loading page'), 'status line painted');
    assert.ok(!t.includes('/help'), 'hints hide while the slot is busy');
    assert.ok(!t.includes('some hint'), 'loader hint row gone (space saved)');
    assert.ok(t.includes('penguins'), 'page above intact');
    const slot = slotBox(screen);
    assert.ok(slot && !slot.hidden, 'slot visible');
    assert.equal(slot.height, 2, `loader slot is 2 rows (got ${slot && slot.height})`);
    ui.hideLoading();
  });
  it('hints return when the slot goes idle on home', () => {
    const { screen, ui } = make();
    ui.showLoading('Loading page', 'example.com', '');
    assert.ok(!screenText(screen).includes('/help'), 'hints hidden during load');
    ui.hideLoading();
    assert.ok(screenText(screen).includes('/help'), 'hints return when idle');
    assert.equal(slotBox(screen), null, 'slot released');
  });
  it('viz takes 1 row; hints hide; release restores everything', () => {
    const { screen, ui } = make();
    ui.setHomeMode(false);
    ui.showVisualizer();
    ui.setVizBands(new Array(16).fill(0).map((_, i) => (i === 1 ? 1 : 0)));
    const slot = slotBox(screen);
    assert.ok(slot && !slot.hidden, 'slot visible');
    assert.equal(slot.height, 1, `viz slot is 1 row (got ${slot && slot.height})`);
    ui.setHomeMode(true); // home must NOT bring hints back over the viz
    assert.ok(!screenText(screen).includes('/help'), 'no hints over live bars');
    ui.hideVisualizer();
    assert.ok(screenText(screen).includes('/help'), 'hints return after release');
    assert.equal(slotBox(screen), null, 'slot released');
  });
});
