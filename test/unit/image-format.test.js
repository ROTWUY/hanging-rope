/**
 * 图片格式识别单元测试（纯 Node）
 * 覆盖：AC-37 网页图片（含 svg+xml）落地扩展名正确 / AC-38 非图片内容被识别并拒绝
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fmt = require('../../src/main/image-format');

/* ---------------- 样本字节 ---------------- */

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a', 'ascii');
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 ', 'ascii'),
]);
const BMP = Buffer.concat([Buffer.from('BM', 'ascii'), Buffer.alloc(20, 0)]);
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00]);
const AVIF = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from('ftypavif', 'ascii'),
  Buffer.alloc(20, 0),
]);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1620" height="560"><rect width="10" height="10"/></svg>',
  'utf8'
);
const SVG_WITH_DECL = Buffer.from(
  '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- exported -->\n<svg viewBox="0 0 120 60"><g/></svg>',
  'utf8'
);
const HTML = Buffer.from('<!DOCTYPE html><html><body>403 Forbidden</body></html>', 'utf8');

/* ---------------- 用例 ---------------- */

test('sniffExt：按文件头识别常见格式', () => {
  assert.equal(fmt.sniffExt(PNG), 'png');
  assert.equal(fmt.sniffExt(JPG), 'jpg');
  assert.equal(fmt.sniffExt(GIF), 'gif');
  assert.equal(fmt.sniffExt(WEBP), 'webp');
  assert.equal(fmt.sniffExt(BMP), 'bmp');
  assert.equal(fmt.sniffExt(ICO), 'ico');
  assert.equal(fmt.sniffExt(AVIF), 'avif');
  assert.equal(fmt.sniffExt(SVG), 'svg');
});

test('sniffExt：SVG 带 BOM / XML 声明 / 注释也能识别', () => {
  assert.equal(fmt.sniffExt(SVG_WITH_DECL), 'svg');
});

test('sniffExt：非图片字节返回空（AC-38 防盗链 HTML 页面）', () => {
  assert.equal(fmt.sniffExt(HTML), '');
  assert.equal(fmt.sniffExt(Buffer.alloc(0)), '');
  assert.equal(fmt.sniffExt(Buffer.from('hello world', 'utf8')), '');
  assert.equal(fmt.sniffExt(null), '');
});

test('extFromMime：image/svg+xml → svg（旧版本正是这里拼出了 .svgxml）', () => {
  assert.equal(fmt.extFromMime('image/svg+xml'), 'svg');
  assert.equal(fmt.extFromMime('image/svg+xml; charset=utf-8'), 'svg');
  assert.equal(fmt.extFromMime('IMAGE/JPEG'), 'jpg');
  assert.equal(fmt.extFromMime('image/vnd.microsoft.icon'), 'ico');
  assert.equal(fmt.extFromMime('image/avif'), 'avif');
  assert.equal(fmt.extFromMime('text/html'), '');
  assert.equal(fmt.extFromMime(''), '');
});

test('extFromMime：任何 mime 都不会产出带非法字符的扩展名', () => {
  const samples = [
    'image/svg+xml',
    'image/x-icon',
    'image/vnd.microsoft.icon',
    'image/heic-sequence',
    'image/png;foo=bar',
    'application/octet-stream',
  ];
  for (const m of samples) {
    const ext = fmt.extFromMime(m);
    assert.ok(/^[a-z0-9]*$/.test(ext), `${m} → ${ext} 含非法字符`);
  }
});

test('resolveImageExt：字节优先于 mime（mime 撒谎也能救回来）', () => {
  const r = fmt.resolveImageExt({ buf: SVG, mime: 'image/png' });
  assert.equal(r.ext, 'svg');
  assert.equal(r.source, 'bytes');
});

test('resolveImageExt：无字节依据时回落到 mime，再回落到文件名', () => {
  assert.equal(fmt.resolveImageExt({ buf: HTML, mime: 'image/svg+xml' }).ext, 'svg');
  assert.equal(fmt.resolveImageExt({ buf: null, name: 'photo.JPEG' }).ext, 'jpg');
  assert.equal(fmt.resolveImageExt({ buf: HTML }).ext, '');
});

test('isRenderableExt：Chromium 能显示 svg/webp/avif，不能显示 tiff/heic', () => {
  for (const e of ['png', 'jpg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif', 'SVG']) {
    assert.equal(fmt.isRenderableExt(e), true, e);
  }
  for (const e of ['tiff', 'heic', 'svgxml', '', 'html']) {
    assert.equal(fmt.isRenderableExt(e), false, e);
  }
});

test('parseDataUrl：支持 base64 与 percent-encoded 两种写法', () => {
  const b64 = 'data:image/svg+xml;base64,' + SVG.toString('base64');
  const a = fmt.parseDataUrl(b64);
  assert.equal(a.mime, 'image/svg+xml');
  assert.equal(fmt.sniffExt(a.buf), 'svg');

  const plain =
    'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg width="8" height="8"></svg>');
  const b = fmt.parseDataUrl(plain);
  assert.equal(b.mime, 'image/svg+xml');
  assert.equal(fmt.sniffExt(b.buf), 'svg');

  assert.equal(fmt.parseDataUrl('https://a/b.png'), null);
  assert.equal(fmt.parseDataUrl('data:image/png;base64,'), null);
});

test('svgSize：读 width/height，缺失时读 viewBox', () => {
  assert.deepEqual(fmt.svgSize(SVG.toString('utf8')), { width: 1620, height: 560 });
  assert.deepEqual(fmt.svgSize(SVG_WITH_DECL.toString('utf8')), { width: 120, height: 60 });
  assert.deepEqual(fmt.svgSize('<svg></svg>'), { width: null, height: null });
});
