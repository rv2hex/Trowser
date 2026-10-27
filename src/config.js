'use strict';

// App preferences: theme name + links per page.
// Plain JSON, best-effort IO (a broken config never breaks the app —
// defaults win). Unknown keys (e.g. retired googleClientId) are ignored.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { themeNames } = require('./themes');
const { DEFAULT_QUALITY, normalizeQuality, DEFAULT_VO, normalizeVo } = require('./quality');

const DEFAULTS = { theme: 'white', pageSize: 50, quality: DEFAULT_QUALITY, vo: DEFAULT_VO, idleTeardownMin: 0, quitPlayer: 'ask', readerMode: 'reader', glow: false, aiModel: '', restoreSession: false };
// Reader view default: 'reader' (clean article) or 'raw' (full page text).
const READER_MODES = ['reader', 'raw'];
// Quit-with-video choices: ask every time (default), always keep the player
// running, or always stop it.
const QUIT_PLAYER_CHOICES = ['ask', 'keep', 'stop'];
// /links page sizes. 10 is the floor: DuckDuckGo's HTML endpoint serves
// exactly 10 results per page, so 10 is "no fan-out", anything higher
// fetches extra pages (and related-query variations) in the background.
const PAGE_SIZES = [10, 25, 50, 100];
// Idle teardown bounds (minutes). 0 = off (default): Chrome is only closed
// when the user asks (/home) or at quit. A positive value parks the engine
// after that many idle minutes and relaunches it on the next navigation.
const IDLE_TEARDOWN_MAX_MIN = 240;

function configFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'tui-browser', 'config.json');
}

function loadConfig(file) {
  const merged = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(file || configFile(), 'utf8'));
    if (raw && typeof raw === 'object') {
      if (typeof raw.theme === 'string' && themeNames().includes(raw.theme)) {
        merged.theme = raw.theme;
      }
      if (PAGE_SIZES.includes(raw.pageSize)) merged.pageSize = raw.pageSize;
      const q = normalizeQuality(raw.quality);
      if (q) merged.quality = q;
      const vo = normalizeVo(raw.vo);
      if (vo) merged.vo = vo;
      // Idle teardown: minutes, clamped. 0 (or garbage) = off.
      const idle = Math.floor(Number(raw.idleTeardownMin));
      if (Number.isFinite(idle) && idle > 0) {
        merged.idleTeardownMin = Math.min(idle, IDLE_TEARDOWN_MAX_MIN);
      }
      // Quit-with-video behavior: ask | keep | stop.
      if (QUIT_PLAYER_CHOICES.includes(raw.quitPlayer)) merged.quitPlayer = raw.quitPlayer;
      // Reader mode: reader | raw.
      if (READER_MODES.includes(raw.readerMode)) merged.readerMode = raw.readerMode;
      // Opt-in session restore: boolean.
      if (typeof raw.restoreSession === 'boolean') merged.restoreSession = raw.restoreSession;
      // Rainbow glow: boolean.
      if (typeof raw.glow === 'boolean') merged.glow = raw.glow;
      // /ai model pick (OpenRouter id, e.g. '…:free'). Any non-empty string
      // is kept: a custom id the user pasted must not be silently swapped —
      // a dead id paints its own 404 guidance, which beats a mystery switch.
      if (typeof raw.aiModel === 'string' && raw.aiModel.trim()) {
        merged.aiModel = raw.aiModel.trim().slice(0, 120);
      }
    }
  } catch {
    // First run or corrupt file: defaults.
  }
  return merged;
}

function saveConfig(cfg, file) {
  try {
    const target = file || configFile();
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const out = { theme: cfg.theme, pageSize: cfg.pageSize, quality: normalizeQuality(cfg.quality) || DEFAULTS.quality, vo: normalizeVo(cfg.vo) || DEFAULTS.vo, idleTeardownMin: Math.max(0, Math.min(IDLE_TEARDOWN_MAX_MIN, Math.floor(Number(cfg.idleTeardownMin)) || 0)), quitPlayer: QUIT_PLAYER_CHOICES.includes(cfg.quitPlayer) ? cfg.quitPlayer : DEFAULTS.quitPlayer, readerMode: READER_MODES.includes(cfg.readerMode) ? cfg.readerMode : DEFAULTS.readerMode, glow: !!cfg.glow, restoreSession: !!cfg.restoreSession, aiModel: typeof cfg.aiModel === 'string' ? cfg.aiModel.trim().slice(0, 120) : '' };
    fs.writeFileSync(target, JSON.stringify(out, null, 2));
  } catch {
    // Best effort: prefs just won't survive restarts.
  }
}

module.exports = { DEFAULTS, PAGE_SIZES, IDLE_TEARDOWN_MAX_MIN, QUIT_PLAYER_CHOICES, READER_MODES, configFile, loadConfig, saveConfig };
