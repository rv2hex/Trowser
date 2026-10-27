'use strict';

// Pong vs the machine — the arcade's second cabinet. Pure engine: no DOM,
// no timers, no I/O. The UI owns the clock (its interval calls tick()) and
// the keys (nudge()/continueGame()/restartRun()). Every random draw goes
// through the injected rng so tests are deterministic; paint() returns
// exactly `h` strings of `w` single-cell glyphs every frame.
//
// The rules the user asked for: beat the bot to level up (every level is
// faster and tracks better); lose three matches and the run restarts at
// level 1. A match is first to WIN_POINTS points.
//
// Controls are deliberately one-dimensional:
// ↑/↓ (or w/s, k/j) nudge the left paddle; Enter continues between
// matches. Glyphs: ● ball, ▌ player paddle, ▐ bot paddle — BMP, single
// cell. The dashed centre line is '·' (the house BOLT glyph).

const TICK_MS = 80; // ~12.5 fps: fluid ball without repaint churn
const BALL = '●';
const P1 = '▌';
const P2 = '▐';
const PADDLE_LEN = 3;
const WIN_POINTS = 3; // first to 3 takes the match
const LIVES = 3; // three match losses restart the run at level 1
const SERVE_TICKS = 11; // pause before each serve (~0.9 s)
const POINT_TICKS = 7; // pause after a non-deciding point
const P1_X = 1; // player paddle column
const PLAY = new Set(['serve', 'rally', 'pointyou', 'pointbot']);

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// Difficulty curve, monotonic in level (tests pin it): speed = ball cells
// per tick, step = bot cells moved per ball step, err = persistent aim
// offset in cells (0 = perfect tracking from level 4 on).
function difficulty(level) {
  const lv = clampInt(level, 1, 99, 1);
  return {
    speed: Math.min(2, 0.65 + (lv - 1) * 0.35),
    step: Math.min(3, 0.8 + (lv - 1) * 0.5),
    err: Math.max(0, 4 - lv),
  };
}

// opts: { width, height, rng, level, lives, you, bot }. width/height are
// the box interior in cells; rng defaults to Math.random. Passing
// level/lives/you/bot lets a resize keep the run going (the UI rebuilds
// the game at the new dims); mid-match details reset to a fresh serve.
function createGame(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const w = clampInt(o.width, 16, 200, 40);
  const h = clampInt(o.height, 6, 40, 12);
  const g = {
    w,
    h,
    rng: typeof o.rng === 'function' ? o.rng : Math.random,
    level: clampInt(o.level, 1, 99, 1),
    lives: clampInt(o.lives, 1, 9, LIVES),
    you: clampInt(o.you, 0, 99, 0),
    bot: clampInt(o.bot, 0, 99, 0),
    p1y: Math.max(0, Math.min(h - PADDLE_LEN, Math.floor(h / 2) - 1)),
    p2y: Math.max(0, Math.min(h - PADDLE_LEN, Math.floor(h / 2) - 1)),
    bx: Math.floor(w / 2),
    by: Math.floor(h / 2),
    bvx: 0,
    bvy: 0,
    phase: 'serve',
    wait: SERVE_TICKS,
    frame: 0,
    speedAcc: 0,
    botAcc: 0,
    err: 0,
    serveDir: o.rng && o.rng() < 0.5 ? -1 : 1,
  };
  g.diff = difficulty(g.level);
  return g;
}

// Move the player paddle one cell; clamped at both ends, only while the
// ball is in play or about to serve. Returns true when it actually moved
// (the UI repaints on true).
function nudge(g, dir) {
  if (!g || !PLAY.has(g.phase)) return false;
  const step = dir < 0 ? -1 : 1;
  const next = Math.max(0, Math.min(g.h - PADDLE_LEN, g.p1y + step));
  if (next === g.p1y) return false;
  g.p1y = next;
  return true;
}

function startServe(g) {
  g.phase = 'serve';
  g.wait = SERVE_TICKS;
  g.bx = Math.floor(g.w / 2);
  g.by = Math.floor(g.h / 2);
  g.bvx = 0;
  g.bvy = 0;
  g.speedAcc = 0;
  g.botAcc = 0;
}

function point(g, who, ev) {
  if (who === 'you') g.you++;
  else g.bot++;
  if (g.you >= WIN_POINTS || g.bot >= WIN_POINTS) {
    if (g.you >= WIN_POINTS) {
      g.phase = 'matchwon';
      ev.push('match-won');
    } else {
      g.phase = 'matchlost';
      ev.push('match-lost');
    }
    return;
  }
  g.phase = who === 'you' ? 'pointyou' : 'pointbot';
  g.wait = POINT_TICKS;
  ev.push(who === 'you' ? 'point-you' : 'point-bot');
}

// One ball step: the bot tracks (only an incoming ball, with its
// persistent aim offset), walls bounce, the paddle planes decide
// bounce-or-point. Mutates phase via point().
function stepBall(g, ev) {
  if (g.bvx > 0) {
    g.botAcc += g.diff.step;
    while (g.botAcc >= 1) {
      g.botAcc -= 1;
      const target = Math.max(0, Math.min(g.h - 1, g.by + g.err));
      if (target < g.p2y) g.p2y = Math.max(0, g.p2y - 1);
      else if (target > g.p2y + PADDLE_LEN - 1) g.p2y = Math.min(g.h - PADDLE_LEN, g.p2y + 1);
    }
  }
  let nx = g.bx + g.bvx;
  let ny = g.by + g.bvy;
  if (ny < 0) {
    ny = 0;
    g.bvy = 1;
  } else if (ny > g.h - 1) {
    ny = g.h - 1;
    g.bvy = -1;
  }
  const p2x = g.w - 2;
  if (g.bvx < 0 && nx <= P1_X) {
    if (ny >= g.p1y && ny <= g.p1y + PADDLE_LEN - 1) {
      nx = P1_X + 1;
      g.bvx = 1;
      const off = ny - (g.p1y + 1);
      if (off !== 0) g.bvy = off < 0 ? -1 : 1;
    } else {
      point(g, 'bot', ev);
      return;
    }
  } else if (g.bvx > 0 && nx >= p2x) {
    if (ny >= g.p2y && ny <= g.p2y + PADDLE_LEN - 1) {
      nx = p2x - 1;
      g.bvx = -1;
      const off = ny - (g.p2y + 1);
      if (off !== 0) g.bvy = off < 0 ? -1 : 1;
    } else {
      point(g, 'you', ev);
      return;
    }
  }
  g.bx = nx;
  g.by = ny;
}

// One world tick. Returns the events fired this tick (for tests and the
// UI's ears): 'serve', 'point-you', 'point-bot', 'match-won', 'match-lost'.
function tick(g) {
  const ev = [];
  if (!g) return ev;
  g.frame++;
  if (g.phase === 'serve') {
    if (g.wait > 0) g.wait--;
    if (g.wait <= 0) {
      const d = g.serveDir || (g.rng() < 0.5 ? -1 : 1);
      g.bvx = d;
      g.bvy = g.rng() < 0.5 ? -1 : 1;
      g.serveDir = -d;
      g.err = Math.round((g.rng() * 2 - 1) * g.diff.err);
      g.phase = 'rally';
      ev.push('serve');
    }
    return ev;
  }
  if (g.phase === 'pointyou' || g.phase === 'pointbot') {
    g.wait--;
    if (g.wait <= 0) {
      startServe(g);
      ev.push('serve');
    }
    return ev;
  }
  if (g.phase !== 'rally') return ev; // message phases wait for continueGame()
  g.speedAcc += g.diff.speed;
  while (g.speedAcc >= 1) {
    g.speedAcc -= 1;
    stepBall(g, ev);
    if (g.phase !== 'rally') break;
  }
  return ev;
}

// Enter between matches. 'matchwon' -> level up; 'matchlost' -> spend a
// life (third loss resets the run to level 1 with fresh lives);
// 'reset' -> serve. Returns true when it actually advanced.
function continueGame(g) {
  if (!g) return false;
  if (g.phase === 'matchwon') {
    g.level += 1;
    g.diff = difficulty(g.level);
    g.you = 0;
    g.bot = 0;
    startServe(g);
    return true;
  }
  if (g.phase === 'matchlost') {
    g.you = 0;
    g.bot = 0;
    const left = g.lives - 1;
    if (left <= 0) {
      g.level = 1;
      g.lives = LIVES;
      g.diff = difficulty(1);
      g.phase = 'reset';
      return true;
    }
    g.lives = left;
    startServe(g);
    return true;
  }
  if (g.phase === 'reset') {
    startServe(g);
    return true;
  }
  return false;
}

// r restarts the whole run: level 1, three lives, fresh serve.
function restartRun(g) {
  if (!g) return false;
  g.level = 1;
  g.lives = LIVES;
  g.you = 0;
  g.bot = 0;
  g.diff = difficulty(1);
  g.p1y = Math.max(0, Math.min(g.h - PADDLE_LEN, Math.floor(g.h / 2) - 1));
  g.p2y = g.p1y;
  startServe(g);
  return true;
}

function plot(rows, g, x, y, ch) {
  if (x < 0 || x >= g.w || y < 0 || y >= g.h) return;
  if (rows[y][x] === ' ' || rows[y][x] === '·') rows[y][x] = ch;
}

function paint(g) {
  const rows = [];
  for (let y = 0; y < g.h; y++) rows.push(new Array(g.w).fill(' '));
  const cx = Math.floor(g.w / 2);
  for (let y = 0; y < g.h; y += 2) rows[y][cx] = '·';
  for (let i = 0; i < PADDLE_LEN; i++) {
    plot(rows, g, P1_X, g.p1y + i, P1);
    plot(rows, g, g.w - 2, g.p2y + i, P2);
  }
  if (g.bvx !== 0 || g.phase === 'serve') plot(rows, g, g.bx, g.by, BALL);
  return rows.map((r) => r.join(''));
}

// One status line for the box header row.
function describe(g) {
  if (!g) return '';
  const hearts = '●'.repeat(Math.max(0, Math.min(LIVES, g.lives))) + '·'.repeat(Math.max(0, LIVES - g.lives));
  return `LEVEL ${g.level} · YOU ${g.you} – ${g.bot} BOT · LIVES ${hearts}`;
}

// The line under the arena: live messages between matches, '' during play
// (the note set at open explains the rules).
function status(g) {
  if (!g) return '';
  switch (g.phase) {
    case 'pointyou':
      return 'Point!';
    case 'pointbot':
      return 'Bot scores.';
    case 'matchwon':
      return `Match! Level ${g.level + 1}'s bot is faster — Enter serves`;
    case 'matchlost': {
      const left = g.lives - 1;
      return left > 0
        ? `Bot takes the match — ${left} ${left === 1 ? 'life' : 'lives'} left (Enter)`
        : `Third loss — the run restarts at level 1 (Enter)`;
    }
    case 'reset':
      return 'Fresh start — level 1, three lives (Enter)';
    default:
      return '';
  }
}

module.exports = {
  TICK_MS,
  BALL,
  P1,
  P2,
  PADDLE_LEN,
  WIN_POINTS,
  LIVES,
  difficulty,
  createGame,
  nudge,
  tick,
  continueGame,
  restartRun,
  paint,
  describe,
  status,
};
