'use strict';

// Music-reactive visualizer audio tap (v1: loudness envelope).
//
// The visualizer bars used to be pure synthetic animation (seeded PRNG).
// They now follow the actual music: a tiny `parec` monitor tap reads the
// system mix (~16 KB/s at 8 kHz mono) and each ~100 ms chunk resolves to
// one RMS loudness value, mapped to an energy 0..1 that scales bar heights
// in the UI. No second download, no decoder, no FFT — RMS over 800 samples
// is ~0.1% CPU and reuses the audio mpv is already playing.
//
// Cooperative-mpv approaches were tried and rejected on this box:
// mpv 0.40's `af-metadata` does not forward lavfi filter metadata
// (ebur128/astats both reply "error accessing property"), and framelog
// parsing is fragile. The monitor tap needs zero mpv cooperation and
// works for any player. Pause needs no special-casing either: a paused
// player is silent, so energy falls on its own (the existing pause-freeze
// poll stays as the hard freeze).
//
// Everything here is pure + unit-testable except createMonitor (one thin
// spawn wrapper, injectable for tests). Nothing throws on junk input.

const VIZ_SAMPLE_RATE = 8000;
const VIZ_CHANNELS = 1;
const VIZ_FRAME_SAMPLES = 800; // 100 ms @ 8 kHz
const VIZ_MONITOR_DEVICE = '@DEFAULT_MONITOR@';

// Perceptual mapping bounds (measured RMS on this box: quiet sine 0.009,
// loud sine 0.080, digital silence 0.000).
const VIZ_RMS_FLOOR = 0.004;
const VIZ_RMS_REF = 0.12;

// EMA smoothing per 100 ms frame: fast attack (kicks follow the beat —
// measured 2026-10-13: capture is 1-6 ms, so convergence speed here IS the
// perceived lag; 0.8 reaches 96% in two frames), slow release (bars fall
// gracefully instead of flickering).
const VIZ_ATTACK = 0.8;
const VIZ_RELEASE = 0.18;

// RMS of signed 16-bit samples, 0..1. Accepts any array-like of numbers;
// non-finite entries count as silence. Never throws.
function rmsOfSamples(samples) {
  try {
    if (!samples || typeof samples.length !== 'number' || samples.length === 0) return 0;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Number(samples[i]);
      if (!Number.isFinite(v) || v === 0) {
        if (v === 0) n++;
        continue;
      }
      sum += v * v;
      n++;
    }
    if (!n) return 0;
    return Math.min(1, Math.sqrt(sum / n) / 32768);
  } catch {
    return 0;
  }
}

// RMS of a raw s16le Buffer. Never throws.
function rmsOfBuffer(buf) {
  try {
    if (!buf || !buf.length) return 0;
    const n = Math.floor(buf.length / 2);
    if (!n) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = buf.readInt16LE(i * 2);
      if (v !== 0) sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / n) / 32768);
  } catch {
    return 0;
  }
}

// Loudness RMS 0..1 → display energy 0..1. Square-rooted so quiet passages
// still visibly move; silence maps to exactly 0. Never throws.
function energyFromRms(rms) {
  try {
    const r = Number(rms);
    if (!Number.isFinite(r) || r <= VIZ_RMS_FLOOR) return 0;
    if (r >= VIZ_RMS_REF) return 1;
    const t = (r - VIZ_RMS_FLOOR) / (VIZ_RMS_REF - VIZ_RMS_FLOOR);
    return Math.min(1, Math.max(0, Math.sqrt(Math.max(0, t))));
  } catch {
    return 0;
  }
}

// One EMA step toward the next energy reading. Never throws.
function smoothEnergy(prev, next, attack = VIZ_ATTACK, release = VIZ_RELEASE) {
  try {
    const p = Number(prev);
    const q = Number(next);
    const a = Number(attack);
    const r = Number(release);
    const p0 = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
    if (!Number.isFinite(q)) return p0;
    const q0 = Math.min(1, Math.max(0, q));
    const k = q0 > p0
      ? (Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : VIZ_ATTACK)
      : (Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : VIZ_RELEASE);
    return p0 + k * (q0 - p0);
  } catch {
    return 0;
  }
}

// Spawn the monitor tap. onEnergy(e) fires ~10 Hz with smoothed 0..1
// values. Returns { stop() } or null when the tap cannot start (missing
// parec, spawn stubbed in tests, etc.) — never throws. The child is
// unref'd so a leaked tap can never hold the TUI open.
function createMonitor({ onEnergy, onError, device, rate, spawn } = {}) {
  try {
    const spawnFn = spawn || require('child_process').spawn;
    const dev = typeof device === 'string' && device ? device : VIZ_MONITOR_DEVICE;
    const sr = Number.isFinite(Number(rate)) && Number(rate) > 0 ? Math.floor(Number(rate)) : VIZ_SAMPLE_RATE;
    const frameSamples = Math.max(80, Math.round(sr / 10));
    let child = null;
    try {
      // --latency-msec=25: without an explicit request the server (PipeWire
      // pulse layer here) batches record streams ~2 s at a time — the bars
      // jumped in multi-second blocks. 25 ms measured steady (~43 ms median
      // fragment gap, zero gaps >500 ms during music; the 50 ms request
      // landed on a coarser ~256 ms grid). Cheap: one small wakeup per hop.
      child = spawnFn('parec', ['-d', dev, `--rate=${sr}`, '--channels=1', '--format=s16le', '--latency-msec=25'],
        { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
    if (!child || !child.stdout || typeof child.stdout.on !== 'function') {
      try { child && child.kill && child.kill(); } catch { /* best effort */ }
      return null;
    }
    if (typeof child.unref === 'function') {
      try { child.unref(); } catch { /* keep tapping */ }
    }
    let carry = Buffer.alloc(0);
    let energy = 0;
    let stopped = false;
    const bytesPerFrame = frameSamples * 2;
    const fail = (err) => {
      if (stopped) return;
      try { if (typeof onError === 'function') onError(err); } catch { /* best effort */ }
    };
    try {
      child.stdout.on('data', (chunk) => {
        try {
          if (stopped) return;
          carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
          while (carry.length >= bytesPerFrame) {
            const frame = carry.subarray(0, bytesPerFrame);
            carry = carry.subarray(bytesPerFrame);
            const e = energyFromRms(rmsOfBuffer(frame));
            energy = smoothEnergy(energy, e);
            try { if (typeof onEnergy === 'function') onEnergy(energy); } catch { /* never break the tap */ }
          }
          // Bound memory when the consumer stalls: keep one frame.
          if (carry.length > bytesPerFrame * 4) carry = carry.subarray(carry.length - bytesPerFrame);
        } catch { /* tap never throws */ }
      });
      child.stdout.on('error', fail);
      if (typeof child.on === 'function') {
        child.on('error', fail);
      }
    } catch {
      return null;
    }
    return {
      stop() {
        try {
          stopped = true;
          try { child.stdout && child.stdout.destroy && child.stdout.destroy(); } catch { /* best effort */ }
          try { child.kill && child.kill('SIGTERM'); } catch { /* best effort */ }
        } catch { /* best effort */ }
      },
    };
  } catch {
    return null;
  }
}

// Spawn the spectrum analyzer (scripts/vizspectrum.py, stdlib + numpy
// only — no new system dependencies). onBands(arr) fires ~20 Hz with a
// 0..1 level per frequency band (low → high). Malformed lines are
// skipped; a dead/missing script yields onError and the caller falls
// back to the RMS tap. Returns { stop() } or null. Never throws.
function createSpectrumMonitor({ onBands, onError, script, device, spawn } = {}) {
  try {
    const path = require('path');
    const spawnFn = spawn || require('child_process').spawn;
    const scriptPath = typeof script === 'string' && script
      ? script
      : path.join(__dirname, '..', 'scripts', 'vizspectrum.py');
    const dev = typeof device === 'string' && device ? device : VIZ_MONITOR_DEVICE;
    let child = null;
    try {
      child = spawnFn('python3', [scriptPath, '--device', dev],
        { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
    if (!child || !child.stdout || typeof child.stdout.on !== 'function') {
      try { child && child.kill && child.kill(); } catch { /* best effort */ }
      return null;
    }
    if (typeof child.unref === 'function') {
      try { child.unref(); } catch { /* keep analyzing */ }
    }
    let stopped = false;
    let carry = '';
    const fail = (err) => {
      if (stopped) return;
      stopped = true;
      try { if (typeof onError === 'function') onError(err); } catch { /* best effort */ }
    };
    try {
      child.stdout.on('data', (chunk) => {
        try {
          if (stopped) return;
          carry += String(chunk);
          if (carry.length > 65536) carry = carry.slice(-8192);
          let nl;
          while ((nl = carry.indexOf('\n')) >= 0) {
            const line = carry.slice(0, nl).trim();
            carry = carry.slice(nl + 1);
            if (!line) continue;
            const parts = line.split(';');
            if (parts.length < 4 || parts.length > 512) continue;
            const bands = [];
            let ok = true;
            for (const p of parts) {
              const v = Number(p);
              if (!Number.isFinite(v)) { ok = false; break; }
              bands.push(Math.min(1, Math.max(0, v / 1000)));
            }
            if (!ok || !bands.length) continue;
            try { if (typeof onBands === 'function') onBands(bands); } catch { /* never break the tap */ }
          }
        } catch { /* tap never throws */ }
      });
      child.stdout.on('error', fail);
      if (typeof child.on === 'function') {
        child.on('error', fail);
        child.on('close', () => fail(new Error('spectrum ended')));
      }
    } catch {
      return null;
    }
    return {
      stop() {
        try {
          stopped = true;
          try { child.stdout && child.stdout.destroy && child.stdout.destroy(); } catch { /* best effort */ }
          try { child.kill && child.kill('SIGTERM'); } catch { /* best effort */ }
        } catch { /* best effort */ }
      },
    };
  } catch {
    return null;
  }
}

module.exports = {
  createSpectrumMonitor,
  VIZ_SAMPLE_RATE,
  VIZ_CHANNELS,
  VIZ_FRAME_SAMPLES,
  VIZ_MONITOR_DEVICE,
  VIZ_RMS_FLOOR,
  VIZ_RMS_REF,
  VIZ_ATTACK,
  VIZ_RELEASE,
  rmsOfSamples,
  rmsOfBuffer,
  energyFromRms,
  smoothEnergy,
  createMonitor,
};
