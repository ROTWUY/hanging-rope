/**
 * 悬挂绳 —— 图片格式识别
 *
 * 为什么需要这个模块：
 *   网页上的图片有 png/jpg/gif/webp/svg/avif 等各种格式，来源的 content-type
 *   和文件名都不一定可靠（CDN 常返回 application/octet-stream，或把 SVG 报成
 *   `image/svg+xml`）。早期版本直接拿 content-type 的子类型拼扩展名，于是
 *   `image/svg+xml` 变成了 `.svgxml` —— 本地 file:// 加载时 Chromium 是按扩展名
 *   猜 MIME 的，认不出的扩展名就不会当图片渲染，卡片上就是一个破图标。
 *
 *   这里改成「以字节为准」：先按文件头魔数判断真实格式，其次才用 content-type、
 *   文件名兜底。纯函数、不依赖 Electron，便于单元测试。
 */
'use strict';

/* content-type → 扩展名（键为小写、不含参数） */
const MIME_EXT = {
  'image/png': 'png',
  'image/apng': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/ico': 'ico',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

/** Chromium 的 <img> 能直接渲染的格式；其余（tiff/heic 等）落地了也是破图 */
const RENDERABLE = new Set(['png', 'jpg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);

const KNOWN_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
  'svg',
  'tif',
  'tiff',
  'heic',
  'heif',
]);

function normalizeExt(ext) {
  const e = String(ext || '')
    .toLowerCase()
    .replace(/^\./, '')
    .replace(/[^a-z0-9]/g, '');
  if (!e) return '';
  if (e === 'jpeg' || e === 'pjpeg') return 'jpg';
  if (e === 'tif') return 'tiff';
  return KNOWN_EXT.has(e) ? e : '';
}

/** content-type → 扩展名。`image/svg+xml` → `svg`，无法识别返回 '' */
function extFromMime(mime) {
  const m = String(mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!m) return '';
  if (MIME_EXT[m]) return MIME_EXT[m];
  if (!m.startsWith('image/')) return '';
  // 兜底：剥掉 `+xml` 之类的结构化后缀（svg+xml / vnd.microsoft.icon …）
  const sub = m.slice(6).replace(/\+.*$/, '').replace(/^x-/, '').replace(/^vnd\./, '');
  return normalizeExt(sub);
}

/** 文件名 → 扩展名 */
function extFromName(name) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(String(name || '').replace(/[?#].*$/, ''));
  return m ? normalizeExt(m[1]) : '';
}

/**
 * 按文件头魔数判断真实图片格式。认不出返回 ''。
 * SVG 是文本格式，只能在前 8KB 文本里找 `<svg`（允许前面有 XML 声明/注释/BOM）。
 */
function sniffExt(buf) {
  if (!buf || !buf.length) return '';
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const len = b.length;
  if (len >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a) return 'png';
  if (len >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (len >= 6 && b.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (
    len >= 12 &&
    b.slice(0, 4).toString('ascii') === 'RIFF' &&
    b.slice(8, 12).toString('ascii') === 'WEBP'
  )
    return 'webp';
  if (len >= 18 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (len >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ico';
  if (len >= 12 && b.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = b.slice(8, 12).toString('ascii').toLowerCase();
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (brand.startsWith('hei')) return 'heif';
  }
  // SVG 兜底：文本里的 <svg 根元素（跳过 BOM）
  const head = b.slice(0, 8192).toString('utf8').replace(/^\uFEFF/, '');
  if (/<svg[\s>]/i.test(head)) return 'svg';
  return '';
}

/**
 * 综合判断一张图应该用什么扩展名落地。
 * 优先级：字节 > content-type > 文件名（字节最可信，见模块头注释）。
 * @returns {{ext:string, source:'bytes'|'mime'|'name'|''}}
 */
function resolveImageExt({ buf, mime, name } = {}) {
  const byBytes = sniffExt(buf);
  if (byBytes) return { ext: byBytes, source: 'bytes' };
  const byMime = extFromMime(mime);
  if (byMime) return { ext: byMime, source: 'mime' };
  const byName = extFromName(name);
  if (byName) return { ext: byName, source: 'name' };
  return { ext: '', source: '' };
}

/** Chromium 的 <img> 能不能直接显示这个扩展名的图 */
function isRenderableExt(ext) {
  return RENDERABLE.has(normalizeExt(ext));
}

/**
 * 解析 data: URL（网页里内联的小图常是这种）。
 * 同时支持 base64 与 percent-encoded 两种写法。
 * @returns {{mime:string, buf:Buffer}|null}
 */
function parseDataUrl(url) {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(String(url || ''));
  if (!m) return null;
  const meta = m[1] || '';
  const isBase64 = /;base64/i.test(meta);
  const mime = meta.split(';')[0].trim().toLowerCase();
  let buf;
  try {
    if (isBase64) {
      buf = Buffer.from(m[2], 'base64');
    } else {
      buf = Buffer.from(decodeURIComponent(m[2]), 'utf8');
    }
  } catch {
    return null;
  }
  if (!buf.length) return null;
  return { mime, buf };
}

/** 从 SVG 文本里读宽高（SVG 没法用 nativeImage 解析，卡片信息靠这个） */
function svgSize(text) {
  const t = String(text || '');
  const w = /\bwidth\s*=\s*["']\s*([\d.]+)(?:px)?\s*["']/i.exec(t);
  const h = /\bheight\s*=\s*["']\s*([\d.]+)(?:px)?\s*["']/i.exec(t);
  if (w && h) {
    return { width: Math.round(parseFloat(w[1])), height: Math.round(parseFloat(h[1])) };
  }
  const vb = /viewBox\s*=\s*["']\s*[-+\d.eE]+[\s,]+[-+\d.eE]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(t);
  if (vb) {
    return { width: Math.round(parseFloat(vb[1])), height: Math.round(parseFloat(vb[2])) };
  }
  return { width: null, height: null };
}

module.exports = {
  MIME_EXT,
  RENDERABLE,
  normalizeExt,
  extFromMime,
  extFromName,
  sniffExt,
  resolveImageExt,
  isRenderableExt,
  parseDataUrl,
  svgSize,
};
