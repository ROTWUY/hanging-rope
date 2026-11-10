/**
 * 路径归一化单元测试（纯 Node）
 * 覆盖 PRD AC-45「同一个子文件夹不重复固定」依赖的路径等价判断。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { pathKey, samePath } = require('../../src/main/paths');

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
