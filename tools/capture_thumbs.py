#!/usr/bin/env python3
"""Orebody — capture chapter thumbnails for the slide rail.

Two-pass by necessity: the thumbnails are pictures of the built page, so the
page has to exist before they can be taken. Run it as:

    python3 tools/build_present.py       # pass 1 — build without thumbnails
    python3 tools/capture_thumbs.py      # drive a browser, capture, write JSON
    python3 tools/build_present.py       # pass 2 — build with them embedded

Thumbnails land in tools/assets/thumbs.json as {chapterIndex: dataURL} and are
inlined by the builder, so the finished page still needs no network.

Requires a Chrome/Chromium with remote debugging, which is how the rest of this
project is verified anyway. Falls back with a clear message if none is found.
"""
import base64, json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tools" / "assets" / "thumbs.json"
PORT = int(os.environ.get("OREBODY_CDP_PORT", "9222"))
SERVE_PORT = int(os.environ.get("OREBODY_SERVE_PORT", "8899"))
THUMB_W = 320


def cdp(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=5) as r:
        return json.loads(r.read().decode())


def main():
    try:
        cdp("/json/version")
    except Exception:
        sys.exit(
            f"no Chrome DevTools endpoint on :{PORT}.\n"
            f"Start one with:\n"
            f"  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome "
            f"--remote-debugging-port={PORT} --user-data-dir=/tmp/orebody-cdp\n"
            f"and serve the build with:  python3 -m http.server {SERVE_PORT}")

    try:
        import websocket  # type: ignore
    except ImportError:
        sys.exit("needs websocket-client:  python3 -m pip install websocket-client")

    tab = cdp("/json/new?" + f"http://localhost:{SERVE_PORT}/index.html")
    ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=180)
    mid = [0]

    def send(method, params=None):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": method, "params": params or {}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == mid[0]:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def js(expr, wait=True):
        r = send("Runtime.evaluate", {"expression": expr, "awaitPromise": wait,
                                      "returnByValue": True})
        return r.get("result", {}).get("value")

    print("waiting for the scene to build…")
    for _ in range(90):
        time.sleep(2)
        if js("!!window.__api && !!window.__viewer"):
            break
    else:
        sys.exit("page never finished booting")

    n = js("CHAPTERS.length")
    js("document.getElementById('begin').click()")
    time.sleep(2)
    # Hide the UI chrome so a thumbnail is the scene, not the interface.
    js("""document.querySelectorAll('#bar,#rail,#brand,#legend,#tools,#panel,#prog,#dwell,#status,#synwarn')
           .forEach(e=>e.style.visibility='hidden'); 'ok'""")

    thumbs = {}
    for i in range(n):
        js(f"window.__api.stop(); window.__api.go({i}); 'ok'")
        time.sleep(3.4)
        shot = send("Page.captureScreenshot", {"format": "jpeg", "quality": 72})
        raw = base64.b64decode(shot["data"])
        thumbs[str(i)] = "data:image/jpeg;base64," + base64.b64encode(raw).decode()
        print(f"  chapter {i+1}/{n}  {len(raw)/1024:.0f} KB")

    js("""document.querySelectorAll('#bar,#rail,#brand,#legend,#tools,#panel,#prog,#dwell,#status,#synwarn')
           .forEach(e=>e.style.visibility=''); 'ok'""")
    ws.close()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(thumbs))
    total = sum(len(v) for v in thumbs.values()) / 1024
    print(f"wrote {OUT.relative_to(ROOT)} — {len(thumbs)} thumbnails, {total:.0f} KB")
    print("now re-run tools/build_present.py to embed them")


if __name__ == "__main__":
    main()
