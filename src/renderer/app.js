/**
 * 悬挂绳 —— 渲染层
 * 拖入悬挂、拖出插入、文件夹滚轮翻看、长按排序、Esc 取件。
 * （设置是独立窗口，见 settings.js，不在绳索条内渲染。）
 */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);

const els = {
  shell: $('#shell'),
  track: $('#track'),
  emptyHint: $('#empty-hint'),
  copyPill: $('#copy-pill'),
  removeHint: $('#remove-hint'),
  folderPanel: $('#folder-panel'),
  dropVeil: $('#drop-veil'),
  toast: $('#toast'),
};

let S = { items: [], settings: {}, copyMode: false };

const ui = {
  removeMode: false,
  press: null, // { item, el, pointerId, x0, y0, lifted, timer } 按住中（文件/文件夹/图片）
  reorder: null, // 抬起后的排序手势（与 press 同一对象）
  textDrag: null, // { el, reordered } 文字挂件的 HTML5 拖拽会话
  nativeDrag: false, // 自己发起的原生拖拽（拖出）进行中
  nativeDragTimer: null,
  suppressClickUntil: 0, // 手势刚结束的短暂窗口，不把余下的 click 当成"单击复制"
  lastDragPath: '',
  lastDragAt: 0,
  folder: null, // { id, entries, index, error }
  folderCloseTimer: null,
  folderHoverTimer: null,
};

/* ---------------- 工具 ---------------- */

function findItem(id) {
  return S.items.find((i) => i.id === id) || null;
}

function fileUrl(p) {
  return encodeURI('file:///' + String(p).replace(/\\/g, '/')).replace(/#/g, '%23');
}

function extOf(name) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name || '');
  return m ? m[1].toUpperCase() : '';
}

function textName(text) {
  const first = (text || '').trim().split(/\r?\n/)[0] || '文字';
  return first.length > 40 ? first.slice(0, 40) + '…' : first;
}

/* 图片扩展名：这类"文件"挂件直接渲染原图预览 */
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;

/* 路径比较键（与主进程 src/main/paths.js 同一套规则）：
   Windows 不区分大小写、斜杠方向无关、末尾分隔符可有可无。
   用来判断"这一行的是不是已经挂在绳上了"。 */
function pathKey(p) {
  if (!p || typeof p !== 'string') return '';
  let s = p.trim().replace(/\\/g, '/').toLowerCase();
  if (!s) return '';
  s = s.replace(/\/+$/, '');
  if (/^[a-z]:$/.test(s)) return s + '/';
  return s || '/';
}

function isPinnedPath(p) {
  const k = pathKey(p);
  if (!k) return false;
  return S.items.some(
    (it) => (it.type === 'folder' || it.type === 'file') && pathKey(it.path) === k
  );
}

/* 📌 的"已固定"态以绳上实际状态为准：除了点按钮时更新，
   每次状态推送也同步一遍 —— 从别处（Esc 取件、拖入、清空）拿下挂件后，
   已展开的面板里的金色态必须跟着熄灭，否则按钮会骗人（AC-49）。 */
function applyPinVisual(pin, on) {
  pin.classList.toggle('on', on);
  const title = on ? '取消固定（已在绳上）' : '固定到绳上';
  pin.title = title;
  pin.setAttribute('aria-label', title);
}

function syncPinButton(pin, p) {
  applyPinVisual(pin, isPinnedPath(p));
}

function syncPinButtons() {
  if (!ui.folder) return;
  for (const pin of els.folderPanel.querySelectorAll('.fp-pin')) {
    syncPinButton(pin, pin.dataset.path || '');
  }
}

/* 缓存自动生成的文件名（img_<时间戳>_<sha1>.ext）不是给人看的：
   早先版本直接把缓存名当挂件名，卡片上就是一串哈希。这类名字改成"图片 · SVG"。 */
const AUTO_IMAGE_NAME = /^img_[a-z0-9]+_[0-9a-f]{8,}\./i;

function itemLabel(item) {
  const n = item.name || '';
  if (item.type === 'image' && AUTO_IMAGE_NAME.test(n)) {
    // 真实格式看缓存文件，别用上游谎报的扩展名
    const ext = extOf(item.cachePath || n);
    return ext ? '图片 · ' + ext : '图片';
  }
  return n;
}

function isImageFile(item) {
  return item.type === 'file' && !item.invalid && IMG_EXT_RE.test(item.name || '');
}

let toastTimer = null;
function toast(text, warn) {
  els.toast.textContent = text;
  els.toast.classList.toggle('warn', !!warn);
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2600);
}

/* ---------------- 单击复制 / 双击打开（v1.5） ----------------
   绳上挂件与文件夹浏览面板里的行共用这一套：单击 = 复制到系统剪贴板，
   双击 = 用系统默认程序打开对象本体。按住拖动 / 排序 / 拖出 / 取件模式
   全部优先，绝不把一次手势误判成"单击复制"。 */

function markClickBlocked(ms) {
  ui.suppressClickUntil = Math.max(ui.suppressClickUntil, Date.now() + ms);
}

function clickBlocked() {
  return (
    ui.removeMode ||
    ui.nativeDrag ||
    ui.press ||
    ui.reorder ||
    ui.textDrag ||
    Date.now() < ui.suppressClickUntil
  );
}

function targetOfItem(item) {
  return {
    type: item.type,
    path: item.path || '',
    cachePath: item.cachePath || '',
    text: item.text || '',
    invalid: !!item.invalid,
  };
}

function targetOfRow(entry) {
  return {
    type: entry.isDir ? 'folder' : 'file',
    path: entry.path || '',
    cachePath: '',
    text: '',
    invalid: false,
  };
}

/* 双击 = 两次 click + 一次 dblclick，复制与打开的 IPC 可能乱序返回。
   用序号保证"最后发起的那次操作"说了算，别让先回来的复制提示盖掉打开提示。 */
let actionToastSeq = 0;

async function doCopy(target, label) {
  const seq = ++actionToastSeq;
  try {
    const res = await rope.copyItem(target);
    if (seq !== actionToastSeq) return res;
    if (res && res.ok) toast('已复制：' + label + '，可直接粘贴');
    else toast((res && res.message) || '复制失败', true);
    return res;
  } catch (err) {
    if (seq !== actionToastSeq) return null;
    toast('复制失败：' + err.message, true);
    return null;
  }
}

async function doOpen(target, label) {
  const seq = ++actionToastSeq;
  try {
    const res = await rope.openItem(target);
    if (seq !== actionToastSeq) return res;
    if (res && res.ok) toast('已打开：' + label);
    else if (res && res.fallback === 'copy') {
      toast(res.message || '文字没有可打开的文件', !res.copied);
    } else {
      toast((res && res.message) || '打开失败', true);
    }
    return res;
  } catch (err) {
    if (seq !== actionToastSeq) return null;
    toast('打开失败：' + err.message, true);
    return null;
  }
}

/* ---------------- 渲染 ---------------- */

function render() {
  // 整表重建，但只有“新挂上”的挂件才播入场动画。
  // 给已存在的挂件也带动画的话，任何一次状态推送都会让整条绳闪一下；
  // 而用 animation:none 去压制又会在取消时让动画重播，所以干脆不声明。
  const prevIds = new Set([...els.track.children].map((n) => n.dataset.id));
  els.track.innerHTML = '';
  for (const item of S.items) {
    const el = buildItem(item);
    if (!prevIds.has(item.id)) el.classList.add('anim-in');
    els.track.appendChild(el);
  }
  els.emptyHint.hidden = S.items.length > 0;
  els.copyPill.classList.toggle('on', !!S.copyMode);
  // 挂件被清掉后，浏览面板随之关闭
  if (ui.folder && !findItem(ui.folder.id)) closeFolder(true);
}

function buildItem(item) {
  const el = document.createElement('div');
  // 图片类（网页/剪贴板图片、图片文件）都用大预览卡样式
  el.className =
    'item ' +
    (item.type === 'image' || isImageFile(item) ? 't-image ' : '') +
    't-' +
    item.type +
    (item.invalid ? ' invalid' : '');
  el.dataset.id = item.id;
  // 只有文字走 HTML5 拖拽；文件/文件夹/图片完全用指针手势（见统一手势说明）
  el.draggable = item.type === 'text';

  const clip = document.createElement('div');
  clip.className = 'clip';
  el.appendChild(clip);

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  buildThumb(thumb, item);
  el.appendChild(thumb);

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = item.type === 'text' ? textName(item.text) : itemLabel(item);
  if (item.invalid) name.textContent = (item.name || '') + '（源已丢失）';
  el.appendChild(name);

  wireItem(el, item);
  // 入场动画只播一次：结束后摘掉类，避免后续 DOM 重排时重播
  el.addEventListener('animationend', (e) => {
    if (e.animationName === 'hang-in') el.classList.remove('anim-in');
  });
  return el;
}

function buildThumb(container, item) {
  if (item.type === 'image' && item.cachePath) {
    thumbImg(container, fileUrl(item.cachePath), item);
    return;
  }
  // 桌面/资源管理器拖入的图片文件：直接显示原图预览
  if (isImageFile(item)) {
    thumbImg(container, fileUrl(item.path), item);
    return;
  }
  if (item.type === 'text') {
    const pre = document.createElement('div');
    pre.className = 'text-preview';
    pre.textContent = (item.text || '').trim().slice(0, 160);
    container.appendChild(pre);
    return;
  }
  if (item.type === 'folder') {
    const f = document.createElement('div');
    f.className = 'folder-shape';
    container.appendChild(f);
    return;
  }
  const doc = document.createElement('div');
  doc.className = 'doc-shape';
  doc.textContent = extOf(item.name) || '文件';
  container.appendChild(doc);
}

/* 缩略图加载失败时给一个占位块，而不是让浏览器画出破图标 ——
   缓存被清空、格式不被支持、扩展名异常等情况都走这里。 */
function thumbImg(container, src, item) {
  const img = document.createElement('img');
  img.draggable = false;
  img.alt = '';
  img.addEventListener('error', () => {
    container.innerHTML = '';
    const ph = document.createElement('div');
    ph.className = 'thumb-broken';
    ph.textContent = item && item.invalid ? '源已丢失' : '预览不可用';
    container.appendChild(ph);
  });
  img.src = src;
  container.appendChild(img);
  return img;
}

/* ---------------- 挂件交互（统一手势） ----------------
   一个连续动作，不区分“排序模式 / 拖出模式”：
   · 按下即捕获指针（0.15 秒后卡片“抬起”，无论这期间是否移动）
   · 抬起后横向移动        → 绳上跟手换位（排序），松手落位
   · 抬起后拖出窗口底部/左右 → 无缝转为对外拖出（插入聊天框 / Office）
   注意：抬起前移动不触发任何动作——曾经在这里做过“快速甩出=直接拖出”
   的判定，但正常人按住就拖几乎总在 150ms 内开始移动，结果每次拖动都被
   误判成拖出、反复进出系统原生拖拽，看起来就是闪烁，已删除。
   文字挂件例外：走 HTML5 拖拽（Chromium 会转成系统文本拖放），
   拖动过程中指针在绳内 = 排序，拖出去 = 拖出，天然是同一个手势。 */

const LIFT_MS = 150; // 按住多久后抬起（期间移动也没关系）

function wireItem(el, item) {
  if (item.type === 'text') {
    /* --- 文字：HTML5 拖拽，方向自动决定排序还是拖出 --- */
    el.addEventListener('dragstart', (e) => {
      ui.textDrag = { el, reordered: false };
      rope.busy(true);
      const dt = e.dataTransfer;
      if (dt) {
        // 必须写入内容本身，否则拖到记事本/聊天框会是空的（AC-13）
        dt.effectAllowed = 'copy';
        dt.setData('text/plain', item.text || '');
      }
      try {
        e.dataTransfer.setDragImage(el, 42, 24);
      } catch {
        /* ignore */
      }
    });
    el.addEventListener('drag', (e) => {
      const td = ui.textDrag;
      if (!td || td.el !== el) return;
      if (pointInTrack(e.clientX, e.clientY, 0)) {
        reorderAtPoint(e.clientX, e.clientY, el);
        td.reordered = true;
      }
    });
    el.addEventListener('dragend', () => {
      if (ui.textDrag && ui.textDrag.el === el && ui.textDrag.reordered) {
        commitReorder(); // 在绳内移动过 → 提交排序；拖到外部则本身就是拖出
      }
      ui.textDrag = null;
      markClickBlocked(350); // 拖完可能补一个 click，别当成"单击复制"
      rope.busy(false);
    });
  } else {
    /* --- 文件 / 文件夹 / 图片：纯指针手势 --- */
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || ui.nativeDrag || ui.reorder || ui.press) return;
      const p = {
        item,
        el,
        pointerId: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        lifted: false,
        timer: null,
      };
      // 按下立即捕获指针：即使 150ms 内已经把鼠标甩出窗口，
      // 抬起后也能继续收到轨迹并正确转成拖出
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      ui.press = p;
      clearTimeout(p.timer);
      p.timer = setTimeout(() => {
        if (ui.press !== p) return;
        lift(p);
      }, LIFT_MS);
    });
  }

  /* --- 文件夹：悬停打开浏览面板 + 滚轮翻看（按住/排序手势进行中不触发） --- */
  if (item.type === 'folder') {
    el.addEventListener('mouseenter', () => {
      clearTimeout(ui.folderHoverTimer);
      if (item.invalid || ui.press || ui.reorder) return;
      ui.folderHoverTimer = setTimeout(() => {
        if (!ui.press && !ui.reorder) openFolder(item, el);
      }, 200);
    });
    el.addEventListener('mouseleave', () => {
      clearTimeout(ui.folderHoverTimer);
      scheduleFolderClose();
    });
    el.addEventListener('wheel', (e) => {
      if (item.invalid) return;
      e.preventDefault();
      // 别让事件继续冒泡到 document 的横向滚动逻辑（两件事不能同时发生）
      e.stopPropagation();
      ensureFolderOpen(item, el);
      cycleFolder(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
  }

  /* --- v1.5：单击 = 复制到剪贴板，双击 = 用系统默认程序打开 ---
     双击的第二次 click（detail>=2）跳过，避免连续复制两遍；
     按住拖动 / 排序 / 拖出 / 取件模式由 clickBlocked() 统一挡掉。 */
  el.addEventListener('click', (e) => {
    if (e.detail >= 2 || clickBlocked()) return;
    doCopy(targetOfItem(item), itemLabel(item) || item.type);
  });
  el.addEventListener('dblclick', () => {
    if (clickBlocked()) return;
    doOpen(targetOfItem(item), itemLabel(item) || item.type);
  });

  /* --- 图片挂件本身即预览图，悬停用系统提示补充信息 --- */
  if (item.type === 'image' || isImageFile(item)) {
    const dims = item.width && item.height ? `（${item.width}×${item.height}）` : '';
    el.title = itemLabel(item) + dims;
  }
}

/* 发起对外拖出（系统原生拖放接管） */
function dragOutFromItem(item) {
  if (item.invalid) {
    toast('源已丢失，无法拖出');
    return;
  }
  markClickBlocked(2600); // 原生拖放结束后余下的 click 不能算"单击复制"
  ui.nativeDrag = true;
  ui.lastDragPath = item.path || '';
  ui.lastDragAt = Date.now();
  rope.startDrag(
    item.type === 'image'
      ? { kind: 'image', cachePath: item.cachePath }
      : { kind: item.type, path: item.path }
  );
  // 原生拖拽由主进程维持 busy，这里延迟解除内部标记
  clearTimeout(ui.nativeDragTimer);
  ui.nativeDragTimer = setTimeout(() => {
    ui.nativeDrag = false;
  }, 2500);
}

function pointInTrack(x, y, margin) {
  const r = els.track.getBoundingClientRect();
  return x >= r.left - margin && x <= r.right + margin && y >= r.top - margin && y <= r.bottom + margin;
}

function reorderAtPoint(x, y, dragged) {
  const others = [...els.track.querySelectorAll('.item:not(.lifting)')];
  let insertBefore = null;
  for (const n of others) {
    const r = n.getBoundingClientRect();
    if (x < r.left + r.width / 2) {
      insertBefore = n;
      break;
    }
  }
  // 位置没变就不要再动 DOM：insertBefore 是“移出+插入”，
  // 即便目标位置相同也会让节点重新挂载（动画/悬停状态被打断）。
  if (insertBefore ? insertBefore === dragged.nextElementSibling : !dragged.nextElementSibling) return;
  if (insertBefore) els.track.insertBefore(dragged, insertBefore);
  else els.track.appendChild(dragged);
}

function lift(p) {
  p.lifted = true;
  markClickBlocked(600); // 已"抬起"就属于排序手势，松手后的 click 不复制
  ui.reorder = p;
  p.el.classList.add('lifting');
  document.body.classList.add('reordering');
  rope.busy(true);
}

function commitReorder() {
  document.body.classList.remove('reordering');
  markClickBlocked(600);
  if (ui.reorder) {
    ui.reorder.el.classList.remove('lifting');
    ui.reorder = null;
  }
  rope.busy(false);
  rope.reorder([...els.track.querySelectorAll('.item')].map((n) => n.dataset.id));
}

document.addEventListener('pointermove', (e) => {
  const p = ui.press;
  // 文件夹列表的行：没有排序，按住行拖动 = 拖出（移动超过 8px 即触发）
  if (p && p.rowOnly) {
    if (!p.lifted && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 8) {
      ui.press = null;
      dragOutFromItem(p.item);
    }
    return;
  }
  const r = ui.reorder;
  if (!r || r.item.type === 'text') return;
  // 只有“往下拖出窗口底边”才转成对外拖出。
  // 之前还允许“拖出左右边缘”，但绳索只占屏幕 1/3 宽，排序时手很容易
  // 扫到窗口左右边界，于是被误判成拖出（系统原生拖拽一起一停，看起来就是闪）。
  const belowWindow = e.clientY > window.innerHeight - 6;
  if (belowWindow) {
    // 拖出窗口 → 转为对外拖出
    ui.press = null;
    commitReorder();
    dragOutFromItem(r.item);
    return;
  }
  reorderAtPoint(e.clientX, e.clientY, r.el);
});

document.addEventListener('pointerup', () => {
  const p = ui.press;
  if (!p) return;
  if (p.lifted) commitReorder(); // 在绳内松手 → 落位
  else clearTimeout(p.timer);
  ui.press = null;
});
document.addEventListener('pointercancel', () => {
  const p = ui.press;
  if (!p) return;
  if (p.lifted) commitReorder();
  else clearTimeout(p.timer);
  ui.press = null;
});

/* ---------------- 文件夹浏览面板 ---------------- */

function ensureFolderOpen(item, anchorEl) {
  if (!ui.folder || ui.folder.id !== item.id) openFolder(item, anchorEl);
}

function openFolder(item, anchorEl) {
  ui.folder = { id: item.id, entries: [], index: 0, error: '' };
  rope.setHeight(410);
  positionFolderPanel(anchorEl);
  renderFolderPanel();
  rope.listFolder(item.path).then((res) => {
    if (!ui.folder || ui.folder.id !== item.id) return;
    ui.folder.entries = res.entries || [];
    ui.folder.error = res.ok ? '' : res.error || '读取失败';
    ui.folder.index = Math.min(ui.folder.index, Math.max(0, ui.folder.entries.length - 1));
    // 用户正按住某一行时不要重建 DOM（会打断拖出手势），等松手后下次渲染生效
    if (!ui.press) renderFolderPanel();
  });
}

function positionFolderPanel(anchorEl) {
  const r = anchorEl.getBoundingClientRect();
  const width = 332;
  let left = Math.round(r.left - 60);
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  els.folderPanel.style.left = left + 'px';
}

function cycleFolder(dir) {
  const f = ui.folder;
  if (!f || !f.entries.length) return;
  f.index = (f.index + dir + f.entries.length) % f.entries.length;
  renderFolderPanel();
}

/* 选中某行：只改高亮与计数，不重建 DOM。
   重建会让两次 click 落在不同元素上，dblclick 就不会派发（v1.5 单击/双击同存的前提）。 */
function selectFolderRow(i) {
  const f = ui.folder;
  if (!f || f.index === i) return;
  f.index = i;
  for (const r of els.folderPanel.querySelectorAll('.fp-row')) {
    r.classList.toggle('sel', Number(r.dataset.index) === i);
  }
  const counter = els.folderPanel.querySelector('.fp-counter');
  if (counter) {
    counter.textContent = f.entries.length ? `${i + 1} / ${f.entries.length}` : '0 项';
  }
}

function scheduleFolderClose() {
  clearTimeout(ui.folderCloseTimer);
  ui.folderCloseTimer = setTimeout(closeFolder, 260);
}

function closeFolder(instant) {
  clearTimeout(ui.folderCloseTimer);
  ui.folder = null;
  els.folderPanel.hidden = true;
  rope.setHeight(210);
}

/* 面板：竖排列表，一屏 3 行，滚轮滚动选择，选中行高亮。
   行的拖出与挂件同一套指针手势（按住行拖动 = 拖出插入）。 */
const FP_ROWS = 3;

function renderFolderPanel() {
  const f = ui.folder;
  const panel = els.folderPanel;
  if (!f) return;
  panel.hidden = false;
  panel.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'fp-head';
  const nm = document.createElement('span');
  nm.className = 'fp-name';
  const it = findItem(f.id);
  nm.textContent = it ? it.name : '';
  nm.title = nm.textContent;
  const counter = document.createElement('span');
  counter.className = 'fp-counter';
  counter.textContent = f.entries.length ? `${f.index + 1} / ${f.entries.length}` : '0 项';
  head.appendChild(nm);
  head.appendChild(counter);
  panel.appendChild(head);

  if (f.error) {
    const err = document.createElement('div');
    err.className = 'fp-empty';
    err.textContent = f.error;
    panel.appendChild(err);
    const foot = document.createElement('div');
    foot.className = 'fp-foot';
    foot.innerHTML = '<span>滚轮逐个翻看</span>';
    panel.appendChild(foot);
    return;
  }
  if (!f.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'fp-empty';
    empty.textContent = '空文件夹';
    panel.appendChild(empty);
    const foot = document.createElement('div');
    foot.className = 'fp-foot';
    foot.innerHTML = '<span>滚轮逐个翻看</span>';
    panel.appendChild(foot);
    return;
  }

  const n = f.entries.length;
  // 选中行尽量居中显示
  const start = Math.max(0, Math.min(f.index - 1, n - FP_ROWS));
  const end = Math.min(n, start + FP_ROWS);
  const list = document.createElement('div');
  list.className = 'fp-list';

  for (let i = start; i < end; i++) {
    const entry = f.entries[i];
    const row = document.createElement('div');
    row.className = 'fp-row' + (i === f.index ? ' sel' : '');
    row.dataset.index = String(i);

    const label = document.createElement('div');
    label.className = 'fp-row-name';
    label.textContent = entry.name;
    label.title = entry.name;
    row.appendChild(label);

    const th = document.createElement('div');
    th.className = 'fp-row-thumb';
    if (!entry.isDir && IMG_EXT_RE.test(entry.name)) {
      thumbImg(th, fileUrl(entry.path), null);
    } else {
      const shape = document.createElement('div');
      shape.className = entry.isDir ? 'folder-shape' : 'doc-shape';
      if (!entry.isDir) shape.textContent = extOf(entry.name) || '文件';
      th.appendChild(shape);
    }
    row.appendChild(th);

    /* 右侧 📌：点一下固定到绳上，再点一下取消固定（只引用路径，不复制本体）。
       文件行留同宽占位，保证各行缩略图纵向对齐。 */
    if (entry.isDir) {
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'fp-pin';
      pin.textContent = '📌';
      pin.dataset.path = entry.path; // 状态同步时据此回查绳上状态
      syncPinButton(pin, entry.path);
      // 按下就拦住：不能让行拿到 pointerdown，否则会被当成"按住拖动＝拖出"
      pin.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
      });
      pin.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (f.index !== i) f.index = i;
        if (pin.dataset.busy === '1') return;
        pin.dataset.busy = '1';
        // 点击瞬间决定方向：已固定 → 取消；未固定 → 固定。
        // busy 标志拦住连点，避免一次操作里 both 方向交错。
        const wasPinned = isPinnedPath(entry.path);
        let nextOn = wasPinned;
        try {
          const res = wasPinned
            ? await rope.unpinPath(entry.path)
            : await rope.pinPath(entry.path);
          if (res && res.ok && wasPinned && res.removed) {
            toast('已取消固定：' + (res.name || entry.name));
            nextOn = false;
          } else if (res && res.ok && wasPinned) {
            toast((res && res.message) || '绳上没有这个文件夹', true);
            nextOn = false;
          } else if (res && res.ok && res.already) {
            // 状态推送尚未落地时，主进程兜底告知"已经挂上了"，不重复添加
            toast('这个文件夹已经在绳上了');
            nextOn = true;
          } else if (res && res.ok) {
            toast('已固定：' + (res.name || entry.name));
            nextOn = true;
          } else {
            toast((res && res.message) || (wasPinned ? '取消固定失败' : '固定失败'), true);
          }
          // 按操作结果立刻改视觉，不等状态推送；随后 onState 会以真实状态再校准一次
          applyPinVisual(pin, nextOn);
        } catch (err) {
          toast((wasPinned ? '取消固定失败：' : '固定失败：') + err.message, true);
        } finally {
          delete pin.dataset.busy;
        }
      });
      pin.addEventListener('dblclick', (e) => {
        e.stopPropagation(); // 双击 📌 只做固定/取消固定，不冒泡成"双击打开"
      });
      row.appendChild(pin);
    } else {
      const slot = document.createElement('span');
      slot.className = 'fp-pin-slot';
      row.appendChild(slot);
    }

    // v1.5：单击 = 选中 + 复制到剪贴板，双击 = 打开；按住拖动仍是拖出
    row.addEventListener('click', (e) => {
      selectFolderRow(i);
      if (e.detail >= 2 || clickBlocked()) return;
      doCopy(targetOfRow(entry), entry.name);
    });
    row.addEventListener('dblclick', () => {
      if (clickBlocked()) return;
      doOpen(targetOfRow(entry), entry.name);
    });
    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || ui.nativeDrag || ui.press || ui.reorder) return;
      // 让行内的 pointerdown 优先选中该行（不重建 DOM，避免打断拖出手势）
      selectFolderRow(i);
      const p = {
        item: { type: entry.isDir ? 'folder' : 'file', path: entry.path, name: entry.name },
        el: row,
        pointerId: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        lifted: false, // 行没有“抬起排序”，只做拖出
        timer: null,
        rowOnly: true,
      };
      try {
        row.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      ui.press = p;
    });

    list.appendChild(row);
  }
  panel.appendChild(list);

  const foot = document.createElement('div');
  foot.className = 'fp-foot';
  foot.innerHTML =
    '<span>滚轮切换选择</span><span><span class="key">按住行拖动</span> = 拖出插入</span>';
  panel.appendChild(foot);
}

/* 面板自身也响应滚轮与悬停保持 */
els.folderPanel.addEventListener('wheel', (e) => {
  e.preventDefault();
  e.stopPropagation(); // 面板内滚轮 = 翻列表，不触发绳索的横向滚动
  cycleFolder(e.deltaY > 0 ? 1 : -1);
}, { passive: false });
els.folderPanel.addEventListener('mouseenter', () => clearTimeout(ui.folderCloseTimer));
els.folderPanel.addEventListener('mouseleave', scheduleFolderClose);

/* 挂件超出轨道宽度时，滚轮横向滚动（PRD 2.3 / AC-39）。
   监听挂在 document 上：绳索条的任意背景位置（卡片下方的空白、绳索两侧、
   状态栏）都能滚，而不是只有光标正好压在 #track 上才生效。
   没有溢出就不拦截，避免吞掉正常滚动；面板内的滚轮归面板自己处理。 */
document.addEventListener(
  'wheel',
  (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('#folder-panel')) return;
    const max = els.track.scrollWidth - els.track.clientWidth;
    if (max <= 0) return;
    // 触摸板横行手势优先用 deltaX
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    // deltaMode: 0=像素 1=行 2=页
    const step = e.deltaMode === 1 ? d * 16 : e.deltaMode === 2 ? d * els.track.clientWidth : d;
    e.preventDefault();
    els.track.scrollLeft = Math.max(0, Math.min(max, els.track.scrollLeft + step));
  },
  { passive: false }
);

/* ---------------- 拖入（外部 → 绳） ---------------- */

let dragDepth = 0;

function showVeil() {
  els.dropVeil.hidden = false;
}
function hideVeil() {
  dragDepth = 0;
  els.dropVeil.hidden = true;
}

document.addEventListener('dragenter', (e) => {
  if (ui.nativeDrag || ui.textDrag) return; // 文字挂件在绳内拖动排序时不显示遮罩
  dragDepth++;
  showVeil();
});
document.addEventListener('dragleave', () => {
  if (ui.nativeDrag || ui.textDrag) return;
  dragDepth--;
  if (dragDepth <= 0) hideVeil();
});
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!ui.nativeDrag) e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (ui.nativeDrag) return; // 自己拖出的东西，拖回自己窗口忽略
  if (ui.textDrag) {
    // 自己的文字挂件拖回绳上：只算排序，不重复挂
    if (ui.textDrag.reordered) commitReorder();
    return;
  }
  hideVeil();

  const dt = e.dataTransfer;

  // 1) 文件 / 文件夹
  const files = [...(dt.files || [])];
  if (files.length) {
    const paths = files.map((f) => rope.getPathForFile(f)).filter(Boolean);
    // 刚拖出去的同一个文件被拖回窗口时，不重复挂
    const fresh = paths.filter(
      (p) => !(Date.now() - ui.lastDragAt < 5000 && p === ui.lastDragPath)
    );
    if (fresh.length) {
      rope.addPaths(fresh);
      return;
    }
    // 没有本地路径（例如某些网页拖出的图片）：读取字节缓存。
    // 扩展名不在这里猜，交给主进程按字节判断（网页图片常见 svg/webp/avif）
    for (const f of files) {
      try {
        if (/^image\//.test(f.type) || IMG_EXT_RE.test(f.name || '')) {
          const buf = new Uint8Array(await f.arrayBuffer());
          rope.addImageBuffer(buf, '', { mime: f.type || '', name: f.name || '' });
          return;
        }
      } catch {
        /* ignore */
      }
    }
  }

  // 2) 网页图片（浏览器拖拽通常不给 File，只给 HTML/URI）
  const html = dt.getData('text/html') || '';
  const imgMatch = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(html);
  if (imgMatch) {
    const src = imgMatch[1];
    const alt = (/<img[^>]+alt\s*=\s*["']([^"']*)["']/i.exec(html) || [])[1] || '';
    rope.addImageUrl(src.startsWith('http') || src.startsWith('data:') ? src : '', alt);
    if (!(src.startsWith('http') || src.startsWith('data:'))) {
      toast('这张图片无法直接抓取，试试右键复制图片后拖入');
    }
    return;
  }

  // 3) 纯文字
  const text = (dt.getData('text/plain') || dt.getData('text/uri-list') || '').trim();
  if (text) rope.addText(text);
});

/* ---------------- 取件模式（按住 Esc 点击取下） ---------------- */

function setRemoveMode(on, fromMain = false) {
  if (ui.removeMode === on) return;
  ui.removeMode = on;
  document.body.classList.toggle('remove-mode', on);
  els.removeHint.hidden = !on;
  // 主进程回传的事件只同步 UI，不再回发 IPC：否则"按下→点击→松开"快速连发时
  // 会形成 true→false→true 的回环，取件模式关不掉，后续单击会误触取下。
  if (!fromMain) rope.setRemoveMode(on);
}

/* Esc 手势 = 按住进入、松开退出（点击挂件取下）。
   与主进程全局键二选一处理（谁注册谁处理，绝不两边同时响应——之前闪烁
   就是因为一边开、一边关）。窗口聚焦时这里用真实 keydown/keyup；
   未聚焦时主进程用自动重复保活模拟按住。 */
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.repeat) return;
  if (ui.folder) {
    closeFolder();
    return;
  }
  e.preventDefault();
  setRemoveMode(true);
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'Escape') setRemoveMode(false);
});

document.addEventListener('click', (e) => {
  if (!ui.removeMode) return;
  const itemEl = e.target.closest('.item');
  if (itemEl) {
    rope.removeItem(itemEl.dataset.id);
    toast('已取下');
  }
  // 不在此处退出取件模式：松开 Esc 时自动退出（按住可连续取下多件）
});

/* 主进程的全局 Esc（窗口未聚焦时兜底）也走这里 */
function onRemoveModeEvent(on) {
  setRemoveMode(!!on, true);
}

/* ---------------- 设置 ----------------
   设置是独立的普通窗口（主进程 BrowserWindow#openSettingsWindow），
   所以这里只负责"把窗口叫出来"。以前的内嵌浮层会跟着绳索一起收回，
   鼠标一移开就消失，没法一边看一边改。 */

function openSettings() {
  closeFolder(true);
  rope.openSettings();
}

$('#btn-settings').addEventListener('click', openSettings);
$('#btn-clear').addEventListener('click', () => {
  rope.clearAll();
  toast('已清空全部挂件');
});

/* 复制模式开关（点击胶囊） */
els.copyPill.addEventListener('click', () => rope.toggleCopyMode());

/* ---------------- 主进程事件 ---------------- */

rope.onState((s) => {
  S = s;
  render();
  // 绳上状态变了（别处取下 / 拖入 / 清空），展开的面板里 📌 要跟着变
  syncPinButtons();
});

rope.onEvent((ev) => {
  switch (ev.type) {
    case 'toast':
      toast(ev.text, ev.level === 'warn');
      break;
    case 'remove-mode':
      onRemoveModeEvent(ev.on);
      break;
    case 'copy-mode':
      toast(ev.on ? '复制即悬挂：已开启，复制的内容会自动挂上绳' : '复制即悬挂：已关闭');
      break;
    case 'open-settings':
      rope.openSettings(); // 兼容旧事件：主进程已经开始自己开窗，这里只是兜底
      break;
    case 'hidden':
      setRemoveMode(false); // 绳索收回时复位取件模式（主进程已复位，这里同步 UI）
      closeFolder(true);
      break;
    default:
      break;
  }
});

/* 鼠标进入/离开窗口 → 通知主进程（注册 Esc 全局键 + 防止收回） */
document.addEventListener('mouseenter', () => rope.hover(true));
document.addEventListener('mouseleave', () => rope.hover(false));

/* ---------------- 启动 ---------------- */
rope.getState().then((s) => {
  S = s;
  render();
});
