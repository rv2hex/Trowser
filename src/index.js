#!/usr/bin/env node
'use strict';

const blessed = require('blessed');
const { createUI } = require('./ui');
const { Navigator } = require('./navigation');
const { handleAuthArgs } = require('./auth');
const { getLocalSuggestions, getSuggestions, getCommandSuggestions } = require('./suggest');
const { routeCommand } = require('./commands');
const { loadConfig, saveConfig } = require('./config');
const engines = require('./engines');
const { petFor, moodForEvent, primePets } = require('./pets');

// ./browser is required lazily everywhere on the boot path: it pulls in
// playwright (~300 ms) plus readability/blocklist, and none of that is
// needed until the first navigation actually asks for a page. errText
// stays callable from anywhere because error paths want it immediately —
// it delegates to browser.js on first use.
function browserLib() {
  return require('./browser');
}
function errText(err, fallback) {
  return browserLib().errText(err, fallback);
}

// Video handoff: the terminal lists titles and thumbnails but cannot play
// streams, so Enter opens the URL in mpv fullscreen at the configured
// quality. Detached and unref'd — the TUI keeps running. Videos NEVER
// auto-open a full browser (explicit user complaint): mpv failure paints
// an actionable TUI error + player.log entry instead. Use /open explicitly
// if you really want the browser. Returns {ok, method, error, args}.
// Never throws.
function playerLogFile() {
  try {
    const os = require('os');
    const path = require('path');
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(base, 'tui-browser', 'player.log');
  } catch {
    return null;
  }
}

function logPlayer(line) {
  try {
    const fs = require('fs');
    const path = require('path');
    const f = playerLogFile();
    if (!f) return;
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    // Bounded growth: roll over to a single `.1` file at 2 MB so a long
    // session can never grow player.log without limit (best-effort — a
    // failed rollover still appends rather than losing the line).
    try {
      if (fs.statSync(f).size > 2 * 1024 * 1024) {
        fs.renameSync(f, `${f}.1`);
      }
    } catch { /* first write, or rollover failed: append below */ }
    fs.appendFileSync(f, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* diagnostics never break playback */
  }
}

function playVideo(url, opts = {}) {
  // Captured at call time (not looked up later): the resolve now runs as an
  // async chain, and tests swap these on require('child_process') — every
  // client attempt must keep using the functions the call started with.
  const { execFile, spawn } = require('child_process');
  const {
    normalizeQuality, ytdlFormat, progressiveFormat, mpvDirectArgs, parseDirectUrls, DEFAULT_QUALITY,
    clientLadder, isRateLimited, parseResolveOutput, pickBetter, shouldStop, wantsPrimaryRetry, resolveArgs,
    CLIENT_TIMEOUT_MS, RESOLVE_BUDGET_MS, STICKY_CLIENT_MS,
  } = require('./quality');
  let target = '';
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      const r = { ok: false, method: 'none', error: `unsupported protocol: ${parsed.protocol}` };
      logPlayer(`REJECT ${String(url).slice(0, 120)} ${r.error}`);
      return r;
    }
    target = parsed.toString();
  } catch {
    const r = { ok: false, method: 'none', error: 'invalid URL' };
    logPlayer(`REJECT ${String(url).slice(0, 120)} invalid URL`);
    return r;
  }
  const quality = normalizeQuality(opts.quality || (typeof config !== 'undefined' && config.quality) || DEFAULT_QUALITY) || DEFAULT_QUALITY;
  // Single-flight: double Enter / key-repeat on the same video must not
  // open 2x mpv windows. Dupe window: 2.5s per URL.
  const nowMs = Date.now();
  try {
    if (lastPlay.url === target && nowMs - lastPlay.at < 2500) {
      logPlayer(`DEDUP skip (2nd Enter within window) ${target.slice(0, 100)}`);
      return { ok: true, method: 'mpv-resolve', quality, deduped: true };
    }
  } catch { /* first play */ }
  try { lastPlay = { url: target, at: nowMs }; } catch { /* best effort */ }
  const dry = !!opts.dryRun;
  const primaryFmt = ytdlFormat(quality);
  logPlayer(`RESOLVE yt-dlp -f "${primaryFmt}" ${target.slice(0, 120)} quality=${quality}${dry ? ' dry-run' : ''}`);
  if (dry) {
    const { mpvArgs } = require('./quality');
    return { ok: true, method: 'mpv-resolve', args: mpvArgs(target, quality), quality, dryRun: true, format: primaryFmt };
  }
  // Animated loading view for the video hand-off: yt-dlp resolving a
  // stream can take seconds, so this shows real motion (spinner + shimmer
  // + the stage) instead of a dead screen. mpv covers the terminal the
  // moment it launches, so the loader is dropped on spawn.
  let loadingPainted = false;
  const stage = (text, hint) => {
    try {
      if (typeof ui === 'undefined' || !ui) return;
      if (text === 'start') {
        if (ui.showLoading) { ui.showLoading('Loading video', 'starting…', hint || ''); loadingPainted = true; }
        return;
      }
      if (ui.setLoadingStage) ui.setLoadingStage(text, hint);
      else if (ui.toast) ui.toast(`${text}${hint ? ` — ${hint}` : ''}`);
    } catch { /* loader is best-effort */ }
  };
  const stopLoading = () => {
    if (!loadingPainted) return;
    try { if (ui && ui.hideLoading) ui.hideLoading(); } catch { /* best effort */ }
    loadingPainted = false;
  };
  // A live player means Enter QUEUES the next item: never paint the yt-dlp
  // loading state for a queue add (mpv resolves the stream on loadfile).
  const willEnqueue = !dry && mpvRunning();
  if (!willEnqueue) {
    stage('start', 'Finding the best stream…');
    // Pre-warm the visualizer tap while resolve runs: parec needs ~2 s to
    // deliver first bytes, and resolve usually takes longer — so the bars
    // are live the instant playback starts instead of two seconds later.
    // Adopted (not restarted) by the spawn path; released by paintFail when
    // resolve never reaches a player. Best-effort, never throws.
    try { startVizSpectrum(); } catch { /* tap is best-effort */ }
  }
  const paintFail = (title, detail) => {
    try {
      if (typeof ui !== 'undefined' && ui && typeof ui.clearStatus === 'function') ui.clearStatus();
    } catch { /* best effort */ }
    // A failure replaces the loader, never stacks on top of it.
    stopLoading();
    // Resolve died without a player: release the pre-warmed tap.
    try { stopVizSpectrum(); } catch { /* best effort */ }
    try { stopVizMonitor(); } catch { /* best effort */ }
    try {
      if (typeof ui !== 'undefined' && ui && typeof ui.setCenterContent === 'function') {
        const log = playerLogFile() || 'player.log';
        const name = String((opts && opts.title) || '').trim();
        ui.setCenterContent(
          `${title}\n${String(detail || '').slice(0, 300)}\n\n${name ? `${name}\n\n` : ''}Check: mpv · yt-dlp · ffmpeg installed · ${log}\nLower data: /quality 360 · black screen? /vo x11 · retry: /play`,
          []
        );
      }
    } catch { /* best effort */ }
  };
  // Queue hygiene: http(s) only, minus the now-playing head, deduped,
  // capped. Entries are {url, title} so the queue never has to show a URL
  // to the user; bare URL strings from older callers are still accepted.
  const uniqueQueueUrls = (queue, target) => {
    const out = [];
    try {
      const seen = new Set([String(target)]);
      for (const item of Array.isArray(queue) ? queue : []) {
        const u = String(item && typeof item === 'object' ? item.url : item || '').trim();
        if (!/^https?:\/\//i.test(u) || seen.has(u)) continue;
        seen.add(u);
        const title = item && typeof item === 'object' ? String(item.title || '').slice(0, 80) : '';
        out.push({ url: u, title });
        if (out.length >= 24) break;
      }
    } catch { /* best effort */ }
    return out;
  };
  // Shared mpv launcher (single + queue): detached, ignored stdio, capped
  // rolling stderr tail, IPC socket for /next + /stop. NOTE: mpv is a
  // LONG-LIVED player — never execFile it with a timeout (that SIGTERMs
  // playback ~30s in: the classic "video closes after a while" crash) and
  // never buffer its stdio unbounded.
  const spawnPlayer = (args, tag) => {
    // Video output: auto chains gpu with software fallbacks in ONE spawn
    // (covers drivers that fail vo init); an explicit /vo pins one driver
    // for black-screen GPUs (Intel MESA etc.).
    let vo = 'auto';
    let windowGeometry = '1000x600';
    try {
      const { VOS, DEFAULT_VO, PLAYER_GEOMETRY } = require('./quality');
      const cfgVo = typeof config !== 'undefined' && config ? config.vo : '';
      vo = (Array.isArray(VOS) && VOS.includes(cfgVo) ? cfgVo : DEFAULT_VO) || DEFAULT_VO;
      if (PLAYER_GEOMETRY) windowGeometry = PLAYER_GEOMETRY;
    } catch { /* auto */ }
    const voArgs = vo === 'auto' ? ['--vo=gpu,xv,x11'] : [`--vo=${vo}`];
    // Windowed size for Esc-out-of-fullscreen: without a geometry mpv
    // restored to its native, screen-filling size (user complaint).
    const windowArgs = [`--geometry=${windowGeometry}`];
    const full = [...args, ...voArgs, ...windowArgs, `--input-ipc-server=${mpvSockPath()}`];
    logPlayer(`SPAWN mpv [${tag}] vo=${vo} ${full.slice(0, 3).join(' ')} … n=${full.length}`);
    // Playback handed off — the loader's job is done (mpv covers the whole
    // screen from here; failures repaint via paintFail/close handler).
    try {
      if (typeof ui !== 'undefined' && ui && typeof ui.clearStatus === 'function') ui.clearStatus();
    } catch { /* best effort */ }
    stopLoading();
    const startedAt = Date.now();
    let tail = '';
    let safeRetried = false;
    const launch = (extraArgs, why) => {
      let child = null;
      try {
        child = spawn('mpv', [...args, ...extraArgs, ...windowArgs, `--input-ipc-server=${mpvSockPath()}`], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (err) {
        const msg = String((err && err.message) || err).slice(0, 200);
        logPlayer(`SPAWN-THROW ${msg}`);
        paintFail('Could not start mpv — staying in TUI (no browser opened).', `${msg}\nInstall: sudo apt install mpv yt-dlp ffmpeg`);
        return;
      }
      if (child && child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (d) => {
          try {
            tail = (String(tail) + d.toString()).slice(-400);
          } catch { /* keep old tail */ }
        });
      }
      if (child && typeof child.on === 'function') {
        child.on('error', (err) => {
          const msg = String((err && err.message) || err).slice(0, 200);
          try {
            mpvPid = null;
          } catch { /* liveness is best-effort */ }
          try { stopVizPoll(); } catch { /* best effort */ }
          try { stopVizMonitor(); } catch { /* best effort */ }
          try { stopVizSpectrum(); } catch { /* best effort */ }
          try {
            if (typeof ui !== 'undefined' && ui && typeof ui.hideVisualizer === 'function') ui.hideVisualizer();
          } catch { /* visualizer is best-effort */ }
          logPlayer(`SPAWN-ERR ${msg}`);
          paintFail('Could not start mpv — staying in TUI (no browser opened).', `${msg}\nInstall: sudo apt install mpv yt-dlp ffmpeg`);
        });
        child.on('close', (code, signal) => {
          let lived = 0;
          try {
            lived = Math.round((Date.now() - startedAt) / 1000);
          } catch { /* clock is best-effort */ }
          try {
            mpvPid = null;
          } catch { /* liveness is best-effort */ }
          try { stopVizPoll(); } catch { /* best effort */ }
          try { stopVizMonitor(); } catch { /* best effort */ }
          try { stopVizSpectrum(); } catch { /* best effort */ }
          // Player gone: the bottom slot goes back to wave/hint duty.
          try {
            if (typeof ui !== 'undefined' && ui && typeof ui.hideVisualizer === 'function') ui.hideVisualizer();
          } catch { /* visualizer is best-effort */ }
          try { stopNowPlaying(); } catch { /* row is best-effort */ }
          logPlayer(`MPV-CLOSE code=${code} signal=${signal || '-'} lived=${lived}s${why ? ` via=${why}` : ''}${code !== 0 ? ` tail=${tail.slice(-220)}` : ''}`);
          if (code === 0) return; // watched and quit: silence
          // Fast death with GPU-flavored stderr on auto vo: the driver
          // accepted init but can't render (black screen class) — respawn
          // once with software output before admitting defeat.
          if (!safeRetried && lived < 15 && vo === 'auto' && /vulkan|MESA|vo |video output|hwdec|vaapi|drm|Failed to open|error opening/i.test(tail)) {
            safeRetried = true;
            logPlayer('MPV-SAFE-RETRY --vo=xv,x11 --hwdec=no');
            try {
              if (typeof ui !== 'undefined' && ui && typeof ui.setStatus === 'function') ui.setStatus('Retrying with software video output…');
            } catch { /* best effort */ }
            launch(['--vo=xv,x11', '--hwdec=no'], 'safe-vo');
            return;
          }
          // Splash an error only when mpv died before playback could start.
          // Quitting after watching (code 0, or long-lived) stays silent.
          if (lived < 15) {
            paintFail('mpv failed — staying in TUI (no browser opened).', tail.slice(-220));
          } else if (typeof ui !== 'undefined' && ui && typeof ui.flashStatus === 'function') {
            // Died mid-watch (the old crash class): say so without nuking
            // the picker — /play retries, player.log has the stderr tail.
            try {
              ui.flashStatus(`mpv exited after ${lived}s (code ${code}) — /play to retry`);
            } catch { /* best effort */ }
          }
        });
      }
      if (child && typeof child.unref === 'function') child.unref();
      // Record the player pid for the single-player check below: Enter
      // while this pid answers means enqueue play-next, not a 2nd window.
      // A safe-retry relaunch overwrites it; close/error clear it above.
      // Stubbed spawns (tests) carry no pid, so they always take the
      // spawn path exactly as before.
      try {
        mpvPid = child && Number.isFinite(Number(child.pid)) ? Number(child.pid) : null;
      } catch { /* liveness is best-effort */ }
      // A live player owns the bottom slot: equalizer bars instead of the
      // wave until the close/error handlers above fire (HANDOVER §6.5).
      try {
        if (Number.isFinite(Number(mpvPid)) && typeof ui !== 'undefined' && ui && typeof ui.showVisualizer === 'function') ui.showVisualizer();
      } catch { /* visualizer is best-effort */ }
      try { startVizPoll(); } catch { /* poll is best-effort */ }
      try { startVizSpectrum(); } catch { /* tap is best-effort */ }
      // Footer truth while it runs: title · position · quality in npBar.
      try { startNowPlaying(); } catch { /* row is best-effort */ }
    };
    launch(voArgs, '');
  };
  const spawnDirect = (directs, fmt) => {
    const args = mpvDirectArgs(directs);
    if (!args) {
      logPlayer(`RESOLVE-EMPTY fmt="${fmt}"`);
      paintFail('Could not resolve a playable stream — staying in TUI (no browser opened).', 'yt-dlp returned no URL. Private/age-gated/login-required videos do this.');
      return;
    }
    stage('starting playback', `stream resolved (${fmt}) — handing over to mpv`);
    logPlayer(`SPAWN mpv ${args.map((a) => (a.length > 90 ? a.slice(0, 90) + '…' : a)).join(' ')} fmt="${fmt}"`);
    spawnPlayer(args, 'direct');
  };
  // Up-next queue: one mpv, whole playlist, immersion unbroken. Entries
  // resolve inside mpv (progressive single-file streams), so playback
  // starts immediately and rolls into the next song/video on its own.
  const rest = uniqueQueueUrls(opts.queue, target);
  const headTitle = String(opts.title || '').slice(0, 80);
  const batch = [{ url: target, title: headTitle }, ...rest];
  // Single player only: Enter while mpv runs enqueues play-next into it
  // (inserted right after the current entry) — never a second window.
  // Stubbed spawns (tests) carry no pid, so they always fall through to
  // the spawn path below, exactly as before.
  if (!dry && mpvRunning()) {
    // One pick, one queued item: Enter while a player runs must add EXACTLY
    // the highlighted video — never the rest of the list (real bug: a /yt
    // pick after a play dumped 24 unselected videos into the queue).
    const enqueueItems = [{ url: target, title: headTitle }];
    logPlayer(`ENQUEUE-TRY n=${enqueueItems.length} ${target.slice(0, 80)}`);
    enqueueBatch(enqueueItems).then(
      (ok) => {
        if (ok) {
          try {
            if (typeof ui !== 'undefined' && ui && typeof ui.flashStatus === 'function') {
              // The user pressed Enter while watching: say it was QUEUED
              // (with the title), never a loading message.
              ui.flashStatus(`Queued: ${headTitle || 'next video'}`, 3200);
            }
          } catch { /* best effort */ }
          return;
        }
        try {
          lastPlay = { url: '', at: 0 };
        } catch { /* best effort: allow an immediate retry */ }
        try {
          if (typeof ui !== 'undefined' && ui && typeof ui.flashStatus === 'function') {
            ui.flashStatus("Couldn't add to the queue — /play to retry");
          }
        } catch { /* best effort */ }
        logPlayer('ENQUEUE-FAIL — /play retries (spawns when the player is gone)');
      },
      () => {
        try {
          lastPlay = { url: '', at: 0 };
        } catch { /* best effort */ }
      }
    );
    return { ok: true, method: 'mpv-enqueue', quality, count: enqueueItems.length };
  }
  if (rest.length > 0) {
    const { mpvQueueArgs } = require('./quality');
    const args = mpvQueueArgs([target, ...rest.map((r) => r.url)], quality);
    if (!args) {
      logPlayer('QUEUE-EMPTY (nothing playable after filtering)');
    } else {
      lastQueue = batch.slice(0, 25);
      logPlayer(`SPAWN-QUEUE mpv n=${lastQueue.length} quality=${quality}`);
      stage('starting playback', `${lastQueue.length} videos queued`);
      spawnPlayer(args, 'queue');
      return { ok: true, method: 'mpv-queue', quality, count: lastQueue.length };
    }
    // else: fall through to single-item two-stage resolve below
  } else {
    try {
      lastQueue = [{ url: target, title: headTitle }];
    } catch { /* display state is best-effort */ }
  }
  // Resolve can take seconds (yt-dlp + SABR retries): the animated loader
  // names the real stage so Enter never reads as dead.
  try {
    if (typeof ui !== 'undefined' && ui && typeof ui.setStatus === 'function') {
      ui.setStatus(`Preparing ${quality}p video…`);
    }
  } catch { /* status never breaks playback */ }
  stage('preparing video', `${quality}p`);
  // Quality-aware resolve. YouTube rate-limits bursts: six PARALLEL yt-dlp
  // extractions per play trip 429s on the rich clients, and only android
  // survives — which serves nothing but progressive 360p. So walk clients
  // SEQUENTIALLY, richest first, stop as soon as the request is met, and
  // retry the rich client once before accepting android's 360p.
  // The JS runtime + EJS solver flags fix YouTube's signature / n
  // challenges (without them yt-dlp says "some formats may be missing" and
  // the rich clients fall back or 429). node is already the app's runtime.
  // The selector is merge-capable (bestvideo+bestaudio): mpv plays the pair
  // via --audio-file (verified: HLS video + opus audio). One --print height
  // + --print urls run yields both the honest height and up to two URLs.
  const resolveForQuality = (quality) => {
    const want = normalizeQuality(quality) || DEFAULT_QUALITY;
    const wantH = want === 'best' ? 100000 : Number(want);
    const selector = ytdlFormat(want);
    const mySeq = ++playSeq;
    const startedAt = Date.now();
    let sticky = '';
    try {
      if (lastGoodClient.client && lastGoodClient.client !== 'android'
        && lastGoodClient.quality === want
        && startedAt - lastGoodClient.at < STICKY_CLIENT_MS) sticky = lastGoodClient.client;
    } catch { /* first play */ }
    const ladder = clientLadder(sticky);
    let best = null; // { height, urls, client, merge }
    let attempts = 0;
    let throttled = 0;
    let jsFlags = null; // unknown until the first run; false on old yt-dlp
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, process.env.TUI_TEST ? 0 : ms));
    const runClient = (client) => new Promise((resolve) => {
      const left = RESOLVE_BUDGET_MS - (Date.now() - startedAt);
      if (left <= 500) { resolve(null); return; }
      try {
        execFile('yt-dlp', [...resolveArgs(selector, client, { js: jsFlags !== false }), target], { timeout: Math.min(CLIENT_TIMEOUT_MS, left), maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          resolve({ client, err, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
      } catch (e) {
        resolve({ client, err: e, stdout: '', stderr: '' });
      }
    });
    const runAttempt = async (client) => {
      let r = await runClient(client);
      if (!r) return null;
      // Older yt-dlp builds do not know --js-runtimes/--remote-components:
      // drop the flags for the rest of this resolve and retry once.
      if (jsFlags === null && /unrecognized arguments|no such option/i.test(`${r.stderr}\n${(r.err && r.err.message) || ''}`)) {
        jsFlags = false;
        logPlayer('RESOLVE-NOJSFLAGS yt-dlp too old for --js-runtimes (upgrade fixes 1080p)');
        r = await runClient(client);
        if (!r) return null;
      }
      if (jsFlags === null && !r.err) jsFlags = true;
      return r;
    };
    const consider = (r) => {
      if (!r) return;
      attempts += 1;
      const rateLimited = isRateLimited(r.stderr);
      if (rateLimited) throttled += 1;
      const parsed = parseResolveOutput(r.stdout);
      if (!parsed.urls.length) return;
      const cand = { height: parsed.height, urls: parsed.urls, client: r.client, merge: parsed.urls.length > 1 };
      if (pickBetter(cand, best, wantH)) best = cand;
      // Remember the winner (never android) so the next play starts there.
      if (best && best.client !== 'android' && best.height > 0) {
        try { lastGoodClient = { client: best.client, quality: want, at: Date.now() }; } catch { /* best effort */ }
      }
    };
    pendingResolve = (async () => {
      try {
        for (const client of ladder) {
          if (mySeq !== playSeq) return;
          const r = await runAttempt(client);
          if (!r) break; // budget spent
          logPlayer(`RESOLVE-TRY client=${client}${isRateLimited(r.stderr) ? ' 429' : ''}`);
          consider(r);
          if (shouldStop({ want, best, attempts, lastClient: client })) break;
          if (isRateLimited(r.stderr)) await sleep(300);
        }
        // The classic 429 consolation: android's 360p won only because the
        // rich clients were throttled — one deliberate retry is worth it.
        if (mySeq === playSeq && wantsPrimaryRetry(best, want)) {
          logPlayer(`RESOLVE-RETRY client=default after android=${best && best.height > 0 ? best.height : '?'}p`);
          await sleep(800);
          consider(await runAttempt('default'));
        }
        if (mySeq !== playSeq) {
          logPlayer(`RESOLVE-STALE seq=${mySeq} current=${playSeq}`);
          return;
        }
        if (best) {
          const got = best.height > 0 ? `${best.height}p` : 'stream';
          logPlayer(`RESOLVE-OK quality=${want} got=${got} urls=${best.urls.length} client=${best.client} attempts=${attempts} throttled=${throttled}`);
          try {
            if (typeof ui !== 'undefined' && ui && typeof ui.setStatus === 'function') {
              ui.setStatus(`Playing ${got} (wanted ${want === 'best' ? 'best' : want + 'p'})`);
            }
            // Honest toast when throttling forced a below-request height
            // instead of silently serving the consolation stream.
            const lowBar = want === 'best' ? 720 : Number(want);
            if (throttled > 0 && best.height > 0 && best.height < lowBar && typeof ui.flashStatus === 'function') {
              ui.flashStatus(`YouTube throttled high-res — playing ${got} · /play retries`, 4200);
            }
          } catch { /* status is best-effort */ }
          spawnDirect(best.urls, selector);
          return;
        }
        logPlayer(`RESOLVE-FAIL attempts=${attempts} throttled=${throttled}`);
        paintFail('Could not resolve a playable stream — staying in TUI (no browser opened).', 'No client returned a usable stream.\nTip: yt-dlp -U (SABR fix) · /quality 360');
      } catch (e) {
        logPlayer(`RESOLVE-THROW ${String((e && e.message) || e).slice(0, 180)}`);
        if (mySeq === playSeq) paintFail('Could not resolve a playable stream — staying in TUI (no browser opened).', `Resolve crashed: ${String((e && e.message) || e).slice(0, 200)}`);
      }
    })();
  };
  resolveForQuality(quality);
  return { ok: true, method: 'mpv-resolve', quality, format: primaryFmt };
}

// External handoff for non-web schemes (mailto:, tel:): open in the
// system's handler via xdg-open/open. Returns true when handed off.
function openExternal(url) {
  let scheme = '';
  try {
    scheme = new URL(String(url)).protocol.toLowerCase();
  } catch {
    return false;
  }
  if (scheme !== 'mailto:' && scheme !== 'tel:') return false;
  try {
    const { execFile } = require('child_process');
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = execFile(opener, [String(url)], () => {});
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false;
  }
}

// --logout never starts the TUI (top-level return is legal in CJS).
if (handleAuthArgs(process.argv.slice(2))) return;

const screen = blessed.screen({
  smartCSR: true,
  fullUnicode: false,
  autoPadding: true,
  title: 'tui-browser',
});

const config = loadConfig();
const navigator = new Navigator();
// pageSize is owned by /links now; the browser uses it as the fan-out
// target for searches (DDG serves 10 per page on its own).
const browser = new (browserLib().Browser)({ pageSize: config.pageSize });

// Monotonic navigation id — see handleNavigation's freshness guard.
let navSeq = 0;
// In-flight navigation target (same-url twin guard, see handleNavigation).
let inflightNav = null;

// Last spawned video (single-flight so double Enter opens 1x mpv, and the
// picker stays mounted for the next pick after mpv closes).
let lastPlay = { url: '', at: 0 };
// Sequential quality resolve state: the stream resolver is async now, so a
// newer play supersedes an older one (no stale mpv after a quick re-pick).
let playSeq = 0;
let pendingResolve = null;
// Last client that delivered a real height (sticky first try, 10 min TTL).
let lastGoodClient = { client: '', quality: '', at: 0 };
// Up-next queue display state (watch URLs, head first). Refreshed on every
// play; read by /queue. Display-only — mpv owns actual playback order.
let lastQueue = [];
// Pid of the spawned player (null when none). mpvRunning() probes it with
// kill(pid, 0): fully synchronous, so Enter can decide enqueue-vs-spawn
// without changing playVideo's sync contract. Stubbed spawns carry no pid
// and always take the spawn path, exactly as before.
let mpvPid = null;
let enqueueChain = Promise.resolve();

function mpvRunning() {
  try {
    if (!mpvPid || !Number.isFinite(Number(mpvPid))) return false;
    process.kill(Number(mpvPid), 0);
    return true;
  } catch {
    return false;
  }
}

// Control socket for the running mpv (/next = skip, /stop = quit).
// Fixed path: a new spawn replaces the old listener (mpv unlinks stale
// sockets on bind); commands to a dead socket just report failure.
function mpvSockPath() {
  try {
    const os = require('os');
    const path = require('path');
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(base, 'tui-browser', 'mpv.sock');
  } catch {
    return '';
  }
}

// ---- opt-in session restore ------------------------------------------
// Privacy default: history is session-scoped (wiped on quit). When the
// user turns restoreSession on, shutdown() captures ONLY the last URL
// here — nothing touches disk while browsing — and boot reopens it. Off
// means the file is neither read nor written and the app boots to the
// dashboard exactly as before.
function sessionFile() {
  try {
    const os = require('os');
    const path = require('path');
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(base, 'tui-browser', 'session.json');
  } catch {
    return '';
  }
}
function lastVisitedUrl() {
  try {
    const h = navigator.getHistory();
    return h.length ? String(h[h.length - 1] || '') : '';
  } catch {
    return '';
  }
}
function saveSessionUrl(url) {
  try {
    if (!config || !config.restoreSession) return false;
    const f = sessionFile();
    if (!f || !/^https?:\/\//i.test(String(url || ''))) return false;
    const fs = require('fs');
    fs.mkdirSync(require('path').dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, JSON.stringify({ url: String(url), at: Date.now() }), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
function restoreSessionUrl() {
  try {
    if (!config || !config.restoreSession) return '';
    const raw = JSON.parse(require('fs').readFileSync(sessionFile(), 'utf8'));
    const url = String((raw && raw.url) || '');
    return /^https?:\/\//i.test(url) ? url : '';
  } catch {
    return '';
  }
}

function sendMpvCommand(cmdArray) {
  return new Promise((resolve) => {
    try {
      const net = require('net');
      const sock = mpvSockPath();
      if (!sock || !Array.isArray(cmdArray)) return resolve(false);
      let done = false;
      const fin = (ok) => {
        if (done) return;
        done = true;
        try {
          s.destroy();
        } catch { /* best effort */ }
        resolve(ok);
      };
      const s = net.createConnection(sock);
      const to = setTimeout(() => fin(false), 2000);
      s.on('connect', () => {
        try {
          s.write(`${JSON.stringify({ command: cmdArray })}\n`);
        } catch {
          clearTimeout(to);
          fin(false);
        }
      });
      // Any reply ({"error":"success",...}) means mpv heard us.
      s.on('data', () => {
        clearTimeout(to);
        fin(true);
      });
      s.on('error', () => {
        clearTimeout(to);
        fin(false);
      });
    } catch {
      resolve(false);
    }
  });
}

function mpvNext() {
  return sendMpvCommand(['playlist-next']);
}

function mpvStop() {
  try { stopVizPoll(); } catch { /* best effort */ }
  try { stopVizMonitor(); } catch { /* best effort */ }
  try { stopVizSpectrum(); } catch { /* best effort */ }
  try {
    if (typeof ui !== 'undefined' && ui && typeof ui.hideVisualizer === 'function') ui.hideVisualizer();
  } catch { /* visualizer is best-effort */ }
  return sendMpvCommand(['quit']);
}

// /queue picker: play the chosen item NOW in the single running player.
// mpv itself swaps the current stream for the target (playlist-play-index),
// so two videos never play at once. Falls back to a fresh play when the
// player is gone. Returns true when the request was handed off.
function playFromQueue(url) {
  const target = String(url || '');
  if (!/^https?:\/\//i.test(target)) return false;
  try {
    if (mpvRunning()) {
      const idx = lastQueue.findIndex((it) => ((it && typeof it === 'object' ? it.url : it) === target));
      if (idx >= 0) {
        mpvCall(['playlist-play-index', idx], { timeoutMs: 3000 }).then(
          (ok) => {
            try {
              if (ok && typeof ui !== 'undefined' && ui && typeof ui.flashStatus === 'function') {
                const it = lastQueue[idx];
                const t = it && typeof it === 'object' ? it.title : '';
                ui.flashStatus(`Playing now: ${t || 'queue item'}`);
              }
            } catch { /* best effort */ }
          },
          () => {}
        );
        return true;
      }
    }
  } catch { /* fall through to a fresh play */ }
  try {
    const r = playVideo(target, { quality: config.quality });
    return !!(r && r.ok);
  } catch {
    return false;
  }
}

// Is this URL already in the bookmark store? Drives the ★ footer marker.
function isBookmarked(url) {
  try {
    return require('./downloads').loadBookmarks().some((b) => b && b.url === String(url));
  } catch {
    return false;
  }
}

// Reactive visualizer tap: a `parec` monitor feed (~16 KB/s, RMS only)
// makes the bars follow the actual music. Zero mpv cooperation needed,
// ~0.1% CPU, silent fallback to the synthetic shape when the tap cannot
// start (missing parec, headless CI, stubbed spawn in tests). Lifecycle
// mirrors the player: one tap per spawn, killed on close/error//stop.
// All best-effort, unref'd — a dead tap never breaks playback or the TUI.
let vizMonitor = null;
function stopVizMonitor() {
  try {
    if (vizMonitor && typeof vizMonitor.stop === 'function') vizMonitor.stop();
  } catch { /* best effort */ }
  try { vizMonitor = null; } catch { /* best effort */ }
}
function startVizMonitor() {
  try {
    stopVizMonitor();
    let audio = null;
    try { audio = require('./vizAudio'); } catch { return; }
    if (!audio || typeof audio.createMonitor !== 'function') return;
    const tap = audio.createMonitor({
      onEnergy: (e) => {
        try {
          if (typeof ui !== 'undefined' && ui && typeof ui.setVizEnergy === 'function') ui.setVizEnergy(e);
        } catch { /* paint is best-effort */ }
      },
      onError: (err) => {
        try { logPlayer(`VIZ-TAP ${(err && err.message) || err || 'ended'}`.slice(0, 160)); } catch { /* diagnostics never break playback */ }
      },
    });
    if (tap) {
      vizMonitor = tap;
      try { logPlayer('VIZ-TAP monitor on (@DEFAULT_MONITOR@ 8kHz)'); } catch { /* best effort */ }
    }
  } catch { /* synthetic fallback */ }
}

// Spectrum tap (v2): scripts/vizspectrum.py turns the same monitor mix
// into per-band levels (~20 Hz, stdlib + numpy only — no new system
// dependencies). Preferred over the RMS tap: startVizSpectrum owns a 4 s
// watchdog — no frames (missing numpy/parec, headless CI) falls back to
// the RMS tap, then to the synthetic shape. 4 s, not 2: a cold tap pays
// python+numpy import plus parec's ~2 s first-byte delay, and the old 2 s
// watchdog lost that race on every windowed resume (player.log 06:25) —
// the user only ever saw the RMS fallback. A mid-play death falls back
// once per spawn. Lifecycle mirrors the player; all best-effort, unref'd.
let vizSpectrum = null;
let vizSpecFrames = 0;
let vizSpecFellBack = false;
function stopVizSpectrum() {
  try {
    if (vizSpectrum && typeof vizSpectrum.stop === 'function') vizSpectrum.stop();
  } catch { /* best effort */ }
  try { vizSpectrum = null; } catch { /* best effort */ }
}
function startVizSpectrum() {
  try {
    // Adopt a pre-warmed tap (started during resolve): restarting would
    // re-pay parec's ~2 s first-byte delay for no reason.
    try {
      if (vizSpectrum) { vizSpecFellBack = false; return; }
    } catch { /* fall through to a fresh start */ }
    stopVizSpectrum();
    stopVizMonitor();
    vizSpecFrames = 0;
    vizSpecFellBack = false;
    let audio = null;
    try { audio = require('./vizAudio'); } catch { startVizMonitor(); return; }
    if (!audio || typeof audio.createSpectrumMonitor !== 'function') { startVizMonitor(); return; }
    const tap = audio.createSpectrumMonitor({
      onBands: (bands) => {
        try {
          vizSpecFrames++;
          if (typeof ui !== 'undefined' && ui && typeof ui.setVizBands === 'function') ui.setVizBands(bands);
        } catch { /* paint is best-effort */ }
      },
      onError: (err) => {
        try { logPlayer(`VIZ-SPEC ${(err && err.message) || err || 'ended'}`.slice(0, 160)); } catch { /* diagnostics never break playback */ }
        try {
          if (!vizSpecFellBack && mpvRunning()) {
            vizSpecFellBack = true;
            stopVizSpectrum();
            startVizMonitor();
          }
        } catch { /* fallback is best-effort */ }
      },
    });
    if (!tap) { startVizMonitor(); return; }
    vizSpectrum = tap;
    try { logPlayer('VIZ-SPEC spectrum on (8 bass bands, 20Hz)'); } catch { /* best effort */ }
    const wd = setTimeout(() => {
      try {
        if (vizSpecFrames === 0 && vizSpectrum && mpvRunning()) {
          vizSpecFellBack = true;
          try { logPlayer('VIZ-SPEC no frames in 4s — RMS fallback'); } catch {}
          stopVizSpectrum();
          startVizMonitor();
        }
      } catch { /* fallback is best-effort */ }
    }, 4000);
    if (wd && typeof wd.unref === 'function') {
      try { wd.unref(); } catch { /* keep watching */ }
    }
  } catch {
    try { startVizMonitor(); } catch { /* synthetic fallback */ }
  }
}

// Visualizer pause-follow (P4): one cheap IPC poll per second while mpv
// plays — no audio analysis, no extra processes. Dead player stops the
// poll and releases the bottom slot. All best-effort, unref'd.
let vizPoll = null;
let vizSuspendedFS = false;
function stopVizPoll() {
  try {
    if (vizPoll) { clearInterval(vizPoll); vizPoll = null; }
  } catch { /* best effort */ }
  try { vizSuspendedFS = false; } catch { /* best effort */ }
}
function startVizPoll() {
  try {
    stopVizPoll();
    // Fullscreen suspension: mpv covers the whole screen, so bars paint
    // unseen while fullscreen. Suspended = viz UI hidden, taps KEPT WARM:
    // killing them here forced a cold respawn on resume, and the cold tap
    // always lost the watchdog race — every windowed session fell back to
    // the RMS look (player.log 06:25). Leaving fullscreen re-shows the viz
    // and reuses the warm tap. stopVizPoll resets the flag per generation.
    const tick = () => {
      try {
        if (!mpvRunning()) {
          stopVizPoll();
          try { stopVizMonitor(); } catch { /* best effort */ }
          try { stopVizSpectrum(); } catch { /* best effort */ }
          try { vizSuspendedFS = false; } catch { /* best effort */ }
          try {
            if (typeof ui !== 'undefined' && ui && typeof ui.hideVisualizer === 'function') ui.hideVisualizer();
          } catch { /* best effort */ }
          return;
        }
        mpvQuery(['pause', 'fullscreen'], { timeoutMs: 300 }).then(
          (live) => {
            try {
              if (typeof ui !== 'undefined' && ui && typeof ui.setVizPaused === 'function') {
                ui.setVizPaused(!!(live && live.pause));
              }
            } catch { /* best effort */ }
            try {
              const fs = !!(live && live.fullscreen === true);
              const vizOn = (typeof ui !== 'undefined' && ui && typeof ui.isVisualizerOn === 'function')
                ? ui.isVisualizerOn() : false;
              if (fs && vizOn && !vizSuspendedFS) {
                // Entered fullscreen: park the viz UI only. The taps stay
                // alive and warm (idle cost ~0.1% CPU; readings store but
                // never paint while hidden), so resume is instant.
                vizSuspendedFS = true;
                try {
                  if (typeof ui !== 'undefined' && ui && typeof ui.hideVisualizer === 'function') ui.hideVisualizer();
                } catch { /* best effort */ }
                try { logPlayer('VIZ-FS suspended (mpv fullscreen, taps warm)'); } catch { /* best effort */ }
              } else if (!fs && vizSuspendedFS) {
                // Left fullscreen with the player alive: re-show and reuse
                // the warm tap. A fresh tap starts only if both died while
                // parked (then the 4 s watchdog owns the race, not 2 s).
                vizSuspendedFS = false;
                try {
                  if (typeof ui !== 'undefined' && ui && typeof ui.showVisualizer === 'function') ui.showVisualizer();
                } catch { /* best effort */ }
                try {
                  let warm = false;
                  try { warm = !!vizSpectrum || !!vizMonitor; } catch { warm = false; }
                  if (!warm) startVizSpectrum();
                } catch { /* tap is best-effort */ }
                try { logPlayer('VIZ-FS resumed (mpv windowed)'); } catch { /* best effort */ }
              }
            } catch { /* fullscreen rule never throws */ }
          },
          () => {}
        );
      } catch { /* poll never throws */ }
    };
    tick(); // leading edge: correct within ~100 ms, not a full second
    vizPoll = setInterval(tick, 1000);
    if (vizPoll && typeof vizPoll.unref === 'function') {
      try { vizPoll.unref(); } catch { /* keep polling */ }
    }
  } catch { /* best effort */ }
}

// Live player truth: ask mpv for property values over the IPC socket.
// Request/response pairs match by request_id (async mpv events carry none
// and are ignored). Resolves an object of answered props, or null when the
// player is gone / silent. Never throws. sockPath override exists for tests.
function mpvQuery(props, { sockPath, timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const done = (val) => {
      try {
        resolve(val);
      } catch { /* settle once */ }
    };
    try {
      const list = (Array.isArray(props) ? props : [props]).filter((k) => typeof k === 'string' && k);
      let sock = '';
      try {
        sock = sockPath || mpvSockPath();
      } catch {
        return done(null);
      }
      if (!sock || !list.length) return done(null);
      const net = require('net');
      const pending = new Map();
      const out = {};
      let rid = 1;
      let carry = '';
      let s = null;
      let finished = false;
      let timer = null;
      const fin = (val) => {
        if (finished) return;
        finished = true;
        try {
          clearTimeout(timer);
        } catch { /* best effort */ }
        try {
          s && s.destroy();
        } catch { /* best effort */ }
        done(val);
      };
      timer = setTimeout(() => fin(Object.keys(out).length ? out : null), Math.max(100, Number(timeoutMs) || 800));
      if (timer && typeof timer.unref === 'function') {
        try {
          timer.unref();
        } catch { /* keep ticking */ }
      }
      try {
        s = net.createConnection(sock);
      } catch {
        return fin(null);
      }
      s.on('connect', () => {
        try {
          for (const key of list) {
            const id = rid++;
            pending.set(id, key);
            s.write(`${JSON.stringify({ command: ['get_property', key], request_id: id })}\n`);
          }
        } catch {
          fin(Object.keys(out).length ? out : null);
        }
      });
      s.on('data', (chunk) => {
        try {
          carry += String(chunk);
          const lines = carry.split('\n');
          carry = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            let msg = null;
            try {
              msg = JSON.parse(t);
            } catch {
              continue;
            }
            if (!msg || typeof msg !== 'object') continue;
            if (msg.request_id == null || !pending.has(msg.request_id)) continue;
            const key = pending.get(msg.request_id);
            pending.delete(msg.request_id);
            if (msg.error === 'success') out[key] = msg.data === undefined ? null : msg.data;
            if (!pending.size) {
              fin(out);
              return;
            }
          }
        } catch { /* keep listening */ }
      });
      s.on('error', () => fin(Object.keys(out).length ? out : null));
      s.on('close', () => fin(Object.keys(out).length ? out : null));
    } catch {
      done(null);
    }
  });
}

// What is actually on screen right now: live mpv state first (exact even
// after /next seeks past the queued head), null when unverifiable. Callers
// fall back to getNowPlaying() (what we asked it to play). Never throws.
async function mpvNowPlaying() {
  try {
    const live = await mpvQuery(['filename', 'media-title', 'pause'], { timeoutMs: 300 }).catch(() => null);
    if (live && (live.filename || live['media-title'])) {
      return {
        url: typeof live.filename === 'string' ? live.filename : '',
        title: typeof live['media-title'] === 'string' ? live['media-title'] : '',
        paused: live.pause === true,
      };
    }
  } catch { /* fall through to null */ }
  return null;
}

// Last known playback head (what we handed mpv). Synchronous so lists can
// paint instantly; mpvNowPlaying() confirms it live. Never throws.
function getNowPlaying() {
  try {
    const q = [...lastQueue];
    if (q.length && q[0]) {
      const head = typeof q[0] === 'object' ? q[0] : { url: q[0], title: '' };
      return { url: String(head.url || ''), title: String(head.title || '') };
    }
  } catch { /* none */ }
  return null;
}

// Quality is locked for the NEXT track; a running player gets told too so
// the setting is not a lie until the next spawn. mpv 0.40 accepts
// ytdl-format at runtime (older builds ignore the property — playback
// continues either way). Resolves true only when mpv acknowledged.
async function pushPlayerQuality(q) {
  try {
    if (!mpvRunning()) return false;
    const { ytdlFormat } = require('./quality');
    const fmt = ytdlFormat(q || (config && config.quality));
    if (!fmt) return false;
    return await mpvCall(['set_property', 'ytdl-format', fmt], { timeoutMs: 1200 });
  } catch {
    return false;
  }
}

// ---- now-playing row --------------------------------------------------
// While a player runs, one 1.5 s poll mirrors mpv's truth into the footer
// (♪ position · title · quality). The interval is created by the first
// spawn and destroys itself the moment mpvRunning() says the player is
// gone — a dead socket never leaves a stale row behind. Every tick is a
// bounded mpvQuery; the UI repaints only when the formatted line changed.
let npTimer = null;
let npLast = '';

function stopNowPlaying() {
  try {
    if (npTimer) {
      clearInterval(npTimer);
      npTimer = null;
    }
  } catch { /* best effort */ }
  npLast = '';
  try {
    if (typeof ui !== 'undefined' && ui && typeof ui.setNowPlaying === 'function') ui.setNowPlaying('');
  } catch { /* row is best-effort */ }
}

function startNowPlaying() {
  try {
    if (npTimer) return;
    npTimer = setInterval(() => { pollNowPlaying(); }, 1500);
    if (npTimer && typeof npTimer.unref === 'function') npTimer.unref();
    pollNowPlaying();
  } catch { /* row is best-effort */ }
}

async function pollNowPlaying() {
  let info = null;
  try {
    if (!mpvRunning()) { stopNowPlaying(); return; }
    info = await mpvQuery(['media-title', 'time-pos', 'duration', 'pause'], { timeoutMs: 600 });
  } catch { info = null; }
  try {
    if (!mpvRunning()) { stopNowPlaying(); return; }
    if (!info) return; // transient silence: keep the last frame on screen
    const q = String((config && config.quality) || '').trim();
    const label = !q ? '' : (q === 'best' ? 'best' : `${q}p`);
    const text = require('./nowplaying').formatNowPlaying(info, { quality: label });
    if (text !== npLast) {
      npLast = text;
      if (typeof ui !== 'undefined' && ui && typeof ui.setNowPlaying === 'function') ui.setNowPlaying(text);
    }
  } catch { /* row is best-effort */ }
}

// Boot adoption: a player that outlived the app (fixed IPC socket from an
// earlier process) is adopted once at startup so Enter keeps QUEUEING into
// it instead of spawning a second mpv window. One bounded probe: an
// absent/dead socket resolves null and boot continues untouched. Self-
// healing: if the adopted pid dies later, mpvRunning() says so and the
// next pick spawns fresh.
async function adoptRunningPlayer() {
  try {
    if (mpvRunning()) return true;
    const st = await mpvQuery(['pid'], { timeoutMs: 700 });
    const pid = Number(st && st.pid);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    mpvPid = pid;
    // Same live-player furniture as a fresh spawn (bars + footer truth).
    try {
      if (typeof ui !== 'undefined' && ui && typeof ui.showVisualizer === 'function') ui.showVisualizer();
    } catch { /* visualizer is best-effort */ }
    try { startVizPoll(); } catch { /* poll is best-effort */ }
    try { startVizSpectrum(); } catch { /* tap is best-effort */ }
    try { startNowPlaying(); } catch { /* row is best-effort */ }
    return true;
  } catch {
    return false;
  }
}

// Strict IPC call: resolves true only on an error:success reply matched by
// request_id (mpv answers every command; the bool sender used by /next and
// /stop cannot tell failure from silence). Never throws.
function mpvCall(cmdArray, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const done = (v) => {
      try {
        resolve(!!v);
      } catch { /* settle once */ }
    };
    try {
      if (!Array.isArray(cmdArray) || !cmdArray.length) return done(false);
      const net = require('net');
      let sock = '';
      try {
        sock = mpvSockPath();
      } catch {
        return done(false);
      }
      if (!sock) return done(false);
      const rid = Math.floor(Math.random() * 1e9) + 1;
      let s = null;
      let finished = false;
      let timer = null;
      let carry = '';
      const fin = (v) => {
        if (finished) return;
        finished = true;
        try {
          clearTimeout(timer);
        } catch { /* best effort */ }
        try {
          s && s.destroy();
        } catch { /* best effort */ }
        done(v);
      };
      timer = setTimeout(() => fin(false), Math.max(200, Number(timeoutMs) || 1500));
      if (timer && typeof timer.unref === 'function') {
        try {
          timer.unref();
        } catch { /* keep ticking */ }
      }
      try {
        s = net.createConnection(sock);
      } catch {
        return fin(false);
      }
      s.on('connect', () => {
        try {
          s.write(`${JSON.stringify({ command: cmdArray, request_id: rid })}\n`);
        } catch {
          fin(false);
        }
      });
      s.on('data', (chunk) => {
        try {
          carry += String(chunk);
          const lines = carry.split('\n');
          carry = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            let msg = null;
            try {
              msg = JSON.parse(t);
            } catch {
              continue;
            }
            if (msg && typeof msg === 'object' && msg.request_id === rid) {
              fin(msg.error === 'success');
              return;
            }
          }
        } catch { /* keep listening */ }
      });
      s.on('error', () => fin(false));
      s.on('close', () => fin(false));
    } catch {
      done(false);
    }
  });
}

// Enqueue play-next into the RUNNING player: append the batch at the tail,
// then move each entry right after the current one (verified move math:
// entry appended at count+j belongs at pos+1+j). Serialized through a
// chain so rapid Enters cannot interleave moves. Mirrors the order into
// lastQueue (display-only). Resolves true only when every step answered
// success — anything less means "spawn instead / retry", never half state.
function enqueueBatch(batch) {
  const list = (Array.isArray(batch) ? batch : [])
    .map((it) => (it && typeof it === 'object' ? { url: String(it.url || '').trim(), title: String(it.title || '').slice(0, 80) } : { url: String(it || '').trim(), title: '' }))
    .filter((e) => /^https?:\/\//i.test(e.url));
  const run = async () => {
    try {
      if (!list.length || !mpvRunning()) return false;
      const st = await mpvQuery(['playlist-pos', 'playlist-count'], { timeoutMs: 1500 });
      if (!st) return false;
      const posRaw = Number(st['playlist-pos']);
      const countRaw = Number(st['playlist-count']);
      // Idle mpv reports pos -1: appends already land in order, no moves.
      const pos = Number.isFinite(posRaw) && posRaw >= 0 ? posRaw : null;
      const count = Number.isFinite(countRaw) && countRaw >= 0 ? countRaw : null;
      for (let i = 0; i < list.length; i++) {
        // append-play starts an idle player too; the rest plain-append.
        const ok = await mpvCall(['loadfile', list[i].url, i === 0 ? 'append-play' : 'append'], { timeoutMs: 15000 });
        if (!ok) return false;
      }
      if (pos != null && count != null) {
        for (let j = 0; j < list.length; j++) {
          const ok = await mpvCall(['playlist-move', count + j, pos + 1 + j], { timeoutMs: 2000 });
          if (!ok) return false;
        }
      }
      try {
        logPlayer(`ENQUEUE mpv n=${list.length} at=${pos == null ? 'tail' : pos + 1}`);
      } catch { /* diagnostics never break playback */ }
      try {
        const q = [...lastQueue];
        const at = pos == null ? q.length : Math.min(Math.max(pos + 1, 0), q.length);
        lastQueue = [...q.slice(0, at), ...list, ...q.slice(at)].slice(0, 25);
      } catch { /* display is best-effort */ }
      return true;
    } catch {
      return false;
    }
  };
  const p = enqueueChain.then(run, run);
  enqueueChain = p.catch(() => false);
  return p;
}

// Aborts the previous keystroke's web-suggest fetch. Typing must never wait
// on (or pile up) stale network: local rows paint instantly, the fetch only
// enriches whatever is current.
let suggestCtl = null;

function normalizeURL(input) {
  const v = String(input || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) return `https://${v}`;
  return null;
}

// ---- Idle teardown (opt-in RAM saver; config.idleTeardownMin) ----
// Chrome is parked after N idle minutes and relaunched on the next
// navigation — the big idle RAM win. Off by default (0 = never). mpv is a
// separate process and is untouched, so playback never stops. Every step is
// best-effort: a failed park just means the engine stays open.
let idleTimer = null;
function cancelIdleTeardown() {
  try {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  } catch { /* best effort */ }
}
function armIdleTeardown() {
  cancelIdleTeardown();
  let min = 0;
  try { min = Math.floor(Number(config && config.idleTeardownMin)) || 0; } catch { min = 0; }
  if (min <= 0) return;
  try {
    if (!browser || !browser.browser) return; // nothing open to park
    idleTimer = setTimeout(() => {
      idleTimer = null;
      try {
        if (browser && browser.browser) {
          browser.close().catch(() => {});
          logPlayer(`IDLE-TEARDOWN browser parked after ${min} min idle`);
          try {
            if (typeof ui !== 'undefined' && ui && typeof ui.flashStatus === 'function') {
              ui.flashStatus('Engine parked to free RAM — it restarts on your next page');
            }
          } catch { /* feedback is best-effort */ }
        }
      } catch { /* teardown is best-effort */ }
    }, Math.min(min, 240) * 60000);
    if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref();
  } catch { /* best effort */ }
}

function shutdown(code) {
  cancelIdleTeardown();
  try { if (ui && typeof ui.setGlow === 'function') ui.setGlow(false); } catch { /* best effort */ }
  try { stopVizMonitor(); } catch {}
  try { stopVizSpectrum(); } catch {}
  try { stopVizPoll(); } catch {}
  // Opt-in session restore: capture the last page BEFORE the wipe below —
  // this call is a no-op unless config.restoreSession is on (off leaves
  // zero trace on disk).
  try { saveSessionUrl(lastVisitedUrl()); } catch { /* best effort */ }
  // Session scope: browsing history is wiped on close. Login (in-memory)
  // and bookmarks (their own store) are untouched.
  try { navigator.clearHistory(); } catch { /* best effort */ }
  try {
    screen.destroy();
  } catch {}
  // Bounded teardown: a Playwright context.close() can wait on a stalled
  // page (chaos saw /quit exceed 5 s after heavy use), and quit must never
  // hang. Whichever settles first wins; the timer is unref'd.
  try {
    const closed = browser.close().catch(() => {});
    const cap = new Promise((resolve) => {
      const t = setTimeout(resolve, 1500);
      if (t && typeof t.unref === 'function') t.unref();
    });
    Promise.race([closed, cap]).finally(() => process.exit(code));
  } catch {
    process.exit(code);
  }
}

// Ctrl+Q / /quit. When a video is still playing, ask what to do with it
// (keep playing / stop too), with an "always" option stored in
// config.quitPlayer (changeable later in /settings).
function requestQuit() {
  let playing = false;
  try { playing = mpvRunning(); } catch { playing = false; }
  const mode = (config && config.quitPlayer) || 'ask';
  if (!playing || mode === 'keep') { shutdown(0); return; }
  if (mode === 'stop') {
    try { mpvStop(); } catch { /* best effort */ }
    shutdown(0);
    return;
  }
  // ask
  try {
    if (ui && typeof ui.showChoice === 'function') {
      ui.showChoice({
        title: 'A video is still playing',
        options: [
          { label: 'Quit and keep the video playing', hint: 'the player stays open' },
          { label: 'Quit and stop the video', hint: 'closes the player too' },
          { label: 'Keep the video playing — always', hint: 'remember for next time' },
          { label: 'Stop the video — always', hint: 'remember for next time' },
        ],
        footer: 'Esc cancels · change later in /settings',
        callback: (pick) => {
          if (pick === 0) { shutdown(0); return; }
          if (pick === 1) { try { mpvStop(); } catch { /* best effort */ } shutdown(0); return; }
          if (pick === 2) { try { config.quitPlayer = 'keep'; saveConfig(config); } catch { /* best effort */ } shutdown(0); return; }
          if (pick === 3) { try { config.quitPlayer = 'stop'; saveConfig(config); } catch { /* best effort */ } try { mpvStop(); } catch { /* best effort */ } shutdown(0); return; }
          // null (Esc): stay in the app.
        },
      });
      return;
    }
  } catch { /* fall through to a plain quit */ }
  shutdown(0);
}

// Quit keys: Ctrl+Q / Ctrl+C only (bare `q` always types, per user
// decision). Esc is owned SOLELY by ui.js router (single-owner; a second
// screen.key escape binding double-fired and clobbered every restore).
// F2 is intentionally NOT bound: laptop function-key rows already own it,
// and the theme picker now lives inside /settings.

function searchURL(query) {
  // Strip control bytes first: pasted DEL/other control chars would
  // otherwise percent-encode into the query (e.g. %7F) and mistarget search.
  const clean = String(query == null ? '' : query).replace(/[\x00-\x1f\x7f]/g, '');
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(clean)}`;
}

// Enter routing: `/commands` first (never reach web search) — the typed
// value wins whenever it extends the highlighted command (e.g. `/history
// cats` over a `/history` row keeps `cats`; P1-2). A bare `/the` over a
// concrete row still uses the row. `<placeholder>` rows always fall
// through to the typed value. Then URL rows, then raw input routing.
// Command bodies live in commands.js (testable without booting the TUI).
function routeInput(value, row) {
  const v = String(value || '').trim();
  if (v.startsWith('/')) {
    // Note: ui normalizes suggest rows to {title,...}, so check title here.
    // Placeholder rows (`<...>` / `[...]` usage) never win — the typed
    // value carries the real arguments.
    if (row && row.kind === 'command' && row.title && !row.title.includes('<') && !row.title.includes('[')) {
      const rowCmd = String(row.title).trim().toLowerCase();
      const typed = v.toLowerCase();
      // Typed value extends the row ("/history cats" vs "/history"):
      // prefer the typed value so args are never silently dropped.
      if (typed === rowCmd || typed.startsWith(rowCmd + ' ') || typed.startsWith(rowCmd + '/')) {
        return routeCommand(v, commandDeps());
      }
      // Bare partial ("/the" over "/pets"): the row is the intent, unless
      // the typed value is itself a complete longer command.
      const typedCmd = typed.split(/\s+/)[0];
      if (typedCmd.length <= rowCmd.length) {
        return routeCommand(row.title, commandDeps());
      }
      return routeCommand(v, commandDeps());
    }
    return routeCommand(v, commandDeps());
  }
  // A `>`-prefixed value never rides a suggestion row. DDG autocomplete
  // rows for ">nope" arrive a beat after typing; picking one navigated to
  // a web search for the bang syntax — exactly what the teaching block
  // below promises never happens (and a `>wiki cats` Enter could be
  // hijacked the same way). Banged input goes straight to scope routing.
  const scopesMod = require('./scopes');
  const bangPrefixed = scopesMod.normalizeBangInput(v).startsWith('>');
  if (row && row.url && !bangPrefixed) {
    if (routeYouTubeUrl(row.url)) return;
    return handleNavigation(row.url);
  }
  if (!v) return;
  // Typed bang (`>wiki einstein`) wins everywhere: explicit scope, explicit
  // query — the site's own search, and for Wikipedia its TOP result. Extra
  // `>`s (`>>wiki x`) collapse into one so a typo still routes.
  const bang = scopesMod.parseBang(v);
  if (bang) {
    if (runScopedSearch(bang.scope, bang.query, { label: `${bang.scope} ${bang.query}` })) return;
  }
  if (bangPrefixed) {
    // A `>` prefix that did not resolve to a scope NEVER web-searches its own
    // syntax: `>wiki`, `>>foo`, `>notascope query` all teach instead. (The
    // old fall-through navigated to a search page for ">wiki" — a surprise.)
    try {
      if (ui && typeof ui.flashStatus === 'function') {
        ui.flashStatus('Unknown scope. Try >wiki, >gh, >so, >hn, or >example.com — clear the > to web-search.');
      }
    } catch { /* best effort */ }
    return;
  }
  // Dashboard open: the picked scope (ui picker) scopes the search. Plain
  // queries with the default `web` scope search the whole web — the old
  // "whatever row is highlighted" scoping is gone.
  const scoped = homeScopeSearch(v);
  if (scoped) {
    if (runScopedSearch(scoped.scope, scoped.query, { label: v })) return;
  }
  // Raw search text keeps living in the bar (see handleNavigation's label):
  // refining a query is one edit, not a retype. Direct URLs show as URLs.
  const target = normalizeURL(v);
  if (target) {
    if (routeYouTubeUrl(target)) return;
    return handleNavigation(target);
  }
  return handleNavigation(searchURL(v), { label: v });
}

// Every youtube.com open goes through the fast path — no slow Playwright
// scrape, no bot-wall roulette. Video/playlist URLs play in mpv at once;
// search URLs run a /yt search for the same query (youtube.com/results
// uses search_query, music.youtube.com/search uses q — both accepted on
// both paths). Anything else on a YouTube host (channels, home) returns
// false for normal navigation.
// History back/forward call handleNavigation directly and keep their
// Playwright semantics (theater layout included).
function routeYouTubeUrl(raw) {
  let yt = null;
  try {
    yt = require('./yt');
  } catch {
    return false;
  }
  let u = null;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return false;
  }
  try {
    const host = u.hostname.toLowerCase();
    const isYtHost = host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
    if (!isYtHost) return false;
    if (typeof yt.isYouTubeVideoUrl === 'function' && yt.isYouTubeVideoUrl(u.toString())) {
      playVideo(u.toString(), { quality: config.quality });
      return true;
    }
    if (u.pathname.toLowerCase() === '/results' || u.pathname.toLowerCase() === '/search') {
      const q = (u.searchParams.get('search_query') || u.searchParams.get('q') || '').trim();
      if (q) {
        routeCommand(`/yt ${q.slice(0, 120)}`, commandDeps());
        return true;
      }
      return false;
    }
    if (u.pathname.toLowerCase() === '/playlist' && u.searchParams.get('list')) {
      playVideo(u.toString(), { quality: config.quality });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function commandDeps() {
  return {
    ui, browser, navigator, config, saveConfig, shutdown,
    navigate: (u) => handleNavigation(u),
    goBack: () => {
      const u = navigator.back();
      if (u) { handleNavigation(u, { history: true }); return true; }
      return false;
    },
    goForward: () => {
      const u = navigator.forward();
      if (u) { handleNavigation(u, { history: true }); return true; }
      return false;
    },
    reload: () => {
      const u = navigator.currentUrl();
      if (u) { handleNavigation(u, { history: true }); return true; }
      return false;
    },
    currentUrl: () => navigator.currentUrl(),
    openExternal: (u) => openExternal(u),
    playUrl: (u, queue, title) => playVideo(String(u || ''), { quality: config.quality, queue, title }),
    getQueue: () => { try { return [...lastQueue]; } catch { return []; } },
    getNowPlaying: () => getNowPlaying(),
    mpvNowPlaying: () => mpvNowPlaying(),
    pushQuality: (q) => pushPlayerQuality(q),
    mpvNext: () => mpvNext(),
    mpvStop: () => mpvStop(),
    // /ai: OpenRouter free-tier answers (src/openrouter.js). The command
    // layer calls THIS when present, so tests/hosts can inject a transport;
    // otherwise it falls back to the module with the same behavior.
    askAi: (q, opts) => require('./openrouter').askAi(q, opts || {}),
    // /links <n>: re-fill the open search list up to the new size.
    refillLinks: (n) => { fillCurrentSearch(Number(n) || config.pageSize); },
    // /pdf <q>: PDF-only search (filetype:pdf) through the normal engine
    // ladder — rows get the (pdf) marker and open in the in-app viewer.
    search: (q) => handleNavigation(searchURL(q)),
    // /home: reset the browser (fresh engine, RAM released) then show the
    // in-app start dashboard (never a dead search page / bot wall).
    resetBrowser: () => resetBrowser(),
    showHome: () => showHomeDashboard(),
    // /read [raw]: reader view is the default; raw is the escape hatch.
    setReadMode: (mode) => setReadMode(mode),
  };
}

// ---- In-app Home dashboard (/home destination) ----
// The start view is rendered by the TUI itself: pinned quick links, recent
// history and bookmarks. No network, so it can never show a bot wall or an
// "unsupported browser" page. `tui:home` is the marker stored in history.
const HOME_URL = 'tui:home';
const HOME_QUICK = [
  { title: 'Wikipedia', url: 'https://en.wikipedia.org/', domain: 'wikipedia.org' },
  { title: 'GitHub', url: 'https://github.com/', domain: 'github.com' },
  { title: 'Hacker News', url: 'https://news.ycombinator.com/', domain: 'ycombinator.com' },
  { title: 'Stack Overflow', url: 'https://stackoverflow.com/', domain: 'stackoverflow.com' },
];

// /home domain scope + `>bang` search. The dashboard picker (ui.getHomeScope)
// is the source of truth while home is open — the highlighted row never
// decides the scope (the "why is it searching YouTube" bug). Every search
// path funnels through runScopedSearch.
function homeScopeSearch(query) {
  try {
    if (!ui || typeof ui.isHomeOpen !== 'function' || !ui.isHomeOpen()) return null;
    if (typeof ui.getHomeScope !== 'function') return null;
    const scope = String(ui.getHomeScope() || '');
    const q = String(query || '').trim();
    if (!scope || !q) return null; // web scope: plain search
    return { scope, query: q };
  } catch {
    return null;
  }
}

// One navigation for every scoped search. Wikipedia resolves the REAL top
// result (opensearch API) and opens it directly; the Go-handshake search URL
// is the instant fallback when the API is slow/offline. Other scopes open
// their on-site search; `>somedomain.tld` becomes a site:-scoped web search.
function runScopedSearch(scope, query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return false;
  const label = String(opts.label || q);
  const key = String(scope || '').toLowerCase();
  if (key === 'wiki') {
    const fallback = require('./scopes').scopedSearchUrl('wiki', q);
    let settled = false;
    const go = (url, how) => {
      if (settled) return;
      settled = true;
      try { if (typeof ui.clearStatus === 'function') ui.clearStatus(); } catch { /* best effort */ }
      logPlayer(`SCOPE wiki ${how} q="${q.slice(0, 60)}"`);
      handleNavigation(url, { label });
    };
    try { if (typeof ui.setStatus === 'function') ui.setStatus('Finding the top Wikipedia result…'); } catch { /* best effort */ }
    // Hard timeout: a hanging fetch must never trap the query.
    let timer = null;
    try {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      timer = setTimeout(() => { try { ctl && ctl.abort(); } catch { /* already settled */ } }, 5000);
      if (timer && typeof timer.unref === 'function') timer.unref();
      fetch(require('./scopes').wikiOpensearchUrl(q), { signal: ctl ? ctl.signal : undefined, headers: { 'User-Agent': 'tui-browser' } })
        .then((res) => (res && res.ok ? res.json() : null))
        .then((json) => {
          const url = require('./scopes').firstWikiResult(json);
          if (url) go(url, 'top-result');
          else go(fallback, 'go-handshake');
        })
        .catch(() => go(fallback, 'api-failed'));
    } catch {
      go(fallback, 'no-fetch');
    }
    return true;
  }
  const url = require('./scopes').scopedSearchUrl(key, q);
  if (url) {
    handleNavigation(url, { label });
    return true;
  }
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(key)) {
    handleNavigation(searchURL(`site:${key} ${q}`), { label });
    return true;
  }
  return false;
}

// Rows for the dashboard: quick links, then recent history (newest first),
// then bookmarks. Deduped by URL, capped. Never throws.
function homeRows() {
  const rows = [];
  const seen = new Set();
  const host = (u) => {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
  };
  const push = (title, url) => {
    const u = String(url || '').trim();
    if (!u || !/^https?:\/\//i.test(u) || seen.has(u)) return;
    seen.add(u);
    rows.push({ title: String(title || host(u) || u).slice(0, 80), url: u, domain: host(u) });
  };
  for (const q of HOME_QUICK) push(q.title, q.url);
  // Live widget: while mpv plays, the track tops the dashboard and Enter
  // reopens it — the dashboard doubles as a remote.
  try {
    if (mpvRunning()) {
      const np = getNowPlaying();
      const u = np && np.url ? String(np.url) : '';
      if (u && /^https?:\/\//i.test(u) && !seen.has(u)) {
        seen.add(u);
        rows.unshift({ title: `♪ ${(np.title || host(u) || u)}`.slice(0, 80), url: u, domain: 'now playing' });
      }
    }
  } catch { /* widget is best-effort */ }
  try {
    const h = navigator.getHistory().filter((u) => u && u !== HOME_URL);
    for (let i = h.length - 1; i >= 0 && rows.length < 22; i--) {
      push(host(h[i]) || h[i], h[i]);
    }
  } catch { /* history is best-effort */ }
  try {
    const bm = require('./downloads').loadBookmarks();
    for (let i = bm.length - 1; i >= 0 && rows.length < 22; i--) {
      push(bm[i].title || host(bm[i].url), bm[i].url);
    }
  } catch { /* bookmarks are best-effort */ }
  return rows;
}

// Paint the dashboard and make it the current history entry (so back/forward
// and /profile stay honest, and re-running /home is idempotent). Never throws.
function showHomeDashboard() {
  try { navigator.replaceCurrent(HOME_URL); } catch { /* best effort */ }
  try { ui.hideLoading(); } catch { /* best effort */ }
  try { if (typeof ui.setHomeMode === 'function') ui.setHomeMode(true); } catch { /* best effort */ }
  const rows = homeRows();
  try {
    if (typeof ui.showHome === 'function') {
      ui.showHome(rows);
      return true;
    }
    ui.setCenterContent(
      `Start — type in the bar to search, or open a row below.\n\n${rows.map((r, i) => `${i + 1}. ${r.title}`).join('\n')}`,
      rows
    );
  } catch { /* best effort */ }
  return true;
}

// Browser reset (the /home recovery path): park the whole engine. Frees the
// renderer and its RAM, drops stuck pages and the bot-wall state that came
// with them. The next navigation relaunches it automatically (init()), so a
// fresh /home on an idle app never spins Chrome up for a local dashboard.
// Reader mode + page size are ours, not the browser's, so they persist.
// Never throws — a failed park still lets the user go home.
async function resetBrowser() {
  try {
    ui.showLoading('Resetting browser', 'parking the engine…', 'Frees RAM and drops a stuck or walled page.');
    if (browser && typeof browser.close === 'function') await browser.close();
    try { ui.hideLoading(); } catch { /* best effort */ }
    return true;
  } catch (e) {
    try { ui.hideLoading(); } catch { /* best effort */ }
    ui.toast(`Browser reset failed: ${errText(e)}`);
    return false;
  }
}

// Reader vs raw extraction for the CURRENT page, re-navigating so the
// browser re-extracts with the chosen mode. Reader is the default.
function setReadMode(mode) {
  try {
    browser.readMode = mode === 'raw' ? 'raw' : 'reader';
  } catch { /* best effort */ }
  const h = navigator.getHistory();
  const url = h.length ? h[h.length - 1] : '';
  if (!url) {
    ui.toast(mode === 'raw' ? 'Reader view: raw text.' : 'Reader view: clean article.');
    return;
  }
  ui.toast(mode === 'raw' ? 'Showing full page text…' : 'Showing reader view…');
  handleNavigation(url).catch(() => {});
}

// Search fan-out: DuckDuckGo serves 10 per page, so after the first paint
// we keep fetching (page 2, 3, … then related-query variations) until the
// /links page size is reached. Plain fetch — no extra browser page, no RAM.
let fillToken = 0;
// Search AI answers: question-shaped queries get a real LLM answer
// (OpenRouter free models, standalone, no page context) painted into the
// picker's AI slot when it lands — results never wait for it. Token-guarded
// like the fan-out: any navigation invalidates in-flight answers so stale
// text can never land on a newer page. Bumped at the top of handleNavigation.
let aiAnswerToken = 0;
function startSearchAnswer(query, pageAi) {
  const mine = ++aiAnswerToken;
  try {
    const { looksLikeQuestion } = require('./ai');
    if (!looksLikeQuestion(query)) return;
    if (!ui || typeof ui.setAiAnswer !== 'function') return;
    const or = require('./openrouter');
    // The search page ALWAYS gets the bottom AI section for a question: show
    // the pending placeholder immediately, then the rich LLM answer replaces
    // it when it lands. (A page AI card no longer short-circuits the real
    // answer — the card was the "filler" the user complained about.)
    if (typeof ui.setAiAnswerPending === 'function') ui.setAiAnswerPending();
    if (!or.resolveKey()) {
      ui.setAiAnswer('Set your OpenRouter API key in /settings → AI (free key at openrouter.ai/keys) for a rich answer.');
      return;
    }
    // Free models can be slow (a full ANSWER_STYLE reply measured ~60s):
    // stream the deltas into the box so it fills live, and keep the generous
    // cap as the only hang guard. The token guard drops stale paints.
    let lastPaint = 0;
    const onDelta = (full) => {
      if (mine !== aiAnswerToken) return;
      const now = Date.now();
      if (now - lastPaint < 300) return;
      lastPaint = now;
      try { ui.setAiAnswer(full); } catch { /* best effort */ }
    };
    or.askAi(String(query), { context: '', style: or.ANSWER_STYLE, timeoutMs: or.TIMEOUT_MS, onDelta }).then((r) => {
      if (mine !== aiAnswerToken) return; // navigated away: drop stale
      if (!r) return;
      try {
        if (r.ok && r.text) ui.setAiAnswer(r.text, { model: r.model });
        else if (r.error && typeof ui.setAiAnswerError === 'function') ui.setAiAnswerError(r.error);
      } catch { /* answers never break search */ }
    }).catch(() => {});
  } catch { /* answers never break search */ }
}
function fillCurrentSearch(want) {
  const target = Math.max(1, Number(want) || config.pageSize || 50);
  // /links changes the target for this AND every later search.
  try { browser.pageSize = target; } catch { /* best effort */ }
  const query = String((browser && browser._navQuery) || '').trim();
  if (!query || !ui.isPickerOpen || !ui.isPickerOpen()) return;
  const mine = ++fillToken;
  const seen = new Set((ui.visibleRows ? ui.visibleRows() : []).map((r) => r.url));
  browser
    .fillSearch(query, { have: seen.size, want: target, seen })
    .then((r) => {
      // Stale guard: a newer search (or a manual /links change) wins.
      if (mine !== fillToken) return;
      if (!r || !r.rows || !r.rows.length) return;
      ui.appendLinks(r.rows, r.done);
    })
    .catch((e) => {
      // Never silent again (the "stuck at 10 links" class): the tail row
      // says the fill stalled, and player.log carries the reason.
      try {
        logPlayer(`FILL-FAIL ${String((e && e.message) || e).slice(0, 160)}`);
      } catch { /* logging is best-effort */ }
      try {
        if (ui && typeof ui.markFillStalled === 'function') ui.markFillStalled();
      } catch { /* never break navigation */ }
    });
}

// Every navigation commits a history entry: arrows only move the highlight,
// so Enter on a result is the single commit point and the back/forward stack
// stays meaningful.
//
// Search-engine fallback (engines.js): a search URL that answers with a bot
// challenge or a blank page is retried on the next engine (DDG -> Bing ->
// Brave) inside this one navigation. The engine that actually answers
// REPLACES the refused entry (Navigator.replaceCurrent), so back/forward
// never lands on a dead search. Non-search URLs always take exactly one
// attempt — identical to the previous behavior.
// In-app PDF viewer: download once, extract text (pdftotext) + render page
// images (pdftoppm) through src/pdf.js, then show text on the left and the
// pages as a 60/40 image pane (Tab pans, Ctrl+F zooms, /gallery grids them).
async function openPdfInApp(url, label, fresh, historyJump) {
  try {
    if (!historyJump) navigator.navigate(url);
    ui.setURL(url);
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch { /* fall back to the raw URL below */ }
    try {
      ui.showLoading('Rendering PDF', host || url.slice(0, 60), 'Text + page images in-app — no browser needed.');
    } catch { /* loader is best-effort */ }
    const res = await require('./pdf').openPdf(url).catch((e) => ({ ok: false, error: (e && e.message) || 'open failed' }));
    if (!fresh()) return null;
    if (!res || !res.ok) {
      ui.setCenterContent(`Could not open PDF: ${(res && res.error) || 'unknown error'}\n\n${petFor(moodForEvent('error'))}`, []);
      return null;
    }
    try {
      const nm = decodeURIComponent(String(url.split('/').pop() || 'document.pdf').split('?')[0]).slice(0, 80);
      navigator.setTitle(url, nm);
    } catch { /* title is best-effort */ }
    const pages = Array.isArray(res.pages) ? res.pages : [];
    const text = String(res.text || '')
      .replace(/\f/g, '\n\n─── page break ───\n\n')
      .trim();
    const note = pages.length
      ? `\n\n(${pages.length} page image${pages.length === 1 ? '' : 's'} on the right — Ctrl+F zooms a page)`
      : '\n\n(no page images could be rendered — showing text only)';
    ui.setCenterContent(text ? `${text}${note}` : `No extractable text.${note}`, []);
    if (pages.length && typeof ui.showPdfSplit === 'function') ui.showPdfSplit(pages);
    if (label) ui.setURL(label);
    return null;
  } finally {
    try { ui.hideLoading(); } catch { /* best effort */ }
    try { if (typeof ui.setHomeMode === 'function') ui.setHomeMode(false); } catch { /* best effort */ }
    armIdleTeardown();
  }
}

async function handleNavigation(rawUrl, opts) {
  // Back/forward can land on the dashboard marker: re-open it instead of
  // trying (and failing) to treat "tui:home" as a URL.
  if (String(rawUrl || '').trim() === HOME_URL) {
    showHomeDashboard();
    return null;
  }
  let url = normalizeURL(rawUrl);
  const label = opts && typeof opts.label === 'string' ? opts.label.trim().slice(0, 120) : '';
  // Back/forward already moved the history cursor (navigator.back()/forward()).
  // Pushing the target again would truncate the forward stack and turn every
  // Back into a new visit: the cursor then bounces between the last two
  // entries and Forward can never work. History jumps only paint.
  const historyJump = !!(opts && opts.history);
  if (!url) {
    ui.setCenterContent(`Invalid URL. Enter like https://github.com/sindresorhus/awesome\n\n${petFor(moodForEvent('invalid'))}`, []);
    return null;
  }
  // One physical Enter can surface twice: blessed delivers a CR as an
  // enter+return pair and the return half can trail by ~300ms. By then the
  // bar was rewritten with the URL this very navigation set, so a second
  // handleNavigation arrives for the SAME url — and racing a second goto
  // aborts BOTH loads on a cold Chrome (net::ERR_ABORTED on the first
  // search) while the navSeq bump discards the first result even if it
  // lands. Same url while the first is still in flight is that twin (or an
  // impatient double-Enter), never intent: skip it. Once the first settles
  // the same url is a normal reload again.
  if (inflightNav && inflightNav.url === url) return null;
  const navHandle = { url };
  inflightNav = navHandle;
  const releaseNav = () => { if (inflightNav === navHandle) inflightNav = null; };
  // Monotonic guard: overlapping navigations resolve out of order — only
  // the latest paints.
  const seq = ++navSeq;
  // A new navigation invalidates any in-flight search AI answer.
  aiAnswerToken++;
  const fresh = () => seq === navSeq;
  // A real navigation means the user is active: hold the idle park off.
  cancelIdleTeardown();
  // PDFs never touch the engine: text + page images render in-app (headless
  // Chrome has no PDF plugin anyway, and this saves the whole launch).
  // Ctrl+F in the split view fullscreens a page.
  try {
    if (require('./pdf').isPdfUrl(url)) {
      try {
        return await openPdfInApp(url, label, fresh, historyJump);
      } finally {
        releaseNav();
      }
    }
  } catch { /* fall through to the normal path */ }
  // Attempt chain: one engine for normal pages, the engine ladder for
  // search pages (skips engines already refused in this session).
  let chain = [url];
  try {
    if (engines.isEngineSearchUrl(url)) {
      chain = [url, ...engines.fallbacksFor(url).map((f) => f.url)];
    }
  } catch { /* single attempt */ }
  try {
    if (!historyJump) navigator.navigate(url);
    ui.setURL(url);
    // Animated loader (spinner + shimmer) instead of a frozen line, with
    // the pet still there for company once the page lands.
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch { /* fall back to the full URL below */ }
    try {
      ui.showLoading('Loading page', host || url.slice(0, 60), 'Fetching text and links — no pixels, no video bytes.');
    } catch { /* loader is best-effort */ }
    // Single-animation rule: the wave above is the ONLY loading
    // animation — no footer spinner alongside it (see HANDOVER §6.3).
    // The loader's status line already shows the destination host.
    let result = null;
    for (let i = 0; i < chain.length; i++) {
      const attemptUrl = chain[i];
      const isLast = i === chain.length - 1;
      if (i > 0) {
        // Engine switch: the refused entry gives way to the one in use.
        url = attemptUrl;
        try { navigator.replaceCurrent(attemptUrl); } catch { /* best effort */ }
        ui.setURL(attemptUrl);
        try {
          let h = '';
          try { h = new URL(attemptUrl).hostname.replace(/^www\./, ''); } catch { /* full url below */ }
          if (typeof ui.setLoadingStage === 'function') {
            ui.setLoadingStage(`Trying ${h || attemptUrl.slice(0, 40)}`, 'the previous engine refused the search');
          }
        } catch { /* loader stage is best-effort */ }
      }
      result = (await browser.navigate(attemptUrl)) || {};
      if (!fresh()) return null;
      if (result.navError) {
        // A page that never landed comes back as an Error: text result.
        // Rethrow into the catch below: it paints the honest error, names
        // an offline/slow web for the arcade note, and opens the arcade as
        // consolation — instead of dumping raw error text as a "page".
        throw new Error(String(result.text || '').replace(/^Error:\s*/, '') || 'navigation failed');
      }
      if (engines.isEngineSearchUrl(attemptUrl)) {
        const count = Array.isArray(result.results) ? result.results.length : 0;
        const text = result.searchChallenge ? result.searchChallenge.text : result.text;
        let verdict = { fallback: false, reason: '' };
        try {
          verdict = engines.judgeSearch({ blocked: !!result.searchChallenge, text, count });
        } catch { /* verdict is best-effort */ }
        if (verdict.fallback) {
          // Remember EVERY engine that refused (the last one too): the next
          // search then fails fast instead of re-walking the whole ladder.
          try {
            const eng = engines.engineForUrl(attemptUrl);
            if (eng) engines.markBlocked(eng.id);
          } catch { /* session memory is best-effort */ }
          if (!isLast) continue; // next engine, same navigation
        }
      }
      break;
    }
    // Paint owns the screen from here; the spinner's job is done.
    try {
      if (typeof ui.clearStatus === 'function') ui.clearStatus();
    } catch { /* best effort */ }
    // The loader stops here AND in the catch/finally below, so a
    // superseded or failed navigation can never leave the spinner
    // repainting over the page that replaced it.

    // setURL() first in every branch so the content/list paint below owns
    // the final focus. Results land directly in the `>` list.
    if (result.searchChallenge) {
      // Every engine in the chain refused the search (or a non-search page
      // came back as a wall). Honest message — never the challenge page.
      ui.setURL(url);
      ui.setCenterContent(
        `The search engines are blocking automated searches right now (bot check).\n\nTry again in a moment, or open the site in your regular browser.\n\n${petFor(moodForEvent('blocked'))}`,
        []
      );
    } else if (result.captcha) {
      ui.setURL(url);
      ui.showCaptcha(`${result.captcha}\n\n${petFor(moodForEvent('captcha'))}`);
      ui.redirectToBrowser(url);
    } else if (typeof result.blocked === 'string' && result.blocked.trim()) {
      // Bot-wall (e.g. Google's JS check): message only, no auto-open.
      // STRING only: a truthy non-string here once painted "[object
      // Object]" and ate every page load, so the check stays strict.
      const msg = `${result.blocked}\n\n${petFor(moodForEvent('blocked'))}`;
      ui.setURL(url);
      ui.setCenterContent(msg, []);
      // Same consolation as the captcha wall: the arcade under the bad
      // news. The blocked text is the game header, so Esc brings it back.
      try {
        if (typeof ui.showGame === 'function') {
          ui.showGame({ head: msg, note: 'A bot-wall blocks the page — arcade while it cools down.' });
        }
      } catch { /* arcade is best-effort */ }
    } else if (result.results) {
      ui.setURL(url);
      ui.showLinkPicker(result.results, result.ai || null, result.summary || null);
      // Blocked badge reflects THIS page's refused requests (fonts, media,
      // trackers) - the honest count, not a guess.
      if (result.net && typeof ui.setBlockedCount === 'function') ui.setBlockedCount(result.net.page, result.net.total);
      // DDG gives 10 per page; fill up to /links size in the background so
      // the list grows under the cursor without a reload. DDG-only: the
      // fan-out parses DDG's HTML (mixing Bing/Brave rows in would be
      // wrong, and their pagination is not wired here).
      try {
        if ((engines.engineForUrl(url) || {}).id === 'duckduckgo') fillCurrentSearch(config.pageSize);
      } catch { /* fill is best-effort */ }
      // Question-shaped queries get a real answer in the AI slot (async).
      startSearchAnswer(result.searchQuery, result.ai);
    } else {
      ui.setURL(url);
      ui.setCenterContent(result.text, result.links || [], result.spans, result.media, result.ai || null, result.summary || null, result.pretty || null, result);
    }
    // Search text outlives the navigation: the bar keeps the query so
    // refining it is one edit, not a retype. (History/reload/currentUrl
    // still use the real URL from the navigator.)
    if (label) ui.setURL(label);
    // ★ footer marker: is the page we just landed on already bookmarked?
    try {
      if (typeof ui.setBookmarked === 'function') ui.setBookmarked(isBookmarked(url));
    } catch { /* marker is best-effort */ }
    // Remember this page's title so /history lists titles, not raw URLs.
    try {
      const t = (result && result.title) || (result && result.reader && result.reader.title) || '';
      if (t) navigator.setTitle(url, t);
    } catch { /* titles are best-effort */ }
  } catch (err) {
    try {
      if (typeof ui.clearStatus === 'function') ui.clearStatus();
    } catch { /* best effort */ }
    const msg = `Error: ${errText(err)}\n\n${petFor(moodForEvent('error'))}`;
    ui.setCenterContent(msg, []);
    // No internet or a dead-slow timeout gets the offline arcade as a
    // consolation: the error text stays as the game's header, so Esc
    // restores it and nothing about the failure is hidden.
    try {
      const { offlineKind } = require('./piano');
      const kind = offlineKind(errText(err));
      if (kind && typeof ui.showGame === 'function') {
        ui.showGame({
          head: msg,
          note: kind === 'offline'
            ? 'No internet — the arcade works offline. Esc returns to the error.'
            : 'The web is too slow right now — arcade until it recovers.',
        });
      }
    } catch { /* arcade is best-effort */ }
  } finally {
    // Single owner for the loader: it stops on success, on failure and on
    // a superseded navigation. Nothing can outlive its request.
    try { ui.hideLoading(); } catch { /* best effort */ }
    // Any real navigation leaves the home dashboard: the footer hint row
    // belongs to the dashboard only (showHomeDashboard turns it back on).
    try {
      if (typeof ui.setHomeMode === 'function') ui.setHomeMode(false);
    } catch { /* footer is best-effort */ }
    // Re-arm the opt-in idle park for the next quiet period (no-op when
    // config.idleTeardownMin is 0).
    armIdleTeardown();
    // This navigation no longer blocks a same-url retry (reload).
    releaseNav();
  }
}

const ui = createUI(
  screen,
  {
    onOmniSubmit: (value, row) => {
      // A submit means navigation/command owns the screen: abort any
      // in-flight web-suggest so a late response cannot snap the cursor
      // back to 0 after Enter (P2).
      try { if (suggestCtl) { suggestCtl.abort(); suggestCtl = null; } } catch { /* best effort */ }
      routeInput(value, row);
    },
  onSuggest: (text, id) => {
    const v = String(text || '');
    // Empty bar: blank body, no network call, no history dump.
    if (!v.trim()) {
      ui.renderSuggestRows([], id);
      return;
    }
    // Slash commands complete locally — never reach web search.
    if (v.trim().startsWith('/')) {
      ui.renderSuggestRows(getCommandSuggestions(v), id);
      return;
    }
    // Phase 1: instant local rows (history/direct URL) — typing feedback
    // never waits on the network.
    ui.renderSuggestRows(getLocalSuggestions(text, navigator.getHistory()), id);
    // Phase 2: abort the previous keystroke's fetch, merge web results.
    if (suggestCtl) suggestCtl.abort();
    suggestCtl = new AbortController();
    const ctl = suggestCtl;
    getSuggestions(text, navigator.getHistory(), undefined, { signal: ctl.signal })
      .then((rows) => {
        if (suggestCtl === ctl) ui.renderSuggestRows(rows, id);
      })
      .catch(() => {
        if (suggestCtl === ctl) ui.renderSuggestRows([], id);
      });
  },
    // Direct media / streams play in mpv fullscreen (never a full browser)
    // instead of navigating — a text extractor can do nothing with them.
    // YouTube links shortcut through the fast path above (play / /yt
    // search); everything else navigates as before.
    onLinkPick: (url) => {
      // Non-web schemes (mailto:, tel:) open in the system handler —
      // email and phone links now work instead of erroring.
      try {
        if (openExternal(url)) return;
      } catch { /* fall through */ }
      // YouTube shortcut: watch/shorts/embed/music/playlist URLs play in
      // mpv at once, /results URLs run a /yt search — never a slow scrape.
      try {
        if (routeYouTubeUrl(url)) return;
      } catch { /* fall through to navigation */ }
      try {
        if (/\.(mp4|webm|mov|m4v|mkv|avi|m3u8|mpd)(\?|#|$)/i.test(new URL(String(url)).pathname + new URL(String(url)).search)) {
          playVideo(url);
          return;
        }
      } catch { /* fall through to navigation */ }
      handleNavigation(url).catch((err) => ui.setCenterContent(`Error: ${errText(err)}`, []));
    },
    onPlayVideo: (url, queue, title) => {
      const r = playVideo(url, { quality: config.quality, queue, title });
      // Keep the picker mounted on success (mpv covers fullscreen); only
      // failures paint (playVideo already paints + logs the fallback).
      return r;
    },
    // /queue picker rows: play the chosen item now (single player).
    onPlayQueue: (url) => playFromQueue(url),
    onQualityCycle: () => {
      try {
        const { cycleQuality, describeQuality } = require('./quality');
        config.quality = cycleQuality(config.quality);
        saveConfig(config);
        ui.setURL(`Quality: ${describeQuality(config.quality)} — /quality sets`);
        return config.quality;
      } catch {
        return null;
      }
    },
    onHistoryBack: () => {
      const url = navigator.back();
      if (url) handleNavigation(url, { history: true });
    },
    onHistoryForward: () => {
      const url = navigator.forward();
      if (url) handleNavigation(url, { history: true });
    },
    onEscape: () => ui.resetFocus(),
    onQuit: () => requestQuit(),
    // /themes applies live: persist whatever is highlighted, no confirm.
    onThemeChange: (name) => {
      config.theme = name;
      saveConfig(config);
    },
  },
  { theme: config.theme, pageSize: config.pageSize }
);

process.on('uncaughtException', (err) => {
  try {
    screen.destroy();
  } catch {}
  // eslint-disable-next-line no-console
  console.error(err);
  browser.close().catch(() => {}).finally(() => process.exit(1));
});

// Initial paint + focus. Render synchronously so a bad widget
// fails here with a useful stack instead of inside a timer.
screen.render();

// Warm the live pet pools in the background (no-op under TUI_TEST).
primePets();

// Adopt a player that outlived the last app run (fixed IPC socket probe):
// Enter then QUEUES into it instead of spawning a second mpv window.
adoptRunningPlayer().catch(() => {});

// Opt-in session restore: reopen the page from the last quit (written by
// shutdown() only while config.restoreSession is on). A fresh profile or
// an off setting boots to the dashboard exactly as before.
try {
  const last = restoreSessionUrl();
  if (last) handleNavigation(last).catch(() => {});
} catch { /* boot is best-effort */ }

// Test seam: exposes orchestration without affecting the prod path.
if (process.env.TUI_TEST) {
  module.exports = { handleNavigation, routeInput, routeYouTubeUrl, navigator, browser, ui, screen, shutdown, playVideo, openExternal, searchURL, normalizeURL, mpvNext, mpvStop, mpvQuery, adoptRunningPlayer, getQueue: () => { try { return [...lastQueue]; } catch { return []; } }, getResolvePromise: () => pendingResolve };
}
