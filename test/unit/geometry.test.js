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

/* ---------------- v1.14：四向停靠 ---------------- */

const WA = { x: 0, y: 0, width: 1920, height: 1040 }; // 工作区（底部 40px 任务栏）
const TH = 210;

test('normalizePosition：只认 4 个方位，非法值回落 top', () => {
  assert.equal(geo.normalizePosition('top'), 'top');
  assert.equal(geo.normalizePosition('left'), 'left');
  assert.equal(geo.normalizePosition('right'), 'right');
  assert.equal(geo.normalizePosition('bottom'), 'bottom');
  assert.equal(geo.normalizePosition('TOP'), 'top');
  assert.equal(geo.normalizePosition(''), 'top');
  assert.equal(geo.normalizePosition(undefined), 'top');
  assert.equal(geo.normalizePosition(42), 'top');
});

test('顶部停靠：与旧接口结果一致（宽度 ÷3 居中、贴屏顶、隐藏在屏外上方）', () => {
  const g = geo.computeRopeBounds(FS, WA, TH, 'top');
  assert.equal(g.shown.width, 640);
  assert.equal(g.shown.x, 640);
  assert.equal(g.shown.y, 0);
  assert.equal(g.shown.height, TH);
  assert.equal(g.hidden.y, -TH);
  const legacy = geo.computeWindowBounds(FS, TH);
  assert.deepEqual(g.shown, { x: legacy.x, y: 0, width: legacy.width, height: TH });
});

test('底部停靠：贴工作区底边（避开任务栏），隐藏在屏幕外下方', () => {
  const g = geo.computeRopeBounds(FS, WA, TH, 'bottom');
  assert.equal(g.shown.width, Math.round(WA.width / 3));
  assert.equal(g.shown.y, WA.y + WA.height - TH, 'y = 工作区底 - 厚度');
  assert.equal(g.shown.y + TH, 1040, '底边对齐工作区底（任务栏上方）');
  assert.equal(g.hidden.y, FS.height, '隐藏位置在整屏之外');
  // 水平居中于工作区
  assert.ok(Math.abs(g.shown.x + g.shown.width / 2 - WA.width / 2) <= 1);
});

test('左侧停靠：竖条贴左缘，长度 = 工作区高 ÷2.5 垂直居中，隐藏在屏外左侧', () => {
  const g = geo.computeRopeBounds(FS, WA, TH, 'left');
  const len = Math.max(168, Math.round(WA.height / 2.5));
  assert.equal(g.shown.width, TH);
  assert.equal(g.shown.height, len);
  assert.equal(g.shown.x, 0);
  assert.ok(Math.abs(g.shown.y + len / 2 - WA.height / 2) <= 1, '垂直居中于工作区');
  assert.equal(g.hidden.x, -TH);
});

test('右侧停靠：竖条贴工作区右缘，隐藏在屏外右侧', () => {
  const g = geo.computeRopeBounds(FS, WA, TH, 'right');
  const len = Math.max(168, Math.round(WA.height / 2.5));
  assert.equal(g.shown.width, TH);
  assert.equal(g.shown.x, WA.width - TH, 'x = 工作区右 - 厚度');
  assert.equal(g.shown.height, len);
  assert.equal(g.hidden.x, FS.width);
});

test('左右竖条长度 = 工作区高 ÷2.5；矮屏时保底 168px', () => {
  const tall = geo.computeRopeBounds(FS, { x: 0, y: 0, width: 1920, height: 1080 }, TH, 'left');
  assert.equal(tall.shown.height, Math.round(1080 / 2.5), '1080 工作区 → 432');

  const short = geo.computeRopeBounds(FS, { x: 0, y: 0, width: 1366, height: 400 }, TH, 'right');
  assert.equal(short.shown.height, 168, '400 ÷2.5 = 160 → 保底 168');
});

test('非法停靠值归一为 top，不抛错', () => {
  const g = geo.computeRopeBounds(FS, WA, TH, 'diagonal');
  assert.equal(g.shown.y, 0);
  assert.equal(g.shown.width, Math.round(FS.width / 3));
});

test('厚度变化（文件夹面板展开 410）四向都只影响厚度方向', () => {
  for (const pos of ['top', 'bottom', 'left', 'right']) {
    const a = geo.computeRopeBounds(FS, WA, TH, pos);
    const b = geo.computeRopeBounds(FS, WA, 410, pos);
    if (pos === 'top' || pos === 'bottom') {
      assert.equal(b.shown.width, a.shown.width, pos + ' 宽度不变');
      assert.equal(b.shown.height, 410, pos + ' 高度变厚');
    } else {
      assert.equal(b.shown.height, a.shown.height, pos + ' 高度不变');
      assert.equal(b.shown.width, 410, pos + ' 宽度变厚');
    }
    // 贴的那条边不动
    if (pos === 'bottom') assert.equal(b.shown.y + 410, WA.height);
    if (pos === 'right') assert.equal(b.shown.x + 410, WA.width);
  }
});

test('isEdgeHit 四向热区：只认停靠边 + 绳长范围', () => {
  const g = geo.computeRopeBounds(FS, WA, TH, 'bottom');
  const bs = g.shown;
  // 命中：工作区底边、绳宽范围内
  assert.equal(geo.isEdgeHit({ x: bs.x + 5, y: WA.height - 1 }, FS, WA, bs, 'bottom'), true);
  // 任务栏里不算（y 超过工作区底）
  assert.equal(geo.isEdgeHit({ x: bs.x + 5, y: WA.height + 20 }, FS, WA, bs, 'bottom'), false);
  // 绳宽范围外不算
  assert.equal(geo.isEdgeHit({ x: bs.x - 5, y: WA.height - 1 }, FS, WA, bs, 'bottom'), false);

  const gl = geo.computeRopeBounds(FS, WA, TH, 'left');
  const ls = gl.shown;
  assert.equal(geo.isEdgeHit({ x: 0, y: ls.y + 10 }, FS, WA, ls, 'left'), true);
  assert.equal(geo.isEdgeHit({ x: 0, y: ls.y - 10 }, FS, WA, ls, 'left'), false, '绳长范围外');
  assert.equal(geo.isEdgeHit({ x: 30, y: ls.y + 10 }, FS, WA, ls, 'left'), false, '离左缘太远');

  const gr = geo.computeRopeBounds(FS, WA, TH, 'right');
  const rs = gr.shown;
  assert.equal(geo.isEdgeHit({ x: WA.width - 1, y: rs.y + 10 }, FS, WA, rs, 'right'), true);
  assert.equal(geo.isEdgeHit({ x: WA.width - 30, y: rs.y + 10 }, FS, WA, rs, 'right'), false);

  // 顶部沿用旧手感：整屏顶边
  const gt = geo.computeRopeBounds(FS, WA, TH, 'top');
  assert.equal(geo.isEdgeHit({ x: gt.shown.x + 5, y: 0 }, FS, WA, gt.shown, 'top'), true);
  assert.equal(geo.isEdgeHit({ x: gt.shown.x - 5, y: 0 }, FS, WA, gt.shown, 'top'), false);
});

/* ---------------- v1.20d：显式唤出后的收回判定（autoHideTick） ---------------- */

const WB = { x: 640, y: 0, width: 640, height: 210 }; // 顶部停靠的 shown 窗口
const INSIDE = { x: 800, y: 60 };
const OUTSIDE = { x: 100, y: 900 }; // 托盘方向（左下角），远在窗口外

test('autoHideTick：非显式唤出保持原节奏——离开累计 3 拍即收回', () => {
  const r1 = geo.autoHideTick(OUTSIDE, WB, false, false, false, 0, 3);
  assert.equal(r1.hide, false, '第 1 拍宽限');
  const r2 = geo.autoHideTick(OUTSIDE, WB, false, false, r1.summonPending, r1.outsideTicks, 3);
  const r3 = geo.autoHideTick(OUTSIDE, WB, false, false, r2.summonPending, r2.outsideTicks, 3);
  assert.equal(r3.hide, true, '第 3 拍收回');
  // 悬停 / 拖拽中不收回
  assert.equal(geo.autoHideTick(OUTSIDE, WB, true, false, false, 2, 3).hide, false);
  assert.equal(geo.autoHideTick(OUTSIDE, WB, false, true, false, 2, 3).hide, false);
  // 回到窗口内清零
  const back = geo.autoHideTick(INSIDE, WB, false, false, false, 2, 3);
  assert.equal(back.outsideTicks, 0);
  assert.equal(back.hide, false);
});

test('autoHideTick：显式唤出后指针没来过，多少拍都不收回', () => {
  let s = { summonPending: true, outsideTicks: 0, hide: false };
  for (let i = 0; i < 50; i++) {
    s = geo.autoHideTick(OUTSIDE, WB, false, false, s.summonPending, s.outsideTicks, 3);
    assert.equal(s.hide, false, '第 ' + (i + 1) + ' 拍也不该收回');
    assert.equal(s.summonPending, true, 'pending 保持等待');
  }
});

test('autoHideTick：显式唤出后指针来过一次，离开再走常规宽限收回', () => {
  // 指针进入窗口：清除 pending
  const enter = geo.autoHideTick(INSIDE, WB, false, false, true, 0, 3);
  assert.equal(enter.summonPending, false);
  assert.equal(enter.hide, false);
  // 离开后照常 3 拍收回
  const o1 = geo.autoHideTick(OUTSIDE, WB, false, false, enter.summonPending, enter.outsideTicks, 3);
  const o2 = geo.autoHideTick(OUTSIDE, WB, false, false, o1.summonPending, o1.outsideTicks, 3);
  const o3 = geo.autoHideTick(OUTSIDE, WB, false, false, o2.summonPending, o2.outsideTicks, 3);
  assert.equal(o3.hide, true);
});

test('autoHideTick：显式唤出且指针一开始就在窗口内，立即清除 pending', () => {
  const r = geo.autoHideTick(INSIDE, WB, false, false, true, 0, 3);
  assert.equal(r.summonPending, false);
  assert.equal(r.hide, false);
});
