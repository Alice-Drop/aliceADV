#!/usr/bin/env python3
"""资源预加载「顺序 / 调度 / 兜底」的不变量（静态守卫）。

守的是什么：
  预加载的**正确性依赖「发起顺序 = 下载顺序」**（浏览器每源 ~6 条并发连接，按发起顺序排队）。
  因此「把哪些资源、按什么顺序放进队列」就是这套机制的全部要害。而这类改动的破坏性
  在不限速的开发机上**完全看不出来**——只有限速到 4G/3G 才会露出「首页空白、背景逐行扫描」。

  2026-09-23 起，调度依据由「按资源类型的固定顺序」改为「按 deadline 算出的 slack」，
  前瞻单位由「指令条数」改为「秒」。这里把随之而来的几条硬约定钉成断言，
  防止有人顺手退回旧形状。

具体不变量：
  1. 发起必须经过泵(pump)：boot 队列优先于规划队列，两者共用一个并发窗口。
  2. boot() 必须分级且首屏优先，且**不得**全量预载角色对话框。
  3. enterStage() 的前奏集合来自时间轴（planChars），且遮罩等待必须走 waitForPaint。
  4. plan() 的排序键是 tier → slack → size；decide 各分支从同一个 acc 分叉；
     章边界读 __segChapter。
  5. **资源归属只读运行时的 records**：不得按 segment 推断「已加载过」。
  6. barrier() 必须在 exec(c) 之前；next() 在 state.barrier 为真时必须返回。
  7. setBg / showChar / musicCmd / playVoice 内部不得出现 await（会破坏同步返回语义）。
  8. 快进语音（预载与播放两处）都受 fastForward.skipVoice 控制，且判据同源。
  9. 下载中的 Image / Audio 必须被强引用持有（否则 GC 会中止请求）。
 10. 遮罩等待必须走 waitForPaint；模板 info.json 必须写明全部默认值；
     模式常量必须与 script.js 的定时器周期一致。
 11. 超时只解除「等待」，不得释放下载中元素的强引用（否则 GC 中止请求、预加载白做）。
 12. 慢网提示必须写得到**两层遮罩**上，且判据是「有没有遮罩亮着」而非某个具体遮罩；
     背景转场在解码期间（pending）必须吸收点击——否则换图被作废、幕布停在满幕。

浏览器端的端到端验证（限速、真实网络栈、CDP）见
skills/aliceadv-verify/assets/verify_preload_throttle.js 与 verify_preload_timeout.js。
file:// 下 CDP 限速**不生效**，所以那些验证必须自带 http 服务器。

时间轴逻辑（累加、分支分叉、章边界、排序）由 test_preload_plan.py 在 node 里真跑一遍。

跑法：python3 aliceadv/tests/test_preload_order.py
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.normpath(os.path.join(HERE, "..", "src", "aliceadv", "template"))
STYLE = os.path.join(TEMPLATE, "style")
PRELOAD_JS = os.path.normpath(os.path.join(STYLE, "preload.js"))
SCRIPT_JS = os.path.normpath(os.path.join(STYLE, "script.js"))
PRELOAD_CSS = os.path.normpath(os.path.join(STYLE, "preload.css"))
INDEX_HTML = os.path.normpath(os.path.join(TEMPLATE, "index.html"))
INFO_JSON = os.path.normpath(os.path.join(TEMPLATE, "info.json"))

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

    注意正则里的 \\b：没有它 'plan\\s*\\(' 会先命中 'planChars' 之类的名字。
    """
    pattern = r"(?:async\s+)?function\s+(?:" + decl_regex + r")\s*\("
    # 用 (?![\w$]) 锚住函数名末尾，避免前缀误配
    pattern = pattern.replace(r"\s*\(", r"(?![\w$])\s*\(")
    m = re.search(pattern, src)
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
    src = read(PRELOAD_JS)
    print("预加载调度不变量")

    # 1. 双队列 + 单一并发窗口
    print("队列与并发窗口")
    pump = body_of(src, r"pump")
    check(pump is not None,
          "preload.js 定义了 pump()",
          "preload.js 找不到 pump()——限并发的泵被删了，发起顺序将不再受控")
    check(re.search(r"\bfunction\s+ensure(?![\w$])", src) is not None,
          "preload.js 定义了 ensure()（唯一的发起入口）",
          "preload.js 找不到 ensure()——资源发起必须收口到一个入口，否则就绪状态无法判定")
    check(re.search(r"\bfunction\s+enqueue(?![\w$])", src) is not None,
          "preload.js 定义了 enqueue()（批量保序入队）",
          "preload.js 找不到 enqueue()——批量预载的保序性质没有落脚点")
    if pump:
        check("inflightCount < CONCURRENCY" in pump,
              "pump() 用 CONCURRENCY 限制在途请求数",
              "pump() 不再限并发——浏览器排队顺序会打乱优先级")
        i_boot, i_plan = pump.find("bootQueue.length"), pump.find("planQueue.length")
        check(i_boot >= 0 and i_plan >= 0 and i_boot < i_plan,
              "pump() 先取 boot 队列再取 plan 队列（启动/进章优先于运行时规划）",
              "pump() 的取值顺序变了——进章的整批资源会被运行中的规划插队")
        check("bootQueue" in src and "planQueue" in src,
              "boot 与 plan 是两个队列、共用一个并发计数",
              "boot / plan 不再是两个队列——进章的大批资源会与运行中的规划各占一个窗口")
    pa = body_of(src, r"preloadAll") or ""
    check("enqueue(" in pa,
          "preloadAll() 走 enqueue()（按数组顺序入队）",
          "preloadAll() 不再走 enqueue()——「数组顺序 = 发起顺序」的优先级会失效")
    check("runQueue" not in src,
          "旧的按类型固定顺序队列 runQueue 已移除",
          "preload.js 里又出现 runQueue——旧队列的「音效→语音→背景→立绘」固定顺序不该回来")

    # 2. boot 分级 + 首屏优先 + 不塞角色对话框
    print("boot 分级")
    boot = body_of(src, r"boot") or ""
    if not boot:
        check(False, "", "preload.js 找不到 boot() 函数体（声明形式变了？请更新本测试）")
    else:
        i_title, i_chrome = boot.find("collectTitle("), boot.find("collectChrome(")
        check(i_title >= 0 and i_chrome >= 0 and i_title < i_chrome,
              "boot() 中 collectTitle() 排在 collectChrome() 之前（首屏优先）",
              "boot() 没有做到首屏优先：首页背景必须排在引擎外壳图之前")
        check("collectCharTextboxes(" not in boot,
              "boot() 不预载角色专属对话框（避免 ~10MB 挤掉首屏）",
              "boot() 又在全量预载角色对话框了——限速下会把首页背景挤到队尾，首页空白")
        check("hideMask(" in boot,
              "boot() 会在首屏就绪后揭开遮罩",
              "boot() 不再揭开遮罩")

    # 3. enterStage 的前奏集合与遮罩等待
    print("章首加载页")
    es = body_of(src, r"enterStage") or ""
    if not es:
        check(False, "", "preload.js 找不到 enterStage() 函数体（声明形式变了？请更新本测试）")
    else:
        check("collectCharTextboxes(" in es,
              "enterStage() 按需预载角色对话框",
              "enterStage() 不再预载角色对话框——第一句台词的对话框会「后到」")
        check("planChars" in es,
              "enterStage() 用时间轴(planChars)挑出前奏窗口内要登场的角色",
              "enterStage() 不再按登场时间挑角色对话框——要么全量（挤带宽）要么完全不预载")
        check("waitForPaint(" in es and "Promise.race(" not in es,
              "enterStage() 的遮罩等待走 waitForPaint()",
              "enterStage() 自己写 Promise.race(sleep)——超时策略必须集中在 waitForPaint()")
        check("chapterAssets(" in es and 'preload === "complete"' in es,
              'enterStage() 支持 chapter.preload="complete"（等齐章内全部可达资源）',
              'enterStage() 丢掉 complete 模式——作者要求的「宁可等也不要缺素材」没有实现')
        check("hideMask(" in es,
              "enterStage() 就绪后揭开遮罩",
              "enterStage() 不再揭开遮罩")
        # 揭幕前的等待必须**分组**：首帧关键集无条件等，前奏受下载时间预算截断。
        # 早期实现把整个规划（180 秒上界内的全部资源）都塞进等待集，
        # 实测在 Fast 3G 下让章首遮罩足足等了 95 秒——这是本组断言要防的退化。
        check("critical" in es and "prelude" in es and "rest" in es,
              "enterStage() 把等待集分成「首帧关键集 / 前奏 / 后台补齐」三组",
              "enterStage() 不再分组——首帧与远档混在一起等，遮罩会被远档拖住")
        check("preludeBudgetSeconds" in es and "budget" in es and "spent" in es,
              "enterStage() 用 preludeBudgetSeconds 按预计下载耗时截断前奏",
              "enterStage() 的前奏没有下载时间预算——它的字节数无上界，慢网下会让玩家干等")
        check("cut = true" in es,
              "前奏按顺序**切断**（不跳过超支项去捡后面的小文件）",
              "前奏不再按顺序切断——跳着取会破坏「顺序即优先级」")
        check("plan(script, seg, idx)" in es,
              "enterStage() 从传入的 (seg, idx) 起算时间轴（读档点，不是段首）",
              "enterStage() 没有从传入位置起算——读档进入时前奏会选错资源")
        # 章首等的是「画得出来」，不是「我们取回过一次」：首帧背景往往在进网页时就预载过
        # （可能是一分钟前），缓存一旦用不上，绘制仍要重新联网 → 遮罩已揭开，玩家看到半张背景。
        check("waitPaintable(" in es,
              "enterStage() 的等待集走可绘制性探针（图片不是只等自己的加载 promise）",
              "enterStage() 只等自己的加载 promise——首帧背景可能是很久以前预载的，"
              "缓存失效时遮罩照样揭开，玩家看到半张背景")
        check("!isReady(" not in es,
              "enterStage() 不拿 records.done 过滤等待集",
              "enterStage() 用 isReady() 过滤等待集——已 done 但已不可绘制的图片会被跳过")
        check("maskDelayMs" in es,
              "enterStage() 也遵守遮罩显示延迟（资源都在缓存里时不闪一下）",
              "enterStage() 立刻显示遮罩——命中的资源会让全屏遮罩闪一下")

    # 4. plan 的排序键 / 分支分叉 / 章边界
    print("时间轴与排序")
    plan = body_of(src, r"plan") or ""
    if not plan:
        check(False, "", "preload.js 找不到 plan() 函数体（声明形式变了？请更新本测试）")
    else:
        for key in ("a.tier - b.tier", "a.slack - b.slack", "a.size - b.size"):
            check(key in plan,
                  f"plan() 的排序键包含 {key}",
                  f"plan() 的排序键丢了 {key}——档位 / slack / 体积三者缺一都会让排序退化")
        check("a.slack - b.slack" in plan and plan.find("a.slack - b.slack") < plan.find("a.size - b.size"),
              "slack 在体积之前比较（体积只参与预计耗时，不参与「谁更重要」）",
              "plan() 先比体积再比 slack——等于退回「大文件优先」，与设计相悖")
        check("__segChapter" in plan and "crossChapter" in plan,
              "plan() 的章边界检查读 __segChapter",
              "plan() 不再检查章边界——chapter.scope 失效，跨章遍历会失控")
        check('c.cmd === "decide"' in plan and plan.count("walk(opt.goto, 0, acc)") == 1,
              "decide 的各分支从同一个 acc 分叉",
              "plan() 的 decide 分支没有共用同一个 acc——第二个分支的 deadline 会被串行推后")
        check('c.cmd === "goto"' in plan and 'c.cmd === "if"' in plan,
              "goto / if 是顺序关系（继续用同一个 acc）",
              "plan() 丢了 goto 或 if 的遍历——跨段资源不会被规划到")
        check("skipVoiceActive()" in plan,
              "plan() 在快进时把语音移出待发集合",
              "plan() 没有排除语音——快进时语音会挤占图片的带宽")
        check("instructionCost(" in plan,
              "plan() 用 instructionCost() 累加时间",
              "plan() 不再按指令耗时累加——时间轴退化成条数")
        check("estimateSeconds(" in plan,
              "plan() 用 estimateSeconds() 把体积换算成预计下载耗时",
              "plan() 不再用体积算 slack——deadline 无法与下载耗时比较")

    # 5. 就绪判定只读 records，不按段推断
    print("就绪判定")
    check("var records = Object.create(null)" in src,
          "preload.js 用 records 记录每个资源的真实状态",
          "找不到 records——「这个资源能不能用」失去唯一依据")
    check("cache[" not in src,
          "旧的 cache（只记「已发起」）已完全移除",
          "preload.js 里还有旧的 cache——它不区分「已发起」与「已完成」，不足以判定就绪")
    br = body_of(src, r"barrier") or ""
    if not br:
        check(False, "", "preload.js 找不到 barrier() 函数体（声明形式变了？请更新本测试）")
    else:
        check("records[" in br and "waitPaintable(" in br,
              "barrier() 用 records 判「发起过没有 / 坏没坏」，用可绘制性探针判「此刻能不能用」",
              "barrier() 的就绪判定退化了——只信我们自己的加载记录会在缓存不可用时放行半张图")
        check("isReady(" not in br,
              "barrier() 不拿 records.done 当就绪判据",
              "barrier() 又用 isReady() 直接放行了——records.done 只证明「曾经取回过一次」，"
              "不证明浏览器此刻画得出来（DevTools 禁用缓存 / 缓存被淘汰 / 响应不可缓存时，"
              "绘制会重新联网 → 背景半张图 + 永远看不到转圈圈）")
        check('status === "failed"' in br,
              "barrier() 跳过已失败的资源（等坏资源等于卡死）",
              "barrier() 不跳过失败资源——一个 404 会让游戏永远停在等待遮罩上")
        check('fallbackFor' in br,
              "barrier() 按 fallback 配置分档（block 才等）",
              "barrier() 不分档——degrade / missing 会被当成 block 处理")
        check("return null" in br,
              "barrier() 无资源可等时返回 null（调用方用真假判断，不必 await）",
              "barrier() 无资源可等时仍返回 Promise——每次推进都会多出一个微任务，且真假判断失效")

    # 5.1 可绘制性探针：这是「此刻能不能用」的唯一判据
    print("可绘制性探针")
    pr = body_of(src, r"probeImage") or ""
    if not pr:
        check(False, "", "preload.js 找不到 probeImage()（就绪判据失去「此刻可绘制」这一半）")
    else:
        check("new Image()" in pr and "img.decode" in pr,
              "probeImage() 用真实的 Image 取用路径（load + decode）验证可绘制性",
              "probeImage() 不真的取用图片——判据又回到了「查我们自己的记录」")
        check("inflight.push(" in pr,
              "probeImage() 强引用在途 Image",
              "probeImage() 不持有在途 Image——GC 可能在下载途中回收它并中止请求")
        check("ASSET_TIMEOUT" in pr,
              "probeImage() 有等待上限（沿用 ASSET_TIMEOUT）",
              "probeImage() 没有等待上限——坏资源会让遮罩永久停留")
    wp = body_of(src, r"waitPaintable") or ""
    check("probeImage(" in wp and "ensure(" in wp and "assetKind(" in wp,
          "waitPaintable() 对图片走探针、对其它走加载 promise，并始终登记 records",
          "waitPaintable() 不再区分类型——图片会退回「只信 records」，或音频也会被探针拖住")
    ca = body_of(src, r"chapterAssets") or ""
    check("script.segments" in ca and "needsOf(" in ca,
          "chapterAssets() 是「章内全部被引用的资源」的全量并集",
          "chapterAssets() 的形状变了——complete 模式会漏载资源")

    # 6. barrier 的位置与重入守卫（script.js）
    print("兜底拦停")
    sjs = read(SCRIPT_JS)
    adv = body_of(sjs, r"advance") or ""
    if not adv:
        check(False, "", "script.js 找不到 advance() 函数体（声明形式变了？请更新本测试）")
    else:
        check(re.search(r"async\s+function\s+advance", sjs) is not None,
              "advance() 已异步化（兜底需要 await）",
              "advance() 不是 async——兜底拦停无处落脚")
        i_barrier, i_exec = adv.find(".barrier(c)"), adv.find("exec(c)")
        check(i_barrier >= 0 and i_exec >= 0 and i_barrier < i_exec,
              "barrier 在 exec(c) 之前（指令执行前拦停）",
              "barrier 不在 exec(c) 之前——它必须留在主循环里，不要塞进 setBg 等指令内部")
        check("state.barrier = true" in adv and "state.barrier = false" in adv,
              "advance() 在等待期间立起 state.barrier",
              "advance() 不再立 state.barrier——等待期间玩家的点击会重入主循环")
        check("state.epoch" in adv,
              "advance() 用 state.epoch 判断「醒来时这一局是否还在」",
              "advance() 不再校验 epoch——等待跨过读档/重开会拿旧剧本继续跑")
        check("reportDwell(" in adv,
              "advance() 上报实测的每句耗时",
              "advance() 不再上报节奏样本——时间窗口只能用缺省值，快慢玩家一律按 3 秒算")
    nxt = body_of(sjs, r"next") or ""
    check("state.barrier" in nxt,
          "next() 在 state.barrier 为真时直接返回",
          "next() 不检查 state.barrier——兜底等待期间点击会重入")
    sp = body_of(sjs, r"stopPlayback") or ""
    check("state.barrier = false" in sp and "state.epoch++" in sp,
          "stopPlayback() 清掉 barrier 并递增 epoch",
          "stopPlayback() 不复位 barrier/epoch——上一局的等待会跟着走到下一局")
    for name in ("setAuto", "setSkip"):
        body = body_of(sjs, name) or ""
        check("syncPlaybackMode(" in body,
              f"{name}() 上报播放模式给预加载器",
              f"{name}() 不上报播放模式——窗口长度不会随自动/快进调整")

    # 7. 指令内部不得 async（会破坏同步返回语义）
    print("指令保持同步")
    for name in ("setBg", "showChar", "musicCmd", "playVoice"):
        body = body_of(sjs, name)
        if body is None:
            check(False, "", f"script.js 找不到 {name}() 函数体（声明形式变了？请更新本测试）")
            continue
        check("await " not in body,
              f"{name}() 内部没有 await（保持同步返回语义）",
              f"{name}() 里出现了 await——它的返回值语义与 epoch 判断的时机都会错位")

    # 8. 快进语音：两处同源
    print("快进语音")
    check(re.search(r"\bfunction\s+skipVoiceActive(?![\w$])", src) is not None,
          "preload.js 定义了 skipVoiceActive()（快进跳语音的唯一判据）",
          "preload.js 找不到 skipVoiceActive()——预载侧的语音策略失去落脚点")
    sva = body_of(src, r"skipVoiceActive") or ""
    check("fastForward.skipVoice" in sva,
          "skipVoiceActive() 读 info.preload.fastForward.skipVoice",
          "skipVoiceActive() 不读配置——作者无法关掉「快进时跳过语音」")
    check("state.skip" in sva or "playback" in sva,
          "skipVoiceActive() 同时认 playback 与运行时 state.skip",
          "skipVoiceActive() 只看一个来源——预载侧与播放侧会不一致")
    snv = body_of(sjs, r"skipVoiceNow") or ""
    check("skipVoiceActive" in snv,
          "script.js 的 skipVoiceNow() 委托给 preload.js（两处同源）",
          "script.js 自己另写一套快进判定——预载不加载、播放却要播，两处会走偏")
    check(sjs.count("skipVoiceNow()") >= 3,
          "语音播放的三处入口（voice 指令 / say 绑定 / 回溯重播）都受控",
          "有 playVoice 调用点漏了 skipVoiceNow()——快进时仍会播语音")
    # say.append 分支的语音属于「say 绑定」一类，不应另起一处判断
    check(sjs.count("playVoice(") == sjs.count("!skipVoiceNow()") + 1,
          f"playVoice() 的 {sjs.count('playVoice(')} 处调用中，除定义外全部带快进守卫",
          "playVoice() 的调用点与守卫数量不匹配——有语音路径漏了快进判定")

    # 9. 下载中对象强引用
    print("防 GC 中止下载")
    pi = body_of(src, r"preloadImage") or ""
    check("inflight.push(" in pi,
          "preloadImage() 把在途 Image 放进 inflight 强引用",
          "preloadImage() 不再持有在途 Image——GC 可能中止下载，表现为「发起过却永远没完成」")
    pa2 = body_of(src, r"preloadAudio") or ""
    check('a.src = ""' not in pa2 and "a.src=\"\"" not in pa2,
          "preloadAudio() 不再把 src 置空（置空会主动中止下载）",
          'preloadAudio() 又把 src 置空了——会主动中止仍在进行的下载，预加载白做')
    check("arrayBuffer(" in pa2,
          "preloadAudio() 在 http(s) 下 fetch 并读完响应体（否则不会落进 HTTP 缓存）",
          "preloadAudio() 没有读完响应体——未消费的 fetch 会被中止，缓存里留不下字节")
    check("new URL(" in pa2,
          "preloadAudio() 先把相对路径解析成绝对 URL 再判协议",
          "preloadAudio() 直接对相对路径判协议——脚本里的 src 是相对的，会永远走回退分支")

    # 10. 单资源等待超时
    print("超时语义")
    m = re.search(r"var\s+ASSET_TIMEOUT\s*=\s*(\d+)", src)
    check(m is not None and int(m.group(1)) >= 15000,
          f"ASSET_TIMEOUT = {m.group(1) if m else '?'}ms（只解除等待、不中止下载）",
          "ASSET_TIMEOUT 被缩得太小——限速下会提前放行队列，让限并发失效，请保持 >= 15000")

    # 11. 遮罩超时策略：可配置 + 两模式 + 三处入口共用
    print("超时策略（preload.timeout / onTimeout）")
    check(re.search(r"\bBOOT_TIMEOUT\b", src) is None,
          "写死的总超时常量 BOOT_TIMEOUT 已移除",
          "preload.js 里又出现写死的 BOOT_TIMEOUT——超时时间必须来自 info.json 的 preload.timeout")
    check("DEFAULT_TIMEOUT" in src,
          "DEFAULT_TIMEOUT 作为 preload.timeout 的缺省值存在",
          "找不到 DEFAULT_TIMEOUT——timeout 缺省值必须在引擎侧有兜底")
    gs = body_of(src, r"getStrategy") or ""
    for key in ("pre.timeout", "pre.onTimeout", "pre.slowSpeedKBps"):
        check(key in gs,
              f"getStrategy() 读取 {key}",
              f"getStrategy() 没有读取 {key}——该配置项不会生效")
    wfp = body_of(src, r"waitForPaint") or ""
    if not wfp:
        check(False, "", "找不到 waitForPaint()——遮罩等待策略必须集中在这一个函数里")
    else:
        check('strat.onTimeout === "release"' in wfp and "Promise.race(" in wfp,
              'waitForPaint() 有 "release" 分支（到点放行）',
              'waitForPaint() 缺少 "release" 分支——旧行为（超时自动放行）必须仍可选')
        check("onTimeout" in wfp and "strat.timeout" in wfp,
              "waitForPaint() 使用配置里的 timeout / onTimeout",
              "waitForPaint() 没有使用配置值——又变成写死的行为")
        check("showHint(" in wfp and "hintForNow(" in wfp and "anyMaskVisible(" in wfp,
              "waitForPaint() 在超时后实测网速并显示提示文字",
              "waitForPaint() 超时后没有测速/提示——提示模式失效")
        # 判据必须是「有没有遮罩亮着」，不能是「某个具体遮罩是否隐藏」：
        # 章首等的是 #boot-mask、剧情中途等的是 #wait-mask，只查一层会把另一层的提示静默丢掉
        # （实测症状：等了二十多秒只有转圈圈、一行字都没有）。
        check('classList.contains("is-hidden")' not in wfp,
              "waitForPaint() 不以「某个遮罩是否隐藏」作为放不放提示的判据",
              "waitForPaint() 又拿单个遮罩的 is-hidden 当守卫——另一层遮罩上的提示会被丢掉")
    ms = body_of(src, r"measureSpeedKBps") or ""
    check('getEntriesByType("resource")' in ms,
          "measureSpeedKBps() 读 Resource Timing 的 resource 条目",
          "measureSpeedKBps() 没有读 Resource Timing——没法算单资源传输速率")
    check("transferSize" in ms and "encodedBodySize" in ms,
          "measureSpeedKBps() 用 transferSize / encodedBodySize（命中缓存的条目 transferSize 为 0，须剔除）",
          "measureSpeedKBps() 没用 transferSize / encodedBodySize——缓存命中的资源会算成虚高网速")
    check("MIN_SPEED_SAMPLE" in ms,
          "measureSpeedKBps() 丢弃过小样本（几百字节的突发会算出失真速率）",
          "measureSpeedKBps() 不筛样本大小——小响应的瞬时速率会污染「网速是否慢」的判断")
    check("SPEED_WINDOW_MS" in ms and "lastRateAt" in ms,
          "measureSpeedKBps() 只采信时效窗口内的样本（中途限速后能自我纠正）",
          "measureSpeedKBps() 不再看样本时效——中途开限速后，限速前的全速传输会一直胜出，"
          "估计值永远停在限速前，提示文案会把「网络较慢」说成「资源体积较大」")
    check("DEFAULT_MASK_DELAY_MS" in src and "maskDelayMs" in gs,
          "兜底遮罩有显示延迟（fallback.maskDelayMs，可配置）",
          "找不到遮罩显示延迟——缓存命中的资源会让转圈圈闪一下")
    wb = body_of(src, r"waitWithBarrier") or ""
    if not wb:
        check(False, "", "找不到 waitWithBarrier()——兜底等待与遮罩显示在这里")
    else:
        check("maskDelayMs" in wb and "setTimeout(reveal" in wb,
              "waitWithBarrier() 先等 maskDelayMs 再亮遮罩（超时未就绪才显示）",
              "waitWithBarrier() 立刻显示遮罩——绝大多数指令的资源都在缓存里，会闪一下")
        check("it.done" in wb or "it.done = true" in wb,
              "waitWithBarrier() 按每一项自己的 promise 算进度（探针未返回 = 这一项还没好）",
              "waitWithBarrier() 的进度不看探针——遮罩上会显示 100% 却还在等")
    for name in ("boot", "enterStage"):
        body = body_of(src, name)
        if body is None:
            check(False, "", f"找不到 {name}() 函数体（声明形式变了？请更新本测试）")
            continue
        check("waitForPaint(" in body and "Promise.race(" not in body,
              f"{name}() 的遮罩等待走 waitForPaint()",
              f"{name}() 自己写 Promise.race(sleep)——超时策略必须集中在 waitForPaint()，否则三处会走偏")

    # 12. 兜底遮罩的节点与样式
    print("兜底遮罩（#wait-mask）")
    css = read(PRELOAD_CSS)
    check(".boot-hint" in css and ".boot-hint.is-shown" in css,
          "preload.css 定义了 .boot-hint 与其显示态 .is-shown",
          "preload.css 缺少 .boot-hint / .boot-hint.is-shown——提示文字无法淡入")
    check("#wait-mask" in css and "#wait-mask.is-hidden" in css,
          "preload.css 定义了 #wait-mask 与其隐藏态 .is-hidden",
          "preload.css 缺少 #wait-mask 的样式——兜底等待时舞台会被盖住或没有遮罩")
    html = read(INDEX_HTML)
    check('id="boot-hint"' in html,
          "index.html 的启动遮罩内含 #boot-hint 元素",
          "index.html 里找不到 #boot-hint——showHint 无处落笔")
    check('id="wait-mask"' in html and 'id="wait-progress"' in html,
          "index.html 内含 #wait-mask 与 #wait-progress",
          "index.html 里找不到 #wait-mask / #wait-progress——barrier 无处显示")

    # 13. 模板 info.json 即默认值来源
    hfn = body_of(src, r"hintForNow") or ""
    check("measureSpeedKBps(" in hfn and "HINT_SLOW" in hfn and "HINT_LARGE" in hfn,
          "hintForNow() 按实测网速在两句文案间二选一",
          "hintForNow() 不再测速——提示文案与真实网速脱钩")
    # 两处（waitForPaint / waitWithBarrier）都靠它取文案，判据必须同源
    check(src.count("showHint(hintForNow())") >= 2,
          "启动遮罩与兜底遮罩共用同一份提示文案（hintForNow）",
          "只有一处调用 hintForNow()——两处的提示文案会走偏")

    # 12b. 提示的投递：两层遮罩都要写得到
    print("提示文字的投递")
    sh = body_of(src, r"showHint") or ""
    check('"boot-hint"' in sh and '"wait-hint"' in sh,
          'showHint() 同时写 #boot-hint 与 #wait-hint（哪层遮罩亮着都能看到）',
          'showHint() 只写一个元素——另一层遮罩上的玩家看不到任何解释文字')
    hh = body_of(src, r"hideHint") or ""
    check('"boot-hint"' in hh and '"wait-hint"' in hh,
          "hideHint() 两层一起清（不会把上一次的提示留在下一次等待里）",
          "hideHint() 只清一个元素——复用的遮罩会挂着过期提示")
    am = body_of(src, r"anyMaskVisible") or ""
    check('"boot-mask"' in am and '"wait-mask"' in am,
          "anyMaskVisible() 同时看两层遮罩",
          "anyMaskVisible() 只看一层——判断「还该不该补提示」会出错")
    check("hintTimer" in wb,
          "waitWithBarrier() 也有超时提示（兜底等待超过 preload.timeout 会补一行说明）",
          "waitWithBarrier() 没有提示——兜底等待再久也只有一个转圈圈")
    wm_html = read(INDEX_HTML)
    check('id="wait-hint"' in wm_html,
          "index.html 的兜底遮罩内含 #wait-hint 元素",
          "index.html 里找不到 #wait-hint——showHint 在兜底遮罩上无处落笔")
    check(".wait-hint" in css and ".wait-hint.is-shown" in css,
          "preload.css 定义了 .wait-hint 与其显示态 .is-shown",
          "preload.css 缺少 .wait-hint / .wait-hint.is-shown——兜底遮罩上的提示不可见")

    # 12c. 超时只解除等待，不中止下载
    print("超时不得中止下载")
    for name in ("preloadImage", "probeImage"):
        body = body_of(src, r"" + name) or ""
        if not body:
            check(False, "", f"找不到 {name}() 函数体（声明形式变了？请更新本测试）")
            continue
        m_to = re.search(r"setTimeout\(\s*(\w+)\s*,\s*ASSET_TIMEOUT\s*\)", body)
        check(m_to is not None and m_to.group(1) in ("settle", "release"),
              f"{name}() 的 ASSET_TIMEOUT 只调放行函数（settle），不顺手释放引用",
              f"{name}() 的超时又去调 finish/done —— 释放强引用后 GC 会中止在途请求"
              "（Network 面板出 ERR_ABORTED），页面用到时再下一次，预加载白做")
        check("releaseInflight(" in body and "function drop(" in body,
              f"{name}() 把「放行等待」与「释放引用」分成两个动作",
              f"{name}() 没有把两件事分开——下载中的元素会被提前解除引用")

    # 12d. 舞台转场：换图期间不得被推进打断
    print("背景转场与推进的互斥")
    di = body_of(sjs, r"decodeImage") or ""
    check("setTimeout(" in di and "DECODE_TIMEOUT_MS" in di,
          "decodeImage() 有超时（图没有响应时不会把玩家永久留在黑幕里）",
          "decodeImage() 没有超时——一次无响应的取图会让幕布永远不揭、state.waiting 永不解除")
    sb = body_of(sjs, r"setBg") or ""
    i_pending, i_decode = sb.find("pending: true"), sb.find("decodeImage(")
    check(i_pending >= 0 and i_decode >= 0 and i_pending < i_decode,
          "setBg() 先登记转场（pending）再解码——解码期间的点击不会绕过转场判断",
          "setBg() 等 decodeImage 落定才登记 bgFade——解码期间的点击会直接推进剧情、"
          "作废这次换图，幕布停在满幕（背景全黑）")
    check("pending: false" in sb,
          "setBg() 在解码完成后把 pending 置回 false（点击恢复「立刻结束转场」语义）",
          "setBg() 没有把 pending 置回 false——转场期间的点击会一直被吞掉")
    nx = body_of(sjs, r"next") or ""
    check("pending" in nx,
          "next() 在转场 pending（新图还在解码）期间吸收点击",
          "next() 不看 pending——解码期间点击会把换图作废，幕布停在满幕")
    adv2 = body_of(sjs, r"advance") or ""
    check("state.step++" in adv2,
          "advance() 递增 state.step（转场据此判断「解码期间这一步有没有被推过」）",
          "advance() 不再递增 state.step——setBg 里那个判断永远为假，成为死代码")

    print("模板默认值")
    info = json.loads(read(INFO_JSON))
    pre = info.get("preload", {})
    for key in ("timeout", "onTimeout", "slowSpeedKBps", "lookahead", "chapter", "stage",
                "fastForward", "fallback"):
        check(key in pre,
              f"模板 info.json 写明 preload.{key}",
              f"模板 info.json 缺少 preload.{key}——模板即默认值来源，必须显式写出")
    check(pre.get("onTimeout") == "hint",
          '模板 info.json 的默认方案是 onTimeout="hint"（测速提示）',
          '模板 info.json 的 onTimeout 不是 "hint"——「显示提示文字」才是引擎的默认方案')
    st = pre.get("stage") or {}
    check("preludeBudgetSeconds" in st,
          f"模板 info.json 写明 stage.preludeBudgetSeconds = {st.get('preludeBudgetSeconds')!r}",
          "模板 info.json 缺少 stage.preludeBudgetSeconds——章首加载页的前奏会失去下载时间预算")
    check("predictLookahead" not in pre,
          "旧的 predictLookahead（按条数）已移除",
          "模板 info.json 里还有 predictLookahead——按条数与按秒两套单位不该并存")
    la = pre.get("lookahead") or {}
    # 模式常量必须与 script.js 的定时器周期一致：两处数字漂移会让窗口长度算错
    m_auto = re.search(r"state\.autoTimer\s*=\s*setInterval\([^,]+,\s*(\d+)\s*\)", sjs)
    m_skip = re.search(r"state\.skipTimer\s*=\s*setInterval\([^,]+,\s*(\d+)\s*\)", sjs)
    check(m_auto and abs(la.get("autoLineSeconds", 0) * 1000 - int(m_auto.group(1))) < 1e-6,
          f"lookahead.autoLineSeconds 与 script.js 的 autoTimer（{m_auto.group(1) if m_auto else '?'}ms）一致",
          "lookahead.autoLineSeconds 与 script.js 的 autoTimer 不一致——自动模式下窗口长度会算错")
    check(m_skip and abs(la.get("skipLineSeconds", 0) * 1000 - int(m_skip.group(1))) < 1e-6,
          f"lookahead.skipLineSeconds 与 script.js 的 skipTimer（{m_skip.group(1) if m_skip else '?'}ms）一致",
          "lookahead.skipLineSeconds 与 script.js 的 skipTimer 不一致——快进下窗口长度会算错")
    fb = pre.get("fallback") or {}
    check(fb.get("image") == "block" and fb.get("audio") == "degrade",
          '模板默认：图片 block（画面缺失可见）、音频 degrade（占体积 61% 却不影响画面）',
          "模板的 fallback 默认值变了——图片必须 block、音频必须 degrade")
    md = fb.get("maskDelayMs")
    check(isinstance(md, (int, float)) and 0 <= md <= 5000,
          f"模板 info.json 写明 fallback.maskDelayMs = {md!r}（遮罩显示延迟）",
          "模板 info.json 缺少 fallback.maskDelayMs——遮罩会在缓存命中时闪一下")

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
