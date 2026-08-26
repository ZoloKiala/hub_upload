#!/usr/bin/env python3
"""Rasterise assets/hub-uploader-icon.svg into the PNGs a PWA needs.

assets/hub-uploader-icon.svg is the source of truth. Browsers take the SVG directly
as a favicon, but an installable app still needs PNGs: Chrome wants a 192 and a 512,
and Android wants a separate *maskable* one — the launcher crops icons to whatever
shape the phone uses (circle, squircle, rounded square), so a maskable icon has to
keep its artwork inside the middle ~80% and let the background take the crop. Handing
the same rounded tile to a circular mask shaves its corners off.

So three files come out of one drawing:

  icon-192.png            the tile as drawn
  icon-512.png            the tile as drawn
  icon-maskable-512.png   full-bleed background, artwork inset to the safe zone
  favicon-32.png          for browsers that still ignore an SVG favicon

Rendering is done by headless Chrome over the DevTools protocol, because it is the
same engine that will draw the icon and it needs no image library.

Run:  python pwa/build_app_icons.py          (only when the drawing changes)
Needs: Chrome or Edge, and `pip install websocket-client`.
"""

import base64
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "assets", "hub-uploader-icon.svg")

# name -> (pixel size, inset as a fraction of the canvas, drop the tile)
# The maskable one drops the rounded tile and paints its colour full-bleed instead:
# the launcher supplies the shape, so a tile inside the crop shows up as a stray
# outline floating in the corner rounding.
TARGETS = [
    ("icon-192.png", 192, 0.0, False),
    ("icon-512.png", 512, 0.0, False),
    ("icon-maskable-512.png", 512, 0.16, True),
    ("favicon-32.png", 32, 0.0, False),
]

PAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: transparent; }
  #stage { width: %(size)dpx; height: %(size)dpx; position: relative; overflow: hidden;
           background: %(bg)s; }
  #stage svg { position: absolute; left: %(inset)dpx; top: %(inset)dpx;
               width: %(inner)dpx; height: %(inner)dpx; }
</style></head><body><div id="stage">%(svg)s</div></body></html>"""


def chrome():
    for name in ("CHROME", "EDGE"):
        if os.environ.get(name):
            return os.environ[name]
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        "/usr/bin/google-chrome", "/usr/bin/chromium",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    found = shutil.which("chrome") or shutil.which("chromium") or shutil.which("google-chrome")
    if found:
        return found
    raise SystemExit("No Chrome or Edge found. Set CHROME=/path/to/chrome.")


def free_port():
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


class Renderer:
    """Just enough DevTools protocol to open a page and screenshot a region."""

    def __init__(self):
        import websocket  # noqa: F401  (checked here so the error is obvious)

        self.port = free_port()
        self.profile = tempfile.mkdtemp(prefix="icon_chrome_")
        self.proc = subprocess.Popen(
            [chrome(), "--headless=new", "--disable-gpu", "--no-first-run",
             "--no-default-browser-check", "--remote-allow-origins=*",
             "--force-device-scale-factor=1",
             "--remote-debugging-port=%d" % self.port,
             "--user-data-dir=%s" % self.profile, "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.ws = None
        self.msg = 0
        for _ in range(60):
            try:
                pages = json.load(urllib.request.urlopen(
                    "http://127.0.0.1:%d/json" % self.port, timeout=2))
                page = next(p for p in pages if p.get("type") == "page")
                self.ws = websocket.create_connection(page["webSocketDebuggerUrl"],
                                                      timeout=60)
                return
            except Exception:
                time.sleep(0.5)
        raise SystemExit("Chrome started but never opened its debug port.")

    def send(self, method, **params):
        self.msg += 1
        self.ws.send(json.dumps({"id": self.msg, "method": method, "params": params}))
        while True:
            message = json.loads(self.ws.recv())
            if message.get("id") == self.msg:
                return message.get("result", {})

    def shot(self, html, size):
        self.send("Emulation.setDeviceMetricsOverride", width=size, height=size,
                  deviceScaleFactor=1, mobile=False)
        self.send("Page.navigate",
                  url="data:text/html;base64," +
                      base64.b64encode(html.encode("utf-8")).decode("ascii"))
        time.sleep(0.6)
        result = self.send("Page.captureScreenshot", format="png",
                           captureBeyondViewport=True,
                           clip={"x": 0, "y": 0, "width": size, "height": size,
                                 "scale": 1})
        return base64.b64decode(result["data"])

    def close(self):
        try:
            if self.ws:
                self.ws.close()
        finally:
            self.proc.terminate()


def main():
    with open(SOURCE, encoding="utf-8") as handle:
        svg = handle.read()
    # The tile's own background becomes the full-bleed one for the maskable icon, so
    # the crop eats colour rather than the drawing.
    stops = re.findall(r'id="bg".*?stop-color="(#[0-9a-fA-F]{3,6})"', svg, re.DOTALL)
    ground = stops[-1] if stops else "#101d33"

    renderer = Renderer()
    try:
        for name, size, inset_frac, bare in TARGETS:
            inset = int(round(size * inset_frac))
            art = re.sub(r"<rect[^>]*/>\s*", "", svg) if bare else svg
            html = PAGE % {"size": size, "inset": inset,
                           "inner": size - 2 * inset,
                           "bg": ground if bare else "transparent",
                           "svg": art}
            png = renderer.shot(html, size)
            out = os.path.join(HERE, "assets", name)
            with open(out, "wb") as handle:
                handle.write(png)
            print("  %-26s %4dpx  inset %2d%%  %-9s %5.1f KB"
                  % (name, size, round(inset_frac * 100),
                     "full bleed" if bare else "tile", len(png) / 1024.0))
    finally:
        renderer.close()
    print("wrote %d icon(s) from %s" % (len(TARGETS), os.path.basename(SOURCE)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
