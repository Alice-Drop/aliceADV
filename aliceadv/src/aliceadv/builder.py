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

from . import ENGINE_MARKER, ENGINE_RUNTIME, ENGINE_VERSION, ENGINE_NAME, template_path
from .cssutil import rewrite_css_asset_paths

# 复制工程到 dist/web 时忽略的项（避免递归 / 引擎内部文件）
IGNORE_PATTERNS = ("dist", ".git", ENGINE_MARKER, "__pycache__", "*.pyc")


def rel(v, fallback):
    """数字(0~1) → 百分比字符串；字符串 → 原样透传；None → fallback。"""
    if v is None:
        return fallback
    if isinstance(v, (int, float)):
        return f"{v * 100:.4g}%"
    return str(v)


def camel2(s):
    out = []
    for i, part in enumerate(s.replace("-", "_").split("_")):
        out.append(part if i == 0 else part[:1].upper() + part[1:])
    return "".join(out)


def build_css_vars(theme):
    lines = [":root {"]

    # 字号：基于设计宽度 1920 的比例（输出为 px，由 #stage transform 整体缩放）
    sizes = theme.get("sizes", {})
    for k, v in sizes.items():
        lines.append(f"  --size-{k}: calc(var(--design-w) * {v} / 1920);")

    # 颜色（跳过 _comment 等内部说明键）
    for k, v in theme.get("colors", {}).items():
        if k.startswith("_"):
            continue
        lines.append(f"  --color-{camel2(k)}: {v};")

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
    if sc.get("aspect"):
        lines.append(f"  --aspect: {sc['aspect'].replace(':', ' / ')};")
    if sc.get("designWidth"):
        lines.append(f"  --design-w: {sc['designWidth']}px;")
        lines.append(f"  --design-w-px: {sc['designWidth']}px;")
    if sc.get("designHeight"):
        lines.append(f"  --design-h: {sc['designHeight']}px;")
        lines.append(f"  --design-h-px: {sc['designHeight']}px;")
    if sc.get("overflowColor"):
        lines.append(f"  --overflow-color: {sc['overflowColor']};")

    # 存档槽
    slot = theme.get("slot")
    if slot:
        lines.append(f"  --slot-cols: {slot.get('cols', 3)};")
        lines.append(f"  --slot-aspect: {slot.get('width', 414)} / {slot.get('height', 309)};")

    if theme.get("notifyYpos") is not None:
        lines.append(f"  --notify-ypos: {theme['notifyYpos']};")
    if theme.get("skipYpos") is not None:
        lines.append(f"  --skip-ypos: {theme['skipYpos']};")

    # 布局自由度（相对值 → 百分比 / em）
    L = theme.get("layout", {})
    d = L.get("dialogue", {})
    lines.append(f"  --dialogue-left: {rel(d.get('left'), '5%')};")
    lines.append(f"  --dialogue-bottom: {rel(d.get('bottom'), '5%')};")
    lines.append(f"  --dialogue-width: {rel(d.get('width'), '90%')};")
    lines.append(f"  --dialogue-height: {rel(d.get('height'), '28%')};")
    _padx = d.get('padX', '3.4em')
    lines.append(f"  --dialogue-pad-x: {_padx};")
    lines.append(f"  --dialogue-pad-left: {d.get('padLeft', _padx)};")
    lines.append(f"  --dialogue-pad-right: {d.get('padRight', _padx)};")
    lines.append(f"  --dialogue-pad-top: {d.get('padTop', d.get('padY', '2.4em'))};")
    lines.append(f"  --dialogue-pad-bottom: {d.get('padBottom', d.get('padY', '2.4em'))};")
    lines.append(f"  --dialogue-justify: {d.get('justify', 'center')};")
    lines.append(f"  --dialogue-text-align: {d.get('textAlign', 'left')};")
    n = L.get("name", {})
    lines.append(f"  --name-left: {rel(n.get('left'), '3%')};")
    lines.append(f"  --name-top: {rel(n.get('top'), '-7%')};")
    s = L.get("sprite", {})
    lines.append(f"  --sprite-bottom: {rel(s.get('bottom'), '0%')};")
    lines.append(f"  --sprite-height: {rel(s.get('height'), 'auto')};")
    v = L.get("nvl", {})
    lines.append(f"  --nvl-left: {rel(v.get('left'), '18.75%')};")
    lines.append(f"  --nvl-width: {rel(v.get('width'), '62.5%')};")
    lines.append(f"  --nvl-line-gap: {v.get('lineGap', '0.5em')};")
    lines.append(f"  --nvl-justify: {v.get('justify', 'center')};")
    lines.append(f"  --nvl-text-align: {v.get('textAlign', 'left')};")
    c = L.get("choice", {})
    lines.append(f"  --choice-left: {rel(c.get('left'), '10%')};")
    lines.append(f"  --choice-top: {rel(c.get('top'), '26%')};")
    lines.append(f"  --choice-width: {rel(c.get('width'), '80%')};")
    lines.append(f"  --choice-gap: {c.get('gap', '1.2em')};")
    lines.append(f"  --choice-max-width: {c.get('maxWidth', '60%')};")
    t = L.get("toolbar", {})
    lines.append(f"  --toolbar-height: {t.get('height', '6.5em')};")
    lines.append(f"  --toolbar-gap: {t.get('gap', '2em')};")

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


def build_project(project_dir):
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

    # 1. 读取用户配置 theme.json
    theme_path = os.path.join(project_dir, "theme.json")
    if not os.path.isfile(theme_path):
        print("✗ 工程目录缺少 theme.json: " + theme_path)
        return False
    with open(theme_path, "r", encoding="utf-8") as f:
        theme = json.load(f)

    # 2. 合并 info.json（游戏名 / 版本等）覆盖 theme.info
    info_path = os.path.join(project_dir, "info.json")
    if os.path.isfile(info_path):
        try:
            info = json.load(open(info_path, "r", encoding="utf-8"))
            base = theme.get("info", {}) or {}
            for k, v in info.items():
                if v is not None:
                    base[k] = v
            theme["info"] = base
        except Exception as e:
            print("! 读取 info.json 失败，已跳过:", e)

    # 3. 生成构建 CSS 变量 + 浮层面板停靠方向
    css = build_css_vars(theme)
    css += "\n\n" + build_panel_css(theme)

    # 4. 收集剧本（章节 + 角色档案）
    scripts = collect_scripts(project_dir)

    # 5. 组装 <工程>/dist/web/ = 引擎运行时(取自模板) + 工程内容(取自工程目录)
    #    工程根目录只保存内容（theme.json / story / gui / images / audio ...），
    #    网页外壳 index.html 与引擎 style/ 一律从模板装配，不落进工程目录。
    web = os.path.join(project_dir, "dist", "web")
    if os.path.isdir(web):
        shutil.rmtree(web)
    os.makedirs(web)

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

    # 7b. 把主题与剧本内联（在 theme.js 之前），使 file:// 直接可用
    theme_inline = json.dumps(theme, ensure_ascii=False)
    scripts_inline = json.dumps(scripts, ensure_ascii=False)
    # 打包引擎版本：来自 aliceadv 包（ENGINE_NAME/ENGINE_VERSION），
    # 而非工程 info.json，使构建产物在关于页/标题页展示「引擎版本」。
    engine_inline = json.dumps(
        {"name": ENGINE_NAME, "version": ENGINE_VERSION}, ensure_ascii=False)
    html = html.replace(
        '<script src="style/theme.js"></script>',
        f'<script>window.__ENGINE__ = {engine_inline};</script>\n'
        f'    <script>window.__THEME__ = {theme_inline};</script>\n'
        f'    <script>window.__SCRIPTS__ = {scripts_inline};</script>\n'
        '    <script src="style/theme.js"></script>',
        1
    )

    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

    print("✓ aliceADV build 完成")
    print(f"  工程: {project_dir}")
    print(f"  主题: {theme.get('info', {}).get('name', '(未命名)')} "
          f"v{theme.get('info', {}).get('version', '?')}")
    print(f"  引擎: {ENGINE_NAME} {ENGINE_VERSION}")
    print(f"  剧本: {len(scripts)} 个文件已内联 ({', '.join(scripts.keys()) if scripts else '无'})")
    print(f"  产物: {os.path.relpath(html_path, project_dir)}")
    print("  预览: 直接打开该 index.html，或在工程目录运行 python3 -m http.server 后访问 dist/web/")
    return True
