/**
 * 悬挂绳 —— 拖出载荷决策（纯逻辑，依赖注入，便于单元测试）
 * 规则来源：PRD F4 / F9
 *  · 图片挂件 → 发送缓存副本
 *  · 文件/文件夹 → 发送本体；快捷方式先解析到本体
 *  · 悬空快捷方式 → 降级发送 .lnk 本身，并给出警告
 *  · 源不存在 → 不发起拖拽，给出原因
 */

const DANGLING_LNK_WARNING = '快捷方式指向的对象已不存在，将发送快捷方式本身';

function fail(warning, kind) {
  return { ok: false, target: null, icon: null, warning, kind };
}

/**
 * @param {{kind?:string,path?:string,cachePath?:string}} payload
 * @param {{exists:Function,stat:Function,resolveShortcut:Function,imageIconFor?:Function}} deps
 */
function planDrag(payload, deps) {
  const d = deps || {};
  const { kind, path: filePath, cachePath } = payload || {};

  if (kind === 'image') {
    if (!cachePath || !d.exists(cachePath)) return fail('图片缓存已丢失，无法拖出', 'image');
    return {
      ok: true,
      target: cachePath,
      icon: typeof d.imageIconFor === 'function' ? d.imageIconFor(cachePath) : null,
      warning: '',
      kind: 'image',
    };
  }

  if (!filePath) return fail('没有可拖出的内容', kind || '');

  const resolved = (typeof d.resolveShortcut === 'function' && d.resolveShortcut(filePath)) || {
    path: filePath,
    shortcut: null,
  };
  const target = resolved.path || filePath;
  const warning =
    !resolved.shortcut && /\.lnk$/i.test(filePath) ? DANGLING_LNK_WARNING : '';

  if (!d.stat(target)) return fail('源文件已不存在，无法拖出', kind);

  return {
    ok: true,
    target,
    icon: null,
    warning,
    kind,
    shortcut: resolved.shortcut || '',
  };
}

module.exports = { planDrag, DANGLING_LNK_WARNING };
