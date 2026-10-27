'use strict';

// Downloads + bookmarks: the two bits of browser state (besides history)
// worth persisting. Zero new deps: global fetch + fs only. Best-effort IO —
// a failed write reports loudly instead of claiming success.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { errText } = require('./browser');

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;

function downloadsDir() {
  return path.join(os.homedir(), 'Downloads');
}

// Expand a leading ~ to the home dir (/download ~/pics support).
function expandHome(p) {
  try {
    const s = String(p || '');
    if (s === '~') return os.homedir();
    if (s.startsWith(`~${path.sep}`)) return path.join(os.homedir(), s.slice(2));
    return s;
  } catch {
    return String(p || '');
  }
}

function bookmarksFile(file) {
  if (file) return file;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'tui-browser', 'bookmarks.json');
}

// In-memory download log for this session (paths survive on disk anyway).
const downloadLog = [];

function getDownloads() {
  return downloadLog.slice();
}

function fileNameFor(url) {
  try {
    const u = new URL(String(url));
    let base = path.basename(u.pathname || '') || 'download';
    base = base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'download';
    if (!/\.[a-z0-9]{2,5}$/i.test(base)) {
      base += '.bin';
    }
    return base;
  } catch {
    return 'download.bin';
  }
}

async function downloadUrl(url, { referer, dest } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, error: 'Invalid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http(s) URLs can be downloaded.' };
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      signal: ctl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        ...(referer ? { Referer: String(referer) } : {}),
      },
    });
    if (!res.ok || !res.body) return { ok: false, error: `Server replied ${res.status || 'with an error'}.` };
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        try { await reader.cancel(); } catch { /* best effort */ }
        return { ok: false, error: `File is larger than ${MAX_DOWNLOAD_BYTES / 1048576}MB — use your regular browser.` };
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const dir = downloadsDir();
    fs.mkdirSync(dir, { recursive: true });
    const generated = `${Date.now()}-${fileNameFor(parsed.toString())}`;
    // dest may be a full file path (existing use) or a directory: an
    // existing dir, or anything with a trailing slash, gets the generated
    // filename inside it. Relative paths stay under ~/Downloads.
    let target = dest ? expandHome(String(dest)) : path.join(dir, generated);
    try {
      if (target.endsWith(path.sep)) {
        fs.mkdirSync(target, { recursive: true });
        target = path.join(target, generated);
      } else if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        target = path.join(target, generated);
      }
    } catch { /* fall through to file write below */ }
    if (!path.isAbsolute(target)) target = path.join(dir, target);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    } catch { /* write reports below */ }
    fs.writeFileSync(target, buf);
    const entry = { url: parsed.toString(), path: target, bytes: buf.length, at: new Date().toISOString() };
    downloadLog.push(entry);
    return { ok: true, error: '', ...entry };
  } catch (err) {
    return { ok: false, error: `Download failed: ${errText(err, 'unknown network error')}` };
  } finally {
    clearTimeout(t);
  }
}

function loadBookmarks(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file || bookmarksFile(), 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((b) => b && typeof b.url === 'string').slice(-500);
  } catch {
    return [];
  }
}

function saveBookmarks(list, file) {
  try {
    const target = file || bookmarksFile();
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, JSON.stringify(list.slice(-500), null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function addBookmark(url, title, file) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, error: 'Invalid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http(s) URLs can be bookmarked.' };
  }
  const list = loadBookmarks(file);
  if (list.some((b) => b.url === parsed.toString())) {
    return { ok: true, error: '', duplicate: true };
  }
  list.push({ url: parsed.toString(), title: String(title || parsed.hostname).slice(0, 120), at: new Date().toISOString() });
  if (!saveBookmarks(list, file)) return { ok: false, error: 'Could not save bookmarks.' };
  return { ok: true, error: '', duplicate: false };
}

module.exports = {
  MAX_DOWNLOAD_BYTES,
  downloadsDir,
  expandHome,
  bookmarksFile,
  getDownloads,
  fileNameFor,
  downloadUrl,
  loadBookmarks,
  saveBookmarks,
  addBookmark,
};
