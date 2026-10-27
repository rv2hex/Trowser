'use strict';

// Copy text to the system clipboard. Tries native tools first (wl-copy,
// xclip, xsel, pbcopy), falls back to an OSC52 escape over stdout (works
// over SSH and in most modern terminals). Never throws — returns
// { ok, method, error } for the caller to paint.

const { execFile } = require('child_process');

const TOOLS = [
  { cmd: 'wl-copy', args: [] },
  { cmd: 'xclip', args: ['-selection', 'clipboard'] },
  { cmd: 'xsel', args: ['--clipboard', '--input'] },
  { cmd: 'pbcopy', args: [] },
];

function runTool(cmd, args, text, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    try {
      const child = execFile(cmd, args, { timeout: timeoutMs || 800 }, (err) => {
        finish(!err);
      });
      if (!child || !child.stdin) {
        finish(false);
        return;
      }
      child.stdin.on('error', () => finish(false));
      child.stdin.write(String(text));
      child.stdin.end();
    } catch {
      finish(false);
    }
  });
}

function osc52(text) {
  try {
    const b64 = Buffer.from(String(text), 'utf8').toString('base64');
    process.stdout.write(`\x1b]52;c;${b64}\x07`);
    return true;
  } catch {
    return false;
  }
}

async function copyText(text) {
  const t = String(text == null ? '' : text);
  if (!t) return { ok: false, method: '', error: 'Nothing to copy.' };
  const clipped = t.slice(0, 4096);
  // Skip tools whose display server is absent (xclip blocks for seconds
  // with no X DISPLAY instead of failing fast).
  const isMac = process.platform === 'darwin';
  const tools = TOOLS.filter((tool) => {
    if (tool.cmd === 'pbcopy') return isMac;
    if (tool.cmd === 'wl-copy') return !!process.env.WAYLAND_DISPLAY;
    if (tool.cmd === 'xclip' || tool.cmd === 'xsel') return !!process.env.DISPLAY;
    return true;
  });
  for (const tool of tools) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const ok = await runTool(tool.cmd, tool.args, clipped, 800);
      if (ok) return { ok: true, method: tool.cmd, error: '' };
    } catch {
      /* try the next tool */
    }
  }
  if (osc52(clipped)) return { ok: true, method: 'terminal (OSC52)', error: '' };
  return { ok: false, method: '', error: 'No clipboard tool found (tried wl-copy, xclip, xsel, pbcopy).' };
}

module.exports = { TOOLS, runTool, osc52, copyText };
