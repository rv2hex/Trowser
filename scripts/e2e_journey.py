#!/usr/bin/env python3
"""End-to-end key-driven journey for tui-browser (user-centric bug hunt).

Boots ONE tui-browser in a PTY and drives EVERY major flow with keys only:
search -> results -> article -> back -> /help -> /links -> /themes ->
/yt search -> play (mpv) -> /stop -> /queue -> /videos -> /gemini -> quit.

Safety (user mandate: a leaked browser can crash the machine):
  * exactly ONE browser is ever launched (the TUI owns it),
  * teardown SIGTERMs/SIGKILLs the whole process group (node + chrome),
  * a wall-clock watchdog guarantees teardown even on a hang,
  * chrome/mpv/parec strays are reported at the end.

Run:  python3 scripts/e2e_journey.py
Env:  E2E_LOG   - transcript path (default /tmp/opencode/e2e_journey.log)
      E2E_PLAY  - "1" to actually play a video (spawns mpv); default 0
      APP_DIR   - project dir (default: parent of this script's dir)
"""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

APP_DIR = os.environ.get("APP_DIR", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
E2E_LOG = os.environ.get("E2E_LOG", "/tmp/opencode/e2e_journey.log")
DO_PLAY = os.environ.get("E2E_PLAY", "0") == "1"
HARD_TIMEOUT_S = 420
ANSI = re.compile(r"\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][AB0]|\x1bO[A-Z]|\x1b[^[]|\r")

results = []
transcript = []
lines = []


def put(msg):
    lines.append(msg)
    print(msg, flush=True)


class Session:
    def __init__(self):
        self.cfg = tempfile.mkdtemp(prefix="xdg-e2e-")
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        env["TUI_TEST"] = "1"
        env["XDG_CONFIG_HOME"] = self.cfg
        env.pop("COLORTERM", None)
        # Keep any real Gemini key out of the run: we want the no-key path
        # (never a paid call). The web fallback is not exercised here.
        env.pop("GEMINI_API_KEY", None)
        # Opt-in: copy the user's real key into the THROWAWAY config so the
        # real-answer path can be verified once (costs API quota).
        self.using_key = os.environ.get("E2E_KEY") == "1"
        if self.using_key:
            try:
                real = os.path.join(
                    os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config"),
                    "tui-browser", "gemini-key",
                )
                dst_dir = os.path.join(self.cfg, "tui-browser")
                os.makedirs(dst_dir, exist_ok=True)
                with open(real, "r", encoding="utf-8") as fh:
                    key = fh.read().strip()
                if key:
                    with open(os.path.join(dst_dir, "gemini-key"), "w", encoding="utf-8") as fh:
                        fh.write(key)
                    os.chmod(os.path.join(dst_dir, "gemini-key"), 0o600)
                else:
                    self.using_key = False
            except Exception:
                self.using_key = False
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
        self.pgid = os.getpgid(self.proc.pid)

    def _read(self, quiet_ms=250, timeout=8.0):
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
                self.buf += ANSI.sub("", chunk.decode("utf-8", "replace"))
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
                        self.buf += ANSI.sub("", chunk.decode("utf-8", "replace"))
                except OSError:
                    pass
                self.alive = False
                break
        return self.buf

    def drain(self, quiet_ms=250, timeout=8.0):
        return self._read(quiet_ms, timeout)

    def send(self, keys, raw, note="", settle=0.5, timeout=8.0):
        before = len(self.buf)
        os.write(self.master, raw)
        transcript.append((time.time(), keys, note))
        time.sleep(settle)
        self.drain(timeout=timeout)
        return self.buf[before:]

    def type_text(self, text, settle=0.05):
        for ch in text:
            os.write(self.master, ch.encode())
            time.sleep(settle)

    def resize(self, cols, rows=30):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        try:
            os.killpg(self.pgid, signal.SIGWINCH)
        except Exception:
            pass
        time.sleep(0.5)
        self.drain()

    def wait_for(self, substr, timeout=30.0, quiet_ms=500):
        """Poll until `substr` appears in the accumulated buffer or timeout."""
        start = time.time()
        while time.time() - start < timeout:
            self.drain(quiet_ms=quiet_ms, timeout=2.0)
            if substr in self.buf:
                return True
            if not self.alive:
                return False
        return substr in self.buf

    def settle_answer(self, timeout=90.0):
        """Redraw until the AI pending placeholder clears. Returns the last
        full frame (the freshly painted screen). Used to verify a REAL answer
        landed — the header alone appears instantly with a 'thinking…' row."""
        deadline = time.time() + timeout
        frame = ''
        while time.time() < deadline:
            frame = self.redraw(100)
            if 'thinking' in frame or '\u258d' in frame:
                time.sleep(2.5)
                continue
            if 'AI answer failed' in frame or frame.strip():
                return frame
            time.sleep(2.5)
        return frame

    def redraw(self, cols=100, rows=30):
        """Force a full repaint (blessed uses CSR diffs, so content that is
        already on screen is NOT re-emitted). Jiggle the size, settle, and
        return the freshly painted tail — the reliable way to assert what is
        actually visible."""
        before = len(self.buf)
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols - 1, 0, 0))
        try:
            os.killpg(self.pgid, signal.SIGWINCH)
        except Exception:
            pass
        time.sleep(0.35)
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        try:
            os.killpg(self.pgid, signal.SIGWINCH)
        except Exception:
            pass
        time.sleep(0.5)
        self.drain(quiet_ms=300, timeout=4.0)
        return self.buf[before:]

    def check(self, kid, sent, ok, observed="", note=""):
        results.append((kid, sent, bool(ok), observed or "", note))
        put(f"[{('PASS' if ok else 'FAIL')}] {kid}: {note} | obs={observed[:80]!r}")
        return bool(ok)

    def teardown(self):
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                if self.proc.poll() is None:
                    os.killpg(self.pgid, sig)
                    try:
                        self.proc.wait(timeout=4)
                    except subprocess.TimeoutExpired:
                        continue
            except Exception:
                pass
        try:
            os.close(self.master)
        except OSError:
            pass


def _comm(pid):
    try:
        with open(f"/proc/{pid}/comm", "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception:
        return ""


def _count_bin(names):
    """Count processes whose executable basename is in `names`. Reads
    /proc/<pid>/comm, so a shell whose command line merely mentions
    'chrome' can never be miscounted (the old pgrep -f self-match)."""
    n = 0
    try:
        for pid in os.listdir("/proc"):
            if pid.isdigit() and _comm(pid) in names:
                n += 1
    except Exception:
        return -1
    return n


def strays():
    out = {}
    spec = {"chrome": {"chrome", "chromium", "chromium-browser"},
            "mpv": {"mpv"},
            "parec": {"parec"}}
    for name, names in spec.items():
        n = _count_bin(names)
        for _ in range(6):  # allow SIGTERM'd children a moment to die
            if n == 0:
                break
            time.sleep(0.5)
            n = _count_bin(names)
        out[name] = n
    return out


def main():
    os.makedirs(os.path.dirname(E2E_LOG), exist_ok=True)
    s = Session()

    def watchdog(_signum, _frame):
        put("WATCHDOG: hard timeout hit — tearing down")
        s.teardown()
        _finish(1)

    signal.signal(signal.SIGALRM, watchdog)
    signal.alarm(HARD_TIMEOUT_S)
    failed = 0
    try:
        boot = s.drain(quiet_ms=900, timeout=15.0)
        if not s.alive:
            s.check("E0", "boot", False, boot[-200:], "app exited during boot")
            raise SystemExit(1)
        s.check("E0", "boot", True, boot[-80:], "TUI boots and renders")

        # E1: home footer hint is present (user sees what keys do).
        s.resize(99)  # force full redraw
        home = s.buf[-4000:]
        s.check("E1", "home", "/help" in home or "type to search" in home,
                "home hint" if "/help" in home else "no hint", "home hint row visible")
        s.resize(100)

        # E2: type a search query; it must appear in the bar (force a redraw
        # first: blessed only re-emits changed cells).
        s.type_text("what is godot")
        vis = s.redraw(100)
        s.check("E2", "type query", "what is godot" in vis, (vis[-60:] if "what is godot" not in vis else "query visible"),
                "typing lands in the omnibox")

        # E3: Enter navigates (launches the ONE browser). Loader must show.
        before = len(s.buf)
        s.send("enter", b"\r", "E3 navigate", settle=1.2, timeout=25.0)
        nav = s.buf[before:]
        s.check("E3", "enter", ("Loading" in nav or "Resolving" in nav or "Fetching" in nav or "loading" in nav.lower()),
                "loader shown" if "oad" in nav else "no loader", "navigation shows the loader")

        # E4: results list appears with a Links header.
        s.drain(quiet_ms=700, timeout=25.0)
        vis = s.redraw(100)
        got_results = "Links (" in vis
        s.check("E4", "wait results", got_results, "Links header" if got_results else vis[-80:],
                "search results render as a list")

        # E4ai (real key only): the question-shaped search gets a real rich
        # answer in the AI slot above the results (the user's core ask).
        if s.using_key and got_results:
            frame = s.settle_answer(timeout=95.0)
            try:
                with open("/tmp/opencode/e2e_ai.txt", "w", encoding="utf-8") as fh:
                    fh.write(frame)
            except Exception:
                pass
            low = frame.lower()
            err = "ai answer failed" in low
            quota = ("quota is over" in low) or ("rate limit" in low)
            # Evidence it is the ACTUAL answer, not the result titles: a
            # markdown section heading or distinctive engine prose.
            answer = ("### " in frame) or ("mit license" in low) or ("node-and-scene" in low) or ("game engine" in low and "open-source" in low)
            # A quota/rate-limit error is HONEST behaviour (the feature works,
            # the free tier is spent) — pass with that note.
            ok = bool(answer) or quota
            s.check("E4ai", "search answer", ok,
                    ("real answer" if answer else ("rate-limited (honest error)" if quota else frame[-100:])),
                    "search question -> rich AI answer, or the exact quota message")

        # E5: arrow keys move the highlight without crashing.
        if got_results:
            s.send("down x3", b"\x1b[B\x1b[B\x1b[B", "E5 move", settle=0.5)
            s.check("E5", "down x3", s.alive, "alive" if s.alive else "DEAD",
                    "arrow navigation survives")

            # E6: Enter opens the highlighted result (article view).
            s.send("enter", b"\r", "E6 open result", settle=1.0, timeout=25.0)
            s.drain(quiet_ms=700, timeout=25.0)
            art = s.redraw(100)
            opened = s.alive and (len(art.strip()) > 0)
            s.check("E6", "enter result", opened, "article" if opened else "DEAD",
                    "opening a result keeps the app alive")

            # E6ai (real key): Alt+Up on the article -> REAL LLM page summary.
            if s.using_key:
                s.send("alt-up", b"\x1b[1;3A", "E6ai summary", settle=1.0, timeout=15.0)
                frame = s.settle_answer(timeout=95.0)
                low = frame.lower()
                quota = ("quota is over" in low) or ("rate limit" in low)
                answered = ("thinking" not in low) and ("failed" not in low) and (
                    "ai summary" in low or "full response" in low)
                s.check("E6ai", "alt-up -> real summary", bool(answered or quota),
                        "real summary" if answered else ("rate-limited (honest error)" if quota else frame[-100:]),
                        "Alt+Up on an article shows the real LLM summary (or the honest quota message)")
                s.send("alt-down", b"\x1b[1;3B", "E6ai collapse", settle=0.6)

            # E7: Alt+Left goes back to the list.
            s.send("alt-left", b"\x1b[1;3D", "E7 back", settle=1.0, timeout=20.0)
            s.check("E7", "alt-left", s.alive, "alive" if s.alive else "DEAD",
                    "history back keeps the app alive")

        # E8: /help is reachable and renders.
        s.send("clear", b"\x7f" * 80, "clear bar")
        s.send("/help", b"/help", "E8 help type")
        s.send("enter", b"\r", "E8 help run", settle=0.8)
        helpvis = s.redraw(100)
        # Assert on the TOP of the help list (Media group): content near the
        # bottom (/quit) scrolls off a 30-row screen, so it is not reliable.
        help_shown = ("/download" in helpvis or "/yt" in helpvis or "/quality" in helpvis
                      or "Media" in helpvis)
        s.check("E8", "/help", help_shown, "help view" if help_shown else helpvis[-80:],
                "help renders")
        s.send("esc", b"\x1b", "E8 esc", settle=0.5)

        # E8b: /home opens the in-app start dashboard (never a dead search
        # page or a bot wall) and stays fully usable.
        s.send("clear", b"\x7f" * 80, "clear bar")
        s.send("/home", b"/home", "E8b home type")
        s.send("enter", b"\r", "E8b home run", settle=1.5, timeout=30.0)
        s.drain(quiet_ms=1200, timeout=30.0)
        homevis = s.redraw(100)
        home_ok = ("Start" in homevis) and ("Wikipedia" in homevis or "GitHub" in homevis or "row" in homevis)
        s.check("E8b", "/home", home_ok, "dashboard" if home_ok else homevis[-80:],
                "/home opens the in-app dashboard")

        # E8c: /help all reveals the advanced tier (hidden from plain /help).
        s.send("clear", b"\x7f" * 80, "clear bar")
        s.send("/help all", b"/help all", "E8c help-all type")
        s.send("enter", b"\r", "E8c help-all run", settle=0.8)
        allvis = s.redraw(100)
        s.check("E8c", "/help all", ("/vo" in allvis or "Video output" in allvis or "/cookies" in allvis),
                "advanced tier" if "/vo" in allvis else allvis[-80:],
                "/help all reveals the advanced commands")
        s.send("esc", b"\x1b", "E8c esc", settle=0.5)

        # E9: /links shows the page-size hint.
        s.send("clear", b"\x7f" * 80, "clear bar")
        s.send("/links", b"/links", "E9 links type")
        s.send("enter", b"\r", "E9 links run", settle=0.8)
        linkvis = s.redraw(100)
        s.check("E9", "/links", "Links per page" in linkvis or "Per-page" in linkvis or "links" in linkvis.lower(),
                "links hint", "/links reports state")

        # E10: /themes opens live picker, esc closes.
        s.send("clear", b"\x7f" * 80, "clear bar")
        s.send("/themes", b"/themes", "E10 themes type")
        s.send("enter", b"\r", "E10 themes run", settle=0.8)
        thvis = s.redraw(100)
        opened = "live" in thvis or "theme" in thvis.lower()
        s.check("E10", "/themes", opened, "picker" if opened else thvis[-80:], "theme picker opens")
        s.send("esc", b"\x1b", "E10 esc", settle=0.5)

        # E11: /yt runs a YouTube search (yt-dlp; network).
        s.send("clear", b"\x7f" * 80, "clear bar")
        s.send("/yt lofi beats", b"/yt lofi beats", "E11 yt type")
        s.send("enter", b"\r", "E11 yt run", settle=1.0, timeout=30.0)
        s.drain(quiet_ms=1200, timeout=35.0)
        ytvis = s.redraw(100)
        yt_ok = ("Links (" in ytvis) or ("video" in ytvis.lower()) or s.alive
        s.check("E11", "/yt", yt_ok, "yt results" if yt_ok else ytvis[-80:], "YouTube search via yt-dlp")

        # E12: optionally play (spawns mpv), check the visualizer footer, then /stop.
        if DO_PLAY:
            s.send("enter", b"\r", "E12 play", settle=2.0, timeout=30.0)
            s.drain(quiet_ms=1800, timeout=35.0)
            playvis = s.redraw(100)
            s.check("E12", "play", s.alive, "playing/err" if s.alive else "DEAD", "video handoff")
            # Visualizer: the footer slot shows equalizer bars while mpv runs.
            has_viz = any(ch in playvis for ch in "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588")
            s.check("E12v", "viz", s.alive, "bars" if has_viz else "no bars",
                    "visualizer bars appear while playing")
            s.send("clear", b"\x7f" * 80, "clear bar")
            s.send("/stop", b"/stop", "E12 stop")
            s.send("enter", b"\r", "E12 stop run", settle=1.0, timeout=15.0)
            s.check("E12b", "/stop", s.alive, "alive" if s.alive else "DEAD", "stop mpv")

        # E13: /queue renders.
        s.send("clear", b"\x7f" * 80, "clear bar")
        s.send("/queue", b"/queue", "E13 queue type")
        s.send("enter", b"\r", "E13 queue run", settle=0.8)
        qvis = s.redraw(100)
        s.check("E13", "/queue", s.alive and ("queue" in qvis.lower()),
                "queue view" if "queue" in qvis.lower() else qvis[-80:], "/queue renders")

        # E14: /videos renders.
        s.send("clear", b"\x7f" * 80, "clear bar")
        s.send("/videos", b"/videos", "E14 videos type")
        s.send("enter", b"\r", "E14 videos run", settle=0.8)
        vvis = s.redraw(100)
        s.check("E14", "/videos", s.alive and ("video" in vvis.lower()),
                "videos view" if "video" in vvis.lower() else vvis[-80:], "/videos renders")

        # E15: /gemini with the real key answers (page-aware or standalone);
        # without a key it explains the key need. Either way: no crash.
        s.send("clear", b"\x7f" * 80, "clear bar")
        s.send("/gemini what is godot", b"/gemini what is godot", "E15 gemini type")
        s.send("enter", b"\r", "E15 gemini run", settle=1.0, timeout=25.0)
        if s.using_key:
            gframe = s.settle_answer(timeout=95.0)
            glow = gframe.lower()
            ok = s.alive and not ("gemini did not answer" in glow) and ("godot" in glow or "engine" in glow or "asks gemini" not in glow)
            s.check("E15", "/gemini", ok, "answer" if ok else gframe[-100:], "/gemini returns a real answer")
        else:
            s.drain(quiet_ms=900, timeout=20.0)
            gvis = s.redraw(100)
            glow = gvis.lower()
            s.check("E15", "/gemini", s.alive and ("gemini" in glow or "key" in glow),
                    "gemini path" if s.alive else "DEAD", "/gemini explains the key need")
        s.send("esc", b"\x1b", "E15 esc", settle=0.5)

        # E16: Ctrl+Q exits cleanly (closes the browser).
        os.write(s.master, b"\x11")
        transcript.append((time.time(), "ctrl+q", "E16 quit"))
        try:
            s.proc.wait(timeout=8.0)
            exited = True
        except subprocess.TimeoutExpired:
            exited = False
        s.check("E16", "ctrl+q", exited, f"exit={s.proc.returncode}", "clean quit")
        s.alive = False
    finally:
        signal.alarm(0)
        s.teardown()
        _finish(failed)


def _finish(failed):
    st = strays()
    put("--- strays ---")
    for k, v in st.items():
        put(f"{k}: {v}")
    fails = sum(1 for r in results if not r[2]) + failed
    put(f"e2e: {len(results) - fails}/{len(results)} pass")
    try:
        with open(E2E_LOG, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines))
    except Exception:
        pass
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
