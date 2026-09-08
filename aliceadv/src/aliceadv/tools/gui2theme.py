#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gui2theme.py — Ren'Py gui.rpy → aliceADV theme.json 的「布局翻译器」

为什么要有这个工具：
    移植 Ren'Py 游戏时，对话框高度、正文位置、名字条位置、字号等都由 gui.rpy
    里的几何参数决定。手工照抄这些数字极易出错（也难以复核），因此改为由编译器
    从 gui.rpy 直接翻译进 theme.json，保证「单一真相源」。

    与 rpy2adv.py（剧本转换）配套使用：
        aliceadv rpy2adv  script.rpy  <images_dir>  <工程>/story
        aliceadv gui2theme gui.rpy  <工程>/theme.json --apply

用法：
    aliceadv gui2theme <gui.rpy> <theme.json>            # 只预览换算结果
    aliceadv gui2theme <gui.rpy> <theme.json> --apply    # 写回 theme.json

换算规则（相对设计分辨率 W x H，取自 gui.init）：
    textbox_height   → layout.dialogue.height   = h / H
    textbox_yalign   → layout.dialogue.bottom   （1.0 贴底 → 0）
    dialogue_xpos    → layout.dialogue.padX     = xpos / W（百分比）
    dialogue_ypos    → layout.dialogue.padTop   = ypos px（设计像素，正文顶对齐）
    name_xpos/ypos   → layout.name.left / top   （相对文本框）
    nvl_thought_*    → layout.nvl.left / width
    choice_button_width / choice_spacing → layout.choice.width / gap
    text_size / name_text_size / choice_button_text_size → sizes.*
"""
import json
import os
import re
import sys


def parse_gui_rpy(path):
    """抽取 gui.rpy 里的几何与字号定义，返回 dict。"""
    src = open(path, "r", encoding="utf-8").read()
    vals = {}

    # 设计分辨率：gui.init(1920, 1080)
    m = re.search(r"gui\.init\(\s*(\d+)\s*,\s*(\d+)\s*\)", src)
    vals["W"] = int(m.group(1)) if m else 1920
    vals["H"] = int(m.group(2)) if m else 1080

    # define gui.xxx = 数字 / 字符串（字符串支持 gui.yyy 引用，稍后解引用）
    for m in re.finditer(r"^\s*define\s+gui\.(\w+)\s*=\s*([^\n#]+)", src, re.M):
        key, raw = m.group(1), m.group(2).strip().rstrip(",")
        if raw in ("None", "True", "False"):
            vals[key] = None if raw == "None" else (raw == "True")
            continue
        num = re.fullmatch(r"-?\d+(?:\.\d+)?", raw)
        if num:
            v = float(raw)
            vals[key] = int(v) if v.is_integer() else v
        elif raw.startswith(("'", '"')):
            vals[key] = raw.strip("'\"")
        else:
            # 形如 `= gui.text_size` / `= Borders(...)` 的引用或表达式：
            # 先原样保存，稍后对 gui.xxx 引用做解引用。
            vals[key] = raw
    # 解引用 choice_button_text_size = gui.text_size 之类
    for k, v in list(vals.items()):
        if isinstance(v, str) and v.startswith("gui."):
            vals[k] = vals.get(v[4:])
    return vals


def pct(x, W, nd=4):
    """像素 → 百分比字符串（相对设计宽度）。"""
    return ("%." + str(nd) + "f%%") % (x * 100.0 / W)


def ratio(x, H):
    """像素 → 0~1 相对值（相对设计高度）。"""
    return round(x * 1.0 / H, 6)


def align_word(a):
    return "left" if a < 0.34 else ("center" if a <= 0.66 else "right")


def compute_layout(g):
    """把 gui 参数翻译为 theme.json 的 layout / sizes 片段。"""
    W, H = g["W"], g["H"]
    out = {"layout": {}, "sizes": {}}

    # ---- 对话框 ----
    h = g.get("textbox_height", 278)
    yalign = g.get("textbox_yalign", 1.0)
    d = {"height": ratio(h, H), "width": 1.0, "left": 0.0}
    if yalign >= 1.0:
        d["bottom"] = 0.0
    else:
        top = yalign * (H - h)
        d["bottom"] = round((H - h - top) / H, 6)
    xpos = g.get("dialogue_xpos", 0)
    d["padX"] = pct(xpos, W)
    d["padTop"] = "%dpx" % g.get("dialogue_ypos", 0)
    d["padBottom"] = "0.5em"
    d["justify"] = "flex-start"          # ypos 自顶部起算，故顶对齐
    d["textAlign"] = align_word(g.get("dialogue_text_xalign", 0.0))
    out["layout"]["dialogue"] = d

    # ---- 名字条（相对文本框） ----
    out["layout"]["name"] = {
        "left": pct(g.get("name_xpos", 0), W),
        "top": pct(g.get("name_ypos", 0), max(h, 1)),
        "align": align_word(g.get("name_xalign", 0.0)),
    }

    # ---- NVL 整屏旁白 ----
    if "nvl_thought_xpos" in g:
        out["layout"]["nvl"] = {
            "left": pct(g["nvl_thought_xpos"], W),
            "width": pct(g.get("nvl_thought_width", W), W),
            "lineGap": "%dpx" % g.get("nvl_spacing", 15),
            "justify": "center",
            "textAlign": align_word(g.get("nvl_thought_xalign", 0.0)),
        }

    # ---- 选项条 ----
    if "choice_button_width" in g:
        out["layout"]["choice"] = {
            "width": ratio(g["choice_button_width"], W),
            "maxWidth": pct(g["choice_button_width"], W),
            "gap": "%dpx" % g.get("choice_spacing", 12),
        }

    # ---- 字号 ----
    if "text_size" in g:
        out["sizes"]["text"] = g["text_size"]
    if "name_text_size" in g:
        out["sizes"]["name"] = g["name_text_size"]
    if "choice_button_text_size" in g:
        out["sizes"]["choice"] = g["choice_button_text_size"]
    if "interface_text_size" in g:
        out["sizes"]["interface"] = g["interface_text_size"]
    return out


def merge(theme, computed, src_name="gui.rpy"):
    """把换算结果并入 theme.json（保留其它字段，只覆盖 layout/sizes 中算出的项）。"""
    for section, items in computed.items():
        target = theme.setdefault(section, {})
        for k, v in items.items():
            if isinstance(v, dict):
                sub = target.setdefault(k, {})
                sub.update(v)
                sub["_comment"] = "由 aliceadv gui2theme 从 %s 自动换算" % src_name
            else:
                target[k] = v
    theme.setdefault("layout", {}).setdefault("_comment",
                                              "本段由 aliceadv gui2theme 从 %s 换算生成" % src_name)
    return theme


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    args = [a for a in argv if not a.startswith("--")]
    apply_ = "--apply" in argv
    if len(args) < 2:
        print(__doc__)
        print("! 参数不足")
        return 1
    gui_path, theme_path = args[0], args[1]
    if not os.path.isfile(gui_path):
        print("! gui.rpy 不存在:", gui_path)
        return 1
    g = parse_gui_rpy(gui_path)
    computed = compute_layout(g)
    print("✓ 解析 %s  设计分辨率 %dx%d" % (os.path.basename(gui_path), g["W"], g["H"]))
    print(json.dumps(computed, ensure_ascii=False, indent=2))
    if not apply_:
        print("\n（预览模式，未写入。加 --apply 写入 %s）" % theme_path)
        return 0
    if not os.path.isfile(theme_path):
        print("! theme.json 不存在:", theme_path)
        return 1
    theme = json.load(open(theme_path, "r", encoding="utf-8"))
    merge(theme, computed, os.path.basename(gui_path))
    with open(theme_path, "w", encoding="utf-8") as f:
        json.dump(theme, f, ensure_ascii=False, indent=4)
        f.write("\n")
    print("\n✓ 已写入", theme_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
