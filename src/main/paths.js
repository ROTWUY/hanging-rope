/**
 * 路径归一化（纯函数，可被纯 Node 单测覆盖）
 *
 * 用途：判断"两个挂件是否指向同一个目标"。Windows 下路径大小写不敏感、
 * 反斜杠与正斜杠等价、末尾分隔符可有可无，所以比较前统一成小写 + 正斜杠。
 * 注意：只做字符串层面的等价，不做软链接/短路径（8.3）解析。
 */

const path = require('path');

/**
 * @param {string} p 绝对路径
 * @returns {string} 归一化后的比较键；非法输入返回空串
 */
function pathKey(p) {
  if (!p || typeof p !== 'string') return '';
  let s = p.trim().replace(/\\/g, '/').toLowerCase();
  if (!s) return '';
  // 先去掉末尾分隔符，再单独给盘符根补回一个斜杠，
  // 避免 "C:\" 和 "C:" 归一化成不同的键
  s = s.replace(/\/+$/, '');
  if (/^[a-z]:$/.test(s)) return s + '/';
  return s || '/';
}

/** 两个路径是否指向同一目标 */
function samePath(a, b) {
  const ka = pathKey(a);
  return !!ka && ka === pathKey(b);
}

/**
 * 找出 items 里所有指向同一目标的文件/文件夹挂件。
 * 供「📌 固定」的去重与「再点一次取消固定」的摘除共用同一套判定，
 * 避免两处规则漂移；同一目标若因大小写/斜杠/末尾分隔符变体被重复挂了多份，
 * 会一起返回（取消固定时一次全摘，不会点了还剩一张卡片）。
 * @param {Array<{type?:string,path?:string}>} items
 * @param {string} p 目标路径
 * @returns {Array} 匹配到的挂件（可能 0 / 1 / 多个）
 */
function pinnedItems(items, p) {
  if (!Array.isArray(items) || !p || typeof p !== 'string' || !p.trim()) return [];
  const key = pathKey(path.resolve(p.trim()));
  if (!key) return [];
  return items.filter((it) => {
    if (!it || (it.type !== 'folder' && it.type !== 'file')) return false;
    if (typeof it.path !== 'string' || !it.path.trim()) return false;
    return pathKey(path.resolve(it.path.trim())) === key;
  });
}

module.exports = { pathKey, samePath, pinnedItems };
