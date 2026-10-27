#!/usr/bin/env python3
"""Chaos TUI: adversarial key-driven torture test for tui-browser.

Boots the REAL app in a PTY and abuses it like a hostile user: bang typos,
unknown scopes, unknown commands, form escapes, picker wrap-around, resize
storms, control-char torture, random bursts — then checks after every phase
that the app is alive AND still echoing keystrokes (stuck-input detector).

Safety rules (mandatory):
  * NEVER presses Enter on anything that navigates or sends mail: no search
    query, no quick-link row, no form submit, no `>wiki <query>` (that would
    fetch + launch Chrome). Bang-with-no-query and each slash command in the
    safe list are the only Enters.
  * teardown SIGTERMs/SIGKILLs the whole process group.
  * startup config is a throwaway XDG_CONFIG_HOME.

Checks: process liveness, fatal-error scan, echo/stuck detection, literal
blessed-tag artifact scan, config JSON validity, otp.json hygiene (no code
file from merely opening a form / resending while signed out), chrome/mpv
stray count.

Run:  python3 scripts/chaos_tui.py
Env:  CHAOS_LOG - transcript path (default /tmp/opencode/chaos_tui.log)
      APP_DIR   - project dir (default: parent of this script's dir)
"""
import json
import os
import pty
import random
import re
import select
import signal
import struct
import fcntl
import subprocess
import sys
import tempfile
import termios
import time

APP_DIR = os.environ.get("APP_DIR", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHAOS_LOG = os.environ.get("CHAOS_LOG", "/tmp/opencode/chaos_tui.log")
ANSI = re.compile(r"\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][AB0]|\x1bO[A-Z]|\x1b[^[]|\r")

FATALS = [
    "Maximum call stack size exceeded",
    "UnhandledPromiseRejection",
    "Unhandled 'error' event",
    "TypeError:",
    "ReferenceError:",
    "SyntaxError:",
    "RangeError:",
    "AssertionError",
    "Segmentation fault",
    "\n    at ",  # a stack frame in raw output = an uncaught throw
]
TAG_ARTIFACT = re.compile(r"\{[a-zA-Z0-9_-]+-fg\}|\{/\}|\{bold\}|\{cyan-fg\}")

results = []  # (phase, ok, detail)


def strip_ansi(data):
    return ANSI.sub("", data.decode("utf-8", "replace"))


class Session:
    def __init__(self):
        self.cfg = tempfile.mkdtemp(prefix="xdg-chaos-")
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        env["TUI_TEST"] = "1"
        env["XDG_CONFIG_HOME"] = self.cfg
        env.pop("COLORTERM", None)
        self.proc = subprocess.Popen(
            ["node", "src/index.js"],
            cwd=APP_DIR,
            stdin=self.slave,
            stdout=self.slave,
            stderr=subprocess.STDOUT,
            env=env,
            preexec_fn=os.setsid,
        )
        os.close(self.slave)
        self.buf = ""
        self.raw = b""
        self.sent = 0
        self.died_code = None
        self.notes = []

    # ---- io ----
    def drain(self, quiet_ms=250, timeout=8.0):
        end_quiet = None
        start = time.time()
        while time.time() - start < timeout:
            r, _, _ = select.select([self.master], [], [], 0.05)
            if r:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                self.raw += chunk
                self.buf += strip_ansi(chunk)
                end_quiet = None
            else:
                if end_quiet is None:
                    end_quiet = time.time()
                elif (time.time() - end_quiet) * 1000 >= quiet_ms:
                    break
            if self.proc.poll() is not None:
                try:
                    while True:
                        r, _, _ = select.select([self.master], [], [], 0.1)
                        if not r:
                            break
                        chunk = os.read(self.master, 65536)
                        if not chunk:
                            break
                        self.raw += chunk
                        self.buf += strip_ansi(chunk)
                except OSError:
                    pass
                self.died_code = self.proc.returncode
                break
        return self.buf

    def send(self, label, raw, note="", settle=0.35, quiet_ms=250):
        # `note` is documentation for the transcript reader; it never reaches
        # the app. Keys go straight to the PTY master.
        self.notes.append((label, note))
        before = len(self.buf)
        os.write(self.master, raw)
        self.sent += 1
        time.sleep(settle)
        self.drain(quiet_ms=quiet_ms)
        return self.buf[before:]

    def resize(self, cols, rows=24, settle=0.25):
        try:
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            return
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGWINCH)
        except Exception:
            pass
        time.sleep(settle)
        self.drain(quiet_ms=150, timeout=4.0)

    def alive(self):
        rc = self.proc.poll()
        if rc is not None and self.died_code is None:
            self.died_code = rc
        return rc is None

    # ---- focus / line helpers (all navigation-free) ----
    def focus_input(self):
        # Esc exits panels/focus back to the omnibox; twice for nested state.
        os.write(self.master, b"\x1b")
        time.sleep(0.15)
        os.write(self.master, b"\x1b")
        time.sleep(0.15)
        self.drain(quiet_ms=120)
        self.sent += 2

    def clear_line(self):
        self.focus_input()
        os.write(self.master, b"\x7f" * 140)
        time.sleep(0.2)
        self.drain(quiet_ms=120)
        self.sent += 1

    def type_and_clear(self, text):
        os.write(self.master, text.encode())
        time.sleep(0.25)
        self.drain(quiet_ms=150)
        self.clear_line()

    def echo_check(self, phase, settle=0.3):
        """Type a unique marker; a live TUI must show it after a full redraw."""
        marker = "mk" + "".join(random.choice("abcdefghjkmnpqrstuvwxyz") for _ in range(5))
        before = len(self.buf)
        os.write(self.master, marker.encode())
        self.sent += 1
        time.sleep(settle)
        self.drain(quiet_ms=200)
        self.resize(79)
        self.resize(80)
        new = self.buf[before:]
        ok = marker in new
        self.expect(phase, ok and self.alive(), "echo=" + ("ok" if ok else "MISSING") + f" alive={self.alive()}")
        self.clear_line()
        return ok

    def expect(self, phase, ok, detail=""):
        results.append((phase, bool(ok), detail))
        print(f"[{('PASS' if ok else 'FAIL')}] {phase}: {detail}", flush=True)
        return bool(ok)

    def crash_scan(self, phase):
        found = [p for p in FATALS if p in self.buf]
        if found:
            ctx = ""
            for p in found:
                i = self.buf.find(p)
                ctx += repr(self.buf[max(0, i - 80):i + 120]) + " | "
            self.expect(phase + ":no-crash", False, f"fatal markers {found} ctx={ctx[:400]}")
            return False
        return True

    def teardown(self):
        try:
            if self.proc.poll() is None:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
                try:
                    self.proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
        except Exception:
            pass
        try:
            os.close(self.master)
        except OSError:
            pass


def cfg_files(cfg):
    out = []
    for root, _d, files in os.walk(cfg):
        for f in files:
            out.append(os.path.join(root, f))
    return out


def main():
    os.makedirs(os.path.dirname(CHAOS_LOG), exist_ok=True)
    s = Session()
    t0 = time.time()
    try:
        # ---------- P0: boot ----------
        s.drain(quiet_ms=900, timeout=14.0)
        if not s.expect("P0:boot", s.alive(), f"alive={s.alive()} bytes={len(s.buf)}"):
            raise SystemExit(1)

        # ---------- P1: echo baseline ----------
        s.echo_check("P1:echo-baseline")
        s.crash_scan("P1")

        # ---------- P2: palette + bangs (Enter ONLY on hint paths) ----------
        s.clear_line()
        s.send("palette-slash", b"/", "open palette")
        s.send("palette-noise", b"zz!!", "noise in palette")
        s.focus_input()
        s.clear_line()

        for bang in (">wiki", ">gh", ">WIKI", ">", ">>", ">notascope", ">>>"):
            s.clear_line()
            os.write(s.master, bang.encode())
            time.sleep(0.2)
            s.drain(quiet_ms=150)
            s.sent += 1
            if bang in (">", ">>", ">>>"):
                # brace-and-beyond: never Enter a bare > (it WOULD navigate)
                s.clear_line()
                continue
            mark = len(s.buf)
            s.send(f"bang-enter{bang}", b"\r", "hint path only", settle=0.35)
            s.resize(79)
            s.resize(80)
            # Everything since Enter: one redraw is ~4KB, so a fixed tail
            # window sat right at the edge and made this check flaky.
            ok = ("Unknown scope" in s.buf[mark:]) and s.alive()
            s.expect(f"P2:bang-hint{bang}", ok, "hint shown" if ok else "MISSING hint")
        for bang in (">notascope reaction", ">  spaced"):
            # These carry a query but never resolve: parse to unknown — the
            # fix guarantees unresolved `>` prefixes teach instead of
            # navigate, so Enter is the very behaviour under test. (NOT
            # `>>>wiki x`: extra `>`s collapse to a REAL scope by design,
            # and Entering that would navigate — the chaos safety rule
            # forbids it. Collapse is covered by unit tests instead.)
            s.clear_line()
            os.write(s.master, bang.encode())
            time.sleep(0.25)
            s.drain(quiet_ms=150)
            s.sent += 1
            mark = len(s.buf)
            s.send(f"bang-query-enter{bang}", b"\r", "must teach, not navigate", settle=0.4)
            s.resize(79)
            s.resize(80)
            ok = ("Unknown scope" in s.buf[mark:]) and s.alive()
            s.expect(f"P2:bang-teach{bang}", ok, "taught" if ok else "MISSING teach")
        s.crash_scan("P2")
        s.echo_check("P2:echo-after-bangs")

        # ---------- P3: slash-command fuzz ----------
        cmds = ["/help", "/help all", "/nonexistentcmd", "//", "//home", "/resend",
                "/quality", "/vo", "/settings", "/themes", "/links", "/bookmarks",
                "/history", "/pets"]
        for c in cmds:
            s.clear_line()
            os.write(s.master, c.encode())
            time.sleep(0.2)
            s.drain(quiet_ms=150)
            s.sent += 1
            s.send(f"cmd{c}", b"\r", "submit", settle=0.5)
            if not s.alive():
                s.expect(f"P3:{c}", False, f"DIED rc={s.died_code}")
                break
            s.expect(f"P3:{c}", True, "alive")
            if c in ("/settings", "/themes", "/links"):
                s.send("settings-arrows", b"\x1b[C" * 25 + b"\x1b[D" * 25, "arrow spam")
                s.resize(20, 10)
                s.send("settings-tiny-arrows", b"\x1b[C\x1b[D\x1b[A\x1b[B", "tiny resize arrows")
                s.resize(80, 24)
                s.send("settings-lock", b"\r", "lock a value", settle=0.4)
            if c in ("/bookmarks", "/history"):
                s.send("list-arrows", b"\x1b[A\x1b[B\x1b[A", "list cursor")
        s.focus_input()
        s.clear_line()
        s.expect("P3:resend-no-otp", not any(f.endswith("otp.json") for f in cfg_files(s.cfg)),
                 "no otp.json from /resend when signed out")
        s.crash_scan("P3")
        s.echo_check("P3:echo-after-commands")

        # ---------- P4: form fuzz (Esc-only; NEVER submit = never mail) ----------
        for form_cmd in ("/login", "/register"):
            s.clear_line()
            os.write(s.master, form_cmd.encode())
            time.sleep(0.2)
            s.drain(quiet_ms=150)
            s.sent += 1
            s.send(f"form{form_cmd}", b"\r", "open form", settle=0.5)
            s.send("form-junk", b"not-an-email@@@ !!!", "junk into field 0")
            s.send("form-arrows", b"\x1b[A\x1b[B\x1b[C\x1b[D", "arrows in form")
            s.resize(41, 13)
            s.send("form-tiny", b"x", "type in tiny form")
            s.resize(80, 24)
            s.send("form-esc", b"\x1b", "cancel form", settle=0.4)
            s.send("form-esc2", b"\x1b", "cancel again", settle=0.3)
            s.expect(f"P4:{form_cmd}-cancel", s.alive(), f"alive={s.alive()}")
        s.expect("P4:no-otp-from-forms", not any(f.endswith("otp.json") for f in cfg_files(s.cfg)),
                 "forms never wrote a code file")
        s.crash_scan("P4")
        s.echo_check("P4:echo-after-forms")

        # ---------- P5: home picker torture ----------
        s.clear_line()
        os.write(s.master, b"/home")
        time.sleep(0.2)
        s.drain(quiet_ms=150)
        s.sent += 1
        mark = len(s.buf)
        s.send("home-open", b"\r", "open dashboard", settle=0.6)
        s.resize(79)
        s.resize(80)
        out = s.buf[mark:]
        s.expect("P5:home-heading", "search in" in out and ">wiki" in out and s.alive(),
                 "picker chips visible" if "search in" in out else "MISSING chips")
        # one right = wiki chip active
        mark = len(s.buf)
        s.send("home-right", b"\x1b[C", "scope -> wiki")
        s.resize(79)
        s.resize(80)
        s.expect("P5:home-wiki-chip", "[>wiki]" in s.buf[mark:], "wiki chip highlighted")
        s.send("home-cycle", b"\x1b[C" * 12 + b"\x1b[D" * 13, "wrap both ways")
        s.expect("P5:home-cycle-alive", s.alive(), "wrap-around safe")
        # bang-with-no-query Enter on home = hint (safe even with a scope picked)
        os.write(s.master, b">wiki cats")
        time.sleep(0.25)
        s.drain(quiet_ms=150)
        s.sent += 1
        s.clear_line()  # deliberate: DO NOT Enter ">wiki cats" (would navigate)
        os.write(s.master, b">nope")
        time.sleep(0.2)
        s.drain(quiet_ms=150)
        s.sent += 1
        mark = len(s.buf)
        s.send("home-bang-hint", b"\r", "hint only", settle=0.4)
        s.resize(79)
        s.resize(80)
        # Repaint artifacts: blessed drops spaces it skips re-drawing and the
        # loader spinner chars land inside the status row, so match the
        # message whitespace-insensitively after removing the spinner.
        new = re.sub(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]", "", s.buf[mark:])
        s.expect("P5:home-bang-hint", re.search(r"Unknown\s*scope", new) is not None, "hint from dashboard")
        s.resize(20, 10)
        s.expect("P5:home-tiny", s.alive(), "20x10 dashboard alive")
        s.resize(80, 24)
        s.focus_input()
        s.clear_line()
        s.crash_scan("P5")
        s.echo_check("P5:echo-after-home")

        # ---------- P6: resize storm + key torture ----------
        for (c, r) in ((10, 5), (20, 10), (41, 13), (120, 40), (80, 24), (5, 3), (200, 60), (80, 24)):
            s.resize(c, r, settle=0.12)
        s.expect("P6:resize-storm", s.alive(), "8 rapid resizes survived")
        s.crash_scan("P6:resize")

        alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:'\"!@#$%^&*()-_=+[]|~?<>"
        burst = "".join(random.choice(alpha) for _ in range(150))
        before = len(s.buf)
        os.write(s.master, burst.encode())
        s.sent += 1
        time.sleep(0.6)
        s.drain(quiet_ms=300)
        s.expect("P6:fuzz-burst", s.alive() and len(s.buf) > before, "150-char burst handled")
        s.clear_line()
        # control-char torture (safe subset: no Ctrl+C / Ctrl+Q)
        seq = (b"\x7f" * 50 + b"\t" * 5 + b"\x1b[A" * 10 + b"\x1b[B" * 10 +
               b"\x1b[5~" + b"\x1b[6~" + b"\x1b[H" + b"\x1b[F" + b"\x1b[2~" + b"\x1b[3~" +
               b"\x1bOP" + b"\x1b[15~" + b"\x1b[24~" + b"\x1bOQ" + b"\x1b")
        s.send("control-torture", seq, "cursors/paging/function keys", settle=0.5)
        s.send("esc-hammer", b"\x1b" * 10, "esc x10", settle=0.4)
        s.expect("P6:control-torture", s.alive(), f"alive={s.alive()}")
        s.crash_scan("P6:torture")
        s.echo_check("P6:echo-after-torture")

        # ---------- P7: hygiene + clean quit ----------
        # config files must parse as JSON (theme spam never corrupts them)
        bad = []
        for f in cfg_files(s.cfg):
            if not f.endswith(".json"):
                continue
            try:
                with open(f, encoding="utf-8") as fh:
                    json.load(fh)
            except Exception as e:
                bad.append(f"{os.path.basename(f)}:{e}")
        s.expect("P7:config-valid", not bad, "config JSON parses" if not bad else f"corrupt: {bad}")
        arts = TAG_ARTIFACT.findall(s.buf)
        if arts:
            i = TAG_ARTIFACT.search(s.buf).start()
            s.expect("P7:no-tag-artifacts", False, f"{arts[:5]} ctx={s.buf[max(0,i-60):i+60]!r}")
        else:
            s.expect("P7:no-tag-artifacts", True, "no literal blessed tags in output")

        s.focus_input()
        s.clear_line()
        os.write(s.master, b"/quit")
        time.sleep(0.25)
        s.drain(quiet_ms=150)
        s.sent += 1
        os.write(s.master, b"\r")
        try:
            s.proc.wait(timeout=5.0)
            rc = s.proc.returncode
        except subprocess.TimeoutExpired:
            rc = None
        s.expect("P7:quit-clean", rc == 0, f"exit code {rc}")
    finally:
        s.teardown()
        dur = time.time() - t0
        try:
            with open(CHAOS_LOG, "w", encoding="utf-8") as fh:
                fh.write(s.buf)
        except OSError:
            pass

    # stray report: match process NAMES exactly (-x) — a -f pattern like
    # "[c]hrome --" matches any shell whose arguments merely mention it.
    def strays(pat):
        try:
            out = subprocess.run(["pgrep", "-x", "-a", pat], capture_output=True, text=True).stdout.strip()
            lines = [l for l in out.splitlines() if l.strip()]
            if lines:
                print("strays left behind:")
                print(out)
            return len(lines)
        except Exception:
            return -1
    browsers = "chrome|chromium|chromium-browser|google-chrome|headless_shell|firefox|firefox-bin"
    chrome, mpv = strays(browsers), strays("mpv")
    print(f"strays: chrome={chrome} mpv={mpv}")
    if chrome > 0 or mpv > 0:
        results.append(("strays", False, f"chrome={chrome} mpv={mpv}"))

    fails = [r for r in results if not r[1]]
    print(f"\nchaos: {len(results)-len(fails)}/{len(results)} pass in {dur:.1f}s "
          f"({s.sent} key events) — transcript {CHAOS_LOG}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
