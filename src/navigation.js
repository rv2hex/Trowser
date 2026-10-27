'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HISTORY_LIMIT = 200;

function historyFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'tui-browser', 'history.json');
}

function titlesFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'tui-browser', 'titles.json');
}

class Navigator {
  constructor(opts = {}) {
    this.history = [];
    this.current = -1;
    this.redirects = [];
    // Pass { file: null } to disable persistence (tests).
    this.file = opts.file === undefined ? historyFile() : opts.file;
    if (this.file) this._load();
    // Friendly titles per URL (filled on every navigation), persisted beside
    // the history so /history reads as titles, not raw links.
    this.titles = {};
    this.titlesFile = opts.titlesFile === undefined ? titlesFile() : opts.titlesFile;
    if (this.titlesFile) this._loadTitles();
  }

  navigate(url) {
    // Remove forward history when navigating to new page
    this.history = this.history.slice(0, this.current + 1);
    this.history.push(String(url));
    if (this.history.length > HISTORY_LIMIT) {
      this.history = this.history.slice(-HISTORY_LIMIT);
    }
    this.current = this.history.length - 1;
    this._save();
  }

  redirect(url) {
    this.redirects.push(url);
  }

  back() {
    if (this.current > 0) {
      this.current--;
      return this.history[this.current];
    }
    return null;
  }

  forward() {
    if (this.current < this.history.length - 1) {
      this.current++;
      return this.history[this.current];
    }
    return null;
  }

  // Replace the CURRENT entry (search-engine fallback / redirect semantics):
  // the URL that actually answered replaces the one we first tried, so the
  // back/forward stack never shows a refused search. Appends when the stack
  // is empty. Never throws.
  replaceCurrent(url) {
    if (this.current < 0 || this.current >= this.history.length) {
      this.navigate(url);
      return;
    }
    this.history[this.current] = String(url);
    this._save();
  }

  canGoBack() {
    return this.current > 0;
  }

  canGoForward() {
    return this.current < this.history.length - 1;
  }

  getHistory() {
    return [...this.history];
  }

  // The URL the cursor points at — the page the user is actually on.
  // getHistory() returns the whole stack, so its tail is only "current"
  // until the user reopens an older entry.
  currentUrl() {
    return this.current >= 0 && this.current < this.history.length
      ? this.history[this.current]
      : '';
  }

  // Friendly title for a URL ('' when unknown — caller falls back to host).
  titleFor(url) {
    try {
      return String(this.titles[String(url)] || '');
    } catch {
      return '';
    }
  }

  // Record the title a page reported for its URL.
  setTitle(url, title) {
    const u = String(url || '');
    const t = String(title || '').slice(0, 200).trim();
    if (!u || !t) return;
    this.titles[u] = t;
    try {
      // Bound the map: keep the most recent 500 entries.
      const keys = Object.keys(this.titles);
      if (keys.length > 500) {
        const drop = keys.slice(0, keys.length - 500);
        for (const k of drop) delete this.titles[k];
      }
    } catch { /* best effort */ }
    this._saveTitles();
  }

  _loadTitles() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.titlesFile, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === 'string' && v) this.titles[k] = v.slice(0, 200);
        }
      }
    } catch {
      // First run or corrupt file: start empty.
    }
  }

  _saveTitles() {
    if (!this.titlesFile) return;
    try {
      fs.mkdirSync(path.dirname(this.titlesFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.titlesFile, JSON.stringify(this.titles), { mode: 0o600 });
    } catch {
      // Best effort: titles just won't survive restarts.
    }
  }

  // Session scope: wipe the history (memory + file) on quit. Bookmarks and
  // account data live elsewhere and are untouched.
  clearHistory() {
    this.history = [];
    this.current = -1;
    this.redirects = [];
    if (!this.file) return;
    try {
      fs.rmSync(this.file, { force: true });
    } catch { /* best effort */ }
  }

  getRedirects() {
    return [...this.redirects];
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) {
        this.history = raw.filter((u) => typeof u === 'string').slice(-HISTORY_LIMIT);
        this.current = this.history.length - 1;
      }
    } catch {
      // First run or corrupt file: start empty.
    }
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify(this.history.slice(-HISTORY_LIMIT)), { mode: 0o600 });
    } catch {
      // Best effort: history just won't survive restarts.
    }
  }
}

module.exports = { Navigator };
