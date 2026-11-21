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
  limitNote: $('#limit-note'),
  limitOpts: Array.from(document.querySelectorAll('.limit-opt')),
  posOpts: Array.from(document.querySelectorAll('.pos-opt')),
  posNote: $('#pos-note'),
  themeLight: $('#btn-theme-light'),
  themeDark: $('#btn-theme-dark'),
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

/* ---------------- 主题 ---------------- */

/* 三个动作合成一处：改 <html data-theme>（CSS 立刻生效）+ 同步分段按钮态。
   主窗口由主进程的 state 推送走同一套 ropeTheme.apply，所以两边永远一致。 */
function applyTheme(theme) {
  const t = window.ropeTheme.apply(theme);
  els.themeLight.classList.toggle('on', t === 'light');
  els.themeDark.classList.toggle('on', t === 'dark');
  els.themeLight.setAttribute('aria-pressed', String(t === 'light'));
  els.themeDark.setAttribute('aria-pressed', String(t === 'dark'));
  return t;
}

async function chooseTheme(theme) {
  applyTheme(theme); // 先本地预览，不等 IPC 往返
  const s = await rope.setTheme(theme);
  applyTheme(s.theme); // 以主进程校验后的真实值为准
  status(s.theme === 'dark' ? '已切换到深色主题' : '已切换到浅色主题');
  refresh();
}

els.themeLight.addEventListener('click', () => chooseTheme('light'));
els.themeDark.addEventListener('click', () => chooseTheme('dark'));

/* ---------------- 件数上限（v1.12） ---------------- */

/* 与主进程 store.ITEM_LIMITS 保持一致；非法值一律回落到默认 300。
   之所以把 300 也放进档位里：否则用户改过一次后就再也选不回默认值。 */
const ITEM_LIMITS = [200, 300, 350, 400, 450, 500];
const DEFAULT_ITEM_LIMIT = 300;

function applyItemLimit(n) {
  const v = ITEM_LIMITS.includes(n) ? n : DEFAULT_ITEM_LIMIT;
  for (const b of els.limitOpts) {
    const on = Number(b.dataset.limitValue) === v;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  return v;
}

async function chooseItemLimit(n) {
  applyItemLimit(n); // 先本地预览，不等 IPC 往返
  const s = await rope.setItemLimit(n);
  const real = applyItemLimit(s.itemLimit); // 以主进程校验后的真实值为准
  status(`件数上限已设为 ${real} 件`);
  refresh();
}

for (const b of els.limitOpts) {
  b.addEventListener('click', () => chooseItemLimit(Number(b.dataset.limitValue)));
}

/* ---------------- 停靠位置（v1.14） ---------------- */

/* 与主进程 geo.POSITIONS 对应；非法值回落 top。 */
const POS_LABELS = { top: '顶部', left: '左侧', right: '右侧', bottom: '底部' };

function applyRopePosition(pos) {
  const v = POS_LABELS[pos] ? pos : 'top';
  for (const b of els.posOpts) {
    const on = b.dataset.posValue === v;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  return v;
}

async function chooseRopePosition(pos) {
  applyRopePosition(pos); // 先本地预览，不等 IPC 往返
  const s = await rope.setSettings({ ropePosition: pos });
  const real = applyRopePosition(s.ropePosition); // 以主进程校验后的真实值为准
  status(`绳子已停靠到屏幕${POS_LABELS[real]}`);
  refresh();
}

for (const b of els.posOpts) {
  b.addEventListener('click', () => chooseRopePosition(b.dataset.posValue));
}

/* ---------------- 视图刷新 ---------------- */

let info = null;

async function refresh() {
  info = await rope.settingsInfo();
  const s = info.settings || {};
  applyTheme(s.theme);
  const lim = applyItemLimit(s.itemLimit);
  applyRopePosition(s.ropePosition);

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

  const count = info.itemCount;
  els.itemCount.textContent = `当前 ${count} 件 / 上限 ${lim} 件`;
  const over = count > lim;
  els.limitNote.textContent = over
    ? `当前超出上限 ${count - lim} 件，请先取下或调高档位（已有挂件不会被删除）`
    : count === lim
    ? '已达上限，新挂件暂不添加，可在右侧调高档位'
    : `最多挂 ${lim} 件，已满时不再添加新挂件`;
  els.limitNote.classList.toggle('warn', over);
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
