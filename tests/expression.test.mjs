import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPRESSION_POLICY, LIP_SIGNAL_DEFINITIONS, analyzeLipReliability } from '../src/expression.js';

// Deterministic software contract fixtures, not photographs or model runs.
const signals = (overrides = {}) => LIP_SIGNAL_DEFINITIONS.map(({ id }) => ({ categoryName: id, score: overrides[id] ?? 0 }));
const quality = (overrides = {}, warnings = []) => ({ valid: true, warnings, measurements: { faceWidthPixels: 200, yawProxy: 0, eyeWidthImbalance: 1, ...overrides } });
const analyze = (overrides = {}, q = quality(), mode = 'auto') => analyzeLipReliability(signals(overrides), q, mode);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('policy is versioned, deeply frozen, serializable and explicitly heuristic', () => {
  assert.equal(EXPRESSION_POLICY.version, 'lip-reliability-v1');
  assert.match(EXPRESSION_POLICY.interpretation, /untrained and uncalibrated/);
  assert.deepEqual(JSON.parse(JSON.stringify(EXPRESSION_POLICY)), EXPRESSION_POLICY);
  assert.ok(Object.isFrozen(EXPRESSION_POLICY));
  assert.ok(Object.isFrozen(EXPRESSION_POLICY.expression));
  assert.ok(Object.isFrozen(EXPRESSION_POLICY.requiredSignals));
  assert.equal(EXPRESSION_POLICY.requiredSignals.length, 11);
  assert.equal(EXPRESSION_POLICY.pressRollSignals.length, 4);
  assert.ok(!EXPRESSION_POLICY.requiredSignals.includes('mouthClose'));
  assert.ok(Object.isFrozen(LIP_SIGNAL_DEFINITIONS[0]));
});

test('complete neutral signals and adequate quality yield reliability one', () => {
  const result = analyze();
  assert.equal(result.known, true);
  assert.equal(result.autoReliability, 1);
  assert.equal(result.reliability, 1);
  assert.equal(result.level, 'usable');
  assert.equal(result.suspectedPress, false);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(analyzeLipReliability({ categories: signals() }, quality()), result);
});

test('press and roll reduce reliability monotonically and exclude at the endpoint', () => {
  for (const name of EXPRESSION_POLICY.pressRollSignals) {
    let previous = Infinity;
    for (const value of [0, 0.19, 0.2, 0.3, 0.45, 0.6, 0.7, 1]) {
      const result = analyze({ [name]: value });
      assert.ok(result.reliability <= previous);
      previous = result.reliability;
      assert.equal(result.suspectedPress, value >= 0.2);
      if (value > 0.2 && value < 0.7) assert.equal(result.level, 'reduced');
      if (value >= 0.7) assert.equal(result.level, 'excluded');
    }
  }
  close(analyze({ mouthPressLeft: 0.45 }).expressionReliability, 0.5);
  assert.equal(analyze({ mouthPressLeft: 0.8 }).press, 0.8);
  assert.equal(analyze({ mouthRollLower: 0.8 }).roll, 0.8);
  assert.ok(analyze({ mouthPressRight: 0.8 }).reasons.some(({ code }) => code === 'press'));
  assert.ok(analyze({ mouthRollUpper: 0.8 }).reasons.some(({ code }) => code === 'roll'));
});

test('mouthClose is optional/display-only; other interference does not imply pressing', () => {
  const closed = analyze({ mouthClose: 1 });
  assert.equal(closed.signals.mouthClose, 1);
  assert.equal(closed.reliability, 1);
  assert.equal(closed.expressionSeverity, 0);
  const noMouthClose = signals().filter(({ categoryName }) => categoryName !== 'mouthClose');
  assert.equal(analyzeLipReliability(noMouthClose, quality()).reliability, 1);
  for (const name of EXPRESSION_POLICY.otherExpressionSignals) {
    const result = analyze({ [name]: 0.45 });
    close(result.reliability, 0.5);
    assert.equal(result.suspectedPress, false);
    assert.ok(result.reasons.some(({ code }) => code === 'other-expression'));
    assert.ok(!result.reasons.some(({ code }) => ['press', 'roll'].includes(code)));
  }
});

test('quality factors remain distinct from press/roll and combine by minimum', () => {
  for (const [q, reason] of [
    [quality({ faceWidthPixels: 100 }), 'quality-small'],
    [quality({ yawProxy: 0.21 }), 'quality-pose'],
    [quality({ eyeWidthImbalance: 1.675 }), 'quality-pose'],
    [quality({}, [{ code: 'clipped' }]), 'quality-clipped'],
  ]) {
    const result = analyze({}, q);
    assert.equal(result.expressionReliability, 1);
    assert.equal(result.suspectedPress, false);
    assert.ok(result.reliability > 0 && result.reliability < 1);
    assert.ok(result.reasons.some(({ code }) => code === reason));
    assert.ok(!result.reasons.some(({ code }) => ['press', 'roll'].includes(code)));
  }
  const combined = analyze({ mouthPressLeft: 0.45 }, quality({ faceWidthPixels: 100, yawProxy: 0.21 }, [{ code: 'clipped' }]));
  close(combined.qualityReliability, 0.25);
  close(combined.autoReliability, 0.125);
  assert.equal(analyze({}, quality({ faceWidthPixels: 60 })).reliability, 0);
  assert.equal(analyze({}, quality({ yawProxy: 0.30 })).reliability, 0);
  assert.equal(analyze({}, quality({ eyeWidthImbalance: 2 })).reliability, 0);
});

test('every missing or invalid interference coefficient is unknown, never neutral or clamped', () => {
  for (const name of EXPRESSION_POLICY.requiredSignals) {
    const missing = signals().filter(({ categoryName }) => categoryName !== name);
    for (const input of [missing, ...[NaN, Infinity, -0.1, 1.1, '0.5', null].map((score) => [...missing, { categoryName: name, score }])]) {
      const result = analyzeLipReliability(input, quality());
      assert.equal(result.known, false);
      assert.equal(result.signals[name], null);
      assert.equal(result.expressionSeverity, null);
      assert.equal(result.expressionReliability, null);
      assert.equal(result.autoReliability, 0);
      assert.equal(result.level, 'unknown');
      assert.equal(result.suspectedPress, false);
    }
  }
  for (const input of [undefined, null, {}, { categories: {} }, [null]]) {
    assert.equal(analyzeLipReliability(input, quality()).level, 'unknown');
  }
  const onlyCore = signals().filter(({ categoryName }) => EXPRESSION_POLICY.pressRollSignals.includes(categoryName));
  assert.equal(analyzeLipReliability(onlyCore, quality()).reliability, 0);
  assert.equal(analyzeLipReliability(onlyCore, quality()).level, 'unknown');
  assert.equal(analyzeLipReliability(onlyCore, quality()).otherExpression, null);
  const invalidJaw = signals().map((value) => value.categoryName === 'jawOpen' ? { ...value, score: 2 } : value);
  assert.equal(analyzeLipReliability(invalidJaw, quality()).signals.jawOpen, null);
  assert.equal(analyzeLipReliability(invalidJaw, quality()).reliability, 0);
  assert.equal(analyzeLipReliability(invalidJaw, quality()).level, 'unknown');
});

test('missing other interference preserves available core press/roll diagnostics', () => {
  for (const missingName of EXPRESSION_POLICY.otherExpressionSignals) {
    const input = signals({ mouthPressRight: 0.8, mouthRollUpper: 0.4 }).filter(({ categoryName }) => categoryName !== missingName);
    const result = analyzeLipReliability(input, quality());
    assert.equal(result.known, false);
    assert.equal(result.press, 0.8);
    assert.equal(result.roll, 0.4);
    assert.equal(result.suspectedPress, true);
    assert.equal(result.expressionSeverity, null);
    assert.equal(result.expressionReliability, null);
    assert.equal(result.autoReliability, 0);
    assert.equal(result.level, 'unknown');
    for (const code of ['missing-signals', 'press', 'roll']) assert.ok(result.reasons.some((reason) => reason.code === code));
  }
});

test('missing or invalid quality is unknown even with complete neutral interference signals', () => {
  for (const q of [undefined, null, {}, { ...quality(), valid: false }, { ...quality(), warnings: undefined },
    ...[NaN, Infinity, 0, -1, '100'].map((faceWidthPixels) => quality({ faceWidthPixels })),
    ...[NaN, -0.1, '0'].map((yawProxy) => quality({ yawProxy })),
    ...[NaN, 0.9, '1'].map((eyeWidthImbalance) => quality({ eyeWidthImbalance })),
  ]) {
    const result = analyzeLipReliability(signals(), q);
    assert.equal(result.known, false);
    assert.equal(result.qualityReliability, null);
    assert.equal(result.reliability, 0);
    assert.equal(result.level, 'unknown');
    assert.ok(result.reasons.some(({ code }) => code === 'invalid-quality'));
  }
  const coreMissing = signals().filter(({ categoryName }) => categoryName !== 'mouthRollLower');
  assert.equal(analyzeLipReliability(coreMissing, quality()).qualityReliability, 1);
});

test('manual overrides retain automatic diagnostics, including unknown data', () => {
  for (const input of [signals({ mouthPressLeft: 0.8 }), signals({ mouthPressLeft: 0.8 }).filter(({ categoryName }) => categoryName !== 'jawOpen'), undefined]) {
    const automatic = analyzeLipReliability(input, quality());
    for (const [mode, reliability] of [['include', 1], ['exclude', 0]]) {
      const manual = analyzeLipReliability(input, quality(), mode);
      assert.equal(manual.reliability, reliability);
      for (const key of ['known', 'signals', 'press', 'roll', 'otherExpression', 'expressionSeverity', 'expressionReliability', 'qualityReliability', 'autoReliability', 'level', 'suspectedPress', 'factors']) {
        assert.deepEqual(manual[key], automatic[key]);
      }
      assert.deepEqual(manual.reasons.slice(0, -1), automatic.reasons);
      assert.equal(manual.reasons.at(-1).code, `manual-${mode}`);
    }
  }
  assert.deepEqual(analyze({}, quality(), 'invalid'), analyze());
});

test('analysis is pure and has no dependence on geometry or resemblance', () => {
  const input = { categories: signals({ mouthPressLeft: 0.4 }) };
  const q = quality({ faceWidthPixels: 110 });
  const beforeInput = structuredClone(input);
  const beforeQuality = structuredClone(q);
  const first = analyzeLipReliability(input, q);
  assert.deepEqual(analyzeLipReliability(input, q), first);
  assert.deepEqual(input, beforeInput);
  assert.deepEqual(q, beforeQuality);
  assert.deepEqual(analyzeLipReliability(input, { ...q, metrics: { lipThickness: 0 }, score: 100 }), first);
  first.signals.mouthPressLeft = 1;
  first.factors.size = 0;
  assert.deepEqual(analyzeLipReliability(input, q).signals, analyzeLipReliability(beforeInput, beforeQuality).signals);
});
