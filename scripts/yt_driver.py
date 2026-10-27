#!/usr/bin/env python3
"""Direct Python driver for tui-browser YouTube + image + slash checks.

Borrowed UX patterns (verified in /tmp/opencode/ref):
- Siriusmart/youtube-tui: TUI frontend, mpv for play, yt-dlp for fetch,
  config `video-player: mpv / youtube-downloader: yt-dlp`, title list.
- pystardust/ytfzf: `ytfzf -t query` title+thumb selector, FZF_PLAYER=mpv.
- Banh-Canh/ytui: Go TUI, requires mpv + yt-dlp, search/history/subs.

This driver shells to node for the real JS units (no reimplementation),
and can directly play a Gotham Chess video via mpv for terminal testing.

Usage:
  python3 scripts/yt_driver.py check
  python3 scripts/yt_driver.py search "gotham chess"
  python3 scripts/yt_driver.py aspect
  python3 scripts/yt_driver.py deps
  python3 scripts/yt_driver.py slash
  python3 scripts/yt_driver.py play "https://www.youtube.com/watch?v=..."
  python3 scripts/yt_driver.py gotham   # search + play #1 (dry-run by default)
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"


def run_node(code):
    r = subprocess.run(
        ["node", "-e", code],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=60,
    )
    return r


def check_aspect():
    code = """
const { fitOverlay, kittyChunks, pngSize } = require('./src/image');
const cases = [
  [ {w:1280,h:720},  {cols:30},  'landscape 16:9 -> cols (no stretch)' ],
  [ {w:720,h:1280},  {rows:12},  'portrait -> rows (no stretch)' ],
  [ {w:800,h:800},   {rows:12},  'square -> rows (cell-aware: 30 cols would be 15 rows > 12)' ],
  [ {w:2000,h:500},  {cols:30},  'ultra-wide -> cols (cell-aware fit)' ],
  [ null,            {cols:30},  'unknown size -> cols fallback' ],
];
let fail = 0;
for (const [size, want, name] of cases) {
  const got = fitOverlay(size, {maxCols:30, maxRows:12});
  const keys = Object.keys(got);
  const okSingle = keys.length === 1 && (keys[0]==='cols'||keys[0]==='rows');
  const okWant = JSON.stringify(got) === JSON.stringify(want);
  console.log((okSingle&&okWant?'PASS':'FAIL')+' '+name+' got='+JSON.stringify(got));
  if (!(okSingle&&okWant)) fail++;
}
// kitty must never emit both c= and r= via fitOverlay path
const dims = fitOverlay({w:1280,h:720},{maxCols:30,maxRows:12});
const seq = kittyChunks('QQ==', dims)[0];
const both = seq.includes('c=') && seq.includes('r=');
console.log((!both?'PASS':'FAIL')+' kitty single-dim chunks: '+seq.slice(0,60));
if (both) fail++;
// 16x16 PNG header parses
const png = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0,0,0,13,73,72,68,82,0,0,0,16,0,0,0,16,8,2,0,0,0]);
console.log('pngSize 16x16 = '+JSON.stringify(pngSize(png)));
process.exit(fail?1:0);
"""
    r = run_node(code)
    print(r.stdout, end="")
    print(r.stderr, end="", file=sys.stderr)
    return r.returncode == 0


def check_yt_parsers():
    code = """
const yt = require('./src/yt');
let fail = 0;
const ok = (n,c)=>{ console.log((c?'PASS':'FAIL')+' '+n); if(!c) fail++; };
// thumb + id helpers
ok('thumbForVideoId', yt.thumbForVideoId('dQw4w9WgXcQ')==='https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
ok('thumb rejects bad id', yt.thumbForVideoId('!!')===null);
ok('videoId watch', yt.videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')==='dQw4w9WgXcQ');
ok('videoId shorts', yt.videoIdFromUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')==='dQw4w9WgXcQ');
ok('videoId youtu.be', yt.videoIdFromUrl('https://youtu.be/dQw4w9WgXcQ')==='dQw4w9WgXcQ');
ok('isVideoUrl true', yt.isYouTubeVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')===true);
ok('isVideoUrl false', yt.isYouTubeVideoUrl('https://github.com')===false);
// yt-dlp parsers (pure, no binary needed)
const line = JSON.stringify({id:'abc123XYZ-_', title:'  Gotham  Chess  Best  ', thumbnails:[{url:'https://i.ytimg.com/vi/abc123XYZ-_/mqdefault.jpg',width:320}]});
const row = yt.normalizeYtDlpEntry(JSON.parse(line));
ok('normalizeYtDlpEntry title+url+thumb+video', !!row && row.url.includes('watch?v=abc123XYZ-_') && row.video===true && /Gotham/.test(row.title));
const flat = JSON.stringify({id:'flatID12345', title:'Flat Entry', url:'flatID12345'});
const row2 = yt.normalizeYtDlpEntry(JSON.parse(flat));
ok('flat bare-id url', !!row2 && row2.url==='https://www.youtube.com/watch?v=flatID12345');
ok('junk null', yt.normalizeYtDlpEntry({title:'',id:''})===null);
const out = yt.parseYtDlpOutput(line+'\\nnot-json\\n'+line+'\\n', 10);
ok('parse dedupes', out.length===1);
// invidious normalizer
const inv = yt.normalizeInvidiousItem({type:'video', videoId:'dQw4w9WgXcQ', title:'Hi', author:'Ch', lengthSeconds:60, videoThumbnails:[{url:'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',width:320}]});
ok('invidious row', !!inv && inv.video===true && inv.url.includes('dQw4w9WgXcQ'));
ok('search url builder', yt.buildYouTubeSearchUrl('gotham chess').includes('youtube.com/results?search_query=gotham%20chess'));
process.exit(fail?1:0);
"""
    r = run_node(code)
    print(r.stdout, end="")
    print(r.stderr, end="", file=sys.stderr)
    return r.returncode == 0


def check_slash():
    code = """
const { getCommandSuggestions } = require('./src/suggest');
const rows = getCommandSuggestions('/');
const hasYt = rows.some(r=>r.label==='/yt <name>');
console.log((hasYt?'PASS':'FAIL')+' / palette contains /yt <name> ('+rows.length+' cmds)');
const yt = getCommandSuggestions('/yt');
console.log((yt.length>=1?'PASS':'FAIL')+' /yt prefix filters -> '+yt.map(r=>r.label).join(','));
process.exit(hasYt&&yt.length>=1?0:1);
"""
    r = run_node(code)
    print(r.stdout, end="")
    print(r.stderr, end="", file=sys.stderr)
    # Structural check of the fix: startFreshSearch must seed '/'.
    src = (SRC / "ui.js").read_text()
    seeded = "omni.setValue('/')" in src and "onSuggest('/', id)" in src
    print(("PASS" if seeded else "FAIL") + " ui.js startFreshSearch seeds '/' (single-press fix)")
    return r.returncode == 0 and seeded


def check_deps():
    code = """
const yt = require('./src/yt');
console.log(JSON.stringify(yt.checkPlayerDeps()));
"""
    r = run_node(code)
    print(r.stdout, end="")
    has_mpv = shutil.which("mpv") is not None
    has_ytdlp = shutil.which("yt-dlp") is not None
    print(f"mpv binary: {'found' if has_mpv else 'MISSING'}")
    print(f"yt-dlp binary: {'found' if has_ytdlp else 'MISSING'}")
    return True


def live_search(query):
    code = f"""
const yt = require('./src/yt');
yt.searchYouTube({json.dumps(query)}, {{limit:10}}).then(r=>{{
  console.log(JSON.stringify({{source:r.source, count:(r.rows||[]).length, rows:(r.rows||[]).slice(0,10)}}));
}}).catch(e=>{{ console.log(JSON.stringify({{error:String(e)}})); }});
"""
    r = run_node(code)
    print(r.stdout, end="")
    print(r.stderr, end="", file=sys.stderr)
    try:
        data = json.loads((r.stdout or "").strip().splitlines()[-1])
        rows = data.get("rows", [])
        print(f"\n-- {len(rows)} titles (source={data.get('source')}) --")
        for i, row in enumerate(rows, 1):
            print(f"{i}. {row.get('title')}\n   {row.get('url')} thumb={'yes' if row.get('thumb') else 'no'}")
        return rows
    except Exception as e:
        print(f"parse failed: {e}")
        return []


def play_url(url, dry=False):
    if dry:
        print(f"[dry-run] would spawn: mpv {url!r}")
        return True
    mpv = shutil.which("mpv")
    if not mpv:
        print("mpv not found; cannot play.")
        return False
    print(f"Launching mpv (detached): {url}")
    subprocess.Popen([mpv, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    if cmd == "check":
        ok = True
        print("== aspect (no-stretch) ==")
        ok &= check_aspect()
        print("\n== yt parsers ==")
        ok &= check_yt_parsers()
        print("\n== slash (single-press) ==")
        ok &= check_slash()
        print("\n== deps ==")
        check_deps()
        print("\n== npm test (node suite) ==")
        t = subprocess.run(["npm", "test"], cwd=str(ROOT), capture_output=True, text=True, timeout=300)
        tail = "\n".join((t.stdout + t.stderr).splitlines()[-15:])
        print(tail)
        ok &= t.returncode == 0
        print("\nALL PASS" if ok else "\nSOME FAILURES")
        return 0 if ok else 1
    if cmd == "search":
        q = " ".join(argv[2:]) or "gotham chess"
        live_search(q)
        return 0
    if cmd == "aspect":
        return 0 if check_aspect() else 1
    if cmd == "deps":
        check_deps()
        return 0
    if cmd == "slash":
        return 0 if check_slash() else 1
    if cmd == "play":
        url = argv[2] if len(argv) > 2 else ""
        dry = "--dry" in argv or "--dry-run" in argv
        if not url:
            print('usage: yt_driver.py play "<url>" [--dry]')
            return 2
        return 0 if play_url(url, dry=dry) else 1
    if cmd == "gotham":
        dry = "--play" not in argv  # default dry-run; pass --play to actually launch mpv
        rows = live_search("gotham chess")
        if not rows:
            print("No rows; try: python3 scripts/yt_driver.py search 'gotham chess'")
            return 1
        print(f"\nTop pick: {rows[0]['title']}\n{rows[0]['url']}")
        return 0 if play_url(rows[0]["url"], dry=dry) else 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
