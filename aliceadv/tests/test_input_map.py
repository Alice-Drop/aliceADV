#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""回归测试：输入系统的静态自洽（动作表 / 绑定语法 / 配置 / 文档 / 两个历史 bug）。

与 tests/ 下其它测试同一定位：**不启动浏览器**，只读源码做结构断言。
真正的端到端行为由浏览器验证脚本覆盖（见 skills/aliceadv-verify 的
assets/verify_input_actions.js）。

断言分五组：

  A. 动作表本身：id 唯一、形状正确、每个动作都有人注册处理器。
     「在册但没人管」的动作是死动作：装了也不会有反应，且很难在页面上看出来。

  B. 文档 ↔ 代码一致：docs/输入与按键.md 的动作表必须与 input.js 的 ACTIONS
     逐行对上（id / priority / 是否按住 / 是否仅滚轮 / 默认方案绑定）。
     这份表是作者查动作的地方，漂移了比没有更糟。

  C. 配置合法性：theme.json 的 input.presets 里每个动作 id 都得在 ACTIONS 里，
     每条绑定字符串都得符合绑定语法（词汇表从 input.js 静态提取，不另抄一份）；
     default 要指向存在的方案；设置页 sections 引用的 key 都得在 settings.js 的
     SPECS 里登记，否则那条设置项会被静默跳过。

  D. 接线完整性：index.html 加载 input.js 与轮盘样式、且在依赖它的脚本之前，
     启动流程调用 init()；轮盘的外直径固定在画面高度的 30%、其余半径按比例派生
     （CSS 里不得写死 px 半径），input.js 量元素把生效尺寸取回来；
     四个方向是四个 1/4 圆环（各占 90°、各涂一条边、之间有缝）、中心留足净空隙；
     松手不执行置灰的格子。

  E. 两个已修 bug 的形状守卫（2026-09-29）：
     E1 空格键：normalizeKeyName 判空格必须在 trim() 之前——先 trim 的话
        String(" ").trim() 已是空串，判定成了死代码，key:space 永不匹配真实空格键。
     E2 回车被吞：confirmPopup 的判据必须是「浮层处于 is-active」，
        而退出确认框是常驻页面、只靠 .is-active 隐藏的，按 DOM 里存在按钮来判会永远消费回车。

运行：
  python aliceadv/tests/test_input_map.py
  （也可被 pytest 收集，函数名以 test_ 开头）
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)                        # .../aliceadv
SRC = os.path.join(PKG, "src")                     # .../aliceadv/src
sys.path.insert(0, SRC)

TEMPLATE = os.path.join(SRC, "aliceadv", "template")
STYLE = os.path.join(TEMPLATE, "style")
INPUT_JS = os.path.join(STYLE, "input.js")
SETTINGS_JS = os.path.join(STYLE, "settings.js")
ENGINE_JS = os.path.join(STYLE, "engine.js")
SCRIPT_JS = os.path.join(STYLE, "script.js")
RADIAL_CSS = os.path.join(STYLE, "pages", "radial.css")
THEME_JSON = os.path.join(TEMPLATE, "theme.json")
INDEX_HTML = os.path.join(TEMPLATE, "index.html")
DOC = os.path.join(os.path.dirname(PKG), "docs", "输入与按键.md")

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
    """剥掉 JS 的块注释与行注释。

    判「某段代码里有没有 X」「X 在不在 Y 之前」时**必须先剥注释**：说明性注释为了讲清一条规则，
    往往会原样引用被禁掉或要求的那段代码，直接搜会命中注释里的影子字面量。
    """
    src = re.sub(r"/\*[\s\S]*?\*/", "", src)
    return re.sub(r"//[^\n]*", "", src)


def function_body(js, name):
    """取 `function name(...) { ... }` 的函数体（括号配对扫描，能处理嵌套）。

    按「最近的右括号」取窗口会在体内有 if/for 时截断，所以这里做真正的配对扫描。
    """
    m = re.search(r"function\s+" + re.escape(name) + r"\s*\([^)]*\)\s*\{", js)
    if not m:
        return ""
    i = js.index("{", m.end() - 1)
    depth, j = 0, i
    while j < len(js):
        if js[j] == "{":
            depth += 1
        elif js[j] == "}":
            depth -= 1
            if depth == 0:
                return js[i + 1:j]
        j += 1
    return ""


def block_after(src, marker, oc="{", cc="}"):
    """取 `marker` 之后第一个由 oc/cc 配对包起来的块的内容（配对扫描，能处理嵌套）。

    注意 `const ACTIONS = [ {...}, {...} ]` 这种：必须按 **marker 里写的那个开括号** 配对
    （这里是 `[`），否则会取到第一个元素的 `{...}`，得到「0 个动作」这种假阴性。
    """
    k = src.find(marker)
    if k == -1:
        return ""
    i = src.index(oc, k + len(marker) - 1)
    depth, j = 0, i
    while j < len(src):
        if src[j] == oc:
            depth += 1
        elif src[j] == cc:
            depth -= 1
            if depth == 0:
                return src[i + 1:j]
        j += 1
    return ""


def brace_block(src, marker):
    return block_after(src, marker, "{", "}")


# ---------------------------------------------------------------- 提取

def actions_from_js(js):
    """input.js 的 ACTIONS 表 → { id: {priority, hold, wheelOnly, short} }。"""
    block = block_after(js, "const ACTIONS = [", "[", "]")
    if not block:
        return {}
    out = {}
    # 每条一行：{ id: "Advance", label: "…", short: "…", priority: 40 }
    for m in re.finditer(r"\{([^{}]*?)\}", block):
        row = m.group(1)
        mid = re.search(r'id:\s*"([^"]+)"', row)
        if not mid:
            continue
        aid = mid.group(1)
        pr = re.search(r"priority:\s*(-?\d+)", row)
        out[aid] = {
            "priority": int(pr.group(1)) if pr else None,
            "hold": bool(re.search(r"\bhold:\s*true", row)),
            "wheelOnly": bool(re.search(r"\bwheelOnly:\s*true", row)),
            "short": (re.search(r'short:\s*"([^"]*)"', row) or [None, ""])[1],
        }
    return out


def vocab_from_js(js):
    """绑定语法词汇表（从 input.js 静态提取，不在测试里另抄一份）。"""
    mouse = re.findall(r'"([a-z0-9]+)"', re.search(r"const MOUSE_NAMES = \[([^\]]*)\]", js).group(1))
    pad = {k: int(v) for k, v in re.findall(r"(\w+):\s*(\d+)", re.search(r"const PAD_ALIAS = \{([^}]*)\}", js).group(1))}
    wheel_block = re.search(r"const WHEEL_LABELS = \{([^}]*)\}", js).group(1)
    wheel = re.findall(r"(\w+):", wheel_block)
    return set(mouse), set(pad.keys()), set(wheel), pad


def binding_errors(spec, vocab, label):
    """校验一条绑定字符串，返回错误说明列表（空 = 合法）。"""
    mouse, pads, wheels, pad_idx = vocab
    errs = []
    if not isinstance(spec, str) or ":" not in spec:
        return ["不是字符串或缺冒号: %r" % (spec,)]
    device, _, body = spec.partition(":")
    device = device.strip().lower()
    body = body.strip()
    if not body:
        return ["设备体为空: %r" % spec]
    if device == "key":
        parts = body.split("+")
        name = parts.pop()
        if not name:
            errs.append("键名为空: %r" % spec)
        order = []
        for p in parts:
            p = p.strip().lower()
            if p not in ("ctrl", "alt", "shift", "meta"):
                errs.append("未知修饰键 %r：%r" % (p, spec))
            order.append(p)
        fixed = [m for m in ("ctrl", "alt", "shift", "meta") if m in order]
        if order != fixed:
            errs.append("修饰键顺序不符（应为 ctrl+alt+shift+meta）: %r" % spec)
        if name != "space" and len(name) == 1 and name != name.lower():
            errs.append("单字符键名必须小写: %r" % spec)
        if name.strip() == "" or name != name.strip():
            errs.append("键名含空白或为空: %r" % spec)
    elif device == "mouse":
        if body.lower() not in mouse:
            errs.append("未知鼠标键 %r：%r" % (body, spec))
    elif device == "wheel":
        if body.lower() not in wheels:
            errs.append("未知滚轮方向 %r：%r" % (body, spec))
    elif device == "pad":
        b = body.lower()
        if b not in pads and not (b.isdigit() and 0 <= int(b) < 32):
            errs.append("未知手柄按钮 %r：%r" % (body, spec))
    else:
        errs.append("未知设备 %r：%r" % (device, spec))
    return errs


def doc_action_rows(doc):
    """docs/输入与按键.md 第 2 节动作表 → [{id, cells}]。"""
    m = re.search(r"^## 2\. 动作表\s*$(.*?)^#{2,3} ", doc, re.M | re.S)
    if not m:
        return []
    rows = []
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        mid = re.match(r"^`([A-Za-z][A-Za-z0-9]*)`$", cells[0]) if cells else None
        if mid:
            rows.append({"id": mid.group(1), "cells": cells})
    return rows


def registrations(js):
    """engine.js / script.js 里注册到输入系统的动作名。"""
    names = set()
    for m in re.finditer(r'\bregister\(\s*"([A-Za-z][A-Za-z0-9]*)"', js):
        names.add(m.group(1))
    for m in re.finditer(r'\bregisterAvailability\(\s*"([A-Za-z][A-Za-z0-9]*)"', js):
        names.add(m.group(1))
    for m in re.finditer(r"registerAll\(\{", js):
        block = brace_block(js, "registerAll({")
        for k in re.finditer(r"^\s*([A-Z][A-Za-z0-9]*)\s*:", block, re.M):
            names.add(k.group(1))
    return names


# ---------------------------------------------------------------- 测试

def test_input_action_map():
    js_raw = read(INPUT_JS)
    js = strip_comments(js_raw)
    theme = json.loads(read(THEME_JSON))
    settings = read(SETTINGS_JS)
    doc = read(DOC)
    html = read(INDEX_HTML)
    css = read(RADIAL_CSS)
    engine = read(ENGINE_JS)
    script = read(SCRIPT_JS)
    # 判「代码里有没有某段」一律用剥注释后的版本：说明性注释常原样引用被要求的写法，
    # 不剥的话断言会被注释里的影子字面量满足（2026-09-29 就在 confirmPopup 上中过一次）。
    engine_code = strip_comments(engine)
    script_code = strip_comments(script)

    acts = actions_from_js(js)
    ids = list(acts.keys())
    vocab = vocab_from_js(js)

    print("\n[A] 动作表")
    check(len(ids) >= 20, "动作表非空且规模合理（%d 个）" % len(ids))
    check(len(ids) == len(set(ids)), "动作 id 唯一")
    check(all(re.match(r"^[A-Z][A-Za-z0-9]*$", i) for i in ids), "动作 id 为大驼峰")
    check(all(acts[i]["priority"] is not None for i in ids), "每个动作都写了 priority（决定派发顺序）")
    check(acts.get("Cancel", {}).get("priority") == 100 and acts.get("Confirm", {}).get("priority") == 100,
          "Cancel / Confirm 优先级最高（100），才能先于 Advance 拿回车与 Esc")
    check(acts.get("Advance", {}).get("priority", 0) < 100, "Advance 优先级低于确认类动作")
    check(acts.get("FastForward", {}).get("hold") is True, "FastForward 是「按住生效」")
    check(acts.get("ScrollBack", {}).get("wheelOnly") is True and acts.get("ScrollForward", {}).get("wheelOnly") is True,
          "回看上下滚是「仅滚轮」动作（受 wheelReview 设置项控制）")

    print("\n[B] 文档动作表与代码一致")
    rows = doc_action_rows(doc)
    check(bool(rows), "能解析出文档动作表（%d 行）" % len(rows))
    doc_ids = [r["id"] for r in rows]
    check(set(doc_ids) == set(ids), "文档动作表与 ACTIONS 的 id 集合相同（缺失 %s / 多余 %s）"
          % (sorted(set(ids) - set(doc_ids)), sorted(set(doc_ids) - set(ids))))
    mismatch = []
    for r in rows:
        a = acts.get(r["id"])
        if not a or len(r["cells"]) < 7:
            continue
        cell = r["cells"]
        if cell[3] != str(a["priority"]):
            mismatch.append("%s priority 文档 %s ≠ 代码 %s" % (r["id"], cell[3], a["priority"]))
        if (cell[4] == "✓") != a["hold"]:
            mismatch.append("%s 按住列与 hold 不一致" % r["id"])
        if (cell[5] == "✓") != a["wheelOnly"]:
            mismatch.append("%s 仅滚轮列与 wheelOnly 不一致" % r["id"])
        if cell[2] != a["short"]:
            mismatch.append("%s 短名 文档 %s ≠ 代码 %s" % (r["id"], cell[2], a["short"]))
    check(not mismatch, "文档逐行匹配 priority / 按住 / 仅滚轮 / 短名（%s）" % ("；".join(mismatch[:4]) or "全部一致"))

    print("\n[C] 配置合法性")
    inp = theme.get("input") or {}
    presets = inp.get("presets") or []
    check(bool(presets), "模板提供了推荐方案（%d 套）" % len(presets))
    pids = [p.get("id") for p in presets]
    check(inp.get("default") in pids, "input.default（%r）指向存在的方案 %s" % (inp.get("default"), pids))
    bad_actions, bad_bindings = [], []
    for p in presets:
        for aid, binds in (p.get("bindings") or {}).items():
            if aid not in acts:
                bad_actions.append("%s.%s" % (p.get("id"), aid))
            check_list = binds if isinstance(binds, list) else [binds]
            for b in check_list:
                for e in binding_errors(b, vocab, aid):
                    bad_bindings.append("%s.%s: %s" % (p.get("id"), aid, e))
    check(not bad_actions, "推荐方案里的动作 id 都在 ACTIONS 里（%s）" % ("；".join(bad_actions[:4]) or "全部合法"))
    check(not bad_bindings, "推荐方案里的绑定字符串都合法（%s）" % ("；".join(bad_bindings[:4]) or "全部合法"))
    default_binds = next((p.get("bindings") or {} for p in presets if p.get("id") == inp.get("default")), {})
    mismatch = []
    for r in rows:
        if len(r["cells"]) < 7:
            continue
        cell = r["cells"][6]
        want = [] if cell == "无" else re.findall(r"`([^`]+)`", cell)
        got = default_binds.get(r["id"], [])
        if want != got:
            mismatch.append("%s 文档 %s ≠ 配置 %s" % (r["id"], want, got))
    check(not mismatch, "文档「默认方案绑定」列与 theme.json 一致（%s）" % ("；".join(mismatch[:3]) or "全部一致"))

    print("\n[D] 设置页与接线")
    spec_keys = set(re.findall(r"^\s*([A-Za-z][A-Za-z0-9]*):\s*\{", brace_block(settings, "const SPECS = {"), re.M))
    sections = ((theme.get("pages") or {}).get("settings") or {}).get("sections") or []
    check(bool(sections), "模板 pages.settings.sections 已给出默认版面（%d 个分区）" % len(sections))
    unknown = []
    keymap_blocks = 0
    for sec in sections:
        for item in (sec.get("items") or []):
            if item.get("type") == "keymap":
                keymap_blocks += 1
                continue
            k = item.get("key")
            if k and k not in spec_keys:
                unknown.append(k)
    check(not unknown, "sections 引用的设置项都已在 SPECS 登记（%s）" % ("、".join(sorted(set(unknown))) or "全部已登记"))
    check(keymap_blocks >= 1, "sections 含按键映射区块（type: keymap）")
    for k in ("wheelReview", "radialEnabled", "radialHoldMs",
              "radialUp", "radialRight", "radialDown", "radialLeft", "radialCenter"):
        check(k in spec_keys, "设置项 %s 已在 SPECS 登记" % k)
    radial_defs = {k: (re.search(r'%s:\s*\{[^}]*def:\s*"([^"]+)"' % k, brace_block(settings, "const SPECS = {")) or [None, None])[1]
                   for k in ("radialUp", "radialRight", "radialDown", "radialLeft", "radialCenter")}
    check(all(v in acts for v in radial_defs.values()),
          "轮盘五向的默认动作都是合法动作（%s）" % radial_defs)
    check("aliceadv-radial" in js, "轮盘容器 id 在 input.js 里定义")

    print("\n[E] 接线与几何")
    order = {}
    for m in re.finditer(r'<script src="(style/[^"]+)"', html):
        order[m.group(1)] = m.start()
    for need in ("style/input.js", "style/theme.js", "style/script.js", "style/engine.js"):
        check(need in order, "index.html 加载 %s" % need)
    check(order.get("style/input.js", 1 << 30) < order.get("style/theme.js", -1),
          "input.js 在 theme.js 之前加载（设置页要用它渲染按键映射）")
    check(order.get("style/input.js", 1 << 30) < order.get("style/script.js", -1)
          and order.get("style/input.js", 1 << 30) < order.get("style/engine.js", -1),
          "input.js 在 script.js / engine.js 之前加载（它们要向它注册处理器）")
    check('href="style/pages/radial.css"' in html, "index.html 加载 style/pages/radial.css")
    check("AliceADVInput.init()" in html, "启动流程调用 AliceADVInput.init()")
    # 轮盘几何：外直径固定在「画面高度的 30%」，其余半径按比例派生；
    # input.js 量元素把生效尺寸取回来用。
    # 历史上两边各写一个数（JS 判定 56 / CSS 排布 64），于是出现「看着够到圆环了却没选中」。
    css_code = strip_comments(css)

    def css_var(name):
        m = re.search(r"--" + re.escape(name) + r"\s*:\s*([^;]+);", css_code)
        return m.group(1).strip() if m else None

    def calc_ratio(name, base):
        """从 `--name: calc(var(--base) * 0.55)` 里取出比例 0.55。"""
        v = css_var(name) or ""
        m = re.search(r"calc\(\s*var\(--" + re.escape(base) + r"\)\s*\*\s*(\d+(?:\.\d+)?)\s*\)", v)
        return float(m.group(1)) if m else None

    d_expr = css_var("radial-d")
    m_d = re.match(r"^(\d+(?:\.\d+)?)vh$", d_expr or "")
    check(bool(m_d) and abs(float(m_d.group(1)) - 30) < 1e-6,
          "整个圆环的外直径 = 画面高度的 30%%（--radial-d: %s）" % d_expr)
    check("var(--radial-d)" in (css_var("radial-r-out") or ""),
          "外半径由 --radial-d 派生（--radial-r-out: %s）" % css_var("radial-r-out"))
    ratio_in = calc_ratio("radial-r-in", "radial-r-out")
    ratio_center = calc_ratio("radial-center-d", "radial-r-out")
    check(ratio_in is not None and 0 < ratio_in < 1,
          "内半径 = 外半径 × %s（差额即环的厚度，也是 border 的宽度）" % ratio_in)
    check(ratio_center is not None and 0 < ratio_center <= 1,
          "中心圆直径 = 外半径 × %s" % ratio_center)
    if ratio_in and ratio_center:
        clear = ratio_in - ratio_center / 2
        check(clear >= 0.2,
              "中心与环内缘的净空隙 = 外半径的 %.2f ≥ 0.2（贴太近会和环连成一坨）" % clear)
    check(not re.search(r"--radial-(d|r-out|r-in|center-d)\s*:\s*-?\d+(?:\.\d+)?px", css_code),
          "轮盘半径不得写死成 px（必须由画面高度派生，否则换窗口 / 换分辨率就不成比例）")
    check("clamp(" in css_code,
          "标签字号随轮盘尺寸缩放（clamp，带可读下限），不是写死的 px")

    check(not re.search(r"ring\s*:\s*\d+", js),
          "input.js 不再自己写死判定半径（半径的唯一来源是 radial.css）")
    # 判「有没有那段代码」先剥注释：说明性注释会原样引用被禁掉 / 要求的那段写法
    js_code = strip_comments(js)
    check('".radial__edge--in"' in js_code and "offsetWidth" in js_code,
          "input.js 量元素（offsetWidth）取半径：calc 表达式 parseFloat 读不出来，会静默退回兜底值")
    check("function radialSize" in js, "input.js 有取几何的函数 radialSize()")

    # 四个方向＝四个 1/4 圆环：各占 90°，各涂一条边，靠 --radial-rot 分工
    rots = sorted(re.findall(r"--radial-rot\s*:\s*(\d+)deg", css_code), key=int)
    sides = sorted(re.findall(r"border-(top|right|bottom|left)-color\s*:\s*var\(--sector\)", css_code))
    check(rots == ["0", "90", "180", "270"],
          "四个方向各占 90°（--radial-rot = %s）" % "/".join(rots))
    check(sides == ["bottom", "left", "right", "top"],
          "四个方向各涂一条边＝四个 1/4 圆环（%s）" % "/".join(sides))
    check("border-radius: 50%" in css_code, "圆环靠「方框 + border-radius: 50%」成圆")
    check(re.search(r"--radial-gap\s*:\s*[1-9]", css_code) is not None and "conic-gradient" in css_code,
          "相邻两个 1/4 环之间留了缝（conic-gradient 面罩 + --radial-gap > 0）")
    check(".radial__edge--out" in css_code and ".radial__edge--in" in css_code,
          "环的内缘 / 外缘各描了一圈细线（只靠填充色看不出这是被分段的整环）")
    check('"radial__edge radial__edge--"' in js, "input.js 会创建那两圈细线的元素")

    # 松手时不执行置灰的格子
    close_body = function_body(js, "closeRadial")
    check(bool(close_body), "能定位 input.js 的 closeRadial")
    check("available(" in close_body,
          "轮盘松手时不执行 is-disabled 的格子（画成灰的却又照常触发＝自相矛盾）")

    print("\n[F] 每个动作都有人注册处理器（死动作守卫）")
    reg = registrations(engine_code) | registrations(script_code) | registrations(js)
    orphans = sorted(set(ids) - reg)
    check(not orphans, "ACTIONS 里的动作都能找到处理器（%s）" % ("、".join(orphans) or "全部已注册"))
    unknown_reg = sorted(reg - set(ids))
    check(not unknown_reg, "注册用的动作名都合法（拼错会被静默忽略）（%s）" % ("、".join(unknown_reg) or "全部合法"))

    print("\n[G] 两个已修 bug 的形状守卫")
    # G1 空格键：判空格必须在 trim() 之前
    body = function_body(js, "normalizeKeyName")
    check(bool(body), "能定位 normalizeKeyName 的函数体")
    i_space = body.find('=== " "')
    i_trim = body.find(".trim()")
    check(i_space != -1, 'normalizeKeyName 保留了空格判定（=== " "）')
    check(i_space != -1 and i_trim != -1 and i_space < i_trim,
          "空格判定在 trim() 之前（先 trim 会让 String(\" \").trim() 变成空串、判定成死代码，key:space 永不匹配）")
    # G2 回车：确认框判据必须是 is-active
    popup = function_body(engine_code, "confirmPopup")
    check(bool(popup), "能定位 engine.js 的 confirmPopup")
    check("is-active" in popup,
          "confirmPopup 以 .is-active 判断「浮层真的开着」（退出确认框常驻页面，只按 DOM 里存在按钮判会永远吞掉回车）")
    check("#popup_quitQuery [data-popup-confirm]" not in popup,
          "confirmPopup 不再只按「DOM 里存在那个按钮」下判断")
    # G3 舞台推进与 Esc 只在输入系统一处，避免同一次点击 / 按键被处理两次
    check(not re.search(r'addEventListener\(\s*["\']key\w*["\']', engine_code),
          "engine.js 不再挂 keydown 监听（Esc 与推进都改由输入系统的绑定承担）")
    check(".next(" not in engine_code,
          "engine.js 不直接调用 next()（推进只经 Advance 动作，避免同一次点击推进两次）")


def main():
    print("=" * 70)
    print("输入系统静态自洽测试")
    print("=" * 70)
    test_input_action_map()
    print("\n" + "=" * 70)
    if _failures:
        print("✗ 失败 %d 项：" % len(_failures))
        for f in _failures:
            print("  - " + f)
        return 1
    print("✓ 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
