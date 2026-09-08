# AliceADV

AliceADV 是一款基于网页的 ADV（视觉小说）游戏引擎。它沿用 Ren'Py 的设计语言：用 JSON 描述场景、对话、角色与分支，引擎产出可直接在浏览器运行的静态网页游戏。

引擎以 Python 包形式发布，提供 `create` / `build` 命令行工具。构建产物是纯 HTML/CSS/JS，无服务器、无运行时依赖——可通过 `file://` 直接打开 `index.html`，也可作为静态站点部署。

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [工程结构](#工程结构)
- [命令行参考](#命令行参考)
- [剧本概览](#剧本概览)
- [Ren'Py 迁移](#renpy-迁移)
- [架构说明](#架构说明)
- [文档](#文档)

## 安装

环境要求：Python >= 3.9。

从源码安装：

```bash
pip install ./aliceadv
```

开发模式（可编辑安装）：

```bash
pip install -e ./aliceadv
```

验证安装：

```bash
aliceadv --version
```

命令输出 `aliceADV 0.1.0 (engine v0.1)`。

## 快速开始

1. 创建工程。把引擎模板复制到一个新目录：

   ```bash
   aliceadv create my_game --name "我的游戏"
   ```

2. 编辑工程。修改 `theme.json` 调整样式，修改 `story/*.json` 编写剧本。完整指令见[文档](#文档)。

3. 构建工程。把引擎运行时与你的内容装配进 `my_game/dist/web/`：

   ```bash
   aliceadv build my_game
   ```

4. 游玩。用浏览器打开 `my_game/dist/web/index.html`，或启动本地服务：

   ```bash
   python3 -m http.server -d my_game/dist/web 8000
   ```

## 工程结构

`aliceadv create` 之后，用户工程结构如下：

```text
my_game/
├── theme.json        # 样式与界面文本（颜色、字体、字号、布局）
├── info.json         # 游戏名、版本、引擎字段
├── story/            # 剧本：chX.json、characters.json、chapters.json
├── gui/              # 界面图片（文本框、按钮、面板、浮层）
├── images/           # 内容图片：bg/、char/<角色id>/
├── audio/            # 音乐与音效
└── documents/        # 文档副本
```

`index.html` 外壳与引擎运行时 `style/` **不**存放在工程目录中。它们在构建时从引擎模板装配进产物。这让工程只保存内容，升级引擎后重新构建即可生效。

引擎模板本身位于包内的 `aliceadv/template/`。不要把 `aliceadv build` 指向它——构建命令会拒绝包含 `.aliceadv_engine` 标记文件的目录（即模板本身）。

## 命令行参考

| 命令 | 用途 |
|---|---|
| `aliceadv create <目录> [--name 名称] [--force]` | 复制引擎模板，创建新工程。 |
| `aliceadv build <目录>` | 构建工程到 `<目录>/dist/web/`。 |
| `aliceadv rpy2adv <script.rpy> <images_dir> <out_dir>` | 将 Ren'Py 剧本转换为 `story/` JSON。 |
| `aliceadv gui2theme <gui.rpy> <theme.json> [--apply]` | 将 Ren'Py `gui.rpy` 布局换算进 `theme.json`。 |

### aliceadv create

把模板内容（`gui/`、`images/`、`audio/`、`story/`、`theme.json`、`info.json`、`about.txt`、`documents/`）复制到目标目录。

| 参数 | 类型 | 必填 | 说明 | 默认值 |
|---|---|---|---|---|
| `目录` | string | 否* | 目标工程目录。 | 交互式输入 |
| `--name` | string | 否 | 写入 `info.json` 的游戏名。 | 模板默认值 |
| `--force` | flag | 否 | 目标目录非空时跳过二次确认。 | 关闭 |

\* 省略 `目录` 时，CLI 会提示输入。

引擎标记文件 `.aliceadv_engine` 与引擎运行时（`index.html`、`style/`）不会被复制进工程。

### aliceadv build

读取工程的 `theme.json` 与 `story/*.json`，把 `theme.json` 中的相对值（0–1）翻译为百分比 CSS 变量，将主题与剧本内联进 `index.html`，输出到 `<目录>/dist/web/`。

| 参数 | 类型 | 必填 | 说明 | 默认值 |
|---|---|---|---|---|
| `目录` | string | 否* | 待构建的工程目录。 | 交互式输入 |

\* 省略 `目录` 时，CLI 会提示输入。

行为与限制：

- 拒绝构建包含 `.aliceadv_engine` 的目录（即引擎模板本身）。
- 要求工程根目录存在 `theme.json`。
- 存在 `info.json` 时，其值会合并进 `theme.info`。
- `story/*.json` 被收集并内联为 `window.__SCRIPTS__`，以保证 `file://` 直接可玩。
- 构建是干净的：每次运行都会先删除再重建 `dist/web/`。

### aliceadv rpy2adv

将 Ren'Py 的 `.rpy` 剧本转换为 aliceADV 的 `story/` JSON。映射关系：`label` → 段（segment）、`jump` → `goto`、`menu` → `decide`、`$ x=...` → `set`、`default x=...` → `vars`、`if/elif/else` 块 → 单条指令的 `if` 执行条件。

### aliceadv gui2theme

将 Ren'Py `gui.rpy` 的几何与字号参数换算进 `theme.json` 的 `layout`/`sizes` 字段。不加 `--apply` 只打印换算结果；加 `--apply` 写回文件（非几何派生的字段保持不变）。

## 剧本概览

剧本由若干**段（segment）**组成。每段是一组有序指令——带 `cmd` 字段的 JSON 对象。一个最小可用剧本：

```json
{
  "start": "opening",
  "segments": {
    "opening": [
      { "cmd": "bg", "src": "images/bg/classroom.png" },
      { "cmd": "show", "char": "elin", "sprite": "normal", "at": "center" },
      { "cmd": "say", "char": "elin", "text": "晚上好。" }
    ]
  }
}
```

常用指令：

| 指令 | 用途 |
|---|---|
| `bg` / `scene` | 设置背景图。 |
| `show` / `hide` | 添加或移除角色立绘 / 图片。 |
| `sprite` | 替换已显示角色的立绘。 |
| `say` / `narrate` | 显示对话或旁白。 |
| `music` / `sound` / `voice` / `stop` | 控制音频。 |
| `set` / `if` / `decide` | 变量、条件跳转与玩家选项（分支）。 |
| `goto` | 跳转到另一段。 |
| `wait` / `end` | 暂停，或结束游戏。 |

分支通过变量与条件实现：某段可 `goto` 另一段，构成剧情图（story graph）；两条分支可在共享段汇合。共享段内的细微差异有两种轻量写法——在 `say` 文本内使用行内 `{if ...}`，或为单条指令添加 `if` 字段（条件不满足时该指令被跳过）。

完整指令参考（字段表、默认值、示例与限制）见 `documents/指令.md`。精确规格 `剧本格式说明.md` 位于 `aliceadv/template/documents/` 与你的工程 `documents/` 中。

## Ren'Py 迁移

提供两个辅助命令：

- `aliceadv rpy2adv` 转换剧本。
- `aliceadv gui2theme` 转换布局。

它们覆盖常见的 Ren'Py 映射（`label` / `jump` / `menu` / `$` / `default` / `if`）。并非所有 Ren'Py 特性都会被转换；转换后请审阅生成的 JSON，必要时手动调整。

## 架构说明

包结构将**引擎模板**（纯数据：`index.html`、`style/`、`gui/`、`story/`、`images/`、`audio/`、`documents/`）与**编译器实现**（`creator.py`、`builder.py`、`cli.py`、`cssutil.py`）分离。模板不含任何 Python 代码。

此分离是刻意的：若未来用其他语言重写编译器，可直接复用同一份 `template/` 目录与相同的 CLI 语义，无需改动模板内容。模板位置可通过环境变量 `ALICEADV_TEMPLATE` 覆盖，指向任意模板目录。

固定设计画布为 1920×1080。`theme.json` 中的数值按设计像素书写，或以相对值（0–1）书写、由构建翻译为 CSS。

## 文档

- `documents/指令.md` —— 指令手册（中文）：每条指令的用途、字段、示例与限制。
- `aliceadv/template/documents/剧本格式说明.md` 与工程 `documents/剧本格式说明.md` —— 精确规格：字段类型、默认值与边界。
- `girls_orbit_project/` —— 从 Ren'Py 演示项目移植的样例工程，含真实剧本、`theme.json` 与分支。

## 许可证

仓库目前尚未包含 LICENSE 文件。如需指定授权条款，请在仓库根目录添加该文件。
