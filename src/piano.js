'use strict';

// Offline arcade: the piano — a rhythm cabinet for eight lanes
// (a s d f j k l ;), one piano note per lane (C4 D4 E4 F4 G4 A4 B4 C5).
// Pure engine: no DOM, no timers, no I/O and no rng — the UI owns the
// clock (its interval calls tick()) and the keys (press()/restart()/
// selectSong()), and the songs are fixed sequences, so every run is
// fully deterministic. paint() returns exactly `height` strings of
// `width` single-cell glyphs every frame.
//
// Notes fall as ● balls toward the keyboard strip (the hit line, three
// rows above the floor): tap the lane key when the ball reaches its key.
//   Perfect ≤ 90 ms (+100) · Great ≤ 180 ms (+60) · Good ≤ 300 ms (+30)
// (TICK_MS 60). A press with no ball near the line — or the wrong lane —
// is free; the ball just keeps falling. A ball nobody hits rolls past
// the line, reaches the bottom border and shatters there: that crash is
// a miss, and three of them end the run (r, or Enter on the game-over
// screen, restarts the same song).
//
// Difficulty creeps, never jumps: travel time falls from 2.4 s by 0.03
// ticks per judged hit to a 0.96 s floor, and the note beat is always
// travel/4 — so the melody speeds up very gradually while you survive.
// Five songs rotate 1→2→3→4→5→1; digits pick one, p swaps to free play
// (every key answers with its note, nothing falls), m mutes (the UI).
// The two hard songs double the note density (tempo 2) rather than the
// fall speed, so they stay fair at any creep level.
//
// Glyphs are deliberate single-cell choices (BMP, fullUnicode:false
// safe): ● ball / lit key, ─ white-key line, ▓ black-key block, and the
// key letters a s d f j k l ; in the strip. The field is the box
// interior only.
//
// offlineKind() stays here because index.js has required it from this
// module since the arcade moved in — same classifier, moved code.

const TICK_MS = 60; // ~16 fps: balls read as falling, repaint stays cheap
const KEYS = ['a', 's', 'd', 'f', 'j', 'k', 'l', ';'];
const LANES = KEYS.length;
const NOTES = ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5'];
const BALL = '●';
const LINE = '─';
const BLACK = '▓';
const LIVES = 3;

// Judgment windows in ticks (TICK_MS 60): a press within ±PERFECT_T of
// the line is perfect, and so on. Past ±GOOD_T a press finds no ball.
const PERFECT_T = 1.5; // 90 ms
const GREAT_T = 3; // 180 ms
const GOOD_T = 5; // 300 ms
const SCORE_PERFECT = 100;
const SCORE_GREAT = 60;
const SCORE_GOOD = 30;

// Speed creep: ticks from spawn to the hit line, one -CREEP step per
// judged hit, floored so the game never becomes unplayable. The note
// beat is always a quarter of the travel time.
const START_TRAVEL = 40; // 2.4 s at TICK_MS
const MIN_TRAVEL = 16; // 0.96 s floor
const CREEP_PER_HIT = 0.03;

const FLASH_TICKS = 6; // judgment/miss flash under the box (~0.36 s)
const SONG_FLASH_TICKS = 14; // the song banner lingers longer
const KEY_FLASH = 6; // a pressed key stays lit this long

// The songs — lane indices in C major, recognisable openings: classical
// (Prelude in C, Für Elise, Moonlight Sonata), 8-bit themes (Tetris,
// Megalovania, Mario) and the original three. They loop forever
// (1→…→10→1); digits 1-9 pick a song and 0 picks the tenth. `tempo` 2
// doubles the note density (a note every half beat) — that is what makes
// the hard songs hard, not the fall speed, which every song shares.
const SONGS = [
  {
    name: 'Prelude in C',
    notes: [
      // One broken chord (8 eighths) per bar: C, Dm, Em, F, G, Am, G, C.
      0, 2, 4, 2, 4, 0, 2, 4,
      1, 3, 5, 3, 5, 1, 3, 5,
      2, 4, 6, 4, 6, 2, 4, 6,
      3, 5, 7, 5, 7, 3, 5, 7,
      1, 4, 6, 4, 6, 1, 4, 6,
      2, 5, 7, 5, 7, 2, 5, 7,
      1, 4, 6, 4, 6, 1, 4, 6,
      0, 2, 4, 2, 4, 0, 2, 4,
    ],
  },
  {
    name: 'Ode to Joy',
    notes: [
      2, 2, 3, 4, 4, 3, 2, 1,
      0, 0, 1, 2, 2, 1, 1,
      2, 2, 3, 4, 4, 3, 2, 1,
      0, 0, 1, 2, 1, 0, 0,
    ],
  },
  {
    name: 'Für Elise',
    tempo: 1,
    notes: [
      2, 1, 2, 1, 2, 6, 1, 0,
      5, 0, 2, 5, 6,
      2, 1, 2, 1, 2, 6, 1, 0,
      5, 0, 2, 5, 6,
      2, 0, 6, 5,
      0, 2, 5, 0,
    ],
  },
  {
    name: 'Tetris',
    notes: [
      // Korobeiniki, transposed up a third to sit in C major.
      4, 1, 2, 3, 2, 1, 0, 0,
      2, 4, 3, 2, 1, 1, 2, 3,
      4, 2, 0, 0,
      4, 1, 2, 3, 2, 1, 0, 0,
      2, 4, 3, 2, 1, 1, 2, 3,
      4, 2, 0, 0,
    ],
  },
  {
    name: 'Moonlight Sonata',
    notes: [
      // One triplet arpeggio (8 notes) per bar: Am, Am, Dm, E, Am, F, Dm, E.
      2, 5, 7, 2, 5, 7, 2, 5,
      2, 5, 7, 2, 5, 7, 2, 5,
      1, 3, 5, 1, 3, 5, 1, 3,
      2, 4, 6, 2, 4, 6, 2, 4,
      2, 5, 7, 2, 5, 7, 2, 5,
      3, 5, 7, 3, 5, 7, 3, 5,
      1, 3, 5, 1, 3, 5, 1, 3,
      2, 4, 6, 2, 4, 6, 2, 4,
    ],
  },
  {
    name: 'Twinkle Twinkle',
    notes: [
      0, 0, 4, 4, 5, 5, 4,
      3, 3, 2, 2, 1, 1, 0,
      4, 4, 3, 3, 2, 2, 1,
      4, 4, 3, 3, 2, 2, 1,
      0, 0, 4, 4, 5, 5, 4,
      3, 3, 2, 2, 1, 1, 0,
    ],
  },
  {
    name: 'Jingle Bells',
    notes: [
      2, 2, 2, 2, 2, 2,
      2, 4, 0, 1, 2,
      3, 3, 3, 3, 3, 2, 2,
      2, 2, 1, 1, 2, 1, 4,
    ],
  },
  {
    name: 'Rush E',
    tempo: 2,
    notes: [
      2, 2, 7, 7, 2, 2, 7, 7,
      2, 6, 2, 6, 2, 7, 2, 7,
      0, 7, 0, 7, 0, 6, 0, 6,
      1, 7, 1, 7, 2, 7, 2, 7,
      5, 5, 6, 6, 7, 7, 0, 0,
    ],
  },
  {
    name: 'Megalovania',
    tempo: 2,
    notes: [
      // The riff (D D D A A G G F D F G), four times.
      1, 1, 1, 5, 5, 4, 4, 3, 1, 3, 4,
      1, 1, 1, 5, 5, 4, 4, 3, 1, 3, 4,
      1, 1, 1, 5, 5, 4, 4, 3, 1, 3, 4,
      1, 1, 1, 5, 5, 4, 4, 3, 1, 3, 4,
    ],
  },
  {
    name: 'Mario Overworld',
    tempo: 2,
    notes: [
      // The opening phrase, the B section, and the phrase again.
      2, 2, 2, 7, 2, 4, 4,
      7, 4, 2, 5, 6, 6, 5,
      4, 2, 4, 5, 3, 4, 2, 0, 1, 6,
      2, 2, 2, 7, 2, 4, 4,
    ],
  },
];

// No-internet / dead-slow classifier for navigation errors. 'offline' and
// 'slow' are the two moods the arcade answers; anything else (a plain 404,
// a refused connection, a bad URL) is the user's business, not the game's.
// Chromium says ERR_INTERNET_DISCONNECTED / ERR_NAME_NOT_RESOLVED when the
// uplink is gone; fetch-based callers say "fetch failed"; Playwright says
// "Timeout 20000ms exceeded" when a page never settles.
// A goto that timed out waiting for domcontentloaded never received the
// document at all — that is connectivity, not slowness, even though the
// message says "Timeout"; plain timeouts (no domcontentloaded in the call
// log) keep the slow mood.
const OFFLINE_RE = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|getaddrinfo|fetch failed|network error|offline|timeout \d+ms exceeded[^]*domcontentloaded/i;
const SLOW_RE = /timeout|timed out|ETIMEDOUT|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|aborted|deadline exceeded/i;

function offlineKind(text) {
  const t = String(text || '');
  if (!t) return '';
  if (OFFLINE_RE.test(t)) return 'offline';
  if (SLOW_RE.test(t)) return 'slow';
  return '';
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// Ticks from spawn to the hit line at a given (judged-)hit count. Strictly
// monotonic down to the floor; tests pin the step and the floor.
function travelFor(hits) {
  const n = Math.max(0, Math.floor(Number(hits) || 0));
  return Math.max(MIN_TRAVEL, START_TRAVEL - n * CREEP_PER_HIT);
}

// Note cadence: the beat is always a quarter of the travel time, so the
// stream and the fall speed creep together.
function beatFor(travel) {
  const t = Number.isFinite(Number(travel)) ? Number(travel) : START_TRAVEL;
  return Math.max(1, t / 4);
}

// A song's note density: 1 = one note per beat, 2 = two (the hard ones).
function tempoOf(song) {
  const s = SONGS[clampInt(song, 0, SONGS.length - 1, 0)] || SONGS[0];
  return Math.max(1, Math.floor(Number(s.tempo) || 1));
}

// Ticks between notes for a live game (the beat over the song's tempo).
function spawnBeat(g) {
  const t = g && Number.isFinite(Number(g.travel)) ? Number(g.travel) : START_TRAVEL;
  return Math.max(1, beatFor(t) / tempoOf(g ? g.song : 0));
}

// opts: { width, height, free, song, score, lives, over, hits, noteIdx,
// perfect, great, good, beatAcc, balls }. width/height are the box
// interior in cells. carry() feeds the same shape back in, so a resize
// keeps the whole run — score, lives, song position, the hit count that
// drives the creep and the balls in flight.
function createGame(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const w = clampInt(o.width, 16, 200, 40);
  const h = clampInt(o.height, 6, 40, 18);
  const laneW = Math.max(2, Math.floor(w / LANES));
  const hits = clampInt(o.hits, 0, 9999999, 0);
  const travel = travelFor(hits);
  const free = !!o.free;
  const over = !free && !!o.over;
  const g = {
    w,
    h,
    free,
    laneW,
    x0: Math.floor((w - laneW * LANES) / 2),
    score: free ? 0 : clampInt(o.score, 0, 9999999, 0),
    lives: over ? 0 : clampInt(o.lives, 1, 9, LIVES),
    over,
    song: clampInt(o.song, 0, SONGS.length - 1, 0),
    random: !!o.random, // * random songs: every restart rolls a fresh one
    noteIdx: clampInt(o.noteIdx, 0, 9999, 0),
    hits,
    perfect: clampInt(o.perfect, 0, 9999999, 0),
    great: clampInt(o.great, 0, 9999999, 0),
    good: clampInt(o.good, 0, 9999999, 0),
    travel,
    beatAcc: 0, // set right below: one tick before the song's next note is due
    balls: [], // { lane, t, t0 }: ticks to the line (t ≤ 0 = past it), t0 = spawn travel
    keyFlash: new Array(LANES).fill(0), // lit lane centers for pressed/hit keys
    lastJudge: '',
    lastJudgeTicks: 0,
    lastNote: '', // free play: the note last sounded
    lastNoteTicks: 0,
    flash: '', // transient miss/song line shown by status()
    flashTicks: 0,
    tick: 0,
  };
  if (Number.isFinite(Number(o.beatAcc))) g.beatAcc = Number(o.beatAcc);
  else g.beatAcc = spawnBeat(g) - 1;
  if (!free && Array.isArray(o.balls)) {
    for (const b of o.balls) {
      if (!b) continue;
      const lane = Math.floor(Number(b.lane));
      const t = Number(b.t);
      const t0 = Number(b.t0);
      if (!Number.isFinite(lane) || lane < 0 || lane >= LANES || !Number.isFinite(t)) continue;
      g.balls.push({ lane, t, t0: Number.isFinite(t0) && t0 > 0 ? t0 : travel });
    }
  }
  return g;
}

// The fields that make a run a run — everything unique about its state.
// The UI spreads this into a fresh createGame() when the arena changes
// (resize, mode swap), the only sanctioned way to move a run.
function carry(g) {
  if (!g || typeof g !== 'object') return {};
  return {
    score: g.score,
    lives: g.lives,
    over: g.over,
    song: g.song,
    noteIdx: g.noteIdx,
    hits: g.hits,
    perfect: g.perfect,
    great: g.great,
    good: g.good,
    free: g.free,
    random: g.random === true,
    beatAcc: g.beatAcc,
    balls: (Array.isArray(g.balls) ? g.balls : []).map((b) => ({ lane: b.lane, t: b.t, t0: b.t0 })),
  };
}

// Where a ball at `t` ticks (t0 = its spawn travel) sits in the field:
// row 0 fresh, the hit line at t = 0, and the bottom border exactly when
// the good window runs out (t = -GOOD_T). The last two rows are the
// landing zone the ball rolls through while a late tap is still judged.
function ballRow(g, t, t0) {
  const h = g && Number.isFinite(Number(g.h)) ? Number(g.h) : 18;
  const lineRow = Math.max(1, h - 3);
  const span = Number.isFinite(Number(t0)) && Number(t0) > 0
    ? Number(t0)
    : (g && Number.isFinite(Number(g.travel)) ? Number(g.travel) : START_TRAVEL);
  const tt = Number.isFinite(Number(t)) ? Number(t) : span;
  let f;
  if (tt >= 0) {
    f = lineRow * (1 - Math.min(tt, span) / Math.max(1, span));
  } else {
    f = lineRow + Math.min(GOOD_T, -tt) * (2 / GOOD_T);
  }
  return Math.max(0, Math.min(h - 1, Math.round(f)));
}

// Press the lane key. In song mode this is the judge: the nearest ball in
// that lane within the good window scores (perfect/great/good) and leaves
// the board; anything else returns '' and costs nothing. Free play always
// answers 'note' — the UI sounds the lane's frequency on that.
function press(g, lane) {
  if (!g || typeof g !== 'object') return '';
  const i = Math.floor(Number(lane));
  if (!Number.isFinite(i) || i < 0 || i >= LANES) return '';
  if (g.free) {
    g.keyFlash[i] = KEY_FLASH;
    g.lastNote = NOTES[i];
    g.lastNoteTicks = KEY_FLASH;
    return 'note';
  }
  if (g.over) return '';
  let best = -1;
  let bestAbs = Infinity;
  for (let k = 0; k < g.balls.length; k++) {
    const b = g.balls[k];
    if (b.lane !== i) continue;
    const a = Math.abs(b.t);
    if (a <= GOOD_T && a < bestAbs) {
      bestAbs = a;
      best = k;
    }
  }
  if (best < 0) return '';
  g.balls.splice(best, 1);
  const judge = bestAbs <= PERFECT_T ? 'perfect' : bestAbs <= GREAT_T ? 'great' : 'good';
  g.score += judge === 'perfect' ? SCORE_PERFECT : judge === 'great' ? SCORE_GREAT : SCORE_GOOD;
  if (judge === 'perfect') g.perfect += 1;
  else if (judge === 'great') g.great += 1;
  else g.good += 1;
  g.hits += 1;
  g.travel = travelFor(g.hits);
  g.keyFlash[i] = KEY_FLASH;
  g.lastJudge = judge;
  g.lastJudgeTicks = FLASH_TICKS;
  return judge;
}

// One flash-length step for every transient marker (judgment, miss/song
// banner, key lights, free-play note readout).
function decay(g) {
  if (g.flashTicks > 0) {
    g.flashTicks -= 1;
    if (g.flashTicks <= 0) {
      g.flashTicks = 0;
      g.flash = '';
    }
  }
  if (g.lastJudgeTicks > 0) {
    g.lastJudgeTicks -= 1;
    if (g.lastJudgeTicks <= 0) {
      g.lastJudgeTicks = 0;
      g.lastJudge = '';
    }
  }
  if (g.lastNoteTicks > 0) {
    g.lastNoteTicks -= 1;
    if (g.lastNoteTicks <= 0) {
      g.lastNoteTicks = 0;
      g.lastNote = '';
    }
  }
  for (let i = 0; i < LANES; i++) if (g.keyFlash[i] > 0) g.keyFlash[i] -= 1;
}

// The next note in the current song; past the last one the song advances
// (1→2→3→1) and announces itself. Balls spawn at the top row, t = travel.
function spawnNote(g) {
  const s = SONGS[g.song] || SONGS[0];
  const idx = Math.max(0, Math.min(s.notes.length - 1, g.noteIdx));
  const lane = s.notes[idx];
  g.noteIdx = idx + 1;
  if (g.noteIdx >= s.notes.length) {
    g.noteIdx = 0;
    g.song = (g.song + 1) % SONGS.length;
    g.flash = `Song ${g.song + 1}: ${SONGS[g.song].name}`;
    g.flashTicks = SONG_FLASH_TICKS;
  }
  const t0 = Math.max(1, g.travel);
  g.balls.push({ lane, t: t0, t0 });
  return lane;
}

// One world tick. Order is fixed: markers decay, every ball steps down
// (one that passes the good window crashes on the border — life gone, a
// miss event), then the song spawns on the beat. Returns the important
// events as strings: 'miss', 'over'. Free play only decays.
function tick(g) {
  const ev = [];
  if (!g || typeof g !== 'object') return ev;
  if (g.free) {
    g.tick += 1;
    decay(g);
    return ev;
  }
  if (g.over) return ev;
  g.tick += 1;
  decay(g);
  for (let i = g.balls.length - 1; i >= 0; i--) {
    const b = g.balls[i];
    b.t -= 1;
    if (b.t >= -GOOD_T) continue;
    g.balls.splice(i, 1);
    g.lives = Math.max(0, g.lives - 1);
    if (g.lives === 0) {
      g.over = true;
      g.balls = [];
      ev.push('over');
      break;
    }
    g.flash = `Miss — ${g.lives} ${g.lives === 1 ? 'life' : 'lives'} left`;
    g.flashTicks = FLASH_TICKS;
    ev.push('miss');
  }
  if (g.over) return ev;
  g.beatAcc += 1;
  const beat = spawnBeat(g);
  let guard = 0;
  while (g.beatAcc >= beat && guard++ < 64) {
    g.beatAcc -= beat;
    spawnNote(g);
  }
  return ev;
}

// A song index other than `exclude`, uniformly at random — random mode
// never repeats the same song twice in a row.
function pickRandom(exclude) {
  const n = SONGS.length;
  if (n < 2) return 0;
  const cur = Number.isFinite(Number(exclude))
    ? Math.max(0, Math.min(n - 1, Math.floor(Number(exclude))))
    : 0;
  return (cur + 1 + Math.floor(Math.random() * (n - 1))) % n;
}

// Fresh run — same song (a random-songs run rolls a fresh one), same
// arena, speed back to the start.
function restart(g) {
  if (!g || typeof g !== 'object') return g;
  // Random mode rolls the next song first, so the beat/tempo below are
  // computed for the song that will actually play.
  const rolled = g.random ? pickRandom(g.song) : -1;
  if (rolled >= 0) g.song = rolled;
  g.score = 0;
  g.lives = LIVES;
  g.over = false;
  g.hits = 0;
  g.perfect = 0;
  g.great = 0;
  g.good = 0;
  g.travel = travelFor(0);
  g.beatAcc = spawnBeat(g) - 1;
  g.balls = [];
  g.noteIdx = 0;
  g.keyFlash = new Array(LANES).fill(0);
  g.lastJudge = '';
  g.lastJudgeTicks = 0;
  g.lastNote = '';
  g.lastNoteTicks = 0;
  g.flash = '';
  g.flashTicks = 0;
  g.tick = 0;
  if (rolled >= 0) {
    g.flash = `Song ${g.song + 1}: ${SONGS[g.song].name}`;
    g.flashTicks = SONG_FLASH_TICKS;
  }
  return g;
}

// Pick a song by index and start a fresh run on it, from any mode (free
// play included — a song pick means "play this song now"). An explicit
// pick also takes over from random mode.
function selectSong(g, i) {
  if (!g || typeof g !== 'object') return false;
  const idx = Math.floor(Number(i));
  if (!Number.isFinite(idx) || idx < 0 || idx >= SONGS.length) return false;
  g.random = false;
  g.free = false;
  g.song = idx;
  restart(g);
  g.flash = `Song ${idx + 1}: ${SONGS[idx].name}`;
  g.flashTicks = SONG_FLASH_TICKS;
  return true;
}

// * toggles random songs and returns the new state. On: a fresh random
// song right away, and every restart rolls another one (never the same
// twice in a row). Off: restarts replay the current song again.
function toggleRandom(g) {
  if (!g || typeof g !== 'object') return false;
  if (g.random) {
    g.random = false;
    g.flash = 'Random songs off';
    g.flashTicks = SONG_FLASH_TICKS;
    return false;
  }
  g.random = true;
  g.free = false; // a random pick is a song pick: it leaves free play
  restart(g); // restart rolls the first song and flashes its name
  g.flash = `Random songs — ${SONGS[g.song].name}`;
  g.flashTicks = SONG_FLASH_TICKS;
  return true;
}

// The game-over screen: the field becomes the score card — GAME OVER, the
// final score, the grade counts and the restart key, centered and clipped
// to the field so it reads at every arena size.
function paintOver(g, rows) {
  const lines = [
    'GAME OVER',
    `SCORE ${g.score}`,
    `${g.perfect} perfect · ${g.great} great`,
    `${g.good} good · ${g.hits} hit${g.hits === 1 ? '' : 's'}`,
    'r / Enter restarts',
  ];
  const top = Math.max(0, Math.floor((g.h - lines.length) / 2));
  for (let i = 0; i < lines.length; i++) {
    const y = top + i;
    if (y < 0 || y >= g.h) continue;
    const text = lines[i].slice(0, g.w);
    const x = Math.max(0, Math.floor((g.w - text.length) / 2));
    for (let c = 0; c < text.length; c++) rows[y][x + c] = text[c];
  }
}

// Exactly `h` rows of `w` cells. The keyboard strip sits three rows above
// the floor (the hit line), white keys drawn as ─ with their letter,
// black keys as ▓ blocks with theirs, alternating — and a pressed/hit key
// lights up as ●. Balls are plotted on top, so a ball reaching the line
// covers its own key letter. A finished run paints the game-over card in
// place of the whole field.
function paint(g) {
  const rows = [];
  for (let y = 0; y < g.h; y++) rows.push(new Array(g.w).fill(' '));
  if (g && g.over) {
    paintOver(g, rows);
    return rows.map((r) => r.join(''));
  }
  const strip = Math.max(0, Math.min(g.h - 1, g.h - 3));
  const off = Math.floor((g.laneW - 1) / 2);
  for (let i = 0; i < LANES; i++) {
    const x = g.x0 + i * g.laneW;
    if (x >= g.w) continue;
    const black = i % 2 === 1;
    for (let c = 0; c < g.laneW && x + c < g.w; c++) rows[strip][x + c] = black ? BLACK : LINE;
    const cx = x + off;
    if (cx >= 0 && cx < g.w) rows[strip][cx] = g.keyFlash && g.keyFlash[i] > 0 ? BALL : KEYS[i];
  }
  for (const b of g.balls) {
    const y = ballRow(g, b.t, b.t0);
    const x = g.x0 + b.lane * g.laneW + off;
    if (x >= 0 && x < g.w && y >= 0 && y < g.h) rows[y][x] = BALL;
  }
  return rows.map((r) => r.join(''));
}

// One status line for the box header row.
function describe(g) {
  if (!g || typeof g !== 'object') return '';
  if (g.free) return 'FREE PLAY · press any key';
  if (g.over) return `SCORE ${g.score} · GAME OVER`;
  const full = Math.max(0, Math.min(LIVES, g.lives));
  const hearts = '♥'.repeat(full) + '·'.repeat(Math.max(0, LIVES - full));
  return `SCORE ${g.score} · LIVES ${hearts}`;
}

// The line under the arena: the last judgment while it is fresh, then
// miss/song banners, the game-over score card, the free-play note — or ''
// during quiet play (the note set at open explains the rules).
function status(g) {
  if (!g || typeof g !== 'object') return '';
  if (g.free) return g.lastNoteTicks > 0 && g.lastNote ? `♪ ${g.lastNote}` : '';
  if (g.over) {
    return `Game over — ${g.perfect} perfect · ${g.great} great · ${g.good} good — r or Enter restarts`;
  }
  if (g.lastJudgeTicks > 0 && g.lastJudge) {
    return g.lastJudge === 'perfect' ? 'Perfect!' : g.lastJudge === 'great' ? 'Great!' : 'Good!';
  }
  if (g.flashTicks > 0 && g.flash) return g.flash;
  return '';
}

module.exports = {
  TICK_MS,
  KEYS,
  LANES,
  NOTES,
  SONGS,
  BALL,
  LINE,
  BLACK,
  LIVES,
  PERFECT_T,
  GREAT_T,
  GOOD_T,
  SCORE_PERFECT,
  SCORE_GREAT,
  SCORE_GOOD,
  START_TRAVEL,
  MIN_TRAVEL,
  CREEP_PER_HIT,
  FLASH_TICKS,
  KEY_FLASH,
  travelFor,
  beatFor,
  tempoOf,
  spawnBeat,
  ballRow,
  createGame,
  carry,
  press,
  tick,
  restart,
  selectSong,
  toggleRandom,
  pickRandom,
  paint,
  describe,
  status,
  offlineKind,
};
