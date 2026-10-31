import { FEATURE_DEFINITIONS, GROUP_DEFINITIONS, extractGeometry, aggregateComparisons, summarizeQuality } from './geometry.js';

const $ = (selector, scope = document) => scope.querySelector(selector);
const MAX_PHOTOS = 8;
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 32_000_000;
const MAX_EDGE = 1600;
const state = {
  photos: { a: [], b: [] }, selected: { a: 0, b: 0 },
  overlay: 'contours', metric: FEATURE_DEFINITIONS[0].id, pointLabels: false,
  connections: { mesh: [], contours: [] }, results: null,
  busy: false, importing: false, ready: false,
};
let worker;
let enginePromise;
let requestId = 0;
const pending = new Map();
const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const label = (side, index) => `${side.toUpperCase()}${index + 1}`;
const current = (side) => state.photos[side][state.selected[side]];
const isLocked = () => state.busy || state.importing;

function showError(message = '') {
  $('#global-error').textContent = message;
  $('#global-error').hidden = !message;
}

function status(message, kind = '') {
  $('#model-state').className = `model-status ${kind}`;
  $('#model-state').replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  $('#model-state').append(dot, document.createTextNode(message));
}

function invalidateResults() {
  state.results = null;
  $('#results').hidden = true;
  $('#empty-results').hidden = false;
}

function updateControls() {
  $('#compare').disabled = isLocked() || !state.photos.a.length || !state.photos.b.length;
  $('#compare').textContent = state.busy ? '正在计算…' : '开始比较 ↗';
  $('#clear-all').disabled = isLocked() || (!state.photos.a.length && !state.photos.b.length);
  $('#load-model').disabled = isLocked() || state.ready;
  $('#load-model').textContent = state.ready ? '已加载' : '预先加载';
  document.querySelectorAll('.add-photo,.remove-photo,.upload-empty,input[type="file"]').forEach((button) => { button.disabled = isLocked(); });
}

async function addPhotos(side, files) {
  if (isLocked()) return;
  state.importing = true;
  showError();
  updateControls();
  const errors = [];
  const selectedFiles = Array.from(files);
  const available = MAX_PHOTOS - state.photos[side].length;
  if (selectedFiles.length > available) errors.push(`每组最多 ${MAX_PHOTOS} 张；超出的照片未加入。`);
  try {
    for (const file of selectedFiles.slice(0, available)) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        errors.push('有文件格式不支持。请使用 JPG、PNG 或 WebP；HEIC 请先导出为 JPEG。');
        continue;
      }
      if (file.size > MAX_BYTES) { errors.push('有照片超过 12 MB，请缩小后再试。'); continue; }
      const url = URL.createObjectURL(file);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (!width || !height || width * height > MAX_PIXELS) {
          URL.revokeObjectURL(url);
          errors.push('有照片超过 3200 万像素或尺寸无效，请先缩小照片。');
          continue;
        }
        state.photos[side].push({ url, image, width, height, result: null, error: '', quality: null });
        invalidateResults();
      } catch (_error) {
        URL.revokeObjectURL(url);
        errors.push('有照片无法解码，请重新导出为 JPG 或 PNG。');
      }
    }
  } finally {
    state.importing = false;
    renderPanels();
    updateControls();
    if (errors.length) showError([...new Set(errors)].join('\n'));
  }
}

function removePhoto(side, index) {
  if (isLocked()) return;
  const [photo] = state.photos[side].splice(index, 1);
  if (photo) URL.revokeObjectURL(photo.url);
  state.selected[side] = Math.max(0, Math.min(state.selected[side], state.photos[side].length - 1));
  invalidateResults();
  renderPanels();
  updateControls();
  $('#progress').textContent = '照片已更改，点击开始比较以更新汇总。';
}

function renderPanels() {
  const container = $('#photo-panels');
  container.replaceChildren();
  for (const side of ['a', 'b']) {
    const photos = state.photos[side];
    const photo = current(side);
    const panel = document.createElement('article');
    panel.className = 'photo-panel';
    panel.dataset.side = side;
    panel.innerHTML = `
      <div class="panel-top"><div class="person-label"><span class="person-letter">${side.toUpperCase()}</span><span>人物 ${side.toUpperCase()}</span></div><span class="counter">${photos.length} / ${MAX_PHOTOS} 张</span></div>
      <input class="visually-hidden" id="files-${side}" type="file" accept="image/jpeg,image/png,image/webp" multiple aria-label="为人物 ${side.toUpperCase()} 选择照片">
      <div class="photo-stage ${photo ? 'has-photo' : ''}">
        ${photo ? `<canvas aria-label="人物 ${side.toUpperCase()} 的照片与关键点"></canvas><span class="photo-caption">${label(side, state.selected[side])} · ${photo.width} × ${photo.height}</span><span class="photo-status"></span>` : `<button class="upload-empty" aria-label="选择人物 ${side.toUpperCase()} 的照片"><div class="upload-glyph" aria-hidden="true"><span></span></div><strong>选择照片，或拖放到这里</strong><span class="small">一张起步，多张更完整</span><span class="format-hint">JPG / PNG / WEBP · ≤ 12 MB</span></button>`}
      </div>
      <div class="thumbnail-row"></div><ul class="quality-list"></ul><p class="photo-error" hidden></p>`;
    const input = $('input[type="file"]', panel);
    input.addEventListener('change', () => addPhotos(side, input.files));
    $('.upload-empty', panel)?.addEventListener('click', () => input.click());
    const stage = $('.photo-stage', panel);
    for (const event of ['dragenter', 'dragover']) stage.addEventListener(event, (e) => { e.preventDefault(); if (!isLocked()) stage.classList.add('dragging'); });
    stage.addEventListener('dragleave', () => stage.classList.remove('dragging'));
    stage.addEventListener('drop', (e) => { e.preventDefault(); stage.classList.remove('dragging'); addPhotos(side, e.dataTransfer.files); });
    const row = $('.thumbnail-row', panel);
    photos.forEach((item, index) => {
      const wrap = document.createElement('div');
      wrap.className = 'thumb-wrap';
      const button = document.createElement('button');
      button.className = 'thumbnail';
      button.setAttribute('aria-label', `查看照片 ${label(side, index)}`);
      button.setAttribute('aria-pressed', String(index === state.selected[side]));
      const thumbnail = document.createElement('img');
      thumbnail.src = item.url;
      thumbnail.alt = label(side, index);
      button.append(thumbnail);
      button.addEventListener('click', () => { state.selected[side] = index; renderPanels(); updatePairSelection(); updateControls(); });
      const remove = document.createElement('button');
      remove.className = 'remove-photo';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `移除照片 ${label(side, index)}`);
      remove.addEventListener('click', () => removePhoto(side, index));
      wrap.append(button, remove);
      row.append(wrap);
    });
    if (photos.length && photos.length < MAX_PHOTOS) {
      const add = document.createElement('button');
      add.className = 'add-photo';
      add.textContent = '＋ 添加';
      add.setAttribute('aria-label', `为人物 ${side.toUpperCase()} 添加照片`);
      add.addEventListener('click', () => input.click());
      row.append(add);
    }
    if (photo) {
      const badge = $('.photo-status', panel);
      badge.textContent = photo.error ? '未纳入比较' : photo.result ? (photo.quality?.warnings.length ? '已测量 · 有拍摄提示' : `${photo.landmarks.length} 个关键点`) : '等待分析';
      badge.classList.toggle('error', Boolean(photo.error));
      badge.classList.toggle('warning', Boolean(photo.quality?.warnings.length));
      for (const warning of photo.quality?.warnings ?? []) {
        const li = document.createElement('li');
        li.textContent = '↳ ' + warning.message;
        $('.quality-list', panel).append(li);
      }
      if (photo.error) {
        $('.photo-error', panel).hidden = false;
        $('.photo-error', panel).textContent = photo.error;
      }
    }
    container.append(panel);
  }
  drawAll();
  updateControls();
}

function drawConnections(ctx, points, connections, map, color, lineWidth = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  for (const { start, end } of connections) {
    if (!points[start] || !points[end]) continue;
    const a = map(points[start]);
    const b = map(points[end]);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
}

function drawPhoto(side) {
  const photo = current(side);
  const panel = $(`.photo-panel[data-side="${side}"]`);
  const canvas = $('canvas', panel);
  if (!photo || !canvas) return;
  const stage = $('.photo-stage', panel);
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const scale = Math.min(width / photo.width, height / photo.height);
  const w = photo.width * scale;
  const h = photo.height * scale;
  const x = (width - w) / 2;
  const y = (height - h) / 2;
  ctx.drawImage(photo.image, x, y, w, h);
  if (!photo.landmarks || state.overlay === 'none') return;
  const points = photo.landmarks;
  const map = (point) => ({ x: x + point.x * w, y: y + point.y * h });
  const color = side === 'a' ? '#cbf3ad' : '#ffe0b1';
  if (state.overlay === 'mesh') drawConnections(ctx, points, state.connections.mesh, map, side === 'a' ? '#c9efad88' : '#ffdfad88', .55);
  if (state.overlay !== 'measure') drawConnections(ctx, points, state.connections.contours, map, color, 1.1);
  let visiblePoints = [];
  if (state.overlay === 'measure') {
    const feature = FEATURE_DEFINITIONS.find((item) => item.id === state.metric);
    for (const [kind, segmentColor] of [['denominator', '#f0e0b0'], ['numerator', '#8ef4e5']]) {
      const connections = feature.segments[kind].map(([start, end]) => ({ start, end }));
      drawConnections(ctx, points, connections, map, '#152b29bb', 4);
      drawConnections(ctx, points, connections, map, segmentColor, 2);
    }
    visiblePoints = [...new Set([...feature.segments.numerator, ...feature.segments.denominator].flat())];
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#17332de6';
    ctx.fillRect(8, height - 49, 151, 19);
    ctx.fillStyle = '#8ef4e5';
    ctx.fillText('青色：分子', 14, height - 36);
    ctx.fillStyle = '#f0e0b0';
    ctx.fillText('米色：分母', 83, height - 36);
  } else if (state.pointLabels) {
    visiblePoints = [...new Set(FEATURE_DEFINITIONS.flatMap((item) => [...item.segments.numerator, ...item.segments.denominator].flat()))];
  }
  for (const index of visiblePoints) {
    const point = map(points[index]);
    ctx.beginPath(); ctx.arc(point.x, point.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = '#fffce4'; ctx.fill();
    if (state.pointLabels) {
      ctx.font = '8px monospace';
      ctx.lineWidth = 2; ctx.strokeStyle = '#1d342e';
      ctx.strokeText(String(index), point.x + 4, point.y - 3);
      ctx.fillText(String(index), point.x + 4, point.y - 3);
    }
  }
}

function drawAligned() {
  const canvas = $('#aligned-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const photos = ['a', 'b'].map((side) => current(side));
  const all = photos.flatMap((photo) => photo?.result?.normalizedLandmarks.filter(Boolean) ?? []);
  if (!all.length) return;
  const minX = Math.min(...all.map((p) => p.x));
  const maxX = Math.max(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y));
  const maxY = Math.max(...all.map((p) => p.y));
  const scale = Math.min((canvas.width - 90) / (maxX - minX), (canvas.height - 65) / (maxY - minY));
  const map = (p) => ({ x: canvas.width / 2 + (p.x - (minX + maxX) / 2) * scale, y: canvas.height / 2 + (p.y - (minY + maxY) / 2) * scale });
  photos.forEach((photo, index) => {
    if (photo?.result) drawConnections(ctx, photo.result.normalizedLandmarks, state.connections.contours, map, index ? '#bf7856cc' : '#456b58cc', 1.6);
  });
}

function drawAll() { drawPhoto('a'); drawPhoto('b'); if (state.results) drawAligned(); }

function resetWorker() {
  worker?.terminate();
  worker = null;
  enginePromise = null;
  state.ready = false;
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('计算已中断，请重新开始比较。')); }
  pending.clear();
}

function request(type, payload = {}, transfers = []) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('本机计算超时，请刷新后重试，或换用桌面版 Chrome / Edge。'));
      resetWorker();
    }, type === 'initialize' ? 90000 : 45000);
    pending.set(id, { resolve, reject, timer });
    try { worker.postMessage({ id, type, ...payload }, transfers); }
    catch (_error) { pending.delete(id); clearTimeout(timer); payload.bitmap?.close(); reject(new Error('无法启动浏览器推理，请换用支持 WebAssembly 的现代浏览器。')); }
  });
}

async function ensureEngine() {
  if (state.ready) return;
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    if (!window.Worker || !window.createImageBitmap || !window.OffscreenCanvas) throw new Error('此浏览器缺少所需的图片或 Worker 功能，请使用近期版本的 Chrome / Edge。');
    status('正在加载本地模型…');
    // The pinned MediaPipe WASM loader uses importScripts(), requiring a classic Worker.
    worker = new Worker(new URL('./inference.worker.js', import.meta.url));
    worker.onmessage = ({ data }) => {
      const item = pending.get(data.id);
      if (!item) return;
      clearTimeout(item.timer); pending.delete(data.id);
      data.ok ? item.resolve(data) : item.reject(new Error(data.error));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('推理组件未能加载。请运行 uv run python scripts/setup_assets.py，并通过本地服务器打开页面。')); }
      pending.clear(); resetWorker();
    };
    const response = await request('initialize');
    state.connections = response.connections;
    state.ready = true;
    status('本地模型已就绪', 'ready');
  })();
  try { return await enginePromise; }
  catch (error) { resetWorker(); status('模型未就绪', 'error'); throw error; }
}

async function analyze() {
  if (isLocked()) return;
  state.busy = true;
  showError();
  invalidateResults();
  updateControls();
  try {
    await ensureEngine();
    const total = state.photos.a.length + state.photos.b.length;
    let completed = 0;
    for (const side of ['a', 'b']) {
      for (const [index, photo] of state.photos[side].entries()) {
        $('#progress').textContent = `正在分析 ${label(side, index)} · ${completed + 1} / ${total}`;
        if (!photo.result) {
          photo.error = '';
          try {
            const scale = Math.min(1, MAX_EDGE / Math.max(photo.width, photo.height));
            const width = Math.max(1, Math.round(photo.width * scale));
            const height = Math.max(1, Math.round(photo.height * scale));
            const bitmap = await createImageBitmap(photo.image, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
            const response = await request('detect', { bitmap }, [bitmap]);
            const faces = response.faceLandmarks;
            if (!faces.length) throw new Error('未检测到人脸。请使用清晰、无遮挡的正面照片。');
            if (faces.length !== 1) throw new Error('检测到多张脸。请裁剪到一人后重新加入；此照片未参与评分。');
            const geometry = extractGeometry(faces[0], width, height);
            if (!geometry.valid) throw new Error('关键点未形成完整有效的比例，请换一张照片。');
            photo.landmarks = faces[0];
            photo.result = geometry;
            photo.quality = summarizeQuality(faces[0], width, height, response.faceBlendshapes[0]?.categories ?? []);
          } catch (error) {
            photo.error = error.message;
            if (!state.ready) throw error;
          }
        }
        completed += 1;
        renderPanels();
      }
    }
    const result = aggregateComparisons(state.photos.a.map((p) => p.result), state.photos.b.map((p) => p.result));
    if (!result.valid) throw new Error('两组都需要至少一张能检测到单个人脸的照片。请查看各张照片的提示后重试。');
    state.results = result;
    // Select a valid pair if the current selection is excluded.
    for (const side of ['a', 'b']) if (!current(side)?.result) state.selected[side] = state.photos[side].findIndex((p) => p.result);
    renderPanels();
    renderResults();
    const excluded = result.excluded.a.length + result.excluded.b.length;
    $('#progress').textContent = `已比较 ${result.validPhotoCounts.a} × ${result.validPhotoCounts.b} = ${result.pairScores.length} 个有效配对${excluded ? `；${excluded} 张照片未纳入，见照片提示` : '。'}`;
    status('本地计算完成', 'ready');
  } catch (error) {
    showError(error.message || '比较未完成，请重试。');
    $('#progress').textContent = '比较未完成。照片仍保留在当前页面。';
  } finally {
    state.busy = false;
    updateControls();
  }
}

function renderResults() {
  const result = state.results;
  $('#results').hidden = false;
  $('#empty-results').hidden = true;
  $('#overall-score').textContent = number(result.median);
  $('#range-stats').innerHTML = `<div>最低 — 最高<strong>${number(result.min)} – ${number(result.max)}</strong></div><div>四分位距<strong>${number(result.iqr)}</strong></div><div>有效配对<strong>${result.pairScores.length}</strong></div>`;
  $('#group-bars').innerHTML = GROUP_DEFINITIONS.map((group) => `<div class="group-row"><div class="group-label"><span>${group.label}</span><strong>${number(result.groupMedians[group.id])}</strong></div><div class="bar-track"><div class="bar-fill" style="width:${result.groupMedians[group.id]}%"></div></div></div>`).join('');
  $('#pair-count').textContent = `${result.validPhotoCounts.a} × ${result.validPhotoCounts.b} 个有效配对`;
  const matrix = document.createElement('table');
  matrix.className = 'matrix';
  matrix.setAttribute('aria-label', 'A 组与 B 组每张照片的几何接近度');
  matrix.innerHTML = `<thead><tr><th>A / B</th>${state.photos.b.map((_, i) => `<th scope="col">${label('b', i)}</th>`).join('')}</tr></thead><tbody></tbody>`;
  result.pairMatrix.forEach((row, a) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<th scope="row">${label('a', a)}</th>`;
    row.forEach((score, b) => {
      const td = document.createElement('td');
      const button = document.createElement('button');
      button.textContent = number(score, 0);
      button.disabled = score === null;
      button.dataset.a = a; button.dataset.b = b;
      button.setAttribute('aria-label', `${label('a', a)} 与 ${label('b', b)}：${score === null ? '无效配对' : number(score) + ' 分'}`);
      if (score !== null) button.style.backgroundColor = `hsl(82 28% ${97 - score * .23}%)`;
      button.addEventListener('click', () => {
        state.selected.a = a; state.selected.b = b;
        renderPanels(); updatePairSelection();
      });
      td.append(button); tr.append(td);
    });
    $('tbody', matrix).append(tr);
  });
  $('#pair-matrix').replaceChildren(matrix);
  $('#feature-rows').innerHTML = FEATURE_DEFINITIONS.map((feature) => `<tr data-feature="${feature.id}"><td>${feature.label}<span class="feature-desc">${feature.explanation}</span></td><td>${number(result.metricRawMedians.a[feature.id], 3)}</td><td>${number(result.metricRawMedians.b[feature.id], 3)}</td><td>${number(result.metricDifferenceMedians[feature.id] * 100)}%</td><td><button data-measure="${feature.id}" aria-label="查看${feature.label}测量线">查看测量 ↗</button></td></tr>`).join('');
  $('#feature-rows').querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
    state.metric = button.dataset.measure;
    setOverlay('measure');
    $('#metric-select').value = state.metric;
    $('.workspace').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  }));
  updatePairSelection();
  updateFeatureSelection();
}

function updatePairSelection() {
  if (!state.results) return;
  document.querySelectorAll('.matrix button').forEach((button) => button.setAttribute('aria-pressed', String(+button.dataset.a === state.selected.a && +button.dataset.b === state.selected.b)));
  const pair = state.results.pairs.find((p) => p.aIndex === state.selected.a && p.bIndex === state.selected.b);
  $('#pair-detail').innerHTML = pair ? `当前查看 <strong>${label('a', state.selected.a)} × ${label('b', state.selected.b)}</strong> · 几何接近度 <strong>${number(pair.score)} / 100</strong>` : '当前选中照片未形成有效配对。';
  drawAligned();
}

function updateFeatureSelection() {
  document.querySelectorAll('[data-feature]').forEach((row) => row.classList.toggle('selected', row.dataset.feature === state.metric && state.overlay === 'measure'));
}

function setOverlay(mode) {
  state.overlay = mode;
  document.querySelectorAll('[data-overlay]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.overlay === mode)));
  $('.metric-picker').hidden = mode !== 'measure';
  updateFeatureSelection();
  drawAll();
}

function exportCsv() {
  if (!state.results) return;
  const rows = [['record_type', 'photo_a', 'photo_b', 'group', 'feature', 'value_a', 'value_b', 'relative_difference', 'score', 'note']];
  rows.push(['metadata', '', '', '', 'method', '', '', '', '', 'FaceTwin 0.1; MediaPipe Tasks Vision 0.10.21; face_landmarker float16/1; geometry only; scale=0.20; floor=0.01; 5 equal-weight groups; not calibrated to human ratings']);
  rows.push(['summary', '', '', '', 'median', '', '', '', state.results.median, 'All valid cross-photo pairs']);
  for (const key of ['min', 'max', 'q1', 'q3', 'iqr']) rows.push(['summary', '', '', '', key, '', '', '', state.results[key], 'Descriptive photo variation, not a confidence interval']);
  for (const pair of state.results.pairs) {
    rows.push(['pair', label('a', pair.aIndex), label('b', pair.bIndex), '', '', '', '', pair.meanDifference, pair.score, '']);
    for (const feature of FEATURE_DEFINITIONS) {
      const item = pair.metrics[feature.id];
      rows.push(['feature', label('a', pair.aIndex), label('b', pair.bIndex), feature.group, feature.id, item.a, item.b, item.difference, item.score, feature.formula]);
    }
  }
  for (const side of ['a', 'b']) state.photos[side].forEach((photo, index) => {
    rows.push(['photo_status', side === 'a' ? label(side, index) : '', side === 'b' ? label(side, index) : '', '', '', '', '', '', '', photo.error || photo.quality?.warnings.map((w) => w.message).join(' | ') || 'Measured']);
  });
  const csv = rows.map((row) => row.map((cell) => '"' + String(cell).replaceAll('"', '""') + '"').join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'facetwin-geometry.csv';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#metric-select').innerHTML = FEATURE_DEFINITIONS.map((feature) => `<option value="${feature.id}">${feature.label}</option>`).join('');
$('#metric-select').addEventListener('change', (event) => { state.metric = event.target.value; drawAll(); updateFeatureSelection(); });
document.querySelectorAll('[data-overlay]').forEach((button) => button.addEventListener('click', () => setOverlay(button.dataset.overlay)));
$('#show-points').addEventListener('change', (event) => { state.pointLabels = event.target.checked; drawAll(); });
$('#compare').addEventListener('click', analyze);
$('#load-model').addEventListener('click', async () => {
  if (isLocked()) return;
  state.busy = true;
  showError();
  updateControls();
  try {
    await ensureEngine();
    $('#progress').textContent = '模型已在本地就绪。加入两组照片即可比较。';
  } catch (error) {
    showError(error.message);
  } finally {
    state.busy = false;
    updateControls();
  }
});
$('#export-csv').addEventListener('click', exportCsv);
$('#clear-all').addEventListener('click', () => {
  if (isLocked()) return;
  for (const photos of Object.values(state.photos)) for (const photo of photos) URL.revokeObjectURL(photo.url);
  state.photos = { a: [], b: [] }; state.selected = { a: 0, b: 0 };
  invalidateResults(); showError(); renderPanels(); updateControls();
  $('#progress').textContent = '照片已清空。每组可放入 1–8 张新照片。';
});
window.addEventListener('resize', drawAll);
window.addEventListener('pagehide', () => { resetWorker(); });
// Prevent browser navigation when files are dropped just outside a panel.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
renderPanels();
updateControls();
