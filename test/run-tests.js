/**
 * 悬挂绳 —— 测试总入口
 *   npm test                单元 + 全部 Electron 场景
 *   npm run test:unit       只跑纯 Node 单元测试
 *   npm run test:e2e        只跑 Electron 场景
 *
 * 每个场景使用独立的 HANGING_ROPE_TEST_USERDATA 临时目录，
 * 不会读写用户真实的 %APPDATA%\悬挂绳，也不会和正在运行的正式实例抢单实例锁。
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const only = process.argv[2] || 'all'; // all | unit | e2e

const electron = require('electron');
if (typeof electron !== 'string') {
  console.error('无法定位 Electron 可执行文件，请先 npm install');
  process.exit(2);
}

const baseEnv = { ...process.env };
delete baseEnv.ELECTRON_RUN_AS_NODE; // 宿主终端可能带着它，会让 Electron 当 Node 跑

const summary = [];
let failed = 0;

function run(title, cmd, args, env) {
  console.log('\n=== ' + title + ' ===');
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...baseEnv, ...(env || {}) },
    timeout: 180000,
  });
  if (r.error) {
    failed++;
    summary.push(`FAIL  ${title}  (${r.error.message})`);
    console.log('启动失败：' + r.error.message);
    return;
  }
  if (r.status === 0) {
    summary.push(`PASS  ${title}`);
  } else {
    failed++;
    summary.push(`FAIL  ${title}  (exit ${r.status})`);
  }
}

function mkUserData(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hr-e2e-${tag}-`));
}

function seedState(userData, items) {
  const seed = { version: 1, items, settings: {} };
  fs.writeFileSync(path.join(userData, 'state.json'), JSON.stringify(seed, null, 2));
  fs.writeFileSync(path.join(userData, 'seed.json'), JSON.stringify(seed, null, 2));
  return seed;
}

function e2e(tag, extraEnv, userData) {
  const dir = userData || mkUserData(tag);
  // 缓存目录默认落在 %LOCALAPPDATA%\HangingRope\cache，这里一并隔离：
  // 否则测试里的“清空缓存/清理孤儿”会动到用户真实缓存
  const localAppData = path.join(dir, 'localappdata');
  fs.mkdirSync(localAppData, { recursive: true });
  run(`E2E / ${tag}`, electron, [path.join(__dirname, 'e2e', 'scenarios.js')], {
    HR_SCENARIO: tag,
    HANGING_ROPE_TEST_USERDATA: dir,
    LOCALAPPDATA: localAppData,
    HANGING_ROPE_TEST_DRY_DRAG: '1',
    HANGING_ROPE_TEST_FREEZE_WATCHER: '1',
    ...extraEnv,
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------------- 单元测试 ---------------- */

if (only === 'all' || only === 'unit') {
  const unitDir = path.join(__dirname, 'unit');
  const files = fs
    .readdirSync(unitDir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => path.join(unitDir, f));
  run('单元测试（node --test）', process.execPath, ['--test', ...files]);
}

/* ---------------- 端到端场景 ---------------- */

if (only === 'all' || only === 'e2e') {
  e2e('basic', {});
  e2e('shortcut', {});

  // 恢复场景：预置 4 件内容（文字 / 图片 / 文件 / 文件夹）
  const seedItems = [
    { id: 'r1', type: 'text', text: '恢复用文字', addedAt: 1 },
    {
      id: 'r2',
      type: 'image',
      cachePath: path.join(ROOT, 'assets', 'icon.png'),
      name: 'icon.png',
      width: 256,
      height: 256,
      bytes: 6363,
      addedAt: 2,
    },
    { id: 'r3', type: 'file', path: path.join(ROOT, 'package.json'), name: 'package.json', addedAt: 3 },
    { id: 'r4', type: 'folder', path: path.join(ROOT, 'src'), name: 'src', addedAt: 4 },
  ];

  const restoreDir = mkUserData('restore');
  seedState(restoreDir, seedItems);
  e2e('restore', { HANGING_ROPE_RESTORE_ANSWER: 'restore' }, restoreDir);

  const discardDir = mkUserData('discard');
  seedState(discardDir, seedItems);
  e2e('discard', { HANGING_ROPE_RESTORE_ANSWER: 'discard' }, discardDir);
}

/* ---------------- 汇总 ---------------- */

console.log('\n================ 测试结果 ================');
for (const line of summary) console.log(line);
console.log('==========================================');
console.log(failed ? `失败 ${failed} 项` : '全部通过');

process.exit(failed ? 1 : 0);
