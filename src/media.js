/** Decode without altering the input File. HEIF fallback is loopback-only. */
export const isHeif = (file) => /\.(heic|heif|hif)$/i.test(file.name) || /^image\/hei[cf](?:-sequence)?$/i.test(file.type);
export const isSupportedImage = (file) => isHeif(file) || ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);

async function decodeUrl(url) {
  const image = new Image();
  image.src = url;
  let timer;
  try {
    await Promise.race([
      image.decode(),
      new Promise((_, reject) => { timer = setTimeout(() => { image.removeAttribute('src'); reject(new Error('Image decoding timed out')); }, 30000); }),
    ]);
  } finally { clearTimeout(timer); }
  return image;
}

export async function loadPhoto(file) {
  let url = URL.createObjectURL(file);
  try {
    const image = await decodeUrl(url);
    return { image, url, colorNote: isHeif(file) ? 'HEIF 原图由浏览器直接解码；HDR 显示效果取决于浏览器和屏幕。' : '', decodeMethod: 'browser-native' };
  } catch (_error) {
    URL.revokeObjectURL(url);
    if (!isHeif(file)) throw new Error('有照片无法解码，请确认文件完整且格式正确。');
  }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname)) {
    throw new Error('此浏览器不能直接读取 HEIF。请用 uv run python scripts/serve.py 在本机打开，或使用支持 HEIF 的浏览器。');
  }
  let response;
  try {
    response = await fetch('./api/decode-heif', {
      method: 'POST', body: file, cache: 'no-store',
      headers: { 'Content-Type': 'application/octet-stream', 'X-FaceTwin-Decode': '1' },
      signal: AbortSignal.timeout(90000),
    });
  } catch (_error) { throw new Error('本机 HEIF 解码不可用或超时。请运行 uv sync 后重新启动本地服务器。'); }
  if (!response.ok) throw new Error('HEIF 解码失败：文件可能损坏、色彩描述不受支持或尺寸过大。请先运行 uv sync，并重新启动本地服务器。');
  const blob = await response.blob();
  url = URL.createObjectURL(blob);
  try {
    const image = await decodeUrl(url);
    const hasProfile = response.headers.get('X-FaceTwin-Color')?.startsWith('icc-preserved');
    return { image, url, decodeMethod: 'local-heif-preview', colorNote: `本机 HEIF 预览：${hasProfile ? '保留 ICC 色彩描述' : '无可保留的 ICC 色彩描述'}。仅为 8 位预览，不保证原始 HDR 外观；原文件未修改。` };
  } catch (_error) { URL.revokeObjectURL(url); throw new Error('本机生成的 HEIF 预览无法显示。'); }
}
