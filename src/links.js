'use strict';

// Link normalization, shared by the browser driver and the search fan-out.
// Pure: no driver, no network, no DOM. Tests exercise this directly.
//
// Contract for every row we hand to the picker:
//   { title, url, domain, snippet? }  — http(s) + mailto only, absolutized,
//   redirector URLs unwrapped, deduped by FINAL url, order preserved.

function cleanLinks(raw, limit, base) {
  const seen = new Set();
  const out = [];
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 200;
  for (const r of raw || []) {
    let url = String((r && r.href) || '').trim();
    const title = String((r && r.title) || '')
      .trim()
      .replace(/\s+/g, ' ');
    const snippet = String((r && r.snippet) || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 300);
    if (!url) continue;
    try {
      // Absolutize first so relative page links survive.
      url = new URL(url, base || 'https://www.google.com').toString();
      const u = new URL(url);
      // Unwrap redirector links (Google /url?q=REAL, DDG /l/?uddg=REAL).
      // Path-based on purpose: result hrefs are often root-relative, and a
      // same-path redirector means "go to the target" on any host.
      if (u.pathname === '/url') {
        const q = u.searchParams.get('q') || u.searchParams.get('url');
        if (q) url = new URL(q, base || 'https://www.google.com').toString();
      } else if (u.pathname === '/l/') {
        const uddg = u.searchParams.get('uddg');
        if (uddg) url = new URL(uddg, base || 'https://www.google.com').toString();
      } else if (u.pathname === '/ck/a') {
        // Bing wraps every result in bing.com/ck/a?...&u=a1<base64url>.
        // Decode the `u` param back to the real target so links never
        // point at bing.com redirects.
        const raw = u.searchParams.get('u') || '';
        if (raw.startsWith('a1')) {
          try {
            const b64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
            const decoded = Buffer.from(b64, 'base64').toString('utf8');
            if (/^https?:\/\//i.test(decoded)) url = decoded;
          } catch { /* keep the redirect link */ }
        }
      }
      const final = new URL(url);
      // Email links ride along so contact pages stay actionable —
      // Enter/click hands them to the system mail client (see onLinkPick).
      if (final.protocol === 'mailto:') {
        const addr = String(final.pathname || '').split('?')[0].trim() || title;
        if (!addr) continue;
        const key = final.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ title: (title || addr).slice(0, 80), url: key, domain: 'email' });
        if (out.length >= cap) break;
        continue;
      }
      if (final.protocol !== 'http:' && final.protocol !== 'https:') continue;
      const key = final.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      const domain = final.hostname.replace(/^www\./, '');
      if (!domain) continue;
      const row = { title: title.slice(0, 80) || domain, url: key, domain };
      if (snippet) row.snippet = snippet;
      out.push(row);
      if (out.length >= cap) break;
    } catch {
      continue;
    }
  }
  return out;
}

// Keep only rows whose url is not already on screen. Order preserved; the
// caller's cursor never moves because appending never reorders.
function unseenRows(rows, seenUrls) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const u = r && r.url ? String(r.url) : '';
    if (!u || seenUrls.has(u)) continue;
    seenUrls.add(u);
    out.push(r);
  }
  return out;
}

// Seed a Set from existing rows (call once per list before appending).
function urlSet(rows) {
  const s = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && r.url) s.add(String(r.url));
  }
  return s;
}

module.exports = { cleanLinks, unseenRows, urlSet };