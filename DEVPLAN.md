# 悬挂绳 · 开发计划（可执行版）

> 依据：`PRD.md` v1.5（自 v1.0 起逐版追加）
> 约定：✅ = 已实现并通过对应测试/验证；⬜ = 未完成（本计划执行完毕后已无 ⬜ 项）。🧪 表示该阶段必须有可运行测试。
> 执行方式：按 P0 → P18 顺序推进，每阶段先跑测试，失败先修再进下一阶段。

---

## 0. 范围与完成定义

**范围**：PRD 第 3 章 F1–F11 全部功能 + 第 5 章 AC-01 ~ AC-60。

**"完成"的定义**（三选一，缺一不可）：

1. 功能在代码中实现，且能被自动化测试直接或间接观察到；
2. 无法自动化的部分（真实鼠标触顶、真实拖放到微信/Word、托盘图标外观），在测试矩阵中明确标注"手工"，并给出可照做的检查步骤；
3. `npm test` 全绿（单元测试 + Electron 端到端场景），且连续运行两次结果一致。

**测试分层**：

| 层 | 位置 | 运行方式 | 覆盖 |
| --- | --- | --- | --- |
| 单元测试 | `test/unit/*.test.js` | `node --test`（纯 Node，不需要 GUI） | 数据层（store）、窗口几何/触顶判定、拖拽载荷规划 |
| 端到端 | `test/e2e/scenarios.js` | Electron 主进程内运行，真实创建窗口/渲染页面 | 窗口形态、渲染、手势、IPC、持久化、恢复、快捷方式、缓存 |
| 手工 | 本文档第 3 节"手工清单" | 人工操作 | 真实拖放到第三方软件、托盘、多显示器 |

---

## 1. 阶段总览

| 阶段 | 内容 | 状态 | 对应验收项 |
| --- | --- | --- | --- |
| P0 | 测试基建（可测性改造 + 运行器） | ✅ | — |
| P1 | 数据层：持久化、排序、缓存、迁移 | ✅ 功能 / ✅ 测试 | AC-33/34/35，F8/F10 |
| P2 | 悬浮窗形态与唤出/收回 | ✅ 功能 / ✅ 测试 | AC-01~06，F1 |
| P3 | 悬挂：文字/文件/文件夹/图片/超长 | ✅ 功能 / ✅ 测试 | AC-07~09，F2 |
| P4 | 拖出：文件/文件夹/图片/文字 | ✅ 修复 / ✅ 测试 | AC-11~14，F4 |
| P5 | 文件夹浏览：竖排列表/滚轮/行拖出/背景不放大 | ✅ 功能 / ✅ 测试 | AC-15~18，F5 |
| P6 | 排序与防闪烁 | ✅ 功能 / ✅ 测试 | AC-19~22，F6 |
| P7 | 取件：按住 Esc + 点击 | ✅ 功能 / ✅ 测试 | AC-23~26，F3 |
| P8 | 复制即悬挂 + 悬停 Ctrl+V | ✅ 功能 / ✅ 测试 | AC-27~30，F7 |
| P9 | 持久化恢复询问 | ✅ 功能 / ✅ 测试 | AC-10，F8 |
| P10 | 快捷方式 .lnk：映射/自愈/悬空降级 | ✅ 功能 / ✅ 测试 | AC-31~32，F9 |
| P11 | 设置与缓存管理（UI 侧，v1.2 起改为独立窗口） | ✅ 功能 / ✅ 测试 | AC-34/35，F10 |
| P12 | 轨道横向滚动（PRD 2.3 缺口） | ✅ 新增 | F3 展示要求 |
| P13 | 全量回归、文档、收尾 | ✅ | AC-36 |
| P14 | 反馈修复：网页图片破图 + 背景滚轮横向滚动 | ✅ 功能 / ✅ 测试 | AC-37/38/39 |
| P15 | 反馈修复：设置改为独立普通窗口 | ✅ 功能 / ✅ 测试 | AC-40~43，F10 |
| P16 | 反馈增强：文件夹面板内 📌 固定子文件夹 | ✅ 功能 / ✅ 测试 | AC-44~46，F5 |
| P17 | 反馈增强：📌 再点一次取消固定（开关语义） | ✅ 功能 / ✅ 测试 | AC-47~50，AC-45，F5 |
| P18 | 反馈增强：单击复制 / 双击打开 | ✅ 功能 / ✅ 测试 | AC-51~60，AC-13/26，F3/F5 |

---

## 2. 分阶段任务清单

### P0 测试基建（本轮新增）

- ✅ **P0-1** `src/main/store.js` 支持纯 Node 运行：`userData` 解析顺序改为 `HANGING_ROPE_USERDATA` → Electron `app.getPath('userData')` → 系统临时目录；`defaultCacheDir` 的家目录兜底改用 `os.homedir()`。目的：单元测试不必启动 GUI，也不会写用户真实数据。
- ✅ **P0-2** 抽出 `src/main/geometry.js`：`computeWindowBounds(display, height)`、`isTopEdgeHit(point, display, winX, winW, tol)`、`shouldAutoHide(...)`，主进程改为调用它。目的：AC-03/05/06 的判定可被单元测试直接断言。
- ✅ **P0-3** 主进程拖拽改造：抽出 `planDrag(payload)`（解析 target / 校验存在性 / 快捷方式映射 / 悬空降级警告），`startDrag` 复用它；新增仅测试可用的 `HANGING_ROPE_TEST_DRY_DRAG`（记录载荷但不真正发起系统拖拽）与 `module.exports.__test`（`showRope/hideRope/onPastePressed/addPaths/addTextItem/planDrag/addImageBuffer/getSnapshot`）。
- ✅ **P0-4** 恢复询问可编程回答：`HANGING_ROPE_RESTORE_ANSWER=restore|discard`（仅测试用，正常启动仍弹窗）。
- ✅ **P0-5** `test/run-tests.js` 运行器 + `npm test` / `test:unit` / `test:e2e` 脚本；每个 E2E 场景用独立 `HANGING_ROPE_TEST_USERDATA` 临时目录，跑完清理。

**完成判据**：`npm test` 能跑起来（哪怕断言还很少），失败时退出码非 0。

### P1 数据层（功能已实现）

- ✅ 原子写入 `state.json`（先写 `.tmp` 再 rename）、150ms 防抖保存
- ✅ 挂件增删改序、清空
- ✅ 文字单条上限 50000 字符
- ✅ 图片缓存：写入、总量统计、孤儿清理、清空、更换目录迁移
- ✅ **测试**：`test/unit/store.test.js`
  - 载入时丢弃未知类型；`text` 超长截断；`shortcut` 字段保留
  - `addItem/removeItem/reorder` 后 `saveNow()` 落盘内容与内存一致；`reorder` 传入残缺 id 列表时其余项追加到末尾且不丢失
  - `save()` 防抖后落盘
  - `saveImageToCache` 生成的文件存在且字节一致；`cacheUsage().bytes` 与实际一致
  - `pruneOrphans` 删除未引用、保留被引用
  - `migrateCache` 把文件搬到新目录并改写 `cachePath`；同目录迁移为 0
  - `clearCache` 清空文件并把图片挂件标记 `invalid`
  - `defaultCacheDir()` 以 `LOCALAPPDATA` 结尾为 `HangingRope/cache`

### P2 悬浮窗形态与唤出（功能已实现）

- ✅ 1/3 屏宽、水平居中、透明无边框、置顶、跳过任务栏
- ✅ 默认 y = -高度（完全隐藏）
- ✅ 顶部中间 1/3 触顶（连续 2 个轮询周期 ≈120ms）才唤出；左右两侧不触发
- ✅ 离开 3 个轮询周期（≈180ms）收回；拖拽/悬停期间不收回
- ✅ 上下滑动 150ms 缓出
- ✅ **测试**：`test/unit/geometry.test.js`（宽高/居中/触顶边界/左右两侧/防误触计数）+ E2E（隐藏位置、唤出后 y=0、收回后 y=-210、窗口尺寸）

### P3 悬挂（功能已实现）

- ✅ 文件/文件夹只存路径；文字存文本；图片落地副本；图片文件按原路径预览
- ✅ 超过 50000 字符拒绝并 toast
- ✅ 粘贴文本若本身是现存路径 → 按文件/文件夹悬挂
- ✅ **测试**：E2E 依次挂入 文字 / 图片文件 / 文件夹，断言挂件数量、`t-image` 类与 `<img>`、`state.json` 落盘字段（文件项无 bytes/无副本）

### P4 拖出（本轮修缺口）

- ✅ **P4-1** 文字挂件 `dragstart` 未写入 `text/plain`，拖到记事本/聊天框会没有内容 → 补 `setData('text/plain', item.text)` 与 `effectAllowed='copy'`（AC-13）。
- ✅ 文件/文件夹/图片走系统原生拖放（`startDrag`），先 `preventDefault` 避免双拖拽会话
- ✅ 悬空快捷方式拖出降级发送 `.lnk` 并提示；源文件丢失时不发起拖拽并提示
- ✅ **测试**：E2E 在页面内派发 `dragstart`，断言 `DataTransfer.getData('text/plain')` 等于原文；`planDrag` 单元测试覆盖 文件/文件夹/图片/悬空 lnk/丢失路径。

### P5 文件夹浏览（功能已实现）

- ✅ 悬停 200ms 展开；一屏 3 行、左名右图、选中行高亮；表头 `n / m`
- ✅ 滚轮切换（面板与挂件上均可滚）
- ✅ 行上按住拖动即拖出（与挂件同一套指针手势，移动 > 8px 触发）
- ✅ 面板展开时绳索条背景固定 210px（`#shell::before`），窗口变高不放大背景
- ✅ **测试**：E2E 断言面板 3 行、`1 / N`、`.sel` 行、滚轮后计数变化、`::before` 计算高度 = 210px、窗口高度 = 410、行拖出产生正确 `planDrag` 载荷

### P6 排序与防闪烁（功能已实现）

- ✅ 按住 150ms 抬起（放大 + 金色描边 + 投影）；横向拖动实时换位；松手提交并持久化
- ✅ 向下拖出窗口底边才转为对外拖出
- ✅ 入场动画只挂在新挂件（`anim-in`，动画结束移除）；排序期间禁用过渡 → 修复闪烁
- ✅ **测试**：E2E 合成 pointerdown → 150ms → 多次 pointermove，采样每步 `opacity`（必须恒为 1）与 `el.getAnimations().length`（必须为 0），并断言 DOM 顺序随指针变化、pointerup 后 `state.json` 顺序一致

### P7 取件（功能已实现）

- ✅ 按住 Esc 进入（窗口聚焦用真实 keydown/keyup；未聚焦用全局键自动重复保活 650ms）
- ✅ 点击挂件取下，可连续取下多件；松开 Esc 退出
- ✅ 取件态视觉：卡片红边 + 右上角"取下"角标 + 顶部红色提示条
- ✅ **测试**：E2E 派发 keydown → 断言 `body.remove-mode` 与提示条可见 → 点击两个挂件断言逐个移除 → keyup 退出 → 双击不误删

### P8 复制即悬挂（功能已实现）

- ✅ `Ctrl+Alt+H` 与胶囊开关；状态持久在内存并回推 UI
- ✅ 监听剪贴板：文件（UTF-16LE 解析 `FileNameW`）> 文字 > 图片；重复内容不重复挂
- ✅ 悬停绳索时 `Ctrl+V` 手动挂载（force，重复时提示"已经挂在绳上了"）
- ✅ **测试**：E2E 点击胶囊断言 `copyMode` 与高亮；`__test.onPastePressed()` 连续两次同样文字断言只增一件；剪贴板放真实文件路径断言挂上文件挂件

### P9 持久化与恢复（功能已实现）

- ✅ 每次变更落盘；启动时若存在挂件则弹窗询问恢复/不恢复
- ✅ **测试**：`restore` 场景（预置 5 件 → 启动 → 断言 5 件且顺序一致）、`discard` 场景（断言 0 件且 `state.json.items` 为空）

### P10 快捷方式（功能已实现）

- ✅ 挂入即解析到本体（路径/名称/类型都换成本体）
- ✅ 启动自愈：历史 `.lnk` 挂件重新解析
- ✅ 悬空快捷方式保留原样，拖出降级发送 `.lnk` 并提示
- ✅ **测试**：E2E 用 `shell.writeShortcutLink` 造一个指向真实文件的 `.lnk` → `addPaths` → 断言 `path === target`、`name === basename(target)`、`shortcut === lnk`；再造一个指向不存在目标的 `.lnk` → 断言 `path` 仍是 `.lnk` 且 `planDrag` 返回降级警告

### P11 设置与缓存管理（功能已实现）

- ✅ 面板：缓存目录展示/更换（弹目录选择 → 迁移）、上限编辑保存、占用统计、清理未引用、清空缓存、快捷键展示、清空全部、退出
- ✅ **测试**：E2E 打开设置面板断言目录/上限/占用/快捷键文本非空；`rope.setSettings({cacheLimitMB: 50})` 后 `state.json.settings` 生效；缓存迁移在 P1 单测覆盖

### P12 轨道横向滚动（本轮新增）

- ✅ **P12-1** PRD 2.3 要求"挂件超出宽度可横向滚动"，当前 `#track` 只是 `overflow-x:auto` 且隐藏滚动条，鼠标滚轮无法横向滚动 → 增加 wheel 处理（`deltaY` → `scrollLeft`，无溢出时不拦截）。测试：E2E 挂够 8 件使轨道溢出后派发 `wheel`，断言 `scrollLeft > 0`。

### P13 回归与收尾

- ✅ 连续运行 `npm test` 两次（含全部 E2E 场景），确认稳定
- ✅ 更新 `README.md`（测试命令、测试目录说明）
- ✅ 更新 `DEVPLAN.md` 状态与勾选
- ✅ 记录工作日志

### P14 反馈修复（v1.1）

**现象 1：网页图片挂上后是破图。**
根因：缓存扩展名由 `content-type` 子类型直接拼出来 —— `image/svg+xml` → `split('/')[1]` = `svg+xml` → 文件名 `img_xxx.svgxml`。本地 `file://` 加载时 Chromium 按扩展名判 MIME，认不出 `.svgxml` 就不当图片渲染，卡片上是破图标。用户机器上实测文件 `img_mwau6kh0_…svgxml` 内容是 SVG（1620×560）。

- ✅ **P14-1** 新增 `src/main/image-format.js`（纯函数）：`sniffExt` 按文件头魔数识别 png/jpg/gif/webp/bmp/ico/avif/svg；`extFromMime` 正确把 `image/svg+xml` 映射为 `svg`、剥掉 `+xml`/`x-`/`vnd.` 结构后缀；`resolveImageExt` 优先级 = 字节 > mime > 文件名；`parseDataUrl` 同时支持 base64 与 percent-encoded；`svgSize` 读 width/height 或 viewBox；`isRenderableExt` 拦掉 tiff/heic 这类 Chromium 显示不了的格式。
- ✅ **P14-2** `main.js`：`addImageBuffer` 改为按字节决定扩展名，不再信任上游 ext；内容不是图片（如防盗链 HTML）时拒绝悬挂并给明确提示；SVG 用 `svgSize` 补宽高。`addImageFromUrl` 的 content-type 检查放宽为"字节或 mime 任一像图片即可"，并支持非 base64 的 data URL。剪贴板图片、拖入 File、网页 URL 三条入口统一走这条路。
- ✅ **P14-3** 挂件名称改为可读名（网页图片用 URL 末段、拖入的 File 用原文件名、剪贴板用"剪贴板图片"），不再显示 `img_xxx` 哈希名。
- ✅ **P14-4** `store.healImageExtensions()`：启动时读缓存文件头嗅探真实格式，扩展名不符就改名并改写 `cachePath`（**只动缓存目录内的副本**，用户原文件绝不改名）。用于修复历史坏图。
- ✅ **P14-5** 渲染层 `<img>` 加 `onerror` 兜底：加载失败显示"预览不可用"占位块，替代浏览器破图标。

**现象 2：鼠标在挂件下方空白背景处滚轮，绳索不横向滚动。**
根因：`wheel` 监听绑在 `#track` 上，事件只在该元素内触发；卡片下方的空白属于 `#shell`，滚轮事件根本到不了监听器。

- ✅ **P14-6** 监听提升到 `document` 级：绳索条内任意位置（含卡片下方空白、绳索两侧、状态栏）滚轮即横向滚动；无溢出时不拦截；`#folder-panel` / `#settings-panel` 内的滚轮被排除在外。
- ✅ **P14-7** 文件夹挂件与文件夹面板的 wheel 处理加 `stopPropagation()`，避免"翻列表"和"横向滚动"同时发生。

**测试**

- ✅ `test/unit/image-format.test.js`（9 项）：各格式嗅探、带 BOM/XML 声明的 SVG、HTML 非图片、`svg+xml` → `svg`、mime 撒谎时字节优先、不可渲染格式拦截、data URL 两种写法、svgSize。
- ✅ `test/unit/store.test.js` 追加 4 项：`saveImageToCache` 非法扩展名按字节纠正、`healImageExtensions` 改名并落盘、缓存目录外文件不动、二次执行幂等。
- ✅ E2E `basic` 追加 4 项：SVG 以 `.svg` 落地并**真的画出图**（`img.naturalWidth > 0`）、mime 撒谎仍按字节纠正、HTML 内容拒绝悬挂、挂件下方背景滚轮横滚（正向 + 反向）与"面板内滚轮不联动"。
- ✅ 测试卫生：`run-tests.js` 为每个 E2E 场景注入隔离的 `LOCALAPPDATA`，避免测试的"清空缓存/清理孤儿"动到用户真实缓存目录。
- ✅ 反向验证（两条，均先改坏再还原）：
  - 禁用 `sniffExt` 的 SVG 识别 → 单元测试 4 项失败、E2E「mime 撒谎」用例失败；
  - 把 `wheel` 监听退回 `#track` → E2E「背景空白处滚轮」失败（`scrollLeft 0`，落点 `shell`），与用户反馈一致。
- ✅ 用用户机器上真实的坏文件 `img_mwau6kh0_…svgxml` 做自愈验证（复制到临时目录，只读原文件）：`.svgxml` → `.svg`，内容确认是 SVG。

### P15 设置改为独立普通窗口（v1.2）

**现象**：设置是绳索条里的浮层，鼠标一离开顶部绳索收回，设置跟着消失；改完一个值想再改下一个就得重新唤出，实际不可用。用户要求"单独的、普通进程的窗口，右上角有关闭按钮"。

**根因**：设置面板是 `index.html` 里的 `#settings-panel`，渲染在绳索悬浮窗内部（透明、无边框、置顶、跟随收回），本质上是绳索的一部分而不是独立窗口。

- ✅ **P15-1** `main.js` 新增 `openSettingsWindow()`：真正的 `BrowserWindow`（`frame:true` / `resizable` / `minimizable` / `skipTaskbar:false` / `alwaysOnTop:false`），居中于主屏工作区，`titleBar` 为系统原生（右上角关闭按钮）。已打开时只 `show()+focus()` 并推送一次刷新，不会开出第二个。
- ✅ **P15-2** 新增 IPC `open-settings`、`settings:info`（设置 + 缓存占用 + 挂件数 + 复制模式）、`settings:clear-all`；`sendState()` 末尾统一 `notifySettings()`，挂件/缓存放生变化时设置窗口自动刷新；目录选择框的父窗口改为设置窗口（打开时）。
- ✅ **P15-3** 新增 `src/renderer/settings.html` + `settings.css` + `settings.js`：深色双卡片（图片缓存 / 悬挂绳），路径单独占行不再被按钮挤成省略号，占用用进度条表示，底部"退出程序 / 关闭"。Esc 可关（输入框聚焦时先失焦，不误关）。
- ✅ **P15-4** 删除绳索内的 `#settings-panel` 及其样式与 `openSettings/closeSettings/fillSettings` 逻辑；状态栏「设置」改为 `rope.openSettings()`；托盘「设置」直接开窗（不再先唤出绳索）；顺带清掉 `EXPANDED_HEIGHT` 常量与不再使用的 `fmtSize`。
- ✅ **P15-5** 修复过程中踩到的坑：`settings.js` 里写 `const rope = window.rope` 会与 contextBridge 定义的全局绑定重名，整段脚本 `Identifier 'rope' has already been declared` 直接不执行（页面全是"—"）。改为直接使用全局 `rope`。

**测试**

- ✅ E2E `basic` 追加 5 项并移除旧的"设置面板"2 项：点按钮后窗口数 = 2 且非父子窗口、`isClosable/isResizable/isAlwaysOnTop` + 系统标题栏高度 > 20、`hideRope(true)` 后设置窗口仍可见未销毁、在设置窗口改上限落盘、Esc 关窗后引用清空且重开为新窗口。
- ✅ 顺手修掉 AC-16 的假失败隐患：计数基线改为紧贴滚轮前读取（原先用很早的快照，中途重渲染会让用例偶发失败，与产品无关）。
- ✅ 反向验证：把设置窗口改回 `frame:false` + `alwaysOnTop:true` → AC-41 失败（"不应该置顶"），还原后全绿。
- ✅ 视觉验证：用隔离数据目录启动，截图确认 620×570 窗口内容无滚动条、无截断（`.test/settings-win.png`）。

### P16 文件夹面板内 📌 固定子文件夹（v1.3）

**需求**：文件夹（1）的浏览面板里还有子文件夹（2）时，在子文件夹行**右侧显示 📌**，点击即把文件夹（2）固定到绳上，不必先拖出再拖回来。

**取舍**：只给**目录行**加 📌（需求就是"固定子文件夹"）；拖出仍然是"按住行拖动"，两者用事件隔离而不是换手势。

- ✅ **P16-1** 新增 `src/main/paths.js`：`pathKey / samePath` 纯函数（小写 + 正斜杠 + 去末尾分隔符 + 盘符根补斜杠），用于判断"这个目标是不是已经在绳上了"。
- ✅ **P16-2** `main.js` 新增 `pinPath(raw)`：解 `.lnk` → `stat` 校验（不存在则返回 `missing`）→ 路径去重（已在绳上返回 `already`）→ 否则按拖入同一套字段 `addItem` 并 `sendState()`；新增 IPC `pin-path`（invoke，返回结果给渲染层提示）。
- ✅ **P16-3** `preload.js` 暴露 `rope.pinPath(path)`。
- ✅ **P16-4** 渲染层：目录行右侧追加 `.fp-pin`（文件行追加同宽 `.fp-pin-slot` 占位，保证缩略图纵向对齐）；点击后 toast「已固定：xxx」/「已经在绳上了」，并把 📌 切成金色 `on` 态；面板保持打开可连续钉。
- ✅ **P16-5** 手势隔离：📌 上 `pointerdown` 即 `stopPropagation()`，行拿不到按下事件 → 不会启动"按住行拖动＝拖出"；`click` 也 `stopPropagation()`，不干扰行的选中逻辑。
- ✅ **P16-6** 视觉细节：面板宽度 300 → 332（给 📌 让位，避免文件名被挤成省略号）；emoji 📌 静息态 `grayscale+brightness` 去色成灰钉，悬停/已固定恢复原色，避免三行红点抢视觉。

**测试**

- ✅ 单元 5 项（`test/unit/paths.test.js`）：大小写、斜杠方向、末尾分隔符与盘符根、中文与空格路径、空值/不相等。
- ✅ E2E `basic` 6 项：文件夹行有 📌 而文件行只有占位（含右端间距 ≤12px、垂直偏差 ≤2px）、按 📌 拖动不产生拖出载荷、点 📌 新增文件夹挂件且路径/名称正确、📌 变 `on`、面板不关闭、再点不重复且提示文案。
- ✅ 反向验证：①把 `pinPath` 的去重判断去掉 → AC-45「不重复添加」失败；②去掉 📌 上的 `pointerdown stopPropagation` → AC-46「不应产生拖出载荷」失败。两处均已还原。
- ⚠️ 过程中发现 AC-46 一开始是"假通过"：上一步 AC-17 的拖出会把渲染层的 `ui.nativeDrag` 置真 2.5 秒，这期间行的按下事件被直接忽略，于是无论有没有拦截都拖不出去。已改为先等 2.5 秒再做探针，反向验证才真正失败。
- ✅ 视觉验证：隔离环境截图确认三行排布、灰钉与已固定金色态（`.test/pin-panel.png`、`.test/pin-done.png`）。

### P17 📌 再点一次取消固定（v1.4）

**需求**：文件夹面板里的 📌 不再是"只进不出"的一次性按钮 —— 点一下固定，**再点同一枚即取消固定**，把该子文件夹从绳上取下来；按钮态要跟绳上真实状态一致。

**取舍**：

- 不新增手势、不新增按钮，仍是原地同一枚 📌；方向由"点击瞬间该路径是否已挂在绳上"决定（AC-47/48）。
- 取消固定走主进程新 IPC，而不是渲染层直接 `removeItem(id)`：路径归一化规则只在 `src/main/paths.js` 维护一份，且能一次摘掉所有等价变体（AC-50）。
- 取消时**不做 stat 校验**：源目录已被移动 / 删除也要能把挂件取下来。
- 按钮态不只在点击时改，每次 `onState` 都按绳上真实状态校准一遍（AC-49）。

- ✅ **P17-1** `src/main/paths.js` 新增 `pinnedItems(items, p)`：返回所有指向同一目标的文件 / 文件夹挂件；`pinPath` 的去重与 `unpinPath` 的摘除共用它，规则不漂移。
- ✅ **P17-2** `main.js` 新增 `unpinPath(raw)`：解 `.lnk` → `pinnedItems` 找全部匹配 → 逐个 `store.removeItem` → `sendState()`；找不到返回 `removed:false`，路径非法返回 `bad-path`；新增 IPC `unpin-path`。`pinPath` 的查找改用 `pinnedItems(...)[0]`。
- ✅ **P17-3** `preload.js` 暴露 `rope.unpinPath(path)`。
- ✅ **P17-4** 渲染层新增 `applyPinVisual / syncPinButton / syncPinButtons`：📌 存 `data-path`，点击按 `isPinnedPath` 决定调用 `pinPath` 或 `unpinPath`，toast「已固定 / 已取消固定 / 这个文件夹已经在绳上了」；成功后立刻改视觉（不等状态推送），`onState` 里 `syncPinButtons()` 做最终校准。`dataset.busy` 拦连点，避免一次操作里方向交错。
- ✅ **P17-5** 既有约束一条不降：📌 上 `pointerdown` / `click` 仍 `stopPropagation()`（AC-46）、面板不关闭（AC-45）、文件行仍是 `.fp-pin-slot` 占位（AC-44）。

**测试**

- ✅ 单元 5 项（追加到 `test/unit/paths.test.js`）：等价变体命中、只算 folder/file、多份变体全部返回、前缀相同不误命中、空值 / 非法输入安全返回。
- ✅ E2E `basic` 59 → 62 项：把原「再点不重复添加，只提示已经在绳上了」按新需求改为 AC-47「再点 = 取消固定」，新增 AC-48「取消后可重新固定且始终只有一件」、AC-49「从别处取下后 📌 自动熄灭」、AC-50「多份等价变体一次摘净」。**原"不重复添加"的要求没有删除**，改由 AC-48 的固定 → 取消 → 固定循环继续守着。
- ✅ 反向验证：①去掉 `onState` 里的 `syncPinButtons()` → AC-49 失败（61 通过 / 1 失败）；②把 `unpinPath` 改成只删 `matches[0]` → AC-50 失败「两份应被一次摘净」（61 通过 / 1 失败）。两处均已还原，加固测试代码后又各重跑一次，结论不变。
- ✅ **稳定性加固（本轮踩坑）**：连续跑全量套件时，basic 里靠"固定 `sleep(700)` + 取最后一个 folder 挂件"定位面板偶发失准 —— 状态推送慢会定位到错误的文件夹，宿主真实光标掠过触发 `mouseleave` 又会在 260ms 后按设计收起面板，曾出现 10 项连带假失败（第一次全绿、第二次 10 失败）。改为：`waitItemId()` 按路径等挂件出现、`openFolderPanel()` 按 `data-id` 精确锁定并条件等待面板展开、AC-50 用 `waitFor` 等两份变体挂件到位；再加 `installMouseShield()` **只拦授信（真实）鼠标边界事件**，合成事件 `isTrusted=false` 仍完整走产品逻辑；AC-49 等待期间模拟"鼠标停在面板上"（产品本来就不收起）。**断言标准一条未改，产品代码未因此改动**；加固后 `npm test` 连续三次全绿（当时共 120 项）。
- ✅ 交互细节：按钮 `title` 随状态在「固定到绳上」与「取消固定（已在绳上）」之间切换；金色 `on` 态语义从"只提示"改为"可再点取消"（`styles.css` 注释同步）。

### P18 单击复制 / 双击打开（v1.5）

**需求**：绳上挂件与文件夹面板里的行统一改成「单击（未按住拖动）= 复制到系统剪贴板，双击 = 用系统默认程序打开」；按住 0.15 秒抬起排序、向下拖出、按住 `Esc` 取件全部优先，绝不误触。

**取舍与前置验证**：

- **剪贴板格式实测**：先用独立 Electron 进程写 `clipboard.writeBuffer('FileNameW', utf16le(paths.join('\0') + '\0\0'))`，再用系统剪贴板 API 验证 `ContainsFileDropList() = True` 且路径正确 —— Chromium 会自动呈现标准 `CF_HDROP`，资源管理器 / 微信可直接粘贴；项目自身 `readClipboardFiles()` 也按同一套规则读回。实验前后备份并恢复了用户原剪贴板。结论：**不引入新依赖、不调用 PowerShell / Win32**，纯 Electron API 即可。
- 「打开」用 `shell.openPath`；文字没有文件本体 → 退化成复制并提示；网页图片打开其缓存副本。
- 自动化里双击只记 `openLog`、不真启动程序（`HANGING_ROPE_TEST_DRY_OPEN`），避免每次测试弹出记事本 / 看图器。

- ✅ **P18-1** 新增 `src/main/item-action.js` 纯函数：`planCopy / planOpen / fileNameWBuffer`，挂件与面板行共用同一套类型分流，规则不漂移。
- ✅ **P18-2** `main.js` 新增 `copyItemToClipboard / openItemTarget`、IPC `copy-item` / `open-item`、测试出口 `openLog`；写完剪贴板**必调 `snapshotClipboard()`** 刷新「复制即悬挂」基线。`preload.js` 暴露 `rope.copyItem / rope.openItem`。
- ✅ **P18-3** 渲染层新增 `clickBlocked / markClickBlocked / doCopy / doOpen`；挂件与面板行都绑定单击复制、双击打开；`e.detail >= 2` 跳过双击的第二次复制；`actionToastSeq` 保证最后发起的那次操作的提示不被先返回的 IPC 覆盖。
- ✅ **P18-4** 手势优先：`lift / commitReorder / dragOutFromItem / 文字 dragend` 全部 `markClickBlocked`；取件模式、拖拽态由 `clickBlocked()` 统一挡掉。
- ✅ **P18-5** 面板行单击改为 `selectFolderRow()` 只改高亮与计数、**不重建 DOM**，保证 `dblclick` 能派发；📌 的 `dblclick` 也 `stopPropagation`，固定/取消固定不受影响。
- ✅ **P18-6（顺带修真 bug）** `setRemoveMode(on, fromMain)`：主进程回传的 `remove-mode` 事件只同步 UI、不再回发 IPC，消除「按下 → 点击 → 松开」快速连发时的 `true→false→true` 回环（会让取件模式关不掉，后续单击全变成"取下"）。basic 的 AC-23~26 回归验证通过。

**测试**

- ✅ 单元 10 项（`test/unit/item-action.test.js`）：复制分流、打开分流、文字退化、`FileNameW` 字节（单/多路径/空值）。
- ✅ 新增独立 E2E 场景 `click` 15 项：AC-51~AC-60 全覆盖（含取件模式、📌 不受影响、自我悬挂、源丢失、两种手势不误触）。独立场景，不与 basic 抢剪贴板 / `nativeDrag` 保护窗口。
- ✅ 反向验证见 6.2 表；basic 62 项回归全绿。

---

## 3. 测试矩阵（AC → 手段）

| 验收项 | 手段 | 位置 |
| --- | --- | --- |
| AC-01 启动/托盘/无任务栏 | 自动（进程存活、无崩溃日志）+ 手工（托盘图标） | E2E / 手工 |
| AC-02 启动不可见 | 自动（bounds.y = -210） | E2E |
| AC-03 1/3 宽居中 | 自动（几何单元测试 + 窗口 bounds） | 单测 + E2E |
| AC-04 唤出/收回 | 自动（几何判定 + `__test.showRope/hideRope`）+ 手工（真实鼠标） | 单测 + E2E |
| AC-05 两侧不唤出 | 自动（`isTopEdgeHit` 边界） | 单测 |
| AC-06 掠过不唤出 | 自动（连续 tick 计数） | 单测 |
| AC-07 五类挂件 | 自动（DOM 类名/数量）+ 手工（网页图片） | E2E / 手工 |
| AC-08 大文件只存路径 | 自动（state 项无 bytes、缓存目录不增长） | E2E |
| AC-09 超长文字拒绝 | 自动 | E2E |
| AC-10 恢复一致 | 自动（restore/discard 场景） | E2E |
| AC-11/12 文件·文件夹拖入外部 | 手工（真实拖到微信/资源管理器） | 手工 |
| AC-13 文字拖出/单击复制 | 自动（DataTransfer 内容）+ 手工（落到记事本） | E2E / 手工 |
| AC-14 原件不受影响 | 自动（拖出计划不改动源文件、mtime/大小不变） | E2E |
| AC-15/16 面板与滚轮 | 自动 | E2E |
| AC-17 行拖出 | 自动（dry-drag 载荷）+ 手工（落到微信） | E2E / 手工 |
| AC-18 背景不放大 | 自动（`::before` 高度） | E2E |
| AC-19/20 抬起与换位 | 自动 | E2E |
| AC-21 下拖转拖出 | 自动（dry-drag 载荷 + 窗口底边判定） | E2E |
| AC-22 无闪烁 | 自动（逐帧 opacity/animations 采样） | E2E |
| AC-23/24/25 取件 | 自动 | E2E |
| AC-26 退出后行为正常 | 自动（双击不删除） | E2E |
| AC-27/28/29 复制即悬挂 | 自动（文字/文件/去重） | E2E |
| AC-30 悬停 Ctrl+V | 自动（`__test.onPastePressed`） | E2E |
| AC-31/32 快捷方式 | 自动（`shell.writeShortcutLink` 造样本） | E2E |
| AC-33 即时落盘 | 自动（读 `state.json`） | E2E |
| AC-34 迁移 | 自动（单测） + 手工（目录选择框） | 单测 / 手工 |
| AC-35 超限提示 | 自动（`cacheUsage` + toast 触发条件） | 单测 |
| AC-36 无崩溃日志 | 自动（两次启动后 `crash.log` 不存在/无新增） | E2E |
| AC-37 网页 SVG 正常显示、扩展名正确 | 自动（扩展名 + `img.naturalWidth > 0` + 启动自愈单测） | 单测 + E2E |
| AC-38 非图片内容拒绝悬挂 | 自动（挂件数不变 + toast 文案） | E2E |
| AC-39 背景空白处滚轮横滚 | 自动（`elementFromPoint` 落点 = `#shell` 后派发 wheel，断言 `scrollLeft` 变化） | E2E |
| AC-40 设置是独立窗口 | 自动（点 `#btn-settings` 后窗口数 2、非父子窗口） | E2E |
| AC-41 设置是普通窗口 | 自动（`isClosable/isResizable/isAlwaysOnTop` + `outerHeight-innerHeight>20` 证明有系统标题栏） | E2E |
| AC-42 绳索收回后设置窗口不消失 | 自动（`hideRope(true)` 后 `isVisible() && !isDestroyed()`） | E2E |
| AC-43 关闭/重开且唯一 | 自动（Esc 关闭 → `getSettingsWindow()===null` → 重开 `id` 不同、窗口数 2） | E2E |
| AC-44 文件夹行有 📌、文件行无 | 自动（按行读 `.fp-pin` / `.fp-pin-slot` + 右端间距与垂直居中） | E2E |
| AC-45 点 📌 固定且不重复 | 自动（挂件数 +1、path/name 断言、`pin.on`、面板未关；AC-48 循环固定/取消再验不重复） | 单测 + E2E |
| AC-46 📌 上拖动不触发拖出 | 自动（pin 上 pointerdown→move→up，断言 `dragLog` 长度不变） | E2E |
| AC-47 再点 📌 取消固定 | 自动（挂件数回到固定前、路径消失、`on` 熄灭、title/toast、面板仍开） | E2E |
| AC-48 取消后可重新固定且不重复 | 自动（再点后该路径恰好 1 件、总数 = 基准 +1、`on` 亮起） | E2E |
| AC-49 别处取下后 📌 自动熄灭 | 自动（`rope.removeItem` 后不重开面板，断言 `on` 为假且面板仍开） | E2E |
| AC-50 等价变体一次全摘 | 自动（同时挂两份大小写变体 → 点一次后全部消失、无新增）+ `pinnedItems` 单测 | 单测 + E2E |
| AC-51 单击文字挂件复制 | 自动（`clipboard.readText()` 等于原文 + toast） | E2E |
| AC-52 单击文件挂件复制成文件对象 | 自动（`clipboard.readBuffer('FileNameW')` 解析出该绝对路径，且 `readText()` 为空） | E2E |
| AC-53 单击图片挂件复制图片 | 自动（`clipboard.readImage()` 非空且有尺寸） | E2E |
| AC-54 双击打开本体 | 自动（dry-run `openLog` 三条载荷 = 文件 / 文件夹 / 图片缓存副本） | E2E |
| AC-55 文字双击退化 | 自动（`openLog` 不增长、剪贴板仍是原文、toast 含"文字"） | 单测 + E2E |
| AC-56 手势后不误复制 | 自动（排序与拖出两种手势后补发 click，剪贴板哨兵不变） | E2E |
| AC-57 取件模式优先且能复位 | 自动（Esc 按下→点击→松开后挂件 -1、剪贴板哨兵不变；后续单击仍按复制语义工作） | E2E |
| AC-58 面板行同语义 + 📌 不受影响 | 自动（行单击复制 + 选中、双击打开、📌 固定/取消固定、剪贴板哨兵不变） | E2E |
| AC-59 复制不自我悬挂 | 自动（开启"复制即悬挂"后单击复制，跨两轮 700ms 轮询挂件数不变） | E2E |
| AC-60 源丢失明确提示 | 自动（删掉源文件后单击，剪贴板哨兵不变 + toast 含"已丢失"） | E2E |

**手工清单（无法自动化，交付时逐条自测）**：

1. 托盘图标存在、右键菜单四项可用；任务栏无按钮（AC-01）。
2. 真实鼠标触顶唤出、离开收回、快速掠过不出现（AC-04/06）。
3. 文件/文件夹拖入微信、Word、资源管理器；文字拖入记事本（AC-11/12/13）。
4. 文件夹面板某行拖入微信（AC-17）。
5. 设置窗口里点"更换…"选择目录并确认迁移（AC-34）；顺便看标题栏右上角的 × 是否能关窗（AC-41）。
6. 网页图片拖入（需联网抓图，重点看 SVG/WebP 和"抓回来是 403 页面"两种情况）（AC-37/38）。
7. 真实双击挂件 / 面板行，确认系统默认程序确实打开对应对象（自动化为 dry-run，只校验载荷不启动程序）（AC-54）；顺手把单击复制出的文件粘贴到微信 / 资源管理器，确认落下的是文件本体而不是路径文本（AC-52）。
7. 绳索条内挂件下方空白处滚轮横向滚动（AC-39）。

---

## 4. 执行顺序与命令

```
npm test          # 单元 + 全部 E2E 场景
npm run test:unit # 只跑纯 Node 单元测试
npm run test:e2e  # 只跑 Electron 场景
```

阶段推进规则：

1. 改代码 → 跑该阶段测试 → 失败则定位修复 → 通过后进下一阶段；
2. 不允许删测试、跳过测试、放宽断言；
3. 若发现实现与 PRD 冲突，以 PRD 为准改实现；若 PRD 本身有歧义，记录在本文档"待确认"里。

## 5. 已知风险

| 风险 | 处理 |
| --- | --- |
| 系统原生拖放（`startDrag`）在自动化中会阻塞等待鼠标释放 | 测试用 `HANGING_ROPE_TEST_DRY_DRAG` 只校验载荷，真实拖放交手工 |
| 全局 Esc / `Ctrl+V` 会劫持系统按键 | 测试直接调内部函数，不注册真实全局键；生产逻辑不变 |
| 单实例锁与用户正在运行的实例冲突 | 所有测试使用独立 `HANGING_ROPE_TEST_USERDATA` |
| 弹窗类 UI（恢复询问、目录选择）无法自动点击 | 恢复询问加测试用回答开关；目录选择只在单测覆盖迁移逻辑 |

---

## 6. 执行结果（2026-11-11，v1.5 更新）

### 6.1 测试套件与结果

| 套件 | 命令 | 用例数 | 结果 |
| --- | --- | --- | --- |
| 单元测试（store / geometry / drag-plan / image-format / paths / item-action） | `npm run test:unit` | 59 | 全部通过 |
| E2E `basic`（形态·悬挂·网页图片·文件夹·📌固定/取消·排序·取件·复制·滚动·设置窗口） | `npm run test:e2e` | 62 | 全部通过 |
| E2E `shortcut`（.lnk 映射与悬空降级） | `npm run test:e2e` | 6 | 全部通过 |
| E2E `restore`（恢复上次悬挂） | `npm run test:e2e` | 2 | 全部通过 |
| E2E `discard`（选择不恢复） | `npm run test:e2e` | 1 | 全部通过 |
| E2E `click`（单击复制 / 双击打开，AC-51~60） | `npm run test:e2e` | 15 | 全部通过 |
| **合计** | `npm test` | **145** | **连续三次全绿** |

### 6.2 反向验证（证明测试不是空跑）

| 故意改坏的地方 | 期望 | 实际 |
| --- | --- | --- |
| 注释掉文字挂件 `dragstart` 里的 `setData('text/plain', …)` | AC-13 失败 | ✗ AC-13 失败（41 通过 / 1 失败） |
| 禁用 `#track` 的 `wheel` 监听 | 轨道滚动失败 | ✗ F3 横向滚动失败（41 通过 / 1 失败） |
| 禁用 `sniffExt` 的 SVG 识别（P14） | AC-37 失败 | ✗ 单元测试 4 项失败、E2E「mime 撒谎仍按字节纠正」失败 |
| 把 `wheel` 监听退回 `#track`（P14） | 背景滚动失败 | ✗ AC-39「挂件下方背景空白处滚轮」失败：`scrollLeft 0`，落点 `shell` |
| 设置窗口改回 `frame:false` + `alwaysOnTop:true`（P15） | AC-41 失败 | ✗ AC-41「设置窗口是普通窗口」失败：不应该置顶 |
| 去掉 `pinPath` 的路径去重（P16） | AC-45 失败 | ✗ AC-45「不重复添加」失败：挂件数 +1 |
| 去掉 📌 的 `pointerdown stopPropagation`（P16） | AC-46 失败 | ✗ AC-46「不应产生拖出载荷」失败（58 通过 / 1 失败） |
| 去掉 `onState` 里的 `syncPinButtons()`（P17） | AC-49 失败 | ✗ AC-49「📌 自动熄灭」失败：📌 不应还留在已固定态（61 通过 / 1 失败） |
| `unpinPath` 只删 `matches[0]`（P17） | AC-50 失败 | ✗ AC-50「多份变体一次摘净」失败：两份应被一次摘净（61 通过 / 1 失败） |
| 去掉挂件 `click` 里的 `clickBlocked()`（P18） | AC-56 / AC-57 失败 | ✗ AC-56 两条「手势后不复制」+ AC-57「取件模式不复制」失败（12 通过 / 3 失败） |
| 去掉 `copyItemToClipboard` 里的 `snapshotClipboard()`（P18） | AC-59 失败 | ✗ AC-59「不自我悬挂」失败：挂件数不应增加（14 通过 / 1 失败） |
| 恢复 `onRemoveModeEvent` 的 IPC 回环（P18） | AC-58 / AC-60 失败 | ✗ AC-58「双击面板行打开」、AC-60「源丢失提示」失败（13 通过 / 2 失败） |

以上改动均已还原并重跑，全绿。

### 6.3 代码改动清单

- 新增 `src/main/geometry.js`：窗口尺寸/居中/触顶热区/收回判定，纯函数。
- 新增 `src/main/drag-plan.js`：拖出载荷决策（图片副本、快捷方式映射、悬空降级、源丢失）。
- 新增 `src/main/image-format.js`（P14）：字节嗅探 + mime/文件名兜底 + data URL 解析 + SVG 尺寸；扩展名不再由 `content-type` 直接拼接（修复 `.svgxml`）。
- `src/main/store.js`：支持 `HANGING_ROPE_USERDATA` 覆盖（纯 Node 可测）；`load()` 先重置内存；`saveNow()` 取消挂起的防抖定时器；`saveImageToCache` 扩展名非法时按字节纠正；新增 `healImageExtensions()` 启动自愈旧坏缓存。
- `src/main/main.js`：改用 geometry / drag-plan / image-format；图片三入口统一按字节落地并拒绝非图片内容；启动时执行图片扩展名自愈；新增测试出口 `__test`、干跑拖拽 `HANGING_ROPE_TEST_DRY_DRAG`、冻结光标轮询 `HANGING_ROPE_TEST_FREEZE_WATCHER`、恢复回答 `HANGING_ROPE_RESTORE_ANSWER`（均只在测试环境生效）。
- `src/preload/preload.js`：`addImageBuffer/addImageUrl` 增加 `mime` / `name` 透传。
- `src/renderer/app.js`：文字挂件 `dragstart` 写入 `text/plain`；滚轮横向滚动提升到 `document` 级（背景任意位置可滚，面板内排除）；文件夹挂件/面板 wheel `stopPropagation`；`<img>` 加载失败显示占位；哈希缓存名显示为「图片 · SVG」。
- `src/renderer/styles.css`：`.thumb-broken` 占位样式。
- 新增 `src/main/paths.js`（P16）：`pathKey/samePath` 路径等价判断（主进程与渲染层共用同一套规则）。
- 新增 `src/renderer/settings.html` / `settings.css` / `settings.js`（P15）：独立设置窗口页面。
- `src/main/main.js`（P15）：`openSettingsWindow/notifySettings/settingsSnapshot`、`open-settings`、`settings:info`、`settings:clear-all`；托盘「设置」直接开窗；`__test` 暴露 `openSettingsWindow/getSettingsWindow/settingsSnapshot`。
- `src/renderer/index.html` / `app.js` / `styles.css`（P15）：移除内嵌 `#settings-panel` 及其逻辑与样式，状态栏「设置」改调 `rope.openSettings()`。
- `src/main/main.js` + `src/preload/preload.js` + `src/renderer/app.js` + `styles.css`（P16）：`pinPath` 与 IPC `pin-path`、面板行内 📌（含占位、手势隔离、`on` 态）、面板宽度 332。
- `src/main/paths.js`（P17）：新增 `pinnedItems(items, p)`，固定去重与取消摘除共用同一套归一化判定。
- `src/main/main.js` + `src/preload/preload.js`（P17）：`unpinPath` 与 IPC `unpin-path`、`rope.unpinPath`；`pinPath` 改用 `pinnedItems`。
- `src/renderer/app.js` + `styles.css`（P17）：`applyPinVisual / syncPinButton / syncPinButtons`、📌 点击按固定态切换 pin/unpin、`onState` 状态校准、`data-path`、金色态注释语义更新。
- `test/unit/paths.test.js`（P17）：新增 `pinnedItems` 5 项单测（等价变体、类型过滤、多份全返回、前缀不误命中、非法输入）。
- `test/e2e/scenarios.js`（P17）：新增 AC-47~50 四条用例；新增 `waitItemId / openFolderPanel / installMouseShield` 三个辅助，文件夹面板定位由"最后一个 folder 挂件 + 固定 sleep"改为按 id 精确定位 + 条件等待；收尾清理路径比较改为大小写不敏感。
- 新增 `src/main/item-action.js`（P18）：`planCopy / planOpen / fileNameWBuffer` 纯函数，挂件与面板行共用。
- `src/main/main.js` + `src/preload/preload.js`（P18）：`copyItemToClipboard / openItemTarget`、IPC `copy-item` / `open-item`、`rope.copyItem / rope.openItem`、`openLog` 与 `HANGING_ROPE_TEST_DRY_OPEN`；写剪贴板后刷新监听基线。
- `src/renderer/app.js`（P18）：单击复制 / 双击打开（挂件 + 面板行）、`clickBlocked / markClickBlocked / actionToastSeq`、`selectFolderRow()` 轻量选中、📌 `dblclick` 隔离、`setRemoveMode` 去回环。
- 新增 `test/unit/item-action.test.js`（P18，10 项）；`test/e2e/scenarios.js` 新增独立 `click` 场景（15 项）；`test/run-tests.js` 注册该场景并注入 `HANGING_ROPE_TEST_DRY_OPEN`。
- 新增 `test/unit/*.test.js`（4 个文件 39 项）、`test/e2e/scenarios.js`（4 个场景）、`test/run-tests.js`（运行器，E2E 注入隔离 `LOCALAPPDATA`）。
- `package.json`：新增 `test` / `test:unit` / `test:e2e`。

### 6.4 仍需人工验收的 7 条

见第 3 节"手工清单"。这些依赖真实鼠标/真实第三方窗口，自动化无法替代；建议按清单逐条点一遍，尤其"拖文件进微信""拖行内容进微信""更换缓存目录""网页图片拖入"四项。
