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
const dedupe = require('./dedupe');

/* ---------------- 常量 ---------------- */
const BASE_HEIGHT = 210; // 常规高度（文件夹浏览面板展开时由渲染层调到 370）
const EDGE_TRIGGER_PX = 2; // 触顶判定
const HIDE_GRACE_TICKS = 3; // 连续离开多少个轮询周期后收回
const POLL_MS = 60;
const CLIP_POLL_MS = 700;
const MAX_CLIP_IMAGE_BYTES = 20 * 1024 * 1024;

/* 设置窗口的原生底色：先于 CSS 绘制，避免深色主题启动时闪一下白。
   绳索主窗口是 transparent，不需要这一层。 */
const THEME_NATIVE_BG = { light: '#f4f7fb', dark: '#1b1f28' };
function nativeThemeBg() {
  return THEME_NATIVE_BG[store.getSettings().theme] || THEME_NATIVE_BG.light;
}

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
let ropeThickness = BASE_HEIGHT; // 窗口厚度（顶部/底部=高度，左右=宽度）；文件夹面板展开时由渲染层调到 410
let ropePos = 'top'; // 停靠边（v1.14），与 store.settings.ropePosition 同步
let ropeGeom = null; // { shown, hidden } 由 computeRopeGeometry 按当前停靠边与厚度算出
let outsideTicks = 0;
let animToken = 0; // 动画令牌：新动画打断旧动画
let busyDrag = false; // 拖拽进行中禁止收回
let hovering = false; // 渲染层报告鼠标在内容上
let removeMode = false;
let summonPending = false; // 显式唤出（托盘等）后待指针首次进入窗口（v1.20d）

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
  app.on('second-instance', () => showRope({ explicit: true }));
}

app.setAppUserModelId('com.local.hangingrope');

/* ---------------- 悬浮窗 ---------------- */

function createWindow() {
  ropePos = geo.normalizePosition(store.getSettings().ropePosition);
  ropeGeom = computeRopeGeometry();

  win = new BrowserWindow({
    x: ropeGeom.hidden.x,
    y: ropeGeom.hidden.y,
    width: ropeGeom.hidden.width,
    height: ropeGeom.hidden.height,
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
  // 主题随 URL 一并交给渲染层：head 里的 theme.js 在 CSS 生效前就设好
  // <html data-theme>，深色启动不会先闪一帧浅色；停靠位置同理（data-pos）。
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: {
      theme: store.getSettings().theme || 'light',
      pos: ropePos,
    },
  });

  win.on('closed', () => {
    win = null;
  });
  win.on('focus', updateEscapeRegistration);
  win.on('blur', updateEscapeRegistration);
}

/* 按当前停靠边与厚度重算窗口几何（shown = 贴边可见，hidden = 挪出屏幕外） */
function computeRopeGeometry() {
  const display = screen.getPrimaryDisplay();
  return geo.computeRopeBounds(display.bounds, display.workArea, ropeThickness, ropePos);
}

/* 从当前 bounds 弹簧滑到目标 bounds（§3/§4：临界阻尼弹簧，无回弹）。
   v1.19 之前是固定 150ms easeOutCubic —— 中途反向时缓动从头重启，
   速度先骤停再加速，有"撞墙感"；弹簧跨 re-target 连续：
   x / y 各自独立积分（§3 二维运动拆两个一维弹簧），速度保存在模块级，
   新目标从当前值 + 当前速度继续，中断天然平滑。步进用真实 dt 的
   半隐式欧拉，收敛（距离 < 0.5px 且速度 < 8px/s）后贴齐并清零速度。 */
const SPRING_RESPONSE = 0.15; // 秒：越小越"跟手"（0.15 ≈ 旧版 150ms easeOut 的节奏）
const SPRING_DAMPING = 1.0; // 1.0 = 临界阻尼（§4：默认 UI 不回弹）
let animVel = { x: 0, y: 0 };

function animateBounds(target, done) {
  const token = ++animToken;
  const b = win.getBounds();
  const pos = { x: b.x, y: b.y };
  const tgt = { x: target.x, y: target.y };
  const vel = { ...animVel };
  const k = Math.pow((2 * Math.PI) / SPRING_RESPONSE, 2); // 刚度（质量 = 1）
  const c = 2 * SPRING_DAMPING * Math.sqrt(k); // 阻尼系数
  let last = Date.now();
  const step = () => {
    if (!win || token !== animToken) return;
    const now = Date.now();
    const dt = Math.min(0.032, Math.max(0.004, (now - last) / 1000));
    last = now;
    vel.x += (-k * (pos.x - tgt.x) - c * vel.x) * dt;
    vel.y += (-k * (pos.y - tgt.y) - c * vel.y) * dt;
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    const settled =
      Math.abs(pos.x - tgt.x) < 0.5 &&
      Math.abs(pos.y - tgt.y) < 0.5 &&
      Math.abs(vel.x) < 8 &&
      Math.abs(vel.y) < 8;
    if (settled) {
      pos.x = tgt.x;
      pos.y = tgt.y;
      vel.x = 0;
      vel.y = 0;
    }
    animVel = { x: vel.x, y: vel.y };
    try {
      win.setBounds({ x: Math.round(pos.x), y: Math.round(pos.y), width: target.width, height: target.height });
    } catch {
      /* ignore */
    }
    if (settled) {
      if (done) done();
      return;
    }
    setTimeout(step, 8);
  };
  step();
}

function showRope(opts) {
  if (!win || ropeVisible) return;
  ropeVisible = true;
  outsideTicks = 0;
  /* 显式唤出（托盘点击 / 托盘菜单 / 二次启动）：等指针来过窗口一次才开始
     自动收回判定。否则点击"显示悬挂绳"时光标还在屏幕角落的托盘上，
     3 个轮询周期（约 180ms）后绳就被"离开收回"吞掉——闪一下就没（v1.20d）。 */
  summonPending = !!(opts && opts.explicit);
  ropeGeom = computeRopeGeometry(); // 厚度可能刚被文件夹面板改过
  animateBounds(ropeGeom.shown);
  sendEvent({ type: 'shown' });
}

function hideRope(force = false) {
  if (!win || !ropeVisible) return;
  if (busyDrag && !force) return;
  ropeVisible = false;
  summonPending = false;
  removeMode = false;
  clearTimeout(escReleaseTimer);
  unregisterHoverShortcuts();
  sendEvent({ type: 'hidden', removeMode });
  animateBounds(ropeGeom.hidden);
}

/* 鼠标轮询：贴当前停靠边唤出；离开窗口一段时间后收回 */
let edgeTicks = 0; // 屏幕边缘连续停留计数（防误触：掠过不唤出）

/* 单个轮询周期。injectedPoint 仅测试用（冻结轮询时由用例直接驱动）。 */
function edgeWatchTick(injectedPoint) {
  if (!win || !ropeGeom) return;
  const p = injectedPoint || screen.getCursorScreenPoint();
  const display = screen.getPrimaryDisplay();

  if (!ropeVisible) {
    const hit = geo.isEdgeHit(p, display.bounds, display.workArea, ropeGeom.shown, ropePos, EDGE_TRIGGER_PX);
    const step = geo.nextEdgeTicks(edgeTicks, hit, 2);
    edgeTicks = step.ticks;
    if (step.show) showRope();
    return;
  }

  // 可见状态：判断是否离开
  if (process.env.HANGING_ROPE_DEBUG_SHOW) return; // 调试常显
  const r = geo.autoHideTick(p, win.getBounds(), hovering, busyDrag, summonPending, outsideTicks, HIDE_GRACE_TICKS);
  summonPending = r.summonPending;
  outsideTicks = r.outsideTicks;
  if (r.hide) hideRope();
}

function startEdgeWatcher() {
  // 测试用：冻结轮询，由测试脚本显式调用 showRope/hideRope/edgeWatchTick，避免真实光标位置干扰
  if (process.env.HANGING_ROPE_TEST_FREEZE_WATCHER) return;
  setInterval(() => edgeWatchTick(), POLL_MS);
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
 * force=true 表示用户主动按了 Ctrl+V（忽略"连续相同内容"的监听基线）。
 * 无论是否 force，都要过统一判重：绳上已有同一件内容就不再挂第二张。
 * 基线在判重前先更新，避免监听轮询每轮都重复弹提示。
 */
function hangFromClipboard(force = false) {
  // 满额时直接返回 limit：轮询（force=false）静默，避免每 200ms 刷一次提示；
  // 用户主动 Ctrl+V 由 onPastePressed 统一给出原因。
  if (!freeSlots()) return { ok: false, reason: 'limit' };

  /* 1) 文件 / 文件夹（资源管理器复制） */
  const files = readClipboardFiles();
  if (files.length) {
    const sig = 'files:' + files.join('|').toLowerCase();
    if (!force && sig === lastClipFileSig) return { ok: false, reason: 'same' };
    lastClipFileSig = sig;
    lastClipText = '';
    lastClipImageHash = '';
    const fresh = files.filter((f) => !duplicateOf({ type: 'file', path: f }));
    if (!fresh.length) {
      sendEvent({ type: 'toast', text: '已在绳上，未重复添加', level: 'ok' });
      return { ok: false, reason: 'same' };
    }
    let report = null;
    const added = addPaths(fresh, { silent: true, report: (r) => { report = r; } });
    if (added.length) {
      const dup = (report && report.skipped) || 0;
      const lim = (report && report.blocked) || 0;
      const text = lim
        ? `已悬挂 ${added.length} 件，另有 ${lim} 件超出 ${itemLimit()} 件上限`
        : dup
        ? `已悬挂 ${added.length} 件，跳过 ${dup} 个重复项`
        : '已悬挂剪贴板文件';
      sendEvent({ type: 'toast', text, level: lim ? 'warn' : 'ok' });
      return { ok: true };
    }
    if (report && report.blocked) {
      warnLimit(report.blocked);
      return { ok: false, reason: 'limit' };
    }
    return { ok: false, reason: 'failed' };
  }

  /* 2) 文字（Excel/Word 复制常同时携带图片，优先按文字处理） */
  const text = clipboard.readText();
  if (text && text.trim()) {
    if (!force && text === lastClipText) return { ok: false, reason: 'same' };
    lastClipText = text;
    lastClipImageHash = '';
    lastClipFileSig = '';
    if (duplicateOf({ type: 'text', text })) {
      sendEvent({ type: 'toast', text: '这段文字已经挂在绳上了', level: 'ok' });
      return { ok: false, reason: 'same' };
    }
    const item = addTextItem(text, true, { silent: true });
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
  lastClipImageHash = h;
  lastClipText = '';
  lastClipFileSig = '';
  const png = img.toPNG();
  if (png.length > MAX_CLIP_IMAGE_BYTES) {
    sendEvent({ type: 'toast', text: '剪贴板图片过大，未悬挂', level: 'warn' });
    return { ok: false, reason: 'too-big' };
  }
  if (duplicateOf({ type: 'image', buf: png })) {
    sendEvent({ type: 'toast', text: '这张图片已经在绳上了', level: 'ok' });
    return { ok: false, reason: 'same' };
  }
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
      : r.reason === 'limit'
      ? limitText()
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

function addTextItem(text, fromWatcher = false, opts = {}) {
  const t = String(text || '');
  if (!t.trim()) return null;

  // 看起来像本地路径 → 直接按文件/文件夹悬挂（去重交给 addPaths 统一处理）
  const asPath = looksLikePath(t);
  if (asPath && statSafe(asPath)) {
    return addPaths([asPath], opts)[0] || null;
  }

  if (duplicateOf({ type: 'text', text: t })) {
    if (!opts.silent) sendEvent({ type: 'toast', text: '这段文字已经挂在绳上了', level: 'ok' });
    return null;
  }

  if (t.length > store.MAX_TEXT_CHARS) {
    sendEvent({ type: 'toast', text: `文字太长（>${Math.round(store.MAX_TEXT_CHARS / 1000)}KB），建议保存为文件再拖`, level: 'warn' });
    return null;
  }
  if (!freeSlots()) {
    warnLimit();
    return null;
  }
  const item = store.addItem({ id: store.newId(), type: 'text', text: t, addedAt: Date.now() });
  if (!item) {
    warnLimit();
    return null;
  }
  sendState();
  if (!fromWatcher && !opts.silent) sendEvent({ type: 'toast', text: '已悬挂文字', level: 'ok' });
  return item;
}

/* ---------------- 新增挂件 ---------------- */

/* 挂件件数上限（v1.12）：设置里给 6 个档位，默认 300。
   所有新增入口统一走 freeSlots() 预检查，给用户一条能看懂的提示；
   store.addItem 里还有最后一道兜底，任何路径都绕不过去。 */
function itemLimit() {
  return store.getSettings().itemLimit;
}

function freeSlots() {
  return Math.max(0, itemLimit() - store.getItems().length);
}

function limitText(blocked = 0) {
  return blocked
    ? `已达上限 ${itemLimit()} 件，跳过 ${blocked} 件（可在设置里调整）`
    : `已达上限 ${itemLimit()} 件，未添加（可在设置里调整）`;
}

function warnLimit(blocked = 0) {
  sendEvent({ type: 'toast', text: limitText(blocked), level: 'warn' });
}

/**
 * 统一判重入口：所有挂件添加路径（拖入 / 复制即悬挂 / Ctrl+V / 文字路径 /
 * 📌 固定 / 网页图片）都走这里，保证"什么算同一件"只有一套规则。
 */
function duplicateOf(candidate) {
  if (candidate && candidate.type === 'image') ensureImageHashes();
  return dedupe.findDuplicate(store.getItems(), candidate);
}

/**
 * 老版本图片挂件没有内容指纹，判重时读一次缓存副本补上。
 * 只补能读到的文件；读不到的（失效挂件）保持原样，由 cachePath 兜底键处理。
 */
function ensureImageHashes() {
  let changed = false;
  for (const it of store.getItems()) {
    if (it.type !== 'image' || it.hash || !it.cachePath) continue;
    try {
      it.hash = dedupe.contentHash(fs.readFileSync(it.cachePath));
      changed = true;
    } catch {
      /* 副本已丢失：保持无 hash，不阻塞后续添加 */
    }
  }
  if (changed) store.save();
  return changed;
}

/**
 * 启动自愈：合并旧版本已经挂上绳的重复挂件（截图里那两张一模一样的图）。
 * 保留最早的一张、顺序不变；被摘掉的图片副本交给 pruneOrphans 回收。
 * 此时窗口还没创建，只改 state，随后 did-finish-load 会把结果推给渲染层。
 */
function healDuplicates() {
  ensureImageHashes();
  const { kept, removed } = dedupe.collapseDuplicates(store.getItems());
  if (!removed.length) return 0;
  store.replaceItems(kept);
  if (removed.some((it) => it.type === 'image')) store.pruneOrphans();
  console.log('[hanging-rope] merged duplicate items: ' + removed.length);
  return removed.length;
}

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

/**
 * 把文件/文件夹路径挂上绳（拖入、剪贴板文件、Ctrl+V、文字路径都走这里）。
 * 同一目标 — 大小写/斜杠/末尾分隔符变体、.lnk 与其本体 — 只保留一张；
 * 重复项跳过并提示，但不影响同一批里其它新目标的添加。
 * v1.12：一次批量最多挂到 settings.itemLimit 为止，超出的部分跳过并单独提示，
 * 不会"整批失败"；opts.report 供剪贴板监听自己汇总提示用。
 * @param {string[]} pathList
 * @param {{silent?:boolean, report?:function}} opts silent 供剪贴板监听自己汇总提示
 */
function addPaths(pathList, opts = {}) {
  const added = [];
  let skipped = 0;
  let blocked = 0;
  let slots = freeSlots();
  const seen = new Set(); // 同一次批量里也可能出现等价变体
  for (const raw of pathList || []) {
    if (!raw) continue;
    const resolved = resolveShortcut(raw);
    const p = resolved.path;
    const st = statSafe(p);
    if (!st) {
      sendEvent({ type: 'toast', text: `无法读取：${p}`, level: 'warn' });
      continue;
    }
    const isDir = st.isDirectory();
    const candidate = { type: isDir ? 'folder' : 'file', path: p };
    const key = dedupe.candidateKey(candidate);
    if ((key && seen.has(key)) || duplicateOf(candidate)) {
      skipped++;
      continue;
    }
    // 判重之后才占名额：重复项不该消耗件数上限
    if (slots <= 0) {
      blocked++;
      continue;
    }
    if (key) seen.add(key);
    const item = store.addItem({
      id: store.newId(),
      type: isDir ? 'folder' : 'file',
      path: p,
      name: path.basename(p) || p,
      shortcut: resolved.shortcut || undefined,
      addedAt: Date.now(),
    });
    if (!item) {
      // store 层兜底（例如状态刚被其它入口改动）
      blocked++;
      continue;
    }
    slots--;
    added.push(item);
  }
  if (skipped && !opts.silent) {
    sendEvent({
      type: 'toast',
      text: skipped === 1 ? '已在绳上，未重复添加' : `已跳过 ${skipped} 个重复项`,
      level: 'ok',
    });
  }
  if (blocked && !opts.silent) warnLimit(blocked);
  if (typeof opts.report === 'function') opts.report({ added: added.length, skipped, blocked });
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

  // 与拖入 / 复制即悬挂共用同一套判重规则（v1.6）
  const existing = duplicateOf({ type: st.isDirectory() ? 'folder' : 'file', path: p });
  if (existing) {
    return { ok: true, already: true, id: existing.id, name: existing.name };
  }
  if (!freeSlots()) {
    return {
      ok: false,
      reason: 'limit',
      message: `已达上限 ${itemLimit()} 件，请先取下部分挂件或在设置里调高上限`,
    };
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
  if (!item) {
    return { ok: false, reason: 'limit', message: limitText() };
  }
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

  // 判重必须在写缓存之前：同一张图片不再生成第二份副本（v1.6）。
  // 指纹取落盘的真实字节，剪贴板图片 / 网页图片 / 拖入图片只要字节相同就算同一件。
  const hash = dedupe.contentHash(bytes);
  if (duplicateOf({ type: 'image', buf: bytes })) {
    if (!opts.silent) sendEvent({ type: 'toast', text: '这张图片已经在绳上了', level: 'ok' });
    return null;
  }
  // 上限检查必须早于写缓存：满额时不能白白留下一份没有挂件引用的图片副本
  if (!freeSlots()) {
    warnLimit();
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
    hash,
    width: size.width,
    height: size.height,
    bytes: bytes.length,
    addedAt: Date.now(),
  });
  if (!item) {
    warnLimit();
    return null;
  }
  checkCacheLimit();
  sendState();
  if (!opts.fromWatcher && !opts.silent) {
    sendEvent({ type: 'toast', text: '已悬挂图片', level: 'ok' });
  }
  return item;
}

/** 从网页拖图片进来：解析出图片地址后下载缓存（这是工具唯一的联网动作，仅发生在用户主动拖拽网页图片时） */
async function addImageFromUrl(url, hintName) {
  // 先把上限挡在最前面，避免满额时还去联网下载一张注定挂不上的图
  if (!freeSlots()) {
    warnLimit();
    return null;
  }
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

/**
 * 读取随包携带的图片资源。
 * 打包后 assets 位于 app.asar 内部，nativeImage.createFromPath 走原生文件读取、
 * 读不到 asar 里的条目；改用被 Electron 打过补丁的 fs + createFromBuffer，
 * 开发态（普通目录）与发布态（asar）都能取到图标。
 * @param {string} name assets/ 下的文件名
 * @returns {Electron.NativeImage|null}
 */
function appAssetImage(name) {
  try {
    const file = path.join(app.getAppPath(), 'assets', name);
    const img = nativeImage.createFromBuffer(fs.readFileSync(file));
    return img.isEmpty() ? null : img;
  } catch {
    return null;
  }
}

function genericDragIcon() {
  return appAssetImage('tray.png') || nativeImage.createEmpty();
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
  // v1.16 多选整组拖出：files 数组一次带出，插入端按数组顺序逐一插入
  if (payload && payload.kind === 'multi') return startMultiDrag(payload.list, sender);
  const plan = planDrag(payload);
  if (plan.warning) {
    sendEvent({ type: 'toast', text: plan.warning, level: 'warn' });
  }
  if (!plan.ok) {
    if (!plan.warning) sendEvent({ type: 'toast', text: '无法拖出', level: 'warn' });
    sendEvent({ type: 'drag-ended' }); // 渲染层已先置位 nativeDrag，失败路径立刻解除
    return false;
  }

  let icon = plan.icon || genericDragIcon();
  if (!icon || icon.isEmpty()) icon = appAssetImage('icon.png') || nativeImage.createEmpty();

  busyDrag = true;
  if (process.env.HANGING_ROPE_TEST_DRY_DRAG) {
    dragLog.push({ at: Date.now(), target: plan.target, kind: plan.kind, warning: plan.warning });
    setTimeout(() => {
      busyDrag = false;
      sendEvent({ type: 'drag-ended' }); // 干跑也走同一事件，测试与真实路径一致
    }, 300);
    return true;
  }
  try {
    sender.startDrag({ file: plan.target, icon });
  } catch (e) {
    busyDrag = false;
    logLine('startDrag error: ' + e.message);
    sendEvent({ type: 'toast', text: '拖出失败：' + e.message, level: 'warn' });
    sendEvent({ type: 'drag-ended' });
    return false;
  }
  // 拖放已结束（Windows 上 startDrag 阻塞到 drop 完成）：
  // 立刻通知渲染层解除 ui.nativeDrag —— 用户把文件拖回来想马上排序时，
  // 不能再被 2.5s 保护窗把 pointerdown 全部拒掉（v1.20 修复）。
  sendEvent({ type: 'drag-ended' });
  // 这里再兜底释放，避免窗口被永久“占用”
  setTimeout(() => {
    busyDrag = false;
  }, 800);
  return true;
}

/* v1.16 多选整组拖出：逐项校验（文字 / 源丢失自动跳过并提示），
   可插入的按绳上顺序组成 files 数组，一次系统拖放全部带出 */
function startMultiDrag(list, sender) {
  const plan = dragPlan.planMultiDrag(list, {
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
  if (plan.skipped) {
    sendEvent({ type: 'toast', text: `已跳过 ${plan.skipped} 件不可插入的对象`, level: 'warn' });
  }
  if (!plan.ok) {
    if (!plan.skipped) sendEvent({ type: 'toast', text: '选中的对象都无法插入', level: 'warn' });
    sendEvent({ type: 'drag-ended' }); // 渲染层已先置位 nativeDrag，失败路径立刻解除
    return false;
  }

  let icon = appAssetImage('icon.png') || genericDragIcon();
  if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty();

  busyDrag = true;
  if (process.env.HANGING_ROPE_TEST_DRY_DRAG) {
    dragLog.push({ at: Date.now(), target: plan.targets, kind: 'multi', warning: '', skipped: plan.skipped });
    setTimeout(() => {
      busyDrag = false;
      sendEvent({ type: 'drag-ended' });
    }, 300);
    return true;
  }
  try {
    sender.startDrag({ files: plan.targets, icon });
  } catch (e) {
    busyDrag = false;
    logLine('startDrag(multi) error: ' + e.message);
    sendEvent({ type: 'toast', text: '拖出失败：' + e.message, level: 'warn' });
    sendEvent({ type: 'drag-ended' });
    return false;
  }
  // 同单件拖出：拖放结束立刻通知渲染层解除 nativeDrag（v1.20 修复）
  sendEvent({ type: 'drag-ended' });
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
  /* 四张卡片（外观 / 图片缓存 / 悬挂绳 / 关于）加上头部与底部操作栏，内容自然
     高度约 790 DIP（v2.0.0 新增「关于」卡片后再加 60）。这里给足高度并按
     工作区兜底，小屏幕也不会把窗口顶出屏幕（AC-94 / AC-116 一屏约束）。 */
  const height = Math.min(830, Math.max(560, area.height - 40));
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
    backgroundColor: nativeThemeBg(),
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
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'), {
    query: { theme: store.getSettings().theme || 'light' },
  });
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
  if (!settingsWindowAlive()) return;
  // 主题切换时连窗口的原生底色一起换，避免缩放/滚动露出浅色底边
  if (typeof settingsWin.setBackgroundColor === 'function') {
    settingsWin.setBackgroundColor(nativeThemeBg());
  }
  settingsWin.webContents.send('settings:changed');
}

/* 设置窗口需要的全部数据：设置项 + 缓存占用 + 挂件数 + 应用版本（v2.0.0「关于」卡片） */
function settingsSnapshot() {
  return {
    settings: store.getSettings(),
    usage: store.cacheUsage(),
    itemCount: store.getItems().length,
    copyMode,
    version: app.getVersion(),
  };
}

/* ---------------- 停靠位置（v1.14） ----------------
   切换即时生效：重算几何 → 立即放到新边的可见/隐藏位置 → 托盘单选同步。
   渲染层布局由 sendState 推送的 settings.ropePosition 驱动（app.js 设 data-pos）。 */
function applyRopePosition(pos) {
  const next = geo.normalizePosition(pos);
  if (next !== ropePos) {
    ropePos = next;
    ropeGeom = computeRopeGeometry();
    if (win) {
      if (ropeVisible) animateBounds(ropeGeom.shown);
      else win.setBounds(ropeGeom.hidden);
    }
  }
  refreshTrayMenu();
}

/* ---------------- 托盘 ---------------- */

const POS_LABELS = { top: '顶部', left: '左侧', right: '右侧', bottom: '底部' };

function buildTrayTemplate() {
  return [
    { label: '显示悬挂绳', click: () => showRope({ explicit: true }) },
    { label: '设置', click: () => openSettingsWindow() },
    {
      label: '停靠位置',
      submenu: geo.POSITIONS.map((p) => ({
        label: POS_LABELS[p],
        type: 'radio',
        checked: ropePos === p,
        click: () => {
          store.setSettings({ ropePosition: p });
          applyRopePosition(p);
          sendState();
        },
      })),
    },
    { type: 'separator' },
    { label: '清空全部挂件', click: () => { store.clearItems(); store.pruneOrphans(); sendState(); } },
    { type: 'separator' },
    { label: '退出悬挂绳', click: () => app.quit() },
  ];
}

function createTray() {
  const icon = appAssetImage('tray.png') || genericDragIcon();
  tray = new Tray(icon);
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate()));
  tray.setToolTip('悬挂绳');
  tray.on('click', () => showRope({ explicit: true }));
}

/* 停靠位置变化后重建菜单，让单选勾随实际状态走 */
function refreshTrayMenu() {
  if (!tray) return;
  try {
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate()));
  } catch {
    /* ignore */
  }
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
    if (nh === ropeThickness) return;
    ropeThickness = nh;
    // 拖放进行中绝不调整窗口尺寸：源窗口在系统拖拽过程中被改变会引发崩溃
    if (busyDrag) return;
    ropeGeom = computeRopeGeometry();
    if (ropeVisible) animateBounds(ropeGeom.shown);
    else win.setBounds(ropeGeom.hidden);
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
    const before = store.getSettings();
    const s = store.setSettings(patch || {});
    if (s.hotkey !== before.hotkey) registerHotkey();
    if (s.ropePosition !== before.ropePosition) applyRopePosition(s.ropePosition);
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
  // 旧版本没有统一去重，绳上可能已经挂着两张一模一样的卡片；启动时合并成一张
  healDuplicates();
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
                const b0 = win.getBounds();
                const img = await win.webContents.capturePage({ x: 0, y: 0, width: b0.width, height: b0.height });
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
          const img = await win.webContents.capturePage({ x: 0, y: 0, width: win.getBounds().width, height: 400 });
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
    edgeWatchTick,
    onPastePressed,
    addPaths,
    addTextItem,
    addImageBuffer,
    addImageFromUrl,
    healDuplicates,
    ensureImageHashes,
    /* 模拟旧版本遗留的重复挂件（绕过产品入口的去重），供 AC-50 等回归用例构造前置数据 */
    injectRawItems: (items) => {
      const arr = store.getItems();
      for (const raw of items || []) arr.push({ ...raw });
      store.save();
      sendState();
      return arr.length;
    },
    planDrag,
    dragLog,
    openLog,
    copyItemToClipboard,
    openItemTarget,
    openSettingsWindow,
    applyRopePosition,
    buildTrayTemplate,
    getWindow: () => win,
    getSettingsWindow: () => settingsWin,
    settingsSnapshot,
    snapshot: () => ({
      ropeVisible,
      ropeThickness,
      ropePos,
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
