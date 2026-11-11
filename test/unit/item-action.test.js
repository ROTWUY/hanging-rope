/**
 * 单击复制 / 双击打开的动作规划单元测试（纯 Node）
 * 覆盖 PRD AC-51~AC-58 依赖的类型分流与 Windows 剪贴板字节格式。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { planCopy, planOpen, fileNameWBuffer } = require('../../src/main/item-action');

const text = { type: 'text', text: '周四 14:00 同步' };
const image = { type: 'image', cachePath: 'E:\\cache\\img_abc.png' };
const file = { type: 'file', path: 'E:\\Work\\报告.docx' };
const folder = { type: 'folder', path: 'E:\\Work\\Pics' };

/* ---------------- 复制 ---------------- */

test('复制文字：写文本；复制图片挂件：写图片副本', () => {
  assert.deepEqual(planCopy(text), { ok: true, kind: 'text', payload: { text: text.text } });
  assert.deepEqual(planCopy(image), {
    ok: true,
    kind: 'image',
    payload: { imageCachePath: image.cachePath },
  });
});

test('复制文件 / 文件夹：作为可粘贴的文件对象（FileNameW 列表）', () => {
  assert.deepEqual(planCopy(file), {
    ok: true,
    kind: 'files',
    payload: { paths: [file.path] },
  });
  assert.deepEqual(planCopy(folder).payload.paths, [folder.path]);
});

test('复制空文字 / 无副本图片 / 无路径 / 未知类型 / 空目标都明确失败', () => {
  assert.equal(planCopy({ type: 'text', text: '' }).ok, false);
  assert.equal(planCopy({ type: 'image' }).ok, false);
  assert.equal(planCopy({ type: 'file' }).ok, false);
  assert.equal(planCopy({ type: 'folder' }).ok, false);
  assert.equal(planCopy({ type: 'video' }).ok, false);
  assert.equal(planCopy(null).ok, false);
  assert.equal(planCopy(undefined).ok, false);
  assert.ok(planCopy(null).message);
});

/* ---------------- 打开 ---------------- */

test('打开文件 / 文件夹：用原始路径交给系统默认程序', () => {
  assert.deepEqual(planOpen(file), { ok: true, kind: 'open', payload: { path: file.path } });
  assert.deepEqual(planOpen(folder).payload.path, folder.path);
});

test('打开图片：网页图片用缓存副本，图片文件用原始路径', () => {
  assert.equal(planOpen(image).payload.path, image.cachePath);
  assert.equal(planOpen({ type: 'file', path: 'E:\\Pics\\a.png' }).payload.path, 'E:\\Pics\\a.png');
  // 缓存优先，缺失时回退到原始路径
  assert.equal(
    planOpen({ type: 'image', cachePath: '', path: 'E:\\Pics\\b.png' }).payload.path,
    'E:\\Pics\\b.png'
  );
});

test('文字没有文件本体：双击打开退化为复制并提示', () => {
  const r = planOpen(text);
  assert.equal(r.ok, false);
  assert.equal(r.fallback, 'copy');
  assert.match(r.message, /文字/);
});

test('打开无路径对象 / 空目标：明确失败而不是静默', () => {
  assert.equal(planOpen({ type: 'image' }).ok, false);
  assert.equal(planOpen({ type: 'file' }).ok, false);
  assert.equal(planOpen(null).ok, false);
});

/* ---------------- Windows 剪贴板字节 ---------------- */

test('FileNameW：单路径为 UTF-16LE + 双 NUL 结尾，可被读回解析', () => {
  const buf = fileNameWBuffer([file.path]);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString('utf16le'), file.path + '\0\0');
  assert.deepEqual(buf.toString('utf16le').split('\0').filter(Boolean), [file.path]);
});

test('FileNameW：多路径用 NUL 分隔、双 NUL 结尾', () => {
  const list = [file.path, folder.path];
  const s = fileNameWBuffer(list).toString('utf16le');
  assert.equal(s, list.join('\0') + '\0\0');
  assert.deepEqual(s.split('\0').filter(Boolean), list);
});

test('FileNameW：空列表 / 非法项返回空 Buffer，绝不写脏剪贴板', () => {
  assert.equal(fileNameWBuffer([]).length, 0);
  assert.equal(fileNameWBuffer(null).length, 0);
  assert.equal(fileNameWBuffer(['', '   ', null, 123]).length, 0);
  assert.deepEqual(
    fileNameWBuffer([file.path, '', null]).toString('utf16le').split('\0').filter(Boolean),
    [file.path]
  );
});
