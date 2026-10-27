'use strict';

// Terminal beautifier: markdown-lite -> blessed tags. Zero-dependency,
// pattern borrowed from marked-terminal / glow / mdcat (terminal markdown
// renderers): AI answers and web pages carry markdown, and raw passthrough
// reads as a wall of gray text. Pure + unit-testable, never throws.
//
// Contract: input is ALREADY escTags-escaped (literal { } arrived as
// {open}/{close}). Output adds real blessed tags ({bold}, {underline},
// {inverse}, {/}). Regexes only touch * _ ` [ ] ( ) ~ # > | - characters,
// so previously injected tags are never re-matched.

// Inline emphasis on one already-escaped line. `underline: false` keeps
// bold/code but renders italics (and markdown-link labels) UNDECORATED —
// used by boxSections so nothing inside a box is underlined, and so the
// visible width is final BEFORE the row is padded (padding an `*italic*`
// that blockMd later turns into `{underline}italic{/}` left the right
// border 2 cells short: the misaligned-box bug).
function inlineMd(s, { underline = true } = {}) {
  let out = String(s ?? '');
  if (!out) return '';
  const em = underline ? (t) => `{underline}${t}{/}` : (t) => t;
  const code = [];
  try {
    // Fenced code spans first (hidden behind placeholders so * _ [ inside
    // code never match emphasis rules below).
    out = out.replace(/`([^`\n]+)`/g, (m, inner) => {
      code.push(`{inverse}${inner}{/}`);
      return `\x00CODE${code.length - 1}\x00`;
    });
    // Links before emphasis: [title](https://url) -> bold title plus the
    // plain URL (still copyable, still readable); underlined when enabled.
    out = out.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, (m, title, url) => `${underline ? '{bold}{underline}' : '{bold}'}${title}{/} (${url})`);
    // Bold: **text** and __text__ (markers must hug non-space text).
    out = out.replace(/\*\*(\S[^*\n]*\S|\S)\*\*/g, '{bold}$1{/}');
    out = out.replace(/__(\S[^_\n]*\S|\S)__/g, '{bold}$1{/}');
    // Italic: *text* and _text_ only when markers hug text AND sit on word
    // boundaries — "a * b" math and snake_case_names pass through intact.
    out = out.replace(/(^|[\s(\["'])\*(\S[^*\n]*\S|\S)\*(?![\w*])/g, (m, pre, t) => `${pre}${em(t)}`);
    out = out.replace(/(^|[\s(\["'])_(\S[^_\n]*\S|\S)_(?![\w_])/g, (m, pre, t) => `${pre}${em(t)}`);
    // Strikethrough carries no terminal style: keep the words, drop tildes.
    out = out.replace(/~~(\S[^~\n]*\S|\S)~~/g, '$1');
    // Restore code spans.
    out = out.replace(/\x00CODE(\d+)\x00/g, (m, i) => code[Number(i)] || '');
  } catch {
    /* best effort — return whatever survived */
  }
  return out;
}

// Block structure over already-escaped text: headings, quotes, lists,
// fenced code (indented), rules, pipe tables. Blank-line rhythm is kept
// (at most one blank line, same collapse as renderSpans). Safe to run over boxed output (borders use │ ─ ╔ ╝,
// never ASCII # > | - at line start, so box art is never rewritten).
function blockMd(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let blanks = 0;
  let inFence = false;
  let table = [];
  const flushTable = () => {
    if (!table.length) return;
    try {
      const rows = table
        .map((ln) => String(ln).trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
        .filter((cells) => cells.some((c) => c && !/^[:\- ]+$/.test(c)));
      if (rows.length) {
        const cols = Math.max(...rows.map((r) => r.length));
        const widths = [];
        for (let c = 0; c < cols; c++) {
          widths.push(Math.max(3, Math.min(40, ...rows.map((r) => (r[c] || '').length))));
        }
        for (const r of rows) {
          const cells = [];
          for (let c = 0; c < cols; c++) {
            const cell = inlineMd(r[c] || '');
            cells.push(`${cell}${' '.repeat(Math.max(0, widths[c] - [...(r[c] || '')].length))}`);
          }
          out.push(cells.join(' | ').replace(/\s+$/, ''));
        }
      }
    } catch { /* drop malformed tables */ }
    table = [];
    blanks = 0;
  };
  for (const raw of lines) {
    const ln = String(raw ?? '');
    // Fenced code: drop the fence, indent the block, skip emphasis inside.
    if (/^\s*```/.test(ln)) {
      flushTable();
      inFence = !inFence;
      blanks = 0;
      continue;
    }
    if (inFence) {
      out.push(`  ${ln}`);
      blanks = 0;
      continue;
    }
    // Pipe-table groups (a | b | … block, separator row skipped).
    if (/^\s*\|.*\|\s*$/.test(ln)) {
      table.push(ln);
      continue;
    }
    flushTable();
    if (!ln.trim()) {
      if (blanks < 1) out.push('');
      blanks++;
      continue;
    }
    blanks = 0;
    let m = ln.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      out.push(`{bold}${inlineMd(m[2].trim())}{/}`);
      continue;
    }
    if (/^(\*\*\*+|---+|___+)\s*$/.test(ln.trim())) {
      out.push('─'.repeat(40));
      continue;
    }
    m = ln.match(/^(>+)\s?(.*)$/);
    if (m) {
      const depth = Math.min(3, m[1].length);
      out.push(`${'│ '.repeat(depth)}${inlineMd(m[2])}`);
      continue;
    }
    m = ln.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)$/);
    if (m) {
      const indent = '  '.repeat(Math.min(4, Math.floor(m[1].length / 2)));
      const bullet = /^\d/.test(m[2]) ? `${m[2]} ` : '• ';
      out.push(`${indent}${bullet}${inlineMd(m[3])}`);
      continue;
    }
    out.push(inlineMd(ln));
  }
  flushTable();
  return out.join('\n');
}

module.exports = { inlineMd, blockMd, boxSections, pairLinks, visLen, visibleCells, isWideChar, splitVis, boxRowOverflow, wrapVis, fitVis, stripRawAnsi, verifyBoxContainment };

// Pair `label [url]` markers into underlined labels, collecting urls.
// Returns { t, urls } (urls in appearance order). Lone markers (wrapped
// continuations with no label on their line) vanish from display but are
// still collected, so their line stays clickable. Operates on one logical
// line: never changes line counts, so recorded indices survive wrapping.
// Set underline: false to emit plain labels (for boxed content where
// links are clickable via line mapping, not visual underline).
function pairLinks(s, { underline = true } = {}) {
  const urls = [];
  let t = String(s ?? '');
  try {
    t = t.replace(/(\S(?:[^\n\[]*?\S)?)\s*(\[https?:\/\/[^\s\]]+\])/g, (m, label, mark) => {
      urls.push(mark.slice(1, -1));
      return underline ? `{underline}${label}{/}` : label;
    });
    t = t.replace(/\[https?:\/\/[^\s\]]+\]/g, (mark) => {
      urls.push(mark.slice(1, -1));
      return '';
    });
  } catch { /* best effort */ }
  return { t, urls };
}

// Max overhang of box rows (╭╰│…) past maxW, in visible cells (≤0 fits).
// Painters verify-then-shrink with this after reloads and resizes so boxes
// always sit right in the current webview. Thin wrapper over
// verifyBoxContainment (prefix-row violations only) so the two can never
// disagree on what "fits" means.
function boxRowOverflow(text, maxW) {
  const W = Math.max(1, Number(maxW) || 1);
  let over = 0;
  try {
    const v = verifyBoxContainment(text, W);
    for (const x of v.violations) {
      if (x.reason === 'box-row-exceeds-container') over = Math.max(over, x.width - W);
    }
  } catch { /* best effort */ }
  return over;
}

// Box-containment checker: proves a painted body string sits right inside
// its container. Unlike boxRowOverflow (prefix rows only), this also
// catches rows that ALREADY escaped into non-prefixed continuation lines,
// orphan borders, runs missing a cap, and right edges past innerWidth.
// Widths are measured with visibleCells, so blessed tags AND raw ANSI both
// count zero — the checker sees true rendered cells. Returns
// { ok, violations: [{ line, reason, width }] }; reasons are stable strings:
// 'box-row-exceeds-container', 'run-missing-top', 'run-missing-bottom',
// 'border-misaligned', 'content-exceeds-container'. Pure, never throws.
function verifyBoxContainment(text, innerWidth) {
  const violations = [];
  try {
    const W = Math.max(1, Math.floor(Number(innerWidth) || 1));
    const rows = String(text ?? '').split('\n');
    const isBoxRow = (ln) => /^[╭╰│]/.test(ln);
    let run = null; // { start, width }
    const closeRun = (endIdx) => {
      if (!run) return;
      const last = rows[endIdx];
      if (!last || !/^╰/.test(last)) {
        violations.push({ line: run.start, reason: 'run-missing-bottom', width: run.width });
      }
      run = null;
    };
    rows.forEach((ln, i) => {
      const w = visLen(ln);
      if (!isBoxRow(ln)) {
        closeRun(i - 1);
        if (ln.trim() && w > W) {
          violations.push({ line: i, reason: 'content-exceeds-container', width: w });
        }
        return;
      }
      if (w > W) {
        violations.push({ line: i, reason: 'box-row-exceeds-container', width: w });
      }
      if (/^╭/.test(ln)) {
        closeRun(i - 1);
        run = { start: i, width: w };
      } else if (/^╰/.test(ln)) {
        if (!run) {
          violations.push({ line: i, reason: 'run-missing-top', width: w });
        } else {
          if (w !== run.width) {
            violations.push({ line: i, reason: 'border-misaligned', width: w });
          }
          run = null;
        }
      } else {
        // │ row
        if (!run) {
          violations.push({ line: i, reason: 'run-missing-top', width: w });
        } else if (w !== run.width) {
          violations.push({ line: i, reason: 'border-misaligned', width: w });
        }
      }
    });
    if (run) {
      violations.push({ line: run.start, reason: 'run-missing-bottom', width: run.width });
    }
  } catch { /* checker never throws; empty violations on bug */ }
  return { ok: violations.length === 0, violations };
}

// Terminal cell width: 1 for most chars, 2 for CJK/emoji wide chars,
// 0 for combining marks. Code points (not UTF-16 units) so astral
// emoji count once. Used by every width budget below — measuring code
// points instead of cells is what let CJK/emoji rows render wider than
// their box and spill the underline outside (BUG-2 H2).
function isWideChar(cp) {
  try {
    if (typeof cp === 'string') cp = cp.codePointAt(0);
    if (!(cp >= 0)) return false;
    return (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd) ||
      // U+2600–U+26FF (♥ ♪ ⚡ ☀ ⛨ …) is NOT wide: blessed measures the
      // block as one cell and terminals draw it one cell — the piano's
      // hearts row is padded with this table, and measuring hearts as 2
      // pulled the stats row's box border three cells in.
      (cp >= 0x2700 && cp <= 0x27bf) ||
      (cp >= 0x2b00 && cp <= 0x2bff) ||
      (cp >= 0x1f300 && cp <= 0x1faff)
    );
  } catch {
    return false;
  }
}

// Strip raw ANSI CSI/SGR escapes (blessed's getContent returns rendered
// escapes like \x1b[1m for parsed tags). Box content is escTags'd so no
// legitimate raw ANSI exists there; painters must measure true rendered
// cells, never escape bytes, or link rows mis-measure and escape the box.
function stripRawAnsi(s) {
  try {
    return String(s ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  } catch {
    return String(s ?? '');
  }
}

// Visible width in TERMINAL CELLS, ignoring blessed tags ({bold} etc.)
// AND raw ANSI escapes; {open}/{close} count as one rendered char each.
// This is the single width function every painter and test should use.
function visibleCells(s) {
  try {
    const t = stripRawAnsi(String(s ?? '')).replace(/\{open\}|\{close\}/g, '\uFFFF').replace(/\{[^}]*\}/g, '');
    let w = 0;
    for (const ch of t) {
      const cp = ch.codePointAt(0);
      // Combining marks ride on the previous cell.
      if (cp >= 0x0300 && cp <= 0x036f) continue;
      if (cp === 0xfe0f) continue;
      w += isWideChar(cp) ? 2 : 1;
    }
    return w;
  } catch {
    return 0;
  }
}

// Visible width ignoring blessed tags ({bold} etc.); {open}/{close} count
// as one rendered char each. Cell-accurate (wide chars = 2); kept as the
// historic name so existing callers/tests keep working.
function visLen(s) {
  return visibleCells(s);
}

// Truncate to max visible CELLS, keeping blessed tags intact (zero-width
// tags pass through free; only real chars consume budget, wide chars cost
// 2). Never emits a half-wide char: a wide char with only 1 cell left is
// dropped and the line is space-padded by the caller.
function fitVis(s, max) {
  const budget = Math.max(0, Number(max) || 0);
  const parts = String(s ?? '').split(/(\{[^}]*\})/g);
  let len = 0;
  let out = '';
  let done = false;
  for (const p of parts) {
    if (!p || done) continue;
    if (/^\{[^}]*\}$/.test(p)) {
      if (p === '{open}' || p === '{close}') {
        if (len + 1 > budget) { done = true; break; }
        len += 1;
      }
      out += p;
      continue;
    }
    for (const ch of [...p]) {
      const cp = ch.codePointAt(0);
      if (cp >= 0x0300 && cp <= 0x036f) { out += ch; continue; }
      if (cp === 0xfe0f) { out += ch; continue; }
      const cw = isWideChar(cp) ? 2 : 1;
      if (len + cw > budget) { done = true; break; }
      out += ch;
      len += cw;
    }
  }
  return out;
}

// Split one overlong tagged line into several rows of at most `width`
// cells each, keeping blessed tags intact. Used when a single word (a
// long URL marker, a code token) exceeds the row: clipping would lose
// content and returning it whole would overrun the box border.
function splitVis(s, width) {
  const w = Math.max(1, Number(width) || 1);
  const parts = String(s ?? '').split(/(\{[^}]*\})/g);
  const rows = [];
  let cur = '';
  let len = 0;
  const push = () => { rows.push(cur); cur = ''; len = 0; };
  for (const p of parts) {
    if (!p) continue;
    if (/^\{[^}]*\}$/.test(p)) {
      if ((p === '{open}' || p === '{close}') && len + 1 > w && len > 0) push();
      if (p === '{open}' || p === '{close}') len += 1;
      cur += p;
      continue;
    }
    for (const ch of [...p]) {
      const cp = ch.codePointAt(0);
      if ((cp >= 0x0300 && cp <= 0x036f) || cp === 0xfe0f) { cur += ch; continue; }
      const cw = isWideChar(cp) ? 2 : 1;
      if (len + cw > w && len > 0) push();
      if (cw > w) continue; // wider than the whole row: drop, never overrun
      cur += ch;
      len += cw;
    }
  }
  if (cur !== '' || !rows.length) rows.push(cur);
  return rows;
}

// Greedy word-wrap to max visible CELLS. Tags ride along with their words;
// a single overlong word without spaces is hard-split into several rows
// (never clipped, never returned whole): an overlong row used to be
// returned as-is when it held a link marker, overrunning the box border
// and dragging the underline outside with it (BUG-2 H1).
function wrapVis(line, max, keepLinksWhole = true) {
  // Floor 4 (not 10): narrow-but-viable boxes (W>=12, inner>=6) must wrap
  // to their real inner width — a 10-cell floor would emit rows wider
  // than the box and escape it.
  const width = Math.max(4, Number(max) || 4);
  void keepLinksWhole;
  const words = String(line ?? '').split(/(\s+)/).filter((w) => w !== '');
  const rows = [];
  let cur = '';
  for (const w of words) {
    if (!w.trim()) {
      if (cur && !/\s$/.test(cur)) cur += ' ';
      continue;
    }
    const candidate = cur + w;
    if (visLen(candidate) <= width || !cur.trim()) {
      cur = candidate;
    } else {
      rows.push(cur.replace(/\s+$/, ''));
      cur = w;
    }
  }
  if (cur.trim()) rows.push(cur.replace(/\s+$/, ''));
  else if (!rows.length) rows.push('');
  return rows.flatMap((r) => {
    if (visLen(r) <= width) return [r];
    // keepLinksWhole is now only a hint about WHERE to prefer splitting
    // (callers that need click mapping use the first row); the width
    // invariant wins in every case — no row may exceed `width`.
    return splitVis(r, width);
  });
}

// Sub-topic boxes: split already-escaped text on `## ` headings and wrap
// each section in rounded line borders (same glyphs as the app chrome:
// single-width, safe with fullUnicode:false). Layout per box is one padded
// column with breathing room top and bottom:
//
//   ╭─ Section title ─────╮
//   │                     │
//   │  body prose here    │
//   │  • linked words     │
//   │                     │
//   ╰─────────────────────╯
//
// `label [url]` pairs become underlined labels (no visible URLs, refs, or
// rails — words just link); every url is still recorded per emitted row, so
// clicks keep working. h1 stays a plain title; deeper headings (###+)
// become bold subheads; `-`/`*` become • bullets and `>` quotes gain a │
// rail inside boxes (blockMd can't reach them past the box borders later);
// fenced code is indented and wrapped like everything else.
// Text without any h2 passes through untouched with boxed:false.
// Inline emphasis (bold/code; italics WITHOUT underline) is applied HERE,
// before wrapping/padding, so the padded row width is final — blockMd then
// runs as a line-count/width no-op over the box art (borders use │ ╭ ╮,
// never ASCII # > | at line start, so block rules can't rewrite it).
// Returns { text, linkLines, boxed } with line numbers exact against the
// returned text (blank runs collapse here, so downstream blockMd is a
// line-count no-op on boxes).
function boxSections(text, { width = 76, available } = {}) {
  // W never exceeds the real container (`available`, the live body width
  // passed by the painter): a fixed 30 floor used to force boxes wider
  // than narrow bodies, and blessed wrapped the border rows mid-box.
  // Below W=12 a proper box is impossible (borders + padding eat the row),
  // so text passes through unboxed and blessed wraps it as plain text.
  const want = Math.min(110, Number(width) || 76);
  const avail = (Number.isFinite(Number(available)) && Number(available) > 0)
    ? Math.floor(Number(available))
    : want;
  const W = Math.min(want, avail);
  const lines = String(text ?? '').split('\n');
  let inFence = false;
  const isH2 = (ln) => !inFence && /^##\s+\S/.test(String(ln).trim());
  if (W < 12 || !lines.some(isH2)) return { text: String(text ?? ''), linkLines: [], boxed: false };
  inFence = false;
  const chunks = [];
  let cur = null;
  for (const ln of lines) {
    if (/^\s*```/.test(ln)) {
      inFence = !inFence;
      if (cur) cur.body.push(ln);
      else chunks.push({ kind: 'text', line: ln });
      continue;
    }
    const h = !inFence && String(ln).match(/^##\s+(.*)$/);
    if (h) {
      if (cur) chunks.push(cur);
      cur = { kind: 'box', title: h[1], body: [] };
      continue;
    }
    if (cur) cur.body.push(ln);
    else chunks.push({ kind: 'text', line: ln });
  }
  if (cur) chunks.push(cur);
  const out = [];
  const linkLines = [];
  // Single push point: collapses blank runs here so downstream blockMd
  // (same collapse) is a line-count no-op and recorded numbers stay exact.
  let prevBlank = false;
  const pushLine = (ln) => {
    const s = String(ln ?? '');
    const blank = !s.trim();
    if (blank && prevBlank) return -1;
    prevBlank = blank;
    out.push(s);
    return out.length - 1;
  };
  const pushLinkAt = (url, idx) => {
    if (!url || idx < 0) return;
    linkLines.push({ line: idx, url: String(url).slice(0, 300), text: '' });
  };
  for (const c of chunks) {
    if (c.kind === 'text') {
      pushLine(c.line);
      continue;
    }
    // Pair links per logical line, then normalize structure, then wrap.
    // Urls fan out to the FIRST wrapped row of their line.
    let fenced = false;
    const display = []; // {t, code, urls[]}
    for (const raw of c.body) {
      let ln = String(raw ?? '');
      if (/^\s*```/.test(ln)) {
        fenced = !fenced;
        continue; // fences read as indentation, like blockMd
      }
      if (fenced) {
        display.push({ t: `  ${ln}`, code: true, urls: [] });
        continue;
      }
      const sub = ln.match(/^#{1,6}\s+(.*)$/);
      if (sub) {
        const p = pairLinks(sub[1].trim(), { underline: false });
        display.push({ t: `{bold}${inlineMd(p.t, { underline: false })}{/}`, code: false, urls: p.urls });
        continue;
      }
      ln = ln.replace(/^(\s*)[-*•]\s+/, '$1• ');
      let q = 0;
      while (q < 3 && ln.startsWith('>')) {
        ln = ln.replace(/^>\s?/, '');
        q++;
      }
      if (q) ln = `${'│ '.repeat(q)}${ln}`;
      const p = pairLinks(ln, { underline: false });
      display.push({ t: inlineMd(p.t, { underline: false }), code: false, urls: p.urls });
    }
    while (display.length && !display[display.length - 1].t.trim()) display.pop();
    while (display.length && !display[0].t.trim()) display.shift();
    const inner = W - 6;
    const tp = pairLinks(String(c.title || '').trim(), { underline: false });
    const title = fitVis(inlineMd(tp.t, { underline: false }), W - 10) || '···';
    const titleIdx = pushLine(`╭─ ${title} ${'─'.repeat(Math.max(1, W - visLen(title) - 5))}╮`);
    tp.urls.forEach((u) => pushLinkAt(u, titleIdx));
    pushLine(`│${' '.repeat(W - 2)}│`);
    for (const d of display) {
      // Bullets get a hanging indent: the first row carries the marker,
      // wrapped rows line up under the text, not under the marker. Long
      // list items read as one block instead of a staircase.
      const isBullet = /^\s*•\s+/.test(d.t);
      const hang = isBullet ? '  ' : '';
      const text = isBullet ? d.t.replace(/^(\s*)•\s+/, '$1') : d.t;
      const wrapped = wrapVis(text, Math.max(4, inner - (hang ? hang.length : 0)), !d.code);
      wrapped.forEach((w, wi) => {
        const body = wi === 0 && isBullet ? `• ${w}` : `${hang}${w}`;
        const idx = pushLine(`│  ${body}${' '.repeat(Math.max(0, inner - visLen(body)))}  │`);
        if (wi === 0) d.urls.forEach((u) => pushLinkAt(u, idx));
        // Fence-code leftovers with intact markers still map exactly.
        if (d.code && idx >= 0) {
          const re = /\[https?:\/\/[^\s\]]+\]/g;
          let m;
          while ((m = re.exec(w)) !== null) pushLinkAt(m[0].slice(1, -1), idx);
        }
      });
    }
    pushLine(`│${' '.repeat(W - 2)}│`);
    pushLine(`╰${'─'.repeat(W - 2)}╯`);
  }
  return { text: out.join('\n'), linkLines, boxed: true };
}
