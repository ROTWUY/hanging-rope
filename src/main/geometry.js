/**
 * 悬挂绳 —— 窗口几何与触顶判定（纯函数，便于单元测试）
 * 主进程的 createWindow / startEdgeWatcher 都走这里，避免判定逻辑散落在副作用代码里。
 */

const WIDTH_DIVISOR = 3; // 绳索宽度 = 主屏宽度 / 3
const EDGE_HOLD_TICKS = 2; // 触顶需连续命中的轮询次数（60ms × 2 ≈ 120ms，防掠过误触）

/**
 * 计算悬浮窗的位置与尺寸。
 * @param {{x:number,y:number,width:number,height:number}} displayBounds 主显示器工作区
 * @param {number} height 窗口高度
 */
function computeWindowBounds(displayBounds, height) {
  const width = Math.round(displayBounds.width / WIDTH_DIVISOR);
  const x = displayBounds.x + Math.round((displayBounds.width - width) / 2);
  return { x, y: displayBounds.y - height, width, height };
}

/**
 * 指针是否命中"顶部唤出热区"：横向必须落在绳索宽度内，纵向贴住屏幕顶端。
 * @param {{x:number,y:number}} point 指针屏幕坐标
 * @param {{x:number,y:number,width:number,height:number}} displayBounds 主显示器
 * @param {number} winX 窗口左边界
 * @param {number} winW 窗口宽度
 * @param {number} [tolerance] 触顶容差（像素）
 */
function isTopEdgeHit(point, displayBounds, winX, winW, tolerance = 2) {
  const inX = point.x >= winX && point.x < winX + winW;
  const atTop = point.y <= displayBounds.y + tolerance;
  return inX && atTop;
}

/**
 * 触顶停留计数：命中则累加，未命中清零。达到要求次数才唤出。
 * @returns {{ticks:number, show:boolean}}
 */
function nextEdgeTicks(ticks, hit, required = EDGE_HOLD_TICKS) {
  const next = hit ? ticks + 1 : 0;
  return { ticks: next, show: next >= required };
}

/**
 * 可见状态下，指针是否已经离开窗口（该收回）。
 * 拖拽中或悬停在内容上时不收回。
 */
function shouldAutoHide(point, winBounds, hovering, busyDrag) {
  if (hovering || busyDrag) return false;
  const inside =
    point.x >= winBounds.x &&
    point.x < winBounds.x + winBounds.width &&
    point.y >= winBounds.y &&
    point.y < winBounds.y + winBounds.height;
  return !inside;
}

module.exports = {
  WIDTH_DIVISOR,
  EDGE_HOLD_TICKS,
  computeWindowBounds,
  isTopEdgeHit,
  nextEdgeTicks,
  shouldAutoHide,
};
