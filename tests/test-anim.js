'use strict';

// Shared animation frames + the self-stopping ticker (src/anim.js). The
// failure modes this pins: frames must wrap (and survive junk input) so a
// long-running animation never reads NaN; the ticker must start on the
// first subscriber, stop the moment the last one leaves (zero timers at
// rest = the memory rule), isolate a throwing subscriber, and respect
// per-subscriber cadence.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { BOP, DOTS, bop, dots, createTicker } = require('../src/anim');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('anim: frames', () => {
  it('bop alternates ♪/♫ and wraps both directions', () => {
    assert.deepEqual(BOP, ['♪', '♫']);
    assert.equal(bop(0), '♪');
    assert.equal(bop(1), '♫');
    assert.equal(bop(2), '♪');
    assert.equal(bop(-1), '♫');
    assert.equal(bop('junk'), '♪');
    assert.equal(bop(1e9 + 1), bop(1));
  });

  it('dots grow, hold and shrink through the table, wrapping', () => {
    assert.equal(dots(0), DOTS[0]);
    assert.equal(dots(DOTS.length), DOTS[0]);
    assert.equal(dots(-1), DOTS[DOTS.length - 1]);
    assert.equal(dots(undefined), DOTS[0]);
  });

  it('every frame glyph is BMP (single-cell house rule)', () => {
    for (const g of [...BOP, ...DOTS.flatMap((d) => [...d])]) {
      assert.ok(g.codePointAt(0) < 0x10000, `not BMP: ${JSON.stringify(g)}`);
    }
  });
});

describe('anim: ticker', () => {
  it('starts on first add, ticks on cadence, stops when idle', async () => {
    const t = createTicker({ baseMs: 20 });
    let calls = 0;
    assert.equal(t.active, false);
    const off = t.add(() => { calls += 1; }, 20);
    assert.equal(t.active, true);
    assert.equal(t.size, 1);
    // Wide window: the full suite runs test files in parallel and load can
    // starve a 20 ms interval — cadence is pinned, latency is not.
    await wait(350);
    assert.ok(calls >= 2, `ticked ${calls}x`);
    off();
    assert.equal(t.active, false);
    assert.equal(t.size, 0);
    const atStop = calls;
    await wait(90);
    assert.equal(calls, atStop, 'no ticks after the last unsubscribe');
  });

  it('keeps running while another subscriber remains; isolates throws', async () => {
    const t = createTicker({ baseMs: 15 });
    let good = 0;
    const offBad = t.add(() => { throw new Error('boom'); }, 15);
    const offGood = t.add(() => { good += 1; }, 15);
    await wait(250);
    assert.ok(t.active, 'still active');
    assert.ok(good >= 2, `good subscriber kept ticking (${good})`);
    offBad();
    assert.ok(t.active, 'one left -> still ticking');
    offGood();
    assert.equal(t.active, false, 'idle after last off');
  });

  it('stop() clears everything even with subscribers attached', async () => {
    const t = createTicker({ baseMs: 15 });
    let calls = 0;
    t.add(() => { calls += 1; }, 15);
    await wait(50);
    t.stop();
    assert.equal(t.active, false);
    assert.equal(t.size, 0);
    const atStop = calls;
    await wait(50);
    assert.equal(calls, atStop);
  });
});
