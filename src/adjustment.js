/**
 * Optional expression-aware weighting layered on the unmodified geometry score.
 * Only lipThickness loses weight. Remaining weights are normalized globally, so
 * excluded lip evidence does not transfer solely to the other mouth metric.
 * Reliability is an advisory scalar, not calibrated measurement confidence.
 */
import { compareGeometry, FEATURE_DEFINITIONS, SCORE_SCALE } from './geometry.js';

export const LIP_REFERENCE_MIN_RELIABILITY = 0.5;
const originalWeight = FEATURE_DEFINITIONS.reduce((sum, feature) => sum + feature.weight, 0);
const reliability = (value) => Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
const asArray = (value) => Array.isArray(value) ? value : [];
const isGeometry = (geometry) => compareGeometry(geometry, geometry).valid;

// R-7 interpolation, identical to the original photo-pair summary convention.
function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

/** Keep raw measurements and baseline scores intact; q=0 still compares the
 * other twelve features. Incomplete geometry is never rescued by reweighting.
 * delta is signed: removing a comparatively close lip ratio can lower the score.
 */
export function compareAdjusted(a, b, reliabilityA, reliabilityB) {
  const baseline = compareGeometry(a, b);
  if (!baseline.valid) return {
    valid: false, score: null, meanDifference: null, baselineScore: null,
    delta: null, coverage: null, lipReliability: null, lipEffectiveWeight: null,
    metrics: {}, errors: [...baseline.errors],
  };
  const lipReliability = Math.min(reliability(reliabilityA), reliability(reliabilityB));
  const retainedWeights = FEATURE_DEFINITIONS.map((feature) =>
    feature.weight * (feature.id === 'lipThickness' ? lipReliability : 1));
  const retainedWeight = retainedWeights.reduce((sum, weight) => sum + weight, 0);
  const metrics = Object.fromEntries(FEATURE_DEFINITIONS.map((feature, index) => {
    const raw = baseline.metrics[feature.id];
    const effectiveWeight = retainedWeights[index] / retainedWeight;
    return [feature.id, {
      ...raw, baseWeight: feature.weight, retainedWeight: retainedWeights[index],
      effectiveWeight, contribution: effectiveWeight * raw.difference,
    }];
  }));
  // Preserve the original scalar values exactly at full reliability, including
  // the baseline's group-first floating-point evaluation order.
  const meanDifference = lipReliability === 1 ? baseline.meanDifference
    : Object.values(metrics).reduce((sum, metric) => sum + metric.contribution, 0);
  const score = lipReliability === 1 ? baseline.score
    : 100 * Math.exp(-meanDifference / SCORE_SCALE);
  return {
    valid: true, score, meanDifference, baselineScore: baseline.score,
    delta: score - baseline.score, coverage: retainedWeight / originalWeight,
    lipReliability, lipEffectiveWeight: metrics.lipThickness.effectiveWeight,
    metrics, errors: [],
  };
}

/** All valid A×B pairs remain present regardless of lip reliability. Matrix
 * cells retain original photo indices; null cells represent invalid geometry.
 */
export function aggregateAdjusted(geometriesA, geometriesB, reliabilitiesA, reliabilitiesB) {
  const as = asArray(geometriesA);
  const bs = asArray(geometriesB);
  const qsA = asArray(reliabilitiesA);
  const qsB = asArray(reliabilitiesB);
  const pairs = [];
  const pairMatrix = as.map((a, aIndex) => bs.map((b, bIndex) => {
    const comparison = compareAdjusted(a, b, qsA[aIndex], qsB[bIndex]);
    if (!comparison.valid) return null;
    pairs.push({ aIndex, bIndex, ...comparison });
    return comparison.score;
  }));
  const pairScores = pairs.map((pair) => pair.score);
  const coverages = pairs.map((pair) => pair.coverage);
  const q1 = quantile(pairScores, 0.25);
  const q3 = quantile(pairScores, 0.75);
  const minimum = (values) => values.length ? values.reduce((a, b) => Math.min(a, b), Infinity) : null;
  const maximum = (values) => values.length ? values.reduce((a, b) => Math.max(a, b), -Infinity) : null;
  const validAs = as.map(isGeometry);
  const validBs = bs.map(isGeometry);
  return {
    valid: pairs.length > 0, pairs, pairMatrix, pairScores,
    median: quantile(pairScores, 0.5), min: minimum(pairScores), max: maximum(pairScores),
    q1, q3, iqr: pairs.length ? q3 - q1 : null,
    medianDifference: quantile(pairs.map((pair) => pair.meanDifference), 0.5),
    medianCoverage: quantile(coverages, 0.5), minCoverage: minimum(coverages), maxCoverage: maximum(coverages),
    medianLipEffectiveWeight: quantile(pairs.map((pair) => pair.lipEffectiveWeight), 0.5),
    validPhotoCounts: { a: validAs.filter(Boolean).length, b: validBs.filter(Boolean).length },
    excluded: {
      a: validAs.flatMap((valid, index) => valid ? [] : [index]),
      b: validBs.flatMap((valid, index) => valid ? [] : [index]),
    },
    errors: pairs.length ? [] : ['没有可比较的有效照片组合。'],
  };
}

/** Descriptive within-person photo sensitivity; unique i<j pairs only. */
export function withinGroupAdjusted(geometries, reliabilities) {
  const photos = asArray(geometries);
  const qs = asArray(reliabilities);
  const pairs = [];
  for (let i = 0; i < photos.length; i += 1) {
    for (let j = i + 1; j < photos.length; j += 1) {
      const comparison = compareAdjusted(photos[i], photos[j], qs[i], qs[j]);
      if (comparison.valid) pairs.push(comparison);
    }
  }
  const scores = pairs.map((pair) => pair.score);
  return {
    count: pairs.length, medianScore: quantile(scores, 0.5),
    medianDifference: quantile(pairs.map((pair) => pair.meanDifference), 0.5),
    min: scores.length ? scores.reduce((a, b) => Math.min(a, b), Infinity) : null,
    max: scores.length ? scores.reduce((a, b) => Math.max(a, b), -Infinity) : null,
    medianCoverage: quantile(pairs.map((pair) => pair.coverage), 0.5),
  };
}

/** Descriptive lip reference from valid photos with q>=0.5, weighted by q.
 * It NEVER replaces a raw lip measurement in pair scoring. totalCount includes
 * all supplied photos; count includes only eligible photos. No eligible photos
 * means an unknown (null) reference, never a zero-thickness measurement.
 */
export function summarizeLipReference(geometries, reliabilities) {
  const photos = asArray(geometries);
  const qs = asArray(reliabilities);
  const eligible = photos.flatMap((geometry, index) => {
    const q = reliability(qs[index]);
    return q >= LIP_REFERENCE_MIN_RELIABILITY && isGeometry(geometry) ? [{ value: geometry.metrics.lipThickness, q }] : [];
  }).sort((a, b) => a.value - b.value);
  const weightSum = eligible.reduce((sum, photo) => sum + photo.q, 0);
  let value = null;
  let cumulative = 0;
  for (let index = 0; index < eligible.length; index += 1) {
    cumulative += eligible[index].q;
    if (cumulative >= weightSum / 2) {
      value = cumulative === weightSum / 2 && index + 1 < eligible.length
        ? (eligible[index].value + eligible[index + 1].value) / 2 : eligible[index].value;
      break;
    }
  }
  return { value, count: eligible.length, totalCount: photos.length, weightSum };
}
