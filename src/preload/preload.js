/**
 * 悬挂绳 —— 预加载桥
 * 只暴露白名单 API，渲染层不接触 Node 能力。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('rope', {
  /* 拖入的 File 对象 → 本地路径 */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  /* 状态与事件 */
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onEvent: (cb) => ipcRenderer.on('event', (_e, ev) => cb(ev)),

  /* 新增挂件 */
  addPaths: (paths) => ipcRenderer.send('add-paths', paths),
  addText: (text) => ipcRenderer.send('add-text', text),
  addImageUrl: (url, name) => ipcRenderer.send('add-image-url', { url, name: name || '' }),
  addImageBuffer: (buf, ext, meta) =>
    ipcRenderer.send('add-image-buffer', {
      buf,
      ext: ext || '',
      mime: (meta && meta.mime) || '',
      name: (meta && meta.name) || '',
    }),

  /* 挂件操作 */
  removeItem: (id) => ipcRenderer.send('remove-item', id),
  reorder: (ids) => ipcRenderer.send('reorder', ids),
  clearAll: () => ipcRenderer.send('clear-all'),
  revealItem: (p) => ipcRenderer.send('reveal-item', p),

  /* 拖出 */
  startDrag: (payload) => ipcRenderer.send('start-drag', payload),
  dragEnded: () => ipcRenderer.send('drag-ended'),

  /* 单击复制 / 双击打开（挂件与文件夹面板行共用，v1.5） */
  copyItem: (target) => ipcRenderer.invoke('copy-item', target),
  openItem: (target) => ipcRenderer.invoke('open-item', target),

  /* 文件夹浏览 */
  listFolder: (dir) => ipcRenderer.invoke('list-folder', dir),
  pinPath: (p) => ipcRenderer.invoke('pin-path', p),
  unpinPath: (p) => ipcRenderer.invoke('unpin-path', p),

  /* 悬浮窗状态 */
  hover: (on) => ipcRenderer.send('hover', on),
  busy: (on) => ipcRenderer.send('busy', on),
  setHeight: (h) => ipcRenderer.send('set-height', h),

  /* 复制模式 */
  setCopyMode: (on) => ipcRenderer.send('set-copy-mode', on),
  toggleCopyMode: () => ipcRenderer.send('toggle-copy-mode'),
  copyToClipboard: (payload) => ipcRenderer.send('copy-to-clipboard', payload),

  /* 取件模式（渲染层 Esc 切换后同步给主进程） */
  setRemoveMode: (on) => ipcRenderer.send('set-remove-mode', on),

  /* 设置（独立窗口） */
  openSettings: () => ipcRenderer.send('open-settings'),
  settingsInfo: () => ipcRenderer.invoke('settings:info'),
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', () => cb()),
  clearAllItems: () => ipcRenderer.invoke('settings:clear-all'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseCacheDir: () => ipcRenderer.invoke('settings:choose-cache-dir'),
  cacheUsage: () => ipcRenderer.invoke('cache:usage'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  pruneCache: () => ipcRenderer.invoke('cache:prune'),

  quit: () => ipcRenderer.send('quit-app'),
});
