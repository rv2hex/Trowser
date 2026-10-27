'use strict';
// Minimal Gmail SMTP sender — zero new deps (TLS + AUTH LOGIN + MIME).
// Used for OTP email verification and password-reset codes. Best-effort: a
// failed send reports loudly instead of claiming the code was emailed.

const tls = require('tls');

const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465;
// Credentials are NEVER stored in the repo — they come from the environment:
//   SMTP_USER  your full Gmail address
//   SMTP_PASS  a Gmail app password (https://myaccount.google.com/apppasswords)
// Everything except the OTP email (browsing, YouTube, /ai, …) works without them.
const SMTP_NOT_CONFIGURED =
  'SMTP not configured — set SMTP_USER and SMTP_PASS (Gmail app password).';

function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

// Send a plain-text email. Resolves { ok, error }.
function sendMail({ to, subject, text }) {
  // Read at call time so the env can be set after the module loads.
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();
  if (!user || !pass) return Promise.resolve({ ok: false, error: SMTP_NOT_CONFIGURED });
  const from = `TUI Browser <${user}>`;
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* best effort */ }
      resolve({ ok, error: error || '' });
    };
    let sock;
    try {
      sock = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST });
    } catch (e) {
      resolve({ ok: false, error: 'SMTP connect failed: ' + e.message });
      return;
    }
    let buf = '';
    let stage = 0;
    const send = (line) => { try { sock.write(line + '\r\n'); } catch { /* best effort */ } };
    const fail = (msg) => done(false, msg);
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const code = line.slice(0, 3);
        if (line[3] === '-') continue; // multi-line continuation: wait for the last
        if (code[0] === '4' || code[0] === '5') return fail('SMTP: ' + line);
        if (stage === 0) { send('EHLO tui-browser'); stage = 1; continue; }
        if (stage === 1) { send('AUTH LOGIN'); stage = 2; continue; }
        if (stage === 2) { send(b64(user)); stage = 3; continue; }
        if (stage === 3) { send(b64(pass)); stage = 4; continue; }
        if (stage === 4) { send(`MAIL FROM:<${user}>`); stage = 5; continue; }
        if (stage === 5) { send(`RCPT TO:<${to}>`); stage = 6; continue; }
        if (stage === 6) { send('DATA'); stage = 7; continue; }
        if (stage === 7) {
          send([
            `From: ${from}`,
            `To: <${to}>`,
            `Subject: ${subject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset="utf-8"',
            '',
            text,
            '.',
          ].join('\r\n'));
          stage = 8;
          continue;
        }
        if (stage === 8) { send('QUIT'); stage = 9; continue; }
        if (stage === 9) { done(true); return; }
      }
    });
    sock.on('error', (e) => fail('SMTP error: ' + e.message));
    sock.on('timeout', () => fail('SMTP timeout'));
    sock.setTimeout(20000);
  });
}

module.exports = { sendMail };
