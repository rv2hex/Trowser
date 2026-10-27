'use strict';
// One-shot generator: fetch opencode's real theme palettes and write them
// into src/themes.js, mapped onto the 5 roles this browser paints.
const fs = require('fs');
const path = require('path');

const IDS = [
  'oc-2', 'amoled', 'aura', 'ayu', 'carbonfox', 'catppuccin', 'catppuccin-frappe',
  'catppuccin-macchiato', 'cobalt2', 'cursor', 'dracula', 'everforest', 'flexoki',
  'github', 'gruvbox', 'kanagawa', 'lucent-orng', 'material', 'matrix', 'mercury',
  'monokai', 'nightowl', 'nord', 'one-dark', 'onedarkpro', 'opencode', 'orng',
  'osaka-jade', 'palenight', 'rosepine', 'shadesofpurple', 'solarized',
  'synthwave84', 'tokyonight', 'vercel', 'vesper', 'zenburn',
];

const BASE = 'https://cdn.jsdelivr.net/npm/@opencode-ai/ui@latest/src/theme/themes/';

const hex2rgb = (h) => {
  const s = String(h || '').trim().replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (full.length !== 6) return null;
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) };
};
const rgb2hex = ({ r, g, b }) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
// Upstream palettes mix 3-digit (#FFF) and 6-digit hexes; normalize so
// every consumer can rely on one shape.
const norm = (h) => {
  const s = String(h || '').trim().replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(s)) return '#' + s.split('').map((c) => c + c).join('').toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(s)) return '#' + s.toLowerCase();
  return null;
};
// Blend `a` toward `b` by t (0 = a, 1 = b).
const blend = (a, b, t) => {
  const A = hex2rgb(a); const B = hex2rgb(b);
  if (!A || !B) return a;
  return rgb2hex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t });
};

(async () => {
  const out = {};
  for (const id of IDS) {
    try {
      const r = await fetch(BASE + id + '.json');
      if (!r.ok) { console.error('skip', id, r.status); continue; }
      const j = await r.json();
      const p = (j.dark && j.dark.palette) || j.palette || {};
      const bg = norm(p.neutral || p.background);
      const fg = norm(p.ink || p.foreground);
      if (!bg || !fg) { console.error('no palette', id); continue; }
      out[id] = {
        bg,
        fg,
        // Structure colours: the ink pulled back toward the background, so
        // borders and muted text sit correctly on every palette.
        border: blend(fg, bg, 0.78),
        muted: blend(fg, bg, 0.55),
        // opencode palettes carry TWO strong colours: `primary` and
        // `accent`. Both are kept: links/highlights use primary, and the
        // secondary roles (quotes, box titles, rules, loader label) use
        // accent, so a theme looks like itself in more than one place.
        accent: norm(p.primary) || norm(p.accent) || fg,
        alt: norm(p.accent) || norm(p.primary) || fg,
      };
    } catch (e) {
      console.error('fail', id, e.message);
    }
  }
  console.log('fetched', Object.keys(out).length, 'themes');
  const header = `'use strict';

// Theme palettes: every built-in opencode theme, with the real colors
// pulled from @opencode-ai/ui's theme JSONs and mapped onto the roles this
// browser actually paints:
//
//   bg     background      fg     body text
//   border frames + rules  muted  meta text
//   accent primary -> links, highlights, the cursor, the loading wave
//   alt    accent  -> quotes, box titles, the AI answer rules
//
// Both strong colors are used on purpose: a theme should look like itself
// in more than one place, not just wherever one hue happens to land.
//
// 'white' is the transparent default (terminal background, plain text).
// HIGHLIGHTED themes are the vivid ones - pinned to the top of /themes
// with a star, because they are the ones worth trying first.
//
// Regenerate with: node scripts/gen-themes.js
const HIGHLIGHTED = ['matrix', 'synthwave84', 'carbonfox', 'orng', 'lucent-orng', 'rosepine'];

const THEMES = {
  white: {
    bg: null,
    fg: '#ffffff',
    border: '#ffffff',
    muted: '#ffffff',
    accent: '#ffffff',
    alt: '#ffffff',
  },
`;
  const opaque = Object.entries(out);
  // Transparent twins: identical colors, no background, so the terminal's
  // own background (or wallpaper, on translucent terminals) shows
  // through. Named `<theme>-t`, grouped after the opaque ones.
  const twins = opaque.map(([id, t]) => [`${id}-t`, { ...t, bg: null }]);
  const merged = Object.fromEntries([...opaque, ...twins]);
  // Uniqueness guard (BUG-5): two entries with the same full fingerprint
  // are indistinguishable once painted. If a twin ever collides fully
  // with another entry, blend its accent 12% toward its fg — same family,
  // deterministic, and documented here instead of silently duplicated.
  const seen = new Map();
  for (const [id, t] of Object.entries(merged)) {
    const fp = [t.bg, t.fg, t.border, t.muted, t.accent, t.alt].join('|');
    if (seen.has(fp)) {
      const other = seen.get(fp);
      console.error(`collision: ${id} duplicates ${other} — nudging ${id} accent toward fg`);
      merged[id] = { ...t, accent: blend(t.accent, t.fg, 0.12) };
    } else {
      seen.set(fp, id);
    }
  }
  const body = Object.entries(merged)
    .map(
      ([id, t]) =>
        `  ${JSON.stringify(id)}: {\n    bg: ${JSON.stringify(t.bg)},\n    fg: ${JSON.stringify(t.fg)},\n    border: ${JSON.stringify(t.border)},\n    muted: ${JSON.stringify(t.muted)},\n    accent: ${JSON.stringify(t.accent)},\n    alt: ${JSON.stringify(t.alt)},\n  },`
    )
    .join('\n');
  const footer = `
};

function themeNames() {
  return Object.keys(THEMES);
}

// Picker order: highlighted themes first, then the rest, then the
// transparent twins, with 'white' last (it is the fallback, not a look).
function themeList() {
  const star = new Set(HIGHLIGHTED);
  const all = themeNames();
  const twins = all.filter((n) => n !== 'white' && n.endsWith('-t'));
  const solid = all.filter((n) => n !== 'white' && !n.endsWith('-t'));
  const clear = solid.filter((n) => !star.has(n));
  return [...HIGHLIGHTED.filter((n) => THEMES[n]), ...clear, ...twins, 'white'];
}

function isHighlightedTheme(name) {
  return HIGHLIGHTED.indexOf(name) !== -1;
}

// Transparent themes paint no background of their own.
function isTransparentTheme(name) {
  const t = THEMES[name];
  return !!(t && t.bg === null);
}

function getTheme(name) {
  if (name && Object.prototype.hasOwnProperty.call(THEMES, name)) {
    return { name, ...THEMES[name] };
  }
  return { name: 'white', ...THEMES.white };
}

module.exports = { THEMES, HIGHLIGHTED, themeNames, themeList, isHighlightedTheme, isTransparentTheme, getTheme };
`;
  fs.writeFileSync(path.join(__dirname, '..', 'src', 'themes.js'), header + body + footer);
  console.log('wrote src/themes.js');
})();