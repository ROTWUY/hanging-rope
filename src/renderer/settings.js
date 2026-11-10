/**
 * 悬挂绳 —— 设置窗口渲染层
 *
 * 这个页面跑在独立的普通 BrowserWindow 里（见 main.js#openSettingsWindow），
 * 数据全部走 preload 暴露的 rope.* 接口；主进程有变化时通过
 * settings:changed 主动推送，这里只负责刷新视图。
 */
'use strict';

const $ = (sel) => document.querySelector(sel);
// 注意：preload 已经通过 contextBridge 在 window 上定义了 rope，
// 这里不能再写 const rope = ...（会和全局绑定重名，整段脚本直接语法报错）。

const els = {
  cacheDir: $('#cache-dir'),
  limit: $('#limit-input'),
  usage: $('#cache-usage'),
  usageBar: $('#usage-bar'),
  hotkey: $('#hotkey-label'),
  copyState: $('#copy-state'),
  itemCount: $('#item-count'),
  status: $('#status'),
};

/* ---------------- 工具 ---------------- */

function fmtSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

let statusTimer = null;
function status(text, warn) {
  els.status.textContent = text;
  els.status.className = 'status' + (warn ? ' warn' : '');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    els.status.textContent = '';
    els.status.className = 'status';
  }, 3600);
}

/* ---------------- 视图刷新 ---------------- */

let info = null;

async function refresh() {
  info = await rope.settingsInfo();
  const s = info.settings || {};

  els.cacheDir.textContent = s.resolvedCacheDir || '（默认目录）';
  els.cacheDir.title = s.resolvedCacheDir || '';

  // 正在输入数字时不要把光标里的值覆盖掉
  if (document.activeElement !== els.limit) els.limit.value = s.cacheLimitMB || 200;

  const limitBytes = Math.max(1, info.usage.limitMB) * 1024 * 1024;
  els.usage.textContent = `${fmtSize(info.usage.bytes)} / ${info.usage.limitMB} MB`;
  const pct = Math.min(100, (info.usage.bytes / limitBytes) * 100);
  els.usageBar.style.width = pct.toFixed(1) + '%';
  els.usageBar.classList.toggle('warn', pct >= 90);

  const hk = (s.hotkey || 'CommandOrControl+Alt+H').replace('CommandOrControl', 'Ctrl').replace('Control', 'Ctrl');
  els.hotkey.textContent = hk;

  els.copyState.textContent = info.copyMode ? '已开启' : '已关闭';
  els.copyState.classList.toggle('on', !!info.copyMode);

  els.itemCount.textContent = `当前 ${info.itemCount} 件`;
  return info;
}

/* ---------------- 交互 ---------------- */

$('#btn-choose-dir').addEventListener('click', async () => {
  const res = await rope.chooseCacheDir();
  if (res) status(`已迁移 ${res.moved} 张缓存图片`);
  else status('已取消');
  refresh();
});

$('#btn-save-limit').addEventListener('click', async () => {
  const v = parseInt(els.limit.value, 10);
  if (!Number.isFinite(v)) {
    status('请输入 10 ~ 4096 之间的数字', true);
    return;
  }
  const s = await rope.setSettings({ cacheLimitMB: v });
  els.limit.value = s.cacheLimitMB;
  status(`缓存上限已设为 ${s.cacheLimitMB} MB`);
  refresh();
});

els.limit.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btn-save-limit').click();
});

$('#btn-prune').addEventListener('click', async () => {
  const n = await rope.pruneCache();
  status(n ? `已清理 ${n} 个未引用文件` : '没有可清理的文件');
  refresh();
});

$('#btn-clear-cache').addEventListener('click', async () => {
  const n = await rope.clearCache();
  status(`已清空 ${n} 个缓存文件（图片挂件会显示失效）`, true);
  refresh();
});

$('#btn-toggle-copy').addEventListener('click', () => rope.toggleCopyMode());

$('#btn-clear-all').addEventListener('click', async () => {
  await rope.clearAllItems();
  status('已清空全部挂件');
  refresh();
});

$('#btn-quit').addEventListener('click', () => rope.quit());
$('#btn-close').addEventListener('click', () => window.close());

/* Esc 也能关（普通窗口的常规习惯），但不会误触：只在没有输入焦点时生效 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.activeElement === els.limit) {
    els.limit.blur();
    return;
  }
  window.close();
});

/* 主进程在挂件/缓存/设置变化后推送，保持与绳索同步 */
rope.onSettingsChanged(() => refresh());

refresh();
