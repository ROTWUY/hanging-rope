/**
 * 悬挂绳 —— 主进程
 * 顶部贴边悬浮窗（隐藏/唤出）、托盘、全局快捷键、剪贴板监听、拖出支持、持久化。
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  globalShortcut,
  clipboard,
  nativeImage,
  dialog,
  Tray,
  Menu,
  shell,
  powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const store = require('./store');
const geo = require('./geometry');
const dragPlan = require('./drag-plan');
const imageFormat = require('./image-format');
const paths = require('./paths');
const itemAction = require('./item-action');

/* ---------------- 常量 ---------------- */
const BASE_HEIGHT = 210; // 常规高度（文件夹浏览面板展开时由渲染层调到 370）
const EDGE_TRIGGER_PX = 2; // 触顶判定
const HIDE_GRACE_TICKS = 3; // 连续离开多少个轮询周期后收回
const POLL_MS = 60;
const CLIP_POLL_MS = 700;
const MAX_CLIP_IMAGE_BYTES = 20 * 1024 * 1024;

let win = null;
let tray = null;
let quiting = false;

/** 崩溃/异常落盘，方便排查“拖放后程序消失”这类问题 */
function logLine(msg) {
  try {
    const file = path.join(app.getPath('userData'), 'crash.log');
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

app.on('render-process-gone', (_e, _wc, details) => logLine('render-process-gone ' + JSON.stringify(details)));
app.on('child-process-gone', (_e, details) => logLine('child-process-gone ' + JSON.stringify(details)));
process.on('uncaughtException', (err) => logLine('uncaughtException: ' + (err && err.stack ? err.stack : err)));
process.on('unhandledRejection', (r) => logLine('unhandledRejection: ' + r));

/* 悬浮窗状态 */
let ropeVisible = false;
let ropeHeight = BASE_HEIGHT;
let winX = 0;
let winW = 800;
let outsideTicks = 0;
let animToken = 0; // 动画令牌：新动画打断旧动画
let busyDrag = false; // 拖拽进行中禁止收回
let hovering = false; // 渲染层报告鼠标在内容上
let removeMode = false;

/* 剪贴板监听 */
let copyMode = false;
let clipTimer = null;
let lastClipText = '';
let lastClipImageHash = '';
let lastClipFileSig = '';

/* 双击打开的动作日志；自动化里只记载荷，不真的启动系统程序 */
const openLog = [];
const dryOpen = () => process.env.HANGING_ROPE_TEST_DRY_OPEN === '1';

/* 测试支持：允许用独立 userData 启动，不与正在运行的正式实例抢单实例锁 */
if (process.env.HANGING_ROPE_TEST_USERDATA) {
  app.setPath('userData', process.env.HANGING_ROPE_TEST_USERDATA);
  process.env.HANGING_ROPE_USERDATA = process.env.HANGING_ROPE_TEST_USERDATA;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showRope());
}

app.setAppUserModelId('com.local.hangingrope');

/* ---------------- 悬浮窗 ---------------- */

function createWindow() {
  const display = screen.getPrimaryDisplay();
  // 绳索只占屏幕宽度的 1/3，居中于顶部（几何计算见 geometry.js，可单测）
  const bounds = geo.computeWindowBounds(display.bounds, BASE_HEIGHT);
  winW = bounds.width;
  winX = bounds.x;

  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: BASE_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.on('closed', () => {
    win = null;
  });
  win.on('focus', updateEscapeRegistration);
  win.on('blur', updateEscapeRegistration);
}

function animateY(targetY, height, done) {
  const token = ++animToken;
  const fromY = win.getBounds().y;
  const dur = 150;
  const start = Date.now();
  const step = () => {
    if (!win || token !== animToken) return;
    const t = Math.min(1, (Date.now() - start) / dur);
    const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
    const y = Math.round(fromY + (targetY - fromY) * e);
    try {
      win.setBounds({ x: winX, y, width: winW, height });
    } catch {
      /* ignore */
    }
    if (t < 1) setTimeout(step, 12);
    else if (done) done();
  };
  step();
}

function showRope() {
  if (!win || ropeVisible) return;
  ropeVisible = true;
  outsideTicks = 0;
  animateY(0, ropeHeight);
  sendEvent({ type: 'shown' });
}

function hideRope(force = false) {
  if (!win || !ropeVisible) return;
  if (busyDrag && !force) return;
  ropeVisible = false;
  removeMode = false;
  clearTimeout(escReleaseTimer);
  unregisterHoverShortcuts();
  sendEvent({ type: 'hidden', removeMode });
  animateY(-ropeHeight, ropeHeight);
}

/* 鼠标轮询：顶部触边唤出；离开窗口一段时间后收回 */
let edgeTicks = 0; // 顶部边缘连续停留计数（防误触：掠过不唤出）

function startEdgeWatcher() {
  // 测试用：冻结轮询，由测试脚本显式调用 showRope/hideRope，避免真实光标位置干扰
  if (process.env.HANGING_ROPE_TEST_FREEZE_WATCHER) return;
  setInterval(() => {
    if (!win) return;
    const p = screen.getCursorScreenPoint();
    const primary = screen.getPrimaryDisplay().bounds;

    if (!ropeVisible) {
      const hit = geo.isTopEdgeHit(p, primary, winX, winW, EDGE_TRIGGER_PX);
      const step = geo.nextEdgeTicks(edgeTicks, hit, 2);
      edgeTicks = step.ticks;
      if (step.show) showRope();
      return;
    }

    // 可见状态：判断是否离开
    if (process.env.HANGING_ROPE_DEBUG_SHOW) return; // 调试常显
    const b = win.getBounds();
    if (geo.shouldAutoHide(p, b, hovering, busyDrag)) {
      outsideTicks++;
      if (outsideTicks >= HIDE_GRACE_TICKS) hideRope();
    } else {
      outsideTicks = 0;
    }
  }, POLL_MS);
}

/* ---------------- Escape 取件模式 ----------------
   只允许一个处理者，否则一开一关会闪烁：
   · 窗口未聚焦（鼠标只是悬停）→ 注册全局 Esc，由主进程切换；
   · 窗口已聚焦 → 全局快捷键注销，由渲染层 keydown 切换。
   按住不放的自动重复只算一次。 */

let escReleaseTimer = null;

function enterRemoveMode(on) {
  if (removeMode === on) return;
  removeMode = on;
  sendEvent({ type: 'remove-mode', on });
}

/* 窗口未聚焦时用全局快捷键实现“按住 Esc”：
   globalShortcut 只有按下事件（含按住不放的自动重复），拿不到松开事件。
   利用自动重复做保活——每次 keydown（含重复）都把“松开定时器”往后推；
   重复停止（松开）后 0.65 秒退出取件模式。 */
function onEscapePressed() {
  clearTimeout(escReleaseTimer);
  escReleaseTimer = setTimeout(() => enterRemoveMode(false), 650);
  if (!removeMode) enterRemoveMode(true);
}

function registerEscape() {
  try {
    globalShortcut.register('Escape', onEscapePressed);
  } catch {
    /* 被占用则退化为窗口内按键 */
  }
}

function unregisterEscape() {
  try {
    globalShortcut.unregister('Escape');
  } catch {
    /* ignore */
  }
}

/* 根据聚焦状态决定 Esc 归谁管 */
function updateEscapeRegistration() {
  if (!win) return;
  if (hovering && ropeVisible && !win.isFocused()) registerEscape();
  else unregisterEscape();
}

/* 鼠标停在绳索上时，Ctrl+V 直接挂上剪贴板内容 */
function registerHoverShortcuts() {
  try {
    globalShortcut.register('CommandOrControl+V', onPastePressed);
  } catch {
    /* 被占用则只支持拖入 */
  }
  updateEscapeRegistration();
}

function unregisterHoverShortcuts() {
  unregisterEscape();
  try {
    globalShortcut.unregister('CommandOrControl+V');
  } catch {
    /* ignore */
  }
}

/* ---------------- 复制即悬挂（剪贴板监听） ---------------- */

function clipImageHash(img) {
  if (!img || img.isEmpty()) return '';
  return crypto.createHash('sha1').update(img.toPNG()).digest('hex');
}

function readClipFile() {
  const list = readClipboardFiles();
  return list[0] || '';
}

/**
 * 读取剪贴板里的文件列表（资源管理器“复制文件/复制图片文件”）。
 * 实测坑：clipboard.read('FileNameW') 返回的字符串里夹着 UTF-16 空字节
 * （形如 "E\0:\0\\0..."），直接 trim 再 stat 必然失败。
 * 正确做法是读原始 buffer 按 utf16le 解码，再按 \0 切分。
 */
function readClipboardFiles() {
  const raw = [];
  const pushList = (s) => {
    if (!s) return;
    for (const part of String(s).split('\0')) {
      const p = part.replace(/\0/g, '').trim();
      if (p) raw.push(p);
    }
  };
  try {
    const buf = clipboard.readBuffer('FileNameW');
    if (buf && buf.length) pushList(buf.toString('utf16le'));
  } catch {
    /* ignore */
  }
  if (!raw.length) {
    try {
      pushList(clipboard.read('FileName'));
    } catch {
      /* ignore */
    }
  }
  if (!raw.length) {
    try {
      pushList(clipboard.read('FileNameW'));
    } catch {
      /* ignore */
    }
  }
  const seen = new Set();
  return raw.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return !!statSafe(p);
  });
}

function snapshotClipboard() {
  lastClipText = clipboard.readText() || '';
  lastClipImageHash = clipImageHash(clipboard.readImage());
  const files = readClipboardFiles();
  lastClipFileSig = files.length ? 'files:' + files.join('|').toLowerCase() : '';
}

/**
 * 单击复制：把目标写进系统剪贴板（v1.5）。
 * 写完必须刷新"复制即悬挂"的监听基线，否则自己复制的内容会在下一次轮询里
 * 又被自动挂回绳上 —— 正好踩到 AC-29 要防的重复悬挂。
 */
function copyItemToClipboard(target) {
  const plan = itemAction.planCopy(target);
  if (!plan.ok) return plan;
  try {
    if (plan.kind === 'text') {
      clipboard.writeText(plan.payload.text);
    } else if (plan.kind === 'image') {
      const p = plan.payload.imageCachePath;
      if (!fs.existsSync(p)) {
        return { ok: false, reason: 'missing', message: '图片副本已丢失，无法复制' };
      }
      clipboard.writeImage(nativeImage.createFromPath(p));
    } else {
      const exists = plan.payload.paths.filter((p) => fs.existsSync(p));
      if (!exists.length) {
        return { ok: false, reason: 'missing', message: '源文件已丢失，无法复制' };
      }
      const buf = itemAction.fileNameWBuffer(exists);
      if (!buf.length) return { ok: false, reason: 'bad-path', message: '源文件路径无效' };
      // 实测：写 FileNameW 后系统会同时呈现标准 CF_HDROP，可直接粘贴到资源管理器
      clipboard.writeBuffer('FileNameW', buf);
    }
    snapshotClipboard();
    return { ok: true, kind: plan.kind };
  } catch (err) {
    return { ok: false, reason: 'error', message: (err && err.message) || '复制失败' };
  }
}

/**
 * 双击打开：用系统默认程序打开对象本体（v1.5）。
 * 文字没有文件本体 → 退化为复制并提示；源文件丢失 → 明确提示，不静默失败。
 */
async function openItemTarget(target) {
  const plan = itemAction.planOpen(target);
  if (!plan.ok) {
    if (plan.fallback === 'copy') {
      const r = copyItemToClipboard(target);
      return {
        ok: false,
        fallback: 'copy',
        copied: !!r.ok,
        message: r.ok ? plan.message : r.message,
      };
    }
    return plan;
  }
  const p = plan.payload.path;
  if (!fs.existsSync(p)) {
    return { ok: false, reason: 'missing', message: '源文件已丢失，无法打开' };
  }
  // 自动化里只记载荷，否则每次双击都会弹出记事本 / 看图器 / 资源管理器
  if (dryOpen()) {
    openLog.push({ path: p, at: Date.now() });
    return { ok: true, kind: 'open', dry: true, path: p };
  }
  try {
    const err = await shell.openPath(p);
    if (err) return { ok: false, reason: 'open-failed', message: err };
    return { ok: true, kind: 'open', path: p };
  } catch (err) {
    return { ok: false, reason: 'error', message: (err && err.message) || '打开失败' };
  }
}

function setCopyMode(on) {
  if (on === copyMode) return;
  copyMode = on;
  if (on) {
    snapshotClipboard(); // 开启瞬间不做“补挂”
    startClipWatcher();
  } else {
    stopClipWatcher();
  }
  sendState();
  sendEvent({ type: 'copy-mode', on });
}

function startClipWatcher() {
  if (clipTimer) return;
  clipTimer = setInterval(clipCheck, CLIP_POLL_MS);
}

function stopClipWatcher() {
  clearInterval(clipTimer);
  clipTimer = null;
}

/**
 * 从剪贴板取一件内容挂上绳。
 * force=true 表示用户主动按了 Ctrl+V（忽略“重复内容”判断）。
 */
function hangFromClipboard(force = false) {
  /* 1) 文件 / 文件夹（资源管理器复制） */
  const files = readClipboardFiles();
  if (files.length) {
    const sig = 'files:' + files.join('|').toLowerCase();
    if (!force && sig === lastClipFileSig) return { ok: false, reason: 'same' };
    const dup = force && store.getItems().some((i) => (i.type === 'file' || i.type === 'folder') && files.some((f) => f.toLowerCase() === i.path.toLowerCase()));
    if (dup) {
      sendEvent({ type: 'toast', text: '这些文件已经挂在绳上了' });
      return { ok: false, reason: 'same' };
    }
    lastClipFileSig = sig;
    lastClipText = '';
    const added = addPaths(files);
    if (added.length) {
      sendEvent({ type: 'toast', text: '已悬挂剪贴板文件', level: 'ok' });
      return { ok: true };
    }
    return { ok: false, reason: 'failed' };
  }

  /* 2) 文字（Excel/Word 复制常同时携带图片，优先按文字处理） */
  const text = clipboard.readText();
  if (text && text.trim()) {
    if (!force && text === lastClipText) return { ok: false, reason: 'same' };
    const dup = force && store.getItems().some((i) => i.type === 'text' && i.text === text);
    if (dup) {
      sendEvent({ type: 'toast', text: '这段文字已经挂在绳上了' });
      return { ok: false, reason: 'same' };
    }
    lastClipText = text;
    lastClipImageHash = '';
    const item = addTextItem(text, true);
    if (item) {
      sendEvent({ type: 'toast', text: '已悬挂剪贴板文字', level: 'ok' });
      return { ok: true };
    }
    return { ok: false, reason: 'too-long' };
  }

  /* 3) 图片 */
  const img = clipboard.readImage();
  if (img.isEmpty()) return { ok: false, reason: 'empty' };
  const h = clipImageHash(img);
  if (!force && h === lastClipImageHash) return { ok: false, reason: 'same' };
  const png = img.toPNG();
  if (png.length > MAX_CLIP_IMAGE_BYTES) {
    lastClipImageHash = h;
    sendEvent({ type: 'toast', text: '剪贴板图片过大，未悬挂', level: 'warn' });
    return { ok: false, reason: 'too-big' };
  }
  lastClipImageHash = h;
  lastClipText = '';
  const savedItem = addImageBuffer(png, 'png', { name: '剪贴板图片', silent: true });
  if (!savedItem) return { ok: false, reason: 'failed' };
  sendEvent({ type: 'toast', text: '已悬挂剪贴板图片', level: 'ok' });
  return { ok: true };
}

function clipCheck() {
  if (!copyMode) return;
  hangFromClipboard(false);
}

/** 悬浮窗可见时按 Ctrl+V：把剪贴板内容挂上绳 */
function onPastePressed() {
  if (!ropeVisible) return;
  const r = hangFromClipboard(true);
  if (r.ok || r.reason === 'same') return;
  const msg =
    r.reason === 'empty'
      ? '剪贴板里没有可悬挂的内容'
      : r.reason === 'too-long'
      ? '文字太长，建议另存为文件再挂'
      : r.reason === 'failed'
      ? '无法读取剪贴板里的文件'
      : '';
  if (msg) sendEvent({ type: 'toast', text: msg, level: 'warn' });
}

function looksLikePath(t) {
  const s = t.trim().replace(/^"(.*)"$/, '$1').trim();
  if (!s || s.includes('\n') || s.length > 500) return null;
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\')) return s;
  return null;
}

function addTextItem(text, fromWatcher = false) {
  const t = String(text || '');
  if (!t.trim()) return null;

  // 看起来像本地路径 → 直接按文件/文件夹悬挂
  const asPath = looksLikePath(t);
  if (asPath && statSafe(asPath)) {
    return addPaths([asPath])[0] || null;
  }

  if (t.length > store.MAX_TEXT_CHARS) {
    sendEvent({ type: 'toast', text: `文字太长（>${Math.round(store.MAX_TEXT_CHARS / 1000)}KB），建议保存为文件再拖`, level: 'warn' });
    return null;
  }
  const item = store.addItem({ id: store.newId(), type: 'text', text: t, addedAt: Date.now() });
  sendState();
  if (!fromWatcher) sendEvent({ type: 'toast', text: '已悬挂文字', level: 'ok' });
  return item;
}

/* ---------------- 新增挂件 ---------------- */

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * .lnk 快捷方式 → 解析出它指向的本体（文件或文件夹）。
 * 解析失败时返回原路径，由调用方决定如何处理。
 */
function resolveShortcut(p) {
  if (!p || !/\.lnk$/i.test(p)) return { path: p, shortcut: null };
  try {
    const link = shell.readShortcutLink(p);
    if (link && link.target && fs.existsSync(link.target)) {
      return { path: link.target, shortcut: p };
    }
  } catch {
    /* 损坏/网络路径/权限不足时保持原样 */
  }
  return { path: p, shortcut: null };
}

/* 启动自愈：旧版本挂上的 .lnk 挂件当时可能没解析成功（或解析时目标尚不存在）。
   重启后重新解析一次：能解析到现存的本体就更新挂件（路径/名称/类型）；
   解析不到（快捷方式悬空）则保持原样，拖出时降级发送 .lnk 本身。 */
function healShortcuts() {
  let changed = false;
  for (const it of store.getItems()) {
    if (it.type !== 'file' && it.type !== 'folder') continue;
    if (!it.path || !/\.lnk$/i.test(it.path)) continue;
    const resolved = resolveShortcut(it.path);
    if (!resolved.shortcut) continue; // 仍解析不到现存目标
    const st = statSafe(resolved.path);
    if (!st) continue;
    it.path = resolved.path;
    it.name = path.basename(resolved.path) || it.name;
    it.type = st.isDirectory() ? 'folder' : 'file';
    it.shortcut = resolved.shortcut;
    changed = true;
  }
  if (changed) {
    store.save();
    console.log('[hanging-rope] healed shortcut items');
  }
}

function addPaths(paths) {
  const added = [];
  for (const raw of paths || []) {
    if (!raw) continue;
    const resolved = resolveShortcut(raw);
    const p = resolved.path;
    const st = statSafe(p);
    if (!st) {
      sendEvent({ type: 'toast', text: `无法读取：${p}`, level: 'warn' });
      continue;
    }
    const isDir = st.isDirectory();
    const item = store.addItem({
      id: store.newId(),
      type: isDir ? 'folder' : 'file',
      path: p,
      name: path.basename(p) || p,
      shortcut: resolved.shortcut || undefined,
      addedAt: Date.now(),
    });
    added.push(item);
  }
  if (added.length) sendState();
  return added;
}

/**
 * 把某个路径"钉"到绳上（文件夹浏览面板里点 📌 时走这里）。
 * 与拖入的区别：不产生重复 —— 同一目标已经在绳上时直接返回 already，
 * 让渲染层提示"已经在绳上了"，而不是挂出两张一样的卡片。
 */
function pinPath(raw) {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, reason: 'bad-path', message: '路径无效' };
  }
  const resolved = resolveShortcut(raw);
  const p = resolved.path;
  const st = statSafe(p);
  if (!st) {
    return { ok: false, reason: 'missing', message: '目标已不存在' };
  }

  const existing = paths.pinnedItems(store.getItems(), p)[0];
  if (existing) {
    return { ok: true, already: true, id: existing.id, name: existing.name };
  }

  const isDir = st.isDirectory();
  const item = store.addItem({
    id: store.newId(),
    type: isDir ? 'folder' : 'file',
    path: p,
    name: path.basename(p) || p,
    shortcut: resolved.shortcut || undefined,
    addedAt: Date.now(),
  });
  sendState();
  return { ok: true, already: false, id: item.id, name: item.name };
}

/**
 * 取消固定：把该路径对应的文件/文件夹挂件从绳上摘掉。
 * 文件夹浏览面板里再点一次已固定的 📌 时走这里（v1.4 / AC-47）。
 *
 * 与 pinPath 对称，共用 pinnedItems 的路径归一化判定；区别：
 *  - **不做 stat 校验**：源目录已被移动/删除时，也要能把挂件取下来。
 *  - **一次摘掉全部同目标挂件**：大小写/斜杠/末尾分隔符变体导致的重复卡片
 *    不能出现"点了取消却还剩一张"的半吊子状态。
 */
function unpinPath(raw) {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, reason: 'bad-path', message: '路径无效' };
  }
  const resolved = resolveShortcut(raw);
  const matches = paths.pinnedItems(store.getItems(), resolved.path);
  if (!matches.length) {
    return { ok: true, removed: false, count: 0, message: '绳上没有这个文件夹' };
  }
  for (const it of matches) store.removeItem(it.id);
  sendState();
  return { ok: true, removed: true, count: matches.length, name: matches[0].name };
}

/** 挂件显示用的可读名称：优先用来源文件名/URL 末段，取不到就用缓存名 */
function readableImageName(hint, fallback) {
  let base = String(hint || '').split(/[\\/]/).pop() || '';
  base = base.replace(/[?#].*$/, '').trim();
  if (!base) return fallback;
  return base.length > 60 ? base.slice(0, 57) + '…' : base;
}

function nameFromUrl(u) {
  try {
    const seg = new URL(u).pathname.split('/').filter(Boolean).pop() || '';
    return seg || '网页图片';
  } catch {
    return '网页图片';
  }
}

/**
 * 把图片字节落盘并挂上绳。
 * 扩展名一律以字节为准（见 image-format.js），不再直接拿 content-type 拼 ——
 * `image/svg+xml` 那样拼出来的是 `.svgxml`，Chromium 按扩展名判类型就成了破图。
 * @param {Buffer|Uint8Array} buf
 * @param {string} extHint 渲染层/上游给的扩展名提示（仅兜底用）
 * @param {{mime?:string,name?:string,fromWatcher?:boolean,silent?:boolean}} opts
 */
function addImageBuffer(buf, extHint, opts = {}) {
  if (!buf || !buf.length) return null;
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const nameHint = opts.name || '';
  const { ext } = imageFormat.resolveImageExt({
    buf: bytes,
    mime: opts.mime || '',
    name: nameHint || (extHint ? 'image.' + extHint : ''),
  });
  if (!ext || !imageFormat.isRenderableExt(ext)) {
    // 认不出格式时区分“拿到的是网页”和“拿到了看不懂的二进制”，提示更有用
    const head = bytes.slice(0, 512).toString('utf8').toLowerCase();
    const looksHtml = /<!doctype html|<html[\s>]|<head[\s>]/.test(head);
    sendEvent({
      type: 'toast',
      text: looksHtml
        ? '抓到的不是图片（可能是防盗链页面），未悬挂'
        : ext
        ? `${ext.toUpperCase()} 格式的图片无法预览，未悬挂`
        : '这张图片的格式无法识别，未悬挂',
      level: 'warn',
    });
    return null;
  }

  const saved = store.saveImageToCache(bytes, ext);
  let size = { width: null, height: null };
  if (ext === 'svg') {
    size = imageFormat.svgSize(bytes.toString('utf8'));
  } else {
    try {
      const im = nativeImage.createFromPath(saved.path);
      if (!im.isEmpty()) size = im.getSize();
    } catch {
      /* ignore */
    }
  }
  const item = store.addItem({
    id: store.newId(),
    type: 'image',
    cachePath: saved.path,
    name: readableImageName(nameHint, saved.name),
    width: size.width,
    height: size.height,
    bytes: bytes.length,
    addedAt: Date.now(),
  });
  checkCacheLimit();
  sendState();
  if (!opts.fromWatcher && !opts.silent) {
    sendEvent({ type: 'toast', text: '已悬挂图片', level: 'ok' });
  }
  return item;
}

/** 从网页拖图片进来：解析出图片地址后下载缓存（这是工具唯一的联网动作，仅发生在用户主动拖拽网页图片时） */
async function addImageFromUrl(url, hintName) {
  try {
    const u = String(url || '');
    if (!u) throw new Error('没有图片地址');
    if (/^data:/i.test(u)) {
      const parsed = imageFormat.parseDataUrl(u);
      if (!parsed) throw new Error('内联图片数据无法解析');
      return addImageBuffer(parsed.buf, '', { mime: parsed.mime, name: hintName || '网页图片' });
    }
    if (!/^https?:\/\//i.test(u)) throw new Error('不支持的图片地址');
    const { net } = require('electron');
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;
    const resp = await net.fetch(u, signal ? { signal } : undefined);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const type = (resp.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) throw new Error('图片内容为空');
    // content-type 不可全信（CDN 常给 application/octet-stream），以字节为最终依据
    if (!imageFormat.sniffExt(buf) && !type.startsWith('image/')) {
      throw new Error('拿到的不是图片（' + (type || '未知类型') + '，可能有防盗链）');
    }
    return addImageBuffer(buf, '', { mime: type, name: hintName || nameFromUrl(u) });
  } catch (e) {
    sendEvent({ type: 'toast', text: '图片抓取失败：' + e.message, level: 'warn' });
    return null;
  }
}

function checkCacheLimit() {
  const usage = store.cacheUsage();
  if (usage.bytes > usage.limitMB * 1024 * 1024) {
    sendEvent({
      type: 'toast',
      text: `图片缓存已超过上限（${usage.limitMB}MB），可到设置里清理`,
      level: 'warn',
    });
  }
}

/* ---------------- 拖出 ---------------- */

function genericDragIcon() {
  const img = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'tray.png'));
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

/**
 * 计算一次拖出要发送什么（纯决策，不启动系统拖拽）。
 * 规则实现见 drag-plan.js（可单测），这里只负责注入真实依赖。
 * @returns {{ok:boolean,target:string|null,icon:object|null,warning:string,kind:string,shortcut?:string}}
 */
function planDrag(payload) {
  return dragPlan.planDrag(payload, {
    exists: (p) => fs.existsSync(p),
    stat: statSafe,
    resolveShortcut,
    imageIconFor: (p) => {
      try {
        const img = nativeImage.createFromPath(p);
        return img.isEmpty() ? null : img.resize({ width: 64 });
      } catch {
        return null;
      }
    },
  });
}

/* 测试用：干跑模式记录每次拖出的载荷，不真正启动系统拖拽 */
const dragLog = [];

function startDrag(payload, sender) {
  const plan = planDrag(payload);
  if (plan.warning) {
    sendEvent({ type: 'toast', text: plan.warning, level: 'warn' });
  }
  if (!plan.ok) {
    if (!plan.warning) sendEvent({ type: 'toast', text: '无法拖出', level: 'warn' });
    return false;
  }

  let icon = plan.icon || genericDragIcon();
  if (!icon || icon.isEmpty()) icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icon.png'));

  busyDrag = true;
  if (process.env.HANGING_ROPE_TEST_DRY_DRAG) {
    dragLog.push({ at: Date.now(), target: plan.target, kind: plan.kind, warning: plan.warning });
    setTimeout(() => {
      busyDrag = false;
    }, 300);
    return true;
  }
  try {
    sender.startDrag({ file: plan.target, icon });
  } catch (e) {
    busyDrag = false;
    logLine('startDrag error: ' + e.message);
    sendEvent({ type: 'toast', text: '拖出失败：' + e.message, level: 'warn' });
    return false;
  }
  // Windows 上 startDrag 会阻塞到拖放结束；这里再兜底释放，避免窗口被永久“占用”
  setTimeout(() => {
    busyDrag = false;
  }, 800);
  return true;
}

/* ---------------- 恢复询问 ---------------- */

async function askRestore() {
  const items = store.getItems();
  if (!items.length) return;

  // 测试用：用环境变量代替弹窗（正常启动仍然是对话框）
  const answer = String(process.env.HANGING_ROPE_RESTORE_ANSWER || '').toLowerCase();
  let response;
  if (answer === 'restore') {
    response = 0;
  } else if (answer === 'discard') {
    response = 1;
  } else {
    if (process.env.HANGING_ROPE_AUTOQUIT) return; // 冒烟测试不弹窗
    ({ response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['恢复', '不恢复'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: '悬挂绳',
      message: `上次还挂着 ${items.length} 件内容，要恢复吗？`,
      detail: '选择“不恢复”将清空悬挂记录（缓存的图片稍后可在设置里清理）。',
    }));
  }
  if (response === 1) {
    store.clearItems();
    store.pruneOrphans();
  }
  sendState();
}

/* ---------------- 设置窗口 ----------------
   设置是独立的普通窗口（不是绳索条里的浮层）：
   · 带系统标题栏，右上角有关闭按钮，可缩放、可最小化、不置顶；
   · 在任务栏有独立条目，鼠标移开顶部不会自动消失，可以一直摆着对照着改；
   · 关掉后再次打开复用同一份状态，不残留进程。 */

let settingsWin = null;

function settingsWindowAlive() {
  return !!settingsWin && !settingsWin.isDestroyed();
}

function openSettingsWindow() {
  if (settingsWindowAlive()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    settingsWin.webContents.send('settings:changed');
    return settingsWin;
  }

  const area = screen.getPrimaryDisplay().workArea;
  const width = 620;
  const height = 570;
  settingsWin = new BrowserWindow({
    width,
    height,
    minWidth: 560,
    minHeight: 500,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    title: '悬挂绳 · 设置',
    // 普通窗口：系统边框 + 右上角关闭按钮，没有透明/无边框/置顶这些特性
    frame: true,
    transparent: false,
    backgroundColor: '#15171c',
    resizable: true,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: false,
    hasShadow: true,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => {
    if (!settingsWindowAlive()) return;
    settingsWin.show();
    settingsWin.focus();
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  return settingsWin;
}

function notifySettings() {
  if (settingsWindowAlive()) settingsWin.webContents.send('settings:changed');
}

/* 设置窗口需要的全部数据：设置项 + 缓存占用 + 挂件数 */
function settingsSnapshot() {
  return {
    settings: store.getSettings(),
    usage: store.cacheUsage(),
    itemCount: store.getItems().length,
    copyMode,
  };
}

/* ---------------- 托盘 ---------------- */

function createTray() {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'tray.png'));
  tray = new Tray(icon.isEmpty() ? genericDragIcon() : icon);
  const menu = Menu.buildFromTemplate([
    { label: '显示悬挂绳', click: () => showRope() },
    { label: '设置', click: () => openSettingsWindow() },
    { type: 'separator' },
    { label: '清空全部挂件', click: () => { store.clearItems(); store.pruneOrphans(); sendState(); } },
    { type: 'separator' },
    { label: '退出悬挂绳', click: () => app.quit() },
  ]);
  tray.setToolTip('悬挂绳');
  tray.setContextMenu(menu);
  tray.on('click', () => showRope());
}

/* ---------------- IPC ---------------- */

function sendState() {
  if (win) {
    win.webContents.send('state', {
      items: store.getItems(),
      settings: store.getSettings(),
      copyMode,
    });
  }
  // 设置窗口是独立窗口，挂件数/缓存占用要跟着刷新
  notifySettings();
}

function sendEvent(ev) {
  if (!win) return;
  win.webContents.send('event', ev);
}

function registerIpc() {
  ipcMain.handle('get-state', () => {
    return { items: store.getItems(), settings: store.getSettings(), copyMode };
  });

  ipcMain.on('add-paths', (_e, paths) => addPaths(paths));
  ipcMain.on('add-text', (_e, text) => addTextItem(text));
  ipcMain.on('add-image-url', (_e, payload) => {
    // 兼容旧调用（直接传 url 字符串）与新的 { url, name }
    const url = typeof payload === 'string' ? payload : payload && payload.url;
    const name = typeof payload === 'string' ? '' : payload && payload.name;
    addImageFromUrl(url, name);
  });
  ipcMain.on('add-image-buffer', (_e, payload) => {
    if (!payload) return;
    const bytes = Buffer.from(payload.buf || payload.bytes || payload);
    addImageBuffer(bytes, payload.ext, { mime: payload.mime, name: payload.name });
  });

  ipcMain.on('remove-item', (_e, id) => {
    store.removeItem(id);
    sendState();
  });
  ipcMain.on('reorder', (_e, ids) => store.reorder(ids));
  ipcMain.on('clear-all', () => {
    store.clearItems();
    store.pruneOrphans();
    sendState();
  });

  ipcMain.on('start-drag', (e, payload) => {
    startDrag(payload, e.sender);
  });
  ipcMain.on('drag-ended', () => {
    // 系统级拖拽可能比渲染层事件晚一点结束，留出缓冲避免拖拽中途窗口收回
    setTimeout(() => {
      busyDrag = false;
    }, 400);
  });

  /* 文件夹浏览面板里的 📌：点一下固定，再点一下取消固定（v1.4） */
  ipcMain.handle('pin-path', (_e, p) => pinPath(p));
  ipcMain.handle('unpin-path', (_e, p) => unpinPath(p));

  ipcMain.handle('list-folder', (_e, dir) => {
    try {
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.') && !d.name.startsWith('$'))
        .map((d) => {
          const p = path.join(dir, d.name);
          const st = statSafe(p);
          return {
            name: d.name,
            path: p,
            isDir: d.isDirectory(),
            size: st && !d.isDirectory() ? st.size : null,
            mtime: st ? st.mtimeMs : null,
          };
        })
        .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh-CN'));
      return { ok: true, entries };
    } catch (err) {
      return { ok: false, error: err.message, entries: [] };
    }
  });

  ipcMain.on('hover', (_e, on) => {
    hovering = !!on;
    outsideTicks = 0;
    if (hovering && ropeVisible) registerHoverShortcuts();
    else unregisterHoverShortcuts();
  });
  ipcMain.on('set-remove-mode', (_e, on) => {
    clearTimeout(escReleaseTimer);
    enterRemoveMode(!!on);
  });
  ipcMain.on('busy', (_e, on) => {
    busyDrag = !!on;
    if (on) outsideTicks = 0;
  });
  ipcMain.on('set-height', (_e, h) => {
    const nh = Math.max(BASE_HEIGHT, Math.min(600, h | 0));
    if (nh === ropeHeight) return;
    ropeHeight = nh;
    // 拖放进行中绝不调整窗口尺寸：源窗口在系统拖拽过程中被改变会引发崩溃
    if (busyDrag) return;
    if (ropeVisible) animateY(0, ropeHeight);
    else win.setBounds({ x: winX, y: -ropeHeight, width: winW, height: ropeHeight });
  });

  /* 复制模式 */
  ipcMain.on('set-copy-mode', (_e, on) => setCopyMode(!!on));
  ipcMain.on('toggle-copy-mode', () => setCopyMode(!copyMode));

  /* 手动复制到剪贴板（双击挂件的兜底操作），需更新监听基线避免重复悬挂 */
  ipcMain.on('copy-to-clipboard', (_e, { text, imageCachePath }) => {
    if (typeof text === 'string') {
      clipboard.writeText(text);
      snapshotClipboard();
    } else if (imageCachePath && fs.existsSync(imageCachePath)) {
      clipboard.writeImage(nativeImage.createFromPath(imageCachePath));
      snapshotClipboard();
    }
  });

  /* v1.5：单击复制 / 双击打开，绳上挂件与文件夹面板行共用同一套动作 */
  ipcMain.handle('copy-item', (_e, target) => copyItemToClipboard(target));
  ipcMain.handle('open-item', (_e, target) => openItemTarget(target));

  /* 设置 */
  ipcMain.on('open-settings', () => openSettingsWindow());
  ipcMain.handle('settings:info', () => settingsSnapshot());
  ipcMain.handle('settings:clear-all', () => {
    store.clearItems();
    store.pruneOrphans();
    sendState();
    return store.getItems().length;
  });
  ipcMain.handle('settings:set', (_e, patch) => {
    const before = store.getSettings().hotkey;
    const s = store.setSettings(patch || {});
    if (s.hotkey !== before) registerHotkey();
    sendState();
    return s;
  });
  ipcMain.handle('settings:choose-cache-dir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(settingsWindowAlive() ? settingsWin : win, {
      title: '选择图片缓存目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: store.cacheDir(),
    });
    if (canceled || !filePaths.length) return null;
    const result = store.migrateCache(filePaths[0]);
    sendState();
    return result;
  });
  ipcMain.handle('cache:usage', () => store.cacheUsage());
  ipcMain.handle('cache:clear', () => {
    const n = store.clearCache();
    sendState();
    return n;
  });
  ipcMain.handle('cache:prune', () => {
    const n = store.pruneOrphans();
    sendState();
    return n;
  });

  ipcMain.on('reveal-item', (_e, p) => {
    if (p && fs.existsSync(p)) shell.showItemInFolder(p);
  });
  ipcMain.on('quit-app', () => app.quit());
}

/* ---------------- 全局快捷键（复制即悬挂） ---------------- */

let hotkeyAccel = '';

function registerHotkey() {
  try {
    if (hotkeyAccel) globalShortcut.unregister(hotkeyAccel);
  } catch {
    /* ignore */
  }
  hotkeyAccel = store.getSettings().hotkey || 'CommandOrControl+Alt+H';
  try {
    const ok = globalShortcut.register(hotkeyAccel, () => setCopyMode(!copyMode));
    if (!ok) hotkeyAccel = '';
  } catch {
    hotkeyAccel = '';
  }
}

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(async () => {
  store.load();
  healShortcuts();
  // 旧版本把 SVG 存成了 .svgxml 这类错误扩展名，界面上就是破图；启动时按字节纠正
  const healedImages = store.healImageExtensions();
  if (healedImages) console.log('[hanging-rope] healed image extensions: ' + healedImages);
  createWindow();
  createTray();
  registerIpc();
  registerHotkey();
  startEdgeWatcher();
  win.webContents.once('did-finish-load', async () => {
    sendState();
    await askRestore();
  });

  // 冒烟测试用：设置环境变量后自动退出
  const autoQuitMs = parseInt(process.env.HANGING_ROPE_AUTOQUIT || '', 10);
  if (autoQuitMs > 0) setTimeout(() => app.quit(), autoQuitMs);
  // 调试用：强制常显悬浮窗，并截取窗口内容供检查
  if (process.env.HANGING_ROPE_DEBUG_SHOW) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => showRope(), 400);
      // 调试：模拟按住第一张卡横向排序，采样卡片透明度与动画状态，
      // 用于验证“拖动时闪烁”（动画重播）是否已修复
      if (process.env.HANGING_ROPE_DEBUG_DRAG) {
        setTimeout(async () => {
          const y = 92;
          win.webContents.sendInputEvent({ type: 'mouseDown', x: 90, y, button: 'left', clickCount: 1 });
          await new Promise((r) => setTimeout(r, 260)); // 等 0.15s 抬起
          const samples = [];
          for (const x of [140, 210, 290, 370, 300, 220, 150, 100]) {
            win.webContents.sendInputEvent({ type: 'mouseMove', x, y, button: 'left' });
            await new Promise((r) => setTimeout(r, 70));
            const s = await win.webContents.executeJavaScript(`(() => {
              const el = document.querySelector('.item.lifting');
              if (!el) return { lifting: false };
              return {
                lifting: true,
                opacity: getComputedStyle(el).opacity,
                anims: el.getAnimations().map((a) => (a.animationName || a.transitionProperty || '?') + ':' + a.playState).join('|'),
                order: [...document.querySelectorAll('.item')].map((n) => n.dataset.id).join(','),
              };
            })()`);
            samples.push({ x, ...s });
            if (x === 140 || x === 290 || x === 220) {
              try {
                const img = await win.webContents.capturePage({ x: 0, y: 0, width: winW, height: ropeHeight });
                fs.writeFileSync(path.join(app.getAppPath(), '.test', `drag-${x}.png`), img.toPNG());
              } catch {
                /* ignore */
              }
            }
          }
          win.webContents.sendInputEvent({ type: 'mouseUp', x: 100, y, button: 'left', clickCount: 1 });
          fs.writeFileSync(path.join(app.getAppPath(), '.test', 'drag.json'), JSON.stringify(samples, null, 2));
        }, 1400);
      }
      // 调试：直接对文件夹挂件派发 mouseenter 以展开浏览面板（不依赖坐标）
      if (process.env.HANGING_ROPE_DEBUG_HOVER_FOLDER) {
        setTimeout(() => {
          win.webContents.executeJavaScript(`(() => {
            const el = [...document.querySelectorAll('.item')].find((n) => n.classList.contains('t-folder'));
            if (el) el.dispatchEvent(new MouseEvent('mouseenter'));
            return !!el;
          })()`).catch(() => {});
        }, 1200);
      }
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage({ x: 0, y: 0, width: winW, height: 400 });
          fs.writeFileSync(
            path.join(app.getAppPath(), '.test', 'window.png'),
            img.toPNG()
          );
        } catch (e) {
          console.error('capture failed:', e);
        }
      }, 2500);
    });
  }
});

app.on('before-quit', () => {
  quiting = true;
  stopClipWatcher();
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }
  store.saveNow();
});

app.on('will-quit', () => {
  quiting = true;
});

app.on('window-all-closed', () => {
  if (quiting) app.quit();
});

/* ---------------- 测试出口 ----------------
   仅在设置了独立测试数据目录时暴露：让 Electron 内的场景测试可以直接驱动
   “唤出/收回、粘贴悬挂、拖出计划”等内部动作，而不必依赖真实鼠标与系统拖放。
   生产启动（无 HANGING_ROPE_TEST_USERDATA）时这里完全不生效。 */
if (process.env.HANGING_ROPE_TEST_USERDATA) {
  module.exports.__test = {
    showRope,
    hideRope,
    onPastePressed,
    addPaths,
    addTextItem,
    addImageBuffer,
    addImageFromUrl,
    planDrag,
    dragLog,
    openLog,
    copyItemToClipboard,
    openItemTarget,
    openSettingsWindow,
    getWindow: () => win,
    getSettingsWindow: () => settingsWin,
    settingsSnapshot,
    snapshot: () => ({
      ropeVisible,
      ropeHeight,
      removeMode,
      busyDrag,
      hovering,
      copyMode,
      bounds: win ? win.getBounds() : null,
      items: store.getItems(),
      settings: store.getSettings(),
    }),
  };
}
