# FaceTwin WFLW showcase

This independent static exhibition presents the existing, completed WFLW test-split run. The repository-root local comparison application remains separate. GitHub Pages publishes only this `showcase/` directory.

The page contains the original five highest-scoring image pairs, their quality warnings, actual selected model coordinates, thirteen ratio measurements, research attribution, and a visual-review note for the suspected duplicate image in pair two. Scores are uncalibrated geometry scores, not resemblance percentages or identity predictions. All 2,500 official test records were attempted; 2,244 valid records yielded 2,516,646 pairs. No new inference or training is performed by this website.

## Data provenance

`data/results.json` and the explicitly selected assets were exported from the preserved local full run with `scripts/export_wflw_showcase.mjs`. The exporter checks the ten crop checksums against that run's manifest and copies only those public WFLW inputs. Original watermarks remain intact. No personal photo, full dataset archive, local path, host information, log, or credential is included. `data/asset-manifest.json` records file hashes.

The 98 manually annotated WFLW points were used only to locate target crops. The displayed 478-point detections and all scores come from FaceTwin's MediaPipe pipeline. Target crops used the annotated point envelope plus 34% margin on each side, clipped to actual source dimensions. The margin was fixed before inference to address 18 incorrectly clipped rectangles in the converted annotation file. Cropping did not resize source pixels. Selected upright-pass points are mapped to the original crop coordinate system.

The PDF and CSV downloads are the existing verified result artifacts. Details and full raw outputs remain in the ignored run directory; the static site publishes only what is needed to inspect these five pairs. Photo rights and attribution are documented in `assets/faces/NOTICE.md`; dataset photographs are not relicensed under the project's software license.

## Rebuild and verify

From the repository root with Node.js installed:

```sh
node scripts/export_wflw_showcase.mjs
node scripts/verify_showcase.mjs
```

Export requires the original full run, which is intentionally not part of the public repository. Verification uses the committed showcase data and assets and works in a clean checkout. No export is required for deployment. Avoid modifying either the ranking or the coordinates to improve presentation scores.

For local preview, serve the directory with any static HTTP server. All runtime URLs are relative so the same page works on a GitHub Pages project subpath. The interface uses no remote scripts, fonts, analytics, uploads, or inference service. External links are research references only.

## Deployment

`.github/workflows/showcase-pages.yml` verifies the committed artifact and publishes only `showcase/` through GitHub Actions. Changes to that directory, its verifier, or the workflow on `main` trigger deployment. GitHub Pages must use the `workflow` build type. All workflow actions are pinned to reviewed commit hashes. The workflow needs only read access to source code and the standard `pages: write` / `id-token: write` deployment permissions.
