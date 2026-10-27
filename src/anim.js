'use strict';

// Shared micro-animations: tiny pure frame tables (unit-tested without a
// screen) plus ONE lazily-started, self-stopping ticker so N animations
// share a single unref'd interval. The memory rule: zero timers while
// nothing is animating — the ticker starts with the first subscriber and
// clears itself the moment the last one unsubscribes. Glyphs stay BMP and
// single-cell (fullUnicode:false house rule): ♪ ♫ · ▍.
//
// Homes today: the now-playing note bops via position parity inside
// nowplaying.js (no timer at all); the AI "thinking" placeholder streams
// its dots through this ticker while a model call is in flight. The wave
// loader (ui.js) keeps its own 60 ms table — it predates this module and
// is pinned byte-exact by tests.

function mod(n, m) {
  return ((Math.trunc(Number(n) || 0) % m) + m) % m;
}

// Music-note bop: two frames, one cell. Kept here as the canonical table
// (tests pin it); formatNowPlaying derives the same flip from position.
const BOP = ['♪', '♫'];
function bop(i) {
  return BOP[mod(i, BOP.length)];
}

// Thinking dots: grow, hold, shrink — '▍ thinking ·' → '▍ thinking ···'.
const DOTS = [' ·', ' ··', ' ···', ' ··'];
function dots(i) {
  return DOTS[mod(i, DOTS.length)];
}

// createTicker(): one setInterval at baseMs resolution (default 130) that
// calls each subscriber at its own cadence. add(fn, ms) returns an
// unsubscribe function; removing the last subscriber stops the timer.
// Injectable baseMs keeps tests fast; the timer is unref'd so a missed
// unsubscribe can never hold the process open.
function createTicker(opts) {
  const baseMs = Math.max(10, Number(opts && opts.baseMs) || 130);
  let timer = null;
  let frame = 0;
  const subs = new Set();
  const stopIfIdle = () => {
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  const tick = () => {
    frame += 1;
    const now = Date.now();
    for (const s of [...subs]) {
      if (now - s.at < s.ms) continue;
      s.at = now;
      try {
        s.fn(frame);
      } catch {
        /* one animation never breaks the rest */
      }
    }
  };
  return {
    add(fn, ms) {
      if (typeof fn !== 'function') return () => {};
      const sub = { fn, ms: Math.max(baseMs, Number(ms) || baseMs), at: 0 };
      subs.add(sub);
      if (!timer) {
        timer = setInterval(tick, baseMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
      return () => {
        subs.delete(sub);
        stopIfIdle();
      };
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      subs.clear();
    },
    get active() {
      return !!timer;
    },
    get size() {
      return subs.size;
    },
  };
}

module.exports = { BOP, DOTS, bop, dots, createTicker };
