#!/usr/bin/env python3
"""Keyboard logger for tui-browser: verifies every keypress path and every
slash command the way a user would type them.

The probe (scripts/keylog_probe.js) drives the REAL blessed UI headlessly
with the same keypress shapes terminals deliver, across boot / article /
list contexts, then types each /command from the catalog. Results land as
JSON in a file (blessed spams stdout with escape codes, so stdout is never
parsed). This driver runs the probe and prints a PASS/FAIL table.

Usage:
  python3 scripts/keylog_driver.py            # full matrix
  python3 scripts/keylog_driver.py --ctx list # only one context
  python3 scripts/keylog_driver.py --fail-only

Network/file/mail-client cases (/gemini <q>, real downloads, ...) are
reported as SKIP: they are exercised live, not headless. Ctrl+C and F2 are
index-level bindings (screen.key in src/index.js), not UI-router keys, so
they are out of scope here by design.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROBE = ROOT / "scripts" / "keylog_probe.js"


def main(argv):
    ctx_only = None
    fail_only = False
    for a in argv[1:]:
        if a == "--fail-only":
            fail_only = True
        elif a.startswith("--ctx"):
            ctx_only = a.split("=", 1)[1] if "=" in a else (argv[argv.index(a) + 1] if argv.index(a) + 1 < len(argv) else None)

    with tempfile.NamedTemporaryFile(prefix="keylog-", suffix=".json", delete=False) as f:
        out_path = f.name
    try:
        r = subprocess.run(
            ["node", str(PROBE), out_path],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=180,
        )
    except subprocess.TimeoutExpired:
        print("FAIL: probe timed out after 180s")
        return 1
    if r.returncode != 0:
        print(f"FAIL: probe exited {r.returncode}\n{r.stderr[-2000:]}")
        return 1
    try:
        data = json.loads(Path(out_path).read_text())
    except Exception as e:
        print(f"FAIL: unreadable probe output: {e}\nstdout tail: {r.stdout[-500:]}")
        return 1
    cases = data.get("cases", [])
    if ctx_only:
        cases = [c for c in cases if c.get("ctx") == ctx_only]
    npass = nfail = nskip = 0
    print(f"{'CASE':52} {'CTX':8} RESULT  DETAIL")
    print("-" * 100)
    for c in cases:
        name = str(c.get("case", "?"))[:50]
        ctx = str(c.get("ctx", "?"))[:7]
        if c.get("skipped"):
            nskip += 1
            if not fail_only:
                print(f"{name:52} {ctx:8} SKIP    {c.get('detail', '')[:30]}")
            continue
        if c.get("ok"):
            npass += 1
            if not fail_only:
                print(f"{name:52} {ctx:8} PASS    {str(c.get('detail', ''))[:30]}")
        else:
            nfail += 1
            print(f"{name:52} {ctx:8} FAIL    {c.get('detail', '')[:60]}")
    print("-" * 100)
    print(f"{npass} pass / {nfail} fail / {nskip} skip ({len(cases)} cases)")
    return 1 if nfail else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
