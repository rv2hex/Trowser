'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Playwright is required lazily: loading it costs ~300 ms and nothing on
// the boot path (dashboard paint, command routing) needs it — only the
// first navigation that actually launches a browser does. Same dependency,
// same API, just paid at first use instead of at startup.
let playwrightMod = null;
function playwright() {
  if (!playwrightMod) playwrightMod = require('playwright');
  return playwrightMod;
}
const { cleanLinks } = require('./links');
const { isMediaUrl, isTrackerUrl } = require('./blocklist');
const { extractArticle, heroFrom, heroCandidates } = require('./readability');
const { fillResults } = require('./searchFill');
const { looksLikeChallenge } = require('./engines');

// NOTE (backend): every driver call lives in this file — Playwright +
// Chrome (system install via `channel: 'chrome'`, zero download) by default,
// Firefox via `new Browser({ engine: 'firefox' })`. To switch engines later,
// change the default below; the rest of this class only uses cross-browser
// Playwright APIs (launchPersistentContext, route, goto, evaluate, close).
// No other file requires a driver library (verified: only this file does).
const DEFAULT_ENGINE = 'chrome';

function defaultProfileDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'tui-browser', 'profile');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Max total time for a navigation (goto + settle + extraction).
// If exceeded, the tab is closed and navigation fails — prevents RAM clog
// from stalled loads. 60s covers slow sites + YouTube SPA + settle.
const NAV_TIMEOUT_MS = 60000;

// Human text for anything that was thrown. Playwright throws Errors, but
// our own code paths (and rejected promises) can carry plain objects — and
// `${obj}` renders those as the literal "[object Object]", which is the
// worst possible error message. Dig out the useful fields instead.
// Playwright's call log embeds ANSI dim codes; strip them so the TUI never
// paints raw escape junk inside error text.
function errText(err, fallback = 'unknown error') {
  const clean = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (err == null) return fallback;
  if (typeof err === 'string') return clean(err) || fallback;
  try {
    if (typeof err.message === 'string' && err.message.trim()) return clean(err.message);
    if (typeof err.error === 'string' && err.error.trim()) return clean(err.error);
    if (err.error && typeof err.error.message === 'string') return clean(err.error.message);
    if (typeof err.reason === 'string' && err.reason.trim()) return clean(err.reason);
    const keys = Object.keys(err).slice(0, 4);
    if (keys.length) {
      const parts = keys.map((k) => {
        const v = err[k];
        const s = typeof v === 'string' ? v : v && typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v);
        return `${k}: ${String(s).slice(0, 120)}`;
      });
      return parts.join(' · ').slice(0, 240);
    }
  } catch { /* fall through */ }
  return fallback;
}

// Wait until JS-driven rendering settles: sample body text length until it
// stops changing (stable) or a short budget runs out. Budget is tight on
// purpose — this browser beats normal browsers by extracting text ASAP
// instead of waiting on trackers and pixels.
async function settlePage(page, { stableRounds = 2, intervalMs = 250, maxMs = 1500 } = {}) {
  let last = -1;
  let stable = 0;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    let len = -1;
    try {
      len = await page.evaluate(() =>
        document && document.body ? (document.body.innerText || '').length : -1
      );
    } catch {
      break;
    }
    if (len === last) {
      stable += 1;
      if (stable >= stableRounds) break;
    } else {
      stable = 0;
      last = len;
    }
    await sleep(intervalMs);
  }
}

function isSearchURL(parsed) {
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (host === 'html.duckduckgo.com' || (host.endsWith('.duckduckgo.com') && path.startsWith('/html'))) {
    return path === '/html' || path.startsWith('/html/');
  }
  if (host.endsWith('google.com') && path === '/search') return true;
  if (isYouTubeSearchHost(host) && path === '/results') return true;
  // Bing / Brave — the search-engine fallback chain (see engines.js).
  if ((host === 'bing.com' || host.endsWith('.bing.com') || host === 'search.brave.com') && path === '/search') {
    return true;
  }
  return false;
}

// YouTube hosts (search + watch + shorts links). youtu.be is watch-only.
function isYouTubeHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be';
}

function isYouTubeSearchHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'youtube.com' || h === 'www.youtube.com' || h === 'm.youtube.com';
}

// Bounded per-host wait: YouTube is a heavy SPA that misses the generic
// 10s goto + 1.5s settle budget. Bounds stay in place so a stalled load
// can never hang the TUI — only the budget is host-aware.
const YT_GOTO_TIMEOUT_MS = 30000;
const YT_SEARCH_WAIT_MS = 20000;
const YT_WATCH_WAIT_MS = 10000;
const YT_SEARCH_READY = 'ytd-video-renderer a#video-title, ytd-rich-item-renderer a#video-title, ytd-compact-video-renderer a#video-title';
const YT_WATCH_READY = 'h1.ytd-watch-metadata, h1.title, #title h1';

// Generic goto budget. The FIRST navigation after a browser launch pays
// cold-start costs (renderer spawn, DNS/TLS warmup, empty cache) and gets
// a wider budget; a commit-only retry turns a slow DOMContentLoaded into a
// degraded load instead of an error. Only a navigation that never commits
// at all is a real failure.
const GOTO_TIMEOUT_MS = 10000;
const GOTO_TIMEOUT_COLD_MS = 20000;
const GOTO_COMMIT_RETRY_MS = 8000;
const GOTO_BODY_WAIT_MS = 5000;

// Playwright's TimeoutError, matched by name OR message so a re-wrapped
// error still classifies.
function isNavTimeout(err) {
  try {
    if (!err) return false;
    if (err.name === 'TimeoutError') return true;
    return /timeout \d+ms exceeded/i.test(String(err.message || ''));
  } catch {
    return false;
  }
}

// Link normalization lives in ./links.js (shared with the search fan-out and
// unit-tested on its own). This module stays driver-only.

class Browser {
  constructor(opts = {}) {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.headless = opts.headless !== false;
    this.profileDir = opts.profileDir || defaultProfileDir();
    // Chrome (system install, shared profile for browsing)
    // or 'firefox' (legacy). Sessions live per-engine: cookies saved under
    // one engine are invisible to the other, so the whole app uses one.
    this.engine = opts.engine || DEFAULT_ENGINE;
    // Links per page target (/links). Drives how hard a search fans out
    // past DuckDuckGo's 10-per-page wall.
    this.pageSize = Number(opts.pageSize) > 0 ? Number(opts.pageSize) : 50;
    // Reader mode is the default for every page; /read raw flips this for
    // one navigation. Reset to true on each navigate.
    this.readMode = true;
    // Blocked-request counter for the footer badge. Reset per navigation.
    this.blocked = 0;
    this.blockedTotal = 0;
    // Set while a search fan-out is in flight (guards double starts).
    this._filling = null;
    // Hard per-navigation deadline (see navigate): a stalled load closes
    // its page instead of holding a tab open. Overridable for tests.
    this.navTimeoutMs = Number(opts.navTimeoutMs) > 0 ? Number(opts.navTimeoutMs) : NAV_TIMEOUT_MS;
    // True until the first navigation after a launch: that one absorbs the
    // cold-start cost with a wider goto budget (see _launch/navigate).
    this._coldNav = true;
    // Script freeze: after extraction the live page's JS is pure cost
    // (timers, hydration, analytics). One CDP session per page, reset when
    // the page is recreated/closed.
    this._cdpSession = null;
    this._cdpPage = null;
    this._frozen = false;
  }

  // How many requests the blocklist has refused (this page / all session).
  blockedCounts() {
    return { page: this.blocked, total: this.blockedTotal };
  }

  // ---- Script freeze (read-time RAM/CPU saver) --------------------------
  // The TUI never paints the live page: text, links, media and the title are
  // extracted right after load. Past that point the page's own JS (timers,
  // hydration, analytics, animations) only burns CPU and keeps the renderer's
  // heap busy while the user reads. Disable script execution until the next
  // navigation. The DOM stays alive, so page.evaluate() still answers — that
  // keeps /search "more results" (fillSearch) and the related-video rail
  // working. Best-effort: Firefox/WebKit (or a closed page) just no-op.
  async _cdp() {
    if (!this.page) return null;
    if (this._cdpSession && this._cdpPage === this.page) return this._cdpSession;
    try {
      const session = await this.context.newCDPSession(this.page);
      this._cdpSession = session;
      this._cdpPage = this.page;
      return session;
    } catch {
      this._cdpSession = null;
      this._cdpPage = null;
      return null;
    }
  }

  async _setScriptsEnabled(enabled) {
    if (!this.page) return false;
    try {
      const session = await this._cdp();
      if (!session) return false;
      await session.send('Emulation.setScriptExecutionDisabled', { value: !enabled });
      this._frozen = !enabled;
      return true;
    } catch {
      return false;
    }
  }

  freezeScripts() {
    return this._setScriptsEnabled(false);
  }

  thawScripts() {
    return this._setScriptsEnabled(true);
  }

  // A throwaway page in the SAME browser: used by the keyless Gemini web
  // app so no second browser process exists. Callers MUST close it (see
  // closeAuxPage) so memory does not creep.
  async newAuxPage() {
    await this.init();
    const page = await this.context.newPage();
    // Same hygiene as the main page: no fonts, no media, no trackers.
    await page.route('**/*', (route) => {
      const req = route.request();
      const url = req.url();
      if (isTrackerUrl(url) || isMediaUrl(url) || req.resourceType() === 'font') {
        this._countBlocked();
        return route.abort().catch(() => {});
      }
      return route.continue().catch(() => {});
    }).catch(() => {});
    return page;
  }

  async closeAuxPage(page) {
    if (!page) return;
    try {
      await page.close();
    } catch {
      /* already gone */
    }
  }

  // Hard tab budget: exactly one page may live in this context.
  // Sites open popups (window.open, ad iframes as windows), and every
  // extra tab is another renderer holding real RAM — a handful of those
  // is enough to freeze a desktop. Anything that is not the main page is
  // closed immediately, no matter who opened it.
  enforcePageBudget() {
    try {
      if (!this.context) return 0;
      const pages = this.context.pages();
      let closed = 0;
      for (const p of pages) {
        if (this.page && p === this.page) continue;
        closed += 1; // counted now; the close itself is fire-and-forget
        Promise.resolve(p.close({ runBeforeUnload: false })).catch(() => { /* already gone */ });
      }
      return closed;
    } catch {
      return 0;
    }
  }

  _countBlocked() {
    this.blocked += 1;
    this.blockedTotal += 1;
  }

  // Cheap honesty check: a cookie store means a session was saved here.
  // It does NOT prove the site still accepts it (see the `blocked` path).
  // Checks both Firefox (cookies.sqlite) and legacy Chromium layouts.
  profileReady() {
    const candidates = [
      'cookies.sqlite',
      'Default/Network/Cookies',
      'Default/Cookies',
    ];
    for (const rel of candidates) {
      try {
        if (fs.statSync(path.join(this.profileDir, rel)).isFile()) return true;
      } catch {
        /* absent */
      }
    }
    return false;
  }

  static wipeProfile(profileDir) {
    fs.rmSync(profileDir || defaultProfileDir(), { recursive: true, force: true });
  }

  // Cookie import: load a Playwright-format cookie file (a JSON array, or
  // { "cookies": [...] } as exported by cookie-editor extensions) into the
  // live browsing profile. Lets users carry a session from their regular
  // browser instead of logging in inside automation. Returns
  // { imported, skipped }; throws plain Errors the caller paints.
  async importCookiesFile(file) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(String(file), 'utf8'));
    } catch {
      throw new Error(`Cannot read cookie file: ${file}`);
    }
    const list = Array.isArray(raw) ? raw : raw && raw.cookies;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('No cookies found (expected a JSON array or { "cookies": [...] }).');
    }
    const valid = [];
    let skipped = 0;
    for (const c of list) {
      try {
        if (!c || typeof c !== 'object' || !c.name || c.value === undefined) {
          skipped++;
          continue;
        }
        if (c.url) {
          valid.push({
            name: String(c.name),
            value: String(c.value),
            url: String(c.url),
          });
        } else if (c.domain) {
          const cookie = {
            name: String(c.name),
            value: String(c.value),
            domain: String(c.domain),
            path: c.path ? String(c.path) : '/',
          };
          if (c.expires && Number(c.expires) > 0) cookie.expires = Number(c.expires);
          if (c.httpOnly !== undefined) cookie.httpOnly = !!c.httpOnly;
          if (c.secure !== undefined) cookie.secure = !!c.secure;
          if (c.sameSite && ['Strict', 'Lax', 'None'].includes(c.sameSite)) {
            cookie.sameSite = c.sameSite;
          }
          valid.push(cookie);
        } else {
          skipped++;
        }
      } catch {
        skipped++;
      }
    }
    if (valid.length === 0) throw new Error(`No usable cookies (${skipped} skipped).`);
    await this.init();
    await this.context.addCookies(valid);
    return { imported: valid.length, skipped };
  }

  async init() {
    // Single-flight: overlapping navigations must not launch two browsers
    // on one profile (the `!this.browser` check in navigate() is not atomic
    // across awaits — the second launch fails on the profile lock, and the
    // stale-lock retry below would then yank locks from the live instance).
    if (this.browser) return;
    if (this._initPromise) {
      await this._initPromise;
      return;
    }
    this._initPromise = this._initInner().finally(() => {
      this._initPromise = null;
    });
    await this._initPromise;
  }

  async _initInner() {
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.profileDir, 0o700);
    } catch {
      /* best effort */
    }
    try {
      await this._launch();
    } catch (err) {
      // A previous crash/kill can leave stale browser lockfiles behind,
      // which make every future launch fail. Remove lockfiles only (never
      // session data) and retry once.
      try {
        for (const f of fs.readdirSync(this.profileDir)) {
          if (f === 'lock' || f === 'parent.lock' || f.endsWith('.lock')) {
            fs.rmSync(path.join(this.profileDir, f), { force: true });
          }
        }
      } catch {
        /* best effort */
      }
      await this._launch();
    }
  }

  async _launch() {
    // `channel: 'chrome'` drives the installed Google Chrome binary — no
    // download, and sites treat it as a supported browser (fewer bot
    // walls). Unknown engines fall back to Chrome.
    const pw = playwright();
    const driver = this.engine === 'firefox' ? pw.firefox : pw.chromium;
    const launchOpts = {
      headless: this.headless,
      javaScriptEnabled: true,
      userAgent:
        this.engine === 'firefox'
          ? 'Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0'
          : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };
    if (this.engine !== 'firefox') {
      // Privacy posture, safe defaults only: WebRTC stays ON but local IPs
      // are never exposed to pages (public interface only — visible calls
      // still work). The referrer stays at Chrome's cross-origin default
      // (strict-origin-when-cross-origin): a hard no-referrer breaks logins
      // and hotlinks, and cookies are already per-session (profile wipe).
      launchOpts.args = ['--webrtc-ip-handling-policy=default_public_interface_only'];
    }
    if (driver === pw.chromium && this.engine !== 'firefox') {
      launchOpts.channel = 'chrome';
    }
    try {
      this.context = await driver.launchPersistentContext(this.profileDir, launchOpts);
    } catch (err) {
      if (this.engine !== 'firefox' && /executable doesn't exist|channel/i.test(String((err && err.message) || err))) {
        throw new Error(
          'Google Chrome is not installed. Install it (or pass { engine: \'firefox\' }) to use the browser.'
        );
      }
      throw err;
    }
    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    this.browser = this.context;
    // A persistent context can hand back a stray about:blank / new-tab page
    // next to the real one. Close extras immediately: two idle tabs are two
    // idle renderers holding RAM for nothing.
    for (const extra of pages.slice(1)) {
      try {
        await extra.close();
      } catch {
        /* best effort */
      }
    }
    
    // Stealth: hide automation fingerprints (navigator.webdriver, etc.)
    // for headed windows, which sites probe for automation.
    if (!this.headless) {
      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // Chrome runtime
        window.chrome = { runtime: {} };
        // Permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);
      });
    }
    
    // Speed package: text + links extract first, pixels on demand. Fonts
    // and media streams are pure latency (blocked); document, script,
    // xhr/fetch (hydration) and stylesheet (innerText honors CSS
    // visibility, so styles stay) pass through. Images pass through too:
    // the gallery fetches them lazily via node, but the DOM needs real
    // src/srcset resolution (lazy-loaders only fill them near-viewport or
    // after load — e.g. Pinterest pinimg URLs). Bytes are never painted
    // by the browser itself.
    await this.context.route('**/*', (route) => {
      const req = route.request();
      const url = req.url();
      const type = req.resourceType();
      // Never download video or audio (user requirement): no mp4/webm/m3u8
      // bytes ever enter RAM. Fonts are latency, not content.
      if (type === 'font' || type === 'media' || isMediaUrl(url)) {
        this._countBlocked();
        return route.abort().catch(() => {});
      }
      // Ads/trackers: pure junk DOM. Blocking them speeds the page up AND
      // makes extraction cleaner (the reader view reads far better).
      if (isTrackerUrl(url)) {
        this._countBlocked();
        return route.abort().catch(() => {});
      }
      route.continue().catch(() => {});
    });
    // The next navigation pays the cold-start cost — give it the wider budget.
    this._coldNav = true;
  }

  async navigate(url, { deferMedia = false } = {}) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      return { text: `Error: invalid URL` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { text: `Error: only http(s) URLs are supported` };
    }

    // init() is single-flight: concurrent navigations share one launch
    // instead of racing two browsers onto one profile.
    await this.init();

    // A previous timeout may have closed the browsing page to free RAM.
    // Recreate it (context-level routing + stealth scripts already apply
    // to every new page), so a recovered navigation works like the first.
    try {
      const closed = this.page && typeof this.page.isClosed === 'function' && this.page.isClosed();
      if (!this.page || closed) {
        this.page = await this.context.newPage();
        // A fresh page starts unfrozen and needs its own CDP session.
        this._cdpSession = null;
        this._cdpPage = null;
        this._frozen = false;
      }
    } catch { /* keep the existing page when recreation fails */ }
    // The previous navigation froze this page once extraction was done;
    // this navigation needs its scripts running (lazy-loaders, hydration).
    if (this._frozen) await this.thawScripts();

    // Per-page counter for the footer badge (fonts/media/trackers refused).
    this.blocked = 0;
    this._navUrl = parsed.toString();
    this._navQuery = '';

    // This navigation OWNS the page captured here. A concurrency guard: if a
    // newer navigation starts (rapid Enters) and later swaps this.page, a
    // stalled older one must NEVER close the newer page. index.js already
    // discards stale results by its own navSeq; this only protects the page.
    const page = this.page;
    const myGen = (this._navGen = (this._navGen || 0) + 1);

    // Entire navigation runs under a hard deadline (NAV_TIMEOUT_MS): a
    // stalled load must never hold a tab open and clog RAM. On timeout THIS
    // navigation's page is closed and a fresh one is created next time.
    const doNavigate = async () => {
      // domcontentloaded only — networkidle would gate us on chatty
      // trackers (up to 15s). Hydration is covered by the settle poll.
      // YouTube gets a larger bounded goto (heavy SPA) plus a
      // wait-for-selector below; both are capped so stalls can't hang us.
      const yt = isYouTubeHost(parsed.hostname);
      const ytSearch = yt && parsed.pathname.toLowerCase() === '/results';
      const ytWatch = yt && (parsed.pathname.toLowerCase() === '/watch' || parsed.hostname.toLowerCase() === 'youtu.be');
      const budget = yt ? YT_GOTO_TIMEOUT_MS : this._coldNav ? GOTO_TIMEOUT_COLD_MS : GOTO_TIMEOUT_MS;
      this._coldNav = false; // the first attempt after a launch absorbs the cold-start cost
      try {
        await page.goto(parsed.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: budget,
        });
      } catch (err) {
        // Cold Chrome (or a chatty page) can miss the DOMContentLoaded
        // deadline while the document itself is fine. Retry once asking
        // only for the commit — if even that never lands, surface the
        // original timeout (the real "can't load it" case).
        if (yt || !isNavTimeout(err)) throw err;
        try {
          await page.goto(parsed.toString(), { waitUntil: 'commit', timeout: GOTO_COMMIT_RETRY_MS });
        } catch {
          throw err;
        }
        await page
          .waitForFunction(
            () => !!(document && document.body && String(document.body.innerText || '').trim()),
            { timeout: GOTO_BODY_WAIT_MS }
          )
          .catch(() => {});
      }
      // A newer navigation has taken over: bail without touching its page
      // (index.js discards this stale result anyway).
      if (this._navGen !== myGen) return { text: '' };
      // Search pages are server-rendered: extract immediately, zero settle.
      // YouTube search instead waits for its video renderers (bounded).
      if (ytSearch) {
        await page.waitForSelector(YT_SEARCH_READY, { timeout: YT_SEARCH_WAIT_MS }).catch(() => {});
      } else if (ytWatch) {
        await page.waitForSelector(YT_WATCH_READY, { timeout: YT_WATCH_WAIT_MS }).catch(() => {});
        await settlePage(page);
      } else if (!isSearchURL(parsed)) {
        await settlePage(this.page);
        // Image-heavy SPAs (Pinterest et al.) hydrate pictures lazily:
        // give their CDN hosts one bounded wait so <img src> attributes
        // exist before extraction. Never throws, never hangs the TUI.
        try {
          const host = parsed.hostname.toLowerCase();
          if (host.includes('pinterest.') || host.includes('pinimg.')) {
            await this.page.waitForSelector('img[src*="pinimg"], meta[property="og:image"]', { timeout: 8000 }).catch(() => {});
            await settlePage(this.page, { stableRounds: 1, intervalMs: 250, maxMs: 1000 });
          }
        } catch {
          /* best effort */
        }
      }

      // Popup guard, before anything is extracted: a page that opened ten
      // windows must not cost ten renderers' worth of RAM. One tab only.
      this.enforcePageBudget();

      // Bot-wall / JS-check pages (e.g. Google's "enable JavaScript" wall).
      // JS is enabled; these pages fingerprint headless automation, so we
      // report them honestly instead of dumping their text.
      const blockedKind = await this.page.evaluate(() => {
        if (!document || !document.body) return null;
        if (location.hostname === 'consent.google.com') return 'consent-google';
        if (location.hostname === 'consent.youtube.com') return 'consent-youtube';
        if (/\/sorry\//.test(location.href)) return 'sorry';
        const text = (document.body.innerText || '').toLowerCase();
        const indicators = [
          'enable javascript',
          'unusual traffic',
          'verify you are a human',
        ];
        return indicators.some((ind) => text.includes(ind)) ? 'js-wall' : null;
      });

      // Search-engine bot walls: DDG/Bing/Brave answer automated traffic
      // with a challenge page instead of results. One probe catches both the
      // generic bot-wall kinds and the engine-specific challenge wording;
      // reported as `searchChallenge` so index.js falls back to the next
      // engine (see engines.js) instead of dumping the wall at the user.
      if (isSearchURL(parsed)) {
        const probe = await this.page
          .evaluate(() => (document && document.body ? (document.body.innerText || '').slice(0, 4000) : ''))
          .catch(() => '');
        if (blockedKind || looksLikeChallenge(probe)) {
          return {
            searchChallenge: {
              url: parsed.toString(),
              host: parsed.hostname,
              text: String(probe || blockedKind || '').slice(0, 300),
            },
          };
        }
      }

      if (blockedKind) {
        return {
          blocked:
            blockedKind === 'consent-youtube'
              ? 'YouTube asks for consent in this automated browser. Open the URL in your regular browser, or try again — consent sometimes clears after one visit.'
              : blockedKind === 'consent-google'
                ? 'Google asks for consent in this automated browser. Open the URL in your regular browser, or search from here (DuckDuckGo).'
                : 'This page needs a real (non-headless) browser — it shows a JavaScript/bot check here. Open the URL in your regular browser, or search from here (DuckDuckGo).',
        };
      }

      // Check for CAPTCHA
      const hasCaptcha = await this.page.evaluate(() => {
        if (!document || !document.body) return false;
        const text = document.body.innerText || '';
        const captchaIndicators = ['captcha', 'recaptcha', 'please verify', 'are you a robot'];
        return captchaIndicators.some((ind) => text.toLowerCase().includes(ind));
      });

      if (hasCaptcha) {
        const message = await this.page.evaluate(() => {
          if (!document || !document.body) return 'CAPTCHA detected';
          const el = document.querySelector('form, iframe') || document.body;
          return el.innerText || 'CAPTCHA detected';
        });
        return { captcha: String(message).trim().slice(0, 2000) };
      }

      // Every page also feeds the link picker: collect all anchors here so
      // "load more" paging never needs another round-trip.
      const links = await this.extractPageLinks();

      // Search-result pages: return a structured title + domain list
      // instead of a raw text dump. Zero hits fall through to the text
      // dump below so selector rot never yields a blank screen.
      if (isSearchURL(parsed)) {
        let results = await this.extractResults();
        if (isYouTubeSearchHost(parsed.hostname) && parsed.pathname.toLowerCase() === '/results') {
          const yt = await this.extractYouTubeResults();
          if (yt.length > 0) results = yt;
        }
        // Every web search also offers its YouTube twin, so video titles
        // are one Enter away without a second query. Only added when the
        // page itself yielded results, so selector rot still falls through
        // to the text dump below instead of hiding behind one synthetic row.
        if (results.length > 0) {
          const q = parsed.searchParams.get('q');
          if (q && q.trim() && !isYouTubeHost(parsed.hostname)) {
            const query = q.trim().slice(0, 80);
            results.unshift({
              title: `Search YouTube for "${query}"`,
              url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
              domain: 'youtube.com',
              thumb: null,
            });
          }
        }
        if (results.length > 0) {
          const ai = await this.extractAiAnswer().catch(() => null);
          let summary = null;
          // The fan-out needs the query text; variations are derived at
          // fill time (DuckDuckGo's HTML has no related-search markup —
          // verified — so autocomplete phrases are the real source).
          const q = parsed.searchParams.get('q') || '';
          this._navQuery = String(q).trim().slice(0, 120);
          try {
            const { summarizeResults } = require('./ai');
            summary = summarizeResults(results) || null;
          } catch { /* summary is best-effort */ }
          return {
            results,
            links: links.length > 0 ? links : results,
            ai: ai || null,
            summary,
            searchQuery: this._navQuery,
            net: this.blockedCounts(),
          };
        }
      }

      // Reader mode by DEFAULT (the whole point of the app): Mozilla's
      // Readability scores the live DOM and returns clean article HTML for
      // GitHub pages, news sites and blogs alike. /read raw skips this and
      // uses the heuristic dump below. Either way: never a blank page.
      let reader = null;
      if (this.readMode !== 'raw') {
        try {
          reader = await extractArticle(this.page);
        } catch {
          reader = null;
        }
      }

      // Main-content extraction (readability, not a raw dump): strip
      // boilerplate + hidden nodes, score candidates reader-style
      // (class/id weight + paragraph text + commas − link density),
      // render the winner. Links are collected separately on the full DOM,
      // so this path can be aggressive. Falls back to a plain dump, never blank.
      const res = await this.page.evaluate(() => {
        if (!document || !document.body) return { text: '', spans: [] };
        const clone = document.body.cloneNode(true);
        const drop = (sel) => {
          try {
            clone.querySelectorAll(sel).forEach((el) => el.remove());
          } catch {
            /* invalid selector on odd pages */
          }
        };
        drop('script, style, noscript, nav, header, footer, aside, dialog');
        drop('form, iframe, canvas, video, audio, select, input, textarea, button');
        drop('[role="navigation"], [role="banner"], [role="complementary"], [role="contentinfo"], [role="dialog"], [role="alertdialog"]');
        drop('[aria-hidden="true"], [hidden]');
        drop('div[style*="display:none"], div[style*="display: none"]');
        // Video-site chrome + recommendation rails: never main content.
        drop('#secondary, #related, ytd-watch-next-secondary-results-renderer, ytd-comments, #comments, ytd-mini-guide-renderer, ytd-guide-renderer, ytd-masthead');
        // Cookie/consent banners, modals, popups, newsletter sludge.
        const JUNK = /cookie|consent|gdpr|banner|modal|popup|popover|overlay|newsletter|subscribe|paywall|toast|drawer|sticky|sidebar|related|sponsor|recommend|trending|shorts/i;
        // ...but NEVER strip the page's own content: modern layouts name
        // their WRAPPERS after widgets (MDN's .layout__2-sidebars-inline
        // wraps the whole article — the old rule left MDN with "(no
        // content)"). A node that still holds <main>/[role=main], or most
        // of the page's text, is layout, not a cookie banner.
        const pageChars = (clone.innerText || '').length;
        clone.querySelectorAll('div, section').forEach((el) => {
          const sig = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
          if (!JUNK.test(sig)) return;
          try {
            if (el.querySelector('main, [role="main"]')) return;
          } catch { /* odd nodes: fall through to the strip */ }
          try {
            const chars = (el.innerText || '').trim().length;
            if (pageChars > 0 && chars > pageChars * 0.6) return;
          } catch { /* odd nodes: fall through to the strip */ }
          el.remove();
        });
        const clean = (root) => {
          // Drop small blocks that are mostly links (nav remnants etc.).
          root.querySelectorAll('p, li').forEach((el) => {
            const t = (el.innerText || '').trim();
            if (!t || t.length > 600) return;
            let linkLen = 0;
            el.querySelectorAll('a').forEach((a) => {
              linkLen += ((a.innerText || '').trim()).length;
            });
            if (t.length < 240 && linkLen > t.length * 0.5) el.remove();
          });
          const lines = (root.innerText || '')
            .split('\n')
            .map((l) => l.trim().replace(/\s+/g, ' '))
            .filter((l) => l.length >= 2);
          // Dedupe repeats (duplicated nav/footer lines).
          const seen = new Set();
          return lines
            .filter((l) => {
              if (seen.has(l)) return false;
              seen.add(l);
              return true;
            })
            .join('\n')
            .trim();
        };
        // Link-aware spans for underlined rendering: recursive walk of the
        // same cleaned tree, tracking the enclosing anchor. Images become
        // `[alt]` spans (linked when nested in an anchor).
        const collectSpans = (root) => {
          const spans = [];
          const MAX_SPANS = 3000;
          const abs = (href) => {
            try {
              const u = new URL(href, location.href);
              // mailto: survives so contact links stay clickable (system
              // mail client via onLinkPick); tel: stays dropped as before.
              if (u.protocol === 'mailto:') return u.toString();
              return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
            } catch {
              return null;
            }
          };
          const walk = (node, link) => {
            if (spans.length >= MAX_SPANS) return;
            if (node.nodeType === 3) {
              const t = node.nodeValue || '';
              if (t.trim()) spans.push({ t, url: link });
            } else if (node.nodeType === 1) {
              if (node.tagName === 'IMG') {
                const alt = node.getAttribute('alt');
                if (alt && alt.trim()) spans.push({ t: `[${alt.trim()}]`, url: link });
                return;
              }
              const href = node.tagName === 'A' ? node.getAttribute('href') : null;
              const next = href ? abs(href) : link;
              for (let c = node.firstChild; c; c = c.nextSibling) walk(c, next);
            }
          };
          walk(root, null);
          const seen = new Set();
          const out = [];
          let chars = 0;
          for (const s of spans) {
            for (const raw of s.t.split('\n')) {
              const line = raw.trim().replace(/\s+/g, ' ');
              if (line.length < 2 || seen.has(line)) continue;
              seen.add(line);
              out.push({ t: line, url: s.url });
              chars += line.length;
              if (chars > 20000 || out.length >= MAX_SPANS) return out;
            }
          }
          return out;
        };
        // Reader-style candidate scoring (cf. mrusme/reader's go-readability
        // core): weigh subtrees by class/id signals, paragraph text, commas,
        // and link density — then render the winner. A bare main/article
        // with no real paragraphs never wins on tags alone.
        const scoreRoot = () => {
          const GOOD = /article|content|post|main|entry|story|blog|text/i;
          const BAD = /comment|sidebar|footer|nav|menu|ad|banner|widget|popup|modal|share|related|sponsor/i;
          const weight = (el) => {
            let w = 0;
            try {
              const sig = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
              if (GOOD.test(sig)) w += 25;
              if (BAD.test(sig)) w -= 25;
            } catch {
              /* odd nodes */
            }
            return w;
          };
          const linkDensity = (el) => {
            const t = (el.innerText || '').trim().length;
            if (!t) return 1;
            let linkLen = 0;
            try {
              el.querySelectorAll('a').forEach((a) => {
                linkLen += ((a.innerText || '').trim()).length;
              });
            } catch {
              /* odd nodes */
            }
            return linkLen / t;
          };
          let best = null;
          let bestScore = 0;
          clone.querySelectorAll('main, article, [role="main"], div, section').forEach((c) => {
            let text = '';
            try {
              c.querySelectorAll('p').forEach((p) => {
                text += ` ${(p.innerText || '').trim()}`;
              });
            } catch {
              /* odd nodes */
            }
            text = text.trim();
            // Front pages put headlines in links/headings, not <p>: when the
            // paragraph text is too thin, fall back to the subtree's whole
            // text so a <main> full of headlines can still win. Without this,
            // BBC News handed back one teaser instead of the front page.
            if (text.length < 80) text = String(c.innerText || '').trim();
            if (text.length < 80) return; // needs real content
            const commas = (text.match(/,/g) || []).length;
            const score =
              weight(c) + Math.min(text.length / 100, 30) + Math.min(commas * 2, 10) - linkDensity(c) * 40;
            if (score > bestScore) {
              bestScore = score;
              best = c;
            }
          });
          // A <main>/[role=main] is the content region by definition. The
          // scorer can still hand back one teaser inside it (BBC News: a
          // link-dense front page has almost no <p> text), so a real main
          // that is much bigger than the winner takes over.
          try {
            const mainEl = clone.querySelector('main, [role="main"]');
            if (mainEl) {
              const mainLen = String(mainEl.innerText || '').trim().length;
              const bestLen = best ? String(best.innerText || '').trim().length : 0;
              if (mainLen > 200 && mainLen > bestLen * 1.4) return mainEl;
            }
          } catch {
            /* odd nodes */
          }
          return bestScore > 0 && best ? best : null;
        };
        let root = scoreRoot() || clone;
        let out = clean(root);
        if (out.length < 200) {
          out = clean(clone); // fallback: whole body
          root = clone;
        }
        // Cleaned HTML for the pretty renderer (pretty.js): anchors
        // absolutized so `label [url]` markers stay clickable, images swapped
        // for their [alt] text (the gallery covers real pictures). Clone-only,
        // the live page and media extraction are untouched.
        let html = '';
        try {
          // NOTE: attribute selector written as tag + hasAttribute check
          // (keeps the mocked page in tests/test-round2.js routing here).
          root.querySelectorAll('a').forEach((a) => {
            try { if (a.hasAttribute('href')) a.href = a.href; } catch { /* keep original */ }
          });
          root.querySelectorAll('img').forEach((img) => {
            try {
              const alt = img.getAttribute('alt') || '';
              img.replaceWith(document.createTextNode(alt && alt.trim() ? `[${alt.trim()}]` : ''));
            } catch { /* keep */ }
          });
          html = (root.innerHTML || '').slice(0, 200000);
        } catch { html = ''; }
        return { text: out, spans: collectSpans(root), html };
      });

      const rawText = res && typeof res.text === 'string' ? res.text : '';
      // Hard output bounds: minified/single-line pages (or a hostile page
      // stuffing evaluate results) can otherwise hand blessed megabyte
      // lines (UI crawl). Text, span count/text/URLs are all capped.
      const text = rawText.slice(0, 100000);
      const spans = (res && Array.isArray(res.spans) ? res.spans : []).slice(0, 2000).map((s) => ({
        t: String((s && s.t) || '').slice(0, 300),
        url: typeof (s && s.url) === 'string' ? s.url.slice(0, 300) : null,
      })).filter((s) => s.t);
      // Page media (reader-style: content + embedded images together).
      // Lazy-loaders only fill src near the viewport, so scroll through
      // once (bounded) before collecting. Never throws — [] on failure.
      const media = await this.extractPageMedia();
      const ai = await this.extractAiAnswer().catch(() => null);
      // Local extractive summary of the article text (computed here, no
      // extra round-trip). The UI shows it on demand via /ai; search pages
      // get their own digest above. Best-effort: null when too short.
      let summary = null;
      try {
        const { summarize } = require('./ai');
        summary = summarize(text) || null;
      } catch { /* summary is best-effort */ }
      // Pretty article rendering via pretty.js (own renderer): bordered
      // tables, quote bars, code blocks, visible link URLs. Best-effort —
      // null keeps the current spans/text paint. Never throws.
      let pretty = null;
      let readerMeta = null;
      // Reader mode wins: its HTML is far cleaner than the heuristic dump,
      // and it renders through the very same pretty.js pipeline.
      if (reader && reader.content && reader.content.trim().length > 50) {
        try {
          const { renderPretty } = require('./pretty');
          pretty = await renderPretty(reader.content).catch(() => null);
          if (pretty) {
            readerMeta = {
              title: reader.title || '',
              byline: reader.byline || '',
              site: reader.siteName || '',
              readingTime: reader.readingTime || 0,
            };
            // The article text is the readable text, not the raw dump.
            text = reader.textContent && reader.textContent.length > text.length ? reader.textContent : text;
          }
        } catch { pretty = null; }
      }
      if (!pretty) {
        try {
          const rawHtml = res && typeof res.html === 'string' ? res.html : '';
          if (rawHtml && rawHtml.trim().length > 50) {
            const { renderPretty } = require('./pretty');
            pretty = await renderPretty(rawHtml).catch(() => null);
          }
        } catch { pretty = null; }
      }
      // Hero art: og:image / twitter:image / biggest in-article image.
      // Never blocks the text; the UI draws it above the title when it can.
      let hero = [];
      if (readerMeta) {
        try {
          const meta = await this.extractPageMeta().catch(() => ({}));
          const imgs = media && Array.isArray(media.images) ? media.images : [];
          hero = heroFrom(meta, imgs);
          // A page whose only art is decorative still gets its image in
          // /gallery, just never above the title.
          if (!hero.length && media && Array.isArray(media.images) && !media.images.length) {
            const extras = heroCandidates(meta, imgs);
            if (extras.length) media.images = extras.map((src) => ({ src, alt: '' }));
          }
        } catch { hero = []; }
      }
      // YouTube watch: beautified header (title + channel + meta + desc)
      // prepended so the view is titles-first, never sidebar soup. Related
      // rail videos ride on media for the 60/40 theater split in the UI.
      if (ytWatch) {
        const w = await this.extractYouTubeWatch().catch(() => null);
        const related = await this.extractRelatedVideos().catch(() => []);
        try {
          if (Array.isArray(related) && related.length > 0) {
            media.related = related;
            media.watch = true;
          }
        } catch { /* split is best-effort */ }
        if (w && w.title) {
          const head = [w.title, w.channel ? `by ${w.channel}` : '', w.meta || '', '', (w.desc || '').slice(0, 1200)]
            .filter((l, i) => (i < 3 ? l : true))
            .join('\n')
            .trim();
          const full = head ? `${head}\n\n${(text && text.trim()) || ''}`.trim() : (text && text.trim()) || '(no content)';
          return { text: full || '(no content)', links, spans, media, ai: ai || null, summary, pretty, net: this.blockedCounts() };
        }
      }
      return {
        text: (text && text.trim()) || '(no content)',
        links,
        spans,
        media,
        ai: ai || null,
        summary,
        pretty,
        reader: readerMeta,
        hero,
        net: this.blockedCounts(),
      };
    };

    const work = doNavigate();
    // A late rejection after the timeout must never surface as unhandled.
    work.catch(() => {});
    let timer = null;
    let result = null;
    try {
      result = await Promise.race([
        work,
        new Promise((_, reject) => {
          const secs = Math.max(1, Math.round(this.navTimeoutMs / 1000));
          timer = setTimeout(
            () => reject(new Error(`Navigation timed out after ${secs}s — tab closed to free RAM`)),
            this.navTimeoutMs
          );
          if (timer && typeof timer.unref === 'function') {
            try { timer.unref(); } catch { /* keep ticking */ }
          }
        }),
      ]);
    } catch (err) {
      // Timeout or failure. Close THIS navigation's page so a stalled tab
      // can never clog RAM — but only while it is still ours: if a newer
      // navigation already owns the slot, leave its page alone. The next
      // navigation recreates the page it needs (guard above init()).
      if (this._navGen === myGen && this.page === page) {
        try {
          if (page && typeof page.close === 'function') await page.close();
        } catch { /* already gone */ }
        this.page = null;
      }
      // navError marks a failed LOAD (not a page whose text happens to
      // start with "Error:"): index.js routes it through the offline/slow
      // classifier — honest error + the arcade as consolation — instead of
      // painting raw error text as if it were page content.
      return { text: `Error: ${errText(err, 'navigation failed')}`, navError: true };
    } finally {
      if (timer) {
        try { clearTimeout(timer); } catch { /* best effort */ }
      }
    }
    // Record the page's own title so /history can show titles, not raw URLs.
    try {
      if (result && typeof result === 'object') {
        let t = '';
        try { t = String(await this.page.evaluate(() => (document && document.title) || '')).slice(0, 200); } catch { /* best effort */ }
        result.title = t;
      }
    } catch { /* title is best-effort */ }
    // Extraction and the title are done: the live page's JS has no further
    // value (see freezeScripts). Only while this navigation still owns the
    // page — a newer navigation must never be frozen by a stale handler.
    if (result && typeof result === 'object' && !result.navError
        && this._navGen === myGen && this.page === page) {
      await this.freezeScripts();
    }
    return result;
  }

  // og:image / twitter:image / description / site name, for the article
  // header (hero art + meta line). Never throws: {} on any failure.
  async extractPageMeta() {
    try {
      const meta = await this.page.evaluate(() => {
        const get = (sel, attr = 'content') => {
          const el = document.querySelector(sel);
          return el ? String(el.getAttribute(attr) || '') : '';
        };
        return {
          'og:image': get('meta[property="og:image"]'),
          'twitter:image': get('meta[name="twitter:image"], meta[property="twitter:image"]'),
          'og:site_name': get('meta[property="og:site_name"]'),
          'og:title': get('meta[property="og:title"]'),
          description: get('meta[name="description"]'),
        };
      });
      return meta && typeof meta === 'object' ? meta : {};
    } catch {
      return {};
    }
  }

  // Fill a search list up to `want` rows. DuckDuckGo HTML serves 10 per
  // page and only via POST, so this walks page 2, 3, … and then related
  // query variations — all through plain fetch, no extra browser page, so
  // the fan-out costs network time only. Never throws.
  //
  // @param {string} query
  // @param {{have:number, want:number, seen:Set, related?:string[]}} opts
  // @returns {Promise<{rows:Array, done:boolean}>}
  async fillSearch(query, { have = 0, want = this.pageSize, seen = new Set(), related = null } = {}) {
    const q = String(query || '').trim();
    if (!q) return { rows: [], done: true };
    try {
      const rels = Array.isArray(related) ? related : null;
      return await fillResults(q, { have, want, seen, related: rels });
    } catch {
      return { rows: [], done: false };
    }
  }

  // Titles-only extraction for search pages. Page-side selectors grab
  // title + href; cleanLinks() unwraps redirects and derives the domain.
  // Never throws: failures yield [] and the caller falls back to text.
  async extractResults() {
    let raw;
    try {
      raw = await this.page.evaluate(() => {
        const out = [];
        const snippetNear = (anchor) => {
          // Result-row snippet next to the title anchor (DDG .result__snippet,
          // Google .VwiC3b / [data-sncf] variants). Same-row only, so text
          // never leaks across results.
          try {
            let node = anchor.parentElement;
            for (let i = 0; i < 4 && node; i++) {
              const s = node.querySelector('.result__snippet, .VwiC3b, div[data-sncf="1"], .s3v9rd');
              if (s && s.innerText && s.innerText.trim().length > 20) return s.innerText.trim().slice(0, 400);
              node = node.parentElement;
            }
          } catch { /* no snippet */ }
          return '';
        };
        // DuckDuckGo HTML: .result__a anchors (direct links).
        document.querySelectorAll('.result__a').forEach((a) => {
          if (out.length < 200 && a.innerText && a.getAttribute('href')) {
            out.push({ title: a.innerText.trim(), href: a.getAttribute('href'), snippet: snippetNear(a) });
          }
        });
        // Google: result blocks with h3 + link.
        if (out.length === 0) {
          document.querySelectorAll('div.g').forEach((g) => {
            if (out.length >= 200) return;
            const h3 = g.querySelector('h3');
            const a = g.querySelector('a[href]');
            if (h3 && a && h3.innerText && a.getAttribute('href')) {
              let sn = '';
              try {
                const s = g.querySelector('.VwiC3b, div[data-sncf="1"], .s3v9rd');
                if (s && s.innerText) sn = s.innerText.trim().slice(0, 400);
              } catch { /* no snippet */ }
              out.push({ title: h3.innerText.trim(), href: a.getAttribute('href'), snippet: sn });
            }
          });
        }
        // Bing: li.b_algo rows (h2 a = title + link; cleanLinks unwraps the
        // /ck/a redirector). Fallback engine, see engines.js.
        if (out.length === 0) {
          document.querySelectorAll('li.b_algo').forEach((li) => {
            if (out.length >= 200) return;
            const a = li.querySelector('h2 a');
            if (!a || !a.getAttribute('href')) return;
            const title = (a.innerText || a.textContent || '').trim();
            if (!title) return;
            let sn = '';
            try {
              const s = li.querySelector('.b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4, p');
              if (s && s.innerText) sn = s.innerText.trim().slice(0, 400);
            } catch { /* no snippet */ }
            out.push({ title, href: a.getAttribute('href'), snippet: sn });
          });
        }
        // Brave: .snippet rows (a.title = title + link, .description =
        // snippet). Fallback engine, see engines.js.
        if (out.length === 0) {
          document.querySelectorAll('.snippet').forEach((s) => {
            if (out.length >= 200) return;
            const a = s.querySelector('a.title') || s.querySelector('a[href^="http"]');
            if (!a || !a.getAttribute('href')) return;
            const title = (a.innerText || a.textContent || '').trim();
            if (!title) return;
            let sn = '';
            try {
              const d = s.querySelector('.description');
              if (d && d.innerText) sn = d.innerText.trim().slice(0, 400);
            } catch { /* no snippet */ }
            out.push({ title, href: a.getAttribute('href'), snippet: sn });
          });
        }
        return out;
      });
    } catch {
      return [];
    }
    let base = null;
    try {
      base = this.page.url();
    } catch {
      base = null;
    }
    return cleanLinks(raw, 200, base);
  }

  // Google AI Overview / AI answer box. Selectors target the generated-answer
  // card (rotates often — all best-effort). Returns trimmed text or null.
  // Never throws: miss means "no AI card on this page".
  async extractAiAnswer() {
    try {
      const txt = await this.page.evaluate(() => {
        if (!document || !document.body) return null;
        const cands = [];
        try {
          document.querySelectorAll('div[data-attrid*="ai" i], div[data-hveid] div[lang], [aria-label*="AI Overview" i]').forEach((el) => {
            const t = (el.innerText || '').trim();
            if (t && t.length > 40) cands.push(t);
          });
        } catch { /* selector miss */ }
        try {
          const heads = document.querySelectorAll('h1, h2, h3');
          for (const h of heads) {
            const label = ((h.innerText || h.textContent) || '').trim().toLowerCase();
            if (label === 'ai overview' || label.indexOf('ai overview') === 0) {
              let node = h.parentElement;
              for (let i = 0; i < 3 && node; i++) {
                const t = ((node.innerText || '').trim());
                if (t && t.length > 80) { cands.push(t); break; }
                node = node.parentElement;
              }
            }
          }
        } catch { /* walk miss */ }
        if (!cands.length) return null;
        cands.sort((a, b) => b.length - a.length);
        return String(cands[0]).trim().slice(0, 3000);
      });
      const s = String(txt || '').trim();
      return s.length > 40 ? s : null;
    } catch {
      return null;
    }
  }

  // Clean YouTube watch header: title + channel + view/date line +
  // description. Gives a beautified watch view instead of sidebar soup.
  // Returns null when the page is not a watch page or selectors miss.
  async extractYouTubeWatch() {
    try {
      const info = await this.page.evaluate(() => {
        if (!document || !document.body) return null;
        const pick = (sel) => {
          try {
            const el = document.querySelector(sel);
            const t = ((el && (el.innerText || el.textContent)) || '').trim();
            return t ? t.slice(0, 300) : '';
          } catch { return ''; }
        };
        let title = '';
        try {
          const meta = document.querySelector('meta[property="og:title"]');
          title = (meta && meta.getAttribute('content')) || '';
        } catch { /* keep blank */ }
        if (!title) title = pick('h1.ytd-watch-metadata, h1.title, #title h1');
        if (!title) {
          try { title = String(document.title || '').replace(/\s*-\s*YouTube\s*$/, '').trim(); } catch { /* blank */ }
        }
        if (!title) return null;
        const channel = pick('ytd-channel-name a, #channel-name a, ytd-video-owner-renderer a');
        const meta2 = pick('#info #info-text, ytd-watch-info-text #info-text');
        let desc = pick('ytd-expander#description, #description-inline-expander');
        try {
          const md = document.querySelector('meta[name="description"]');
          const c = md && md.getAttribute('content');
          if (c && c.trim() && !desc) desc = c.trim().slice(0, 1500);
        } catch { /* keep */ }
        return { title: String(title).slice(0, 200), channel, meta: meta2, desc: String(desc || '').slice(0, 1500) };
      });
      if (!info || !info.title) return null;
      return info;
    } catch {
      return null;
    }
  }

  // Related-videos rail for the YT theater split (watch info left 60%,
  // related list right 40%). Rail-only selectors so sidebar soup never
  // leaks into the article text path. Never throws: [] hides the split.
  async extractRelatedVideos() {
    const empty = [];
    if (!this.page) return empty;
    let raw;
    try {
      raw = await this.page.evaluate(() => {
        const out = [];
        document.querySelectorAll(
          'ytd-compact-video-renderer a#video-title, ytd-compact-video-renderer a#thumbnail, a[href*="/shorts/"]'
        ).forEach((a) => {
          if (out.length >= 60) return;
          const href = a.getAttribute && a.getAttribute('href');
          if (!href) return;
          // Rail videos only: watch/shorts/embed hrefs. Same-rail guard so
          // channel (/@handle, /channel/, /c/, /user/), playlist, hashtag
          // and avatar links never leak across into the pane.
          if (!/^\/(watch|shorts|embed)[?/]/.test(href)) return;
          let title = '';
          try {
            title = (a.getAttribute('title') || a.textContent || '').trim().replace(/\s+/g, ' ');
          } catch { /* blank */ }
          if (!title) return;
          out.push({ title: title.slice(0, 120), href });
        });
        return out;
      });
    } catch {
      return empty;
    }
    let base = null;
    try {
      base = this.page.url();
    } catch {
      base = null;
    }
    const rows = cleanLinks(raw, 25, base);
    // Drop the video currently playing (same videoId as this watch page).
    let selfId = '';
    try {
      const u = new URL(String(base || ''), 'https://www.youtube.com');
      selfId = u.searchParams.get('v') || '';
      if (!selfId && u.hostname.toLowerCase() === 'youtu.be') {
        selfId = u.pathname.split('/').filter(Boolean)[0] || '';
      }
    } catch { /* keep blank */ }
    const out = [];
    const seen = new Set();
    for (const r of rows) {
      try {
        const u = new URL(r.url);
        const h = u.hostname.toLowerCase();
        const isWatch = /^\/(watch|shorts|embed)(\?|\/|$)/.test(u.pathname);
        const isShortLink = h === 'youtu.be' && /^[A-Za-z0-9_-]{6,20}$/.test(u.pathname.split('/').filter(Boolean)[0] || '');
        // Belt-and-braces behind the in-page same-rail filter: channel,
        // playlist, hashtag and title-less rows never reach the pane.
        if (!isWatch && !isShortLink) continue;
        if (!String(r.title || '').trim()) continue;
        const id = u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop() || '';
        if (selfId && id === selfId) continue; // not the playing video
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        out.push(r);
      } catch {
        continue;
      }
    }
    return out.slice(0, 20);
  }

  // YouTube search listing: video titles + /watch links + thumbnail URLs.
  // Selectors target the title anchor (stable across layout variants);
  // the thumbnail is the largest i.ytimg.com img in the same renderer.
  // Never throws: failures yield [] and the caller falls back to text.
  async extractYouTubeResults() {
    let raw;
    try {
      // One bounded scroll pass to trigger lazy-loaded thumbnails; the
      // titles are server-rendered, but imgs only load near the viewport.
      try {
        for (let i = 0; i < 3; i++) {
          await this.page.evaluate(() => window.scrollBy(0, window.innerHeight));
          await this.page.waitForTimeout(400);
        }
        await this.page.evaluate(() => window.scrollTo(0, 0));
        await this.page.waitForTimeout(400);
      } catch {
        /* best effort — titles still extract without it */
      }
      raw = await this.page.evaluate(() => {
        const out = [];
        const rows = document.querySelectorAll(
          'ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer'
        );
        rows.forEach((row) => {
          if (out.length >= 200) return;
          const a = row.querySelector('a#video-title, a#thumbnail[href*="/watch"], a[href*="/shorts/"]');
          if (!a) return;
          const href = a.getAttribute('href');
          if (!href) return;
          const titleEl = row.querySelector('a#video-title') || a;
          const title = (titleEl.getAttribute('title') || titleEl.textContent || '').trim();
          if (!title) return;
          let thumb = null;
          const img = row.querySelector('img[src*="ytimg.com"], img[src*="ggpht.com"]');
          if (img) {
            thumb =
              img.getAttribute('src') ||
              (img.getAttribute('srcset') || '').split(',').pop().trim().split(' ')[0] ||
              null;
            if (thumb && !/^https?:\/\//i.test(thumb)) thumb = null;
          }
          out.push({ title, href, thumb });
        });
        return out;
      });
    } catch {
      return [];
    }
    let base = null;
    try {
      base = this.page.url();
    } catch {
      base = null;
    }
    const cleaned = cleanLinks(
      (raw || []).map((r) => ({ title: r.title, href: r.href })),
      200,
      base
    );
    // Reattach thumbnails by matching cleaned URLs back to raw hrefs.
    const thumbs = new Map();
    for (const r of raw || []) {
      if (!r.thumb) continue;
      try {
        thumbs.set(new URL(r.href, base || 'https://www.youtube.com').toString(), r.thumb);
      } catch {
        /* skip unresolvable href */
      }
    }
    return cleaned.map((c) => ({ ...c, thumb: thumbs.get(c.url) || null }));
  }

  // All-link feed for the picker (every page, uncapped up to the backstop).
  // textContent (not innerText) avoids a layout pass per anchor on huge pages.
  async extractPageLinks() {
    let raw;
    try {
      raw = await this.page.evaluate(() => {
        const out = [];
        document.querySelectorAll('a[href]').forEach((a) => {
          if (out.length >= 400) return;
          const href = a.getAttribute('href');
          if (!href) return;
          out.push({ title: (a.textContent || '').trim().slice(0, 120), href });
        });
        return out;
      });
    } catch {
      return [];
    }
    let base = null;
    try {
      base = this.page.url();
    } catch {
      base = null;
    }
    return cleanLinks(raw, 200, base);
  }

  // Page media: absolute, deduped { images: [{ src, alt }], videos:
  // [{ src, poster, title }] }. Collects og:image/og:video first (present
  // even behind login walls — e.g. a Pinterest pin's own image), then
  // in-content <img> (src, data-src, best srcset entry), <video>/<source>
  // URLs + posters, YouTube embeds, and direct mp4/webm/mov links.
  // 1x1 tracking pixels, sprites/icons (<60px when measurable), data:
  // URIs and javascript: are dropped. Capped (30/10). Never throws.
  async extractPageMedia() {
    const empty = { images: [], videos: [] };
    if (!this.page) return empty;
    // One bounded scroll pass to trigger lazy-loaded pictures.
    try {
      for (let i = 0; i < 4; i++) {
        await this.page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await this.page.waitForTimeout(300);
      }
      await this.page.evaluate(() => window.scrollTo(0, 0));
    } catch {
      /* best effort — meta + eager imgs still extract */
    }
    let raw;
    try {
      raw = await this.page.evaluate(() => {
        const pickSrcset = (s) => {
          try {
            const parts = String(s || '').split(',').map((p) => p.trim()).filter(Boolean);
            if (!parts.length) return null;
            let best = null;
            let bestW = -1;
            for (const p of parts) {
              const m = p.match(/^(\S+)\s+(\d+)w$/);
              if (m) {
                if (Number(m[2]) > bestW) { bestW = Number(m[2]); best = m[1]; }
              } else if (!best) {
                best = p.split(/\s+/)[0];
              }
            }
            return best;
          } catch { return null; }
        };
        const meta = (sel, attr) => {
          try {
            const el = document.querySelector(sel);
            const v = el && el.getAttribute(attr);
            return v ? String(v).trim() : null;
          } catch { return null; }
        };
        const imgs = [];
        const vids = [];
        const ogImage = meta('meta[property="og:image"]', 'content');
        if (ogImage) imgs.push({ src: ogImage, alt: meta('meta[property="og:title"]', 'content') || '' });
        const ogVideo = meta('meta[property="og:video"]', 'content') || meta('meta[property="og:video:url"]', 'content');
        if (ogVideo) vids.push({ src: ogVideo, poster: ogImage, title: meta('meta[property="og:title"]', 'content') || '' });
        document.querySelectorAll('img').forEach((img) => {
          if (imgs.length >= 60) return;
          const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || pickSrcset(img.getAttribute('srcset')) || pickSrcset(img.getAttribute('data-srcset'));
          if (!src) return;
          let w = 0;
          let h = 0;
          try {
            const r = img.getBoundingClientRect ? img.getBoundingClientRect() : null;
            if (r) { w = r.width || 0; h = r.height || 0; }
            w = w || Number(img.getAttribute('width')) || Number(img.naturalWidth) || 0;
            h = h || Number(img.getAttribute('height')) || Number(img.naturalHeight) || 0;
          } catch { /* unmeasurable — keep */ }
          if (w > 0 && h > 0 && (w < 60 || h < 60)) return; // icon/sprite
          const alt = (img.getAttribute('alt') || '').trim().slice(0, 120);
          // Intrinsic/rendered dimensions ride along: /gallery lays photos
          // out by aspect ratio, so a landscape shot gets a wider cell and
          // a portrait one a narrow cell without fetching every image first.
          imgs.push({ src: String(src).trim(), alt, w, h });
        });
        document.querySelectorAll('picture source').forEach((s) => {
          if (imgs.length >= 60) return;
          const src = pickSrcset(s.getAttribute('srcset')) || s.getAttribute('src');
          if (src) imgs.push({ src: String(src).trim(), alt: '' });
        });
        document.querySelectorAll('video').forEach((v) => {
          if (vids.length >= 20) return;
          const vSrc = v.getAttribute('src');
          const vSrcEl = vSrc ? null : v.querySelector('source[src]');
          const s = vSrc || (vSrcEl ? vSrcEl.getAttribute('src') : null);
          if (s) vids.push({ src: String(s).trim(), poster: v.getAttribute('poster'), title: v.getAttribute('title') || v.getAttribute('aria-label') || '' });
        });
        document.querySelectorAll('iframe[src*="youtube.com/embed"], iframe[src*="youtube-nocookie.com/embed"]').forEach((f) => {
          if (vids.length >= 20) return;
          const src = f.getAttribute('src');
          if (src) vids.push({ src: String(src).trim(), poster: null, title: f.getAttribute('title') || 'Embedded video' });
        });
        document.querySelectorAll('a[href]').forEach((a) => {
          if (vids.length >= 20) return;
          const href = a.getAttribute('href');
          if (href && /\.(mp4|webm|mov)(\?|#|$)/i.test(href)) {
            vids.push({ src: href, poster: null, title: (a.textContent || '').trim().slice(0, 120) });
          }
        });
        return { imgs, vids };
      });
    } catch {
      return empty;
    }
    let base = null;
    try { base = this.page.url(); } catch { base = null; }
    const absHttp = (u) => {
      try {
        const full = new URL(String(u || '').trim(), base || 'https://www.google.com').toString();
        const p = new URL(full);
        if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
        return p.toString();
      } catch { return null; }
    };
    const images = [];
    const seenImg = new Set();
    for (const r of (raw && raw.imgs) || []) {
      const src = absHttp(r && r.src);
      if (!src || seenImg.has(src)) continue;
      seenImg.add(src);
      // Keep the rendered dimensions: /gallery sizes cells by aspect ratio
      // without downloading every photo just to measure it.
      const w = Number(r && r.w) || 0;
      const h = Number(r && r.h) || 0;
      images.push({ src, alt: String((r && r.alt) || '').slice(0, 120), w, h });
      if (images.length >= 30) break;
    }
    const videos = [];
    const seenVid = new Set();
    for (const r of (raw && raw.vids) || []) {
      const src = absHttp(r && r.src);
      if (!src || seenVid.has(src)) continue;
      seenVid.add(src);
      videos.push({ src, poster: absHttp(r && r.poster), title: String((r && r.title) || '').slice(0, 120) });
      if (videos.length >= 10) break;
    }
    return { images, videos };
  }

  // Plain open without extraction: programmatic navigation helper.
  async open(url) {
    await this.init();
    // A page frozen after the last extraction needs its scripts back.
    if (this._frozen) await this.thawScripts();
    await this.page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  onDisconnect(fn) {
    if (this.context) this.context.on('close', fn);
  }

  // Relaunch with a different headless setting (e.g. headless app to
  // headed window). close() nulls the
  // context/page, so we can safely flip the flag and re-init.
  async relaunch(opts = {}) {
    if (opts.headless !== undefined) this.headless = opts.headless;
    await this.close();
    await this.init();
  }

  async close() {
    try {
      if (this.context) {
        await this.context.close();
      }
    } catch {
      // ignore teardown errors
    } finally {
      this.browser = null;
      this.context = null;
      this.page = null;
      this._cdpSession = null;
      this._cdpPage = null;
      this._frozen = false;
    }
  }
}

module.exports = { Browser, defaultProfileDir, errText };
