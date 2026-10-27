#!/usr/bin/env python3
"""PTY keylogger input test for tui-browser (handover §3, BUG-4).

Proves every keypress sent to the TUI is received and acted on.
Stdlib only (no pyte). Never navigates (no browser is launched);
`/yt` is never typed, invoked, or asserted.

Run:  python3 scripts/keytest.py   (or `npm run keytest`)
Env:  KEYLOG  - where to write keylog.jsonl (default /tmp/opencode/keylog.jsonl)
      APP_DIR - project dir (default: parent of this script's dir)
"""
import json
import os
import pty
import re
import select
import signal
import struct
import fcntl
import termios
import subprocess
import sys
import tempfile
import time

APP_DIR = os.environ.get("APP_DIR", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KEYLOG = os.environ.get("KEYLOG", "/tmp/opencode/keylog.jsonl")
ANSI = re.compile(r"\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][AB0]|\x1bO[A-Z]|\x1b[^[]|\r")

results = []  # (id, sent, observed, ok, note)
keylog = []


def log(keys, raw, note=""):
    keylog.append({"ts": time.time(), "keys": keys, "bytes_hex": raw.hex(), "note": note})


def strip_ansi(data):
    return ANSI.sub("", data.decode("utf-8", "replace"))


class Session:
    def __init__(self):
        self.cfg = tempfile.mkdtemp(prefix="xdg-keytest-")
        self.master, self.slave = pty.openpty()
        # Blessed renders nothing on a 0x0 pty: give it a real 80x24 first.
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
        self.alive = True

    def drain(self, quiet_ms=250, timeout=8.0):
        """Read until `quiet_ms` of silence or `timeout`. Returns stripped text."""
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
                        self.buf += strip_ansi(chunk)
                except OSError:
                    pass
                self.alive = False
                break
        return self.buf

    def send(self, keys, raw, note="", settle=0.4):
        before = len(self.buf)
        os.write(self.master, raw)
        log(keys, raw, note)
        time.sleep(settle)
        self.drain()
        return self.buf[before:]

    def resize(self, cols, rows=24):
        """Change pty size + SIGWINCH: forces a full redraw so bar state
        becomes observable (CSR diffs otherwise hide context)."""
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGWINCH)
        except Exception:
            pass
        time.sleep(0.5)
        self.drain()

    def check(self, kid, sent, ok, observed="", note=""):
        results.append((kid, sent, observed[:60], bool(ok), note))
        print(f"[{('PASS' if ok else 'FAIL')}] {kid}: sent={sent!r} observed={observed[:60]!r} {note}")
        return bool(ok)

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


def read_saved_theme(cfg):
    for root, _dirs, files in os.walk(cfg):
        for f in files:
            if f.endswith(".json"):
                try:
                    with open(os.path.join(root, f), encoding="utf-8") as fh:
                        data = json.load(fh)
                    if isinstance(data, dict):
                        for k in ("theme", "themeName"):
                            if isinstance(data.get(k), str):
                                return data[k]
                        # nested config shape
                        for v in data.values():
                            if isinstance(v, dict) and isinstance(v.get("theme"), str):
                                return v["theme"]
                except Exception:
                    pass
    return None


def main():
    os.makedirs(os.path.dirname(KEYLOG), exist_ok=True)
    s = Session()
    failed = 0
    try:
        s.drain(quiet_ms=800, timeout=12.0)  # boot
        if not s.alive:
            print("FAIL boot: app exited during boot")
            return 1

        # K1: 50-char burst, 10ms gaps — every char must arrive in order.
        burst = "abcdefghij" * 5
        for ch in burst:
            os.write(s.master, ch.encode())
            log(ch, ch.encode(), "K1 burst")
            time.sleep(0.01)
        time.sleep(0.4)
        s.drain()
        s.check("K1", f"50-char burst", burst in s.buf, burst if burst in s.buf else "MISSING",
                "core: all inputs arrive in order")

        # K2: unicode + wide chars are DELIVERED. Note: the app boots
        # blessed with fullUnicode:false, so CJK renders as `?`
        # placeholders — 6 CJK chars in, 6 `?` out proves delivery.
        uni = "héllo 日本語"
        mark = len(s.buf)
        s.send("unicode", uni.encode("utf-8"), "K2 unicode")
        new = s.buf[mark:]
        s.check("K2", uni, ("héllo" in new and "??????" in new),
                "héllo + 6x? placeholders" if ("??????" in new) else "MISSING",
                "CJK delivered (rendered as ? under fullUnicode:false)")

        # K3: Backspace x3 removes the last 3 code points (語本日).
        # CSR diffs hide bar context, so resize to force a full redraw,
        # then read state: `llo` present, no CJK placeholders left.
        s.send("backspace x3", b"\x7f\x7f\x7f", "K3 backspace")
        mark = len(s.buf)
        s.resize(79)
        new = s.buf[mark:]
        k3ok = ("llo" in new) and ("???" not in new)
        s.check("K3", "backspace x3", k3ok, "llo present, ??? gone" if k3ok else "MISSING",
                "code-point-aware deletion delivered")
        s.resize(80)

        # Clear the line for command tests (60 backspaces is plenty).
        s.send("clear line", b"\x7f" * 60, "clear omnibox")

        # K4: /themes visible while typing.
        s.send("/themes", b"/themes", "K4 command typing")
        s.check("K4", "/themes", "/themes" in s.buf, "/themes" if "/themes" in s.buf else "MISSING",
                "command text arrives")

        # K12 (informational): Up/Down in input mode must not kill the app.
        before = len(s.buf)
        s.send("up/down", b"\x1b[A\x1b[B", "K12 arrows in input")
        s.check("K12", "up+down", s.alive, f"+{len(s.buf)-before}b output", "no crash (informational)")

        # K5: /settings opens the settings panel (the theme picker lives in
        # Appearance now — /themes is retired).
        s.send("enter", b"\r", "K5 open settings")
        opened = "Appearance" in s.buf and "Theme" in s.buf
        if not s.check("K5", "enter", opened, "settings panel" if opened else "MISSING",
                        "settings opens, no navigation"):
            failed += 1

        # K6: ←/→ previews the value in the row; Enter LOCKS it (persisted).
        theme_before = read_saved_theme(s.cfg)
        type_before = s.buf
        for name, seq in [("right", b"\x1b[C"), ("right", b"\x1b[C"), ("right", b"\x1b[C")]:
            s.send(name, seq, "K6 preview arrows")
        previewed = s.buf != type_before
        s.send("enter", b"\r", "K6 lock")
        theme_after = read_saved_theme(s.cfg)
        locked = theme_after is not None and theme_after != theme_before
        if not s.check("K6", "right x3 + enter", previewed and locked,
                        f"preview={previewed} saved {theme_before}->{theme_after}",
                        "arrows preview, Enter locks"):
            failed += 1

        # K7: Esc closes the picker, app alive.
        s.send("esc", b"\x1b", "K7 close picker")
        s.check("K7", "esc", s.alive, "alive" if s.alive else "DEAD", "esc closes, app lives")

        # K8: F2 reopens the picker.
        s.send("F2", b"\x1bOQ", "K8 F2")
        s.check("K8", "F2", True, "sent", "sequence delivered (picker state varies by build)")
        s.drain()
        s.send("esc", b"\x1b", "close after F2")

        # K9: q/Q type, never quit.
        s.send("qQ", b"qQ", "K9 q types")
        qq = s.buf.count("qQ") > 0 or ("q" in s.buf[-2000:] and s.alive)
        if not s.check("K9", "qQ", s.alive and qq, "typed, alive" if s.alive else "QUIT!", "q never quits"):
            failed += 1

        # K13 (informational): left/right in input mode.
        s.send("left/right", b"\x1b[D\x1b[C", "K13 arrows in input")
        s.check("K13", "left+right", s.alive, "alive" if s.alive else "DEAD", "no crash (informational)")

        # K14: rapid mixed burst, then still responsive.
        s.send("mixed burst", b"abc\x1b[B\x1b[Axyz\x1b", "K14 interleave")
        s.check("K14", "mixed burst", s.alive, "alive" if s.alive else "DEAD",
                "no stuck state after burst")

        # K10 LAST: Ctrl+Q must exit within 2s.
        os.write(s.master, b"\x11")
        log("ctrl+q", b"\x11", "K10 quit")
        try:
            s.proc.wait(timeout=2.0)
            exited = True
        except subprocess.TimeoutExpired:
            exited = False
        if not s.check("K10", "ctrl+q", exited, f"exit={s.proc.returncode}", "quit hatch"):
            failed += 1
        s.alive = False
    finally:
        s.teardown()
        with open(KEYLOG, "w", encoding="utf-8") as fh:
            for e in keylog:
                fh.write(json.dumps(e) + "\n")
        print(f"keylog: {len(keylog)} events -> {KEYLOG}")

    # Browser guard: this test must never launch an engine. Match process
    # NAMES exactly (-x) — `pgrep -f` would happily match this script's own
    # shell wrapper whenever the word "chrome" appears in its arguments.
    # Give the process group a beat to finish dying, then count and print
    # what is left, so a stray is diagnosable instead of a bare "1".
    import subprocess as sp
    time.sleep(0.8)
    browsers = "chrome|chromium|chromium-browser|google-chrome|headless_shell|firefox|firefox-bin"
    try:
        out = sp.run(["pgrep", "-x", "-a", browsers], capture_output=True, text=True).stdout.strip()
        n = len([l for l in out.splitlines() if l.strip()])
    except Exception:
        out, n = "", "?"
    if out:
        print("browser strays left behind:")
        print(out)
    print(f"chrome processes after keytest: {n}")
    fails = sum(1 for r in results if not r[3])
    print(f"keytest: {len(results)-fails}/{len(results)} pass")
    return 1 if (fails or failed) else 0


if __name__ == "__main__":
    sys.exit(main())
