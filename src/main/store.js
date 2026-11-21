/**
 * 悬挂绳 —— 数据持久化与图片缓存
 * state.json 原子写入；图片缓存目录可由用户指定，带总量上限与孤儿清理。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const imageFormat = require('./image-format');

/* Electron 的 app 只在主进程可用。
   这里做惰性探测，让 store 能在纯 Node 下（单元测试）直接跑：
   解析顺序 HANGING_ROPE_USERDATA → app.getPath('userData') → 系统临时目录。 */
let electronApp = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object' && electron.app) electronApp = electron.app;
} catch {
  /* 纯 Node 环境：无 Electron */
}

function userDataDir() {
  const override = process.env.HANGING_ROPE_USERDATA;
  if (override) return override;
  if (electronApp && typeof electronApp.getPath === 'function') {
    try {
      return electronApp.getPath('userData');
    } catch {
      /* app 尚未 ready 等情况 */
    }
  }
  return path.join(os.tmpdir(), 'hanging-rope-userdata');
}

const MAX_TEXT_CHARS = 50000; // 单条文字上限（约几十 KB）

/* 主题白名单：只认这两个值，任何脏数据（旧版字段、手改 state.json、
   非法 IPC 入参）都归一成浅色，绝不把未知字符串写进设置。 */
const THEMES = ['light', 'dark'];
function normalizeTheme(v) {
  return THEMES.includes(v) ? v : 'light';
}

/* 挂件件数上限（v1.12）：只认这 6 个档位，默认 300。
   与主题一样，手改 state.json 的脏数据归一为默认值，而非法 IPC 入参
   在 setSettings 里直接忽略（不覆盖用户已有选择）。 */
const ITEM_LIMITS = [200, 300, 350, 400, 450, 500];
const DEFAULT_ITEM_LIMIT = 300;
function normalizeItemLimit(v) {
  return ITEM_LIMITS.includes(v) ? v : DEFAULT_ITEM_LIMIT;
}

/* 停靠位置（v1.14）：只认这 4 个值，默认 top。
   旧版 state.json 没有该字段 → load 时归一为 top，行为与升级前完全一致。 */
const ROPE_POSITIONS = ['top', 'left', 'right', 'bottom'];
function normalizeRopePosition(v) {
  return ROPE_POSITIONS.includes(v) ? v : 'top';
}

const DEFAULT_SETTINGS = {
  cacheDir: '', // 空 = 使用默认目录
  cacheLimitMB: 200,
  hotkey: 'CommandOrControl+Alt+H',
  theme: 'light', // v1.10：浅色为默认，用户可在设置里切到深色
  itemLimit: DEFAULT_ITEM_LIMIT, // v1.12：绳上挂件数上限，设置里可调
  ropePosition: 'top', // v1.14：绳子停靠的屏幕边缘
};

let state = { version: 1, items: [], settings: { ...DEFAULT_SETTINGS } };
let saveTimer = null;
let lastError = null;

function stateFile() {
  return path.join(userDataDir(), 'state.json');
}

function defaultCacheDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'HangingRope', 'cache');
}

function cacheDir() {
  const dir = state.settings.cacheDir && state.settings.cacheDir.trim();
  return dir || defaultCacheDir();
}

function newId() {
  return crypto.randomUUID();
}

function isFileItem(it) {
  return it.type === 'file' || it.type === 'folder';
}

function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const base = { id: raw.id || newId(), type: raw.type, addedAt: raw.addedAt || Date.now() };
  if (raw.type === 'file' || raw.type === 'folder') {
    const it = { ...base, type: raw.type, path: String(raw.path || ''), name: String(raw.name || '') };
    if (raw.shortcut) it.shortcut = String(raw.shortcut); // 由 .lnk 解析而来时记录原始快捷方式
    return it;
  }
  if (raw.type === 'text') {
    let text = String(raw.text || '');
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
    return { ...base, type: 'text', text };
  }
  if (raw.type === 'image') {
    const it = {
      ...base,
      type: 'image',
      cachePath: String(raw.cachePath || ''),
      name: String(raw.name || '图片'),
      width: Number.isFinite(raw.width) ? raw.width : null,
      height: Number.isFinite(raw.height) ? raw.height : null,
      bytes: Number.isFinite(raw.bytes) ? raw.bytes : null,
    };
    // v1.6：图片内容指纹，用于统一去重。老数据没有这个字段，启动时回填。
    if (typeof raw.hash === 'string' && raw.hash) it.hash = raw.hash;
    return it;
  }
  return null;
}

/** 启动时加载；对文件/图片做存在性校验，标记失效但不删除 */
function load() {
  // 先回到默认值：文件缺失/损坏时不残留上一次加载的内容
  state = { version: 1, items: [], settings: { ...DEFAULT_SETTINGS } };
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (raw && Array.isArray(raw.items)) {
      state.items = raw.items.map(sanitizeItem).filter(Boolean);
    }
    state.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
    state.settings.theme = normalizeTheme(state.settings.theme);
    state.settings.itemLimit = normalizeItemLimit(state.settings.itemLimit);
    state.settings.ropePosition = normalizeRopePosition(state.settings.ropePosition);
  } catch {
    // 首次运行或文件损坏：使用默认
  }
  // 校验存在性
  for (const it of state.items) {
    if (isFileItem(it)) it.invalid = !it.path || !fs.existsSync(it.path);
    else if (it.type === 'image') it.invalid = !it.cachePath || !fs.existsSync(it.cachePath);
  }
  return state;
}

/**
 * 旧缓存扩展名自愈。
 *
 * 早期版本按 content-type 的子类型拼扩展名：`image/svg+xml` 会拼成 `.svgxml`，
 * 而本地 file:// 加载时 Chromium 是按扩展名判 MIME 的 —— 认不出的扩展名直接
 * 当成未知类型，卡片上就是破图。
 *
 * 这里读文件头按字节判断真实格式，扩展名不对就改成正确的（只动缓存目录内的
 * 文件，用户自己的原文件绝不改名）。返回修复的件数。
 */
function healImageExtensions() {
  const dir = cacheDir();
  let normDir;
  try {
    normDir = path.resolve(dir).toLowerCase() + path.sep;
  } catch {
    return 0;
  }
  let fixed = 0;
  let changed = false;
  for (const it of state.items) {
    if (it.type !== 'image' || !it.cachePath) continue;
    const file = it.cachePath;
    let normFile;
    try {
      normFile = path.resolve(file).toLowerCase();
    } catch {
      continue;
    }
    // 只修复缓存副本；缓存目录外的文件（例如手工放进来的测试图）不动
    if (!normFile.startsWith(normDir)) continue;

    let ext = path.extname(file).slice(1).toLowerCase();
    let head = null;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        head = Buffer.alloc(8192);
        const n = fs.readSync(fd, head, 0, head.length, 0);
        head = n > 0 ? head.slice(0, n) : null;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue; // 文件读不到：保持原样，由 invalid 标记处理
    }
    if (!head) continue;

    const real = imageFormat.sniffExt(head);
    if (!real || real === ext) continue;

    const target = path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.' + real);
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target); // 同名目标：本次是唯一引用，直接覆盖
      fs.renameSync(file, target);
    } catch {
      try {
        fs.copyFileSync(file, target);
        fs.unlinkSync(file);
      } catch {
        continue; // 实在改不了：保留旧文件，界面会用占位兜底
      }
    }
    // 名称若是自动生成的缓存名（等于旧文件名），同步成新文件名
    if (it.name === path.basename(file)) it.name = path.basename(target);
    it.cachePath = target;
    it.invalid = false;
    fixed++;
    changed = true;
  }
  if (changed) save();
  return fixed;
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    const tmp = stateFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, 'utf8', 2));
    fs.renameSync(tmp, stateFile());
    lastError = null;
  } catch (e) {
    lastError = e.message;
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}

function getItems() {
  return state.items;
}

/** 原子替换整份挂件列表：仅用于启动时合并历史重复挂件 */
function replaceItems(items) {
  state.items = Array.isArray(items) ? items : [];
  save();
  return state.items;
}

function addItem(item) {
  /* 件数上限的最后一道兜底：所有新增入口（拖入 / 剪贴板 / 文字 / 图片 /
     📌 / 网页图片）最终都落到这里，保证任何路径都绕不过上限。
     上层负责预先给出友好提示，这里只负责绝不写爆数据。 */
  if (state.items.length >= normalizeItemLimit(state.settings.itemLimit)) return null;
  state.items.push(item);
  save();
  return item;
}

function removeItem(id) {
  const idx = state.items.findIndex((i) => i.id === id);
  if (idx === -1) return null;
  const [removed] = state.items.splice(idx, 1);
  save();
  return removed;
}

function reorder(ids) {
  const map = new Map(state.items.map((i) => [i.id, i]));
  const next = [];
  for (const id of ids) {
    const it = map.get(id);
    if (it) {
      next.push(it);
      map.delete(id);
    }
  }
  for (const rest of map.values()) next.push(rest);
  state.items = next;
  save();
}

function clearItems() {
  state.items = [];
  save();
}

function getSettings() {
  const s = { ...state.settings, resolvedCacheDir: cacheDir() };
  s.itemLimit = normalizeItemLimit(s.itemLimit);
  s.ropePosition = normalizeRopePosition(s.ropePosition);
  return s;
}

function setSettings(patch) {
  const allowed = {};
  if (typeof patch.cacheDir === 'string') allowed.cacheDir = patch.cacheDir.trim();
  if (Number.isFinite(patch.cacheLimitMB)) allowed.cacheLimitMB = Math.max(10, Math.min(4096, patch.cacheLimitMB | 0));
  if (typeof patch.hotkey === 'string' && patch.hotkey) allowed.hotkey = patch.hotkey;
  // 主题只接受白名单值；非法值直接忽略，不覆盖已有选择
  if (patch.theme === 'light' || patch.theme === 'dark') allowed.theme = patch.theme;
  // 件数上限同理：只认 6 个数字档位，字符串 / 越界 / null 一律忽略
  if (ITEM_LIMITS.includes(patch.itemLimit)) allowed.itemLimit = patch.itemLimit;
  // 停靠位置同理：只认 4 个方位，非法值忽略
  if (ROPE_POSITIONS.includes(patch.ropePosition)) allowed.ropePosition = patch.ropePosition;
  state.settings = { ...state.settings, ...allowed };
  save();
  return getSettings();
}

/* ---------------- 图片缓存 ---------------- */

function ensureCacheDir() {
  fs.mkdirSync(cacheDir(), { recursive: true });
}

function imageCacheKey(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20);
}

/** 把图片字节写入缓存，返回 { path, name } */
function saveImageToCache(buf, ext) {
  ensureCacheDir();
  // 兜底：扩展名不合法时按字节判断真实格式（例如上游传了 "svg+xml"）
  const cleanExt = imageFormat.normalizeExt(ext) || imageFormat.sniffExt(buf) || 'png';
  const name = `img_${Date.now().toString(36)}_${imageCacheKey(buf)}.${cleanExt}`;
  const p = path.join(cacheDir(), name);
  fs.writeFileSync(p, buf);
  return { path: p, name };
}

function dirSizeRecursive(dir) {
  let total = 0;
  let walk;
  try {
    walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else total += fs.statSync(p).size;
      }
    };
    walk(dir);
  } catch {
    /* 目录不存在 */
  }
  return total;
}

function cacheUsage() {
  return { bytes: dirSizeRecursive(cacheDir()), dir: cacheDir(), limitMB: state.settings.cacheLimitMB };
}

/** 删除缓存目录中不再被任何挂件引用的孤儿文件 */
function pruneOrphans() {
  const referenced = new Set(state.items.filter((i) => i.type === 'image').map((i) => i.cachePath));
  let removed = 0;
  try {
    for (const e of fs.readdirSync(cacheDir(), { withFileTypes: true })) {
      const p = path.join(cacheDir(), e.name);
      if (!e.isDirectory() && !referenced.has(p)) {
        fs.unlinkSync(p);
        removed++;
      }
    }
  } catch {
    /* ignore */
  }
  return removed;
}

function clearCache() {
  ensureCacheDir();
  let removed = 0;
  for (const e of fs.readdirSync(cacheDir(), { withFileTypes: true })) {
    const p = path.join(cacheDir(), e.name);
    if (!e.isDirectory()) {
      try {
        fs.unlinkSync(p);
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  // 挂件引用已失效，标记
  for (const it of state.items) {
    if (it.type === 'image') it.invalid = true;
  }
  save();
  return removed;
}

/** 更换缓存目录：迁移现有图片文件并更新挂件引用 */
function migrateCache(newDir) {
  const oldDir = cacheDir();
  const normOld = path.resolve(oldDir).toLowerCase();
  const normNew = path.resolve(newDir).toLowerCase();
  if (normOld === normNew) return { moved: 0 };
  fs.mkdirSync(newDir, { recursive: true });
  let moved = 0;
  for (const it of state.items) {
    if (it.type !== 'image' || !it.cachePath) continue;
    try {
      if (fs.existsSync(it.cachePath)) {
        const target = path.join(newDir, path.basename(it.cachePath));
        fs.copyFileSync(it.cachePath, target);
        fs.unlinkSync(it.cachePath);
        it.cachePath = target;
        moved++;
      }
    } catch {
      /* 单个失败不影响整体 */
    }
  }
  // 尝试删除旧目录（可能非空，失败忽略）
  try {
    for (const e of fs.readdirSync(oldDir, { withFileTypes: true })) {
      if (!e.isDirectory()) fs.unlinkSync(path.join(oldDir, e.name));
    }
    fs.rmdirSync(oldDir);
  } catch {
    /* ignore */
  }
  state.settings.cacheDir = newDir;
  save();
  return { moved };
}

function getState() {
  return state;
}

module.exports = {
  MAX_TEXT_CHARS,
  DEFAULT_SETTINGS,
  THEMES,
  normalizeTheme,
  ITEM_LIMITS,
  DEFAULT_ITEM_LIMIT,
  normalizeItemLimit,
  ROPE_POSITIONS,
  normalizeRopePosition,
  userDataDir,
  load,
  save,
  saveNow,
  healImageExtensions,
  getItems,
  replaceItems,
  addItem,
  removeItem,
  reorder,
  clearItems,
  getSettings,
  setSettings,
  cacheDir,
  defaultCacheDir,
  saveImageToCache,
  cacheUsage,
  pruneOrphans,
  clearCache,
  migrateCache,
  getState,
  newId,
  lastError: () => lastError,
};
