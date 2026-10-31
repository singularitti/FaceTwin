import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_DEFINITIONS, aggregateComparisons } from '../src/geometry.js';
import { aggregateAdjusted } from '../src/adjustment.js';
import { analyzeLipReliability, LIP_SIGNAL_DEFINITIONS } from '../src/expression.js';
import { buildExportRows, serializeCsv } from '../src/export.js';

const geometry = (lip) => ({ valid: true, metrics: Object.fromEntries(FEATURE_DEFINITIONS.map((feature) => [feature.id, feature.id === 'lipThickness' ? lip : 0.4])) });
const quality = { valid: true, warnings: [], measurements: { faceWidthPixels: 300, yawProxy: 0, eyeWidthImbalance: 1 } };
const blendshapes = LIP_SIGNAL_DEFINITIONS.map(({ id }) => ({ categoryName: id, score: 0 }));
const photo = (lip, mode = 'auto') => ({
  result: geometry(lip), quality, blendshapes, lip: analyzeLipReliability(blendshapes, quality, mode),
  width: 800, height: 900, decodeMethod: 'browser-native', colorNote: '',
  file: { name: 'PRIVATE_FILENAME.jpg' }, url: 'blob:PRIVATE_OBJECT_URL',
});
const exported = (photos) => {
  const a = photos.a.map((item) => item.result), b = photos.b.map((item) => item.result);
  const baseline = aggregateComparisons(a, b);
  const adjusted = aggregateAdjusted(a, b, photos.a.map((item) => item.lip?.reliability), photos.b.map((item) => item.lip?.reliability));
  const rows = buildExportRows(photos, baseline, adjusted);
  return { baseline, adjusted, rows, records: rows.slice(1).map((row) => Object.fromEntries(rows[0].map((key, i) => [key, row[i]]))) };
};

test('CSV contains independently reconstructable original and adjusted evidence without photo names', () => {
  const data = exported({ a: [photo(0.2)], b: [photo(0.4, 'exclude')] });
  const original = data.records.find((row) => row.record_type === 'pair');
  const adjusted = data.records.find((row) => row.record_type === 'adjusted_pair');
  assert.equal(original.score, data.baseline.pairs[0].score);
  assert.ok(Math.abs(original.score - 100 * Math.exp(-(0.1 * (2 / 3)) / 0.2)) < 1e-10);
  assert.equal(adjusted.score, 100);
  assert.ok(Math.abs(adjusted.coverage - 0.9) < 1e-12);
  const features = data.records.filter((row) => row.record_type === 'adjusted_feature');
  assert.equal(features.length, 13);
  assert.ok(Math.abs(features.reduce((sum, row) => sum + row.effective_weight, 0) - 1) < 1e-12);
  assert.equal(features.find((row) => row.feature === 'lipThickness').effective_weight, 0);
  const difference = features.reduce((sum, row) => sum + row.relative_difference * row.effective_weight, 0);
  assert.equal(adjusted.score, 100 * Math.exp(-difference / 0.2));
  assert.ok(data.rows.every((row) => row.length === data.rows[0].length));
  const csv = serializeCsv(data.rows);
  assert.ok(!csv.includes('PRIVATE_'));
  assert.ok(data.records.some((row) => row.record_type === 'lip_reliability' && row.feature === 'exclude'));
  assert.ok(data.records.some((row) => row.record_type === 'metadata' && row.feature === 'expression_policy'));
});

test('invalid photos retain anonymous indices and never gain adjusted pairs', () => {
  const excluded = { result: null, error: 'No face', width: 10, height: 10 };
  const data = exported({ a: [excluded, photo(0.2)], b: [photo(0.4)] });
  for (const type of ['pair', 'adjusted_pair']) {
    const pairs = data.records.filter((row) => row.record_type === type);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].photo_a, 'A2');
  }
  assert.equal(data.records.filter((row) => row.record_type === 'photo_status').length, 3);
  assert.equal(data.records.filter((row) => row.record_type === 'within_group' && row.feature === 'unique_photo_pairs')[0].value_a, 0);
});

test('manual include exactly preserves original pair scores while retaining automatic diagnostics', () => {
  const a = photo(0.2, 'include');
  a.blendshapes = blendshapes.map((item) => ({ ...item, score: item.categoryName === 'mouthRollUpper' ? 0.9 : 0 }));
  a.lip = analyzeLipReliability(a.blendshapes, quality, 'include');
  const data = exported({ a: [a], b: [photo(0.4)] });
  const original = data.records.find((row) => row.record_type === 'pair');
  const adjusted = data.records.find((row) => row.record_type === 'adjusted_pair');
  assert.equal(adjusted.score, original.score);
  const record = data.records.find((row) => row.record_type === 'lip_reliability');
  assert.equal(record.value_a, 0);
  assert.equal(record.value_b, 1);
  assert.ok(record.note.includes('suspectedPress=true'));
});

test('CSV quoting preserves commas, quotes, Unicode and multiline notes', () => {
  assert.equal(serializeCsv([['a,b', '"压唇"', 'line1\nline2', null]]), '"a,b","""压唇""","line1\nline2",""');
  assert.equal(buildExportRows({ a: [], b: [] }, { valid: false }, { valid: false }).length, 1);
});

test('unknown expression/quality data exports safely while preserving valid geometry', () => {
  const a = photo(0.2);
  a.blendshapes = [null, { categoryName: 'jawOpen', score: NaN }];
  a.quality = { valid: true, measurements: { faceWidthPixels: 300 } };
  a.lip = analyzeLipReliability(a.blendshapes, a.quality);
  const data = exported({ a: [a], b: [photo(0.4)] });
  assert.equal(data.records.filter((row) => row.record_type === 'adjusted_pair').length, 1);
  const diagnostic = data.records.find((row) => row.record_type === 'lip_reliability');
  assert.equal(diagnostic.reliability, 0);
  assert.ok(diagnostic.note.includes('known=false'));
  assert.ok(!serializeCsv(data.rows).includes('NaN'));
});
