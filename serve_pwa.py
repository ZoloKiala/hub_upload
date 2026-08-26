#!/usr/bin/env python3
"""Serve pwa/ as a static site. This is what the hosted deployment runs.

The PWA needs nothing but files: no Python at runtime, no token on the server, no
session. It could be served by any web host, and `python -m http.server` would nearly
do — but two details matter enough to be worth fifteen lines.

* **MIME types.** A .woff2 served as application/octet-stream and a .webmanifest
  served as text/plain both "work" until a browser decides otherwise. Declared here.
* **Caching.** The document, the script and the stylesheet must not be cached by an
  intermediary, or a deploy takes hours to reach people who already have the app
  open; the fonts and icons should be cached hard, because they change only when
  their filenames do. The service worker makes the same distinction.

Run locally:  python serve_pwa.py            (http://127.0.0.1:8099)
On Railway:   python serve_pwa.py            (PORT comes from the environment)
"""

import functools
import http.server
import os
import socketserver
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "pwa")
PORT = int(os.environ.get("PORT", "8099"))
HOST = os.environ.get("HOST", "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")

FOREVER = (".woff2", ".woff", ".png", ".jpg", ".jpeg", ".webp", ".ico")
NEVER = (".html", ".js", ".css", ".json", ".webmanifest", "/")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map, **{
        ".woff2": "font/woff2",
        ".woff": "font/woff",
        ".webmanifest": "application/manifest+json",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
    })

    def end_headers(self):
        path = self.path.split("?")[0].lower()
        if path.endswith(FOREVER):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        elif path.endswith(NEVER) or "." not in path.rsplit("/", 1)[-1]:
            # The shell must be able to change under people who have it open.
            self.send_header("Cache-Control", "no-cache")
        # The app talks to huggingface.co and jsdelivr from the page; nothing here
        # needs to be embeddable anywhere else.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def log_message(self, fmt, *args):
        # One line per request, without the double timestamp Railway adds.
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    # On POSIX this means "reuse a socket still in TIME_WAIT", which is what you want
    # when restarting a server. On Windows SO_REUSEADDR means something else entirely:
    # a second process may bind a port that is already in use, and requests go to
    # whichever socket happens to answer. Two servers then run on one port and the old
    # one keeps replying — silently, which cost an hour here. So: POSIX only.
    allow_reuse_address = os.name != "nt"


def main():
    if not os.path.isdir(ROOT):
        raise SystemExit("no pwa/ directory beside %s" % os.path.basename(__file__))
    handler = functools.partial(Handler, directory=ROOT)
    with Server((HOST, PORT), handler) as server:
        print("serving pwa/ on http://%s:%d" % (HOST, PORT), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
