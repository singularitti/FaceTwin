#!/usr/bin/env python3
"""Serve application assets and memory-only HEIF previews on loopback."""
import argparse
import json
import socket
from threading import BoundedSemaphore
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from heif_decode import HeifDecodeError, MAX_INPUT_BYTES, decode_heif

ROOT = Path(__file__).resolve().parents[1]
DECODE_SLOTS = BoundedSemaphore(2)


class AppHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".task": "application/octet-stream"}

    def _valid_host(self):
        hosts = self.headers.get_all("Host", [])
        port = self.server.server_address[1]
        return self.server.server_address[0] in ("127.0.0.1", "::1") and len(hosts) == 1 and hosts[0] in {
            f"localhost:{port}", f"127.0.0.1:{port}", f"[::1]:{port}",
        }

    def do_GET(self):
        if not self._valid_host():
            self._error(403, "forbidden")
            return
        super().do_GET()

    def do_HEAD(self):
        if not self._valid_host():
            self._error(403, "forbidden")
            return
        super().do_HEAD()

    def _error(self, status, code):
        body = json.dumps({"error": code}, separators=(",", ":")).encode("ascii")
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/decode-heif":
            self._error(404, "not-found")
            return
        origins = self.headers.get_all("Origin", [])
        if not self._valid_host() or origins != [f"http://{self.headers.get('Host')}"]:
            self._error(403, "forbidden")
            return
        if (self.headers.get_all("Content-Type", []) != ["application/octet-stream"]
                or self.headers.get_all("X-FaceTwin-Decode", []) != ["1"]):
            self._error(415, "unsupported-request")
            return
        lengths = self.headers.get_all("Content-Length", [])
        if (self.headers.get("Transfer-Encoding") is not None or len(lengths) != 1
                or not lengths[0].isascii() or not lengths[0].isdecimal()):
            self._error(400, "invalid-length")
            return
        if len(lengths[0]) > 10 or int(lengths[0]) > MAX_INPUT_BYTES:
            self._error(413, "input-too-large")
            return
        length = int(lengths[0])
        if not length:
            self._error(400, "invalid-image")
            return
        if not DECODE_SLOTS.acquire(blocking=False):
            self._error(503, "decoder-busy")
            return
        try:
            self.connection.settimeout(15)
            data = self.rfile.read(length)
            if len(data) != length:
                self._error(400, "invalid-length")
                return
            png, info = decode_heif(data)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(png)))
            self.send_header("X-FaceTwin-Color", info["color"])
            self.send_header("X-FaceTwin-Output", info["output"])
            self.send_header("X-FaceTwin-Width", str(info["width"]))
            self.send_header("X-FaceTwin-Height", str(info["height"]))
            self.send_header("X-FaceTwin-Source-Bit-Depth", str(info["bitDepth"]))
            self.end_headers()
            self.wfile.write(png)
        except HeifDecodeError as error:
            status = 413 if str(error) in ("input-too-large", "image-too-large") else 422
            self._error(status, str(error))
        except (socket.timeout, TimeoutError):
            self._error(408, "request-timeout")
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            DECODE_SLOTS.release()

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


class LocalHTTPServer(ThreadingHTTPServer):
    def handle_error(self, _request, _client_address):
        pass  # Suppress tracebacks that can include local paths or image metadata.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5173)
    args = parser.parse_args()
    server = LocalHTTPServer(("127.0.0.1", args.port), partial(AppHandler, directory=str(ROOT)))
    print(f"FaceTwin is ready at http://localhost:{args.port}", flush=True)
    print("HEIF fallback previews decode in memory on this computer. Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
