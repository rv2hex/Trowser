'use strict';

// Slash-command routing. Pure wiring over injected deps ({ ui, browser,
// navigator, config, saveConfig, shutdown }) so it unit-tests without
// booting the TUI. Unknown commands and bad args render inline hints,
// never errors.

// In-memory reply threads (newest last, capped at 6 exchanges each).
// Session scope by design: a restart starts fresh conversations.
const aiThreads = { ai: [] };

// /git + /feeds result caches: lazily created, 10-minute TTL (module
// level so repeated calls hit the cache; the helper modules stay out of
// the boot path until the command is first used).
let gitCardCache = null;
let feedCache = null;

// Paint the running Q/A transcript into the dedicated scrollable view.
// Uncapped — the view scrolls, so long answers are never cut.
function showAiThread(ui, thread, title) {
  const lines = [];
  // NOTE: answers stay raw here — showGeminiView escapes + beautifies them.
  (Array.isArray(thread) ? thread : []).forEach((ex, i) => {
    lines.push(`Q${thread.length > 1 ? i + 1 : ''}: ${String(ex.q || '').slice(0, 300)}`);
    lines.push('');
    lines.push(String(ex.a || ''));
    // Attribution on the answer itself: "— by nemotron 120b". Rendered
    // per exchange so an old answer never gets relabelled after a model
    // switch in /settings.
    if (ex && ex.m) {
      try {
        lines.push('');
        lines.push(`— by ${require('./openrouter').modelLabel(ex.m)}`);
      } catch { /* attribution is cosmetic */ }
    }
    lines.push('');
  });
  const text = lines.join('\n').trim().slice(0, 120000) || '(empty thread)';
  // Newest signed exchange also labels the view head, so the model is
  // visible without scrolling to the end of a long answer.
  let lastModel = '';
  const arr = Array.isArray(thread) ? thread : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] && arr[i].m) { lastModel = String(arr[i].m); break; }
  }
  if (ui && typeof ui.showGeminiView === 'function') {
    ui.showGeminiView(text, String(title || 'Conversation').slice(0, 80), lastModel);
  } else if (ui && typeof ui.setCenterContent === 'function') {
    ui.setCenterContent(text, []);
  }
}

// One AI conversation, one real transport: OpenRouter free-tier models
// (src/openrouter.js). No key = honest setup instructions (AI_NO_KEY),
// never a fake answer. Page context is opportunistic — a thin page just
// means "no context" and the question is answered standalone. Replies
// accumulate in-thread; bare /ai reprints the thread, /ai clear resets it.
// Each answer is signed with the model that produced it ("— by nemotron
// 120b"), and /settings → AI picks which free model that is.
function runAiChat(arg, deps) {
  const { ui } = deps;
  const or = require('./openrouter');
  const thread = aiThreads.ai;
  const q = String(arg || '').trim();
  const sub = q.toLowerCase();
  if (!q) {
    // Bare /ai on a page = summarize that page (the everyday ask).
    // Only a truly empty view falls back to the usage hint.
    try {
      const ctx = pageContext(ui);
      if (ctx && ctx.length > 200) return runAiChat('Summarize this page for me.', deps);
    } catch { /* fall through to usage */ }
    if (!thread.length) {
      toast(ui, 'Open a page and /ai summarizes it — or ask: /ai <your question>.');
      return;
    }
    showAiThread(ui, thread, 'Conversation');
    return;
  }
  if (sub === 'clear') {
    thread.length = 0;
    toast(ui, 'Conversation cleared. Ask: /ai <your question>.');
    return;
  }
  const history = thread.map((ex) => ({ q: ex.q, a: ex.a }));
  const show = (text, title) => {
    try {
      if (ui && typeof ui.clearStatus === 'function') ui.clearStatus();
    } catch { /* best effort */ }
    if (typeof ui.showGeminiView === 'function') ui.showGeminiView(text, title);
    else info(ui, text);
  };
  const remember = (a, model) => {
    thread.push({ q: q.slice(0, 500), a: String(a).slice(0, 60000), m: String(model || '') });
    while (thread.length > 6) thread.shift();
    showAiThread(ui, thread, q);
  };
  const fail = (detail) => show(String(detail || 'The AI did not answer.').slice(0, 2000), 'Answer');
  try {
    if (ui && typeof ui.setStatus === 'function') {
      let label = 'free model';
      try { label = or.modelLabel(or.resolveModel()); } catch { /* label is cosmetic */ }
      ui.setStatus(`Asking ${label}… ${q.slice(0, 60)}`);
    }
  } catch { /* status never breaks the ask */ }

  const context = pageContext(ui);
  const hasPage = context.length > 200; // real article loaded
  // Page open → STYLE (concise page summary, 4-6 bullets).
  // No page → ANSWER_STYLE (rich detailed answer, 4000-6000 chars).
  const style = hasPage ? or.STYLE : or.ANSWER_STYLE;
  const promptContext = hasPage ? context : ''; // standalone = no context
  // deps.askAi (wired by index.js) wins so hosts can inject a transport;
  // otherwise the module reads the saved key itself. Either way a missing
  // key comes back as { ok:false, error: AI_NO_KEY } and paints verbatim.
  const ask = typeof deps.askAi === 'function' ? deps.askAi : (question, opts) => or.askAi(question, opts);
  // Streamed progress: free models can take a minute-plus for a full
  // ANSWER_STYLE reply, so the status line proves the request is alive
  // instead of looking hung (the answer view paints when it lands).
  let lastNote = 0;
  const onDelta = (full) => {
    const now = Date.now();
    if (now - lastNote < 500) return;
    lastNote = now;
    try {
      if (ui && typeof ui.setStatus === 'function') {
        ui.setStatus(`Receiving answer… ${String(full || '').length} chars so far (free model, still writing)`);
      }
    } catch { /* status is best-effort */ }
  };
  return Promise.resolve(ask(q, { context: promptContext, history, style, onDelta })).then(
    (r) => (r && r.ok ? remember(r.text, r.model) : fail((r && r.error) || 'The AI did not answer.')),
    (e) => fail(`AI request failed: ${e && e.message ? e.message : e}`)
  );
}

// Best-effort page text for page-aware answers. Empty string is a valid,
// common outcome (no page open, or a text-light page) and never an error.
function pageContext(ui) {
  try {
    if (!ui || typeof ui.getPageText !== 'function') return '';
    const { MAX_CONTEXT_CHARS } = require('./openrouter');
    return String(ui.getPageText() || '').slice(0, MAX_CONTEXT_CHARS);
  } catch {
    return '';
  }
}

function toast(ui, text, ms) {
  try {
    if (ui && typeof ui.toast === 'function') { ui.toast(text, ms); return; }
    if (ui && typeof ui.flashStatus === 'function') { ui.flashStatus(text, ms); return; }
  } catch { /* fall through */ }
  try {
    if (ui && typeof ui.setCenterContent === 'function') ui.setCenterContent(text, []);
  } catch { /* never throw */ }
}

function info(ui, text) {
  try {
    if (ui && typeof ui.showInfo === 'function') { ui.showInfo(text); return; }
  } catch { /* fall through */ }
  try {
    if (ui && typeof ui.setCenterContent === 'function') ui.setCenterContent(text, []);
  } catch { /* never throw */ }
}

function searchURLFor(q) {
  const clean = String(q == null ? '' : q).replace(/[\x00-\x1f\x7f]/g, '');
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(clean)}`;
}

function looksLikeUrlToken(tok) {
  const v = String(tok || '').trim();
  if (!v || /\s/.test(v)) return false;
  if (/^https?:\/\//i.test(v)) return true;
  return /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v);
}

// Host name for display (never a full URL). Empty string when unattributable.
function hostOf(u) {
  try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Bing Images results: full URL + thumbnail + title, from the iusc `m` blob.
function parseImageResults(html) {
  const out = [];
  try {
    const re = /class="iusc"[^>]*m="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      try {
        const obj = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'"));
        if (obj.murl) out.push({ title: String(obj.t || obj.murl).slice(0, 80), full: obj.murl, thumb: obj.turl || obj.murl });
      } catch { /* skip malformed */ }
      if (out.length >= 30) break;
    }
  } catch { /* best effort */ }
  return out;
}

const { buildHelp, buildShortcuts, suggestSimilar, findSpec } = require('./commandSpec');
const SHORTCUTS = buildShortcuts();
const HELP = buildHelp();
// Full catalogue (/help all): setup + settings-hub commands included.
const HELP_ALL = buildHelp('all');

function routeCommand(input, deps) {
  const { ui, browser, navigator, config, saveConfig, shutdown } = deps || {};
  if (!ui) return;
  // Strip ALL leading slashes so `//ai` (double-tap from the search bar)
  // routes exactly like `/ai` instead of dying as an unknown command.
  const parts = String(input || '')
    .trim()
    .replace(/^\/+/, '')
    .split(/\s+/)
    .filter(Boolean);
  const raw = (parts[0] || '').toLowerCase();
  const arg = parts.slice(1).join(' ');
  const cmd = raw === 'shotcuts' ? 'shortcuts' : raw; // forgiving alias
  switch (cmd) {
    case 'settings': {
      // One hub for every setting: boxed sections, live values. ←/→ (or
      // Enter) changes a value; Enter on a personal-details row edits it.
      if (!ui || typeof ui.showSettings !== 'function') {
        toast(ui, 'Settings are unavailable here.');
        return;
      }
      const { describeQuality, cycleQuality, DEFAULT_QUALITY, VOS, describeVo, DEFAULT_VO } = require('./quality');
      const { PAGE_SIZES, QUIT_PLAYER_CHOICES } = require('./config');
      const accts = require('./accounts');
      const persist = () => { try { if (typeof saveConfig === 'function' && config) saveConfig(config); } catch { /* best effort */ } };
      const edit = (field, prompt, censor, apply) => {
        if (typeof ui.showLoginForm !== 'function') { toast(ui, 'Editing is unavailable here.'); return; }
        ui.showLoginForm({
          step: field,
          prompt,
          censor,
          callback: (v) => {
            if (v === null || v === undefined) return; // Esc
            const r = apply ? apply(String(v)) : { ok: true };
            if (r && r.ok === false) { toast(ui, r.error || 'Could not update.'); return; }
            toast(ui, `${field} updated.`, 3000);
            try { ui.showSettings(buildItems()); } catch { /* best effort */ }
          },
        });
      };
      // Every row: `value` is a LIVE function (the row always shows the
      // current setting), `onCycle` only PREVIEWS (mutates config, no apply,
      // no persist), and `onCommit` (Enter) LOCKS it in: applies + persists +
      // confirms. Personal-details / API-key rows use `onSelect` (edit form).
      // Theme preview/lock state lives at case scope so the onLeave revert
      // (passed to showSettings) can see it.
      let lockedTheme = String((config && config.theme) || 'white');
      let previewTheme = null;
      // AI model pick: same cycle=preview / Enter=lock contract as the
      // theme — leaving the hub without Enter restores the locked pick.
      let lockedModel = String((config && config.aiModel) || '');
      const buildItems = () => {
        const items = [];
        const curTheme = () => String((config && config.theme) || 'white');
        const curQuality = () => describeQuality((config && config.quality) || DEFAULT_QUALITY);
        const curVo = () => describeVo((config && config.vo) || DEFAULT_VO);
        const curQuit = () => String((config && config.quitPlayer) || 'ask');
        const curLinks = () => String((config && config.pageSize) || 50);
        const curIdle = () => String((config && config.idleTeardownMin) || 0);
        // `value` may be a thunk: rows mutate config while cycling, so a
        // label snapshotted at hub-build time once toasted "best" right
        // after locking 1080p. Thunks read the value at Enter time, when it
        // is the one being saved.
        const lock = (label, value) => () => {
          let v = value;
          try { v = typeof value === 'function' ? value() : value; } catch { /* fall back to raw */ }
          persist();
          try { if (typeof ui.toast === 'function') ui.toast(`${label} locked: ${v}`, 3000); } catch { /* best effort */ }
        };
        items.push({
          section: 'Appearance', label: 'Theme',
          // Shows the PREVIEWED theme while arrowing, the locked one otherwise.
          value: () => previewTheme || curTheme(),
          // ←/→ previews the colours live (applied, NOT saved).
          onCycle: (d) => {
            // Arrowing the theme while glowing: drop glow so the real theme shows.
            try { if (typeof ui.isGlowOn === 'function' && ui.isGlowOn() && typeof ui.setGlow === 'function') ui.setGlow(false); } catch { /* best effort */ }
            const list = require('./themes').themeList();
            const base = previewTheme || curTheme();
            const i = Math.max(0, list.indexOf(base));
            previewTheme = list[(i + (d < 0 ? -1 : 1) + list.length) % list.length];
            try { if (typeof ui.applyTheme === 'function') ui.applyTheme(previewTheme); } catch { /* best effort */ }
          },
          // Enter LOCKS it in: persist + confirm.
          onCommit: () => {
            lockedTheme = previewTheme || curTheme();
            previewTheme = null;
            if (config) config.theme = lockedTheme;
            persist();
            lock('Theme', lockedTheme)();
          },
        });
        items.push({
          section: 'Appearance', label: 'Glow mode (rainbow)',
          value: () => (typeof ui.isGlowOn === 'function' && ui.isGlowOn() ? 'ON' : 'off'),
          onCycle: () => { try { if (typeof ui.setGlow === 'function') ui.setGlow(!(typeof ui.isGlowOn === 'function' && ui.isGlowOn())); } catch { /* best effort */ } },
          onCommit: () => {
            const on = typeof ui.isGlowOn === 'function' && ui.isGlowOn();
            if (config) config.glow = on;
            persist();
            lock('Glow mode', on ? 'ON' : 'off')();
          },
        });
        items.push({
          section: 'Video', label: 'Quality',
          value: curQuality,
          onCycle: () => { if (config) config.quality = cycleQuality(config.quality); },
          onCommit: () => {
            lock('Quality', curQuality)();
            // A running player hears about the lock too (the next queued
            // track resolves at the new quality; the toast stays the same).
            try { if (typeof deps.pushQuality === 'function') deps.pushQuality(config && config.quality); } catch { /* push is best-effort */ }
          },
        });
        items.push({
          section: 'Video', label: 'Video output',
          value: curVo,
          onCycle: (d) => {
            const cur = (config && config.vo) || DEFAULT_VO;
            const i = Math.max(0, VOS.indexOf(cur));
            if (config) config.vo = VOS[(i + (d < 0 ? -1 : 1) + VOS.length) % VOS.length];
          },
          onCommit: lock('Video output', curVo),
        });
        items.push({
          section: 'Video', label: 'Quit with a video playing',
          value: curQuit,
          onCycle: (d) => {
            const cur = (config && config.quitPlayer) || 'ask';
            const i = Math.max(0, QUIT_PLAYER_CHOICES.indexOf(cur));
            if (config) config.quitPlayer = QUIT_PLAYER_CHOICES[(i + (d < 0 ? -1 : 1) + QUIT_PLAYER_CHOICES.length) % QUIT_PLAYER_CHOICES.length];
          },
          onCommit: lock('Quit with a video playing', curQuit),
        });
        items.push({
          section: 'Browsing', label: 'Links per page',
          value: curLinks,
          onCycle: (d) => {
            const cur = (config && config.pageSize) || 50;
            const i = Math.max(0, PAGE_SIZES.indexOf(cur));
            const n = PAGE_SIZES[(i + (d < 0 ? -1 : 1) + PAGE_SIZES.length) % PAGE_SIZES.length];
            if (config) config.pageSize = n;
          },
          onCommit: () => {
            try { if (typeof ui.setPageSize === 'function') ui.setPageSize(curLinks()); } catch { /* best effort */ }
            if (typeof deps.refillLinks === 'function') { try { deps.refillLinks(curLinks()); } catch { /* best effort */ } }
            lock('Links per page', curLinks)();
          },
        });
        items.push({
          section: 'Browsing', label: 'Idle teardown (minutes, 0=off)',
          value: curIdle,
          onCycle: (d) => {
            const steps = [0, 5, 10, 15, 30];
            const cur = (config && config.idleTeardownMin) || 0;
            const i = Math.max(0, steps.indexOf(cur));
            if (config) config.idleTeardownMin = steps[(i + (d < 0 ? -1 : 1) + steps.length) % steps.length];
          },
          onCommit: lock('Idle teardown', () => `${curIdle()} min`),
        });
        items.push({
          section: 'Browsing', label: 'Reader mode',
          value: () => String((config && config.readerMode) || 'reader'),
          onCycle: () => { if (config) config.readerMode = (config.readerMode === 'raw' ? 'reader' : 'raw'); },
          onCommit: () => {
            if (typeof deps.setReadMode === 'function') { try { deps.setReadMode(String((config && config.readerMode) || 'reader')); } catch { /* best effort */ } }
            lock('Reader mode', () => String((config && config.readerMode) || 'reader'))();
          },
        });
        items.push({
          section: 'Browsing', label: 'Restore last session (opt-in)',
          // Privacy default: OFF — history is session-scoped by design, and
          // the restored URL is the one thing allowed to survive a restart.
          value: () => ((config && config.restoreSession) ? 'ON' : 'off'),
          onCycle: () => { if (config) config.restoreSession = !(config && config.restoreSession); },
          onCommit: lock('Restore last session', () => ((config && config.restoreSession) ? 'ON' : 'off')),
        });
        try {
          // AI section: which free model answers, and the OpenRouter key.
          // The model row cycles the LIVE free catalog (a background fetch
          // starts when the hub opens; the curated list covers until it
          // lands) so retired upstream ids stop being offered. value()
          // shows the model that will really answer — effectiveModel()
          // ignores a stale saved pick the moment the catalog is live.
          // Enter locks the pick into config.json (resolveModel reads it
          // fresh, so the very next /ai uses it). The key row edits the
          // 0600 key file.
          const or = require('./openrouter');
          try { or.warmFreeModels(); } catch { /* background refresh is best-effort */ }
          const curModel = () => or.effectiveModel(String((config && config.aiModel) || ''));
          items.push({
            section: 'AI', label: 'Answer model (OpenRouter free)',
            value: () => {
              const live = or.catalogIsLive() ? ` · ${or.modelCatalog().length} live` : '';
              return or.modelLabel(curModel()) + live;
            },
            onCycle: (d) => {
              // Read the catalog at press time: a fetch that landed while
              // the hub is open is picked up without a rebuild.
              const list = or.modelCatalog().map((m) => m.id);
              if (!list.length || !config) return;
              const cur = String(config.aiModel || '');
              const i = list.indexOf(cur);
              if (i < 0) {
                // A stale/never-listed pick enters the list at the start
                // (→) or the end (←) — never silently skips the first item.
                config.aiModel = d < 0 ? list[list.length - 1] : list[0];
              } else {
                config.aiModel = list[(i + (d < 0 ? -1 : 1) + list.length) % list.length];
              }
            },
            onCommit: () => {
              lockedModel = String((config && config.aiModel) || '');
              persist();
              lock('Answer model', () => or.modelLabel(curModel()))();
            },
          });
          items.push({
            section: 'AI', label: 'OpenRouter API key',
            value: () => {
              try {
                const k = or.loadKey();
                return k ? or.maskKey(k) : 'not set — /ai-key';
              } catch { return 'not set'; }
            },
            onSelect: () => edit(
              'OpenRouter API key',
              'Paste your OpenRouter key (free at https://openrouter.ai/keys; type "clear" to remove it): ',
              true,
              (v) => {
                const { saveKey, clearKey } = require('./openrouter');
                if (String(v).trim().toLowerCase() === 'clear') { clearKey(); return { ok: true }; }
                if (!saveKey(v)) return { ok: false, error: 'Could not save the key.' };
                return { ok: true };
              }
            ),
          });
        } catch { /* AI section is best-effort */ }
        let me = null;
        try { me = accts.currentSession(); } catch { me = null; }
        if (me) {
          let prof = null;
          try { prof = accts.publicProfile(accts.findByGmail(accts.loadAccounts(), me)); } catch { prof = null; }
          if (prof) {
            items.push({ section: 'Personal details', label: 'Name', value: () => prof.name || '—', onSelect: () => edit('Name', 'Name: ', false, (v) => accts.updateAccount(me, { name: v })) });
            items.push({ section: 'Personal details', label: 'Email', value: () => prof.gmail || '—', onSelect: () => edit('Email', 'Your email is your account id — create a new account to change it.\n\nEmail: ', false, () => ({ ok: false, error: 'Email is your account id and cannot be changed here.' })) });
            items.push({ section: 'Personal details', label: 'Number', value: () => prof.number || '—', onSelect: () => edit('Number', 'Number: ', false, (v) => accts.updateAccount(me, { number: v })) });
            items.push({ section: 'Personal details', label: 'Date of birth', value: () => prof.dob || '—', onSelect: () => edit('Date of birth', 'Date of birth (YYYY-MM-DD): ', false, (v) => accts.updateAccount(me, { dob: v })) });
            items.push({ section: 'Personal details', label: 'Password', value: () => '••••••••', onSelect: () => edit('Password', 'New password: ', true, (v) => accts.updateAccount(me, { password: v })) });
          }
        } else {
          items.push({ section: 'Personal details', label: 'Not signed in', value: () => '/login or /register', onCycle: () => {} });
        }
        return items;
      };
      // Reflect a persisted glow setting when the hub opens.
      try {
        if (config && config.glow && typeof ui.setGlow === 'function') ui.setGlow(true);
      } catch { /* best effort */ }
      ui.showSettings(buildItems(), {
        // Leaving without Enter reverts the previewed theme (nothing was saved).
        onLeave: () => {
          if (previewTheme) {
            const revert = lockedTheme;
            previewTheme = null;
            try { if (typeof ui.applyTheme === 'function') ui.applyTheme(revert); } catch { /* best effort */ }
            if (config) config.theme = revert;
            persist();
          }
          // An uncommitted model cycle reverts too: otherwise a later
          // persist (any other lock, /links, /quality) would silently save
          // a model the user never locked in.
          if (config && String(config.aiModel || '') !== lockedModel) config.aiModel = lockedModel;
        },
      });
      return;
    }
    case 'links': {
      // Links per page: owns the paging size AND triggers a refill of the
      // current search (DuckDuckGo HTML only serves 10 per page, so the
      // browser fans out to reach the number set here).
      const { PAGE_SIZES } = require('./config');
      const cur = (config && config.pageSize) || 50;
      const tok = arg.trim().toLowerCase();
      if (!tok) {
        toast(ui, `Links per page: ${cur} — Usage: /links ${PAGE_SIZES.join('|')}. Searches auto-fill up to this many results.`);
        return;
      }
      const n = Number(tok);
      if (!PAGE_SIZES.includes(n)) {
        toast(ui, `Unknown count "${arg.trim().slice(0, 20)}". Try: /links ${PAGE_SIZES.join('|')}.`);
        return;
      }
      try { if (typeof ui.setPageSize === 'function') ui.setPageSize(n); } catch { /* best effort */ }
      try {
        if (config) config.pageSize = n;
        if (typeof saveConfig === 'function' && config) saveConfig(config);
      } catch { /* persist is best-effort */ }
      toast(ui, `Links per page: ${n}`);
      // Refill the list on screen right away when one is open (deps supplies
      // the browser handle; no list = no-op).
      if (typeof deps.refillLinks === 'function') {
        try { deps.refillLinks(n); } catch { /* refill is best-effort */ }
      }
      return;
    }
    case 'read': {
      // Reader view is the default for every page; this only switches the
      // escape hatch (/read raw = untouched full text) and re-extracts.
      const mode = arg.trim().toLowerCase() === 'raw' ? 'raw' : 'reader';
      if (typeof deps.setReadMode === 'function') {
        try { deps.setReadMode(mode); } catch { /* best-effort */ }
        return;
      }
      toast(ui, 'Reader view is unavailable here.');
      return;
    }
    case 'profile': {
      // Local account + session info: everything the app knows about you.
      // Informational view: preserves page media/links via showInfo.
      const accts = require('./accounts');
      let profDir = '';
      let ready = false;
      let histLen = 0;
      try { profDir = browser && browser.profileDir ? browser.profileDir : ''; } catch { /* best effort */ }
      try { ready = browser && typeof browser.profileReady === 'function' ? browser.profileReady() : false; } catch { /* best effort */ }
      try { histLen = navigator && typeof navigator.getHistory === 'function' ? navigator.getHistory().length : 0; } catch { /* best effort */ }
      const lines = [
        `Profile: ${profDir}`,
        `Session: ${ready ? 'saved' : 'not saved'}`,
        `Theme: ${config && config.theme} (config only)   Links per page: ${config && config.pageSize} (/links)`,
        `History: ${histLen} pages`,
      ];
      const me = accts.currentSession();
      if (me) {
        const p = accts.publicProfile(accts.findByGmail(accts.loadAccounts(), me));
        if (p) {
          lines.push(
            '',
            `Signed in as ${p.name} <${p.gmail}>`,
            `Number: ${p.number}`,
            `Registered: ${p.createdAt}`,
            `Last login: ${p.lastLoginAt}`
          );
        } else {
          lines.push('', 'Signed in, but the account is gone.');
        }
      } else {
        lines.push('', 'Not signed in. Run /register or /login.');
      }
      info(ui, lines.join('\n'));
      return;
    }
    case 'pets': {
      const pets = require('./pets');
      const input = arg.trim();
      const egg = pets.easterEgg(input);
      if (egg) {
        info(ui, `${egg}\n\n(easter egg)`);
        return;
      }
      const mood = input.toLowerCase();
      if (!mood) {
        info(ui, `${pets.petFor('happy')}\n(happy — try /pets sad)`);
        return;
      }
      if (!pets.moodNames().includes(mood)) {
        toast(ui, `Unknown mood "${arg.slice(0, 20)}". Try: ${pets.moodNames().join(', ')}`);
        return;
      }
      // Animated pet view (bounces through the mood's frames).
      const frames = pets.petFrames(mood);
      if (typeof ui.showPet === 'function' && ui.showPet(mood, frames)) {
        // Refresh the frames when the live list lands (richer animation).
        pets.loadLiveMood(mood).then((list) => {
          try { if (list && list.length && typeof ui.setPetFrames === 'function') ui.setPetFrames(list); } catch { /* best effort */ }
        }).catch(() => {});
        return;
      }
      info(ui, `${pets.petFor(mood)}\n(${mood})`);
      return;
    }
    case 'shortcuts':
      info(ui, SHORTCUTS);
      return;
    case 'arcade':
    case 'game':
    case 'piano':
    case 'tiles': {
      // The offline piano, on demand. Works with no network at all:
      // A S D F J K L ; play the eight notes, /game free plays around with
      // no balls falling, /game 2 starts song 2 (1-10) — plain /game
      // shuffles random songs by default (* toggles); esc returns.
      const gameArg = String(arg || '').trim().toLowerCase();
      if (ui && typeof ui.showGame === 'function') {
        const opts = { kind: 'piano' };
        if (gameArg === 'free') opts.free = true;
        else if (/^([1-9]|10)$/.test(gameArg)) opts.song = Number(gameArg) - 1;
        if (ui.showGame(opts)) return;
      }
      toast(ui, 'The arcade needs the full TUI view — unavailable here.');
      return;
    }
    case 'pong':
    case 'pingpong': {
      // Pong vs the machine. Win the match to level up (the bot gets
      // faster every level); three match losses restart the run at level 1.
      // ↑/↓ (or k/j, w/s) move; Enter continues between matches.
      if (ui && typeof ui.showGame === 'function' && ui.showGame({ kind: 'pong' })) return;
      toast(ui, 'The arcade needs the full TUI view — unavailable here.');
      return;
    }
    case 'bench': {
      // Perf snapshot for THIS process, on demand: micro timings of the hot
      // pure paths plus live memory. High-resolution clock, no timers, no
      // background work — everything here is thrown away right after paint.
      const ms = (fn) => {
        const t0 = process.hrtime.bigint();
        try { fn(); } catch { /* a broken row must not break /bench */ }
        return Number(process.hrtime.bigint() - t0) / 1e6;
      };
      const { getCommandSuggestions } = require('./suggest');
      const paletteMs = ms(() => { for (let i = 0; i < 50; i++) getCommandSuggestions('/'); });
      const { blockMd, wrapVis, visibleCells } = require('./beautify');
      const sample = Array.from({ length: 120 }, (_, i) => `## Heading ${i}\n- bullet with **bold** words ${i}\nA sentence with more words so the wrapper has to do real work here.`).join('\n');
      const mdMs = ms(() => {
        for (let i = 0; i < 10; i++) wrapVis(blockMd(sample), 76, false);
        visibleCells('sanity');
      });
      const kb = require('./piano');
      const gameMs = ms(() => {
        const g = kb.createGame({ width: 40, height: 20 });
        for (let i = 0; i < 500; i++) {
          for (let l = 0; l < kb.LANES; l++) {
            for (const b of g.balls) {
              if (b.lane === l && Math.abs(b.t) <= kb.PERFECT_T) {
                kb.press(g, l);
                break;
              }
            }
          }
          kb.tick(g);
          kb.paint(g);
        }
      });
      const mem = process.memoryUsage();
      const mb = (n) => (n / 1048576).toFixed(1);
      const up = process.uptime();
      const upTxt = up >= 3600 ? `${(up / 3600).toFixed(1)} h` : up >= 60 ? `${Math.floor(up / 60)} min` : `${Math.round(up)} s`;
      info(ui, [
        'Bench — live numbers for this process',
        '',
        `palette build ×50: ${paletteMs.toFixed(1)} ms`,
        `markdown ×10 blocks: ${mdMs.toFixed(1)} ms`,
        `piano sim 500 ticks: ${gameMs.toFixed(1)} ms`,
        `rss ${mb(mem.rss)} MB · heap ${mb(mem.heapUsed)} MB · external ${mb(mem.external)} MB`,
        `uptime ${upTxt} · node ${process.version}`,
      ].join('\n'));
      return;
    }
    case 'commands':
    case 'help': {
      const q = String(arg || '').trim().toLowerCase().replace(/^\/+/, '').split(/\s+/)[0];
      // /help all (or /help advanced) reveals the Advanced tier too.
      if (q === 'all' || q === 'advanced') {
        info(ui, HELP_ALL);
        return;
      }
      if (q) {
        const spec = findSpec(q);
        if (spec) {
          const alias = (spec.aliases && spec.aliases.length) ? `\nAliases: ${spec.aliases.map((a) => '/' + a).join(', ')}` : '';
          info(ui, `/${spec.name}${spec.usage ? ' ' + spec.usage : ''}\n${spec.hint}${alias}\n\n${HELP}`);
        } else {
          const sim = suggestSimilar(q);
          toast(ui, sim.length ? `Unknown command "/${q}". Did you mean ${sim.map((s) => '/' + s).join(', ')}?` : `Unknown command "/${q}". Try /help.`);
        }
        return;
      }
      info(ui, HELP);
      return;
    }
    case 'login': {
      // Local sign-in: gmail -> emailed 6-digit code. The code is requested
      // for ANY gmail (no enumeration), but only a registered account can
      // finish — and the "no account" answer comes only AFTER the correct
      // code, which proves the person owns the mailbox. Esc cancels
      // silently; empty submits and wrong codes re-prompt (never abort).
      const accts = require('./accounts');
      const pets = require('./pets');
      const mail = deps.mail || require('./mail');
      const ask = (step, prompt, censor, onValue) => {
        try {
          if (!ui || typeof ui.showLoginForm !== 'function') { toast(ui, 'Login form unavailable here.'); return; }
        } catch { return; }
        ui.showLoginForm({
          step,
          prompt,
          censor,
          callback: (v) => {
            if (v === null || v === undefined) return; // Esc: silent cancel (form already exited)
            if (!String(v).trim()) { ask(step, prompt, censor, onValue); return; }
            onValue(v);
          },
        });
      };
      // One live prompt closure per gmail: entering the code verifies it,
      // and a wrong code re-asks via the same closure (no re-send).
      const askCodeFor = (g, prompt) => {
        ask('otp', prompt || `Sign in\n\nGmail: ${g}\nEnter the 6-digit code sent to your Gmail: `, false, (otp) => {
          const res = accts.verifyOtp({ gmail: g, otp });
          if (!res.ok) {
            // Re-prompt instead of aborting the wizard (P1-5).
            askCodeFor(g, `${res.error}\n\nGmail: ${g}\nEnter the 6-digit code (try again): `);
            return;
          }
          if (!res.account) {
            // Correct code, no account: only reachable by the mailbox owner.
            toast(ui, `No account for ${g} yet — run /register to create one.`);
            try { if (typeof ui.resetFocus === 'function') ui.resetFocus(); } catch { /* best effort */ }
            return;
          }
          accts.signInSession(res.account.gmail);
          if (typeof ui.setIdentity === 'function') {
            try { ui.setIdentity(res.account.name, res.account.gmail); } catch { /* best effort */ }
          }
          info(ui, `Signed in as ${res.account.name} <${res.account.gmail}>.\n\n${pets.petFor('love')}`);
        });
      };
      const askGmail = (prompt) => {
        ask('email', prompt || 'Sign in\n\nGmail: ', false, (v) => {
          const g = accts.validGmail(v);
          if (!g) {
            askGmail('Invalid Gmail. Try again:\n\nGmail: ');
            return;
          }
          // Issue the code, show the prompt immediately (the SMTP send is
          // async), then send. A failed send paints the code so the user is
          // never stuck staring at a mailbox that will never get mail.
          askCodeFor(g);
          const res = accts.requestOtp(g);
          if (!res.ok) {
            toast(ui, `Could not create a code: ${res.error}`);
            return;
          }
          Promise.resolve()
            .then(() => mail.sendMail({
              to: g,
              subject: 'TUI Browser sign-in code',
              text: `Your TUI Browser sign-in code is: ${res.otp}\n\nIt expires in 10 minutes. Enter it in the TUI Browser sign-in prompt.\n\nIf you didn't request this code, ignore this email.\n\n— TUI Browser`,
            }))
            .then(
              (sent) => {
                if (!sent || !sent.ok) {
                  toast(ui, `Email failed (${(sent && sent.error) || 'send error'}) — your code is ${res.otp}`);
                } else {
                  toast(ui, `Code sent to ${g} — check your Gmail.`);
                }
              },
              (e) => toast(ui, `Email failed (${(e && e.message) || e}) — your code is ${res.otp}`)
            );
        });
      };
      askGmail();
      return;
    }
    case 'cookies': {
      // Session import: cookies exported from your regular browser
      // (Playwright JSON: an array, or { "cookies": [...] }) land in the
      // live browsing profile — no login UI involved at all.
      const file = arg.trim();
      if (!file) {
        toast(ui, 'Usage: /cookies <cookies.json> — export from your browser, then import here.');
        return;
      }
      try {
        if (typeof ui.setStatus === 'function') ui.setStatus('Importing cookies…');
      } catch { /* status never breaks import */ }
      try {
        if (!browser || typeof browser.importCookiesFile !== 'function') { toast(ui, 'Cookie import unavailable here.'); return; }
      } catch { toast(ui, 'Cookie import unavailable here.'); return; }
      browser
        .importCookiesFile(file)
        .then(
          ({ imported, skipped }) => {
            try {
              if (typeof ui.clearStatus === 'function') ui.clearStatus();
            } catch { /* best effort */ }
            info(ui, `Imported ${imported} cookie${imported === 1 ? '' : 's'}${skipped ? ` (${skipped} skipped)` : ''}.`);
          },
          (e) => {
            try {
              if (typeof ui.clearStatus === 'function') ui.clearStatus();
            } catch { /* best effort */ }
            toast(ui, `Cookie import failed: ${e && e.message ? e.message : e}`);
          }
        );
      return;
    }
    case 'logout': {
      // Sign out locally first, then wipe the live browser profile (close
      // first: wiping a live profile corrupts it). Uses the instance's
      // dir, not the default — they differ with custom profiles.
      const accts = require('./accounts');
      let who = null;
      try { who = accts.currentSession(); } catch { /* best effort */ }
      try { accts.signOutSession(); } catch { /* best effort */ }
      try {
        if (typeof ui.setIdentity === 'function') ui.setIdentity('', '');
      } catch { /* best effort */ }
      let dir = '';
      try { dir = browser && browser.profileDir ? browser.profileDir : ''; } catch { /* best effort */ }
      toast(ui, 'Signing out and wiping profile…');
      try {
        if (!browser || typeof browser.close !== 'function') {
          try { require('./browser').Browser.wipeProfile(dir); } catch { /* best effort */ }
          info(ui, who ? `Signed out ${who}. Profile wiped.` : 'Profile wiped. Session cleared.');
          return;
        }
      } catch { /* fall through to close path */ }
      browser
        .close()
        .catch(() => {})
        .then(() => {
          try {
            require('./browser').Browser.wipeProfile(dir);
          } catch {
            /* best effort */
          }
          info(ui, who ? `Signed out ${who}. Profile wiped.` : 'Profile wiped. Session cleared.');
        });
      return;
    }
    case 'quit':
      try {
        if (typeof shutdown === 'function') shutdown(0);
      } catch { /* never throw */ }
      return;
    case 'register': {
      // Real local registration: name -> gmail -> number -> emailed code ->
      // password -> confirm. The account is only created after the code
      // proves the Gmail is real and owned. Stored scrypt-hashed in a 0600
      // vault, signed in on success. Esc cancels silently; empty and invalid
      // submits re-prompt.
      const accts = require('./accounts');
      const pets = require('./pets');
      const mail = deps.mail || require('./mail');
      const ask = (step, prompt, censor, onValue) => {
        try {
          if (!ui || typeof ui.showLoginForm !== 'function') { toast(ui, 'Register form unavailable here.'); return; }
        } catch { return; }
        ui.showLoginForm({
          step,
          prompt,
          censor,
          callback: (v) => {
            if (v === null || v === undefined) return; // Esc: silent cancel
            if (!String(v).trim()) { ask(step, prompt, censor, onValue); return; }
            onValue(v);
          },
        });
      };
      const draft = {};
      const finish = (pw) => {
        const res = accts.register({ ...draft, password: pw });
        if (!res.ok) {
          toast(ui, res.error);
          try { if (typeof ui.resetFocus === 'function') ui.resetFocus(); } catch { /* best effort */ }
          return;
        }
        accts.signInSession(res.account.gmail);
        if (typeof ui.setIdentity === 'function') {
          try { ui.setIdentity(res.account.name, res.account.gmail); } catch { /* best effort */ }
        }
        info(ui, `Registered as ${res.account.name} <${res.account.gmail}>.\n\n${pets.petFor('love')}`);
      };
      const askPassword = (prompt) => {
        ask('password', prompt || 'Register\n\nPassword: ', true, (pw) => {
          if (String(pw).length < accts.MIN_PASSWORD) {
            askPassword(`Password needs at least ${accts.MIN_PASSWORD} characters.\n\nPassword: `);
            return;
          }
          ask('password', 'Register\n\nConfirm password: ', true, (again) => {
            if (again !== pw) {
              askPassword('Passwords did not match. Start over:\n\nPassword: ');
              return;
            }
            finish(pw);
          });
        });
      };
      // Code prompt closure: wrong code re-asks (no re-send); correct code
      // moves the wizard on to the password steps.
      const askCode = (prompt) => {
        const g = draft.gmail;
        ask('otp', prompt || `Register\n\nGmail: ${g}\nEnter the 6-digit code sent to your Gmail: `, false, (otp) => {
          const res = accts.verifyOtp({ gmail: g, otp });
          if (!res.ok) {
            askCode(`${res.error}\n\nGmail: ${g}\nEnter the 6-digit code (try again): `);
            return;
          }
          askPassword();
        });
      };
      const askNumber = (prompt) => {
        ask('number', prompt || 'Register\n\nNumber: ', false, (v) => {
          if (!accts.validNumber(v)) {
            askNumber('Invalid number. Try again:\n\nNumber: ');
            return;
          }
          draft.number = accts.validNumber(v);
          // Issue the code, show the prompt immediately (the SMTP send is
          // async), then send. A failed send paints the code so the user is
          // never stuck staring at a mailbox that will never get mail.
          askCode();
          const res = accts.requestOtp(draft.gmail);
          if (!res.ok) {
            toast(ui, `Could not create a code: ${res.error}`);
            return;
          }
          Promise.resolve()
            .then(() => mail.sendMail({
              to: draft.gmail,
              subject: 'TUI Browser registration code',
              text: `Your TUI Browser registration code is: ${res.otp}\n\nIt expires in 10 minutes. Enter it in the TUI Browser registration prompt.\n\nIf you didn't request this code, ignore this email.\n\n— TUI Browser`,
            }))
            .then(
              (sent) => {
                if (!sent || !sent.ok) {
                  toast(ui, `Email failed (${(sent && sent.error) || 'send error'}) — your code is ${res.otp}`);
                } else {
                  toast(ui, `Code sent to ${draft.gmail} — check your Gmail.`);
                }
              },
              (e) => toast(ui, `Email failed (${(e && e.message) || e}) — your code is ${res.otp}`)
            );
        });
      };
      const askGmail = (prompt) => {
        ask('email', prompt || 'Register\n\nGmail: ', false, (v) => {
          const g = accts.validGmail(v);
          if (!g) {
            askGmail('Invalid Gmail. Try again:\n\nGmail: ');
            return;
          }
          if (accts.findByGmail(accts.loadAccounts(), g)) {
            // Re-prompt instead of aborting (P1-5): duplicate is recoverable.
            askGmail('That Gmail is already registered. Try another:\n\nGmail: ');
            return;
          }
          draft.gmail = g;
          askNumber();
        });
      };
      ask('name', 'Register\n\nName: ', false, (v) => {
        if (!accts.validName(v)) {
          ask('name', 'Name can\u2019t be empty. Try again:\n\nName: ', false, (v2) => {
            if (!accts.validName(v2)) {
              toast(ui, 'Name can\u2019t be empty.');
              try { if (typeof ui.resetFocus === 'function') ui.resetFocus(); } catch { /* best effort */ }
              return;
            }
            draft.name = accts.validName(v2);
            askGmail();
          });
          return;
        }
        draft.name = accts.validName(v);
        askGmail();
      });
      return;
    }
    case 'resend': {
      // Fresh sign-in code, on demand: /resend <gmail> (or the signed-in
      // gmail when no argument). Useful after Esc-ing out of a wizard — the
      // old code is replaced, so the newest email always wins.
      const accts = require('./accounts');
      const mail = deps.mail || require('./mail');

      const g = accts.validGmail(arg) || accts.currentSession();
      if (!g) {
        toast(ui, 'Usage: /resend <gmail> — sends a fresh sign-in code.');
        return;
      }
      const res = accts.requestOtp(g);
      if (!res.ok) {
        toast(ui, `Could not create a code: ${res.error}`);
        return;
      }
      toast(ui, `Sending a fresh code to ${g}…`);
      Promise.resolve()
        .then(() => mail.sendMail({
          to: g,
          subject: 'TUI Browser sign-in code',
          text: `Your new TUI Browser sign-in code is: ${res.otp}\n\nIt expires in 10 minutes.\n\nIf you didn't request this code, ignore this email.\n\n— TUI Browser`,
        }))
        .then(
          (sent) => {
            if (!sent || !sent.ok) {
              toast(ui, `Email failed (${(sent && sent.error) || 'send error'}) — your code is ${res.otp}`);
            } else {
              toast(ui, `New code sent to ${g} — check your Gmail.`);
            }
          },
          (e) => toast(ui, `Email failed (${(e && e.message) || e}) — your code is ${res.otp}`)
        );
      return;
    }
    case 'play':
      // Same handoff as Shift+Enter, but reachable: most terminals cannot
      // send a distinct Shift+Enter sequence.
      if (typeof ui.playHighlightedVideo === 'function' && ui.playHighlightedVideo()) {
        return;
      }
      toast(ui, 'Nothing playable highlighted. Open results, move to a video, then /play.');
      return;
    case 'open': {
      const target = arg.trim();
      if (!target) {
        // No argument: open what the user is already looking at — the
        // highlighted row, else the current page. No link to type.
        let here = null;
        try {
          if (typeof ui.linkAt === 'function') {
            const row = ui.linkAt();
            if (row && row.url) here = row.url;
          }
        } catch { /* best effort */ }
        if (!here && typeof deps.currentUrl === 'function') {
          const cur = String(deps.currentUrl() || '');
          if (/^https?:\/\//i.test(cur)) here = cur;
        }
        if (!here) {
          toast(ui, 'Nothing to open. Type a URL or search, or highlight a result row.');
          return;
        }
        if (typeof deps.navigate === 'function') { deps.navigate(here); return; }
        toast(ui, 'Open is not wired in this context.');
        return;
      }
      if (typeof deps.navigate === 'function') {
        // URLs navigate directly; anything else searches (matches the bar).
        if (/^https?:\/\//i.test(target) || looksLikeUrlToken(target.split(/\s+/)[0])) {
          const first = target.split(/\s+/)[0];
          if (!/\s/.test(target.trim())) { deps.navigate(target); return; }
          // Multi-word with URL-like first token: still search the full text.
          deps.navigate(searchURLFor(target));
          return;
        }
        deps.navigate(searchURLFor(target));
        return;
      }
      toast(ui, 'Open is not wired in this context. Type the URL in the bar.');
      return;
    }
    case 'back': {
      if (typeof deps.goBack === 'function') {
        const ok = deps.goBack();
        if (ok !== false) return;
        toast(ui, 'Nothing to go back to yet.');
        return;
      }
      toast(ui, 'Use Alt+Left to go back.');
      return;
    }
    case 'forward': {
      if (typeof deps.goForward === 'function') {
        const ok = deps.goForward();
        if (ok !== false) return;
        toast(ui, 'Nothing to go forward to yet.');
        return;
      }
      toast(ui, 'Use Alt+Right to go forward.');
      return;
    }
    case 'reload': {
      if (typeof deps.reload === 'function') {
        const ok = deps.reload();
        if (ok !== false) return;
        toast(ui, 'Nothing to reload yet.');
        return;
      }
      toast(ui, 'Nothing to reload yet.');
      return;
    }
    case 'home': {
      // /home is the recovery command: it resets the BROWSER (fresh engine,
      // fresh renderer, RAM released, stuck pages and bot-wall state gone)
      // and then opens the in-app start dashboard — our own view, so it can
      // never land on a bot wall or an "unsupported browser" page.
      const goHome = () => {
        if (typeof deps.showHome === 'function') {
          try { deps.showHome(); return; } catch { /* fall through to navigate */ }
        }
        if (typeof deps.navigate === 'function') deps.navigate('https://html.duckduckgo.com/html/');
        else toast(ui, 'Home is unavailable here.');
      };
      if (typeof deps.resetBrowser === 'function') {
        toast(ui, 'Resetting the browser, then home…');
        // Navigate either way: a failed reset must not strand the user.
        Promise.resolve(deps.resetBrowser()).then(goHome, goHome);
        return;
      }
      goHome();
      return;
    }
    case 'find': {
      const q = arg.trim();
      if (!q) {
        toast(ui, 'Usage: /find <text> — highlights matches on this page.');
        return;
      }
      if (typeof ui.findInPage === 'function') {
        const count = ui.findInPage(q);
        const st = typeof ui.findStats === 'function' ? ui.findStats() : null;
        if (!count) {
          toast(ui, `No match for "${q.slice(0, 60)}".`, 4000);
        } else {
          // Browser-style find bar summary: matches + lines scanned.
          const lines = st && st.lines ? ` · ${count}/${st.lines} lines` : '';
          toast(ui, `Found ${count} match${count === 1 ? '' : 'es'} for "${q.slice(0, 40)}"${lines}`, 4000);
        }
        return;
      }
      toast(ui, 'Find is unavailable here.');
      return;
    }
    case 'copy': {
      // Copy a link URL: highlighted row, /copy <n> for row N, or a raw URL
      // (scheme-less accepted: github.com -> https://github.com).
      // Native clipboard tools first, terminal OSC52 fallback (works over SSH).
      const tok = (arg.trim().split(/\s+/)[0] || '').trim();
      let target = null;
      if (/^https?:\/\//i.test(tok)) {
        target = tok;
      } else if (tok && looksLikeUrlToken(tok)) {
        target = /^https?:\/\//i.test(tok) ? tok : `https://${tok}`;
      } else if (typeof ui.linkAt === 'function') {
        const row = ui.linkAt(tok ? Number(tok) : undefined);
        if (row && row.url) target = row.url;
      }
      // Still nothing (e.g. reading an article): copy the page you are on.
      if (!target && !tok && typeof deps.currentUrl === 'function') {
        const cur = String(deps.currentUrl() || '');
        if (/^https?:\/\//i.test(cur)) target = cur;
      }
      if (!target) {
        toast(ui, 'Nothing to copy. Highlight a result, use /copy <n>, or /copy <url>.');
        return;
      }
      const { copyText } = require('./clipboard');
      // Instant ack — clipboard tools can stall ~1s on broken X/Wayland,
      // and Enter must never read as dead. The result toast overwrites it.
      // Never the raw URL: a short "Copied link: <domain>" reads better.
      const label = hostOf(target) || 'link';
      toast(ui, `Copying link: ${label}…`);
      copyText(target).then(
        (r) => toast(ui, r.ok ? `Copied link: ${label}` : `Copy failed: ${r.error}`, 4000),
        (e) => toast(ui, `Copy failed: ${e && e.message ? e.message : e}`, 4000)
      );
      return;
    }
    case 'mail': {
      // Email compose in the system mail client: /mail friend@gmail.com.
      // mailto: links on pages work the same way via Enter/click.
      const addr = (arg.trim().split(/\s+/)[0] || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
        toast(ui, 'Usage: /mail friend@gmail.com — opens compose in your system mail client.');
        return;
      }
      if (typeof deps.openExternal === 'function' && deps.openExternal(`mailto:${addr}`)) {
        toast(ui, `Opening compose for ${addr}…`);
        return;
      }
      toast(ui, 'No mail client handler available (tried xdg-open).');
      return;
    }
    case 'bm':
    case 'bookmark':
    case 'bookmarks': {
      const dl = require('./downloads');
      // `/bookmark` (singular) is the same command family, advertised as an
      // alias: it is the quick "save this page" verb, so its whole argument
      // is the title. `/bookmarks add <title>` does the same.
      const saveVerb = cmd === 'bookmark';
      const sub = saveVerb ? 'add' : String(arg).trim().split(/\s+/)[0].toLowerCase();
      if (sub === 'add') {
        const url = typeof deps.currentUrl === 'function' ? deps.currentUrl() : '';
        if (!url) { toast(ui, 'Nothing open to bookmark yet.'); return; }
        const title = (saveVerb ? String(arg).trim() : String(arg).trim().slice(4).trim())
          || (typeof ui.currentTitle === 'function' ? ui.currentTitle() : '')
          || url;
        const r = dl.addBookmark(url, title);
        try { if (r.ok && typeof ui.setBookmarked === 'function') ui.setBookmarked(true); } catch { /* best effort */ }
        toast(ui, r.ok ? (r.duplicate ? 'Already bookmarked.' : 'Webpage added to bookmarks') : r.error, 4000);
        return;
      }
      if (sub === 'open') {
        const n = Number(String(arg).trim().split(/\s+/)[1]);
        const list = dl.loadBookmarks();
        const b = list[Number(n) - 1];
        if (!b) { toast(ui, 'Usage: /bookmarks open <n>. Run /bookmarks first.'); return; }
        if (typeof deps.navigate === 'function') { deps.navigate(b.url); return; }
        info(ui, b.title || b.url);
        return;
      }
      if (sub === 'list' || !sub) {
        const list = dl.loadBookmarks();
        if (!list.length) { toast(ui, 'No bookmarks yet. Run /bookmark on a page you like.'); return; }
        const rows = list.map((b, i) => ({ title: `${i + 1}. ${(b.title || b.url)}`.slice(0, 80), url: b.url, domain: '' }));
        try {
          // Overlay: Esc returns to the page underneath (never blank).
          if (typeof ui.showLinkPicker === 'function') {
            ui.showLinkPicker(rows, null, null, { overlay: true, heading: `Bookmarks (${rows.length}) — Enter opens · Esc back` });
            return;
          }
        } catch { /* fall through */ }
        info(ui, rows.map((r) => r.title).join('\n'));
        return;
      }
      // Bare /bookmarks with unknown sub: show list when possible.
      {
        const list = dl.loadBookmarks();
        if (!list.length) { toast(ui, 'No bookmarks yet. Run /bookmark on a page you like.'); return; }
        const rows = list.map((b, i) => ({ title: `${i + 1}. ${(b.title || b.url)}`.slice(0, 80), url: b.url, domain: '' }));
        try {
          if (typeof ui.showLinkPicker === 'function') {
            ui.showLinkPicker(rows, null, null, { overlay: true, heading: `Bookmarks (${rows.length}) — Enter opens · Esc back` });
            return;
          }
        } catch { /* fall through */ }
        info(ui, rows.map((r) => r.title).join('\n'));
        return;
      }
    }
    case 'history': {
      let h = [];
      try { h = navigator && typeof navigator.getHistory === 'function' ? navigator.getHistory() : []; } catch { h = []; }
      const q = arg.trim().toLowerCase();
      const rows = (q ? h.filter((u) => String(u).toLowerCase().includes(q)) : h)
        .slice(-50).reverse().map((u) => {
          // Titles first: a saved page title, else the host, never a raw URL.
          let title = '';
          try { title = (navigator && typeof navigator.titleFor === 'function') ? navigator.titleFor(u) : ''; } catch { /* best effort */ }
          if (!title) { try { title = new URL(u).hostname.replace(/^www\./, ''); } catch { title = String(u).slice(0, 80); } }
          return { title: title.slice(0, 80), url: u, domain: '' };
        });
      if (!rows.length) { toast(ui, q ? `No history matches "${arg.trim().slice(0, 60)}".` : 'History is empty.'); return; }
      try {
        if (typeof ui.showLinkPicker === 'function') {
          ui.showLinkPicker(rows, null, null, { overlay: true, heading: `History (${rows.length}) — Enter opens · Esc back` });
          return;
        }
      } catch { /* fall through */ }
      info(ui, rows.map((r) => r.title).join('\n'));
      return;
    }
    case 'dl':
    case 'download':
    case 'downloads': {
      const dl = require('./downloads');
      // Context-first /download:
      //   /download            -> the image you are looking at (gallery /
      //                           inline art), else the highlighted row,
      //                           else the page's own image
      //   /download <n>        -> row N of the visible list
      //   /download <url>      -> that URL
      //   /download list       -> this session's saved files
      // Files always land in ~/Downloads (a <dir> arg is still accepted).
      const toks = String(arg).trim().split(/\s+/).filter(Boolean);
      const sub = (toks[0] || '').toLowerCase();
      const dest = toks[1] || null;
      if (sub === 'list') {
        const items = dl.getDownloads();
        if (!items.length) { toast(ui, 'No downloads yet. View an image, then /download.'); return; }
        // Filename + size only — the full path/URL is noise for the user.
        const base = (p) => { try { return require('path').basename(String(p)); } catch { return String(p); } };
        info(ui, items.map((d, i) => `${i + 1}. ${base(d.path)} (${d.bytes} bytes)`).join('\n'));
        return;
      }
      let target = null;
      if (!arg.trim()) {
        // No argument = whatever is on screen right now: the viewed image
        // first, then the highlighted row. Never ask the user for a link.
        try {
          if (typeof ui.currentImageUrl === 'function') target = ui.currentImageUrl();
        } catch { target = null; }
        if (!target) {
          try {
            if (typeof ui.linkAt === 'function') {
              const row = ui.linkAt();
              if (row && row.url) target = row.url;
            }
          } catch { target = null; }
        }
        if (!target) {
          toast(ui, 'No image on screen. Open one (/gallery, Tab), highlight a row, or /download <url>.');
          return;
        }
      }
      const n = Number(sub);
      if (!target && Number.isInteger(n) && n > 0) {
        // Explicit row number resolves against the visible list (P1-4).
        try {
          if (typeof ui.downloadTargetAt === 'function') target = ui.downloadTargetAt(n);
          else if (typeof ui.galleryRows === 'function' && typeof ui.videoRows === 'function') {
            const pick = (arr, i) => (Array.isArray(arr) ? arr[Number(i) - 1] : null);
            const im = pick((ui.galleryRows() || []).map((r) => r.url), n) || null;
            const vd = pick((ui.videoRows() || []).map((r) => r.url), n) || null;
            target = vd || im;
          }
        } catch { target = null; }
        if (!target) {
          toast(ui, `Nothing downloadable at ${n}. Run /gallery or /videos to see numbers, then /download <n>.`);
          return;
        }
      } else if (!target && /^https?:\/\//i.test(toks[0] || '')) {
        target = toks[0];
      } else if (!target) {
        toast(ui, 'Nothing to download. View an image, highlight a row, or /download <url>.');
        return;
      }
      try {
        if (typeof ui.setStatus === 'function') ui.setStatus(`Downloading ${target.slice(0, 60)}…`);
      } catch { /* status never breaks downloads */ }
      dl.downloadUrl(target, { dest: dest || undefined, referer: typeof deps.currentUrl === 'function' ? deps.currentUrl() : undefined }).then(
        (r) => {
          try {
            if (typeof ui.clearStatus === 'function') ui.clearStatus();
          } catch { /* best effort */ }
          if (r.ok) toast(ui, `Saved: ${r.path} (${(r.bytes || 0)} bytes)`);
          else toast(ui, r.error || 'Download failed.');
        },
        (e) => {
          try {
            if (typeof ui.clearStatus === 'function') ui.clearStatus();
          } catch { /* best effort */ }
          toast(ui, `Download failed: ${e && e.message ? e.message : e}`);
        }
      );
      return;
    }
    case 'video':
    case 'videos': {
      // Selectable titles: every detected video (YouTube title, anime ep
      // name, og:title...) becomes a numbered row. Enter plays the row.
      // The row mpv is actually playing gets a ▶ marker: live player
      // state first (exact even after /next), last-known head as fallback.
      const paint = (mark) => (typeof ui.showVideos === 'function' && ui.showVideos(mark));
      const showHint = () => toast(ui, 'No videos on this page. Open a watch/episode page, then /videos.');
      let syncMark = null;
      try { syncMark = (typeof deps.getNowPlaying === 'function' && deps.getNowPlaying()) || null; } catch { syncMark = null; }
      const done = (mark) => {
        if (!paint(mark)) showHint();
      };
      if (syncMark && typeof deps.mpvNowPlaying === 'function') {
        deps.mpvNowPlaying().then(
          (live) => done(live && live.url ? { url: live.url, title: live.title || '', fallbackUrl: syncMark.url } : syncMark),
          () => done(syncMark)
        );
        return;
      }
      done(syncMark);
      return;
    }
    case 'watch': {
      // /watch 2 plays video 2 by title; bare /watch lists titles to pick.
      // N resolves against the visible list first (YT picker included).
      const n = Number(String(arg).trim().split(/\s+/)[0]);
      if (arg.trim() && typeof ui.playVideoAt === 'function') {
        const url = ui.playVideoAt(n);
        if (url) return;
        toast(ui, `No video ${arg.trim().slice(0, 20)}. Run /videos to see titles, then /watch <n>.`);
        return;
      }
      if (typeof ui.showVideos === 'function' && ui.showVideos()) return;
      toast(ui, 'No videos on this page. Open a watch/episode page, then /videos.');
      return;
    }
    case 'queue': {
      // Up-next display: what mpv will roll through after the current
      // song/video. Titles only — Enter on a row plays it right now.
      if (typeof deps.getQueue !== 'function') {
        toast(ui, 'Queue is unavailable here.');
        return;
      }
      const q = deps.getQueue() || [];
      if (!q.length) {
        toast(ui, 'Nothing queued yet. Enter a video while one is playing to queue it next.');
        return;
      }
      const titleOf = (it, i) => {
        if (it && typeof it === 'object') return String(it.title || '').trim() || hostOf(it.url) || `video ${i + 1}`;
        return hostOf(it) || `video ${i + 1}`;
      };
      const urlOf = (it) => (it && typeof it === 'object' ? it.url : it);
      const rows = q.slice(0, 25).map((it, i) => ({
        title: `${i === 0 ? '▶ NOW  ' : `${i + 1}.  `}${titleOf(it, i)}`.slice(0, 80),
        url: urlOf(it),
        domain: '',
        video: true,
        queue: true,
      }));
      try {
        // Overlay picker: Enter plays the picked item right now (the running
        // player jumps to it; no second video ever starts).
        if (typeof ui.showLinkPicker === 'function') {
          ui.showLinkPicker(rows, null, null, { overlay: true, heading: `Queue (${q.length}) — Enter plays now · Esc back` });
          return;
        }
      } catch { /* fall through */ }
      info(ui, `Up next (${q.length}):\n\n${q.slice(0, 25).map((it, i) => `${i === 0 ? '▶ NOW' : `  ${i + 1}.`} ${titleOf(it, i)}`).join('\n')}`);
      return;
    }
    case 'next': {
      // Skip to the next queued song/video in the running mpv.
      if (typeof deps.mpvNext !== 'function') {
        toast(ui, 'Player control is unavailable here.');
        return;
      }
      toast(ui, 'Skipping…');
      deps.mpvNext().then(
        (ok) => {
          if (ok) toast(ui, 'Skipped to next.');
          else toast(ui, 'No player answering (nothing playing?). Enter on a video to start.');
        },
        () => toast(ui, 'No player answering (nothing playing?). Enter on a video to start.')
      );
      return;
    }
    case 'stop': {
      // Stop the running mpv outright.
      if (typeof deps.mpvStop !== 'function') {
        toast(ui, 'Player control is unavailable here.');
        return;
      }
      deps.mpvStop().then(
        (ok) => toast(ui, ok ? 'Stopped.' : 'No player answering (already stopped?).'),
        () => toast(ui, 'No player answering (already stopped?).')
      );
      return;
    }
    case 'gallery':
    case 'images': {
      const q = arg.trim();
      if (!q) {
        // No query: this page's photos, phone-gallery style. Check the
        // return value — a page with no images used to swallow the command
        // silently (the old call ignored showGalleryGrid()'s false).
        if (typeof ui.showGalleryGrid === 'function' && ui.showGalleryGrid()) return;
        if (typeof ui.showGallery === 'function' && ui.showGallery()) return;
        toast(ui, 'No images on this page. Try /gallery <query> for a web image search.');
        return;
      }
      // Image search on the web (Bing Images): thumbnails + full URLs.
      try { if (typeof ui.setStatus === 'function') ui.setStatus(`Searching images: ${q.slice(0, 50)}…`); } catch { /* best effort */ }
      const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
      fetch(`https://www.bing.com/images/search?q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': ua } }).then(async (res) => {
        try { if (typeof ui.clearStatus === 'function') ui.clearStatus(); } catch { /* best effort */ }
        if (!res.ok) { toast(ui, `Image search failed (${res.status}).`); return; }
        const rows = parseImageResults(await res.text());
        if (!rows.length) { toast(ui, `No image results for "${q.slice(0, 40)}".`); return; }
        try {
          if (typeof ui.showLinkPicker === 'function') {
            ui.showLinkPicker(rows.map((r, i) => ({ title: `${i + 1}. ${r.title}`.slice(0, 80), url: r.full, domain: '', thumb: r.thumb, image: true })), null, null, { overlay: true, heading: `Images (${rows.length}) — Enter opens · Esc back` });
            return;
          }
        } catch { /* fall through */ }
        info(ui, rows.map((r, i) => `${i + 1}. ${r.title}`).join('\n'));
      }).catch(() => {
        try { if (typeof ui.clearStatus === 'function') ui.clearStatus(); } catch { /* best effort */ }
        toast(ui, 'Image search failed.');
      });
      return;
    }
    case 'pdf': {
      // PDF-only web search. NOT a URL opener — users don't paste links for
      // PDFs: they search, see (pdf) markers in the rows, and Enter opens
      // the in-app viewer. Plain "filetype:pdf" scopes whatever engine
      // answers (DDG/Google/Bing all understand it).
      const q = String(arg || '').trim();
      if (!q) {
        toast(ui, 'Usage: /pdf <query> — PDF-only search (filetype:pdf). PDF links open in-app.');
        return;
      }
      if (typeof deps.search === 'function') {
        deps.search(`filetype:pdf ${q}`);
        return;
      }
      toast(ui, 'Search is not available here.');
      return;
    }
    case 'feeds':
    case 'rss': {
      // RSS/Atom reader: fetch the URL, show its items as an overlay
      // picker (Enter opens a row; Esc returns to the page). Shared
      // 10-minute cache + 8 s raced timeout in src/feeds.js.
      const target = String(arg || '').trim();
      if (!/^https?:\/\//i.test(target)) {
        toast(ui, 'Give me a feed URL: /feeds https://news.ycombinator.com/rss');
        return;
      }
      const fd = require('./feeds');
      if (!feedCache) feedCache = fd.createFeedCache();
      toast(ui, 'Reading feed…');
      fd.fetchFeed(target, { cache: feedCache }).then((r) => {
        try {
          if (!r || !r.ok) {
            toast(ui, `Feed failed: ${(r && r.error) || 'unknown error'}`);
            return;
          }
          if (!r.items.length) {
            toast(ui, 'Feed has no items.');
            return;
          }
          const rows = r.items.slice(0, 40).map((it, i) => ({
            title: `${i + 1}. ${it.title || it.link}`.slice(0, 90),
            url: it.link,
            domain: hostOf(it.link),
          })).filter((row) => /^https?:\/\//i.test(row.url || ''));
          if (typeof ui.showLinkPicker === 'function' && rows.length) {
            ui.showLinkPicker(rows, null, null, { overlay: true, heading: `${r.title || 'Feed'} (${r.items.length}) — Enter opens · Esc back` });
            return;
          }
          if (!rows.length) {
            toast(ui, 'Feed items carry no links.');
            return;
          }
          info(ui, `${r.title || 'Feed'}:\n\n${r.items.slice(0, 25).map((it, i) => `${i + 1}. ${it.title || it.link}`).join('\n')}`);
        } catch { /* paint is best-effort */ }
      });
      return;
    }
    case 'git': {
      // Repo card: parse a GitHub/GitLab URL (the argument, else the page
      // you are on) and read the public API — no git, no clone. Shared
      // 10-minute cache; the card paints like any other text view.
      const gc = require('./gitcard');
      const target = String(arg || '').trim() || (typeof deps.currentUrl === 'function' ? String(deps.currentUrl() || '') : '');
      if (!gc.parseRepoUrl(target)) {
        toast(ui, 'Not a GitHub/GitLab repo link — try /git https://github.com/owner/repo');
        return;
      }
      if (!gitCardCache) gitCardCache = gc.createRepoCache();
      toast(ui, 'Reading repo…');
      gc.fetchRepoCard(target, { cache: gitCardCache }).then((r) => {
        try {
          if (r && r.ok) info(ui, r.lines.join('\n'));
          else toast(ui, `Repo lookup failed: ${(r && r.error) || 'unknown error'}`);
        } catch { /* paint is best-effort */ }
      });
      return;
    }
    case 'img': {
      // /img 2 renders image 2 as overlay (graphics terms) or ASCII art
      // (plain terms — works everywhere). Bare /img lists the gallery.
      const n = Number(String(arg).trim().split(/\s+/)[0]);
      if (arg.trim() && typeof ui.showImageAt === 'function') {
        const st = ui.showImageAt(n);
        if (st === 'no-media') {
          toast(ui, `No image ${arg.trim().slice(0, 20)}. Run /gallery to see titles, then /img <n>.`);
        }
        return;
      }
      if (typeof ui.showGallery === 'function' && ui.showGallery()) return;
      toast(ui, 'Usage: /img <n>. Run /gallery to see image titles first.');
      return;
    }
    case 'ai': {
      // OpenRouter free-tier answers (src/openrouter.js): page-aware when
      // a page is open, standalone otherwise. Thread kept per session.
      runAiChat(arg, deps);
      return;
    }
    case 'gemini': {
      // Retired: muscle memory lands here. Same conversation, one note.
      toast(ui, '/gemini is retired — /ai answers via OpenRouter free models now.', 4000);
      runAiChat(arg, deps);
      return;
    }
    case 'ai-key': {
      // OpenRouter API key (0600 file, never echoed back). Free tier:
      // models ending in :free need no credits.
      const { saveKey, loadKey, clearKey, maskKey, AI_NO_KEY } = require('./openrouter');
      const sub = arg.trim().split(/\s+/)[0].toLowerCase();
      if (!arg.trim()) {
        const has = !!loadKey();
        info(ui,
          has
            ? `OpenRouter key: ${maskKey(loadKey())} (active — /ai answers with it)\nRun /ai <question> any time.`
            : AI_NO_KEY
        );
        return;
      }
      if (sub === 'clear') {
        clearKey();
        toast(ui, 'OpenRouter key cleared. /ai will show the setup steps again.');
        return;
      }
      const key = arg.trim().split(/\s+/)[0];
      if (key.length < 12 || /\s/.test(key)) {
        toast(ui, 'That does not look like an OpenRouter key (sk-or-…). Nothing was saved.');
        return;
      }
      if (saveKey(key)) {
        toast(ui, `OpenRouter key saved ${maskKey(key)}. /ai answers via free models now.`);
      } else {
        toast(ui, 'Could not save the key. Nothing was stored.');
      }
      return;
    }
    case 'gemini-key': {
      // Retired with /gemini. Old keys are Google keys — not valid here.
      toast(ui, 'The Gemini key is retired — /ai uses an OpenRouter key now (free tier). Try /ai-key.', 5000);
      return;
    }
    case 'quality': {
      const { QUALITIES, DEFAULT_QUALITY, normalizeQuality, describeQuality } = require('./quality');
      const tok = String(arg || '').trim().toLowerCase().replace(/p$/, '');
      if (!tok) {
        const cur = (config && config.quality) || DEFAULT_QUALITY;
        toast(ui, `Quality: ${describeQuality(cur)} — Usage: /quality 360|480|720|1080|best.`);
        return;
      }
      const q = normalizeQuality(tok);
      if (!q) {
        toast(ui, `Unknown quality "${arg.trim().slice(0, 20)}". Try: ${QUALITIES.join(', ')}`);
        return;
      }
      try {
        if (config) config.quality = q;
        if (typeof saveConfig === 'function' && config) saveConfig(config);
      } catch { /* persist is best-effort */ }
      // Push the pick into a live player: its next queued track resolves
      // at the new quality, so the setting visibly works mid-session.
      try { if (typeof deps.pushQuality === 'function') deps.pushQuality(q); } catch { /* push is best-effort */ }
      toast(ui, `Quality: ${describeQuality(q)} — Enter plays fullscreen at this quality.`);
      return;
    }
    case 'vo': {
      // Video output driver: auto chains gpu→xv→x11 in one spawn; pin one
      // (e.g. /vo x11) when the picture stays black (Intel MESA etc.).
      // Takes effect on the next play — no restart needed.
      const { VOS, DEFAULT_VO, normalizeVo, describeVo } = require('./quality');
      const tok = String(arg || '').trim().toLowerCase();
      if (!tok) {
        const cur = (config && config.vo) || DEFAULT_VO;
        toast(ui, `Video output: ${describeVo(cur)} — Usage: /vo ${VOS.join('|')}.`);
        return;
      }
      const v = normalizeVo(tok);
      if (!v) {
        toast(ui, `Unknown video output "${arg.trim().slice(0, 20)}". Try: ${VOS.join(', ')}`);
        return;
      }
      try {
        if (config) config.vo = v;
        if (typeof saveConfig === 'function' && config) saveConfig(config);
      } catch { /* persist is best-effort */ }
      toast(ui, `Video output: ${describeVo(v)} — applies to the next play.`);
      return;
    }
    case 'yt':
    case 'youtube':
    case 'yts': {
      // Fast YouTube path: yt-dlp search -> Invidious -> Playwright fallback.
      // Title-only picker, Enter plays in mpv. A YouTube URL plays directly.
      const q = String(arg || '').trim().slice(0, 120);
      if (!q) {
        let detail = '';
        try { detail = require('./yt').checkPlayerDeps().detail || ''; } catch { /* best effort */ }
        toast(ui, `Usage: /yt <query> — e.g. /yt gotham chess. ${detail}`.trim());
        return;
      }
      try {
        const ytMod = require('./yt');
        if (typeof ytMod.isYouTubeVideoUrl === 'function' && ytMod.isYouTubeVideoUrl(q)) {
          if (typeof deps.playUrl === 'function') {
            deps.playUrl(q);
            return;
          }
          toast(ui, 'Player handoff is unavailable here — open this URL in mpv directly.');
          return;
        }
      } catch { /* fall through to search */ }
      try {
        // The wave is the one loading animation: show it during the search
        // instead of the footer spinner (HANDOVER §6.4). hideLoading owns
        // every exit path below (resolve + reject + navigate fallback).
        if (typeof ui.showLoading === 'function') ui.showLoading('Searching YouTube', q.slice(0, 60), 'yt-dlp → Invidious → fallback…');
        else if (typeof ui.setStatus === 'function') ui.setStatus(`Searching YouTube for ${q.slice(0, 60)}…`);
      } catch { /* status never breaks search */ }
      const yt = require('./yt');
      yt.searchYouTube(q, { limit: 30 }).then(
        (res) => {
          try {
            if (typeof ui.hideLoading === 'function') ui.hideLoading();
            if (typeof ui.clearStatus === 'function') ui.clearStatus();
          } catch { /* best effort */ }
          const rows = (res && res.rows) || [];
          if (rows.length && typeof ui.showYouTubePicker === 'function') {
            ui.showYouTubePicker(rows, q);
            return;
          }
          // Fallback: Playwright scrape of youtube.com/results (slow, bot-wall prone).
          if (typeof deps.navigate === 'function') {
            deps.navigate(yt.buildYouTubeSearchUrl(q));
            return;
          }
          const why = res && res.error ? ` ${String(res.error).slice(0, 200)}` : '';
          toast(ui, `No YouTube results for "${q.slice(0, 60)}".${why} Check: yt-dlp -U · network · player.log`);
        },
        (e) => {
          try {
            if (typeof ui.hideLoading === 'function') ui.hideLoading();
            if (typeof ui.clearStatus === 'function') ui.clearStatus();
          } catch { /* best effort */ }
          if (typeof deps.navigate === 'function') {
            try { deps.navigate(yt.buildYouTubeSearchUrl(q)); return; } catch { /* fall through */ }
          }
          toast(ui, `YouTube search failed: ${e && e.message ? e.message : e}`);
        }
      );
      return;
    }
    default: {
      if (!raw) {
        toast(ui, 'Type /help for commands.');
        return;
      }
      // Settings-folded commands are gone from the catalog: point at the
      // hub instead of a dead "unknown command".
      const MOVED = { themes: 'settings', vo: 'settings', links: 'settings', quality: 'settings' };
      if (MOVED[raw]) {
        toast(ui, `/${raw} moved into /settings — opening it.`);
        routeCommand('/settings', deps);
        return;
      }
      const sim = suggestSimilar(raw);
      toast(ui, sim.length ? `Unknown command "/${raw}". Did you mean ${sim.map((s) => '/' + s).join(', ')}?` : `Unknown command "${raw}". Try /help.`);
    }
  }
}

module.exports = { routeCommand, SHORTCUTS, HELP, HELP_ALL, AI_NO_KEY: require('./openrouter').AI_NO_KEY };
