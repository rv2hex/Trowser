'use strict';

// Local extractive summarizer: zero deps, no network, no API key.
// Scores sentences by word frequency (minus stopwords) + lead bonus,
// dedupes near-identical lines, returns the winners in original order.
// Used for the bottom "AI summary" box on search pages (auto) and `/ai`
// on articles (on demand). Pure + unit-testable.

const STOPWORDS = new Set(
  ('a,an,the,and,or,but,if,then,else,when,at,by,for,with,about,into,through,' +
    'during,before,after,above,below,to,from,up,down,in,out,on,off,over,under,' +
    'again,further,once,here,there,when,where,why,how,all,any,both,each,few,' +
    'more,most,other,some,such,no,nor,not,only,own,same,so,than,too,very,can,' +
    'will,just,don,should,now,is,are,was,were,be,been,being,have,has,had,' +
    'having,do,does,did,doing,would,could,ought,i,you,he,she,it,we,they,' +
    'them,his,her,its,our,their,this,that,these,those,as,of,what,which,who,' +
    'whom,because,until,while,between,both,each,few,more,most,other,some')
    .split(',')
);

function wordsOf(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function splitSentences(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  // Primary: punctuation-led boundaries. Fallback: newlines for fragments
  // (search titles rarely end with periods).
  let parts = t
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    parts = String(text || '')
      .split('\n')
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter((s) => s.length >= 12);
  }
  return parts
    .map((s) => s.slice(0, 400))
    .filter((s) => s.length >= 20 && s.length <= 400)
    .slice(0, 100);
}

function jaccard(a, b) {
  const A = new Set(wordsOf(a));
  const B = new Set(wordsOf(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// Extractive summary of running prose. Returns '' when there is too
// little to summarize honestly (callers show a "too short" hint).
function summarize(text, { maxSentences = 5, maxChars = 900 } = {}) {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return '';
  const freq = new Map();
  for (const s of sentences) {
    for (const w of wordsOf(s)) freq.set(w, (freq.get(w) || 0) + 1);
  }
  const n = Math.max(1, Math.min(24, Number(maxSentences) || 5));
  const scored = sentences.map((s, idx) => {
    const ws = wordsOf(s);
    let score = 0;
    for (const w of ws) score += freq.get(w) || 0;
    if (ws.length > 0) score /= Math.sqrt(ws.length);
    score += Math.max(0, 2 - idx * 0.3); // lead bonus: intro sentences matter
    return { s, idx, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of scored) {
    if (picked.length >= n) break;
    if (picked.some((p) => jaccard(p.s, c.s) > 0.6)) continue; // near-dupe
    picked.push(c);
  }
  picked.sort((a, b) => a.idx - b.idx);
  let out = picked.map((p) => p.s).join(' ');
  out = out.slice(0, Math.max(200, Number(maxChars) || 900)).trim();
  return out.length >= 60 ? out : '';
}

// Answer-style digest of search results. When result snippets are present
// (DDG/Google rows carry them), the box synthesizes what the sources SAY —
// like an AI answer — instead of echoing titles. Output is bullets: the
// bottom bar and the fullscreen digest both read as a list, and no markup
// or URLs ever reach the terminal.
// Without snippets it falls back to the title digest. Returns '' when
// there is too little to say honestly.
function summarizeResults(results, { maxItems = 5, maxSentences = 4 } = {}) {
  const rows = (Array.isArray(results) ? results : []).filter(
    (r) => r && !/^search youtube for/i.test(String((r && r.title) || ''))
  );
  const withSnippets = rows
    .map((r) => ({ title: String(r.title || '').trim(), snippet: String(r.snippet || '').trim() }))
    .filter((r) => r.snippet.length > 40)
    .slice(0, Math.max(1, Math.min(10, Number(maxItems) || 5)));
  if (withSnippets.length >= 2) {
    // Weave titles into the text so the scorer sees complete thoughts,
    // then extract the highest-signal sentences as the answer paragraph.
    const corpus = withSnippets.map((r) => `${r.title}. ${r.snippet}`).join('\n');
    const n = Math.max(2, Math.min(12, Number(maxSentences) || 10));
    const para = summarize(corpus, { maxSentences: n, maxChars: 8000 });
    if (para) return bulletize(para, n);
  }
  const list = rows
    .map((r) => String(r.title || '').trim().replace(/\s+/g, ' '))
    .filter((t) => t.length >= 8)
    .slice(0, Math.max(1, Math.min(10, Number(maxItems) || 5)));
  if (list.length < 2) return '';
  const lines = list.map((t) => `• ${t.slice(0, 120)}`);
  return `The top results say:\n${lines.join('\n')}`;
}

// Split prose into terminal bullets. Sentences only (never mid-sentence
// cuts), markdown/URL debris removed, one point per line.
function bulletize(paragraph, maxBullets = 6) {
  const cap = Math.max(1, Math.min(12, Number(maxBullets) || 6));
  const parts = splitSentences(String(paragraph || '').replace(/\s+/g, ' '))
    .map((s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim())
    .filter((s) => s.length >= 25 && s.length <= 300);
  if (!parts.length) return '';
  return `The results say:\n${parts.slice(0, cap).map((s) => `• ${s}`).join('\n')}`;
}

// Question-shaped query detector: only these trigger a real Gemini answer
// on search (quota discipline — navigational/operator queries stay fast).
// Pure, never throws.
function looksLikeQuestion(q) {
  try {
    const s = String(q || '').trim();
    if (!s || s.length > 120) return false;
    if (/[?？]\s*$/.test(s)) return true;
    // Operator queries and bare domains are navigation, not questions.
    if (/\b(site:|filetype:|inurl:|intitle:|before:|after:)/i.test(s)) return false;
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s) && !/\s/.test(s)) return false;
    return /^(what|who|why|how|when|where|which|whose|whom|is|are|was|were|do|does|did|can|could|should|would|will|explain|define|describe|compare|difference between|tell me)\b/i.test(s);
  } catch {
    return false;
  }
}

module.exports = { STOPWORDS, wordsOf, splitSentences, jaccard, summarize, summarizeResults, bulletize, looksLikeQuestion };
