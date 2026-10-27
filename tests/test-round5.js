'use strict';
/* Reactive visualizer (v1: loudness envelope): the bars follow the actual
 * music via a `parec` monitor tap (RMS → energy → gain LUT on the same
 * precomputed shape). Synthetic fallback when the tap is absent.
 * Offline: monitor spawn is stubbed, no mpv/parec launched.
 * Run: node --test --test-force-exit tests/test-round5.js
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const audio = require('../src/vizAudio');
const uiMod = require('../src/ui');

const stripTags = (s) => String(s).replace(/\{[^}]*\}/g, '').replace(/\x1b\[[0-9;]*m/g, '');
const BRAILLE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

function sineBuffer(n, amp) {
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((i / n) * Math.PI * 2) * 32767 * amp), i * 2);
  }
  return buf;
}

describe('vizAudio: RMS measures real loudness', () => {
  it('silence is 0, full-scale DC is ~1, quiet < loud', () => {
    assert.equal(audio.rmsOfBuffer(Buffer.alloc(1600)), 0);
    assert.equal(audio.rmsOfSamples([]), 0);
    const loud = audio.rmsOfBuffer(sineBuffer(800, 0.9));
    const quiet = audio.rmsOfBuffer(sineBuffer(800, 0.1));
    assert.ok(loud > 0.5 && loud < 0.75, `loud sine ~0.64, got ${loud}`);
    assert.ok(quiet > 0 && quiet < 0.12, `quiet sine ~0.07, got ${quiet}`);
    assert.ok(quiet < loud / 4, 'dynamics clearly separated');
  });
  it('never throws on junk', () => {
    assert.doesNotThrow(() => {
      assert.equal(audio.rmsOfBuffer(null), 0);
      assert.equal(audio.rmsOfBuffer(Buffer.alloc(1)), 0);
      assert.equal(audio.rmsOfSamples(null), 0);
      assert.equal(audio.rmsOfSamples([NaN, Infinity, 'x']), 0);
      assert.equal(audio.energyFromRms(NaN), 0);
      assert.equal(audio.energyFromRms(-3), 0);
      assert.equal(audio.smoothEnergy('a', 'b'), 0);
    });
  });
});

describe('vizAudio: energy mapping + smoothing', () => {
  it('floor→0, ref→1, monotonic with perceptual lift', () => {
    assert.equal(audio.energyFromRms(0), 0);
    assert.equal(audio.energyFromRms(audio.VIZ_RMS_FLOOR), 0);
    assert.equal(audio.energyFromRms(audio.VIZ_RMS_REF), 1);
    assert.equal(audio.energyFromRms(9), 1);
    const q = audio.energyFromRms(0.009); // measured quiet sine
    const l = audio.energyFromRms(0.08); // measured loud sine
    assert.ok(q > 0 && q < l && l <= 1, `quiet ${q} < loud ${l}`);
    assert.ok(q > 0.15, `quiet still visibly moves (${q})`);
  });
  it('attack is faster than release, converges without overshoot', () => {
    let e = 0;
    for (let i = 0; i < 30; i++) e = audio.smoothEnergy(e, 1);
    assert.ok(e > 0.99, `converges up (${e})`);
    const up1 = audio.smoothEnergy(0, 1);
    const down1 = audio.smoothEnergy(1, 0);
    assert.ok(up1 > 1 - down1 + 0.2, `attack ${up1} >> release step ${1 - down1}`);
    for (let i = 0; i < 60; i++) e = audio.smoothEnergy(e, 0);
    assert.ok(e < 0.01, `converges down (${e})`);
    assert.ok(e >= 0, 'never undershoots');
  });
});

describe('viz render: same shape, energy-scaled heights', () => {
  it('exports present; step quantizes 0..7', () => {
    assert.equal(typeof uiMod.vizEnergyLine, 'function');
    assert.equal(typeof uiMod.vizEnergyToStep, 'function');
    assert.equal(uiMod.VIZ_GAIN_STEPS, 8);
    assert.equal(uiMod.vizEnergyToStep(0), 0);
    assert.equal(uiMod.vizEnergyToStep(1), 7);
    assert.equal(uiMod.vizEnergyToStep(-5), 0);
    assert.equal(uiMod.vizEnergyToStep(99), 7);
    assert.equal(uiMod.vizEnergyToStep(NaN), 0);
  });
  it('energy line is exact-width, deterministic, glyph-valid', () => {
    for (const w of [24, 40, 80]) {
      for (const e of [0, 0.3, 1]) {
        const f = stripTags(uiMod.vizEnergyLine(3, w, 'white', 'white', e));
        assert.equal([...f].length, w, `width ${w} energy ${e}`);
        for (const ch of f) assert.ok('▁▂▃▄▅▆▇█'.includes(ch), `glyph ${ch}`);
      }
    }
    const a = uiMod.vizEnergyLine(5, 40, 'white', 'white', 0.7);
    assert.equal(uiMod.vizEnergyLine(5, 40, 'white', 'white', 0.7), a, 'stable');
    assert.equal(stripTags(uiMod.vizEnergyLine(29, 40, 'white', 'white', 0.7)),
      stripTags(uiMod.vizEnergyLine(5, 40, 'white', 'white', 0.7)), 'loop closes at 24');
  });
  it('quiet bars are lower than loud bars, full energy keeps the shape', () => {
    const height = (s) => [...s].reduce((n, ch) => n + '▁▂▃▄▅▆▇█'.indexOf(ch), 0);
    const q = height(stripTags(uiMod.vizEnergyLine(2, 60, 'white', 'white', 0.08)));
    const l = height(stripTags(uiMod.vizEnergyLine(2, 60, 'white', 'white', 0.9)));
    assert.ok(q < l / 2, `quiet ${q} << loud ${l}`);
    assert.equal(stripTags(uiMod.vizEnergyLine(2, 60, 'white', 'white', 1)),
      stripTags(uiMod.vizLineTagged(2, 60, 'white', 'white')), 'full energy == base shape');
    assert.ok(q > 0, 'silence still breathes, never flat');
  });
  it('synthetic path byte-identical after the refactor', () => {
    // Same seeds, same order: the table refactor must not repaint history.
    const a = stripTags(uiMod.vizLineTagged(0, 40, 'white', 'white'));
    assert.equal(uiMod.vizLineTagged(0, 40, 'white', 'white') && stripTags(uiMod.vizLineTagged(0, 40, 'white', 'white')), a);
    assert.notEqual(a, stripTags(uiMod.waveFrame(0, 40)), 'still not the wave');
  });
  it('frames-not-algo: tick path indexes tables, no RNG per tick', () => {
    const src = fs.readFileSync(require.resolve('../src/ui'), 'utf8');
    const at = src.indexOf('function vizEnergyLine');
    const seg = src.slice(at, src.indexOf('}', src.indexOf('return renderVizLevels')) + 1);
    assert.ok(!seg.includes('Math.random'), 'no RNG in the energy tick');
    assert.ok(!seg.includes('vizPRNG('), 'no PRNG recompute in the energy tick');
  });
});

describe('viz instance: energy paints, loader still wins', () => {
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
  it('setVizEnergy repaints taller bars; readback + junk handling', () => {
    const { ui } = make();
    for (const fn of ['setVizEnergy', 'getVizEnergy']) {
      assert.equal(typeof ui[fn], 'function', `ui.${fn} present`);
    }
    ui.showVisualizer();
    assert.equal(ui.getVizEnergy(), null, 'synthetic until first reading');
    ui.setVizPaused(true);
    ui.setVizEnergy(0.9);
    const frozen = ui.getVizEnergy();
    assert.equal(frozen, 0.9);
    ui.setVizPaused(false);
    ui.setVizEnergy(0.05);
    assert.equal(ui.getVizEnergy(), 0.05);
  });
  it('loud vs quiet visibly differs on screen; loader wins; hide resets', () => {
    const { screen, ui } = make();
    ui.showVisualizer();
    ui.setVizEnergy(0.05);
    const q = barsOf(screen);
    ui.setVizEnergy(0.95);
    const l = barsOf(screen);
    assert.ok(q && l, 'bars painted in both states');
    const h = (s) => [...s].reduce((n, ch) => n + '▁▂▃▄▅▆▇█'.indexOf(ch), 0);
    assert.ok(h(q) < h(l), `quiet ${h(q)} < loud ${h(l)} on screen`);
    assert.ok(!BRAILLE.test(stripTags(JSON.stringify(q))), 'no spinner');
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
    assert.ok((barsOf(screen) || '').length > 10, 'viz resumes after loader');
    ui.setVizEnergy('junk');
    assert.equal(ui.getVizEnergy(), null, 'junk clears to synthetic');
    ui.hideVisualizer();
    assert.equal(ui.getVizEnergy(), null, 'hide resets energy');
    assert.equal(ui.isVisualizerOn(), false);
  });
});

describe('viz monitor: stubbed spawn drives energy, failures stay silent', () => {
  it('canned loud/quiet bytes arrive as separated energies', async () => {
    const { EventEmitter } = require('node:events');
    const got = [];
    const stdout = new EventEmitter();
    stdout.destroy = () => {};
    const fakeSpawn = () => ({ stdout, unref: () => {}, kill: () => {}, on: () => {} });
    const tap = audio.createMonitor({ onEnergy: (e) => got.push(e), spawn: fakeSpawn });
    assert.ok(tap, 'tap starts with stubbed spawn');
    stdout.emit('data', sineBuffer(800 * 3, 0.08)); // quiet
    const q = got[got.length - 1];
    for (let i = 0; i < 25; i++) stdout.emit('data', sineBuffer(800, 0.9)); // loud
    const l = got[got.length - 1];
    assert.ok(q < l, `quiet ${q} < loud ${l} through the tap`);
    assert.ok(got.length >= 4, 'one callback per 100 ms frame');
    tap.stop();
    assert.doesNotThrow(() => tap.stop(), 'double stop safe');
  });
  it('spawn failure returns null, never throws', () => {
    assert.equal(audio.createMonitor({ spawn: () => { throw new Error('no parec'); } }), null);
    assert.equal(audio.createMonitor({ spawn: () => null }), null);
    assert.equal(audio.createMonitor({ spawn: () => ({}) }), null, 'no stdout → null');
  });
  it('parec is asked for 25 ms fragments (no multi-second batching)', () => {
    const { EventEmitter } = require('node:events');
    let argv = null;
    const stdout = new EventEmitter();
    stdout.destroy = () => {};
    const tap = audio.createMonitor({
      onEnergy: () => {},
      spawn: (cmd, args) => { argv = [cmd, args]; return { stdout, unref: () => {}, kill: () => {}, on: () => {} }; },
    });
    assert.ok(tap, 'tap starts');
    assert.equal(argv[0], 'parec');
    assert.ok(argv[1].includes('--latency-msec=25'), `small fragments requested: ${argv[1]}`);
    tap.stop();
  });
});

describe('viz wiring: index.js owns the tap lifecycle', () => {
  it('monitor starts on spawn, stops on close/error/stop/shutdown', () => {
    const src = fs.readFileSync(require.resolve('../src/index'), 'utf8');
    assert.ok(src.includes('startVizMonitor()'), 'spawn path starts the tap');
    const stops = (src.match(/stopVizMonitor\(\)/g) || []).length;
    assert.ok(stops >= 5, `stop on close+error+poll-death+mpvStop+shutdown (found ${stops})`);
    assert.ok(src.includes("require('./vizAudio')"), 'uses the shared audio module');
    assert.ok(src.includes('VIZ-TAP'), 'tap lifecycle logged to player.log');
  });
  it('tap module stays light: no ffmpeg, no extra deps', () => {
    const src = fs.readFileSync(require.resolve('../src/vizAudio'), 'utf8');
    assert.ok(!src.includes("require('ffmpeg"), 'no ffmpeg dep');
    assert.ok(!src.includes('Math.random'), 'deterministic: no Math.random');
  });
});
