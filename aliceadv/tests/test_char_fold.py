#!/usr/bin/env python3
"""立绘折叠的不变量（静态守卫）。

守的是「同拍内 hide X + show X 必须折叠成无操作」这件事的**实现方式**。

背景：剧本里存在大量成对指令「hide X; show X」（girls_out_of_orbit 的 ch1 有 339 对，
占全部 show 的 85%），逐字执行会让立绘每推进一句就重建一次、重播一遍入场淡入。
早期实现靠「延迟移除 + setTimeout(remove, 0)」折叠：hide 时把节点记进 state.hidingNodes，
把摘除推迟到下一个宏任务，指望同一拍里的 show 抢在它之前把节点认领回去。
这是**竞态**——advance() 在每条指令执行前都要 await barrier(c)，图片资源走
probeImage（新建 Image + load + decode），至少一个宏任务。两个宏任务赛跑：
探针快则碰巧折叠成功，remove 快则节点被摘掉、show 落到「首次出现」分支重建并重播入场
动画（玩家看到的就是「每推进一句闪一次进场」）。实测把 barrier 的落地延后 30ms，
ch1 的棒棒糖一段 10 句里 4 句重建。

因此这里的断言不是「有没有折叠」，而是「折叠的判据是不是剧本前瞻」——
把定时器、把 await 快慢重新引入判定，就等于把 bug 放回去。

浏览器端的端到端验证见 skills/aliceadv-verify/assets/verify_char_fold.js
（它把 barrier 的落地人为延后 300ms，即把竞态放大到必然暴露）。

跑法：python3 aliceadv/tests/test_char_fold.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT_JS = os.path.normpath(os.path.join(HERE, "..", "src", "aliceadv", "template", "style", "script.js"))

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


def body_of(src, decl_regex):
    """按大括号配对取出函数体（含嵌套）。decl_regex 匹配函数名部分，如 r'foldsIntoLaterShow\\s*\\('。"""
    m = re.search(r"(?:async\s+)?function\s+" + decl_regex, src)
    if not m:
        return None
    i = src.find("{", m.end())
    if i < 0:
        return None
    depth = 0
    for j in range(i, len(src)):
        ch = src[j]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return src[i:j + 1]
    return None


def main():
    script = read(SCRIPT_JS)

    print("立绘折叠不变量")

    # 1. 前瞻折叠是折叠的唯一判据，且必须发生在 dropChar 之前
    hide = body_of(script, r"hideChar\s*\(")
    check(hide is not None, "hideChar 存在", "找不到 hideChar")
    if hide:
        i_fold = hide.find("foldsIntoLaterShow")
        # 注意取最后一次 dropChar：hide 的「清空全部」分支里也调用了 dropChar，
        # 这里要保证的是「按 id 摘除之前先做了前瞻判定」。
        i_drop = hide.rfind("dropChar")
        check(i_fold != -1,
              "hideChar 用剧本前瞻判定折叠（foldsIntoLaterShow）",
              "hideChar 没有调用 foldsIntoLaterShow —— 折叠判据退回了时序/定时器")
        check(i_fold != -1 and i_drop != -1 and i_fold < i_drop,
              "前瞻判定在按 id 摘除之前（先决定折不折，再决定摘不摘）",
              "foldsIntoLaterShow 没有出现在 dropChar 之前，折叠不会生效")
        # 折叠只对硬切生效：带淡出的 hide 是有意为之的演出
        check(re.search(r"if\s*\(\s*!\s*fade\s*&&\s*foldsIntoLaterShow", hide) is not None,
              "只有不带淡出的 hide 参与折叠（淡出是给玩家看的一拍）",
              "hideChar 里的折叠没有排除带淡出的 hide")
        # 清空全部（不给 char / src）的路径不受折叠影响
        check("!c.char && !c.src" in hide,
              "hide 无参仍然走「清空场上全部」",
              "hideChar 丢了「不给 char/src 就清空全部」的分支")

    # 2. 前瞻本身的边界
    fold = body_of(script, r"foldsIntoLaterShow\s*\(")
    check(fold is not None, "foldsIntoLaterShow 存在", "找不到 foldsIntoLaterShow（折叠判据缺失）")
    if fold:
        check("state.idx + 1" in fold,
              "从当前指令的下一条开始前瞻（state.idx + 1）",
              "前瞻的起点不是 state.idx + 1 —— 会把当前这条指令也算进去")
        check("state.script" in fold and "segments" in fold and "state.seg" in fold,
              "前瞻读的是当前段的指令表（state.script.segments[state.seg]）",
              "前瞻没有从当前段指令表里取指令")
        check("isSameShown" in fold,
              "「原样重现」用 isSameShown 判定（同图、同站位、无 anim/transition）",
              "前瞻没有用 isSameShown —— 换站位/换表情会被误当成无操作吞掉")
        check("FOLD_SCAN_MAX" in fold,
              "前瞻有步数上限",
              "前瞻没有上限，病态剧本会退化成 O(n²)")
        # 条件指令：会不会执行看不出来，保守不折叠
        check(re.search(r"c\.if\s*!=\s*null", fold) is not None,
              "带 if 的指令终止前瞻（执行与否不确定）",
              "前瞻没有对 c.if 做保守终止")
        # 带淡出的换景是个真节拍（落幕后），不带淡出的 bg 只是同一帧里换图
        check('transition === "fade"' in fold and ("bg" in fold and "scene" in fold),
              "带 transition:\"fade\" 的 bg/scene 终止前瞻",
              "前瞻没有把带淡出的换景当作节拍边界")

    # 3. 关键：FOLD_PASS 必须只包含「不出画面」的指令。
    #    say / narrate / decide / title / pause / wait 之后的 show 属于后一拍，
    #    中间那段「立绘不在场上」玩家看得见，一旦放它们进白名单就等于删戏。
    m = re.search(r"const\s+FOLD_PASS\s*=\s*\{([^}]*)\}", script)
    check(m is not None, "FOLD_PASS 白名单存在", "找不到 FOLD_PASS 白名单")
    if m:
        names = set(re.findall(r"(\w+)\s*:", m.group(1)))
        forbidden = {"say", "narrate", "decide", "title", "pause", "wait", "goto", "if"}
        bad = sorted(names & forbidden)
        check(not bad,
              "FOLD_PASS 不含任何「占玩家一拍」的指令（say/narrate/decide/title/pause/wait/goto/if）",
              f"FOLD_PASS 里混进了 {bad} —— 前瞻会越过一拍，把玩家该看到的中场吞掉")
        for need in ("show", "hide", "sprite"):
            check(need in names, f"FOLD_PASS 含 {need}", f"FOLD_PASS 缺 {need}，同拍画面编排会被误判为节拍边界")

    # 4. 「延迟移除」可以留作出路，但不能再作为折叠的唯一依靠
    old = body_of(script, r"dropChar\s*\(")
    if old:
        check("hidingNodes" in old,
              "dropChar 仍登记 hidingNodes（供前瞻之外的兜底路径复用）",
              "dropChar 不再登记 hidingNodes，跨 goto 的成对指令会重建立绘")
        check(re.search(r"foldsIntoLaterShow", old) is None,
              "dropChar 本身不做折叠判定（判定只在 hideChar 里、按剧本做）",
              "dropChar 里出现折叠判定，判据被拆成两处会互相漂移")

    print()
    for n in notes:
        print("  " + n)
    if failures:
        print()
        for f in failures:
            print("  " + f)
        print(f"\n✗ {len(failures)} 项不满足")
        return 1
    print("\n✓ 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
