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

本测试把上述五条固化成断言，防止复发。

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
    """菜单页两层衬底（整页半透明衬底 + 主内容不透明白底板）的默认值只写在
    模板 theme.json 的 gameMenu —— 流程代码（theme.js / builder.py）不得再存一份字面兜底。"""
    print("[8] 菜单页衬底默认值单一来源（模板 theme.json 的 gameMenu）")
    theme = json.loads(read(THEME_JSON))
    gm = theme.get("gameMenu") or {}
    tint, panel = gm.get("backgroundColor"), gm.get("panelColor")
    check(bool(tint), "模板 gameMenu.backgroundColor = %s" % tint)
    check(bool(panel), "模板 gameMenu.panelColor = %s" % panel)
    for path, label in ((THEME_JS, "theme.js"), (BUILDER_PY, "builder.py")):
        txt = read(path)
        check(panel not in txt, "%s 不含 panelColor 字面量 %s" % (label, panel))
        check(tint not in txt, "%s 不含 backgroundColor 字面量 %s" % (label, tint))
    css = read(os.path.join(STYLE, "pages", "game-menu.css"))
    check("var(--game-menu-panel" in css, "game-menu.css 通过 var(--game-menu-panel) 读主内容底板")
    js = read(THEME_JS)
    check("--game-menu-panel" in js, "theme.js 写入 --game-menu-panel")
    check("gameMenu" in js, "theme.js 读取 theme.gameMenu 作为共享默认")


def main():
    test_builder_never_emits_camelcase_vars()
    test_no_inert_palette_key()
    test_css_readers_are_all_written()
    test_no_literal_defaults_in_pipeline()
    test_design_resolution_not_hardcoded()
    test_builder_js_naming_agree()
    test_sidebar_has_no_history()
    test_gamemenu_defaults_single_source()
    print()
    if _failures:
        print("FAILED (%d):" % len(_failures))
        for m in _failures:
            print("  - " + m)
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
