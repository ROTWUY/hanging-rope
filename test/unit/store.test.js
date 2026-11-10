/**
 * 数据层单元测试（纯 Node，不启动 Electron）
 * 覆盖 PRD：F2 文字上限 / F8 持久化 / F10 缓存与迁移 / AC-33~35 数据侧
 */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../src/main/store');

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-store-'));
  process.env.HANGING_ROPE_USERDATA = dir;
  process.env.LOCALAPPDATA = path.join(dir, 'localappdata');
  store.load();
});

afterEach(() => {
  // 先清空并落盘，避免防抖定时器把上一个用例的数据写进下一个用例的目录
  try {
    store.clearItems();
    store.saveNow();
  } catch {
    /* ignore */
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const statePath = () => path.join(process.env.HANGING_ROPE_USERDATA, 'state.json');
const readState = () => JSON.parse(fs.readFileSync(statePath(), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('文字上限常量为 50000 字符（PRD F2 / AC-09）', () => {
  assert.equal(store.MAX_TEXT_CHARS, 50000);
});

test('载入：丢弃未知类型、截断超长文字、保留 shortcut 字段与设置', () => {
  fs.writeFileSync(
    statePath(),
    JSON.stringify({
      version: 1,
      items: [
        { id: 'a', type: 'text', text: 'x'.repeat(60000), addedAt: 1 },
        { id: 'b', type: 'mystery', foo: 1 },
        { id: 'c', type: 'file', path: 'C:\\tmp\\a.txt', name: 'a.txt', shortcut: 'C:\\tmp\\a.lnk', addedAt: 2 },
      ],
      settings: { cacheLimitMB: 120, cacheDir: '' },
    })
  );

  store.load();
  const items = store.getItems();

  assert.equal(items.length, 2, '未知类型应被丢弃');
  assert.equal(items[0].text.length, store.MAX_TEXT_CHARS, '超长文字应截断');
  assert.equal(items[1].shortcut, 'C:\\tmp\\a.lnk', 'shortcut 应保留');
  assert.equal(store.getSettings().cacheLimitMB, 120);
});

test('载入：文件缺失时不残留上一次的内存数据', () => {
  store.addItem({ id: 'x', type: 'text', text: '旧数据', addedAt: 1 });
  assert.equal(store.getItems().length, 1);
  fs.rmSync(statePath(), { force: true });
  store.load();
  assert.equal(store.getItems().length, 0);
});

test('排序：按传入 id 排列，缺失的 id 追加在末尾且不丢项', () => {
  store.addItem({ id: 'a', type: 'text', text: 'A', addedAt: 1 });
  store.addItem({ id: 'b', type: 'text', text: 'B', addedAt: 2 });
  store.addItem({ id: 'c', type: 'text', text: 'C', addedAt: 3 });

  store.reorder(['c', 'a']); // b 不在列表里
  assert.deepEqual(store.getItems().map((i) => i.id), ['c', 'a', 'b']);

  store.saveNow();
  assert.deepEqual(readState().items.map((i) => i.id), ['c', 'a', 'b'], '排序结果应落盘');
});

test('增删与清空：立即反映到内存，saveNow 后落盘一致', () => {
  store.addItem({ id: 'a', type: 'text', text: 'A', addedAt: 1 });
  store.addItem({ id: 'b', type: 'file', path: 'C:\\x', name: 'x', addedAt: 2 });
  store.removeItem('a');
  store.saveNow();

  const saved = readState();
  assert.deepEqual(saved.items.map((i) => i.id), ['b']);
  assert.equal(saved.version, 1);

  store.clearItems();
  store.saveNow();
  assert.deepEqual(readState().items, []);
});

test('保存是防抖的：变更后最终一定落盘', async () => {
  store.addItem({ id: 'a', type: 'text', text: 'A', addedAt: 1 });
  await sleep(400);
  assert.equal(readState().items.length, 1);
});

test('图片缓存：写入内容一致、占用统计正确、孤儿清理保留被引用文件', () => {
  const buf = Buffer.from('fake-image-bytes-001');
  const saved = store.saveImageToCache(buf, 'png');
  assert.ok(fs.existsSync(saved.path));
  assert.deepEqual(fs.readFileSync(saved.path), buf);

  store.addItem({
    id: 'i1',
    type: 'image',
    cachePath: saved.path,
    name: saved.name,
    width: 2,
    height: 3,
    bytes: buf.length,
    addedAt: 1,
  });
  const orphan = store.saveImageToCache(Buffer.from('orphan'), 'png');

  const usage = store.cacheUsage();
  assert.ok(usage.bytes >= buf.length + 6, '占用应包含两个文件');
  assert.equal(usage.limitMB, 200, '默认上限 200MB');

  const removed = store.pruneOrphans();
  assert.equal(removed, 1, '应只删除未引用文件');
  assert.ok(fs.existsSync(saved.path), '被引用文件必须保留');
  assert.ok(!fs.existsSync(orphan.path), '孤儿文件应被删除');
});

test('更换缓存目录：迁移文件并改写挂件引用', () => {
  const saved = store.saveImageToCache(Buffer.from('migrate-me'), 'png');
  store.addItem({
    id: 'i1',
    type: 'image',
    cachePath: saved.path,
    name: saved.name,
    width: 1,
    height: 1,
    bytes: 10,
    addedAt: 1,
  });

  const newDir = path.join(dir, 'new-cache');
  const res = store.migrateCache(newDir);

  assert.equal(res.moved, 1);
  const item = store.getItems()[0];
  assert.equal(path.dirname(item.cachePath), newDir, 'cachePath 应指向新目录');
  assert.ok(fs.existsSync(item.cachePath));
  assert.ok(!fs.existsSync(saved.path), '旧文件应被移走');
  assert.equal(store.getSettings().cacheDir, newDir);
  assert.equal(store.getSettings().resolvedCacheDir, newDir);

  // 同目录迁移应为 0，不应报错
  assert.equal(store.migrateCache(newDir).moved, 0);
});

test('清空缓存：删除文件并把图片挂件标记失效', () => {
  const saved = store.saveImageToCache(Buffer.from('clear-me'), 'png');
  store.addItem({ id: 'i1', type: 'image', cachePath: saved.path, name: saved.name, addedAt: 1 });

  const n = store.clearCache();
  assert.equal(n, 1);
  assert.ok(!fs.existsSync(saved.path));
  assert.equal(store.getItems()[0].invalid, true);
});

test('默认缓存目录位于 LOCALAPPDATA\\HangingRope\\cache（F10）', () => {
  const d = store.defaultCacheDir();
  assert.ok(d.startsWith(process.env.LOCALAPPDATA), d);
  assert.ok(/HangingRope[\\/]cache$/.test(d), d);
});

test('设置：非法值被夹紧，合法值持久化', () => {
  store.setSettings({ cacheLimitMB: 5 }); // 低于下限 10
  assert.equal(store.getSettings().cacheLimitMB, 10);

  store.setSettings({ cacheLimitMB: 99999 }); // 高于上限 4096
  assert.equal(store.getSettings().cacheLimitMB, 4096);

  store.setSettings({ cacheLimitMB: 50, hotkey: 'CommandOrControl+Alt+H' });
  store.saveNow();
  assert.equal(readState().settings.cacheLimitMB, 50);
});

test('缓存落盘：扩展名非法时按字节纠正（.svg+xml 不会写出 .svgxml）', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  const saved = store.saveImageToCache(svg, 'svg+xml');
  assert.ok(saved.path.endsWith('.svg'), '实际 ' + saved.path);
  assert.equal(path.extname(saved.path), '.svg');
});

test('启动自愈：把 .svgxml 之类的旧缓存改名成真实扩展名并更新引用（AC-37）', () => {
  const dirCache = store.cacheDir();
  fs.mkdirSync(dirCache, { recursive: true });
  const bad = path.join(dirCache, 'img_old_abc.svgxml');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  fs.writeFileSync(bad, svg);

  store.addItem({
    id: 'bad1',
    type: 'image',
    cachePath: bad,
    name: 'img_old_abc.svgxml',
    width: null,
    height: null,
    bytes: svg.length,
    addedAt: 1,
  });
  store.saveNow();

  const fixed = store.healImageExtensions();
  assert.equal(fixed, 1);

  const it = store.getItems()[0];
  assert.ok(it.cachePath.endsWith('.svg'), '引用应改成 .svg：' + it.cachePath);
  assert.equal(it.name, 'img_old_abc.svg', '自动生成的缓存名同步改名');
  assert.ok(fs.existsSync(it.cachePath), '新文件应存在');
  assert.ok(!fs.existsSync(bad), '旧文件应已改名（不留副本）');
  store.saveNow(); // 自愈用的是防抖落盘，退出时另有 saveNow 兜底
  assert.equal(readState().items[0].cachePath, it.cachePath, '修正结果应落盘');
});

test('启动自愈：扩展名正确的不动，缓存目录外的文件绝不动', () => {
  const good = store.saveImageToCache(Buffer.from('not-a-real-image'), 'png');
  store.addItem({ id: 'g', type: 'image', cachePath: good.path, name: good.name, addedAt: 1 });

  const outside = path.join(dir, 'outside.svgxml');
  fs.writeFileSync(outside, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  store.addItem({ id: 'o', type: 'image', cachePath: outside, name: 'outside.svgxml', addedAt: 2 });
  store.saveNow();

  assert.equal(store.healImageExtensions(), 0, '不应改动任何文件');
  assert.ok(fs.existsSync(good.path));
  assert.ok(fs.existsSync(outside), '缓存目录外的文件必须保持原样');
  assert.equal(store.getItems()[1].cachePath, outside);
});

test('启动自愈：二次执行幂等（已修好的不会再改）', () => {
  const dirCache = store.cacheDir();
  fs.mkdirSync(dirCache, { recursive: true });
  const f = path.join(dirCache, 'img_x_1.svgxml');
  fs.writeFileSync(f, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  store.addItem({ id: 'x', type: 'image', cachePath: f, name: 'img_x_1.svgxml', addedAt: 1 });

  assert.equal(store.healImageExtensions(), 1);
  assert.equal(store.healImageExtensions(), 0);
});
