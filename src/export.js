/** CSV audit data: anonymous photo labels, original measurements, and adjustments. */
import { FEATURE_DEFINITIONS } from './geometry.js';
import { comparisonDiagnostics } from './diagnostics.js';
import { EXPRESSION_POLICY } from './expression.js';
import { withinGroupAdjusted, summarizeLipReference, LIP_REFERENCE_MIN_RELIABILITY } from './adjustment.js';

const label = (side, index) => `${side.toUpperCase()}${index + 1}`;
const q = (photo) => photo.lip?.reliability ?? 0;

export function buildExportRows(photos, baseline, adjusted) {
  const header = ['record_type', 'photo_a', 'photo_b', 'group', 'feature', 'value_a', 'value_b', 'relative_difference', 'score', 'note', 'base_weight', 'retained_weight', 'effective_weight', 'coverage', 'reliability'];
  const rows = [header];
  if (!baseline?.valid || !adjusted?.valid) return rows;
  const add = (row) => rows.push([...row, ...Array(Math.max(0, header.length - row.length)).fill('')]);
  const geometries = Object.fromEntries(['a', 'b'].map((side) => [side, photos[side].map((photo) => photo.result)]));
  const reliabilities = Object.fromEntries(['a', 'b'].map((side) => [side, photos[side].map(q)]));
  const diagnostics = comparisonDiagnostics(geometries.a, geometries.b, baseline);
  add(['metadata', '', '', '', 'method', '', '', '', '', 'FaceTwin; MediaPipe Tasks Vision 0.10.21; face_landmarker float16/1; geometry only; scale=0.20; floor=0.01; original 5 equal-weight groups; uncalibrated']);
  add(['metadata', '', '', '', 'expression_policy', '', '', '', '', JSON.stringify(EXPRESSION_POLICY)]);
  add(['metadata', '', '', '', 'adjustment_method', '', '', '', '', 'Only lipThickness base weight is multiplied by min(qA,qB); normalize all retained weights globally. Missing reliability=0. No change to raw measurements. Coefficients and q are not probabilities.']);
  add(['summary', '', '', '', 'median_weighted_difference', '', '', diagnostics.medianDifference, '', 'Original weighted geometric difference']);
  for (const key of ['median', 'min', 'max', 'q1', 'q3', 'iqr']) {
    add(['summary', '', '', '', key, '', '', '', baseline[key], 'Original score; descriptive photo variation']);
    add(['adjusted_summary', '', '', '', key, '', '', '', adjusted[key], 'Experimental adjustment; not calibrated perception']);
  }
  add(['adjusted_summary', '', '', '', 'median_weighted_difference', '', '', adjusted.medianDifference, '', 'Median of adjusted pair differences']);
  for (const key of ['medianCoverage', 'minCoverage', 'maxCoverage', 'medianLipEffectiveWeight']) {
    add(['adjusted_summary', '', '', '', key, adjusted[key], '', '', '', 'Coverage is retained base-weight mass, not confidence']);
  }
  for (const side of ['a', 'b']) {
    const original = diagnostics.within[side];
    const weighted = withinGroupAdjusted(geometries[side], reliabilities[side]);
    for (const [type, result] of [['within_group', original], ['within_group_adjusted', weighted]]) {
      add([type, side.toUpperCase(), '', '', 'unique_photo_pairs', result.count, '', result.medianDifference ?? '', result.medianScore ?? '', 'User-provided groups; no self-pairs or identity verification', '', '', '', result.medianCoverage ?? '']);
      for (const key of ['min', 'max']) add([type, side.toUpperCase(), '', '', key, '', '', '', result[key] ?? '', 'Descriptive within-group score range']);
    }
    const reference = summarizeLipReference(geometries[side], reliabilities[side]);
    add(['lip_reference', side.toUpperCase(), '', 'mouth', 'weighted_median', reference.value ?? '', reference.count, '', '', `q>=${LIP_REFERENCE_MIN_RELIABILITY}; descriptive only, never replaces pair measurements; supplied=${reference.totalCount}; weightSum=${reference.weightSum}`]);
  }
  for (const [type, result] of [['pair', baseline], ['adjusted_pair', adjusted]]) {
    for (const pair of result.pairs) {
      const a = label('a', pair.aIndex), b = label('b', pair.bIndex);
      add([type, a, b, '', '', '', '', pair.meanDifference, pair.score, type === 'pair' ? 'Original score' : `original=${pair.baselineScore}; delta=${pair.delta}`, '', '', '', pair.coverage ?? '', pair.lipReliability ?? '']);
      for (const feature of FEATURE_DEFINITIONS) {
        const item = pair.metrics[feature.id];
        add([type === 'pair' ? 'feature' : 'adjusted_feature', a, b, feature.group, feature.id, item.a, item.b, item.difference, item.score, feature.formula, item.baseWeight ?? feature.weight, item.retainedWeight ?? feature.weight, item.effectiveWeight ?? feature.weight, pair.coverage ?? 1, feature.id === 'lipThickness' ? pair.lipReliability ?? 1 : 1]);
      }
    }
  }
  for (const side of ['a', 'b']) photos[side].forEach((photo, index) => {
    const a = side === 'a' ? label(side, index) : '', b = side === 'b' ? label(side, index) : '';
    const warnings = Array.isArray(photo.quality?.warnings) ? photo.quality.warnings : [];
    add(['photo_status', a, b, '', '', '', '', '', '', photo.error || warnings.map((warning) => warning?.message).filter(Boolean).join(' | ') || 'Measured']);
    add(['preprocessing', a, b, '', 'decode_and_crop', photo.width, photo.height, '', '', `${photo.decodeMethod}; ${photo.colorNote ?? ''}; ${JSON.stringify(photo.detectionInfo ?? {})}; crop=${JSON.stringify(photo.cropRegion ?? null)}`]);
    if (photo.lip) {
      const lip = photo.lip;
      add(['lip_reliability', a, b, 'mouth', lip.mode, lip.autoReliability, lip.reliability, '', '', `known=${lip.known}; level=${lip.level}; suspectedPress=${lip.suspectedPress}; ${lip.reasons.map((reason) => `${reason.code}: ${reason.message}`).join(' | ')}`, '', '', '', '', lip.reliability]);
      for (const key of ['press', 'roll', 'otherExpression', 'expressionSeverity', 'expressionReliability', 'qualityReliability']) {
        add(['lip_diagnostic', a, b, 'mouth', key, lip[key] ?? '', '', '', '', 'Engineering signal, not an action probability']);
      }
      for (const [key, value] of Object.entries(lip.factors)) add(['lip_quality_factor', a, b, 'mouth', key, value ?? '', '', '', '', 'Engineering factor; no expression claim']);
    }
    for (const [key, value] of Object.entries(photo.quality?.measurements ?? {})) {
      add(['quality_measurement', a, b, '', key, Number.isFinite(value) ? value : '', '', '', '', 'Uncalibrated image/pose proxy']);
    }
    for (const category of Array.isArray(photo.blendshapes) ? photo.blendshapes : []) {
      const name = category?.categoryName ?? category?.displayName;
      if (typeof name !== 'string' || !/^[A-Za-z_]\w*$/.test(name)) continue;
      add(['blendshape', a, b, '', name, Number.isFinite(category.score) ? category.score : '', '', '', '', 'Raw model coefficient; not probability; derived from landmarks']);
    }
  });
  return rows;
}

export function serializeCsv(rows) {
  return rows.map((row) => row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
}
