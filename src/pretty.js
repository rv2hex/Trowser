'use strict';

// Article HTML renderer (own MIT code, zero-dep): cleaned article HTML to
// terminal text with headings, `label [url]` link markers, bullets, bordered
// tables, quote bars, and fenced code. Same output contract the cli-html
// dependency used to provide, without the GPL license or the 52MB tree.
// Pure + unit-testable, never throws — callers keep their current rendering
// when pretty output is unavailable (null).

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', times: '×', divide: '÷',
};

function decodeEntities(s) {
  try {
    return String(s ?? '')
      .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
        const n = parseInt(h, 16);
        return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : m;
      })
      .replace(/&#(\d+);/g, (m, d) => {
        const n = parseInt(d, 10);
        return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : m;
      })
      .replace(/&([a-zA-Z]+);/g, (m, name) => (name in ENTITY_MAP ? ENTITY_MAP[name] : m));
  } catch {
    return String(s ?? '');
  }
}

// Content tags whose children never reach the page (defense in depth — the
// browser already drops most of these from the cleaned clone).
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'iframe', 'canvas', 'video', 'audio', 'svg']);

function parseTag(token) {
  const m = String(token).match(/^<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>?$/);
  if (!m) return null;
  const closing = token[1] === '/';
  const name = m[1].toLowerCase();
  let href = null;
  if (!closing && name === 'a') {
    const h = m[2].match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (h) href = h[2] !== undefined ? h[2] : h[3] !== undefined ? h[3] : h[4];
  }
  return { name, closing, href };
}

// Render one table's captured rows to bordered text (same look the old
// renderer produced, minus its gray ANSI). rows: [{cells:[..], head:bool}].
function renderTable(rows) {
  const clean = (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      head: !!(r && r.head),
      cells: (r && Array.isArray(r.cells) ? r.cells : []).map((c) => String(c ?? '').replace(/\s+/g, ' ').trim()),
    }))
    .filter((r) => r.cells.some((c) => c));
  if (!clean.length) return '';
  const cols = Math.max(...clean.map((r) => r.cells.length));
  const widths = [];
  for (let c = 0; c < cols; c++) {
    let w = 3;
    for (const r of clean) w = Math.max(w, Math.min(30, [...(r.cells[c] || '')].length));
    widths.push(w);
  }
  const fit = (cell, w) => {
    const chars = [...String(cell || '')];
    const cut = chars.length > w ? [...chars.slice(0, Math.max(0, w - 1)), '…'] : chars;
    return cut.join('') + ' '.repeat(Math.max(0, w - cut.length));
  };
  const bar = (l, m, r) => l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const out = [bar('┌', '┬', '┐')];
  clean.forEach((r, i) => {
    const cells = [];
    for (let c = 0; c < cols; c++) cells.push(` ${fit(r.cells[c] || '', widths[c])} `);
    out.push(`│${cells.join('│')}│`);
    if (i === 0 && r.head && clean.length > 1) out.push(bar('├', '┼', '┤'));
  });
  out.push(bar('└', '┴', '┘'));
  return out.join('\n');
}

// Cleaned article HTML -> terminal text. One logical line per block (no
// forced wrapping — boxes and blessed wrap downstream, and mid-line breaks
// used to split `label [url]` markers apart).
// Accessibility chrome that survives article extraction: "Jump to
// content", "Skip to navigation", "Back to top". They are links, not
// prose, and they used to open every Wikipedia article. Matched on the
// WHOLE rendered line (including its `[url]` marker), so real sentences
// that merely begin with "Jump to" are never dropped.
const CHROME_LINE = /^(jump|skip|back|go)\s+(to|back)\s+(the\s+)?(content|navigation|main|search|top)\b/i;

function isChromeLine(line) {
  return CHROME_LINE.test(String(line || '').trim());
}

function renderHtmlText(html) {
  const tokens = String(html ?? '').split(/(<[^>]*>)/g);
  const buffers = [''];
  const write = (s) => {
    buffers[buffers.length - 1] += s;
  };
  // Write with single-space joining: never doubles a space, never leads a
  // fresh line with one.
  const writeSpaced = (s) => {
    const chunk = String(s ?? '');
    if (!chunk) return;
    const cur = buffers[buffers.length - 1];
    if (cur === '' || /[\n ]$/.test(cur)) write(chunk.replace(/^\s+/, ''));
    else write(chunk);
  };
  // Ensure at least n trailing newlines (no prefixes here — callers that
  // need a quote rail write it explicitly after the break).
  const nl = (n) => {
    const idx = buffers.length - 1;
    const have = (buffers[idx].match(/\n*$/) || [''])[0].length;
    for (let i = have; i < n; i++) buffers[idx] += '\n';
  };
  const stack = []; // {tag, href?} + table frames {tag:'table', rows}
  const lists = []; // {type, n}
  let skip = 0;
  let inPre = false;
  let bq = 0;
  const rail = () => '│ '.repeat(Math.min(3, bq));
  const nearestTable = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].tag === 'table') return stack[i];
    }
    return null;
  };
  const inCell = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].tag === 'td' || stack[i].tag === 'th') return true;
      if (stack[i].tag === 'table') return false;
    }
    return false;
  };
  const blockOpen = () => {
    if (inCell()) write('\n');
    else nl(2);
  };
  for (const tok of tokens) {
    if (!tok) continue;
    if (tok[0] !== '<') {
      if (skip > 0) continue;
      const decoded = decodeEntities(tok);
      if (inPre) {
        write(decoded.replace(/^\n+/, ''));
        continue;
      }
      const collapsed = decoded.replace(/\s+/g, ' ');
      if (collapsed.trim()) writeSpaced(collapsed);
      else if (/[ \t\n]/.test(decoded)) {
        const cur = buffers[buffers.length - 1];
        if (cur !== '' && !/[\n ]$/.test(cur)) write(' ');
      }
      continue;
    }
    if (/^<!--/.test(tok)) continue;
    const tag = parseTag(tok);
    if (!tag) {
      // Not really a tag (math like `a < b > c`): keep it as text.
      if (/^<\s|<\d/.test(tok) && skip === 0) writeSpaced(decodeEntities(tok));
      continue;
    }
    const { name, closing } = tag;
    if (SKIP_TAGS.has(name)) {
      if (!closing && !/\/>$/.test(tok)) skip++;
      else if (closing && skip > 0) skip--;
      continue;
    }
    if (skip > 0) continue;
    if (name === 'br') {
      write(`\n${bq ? rail() : ''}`);
      continue;
    }
    if (name === 'hr') {
      nl(2);
      write(`${bq ? rail() : ''}---`);
      nl(2);
      continue;
    }
    if (name === 'img') continue; // browser swaps imgs for [alt] text first
    if (/^h[1-6]$/.test(name)) {
      if (!closing) {
        blockOpen();
        write(`${bq ? rail() : ''}${'#'.repeat(Number(name[1]))} `);
      } else {
        nl(2);
      }
      continue;
    }
    if (name === 'p' || name === 'div' || name === 'section' || name === 'article' || name === 'main' || name === 'header' || name === 'footer' || name === 'nav' || name === 'aside' || name === 'figure' || name === 'figcaption') {
      if (!closing) blockOpen();
      else if (!inCell()) nl(2);
      continue;
    }
    if (name === 'blockquote') {
      if (!closing) {
        blockOpen();
        bq++;
      } else {
        if (bq > 0) bq--;
        if (!inCell()) nl(2);
      }
      continue;
    }
    if (name === 'ul' || name === 'ol') {
      if (!closing) {
        lists.push({ type: name, n: 0 });
        if (!inCell()) nl(1);
      } else {
        lists.pop();
        if (!inCell()) nl(lists.length ? 1 : 2);
      }
      continue;
    }
    if (name === 'li') {
      if (!closing) {
        const top = lists[lists.length - 1];
        const indent = '  '.repeat(Math.max(0, lists.length - 1));
        if (top && top.type === 'ol') {
          top.n++;
          if (inCell()) writeSpaced(`${top.n}. `);
          else {
            nl(1);
            write(`${bq ? rail() : ''}${indent}${top.n}. `);
          }
        } else if (inCell()) {
          writeSpaced('• ');
        } else {
          nl(1);
          write(`${bq ? rail() : ''}${indent}• `);
        }
      }
      continue;
    }
    if (name === 'pre') {
      if (!closing) {
        blockOpen();
        write('```\n');
        inPre = true;
      } else {
        inPre = false;
        write('\n```');
        if (!inCell()) nl(2);
      }
      continue;
    }
    if (name === 'table') {
      if (!closing) {
        if (!inCell()) nl(2);
        stack.push({ tag: 'table', rows: [] });
      } else {
        let frame = null;
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].tag === 'table') {
            frame = stack.splice(i, 1)[0];
            break;
          }
        }
        const rendered = renderTable(frame && frame.rows ? frame.rows : []);
        if (rendered) {
          if (!inCell()) nl(2);
          write(rendered);
        }
        if (!inCell()) nl(2);
      }
      continue;
    }
    if (name === 'tr') {
      if (!closing) {
        const t = nearestTable();
        if (t) t.rows.push({ cells: [], head: false });
      }
      continue;
    }
    if (name === 'th' || name === 'td') {
      if (!closing) {
        stack.push({ tag: name });
        buffers.push('');
      } else if (buffers.length > 1) {
        const buf = buffers.pop() || '';
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].tag === 'th' || stack[i].tag === 'td') {
            stack.splice(i, 1);
            break;
          }
        }
        const t = nearestTable();
        if (t) {
          if (!t.rows.length) t.rows.push({ cells: [], head: false });
          const row = t.rows[t.rows.length - 1];
          row.cells.push(buf.replace(/\s+/g, ' ').trim());
          if (name === 'th') row.head = true;
        } else {
          write(buf);
        }
      }
      continue;
    }
    if (name === 'a') {
      if (!closing) {
        // Track buffer length at link start to detect empty links
        const bufIdx = buffers.length - 1;
        const startLen = buffers[bufIdx].length;
        stack.push({ tag: 'a', href: tag.href, bufIdx, startLen });
      } else {
        let href = '';
        let startLen = 0;
        let bufIdx = buffers.length - 1;
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].tag === 'a') {
            href = stack[i].href || '';
            startLen = stack[i].startLen || 0;
            bufIdx = stack[i].bufIdx || bufIdx;
            stack.splice(i, 1);
            break;
          }
        }
        href = String(href).trim();
        // Only emit [url] if there was actual link text content written
        const cur = buffers[bufIdx] || '';
        const hasLinkText = cur.length > startLen && cur.slice(startLen).trim().length > 0;
        if (/^https?:\/\//i.test(href) && hasLinkText) {
          write(cur === '' || /[\n ]$/.test(cur) ? `[${href}]` : ` [${href}]`);
        }
      }
      continue;
    }
    if (name === 'strong' || name === 'b') {
      if (!inPre) write('**');
      continue;
    }
    if (name === 'em' || name === 'i') {
      if (!inPre) write('*');
      continue;
    }
    if (name === 'code' || name === 'kbd' || name === 'samp' || name === 'var') {
      if (!inPre) write('`');
      continue;
    }
    if (name === 'del' || name === 's' || name === 'strike') {
      if (!inPre) write('~~');
      continue;
    }
    // Unknown tags pass children through (browser cleaning already dropped
    // chrome); form controls contribute nothing.
    if (/^(input|button|select|textarea|option)$/.test(name)) continue;
  }
  return buffers
    .join('')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .filter((l) => !isChromeLine(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Strip ANSI SGR/CSI sequences (kept for robustness: our renderer emits
// none, but pasted upstream content might carry some).
function stripAnsi(s) {
  try {
    return String(s ?? '').replace(/\[[0-9;]*[A-Za-z]/g, '').replace(/\][^\x07]*\x07/g, '');
  } catch {
    return String(s ?? '');
  }
}

// Render cleaned article HTML to plain terminal text. Sync core, async
// signature kept (callers await it). Returns trimmed text or null.
async function renderPretty(html, { maxChars = 60000 } = {}) {
  const src = String(html || '').trim();
  if (src.length < 50) return null;
  try {
    const text = renderHtmlText(src)
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, Math.max(1000, Number(maxChars) || 60000));
    return text.length > 50 ? text : null;
  } catch {
    return null;
  }
}

// Click mapping for pretty text: links render as `label [url]`.
// One entry per line (first URL wins), same shape as contentLinkLines.
function extractLinkLines(text) {
  const out = [];
  try {
    String(text || '').split('\n').forEach((ln, i) => {
      const line = String(ln || '');
      const m = line.match(/\[https?:\/\/[^\s\]]+\]/);
      if (m) out.push({ line: i, url: m[0].slice(1, -1).slice(0, 300), text: line.trim().slice(0, 120) });
    });
  } catch { /* best effort */ }
  return out;
}

module.exports = { renderPretty, renderHtmlText, extractLinkLines, stripAnsi, isChromeLine };
