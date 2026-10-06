# aliceADV 更新日志

> 版本号唯一书写位置：`aliceadv/src/aliceadv/_version.py`（单行 `__version__`）。
> 包版本、产物展示版本、CLI `--version` 全部从该文件派生，详见其文件头注释。

---

## 未发布

### 新增功能

- **手柄焦点框导航**：识别到手柄（`gamepadconnected` 事件，或轮询 `getGamepads()` 发现任意已连接手柄）后，
  开始界面 / 菜单页的候选按钮会被圈上一张粗显眼的焦点框；方向键 / 左摇杆在按钮间切换，
  按 A（`Confirm`）点击当前选中项——手柄用户无需鼠标键盘即可进入游戏、操作菜单。
  焦点框仅在非舞台页、无浮层、无选项列表时显示；舞台播放期间自动停用，
  方向键照常归 `Auto` / `History` / 快存快读等舞台功能（靠 `Nav*` 不适用时返回假值放行）。
  - 实现位置：`engine.js` 的 `Focus` 模块（收集候选 / 移动 / A 确认点击），
    手柄存在检测在 `input.js`（`gamepadPresent()` / `onGamepadPresenceChange(cb)` / 测试注入 `_setGamepadForTest(v)`）。
  - 导航分两种策略：
    - **十字键**（`NavUp/Down/Left/Right`，priority 90）：**热区 / 自定义按钮模式**（候选全是
      `.title-custom-btn`）在加载时把按钮声明的 `left/top/width/height` 解析成中心做几何移动；
      **普通模式**（按钮列表 / 侧栏）按声明顺序直下（下 / 右 = 下一项、上 / 左 = 上一项，到头不动）。
    - **左摇杆**（新增）：摇杆比十字键多一维自由度（连续角度），**不再量化成四向**，而是真做坐标运算
      ——`input.js` 读 `axes[0]/axes[1]`、越过死区（0.4）的那一下回调 `Focus.moveVector(dx,dy)`，
      按「当前候选→各候选」连线方向与摇杆方向的**夹角**选按钮（夹角 ≤90° 的同侧候选里取最近，
      夹角几乎相同则取距离近的）。例：从 `start` 往右下 45° 推，`preference` 与摇杆方向只差约 36°、
      `load` 差约 65°，故落到 `preference`。回中后可再次触发（边沿检测，可连续导航）。
  - 外观可配置：`theme.json` 顶层 `focus` 块（`frameWidth` / `frameColor` / `frameColorActive` / `glow` / `radius` / `transition`），
    由 `builder.build_css_vars` 与 `theme.js` 的 `applyThemeVars` 写成 `--focus-*` 变量，`style/pages/focus.css` 读取；
    默认样式（粗 6px 白色实线环 + 柔和白光，`focus.css` 内置一层深色柔光保证浅色背景上可见）已内置，工程无需改动即生效。
  - 新增 4 个导航动作 `NavUp` / `NavDown` / `NavLeft` / `NavRight`（默认绑定手柄方向键），动作表 24 → 28；
    `docs/输入与按键.md` 动作表与 §2.1「手柄焦点框」、`tests/test_input_map.py` 的「文档↔代码一致」断言、
    `verify_input_actions.js` 的动作数 / 键位行数断言均已同步。

---

## v0.4.4 — 2026-09-28

相对上一 tagged 版本（v0.4.2）的累计改动。本版本围绕「关于页重做」「菜单页侧栏版式」「舞台提示条（notify / skip）」
三块做了较大改动，并顺手修了一批长期存在的细节 bug。

### 新增功能

- **关于页版式重做**：正文按**固定栏宽**（900 设计 px）排成一列，白底（「纸」）只包住这一列、
  在侧栏右侧区域**水平居中**；纸的左右两侧不再铺白底，直接透出整页 0.4 衬底。
  - 纸宽由「正文栏宽 + 左右页边距」单向推出；**不再用 `aspect-ratio` 反推纸宽**——
    那会把栏宽压到 572、换行整体错位（用户看到的是「文字被放大」，其实字号没动）。
  - 纸内文字滚动，纸高由主区高度决定；主内容区在本页不铺底色。
  - 字段：`about.css` 的 `--about-sheet-content / -gap / -pad-x / -pad-y`；`panelColor` 即纸色，写 `null` 可关。
- **关于页正文来源迁移到 `about.txt`**：正文（游戏简介 / 制作人员 / 版权声明等长文本）属于**内容**，
  不再写在 `theme.json` 里，改为工程根 `about.txt`（与剧本、素材同一套「一个文件放一类东西」的约定）。
  - 构建产物内联为 `window.__ABOUT__`（`file://` 直接可读）；模板模式由 `theme.js` 运行时 fetch 同一个文件；两入口只写一个变量。
  - 兼容：旧工程仍写在 `theme.json.about` 时，构建时沿用并打印迁移提示；`about.txt` 有内容时永远优先。
- **关于页版本行重做**：游戏版本与引擎版本合成**一行**、同框放一个圆角胶囊里，中间一条细竖线分隔。
  - 「引擎名 + 版本号」整体是一个指向引擎仓库的链接（URL 唯一来源 `ENGINE_REPO`），**无下划线**，hover 用「变色 + 淡底」提示。
  - 两个入口的版本号统一走 `verLabel()`，都带 `v` 前缀。
- **通知条 `notify`**（Ren'Py `renpy.notify` 等价物）：新增 `AliceADVEngine.notify(text)` / `clearNotify()`，
  供剧本与工程自定义 UI 调用；1.6s 后自动消失，循环调用以最后一次为准；离开舞台时自动清除（避免残影）。
  读取存档 / 快读**成功**时才弹「已读取存档」提示。骨架由 `theme.js` 随舞台页面建好，显隐只看 `.is-active`。
- **快进指示条 `skip_indicator`**（Ren'Py `gui.skip_indicator` 等价物）：三个三角依次闪烁；
  位置由 `theme.json` 的 `skipYpos` 决定；显隐是 `state.skip` 的纯视图，由 `script.js` 的 `syncPlaybackMode()` 单点同步。
- **菜单页侧边栏版式**：侧栏本身**不再是一块衬底**，改为每个按钮**各自纯白、完全不透明**的底色 + 一条非黑描边
  （`colors.muted`），底部「返回」用 `margin-top:auto` 压底且与上方按钮始终留缝。新键 `gameMenu.sidebarButtonColor`。
- **名字框锚点 `layout.name.anchor`**（Ren'Py `gui.name_xalign` 等价物，0~1 小数）：0 = 左缘贴合、0.5 = 中点对齐、1 = 右缘对齐，
  支持任意中间值；用 `transform: translateX()` 实现锚点语义，而非 `text-align`。`builder` 与模板模式两处同源写入。
- **`gui2theme` 补全翻译**：`dialogue_text_xalign` / `nvl_thought_xalign` → `layout.*.textAlign`（词）；
  `name_xalign` → `layout.name.anchor`（保留原始小数，不折算成 left/center/right）。

### 缺陷修复

- 关于页「游戏版本少一个 `v`」：`verLabel()` 收敛两处拼接为单一来源（此前标题页写 `"v"+v`、关于页写 `v`）。
- 关于页文字看起来被放大：根因是栏宽被 A4 比例压到 572，而非字号变化；改为固定 900 设计 px 栏宽。
- 菜单页 `grid-template-rows` 改为 `minmax(0, 1fr)`（写 `1fr` 无效）、关于页 body `min-height: 0`，
  防止内容把整页顶高（纸曾从 1012×968 被顶到 2000×2100 级、菜单从 1080 涨到 2156）。
- 读取 / 快读失败时不再误弹「成功」提示：`load()` / `loadQuick()` 返回是否成功，仅成功时 notify。
- 离开舞台时清除通知条，避免回到舞台看到上一条消息残影。
- 构建资产过滤：忽略 `*.bak` / `*.bak-*`（配置备份不进发行版，里面往往含旧正文旧样式）与 `documents/`。
- 移除 `pages.save.autoSlots`：引擎只有一个自动存档槽，该键是冗余且会误导（总数本就是 `slotCols × slotRows`）。
- 关于页移除了硬编码的「由 aliceADV 引擎驱动 (MIT License)」与「引擎仓库: …」两句，仓库地址改由版本行链接承担。

### 配置 / 约定

- `theme.json` 删除 `info` 与 `about` 字段：`info`（游戏名 / 版本）迁往 `info.json`，关于正文迁往 `about.txt`；
  文件头 `_comment` 明确本文件只描述**外观与界面**，不承载游戏内容。
- `window.__ENGINE__` 增加 `repo` 字段（来自 `ENGINE_REPO`，关于页链接的唯一来源）。
- `gameMenu` 新增 `sidebarButtonColor`（默认 `#FFFFFF`，与 `backgroundColor` / `panelColor` 同为单页可覆盖、写 `null` 关掉）。

### 测试 / 文档

- 静态守卫 `tests/test_theme_vars.py` 扩展至 **11 组**（新增：关于页文本来源 / 版本行 `v` / 定宽栏版式、
  通知条 & 快进条已接上、`autoSlots` 已移除、主题变量名 kebab 等）。
- `docs/样式控制.md` 同步更新（关于页版式、通知条 / 快进条、名字框锚点、菜单页侧栏版式）。

### 版本号

- `aliceadv/_version.py`：0.4.2 → 0.4.4。
- 注：仓库历史里 commit message、tag、文件版本号曾出现不一致（`test_version.py` 已守住「除 `_version.py` 外不许写死版本号字面量」）。
