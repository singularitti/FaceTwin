import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareLandmarkChoices, applyLandmarkChoice } from '../src/landmarks.js';
import { extractGeometry, summarizeQuality, compareGeometry } from '../src/geometry.js';
import { EXPRESSION_POLICY } from '../src/expression.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const WIDTH = 800;
const HEIGHT = 600;

// Explicit software landmarks and coefficients exercise cache/selection state;
// these are neither photographs nor assertions about detector accuracy.
function mesh({ cheekHalfWidth = 125, upperLip = 10 } = {}) {
  const points = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const anchors = {
    10: [0, -170], 152: [0, 180], 234: [-cheekHalfWidth, 0], 454: [cheekHalfWidth, 0],
    172: [-95, 110], 397: [95, 110], 149: [-55, 155], 378: [55, 155],
    33: [-85, -65], 133: [-35, -65], 362: [35, -65], 263: [85, -65],
    159: [-60, -75], 145: [-60, -55], 386: [60, -75], 374: [60, -55],
    48: [-25, 15], 278: [25, 15], 168: [0, -75], 2: [0, 35], 1: [0, 20],
    61: [-50, 90], 291: [50, 90], 0: [0, 85 - upperLip], 13: [0, 85], 14: [0, 95], 17: [0, 108],
  };
  for (const [index, [x, y]] of Object.entries(anchors)) points[index] = { x: (400 + x) / WIDTH, y: (300 + y) / HEIGHT, z: 0 };
  return points;
}

function variant({ cheekHalfWidth = 125, upperLip = 10, press = 0, method = 'full-refined' } = {}) {
  return {
    landmarks: mesh({ cheekHalfWidth, upperLip }),
    blendshapes: { categories: EXPRESSION_POLICY.requiredSignals.map((categoryName) => ({ categoryName, score: categoryName === 'mouthPressLeft' ? press : 0 })) },
    cropRegion: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    detectionInfo: { method, passes: 3, sourceFaceWidthPx: cheekHalfWidth * 2 },
  };
}

function response() {
  return { landmarkVariants: {
    original: variant(),
    upright: variant({ cheekHalfWidth: 50, upperLip: 20, press: 0.45, method: 'full-refined-upright' }),
  }, selectedLandmarkVariant: 'upright' };
}

test('preparation keeps the valid original when optional upright geometry is invalid', () => {
  const invalidVariants = [
    { landmarks: [] },
    { landmarks: mesh().map((point, index) => index === 33 ? { ...point, x: NaN } : point) },
    { landmarks: Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 })) },
  ];
  for (const upright of invalidVariants) {
    const input = { landmarkVariants: { original: variant(), upright }, selectedLandmarkVariant: 'upright' };
    const before = structuredClone(input);
    const choices = prepareLandmarkChoices(input, WIDTH, HEIGHT);
    assert.deepEqual(Object.keys(choices), ['original']);
    assert.equal(choices.original.result.valid, true);
    const photo = { landmarkChoices: choices, lipMode: 'auto' };
    assert.equal(applyLandmarkChoice(photo, input.selectedLandmarkVariant), false);
    assert.equal(applyLandmarkChoice(photo, 'original'), true);
    assert.equal(photo.result, choices.original.result);
    assert.deepEqual(input, before);
  }
});

test('preparation caches each pass geometry, quality, coefficients, and provenance without mutation', () => {
  const input = response();
  const before = structuredClone(input);
  const choices = prepareLandmarkChoices(input, WIDTH, HEIGHT);
  assert.deepEqual(Object.keys(choices), ['original', 'upright']);
  for (const mode of ['original', 'upright']) {
    const source = input.landmarkVariants[mode];
    assert.equal(choices[mode].landmarks, source.landmarks);
    assert.equal(choices[mode].blendshapes, source.blendshapes.categories);
    assert.equal(choices[mode].cropRegion, source.cropRegion);
    assert.equal(choices[mode].detectionInfo, source.detectionInfo);
    assert.deepEqual(choices[mode].result, extractGeometry(source.landmarks, WIDTH, HEIGHT));
    assert.deepEqual(choices[mode].quality, summarizeQuality(source.landmarks, WIDTH, HEIGHT, source.blendshapes.categories));
  }
  close(choices.original.result.metrics.lipThickness, 23 / 100);
  close(choices.upright.result.metrics.lipThickness, 33 / 100);
  close(choices.original.quality.measurements.faceWidthPixels, 250);
  close(choices.upright.quality.measurements.faceWidthPixels, 100);
  assert.deepEqual(input, before);
});

test('switching cached passes updates all active diagnostics and recomputes automatic lip q', () => {
  const choices = prepareLandmarkChoices(response(), WIDTH, HEIGHT);
  const photo = { landmarkChoices: choices, lipMode: 'auto', id: 'software-fixture' };
  assert.equal(applyLandmarkChoice(photo, 'original'), true);
  close(photo.lip.autoReliability, 1);
  close(photo.lip.reliability, 1);
  assert.equal(applyLandmarkChoice(photo, 'upright'), true);
  assert.equal(photo.landmarkMode, 'upright');
  for (const field of ['landmarks', 'result', 'quality', 'blendshapes', 'cropRegion', 'detectionInfo']) assert.equal(photo[field], choices.upright[field]);
  // 100px width gives size factor .5; press .45 gives expression factor .5.
  close(photo.lip.autoReliability, 0.25);
  close(photo.lip.reliability, 0.25);
  close(photo.lip.signals.mouthPressLeft, 0.45);
  assert.equal(photo.lip.mode, 'auto');
  assert.equal(photo.id, 'software-fixture');
});

test('switches honor the CURRENT manual mode while retaining new-pass automatic diagnostics', () => {
  const choices = prepareLandmarkChoices(response(), WIDTH, HEIGHT);
  const photo = { landmarkChoices: choices, lipMode: 'auto' };
  applyLandmarkChoice(photo, 'original');
  photo.lipMode = 'include';
  applyLandmarkChoice(photo, 'upright');
  assert.equal(photo.lipMode, 'include');
  assert.equal(photo.lip.mode, 'include');
  assert.equal(photo.lip.reliability, 1);
  close(photo.lip.autoReliability, 0.25);
  assert.ok(photo.lip.reasons.some((reason) => reason.code === 'manual-include'));
  photo.lipMode = 'exclude';
  applyLandmarkChoice(photo, 'original');
  assert.equal(photo.lipMode, 'exclude');
  assert.equal(photo.lip.mode, 'exclude');
  assert.equal(photo.lip.reliability, 0);
  close(photo.lip.autoReliability, 1);
  assert.ok(photo.lip.reasons.some((reason) => reason.code === 'manual-exclude'));
  photo.lipMode = 'auto';
  applyLandmarkChoice(photo, 'upright');
  close(photo.lip.reliability, 0.25);
  assert.equal(photo.lip.mode, 'auto');
});

test('switching back restores the exact baseline result and preserves both complete caches', () => {
  const choices = prepareLandmarkChoices(response(), WIDTH, HEIGHT);
  const before = structuredClone(choices);
  const baselineResult = choices.original.result;
  const baselineComparison = compareGeometry(baselineResult, baselineResult);
  const photo = { landmarkChoices: choices, lipMode: 'auto' };
  applyLandmarkChoice(photo, 'original');
  const baselineLip = structuredClone(photo.lip);
  applyLandmarkChoice(photo, 'upright');
  assert.notDeepEqual(photo.result.metrics, baselineResult.metrics);
  applyLandmarkChoice(photo, 'original');
  assert.equal(photo.landmarkChoices, choices);
  assert.equal(photo.result, baselineResult);
  assert.deepEqual(compareGeometry(photo.result, baselineResult), baselineComparison);
  assert.deepEqual(photo.lip, baselineLip);
  assert.deepEqual(choices, before);
  assert.equal(choices.upright.result.valid, true);
});

test('unknown, absent, and invalid cached selections are no-ops', () => {
  const choices = prepareLandmarkChoices(response(), WIDTH, HEIGHT);
  choices.invalid = { result: { valid: false }, landmarks: [] };
  const photo = { landmarkChoices: choices, lipMode: 'include' };
  applyLandmarkChoice(photo, 'original');
  const before = structuredClone(photo);
  const result = photo.result;
  const lip = photo.lip;
  for (const mode of ['missing', 'invalid', undefined, null, 'toString', '__proto__']) {
    assert.equal(applyLandmarkChoice(photo, mode), false);
    assert.deepEqual(photo, before);
    assert.equal(photo.result, result);
    assert.equal(photo.lip, lip);
  }
  const empty = { lipMode: 'auto' };
  assert.equal(applyLandmarkChoice(empty, 'original'), false);
  assert.deepEqual(empty, { lipMode: 'auto' });
});

test('legacy response prepares and selects an original choice with all prior metadata', () => {
  const source = variant();
  const legacy = {
    faceLandmarks: [source.landmarks],
    faceBlendshapes: [source.blendshapes],
    cropRegions: [source.cropRegion],
    detectionInfo: source.detectionInfo,
  };
  const before = structuredClone(legacy);
  const choices = prepareLandmarkChoices(legacy, WIDTH, HEIGHT);
  assert.deepEqual(Object.keys(choices), ['original']);
  const photo = { landmarkChoices: choices, lipMode: 'include' };
  assert.equal(applyLandmarkChoice(photo, 'original'), true);
  assert.equal(photo.landmarks, source.landmarks);
  assert.equal(photo.blendshapes, source.blendshapes.categories);
  assert.equal(photo.detectionInfo, source.detectionInfo);
  assert.equal(photo.cropRegion, source.cropRegion);
  assert.equal(photo.lip.reliability, 1);
  assert.equal(photo.lipMode, 'include');
  assert.deepEqual(legacy, before);
  assert.deepEqual(prepareLandmarkChoices({}, WIDTH, HEIGHT), {});
});

test('missing coefficients retain valid geometry with unknown automatic lip reliability', () => {
  const input = { faceLandmarks: [mesh()] };
  const choices = prepareLandmarkChoices(input, WIDTH, HEIGHT);
  const photo = { landmarkChoices: choices, lipMode: 'auto' };
  assert.equal(applyLandmarkChoice(photo, 'original'), true);
  assert.equal(photo.result.valid, true);
  assert.deepEqual(photo.blendshapes, []);
  assert.equal(photo.lip.known, false);
  assert.equal(photo.lip.reliability, 0);
  assert.equal(photo.lip.level, 'unknown');
});
