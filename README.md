# FaceTwin

A local, multi-image facial resemblance explorer with visible geometric measurements.

FaceTwin 0.1 compares two sets of portrait photos, draws face landmarks and a mesh, and explains a **geometric resemblance score** through 13 measured proportions. The interface is in Chinese. It is an exploratory geometry baseline, not a validated model of human-perceived resemblance, an identity verification service, or a PerFace reproduction.

## Run locally

Requirements: [uv](https://docs.astral.sh/uv/) and a modern desktop browser with WebAssembly, Workers, `createImageBitmap`, and `OffscreenCanvas`. Start with a recent Chrome or Edge. The project selects Python 3.14 through `.python-version`; the scripts support Python 3.10+. `uv sync` installs Pillow and pillow-heif for local HEIF decoding. No npm installation, account, API key, or GPU is required.

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

`pyproject.toml` declares Pillow and pillow-heif for decoding HEIF previews, checking ICC profiles, and writing PNG bytes in memory. The HTTP server and asset downloader otherwise use the standard library. Running `uv sync` generates a local `uv.lock` and creates `.venv/`; neither is committed. `uv run` selects the project environment without manual activation. If the selected Python version is unavailable on another machine, uv may download it; this setup reused an existing Python installation.

Use `uv add <package>` for Python runtime dependencies and `uv add --dev <package>` for Python development tools. Commit `pyproject.toml` and `.python-version`; keep the generated lockfile and virtual environment local. A fresh checkout uses `uv sync` to resolve its environment. Separate checkouts can resolve different versions within the declared constraints because no lockfile is shared.

The browser dependencies are **not Python packages**: MediaPipe Tasks Vision 0.10.21 (JavaScript/WASM) and Face Landmarker float16 version 1 remain pinned by URL/version and integrity hashes in the asset setup script. Its local manifest records the installed file checksums. Running the script through uv provides a consistent Python environment but does not put those external assets into `uv.lock`. Node.js is needed only for the JavaScript tests and is not installed or managed by uv; the initial verification used an existing bundled runtime. No `pip install` or `npm install` is required.

Select or drop **1–8 photos per person**, then choose `开始比较`. Supported formats: JPG, PNG, WebP, HEIC, and HEIF; at most 12 MB and 32 megapixels per image. Keep the original HEIF; no manual JPEG conversion is needed. Each photo must contain exactly one detectable face; no-face and multiple-face inputs are excluded and remain visible with an explanation.

### HEIF, color, and small faces

HEIF is a container format; HEIC usually holds HEVC-compressed still images. Some images contain wide-gamut color, 10-bit precision, HDR transfer functions, or gain maps. Converting these to ordinary 8-bit sRGB JPEG can change gamut and brightness as well as introduce compression artifacts. Not every HEIF is HDR, and preserving an ICC profile alone does not preserve HDR rendering.

The app first tries native browser decoding. If HEIF cannot be decoded and the page is running on loopback, it sends the compressed bytes only to the same-origin local Python helper. The helper reads the primary image, applies its container orientation once, preserves supported RGB ICC data, strips EXIF/GPS/XMP, and returns an in-memory PNG. The fallback reduces precision to eight bits: this is **not HDR tone mapping**, does not preserve gain maps, and cannot guarantee the original HDR appearance. The UI labels the fallback explicitly. The source file is never overwritten. The preview uses an `<img>` element so the browser can manage its color; a transparent canvas draws only overlays. Inference still uses an ordinary RGB working image, so rendering quality and the model input are separate concerns.

Small-face detection starts with a bounded full-image pass. If no face is found or the sole face occupies less than 20% of the image width, it scans overlapping 2×2 and 3×3 regions sampled from original pixels. Geometric deduplication merges repeated detections of a region; multiple distinct faces remain excluded. A sole face is refined using a padded original-resolution crop, skipping a crop identical to the full image or selected source region. A visibly tilted face may receive one additional upright pass, described below. Every inference pass has a maximum 1600-pixel edge; up to 16 passes may be needed. Cropped landmarks are mapped back to original coordinates before measurement. `放大人脸` toggles the display crop without modifying the image. Cropping can recover a face lost to whole-image downsampling, but cannot reconstruct missing detail in a genuinely tiny or blurred face.

### Tilted faces and estimated contours

The practical question is whether the landmark overlay follows a tilted face better, not whether its resemblance score increases. Previously, the padded refinement could repeat the full image unchanged, and leveling already-detected coordinates could not repair a bad detection. MediaPipe already uses oriented regions internally; this additional pass supplies a tighter upright image and retains the alternative for inspection, rather than claiming to introduce all rotation handling.

`src/orientation.js` defines `upright-refinement-v1`. When the original outer-eye line is tilted by at least 12°, the worker rotates **original pixels** into a square crop around the first 468 points, with 18% padding per side. Out-of-image areas receive neutral gray padding without shifting or clamping the crop. One inference pass is inverted back to original x/y coordinates; relative z is scaled consistently but remains unused by scoring. The input image and displayed colors are unchanged.

Selection uses pass consistency, never resemblance or expression scores. Displacements are divided by the smaller original/candidate outer-eye span. Five eye/nose/mouth anchors must have mean displacement ≤0.12 and maximum ≤0.25. The 36 oval points must have mean ≤0.20 and maximum ≤0.40 for automatic adoption. Anchor disagreement discards the alternative; contour disagreement retains it as an optional choice while defaulting to the original. Missing/failed optional inference preserves the original, while multiple detected faces remain excluded. These fixed engineering thresholds do not measure anatomical accuracy and were not fitted to the supplied photos.

Both valid passes remain available under **本张关键点 → 原始定位 / 旋正复测**. Selecting a pass updates overlays, all 13 ratios, quality/action diagnostics, and both scores without rerunning the model. The lip override is preserved and reapplied. “Original score” means the unweighted geometric score for the **currently selected pass**, not necessarily the original detection. The original detection remains separately recoverable. CSV records include the selection, policy, agreement, and per-variant ratios, quality, coefficients, and reliability.

This is only **2D eye-line tilt correction**, not yaw/pitch correction, frontalization, or hidden-contour recovery. A fixed anatomical mesh is not pixel segmentation of the visible silhouette. With an existing pose warning, the entire oval is drawn as an orange dashed estimate; it is not a per-point confidence map or a claim about which side is hidden. Other facial contours and measurement segments remain visible. Natural asymmetry can also trigger the warning. Compare both overlays against the photo; neither consistency nor a higher score proves improvement.

Primary implementation references: [MediaPipe's oriented landmark ROI](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/cc/vision/face_landmarker/face_landmarks_detector_graph.cc) and [Face Mesh coordinate/geometry explanation](https://github.com/google-ai-edge/mediapipe/wiki/MediaPipe-Face-Mesh).

Browser image decoding has a 30-second timeout, HEIF requests a 90-second client timeout, and landmark inference a 120-second timeout. A client timeout does not cancel native HEIF decoding on the server. Two native decodes may run concurrently; pathological files can require a server restart. Use local trusted images rather than exposing this helper as a public conversion service.

For useful comparisons, choose clear, approximately frontal photos with similar lighting and neutral expressions. The app flags small or clipped faces, pose proxies, and expression signals. These are heuristic warnings, not validated image-quality or pose estimates; warned photos remain in the score.

## Where it runs

```text
Local photo selection
        ↓
Browser decoding (HEIF fallback: local Python memory → PNG preview)
        ↓
Original-resolution crops → CPU / WebAssembly in a Web Worker
        ↓
478 estimated landmarks → 13 proportions → all A × B comparisons
        ↓
Canvases, feature table, photo-pair matrix, optional CSV download
```

The frontend is a **static client-side web application with a local HEIF decoder endpoint**. Python serves the app on loopback and receives HEIF bytes only when native decoding is unavailable. It does not run landmark inference, write photos to disk, or contact an external service. The endpoint validates Host, Origin, a custom header, input length, and image dimensions, and does not enable CORS. There is no database, telemetry, external font, CDN request at runtime, or browser persistent storage. Photo names are replaced in the interface and exported data by labels such as A1 and B1. Refreshing or closing the page discards the active session. A user-triggered CSV download persists until the user deletes that file.

Use HTTP rather than double-clicking `index.html`: module loading, model fetches, and Workers need an appropriate origin. A conventional static host can serve the frontend, JavaScript/WASM, and model files, but **cannot provide the Python HEIF fallback**; on a non-loopback host the frontend never sends photos to that endpoint. This version has not been publicly deployed. Keep private input files and ignored diagnostic runs out of any deployment. Retain the HTML Content Security Policy and use HTTPS.

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

For example, `D = 0.20 × ln(2) ≈ 0.1386` maps to a score of 50: roughly 13.9% weighted proportional difference, not “half alike.” The UI displays the raw weighted difference alongside the unchanged score. It also shows within-group comparisons (unique unordered photo pairs, no self-pairs) and the largest feature contributions to mean weighted difference across all cross-group pairs. Large within-group variation warns that photos or landmark estimates can dominate; it is not used to inflate scores or perform identity verification. Contribution percentages explain the geometry formula, not human perception, and average contributions should not be added to reconstruct a median score.

### Lip expression hints and experimental reweighting

The interface keeps **original and adjusted scores side by side**. For the currently selected landmark pass, the lip adjustment preserves geometry, five group base weights, measurements, pair membership, and aggregation. The adjustment only changes the influence of `lipThickness`; it does not reconstruct neutral lips, change pixel/landmark coordinates, or correct other expression-sensitive features such as mouth width. Selecting a different landmark pass is a separate operation that can change both scores. Both scores remain uncalibrated against human resemblance ratings, and the adjusted score may increase or decrease.

The existing model already returns blendshape coefficients; no additional model or package is downloaded. `mouthPressLeft/Right` represent lower-lip compression and `mouthRollUpper/Lower` represent inward rolling. Pucker, funnel, smile, stretch, and jaw-open signals also inform lip measurement interference. `mouthClose` is displayed but **does not independently trigger a penalty**: ordinary lip closure is not proof of pressing. These coefficients are estimated from the same landmarks as the geometry, not independent evidence or calibrated probabilities. Thin measured lips and inter-person differences are never inputs to the reliability rule.

`src/expression.js` defines the versioned `lip-reliability-v1` policy. Its thresholds were fixed before inspecting the evaluation photos and are explicit engineering heuristics:

| Factor | Rule |
| --- | --- |
| Expression | Maximum of press, roll, pucker, funnel, smile, stretch, and jaw-open coefficients; reliability decreases smoothly from 1 at 0.20 to 0 at 0.70. |
| Source face width | Quality increases smoothly from 0 at 60 pixels to 1 at 140 pixels. Cropping does not invent additional source pixels. |
| Pose proxies | Quality decreases smoothly for nose displacement / outer-eye span from 0.12 to 0.30, and left/right eye-width imbalance from 1.35 to 2.00. Natural asymmetry can also trigger these proxies. |
| Clipping | A clipped-face warning caps the quality factor at 0.25. |
| Missing data | Missing/invalid coefficients in any of the eleven interference channels or quality measurements makes automatic lip reliability unknown and sets its applied factor to 0, never neutral. The display-only `mouthClose` channel is optional. |

The transition is `smoothstep(t) = t²(3 − 2t)` with `t` clamped to `[0,1]` over the stated interval. The quality factor is the minimum of size, pose, and clipping factors. Per-photo automatic reliability is `q = expression_reliability × quality_factor`. Quality warnings are kept separate from pressing/rolling hints; a small face alone does not imply a lip action. q is an engineering factor, not confidence in the existence of an expression.

For each valid photo pair, let `q_pair = min(q_A, q_B)`. The original lip feature weight is 0.10. Multiply that weight by `q_pair`, leave the other twelve base weights unchanged, and normalize **all** retained feature weights globally:

```text
w'_lip = 0.10 × q_pair
w'_k   = w_k                         for every other feature
D_adj  = sum(w'_k × d_k) / sum(w'_k)
S_adj  = 100 × exp(−D_adj / 0.20)
```

When both q values are 1, the original score is preserved exactly. At q=0 the pair still compares the other twelve features. Retained base-weight coverage ranges from 90% to 100%; it is displayed separately from the normalized lip weight and is **not statistical confidence or accuracy**. The missing lip weight is not reassigned solely to mouth width. Pair and within-group summaries use the same pairs and median convention as the original score.

Each photo offers **automatic / retain lip (q=1) / exclude lip (q=0)** controls. Overrides immediately recompute adjusted scores without rerunning inference or altering the original score. Automatic signals, reasons, and q remain visible for auditing. A retain override is the user's choice to trust a measurement; it does not prove neutral expression. A descriptive lip reference uses only valid photos with applied q≥0.5 and a q-weighted median; no eligible images means “cannot reliably estimate.” This reference helps inspect multi-photo variation but never substitutes for raw pair measurements or selects the thickest lips.

CSV export preserves the existing original records and adds adjusted pairs/features/summaries, retained/effective weights, coverage, per-photo automatic and applied reliability, overrides, quality measurements, raw blendshape coefficients, and the complete policy. The table remains anonymous (A1/B1 labels). The original 10 columns are retained, followed by `base_weight`, `retained_weight`, `effective_weight`, `coverage`, and `reliability`; consumers should use column names. These records make the arithmetic reproducible, not the expression interpretation validated. Private photo runs stay under ignored `runs/` folders with separate input provenance and output reports.

Model/action references: [MediaPipe model overview](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker), [blendshape model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf), [mouthPressLeft](https://developer.apple.com/documentation/arkit/arfaceanchor/blendshapelocation/mouthpressleft), [mouthRollUpper](https://developer.apple.com/documentation/arkit/arfaceanchor/blendshapelocation/mouthrollupper), and [mouthClose](https://developer.apple.com/documentation/arkit/arfaceanchor/blendshapelocation/mouthclose).

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
src/crop.js                 Crop planning, coordinate mapping and deduplication
src/orientation.js          Original-pixel upright crop, inverse mapping, pass agreement
src/landmarks.js            Cached pass preparation and consistent selection
src/media.js                Native photo decoding and local HEIF fallback
src/diagnostics.js          Within-group variability and score contributions
src/expression.js           Versioned lip-action and quality reliability policy
src/adjustment.js           Lip-only reweighting, coverage and reference summaries
src/export.js               Original/adjusted audit CSV records
src/geometry.js             Feature definitions, geometry, comparisons, quality hints
scripts/setup_assets.py     Pinned downloads and integrity verification
scripts/serve.py            Restricted loopback server and HEIF endpoint
scripts/heif_decode.py      Memory-only HEIF primary-image preview
tests/geometry.test.mjs     Numerical software tests
tests/server_test.py        Static-server access-scope tests
tests/crop.test.mjs         Crop geometry and worker orchestration tests
tests/orientation.test.mjs  Analytic affine geometry and pass-consistency gates
tests/landmarks.test.mjs    Pass selection, override persistence and restoration
tests/diagnostics.test.mjs  Score explanation and variability tests
tests/expression.test.mjs   Action hints, unknown data, quality and overrides
tests/adjustment.test.mjs   Weight normalization and unchanged baseline invariants
tests/export.test.mjs       Reconstructable CSV evidence and anonymous labels
tests/heif_test.py          HEIF format, orientation, metadata and color tests
vendor/                    Downloaded runtime, ignored by Git
models/                    Downloaded model, ignored by Git
```

The Worker is intentionally a **classic Worker**: the pinned MediaPipe WASM loader uses `importScripts()`, which cannot execute in module Workers. The worker dynamically imports the ESM API and runs detection on CPU. Model loading failures and timeouts are recoverable through the UI.

## Verification

With Node.js 18+ available, run the numerical tests without installing packages:

```sh
node --test tests/*.test.mjs
uv run python -m unittest discover -s tests -p '*test.py'
```

Tests cover physical ratios, image aspect ratio, translation/scale/roll/reflection invariance, score symmetry, group weighting, all-pair aggregation, outliers, invalid/degenerate coordinates, and quality warnings. These are software tests, not a resemblance benchmark or a calibration experiment.

Verification includes numerical geometry, crop mapping/deduplication, worker orchestration, score diagnostics, actual in-memory HEIF round trips, metadata stripping, and HTTP access checks. A complete browser run with both user-supplied photo groups also exercised HEIF input, tiled small-face recovery, crop refinement, all-pair results, and CSV export. Private input photos and their numerical diagnostic report are not included in source control. These checks establish software behavior, not perceptual resemblance validity or universal small-face detection accuracy.

Expression adjustment verification additionally covers 51 JavaScript and 19 Python tests, full-input browser comparisons in automatic/all-retained/all-excluded modes, unchanged original feature records and scores, restoration of automatic state, manual overrides, action-coefficient display, and lip measurement overlays. An independent CSV audit reconstructs every adjusted score and effective weight, separates expression-only and quality-only sensitivity calculations, and checks input hashes before/after the run. No expression-accuracy or perceptual-validity claim follows from a higher score or these software checks.

Upright refinement verification brings the suite to 84 JavaScript and 19 Python tests, including analytical affine/inverse geometry, original-source sampling, the 16-pass bound, failed/disagreeing/multiple-face refinement, invalid optional geometry, cached-pass restoration, override persistence, and variant CSV records. Browser verification used all seven photos currently available in the supplied directories (4+3, twelve cross-pairs); two former inputs were absent, so this is not a repeat of the older nine-photo run. All corresponding original measurements and pair scores match the previous export after switching back to original landmarks. Full CSVs are byte-identical after both a repeated inference run and restoring the default choices after overrides. An independent 29-check CSV audit reconstructs scores/weights and verifies unchanged input hashes. The target contour was visually inspected in both modes, but no annotated contour ground truth was available; pass displacement and score changes do not establish an accuracy improvement. Private exports and a photo-free control screenshot remain in the ignored, documented run folder.

## References and third-party assets

- [MediaPipe Face Landmarker overview](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker): 478 landmarks and expression blendshapes.
- [Web implementation guide](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js): inference and Worker considerations.
- [Official landmark topology](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/python/solutions/face_mesh_connections.py) and [canonical mesh](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/modules/face_geometry/data/canonical_face_model.obj).
- Runtime: `@mediapipe/tasks-vision` **0.10.21**, Apache-2.0. Model: Google Face Landmarker **float16, version 1**, downloaded separately; consult the linked Google model documentation for its provenance and terms.
- Downloads are version-pinned and checked by SHA-512 (npm package) and SHA-256 (model). The local manifest records SHA-256 for each installed asset.

Project source retains the existing repository license. No PerFace training data or weights are bundled.
