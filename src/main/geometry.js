/**
 * 悬挂绳 —— 窗口几何与触边判定（纯函数，便于单元测试）
 * 主进程的 createWindow / startEdgeWatcher 都走这里，避免判定逻辑散落在副作用代码里。
 * v1.14：支持四向停靠（top/left/right/bottom）。
 */

const WIDTH_DIVISOR = 3; // 绳索宽度 = 主屏宽度 / 3
const LENGTH_DIVISOR = 3; // 横条长度 = 停靠边宽度 / 3（顶部取屏宽、底部取工作区宽）
const SIDE_LENGTH_DIVISOR = 2.5; // 竖条长度 = 工作区高度 / 2.5（v1.18：左右停靠占屏高约 40%）
const SIDE_MIN_LENGTH = 168; // 竖条下限：矮屏（工作区 < 420px）时保住纵向图标栏与至少一张挂件
const EDGE_HOLD_TICKS = 2; // 触边需连续命中的轮询次数（60ms × 2 ≈ 120ms，防掠过误触）

const POSITIONS = Object.freeze(['top', 'left', 'right', 'bottom']);

/** 停靠边归一：非法值一律回顶部（默认） */
function normalizePosition(v) {
  return POSITIONS.includes(v) ? v : 'top';
}

/**
 * 按停靠边计算绳索窗口「可见 / 隐藏」两套 bounds。
 * · 顶部：沿用旧行为 —— 横条按整屏宽度 ÷3 居中，贴屏幕最顶端（不受任务栏影响）；
 * · 底部：横条按工作区宽度 ÷3 居中，贴工作区底边（自动避开任务栏）；
 * · 左/右：竖条厚度 = thickness，长度 = 工作区高度 ÷2.5 垂直居中，贴工作区侧边。
 * 隐藏位置统一挪出屏幕外（用整屏 bounds，保证连任务栏区域也不挡鼠标）。
 *
 * @param {{x:number,y:number,width:number,height:number}} displayBounds 主屏完整 bounds
 * @param {{x:number,y:number,width:number,height:number}} workArea 主屏工作区
 * @param {number} thickness 窗口厚度（顶部/底部 = 高度，左右 = 宽度）
 * @param {string} pos 停靠边（top/left/right/bottom）
 * @returns {{shown:{x,y,width,height}, hidden:{x,y,width,height}}}
 */
function computeRopeBounds(displayBounds, workArea, thickness, pos) {
  const p = normalizePosition(pos);

  if (p === 'top') {
    const width = Math.round(displayBounds.width / WIDTH_DIVISOR);
    const x = displayBounds.x + Math.round((displayBounds.width - width) / 2);
    return {
      shown: { x, y: displayBounds.y, width, height: thickness },
      hidden: { x, y: displayBounds.y - thickness, width, height: thickness },
    };
  }

  if (p === 'bottom') {
    const width = Math.round(workArea.width / LENGTH_DIVISOR);
    const x = workArea.x + Math.round((workArea.width - width) / 2);
    return {
      shown: { x, y: workArea.y + workArea.height - thickness, width, height: thickness },
      hidden: { x, y: displayBounds.y + displayBounds.height, width, height: thickness },
    };
  }

  const height = Math.max(SIDE_MIN_LENGTH, Math.round(workArea.height / SIDE_LENGTH_DIVISOR));
  const y = workArea.y + Math.round((workArea.height - height) / 2);
  if (p === 'left') {
    return {
      shown: { x: workArea.x, y, width: thickness, height },
      hidden: { x: displayBounds.x - thickness, y, width: thickness, height },
    };
  }
  // right
  return {
    shown: { x: workArea.x + workArea.width - thickness, y, width: thickness, height },
    hidden: { x: displayBounds.x + displayBounds.width, y, width: thickness, height },
  };
}

/**
 * 计算悬浮窗的位置与尺寸（v1.13 及以前的旧接口，仅顶部停靠）。
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
 * 指针是否命中当前停靠边的唤出热区（v1.14 四向版）。
 * 热区长度 = 绳索长度（指针要落在绳的投影范围内），宽度 = 贴边 tolerance 像素。
 * 顶部用整屏 bounds（沿用旧手感），底/左/右用工作区（任务栏一侧以工作区边缘为准）。
 *
 * @param {{x:number,y:number}} point 指针屏幕坐标
 * @param {{x,y,width,height}} displayBounds 主屏完整 bounds
 * @param {{x,y,width,height}} workArea 主屏工作区
 * @param {{x,y,width,height}} bounds 绳索窗口「可见」bounds（限定热区长度）
 * @param {string} pos 停靠边
 * @param {number} [tolerance] 贴边容差（像素）
 */
function isEdgeHit(point, displayBounds, workArea, bounds, pos, tolerance = 2) {
  const p = normalizePosition(pos);
  if (p === 'top') {
    return (
      point.x >= bounds.x &&
      point.x < bounds.x + bounds.width &&
      point.y <= displayBounds.y + tolerance
    );
  }
  if (p === 'bottom') {
    const bottom = workArea.y + workArea.height;
    return (
      point.x >= bounds.x &&
      point.x < bounds.x + bounds.width &&
      point.y >= bottom - 1 - tolerance &&
      point.y <= bottom + tolerance // 只认贴边窄带，深入任务栏不算
    );
  }
  if (p === 'left') {
    return (
      point.y >= bounds.y &&
      point.y < bounds.y + bounds.height &&
      point.x <= workArea.x + tolerance &&
      point.x >= workArea.x - tolerance
    );
  }
  const right = workArea.x + workArea.width;
  return (
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height &&
    point.x >= right - 1 - tolerance &&
    point.x <= right + tolerance
  );
}

/**
 * 触边停留计数：命中则累加，未命中清零。达到要求次数才唤出。
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
  LENGTH_DIVISOR,
  SIDE_LENGTH_DIVISOR,
  EDGE_HOLD_TICKS,
  POSITIONS,
  normalizePosition,
  computeRopeBounds,
  computeWindowBounds,
  isTopEdgeHit,
  isEdgeHit,
  nextEdgeTicks,
  shouldAutoHide,
};
