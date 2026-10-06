#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""回归测试：主题变量链路（theme.json → CSS 变量 → CSS 消费）的单向自洽。

根因（2026-09-26 审计发现的一类反复性 bug）：
  同一批 CSS 变量有**两个写入者**——构建期的 builder.build_css_vars()
  （产出 dist/web/style/theme.built.css）与运行期的 theme.js applyThemeVars()
  （写 documentElement 的内联样式）。两者一旦不一致，症状都是「改了 theme.json 没反应」：

  1) 命名错位：两个写入者都按驼峰拼变量名（--color-accentDeep / --size-pageHeading），
     而 CSS 侧的约定是 kebab（--color-accent-deep / --size-page-heading）。
     于是 theme.json 里的驼峰键（accentDeep / idleSmall / pageHeading / sectionHeading）
     全部静默失效，页面吃到的是 base.css :root 里的兜底字面值。
  2) 调色板键无人消费：colors.selected / interface / muted / hoverMuted 写在模板 theme.json 里、
     也写了变量，但没有任何 CSS 规则读它们 —— 作者改了等于没改。
  3) 默认值多副本：布局项在 builder.py、theme.js、CSS var(--x, 默认) 三处各存一份字面兜底。
  4) 设计分辨率写死在渲染流程里：engine.js 用 const DESIGN_W = 1920 做缩放基准，
     而 screen.designWidth 是文档化可配项。
  5) 菜单页共享外观的第二份真值源：整页衬底/主内容底板的默认值若同时出现在
     模板 theme.json 与 theme.js/CSS，工程改了就未必生效（显式 null 还会被兜回来）。
  6) 游戏内容混进配置：关于页正文（长篇文本）曾写在 theme.json 的 about 里，
     与「theme.json 只描述外观与界面」的定位冲突；正文搬到工程根 about.txt 后，
     若两个入口（构建期内联 / 模板模式 fetch）有一处漏读、或空文件把正文清空，
     症状都是「关于页的文本不见了」。

本测试把上述六条固化成断言，防止复发。

运行：
  python tests/test_theme_vars.py
  （也可被 pytest 收集，函数名以 test_ 开头）
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)                       # .../aliceadv
SRC = os.path.join(PKG, "src")                    # .../aliceadv/src
sys.path.insert(0, SRC)

import aliceadv.builder as _builder               # 本地包（SRC 已在 sys.path 最前）
from aliceadv import ENGINE_MARKER  # noqa: F401  （与其它测试保持同样的导入约定）

TEMPLATE = os.path.join(SRC, "aliceadv", "template")
STYLE = os.path.join(TEMPLATE, "style")
THEME_JSON = os.path.join(TEMPLATE, "theme.json")
THEME_JS = os.path.join(STYLE, "theme.js")
ENGINE_JS = os.path.join(STYLE, "engine.js")
BUILDER_PY = os.path.join(SRC, "aliceadv", "builder.py")

_failures = []


def check(cond, msg):
    if cond:
        print("  ✓ " + msg)
    else:
        print("  ✗ " + msg)
        _failures.append(msg)


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def strip_comments(src):
    """剥掉 JS 的行注释与块注释。

    断言「这段代码里有没有 / 在不在某句之后出现 X」时**必须先剥注释**：说明性注释为了讲清一条
    规则，往往会**原样引用**被禁掉或要求的那段代码，于是 `in` / `find()` 命中注释里的影子字面量，
    把「按规矩写对了」判成失败（2026-09-27 在 [9]、[11] 各踩了一次）。
    """
    src = re.sub(r"/\*[\s\S]*?\*/", "", src)
    return re.sub(r"//[^\n]*", "", src)


def strip_css_comments(src):
    """剥掉 CSS 的块注释。**不要**用 strip_comments：它连 `//` 一起剥，
    而 CSS 里 `url(//host/x)` 这类协议相对地址会被拦腰截断（2026-09-27 为关于页链接断言新增）。
    """
    return re.sub(r"/\*[\s\S]*?\*/", "", src)


def css_rule(src, selector):
    """取 CSS 里**选择器恰好等于** selector 的那条规则的规则体（已剥注释）。找不到返回 ""。

    不能直接搜 `selector + "{"`：比如 `.game-menu__sidebar` 会先命中文件更早处的
    `.game-menu--sidebar-left  .game-menu__sidebar { grid-column: 1; }` 那条。
    这里按「`{` 前的整段文本」逐条比对，并把连续空白归一化，所以多行选择器
    （`.game-menu,\n.game-menu__divider {`）也能命中。
    """
    want = " ".join(selector.split())
    body = strip_css_comments(src)
    for m in re.finditer(r"([^{}]+)\{([^}]*)\}", body):
        if " ".join(m.group(1).split()) == want:
            return m.group(2)
    return ""


def css_files():
    for root, _dirs, names in os.walk(STYLE):
        for n in names:
            if n.endswith(".css"):
                yield os.path.join(root, n)


def css_consumed(prefix):
    """模板 CSS 里 var(--prefix-*) 实际读取到的变量名集合。"""
    out = set()
    for p in css_files():
        out |= set(re.findall(r"var\((--%s-[A-Za-z0-9_-]+)" % prefix, read(p)))
    return out


def built_vars(theme):
    """把 builder 对给定 theme 生成的 :root 块解析成 {变量名: 值}。

    直接调用真实函数（而不是正则扫源码），才验得住「构建期实际写出来的名字」。"""
    css = _builder.build_css_vars(theme)
    return dict(re.findall(r"^\s*(--[A-Za-z0-9_-]+)\s*:\s*(.+?);\s*$", css, re.M))


def camel_keys(d):
    """键名里含大写字母的（会被 kebab 化，最容易踩命名错位）。"""
    return [k for k in d if any(c.isupper() for c in k)]


# ---------------------------------------------------------------------------
def test_builder_never_emits_camelcase_vars():
    """命名错位：构建期写出的变量名必须一律 kebab（不允许出现大写字母）。"""
    print("[1] builder.build_css_vars 产出的变量名一律 kebab-case")
    theme = json.loads(read(THEME_JSON))
    vars_ = built_vars(theme)

    bad = sorted(v for v in vars_ if re.search(r"[A-Z]", v))
    check(not bad, "无驼峰变量名（违例: %s）" % ", ".join(bad))

    # 驼峰键必须被正确 kebab 化（这四个正是历史上失效的那批）
    check("--color-accent-deep" in vars_, "colors.accentDeep → --color-accent-deep")
    check("--color-idle-small" in vars_, "colors.idleSmall → --color-idle-small")
    check("--color-hover-muted" in vars_, "colors.hoverMuted → --color-hover-muted")
    check("--size-page-heading" in vars_, "sizes.pageHeading → --size-page-heading")
    check("--size-section-heading" in vars_,
          "sizes.sectionHeading → --size-section-heading")

    # 说明键（_comment）不得变成变量
    check(not [v for v in vars_ if "comment" in v.lower()],
          "下划线开头的说明键不被写成变量")


def test_no_inert_palette_key():
    """无人消费的键：模板 theme.json 的 colors / sizes / fonts 每个键都必须有 CSS 读者。

    否则「作者改了 theme.json 却没有任何视觉变化」——配置在说谎。"""
    print("[2] colors / sizes / fonts 的每个键都有 CSS 消费者（无死键）")
    theme = json.loads(read(THEME_JSON))

    for group, prefix in (("colors", "--color"), ("sizes", "--size"), ("fonts", "--font")):
        consumed = css_consumed(prefix[2:])
        scheme = theme.get(group, {})
        for k in scheme:
            if k.startswith("_"):
                continue
            name = "--%s-%s" % (prefix[2:], _builder.css_name(k))
            check(name in consumed,
                  "theme.json %s.%s 对应的 %s 有 CSS 消费者" % (group, k, name))


def test_css_readers_are_all_written():
    """缺写：CSS 读的每个 --color-*/--size-*/--font-* 都必须由构建期写出。

    （运行期 theme.js 的同名写入由 tests/test_dialogue_layout.py 覆盖 --dialogue-*；
     这里保证调色板/字号这两组不会漏。）"""
    print("[3] CSS 读取的 --color-* / --size-* / --font-* 都被构建期写出")
    theme = json.loads(read(THEME_JSON))
    vars_ = built_vars(theme)

    for prefix in ("color", "size", "font"):
        consumed = css_consumed(prefix)
        missing = sorted(consumed - set(vars_))
        check(not missing,
              "--%s-* 无缺口（缺: %s）" % (prefix, ", ".join(missing)))


def test_no_literal_defaults_in_pipeline():
    """默认值多副本：渲染/构建流程里不得再写**主题级布局项**的兜底字面量。

    默认值的唯一来源是模板 theme.json，最后一道兜底写在 CSS 的 var(--x, 默认)。

    范围限定在 layout.*（--dialogue/--name/--sprite/--nvl/--choice/--toolbar）：
    这是历史上真出过「builder 有一份 '5%'、theme.js 又有一份 '5%'、CSS 还有第三份」的地方。
    逐项兜底（如 pages.title.customButtons[i].left 缺省按 0 定位）不算主题默认值，
    它属于「配置项内部的可选字段」，不在本断言范围内。
    """
    print("[4] 流程代码里不写主题级布局兜底字面量（与 CSS 的最后兜底重复）")
    layout = r"--(?:dialogue|name|sprite|nvl|choice|toolbar)[\w-]*"

    js = read(THEME_JS)
    bad = [m.group(0) for m in
           re.finditer(r'setVar\(\s*"%s"\s*,\s*rel\(([^()]*)\)' % layout, js)
           if m.group(1).count(",") >= 1]
    check(not bad, "theme.js 的布局变量不再给 rel() 传兜底值（违例: %s）" % "; ".join(bad))

    py = read(BUILDER_PY)
    bad = [m.group(0) for m in
           re.finditer(r'add\(\s*"%s"\s*,\s*rel\(([^()]*)\)' % layout, py)
           if m.group(1).count(",") >= 1]
    check(not bad, "builder.py 的布局变量不再给 rel() 传兜底值（违例: %s）" % "; ".join(bad))

    # 布局变量也不得带引号字面默认值
    literals = re.findall(
        r'setVar\(\s*"%s"\s*,\s*["\'][^"\']+["\']' % layout, js)
    check(not literals,
          "theme.js 的布局变量不再带引号字面默认值（违例: %s）" % "; ".join(literals))


def test_design_resolution_not_hardcoded():
    """设计分辨率写死：engine.js 的缩放基准必须来自 #stage 的布局尺寸，
    否则 screen.designWidth 一改，画面就整体放大并被裁掉。"""
    print("[5] engine.js 的舞台缩放基准来自 theme.json（不写死 1920×1080）")
    js = read(ENGINE_JS)
    check("DESIGN_W" not in js and "DESIGN_H" not in js,
          "engine.js 不再定义 DESIGN_W / DESIGN_H 常量")
    check("stage.offsetWidth" in js and "stage.offsetHeight" in js,
          "fitStage() 用 #stage 的 offsetWidth / offsetHeight 作缩放基准")


def test_builder_js_naming_agree():
    """两个写入者的命名规则必须一致：builder.css_name 与 theme.js cssName
    对同一批键产出同一个名字。"""
    print("[6] builder.css_name 与 theme.js cssName 命名规则一致")
    js = read(THEME_JS)
    m = re.search(r"function cssName\(s\)\s*\{\s*return ([^;]+);", js)
    check(m is not None, "theme.js 存在 cssName() 且实现可静态提取")
    if m:
        check('replace(/_/g, "-")' in m.group(1) and "([a-z0-9])([A-Z])" in m.group(1),
              "theme.js cssName() 仍是「下划线→连字符 + 小写后接大写处插连字符」")
    # 真实产出一致性：对模板里所有驼峰键比对两侧结果
    theme = json.loads(read(THEME_JSON))
    keys = camel_keys(theme.get("colors", {})) + camel_keys(theme.get("sizes", {}))
    check(bool(keys), "模板 theme.json 里存在驼峰键可校验（%s）" % ", ".join(keys))
    for k in keys:
        py = _builder.css_name(k)
        js_expected = re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", k.replace("_", "-")).lower()
        check(py == js_expected,
              "css_name(%s) = %s（JS 侧同名）" % (k, py))


def test_sidebar_has_no_history():
    """菜单页侧边栏不该出现「历史」（2026-09-26 用户要求）：
    历史是播放内的功能，入口在舞台底部工具栏；把它挂在菜单页侧边栏上属于放错位置。
    注意 NAV.history 要保留（工具栏仍用），只是不出现在 sidebar 列表里。"""
    print("[7] 菜单页侧边栏不含「历史」")
    theme = json.loads(read(THEME_JSON))
    sidebar = theme.get("sidebar") or []
    check("history" not in sidebar,
          "模板 theme.json 的 sidebar 不含 history（%s）" % "/".join(sidebar))
    js = read(THEME_JS)
    # 侧边栏默认数组含 "branches"（暂停浮层的 panel.buttons 不含），用它把两者区分开
    m = re.search(r'\[\s*"save"\s*,\s*"load"[^\]]*"branches"[^\]]*\]', js)
    check(m is not None, "theme.js 里能定位到侧边栏默认数组")
    if m:
        check('"history"' not in m.group(0),
              "theme.js 侧边栏默认数组不含 history（%s）" % m.group(0).strip())
    check('action: "history"' in js, "NAV.history 仍保留（舞台底部工具栏可用）")


def test_gamemenu_defaults_single_source():
    """菜单页衬底的默认值只写在模板 theme.json 的 gameMenu ——
    流程代码（theme.js / builder.py）不得再存一份字面兜底。

    白色菜单底有两个**各管一块**的键（2026-09-27 定稿）：
      * `panelColor` 只服务主内容 `.game-menu__main` 那一整块面板（略微透明，底图淡淡透出）；
      * `sidebarButtonColor` 服务**每个侧栏按钮各自**的底色（默认 `#FFFFFF` 完全不透明）——
        侧栏本身不再铺整块面板（那会让几个导航按钮和底部「返回」连成一片），
        而按钮只靠描边在饱和底图上又读不清，所以按钮单独铺纯白。
    按钮范围另由一条非黑描边（colors.muted）勾出。
    """
    print("[8] 菜单页衬底默认值单一来源（模板 theme.json 的 gameMenu）+ 侧栏/按钮各自的底")
    theme = json.loads(read(THEME_JSON))
    gm = theme.get("gameMenu") or {}
    tint, panel = gm.get("backgroundColor"), gm.get("panelColor")
    side_btn = gm.get("sidebarButtonColor")
    check(bool(tint), "模板 gameMenu.backgroundColor = %s" % tint)
    check(bool(panel), "模板 gameMenu.panelColor = %s" % panel)
    check(side_btn == "#FFFFFF",
          "模板 gameMenu.sidebarButtonColor = %s（纯白、完全不透明；不用 rgba 半透明）" % side_btn)
    for path, label in ((THEME_JS, "theme.js"), (BUILDER_PY, "builder.py")):
        txt = read(path)
        check(panel not in txt, "%s 不含 panelColor 字面量 %s" % (label, panel))
        check(tint not in txt, "%s 不含 backgroundColor 字面量 %s" % (label, tint))
        check(side_btn not in txt, "%s 不含 sidebarButtonColor 字面量 %s" % (label, side_btn))
    css = read(os.path.join(STYLE, "pages", "game-menu.css"))
    check("var(--game-menu-panel" in css, "game-menu.css 通过 var(--game-menu-panel) 读白色菜单底")
    js = read(THEME_JS)
    check("--game-menu-panel" in js, "theme.js 写入 --game-menu-panel")
    check("--game-menu-sidebar-btn" in js, "theme.js 写入 --game-menu-sidebar-btn")
    check("gameMenu" in js, "theme.js 读取 theme.gameMenu 作为共享默认")

    # ---- 白色菜单底的两个落点 ----
    main_rule = css_rule(css, ".game-menu__main")
    check("var(--game-menu-panel" in main_rule, "主内容面板用 --game-menu-panel")

    # 侧栏自身**不能**有背景：整块面板会让 4 个导航按钮与底部「返回」连成一片
    side_rule = css_rule(css, ".game-menu__sidebar")
    check(side_rule != "", "能定位到 .game-menu__sidebar 规则（不是只匹配到 --sidebar-left 那条）")
    check("background" not in side_rule, "侧栏本身没有背景（整块衬底已移除）")
    check("box-shadow" not in side_rule, "侧栏没有投影（没有底色时的投影只是脏）")
    check("gap:" in side_rule, "侧栏按钮之间留缝（flex gap）")

    btn_rule = css_rule(css, ".game-menu__sidebar .paper-btn")
    check("background-color: var(--game-menu-sidebar-btn" in btn_rule,
          "侧栏按钮底色来自 --game-menu-sidebar-btn（每个按钮各自的底）")
    check("var(--game-menu-sidebar-btn, #fff)" in btn_rule,
          "CSS 侧最后兜底是纯白 `#fff`（引擎默认值仍只写在模板 theme.json）")
    check("var(--game-menu-panel" not in btn_rule,
          "侧栏按钮不读 --game-menu-panel（panelColor 只服务主内容面板）")
    check("background-color: transparent" not in btn_rule,
          "侧栏按钮不再是无底色的 transparent（2026-09-27 用户明确要求 100% 不透明的白）")
    check("border:" in btn_rule and "var(--color-muted)" in btn_rule,
          "侧栏按钮用 colors.muted 做描边（非纯黑；模板 #6080D0 / 本工程 #666666）")
    check("padding" in btn_rule, "侧栏按钮自带内边距")
    check("height: auto" in btn_rule,
          "高度交给 padding 决定（box-sizing:border-box 下固定 height 加不上纵向内边距）")
    # 在 .paper-btn 之后写 `color` 会连带盖掉 :hover 与 .is-current（同处 (0,2,0) 档、后写者胜）——
    # 所以必须同时存在两条 (0,3,0) 的补回规则，否则悬停/当前页高亮会静默失效。
    check("color:" in btn_rule, "侧栏按钮设了标签色（因此下面两条补回规则是必需的）")
    check("var(--color-hover)" in css_rule(css, ".game-menu__sidebar .paper-btn:hover"),
          "补回 .game-menu__sidebar .paper-btn:hover（否则 hover 变色被 (0,2,0) 同档后写规则盖掉）")
    check("var(--color-accent)" in css_rule(css, ".game-menu__sidebar .paper-btn.is-current"),
          "补回 .game-menu__sidebar .paper-btn.is-current（否则当前页高亮被盖掉）")
    # 白底**不该**被 hover 抹掉：base.css 的 `.paper-btn:hover` 只改 background-image，
    # 本规则的 background-color 与它同档但书写在后 → 仍然生效。这里锁住「hover 规则里别再写
    # background-color」这个前提，一旦有人给悬停态加底色，白底就会在鼠标移上去时闪掉。
    hover_btn = css_rule(css, ".game-menu__sidebar .paper-btn:hover")
    check("background-color" not in hover_btn,
          "侧栏按钮 hover 规则不写 background-color（同档后写会盖掉白底）")

    back_rule = css_rule(css, ".game-menu__sidebar .back-btn")
    check("margin-top: auto" in back_rule,
          "「返回」用 margin-top:auto 压到底部，不与上面那组导航按钮相连")


def test_about_text_single_source():
    """关于页正文的单一来源 = 工程根 about.txt（2026-09-27）。

    正文是**游戏内容**，不属于 theme.json（它只描述外观与界面）。历史症状：
    theme.js 在模板模式下 `if (r3.ok) loaded.about = await r3.text();` 无条件覆盖，
    而 about.txt 是 0 字节的诞生文件 → 正文被空串清掉，关于页只剩引擎自带的那几行。

    这里锁住四件事：① 配置里没有 about；② 两个入口都读 about.txt；
    ③ 空文件不算「有正文」；④ 旧工程的 theme.json.about 仍能兜住（带迁移提示）。
    另外锁住本页两块易退化的东西：**版本号都带 `v` 前缀**（verLabel 单一来源）与
    **「正文定宽 + 白底只包住正文栏且居中」这套版式**（白底从 .game-menu__main 挪到 .about-panel）。
    """
    print("[9] 关于页：正文来源 about.txt + 版本号 v 前缀 + 定宽正文栏版式")
    sys.path.insert(0, HERE) if HERE not in sys.path else None
    import tempfile
    import shutil
    import contextlib
    import io

    theme = json.loads(read(THEME_JSON))
    check("about" not in theme, "模板 theme.json 不含 about 键（正文不在配置里）")
    check("info" not in theme,
          "模板 theme.json 不含 info 键（游戏名/版本唯一来源是 info.json）")

    js = read(THEME_JS)
    check("theme.about" not in js, "theme.js 不再从 theme.about 取正文")
    check("ABOUT_TEXT" in js, "theme.js 用单一变量 ABOUT_TEXT 承载正文")
    check("about.txt" in js, "theme.js（模板模式）运行时 fetch about.txt")
    # 空文件不覆盖：正则要求 trim() 判断存在
    m = re.search(r'r3\.ok\)\s*\{([^}]*)\}', js)
    check(m is not None and ".trim()" in m.group(1),
          "theme.js 只在 about.txt 非空时才采用其内容（空文件不清空正文）")
    check("__ABOUT__" in js, "theme.js 构建模式从 window.__ABOUT__ 取正文")

    py = read(BUILDER_PY)
    check("ABOUT_FILE" in py and "def resolve_about" in py,
          "builder.py 有 resolve_about() 且以 ABOUT_FILE 为唯一文件名")
    check("__ABOUT__" in py, "builder.py 把正文内联为 window.__ABOUT__")

    tpl_about = os.path.join(TEMPLATE, "about.txt")
    check(os.path.isfile(tpl_about) and os.path.getsize(tpl_about) > 0,
          "模板 about.txt 存在且非空（create 出来的新工程自带可用的示例正文）")

    # ---- 版本行：两个版本号同框同行，「引擎名 + 版本号」整体是指向引擎仓库的链接 ----
    # 剥注释后再查「有没有那两句话」：本函数的说明注释里为了讲清改动，原样引用了它们。
    js_code = strip_comments(js)
    check("由 aliceADV 引擎驱动" not in js_code,
          "theme.js 不再输出「由 aliceADV 引擎驱动 (MIT License)」这句")
    check("引擎仓库" not in js_code, "theme.js 不再输出「引擎仓库: …」这句")
    check("about-meta" in js, "theme.js 用 .about-meta 承载版本行")
    check('el("div", { class: "about-meta" })' in js,
          "版本行是**一个**容器（两个版本号同框，而不是两个各自成行的 div）")
    check('class: "about-meta__link"' in js and "href: ENGINE_REPO" in js,
          "版本行渲染为指向 ENGINE_REPO 的链接")
    # 链接文本 = ENGINE_LABEL（「引擎名 版本号」），即版本号**在链接之内**；
    # 且不在这里二次拼接（拼接两次迟早不一致）。
    check('text: ENGINE_LABEL' in js_code,
          "链接圈住「引擎名 + 版本号」整体（文案直接复用 ENGINE_LABEL）")
    check("引擎版本" not in js_code, "文案是「引擎」而不是「引擎版本」")
    check("ENGINE_REPO" in js, "theme.js 用 ENGINE_REPO，不再写死仓库 URL")

    init_py = read(os.path.join(SRC, "aliceadv", "__init__.py"))
    check('ENGINE_REPO = "https://github.com/Alice-Drop/aliceADV"' in init_py,
          "__init__.py 定义 ENGINE_REPO（仓库 URL 唯一来源）")
    check('"repo": ENGINE_REPO' in read(BUILDER_PY),
          "builder.py 把 repo 随 window.__ENGINE__ 一起内联")

    about_css = read(os.path.join(STYLE, "pages", "about.css"))
    css_code = strip_css_comments(about_css)
    check(".about-meta" in about_css and "border-radius" in about_css,
          "about.css 给版本行圆角框")
    check(".about-content .ver" not in about_css,
          "旧的「两个版本各占一行」的 .ver 样式已移除")
    check("inline-flex" in about_css,
          "版本行用 inline-flex（框宽随内容收缩，不拉满整行）")
    # 下划线：版本行链接**不带下划线**。两件事一起保证 ——
    #   ① 该规则体内没有 border-bottom（旧实现靠它画线）；
    #   ② 正文链接规则必须收窄到 `p`：写成 `.about-content a`（特异性 0,1,1）会比
    #      单个类的 `.about-meta__link`（0,1,0）**更具体**，从而把 main:none 覆盖成 underline ——
    #      那样 `.about-meta__link` 里的 `text-decoration: none` 就成了死代码，改样式时看不出问题。
    check(".about-content .about-body a" in css_code,
          "正文链接规则收窄到 .about-body 之内（`.about-content p a` 的 v3 等价写法："
          "正文是 div.about-line 而非 <p>，版本行不在 .about-body 内，二者不争特异性）")
    check(".about-content a" not in css_code,
          "旧的 `.about-content a` 已移除（它会把版本行链接强制加上下划线）")
    link_rule = css_code.split(".about-meta__link")[1].split("}")[0]
    check("text-decoration: none" in link_rule, "版本行链接 text-decoration:none（无下划线）")
    check("border-bottom" not in link_rule, "版本行链接不再用 border-bottom 画下划线")
    # hover 提示 = 变色 + 淡底。**光变色不够**：单色主题把 --color-hover 与 --color-accent
    # 设成同一个值（本工程都是 #000000）时毫无视觉变化，规则在但眼睛看不见。
    hover_rule = css_code.split(".about-meta__link:hover")[1].split("}")[0]
    check("color" in hover_rule, "版本行链接 hover 变色")
    check("color-mix" in hover_rule and "var(--color-accent)" in hover_rule,
          "hover 淡底由 --color-accent 经 color-mix 派生（主题驱动，不写死颜色）")
    check("rgba(" in hover_rule, "hover 淡底带 rgba 兜底（不支持 color-mix 时仍在）")

    # ---- 关于页正文空行逐行还原（2026-09-29，第三版修正）----
    # 第一版 split(/\n+/) 一刀切、空一行/空两行无法区分；第二版 pre-wrap，但空行没有内容、
    # 行盒塌缩成接近 0，空行仍没占住一行文字高度；终版：按 \n 切成一行一个块，非空行 = 一行文字，
    # 空行 = .about-blank 且 min-height 显式 = 一行文字高度（字号 × 1.7 = line-height）。
    check("split(/\\n+/).forEach" not in js_code,
          "theme.js 不再把整段正文按「连续换行」一刀切（空行数量信息被丢弃）")
    check("about-blank" in js_code and "textContent" in js_code,
          "theme.js 用 .about-blank 标记空行 + textContent 写入（空行 = 一行文字高度，且不当 HTML 解析）")
    blank_rule = css_code.split(".about-content .about-body .about-blank")[1].split("}")[0] \
        if ".about-content .about-body .about-blank" in css_code else ""
    check(bool(blank_rule) and "min-height" in blank_rule and "1.7" in blank_rule,
          "about.css 给空行 min-height = 一行文字高度（字号 × 1.7 = line-height）")
    check(".about-content p.is-section" not in css_code,
          "旧的 .is-section 段距写法已移除（段距不再用数值硬凑）")
    check(".about-content p " not in css_code and ".about-content p{" not in css_code,
          "正文不再拆成多个 <p>（一行一个块整体渲染）")

    # ---- 版本号都带 `v` 前缀（2026-09-27 修：关于页的「游戏版本」少了一个 v）----
    # 标题页原先写 `"v" + info.version`、关于页写 `info.version` —— 同一条信息两处各拼一次，
    # 于是就有一处漏了前缀。现在统一走 verLabel()，两处都只是调用它。
    check("function verLabel" in js_code, "theme.js 有统一的 verLabel() 补 v 前缀")
    check("/^v/i.test(s)" in js_code,
          "verLabel 对已写成 v0.2.2 的值不再叠加一个 v")
    check(re.search(r'verLabel\(info\.version\)', js_code) is not None,
          "标题页的版本号走 verLabel()")
    check('"游戏版本 " + verLabel(info.version)' in js_code,
          "关于页的「游戏版本」也走 verLabel()（此前这里漏了 v，用户报的 bug）")
    check('"v" + info.version' not in js_code,
          "旧的 `\"v\" + info.version` 手拼已移除（否则又有两处拼接）")

    # ---- 关于页版式：正文定宽栏 + 白底只包住这一列 + 居中（2026-09-28）----
    # 主内容区在本页**不铺白底**：纸的左右两侧要直接透出整页衬底（用户要求「两面没有东西」）。
    # ⚠️ 纸宽必须**由正文栏宽算出**，不能再用 aspect-ratio 定 A4 比例：
    #    纸高固定（968）→ A4 比例把纸宽锁成 684 → 扣掉内边距栏宽只剩 572，
    #    换行相对原版（限宽 900）全面错位。用户报的「文字被放大了」其实是栏宽变窄，
    #    字号一个字都没改（工程 sizes.interface = 33 前后一致）。
    root_rule = css_rule(about_css, ".page_about")
    check("--about-sheet-content" in root_rule, "正文栏宽写成变量（.page_about 上）")
    check("900" in root_rule, "正文栏宽保持 900 这一档（与原版 max-width: 900px 逐字对齐换行）")
    main_rule = css_rule(about_css, ".page_about .game-menu__main")
    check("background: none" in main_rule,
          "关于页主内容区不铺白底（否则纸的左右两侧也一起变白）")
    check("box-shadow: none" in main_rule, "关于页主内容区也没有投影")
    body_rule = css_rule(about_css, ".page_about .game-menu__body")
    check("justify-content: center" in body_rule and "align-items: center" in body_rule,
          "关于页正文容器把纸**居中**（纵横都居中）")
    check("overflow: visible" in body_rule,
          "滚动移到纸内（容器自己不再滚，否则纸会被拉成一整列还能滚）")
    panel_rule = css_rule(about_css, ".page_about .about-panel")
    check("width: calc(var(--about-sheet-content) + var(--about-sheet-pad-x) * 2)" in panel_rule,
          "纸宽 = 正文栏宽 + 左右页边距（border-box → 内容盒正好落在 900 那一档）")
    check("aspect-ratio" not in panel_rule,
          "纸**不用** aspect-ratio 定比例（A4 比例会把栏宽压到 572、换行与原版错位）")
    check("--about-sheet-ratio" not in css_code,
          "旧的 --about-sheet-ratio 已彻底移除（留着就会被重新接回去）")
    check("max-width: 100%" in panel_rule,
          "纸不窄于容器（小窗口 / 窄主区时不溢出）")
    check("height: 100%" in panel_rule, "纸高 = 正文容器高（再减去纸四周留白）")
    check("overflow-y: auto" in panel_rule, "正文比纸高时在**纸内**滚动")
    check("var(--game-menu-panel" in panel_rule,
          "纸的底色仍取 --game-menu-panel（= gameMenu.panelColor，写 null 依旧能关掉）")
    check("padding" in panel_rule and "var(--about-sheet-pad" in panel_rule,
          "纸自带页边距（横向那一档同时决定纸比正文栏宽出多少）")
    # 归位检查：栏宽只有一个来源（变量），正文再限一次宽
    content_rule = css_rule(about_css, ".about-content")
    check("max-width: var(--about-sheet-content)" in content_rule,
          ".about-content 用同一个变量限宽（栏宽只有一处可改）")
    check("max-width: 980px" not in css_code and "max-width: 900px" not in css_code,
          "旧版写死的 980/900 限宽不再回来（否则与变量成为两套宽度）")

    # ---- 功能验证：真跑 resolve_config / build_project ----
    tmp = tempfile.mkdtemp(prefix="aliceadv_about_")
    try:
        # ① 正常工程：正文在 about.txt
        proj = os.path.join(tmp, "ok")
        os.makedirs(proj)
        with open(os.path.join(proj, "theme.json"), "w", encoding="utf-8") as f:
            json.dump({}, f)
        with open(os.path.join(proj, "about.txt"), "w", encoding="utf-8") as f:
            f.write("第一段\n\n第二段\n")
        _t, _i, about = _builder.resolve_config(proj)
        check(about == "第一段\n\n第二段\n", "about.txt 的内容原样成为正文")
        check("about" not in _t, "生效配置里不含 about 键（正文不进 window.__THEME__）")

        # ② 兼容：old theme.json 有 about + 空的 about.txt
        proj2 = os.path.join(tmp, "legacy")
        os.makedirs(proj2)
        with open(os.path.join(proj2, "theme.json"), "w", encoding="utf-8") as f:
            json.dump({"about": "旧工程写在 theme.json 里的正文"}, f, ensure_ascii=False)
        with open(os.path.join(proj2, "about.txt"), "w", encoding="utf-8") as f:
            f.write("")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            _t2, _i2, about2 = _builder.resolve_config(proj2)
        check(about2 == "旧工程写在 theme.json 里的正文",
              "旧工程的 theme.json.about 仍被沿用（不会突然空白）")
        check("已废弃" in buf.getvalue() and "about.txt" in buf.getvalue(),
              "并打印迁移提示（指向 about.txt）")

        # ③ 两者都有 → about.txt 优先
        proj3 = os.path.join(tmp, "both")
        os.makedirs(proj3)
        with open(os.path.join(proj3, "theme.json"), "w", encoding="utf-8") as f:
            json.dump({"about": "theme.json 的旧值"}, f, ensure_ascii=False)
        with open(os.path.join(proj3, "about.txt"), "w", encoding="utf-8") as f:
            f.write("about.txt 的新值")
        _t3, _i3, about3 = _builder.resolve_config(proj3)
        check(about3 == "about.txt 的新值", "about.txt 有内容时优先于 theme.json.about")

        # ④ 真构建：产物内联 window.__ABOUT__，且产物的 theme.json 不含 about
        web = os.path.join(proj, "dist", "web")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            ok_build = _builder.build_project(proj)
        check(ok_build, "临时工程构建成功")
        if ok_build:
            html = read(os.path.join(web, "index.html"))
            check('window.__ABOUT__ = "第一段\\n\\n第二段\\n"' in html,
                  "产物 index.html 内联 window.__ABOUT__（file:// 直接可读）")
            built_theme = json.loads(read(os.path.join(web, "theme.json")))
            check("about" not in built_theme, "产物 theme.json 不含 about 键")
            check(os.path.join(web, "about.txt") and
                  os.path.isfile(os.path.join(web, "about.txt")),
                  "about.txt 随产物一同分发（作者可对照）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_gui2theme_keys_are_all_consumed():
    """Ren'Py 换算键必须全部有消费者：`gui2theme` 从 gui.rpy 算出来的每一个键，
    都要有对应的 CSS 变量被构建期写出、并且被模板 CSS 读到。

    这一条是 2026-09-27 发现的坑的守卫：`gui2theme` 一直在输出 `layout.name.align`
    （Ren'Py 的 `gui.name_xalign`），而引擎从来没读过它——名字框位置固定按左缘贴合，
    作者改这个键毫无反应（配置在说谎）。现在 `name_xalign` 输出为 `layout.name.anchor`
    （0~1 锚点）并由 `--name-anchor` 消费。

    做法：真调 compute_layout()（而不是硬编码键名清单），把结果按键名映射成期望的
    变量名，再分别核对「构建期写出」与「CSS 读取」两侧。
    """
    print("[10] gui2theme（Ren'Py 换算）产出的每个键都有消费者")
    from aliceadv.tools import gui2theme as _g

    # 一份「gui.rpy 里什么都有」的参数集，保证 compute_layout 走完所有分支
    g = {
        "W": 1920, "H": 1080,
        "textbox_height": 278, "textbox_yalign": 1.0,
        "dialogue_xpos": 96, "dialogue_ypos": 20, "dialogue_text_xalign": 0.0,
        "name_xpos": 36, "name_ypos": 0, "name_xalign": 0.0,
        "nvl_thought_xpos": 360, "nvl_thought_width": 1200,
        "nvl_spacing": 15, "nvl_thought_xalign": 0.5,
        "choice_button_width": 800, "choice_spacing": 12,
        "text_size": 22, "name_text_size": 28,
        "choice_button_text_size": 24, "interface_text_size": 22,
    }
    computed = _g.compute_layout(g)

    expected = set()
    for sec in ("dialogue", "name", "nvl", "choice"):
        for k in computed.get("layout", {}).get(sec, {}):
            expected.add("--%s-%s" % (sec, _builder.css_name(k)))
    for k in computed.get("sizes", {}):
        expected.add("--size-%s" % _builder.css_name(k))

    theme = json.loads(read(THEME_JSON))
    for sec, items in computed.items():
        tgt = theme.setdefault(sec, {})
        for k, v in items.items():
            if isinstance(v, dict):
                tgt.setdefault(k, {}).update(v)
            else:
                tgt[k] = v
    written = set(built_vars(theme))

    consumed = set()
    for p in css_files():
        consumed |= set(re.findall(r"var\((--[A-Za-z0-9_-]+)", read(p)))

    for name in sorted(expected):
        check(name in written, "构建期写出 %s（来自 gui2theme 的某个键）" % name)
        check(name in consumed, "%s 有 CSS 消费者" % name)
    check(bool(expected), "compute_layout 确实产出了键可校验（%d 个变量）" % len(expected))


def test_notify_and_skip_are_wired():
    """Ren'Py 的 notify / skip_indicator 两条提示必须真的接上（2026-09-27）。

    接上之前是「假配置」：模板 theme.json 写着 `notifyYpos` / `skipYpos`，theme.js 也把
    它们写成了 `--notify-ypos` / `--skip-ypos`，但 `.notify` 这个元素没有任何代码创建、
    `--skip-ypos` 没有任何 CSS 读 —— 两个键都是「写得出、改了没反应」。

    这里锁住五件事，每一条都对应一个已经踩过或极易踩的坑：
      ① 两个位置键各自有 CSS 消费者；
      ② 两个元素由 theme.js 的 buildStagePage() 搭骨架（**不是运行时创建** ——
         舞台重建会清空 #page_stage，运行时自建的节点留不下来）；
      ③ 显隐靠 .is-active 且默认 display:none（否则空衬底会一直挂在屏幕上）；
      ④ 快进指示条只由 state.skip 驱动，同步点必须在 syncPlaybackMode() 的
         `if (!P) return` **之前**（否则预加载器缺席时指示条就不动了）；
      ⑤ autoSlots 已从引擎里彻底移除（它声明 9 个自动槽，与实际 3×2=6 格矛盾）。
    """
    print("[11] notify / skip 提示条已接上（autoSlots 已移除）")
    css_all = "\n".join(read(p) for p in css_files())
    js = read(THEME_JS)

    # ---- ① 位置键有消费者 ----
    check("var(--notify-ypos" in css_all, ".notify 读 --notify-ypos")
    check("var(--skip-ypos" in css_all, ".skip-indicator 读 --skip-ypos")

    # ---- ② 骨架由 buildStagePage() 搭建 ----
    m = re.search(r"function buildStagePage\([\s\S]*?\n    function ", js)
    check(m is not None, "theme.js 里能定位到 buildStagePage()")
    stage_body = m.group(0) if m else ""
    for cls in ("notify", "notify__inner", "skip-indicator", "skip-indicator__inner"):
        check('"%s"' % cls in stage_body, "buildStagePage() 搭建 .%s" % cls)
    check("I18N.skipIndicator" in stage_body,
          "快进文案取自 I18N.skipIndicator（界面文案单一来源）")

    # ---- ③ 默认隐藏，.is-active 才显示 ----
    for sel in (".notify", ".skip-indicator"):
        m2 = re.search(re.escape(sel) + r"\s*\{([^}]*)\}", css_all)
        check(m2 is not None and "display: none" in m2.group(1),
              "%s 默认 display:none（无消息时不占位）" % sel)
        check(sel + ".is-active" in css_all, "%s 用 .is-active 控制显隐" % sel)

    # ---- ④ 快进指示条的单一驱动点 ----
    eng = read(ENGINE_JS)
    exp = re.search(r"global\.AliceADVEngine = \{[\s\S]*?\n    \};", eng)
    check(exp is not None and "notify" in exp.group(0)
          and "setSkipIndicator" in exp.group(0),
          "engine.js 导出 notify / clearNotify / setSkipIndicator")
    check('el("div", { class: "notify" }' in js or 'class: "notify"' in js,
          "engine.js 不自行创建 .notify（骨架归 theme.js）")
    m3 = re.search(r"function syncPlaybackMode\(\)[\s\S]*?\n    function ",
                   read(os.path.join(STYLE, "script.js")))
    check(m3 is not None, "script.js 里能定位到 syncPlaybackMode()")
    body = m3.group(0) if m3 else ""
    # 先剥注释再判顺序（理由见 strip_comments）：注释为了讲清这条规则会原样引用那句守卫。
    code = strip_comments(body)
    check("setSkipIndicator(state.skip)" in code,
          "syncPlaybackMode() 按 state.skip 同步快进指示条")
    i_sync, i_guard = code.find("setSkipIndicator"), code.find("if (!P) return")
    check(i_sync != -1 and (i_guard == -1 or i_sync < i_guard),
          "同步点在早退守卫（预加载器缺席则 return）之前——否则该守卫一触发指示条就不动了")

    # ---- ⑤ autoSlots 彻底移除 ----
    hits = []
    for root, _dirs, names in os.walk(SRC):
        for n in names:
            if n.endswith((".py", ".js", ".json", ".css", ".html", ".txt", ".md")):
                p = os.path.join(root, n)
                if "autoSlots" in read(p):
                    hits.append(os.path.relpath(p, SRC))
    check(not hits, "引擎源码里已无 autoSlots（残留: %s）" % ", ".join(hits))
    check("autoSlots" not in read(THEME_JSON),
          "模板 theme.json 的 pages.save 不再声明 autoSlots")


def test_toolbar_buttons_wired():
    """舞台工具栏：默认列表在**三处**必须逐项一致，且每个键都有「文案 + 动作」两份映射。

    2026-10-06 用户报「stage 菜单里忘记放读取按钮」。根因不是某一处写错，而是
    **同一个列表散在三处**（模板 theme.json / theme.js 兜底数组 / 工程 theme.json），
    三处各自演化，`load` 只在 `TOOLBAR_LABELS` 与 `TOOL_ACTIONS` 里备好了，
    三个列表却都没把它列进去 —— 按钮于是既不渲染也点不到，且 build 全程不报错。
    加上「数组在 deep merge 里整替」：工程只写 pages.stage.background 也会用自己的
    整份列表盖掉模板默认，于是**只改模板等于没改**。

    这里锁住：① 三处列表逐项一致；② 每个键在 TOOLBAR_LABELS 与 TOOL_ACTIONS 里都有映射
    （缺一个 = 点了没反应或跳错页）；③ 默认列表必须含 load（它曾长期缺席）。
    动态部分（真点击 load 能打开 page_load）由 assets/verify_toolbar_load_readable.js 覆盖。
    """
    print("[12] 舞台工具栏：三处列表一致 + 每个键都有文案与动作映射")
    import re as _re

    theme = json.loads(read(THEME_JSON))
    tpl = theme.get("pages", {}).get("stage", {}).get("toolbar") or []
    check(bool(tpl), "模板 theme.json 的 pages.stage.toolbar 非空")

    js = read(THEME_JS)
    js_code = strip_comments(js)
    # theme.js 兜底数组：形如 ["back", "history", ... ]
    m = _re.search(r'cfg\.toolbar && cfg\.toolbar\.length\)\s*\?\s*cfg\.toolbar\s*:\s*\[([^\]]*)\]', js_code, _re.S)
    check(m is not None, "theme.js 里能定位到 buildStagePage 的工具栏兜底数组")
    fb = _re.findall(r'"([^"]+)"', m.group(1)) if m else []
    check(fb == tpl,
          "theme.js 兜底数组与模板 theme.json 逐项一致（改一处必须三处同步）"
          "｜theme.js=%s / theme.json=%s" % (fb, tpl))

    # 三份映射：TOOLBAR_LABELS（文案）/ TOOL_ACTIONS（动作）/ NAV（data-page）
    labels = _re.search(r"const TOOLBAR_LABELS = \{([\s\S]*?)\n    \};", js_code)
    acts = _re.search(r"const TOOL_ACTIONS = \{([\s\S]*?)\};", read(os.path.join(STYLE, "engine.js")))
    check(labels is not None and acts is not None, "能定位到 TOOLBAR_LABELS 与 TOOL_ACTIONS")
    label_keys = _re.findall(r"(\w+):", labels.group(1)) if labels else []
    act_keys = _re.findall(r"(\w+):", acts.group(1)) if acts else []
    for k in tpl:
        check(k in label_keys, "键 %s 有文案（TOOLBAR_LABELS）" % k)
        check(k in act_keys, "键 %s 有动作（TOOL_ACTIONS，否则点了没反应）" % k)

    check("load" in tpl, "默认列表含 load（读取）——它曾长期缺席导致按钮不显示")
    # 顺序：读取紧跟保存（读档与存档成对），避免以后又被排到末尾
    if "load" in tpl and "save" in tpl:
        check(tpl.index("load") == tpl.index("save") + 1, "load 紧跟在 save 之后（读档与存档成对）")

    # 工具栏文字压在背景图上，底色不可控 → 描边 + paint-order + 多层阴影缺一不可
    css = strip_css_comments(read(os.path.join(STYLE, "pages", "stage.css")))
    btn = css_rule(css, ".toolbar__btn")
    check("text-stroke" in btn, ".toolbar__btn 有深色描边（亮底上白字否则隐形）")
    check("paint-order" in btn, ".toolbar__btn 写 paint-order: stroke（描边不削细笔画）")
    shadows = btn.count("text-shadow") + len(_re.findall(r"rgba\([^)]*0\.[0-9]+\)", btn))
    check(shadows >= 2, ".toolbar__btn 的落影/描边是多层的（老浏览器不支持 stroke 时仍有兜底）")
    hover = css_rule(css, ".toolbar__btn:hover")
    check("text-stroke" in hover,
          "hover 同时加深描边（单靠「字更白」在亮底上没有视觉变化）")


def main():
    test_builder_never_emits_camelcase_vars()
    test_no_inert_palette_key()
    test_css_readers_are_all_written()
    test_no_literal_defaults_in_pipeline()
    test_design_resolution_not_hardcoded()
    test_builder_js_naming_agree()
    test_sidebar_has_no_history()
    test_gamemenu_defaults_single_source()
    test_about_text_single_source()
    test_gui2theme_keys_are_all_consumed()
    test_notify_and_skip_are_wired()
    test_toolbar_buttons_wired()
    print()
    if _failures:
        print("FAILED (%d):" % len(_failures))
        for m in _failures:
            print("  - " + m)
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
