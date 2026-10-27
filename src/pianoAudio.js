'use strict';

// Piano audio (v2): the game plays a real note per key press.
//
// The eight lane frequencies are pre-rendered as small WAV files by a
// pure JS synth (sine + two quiet partials, fast attack, piano-ish decay)
// and played fire-and-forget through whatever the box has — paplay →
// aplay → ffplay → mpv → silent. Files are cached per-user in tmpdir
// and only written for sounds that exist; nothing here ever throws and
// nothing blocks the game loop.
//
// Volumes are baked into two variants per note (loud for perfect hits,
// soft for great/good and free play) because paplay/aplay take no volume
// flag — a named voice beats a fancier command line. One soft low thud
// (v1-thud.wav) is the border-crash sound.
//
// Tests and CI stay silent: TUI_TEST=1 or TUI_PIANO_AUDIO=0 force the
// silent path, and createPlayer({ spawn }) is the injectable seam — the
// vizAudio house pattern (pure core, one thin spawn wrapper, unref'd
// children, a live-voice cap instead of a queue).

const path = require('path');
const os = require('os');
const fs = require('fs');

const NOTES = ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5'];
const FREQS = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25];

const SAMPLE_RATE = 22050; // plenty for a decayed sine; half the bytes
const DURATION = 0.9; // seconds per note
const ATTACK = 0.004; // linear attack: no click on the first sample
const DECAY = 0.28; // exp decay time constant — a struck-string envelope
const TAIL = 0.02; // final fade so a cut file never ends mid-wave
const PARTIALS = [1, 0.28, 0.14]; // fundamental + two soft partials
const LOUD_AMP = 0.55; // perfect hits
const SOFT_AMP = 0.34; // great/good, free play
const THUD_FREQ = 98; // border crash: a low, short thump
const THUD_AMP = 0.4;
const MAX_LIVE = 6; // voices at once — a key mash cannot fork-bomb

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// A synth voice: `partials` weights against f, 2f, 3f…; the envelope is
// a linear attack into an exponential decay with a final linear fade.
// returns Int16Array; junk input yields bounded silence, never throws.
function synthPcm(freq, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const rate = clampInt(o.rate, 8000, 96000, SAMPLE_RATE);
  const dur = Number.isFinite(Number(o.duration)) && Number(o.duration) > 0
    ? Math.min(3, Number(o.duration))
    : DURATION;
  const amp = Number.isFinite(Number(o.amp)) ? Math.min(1, Math.max(0, Number(o.amp))) : LOUD_AMP;
  const decay = Number.isFinite(Number(o.decay)) && Number(o.decay) > 0 ? Number(o.decay) : DECAY;
  const partials = Array.isArray(o.partials) && o.partials.length ? o.partials : PARTIALS;
  const n = Math.max(1, Math.round(rate * dur));
  const out = new Int16Array(n);
  const f = Number(freq);
  if (!Number.isFinite(f) || f <= 0) return out;
  const attackN = Math.max(1, Math.round(rate * ATTACK));
  const tail = Math.min(TAIL, dur / 4);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    if (i < attackN) {
      const a = i / attackN;
      if (a === 0) { out[i] = 0; continue; }
      let v = 0;
      for (let k = 0; k < partials.length; k++) {
        const p = Number(partials[k]);
        if (Number.isFinite(p) && p !== 0) v += p * Math.sin(2 * Math.PI * f * (k + 1) * t);
      }
      v *= a * Math.exp(-t / decay);
      out[i] = Math.max(-32767, Math.min(32767, Math.round(v * amp * 32767)));
      continue;
    }
    let v = 0;
    for (let k = 0; k < partials.length; k++) {
      const p = Number(partials[k]);
      if (Number.isFinite(p) && p !== 0) v += p * Math.sin(2 * Math.PI * f * (k + 1) * t);
    }
    v *= Math.exp(-t / decay);
    if (t > dur - tail) v *= Math.max(0, (dur - t) / tail);
    out[i] = Math.max(-32767, Math.min(32767, Math.round(v * amp * 32767)));
  }
  return out;
}

// Int16 PCM → a minimal 16-bit mono RIFF/WAVE buffer (explicit LE writes,
// so the bytes are the same on any host architecture).
function wavBytes(pcm, rate) {
  const sr = clampInt(rate, 8000, 96000, SAMPLE_RATE);
  const data = pcm && typeof pcm.length === 'number' ? pcm : new Int16Array(0);
  const n = data.length;
  const out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + n * 2, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(sr, 24);
  out.writeUInt32LE(sr * 2, 28); // byte rate
  out.writeUInt16LE(2, 32); // block align
  out.writeUInt16LE(16, 34); // bits
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-32767, Math.min(32767, Math.round(Number(data[i]) || 0)));
    out.writeInt16LE(v, 44 + i * 2);
  }
  return out;
}

// One WAV per note. Deterministic for a given (freq, opts).
function synthNoteWav(freq, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const rate = clampInt(o.rate, 8000, 96000, SAMPLE_RATE);
  return wavBytes(synthPcm(freq, Object.assign({}, o, { rate })), rate);
}

// The border-crash thud: much lower, much shorter, no ring.
function synthThud() {
  return wavBytes(synthPcm(THUD_FREQ, { duration: 0.22, amp: THUD_AMP, decay: 0.045, partials: [1, 0.5] }), SAMPLE_RATE);
}

// Sound on unless tests/CI asked for silence.
function audioEnabled(env) {
  try {
    const e = env && typeof env === 'object' ? env : process.env;
    if (String(e.TUI_TEST || '') === '1') return false; // tests never bark
    if (String(e.TUI_PIANO_AUDIO || '') === '0') return false;
    return true;
  } catch {
    return false;
  }
}

function uid() {
  try {
    return typeof process.getuid === 'function' ? String(process.getuid()) : 'x';
  } catch {
    return 'x';
  }
}

// paplay only makes sense with a running Pulse/PipeWire layer — without
// it the spawn "succeeds" and the note dies in the server handshake.
function pulseOk(env) {
  try {
    const e = env && typeof env === 'object' ? env : process.env;
    if (e && e.PULSE_SERVER) return true;
    const id = typeof process.getuid === 'function' ? process.getuid() : null;
    if (id == null) return false;
    return fs.existsSync(`/run/user/${id}/pulse/native`);
  } catch {
    return false;
  }
}

// A binary name counts as present when it sits in one of PATH's dirs.
function onPath(cmd, env) {
  try {
    const e = env && typeof env === 'object' ? env : process.env;
    const dirs = String(e.PATH || '').split(path.delimiter).filter(Boolean);
    for (const d of dirs) {
      try {
        if (fs.existsSync(path.join(d, cmd))) return true;
      } catch { /* next dir */ }
    }
  } catch { /* no PATH, no player */ }
  return false;
}

const DRIVERS = [
  { cmd: 'paplay', args: [], pulse: true },
  { cmd: 'aplay', args: ['-q'], pulse: false },
  { cmd: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet'], pulse: false },
  { cmd: 'mpv', args: ['--no-video', '--really-quiet'], pulse: false },
];

// First available player, in preference order, or null. `has`/`pulse` are
// the injectable probes (tests pass plain functions).
function detectPlayer(opts) {
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const has = typeof o.has === 'function' ? o.has : (cmd) => onPath(cmd, o.env);
    const pulse = typeof o.pulse === 'function' ? o.pulse : () => pulseOk(o.env);
    for (const d of DRIVERS) {
      if (d.pulse && !pulse()) continue;
      if (!has(d.cmd)) continue;
      return { cmd: d.cmd, args: d.args.slice() };
    }
    return null;
  } catch {
    return null;
  }
}

// The player. Never throws; every method is safe on a box with no audio
// at all. { enabled, dir, play(i, loud), thud(), stop(), setMuted(b),
// isMuted(), command() } — `play`/`thud` return false instead of
// throwing when anything is missing.
function createPlayer(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const env = o.env && typeof o.env === 'object' ? o.env : process.env;
  const on = o.enabled === undefined ? audioEnabled(env) : !!o.enabled;
  const spawnFn = typeof o.spawn === 'function' ? o.spawn : null;
  const root = typeof o.dir === 'string' && o.dir
    ? o.dir
    : path.join(os.tmpdir(), `tui-piano-${uid()}`);
  let muted = !!o.muted;
  let files = null;
  let driver; // undefined = not probed yet, null = none found
  const live = new Set(); // children still playing

  function probe() {
    if (driver === undefined) driver = detectPlayer({ has: o.has, pulse: o.pulse, env });
    return driver;
  }

  // All voices, written once per process onto disk and reused from then
  // on (a WAV the size of a snapshot; regeneration ~ms).
  function ensureFiles() {
    if (files) return files;
    const map = { thud: path.join(root, 'v1-thud.wav') };
    for (let i = 0; i < NOTES.length; i++) {
      map[`l${i}`] = path.join(root, `v1-note-l-${i}.wav`);
      map[`s${i}`] = path.join(root, `v1-note-s-${i}.wav`);
    }
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch { /* an existing dir is fine */ }
    for (const key of Object.keys(map)) {
      const file = map[key];
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > 256) continue;
        let buf = null;
        if (key === 'thud') {
          buf = synthThud();
        } else {
          const i = Number(key.slice(1));
          if (Number.isFinite(i) && i >= 0 && i < FREQS.length) {
            buf = synthNoteWav(FREQS[i], { amp: key[0] === 'l' ? LOUD_AMP : SOFT_AMP });
          }
        }
        if (buf) fs.writeFileSync(file, buf);
      } catch { /* a missing voice is silence, never an error */ }
    }
    files = map;
    return files;
  }

  // Fire one file at the driver. Fire-and-forget: no stdio, unref'd, and
  // capped so held keys can never pile up processes.
  function fire(file) {
    try {
      if (live.size >= MAX_LIVE) return false;
      const drv = probe();
      if (!drv || !file) return false;
      const args = drv.args.concat([file]);
      const child = spawnFn
        ? spawnFn(drv.cmd, args, { stdio: 'ignore' })
        : require('child_process').spawn(drv.cmd, args, { stdio: 'ignore' });
      if (!child) return false;
      try {
        if (typeof child.unref === 'function') child.unref();
      } catch { /* it still plays */ }
      live.add(child);
      if (typeof child.on === 'function') {
        try {
          child.on('exit', () => { live.delete(child); });
          child.on('error', () => { live.delete(child); });
        } catch { /* the cap still protects without cleanup */ }
      }
      return true;
    } catch {
      return false;
    }
  }

  return {
    enabled: on,
    dir: root,
    command() {
      const drv = probe();
      return drv ? drv.cmd : '';
    },
    // Sound lane `i` (0..7). `loud` picks the perfect-hit voice.
    play(i, loud) {
      try {
        if (!on || muted) return false;
        if (!probe()) return false;
        const idx = Math.floor(Number(i));
        if (!Number.isFinite(idx) || idx < 0 || idx >= NOTES.length) return false;
        const map = ensureFiles();
        return fire(loud ? map[`l${idx}`] : map[`s${idx}`]);
      } catch {
        return false;
      }
    },
    // The soft low thud of a ball crashing into the border.
    thud() {
      try {
        if (!on || muted) return false;
        if (!probe()) return false;
        return fire(ensureFiles().thud);
      } catch {
        return false;
      }
    },
    stop() {
      try {
        for (const child of Array.from(live)) {
          try {
            if (child && typeof child.kill === 'function') child.kill('SIGTERM');
          } catch { /* best effort */ }
        }
        live.clear();
      } catch { /* best effort */ }
      return true;
    },
    setMuted(v) {
      muted = !!v;
      return muted;
    },
    isMuted() {
      return muted;
    },
  };
}

module.exports = {
  NOTES,
  FREQS,
  SAMPLE_RATE,
  DURATION,
  LOUD_AMP,
  SOFT_AMP,
  MAX_LIVE,
  synthPcm,
  wavBytes,
  synthNoteWav,
  synthThud,
  audioEnabled,
  detectPlayer,
  createPlayer,
};
