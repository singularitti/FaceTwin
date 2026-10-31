"""Static file isolation and loopback-only, bounded HEIF request checks."""
from functools import partial
from http.client import HTTPConnection
import importlib.util
from io import BytesIO
from pathlib import Path
import sys
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch

from PIL import Image
import pillow_heif

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

spec = importlib.util.spec_from_file_location("facetwin_server", Path(__file__).resolve().parents[1] / "scripts/serve.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class StaticScopeTest(unittest.TestCase):
    def request(self, path):
        handler = object.__new__(server.AppHandler)
        handler.path = path
        handler.command = "GET"
        handler.request_version = "HTTP/1.1"
        handler.requestline = "GET " + path
        handler.directory = str(server.ROOT)
        handler.headers = {}
        handler.wfile = BytesIO()
        handler.close_connection = False
        handler.extra_response_headers = None
        codes = []
        handler.send_response = lambda code, message=None: codes.append(code)
        stream = handler.send_head()
        if stream is not None:
            stream.close()
        return codes[0]

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="facetwin-server-test-")
        self.previous_root = server.ROOT
        server.ROOT = Path(self.temp.name).resolve()
        (server.ROOT / "index.html").write_text("<h1>FaceTwin</h1>")
        (server.ROOT / "src").mkdir()
        (server.ROOT / "src/app.js").write_text("export {}")

    def tearDown(self):
        server.ROOT = self.previous_root
        self.temp.cleanup()

    def test_application_assets_are_served(self):
        self.assertEqual(self.request("/"), 200)
        self.assertEqual(self.request("/src/app.js?version=1"), 200)

    def test_private_files_traversal_and_directory_listing_are_blocked(self):
        (server.ROOT / "secret.txt").write_text("not an asset")
        for path in ["/.git/config", "/README.md", "/src/", "/secret.txt", "/src/../secret.txt", "/src/%2e%2e/secret.txt"]:
            with self.subTest(path=path):
                self.assertEqual(self.request(path), 404)

    def test_asset_symlinks_cannot_expose_other_files(self):
        outside = server.ROOT.parent / (server.ROOT.name + "-outside.txt")
        try:
            outside.write_text("not an asset")
            (server.ROOT / "src/leak.js").symlink_to(outside)
            (server.ROOT / ".private").write_text("private")
            (server.ROOT / "src/internal.js").symlink_to(server.ROOT / ".private")
            self.assertEqual(self.request("/src/leak.js"), 404)
            self.assertEqual(self.request("/src/internal.js"), 404)
        finally:
            outside.unlink(missing_ok=True)


class DecodeEndpointTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not pillow_heif.libheif_info().get("HEIF"):
            raise unittest.SkipTest("HEIF encoder is unavailable")
        cls.httpd = server.LocalHTTPServer(("127.0.0.1", 0), partial(server.AppHandler, directory=str(server.ROOT)))
        cls.port = cls.httpd.server_address[1]
        cls.host = f"127.0.0.1:{cls.port}"
        cls.thread = Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        output = BytesIO()
        pillow_heif.from_pillow(Image.new("RGB", (40, 24), "red")).save(output, quality=-1)
        cls.data = output.getvalue()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join()

    def request(self, body=None, *, path="/api/decode-heif", headers=None, method="POST"):
        body = self.data if body is None else body
        request_headers = {
            "Host": self.host,
            "Origin": f"http://{self.host}",
            "Content-Type": "application/octet-stream",
            "X-FaceTwin-Decode": "1",
        }
        for key, value in (headers or {}).items():
            if value is None:
                request_headers.pop(key, None)
            else:
                request_headers[key] = value
        connection = HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_decode_returns_png_with_explicit_precision_limit(self):
        status, headers, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-FaceTwin-Output"], "8-bit-preview")
        self.assertEqual(headers["X-FaceTwin-Color"], "unprofiled-8bit")
        self.assertEqual(headers["X-FaceTwin-Source-Bit-Depth"], "8")
        self.assertFalse(any(name.lower().startswith("access-control-") for name in headers))
        with Image.open(BytesIO(body)) as image:
            self.assertEqual(image.size, (40, 24))

    def test_cross_origin_missing_origin_and_untrusted_host_are_denied(self):
        for headers in [
            {"Origin": "https://untrusted.invalid"}, {"Origin": "null"}, {"Origin": None},
            {"Origin": f"http://localhost:{self.port}"},
            {"Host": f"untrusted.invalid:{self.port}"},
            {"Host": "127.0.0.1:1"}, {"Host": f"127.0.0.1:{self.port}@untrusted.invalid"},
        ]:
            with self.subTest(headers=headers):
                self.assertEqual(self.request(headers=headers)[0], 403)

    def test_loopback_hostname_origin_pair_is_allowed(self):
        for host in (f"localhost:{self.port}", f"[::1]:{self.port}"):
            with self.subTest(host=host):
                self.assertEqual(self.request(headers={"Host": host, "Origin": f"http://{host}"})[0], 200)

    def test_endpoint_and_request_headers_are_exact(self):
        self.assertEqual(self.request(path="/api/decode-heif?file=private.heic")[0], 404)
        self.assertEqual(self.request(path="/api/other")[0], 404)
        for headers in [
            {"Content-Type": "image/heic"}, {"Content-Type": "application/octet-stream; charset=UTF-8"},
            {"X-FaceTwin-Decode": None}, {"X-FaceTwin-Decode": "true"},
        ]:
            with self.subTest(headers=headers):
                self.assertEqual(self.request(headers=headers)[0], 415)

    def test_oversized_and_ambiguous_bodies_are_denied_before_decode(self):
        with patch.object(server, "decode_heif") as decode:
            self.assertEqual(self.request(body=b"small", headers={"Content-Length": str(server.MAX_INPUT_BYTES + 1)})[0], 413)
            self.assertEqual(self.request(body=b"small", headers={"Transfer-Encoding": "chunked"})[0], 400)
            self.assertEqual(self.request(body=b"small", headers={"Content-Length": "-1"})[0], 400)
            self.assertEqual(self.request(body=b"")[0], 400)
            decode.assert_not_called()

    def test_decoder_capacity_is_bounded(self):
        self.assertTrue(server.DECODE_SLOTS.acquire(blocking=False))
        self.assertTrue(server.DECODE_SLOTS.acquire(blocking=False))
        try:
            self.assertEqual(self.request()[0], 503)
        finally:
            server.DECODE_SLOTS.release()
            server.DECODE_SLOTS.release()
        self.assertEqual(self.request()[0], 200)

    def test_duplicate_security_headers_and_lengths_are_denied(self):
        for duplicate, value, expected in [
            ("Host", self.host, 403), ("Origin", f"http://{self.host}", 403),
            ("Content-Type", "application/octet-stream", 415),
            ("X-FaceTwin-Decode", "1", 415), ("Content-Length", str(len(self.data)), 400),
        ]:
            with self.subTest(duplicate=duplicate):
                connection = HTTPConnection("127.0.0.1", self.port, timeout=5)
                try:
                    connection.putrequest("POST", "/api/decode-heif", skip_host=True)
                    for name, content in [
                        ("Host", self.host), ("Origin", f"http://{self.host}"),
                        ("Content-Type", "application/octet-stream"), ("X-FaceTwin-Decode", "1"),
                        ("Content-Length", str(len(self.data))), (duplicate, value),
                    ]:
                        connection.putheader(name, content)
                    connection.endheaders(self.data)
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected)
                    response.read()
                finally:
                    connection.close()

    def test_corrupt_body_has_only_a_safe_code_and_releases_capacity(self):
        status, headers, body = self.request(body=b"private/path/broken.heic")
        self.assertEqual(status, 422)
        self.assertEqual(body, b'{"error":"unsupported-image"}')
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.request()[0], 200)

    def test_static_requests_also_validate_loopback_host(self):
        self.assertEqual(self.request(method="GET", path="/", headers={"Host": "untrusted.invalid"})[0], 403)
        self.assertEqual(self.request(method="HEAD", path="/", headers={"Host": "untrusted.invalid"})[0], 403)
        self.assertEqual(self.request(method="GET", path="/", body=b"")[0], 200)


if __name__ == "__main__":
    unittest.main()
