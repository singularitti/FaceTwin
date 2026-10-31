/** Verify the complete publication artifact; no inference or synthetic inputs. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../showcase');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const json = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const near = (a, b, label) => assert(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-10, label);

try {
  const data = json('data/results.json'), manifest = json('data/asset-manifest.json');
  assert(data.schemaVersion === 1 && data.pairs.length === 5 && data.features.length === 13, 'Unexpected showcase schema');
  assert(data.run.recordCount === 2500 && data.run.validCount === 2244, 'Run counts changed');
  assert(data.run.noFaceCount + data.run.multipleFaceCount + data.run.validCount === data.run.recordCount, 'Incomplete exclusion accounting');
  assert(data.run.pairCount === data.run.validCount * (data.run.validCount - 1) / 2, 'Incorrect pair count');
  const allowed = new Set(['index.html', 'app.js', 'styles.css', '.nojekyll', 'README.md', 'assets/faces/NOTICE.md', 'data/asset-manifest.json']);
  const uniqueFiles = new Set();
  for (const file of manifest.files) {
    assert(/^(data\/results\.json|assets\/faces\/W\d{4}\.png|assets\/downloads\/(top5\.csv|top5-feature-comparisons\.csv|verification\.csv|facetwin-wflw-top5\.pdf))$/.test(file.path), 'Unexpected published asset');
    assert(!uniqueFiles.has(file.path), 'Duplicate manifest entry'); uniqueFiles.add(file.path); allowed.add(file.path);
    const bytes = fs.readFileSync(path.join(root, file.path));
    assert(bytes.length === file.bytes && crypto.createHash('sha256').update(bytes).digest('hex') === file.sha256, 'Published asset hash mismatch: ' + file.path);
    if (file.path.endsWith('.png')) {
      assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Invalid PNG');
      let offset = 8;
      while (offset < bytes.length) {
        const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
        assert(!['eXIf', 'tEXt', 'zTXt', 'iTXt'].includes(type), 'Unexpected image metadata');
        offset += size + 12;
      }
      assert(offset === bytes.length, 'Invalid PNG chunks');
    }
  }
  assert(manifest.files.length === 15, 'Expected ten faces, four downloads, and result data');
  const observed = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Publication directory must not contain symlinks');
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(absolute); continue; }
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      assert(allowed.has(relative), 'Unexpected file in publication: ' + relative);
      observed.push(relative);
      if (/\.(?:html|js|css|json|csv|md)$/.test(relative)) {
        const text = fs.readFileSync(absolute, 'utf8');
        assert(!/(?:\/Users\/|\/home\/|file:\/\/|github_pat_|ghp_[A-Za-z0-9]{20}|sk-[A-Za-z0-9]{24})/.test(text), 'Local path or credential-like data in publication');
      }
    }
  };
  visit(root);
  assert(observed.length === allowed.size, 'Missing publication files');
  const ids = new Set();
  const groups = [...new Set(data.features.map(f => f.group))];
  assert(groups.length === 5, 'Expected five geometry groups');
  for (const [i, pair] of data.pairs.entries()) {
    assert(pair.rank === i + 1 && pair.id === 'pair-' + pair.rank, 'Unexpected pair order');
    assert(pair.score >= (data.pairs[i + 1]?.score ?? 0), 'Ranking is not descending');
    assert(pair.duplicateSuspected === (pair.rank === 2), 'Missing duplicate-image review note');
    assert(pair.measurements.length === 13 && pair.groups.length === 5, 'Incomplete measurement evidence');
    for (const photo of [pair.a, pair.b]) {
      assert(/^W\d{4}$/.test(photo.id) && !ids.has(photo.id), 'Unexpected repeated record'); ids.add(photo.id);
      assert(photo.src === './assets/faces/' + photo.id + '.png', 'Image ID/path mismatch');
      assert(photo.points.length === 478 && photo.width > 0 && photo.height > 0, 'Invalid image geometry');
      const image = fs.readFileSync(path.join(root, photo.src));
      assert(image.readUInt32BE(16) === photo.width && image.readUInt32BE(20) === photo.height, 'Image/overlay dimensions disagree');
      const length = ([a, b]) => Math.hypot((photo.points[a].x - photo.points[b].x) * photo.width,
        (photo.points[a].y - photo.points[b].y) * photo.height);
      for (const f of data.features) {
        const measurement = kind => {
          const values = f.segments[kind].map(length);
          return values.reduce((a, b) => a + b, 0) / (f[kind + 'Mode'] === 'sum' ? 1 : values.length);
        };
        near(measurement('numerator') / measurement('denominator'), photo.metrics[f.id], 'Coordinates do not reproduce published measurement');
      }
    }
    const diffs = data.features.map(f => Math.abs(pair.a.metrics[f.id] - pair.b.metrics[f.id]) / Math.max((pair.a.metrics[f.id] + pair.b.metrics[f.id]) / 2, .01));
    const baselineExponent = groups.map(g => data.features.flatMap((f, k) => f.group === g ? [diffs[k] / .2] : []))
      .map(values => values.reduce((a, b) => a + b, 0) / values.length).reduce((a, b) => a + b, 0) / groups.length;
    const baseline = 100 * Math.exp(-baselineExponent);
    const weights = data.features.map(f => f.weight * (f.id === 'lipThickness' ? pair.lipReliability : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    const adjusted = pair.lipReliability === 1 ? baseline : 100 * Math.exp(-diffs.reduce((sum, d, k) => sum + d * weights[k] / total, 0) / .2);
    near(baseline, pair.baselineScore, 'Original score mismatch'); near(adjusted, pair.score, 'Adjusted score mismatch');
    near(total / data.features.reduce((s, f) => s + f.weight, 0), pair.coverage, 'Coverage mismatch');
    for (const [k, f] of data.features.entries()) {
      const row = pair.measurements[k];
      assert(row.id === f.id, 'Measurement table order mismatch');
      near(row.a, pair.a.metrics[f.id], 'First displayed ratio mismatch');
      near(row.b, pair.b.metrics[f.id], 'Second displayed ratio mismatch');
      near(row.difference, diffs[k], 'Displayed difference mismatch');
      near(row.effectiveWeight, weights[k] / total, 'Displayed effective weight mismatch');
    }
  }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert(/lang="zh-CN"/.test(html), 'Missing page language');
  assert(html.includes('Content-Security-Policy'), 'Missing restrictive content policy');
  for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (url.startsWith('#') || url.startsWith('https://') || url.startsWith('data:image/')) continue;
    assert(url.startsWith('./') && !url.includes('..'), 'Site must use relative project-subpath links');
    assert(fs.existsSync(path.join(root, url.split('#')[0])), 'Broken local HTML reference');
  }
  console.log('Verified publication: 5 pairs, 10 image hashes/dimensions, 130 coordinate-derived ratios, scores, exclusions, downloads, and allowed files.');
} catch (error) {
  console.error('Showcase verification failed:', error.message);
  process.exitCode = 1;
}
