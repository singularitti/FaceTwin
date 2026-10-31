/**
 * Per-photo lip-measurement reliability, fixed before inspecting photographs.
 * These are explicit engineering heuristics with untrained, uncalibrated
 * thresholds, not probabilities or independent evidence of an expression.
 * MediaPipe coefficients share the landmark model's evidence. Neither lip
 * thickness, facial proportions nor resemblance scores are inputs here.
 */

const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

export const EXPRESSION_POLICY = freeze({
  version: 'lip-reliability-v1',
  interpretation: 'Engineering heuristic; not a probability. Thresholds are untrained and uncalibrated.',
  expression: { start: 0.2, end: 0.7 },
  size: { startPixels: 60, endPixels: 140 },
  yaw: { start: 0.12, end: 0.30 },
  eyeWidthImbalance: { start: 1.35, end: 2.0 },
  clippedFactor: 0.25,
  suspectedPressThreshold: 0.2,
  pressRollSignals: ['mouthPressLeft', 'mouthPressRight', 'mouthRollUpper', 'mouthRollLower'],
  requiredSignals: ['mouthPressLeft', 'mouthPressRight', 'mouthRollUpper', 'mouthRollLower', 'mouthPucker', 'mouthFunnel', 'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight', 'jawOpen'],
  otherExpressionSignals: ['mouthPucker', 'mouthFunnel', 'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight', 'jawOpen'],
  displayOnlySignals: ['mouthClose'],
});

export const LIP_SIGNAL_DEFINITIONS = freeze([
  { id: 'mouthPressLeft', label: '左侧压唇' },
  { id: 'mouthPressRight', label: '右侧压唇' },
  { id: 'mouthRollUpper', label: '上唇内卷' },
  { id: 'mouthRollLower', label: '下唇内卷' },
  { id: 'mouthPucker', label: '噘嘴' },
  { id: 'mouthFunnel', label: '嘴唇收拢' },
  { id: 'mouthSmileLeft', label: '左侧微笑' },
  { id: 'mouthSmileRight', label: '右侧微笑' },
  { id: 'mouthStretchLeft', label: '左侧嘴角拉伸' },
  { id: 'mouthStretchRight', label: '右侧嘴角拉伸' },
  { id: 'jawOpen', label: '张嘴' },
  { id: 'mouthClose', label: '闭嘴（仅展示）' },
]);

function smoothstep(start, end, value) {
  const t = Math.min(1, Math.max(0, (value - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

const validSignal = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const maxKnown = (values) => {
  const known = values.filter((value) => value !== null);
  return known.length ? Math.max(...known) : null;
};

/**
 * Accepts a MediaPipe category array or {categories:[...]}, and the result of
 * summarizeQuality(). Invalid/missing interference signals or quality yield unknown
 * automatic reliability (weight zero), never a neutral-expression assumption.
 * Manual modes change only final reliability; all automatic diagnostics remain.
 */
export function analyzeLipReliability(blendshapes, quality, mode = 'auto') {
  mode = ['auto', 'include', 'exclude'].includes(mode) ? mode : 'auto';
  const categories = Array.isArray(blendshapes) ? blendshapes : blendshapes?.categories;
  const signals = Object.fromEntries(LIP_SIGNAL_DEFINITIONS.map(({ id }) => [id, null]));
  if (Array.isArray(categories)) {
    for (const category of categories) {
      const name = category?.categoryName || category?.displayName;
      if (!Object.hasOwn(signals, name)) continue;
      // Duplicate entries are unexpected; never let a later neutral coefficient
      // erase an earlier interference signal. Invalid entries are missing.
      if (validSignal(category.score)) signals[name] = Math.max(signals[name] ?? 0, category.score);
    }
  }
  const coreKnown = EXPRESSION_POLICY.pressRollSignals.every((name) => signals[name] !== null);
  const expressionKnown = EXPRESSION_POLICY.requiredSignals.every((name) => signals[name] !== null);
  const press = signals.mouthPressLeft !== null && signals.mouthPressRight !== null
    ? Math.max(signals.mouthPressLeft, signals.mouthPressRight) : null;
  const roll = signals.mouthRollUpper !== null && signals.mouthRollLower !== null
    ? Math.max(signals.mouthRollUpper, signals.mouthRollLower) : null;
  const otherExpression = maxKnown(EXPRESSION_POLICY.otherExpressionSignals.map((name) => signals[name]));
  const expressionSeverity = expressionKnown ? Math.max(press, roll, otherExpression) : null;
  const expressionReliability = expressionKnown
    ? 1 - smoothstep(EXPRESSION_POLICY.expression.start, EXPRESSION_POLICY.expression.end, expressionSeverity) : null;

  const measurements = quality?.measurements;
  const sizeKnown = Number.isFinite(measurements?.faceWidthPixels) && measurements.faceWidthPixels > 0;
  const yawKnown = Number.isFinite(measurements?.yawProxy) && measurements.yawProxy >= 0;
  const imbalanceKnown = Number.isFinite(measurements?.eyeWidthImbalance) && measurements.eyeWidthImbalance >= 1;
  const clippingKnown = Array.isArray(quality?.warnings);
  const qualityKnown = quality?.valid === true && sizeKnown && yawKnown && imbalanceKnown && clippingKnown;
  const factors = {
    size: sizeKnown ? smoothstep(EXPRESSION_POLICY.size.startPixels, EXPRESSION_POLICY.size.endPixels, measurements.faceWidthPixels) : null,
    yaw: yawKnown ? 1 - smoothstep(EXPRESSION_POLICY.yaw.start, EXPRESSION_POLICY.yaw.end, measurements.yawProxy) : null,
    eyeWidthImbalance: imbalanceKnown ? 1 - smoothstep(EXPRESSION_POLICY.eyeWidthImbalance.start, EXPRESSION_POLICY.eyeWidthImbalance.end, measurements.eyeWidthImbalance) : null,
    pose: null,
    clipped: clippingKnown ? (quality.warnings.some((warning) => warning?.code === 'clipped') ? EXPRESSION_POLICY.clippedFactor : 1) : null,
  };
  if (yawKnown && imbalanceKnown) factors.pose = Math.min(factors.yaw, factors.eyeWidthImbalance);
  const qualityReliability = qualityKnown ? Math.min(factors.size, factors.pose, factors.clipped) : null;
  const known = expressionKnown && qualityKnown;
  const autoReliability = known ? expressionReliability * qualityReliability : 0;
  const level = !known ? 'unknown' : autoReliability === 0 ? 'excluded' : autoReliability < 1 ? 'reduced' : 'usable';
  const suspectedPress = coreKnown && Math.max(press, roll) >= EXPRESSION_POLICY.suspectedPressThreshold;
  const reasons = [];
  if (!expressionKnown) reasons.push({ code: 'missing-signals', message: '压唇、内卷或其他嘴部干扰信号缺失或无效，自动唇厚可靠性未知。' });
  if (!qualityKnown) reasons.push({ code: 'invalid-quality', message: '照片质量测量缺失或无效，自动唇厚可靠性未知。' });
  if (press !== null && press >= EXPRESSION_POLICY.suspectedPressThreshold) reasons.push({ code: 'press', message: '模型出现压唇信号，唇厚测量可能受影响；这不是确定的表情判定。' });
  if (roll !== null && roll >= EXPRESSION_POLICY.suspectedPressThreshold) reasons.push({ code: 'roll', message: '模型出现唇部内卷信号，唇厚测量可能受影响；这不是确定的表情判定。' });
  if (otherExpression !== null && otherExpression > EXPRESSION_POLICY.expression.start) reasons.push({ code: 'other-expression', message: '噘嘴、嘴角拉伸、笑容或张嘴信号可能影响唇厚测量。' });
  if (qualityKnown && factors.size < 1) reasons.push({ code: 'quality-small', message: '脸宽像素较少，降低唇厚测量的质量权重。' });
  if (qualityKnown && factors.pose < 1) reasons.push({ code: 'quality-pose', message: '鼻尖偏移或眼宽不平衡，降低唇厚测量的质量权重；也可能受自然不对称影响。' });
  if (qualityKnown && factors.clipped < 1) reasons.push({ code: 'quality-clipped', message: '面部轮廓接近或超出边缘，降低唇厚测量的质量权重。' });
  if (mode === 'include') reasons.push({ code: 'manual-include', message: '已手动纳入唇厚测量，采用的可靠度因子 q 设为 1；自动诊断保留。' });
  if (mode === 'exclude') reasons.push({ code: 'manual-exclude', message: '已手动排除唇厚测量，采用的可靠度因子 q 设为 0；自动诊断保留。' });
  return {
    mode, known, signals, press, roll, otherExpression, expressionSeverity,
    expressionReliability, qualityReliability, autoReliability,
    reliability: mode === 'include' ? 1 : mode === 'exclude' ? 0 : autoReliability,
    level, suspectedPress, reasons, factors,
  };
}
