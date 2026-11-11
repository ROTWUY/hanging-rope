/**
 * 统一去重单元测试（纯 Node）
 * 覆盖 PRD v1.6 AC-61~AC-68 依赖的比较键、判重与历史重复合并。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  contentHash,
  itemKey,
  candidateKey,
  findDuplicate,
  collapseDuplicates,
} = require('../../src/main/dedupe');

const file = (p, extra = {}) => ({ id: 'x', type: 'file', path: p, name: 'f', ...extra });

test('contentHash：相同字节同一指纹，不同字节不同指纹', () => {
  const a = Buffer.from('悬挂绳图片内容');
  const b = Buffer.from('悬挂绳图片内容');
  const c = Buffer.from('另一张图片');
  assert.match(contentHash(a), /^[0-9a-f]{40}$/);
  assert.equal(contentHash(a), contentHash(b));
  assert.notEqual(contentHash(a), contentHash(c));
  assert.equal(contentHash(new Uint8Array(a)), contentHash(a));
});

test('itemKey：文件/文件夹按归一化路径，大小写/斜杠/末尾分隔符等价', () => {
  const a = itemKey(file('E:\\Desktop\\PixPin.png'));
  assert.equal(a, itemKey(file('e:/desktop/pixpin.png')));
  assert.equal(a, itemKey(file('E:/Desktop/PixPin.png/')));
  assert.equal(a, itemKey({ type: 'folder', path: 'E:\\Desktop\\PixPin.png' }));
  assert.notEqual(a, itemKey(file('E:\\Desktop\\PixPin-2.png')));
});

test('itemKey：盘符根 C:\\ 与 C: 等价；空路径不产生键', () => {
  assert.equal(itemKey(file('C:\\')), itemKey(file('C:')));
  assert.equal(itemKey(file('')), '');
  assert.equal(itemKey({ type: 'file' }), '');
});

test('itemKey：图片优先用内容指纹，老数据退回缓存副本路径', () => {
  const h = contentHash(Buffer.from('img'));
  const withHash = { type: 'image', hash: h, cachePath: 'E:\\cache\\a.png' };
  assert.equal(itemKey(withHash), 'image:' + h);
  assert.equal(
    itemKey(withHash),
    itemKey({ type: 'image', hash: h.toUpperCase(), cachePath: 'E:\\cache\\b.png' }),
    '同一指纹、不同缓存副本仍是同一张图'
  );
  const legacy = { type: 'image', cachePath: 'E:\\cache\\a.png' };
  assert.equal(itemKey(legacy), 'cache:e:/cache/a.png');
  assert.equal(itemKey(legacy), itemKey({ type: 'image', cachePath: 'e:/cache/a.png' }));
  assert.equal(itemKey({ type: 'image' }), '');
});

test('itemKey：文字按完整内容，不同类型不互相吃掉', () => {
  assert.equal(itemKey({ type: 'text', text: '同一段文字' }), 'text:同一段文字');
  assert.notEqual(
    itemKey({ type: 'text', text: '同一段文字' }),
    itemKey({ type: 'text', text: '同一段文字 ' })
  );
  assert.equal(itemKey({ type: 'text', text: '' }), '');
  assert.notEqual(itemKey({ type: 'text', text: 'abc' }), itemKey(file('abc')));
  assert.equal(itemKey({ type: 'unknown', path: 'x' }), '');
  assert.equal(itemKey(null), '');
});

test('candidateKey 与 itemKey 同规则：路径 / 图片字节 / 文字', () => {
  const p = 'D:\\Work\\report.docx';
  assert.equal(candidateKey({ type: 'folder', path: p }), itemKey({ type: 'folder', path: p }));
  const buf = Buffer.from('同一张图片');
  assert.equal(
    candidateKey({ type: 'image', buf }),
    itemKey({ type: 'image', hash: contentHash(buf), cachePath: 'any' })
  );
  assert.equal(candidateKey({ type: 'text', text: 'hi' }), itemKey({ type: 'text', text: 'hi' }));
  assert.equal(candidateKey({ type: 'image', buf: Buffer.alloc(0) }), '');
  assert.equal(candidateKey(null), '');
});

test('findDuplicate：找到同一目标（含 .lnk 解析后本体与路径变体）', () => {
  const items = [
    file('C:\\Other\\a.txt', { id: 'other' }),
    { id: 't', type: 'text', text: '文字' },
    file('E:\\Desktop\\PixPin.png', { id: 'target' }),
  ];
  const hit = findDuplicate(items, { type: 'file', path: 'e:/desktop/pixpin.png/' });
  assert.equal(hit && hit.id, 'target');
  assert.equal(findDuplicate(items, { type: 'text', text: '文字' }).id, 't');
});

test('findDuplicate：不同内容不误判；无法判定时一律放行', () => {
  const items = [file('E:\\Desktop\\a.png'), { type: 'text', text: 'a' }];
  assert.equal(findDuplicate(items, { type: 'file', path: 'E:\\Desktop\\b.png' }), null);
  assert.equal(findDuplicate(items, { type: 'text', text: 'b' }), null);
  assert.equal(findDuplicate(items, { type: 'file', path: '' }), null);
  assert.equal(findDuplicate(items, null), null);
  assert.equal(findDuplicate([], { type: 'file', path: 'E:\\a' }), null);
});

test('findDuplicate：图片按字节判重，缓存副本文件名不同也算同一张', () => {
  const buf = Buffer.from('PNG-BYTES');
  const items = [{ id: 'img1', type: 'image', hash: contentHash(buf), cachePath: 'E:\\c\\img_1.png' }];
  assert.equal(findDuplicate(items, { type: 'image', buf }).id, 'img1');
  assert.equal(findDuplicate(items, { type: 'image', buf: Buffer.from('PNG-BYTE2') }), null);
});

test('collapseDuplicates：保留最早一张、顺序不变、一次摘净多份变体', () => {
  const items = [
    { id: '1', type: 'text', text: 'A' },
    file('E:\\Desktop\\a.png', { id: '2' }),
    { id: '3', type: 'folder', path: 'e:/desktop/a.png/' },
    { id: '4', type: 'text', text: 'B' },
    file('E:\\Desktop\\A.PNG\\', { id: '5' }),
  ];
  const { kept, removed } = collapseDuplicates(items);
  assert.deepEqual(kept.map((i) => i.id), ['1', '2', '4']);
  assert.deepEqual(removed.map((i) => i.id), ['3', '5']);
});

test('collapseDuplicates：图片同指纹不同副本合并；无法判定的挂件全部保留', () => {
  const h = contentHash(Buffer.from('same'));
  const items = [
    { id: 'i1', type: 'image', hash: h, cachePath: 'E:\\c\\1.png' },
    { id: 'i2', type: 'image', hash: h, cachePath: 'E:\\c\\2.png' },
    { id: 'i3', type: 'image', cachePath: 'E:\\c\\1.png' },
    { id: 'u1', type: 'mystery' },
    { id: 'u2', type: 'file' },
    { id: 'u3', type: 'image' },
  ];
  const { kept, removed } = collapseDuplicates(items);
  assert.deepEqual(kept.map((i) => i.id), ['i1', 'u1', 'u2', 'u3']);
  assert.deepEqual(removed.map((i) => i.id), ['i2', 'i3']);
});

test('collapseDuplicates：没有重复时原样返回；空输入安全', () => {
  const items = [{ id: '1', type: 'text', text: 'A' }, file('E:\\a', { id: '2' })];
  const r = collapseDuplicates(items);
  assert.deepEqual(r.kept, items);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(collapseDuplicates(null), { kept: [], removed: [] });
});
