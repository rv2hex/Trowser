'use strict';

// Now-playing formatting for the footer row. Pure: takes the object
// mpvQuery() answered (mpv property names, dashes included) and returns
// one plain line — no blessed tags, single-cell glyphs only — or '' when
// there is nothing worth a row. The UI paints it verbatim; glyphs follow
// the app's fullUnicode:false rule: ♪ / ‖ are BMP and one cell wide.

// '82' -> '1:22'; hours only when earned ('1:05:00'). NaN/negatives are
// '' so a live stream (no duration) never prints "NaN:NaN".
function fmtTime(sec) {
  const n = Math.floor(Number(sec));
  if (!Number.isFinite(n) || n < 0) return '';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = String(n % 60).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${s}`;
  return `${m}:${s}`;
}

// info: { 'media-title', 'time-pos', 'duration', 'pause', title }
// opts: { quality } — short label like '720p' appended when known.
// Shape: '♪ 1:22 / 3:40 · Title · 720p' (‖ when paused). A line needs at
// least a title or a position; total silence returns '' and the row hides.
function formatNowPlaying(info, opts) {
  if (!info || typeof info !== 'object') return '';
  const o = opts && typeof opts === 'object' ? opts : {};
  const title = String(info['media-title'] || info.title || '').replace(/\s+/g, ' ').trim();
  const pos = Number(info['time-pos']);
  const dur = Number(info.duration);
  const parts = [];
  if (Number.isFinite(pos) && Number.isFinite(dur) && dur > 0) {
    parts.push(`${fmtTime(pos)} / ${fmtTime(dur)}`);
  } else if (Number.isFinite(pos) && pos >= 0) {
    parts.push(fmtTime(pos));
  }
  if (title) parts.push(title);
  const q = String(o.quality || '').trim();
  if (q) parts.push(q);
  if (!title && !parts.length) return '';
  // The glyph rides WITH the first part ('♪ 1:22 / 3:40 · …') so a
  // position-only row never reads '♪ · 1:22 / 3:40'.
  // The note bops (♪/♫) with the parity of the position second: motion
  // for free — no extra timer — and a paused player stays a still ‖.
  const glyph = info.pause === true ? '‖' : (Number.isFinite(pos) && Math.floor(pos) % 2 === 1 ? '♫' : '♪');
  const head = parts.length ? `${glyph} ${parts[0]}` : glyph;
  return [head, ...parts.slice(1)].join(' · ');
}

module.exports = { fmtTime, formatNowPlaying };
