#!/usr/bin/env python3
# =========================================================
# aliceADV 工具 — Ren'Py 剧本 (.rpy) → aliceADV 剧本 (JSON)
#
# 解析 Ren'Py web 构建里的 game/script.rpy（可读源码），生成 aliceADV 的：
#   - characters.json   角色档案（含 per-character 对话框、表情立绘、名字颜色）
#   - chapters.json     剧本目录（单章即可，含 playOrder）
#   - ch1.json          章节剧本（段 segments，指令序列）
#
# 支持的 Ren'Py 语法（本工具覆盖范围，足以搬运常见线性/轻分支 VN）：
#   define X = Character('名', color="#..", image="..", window_background="images/.._tb.png")
#   label start:  ...  return
#   scene NAME [with fade]                  -> scene { src, transition }   (bg 为兼容别名)
#   show NAME [at left|center|right] [with fade]   -> show { char|src, sprite?, at, transition }
#   hide NAME [with fade]                   -> hide { char|src, transition }
#   pause N                                 -> wait { seconds }
#   play music "audio/.." [loop|noloop] [fadein N] [volume V]  -> music { src, loop?, fade?, volume? }
#   play sound "audio/.." [volume V]        -> sound { src, volume? }
#   voice "audio/.." / play voice "audio/.." -> voice { src }   (或绑到下一句 say 的 voice 字段)
#   stop music / stop sound [fadeout N]     -> stop { what, fade? }
#   X "文本"                                -> say (角色) / narrate (narrator_adv) / narrate mode=nvl (narrator_nvl)
#   extend "文本"                          -> say { text, append: true }  （续说，沿用上一说话角色；{w}/{w=N} 标签原样透传）
#   文本内 {w} / {w=0.6}                     -> 行内停顿（aliceADV 原生支持，原样保留）
#   nvl clear                               -> nvlclear
#   default x = 0                           -> 脚本根 vars（变量初始值）
#   $ x = 1 / $ x += 1 / $ x -= 1           -> set { var, op, value }
#   jump LABEL                              -> goto { segment: LABEL }
#   if EXPR:                                -> if { test }  （and/or/not -> &&/||/!）
#   menu: + "选项": + jump/($ set)          -> decide { options:[{text, goto, set?}] }
#
# 用法：
#   aliceadv rpy2adv <script.rpy> <images_dir> <out_story_dir>
#     script.rpy    : Ren'Py 脚本源（含可读 .rpy）
#     images_dir    : 该游戏的图片目录（用于发现角色表情立绘文件名 -> sprite key）
#     out_story_dir : 输出目录（通常是 某工程/story/）
# =========================================================
import json
import os
import re
import sys

# 剧本里的旁白角色（空名 / 整屏 NVL）
NVL_NARRATOR = "narrator_nvl"
ADV_NARRATOR = "narrator_adv"


def strip_comment(line):
    r"""去掉行内 # 注释，但不动引号内的 #（demo 文本里有 #\%^$ 之类的乱码）。"""
    out = []
    in_str = False
    quote = ""
    i = 0
    while i < len(line):
        ch = line[i]
        if in_str:
            out.append(ch)
            if ch == quote:
                in_str = False
        else:
            if ch in ("'", '"'):
                in_str = True
                quote = ch
                out.append(ch)
            elif ch == "#":
                break  # 注释开始
            else:
                out.append(ch)
        i += 1
    return "".join(out).rstrip()


def split_args(args):
    """按顶层逗号切分实参串（忽略引号内与括号内的逗号）。"""
    out, buf, depth, in_str, quote = [], [], 0, False, ""
    for ch in args:
        if in_str:
            buf.append(ch)
            if ch == quote:
                in_str = False
            continue
        if ch in ("'", '"'):
            in_str, quote = True, ch
            buf.append(ch)
        elif ch in "([{":
            depth += 1
            buf.append(ch)
        elif ch in ")]}":
            depth -= 1
            buf.append(ch)
        elif ch == "," and depth == 0:
            out.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    if buf:
        out.append("".join(buf).strip())
    return [a for a in out if a]


def parse_define(line):
    """parse: define role1 = Character('友子', color="#6E5F59", image="role1", window_background="images/tomoko_tb.png")"""
    m = re.match(r"\s*define\s+(\w+)\s*=\s*Character\s*\((.*)\)\s*$", line, re.S)
    if not m:
        return None
    cid = m.group(1)
    args = m.group(2)
    # 名字 = 第一个位置实参。Character(None, ...) 表示「有对话框但不显示名字」，
    # 映射为空串（引擎里 name === "" 时隐藏名字条，与旁白 narrate 区分开）。
    name = ""
    parts = split_args(args)
    if parts and "=" not in parts[0].split("(")[0]:
        first = parts[0]
        if first != "None":
            nm = re.match(r"""^_?\(?\s*['"](.*)['"]\s*\)?$""", first, re.S)
            name = nm.group(1) if nm else first.strip("'\"")
    color_m = re.search(r"color\s*=\s*['\"]([^'\"]+)['\"]", args)
    color = color_m.group(1) if color_m else None
    tb_m = re.search(r"window_background\s*=\s*['\"]([^'\"]+)['\"]", args)
    window_bg = tb_m.group(1) if tb_m else None
    # kind（nvl/adv）— 仅记录，便于理解；运行时靠 narrate mode 区分
    kind_m = re.search(r"kind\s*=\s*(\w+)", args)
    kind = kind_m.group(1) if kind_m else "adv"
    return {
        "id": cid,
        "name": name,
        "color": color,
        "window_background": window_bg,
        "kind": kind,
    }


def discover_sprites(images_dir):
    """扫描图片目录，找出每个角色角色的表情立绘。
    规则：role1_h1.png -> 角色 role1 的 sprite key 'h1'，路径 images/char/role1/h1.png。"""
    sprites = {}  # cid -> { sprite_key: path }
    if not os.path.isdir(images_dir):
        return sprites
    for fn in os.listdir(images_dir):
        m = re.match(r"^(role\d+)_([^_].*)\.png$", fn)
        if not m:
            continue
        cid = m.group(1)
        key = m.group(2)
        sprites.setdefault(cid, {})[key] = f"images/char/{cid}/{key}.png"
    return sprites


def role_of(show_name):
    """'role1_h1' -> ('role1','h1')；'role2' -> ('role2', None)；'fsm' -> None(creature)"""
    m = re.match(r"^(role\d+)(?:_(.+))?$", show_name)
    if m:
        return m.group(1), (m.group(2) or None)
    return None, None


def lit(s):
    """把 Ren'Py 字面量解析为 Python 值（字符串/数字/布尔/None）。"""
    s = s.strip()
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        return s[1:-1]
    if s in ("True", "true"):
        return True
    if s in ("False", "false"):
        return False
    if s in ("None", "null"):
        return None
    try:
        return float(s) if "." in s else int(s)
    except ValueError:
        return s  # 无法识别：保留原串


def py_expr_to_adv(expr):
    """把 Ren'Py/Python 布尔表达式转成 aliceADV 表达式（and/or/not → &&/||/!）。"""
    e = expr.strip()
    e = re.sub(r"\band\b", "&&", e)
    e = re.sub(r"\bor\b", "||", e)
    e = re.sub(r"\bnot\b", "!", e)
    return e


def _indent(s):
    return len(s) - len(s.lstrip(" "))


def _gather_block(body_lines, i, n, base_ind):
    """收集缩进深于 base_ind 的连续行（空行也吸入），返回 (block_lines, next_i)。"""
    block = []
    while i < n:
        bl = body_lines[i]
        if not bl.strip():
            block.append(bl); i += 1; continue
        if _indent(bl) <= base_ind:
            break
        block.append(bl); i += 1
    return block, i


def _parse_if_chain(body_lines, i, n, vars):
    """解析 if/elif/else 链，把每个分支块里的指令都加上对应的 `if` 执行条件。

    由于 aliceADV 是扁平指令流，Ren'Py 的块结构被翻译为：块内每条指令附加
    `if:"<条件>"` 字段；else 分支用「前面条件之否定」组合，保证语义等价。"""
    cmds = []
    base_ind = _indent(body_lines[i])
    m = re.match(r"^\s*if\s+(.+):\s*$", body_lines[i].strip())
    cond = py_expr_to_adv(m.group(1))
    i += 1
    block, i = _gather_block(body_lines, i, n, base_ind)
    for c in (parse_body(block, vars) if block else []):
        if "if" not in c:
            c["if"] = cond
        cmds.append(c)
    prev_false = "!(" + cond + ")"
    while i < n and body_lines[i].strip() and _indent(body_lines[i]) == base_ind:
        sib = body_lines[i].strip()
        em = re.match(r"^elif\s+(.+):\s*$", sib)
        if em:
            c2 = py_expr_to_adv(em.group(1))
            i += 1
            block, i = _gather_block(body_lines, i, n, base_ind)
            econd = prev_false + " && (" + c2 + ")"
            for c in (parse_body(block, vars) if block else []):
                if "if" not in c:
                    c["if"] = econd
                cmds.append(c)
            prev_false = prev_false + " && !(" + c2 + ")"
            continue
        eem = re.match(r"^else\s*:\s*$", sib)
        if eem:
            i += 1
            block, i = _gather_block(body_lines, i, n, base_ind)
            for c in (parse_body(block, vars) if block else []):
                if "if" not in c:
                    c["if"] = prev_false
                cmds.append(c)
            break
        break
    return cmds, i


def parse_body(body_lines, vars=None):
    """把 label start 的正文行翻译成指令列表。"""
    cmds = []
    _vars = vars if vars is not None else {}
    last_char = None  # 追踪上一个说话角色，供 extend 续说沿用
    i = 0
    n = len(body_lines)
    while i < n:
        raw = body_lines[i]
        line = raw.strip()
        if not line:
            i += 1
            continue

        # 内联 with：scene X with fade
        m = re.match(r"^(scene|show|hide)\s+(\S+)\s+with\s+(\w+)$", line)
        inline_trans = None
        if m:
            inline_trans = m.group(3)
            line = f"{m.group(1)} {m.group(2)}"

        # 前瞻下一句是否有独立 with <trans>
        peek_trans = None
        j = i + 1
        while j < n and not body_lines[j].strip():
            j += 1
        if j < n:
            pm = re.match(r"^with\s+(\w+)$", body_lines[j].strip())
            if pm:
                peek_trans = pm.group(1)

        trans = inline_trans or peek_trans
        if trans and not inline_trans:
            i = j  # 消费掉独立的 with 行

        # ---- scene ----
        m = re.match(r"^scene\s+(\S+)$", line)
        if m:
            cmds.append({"cmd": "scene", "src": f"images/bg/{m.group(1)}.png",
                         **({"transition": trans} if trans else {})})
            i += 1
            continue

        # ---- show ----
        m = re.match(r"^show\s+(\S+)(?:\s+at\s+(left|center|right))?$", line)
        if m:
            name = m.group(1)
            at = m.group(2) or "center"
            cid, sprite = role_of(name)
            if cid:
                c = {"cmd": "show", "char": cid, "at": at}
                if sprite:
                    c["sprite"] = sprite
            else:
                c = {"cmd": "show", "src": f"images/char/{name}.png", "at": at}
            if trans:
                c["transition"] = trans
            cmds.append(c)
            i += 1
            continue

        # ---- hide ----
        m = re.match(r"^hide\s+(\S+)$", line)
        if m:
            name = m.group(1)
            cid, sprite = role_of(name)
            if cid:
                c = {"cmd": "hide", "char": cid}
            else:
                c = {"cmd": "hide", "src": f"images/char/{name}.png"}
            if trans:
                c["transition"] = trans
            cmds.append(c)
            i += 1
            continue

        # ---- pause ----
        m = re.match(r"^pause\s+([0-9]+(?:\.[0-9]+)?)$", line)
        if m:
            cmds.append({"cmd": "wait", "seconds": float(m.group(1))})
            i += 1
            continue

        # ---- play music / sound ----
        m = re.match(r'^play\s+music\s+["\']([^"\']+)["\'](.*)$', line)
        if m:
            c = {"cmd": "music", "src": m.group(1)}
            rest = m.group(2)
            if re.search(r"\bnoloop\b", rest):
                c["loop"] = False
            elif re.search(r"\bloop\b", rest):
                c["loop"] = True
            fm = re.search(r"fadein\s+([0-9]+(?:\.[0-9]+)?)", rest)
            if fm:
                c["fade"] = float(fm.group(1))
            vm = re.search(r"volume\s+([0-9]+(?:\.[0-9]+)?)", rest)
            if vm:
                c["volume"] = float(vm.group(1))
            cmds.append(c)
            i += 1
            continue
        m = re.match(r'^play\s+sound\s+["\']([^"\']+)["\'](.*)$', line)
        if m:
            c = {"cmd": "sound", "src": m.group(1)}
            vm = re.search(r"volume\s+([0-9]+(?:\.[0-9]+)?)", m.group(2))
            if vm:
                c["volume"] = float(vm.group(1))
            cmds.append(c)
            i += 1
            continue

        # ---- voice ----
        m = re.match(r'^(?:play\s+)?voice\s+["\']([^"\']+)["\']', line)
        if m:
            cmds.append({"cmd": "voice", "src": m.group(1)})
            i += 1
            continue

        # ---- stop sound / stop music ----
        m = re.match(r"^stop\s+(sound|music)(.*)$", line)
        if m:
            c = {"cmd": "stop", "what": m.group(1)}
            fm = re.search(r"fadeout\s+([0-9]+(?:\.[0-9]+)?)", m.group(2))
            if fm:
                c["fade"] = float(fm.group(1))
            cmds.append(c)
            i += 1
            continue

        # ---- nvl clear ----
        if re.match(r"^nvl\s+clear$", line):
            cmds.append({"cmd": "nvlclear"})
            i += 1
            continue

        # ---- 说话 / 旁白： NAME "文本" ----
        m = re.match(r'^(\w+)\s+"([^"]*)"$', line)
        if m:
            who = m.group(1)
            text = m.group(2)
            if who == NVL_NARRATOR:
                cmds.append({"cmd": "narrate", "mode": "nvl", "text": text})
            elif who == ADV_NARRATOR:
                cmds.append({"cmd": "narrate", "text": text})
            else:
                cmds.append({"cmd": "say", "char": who, "text": text})
                last_char = who
            i += 1
            continue

        # ---- extend "文本"（续说，对应 aliceADV append:true）----
        # Ren'Py 的 extend 把新文本追加到上一句；沿用上一个说话角色。
        # 文本里的 {w}/{w=N} 停顿标签原样透传（引擎原生支持）。
        m = re.match(r'^extend\s+"([^"]*)"$', line)
        if m:
            c = {"cmd": "say", "text": m.group(1), "append": True}
            if last_char:
                c["char"] = last_char
            cmds.append(c)
            i += 1
            continue

        # ---- default X = Y（变量初始值）----
        m = re.match(r"^\s*default\s+(\w+)\s*=\s*(.+)$", line)
        if m:
            _vars[m.group(1)] = lit(m.group(2))
            i += 1
            continue

        # ---- $ X = Y / X += Y / X -= Y（写变量 -> set）----
        m = re.match(r"^\s*\$\s*(.+)$", line)
        if m:
            expr = m.group(1).strip()
            am = re.match(r"(\w+)\s*\+=\s*(.+)$", expr)
            if am:
                cmds.append({"cmd": "set", "var": am.group(1), "op": "add", "value": lit(am.group(2))})
                i += 1; continue
            sm = re.match(r"(\w+)\s*-=\s*(.+)$", expr)
            if sm:
                cmds.append({"cmd": "set", "var": sm.group(1), "op": "sub", "value": lit(sm.group(2))})
                i += 1; continue
            eq = re.match(r"(\w+)\s*=\s*(.+)$", expr)
            if eq:
                cmds.append({"cmd": "set", "var": eq.group(1), "value": lit(eq.group(2))})
                i += 1; continue
            i += 1; continue

        # ---- jump LABEL ----
        m = re.match(r"^\s*jump\s+(\w+)$", line)
        if m:
            cmds.append({"cmd": "goto", "segment": m.group(1)})
            i += 1
            continue

        # ---- if / elif / else 块（条件分支；转为每块指令的 if 执行条件）----
        m = re.match(r"^\s*if\s+(.+):\s*$", line)
        if m:
            sub, i = _parse_if_chain(body_lines, i, n, _vars)
            cmds.extend(sub)
            continue

        # ---- menu:（选项分支 -> decide）----
        m = re.match(r'^\s*menu(?:\s+"[^"]*")?\s*(?:\(.*\))?\s*:\s*$', line)
        if m:
            opts = []
            i += 1
            while i < n and body_lines[i].strip():
                om = re.match(r'^"([^"]*)"\s*:\s*$', body_lines[i].strip())
                if not om:
                    break
                opt = {"text": om.group(1)}
                i += 1
                while i < n and body_lines[i].strip():
                    il = body_lines[i].strip()
                    jm = re.match(r"^\s*jump\s+(\w+)$", il)
                    if jm:
                        opt["goto"] = jm.group(1); i += 1; continue
                    dm = re.match(r"^\s*\$\s*(\w+)\s*=\s*(.+)$", il)
                    if dm:
                        opt.setdefault("set", []).append({"var": dm.group(1), "value": lit(dm.group(2))})
                        i += 1; continue
                    break
                opts.append(opt)
            if opts:
                cmds.append({"cmd": "decide", "options": opts})
            continue

        # 其它（transform / label 等）— 跳过
        i += 1

    return cmds


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if len(argv) < 3:
        print("用法: aliceadv rpy2adv <script.rpy> <images_dir> <out_story_dir>")
        return 1
    rpy_path, images_dir, out_dir = argv[0], argv[1], argv[2]

    with open(rpy_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    # 收集 define
    char_defs = {}
    for ln in lines:
        s = strip_comment(ln)
        d = parse_define(s)
        if d:
            char_defs[d["id"]] = d

    # 收集 default 变量初始值
    vars = {}
    for ln in lines:
        s = strip_comment(ln)
        dm = re.match(r"^\s*default\s+(\w+)\s*=\s*(.+)$", s)
        if dm:
            vars[dm.group(1)] = lit(dm.group(2))

    # 发现角色表情立绘
    sprites = discover_sprites(images_dir)

    # 截取 label start: ... return
    body_start = None
    for idx, ln in enumerate(lines):
        if re.match(r"^\s*label\s+start\s*:\s*$", ln):
            body_start = idx + 1
            break
    if body_start is None:
        print("✗ 未找到 label start:")
        return 1
    # 正文到第一个顶格/4空格的 return 为止
    body = []
    for ln in lines[body_start:]:
        if re.match(r"^\s*return\s*$", ln):
            break
        body.append(strip_comment(ln))

    cmds = parse_body(body, vars)

    # 组装 characters.json
    characters = {}
    for cid, d in char_defs.items():
        entry = {"name": d["name"], "color": d["color"]}
        if d["window_background"]:
            # images/xxx_tb.png -> gui/textbox/xxx_tb.png
            base = os.path.basename(d["window_background"])
            entry["textbox"] = f"gui/textbox/{base}"
        sp = sprites.get(cid)
        if sp:
            entry["sprites"] = sp
        characters[cid] = entry

    # chapters.json
    chapters = {
        "chapters": [
            {"idx": "01", "title": "脱出轨道的女孩们", "desc": "移植自 Ren'Py demo：girls_out_of_orbit",
             "locked": False, "script": "story/ch1.json"}
        ],
        "playOrder": ["ch1"],
        "branches": [],
        "gallery": []
    }

    # ch1.json
    ch1 = {
        "id": "ch1",
        "title": "脱出轨道的女孩们",
        "start": "start",
        "segments": {
            "start": cmds
        }
    }
    if vars:
        ch1["vars"] = vars

    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "characters.json"), "w", encoding="utf-8") as f:
        json.dump(characters, f, ensure_ascii=False, indent=2)
    with open(os.path.join(out_dir, "chapters.json"), "w", encoding="utf-8") as f:
        json.dump(chapters, f, ensure_ascii=False, indent=2)
    with open(os.path.join(out_dir, "ch1.json"), "w", encoding="utf-8") as f:
        json.dump(ch1, f, ensure_ascii=False, indent=2)

    print(f"✓ 转换完成")
    print(f"  角色: {len(characters)} 个（含表情立绘: {sum(1 for c in characters.values() if c.get('sprites'))} 个）")
    print(f"  指令: {len(cmds)} 条")
    print(f"  输出: {out_dir}/{{characters,chapters,ch1}}.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
