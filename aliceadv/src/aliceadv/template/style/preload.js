/* =========================================================
 * aliceADV engine — 资源预加载器 (preload runtime)
 *
 * 职责：
 *   1. 启动加载遮罩（#boot-mask）：进入网页时显示纯黑遮罩 + 转圈圈，
 *      按 info.json preload.boot 策略强制加载指定素材，就绪后渐隐消失。
 *   2. 运行时预加载（info.json preload.runtime）：
 *      - "page"    切换页面前预加载目标页面背景（不阻塞切换）
 *      - "predict" 剧情推进时向前扫描，预加载接下来将出现的
 *                  音效/音乐（最高优先级）→ 语音 → 场景背景 → 角色立绘
 *
 * 与引擎分工：
 *   theme.js  负责读取 theme.json、构造页面 DOM（含 background-image）。
 *   本模块只做「资源收集 + 预取 + 遮罩」，不构造 DOM、不改动剧本运行时。
 *   page/predict hook 由 engine.js / script.js 在切换/推进时调用。
 *
 * 策略来源：info.json 的 preload 字段（构建时合并进 window.__THEME__.info）。
 *   preload.boot    "none" | "title" | "system" | "title+story"
 *   preload.runtime  [] (关闭) | 含 "page" / "predict" 的任意组合
 * ========================================================= */

(function (global) {
    "use strict";

    /* ---------- 常量 ---------- */
    var BOOT_TIMEOUT = 12000;      // 启动加载总兜底超时（ms）：超时即放行，不无限卡玩家
    var ASSET_TIMEOUT = 8000;      // 单个资源预加载超时（ms）
    var PREDICT_LOOKAHEAD = 14;    // predict 向前扫描的指令条数

    /* 已预取过的资源集合（原始路径字符串），避免重复发起请求 */
    var cache = Object.create(null);

    var IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|#|$)/i;
    var AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac|opus)(\?|#|$)/i;

    /* ---------- 资源路径解析（与 theme.js resolveAsset 一致） ----------
     * 绝对/协议/data URI 原样返回；工程根相对路径原样返回（baseURI 为 dist/web/）。 */
    function resolveAsset(p) {
        if (!p) return "";
        if (/^(https?:|data:|\/\/|\/)/.test(p)) return p;
        return p;
    }

    /* ---------- 启动遮罩 ---------- */
    function showMask() {
        var m = document.getElementById("boot-mask");
        if (m) m.classList.remove("is-hidden");
    }
    function hideMask() {
        var m = document.getElementById("boot-mask");
        if (!m) return;
        m.classList.add("is-hidden");
    }

    /* ---------- 读取 info.preload 策略 ----------
     * 构建产物：window.__THEME__.info.preload（builder 把 info.json 合并进 theme.info）。
     * 模板模式：theme.js loadTheme() 会把 fetch 到的 info.json 挂到 theme.info。
     * 缺省视为：boot="title"（只加载首页）、runtime=["page","predict"]（最优组合）。 */
    function getStrategy() {
        var info = (global.__THEME__ && global.__THEME__.info) || {};
        var pre = info.preload || {};
        var boot = pre.boot;
        if (!boot || ["none", "title", "system", "title+story"].indexOf(boot) === -1) {
            boot = "title";
        }
        var rt = pre.runtime;
        if (rt == null) rt = ["page", "predict"];
        if (typeof rt === "string") rt = [rt];
        rt = (rt || []).filter(function (k) { return k === "page" || k === "predict"; });
        return { boot: boot, runtime: rt };
    }

    /* ---------- 资源收集 ---------- */

    /* 首页素材：pages.title.background + customButtons 的 image/hover。
     * 与 theme.js buildTitlePage 读取的字段一一对应。 */
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

    /* 某系统页是否启用（被禁用的功能不加载其专属素材）。
     * gallery/branches/chapters：目录无数据视为禁用；其余系统页（save/load/settings/about）始终启用。 */
    function isPageEnabled(k, catalog) {
        catalog = catalog || {};
        if (k === "gallery")  return (catalog.gallery  && catalog.gallery.length  > 0);
        if (k === "branches")  return (catalog.branches && catalog.branches.length > 0);
        if (k === "chapters") return (catalog.chapters && catalog.chapters.length > 0);
        return true;
    }

    /* 系统界面素材：首页 + 各启用系统页背景 + 舞台背景。
     * 跳过禁用功能（如 gallery 无数据则不加载其背景）。 */
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

    /* 全部剧情素材：遍历 window.__SCRIPTS__ 所有剧本，收集 bg/show/music/sound/voice 的 src
     * + 角色档案 characters.json 的全部立绘 + 角色专属对话框。
     * 两层次脚本（chapters.segments）自动展开。 */
    function collectStory(theme, scripts) {
        var out = [];
        scripts = scripts || global.__SCRIPTS__ || {};
        var chars = scripts["story/characters.json"] || {};
        for (var id in chars) {
            var profile = chars[id] || {};
            var sprites = profile.sprites || {};
            for (var sp in sprites) if (sprites[sp]) out.push(resolveAsset(sprites[sp]));
            if (profile.textbox) out.push(resolveAsset(profile.textbox));
        }
        for (var key in scripts) {
            if (key === "story/characters.json" || key === "story/chapters.json") continue;
            var script = scripts[key];
            if (!script) continue;
            var segs = script.segments || {};
            if (script.chapters) {
                segs = {};
                for (var chName in script.chapters) {
                    var ch = script.chapters[chName] || {};
                    var chSegs = ch.segments || {};
                    for (var sn in chSegs) segs[sn] = chSegs[sn];
                }
                if (script.segments) for (var sn2 in script.segments) segs[sn2] = script.segments[sn2];
            }
            for (var segName in segs) {
                var list = segs[segName];
                if (!Array.isArray(list)) continue;
                for (var i = 0; i < list.length; i++) {
                    var c = list[i];
                    if (!c || !c.src) continue;
                    if (c.cmd === "bg" || c.cmd === "scene" ||
                        c.cmd === "show" || c.cmd === "music" ||
                        c.cmd === "sound" || c.cmd === "voice") {
                        out.push(resolveAsset(c.src));
                    }
                }
            }
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

    /* ---------- 预加载器（隐藏 Image / Audio 触发浏览器加载并缓存） ---------- */

    function preloadImage(url) {
        return new Promise(function (resolve) {
            if (!url || cache[url]) return resolve();
            cache[url] = true;
            var img = new Image();
            var settled = false;
            function done() { if (settled) return; settled = true; img.onload = img.onerror = null; resolve(); }
            img.onload = done;
            img.onerror = done;
            setTimeout(done, ASSET_TIMEOUT);
            img.src = url;
        });
    }

    function preloadAudio(url) {
        return new Promise(function (resolve) {
            if (!url || cache[url]) return resolve();
            cache[url] = true;
            var a = new Audio();
            var settled = false;
            function done() { if (settled) return; settled = true; a.oncanplaythrough = a.onerror = a.onloadeddata = null; try { a.src = ""; } catch (e) {} resolve(); }
            a.preload = "auto";
            a.oncanplaythrough = done;
            a.onloadeddata = done;
            a.onerror = done;
            setTimeout(done, ASSET_TIMEOUT);
            a.src = url;
        });
    }

    /* 批量预加载：按扩展名分发到图片/音频加载器；未知扩展名默认按图片处理。
     * 任一失败/超时都不影响其它（均 resolve，绝不 reject）。 */
    function preloadAll(urls) {
        if (!urls || !urls.length) return Promise.resolve();
        return Promise.all(urls.map(function (u) {
            if (!u) return Promise.resolve();
            if (AUDIO_EXT.test(u)) return preloadAudio(u);
            return preloadImage(u);
        }));
    }

    /* ---------- 启动入口：按 boot 策略收集 + 预加载 + 隐藏遮罩 ----------
     * 必须在 theme.js buildAll() 之后调用（DOM 已构造、背景已写入 style）。
     * scripts 透传 window.__SCRIPTS__（构建产物内联）供 collectStory 使用。 */
    async function boot(theme, catalog, scripts) {
        var strat = getStrategy();
        if (strat.boot === "none") { hideMask(); return; }

        var urls = [];
        if (strat.boot === "title" || strat.boot === "system" || strat.boot === "title+story") {
            urls = urls.concat(collectTitle(theme));
        }
        if (strat.boot === "system") {
            urls = urls.concat(collectSystem(theme, catalog));
        }
        if (strat.boot === "title+story") {
            urls = urls.concat(collectStory(theme, scripts));
        }
        // 去重
        var uniq = [];
        var seen = Object.create(null);
        urls.forEach(function (u) { if (u && !seen[u]) { seen[u] = 1; uniq.push(u); } });

        // 总超时兜底：即便个别资源未就绪也不无限卡住玩家
        await Promise.race([
            preloadAll(uniq),
            new Promise(function (r) { setTimeout(r, BOOT_TIMEOUT); })
        ]);
        hideMask();
    }

    /* ---------- 运行时 hook：page 预加载 ----------
     * 由 engine.js showPage 在切换页面前调用（不阻塞切换，后台预载目标页背景）。 */
    function hookPage(pageName, theme, catalog) {
        var strat = getStrategy();
        if (strat.runtime.indexOf("page") === -1) return;
        var urls = collectPageAssets(pageName, theme || (global.__THEME__), catalog);
        preloadAll(urls);
    }

    /* ---------- 运行时 hook：predict 预加载 ----------
     * 由 script.js advance 在推进时调用，从当前 seg/idx 向前扫描 PREDICT_LOOKAHEAD 条，
     * 按「音效/音乐（最高）→ 语音 → 场景背景 → 角色立绘」优先级串行预取。
     * char+sprite 形态的 show 查角色档案（state.chars）解析出立绘 src。 */
    function hookPredict(script, seg, idx) {
        var strat = getStrategy();
        if (strat.runtime.indexOf("predict") === -1) return;
        if (!script || !script.segments) return;
        var list = script.segments[seg];
        if (!list) return;
        idx = idx || 0;

        var sfxUrls = [], voiceUrls = [], bgUrls = [], charUrls = [];
        for (var i = idx; i < list.length && i - idx < PREDICT_LOOKAHEAD; i++) {
            var c = list[i];
            if (!c) continue;
            if ((c.cmd === "sound" || c.cmd === "music") && c.src) sfxUrls.push(resolveAsset(c.src));
            if (c.cmd === "voice" && c.src) voiceUrls.push(resolveAsset(c.src));
            if ((c.cmd === "bg" || c.cmd === "scene") && c.src) bgUrls.push(resolveAsset(c.src));
            if (c.cmd === "show") {
                var src = c.src || resolveCharSprite(c.char, c.sprite);
                if (src) charUrls.push(resolveAsset(src));
            }
        }
        // 优先级串行：音效/音乐最先发起请求（带宽优先），完成后再语音→背景→立绘。
        preloadAll(sfxUrls)
            .then(function () { return preloadAll(voiceUrls); })
            .then(function () { return preloadAll(bgUrls); })
            .then(function () { return preloadAll(charUrls); });
    }

    /* 查角色档案解析立绘 src（与 script.js showChar 同源逻辑，但从运行时 state 读取已加载档案）。 */
    function resolveCharSprite(charId, sprite) {
        var S = global.AliceADVScript;
        var chars = (S && S.state && S.state.chars) || {};
        var profile = chars[charId] || {};
        var sprites = profile.sprites || {};
        var sp = sprite || (function () { for (var k in sprites) return k; })() || null;
        return sp ? sprites[sp] : null;
    }

    global.AliceADVPreload = {
        boot: boot, showMask: showMask, hideMask: hideMask, getStrategy: getStrategy,
        hookPage: hookPage, hookPredict: hookPredict,
        preloadAll: preloadAll,
        collectTitle: collectTitle, collectSystem: collectSystem, collectStory: collectStory,
        collectPageAssets: collectPageAssets
    };
})(window);
