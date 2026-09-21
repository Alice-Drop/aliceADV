# aliceADV 文档

aliceADV 是一个网页端 ADV（视觉小说）游戏引擎。剧情、角色与分支用 JSON 描述，编译器把它们打包成纯静态网页 —— 直接双击 `index.html` 即可游玩，也可托管为静态站点。

- 仓库：<https://github.com/Alice-Drop/aliceADV>
- 安装：`pip install aliceadv`

## 文档索引

| 文档 | 内容 | 主要读者 |
|---|---|---|
| [定义](定义.md) | 引擎定位、两层结构、目录与资源约定 | 全体 |
| [剧本格式说明](剧本格式说明.md) | `story/*.json` 的字段级规格 | 作者 |
| [指令手册](指令.md) | 每条剧本指令的用途、字段、示例与限制 | 作者 |
| [样式控制](样式控制.md) | `theme.json` 全部配置项、首页按钮机制、热区对齐 | 作者 |
| [信息配置](信息配置.md) | `info.json` 配置项与资源预加载策略 | 作者 |
| [编译原理](编译原理.md) | `aliceadv build` 的完整流程与默认值合并语义 | 维护者、进阶作者 |
| [先进脚本格式](先进脚本设计.md) | 一种尚未实现的候选脚本格式（设计笔记） | 维护者 |
| [Ren'Py GUI 参考](renpy文档.md) | Ren'Py GUI 定制化文档，迁移时的参考资料 | 参考 |

## 五分钟上手

```bash
pip install aliceadv
aliceadv create my_game
aliceadv build my_game
```

用浏览器打开 `my_game/dist/web/index.html` 即可游玩。之后修改 `my_game/theme.json`（样式）与 `my_game/story/*.json`（剧本），每次改完重新执行 `aliceadv build my_game`。

资源目录沿用 Ren'Py 约定：

| 目录 | 用途 |
|---|---|
| `gui/` | 界面图片（文本框、按钮、面板、叠加层） |
| `images/bg/` | 场景背景 |
| `images/char/<角色id>/` | 角色立绘 |
| `audio/` | 音乐、音效、语音 |

## 文档约定

- 文档的唯一副本位于本目录（引擎仓库 `docs/`），以 GitHub Pages 形式发布。
- 引擎包（`aliceadv`）内不含文档；`aliceadv create` 不会把文档复制进工程。
- 文档与引擎同仓库更新，同一次提交内保持一致，避免出现文档描述与代码不符。
- 工程目录下的 `documents/` 属作者自建内容，`aliceadv build` 会将其排除在发行产物之外。
