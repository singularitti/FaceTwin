import test from 'node:test';
import assert from 'node:assert/strict';
import { SCORE_SCALE, FEATURE_DEFINITIONS, GROUP_DEFINITIONS, normalizeLandmarks, extractGeometry, compareGeometry, aggregateComparisons, summarizeQuality } from '../src/geometry.js';

// Software fixture with explicit anatomical anchors, not a model/simulation run.
function fixture() {
  const points = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const anchors = { 10: [0, -170], 152: [0, 180], 234: [-125, 0], 454: [125, 0], 172: [-95, 110], 397: [95, 110], 149: [-55, 155], 378: [55, 155], 33: [-85, -65], 133: [-35, -65], 362: [35, -65], 263: [85, -65], 159: [-60, -75], 145: [-60, -55], 386: [60, -75], 374: [60, -55], 48: [-25, 15], 278: [25, 15], 168: [0, -75], 2: [0, 35], 1: [0, 20], 61: [-50, 90], 291: [50, 90], 0: [0, 75], 13: [0, 85], 14: [0, 95], 17: [0, 108] };
  for (const [index, [x, y]] of Object.entries(anchors)) points[index] = { x: (x + 400) / 800, y: (y + 300) / 600, z: 0 };
  return points;
}

function transform(points, { scale = 1, angle = 0, dx = 0, dy = 0, width = 800, height = 600, mirror = false } = {}) {
  return points.map((point) => {
    const x = (point.x * 800 - 400) * (mirror ? -1 : 1);
    const y = point.y * 600 - 300;
    return { x: (scale * (x * Math.cos(angle) - y * Math.sin(angle)) + 400 + dx) / width, y: (scale * (x * Math.sin(angle) + y * Math.cos(angle)) + 300 + dy) / height };
  });
}

const close = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const original = () => extractGeometry(fixture(), 800, 600);

test('13 documented ratios expose all numerator/denominator segments and group weights', () => {
  assert.equal(FEATURE_DEFINITIONS.length, 13);
  assert.equal(SCORE_SCALE, 0.2);
  close(FEATURE_DEFINITIONS.reduce((sum, feature) => sum + feature.weight, 0), 1);
  for (const group of GROUP_DEFINITIONS) {
    const metrics = FEATURE_DEFINITIONS.filter((feature) => feature.group === group.id);
    close(metrics.reduce((sum, feature) => sum + feature.weight, 0), 0.2);
    for (const feature of metrics) {
      assert.ok(feature.formula && feature.explanation && feature.label);
      assert.equal(feature.tolerance, 0.2);
      for (const pair of [...feature.segments.numerator, ...feature.segments.denominator]) assert.ok(pair.length === 2 && pair.every(Number.isInteger));
    }
  }
});

test('pixel aspect ratio conversion produces known physical ratios', () => {
  const geometry = original();
  assert.ok(geometry.valid);
  close(geometry.metrics.faceAspect, 350 / 250);
  close(geometry.metrics.eyeWidth, 50 / 250);
  close(geometry.metrics.noseAspect, 110 / 50);
  close(geometry.metrics.lipThickness, 23 / 100);
  const wide = extractGeometry(transform(fixture(), { width: 1600, height: 450 }), 1600, 450);
  for (const feature of FEATURE_DEFINITIONS) close(geometry.metrics[feature.id], wide.metrics[feature.id]);
});

test('ratios survive translation, uniform scale, roll and image mirroring', () => {
  const base = original();
  for (const options of [{ dx: 40, dy: -20 }, { scale: 1.4 }, { angle: 0.7 }, { mirror: true }, { scale: 0.8, angle: -0.5, dx: 15, dy: 20, mirror: true, width: 1200, height: 700 }]) {
    const transformed = extractGeometry(transform(fixture(), options), options.width ?? 800, options.height ?? 600);
    assert.ok(transformed.valid);
    for (const feature of FEATURE_DEFINITIONS) close(transformed.metrics[feature.id], base.metrics[feature.id]);
    close(compareGeometry(base, transformed).score, 100);
  }
  const normalized = normalizeLandmarks(fixture(), 800, 600);
  close(normalized.points[33].y, 0);
  close(normalized.points[263].y, 0);
  close(normalized.points[234].x, -0.5);
  close(normalized.points[454].x, 0.5);
});

test('exact matches score 100; comparisons are symmetric and respond to differences', () => {
  const a = original();
  const b = structuredClone(a);
  b.metrics.noseWidth *= 1.2;
  const ab = compareGeometry(a, b);
  const ba = compareGeometry(b, a);
  close(compareGeometry(a, a).score, 100);
  close(ab.score, ba.score);
  assert.ok(ab.score < 100 && ab.score > 0);
  close(ab.metrics.noseWidth.difference, 0.2 / 1.1);
  close(ab.groups.face.score, 100);
});

test('groups have equal total influence despite different feature counts', () => {
  const a = original();
  const changeGroup = (group) => {
    const b = structuredClone(a);
    for (const feature of FEATURE_DEFINITIONS.filter((feature) => feature.group === group)) b.metrics[feature.id] *= 1.2;
    return compareGeometry(a, b);
  };
  close(changeGroup('face').score, changeGroup('mouth').score);
  close(changeGroup('eyes').score, changeGroup('nose').score);
  const expected = 100 * Math.exp(-(0.2 / 1.1) / 0.2 / 5);
  close(changeGroup('face').score, expected);
});

test('all cross-photo pairs aggregate by median and expose spread and raw ratios', () => {
  const a = original();
  const outlier = structuredClone(a);
  for (const feature of FEATURE_DEFINITIONS) outlier.metrics[feature.id] *= 3;
  const result = aggregateComparisons([a, a, outlier], [a, a]);
  assert.ok(result.valid);
  assert.equal(result.pairs.length, 6);
  assert.deepEqual(result.pairMatrix.map((row) => row.length), [2, 2, 2]);
  close(result.median, 100);
  assert.ok(result.min < result.median);
  close(result.max, 100);
  assert.ok(result.iqr > 0);
  close(result.groupMedians.face, 100);
  close(result.metricRawMedians.a.faceAspect, a.metrics.faceAspect);
  close(result.metricRawMedians.b.faceAspect, a.metrics.faceAspect);
  assert.deepEqual(result.validPhotoCounts, { a: 3, b: 2 });
});

test('one pair has zero IQR; empty and invalid inputs do not invent scores', () => {
  const a = original();
  const one = aggregateComparisons([a], [a]);
  close(one.iqr, 0);
  const empty = aggregateComparisons([], [a]);
  assert.equal(empty.valid, false);
  assert.equal(empty.median, null);
  const partial = aggregateComparisons([a, { valid: false }], [a]);
  assert.deepEqual(partial.pairMatrix, [[100], [null]]);
  assert.deepEqual(partial.excluded.a, [1]);
  assert.equal(compareGeometry(a, { valid: true, metrics: {} }).score, null);
});

test('bad dimensions, missing points, NaN and degenerate references are rejected', () => {
  assert.equal(extractGeometry([], 800, 600).valid, false);
  assert.equal(extractGeometry(fixture(), 0, 600).valid, false);
  assert.equal(extractGeometry(fixture(), NaN, 600).valid, false);
  const missing = fixture();
  missing[33] = null;
  assert.equal(extractGeometry(missing, 800, 600).valid, false);
  const invalid = fixture();
  invalid[168].x = NaN;
  assert.equal(extractGeometry(invalid, 800, 600).valid, false);
  const collapsed = fixture();
  collapsed[454] = collapsed[234];
  assert.equal(extractGeometry(collapsed, 800, 600).valid, false);
  const zeroNose = fixture();
  zeroNose[278] = zeroNose[48];
  assert.equal(extractGeometry(zeroNose, 800, 600).valid, false);
  const zeroFace = fixture();
  zeroFace[152] = zeroFace[10];
  assert.equal(extractGeometry(zeroFace, 800, 600).valid, false);
  const overflow = fixture();
  overflow[234].x = Number.MAX_VALUE;
  assert.equal(normalizeLandmarks(overflow, 800, 600).valid, false);
});

test('quality heuristics flag small, clipped, turned and expressive examples', () => {
  assert.equal(summarizeQuality(fixture(), 800, 600).level, 'ok');
  const small = transform(fixture(), { scale: 0.3 });
  assert.ok(summarizeQuality(small, 800, 600).warnings.some((warning) => warning.code === 'small'));
  const clipped = fixture();
  clipped[10].y = 0;
  assert.ok(summarizeQuality(clipped, 800, 600).warnings.some((warning) => warning.code === 'clipped'));
  const turned = fixture();
  turned[1].x += 0.1;
  assert.ok(summarizeQuality(turned, 800, 600).warnings.some((warning) => warning.code === 'pose'));
  const expressive = summarizeQuality(fixture(), 800, 600, { categories: [{ categoryName: 'mouthSmileLeft', score: 0.8 }] });
  assert.ok(expressive.warnings.some((warning) => warning.code === 'expression'));
  assert.equal(summarizeQuality([], 800, 600).valid, false);
});
