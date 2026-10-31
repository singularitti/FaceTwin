"use strict";

// Only public, precomputed showcase data is read. There is no photo upload or inference.
const DATA_URL = "./data/results.json";
const SVG_NS = "http://www.w3.org/2000/svg";
const ACCENT = "#276153";
const DENOMINATOR = "#ae5c34";
const list = document.querySelector("#pair-list");
const status = document.querySelector("#load-status");
const dialog = document.querySelector("#pair-dialog");
const dialogContent = document.querySelector("#dialog-content");
let dataset;
let activePair;
let activeFeature;
let overlayEnabled = false;
let returnFocus;

const integer = (value) => Number(value).toLocaleString("en-US");
const number = (value, digits = 4) =>
  Number.isFinite(Number(value)) && value !== null
    ? Number(value).toFixed(digits)
    : "—";
const score = (value) => number(Number(value), 2);
const percent = (value) =>
  Number.isFinite(Number(value)) && value !== null
    ? `${number(Number(value) * 100, 1)}%`
    : "—";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function add(parent, ...children) {
  parent.append(...children.filter(Boolean));
  return parent;
}

function validPublicImage(src) {
  // Reject protocols, parent traversal, and external requests in data files.
  return typeof src === "string" &&
    /^\.\/assets\/faces\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/i.test(src);
}

function warningNodes(warnings) {
  const wrapper = element("div", "warning-list");
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return add(wrapper, element("span", "warning-none", "无质量提醒"));
  }
  warnings.forEach((warning) =>
    wrapper.append(
      element("span", "warning-label", warning.label || warning.code),
    )
  );
  return wrapper;
}

function portrait(face, detailed = false) {
  const figure = element("figure", "portrait");
  const stage = element("div", "portrait-stage");
  const stack = element("div", "image-stack");
  const ratio = Number(face.width) > 0 && Number(face.height) > 0
    ? Number(face.width) / Number(face.height)
    : 1;
  stack.style.setProperty("--image-ratio", ratio);
  stack.style.setProperty(
    "--image-max-width",
    `${Math.min(detailed ? 500 : 470, ratio * (detailed ? 420 : 330))}px`,
  );
  const img = element("img");
  if (!validPublicImage(face.src)) throw new Error("Invalid public image path");
  img.src = face.src;
  img.alt = `公开测试图像 ${face.id}，${
    detailed ? "用于检查二维比例" : "面部几何比较"
  }`;
  img.width = Number(face.width) || 1;
  img.height = Number(face.height) || 1;
  img.loading = detailed ? "eager" : "lazy";
  img.decoding = "async";
  stack.append(img);
  if (detailed) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("measurement-overlay");
    svg.setAttribute("viewBox", "0 0 1 1");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("hidden", "");
    svg.dataset.face = face.id;
    stack.append(svg);
  }
  stage.append(stack);
  const caption = add(
    element("figcaption"),
    element("span", "", face.id),
    element("span", "image-tag", "原始输入图像"),
  );
  if (detailed) {
    const warnings = warningNodes(face.warnings);
    warnings.classList.add("portrait-warnings");
    caption.append(warnings);
  }
  return add(figure, stage, caption);
}

function card(pair) {
  const article = element(
    "article",
    `pair-card${pair.rank === 1 ? " featured" : ""}`,
  );
  article.setAttribute("aria-labelledby", `pair-title-${pair.rank}`);
  const summary = element("div", "pair-summary");
  const rank = add(
    element("div", "rank-line"),
    element("span", "rank-number", String(pair.rank).padStart(2, "0")),
    element("span", "", "RANK"),
  );
  const title = element("h3", "", `${pair.a.id} / ${pair.b.id}`);
  title.id = `pair-title-${pair.rank}`;
  const baseline = add(
    element("p", "baseline", "原始分数"),
    element("b", "", score(pair.baselineScore)),
  );
  add(
    summary,
    rank,
    title,
    element("div", "pair-score", score(pair.score)),
    element("p", "score-label", "调整后分数 · 未校准"),
    baseline,
  );
  if (pair.duplicateSuspected) {
    summary.append(element("span", "duplicate-badge", "疑似重复图像"));
  }
  summary.append(
    element(
      "p",
      "pair-note",
      pair.note || "对照照片与测量，检查分数来自哪些接近的比例。",
    ),
  );
  const button = add(
    element("button", "details-button", "展开测量详情"),
    element("span", "", "↗"),
  );
  button.type = "button";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute(
    "aria-label",
    `展开第 ${pair.rank} 组 ${pair.a.id} 与 ${pair.b.id} 的测量详情`,
  );
  button.addEventListener("click", () => openDetails(pair, button));
  summary.append(button);
  const visuals = element("div", "pair-visuals");
  const photos = add(
    element("div", "photo-pair"),
    portrait(pair.a),
    portrait(pair.b),
  );
  const footnote = element("div", "pair-footnote");
  const warnings = [...(pair.a.warnings || []), ...(pair.b.warnings || [])];
  const uniqueWarnings = warnings.filter((warning, index) =>
    warnings.findIndex((item) =>
      (item.code || item.label) === (warning.code || warning.label)
    ) === index
  );
  add(
    footnote,
    warningNodes(uniqueWarnings),
    element("span", "", `保留权重 ${percent(pair.coverage)}`),
  );
  return add(article, summary, add(visuals, photos, footnote));
}

function drawSegments(svg, points, segments, color) {
  if (!Array.isArray(points) || !Array.isArray(segments)) return;
  const endpoints = new Set();
  segments.forEach((segment) => {
    if (!Array.isArray(segment) || segment.length !== 2) return;
    const a = points[segment[0]], b = points[segment[1]];
    if (!a || !b || ![a.x, a.y, b.x, b.y].every(Number.isFinite)) return;
    const line = document.createElementNS(SVG_NS, "line");
    for (
      const [key, value] of Object.entries({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        stroke: color,
      })
    ) line.setAttribute(key, value);
    svg.append(line);
    segment.forEach((index) => endpoints.add(index));
  });
  endpoints.forEach((index) => {
    const point = points[index];
    const circle = document.createElementNS(SVG_NS, "circle");
    for (
      const [key, value] of Object.entries({
        cx: point.x,
        cy: point.y,
        r: 0.005,
        fill: color,
      })
    ) circle.setAttribute(key, value);
    svg.append(circle);
  });
}

function updateOverlay() {
  const feature = dataset.features.find((item) => item.id === activeFeature);
  dialogContent.querySelectorAll(".measurement-overlay").forEach(
    (svg, index) => {
      svg.replaceChildren();
      svg.toggleAttribute("hidden", !overlayEnabled);
      if (!overlayEnabled || !feature) return;
      const face = index === 0 ? activePair.a : activePair.b;
      drawSegments(
        svg,
        face.points,
        feature.segments?.denominator,
        DENOMINATOR,
      );
      drawSegments(svg, face.points, feature.segments?.numerator, ACCENT);
    },
  );
  dialogContent.querySelectorAll(".view-switch button").forEach((button) =>
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.view === (overlayEnabled ? "measure" : "raw")),
    )
  );
  const select = dialogContent.querySelector("#feature-select");
  select.disabled = !overlayEnabled;
  select.value = activeFeature;
  const caption = dialogContent.querySelector("#overlay-caption-text");
  caption.replaceChildren();
  if (overlayEnabled && feature) {
    caption.append(
      element(
        "span",
        "overlay-formula",
        `${feature.label} · ${feature.formula || "线段长度之比"}`,
      ),
    );
  } else {
    caption.textContent =
      "当前显示原始输入图像。开启测量线，可查看所选比例对应的实际关键点线段。";
  }
  dialogContent.querySelector(".overlay-legend").hidden = !overlayEnabled;
  dialogContent.querySelectorAll(".measurement-table tbody tr").forEach((row) =>
    row.classList.toggle(
      "is-selected",
      overlayEnabled && row.dataset.feature === activeFeature,
    )
  );
}

function selectFeature(id) {
  activeFeature = id;
  overlayEnabled = true;
  updateOverlay();
}

function measurementTable(pair) {
  const scroll = element("div", "table-scroll");
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", "13 项二维比例测量，窄屏可横向滚动");
  scroll.tabIndex = 0;
  const table = element("table", "measurement-table");
  const head = element("thead");
  const heading = element("tr");
  ["测量项目", pair.a.id, pair.b.id, "差异 (%)", "有效权重"].forEach(
    (label) => {
      const th = element("th", "", label);
      th.scope = "col";
      heading.append(th);
    },
  );
  head.append(heading);
  const body = element("tbody");
  pair.measurements.forEach((measurement) => {
    const row = element("tr");
    row.dataset.feature = measurement.id;
    const name = element("td");
    const button = element("button", "", measurement.label);
    button.type = "button";
    button.setAttribute("aria-label", `查看${measurement.label}的测量线`);
    button.addEventListener("click", () => selectFeature(measurement.id));
    name.append(button);
    add(
      row,
      name,
      element("td", "", number(measurement.a)),
      element("td", "", number(measurement.b)),
      element("td", "", percent(measurement.difference)),
      element("td", "", percent(measurement.effectiveWeight)),
    );
    body.append(row);
  });
  return add(scroll, add(table, head, body));
}

function openDetails(pair, trigger) {
  activePair = pair;
  activeFeature = pair.measurements[0]?.id || dataset.features[0]?.id;
  overlayEnabled = false;
  returnFocus = trigger;
  document.querySelector("#dialog-title").textContent =
    `${pair.a.id} / ${pair.b.id}`;
  document.querySelector("#dialog-kicker").textContent = `PAIR ${
    String(pair.rank).padStart(2, "0")
  } / MEASUREMENT DETAILS`;
  dialogContent.replaceChildren();
  if (pair.duplicateSuspected) {
    dialogContent.append(
      element(
        "p",
        "dialog-duplicate",
        "疑似重复图像：这组高分可能与同一图像的重复或近重复有关。保留原排名供审查，不将其解释为两个独立面孔相似的证据。",
      ),
    );
  }
  const intro = element("div", "dialog-intro");
  const scoreBlock = add(
    element("div", "dialog-score", "调整后分数 · 未校准"),
    element("strong", "", score(pair.score)),
  );
  add(
    intro,
    element(
      "p",
      "",
      pair.note ||
        "用原图检查观感，用测量线检查比例。所有线段均来自此图像对应的实际归一化关键点；分数未经人类相似判断校准。",
    ),
    scoreBlock,
  );
  const toolbar = element("div", "viewer-toolbar");
  const switcher = element("div", "view-switch");
  switcher.setAttribute("role", "group");
  switcher.setAttribute("aria-label", "照片显示方式");
  [["raw", "原图"], ["measure", "测量线"]].forEach(([view, label]) => {
    const button = element("button", "", label);
    button.type = "button";
    button.dataset.view = view;
    button.addEventListener("click", () => {
      overlayEnabled = view === "measure";
      updateOverlay();
    });
    switcher.append(button);
  });
  const control = element("div", "feature-control");
  const label = element("label", "", "测量项目");
  label.htmlFor = "feature-select";
  const select = element("select");
  select.id = "feature-select";
  dataset.features.forEach((feature) => {
    if (
      !pair.measurements.some((measurement) => measurement.id === feature.id)
    ) return;
    const option = element("option", "", feature.label);
    option.value = feature.id;
    select.append(option);
  });
  select.addEventListener("change", () => selectFeature(select.value));
  add(toolbar, switcher, add(control, label, select));
  const photos = add(
    element("div", "photo-pair dialog-photos"),
    portrait(pair.a, true),
    portrait(pair.b, true),
  );
  const caption = element("div", "overlay-caption");
  const text = element("p");
  text.id = "overlay-caption-text";
  text.setAttribute("aria-live", "polite");
  const legend = element("div", "overlay-legend");
  add(
    legend,
    add(
      element("span", "", ""),
      element("i", "legend-key"),
      document.createTextNode("分子线段"),
    ),
    add(
      element("span", "", ""),
      element("i", "legend-key denominator"),
      document.createTextNode("分母线段"),
    ),
  );
  add(caption, text, legend);
  const metadata = element("div", "detail-metadata");
  [["原始分数", score(pair.baselineScore)], [
    "保留权重",
    percent(pair.coverage),
  ], ["唇厚因子 q", number(pair.lipReliability, 2)]].forEach((
    [labelText, value],
  ) =>
    metadata.append(
      add(element("span", "", labelText), element("b", "", value)),
    )
  );
  add(
    dialogContent,
    intro,
    toolbar,
    photos,
    caption,
    metadata,
    element("h3", "detail-section-title", "13 项二维比例"),
    element(
      "p",
      "table-help",
      "两图比例为无量纲数值。相对差异 = |A − B| ÷ max((A + B) / 2, 0.01)，以百分数显示；有效权重同样以百分数显示。点击项目名称可查看对应测量线。",
    ),
    measurementTable(pair),
  );
  if (Array.isArray(pair.groups) && pair.groups.length) {
    const groups = element("div", "group-scores");
    pair.groups.forEach((group) =>
      groups.append(
        add(
          element("span", "", `${group.label} · 原始分数`),
          element("b", "", score(group.baselineScore)),
        ),
      )
    );
    dialogContent.append(groups);
  }
  dialogContent.append(
    element(
      "p",
      "dialog-limit",
      "公式中 d(i, j) 表示关键点 i 与 j 在图像像素坐标中的距离；mean 表示算术平均，+ 表示长度相加。测量线使用该图像所选模型变体的关键点，已映射回未旋转的原始输入图像；叠加层保持原始宽高比。可见的线段只是几何测量，不代表人工标注的精确边界。",
    ),
  );
  updateOverlay();
  document.body.classList.add("dialog-open");
  dialog.showModal();
  dialog.scrollTop = 0;
  dialog.querySelector(".close-button").focus();
}

function closeDetails() {
  dialog.close();
}
dialog.querySelector(".close-button").addEventListener("click", closeDetails);
dialog.addEventListener("click", (event) => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (
    event.clientX < rect.left || event.clientX > rect.right ||
    event.clientY < rect.top || event.clientY > rect.bottom
  ) closeDetails();
});
dialog.addEventListener("close", () => {
  document.body.classList.remove("dialog-open");
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
});

function renderMetadata(run, sources) {
  const stats = document.querySelectorAll(".study-stats .stat-value");
  stats[0].textContent = dataset.features.length;
  stats[1].textContent = integer(run.validCount);
  stats[2].textContent = integer(run.pairCount);
  stats[3].textContent = String(dataset.pairs.length).padStart(2, "0");
  document.querySelector("#dataset-method").textContent =
    `${run.dataset} ${run.split}共 ${integer(run.recordCount)} 条人脸记录，其中 ${
      integer(run.validCount)
    } 条得到有效单人脸测量。${integer(run.noFaceCount)} 条未检测到人脸、${
      integer(run.multipleFaceCount)
    } 条检测到多个人脸，未参与比较。对有效记录进行 ${
      integer(run.pairCount)
    } 次两两比较，每对只计算一次。`;
  document.querySelector("#run-provenance").textContent =
    `本次运行：${run.date} · ${run.dataset} ${run.split}。算法来源版本：${run.sourceCommit}。人脸推理约 ${
      number(run.inferenceSeconds, 2)
    } 秒；配对评分与保存 CSV 约 ${
      number(run.pairScoringSeconds, 2)
    } 秒，不含下载与预处理。时间来自本次运行记录，不代表跨设备性能。`;
  const sourceList = document.querySelector("#sources-list");
  sources.forEach((source) => {
    let url;
    try {
      url = new URL(source.url);
    } catch {
      return;
    }
    if (url.protocol !== "https:") return;
    const link = element("a", "", source.label);
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `${source.label}（在新标签页打开）`);
    sourceList.append(add(element("li"), link));
  });
}

async function load() {
  try {
    const response = await fetch(DATA_URL, { credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (
      data.schemaVersion !== 1 || !data.run || !Array.isArray(data.features) ||
      !Array.isArray(data.pairs) || data.pairs.length === 0
    ) throw new Error("Invalid showcase data");
    dataset = data;
    const cards = data.pairs.map(card);
    list.replaceChildren(...cards);
    renderMetadata(data.run, Array.isArray(data.sources) ? data.sources : []);
    status.hidden = true;
  } catch (error) {
    status.hidden = false;
    status.classList.add("error");
    status.textContent =
      "比较数据暂时无法载入。请刷新页面重试；若问题持续，可通过下方下载链接查看原始结果。";
    console.error(
      "Showcase data could not be loaded.",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

load();
