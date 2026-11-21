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

/* 主题：初始那一帧由 head 里的 theme.js 按 URL 上的 query 定好（不闪白），
   设置窗口切换后主进程把 settings.theme 推过来，这里只负责运行时同步。 */
function applyThemeFromState(s) {
  if (window.ropeTheme) window.ropeTheme.apply(s && s.settings && s.settings.theme);
}

/* 停靠位置（v1.14）：初始由 theme.js 按 URL query 写好 data-pos（不闪布局），
   运行时随状态推送同步。位置一变，展开中的文件夹面板坐标就失效，顺手收起。 */
function applyPosFromState(s) {
  const pos = (s && s.settings && s.settings.ropePosition) || 'top';
  const cur = document.documentElement.getAttribute('data-pos') || 'top';
  const next = window.ropeTheme ? window.ropeTheme.applyPos(pos) : pos;
  if (cur !== next && ui.folder) closeFolder(true);
}

const ui = {
  removeMode: false,
  selMode: false, // 多选模式（v1.17）：按钮开启后普通单击即可勾选；Ctrl+点击是独立入口
  selected: new Set(), // 选中的挂件 id
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

/* 图片扩展名：这类"文件"挂件直接渲染原图预览 */
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;

/* ---------------- Office 文件图标（v1.11） ----------------
   Word / Excel / PowerPoint 文档不再用通用白纸 + "DOCX" 文字，
   改用 assets/ 下三款自绘的彩色应用图标。只按扩展名判断（大小写无关），
   其它格式、图片、文件夹一律保持原逻辑；尺寸与卡片结构不变。 */
const OFFICE_ICON = Object.freeze({
  word: '../../assets/office-word.svg',
  excel: '../../assets/office-excel.svg',
  powerpoint: '../../assets/office-powerpoint.svg',
});
const OFFICE_EXT = Object.freeze({
  doc: 'word', docx: 'word', docm: 'word', dot: 'word', dotx: 'word', dotm: 'word',
  xls: 'excel', xlsx: 'excel', xlsm: 'excel', xlsb: 'excel', xlt: 'excel', xltx: 'excel', xltm: 'excel',
  ppt: 'powerpoint', pptx: 'powerpoint', pptm: 'powerpoint', pps: 'powerpoint',
  ppsx: 'powerpoint', ppsm: 'powerpoint', pot: 'powerpoint', potx: 'powerpoint', potm: 'powerpoint',
});

function officeKind(name) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name || '');
  if (!m) return '';
  const k = m[1].toLowerCase();
  return Object.prototype.hasOwnProperty.call(OFFICE_EXT, k) ? OFFICE_EXT[k] : '';
}

function docShape(name) {
  const doc = document.createElement('div');
  doc.className = 'doc-shape';
  doc.textContent = extOf(name) || '文件';
  return doc;
}

/* 文件夹图标：v1.14.1 起用 assets/folder.png（用户提供的黄色经典文件夹，
   透明背景）。加载失败时退回旧 CSS 绘制的 .folder-shape 兜底块。 */
function folderShape() {
  const img = document.createElement('img');
  img.className = 'folder-shape';
  img.draggable = false;
  img.alt = '';
  img.src = '../../assets/folder.png';
  img.addEventListener('error', () => {
    if (img.isConnected) img.classList.add('folder-shape-fallback');
  });
  return img;
}

/* 资源缺失（旧成品、手改资源目录）时静默退回通用文档形状，
   不让 Chromium 画出破图标，也不会影响单击复制 / 拖出等行为。 */
function officeShape(container, name, kind) {
  const img = document.createElement('img');
  img.className = 'office-icon';
  img.draggable = false;
  img.alt = '';
  img.dataset.office = kind;
  img.addEventListener('error', () => {
    if (img.isConnected) container.replaceChild(docShape(name), img);
  });
  container.appendChild(img);
  img.src = OFFICE_ICON[kind];
  return img;
}

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

/* 手势互斥（不含点击抑制窗）：多选勾选要用它 —— 勾选不该被
   suppressClickUntil 拦（否则 400ms 内连选第二件会被静默吞掉，v1.19 修复） */
function gestureBusy() {
  return ui.removeMode || ui.nativeDrag || ui.press || ui.reorder || ui.textDrag;
}

function clickBlocked() {
  return gestureBusy() || Date.now() < ui.suppressClickUntil;
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
  // 多选：清掉已经不在绳上的 id（取下 / 清空 / 别处删除）
  const liveIds = new Set(S.items.map((i) => i.id));
  for (const id of [...ui.selected]) if (!liveIds.has(id)) ui.selected.delete(id);
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
  if (ui.selected.has(item.id)) el.classList.add('selected');

  const clip = document.createElement('div');
  clip.className = 'clip';
  el.appendChild(clip);

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  buildThumb(thumb, item);
  el.appendChild(thumb);

  /* 正文已经由 .text-preview 完整展示，文字挂件下面不再重复一行首行摘要。
     文件/文件夹/图片的名称行仍然保留，用来辨认目标。 */
  if (item.type !== 'text') {
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = itemLabel(item);
    if (item.invalid) name.textContent = (item.name || '') + '（源已丢失）';
    el.appendChild(name);
  }

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
    container.appendChild(folderShape());
    return;
  }
  const kind = item.type === 'file' ? officeKind(item.name) : '';
  if (kind) {
    officeShape(container, item.name, kind);
    return;
  }
  container.appendChild(docShape(item.name));
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
        // 记录指针位置并尝试启动边缘自动滚动（拖到绳两端够不到时用）
        edgeScroll.x = e.clientX;
        edgeScroll.y = e.clientY;
        edgeAutoScrollStart();
      }
    });
    el.addEventListener('dragend', () => {
      edgeAutoScrollStop();
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
      if (e.button !== 0 || ui.nativeDrag) return;
      // 手势残留自愈（v1.20）：系统原生拖拽会吞掉 pointerup/pointercancel，
      // 若上一个手势的收尾事件丢了（新按下的 pointerId 不同 = 旧指针已消失），
      // 先就地清掉残留再受理新手势 —— 绝不把"排序"永久拒之门外。
      if (ui.press) {
        clearTimeout(ui.press.timer);
        ui.press = null;
      }
      if (ui.reorder) commitReorder();
      const p = {
        item,
        el,
        pointerId: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        lifted: false,
        timer: null,
      };
      // 记住"抓取点"在卡片内的相对位置（§2 直接操纵：拖动 1:1 跟手时，
      // 卡片要保持被抓住的那个部位贴着指针，而不是吸附到自身中心）
      {
        const r = el.getBoundingClientRect();
        p.grabDX = e.clientX - r.left;
        p.grabDY = e.clientY - r.top;
      }
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
     按住拖动 / 排序 / 拖出 / 取件模式由 clickBlocked() 统一挡掉。
     v1.17：多选状态下单击/双击语义停用 —— 普通单击 = 勾选/取消勾选，
     双击不打开；Ctrl+点击仍是独立的多选入口（不开按钮也能直接勾）。 */
  el.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.detail >= 2) return; // 双击的第二下不当选择
      toggleSelect(item.id);
      markClickBlocked(400); // 选完立刻双击的话别误开
      return;
    }
    if (ui.selMode) {
      // 多选模式：单击就是勾选/取消勾选，不再复制。
      // 只拦手势互斥，不拦点击抑制窗：快速连选第二件不能被静默吞掉（v1.19）。
      // 双击的第二下由 detail >= 2 挡掉（多选下 dblclick 本身已停用）。
      if (e.detail >= 2 || gestureBusy()) return;
      toggleSelect(item.id);
      return;
    }
    if (e.detail >= 2 || clickBlocked()) return;
    doCopy(targetOfItem(item), itemLabel(item) || item.type);
  });
  el.addEventListener('dblclick', () => {
    if (ui.selMode) return; // 多选模式下双击打开停用
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

/* v1.16：多选整组拖出 —— 按绳上顺序逐一带出，插入目标软件（Office /
   聊天）时按这个顺序逐一插入；文字等不可插入的对象由主进程统一跳过
   并提示跳过数量。理念不变：只发路径引用（图片发缓存副本），不复制存储。 */
function dragOutMulti(items) {
  const list = [];
  for (const it of items) {
    if (!it) continue;
    list.push(
      it.type === 'image'
        ? { kind: 'image', cachePath: it.cachePath }
        : { kind: it.type, path: it.path || '', text: it.text || '' }
    );
  }
  if (!list.length) return;
  markClickBlocked(2600);
  ui.nativeDrag = true;
  ui.lastDragPath = '';
  ui.lastDragAt = Date.now();
  rope.startDrag({ kind: 'multi', list });
  clearTimeout(ui.nativeDragTimer);
  ui.nativeDragTimer = setTimeout(() => {
    ui.nativeDrag = false;
  }, 2500);
}

function pointInTrack(x, y, margin) {
  const r = els.track.getBoundingClientRect();
  return x >= r.left - margin && x <= r.right + margin && y >= r.top - margin && y <= r.bottom + margin;
}

/* ---------------- v1.19 动效基建（§2 / §3 / §14） ----------------
   · FLIP：被让位的卡片从旧视觉位置弹回新槽位，中断时从当前 transform
     续算（§3 永远从"看到的值"出发），水平 / 垂直停靠都成立；
   · 跟手：拖动锚点卡片 1:1 跟随指针，槽位变化后即时补偿 transform；
   · reduced-motion 两者都退化为瞬时换位。 */
const REDUCED_MOTION = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function currentTranslate(el) {
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return [0, 0];
  const m = t.match(/^matrix\((.+)\)$/);
  if (!m) return [0, 0];
  const p = m[1].split(',').map(parseFloat);
  return [p[4] || 0, p[5] || 0];
}

function flipApply(snapshot, skipSet) {
  if (REDUCED_MOTION()) return;
  for (const [el, old] of snapshot) {
    if (skipSet && skipSet.has(el)) continue;
    const now = el.getBoundingClientRect();
    const [tx, ty] = currentTranslate(el);
    // 视觉连续：新 transform = 旧视觉位置 - 新布局位置
    const dx = old.left + tx - now.left;
    const dy = old.top + ty - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    void el.getBoundingClientRect(); // 强制回流，确保从位移处起步
    el.style.transition = 'transform 150ms cubic-bezier(0.22, 0.61, 0.36, 1)';
    el.style.transform = 'translate(0, 0)';
  }
}

function clearFlipStyles() {
  for (const el of els.track.querySelectorAll('.item')) {
    el.style.transition = '';
    el.style.transform = '';
  }
}

/* 拖动锚点 1:1 跟手：transform = 指针位置 - 抓取偏移 - 当前槽位。
   槽位随 insertBefore 变化后立即重算，视觉不跳。
   reduced-motion 下去掉缩放 / 旋转的花活，只保留 1:1 跟随。 */
function positionDraggedCard(p, px, py) {
  const el = p.el;
  const rect = el.getBoundingClientRect();
  const [tx, ty] = currentTranslate(el);
  const targetX = px - (p.grabDX || 0) - (rect.left - tx);
  const targetY = py - (p.grabDY || 0) - (rect.top - ty);
  el.style.transition = 'none';
  el.style.transform = REDUCED_MOTION()
    ? `translate(${targetX}px, ${targetY}px)`
    : `translate(${targetX}px, ${targetY}px) scale(1.08) rotate(-1.5deg)`;
}

/* 拖拽排序的边缘自动滚动：把最左/最右的挂件往可视区边缘外拖时，
   绳索按"指针深入边缘感应区的距离"成比例加速滚动 —— 否则最后一个
   挂件永远拖不到绳的另一头（用户只能先松手、滚轮滚过去再拖）。
   每帧滚动后用同一个指针坐标重算槽位（reorderAtPoint）和跟手
   transform（positionDraggedCard），卡片在滚动中始终贴着指针。 */
const edgeScroll = { x: 0, y: 0, raf: 0 };

function edgeAutoScrollStop() {
  if (edgeScroll.raf) {
    cancelAnimationFrame(edgeScroll.raf);
    edgeScroll.raf = 0;
  }
}

function edgeAutoScrollStart() {
  if (edgeScroll.raf) return;
  const step = () => {
    edgeScroll.raf = 0;
    const act = ui.reorder || ui.textDrag; // 指针手势 / 文字 HTML5 拖拽都算
    if (!act) return;
    const t = els.track;
    const max = t.scrollWidth - t.clientWidth;
    if (max <= 0) return;
    const rect = t.getBoundingClientRect();
    const zone = 64; // 边缘感应区宽度（px）
    let delta = 0;
    if (edgeScroll.x < rect.left + zone) {
      const depth = Math.min(zone, rect.left + zone - edgeScroll.x);
      delta = -Math.max(2, (depth / zone) * 18); // 越靠边滚得越快，2~18 px/帧
    } else if (edgeScroll.x > rect.right - zone) {
      const depth = Math.min(zone, edgeScroll.x - (rect.right - zone));
      delta = Math.max(2, (depth / zone) * 18);
    }
    const next = Math.max(0, Math.min(max, t.scrollLeft + delta));
    if (next === t.scrollLeft) return; // 已经滚到头（或不在感应区）就停表
    t.scrollLeft = next;
    wheelSmooth.target = next; // 与滚轮平滑共享目标，两条机制不打架
    reorderAtPoint(edgeScroll.x, edgeScroll.y, act.el);
    if (ui.reorder && act.item.type !== 'text') {
      positionDraggedCard(ui.reorder, edgeScroll.x, edgeScroll.y);
    }
    edgeScroll.raf = requestAnimationFrame(step);
  };
  edgeScroll.raf = requestAnimationFrame(step);
}

function reorderAtPoint(x, y, dragged) {  // 多选整组拖动时，插入位置只在“组外”的挂件里找（v1.16）
  const group = (ui.reorder && ui.reorder.group) || null;
  const inGroup = (n) => (group ? group.includes(n) : n === dragged);
  const others = [...els.track.querySelectorAll('.item')].filter((n) => !inGroup(n) && !n.classList.contains('lifting'));
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
  const anchor = group ? group[group.length - 1] : dragged;
  if (insertBefore ? insertBefore === anchor.nextElementSibling : !anchor.nextElementSibling) return;
  // FLIP（§3）：DOM 重排前后各拍一次快照，被让位的卡片从旧位置滑回新槽位
  const snapshot = new Map(
    [...els.track.querySelectorAll('.item')].map((n) => [n, n.getBoundingClientRect()])
  );
  els.track.insertBefore(dragged, insertBefore);
  // 组内其余成员按原相对顺序依次跟在拖动件后面
  if (group) {
    let prev = dragged;
    for (const g of group) {
      if (g === dragged) continue;
      els.track.insertBefore(g, prev.nextSibling);
      prev = g;
    }
  }
  flipApply(snapshot, new Set([dragged]));
}

function lift(p) {
  p.lifted = true;
  markClickBlocked(600); // 已"抬起"就属于排序手势，松手后的 click 不复制
  ui.reorder = p;
  // 多选：拖动的是选中件 → 整组一起抬起（组内相对顺序 = 绳上顺序）。
  // 锚点卡片跟手（v1.19），组内其余成员只做描边高亮（lifting-soft），
  // 变化由 FLIP 平滑带过去 —— 它们的 transform 要留给让位动画用。
  if (ui.selMode && ui.selected.has(p.item.id)) {
    p.group = selectedEls();
    for (const g of p.group) {
      if (g === p.el) g.classList.add('lifting');
      else g.classList.add('lifting-soft');
    }
  } else {
    p.el.classList.add('lifting');
  }
  document.body.classList.add('reordering');
  rope.busy(true);
}

function commitReorder() {
  document.body.classList.remove('reordering');
  markClickBlocked(600);
  edgeAutoScrollStop(); // 松手/转拖出后停掉边缘自动滚动
  if (ui.reorder) {
    const r = ui.reorder;
    // 先移除 reordering（.item 的 transform 过渡随之恢复）再清 inline
    // transform，跟手的卡片会平滑"落"回槽位，而不是瞬移
    if (r.group) {
      for (const g of r.group) {
        g.classList.remove('lifting');
        g.classList.remove('lifting-soft');
      }
    } else {
      r.el.classList.remove('lifting');
    }
    ui.reorder = null;
    clearFlipStyles();
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
    // 拖出窗口 → 转为对外拖出（多选拖的选中件 = 整组带出，v1.16）
    ui.press = null;
    commitReorder();
    if (r.group && r.group.length) {
      dragOutMulti(r.group.map((n) => findItem(n.dataset.id)));
    } else {
      dragOutFromItem(r.item);
    }
    return;
  }
  reorderAtPoint(e.clientX, e.clientY, r.el);
  positionDraggedCard(r, e.clientX, e.clientY); // §2：锚点卡片 1:1 跟手
  // 记录指针位置并尝试启动边缘自动滚动（把末尾挂件拖向绳另一头时用）
  edgeScroll.x = e.clientX;
  edgeScroll.y = e.clientY;
  edgeAutoScrollStart();
});

document.addEventListener('pointerup', (e) => {
  const p = ui.press;
  if (!p) return;
  if (p.lifted) {
    // 松手瞬间用最终指针坐标补算一次落位再提交：边缘自动滚动进行中松手时，
    // 最后一次 reorderAtPoint 可能是滚动中途的帧（松手帧与滚动帧交错），
    // 直接提交会把挂件落在旧槽位（差 1~2 位）。
    const r = ui.reorder;
    if (r && r.item.type !== 'text' && (e.clientX || e.clientY)) {
      reorderAtPoint(e.clientX, e.clientY, r.el);
      positionDraggedCard(r, e.clientX, e.clientY);
    }
    commitReorder(); // 在绳内松手 → 落位
  } else clearTimeout(p.timer);
  ui.press = null;
});
document.addEventListener('pointercancel', (e) => {
  const p = ui.press;
  if (!p) return;
  if (p.lifted) {
    const r = ui.reorder;
    if (r && r.item.type !== 'text' && (e.clientX || e.clientY)) {
      reorderAtPoint(e.clientX, e.clientY, r.el);
      positionDraggedCard(r, e.clientX, e.clientY);
    }
    commitReorder();
  } else clearTimeout(p.timer);
  ui.press = null;
});

/* ---------------- 文件夹浏览面板 ---------------- */

function ensureFolderOpen(item, anchorEl) {
  if (!ui.folder || ui.folder.id !== item.id) openFolder(item, anchorEl);
}

function openFolder(item, anchorEl) {
  ui.folder = { id: item.id, entries: [], index: 0, error: '' };
  clearTimeout(ui.folderHideTimer);
  els.folderPanel.classList.remove('closing');
  rope.setHeight(410);
  const placement = positionFolderPanel(anchorEl);
  if (placement === 'below') {
    // 窗口太窄面板只能放卡片下方：把窗口加高到够容纳（主进程上限 600）。
    // 此刻面板还是 hidden，getBoundingClientRect 全 0 —— 只能用锚点矩形 + 估算高度
    rope.setHeight(Math.round(anchorEl.getBoundingClientRect().bottom + 8 + 280 + 12));
  }
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
  const height = 250; // 面板高度估值（头部 + 3 行 + 底注），用于上下方位的避让
  const pos = document.documentElement.getAttribute('data-pos') || 'top';

  if (pos === 'left') {
    // 绳在左缘：面板出现在卡片右侧（屏幕内侧）
    const left = Math.round(r.right + 10);
    let top = Math.round(r.top - 40);
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    els.folderPanel.style.left = left + 'px';
    els.folderPanel.style.top = top + 'px';
    return;
  }
  if (pos === 'right') {
    // 绳在右缘：面板出现在卡片左侧
    const left = Math.round(r.left - width - 10);
    let top = Math.round(r.top - 40);
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    els.folderPanel.style.left = Math.max(8, left) + 'px';
    els.folderPanel.style.top = top + 'px';
    return;
  }
  if (pos === 'bottom') {
    // 绳在底边：面板出现在卡片上方（避开卡片与下缘）
    const left = Math.round(r.left - 60);
    let top = Math.round(r.top - height - 8);
    top = Math.max(8, top);
    els.folderPanel.style.left = Math.max(8, Math.min(left, window.innerWidth - width - 8)) + 'px';
    els.folderPanel.style.top = top + 'px';
    return;
  }
  // 顶部（默认）：统一放卡片**正下方**（v1.20b 用户拍板：所有顶部停靠的展开
  // 都用同一形态，不再做侧面摆放），窗口加高到容纳面板（openFolder 读取返回值）。
  // top 以卡片底边为准——不能拿当前 innerH 做上限（此时窗口可能还没长高）。
  const top = Math.max(8, Math.round(r.bottom + 8));
  els.folderPanel.style.left = Math.max(8, Math.min(Math.round(r.left - 60), window.innerWidth - width - 8)) + 'px';
  els.folderPanel.style.top = top + 'px';
  return 'below';
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

/* 关闭面板：退出动画与入场对称（§7 从哪来回哪去），淡出完成后才
   隐藏并把窗口高度收回去——先收高度会把淡出中的面板拦腰裁掉。
   reduced-motion / instant 直接隐藏。 */
function finishFolderHide() {
  clearTimeout(ui.folderHideTimer);
  els.folderPanel.classList.remove('closing');
  els.folderPanel.hidden = true;
  rope.setHeight(210);
}

function closeFolder(instant) {
  clearTimeout(ui.folderCloseTimer);
  ui.folder = null;
  const panel = els.folderPanel;
  if (panel.hidden || panel.classList.contains('closing')) return;
  if (instant || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finishFolderHide();
    return;
  }
  panel.classList.add('closing');
  ui.folderHideTimer = setTimeout(finishFolderHide, 120);
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
    } else if (entry.isDir) {
      th.appendChild(folderShape());
    } else {
      const kind = officeKind(entry.name); // 文件夹面板里 Office 行跟着换图标
      if (kind) officeShape(th, entry.name, kind);
      else th.appendChild(docShape(entry.name));
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
   没有溢出就不拦截，避免吞掉正常滚动；面板内的滚轮归面板自己处理。
   v1.19 §1：不再逐格瞬跳 —— 目标值累积，rAF 每帧向目标收敛（指数趋近），
   连续滚动时目标一直前移，动画天然衔接；prefers-reduced-motion 直接赋值。 */
const wheelSmooth = { target: 0, raf: 0 };

function smoothTrackScroll(delta) {
  const t = els.track;
  const max = t.scrollWidth - t.clientWidth;
  if (max <= 0) return;
  const base = wheelSmooth.raf ? wheelSmooth.target : t.scrollLeft;
  wheelSmooth.target = Math.max(0, Math.min(max, base + delta));
  if (wheelSmooth.raf) return;
  const step = () => {
    const cur = t.scrollLeft;
    const diff = wheelSmooth.target - cur;
    if (Math.abs(diff) < 1) {
      t.scrollLeft = wheelSmooth.target;
      wheelSmooth.raf = 0;
      return;
    }
    t.scrollLeft = cur + diff * 0.3;
    wheelSmooth.raf = requestAnimationFrame(step);
  };
  wheelSmooth.raf = requestAnimationFrame(step);
}

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
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const base = wheelSmooth.raf ? wheelSmooth.target : els.track.scrollLeft;
      els.track.scrollLeft = Math.max(0, Math.min(max, base + step));
      return;
    }
    smoothTrackScroll(step);
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
  hideVeil(); // 所有早退路径都先把遮罩/深度收干净，别留在半路
  if (ui.nativeDrag) return; // 自己拖出的东西，拖回自己窗口忽略
  if (ui.textDrag) {
    // 自己的文字挂件拖回绳上：只算排序，不重复挂
    if (ui.textDrag.reordered) commitReorder();
    return;
  }

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
  // 取件与多选互斥：进取件模式先退出多选
  if (on && ui.selMode) setSelMode(false);
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
  // 多选模式开着时，Esc 先退出多选（取件模式退后）
  if (ui.selMode) {
    setSelMode(false);
    return;
  }
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

/* ---------------- 多选模式（v1.16） ----------------
   与取件模式同一套手势思路（复用点击拦截 / Esc 退出），但语义互补：
   · 进入：点「多选」按钮，或直接 Ctrl+点击任意挂件（隐式进入）
   · 勾选：Ctrl+点击 切换选中；多选状态下普通单击 / 双击语义不变
     （单击复制 / 双击打开，作用于指针指向的那一件）
   · 整组拖动：按住选中件抬起 → 整组跟手换位（保持组内相对顺序）
   · 整组拖出：拖出窗口 → 按绳上顺序逐一插入目标软件，
     文字等不可插入的对象自动跳过（主进程提示跳过数量）
   · 退出：再点「多选」按钮，或按 Esc（多选优先于取件模式） */

function itemElById(id) {
  return [...els.track.children].find((n) => n.dataset.id === id) || null;
}

function selectedEls() {
  return [...els.track.children].filter((n) => n.classList.contains('selected'));
}

function setSelMode(on) {
  if (ui.selMode === on) return;
  ui.selMode = on;
  if (!on) {
    ui.selected.clear();
    for (const n of els.track.querySelectorAll('.item.selected')) n.classList.remove('selected');
  }
  document.body.classList.toggle('sel-mode', on);
  const btn = $('#btn-select');
  if (btn) btn.classList.toggle('on', on);
}

function toggleSelect(id) {
  const el = itemElById(id);
  if (!el) return;
  if (!ui.selMode) setSelMode(true); // Ctrl 点选隐式进入多选（与按钮开启等效）
  if (ui.selected.has(id)) {
    ui.selected.delete(id);
    el.classList.remove('selected');
  } else {
    ui.selected.add(id);
    el.classList.add('selected');
  }
}

$('#btn-select').addEventListener('click', () => {
  const on = !ui.selMode;
  setSelMode(on);
  toast(on ? '多选：点击卡片勾选 · 拖动整组排序 / 插入 · Esc 或再点按钮退出' : '已退出多选');
});

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
  applyThemeFromState(s);
  applyPosFromState(s);
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
    case 'drag-ended':
      // 主进程确认系统拖放已结束（sender.startDrag 返回 = drop 已完成）：
      // 立刻解除 nativeDrag。此前要等满 2.5s 保护窗，用户把文件拖回来
      // 想马上排序时 pointerdown 会被整窗拒绝，体感就是"没法排序了"。
      clearTimeout(ui.nativeDragTimer);
      ui.nativeDrag = false;
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
  applyThemeFromState(s);
  applyPosFromState(s);
  render();
});
