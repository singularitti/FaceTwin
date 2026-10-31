import { FEATURE_DEFINITIONS, GROUP_DEFINITIONS, aggregateComparisons } from './geometry.js';
import { comparisonDiagnostics } from './diagnostics.js';
import { isSupportedImage, loadPhoto } from './media.js';
import { analyzeLipReliability, LIP_SIGNAL_DEFINITIONS } from './expression.js';
import { aggregateAdjusted, withinGroupAdjusted, summarizeLipReference } from './adjustment.js';
import { buildExportRows, serializeCsv } from './export.js';
import { prepareLandmarkChoices, applyLandmarkChoice } from './landmarks.js';

const $ = (selector, scope = document) => scope.querySelector(selector);
const MAX_PHOTOS = 8;
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 32_000_000;
const state = {
  photos: { a: [], b: [] }, selected: { a: 0, b: 0 },
  overlay: 'contours', metric: FEATURE_DEFINITIONS[0].id, pointLabels: false,
  connections: { mesh: [], contours: [], faceOval: [] }, results: null, adjusted: null,
  busy: false, importing: false, ready: false, faceZoom: true,
};
let worker;
let enginePromise;
let requestId = 0;
const pending = new Map();
const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const label = (side, index) => `${side.toUpperCase()}${index + 1}`;
const current = (side) => state.photos[side][state.selected[side]];
const isLocked = () => state.busy || state.importing;
const modeLabel = (mode) => ({ auto: '自动', include: '手动保留', exclude: '手动排除' }[mode] ?? '自动');
const reliability = (photo) => photo.lip?.reliability ?? 0;
const hasPoseWarning = (photo) => photo?.quality?.warnings.some((warning) => warning.code === 'pose');

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
  state.adjusted = null;
  $('#results').hidden = true;
  $('#empty-results').hidden = false;
}

function updateControls() {
  $('#compare').disabled = isLocked() || !state.photos.a.length || !state.photos.b.length;
  $('#compare').textContent = state.busy ? '正在计算…' : '开始比较 ↗';
  $('#clear-all').disabled = isLocked() || (!state.photos.a.length && !state.photos.b.length);
  $('#load-model').disabled = isLocked() || state.ready;
  $('#load-model').textContent = state.ready ? '已加载' : '预先加载';
  document.querySelectorAll('.add-photo,.remove-photo,.upload-empty,input[type="file"],.lip-mode,.landmark-mode').forEach((button) => { button.disabled = isLocked(); });
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
      if (!isSupportedImage(file)) {
        errors.push('有文件格式不支持。请使用 JPG、PNG、WebP、HEIC 或 HEIF。');
        continue;
      }
      if (file.size > MAX_BYTES) { errors.push('有照片超过 12 MB，请缩小后再试。'); continue; }
      let photo;
      try {
        $('#progress').textContent = '正在读取照片；HEIF 必要时由本机解码…';
        photo = await loadPhoto(file);
        const { image, url } = photo;
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (!width || !height || width * height > MAX_PIXELS) {
          URL.revokeObjectURL(url);
          errors.push('有照片超过 3200 万像素或尺寸无效，请先缩小照片。');
          continue;
        }
        state.photos[side].push({ ...photo, width, height, result: null, error: '', quality: null, blendshapes: [], lip: null, lipMode: 'auto' });
        invalidateResults();
      } catch (error) {
        if (photo?.url) URL.revokeObjectURL(photo.url);
        errors.push(error.message || '有照片无法解码，请确认文件完整。');
      }
    }
  } finally {
    state.importing = false;
    renderPanels();
    updateControls();
    $('#progress').textContent = '照片读取完毕，点击开始比较。';
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
      <input class="visually-hidden" id="files-${side}" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,.hif" multiple aria-label="为人物 ${side.toUpperCase()} 选择照片">
      <div class="photo-stage ${photo ? 'has-photo' : ''}">
        ${photo ? `<img class="source-photo" alt="${label(side, state.selected[side])} 的照片"><canvas aria-label="人物 ${side.toUpperCase()} 的关键点图层"></canvas><span class="photo-caption">${label(side, state.selected[side])} · ${photo.width} × ${photo.height}</span><span class="photo-status"></span>` : `<button class="upload-empty" aria-label="选择人物 ${side.toUpperCase()} 的照片"><div class="upload-glyph" aria-hidden="true"><span></span></div><strong>选择照片，或拖放到这里</strong><span class="small">一张起步，多张更完整</span><span class="format-hint">JPG / PNG / WEBP / HEIF · ≤ 12 MB</span></button>`}
      </div>
      <div class="thumbnail-row"></div><p class="color-note small muted" hidden></p><p class="crop-note small muted" hidden></p><ul class="quality-list"></ul><div class="orientation-assessment" hidden></div><div class="lip-assessment" hidden></div><p class="photo-error" hidden></p>`;
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
      $('.source-photo', panel).src = photo.url;
      if (photo.colorNote) {
        $('.color-note', panel).textContent = photo.colorNote;
        $('.color-note', panel).hidden = false;
      }
      if (photo.detectionInfo) {
        const info = photo.detectionInfo;
        const method = info.method.includes('upright') ? '旋正裁剪复测' : info.method.includes('refined') ? '裁剪复测' : '定位';
        $('.crop-note', panel).textContent = `${info.method.includes('tile') ? '分区搜索后' : '整图搜索后'}${method} · 原图脸部宽约 ${number(info.sourceFaceWidthPx, 0)} px · 原文件未修改。`;
        $('.crop-note', panel).hidden = false;
      }
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
      if (photo.result) renderOrientationAssessment($('.orientation-assessment', panel), photo, label(side, state.selected[side]));
      if (photo.result && photo.lip) renderLipAssessment($('.lip-assessment', panel), photo, label(side, state.selected[side]));
    }
    container.append(panel);
  }
  drawAll();
  updateControls();
}

function renderOrientationAssessment(container, photo, photoLabel) {
  const info = photo.orientationInfo;
  if (!info) return;
  container.hidden = false;
  const title = document.createElement('strong');
  title.textContent = '倾斜定位检查';
  const description = document.createElement('p');
  description.className = 'small';
  const reasons = {
    'not-needed': '倾斜未达到复测阈值，沿用原始定位。',
    stable: '两次定位通过一致性检查，默认采用旋正复测。',
    'contour-disagreement': '两次轮廓差异较大，默认保留原始定位；请对照照片手动选择。',
    'anchor-disagreement': '两次眼鼻嘴位置差异较大，已保留原始定位。',
    'no-face': '旋正后未检测到脸，已保留原始定位。',
    'invalid-geometry': '无法可靠计算倾斜，已保留原始定位。',
    'invalid-refinement': '旋正关键点未形成有效比例，已保留原始定位。',
    failed: '旋正复测未完成，已保留原始定位。',
  };
  description.textContent = `眼线倾斜 ${number(info.eyeLineRollDegrees)}°。${reasons[info.reason] ?? '请检查关键点是否贴合。'}当前：${photo.landmarkMode === 'upright' ? '旋正复测' : '原始定位'}。一致不代表更准确。`;
  const note = document.createElement('p');
  note.className = 'small muted';
  note.textContent = hasPoseWarning(photo)
    ? '橙色虚线表示侧脸提示下的整圈估计轮廓，不是逐点置信度或真实可见边缘；被遮挡的一侧仍由模型推测。旋正只处理画面内倾斜。'
    : '旋正只处理画面内倾斜，不还原侧转、仰俯或遮挡。轮廓连线来自固定面部网格，不是图像分割边缘。';
  container.replaceChildren(title, description);
  if (photo.landmarkChoices?.original && photo.landmarkChoices?.upright) {
    const control = document.createElement('label');
    control.className = 'lip-control small';
    control.append(document.createTextNode('本张关键点 '));
    const select = document.createElement('select');
    select.className = 'landmark-mode';
    select.setAttribute('aria-label', `${photoLabel} 的关键点定位`);
    for (const [value, text] of [['original', '原始定位'], ['upright', '旋正复测']]) {
      const option = document.createElement('option');
      option.value = value; option.textContent = text; select.append(option);
    }
    select.value = photo.landmarkMode;
    select.addEventListener('change', () => {
      if (isLocked() || !applyLandmarkChoice(photo, select.value)) return;
      if (state.results) state.results = aggregateComparisons(state.photos.a.map((p) => p.result), state.photos.b.map((p) => p.result));
      renderPanels();
      if (state.results) renderResults();
      $('#progress').textContent = `${photoLabel} 已切换关键点；两类分数、动作信号和测量线均已更新。`;
    });
    control.append(select); container.append(control);
  }
  if (info.agreement?.comparable) {
    const agreement = document.createElement('p');
    agreement.className = 'small muted';
    agreement.textContent = `轮廓平均位移为眼间距的 ${number(info.agreement.contourMeanFraction * 100)}%，最大 ${number(info.agreement.contourMaxFraction * 100)}%。这是两次定位的差异，不是定位误差。`;
    container.append(agreement);
  }
  container.append(note);
}

function renderLipAssessment(container, photo, photoLabel) {
  const lip = photo.lip;
  container.hidden = false;
  const title = document.createElement('strong');
  title.textContent = lip.suspectedPress ? '疑似压唇／卷唇线索' : !lip.known ? '嘴部动作或质量信息不足' : '唇厚测量可靠度';
  const description = document.createElement('p');
  description.className = 'small';
  description.textContent = `自动 q ${number(lip.autoReliability, 2)} · 采用 q ${number(lip.reliability, 2)} · ${modeLabel(lip.mode)}。这是工程启发式，不是抿嘴概率。`;
  const reasons = document.createElement('ul');
  reasons.className = 'lip-reasons small';
  for (const reason of lip.reasons) {
    const item = document.createElement('li');
    item.textContent = reason.message;
    reasons.append(item);
  }
  if (!lip.reasons.length) {
    const item = document.createElement('li');
    item.textContent = '当前信号未触发降权；这不保证没有表情或定位误差。';
    reasons.append(item);
  }
  const control = document.createElement('label');
  control.className = 'lip-control small';
  control.append(document.createTextNode('本张唇厚 '));
  const select = document.createElement('select');
  select.className = 'lip-mode';
  select.setAttribute('aria-label', `${photoLabel} 的唇厚处理`);
  for (const [value, text] of [['auto', '自动判断'], ['include', '保留唇厚（q = 1）'], ['exclude', '排除唇厚（q = 0）']]) {
    const option = document.createElement('option');
    option.value = value; option.textContent = text; select.append(option);
  }
  select.value = photo.lipMode;
  select.addEventListener('change', () => {
    if (isLocked()) return;
    photo.lipMode = select.value;
    photo.lip = analyzeLipReliability(photo.blendshapes, photo.quality, photo.lipMode);
    renderPanels();
    if (state.results) renderResults();
    $('#progress').textContent = `${photoLabel} 的唇厚处理已更新；原始分数不变。`;
  });
  control.append(select);
  const details = document.createElement('details');
  details.className = 'lip-signals small';
  const summary = document.createElement('summary');
  summary.textContent = '查看嘴部动作系数';
  const signals = document.createElement('dl');
  for (const signal of LIP_SIGNAL_DEFINITIONS) {
    const term = document.createElement('dt'); term.textContent = signal.label;
    const value = document.createElement('dd'); value.textContent = number(lip.signals[signal.id], 3);
    signals.append(term, value);
  }
  details.append(summary, signals);
  container.replaceChildren(title, description, reasons, control, details);
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

function drawFaceContours(ctx, photo, points, map, color, lineWidth) {
  const edgeKey = ({ start, end }) => `${Math.min(start, end)}:${Math.max(start, end)}`;
  const oval = state.connections.faceOval ?? [];
  const ovalKeys = new Set(oval.map(edgeKey));
  drawConnections(ctx, points, state.connections.contours.filter((edge) => !ovalKeys.has(edgeKey(edge))), map, color, lineWidth);
  ctx.save();
  if (hasPoseWarning(photo)) {
    ctx.setLineDash([5, 4]);
    drawConnections(ctx, points, oval, map, '#31291dcc', lineWidth + 2);
  }
  drawConnections(ctx, points, oval, map, hasPoseWarning(photo) ? '#ffbe73' : color, lineWidth);
  ctx.restore();
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
  const region = state.faceZoom && photo.cropRegion ? photo.cropRegion : { x: 0, y: 0, width: 1, height: 1 };
  const scale = Math.min(width / (photo.width * region.width), height / (photo.height * region.height));
  const w = photo.width * scale;
  const h = photo.height * scale;
  const x = (width - w * region.width) / 2 - region.x * w;
  const y = (height - h * region.height) / 2 - region.y * h;
  // Keep the original/profiled image in an <img>; a default sRGB canvas would
  // flatten its display gamut. Canvas is transparent and contains overlays only.
  const source = $('.source-photo', panel);
  Object.assign(source.style, { width: `${w}px`, height: `${h}px`, left: `${x}px`, top: `${y}px` });
  if (!photo.landmarks || state.overlay === 'none') return;
  const points = photo.landmarks;
  const map = (point) => ({ x: x + point.x * w, y: y + point.y * h });
  const color = side === 'a' ? '#cbf3ad' : '#ffe0b1';
  if (state.overlay === 'mesh') {
    const oval = new Set((state.connections.faceOval ?? []).map(({ start, end }) => `${Math.min(start, end)}:${Math.max(start, end)}`));
    const mesh = hasPoseWarning(photo) ? state.connections.mesh.filter(({ start, end }) => !oval.has(`${Math.min(start, end)}:${Math.max(start, end)}`)) : state.connections.mesh;
    drawConnections(ctx, points, mesh, map, side === 'a' ? '#c9efad88' : '#ffdfad88', .55);
  }
  if (state.overlay !== 'measure') drawFaceContours(ctx, photo, points, map, color, 1.1);
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
    if (photo?.result) drawFaceContours(ctx, photo, photo.result.normalizedLandmarks, map, index ? '#bf7856cc' : '#456b58cc', 1.6);
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
    }, type === 'initialize' ? 90000 : 120000);
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
            const { width, height } = photo;
            // The worker crops from original pixels before resizing each pass.
            const bitmap = await createImageBitmap(photo.image);
            const response = await request('detect', { bitmap }, [bitmap]);
            const faces = response.faceLandmarks;
            if (!faces.length) throw new Error('整图与分区搜索均未检测到人脸。请手动裁剪到脸部后重试；如果原图脸部像素过少，放大也无法补回细节。');
            if (faces.length !== 1) throw new Error('检测到多张脸。请裁剪到一人后重新加入；此照片未参与评分。');
            photo.orientationInfo = response.orientationInfo;
            photo.landmarkChoices = prepareLandmarkChoices(response, width, height);
            if (photo.orientationInfo?.available && !photo.landmarkChoices.upright) {
              photo.orientationInfo = { ...photo.orientationInfo, available: false, recommended: false, reason: 'invalid-refinement' };
            }
            const preferred = response.selectedLandmarkVariant ?? 'original';
            if (!applyLandmarkChoice(photo, preferred) && !applyLandmarkChoice(photo, 'original')) {
              throw new Error('关键点未形成完整有效的比例，请换一张照片。');
            }
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
  const geometries = Object.fromEntries(['a', 'b'].map((side) => [side, state.photos[side].map((photo) => photo.result)]));
  const reliabilities = Object.fromEntries(['a', 'b'].map((side) => [side, state.photos[side].map(reliability)]));
  const adjusted = aggregateAdjusted(geometries.a, geometries.b, reliabilities.a, reliabilities.b);
  state.adjusted = adjusted;
  $('#results').hidden = false;
  $('#empty-results').hidden = true;
  $('#overall-score').textContent = number(result.median);
  const diagnostics = comparisonDiagnostics(state.photos.a.map((p) => p.result), state.photos.b.map((p) => p.result), result);
  $('#difference-value').textContent = `${number(diagnostics.medianDifference * 100)}%`;
  $('#adjusted-score').textContent = number(adjusted.median);
  const change = adjusted.median - result.median;
  $('#score-change').textContent = `与原始中位数相比 ${change > 0 ? '+' : ''}${number(change)} 分 · 不是准确度提升的证明`;
  $('#adjusted-difference').textContent = `${number(adjusted.medianDifference * 100)}%`;
  $('#adjusted-range').innerHTML = `<div>最低 — 最高<strong>${number(adjusted.min)} – ${number(adjusted.max)}</strong></div><div>四分位距<strong>${number(adjusted.iqr)}</strong></div><div>有效配对<strong>${adjusted.pairScores.length}</strong></div>`;
  $('#coverage-summary').textContent = `保留的基础权重：中位数 ${number(adjusted.medianCoverage * 100)}%（${number(adjusted.minCoverage * 100)}–${number(adjusted.maxCoverage * 100)}%）。归一化后唇厚有效权重：中位数 ${number(adjusted.medianLipEffectiveWeight * 100)}%（原始 10%）。`;
  $('#score-explanation').textContent = `原始评分中，加权比例差异中位数为 ${number(diagnostics.medianDifference * 100)}%。分数由固定指数公式映射：约 13.9% 的差异即可得到 50 分；它不是人眼相似度的百分比。`;
  $('#within-groups').innerHTML = ['a', 'b'].map((side) => {
    const within = diagnostics.within[side];
    const weighted = withinGroupAdjusted(geometries[side], reliabilities[side]);
    return `<div><strong>${side.toUpperCase()} 组内部</strong><p>${within.count ? `原始 ${number(within.medianScore)} → 调整后 ${number(weighted.medianScore)}<br>比例差异 ${number(within.medianDifference * 100)}% → ${number(weighted.medianDifference * 100)}%<br>${within.count} 个不同照片配对；原始范围 ${number(within.min)}–${number(within.max)}，调整后 ${number(weighted.min)}–${number(weighted.max)}` : '至少两张有效照片才能估计组内波动。'}</p></div>`;
  }).join('');
  $('#lip-references').innerHTML = ['a', 'b'].map((side) => {
    const reference = summarizeLipReference(geometries[side], reliabilities[side]);
    return `<div><strong>${side.toUpperCase()} 组唇厚参考</strong><p>${reference.count ? `唇厚／嘴宽 ${number(reference.value, 3)} · ${reference.count} / ${reference.totalCount} 张照片` : '无法可靠估计：没有采用 q ≥ 0.5 的有效照片。'}</p></div>`;
  }).join('');
  renderExpressionTable();
  $('#top-differences').innerHTML = diagnostics.contributions.slice(0, 3).map((feature) => `<li>${feature.label}：平均相对差异 ${number(feature.meanDifference * 100)}%，占平均加权差异的 ${number(feature.share * 100)}%。</li>`).join('');
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
      const adjustedScore = adjusted.pairMatrix[a][b];
      button.textContent = score === null ? '—' : `${number(score, 0)} → ${number(adjustedScore, 0)}`;
      button.disabled = score === null;
      button.dataset.a = a; button.dataset.b = b;
      button.setAttribute('aria-label', `${label('a', a)} 与 ${label('b', b)}：${score === null ? '无效配对' : `原始 ${number(score)}，调整后 ${number(adjustedScore)} 分`}`);
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

function renderExpressionTable() {
  const rows = $('#expression-rows');
  rows.replaceChildren();
  for (const side of ['a', 'b']) state.photos[side].forEach((photo, index) => {
    const row = document.createElement('tr');
    const first = document.createElement('td');
    const button = document.createElement('button');
    button.textContent = label(side, index);
    button.setAttribute('aria-label', `查看 ${label(side, index)} 的嘴部动作`);
    button.addEventListener('click', () => {
      state.selected[side] = index;
      renderPanels(); updatePairSelection();
      $(`.photo-panel[data-side="${side}"] .lip-assessment`)?.scrollIntoView({ block: 'center' });
    });
    first.append(button); row.append(first);
    const lip = photo.lip;
    const values = photo.result && lip ? [number(lip.press, 3), number(lip.roll, 3), number(lip.otherExpression, 3), number(lip.qualityReliability, 2), number(lip.autoReliability, 2), `${number(lip.reliability, 2)} / ${modeLabel(lip.mode)}`] : ['—', '—', '—', '—', '—', '未纳入比较'];
    for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    rows.append(row);
  });
}

function updatePairSelection() {
  if (!state.results) return;
  document.querySelectorAll('.matrix button').forEach((button) => button.setAttribute('aria-pressed', String(+button.dataset.a === state.selected.a && +button.dataset.b === state.selected.b)));
  const pair = state.results.pairs.find((p) => p.aIndex === state.selected.a && p.bIndex === state.selected.b);
  const adjusted = state.adjusted?.pairs.find((p) => p.aIndex === state.selected.a && p.bIndex === state.selected.b);
  $('#pair-detail').innerHTML = pair && adjusted ? `当前查看 <strong>${label('a', state.selected.a)} × ${label('b', state.selected.b)}</strong><br>原始 <strong>${number(pair.score)}</strong> → 调整后 <strong>${number(adjusted.score)}</strong> / 100<br>唇厚 q ${number(adjusted.lipReliability, 2)} · 有效权重 ${number(adjusted.lipEffectiveWeight * 100)}% · 保留基础权重 ${number(adjusted.coverage * 100)}%` : '当前选中照片未形成有效配对。';
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
  if (!state.results || !state.adjusted) return;
  const csv = serializeCsv(buildExportRows(state.photos, state.results, state.adjusted));
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
$('#face-zoom').addEventListener('change', (event) => { state.faceZoom = event.target.checked; drawAll(); });
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
