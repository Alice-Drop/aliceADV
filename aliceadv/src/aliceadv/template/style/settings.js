/* =========================================================
 * aliceADV engine — 设置系统 (settings store)
 *
 * 职责边界：
 *   1. 配置的单一来源：默认值 → localStorage 持久化 → 变更订阅。
 *      页面只读 get() / 只写 set()，不各自保存一份，避免多处状态不一致。
 *   2. 显示模式的落地：窗口 ↔ 浏览器全屏（Fullscreen API）。
 *
 * 语义：存下来的是「当前生效状态」，不是「启动时想不想全屏」的愿望。
 * 因此实际状态变化时（在设置里切窗口、或玩家连续两次按 ESC 退出全屏）都要回写。
 *
 * 存储键：aliceadv.settings.<游戏名>，按游戏分命名空间，多个作品互不干扰。
 * localStorage 不可用时（隐私模式 / 部分 file:// 场景）自动降级为「仅本次会话生效」，
 * 不抛错、不影响游戏运行。
 *
 * 全屏的浏览器限制：requestFullscreen() 必须由用户手势触发。
 * 因此启动时读到「全屏幕」不能直接调用，而是挂一次性手势监听
 * （pointerdown / mousedown / touchstart / keydown），
 * 等玩家第一次点击或按键时才申请；玩家手动改回窗口则立即撤销该监听。
 * ========================================================= */

(function (global) {
    "use strict";

    /* ---------- 1. 默认值：单一来源 ---------- */
    const DEFAULTS = {
        displayMode:     "window",   // "window" | "fullscreen"
        rollbackSide:    "left",     // "disable" | "left" | "right"
        skipUnseen:      false,
        skipAfterChoice: true,
        skipTransitions: false,
        textSpeed:       0.55,
        autoWait:        0.30,
        musicVolume:     0.60,
        soundVolume:     0.70,
        voiceVolume:     0.80,
        muteAll:         false
    };

    const PREFIX = "aliceadv.settings.";
    const ARM_EVENTS = ["pointerdown", "mousedown", "touchstart", "keydown"];

    let cache = null;              // 内存态：读写的唯一对象
    let keyCache = null;           // localStorage 键（惰性计算）
    const listeners = [];          // 变更订阅者

    /* ---------- 2. 存储层 ---------- */
    function storageKey() {
        if (keyCache) return keyCache;
        let name = "";
        try {
            const t = global.__THEME__
                || (global.AliceADVTheme && global.AliceADVTheme.getTheme && global.AliceADVTheme.getTheme());
            name = (t && t.info && t.info.name) || "";
        } catch (e) { name = ""; }
        // 只剔掉会破坏键名/造成歧义的字符，保留中日韩等本地字符：
        // 用 \w 会把「无法校准少女」整串压成一个 "_"，不同作品会撞键。
        const slug = String(name).trim()
            .replace(/[\s\u0000-\u001f\u007f\/:*?"<>|#&=]+/g, "_").slice(0, 64) || "default";
        keyCache = PREFIX + slug;
        return keyCache;
    }

    function readStore() {
        try {
            const raw = global.localStorage.getItem(storageKey());
            if (!raw) return {};
            const obj = JSON.parse(raw);
            return (obj && typeof obj === "object") ? obj : {};
        } catch (e) { return {}; }
    }

    function writeStore(obj) {
        try { global.localStorage.setItem(storageKey(), JSON.stringify(obj)); return true; }
        catch (e) { return false; }   // 存储不可用：仅内存生效
    }

    // 按默认值类型收紧，避免脏数据（手改 localStorage / 旧版本残留）污染运行时
    function coerce(value, def) {
        if (typeof def === "boolean") return !!value;
        if (typeof def === "number") {
            const n = Number(value);
            return isFinite(n) ? Math.min(1, Math.max(0, n)) : def;
        }
        if (typeof def === "string") return (typeof value === "string" && value) ? value : def;
        return def;
    }

    function load() {
        if (cache) return cache;
        const stored = readStore();
        cache = {};
        for (const k in DEFAULTS) {
            const v = stored[k];
            cache[k] = (v === undefined || v === null) ? DEFAULTS[k] : coerce(v, DEFAULTS[k]);
        }
        return cache;
    }

    function emit(key, value) {
        listeners.slice().forEach(fn => {
            try { fn(key, value); } catch (e) { /* 单个订阅者出错不阻断其余 */ }
        });
    }

    /* ---------- 3. 读写接口 ---------- */
    function get(key) {
        if (!(key in DEFAULTS)) return undefined;
        return load()[key];
    }

    function set(key, value) {
        if (!(key in DEFAULTS)) return;              // 未知项不落盘
        const s = load();
        const next = coerce(value, DEFAULTS[key]);
        if (s[key] === next) return;                 // 同值不写盘、不广播
        s[key] = next;
        writeStore(s);
        if (key === "displayMode") {
            // 玩家在设置里显式改过，就撤销「启动后首次点击自动全屏」的待命
            disarmAutoFullscreen();
            applyDisplayMode();
        }
        emit(key, next);
    }

    function all() {
        const s = load();
        const out = {};
        for (const k in s) out[k] = s[k];
        return out;
    }

    function reset() {
        cache = null;
        writeStore({});
        load();
        for (const k in DEFAULTS) emit(k, DEFAULTS[k]);
        disarmAutoFullscreen();
        applyDisplayMode();
    }

    // 订阅全量变更；返回取消订阅函数。key === "__fullscreen" 表示实际全屏状态变化
    function onChange(fn) {
        if (typeof fn !== "function") return function () {};
        listeners.push(fn);
        return function () {
            const i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
        };
    }

    /* ---------- 4. 显示模式：窗口 ↔ 全屏 ----------
     * 目标元素是 documentElement（#game-frame 为 fixed inset:0，全屏后自然铺满屏幕）。
     * 带 webkit 前缀是因为 Safari 系列只实现了旧接口。
     */
    function fullscreenEl() {
        return document.fullscreenElement || document.webkitFullscreenElement || null;
    }
    function isFullscreen() { return !!fullscreenEl(); }

    /* 「能不能全屏」要看 fullscreenEnabled（Permissions Policy），不能只看方法在不在：
     * 被嵌进没有 allowfullscreen 的 iframe 时，requestFullscreen 方法是有的，
     * 但策略禁止，调用必失败 —— fullscreenEnabled 才是浏览器给的实时判定。 */
    function isFullscreenSupported() {
        if (typeof document.fullscreenEnabled === "boolean") return document.fullscreenEnabled;
        if (typeof document.webkitFullscreenEnabled === "boolean") return document.webkitFullscreenEnabled;
        const el = document.documentElement;
        return !!(el.requestFullscreen || el.webkitRequestFullscreen);
    }

    function requestFullscreen() {
        if (!isFullscreenSupported()) return Promise.resolve(false);
        const el = document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        let p;
        try { p = req.call(el); } catch (e) { return Promise.resolve(false); }
        return Promise.resolve(p).then(function () { return true; }).catch(function () { return false; });
    }

    function exitFullscreen() {
        if (!isFullscreen()) return Promise.resolve(false);
        const ex = document.exitFullscreen || document.webkitExitFullscreen;
        if (!ex) return Promise.resolve(false);
        let p;
        try { p = ex.call(document); } catch (e) { return Promise.resolve(false); }
        return Promise.resolve(p).then(function () { return true; }).catch(function () { return false; });
    }

    /* 竞态校正：全屏请求是异步的，等它落地时偏好可能已经被改回「窗口」
     * （例如启动待命的首次点击落在了「窗口」按钮上）。落地后对一次账即可。 */
    function reconcile() {
        if (get("displayMode") !== "fullscreen" && isFullscreen()) exitFullscreen();
    }

    // 按当前偏好落地：全屏就进，窗口就退。已处于目标状态时不动，避免无谓的 rejected promise。
    function applyDisplayMode() {
        if (get("displayMode") === "fullscreen") {
            if (isFullscreen()) return;
            requestFullscreen().then(function (ok) {
                // 申请被拒（无 allowfullscreen 的 iframe / 浏览器策略）= 状态根本没变，
                // 那就别让设置页停在「全屏幕」上谎报状态，如实写回窗口。
                if (!ok && get("displayMode") === "fullscreen" && !isFullscreen()) {
                    set("displayMode", "window");
                }
                reconcile();
            });
        } else {
            if (isFullscreen()) exitFullscreen();
        }
    }

    /* ---------- 5. 启动时的全屏待命 ----------
     * 偏好为「全屏幕」时，等玩家第一次手势再申请（浏览器硬性要求）。
     * 监听是一次性的：触发后立刻摘除，之后的全屏切换只由设置项的显式操作驱动。
     */
    let armHandler = null;

    function disarmAutoFullscreen() {
        if (!armHandler) return;
        ARM_EVENTS.forEach(t => document.removeEventListener(t, armHandler, true));
        armHandler = null;
    }

    function armAutoFullscreen() {
        if (armHandler) return;
        if (get("displayMode") !== "fullscreen") return;
        if (!isFullscreenSupported()) return;
        if (isFullscreen()) return;

        const fire = function () {
            disarmAutoFullscreen();
            requestFullscreen().then(reconcile);
        };
        armHandler = fire;
        ARM_EVENTS.forEach(t => document.addEventListener(t, fire, true));
    }

    /* ---------- 6. 全屏状态变化（玩家按 ESC / 浏览器 UI） ----------
     * displayMode 存的是「当前生效状态」，不是「启动时想不想全屏」的愿望，
     * 所以只要真的退出了全屏，状态就必须立刻跟着变 —— 一次 ESC 就够，
     * 浏览器本来就是按一次 ESC 退出全屏，不存在「按两次才退」。
     *
     * 判定完全走事件（fullscreenchange），不轮询、不猜按键：
     * 浏览器退出全屏时 fullscreenElement 变 null 并派发该事件，
     * 「刚才是全屏 → 现在不是」这一跳本身就是最可靠的信号。
     *
     * 判定完全交给浏览器的事件，不轮询、不猜按键、不维护自己的状态变量：
     *   fullscreenchange + document.fullscreenElement —— 「现在是不是全屏」由 API 说了算；
     *   fullscreenerror                              —— 申请失败时也给事件。
     *
     * 不变式很简单：displayMode 必须等于真实全屏状态。
     * 所以事件一到就这么判：不在全屏、偏好却还是「全屏幕」→ 状态不一致，写回窗口。
     * 区分不了也不需要区分是 ESC 还是申请失败 —— 结果都是「现在不是全屏」。
     * 偏好已经是「窗口」时 set() 同值早退，不会重复写盘。
     */
    function syncFromFullscreen() {
        const now = isFullscreen();
        // 走 set() 而不是直接改内存：要落盘，并让设置页的选中态跟着变。
        if (!now && get("displayMode") === "fullscreen") set("displayMode", "window");
        emit("__fullscreen", now);
    }

    function bindFullscreenEvents() {
        document.addEventListener("fullscreenchange", syncFromFullscreen);
        document.addEventListener("webkitfullscreenchange", syncFromFullscreen);
        // 申请失败（无 allowfullscreen 的 iframe / 被策略拦截）不会走 fullscreenchange，
        // 只发 fullscreenerror；这里补上，免得设置页停在「全屏幕」谎报状态。
        document.addEventListener("fullscreenerror", syncFromFullscreen);
        document.addEventListener("webkitfullscreenerror", syncFromFullscreen);
    }

    /* ---------- 7. 初始化 ---------- */
    function init() {
        load();
        bindFullscreenEvents();
        armAutoFullscreen();
    }

    global.AliceADVSettings = {
        init: init,
        get: get,
        set: set,
        all: all,
        reset: reset,
        onChange: onChange,
        defaults: DEFAULTS,
        // 显示模式
        applyDisplayMode: applyDisplayMode,
        armAutoFullscreen: armAutoFullscreen,
        disarmAutoFullscreen: disarmAutoFullscreen,
        isFullscreen: isFullscreen,
        isFullscreenSupported: isFullscreenSupported,
        requestFullscreen: requestFullscreen,
        exitFullscreen: exitFullscreen
    };
})(window);
