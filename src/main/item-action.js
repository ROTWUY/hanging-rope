/**
 * 单击「复制」/ 双击「打开」的动作规划（纯函数，可被纯 Node 单测覆盖）。
 *
 * 输入是渲染层给的"目标描述"，不掺 Electron / 文件系统，只决定该走哪条路：
 *  - 文字：复制文本；没有文件本体，双击打开退化为复制 + 提示
 *  - 图片挂件：复制图片内容（缓存副本）；双击打开缓存副本
 *  - 文件 / 文件夹 / 图片文件：复制成系统剪贴板里的"可粘贴文件对象"；双击用默认程序打开
 *
 * 文件/文件夹面板里的行与绳上挂件共用同一套规则，避免两处行为漂移。
 */

/**
 * 规划一次「复制到剪贴板」。
 * @param {{type?:string,path?:string,cachePath?:string,text?:string,invalid?:boolean}} target
 * @returns {{ok:boolean,kind?:string,payload?:object,reason?:string,message?:string}}
 */
function planCopy(target) {
  if (!target || typeof target !== 'object') {
    return { ok: false, reason: 'bad-target', message: '没有可复制的内容' };
  }
  switch (target.type) {
    case 'text':
      if (typeof target.text !== 'string' || !target.text) {
        return { ok: false, reason: 'empty-text', message: '文字内容为空' };
      }
      return { ok: true, kind: 'text', payload: { text: target.text } };
    case 'image':
      if (!target.cachePath) {
        return { ok: false, reason: 'no-file', message: '这张图片没有本地副本' };
      }
      return { ok: true, kind: 'image', payload: { imageCachePath: target.cachePath } };
    case 'file':
    case 'folder':
      if (!target.path) {
        return { ok: false, reason: 'no-path', message: '没有源文件路径' };
      }
      // Windows 剪贴板的文件列表：UTF-16、NUL 分隔、双 NUL 结尾（见 fileNameWBuffer）
      return { ok: true, kind: 'files', payload: { paths: [target.path] } };
    default:
      return { ok: false, reason: 'unknown-type', message: '不支持复制这类内容' };
  }
}

/**
 * 规划一次「用系统默认程序打开」。
 * 文字没有文件本体，明确退化成复制，由调用方给出提示。
 * @param {{type?:string,path?:string,cachePath?:string,text?:string}} target
 * @returns {{ok:boolean,kind?:string,payload?:object,fallback?:string,reason?:string,message?:string}}
 */
function planOpen(target) {
  if (!target || typeof target !== 'object') {
    return { ok: false, reason: 'bad-target', message: '没有可打开的对象' };
  }
  if (target.type === 'text') {
    return {
      ok: false,
      fallback: 'copy',
      message: '文字没有可打开的文件，已复制到剪贴板',
    };
  }
  // 网页图片只有缓存副本；图片文件 / 其它文件用原始路径
  const p = target.type === 'image' ? target.cachePath || target.path : target.path;
  if (!p) {
    return { ok: false, reason: 'no-file', message: '这个对象没有可打开的文件' };
  }
  return { ok: true, kind: 'open', payload: { path: p } };
}

/**
 * 构造 Windows `FileNameW` 剪贴板格式的字节。
 * Chromium 写入后系统会同时呈现标准 CF_HDROP，资源管理器 / 微信等可直接粘贴；
 * 项目自身的 readClipboardFiles() 也按同一套 utf16le + NUL 规则读回。
 * @param {string[]} paths 绝对路径列表
 * @returns {Buffer} 空列表返回空 Buffer（调用方应拒绝写入）
 */
function fileNameWBuffer(list) {
  const items = (Array.isArray(list) ? list : []).filter(
    (p) => typeof p === 'string' && p.trim()
  );
  if (!items.length) return Buffer.alloc(0);
  return Buffer.from(items.join('\0') + '\0\0', 'utf16le');
}

module.exports = { planCopy, planOpen, fileNameWBuffer };
