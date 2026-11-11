/**
 * 路径归一化单元测试（纯 Node）
 * 覆盖 PRD AC-45「同一个子文件夹不重复固定」与 AC-47/AC-50
 * 「再点 📌 取消固定、等价变体一次全摘」依赖的路径等价判断。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { pathKey, samePath, pinnedItems } = require('../../src/main/paths');

test('大小写不同视为同一目标（Windows 不区分大小写）', () => {
  assert.equal(pathKey('C:\\Users\\A\\Docs'), pathKey('c:\\users\\a\\docs'));
  assert.ok(samePath('E:\\Work\\Pics', 'e:/work/pics'));
});

test('斜杠方向不同视为同一目标', () => {
  assert.equal(pathKey('E:\\WorkBuddy\\Test\\a'), 'e:/workbuddy/test/a');
  assert.ok(samePath('E:/WorkBuddy/Test/a', 'E:\\WorkBuddy\\Test\\a'));
});

test('末尾分隔符可有可无（含盘符根）', () => {
  assert.ok(samePath('E:\\Work\\', 'E:\\Work'));
  assert.ok(samePath('E:\\Work\\\\', 'e:/work/'));
  assert.equal(pathKey('C:\\'), 'c:/');
  assert.equal(pathKey('c:'), 'c:/');
});

test('中文与空格路径不被破坏', () => {
  assert.ok(samePath('E:\\版式设计\\8月24日', 'e:/版式设计/8月24日/'));
  assert.equal(pathKey('  E:\\a b\\c  '), 'e:/a b/c');
});

test('不同路径不相等；空值得到空键', () => {
  assert.ok(!samePath('E:\\a\\b', 'E:\\a\\bc'));
  assert.ok(!samePath('E:\\a', 'F:\\a'));
  assert.equal(pathKey(''), '');
  assert.equal(pathKey(null), '');
  assert.equal(pathKey(undefined), '');
  assert.equal(pathKey(123), '');
  assert.ok(!samePath('', ''));
});

/* --- pinnedItems：📌 固定去重 / 再点取消固定的共用判定（AC-45/47/50） --- */

test('等价路径变体都能命中同一个已固定目标', () => {
  const items = [{ id: 'a', type: 'folder', path: 'E:\\WorkBuddy\\Test\\Pics' }];
  for (const variant of [
    'E:\\WorkBuddy\\Test\\Pics',
    'e:/workbuddy/test/pics',
    'E:/WorkBuddy/Test/Pics/',
    'E:\\WORKBUDDY\\test\\pics\\\\',
    '  E:\\WorkBuddy\\Test\\Pics  ',
  ]) {
    assert.deepEqual(
      pinnedItems(items, variant).map((i) => i.id),
      ['a'],
      '变体应命中：' + variant
    );
  }
});

test('只把文件/文件夹挂件算作"已固定"，图片与文字不参与', () => {
  const p = 'E:\\WorkBuddy\\Test\\Pics';
  const items = [
    { id: 'img', type: 'image', path: p },
    { id: 'txt', type: 'text', path: p },
    { id: 'dir', type: 'folder', path: p },
    { id: 'file', type: 'file', path: p },
  ];
  assert.deepEqual(
    pinnedItems(items, p).map((i) => i.id),
    ['dir', 'file']
  );
});

test('同一目标重复挂多份时全部返回，供取消固定一次摘净', () => {
  const items = [
    { id: '1', type: 'folder', path: 'E:\\Work\\Pics' },
    { id: '2', type: 'folder', path: 'e:/work/pics/' },
    { id: '3', type: 'folder', path: 'E:\\Work\\Other' },
    { id: '4', type: 'image', path: 'E:\\Work\\Pics' },
  ];
  assert.deepEqual(
    pinnedItems(items, 'E:\\Work\\Pics\\').map((i) => i.id),
    ['1', '2']
  );
});

test('前缀相同但目标不同不误命中', () => {
  const items = [
    { id: 'x', type: 'folder', path: 'E:\\Work\\PicsExtra' },
    { id: 'y', type: 'folder', path: 'F:\\Work\\Pics' },
  ];
  assert.deepEqual(pinnedItems(items, 'E:\\Work\\Pics'), []);
});

test('空值 / 非法输入 / 缺 path 的挂件安全返回空数组', () => {
  const items = [
    { id: 'no-path', type: 'folder' },
    { id: 'blank', type: 'folder', path: '   ' },
    { id: 'null-path', type: 'file', path: null },
  ];
  assert.deepEqual(pinnedItems(items, ''), []);
  assert.deepEqual(pinnedItems(items, null), []);
  assert.deepEqual(pinnedItems(items, 123), []);
  assert.deepEqual(pinnedItems(items, '   '), []);
  assert.deepEqual(pinnedItems(null, 'E:\\Work\\Pics'), []);
  assert.deepEqual(pinnedItems(items, 'E:\\Work\\Pics'), []);
});
