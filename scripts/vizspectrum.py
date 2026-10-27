#!/usr/bin/env python3
"""Live music spectrum for the TUI visualizer (stdlib + numpy only).

Reads the system mix via `parec` (same monitor tap the RMS fallback uses),
runs a Hann-windowed FFT per hop, and prints one ascii frame per hop:

    v0;v1;...;v15\\n          (ints 0..1000, low -> high frequency)

No new dependencies: python3 + system numpy (already on the box), parec
(already required for the RMS tap). If numpy or parec is missing the
script exits nonzero and the Node side falls back to the RMS tap, then
to the synthetic animation. Never prints anything except frames on
stdout (diagnostics go to stderr, which Node ignores).

Latency design (measured 2026-10-13: parec/monitor capture itself is
1-6 ms — the old lag was 100 ms frames + slow EMA in Node, not capture):
100 ms window with a 50 ms hop (overlap keeps bass resolution while the
cadence doubles), so a beat is reported <= 50 ms after it sounds.
"""
import subprocess
import sys

RATE = 8000
WINDOW_S = 0.10
HOP_S = 0.05
BANDS = 16
FLO = 60.0
FHI = 3800.0
# Bass-only mode (the default tap): kick + bassline read as a few big
# pulsing columns instead of full-spectrum shimmer nobody can follow.
BASS_BANDS = 8
BASS_FLO = 40.0
BASS_FHI = 250.0
AGC_DECAY = 0.90  # per-hop peak follower decay: sensitivity recovers
FALL = 0.78       # per-hop gravity: bars drop between beats (~250 ms tail)
RISE = 0.85       # per-hop attack: rises follow beats almost instantly
# Sync rationale: attack was always fast (~1 hop to 85%), but FALL=0.55
# smeared every 100 ms kick into a 550 ms glow — at 120 BPM tails overlap
# and beats blur together ("slow", unreadable). 0.78 clears in ~5 hops so
# consecutive hits punch distinctly; 0.90 peak recovery keeps the NEXT hit
# full-height instead of normalized against a stale peak. Sustained bass
# is unaffected (target stays high, shown stays pinned).


def log_bins(n_fft, n_bands, flo=FLO, fhi=FHI):
    import numpy as np
    freqs = np.fft.rfftfreq(n_fft, 1.0 / RATE)
    edges = np.logspace(np.log10(flo), np.log10(fhi), n_bands + 1)
    return [np.where((freqs >= edges[i]) & (freqs < edges[i + 1]))[0]
            for i in range(n_bands)]


def parse_args(argv):
    device = '@DEFAULT_MONITOR@'
    bass_only = True   # default: react to the bass, not the shimmer
    use_stdin = False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--device' and i + 1 < len(argv):
            device = argv[i + 1]
            i += 2
        elif a == '--full':
            bass_only = False
            i += 1
        elif a == '--bass-only':
            bass_only = True
            i += 1
        elif a == '--stdin':
            use_stdin = True
            i += 1
        else:
            i += 1
    return device, bass_only, use_stdin


def main():
    import numpy as np
    device, bass_only, use_stdin = parse_args(sys.argv[1:])
    n_bands = BASS_BANDS if bass_only else BANDS
    flo, fhi = (BASS_FLO, BASS_FHI) if bass_only else (FLO, FHI)
    win_n = int(RATE * WINDOW_S)
    hop_n = int(RATE * HOP_S)
    window = np.hanning(win_n)
    bins = log_bins(win_n, n_bands, flo, fhi)
    # silence floor per band (measured): anything below reads as 0
    floor = np.full(n_bands, 1e-4)
    peak = np.full(n_bands, 1e-3)
    shown = np.zeros(n_bands)
    buf = np.zeros(0, dtype=np.float64)
    first = True
    cap = None

    def reap():
        # The tap owns its parec child: dying must never orphan it into
        # a silent CPU/battery drain (found live 2026-10-13: SIGTERM to
        # this script left parec running).
        try:
            if cap is not None:
                cap.terminate()
        except Exception:  # noqa: BLE001 - teardown never throws
            pass
        try:
            if cap is not None:
                cap.wait(timeout=2)
        except Exception:  # noqa: BLE001 - teardown never throws
            pass
        try:
            if cap is not None:
                cap.kill()
        except Exception:  # noqa: BLE001 - teardown never throws
            pass

    import atexit
    import signal
    atexit.register(reap)

    def _sig(_signo, _frame):
        reap()
        sys.exit(0)

    for _sig_name in ('SIGTERM', 'SIGINT'):
        try:
            signal.signal(getattr(signal, _sig_name), _sig)
        except (OSError, ValueError):
            pass

    try:
        if use_stdin:
            # Test seam: read raw s16le mono @RATE from stdin instead of
            # spawning parec (deterministic canned audio, no hardware).
            cap = None
            stream = sys.stdin.buffer
        else:
            # --latency-msec=25: without it the server batches this record
            # stream ~2 s at a time (bars jump in blocks, not a viz). 25 ms
            # measured steady at ~43 ms median fragment gap during music.
            cap = subprocess.Popen(
                ['parec', '-d', device, f'--rate={RATE}',
                 '--channels=1', '--format=s16le', '--latency-msec=25'],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            stream = cap.stdout
    except (OSError, FileNotFoundError):
        return 2
    out = sys.stdout
    try:
        while True:
            chunk = stream.read(hop_n * 2)
            if len(chunk) < hop_n * 2:
                return 0  # tap closed: clean exit, Node falls back
            frame = np.frombuffer(chunk, dtype='<i2').astype(np.float64)
            buf = np.concatenate([buf, frame])[-win_n:]
            if len(buf) < win_n:
                continue
            mag = np.abs(np.fft.rfft(buf * window)) / win_n
            vals = np.array([
                float(np.mean(mag[b])) if len(b) else 0.0 for b in bins])
            vals = np.maximum(vals - floor, 0.0)
            # Relative floor: a band only counts when it carries real
            # energy vs the loudest band. Without this, silent bands'
            # peaks decay down to leakage level and self-normalize to
            # full scale (everything lit with a pure sine).
            frame_max = float(np.max(vals)) if vals.size else 0.0
            rel_floor = frame_max * 0.03
            if first:
                peak = np.maximum(vals, rel_floor)
                first = False
            else:
                peak = np.maximum(np.maximum(peak * AGC_DECAY, vals),
                                  rel_floor)
            target = np.divide(vals, np.maximum(peak, 1e-9),
                               out=np.zeros_like(vals),
                               where=peak > 1e-9)
            target = np.clip(target, 0.0, 1.0)
            k = np.where(target > shown, RISE, FALL)
            shown = shown + k * (target - shown)
            out.write(';'.join(str(int(round(v * 1000))) for v in shown) + '\n')
            out.flush()
    except (BrokenPipeError, ValueError):
        return 0
    except Exception as exc:  # noqa: BLE001 - diagnostics only
        print(f'vizspectrum: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
