# =========================================================
# aliceADV builder — 构建机制（按「工程目录」构建）
#
# 读取用户工程目录下的 theme.json / info.json / story/*.json，
# 把 theme.json 中的「相对值(0~1)」翻译为百分比 CSS 变量，
# 把整个工程复制/构建到  <工程目录>/dist/web/ ，生成可直接 file:// 打开的 web 产物。
#
# 架构约定：
#   - 引擎模板位于 aliceadv/template/（含 index.html / style / gui / story / ...），
#     模板本身不是工程，严禁对其直接 build（见 ENGINE_MARKER 自检）。
#   - 用户在自己「工程目录」（由 aliceadv create 创建）里编写 theme.json / story 等，
#     然后运行  aliceadv build <工程目录>  对该工程构建。
#   - 构建产物与工程源码分离，输出到 <工程目录>/dist/web/。
#
# 用法：
#   aliceadv build <工程目录>          # 命令行
#   build_project(project_dir)         # 以函数方式调用（供其它工具集成）
# =========================================================
import json
import os
import shutil
import re
import time

from . import (ENGINE_MARKER, ENGINE_RUNTIME, ENGINE_VERSION, ENGINE_NAME,
               ENGINE_REPO, template_path)
from .cssutil import rewrite_css_asset_paths

# 复制工程到 dist/web 时忽略的项（避免递归 / 引擎内部文件 / 用户的 dot 文件）。
# documents/：作者自己的说明文档，属于写作资料而非游戏内容，不应随发行版发给玩家
#（引擎官方文档在仓库 docs/，同样不随包也不随工程分发）。
# *.bak*：改配置前的备份（theme.json.bak-20260927 之类）是作者本地的历史，不是游戏内容，
#        不该跟着发行版发出去——里面往往还留着旧正文与旧样式。
IGNORE_PATTERNS = ("dist", ".git", ".gitignore", ".workbuddy", ".DS_Store",
                   ".idea", ".vscode", ENGINE_MARKER, "__pycache__", "*.pyc",
                   "*.bak", "*.bak-*", "documents")

# 关于页正文放这里（工程根）。
# 正文属于「内容」而非「样式」：theme.json 只描述外观与界面，长篇文本与剧本、素材
# 一样各自占一个文件。构建时读取并内联为 window.__ABOUT__；模板模式由 theme.js fetch。
ABOUT_FILE = "about.txt"


def _safe_clear_directory(target):
    """清空 target 目录下的全部内容，但保留以 '.' 开头的文件/目录（.git / .workbuddy / .DS_Store 等）。

    用于清理构建产物 dist/web：只移除旧的构建文件，绝不误删用户放在 dist/web 下的
    git 仓库或工具配置等 dot 文件。"""
    if not os.path.isdir(target):
        return
    for name in os.listdir(target):
        if name.startswith("."):
            continue
        p = os.path.join(target, name)
        try:
            if os.path.islink(p) or os.path.isfile(p):
                os.remove(p)
            else:
                shutil.rmtree(p)
        except OSError as e:
            print("  ! 清理 %s 失败: %s" % (p, e))


def rel(v, fallback=None):
    """数字(0~1) → 百分比字符串；字符串 → 原样透传；None → fallback（默认 None）。

    返回 None 表示「这一项没有值」，调用方应**跳过**该行，而不是写一个兜底字面量：
    默认值的唯一来源是模板 theme.json，最后一道兜底在 CSS 的 var(--x, 默认) 里。"""
    if v is None:
        return fallback
    if isinstance(v, (int, float)):
        return f"{v * 100:.4g}%"
    return str(v)


_KEBAB_RE = re.compile(r"([a-z0-9])([A-Z])")


def css_name(s):
    """字段名 → CSS 变量名：统一 kebab-case。

    CSS 侧的既有约定就是 kebab（--color-accent-deep / --size-page-heading），
    若按驼峰拼名字（--color-accentDeep），就会出现「构建写一个名、CSS 读另一个名」的错位，
    theme.json 里的驼峰键（accentDeep / idleSmall / pageHeading / sectionHeading）会静默失效。

    本函数必须与 template/style/theme.js 的 cssName() 保持一致——两处都在写同一批变量，
    构建期写进 theme.built.css，运行期写进 documentElement 的内联样式。"""
    return _KEBAB_RE.sub(r"\1-\2", str(s).replace("_", "-")).lower()


def build_css_vars(theme):
    lines = [":root {"]

    # 字号：基于设计宽度 1920 的比例（输出为 px，由 #stage transform 整体缩放）
    sizes = theme.get("sizes", {})
    for k, v in sizes.items():
        if k.startswith("_"):
            continue
        lines.append(f"  --size-{css_name(k)}: calc(var(--design-w) * {v} / 1920);")

    # 颜色（跳过 _comment 等内部说明键；键名 kebab 化，见 css_name 的说明）
    for k, v in theme.get("colors", {}).items():
        if k.startswith("_"):
            continue
        lines.append(f"  --color-{css_name(k)}: {v};")

    # 字体（支持字符串栈 或 对象形态 {family, src, fallbacks}）
    for k, v in theme.get("fonts", {}).items():
        if k.startswith("_"):
            continue
        if isinstance(v, dict):
            fam = v.get("family")
            if not fam:
                continue
            fb = v.get("fallbacks")
            val = f'"{fam}"' + (f", {fb}" if fb else "")
            lines.append(f"  --font-{k}: {val};")
        else:
            lines.append(f"  --font-{k}: {v};")

    # 屏幕
    sc = theme.get("screen", {})
    # 宽高比：不参与布局计算（#stage 的尺寸由 --design-w/--design-h 决定），仅供自行引用。
    if sc.get("aspect"):
        lines.append(f"  --aspect: {sc['aspect'].replace(':', ' / ')};")
    if sc.get("designWidth"):
        lines.append(f"  --design-w: {sc['designWidth']}px;")
    if sc.get("designHeight"):
        lines.append(f"  --design-h: {sc['designHeight']}px;")
    if sc.get("overflowColor"):
        lines.append(f"  --overflow-color: {sc['overflowColor']};")

    # 存档槽：不写死 cols / 宽高比，没配就不写（CSS 侧 var(--slot-cols, 3) 等负责兜底）
    slot = theme.get("slot")
    if slot:
        if slot.get("cols") is not None:
            lines.append(f"  --slot-cols: {slot['cols']};")
        if slot.get("width") is not None and slot.get("height") is not None:
            lines.append(f"  --slot-aspect: {slot['width']} / {slot['height']};")

    if theme.get("notifyYpos") is not None:
        lines.append(f"  --notify-ypos: {theme['notifyYpos']};")
    if theme.get("skipYpos") is not None:
        lines.append(f"  --skip-ypos: {theme['skipYpos']};")

    # 布局自由度（相对值 → 百分比 / em）。
    # 这里**不写任何字面兜底默认值**：默认值的唯一来源是模板 theme.json
    # （build 时 _deep_merge(模板, 工程) 已合并进来），最后一道兜底写在 CSS 的 var(--x, 默认) 里。
    # 在构建脚本里再抄一份 '5%' / '3.4em'，就是同一份默认值的第三处副本——
    # 改模板却漏改这里，就会出现「模板改了、页面没变」的假象。
    def add(name, val):
        if val is None:
            return
        lines.append(f"  {name}: {val};")

    L = theme.get("layout", {})
    d = L.get("dialogue", {})
    add("--dialogue-left",   rel(d.get("left")))
    add("--dialogue-bottom", rel(d.get("bottom")))
    add("--dialogue-width",  rel(d.get("width")))
    add("--dialogue-height", rel(d.get("height")))
    # padX / padY 是「派生基准」（左右取 padX、上下取 padY），属于配置内部的继承关系，不是默认值
    _padx = d.get("padX")
    add("--dialogue-pad-x",      _padx)
    add("--dialogue-pad-left",   d.get("padLeft", _padx))
    add("--dialogue-pad-right",  d.get("padRight", _padx))
    add("--dialogue-pad-top",    d.get("padTop", d.get("padY")))
    add("--dialogue-pad-bottom", d.get("padBottom", d.get("padY")))
    add("--dialogue-justify",    d.get("justify"))
    add("--dialogue-text-align", d.get("textAlign"))
    n = L.get("name", {})
    add("--name-left", rel(n.get("left")))
    add("--name-top",  rel(n.get("top")))
    # 名字框锚点：Ren'Py gui.name_xalign 的等价物（0~1，0=左缘贴合）。
    # 原样透传（数值，不是相对值），不做字面兜底——默认值在模板 theme.json 的 layout.name.anchor。
    add("--name-anchor", n.get("anchor"))
    s = L.get("sprite", {})
    add("--sprite-bottom", rel(s.get("bottom")))
    add("--sprite-height", rel(s.get("height")))
    v = L.get("nvl", {})
    add("--nvl-left",       rel(v.get("left")))
    add("--nvl-width",      rel(v.get("width")))
    add("--nvl-line-gap",   v.get("lineGap"))
    add("--nvl-justify",    v.get("justify"))
    add("--nvl-text-align", v.get("textAlign"))
    c = L.get("choice", {})
    add("--choice-left",      rel(c.get("left")))
    add("--choice-top",       rel(c.get("top")))
    add("--choice-width",     rel(c.get("width")))
    add("--choice-gap",       c.get("gap"))
    add("--choice-max-width", c.get("maxWidth"))
    t = L.get("toolbar", {})
    add("--toolbar-height", t.get("height"))
    add("--toolbar-gap",    t.get("gap"))

    lines.append("}")
    return "\n".join(lines)


def build_panel_css(theme):
    """游戏内暂停菜单（.ingame-menu 浮层）的停靠方向、窗口尺寸。

    由 theme.json 的 panel 控制：
      - panel.side:   "left" / "right" / "center"（默认 "right"）
      - panel.width:  窗口宽（px，相对 info.json 的 screen.designWidth 转换为比例）
      - panel.height: 窗口高（px，相对 screen.designHeight；可选，缺省为整屏高）

    构建时把 px 转换为相对于设计画布的比例（与 定义.md「按钮以 px 为单位 → 比例」一致），
    覆盖模板 menu.css 中的默认停靠（right）与默认宽（26%）。
    """
    panel = theme.get("panel") or {}
    side = (panel.get("side") or "right").lower()
    if side not in ("left", "right", "center"):
        side = "right"
    screen = theme.get("screen") or {}
    dw = screen.get("designWidth") or 1920
    dh = screen.get("designHeight") or 1080
    width_px = panel.get("width", 500)
    height_px = panel.get("height")

    w_ratio = float(width_px) / dw
    lines = [
        "/* 游戏内暂停菜单停靠方向 / 窗口尺寸：由 theme.json panel.side / panel.width / panel.height 控制。",
        "   请勿手改，改 theme.json 后重新 build。 */",
        ".ingame-menu {",
    ]
    if side == "left":
        lines.append("  left: 0;")
        lines.append("  right: auto;")
    elif side == "right":
        lines.append("  right: 0;")
        lines.append("  left: auto;")
    else:  # center
        lines.append("  left: 50%;")
        lines.append("  right: auto;")

    lines.append(f"  width: calc(var(--design-w) * {w_ratio:.6f});")
    lines.append(f"  min-width: calc(var(--design-w) * {w_ratio:.6f});")

    if height_px:
        h_ratio = float(height_px) / dh
        lines.append("  top: 50%;")
        lines.append("  bottom: auto;")
        lines.append(f"  height: calc(var(--design-h) * {h_ratio:.6f});")
        if side == "center":
            lines.append("  transform: translate(-50%, -50%);")
        else:
            lines.append("  transform: translateY(-50%);")
    else:
        lines.append("  top: 0;")
        lines.append("  bottom: 0;")
        if side == "center":
            lines.append("  transform: translateX(-50%);")
    lines.append("}")
    return "\n".join(lines)


def build_fonts_css(theme):
    """根据 theme.json 的 fonts 配置生成 @font-face 规则（字体加载机制）。

    每个 role 若是对象 {family, src, fallbacks?}：
      - src 为工程根相对路径（如 fonts/SourceHanSansLite.ttf），
        由 cssutil 在「复制/构建」阶段按 CSS 文件深度自动重写为正确相对路径；
      - 生成一条 @font-face 声明，使浏览器真正加载该字体文件。
    相同 (family, src) 去重，避免多个 role 指向同一字体时重复声明。
    若 fonts 里没有任何对象形态配置（全部是系统/Web 字体栈），返回空字符串。"""
    seen = set()
    rules = []
    for k, v in theme.get("fonts", {}).items():
        if not isinstance(v, dict):
            continue
        fam = v.get("family")
        src = v.get("src")
        if not fam or not src:
            continue
        key = (fam, src)
        if key in seen:
            continue
        seen.add(key)
        rules.append(
            "/* %s */\n@font-face {\n"
            "  font-family: \"%s\";\n"
            "  src: url(\"%s\") format(\"truetype\");\n"
            "  font-weight: normal;\n  font-style: normal;\n  font-display: swap;\n}"
            % (k, fam, src)
        )
    if not rules:
        return ""
    header = ("/* aliceADV 构建产物：由 theme.json fonts 配置生成的 @font-face 声明。\n"
              "   字体文件来源于工程 fonts/ 目录，构建时复制到 dist/web/fonts/。\n"
              "   请勿手改，改 theme.json 后重新 build。 */\n")
    return header + "\n\n".join(rules) + "\n"


def collect_scripts(project_dir):
    """收集工程目录 story/ 下所有 JSON（角色档案 characters.json、目录 chapters.json、各章剧本 chX.json）。
    构建产物内联为 window.__SCRIPTS__（键名保留 story/ 前缀），使 file:// 直接打开也能播放剧本。"""
    scripts_dir = os.path.join(project_dir, "story")
    out = {}
    if not os.path.isdir(scripts_dir):
        return out
    for name in sorted(os.listdir(scripts_dir)):
        if name.endswith(".json"):
            path = os.path.join(scripts_dir, name)
            with open(path, "r", encoding="utf-8") as f:
                out["story/" + name] = json.load(f)
    return out


"""构建资源清单（window.__ASSETS__）时判定类型用的扩展名，与 preload.js 的 AUDIO_EXT 一致。"""
AUDIO_EXT_RE = re.compile(r"\.(mp3|wav|ogg|m4a|aac|flac|opus)$", re.I)


def _story_asset_refs(scripts):
    """内联剧本里被引用的资源路径（与 preload.js 的 collectStory 同口径）。

    这是**全量并集**：不按段裁剪，也不区分「这一段新增了什么」。原因见
    docs/预加载.md §8——资源被多个段复用，而玩家可以从任意一段开始
    （读档的 seg/idx 可以是章内任意一句），因此清单必须覆盖所有被引用的资源，
    否则从章中进入时体积未知，只能退化成缺省值。"""
    refs = set()
    chars = (scripts or {}).get("story/characters.json") or {}
    for cid, profile in (chars or {}).items():
        # 角色档案里可能有 "_comment" 这类说明项（模板就有，值是字符串）。
        # 这类条目不是角色，跳过；同时容错非对象值，构建不该因档案形状异常而中断。
        if not isinstance(profile, dict) or str(cid).startswith("_"):
            continue
        for _sp, path in (profile.get("sprites") or {}).items():
            if isinstance(path, str) and path:
                refs.add(path)
        if isinstance(profile.get("textbox"), str) and profile["textbox"]:
            refs.add(profile["textbox"])
    for key, script in (scripts or {}).items():
        if key in ("story/characters.json", "story/chapters.json") or not isinstance(script, dict):
            continue
        segs = dict(script.get("segments") or {})
        for _chname, ch in (script.get("chapters") or {}).items():
            for sn, lst in ((ch or {}).get("segments") or {}).items():
                segs.setdefault(sn, lst)
        for _sn, lst in segs.items():
            if not isinstance(lst, list):
                continue
            for c in lst:
                if not isinstance(c, dict):
                    continue
                cmd = c.get("cmd")
                src = c.get("src")
                if src and cmd in ("bg", "scene", "show", "music", "sound", "voice"):
                    refs.add(src)
                if cmd == "say" and c.get("voice"):
                    refs.add(c["voice"])
    return refs


def _theme_asset_refs(theme):
    """theme.json 里声明的界面图片：外壳图（文本框/边框/按钮/选项/占位图）与各页背景。

    字段清单与 preload.js 的 collectChrome / collectSystem 一致。"""
    refs = set()

    def add(v):
        if isinstance(v, str) and v:
            refs.add(v)

    for name in ("dialog", "frame"):
        add((theme.get(name) or {}).get("background"))
    for name in ("button", "choice"):
        blk = theme.get(name) or {}
        add(blk.get("idle"))
        add(blk.get("hover"))
    add((theme.get("thumb") or {}).get("placeholder"))
    for _pname, page in (theme.get("pages") or {}).items():
        if not isinstance(page, dict):
            continue
        add(page.get("background"))
        for b in (page.get("customButtons") or []):
            if isinstance(b, dict):
                add(b.get("image"))
                add(b.get("hover"))
    return refs


def collect_asset_sizes(web_dir, scripts, theme):
    """资源清单：工程根相对路径 → {"size": 字节数, "type": "image"|"audio"}。

    体积取自**已复制完成的产物目录**（dist/web），因此与玩家实际下载的文件完全一致。
    运行时用这份体积计算「预计下载耗时 → slack」，以及按字节加权的进度百分比；
    清单缺失时 preload.js 按扩展名取缺省体积。"""
    refs = _story_asset_refs(scripts) | _theme_asset_refs(theme)
    out = {}
    for rel in sorted(refs):
        if rel.startswith(("http://", "https://", "data:", "//", "/")):
            continue
        path = os.path.join(web_dir, rel.replace("/", os.sep))
        if not os.path.isfile(path):
            print("  ! 资源清单: 找不到被引用的资源 " + rel)
            continue
        out[rel] = {
            "size": os.path.getsize(path),
            "type": "audio" if AUDIO_EXT_RE.search(rel) else "image",
        }
    return out


def _deep_merge(default, user):
    """deep merge：默认配置模板(default) + 用户配置(user) → 生效配置。

    合并语义（全编译系统统一，其它语言实现只需照此语义）：
      - 对象/Map：递归合并；
      - 数组/List：整体替换，不逐项合并；
      - 基本类型：用户值覆盖默认值；
      - 缺字段：保留默认值；
      - null：视为用户显式提供的值，不因「为空」而恢复默认。
    """
    if isinstance(default, dict) and isinstance(user, dict):
        out = dict(default)
        for k, v in user.items():
            # 用户提供即覆盖；双方都是对象时递归，否则以用户值为准
            out[k] = _deep_merge(out[k], v) if k in out else v
        return out
    # 数组整体替换 / 基本类型覆盖 / null 显式置空：一律以用户值为准
    return user


def _read_json(path):
    """读取 JSON；文件不存在返回 None（由调用方决定回落）。"""
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _read_text(path):
    """读取 UTF-8 文本；文件不存在返回 None（由调用方区分「没这个文件」和「空文件」）。"""
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def resolve_config(project_dir):
    """计算「生效配置」：引擎默认模板 deep merge 工程配置。

    仅用于配置文件 theme.json / info.json——脚本 / 角色 / 章节等不属于配置，
    由 build 原样复制到发行版，不在此扫描或处理。

    默认模板 = 引擎 template/ 下的 theme.json / info.json，它同时也是
    `aliceadv create` 复制进新工程的模板，因此是「默认值 + 工程模板」的单一来源，
    不存在第二份「推荐字段」清单。

    关于页正文**不属于配置**：它来自工程根 about.txt（见 resolve_about），
    不从 theme.json 读。若旧工程仍在 theme.json 里写着 about，这里会把它取出来
    当兼容值并在构建时提示迁移（见 resolve_about）。

    返回 (theme, info, about)：均为合并后的完整配置，不再区分用户值 / 默认值；
    运行时只读这份结果。info 另并入 theme.info（运行时读 theme.info）。
    """
    tpl = template_path()

    theme = _deep_merge(
        _read_json(os.path.join(tpl, "theme.json")) or {},
        _read_json(os.path.join(project_dir, "theme.json")) or {},
    )
    info = _deep_merge(
        _read_json(os.path.join(tpl, "info.json")) or {},
        _read_json(os.path.join(project_dir, "info.json")) or {},
    )
    # info.json 仍是 theme.info 的来源：把完整 info 并入 theme.info
    theme["info"] = _deep_merge(theme.get("info", {}) or {}, info)
    # 关于页正文不是配置：从生效配置里摘掉，改由 resolve_about 从 about.txt 取，
    # 使其不出现在 window.__THEME__ / 产物的 theme.json 里。
    legacy_about = theme.pop("about", None)
    about = resolve_about(project_dir, legacy_about)
    return theme, info, about


def resolve_about(project_dir, legacy_about=None):
    """关于页正文的来源解析：工程根 `about.txt`。

    正文（游戏简介 / 制作人员 / 版权声明这类长篇文本）是**内容**，不是样式，
    因此不写在 theme.json 里，而是和剧本、素材一样放工程根、一个文件放一类东西。
    这里读到的文本由 build 内联为 `window.__ABOUT__`（构建产物 file:// 直接可读）；
    模板模式（未构建、直接开模板目录）由 theme.js 运行时 fetch 同一个文件。

    兼容：旧工程的 theme.json 若还写着 `about`，且工程根没有（或为空）about.txt，
    则沿用该值并打印迁移提示——已迁移的工程不受影响，未迁移的工程也不会突然
    变成空白页。about.txt 有内容时永远优先。
    """
    about = _read_text(os.path.join(project_dir, ABOUT_FILE))
    if about and about.strip():
        return about
    if isinstance(legacy_about, str) and legacy_about.strip():
        print("  ! theme.json 的 about 已废弃：关于页正文请改写到工程根 " + ABOUT_FILE +
              "（本次仍沿用 theme.json 里的值）")
        return legacy_about
    return ""


def build_project(project_dir):
    start_time = time.time()
    project_dir = os.path.abspath(project_dir)
    if not os.path.isdir(project_dir):
        print("✗ 工程目录不存在: " + project_dir)
        return False

    # 禁止对引擎模板目录直接 build（含标记文件的目录即模板本身）
    if os.path.exists(os.path.join(project_dir, ENGINE_MARKER)):
        print("✗ 禁止对引擎模板目录直接执行 build。")
        print("  模板是引擎的一部分，请传入你自己的「工程目录」，例如：")
        print("    aliceadv build ../my_game")
        return False

    # 1. 生效配置 = 引擎默认模板 deep merge 工程配置（theme.json / info.json）
    #    （剧本 / 角色 / 章节不属于配置，后面由 build 原样复制，不在此合并）
    theme_path = os.path.join(project_dir, "theme.json")
    if not os.path.isfile(theme_path):
        print("✗ 工程目录缺少 theme.json: " + theme_path)
        return False
    try:
        theme, info, about = resolve_config(project_dir)
    except Exception as e:
        print("✗ 读取/合并配置失败:", e)
        return False

    # 3. 生成构建 CSS 变量 + 浮层面板停靠方向
    css = build_css_vars(theme)
    css += "\n\n" + build_panel_css(theme)

    # 4. 收集剧本（章节 + 角色档案）
    scripts = collect_scripts(project_dir)

    # 5. 组装 <工程>/dist/web/ = 引擎运行时(取自模板) + 工程内容(取自工程目录)
    #    工程根目录只保存内容（theme.json / story / gui / images / audio ...），
    #    网页外壳 index.html 与引擎 style/ 一律从模板装配，不落进工程目录。
    web = os.path.join(project_dir, "dist", "web")
    # 仅清理旧构建产物；以 '.' 开头的文件/目录（.git / .workbuddy 等）一律保留，绝不删除。
    os.makedirs(web, exist_ok=True)
    _safe_clear_directory(web)

    # 5a. 引擎运行时：模板/index.html + 模板/style/ → dist/web/
    tpl = template_path()
    for item in ENGINE_RUNTIME:
        src = os.path.join(tpl, item)
        dst = os.path.join(web, item)
        if not os.path.exists(src):
            continue
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)

    # 5b. 工程内容 → dist/web/（忽略 dist 自身；兼容旧工程里残留的 index.html / style/）
    legacy = [os.path.join(project_dir, i) for i in ENGINE_RUNTIME]
    has_legacy = [os.path.relpath(p, project_dir) for p in legacy if os.path.exists(p)]
    if has_legacy:
        print("  提示: 工程根目录残留引擎文件（已忽略，产物改用模板版本）: "
              + ", ".join(has_legacy))
    shutil.copytree(project_dir, web,
                    ignore=shutil.ignore_patterns(*IGNORE_PATTERNS, *ENGINE_RUNTIME),
                    dirs_exist_ok=True)

    # 5b-2. 把「生效配置」写入发行版：运行时只读产物里的最终配置，
    #       不需要知道工程配置与引擎默认配置的关系（覆盖从工程复制来的原始文件）。
    for _name, _data in (("theme.json", theme), ("info.json", info)):
        with open(os.path.join(web, _name), "w", encoding="utf-8") as _f:
            json.dump(_data, _f, ensure_ascii=False, indent=2)

    # 5b-3. 资源清单：被引用资源的体积与类型。运行时据此计算「预计下载耗时 → slack」
    #       与按字节加权的进度；取自产物目录，因此与实际发行的文件一致。
    #       步骤 7c 内联为 window.__ASSETS__（与 __SCRIPTS__ 同理，file:// 下也能读）。
    assets = collect_asset_sizes(web, scripts, theme)
    assets_bytes = sum(v["size"] for v in assets.values())

    # 5b. 字体 @font-face（字体加载机制）：把 theme.json 中声明了 src 的字体
    #     生成为 style/fonts.built.css；随后紧跟的「CSS 资源路径重写」会把它
    #     内部的 url(fonts/...) 按文件深度统一重写为 ../fonts/...，与模板约定一致。
    fonts_css = build_fonts_css(theme)
    if fonts_css:
        with open(os.path.join(web, "style", "fonts.built.css"), "w", encoding="utf-8") as f:
            f.write(fonts_css)

    # 5c. 编译期重写 CSS 资源路径：url() 相对 CSS 文件自身解析，
    #     模板统一写工程根相对路径（gui/...），此处按文件深度自动补 ../ 前缀。
    rewritten = rewrite_css_asset_paths(web)
    if rewritten:
        print("  CSS 资源路径: 已按深度重写 %d 个文件 (%s)"
              % (len(rewritten), ", ".join(os.path.basename(p) for p in rewritten)))

    # 6. 写入构建产物 style/theme.built.css
    built_css_path = os.path.join(web, "style", "theme.built.css")
    with open(built_css_path, "w", encoding="utf-8") as f:
        f.write("/* aliceADV 构建产物：由 theme.json 翻译生成的 CSS 变量。请勿手改，改 theme.json 后重新 build。 */\n")
        f.write(css + "\n")

    # 7. 注入到 dist/web/index.html
    html_path = os.path.join(web, "index.html")
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()

    # 7a. 引入字体 @font-face（fonts.built.css 已在 step 5b 生成，此处只引入）
    if fonts_css:
        # 置于 base.css 之后，确保字体规则尽早注册（在页面样式引用前生效）
        html = re.sub(
            r'<link[^>]*href="style/base\.css"[^>]*>',
            '<link rel="stylesheet" href="style/base.css">\n'
            '    <link rel="stylesheet" href="style/fonts.built.css">',
            html, count=1
        )

    # 7b. 引入构建 css（置于所有页面样式之后，确保用户的 theme.json 配置覆盖模板默认值）
    html = re.sub(
        r'<link[^>]*href="style/pages/popup\.css"[^>]*>',
        '<link rel="stylesheet" href="style/pages/popup.css">\n'
        '    <link rel="stylesheet" href="style/theme.built.css">',
        html, count=1
    )

    # 7b. 把主题、关于页正文与剧本内联（在 theme.js 之前），使 file:// 直接可用
    theme_inline = json.dumps(theme, ensure_ascii=False)
    scripts_inline = json.dumps(scripts, ensure_ascii=False)
    # 关于页正文来自工程根 about.txt（不是 theme.json 的字段）。
    # 把 「</」 转义成 「<\/」：正文是作者自由撰写的长文本，万一出现 </script> 会提前
    # 结束脚本块；JS 里 "\/" 与 "/" 等价，读出来的字符串不受影响。
    about_inline = json.dumps(about, ensure_ascii=False).replace("</", "<\\/")
    # 7c. 资源清单一并内联：运行时预加载调度需要知道每个资源的体积。
    #     路径用紧凑分隔符输出，几百项也只是一个几 KB 的脚本。
    assets_inline = json.dumps(assets, ensure_ascii=False, separators=(",", ":"))
    # 打包引擎版本：来自 aliceadv 包（ENGINE_NAME/ENGINE_VERSION），
    # 而非工程 info.json，使构建产物在关于页/标题页展示「引擎版本」。
    # repo 一并内联：关于页把引擎名做成指向仓库的链接，URL 的唯一来源是 __init__.py 的 ENGINE_REPO。
    engine_inline = json.dumps(
        {"name": ENGINE_NAME, "version": ENGINE_VERSION, "repo": ENGINE_REPO},
        ensure_ascii=False)
    html = html.replace(
        '<script src="style/theme.js"></script>',
        f'<script>window.__ENGINE__ = {engine_inline};</script>\n'
        f'    <script>window.__THEME__ = {theme_inline};</script>\n'
        f'    <script>window.__ABOUT__ = {about_inline};</script>\n'
        f'    <script>window.__SCRIPTS__ = {scripts_inline};</script>\n'
        f'    <script>window.__ASSETS__ = {assets_inline};</script>\n'
        '    <script src="style/theme.js"></script>',
        1
    )

    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

    end_time = time.time()

    print(f"✓ aliceADV build 完成   用时{end_time-start_time}秒")
    print(f"  工程: {project_dir}")
    print(f"  主题: {theme.get('info', {}).get('name', '(未命名)')} "
          f"v{theme.get('info', {}).get('version', '?')}")
    print(f"  引擎: {ENGINE_NAME} {ENGINE_VERSION}")
    print("  关于页: " + (f"{ABOUT_FILE} {len(about)} 字符"
                          if about else
                          f"无 {ABOUT_FILE}（关于页只显示游戏名与版本行）"))
    print(f"  剧本: {len(scripts)} 个文件已内联 ({', '.join(scripts.keys()) if scripts else '无'})")
    print(f"  资源清单: {len(assets)} 项 / {assets_bytes / 1048576:.1f} MB 被引用")
    print(f"  产物: {os.path.relpath(html_path, project_dir)}")
    print("  预览: 直接打开该 index.html，或在工程目录运行 python3 -m http.server 后访问 dist/web/")
    return True
