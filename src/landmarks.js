/** Prepare and select cached landmark passes without repeating inference. */
import { extractGeometry, summarizeQuality } from './geometry.js';
import { analyzeLipReliability } from './expression.js';

export function prepareLandmarkChoices(response, width, height) {
  const variants = response.landmarkVariants ?? { original: {
    landmarks: response.faceLandmarks?.[0], blendshapes: response.faceBlendshapes?.[0],
    cropRegion: response.cropRegions?.[0], detectionInfo: response.detectionInfo,
  } };
  const choices = {};
  for (const mode of ['original', 'upright']) {
    const variant = variants[mode];
    if (!variant) continue;
    const result = extractGeometry(variant.landmarks, width, height);
    if (!result.valid) continue;
    const blendshapes = Array.isArray(variant.blendshapes?.categories) ? variant.blendshapes.categories : [];
    choices[mode] = { ...variant, result, blendshapes,
      quality: summarizeQuality(variant.landmarks, width, height, blendshapes) };
  }
  return choices;
}

export function applyLandmarkChoice(photo, mode) {
  const choice = photo.landmarkChoices?.[mode];
  if (!choice?.result?.valid) return false;
  Object.assign(photo, choice, { landmarkMode: mode,
    lip: analyzeLipReliability(choice.blendshapes, choice.quality, photo.lipMode) });
  return true;
}
