'use strict';
// PDF viewer: open a PDF in a split view — the extracted TEXT on the left
// (readable, searchable) and every page rendered as an IMAGE on the right
// (so pictures/diagrams inside the PDF are visible). Ctrl+F fullscreen.
// Uses poppler (pdftotext + pdftoppm), already installed. Zero new deps.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadUrl } = require('./downloads');

function isPdfUrl(url) {
  try {
    const u = new URL(String(url));
    return /\.pdf(\?|#|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: Number(timeoutMs) || 60000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Open a PDF: extract text AND render each page to a PNG. Resolves
// { ok, text, pages: [path], dir } — pages sorted by name (page order).
async function openPdf(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-pdf-'));
  const pdfPath = path.join(dir, 'doc.pdf');
  const dl = await downloadUrl(url, { dest: pdfPath });
  if (!dl.ok) return { ok: false, error: dl.error };
  // Text layer (for reading / /find).
  const txt = await run('pdftotext', [pdfPath, '-']);
  // Page images (for the pictures inside the PDF).
  const prefix = path.join(dir, 'page');
  await run('pdftoppm', ['-png', '-r', '150', pdfPath, prefix]);
  const pages = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('page') && f.endsWith('.png')) pages.push(path.join(dir, f));
    }
  } catch { /* best effort */ }
  pages.sort();
  return { ok: true, text: txt.stdout || '', pages, dir };
}

module.exports = { isPdfUrl, openPdf };
