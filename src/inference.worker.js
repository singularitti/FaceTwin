let landmarker;
let initializing;
let crop;
const MAX_INFERENCE_EDGE = 1600;

async function initialize() {
  if (landmarker) return;
  if (initializing) return initializing;
  initializing = (async () => {
    crop = await import('./crop.js');
    const { FaceLandmarker, FilesetResolver } = await import('../vendor/vision/vision_bundle.mjs');
    const vision = await FilesetResolver.forVisionTasks(new URL('../vendor/vision/wasm/', self.location.href).href);
    landmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: new URL('../models/face_landmarker.task', self.location.href).href,
        delegate: 'CPU',
      },
      runningMode: 'IMAGE',
      numFaces: 2,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    });
    return {
      mesh: FaceLandmarker.FACE_LANDMARKS_TESSELATION,
      contours: FaceLandmarker.FACE_LANDMARKS_CONTOURS,
    };
  })();
  try { return await initializing; } catch (error) { initializing = null; throw error; }
}

/** Every pass samples from the original bitmap; tiles are never made from an
 * already downsized full image. Canvas dimensions stay bounded by 1600 pixels.
 */
async function detectImage(bitmap) {
  const width = bitmap.width;
  const height = bitmap.height;
  let passes = 0;
  let tiled = false;
  let refined = false;
  const candidates = [];
  const detectRegion = (region) => {
    const source = crop.regionToPixels(region, width, height);
    const scale = Math.min(1, MAX_INFERENCE_EDGE / Math.max(source.width, source.height));
    const targetWidth = Math.max(1, Math.round(source.width * scale));
    const targetHeight = Math.max(1, Math.round(source.height * scale));
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image preparation failed');
    context.drawImage(bitmap, source.x, source.y, source.width, source.height, 0, 0, targetWidth, targetHeight);
    passes += 1;
    const result = landmarker.detect(canvas);
    const detections = result.faceLandmarks.map((landmarks, index) => ({
      landmarks: crop.mapLandmarks(landmarks, source.region),
      blendshapes: result.faceBlendshapes[index] ?? { categories: [] },
      region: source.region,
      samplingScale: Math.min(targetWidth / source.width, targetHeight / source.height),
      passId: passes,
    }));
    // Release potentially large canvas backing stores after synchronous inference.
    canvas.width = 1;
    canvas.height = 1;
    return detections;
  };
  candidates.push(...detectRegion(crop.FULL_REGION));
  let faces = crop.deduplicateFaces(candidates, width, height);
  if (!faces.length || (faces.length === 1 && crop.faceBounds(faces[0].landmarks).width < 0.2)) {
    tiled = true;
    for (const grid of [2, 3]) {
      for (const region of crop.planTiles(width, height, grid)) candidates.push(...detectRegion(region));
    }
    faces = crop.deduplicateFaces(candidates, width, height);
  }
  if (faces.length === 1) {
    const region = crop.paddedFaceCrop(faces[0].landmarks, width, height);
    if (region) {
      const refinement = detectRegion(region);
      // Keep prior detections when refinement fails. If it exposes a second face,
      // preserve that face instead of selecting the largest or most central one.
      if (refinement.length) {
        faces = crop.reconcileSoleFaceRefinement(faces, refinement, width, height);
        refined = true;
      }
    }
  }
  return {
    faceLandmarks: faces.map((face) => face.landmarks),
    faceBlendshapes: faces.map((face) => face.blendshapes),
    cropRegions: faces.map((face) => crop.paddedFaceCrop(face.landmarks, width, height) ?? face.region),
    detectionInfo: {
      method: tiled ? (refined ? 'tiled-refined' : 'tiled') : (refined ? 'full-refined' : 'full'),
      passes,
      sourceFaceWidthPx: faces.length === 1 ? crop.faceBounds(faces[0].landmarks).width * width : null,
    },
  };
}

self.onmessage = async ({ data }) => {
  const { id, type, bitmap } = data;
  try {
    if (type === 'initialize') {
      const connections = await initialize();
      self.postMessage({ id, ok: true, connections });
    } else if (type === 'detect') {
      if (!landmarker) throw new Error('模型尚未初始化。');
      const result = await detectImage(bitmap);
      self.postMessage({ id, ok: true, ...result });
    } else {
      throw new Error('未知推理操作。');
    }
  } catch (_error) {
    // Avoid forwarding vendor errors that may contain local paths or image data.
    self.postMessage({ id, ok: false, error: type === 'initialize' ? '模型加载失败。请在项目目录运行 uv run python scripts/setup_assets.py，然后刷新网页重试。' : '此照片的关键点推理失败，请换一张清晰的正面照片。' });
  } finally {
    bitmap?.close();
  }
};
