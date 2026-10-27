# Local accounts — BUILT (replaces the old Google/OAuth design)

Status: **implemented.** No third party involved: `/register` and `/login`
work against a local vault. Google OAuth (`src/google-auth.js`), the headed
Google flows, and `--login` were removed.

## Design (as built)
- Vault `~/.config/tui-browser/accounts.json`, mode `0600`:
  `[{ name, gmail, number, salt, hash, createdAt, lastLoginAt }]`.
- Passwords: `crypto.scryptSync` + per-user random salt. Zero new deps.
- Session is in-memory (`src/accounts.js`); a restart signs out.
- `/register` wizard: name → Gmail (format + unique) → number → password
  (min 8, censored) → confirm. Esc cancels any step.
- `/login` wizard: Gmail → password. Failures say "did not match"
  (no user enumeration).
- `/logout` signs out locally and wipes the browser profile (unchanged).
- `/profile` shows everything: account (name, Gmail, number, registered,
  last login) + browser profile, session, theme (config-only), page size
  (`/links`), history.
- Public shapes never carry salt/hash (`publicProfile`).
- Registration/login forms render in the web view with a block caret
  (`paintForm` in `src/ui.js`); the omnibox stays the input buffer.

## Deliberately out of scope
- No Gmail OTP (needs a mail sender + data), no web-form autofill, no sync.
- `saveAccounts` returning false fails the registration loudly instead of
  claiming it survived (data-loss prevention).
