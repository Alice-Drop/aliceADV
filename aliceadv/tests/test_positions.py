#!/usr/bin/env python3
"""站位系统（章级 positions）的不变量（静态守卫 + 解析器实测）。

守的是四件事：
  1. 内置 left / center / right 三槽存在且语义固定，center 是 at 的缺省兜底；
  2. 十个字段在运行时、构建期校验、Ren'Py 转换器三处同源；
  3. 站位由运行时演出控制系统计算并落地，构建期只校验、不产出 CSS；
  4. 文档、工程数据与构建产物口径一致。

跑法：PYTHONPATH=aliceadv/src python3 aliceadv/tests/test_positions.py
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.normpath(os.path.join(HERE, "..", "src"))
sys.path.insert(0, PKG)

TPL = os.path.normpath(os.path.join(PKG, "aliceadv", "template"))
DOCS = os.path.normpath(os.path.join(HERE, "..", "..", "docs"))
WORKSPACE = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
SCRIPT_JS = os.path.join(TPL, "style", "script.js")
STAGE_CSS = os.path.join(TPL, "style", "pages", "stage.css")
BUILDER_PY = os.path.normpath(os.path.join(PKG, "aliceadv", "builder.py"))
RPY2ADV_PY = os.path.normpath(os.path.join(PKG, "aliceadv", "tools", "rpy2adv.py"))
PROJECT_CH1 = os.path.join(WORKSPACE, "girls_orbit_project", "story", "ch1.json")
PROJECT_DIST = os.path.join(WORKSPACE, "girls_orbit_project", "dist", "web", "index.html")

failures = []
notes = []


def check(cond, ok, bad):
    if cond:
        notes.append("  ✓ " + ok)
    else:
        failures.append("  ✗ " + bad)


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def fields_of(text, name):
    m = re.search(name + r"\s*=\s*[\[\(](.*?)[\]\)]", text, re.S)
    if not m:
        return None
    return set(a or b for a, b in re.findall(r'"(\w+)"|\'(\w+)\'', m.group(1)))


def main():
    from aliceadv.builder import validate_positions
    from aliceadv.tools.rpy2adv import parse_transforms

    js = read(SCRIPT_JS)
    css = read(STAGE_CSS)
    builder = read(BUILDER_PY)
    rpy2adv = read(RPY2ADV_PY)

    print("[1] 内置三槽与缺省兜底")
    block = re.search(r"const DEFAULT_POSITIONS\s*=\s*\{(.*?)\};", js, re.S)
    check(block is not None, "DEFAULT_POSITIONS 存在", "缺少 DEFAULT_POSITIONS")
    if block:
        b = block.group(1)
        check(re.search(r"left:\s*\{\s*xalign:\s*0\.0", b) is not None,
              "left = xalign 0.0", "内置 left 不是 xalign 0.0")
        check(re.search(r"center:\s*\{\s*xalign:\s*0\.5", b) is not None,
              "center = xalign 0.5", "内置 center 不是 xalign 0.5")
        check(re.search(r"right:\s*\{\s*xalign:\s*1\.0", b) is not None,
              "right = xalign 1.0", "内置 right 不是 xalign 1.0")
        check(b.count("yalign: 1.0") == 3,
              "三个内置站位都贴底（yalign 1.0）", "内置站位未全部贴底")
    check(re.search(r'\(at == null \|\| at === ""\)\s*\?\s*"center"\s*:\s*String\(at\)', js) is not None,
          "at 缺省回落 center", "at 缺省没有回落 center")
    check("Object.assign({}, DEFAULT_POSITIONS, own)" in js,
          "章级 positions 覆盖内置三槽", "章级表没有与内置表合并")

    print("[2] 十个字段三处同源")
    js_fields = fields_of(js, "POSITION_FIELDS")
    py_fields = fields_of(builder, "POSITION_FIELDS")
    tool_fields = fields_of(rpy2adv, "POSITION_PROPS")
    expect = {"left", "top", "right", "bottom",
              "xpos", "ypos", "xanchor", "yanchor", "xalign", "yalign"}
    for label, got in (("script.js", js_fields), ("builder.py", py_fields),
                       ("rpy2adv.py", tool_fields)):
        check(got == expect, label + " 的字段集是完整的十个",
              label + " 字段集不符：%s" % (sorted(got) if got else "解析失败"))

    print("[3] 运行时计算与落地分层")
    for fn in ("function positionTable", "function resolvePosition",
               "function resolveAt", "function applySpriteLayout",
               "function canvasLength", "function anchorLength"):
        check(fn in js, fn + "() 存在", "缺少 " + fn)
    binds = len(re.findall(r"^\s*applySpriteLayout\(node,", js, re.M))
    check(binds == 3,
          "三个绑定点都调用 applySpriteLayout（新建 / 换站位 / 快照重建）",
          "绑定点数量不是 3（%d）" % binds)
    check('--char-tx' in js and '--char-ty' in js,
          "落地层写入 --char-tx / --char-ty", "落地层没写垂直偏移变量")
    check(".stage-char.at-left" not in css and ".stage-char.at-right" not in css,
          "CSS 不再写死 left / right 站位", "CSS 仍有写死的 at-* 定位规则")
    check("translate(var(--char-tx, 0), var(--char-ty, 0))" in css,
          ".stage-char 用两个变量做 transform", "transform 没同时读 tx / ty")
    check(css.count("--char-ty") >= 3,
          "动画 keyframes 也保留垂直偏移", "keyframes 未同步 --char-ty")

    print("[4] 构建期只校验，不产出 CSS")
    check("def validate_positions" in builder,
          "builder.validate_positions 存在", "缺少构建期校验函数")
    check(re.search(r"for _w in validate_positions\(scripts\)", builder) is not None,
          "build 流程调用了校验", "校验函数没接进 build")
    check("positions.built.css" not in builder,
          "构建期没有生成站位 CSS 文件", "构建期仍在产出站位 CSS")
    check("validate_positions" in read(os.path.join(DOCS, "编译原理.md")),
          "编译原理.md 记录了只读校验", "编译原理.md 未说明校验")

    print("[5] 校验函数实测")
    good = {"story/ch1.json": {"positions": {
        "left": {"xalign": 0.3, "yalign": 1.0},
        "right": {"left": 0.3, "bottom": 0}}}}
    check(validate_positions(good) == [],
          "合法配置无告警", "合法配置产生了告警：%s" % validate_positions(good))
    bad = {"story/ch1.json": {"positions": {
        "left": 0.3,
        "weird": {"xalign": 0.3, "zoom": 1.2},
        "mix": {"xalign": 0.3, "left": 0.2, "top": 0.1, "bottom": 0}}}}
    warns = validate_positions(bad)
    check(any("必须是对象" in w for w in warns),
          "数字简写被拦截", "数字简写未被拦截")
    check(any("未识别字段" in w for w in warns),
          "未知字段被拦截", "未知字段未被拦截")
    check(any("混用" in w for w in warns),
          "字段冲突被提示", "字段冲突未被提示")

    print("[6] Ren'Py transform 解析实测")
    sample = ["transform left:\n", "    xalign 0.3  # 注释\n", "    yalign 1.0\n",
              "\n", "transform right:\n", "    xalign 0.7\n", "    yalign 1.0\n",
              "label start:\n", "    return\n"]
    got = parse_transforms(sample)
    want = {"left": {"xalign": 0.3, "yalign": 1.0},
            "right": {"xalign": 0.7, "yalign": 1.0}}
    check(got == want, "transform 块解析为章级 positions：%s" % got,
          "transform 解析结果不对：%s" % got)
    check('if positions:' in rpy2adv and 'ch1["positions"]' in rpy2adv,
          "转换器把 positions 写进 ch1.json", "转换器没有输出 positions")

    print("[7] 文档覆盖")
    zhiling = read(os.path.join(DOCS, "指令.md"))
    check("### 3.9 站位定义" in zhiling,
          "指令.md 有 3.9 站位定义", "指令.md 缺少站位章节")
    check(all(("`%s`" % k) in zhiling for k in expect),
          "十个字段都在字段表里", "指令.md 字段表不全")
    check("不要用 `hide` + `show` 表达移动" in zhiling,
          "说明了换站位的正确写法", "未说明换站位写法")
    check("positions" in read(os.path.join(DOCS, "剧本格式说明.md")),
          "剧本格式说明.md 记录了顶层 positions", "剧本格式说明.md 未记录 positions")
    yangshi = read(os.path.join(DOCS, "样式控制.md"))
    check("设计像素" in yangshi and "锚点类字段" in yangshi,
          "样式控制.md §1 补齐了单位约定", "样式控制.md 单位约定不完整")
    check("widht" not in read(os.path.join(DOCS, "定义.md")),
          "定义.md 的拼写错误已修", "定义.md 仍有 widht")

    print("[8] 工程数据与产物")
    if os.path.exists(PROJECT_CH1):
        ch1 = json.loads(read(PROJECT_CH1))
        check(ch1.get("positions") == want,
              "girls_orbit_project 的站位是原版 0.3 / 0.7",
              "工程 positions 不符：%s" % ch1.get("positions"))
    else:
        notes.append("  - 工程 ch1.json 不在工作区，跳过该项")
    if os.path.exists(PROJECT_DIST):
        html = read(PROJECT_DIST)
        m = re.search(r"window\.__SCRIPTS__\s*=\s*(\{.*?\});</script>", html, re.S)
        check(m is not None, "产物内联了 __SCRIPTS__", "产物缺少 __SCRIPTS__")
        if m:
            inline = json.loads(m.group(1)).get("story/ch1.json", {})
            check(inline.get("positions") == want,
                  "产物内联剧本带上 positions", "产物没有带上 positions")
        rt = read(os.path.join(WORKSPACE, "girls_orbit_project", "dist", "web",
                               "style", "script.js"))
        check("applySpriteLayout" in rt,
              "产物运行时含新站位系统", "产物仍是旧运行时")
    else:
        notes.append("  - 产物未构建，跳过产物项")

    print()
    for n in notes:
        print(n)
    if failures:
        print()
        for f in failures:
            print(f)
        print("\n✗ %d 项不满足" % len(failures))
        return 1
    print("\n✓ 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
