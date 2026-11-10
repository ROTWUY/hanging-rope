/**
 * 窗口几何与触顶判定单元测试
 * 覆盖 PRD：2.1 窗口形态 / 2.2 隐藏与唤出 / AC-03~06
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../../src/main/geometry');

const FS = { x: 0, y: 0, width: 1920, height: 1080 };

test('1920 屏：宽度 = 640，水平居中，初始位置在屏幕外', () => {
  const b = geo.computeWindowBounds(FS, 210);
  assert.equal(b.width, 640);
  assert.equal(b.x, 640);
  assert.equal(b.y, -210, '初始 y 应等于负的高度（完全隐藏）');
  assert.equal(b.height, 210);
  assert.equal(b.x + b.width / 2, FS.width / 2, '必须水平居中');
});

test('非整除宽度按四舍五入，误差不超过 1px', () => {
  const b = geo.computeWindowBounds({ x: 0, y: 0, width: 1366, height: 768 }, 210);
  assert.ok(Math.abs(b.width - 1366 / 3) <= 1, `width=${b.width}`);
  const center = b.x + b.width / 2;
  assert.ok(Math.abs(center - 683) <= 1, `center=${center}`);
});

test('显示器有原点偏移时整体平移', () => {
  const b = geo.computeWindowBounds({ x: 1920, y: 0, width: 1920, height: 1080 }, 210);
  assert.equal(b.width, 640);
  assert.equal(b.x, 1920 + 640);
  assert.equal(b.y, -210);
});

test('触顶热区：只认绳索宽度范围 + 屏幕最上沿（AC-04/05）', () => {
  const b = geo.computeWindowBounds(FS, 210);
  // 中间命中
  assert.equal(geo.isTopEdgeHit({ x: b.x + 10, y: 0 }, FS, b.x, b.width), true);
  assert.equal(geo.isTopEdgeHit({ x: b.x + b.width - 1, y: 1 }, FS, b.x, b.width), true);
  // 左右两侧不命中
  assert.equal(geo.isTopEdgeHit({ x: b.x - 1, y: 0 }, FS, b.x, b.width), false);
  assert.equal(geo.isTopEdgeHit({ x: b.x + b.width, y: 0 }, FS, b.x, b.width), false);
  assert.equal(geo.isTopEdgeHit({ x: 100, y: 0 }, FS, b.x, b.width), false, '左侧 1/3 不应唤出');
  assert.equal(geo.isTopEdgeHit({ x: 1800, y: 0 }, FS, b.x, b.width), false, '右侧 1/3 不应唤出');
  // 离开顶边（哪怕只差 3px）不命中
  assert.equal(geo.isTopEdgeHit({ x: b.x + 10, y: 5 }, FS, b.x, b.width), false);
});

test('触顶停留计数：连续 2 次才唤出，掠过不唤出（AC-06）', () => {
  let s = geo.nextEdgeTicks(0, true);
  assert.deepEqual(s, { ticks: 1, show: false }, '第一次命中不应立刻唤出');
  s = geo.nextEdgeTicks(s.ticks, true);
  assert.equal(s.show, true, '连续命中达到阈值应唤出');

  // 掠过：命中一次后离开 → 计数归零，永不唤出
  s = geo.nextEdgeTicks(0, true);
  s = geo.nextEdgeTicks(s.ticks, false);
  assert.deepEqual(s, { ticks: 0, show: false });
});

test('收回判定：离开窗口才收回；悬停/拖拽期间不收回（AC-04）', () => {
  const winBounds = { x: 640, y: 0, width: 640, height: 210 };
  assert.equal(geo.shouldAutoHide({ x: 700, y: 100 }, winBounds, false, false), false);
  assert.equal(geo.shouldAutoHide({ x: 300, y: 100 }, winBounds, false, false), true);
  assert.equal(geo.shouldAutoHide({ x: 700, y: 260 }, winBounds, false, false), true);
  assert.equal(geo.shouldAutoHide({ x: 300, y: 100 }, winBounds, true, false), false, '鼠标悬停在内容上不收回');
  assert.equal(geo.shouldAutoHide({ x: 300, y: 100 }, winBounds, false, true), false, '拖拽进行中不收回');
});
