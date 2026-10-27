'use strict';

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
  "oc-2": {
    bg: "#1f1f1f",
    fg: "#f1ece8",
    border: "#4d4c4b",
    muted: "#7d7b79",
    accent: "#fab283",
    alt: "#fab283",
  },
  "amoled": {
    bg: "#000000",
    fg: "#ffffff",
    border: "#383838",
    muted: "#737373",
    accent: "#b388ff",
    alt: "#ff4081",
  },
  "aura": {
    bg: "#15141b",
    fg: "#edecee",
    border: "#454449",
    muted: "#76757a",
    accent: "#a277ff",
    alt: "#ff6767",
  },
  "ayu": {
    bg: "#0f1419",
    fg: "#d6dae0",
    border: "#3b4045",
    muted: "#696d73",
    accent: "#3fb7e3",
    alt: "#f2856f",
  },
  "carbonfox": {
    bg: "#393939",
    fg: "#f2f4f8",
    border: "#626263",
    muted: "#8c8d8f",
    accent: "#33b1ff",
    alt: "#ff8389",
  },
  "catppuccin": {
    bg: "#1e1e2e",
    fg: "#cdd6f4",
    border: "#45465a",
    muted: "#6d7187",
    accent: "#b4befe",
    alt: "#f38ba8",
  },
  "catppuccin-frappe": {
    bg: "#303446",
    fg: "#c6d0f5",
    border: "#51566d",
    muted: "#747a95",
    accent: "#8da4e2",
    alt: "#f4b8e4",
  },
  "catppuccin-macchiato": {
    bg: "#24273a",
    fg: "#cad3f5",
    border: "#494d63",
    muted: "#6f748e",
    accent: "#8aadf4",
    alt: "#f5bde6",
  },
  "cobalt2": {
    bg: "#193549",
    fg: "#ffffff",
    border: "#4c6171",
    muted: "#81909b",
    accent: "#0088ff",
    alt: "#2affdf",
  },
  "cursor": {
    bg: "#181818",
    fg: "#e4e4e4",
    border: "#454545",
    muted: "#747474",
    accent: "#88c0d0",
    alt: "#88c0d0",
  },
  "dracula": {
    bg: "#1d1e28",
    fg: "#f8f8f2",
    border: "#4d4e54",
    muted: "#808083",
    accent: "#bd93f9",
    alt: "#ff79c6",
  },
  "everforest": {
    bg: "#2d353b",
    fg: "#d3c6aa",
    border: "#525553",
    muted: "#78766d",
    accent: "#a7c080",
    alt: "#d699b6",
  },
  "flexoki": {
    bg: "#100f0f",
    fg: "#cecdc3",
    border: "#3a3937",
    muted: "#656460",
    accent: "#da702c",
    alt: "#8b7ec8",
  },
  "github": {
    bg: "#0d1117",
    fg: "#c9d1d9",
    border: "#363b42",
    muted: "#62676e",
    accent: "#58a6ff",
    alt: "#39c5cf",
  },
  "gruvbox": {
    bg: "#282828",
    fg: "#ebdbb2",
    border: "#534f46",
    muted: "#807966",
    accent: "#83a598",
    alt: "#fb4934",
  },
  "kanagawa": {
    bg: "#1f1f28",
    fg: "#dcd7ba",
    border: "#494748",
    muted: "#74726a",
    accent: "#7e9cd8",
    alt: "#d27e99",
  },
  "lucent-orng": {
    bg: "#2a1a15",
    fg: "#eeeeee",
    border: "#554945",
    muted: "#827977",
    accent: "#ec5b2b",
    alt: "#fff7f1",
  },
  "material": {
    bg: "#263238",
    fg: "#eeffff",
    border: "#525f64",
    muted: "#808e92",
    accent: "#82aaff",
    alt: "#89ddff",
  },
  "matrix": {
    bg: "#0a0e0a",
    fg: "#62ff94",
    border: "#1d4328",
    muted: "#327a48",
    accent: "#2eff6a",
    alt: "#c770ff",
  },
  "mercury": {
    bg: "#171721",
    fg: "#dddde5",
    border: "#43434c",
    muted: "#707079",
    accent: "#8da4f5",
    alt: "#8da4f5",
  },
  "monokai": {
    bg: "#272822",
    fg: "#f8f8f2",
    border: "#555650",
    muted: "#858680",
    accent: "#ae81ff",
    alt: "#f92672",
  },
  "nightowl": {
    bg: "#011627",
    fg: "#d6deeb",
    border: "#304252",
    muted: "#61707f",
    accent: "#82aaff",
    alt: "#f78c6c",
  },
  "nord": {
    bg: "#2e3440",
    fg: "#e5e9f0",
    border: "#565c67",
    muted: "#80858f",
    accent: "#88c0d0",
    alt: "#d57780",
  },
  "one-dark": {
    bg: "#282c34",
    fg: "#abb2bf",
    border: "#454953",
    muted: "#636873",
    accent: "#61afef",
    alt: "#56b6c2",
  },
  "onedarkpro": {
    bg: "#1e222a",
    fg: "#abb2bf",
    border: "#3d424b",
    muted: "#5d636d",
    accent: "#61afef",
    alt: "#e06c75",
  },
  "opencode": {
    bg: "#0a0a0a",
    fg: "#eeeeee",
    border: "#3c3c3c",
    muted: "#717171",
    accent: "#fab283",
    alt: "#9d7cd8",
  },
  "orng": {
    bg: "#0a0a0a",
    fg: "#eeeeee",
    border: "#3c3c3c",
    muted: "#717171",
    accent: "#ec5b2b",
    alt: "#fff7f1",
  },
  "osaka-jade": {
    bg: "#111c18",
    fg: "#c1c497",
    border: "#384134",
    muted: "#606851",
    accent: "#2dd5b7",
    alt: "#549e6a",
  },
  "palenight": {
    bg: "#292d3e",
    fg: "#a6accd",
    border: "#45495d",
    muted: "#61667e",
    accent: "#82aaff",
    alt: "#89ddff",
  },
  "rosepine": {
    bg: "#191724",
    fg: "#e0def4",
    border: "#454352",
    muted: "#737182",
    accent: "#9ccfd8",
    alt: "#ebbcba",
  },
  "shadesofpurple": {
    bg: "#1a102b",
    fg: "#f5f0ff",
    border: "#4a415a",
    muted: "#7d758a",
    accent: "#c792ff",
    alt: "#ff7ac6",
  },
  "solarized": {
    bg: "#002b36",
    fg: "#93a1a1",
    border: "#20454e",
    muted: "#426066",
    accent: "#6c71c4",
    alt: "#d33682",
  },
  "synthwave84": {
    bg: "#262335",
    fg: "#ffffff",
    border: "#565361",
    muted: "#888690",
    accent: "#36f9f6",
    alt: "#b084eb",
  },
  "tokyonight": {
    bg: "#1a1b26",
    fg: "#c0caf5",
    border: "#3f4254",
    muted: "#656a83",
    accent: "#7aa2f7",
    alt: "#ff9e64",
  },
  "vercel": {
    bg: "#000000",
    fg: "#ededed",
    border: "#343434",
    muted: "#6b6b6b",
    accent: "#0070f3",
    alt: "#8e4ec6",
  },
  "vesper": {
    bg: "#101010",
    fg: "#ffffff",
    border: "#454545",
    muted: "#7c7c7c",
    accent: "#ffc799",
    alt: "#ff8080",
  },
  "zenburn": {
    bg: "#3f3f3f",
    fg: "#dcdccc",
    border: "#62625e",
    muted: "#86867e",
    accent: "#8cd0d3",
    alt: "#93e0e3",
  },
  "oc-2-t": {
    bg: null,
    fg: "#f1ece8",
    border: "#4d4c4b",
    muted: "#7d7b79",
    accent: "#fab283",
    alt: "#fab283",
  },
  "amoled-t": {
    bg: null,
    fg: "#ffffff",
    border: "#383838",
    muted: "#737373",
    accent: "#b388ff",
    alt: "#ff4081",
  },
  "aura-t": {
    bg: null,
    fg: "#edecee",
    border: "#454449",
    muted: "#76757a",
    accent: "#a277ff",
    alt: "#ff6767",
  },
  "ayu-t": {
    bg: null,
    fg: "#d6dae0",
    border: "#3b4045",
    muted: "#696d73",
    accent: "#3fb7e3",
    alt: "#f2856f",
  },
  "carbonfox-t": {
    bg: null,
    fg: "#f2f4f8",
    border: "#626263",
    muted: "#8c8d8f",
    accent: "#33b1ff",
    alt: "#ff8389",
  },
  "catppuccin-t": {
    bg: null,
    fg: "#cdd6f4",
    border: "#45465a",
    muted: "#6d7187",
    accent: "#b4befe",
    alt: "#f38ba8",
  },
  "catppuccin-frappe-t": {
    bg: null,
    fg: "#c6d0f5",
    border: "#51566d",
    muted: "#747a95",
    accent: "#8da4e2",
    alt: "#f4b8e4",
  },
  "catppuccin-macchiato-t": {
    bg: null,
    fg: "#cad3f5",
    border: "#494d63",
    muted: "#6f748e",
    accent: "#8aadf4",
    alt: "#f5bde6",
  },
  "cobalt2-t": {
    bg: null,
    fg: "#ffffff",
    border: "#4c6171",
    muted: "#81909b",
    accent: "#0088ff",
    alt: "#2affdf",
  },
  "cursor-t": {
    bg: null,
    fg: "#e4e4e4",
    border: "#454545",
    muted: "#747474",
    accent: "#88c0d0",
    alt: "#88c0d0",
  },
  "dracula-t": {
    bg: null,
    fg: "#f8f8f2",
    border: "#4d4e54",
    muted: "#808083",
    accent: "#bd93f9",
    alt: "#ff79c6",
  },
  "everforest-t": {
    bg: null,
    fg: "#d3c6aa",
    border: "#525553",
    muted: "#78766d",
    accent: "#a7c080",
    alt: "#d699b6",
  },
  "flexoki-t": {
    bg: null,
    fg: "#cecdc3",
    border: "#3a3937",
    muted: "#656460",
    accent: "#da702c",
    alt: "#8b7ec8",
  },
  "github-t": {
    bg: null,
    fg: "#c9d1d9",
    border: "#363b42",
    muted: "#62676e",
    accent: "#58a6ff",
    alt: "#39c5cf",
  },
  "gruvbox-t": {
    bg: null,
    fg: "#ebdbb2",
    border: "#534f46",
    muted: "#807966",
    accent: "#83a598",
    alt: "#fb4934",
  },
  "kanagawa-t": {
    bg: null,
    fg: "#dcd7ba",
    border: "#494748",
    muted: "#74726a",
    accent: "#7e9cd8",
    alt: "#d27e99",
  },
  "lucent-orng-t": {
    bg: null,
    fg: "#eeeeee",
    border: "#554945",
    muted: "#827977",
    accent: "#ec5b2b",
    alt: "#fff7f1",
  },
  "material-t": {
    bg: null,
    fg: "#eeffff",
    border: "#525f64",
    muted: "#808e92",
    accent: "#82aaff",
    alt: "#89ddff",
  },
  "matrix-t": {
    bg: null,
    fg: "#62ff94",
    border: "#1d4328",
    muted: "#327a48",
    accent: "#2eff6a",
    alt: "#c770ff",
  },
  "mercury-t": {
    bg: null,
    fg: "#dddde5",
    border: "#43434c",
    muted: "#707079",
    accent: "#8da4f5",
    alt: "#8da4f5",
  },
  "monokai-t": {
    bg: null,
    fg: "#f8f8f2",
    border: "#555650",
    muted: "#858680",
    accent: "#ae81ff",
    alt: "#f92672",
  },
  "nightowl-t": {
    bg: null,
    fg: "#d6deeb",
    border: "#304252",
    muted: "#61707f",
    accent: "#82aaff",
    alt: "#f78c6c",
  },
  "nord-t": {
    bg: null,
    fg: "#e5e9f0",
    border: "#565c67",
    muted: "#80858f",
    accent: "#88c0d0",
    alt: "#d57780",
  },
  "one-dark-t": {
    bg: null,
    fg: "#abb2bf",
    border: "#454953",
    muted: "#636873",
    accent: "#61afef",
    alt: "#56b6c2",
  },
  "onedarkpro-t": {
    bg: null,
    fg: "#abb2bf",
    border: "#3d424b",
    muted: "#5d636d",
    accent: "#61afef",
    alt: "#e06c75",
  },
  "opencode-t": {
    bg: null,
    fg: "#eeeeee",
    border: "#3c3c3c",
    muted: "#717171",
    accent: "#fab283",
    alt: "#9d7cd8",
  },
  "orng-t": {
    bg: null,
    fg: "#eeeeee",
    border: "#3c3c3c",
    muted: "#717171",
    accent: "#ec5b2b",
    alt: "#fff7f1",
  },
  "osaka-jade-t": {
    bg: null,
    fg: "#c1c497",
    border: "#384134",
    muted: "#606851",
    accent: "#2dd5b7",
    alt: "#549e6a",
  },
  "palenight-t": {
    bg: null,
    fg: "#a6accd",
    border: "#45495d",
    muted: "#61667e",
    accent: "#82aaff",
    alt: "#89ddff",
  },
  "rosepine-t": {
    bg: null,
    fg: "#e0def4",
    border: "#454352",
    muted: "#737182",
    accent: "#9ccfd8",
    alt: "#ebbcba",
  },
  "shadesofpurple-t": {
    bg: null,
    fg: "#f5f0ff",
    border: "#4a415a",
    muted: "#7d758a",
    accent: "#c792ff",
    alt: "#ff7ac6",
  },
  "solarized-t": {
    bg: null,
    fg: "#93a1a1",
    border: "#20454e",
    muted: "#426066",
    accent: "#6c71c4",
    alt: "#d33682",
  },
  "synthwave84-t": {
    bg: null,
    fg: "#ffffff",
    border: "#565361",
    muted: "#888690",
    accent: "#36f9f6",
    alt: "#b084eb",
  },
  "tokyonight-t": {
    bg: null,
    fg: "#c0caf5",
    border: "#3f4254",
    muted: "#656a83",
    accent: "#7aa2f7",
    alt: "#ff9e64",
  },
  "vercel-t": {
    bg: null,
    fg: "#ededed",
    border: "#343434",
    muted: "#6b6b6b",
    accent: "#0070f3",
    alt: "#8e4ec6",
  },
  "vesper-t": {
    bg: null,
    fg: "#ffffff",
    border: "#454545",
    muted: "#7c7c7c",
    accent: "#ffc799",
    alt: "#ff8080",
  },
  "zenburn-t": {
    bg: null,
    fg: "#dcdccc",
    border: "#62625e",
    muted: "#86867e",
    accent: "#8cd0d3",
    alt: "#93e0e3",
  },
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
