'use strict';

// Live mood pet: kaomoji that reacts to what the browser is doing
// (loading → thinking, fail → sad, login → love …), picked at random.
// Source: kaomojiya-collection/kaomoji-collection categories on GitHub
// (raw.githubusercontent.com, a few KB per mood). Bundled FALLBACK pools
// keep the pet alive offline or on low data; live lists are cached on disk
// and in memory once fetched. Zero new deps: global fetch only.
//
// Upstream files embed HTML entities (&gt; &#x27; …) — decodeEntities
// normalizes them before anything paints.

const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = 'https://raw.githubusercontent.com/kaomojiya-collection/kaomoji-collection/main/categories';

// Mood -> upstream category file. Kept small on purpose: six moods cover
// every browser event (see moodForEvent).
const MOODS = {
  happy: 'yorokobu',
  sad: 'sad',
  thinking: 'kangaeru',
  love: 'love',
  troubled: 'komaru',
  sleepy: 'nemui',
};

// Offline pools (decoded, curated). Every pool is non-empty by contract.
const FALLBACK = {
  happy: ['(☆‿☆)', '(⁎˃ᴗ˂⁎)', '(╯✧▽✧)╯', '(´ω`*)', '(/ω＼✿)', '(˘ᴗ˘)♡'],
  sad: ['(´△｀)', '(T_T)', '(>_<)', '(；ω；)', '(u_u)'],
  thinking: ['(・・？)', '(?_?)', '(･-･)', '(ーー゛)', '(mm*)'],
  love: ['(♥ε♥)', '(♥ω♥*)', '(´∀｀)♡', '(♡_♡)', '(●♡∀♡)'],
  troubled: ['(^_^;)', '(-_-;)', '(>﹏<)', '(｡ŏ﹏ŏ)'],
  sleepy: ['( ˘ω˘ )zzz', '( ˘ᵕ˘ )zz', '(－ω－)｡･ﾟﾟ'],
};

const FETCH_TIMEOUT_MS = 4000;
const MAX_LIVE = 300;

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return _;
      }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 10));
      } catch {
        return _;
      }
    })
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function moodNames() {
  return Object.keys(MOODS);
}

// Frames to animate through for a mood (sync pool: non-empty, instant).
function petFrames(mood) {
  return poolFor(mood);
}

// Easter eggs: special slash inputs that get a fun reply.
const EASTER_EGGS = {
  '42': '(‿ˠ‿) 42',
  'sudo make me a sandwich': '( ´▽` )ﾉ okay~',
  rickroll: '♪ never gonna give you up ♪',
  konami: '↑↑↓↓←→←→BA (ﾉ>∀<)ﾉ',
  hello: '(・ω・)ﾉ hi!',
  hi: '(・ω・)ﾉ hi!',
  egg: '(´・ω・`) you found an easter egg~',
  ping: 'pong! (≧▽≦)',
  coffee: '( ´ー`)ﾉ☕ brew~',
  dance: '♪┌|∵|┘♪ └|∵|┐♪ (ﾉ>∀<)ﾉ',
};
function easterEgg(input) {
  const k = String(input || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(EASTER_EGGS, k) ? EASTER_EGGS[k] : null;
}

// Live lists once fetched (memory cache; disk cache alongside).
const live = {};

function poolFor(mood) {
  if (mood && live[mood] && live[mood].length > 0) return live[mood];
  if (mood && FALLBACK[mood] && FALLBACK[mood].length > 0) return FALLBACK[mood];
  return FALLBACK.happy;
}

// Random pet for a mood (unknown moods fall back to happy, never blank).
// `rand` is injectable so tests can seed it.
function petFor(mood, rand) {
  const pool = poolFor(mood);
  const r = typeof rand === 'function' ? rand() : Math.random();
  const i = Math.abs(Math.floor(Number(r) * pool.length)) % pool.length;
  return pool[i];
}

// Browser event -> mood. Pure and total: unknown events get happy.
function moodForEvent(event) {
  switch (String(event || '')) {
    case 'error':
    case 'fail':
    case 'invalid':
      return 'sad';
    case 'blocked':
    case 'captcha':
    case 'denied':
      return 'troubled';
    case 'loading':
    case 'thinking':
      return 'thinking';
    case 'login':
    case 'success':
    case 'love':
      return 'love';
    case 'idle':
    case 'sleep':
      return 'sleepy';
    default:
      return 'happy';
  }
}

function cacheFile(mood) {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'tui-browser', `kaomoji-${mood}.json`);
}

// Fetch + decode + cache one mood's live list. Resolves the list, or null
// on any failure (caller keeps the fallback pool). Never throws.
async function loadLiveMood(mood, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (!mood || !MOODS[mood]) return null;
  if (live[mood] && live[mood].length > 0) return live[mood];
  // Disk cache first: free on low data.
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(mood), 'utf8'));
    if (Array.isArray(raw) && raw.length > 0 && raw.every((s) => typeof s === 'string')) {
      live[mood] = raw.slice(0, MAX_LIVE);
      return live[mood];
    }
  } catch {
    /* miss — fetch live */
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    t.unref();
  } catch {
    /* timers without unref */
  }
  try {
    const res = await fetch(`${BASE}/${MOODS[mood]}.json`, { signal: ctl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    const list = data
      .filter((s) => typeof s === 'string')
      .map((s) => decodeEntities(s).trim())
      .filter((s) => s.length > 0 && s.length <= 60)
      .slice(0, MAX_LIVE);
    if (list.length === 0) return null;
    live[mood] = list;
    try {
      fs.mkdirSync(path.dirname(cacheFile(mood)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(cacheFile(mood), JSON.stringify(list));
    } catch {
      /* memory cache still works */
    }
    return list;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Fire-and-forget warmup for the moods the browser shows unprompted.
// Skipped under TUI_TEST so the suite never touches the network.
function primePets() {
  if (process.env.TUI_TEST) return;
  for (const mood of ['happy', 'sad', 'thinking']) {
    loadLiveMood(mood).catch(() => {});
  }
}

module.exports = {
  MOODS,
  FALLBACK,
  FETCH_TIMEOUT_MS,
  decodeEntities,
  moodNames,
  petFrames,
  easterEgg,
  petFor,
  moodForEvent,
  loadLiveMood,
  primePets,
};
