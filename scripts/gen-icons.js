/**
 * 生成应用图标（纯 Node 实现 PNG 编码，不依赖任何第三方库）
 * 产物：assets/icon.png (256x256)、assets/tray.png (32x32)
 * 用法：npm run icons
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 极简绘图 ---------------- */
function createCanvas(size) {
  const px = new Float64Array(size * size * 4); // rgba 0..255, a 0..1 存第四通道为 alpha*255
  return {
    size,
    px,
    blend(x, y, r, g, b, a) {
      if (x < 0 || y < 0 || x >= size || y >= size || a <= 0) return;
      const i = (y * size + x) * 4;
      const sa = a;
      const da = px[i + 3] / 255;
      const oa = sa + da * (1 - sa);
      if (oa <= 0) return;
      px[i] = (r * sa + px[i] * da * (1 - sa)) / oa;
      px[i + 1] = (g * sa + px[i + 1] * da * (1 - sa)) / oa;
      px[i + 2] = (b * sa + px[i + 2] * da * (1 - sa)) / oa;
      px[i + 3] = oa * 255;
    },
  };
}

function roundRect(canvas, x, y, w, h, r, color, alpha = 1) {
  const [cr, cg, cb] = color;
  for (let py = Math.floor(y); py < Math.ceil(y + h); py++) {
    for (let px = Math.floor(x); px < Math.ceil(x + w); px++) {
      // 4x4 超采样求覆盖率
      let hit = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const fx = px + (sx + 0.5) / 4;
          const fy = py + (sy + 0.5) / 4;
          let inside = false;
          if (fx >= x + r && fx <= x + w - r) inside = fy >= y && fy <= y + h;
          else if (fy >= y + r && fy <= y + h - r) inside = fx >= x && fx <= x + w;
          else {
            const cx = fx < x + r ? x + r : x + w - r;
            const cy = fy < y + r ? y + r : y + h - r;
            inside = (fx - cx) ** 2 + (fy - cy) ** 2 <= r * r;
          }
          if (inside) hit++;
        }
      }
      if (hit) canvas.blend(px, py, cr, cg, cb, alpha * (hit / 16));
    }
  }
}

function downsample(canvas, outSize) {
  const { size, px } = canvas;
  const ratio = size / outSize;
  const out = Buffer.alloc(outSize * outSize * 4);
  for (let y = 0; y < outSize; y++) {
    for (let x = 0; x < outSize; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = Math.floor(y * ratio); sy < Math.floor((y + 1) * ratio); sy++) {
        for (let sx = Math.floor(x * ratio); sx < Math.floor((x + 1) * ratio); sx++) {
          const i = (sy * size + sx) * 4;
          const pa = px[i + 3] / 255;
          r += px[i] * pa;
          g += px[i + 1] * pa;
          b += px[i + 2] * pa;
          a += pa;
          n++;
        }
      }
      const o = (y * outSize + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return out;
}

/* ---------------- 绘制图标 ---------------- */
function drawIcon(targetSize) {
  const SS = 4;
  const S = targetSize * SS;
  const c = createCanvas(S);
  const u = S / 100; // 百分比单位

  // 底板：深色圆角方形
  roundRect(c, 4 * u, 4 * u, 92 * u, 92 * u, 24 * u, [22, 24, 29], 1);
  // 内层微亮描边
  roundRect(c, 5.4 * u, 5.4 * u, 89.2 * u, 89.2 * u, 22.8 * u, [42, 46, 55], 0.9);
  roundRect(c, 6.6 * u, 6.6 * u, 86.8 * u, 86.8 * u, 21.6 * u, [17, 19, 23], 1);

  // 绳索：一条横贯的暖色绳
  roundRect(c, 8 * u, 27 * u, 84 * u, 4.2 * u, 2.1 * u, [226, 163, 74], 1);
  roundRect(c, 8 * u, 27 * u, 84 * u, 1.6 * u, 0.8 * u, [255, 214, 150], 0.85);

  // 两个悬挂的小卡片
  roundRect(c, 22 * u, 33 * u, 24 * u, 30 * u, 5 * u, [236, 240, 248], 1);
  roundRect(c, 27 * u, 40 * u, 14 * u, 2.6 * u, 1.3 * u, [140, 150, 170], 1);
  roundRect(c, 27 * u, 46 * u, 10 * u, 2.6 * u, 1.3 * u, [176, 184, 200], 1);

  roundRect(c, 54 * u, 33 * u, 24 * u, 30 * u, 5 * u, [226, 163, 74], 1);
  roundRect(c, 59 * u, 40 * u, 14 * u, 2.6 * u, 1.3 * u, [110, 74, 26], 1);
  roundRect(c, 59 * u, 46 * u, 9 * u, 2.6 * u, 1.3 * u, [140, 96, 38], 1);

  return downsample(c, targetSize);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

for (const [name, size] of [['icon.png', 256], ['tray.png', 32]]) {
  const rgba = drawIcon(size);
  const png = encodePNG(size, size, rgba);
  fs.writeFileSync(path.join(outDir, name), png);
  console.log('written', name, size, png.length + ' bytes');
}
