import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_DEFINITIONS, compareGeometry } from '../src/geometry.js';
import { comparisonDiagnostics, withinGroup } from '../src/diagnostics.js';

const geometry = (overrides = {}) => ({ valid: true, metrics: { ...Object.fromEntries(FEATURE_DEFINITIONS.map((f) => [f.id, 1])), ...overrides } });

test('within-group variability uses unique unordered pairs and excludes invalid photos', () => {
  assert.equal(withinGroup([geometry()]).count, 0);
  assert.equal(withinGroup([geometry()]).medianScore, null);
  const summary = withinGroup([geometry(), geometry(), geometry({ eyeWidth: 2 }), null]);
  assert.equal(summary.count, 3);
  assert.equal(summary.max, 100);
  assert.ok(summary.medianDifference > 0);
});

test('feature contributions exactly partition mean weighted difference, not an attribution model', () => {
  const a = geometry();
  const b = geometry({ eyeWidth: 2, noseWidth: 1.5 });
  const report = comparisonDiagnostics([a], [b]);
  assert.ok(Math.abs(report.meanDifference - compareGeometry(a, b).meanDifference) < 1e-12);
  assert.ok(Math.abs(report.contributions.reduce((s, f) => s + f.share, 0) - 1) < 1e-12);
  assert.equal(report.contributions[0].id, 'eyeWidth');
  assert.equal(report.within.a.medianScore, null);
});

test('zero difference and empty comparisons do not invent sensitivity estimates', () => {
  const report = comparisonDiagnostics([geometry()], [geometry()]);
  assert.equal(report.medianDifference, 0);
  assert.ok(report.contributions.every((f) => f.share === 0));
  assert.equal(comparisonDiagnostics([], [geometry()]), null);
});
