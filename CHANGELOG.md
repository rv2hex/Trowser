# Changes — TUI YouTube + slash audit

## 2026-10-22 gallery shows real images only on graphics terminals

**What changed (user: "remove the ascii from the gallery … we will just use
plain old images, unless a system can't render an image")**

* **ASCII is now a no-graphics fallback, not a placeholder layer.** On
  Kitty/iTerm2 the `/gallery` grid paints its frames once and goes straight
  to real thumbnails; it never calls `getImageAscii` and never repaints the
  text body when art would have arrived. Plain terminals keep the existing
  ASCII grid, still through the shared two-slot queue.
* **Fixed the ASCII → image flicker/wipe.** The old second `draw(arts)` ran
  `scrollBodyTo()`, which calls `tryClearImages()` and deleted photos that
  had already been emitted; the per-generation emitted-set then suppressed
  their re-emission. With the ASCII pass gone on graphics terminals there is
  one text paint and one graphics pass per grid paint.
* **Failed photos never fall back to ASCII on a graphics terminal.** The
  60/40 pane, fullscreen view, and video poster now show a plain
  `Image could not be loaded` / `Poster unavailable` line instead. ASCII art
  remains for terminals with no image protocol (and for the article hero).
* Removed the URL-keyed "already emitted" set that was only needed for the
  double paint; visible cells are queued once per generation.
* **Tests:** 760/760, 181 suites, 0 failures. Added coverage for zero ASCII
  fetches on Kitty, plain-terminal ASCII fallback, and the pane's plain
  failure line. Practical checks: `keytest.py` 13/13 keys; live PTY probe on
  fake-Kitty TERM navigated to Wikipedia Cat → `/gallery` emitted 529 Kitty
  chunks with no ASCII, arrows/Enter/Ctrl+F/Esc worked, 0 Chrome strays.

## 2026-10-21 reading stays cold, gallery gets a real layout

**What changed (user: "freeze the page", "make /gallery a grid with alt as the
name", "save memory on images")**

* **Plan A — freeze page JS after extraction.** Once the article, media, AI
  answer and YouTube rail are in hand, the live page has no more work to do.
  `Browser.navigate` now disables scripts through CDP
  (`Emulation.setScriptExecutionDisabled`) and thaws them before the next
  `goto`. Best-effort by design: no-op without CDP (Firefox/WebKit/fakes),
  never freezes a failed navigation, and a recreated page starts unfrozen.
  `page.evaluate` keeps working while frozen, so search/related extraction
  needs no carve-out. Measured on BBC News (8 s idle): renderer
  `ScriptDuration` **0.124 s → 0**, `TaskDuration` **0.240 s → 0.014 s**
  (−94 %), DOM query still returned 158 links, JS heap unchanged (freeze is
  CPU, not GC). Live 6-site hop: chrome flat at **9**, one reused page, RSS
  plateau, back/back/forward intact, zero strays. Regression tests pin
  freeze-once, thaw→freeze, no freeze on `navError`, unfrozen recreation.
* **`/gallery` is now an aspect-aware flex table.** Cells are sized from each
  photo's real dimensions (captured during extraction as `w`/`h`): a
  landscape shot spans more columns, a portrait keeps a narrow column and
  uses the full band height. Rows pack left→right; full rows share the
  leftover columns **proportionally** (equal shares flattened every box to
  the same width), and a row that overflows by ≤12 % shrinks instead of
  wrapping into banner-wide boxes. Each photo sits in a rounded frame with
  `alt` text, then the URL filename, then `image N` in the top border;
  ASCII art and graphics are centred both ways. Live Wikipedia Cat (30
  photos, aspects 0.66–2.38): 13–27-column boxes, 6 per band; BBC News: 5
  per band. Arrow keys now move by band and pick the horizontally nearest
  cell; the scroll window follows the cursor. ASCII cache keys include
  width **and** height, and graphics anchors derive from the band geometry
  (no hardcoded `ch`).
* **Image memory is budgeted, not guessed.** The original-bytes cache was
  "20 entries" (up to 30 MB); it is now an LRU capped at **12 MB / 48
  entries**, and a second **8 MB / 96-entry** cache stores the already
  resized display PNG per target box so repaints and fullscreen never
  re-decode through sharp. Display PNGs are sized to the box being drawn
  (~14×28 px cells, 800×600 cap) instead of always 800×600. `cache:true`
  fetches also dedupe in flight, so the ASCII and graphics queues share one
  socket and one buffer per URL instead of downloading twice. Originals
  larger than the whole budget are used but not pinned.
* **Fixed — slash commands were rewritten by the palette.** With the command
  palette open (waiting a beat after typing), Enter accepted the highlighted
  row title, so `/gallery` became `/gallery (list page images…)` and ran an
  image search; `/vid` → highlighted `/videos` still completes (bare `/` +
  arrows unchanged). The command and its args now always win.
* **Fixed — toasts were invisible off-home.** `layoutBody()` called
  `updateHint()` before the toast timer existed, so the footer was hidden
  again and the message went into a hidden bar. `/gallery` on a page with no
  images looked like a no-op; `/img 99`, `/download` and the rest had the
  same silent failure. The toast now claims the footer before layout, and
  the typed command leaves the omnibox even when the command moves focus.
* **regression tests**: freeze/thaw, bounded caches + in-flight dedupe,
  palette-vs-command routing, toast visibility (checks `hidden`, not just
  widget text). Suite **757/757, 180 suites**.

## 2026-10-20 tester twin: site-to-site hops + the history stack

**What changed (user: "make sure the browser is optimised to open one after
another website")** — drove the real TUI in a PTY like a user: typed bare URLs,
hopped 10 sites back-to-back, jumped ~35 slash commands between pages, and
re-typed a new URL while the previous page was still loading.

* **hop measured (no leaks)**: chrome process count flat at **9** for all 10
  hops (72 total spawned once), group RSS **73 → 288 MB and plateaued**
  (nav 9→10 added 1 MB), zero strays after teardown. Warm `navigate()` is
  **0.9–4.0 s** (goto dominates; extraction ≤ 150 ms); one browser and one
  reused page — nothing relaunches per hop. Impatient 3-URL burst landed on
  the last URL with history intact and no aborted error.
* **fixed — layout wrappers were stripped as "junk"** (MDN painted the title +
  `(no content)`). The banner/sidebar filter matched MDN's
  `.layout__2-sidebars-inline`, which wraps the whole `<main>`. A node that
  still holds `<main>`/`[role=main]`, or most of the page's text (60% guard),
  is layout, not a cookie banner. MDN **12 → 4 016 chars** of real article
  (links unchanged).
* **fixed — front pages collapsed to one teaser** (BBC News painted 208 chars
  of a single story). The candidate scorer only counted `<p>` text, so a
  link-heavy front page with headlines in headings/links lost to one story
  div. It now falls back to subtree text, and a `<main>`/`[role=main]` that is
  much bigger than the winner takes over. BBC **208 → 5 861 chars** of
  headlines (MDN/GitHub/Wikipedia/HN unchanged).
* **fixed — Back/Forward corrupted history** (found while hopping). Every
  history jump called `navigator.navigate()` again, truncating the forward
  stack and pushing a new entry: after one Back the cursor bounced between the
  last two entries and Forward was dead. History jumps now only move the
  cursor (`handleNavigation(url, { history: true })`).
* **fixed — reload / currentUrl used the stack tail**, not the cursor: after a
  Back, `/bookmark`, `/download`, `/share` and reload targeted the forward-most
  page. New `Navigator.currentUrl()`; reload is a true reload (no new entry).
* **regression tests**: the handler test now walks back/back/forward across
  three entries and asserts the stack is unchanged; a unit test pins
  `currentUrl()` cursor semantics. Suite **752/752**.

## 2026-10-20 /quality 1080p played as 360p — sequential client ladder + JS solver

**What changed (user: "ok now plan solving the video quility issue" → "go")** —
the six-client resolver was the problem, not the format selector:

* **root cause**: every play fired six yt-dlp extractions in PARALLEL. YouTube
  rate-limited the rich clients (HTTP 429) and only `android` answered — and
  android can only serve the progressive 360p itag 18. `RESOLVE-OK quality=1080
  got=360p client=android` twice in the real player log.
* **JS runtime + EJS solver**: resolve attempts now pass
  `--js-runtimes node --remote-components ejs:github` (the app already runs on
  node; the solver is fetched once and cached in
  `~/.cache/yt-dlp/challenge-solver`). Without them yt-dlp cannot solve
  YouTube's signature/n challenges and reports "some formats may be missing".
  Older yt-dlp builds are detected (`unrecognized arguments` / `no such
  option`), and the same client is retried once without the flags.
* **sequential ladder with early stop**: sticky winner (10 min, never android)
  → `default` → `tv` → `web` → `ios` → `mweb` → `android` last. Stops on an
  exact cap hit, a 1080p+ `best`, a bounded attempt count, or after default was
  cross-checked once. No playable URL yet? Keep walking to android.
* **429 handling**: short backoff between throttled attempts; if android's
  360p wins anyway, retry `default` once before accepting it. A below-request
  play now flashes "YouTube throttled high-res — playing Np · /play retries"
  instead of silently serving the consolation stream.
* **honest diagnostics**: `RESOLVE-OK … attempts=N throttled=M`, `RESOLVE-TRY`,
  `RESOLVE-RETRY`, `RESOLVE-FAIL`; a newer play supersedes an older in-flight
  resolve (`playSeq`, no stale mpv after a quick re-pick).
* **queue parity**: `mpvQueueArgs` forwards the same JS runtime/solver raw
  options; mpv's ytdl hook probe confirms yt-dlp receives them.
* **budget**: 12 s per client, 25 s per resolve (the old parallel worst case
  was 20 s; a dead network still lands on the honest error card).
* **tests**: pure helpers (`clientLadder`, `isRateLimited`, `parseResolveOutput`,
  `pickBetter`, `shouldStop`, `wantsPrimaryRetry`, `resolveArgs`) pinned in
  test-unit; test-index covers one-call early stop, 429 → tv 1080p, and the
  android-360 + default-retry + throttled-toast path. Full suite **751/751**.

**Live evidence**: 5/5 real `playVideo` runs resolved `got=1080p client=default
attempts=1 throttled=0` (itags 399/699); `/quality best` on a 4K video resolved
2160p first try; mpv hook trace shows
`yt-dlp … --remote-components ejs:github --js-runtimes node …`.

## 2026-10-17 /game v2: falling balls, ten real songs, random mode, game-over screen

**What changed (user: "u create a piano game where user plays magic tiles like
piano game with ASDF JKL; keys" → then "there is a box messed up in the /game
near the heart" + "also can u make the music select random?" → "remove the
/game random it should be random by default")** — the piano
cabinet was rebuilt around real rhythm-game bones:

* **falling balls, not waiting tiles**: one ball per note drops down its lane;
  tap the lane key while it waits on the key row — Perfect (100) / Great (60) /
  Good (30) on a fixed window, stray or early presses are free and silent;
  unhit balls crash into the bottom border (soft thud), 3 crashes end the run;
* **game-over screen**: the field itself becomes the score card — GAME OVER,
  final score, grade counts, `r`/Enter restarts (`r` works anytime);
* **ten songs, real music** (8-bit adaptations on the 8 keys): 1 Prelude in C,
  2 Ode to Joy, 3 Für Elise, 4 Tetris (Korobeiniki), 5 Moonlight Sonata,
  6 Twinkle Twinkle, 7 Jingle Bells, 8 Rush E, 9 Megalovania, 10 Mario
  Overworld — five new (1/4/5/9/10), the last three at double tempo; digits
  `1`-`9` pick and `0` is the tenth;
* **random by default**: a plain `/game` rolls straight into a random song
  (the offline consolation too), and every restart rolls another — never the
  same twice in a row; `*` toggles the mode off, a digit pick takes over and
  locks that song; a parked run resumes untouched;
* **per-hit sound**: every judged or free-play press plays a synthesized note
  (WAV cache, `paplay → aplay → ffplay → mpv → silent` chain), `m` mutes,
  misses thud; TUI_TEST silences everything;
* **free play** (`p`) — every key is its note, nothing falls, nothing judged;
  **square box** on big terminals (side ≥ 22 → square, rectangle fallback on
  short screens), a resize keeps the run;
* **heart fix**: the stats row's right border jutted three cells in — ♥
  measured 2 cells wide, terminals draw it in 1; `isWideChar` keeps
  U+2600–U+26FF narrow (blessed parity), pinned by tests (every painted row
  reaches the same border column + cell-count pins);
* **offline honesty**: a navigation that never landed used to paint raw
  Playwright text ("…waiting until domcontentloaded") as if it were the page.
  `browser.navigate` now marks failed loads (`navError = true`) and index.js
  routes them through the offline/slow classifier: the honest error stays as
  the arcade header, the note says "No internet — the arcade works offline.
  Esc returns to the error." and the piano opens as consolation — and a late
  failure can never repaint over an already-open game. A goto that timed out
  waiting for domcontentloaded reads as offline (the document never
  arrived); plain timeouts keep the "slow" mood.

**Tests:** suite green — **743/743** (`test-piano` ×17, `test-index` walks a
failed load end-to-end: honest card + offline note + arcade head; `test-launch`
pins the `navError` marks), `keytest` 13/13, no stray chrome or player
processes.

## 2026-10-17 /game is now the piano: magic tiles on A S D F J K L ;

**What changed (user: "u create a piano game where user plays magic tiles like
piano game with ASDF JKL; keys")** — the offline arcade is now a magic-tiles
cabinet, and since `/game` and the offline consolation are one code path, both
switched at once:
* new pure engine `src/piano.js` — 8 lanes on `a s d f j k l ;`, tiles fall
  from the top, tap the lane key while a tile waits on the bottom key row
  (fixed ~0.6 s window, so falling speed never eats reaction time); stray or
  early presses are free, a miss costs one of 3 lives, score `/streak/level`
  (every 12 hits: faster fall + denser spawns; mirrored chords from level 5);
  `r` — or Enter from the game-over screen — restarts; a resize keeps
  score/level/lives/game-over, only the falling board starts clean;
* the space shooter (`src/minigame.js`) is **gone**: `offlineKind()` moved
  into `src/piano.js`, `/bench` now sims `tiles sim 500 ticks`, `src/pong.js`
  lost its shooter reference, and the shooter's tests were replaced by
  `tests/test-piano.js` (+ moved offline-kind cases);
* UI: `showGame({})` — offline, dead-slow, bot-wall and captcha paths — and
  `/game`, `/arcade`, plus new aliases `/piano` and `/tiles` all open the
  tiles cabinet; lane keys stay inside the modal (hit() is the only judge),
  any non-lane printable still escapes into a fresh search, Esc restores the
  page/error beneath byte-identical;
* UI tests: `/game` opens the piano (title, stats, lane keys, restart), the
  no-kind `showGame` call is pinned as the offline consolation.

**Tests:** suite green — **722/722** (`tests/test-piano.js` ×14 new).

## 2026-10-14 Rainbow glow mode (fun)

**What changed (user: "just for fun can u add a glowing mode? where the theme is
cycling through rainbow colors all of it even the borders")** — a **Glow mode**
toggle in `/settings → Appearance`:
* the whole app — edges/borders, header, separators, bar, body, panes — cycles
  through the spectrum (~8 fps), driven by mutating the live theme object and
  repainting the chrome, so lists and boxes glow too;
* arrows/Enter toggle it; it persists (`config.glow`) and restores when the hub
  opens; shutdown clears it.
`applyThemeChrome()` was extracted from `applyTheme()` so the glow and normal
themes share one paint path.

**Tests:** suite stays green. **543/543**, `keytest` 13/13, chrome strays 0.

## 2026-10-14 Theme preview: see it on arrows, Enter locks, Esc reverts

**What changed (user: "left right arrow key i get the preview of the color if i
dont hit enter, the theme back to the old one and enter to lock i need to seeee
what i m enter")** — the Theme row in `/settings` now:
* **←/→ previews the colours LIVE** — `ui.applyTheme(name)` applies the look
  instantly (no save), so you see exactly what you're choosing;
* the row shows the **previewed** name while arrowing;
* **Enter LOCKS it** — persists to config.json + confirms "Theme locked: …";
* **Esc (or leaving without Enter) reverts** to the previously locked theme —
  nothing is saved unless you commit.
Verified: `white →(→) matrix` (applied, not saved) `→(Enter) matrix` (saved);
`→(→) synthwave84 →(Esc) white` (reverted).

**Tests:** the theme test now asserts preview-doesn't-save + Enter-locks.
**543/543 green**, `keytest` 13/13, chrome strays 0.

## 2026-10-14 /settings is the only settings command; values live + Enter locks

**`/commands` now lists browsing tools only.** Removed from the visible
catalog (help + `/` palette): `read`, `gemini-key` — joining the earlier
`themes`, `quality`, `vo`, `links`. Everything settable lives in `/settings`:
* **Appearance** — Theme (←/→ cycles all 75 looks)
* **Video** — Quality, Video output, Quit-with-video
* **Browsing** — Links per page, Idle teardown, **Reader mode** (new)
* **AI** — Gemini API key (edit form, censored)
* **Personal details** — Name, Email, Number, Date of birth, Password
The old handlers stay routable but invisible; typing a retired one says
"moved into /settings" and opens the hub.

**Settings rows now show the CURRENT value and lock on Enter.** Previously
`value` was captured once at build time, so the row never updated. Now
`value` is a live function; **←/→ previews** (mutates config, no apply) and
**Enter locks** (applies + persists + confirms "Theme locked: matrix").
Verified: theme row white→matrix on →, saved only after Enter; Reader mode
reader→raw on →, locked on Enter.

**Tests:** `test-fixes` retired list +read/gemini-key; `keytest` K6 re-pointed
at preview+lock. **543/543 green**, `keytest` 13/13, chrome strays 0.

## 2026-10-14 /settings owns everything; input-lock fixes; download fixes

**Input dies after `/settings → Theme → Esc` (root cause: stale panel + stolen focus).**
* `setFocus(mode)` now clears `settingsState` whenever focus leaves settings — a
  ghost panel can never swallow keys again.
* The settings key branch only acts when the panel is really open; typing or
  `/` returns to browsing instead of a dead end.
* `closeThemes()` used to call `showText()`, which internally re-focused
  `content` — so closing the theme picker silently abandoned the settings
  panel. Fixed.
* `/pets` (and any `showInfo` view) now snapshots the view underneath, so Esc
  returns to it instead of a blank page.

**`/themes` is gone — `/settings` owns themes, video quality, video output,
links per page.**
* Theme row **cycles live with ←/→** (75 looks, persisted) — no picker
  command. A **Gemini API key** row (edit form, censored) is in the AI section.
* `/themes`, `/quality`, `/vo`, `/links` are removed from the catalog (help +
  palette); typing one says "moved into /settings" and opens the hub.
* `accounts.js` gained `dob`, `validDob`, `updateAccount()`; `/settings`
  Personal details edits Name/Number/DOB/Password.

**Boxes & gallery.**
* Fixed the broken box geometry (top border was 2 cells short) and used a
  width-safe `>` cursor.
* **The gallery no longer disappears when you type `/download`** — a
  `mediaSnapshot` (gallery/theater + cursor) is taken before a command-driven
  view opens and restored when the command didn't paint a new page. Verified:
  image stays on screen across `/download`, `/bookmark`, `/copy`, `/pets`.

**Download fix.** `/download` now sends the page URL as `Referer` — hotlink
CDNs (e.g. Pinterest's `i.pinimg.com`) answer `403` without it (reproduced).

**Tests:** +5 (theme cycling, no ghost panel, keys live after `/pets`,
gallery survives `/download`, `/themes` redirect). **543/543 green**,
`keytest` 13/13 (K5/K6 re-pointed at /settings), chrome strays 0.

## 2026-10-14 /settings hub, DOB, header spacing, tracker badge

* **`/settings` (new, the one door for small settings)** — an interactive
  panel with **soft-corner boxed sections**, live values, ←/→ (or Enter) to
  change:
  * **Appearance** — Theme (Enter opens the live 75-theme picker)
  * **Video** — Quality, Video output, Quit-with-video behaviour
  * **Browsing** — Links per page, Idle teardown
  * **AI** — Gemini key status
  * **Personal details** — Name, Email, Number, **Date of birth**, Password
    (Enter edits via the form wizard; stored in the 0600 vault, password
    re-hashed with a fresh salt)
* **Retired from the command list:** `/quality`, `/vo`, `/links` (now
  settings-only; the handlers remain for compatibility) — `/themes` stays
  reachable and also lives in settings. Palette/help/shortcuts updated in
  lockstep. **F2 stays unbound** (laptop function-key rows own it).
* **`accounts.js`** — `dob` field (YYYY-MM-DD validated), `updateAccount()`
  for profile edits, `publicProfile()` now carries `dob`.
* **Header spacing** — the identity pill no longer touches the right border:
  `  · name <email>  ` (insets + separator) instead of text glued to the
  corner.
* **Tracker shield** — always bottom-right (`⛨ N`), glows on each block.

**Tests:** palette/help/link-sweep assertions updated for the retirement;
**538/538 green**. Live PTY check: `/settings` paints all sections with
`╭─ … ╮` boxes and a `▶` cursor row.

## 2026-10-14 UX round: page restore, /bookmark, queue titles, shield badge, quit prompt

**What changed (user reports, in order)**
* **`/bookmark` blanked the page** — real root cause found: overlay views
  (`/bookmarks`, `/history` pickers, the gallery pane, the theater rail) set
  `lastPretty = null`, so Esc had nothing to restore. New **content snapshot**
  (`snapshotContentView` / `restoreContentView` in `ui.js`) captures the page
  (or the list) before an overlay opens and restores it on Esc — verified
  live: page → `/bookmark` → `/bookmarks` → Esc returns to the article.
* **`/bookmark` (new command)** saves the current page and writes
  **"Webpage added to bookmarks"** to the footer for ~4 s (`toast(..., 4000)`
  now actually forwards its duration — the helper dropped it). A **★** shows
  in the footer while the current page is bookmarked. `/bookmarks` (list) now
  shows titles, opened as an **overlay** with a heading.
* **Queue** — entries are now `{url, title}` end to end (`playableQueue` →
  `uniqueQueueUrls`/`enqueueBatch` → `lastQueue`/`getQueue`). `/queue` lists
  **titles** (▶ NOW marker), empty says **"No videos queued yet."**, and it is
  an **overlay picker**: **Enter plays that item now** (`playFromQueue` →
  mpv `playlist-play-index`, single player — the current stream is swapped,
  never two videos at once). Pressing Enter while a video plays now flashes
  **"Added to queue: <title>"** and never shows the yt-dlp loading state.
* **Tracker shield badge** — always visible bottom-right (`⛨ N`, session
  total), **glows** (accent + bold) for ~1.6 s whenever a request is refused,
  then settles. The old hint-bar badge is gone (the shield owns it).
* **Quit with a video playing** — Ctrl+Q / `/quit` now prompts: keep playing
  / stop it / keep **always** / stop **always** (`config.quitPlayer` =
  `ask|keep|stop`, changeable later in /settings).
* **Session scope** — browsing history is **wiped on quit**
  (`Navigator.clearHistory()`); login stays in-memory; **bookmarks persist**
  (own store, untouched by quit/logout).
* **`/gemini` on a page** with no question now **summarizes the page**
  (previously it printed a usage line).
* **`/find`** reports **"Found N matches … · N/M lines"** in the footer.
* **Human wording** — loader/status say "Finding the best stream…",
  "Preparing 480p video…"; the player-failure screen no longer prints the raw
  stream URL or `/open <url>`.
* **F2 removed** (laptop function-key rows own it; the theme picker will live
  in /settings). **`showChoice`** modal added (numbered options + Esc) for the
  quit prompt.
* **Link sweep**: `/copy` → "Copied link: <domain>", `/download list` →
  filename + size only.

**Tests:** updated the intentional-churn assertions (queue shape, gemini
wording, resolve status); **538/538 green**, `keytest` 13/13. Note: keytest's
system-wide chrome count now reports the user's own `npm run start` session as
"strays" — not a leak (verified via /proc ancestry).

## 2026-10-14 User-centric overhaul: resilient search, in-app Home, context commands

**What changed (user: "/home sends the user to DuckDuckGo where they get an
unsupported browser … commands require the user to put in a link — too much
hassle, make them work on what the user is viewing … /download must download
the current image to Downloads … remove what is hard to use … remove dead
code, lighten the browser")**

* **Search never dead-ends (new `src/engines.js`).** DDG stays the primary
  engine; a search page that answers with a bot challenge or a blank page
  transparently retries on **Bing**, then **Brave**, in the same navigation.
  The engine that actually answered **replaces** the refused history entry
  (`Navigator.replaceCurrent`), so back/forward never lands on a dead search.
  Engines refused this session are skipped by later searches, and when the
  whole chain is refused the user gets one honest message — never a wall.
  `browser.js` gained the challenge fingerprint (the wording DDG/Bing/Brave
  serve to automated traffic), Bing/Brave result selectors, and `links.js`
  now **unwraps Bing `/ck/a?u=a1<base64>` redirects** to real URLs.
  Verified live: Bing → 11 rows, Brave → 19 rows, real destinations.
* **`/home` opens an in-app start dashboard** (still preceded by the browser
  reset): pinned quick links + recent history + bookmarks, rendered by the
  TUI itself. No network, so it can never show a bot wall or an
  "unsupported browser" page again. It is now the current history entry.
* **Context-first commands** — no link typing for the common case:
  * `/download` (no arg) saves **the image on screen** (gallery / inline
    art) — else the highlighted row — **to ~/Downloads**; `/download <n>`,
    `/download <url>` and `/download list` are unchanged.
    New `ui.currentImageUrl()` accessor.
  * `/open` (no arg) opens the **highlighted row**, else the current page;
    `/open <url-or-search>` unchanged.
  * `/copy` (no arg) now copies the **current page URL** when nothing is
    highlighted (previously it just failed on articles).
* **Command tiering** — `/help` shows the everyday list; the new Advanced
  tier (`/vo`, `/cookies`) is revealed by **`/help all`**. Routing and the
  `/`-palette are unchanged for power users.
* **Dead code removed**: `image.js` (`showImageAuto`, `clearImageCache`,
  plus dead exports), `ui.js` (`loaderFrameThemed`, `WAVE_RAMP` export,
  unused `bestImageMode` import), `pretty.js` (`preload` no-op), unused
  imports in `browser.js`/`config.js`/`suggest.js`.
* **Resource saving (opt-in)**: `idleTeardownMin` in `config.json` parks the
  Chrome engine after N idle minutes (0 = off) and relaunches it on the next
  navigation (~300 MB released on this 7.6 GB box). `player.log` now rolls
  over at 2 MB to a single `.1` file instead of growing without bound.

**Tests:** new `tests/test-engines.js` (14) + `tests/test-round7.js` (20) —
ladder order, block memory, challenge wording, blank-vs-text fallbacks,
context commands, dashboard UI, `replaceCurrent`, config clamp, Bing unwrap.
`scripts/e2e_journey.py` gained `/home` (E8b) and `/help all` (E8c) checks;
`scripts/keylog_probe.js` expectations updated for the new context messages.
**533/533 green**, `npm run keytest` 13/13, strays NONE.

## 2026-10-14 The AI answer moved to the bottom box (real LLM, 5 lines, Alt+Up full)

**What changed (user: "i still see the ai summary box … move that AI answer
to bottom to ai summary … 5 lines max … ALT+up to get the full real llm")**
— the real LLM answer no longer renders as a top-of-list header; it now
lives in the **bottom AI box**, replacing the old extractive "AI summary":
* box title is **"AI answer by <Model>"** (e.g. "AI answer by Gemini 2.5
  Flash") via `gemini.modelLabel()` — the model that actually answered
  (fallback model included), passed through `askGemini`'s result;
* **5 answer lines max** (`AI_ANSWER_LINES`, `AI_BAR_H = 8`);
* **Alt+Up** shows the same answer fullscreen ("AI answer by … — FULL
  RESPONSE"), Alt+Down / Esc collapse;
* the **extractive digest is gone from every surface** — no key (or a
  non-question) shows the box text **"Set /gemini-key for a real answer —
  free key at aistudio.google.com/apikey"**; thinking/errors share the box;
* one display source (`lastAi`) drives both the box and the fullscreen, so
  they can never disagree; a token cancels in-flight replies on collapse.

**Tests:** updated + added (bottom-box render + model title + line cap +
Alt+Up full + key-hint text; `modelLabel`), and every Alt+Up-on-article test
now stubs the key so the suite never makes a real network call.
**499/499 green**, `npm run keytest` 13/13, `npm run e2e` 16/16 (no-key),
strays NONE. (Live-key verification is pending the free Gemini quota reset.)

## 2026-10-14 Alt+Up is a real LLM reply now (AI summary section replaced)

**What changed (user: "replace the ai summary section with this instead …
alt+up to get the full ai response … real rich reply with real llm")** —
Alt+Up no longer shows the local extractive digest as the primary content:
* on an ARTICLE it asks the REAL Gemini model to summarize the page
  (`STYLE`) and paints the rich reply fullscreen — with a `▍ thinking…`
  placeholder first and the local digest kept ONLY as a no-key fallback;
* on a SEARCH list it shows the REAL answer already fetched for the query
  (`lastAi`), not the stale extractive digest.
Collapse (Esc / Alt+Down) and the open/close toggle cancel any in-flight
reply via a token (`aiFullToken`), so a late answer can never land on the
wrong view. `showAiSummary` prefers the real answer too.
**Tests:** +2 (list prefers the real answer over the extractive digest;
article asks the LLM, shows the placeholder, then paints the reply).
**498/498 green**, `npm run keytest` 13/13, `npm run e2e` 16/16 (no-key),
strays NONE. Live-key runs confirmed the real answer path AND the exact
honest quota message after the free tier was spent.

## 2026-10-14 Boxes perfect at every width + real AI answers that actually arrive

**Boxes (user: "check all the boxes … no misaligned boxes")** — found and
fixed the real defect with a new real-page checker (`scripts/boxcheck.js`,
`npm run boxcheck`): `boxSections` padded each row on the raw `*italic*`
text, then `blockMd` turned `*italic*` into `{underline}italic{/}` AFTER
padding, removing 2 cells → **every Wikipedia box's right border was 2
cells short**. Emphasis (bold/code; italics now WITHOUT underline) is
applied inside `boxSections` BEFORE wrapping, so the padded width is final.
Inline italics and link labels are no longer underlined in boxes (user:
"remove the underline inside the boxed altogether"). Proof: 3 Wikipedia
articles × 4 widths = **12/12 boxes PERFECT** (before: 0/12). `inlineMd`
gained an `underline` option (default unchanged), `pairLinks` already had
one. Tests: +3 (emphasis never misaligns; no underline survives; links stay
clickable without underline).

**Real AI answers (user: "i expect a rich answer")** — the search answer
never appeared for two reasons, both fixed: (1) the live API returns a rich
answer in **~37 s**, but the search-answer timeout was **15 s** → every
answer died first; raised to 75 s and capped output (`MAX_OUTPUT_TOKENS`
3000) so length and latency are bounded. (2) a ~150-line answer was
scrolled completely off-screen by the cursor-following list paint; the list
now shows the top (the answer) until the user navigates. Heightened
`ANSWER_STYLE` to demand a full explanation. `/gemini` is now
context-aware: a page open → concise summary; standalone → rich answer.
Verified end-to-end with the real key: "what is godot" → the full
"Godot is a free and open-source … node-and-scene …" answer in the list.

**Browser tab safety (user: "close a browser tab after 1 minute")** —
`navigate()` runs under a hard 60 s deadline (`navTimeoutMs`); a stalled
load closes ITS page (RAM guard), and a superseded navigation can never
close a page a newer one is using (generation guard). Verified: stalled
page closed + slot cleared; superseded nav leaves the page alone. No stray
chrome/mpv/parec after any run.

**New E2E journey (`scripts/e2e_journey.py`, `npm run e2e`)** — one TUI
session, keys only: search → results → article → back → /help → /links →
/themes → /yt → play(mpv) → /stop → /queue → /videos → /gemini → quit.
**17/17 pass**, strays NONE (stray check reads `/proc/<pid>/comm`, immune to
the old `pgrep -f` shell self-match).
**496/496 tests**, `npm run keytest` 13/13, `npm run boxcheck` 12/12.

## 2026-10-14 Empty link markers removed from Wikipedia/wiki pages

**What changed** — Wikipedia and similar sites have many reference anchors
(`<a href="#cite_note-1">[1]</a>`) and empty anchors that previously
rendered as empty `[]` brackets in the article view. The pretty.js renderer
now tracks whether actual link text was written between `<a>` and `</a>`;
if the buffer didn't grow (only whitespace), the `[url]` marker is
suppressed entirely. Legitimate links with visible labels still render as
`label [url]` and stay clickable.
**Files:** `src/pretty.js` (anchor open/close tracking)
**Tests:** 491/491 green, `npm run keytest` 13/13, chrome/mpv/parec 0.

## 2026-10-14 Searches answer question-shaped queries with real Gemini

**What changed (user complaint: the "AI answer" was a useless extractive
bullet list)** — question-shaped searches now get a real Gemini answer in
the existing ━━━ AI answer ━━━ slot above the results: direct lead
paragraph, `###` sections, bullets (the Godot shape), rendered through
`blockMd` and pre-wrapped to the live body width so click mapping stays
exact. Results paint instantly; the answer lands async with a ▍ thinking…
placeholder. Only `looksLikeQuestion()` queries fire (what/why/how/is/…,
trailing ?); keyword/operator/domain searches never touch quota. No key →
one honest hint line + the extractive box stays. Page AI Overview card
wins when present (no double call). Stale answers die by navigation token.
**Errors name the exact problem:** 429/quota text → "your free API quota
is over" + usage link; 403 → restricted key; 500/503 → outage; abort →
"timed out after Ns"; `/gemini` behavior and STYLE untouched.
**Tests:** +3 detector, +8 style/errors (mocked fetch incl. 404 fallback),
+3 UI slot (markdown renders, replaces box, containment-checked), +5
orchestration (lands, no-key hint, non-question quiet, card wins, stale
dropped). **491/491 green**, `npm run keytest` 13/13, chrome/mpv/parec 0.

## 2026-10-14 Box containers fit their real container + containment checker

**What changed (user complaint: link lines escape the box when they wrap)**
— boxes were built from a *derived* width (`contentWidth()` = screen−6)
but drawn into `body` (real inner = screen−2): equal only by coincidence.
Two hard defects: a fixed 30 floor (`Math.max(30, …)` in paintPretty +
`boxSections` min-30 clamp) forced boxes wider than narrow bodies with a
shrink loop that could never shrink, and on shrink-resize the stale
`body.iwidth` outlived the layout so blessed wrapped border rows mid-box.
Measured in-suite pre-fix: box rows 30 cells in a 20-cell container.
Also found in blessed's own source (`element.js` parseContent): a
scrollbar object would steal the last column — our body has none, so the
wrap column is full `iwidth` (coded defensively anyway).
**Built:** `bodyInnerWidth()` in ui.js (min of fresh-derived and live
`iwidth`, falls back headless), `boxSections` takes `available` and never
exceeds it (passes through unboxed below W=12), `wrapVis` floor 10→4,
shrink loop verifies against the real width, `readerHeader` uses the same
basis, `TUI_DEBUG_BOX=1` prints violations to stderr. **Checker:**
`verifyBoxContainment()` in beautify.js (ANSI/tag-aware: catches escaped
continuations, orphan borders, missing caps, misaligned right edges with
stable reason strings); `boxRowOverflow` is now a thin wrapper over it;
`visibleCells`/`visLen` ignore raw ANSI (blessed getContent returns
rendered escapes). **Tests:** +10 in new tests/test-boxcontain.js (wired
into `npm test`; the live blessed case failed pre-fix, passes post-fix).
**472/472 green**, `npm run keytest` 13/13, chrome/mpv/parec 0.

## 2026-10-13 Viz runs at 20 Hz now (parec was starving it in 2 s bursts)

**What changed (user complaint: blocks update "after secs")** — measured
live during real playback: default `parec` delivers in ~2 s bursts (16
chunks/6 s, median gap 0 ms, max 2006 ms) — the script emitted 40 frames at
once then starved, so the bars JUMPED every ~2 s. Root cause: no latency
request → the server (PipeWire pulse layer) batches record streams.
Both parec spawns (RMS tap + spectrum script) now pass
`--latency-msec=25`, measured steady during music: 119 reads/6 s, median
gap 43 ms, max 125 ms, zero gaps >500 ms. End-to-end through the real app
path (Node child stdout): 156 frames/8 s (19.5 Hz), median 53 ms, max
245 ms. Kicks still punch (978) against quiet.
**Tests:** +2 arg pins (round5 spawn-argv, round6 script source).
**462/462 green**, `npm run keytest` 13/13, chrome/mpv/parec 0.

## 2026-10-13 music.youtube.com works like normal YouTube + snappier viz sync

**Music (user request)** — `music.youtube.com/search?q=…` now runs a `/yt`
search into the same picker (titles, Enter to play), exactly like
`youtube.com/results?search_query=…`. Both params accepted on both paths.
`music.youtube.com/watch?v=…` already played (pinned by test so it stays);
bare `/search` with no query still navigates normally (fail-open).
Verified live: yt-dlp resolves music URLs with full titles (same extractor).

**Sync (user complaint: viz updates slow)** — measured first: attack was
always fast (~1 hop to 85%, 0.1 ms paints), but FALL=0.55 smeared every
100 ms kick into a 550 ms glow — at 120 BPM tails overlap and beats blur.
Now FALL=0.78 (tail ~250 ms, clears in ~5 hops) + AGC 0.94→0.90 (sensitivity
recovers in ~300 ms so the next hit punches full). Sustained bass
unaffected (shown stays pinned while target is high). Proven: isolated
burst → 978 peak, all-zero by 5 hops later. Live capture latency ruled out
(click tracking ±60 ms; misses were startup scheduling, noted in test).

**Tests:** +1 spectrum tail test (attack intact + tail clear), +3 music
routing tests (search→picker, watch→mpv, bare search→navigate).
**460/460 green**, `npm run keytest` 13/13, chrome/mpv/parec 0 (9 keytest
chrome orphans reaped by hand — the §14 flake, again).

## 2026-10-13 Fullscreen keeps viz taps warm (you actually see bass now)

**What changed (user complaint: "still looks like the old code")** — proven
from `player.log`: every windowed session logged `spectrum on (8 bass bands)`
→ `FS suspended` → `no frames in 2s — RMS fallback`. mpv launches fullscreen
by default, suspend KILLED the warm tap, resume spawned a cold one, and the
2 s watchdog always won the race (python+numpy import + parec first-byte ≈
2 s) — so every session fell back to the RMS look. The bass bars worked in
tests but no user ever saw them.
- Suspend now parks the viz UI only; taps stay alive and warm (readings
  store, never paint while hidden). Resume re-shows and reuses the warm
  tap; a fresh tap starts only if both died while parked.
- Watchdog 2 s → 4 s for genuinely cold spawns (same bug class).
- Proven live: real mpv windowed → fullscreen → windowed on :1 while kicks
  played — one tap process throughout, kick hits pulsing 0.85–0.98 against
  quiet zeros across the toggle, no tap errors.
- `VIZ-FS suspended` log now notes taps stay warm.

**Tests:** fullscreen block in test-index.js now runs REAL tap objects (fake
spawn children with stdout + one spectrum frame, kills recorded): suspend
kills nothing, resume spawns nothing; round6 watchdog string → 4 s.
**456/456 green**, `npm run keytest` 13/13, chrome/mpv/parec 0.

## 2026-10-13 Footer owns the bottom slot (loader 2 rows, viz 1 row)

**What changed (user request)** — the wave loader and the visualizer moved
INTO the footer, and footer hints show only when neither needs the slot:
- Loading: `title · stage · Ns` + full-width wave (**2 rows**, was 3 + hint).
- Playing: spectrum bars only (**1 row**, was 3 + hint).
- Idle home: hints (1 row, as before). Idle off-home: nothing (as before).
- Worst case went 4 rows → 2; the page above never moves.
- Dropped rows: the loader hint (3rd row — same text the footer says when
  idle; the `hint` param is still accepted, just not painted) and the viz
  title/subhint (`playing in mpv`, `/stop · /next` — `/help` still lists
  them). The exact-width wave/bars invariant is untouched.
- `loaderFrame` (pure) is now 2 lines: `title · stage` + wave.
- `updateHint` yields while the slot is busy; `layoutBody` syncs hints
  first, then stacks the dynamic slot height (2/1/0). Toast/status still
  reveal transiently above the slot. Loader-wins, pause-freeze,
  fullscreen-suspend, and pre-warm semantics all unchanged.

**Tests:** updated in the same commit (`loaderFrame` verbatim shapes in
test-reader/test-handover/test-round3, viz bars re-anchored off the removed
title in round3/4/5/6, headless-truncation-proof stage assertion in
test-unit) + 3 new slot tests (2-row load, hint hide/return, 1-row viz).
**454/454 green**, `npm run keytest` 13/13, mpv/parec 0.

## 2026-10-13 Visualizer v2: real spectrum, no new deps + fullscreen rule

**Spectrum (user request: GitHub-picked, zero new dependencies)** — assessed
cava (needs building — rejected per user), PyAudio-class projects (all need
compiled bindings), and `pw-record` (87 ms startup but captures the wrong
source on this box — dropped after measurement). Shipped instead:
`scripts/vizspectrum.py` (stdlib + system numpy only, already installed):
100 ms Hann window / 50 ms hop (~20 Hz); bass-default mode: 8 log-spaced
bands over 40–250 Hz (kick + bassline only — `--full` opts back into the
16-band 60 Hz–3.8 kHz spectrum). Per-band AGC with a relative floor +
peak-hold/gravity falloff, ascii frames to stdout, `--stdin` test seam.
Proven live: 100 Hz sine → bass bands 3–4, 2 kHz → all-zero, silence →
zeros; kick pattern pulses 7 hot frames against 60 quiet. UI renders real
bands through the shared tag renderer (`renderVizBands`, `set/getVizBands`); precedence is bands >
envelope > synthetic. Fallback chain: spectrum → RMS tap → synthetic, with a
2 s no-frames watchdog. Found by test: silent bands self-normalized to full
scale as peaks decayed — fixed with the relative floor + first-frame init.
CPU stays ~1% (rfft of 800 samples @20 Hz is nothing).

**Sync fix (user report: terminal lagged the video)** — measured, not
guessed: capture path is 1–6 ms (parec buffering was innocent), steady-state
click-to-bar is ~176 ms. The lag was ours: 100 ms frames + attack 0.6 (≈300 ms
to converge). Attack is now 0.8 (96% in two frames); spectrum hops at 50 ms
and repaints on arrival (tick skips while bands are live).

**Fullscreen rule (user request)** — mpv covers the whole screen, so painting
bars underneath it is pure waste. The 1 s viz poll now also reads mpv's
`fullscreen` property (verified live: queryable + tracks runtime toggles):
- Fullscreen + viz on → hide the viz AND stop both taps (spectrum + RMS),
  logged as `VIZ-FS suspended`; a `vizSuspendedFS` flag owns the state.
- Back to windowed with the player alive → `showVisualizer` + tap restart,
  logged as `VIZ-FS resumed`. Pause-follow keeps working throughout.
- Missing `fullscreen` answer (older mpv) fails OPEN — viz stays on.
- Leading-edge tick: the rule corrects within ~100 ms of spawn, not a full
  second. All stop paths (close/error/`/stop`/shutdown/poll-death) reset it.
- Tests: 3 new behavior tests in `test-index.js` (fake player + fake IPC
  socket: park, resume, legacy fail-open). Two harness lessons: the shared
  spawn stub now records mpv handlers only, and each test rotates its fake
  pid (a stale "live" pid routes plays into the enqueue path).

**Spectrum pre-warm (the 2 s first-byte fix)** — measured: `parec` takes
~2 s to deliver first bytes (`pw-record` does 87 ms but captures the wrong
source here — dropped). The tap now starts with the yt-dlp resolve stage
(which takes longer anyway), so bars are live at playback start; the spawn
path adopts the warm tap instead of restarting it, and `paintFail` releases
a tap that never reached a player.

**Incidental leak fix** — `tap.stop()` killed the python analyzer but
orphaned its `parec` child. `scripts/vizspectrum.py` now installs
SIGTERM/SIGINT handlers + `atexit` reap: no more silent strays.

**Tests: 451/451 green** (+3), `npm run keytest` 13/13, mpv/parec 0.

## 2026-10-13 Reactive visualizer v1: bars follow the music (loudness envelope)

**What changed** — the bottom-line equalizer no longer plays a canned loop while
mpv runs; it breathes with the actual song. Quiet passages render low bars,
choruses render tall ones (live proof: quiet sine → energy 0.20, loud sine →
0.81, silence after stop → 0.00, all at ~10 Hz over the real monitor tap).

**How** (`src/vizAudio.js` new, `src/ui.js`, `src/index.js`)
- New `src/vizAudio.js`: spawns `parec -d @DEFAULT_MONITOR@ --rate=8000
  --channels=1 --format=s16le` (~16 KB/s, RMS over 800-sample / 100 ms frames,
  ~0.1% CPU), maps RMS → 0..1 energy (sqrt perceptual lift, floor 0.004 /
  ref 0.12 from measured box levels), smooths with fast-attack / slow-release
  EMA. Pure + unit-tested; never throws; `null` when the tap cannot start.
- `src/ui.js`: the 24-frame bar *shape* stays precomputed (same seeds — the
  synthetic path renders byte-identical output), the tick only indexes it.
  New `vizEnergyLine()` scales heights through an integer gain LUT
  (silence keeps 25% so the slot never looks dead, full energy == base shape).
  Instance gains `setVizEnergy`/`getVizEnergy`; loader-wins, pause-freeze and
  hide-reset semantics unchanged. No RNG, no FFT on the tick path.
- `src/index.js`: tap starts on mpv spawn, stops on close/error/poll-death/
  `/stop`/shutdown; lifecycle logged (`VIZ-TAP`) to player.log. Missing parec
  or any tap failure falls back to the synthetic animation silently.

**Why not mpv-cooperative**: tried first — mpv 0.40's `af-metadata` does not
forward lavfi filter metadata (ebur128/astats both answer "error accessing
property") and framelog parsing is fragile. The monitor tap needs zero mpv
cooperation and follows any player. No second download, no decoder, no
measurable CPU. Pause needs no special case (paused = silent = bars fall).

**Tests**: `tests/test-round5.js` (15 tests, in `npm test`) — RMS/mapping/
smoothing units, energy-line width/determinism/quiet≠loud, instance paint +
loader-wins, stubbed-spawn tap proof, wiring + lightness guards. Two
`test-index.js` spawn-count stubs now count mpv spawns only (the parec tap
shares the spawn seam). **437/437 green**, `npm run keytest` 13/13.

**Parked (user request, next)**: visualizer on/off toggle.

## 2026-10-12 Round 2 (§6 plan): wave v2, one animation, /yt loader, visualizer, dirty-bar fix

**T5 — dirty bar (the real `/gemini-key` + `/queue` bug), `src/ui.js` `submitOmni`**
- The omnibox was never cleared after a slash-command submit, so the next command
  glued onto the old text (`/gemini-key KEY` + `/gemini hi` submitted as one value that
  re-ran `gemini-key` with a corrupted key — proven live: toast `…mini(set)`). Now a
  `/…` submit clears the bar + resets the palette; raw search text deliberately stays.
- The `/gemini-key` save path itself was always fine (0600 file, masked toast, live API
  call answered `ok:true`); no key material is committed anywhere (tests use fake keys).

**T1 — wave art → the exact 20-cell cycle** `▁▂▃▄▅▆▇███▇▆▅▄▃▂▂▁▁▁` (`WAVE_FRAMES = 20`,
`WAVE_MS = 60`). Frames-not-algo: `WAVE_MOTIF` precomputed once, `waveFrame`/`waveLineTagged`
are pure table lookups (tick = one index), enforced by a source-guard test.

**T2 — ONE loading animation.** Braille spinner removed from the loader status line
(`paintLoading`, `loaderFrame`; dead `LOADER_SPIN` table deleted); `setStatus` paints
static text while the loader is up; duplicate `setStatus('Loading host…')` dropped from
`handleNavigation` (`src/index.js`). Wave keeps theme two-tone (accent crest / alt trough).

**T3 — wave loader on `/yt`** (`src/commands.js`): `showLoading('Searching YouTube', …)`
around `searchYouTube`, `hideLoading` on resolve + reject + before the navigate fallback;
verified live (loader title + 20-cell wave runs in the PTY stream, picker + thumbs follow).

**T4 — music visualizer** (`showVisualizer`/`hideVisualizer`/`isVisualizerOn`,
`vizLineTagged`, `VIZ_FRAMES = 24`, `VIZ_MS = 90`): precomputed equalizer-bar table
(seeded PRNG, temporally smoothed, deterministic), two-tone theme colors, in the wave's
bottom slot while mpv plays. Wired in `src/index.js`: on at spawn (`mpvPid` set), off on
close/error/`mpvStop`. Loader always wins the slot; viz resumes after `hideLoading`.

**T6 — queue:** no rebuild needed (9/9 queue tests were already green); added regression
test proving `/queue` routes clean after a prior command (the T5 path that made it feel broken).

**Tests:** new `tests/test-round3.js` (17 tests, in `npm test`), updated `test-reader.js`
(20-cell art, no-spinner loader) + `test-unit.js` wave test. Round-2 close: **409/409 green**,
`npm run keytest` **13/13**, zero stray processes.

## 2026-10-13 Round 3 follow-through (P1–P4): footer, docking, gallery loader, viz pause

**P1 — hint footer lives on home only** (`src/ui.js`, `src/index.js`)
- New `ui.setHomeMode(bool)`; `handleNavigation` reports it in `finally` (bare URL equals
  the DDG home page; boot defaults to home). Off-home `updateHint` hides the footer and
  clears it; `setStatus`/`toast` reveal it transiently and `clearStatus`/expiry re-hide it.
- Loader/visualizer sit flush at the very bottom off-home — no reserved hint row.

**P2 — one docking system** (`layoutBody`, `src/ui.js`)
- Every bottom-anchored box (`body`, `aiBar`, `loadBar`, `hintBar`, `imgPane`,
  `theaterPane`, `splitDiv`) gets `.bottom` assigned centrally every repaint, stacked
  loadBar → hint → aiBar from the inner edge. Killed the permanent `+1` reservation
  (the dead 1-row strip under the loader) and the `bottom:1` vs `bottom:0` overlap.
  Toasts during a load stack above the wave instead of covering it.

**P3 — gallery fetch shows the wave loader** (`renderGalleryImage`, `src/ui.js`)
- 250 ms delayed `showLoading('Loading image', 'N of M…')` (cached/instant fetches never
  flash); newest-request ownership via `galleryReq` + `galleryLoading` flag; released on
  ok/stale/unsupported/close; footer spinner removed (single-animation rule).

**P4 — visualizer pause-follow, synthetic (**no new CPU**)** 
- `ui.setVizPaused`/`isVizPaused`; 90 ms tick freezes while paused, repaints on resume;
  `♪` title dropped (renders `?` under `fullUnicode:false`). Index polls mpv `pause`
  over IPC once/sec (unref'd, dies with the player). Verified live: viz title + bar runs
  in the PTY stream during real mpv playback, `/stop` + kill leaves 0 strays.
- Real (ffmpeg-sidecar) reactivity stays rejected: ~5–15% CPU + double bandwidth +
  ~50–100 MB RAM on this box. Polls reuse the existing socket.

**Tests:** `tests/test-round4.js` (9 tests, in `npm test`; image I/O stubbed pre-require).
Final: **422/422 green**, `npm run keytest` **13/13**, chrome/mpv/yt-dlp all 0.

## 2026-10-13 ALT+UP / fill follow-ups + command-rule color

**P6 — background fill never clobbers the AI fullscreen** (`src/ui.js`, `src/index.js`)
- Root cause: after a search, `fillCurrentSearch` resolves in the background and
  `appendLinks` → `paintList` repainted `body` even with the ALT+UP digest open, wiping
  the AI view (read as "ALT+UP loads more links"). Now `appendLinks` merges rows silently
  while `aiExpanded` (they appear on collapse, which always repaints); explicit actions
  still win (new search via `showLinkPicker` already resets `aiExpanded`).
- Same race closed on two more paths: links/content **Tab now collapses the digest
  first** (plus the AI key trap, whose terminal `return` swallowed Tab/Enter — both now
  collapse-and-continue), and the async gallery/thumb body paints skip while `aiExpanded`.
- Fill failures are visible now: `fillCurrentSearch` logs `FILL-FAIL …` to player.log
  and calls new `ui.markFillStalled()`; the tail row reads `… load more (N more, fill
  stalled)`; any new search clears the marker. (Was: `.catch(() => {})`, stuck at 10
  links with no signal.)
- Command-line rule (`sep2`, under the omnibox): glyph untouched (`─`), color changed
  `muted` → theme `border` (constructor + `applyTheme`), so it reads as frame chrome.
- Tests: `tests/test-round3.js` T6 (digest survives background append, Tab collapses,
  stall marker set/cleared) + sep2 color guard. Final: **413/413 green**,
  `npm run keytest` **13/13**, chrome/mpv/yt-dlp all 0 (self-excluding `chrom[e]` counts).

## 2026-10-12 Handover implementation (BUG-1..BUG-8, wave spec, keytest)

**BUG-1 — themes looked identical: two stacked causes, both fixed**
- Root cause (bigger than quantization): every theme-colored content string used bare
  `{#hex}` tags (`src/ui.js`). Blessed resolves those through `_attr` to a bare palette
  number and emits junk SGR (`ESC[111m` — not a color), so accent/alt/muted never painted
  anywhere in body content. All content tags now use blessed's `{#hex-fg}` form, verified
  live (`38;2;…` on screen). `tests/test-handover.js` fails on any bare tag in `src/ui.js`.
- Truecolor passthrough (`enableTruecolor`, `src/ui.js:209`): when `COLORTERM` advertises
  truecolor/24bit, `#rrggbb fg|bg` emits `38;2/48;2` instead of xterm-256 quantization
  (which collapsed 75 themes to 8 backgrounds). Runtime patch on `program._attr`, gated +
  idempotent, stock path otherwise. Exported + unit-tested (`hasTruecolor`, `hexToRgbTriplet`).
- More surface: list headers (`Links (N)`, AI-answer rules) now carry accent/alt.
- Picker swatches: every row shows the theme's own `██ ██` (accent + alt); new pure
  `themeGrid()` also collapses to one column under 62 cells (BUG-7).

**BUG-2 — underline/rules spilling outside boxes**
- `src/beautify.js` measures terminal CELLS now (`visibleCells`/`isWideChar`; CJK/emoji = 2,
  combining marks = 0, `{open}/{close}` = 1). `visLen` kept as an alias.
- `wrapVis` no longer returns overlong URL rows whole (the H1 overrun): new `splitVis`
  chunks them into rows that all fit. `fitVis` is wide-aware and never halves a wide char.
- `centerTagged`/`truncateVisual` moved to `src/ui.js` module scope, cell-accurate, exported;
  overlong centered lines truncate instead of crossing the border (H4). Call-site order
  verified: `boxSections(escTags(…))`, and the `blockMd` post-pass only shrinks widths (H3 clear).
- Corpus test: ASCII/CJK/emoji/raw `{}`/long-URL/code-fence boxes at W=40/60/76 — every line fits.

**Wave loader (spec §2)** — the user's 14-cell cycle `▁▂▃▄▅▆▇█▇▆▅▄▃▂`, frames as left-rotations
(frame 0/1/2 verbatim, frame 14 === frame 0), tiled edge-to-edge with zero gaps at any width.
`LOAD_H` 2→3: status line, full-width two-tone wave (troughs alt, crests accent, tagged table
cached per width/colors), hint line. `WAVE_FRAMES` 24→14; `test-reader.js` art tests updated.

**Input (BUG-4 + keytest K2/K3)** — real bug found by the keylogger: `editText`/`acceptTypedChar`
required `ch.length === 1`, so CJK IME commits and pastes never reached the bar. Both accept
whole printable strings now (`printableStr`); type-to-search call sites route spaceless
multi-char commits; backspace deletes one code point (no halved emoji). `scripts/keytest.py`
(PTY, stdlib only, `npm run keytest`): **13/13 pass**, keylog at `/tmp/opencode/keylog.jsonl`,
zero browser processes (it never navigates; `/yt` untouched).

**LOW** — generator uniqueness guard for twin collisions (`scripts/gen-themes.js`, BUG-5; full
fingerprints asserted unique in tests); suite no-real-launch guard test (BUG-8 — the suite was
already fully stubbed, the earlier Chrome sighting was a debug script).

**Verification** — `npm test`: **392 tests, 392 pass, 0 fail** (was 365). No browser launched by
any test; system left with zero stray engine processes (user's own Firefox untouched).

**Fixes found by live verification**
- `errText()` in `src/browser.js`: any thrown value — plain object, nested `{error:{message}}`, fieldless — now renders a readable sentence. `${err}` on an object produced the literal `[object Object]`, which is now impossible on every path that reports a failure (`browser.navigate`, `/gemini` API, keyless Gemini web app, downloads, `handleNavigation`).
- The animated loader could outlive its request: a superseded or failed navigation returned before `hideLoading()`, leaving the spinner repainting over the page that replaced it. `handleNavigation` now owns it in a `finally` — success, failure and race all stop it.
- `/home` is now a real recovery command: it resets the browser (engine torn down and relaunched — renderer freed, stuck pages and bot-wall state dropped, reader mode and page size preserved) and *then* goes home. A failed reset still navigates, so it can never strand the user.

**Verification (live, one browser, closed afterwards)**
- Search: `q=chawan terminal browser` → 11 rows from page one, fan-out added 10 more (21 unique, zero dupes).
- Gemini key path with a deliberately invalid key → Google's own readable message: `API key not valid. Please pass a valid API key. Check /gemini-key.` (no `[object Object]`).
- `/home` reset → engine back up, search still returns 11 rows, exactly **1 tab** alive, browser closed cleanly.

**Critical fix — searches were broken**
- `browser.navigate()` started returning `blocked: { page, total }` (the tracker counts for the footer badge), and `handleNavigation()` treated *any* truthy `result.blocked` as the bot-wall message. Every page therefore painted `[object Object]` and no search ever opened a list. Counts now travel as `net`, and the wall check is `typeof === 'string'` only. Two regression tests cover both halves.

**/themes is back — live picker, no confirm button**
- `/themes` (and F2) opens a two-column picker of every theme. Moving the highlight repaints the whole app immediately and persists the choice — there is no Enter step; Esc just closes.
- Markers: `*` = highlighted theme, `o` = transparent.
- Opening on `white` now starts at the top of the list (white is parked last as the fallback, so arrows used to do nothing).

**All opencode themes, transparent twins, and both colors**
- `src/themes.js` is generated by `scripts/gen-themes.js` from opencode's real theme JSONs: **37 themes + white = 75 entries**, each with a transparent twin (`<name>-t`, `bg: null`) so the terminal background shows through.
- Each palette carries BOTH strong colors from upstream — `accent` (primary: links, cursor, loading wave) and `alt` (accent: AI answer rules, reader rule, loader stage) — so a theme is visible in more than one place, not just where one hue happens to land.
- `HIGHLIGHTED` themes (matrix, synthwave84, carbonfox, orng, lucent-orng, rosepine) are pinned to the top of the picker.
- Upstream 3-digit hexes are normalized so every color is `#rrggbb`.

**Loading wave, rebuilt from the supplied frames**
- The loader is now a two-row bar pinned to the bottom of the web view: the travelling wave + stage on row one, the hint underneath. The page above never moves, is never wiped, and never loses focus.
- The wave uses the supplied 24-frame artwork verbatim (`▂▃▄▅▆▇█` sliding one cell per frame, 60ms apart) at its designed 8-cell rhythm — tiling it across a wide bar made every copy snap at once, which is what made the earlier version look like noise.
- One leftover bug fixed: the tick referenced a deleted `WAVE_STEP`, which crashed the app on the first animation frame (`ReferenceError` while searching).

## 2026-10-12 Reader-mode browser + real Gemini + `/links`
The browser now looks the same on every site (not just Wikipedia), search returns more than 10 links, and AI answers are real or absent.

**Page view (the big one)**
- Reader mode is now the default for every page: `@mozilla/readability` (Apache-2.0, the Firefox Reader View engine) is vendored to `src/vendor/readability.bundle.js` and injected into the live page, so GitHub pages, news sites and blogs extract as real articles. `/read raw` is the escape hatch back to full page text. Verified on Wikipedia, GitHub and a blog; the old heuristic extraction stays as the fallback when there is no article.
- New `src/readability.js` (reading time, lead-heading promotion, hero-image picking), `src/links.js` (link normalization, shared with the search fan-out), `src/blocklist.js` (network hygiene), `src/searchFill.js` (search fan-out), `src/geminiWeb.js` (keyless Gemini).
- Magazine header on every article: centered title, muted `site · byline · reading time`, rule, and the lead image rendered as centered ASCII art above the title (text never waits for the image).
- Accessibility chrome no longer opens articles ("Jump to content" / "Skip to navigation" are dropped at the text level, `pretty.js`).
- Footer gained two live indicators: reading position (`· 42%`) and a right-aligned blocked badge (`⛨ 14 blocked`).
- `/gpt`, `/ai`, `/theme`, `/themes`, `/settings` and the whole F2 settings view are gone. Theme is config-only (`~/.config/tui-browser/config.json`), links-per-page moved to `/links`.
- AI answers render centered, as bullets, with rules and breathing room; markdown links and raw URLs are stripped so `[links]` can never appear. The auto AI bar on search lists keeps working and keeps its bullets.

**Search: more than 10 links**
- Verified root cause: `html.duckduckgo.com` serves exactly 10 results per page and ignores `&s=` on GET — page 2+ only exists as a POST. `/links 10|25|50|100` now drives a background fan-out: POST pagination, then **query variations** (DuckDuckGo autocomplete phrases, else `<query> <year>` / `<query> review`) so extra links are genuinely different pages. Rows merge live under the cursor (`ui.appendLinks`) without moving the highlight; `… load more` stays only when the budget ran out.

**AI: real or absent**
- `/gemini` uses the official Gemini API when a key exists (`/gemini-key`, `GEMINI_API_KEY`), otherwise drives the real `gemini.google.com/app` in the running browser and closes that page immediately after. With neither, it prints setup instructions — never a stand-in answer.
- `src/aiRemote.js` (pollinations) deleted: no more "GPT-like" answers from a free endpoint.
- Prompts now ask for "This website states …" narration plus short bullets. The old "too little text on this page to answer from" dead end is gone: a thin page means "no context", and the question is answered standalone.
- Model default `gemini-2.5-flash` with one silent retry on `gemini-2.0-flash` when a model is retired.

**Resource use**
- Videos are never downloaded: media requests are aborted by extension *and* resource type, so no mp4/webm/m3u8 bytes ever enter RAM.
- Ads/trackers are blocked at the network layer (curated host list + first-party beacon paths like `/beacon`, `/analytics.js`), counted per page and shown in the footer badge. Blocking them also makes extraction cleaner.
- Every auxiliary page (the keyless Gemini app) is closed the moment its text is extracted, and stray extra tabs from the persistent context are closed at launch.

**Loading animations**
- `ui.showLoading()` / `setLoadingStage()` / `hideLoading()`: braille spinner + shimmer bar + live stage text. Page loads use it ("Fetching text and links — no pixels, no video bytes"), and so does the video hand-off (resolve → retry with Android client → queue → hand over to mpv), replacing the frozen "Loading…" line.

**Tests**
- New `tests/test-reader.js` (offline tests for link normalization, fan-out planning/parsing/variants, media+tracker blocking, readability helpers, keyless-Gemini page lifecycle, prompt style, loader art, answer tidying). `npm test` now runs five files: 333 pass / 0 fail.

## 2026-10-12 P0+P1 command/key overhaul (Phases 0-3)
## 2026-10-12 P0+P1 command/key overhaul (Phases 0-3)
- New `src/commandSpec.js`: single source of truth (names, aliases, usage, hints, groups). Palette (`suggest.js`), HELP/SHORTCUTS (`commands.js`) and footer hints generated from it; `/youtube`, `/yts`, `/images`, `/dl`, `/downloads`, `/bm`, `/commands` now routable+visible; unknown commands suggest similars.
- Input layer (`src/ui.js`, `src/index.js`): CR twin deduped (one press = one action; LF also submits), Esc single-owned by the ui router (index binding removed, `resetFocus` idempotent + explicit form branch), bare `q` never quits (Ctrl+Q, `/quit` only; no C-c binding), `omni.censor` cleared on leaving form, gallery spinner + 10s watchdog guarantee the footer returns, click mapping uses real header height + zero-offset content clicks.
- Page vs message (`src/ui.js`, `src/commands.js`): new `ui.toast()` (footer flash, page untouched) for all transient feedback and new `ui.showInfo()` (body info that preserves page media/links) for `/help`, `/profile`, `/pets`, `/queue`, `/cookies` result etc. `/find` highlights in place with a match count and never clobbers lists/boxes/click map; `/watch`, `/img`, `/download`, `/copy` resolve against the visible list (`visibleRows`/`downloadTargetAt`); `/ai` toggle normalizes focus first; `/open` searches non-URL text; `/copy` accepts scheme-less URLs + instant ack; `/next` confirms; `/back`/`/forward`/`/reload` report empty stacks; `/theme` usage fixed; wizards re-prompt instead of aborting (Esc still cancels silently).
- Tests: new `tests/test-fixes.js` (truth + key-path + status, all offline); `test-unit`/`test-round2` updated for re-prompt wizards and clipboard-contract `/copy`. `npm test` now includes all four files.
- Known, parked (out of scope): terminal-resize repaints, small-terminal overlay clamping, `/gemini clear` single-word semantics, suggest-cursor reset on late responses, boot welcome screen, mpv `/pause|/mute|/seek` controls.

## 2026-10-11
- Added `src/yt.js`: `yt-dlp ytsearch` -> Invidious -> Playwright fallback; `thumbForVideoId`, `parseYtDlpOutput`, `checkPlayerDeps`.
- Added `/yt|/youtube|/yts` in `src/commands.js`; HELP/SHORTCUTS updated.
- Added `showYouTubePicker` title-only list in `src/ui.js` (`ytMode`); Enter plays via mpv, auto-thumb bound to `>`, click header fixed to 2 lines.
- Fixed `/` double-press: `startFreshSearch()` seeds `'/'` + `onSuggest('/')`.
- Fixed images no-stretch: `fitOverlay()` cell-aware single-dim, `kittyChunks()` no implicit second dim, `toDisplayPng()` `fit:inside` 800x600.
- Fixed Alt+Up disappear: `updateSummary()` repaints fullscreen when `aiExpanded` instead of `paintList()`.
- Tests use realistic user sites (github, youtube GothamChess, stackoverflow, reddit/r/chess, hackernews, MDN, DDG) — no example.com/wiki in new matrix.
- Added `scripts/yt_driver.py` (check/search/aspect/deps/slash/play/gotham) and `scripts/test_commands_matrix.py` (all/one/altup/sites).
- Updated `tests/test-unit.js` kitty single-dim contract + `tests/test-round2.js` single-slash expectation.

### Verification
- `npm test`: 184 pass / 0 fail.
- `python3 scripts/yt_driver.py check`: ALL PASS.
- `python3 scripts/test_commands_matrix.py all`: 56/56 no-throw (intended + unintended hints).
- Live: `/yt gotham chess` -> 10 GothamChess titles via yt-dlp, Enter plays in mpv.

## 2026-10-11 fullscreen Enter
- `playVideo()` now spawns `mpv --fullscreen <url>` so picker Enter opens fullscreen, fallback `xdg-open` unchanged.
- YT hint updated to `enter fullscreen in mpv`; picker keeps `>` list (no wipe) so fullscreen handoff is obvious.
- `tests/test-index.js` fullscreen spawn assertion updated.

## 2026-10-11 two-stage playback (SABR fix)
- `playVideo()` is now resolve-then-play: `yt-dlp -g -f <quality>` (+ android-client retry on SABR `page needs reload`) then `mpv --fullscreen <direct-url>` (`--audio-file=` for split tracks). No `--ytdl-format` inside mpv, no ffmpeg merge needed on saver levels.
- Saver defaults are progressive single-file (`360/480: best[height<=Q]/best`); 720+ tries merge first, retries progressive. Full mpv stderr tail goes to `player.log` + TUI error (never a browser).
- `/yt crunchiroll` (your failing `watch?v=2KPFnP1othM`) verified: 10-row picker live, direct URL resolves via android client (itag 18). Higher qualities note SABR limits + `yt-dlp -U` tip.
- Matrix `/yt <q>` now waits 45s/90s timeout so live search is actually asserted (10 rows), not a 120ms false-pass.

## 2026-10-11 single mpv + picker stays
- Double Enter no longer opens 2x mpv: `confirmLinkList()` dedupes same URL 1s (`src/ui.js`), `playVideo()` dedupes same URL 2.5s with `DEDUP` log (`src/index.js`), textbox `submit` ignored outside input/form (was double-firing with keypress).
- Picker stays mounted after play (YT mode never calls `showText` on Enter): close mpv, pick next video with `up/down` + Enter. Verified: 2x fast Enter -> 1 play, `isPickerOpen()=true`.
- Playback stays external separate mpv window; terminal only shows titles + thumbs, never in-terminal video.
- Videos never auto-open a browser: mpv async/sync failure paints TUI error + `player.log`, no `xdg-open` fallback. `/open` stays explicit.
- Added `src/quality.js` + `config.quality` (default 480p saver): `/quality 360|480|720|1080|best`, `Ctrl+Q` cycles, mpv `--ytdl-format` mapped per level.
- Enter reliability: `links` Enter accepts `enter/return/kpenter/\\r` spellings; `playVideo()` returns `{ok,method,error,args}` + log.
- Test fixtures use real user sites (github, GothamChess YT, stackoverflow, reddit/r/chess, HN, MDN, gmail); zero `example.com` in code/tests.

## 2026-10-11 pretty articles + sub-topic boxes
- `src/pretty.js` (own MIT renderer, zero-dep — cli-html trial removed with its 52MB tree): headings, `label [url]` markers, bullets, bordered tables, quote bars, fenced code; `extractLinkLines` click mapping.
- `src/browser.js` returns cleaned article HTML (anchors absolutized, imgs to `[alt]`) + Node-side `pretty` text on article results.
- `src/ui.js` prefers the pretty view over spans (spans stay as fallback + Enter picker); `src/index.js` passes `result.pretty` through.
- `src/beautify.js` `boxSections()`: `## ` splits into rounded-border boxes, body left + numbered links rail right of a middle │ divider, padded; refs `[n]`, bullets, quote rails, bold subheads inside.
- Box measuring: every box row fits its width exactly (two-col off-by-one fixed, code wraps); widths re-measured live via `contentWidth()` (split-aware) on navigation, Esc-restore, split toggle, and resize; `showText` keeps boxes via persisted pretty source.
- 60/40 splits: body narrows to `60%-1`, visible │ divider column between webview and image/theater pane (paints on toggle/resize/theme).

## 2026-10-11 /videos now-playing + /download dir
- `/videos` marks the row mpv is actually playing with ▶: new `mpvQuery()` IPC request/response (request_id matched, events ignored, chunk reassembly, never throws) + `mpvNowPlaying()` live state first (exact after `/next`), last-queue head as fallback for direct-stream plays; `yt.sameVideoUrl()` identity (watch/shorts/embed/youtu.be equal, else exact).
- `/download <n-or-url> [<dir>]`: second arg overrides the destination (default stays ~/Downloads); existing dirs, trailing-slash and fresh nested dirs get the generated filename inside; `~` expands; relative stays under Downloads; parent dirs created. HELP/SHORTCUTS usage updated.

## 2026-10-11 single-player enqueue + keyboard logger
- One mpv only: Enter while a video runs enqueues play-next into the running player (loadfile append + playlist-move right after current, verified move math against live mpv) instead of a 2nd window; PID-tracked liveness (kill(pid,0), sync, stub-safe), serialized chain, strict IPC replies, lastQueue mirrored, flash feedback + retry hint. HELP/SHORTCUTS updated.
- `scripts/keylog_driver.py` + `scripts/keylog_probe.js`: keyboard logger driving the real blessed UI across boot/article/list contexts (all keys incl. arrows/tab/space/esc/ctrl+q/alt-combos) plus every /command typed from the catalog; JSON-in-file output (blessed spams stdout), PASS/FAIL/SKIP table, network-only cases marked SKIP.

## 2026-10-11 slash palette overlay + suggest health
- `/` while browsing paints a 3-row top overlay (page stays mounted underneath) with a disconnect rule; idle boots keep the legacy full catalog list in the body. Arrows walk the window, Enter/Esc/submit flows unchanged; overlay hides on submit, cancel, and focus change.
