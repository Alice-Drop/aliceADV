/* =========================================================
 * aliceADV engine — 剧本运行时 (script runtime)
 *
 * 剧本格式：每章一个 JSON 文件（story/chX.json），角色档案 story/characters.json。
 * 剧本目录（章节/分支/画廊 + 播放顺序）由 story/chapters.json 管理，与 theme.json 解耦。
 * 剧情按『段 segments』组织；分支判定点用 decide（判定）指令。
 *
 * 指令集：
 *   bg      { src, transition? }                 切换背景；transition:"fade" = 黑幕落→换图→黑幕起
 *                                                 （转场期间阻塞，等价 Ren'Py 的 with fade）
 *   music   { src?, stop?, volume?, fade? }       音乐控制（循环）
 *   sound   { src, volume? }                       音效（一次性，不循环）
 *   stop    { what }                              停止：what = "music" | "sound" | "all"
 *   show    { char?, sprite?, src?, at?, transition?, anim? }   立绘/图片出现
 *           - char+sprite：查角色档案 sprites
 *           - src：直接显示一张图片（如 demo 的 creatures），无需角色档案
 *           - at：left / center / right（默认 center）
 *   hide    { char?|src?, transition? }            立绘/图片消失；不给 char/src = 清空场上全部
 *   sprite  { char, sprite, anim? }               切换立绘/表情
 *   say     { char, text, sprite?, as? }          角色说话（as = 临时显示名）
 *   narrate { text, mode? }                        旁白；mode="nvl" 走 NVL 整屏模式
 *   nvlclear { }                                  清空 NVL 整屏（Ren'Py: nvl clear）
 *   rename  { char, to }                          角色改名（??? → 真名）
 *   decide  { prompt?, options:[{text, goto}] }   判定（选项分支）
 *   goto    { segment }                           跳转到段
 *   set     { var, op?, value? }                  写变量（op: = add sub mul div toggle append；非阻塞）
 *   if      { test|var+op+value, goto?, else? }   条件跳转（命中 goto / 未命中 else / 皆空则继续当前段）
 *   pause   { seconds?|ms? }                       纯停顿（不显示对话框）：默认等玩家点击，
 *                                                 给 seconds/ms 则定时自动继续（点击可跳过）
 *   wait    { seconds?|ms? }                       演出等待（同 pause 的定时形态，缺省 800ms）
 *   title   { text }                              章节标题卡
 *   end     { action? }                           章节结束（title/chapters）
 *
 * 变量系统：脚本根 "vars":{...} 为初始值；decide 选项可 record（记选项文本/value）与 set（批量写）。
 *   单条指令可附 "if": "<表达式>" 字段：条件不满足则跳过该指令（不阻塞当前段推进）。
 *   文本内支持行内条件：{if 条件: "文本"; elif 条件: "文本"; else: "文本"}（随 state.vars 实时解析）。
 *   条件表达式仅支持 变量/数字/字符串/比较/逻辑/算术(+ - * /)/括号，不使用 eval，杜绝注入。
 *   两层次：脚本根 "chapters":{ 章名:{ start?, segments } } 为宏观组织；运行时扁平化为全局段名。
 *
 * 历史记录：say/narrate（含 nvl）播放时写入 history；exit() 退出播放时清空。
 * ========================================================= */

(function (global) {
    "use strict";

    const CHAR_PATH = "story/characters.json";
    const TYPE_SPEED = 26;   // ms/字
    const TITLE_CARD_MS = 2200;

    const state = {
        script: null,          // 当前章节剧本
        chars: null,           // 角色档案
        names: {},             // 运行时显示名（支持改名）
        seg: null,             // 当前段 id
        idx: 0,                // 当前段内指令下标
        charsOnStage: {},      // { id: { src, at } }  —— 存解析后的图片，渲染与档案解耦
        nodeMap: {},           // { id: DOMNode }      立绘节点索引
        bg: null,
        music: null,           // { src, volume, loop }  loop: Infinity=无限 / 0=一次性 / N=播 N 次
        voice: null,           // { src, volume }  一次性语音通道状态
        nvlLines: [],          // NVL 整屏累积文本
        playing: false,
        waiting: false,        // 等待用户点击
        deciding: false,       // 选项展示中
        typing: null,          // 打字机 timer（活跃打字中）
        typeParts: null,       // 解析后的带停顿分段：[{text, wait}]
        typeSi: 0,              // 当前段下标
        typeCi: 0,              // 当前段已打字字符数
        typePrefix: "",         // append 时已显示在屏上、须保留的前置文本
        awaitClick: false,     // 句中 {w} 等待点击续打
        typePauseTimer: null,  // 句中 {w=N} 计时续打 timer
        waitTimer: null,       // 定时等待 timer（可点击跳过）
        history: [],           // [{name, text}]
        snaps: [],             // 每句台词后的快照（用于后退一句）
        vars: {},              // 全局变量（游玩期有效，start/exit 重置）
        chapters: null,        // 两层次：章节元数据（宏观组织）
        initVars: {},          // 变量初始值副本
        auto: false,
        skip: false,
        autoTimer: null,
        skipTimer: null,
        barrier: false,        // 资源兜底等待中（#wait-mask 已显示）：期间点击不推进，见 next()
        epoch: 0,              // 播放会话代号：每次 stopPlayback() 递增。
                               // advance() 变异步后，barrier 等待会跨过「退出一局 → 进入下一局」，
                               // 醒来时必须据此判断这条推进是否还属于当前这一局。
        step: 0                // 推进计数：每调用一次 advance() 递增。
                               // 异步演出（如背景 fade 的解码回调）据此判断「玩家是否早已把这条推过去」。
    };

    /* 上一次「进入玩家等待」的时刻（ms）。用于实测玩家的翻页节奏：
     * 玩家点击推进 → advance() 读这个时间戳算出间隔，交给 preload.js 的 reportDwell()
     * 换算成「一句多少秒」。定时自动推进（wait / pause / 标题卡）必须先把它清零，
     * 否则会把演出时长当成玩家的翻页速度，把时间窗口算飞（见 advanceTimed）。 */
    let lineClock = 0;

    /* 定时自动推进：先把「玩家等待起点」清零再推进，使这次推进不产生节奏样本。 */
    function advanceTimed() {
        lineClock = 0;
        return advance();
    }

    /* 快进时是否跳过语音。判据只有一处 —— preload.js 的 skipVoiceActive()，
     * 它同时管「不预载语音」，两处必须同源；preload.js 缺席时按同一份 info.json 配置兜底。 */
    function skipVoiceNow() {
        if (global.AliceADVPreload && global.AliceADVPreload.skipVoiceActive) {
            return global.AliceADVPreload.skipVoiceActive();
        }
        const ff = (((global.__THEME__ || {}).info || {}).preload || {}).fastForward || {};
        return state.skip && ff.skipVoice !== false;
    }

    /* 把当前播放模式（正常 / 自动 / 快进）上报给预加载器：窗口长度以「秒」计，
     * 模式决定「一句多少秒」，因此模式一变，待发集合与排序都要重算。 */
    function syncPlaybackMode() {
        const P = global.AliceADVPreload;
        if (!P) return;
        if (P.setPlaybackMode) P.setPlaybackMode(state.skip ? "skip" : (state.auto ? "auto" : "normal"));
        if (state.playing && state.script && state.seg && P.replan) {
            P.replan(state.script, state.seg, state.idx);
        }
    }

    /* ---------- DOM 工具 ---------- */
    function $(sel) { return document.querySelector(sel); }
    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }
    function clearNode(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
    function stageRoot() { return document.getElementById("page_stage"); }

    /* ---------- 安全表达式求值器（条件跳转 / 行内 {if} / 单指令 if） ----------
       不使用 eval；仅支持 变量 / 数字 / 字符串 / 比较(== != >= <= > <) /
       逻辑(&& || !) / 算术(+ - * /) / 括号。变量取自 state.vars。 */
    function truthy(x) { return !!x; }
    function numOf(x) { if (typeof x === "number") return x; if (x == null) return 0; const n = parseFloat(x); return isNaN(n) ? 0 : n; }
    function cmpOp(a, op, b) {
        switch (op) {
            case "==": return a == b;   // 宽松比较，便于 数字/字符串 互通
            case "!=": return a != b;
            case ">":  return a > b;
            case "<":  return a < b;
            case ">=": return a >= b;
            case "<=": return a <= b;
        }
        return false;
    }
    function tokenizeExpr(s) {
        const toks = []; let i = 0; const n = s.length;
        const isDig = c => c >= "0" && c <= "9";
        const isId0 = c => /[A-Za-z_$一-龥]/.test(c);
        const isId  = c => /[A-Za-z0-9_$]/.test(c);
        while (i < n) {
            const c = s[i];
            if (/\s/.test(c)) { i++; continue; }
            if (c === '"' || c === "'") {
                let j = i + 1, buf = "";
                while (j < n && s[j] !== c) { buf += s[j]; j++; }
                toks.push({ t: "str", v: buf }); i = j + 1; continue;
            }
            if (isDig(c) || (c === "." && isDig(s[i + 1]))) {
                let j = i, buf = "";
                while (j < n && /[0-9.]/.test(s[j])) { buf += s[j]; j++; }
                toks.push({ t: "num", v: parseFloat(buf) }); i = j; continue;
            }
            if (isId0(c)) {
                let j = i, buf = "";
                while (j < n && isId(s[j])) { buf += s[j]; j++; }
                toks.push({ t: "id", v: buf }); i = j; continue;
            }
            const two = s.substr(i, 2);
            if (two === "&&" || two === "||" || two === "==" || two === "!=" || two === ">=" || two === "<=") {
                toks.push({ t: "op", v: two }); i += 2; continue;
            }
            if ("+-*/<>!()".indexOf(c) !== -1) { toks.push({ t: "op", v: c }); i++; continue; }
            throw new Error("表达式非法字符: " + c);
        }
        return toks;
    }
    function parseExpr(toks) {
        let pos = 0;
        const peek = () => toks[pos];
        const eat  = () => toks[pos++];
        function pOr()  { let l = pAnd(); while (peek() && peek().t === "op" && peek().v === "||") { eat(); l = truthy(l) || truthy(pAnd()); } return l; }
        function pAnd() { let l = pNot(); while (peek() && peek().t === "op" && peek().v === "&&") { eat(); l = truthy(l) && truthy(pNot()); } return l; }
        function pNot() { if (peek() && peek().t === "op" && peek().v === "!") { eat(); return !truthy(pNot()); } return pCmp(); }
        function pCmp() {
            let l = pAdd();
            while (peek() && peek().t === "op" && ["==", "!=", ">", "<", ">=", "<="].indexOf(peek().v) !== -1) {
                const op = eat().v; const r = pAdd(); l = cmpOp(l, op, r);
            }
            return l;
        }
        function pAdd() { let l = pMul(); while (peek() && peek().t === "op" && (peek().v === "+" || peek().v === "-")) { const op = eat().v; const r = pMul(); l = op === "+" ? l + r : l - r; } return l; }
        function pMul() { let l = pUn(); while (peek() && peek().t === "op" && (peek().v === "*" || peek().v === "/")) { const op = eat().v; const r = pUn(); l = op === "*" ? l * r : (r === 0 ? 0 : l / r); } return l; }
        function pUn()  { if (peek() && peek().t === "op" && peek().v === "-") { eat(); return -pUn(); } return pPrim(); }
        function pPrim() {
            const tk = eat();
            if (!tk) throw new Error("表达式不完整");
            if (tk.t === "num") return tk.v;
            if (tk.t === "str") return tk.v;
            if (tk.t === "id") {
                if (tk.v === "true") return true;
                if (tk.v === "false") return false;
                if (tk.v === "null") return null;
                const v = state.vars[tk.v];
                return v === undefined ? null : v;
            }
            if (tk.t === "op" && tk.v === "(") { const e = pOr(); if (peek() && peek().v === ")") eat(); return e; }
            throw new Error("表达式语法错误: " + tk.v);
        }
        return pOr();
    }
    function evalExpr(src) {
        try {
            const toks = tokenizeExpr(String(src == null ? "" : src).trim());
            if (!toks.length) return false;
            return parseExpr(toks);
        } catch (e) {
            console.warn("[aliceADV] 条件表达式求值失败:", src, e);
            return false;
        }
    }
    // 结构化条件（if 字段用 var/op/value 时）→ 表达式字符串
    function buildCond(c) {
        const v = c.value;
        const sv = (typeof v === "string") ? '"' + String(v).replace(/"/g, '\\"') + '"'
                 : (v === true ? "true" : v === false ? "false" : (v === null ? "null" : String(v)));
        return (c.var) + " " + (c.op || "==") + " " + sv;
    }
    function condTest(c) {
        const expr = (c.test != null) ? c.test : buildCond(c);
        return evalExpr(expr);
    }
    // 应用一条 set 规格：{ var, op?, value? }
    function applySetSpec(s) {
        if (!s || !s.var) return;
        const cur = state.vars[s.var];
        const op = s.op || "=";
        const val = s.value;
        switch (op) {
            case "=":  state.vars[s.var] = val; break;
            case "add": state.vars[s.var] = numOf(cur) + numOf(val); break;
            case "sub": state.vars[s.var] = numOf(cur) - numOf(val); break;
            case "mul": state.vars[s.var] = numOf(cur) * numOf(val); break;
            case "div": state.vars[s.var] = (numOf(val) === 0 ? 0 : numOf(cur) / numOf(val)); break;
            case "toggle": state.vars[s.var] = !truthy(cur); break;
            case "append":
                if (Array.isArray(cur)) { cur.push(val); state.vars[s.var] = cur; }
                else state.vars[s.var] = String(cur == null ? "" : cur) + String(val == null ? "" : val);
                break;
            default: state.vars[s.var] = val;
        }
    }
    // 行内条件文本：{if 条件: "文本"; elif 条件: "文本"; else: "文本"}
    function resolveText(t) {
        if (typeof t !== "string" || t.indexOf("{if") === -1) return t;
        return t.replace(/\{if\s+([\s\S]*?)\}/g, (m, body) => {
            const clauses = [];
            splitRespectQuotes(body, ";").forEach((raw, idx) => {
                const p = raw.trim(); if (!p) return;
                const km = p.match(/^(if|elif|else)\b\s*([\s\S]*)$/);
                let kind, rest;
                if (km) { kind = km[1]; rest = km[2].trim(); }
                else if (idx === 0) { kind = "if"; rest = p; }   // 首段可省略 if 关键字
                else return;                                     // 后续段必须有 elif/else 关键字
                if (kind === "else") {
                    let txt = rest; if (txt[0] === ":") txt = txt.slice(1).trim();
                    clauses.push({ kind, text: txt });
                } else {
                    const ci = rest.indexOf(":");
                    if (ci === -1) { clauses.push({ kind, cond: rest, text: "" }); return; }
                    clauses.push({ kind, cond: rest.slice(0, ci).trim(), text: rest.slice(ci + 1).trim() });
                }
            });
            for (const cl of clauses) {
                if (cl.kind === "else") return unquote(cl.text);
                if (evalExpr(cl.cond)) return unquote(cl.text);
            }
            return "";
        });
    }
    function splitRespectQuotes(s, sep) {
        const out = []; let buf = ""; let q = null;
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (q) { buf += c; if (c === q) q = null; continue; }
            if (c === '"' || c === "'") { q = c; buf += c; continue; }
            if (c === sep) { out.push(buf); buf = ""; continue; }
            buf += c;
        }
        out.push(buf);
        return out;
    }
    function unquote(t) {
        t = (t == null ? "" : String(t)).trim();
        if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) return t.slice(1, -1);
        return t;
    }

    /* ---------- 资源加载（构建产物内联 window.__SCRIPTS__ 优先） ---------- */
    async function fetchJSON(path) {
        const inline = global.__SCRIPTS__;
        if (inline && inline[path] !== undefined) return inline[path];
        const r = await fetch(path);
        if (!r.ok) throw new Error("加载失败: " + path);
        return await r.json();
    }

    /* ---------- 音频：music（循环/可指定次数）+ sound（一次性）+ voice（一次性·绑台词）三通道 ---------- */
    let audio = null;          // 音乐通道
    let sfx = null;            // 音效通道
    let voiceAudio = null;     // 语音通道（一次性）
    let musicLoopTarget = Infinity; // 音乐播放次数目标：Infinity=无限循环
    let musicLoopCount = 0;    // 已完成的循环次数

    // 解析 loop 参数：缺省 / true / "INF" => 无限；false / 0 => 一次性；正整数 N => 播 N 次
    function parseLoop(c) {
        const v = c.loop;
        if (v === undefined || v === null) return Infinity;
        if (v === true) return Infinity;
        if (v === false || v === 0) return 0;
        if (typeof v === "string") {
            const s = v.trim().toUpperCase();
            if (s === "INF" || s === "INFINITY" || s === "∞") return Infinity;
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) return n;
        }
        if (typeof v === "number") return v > 0 ? Math.floor(v) : 0;
        return Infinity;
    }

    // 播放一次性语音（独立通道，播新停旧）
    function playVoice(src, volume) {
        if (!src) return;
        if (!voiceAudio) voiceAudio = new Audio();
        else { try { voiceAudio.pause(); } catch (e) {} }
        voiceAudio.loop = false;
        voiceAudio.volume = (volume != null) ? volume : (voiceAudio.volume ? voiceAudio.volume : 1.0);
        voiceAudio.src = src;
        voiceAudio.play().catch(() => {});
        state.voice = { src, volume: voiceAudio.volume };
    }

    function musicCmd(c) {
        if (!audio) audio = new Audio();
        if (!c.src) return;
        const target = (c.volume != null) ? c.volume : 0.6;
        const fade = (c.fade || 0) * 1000;
        // ifChanged：同曲已在播则不重启（对齐 Ren'Py if_changed）
        if (c.ifChanged && state.music && state.music.src === c.src && !audio.paused) return;

        const loop = parseLoop(c);
        musicLoopTarget = loop;
        musicLoopCount = 0;

        const needSwap = (audio.src !== new URL(c.src, document.baseURI).href);
        if (needSwap) audio.src = c.src;
        // 有限次 / 一次性：loop=false，靠 ended 事件重播或停止；无限：loop=true 浏览器自动循环
        audio.loop = (loop === Infinity);
        audio.onended = function () {
            if (musicLoopTarget === Infinity) { // 不应发生（loop=true 已自动循环），保险处理
                try { audio.currentTime = 0; } catch (e) {}
                audio.play().catch(() => {});
                return;
            }
            if (musicLoopCount < musicLoopTarget - 1) {
                musicLoopCount++;
                try { audio.currentTime = 0; } catch (e) {}
                audio.play().catch(() => {});
            } else { // 播满 N 次，自动停止
                audio.pause();
                audio.onended = null;
                state.music = null;
            }
        };

        const startFrom = fade ? 0 : target;
        audio.volume = startFrom;
        audio.play().catch(() => {}); // 无手势时静默失败

        if (fade) {
            const t0 = Date.now();
            const iv = setInterval(() => {
                const p = Math.min(1, (Date.now() - t0) / fade);
                audio.volume = startFrom + (target - startFrom) * p;
                if (p >= 1) clearInterval(iv);
            }, 50);
        } else {
            audio.volume = target;
        }
        state.music = { src: c.src, volume: target, loop };
    }

    function soundCmd(c) {
        if (!c.src) return;
        if (!sfx) sfx = new Audio();
        sfx.loop = false;
        sfx.volume = (c.volume != null) ? c.volume : (sfx.volume ? sfx.volume : 0.85);
        sfx.src = c.src;
        sfx.play().catch(() => {});
    }

    function stopCmd(c) {
        const what = (c.what || "all").toLowerCase();
        const fade = (c.fade || 0) * 1000;
        if (what === "music" || what === "all") {
            if (audio) {
                if (fade) {
                    const from = audio.volume;
                    const t0 = Date.now();
                    const iv = setInterval(() => {
                        const p = Math.min(1, (Date.now() - t0) / Math.max(fade, 1));
                        audio.volume = from * (1 - p);
                        if (p >= 1) {
                            clearInterval(iv);
                            audio.pause();
                            try { audio.currentTime = 0; } catch (e) {}
                        }
                    }, 50);
                } else {
                    audio.pause();
                    try { audio.currentTime = 0; } catch (e) {}
                }
                audio.onended = null;
                musicLoopTarget = Infinity;
                musicLoopCount = 0;
            }
            state.music = null;
        }
        if (what === "sound" || what === "all") {
            if (sfx) { sfx.pause(); try { sfx.currentTime = 0; } catch (e) {} }
        }
        if (what === "voice" || what === "all") {
            if (voiceAudio) { voiceAudio.pause(); try { voiceAudio.currentTime = 0; } catch (e) {} }
            state.voice = null;
        }
    }

    /* ---------- 后台暂停：页面切到后台（隐藏）时暂停全部音频，回到前台仅恢复原本在播的通道 ----------
       解决「网页退到后台仍播放音乐、甚至出现在系统媒体控件（OS Media Session）」的问题：
       浏览器会把任意正在播放的 <audio> 自动登记进系统媒体控件，故切后台时必须主动暂停，
       并显式把 navigator.mediaSession.playbackState 置为 "none" 以清除/阻止系统控件条目；
       回到前台时只恢复隐藏前确实在播的通道，保留用户主动暂停的意图。 */
    let _bgAudioPlaying = false;
    let _bgSfxPlaying = false;
    let _bgVoicePlaying = false;

    function _pauseForBackground() {
        _bgAudioPlaying = !!(audio && !audio.paused);
        _bgSfxPlaying = !!(sfx && !sfx.paused);
        _bgVoicePlaying = !!(voiceAudio && !voiceAudio.paused);
        if (audio) { try { audio.pause(); } catch (e) {} }
        if (sfx) { try { sfx.pause(); } catch (e) {} }
        if (voiceAudio) { try { voiceAudio.pause(); } catch (e) {} }
        if (navigator.mediaSession) {
            try { navigator.mediaSession.playbackState = "none"; } catch (e) {}
        }
    }

    function _resumeFromBackground() {
        if (_bgAudioPlaying && audio) { try { audio.play().catch(() => {}); } catch (e) {} }
        if (_bgSfxPlaying && sfx) { try { sfx.play().catch(() => {}); } catch (e) {} }
        if (_bgVoicePlaying && voiceAudio) { try { voiceAudio.play().catch(() => {}); } catch (e) {} }
        if (navigator.mediaSession && _bgAudioPlaying) {
            try { navigator.mediaSession.playbackState = "playing"; } catch (e) {}
        }
    }

    function _onVisibilityChange() {
        if (document.hidden) _pauseForBackground();
        else _resumeFromBackground();
    }

    if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", _onVisibilityChange);
    }

    /* ---------- 舞台渲染 ----------
     * 背景转场：transition:"fade" 等价 Ren'Py 的 with fade ——
     *   黑幕落下（淡出）→ 幕后备好并换上目标图 → 黑幕升起（淡入）。
     * 幕布是 .stage-fade 层（theme.js 搭骨架时插在 .stage-bg 之上、.stage-chars 之下），
     * 所以淡出淡入全程既不会露 .stage-bg 的兜底色，也不会闪出尚未解码的图。
     * 淡入淡出时长只写在 CSS（stage.css 的 .stage-fade），JS 读计算值，避免两处各写一份。
     * 转场进行中该指令阻塞（setBg 返回 true），与 Ren'Py 的 with 一致：
     *   玩家在转场中点一下 = 立即结束转场并推进一句；快进(skip)模式不播转场，直接换图。
     */
    let bgSeq = 0;      // 转场令牌：每次 setBg 递增，旧转场的延时回调据此自动作废
    let bgFade = null;  // 进行中的转场 { seq, step, apply, timer, pending }
                        // pending=true 表示「已开始转场、新图还在解码」：此时还没有可换的图，
                        // 点击不推进（否则这次换图会被作废、幕布停在满幕）

    function veilEl() {
        const root = stageRoot();
        return root ? root.querySelector(".stage-fade") : null;
    }

    function bgFadeMs(veil) {
        const raw = String(global.getComputedStyle(veil).transitionDuration || "").split(",")[0].trim();
        const n = parseFloat(raw) || 0;
        return /ms\s*$/.test(raw) ? n : n * 1000;
    }

    /* 目标图就绪（含 CSS 二次解码）。图缺失也要收尾，绝不把玩家留在黑幕里。
     *
     * **必须有超时。** decode 只在「响应到了」之后才会被调用：若这张图根本没有响应
     * （请求被中止、服务器挂着不回），decodeImage 就永远不 settle —— 转场停在「等图」阶段，
     * 幕布一直不透明、state.waiting 一直是 true，玩家看到的是**永久黑屏**，
     * 而且新加的「pending 期间吸收点击」会让点也点不动，只能刷新页面。
     * 超时语义与预加载的 ASSET_TIMEOUT 一致：只解除等待，**不中止下载**（该下继续下）。
     * 放行后照常 apply() + 揭幕：这张图这一刻画不出来时，露出的是下层兜底图，而不是黑洞。 */
    const DECODE_TIMEOUT_MS = 30000;
    /* 在途解码探针的强引用。与 preload.js 的 inflight 同理：元素若只被局部变量引用，
     * GC 回收它时 Chrome 会中止在途请求，于是「等超时 → 图被中止 → 永远等不到」。 */
    const decodeHolds = [];
    function decodeImage(src) {
        return new Promise(resolve => {
            const probe = new Image();
            decodeHolds.push(probe);
            let settled = false, released = false;
            let timer = null;
            // 放行「等待」（不碰引用与事件，下载继续）
            const settle = () => { if (settled) return; settled = true; resolve(); };
            // 真正结束：这时才可以释放引用、摘掉事件
            const drop = () => {
                if (released) return;
                released = true;
                const k = decodeHolds.indexOf(probe);
                if (k !== -1) decodeHolds.splice(k, 1);
                probe.onload = probe.onerror = null;
            };
            const finish = () => { clearTimeout(timer); drop(); settle(); };
            probe.onload = function () {
                if (probe.decode) probe.decode().then(finish).catch(finish);
                else finish();
            };
            probe.onerror = finish;
            timer = setTimeout(settle, DECODE_TIMEOUT_MS);
            probe.src = src;
            if (probe.complete && probe.naturalWidth > 0) finish();
        });
    }

    // 揭幕。只有最新的那次转场有权揭幕：被后续转场接管的旧回调不得动幕布，
    // 否则会在新转场刚落幕时把幕布撤掉（画面瞬间闪回旧图）。
    function liftVeil(seq) {
        requestAnimationFrame(() => {
            if (seq !== bgSeq) return;
            const veil = veilEl();
            if (veil) veil.classList.remove("is-on");
        });
    }

    // 转场收尾：换图 + 揭幕 + 放行被阻塞的推进。定时到期与玩家点击都走这里。
    function settleBgFade(seq) {
        const f = bgFade;
        if (!f || (seq != null && f.seq !== seq)) return;
        if (!f.apply) return;   // pending（图还在解码）阶段无图可换，只能等解码结束
        bgFade = null;
        clearTimeout(f.timer);
        f.apply();
        liftVeil(f.seq);
        if (state.playing && state.waiting) { state.waiting = false; advanceTimed(); }
    }

    function setBg(src, transition) {
        const bg = stageRoot() && stageRoot().querySelector(".stage-bg");
        if (!bg) return false;
        // 当前已在场上显示的背景（上一张，或首张时主题兜底图 roof.png），
        // 作为新图解码期间的下层兜底，避免 CSS 重解码 new 的瞬间露出 .stage-bg 的蓝紫背景色。
        const current = state.bg || (function () {
            const m = (bg.style.backgroundImage || "").match(/url\("?([^"]+?)"?\)/);
            return m ? m[1] : "";
        })();
        const apply = () => {
            if (src) {
                // 新图在上层、当前图在下层；新图解码期间下层兜底显示，绝不露蓝紫兜底色。
                // 注意 current 是裸路径，必须各自包成 url(...) 才是合法的多层 background-image，
                // 否则整条声明会被浏览器丢弃、只剩 background-color（蓝紫）兜底色。
                bg.style.backgroundImage = `url("${src}")` + (current ? `, url("${current}")` : "");
                bg.style.backgroundSize = current ? "cover, cover" : "cover";
                bg.style.backgroundPosition = current ? "center, center" : "center";
                bg.style.backgroundRepeat = current ? "no-repeat, no-repeat" : "no-repeat";
            } else {
                bg.style.backgroundImage = "none";
            }
            bg.style.opacity = "1";
        };
        // 本场故事的第一张背景：舞台刚从标题页切过来，没有「上一张图」可淡出。
        // 显式从黑场淡入（而不是让幕布 0→1 落下），否则这一瞬间会露出主题兜底图
        // （兜底图缺失时就是 .stage-bg 的蓝紫渐变），既难看又依赖浏览器是否给
        // 「刚由 display:none 变可见的元素」播过渡动画。此处不依赖任何浏览器特性。
        const fromBlank = state.bg == null;
        state.bg = src; // 先记状态：下层兜底图 / 快照 / 存档缩略图都以它为准
        // 本次切换接管转场：作废上一场（换图与揭幕由本次负责，不留悬挂等待）
        if (bgFade) { clearTimeout(bgFade.timer); bgFade = null; }
        const seq = ++bgSeq;

        const veil = veilEl();
        if (transition === "fade" && src && veil && !state.skip) {
            // 上一场转场尚未揭幕 → 幕布已在位，不必再落一次幕（连点切图时保持黑场，不来回闪）
            const covered = veil.classList.contains("is-on");
            if (!covered) {
                if (fromBlank) {
                    // 直接落在满幕：临时关掉过渡，结算后再恢复，避免首帧闪出兜底图
                    veil.style.transition = "none";
                    veil.classList.add("is-on");
                    void veil.offsetWidth;
                    veil.style.transition = "";
                } else {
                    veil.classList.add("is-on");
                }
            }
            const t0 = Date.now();
            const step = state.step; // 本次演出所属的推进步
            // **先登记转场，再解码**（pending = 新图尚未解码）。这个顺序不能颠倒：
            // 若等 decodeImage 落定后才登记，解码这段时间里 bgFade 为 null，
            // 玩家的点击（以及自动/快进的节拍）就会绕过 next() 的转场分支直接推进剧情，
            // bgSeq 随之递增 → 本次换图被判定作废 → 幕布停在满幕不动，
            // 玩家看到的就是**背景全黑**且越点越黑。pending 期间 next() 一律吸收点击。
            bgFade = { seq: seq, step: step, apply: null, timer: null, pending: true };
            decodeImage(src).then(() => {
                if (seq !== bgSeq) return; // 期间又切了背景：本次作废（幕布归新的那次管）
                if (state.step !== step) {
                    // 解码期间这一步已被别处推过（外部 advance / 跳段 / 读档）：
                    // 只把图换上并揭幕，不再拦住推进
                    if (bgFade && bgFade.seq === seq) bgFade = null;
                    apply(); liftVeil(seq); return;
                }
                // 帷幕落满 + 图就绪 是两条并行条件，谁慢等谁；
                // 已在幕中（covered）与首图从黑场淡入（fromBlank）都无需再等落满时长
                const hold = (covered || fromBlank) ? 0 : Math.max(0, bgFadeMs(veil) - (Date.now() - t0));
                bgFade = { seq: seq, step: step, apply: apply,
                           timer: setTimeout(() => settleBgFade(seq), hold), pending: false };
                state.waiting = true; // 转场期间阻塞（advance 据此停在本条指令）
            });
            return true;
        }
        apply();
        liftVeil(seq);
        return false;
    }

    function nodeId(c) { return c.src ? ("__src__" + c.src) : c.char; }

    // 立绘节点管理：
    //   state.nodeMap[id]      —— 当前在场上（非待移除）的节点
    //   state.hidingNodes[id]  —— 已被 hide 但延迟到下一帧才真正移除的节点
    //                              （用于把「同一步内的 hide X + show X」折叠成无操作，避免闪烁）
    //   state.hideTimers[id]   —— 对应的延迟移除计时器
    function ensureHideMaps() {
        if (!state.hidingNodes) state.hidingNodes = {};
        if (!state.hideTimers) state.hideTimers = {};
    }

    function cancelPendingHide(id) {
        ensureHideMaps();
        if (state.hidingNodes[id]) delete state.hidingNodes[id];
        if (state.hideTimers[id]) { clearTimeout(state.hideTimers[id]); delete state.hideTimers[id]; }
    }

    // 同 id 的立绘当前是否「已在场上且属性完全一致（相同 src/站位，无显式动画/转场）」
    function isSameShown(node, c, src) {
        return node.getAttribute("src") === (src || "")
            && node.className.indexOf("at-" + (c.at || "center")) !== -1
            && !c.anim && c.transition !== "fade";
    }

    function showChar(c) {
        ensureHideMaps();
        const id = nodeId(c);
        let src;
        if (c.src) {
            src = c.src;
        } else {
            const profile = (state.chars || {})[c.char] || {};
            const sprite = c.sprite || Object.keys(profile.sprites || {})[0];
            src = (profile.sprites || {})[sprite];
        }

        // 情形 A：上一步刚 hide 了这个 id，同一步内又 show 同一立绘
        //         → 取消待移除，复用仍挂在 DOM 上的节点，视为无操作（不闪烁）。
        if (state.hidingNodes[id]) {
            const node = state.hidingNodes[id];
            cancelPendingHide(id);
            state.nodeMap[id] = node;
            if (isSameShown(node, c, src)) {
                state.charsOnStage[id] = { src: src || "", at: c.at || "center" };
                return;
            }
            applyCharVisual(node, c, src, id);
            return;
        }

        // 情形 B：节点本就在场上
        let node = state.nodeMap[id];
        if (node) {
            // 冗余的「再次 show 同一立绘」→ 无操作，绝不重启淡入/重建。
            if (isSameShown(node, c, src)) {
                state.charsOnStage[id] = { src: src || "", at: c.at || "center" };
                return;
            }
            applyCharVisual(node, c, src, id);
            return;
        }

        // 情形 C：首次出现 → 真正新建（带一次入场，若未指定 anim 则用 anim-fade 淡入）
        node = document.createElement("img");
        node.className = "stage-char at-" + (c.at || "center")
            + (c.anim ? " anim-" + c.anim : " anim-fade");
        node.setAttribute("data-char", id);
        node.draggable = false;
        const layer = stageRoot().querySelector(".stage-chars");
        if (layer) layer.appendChild(node);
        state.nodeMap[id] = node;
        if (c.transition === "fade") {
            node.style.opacity = "0";
            requestAnimationFrame(() => { node.style.opacity = "1"; });
        }
        if (src) node.src = src;
        state.charsOnStage[id] = { src: src || "", at: c.at || "center" };
    }

    // 把「站位 / 动画 / 淡入 / 图片」应用到已有立绘节点（情形 A、B 的「真有变化」分支）。
    function applyCharVisual(node, c, src, id) {
        if (c.anim) {
            node.className = node.className.replace(/\s*anim-\w+/g, "");
            void node.offsetWidth; // 重启动画
            node.classList.add("anim-" + c.anim);
        } else {
            node.className = "stage-char at-" + (c.at || "center");
        }
        if (c.transition === "fade") {
            node.style.opacity = "0";
            requestAnimationFrame(() => { node.style.opacity = "1"; });
        }
        if (src) node.src = src;
        state.charsOnStage[id] = { src: src || "", at: c.at || "center" };
    }

    /* ---------- 同拍立绘折叠（本拍内 hide X → show X）----------
     * 转换器产物里有大量成对的「hide X; show X」，意图是「这张图继续留在场上」
     * （girls_out_of_orbit 的 ch1 里这样的成对指令有 339 对，占全部 show 的 85%）。
     * 照字面执行的话，玩家每推进一句都会看到立绘被摘掉又建回来、重播一遍入场淡入
     * —— 即「每推进一句就闪一次进场」。
     *
     * 早期实现靠「延迟移除」折叠：hide 时把节点记进 state.hidingNodes、用
     * setTimeout(remove, 0) 把摘除推到下一个宏任务，期待同一拍里的 show 抢在它之前
     * 把节点认领回去。这个做法是**竞态**：advance() 在每条指令执行前都要
     * await barrier(c)，而图片资源的 barrier 走 probeImage（新建 Image + load + decode），
     * 至少一个宏任务。于是
     *     「hide 排下的 0ms 定时器」 与 「barrier 的 await」
     * 开始赛跑，谁先落地决定折叠成不成立：探针只要慢过那个定时器（图未命中缓存、
     * 主线程忙、限速、开着 DevTools 的禁用缓存……），remove 就先跑——节点被摘掉，
     * 紧随其后的 show 落入「首次出现」分支，新建节点并重播 anim-fade，玩家看到闪烁。
     *
     * 可复现（2026-09-23 实测）：把 barrier 的落地人为延后 30ms，
     * ch1「它的尾巴就像一个粉色棒棒糖」前后 10 句里有 4 句立绘节点被重建。
     *
     * 「这一拍里它还要原样回来」是**剧本层面**的事实，与定时器无关、与 await 快慢无关，
     * 因此判定必须前瞻剧本，而不是赌时序。 */
    // 前瞻可以越过的指令：它不占玩家的一拍，也不改变「场上少了谁」的可见性
    //（show/hide/sprite 是同一拍内的画面编排，其余是不出画面的状态指令）。
    const FOLD_PASS = { show: 1, hide: 1, sprite: 1, music: 1, sound: 1, voice: 1,
                        stop: 1, set: 1, rename: 1, nvlclear: 1 };
    const FOLD_SCAN_MAX = 200;   // 前瞻上限，防病态剧本把它变成 O(n²)

    // 从当前指令往后看：本拍内还会不会「原样重现」同一个立绘？会 → 这条 hide 不必执行。
    function foldsIntoLaterShow(id) {
        const segs = state.script && state.script.segments;
        const node = state.nodeMap[id];
        let list = segs && segs[state.seg];
        if (!list || !node) return false;
        let i = state.idx + 1;
        for (let n = 0; n < FOLD_SCAN_MAX; n++) {
            if (i >= list.length) return false;      // 走到段尾（没有 goto 续接）
            const c = list[i];
            // 条件指令：会不会执行看不出来，保守不折叠
            if (!c || c.if != null) return false;
            // goto 不阻塞，同一拍会跨段继续执行 → 跟到目标段接着看。
            // 回环由 FOLD_SCAN_MAX 兜住。
            if (c.cmd === "goto") {
                const target = segs[c.segment];
                if (!target) return false;
                list = target; i = 0; continue;
            }
            if (c.cmd === "bg" || c.cmd === "scene") {
                // 带淡出的换景会落幕后停一拍，它之后的 show 属于后一拍 → 不越过
                if (c.transition === "fade") return false;
                i++; continue;
            }
            // 表外的指令（say / narrate / decide / title / pause / wait / if …）都终止前瞻：
            // 它们之后的 show 属于后一拍，中间那段「立绘不在场上」是玩家真看得见的。
            if (!FOLD_PASS[c.cmd]) return false;
            if (c.cmd !== "show" || nodeId(c) !== id) { i++; continue; }
            let src;
            if (c.src) {
                src = c.src;
            } else {
                const profile = (state.chars || {})[c.char] || {};
                const sprite = c.sprite || Object.keys(profile.sprites || {})[0];
                src = (profile.sprites || {})[sprite];
            }
            // 只有「原样重现」（同图、同站位、不带动画/转场）才算折叠；
            // 换站位、换表情、自带入场动画都是真要重演一次，照旧走摘除 + 重建。
            return isSameShown(node, c, src);
        }
        return false;
    }

    function hideChar(c) {
        ensureHideMaps();
        // 淡出的规范写法是 transition:"fade"。早期 demo 里把入场动画字段 anim 误用在这里
        // （hide + anim:"fade"），意图很明确，认作淡出——静默变成「啪地消失」比宽容更糟。
        const fade = c.transition === "fade" || c.anim === "fade";
        // 不给 char / src = 清空场上全部立绘与整屏图（谢幕、切章这类要把画面腾空的场合）。
        if (!c.char && !c.src) {
            Object.keys(state.nodeMap).forEach(id => dropChar(id, fade));
            return;
        }
        const id = nodeId(c);
        // 本拍内还会原样再现 → 这条 hide 不执行（否则节点被摘掉、随后的 show 重建并重播入场动画）。
        // 只对硬切生效：带淡出的 hide 是有意为之的演出（淡出本身就是给玩家看的一拍）。
        if (!fade && foldsIntoLaterShow(id)) return;
        dropChar(id, fade);
    }

    // 淡出时长与 .stage-char 的 opacity transition 取同一来源（CSS），不另写一份时长
    // ——与背景幕布 bgFadeMs 同规矩。
    function charFadeMs(node) {
        const raw = String(global.getComputedStyle(node).transitionDuration || "").split(",")[0].trim();
        const n = parseFloat(raw) || 0;
        return /ms\s*$/.test(raw) ? n : n * 1000;
    }

    // 摘掉一个立绘节点。立即从「在场」集合移除（快照/状态立刻反映已隐藏），
    // 但 DOM 节点的实际删除延迟到淡出走完：若同一步内又 show 同一 id，则取消删除、立绘原样保留。
    function dropChar(id, fade) {
        const node = state.nodeMap[id];
        if (!node) return;
        delete state.nodeMap[id];
        delete state.charsOnStage[id];
        state.hidingNodes[id] = node;
        const remove = () => {
            cancelPendingHide(id);
            if (node.parentNode) node.parentNode.removeChild(node);
        };
        if (fade) {
            // 立绘登场默认带 anim-fade（CSS 动画，animation-fill-mode: both）。
            // CSS 动画的优先级高于 inline style，会一直把 opacity 钉在 1——
            // 不先停掉动画，这里写的 opacity:0 根本不生效，角色是「啪」地消失而不是淡出。
            node.style.animation = "none";
            void node.offsetWidth;           // 先让「停动画」落地，再改 opacity，过渡才有起点
            node.style.opacity = "0";
            state.hideTimers[id] = setTimeout(remove, charFadeMs(node) || 320);
        } else {
            state.hideTimers[id] = setTimeout(remove, 0);
        }
    }

    function setSprite(c) {
        const id = c.char;
        const node = state.nodeMap[id] || (state.hidingNodes && state.hidingNodes[id]);
        const profile = (state.chars || {})[id] || {};
        const src = (profile.sprites || {})[c.sprite];
        if (node && src) {
            if (c.anim) {
                node.className = node.className.replace(/\s*anim-\w+/g, "");
                void node.offsetWidth; // 重启动画
                node.classList.add("anim-" + c.anim);
            }
            node.src = src;
        }
        if (state.charsOnStage[id]) state.charsOnStage[id].src = src || "";
    }

    function displayName(charId) {
        const profile = (state.chars || {})[charId] || {};
        if (state.names[charId] != null) return state.names[charId];
        if (profile.name != null) return profile.name;     // 允许空字符串（无名旁白）
        if (profile.initialName != null) return profile.initialName;
        return charId;
    }

    function setTextbox(name, text, customBox, nameColor, instant) {
        const root = stageRoot();
        const box = root && root.querySelector(".textbox");
        if (!box) return;
        box.classList.add("is-active"); // 有台词才显示对话框
        // 角色专属对话框图片（可选；不填则回落到 CSS 的 --gui-textbox）
        // customBox 是 characters.json 里的原始相对路径，与 preload.js 的 collectCharTextboxes
        // 收集到的字符串完全相同——内联样式和 new Image() 都以 document.baseURI 解析，
        // 因此命中同一缓存项。改这里时务必保持该约定，否则预载会落空。
        if (customBox) {
            box.classList.add("textbox--image");
            box.style.backgroundImage = `url("${customBox}")`;
        } else {
            box.classList.remove("textbox--image");
            box.style.backgroundImage = "";
        }
        const nameEl = box.querySelector(".textbox__name");
        const textEl = box.querySelector(".textbox__text");
        if (nameEl) {
            nameEl.textContent = name || "";
            nameEl.style.display = name ? "" : "none";
            nameEl.style.color = nameColor || "";
        }
        if (textEl) {
            if (instant) {
                // 回溯/重建场景：直接整行显示，不启动打字机（避免 state.typing 残留导致二次回滚被 finishTyping 拦截）
                clearInterval(state.typing);
                if (state.typePauseTimer) { clearTimeout(state.typePauseTimer); state.typePauseTimer = null; }
                state.typing = null;
                state.awaitClick = false;
                state.typePrefix = "";
                textEl.textContent = text;
                textEl.dataset.full = text;
                state.waiting = true;
            } else {
                runTyper(textEl, text, "");
            }
        } else {
            state.waiting = true;
        }
    }

    function hideTextbox() {
        const box = stageRoot() && stageRoot().querySelector(".textbox");
        if (box) box.classList.remove("is-active");
    }

    /* ---------- 打字机（支持行内 {w}/{w=N} 停顿 + append 追加） ---------- */
    const WAIT_RE = /\{w(?:=([\d.]+))?\}/g;
    // 把文本按 {w}/{w=N} 切成带等待的分段：wait 为 "click"(等点击) / 数字(秒) / null(末段)
    function parseWait(text) {
        const parts = [];
        let last = 0, m;
        WAIT_RE.lastIndex = 0;
        while ((m = WAIT_RE.exec(text)) !== null) {
            if (m.index > last) parts.push({ text: text.slice(last, m.index), wait: m[1] != null ? parseFloat(m[1]) : "click" });
            last = WAIT_RE.lastIndex;
        }
        if (last < text.length) parts.push({ text: text.slice(last), wait: null });
        if (parts.length === 0) parts.push({ text: "", wait: null });
        return parts;
    }
    // node: 文本节点；text: 要打出的文本（可含 {w}）；prefix: 已显示在屏上、须保留的前置文本（append 用）
    function runTyper(node, text, prefix) {
        clearInterval(state.typing);
        if (state.typePauseTimer) { clearTimeout(state.typePauseTimer); state.typePauseTimer = null; }
        state.awaitClick = false;
        node.textContent = prefix || "";
        state.typePrefix = prefix || "";
        state.typeParts = parseWait(text);
        state.typeSi = 0;
        state.typeCi = 0;
        node.dataset.full = (prefix || "") + text.replace(WAIT_RE, "");
        typeSeg(node);
    }
    function typeSeg(node) {
        if (state.typeSi >= state.typeParts.length) { state.typing = null; return; }
        const seg = state.typeParts[state.typeSi];
        state.typing = setInterval(() => {
            state.typeCi++;
            const shown = state.typePrefix
                + state.typeParts.slice(0, state.typeSi).map(p => p.text).join("")
                + seg.text.slice(0, state.typeCi);
            node.textContent = shown;
            if (state.typeCi >= seg.text.length) {
                clearInterval(state.typing);
                state.typing = null;
                onSegDone(node, seg);
            }
        }, TYPE_SPEED);
    }
    function onSegDone(node, seg) {
        if (seg.wait === "click") { state.awaitClick = true; return; }      // 等点击续打下一截
        if (typeof seg.wait === "number") {                                  // 计时后自动续打
            state.typePauseTimer = setTimeout(() => {
                state.typePauseTimer = null;
                state.typeSi++; state.typeCi = 0;
                typeSeg(node);
            }, seg.wait * 1000);
            return;
        }
        // wait:null → 末段结束，进入整行点击等待（由 setTextbox/append 已置 waiting=true）
    }
    function finishTyping() {
        const textEl = stageRoot() && stageRoot().querySelector(".textbox .textbox__text");
        if ((state.typing || state.awaitClick || state.typePauseTimer) && textEl && textEl.dataset.full != null) {
            clearInterval(state.typing);
            state.typing = null;
            if (state.typePauseTimer) { clearTimeout(state.typePauseTimer); state.typePauseTimer = null; }
            state.awaitClick = false;
            textEl.textContent = textEl.dataset.full;
            return true;
        }
        return false;
    }

    /* ---------- NVL 整屏旁白 ---------- */
    function showNvl(on) {
        const panel = stageRoot() && stageRoot().querySelector(".stage-nvl");
        if (panel) panel.classList.toggle("is-active", !!on);
        // NVL 整屏旁白期间隐藏 ADV 对话框（避免空白框叠在 NVL 上）
        if (on) {
            const box = stageRoot() && stageRoot().querySelector(".textbox");
            if (box) box.classList.remove("is-active");
        }
    }
    function renderNvl() {
        const panel = stageRoot() && stageRoot().querySelector(".stage-nvl");
        if (!panel) return;
        clearNode(panel);
        state.nvlLines.forEach(line => panel.appendChild(el("div", "stage-nvl__line", line)));
        panel.scrollTop = panel.scrollHeight;
    }

    function showTitleCard(text) {
        const card = stageRoot().querySelector(".stage-title-card");
        if (!card) return;
        card.querySelector(".stage-title-card__text").textContent = text || "";
        card.classList.add("is-active");
        state.waiting = true;
        setTimeout(() => {
            if (!card.classList.contains("is-active")) return; // 用户已点击跳过
            card.classList.remove("is-active");
            state.waiting = false;
            advanceTimed();
        }, TITLE_CARD_MS);
    }

    function showDecide(c) {
        const root = stageRoot();
        const choices = root.querySelector(".choices");
        const box = root.querySelector(".textbox");
        clearNode(choices);
        showNvl(false);
        // 提示语显示到对话框（不入历史）
        if (box) {
            const nameEl = box.querySelector(".textbox__name");
            nameEl.style.display = "none";
            box.classList.remove("textbox--image");
            box.style.backgroundImage = "";
            const textEl = box.querySelector(".textbox__text");
            clearInterval(state.typing);
            textEl.textContent = resolveText(c.prompt || "");
            box.classList.add("is-active"); // 选项提示语需要显示对话框
        }
        (c.options || []).forEach(opt => {
            const btn = el("button", "choice paper", opt.text);
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                pickChoice(opt);
            });
            choices.appendChild(btn);
        });
        state.deciding = true;
        state.waiting = true;
    }

    function pickChoice(opt) {
        // 选项记录到全局变量（record 写 opt.value 或 opt.text；set 批量写变量）
        if (opt.record) state.vars[opt.record] = (opt.value !== undefined ? opt.value : opt.text);
        if (opt.set) (Array.isArray(opt.set) ? opt.set : [opt.set]).forEach(applySetSpec);
        const root = stageRoot();
        clearNode(root.querySelector(".choices"));
        state.deciding = false;
        state.waiting = false;
        jumpTo(opt.goto);
    }

    /* ---------- 快照（后退一句） ---------- */
    function snapshot(lineCmd) {
        state.snaps.push({
            seg: state.seg,
            idx: state.idx,
            line: lineCmd,
            bg: state.bg,
            music: state.music ? Object.assign({}, state.music) : null,
            chars: JSON.parse(JSON.stringify(state.charsOnStage)),
            names: JSON.parse(JSON.stringify(state.names)),
            nvlLines: state.nvlLines.slice(),
            vars: JSON.parse(JSON.stringify(state.vars)),
            // 存完整 history 副本：append 多段共享同一条 history 条目，
            // 仅靠 historyLen 无法区分各快照对应的合并文本，整体复制最稳妥。
            history: state.history.map(h => ({ name: h.name, text: h.text }))
        });
    }

    function applySnap(s) {
        // 场景
        setBg(s.bg);
        if (s.music) {
            musicCmd({ src: s.music.src, volume: s.music.volume, loop: s.music.loop });
        }
        // 立绘（用快照里解析好的 src 重建，与角色档案解耦）
        const root = stageRoot();
        root.querySelectorAll(".stage-char").forEach(n => n.remove());
        if (state.hideTimers) { for (const k in state.hideTimers) clearTimeout(state.hideTimers[k]); }
        state.nodeMap = {};
        state.hidingNodes = {};
        state.hideTimers = {};
        state.charsOnStage = JSON.parse(JSON.stringify(s.chars));
        for (const id in s.chars) {
            const src = s.chars[id].src;
            const node = document.createElement("img");
            node.className = "stage-char at-" + (s.chars[id].at || "center");
            node.setAttribute("data-char", id);
            node.draggable = false;
            if (src) node.src = src;
            root.querySelector(".stage-chars").appendChild(node);
            state.nodeMap[id] = node;
        }
        // NVL
        state.nvlLines = s.nvlLines ? s.nvlLines.slice() : [];
        renderNvl();
        showNvl(state.nvlLines.length > 0);
        // 名字、变量与历史
        state.names = JSON.parse(JSON.stringify(s.names));
        state.vars = JSON.parse(JSON.stringify(s.vars || {}));
        state.history = (s.history || []).map(h => ({ name: h.name, text: h.text }));
        renderHistory();
        // 台词（回溯重建：整行直接显示，不重新打字）
        const line = s.line;
        if (line) {
            if (line.cmd === "decide") {
                showDecide(line);
            } else if (line.cmd === "narrate") {
                setTextbox("", line._resolved || line._merged || line.text, null, "", true);
            } else if (line.cmd === "say") {
                const profile = (state.chars || {})[line.char] || {};
                setTextbox(line.as || displayName(line.char), line._resolved || line._merged || line.text,
                           profile.textbox || null, profile.color || null, true);
                if (line.voice && !skipVoiceNow()) playVoice(line.voice, line.voiceVolume); // 回溯时重播绑定语音
            }
        }
    }

    function rollback() {
        if (!state.playing) return;
        if (finishTyping()) return; // 打字中先补全
        if (state.deciding) { /* 选项界面后退：回到判定前一句 */ }
        if (state.snaps.length < 2) return;
        state.snaps.pop();
        applySnap(state.snaps[state.snaps.length - 1]);
        const s = state.snaps[state.snaps.length - 1];
        state.seg = s.seg;
        state.idx = s.idx + 1;
        state.waiting = true;
    }

    /* ---------- 存档 / 读档（localStorage） ---------- */
    // 存档槽分三类：auto（自动存档）/ quick（快速存档）/ manual（手动存档）。
    // 三者 localStorage 键名互不冲突，手动存档无法覆盖系统槽。
    const SAVE_PREFIX = "aliceADV.save.";
    function saveKey(kind, n) {
        if (kind === "auto") return "aliceADV.auto";
        if (kind === "quick") return "aliceADV.quick";
        return SAVE_PREFIX + n;
    }
    function readSave(kind, n) {
        try { const raw = localStorage.getItem(saveKey(kind, n)); return raw ? JSON.parse(raw) : null; }
        catch (e) { return null; }
    }
    function writeSave(kind, n, obj) {
        try { localStorage.setItem(saveKey(kind, n), JSON.stringify(obj)); return true; }
        catch (e) { console.warn("[aliceADV] 保存失败（localStorage 不可用或配额已满）", e); return false; }
    }
    // 自动存档 / 快速存档开关取自 info.json（构建时合并进 window.__THEME__.info）。
    // 缺省视为开启；关闭后对应系统槽从界面消失、对应动作失效（见 load / 槽位渲染）。
    function cfgBool(name, def) {
        const info = (global.__THEME__ && global.__THEME__.info) || {};
        const v = info[name];
        return (v === undefined || v === null) ? def : !!v;
    }
    function autoSaveEnabled()  { return cfgBool("autoSave", true); }
    function quickSaveEnabled() { return cfgBool("quickSave", true); }
    function pad2(n) { return String(n).padStart(2, "0"); }
    function fmtTime(d) {
        return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    }
    // 由快照推导存档槽展示信息：缩略图=背景；内容=说话角色+当前台词；旁白/选项特殊处理
    function buildDisplay(snap) {
        const line = snap && snap.line;
        let label = "旁白", text = "";
        if (line) {
            if (line.cmd === "decide") { label = "选择"; text = resolveText(line.prompt || ""); }
            else if (line.cmd === "narrate") { label = "旁白"; text = line._resolved || line._merged || line.text || ""; }
            else if (line.cmd === "say") {
                const nm = line.as || displayName(line.char);
                label = nm || "旁白";
                text = line._resolved || line._merged || line.text || "";
            }
        }
        return { label: label, text: text, thumb: (snap && snap.bg) || "" };
    }
    // 取最近一条快照（即当前停在屏幕上的那句）
    function lastSnap() { return state.snaps.length ? state.snaps[state.snaps.length - 1] : null; }

    // 由快照构建存档对象（三类槽共用，存全量运行时状态以便精确还原）
    function buildSaveObject(snap) {
        const now = new Date();
        const disp = buildDisplay(snap);
        return {
            version: 1,
            scriptPath: (state.script && state.script.__path) || "",
            time: now.getTime(),
            timeStr: fmtTime(now),
            seg: snap.seg,
            idx: snap.idx,
            vars: JSON.parse(JSON.stringify(state.vars)),
            names: JSON.parse(JSON.stringify(state.names)),
            bg: state.bg,
            chars: JSON.parse(JSON.stringify(state.charsOnStage)),
            nvlLines: state.nvlLines.slice(),
            history: state.history.map(h => ({ name: h.name, text: h.text })),
            music: state.music ? Object.assign({}, state.music) : null,
            snap: JSON.parse(JSON.stringify(snap)),
            display: { label: disp.label, text: disp.text, thumb: disp.thumb }
        };
    }

    // 自动存档：每前进一步由 advance() 调用，记录当前位置供首页「继续」使用。
    // 自动存档关闭时不写入（旧档由 load 端拦截，界面也不再展示）。
    function saveAuto() {
        if (!state.playing || !autoSaveEnabled()) return false;
        const snap = lastSnap();
        if (!snap) return false;
        return writeSave("auto", 0, buildSaveObject(snap));
    }
    // 快速存档：菜单「快存」使用（slot 0 / quick）。
    function saveQuick() {
        if (!state.playing || !quickSaveEnabled()) return false;
        const snap = lastSnap();
        if (!snap) return false;
        return writeSave("quick", 0, buildSaveObject(snap));
    }
    // 手动存档：写入第 n 个普通槽（n>=1），不被系统槽占用。
    function saveManual(n) {
        if (!state.playing) return false;
        if (!(n >= 1)) return false;
        const snap = lastSnap();
        if (!snap) return false;
        return writeSave("manual", n, buildSaveObject(snap));
    }
    // 读取指定槽位存档对象（供 UI 渲染；null = 空槽）
    function getSave(kind, n) { return readSave(kind, n); }
    // 读档：恢复进度并回到舞台继续游玩
    async function load(kind, n) {
        // 关闭的系统槽不可读：自动存档关闭则「继续」失效，快速存档关闭则「快读」失效
        if (kind === "auto"  && !autoSaveEnabled())  return false;
        if (kind === "quick" && !quickSaveEnabled()) return false;
        const data = readSave(kind, n);
        if (!data) return false;
        // 确保剧本已加载（从标题直接进入读档时可能尚未 start）
        if (!state.script || (state.script.__path && state.script.__path !== data.scriptPath)) {
            try { state.chars = await fetchJSON(CHAR_PATH); } catch (e) { state.chars = {}; }
            state.script = await fetchJSON(data.scriptPath);
            normalizeScript(state.script);
            state.script.__path = data.scriptPath;
            state.initVars = state.script.varsInit || {};
        }
        // 停止当前演出并把舞台复位到空白（同 start：进入播放前兜一次，
        // 读档时舞台上一律先空——否则当前进度里的立绘会与存档快照的立绘叠在一起）
        stopPlayback();
        resetStage();
        if (audio) { audio.pause(); try { audio.currentTime = 0; } catch (e) {} }
        if (sfx) { sfx.pause(); }
        state.playing = true;
        // 恢复运行时状态
        state.vars = JSON.parse(JSON.stringify(data.vars || {}));
        state.names = JSON.parse(JSON.stringify(data.names || {}));
        state.bg = data.bg;
        state.charsOnStage = JSON.parse(JSON.stringify(data.chars || {}));
        state.nvlLines = data.nvlLines ? data.nvlLines.slice() : [];
        state.history = (data.history || []).map(h => ({ name: h.name, text: h.text }));
        state.music = null; // 让 applySnap 重新启动背景音乐
        const snap = data.snap;
        if (snap) {
            state.seg = snap.seg;
            state.idx = snap.idx + 1;
            state.snaps = [ JSON.parse(JSON.stringify(snap)) ];
            applySnap(snap);
            renderHistory();
        }
        // 进入舞台前先按策略预载开场视野（含跨段/分支），避免首屏资源未就绪而闪烁
        if (global.AliceADVPreload) await global.AliceADVPreload.enterStage(state.script, state.seg, state.idx);
        state.waiting = true;
        if (global.AliceADVEngine) global.AliceADVEngine.showPage("page_stage");
        return true;
    }
    // 便捷封装：首页「继续」/ 菜单「快读」直接调用
    function loadAuto()  { return load("auto", 0); }
    function loadQuick() { return load("quick", 0); }

    /* ---------- 运行循环 ---------- */
    function jumpTo(segment) {
        if (!state.script.segments[segment]) {
            console.warn("[aliceADV] 段不存在:", segment);
            return;
        }
        state.seg = segment;
        state.idx = 0;
        advance();
    }

    /* 推进主循环。
     *
     * 变异步只为了一个目的：**资源兜底**。在 exec(c) 之前若发现这条指令要用的图片还没就绪、
     * 且作者的 fallback 策略是 "block"，就要显示 #wait-mask 等它（见 AliceADVPreload.barrier）。
     * 其余部分与同步版本完全一致：await 只在「确实要等」时才产生。
     *
     * 两个守卫：
     *   state.barrier —— 等待期间玩家的点击由 next() 直接丢弃，不重入主循环。
     *   state.epoch   —— 等待可能跨过「退出一局 → 进入下一局」，醒来后必须确认这条推进
     *                    仍属于当前这一局，否则会拿旧剧本的段名去跑新一局。
     */
    async function advance() {
        if (!state.playing) return;
        const epoch = state.epoch;
        state.step++;             // 推进计数。转场用它判断「解码期间这一步有没有被别处推过」
                                  //（见 setBg）——只声明不递增会让那个判断永远是假，成为死代码
        state.waiting = false;
        hideTextbox(); // 推进即收起对话框，待 say/narrate 重新点亮
        // 若章节标题卡仍在展示（用户点击推进），先收起
        const card = stageRoot() && stageRoot().querySelector(".stage-title-card");
        if (card) card.classList.remove("is-active");
        // 实测玩家翻页节奏：与上一次「进入玩家等待」的间隔。定时自动推进已把起点清零
        //（见 advanceTimed），因此这里采到的才是玩家自己的速度。样本交给预加载器做 EWMA。
        if (lineClock && !state.auto && !state.skip && global.AliceADVPreload) {
            global.AliceADVPreload.reportDwell((Date.now() - lineClock) / 1000);
        }
        lineClock = 0;
        // 运行时调度：按「秒」为单位向前推算，产出按 slack 升序的待发列表
        // （info.json preload.runtime 含 "predict" 时生效）
        if (global.AliceADVPreload) global.AliceADVPreload.hookPredict(state.script, state.seg, state.idx);
        const segs = state.script.segments;
        let guard = 0;
        while (guard++ < 10000) {
            const list = segs[state.seg];
            if (!list || state.idx >= list.length) { doEnd({}); return; }
            const c = list[state.idx];
            // 兜底拦停：block 的资源未就绪就等，degrade / missing 不等（barrier 返回 null）
            const pending = global.AliceADVPreload ? global.AliceADVPreload.barrier(c) : null;
            if (pending) {
                state.barrier = true;
                try { await pending; } finally { state.barrier = false; }
                if (!state.playing || state.epoch !== epoch) return; // 等待期间退出了播放
            }
            const blocking = exec(c);
            state.idx++;
            if (blocking) { state.waiting = true; saveAuto(); lineClock = Date.now(); return; }
        }
    }

    // 定时等待：阻塞 ms 毫秒后自动继续；期间点击可跳过（见 next）。
    function beginTimedWait(ms) {
        state.waiting = true;
        state.waitTimer = setTimeout(() => {
            state.waitTimer = null;
            state.waiting = false;
            advanceTimed();
        }, ms);
        return true;
    }

    function exec(c) {
        // 单指令执行条件：不满足则跳过本条（不执行、不阻塞，继续推进）
        if (c.if != null) {
            if (!condTest({ test: c.if })) return false;
        }
        switch (c.cmd) {
            case "bg":
            case "scene":          // scene 为规范名，bg 保留作兼容别名（二者等价）
                return setBg(c.src, c.transition); // 带 fade 时阻塞到转场结束
            case "music":
                musicCmd(c);
                return false;
            case "sound":
                soundCmd(c);
                return false;
            case "voice":          // 独立语音指令（一次性，无台词时也可用）
                // 快进时语音通常听不完，把它移出播放与预载可以给图片让出带宽（见 info.preload.fastForward）
                if (!skipVoiceNow()) playVoice(c.src, c.volume);
                return false;
            case "stop":
                stopCmd(c);
                return false;
            case "show":
                showChar(c);
                return false;
            case "hide":
                hideChar(c);
                return false;
            case "sprite":
                setSprite(c);
                return false;
            case "rename":
                state.names[c.char] = c.to;
                return false;
            case "set":             // 写变量（非阻塞）：{ var, op?, value? }
                applySetSpec(c);
                return false;
            case "if": {            // 条件跳转（非阻塞）：命中 goto / 未命中 else / 皆空则继续当前段
                const target = condTest(c) ? c.goto : c.else;
                if (target) { state.seg = target; state.idx = -1; } // 由外层 advance 循环接管
                return false;
            }
            case "goto":
                state.seg = c.segment;
                state.idx = -1; // advance 里会 ++
                return false;
            case "wait": {         // 演出等待：定时自动继续（点击可跳过）；未给时长按 800ms
                const ms = c.ms != null ? c.ms : (c.seconds != null ? c.seconds * 1000 : 800);
                return beginTimedWait(ms);
            }
            case "pause": {        // 纯停顿：不显示对话框、不写历史、不占用资源
                // 无参 = 等玩家点击（让背景/图片单独亮相一拍的节拍指令）；
                // 带 ms / seconds = 定时自动继续，期间点击可跳过。
                if (c.ms == null && c.seconds == null) { state.waiting = true; return true; }
                return beginTimedWait(c.ms != null ? c.ms : c.seconds * 1000);
            }
            case "title":
                showTitleCard(c.text);
                return true;
            case "narrate": {
                if (c.mode === "nvl") {
                    const rtext = resolveText(c.text);
                    state.nvlLines.push(rtext);
                    showNvl(true);
                    renderNvl();
                    state.history.push({ name: "", text: rtext });
                    renderHistory();
                    c._resolved = rtext;
                    snapshot(c);
                    return true;
                }
                // ADV 旁白：退出 NVL 整屏
                showNvl(false);
                const rtext2 = resolveText(c.text);
                state.history.push({ name: "", text: rtext2 });
                renderHistory();
                setTextbox("", rtext2, null, "");
                c._resolved = rtext2;
                snapshot(c);
                return true;
            }
            case "nvlclear":
                state.nvlLines = [];
                renderNvl();
                return false;
            case "say": {
                const profile = (state.chars || {})[c.char] || {};
                if (c.sprite) setSprite({ char: c.char, sprite: c.sprite });
                showNvl(false); // 说话即回到 ADV 文本框，隐藏 NVL 整屏
                const name = c.as || displayName(c.char);
                const color = profile.color || null;
                const box = stageRoot() && stageRoot().querySelector(".textbox");
                if (c.append) {
                    // 追加续说：不清空对话框，拼接新文本；段间可插任意指令（换表情/背景/音效）
                    const textEl = box && box.querySelector(".textbox__text");
                    const prev = (textEl && (textEl.dataset.full || textEl.textContent)) ? (textEl.dataset.full || textEl.textContent) : "";
                    const sep = (prev && !/[\n　\s]$/.test(prev)) ? " " : "";
                    const prefix = prev + sep;   // 已显示文本 + 分隔符，作为打字前缀
                    const merged = prefix + resolveText(c.text);
                    if (box) box.classList.add("is-active");
                    if (textEl) {
                        if (c.voice && !skipVoiceNow()) playVoice(c.voice, c.voiceVolume);
                        runTyper(textEl, c.text, prefix); // 只打新文本，保留 prefix
                    }
                    // 历史合并到上一条（Ren'Py extend 行为：同一句台词）
                    if (state.history.length) {
                        state.history[state.history.length - 1].text = merged;
                    }
                    c._merged = merged; // 供回溯重建整行
                    if (c.pause != null) {
                        // 自动续：pause 秒后自动进下一句（点击可跳过）
                        const ms = (typeof c.pause === "number" ? c.pause * 1000 : 800);
                        state.waiting = true;
                        state.waitTimer = setTimeout(() => {
                            state.waitTimer = null;
                            state.waiting = false;
                            advanceTimed();
                        }, ms);
                    } else {
                        state.waiting = true; // 默认等同普通句：等玩家点击
                    }
                    snapshot(c);
                    return true;
                }
                // 普通 say（文本内 {if} 条件在渲染时解析）
                if (box) box.classList.add("is-active");
                const rtext = resolveText(c.text);
                state.history.push({ name, text: rtext });
                renderHistory();
                setTextbox(name, rtext, profile.textbox || null, color);
                if (c.voice && !skipVoiceNow()) playVoice(c.voice, c.voiceVolume); // 台词绑定语音（一次性）
                c._resolved = rtext; // 供回溯重建整行
                snapshot(c);
                return true;
            }
            case "decide":
                showDecide(c);
                snapshot(c);
                return true;
            case "end":
                doEnd(c);
                return true;
            default:
                console.warn("[aliceADV] 未知指令:", c);
                return false;
        }
    }

    function doEnd(c) {
        const action = c.action || "title";
        exit();
        if (global.AliceADVEngine) {
            global.AliceADVEngine.showPage(action === "chapters" ? "page_chapters" : "page_title");
        }
    }

    /* ---------- 用户推进 ---------- */
    function next() {
        if (!state.playing) return;
        if (state.barrier) return;  // 资源兜底等待中（#wait-mask 已显示）：只能等它自己结束
        if (state.deciding) return; // 判定中：只能点选项
        // 背景转场中点击：立即结束转场（换图 + 揭幕）并推进一句，不必等帷幕落满。
        // 但**新图还在解码**（pending）时点击必须被吸收：这一刻没有图可换，
        // 放行推进只会把这次换图作废（bgSeq 变化）、把幕布留在满幕上 —— 即背景全黑。
        if (bgFade) {
            if (bgFade.pending) return;
            settleBgFade(bgFade.seq);
            return;
        }
        // 句中 {w} 等待点击：点击=续打下一截（不整行跳过、不推进下一句）
        if (state.awaitClick) {
            state.awaitClick = false;
            state.typeSi++; state.typeCi = 0;
            typeSeg(stageRoot().querySelector(".textbox .textbox__text"));
            return;
        }
        // 句中 {w=N} 计时等待中点点击：跳过等待、续打下一截
        if (state.typePauseTimer) {
            clearTimeout(state.typePauseTimer); state.typePauseTimer = null;
            state.typeSi++; state.typeCi = 0;
            typeSeg(stageRoot().querySelector(".textbox .textbox__text"));
            return;
        }
        // 打字中点击：补全整行并继续推进（同一次点击既打完字又前进）
        if (state.typing) finishTyping();
        if (state.waitTimer) {      // 定时等待中：点击可跳过
            clearTimeout(state.waitTimer);
            state.waitTimer = null;
            state.waiting = false;
            advanceTimed();
            return;
        }
        if (!state.waiting) return;
        state.waiting = false;
        advance();
    }

    /* ---------- 历史 ---------- */
    function renderHistory() {
        const list = document.querySelector("#overlay_history .history-list");
        if (!list) return;
        clearNode(list);
        state.history.forEach(h => {
            const item = el("div", "history-item");
            if (h.name) item.appendChild(el("div", "history-item__name", h.name));
            item.appendChild(el("div", "history-item__text", h.text));
            list.appendChild(item);
        });
        list.scrollTop = list.scrollHeight;
    }

    /* ---------- 两层次脚本归一化（Chapter 宏观 / Segment 单元） ----------
     * 除了把段名扁平化成全局唯一映射，还要留下「段属于哪一章」（__segChapter）：
     * 预加载的搜索上界以章为准（不跨章），而章的边界只能靠这张反查表判断。
     * 玩家可以从章内任意位置读档进入，因此这张表是「范围」的依据，不是「加载过没有」的依据。 */
    function normalizeScript(script) {
        if (!script) return;
        // chapters: { 章名: { start?, title?, segments:{ 段名:[指令...] } } }
        // → 扁平化为全局唯一段名映射 state.script.segments；chapters 仅作宏观元数据。
        if (script.chapters) {
            const flat = {};
            const chaptersMeta = [];
            const segChapter = {};
            let firstStart = null;
            for (const chName in script.chapters) {
                const ch = script.chapters[chName] || {};
                const segStart = ch.start || (ch.segments ? Object.keys(ch.segments)[0] : null);
                if (segStart && !firstStart) firstStart = segStart;
                const segNames = Object.keys(ch.segments || {});
                chaptersMeta.push({ name: chName, title: ch.title || chName, start: segStart, segments: segNames });
                for (const segName of segNames) {
                    flat[segName] = ch.segments[segName];
                    segChapter[segName] = chName;
                }
            }
            if (script.segments) Object.assign(flat, script.segments); // 顶层 segments 一并并入
            script.segments = flat;
            script.chaptersMeta = chaptersMeta;
            script.__segChapter = segChapter;
            if (!script.start) script.start = firstStart || (script.segments ? Object.keys(script.segments)[0] : null);
        } else {
            // 一章一个剧本文件：整个文件就是一章，不存在边界，规划可以走到底
            script.chaptersMeta = null;
            script.__segChapter = null;
        }
        // 变量初始值（游玩期全局；start/exit 重置）
        script.varsInit = script.vars ? JSON.parse(JSON.stringify(script.vars)) : {};
    }

    /* ---------- 舞台复位 ----------
     * 把「上一局留在舞台上的痕迹」一次抹干净：立绘/整屏图（含在途的淡出节点）、
     * 背景（含 setBg 垫在下层的「上一张图」）、幕布、章节标题卡、NVL、选项、对话框。
     *
     * 为什么抽成一个函数、并且「离开舞台」与「进入舞台」两头都调用：
     *   舞台元素的生命周期跨越「播放中」与「已退出播放」两种状态。若只在 exit() 里清，
     *   任何一条没走到 exit() 的路径（读档直接进舞台、将来新增的入口、以及
     *   「已经退出播放、但画面上还留着东西」的中间态）都会让上一次的画面原样留在 stage 上，
     *   重新开始时立绘/背景就停在退出时的位置。复位做成幂等操作、进入播放前再兜一次，
     *   就不再依赖「调用方记得清」——等价于 Ren'Py 里「回主菜单再开始必然是一场干净的戏」。
     */
    function resetStage() {
        const root = stageRoot();
        if (!root) return;
        // 1. 立绘 / 整屏图：DOM 与索引一起清。「已 hide、等下一帧才移除」的在途节点也要清，
        //    并撤销它的定时器——否则它会在下一帧冒出来，或永远留在画面上。
        root.querySelectorAll(".stage-char").forEach(n => n.remove());
        ensureHideMaps();
        for (const k in state.hideTimers) clearTimeout(state.hideTimers[k]);
        state.nodeMap = {};
        state.hidingNodes = {};
        state.hideTimers = {};
        state.charsOnStage = {};
        // 2. 选项：不清会留在舞台上，而且仍然可点（点到就跳分支）
        const choices = root.querySelector(".choices");
        if (choices) { clearNode(choices); choices.classList.remove("is-active"); }
        // 3. 章节标题卡
        const card = root.querySelector(".stage-title-card");
        if (card) card.classList.remove("is-active");
        // 4. NVL 整屏旁白
        const nvl = root.querySelector(".stage-nvl");
        if (nvl) { nvl.classList.remove("is-active"); clearNode(nvl); }
        state.nvlLines = [];
        // 5. 对话框：文本、名字、角色专属图框与配色全部还原成「还没说话」的初始态。
        //    dataset.full 存着整行全文（append 续说靠它拼前缀），不清的话下一局第一句
        //    append 会把上一局的最后一句当成本句前缀拼上去。
        hideTextbox();
        const box = root.querySelector(".textbox");
        if (box) {
            box.classList.remove("textbox--image");
            box.style.backgroundImage = "";
            box.style.visibility = "";
            const nEl = box.querySelector(".textbox__name");
            const tEl = box.querySelector(".textbox__text");
            if (nEl) { nEl.style.display = "none"; nEl.textContent = ""; nEl.style.color = ""; }
            if (tEl) { tEl.textContent = ""; tEl.dataset.full = ""; }
        }
        // 6. 背景：setBg 为了「解码新图时不露兜底色」会把上一张垫在下层
        //    （backgroundImage = "url(新图), url(旧图)"）。只换上第一层、不连第二层一起清的话，
        //    这张旧图会一路活到下一局，重新开始时先露出来的就是它——「退出时那个位置的东西还在」。
        //    复位到主题兜底背景（theme.js 写在 data-fallback-bg），而不是清空露出 CSS 渐变。
        const bg = root.querySelector(".stage-bg");
        if (bg) {
            bg.style.backgroundImage = bg.dataset.fallbackBg || "";
            bg.style.backgroundSize = "";
            bg.style.backgroundPosition = "";
            bg.style.backgroundRepeat = "";
            bg.style.opacity = "";
        }
        state.bg = null;
        // 7. 幕布与在途转场：令牌 +1 让所有没跑完的 fade 回调作废，它们不得再改动画。
        const veil = veilEl();
        if (veil) veil.classList.remove("is-on");
        if (bgFade) { clearTimeout(bgFade.timer); bgFade = null; }
        bgSeq++;
    }

    /* ---------- 生命周期 ---------- */
    async function start(scriptPath) {
        // 进入播放前先把上一局的痕迹清干净（幂等）：不依赖「退出时一定走过 exit」。
        // 放在最前面，是为了在任何 await 之前就把画面复位，中途失败也不会留下半场演出。
        stopPlayback();
        resetStage();
        if (!state.chars) {
            try { state.chars = await fetchJSON(CHAR_PATH); }
            catch (e) { console.warn("[aliceADV] 角色档案加载失败", e); state.chars = {}; }
        }
        state.script = await fetchJSON(scriptPath);
        normalizeScript(state.script);
        state.script.__path = scriptPath;
        state.chapters = state.script.chaptersMeta || null;
        state.initVars = state.script.varsInit || {};
        state.vars = JSON.parse(JSON.stringify(state.initVars));
        // 重置
        state.names = {};
        for (const id in state.chars) {
            const p = state.chars[id];
            state.names[id] = p.initialName != null ? p.initialName : (p.name != null ? p.name : id);
        }
        state.seg = state.script.start || Object.keys(state.script.segments)[0];
        state.idx = 0;
        state.charsOnStage = {};
        state.nodeMap = {};
        state.bg = null;
        state.nvlLines = [];
        state.history = [];
        state.snaps = [];
        state.typing = state.typePauseTimer = null;
        state.awaitClick = false;
        state.typeParts = null; state.typeSi = 0; state.typeCi = 0; state.typePrefix = "";
        state.playing = true;
        state.waiting = false;
        state.deciding = false;
        state.step = 0;
        renderHistory();
        renderNvl();
        // 进舞台前先按策略预载开场视野（显示转圈圈，避免首屏资源未就绪而闪烁）；predict 关闭则跳过
        if (global.AliceADVPreload) await global.AliceADVPreload.enterStage(state.script, state.seg, state.idx);
        if (global.AliceADVEngine) global.AliceADVEngine.showPage("page_stage");
        advance();
    }

    /* ---------- 演出停机 ----------
     * 停掉「正在跑」的一切：打字机、句中/定时等待、自动与快进。
     * exit（离开舞台）与 start / load（进入舞台）共用同一个停机动作——
     * 上一局的定时器不能跟着走到下一局（否则新一局会被上局的 auto/skip 继续推着跑）。
     */
    function stopPlayback() {
        clearInterval(state.typing);
        clearInterval(state.autoTimer);
        clearInterval(state.skipTimer);
        if (state.typePauseTimer) { clearTimeout(state.typePauseTimer); state.typePauseTimer = null; }
        if (state.waitTimer) { clearTimeout(state.waitTimer); state.waitTimer = null; }
        state.typing = state.autoTimer = state.skipTimer = state.typePauseTimer = null;
        state.awaitClick = false;
        state.typeParts = null; state.typeSi = 0; state.typeCi = 0; state.typePrefix = "";
        state.auto = false;
        state.skip = false;
        state.waiting = false;
        state.deciding = false;
        state.barrier = false;   // 上一局的兜底等待不能跟着走到下一局（在途的 await 由 epoch 拦下）
        state.epoch++;           // 作废所有在途的 advance() 续跑
        lineClock = 0;
        syncPlaybackMode();
    }

    function exit() {
        state.playing = false;
        stopPlayback();
        hideTextbox(); // 退出播放时收起对话框
        // 清空历史与变量（退出播放即清除；变量为游玩期有效）
        state.history = [];
        state.vars = {};
        renderHistory();
        // 停止音乐 / 音效
        if (audio) { audio.pause(); try { audio.currentTime = 0; } catch (e) {} }
        if (sfx) { sfx.pause(); try { sfx.currentTime = 0; } catch (e) {} }
        state.music = null;
        // 清舞台：复位成「还没开始这一局」的样子（见 resetStage）
        resetStage();
        state.script = null;
        state.snaps = [];
    }

    /* ---------- 自动 / 快进 ----------
     * 两者的周期（2600ms / 180ms）必须与模板 info.json 的 lookahead.autoLineSeconds /
     * skipLineSeconds 保持一致：预加载器用它们把「时间窗口」换算成指令条数。 */
    function setAuto(on) {
        state.auto = on;
        clearInterval(state.autoTimer);
        if (on) state.autoTimer = setInterval(() => {
            if (state.playing && state.waiting && !state.deciding) next();
        }, 2600);
        syncPlaybackMode();
        return state.auto;
    }
    function setSkip(on) {
        state.skip = on;
        clearInterval(state.skipTimer);
        if (on) state.skipTimer = setInterval(() => {
            if (state.playing && state.waiting && !state.deciding) next();
        }, 180);
        syncPlaybackMode();
        return state.skip;
    }

    global.AliceADVScript = {
        start, next, rollback, exit, setAuto, setSkip, renderHistory,
        saveAuto, saveQuick, saveManual, loadAuto, loadQuick,
        load, getSave, autoSaveEnabled, quickSaveEnabled,
        resetStage,          // 舞台复位（离开/进入播放共用；测试与自定义 UI 也可直接调用）
        state,
        isPlaying: () => state.playing,
        history: () => state.history
    };
})(window);
