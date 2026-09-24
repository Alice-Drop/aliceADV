/* =========================================================
 * preload.js 时间轴规划器的可执行测试载体 (harness)
 *
 * 为什么需要它：
 *   plan() 是纯计算 —— 给一段剧本和当前位置，产出「哪些资源、什么时候要用、按什么顺序拉」。
 *   它的正确性（时间累加、分支分叉、章边界、排序键）**没有任何静态断言能守住**：
 *   少写一个 acc、把 decide 的分支串行累加，代码看上去都同样合理，只有把数算出来才看得见。
 *   而这类错误在真机上表现为「快进时音乐永远慢一拍」或「第二条分支的资源从不下发」，
 *   极难从现象反推。
 *
 * 做法：
 *   用 node 的 vm 建一个最小沙箱，把 preload.js 原样跑起来（只提供 document / __THEME__ /
 *   __SCRIPTS__ / __ASSETS__ 这几个它需要的东西），然后直接调 plan()。
 *   本文件只负责「跑出数」，断言全在 test_preload_plan.py 里 —— 与其它测试保持一致。
 *
 * 用法：
 *   node preload_plan_harness.js <path/to/preload.js>      # 结果以 JSON 打到 stdout
 *
 * 沙箱里的 Image / Audio 是空壳，永不触发 load —— 本测试不发起任何下载。
 * 末尾 process.exit(0) 是为了不去等那些按 ASSET_TIMEOUT 挂起的定时器。
 * ========================================================= */

"use strict";

const fs = require("fs");
const vm = require("vm");

const PRELOAD_JS = process.argv[2];
if (!PRELOAD_JS) {
    console.error("用法: node preload_plan_harness.js <path/to/preload.js>");
    process.exit(2);
}
const SRC = fs.readFileSync(PRELOAD_JS, "utf8");

/* 建一个最小可用的引擎实例，返回 window.AliceADVPreload。 */
function engine(theme, scripts, assets) {
    const sandbox = {
        console: { warn() {}, log() {}, error() {} },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        clearInterval: clearInterval
    };
    sandbox.window = sandbox;
    sandbox.document = {
        baseURI: "http://localhost/",
        hidden: false,
        getElementById: function () { return null; },
        querySelector: function () { return null; }
    };
    // 不产生任何 Resource Timing 条目 → measureSpeedKBps() 返回 null
    // → estimateSeconds() 走标称值 500 KB/s。断言里的预计耗时都按这个口径手算。
    sandbox.performance = { getEntriesByType: function () { return []; } };
    sandbox.Image = function () {};
    sandbox.Audio = function () {};
    sandbox.__THEME__ = { info: { preload: theme || {} } };
    sandbox.__SCRIPTS__ = scripts || {};
    sandbox.__ASSETS__ = assets || {};
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: "preload.js" });
    return sandbox.AliceADVPreload;
}

/* ---------- 剧本小工具 ---------- */
function say(char, voice) {
    const c = { cmd: "say", char: char || "a", text: "……" };
    if (voice) c.voice = voice;
    return c;
}
function narrate() { return { cmd: "narrate", text: "……" }; }
function bg(src) { return { cmd: "bg", src: src }; }
function show(char, sprite) { return { cmd: "show", char: char, sprite: sprite }; }
function music(src) { return { cmd: "music", src: src }; }
function goto(seg) { return { cmd: "goto", segment: seg }; }
function decide(targets) {
    return { cmd: "decide", options: targets.map(function (t) { return { text: "t", goto: t }; }) };
}
function filler(n) { const a = []; for (let i = 0; i < n; i++) a.push(say()); return a; }

/* 扁平剧本（无 chapters）：整个文件就是一整章，不存在边界。 */
function flat(segments, start) {
    const s = { segments: segments };
    if (start) s.start = start;
    s.__segChapter = null;
    return s;
}
/* 两层次剧本：chapters → 扁平 segments + __segChapter（由 script.js 的 normalizeScript 生成，
 * 这里手工构造同样的形状）。 */
function nested(chapters) {
    const segments = {};
    const segChapter = {};
    for (const chName in chapters) {
        const segs = chapters[chName];
        for (const segName in segs) {
            segments[segName] = segs[segName];
            segChapter[segName] = chName;
        }
    }
    return { segments: segments, __segChapter: segChapter };
}

function slim(items) {
    return items.map(function (it) {
        return {
            url: it.url, kind: it.kind, voice: !!it.voice,
            deadline: it.deadline, size: it.size, slack: it.slack, tier: it.tier
        };
    });
}
function byUrl(items, url) {
    for (let i = 0; i < items.length; i++) if (items[i].url === url) return items[i];
    return null;
}
function round(x, n) { const p = Math.pow(10, n == null ? 6 : n); return Math.round(x * p) / p; }

/* ---------- 共用素材体积（字节）----------
 * 体积只参与「预计耗时 = size / 1024 / 500」，因此这些数字直接决定 slack。 */
const ASSETS = {
    "bg/a.png": { size: 1024, type: "image" },
    "bg/b.png": { size: 1024, type: "image" },
    "bg/c.png": { size: 1024, type: "image" },
    "bg/d.png": { size: 1024, type: "image" },
    "bg/shared.png": { size: 1024, type: "image" },
    "img/soon.png": { size: 1024, type: "image" },              // 1 KB
    "img/small.png": { size: 50 * 1024, type: "image" },        // 50 KB
    "img/big.png": { size: 10 * 1024 * 1024, type: "image" },   // 10 MB
    "audio/m.mp3": { size: 3 * 1024 * 1024, type: "audio" },
    "voice/v1.mp3": { size: 200 * 1024, type: "audio" },
    "char/a.png": { size: 400 * 1024, type: "image" },
    "char/a_alt.png": { size: 400 * 1024, type: "image" },
    "gui/box.png": { size: 100 * 1024, type: "image" }
};
/* 角色档案：给 say/show 提供对话框与立绘（needsOf 会据此产出额外资源） */
const CHARS = {
    "story/characters.json": {
        "a": { name: "A", textbox: "gui/box.png", sprites: { "normal": "char/a.png", "smile": "char/a_alt.png" } }
    }
};

const out = {};

/* ===== S1 时间累加：deadline = 该指令之前所有阻塞指令的耗时之和 ===== */
{
    const P = engine({}, CHARS, ASSETS);
    const script = flat({
        start: [say(), say(), bg("bg/a.png"), say()]
    });
    const items = slim(P.plan(script, "start", 0));
    out.s1 = { deadlineA: byUrl(items, "bg/a.png").deadline };
}

/* ===== S2 goto 是顺序关系：目标段的 acc 接着当前段累加 ===== */
{
    const P = engine({}, CHARS, ASSETS);
    const script = flat({
        start: [say(), goto("s1")],
        s1: [say(), bg("bg/b.png")]
    });
    const items = slim(P.plan(script, "start", 0));
    out.s2 = { deadlineB: byUrl(items, "bg/b.png").deadline };
}

/* ===== S3 decide 各分支从同一个 acc 分叉（不得串行累加）===== */
{
    const P = engine({}, CHARS, ASSETS);
    const script = flat({
        start: [say(), say(), decide(["s1", "s2"])],
        s1: [bg("bg/c.png")],
        s2: [bg("bg/d.png")]
    });
    const items = slim(P.plan(script, "start", 0));
    out.s3 = {
        deadlineC: byUrl(items, "bg/c.png").deadline,
        deadlineD: byUrl(items, "bg/d.png").deadline
    };
}

/* ===== S4 章边界：scope=current 不跨章，scope=all 跨 ===== */
{
    const chapters = {
        ch1: { s1: [say(), goto("s2")] },
        ch2: { s2: [say(), bg("bg/a.png")] }
    };
    const scriptCurrent = nested(chapters);
    const PC = engine({ chapter: { scope: "current" } }, CHARS, ASSETS);
    const cur = slim(PC.plan(scriptCurrent, "s1", 0));

    const scriptAll = nested(chapters);
    const PA = engine({ chapter: { scope: "all" } }, CHARS, ASSETS);
    const all = slim(PA.plan(scriptAll, "s1", 0));

    out.s4 = {
        currentHasA: !!byUrl(cur, "bg/a.png"),
        allHasA: !!byUrl(all, "bg/a.png")
    };
}

/* ===== S5 排序键：tier 升序 → slack 升序（体积只参与预计耗时）=====
 * 逐条手算（每句 3 秒，标称速率 500 KB/s，窗口 30 s，上界 180 s）：
 *   idx 1   img/soon.png   1 KB    →  deadline 3   est 0.002   slack 2.998   tier 1
 *   idx 6   img/small.png  50 KB   →  deadline 15  est 0.1     slack 14.9    tier 1
 *   idx 20  img/big.png    10 MB   →  deadline 54  est 20.48   slack 33.52   tier 2
 *   （idx 0/2/3/4/5 与 7..19 共 18 条 say；idx 20 的 acc = 3×18 = 54） */
{
    const P = engine({}, CHARS, ASSETS);
    const list = filler(22);
    list[1] = bg("img/soon.png");
    list[6] = bg("img/small.png");
    list[20] = bg("img/big.png");
    const items = slim(P.plan(flat({ start: list }), "start", 0));
    const soon = byUrl(items, "img/soon.png");
    const small = byUrl(items, "img/small.png");
    const big = byUrl(items, "img/big.png");
    out.s5 = {
        order: items.map(function (it) { return it.url; }),
        soon: { deadline: soon.deadline, slack: round(soon.slack), tier: soon.tier },
        small: { deadline: small.deadline, slack: round(small.slack), tier: small.tier },
        big: { deadline: big.deadline, slack: round(big.slack), tier: big.tier },
        tiersAscending: items.every(function (it, i) { return i === 0 || items[i - 1].tier <= it.tier; }),
        slackAscendingWithinTier: items.every(function (it, i) {
            if (i === 0 || items[i - 1].tier !== it.tier) return true;
            return items[i - 1].slack <= it.slack + 1e-9;
        })
    };
}

/* ===== S6 快进时语音出队（预载侧），音乐不受影响 ===== */
{
    const script = flat({ start: [say("a", "voice/v1.mp3"), music("audio/m.mp3")] });

    const PN = engine({}, CHARS, ASSETS);
    PN.setPlaybackMode("normal");
    const normal = slim(PN.plan(script, "start", 0));

    const PS = engine({}, CHARS, ASSETS);
    PS.setPlaybackMode("skip");
    const skip = slim(PS.plan(script, "start", 0));

    const POff = engine({ fastForward: { skipVoice: false } }, CHARS, ASSETS);
    POff.setPlaybackMode("skip");
    const skipVoiceOff = !!byUrl(slim(POff.plan(script, "start", 0)), "voice/v1.mp3");

    out.s6 = {
        normalHasVoice: !!byUrl(normal, "voice/v1.mp3"),
        skipHasVoice: !!byUrl(skip, "voice/v1.mp3"),
        normalHasMusic: !!byUrl(normal, "audio/m.mp3"),
        skipHasMusic: !!byUrl(skip, "audio/m.mp3"),
        // 作者显式关掉开关后，快进也不排除语音
        skipVoiceOffHasVoice: skipVoiceOff
    };
}

/* ===== S7 同一剧本、同一位置：窗口内容随播放模式变化 =====
 * 20 句之后才是 bg/late.png：正常 3.0 s/句 → deadline 60（远档）；快进 0.18 s/句 → 3.6（高保障区） */
{
    const script = flat({ start: filler(20).concat([bg("bg/a.png")]) });

    const PN = engine({}, CHARS, ASSETS);
    PN.setPlaybackMode("normal");
    const normal = byUrl(slim(PN.plan(script, "start", 0)), "bg/a.png");

    const PA = engine({}, CHARS, ASSETS);
    PA.setPlaybackMode("auto");
    const auto = byUrl(slim(PA.plan(script, "start", 0)), "bg/a.png");

    const PS = engine({}, CHARS, ASSETS);
    PS.setPlaybackMode("skip");
    const skip = byUrl(slim(PS.plan(script, "start", 0)), "bg/a.png");

    out.s7 = {
        normal: { deadline: round(normal.deadline), tier: normal.tier },
        auto: { deadline: round(auto.deadline), tier: auto.tier },
        skip: { deadline: round(skip.deadline), tier: skip.tier }
    };
}

/* ===== S8 每句耗时来自实测（EWMA），不是写死的 3 秒 =====
 * 连报 5 次 1.0 秒 → 平均 1.0 → idx 3 的资源的 deadline 应是 3，而不是 9。 */
{
    const P = engine({}, CHARS, ASSETS);
    P.setPlaybackMode("normal");
    for (let i = 0; i < 5; i++) P.reportDwell(1.0);
    const line = P.currentLineSeconds();
    const script = flat({ start: [say(), say(), say(), bg("bg/a.png")] });
    const items = slim(P.plan(script, "start", 0));

    // 越界的样本（玩家挂机 25 秒）不得进入平均：DWELL_MAX = 20
    const before = P.getDwellSeconds();
    P.reportDwell(25);
    const after = P.getDwellSeconds();

    out.s8 = {
        lineSeconds: round(line, 4),
        deadlineA: round(byUrl(items, "bg/a.png").deadline, 4),
        avgBefore: round(before, 4),
        avgAfterOutlier: round(after, 4)
    };
}

/* ===== S9 超过 horizon 的留到下次推进：不排队 =====
 * 窗口 5 s、上界 10 s。idx 2 的 bg/a.png 在 acc 6 被记下 → 超过窗口（tier 2）；
 * idx 5 的 bg/b.png 在 acc 12 被记下 → 超过上界，整条从待发集合里消失。 */
{
    const P = engine({ lookahead: { windowSeconds: 5, horizonSeconds: 10 } }, CHARS, ASSETS);
    P.setPlaybackMode("normal");
    const script = flat({ start: [say(), say(), bg("bg/a.png"), say(), say(), bg("bg/b.png")] });
    const items = slim(P.plan(script, "start", 0));
    out.s9 = {
        hasA: !!byUrl(items, "bg/a.png"),
        deadlineA: byUrl(items, "bg/a.png").deadline,
        tierA: byUrl(items, "bg/a.png").tier,
        hasB: !!byUrl(items, "bg/b.png")
    };
}

/* ===== S10 maxInstructions 截断 =====
 * 注意 getStrategy 给 maxInstructions 的下限是 10（防误配成个位数），所以这里取 10：
 * 只扫到 idx 9，idx 12 的 bg/a.png 不会被记下。 */
{
    const P = engine({ lookahead: { maxInstructions: 10 } }, CHARS, ASSETS);
    const script = flat({ start: filler(12).concat([bg("bg/a.png")]) });
    out.s10 = { hasA: !!byUrl(slim(P.plan(script, "start", 0)), "bg/a.png") };
}

/* ===== S11 当前这条指令的资源是 T0（deadline 0）===== */
{
    const P = engine({}, CHARS, ASSETS);
    const script = flat({ start: [say(), say(), bg("bg/a.png")] });
    const it = byUrl(slim(P.plan(script, "start", 2)), "bg/a.png");
    out.s11 = { deadline: it.deadline, tier: it.tier };
}

/* ===== S12 资源归属不能按段推断（读档从章中进入）=====
 * bg/shared.png 在第 1 段出现过，玩家从第 3 段读档进入时**必须**重新纳入规划——
 * 因为那一段之后它又会被用，而玩家进这一局时它一张都没下过。 */
{
    const P = engine({}, CHARS, ASSETS);
    const script = flat({
        s1: [bg("bg/shared.png"), say()],
        s2: [say()],
        s3: [say(), bg("bg/shared.png")]
    });
    const fromStart = slim(P.plan(script, "s1", 0));
    const fromSave = slim(P.plan(script, "s3", 0));
    out.s12 = {
        fromStartHas: !!byUrl(fromStart, "bg/shared.png"),
        fromSaveHas: !!byUrl(fromSave, "bg/shared.png"),
        fromSaveDeadline: byUrl(fromSave, "bg/shared.png").deadline
    };
}

/* ===== S13 chapterAssets 是全量并集，不按段裁剪 ===== */
{
    const P = engine({}, CHARS, ASSETS);
    const script = nested({
        ch1: { s1: [say()], s2: [say(), bg("bg/a.png")] }
    });
    const list = P.chapterAssets(script, "s1");
    out.s13 = {
        hasBox: list.indexOf("gui/box.png") >= 0,
        hasA: list.indexOf("bg/a.png") >= 0,
        count: list.length
    };
}

/* ===== S14 barrier 的形状：不需要等就返回 null（而不是已 resolve 的 Promise）===== */
{
    const P = engine({}, CHARS, ASSETS);
    const nonResource = P.barrier({ cmd: "set", var: "x", value: 1 });
    // 图片策略为 block 且未就绪 → 返回可等待对象
    const img = P.barrier({ cmd: "bg", src: "bg/a.png" });
    // 音频策略为 degrade 且未就绪 → 不等
    const aud = P.barrier({ cmd: "music", src: "audio/m.mp3" });
    out.s14 = {
        nonResourceIsNull: nonResource === null,
        imageIsThenable: !!(img && typeof img.then === "function"),
        audioIsNull: aud === null
    };
}

/* ===== S15 按钮与兜底默认值可被作者覆盖 ===== */
{
    const P = engine({ fallback: { image: "degrade" } }, CHARS, ASSETS);
    out.s15 = { imageDegradeDoesNotBlock: P.barrier({ cmd: "bg", src: "bg/a.png" }) === null };
}

process.stdout.write(JSON.stringify(out));
process.exit(0);
