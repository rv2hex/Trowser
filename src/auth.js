'use strict';

// Auth entry points. Separated from index.js so the TUI wiring never deals
// with session flows: `--logout` wipes the saved browser profile.
// Accounts (/register, /login) are local — see src/accounts.js.
// Lazy on purpose: this module loads on the boot path (index.js) and
// ./browser drags in heavy web dependencies; only the --wipe handler
// needs them, long after boot.
function browserLib() {
  return require('./browser');
}

function handleAuthArgs(args) {
  const set = new Set(args);
  if (set.has('--logout')) {
    browserLib().Browser.wipeProfile();
    console.log(`Wiped browser profile at ${browserLib().defaultProfileDir()}`);
    process.exit(0);
    return true;
  }
  return false;
}

module.exports = { handleAuthArgs };
