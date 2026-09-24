#!/usr/bin/env python3
"""时间轴规划器（preload.js 的 plan）的行为测试。

守的是什么：
  plan() 是纯计算 —— 给一段剧本和一个位置，产出「哪些资源、什么时候要用、按什么顺序拉」。
  它的正确性没有任何静态断言能守住：
    - 少累加一次时间  → 快进时音乐永远慢一拍，但代码看上去同样合理；
    - 把 decide 的分支串行累加 → 第二条分支的 deadline 被凭空推后，资源从不提前下发；
    - 章边界失效      → 规划跨到下一章，白白占掉当前章的带宽；
    - 从段首而不是从当前位置起算 → 读档进入时窗口从错误位置展开。
  这些都只有把数算出来才看得见，所以在 node 的 VM 里把引擎跑起来、直接调 plan()。

断言口径全部手算写死（见每条 case 的注释），不接受「跑出来是多少就是多少」。
预计下载耗时按标称 500 KB/s（沙箱里 performance 不产生条目 → measureSpeedKBps() 为 null
→ 走 NOMINAL_RATE_KBPS）。

跑法：python3 aliceadv/tests/test_preload_plan.py
依赖：node（用于把引擎跑起来）
"""
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, ".."))
PRELOAD_JS = os.path.join(REPO, "src", "aliceadv", "template", "style", "preload.js")
HARNESS = os.path.join(HERE, "assets", "preload_plan_harness.js")

NODE_CANDIDATES = [
    shutil.which("node"),
    os.path.expanduser("~/.workbuddy/binaries/node/versions/22.22.2-3/bin/node"),
]

failures = []
notes = []


def check(ok, ok_msg, bad_msg):
    if ok:
        notes.append("✓ " + ok_msg)
    else:
        failures.append("✗ " + bad_msg)
    return ok


def find_node():
    for c in NODE_CANDIDATES:
        if c and os.path.exists(c):
            return c
    return None


def run_harness(node):
    proc = subprocess.run(
        [node, HARNESS, PRELOAD_JS],
        capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0:
        print("harness 运行失败：")
        print(proc.stdout)
        print(proc.stderr)
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        print("harness 输出不是合法 JSON：", e)
        print(proc.stdout[:2000])
        return None


def approx(a, b, tol=1e-6):
    return a is not None and b is not None and abs(a - b) <= tol


def main():
    node = find_node()
    if not node:
        print("找不到 node —— 本测试需要在 node 里把 preload.js 跑起来。")
        print("已尝试：", [c for c in NODE_CANDIDATES if c])
        return 1
    r = run_harness(node)
    if r is None:
        return 1

    print("时间轴规划器（plan）")

    # S1 时间累加
    print("\n累加")
    s1 = r["s1"]
    check(s1["deadlineA"] == 6,
          "同段内累加：2 条 say（3 s/句）之后的 bg，deadline = 6 s",
          f"同段内累加错了：bg 的 deadline = {s1['deadlineA']}，应为 6（两条 say × 3 s）")

    s2 = r["s2"]
    check(s2["deadlineB"] == 6,
          "goto 是顺序关系：目标段的资源接着当前段累加（deadline = 6 s）",
          f"goto 之后的时间没有接着累加：deadline = {s2['deadlineB']}，应为 6")

    s3 = r["s3"]
    check(s3["deadlineC"] == 9 and s3["deadlineD"] == 9,
          "decide 各分支从同一个 acc 分叉（两条分支的首个资源 deadline 相同 = 9 s）",
          f"decide 分支没有共用同一个 acc：c={s3['deadlineC']} d={s3['deadlineD']}，应都等于 9")

    # S4 章边界
    print("\n章边界")
    s4 = r["s4"]
    check(s4["currentHasA"] is False,
          'chapter.scope="current" 时不跨章（下一章的资源不进入待发集合）',
          'chapter.scope="current" 仍然跨章遍历——章首加载页之外又多花了一份带宽')
    check(s4["allHasA"] is True,
          'chapter.scope="all" 时允许跨章（同一文件内嵌套多章必须靠它兜住章边界缺口）',
          'chapter.scope="all" 不生效——嵌套多章结构会在章边界处缺资源')

    # S5 排序
    print("\n排序键")
    s5 = r["s5"]
    check(s5["soon"]["tier"] == 1 and s5["small"]["tier"] == 1 and s5["big"]["tier"] == 2,
          "分档正确：3 s 与 15 s 在高保障区（tier 1）、54 s 在远档（tier 2）",
          f"分档错误：{s5['soon']['tier']} / {s5['small']['tier']} / {s5['big']['tier']}，应为 1/1/2")
    check(approx(s5["soon"]["slack"], 2.998) and approx(s5["small"]["slack"], 14.9)
          and approx(s5["big"]["slack"], 33.52),
          "slack = deadline − size/rate：1 KB→2.998、50 KB→14.9、10 MB→33.52",
          f"slack 算错：{s5['soon']['slack']} / {s5['small']['slack']} / {s5['big']['slack']}"
          "（应为 2.998 / 14.9 / 33.52）")
    check(s5["tiersAscending"] is True,
          "待发列表按 tier 升序（已过期/正在用的无条件优先）",
          "待发列表不再按 tier 升序——当前这一屏的资源会被排在后面")
    check(s5["slackAscendingWithinTier"] is True,
          "同一档内按 slack 升序（越来不及的越先发）",
          "同一档内不是按 slack 升序——排序退化成「谁先被扫到谁先发」")
    order = s5["order"]
    check(order.index("img/small.png") < order.index("img/big.png"),
          "50 KB / deadline 15 排在 10 MB / deadline 54 之前（体积不决定重要性，只影响 slack）",
          "大文件排到了小文件前面——等于退回「大文件优先」")
    check(order.count("gui/box.png") == 1,
          "同一路径只登记一次（对话框被 22 条 say 共用）",
          "同一路径出现多次——重复入队会重复占用连接")

    # S6 快进语音
    print("\n快进语音")
    s6 = r["s6"]
    check(s6["normalHasVoice"] is True,
          "正常模式：语音进入待发集合",
          "正常模式下语音被排除了——快进之外也听不到语音")
    check(s6["skipHasVoice"] is False,
          "快进模式：语音移出待发集合（给图片让带宽）",
          "快进模式仍预载语音——语音体积占 61%，会把图片挤到队尾")
    check(s6["skipHasMusic"] is True and s6["normalHasMusic"] is True,
          "快进只排除语音，音乐/音效不受影响",
          "快进把音乐/音效也排除了——快进时会没有背景音乐")
    check(s6["skipVoiceOffHasVoice"] is True,
          "fastForward.skipVoice=false 时快进也不排除语音（作者可关）",
          "fastForward.skipVoice=false 不生效——作者无法关掉「快进跳过语音」")

    # S7 窗口随模式变化
    print("\n窗口随播放速度变化")
    s7 = r["s7"]
    check(approx(s7["normal"]["deadline"], 60) and s7["normal"]["tier"] == 2,
          "正常（3.0 s/句）：20 句之后是 60 s，落在远档",
          f"正常模式的 deadline 错了：{s7['normal']}，应为 60 s / tier 2")
    check(approx(s7["auto"]["deadline"], 52) and s7["auto"]["tier"] == 2,
          "自动（2.6 s/句）：同一位置是 52 s",
          f"自动模式的 deadline 错了：{s7['auto']}，应为 52 s")
    check(approx(s7["skip"]["deadline"], 3.6) and s7["skip"]["tier"] == 1,
          "快进（0.18 s/句）：同一位置只剩 3.6 s，落进高保障区",
          f"快进模式的 deadline 错了：{s7['skip']}，应为 3.6 s / tier 1")
    check(s7["normal"]["tier"] != s7["skip"]["tier"],
          "同一剧本、同一位置，仅因播放模式不同就改变档位（窗口以秒计的核心理由）",
          "播放模式不改变档位——窗口还在按指令条数算")

    # S8 实测节奏
    print("\n每句耗时来自实测")
    s8 = r["s8"]
    check(approx(s8["lineSeconds"], 1.0, 1e-4),
          "连报 5 次 1.0 s → 当前句耗时 = 1.0 s（EWMA 生效）",
          f"实测节奏没有生效：currentLineSeconds = {s8['lineSeconds']}，应为 1.0")
    check(approx(s8["deadlineA"], 3.0, 1e-4),
          "按实测 1.0 s/句算出第 3 句之后的资源 deadline = 3 s（而非缺省的 9 s）",
          f"deadline 没有跟随实测节奏：{s8['deadlineA']}，应为 3.0")
    check(approx(s8["avgAfterOutlier"], s8["avgBefore"], 1e-4),
          "越界样本被丢弃：挂机 25 秒不进入平均",
          "25 秒的间隔被当成正常节奏——玩家切出去再回来会把窗口算飞")

    # S9 / S10 截断
    print("\n上界与截断")
    s9 = r["s9"]
    check(s9["hasA"] is True and s9["deadlineA"] == 6 and s9["tierA"] == 2,
          "窗口 5 s：deadline 6 s 的资源仍被规划（tier 2），不是被丢掉",
          f"窗口外但在上界内的资源被丢了：{s9}")
    check(s9["hasB"] is False,
          "超过 horizonSeconds 的资源整条不排队（留到下次推进重算）",
          "超过上界的资源仍进入待发集合——远档会无边界地吃掉带宽")
    s10 = r["s10"]
    check(s10["hasA"] is False,
          "maxInstructions 生效：只扫前 10 条，后面的资源不登记",
          "maxInstructions 不生效——快进时会一次扫过整章")

    # S11 当前位置
    print("\n起算位置")
    s11 = r["s11"]
    check(s11["deadline"] == 0 and s11["tier"] == 0,
          "从 (seg, idx) 起算：当前这条指令的资源 deadline = 0，落进 tier 0",
          f"时间轴没有从传入的位置起算：deadline = {s11['deadline']} / tier {s11['tier']}")
    s12 = r["s12"]
    check(s12["fromStartHas"] is True and s12["fromSaveHas"] is True,
          "同一资源从章节起点与从章中读档点起算，都会进入待发集合（不因「前面出现过」而跳过）",
          "资源因为「在更早的段里出现过」被跳过——从章中读档进入会缺立绘/背景")
    check(s12["fromSaveDeadline"] == 3,
          "读档点起算的 deadline 是相对该点的（3 s），不是相对章首",
          f"读档点的 deadline 不是相对该点：{s12['fromSaveDeadline']}")

    # S13 chapterAssets
    print("\n章内全量资源")
    s13 = r["s13"]
    check(s13["hasBox"] is True and s13["hasA"] is True,
          "chapterAssets() 是章内全部被引用资源的并集（含其它段才用到的资源）",
          "chapterAssets() 不是全量并集——complete 模式会漏载资源")
    check(s13["count"] == 2,
          "并集去重（对话框被两条 say 共用，只算一次）",
          f"chapterAssets() 有重复项：count = {s13['count']}")

    # S14 / S15 barrier 的形状与可配置
    print("\n兜底接口")
    s14 = r["s14"]
    check(s14["nonResourceIsNull"] is True,
          "barrier() 对不涉及资源的指令返回 null",
          "barrier() 对不涉及资源的指令也返回 Promise——每次推进都白多一个微任务")
    check(s14["imageIsThenable"] is True,
          '图片策略 "block" 且未就绪时，barrier() 返回可等待对象（遮罩会显示）',
          'barrier() 没有为 "block" 的未就绪图片返回可等待对象——兜底形同虚设')
    check(s14["audioIsNull"] is True,
          '音频默认 "degrade"：不在指令执行前拦停（音频缺失只是延迟起播）',
          'barrier() 把音频也拦停了——一条 4 MB 的 BGM 会让玩家干瞪遮罩')
    check(r["s15"]["imageDegradeDoesNotBlock"] is True,
          'fallback.image="degrade" 时图片也不拦停（作者可覆盖）',
          'fallback.image="degrade" 不生效——作者改不动兜底动作')

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
