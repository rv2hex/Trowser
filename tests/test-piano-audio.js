'use strict';

// Piano audio (src/pianoAudio.js): the synth is pure — these tests read
// the WAV bytes back — and the player is one injectable spawn away from
// being testable. What must never break: a valid deterministic RIFF per
// note, a loud/soft pair with a real amplitude difference, a short thud,
// the silent switches (TUI_TEST / TUI_PIANO_AUDIO), the player fallback
// order, and the hard promise that a broken or missing spawner is silence,
// not an exception — no test here may ever start a real player process.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const au = require('../src/pianoAudio');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'piano-audio-test-'));
}

function peakOf(wav) {
  const n = wav.readUInt32LE(40) / 2;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(wav.readInt16LE(44 + i * 2)));
  return peak;
}

// A child good enough for the player (unref/kill/on) without a process.
function fakeChild(track) {
  const c = { unref: () => {}, kill: (sig) => { if (track) track.push(sig); }, on: () => {} };
  return c;
}

describe('piano audio: the synth', () => {
  it('the note table is the C-major scale, C4..C5, ascending', () => {
    assert.deepEqual(au.NOTES, ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5']);
    assert.equal(au.FREQS.length, au.NOTES.length);
    for (let i = 1; i < au.FREQS.length; i++) assert.ok(au.FREQS[i] > au.FREQS[i - 1], 'ascending');
    assert.ok(Math.abs(au.FREQS[0] - 261.63) < 0.01, 'C4');
    assert.ok(Math.abs(au.FREQS[7] - 523.25) < 0.01, 'C5');
  });

  it('synthNoteWav() is a valid, deterministic 16-bit mono RIFF', () => {
    const wav = au.synthNoteWav(440);
    assert.equal(wav.slice(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.slice(8, 12).toString('ascii'), 'WAVE');
    assert.equal(wav.slice(12, 16).toString('ascii'), 'fmt ');
    assert.equal(wav.readUInt32LE(4), wav.length - 8, 'RIFF size field');
    assert.equal(wav.readUInt16LE(20), 1, 'PCM');
    assert.equal(wav.readUInt16LE(22), 1, 'mono');
    assert.equal(wav.readUInt32LE(24), au.SAMPLE_RATE);
    assert.equal(wav.readUInt16LE(34), 16, '16-bit');
    const samples = wav.readUInt32LE(40) / 2;
    assert.equal(samples, Math.round(au.SAMPLE_RATE * au.DURATION));
    assert.equal(wav.length, 44 + samples * 2, 'one data chunk, no padding');
    assert.ok(wav.equals(au.synthNoteWav(440)), 'deterministic');
    assert.ok(!wav.equals(au.synthNoteWav(261.63)), 'different pitch, different bytes');
  });

  it('the envelope attacks fast, peaks audibly and fades to silence', () => {
    const wav = au.synthNoteWav(440);
    const n = wav.readUInt32LE(40) / 2;
    const at = (i) => Math.abs(wav.readInt16LE(44 + i * 2));
    assert.equal(at(0), 0, 'starts at zero (no click)');
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, at(i));
    assert.ok(peak > 8000, `audible peak ${peak}`);
    let tailPeak = 0;
    const tailN = Math.round(au.SAMPLE_RATE * 0.005);
    for (let i = n - tailN; i < n; i++) tailPeak = Math.max(tailPeak, at(i));
    assert.ok(tailPeak < 600, `fades out clean (${tailPeak})`);

    const loud = peakOf(au.synthNoteWav(440, { amp: au.LOUD_AMP }));
    const soft = peakOf(au.synthNoteWav(440, { amp: au.SOFT_AMP }));
    assert.ok(loud > 8000, 'loud is audible');
    assert.ok(soft < loud * 0.75, `soft is quieter (${soft} < ${loud})`);

    const thud = au.synthThud();
    assert.equal(thud.slice(0, 4).toString('ascii'), 'RIFF');
    assert.ok(thud.readUInt32LE(40) / 2 < au.SAMPLE_RATE * 0.3, 'the thud is short');
  });

  it('synthPcm() tolerates junk and keeps every sample bounded', () => {
    for (const bad of [NaN, 0, -5, 'x', null, undefined]) {
      assert.doesNotThrow(() => au.synthPcm(bad));
      const pcm = au.synthPcm(bad);
      assert.ok(pcm.length > 0);
      for (let i = 0; i < pcm.length; i += 997) assert.ok(Math.abs(pcm[i]) <= 32767);
    }
    assert.equal(au.wavBytes(null, 0).length, 44, 'an empty WAV header is still valid');
  });

  it('audioEnabled() honours the silent switches', () => {
    assert.equal(au.audioEnabled({}), true);
    assert.equal(au.audioEnabled({ TUI_TEST: '1' }), false);
    assert.equal(au.audioEnabled({ TUI_TEST: '0' }), true, 'only "1" means tests');
    assert.equal(au.audioEnabled({ TUI_PIANO_AUDIO: '0' }), false);
    assert.equal(au.audioEnabled({ TUI_TEST: '1', TUI_PIANO_AUDIO: '1' }), false, 'TUI_TEST wins');
  });

  it('detectPlayer() prefers paplay with Pulse, then falls back in order', () => {
    const only = (...names) => (cmd) => names.indexOf(cmd) >= 0;
    const driver = (has, pulse) => au.detectPlayer({ has, pulse: () => pulse });
    assert.equal(driver(only('paplay'), true).cmd, 'paplay', 'paplay first when Pulse is up');
    assert.equal(driver(only('paplay', 'aplay'), false).cmd, 'aplay', 'no Pulse socket: paplay cannot work');
    assert.equal(driver(only('aplay', 'ffplay'), true).cmd, 'aplay', 'aplay outranks ffplay');
    assert.equal(driver(only('ffplay', 'mpv'), true).cmd, 'ffplay');
    assert.equal(driver(only('mpv'), true).cmd, 'mpv');
    assert.equal(au.detectPlayer({ has: () => false }), null);
    assert.equal(au.detectPlayer({ has: () => { throw new Error('boom'); } }), null, 'probes never throw through');
  });
});

describe('piano audio: the player', () => {
  it('play() writes cached WAVs and fires the injected spawn once per press', () => {
    const dir = tmpDir();
    const calls = [];
    const player = au.createPlayer({
      enabled: true,
      dir,
      has: (c) => c === 'aplay',
      spawn: (cmd, args, opts) => { calls.push([cmd, args, opts]); return fakeChild(); },
    });
    assert.equal(player.enabled, true);
    assert.equal(player.command(), 'aplay');
    assert.equal(player.play(0, true), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'aplay');
    assert.deepEqual(calls[0][1].slice(0, -1), ['-q'], 'aplay asked to be quiet');
    const file = calls[0][1][calls[0][1].length - 1];
    assert.ok(file.startsWith(dir) && file.endsWith('.wav'), `voice cached in dir: ${file}`);
    assert.ok(fs.existsSync(file), 'the WAV exists');
    assert.equal(fs.readFileSync(file).slice(0, 4).toString('ascii'), 'RIFF');
    assert.equal(player.play(7, false), true, 'soft voice');
    assert.notEqual(calls[1][1][calls[1][1].length - 1], file, 'loud and soft are different files');
    assert.equal(player.play(99, true), false, 'no ninth lane');
    assert.equal(player.play(-1, true), false);
    assert.equal(player.play(NaN, false), false);
    assert.equal(calls.length, 2, 'invalid keys never spawn');
    // Second play reuses the cache: no rewriting means the same bytes.
    assert.ok(fs.readFileSync(file).equals(fs.readFileSync(file)));
  });

  it('mute silences every voice; unmute restores', () => {
    const dir = tmpDir();
    let calls = 0;
    const player = au.createPlayer({
      enabled: true,
      dir,
      has: (c) => c === 'aplay',
      spawn: () => { calls += 1; return fakeChild(); },
    });
    assert.equal(player.setMuted(true), true);
    assert.equal(player.isMuted(), true);
    assert.equal(player.play(0, true), false, 'muted play is silent');
    assert.equal(player.thud(), false, 'muted thud is silent');
    assert.equal(calls, 0, 'nothing spawned while muted');
    player.setMuted(false);
    assert.equal(player.play(0, true), true);
    assert.equal(player.thud(), true);
    assert.equal(calls, 2);
  });

  it('a broken spawner is silence, never an error', () => {
    const player = au.createPlayer({
      enabled: true,
      dir: tmpDir(),
      has: (c) => c === 'aplay',
      spawn: () => { throw new Error('no exec'); },
    });
    assert.doesNotThrow(() => player.play(1, true));
    assert.equal(player.play(1, true), false);
    assert.equal(player.thud(), false);
  });

  it('stop() kills the live voices (closing the game silences the tail)', () => {
    const killed = [];
    const player = au.createPlayer({
      enabled: true,
      dir: tmpDir(),
      has: (c) => c === 'aplay',
      spawn: () => fakeChild(killed),
    });
    assert.equal(player.play(0, true), true);
    assert.equal(player.play(1, false), true);
    player.stop();
    assert.deepEqual(killed, ['SIGTERM', 'SIGTERM']);
    assert.doesNotThrow(() => player.stop(), 'double stop is safe');
  });

  it('held keys cannot fork-bomb: MAX_LIVE voices at most', () => {
    let fired = 0;
    const player = au.createPlayer({
      enabled: true,
      dir: tmpDir(),
      has: (c) => c === 'aplay',
      spawn: () => { fired += 1; return fakeChild(); },
    });
    for (let i = 0; i < au.MAX_LIVE + 4; i++) player.play(0, true);
    assert.equal(fired, au.MAX_LIVE, 'the cap holds the fork count');
  });

  it('a disabled player never touches the spawner', () => {
    const player = au.createPlayer({
      enabled: false,
      spawn: () => { throw new Error('must not spawn'); },
    });
    assert.equal(player.enabled, false);
    assert.equal(player.play(0, true), false);
    assert.equal(player.thud(), false);
    assert.equal(player.isMuted(), false);
  });

  it('with no options at all, TUI_TEST keeps the keyboard silent', () => {
    const prev = process.env.TUI_TEST;
    try {
      process.env.TUI_TEST = '1';
      const player = au.createPlayer({ dir: tmpDir() });
      assert.equal(player.enabled, false);
      assert.equal(player.play(0, true), false);
      assert.equal(player.thud(), false);
    } finally {
      if (prev === undefined) delete process.env.TUI_TEST;
      else process.env.TUI_TEST = prev;
    }
  });

  it('voices are fire-and-forget: stdio ignored, child unref\'d', () => {
    let unrefs = 0;
    let opts = null;
    const player = au.createPlayer({
      enabled: true,
      dir: tmpDir(),
      has: (c) => c === 'aplay',
      spawn: (cmd, args, o) => {
        opts = o;
        return { unref: () => { unrefs += 1; }, kill: () => {}, on: () => {} };
      },
    });
    player.play(0, true);
    assert.equal(unrefs, 1, 'the child cannot hold the TUI open');
    assert.equal(opts.stdio, 'ignore', 'stdout/stderr swallowed');
  });
});
