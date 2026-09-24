#!/usr/bin/env python3
"""舞台复位的不变量（静态守卫）。

守的是「跨状态的生命周期」约定：舞台元素的存活跨越「播放中」与「已退出播放」两种状态。
只要有人把 start() / load() 里的复位动作删掉，就会出现「玩到一半回首页、再开始，
上一次退出时的立绘/背景还留在原位」这类问题——而这种问题在 diff 里几乎看不出来，
只有把画面跑起来才看得见。所以这里把约定钉成断言。

浏览器端的端到端验证（真跑一遍回首页→重开→看残留）见
skills/aliceadv-verify/assets/verify_stage_reset.js。

跑法：python3 aliceadv/tests/test_stage_reset.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
STYLE = os.path.join(HERE, "..", "src", "aliceadv", "template", "style")
SCRIPT_JS = os.path.normpath(os.path.join(STYLE, "script.js"))
THEME_JS = os.path.normpath(os.path.join(STYLE, "theme.js"))

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
    """按大括号配对取出某个函数声明的函数体（含嵌套）。

    decl_regex 必须匹配到函数签名（例如 r'function\\s+exit\\s*\\('）；
    允许 async 前缀，因为 start / load 是异步的。
    """
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
    theme = read(THEME_JS)

    print("舞台复位不变量")

    # 1. 复位动作本身存在，且是「一个函数」而不是散落的清理代码
    print("复位动作")
    check(re.search(r"\bfunction\s+resetStage\s*\(", script) is not None,
          "script.js 定义了 resetStage()",
          "script.js 找不到 resetStage() 定义")

    # 2. 两头都调用：离开播放（exit）与进入播放（start / load）
    print("两头都复位（退出 + 进入）")
    for name in ("exit", "start", "load"):
        body = body_of(script, name + r"\s*\(")
        if body is None:
            check(False, "", f"script.js 找不到 {name}() 函数体（声明形式变了？请更新本测试）")
            continue
        check("resetStage(" in body,
              f"{name}() 调用了 resetStage()",
              f"{name}() 没有调用 resetStage()——这条路径进入/离开舞台时会留下上一次的画面")

    # 3. 演出停机也要两头共用（上一局的 auto/skip 定时器不能跟着走到下一局）
    print("演出停机")
    check(re.search(r"\bfunction\s+stopPlayback\s*\(", script) is not None,
          "script.js 定义了 stopPlayback()",
          "script.js 找不到 stopPlayback() 定义")
    for name in ("start", "load"):
        body = body_of(script, name + r"\s*\(") or ""
        check("stopPlayback(" in body,
              f"{name}() 调用了 stopPlayback()",
              f"{name}() 没有调用 stopPlayback()——上一局的打字机/等待/自动快进会漏到新一局")

    # 4. hide 支持清空全部（无 char / 无 src）
    print("hide 清空全部")
    hide_body = body_of(script, r"hideChar\s*\(") or ""
    check(re.search(r"!\s*c\.char\s*&&\s*!\s*c\.src", hide_body) is not None,
          "hideChar() 有不给 char/src = 清空全部的分支",
          "hideChar() 失去了「不给 char/src = 清空全部」的分支，谢幕类脚本会静默失效")

    # 5. 淡出必须先停掉入场动画：CSS 动画的优先级高于 inline style，
    #    不停动画的话 style.opacity = "0" 不生效，角色会「啪」地消失而不是淡出。
    drop_body = body_of(script, r"dropChar\s*\(") or ""
    check('style.animation' in drop_body and 'style.opacity' in drop_body,
          "dropChar() 淡出前先停掉 CSS 动画（否则淡出被 anim-fade 覆盖）",
          "dropChar() 淡出时没有停掉 CSS 动画——inline opacity 会被 anim-fade 覆盖，淡出失效")

    # 6. 主题兜底背景要能被复位还原（复位不能把舞台清成浏览器默认，得回到「刚打开页面」的样子）
    print("兜底背景")
    check("dataset.fallbackBg" in theme,
          "theme.js 把主题兜底背景写进 data-fallback-bg",
          "theme.js 没有记录主题兜底背景（dataset.fallbackBg）——复位后舞台露不出应有的兜底图")
    check("dataset.fallbackBg" in script,
          "resetStage() 从 data-fallback-bg 还原背景",
          "resetStage() 没有从 data-fallback-bg 还原背景")

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
