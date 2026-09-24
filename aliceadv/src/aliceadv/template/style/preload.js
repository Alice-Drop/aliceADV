/* =========================================================
 * aliceADV engine — 资源预加载与调度器 (preload runtime)
 *
 * 职责：
 *   1. 启动加载遮罩（#boot-mask）：进入网页时显示纯黑遮罩 + 转圈圈，
 *      按 info.json preload.boot 策略强制加载指定素材，就绪后渐隐消失。
 *      超过 preload.timeout 仍未就绪时按 preload.onTimeout 处理（放行 / 提示，见 waitForPaint）。
 *   2. 章首加载页：enterStage() 在进入舞台前按「首帧关键集 + 前奏窗口」等待，
 *      或按 chapter.preload="complete" 等待全章可达资源。
 *   3. 运行时调度：每次剧本推进调用一次 plan()，把「接下来会用到的资源」
 *      按 deadline（第一次被使用的时间，秒）排序后放进保序限并发的队列。
 *   4. 兜底：指令执行前调用 barrier()，按 fallback 配置决定「等待 / 降级 / 原生缺失」。
 *
 * 三条不可动摇的性质：
 *   A. 发起顺序 = 下载顺序。浏览器每源只允许约 6 条并发连接，超出的请求按发起顺序
 *      排队，所以「按什么顺序把 URL 交给队列」就是这套机制的全部要害。
 *   B. 前瞻的单位是秒，不是指令条数。窗口长度固定为秒，条数由实测播放速度换算
 *      （玩家点得快、开了自动或快进，同样 30 秒覆盖的剧情就更多）。
 *   C. 资源是否就绪，唯一依据是运行时的真实状态记录（records）；不得使用
 *      「它在更早的段里出现过」「这一局里已经播过」之类的推断来跳过预载 ——
 *      玩家可以从章内任意位置读档进入，那些资源很可能一张都没下载过。
 *
 * 策略来源：info.json 的 preload 字段（构建时合并进 window.__THEME__.info）。
 *   preload.boot / runtime / timeout / onTimeout / slowSpeedKBps
 *   preload.lookahead   窗口与每句耗时（秒）
 *   preload.chapter     搜索上界与加载强度
 *   preload.stage       章首加载页的前奏窗口
 *   preload.fastForward 快进时的语音策略
 *   preload.fallback    资源未就绪时的动作
 * 完整原理见 docs/预加载.md；字段定义见 docs/信息配置.md §5。
 * ========================================================= */

(function (global) {
    "use strict";

    /* ---------- 常量 ---------- */

    /* 遮罩与测速 */
    var DEFAULT_TIMEOUT = 12000;   // preload.timeout 缺省值（ms）：遮罩等多久后触发 onTimeout 策略
    var MIN_TIMEOUT = 1000;        // preload.timeout 下限（ms）
    var MAX_TIMEOUT = 120000;      // preload.timeout 上限（ms）
    var DEFAULT_SLOW_KBPS = 250;   // preload.slowSpeedKBps 缺省值（KB/s）：判定「网速慢」的阈值
    var MIN_SPEED_SAMPLE = 8192;   // 测速时只采信体积 ≥ 8KB 的响应样本（小响应一次突发就会失真）

    /* 测速样本的时效窗口（ms）。只采信「最近这么久之内**完成**」的传输。
     * 为什么必须有时效：中途限速（DevTools 打开限速）后，若仍把限速前那些全速传输
     * 算进「最快的一次」，估计值会永远停在限速前的水平（实测会停在 150 MB/s 量级），
     * 于是提示文案把「网络较慢」误判成「资源体积较大」，预计耗时也全部失真。
     * 窗口内无样本时，退回「最近一次采信值」，但它同样有时效（见 RATE_STICKY_MS）。 */
    var SPEED_WINDOW_MS = 10000;
    var RATE_STICKY_MS = 60000;

    /* 兜底遮罩的显示延迟（ms，preload.fallback.maskDelayMs 的缺省值）。
     * 等待是「先等一小会，超过这个延迟才把转圈圈亮出来」：绝大多数指令的资源都在缓存里，
     * 几毫秒就绪，立刻显示遮罩会闪一下；超过这个延迟才说明「真的在等网络」。 */
    var DEFAULT_MASK_DELAY_MS = 150;

    /* 单个资源「等待」超时（ms）。只解除等待、不中止下载。
     * 过小（如 8s）会在限速下提前放行队列 → 限并发失效（见 pump）。
     * 它同时是遮罩与 barrier 的内在兜底：单个坏资源最多占用 ASSET_TIMEOUT。 */
    var ASSET_TIMEOUT = 30000;

    var CONCURRENCY = 4;           // 并发窗口：既保序又不占满浏览器连接池

    /* 时间模型（preload.lookahead 的缺省值） */
    var DEFAULT_WINDOW_SECONDS = 30;      // 高保障区：全力保证这么多秒内的资源
    var DEFAULT_HORIZON_SECONDS = 180;    // 规划上界：超过就不排队，留到下次推进重算
    var DEFAULT_MAX_INSTRUCTIONS = 600;   // 单次遍历的指令条数上限（防止快进时一次扫过整章）
    var DEFAULT_LINE_SECONDS = 3;         // 无实测样本时每句耗时
    var DEFAULT_AUTO_LINE_SECONDS = 2.6;  // 自动模式每句耗时，与 script.js 的 autoTimer 周期一致
    var DEFAULT_SKIP_LINE_SECONDS = 0.18; // 快进模式每句耗时，与 script.js 的 skipTimer 周期一致
    var WAIT_DEFAULT_SECONDS = 0.8;       // wait 不带时长时 script.js 的缺省（800ms）
    var DEFAULT_PRELUDE_SECONDS = 60;     // 章首加载页选取前奏资源的剧情秒数（「接下来 60 秒要用到的」）
    var DEFAULT_PRELUDE_BUDGET_SECONDS = 8; // 章首加载页为前奏**最多花掉的下载时间**（按实测速率折算）
                                            // 为什么必须有它：前奏是按剧情秒选的，字节数没有上界
                                            // （实测某章 60 剧情秒内有约 19 MB 图片 + 12 张角色对话框），
                                            // 慢网下会变成让玩家干等一分半。首帧关键集不受此预算约束。

    /* 无实测网速时的估计值（KB/s）。file:// 下 Resource Timing 恒为空，此时只能取一个中间值。 */
    var NOMINAL_RATE_KBPS = 500;

    /* 播放速度实测（EWMA） */
    var DWELL_ALPHA = 0.3;    // 指数滑动平均系数
    var DWELL_SAMPLES = 8;    // 前 8 句用累计平均，避免开局样本把估计拉偏
    var DWELL_MIN = 0.4;      // 单句耗时样本下限（秒）：低于此值多为连点/误触
    var DWELL_MAX = 20;       // 上限（秒）：玩家挂机几分钟不能被当成「正常节奏」

    /* 资源体积缺省值（KB）：清单命中时用真实大小，未命中时按类型估。 */
    var DEFAULT_IMAGE_BYTES = 800 * 1024;
    var DEFAULT_AUDIO_BYTES = 3500 * 1024;

    /* 遮罩提示文案（见 waitForPaint）。
     * 属于引擎级 UI 文字，与 theme.js 的 I18N 同类：描述的是引擎行为，不是游戏内容，
     * 因此不放进 theme.json / info.json，也不随主题变化。 */
    var HINT_SLOW  = "当前网络较慢，加载可能需要较长时间";
    var HINT_LARGE = "游戏资源体积较大，加载需要更多时间";

    var IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|#|$)/i;
    var AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac|opus)(\?|#|$)/i;

    /* 计入时间轴的阻塞指令（每执行一条，玩家要花掉「一句」的时间）。
     * 与 script.js 的 exec() 返回 true 的那些分支一一对应。 */
    var LINE_CMDS = { say: 1, narrate: 1, title: 1, decide: 1 };

    var FALLBACK_ACTIONS = ["block", "degrade", "missing"];

    /* ---------- 资源路径解析（与 theme.js resolveAsset 一致） ----------
     * 绝对/协议/data URI 原样返回；工程根相对路径原样返回（baseURI 为 dist/web/）。 */
    function resolveAsset(p) {
        if (!p) return "";
        if (/^(https?:|data:|\/\/|\/)/.test(p)) return p;
        return p;
    }

    /* ---------- 读取 info.preload 策略 ----------
     * 构建产物：window.__THEME__.info.preload（builder 把 info.json 合并进 theme.info）。
     * 模板模式：theme.js loadTheme() 会把 fetch 到的 info.json 挂到 theme.info。
     * 缺省值与模板 info.json 的取值一致（模板即默认值来源）。 */
    function numOr(v, def, min, max) {
        if (typeof v !== "number" || !isFinite(v)) return def;
        if (v < min) return min;
        if (max != null && v > max) return max;
        return v;
    }
    function boolOr(v, def) { return v == null ? def : v !== false; }
    function pickAction(v, def) {
        return FALLBACK_ACTIONS.indexOf(v) === -1 ? def : v;
    }

    function getStrategy() {
        var info = (global.__THEME__ && global.__THEME__.info) || {};
        var pre = info.preload || {};

        var boot = pre.boot;
        if (!boot || ["none", "title", "system", "title+story"].indexOf(boot) === -1) {
            boot = "title";
        }
        /* runtime 允许数组或单个字符串；写成别的类型（数字、对象）视为未配置。
         * 不能直接 .filter——非数组没有该方法，会在 getStrategy() 里抛错，
         * 而 boot() 一进来就调它，抛错等于整个预加载模块失效、遮罩永不揭开。 */
        var rt = pre.runtime;
        if (rt == null) rt = ["page", "predict"];
        if (typeof rt === "string") rt = [rt];
        if (!Array.isArray(rt)) rt = ["page", "predict"];
        rt = rt.filter(function (k) { return k === "page" || k === "predict"; });

        var la = pre.lookahead || {};
        var ch = pre.chapter || {};
        var st = pre.stage || {};
        var ff = pre.fastForward || {};
        var fb = pre.fallback || {};

        var windowSeconds = numOr(la.windowSeconds, DEFAULT_WINDOW_SECONDS, 1, 3600);
        var horizonSeconds = numOr(la.horizonSeconds, DEFAULT_HORIZON_SECONDS, 1, 7200);
        if (horizonSeconds < windowSeconds) horizonSeconds = windowSeconds;

        return {
            boot: boot,
            runtime: rt,
            timeout: numOr(pre.timeout, DEFAULT_TIMEOUT, MIN_TIMEOUT, MAX_TIMEOUT),
            onTimeout: (pre.onTimeout === "release") ? "release" : "hint",
            slowSpeedKBps: numOr(pre.slowSpeedKBps, DEFAULT_SLOW_KBPS, 1, null),
            lookahead: {
                windowSeconds: windowSeconds,
                horizonSeconds: horizonSeconds,
                maxInstructions: numOr(la.maxInstructions, DEFAULT_MAX_INSTRUCTIONS, 10, 100000),
                defaultLineSeconds: numOr(la.defaultLineSeconds, DEFAULT_LINE_SECONDS, 0.05, 120),
                autoLineSeconds: numOr(la.autoLineSeconds, DEFAULT_AUTO_LINE_SECONDS, 0.05, 120),
                skipLineSeconds: numOr(la.skipLineSeconds, DEFAULT_SKIP_LINE_SECONDS, 0.01, 120)
            },
            chapter: {
                scope: (ch.scope === "all") ? "all" : "current",
                preload: (ch.preload === "complete") ? "complete" : "adaptive"
            },
            stage: {
                preludeSeconds: numOr(st.preludeSeconds, DEFAULT_PRELUDE_SECONDS, 0, 3600),
                preludeImagesOnly: boolOr(st.preludeImagesOnly, true),
                preludeBudgetSeconds: numOr(st.preludeBudgetSeconds, DEFAULT_PRELUDE_BUDGET_SECONDS, 0, 600)
            },
            fastForward: { skipVoice: boolOr(ff.skipVoice, true) },
            fallback: {
                default: pickAction(fb.default, "degrade"),
                image: pickAction(fb.image, "block"),
                audio: pickAction(fb.audio, "degrade"),
                allowSkipWait: boolOr(fb.allowSkipWait, true),
                maskDelayMs: numOr(fb.maskDelayMs, DEFAULT_MASK_DELAY_MS, 0, 5000)
            }
        };
    }

    /* ---------- 播放模式与每句耗时 ----------
     * playback 由 script.js 的 setAuto / setSkip 上报。正常模式下的速度来自实测：
     * script.js 每推进一句调用一次 reportDwell(间隔秒数)，这里做 EWMA。
     * 后台标签页不采样（玩家切出去几分钟再回来点一下，会把估计拉到几百秒）。 */
    var playback = "normal";                 // "normal" | "auto" | "skip"
    var dwell = { samples: 0, avg: 0 };

    function setPlaybackMode(mode) {
        playback = (mode === "auto" || mode === "skip") ? mode : "normal";
        return playback;
    }
    function getPlaybackMode() { return playback; }

    function reportDwell(seconds) {
        if (!(seconds > 0) || !isFinite(seconds)) return null;
        if (seconds < DWELL_MIN || seconds > DWELL_MAX) return dwell.avg || null;
        if (global.document && global.document.hidden) return dwell.avg || null;
        if (dwell.samples < DWELL_SAMPLES) {
            dwell.samples++;
            dwell.avg = dwell.avg + (seconds - dwell.avg) / dwell.samples; // 前几句：累计平均
        } else {
            dwell.avg = DWELL_ALPHA * seconds + (1 - DWELL_ALPHA) * dwell.avg;
        }
        return dwell.avg;
    }
    function getDwellSeconds() { return dwell.avg > 0 ? dwell.avg : null; }
    function resetDwell() { dwell.samples = 0; dwell.avg = 0; }

    /* 当前「一句」的耗时（秒）。模式常量与 script.js 的定时器周期一致：
     * autoTimer 2600ms、skipTimer 180ms —— 改动那两个常量时必须同步 info.json 的缺省值。 */
    function currentLineSeconds() {
        var la = getStrategy().lookahead;
        if (playback === "skip") return la.skipLineSeconds;
        if (playback === "auto") return la.autoLineSeconds;
        return getDwellSeconds() || la.defaultLineSeconds;
    }

    /* 快进时是否跳过语音（不预载、不播放）。两处（预载与播放）共用这一个判据。 */
    function skipVoiceActive() {
        if (!getStrategy().fastForward.skipVoice) return false;
        if (playback === "skip") return true;
        var S = global.AliceADVScript;
        return !!(S && S.state && S.state.skip);
    }

    /* ---------- 编译期资源清单 ----------
     * 调度需要知道每个资源的体积，而浏览器在下载前无法得知，所以 builder 在构建时
     * 生成 window.__ASSETS__ = { "images/bg/x.png": { size, type } } 并内联进产物
     * （内联的理由与 __SCRIPTS__ 相同：file:// 下读不到独立 JSON 文件）。
     * 清单是「剧本、角色档案与 theme.json 里实际被引用的路径」的并集 —— 不按段裁剪，
     * 因为玩家可以从章内任意位置读档进入，任何「这一段没有它」的裁剪都会漏载。 */
    var assetsCache = null;
    function getAssets() {
        if (assetsCache === null) {
            var a = global.__ASSETS__;
            assetsCache = (a && typeof a === "object") ? a : {};
        }
        return assetsCache;
    }

    function assetSize(url) {
        var e = getAssets()[url];
        if (e && typeof e.size === "number" && e.size > 0) return e.size;
        return AUDIO_EXT.test(url) ? DEFAULT_AUDIO_BYTES : DEFAULT_IMAGE_BYTES;
    }
    function assetKind(url) {
        var e = getAssets()[url];
        if (e && e.type) return e.type;
        return AUDIO_EXT.test(url) ? "audio" : "image";
    }

    /* ---------- 资源就绪记录 ----------
     * url → { status: "pending"|"done"|"failed", started, keep, size, kind, promise }。
     * 这是「这个资源现在能不能用」的**唯一依据** —— 不看它属于哪一段、也不看它之前播没播过。
     * status 只在真实的 load/error 事件里改变；等待超时（ASSET_TIMEOUT）只让 promise 置 settled，
     * status 保持 "pending"（下载可能仍在继续，晚到的完成事件会把它改成 "done"）。 */
    var records = Object.create(null);

    /* 双队列 + 单一并发窗口。
     * boot 队列用于启动与进章（高优先），plan 队列用于运行时规划。
     * 两者共用一个并发计数，因此「进章时的大批资源」不会与「运行中的规划」各占一个窗口。 */
    var bootQueue = [];
    var planQueue = [];
    var inflightCount = 0;

    /* 发起一个资源的加载（若尚未发起）。priority=true 走 boot 队列。 */
    function ensure(url, keep, priority) {
        url = resolveAsset(url);
        if (!url) return Promise.resolve(null);
        var rec = records[url];
        if (rec) {
            if (keep) rec.keep = true;
            return rec.promise;
        }
        rec = records[url] = {
            status: "pending",
            started: false,
            keep: !!keep,
            size: assetSize(url),
            kind: assetKind(url),
            promise: null
        };
        rec.promise = new Promise(function (resolve) { rec._settle = resolve; });
        (priority ? bootQueue : planQueue).push(url);
        pump();
        return rec.promise;
    }

    function enqueue(items, priority) {
        var ps = [];
        (items || []).forEach(function (it) {
            if (!it) return;
            var url = (typeof it === "string") ? it : it.url;
            if (!url) return;
            ps.push(ensure(url, it && it.keep, priority));
        });
        return ps.length ? Promise.all(ps) : Promise.resolve([]);
    }

    /* 批量预载（保持数组顺序 = 发起顺序）。keep=true 时保留已解码位图，只用于外壳图小集合。 */
    function preloadAll(urls, keep, priority) {
        if (!urls || !urls.length) return Promise.resolve([]);
        return enqueue(urls.map(function (u) { return { url: u, keep: keep }; }), priority);
    }

    /* 保序限并发的泵。
     *
     * 为什么必须限并发、且必须保序：
     *   浏览器对同一源只允许约 6 条并发连接，超出的请求进入等待队列，并**按发起顺序**获得连接。
     *   若用 Promise.all 一次性把 N 个请求全部发出去，真实下载顺序就退化成「数组顺序」——
     *   发起顺序即优先级。因此这里的做法是：所有请求都登记在 records 里，但只有排在窗口内的
     *   才会真正被发起；boot 队列优先于 plan 队列。
     *
     * 已发起的请求不重排（HTTP 层不提供中途改优先级的能力），因此并发窗口内的最多 CONCURRENCY
     * 项不受重排影响 —— 这也是「不做抢占式带宽分配」的原因。 */
    function pump() {
        while (inflightCount < CONCURRENCY) {
            var url = bootQueue.length ? bootQueue.shift()
                    : (planQueue.length ? planQueue.shift() : null);
            if (!url) break;
            var rec = records[url];
            if (!rec || rec.started) continue;
            rec.started = true;
            inflightCount++;
            startLoad(url, rec);
        }
    }

    function startLoad(url, rec) {
        var p = (rec.kind === "audio") ? preloadAudio(url, rec) : preloadImage(url, rec);
        function done() {
            inflightCount--;
            if (rec._settle) rec._settle(rec.status);
            pump();
        }
        p.then(done, done);
    }

    /* 某个资源的等待是否已结束（完成 / 失败 / 等待超时）。 */
    function isReady(url) {
        var rec = records[resolveAsset(url)];
        return !!(rec && rec.status === "done");
    }
    function getRecords() { return records; }
    /* 兼容旧调用（调试与自动化验证脚本用）：返回「已发起过的资源」表。 */
    function getCache() { return records; }

    /* ---------- 预加载器（隐藏 Image / Audio 触发浏览器加载并缓存） ---------- */

    /* 已解码位图的强引用（只收「外壳图」这类小集合，见 collectChrome / collectCharTextboxes）。
     * 浏览器对已解码位图是弱缓存，被回收后再次绘制会重新增量解码，观感就是「图从上往下扫出来」。
     * 这批图数量少（十位数量级）且几乎每个页面都用，持有一份引用即可保证命中，代价可忽略。
     * 剧情背景/立绘可达上百张，不常驻解码位图，避免内存膨胀。 */
    var retained = [];
    var RETAIN_LIMIT = 64;

    /* 在途 Image 的强引用（与 retained 不同：这里不分 keep，所有下载中的图都持有）。
     * 若 Image 只被局部变量引用，GC 可能在下载途中回收它并**中止请求**，
     * 于是预加载「看起来发起过、却永远没完成」，页面真正用到时再请求一次 —— 即「逐行扫描」。 */
    var inflight = [];

    function retain(img, keep) {
        if (!keep || retained.length >= RETAIN_LIMIT) return;
        retained.push(img);
    }
    function releaseInflight(img) {
        var k = inflight.indexOf(img);
        if (k !== -1) inflight.splice(k, 1);
    }

    function preloadImage(url, rec) {
        return new Promise(function (resolve) {
            var img = new Image();
            inflight.push(img);
            var settled = false, released = false;
            // 放行「等待」：让调用方继续往下走，但**不碰引用、不摘事件**——请求还得跑完。
            function settle(v) { if (settled) return; settled = true; resolve(v); }
            // 真正结束（下载有了结果）：这时才可以释放强引用、摘掉事件。
            function drop() {
                if (released) return;
                released = true;
                releaseInflight(img);
                img.onload = img.onerror = null;
            }
            function done(ok) {
                if (rec) { rec.status = "done"; if (ok) retain(img, rec.keep); }
                drop(); settle("done");
            }
            img.onload = function () {
                // 等待位图解码完成再放行：预加载阶段把图解码好之后，
                // 进舞台 setBg 首帧即可直接绘制，避免「数据已下载但未解码」的黑闪。
                if (!img.decode) { done(true); return; }
                img.decode().then(function () { done(true); }, function () { done(false); });
            };
            img.onerror = function () {
                if (rec) rec.status = "failed";
                drop(); settle("failed");
            };
            // 超时只放行「等待」，**不释放强引用、不中止下载**：请求继续跑完进入缓存，
            // 否则限速下会「提前放行 → 队列继续发起 → 真正在途的越来越多」，限并发形同虚设。
            // 早期版本这里调用的 finish() 顺手释放了引用，于是 img 只剩事件回调这一条引用
            //（随后也被摘掉）——GC 回收元素时 Chrome 会**中止在途请求**（Network 面板可见
            // ERR_ABORTED），页面真正用到这张图时再请求一次，观感就是「预加载发起过、
            // 但网速一慢什么都没留下」。放行等待与释放引用是两件事，必须分开做。
            setTimeout(settle, ASSET_TIMEOUT);
            img.src = url;
        });
    }

    /* ---------- 可绘制性探针（probe）----------
     * 判「这个资源现在能不能用」，唯一可靠的办法是**真的走一遍取用路径**，而不是查我们自己的记录。
     *
     * 为什么 records.done 不够（这是本机制首个版本的真实缺陷，实测复现）：
     *   records.done 只证明「我们曾经取回过一次」。但绘制时浏览器还要再取一次，那次能不能
     *   命中缓存，取决于缓存层，而不是取决于我们：
     *     - DevTools 勾了「禁用缓存」→ 所有缓存读被绕过，绘制时重新联网；
     *     - 缓存条目被淘汰、或服务器响应不可缓存（响应缺 Last-Modified / Cache-Control）。
     *   实测（背景 g1_2.png，先不限速预载、再开限速）：
     *     缓存开启 → 显示时的请求命中磁盘缓存，同刻完成；
     *     禁用缓存 → 显示时重新联网，**15.5 秒后才下完**，而 records 一直说 done
     *                → barrier 判定「已就绪」直接放行 → 背景半张图，且永远不显示转圈圈。
     *   这正是「低网速下背景逐行扫描、看不到等待遮罩」的根因。
     *
     * 探针用一个新的 Image 走一次 load + decode：
     *   - 命中缓存：几毫秒返回，遮罩的显示延迟（fallback.maskDelayMs）会把它吞掉，玩家无感；
     *   - 未命中：老老实实等到下载 + 解码完成 —— 期间遮罩亮起，背景不会半张图。
     * 这条路径本身就是绘制必须走的那条，因此它成功即「画得出来」。 */
    function probeImage(url) {
        return new Promise(function (resolve) {
            var img = new Image();
            inflight.push(img);            // 强引用：否则 GC 可能在途中回收并中止请求
            var settled = false, released = false;
            function settle() { if (settled) return; settled = true; resolve(); }   // 只放行等待
            function drop() {
                if (released) return;
                released = true;
                releaseInflight(img);
                img.onload = img.onerror = null;
            }
            function done() { drop(); settle(); }
            img.onload = function () {
                // decode 保证「位图已就绪」，而不只是「字节已到」。
                if (img.decode) {
                    try { img.decode().then(done, done); return; } catch (e) { /* 落到 done */ }
                }
                done();
            };
            img.onerror = done;            // 坏资源放行（等坏资源等于卡死，与 barrier 一致）
            // 同 preloadImage：超时只放行等待，**不释放引用**。否则 GC 回收元素会让在途请求
            // 被中止，探针却在超时那一刻报了「可用」——绘制时那张图根本没下来，遮罩再也不会出现。
            setTimeout(settle, ASSET_TIMEOUT);
            img.src = url;
        });
    }

    /* 等一个资源「真的可用」。
     *   图片 → ensure（登记 + 发起，仍受并发窗口与 records 管理）+ 探针（此刻画不画得出来）
     *   其它 → ensure 的加载 promise（音频的代价只是延迟起播，不参与画面） */
    function waitPaintable(url, keep, priority) {
        var p = ensure(url, keep, priority);
        if (assetKind(url) !== "image") return p;
        return probeImage(url);
    }

    /* 音频强引用：与图片同理，元素若只被局部变量引用，GC 会回收它并**中止正在进行的下载**。
     * 仅用于 file:// 回退路径（http(s) 走 fetch，见下）。 */
    var audioHold = [];
    var AUDIO_HOLD_LIMIT = 256;

    /* 音频预加载。
     *
     * 坑：`new Audio()` + `preload="auto"` 并不等于「下好并缓存」。媒体元素**不在 DOM 中、
     * 又没有调用 play()** 时，浏览器会把它当作「无人使用的预取」而**中止请求**
     *（实测日志：预加载请求 ERR_ABORTED，随后播放时同一 URL 再请求一次 = 预加载白做，
     * 限速下就是音乐卡顿）。清空 src 更会主动中止。
     * 因此 http(s) 下改用 fetch 完整读完（响应体被读完才会真正落进 HTTP 缓存），
     * 播放时的媒体请求即可命中缓存。file:// 下 fetch 受协议限制，回退到 Audio 元素。 */
    function preloadAudio(url, rec) {
        return new Promise(function (resolve) {
            var settled = false;
            function settle(v) { if (settled) return; settled = true; resolve(v); }
            setTimeout(function () { settle("pending"); }, ASSET_TIMEOUT);

            // 注意：脚本里的 src 是**相对路径**（如 audio/g1.mp3），必须先解析成绝对 URL
            // 才能判断协议、才能交给 fetch，否则永远走回退分支。
            var abs = url;
            try { abs = new URL(url, document.baseURI).href; } catch (e) { abs = url; }
            if (global.fetch && /^https?:/i.test(abs)) {
                // 必须把响应体读完，否则请求会被当作未消费而中止，缓存里也不会留下字节。
                global.fetch(abs, { cache: "force-cache" })
                    .then(function (res) {
                        if (res && res.ok === false) throw new Error("HTTP " + res.status);
                        return res.arrayBuffer();
                    })
                    .then(function () { if (rec) rec.status = "done"; settle("done"); })
                    .catch(function () { if (rec) rec.status = "failed"; settle("failed"); });
                return;
            }

            var a = new Audio();
            if (audioHold.length < AUDIO_HOLD_LIMIT) audioHold.push(a);
            function release() { var k = audioHold.indexOf(a); if (k !== -1) audioHold.splice(k, 1); }
            function detach() { a.oncanplaythrough = a.onerror = a.onloadeddata = null; }
            a.preload = "auto";
            a.oncanplaythrough = function () { if (rec) rec.status = "done"; release(); detach(); settle("done"); };
            a.onloadeddata = function () { if (rec) rec.status = "done"; detach(); settle("done"); };
            a.onerror = function () { if (rec) rec.status = "failed"; detach(); settle("failed"); };
            a.src = url;
        });
    }

    /* ---------- 启动/等待遮罩 ---------- */
    function showMask() {
        var m = document.getElementById("boot-mask");
        if (!m) return;
        hideHint();                 // 遮罩可能被复用（进舞台），必须清掉上一次的提示文字
        m.classList.remove("is-hidden");
    }
    function hideMask() {
        var m = document.getElementById("boot-mask");
        if (!m) return;
        m.classList.add("is-hidden");
    }

    /* ---------- 兜底遮罩（#wait-mask）----------
     * 与 #boot-mask 分开：boot 遮住的是一张还没画好的界面（纯黑全屏），
     * wait 遮住的是一个已经画好、只差一张图的界面（半透明，舞台仍可见）。 */
    function waitMask() { return document.getElementById("wait-mask"); }

    /* 待等资源的进度（0~1），按**字节加权**。
     * 有 promise（探针/加载）的项以它自己的 done 为准 —— 那是「此刻真的可用了」；
     * 没有的（例如外部传入的裸列表）退回 records 的 done。 */
    function progressOf(list) {
        var total = 0, done = 0;
        for (var i = 0; i < (list || []).length; i++) {
            var it = list[i];
            var sz = it.size || assetSize(it.url);
            total += sz;
            if (it.promise ? it.done : isReady(it.url)) done += sz;
        }
        return total > 0 ? done / total : 1;
    }

    function updateBarrier(list) {
        var p = document.getElementById("wait-progress");
        if (!p) return;
        var pct = Math.round(progressOf(list) * 100);
        p.textContent = pct + "%";
    }

    function showBarrier(list) {
        var m = waitMask();
        if (!m) return;
        m.classList.remove("is-hidden");
        updateBarrier(list);
    }
    function hideBarrier() {
        var m = waitMask();
        if (m) m.classList.add("is-hidden");
        var p = document.getElementById("wait-progress");
        if (p) p.textContent = "";
        var btn = m && m.querySelector(".wait-skip");
        if (btn) btn.onclick = null;
    }

    /* ---------- 遮罩提示文字 ----------
     * 两个遮罩各有自己的提示行，**必须同时写**，因为调用方并不知道此刻是哪一层在显示：
     *   #boot-mask > .boot-hint   —— 进网页 / 进章的纯黑遮罩（绝对定位在视口下方）
     *   #wait-mask > .wait-hint   —— 剧情中途的资源等待遮罩（半透明，在进度百分比下面）
     * 只写其中一个的后果是实测过的：进章时 hint 定时器到点、写的是 #boot-mask 里的元素，
     * 而当时亮着的是 #wait-mask（或反之），玩家看到的就是「等了二十秒只有转圈圈、没有任何文字」。
     * 两层都写没有副作用——不可见的那层本来就 opacity:0，跟着自己的遮罩一起显隐。 */
    function showHint(text) {
        if (!text) return;
        ["boot-hint", "wait-hint"].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            el.textContent = text;
            el.classList.add("is-shown");
        });
    }
    function hideHint() {
        ["boot-hint", "wait-hint"].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.classList.remove("is-shown");
        });
    }

    /* 此刻是否有任何一层遮罩正亮着。waitForPaint 的定时器到点时用它判断
     * 「还该不该补提示」——**不能只看 #boot-mask**：章首等待与剧情中途等待用的是两层不同的
     * 遮罩，只查其中一层会把另一层的提示静默丢掉。 */
    function anyMaskVisible() {
        var b = document.getElementById("boot-mask");
        var w = document.getElementById("wait-mask");
        return !!((b && !b.classList.contains("is-hidden")) ||
                  (w && !w.classList.contains("is-hidden")));
    }

    /* 超时提示的文案：先实测网速，再二选一。没有样本（file:// 或样本已过期）按「慢」处理，
     * 因为此时确实无法判断网速——宁可提示玩家「可能较久」，也不要给一个乐观的错误结论。 */
    function hintForNow() {
        var kbps = measureSpeedKBps();
        var strat = getStrategy();
        return (kbps === null || kbps < strat.slowSpeedKBps) ? HINT_SLOW : HINT_LARGE;
    }

    /* ---------- 实测网速（KB/s）----------
     * 数据源是 Resource Timing。对每个**已完成**的资源算一次单资源传输速率
     *     encodedBodySize / (responseEnd - responseStart)
     * 取其中的最大值，作为「这条链路能跑多快」的估计。
     *
     * 为什么取最大值，而不是「已完成字节总和 ÷ 总耗时」：
     *   后者把尚未下载完的请求排除在分子之外，分母却包含它们占用的时间。在「网速正常、
     *   资源很大」的场景里，小文件早已完成、大图仍在途，算出来是一个被人为压低的速率——
     *   恰好把「资源体积大」误判成「网络较慢」。
     *
     * 三道过滤：
     *   1. 只统计 transferSize > 0 的条目——命中缓存的资源该值为 0（字节来自磁盘而非网络）。
     *   2. 只采信体积 ≥ MIN_SPEED_SAMPLE 的样本——几百字节的响应一次突发就能跑出很高的速率。
     *   3. 只采信**最近 SPEED_WINDOW_MS 内完成**的样本——否则中途限速后，限速前那些全速
     *      传输会一直胜出，估计值永远停在限速前的水平，提示文案与实际体验相反。
     *      窗口内无样本时退回「最近一次采信值」，它超过 RATE_STICKY_MS 后也作废。
     *
     * 返回 null 表示没有可用样本。file:// 下浏览器不产生 resource 条目，恒为 null。
     * 这个估计值同时用于「预计下载耗时 = size / rate」，因此它与被排进队列的新请求同口径。 */
    var lastRate = 0, lastRateAt = 0;   // 最近一次采信值及其时刻（performance.now）

    function measureSpeedKBps() {
        var perf = global.performance;
        if (!perf || typeof perf.getEntriesByType !== "function") return null;
        var entries;
        try { entries = perf.getEntriesByType("resource") || []; } catch (e) { return null; }
        var now = (typeof perf.now === "function") ? perf.now() : 0;
        var best = 0;
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i] || {};
            if (!(e.transferSize > 0)) continue;
            var bytes = e.encodedBodySize || e.transferSize || 0;
            if (bytes < MIN_SPEED_SAMPLE) continue;
            var ms = (e.responseEnd || 0) - (e.responseStart || 0);
            if (!(ms > 0)) continue;
            if (now > 0 && (now - (e.responseEnd || 0)) > SPEED_WINDOW_MS) continue;   // 样本已过期
            var kbps = (bytes / 1024) / (ms / 1000);
            if (kbps > best) best = kbps;
        }
        if (best > 0) { lastRate = best; lastRateAt = now; return best; }
        if (lastRate > 0 && now > 0 && (now - lastRateAt) <= RATE_STICKY_MS) return lastRate;
        return null;
    }

    /* 预计下载耗时（秒）。rate 不可得时取一个保守的标称值。 */
    function estimateSeconds(bytes) {
        var rate = measureSpeedKBps();
        if (!(rate > 0)) rate = NOMINAL_RATE_KBPS;
        return (bytes / 1024) / rate;
    }

    /* ---------- 遮罩等待：按 preload.onTimeout 决定「等超时了怎么办」----------
     *   "release" —— 到 timeout 即放行（遮罩揭开，可能露出尚未加载完的画面）
     *   "hint"    —— 到 timeout 时先实测网速、在遮罩上补一行提示，然后**继续等待**（默认）
     *
     * 为什么默认是 "hint"：遮罩的职责是「别让玩家看到一张没加载好的首屏」。到点就放行等于
     * 用一个固定秒数赌资源已经就绪——限速下赌输的直接表现就是空白首页与背景逐行扫描。
     *
     * 不会无限等待：单个资源的等待上限 ASSET_TIMEOUT 是内在兜底，坏资源最多占用那么久。
     * boot() / enterStage() / barrier() 三处的等待**都必须走这个函数**，不要再各写一份 Promise.race。 */
    function waitForPaint(promise) {
        var strat = getStrategy();
        if (strat.onTimeout === "release") {
            return Promise.race([promise, new Promise(function (r) { setTimeout(r, strat.timeout); })]);
        }
        return new Promise(function (resolve) {
            var done = false;
            var timer = setTimeout(function () {
                if (done) return;
                // 两层遮罩都不在（例如等待已被别处提前结束）时不补提示，避免文字挂在空处。
                // 注意判据是「有没有遮罩亮着」，不是「某个具体遮罩是否隐藏」。
                if (!anyMaskVisible()) return;
                showHint(hintForNow());
            }, strat.timeout);
            function finish() {
                if (done) return;
                done = true;
                clearTimeout(timer);
                hideHint();
                resolve();
            }
            promise.then(finish, finish);
        });
    }

    /* ---------- 资源收集（外壳图 / 首页 / 系统页 / 剧情） ---------- */

    /* 引擎 UI 外壳图（文本框背景 / 面板边框 / 按钮背景 / 画廊占位图）：
     * 这些图为引擎自带、几乎每个页面都用得到。它们的路径已从「硬编码在 CSS 的 url(...)」
     * 改为 theme.json 的配置字段（dialog.background、frame.background、button.idle|hover、
     * choice.idle|hover、thumb.placeholder）——与 theme.js 写入 --gui-* 变量的数据源完全一致。
     * 注意：本函数只覆盖 theme.json 里的字段。角色专属对话框不在其中，
     * 由 collectCharTextboxes 单独收集——两者合起来才是完整的「外壳图」集合。 */
    function collectChrome(theme) {
        theme = theme || global.__THEME__ || {};
        var out = [];
        function add(p) { if (p) out.push(resolveAsset(p)); }
        var dlg = theme.dialog || {};
        add(dlg.background);
        var fr = theme.frame || {};
        add(fr.background);
        var btn = theme.button || {};
        add(btn.idle); add(btn.hover);
        var ch = theme.choice || {};
        add(ch.idle); add(ch.hover);
        var th = theme.thumb || {};
        add(th.placeholder);
        return out;
    }

    /* 角色档案查询：构建产物在 __SCRIPTS__ 里，模板/运行时在 AliceADVScript.state.chars。
     * 两处都查，因为 enterStage 可能发生在「剧本已加载、档案已进 state」之后。 */
    function charProfile(id) {
        if (!id || id.charAt(0) === "_") return null;   // "_comment" 之类的说明项不是角色
        var chars = ((global.__SCRIPTS__ || {})["story/characters.json"]) || null;
        if (chars && chars[id] && typeof chars[id] === "object") return chars[id];
        var S = global.AliceADVScript;
        var live = (S && S.state && S.state.chars) || null;
        if (live && live[id] && typeof live[id] === "object") return live[id];
        return null;
    }

    /* 角色专属对话框（角色档案的 profile.textbox）。
     * 它与 theme.dialog.background 是同一性质的东西——「剧本第一句台词就要出现的 UI 图」，
     * 但数据源在角色档案里，不在 theme.json，所以 collectChrome 天生看不到它。
     * ids 为可选白名单：只收集这些角色 id 的对话框（按需预载，避免十几张 800KB 的图
     * 一次性压进带宽，反而挤掉真正马上要用的资源）。 */
    function collectCharTextboxes(scripts, ids) {
        var out = [];
        var seen = Object.create(null);
        var want = null;
        if (ids && ids.length) {
            want = Object.create(null);
            ids.forEach(function (id) { want[id] = 1; });
        }
        function add(p) {
            if (!p) return;
            var u = resolveAsset(p);
            if (u && !seen[u]) { seen[u] = 1; out.push(u); }
        }
        var chars = ((scripts || global.__SCRIPTS__ || {})["story/characters.json"]) || null;
        if (chars) {
            for (var id in chars) {
                if (id.charAt(0) === "_") continue;     // "_comment" 之类的说明项不是角色
                if (want && !want[id]) continue;
                add((chars[id] || {}).textbox);
            }
        } else {
            var S = global.AliceADVScript;
            var live = (S && S.state && S.state.chars) || {};
            for (var k in live) {
                if (k.charAt(0) === "_") continue;
                if (want && !want[k]) continue;
                add((live[k] || {}).textbox);
            }
        }
        return out;
    }

    /* 首页素材：pages.title.background + customButtons 的 image/hover。 */
    function collectTitle(theme) {
        var out = [];
        var cfg = (theme.pages && theme.pages.title) || {};
        if (cfg.background) out.push(resolveAsset(cfg.background));
        var cb = cfg.customButtons;
        if (cb && cb.length) {
            cb.forEach(function (b) {
                if (b.image) out.push(resolveAsset(b.image));
                if (b.hover) out.push(resolveAsset(b.hover));
            });
        }
        return out;
    }

    /* 某系统页是否启用（被禁用的功能不加载其专属素材）。 */
    function isPageEnabled(k, catalog) {
        catalog = catalog || {};
        if (k === "gallery")  return (catalog.gallery  && catalog.gallery.length  > 0);
        if (k === "branches")  return (catalog.branches && catalog.branches.length > 0);
        if (k === "chapters") return (catalog.chapters && catalog.chapters.length > 0);
        return true;
    }

    /* 系统界面素材：首页 + 各启用系统页背景 + 舞台背景。 */
    function collectSystem(theme, catalog) {
        var out = collectTitle(theme);
        var pages = theme.pages || {};
        var sysPages = ["save", "load", "settings", "chapters", "branches", "gallery", "about"];
        sysPages.forEach(function (k) {
            if (!isPageEnabled(k, catalog)) return;
            var cfg = pages[k] || {};
            if (cfg.background) out.push(resolveAsset(cfg.background));
        });
        if (pages.stage && pages.stage.background) out.push(resolveAsset(pages.stage.background));
        return out;
    }

    /* 全部剧情素材：遍历 __SCRIPTS__ 所有剧本。
     * 仅用于 boot="title+story"（作者显式选择的「进网页就全下」）。
     * 注意这一档**不按引用裁剪**：角色档案里的每一张立绘都收，因为画廊等系统页
     * 用的立绘不一定在剧本里出现过（这一点与 §「资源归属不能按段推断」同理：
     * 只有引用关系才能证明「用得到」，而这里作者要的就是全量）。 */
    function collectStory(theme, scripts) {
        var out = [];
        scripts = scripts || global.__SCRIPTS__ || {};
        var chars = scripts["story/characters.json"] || {};
        for (var id in chars) {
            if (id.charAt(0) === "_") continue;   // "_comment" 之类的说明项不是角色
            var profile = chars[id] || {};
            if (typeof profile !== "object") continue;
            var sprites = profile.sprites || {};
            for (var sp in sprites) if (sprites[sp]) out.push(resolveAsset(sprites[sp]));
            if (profile.textbox) out.push(resolveAsset(profile.textbox));
        }
        for (var key in scripts) {
            if (key === "story/characters.json" || key === "story/chapters.json") continue;
            var script = scripts[key];
            if (!script) continue;
            out = out.concat(allSegAssets(script));
        }
        return out;
    }

    /* 单页背景资源（供 hookPage 用）。pageName 兼容 "title" / "page_title" 两种入参。 */
    function collectPageAssets(pageName, theme, catalog) {
        var out = [];
        var k = (pageName.indexOf("page_") === 0) ? pageName.slice(5) : pageName;
        if (k === "title") return collectTitle(theme);
        var cfg = (theme.pages && theme.pages[k]) || {};
        if (cfg.background) out.push(resolveAsset(cfg.background));
        return out;
    }

    /* ---------- 指令 → 资源 ---------- */

    /* 查角色档案解析立绘 src（与 script.js showChar 同源逻辑）。 */
    function resolveCharSprite(charId, sprite) {
        var profile = charProfile(charId) || {};
        var sprites = profile.sprites || {};
        var sp = sprite || (function () { for (var k in sprites) return k; })() || null;
        return sp ? sprites[sp] : null;
    }

    /* 一条指令会用到的资源。返回 [{ url, kind: "image"|"audio", voice }]。
     * kind 决定兜底动作（图不可降级、音频天然可降级）；voice=true 表示「快进时可跳过」的语音。 */
    function needsOf(c) {
        if (!c) return [];
        var out = [];
        var cmd = c.cmd;
        if (cmd === "bg" || cmd === "scene") {
            if (c.src) out.push({ url: c.src, kind: "image" });
        } else if (cmd === "show") {
            var src = c.src || resolveCharSprite(c.char, c.sprite);
            if (src) out.push({ url: src, kind: "image" });
        } else if (cmd === "sprite") {
            var src2 = resolveCharSprite(c.char, c.sprite);
            if (src2) out.push({ url: src2, kind: "image" });
        } else if (cmd === "music" || cmd === "sound") {
            if (c.src) out.push({ url: c.src, kind: "audio" });
        } else if (cmd === "voice") {
            if (c.src) out.push({ url: c.src, kind: "audio", voice: true });
        }
        // say / narrate：先要对话框（图），再要语音（音）
        if (cmd === "say" || cmd === "narrate") {
            var box = charProfile(c.char);
            if (box && box.textbox) out.push({ url: box.textbox, kind: "image" });
            if (c.voice) out.push({ url: c.voice, kind: "audio", voice: true });
        }
        return out;
    }

    /* 一条指令占用多少「剧情时间」（秒）。
     * 阻塞指令（say / narrate / title / decide）各占「一句」；wait / pause 带时长时按声明时长；
     * 裸 pause 等玩家点击，按一句计；裸 wait 用 script.js 的 800ms 缺省；其余非阻塞指令为 0。 */
    function instructionCost(c, lineSeconds) {
        if (!c) return 0;
        if (c.cmd === "wait" || c.cmd === "pause") {
            if (c.ms != null) return c.ms / 1000;
            if (c.seconds != null) return c.seconds / 1000;
            return (c.cmd === "wait") ? WAIT_DEFAULT_SECONDS : lineSeconds;
        }
        return LINE_CMDS[c.cmd] ? lineSeconds : 0;
    }

    function allSegAssets(script) {
        var out = [], seen = Object.create(null);
        var segs = (script && script.segments) || {};
        for (var name in segs) {
            var list = segs[name];
            if (!Array.isArray(list)) continue;
            for (var i = 0; i < list.length; i++) {
                var needs = needsOf(list[i]);
                for (var j = 0; j < needs.length; j++) {
                    var u = resolveAsset(needs[j].url);
                    if (u && !seen[u]) { seen[u] = 1; out.push(u); }
                }
            }
        }
        return out;
    }

    /* ---------- 时间轴遍历（plan）----------
     * 从 (seg, idx) 起算，按「每句耗时」累加时间，记录每个资源**第一次**被用到的时间。
     * 章边界由 chapter.scope 控制：
     *   "current"（默认）：走到别的章就停。一章一个剧本文件时这不产生影响；
     *                      同一文件内嵌套多章时必须改成 "all"，否则章边界处会出现缺口。
     * 分支：goto / if 是顺序关系，继续用同一个 acc；decide 的各选项是并列关系，
     *       每个分支都从同一个 acc 分叉（串行累加会把第二个分支的 deadline 凭空推迟）。 */
    function plan(script, seg, idx) {
        var items = [];
        if (!script || !script.segments || !script.segments[seg]) return items;

        var strat = getStrategy();
        var la = strat.lookahead;
        var lineSeconds = currentLineSeconds();
        var skipVoice = skipVoiceActive();

        var deadline = Object.create(null);   // url → 第一次被使用的时间（秒）
        var kindOf = Object.create(null);
        var voiceOnly = Object.create(null);
        var charDeadline = Object.create(null); // 角色 id → 首次登场/说话的时间
        var scanned = 0;
        var visited = Object.create(null);

        var segChapter = script.__segChapter || null;
        var startChapter = segChapter ? segChapter[seg] : null;
        var crossChapter = (strat.chapter.scope === "all") || !segChapter;

        function note(c, acc) {
            var needs = needsOf(c);
            for (var i = 0; i < needs.length; i++) {
                var n = needs[i];
                var u = resolveAsset(n.url);
                if (!u) continue;
                if (n.voice && skipVoice) continue;   // 快进不播语音，也就不必为它占带宽
                if (deadline[u] === undefined) {
                    deadline[u] = acc;
                    kindOf[u] = n.kind;
                    voiceOnly[u] = !!n.voice;
                } else if (!n.voice) {
                    voiceOnly[u] = false;
                }
            }
            if (c && c.char && (c.cmd === "say" || c.cmd === "show")) {
                if (charDeadline[c.char] === undefined) charDeadline[c.char] = acc;
            }
        }

        function walk(segName, startIdx, acc) {
            if (!crossChapter && startChapter && segChapter[segName] !== startChapter) return;
            var key = segName + "#" + startIdx;
            if (visited[key]) return;   // 阻断 goto / if 构成的环；重复到达不再展开（保守）
            visited[key] = 1;

            var list = script.segments[segName];
            if (!Array.isArray(list)) return;
            var local = 0;
            for (var i = startIdx; i < list.length; i++) {
                if (scanned >= la.maxInstructions) return;
                scanned++;
                local++;
                var c = list[i];
                if (!c) continue;
                // 先记 deadline 再累加时间：当前这条指令的资源相对「现在」就是 0 秒后要用
                note(c, acc);
                acc += instructionCost(c, lineSeconds);
                if (acc > la.horizonSeconds) return;
                if (c.cmd === "goto" && c.segment) {
                    walk(c.segment, 0, acc);
                } else if (c.cmd === "if") {
                    if (c.goto) walk(c.goto, 0, acc);
                    if (c["else"]) walk(c["else"], 0, acc);
                } else if (c.cmd === "decide" && c.options) {
                    // 并列分支：所有选项都从同一个 acc 分叉（若像 goto 那样串行累加，
                    // 第二个分支的 deadline 会被凭空推迟整个第一分支的时长）
                    for (var k = 0; k < c.options.length; k++) {
                        var opt = c.options[k];
                        if (opt && opt.goto) walk(opt.goto, 0, acc);
                    }
                }
            }
        }

        walk(seg, idx, 0);

        var windowSeconds = la.windowSeconds;
        for (var url in deadline) {
            var dl = deadline[url];
            // 超过上界的留到下次推进重算：遍历的早退是按「累加后越界」触发的，
            // 触发那一条自身的资源已经被记下来了，必须在出口处再滤一次才算真的越界。
            if (dl > la.horizonSeconds) continue;
            var size = assetSize(url);
            var est = estimateSeconds(size);
            items.push({
                url: url,
                kind: kindOf[url] || assetKind(url),
                voice: !!voiceOnly[url],
                deadline: dl,
                size: size,
                est: est,
                slack: dl - est,
                tier: dl <= 0 ? 0 : (dl <= windowSeconds ? 1 : 2)
            });
        }
        // 排序：先按档位（已过期/正在用的无条件优先），再按 slack 升序，最后按体积升序。
        // 体积只参与「预计耗时 → slack」，不参与「谁更重要」。
        items.sort(function (a, b) {
            if (a.tier !== b.tier) return a.tier - b.tier;
            if (a.slack !== b.slack) return a.slack - b.slack;
            if (a.size !== b.size) return a.size - b.size;
            return a.url < b.url ? -1 : (a.url > b.url ? 1 : 0);
        });

        planChars = charDeadline;
        return items;
    }

    /* 最近一次 plan() 得到的「角色 → 首次登场时间」（供 enterStage 按需预载对话框）。 */
    var planChars = Object.create(null);
    function getPlanChars() { return planChars; }

    /* 章内全部可达资源（chapter.preload="complete" 用）。
     * 与 §「资源归属不能按段推断」一致：这里是**全量并集**，不按段裁剪，也不区分「本段新增」。 */
    function chapterAssets(script, seg) {
        if (!script || !script.segments) return [];
        var strat = getStrategy();
        var map = script.__segChapter || null;
        var chapter = (strat.chapter.scope === "all" || !map) ? null : map[seg];
        var skipVoice = skipVoiceActive();
        var out = [], seen = Object.create(null);
        for (var name in script.segments) {
            if (chapter && map[name] !== chapter) continue;
            var list = script.segments[name];
            if (!Array.isArray(list)) continue;
            for (var i = 0; i < list.length; i++) {
                var needs = needsOf(list[i]);
                for (var j = 0; j < needs.length; j++) {
                    var n = needs[j];
                    if (n.voice && skipVoice) continue;
                    var u = resolveAsset(n.url);
                    if (u && !seen[u]) { seen[u] = 1; out.push(u); }
                }
            }
        }
        return out;
    }

    /* 「已就绪缓冲秒数」：满足「deadline <= t 的图片资源全部就绪」的最大 t。
     * readySeconds >= windowSeconds 表示当前窗口已被完整覆盖。
     * 音频不作为健康度判据（音频缺失的代价是延迟起播，不是画面缺失）。 */
    function readySeconds(script, seg, idx) {
        var items = plan(script, seg, idx).filter(function (it) { return it.kind === "image"; });
        items.sort(function (a, b) { return a.deadline - b.deadline; });
        var t = 0;
        for (var i = 0; i < items.length; i++) {
            if (!isReady(items[i].url)) break;
            t = items[i].deadline;
        }
        return t;
    }

    /* 把规划结果同步进队列。
     * 已发起的请求不重排；仍排在队列里、但这次规划不再需要的项会被丢弃；
     * 新增项按排序键依次入队（数组顺序 = 发起顺序）。 */
    function applyPlan(items) {
        var wanted = Object.create(null);
        var i;
        for (i = 0; i < items.length; i++) wanted[items[i].url] = items[i];

        if (planQueue.length) {
            var kept = [];
            for (i = 0; i < planQueue.length; i++) {
                var u = planQueue[i];
                if (wanted[u]) kept.push(u);
            }
            planQueue = kept;
        }
        for (i = 0; i < items.length; i++) {
            var it = items[i];
            if (records[it.url] || wanted[it.url].queued) continue;
            wanted[it.url].queued = true;
            ensure(it.url, false, false);
        }
        return items;
    }

    /* ---------- 兜底：指令执行前的 barrier ----------
     * 放在 script.js 的 advance() 循环里、exec(c) 之前，而不是各指令内部：
     *   setBg 同步返回「是否阻塞」，内部用 state.step 做 epoch 判断、用 bgFade 管理幕布状态。
     *   把 await 塞进 setBg 会改变它的返回语义，并让 epoch 判断与幕布状态机的时机全部错位。
     *
     * 就绪判据分两层，缺一不可：
     *   records —— 「这条资源我们发起过没有 / 坏没坏」（不看任何「段」维度的历史）；
     *   探针     —— 「此刻画不画得出来」。**不能只信 records.done**：它只说明我们曾经取回过一次，
     *               不说明浏览器现在能立刻绘制（缓存被绕过 / 被淘汰 / 响应不可缓存时，绘制要重新联网）。
     *               只用 records 会导致「背景半张图 + 永远不显示遮罩」（见 probeImage 的长注释）。 */
    function fallbackFor(kind) {
        var fb = getStrategy().fallback;
        if (kind === "image") return fb.image;
        if (kind === "audio") return fb.audio;
        return fb.default;
    }

    /* 返回 null 表示「这条指令不需要等」——调用方用真假判断即可，不必无谓 await。
     * 返回 Promise 表示「可能等出遮罩」，调用方 await 它，等它 settle 再执行这条指令。 */
    function barrier(c) {
        var list = needsOf(c);
        if (!list.length) return null;
        var skipVoice = skipVoiceActive();
        var wait = [];
        var forked = false;

        for (var i = 0; i < list.length; i++) {
            var n = list[i];
            var url = resolveAsset(n.url);
            if (!url) continue;
            if (n.voice && skipVoice) continue;              // 快进不播语音，也就不必等它
            var rec = records[url];
            if (rec && rec.status === "failed") continue;    // 坏资源不拦停（等它等于卡死）

            var action = fallbackFor(n.kind);
            if (action !== "block") {
                if (!rec) { ensure(url, false, false); forked = true; }   // 降级也要尽量拉，只是不等
                continue;
            }
            // block：先登记/发起（受并发窗口管理），再由探针给出「此刻可绘制」的判据。
            // 注意这里**不查 isReady**——缓存里的那份可能早就不能用了。
            wait.push({
                url: url, kind: n.kind,
                size: rec ? rec.size : assetSize(url),
                promise: waitPaintable(url, false, true)
            });
        }

        if (forked && !wait.length) pump();
        if (!wait.length) return null;
        return waitWithBarrier(wait);
    }

    /* 等一组资源就绪，期间可能亮出 #wait-mask。
     * 遮罩**不是立刻显示**：绝大多数指令要的资源就在缓存里，几毫秒就绪，
     * 立刻显示再立刻隐藏会闪一下。先等 fallback.maskDelayMs（默认 150ms），
     * 超过它还没就绪才说明「真的在等网络」，这时才亮遮罩。 */
    function waitWithBarrier(list) {
        var strat = getStrategy();
        var delay = strat.fallback.maskDelayMs;
        // 进度按「每项自身的就绪」算，而不是按 records：探针未返回 = 这一项还没好
        list.forEach(function (it) {
            it.done = false;
            it.promise.then(function () { it.done = true; }, function () { it.done = true; });
        });
        return new Promise(function (resolve) {
            var delayTimer = null, ticker = null, hintTimer = null, done = false, shown = false;
            function finish() {
                if (done) return;
                done = true;
                if (delayTimer) { clearTimeout(delayTimer); delayTimer = null; }
                if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
                if (ticker) { clearInterval(ticker); ticker = null; }
                hideHint();
                if (shown) hideBarrier();
                resolve();
            }
            function reveal() {
                delayTimer = null;
                if (done) return;
                shown = true;
                showBarrier(list);
                var btn = waitMask() && waitMask().querySelector(".wait-skip");
                if (btn) {
                    if (strat.fallback.allowSkipWait) btn.onclick = finish;
                    btn.style.display = strat.fallback.allowSkipWait ? "" : "none";
                }
                ticker = setInterval(function () { updateBarrier(list); }, 250);
                // 与 waitForPaint 同一门槛：遮罩亮起后超过 preload.timeout 还没好，
                // 就补一行「为什么慢」。这里**不改变等待行为**（barrier 一律等满，
                // 是否放行由 onTimeout 与 allowSkipWait 决定），只补文字——
                // 否则玩家看到的是一个只能转圈、没有任何解释的遮罩。
                hintTimer = setTimeout(function () {
                    hintTimer = null;
                    if (done || !anyMaskVisible()) return;
                    showHint(hintForNow());
                }, strat.timeout);
            }
            if (delay > 0) delayTimer = setTimeout(reveal, delay);
            else reveal();
            // 每个资源的等待都在 ASSET_TIMEOUT 内 settle，因此这里不会无限等
            Promise.all(list.map(function (it) { return it.promise; })).then(finish, finish);
        });
    }

    /* ---------- 启动入口：按 boot 策略收集 + 预加载 + 隐藏遮罩 ----------
     * 必须在 theme.js buildAll() 之后调用（DOM 已构造、背景已写入 style）。
     *
     * 加载顺序即优先级。分级：
     *   ① 首屏（首页背景 / 首页按钮图）→ ② 引擎外壳图 → ③ 策略附加（system / story）。
     * 角色专属对话框**不在此全量预载**：十几张 ~800KB 的图，玩家还在首页时根本用不到，
     * 却会占满连接、把首屏和外壳图挤到队尾（这正是「限速下首页空白」的直接原因）。
     * 它们改由 enterStage / hookPredict 按时间轴内即将登场的角色精确预载。 */
    async function boot(theme, catalog, scripts) {
        var strat = getStrategy();
        if (strat.boot === "none") { hideMask(); return; }

        var first  = collectTitle(theme);     // ① 首屏
        var chrome = collectChrome(theme);    // ② 外壳图（默认对话框/边框/按钮/占位图）
        var later  = [];                      // ③ 策略附加
        if (strat.boot === "system") later = later.concat(collectSystem(theme, catalog));
        if (strat.boot === "title+story") later = later.concat(collectStory(theme, scripts));

        var seen = Object.create(null);
        function uniq(a) {
            var o = [];
            a.forEach(function (u) { if (u && !seen[u]) { seen[u] = 1; o.push(u); } });
            return o;
        }
        var t0 = uniq(first), t1 = uniq(chrome), t2 = uniq(later);

        // 首屏就绪即揭幕：遮罩只负责「别让玩家看到一张没背景的首页」。
        // 超时行为由 preload.onTimeout 决定（默认 hint：继续等 + 提示原因，见 waitForPaint）。
        var firstPaint = preloadAll(t0, true, true);
        firstPaint
            .then(function () { return preloadAll(t1, true, true); })
            .then(function () { return preloadAll(t2, false, true); })
            .catch(function () {});

        await waitForPaint(firstPaint);
        hideMask();
    }

    /* ---------- 运行时 hook：page 预加载 ---------- */
    function hookPage(pageName, theme, catalog) {
        var strat = getStrategy();
        if (strat.runtime.indexOf("page") === -1) return;
        var urls = collectPageAssets(pageName, theme || (global.__THEME__), catalog);
        preloadAll(urls);
    }

    /* ---------- 运行时 hook：predict 规划 ----------
     * 由 script.js 的 advance() 在推进时调用。产出按 slack 升序的待发列表并同步进队列；
     * 已发起的请求保持原样（HTTP 层不提供中途改优先级的能力）。 */
    function hookPredict(script, seg, idx) {
        var strat = getStrategy();
        if (strat.runtime.indexOf("predict") === -1) return [];
        var items = plan(script, seg, idx);
        applyPlan(items);
        return items;
    }

    /* ---------- 进舞台 / 进章的开场预加载 ----------
     * 揭幕前要等的资源分三组，**它们的区别是「等不等得起」，不是「急不急」**：
     *   ① 外壳图 + 首帧关键集：无条件等满。这是底线 —— 不能让玩家看到空舞台，
     *      也不能让第一句台词出来时对话框还没到。
     *   ② 前奏：stage.preludeSeconds 剧情秒内要用的图片。选取按**剧情秒**（语义是
     *      「接下来这么久的剧情要用到的东西」），但等待按**下载时间预算**截断
     *      （stage.preludeBudgetSeconds，按实测速率折算）。两者缺一不可：
     *      只按剧情秒选，字节数没有上界（实测某章 60 剧情秒内约 19 MB），慢网下会
     *      变成让玩家干等一分半；只按预算选，又不知道哪些资源「值得」先花掉预算。
     *   ③ 其余：揭幕后后台补齐，不参与遮罩。
     * chapter.preload="complete" 是作者显式选择的「宁可等，也要全程无缺失」：把①扩成
     *   整章可达资源，等待策略不另起一套（仍是 timeout / onTimeout）。
     * 三组都走 waitForPaint()，与启动遮罩同一条路径。 */
    async function enterStage(script, seg, idx) {
        var strat = getStrategy();
        if (strat.runtime.indexOf("predict") === -1) return;
        if (!script || !script.segments) return;

        var seen = Object.create(null);
        var chrome = [];     // ① 外壳图：无条件等，且保留已解码位图（keep=true）
        var critical = [];   // ① 首帧关键集：无条件等，不保留位图
        var prelude = [];    // ② 前奏：按预算截断
        var rest = [];       // ③ 后台补齐

        function push(arr, url) {
            url = resolveAsset(url);
            if (!url || seen[url]) return;
            seen[url] = 1;
            arr.push(url);
        }
        function defer(url) {
            url = resolveAsset(url);
            if (!url || seen[url]) return;
            rest.push(url);
        }

        collectChrome().forEach(function (u) { push(chrome, u); });

        if (strat.chapter.preload === "complete") {
            // 作者显式选择「宁可等，也要全程无缺失」：等齐章内全部可达资源 +
            // 章内所有角色的专属对话框（complete 即「全都要」，不再按登场时间挑）
            chapterAssets(script, seg).forEach(function (u) { push(critical, u); });
            collectCharTextboxes(global.__SCRIPTS__, null).forEach(function (u) { push(critical, u); });
        } else {
            var items = plan(script, seg, idx);
            var preludeSeconds = strat.stage.preludeSeconds;

            // 第一个要说话/登场的角色：他的对话框属于首帧关键集（第一句台词就要用）
            var firstSpeaker = null;
            for (var cid in planChars) { firstSpeaker = cid; break; }
            collectCharTextboxes(global.__SCRIPTS__, firstSpeaker ? [firstSpeaker] : [])
                .forEach(function (u) { push(critical, u); });

            var candidates = [];
            items.forEach(function (it) {
                if (it.deadline <= 0) { push(critical, it.url); return; }   // 当前这一步就要用
                if (strat.stage.preludeImagesOnly && it.kind !== "image") { defer(it.url); return; }
                if (it.deadline > preludeSeconds) { defer(it.url); return; }
                candidates.push(it);
            });

            // 前奏窗口内会说话 / 会登场的其它角色：对话框也是候选，但同样要受预算约束
            // （十几张 ~800KB 的图足以吃光整个预算，把真正要用的背景挤掉）
            var ids = [];
            for (var cid2 in planChars) {
                if (cid2 !== firstSpeaker && planChars[cid2] <= preludeSeconds) ids.push(cid2);
            }
            collectCharTextboxes(global.__SCRIPTS__, ids).forEach(function (u) {
                var u2 = resolveAsset(u);
                if (!u2 || seen[u2]) return;
                candidates.push({ url: u2, kind: "image", est: estimateSeconds(assetSize(u2)) });
            });

            // 按预算截断。**严格按顺序切断**（不跳过超支项去捡后面的小文件）：
            // candidates 已经是 slack 升序，顺序即优先级，跳着取会破坏这个性质。
            var budget = strat.stage.preludeBudgetSeconds;
            var spent = 0;
            var cut = false;
            candidates.forEach(function (it) {
                if (cut) { defer(it.url); return; }
                var est = (typeof it.est === "number") ? it.est : estimateSeconds(assetSize(it.url));
                // 并发窗口是 4，因此逐项累加的预计耗时是墙钟时间的保守上界
                if (spent + est > budget) { cut = true; defer(it.url); return; }
                spent += est;
                push(prelude, it.url);
            });
        }

        /* 分组的去重（顺序：外壳图 → 首帧关键集 → 前奏 → 其余）。
         * **不按 isReady 过滤**：对图片来说「我们取回过一次」不等于「现在画得出来」
         * （见 probeImage），进入等待集的判据只能是探针。已经就绪的资源由 ensure 幂等吸收、
         * 探针同刻返回，代价可以忽略。 */
        var taken = Object.create(null);
        function uniq(arr) {
            var out = [];
            for (var i = 0; i < arr.length; i++) {
                if (taken[arr[i]]) continue;
                taken[arr[i]] = 1;
                out.push(arr[i]);
            }
            return out;
        }
        var chromeWait = uniq(chrome);
        var critWait = uniq(critical);
        var preWait = uniq(prelude);
        var restWait = uniq(rest);

        /* 等待一组的资源。图片必须走可绘制性探针，不能只等「我们自己的加载 promise」：
         * 首帧背景往往在**进网页时**就被 boot 预载过（可能是一分钟前），
         * 缓存一旦用不上，绘制时仍要重新联网 —— 那时遮罩早已揭开，玩家看到半张背景。
         * map 保持数组顺序 = 发起顺序 = 优先级。 */
        function waitGroup(urls, keep, priority) {
            if (!urls.length) return null;
            return Promise.all(urls.map(function (u) {
                return waitPaintable(u, keep, priority);
            }));
        }

        if (!chromeWait.length && !critWait.length && !preWait.length && !restWait.length) return;
        if (chromeWait.length || critWait.length || preWait.length) {
            var waits = Promise.all([
                waitGroup(chromeWait, true, true),    // 外壳图：无条件等，且保留已解码位图
                waitGroup(critWait, false, true),     // 首帧关键集：无条件等
                waitGroup(preWait, false, true)       // 前奏：已按预算截断
            ]);
            // 与 barrier 同样先给一段延迟：资源都在缓存里时不要让遮罩闪一下
            var revealTimer = null, revealed = false;
            revealTimer = setTimeout(function () {
                revealTimer = null;
                revealed = true;
                showMask();
            }, strat.fallback.maskDelayMs);
            try {
                await waitForPaint(waits);
            } finally {
                if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
                if (revealed) hideMask();
            }
        }
        if (restWait.length) preloadAll(restWait, false, false).catch(function () {});
    }

    /* 播放模式切换时（setAuto / setSkip）重算一次队列：窗口长度变了，待发集合也随之变化。 */
    function replan(script, seg, idx) {
        if (!script || !script.segments || !seg) return [];
        return hookPredict(script, seg, idx);
    }

    global.AliceADVPreload = {
        /* 遮罩与生命周期 */
        boot: boot, showMask: showMask, hideMask: hideMask,
        showBarrier: showBarrier, hideBarrier: hideBarrier,
        showHint: showHint, hideHint: hideHint, hintForNow: hintForNow,
        anyMaskVisible: anyMaskVisible,
        waitForPaint: waitForPaint, measureSpeedKBps: measureSpeedKBps,
        /* 策略 */
        getStrategy: getStrategy,
        /* 运行时 hook */
        hookPage: hookPage, hookPredict: hookPredict, enterStage: enterStage, replan: replan,
        /* 调度 */
        plan: plan, applyPlan: applyPlan, barrier: barrier, chapterAssets: chapterAssets,
        readySeconds: readySeconds, progressOf: progressOf, estimateSeconds: estimateSeconds,
        /* 播放速度实测 */
        setPlaybackMode: setPlaybackMode, getPlaybackMode: getPlaybackMode,
        reportDwell: reportDwell, getDwellSeconds: getDwellSeconds, resetDwell: resetDwell,
        currentLineSeconds: currentLineSeconds, skipVoiceActive: skipVoiceActive,
        /* 资源与就绪状态 */
        ensure: ensure, preloadAll: preloadAll, enqueue: enqueue,
        isReady: isReady, getRecords: getRecords, getCache: getCache,
        probeImage: probeImage, waitPaintable: waitPaintable,
        getAssets: getAssets, assetSize: assetSize, assetKind: assetKind,
        needsOf: needsOf, instructionCost: instructionCost, getPlanChars: getPlanChars,
        /* 收集器 */
        collectTitle: collectTitle, collectSystem: collectSystem, collectStory: collectStory,
        collectPageAssets: collectPageAssets, collectChrome: collectChrome,
        collectCharTextboxes: collectCharTextboxes, allSegAssets: allSegAssets
    };
})(window);
