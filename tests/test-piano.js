'use strict';

// The piano (src/piano.js): the engine is pure and deterministic, so
// these tests own the clock — tick() runs by hand and presses are placed
// by hand. What must never break: the field is exactly w x h single-cell
// glyphs every frame, balls fall to the hit line and only die on the
// bottom border (one life each, three of them freeze the run), press()
// scores perfect/great/good inside the windows and is free outside them,
// the speed creep is gentle and floored, the ten songs rotate, free
// play answers every key with its note, and carry() lets a resize keep
// the whole run (score, lives, song position, balls in flight).
// offlineKind() still fires only on genuine offline / dead-slow errors
// (a plain 404 or a refused connection is not the arcade's business).

const { describe, it } = require('node:test');
const assert = require('node:assert');

const p = require('../src/piano');

const W = 40; // laneW 5
const H = 20; // hit line at 17, border at 19

// Put one ball in flight exactly at a chosen phase (t ticks from the line).
function ball(g, lane, t, t0) {
  g.balls = [{ lane, t, t0: Number.isFinite(t0) ? t0 : p.START_TRAVEL }];
  return g.balls[0];
}

// A player who taps every ball the moment it enters the perfect window,
// so an autoplayed run can never miss. Returns the new hits.
function autoplay(g) {
  let hits = 0;
  for (let lane = 0; lane < p.LANES; lane++) {
    if (g.balls.some((b) => b.lane === lane && Math.abs(b.t) <= p.PERFECT_T)
      && p.press(g, lane) === 'perfect') hits += 1;
  }
  return hits;
}

describe('piano: engine', () => {
  it('exports the eight ASDF JKL; lanes, the notes and the song table', () => {
    assert.equal(p.LANES, 8);
    assert.deepEqual(p.KEYS, ['a', 's', 'd', 'f', 'j', 'k', 'l', ';']);
    assert.deepEqual(p.NOTES, ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5']);
    assert.equal(p.SONGS.length, 10);
    for (const s of p.SONGS) {
      assert.ok(s.name, 'every song has a name');
      assert.ok(s.notes.length >= 20, `${s.name} has a real note list`);
      for (const lane of s.notes) assert.ok(lane >= 0 && lane < p.LANES, `lane in range: ${lane}`);
      assert.ok((s.tempo || 1) === 1 || s.tempo === 2, `${s.name} tempo is sane`);
    }
    for (const name of ['Prelude in C', 'Tetris', 'Moonlight Sonata', 'Megalovania', 'Mario Overworld']) {
      assert.ok(p.SONGS.some((s) => s.name === name), `${name} is in the set`);
    }
    assert.ok(p.SONGS.some((s) => (s.tempo || 1) === 2), 'a hard (double-time) song exists');
    assert.equal(p.TICK_MS, 60);
    assert.ok(p.TICK_MS * p.GOOD_T <= 320, 'the good window is a few 60 ms ticks');
  });

  it('createGame clamps dims and carry() keeps the whole run across a rebuild', () => {
    const small = p.createGame({ width: 4, height: 2 });
    assert.equal(small.w, 16, 'width floor');
    assert.equal(small.h, 6, 'height floor');
    assert.equal(small.lives, p.LIVES);
    assert.equal(small.travel, p.START_TRAVEL);
    assert.equal(small.over, false);
    const big = p.createGame({ width: 999, height: 999 });
    assert.equal(big.w, 200);
    assert.equal(big.h, 40);

    const run = p.createGame({
      width: 30, height: 12, song: 1, score: 440, lives: 2, hits: 30, perfect: 4, great: 1, good: 1, beatAcc: 3.5,
    });
    ball(run, 3, 12.5);
    const rebuilt = p.createGame(Object.assign({ width: 34, height: 14 }, p.carry(run)));
    assert.equal(rebuilt.w, 34, 'new arena');
    assert.equal(rebuilt.song, 1, 'song survives');
    assert.equal(rebuilt.score, 440);
    assert.equal(rebuilt.lives, 2);
    assert.equal(rebuilt.hits, 30);
    assert.equal(rebuilt.perfect, 4);
    assert.equal(rebuilt.great, 1);
    assert.equal(rebuilt.good, 1);
    assert.equal(rebuilt.beatAcc, 3.5);
    assert.equal(rebuilt.travel, p.travelFor(30), 'the creep position survives');
    assert.deepEqual(rebuilt.balls, [{ lane: 3, t: 12.5, t0: p.START_TRAVEL }], 'balls in flight survive');

    const dead = p.createGame({ width: 30, height: 12, score: 90, over: true });
    assert.equal(dead.over, true, 'a rebuild during game over keeps the screen');
    assert.equal(dead.lives, 0);
    assert.equal(dead.score, 90);
    assert.deepEqual(p.carry(null), {});
  });

  it('press() judges perfect/great/good inside the windows and is free outside', () => {
    const g = p.createGame({ width: W, height: H });
    assert.equal(p.press(g, 0), '', 'no ball, no judgment');
    ball(g, 2, 0);
    assert.equal(p.press(g, 2), 'perfect');
    assert.equal(g.score, p.SCORE_PERFECT);
    assert.equal(g.perfect, 1);
    assert.equal(g.hits, 1);
    assert.equal(g.balls.length, 0, 'the ball left the board');
    assert.equal(g.travel, p.travelFor(1), 'the creep counted the hit');
    assert.equal(g.keyFlash[2], p.KEY_FLASH, 'the key lit up');
    assert.equal(p.status(g), 'Perfect!');

    ball(g, 3, p.PERFECT_T); // window edge: still perfect
    assert.equal(p.press(g, 3), 'perfect');

    ball(g, 4, p.PERFECT_T + 0.1);
    assert.equal(p.press(g, 4), 'great');

    ball(g, 5, p.GREAT_T); // window edge: still great
    assert.equal(p.press(g, 5), 'great');

    ball(g, 6, p.GREAT_T + 0.1);
    assert.equal(p.press(g, 6), 'good');
    assert.equal(p.status(g), 'Good!');

    ball(g, 7, p.GOOD_T); // window edge: still good
    assert.equal(p.press(g, 7), 'good');

    ball(g, 1, p.GOOD_T + 0.1);
    assert.equal(p.press(g, 1), '', 'just outside the window: free');
    assert.equal(g.balls.length, 1, 'the ball keeps falling');
    assert.equal(p.press(g, 2), '', 'wrong lane: free');
    assert.equal(p.press(g, -1), '');
    assert.equal(p.press(g, 8), '');
    assert.equal(p.press(g, NaN), '');
  });

  it('score adds 100/60/30 and the counters count each grade', () => {
    const g = p.createGame({ width: W, height: H });
    ball(g, 0, 0);
    assert.equal(p.press(g, 0), 'perfect');
    ball(g, 0, 2.5);
    assert.equal(p.press(g, 0), 'great');
    ball(g, 0, 4.5);
    assert.equal(p.press(g, 0), 'good');
    assert.equal(g.perfect, 1);
    assert.equal(g.great, 1);
    assert.equal(g.good, 1);
    assert.equal(g.score, p.SCORE_PERFECT + p.SCORE_GREAT + p.SCORE_GOOD);
    assert.equal(g.hits, 3);
    assert.equal(p.describe(g), 'SCORE 190 · LIVES ♥♥♥');
  });

  it('a ball past the good window crashes on the border: one life, one event', () => {
    const g = p.createGame({ width: W, height: H });
    g.beatAcc = 0; // keep the spawner quiet for a tick
    ball(g, 4, -p.GOOD_T);
    assert.deepEqual(p.tick(g), ['miss'], 'the crash is announced');
    assert.equal(g.balls.length, 0, 'the ball shattered');
    assert.equal(g.lives, p.LIVES - 1);
    assert.equal(p.status(g), 'Miss — 2 lives left');

    // At exactly -GOOD_T the ball is still the player's to catch.
    const h2 = p.createGame({ width: W, height: H });
    h2.beatAcc = 0;
    ball(h2, 4, -p.GOOD_T);
    assert.equal(p.press(h2, 4), 'good', 'last-chance good');
    assert.deepEqual(p.tick(h2), [], 'nothing left to crash');
  });

  it('three border crashes freeze the run; restart wipes it but keeps arena + song', () => {
    const g = p.createGame({ width: 24, height: 10, song: 1 });
    g.beatAcc = 0;
    for (let i = 1; i <= 2; i++) {
      ball(g, i, -p.GOOD_T);
      assert.deepEqual(p.tick(g), ['miss']);
      assert.equal(g.lives, p.LIVES - i);
    }
    ball(g, 0, -p.GOOD_T);
    assert.deepEqual(p.tick(g), ['over'], 'the third crash ends it');
    assert.equal(g.over, true);
    assert.equal(g.lives, 0);
    assert.equal(g.balls.length, 0, 'board cleared');
    assert.equal(p.describe(g), 'SCORE 0 · GAME OVER');
    assert.match(p.status(g), /0 perfect · 0 great · 0 good/);
    assert.match(p.status(g), /r or Enter restarts/);
    const t = g.tick;
    assert.deepEqual(p.tick(g), [], 'the board is frozen');
    assert.equal(g.tick, t, 'no more ticks after game over');
    assert.equal(p.press(g, 0), '', 'no scoring after game over');
    p.restart(g);
    assert.equal(g.over, false);
    assert.equal(g.lives, p.LIVES);
    assert.equal(g.travel, p.START_TRAVEL, 'speed back to the start');
    assert.equal(g.song, 1, 'same song');
    assert.equal(g.noteIdx, 0);
    assert.equal(g.tick, 0);
    assert.equal(g.w, 24, 'arena kept');
    assert.equal(g.h, 10);
    assert.equal(g.balls.length, 0);
  });

  it('notes spawn on the beat and all ten songs rotate in order', () => {
    const g = p.createGame({ width: W, height: H });
    p.tick(g);
    assert.equal(g.balls.length, 1, 'the first note enters on the first tick');
    assert.equal(g.balls[0].lane, p.SONGS[0].notes[0], 'the song starts at its first note');
    assert.equal(g.balls[0].t, p.START_TRAVEL, 'a fresh ball spawns at the top');
    for (let i = 0; i < 9; i++) p.tick(g);
    assert.equal(g.balls.length, 1, 'a beat (travel/4) passes before the next note');
    p.tick(g);
    assert.equal(g.balls.length, 2, 'the second note enters on the beat');
    assert.equal(g.balls[1].lane, p.SONGS[0].notes[1]);

    // Drive every song in order without letting anything crash (the board
    // is cleared between spawns — this test is about the sequence).
    const g2 = p.createGame({ width: W, height: H });
    for (let s = 0; s < p.SONGS.length; s++) {
      for (const expected of p.SONGS[s].notes) {
        g2.balls = [];
        g2.beatAcc = p.spawnBeat(g2) - 1;
        p.tick(g2);
        assert.equal(g2.balls.length, 1);
        assert.equal(g2.balls[0].lane, expected, `song ${s + 1} note ${expected}`);
      }
      const next = (s + 1) % p.SONGS.length;
      assert.equal(g2.song, next, `song ${s + 1} wraps to ${next + 1}`);
      assert.equal(g2.noteIdx, 0);
      assert.equal(p.status(g2), `Song ${next + 1}: ${p.SONGS[next].name}`);
    }
  });

  it('hard songs double the note density (tempo 2)', () => {
    const idx = p.SONGS.findIndex((s) => (s.tempo || 1) === 2);
    assert.ok(idx >= 0, 'a tempo-2 song exists');
    const g = p.createGame({ width: W, height: H, song: idx });
    p.tick(g);
    assert.equal(g.balls.length, 1, 'the first note enters on the first tick');
    for (let i = 0; i < 4; i++) p.tick(g);
    assert.equal(g.balls.length, 1, 'half a beat passes with no second note');
    p.tick(g);
    assert.equal(g.balls.length, 2, 'tempo 2 spawns twice per beat');
    assert.equal(g.balls[1].lane, p.SONGS[idx].notes[1]);
  });

  it('speed creeps: −CREEP_PER_HIT per judged hit, floored at MIN_TRAVEL', () => {
    assert.equal(p.travelFor(0), p.START_TRAVEL);
    assert.ok(Math.abs((p.travelFor(0) - p.travelFor(1)) - p.CREEP_PER_HIT) < 1e-9, 'the step');
    let prev = p.START_TRAVEL + 1;
    for (let hits = 0; hits <= 900; hits += 50) {
      const t = p.travelFor(hits);
      assert.ok(t <= prev, 'never speeds back up');
      assert.ok(t >= p.MIN_TRAVEL, 'never past the floor');
      prev = t;
    }
    assert.equal(p.travelFor(800), p.MIN_TRAVEL, '800 hits reaches the floor');
    assert.equal(p.travelFor(99999), p.MIN_TRAVEL);
    assert.equal(p.beatFor(p.travelFor(0)), p.START_TRAVEL / 4, 'the beat is travel/4');

    const g = p.createGame({ width: W, height: H });
    ball(g, 1, 0);
    p.press(g, 1);
    assert.equal(g.travel, p.travelFor(1), 'a judged hit moves the creep');
    const before = g.travel;
    ball(g, 1, p.GOOD_T + 3);
    assert.equal(p.press(g, 1), '', 'too early: free');
    assert.equal(g.travel, before, 'a stray press does not speed the game up');
  });

  it('paint() is exact geometry: the strip, the keys, the ball path', () => {
    const g = p.createGame({ width: 24, height: 12 }); // laneW 3, x0 0
    const ALLOWED = new Set([' ', p.BALL, p.LINE, p.BLACK, ...p.KEYS]);
    const strip = 12 - 3;
    let rows = p.paint(g);
    assert.equal(rows.length, 12);
    for (const r of rows) {
      assert.equal([...r].length, 24, `row width: ${JSON.stringify(r)}`);
      for (const ch of r) assert.ok(ALLOWED.has(ch), `unexpected glyph ${JSON.stringify(ch)}`);
    }
    // The keyboard strip alternates white (─a─) and black (▓s▓) keys.
    assert.equal(rows[strip].slice(0, 3), '─a─', 'lane 0 is a white key');
    assert.equal(rows[strip].slice(3, 6), '▓s▓', 'lane 1 is a black key');
    assert.equal(rows[strip].slice(21, 24), '▓;▓', 'lane 7 is black');
    assert.equal(rows[12], undefined, 'nothing below the field');

    // The ball path: top at spawn, the key at the line, the border as the
    // good window runs out.
    assert.equal(p.ballRow(g, p.START_TRAVEL, p.START_TRAVEL), 0, 'spawn row');
    assert.equal(p.ballRow(g, 0, p.START_TRAVEL), strip, 'the line row');
    assert.equal(p.ballRow(g, -p.GOOD_T, p.START_TRAVEL), 11, 'the bottom row (the border)');
    ball(g, 2, 0);
    rows = p.paint(g);
    assert.equal(rows[strip][7], p.BALL, 'a ball at the line covers its key letter');
    ball(g, 2, p.START_TRAVEL);
    rows = p.paint(g);
    assert.equal(rows[0][7], p.BALL, 'a fresh ball sits on the top row');
    ball(g, 2, -p.GOOD_T);
    rows = p.paint(g);
    assert.equal(rows[11][7], p.BALL, 'a missed ball touches the border before it dies');
    g.balls = [];
    g.keyFlash[0] = 3;
    rows = p.paint(g);
    assert.equal(rows[strip][1], p.BALL, 'a lit key shows as a ball on its center');
  });

  it('paint() centers the lane block and escapes narrow fields', () => {
    const g = p.createGame({ width: 18, height: 6 }); // laneW 2, x0 1
    assert.equal(g.laneW, 2);
    assert.equal(g.x0, 1);
    const strip = 6 - 3;
    const rows = p.paint(g);
    assert.equal(rows[strip][1], 'a', 'lane 0 starts after the centering margin');
    assert.equal(rows[strip][3], 's', 'lane 1 follows immediately');
    for (const r of rows) assert.equal([...r].length, 18);
    ball(g, 7, 0);
    const r2 = p.paint(g);
    assert.equal(r2[strip][15], p.BALL, 'lane 7 sits at the block edge');
    const tiny = p.createGame({ width: 16, height: 6 }); // narrowest legal field
    assert.equal(tiny.x0, 0);
    for (const r of p.paint(tiny)) assert.equal([...r].length, 16);
  });

  it('describe() counts lives; status() narrates judgments, misses and game over', () => {
    const g = p.createGame({ width: 24, height: 8 });
    assert.equal(p.describe(g), 'SCORE 0 · LIVES ♥♥♥');
    g.lives = 2;
    assert.equal(p.describe(g), 'SCORE 0 · LIVES ♥♥·');
    g.score = 120;
    assert.equal(p.describe(g), 'SCORE 120 · LIVES ♥♥·');
    assert.equal(p.status(g), '', 'quiet during play');
    ball(g, 0, 0);
    p.press(g, 0);
    assert.equal(p.status(g), 'Perfect!');
    for (let i = 0; i < p.FLASH_TICKS; i++) p.tick(g);
    assert.equal(p.status(g), '', 'the judgment fades');
    assert.equal(p.describe(null), '');
    assert.equal(p.status(null), '');
    assert.equal(p.press(null, 0), '');
    assert.equal(p.tick(null).length, 0);
    assert.equal(p.restart(null), null);
    assert.equal(p.selectSong(null, 0), false);
  });

  it('the game-over screen: the field becomes the score card', () => {
    const g = p.createGame({ width: W, height: H });
    g.beatAcc = 0;
    ball(g, 0, 0);
    assert.equal(p.press(g, 0), 'perfect');
    for (let i = 0; i < p.LIVES; i++) {
      ball(g, i, -p.GOOD_T);
      p.tick(g);
    }
    assert.equal(g.over, true);
    assert.equal(g.perfect, 1);
    const rows = p.paint(g);
    assert.equal(rows.length, g.h);
    assert.ok(rows.every((r) => [...r].length === g.w), 'width holds every frame');
    const card = rows.join('\n');
    assert.ok(rows.some((r) => r.trim() === 'GAME OVER'), 'the card says GAME OVER');
    assert.ok(card.includes(`SCORE ${g.score}`), 'the final score');
    assert.ok(card.includes(`${g.perfect} perfect · ${g.great} great`), 'grade counts');
    assert.ok(card.includes('r / Enter restarts'), 'how to restart');
    assert.ok(!card.includes(p.BLACK), 'the keyboard strip is gone');
    assert.ok(!card.includes(p.BALL), 'no balls over the card');
    const over = rows.find((r) => r.includes('GAME OVER'));
    const left = over.length - over.trimStart().length;
    const right = over.length - over.trimEnd().length;
    assert.ok(Math.abs(left - right) <= 1, 'the card is centered');
  });

  it('free play: every key answers with its note, nothing falls', () => {
    const g = p.createGame({ width: 24, height: 8, free: true });
    assert.equal(g.free, true);
    assert.equal(p.describe(g), 'FREE PLAY · press any key');
    assert.equal(p.press(g, 0), 'note');
    assert.equal(p.status(g), '♪ C4');
    assert.equal(g.keyFlash[0], p.KEY_FLASH);
    assert.equal(p.press(g, 7), 'note');
    assert.equal(p.status(g), '♪ C5');
    assert.equal(p.press(g, 8), '', 'no eighth lane, no note');
    const strip = 8 - 3;
    const rows = p.paint(g);
    assert.equal(rows[strip][1], p.BALL, 'lane 0 lights up');
    assert.equal(rows[strip][22], p.BALL, 'lane 7 lights up');
    for (let i = 0; i < p.KEY_FLASH; i++) {
      assert.deepEqual(p.tick(g), [], 'free play never spawns');
      assert.equal(g.balls.length, 0);
      assert.equal(g.over, false);
    }
    assert.equal(p.status(g), '', 'the note readout fades');
    assert.equal(g.lives, p.LIVES, 'free play costs no lives');
    p.restart(g);
    assert.equal(g.free, true, 'restart keeps free play');
    assert.equal(p.selectSong(g, 1), true);
    assert.equal(g.free, false, 'a song pick leaves free play');
    assert.equal(g.song, 1);
    assert.equal(p.status(g), 'Song 2: Ode to Joy');
    assert.equal(p.selectSong(g, 9), true, 'the tenth song is reachable');
    assert.equal(g.song, 9);
    assert.equal(p.selectSong(g, 10), false);
    assert.equal(g.song, 9, 'a bad pick changes nothing');
  });

  it('random mode: * rolls a fresh song per restart; digits take back over', () => {
    const g = p.createGame({ width: W, height: H, song: 0 });
    assert.equal(g.random, false);
    assert.equal(p.toggleRandom(null), false);
    assert.equal(p.toggleRandom(g), true, '* turns random songs on');
    assert.equal(g.random, true);
    assert.ok(g.song >= 0 && g.song < p.SONGS.length, 'a real song is picked');
    assert.notEqual(g.song, 0, 'the toggle never replays the current song');
    assert.ok(p.status(g).includes('Random songs — '), 'the flash names the mode');
    const seen = new Set([g.song]);
    let prev = g.song;
    for (let i = 0; i < 30; i++) {
      p.restart(g);
      assert.ok(g.song >= 0 && g.song < p.SONGS.length);
      assert.notEqual(g.song, prev, 'a restart rolls a different song');
      prev = g.song;
      seen.add(g.song);
    }
    assert.ok(seen.size > 1, 'different songs get airtime');
    assert.equal(p.toggleRandom(g), false, '* again turns it off');
    assert.equal(g.random, false);
    const held = g.song;
    p.restart(g);
    assert.equal(g.song, held, 'off: a restart replays the same song');
    assert.equal(p.toggleRandom(g), true);
    assert.equal(p.selectSong(g, 1), true);
    assert.equal(g.random, false, 'a digit pick takes over from random');
    assert.equal(g.song, 1);
    p.restart(g);
    assert.equal(g.song, 1, 'and restarts stick to that song');
  });

  it('a perfect player survives a long run: no misses, score = 100 × hits', () => {
    const g = p.createGame({ width: W, height: H });
    let hits = 0;
    for (let i = 0; i < 3000; i++) {
      p.tick(g);
      hits += autoplay(g);
      assert.equal(g.over, false, 'a perfect player never ends the run');
      assert.equal(g.lives, p.LIVES, `no misses (tick ${i})`);
      assert.equal(g.hits, hits);
      assert.equal(g.perfect, hits, 'every tap was perfect');
      assert.equal(g.great + g.good, 0);
      assert.equal(g.score, hits * p.SCORE_PERFECT);
      assert.ok(g.travel >= p.MIN_TRAVEL, 'floored');
      assert.ok(g.travel <= p.START_TRAVEL);
      for (const b of g.balls) {
        assert.ok(b.lane >= 0 && b.lane < p.LANES, `lane in range: ${b.lane}`);
      }
      const rows = p.paint(g);
      assert.equal(rows.length, g.h);
      assert.ok(rows.every((r) => [...r].length === g.w), 'width holds every frame');
    }
    assert.ok(hits > 300, `the run actually plays (${hits} hits)`);
    assert.equal(g.tick, 3000);
    assert.ok(g.travel < p.START_TRAVEL, 'the creep bit');
    assert.ok(g.noteIdx >= 0 && g.noteIdx < p.SONGS[g.song].notes.length);
  });

  it('offlineKind() fires only on genuine offline / slow errors', () => {
    assert.equal(p.offlineKind('net::ERR_INTERNET_DISCONNECTED'), 'offline');
    assert.equal(p.offlineKind('TypeError: fetch failed'), 'offline');
    assert.equal(p.offlineKind('getaddrinfo ENOTFOUND example.com'), 'offline');
    assert.equal(p.offlineKind('net::ERR_NAME_NOT_RESOLVED'), 'offline');
    assert.equal(p.offlineKind('page.goto: Timeout 20000ms exceeded'), 'slow');
    assert.equal(
      p.offlineKind('page.goto: Timeout 30000ms exceeded. Call log: navigating to "https://www.youtube.com/", waiting until "domcontentloaded"'),
      'offline',
      'a document that never arrived is offline, not slow'
    );
    assert.equal(p.offlineKind('net::ERR_TIMED_OUT'), 'slow');
    assert.equal(p.offlineKind('net::ERR_CONNECTION_REFUSED'), '', 'a down site is not the arcade');
    assert.equal(p.offlineKind('Error: 404 not found'), '');
    assert.equal(p.offlineKind(''), '');
    assert.equal(p.offlineKind(null), '');
  });
});
