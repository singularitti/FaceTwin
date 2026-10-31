import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_DEFINITIONS, compareGeometry, aggregateComparisons } from '../src/geometry.js';
import { compareAdjusted, aggregateAdjusted, withinGroupAdjusted, summarizeLipReference, LIP_REFERENCE_MIN_RELIABILITY } from '../src/adjustment.js';

// Software ratio fixtures exercise arithmetic contracts without photographs.
const geometry = (value = 1, overrides = {}) => ({
  valid: true,
  metrics: { ...Object.fromEntries(FEATURE_DEFINITIONS.map((feature) => [feature.id, value])), ...overrides },
  errors: [],
});
const close = (actual, expected, tolerance = 1e-10) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('full reliability preserves exact original scalars and raw metrics without mutating inputs', () => {
  const a = geometry(1, { lipThickness: 0.23, eyeWidth: 0.2 });
  const b = geometry(1.5, { lipThickness: 0.31, eyeWidth: 0.18 });
  const before = structuredClone([a, b]);
  Object.freeze(a.metrics);
  Object.freeze(b.metrics);
  Object.freeze(a);
  Object.freeze(b);
  const baseline = compareGeometry(a, b);
  const adjusted = compareAdjusted(a, b, 1, 1);
  assert.equal(adjusted.score, baseline.score);
  assert.equal(adjusted.meanDifference, baseline.meanDifference);
  assert.equal(adjusted.baselineScore, baseline.score);
  assert.equal(adjusted.delta, 0);
  assert.equal(adjusted.coverage, 1);
  for (const feature of FEATURE_DEFINITIONS) {
    for (const key of ['a', 'b', 'difference', 'normalizedDifference', 'score', 'weight']) {
      assert.equal(adjusted.metrics[feature.id][key], baseline.metrics[feature.id][key]);
    }
    assert.equal(adjusted.metrics[feature.id].baseWeight, feature.weight);
  }
  assert.deepEqual([a, b], before);
  assert.deepEqual(compareGeometry(a, b), baseline);
});

test('lip exclusion retains twelve features and normalizes their weights globally', () => {
  const result = compareAdjusted(geometry(), geometry(1, { noseWidth: 1.5, lipThickness: 2 }), 0, 1);
  // Nose d=0.5/1.25=0.4. Its original 0.1 weight becomes 0.1/0.9.
  close(result.meanDifference, 0.4 / 9);
  close(result.score, 100 * Math.exp(-(0.4 / 9) / 0.2));
  close(result.coverage, 0.9);
  assert.equal(result.lipReliability, 0);
  assert.equal(result.lipEffectiveWeight, 0);
  assert.equal(result.metrics.lipThickness.contribution, 0);
  close(result.metrics.noseWidth.effectiveWeight, 1 / 9);
  close(result.metrics.mouthWidth.effectiveWeight, 1 / 9);
  close(result.metrics.faceAspect.effectiveWeight, 2 / 27);
  close(Object.values(result.metrics).reduce((sum, metric) => sum + metric.effectiveWeight, 0), 1);
  assert.equal(result.metrics.lipThickness.b, 2);
  close(result.metrics.lipThickness.difference, 2 / 3);
});

test('pair reliability is the symmetric minimum with partial lip retention', () => {
  const a = geometry();
  const b = geometry(1, { noseWidth: 1.5, lipThickness: 2 });
  const ab = compareAdjusted(a, b, 0.8, 0.2);
  const ba = compareAdjusted(b, a, 0.2, 0.8);
  assert.equal(ab.lipReliability, 0.2);
  assert.equal(ab.score, ba.score);
  assert.equal(ab.coverage, ba.coverage);
  close(ab.coverage, 0.92);
  close(ab.lipEffectiveWeight, 0.02 / 0.92);
  close(ab.meanDifference, (0.1 * 0.4 + 0.02 * (2 / 3)) / 0.92);
  assert.deepEqual(ab, compareAdjusted(a, b, 0.2, 1));
});

test('removing a closer lip measurement can lower the score', () => {
  const a = geometry();
  const b = geometry(1.5, { lipThickness: 1 });
  const baseline = compareGeometry(a, b);
  const adjusted = compareAdjusted(a, b, 0, 1);
  close(baseline.meanDifference, 0.36);
  close(adjusted.meanDifference, 0.4);
  close(adjusted.score, 100 * Math.exp(-2));
  assert.ok(adjusted.score < baseline.score);
  assert.ok(adjusted.delta < 0);
});

test('missing, nonnumeric and out-of-range reliability mean zero; malformed geometry stays invalid', () => {
  const a = geometry();
  const b = geometry(1, { lipThickness: 2 });
  const excluded = compareAdjusted(a, b, 0, 1);
  for (const q of [undefined, null, NaN, Infinity, -0.1, 1.1, '1', {}, true]) {
    assert.deepEqual(compareAdjusted(a, b, q, 1), excluded);
    assert.deepEqual(compareAdjusted(a, b, 1, q), excluded);
  }
  const malformed = geometry();
  delete malformed.metrics.lipThickness;
  for (const invalid of [null, { valid: false }, malformed, geometry(1, { noseWidth: NaN })]) {
    const result = compareAdjusted(a, invalid, 0, 0);
    assert.equal(result.valid, false);
    for (const key of ['score', 'meanDifference', 'baselineScore', 'delta', 'coverage', 'lipEffectiveWeight']) assert.equal(result[key], null);
    assert.ok(result.errors.length);
  }
});

test('aggregation preserves all original pair indices and matrix cells despite missing reliability', () => {
  const malformed = geometry();
  delete malformed.metrics.lipThickness;
  const as = [geometry(), malformed, geometry(2)];
  const bs = [null, geometry(), geometry(4)];
  const result = aggregateAdjusted(as, bs);
  assert.deepEqual(result.validPhotoCounts, { a: 2, b: 2 });
  assert.deepEqual(result.excluded, { a: [1], b: [0] });
  assert.deepEqual(result.pairs.map(({ aIndex, bIndex }) => [aIndex, bIndex]), [[0, 1], [0, 2], [2, 1], [2, 2]]);
  assert.deepEqual(result.pairMatrix.map((row) => row.map((value) => value === null)), [[true, false, false], [true, true, true], [true, false, false]]);
  assert.equal(result.pairScores.length, 4);
  close(result.minCoverage, 0.9);
  close(result.maxCoverage, 0.9);
  assert.equal(result.medianLipEffectiveWeight, 0);
});

test('all-pair score statistics use R7 interpolation and full reliability equals baseline', () => {
  const as = [geometry(), geometry(2)];
  const bs = [geometry(), geometry(4)];
  const result = aggregateAdjusted(as, bs, [1, 1], [1, 1]);
  const baseline = aggregateComparisons(as, bs);
  assert.deepEqual(result.pairMatrix, baseline.pairMatrix);
  assert.deepEqual(result.pairScores, baseline.pairScores);
  const low = 100 * Math.exp(-6);
  const middle = 100 * Math.exp(-(2 / 3) / 0.2);
  close(result.min, low);
  assert.equal(result.max, 100);
  close(result.median, middle);
  close(result.q1, low + 0.75 * (middle - low));
  close(result.q3, middle + 0.25 * (100 - middle));
  close(result.iqr, result.q3 - result.q1);
  close(result.medianDifference, 2 / 3);
  assert.equal(result.medianCoverage, 1);
});

test('coverage summaries reflect every pair; empty aggregates retain unknown statistics', () => {
  const result = aggregateAdjusted([geometry(), geometry()], [geometry(), geometry()], [1, 0.5], [1, 0]);
  close(result.medianCoverage, 0.925);
  close(result.minCoverage, 0.9);
  close(result.maxCoverage, 1);
  close(result.medianLipEffectiveWeight, (0 + 0.05 / 0.95) / 2);
  const empty = aggregateAdjusted([], [geometry()]);
  assert.equal(empty.valid, false);
  for (const key of ['median', 'min', 'max', 'q1', 'q3', 'iqr', 'medianDifference', 'medianCoverage', 'minCoverage', 'maxCoverage', 'medianLipEffectiveWeight']) assert.equal(empty[key], null);
  assert.deepEqual(empty.pairs, []);
  assert.ok(empty.errors.length);
});

test('within-group comparisons count each unique pair once and omit self pairs and invalid geometry', () => {
  const result = withinGroupAdjusted([geometry(), { valid: false }, geometry(2), geometry(4)], [1, 1, 1, 1]);
  assert.equal(result.count, 3);
  close(result.medianScore, 100 * Math.exp(-(2 / 3) / 0.2));
  close(result.medianDifference, 2 / 3);
  assert.ok(result.max < 100);
  assert.equal(result.medianCoverage, 1);
  assert.deepEqual(withinGroupAdjusted([geometry()], [1]), {
    count: 0, medianScore: null, medianDifference: null, min: null, max: null, medianCoverage: null,
  });
});

test('lip reference applies fixed eligibility and a reliability-weighted median', () => {
  assert.equal(LIP_REFERENCE_MIN_RELIABILITY, 0.5);
  const photos = [geometry(1), geometry(3), geometry(9), geometry(100), { valid: false }];
  const qs = [0.5, 1, 0.5, 0.49, 1];
  const before = structuredClone([photos, qs]);
  assert.deepEqual(summarizeLipReference(photos, qs), { value: 3, count: 3, totalCount: 5, weightSum: 2 });
  assert.deepEqual([photos, qs], before);
  // Exact half uses the adjacent midpoint; otherwise the heavier first value
  // wins even though the unweighted median of the three photos would be 3.
  assert.equal(summarizeLipReference([geometry(1), geometry(3), geometry(9)], [1, 0.5, 0.5]).value, 2);
  assert.equal(summarizeLipReference([geometry(1), geometry(3), geometry(9)], [1, 0.5, 0.49]).value, 1);
  assert.equal(summarizeLipReference([geometry(1), geometry(3)], [0.5, 0.5]).value, 2);
});

test('no eligible reference remains unknown, including invalid geometry and missing reliability', () => {
  assert.deepEqual(summarizeLipReference([geometry(), { valid: false }], [0.49, 1]), {
    value: null, count: 0, totalCount: 2, weightSum: 0,
  });
  assert.deepEqual(summarizeLipReference([geometry()]), { value: null, count: 0, totalCount: 1, weightSum: 0 });
  assert.deepEqual(summarizeLipReference(null), { value: null, count: 0, totalCount: 0, weightSum: 0 });
  // Zero is a possible raw measurement and remains distinct from an unknown reference.
  assert.equal(summarizeLipReference([geometry(1, { lipThickness: 0 })], [1]).value, 0);
});
