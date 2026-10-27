'use strict';

// Pong (src/pong.js): the engine is pure, so these tests own the clock —
// tick() runs by hand and every random draw comes from a seeded rng. What
// must never break: the field is exactly w x h every frame, paddles and
// ball stay inside it, a match ends at WIN_POINTS, a win levels up with a
// strictly harder bot, and the third match loss resets the run to level 1.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const pong = require('../src/pong');

// Mulberry32 — tiny deterministic rng so serves/rallys are reproducible.
function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Run ticks until the ball leaves the serve pause (bounded).
function serveUp(g) {
  for (let i = 0; i < 200 && g.phase === 'serve'; i++) pong.tick(g);
}

// A player that tracks the ball, so long seeded runs actually rally.
function autoplay(g) {
  const target = Math.max(0, Math.min(g.h - 1, Math.round(g.by)));
  if (target < g.p1y) pong.nudge(g, -1);
  else if (target > g.p1y + pong.PADDLE_LEN - 1) pong.nudge(g, 1);
}

describe('pong: engine', () => {
  it('createGame clamps dims and carries the run across a resize', () => {
    const small = pong.createGame({ width: 4, height: 2 });
    assert.equal(small.w, 16, 'width floor');
    assert.equal(small.h, 6, 'height floor');
    assert.equal(small.level, 1);
    assert.equal(small.lives, pong.LIVES);
    assert.equal(small.phase, 'serve');
    const big = pong.createGame({ width: 999, height: 999 });
    assert.equal(big.w, 200);
    assert.equal(big.h, 40);
    const carried = pong.createGame({ width: 30, height: 8, level: 4, lives: 2, you: 2, bot: 1 });
    assert.equal(carried.level, 4, 'level survives the rebuild');
    assert.equal(carried.lives, 2, 'lives survive the rebuild');
    assert.equal(carried.you, 2, 'match score survives the rebuild');
    assert.equal(carried.bot, 1);
  });

  it('difficulty() is monotonic: faster ball, stronger tracking, smaller error', () => {
    let prev = null;
    for (let lv = 1; lv <= 12; lv++) {
      const d = pong.difficulty(lv);
      if (prev) {
        assert.ok(d.speed >= prev.speed, `speed must not fall at level ${lv}`);
        assert.ok(d.step >= prev.step, `bot step must not fall at level ${lv}`);
        assert.ok(d.err <= prev.err, `aim error must not grow at level ${lv}`);
      }
      prev = d;
    }
    assert.ok(pong.difficulty(1).speed < pong.difficulty(5).speed, 'level 5 ball is faster');
    assert.ok(pong.difficulty(1).step < pong.difficulty(5).step, 'level 5 bot is quicker');
    assert.equal(pong.difficulty(1).err, 3);
    assert.equal(pong.difficulty(4).err, 0, 'from level 4 the bot tracks perfectly');
    assert.equal(pong.difficulty(99).speed, 2, 'speed is capped');
    assert.equal(pong.difficulty(99).step, 3, 'bot step is capped');
  });

  it('nudge() clamps at both edges and only steers while the ball is playable', () => {
    const g = pong.createGame({ width: 30, height: 8 });
    g.p1y = 0;
    assert.equal(pong.nudge(g, -1), false, 'top edge is a no-op');
    assert.equal(g.p1y, 0);
    g.p1y = g.h - pong.PADDLE_LEN;
    assert.equal(pong.nudge(g, 1), false, 'bottom edge is a no-op');
    assert.equal(pong.nudge(g, -1), true, 'moves up from the bottom');
    assert.equal(g.p1y, g.h - pong.PADDLE_LEN - 1);
    g.phase = 'matchwon';
    assert.equal(pong.nudge(g, -1), false, 'message phases do not steer');
  });

  it('the serve countdown launches the ball with unit axis velocity', () => {
    const g = pong.createGame({ width: 30, height: 8, rng: seeded(7) });
    assert.equal(g.phase, 'serve');
    serveUp(g);
    assert.equal(g.phase, 'rally');
    assert.equal(Math.abs(g.bvx), 1);
    assert.equal(Math.abs(g.bvy), 1);
  });

  it('player paddle reflects the ball; a clean miss scores for the bot', () => {
    const g = pong.createGame({ width: 20, height: 8, rng: seeded(3) });
    serveUp(g);
    g.phase = 'rally';
    g.p1y = 2;
    g.bx = 2;
    g.by = 3;
    g.bvx = -1;
    g.bvy = 0;
    let guard = 0;
    while (g.bvx !== 1 && guard++ < 30) pong.tick(g);
    assert.equal(g.bvx, 1, 'reflection');
    assert.ok(g.bx >= 2, 'ball stays inside the field');

    const g2 = pong.createGame({ width: 20, height: 8, rng: seeded(3) });
    serveUp(g2);
    g2.phase = 'rally';
    g2.p1y = 0; // paddle parked at the top
    g2.bx = 2;
    g2.by = 7; // ball at the bottom: a clean miss
    g2.bvx = -1;
    g2.bvy = 0;
    const before = g2.bot;
    guard = 0;
    while (g2.bot === before && guard++ < 30) pong.tick(g2);
    assert.equal(g2.bot, before + 1, 'miss on the left scores for the bot');
    assert.ok(g2.phase === 'pointbot' || g2.phase === 'matchlost');
  });

  it('walls bounce: the field is never escaped during a long seeded rally', () => {
    const g = pong.createGame({ width: 24, height: 8, rng: seeded(42) });
    serveUp(g);
    for (let i = 0; i < 600; i++) {
      autoplay(g);
      pong.tick(g);
      assert.ok(g.bx >= 0 && g.bx < g.w, `ball x in bounds at ${i}: ${g.bx}`);
      assert.ok(g.by >= 0 && g.by < g.h, `ball y in bounds at ${i}: ${g.by}`);
      assert.ok(g.p1y >= 0 && g.p1y + pong.PADDLE_LEN <= g.h, `player paddle in bounds at ${i}`);
      assert.ok(g.p2y >= 0 && g.p2y + pong.PADDLE_LEN <= g.h, `bot paddle in bounds at ${i}`);
    }
  });

  it('match point ends the match; a win levels up with a harder bot', () => {
    const g = pong.createGame({ width: 20, height: 8, rng: seeded(5) });
    serveUp(g);
    g.you = pong.WIN_POINTS - 1;
    g.bot = 0;
    g.phase = 'rally';
    g.p2y = 0; // bot paddle pinned at the top
    g.bx = g.w - 3;
    g.by = g.h - 1;
    g.bvx = 1;
    g.bvy = 0;
    let guard = 0;
    while (g.phase === 'rally' && guard++ < 30) pong.tick(g);
    assert.equal(g.phase, 'matchwon', 'match point taken');
    assert.equal(g.you, pong.WIN_POINTS);
    const before = g.diff;
    assert.equal(pong.continueGame(g), true);
    assert.equal(g.level, 2, 'win levels up');
    assert.equal(g.you, 0);
    assert.equal(g.bot, 0);
    assert.equal(g.phase, 'serve');
    assert.ok(g.diff.speed >= before.speed && g.diff.step >= before.step, 'level 2 bot is not weaker');
    assert.ok(g.diff.err <= before.err);
  });

  it('three losses spend the lives; the third resets the run to level 1', () => {
    const g = pong.createGame({ width: 20, height: 8, rng: seeded(9) });
    g.phase = 'matchlost';
    assert.equal(pong.continueGame(g), true);
    assert.equal(g.lives, 2);
    assert.equal(g.phase, 'serve', 'first loss only spends a life');
    g.phase = 'matchlost';
    assert.equal(pong.continueGame(g), true);
    assert.equal(g.lives, 1);
    // Pretend the run had climbed before the third loss lands.
    g.level = 3;
    g.phase = 'matchlost';
    assert.equal(pong.continueGame(g), true);
    assert.equal(g.lives, pong.LIVES, 'lives are fresh again');
    assert.equal(g.level, 1, 'the run restarts at level 1');
    assert.equal(g.phase, 'reset', 'with a message before the first serve');
    assert.equal(pong.continueGame(g), true);
    assert.equal(g.phase, 'serve');
  });

  it('restartRun() resets everything to a fresh level 1', () => {
    const g = pong.createGame({ width: 24, height: 8, rng: seeded(15) });
    g.level = 5;
    g.lives = 1;
    g.you = 2;
    g.bot = 2;
    g.phase = 'matchlost';
    assert.equal(pong.restartRun(g), true);
    assert.equal(g.level, 1);
    assert.equal(g.lives, pong.LIVES);
    assert.equal(g.you, 0);
    assert.equal(g.bot, 0);
    assert.equal(g.phase, 'serve');
  });

  it('describe() counts; status() narrates every message phase', () => {
    const g = pong.createGame({ width: 24, height: 8 });
    assert.match(pong.describe(g), /^LEVEL 1 · YOU 0 – 0 BOT · LIVES ●●●$/);
    g.lives = 2;
    assert.match(pong.describe(g), /LIVES ●●·$/);
    g.phase = 'pointyou';
    assert.equal(pong.status(g), 'Point!');
    g.phase = 'pointbot';
    assert.equal(pong.status(g), 'Bot scores.');
    g.phase = 'matchwon';
    assert.match(pong.status(g), /Level 2/);
    g.phase = 'matchlost';
    g.lives = 3;
    assert.match(pong.status(g), /2 lives left/);
    g.lives = 1;
    assert.match(pong.status(g), /Third loss/);
    g.phase = 'reset';
    assert.match(pong.status(g), /Fresh start/);
    g.phase = 'rally';
    assert.equal(pong.status(g), '');
  });

  it('paint() returns exactly w x h single-cell glyphs', () => {
    const g = pong.createGame({ width: 30, height: 8, rng: seeded(11) });
    const rows = pong.paint(g);
    assert.equal(rows.length, 8);
    const ALLOWED = new Set([' ', '·', '●', '▌', '▐']);
    for (const r of rows) {
      assert.equal([...r].length, 30, 'row is exactly w cells');
      for (const ch of r) assert.ok(ALLOWED.has(ch), `unexpected glyph ${JSON.stringify(ch)}`);
    }
    assert.equal(rows[g.p1y][1], '▌', 'player paddle at its column');
    assert.equal(rows[g.p2y + 2][28], '▐', 'bot paddle at its column');
    assert.ok(rows.some((r) => r.includes('●')), 'the ball is visible during the serve pause');
    assert.ok(rows.some((r) => r.includes('·')), 'centre line painted');
  });

  it('seeded runs are deterministic and stay within their invariants', () => {
    const trace = (seed) => {
      const g = pong.createGame({ width: 32, height: 9, rng: seeded(seed) });
      const out = [];
      for (let i = 0; i < 900; i++) {
        autoplay(g);
        pong.tick(g);
        if (g.phase === 'matchwon' || g.phase === 'matchlost' || g.phase === 'reset') {
          pong.continueGame(g);
        }
        assert.ok(g.level >= 1, 'level floor');
        assert.ok(g.lives >= 1 && g.lives <= pong.LIVES, `lives in range: ${g.lives}`);
        assert.ok(g.you >= 0 && g.you <= pong.WIN_POINTS, `you in range: ${g.you}`);
        assert.ok(g.bot >= 0 && g.bot <= pong.WIN_POINTS, `bot in range: ${g.bot}`);
        assert.ok(
          ['serve', 'rally', 'pointyou', 'pointbot', 'matchwon', 'matchlost', 'reset'].includes(g.phase),
          `phase whitelist: ${g.phase}`
        );
        out.push(`${g.phase}:${g.level}:${g.lives}:${g.you}:${g.bot}:${g.bx}:${g.by}:${g.p1y}:${g.p2y}`);
      }
      return out.join('\n');
    };
    const a = trace(1234);
    const b = trace(1234);
    assert.equal(a, b, 'same seed, same run');
    const c = trace(4321);
    assert.ok(a !== c, 'different seed diverges');
    assert.ok(/rally/.test(a), 'the run actually rallies');
  });
});
