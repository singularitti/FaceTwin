# FaceTwin

A local, multi-image facial resemblance explorer with visible geometric measurements.

FaceTwin 0.1 compares two sets of portrait photos, draws face landmarks and a mesh, and explains a **geometric resemblance score** through 13 measured proportions. The interface is in Chinese. It is an exploratory geometry baseline, not a validated model of human-perceived resemblance, an identity verification service, or a PerFace reproduction.

## Run locally

Requirements: [uv](https://docs.astral.sh/uv/) and a modern desktop browser with WebAssembly, Workers, `createImageBitmap`, and `OffscreenCanvas`. Start with a recent Chrome or Edge. The project selects Python 3.14 through `.python-version`; the scripts support Python 3.10+. No third-party Python packages, npm installation, account, API key, or GPU are required.

From the project directory:

```sh
uv sync
uv run python scripts/setup_assets.py
uv run python scripts/serve.py
```

Open **http://localhost:5173**. Stop the server with **Ctrl+C**. If the port is occupied:

```sh
uv run python scripts/serve.py --port 5174
```

Setup downloads about 23 MB of runtime and model files from the npm registry and Google's model storage, checks their pinned integrity values, and writes them to the ignored `vendor/` and `models/` directories. Re-running setup verifies the files and skips the download when they are intact. After setup, the app does not need an internet connection. `预先加载` checks model initialization without selecting photos.

### Dependency management

`pyproject.toml` declares an empty Python dependency list. Running `uv sync` generates a local `uv.lock` and creates `.venv/`; neither is committed. The Python scripts use only the standard library (`http.server`, `urllib`, `pathlib`, `hashlib`, `tarfile`, and related utilities). `uv run` selects the project environment without manual activation. If the selected Python version is unavailable on another machine, uv may download it; this setup reused an existing Python installation.

Use `uv add <package>` for future Python runtime dependencies and `uv add --dev <package>` for Python development tools. Commit `pyproject.toml` and `.python-version`; keep the generated lockfile and virtual environment local. A fresh checkout uses `uv sync` to resolve its environment. Python currently has no third-party dependencies; if dependencies are added later, separate checkouts can resolve different versions within the declared constraints because no lockfile is shared.

The browser dependencies are **not Python packages**: MediaPipe Tasks Vision 0.10.21 (JavaScript/WASM) and Face Landmarker float16 version 1 remain pinned by URL/version and integrity hashes in the asset setup script. Its local manifest records the installed file checksums. Running the script through uv provides a consistent Python environment but does not put those external assets into `uv.lock`. Node.js is needed only for the JavaScript tests and is not installed or managed by uv; the initial verification used an existing bundled runtime. No `pip install` or `npm install` is required.

Select or drop **1–8 photos per person**, then choose `开始比较`. Supported formats: JPG, PNG, WebP; at most 12 MB and 32 megapixels per image. Convert HEIC to JPEG first. The browser reduces the inference image's longest edge to at most 1600 pixels. Each photo must contain exactly one detectable face; no-face and multiple-face inputs are excluded and remain visible with an explanation.

For useful comparisons, choose clear, approximately frontal photos with similar lighting and neutral expressions. The app flags small or clipped faces, pose proxies, and expression signals. These are heuristic warnings, not validated image-quality or pose estimates; warned photos remain in the score.

## Where it runs

```text
Local photo selection
        ↓
Browser memory → CPU / WebAssembly in a Web Worker
        ↓
478 estimated landmarks → 13 proportions → all A × B comparisons
        ↓
Canvases, feature table, photo-pair matrix, optional CSV download
```

This is a **static client-side web application**. Python serves its HTML, CSS, JavaScript, WASM, and model files on loopback only. Python does not receive photographs or run inference. There is no upload endpoint, database, telemetry, external font, CDN request at runtime, or browser persistent storage. Photo names are replaced in the interface and exported data by labels such as A1 and B1. Refreshing or closing the page discards the active session. A user-triggered CSV download persists until the user deletes that file.

Use HTTP rather than double-clicking `index.html`: module loading, model fetches, and Workers need an appropriate origin. A conventional static host can serve the same application files, provided it serves JavaScript and WASM with correct MIME types. This initial version has not been publicly deployed. To deploy later, include `index.html`, `styles.css`, `favicon.svg`, `src/`, `vendor/vision/`, and `models/`; do not publish the whole repository or private input files. Retain the HTML Content Security Policy and use HTTPS.

## What is compared

MediaPipe's landmark positions are converted from normalized image coordinates into pixels **before** distances are computed. Coordinates are centered between the outer eye corners, rotated to level the eye line, and scaled by cheek width. Every feature is a ratio of Euclidean distances. This removes translation, uniform scale, and in-plane roll; the ratio features are also reflection-invariant. It does **not** undo yaw, pitch, perspective, lens distortion, expression, occlusion, or landmark-estimation error. The model's inferred depth is not used for the score.

| Group | Measured proportions |
| --- | --- |
| Face outline | Mesh height / cheek width; jaw width / cheek width; lower-chin width / cheek width |
| Eyes | Inner-eye spacing / cheek width; average eye width / cheek width; average eyelid height / average eye width |
| Nose | Nose-side width / cheek width; nasal-root-to-base distance / nose-side width |
| Mouth | Mouth width / cheek width; central upper + lower lip thickness / mouth width |
| Vertical layout | Upper mesh edge to nasal root / mesh height; nose base to chin / mesh height; nose base to upper lip / mesh height |

Landmark 10 is the **upper mesh boundary**, not the hairline. These are projected surface measurements, not clinical anthropometry. Anatomical indices and exact formulas are in the feature definitions; the app draws those same numerator and denominator segments, avoiding a separate visualization formula.

Available views:

- **原图**: photograph without overlays.
- **轮廓**: facial outline, eyes, eyebrows, and lips from MediaPipe connections.
- **Mesh 网格**: the fixed tessellation connecting detected points.
- **测量线**: the selected feature's numerator (cyan) and denominator (cream). The optional point labels show the landmark indices used by the measurements, not all 478 labels at once.
- **Aligned outline**: the two currently selected photos' normalized contours superimposed.
- **Photo-pair matrix**: click a cell to select that specific A/B photo pair.

The mesh locates facial surfaces; it does not itself assign resemblance. The measurement overlays explain **this app's geometry**, not the attention or learned feature attribution of a neural embedding model.

## Score definition

For each proportion, with nonnegative measured values `a` and `b`:

```text
d = abs(a - b) / max((a + b) / 2, 0.01)
D_group = mean(d for features in that group)
D = mean(D_group for the five groups)
pair_score = 100 × exp(-D / 0.20)
```

The five groups each have 20% weight. Features share their group's weight equally, so groups with more measurements do not automatically dominate. The 0.20 sensitivity parameter and 0.01 denominator floor are transparent engineering choices, not learned or human-calibrated values. The score is not a probability, a percentile, or a percentage of visual similarity. Correlated ratios are not independent evidence. Texture, skin appearance, hairstyle, and other overall visual cues are not represented.

For N valid photos in A and M in B, the app computes every N × M pair and reports:

- The median pair score as the headline number.
- Minimum, maximum, and interquartile range (R-7 interpolated quartiles).
- Median group scores across pairs.
- Raw proportion medians separately for A and B, and median per-pair relative differences.

The headline is not the arithmetic mean of the displayed group score medians: nonlinear scoring and aggregation occur in a different order. Ranges describe sensitivity to the selected photos, **not a confidence interval**. Users supply the grouping; the application does not check whether photos within a group represent one identity. A single photo in each group gives one pair and zero IQR, which does not establish high confidence.

The optional UTF-8 CSV contains method metadata, summary statistics, every pair and feature value, formulas, and image-specific warnings/exclusions. It does not contain source filenames, photos, or landmark coordinates.

## What PerFace contributes

The motivating question is whether a score agrees with **which of two different faces people think looks closer to a reference**. Identity-trained features alone do not establish that agreement.

[PerFace (ICIP 2025 / arXiv v1)](https://arxiv.org/html/2509.20281v1) fine-tunes an ArcFace-based 512-dimensional representation with human triplet judgments on 6,400 face-swap samples. Table 1 reports 0.917 triplet accuracy against 0.701 for the ArcFace comparison on its evaluation set. These are relative-choice accuracies for that study, not an absolute resemblance scale or evidence of equal accuracy on arbitrary portrait uploads. The shared swap-target design controls parts of the appearance context; the paper also reports sensitivity to source/target overlap and annotation agreement.

As checked on 2026-10-31, the [authors' public repository](https://github.com/kumanotanin/PerFace) lists the paper and SimCelebA dataset link, but no runnable model code or pretrained checkpoint. FaceTwin therefore does not claim to run PerFace. Its implementation takes the paper's calibration problem seriously and exposes a transparent baseline first.

A future perceptual model should use consented triplet judgments, split identities between training and evaluation, and report held-out agreement before introducing a calibrated perception score. Learned embedding dimensions have no guaranteed one-to-one interpretation as eye shape or nose width. Region occlusion or attribution could supply a separate sensitivity visualization, which would need its own validation.

## Source layout

```text
index.html                  Interface and method explanations
styles.css                  Responsive layout
src/app.js                  Selection, results, canvases, CSV, Worker orchestration
src/inference.worker.js     MediaPipe initialization and landmark inference
src/geometry.js             Feature definitions, geometry, comparisons, quality hints
scripts/setup_assets.py     Pinned downloads and integrity verification
scripts/serve.py            Restricted loopback static server
tests/geometry.test.mjs     Numerical software tests
tests/server_test.py        Static-server access-scope tests
vendor/                    Downloaded runtime, ignored by Git
models/                    Downloaded model, ignored by Git
```

The Worker is intentionally a **classic Worker**: the pinned MediaPipe WASM loader uses `importScripts()`, which cannot execute in module Workers. The worker dynamically imports the ESM API and runs detection on CPU. Model loading failures and timeouts are recoverable through the UI.

## Verification

With Node.js 18+ available, run the numerical tests without installing packages:

```sh
node --test tests/geometry.test.mjs
uv run python tests/server_test.py
```

Tests cover physical ratios, image aspect ratio, translation/scale/roll/reflection invariance, score symmetry, group weighting, all-pair aggregation, outliers, invalid/degenerate coordinates, and quality warnings. These are software tests, not a resemblance benchmark or a calibration experiment.

Initial verification: all 9 numerical tests and 3 static-server scope tests pass; JavaScript syntax passes; the browser successfully loads the local WASM runtime and Face Landmarker model. Desktop and 390-pixel layouts were inspected. Full photograph-selection/inference/results verification was blocked by the browser's file-upload permission gate and is **not claimed as completed**. No private photos were used.

## References and third-party assets

- [MediaPipe Face Landmarker overview](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker): 478 landmarks and expression blendshapes.
- [Web implementation guide](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js): inference and Worker considerations.
- [Official landmark topology](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/python/solutions/face_mesh_connections.py) and [canonical mesh](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/modules/face_geometry/data/canonical_face_model.obj).
- Runtime: `@mediapipe/tasks-vision` **0.10.21**, Apache-2.0. Model: Google Face Landmarker **float16, version 1**, downloaded separately; consult the linked Google model documentation for its provenance and terms.
- Downloads are version-pinned and checked by SHA-512 (npm package) and SHA-256 (model). The local manifest records SHA-256 for each installed asset.

Project source retains the existing repository license. No PerFace training data or weights are bundled.
