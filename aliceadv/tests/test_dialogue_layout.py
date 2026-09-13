#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""回归测试：对话框文本框布局变量一致性 + 构建注入。

根因（2026-09-08 发现的反复性 bug）：
  1) theme.js 的 applyThemeVars 只写入了已废弃的 --dialogue-pad-y，漏写
     --dialogue-pad-top / --dialogue-pad-bottom / --dialogue-justify / --dialogue-text-align，
     导致 theme.json.layout.dialogue 的 padTop/padBottom/justify/textAlign 在运行时被忽略，
     文本框文字退回到 CSS 默认值（居中、2.4em 内边距）——视觉上「偏下、对不上横线」。
  2) builder.py 的 index.html 注入用精确字符串 .replace('<link ... href="style/pages/popup.css">')，
     而真实 <link> 带 data-page-node-id 属性，导致 .replace 匹配不上，theme.built.css /
     fonts.built.css 从未被引入，构建期那一份正确变量也失效。

本测试防止同类问题复发：
  - 交叉校验 stage.css 读取的所有 --dialogue-* 变量，必须在 builder.py(build_css_vars)
    与 theme.js(applyThemeVars) 两处都被写入（任一处漏写/改名立即失败）。
  - 端到端构建临时工程，断言 dist/web/index.html 确实引入了 theme.built.css 与 fonts.built.css。

运行：
  python tests/test_dialogue_layout.py
  （也可被 pytest 收集，函数名以 test_ 开头）
"""

import os
import re
import sys
import tempfile
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)                       # .../aliceadv
SRC = os.path.join(PKG, "src")                    # .../aliceadv/src
sys.path.insert(0, SRC)

import aliceadv.builder as _builder               # 本地包（SRC 已在 sys.path 最前）
build_project = _builder.build_project
from aliceadv import ENGINE_MARKER

# 全部路径从本地包目录显式推导，避免 import aliceadv 解析到其它位置的同名包
TEMPLATE = os.path.join(SRC, "aliceadv", "template")
STAGE_CSS = os.path.join(TEMPLATE, "style", "pages", "stage.css")
THEME_JS = os.path.join(TEMPLATE, "style", "theme.js")
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


def css_vars_read(path):
    """stage.css 中通过 var(--dialogue-*) 读取的变量名集合。"""
    txt = read(path)
    return set(re.findall(r"var\((--dialogue-[a-z-]+)", txt))


def js_vars_written(path):
    """theme.js 中 setVar("--dialogue-...", ...) 写入的变量名集合。"""
    txt = read(path)
    return set(re.findall(r'setVar\("(--dialogue-[a-z-]+)"', txt))


def builder_vars_written(path):
    """从 builder.py 源码静态提取 build_css_vars 里所有写入的 --dialogue-* 变量名。

    builder.py 用 f-string 拼装 CSS 行，两种形态都匹配：
      lines.append(f"  --dialogue-pad-top: {d.get('padTop')};")
      lines.append(f'  --dialogue-pad-top: {...};')
    """
    txt = read(path)
    return set(re.findall(r"(--dialogue-[a-z-]+):", txt))


# ---------------------------------------------------------------------------
def test_dialogue_vars_consistency():
    print("[1] 对话框布局变量：CSS 读取 ⊆ (builder 写入 ∩ theme.js 写入)")
    css = css_vars_read(STAGE_CSS)
    js = js_vars_written(THEME_JS)
    b = builder_vars_written(BUILDER_PY)

    # 引擎运行时的 .textbox / .textbox__text 必须至少读取这四个核心变量
    for need in ("--dialogue-pad-top", "--dialogue-pad-bottom",
                 "--dialogue-pad-left", "--dialogue-pad-right",
                 "--dialogue-justify", "--dialogue-text-align",
                 "--dialogue-left", "--dialogue-bottom",
                 "--dialogue-width", "--dialogue-height",
                 "--dialogue-pad-x"):
        check(need in css, f"stage.css 读取 {need}")

    missing_js = sorted(css - js)
    missing_b = sorted(css - b)
    check(not missing_js,
          "theme.js 写入覆盖 stage.css 所有 --dialogue-*（缺: %s）" % ", ".join(missing_js))
    check(not missing_b,
          "builder.py 写入覆盖 stage.css 所有 --dialogue-*（缺: %s）" % ", ".join(missing_b))

    # 已废弃变量不得再出现（防止有人误改回 --dialogue-pad-y 这种名字）
    check("--dialogue-pad-y" not in js, "theme.js 不再写入废弃的 --dialogue-pad-y")
    check("--dialogue-pad-y" not in b, "builder.py 不再写入废弃的 --dialogue-pad-y")


def test_build_injects_built_css():
    print("[2] 端到端：构建产物 index.html 必须引入 theme.built.css / fonts.built.css")
    tmp = tempfile.mkdtemp(prefix="aliceadv_test_")
    try:
        # 复制模板为临时工程（去掉引擎标记，否则 build 拒绝）
        proj = os.path.join(tmp, "proj")
        shutil.copytree(TEMPLATE, proj)
        marker = os.path.join(proj, ENGINE_MARKER)
        if os.path.exists(marker):
            os.remove(marker)
        build_project(proj)

        html = read(os.path.join(proj, "dist", "web", "index.html"))
        check('href="style/theme.built.css"' in html,
              "index.html 引入 theme.built.css")
        # fonts.built.css 仅当 theme.json 配置了 fonts 时才生成并注入；
        # 模板（Example Game）无 fonts 配置，故此处按「存在即必须被引入」校验。
        fonts_built = os.path.join(proj, "dist", "web", "style", "fonts.built.css")
        if os.path.exists(fonts_built):
            check('href="style/fonts.built.css"' in html,
                  "index.html 引入 fonts.built.css")
        else:
            print("  · 模板无 fonts 配置，跳过 fonts.built.css 注入断言（符合预期）")

        # theme.built.css 内确实包含对话布局变量（验证 :root 块正确生成）
        built = read(os.path.join(proj, "dist", "web", "style", "theme.built.css"))
        for need in ("--dialogue-pad-top", "--dialogue-pad-bottom",
                     "--dialogue-pad-left", "--dialogue-pad-right",
                     "--dialogue-justify", "--dialogue-text-align"):
            check(need in built, f"theme.built.css 包含 {need}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    test_dialogue_vars_consistency()
    test_build_injects_built_css()
    print()
    if _failures:
        print("FAILED (%d):" % len(_failures))
        for m in _failures:
            print("  - " + m)
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
