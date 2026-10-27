'use strict';

// Now-playing row (src/nowplaying.js): pure formatting of mpv's answered
// properties into the one footer line. The failure modes this pins: a
// live stream without a duration must not print "NaN:NaN"; a fresh spawn
// without title/position must return '' so the row stays hidden (zero
// dead chrome); paused state must be visible at a glance.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { fmtTime, formatNowPlaying } = require('../src/nowplaying');

describe('nowplaying: formatting', () => {
  it('fmtTime is m:ss under an hour, h:mm:ss after, empty on junk', () => {
    assert.equal(fmtTime(0), '0:00');
    assert.equal(fmtTime(82), '1:22');
    assert.equal(fmtTime(600), '10:00');
    assert.equal(fmtTime(3661), '1:01:01');
    assert.equal(fmtTime(-5), '');
    assert.equal(fmtTime('nope'), '');
    assert.equal(fmtTime(undefined), '');
  });

  it('a playing track reads as glyph · position · title · quality', () => {
    const line = formatNowPlaying(
      { 'media-title': 'Gotham Chess — Speedrun', 'time-pos': 82, duration: 220, pause: false },
      { quality: '720p' }
    );
    assert.equal(line, '♪ 1:22 / 3:40 · Gotham Chess — Speedrun · 720p');
  });

  it('pause flips the glyph, whitespace in titles is squeezed', () => {
    const line = formatNowPlaying({ 'media-title': '  A   B \n', 'time-pos': 5, duration: 60, pause: true });
    assert.equal(line, '‖ 0:05 / 1:00 · A B');
  });

  it('a live stream (no duration) shows elapsed only — never NaN', () => {
    const line = formatNowPlaying({ 'media-title': 'Radio', 'time-pos': 61 });
    assert.equal(line, '♫ 1:01 · Radio');
    assert.ok(!line.includes('NaN'));
  });

  it('position without a title still earns a row; total silence does not', () => {
    assert.equal(formatNowPlaying({ 'time-pos': 3, duration: 10 }), '♫ 0:03 / 0:10');
    assert.equal(formatNowPlaying({}), '');
    assert.equal(formatNowPlaying(null), '');
    assert.equal(formatNowPlaying(undefined, { quality: '720p' }), '');
  });

  it('title-only (spawn moment) shows the title alone', () => {
    assert.equal(formatNowPlaying({ 'media-title': 'Warming up' }), '♪ Warming up');
  });

  it('the note bops with the position second (♪ even, ♫ odd); paused stays still', () => {
    assert.equal(formatNowPlaying({ 'media-title': 'X', 'time-pos': 0, duration: 10 }), '♪ 0:00 / 0:10 · X');
    assert.equal(formatNowPlaying({ 'media-title': 'X', 'time-pos': 1, duration: 10 }), '♫ 0:01 / 0:10 · X');
    assert.equal(formatNowPlaying({ 'media-title': 'X', 'time-pos': 2.9, duration: 10 }), '♪ 0:02 / 0:10 · X');
    assert.equal(formatNowPlaying({ 'media-title': 'X', 'time-pos': 3, duration: 10, pause: true }), '‖ 0:03 / 0:10 · X');
  });
});
