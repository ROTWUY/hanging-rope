/**
 * 悬挂绳 —— 启动引导脚本（主题 + 停靠位置）
 *
 * 被主窗口与设置窗口在 <head> 里同步引入，位置在样式表之后、页面内容之前：
 *  · 初始主题 / 停靠位置由主进程 loadFile(..., { query: { theme, pos } }) 带在 URL 上，
 *    这里在 CSS 还没画出任何东西之前就写好 <html data-theme data-pos>，
 *    深色启动不会先闪白，非顶部停靠也不会先闪一帧横向布局；
 *  · 运行时切换由 app.js / settings.js 调 ropeTheme.apply() / 直接设 data-pos，
 *    两个窗口各自从主进程的状态推送里拿到同一个值，保持一致。
 *
 * 这个文件不碰 DOM 之外的东西，也不依赖 preload，纯前端。
 */
(function () {
  'use strict';

  function normalize(theme) {
    return theme === 'dark' ? 'dark' : 'light';
  }

  function apply(theme) {
    var t = normalize(theme);
    var root = document.documentElement;
    if (root) root.setAttribute('data-theme', t);
    return t;
  }

  var POSITIONS = ['top', 'left', 'right', 'bottom'];

  function normalizePos(pos) {
    return POSITIONS.indexOf(pos) >= 0 ? pos : 'top';
  }

  function applyPos(pos) {
    var p = normalizePos(pos);
    var root = document.documentElement;
    if (root) root.setAttribute('data-pos', p);
    return p;
  }

  window.ropeTheme = { normalize: normalize, apply: apply, normalizePos: normalizePos, applyPos: applyPos };

  try {
    var q = new URLSearchParams(window.location.search);
    apply(q.get('theme'));
    applyPos(q.get('pos'));
  } catch {
    apply('light');
    applyPos('top');
  }
})();
