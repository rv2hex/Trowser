'use strict';

// Single source of truth for slash commands (Phase 3).
// Every routable name, alias, usage string, hint and group lives here.
// suggest.js (palette), commands.js (HELP/SHORTCUTS/routing) and the
// footer hints are all generated from this table so they cannot drift.
//
// Fields:
//   name    - canonical name (lowercase, no slash)
//   aliases - other spellings that route identically
//   usage   - arg placeholder shown in palette/HELP, e.g. '<n>' or '[filter]'
//             empty string = takes no arg
//   hint    - short human description (no leading slash)
//   group   - Media | Navigate | Read+AI | Account | App (section grouping
//             in the `/` palette and HELP)
//   palette - visibility in the `/` palette and default HELP:
//             absent    = everyday command (listed)
//             'search'  = setup/power-user, appears only while typing
//             'hidden'  = owned by the /settings hub, never listed
//                         (still routable; /help all shows everything)
const SPEC = [
  { name: 'yt', aliases: ['youtube', 'yts'], usage: '<query>', hint: 'fast YouTube search: /yt gotham chess', group: 'Media' },
  { name: 'videos', aliases: ['video'], usage: '', hint: 'list page videos with titles to pick', group: 'Media' },
  { name: 'watch', aliases: [], usage: '<n>', hint: 'play video N: /watch 2', group: 'Media' },
  { name: 'gallery', aliases: ['images'], usage: '', hint: 'list page images with titles to pick', group: 'Media' },
  { name: 'quality', aliases: [], usage: '[360|480|720|1080|best]', hint: 'playback quality (data saver) with smart client fallback', group: 'Media', palette: 'hidden' },
  { name: 'play', aliases: [], usage: '', hint: 'play highlighted video (queued when one is already playing)', group: 'Media' },
  { name: 'queue', aliases: [], usage: '', hint: 'show what you queued to play next', group: 'Media' },
  { name: 'next', aliases: [], usage: '', hint: 'skip to next in the running mpv', group: 'Media' },
  { name: 'stop', aliases: [], usage: '', hint: 'stop the running mpv', group: 'Media' },
  { name: 'download', aliases: ['dl', 'downloads'], usage: '[n-or-url]', hint: 'save the image on screen (or row N / a URL)', group: 'Media' },
  { name: 'open', aliases: [], usage: '[url-or-search]', hint: 'open the highlighted/current link, or a URL/search', group: 'Navigate' },
  { name: 'back', aliases: [], usage: '', hint: 'go back (also Alt+Left)', group: 'Navigate' },
  { name: 'forward', aliases: [], usage: '', hint: 'go forward (also Alt+Right)', group: 'Navigate' },
  { name: 'reload', aliases: [], usage: '', hint: 'reload current page', group: 'Navigate' },
  { name: 'home', aliases: [], usage: '', hint: 'reset and open the start dashboard', group: 'Navigate' },
  { name: 'find', aliases: [], usage: '<text>', hint: 'highlight text: /find word', group: 'Read+AI' },
  { name: 'copy', aliases: [], usage: '[n-or-url]', hint: 'copy the highlighted link or this page', group: 'Read+AI' },
  { name: 'ai', aliases: [], usage: '[question]', hint: 'AI answer via OpenRouter free models: page question or standalone', group: 'Read+AI' },
  { name: 'ai-key', aliases: [], usage: '[key|clear]', hint: 'save your OpenRouter API key (free tier) for /ai', group: 'Read+AI', palette: 'search' },
  { name: 'pdf', aliases: [], usage: '<query>', hint: 'PDF-only web search (filetype:pdf); PDF links open in-app', group: 'Read+AI' },
  { name: 'feeds', aliases: ['rss'], usage: '<url>', hint: 'read an RSS/Atom feed as a picker: /feeds <url>', group: 'Read+AI' },
  { name: 'git', aliases: [], usage: '[url]', hint: 'repo card for a GitHub/GitLab link (no clone): /git', group: 'Read+AI', palette: 'search' },
  { name: 'bookmarks', aliases: ['bm', 'bookmark'], usage: '[add|open|list]', hint: 'browse saved pages; /bookmark saves this page', group: 'Navigate' },
  { name: 'history', aliases: [], usage: '[filter]', hint: 'search history: /history cats', group: 'Navigate' },
  { name: 'mail', aliases: [], usage: '<addr>', hint: 'compose email: /mail friend@gmail.com', group: 'Navigate' },
  { name: 'cookies', aliases: [], usage: '<file>', hint: 'import browser cookies from a file', group: 'Account', palette: 'search' },
  { name: 'profile', aliases: [], usage: '', hint: 'show account + session info', group: 'Account' },
  { name: 'pets', aliases: [], usage: '[mood]', hint: 'live mood pet: /pets sad', group: 'Account' },
  { name: 'login', aliases: [], usage: '', hint: 'sign in (local account with Gmail OTP)', group: 'Account', palette: 'hidden' },
  { name: 'logout', aliases: [], usage: '', hint: 'sign out + wipe the saved session', group: 'Account', palette: 'hidden' },
  { name: 'register', aliases: [], usage: '', hint: 'create a local account with Gmail OTP verification', group: 'Account', palette: 'hidden' },
  { name: 'resend', aliases: [], usage: '', hint: 'send a new OTP to the signed-in Gmail', group: 'Account', palette: 'hidden' },
  { name: 'settings', aliases: [], usage: '', hint: 'themes · video quality · links · account · details', group: 'App' },
  { name: 'shortcuts', aliases: ['shotcuts'], usage: '', hint: 'view all keys', group: 'App' },
  { name: 'game', aliases: ['arcade', 'piano', 'tiles'], usage: '[free|1-10]', hint: 'offline piano — 10 songs on A S D F J K L ;, random by default, /game free plays around', group: 'App' },
  { name: 'pong', aliases: ['pingpong'], usage: '', hint: 'pong vs the machine — win to level up; 3 losses restart at level 1', group: 'App' },
  { name: 'bench', aliases: [], usage: '', hint: 'perf snapshot: timings + live memory', group: 'App', palette: 'search' },
  { name: 'help', aliases: ['commands'], usage: '[command]', hint: 'list commands', group: 'App' },
  { name: 'quit', aliases: [], usage: '', hint: 'quit the browser', group: 'App' },
];

function allNames() {
  const out = [];
  for (const c of SPEC) {
    out.push(c.name);
    for (const a of c.aliases || []) out.push(a);
  }
  return out;
}

function findSpec(token) {
  const t = String(token || '').toLowerCase();
  for (const c of SPEC) {
    if (c.name === t) return c;
    if ((c.aliases || []).includes(t)) return c;
  }
  return null;
}

function paletteLabel(c) {
  return '/' + c.name + (c.usage ? ' ' + c.usage : '');
}

// Help text. The default view lists exactly the everyday set the `/`
// palette opens with; setup ('search') and settings-hub ('hidden')
// commands appear only in /help all — routing is unaffected either way.
function buildHelp(tier) {
  const all = String(tier || '').toLowerCase() === 'all' || String(tier || '').toLowerCase() === 'advanced';
  const groups = ['Media', 'Navigate', 'Read+AI', 'Account', 'App'];
  const lines = [];
  for (const g of groups) {
    const rows = SPEC.filter((x) => x.group === g && (all || !x.palette));
    if (!rows.length) continue;
    lines.push(`— ${g} —`);
    for (const c of rows) {
      const left = `/${c.name}${c.usage ? ' ' + c.usage : ''}`;
      const alias = (c.aliases && c.aliases.length) ? ` (aliases: ${c.aliases.map((a) => '/' + a).join(', ')})` : '';
      lines.push(`${left} — ${c.hint}${alias}`);
    }
    lines.push('');
  }
  if (!all) lines.push('More (setup / power-user) commands: /help all · account & quality live in /settings');
  return lines.join('\n').trim();
}

function buildShortcuts() {
  return [
    'type ............. suggestions appear live under the bar',
    'down ............. next suggestion; one more runs the search',
    'up / down ........ move selection (results; Enter opens, YT list auto-previews thumb)',
    '/ ................ command palette: everyday commands in sections; type to filter',
    '/yt <query> ...... fast YouTube titles only, Enter plays in mpv',
    'tab / right ...... accept the highlighted suggestion (bar)',
    'tab .............. thumbnail (results) / 60-40 gallery pane (article)',
    'shift+enter ...... play video externally, or queue next if playing',
    '/play ............ play highlighted video (queues if one is already playing)',
    '/queue ........... show what you queued to play next',
    '/next ............ skip to next in the running mpv',
    '/stop ............ stop the running mpv',
    '/watch <n> ....... play video N by title (see /videos)',
    '/settings ........ all settings in one place (theme, quality, video, links, details)',
    '/videos .......... list this page videos with titles to pick',
    '/gallery ......... image grid: arrows pick, enter open, ctrl+f zoom',
    'left / right ..... back / forward (outside the bar and lists)',
    'alt+left/right ... back / forward (everywhere, even while typing)',
    'alt+up ........... AI digest fullscreen (lists) / page summary (articles)',
    'alt+down ......... collapse AI digest',
    '/ai <q> .......... AI answer (free OpenRouter model; page question or standalone)',
    '/ai-key <key> .... save an OpenRouter API key (free at openrouter.ai/keys)',
    '/pdf <q> ......... PDF-only search: /pdf godot manual',
    'enter ............ open / show image on screen',
    'space ............ open link, scroll page',
    'esc .............. cancel bar, close view, back to page',
    'ctrl+q ........... quit (everywhere)',
    'ctrl+c ........... quit (everywhere)',
    '/<command> ....... ' + SPEC.filter((c) => !c.palette).map((c) => c.name).join(', '),
  ].join('\n');
}

// "did you mean" for unknown commands: prefix + edit-distance-1 matches.
function suggestSimilar(raw) {
  const t = String(raw || '').toLowerCase();
  if (!t) return [];
  const names = SPEC.map((c) => c.name);
  const out = [];
  for (const n of names) {
    if (n.startsWith(t) || t.startsWith(n)) { out.push(n); continue; }
    // edit distance 1 (single insert/delete/substitute)
    if (Math.abs(n.length - t.length) > 1) continue;
    let diff = 0;
    const m = Math.max(n.length, t.length);
    for (let i = 0; i < m; i++) {
      if ((n[i] || '') !== (t[i] || '')) diff++;
      if (diff > 1) break;
    }
    if (diff === 1) out.push(n);
  }
  return out.slice(0, 3);
}

module.exports = { SPEC, allNames, findSpec, paletteLabel, buildHelp, buildShortcuts, suggestSimilar };
