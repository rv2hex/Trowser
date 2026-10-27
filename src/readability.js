'use strict';

// Reader-mode extraction, default on for every page.
//
// Vendored: `@mozilla/readability` (Apache-2.0, Mozilla) bundled to an IIFE
// in src/vendor/readability.bundle.js and injected into the live page, so
// it scores the REAL DOM (no DOM emulation, no extra process). It is the
// same engine Firefox Reader View uses; that is what turns GitHub pages,
// news sites and blogs into clean article text instead of nav sludge.
//
// Pure helpers below (heading promotion, reading time, meta line) are
// unit-tested without a browser; the parse itself needs Playwright and is
// covered by the browser smoke path.

const fs = require('fs');
const path = require('path');

let cachedBundle = null;

// The IIFE bundle, read once. Missing/broken file → null, and every caller
// degrades to the heuristic extraction (never a crash, never a blank page).
function readabilityBundle() {
  if (cachedBundle !== null) return cachedBundle;
  try {
    const p = path.join(__dirname, 'vendor', 'readability.bundle.js');
    const src = fs.readFileSync(p, 'utf8');
    cachedBundle = src && src.length > 1000 ? src : '';
  } catch {
    cachedBundle = '';
  }
  return cachedBundle;
}

// Reading time in minutes, rounded up, 200 wpm (the usual estimate).
function readingTime(text) {
  const words = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w)).length;
  if (!words) return 0;
  return Math.max(1, Math.round(words / 200));
}

// Readability collapses the article's own h1 into its title. When it does,
// promote the first h2 to the document h1 so the terminal render keeps a
// real title + `##` section hierarchy (boxSections works off h2s).
function promoteLeadHeading(html) {
  const src = String(html || '');
  if (/<h1[\s>]/i.test(src)) return src;
  const m = src.match(/<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/i);
  if (!m) return src;
  const attrs = m[1] || '';
  const inner = m[2].trim();
  if (!inner || inner.length > 120) return src;
  return src.replace(m[0], `<h1${attrs}>${inner}</h1>`).replace(`<h1${attrs}>${inner}</h1><h2`, `<h1${attrs}>${inner}</h1><h2`);
}

// Hero image candidates, most reliable first. og:image → twitter:image →
// the largest image inside the extracted article. Decorative art (SVG
// logos, sprites, footers) is demoted, and a page whose ONLY art is
// decorative gets NO hero — a logo above the title looks worse than
// nothing. Returns [] when the page has no real art.
const HERO_JUNK = /\.(svg)(\?|$)|logo|favicon|sprite|footer-|badge|avatar|icon[._-]/i;

function heroFrom(meta, images) {
  const good = [];
  const junk = [];
  const push = (u) => {
    const s = String(u || '').trim();
    if (!/^https?:\/\//i.test(s)) return;
    (HERO_JUNK.test(s) ? junk : good).push(s);
  };
  push(meta && (meta['og:image'] || meta['twitter:image']));
  for (const im of Array.isArray(images) ? images : []) {
    if (im && im.src) push(im.src);
  }
  const uniq = (list) => [...new Set(list)];
  return uniq(good).slice(0, 3);
}

// Everything we know about hero candidates, decorative included — callers
// use this to seed /gallery when the page has no real lead image.
function heroCandidates(meta, images) {
  return [...heroFrom(meta, images), ...heroJunk(meta, images)];
}

function heroJunk(meta, images) {
  const junk = [];
  const push = (u) => {
    const s = String(u || '').trim();
    if (/^https?:\/\//i.test(s) && HERO_JUNK.test(s)) junk.push(s);
  };
  push(meta && (meta['og:image'] || meta['twitter:image']));
  for (const im of Array.isArray(images) ? images : []) {
    if (im && im.src) push(im.src);
  }
  return [...new Set(junk)];
}

/**
 * Parse the live page with Readability.
 * @returns {Promise<null | {title, byline, siteName, textContent, content, hero, readingTime, site}>}
 *          null = no article found (caller keeps the heuristic extraction).
 */
async function extractArticle(page) {
  const bundle = readabilityBundle();
  if (!bundle) return null;
  try {
    await page.evaluate(bundle);
  } catch {
    return null; // CSP / evaluate failure → caller falls back
  }
  let out;
  try {
    out = await page.evaluate(() => {
      const R = window.__READABILITY__;
      if (!R || !R.Readability) return null;
      // NOTE: deliberately no isProbablyReaderable gate. It rejects
      // perfectly good pages (verified: every Wikipedia article), while
      // Readability itself returns null when there is no article — which
      // is the honest signal we actually want.
      const article = new R.Readability(document.cloneNode(true)).parse();
      if (!article || !article.content) return null;
      return {
        title: String(article.title || '').trim(),
        byline: String(article.byline || '').trim(),
        siteName: String(article.siteName || '').trim(),
        textContent: String(article.textContent || ''),
        content: String(article.content || ''),
      };
    });
  } catch {
    return null;
  }
  if (!out || out.none) return null;
  // Too thin to be an article: let the heuristic extraction have it.
  if (String(out.textContent || '').trim().length < 200) return null;
  const content = promoteLeadHeading(out.content);
  const textContent = out.textContent || '';
  return {
    title: out.title || '',
    byline: out.byline || '',
    siteName: out.siteName || '',
    textContent,
    content,
    readingTime: readingTime(textContent),
    hero: [],
  };
}

module.exports = { readabilityBundle, readingTime, promoteLeadHeading, heroFrom, heroCandidates, extractArticle };