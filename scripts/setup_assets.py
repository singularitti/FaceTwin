#!/usr/bin/env python3
"""Download pinned inference assets. No photographs are read or transmitted."""
import base64
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0.10.21"
PACKAGE_URL = f"https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-{VERSION}.tgz"
PACKAGE_SHA512 = "TuhKH+credq4zLksGbYrnvJ1aLIWMc5r0UHwzxzql4BHECJwIAoBR61ZrqwGOW6ZmSBIzU1t4VtKj8hbxFaKeA=="
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
MODEL_SHA256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"


def download(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".download")
    temporary.write_bytes(data)
    temporary.replace(path)


def main():
    manifest_path = ROOT / "vendor/asset-manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        valid = manifest.get("version") == VERSION and manifest.get("model_sha256") == MODEL_SHA256
        valid = valid and all(
            (ROOT / item["path"]).is_file()
            and hashlib.sha256((ROOT / item["path"]).read_bytes()).hexdigest() == item["sha256"]
            for item in manifest.get("files", [])
        )
        if valid and manifest.get("files"):
            print("Local model and runtime verified; no download needed.")
            return

    print(f"Downloading MediaPipe Tasks Vision {VERSION} from the npm registry…", flush=True)
    package = download(PACKAGE_URL)
    if base64.b64encode(hashlib.sha512(package).digest()).decode() != PACKAGE_SHA512:
        raise RuntimeError("npm package integrity check failed")
    allowed = {
        "vision_bundle.mjs", "vision_bundle.mjs.map",
        "wasm/vision_wasm_internal.js", "wasm/vision_wasm_internal.wasm",
        "wasm/vision_wasm_nosimd_internal.js", "wasm/vision_wasm_nosimd_internal.wasm",
    }
    files = []
    with tarfile.open(fileobj=io.BytesIO(package), mode="r:gz") as archive:
        for member in archive.getmembers():
            relative = member.name.removeprefix("package/")
            if relative in allowed and member.isfile():
                data = archive.extractfile(member).read()
                path = ROOT / "vendor/vision" / relative
                write(path, data)
                files.append({"path": path.relative_to(ROOT).as_posix(), "sha256": hashlib.sha256(data).hexdigest()})
    required = allowed - {"vision_bundle.mjs.map"}
    if not required.issubset({item["path"].removeprefix("vendor/vision/") for item in files}):
        raise RuntimeError("Missing required runtime assets")

    print("Downloading Face Landmarker float16 model, version 1…", flush=True)
    model = download(MODEL_URL)
    model_hash = hashlib.sha256(model).hexdigest()
    if MODEL_SHA256 and model_hash != MODEL_SHA256:
        raise RuntimeError("Model integrity check failed")
    write(ROOT / "models/face_landmarker.task", model)
    files.append({"path": "models/face_landmarker.task", "sha256": model_hash})
    write(manifest_path, (json.dumps({"version": VERSION, "package": PACKAGE_URL, "model": MODEL_URL, "model_sha256": model_hash, "files": files}, indent=2) + "\n").encode())
    print("Assets ready. Model SHA-256: " + model_hash)
    print("Start the local app: uv run python scripts/serve.py")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Setup failed: {type(error).__name__}: {error}")
        raise SystemExit(1)
