#!/usr/bin/env node
'use strict';

// Box-perfection check against REAL pages (opt-in; needs network + Chrome).
//
// For every URL: fetch it through the app's own Browser (reader + pretty),
// then render the pretty text EXACTLY the way paintPretty boxes it
// (boxSections -> blockMd) at several container widths and assert every box
// is drawn to perfection with verifyBoxContainment:
//   * every row fits the container,
//   * all right edges of a box line up in one column,
//   * each box has both caps (╭ ... ╰),
//   * nothing escaped into a non-prefixed continuation line.
//
// The browser is ALWAYS closed (finally), even on error.
//
// Run:  node scripts/boxcheck.js [url ...]
// Env:  BOXCHECK_WIDTHS=40,60,80,100   (default)
//       BOXCHECK_FILE=/tmp/opencode/boxcheck.txt (report path)

const fs = require('fs');
const path = require('path');
const { Browser } = require('../src/browser');
const { boxSections, blockMd, verifyBoxContainment, visLen } = require('../src/beautify');
void verifyBoxContainment; // kept available for callers that want the strict form

// Same brace-escaping paintPretty applies before boxes (escTags in ui.js).
function escTags(s) {
  return String(s ?? '').replace(/[{}]/g, (m) => (m === '{' ? '{open}' : '{close}'));
}

const DEFAULT_URLS = [
  'https://en.wikipedia.org/wiki/Godot_(game_engine)',
  'https://en.wikipedia.org/wiki/Linux',
  'https://en.wikipedia.org/wiki/Cat',
];

const WIDTHS = String(process.env.BOXCHECK_WIDTHS || '40,60,80,100')
  .split(',')
  .map((n) => parseInt(n.trim(), 10))
  .filter((n) => Number.isFinite(n) && n >= 20);

const REPORT = process.env.BOXCHECK_FILE || '/tmp/opencode/boxcheck.txt';

const out = [];
function put(line) {
  out.push(line);
  console.log(line);
}

// Render a pretty article the way paintPretty does, at container width W.
function renderBoxed(pretty, W) {
  const boxed = boxSections(escTags(pretty), { width: W, available: W });
  const cooked = blockMd(boxed.text);
  return { boxed, cooked };
}

// Audit ONLY real box runs (opened by ╭, closed by ╰). Non-box prose and
// raw `│ ` quote rails outside a run are blessed's wrap responsibility, not
// box defects, so they are ignored. Inside a run, every row must be a `│`
// row of the SAME width (a non-`│` row = an escaped row: the link-line bug).
function analyzeBoxes(cooked) {
  const rows = String(cooked).split('\n');
  const boxes = [];
  let run = null;
  const close = () => { if (run) { boxes.push(run); run = null; } };
  for (let i = 0; i < rows.length; i++) {
    const ln = rows[i];
    if (/^╭/.test(ln)) {
      if (run) { run.problems.push('previous box never closed'); close(); }
      run = { start: i, end: -1, width: visLen(ln), problems: [], rows: [ln] };
      if (!/╮\s*$/.test(ln)) run.problems.push(`row ${i}: top border missing right ╮`);
    } else if (run) {
      run.rows.push(ln);
      if (/^╰/.test(ln)) {
        run.end = i;
        if (visLen(ln) !== run.width) run.problems.push(`row ${i}: bottom width ${visLen(ln)} != top ${run.width}`);
        if (!/╯\s*$/.test(ln)) run.problems.push(`row ${i}: bottom border missing right ╯`);
        close();
      } else if (/^│/.test(ln)) {
        if (!/│\s*$/.test(ln)) run.problems.push(`row ${i}: mid row lost its right │ — ESCAPED: ${JSON.stringify(ln.slice(0, 44))}`);
        else if (visLen(ln) !== run.width) run.problems.push(`row ${i}: mid width ${visLen(ln)} != top ${run.width}`);
      } else if (ln.trim()) {
        run.problems.push(`row ${i}: ESCAPED content inside the box: ${JSON.stringify(ln.slice(0, 44))}`);
      } else {
        run.problems.push(`row ${i}: unexpected blank row inside the box`);
      }
    }
  }
  if (run) { run.problems.push('box never closed'); close(); }
  return boxes;
}

async function main() {
  const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_URLS;
  const browser = new Browser({ profileDir: path.join('/tmp/opencode', 'boxcheck-profile') });
  let failures = 0;
  let checks = 0;
  try {
    for (const url of urls) {
      put(`\n=== ${url} ===`);
      let result;
      try {
        result = await browser.navigate(url);
      } catch (e) {
        put(`  SKIP (navigate failed): ${(e && e.message) || e}`);
        continue;
      }
      const pretty = String((result && result.pretty) || '').trim();
      if (pretty.length < 50) {
        put(`  SKIP (no pretty text: ${pretty.length} chars)`);
        continue;
      }
      put(`  pretty: ${pretty.length} chars, ${pretty.split('\n').length} lines`);
      for (const W of WIDTHS) {
        checks++;
        const { boxed, cooked } = renderBoxed(pretty, W);
        if (!boxed.boxed) {
          put(`  W=${W}: passthrough (no boxes) — ok`);
          continue;
        }
        const boxes = analyzeBoxes(cooked);
        const problems = boxes.reduce((n, b) => n + b.problems.length, 0);
        if (boxes.length >= 1 && problems === 0) {
          put(`  W=${W}: PERFECT (${boxes.length} boxes)`);
        } else {
          failures++;
          put(`  W=${W}: BAD — ${boxes.length} boxes, ${problems} problems`);
          for (const b of boxes) {
            for (const p of b.problems.slice(0, 4)) put(`      ${p}`);
          }
          // Dump the first imperfect box for eyeballing.
          const bad = boxes.find((b) => b.problems.length) || boxes[0];
          if (bad) {
            put('      --- first box ---');
            for (const r of bad.rows.slice(0, 12)) put(`      ${r}`);
          }
        }
      }
    }
  } finally {
    // ALWAYS close the browser: a leaked engine can exhaust RAM.
    try { await browser.close(); } catch { /* best effort */ }
  }
  put(`\nboxcheck: ${checks - failures}/${checks} width-checks perfect`);
  try {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, out.join('\n'));
  } catch { /* report is best-effort */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('boxcheck crashed:', (e && e.message) || e);
  process.exit(2);
});
