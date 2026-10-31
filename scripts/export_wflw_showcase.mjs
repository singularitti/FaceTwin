/** Export only the five verified WFLW result pairs and explicitly allowed public assets. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = path.resolve(project, process.argv[2] ?? 'runs/facetwin-wflw-test-input-images-output-top5');
const site = path.join(project, 'showcase');
const { parseCSV } = await import(pathToFileURL(path.join(run, 'inputs/scripts/csv.mjs')));
const { FEATURE_DEFINITIONS } = await import(pathToFileURL(path.join(run, 'inputs/source/src/geometry.js')));
const read = relative => parseCSV(fs.readFileSync(path.join(run, relative), 'utf8'));
const table = relative => Object.fromEntries(read(relative).map(r => [r.metric ?? r.key, r.value]));
const ranking = read('outputs/top5.csv');
if (ranking.length !== 5 || ranking.some((r, i) => Number(r.rank) !== i + 1)) throw new Error('Expected verified top five');
const manifest = new Map(read('inputs/manifest.csv').map(r => [r.id, r]));
const featureRows = read('outputs/top5-feature-comparisons.csv');
const groupRows = read('outputs/top5-group-comparisons.csv');
const selected = new Set(ranking.flatMap(r => [r.image_a, r.image_b]));
const raw = new Map();
const lines = readline.createInterface({ input: fs.createReadStream(path.join(run, 'outputs/detections.jsonl')), crlfDelay: Infinity });
for await (const line of lines) {
  const record = JSON.parse(line);
  if (selected.has(record.id)) raw.set(record.id, record);
}
if (raw.size !== selected.size) throw new Error('Missing original inference evidence');
const rankingSummary = table('outputs/ranking-summary.csv');
const inference = table('outputs/inference-metadata.csv');
const versions = table('inputs/versions.csv');
const integrity = [];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const copy = (source, relative, expectedHash) => {
  const bytes = fs.readFileSync(source);
  const sha256 = hash(bytes);
  if (expectedHash && sha256 !== expectedHash) throw new Error('Input hash changed');
  const destination = path.join(site, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  integrity.push({ path: relative, bytes: bytes.length, sha256 });
};
const warningLabels = { small: '脸部较小', pose: '姿态或遮挡提示', expression: '表情提示', clipped: '轮廓近边缘' };
const points = value => value.map(p => ({ x: p.x, y: p.y }));
const photo = id => {
  if (!/^W\d{4}$/.test(id)) throw new Error('Unexpected dataset ID');
  const m = manifest.get(id), r = raw.get(id);
  if (r.status !== 'valid') throw new Error('Invalid record among winners');
  const imagePath = 'assets/faces/' + id + '.png';
  copy(path.join(run, 'inputs/crops', m.crop_file), imagePath, m.crop_sha256);
  return { id, src: './' + imagePath, width: Number(m.width), height: Number(m.height),
    warnings: r.quality.warnings.map(w => ({ code: w.code, label: warningLabels[w.code] ?? w.code })),
    mode: r.mode, sourceDatasetFile: m.source_image,
    points: points(r.response.landmarkVariants[r.mode].landmarks),
    originalPoints: r.mode === 'upright' ? points(r.response.landmarkVariants.original.landmarks) : null,
    metrics: r.metrics };
};
const notes = [
  '两图都有小脸和姿态提示。几何比例接近，不代表人眼一定觉得相似。',
  '视觉复核发现：疑似同一底图的不同水印版本。保留原始排名，不能作为不同人相似的证据。',
  '两图脸部都较小；左图还有姿态提示。定位误差可能影响这些比例。',
  '两图都有表情提示，左图脸部较小。笑容会改变部分测量比例。',
  '两图都有表情提示，右图还有姿态提示。请结合关键点位置理解分数。',
];
const result = {
  schemaVersion: 1,
  run: { dataset: 'WFLW', split: '官方测试集', date: '2026-10-31',
    recordCount: Number(rankingSummary.input_records), validCount: Number(rankingSummary.valid_records),
    noFaceCount: Number(rankingSummary['excluded_no-face']), multipleFaceCount: Number(rankingSummary['excluded_multiple-faces']),
    pairCount: Number(rankingSummary.compared_pairs), inferenceSeconds: Number(inference.wall_seconds),
    pairScoringSeconds: Number(rankingSummary.ranking_and_csv_wall_seconds), sourceCommit: versions.source_commit.slice(0, 7) },
  sources: [
    { label: 'WFLW / LAB 官方项目', url: 'https://github.com/wywu/LAB' },
    { label: 'Wu et al. · Look at Boundary · CVPR 2018', url: 'https://openaccess.thecvf.com/content_cvpr_2018/html/Wu_Look_at_Boundary_CVPR_2018_paper.html' },
    { label: 'MMPose 数据集与转换标注', url: 'https://github.com/open-mmlab/mmpose/blob/main/docs/en/dataset_zoo/2d_face_keypoint.md' },
  ],
  features: FEATURE_DEFINITIONS.map(({ id, label, group, weight, formula, segments, numeratorMode, denominatorMode }) =>
    ({ id, label, group, weight, formula, segments, numeratorMode, denominatorMode })),
  pairs: ranking.map((r, i) => ({ rank: Number(r.rank), id: 'pair-' + r.rank,
    score: Number(r.adjusted_score), baselineScore: Number(r.baseline_score), coverage: Number(r.coverage),
    lipReliability: Number(r.lip_reliability), duplicateSuspected: Number(r.rank) === 2, note: notes[i],
    a: photo(r.image_a), b: photo(r.image_b),
    measurements: featureRows.filter(f => f.rank === r.rank).map(f => ({ id: f.feature, label: f.label,
      a: Number(f.a), b: Number(f.b), difference: Number(f.difference), effectiveWeight: Number(f.effectiveWeight) })),
    groups: groupRows.filter(g => g.rank === r.rank).map(g => ({ id: g.group, label: g.label,
      baselineScore: Number(g.baseline_group_score), contribution: Number(g.adjusted_distance_contribution) })),
  })),
};
for (const filename of ['top5.csv', 'top5-feature-comparisons.csv', 'verification.csv', 'facetwin-wflw-top5.pdf']) {
  copy(path.join(run, 'outputs', filename), 'assets/downloads/' + filename);
}
fs.mkdirSync(path.join(site, 'data'), { recursive: true });
fs.writeFileSync(path.join(site, 'data/results.json'), JSON.stringify(result) + '\n');
integrity.push({ path: 'data/results.json', bytes: fs.statSync(path.join(site, 'data/results.json')).size,
  sha256: hash(fs.readFileSync(path.join(site, 'data/results.json'))) });
fs.writeFileSync(path.join(site, 'data/asset-manifest.json'), JSON.stringify({ schemaVersion: 1, files: integrity }, null, 2) + '\n');
console.log('Exported 5 verified pairs, 10 public WFLW crops, selected model coordinates, and 4 downloads.');
