import { FEATURE_DEFINITIONS, compareGeometry, aggregateComparisons } from './geometry.js';

const median = (items) => {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Descriptive variability only. No identity check or human-rating calibration. */
export function withinGroup(geometries) {
  const pairs = [];
  for (let i = 0; i < geometries.length; i++) {
    for (let j = i + 1; j < geometries.length; j++) {
      const pair = compareGeometry(geometries[i], geometries[j]);
      if (pair.valid) pairs.push(pair);
    }
  }
  return {
    count: pairs.length,
    medianScore: median(pairs.map((p) => p.score)),
    medianDifference: median(pairs.map((p) => p.meanDifference)),
    min: pairs.length ? Math.min(...pairs.map((p) => p.score)) : null,
    max: pairs.length ? Math.max(...pairs.map((p) => p.score)) : null,
  };
}

export function comparisonDiagnostics(a, b, aggregate = aggregateComparisons(a, b)) {
  if (!aggregate.valid) return null;
  const pairs = aggregate.pairs;
  const contributions = FEATURE_DEFINITIONS.map((feature) => ({
    id: feature.id, label: feature.label, group: feature.group,
    meanDifference: pairs.reduce((sum, pair) => sum + pair.metrics[feature.id].difference, 0) / pairs.length,
    contribution: pairs.reduce((sum, pair) => sum + pair.metrics[feature.id].difference * feature.weight, 0) / pairs.length,
  }));
  const meanDifference = contributions.reduce((sum, feature) => sum + feature.contribution, 0);
  for (const feature of contributions) feature.share = meanDifference > 0 ? feature.contribution / meanDifference : 0;
  contributions.sort((a, b) => b.contribution - a.contribution);
  return {
    medianDifference: median(pairs.map((pair) => pair.meanDifference)),
    meanDifference, contributions,
    within: { a: withinGroup(a), b: withinGroup(b) },
  };
}
