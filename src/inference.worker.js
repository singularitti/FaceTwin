let landmarker;
let initializing;

async function initialize() {
  if (landmarker) return;
  if (initializing) return initializing;
  initializing = (async () => {
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

self.onmessage = async ({ data }) => {
  const { id, type, bitmap } = data;
  try {
    if (type === 'initialize') {
      const connections = await initialize();
      self.postMessage({ id, ok: true, connections });
    } else if (type === 'detect') {
      if (!landmarker) throw new Error('模型尚未初始化。');
      const result = landmarker.detect(bitmap);
      self.postMessage({ id, ok: true, faceLandmarks: result.faceLandmarks, faceBlendshapes: result.faceBlendshapes });
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
