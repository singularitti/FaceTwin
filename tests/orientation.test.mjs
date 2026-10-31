import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORIENTATION_POLICY, FACE_OVAL_INDICES, estimateEyeRoll, planUprightCrop,
  mapUprightLandmarks, assessUprightAgreement,
} from '../src/orientation.js';

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

// Analytic coordinate fixtures only; no photos, inference, or accuracy claims.
function rectangle({ degrees = 0, width = 800, height = 600, centerX = 400, centerY = 300, size = 1 } = {}) {
  const angle = degrees * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const at = (x, y) => ({ x: (centerX + size * (cos * x - sin * y)) / width, y: (centerY + size * (sin * x + cos * y)) / height, z: -0.02 });
  const corners = [[-100, -140], [100, -140], [-100, 140], [100, 140]];
  const points = Array.from({ length: 478 }, (_, index) => at(...corners[index % corners.length]));
  points[33] = at(-60, -40);
  points[263] = at(60, -40);
  points[1] = at(0, 0);
  points[61] = at(-30, 50);
  points[291] = at(30, 50);
  return points;
}

test('policy and standard 36-point face oval are explicit and frozen', () => {
  assert.deepEqual(ORIENTATION_POLICY, { version: 'upright-refinement-v1', minRollDegrees: 12, padding: 0.18, maxEdge: 1600, anchorMeanLimit: 0.12, anchorMaxLimit: 0.25, contourMeanLimit: 0.20, contourMaxLimit: 0.40 });
  assert.equal(Object.isFrozen(ORIENTATION_POLICY), true);
  assert.equal(Object.isFrozen(FACE_OVAL_INDICES), true);
  assert.equal(FACE_OVAL_INDICES.length, 36);
  assert.equal(new Set(FACE_OVAL_INDICES).size, 36);
  assert.deepEqual(FACE_OVAL_INDICES, [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]);
});

test('roll uses source pixel aspect ratio and normalizes the eye line modulo pi', () => {
  for (const [degrees, expected] of [[0, 0], [30, 30], [90, 90], [-90, -90], [120, -60], [-150, 30], [180, 0]]) {
    close(estimateEyeRoll(rectangle({ degrees, width: 2000, height: 500 }), 2000, 500), expected * Math.PI / 180);
  }
  const points = rectangle({ degrees: 30 });
  [points[33], points[263]] = [points[263], points[33]];
  close(estimateEyeRoll(points, 800, 600), Math.PI / 6);
});

test('analytic 90-degree crop maps source vertical eye line to target horizontal', () => {
  const points = rectangle({ degrees: 90 });
  const plan = planUprightCrop(points, 800, 600);
  close(plan.rotationRadians, Math.PI / 2);
  close(plan.rollDegrees, 90);
  close(plan.centerX, 400);
  close(plan.centerY, 300);
  close(plan.sourceSize, 280 * 1.36);
  assert.equal(plan.targetSize, 381);
  assert.equal(plan.paddedOutside, false);
  close(plan.transform.a, 0);
  close(plan.transform.b, -381 / 380.8);
  close(plan.transform.c, 381 / 380.8);
  close(plan.transform.d, 0);
  const [mapped] = mapUprightLandmarks([{ x: 0.75, y: 0.5, z: -0.2, visibility: 0.9 }], plan, 800, 600);
  close(mapped.x, 400 / 800);
  close(mapped.y, (300 + 380.8 / 4) / 600);
  close(mapped.z, -0.2 * 380.8 / 800);
  assert.equal(mapped.visibility, 0.9);
});

test('analytic 30-degree inverse respects nonsquare dimensions and width-scaled z', () => {
  const points = rectangle({ degrees: 30, width: 1800, height: 700, centerX: 900, centerY: 350 });
  const plan = planUprightCrop(points, 1800, 700);
  close(plan.centerX, 900);
  close(plan.centerY, 350);
  close(plan.sourceSize, 380.8);
  const [point] = mapUprightLandmarks([{ x: 0.75, y: 0.25, z: 0.1, presence: 0.8 }], plan, 1800, 700);
  // Target displacement (S/4,-S/4) becomes a 30-degree source rotation.
  const offset = 380.8 / 4;
  close(point.x, (900 + offset * (Math.sqrt(3) / 2 + 0.5)) / 1800);
  close(point.y, (350 + offset * (0.5 - Math.sqrt(3) / 2)) / 700);
  close(point.z, 0.1 * 380.8 / 1800);
  assert.equal(point.presence, 0.8);
});

test('affine matrix and inverse roundtrip all landmarks, including iris points', () => {
  for (const degrees of [-60, 0, 30, 90]) {
    const width = 2200;
    const height = 900;
    const original = rectangle({ degrees, width, height, centerX: 1100, centerY: 450 });
    const plan = planUprightCrop(original, width, height);
    const { a, b, c, d, e, f } = plan.transform;
    const target = original.map((point) => ({
      ...point,
      x: (a * point.x * width + c * point.y * height + e) / plan.targetSize,
      y: (b * point.x * width + d * point.y * height + f) / plan.targetSize,
      z: point.z * width / plan.sourceSize,
    }));
    const restored = mapUprightLandmarks(target, plan, width, height);
    assert.equal(restored.length, 478);
    for (let index = 0; index < original.length; index += 1) {
      close(restored[index].x, original[index].x);
      close(restored[index].y, original[index].y);
      close(restored[index].z, original[index].z);
    }
    close(target[33].y, target[263].y);
    assert.ok(target.slice(0, 468).every((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1));
  }
});

test('padding preserves the entire square ROI beyond image edges without clamping', () => {
  const central = planUprightCrop(rectangle(), 800, 600);
  for (const [centerX, centerY] of [[20, 20], [780, 20], [20, 580], [780, 580]]) {
    const plan = planUprightCrop(rectangle({ centerX, centerY, degrees: 30 }), 800, 600);
    assert.equal(plan.paddedOutside, true);
    close(plan.centerX, centerX);
    close(plan.centerY, centerY);
    close(plan.sourceSize, central.sourceSize);
    const corners = mapUprightLandmarks([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 }, { x: 1, y: 1 }], plan, 800, 600);
    assert.ok(corners.some((point) => point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1));
  }
});

test('crop target caps sampling edge and retains original pixel source size', () => {
  const plan = planUprightCrop(rectangle({ width: 8000, height: 6000, centerX: 4000, centerY: 3000, size: 10 }), 8000, 6000);
  close(plan.sourceSize, 3808);
  assert.equal(plan.targetSize, 1600);
  close(plan.samplingScale, 1600 / 3808);
  const tiny = planUprightCrop(rectangle({ size: 0.001 }), 800, 600);
  close(tiny.sourceSize, 0.3808);
  assert.equal(tiny.targetSize, 1);
  close(tiny.samplingScale, 1 / tiny.sourceSize);
});

test('invalid dimensions, meshes, overflowing coordinates and degenerate eyes return null', () => {
  const valid = rectangle();
  for (const [width, height] of [[0, 600], [-1, 600], [800, NaN], [Infinity, 600]]) {
    assert.equal(estimateEyeRoll(valid, width, height), null);
    assert.equal(planUprightCrop(valid, width, height), null);
  }
  const nan = structuredClone(valid);
  nan[200].x = NaN;
  const coincident = structuredClone(valid);
  coincident[263] = { ...coincident[33] };
  const overflow = structuredClone(valid);
  overflow[0].x = Number.MAX_VALUE;
  for (const points of [null, [], valid.slice(0, 467), nan, coincident, overflow]) {
    assert.equal(estimateEyeRoll(points, 800, 600), null);
    assert.equal(planUprightCrop(points, 800, 600), null);
  }
  // Invalid optional iris points do not poison the required 468-point mesh.
  valid[477] = null;
  assert.ok(planUprightCrop(valid, 800, 600));
});

test('inverse mapping rejects invalid plans/points without mutating inputs', () => {
  const plan = planUprightCrop(rectangle(), 800, 600);
  for (const broken of [null, {}, { ...plan, sourceSize: 0 }, { ...plan, targetSize: 1.5 }, { ...plan, transform: { ...plan.transform, a: NaN } }, { ...plan, transform: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 } }]) {
    assert.throws(() => mapUprightLandmarks([{ x: 0.5, y: 0.5 }], broken, 800, 600), TypeError);
  }
  for (const points of [null, [null], Array(1), [{ x: Infinity, y: 0 }], [{ x: 0, y: 0, z: NaN }]]) assert.throws(() => mapUprightLandmarks(points, plan, 800, 600), TypeError);
  assert.throws(() => mapUprightLandmarks([], plan, 0, 600), TypeError);
  const points = [{ x: 0.5, y: 0.5, visibility: 0.7 }];
  const before = structuredClone({ points, plan });
  const mapped = mapUprightLandmarks(points, plan, 800, 600);
  assert.equal('z' in mapped[0], false);
  assert.deepEqual({ points, plan }, before);
  assert.notEqual(mapped[0], points[0]);
});

test('identical and slightly shifted meshes pass consistency gates in original pixels', () => {
  const original = rectangle();
  const stable = assessUprightAgreement(original, original, 800, 600);
  assert.deepEqual(stable, { comparable: true, recommended: true, anchorMeanFraction: 0, anchorMaxFraction: 0, contourMeanFraction: 0, contourMaxFraction: 0, reason: 'stable' });
  const shifted = original.map((point) => ({ ...point, x: point.x + 6 / 800 }));
  const result = assessUprightAgreement(original, shifted, 800, 600);
  assert.equal(result.recommended, true);
  close(result.anchorMeanFraction, 0.05);
  close(result.anchorMaxFraction, 0.05);
  close(result.contourMeanFraction, 0.05);
  close(result.contourMaxFraction, 0.05);
});

test('anchor mean/max limits reject translation and a single drifting anchor', () => {
  const original = rectangle();
  const translated = original.map((point) => ({ ...point, x: point.x + 15 / 800 }));
  let result = assessUprightAgreement(original, translated, 800, 600);
  assert.equal(result.comparable, false);
  assert.equal(result.recommended, false);
  assert.equal(result.reason, 'anchor-disagreement');
  close(result.anchorMeanFraction, 0.125);
  const one = structuredClone(original);
  one[1].x += 31 / 800;
  result = assessUprightAgreement(original, one, 800, 600);
  assert.ok(result.anchorMeanFraction < 0.12);
  assert.ok(result.anchorMaxFraction > 0.25);
  assert.equal(result.comparable, false);
});

test('contour-only mean/max disagreement preserves comparable anchors but blocks recommendation', () => {
  const original = rectangle();
  const drifted = structuredClone(original);
  for (const index of FACE_OVAL_INDICES) drifted[index].y += 25 / 600;
  let result = assessUprightAgreement(original, drifted, 800, 600);
  assert.equal(result.comparable, true);
  assert.equal(result.recommended, false);
  assert.equal(result.reason, 'contour-disagreement');
  close(result.contourMeanFraction, 25 / 120);
  const one = structuredClone(original);
  one[FACE_OVAL_INDICES[0]].y += 49 / 600;
  result = assessUprightAgreement(original, one, 800, 600);
  assert.ok(result.contourMeanFraction < 0.2);
  assert.ok(result.contourMaxFraction > 0.4);
  assert.equal(result.comparable, true);
  assert.equal(result.recommended, false);
});

test('agreement uses the smaller eye span and rejects invalid or <=2px spans', () => {
  const original = rectangle();
  const smaller = structuredClone(original);
  smaller[263].x = smaller[33].x + 80 / 800;
  const comparison = assessUprightAgreement(original, smaller, 800, 600);
  close(comparison.anchorMaxFraction, 40 / 80);
  const invalid = { comparable: false, recommended: false, anchorMeanFraction: null, anchorMaxFraction: null, contourMeanFraction: null, contourMaxFraction: null, reason: 'invalid' };
  const short = structuredClone(original);
  short[263] = { ...short[33], x: short[33].x + 2 / 800 };
  const bad = structuredClone(original);
  bad[467].y = Infinity;
  for (const points of [null, [], short, bad]) assert.deepEqual(assessUprightAgreement(original, points, 800, 600), invalid);
  assert.deepEqual(assessUprightAgreement(original, original, 800, 0), invalid);
});

test('roll, planning, and agreement leave input meshes unchanged', () => {
  const points = rectangle({ degrees: 30 });
  const candidate = structuredClone(points);
  const before = structuredClone({ points, candidate });
  estimateEyeRoll(points, 800, 600);
  planUprightCrop(points, 800, 600);
  assessUprightAgreement(points, candidate, 800, 600);
  assert.deepEqual({ points, candidate }, before);
});
