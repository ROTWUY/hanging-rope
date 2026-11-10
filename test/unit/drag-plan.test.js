/**
 * 拖出载荷决策单元测试
 * 覆盖 PRD：F4 拖出插入 / F9 快捷方式 / AC-31、AC-32
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planDrag, DANGLING_LNK_WARNING } = require('../../src/main/drag-plan');

const EXISTING = new Set(['C:\\tmp\\a.txt', 'C:\\tmp\\dir', 'C:\\tmp\\cache\\img.png', 'C:\\tmp\\gone.lnk']);
const FILES = new Set(['C:\\tmp\\a.txt', 'C:\\tmp\\cache\\img.png', 'C:\\tmp\\gone.lnk']);

const deps = {
  exists: (p) => EXISTING.has(p),
  stat: (p) => (EXISTING.has(p) ? { isDirectory: () => p === 'C:\\tmp\\dir' } : null),
  resolveShortcut: (p) =>
    p === 'C:\\tmp\\valid.lnk'
      ? { path: 'C:\\tmp\\a.txt', shortcut: 'C:\\tmp\\valid.lnk' }
      : { path: p, shortcut: null },
};

test('文件：直接发送原路径', () => {
  const plan = planDrag({ kind: 'file', path: 'C:\\tmp\\a.txt' }, deps);
  assert.equal(plan.ok, true);
  assert.equal(plan.target, 'C:\\tmp\\a.txt');
  assert.equal(plan.warning, '');
});

test('文件夹：与文件同样发送本体', () => {
  const plan = planDrag({ kind: 'folder', path: 'C:\\tmp\\dir' }, deps);
  assert.equal(plan.ok, true);
  assert.equal(plan.target, 'C:\\tmp\\dir');
});

test('图片挂件：发送缓存副本', () => {
  const plan = planDrag({ kind: 'image', cachePath: 'C:\\tmp\\cache\\img.png' }, deps);
  assert.equal(plan.ok, true);
  assert.equal(plan.target, 'C:\\tmp\\cache\\img.png');
});

test('图片缓存丢失：拒绝拖出并说明原因', () => {
  const plan = planDrag({ kind: 'image', cachePath: 'C:\\tmp\\cache\\missing.png' }, deps);
  assert.equal(plan.ok, false);
  assert.match(plan.warning, /缓存/);
});

test('快捷方式：映射到本体，不出现警告（AC-31）', () => {
  const plan = planDrag({ kind: 'file', path: 'C:\\tmp\\valid.lnk' }, deps);
  assert.equal(plan.ok, true);
  assert.equal(plan.target, 'C:\\tmp\\a.txt');
  assert.equal(plan.shortcut, 'C:\\tmp\\valid.lnk');
  assert.equal(plan.warning, '');
});

test('悬空快捷方式：降级发送 .lnk 本身并给出警告（AC-32）', () => {
  const plan = planDrag({ kind: 'file', path: 'C:\\tmp\\gone.lnk' }, deps);
  assert.equal(plan.ok, true);
  assert.equal(plan.target, 'C:\\tmp\\gone.lnk');
  assert.equal(plan.warning, DANGLING_LNK_WARNING);
});

test('源文件不存在：拒绝拖出并提示', () => {
  const plan = planDrag({ kind: 'file', path: 'C:\\tmp\\nope.txt' }, deps);
  assert.equal(plan.ok, false);
  assert.match(plan.warning, /不存在/);
});

test('空载荷：拒绝拖出', () => {
  const plan = planDrag({}, deps);
  assert.equal(plan.ok, false);
  assert.ok(plan.warning.length > 0);
});
