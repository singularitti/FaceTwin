/**
 * Original-pixel eye-line tilt normalization for a second detector pass.
 * This is a 2D rotation, not yaw/pitch correction or recovered hidden contour.
 * Agreement thresholds measure consistency between passes, not accuracy.
 */
export const ORIENTATION_POLICY = Object.freeze({
  version: 'upright-refinement-v1',
  minRollDegrees: 12,
  padding: 0.18,
  maxEdge: 1600,
  anchorMeanLimit: 0.12,
  anchorMaxLimit: 0.25,
  contourMeanLimit: 0.20,
  contourMaxLimit: 0.40,
});

export const FACE_OVAL_INDICES = Object.freeze([
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
  397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
]);

const ANCHOR_INDICES = [1, 33, 263, 61, 291];
const EPSILON = 1e-8;
const dimensionsValid = (width, height) => Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
const pointValid = (point) => Number.isFinite(point?.x) && Number.isFinite(point?.y);

function pixelMesh(landmarks, width, height) {
  if (!dimensionsValid(width, height) || !Array.isArray(landmarks) || landmarks.length < 468) return null;
  const points = [];
  for (let index = 0; index < 468; index += 1) {
    const point = landmarks[index];
    if (!pointValid(point)) return null;
    const pixel = { x: point.x * width, y: point.y * height };
    if (!pointValid(pixel)) return null;
    points.push(pixel);
  }
  return points;
}

function eyeSpan(points) {
  return Math.hypot(points[263].x - points[33].x, points[263].y - points[33].y);
}

function rollFromPixels(points) {
  const span = eyeSpan(points);
  if (!Number.isFinite(span) || span <= EPSILON) return null;
  let roll = Math.atan2(points[263].y - points[33].y, points[263].x - points[33].x);
  if (roll > Math.PI / 2) roll -= Math.PI;
  if (roll < -Math.PI / 2) roll += Math.PI;
  return roll;
}

/** Returns radians in [-pi/2, pi/2], or null for invalid dimensions/mesh/eyes.
 * The first 468 points must have finite x/y; optional iris points are unused.
 * Convert to pixels before estimating the angle, including nonsquare images.
 */
export function estimateEyeRoll(landmarks, width, height) {
  const points = pixelMesh(landmarks, width, height);
  return points ? rollFromPixels(points) : null;
}

/** Returns a square upright sampling plan, or null for invalid/degenerate data.
 * transform is a Canvas-style affine matrix mapping SOURCE PIXELS to TARGET
 * PIXELS. The ROI is never clamped; callers must fill padding outside the source.
 * sourceSize is a length in original pixels, targetSize is the sampling edge;
 * samplingScale describes resampling and does not claim additional source detail.
 * Planning also works below minRollDegrees; the caller decides whether to retry.
 */
export function planUprightCrop(landmarks, width, height) {
  const points = pixelMesh(landmarks, width, height);
  if (!points) return null;
  const rotationRadians = rollFromPixels(points);
  if (rotationRadians === null) return null;
  const cos = Math.cos(rotationRadians);
  const sin = Math.sin(rotationRadians);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const point of points) {
    const u = cos * point.x + sin * point.y;
    const v = -sin * point.x + cos * point.y;
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  const centerU = minU / 2 + maxU / 2;
  const centerV = minV / 2 + maxV / 2;
  const centerX = cos * centerU - sin * centerV;
  const centerY = sin * centerU + cos * centerV;
  const sourceSize = Math.max(maxU - minU, maxV - minV) * (1 + 2 * ORIENTATION_POLICY.padding);
  if (!Number.isFinite(sourceSize) || sourceSize <= EPSILON || !Number.isFinite(centerX) || !Number.isFinite(centerY)) return null;
  const targetSize = Math.max(1, Math.round(Math.min(sourceSize, ORIENTATION_POLICY.maxEdge)));
  const samplingScale = targetSize / sourceSize;
  const transform = {
    a: samplingScale * cos,
    b: -samplingScale * sin,
    c: samplingScale * sin,
    d: samplingScale * cos,
    e: targetSize / 2 - samplingScale * (cos * centerX + sin * centerY),
    f: targetSize / 2 - samplingScale * (-sin * centerX + cos * centerY),
  };
  if (!Object.values(transform).every(Number.isFinite)
      || !Number.isFinite(transform.a * transform.d - transform.b * transform.c)
      || transform.a * transform.d - transform.b * transform.c === 0) return null;
  const half = sourceSize / 2;
  let paddedOutside = false;
  for (const du of [-half, half]) {
    for (const dv of [-half, half]) {
      const x = centerX + cos * du - sin * dv;
      const y = centerY + sin * du + cos * dv;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (x < 0 || x > width || y < 0 || y > height) paddedOutside = true;
    }
  }
  return { rotationRadians, rollDegrees: rotationRadians * 180 / Math.PI, centerX, centerY, sourceSize, targetSize, samplingScale, paddedOutside, transform };
}

/** Invert a plan for target-normalized points, returning source-normalized x/y.
 * z is width-normalized by MediaPipe, so finite z scales by sourceSize/width.
 * Other fields are preserved, absent z remains absent, and inputs are unmodified.
 * Throws TypeError for invalid plans, dimensions, points, or provided nonfinite z.
 */
export function mapUprightLandmarks(points, plan, width, height) {
  const matrix = plan?.transform;
  if (!dimensionsValid(width, height) || !Array.isArray(points)
      || !Number.isFinite(plan?.sourceSize) || plan.sourceSize <= EPSILON
      || !Number.isInteger(plan?.targetSize) || plan.targetSize < 1
      || !matrix || !['a', 'b', 'c', 'd', 'e', 'f'].every((key) => Number.isFinite(matrix[key]))) {
    throw new TypeError('Invalid upright mapping plan, dimensions, or points.');
  }
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || determinant === 0) throw new TypeError('Upright mapping transform must be invertible.');
  return Array.from(points, (point) => {
    if (!pointValid(point) || ('z' in point && !Number.isFinite(point.z))) throw new TypeError('Upright points require finite x/y and any provided z.');
    const x = point.x * plan.targetSize - matrix.e;
    const y = point.y * plan.targetSize - matrix.f;
    const mapped = {
      ...point,
      x: (matrix.d * x - matrix.c * y) / determinant / width,
      y: (-matrix.b * x + matrix.a * y) / determinant / height,
    };
    if ('z' in point) mapped.z = point.z * plan.sourceSize / width;
    if (!pointValid(mapped) || ('z' in mapped && !Number.isFinite(mapped.z))) throw new TypeError('Mapped upright coordinates must be finite.');
    return mapped;
  });
}

/** Conservative pass-consistency gate in ORIGINAL PIXELS, independent of scores
 * and expression. Both first-468 meshes must be finite; the smaller outer-eye
 * span must exceed 2 pixels. Invalid inputs return false flags and null metrics.
 */
export function assessUprightAgreement(original, candidate, width, height) {
  const invalid = { comparable: false, recommended: false, anchorMeanFraction: null, anchorMaxFraction: null, contourMeanFraction: null, contourMaxFraction: null, reason: 'invalid' };
  const a = pixelMesh(original, width, height);
  const b = pixelMesh(candidate, width, height);
  if (!a || !b) return invalid;
  const reference = Math.min(eyeSpan(a), eyeSpan(b));
  if (!Number.isFinite(reference) || reference <= 2) return invalid;
  const fractions = (indices) => indices.map((index) => Math.hypot(a[index].x - b[index].x, a[index].y - b[index].y) / reference);
  const anchors = fractions(ANCHOR_INDICES);
  const contour = fractions(FACE_OVAL_INDICES);
  if (![...anchors, ...contour].every(Number.isFinite)) return invalid;
  const mean = (values) => values.reduce((sum, value) => sum + value / values.length, 0);
  const anchorMeanFraction = mean(anchors);
  const anchorMaxFraction = Math.max(...anchors);
  const contourMeanFraction = mean(contour);
  const contourMaxFraction = Math.max(...contour);
  const comparable = anchorMeanFraction <= ORIENTATION_POLICY.anchorMeanLimit && anchorMaxFraction <= ORIENTATION_POLICY.anchorMaxLimit;
  const recommended = comparable && contourMeanFraction <= ORIENTATION_POLICY.contourMeanLimit && contourMaxFraction <= ORIENTATION_POLICY.contourMaxLimit;
  return {
    comparable, recommended, anchorMeanFraction, anchorMaxFraction, contourMeanFraction, contourMaxFraction,
    reason: !comparable ? 'anchor-disagreement' : recommended ? 'stable' : 'contour-disagreement',
  };
}
