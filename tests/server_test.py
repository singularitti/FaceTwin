"""Focused checks that the static server cannot expose unrelated local files."""
import importlib.util
from io import BytesIO
from pathlib import Path
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
