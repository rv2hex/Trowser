'use strict';

// Local accounts: /register + /login with no third party involved.
// Vault: [{ name, gmail, number, salt, hash, createdAt, lastLoginAt, otp, otpExpiry }] in
// accounts.json (0600, user-only). Passwords: scrypt + per-user salt, zero
// new deps (node:crypto). The signed-in user lives in memory — a restart
// signs out. Public shapes never carry salt/hash.
// Email OTP: on /register or /login, send a 6-digit code to the Gmail and
// require the user to enter it before authentication succeeds. OTP expires
// after 10 minutes. /resend OTP re-issues a new code.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRYPT_KEYLEN = 64;
const MIN_PASSWORD = 8;

function accountsFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'tui-browser', 'accounts.json');
}

function cleanStr(v, max) {
  return String(v == null ? '' : v)
    .trim()
    .slice(0, max);
}

function validName(v) {
  const s = cleanStr(v, 60);
  return s.length > 0 ? s : '';
}

function validGmail(v) {
  const s = cleanStr(v, 120).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
}

function validNumber(v) {
  const s = cleanStr(v, 25);
  return /^\+?[\d\s\-().]{5,25}$/.test(s) ? s : '';
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), SCRYPT_KEYLEN).toString('hex');
}

function loadAccounts(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file || accountsFile(), 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (a) =>
        a &&
        typeof a === 'object' &&
        typeof a.gmail === 'string' &&
        typeof a.salt === 'string' &&
        typeof a.hash === 'string'
    );
  } catch {
    return [];
  }
}

// Returns true only when the vault actually persisted — callers must not
// claim a registration/login survived unless this says so.
function saveAccounts(list, file) {
  try {
    const target = file || accountsFile();
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, JSON.stringify(list, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      /* writeFileSync mode usually sticks */
    }
    return true;
  } catch {
    return false;
  }
}

function findByGmail(list, gmail) {
  const g = String(gmail || '').toLowerCase();
  return list.find((a) => String(a.gmail || '').toLowerCase() === g) || null;
}

function publicProfile(account) {
  if (!account) return null;
  return {
    name: account.name || '',
    gmail: account.gmail || '',
    number: account.number || '',
    dob: account.dob || '',
    createdAt: account.createdAt || '',
    lastLoginAt: account.lastLoginAt || '',
  };
}

// Date of birth: YYYY-MM-DD, real-ish calendar check. Empty is allowed
// (optional field). Returns the normalized string or ''.
function validDob(v) {
  const s = cleanStr(v, 10);
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return s;
}

// Edit fields on the signed-in account (or a named account). Password, when
// given, is re-hashed with a fresh salt. Returns { ok, error }.
function updateAccount(gmail, patch = {}, file) {
  const g = String(gmail || '').toLowerCase();
  const list = loadAccounts(file);
  const account = findByGmail(list, g);
  if (!account) return { ok: false, error: 'Account not found.' };
  if (patch.name !== undefined) {
    const n = validName(patch.name);
    if (!n) return { ok: false, error: 'Name can\u2019t be empty.' };
    account.name = n;
  }
  if (patch.number !== undefined) {
    const num = validNumber(patch.number);
    if (!num) return { ok: false, error: 'Enter a valid number.' };
    account.number = num;
  }
  if (patch.dob !== undefined) {
    // Empty clears it; a non-empty value must be valid.
    if (String(patch.dob).trim() === '') account.dob = '';
    else {
      const d = validDob(patch.dob);
      if (!d) return { ok: false, error: 'Date of birth must be YYYY-MM-DD.' };
      account.dob = d;
    }
  }
  if (patch.password !== undefined) {
    if (String(patch.password).length < MIN_PASSWORD) {
      return { ok: false, error: `Password needs at least ${MIN_PASSWORD} characters.` };
    }
    const salt = crypto.randomBytes(16).toString('hex');
    account.salt = salt;
    account.hash = hashPassword(patch.password, salt);
  }
  if (!saveAccounts(list, file)) return { ok: false, error: 'Could not save the change.' };
  return { ok: true, error: '' };
}

// ---- Email OTP (login + registration codes) ----
// Pending codes live in their own 0600 store (otp.json), keyed by gmail —
// NOT on the account record: /register sends its code before the account
// exists. A code is single-use (deleted on success) and expires in 10 min.
const OTP_TTL_MS = 10 * 60 * 1000;

function otpFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'tui-browser', 'otp.json');
}

function loadOtps(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file || otpFile(), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function saveOtps(map, file) {
  try {
    const target = file || otpFile();
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, JSON.stringify(map || {}, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      /* writeFileSync mode usually sticks */
    }
    return true;
  } catch {
    return false;
  }
}

// 6-digit code, crypto-random (Math.random is not good enough for auth).
function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

// Create (or replace) the pending code for a gmail. Returns { ok, otp } —
// the caller emails `otp`; it is never painted in the TUI unless the send
// failed and the user would otherwise be stuck.
function requestOtp(gmail, file) {
  const g = validGmail(gmail);
  if (!g) return { ok: false, error: 'Enter a valid Gmail address.' };
  const otp = generateOtp();
  const map = loadOtps(file);
  map[g] = { otp, expiry: new Date(Date.now() + OTP_TTL_MS).toISOString(), sentAt: new Date().toISOString() };
  if (!saveOtps(map, file)) return { ok: false, error: 'Could not store the code — check disk permissions.' };
  return { ok: true, otp, error: '' };
}

// Check a code: single-use, expires after OTP_TTL_MS, constant-ish compare.
// On success the pending code is deleted and the account (when one exists)
// is returned as a public profile — registration has none yet.
function verifyOtp({ gmail, otp }, file) {
  const g = validGmail(gmail);
  const code = String(otp == null ? '' : otp).trim();
  if (!g || !/^\d{6}$/.test(code)) return { ok: false, error: 'The code did not match.', account: null };
  const map = loadOtps(file);
  const entry = map[g];
  if (!entry) return { ok: false, error: 'No code was requested for that Gmail.', account: null };
  if (Date.now() > Date.parse(entry.expiry || '')) {
    delete map[g];
    saveOtps(map, file);
    return { ok: false, error: 'That code expired — send a new one.', account: null };
  }
  if (String(entry.otp) !== code) return { ok: false, error: 'The code did not match.', account: null };
  delete map[g];
  saveOtps(map, file);
  const account = findByGmail(loadAccounts(file), g);
  return { ok: true, error: '', account: account ? publicProfile(account) : null };
}

// Drop the pending code for a gmail (used before re-issuing one).
function clearOtp(gmail, file) {
  const g = validGmail(gmail);
  if (!g) return false;
  const map = loadOtps(file);
  if (!map[g]) return false;
  delete map[g];
  return saveOtps(map, file);
}

// Read the pending code without consuming it (tests / diagnostics only).
function peekOtp(gmail, file) {
  const g = validGmail(gmail);
  if (!g) return null;
  const entry = loadOtps(file)[g];
  return entry ? { otp: entry.otp, expiry: entry.expiry } : null;
}

function register({ name, gmail, number, password, dob }, file) {
  const n = validName(name);
  if (!n) return { ok: false, error: 'Enter a name.' };
  const g = validGmail(gmail);
  if (!g) return { ok: false, error: 'Enter a valid Gmail address.' };
  const num = validNumber(number);
  if (!num) return { ok: false, error: 'Enter a valid number.' };
  if (String(password || '').length < MIN_PASSWORD) {
    return { ok: false, error: `Password needs at least ${MIN_PASSWORD} characters.` };
  }
  const dobVal = dob === undefined || dob === null || String(dob).trim() === '' ? '' : validDob(dob);
  if (dob !== undefined && String(dob).trim() !== '' && !dobVal) {
    return { ok: false, error: 'Date of birth must be YYYY-MM-DD.' };
  }
  const list = loadAccounts(file);
  if (findByGmail(list, g)) return { ok: false, error: 'That Gmail is already registered. Try /login.' };
  const salt = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString();
  const account = { name: n, gmail: g, number: num, dob: dobVal, salt, hash: hashPassword(password, salt), createdAt: now, lastLoginAt: now };
  list.push(account);
  if (!saveAccounts(list, file)) return { ok: false, error: 'Could not save the account. Nothing was registered.' };
  return { ok: true, error: '', account: publicProfile(account) };
}

function verify({ gmail, password }, file) {
  const g = validGmail(gmail);
  if (!g || !password) return { ok: false, error: 'Gmail and password did not match.', account: null };
  const list = loadAccounts(file);
  const account = findByGmail(list, g);
  if (!account) return { ok: false, error: 'Gmail and password did not match.', account: null };
  let hash = '';
  try {
    hash = hashPassword(password, account.salt);
  } catch {
    return { ok: false, error: 'Gmail and password did not match.', account: null };
  }
  if (hash !== account.hash) return { ok: false, error: 'Gmail and password did not match.', account: null };
  account.lastLoginAt = new Date().toISOString();
  saveAccounts(list, file); // best effort: session counts even if this fails
  return { ok: true, error: '', account: publicProfile(account) };
}

// In-memory session: who is signed in right now. Restart signs out.
let currentGmail = null;

function signInSession(gmail) {
  currentGmail = String(gmail || '').toLowerCase();
}

function signOutSession() {
  currentGmail = null;
}

function currentSession() {
  return currentGmail;
}

module.exports = {
  MIN_PASSWORD,
  OTP_TTL_MS,
  accountsFile,
  otpFile,
  validName,
  validGmail,
  validNumber,
  validDob,
  updateAccount,
  hashPassword,
  loadAccounts,
  saveAccounts,
  findByGmail,
  publicProfile,
  register,
  verify,
  signInSession,
  signOutSession,
  currentSession,
  // Email OTP (login + registration codes)
  generateOtp,
  requestOtp,
  verifyOtp,
  clearOtp,
  peekOtp,
};
