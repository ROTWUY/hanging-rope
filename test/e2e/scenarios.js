/**
 * 悬挂绳 —— Electron 端到端场景
 *
 * 用法（由 test/run-tests.js 调用，不建议手工直接跑）：
 *   HR_SCENARIO=basic|restore|discard|shortcut|click|dedupe|dedupe-restart|theme|theme-restart|office-icons|item-limit|position|position-restart|multi-select|summon
 *   HANGING_ROPE_TEST_USERDATA=<临时目录>
 *
 * 说明：
 *  · 真实系统拖放（startDrag）在自动化里会阻塞等待鼠标释放，因此用
 *    HANGING_ROPE_TEST_DRY_DRAG 让主进程只记录载荷（dragLog）而不真的拖；
 *    真实拖到微信/Word 属于手工验收项，见 DEVPLAN.md。
 *  · HANGING_ROPE_TEST_DRY_OPEN 让"双击打开"只记 openLog，不真的弹出系统程序。
 *  · HANGING_ROPE_TEST_FREEZE_WATCHER 冻结光标轮询，避免测试机光标位置干扰
 *    窗口的唤出/收回，测试内用 __test.showRope()/hideRope() 显式驱动。
 */
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { app, BrowserWindow, clipboard, shell, screen } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const scenario = process.env.HR_SCENARIO || 'basic';
const userData = process.env.HANGING_ROPE_TEST_USERDATA;

if (!userData) {
  console.error('[e2e] 缺少 HANGING_ROPE_TEST_USERDATA');
  process.exit(2);
}

process.env.HANGING_ROPE_TEST_DRY_DRAG = '1';
process.env.HANGING_ROPE_TEST_FREEZE_WATCHER = '1';

require(path.join(ROOT, 'src', 'main', 'main.js'));
const mainMod = require(path.join(ROOT, 'src', 'main', 'main.js'));
const T = mainMod.__test;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let passes = 0;

async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failures++;
    console.log('  \u2717 ' + name + ' :: ' + (e && e.message ? e.message : e));
  }
}

function js(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

const itemCount = (win) => js(win, 'document.querySelectorAll(".item").length');

async function waitFor(label, fn, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* 页面可能尚未就绪 */
    }
    if (Date.now() - t0 > timeout) throw new Error('等待超时：' + label);
    await sleep(80);
  }
}

/* 文件夹面板展开：早先版本靠"固定 sleep(700) + 取最后一个 folder 挂件"，
   连续跑全量套件时偶发失准（状态推送慢 / 真实光标掠过触发 mouseleave 把面板收起）。
   改为按 id 精确锁定目标挂件 + 条件等待面板真的展开且行数达标；每轮重新 hover，
   并给面板补一个 mouseenter 以清掉待执行的关闭定时器。断言标准不变。 */
async function openFolderPanel(win, itemId, minRows = 3) {
  return waitFor('文件夹面板展开（' + itemId + '）', async () => {
    const found = await js(
      win,
      `(async () => {
        rope.hover(true);
        const el = [...document.querySelectorAll('.item')].find(
          (n) => n.dataset.id === ${JSON.stringify(itemId)}
        );
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('mouseenter'));
        document.querySelector('#folder-panel').dispatchEvent(new MouseEvent('mouseenter'));
        return true;
      })()`
    );
    if (!found) return false;
    await sleep(320); // 200ms hover 延时 + listFolder 往返
    return js(
      win,
      `(() => {
        const p = document.querySelector('#folder-panel');
        return !p.hidden && p.querySelectorAll('.fp-row').length >= ${minRows};
      })()`
    );
  }, 12000);
}

/* 等某个路径的挂件真的出现在 state 里，返回 id（替代固定 sleep 的竞态） */
async function waitItemId(win, targetPath, label) {
  return waitFor(label || '挂件出现（' + targetPath + '）', () =>
    js(
      win,
      `rope.getState().then((s) => {
        const it = s.items.find((i) => i.path === ${JSON.stringify(targetPath)});
        return it ? it.id : '';
      })`
    )
  );
}

/* 透明置顶窗口会收到宿主的真实鼠标边界事件：挂件/面板的 mouseleave 会启动
   "260ms 后收起面板"，连续跑套件时偶发把测试正在观察的面板关掉，造成与产品
   行为无关的假失败。这里只在测试页面里拦掉授信（真实）的 mouseenter/mouseleave；
   合成事件 isTrusted=false 仍完整走产品逻辑，断言标准一条没变。
   与 HANGING_ROPE_TEST_FREEZE_WATCHER 同类：消除环境噪声，不改产品代码。 */
async function installMouseShield(win) {
  return waitFor('鼠标事件垫片', () =>
    js(
      win,
      `(() => {
        if (window.__hrMouseShield) return true;
        window.__hrMouseShield = true;
        for (const type of ['mouseenter', 'mouseleave']) {
          document.addEventListener(type, (e) => {
            if (e.isTrusted) {
              e.stopImmediatePropagation();
              e.preventDefault();
            }
          }, true);
        }
        return true;
      })()`
    )
  );
}

/* 等设置窗口出现并加载完（主进程里设置是独立 BrowserWindow） */
async function waitSettingsWindow() {
  let sw = null;
  for (let i = 0; i < 120 && !sw; i++) {
    sw = T.getSettingsWindow();
    if (!sw) await sleep(50);
  }
  if (!sw) throw new Error('设置窗口没有打开');
  for (let i = 0; i < 120 && sw.webContents.isLoading(); i++) await sleep(80);
  await sleep(400);
  return sw;
}

const statePath = () => path.join(userData, 'state.json');function readState() {
  return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
}

/* ---------------- 场景：主流程 ---------------- */

async function runBasic(win) {
  const disp = screen.getPrimaryDisplay().bounds;

  await check('AC-03 绳索宽度 = 主屏宽度 ÷ 3（误差 ≤4px）', () => {
    const b = win.getBounds();
    const expected = Math.round(disp.width / 3);
    assert.ok(Math.abs(b.width - expected) <= 4, `实际 ${b.width}，期望 ${expected}`);
  });

  await check('AC-03 水平居中', () => {
    const b = win.getBounds();
    const center = b.x + b.width / 2;
    assert.ok(Math.abs(center - (disp.x + disp.width / 2)) <= 2, `实际中心 ${center}`);
  });

  await check('AC-02 启动时完全不可见（y ≤ -210）', () => {
    assert.ok(win.getBounds().y <= -209, 'y=' + win.getBounds().y);
  });

  await check('F3 空状态显示引导文案', async () => {
    const hidden = await js(win, 'document.querySelector("#empty-hint").hidden');
    assert.equal(hidden, false);
  });

  T.showRope();
  await sleep(500);
  await installMouseShield(win);
  await check('AC-04 唤出后贴住屏幕顶端（y = 0）', () => {
    assert.equal(win.getBounds().y, 0);
  });

  /* --- 悬挂 --- */
  const text = '测试文字：周四 14:00 与产品组同步。';
  await js(win, `rope.addText(${JSON.stringify(text)})`);
  await waitFor('文字挂件', async () => (await itemCount(win)) === 1);
  await check('AC-07 文字挂件渲染并显示内容预览', async () => {
    const ok = await js(
      win,
      `(() => { const el = document.querySelector('.item.t-text'); return !!el && el.querySelector('.text-preview').textContent.includes('测试文字'); })()`
    );
    assert.equal(ok, true);
  });
  await check('AC-69 文字挂件只显示一处正文，下方不再重复首行摘要', async () => {
    const r = await js(
      win,
      `(() => {
        const el = document.querySelector('.item.t-text');
        if (!el) return null;
        const pre = el.querySelector('.text-preview');
        return {
          names: el.querySelectorAll('.name').length,
          previews: el.querySelectorAll('.text-preview').length,
          body: el.textContent.trim(),
          preview: pre ? pre.textContent.trim() : '',
        };
      })()`
    );
    assert.ok(r, '文字挂件应存在');
    assert.equal(r.names, 0, '不应再有名称行');
    assert.equal(r.previews, 1, '应恰好一个正文预览块');
    assert.equal(r.body, r.preview, '卡片里不应有第二处文字');
    assert.equal(r.body, text, '去掉摘要后正文仍要完整显示');
  });
  await check('AC-71 文字预览撑满卡片、卡片高度不变', async () => {
    const r = await js(
      win,
      `(() => {
        const el = document.querySelector('.item.t-text');
        const pre = el.querySelector('.text-preview');
        return {
          // offsetHeight 取布局高度：入场动画的 scale 会影响 getBoundingClientRect，
          // 用 rect 会在动画播放期间读到 104 * 0.94 这种假数值
          cardH: el.offsetHeight,
          thumbH: el.querySelector('.thumb').offsetHeight,
          clamp: getComputedStyle(pre).getPropertyValue('-webkit-line-clamp').trim(),
        };
      })()`
    );
    assert.equal(r.cardH, 104, '卡片总高保持 104px');
    assert.ok(r.thumbH > 70, '预览区应占满原本名称行腾出的空间，而不是留一块空白');
    // v1.19：11px × 1.35 行距下 6 行放不进 86px 内容区（最后一行被削半），
    // 收敛为 5 行 —— 仍比普通卡片默认的 4 行多，断言意图（随高度增加）不变
    assert.equal(r.clamp, '5', '正文预览行数应随高度增加');
  });

  await js(win, `rope.addText(${JSON.stringify('x'.repeat(50001))})`);
  await sleep(500);
  await check('AC-09 超长文字被拒绝且给出提示', async () => {
    assert.equal(await itemCount(win), 1, '不应新增挂件');
    const toast = await js(win, 'document.querySelector("#toast").textContent');
    assert.match(toast, /太长/);
  });

  const iconPath = path.join(ROOT, 'assets', 'icon.png');
  await js(win, `rope.addPaths(${JSON.stringify([iconPath])})`);
  await waitFor('图片文件挂件', async () => (await itemCount(win)) === 2);
  await check('AC-07 图片文件显示为直接预览（不是 PNG 文字卡）', async () => {
    const info = await js(
      win,
      `(() => { const els=[...document.querySelectorAll('.item')]; const el=els.find(n=>n.classList.contains('t-image')); return { cls: el ? el.className : '', img: el ? !!el.querySelector('img') : false }; })()`
    );
    assert.ok(info.cls.includes('t-image'), '应带 t-image 类');
    assert.equal(info.img, true, '应渲染 <img> 预览');
  });
  await check('AC-70 其它类型挂件的名称行保持原样、两类卡片尺寸各自不变', async () => {
    const r = await js(
      win,
      `(() => {
        const img = [...document.querySelectorAll('.item')].find((n) => n.classList.contains('t-image'));
        const txt = document.querySelector('.item.t-text');
        const nm = img && img.querySelector('.name');
        return {
          name: nm ? nm.textContent.trim() : '',
          imgH: img ? img.offsetHeight : 0,
          txtH: txt ? txt.offsetHeight : 0,
        };
      })()`
    );
    assert.equal(r.name, 'icon.png', '文件/图片挂件仍要显示文件名');
    // 图片卡本来就比文字卡高（124 vs 104，见 .item.t-image），各自保持原尺寸即可
    assert.equal(r.txtH, 104, '文字卡总高保持 104px');
    assert.equal(r.imgH, 124, '图片卡总高保持 124px');
  });

  const folderPath = path.join(ROOT, 'src');
  await js(win, `rope.addPaths(${JSON.stringify([folderPath])})`);
  await waitFor('文件夹挂件', async () => (await itemCount(win)) === 3);
  await check('AC-07 文件夹挂件渲染', async () => {
    const n = await js(win, 'document.querySelectorAll(".item.t-folder").length');
    assert.equal(n, 1);
  });

  /* --- 持久化 --- */
  await sleep(500);
  await check('AC-33 变更后 state.json 立即更新（3 件）', () => {
    const s = readState();
    assert.equal(s.items.length, 3);
  });
  await check('AC-08 文件项只存路径，不存副本/字节', () => {
    const s = readState();
    const it = s.items.find((i) => i.type === 'file');
    assert.ok(it.path.startsWith(ROOT), '应记录原路径');
    assert.equal(it.cachePath, undefined);
    assert.equal(it.bytes, undefined);
  });
  await check('F2 文字内容随记录落盘', () => {
    const s = readState();
    const it = s.items.find((i) => i.type === 'text');
    assert.equal(it.text, text);
  });

  /* --- 网页图片：svg+xml 不能再变成 .svgxml（AC-37 / AC-38） --- */
  const svgBody =
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#e2a34a"/></svg>';
  const svgDataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svgBody).toString('base64');
  const beforeSvg = await itemCount(win);
  await js(win, `rope.addImageUrl(${JSON.stringify(svgDataUrl)}, '网页配图')`);
  await waitFor('网页 svg 挂件', async () => (await itemCount(win)) === beforeSvg + 1);

  const svgItem = await js(
    win,
    '(async () => { const s = await rope.getState(); return s.items[s.items.length - 1]; })()'
  );
  await check('AC-37 网页 SVG 以 .svg 扩展名落地（不是 .svgxml）', () => {
    assert.match(svgItem.cachePath, /\.svg$/, '实际路径：' + svgItem.cachePath);
    assert.equal(svgItem.name, '网页配图');
    assert.equal(svgItem.width, 240, '应从 SVG 读出宽度');
    assert.equal(svgItem.height, 120);
  });

  const rendered = await waitFor('SVG 缩略图渲染', async () =>
    js(
      win,
      `(() => {
        const el = document.querySelector('.item[data-id="${svgItem.id}"]');
        if (!el) return false;
        const img = el.querySelector('.thumb img');
        if (!img || !img.complete || !img.naturalWidth) return false;
        return { w: img.naturalWidth, h: img.naturalHeight, broken: !!el.querySelector('.thumb-broken') };
      })()`
    )
  );
  await check('AC-37 卡片里真的画出图（naturalWidth > 0，无破图占位）', () => {
    assert.ok(rendered.w > 0, 'naturalWidth=' + rendered.w);
    assert.equal(rendered.broken, false);
  });

  /* CDN 常把图片报成 application/octet-stream 或干脆报错类型：
     扩展名以字节为准，不能被 mime 带偏。
     v1.6 起图片按内容去重，所以这张必须和上面的 SVG 内容不同（只改一个色值），
     否则会作为"同一张图"被正确拦下，测不到 mime 纠错。断言标准不变。 */
  const liarSvgBody = svgBody.replace('#e2a34a', '#e2a34b');
  const beforeLiar = await itemCount(win);
  await js(
    win,
    `(() => {
      const bytes = new TextEncoder().encode(${JSON.stringify(liarSvgBody)});
      rope.addImageBuffer(bytes, '', { mime: 'image/png', name: 'img_mwau6kh0_66f704f6e4fa2af5bc98.png' });
      return true;
    })()`
  );
  await waitFor('mime 撒谎的图片挂件', async () => (await itemCount(win)) === beforeLiar + 1);
  const liarItem = await js(
    win,
    '(async () => { const s = await rope.getState(); return s.items[s.items.length - 1]; })()'
  );
  await check('AC-37 mime 撒谎（image/png）但内容是 SVG：仍按 .svg 落地', () => {
    assert.match(liarItem.cachePath, /\.svg$/, '实际：' + liarItem.cachePath);
  });
  await check('旧记录里的哈希缓存名在卡片上显示为人话（图片 · SVG）', async () => {
    const label = await js(
      win,
      `(() => { const el = document.querySelector('.item[data-id="${liarItem.id}"]'); return el ? el.querySelector('.name').textContent : ''; })()`
    );
    assert.equal(label, '图片 · SVG');
  });

  const beforeJunk = await itemCount(win);
  await js(
    win,
    `rope.addImageUrl(${JSON.stringify(
      'data:text/html;base64,' + Buffer.from('<html><body>403 Forbidden</body></html>').toString('base64')
    )})`
  );
  await sleep(600);
  await check('AC-38 抓到的不是图片（如防盗链 403 页面）就不悬挂，并提示失败', async () => {
    assert.equal(await itemCount(win), beforeJunk, '不应新增挂件');
    const t = await js(win, 'document.querySelector("#toast").textContent');
    assert.match(t, /抓取失败|不是图片/);
  });

  /* --- 文件夹浏览 --- */
  await check('AC-15 目录读取：返回条目且文件夹优先', async () => {
    const res = await js(win, `rope.listFolder(${JSON.stringify(folderPath)})`);
    assert.equal(res.ok, true);
    assert.ok(res.entries.length >= 3, '应有多个条目');
    assert.ok(res.entries.every((e) => e.path && typeof e.isDir === 'boolean'));
  });

  const folderItemId = await waitItemId(win, folderPath, '文件夹挂件出现（AC-15）');
  await openFolderPanel(win, folderItemId);

  const panel = await js(
    win,
    `(() => {
      const p = document.querySelector('#folder-panel');
      return {
        hidden: p.hidden,
        rows: p.querySelectorAll('.fp-row').length,
        sel: p.querySelectorAll('.fp-row.sel').length,
        counter: (p.querySelector('.fp-counter') || {}).textContent || '',
        strip: getComputedStyle(document.querySelector('#shell'), '::before').height,
        thumbs: p.querySelectorAll('.fp-row-thumb').length,
      };
    })()`
  );

  await check('AC-15 面板展开：竖排 3 行、每行有缩略图位', () => {
    assert.equal(panel.hidden, false);
    assert.equal(panel.rows, 3);
    assert.equal(panel.thumbs, 3);
  });
  await check('AC-15 表头显示 n / m 且选中行高亮', () => {
    assert.match(panel.counter, /^\d+ \/ \d+$/);
    assert.equal(panel.sel, 1);
  });
  await check('AC-18 绳索条背景固定 210px（不随窗口变高放大）', () => {
    assert.equal(panel.strip, '210px');
  });

  const heightExpanded = win.getBounds().height;
  await check('F5 展开面板时窗口变高以容纳面板', () => {
    assert.ok(heightExpanded >= 400, 'height=' + heightExpanded);
  });

  /* AC-156：面板不遮挡触发卡片（v1.20 用户反馈——展开列表盖住了原卡片）。
     顶部停靠优先放卡片侧面，窗口太窄两侧都放不下时落到卡片正下方并加高窗口。 */
  await check('AC-156 面板不遮挡触发卡片', async () => {
    const geom = await js(
      win,
      `(() => {
        const el = [...document.querySelectorAll('.item')].find(
          (n) => n.dataset.id === ${JSON.stringify(folderItemId)}
        );
        const p = document.querySelector('#folder-panel');
        const r = el.getBoundingClientRect();
        const q = p.getBoundingClientRect();
        return JSON.stringify({
          hidden: p.hidden,
          overlap: !(q.left >= r.right || q.right <= r.left || q.top >= r.bottom || q.bottom <= r.top),
          below: q.top >= r.bottom - 1,
          side: q.top < r.bottom && (q.left >= r.right - 1 || q.right <= r.left + 1),
          fitsH: q.bottom <= window.innerHeight + 1,
        });
      })()`
    );
    const g = JSON.parse(geom);
    assert.equal(g.hidden, false, '面板应处于打开状态');
    assert.equal(g.overlap, false, '面板与触发卡片不应相交');
    assert.ok(g.below || g.side, '面板应在卡片下方或侧面 below=' + g.below + ' side=' + g.side);
    assert.ok(g.fitsH, '面板应完整落在窗口内 bottom<=' + 'innerHeight');
  });

  /* AC-17：在列表行上按住拖动 → 发起对外拖出（dry-run 只校验载荷） */
  const dragLogBeforeRow = T.dragLog.length;
  const rowTarget = await js(
    win,
    `(async () => {
      const row = document.querySelector('#folder-panel .fp-row');
      const r = row.getBoundingClientRect();
      const mk = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 2, pointerType: 'mouse', isPrimary: true });
      row.dispatchEvent(new PointerEvent('pointerdown', mk(r.left + 30, r.top + 20)));
      await new Promise((res) => setTimeout(res, 40));
      document.dispatchEvent(new PointerEvent('pointermove', mk(r.left + 90, r.top + 20)));
      document.dispatchEvent(new PointerEvent('pointerup', mk(r.left + 90, r.top + 20)));
      return true;
    })()`
  );
  await sleep(400);
  await check('AC-17 文件夹列表行按住拖动可拖出该文件本体', () => {
    assert.ok(T.dragLog.length > dragLogBeforeRow, '应记录到一次拖出载荷');
    const last = T.dragLog[T.dragLog.length - 1];
    assert.ok(last.target, '应有目标路径');
    assert.ok(last.target.startsWith(folderPath), '目标应位于该文件夹内：' + last.target);
    assert.notEqual(last.target, folderPath, '不应是文件夹本身');
    assert.equal(rowTarget, true);
  });

  /* --- v1.20：拖出结束后立刻能排序 ---
     真实拖出后 ui.nativeDrag 要等 2.5s 兜底定时器才解除，期间 pointerdown
     全被拒绝——用户把文件拖回来想马上排序，体感就是"没法排序了"。
     修复后主进程在拖放结束时发 drag-ended 事件，渲染层立刻解除。 */
  await check('AC-154 拖出结束（drag-ended 事件）后 nativeDrag 立即解除、可立即排序', async () => {
    // 发起一次 dry 拖出（文件挂件手势：抬起 → 越过窗口底边）
    const out = await js(
      win,
      `(async () => {
        const el = document.querySelector('.item:not(.t-text)');
        const r = el.getBoundingClientRect();
        const mk = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 20, pointerType: 'mouse', isPrimary: true });
        el.dispatchEvent(new PointerEvent('pointerdown', mk(r.left + 20, r.top + 20)));
        await new Promise((resolve) => { const t0 = Date.now(); const tick = () => { if (ui.reorder || Date.now() - t0 > 2000) return resolve(); setTimeout(tick, 25); }; tick(); });
        document.dispatchEvent(new PointerEvent('pointermove', mk(r.left + 20, window.innerHeight - 2)));
        await new Promise((res) => setTimeout(res, 80));
        return { nativeDrag: ui.nativeDrag };
      })()`
    );
    assert.equal(out.nativeDrag, true, '拖出时 nativeDrag 应置位');
    // dry 拖出 300ms 后主进程发 drag-ended；等它到达
    await waitFor('drag-ended 到达', () => js(win, 'ui.nativeDrag === false'), 3000);
    const press = await js(
      win,
      `(async () => {
        const el = document.querySelector('.item:not(.t-text)');
        const r = el.getBoundingClientRect();
        const mk = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 21, pointerType: 'mouse', isPrimary: true });
        el.dispatchEvent(new PointerEvent('pointerdown', mk(r.left + 20, r.top + 20)));
        const ok = !!ui.press;
        document.dispatchEvent(new PointerEvent('pointerup', mk(r.left + 20, r.top + 20)));
        return { ok };
      })()`
    );
    assert.equal(press.ok, true, '拖放结束后 pointerdown 应立即被受理');
    await sleep(300);
  });

  await check('AC-155 手势残留自愈：卡死的 press/reorder 不再拒绝新的排序按下', async () => {
    const healed = await js(
      win,
      `(async () => {
        // 伪造残留手势（模拟 pointerup/cancel 被系统拖拽吞掉）
        ui.press = { timer: 0, lifted: true, pointerId: 99 };
        ui.reorder = { el: document.querySelector('.item'), item: { id: 'x', type: 'file' } };
        document.querySelector('.item').classList.add('lifting');
        const el = document.querySelector('.item:not(.t-text)');
        const r = el.getBoundingClientRect();
        const mk = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 22, pointerType: 'mouse', isPrimary: true });
        el.dispatchEvent(new PointerEvent('pointerdown', mk(r.left + 20, r.top + 20)));
        const pressAccepted = !!ui.press && ui.press.pointerId === 22;
        const staleCleared = !document.querySelector('.item.lifting');
        document.dispatchEvent(new PointerEvent('pointerup', mk(r.left + 20, r.top + 20)));
        return { pressAccepted, staleCleared };
      })()`
    );
    assert.equal(healed.pressAccepted, true, '新手势应被受理');
    assert.equal(healed.staleCleared, true, '残留 lifting 应被清理');
    await sleep(300);
  });

  /* 计数基线紧贴滚轮前取：中间若有重渲染（拖出会刷新列表）会让旧快照失效，
     那样这条用例就会偶尔“假失败”，和产品行为无关。 */
  const counterBefore = await js(win, 'document.querySelector("#folder-panel .fp-counter").textContent');
  await js(
    win,
    `(() => { const p=document.querySelector('#folder-panel'); p.dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true,cancelable:true})); return true; })()`
  );
  await sleep(200);
  const counterAfter = await js(win, 'document.querySelector("#folder-panel .fp-counter").textContent');
  await check('AC-16 滚轮切换选中项，计数同步变化', () => {
    assert.notEqual(counterAfter, counterBefore, `滚动前后计数应不同：${counterBefore} → ${counterAfter}`);
    assert.match(counterAfter, /^\d+ \/ \d+$/);
  });

  await js(
    win,
    `(() => { const el=[...document.querySelectorAll('.item')].find(n=>n.classList.contains('t-folder')); el.dispatchEvent(new MouseEvent('mouseleave')); return true; })()`
  );
  await sleep(500);
  await check('AC-15 移开鼠标后面板收起', async () => {
    assert.equal(await js(win, 'document.querySelector("#folder-panel").hidden'), true);
  });

  /* --- 文件夹面板里的 📌：把子文件夹固定到绳上（AC-44~46） ---
     用独立临时夹具目录，避免依赖 src 下恰好有"文件夹 + 文件"混排。 */
  const pinRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-pin-'));
  fs.mkdirSync(path.join(pinRoot, '子文件夹A'));
  fs.mkdirSync(path.join(pinRoot, '子文件夹B'));
  fs.writeFileSync(path.join(pinRoot, '说明.txt'), 'pin fixture');
  await js(win, `rope.addPaths(${JSON.stringify([pinRoot])})`);
  const pinItemId = await waitItemId(win, pinRoot, '📌 夹具文件夹挂件出现');
  // 精确锁定刚挂上的夹具文件夹，不再依赖"最后一个 folder 挂件"这种脆弱假设
  await openFolderPanel(win, pinItemId);

  const pinView = await js(
    win,
    `(() => {
      const p = document.querySelector('#folder-panel');
      const rows = [...p.querySelectorAll('.fp-row')];
      const first = rows[0];
      const pin = first && first.querySelector('.fp-pin');
      return {
        hidden: p.hidden,
        rows: rows.map((r) => ({
          name: r.querySelector('.fp-row-name').textContent,
          dir: !!r.querySelector('.fp-row-thumb .folder-shape'),
          pin: !!r.querySelector('.fp-pin'),
          slot: !!r.querySelector('.fp-pin-slot'),
        })),
        align: pin ? (() => {
          const rr = first.getBoundingClientRect(), br = pin.getBoundingClientRect();
          return {
            gap: Math.round(rr.right - br.right),
            midDiff: Math.round(Math.abs((rr.top + rr.bottom) / 2 - (br.top + br.bottom) / 2)),
          };
        })() : null,
      };
    })()`
  );

  await check('AC-44 子文件夹行右侧有 📌，文件行只留同宽占位（缩略图仍对齐）', () => {
    assert.equal(pinView.hidden, false);
    const dirs = pinView.rows.filter((r) => r.dir);
    const files = pinView.rows.filter((r) => !r.dir);
    assert.ok(dirs.length >= 2, '应至少两行文件夹：' + JSON.stringify(pinView.rows));
    assert.ok(dirs.every((r) => r.pin && !r.slot), '文件夹行应有 📌');
    assert.ok(files.length >= 1, '应有一行文件：' + JSON.stringify(pinView.rows));
    assert.ok(files.every((r) => !r.pin && r.slot), '文件行不该有 📌，只留占位');
  });

  await check('AC-44 📌 贴在行右侧且与行垂直居中', () => {
    assert.ok(pinView.align.gap >= 0 && pinView.align.gap <= 12, '右侧留白 ' + pinView.align.gap);
    assert.ok(pinView.align.midDiff <= 2, '垂直偏差 ' + pinView.align.midDiff);
  });

  /* 📌 在行内，但按下它不能启动"按住行拖动 = 拖出"。
     先等上一步（AC-17）拖出的 2.5s ui.nativeDrag 保护窗口过去，
     否则行按下会被直接忽略，这条用例就测不到东西了。 */
  await sleep(2600);
  const dragLogBeforePin = T.dragLog.length;
  await js(
    win,
    `(async () => {
      const pin = document.querySelector('#folder-panel .fp-pin');
      const r = pin.getBoundingClientRect();
      const mk = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 7, pointerType: 'mouse', isPrimary: true });
      pin.dispatchEvent(new PointerEvent('pointerdown', mk(r.left + 8, r.top + 8)));
      document.dispatchEvent(new PointerEvent('pointermove', mk(r.left + 8, r.top + 150)));
      document.dispatchEvent(new PointerEvent('pointerup', mk(r.left + 8, r.top + 150)));
      await new Promise((res) => setTimeout(res, 350));
      return true;
    })()`
  );
  await sleep(200);
  await check('AC-46 在 📌 上按住拖动不会拖出该行内容', () => {
    assert.equal(T.dragLog.length, dragLogBeforePin, '不应产生拖出载荷');
  });

  const pinBefore = await js(win, 'rope.getState().then((s) => s.items.length)');
  const pinned = await js(
    win,
    `(async () => {
      const pin = document.querySelector('#folder-panel .fp-pin');
      const name = pin.closest('.fp-row').querySelector('.fp-row-name').textContent;
      pin.click();
      await new Promise((r) => setTimeout(r, 700));
      const st = await rope.getState();
      return {
        name,
        items: st.items.map((i) => ({ type: i.type, name: i.name, path: i.path })),
        pinOn: !!document.querySelector('#folder-panel .fp-pin.on'),
        panelOpen: !document.querySelector('#folder-panel').hidden,
      };
    })()`
  );

  await check('AC-45 点 📌 把该子文件夹固定到绳上（只引用路径）', () => {
    assert.equal(pinned.items.length, pinBefore + 1, '应新增一个挂件');
    const added = pinned.items.find((i) => i.path === path.join(pinRoot, pinned.name));
    assert.ok(added, '应能找到新挂件：' + JSON.stringify(pinned.items.map((i) => i.path)));
    assert.equal(added.type, 'folder');
    assert.equal(added.name, pinned.name);
    assert.equal(pinned.pinOn, true, '📌 应变为已固定状态');
  });

  await check('AC-45 固定后面板保持打开（可以接着钉别的）', () => {
    assert.equal(pinned.panelOpen, true);
  });

  /* --- v1.4：📌 再点一次 = 取消固定（AC-47~AC-50） ---
     取消的是"子文件夹"挂件；面板对应的父文件夹挂件仍在，所以面板不会关闭。 */
  const pinnedPath = path.join(pinRoot, pinned.name);
  await openFolderPanel(win, pinItemId, 1);
  const unpinned = await js(
    win,
    `(async () => {
      const pin = document.querySelector('#folder-panel .fp-pin');
      pin.click();
      await new Promise((r) => setTimeout(r, 700));
      const st = await rope.getState();
      return {
        items: st.items.map((i) => ({ type: i.type, name: i.name, path: i.path })),
        pinOn: !!document.querySelector('#folder-panel .fp-pin.on'),
        pinTitle: document.querySelector('#folder-panel .fp-pin').title,
        panelOpen: !document.querySelector('#folder-panel').hidden,
        toast: document.querySelector('#toast').textContent,
      };
    })()`
  );

  await check('AC-47 再点同一个 📌 = 取消固定：挂件取回、📌 熄灭、面板不关闭', () => {
    assert.equal(unpinned.items.length, pinBefore, '挂件数应回到固定前');
    assert.ok(
      !unpinned.items.some((i) => i.path === pinnedPath),
      '该子文件夹不应还在绳上：' + JSON.stringify(unpinned.items.map((i) => i.path))
    );
    assert.equal(unpinned.pinOn, false, '📌 应回到未固定态');
    assert.match(unpinned.pinTitle, /固定到绳上/);
    assert.equal(unpinned.panelOpen, true);
    assert.match(unpinned.toast, /已取消固定/);
  });

  await openFolderPanel(win, pinItemId, 1);
  const repin = await js(
    win,
    `(async () => {
      const pin = document.querySelector('#folder-panel .fp-pin');
      pin.click();
      await new Promise((r) => setTimeout(r, 700));
      const st = await rope.getState();
      return {
        items: st.items.map((i) => ({ type: i.type, name: i.name, path: i.path })),
        pinOn: !!document.querySelector('#folder-panel .fp-pin.on'),
        toast: document.querySelector('#toast').textContent,
      };
    })()`
  );

  await check('AC-48 取消后再点可重新固定，且同一目标始终只有一件（不重复添加）', () => {
    const hits = repin.items.filter((i) => i.path === pinnedPath);
    assert.equal(hits.length, 1, '同一路径应恰好一个挂件');
    assert.equal(hits[0].type, 'folder');
    assert.equal(repin.items.length, pinBefore + 1);
    assert.equal(repin.pinOn, true);
    assert.match(repin.toast, /已固定/);
  });

  /* AC-49：从别处取下（模拟 Esc 取件 / 清空）后，展开面板里的金色态必须跟着熄灭 */
  await openFolderPanel(win, pinItemId, 1);
  const external = await js(
    win,
    `(async () => {
      const st = await rope.getState();
      const target = st.items.find((i) => i.path === ${JSON.stringify(pinnedPath)});
      if (target) rope.removeItem(target.id);
      // 等待期间模拟"鼠标停在面板上"（产品本来就不会收起），不重开面板
      rope.hover(true);
      const panelEl = document.querySelector('#folder-panel');
      for (let k = 0; k < 6; k++) {
        await new Promise((r) => setTimeout(r, 100));
        panelEl.dispatchEvent(new MouseEvent('mouseenter'));
      }
      const pin = document.querySelector('#folder-panel .fp-pin');
      return {
        pinOn: !!pin && pin.classList.contains('on'),
        panelOpen: !document.querySelector('#folder-panel').hidden,
        stillThere: (await rope.getState()).items.some((i) => i.path === ${JSON.stringify(
          pinnedPath
        )}),
      };
    })()`
  );

  await check('AC-49 从别处取下挂件后，展开面板里的 📌 自动熄灭', () => {
    assert.equal(external.stillThere, false, '挂件应已被取下');
    assert.equal(external.panelOpen, true, '取下子文件夹不应关掉父文件夹面板');
    assert.equal(external.pinOn, false, '📌 不应还留在已固定态');
  });

  /* AC-50：大小写变体被视为同一目标。v1.6 起所有产品入口统一去重，
     所以这两份"历史遗留的重复卡片"改用测试出口直接注入（模拟旧版本 state.json），
     断言标准不变：点一次 📌 必须一次全摘，不能出现"点了取消却还剩一张卡片"。 */
  const variantPath = pinnedPath.toUpperCase();
  T.injectRawItems([
    { id: 'legacy-pin-a', type: 'folder', path: pinnedPath, name: path.basename(pinnedPath), addedAt: 1 },
    { id: 'legacy-pin-b', type: 'folder', path: variantPath, name: path.basename(variantPath), addedAt: 2 },
  ]);
  let variantBefore = 0;
  try {
    variantBefore = await waitFor('两份等价挂件都挂上', async () => {
      const n = await js(win, 'rope.getState().then((s) => s.items.length)');
      return n >= pinBefore + 2 ? n : 0;
    }, 6000);
  } catch {
    // 等不到就如实记录当前数量，交给下面的 check 报错，而不是让整个场景崩掉
    variantBefore = await js(win, 'rope.getState().then((s) => s.items.length)');
  }
  await openFolderPanel(win, pinItemId, 1);
  const variantPinOn = await js(
    win,
    `!!document.querySelector('#folder-panel .fp-pin.on')`
  );
  const variantAfter = await js(
    win,
    `(async () => {
      const pin = document.querySelector('#folder-panel .fp-pin');
      pin.click();
      await new Promise((r) => setTimeout(r, 700));
      const st = await rope.getState();
      return {
        items: st.items.map((i) => i.path || ''),
        pinOn: !!document.querySelector('#folder-panel .fp-pin.on'),
        toast: document.querySelector('#toast').textContent,
      };
    })()`
  );
  const norm = (p) => p.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');

  await check('AC-50 等价路径变体的多份挂件被一次取消干净，不残留不新增', () => {
    assert.equal(variantBefore, pinBefore + 2, '两份等价路径都应挂上（前置条件）');
    assert.equal(variantPinOn, true, '大小写变体也应被判为"已固定"');
    assert.equal(variantAfter.items.length, pinBefore, '两份应被一次摘净');
    assert.ok(
      !variantAfter.items.some((p) => norm(p) === norm(pinnedPath)),
      '等价路径不应有残留：' + JSON.stringify(variantAfter.items)
    );
    assert.equal(variantAfter.pinOn, false);
    assert.match(variantAfter.toast, /已取消固定/);
  });

  /* 收尾：收起面板、摘掉临时夹具挂件、删掉临时目录，避免影响后续用例 */
  await js(
    win,
    `(() => { const el=[...document.querySelectorAll('.item')].find((n) => n.dataset.id === ${JSON.stringify(
      pinItemId
    )}); if (el) el.dispatchEvent(new MouseEvent('mouseleave')); return true; })()`
  );
  await sleep(500);
  const pinIds = await js(
    win,
    `rope.getState().then((s) => s.items.filter((i) => (i.path || '').toLowerCase().startsWith(${JSON.stringify(
      pinRoot.toLowerCase()
    )})).map((i) => i.id))`
  );
  for (const id of pinIds) await js(win, `rope.removeItem(${JSON.stringify(id)})`);
  await sleep(400);
  fs.rmSync(pinRoot, { recursive: true, force: true });

  /* --- 排序持久化 --- */
  const idsBefore = await js(win, 'rope.getState().then(s => s.items.map(i => i.id))');
  const reversed = idsBefore.slice().reverse();
  await js(win, `rope.reorder(${JSON.stringify(reversed)})`);
  await sleep(500);
  await check('AC-20 排序结果落盘且顺序一致', async () => {
    const now = await js(win, 'rope.getState().then(s => s.items.map(i => i.id))');
    assert.deepEqual(now, reversed);
    assert.deepEqual(readState().items.map((i) => i.id), reversed);
  });

  /* --- 文字拖出内容 --- */
  await check('AC-13 文字挂件 dragstart 携带 text/plain 原文', async () => {
    const got = await js(
      win,
      `(() => {
        const el = document.querySelector('.item.t-text');
        const dt = new DataTransfer();
        el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const v = dt.getData('text/plain');
        el.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
        return v;
      })()`
    );
    assert.equal(got, text);
  });

  /* --- 排序手势与防闪烁 --- */
  // 上一步的行拖出会把 ui.nativeDrag 置位（拖出兜底 2.5s），等它复位再做手势
  await waitFor('拖出标记复位', () => js(win, 'ui.nativeDrag === false'), 8000);
  const flick = await js(
    win,
    `(async () => {
      const el = document.querySelector('.item:not(.t-text)');
      const r = el.getBoundingClientRect();
      const mk = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true });
      el.dispatchEvent(new PointerEvent('pointerdown', mk(r.left + 20, r.top + 20)));
      const before = { press: !!ui.press, reorder: !!ui.reorder, native: ui.nativeDrag, connected: el.isConnected };
      // 等抬起：定时器 150ms，渲染进程忙时可能被推迟，用条件等待而不是写死时长
      await new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => {
          if (document.querySelector('.item.lifting')) return resolve();
          if (Date.now() - t0 > 2000) return resolve();
          setTimeout(tick, 25);
        };
        tick();
      });
      const samples = [];
      // 位移按"被拖卡片与相邻卡片里更宽的那个 + 间距"算：图片卡 120px、
      // 文件卡 86px，写死像素或只看自己宽度都可能跨不过相邻卡片的中心。
      const next = el.nextElementSibling;
      const step = Math.max(r.width, next ? next.getBoundingClientRect().width : 86) + 32;
      for (const k of [0, 0.6, 1.4, 2.6, 1.4, 0.6, 0]) {
        const x = r.left + 20 + step * k;
        document.dispatchEvent(new PointerEvent('pointermove', mk(x, r.top + 20)));
        await new Promise((res) => setTimeout(res, 70));
        const lifted = document.querySelector('.item.lifting');
        samples.push({
          lifted: !!lifted,
          x: Math.round(x),
          reordering: !!ui.reorder,
          opacity: lifted ? getComputedStyle(lifted).opacity : '',
          anims: lifted ? lifted.getAnimations().length : -1,
          order: [...document.querySelectorAll('.item')].map((n) => n.dataset.id).join(','),
        });
      }
      document.dispatchEvent(new PointerEvent('pointerup', mk(r.left + 20, r.top + 20)));
      return { samples, before, width: r.width, step, cls: el.className };
    })()`
  );

  await check('AC-19 按住 0.15 秒出现"抬起"效果', () => {
    assert.ok(flick.samples.some((s) => s.lifted), '应有 lifting 状态：' + JSON.stringify(flick));
  });
  await check('AC-22 排序全程卡片不透明度为 1（无闪烁）', () => {
    const lifted = flick.samples.filter((s) => s.lifted);
    assert.ok(lifted.length >= 3, '应采集到多次抬起样本：' + JSON.stringify(flick));
    for (const s of lifted) assert.equal(s.opacity, '1');
  });
  await check('AC-22 排序期间无动画重播（getAnimations = 0）', () => {
    for (const s of flick.samples.filter((x) => x.lifted)) assert.equal(s.anims, 0);
  });
  await check('AC-20 横向拖动过程中顺序跟随指针变化', () => {
    const orders = new Set(flick.samples.filter((s) => s.lifted).map((s) => s.order));
    assert.ok(
      orders.size >= 2,
      '顺序应随指针变化：' +
        JSON.stringify({
          step: flick.step,
          cls: flick.cls,
          samples: flick.samples.map((s) => ({ x: s.x, lifted: s.lifted, reordering: s.reordering, order: s.order })),
        })
    );
  });

  /* --- 拖拽排序的边缘自动滚动（v1.20） ---
     把挂件往绳的可视区边缘外拖（如把最右的挂件拖去最左）时，
     绳索应按指针深入边缘感应区的程度自动滚动，否则末端的槽位永远够不到。
     溢出量不够就先加文字挂件凑，测完按 id 清掉并还原顺序。 */
  const overflowBefore = await js(win, 'els.track.scrollWidth - els.track.clientWidth');
  const idsBeforeEdge = await js(win, 'rope.getState().then(s => s.items.map(i => i.id))');
  if (overflowBefore < 320) {
    await js(
      win,
      `(async () => {
        for (let i = 0; i < 15 && els.track.scrollWidth - els.track.clientWidth < 320; i++) {
          rope.addText('边缘自动滚动占位 ' + i);
          await new Promise((r) => setTimeout(r, 100));
        }
        return true;
      })()`
    );
    await sleep(300);
  }
  const edge = await js(
    win,
    `(async () => {
      const t = els.track;
      t.scrollLeft = t.scrollWidth;
      const el = t.querySelector('.item:not(.t-text)');
      if (!el) return { skip: true };
      const r = el.getBoundingClientRect();
      const mk = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true });
      const startY = r.top + 20;
      el.dispatchEvent(new PointerEvent('pointerdown', mk(r.left + 20, startY)));
      // 等抬起（LIFT_MS=150，忙时可能推迟，条件等待）
      await new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => {
          if (ui.reorder || Date.now() - t0 > 2000) return resolve();
          setTimeout(tick, 25);
        };
        tick();
      });
      if (!ui.reorder) return { skip: true, noLift: true };
      const rect = t.getBoundingClientRect();
      // 指针移进左边缘感应区（10px）后停住，只采样 scrollLeft
      document.dispatchEvent(new PointerEvent('pointermove', mk(rect.left + 10, startY)));
      const samples = [];
      for (let i = 0; i < 10; i++) {
        await new Promise((res) => setTimeout(res, 120));
        samples.push(Math.round(t.scrollLeft));
      }
      const duringDrag = { start: Math.round(t.scrollWidth - t.clientWidth), end: samples[samples.length - 1] };
      document.dispatchEvent(new PointerEvent('pointerup', mk(rect.left + 10, startY)));
      await new Promise((res) => setTimeout(res, 350));
      const idx = [...t.querySelectorAll('.item')].indexOf(el);
      return { duringDrag, samples, after: { left: Math.round(t.scrollLeft), raf: edgeScroll.raf, reordering: !!ui.reorder, idx } };
    })()`
  );
  await check('AC-152 拖到绳左边缘时自动滚动到头（末端槽位够得到）', () => {
    if (edge.skip) return assert.ok(!edge.noLift, '抬起失败：' + JSON.stringify(edge));
    assert.ok(edge.duringDrag.start > 0, '应存在溢出');
    assert.equal(edge.duringDrag.end, 0, '停住不动也应滚到 0：' + JSON.stringify(edge.duringDrag));
  });
  await check('AC-153 松手后自动滚动停止，挂件落到最左槽位', () => {
    assert.equal(edge.after.raf, 0, 'rAF 循环应停止');
    assert.equal(edge.after.reordering, false, '排序手势应结束');
    assert.equal(edge.after.idx, 0, '被拖挂件应排到最前：idx=' + edge.after.idx);
  });
  // 清理：删掉占位挂件、还原顺序
  const idsAfterEdge = await js(win, 'rope.getState().then(s => s.items.map(i => i.id))');
  const addedEdge = idsAfterEdge.filter((id) => !idsBeforeEdge.includes(id));
  for (const id of addedEdge) await js(win, `rope.removeItem(${JSON.stringify(id)})`);
  await js(win, `rope.reorder(${JSON.stringify(idsBeforeEdge)})`);
  await js(win, 'els.track.scrollLeft = 0');
  await sleep(400);

  /* --- 取件模式 --- */
  await js(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await sleep(200);
  await check('AC-23 按住 Esc 进入取件模式（红边提示 + 顶部提示条）', async () => {
    const st = await js(
      win,
      `({ mode: document.body.classList.contains('remove-mode'), hint: !document.querySelector('#remove-hint').hidden, badge: getComputedStyle(document.querySelector('.item'), '::after').content })`
    );
    assert.equal(st.mode, true);
    assert.equal(st.hint, true);
    assert.match(String(st.badge), /×/, '取下角标 v1.17 起改为 ×');
  });

  const countBeforeRemove = await itemCount(win);
  await js(win, `document.querySelector('.item').click()`);
  await waitFor('第一件取下', async () => (await itemCount(win)) === countBeforeRemove - 1);
  await js(win, `document.querySelector('.item').click()`);
  await waitFor('第二件取下', async () => (await itemCount(win)) === countBeforeRemove - 2);
  await check('AC-23/AC-24 按住期间可连续点击取下多件', async () => {
    assert.equal(await itemCount(win), countBeforeRemove - 2);
  });

  await js(win, `window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  await check('AC-25 松开 Esc 自动退出取件模式', async () => {
    const st = await js(
      win,
      `({ mode: document.body.classList.contains('remove-mode'), hint: document.querySelector('#remove-hint').hidden })`
    );
    assert.equal(st.mode, false);
    assert.equal(st.hint, true);
  });

  const countBeforeDbl = await itemCount(win);
  await js(win, `document.querySelector('.item').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(300);
  await check('AC-26 取件模式退出后双击不会误删', async () => {
    assert.equal(await itemCount(win), countBeforeDbl);
  });

  /* --- 复制即悬挂 --- */
  await js(win, 'document.querySelector("#copy-pill").click()');
  await sleep(300);
  await check('AC-27 点击胶囊开启"复制即悬挂"并高亮', async () => {
    const st = await js(
      win,
      '(async () => ({ on: document.querySelector("#copy-pill").classList.contains("on"), copy: (await rope.getState()).copyMode }))()'
    );
    assert.equal(st.on, true);
    assert.equal(st.copy, true);
  });

  T.showRope();
  await sleep(300);
  clipboard.writeText('剪贴板文字-唯一内容-A1');
  T.onPastePressed();
  await sleep(500);
  const afterPaste = await itemCount(win);
  await check('AC-30 悬停绳索时 Ctrl+V 把剪贴板文字挂上', () => {
    assert.ok(afterPaste >= countBeforeDbl + 1, '应新增一件');
  });

  T.onPastePressed();
  await sleep(500);
  await check('AC-29 重复粘贴同样内容不会重复悬挂', async () => {
    assert.equal(await itemCount(win), afterPaste);
  });

  /* AC-28：资源管理器"复制文件"（FileNameW）自动悬挂 */
  const clipFile = path.join(userData, 'clip-file.txt');
  fs.writeFileSync(clipFile, 'clip');
  let clipFormatOk = true;
  try {
    clipboard.writeBuffer('FileNameW', Buffer.from(clipFile + '\0', 'utf16le'));
  } catch {
    clipFormatOk = false;
  }
  await check('样本准备：把文件写入剪贴板（FileNameW 格式）', () => {
    assert.equal(clipFormatOk, true, '当前 Electron 不支持写入 FileNameW');
  });
  if (clipFormatOk) {
    const beforeClip = await itemCount(win);
    T.onPastePressed();
    await sleep(600);
    await check('AC-28 复制文件后可自动悬挂（不是把路径当文字）', async () => {
      assert.equal(await itemCount(win), beforeClip + 1, '应新增一件');
      const st = await js(
        win,
        `rope.getState().then(s => (s.items.find(i => i.path && i.path.toLowerCase() === ${JSON.stringify(
          clipFile.toLowerCase()
        )}) || {}).type)`
      );
      assert.equal(st, 'file');
    });
  }

  await check('AC-14 拖出计划不改动源文件（只读路径引用）', async () => {
    const before = fs.statSync(iconPath);
    const plan = T.planDrag({ kind: 'file', path: iconPath });
    const after = fs.statSync(iconPath);
    assert.equal(plan.ok, true);
    assert.equal(plan.target, iconPath);
    assert.equal(before.size, after.size);
    assert.equal(before.mtimeMs, after.mtimeMs);
  });

  /* AC-21：抬起后向下拖出窗口 → 转为对外拖出 */
  const dragLogBeforeDown = T.dragLog.length;
  await js(
    win,
    `(async () => {
      const el = document.querySelector('.item:not(.t-text)');
      const r = el.getBoundingClientRect();
      const mk = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 3, pointerType: 'mouse', isPrimary: true });
      el.dispatchEvent(new PointerEvent('pointerdown', mk(r.left + 10, r.top + 10)));
      await new Promise((res) => setTimeout(res, 260));
      document.dispatchEvent(new PointerEvent('pointermove', mk(r.left + 10, window.innerHeight + 60)));
      document.dispatchEvent(new PointerEvent('pointerup', mk(r.left + 10, window.innerHeight + 60)));
      return true;
    })()`
  );
  await sleep(400);
  await check('AC-21 抬起后向下拖出窗口底边 → 转为对外拖出', () => {
    assert.ok(T.dragLog.length > dragLogBeforeDown, '应产生一次拖出载荷');
    const last = T.dragLog[T.dragLog.length - 1];
    assert.ok(last.target && fs.existsSync(last.target), '目标应存在：' + last.target);
  });

  /* --- 轨道横向滚动 --- */
  // v1.19 起滚轮是平滑滚动（rAF 逐帧收敛到累积目标），不再逐格瞬跳：
  // 断言前先等 scrollLeft 停稳，再以停稳值作为下一步的基线
  const settledLeft = async () => {
    let prev = await js(win, 'document.querySelector("#track").scrollLeft');
    for (;;) {
      await sleep(160);
      const cur = await js(win, 'document.querySelector("#track").scrollLeft');
      if (cur === prev) return cur;
      prev = cur;
    }
  };
  await js(win, `(() => { for (let i = 0; i < 8; i++) rope.addText('轨道滚动测试-' + i); return true; })()`);
  await waitFor('轨道溢出', async () => {
    return js(win, '(() => { const t=document.querySelector("#track"); return t.scrollWidth - t.clientWidth > 0; })()');
  });
  await check('F3 挂件超出宽度时轨道可横向滚动', async () => {
    await js(
      win,
      `(() => { const t=document.querySelector('#track'); t.dispatchEvent(new WheelEvent('wheel',{deltaY:200,bubbles:true,cancelable:true})); return true; })()`
    );
    const left = await settledLeft();
    assert.ok(left > 0, 'scrollLeft 应大于 0，实际 ' + left);
  });

  /* AC-39：鼠标不在挂件上、而在绳索条底部的背景空白处，滚轮同样能横向滚动 */
  const bgBefore = await settledLeft();
  await js(
    win,
    `(() => {
      const t = document.querySelector('#track');
      t.scrollLeft = 0;
      const x = Math.round(t.getBoundingClientRect().left + 30);
      const y = window.innerHeight - 4;                 // 卡片下方的背景空白（黄圈①处）
      const el = document.elementFromPoint(x, y) || document.querySelector('#shell');
      const where = (el.id || el.className || el.tagName) + '';
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true }));
      return { where };
    })()`
  );
  await check('AC-39 在挂件下方的背景空白处滚轮 = 横向滚动', async () => {
    const left = await settledLeft();
    assert.ok(left > 0, `scrollLeft 应 > 0，实际 ${left}（平滑滚动应已到位）`);
  });

  const bgScrollUp = { before: await settledLeft() };
  await js(
    win,
    `(() => {
      const t = document.querySelector('#track');
      const el = document.querySelector('#shell');
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
      return true;
    })()`
  );
  await check('AC-39 反向滚轮往回滚', async () => {
    const after = await waitFor('scrollLeft 回落', () =>
      js(win, `(() => { const t = document.querySelector('#track'); return t.scrollLeft < ${bgScrollUp.before} ? t.scrollLeft : false; })()`)
    );
    assert.ok(after < bgScrollUp.before, `${bgScrollUp.before} → ${after}`);
  });

  /* AC-39 后半：文件夹面板上的滚轮只翻列表，不横向滚动绳索 */
  await js(win, `rope.addPaths(${JSON.stringify([path.join(ROOT, 'src')])})`);
  await waitFor('重新挂上文件夹', async () => (await js(win, 'document.querySelectorAll(".item.t-folder").length')) >= 1);
  await js(
    win,
    `(() => { const el=[...document.querySelectorAll('.item')].find(n=>n.classList.contains('t-folder')); el.dispatchEvent(new MouseEvent('mouseenter')); return true; })()`
  );
  await sleep(800);
  await waitFor('文件夹面板展开', () =>
    js(win, `(() => { const p=document.querySelector('#folder-panel'); return !p.hidden && !!p.querySelector('.fp-counter'); })()`)
  );
  const panelWheel = await js(
    win,
    `(() => {
      const t = document.querySelector('#track');
      const p = document.querySelector('#folder-panel');
      t.scrollLeft = Math.min(50, t.scrollWidth - t.clientWidth);
      const before = t.scrollLeft;
      const c0 = (p.querySelector('.fp-counter') || {}).textContent || '';
      p.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
      return {
        before,
        after: t.scrollLeft,
        c0,
        c1: (p.querySelector('.fp-counter') || {}).textContent || '',
        rows: p.querySelectorAll('.fp-row').length,
        hidden: p.hidden,
      };
    })()`
  );
  await check('AC-39 文件夹面板上滚轮只翻列表，不横向滚动绳索', () => {
    const info = JSON.stringify(panelWheel);
    assert.equal(panelWheel.hidden, false, info);
    assert.ok(panelWheel.rows > 0, info);
    assert.notEqual(panelWheel.c1, panelWheel.c0, '面板计数应变化：' + info);
    assert.equal(panelWheel.after, panelWheel.before, '轨道不应被横向滚动：' + info);
  });
  await js(
    win,
    `(() => { const el=[...document.querySelectorAll('.item')].find(n=>n.classList.contains('t-folder')); el.dispatchEvent(new MouseEvent('mouseleave')); return true; })()`
  );
  await sleep(500);


  /* --- 设置：独立普通窗口 --- */
  await js(win, 'document.querySelector("#btn-settings").click()');
  const sw = await waitSettingsWindow();
  await check('AC-40 点「设置」打开的是独立窗口（绳索窗口之外多出一个窗口）', () => {
    const all = BrowserWindow.getAllWindows();
    assert.equal(all.length, 2, '窗口数应为 2，实际 ' + all.length);
    assert.notEqual(sw.id, win.id, '不能是绳索窗口本身');
    assert.equal(sw.getParentWindow(), null, '不应该是绳索窗口的子窗口');
  });

  await check('AC-41 设置窗口是普通窗口：系统标题栏可关闭、可缩放、不置顶', async () => {
    const view = await js(
      sw,
      `({ titlebarPx: window.outerHeight - window.innerHeight, dir: document.querySelector('#cache-dir').textContent,
          limit: document.querySelector('#limit-input').value, usage: document.querySelector('#cache-usage').textContent,
          hotkey: document.querySelector('#hotkey-label').textContent, items: document.querySelector('#item-count').textContent })`
    );
    assert.equal(sw.isClosable(), true, '必须可关闭');
    assert.equal(sw.isResizable(), true, '必须可缩放');
    assert.equal(sw.isAlwaysOnTop(), false, '不应该置顶');
    assert.ok(view.titlebarPx >= 20, '应有系统标题栏（含右上角关闭按钮），实际 ' + view.titlebarPx);
    assert.ok(view.dir.length > 3, '缓存目录不应为空');
    assert.equal(view.limit, '200');
    assert.match(view.usage, /MB/);
    assert.match(view.hotkey, /H/);
    assert.match(view.items, /件/);
  });

  await check('AC-42 绳索收回后设置窗口仍然存在（不随顶部失焦消失）', async () => {
    T.hideRope(true);
    await sleep(700);
    assert.ok(sw.isDestroyed() === false, '设置窗口不应被销毁');
    assert.equal(sw.isVisible(), true, '绳索收回后设置窗口应仍可见');
    assert.ok(BrowserWindow.getAllWindows().some((w) => w.id === sw.id), '设置窗口应还在窗口列表里');
    T.showRope();
    await sleep(500);
  });

  await js(sw, 'document.querySelector("#limit-input").value = "50"; document.querySelector("#btn-save-limit").click(); true');
  await sleep(600);
  await check('AC-35 在设置窗口改缓存上限后持久化', async () => {
    assert.equal(readState().settings.cacheLimitMB, 50);
    assert.equal(await js(sw, 'document.querySelector("#limit-input").value'), '50');
  });

  await check('AC-43 Esc 可关闭设置窗口，重开后是新窗口且只有一个', async () => {
    await js(sw, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    for (let i = 0; i < 40 && !sw.isDestroyed(); i++) await sleep(50);
    assert.equal(sw.isDestroyed(), true, 'Esc 后设置窗口应被关闭');
    assert.equal(T.getSettingsWindow(), null, '关闭后主进程不应留着窗口引用');

    T.openSettingsWindow();
    const again = await waitSettingsWindow();
    assert.notEqual(again.id, sw.id, '重开应是新窗口');
    assert.equal(BrowserWindow.getAllWindows().length, 2, '任何时候只允许一个设置窗口');
    again.close();
    for (let i = 0; i < 40 && T.getSettingsWindow(); i++) await sleep(50);
  });

  /* --- 清空 --- */
  await js(win, 'rope.clearAll()');
  await sleep(500);
  await check('F3 清空按钮清空全部挂件并落盘', async () => {
    assert.equal(await itemCount(win), 0);
    assert.deepEqual(readState().items, []);
    assert.equal(await js(win, 'document.querySelector("#empty-hint").hidden'), false);
  });

  await check('AC-36 无渲染进程崩溃记录', () => {
    assert.equal(fs.existsSync(path.join(userData, 'crash.log')), false);
  });
}

/* ---------------- 场景：Office 文件图标（v1.11） ---------------- */

function officeCards(win) {
  return js(
    win,
    `(() => [...document.querySelectorAll('.item')].map((el) => {
      const im = el.querySelector('img.office-icon');
      const d = el.querySelector('.doc-shape');
      const nm = el.querySelector('.name');
      return {
        name: nm ? nm.textContent.trim() : '',
        office: im ? im.dataset.office : '',
        src: im ? im.getAttribute('src') : '',
        loaded: im ? (im.complete && im.naturalWidth > 0) : false,
        alt: im ? im.getAttribute('alt') : null,
        drag: im ? im.draggable : null,
        doc: d ? d.textContent.trim() : '',
        w: el.offsetWidth,
        h: el.offsetHeight,
      };
    }))()`
  );
}

async function runOfficeIcons(win) {
  T.showRope();
  await sleep(400);
  await installMouseShield(win);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-office-'));
  const names = [
    '论文格式.docx', '旧稿.DOC', '预算.xlsx', '台账.XLS',
    '汇报.pptx', '胶片.PPT', '说明.txt',
  ];
  const files = names.map((n) => path.join(root, n));
  for (const p of files) fs.writeFileSync(p, 'office icon fixture');
  const folder = path.join(root, '办公目录');
  fs.mkdirSync(folder);
  // 按 a/b/c/d 命名，localeCompare 排序后前 3 行正好是三款 Office 图标（面板只显示 3 行）
  for (const n of ['a.docx', 'b.xlsx', 'c.pptx', 'd.txt']) {
    fs.writeFileSync(path.join(folder, n), 'x');
  }

  await js(win, `rope.addPaths(${JSON.stringify(files)}); true`);
  await waitFor('7 个文件挂件出现', async () => (await itemCount(win)) === 7);
  // DOM 挂上不等于 SVG 解码完：早期版本在这里直接取快照，全量连跑时偶发
  // naturalWidth=0 的假失败。等到 6 张 Office 图标都真正加载完再断言。
  await waitFor(
    '6 张 Office SVG 加载完成',
    () =>
      js(
        win,
        `(() => { const a = [...document.querySelectorAll('img.office-icon')];
           return a.length === 6 && a.every((i) => i.complete && i.naturalWidth > 0); })()`
      ),
    10000
  );
  const cards = await officeCards(win);
  const byName = (n) => cards.find((c) => c.name === n) || {};

  const iconCases = [
    ['AC-85 Word 文档显示 Word 图标（.docx / .DOC 大小写都识别，SVG 真实加载）',
      ['论文格式.docx', '旧稿.DOC'], 'word', /office-word\.svg$/],
    ['AC-86 Excel 表格显示 Excel 图标（.xlsx / .XLS）',
      ['预算.xlsx', '台账.XLS'], 'excel', /office-excel\.svg$/],
    ['AC-87 PowerPoint 演示显示 PowerPoint 图标（.pptx / .PPT）',
      ['汇报.pptx', '胶片.PPT'], 'powerpoint', /office-powerpoint\.svg$/],
  ];
  for (const [title, ns, kind, srcRe] of iconCases) {
    await check(title, () => {
      for (const n of ns) {
        const c = byName(n);
        assert.equal(c.office, kind, n + ' 应显示 ' + kind + ' 图标');
        assert.match(c.src, srcRe, n + ' 应指向对应 SVG 资源');
        assert.equal(c.loaded, true, n + ' 的 SVG 应成功加载（naturalWidth > 0）');
        assert.equal(c.doc, '', n + ' 不应再显示通用扩展名文字卡');
      }
    });
  }

  await check('AC-88 非 Office 文件仍是通用文档形状，显示 TXT', () => {
    const c = byName('说明.txt');
    assert.equal(c.office, '');
    assert.equal(c.doc, 'TXT');
  });

  await check('AC-89 换图标不改结构：7 张卡都是 86×104 且名称行完整', () => {
    assert.equal(cards.length, 7);
    for (const c of cards) {
      assert.equal(c.w, 86, c.name + ' 宽度');
      assert.equal(c.h, 104, c.name + ' 高度');
      assert.ok(names.includes(c.name), '名称行应完整保留：' + c.name);
    }
  });

  await check('AC-90 图标是纯装饰图片：alt 为空、不可拖动、不抢指针事件', async () => {
    const c = byName('论文格式.docx');
    assert.equal(c.alt, '');
    assert.equal(c.drag, false);
    const pe = await js(win, `getComputedStyle(document.querySelector('img.office-icon')).pointerEvents`);
    assert.equal(pe, 'none');
  });

  await js(win, `rope.addPaths(${JSON.stringify([folder])}); true`);
  const folderId = await waitItemId(win, folder, '办公目录挂件出现');
  await openFolderPanel(win, folderId, 3);
  await waitFor(
    '面板 3 张 Office SVG 加载完成',
    () =>
      js(
        win,
        `(() => { const a = [...document.querySelectorAll('#folder-panel .fp-row img.office-icon')];
           return a.length === 3 && a.every((i) => i.complete && i.naturalWidth > 0); })()`
      ),
    10000
  );
  await check('AC-91 文件夹面板里的 Office 行也换成对应图标', async () => {
    const rows = await js(
      win,
      `(() => [...document.querySelectorAll('#folder-panel .fp-row')].map((r) => {
        const im = r.querySelector('img.office-icon');
        const d = r.querySelector('.doc-shape');
        return {
          name: r.querySelector('.fp-row-name').textContent.trim(),
          office: im ? im.dataset.office : '',
          loaded: im ? (im.complete && im.naturalWidth > 0) : false,
          doc: d ? d.textContent.trim() : '',
        };
      }))()`
    );
    assert.deepEqual(rows.map((r) => r.name), ['a.docx', 'b.xlsx', 'c.pptx']);
    assert.deepEqual(rows.map((r) => r.office), ['word', 'excel', 'powerpoint']);
    for (const r of rows) {
      assert.equal(r.loaded, true, r.name + ' 面板图标应加载成功');
      assert.equal(r.doc, '', r.name + ' 面板里不应再是文字卡');
    }
  });

  await check('AC-92 深色主题下三款图标仍完整可见（不加滤镜、不失效）', async () => {
    await js(win, `ropeTheme.apply('dark'); true`);
    const r = await js(
      win,
      `(() => {
        const ims = [...document.querySelectorAll('.item img.office-icon')];
        return {
          theme: document.documentElement.getAttribute('data-theme'),
          count: ims.length,
          loaded: ims.every((im) => im.complete && im.naturalWidth > 0),
          filter: ims.length ? getComputedStyle(ims[0]).filter : '',
          opacity: ims.length ? getComputedStyle(ims[0]).opacity : '',
        };
      })()`
    );
    assert.equal(r.theme, 'dark');
    assert.equal(r.count, 6, '6 个 Office 挂件都该有图标');
    assert.equal(r.loaded, true);
    assert.equal(r.filter, 'none', '深色下不给彩色图标加滤镜');
    assert.equal(r.opacity, '1');
    await js(win, `ropeTheme.apply('light'); true`);
  });

  await check('AC-93 SVG 加载失败时静默回退到通用文档形状，不留破图标', async () => {
    const before = await js(
      win,
      `(() => {
        const el = [...document.querySelectorAll('.item')].find(
          (n) => (n.querySelector('.name') || {}).textContent.trim() === '论文格式.docx'
        );
        const im = el.querySelector('img.office-icon');
        im.dispatchEvent(new Event('error'));
        return true;
      })()`
    );
    assert.equal(before, true);
    const after = (await officeCards(win)).find((c) => c.name === '论文格式.docx');
    assert.equal(after.office, '', '应已换成通用形状');
    assert.equal(after.doc, 'DOCX', '回退后仍显示扩展名');
    assert.equal(after.w, 86, '回退不改变卡片宽度');
    assert.equal(after.h, 104, '回退不改变卡片高度');
  });
}

/* ---------------- 场景：挂件件数上限（v1.12） ---------------- */

async function runItemLimit(win) {
  T.showRope();
  await sleep(400);
  await installMouseShield(win);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-item-limit-'));
  const files = [];
  for (let i = 0; i < 210; i++) {
    const p = path.join(root, 'f' + String(i).padStart(4, '0') + '.txt');
    fs.writeFileSync(p, 'limit fixture');
    files.push(p);
  }
  const extra = path.join(root, 'extra.txt');
  fs.writeFileSync(extra, 'extra');

  const toastText = () => js(win, 'document.querySelector("#toast").textContent');
  const clearToast = () => js(win, `document.querySelector('#toast').textContent = ''; true`);
  const waitToast = (re) => waitFor('提示 ' + re, async () => re.test(await toastText()), 5000);
  const setLimit = async (n) => {
    await js(win, `rope.setItemLimit(${JSON.stringify(n)}); true`);
    await waitFor('上限设为 ' + n, () => T.settingsSnapshot().settings.itemLimit === n);
  };
  const settle = (n) => waitFor('挂件数 ' + n, async () => (await itemCount(win)) === n, 12000);
  const count = () => T.settingsSnapshot().itemCount;
  const cacheFiles = () => {
    const dir = T.settingsSnapshot().settings.resolvedCacheDir;
    return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  };

  await check('AC-104 默认上限 300，白名单恰好 6 档（含默认档，可再选回来）', () => {
    assert.equal(T.settingsSnapshot().settings.itemLimit, 300);
    assert.deepEqual(
      require(path.join(ROOT, 'src', 'main', 'store')).ITEM_LIMITS,
      [200, 300, 350, 400, 450, 500]
    );
  });

  T.addPaths(files.slice(0, 198));
  await settle(198);
  await setLimit(200); // 只剩 2 个名额

  await clearToast();
  const partial = T.addPaths(files.slice(198, 202));
  await check('AC-105 批量只挂到上限：4 件里挂上 2 件、另 2 件被拦并提示', async () => {
    assert.equal(partial.length, 2, '应只放行剩余 2 个名额');
    assert.equal(count(), 200);
    await waitToast(/已达上限 200 件，跳过 2 件/);
  });
  // 不写死 200：让 DOM 追上主进程状态即可，避免异常情况下场景直接超时中断
  await waitFor('DOM 与状态件数一致', async () => (await itemCount(win)) === count(), 12000);

  await clearToast();
  const one = T.addPaths([files[202]]);
  await check('AC-106 满额后单件添加被拦，挂件数不变', async () => {
    assert.deepEqual(one, []);
    assert.equal(count(), 200);
    await waitToast(/已达上限 200 件/);
  });

  const pin = await js(win, `rope.pinPath(${JSON.stringify(files[203])})`);
  await check('AC-107 📌 固定满额时返回 limit，并给出可操作的提示', () => {
    assert.equal(pin.ok, false);
    assert.equal(pin.reason, 'limit');
    assert.match(pin.message, /上限|设置/);
    assert.equal(count(), 200);
  });

  const textItem = T.addTextItem('上限核对文字');
  await check('AC-108 文字挂件满额时被拦', () => {
    assert.equal(textItem, null);
    assert.equal(count(), 200);
  });

  const beforeCache = cacheFiles();
  const png = fs.readFileSync(path.join(ROOT, 'assets', 'icon.png'));
  const imgItem = T.addImageBuffer(png, 'png');
  await check('AC-109 图片挂件满额时被拦，且不留无引用的缓存副本', () => {
    assert.equal(imgItem, null);
    assert.equal(count(), 200);
    assert.equal(cacheFiles(), beforeCache, '不能写出挂不上的孤儿图片副本');
  });

  await clearToast();
  T.onPastePressed();
  await check('AC-110 复制即悬挂 / Ctrl+V 满额时说明原因，轮询不刷屏', async () => {
    await waitToast(/已达上限 200 件，未添加/);
    assert.equal(count(), 200);
  });

  await setLimit(350);
  T.addPaths(files.slice(202, 206));
  await check('AC-111 调高档位后立刻可以继续挂', async () => {
    await settle(204);
    assert.equal(count(), 204);
  });

  await setLimit(200);
  await check('AC-112 调低上限不删除已有挂件，只拦新增（204 > 200）', () => {
    assert.equal(count(), 204, '已有挂件一件都不能丢');
    assert.deepEqual(T.addPaths([extra]), []);
    assert.equal(count(), 204);
  });

  for (const bad of [999, '350', null]) {
    await js(win, `rope.setItemLimit(${JSON.stringify(bad)}); true`);
  }
  await sleep(300);
  await js(win, `rope.setTheme('dark'); true`);
  await waitFor('深色生效', () => T.settingsSnapshot().settings.theme === 'dark');
  await sleep(350);
  await check('AC-113 非法档位一律忽略；主题切换不覆盖上限；设置写入 state.json', () => {
    assert.equal(T.settingsSnapshot().settings.itemLimit, 200);
    const s = readState().settings;
    assert.equal(s.itemLimit, 200);
    assert.equal(s.theme, 'dark');
  });

  await js(win, 'document.querySelector("#btn-settings").click()');
  const sw = await waitSettingsWindow();
  await sleep(400);
  const picker = () =>
    js(
      sw,
      `(() => [...document.querySelectorAll('.limit-opt')].map((b) => ({
        v: Number(b.dataset.limitValue),
        on: b.classList.contains('on'),
        pressed: b.getAttribute('aria-pressed'),
      })))()`
    );

  await check('AC-114 设置窗口 6 档选择器与真实设置一致，超出上限有明确说明', async () => {
    const p = await picker();
    assert.deepEqual(p.map((x) => x.v), [200, 300, 350, 400, 450, 500]);
    assert.deepEqual(p.map((x) => x.on), [true, false, false, false, false, false]);
    assert.deepEqual(p.map((x) => x.pressed), ['true', 'false', 'false', 'false', 'false', 'false']);
    const note = await js(
      sw,
      `(() => { const e = document.querySelector('#limit-note');
        return { text: e.textContent, warn: e.classList.contains('warn') }; })()`
    );
    assert.match(note.text, /超出上限 4 件/);
    assert.equal(note.warn, true);
    const cnt = await js(sw, `document.querySelector('#item-count').textContent`);
    assert.match(cnt, /当前 204 件 \/ 上限 200 件/);
  });

  await js(sw, `document.querySelector('.limit-opt[data-limit-value="500"]').click(); true`);
  await waitFor('UI 切到 500', () => T.settingsSnapshot().settings.itemLimit === 500);
  await check('AC-115 点击档位即刻生效、落盘，选中态与 aria-pressed 同步', async () => {
    await waitFor('UI 选中 500', async () => {
      const p = await picker();
      const cur = p.find((x) => x.v === 500);
      return cur.on && cur.pressed === 'true';
    });
    // state.json 有 150ms 防抖，等落盘完成再读，别把"还没写"误判成"没生效"
    await waitFor('上限落盘 500', () => readState().settings.itemLimit === 500);
    assert.equal(T.settingsSnapshot().settings.itemLimit, 500);
    assert.equal(readState().settings.itemLimit, 500);
  });

  await check('AC-116 新增一行后设置窗口仍不滚动、底部按钮完整，深色选中态为蓝色', async () => {
    const layout = await settingsLayout(sw);
    assert.equal(layout.mainMinHeight, '0px');
    assert.ok(layout.footer.bottom <= layout.winH + 1, 'footer 不能被窗口裁切');
    const winH = T.getSettingsWindow().getBounds().height;
    if (winH >= 650) {
      assert.ok(
        layout.mainScroll <= layout.mainClient + 2,
        `默认窗口高 ${winH} 时内容仍要滚动：${layout.mainScroll} > ${layout.mainClient}`
      );
    }
    // 选中态有 140ms 背景过渡，等颜色稳定再取计算样式
    await waitFor(
      '深色选中态蓝色稳定',
      async () =>
        (await js(sw, `getComputedStyle(document.querySelector('.limit-opt.on')).backgroundColor`)) ===
        'rgb(91, 147, 255)',
      4000
    );
    const bg = await js(sw, `getComputedStyle(document.querySelector('.limit-opt.on')).backgroundColor`);
    assert.equal(bg, 'rgb(91, 147, 255)', '深色下选中档位应仍是蓝色实心');
  });

  await check('AC-161 「关于」卡片显示版本号，与 app.getVersion() 一致', async () => {
    const h2s = await js(sw, "[...document.querySelectorAll('.card h2')].map(h => h.textContent)");
    assert.ok(h2s.includes('关于'), '应存在「关于」分组：' + h2s.join(','));
    const ver = await js(sw, "document.querySelector('#app-version').textContent");
    assert.match(ver, /^\d+\.\d+\.\d+$/, '版本号应为 x.y.z 格式：' + ver);
    assert.equal(ver, app.getVersion(), '渲染层显示应与主进程 app.getVersion() 一致');
  });

  await check('AC-36 本场景无渲染进程崩溃记录', () => {
    assert.equal(fs.existsSync(path.join(userData, 'crash.log')), false);
  });
  sw.close();
}

/* ---------------- 场景：恢复 / 不恢复 ---------------- */

async function runRestore(win, expectRestore) {
  const expected = JSON.parse(fs.readFileSync(path.join(userData, 'seed.json'), 'utf8')).items;

  if (expectRestore) {
    await waitFor('恢复后的挂件', async () => (await itemCount(win)) === expected.length);
    await check('AC-10 选择恢复后挂件数量与顺序与关机前一致', async () => {
      const ids = await js(win, 'rope.getState().then(s => s.items.map(i => i.id))');
      assert.deepEqual(ids, expected.map((i) => i.id));
      const domIds = await js(win, '[...document.querySelectorAll(".item")].map(n => n.dataset.id)');
      assert.deepEqual(domIds, expected.map((i) => i.id));
    });
    await check('F8 恢复的内容类型正确（文字/图片/文件/文件夹）', async () => {
      const kinds = await js(win, 'rope.getState().then(s => s.items.map(i => i.type))');
      assert.deepEqual(kinds, expected.map((i) => i.type));
    });
  } else {
    await waitFor('清空后的挂件', async () => (await itemCount(win)) === 0);
    await sleep(400);
    await check('AC-10 选择不恢复后挂件清空且记录落盘', () => {
      assert.deepEqual(readState().items, []);
    });
  }
}

/* ---------------- 场景：快捷方式 ---------------- */

async function runShortcut(win) {
  const target = path.join(userData, 'target.txt');
  fs.writeFileSync(target, 'hello');
  const lnk = path.join(userData, 'target 快捷方式.lnk');

  let created = false;
  try {
    created = shell.writeShortcutLink(lnk, 'create', { target });
  } catch (e) {
    created = false;
  }

  await check('样本准备：创建指向真实文件的 .lnk', () => {
    assert.equal(created, true);
    assert.ok(fs.existsSync(lnk));
  });

  T.addPaths([lnk]);
  await sleep(400);

  await check('AC-31 挂入 .lnk 后映射到本体（路径/名称/类型）', () => {
    const it = T.snapshot().items.find((i) => i.path === target || i.path === lnk);
    assert.ok(it, '应存在对应挂件');
    assert.equal(it.path, target, '应存本体路径');
    assert.equal(it.name, 'target.txt');
    assert.equal(it.type, 'file');
    assert.equal(it.shortcut, lnk, '应记录来源快捷方式');
  });

  await check('AC-31 拖出计划发送本体而非快捷方式', () => {
    const plan = T.planDrag({ kind: 'file', path: lnk });
    assert.equal(plan.ok, true);
    assert.equal(plan.target, target);
    assert.equal(plan.warning, '');
  });

  const dangling = path.join(userData, 'gone 快捷方式.lnk');
  fs.writeFileSync(dangling, 'this is not a real shortcut');
  T.addPaths([dangling]);
  await sleep(400);

  await check('AC-32 悬空快捷方式保留原样（不解析、不删除）', () => {
    const it = T.snapshot().items.find((i) => i.path === dangling);
    assert.ok(it, '挂件应保留');
    assert.equal(it.path, dangling);
  });

  await check('AC-32 悬空快捷方式拖出时降级发送 .lnk 并提示', () => {
    const plan = T.planDrag({ kind: 'file', path: dangling });
    assert.equal(plan.ok, true);
    assert.equal(plan.target, dangling);
    assert.match(plan.warning, /不存在/);
  });

  await check('AC-36 无渲染进程崩溃记录', () => {
    assert.equal(fs.existsSync(path.join(userData, 'crash.log')), false);
  });
}

/* ---------------- 场景：单击复制 / 双击打开（v1.5） ----------------
   独立场景，不与 basic 的手势用例抢剪贴板 / nativeDrag 保护窗口。
   HANGING_ROPE_TEST_DRY_OPEN=1 让双击只记载荷，不真的弹出系统程序。 */

async function runClick(win) {
  T.showRope();
  await sleep(500);
  await installMouseShield(win);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-click-'));
  const aFile = path.join(root, '文档.txt');
  fs.writeFileSync(aFile, '单击复制用文件');
  const aDir = path.join(root, '子目录');
  fs.mkdirSync(aDir);
  fs.writeFileSync(path.join(aDir, '内层.txt'), 'inner');
  fs.mkdirSync(path.join(aDir, '更深的目录'));
  const imgSrc = path.join(ROOT, 'assets', 'icon.png');

  await js(win, `rope.addText('单击复制测试文本'); true`);
  await js(win, `rope.addPaths(${JSON.stringify([aFile, aDir])}); true`);
  T.addImageBuffer(fs.readFileSync(imgSrc), 'png', { mime: 'image/png', name: 'icon.png' });
  await waitFor('四件挂件就位', async () => (await itemCount(win)) === 4);

  const clipText = () => clipboard.readText();
  const clipFiles = () =>
    clipboard
      .readBuffer('FileNameW')
      .toString('utf16le')
      .split('\0')
      .filter(Boolean);
  const clickEl = (selector, detail = 1) =>
    js(
      win,
      `(() => { const el = document.querySelector(${JSON.stringify(
        selector
      )}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: ${detail} })); return true; })()`
    );
  const dblEl = (selector) =>
    js(
      win,
      `(() => { const el = document.querySelector(${JSON.stringify(
        selector
      )}); if (!el) return false;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
        return true; })()`
    );
  const toastText = () => js(win, 'document.querySelector("#toast").textContent');

  /* --- AC-51~53：单击 = 复制到系统剪贴板 --- */
  clipboard.writeText('SENTINEL-51');
  const textClicked = await clickEl('.item.t-text');
  await sleep(350);
  await check('AC-51 单击文字挂件 = 原文进剪贴板，并有提示', async () => {
    assert.equal(textClicked, true);
    assert.equal(clipText(), '单击复制测试文本');
    assert.match(await toastText(), /已复制/);
  });

  clipboard.writeText('SENTINEL-52');
  await clickEl('.item.t-file');
  await sleep(350);
  await check('AC-52 单击文件挂件 = 剪贴板里可粘贴的文件对象', async () => {
    assert.deepEqual(clipFiles(), [aFile], 'FileNameW 应只有该文件的绝对路径');
    assert.equal(clipText(), '', '文件对象不应退化成路径文本');
    assert.match(await toastText(), /已复制/);
  });

  clipboard.writeText('SENTINEL-53');
  const imgClicked = await js(
    win,
    `rope.getState().then((s) => {
      const it = s.items.find((i) => i.type === 'image');
      const el = it && document.querySelector('.item[data-id="' + it.id + '"]');
      if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      return !!el;
    })`
  );
  await sleep(350);
  await check('AC-53 单击图片挂件 = 图片内容进剪贴板', () => {
    assert.equal(imgClicked, true);
    const img = clipboard.readImage();
    assert.equal(img.isEmpty(), false, '应写入图片');
    assert.ok(img.getSize().width > 0, '图片应有尺寸');
  });

  /* --- AC-54~55：双击 = 用系统默认程序打开 --- */
  const openBefore = T.openLog.length;
  await dblEl('.item.t-file');
  await dblEl('.item.t-folder');
  const imgOpen = await js(
    win,
    `rope.getState().then((s) => {
      const it = s.items.find((i) => i.type === 'image');
      const el = it && document.querySelector('.item[data-id="' + it.id + '"]');
      if (el) el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
      return it ? it.cachePath : '';
    })`
  );
  await sleep(500);
  await check('AC-54 双击文件 / 文件夹 / 图片挂件 = 打开对应本体', () => {
    const added = T.openLog.slice(openBefore);
    assert.equal(added.length, 3, '三次双击都该产生打开载荷：' + JSON.stringify(added));
    assert.ok(added.some((e) => e.path === aFile), '应打开文件');
    assert.ok(added.some((e) => e.path === aDir), '应打开文件夹');
    assert.ok(added.some((e) => e.path === imgOpen), '应打开图片缓存副本：' + imgOpen);
  });

  clipboard.writeText('SENTINEL-55');
  const openBeforeText = T.openLog.length;
  await dblEl('.item.t-text');
  await sleep(400);
  await check('AC-55 双击文字挂件退化成复制并提示（不启动任何程序）', async () => {
    assert.equal(T.openLog.length, openBeforeText, '文字不应产生打开载荷');
    assert.equal(clipText(), '单击复制测试文本', '应退化为复制原文');
    assert.match(await toastText(), /文字/);
  });

  /* --- AC-57：取件模式优先：按住 Esc 单击仍是取下，不复制 --- */
  clipboard.writeText('SENTINEL-57');
  const beforeRemove = await itemCount(win);
  await js(
    win,
    `(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const el = document.querySelector('.item.t-text');
      if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
      return true;
    })()`
  );
  await sleep(450);
  await check('AC-57 按住 Esc 单击挂件仍是取下，不触发复制', () => {
    assert.equal(clipText(), 'SENTINEL-57', '剪贴板不应被改写');
  });
  await check('AC-57 取件确实生效（挂件数 -1）', async () => {
    assert.equal(await itemCount(win), beforeRemove - 1);
  });

  /* --- AC-58：文件夹面板里的行用同一套单击/双击语义 --- */
  const folderId = await waitItemId(win, aDir, '夹具文件夹挂件');
  await openFolderPanel(win, folderId, 2);
  const rowName = '内层.txt';
  const rowPath = path.join(aDir, rowName);
  clipboard.writeText('SENTINEL-58');
  const rowClicked = await js(
    win,
    `(() => {
      const row = [...document.querySelectorAll('#folder-panel .fp-row')].find(
        (r) => r.querySelector('.fp-row-name').textContent === ${JSON.stringify(rowName)}
      );
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      return true;
    })()`
  );
  await sleep(350);
  await check('AC-58 单击面板里的文件行 = 复制该文件对象，且行被选中', async () => {
    assert.equal(rowClicked, true, '应能找到该文件行');
    assert.deepEqual(clipFiles(), [rowPath]);
    const sel = await js(
      win,
      `document.querySelector('#folder-panel .fp-row.sel .fp-row-name').textContent`
    );
    assert.equal(sel, rowName, '单击仍要选中该行');
  });

  const openBeforeRow = T.openLog.length;
  await js(
    win,
    `(() => {
      const row = [...document.querySelectorAll('#folder-panel .fp-row')].find(
        (r) => r.querySelector('.fp-row-name').textContent === ${JSON.stringify(rowName)}
      );
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
      return true;
    })()`
  );
  await sleep(400);
  await check('AC-58 双击面板里的文件行 = 打开该文件（单击不重建 DOM）', () => {
    const added = T.openLog.slice(openBeforeRow);
    assert.equal(added.length, 1, '双击应只打开一次：' + JSON.stringify(added));
    assert.equal(added[0].path, rowPath);
  });

  /* 📌 仍是固定/取消固定，不被新的单击语义带偏 */
  clipboard.writeText('SENTINEL-PIN');
  const pinBase = await js(win, 'rope.getState().then((s) => s.items.length)');
  await js(
    win,
    `(async () => { const p = document.querySelector('#folder-panel .fp-pin'); p.click(); await new Promise((r) => setTimeout(r, 400)); return true; })()`
  );
  const pinOn = await js(win, 'rope.getState().then((s) => s.items.length)');
  await js(
    win,
    `(async () => { const p = document.querySelector('#folder-panel .fp-pin'); p.click(); await new Promise((r) => setTimeout(r, 400)); return true; })()`
  );
  const pinOff = await js(win, 'rope.getState().then((s) => s.items.length)');
  await check('AC-58 📌 仍可固定 / 取消固定，且不会误复制', () => {
    assert.equal(pinOn, pinBase + 1, '点一下应固定');
    assert.equal(pinOff, pinBase, '再点应取消固定');
    assert.equal(clipText(), 'SENTINEL-PIN', '📌 点击不应写剪贴板');
  });

  /* --- AC-59：自己复制的内容不能被「复制即悬挂」又挂回来 --- */
  await js(win, 'rope.setCopyMode(true); true');
  await sleep(300);
  const beforeWatch = await itemCount(win);
  await clickEl('.item.t-file');
  await sleep(1800); // 跨过至少两轮 700ms 剪贴板轮询
  const afterWatch = await itemCount(win);
  await js(win, 'rope.setCopyMode(false); true');
  await check('AC-59 单击复制不触发「复制即悬挂」自我重复挂', () => {
    assert.equal(afterWatch, beforeWatch, '挂件数不应增加');
    assert.deepEqual(clipFiles(), [aFile], '剪贴板仍应是刚复制的文件');
  });

  /* --- AC-60：源已丢失时明确提示，不静默写脏剪贴板 --- */
  const gone = path.join(root, '会被删.txt');
  fs.writeFileSync(gone, 'x');
  await js(win, `rope.addPaths(${JSON.stringify([gone])}); true`);
  await waitFor('失效样本挂上', async () => {
    const n = await js(
      win,
      `rope.getState().then((s) => s.items.filter((i) => i.path === ${JSON.stringify(
        gone
      )}).length)`
    );
    return n === 1;
  });
  fs.rmSync(gone);
  clipboard.writeText('SENTINEL-60');
  await js(
    win,
    `rope.getState().then((s) => {
      const it = s.items.find((i) => i.path === ${JSON.stringify(gone)});
      const el = it && document.querySelector('.item[data-id="' + it.id + '"]');
      if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      return !!el;
    })`
  );
  await sleep(400);
  await check('AC-60 源已丢失时单击给出提示，剪贴板保持原样', async () => {
    assert.equal(clipText(), 'SENTINEL-60');
    assert.match(await toastText(), /已丢失/);
  });

  /* --- AC-56：手势优先，按住抬起 / 拖出后余下的 click 都不能当复制 --- */
  clipboard.writeText('SENTINEL-56');
  await js(
    win,
    `(async () => {
      const el = document.querySelector('.item.t-file');
      const r = el.getBoundingClientRect();
      const mk = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 11, pointerType: 'mouse', isPrimary: true });
      el.dispatchEvent(new PointerEvent('pointerdown', mk(r.left + 10, r.top + 10)));
      await new Promise((res) => setTimeout(res, 260));
      document.dispatchEvent(new PointerEvent('pointermove', mk(r.left + 70, r.top + 10)));
      document.dispatchEvent(new PointerEvent('pointerup', mk(r.left + 70, r.top + 10)));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      return true;
    })()`
  );
  await sleep(350);
  await check('AC-56 按住抬起排序后余下的 click 不触发复制', () => {
    assert.equal(clipText(), 'SENTINEL-56');
  });

  clipboard.writeText('SENTINEL-56B');
  const dragBefore = T.dragLog.length;
  await js(
    win,
    `(async () => {
      const el = document.querySelector('.item.t-file');
      const r = el.getBoundingClientRect();
      const mk = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 12, pointerType: 'mouse', isPrimary: true });
      el.dispatchEvent(new PointerEvent('pointerdown', mk(r.left + 10, r.top + 10)));
      await new Promise((res) => setTimeout(res, 260));
      document.dispatchEvent(new PointerEvent('pointermove', mk(r.left + 10, window.innerHeight + 60)));
      document.dispatchEvent(new PointerEvent('pointerup', mk(r.left + 10, window.innerHeight + 60)));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      return true;
    })()`
  );
  await sleep(350);
  await check('AC-56 向下拖出窗口后余下的 click 也不触发复制', () => {
    assert.ok(T.dragLog.length > dragBefore, '前置：确实发生了拖出');
    assert.equal(clipText(), 'SENTINEL-56B');
  });

  await check('AC-36 本场景无渲染进程崩溃记录', () => {
    assert.equal(fs.existsSync(path.join(userData, 'crash.log')), false);
  });

  fs.rmSync(root, { recursive: true, force: true });
}

/* ---------------- 统一去重（v1.6 / AC-61~AC-68） ---------------- */

async function runDedupe(win) {
  T.showRope();
  await sleep(400);

  const { nativeImage } = require('electron');
  const count = () => T.snapshot().items.length;
  const pathsOf = (p) => T.snapshot().items.filter((i) => i.path === p).length;
  const toastText = () => js(win, 'document.querySelector("#toast").textContent');
  const clearToast = () =>
    js(win, `(() => { document.querySelector('#toast').textContent = ''; return true; })()`);
  const cacheDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'HangingRope', 'cache');
  const cacheFiles = () => {
    try {
      return fs.readdirSync(cacheDir).length;
    } catch {
      return 0;
    }
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-dedupe-'));
  const deskFile = path.join(root, 'PixPin_桌面截图.png');
  fs.writeFileSync(deskFile, fs.readFileSync(path.join(ROOT, 'assets', 'icon.png')));
  const otherFile = path.join(root, '另一张.txt');
  fs.writeFileSync(otherFile, 'other');
  const aDir = path.join(root, '文件夹');
  fs.mkdirSync(aDir);
  const png = fs.readFileSync(deskFile);

  /* AC-61：同一个桌面文件从"拖入"入口连续挂两次（走真实 IPC 链路） */
  const n0 = count();
  await js(win, `rope.addPaths(${JSON.stringify([deskFile])}); true`);
  await waitFor('第一张桌面文件挂上', () => count() === n0 + 1);
  await clearToast();
  await js(win, `rope.addPaths(${JSON.stringify([deskFile])}); true`);
  await sleep(350);
  const dupToast1 = await toastText();
  await check('AC-61 同一个桌面文件重复拖入只挂一张，并有去重提示', () => {
    assert.equal(count(), n0 + 1);
    assert.equal(pathsOf(deskFile), 1);
    assert.match(dupToast1, /重复|已在绳上/);
  });

  /* AC-61：绳上已有同一文件时，Ctrl+V 粘贴同一个文件也不重复 */
  await clearToast();
  clipboard.clear();
  clipboard.writeBuffer('FileNameW', Buffer.from(deskFile + '\0', 'utf16le'));
  T.onPastePressed();
  await sleep(350);
  const dupToast2 = await toastText();
  await check('AC-61 绳上已有同一文件时 Ctrl+V 也不重复挂', () => {
    assert.equal(count(), n0 + 1);
    assert.match(dupToast2, /重复|已在绳上/);
  });

  /* AC-61：复制即悬挂 —— 中间复制过别的内容后，再复制回同一段仍不重复挂。
     这是旧实现最容易漏的场景：监听基线只记"上一次内容"，绳上其实早就有了。 */
  clipboard.clear();
  await js(win, `rope.toggleCopyMode(); true`);
  await sleep(250);
  const nWatch = count();
  clipboard.writeText('去重-watch-A');
  await waitFor('watcher 挂上 A', () => count() === nWatch + 1, 8000);
  clipboard.writeText('去重-watch-B');
  await waitFor('watcher 挂上 B', () => count() === nWatch + 2, 8000);
  await clearToast();
  clipboard.writeText('去重-watch-A');
  await sleep(1100); // 至少跨过一次 CLIP_POLL_MS
  const dupToast3 = await toastText();
  await check('AC-61 复制即悬挂：隔过其它内容后再复制同一段，仍不重复挂', () => {
    assert.equal(count(), nWatch + 2);
    assert.match(dupToast3, /已经挂在绳上|重复/);
  });
  await js(win, `rope.toggleCopyMode(); true`);
  await sleep(150);

  /* AC-62：大小写 / 斜杠方向 / 末尾分隔符变体都算同一目标 */
  const nVar = count();
  T.addPaths([deskFile.toUpperCase(), deskFile.replace(/\\/g, '/')]);
  T.addPaths([aDir]);
  T.addPaths([aDir.toUpperCase() + '\\']);
  await sleep(250);
  await check('AC-62 大小写/斜杠/末尾分隔符变体都算同一目标，不重复挂', () => {
    assert.equal(count(), nVar + 1, '只有新文件夹应该挂上');
    assert.equal(pathsOf(aDir), 1);
    assert.equal(pathsOf(deskFile), 1);
  });

  /* AC-63：同一张图片按字节判重，且不写第二份缓存副本 */
  const cacheBefore = cacheFiles();
  const nImg = count();
  const img1 = T.addImageBuffer(png, 'png', { mime: 'image/png', name: 'PixPin.png' });
  const img2 = T.addImageBuffer(png, 'png', { mime: 'image/png', name: 'PixPin-副本.png' });
  await sleep(250);
  await check('AC-63 同一张图片重复添加只挂一张，且不生成第二份缓存副本', () => {
    assert.ok(img1 && img1.hash, '首次应挂上并写入内容指纹');
    assert.equal(img2, null, '第二次应被判重拦下');
    assert.equal(count(), nImg + 1);
    assert.equal(cacheFiles(), cacheBefore + 1);
  });

  const png2 = Buffer.concat([png, Buffer.from([0])]);
  const img3 = T.addImageBuffer(png2, 'png', { mime: 'image/png', name: '另一张图.png' });
  await check('AC-63 不同图片内容仍可正常挂上（不误杀）', () => {
    assert.ok(img3 && img3.id);
    assert.notEqual(img3.hash, img1.hash);
    assert.equal(count(), nImg + 2);
    assert.equal(cacheFiles(), cacheBefore + 2);
  });

  /* AC-63：剪贴板图片强制再挂一次同样不重复（首次是否新增取决于系统是否
     重新编码 PNG，这里只要求"第二次不再增加"，不依赖具体字节）。 */
  clipboard.clear();
  clipboard.writeImage(nativeImage.createFromPath(deskFile));
  T.onPastePressed();
  await sleep(350);
  const afterFirstClipImg = count();
  await clearToast();
  T.onPastePressed();
  await sleep(350);
  const clipImgToast = await toastText();
  await check('AC-63 剪贴板图片：强制再挂一次也不会重复', () => {
    assert.equal(count(), afterFirstClipImg);
    assert.match(clipImgToast, /已经在绳上|重复|已悬挂/);
  });

  /* AC-64：文字按内容判重 */
  const nText = count();
  const t1 = T.addTextItem('去重-固定文字');
  const t2 = T.addTextItem('去重-固定文字');
  const t3 = T.addTextItem('去重-不同文字');
  await check('AC-64 同一段文字不重复挂，不同文字照常挂', () => {
    assert.ok(t1 && t1.id);
    assert.equal(t2, null);
    assert.ok(t3 && t3.id);
    assert.equal(count(), nText + 2);
  });

  /* AC-61：.lnk 解析出的本体、以及"看起来像路径的文字"都指向已挂文件 */
  const nLnk = count();
  const lnk = path.join(root, '桌面截图 快捷方式.lnk');
  let lnkOk = false;
  try {
    lnkOk = shell.writeShortcutLink(lnk, 'create', { target: deskFile });
  } catch {
    lnkOk = false;
  }
  T.addPaths([lnk]);
  T.addTextItem(deskFile);
  await check('AC-61 .lnk 本体与文字路径都指向已挂文件，不重复挂', () => {
    assert.equal(lnkOk, true, '前置：快捷方式创建成功');
    assert.equal(count(), nLnk);
    assert.equal(pathsOf(deskFile), 1);
  });

  /* AC-66：批量里重复项跳过、新目标照常挂上，不因一条重复中断整批 */
  const nBatch = count();
  await clearToast();
  const added = T.addPaths([deskFile, otherFile, aDir, deskFile.toUpperCase()]);
  await sleep(300);
  const batchToast = await toastText();
  await check('AC-66 批量里重复项跳过、新目标照常挂上（不中断整批）', () => {
    assert.equal(added.length, 1);
    assert.equal(added[0].path, otherFile);
    assert.equal(count(), nBatch + 1);
    assert.match(batchToast, /跳过|重复|已在绳上/);
  });

  /* AC-67：去重不是"永久黑名单"，取下同一目标后仍可重新挂上 */
  const otherId = T.snapshot().items.find((i) => i.path === otherFile).id;
  await js(win, `rope.removeItem(${JSON.stringify(otherId)}); true`);
  await waitFor('取下生效', () => !T.snapshot().items.some((i) => i.id === otherId));
  const nRe = count();
  T.addPaths([otherFile]);
  await check('AC-67 去重只在绳上已有该目标时生效；取下后可重新挂上', () => {
    assert.equal(count(), nRe + 1);
    assert.equal(pathsOf(otherFile), 1);
  });

  /* AC-68：源曾丢失的失效挂件仍占着同一路径，重建文件后也不该挂出第二张 */
  const gone = path.join(root, '失效目标.txt');
  T.injectRawItems([
    { id: 'legacy-invalid', type: 'file', path: gone, name: '失效目标.txt', invalid: true, addedAt: 1 },
  ]);
  fs.writeFileSync(gone, 'back');
  const nGone = count();
  T.addPaths([gone]);
  await check('AC-68 源曾丢失的失效挂件仍占同一路径，不会被重复挂上', () => {
    assert.equal(count(), nGone);
    assert.equal(pathsOf(gone), 1);
  });

  await sleep(300);
  await check('AC-61 渲染层卡片数与主进程状态一致（没有藏起来的重复卡片）', async () => {
    assert.equal(await itemCount(win), count());
  });

  await check('AC-36 本场景无渲染进程崩溃记录', () => {
    assert.equal(fs.existsSync(path.join(userData, 'crash.log')), false);
  });

  fs.rmSync(root, { recursive: true, force: true });
}

/* 启动时合并历史重复挂件：state.json 由 run-tests.js 预置，模拟旧版本数据 */
async function runDedupeRestart(win) {
  const items = T.snapshot().items;
  const dedupe = require(path.join(ROOT, 'src', 'main', 'dedupe'));
  const png = fs.readFileSync(path.join(ROOT, 'assets', 'icon.png'));

  await check('AC-65 启动时把历史重复挂件合并成一张，保留最早一张且顺序不变', () => {
    assert.deepEqual(
      items.map((i) => i.id),
      ['legacy-file-a', 'legacy-img-a', 'legacy-text-a', 'keep-file', 'keep-text']
    );
  });

  await check('AC-65 大小写路径变体、相同文字被摘除；不同文件/文字全部保留', () => {
    assert.equal(items.filter((i) => i.type === 'file' && /legacy-file/.test(i.id)).length, 1);
    assert.equal(items.filter((i) => i.type === 'image' && /legacy-img/.test(i.id)).length, 1);
    assert.equal(items.filter((i) => i.type === 'text' && i.text === '重复文字').length, 1);
    assert.ok(items.some((i) => i.id === 'keep-file' && i.type === 'folder'));
    assert.ok(items.some((i) => i.id === 'keep-text' && i.text === '另一段文字'));
  });

  await check('AC-65 旧图片挂件被回填内容指纹（两份副本内容相同才合并）', () => {
    const img = items.find((i) => i.id === 'legacy-img-a');
    assert.ok(img && img.hash, '应补上 hash');
    assert.equal(img.hash, dedupe.contentHash(png));
  });

  await check('AC-65 合并结果写回 state.json，重启不会让重复挂件复活', async () => {
    const raw = await waitFor('state.json 写回', () => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(userData, 'state.json'), 'utf8'));
        return s.items.length === 5 ? s : null;
      } catch {
        return null;
      }
    }, 6000);
    assert.equal(raw.items.length, 5);
    assert.ok(!raw.items.some((i) => /legacy-file-b|legacy-img-b|legacy-text-b/.test(i.id)));
  });

  await check('AC-65 合并后再走产品入口挂同一目标，仍然不会重复', () => {
    const before = T.snapshot().items.length;
    T.addPaths([path.join(ROOT, 'package.json')]);
    assert.equal(T.snapshot().items.length, before);
  });

  await check('AC-36 本场景无渲染进程崩溃记录', () => {
    assert.equal(fs.existsSync(path.join(userData, 'crash.log')), false);
  });
}

/* ---------------- 场景：主题切换（v1.10） ----------------
   覆盖：默认浅色 → 设置窗口切深色（两个窗口同步）→ 变量/底色/持久化 →
   深色下功能不受影响 → 切回浅色 → 非法值拒绝 → 重启后保留。 */

/* 取亮度：十六进制与 rgb() 都支持，用来断言「卡片确实变深 / 文字确实变浅」，
   而不是只看 data-theme 属性（属性对了但 CSS 没接上也可能假通过）。 */
function lum(color) {
  if (!color) return NaN;
  const hex = /^#([0-9a-f]{6})$/i.exec(String(color).trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  }
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(color));
  if (!m) return NaN;
  return 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
}

async function themeView(w) {
  return js(
    w,
    `(() => {
      const root = document.documentElement;
      const cs = getComputedStyle(root);
      const card = document.querySelector('.item') || document.querySelector('.card');
      const shell = document.querySelector('#shell');
      const strip = shell ? getComputedStyle(shell, '::before').height : '';
      return {
        theme: root.getAttribute('data-theme'),
        bg: cs.getPropertyValue('--bg').trim() || cs.getPropertyValue('--bg-1').trim(),
        text: cs.getPropertyValue('--text').trim(),
        accent: cs.getPropertyValue('--accent').trim(),
        cardBg: card ? getComputedStyle(card).backgroundColor : '',
        stripH: strip,
        boot: !!(window.ropeTheme && typeof window.ropeTheme.apply === 'function'),
        query: location.search,
        picker: [...document.querySelectorAll('.theme-opt')].map((b) => ({
          v: b.dataset.themeValue,
          on: b.classList.contains('on'),
          pressed: b.getAttribute('aria-pressed'),
        })),
        cards: [...document.querySelectorAll('.card h2')].map((h) => h.textContent),
      };
    })()`
  );
}

/* 设置窗口布局体检（v1.11.1）：高 DPI 下卡片必须画成实色，标题不能有
   白色胶囊/圆形凸起，底部操作栏与两枚按钮不能被窗口边缘裁掉。 */
async function settingsLayout(w) {
  return js(
    w,
    `(() => {
      const m = document.querySelector('main');
      const ft = document.querySelector('.ft');
      const h2 = document.querySelector('.card h2');
      const card = document.querySelector('.card');
      const btn = document.querySelector('#btn-choose-dir');
      const input = document.querySelector('#limit-input');
      const box = (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height }; };
      const cs = (e) => getComputedStyle(e);
      return {
        winH: innerHeight,
        mainScroll: m.scrollHeight,
        mainClient: m.clientHeight,
        mainMinHeight: cs(m).minHeight,
        footer: box(ft),
        quit: box(document.querySelector('#btn-quit')),
        close: box(document.querySelector('#btn-close')),
        cards: [...document.querySelectorAll('.card')].map((c) => cs(c).backgroundColor),
        h2Bg: cs(h2).backgroundColor,
        h2Radius: cs(h2).borderRadius,
        h2Before: cs(h2, '::before').content,
        btnAppearance: cs(btn).webkitAppearance || cs(btn).appearance,
        inputAppearance: cs(input).webkitAppearance || cs(input).appearance,
        h2Appearance: cs(h2).webkitAppearance || cs(h2).appearance,
      };
    })()`
  );
}

async function waitBothThemes(win, sw, want) {
  return waitFor('两个窗口都切到 ' + want, async () => {
    const a = await js(win, `document.documentElement.getAttribute('data-theme')`);
    const b = await js(sw, `document.documentElement.getAttribute('data-theme')`);
    return a === want && b === want;
  });
}

async function runTheme(win) {
  T.showRope();
  await sleep(400);
  await installMouseShield(win);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-theme-'));
  const aFile = path.join(root, '主题核对.txt');
  const aDir = path.join(root, '主题核对目录');
  fs.writeFileSync(aFile, 'theme switch');
  fs.mkdirSync(aDir);
  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(aDir, `内层${i}.txt`), 'inner');

  await js(win, `rope.addText('主题切换核对文字'); true`);
  await js(win, `rope.addPaths(${JSON.stringify([aFile, aDir])}); true`);
  await waitFor('三件挂件就位', async () => (await itemCount(win)) === 3);
  const folderId = await waitItemId(win, aDir, '文件夹挂件出现');

  const light = await themeView(win);
  await check('AC-72 默认浅色：引导脚本就绪、URL 带主题、蓝强调与 210px 条高不变', () => {
    assert.equal(light.theme, 'light');
    assert.equal(light.boot, true, 'theme.js 必须在 head 里加载');
    assert.match(light.query, /theme=light/);
    assert.equal(light.accent, '#4b86f5');
    assert.equal(light.stripH, '210px');
    assert.equal(T.snapshot().settings.theme, 'light');
  });

  await js(win, 'document.querySelector("#btn-settings").click()');
  const sw = await waitSettingsWindow();
  const swLight = await themeView(sw);

  await check('AC-73 设置窗口含「外观」卡片与浅色/深色两个按钮，浅色为选中态', () => {
    assert.ok(swLight.cards.includes('外观'), JSON.stringify(swLight.cards));
    assert.equal(swLight.theme, 'light');
    assert.equal(swLight.boot, true);
    assert.deepEqual(swLight.picker.map((p) => p.v), ['light', 'dark']);
    assert.equal(swLight.picker[0].on, true);
    assert.equal(swLight.picker[1].on, false);
    assert.equal(swLight.picker[0].pressed, 'true');
    assert.equal(swLight.picker[1].pressed, 'false');
  });

  const layout = await settingsLayout(sw);
  await check('AC-94 设置窗口底部操作栏与「退出程序 / 关闭」完整可见，不被窗口裁切', () => {
    assert.equal(layout.mainMinHeight, '0px', 'main 必须能收缩，否则 footer 会被顶出窗口');
    assert.ok(layout.footer.bottom <= layout.winH + 1,
      `footer 底 ${layout.footer.bottom} 超出视口 ${layout.winH}`);
    for (const [n, b] of [['退出程序', layout.quit], ['关闭', layout.close]]) {
      assert.ok(b.top >= 0 && b.bottom <= layout.winH + 1,
        `${n} 按钮被裁切：${JSON.stringify(b)} / 视口 ${layout.winH}`);
      assert.ok(b.h >= 27, `${n} 按钮高度异常：${b.h}`);
    }
    // 常规屏幕上三张卡片应整屏放下，不必滚动；极小工作区允许保留滚动
    const winH = T.getSettingsWindow().getBounds().height;
    if (winH >= 600) {
      assert.ok(layout.mainScroll <= layout.mainClient + 2,
        `默认窗口高 ${winH} 时内容仍要滚动：scroll ${layout.mainScroll} > client ${layout.mainClient}`);
    }
  });

  await check('AC-95 卡片是实色不透明底，标题是纯文字、控件不套原生外观（无白色胶囊/圆形凸起）', () => {
    // v2.0.0：外观 / 图片缓存 / 悬挂绳 / 关于 —— 4 张卡片
    assert.equal(layout.cards.length, 4);
    for (const bg of layout.cards) {
      assert.equal(bg, 'rgb(255, 255, 255)', '浅色卡片应是纯白实底');
    }
    assert.equal(layout.h2Bg, 'rgba(0, 0, 0, 0)', 'h2 不能有白色底色');
    assert.equal(layout.h2Radius, '0px', 'h2 不能有圆角');
    assert.ok(['none', 'normal', ''].includes(layout.h2Before),
      'h2 不能有 ::before 圆形凸起，实际 ' + layout.h2Before);
    assert.equal(layout.h2Appearance, 'none');
    assert.equal(layout.btnAppearance, 'none');
    assert.equal(layout.inputAppearance, 'none');
  });

  // 先改一项别的设置，用来验证主题切换不会把已有设置覆盖掉
  await js(sw, `document.querySelector('#limit-input').value = '80'; document.querySelector('#btn-save-limit').click(); true`);
  await sleep(500);

  await js(sw, `document.querySelector('#btn-theme-dark').click(); true`);
  await waitBothThemes(win, sw, 'dark');
  await sleep(300);
  const darkMain = await themeView(win);
  const darkSw = await themeView(sw);

  await check('AC-74 点「深色」后主窗口与设置窗口同时变 dark（主进程状态推送生效）', () => {
    assert.equal(darkMain.theme, 'dark');
    assert.equal(darkSw.theme, 'dark');
    assert.equal(T.snapshot().settings.theme, 'dark');
  });

  await check('AC-75 深色不只是改属性：卡片变深、文字变浅、蓝强调提亮', () => {
    assert.equal(darkMain.accent, '#5b93ff');
    assert.equal(darkSw.accent, '#5b93ff');
    assert.ok(lum(darkMain.cardBg) < lum(light.cardBg) - 60,
      '主窗卡片亮度：浅=' + lum(light.cardBg) + ' 深=' + lum(darkMain.cardBg));
    assert.ok(lum(darkSw.cardBg) < lum(swLight.cardBg) - 60,
      '设置卡片亮度：浅=' + lum(swLight.cardBg) + ' 深=' + lum(darkSw.cardBg));
    assert.ok(lum(darkMain.text) > lum(light.text) + 60, '深色主题文字应更亮');
    assert.equal(darkMain.stripH, '210px', '换主题不许改动布局尺寸');
  });

  await check('AC-76 设置窗口原生底色同步为深色，避免缩放时露白边', () => {
    assert.match(sw.getBackgroundColor(), /1b1f28/i, '实际 ' + sw.getBackgroundColor());
  });

  await check('AC-77 主题写入 state.json，且不覆盖已有缓存上限', () => {
    const st = readState().settings;
    assert.equal(st.theme, 'dark');
    assert.equal(st.cacheLimitMB, 80);
  });

  const darkLayout = await settingsLayout(sw);
  await check('AC-96 深色设置窗口同样完整：卡片为深色实底、标题透明、底部按钮不被裁切', () => {
    for (const bg of darkLayout.cards) {
      assert.equal(bg, 'rgb(38, 44, 56)', '深色卡片应是 #262c38 实底');
    }
    assert.equal(darkLayout.h2Bg, 'rgba(0, 0, 0, 0)');
    assert.equal(darkLayout.h2Radius, '0px');
    assert.ok(darkLayout.footer.bottom <= darkLayout.winH + 1,
      '深色下 footer 也不能被裁切');
    assert.ok(darkLayout.close.bottom <= darkLayout.winH + 1,
      '深色下关闭按钮也不能被裁切');
  });

  /* 深色下功能不受换肤影响：文件夹面板能开、行也跟着变深、单击复制仍写文件对象 */
  await openFolderPanel(win, folderId, 3);
  const panel = await js(
    win,
    `(() => { const r = document.querySelector('#folder-panel .fp-row');
      return r ? getComputedStyle(r).backgroundColor : ''; })()`
  );
  await check('AC-78 深色下文件夹面板仍能展开，行底色也跟着变深', () => {
    assert.ok(panel, '面板行应存在');
    assert.ok(lum(panel) < lum(light.cardBg), '面板行应比浅色卡片更暗：' + panel);
  });
  await js(win, `(() => { const el=[...document.querySelectorAll('.item')].find(n=>n.classList.contains('t-folder')); if(el) el.dispatchEvent(new MouseEvent('mouseleave')); return true; })()`);
  await sleep(350);

  clipboard.writeText('SENTINEL-THEME');
  await js(
    win,
    `(() => { const el = document.querySelector('.item.t-file'); if (!el) return false;
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); return true; })()`
  );
  await sleep(350);
  await check('AC-82 深色下单击复制仍写入可粘贴的文件对象（不是路径文字）', () => {
    const files = clipboard
      .readBuffer('FileNameW')
      .toString('utf16le')
      .split('\0')
      .filter(Boolean)
      .map((f) => f.toLowerCase());
    assert.deepEqual(files, [aFile.toLowerCase()]);
  });

  await js(sw, `document.querySelector('#btn-theme-light').click(); true`);
  await waitBothThemes(win, sw, 'light');
  await sleep(300);
  const backMain = await themeView(win);
  const backSw = await themeView(sw);

  await check('AC-79 再点「浅色」两窗口同时恢复，变量与卡片底色回到初始值', () => {
    assert.equal(backMain.theme, 'light');
    assert.equal(backSw.theme, 'light');
    assert.equal(backMain.accent, '#4b86f5');
    assert.equal(backMain.cardBg, light.cardBg);
    assert.equal(backSw.cardBg, swLight.cardBg);
    assert.equal(readState().settings.theme, 'light');
    assert.match(sw.getBackgroundColor(), /f4f7fb/i, '实际 ' + sw.getBackgroundColor());
  });

  const illegal = await js(
    sw,
    `(async () => {
      const a = await rope.setSettings({ theme: 'neon' });
      const b = await rope.setTheme(null);
      const c = await rope.setTheme('DARK');
      return { a: a.theme, b: b.theme, c: c.theme,
               dom: document.documentElement.getAttribute('data-theme') };
    })()`
  );
  await check('AC-80 非法主题值被拒绝，界面与 state.json 都不被污染', () => {
    assert.deepEqual([illegal.a, illegal.b, illegal.c], ['light', 'light', 'light']);
    assert.equal(illegal.dom, 'light');
    assert.equal(readState().settings.theme, 'light');
  });

  const picker = await js(
    sw,
    `[...document.querySelectorAll('.theme-opt')].map(b => ({ v: b.dataset.themeValue, on: b.classList.contains('on'), pressed: b.getAttribute('aria-pressed') }))`
  );
  await check('AC-81 分段按钮态始终与真实主题一致', () => {
    assert.deepEqual(picker.map((p) => p.on), [true, false]);
    assert.deepEqual(picker.map((p) => p.pressed), ['true', 'false']);
  });

  await check('AC-36 本场景无渲染进程崩溃记录', () => {
    assert.equal(fs.existsSync(path.join(userData, 'crash.log')), false);
  });

  sw.close();
  fs.rmSync(root, { recursive: true, force: true });
}

/* ---------------- 场景：深色主题重启保留 ----------------
   run-tests.js 会预置 settings.theme = 'dark' 的 state.json。 */
async function runThemeRestart(win) {
  T.showRope();
  await sleep(400);
  await installMouseShield(win);
  const boot = await themeView(win);

  await check('AC-83 预置深色启动：URL 带上 theme=dark，首帧即为深色', () => {
    assert.match(boot.query, /theme=dark/);
    assert.equal(boot.theme, 'dark');
    assert.equal(boot.accent, '#5b93ff');
    assert.equal(T.snapshot().settings.theme, 'dark');
    assert.equal(readState().settings.theme, 'dark');
  });

  await js(win, 'document.querySelector("#btn-settings").click()');
  const sw = await waitSettingsWindow();
  const swView = await themeView(sw);

  await check('AC-83 重启后打开的设置窗口同样是深色，深色按钮高亮', () => {
    assert.match(swView.query, /theme=dark/);
    assert.equal(swView.theme, 'dark');
    assert.deepEqual(swView.picker.map((p) => p.on), [false, true]);
    assert.match(sw.getBackgroundColor(), /1b1f28/i);
  });

  await js(sw, `document.querySelector('#btn-theme-light').click(); true`);
  await waitBothThemes(win, sw, 'light');
  await sleep(250);
  await check('AC-84 深色重启后仍可切回浅色并落盘', () => {
    assert.equal(readState().settings.theme, 'light');
    assert.equal(T.snapshot().settings.theme, 'light');
  });

  await check('AC-36 本场景无渲染进程崩溃记录', () => {
    assert.equal(fs.existsSync(path.join(userData, 'crash.log')), false);
  });
  sw.close();
}

/* ---------------- 主流程 ---------------- */

(async () => {
  await app.whenReady();
  const win = await waitFor('窗口创建', () => BrowserWindow.getAllWindows()[0]);
  await waitFor('页面就绪', () =>
    win.webContents.executeJavaScript('typeof rope !== "undefined"', true)
  );

/* ---------------- 场景：停靠位置（v1.14） ---------------- */

async function runPosition(win) {
  const work = screen.getPrimaryDisplay().workArea;
  const full = screen.getPrimaryDisplay().bounds;
  const B = () => win.getBounds();

  const setPos = async (pos) => {
    await js(win, `rope.setSettings({ ropePosition: ${JSON.stringify(pos)} }); true`);
    await waitFor('停靠位置 = ' + pos, () => T.settingsSnapshot().settings.ropePosition === pos);
    await sleep(450); // 等滑入弹簧收敛（v1.19：easeOut 换弹簧，收敛 ≈ 250~350ms）
  };
  const dataPos = () => js(win, 'document.documentElement.getAttribute("data-pos")');

  await check('AC-117 默认停靠顶部：启动隐藏在屏外上方，data-pos=top', () => {
    assert.equal(T.settingsSnapshot().settings.ropePosition, 'top');
    assert.ok(B().y <= -209, 'y=' + B().y);
  });

  T.showRope();
  await sleep(400);
  await installMouseShield(win);

  await check('AC-118 顶部唤出后贴屏顶、宽度居中（与旧版一致）', () => {
    const b = B();
    assert.equal(b.y, 0);
    assert.ok(Math.abs(b.x + b.width / 2 - (full.x + full.width / 2)) <= 2);
  });

  /* 挂两件，验证排列方向会跟随停靠边切换 */
  await js(win, `rope.addText('位置A')`);
  await js(win, `rope.addText('位置B')`);
  await waitFor('挂件 2 件', async () => (await itemCount(win)) === 2);
  // 等入场动画（hang-in 的 transform 会临时改变 getBoundingClientRect）
  await waitFor('入场动画结束', () => js(win, 'document.querySelectorAll(".item.anim-in").length === 0'), 4000);
  await sleep(120);
  // 用 offsetTop/offsetLeft（布局位置）而不是 getBoundingClientRect：
  // 后者含 transform，真实光标恰好悬在某张卡片上时 :hover 的 translateY(-3px)
  // 会让 y 差 3px——这是环境干扰，不是布局错误。
  const rectsH = await js(
    win,
    `JSON.stringify([...document.querySelectorAll('.item')].map((n) => ({ x: Math.round(n.offsetLeft), y: Math.round(n.offsetTop) })))`
  );
  const hArr = JSON.parse(rectsH);
  await check('AC-119 顶部：挂件横向排列（x 递增、y 相同）', () => {
    assert.equal(hArr.length, 2);
    assert.ok(hArr[1].x > hArr[0].x, '第二张应在右侧');
    assert.equal(hArr[0].y, hArr[1].y, '顶部停靠 y 应相同');
  });

  await setPos('bottom');
  await check('AC-120 底部：窗口贴工作区底边（避开任务栏），data-pos=bottom', async () => {
    const b = B();
    assert.equal(b.y + b.height, work.y + work.height, '底边 = 工作区底');
    assert.equal(await dataPos(), 'bottom');
  });
  await check('AC-121 底部：挂件仍可见（竖向坐标在窗口内）', async () => {
    const r = await js(
      win,
      `(() => { const n = document.querySelector('.item'); const r = n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()`
    );
    assert.equal(r, true);
  });

  await setPos('left');
  await check('AC-122 左侧：竖条贴左缘，长度 = 工作区高 ÷5 垂直居中', () => {
    const b = B();
    const len = Math.max(168, Math.round(work.height / 2.5));
    assert.equal(b.x, work.x);
    assert.equal(b.width, 210);
    assert.ok(Math.abs(b.height - len) <= 1, `高度 ${b.height} vs ${len}`);
    assert.ok(Math.abs(b.y + b.height / 2 - (work.y + work.height / 2)) <= 1, '垂直居中');
  });
  await check('AC-123 左侧：data-pos=left，挂件纵向排列（y 递增、x 相同）', async () => {
    assert.equal(await dataPos(), 'left');
    const arr = JSON.parse(
      await js(
        win,
        `JSON.stringify([...document.querySelectorAll('.item')].map((n) => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; }))`
      )
    );
    assert.ok(arr[1].y > arr[0].y, '第二张应在下方');
    assert.ok(Math.abs(arr[0].x - arr[1].x) <= 4, '左侧停靠 x 应几乎相同');
  });

  await setPos('right');
  await check('AC-124 右侧：竖条贴工作区右缘', () => {
    const b = B();
    assert.ok(Math.abs(b.x + b.width - (work.x + work.width)) <= 1, `右缘 ${b.x + b.width} vs ${work.x + work.width}`);
    assert.ok(Math.abs(b.width - 210) <= 1, '宽度 ' + b.width);
  });

  T.hideRope();
  await sleep(320);
  await check('AC-125 右侧收回后整体移出屏幕', () => {
    const b = B();
    assert.ok(b.x >= full.x + full.width - 210, 'x=' + b.x + '（应贴屏幕右缘外侧）');
    assert.ok(b.x + b.width > full.x + full.width - 1, '窗口整体应在屏幕右侧之外');
  });

  await check('AC-126 非法停靠值被白名单忽略，设置与窗口位置都不变', async () => {
    const before = B();
    await js(win, `rope.setSettings({ ropePosition: 'diagonal' }); true`);
    await sleep(200);
    assert.equal(T.settingsSnapshot().settings.ropePosition, 'right');
    const after = B();
    assert.equal(after.x, before.x, '窗口 x 不动');
    assert.equal(after.y, before.y, '窗口 y 不动');
  });

  await setPos('top');
  T.showRope();
  await sleep(320);
  await check('AC-127 切回顶部后与旧版行为一致', () => {
    const b = B();
    assert.ok(Math.abs(b.y) <= 1, 'y=' + b.y);
    assert.ok(Math.abs(b.x + b.width / 2 - (full.x + full.width / 2)) <= 2);
  });

  /* 设置窗口：4 档分段按钮与真实设置同步 */
  await js(win, 'rope.openSettings()');
  const sw = await waitSettingsWindow();
  await check('AC-128 设置窗口出现 4 档停靠位置按钮，选中态与设置一致', async () => {
    const state = await js(
      sw,
      `(() => {
        const btns = [...document.querySelectorAll('.pos-opt')];
        return JSON.stringify({
          labels: btns.map((b) => b.dataset.posValue),
          on: btns.map((b) => b.classList.contains('on')),
          pressed: btns.map((b) => b.getAttribute('aria-pressed')),
        });
      })()`
    );
    const s = JSON.parse(state);
    assert.deepEqual(s.labels, ['top', 'left', 'right', 'bottom']);
    assert.deepEqual(s.on, [true, false, false, false]);
    assert.deepEqual(s.pressed, ['true', 'false', 'false', 'false']);
  });
  await check('AC-129 设置窗口点击「左侧」立即生效（主窗口贴左、按钮选中）', async () => {
    T.showRope();
    await sleep(200);
    await js(sw, `document.querySelector('.pos-opt[data-pos-value="left"]').click(); true`);
    await waitFor('设置切到 left', () => T.settingsSnapshot().settings.ropePosition === 'left');
    await sleep(500); // 等滑入弹簧收敛
    assert.ok(Math.abs(B().x - work.x) <= 1, '主窗口应已贴左，x=' + B().x);
    const on = await js(
      sw,
      `JSON.stringify([...document.querySelectorAll('.pos-opt')].map((b) => b.classList.contains('on')))`
    );
    assert.deepEqual(JSON.parse(on), [false, true, false, false]);
  });

  /* 托盘菜单单选组 */
  await check('AC-130 托盘菜单有 4 个单选项，勾选跟随当前停靠边', () => {
    const tpl = T.buildTrayTemplate();
    const sub = tpl.find((m) => m.label === '停靠位置');
    assert.ok(sub && Array.isArray(sub.submenu), '缺少停靠位置子菜单');
    assert.deepEqual(
      sub.submenu.map((m) => m.label),
      ['顶部', '左侧', '右侧', '底部']
    );
    assert.deepEqual(
      sub.submenu.map((m) => m.type),
      ['radio', 'radio', 'radio', 'radio']
    );
    assert.deepEqual(
      sub.submenu.map((m) => !!m.checked),
      [false, true, false, false],
      '当前 left 应勾选「左侧」'
    );
  });

  await check('AC-131 停靠位置落盘，state.json 中记录 ropePosition', async () => {
    await setPos('bottom');
    const raw = readState();
    assert.equal(raw.settings.ropePosition, 'bottom');
  });

  await check('AC-36 本场景无渲染进程崩溃记录', () => {
    const crash = path.join(userData, 'crash.log');
    assert.ok(!fs.existsSync(crash), fs.existsSync(crash) ? fs.readFileSync(crash, 'utf8') : '');
  });
}

/* ---------------- 场景：停靠位置重启记忆 ---------------- */

async function runPositionRestart(win) {
  const work = screen.getPrimaryDisplay().workArea;
  await sleep(300);
  await check('AC-132 重启后按记住的停靠边就位：左侧竖条、启动即隐藏在屏外左侧', () => {
    const b = win.getBounds();
    const len = Math.max(168, Math.round(work.height / 2.5));
    assert.ok(b.x <= -208, '启动应在隐藏位（屏外左侧），x=' + b.x);
    assert.ok(Math.abs(b.width - 210) <= 2, '宽度 ' + b.width);
    // 高 DPI（如 150%）下物理像素取整会带来几 DIP 偏差，精确值由单测保证
    assert.ok(Math.abs(b.height - len) <= 6, `长度 ${b.height} vs 期望 ${len}`);
  });
  await check('AC-133 隐藏位置在屏幕外左侧（贴左停靠时）', () => {
    assert.ok(win.getBounds().x <= -208, 'x=' + win.getBounds().x);
  });
  T.showRope();
  await sleep(420);
  await check('AC-134 唤出后贴左缘且渲染层 data-pos=left（首帧即竖排，无闪变）', async () => {
    const b = win.getBounds();
    assert.ok(Math.abs(b.x - work.x) <= 1);
    assert.equal(await js(win, 'document.documentElement.getAttribute("data-pos")'), 'left');
  });
}

/* ---------------- 场景：多选（v1.16） ---------------- */

async function runMultiSelect(win) {
  T.showRope();
  await sleep(400);
  await installMouseShield(win);

  const readme = path.join(ROOT, 'README.md');
  const srcDir = path.join(ROOT, 'src');
  const targets = [readme, srcDir];
  await js(win, `rope.addText('多选文字A')`);
  await js(win, `rope.addPaths(${JSON.stringify(targets)})`);
  await waitFor('挂件 3 件', async () => (await itemCount(win)) === 3);
  await sleep(450); // 等入场动画结束再读 rect

  /* 按类型取挂件元素与数据 */
  const elOf = async (i) =>
    `[...document.querySelectorAll('.item')][${i}]`;
  const ctrlClick = (expr) =>
    js(win, `${expr}.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); true`);

  await check('AC-135 「多选」按钮位于清空旁，初始未开启', async () => {
    const order = await js(
      win,
      'JSON.stringify([...document.querySelectorAll("#controls .icon-btn")].map((b) => b.id))'
    );
    assert.deepEqual(JSON.parse(order), ['btn-clear', 'btn-select', 'btn-settings']);
    assert.equal(await js(win, 'document.querySelector("#btn-select").classList.contains("on")'), false);
    assert.equal(await js(win, 'document.body.classList.contains("sel-mode")'), false);
  });

  await check('AC-136 点「多选」进入多选模式（按钮绿态 + body 标记）', async () => {
    await js(win, `document.querySelector('#btn-select').click(); true`);
    await sleep(150);
    assert.equal(await js(win, 'document.body.classList.contains("sel-mode")'), true);
    assert.equal(await js(win, 'document.querySelector("#btn-select").classList.contains("on")'), true);
  });

  await check('AC-137 Ctrl+点击勾选两件：仅这两件带 selected 与对勾徽标', async () => {
    await ctrlClick(`${await elOf(1)}`); // README
    await ctrlClick(`${await elOf(2)}`); // src 文件夹
    await sleep(120);
    const n = await js(win, 'document.querySelectorAll(".item.selected").length');
    assert.equal(n, 2, 'selected 数 ' + n);
    const badge = await js(
      win,
      'getComputedStyle(document.querySelector(".item.selected"), "::after").content'
    );
    assert.ok(String(badge).includes('✓'), '徽标内容 ' + badge);
  });

  await check('AC-138 Ctrl+再点同一件 = 取消勾选，数量随之变化', async () => {
    await ctrlClick(`${await elOf(1)}`);
    await sleep(120);
    assert.equal(await js(win, 'document.querySelectorAll(".item.selected").length'), 1);
    await ctrlClick(`${await elOf(1)}`);
    await sleep(120);
    assert.equal(await js(win, 'document.querySelectorAll(".item.selected").length'), 2);
  });

  await check('AC-139 多选状态下普通单击 = 勾选/取消勾选（单击复制停用）', async () => {
    await sleep(600); // 避开 Ctrl 点选后的 click 拦截窗口
    const before = clipboard.readText();
    const txt = `document.querySelector('.item.t-text')`;
    // 保证文字件初始未选中（前面用例可能勾过它）
    await js(
      win,
      `(() => { const el = ${txt}; if (el.classList.contains('selected')) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`
    );
    await sleep(600);
    const base = await js(win, 'document.querySelectorAll(".item.selected").length');
    await js(win, `${txt}.dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);
    await sleep(600);
    assert.equal(
      await js(win, 'document.querySelectorAll(".item.selected").length'),
      base + 1,
      '普通单击应勾选一件'
    );
    assert.equal(clipboard.readText(), before, '多选模式下单击不应复制');
    await js(win, `${txt}.dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);
    await sleep(600);
    assert.equal(
      await js(win, 'document.querySelectorAll(".item.selected").length'),
      base,
      '再点同一件应取消勾选'
    );
  });

  await check('AC-140 多选状态下双击不再打开（双击打开停用，也不降级复制）', async () => {
    await sleep(600); // 避开拦截窗口
    const before = clipboard.readText();
    const selCount = await js(win, 'document.querySelectorAll(".item.selected").length');
    await js(
      win,
      `document.querySelector('.item.t-text').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`
    );
    await sleep(400);
    assert.equal(clipboard.readText(), before, '多选模式下双击不应降级复制');
    assert.equal(
      await js(win, 'document.querySelectorAll(".item.selected").length'),
      selCount,
      '双击不应改变勾选状态'
    );
  });

  await check('AC-141 拖动选中件 = 整组换位（组内相对顺序不变）', async () => {
    // 选中 README(1) 与 src(2)，按住 README 抬起后拖到文字件(0)左侧 → 组插到最前
    const orderBefore = await js(win, `rope.getState().then(s => JSON.stringify(s.items.map(i => i.name || i.text)))`);
    const moved = await js(
      win,
      `(async () => {
        const els = [...document.querySelectorAll('.item')];
        const dragged = els[1]; // README（选中件）
        const textEl = els[0];  // 文字（组外参照）
        const r = dragged.getBoundingClientRect();
        const t = textEl.getBoundingClientRect();
        const mk = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 9, pointerType: 'mouse', isPrimary: true });
        dragged.dispatchEvent(new PointerEvent('pointerdown', mk(r.left + 20, r.top + 20)));
        await new Promise((res) => setTimeout(res, 220)); // 超过 150ms 抬起阈值
        document.dispatchEvent(new PointerEvent('pointermove', mk(t.left - 2, t.top + 20)));
        await new Promise((res) => setTimeout(res, 80));
        document.dispatchEvent(new PointerEvent('pointerup', mk(t.left - 2, t.top + 20)));
        return true;
      })()`
    );
    assert.equal(moved, true);
    await waitFor('排序落盘', async () => {
      const order = await js(win, `rope.getState().then(s => JSON.stringify(s.items.map(i => i.name || i.text)))`);
      return order !== orderBefore ? order : false;
    });
    const order = JSON.parse(
      await js(win, `rope.getState().then(s => JSON.stringify(s.items.map(i => i.name || i.text)))`)
    );
    // 组整体挪到文字前，组内仍 README 在前、src 在后
    assert.deepEqual(order, ['README.md', 'src', '多选文字A'], '顺序 ' + JSON.stringify(order));
  });

  await check('AC-142 拖出窗口 = 整组按顺序拖出（files 数组）', async () => {
    const before = T.dragLog.length;
    const ok = await js(
      win,
      `(async () => {
        const els = [...document.querySelectorAll('.item')];
        const dragged = els[0]; // README（选中件）
        const r = dragged.getBoundingClientRect();
        const mk = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 10, pointerType: 'mouse', isPrimary: true });
        dragged.dispatchEvent(new PointerEvent('pointerdown', mk(r.left + 20, r.top + 20)));
        await new Promise((res) => setTimeout(res, 220));
        document.dispatchEvent(new PointerEvent('pointermove', mk(r.left + 20, window.innerHeight + 30)));
        await new Promise((res) => setTimeout(res, 80));
        document.dispatchEvent(new PointerEvent('pointerup', mk(r.left + 20, window.innerHeight + 30)));
        return true;
      })()`
    );
    assert.equal(ok, true);
    await sleep(400);
    assert.ok(T.dragLog.length > before, '应记录到一次拖出');
    const last = T.dragLog[T.dragLog.length - 1];
    assert.equal(last.kind, 'multi');
    assert.deepEqual(last.target, [readme, srcDir], '载荷 ' + JSON.stringify(last.target));
  });

  await check('AC-143 文字挂件混选时自动跳过并计数', async () => {
    // 上一次拖出后 nativeDrag 标记要 2.5s 才解除，等它过期再发起下一次手势
    await sleep(2300);
    await ctrlClick(`document.querySelector('.item.t-text')`);
    await sleep(120);
    assert.equal(await js(win, 'document.querySelectorAll(".item.selected").length'), 3);
    const before = T.dragLog.length;
    await js(
      win,
      `(async () => {
        const els = [...document.querySelectorAll('.item')];
        const dragged = els[0];
        const r = dragged.getBoundingClientRect();
        const mk = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 11, pointerType: 'mouse', isPrimary: true });
        dragged.dispatchEvent(new PointerEvent('pointerdown', mk(r.left + 20, r.top + 20)));
        await new Promise((res) => setTimeout(res, 220));
        document.dispatchEvent(new PointerEvent('pointermove', mk(r.left + 20, window.innerHeight + 30)));
        await new Promise((res) => setTimeout(res, 80));
        document.dispatchEvent(new PointerEvent('pointerup', mk(r.left + 20, window.innerHeight + 30)));
        return true;
      })()`
    );
    await sleep(400);
    const last = T.dragLog[T.dragLog.length - 1];
    assert.ok(T.dragLog.length > before);
    assert.equal(last.skipped, 1, '应跳过 1 件文字');
    assert.deepEqual(last.target, [readme, srcDir]);
    // 取消文字勾选，恢复两件
    await ctrlClick(`document.querySelector('.item.t-text')`);
    await sleep(120);
  });

  await check('AC-144 只选文字件拖出：不发起拖拽，提示均不可插入', async () => {
    // 文字挂件本身无指针拖拽手势（HTML5 拖拽不参与群组），
    // 这里直接调主进程 multi 分支验证“全部不可插入”的拒绝路径
    const before = T.dragLog.length;
    await js(win, `rope.startDrag({ kind: 'multi', list: [{ kind: 'text', text: '多选文字A' }] }); true`);
    await sleep(400);
    assert.equal(T.dragLog.length, before, '不应记录拖出载荷');
    const toastText = await js(win, 'document.querySelector("#toast").textContent');
    assert.ok(/无法插入|跳过/.test(toastText), 'toast=' + toastText);
    // 离开多选，恢复干净状态
    await js(win, `document.querySelector('#btn-select').click(); true`);
    await sleep(150);
    assert.equal(await js(win, 'document.body.classList.contains("sel-mode")'), false);
  });

  await check('AC-145 Esc 退出多选：清空勾选、按钮复位', async () => {
    // 先进入多选并勾一件（直接按 Esc 在非多选态会进取件模式）
    await js(win, `document.querySelector('#btn-select').click(); true`);
    await sleep(120);
    await ctrlClick(`${await elOf(0)}`);
    await sleep(120);
    assert.equal(await js(win, 'document.querySelectorAll(".item.selected").length'), 1);
    await js(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(150);
    assert.equal(await js(win, 'document.body.classList.contains("sel-mode")'), false);
    assert.equal(await js(win, 'document.body.classList.contains("remove-mode")'), false, '不应误进取件模式');
    assert.equal(await js(win, 'document.querySelectorAll(".item.selected").length'), 0);
    assert.equal(await js(win, 'document.querySelector("#btn-select").classList.contains("on")'), false);
  });

  await check('AC-151 多选开启后再点一次「多选」按钮 = 退出（与 Esc 等效）', async () => {
    // AC-142 的整组拖出留有 2.6s 的 click 抑制窗口（防拖出后余 click 误复制），
    // 本用例是其后第一个"普通单击"用例，先等窗口过期
    await sleep(2800);
    // 按钮 → 普通单击勾选（v1.17：多选下单击即勾选，不需要 Ctrl）→ 再点按钮退出
    await js(win, `document.querySelector('#btn-select').click(); true`);
    await sleep(120);
    let n = 0;
    // 全量并行时偶有残留抑制窗口，最多重试 6 次（每次点击都是"勾选"语义，勾上就停）
    for (let i = 0; i < 6 && n === 0; i++) {
      await js(win, `document.querySelector('.item').dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);
      await sleep(500);
      n = await js(win, 'document.querySelectorAll(".item.selected").length');
    }
    const dbg = await js(
      win,
      `({ sel: document.body.classList.contains('sel-mode'), n: document.querySelectorAll(".item.selected").length, first: document.querySelector('.item').className })`
    );
    assert.ok(dbg.n >= 1, `多选下普通单击应能勾选 · 状态=${JSON.stringify(dbg)}`);
    await js(win, `document.querySelector('#btn-select').click(); true`);
    await sleep(150);
    assert.equal(await js(win, 'document.body.classList.contains("sel-mode")'), false);
    assert.equal(await js(win, 'document.querySelector("#btn-select").classList.contains("on")'), false);
    assert.equal(await js(win, 'document.querySelectorAll(".item.selected").length'), 0);
  });

  await check('AC-146 不开按钮直接 Ctrl+点击 = 隐式进入多选', async () => {
    await ctrlClick(`${await elOf(0)}`);
    await sleep(150);
    assert.equal(await js(win, 'document.body.classList.contains("sel-mode")'), true);
    assert.equal(await js(win, 'document.querySelectorAll(".item.selected").length'), 1);
    await js(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(120);
  });

  await check('AC-147 多选与取件互斥：进入取件模式自动退出多选', async () => {
    await js(win, `document.querySelector('#btn-select').click(); true`);
    await sleep(120);
    await ctrlClick(`${await elOf(0)}`);
    await sleep(120);
    assert.equal(await js(win, 'document.body.classList.contains("sel-mode")'), true);
    // 按住 Esc 进入取件模式（渲染层 keydown）
    await js(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(150);
    // 多选开着时 Esc 只退多选，不进取件
    assert.equal(await js(win, 'document.body.classList.contains("remove-mode")'), false);
    assert.equal(await js(win, 'document.body.classList.contains("sel-mode")'), false);
  });

  await check('AC-148 深色主题下选中态样式清晰（描边 + 绿色对勾）', async () => {
    await js(win, `rope.setSettings({ theme: 'dark' }); true`);
    await sleep(300);
    await ctrlClick(`${await elOf(0)}`);
    await sleep(150);
    const border = await js(
      win,
      'getComputedStyle(document.querySelector(".item.selected")).borderColor'
    );
    assert.notEqual(border, '', '应有描边');
    const btnBg = await js(
      win,
      'document.querySelector("#btn-select").classList.contains("on") ? getComputedStyle(document.querySelector("#btn-select")).backgroundColor : ""'
    );
    assert.match(btnBg, /0,\s*198,\s*92|0, 198, 92/, '按钮绿 ' + btnBg);
    // 还原
    await js(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await js(win, `rope.setSettings({ theme: 'light' }); true`);
    await sleep(250);
  });

  await check('AC-149 竖向停靠：多选进竖向图标栏，只显示图标 + 悬停浮层文字', async () => {
    await js(win, `rope.setSettings({ ropePosition: 'left' }); true`);
    await sleep(400);
    const inRail = await js(
      win,
      '(() => { const b = document.querySelector("#btn-select"); const r = b.getBoundingClientRect(); const sb = document.querySelector("#statusbar").getBoundingClientRect(); const label = b.querySelector(".btn-label"); const ls = getComputedStyle(label); return { inBar: r.left <= sb.left + 30 && r.width <= 30, labelHidden: ls.opacity === "0", labelPos: ls.position }; })()'
    );
    assert.equal(inRail.inBar, true, '应位于外侧图标栏且为图标钮');
    assert.equal(inRail.labelHidden, true, '文字默认隐藏');
    assert.equal(inRail.labelPos, 'absolute', '文字为浮层定位');
    await js(win, `rope.setSettings({ ropePosition: 'top' }); true`);
    await sleep(300);
  });

  await check('AC-150 本场景无渲染进程崩溃记录', () => {
    const crash = path.join(userData, 'crash.log');
    assert.ok(!fs.existsSync(crash), fs.existsSync(crash) ? fs.readFileSync(crash, 'utf8') : '');
  });
}

/* ---------------- v1.20d：显式唤出不被自动收回吞掉（summon） ----------------
   托盘"显示悬挂绳"点击时光标必然停在屏幕角落的托盘上——不在绳窗口内。
   修复前可见状态的离开判定 3 个轮询周期（约 180ms）就收回，绳"闪一下就没"。
   修复后显式唤出要等指针进入过窗口一次才开始常规收回判定。
   本场景轮询被冻结，用 __test.edgeWatchTick(注入坐标) 精确驱动每一拍。 */
async function runSummon(win) {
  const WA = screen.getPrimaryDisplay().workArea;
  const snap = () => T.snapshot();
  const tick = (p) => T.edgeWatchTick(p);
  // 托盘方向：工作区左下角（不在绳窗口内，也不在停靠热区上）
  const outside = () => ({ x: WA.x + 6, y: WA.y + WA.height - 6 });
  const inside = () => {
    const b = T.getWindow().getBounds();
    return { x: b.x + Math.floor(b.width / 2), y: b.y + Math.floor(b.height / 2) };
  };

  T.hideRope(true);
  await sleep(350); // 等收回弹簧收敛

  await check('AC-157 显式唤出（托盘语义）后指针没到窗口，绳持续可见', () => {
    T.showRope({ explicit: true });
    for (let i = 0; i < 20; i++) tick(outside());
    assert.equal(snap().ropeVisible, true, '20 拍（≈1.2s）后仍应可见');
  });

  await check('AC-158 显式唤出后指针来过一次，离开再走常规宽限收回', async () => {
    await sleep(400); // 等唤出弹簧收敛到 shown 边界，inside() 才落在真实窗口内
    tick(inside());
    tick(outside());
    tick(outside());
    assert.equal(snap().ropeVisible, true, '宽限期内仍在');
    tick(outside());
    assert.equal(snap().ropeVisible, false, '第 3 拍应收回');
  });

  await check('AC-159 非显式唤出保持原节奏：离开 3 拍即收回', () => {
    T.showRope();
    assert.equal(snap().ropeVisible, true);
    tick(outside());
    tick(outside());
    assert.equal(snap().ropeVisible, true, '宽限期内仍在');
    tick(outside());
    assert.equal(snap().ropeVisible, false);
  });

  await check('AC-160 本场景无渲染进程崩溃记录', () => {
    const crash = path.join(userData, 'crash.log');
    assert.ok(!fs.existsSync(crash), fs.existsSync(crash) ? fs.readFileSync(crash, 'utf8') : '');
  });
}


  console.log(`\n[e2e] 场景：${scenario}`);

  if (scenario === 'basic') await runBasic(win);
  else if (scenario === 'restore') await runRestore(win, true);
  else if (scenario === 'discard') await runRestore(win, false);
  else if (scenario === 'shortcut') await runShortcut(win);
  else if (scenario === 'click') await runClick(win);
  else if (scenario === 'dedupe') await runDedupe(win);
  else if (scenario === 'dedupe-restart') await runDedupeRestart(win);
  else if (scenario === 'theme') await runTheme(win);
  else if (scenario === 'theme-restart') await runThemeRestart(win);
  else if (scenario === 'office-icons') await runOfficeIcons(win);
  else if (scenario === 'item-limit') await runItemLimit(win);
  else if (scenario === 'position') await runPosition(win);
  else if (scenario === 'position-restart') await runPositionRestart(win);
  else if (scenario === 'multi-select') await runMultiSelect(win);
  else if (scenario === 'summon') await runSummon(win);
  else throw new Error('未知场景：' + scenario);

  console.log(`[e2e] ${scenario}: ${passes} 通过 / ${failures} 失败`);
  // 用 exit 直接退出，避免对话框或托盘拖住进程
  app.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('[e2e] 场景异常终止：', err && err.stack ? err.stack : err);
  app.exit(3);
});
