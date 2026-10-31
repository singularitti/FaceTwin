/**
 * Deterministic, interpretable 2D proportions for MediaPipe Face Landmarker.
 * x/y must be image-normalized coordinates; width/height must match the analyzed
 * image dimensions. z, iris points, identity embeddings, and demographic traits are
 * unused. 468-point meshes are sufficient; 478-point meshes are accepted.
 *
 * Landmark anatomy was checked against MediaPipe's canonical_face_model.obj and
 * face_mesh_connections.py (official sources):
 * https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/modules/face_geometry/data/canonical_face_model.obj
 * https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/python/solutions/face_mesh_connections.py
 * These are projected surface distances, not clinical anthropometry. In
 * particular, point 10 is the upper mesh boundary, NOT the hairline.
 *
 * Every group has weight 1/5. Metrics share their group's weight equally.
 * d = |a-b| / max((a+b)/2, 0.01); metric score = 100 exp(-d/0.2).
 * Overall score = 100 exp(-mean_group(mean_metric(d/0.2))). The 0.2 scale
 * and 0.01 floor are explicit design heuristics, not fitted or validated
 * thresholds. Correlated ratios are not independent evidence. Scores describe
 * only these proportions; they are neither identity probabilities nor validated
 * measures of human-perceived resemblance. No yaw/pitch correction is performed.
 */

export const SCORE_SCALE = 0.2;

export const GROUP_DEFINITIONS = Object.freeze([
  { id: 'face', label: '脸部轮廓', weight: 0.2 },
  { id: 'eyes', label: '眼部比例', weight: 0.2 },
  { id: 'nose', label: '鼻部比例', weight: 0.2 },
  { id: 'mouth', label: '嘴部比例', weight: 0.2 },
  { id: 'layout', label: '纵向布局', weight: 0.2 },
]);

const FACE_WIDTH = [[234, 454]];
const FACE_HEIGHT = [[10, 152]];
const EYE_WIDTHS = [[33, 133], [362, 263]];
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const distance = (points, [a, b]) => Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y);
const definitions = [
  ['faceAspect', '脸长／脸宽', 'face', FACE_HEIGHT, FACE_WIDTH, 'mean', 'mean', 'd(10,152) / d(234,454)', '上部网格边界至下巴的距离，相对于两侧面颊宽度；不代表发际线长度。'],
  ['jawWidth', '下颌宽／脸宽', 'face', [[172, 397]], FACE_WIDTH, 'mean', 'mean', 'd(172,397) / d(234,454)', '两侧下颌轮廓间距，相对于面颊宽度。'],
  ['chinWidth', '下巴宽／脸宽', 'face', [[149, 378]], FACE_WIDTH, 'mean', 'mean', 'd(149,378) / d(234,454)', '靠近下巴的两侧轮廓间距，相对于面颊宽度。'],
  ['eyeSpacing', '内眼角间距／脸宽', 'eyes', [[133, 362]], FACE_WIDTH, 'mean', 'mean', 'd(133,362) / d(234,454)', '两眼内眼角之间的距离，相对于面颊宽度。'],
  ['eyeWidth', '平均眼宽／脸宽', 'eyes', EYE_WIDTHS, FACE_WIDTH, 'mean', 'mean', 'mean(d(33,133), d(362,263)) / d(234,454)', '两眼内外眼角距离的平均值，相对于面颊宽度。'],
  ['eyeOpenness', '平均眼高／平均眼宽', 'eyes', [[159, 145], [386, 374]], EYE_WIDTHS, 'mean', 'mean', 'mean(d(159,145), d(386,374)) / mean(d(33,133), d(362,263))', '上下眼睑中部间距与眼宽的比例；会随眨眼和表情变化。'],
  ['noseWidth', '鼻翼宽／脸宽', 'nose', [[48, 278]], FACE_WIDTH, 'mean', 'mean', 'd(48,278) / d(234,454)', '两侧鼻翼表面点的间距，相对于面颊宽度。'],
  ['noseAspect', '鼻长／鼻翼宽', 'nose', [[168, 2]], [[48, 278]], 'mean', 'mean', 'd(168,2) / d(48,278)', '鼻根至鼻底中点的投影距离，相对于鼻翼宽度。'],
  ['mouthWidth', '嘴宽／脸宽', 'mouth', [[61, 291]], FACE_WIDTH, 'mean', 'mean', 'd(61,291) / d(234,454)', '两侧嘴角之间的距离，相对于面颊宽度；会随笑容变化。'],
  ['lipThickness', '唇厚合计／嘴宽', 'mouth', [[0, 13], [14, 17]], [[61, 291]], 'sum', 'mean', '(d(0,13) + d(14,17)) / d(61,291)', '上唇和下唇中央厚度之和，不把张嘴间隙计入唇厚；仍受表情影响。'],
  ['upperLayout', '上部长度／脸长', 'layout', [[10, 168]], FACE_HEIGHT, 'mean', 'mean', 'd(10,168) / d(10,152)', '上部网格边界至鼻根的距离，占网格脸长的比例。'],
  ['lowerLayout', '鼻底至下巴／脸长', 'layout', [[2, 152]], FACE_HEIGHT, 'mean', 'mean', 'd(2,152) / d(10,152)', '鼻底至下巴的距离，占网格脸长的比例。'],
  ['noseMouthGap', '鼻底至上唇／脸长', 'layout', [[2, 0]], FACE_HEIGHT, 'mean', 'mean', 'd(2,0) / d(10,152)', '鼻底至上唇外缘中点的距离，占网格脸长的比例。'],
];

export const FEATURE_DEFINITIONS = Object.freeze(definitions.map(
  ([id, label, group, numerator, denominator, numeratorMode, denominatorMode, formula, explanation]) => Object.freeze({
    id, label, group,
    segments: { numerator, denominator },
    numeratorMode, denominatorMode, formula, explanation,
    tolerance: SCORE_SCALE,
    weight: 0.2 / definitions.filter((feature) => feature[2] === group).length,
  }),
));

const REQUIRED = [...new Set([1, 13, 14, ...FEATURE_DEFINITIONS.flatMap((feature) =>
  [...feature.segments.numerator, ...feature.segments.denominator].flat())])];
const EPSILON = 1e-8;

function validate(landmarks, width, height) {
  const errors = [];
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) errors.push('图像尺寸必须为正数。');
  if (!Array.isArray(landmarks) || landmarks.length < 468) errors.push('需要至少 468 个 MediaPipe 面部关键点。');
  else if (REQUIRED.some((index) => !Number.isFinite(landmarks[index]?.x) || !Number.isFinite(landmarks[index]?.y))) errors.push('用于测量的关键点包含无效坐标。');
  return errors;
}

/** Returns {valid, points, errors, transform}. points are centered, roll-aligned,
 * cheek-width-normalized coordinates. Missing UNUSED points become null.
 * Pixel conversion precedes distance/angle calculations to fix aspect ratio.
 * Reflection can reverse aligned x, but every measured distance is invariant.
 */
export function normalizeLandmarks(landmarks, width, height) {
  const errors = validate(landmarks, width, height);
  if (errors.length) return { valid: false, points: [], errors, transform: null };
  const pixel = (point) => ({ x: point.x * width, y: point.y * height });
  const a = pixel(landmarks[33]);
  const b = pixel(landmarks[263]);
  const origin = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const cheekA = pixel(landmarks[234]);
  const cheekB = pixel(landmarks[454]);
  const scale = Math.hypot(cheekB.x - cheekA.x, cheekB.y - cheekA.y);
  if (!Number.isFinite(scale) || !Number.isFinite(origin.x) || !Number.isFinite(origin.y) || scale <= EPSILON || Math.hypot(b.x - a.x, b.y - a.y) <= EPSILON) {
    return { valid: false, points: [], errors: ['脸宽或眼角间距为零，无法归一化。'], transform: null };
  }
  const rollRadians = Math.atan2(b.y - a.y, b.x - a.x);
  const cos = Math.cos(rollRadians);
  const sin = Math.sin(rollRadians);
  const points = landmarks.map((point) => {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
    const x = point.x * width - origin.x;
    const y = point.y * height - origin.y;
    return { x: (x * cos + y * sin) / scale, y: (-x * sin + y * cos) / scale };
  });
  if (REQUIRED.some((index) => !Number.isFinite(points[index]?.x) || !Number.isFinite(points[index]?.y))) {
    return { valid: false, points: [], errors: ['关键点数值过大，无法归一化。'], transform: null };
  }
  return { valid: true, points, errors: [], transform: { origin, rollRadians, scale } };
}

/** Geometry objects are immutable-by-convention inputs to comparison. Invalid
 * extraction returns valid:false and errors instead of silently dropping metrics.
 */
export function extractGeometry(landmarks, width, height) {
  const normalized = normalizeLandmarks(landmarks, width, height);
  const result = { valid: normalized.valid, metrics: {}, groups: {}, normalizedLandmarks: normalized.points, errors: [...normalized.errors] };
  if (!normalized.valid) return result;
  for (const feature of FEATURE_DEFINITIONS) {
    const reduce = (segments, mode) => {
      const values = segments.map((pair) => distance(normalized.points, pair));
      return mode === 'sum' ? values.reduce((sum, value) => sum + value, 0) : mean(values);
    };
    const numerator = reduce(feature.segments.numerator, feature.numeratorMode);
    const denominator = reduce(feature.segments.denominator, feature.denominatorMode);
    const value = numerator / denominator;
    if (denominator <= EPSILON || !Number.isFinite(value)) result.errors.push(`${feature.label}的参考长度无效。`);
    else {
      result.metrics[feature.id] = value;
      (result.groups[feature.group] ??= {})[feature.id] = value;
    }
  }
  // A fully collapsed eye or face height is not a meaningful photograph.
  if (distance(normalized.points, FACE_HEIGHT[0]) <= EPSILON || EYE_WIDTHS.some((pair) => distance(normalized.points, pair) <= EPSILON)) result.errors.push('脸长或眼宽为零，无法测量。');
  result.valid = result.errors.length === 0;
  return result;
}

function isGeometry(value) {
  return value?.valid === true && FEATURE_DEFINITIONS.every((feature) => Number.isFinite(value.metrics?.[feature.id]) && value.metrics[feature.id] >= 0);
}

/** Symmetric comparison. All 13 metrics are required; no hidden reweighting for
 * missing features. Group score applies the same exponential to its own mean.
 */
export function compareGeometry(a, b) {
  if (!isGeometry(a) || !isGeometry(b)) return { valid: false, score: null, meanDifference: null, meanNormalizedDifference: null, groups: {}, metrics: {}, errors: ['需要两份完整且有效的几何测量。'] };
  const metrics = {};
  const groups = {};
  for (const feature of FEATURE_DEFINITIONS) {
    const av = a.metrics[feature.id];
    const bv = b.metrics[feature.id];
    const difference = Math.abs(av - bv) / Math.max((av + bv) / 2, 0.01);
    const normalizedDifference = difference / feature.tolerance;
    metrics[feature.id] = { a: av, b: bv, difference, normalizedDifference, score: 100 * Math.exp(-normalizedDifference), weight: feature.weight };
  }
  for (const group of GROUP_DEFINITIONS) {
    const values = FEATURE_DEFINITIONS.filter((feature) => feature.group === group.id).map((feature) => metrics[feature.id]);
    const difference = mean(values.map((value) => value.difference));
    const normalizedDifference = mean(values.map((value) => value.normalizedDifference));
    groups[group.id] = { difference, normalizedDifference, score: 100 * Math.exp(-normalizedDifference), weight: group.weight };
  }
  const meanDifference = mean(Object.values(groups).map((group) => group.difference));
  const meanNormalizedDifference = mean(Object.values(groups).map((group) => group.normalizedDifference));
  return { valid: true, score: 100 * Math.exp(-meanNormalizedDifference), meanDifference, meanNormalizedDifference, groups, metrics, errors: [] };
}

// Linear interpolation between order statistics (R-7); works for one observation.
function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

/** Strict contract: arrays of extractGeometry() results, NOT image records.
 * Compare every valid A×B pair; invalid inputs retain null matrix cells and are
 * reported in excluded. pairScores is flat; pairs retains original photo indices.
 * Quartiles/medians summarize photo sensitivity, NOT statistical confidence.
 * metricRawMedians summarize each person's photos separately in ratio units.
 */
export function aggregateComparisons(photoAs, photoBs) {
  const as = Array.isArray(photoAs) ? photoAs : [];
  const bs = Array.isArray(photoBs) ? photoBs : [];
  const pairs = [];
  const pairMatrix = as.map((a, aIndex) => bs.map((b, bIndex) => {
    const comparison = compareGeometry(a, b);
    if (!comparison.valid) return null;
    pairs.push({ aIndex, bIndex, ...comparison });
    return comparison.score;
  }));
  const pairScores = pairs.map((pair) => pair.score);
  const groupMedians = Object.fromEntries(GROUP_DEFINITIONS.map((group) => [group.id, quantile(pairs.map((pair) => pair.groups[group.id].score), 0.5)]));
  const rawMedians = (photos) => Object.fromEntries(FEATURE_DEFINITIONS.map((feature) => [feature.id, quantile(photos.filter(isGeometry).map((photo) => photo.metrics[feature.id]), 0.5)]));
  const q1 = quantile(pairScores, 0.25);
  const q3 = quantile(pairScores, 0.75);
  return {
    valid: pairs.length > 0, pairMatrix, pairs, pairScores,
    median: quantile(pairScores, 0.5),
    min: pairScores.length ? pairScores.reduce((minimum, score) => Math.min(minimum, score), Infinity) : null,
    max: pairScores.length ? pairScores.reduce((maximum, score) => Math.max(maximum, score), -Infinity) : null,
    q1, q3, iqr: pairs.length ? q3 - q1 : null,
    groupMedians,
    metricRawMedians: { a: rawMedians(as), b: rawMedians(bs) },
    metricDifferenceMedians: Object.fromEntries(FEATURE_DEFINITIONS.map((feature) => [feature.id, quantile(pairs.map((pair) => pair.metrics[feature.id].difference), 0.5)])),
    validPhotoCounts: { a: as.filter(isGeometry).length, b: bs.filter(isGeometry).length },
    excluded: { a: as.map((photo, index) => isGeometry(photo) ? null : index).filter((index) => index !== null), b: bs.map((photo, index) => isGeometry(photo) ? null : index).filter((index) => index !== null) },
    errors: pairs.length ? [] : ['没有可比较的有效照片组合。'],
  };
}

/** Advisory heuristics, not a detector confidence estimate. Warnings do not
 * auto-exclude photos. yawProxy is lateral nose-tip displacement from the outer
 * eye midpoint divided by outer-eye span; it can also reflect natural asymmetry.
 * No calibrated yaw/pitch angle or correction is claimed. blendshapes accepts
 * MediaPipe category arrays or {categories:[...]}; these values stay local.
 */
export function summarizeQuality(landmarks, width, height, blendshapes = []) {
  const geometry = extractGeometry(landmarks, width, height);
  if (!geometry.valid) return { valid: false, level: 'error', warnings: [{ code: 'invalid', message: geometry.errors.join(' ') }], measurements: {} };
  const normalized = normalizeLandmarks(landmarks, width, height);
  const points = normalized.points;
  const span = distance(points, [33, 263]);
  const yawProxy = Math.abs(points[1].x) / span;
  const eyeA = distance(points, EYE_WIDTHS[0]);
  const eyeB = distance(points, EYE_WIDTHS[1]);
  const eyeWidthImbalance = Math.max(eyeA, eyeB) / Math.min(eyeA, eyeB);
  const mouthOpening = distance(points, [13, 14]) / distance(points, [61, 291]);
  const faceWidthPixels = normalized.transform.scale;
  const faceWidthFraction = faceWidthPixels / Math.min(width, height);
  const contour = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  const clipped = contour.some((index) => {
    const point = landmarks[index];
    return point && (point.x < 0.01 || point.x > 0.99 || point.y < 0.01 || point.y > 0.99);
  });
  const categories = Array.isArray(blendshapes) ? blendshapes : blendshapes?.categories ?? [];
  const expressionScore = Math.max(0, ...categories.filter((category) => /^(jawOpen|mouthSmileLeft|mouthSmileRight|eyeBlinkLeft|eyeBlinkRight)$/.test(category.categoryName ?? category.displayName ?? '')).map((category) => Number.isFinite(category.score) ? category.score : 0));
  const warnings = [];
  if (faceWidthPixels < 120 || faceWidthFraction < 0.18) warnings.push({ code: 'small', message: '脸部较小：建议使用更清晰、脸部占比更大的照片。' });
  if (clipped) warnings.push({ code: 'clipped', message: '面部轮廓接近或超出边缘：请保留完整脸部。' });
  if (yawProxy > 0.12 || eyeWidthImbalance > 1.35) warnings.push({ code: 'pose', message: '鼻尖偏移或两眼宽度差较大：可能存在侧脸或遮挡，请优先使用正面照；此提示也可能受自然不对称影响。' });
  if (mouthOpening > 0.16 || expressionScore > 0.55) warnings.push({ code: 'expression', message: '检测到较明显的张嘴、笑容或眨眼信号：表情可能改变比例，请使用自然表情照片。' });
  return { valid: true, level: warnings.length ? 'warning' : 'ok', warnings, measurements: { faceWidthPixels, faceWidthFraction, yawProxy, eyeWidthImbalance, mouthOpening, expressionScore } };
}
