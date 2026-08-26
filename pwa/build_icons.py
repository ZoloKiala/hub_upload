#!/usr/bin/env python3
"""Build assets/icons.svg — one sprite from the Bootstrap Icons the app uses.

The design calls for Bootstrap Icons, and the prototype loaded the whole icon
*font* from a CDN: ~120 KB over the network for 23 glyphs, in an app whose main
selling point is that it installs and keeps working. A sprite of just the icons
used is about 12 KB, ships with the app, and needs no third party at runtime.

Sources are fetched from the pinned upstream version and rewritten as <symbol>,
so `<svg class="ic"><use href="assets/icons.svg#i-upload"/></svg>` draws one.
Bootstrap Icons is MIT — the licence note goes in the sprite itself.

Run:  python pwa/build_icons.py       (only needed when the icon list changes)
"""

import os
import re
import sys
import urllib.request

VERSION = "1.11.3"
BASE = "https://cdn.jsdelivr.net/npm/bootstrap-icons@%s/icons/%%s.svg" % VERSION
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "assets", "icons.svg")

# Every icon the app references, and nothing else.
ICONS = [
    "box-arrow-up-right", "box-seam", "brightness-high-fill", "check-circle-fill",
    "clock-history",
    "cloud-upload", "dash-lg", "database-fill", "display", "droplet-half",
    "moon-stars-fill",
    "exclamation-triangle-fill", "eye", "file-earmark", "gear-fill", "github",
    "grid-3x3-gap-fill", "journal-text", "list", "lock-fill", "question-circle",
    "rocket-takeoff-fill",
    "search", "square", "upload", "x", "x-circle-fill", "x-lg",
]

HEAD = """<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
<!-- Bootstrap Icons %s (MIT) — https://github.com/twbs/icons
     Subset built by pwa/build_icons.py: only the icons this app draws. -->
""" % VERSION


def fetch(name):
    with urllib.request.urlopen(BASE % name, timeout=30) as response:
        return response.read().decode("utf-8")


def to_symbol(name, svg):
    box = re.search(r'viewBox="([^"]+)"', svg)
    if not box:
        raise SystemExit("%s: no viewBox" % name)
    inner = re.sub(r"^.*?<svg[^>]*>", "", svg, flags=re.DOTALL)
    inner = re.sub(r"</svg>\s*$", "", inner).strip()
    return '<symbol id="i-%s" viewBox="%s">%s</symbol>' % (name, box.group(1), inner)


def main():
    parts = [HEAD]
    for name in ICONS:
        parts.append(to_symbol(name, fetch(name)))
        print("  %s" % name)
    parts.append("</svg>\n")
    with open(OUT, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(parts))
    print("wrote %s (%d icons, %.1f KB)"
          % (OUT, len(ICONS), os.path.getsize(OUT) / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
