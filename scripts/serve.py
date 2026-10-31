#!/usr/bin/env python3
"""Serve only application assets on loopback; no upload or inference endpoints."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


class AppHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".task": "application/octet-stream"}

    def send_head(self):
        path = unquote(urlsplit(self.path).path)
        parts = Path(path).parts
        allowed = path in ("/", "/index.html", "/styles.css", "/favicon.svg") or path.startswith(("/src/", "/vendor/vision/", "/models/"))
        if not allowed or any(p.startswith(".") for p in parts):
            self.send_error(404)
            return None
        candidate = ROOT / path.lstrip("/")
        if not candidate.resolve().is_relative_to(ROOT) or any(p.is_symlink() for p in [candidate, *candidate.parents] if p.is_relative_to(ROOT)):
            self.send_error(404)
            return None
        if path != "/" and not (ROOT / path.lstrip("/")).is_file():
            self.send_error(404)
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *_args):
        pass  # No request logs or photo filenames.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5173)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(AppHandler, directory=str(ROOT)))
    print(f"FaceTwin is ready at http://localhost:{args.port}", flush=True)
    print("Photos and calculations stay in your browser. Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
