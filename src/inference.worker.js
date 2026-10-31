let landmarker;
let initializing;
let crop;
let orientation;
const MAX_INFERENCE_EDGE = 1600;

async function initialize() {
  if (landmarker) return;
  if (initializing) return initializing;
  initializing = (async () => {
    [crop, orientation] = await Promise.all([import('./crop.js'), import('./orientation.js')]);
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
      faceOval: FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
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
  if (!faces.length || (faces.length === 1 && (crop.faceBounds(faces[0].landmarks)?.width ?? 0) < 0.2)) {
    tiled = true;
    for (const grid of [2, 3]) {
      for (const region of crop.planTiles(width, height, grid)) candidates.push(...detectRegion(region));
    }
    faces = crop.deduplicateFaces(candidates, width, height);
  }
  if (faces.length === 1) {
    const region = crop.paddedFaceCrop(faces[0].landmarks, width, height);
    // A repeated source region supplies exactly the same pixels to the model.
    const sameRegion = (a, b) => a && b && ['x', 'y', 'width', 'height'].every((key) => a[key] === b[key]);
    if (region && !sameRegion(region, crop.FULL_REGION) && !sameRegion(region, faces[0].region)) {
      const refinement = detectRegion(region);
      // Keep prior detections when refinement fails. If it exposes a second face,
      // preserve that face instead of selecting the largest or most central one.
      if (refinement.length) {
        faces = crop.reconcileSoleFaceRefinement(faces, refinement, width, height);
        refined = true;
      }
    }
  }
  const originalMethod = tiled ? (refined ? 'tiled-refined' : 'tiled') : (refined ? 'full-refined' : 'full');
  const detectionInfoFor = (face, method) => {
    const bounds = face ? crop.faceBounds(face.landmarks) : null;
    return {
      method,
      // Every variant reports total image work, including an optional upright pass;
      // selecting an existing variant in the UI never repeats inference.
      passes,
      sourceFaceWidthPx: bounds ? bounds.width * width : null,
    };
  };
  const variantFor = (face, method) => ({
    landmarks: face.landmarks,
    blendshapes: face.blendshapes,
    cropRegion: crop.paddedFaceCrop(face.landmarks, width, height) ?? face.region,
    detectionInfo: detectionInfoFor(face, method),
  });
  let selectedLandmarkVariant = 'original';
  let uprightFace = null;
  const orientationInfo = {
    attempted: false,
    available: false,
    recommended: false,
    reason: faces.length > 1 ? 'multiple-faces' : faces.length ? 'not-needed' : 'no-face',
    eyeLineRollDegrees: null,
    agreement: null,
    crop: null,
  };
  const originalFace = faces.length === 1 ? faces[0] : null;
  if (originalFace) {
    // This optional image-plane pass estimates neither physical yaw nor pitch.
    // Its agreement check measures consistency, not detection accuracy.
    try {
      const rollRadians = orientation.estimateEyeRoll(originalFace.landmarks, width, height);
      const rollDegrees = Number.isFinite(rollRadians) ? rollRadians * 180 / Math.PI : null;
      orientationInfo.eyeLineRollDegrees = rollDegrees;
      if (Number.isFinite(rollDegrees) && Math.abs(rollDegrees) >= orientation.ORIENTATION_POLICY.minRollDegrees && crop.faceBounds(originalFace.landmarks)) {
        const plan = orientation.planUprightCrop(originalFace.landmarks, width, height);
        if (plan) {
          orientationInfo.attempted = true;
          orientationInfo.crop = plan;
          const canvas = new OffscreenCanvas(plan.targetSize, plan.targetSize);
          let uprightFaces;
          try {
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Image preparation failed');
            context.fillStyle = '#808080';
            context.fillRect(0, 0, canvas.width, canvas.height);
            const { a, b, c, d, e, f } = plan.transform;
            context.setTransform(a, b, c, d, e, f);
            context.drawImage(bitmap, 0, 0);
            passes += 1;
            const result = landmarker.detect(canvas);
            uprightFaces = result.faceLandmarks.map((landmarks, index) => ({
              landmarks: orientation.mapUprightLandmarks(landmarks, plan, width, height),
              blendshapes: result.faceBlendshapes[index] ?? { categories: [] },
              region: originalFace.region,
              samplingScale: plan.samplingScale,
              passId: passes,
            }));
          } finally {
            canvas.width = 1;
            canvas.height = 1;
          }
          if (uprightFaces.length > 1) {
            // Same-pass candidates stay distinct even when their boxes overlap.
            faces = crop.deduplicateFaces([...uprightFaces, originalFace], width, height);
            orientationInfo.reason = 'multiple-faces';
          } else if (!uprightFaces.length) {
            orientationInfo.reason = 'no-face';
          } else {
            const agreement = orientation.assessUprightAgreement(originalFace.landmarks, uprightFaces[0].landmarks, width, height);
            orientationInfo.agreement = agreement;
            if (!agreement.comparable) {
              orientationInfo.reason = 'anchor-disagreement';
            } else {
              uprightFace = uprightFaces[0];
              orientationInfo.available = true;
              orientationInfo.recommended = agreement.recommended;
              orientationInfo.reason = agreement.reason;
              if (agreement.recommended) {
                selectedLandmarkVariant = 'upright';
                faces = [uprightFace];
              }
            }
          }
        } else orientationInfo.reason = 'invalid-geometry';
      } else if (!Number.isFinite(rollDegrees)) orientationInfo.reason = 'invalid-geometry';
    } catch (_error) {
      // An optional refinement failure must not discard a valid original mesh.
      uprightFace = null;
      faces = [originalFace];
      selectedLandmarkVariant = 'original';
      orientationInfo.available = false;
      orientationInfo.recommended = false;
      orientationInfo.reason = 'failed';
    }
  }
  const method = originalMethod + (selectedLandmarkVariant === 'upright' ? '-upright' : '');
  return {
    faceLandmarks: faces.map((face) => face.landmarks),
    faceBlendshapes: faces.map((face) => face.blendshapes),
    cropRegions: faces.map((face) => crop.paddedFaceCrop(face.landmarks, width, height) ?? face.region),
    detectionInfo: detectionInfoFor(faces.length === 1 ? faces[0] : null, method),
    ...(faces.length === 1 ? {
      landmarkVariants: {
        original: variantFor(originalFace, originalMethod),
        ...(uprightFace ? { upright: variantFor(uprightFace, originalMethod + '-upright') } : {}),
      },
      selectedLandmarkVariant,
    } : {}),
    orientationInfo,
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
