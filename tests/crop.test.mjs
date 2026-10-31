import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as cropHelpers from '../src/crop.js';
import { FULL_REGION, regionToPixels, planTiles, mapLandmarks, faceBounds, paddedFaceCrop, sameFaceDetection, deduplicateFaces, reconcileSoleFaceRefinement } from '../src/crop.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
// Software fixture for coordinate transforms/deduplication, not detector claims.
const face = (x = 0.3, y = 0.3, size = 0.1, samplingScale = 1) => ({ landmarks: Array.from({ length: 478 }, (_, index) => ({ x: x + (index % 2) * size, y: y + (Math.floor(index / 2) % 2) * size * 1.2, z: -0.02 })), blendshapes: { categories: [] }, region: FULL_REGION, samplingScale });

test('crop landmarks map to source normalized coordinates and width-scaled z', () => {
  const result = mapLandmarks([{ x: 0.25, y: 0.75, z: -0.2 }], { x: 0.1, y: 0.2, width: 0.4, height: 0.3 })[0];
  close(result.x, 0.2);
  close(result.y, 0.425);
  close(result.z, -0.08);
  // The same mapping remains correct for a 2000×600 source and nonsquare crop.
  close(result.x * 2000, 200 + 0.25 * 800);
  close(result.y * 600, 120 + 0.75 * 180);
});

test('pixel regions clamp to original edges and preserve actual mapped bounds', () => {
  const pixels = regionToPixels({ x: -0.1, y: 0.8, width: 0.4, height: 0.4 }, 1000, 500);
  assert.deepEqual(pixels, { x: 0, y: 400, width: 300, height: 100, region: { x: 0, y: 0.8, width: 0.3, height: 0.2 } });
  assert.throws(() => regionToPixels(FULL_REGION, 0, 500));
});

test('overlapping 2×2 and 3×3 tiles cover every source edge without gaps', () => {
  for (const grid of [2, 3]) {
    const tiles = planTiles(2000, 601, grid);
    assert.equal(tiles.length, grid * grid);
    close(tiles[0].x, 0);
    close(tiles[0].y, 0);
    close(tiles.at(-1).x + tiles.at(-1).width, 1);
    close(tiles.at(-1).y + tiles.at(-1).height, 1);
    assert.ok(tiles[1].x < tiles[0].width);
    assert.ok(tiles[grid].y < tiles[0].height);
    for (const tile of tiles) assert.ok(tile.x >= 0 && tile.y >= 0 && tile.x + tile.width <= 1 + 1e-10 && tile.y + tile.height <= 1 + 1e-10);
  }
});

test('padded crop is square in pixels and bounded near all four corners', () => {
  for (const [x, y] of [[0, 0], [0.88, 0], [0, 0.85], [0.88, 0.85]]) {
    const region = paddedFaceCrop(face(x, y).landmarks, 2000, 1000);
    assert.ok(region.x >= 0 && region.y >= 0 && region.x + region.width <= 1 && region.y + region.height <= 1);
    assert.ok(Math.abs(region.width * 2000 - region.height * 1000) <= 1);
  }
  assert.equal(paddedFaceCrop([], 2000, 1000), null);
});

test('duplicate detections map from tiles and keep higher source sampling', () => {
  const a = face();
  const b = face(0.302, 0.302, 0.1, 2);
  const region = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
  const local = b.landmarks.map((point) => ({ x: (point.x - region.x) / region.width, y: (point.y - region.y) / region.height, z: point.z / region.width }));
  const mapped = { ...b, landmarks: mapLandmarks(local, region) };
  assert.ok(sameFaceDetection(a, mapped, 2000, 600));
  assert.deepEqual(deduplicateFaces([a, mapped], 2000, 600), [mapped]);
});

test('distinct people are preserved; absence and invalid meshes yield no detections', () => {
  const a = face();
  const b = face(0.55, 0.3);
  assert.equal(sameFaceDetection(a, b, 2000, 600), false);
  assert.equal(deduplicateFaces([a, b, face(0.301, 0.301)], 2000, 600).length, 2);
  assert.deepEqual(deduplicateFaces([], 2000, 600), []);
  assert.deepEqual(deduplicateFaces([{ landmarks: [] }], 2000, 600), []);
  assert.equal(faceBounds([]), null);
  const closeA = { ...face(), passId: 1 };
  const closeB = { ...face(0.31, 0.3), passId: 1 };
  assert.equal(deduplicateFaces([closeA, closeB], 2000, 600).length, 2, 'same-pass detections must never be merged');
});

// Exercise actual worker orchestration with a deterministic detector stub. No
// image files/model or face-detection accuracy assertions are involved.
async function workerHarness(faces, missFull = false, refinementFaces = null) {
  const source = await readFile(new URL('../src/inference.worker.js', import.meta.url), 'utf8');
  const sourceWidth = 1000;
  const sourceHeight = 600;
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { drawImage: (_bitmap, x, y, width, height) => { this.region = { x: x / sourceWidth, y: y / sourceHeight, width: width / sourceWidth, height: height / sourceHeight }; } }; }
  }
  let detectorCalls = 0;
  const detector = { detect(canvas) {
    const region = canvas.region;
    const visible = refinementFaces && detectorCalls > 0 ? refinementFaces : faces;
    detectorCalls += 1;
    const matches = missFull && region.width === 1 && region.height === 1 ? [] : visible.filter((candidate) => {
      const bounds = faceBounds(candidate.landmarks);
      return bounds.x >= region.x && bounds.y >= region.y && bounds.x + bounds.width <= region.x + region.width && bounds.y + bounds.height <= region.y + region.height;
    });
    return {
      faceLandmarks: matches.map((candidate) => candidate.landmarks.map((point) => ({ x: (point.x - region.x) / region.width, y: (point.y - region.y) / region.height, z: point.z / region.width }))),
      faceBlendshapes: matches.map((candidate) => candidate.blendshapes),
    };
  } };
  const context = vm.createContext({ self: { location: { href: 'http://example.test/src/inference.worker.js' } }, OffscreenCanvas: Canvas, cropHelpers, detector });
  vm.runInContext(source + '\ncrop = cropHelpers; landmarker = detector; self.runDetection = detectImage;', context);
  return context.self.runDetection({ width: sourceWidth, height: sourceHeight });
}

test('worker absence completes all 14 discovery passes without inventing a face', async () => {
  const result = await workerHarness([]);
  assert.equal(result.faceLandmarks.length, 0);
  assert.equal(result.detectionInfo.passes, 14);
  assert.equal(result.detectionInfo.sourceFaceWidthPx, null);
});

test('worker recovers small tiled face and refines once in original coordinates', async () => {
  const candidate = face(0.32, 0.34, 0.06);
  const result = await workerHarness([candidate], true);
  assert.equal(result.faceLandmarks.length, 1);
  assert.equal(result.detectionInfo.method, 'tiled-refined');
  assert.equal(result.detectionInfo.passes, 15);
  close(result.faceLandmarks[0][1].x, candidate.landmarks[1].x);
  close(result.faceLandmarks[0][1].y, candidate.landmarks[1].y);
  close(result.faceLandmarks[0][1].z, candidate.landmarks[1].z);
  close(result.detectionInfo.sourceFaceWidthPx, 60);
  assert.equal(result.cropRegions.length, 1);
});

test('worker preserves multiple tiled faces and skips sole-face refinement', async () => {
  const result = await workerHarness([face(0.1, 0.2, 0.06), face(0.8, 0.3, 0.06)], true);
  assert.equal(result.faceLandmarks.length, 2);
  assert.equal(result.cropRegions.length, 2);
  assert.equal(result.detectionInfo.method, 'tiled');
  assert.equal(result.detectionInfo.passes, 14);
  assert.equal(result.detectionInfo.sourceFaceWidthPx, null);
});

function uncertainOutlinePair() {
  const make = (box, passId) => {
    const landmarks = Array.from({ length: 478 }, () => ({ x: 0.35, y: 0.36, z: -0.02 }));
    landmarks[10] = { x: box.x, y: box.y };
    landmarks[152] = { x: box.x + box.width, y: box.y + box.height };
    for (const [index, [x, y]] of Object.entries({ 33: [0.32, 0.33], 263: [0.38, 0.33], 1: [0.35, 0.37], 61: [0.33, 0.4], 291: [0.37, 0.4] })) landmarks[index] = { x, y, z: -0.02 };
    return { landmarks, blendshapes: { categories: [] }, region: FULL_REGION, samplingScale: 1, passId };
  };
  return [make({ x: 0.23, y: 0.2, width: 0.24, height: 0.32 }, 1), make({ x: 0.3, y: 0.27, width: 0.1, height: 0.18 }, 2)];
}

test('sole refinement resolves outline disagreement with stable separated anchors', () => {
  const [coarse, refined] = uncertainOutlinePair();
  assert.equal(deduplicateFaces([refined, coarse], 1000, 600).length, 2, 'ordinary discovery stays conservative');
  assert.deepEqual(reconcileSoleFaceRefinement([coarse], [refined], 1000, 600), [refined]);
  const slightlyShifted = structuredClone(refined);
  for (const index of [1, 33, 263, 61, 291]) slightlyShifted.landmarks[index].x += 0.003;
  assert.equal(reconcileSoleFaceRefinement([coarse], [slightlyShifted], 1000, 600).length, 1);
});

test('refinement exception rejects distinct anchors, multiple faces, same pass, or degenerate eye span', () => {
  const [coarse, refined] = uncertainOutlinePair();
  const shifted = structuredClone(refined);
  for (const index of [1, 33, 263, 61, 291]) shifted.landmarks[index].x += 0.02;
  assert.equal(reconcileSoleFaceRefinement([coarse], [shifted], 1000, 600).length, 2);
  const oneBadAnchor = structuredClone(refined);
  oneBadAnchor.landmarks[1].x += 0.015;
  assert.equal(reconcileSoleFaceRefinement([coarse], [oneBadAnchor], 1000, 600).length, 2);
  const samePass = { ...refined, passId: coarse.passId };
  assert.equal(reconcileSoleFaceRefinement([coarse], [samePass], 1000, 600).length, 2);
  assert.ok(reconcileSoleFaceRefinement([coarse], [refined, { ...refined }], 1000, 600).length >= 2);
  const collapsedOld = structuredClone(coarse);
  const collapsedNew = structuredClone(refined);
  collapsedOld.landmarks[263] = collapsedOld.landmarks[33];
  collapsedNew.landmarks[263] = collapsedNew.landmarks[33];
  assert.equal(reconcileSoleFaceRefinement([collapsedOld], [collapsedNew], 1000, 600).length, 2);
});

test('ordinary accepted refinement preserves the exact previously selected object', () => {
  const coarse = { ...face(), passId: 1, samplingScale: 2 };
  const refined = { ...face(0.302, 0.302), passId: 2, samplingScale: 1 };
  const ordinary = deduplicateFaces([refined, coarse], 1000, 600);
  assert.equal(ordinary.length, 1);
  assert.equal(reconcileSoleFaceRefinement([coarse], [refined], 1000, 600)[0], ordinary[0]);
  assert.equal(reconcileSoleFaceRefinement([coarse], [refined], 1000, 600)[0], coarse);
});

test('actual worker sole-refinement branch keeps one face despite corrected outline', async () => {
  const [coarse, refined] = uncertainOutlinePair();
  const result = await workerHarness([coarse], false, [refined]);
  assert.equal(result.faceLandmarks.length, 1);
  assert.equal(result.detectionInfo.passes, 2);
  assert.equal(result.detectionInfo.method, 'full-refined');
  close(result.faceLandmarks[0][10].x, refined.landmarks[10].x);
  close(result.detectionInfo.sourceFaceWidthPx, 100);
});
