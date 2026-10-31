/** Pure image-region helpers. All public regions use ORIGINAL-image-normalized
 * {x,y,width,height}; pixel crop rounding is included before landmark mapping.
 * This is image preparation, not a pose correction or a new face detector.
 */
export const FULL_REGION = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value) => Number.isFinite(value);

export function regionToPixels(region, imageWidth, imageHeight) {
  if (![imageWidth, imageHeight].every((value) => finite(value) && value > 0) || !region || ![region.x, region.y, region.width, region.height].every(finite) || region.width <= 0 || region.height <= 0) throw new RangeError('Invalid crop region or image dimensions');
  const x = clamp(Math.floor(region.x * imageWidth + 1e-7), 0, imageWidth - 1);
  const y = clamp(Math.floor(region.y * imageHeight + 1e-7), 0, imageHeight - 1);
  const right = clamp(Math.ceil((region.x + region.width) * imageWidth - 1e-7), x + 1, imageWidth);
  const bottom = clamp(Math.ceil((region.y + region.height) * imageHeight - 1e-7), y + 1, imageHeight);
  const width = right - x;
  const height = bottom - y;
  return { x, y, width, height, region: { x: x / imageWidth, y: y / imageHeight, width: width / imageWidth, height: height / imageHeight } };
}

/** Overlapping grid covers the full source without gaps. A 2×2 grid has 4
 * regions; 3×3 has 9. Dimensions are used only for pixel-aligned boundaries.
 */
export function planTiles(imageWidth, imageHeight, grid, overlap = 0.25) {
  if (!Number.isInteger(grid) || grid < 1 || grid > 8 || !finite(overlap) || overlap < 0 || overlap >= 1) throw new RangeError('Invalid tile grid');
  const extent = 1 / (grid - (grid - 1) * overlap);
  const stride = extent * (1 - overlap);
  const regions = [];
  for (let row = 0; row < grid; row += 1) {
    for (let column = 0; column < grid; column += 1) regions.push(regionToPixels({ x: column * stride, y: row * stride, width: extent, height: extent }, imageWidth, imageHeight).region);
  }
  return regions;
}

/** MediaPipe z uses the crop's x-coordinate scale, so map z by crop width,
 * not crop height or a mean of the two. x/y may extend beyond crop bounds.
 */
export function mapLandmarks(landmarks, region) {
  return landmarks.map((point) => ({ ...point, x: region.x + point.x * region.width, y: region.y + point.y * region.height, ...(finite(point.z) ? { z: point.z * region.width } : {}) }));
}

/** Bounds of the first 468 facial surface points, excluding iris landmarks. */
export function faceBounds(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 468 || landmarks.slice(0, 468).some((point) => !finite(point?.x) || !finite(point?.y))) return null;
  const points = landmarks.slice(0, 468);
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  if (right - left <= 1e-8 || bottom - top <= 1e-8) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Square in source pixels, with padding on each side equal to 45% of the
 * larger face dimension. Translation preserves requested size at image edges
 * where possible; bounds never leave the source. No upsampling is implied.
 */
export function paddedFaceCrop(landmarks, imageWidth, imageHeight, padding = 0.45) {
  const bounds = faceBounds(landmarks);
  if (!bounds || !finite(padding) || padding < 0) return null;
  const side = Math.max(bounds.width * imageWidth, bounds.height * imageHeight) * (1 + padding * 2);
  const width = Math.min(side, imageWidth);
  const height = Math.min(side, imageHeight);
  const x = clamp((bounds.x + bounds.width / 2) * imageWidth - width / 2, 0, imageWidth - width);
  const y = clamp((bounds.y + bounds.height / 2) * imageHeight - height / 2, 0, imageHeight - height);
  return regionToPixels({ x: x / imageWidth, y: y / imageHeight, width: width / imageWidth, height: height / imageHeight }, imageWidth, imageHeight).region;
}

function overlapOverUnion(a, b) {
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return intersection / (a.width * a.height + b.width * b.height - intersection);
}

/** Strict duplicate heuristic: bounds IoU ≥0.4 AND mean anchor displacement
 * ≤18% of the smaller face's pixel-box diagonal. Stable eye/nose/mouth anchors
 * help avoid merging distinct people whose boxes happen to overlap. This is
 * geometric grouping of detections from one image, not identity recognition.
 */
export function sameFaceDetection(a, b, imageWidth, imageHeight) {
  // Two outputs of one detector call are separate faces by construction, even
  // when their projected boxes or stable anchors overlap unusually closely.
  if (a !== b && a.passId !== undefined && a.passId === b.passId) return false;
  const boxA = faceBounds(a.landmarks);
  const boxB = faceBounds(b.landmarks);
  if (!boxA || !boxB || overlapOverUnion(boxA, boxB) < 0.4) return false;
  const anchors = [1, 33, 263, 61, 291];
  const displacement = anchors.reduce((sum, index) => sum + Math.hypot((a.landmarks[index].x - b.landmarks[index].x) * imageWidth, (a.landmarks[index].y - b.landmarks[index].y) * imageHeight), 0) / anchors.length;
  const reference = Math.min(Math.hypot(boxA.width * imageWidth, boxA.height * imageHeight), Math.hypot(boxB.width * imageWidth, boxB.height * imageHeight));
  return displacement <= reference * 0.18;
}

/** Accept {landmarks,blendshapes,region,samplingScale?} candidates. Invalid meshes
 * are discarded. Higher source sampling resolution wins each duplicate cluster;
 * candidates must match EVERY member to avoid chaining two people together.
 */
export function deduplicateFaces(detections, imageWidth, imageHeight) {
  const clusters = [];
  const regionArea = (detection) => detection.region ? detection.region.width * detection.region.height : 1;
  const sorted = detections.filter((detection) => faceBounds(detection?.landmarks)).map((detection, index) => ({ detection, index })).sort((a, b) => (b.detection.samplingScale ?? 0) - (a.detection.samplingScale ?? 0) || regionArea(a.detection) - regionArea(b.detection) || a.index - b.index);
  for (const { detection } of sorted) {
    const cluster = clusters.find((members) => members.every((member) => sameFaceDetection(member, detection, imageWidth, imageHeight)));
    if (cluster) cluster.push(detection);
    else clusters.push([detection]);
  }
  return clusters.map((cluster) => cluster[0]);
}

/** Reconcile a refinement of ONE previously discovered face. Ordinary discovery
 * matching remains unchanged. Only when that matching would split exactly one
 * old and one refined result, allow contour-box disagreement if stable anchors
 * are very close: mean displacement ≤10%, and EVERY displacement ≤16%, of the
 * smaller outer-eye span in original pixels. Both spans must be nonzero.
 *
 * This narrowly handles an uncertain coarse outline becoming more precise;
 * it never merges multiple outputs of one pass. Already accepted ordinary
 * matches retain the exact same selected mesh and therefore the same ratios.
 */
export function reconcileSoleFaceRefinement(previousFaces, refinementFaces, imageWidth, imageHeight) {
  const ordinary = deduplicateFaces([...refinementFaces, ...previousFaces], imageWidth, imageHeight);
  if (ordinary.length !== 2 || previousFaces.length !== 1 || refinementFaces.length !== 1) return ordinary;
  const previous = previousFaces[0];
  const refined = refinementFaces[0];
  if (!faceBounds(previous?.landmarks) || !faceBounds(refined?.landmarks)) return ordinary;
  if (previous.passId !== undefined && previous.passId === refined.passId) return ordinary;
  const eyeSpan = (face) => Math.hypot((face.landmarks[33].x - face.landmarks[263].x) * imageWidth, (face.landmarks[33].y - face.landmarks[263].y) * imageHeight);
  const reference = Math.min(eyeSpan(previous), eyeSpan(refined));
  if (!finite(reference) || reference <= 1e-8) return ordinary;
  const displacements = [1, 33, 263, 61, 291].map((index) => Math.hypot((previous.landmarks[index].x - refined.landmarks[index].x) * imageWidth, (previous.landmarks[index].y - refined.landmarks[index].y) * imageHeight));
  if (displacements.every((value) => value <= reference * 0.16) && displacements.reduce((sum, value) => sum + value, 0) / displacements.length <= reference * 0.1) return [refined];
  return ordinary;
}
