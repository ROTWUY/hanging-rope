/**
 * 挂件去重（纯函数，可被纯 Node 单测覆盖）
 *
 * 之前只有「📌 固定子文件夹」和「连续两次复制同一内容」有防重复，
 * 拖入 / 复制即悬挂 / Ctrl+V / 文字路径 / 网页图片这些入口各自直接 addItem，
 * 于是同一个桌面文件能挂出两张一模一样的卡片（v1.5 反馈）。
 *
 * 统一规则（所有入口共用同一套比较键，避免规则漂移）：
 *  · file / folder：pathKey(path.resolve(path)) —— 大小写、反斜杠、末尾分隔符
 *    等价；`.lnk` 在主进程解析成本体后再比，所以快捷方式与本体算同一个目标。
 *    已失效（源被删）的挂件仍然占着这个键，不会被重复挂上第二张。
 *  · image：图片字节的 sha1。缓存副本每次都是新文件名，靠路径判不出来；
 *    老数据没有 hash 字段时退化为按缓存副本路径判（启动时主进程会回填）。
 *  · text：完整文本精确相等。
 *
 * 键带类型前缀，不同类型之间不会互相吃掉。
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const { pathKey } = require('./paths');

/** 图片字节内容指纹（与缓存文件名里的短哈希无关，这里用完整 sha1） */
function contentHash(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  return crypto.createHash('sha1').update(bytes).digest('hex');
}

/** 已有挂件的比较键；无法判定时返回空串（调用方一律放行，绝不误删） */
function itemKey(it) {
  if (!it || typeof it !== 'object') return '';
  if (it.type === 'file' || it.type === 'folder') {
    // 不能让 path.resolve('') 把"没有路径的坏挂件"解析成当前工作目录，
    // 否则多张坏挂件会被误判成同一件而合并掉。
    const p = String(it.path || '').trim();
    if (!p) return '';
    const k = pathKey(path.resolve(p));
    return k ? 'path:' + k : '';
  }
  if (it.type === 'image') {
    const h = typeof it.hash === 'string' ? it.hash.trim().toLowerCase() : '';
    if (h) return 'image:' + h;
    // 老版本挂件没有 hash：至少能识别"两张卡片引用同一份缓存副本"
    const cp = String(it.cachePath || '').trim();
    const k = cp ? pathKey(path.resolve(cp)) : '';
    return k ? 'cache:' + k : '';
  }
  if (it.type === 'text') {
    const t = typeof it.text === 'string' ? it.text : '';
    return t ? 'text:' + t : '';
  }
  return '';
}

/**
 * 一个挂件可能同时登记多个键：有指纹的图片既按内容判、也按缓存副本路径判，
 * 这样"旧版本无 hash 的挂件"和"新版本有 hash 的挂件"引用同一份副本时也能合上。
 */
function itemKeys(it) {
  const primary = itemKey(it);
  if (!primary) return [];
  if (it && it.type === 'image') {
    const cp = String(it.cachePath || '').trim();
    const ck = cp ? 'cache:' + pathKey(path.resolve(cp)) : '';
    if (ck && ck !== primary) return [primary, ck];
  }
  return [primary];
}

/**
 * 待添加内容的比较键。
 * @param {{type:string,path?:string,buf?:Buffer|Uint8Array,hash?:string,text?:string}} c
 */
function candidateKey(c) {
  if (!c || typeof c !== 'object') return '';
  if (c.type === 'file' || c.type === 'folder') {
    const p = String(c.path || '').trim();
    if (!p) return '';
    const k = pathKey(path.resolve(p));
    return k ? 'path:' + k : '';
  }
  if (c.type === 'image') {
    const h = c.hash
      ? String(c.hash).trim().toLowerCase()
      : c.buf && c.buf.length
      ? contentHash(c.buf)
      : '';
    return h ? 'image:' + h : '';
  }
  if (c.type === 'text') {
    const t = typeof c.text === 'string' ? c.text : '';
    return t ? 'text:' + t : '';
  }
  return '';
}

/** 绳上是否已有同一件内容；返回匹配到的挂件，没有则 null */
function findDuplicate(items, candidate) {
  const key = candidateKey(candidate);
  if (!key || !Array.isArray(items)) return null;
  return items.find((it) => itemKeys(it).includes(key)) || null;
}

/**
 * 合并绳上已经存在的重复挂件（一次性自愈）：保留第一次出现的那张、
 * 保持原有顺序，其余返回给调用方摘除。无法判定的挂件一律保留。
 * @returns {{kept:Array, removed:Array}}
 */
function collapseDuplicates(items) {
  const seen = new Set();
  const kept = [];
  const removed = [];
  for (const it of Array.isArray(items) ? items : []) {
    const keys = itemKeys(it);
    if (!keys.length) {
      kept.push(it);
      continue;
    }
    if (keys.some((k) => seen.has(k))) {
      removed.push(it);
      continue;
    }
    for (const k of keys) seen.add(k);
    kept.push(it);
  }
  return { kept, removed };
}

module.exports = { contentHash, itemKey, itemKeys, candidateKey, findDuplicate, collapseDuplicates };
