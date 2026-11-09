#!/usr/bin/env python3
"""文字显示速度（info.json 的 textCps）的不变量（静态守卫 + 配置合并实测）。

守的是三件事：
  1. 默认值只写在模板 info.json 一处，运行时读配置、不再有写死的 ms/字；
  2. textCps 为 0 时真的走「整行一次出现」分支，且不启动任何定时器；
  3. 作者配置与玩家设置分两层，字段、文档、设置页三者口径一致。

跑法：PYTHONPATH=aliceadv/src python3 aliceadv/tests/test_text_display.py
"""
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.normpath(os.path.join(HERE, "..", "src"))
sys.path.insert(0, PKG)

TPL = os.path.normpath(os.path.join(PKG, "aliceadv", "template"))
DOCS = os.path.normpath(os.path.join(HERE, "..", "..", "docs"))
INFO_JSON = os.path.join(TPL, "info.json")
SCRIPT_JS = os.path.join(TPL, "style", "script.js")
SETTINGS_JS = os.path.join(TPL, "style", "settings.js")
THEME_JSON = os.path.join(TPL, "theme.json")

failures = []
notes = []


def check(ok, ok_msg, bad_msg):
    if ok:
        notes.append("✓ " + ok_msg)
    else:
        failures.append("✗ " + bad_msg)
    return ok


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def strip_comments(s):
    """判代码片段/顺序前先剥注释：说明性注释会原样引用代码字面量。"""
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    return re.sub(r"//[^\n]*", "", s)


def body_of(src, name):
    """按大括号配对取函数体（含嵌套）；找不到返回 None。"""
    m = re.search(r"function\s+" + name + r"\s*\(", src)
    if not m:
        return None
    i = src.find("{", m.end())
    if i < 0:
        return None
    depth = 0
    for j in range(i, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[i + 1:j]
    return None


def main():
    info = json.loads(read(INFO_JSON))
    script = strip_comments(read(SCRIPT_JS))
    settings = strip_comments(read(SETTINGS_JS))
    theme = json.loads(read(THEME_JSON))

    # [1] 模板 info.json 是默认值的唯一书写位置，且与运行时最后兜底一致
    cps = info.get("textCps")
    check(isinstance(cps, (int, float)) and cps >= 0,
          "模板 info.json 定义了合法的 textCps（%s）" % cps,
          "模板 info.json 缺少合法 textCps，工程省略该字段时没有默认值")
    m = re.search(r"const\s+TEXT_CPS_FALLBACK\s*=\s*([\d.]+)", script)
    check(bool(m) and float(m.group(1)) == float(cps or 0),
          "运行时最后兜底 TEXT_CPS_FALLBACK 与模板 info.json 同值",
          "运行时兜底与模板默认值不一致（两处真值源会漂移）")

    # [2] 打字间隔来自配置，不再有写死的 ms/字
    check(re.search(r"const\s+TYPE_SPEED", script) is None,
          "写死的 TYPE_SPEED 常量已移除",
          "TYPE_SPEED 仍在，textCps 改了也不会生效")
    typer_ms = body_of(script, "typeIntervalMs")
    check(bool(typer_ms) and 'cfgNum("textCps"' in typer_ms,
          "typeIntervalMs() 从 info.json 读 textCps",
          "typeIntervalMs() 没有读 info.json 的 textCps")
    check(bool(typer_ms) and "AliceADVSettings" in typer_ms and "textSpeed" in typer_ms,
          "typeIntervalMs() 叠加设置页 textSpeed 倍率",
          "玩家设置没有接到文字速度上")
    check(bool(typer_ms) and re.search(r"if\s*\(!\(base\s*>\s*0\)\)\s*return\s+0", typer_ms),
          "textCps 为 0 时返回 0（整行一次出现）",
          "textCps 为 0 没有落到整行显示的判据")

    # [3] 整行分支：写全文、不启动定时器、不再进入 typeSeg
    run = body_of(script, "runTyper")
    check(bool(run) and "state.typeMs = typeIntervalMs()" in run,
          "runTyper() 每句重算本句间隔",
          "runTyper() 没有把配置换算成本句间隔")
    if run:
        instant = re.search(r"if\s*\(!state\.typeMs\)\s*\{", run)
        check(bool(instant),
              "runTyper() 有整行一次出现的分支",
              "缺少整行一次出现的分支，textCps:0 会退化成 0ms 定时器")
        if instant:
            block = run[instant.end():]
            block = block[:block.find("}")] if "}" in block else block
            check("node.dataset.full" in block and "node.textContent = node.dataset.full" in block,
                  "整行分支把全文写进文本框（dataset.full 供 append / 回溯使用）",
                  "整行分支没有写全文，append 续说会丢前缀")
            check(re.search(r"state\.typing\s*=\s*null", block) is not None,
                  "整行分支清空打字机状态（点击直接推进）",
                  "整行分支残留打字机状态，点击会被 finishTyping 吃掉")
            check("return" in block,
                  "整行分支提前返回，不进入 typeSeg",
                  "整行分支没有提前返回，仍会启动逐字定时器")
    seg = body_of(script, "typeSeg")
    check(bool(seg) and "state.typeMs" in seg and "TYPE_SPEED" not in seg,
          "typeSeg() 用本句间隔驱动定时器",
          "typeSeg() 仍用固定常量驱动定时器")

    # [4] 设置项登记与页面引用（唯一登记处仍是 SPECS）
    check(re.search(r"textSpeed:\s*\{\s*type:\s*\"unit\"", settings) is not None,
          "textSpeed 仍在 settings.js 的 SPECS 登记（unit / 0~1）",
          "textSpeed 从 SPECS 消失，设置页会跳过这一项")
    sections = theme.get("pages", {}).get("settings", {}).get("sections", [])
    item = next((x for s in sections for x in s.get("items", []) if x.get("key") == "textSpeed"), None)
    check(item is not None,
          "模板 theme.json 的 sections 仍引用 textSpeed",
          "设置页不再显示文字显示速度")
    check(bool(item) and "info.json" in item.get("hint", ""),
          "设置页说明写明作者基准来自 info.json",
          "设置页说明没交代两层速度的关系")

    # [5] 文档三处口径同步
    info_doc = read(os.path.join(DOCS, "信息配置.md"))
    cmd_doc = read(os.path.join(DOCS, "指令.md"))
    style_doc = read(os.path.join(DOCS, "样式控制.md"))
    check("### 4.1 文字显示速度：`textCps`" in info_doc
          and re.search(r"\|\s*`textCps`\s*\|\s*number", info_doc) is not None,
          "信息配置.md 有字段表与 §4.1",
          "信息配置.md 缺少 textCps 字段定义")
    check("textCps" in cmd_doc and "textCps" in style_doc,
          "指令.md / 样式控制.md 都指向同一字段",
          "文档口径没同步，作者会在两处读到不同说法")

    # [6] 真实跑一次配置合并：工程写 0 覆盖模板默认，省略时继承模板默认
    from aliceadv.builder import resolve_config
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "theme.json"), "w", encoding="utf-8") as f:
            json.dump({}, f)
        with open(os.path.join(d, "info.json"), "w", encoding="utf-8") as f:
            json.dump({"textCps": 0}, f)
        merged_theme, merged_info, _ = resolve_config(d)
        check(merged_info.get("textCps") == 0 and merged_theme["info"].get("textCps") == 0,
              "工程写 textCps:0 时生效配置与 theme.info 都是 0（没有被 || 兜回）",
              "工程写 0 被默认值兜回，整行显示无法生效")
        os.remove(os.path.join(d, "info.json"))
        merged_theme, merged_info, _ = resolve_config(d)
        check(merged_info.get("textCps") == cps,
              "工程省略该字段时继承模板默认值 %s" % cps,
              "工程省略该字段时没继承模板默认值")

    print()
    for n in notes:
        print("  " + n)
    if failures:
        print()
        for f in failures:
            print("  " + f)
        print("\n✗ %d 项不满足" % len(failures))
        return 1
    print("\n✓ 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
