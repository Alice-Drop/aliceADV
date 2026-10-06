/* =========================================================
 * aliceADV engine — 输入系统 (input actions / bindings / devices)
 *
 * 职责：把「玩家按了什么」翻译成「引擎要做什么」。
 *
 *   设备事件（键盘 / 鼠标 / 滚轮 / 游戏手柄）
 *        ↓  按绑定表匹配
 *   动作 (action)  —— 引擎的语义单位，如 Advance / Rollback / QuickSave
 *        ↓  按注册顺序派发
 *   处理器 (handler) —— 由 engine.js / script.js / 工程自定义 UI 注册
 *
 * 三条边界（改这个文件前先看懂）：
 *   1. 本文件**不认识剧情**。它只知道动作名；「Advance 是下一句」由 script.js 注册。
 *   2. 绑定是数据。默认绑定写在 theme.json 的 input.presets，玩家改动写在 localStorage，
 *      本文件只是这两者的读取者与合并者，不内置任何一套字面默认绑定。
 *   3. 事件只翻译、不吞。除「按键捕获」与「径向菜单」两种独占态外，
 *      一律不改事件的默认行为（不 preventDefault），避免把页面 UI 弄坏。
 *
 * 绑定字符串语法（作者手写在 theme.json，也用作用户自定义绑定的存储格式）：
 *   key:<键名>              键盘，键名取 KeyboardEvent.key 归一化后的写法：
 *                           key:enter / key:space / key:escape / key:arrowup /
 *                           key:pageup / key:f5 / key:a（单字符一律小写）
 *                           可加修饰键前缀，顺序固定 ctrl+alt+shift+meta：
 *                           key:ctrl+shift+a
 *   mouse:left|middle|right|x1|x2      鼠标按键
 *   wheel:up|down|left|right           滚轮（拨一下 = 一次事件）
 *   pad:a|b|x|y|lb|rb|lt|rt|back|start|l3|r3|up|down|left|right
 *                                      手柄按键别名；也可写数字 pad:0（按钮下标）
 *
 * 派发顺序：同一个事件可能同时命中多个动作（如回车既是 Confirm 又是 Advance）。
 * 命中的动作按 priority 从大到小依次派发，**第一个返回 true 的处理器消费掉该事件**，
 * 后面的不再执行。因此「确认」只在真的有可确认的 UI 时消费回车，否则回车落到「下一句」。
 * ========================================================= */

(function (global) {
    "use strict";

    /* ---------- 0. 动作表 ----------
     * priority：派发顺序（大者先）—— 见文件头「派发顺序」。
     * hold：按住生效（keydown 派发、keyup 结束），如「快进」。
     * wheelOnly：只响应滚轮设备（滚轮回看的开关是设置项，见 dispatch 的 gate 判断）。
     * label / short：界面文案。radial 用短名（径向菜单格子窄）。
     * 这些是**引擎 I18N**，与 theme.js 的 I18N 同性质；theme.json 的
     * input.actionLabels 可以逐项覆盖，不必改本文件。
     */
    const ACTIONS = [
        { id: "Advance",      label: "下一句 / 推进剧情",   short: "下一句", priority: 40 },
        { id: "Rollback",     label: "上一句 / 回到历史位置", short: "上一句", priority: 60 },
        { id: "ScrollBack",   label: "回看（向上滚动）",     short: "回看",   priority: 70, wheelOnly: true },
        { id: "ScrollForward",label: "回到当前（向下滚动）", short: "回到当前", priority: 70, wheelOnly: true },
        { id: "History",      label: "打开历史文本",         short: "历史",   priority: 55 },
        { id: "Auto",         label: "自动播放",             short: "自动",   priority: 55 },
        { id: "SkipRead",     label: "跳过已读文本",         short: "跳已读", priority: 55 },
        { id: "SkipAll",      label: "跳过全部文本",         short: "跳全部", priority: 55 },
        { id: "FastForward",  label: "快进（按住）",         short: "快进",   priority: 55, hold: true },
        { id: "HideUI",       label: "隐藏 / 显示 UI",       short: "隐藏UI", priority: 50 },
        { id: "OpenMenu",     label: "打开游戏菜单",         short: "菜单",   priority: 50 },
        { id: "OpenSave",     label: "打开保存界面",         short: "保存",   priority: 50 },
        { id: "OpenLoad",     label: "打开读档界面",         short: "读取",   priority: 50 },
        { id: "QuickSave",    label: "快速保存",             short: "快存",   priority: 50 },
        { id: "QuickLoad",    label: "快速读档",             short: "快读",   priority: 50 },
        { id: "OpenSettings", label: "打开设置",             short: "设置",   priority: 50 },
        { id: "OpenGallery",  label: "打开鉴赏 / 画廊",      short: "画廊",   priority: 50 },
        { id: "OpenLog",      label: "打开文本 Log",         short: "Log",    priority: 54 },
        { id: "Screenshot",   label: "截图",                 short: "截图",   priority: 45 },
        { id: "Fullscreen",   label: "全屏切换",             short: "全屏",   priority: 45 },
        { id: "Cancel",       label: "返回 / 取消",          short: "取消",   priority: 100 },
        { id: "Confirm",      label: "确认当前 UI 项",       short: "确认",   priority: 100 },
        { id: "MenuUp",       label: "列表上移",             short: "上移",   priority: 95 },
        { id: "MenuDown",     label: "列表下移",             short: "下移",   priority: 95 },
        { id: "NavUp",        label: "焦点框上移（手柄方向键 / 左摇杆）",   short: "焦点上", priority: 90 },
        { id: "NavDown",      label: "焦点框下移（手柄方向键 / 左摇杆）",   short: "焦点下", priority: 90 },
        { id: "NavLeft",      label: "焦点框左移（手柄方向键 / 左摇杆）",   short: "焦点左", priority: 90 },
        { id: "NavRight",     label: "焦点框右移（手柄方向键 / 左摇杆）",   short: "焦点右", priority: 90 }
    ];

    const ACTION_IDS = ACTIONS.map(a => a.id);
    const ACTION_MAP = {};
    ACTIONS.forEach(a => { ACTION_MAP[a.id] = a; });

    /* ---------- 1. 设备与绑定字符串 ---------- */

    const MOUSE_NAMES = ["left", "middle", "right", "x1", "x2"];
    const PAD_ALIAS = {
        a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7,
        back: 8, start: 9, l3: 10, r3: 11,
        up: 12, down: 13, left: 14, right: 15
    };
    const PAD_ALIAS_BY_INDEX = {};
    for (const k in PAD_ALIAS) PAD_ALIAS_BY_INDEX[PAD_ALIAS[k]] = k;

    const KEY_LABELS = {
        enter: "回车", space: "空格", escape: "Esc", tab: "Tab", backspace: "退格",
        delete: "Delete", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
        pageup: "PageUp", pagedown: "PageDown", home: "Home", end: "End",
        shift: "Shift", control: "Ctrl", alt: "Alt", meta: "Meta"
    };
    const MOUSE_LABELS = {
        left: "鼠标左键", middle: "鼠标中键", right: "鼠标右键",
        x1: "鼠标侧键1", x2: "鼠标侧键2"
    };
    const WHEEL_LABELS = { up: "滚轮上", down: "滚轮下", left: "滚轮左", right: "滚轮右" };
    const PAD_LABELS = {
        a: "手柄 A", b: "手柄 B", x: "手柄 X", y: "手柄 Y",
        lb: "手柄 LB", rb: "手柄 RB", lt: "手柄 LT", rt: "手柄 RT",
        back: "手柄 Back", start: "手柄 Start", l3: "手柄 L3", r3: "手柄 R3",
        up: "手柄 ↑", down: "手柄 ↓", left: "手柄 ←", right: "手柄 →"
    };

    function parseBinding(str) {
        if (typeof str !== "string") return null;
        const raw = str.trim();
        const ci = raw.indexOf(":");
        if (ci <= 0) return null;
        const device = raw.slice(0, ci).toLowerCase();
        let body = raw.slice(ci + 1).trim();
        if (!body) return null;
        if (device === "key") {
            const mods = { ctrl: false, alt: false, shift: false, meta: false };
            let parts = body.split("+");
            const name = parts.pop();
            if (!name) return null;
            for (const p of parts) {
                const m = p.trim().toLowerCase();
                if (m === "ctrl" || m === "control") mods.ctrl = true;
                else if (m === "alt" || m === "option") mods.alt = true;
                else if (m === "shift") mods.shift = true;
                else if (m === "meta" || m === "cmd" || m === "win") mods.meta = true;
                else return null;                      // 未知修饰键 = 非法绑定
            }
            const key = normalizeKeyName(name);
            if (!key) return null;
            return { device: "key", key: key, mods: mods };
        }
        if (device === "mouse") {
            body = body.toLowerCase();
            if (MOUSE_NAMES.indexOf(body) === -1) return null;
            return { device: "mouse", button: body, index: MOUSE_NAMES.indexOf(body) };
        }
        if (device === "wheel") {
            body = body.toLowerCase();
            if (!WHEEL_LABELS[body]) return null;
            return { device: "wheel", dir: body };
        }
        if (device === "pad") {
            body = body.toLowerCase();
            let idx;
            if (body in PAD_ALIAS) idx = PAD_ALIAS[body];
            else if (/^\d+$/.test(body)) idx = parseInt(body, 10);
            else return null;
            if (!(idx >= 0 && idx < 32)) return null;
            return { device: "pad", index: idx, name: PAD_ALIAS_BY_INDEX[idx] || String(idx) };
        }
        return null;
    }

    /* 键名归一化：KeyboardEvent.key → 绑定字符串里的写法。
     * 单字符一律小写（这样 Shift+A 表达成 shift+a），空格写成 Space。
     * 注意：空格的判定必须在 trim() **之前** —— String(" ").trim() 已经是空串，
     * 先 trim 就会走进「空名字直接返回」那一支，`key:space` 永远匹配不上真实的空格键。 */
    function normalizeKeyName(name) {
        const raw = String(name);
        if (raw === " " || raw === "Spacebar") return "space";
        const s = raw.trim();
        if (!s) return "";
        if (s === "Esc") return "escape";
        return s.toLowerCase();
    }

    function formatBinding(b) {
        if (!b) return "";
        if (b.device === "key") {
            const pre = [];
            if (b.mods && b.mods.ctrl) pre.push("ctrl");
            if (b.mods && b.mods.alt) pre.push("alt");
            if (b.mods && b.mods.shift) pre.push("shift");
            if (b.mods && b.mods.meta) pre.push("meta");
            return "key:" + pre.concat([b.key]).join("+");
        }
        if (b.device === "mouse") return "mouse:" + b.button;
        if (b.device === "wheel") return "wheel:" + b.dir;
        if (b.device === "pad") return "pad:" + b.name;
        return "";
    }

    /* 绑定 → 中文说明（设置页与键位表用它生成可读文本）。 */
    function describeBinding(str) {
        const b = typeof str === "string" ? parseBinding(str) : str;
        if (!b) return String(str == null ? "" : str);
        let pre = "";
        if (b.device === "key" && b.mods) {
            if (b.mods.ctrl) pre += "Ctrl+";
            if (b.mods.alt) pre += "Alt+";
            if (b.mods.shift) pre += "Shift+";
            if (b.mods.meta) pre += "Meta+";
        }
        if (b.device === "key") {
            const k = b.key;
            if (KEY_LABELS[k]) return pre + KEY_LABELS[k];
            if (/^f\d{1,2}$/.test(k)) return pre + k.toUpperCase();   // F1..F12
            return pre + (k.length === 1 ? k.toUpperCase() : k);
        }
        if (b.device === "mouse") return MOUSE_LABELS[b.button] || ("鼠标 " + b.button);
        if (b.device === "wheel") return WHEEL_LABELS[b.dir] || ("滚轮 " + b.dir);
        if (b.device === "pad") return PAD_LABELS[b.name] || ("手柄按钮 " + b.index);
        return "";
    }

    function describeBindings(list) {
        const out = [];
        (list || []).forEach(s => {
            const d = describeBinding(s);
            if (d) out.push(d);
        });
        return out.join("、");
    }

    /* ---------- 2. 配置读取（theme.json） ---------- */

    function theme() {
        try {
            return global.__THEME__
                || (global.AliceADVTheme && global.AliceADVTheme.getTheme && global.AliceADVTheme.getTheme())
                || {};
        } catch (e) { return {}; }
    }

    function inputCfg() {
        const c = theme().input;
        return (c && typeof c === "object") ? c : {};
    }

    /* 推荐方案（presets）：开发者写的「默认映射」。
     * 规格：input.presets = [{ id, label, bindings: { 动作id: [绑定字符串…] } }]
     * theme.json 里不写 = 没有任何推荐方案（此时所有动作都只能靠玩家自定义）。
     * 无论写了几个方案，都只是「推荐」——玩家在设置里可以逐动作改选，改动只落本地。 */
    function presets() {
        const list = inputCfg().presets;
        if (!Array.isArray(list)) return [];
        return list.filter(p => p && typeof p === "object" && typeof p.id === "string")
                   .map(p => ({
                       id: p.id,
                       label: (typeof p.label === "string" && p.label) ? p.label : p.id,
                       bindings: (p.bindings && typeof p.bindings === "object") ? p.bindings : {}
                   }));
    }

    function presetById(id) {
        return presets().filter(p => p.id === id)[0] || null;
    }

    // 没有玩家选择时用哪个方案：input.default（缺省用第一个方案）
    function defaultPresetId() {
        const d = inputCfg().default;
        const ps = presets();
        if (typeof d === "string" && presetById(d)) return d;
        return ps.length ? ps[0].id : "";
    }

    function presetBindings(presetId, action) {
        const p = presetById(presetId);
        if (!p) return [];
        const raw = p.bindings[action];
        return Array.isArray(raw) ? raw.filter(s => parseBinding(s)) : [];
    }

    /* ---------- 3. 玩家选择（localStorage） ----------
     * 存储：aliceadv.bindings.<游戏名> = { 动作id: {preset:"id"} | {custom:["key:a", …]} }
     * 与设置同命名空间规则（storageKeyFor 由 settings.js 提供，缺省时本地兜底）。 */
    function bindingsKey() {
        const S = global.AliceADVSettings;
        if (S && S.storageKeyFor) return S.storageKeyFor("aliceadv.bindings.");
        let name = "";
        try { name = (theme().info || {}).name || ""; } catch (e) { name = ""; }
        const slug = String(name).trim().replace(/[\s\u0000-\u001f\u007f\/:*?"<>|#&=]+/g, "_").slice(0, 64) || "default";
        return "aliceadv.bindings." + slug;
    }

    let selCache = null;

    function readSel() {
        if (selCache) return selCache;
        selCache = {};
        try {
            const raw = global.localStorage.getItem(bindingsKey());
            if (raw) {
                const obj = JSON.parse(raw);
                if (obj && typeof obj === "object") {
                    for (const k in obj) {
                        const v = obj[k];
                        if (!v || typeof v !== "object") continue;
                        if (typeof v.preset === "string") selCache[k] = { preset: v.preset };
                        else if (Array.isArray(v.custom)) selCache[k] = { custom: v.custom.filter(s => parseBinding(s)) };
                    }
                }
            }
        } catch (e) { selCache = {}; }
        return selCache;
    }

    function writeSel() {
        try { global.localStorage.setItem(bindingsKey(), JSON.stringify(selCache || {})); }
        catch (e) { /* 存储不可用：仅本次会话生效，与设置系统同一降级策略 */ }
    }

    function selection(action) {
        const sel = readSel()[action];
        if (!sel) return { preset: defaultPresetId() };   // 未选择 = 跟随默认方案
        if (sel.custom) return { custom: sel.custom.slice() };
        if (sel.preset) return { preset: sel.preset };
        return { preset: defaultPresetId() };
    }

    function setSelection(action, sel) {
        if (ACTION_IDS.indexOf(action) === -1) return;
        if (!sel) {
            delete readSel()[action];           // 清空 = 回到「跟随默认方案」
        } else if (sel.custom) {
            readSel()[action] = { custom: sel.custom.filter(s => parseBinding(s)) };
        } else if (sel.preset) {
            readSel()[action] = { preset: sel.preset };
        }
        writeSel();
        matchCache = null;
        emitChange();
    }

    // 某动作「此刻生效」的绑定列表（推荐方案 or 玩家自定义）
    function bindingsFor(action) {
        const sel = selection(action);
        if (sel.custom) return sel.custom.slice();
        return presetBindings(sel.preset, action);
    }

    /* 生效绑定表（已解析）。事件派发是热路径（每次按键 / 每帧手柄轮询都要比对全部动作），
     * 每次都重建字符串数组再 parse 一遍太浪费，因此解析结果缓存在这里；
     * 玩家改绑定（setSelection）或主题重新加载（refresh）时失效重建。 */
    let matchCache = null;

    function rebuildMatch() {
        const t = {};
        for (let i = 0; i < ACTIONS.length; i++) {
            t[ACTIONS[i].id] = bindingsFor(ACTIONS[i].id).map(parseBinding).filter(Boolean);
        }
        matchCache = t;
        return t;
    }

    function matchTable() { return matchCache || rebuildMatch(); }

    function refresh() { matchCache = null; }

    // 与别的动作撞车：返回共用同一绑定的其它动作 id 列表（设置页据此提示）
    function conflicts(action) {
        const mine = bindingsFor(action);
        if (!mine.length) return [];
        const out = [];
        ACTION_IDS.forEach(other => {
            if (other === action) return;
            const theirs = bindingsFor(other);
            if (theirs.some(s => mine.indexOf(s) !== -1)) out.push(other);
        });
        return out;
    }

    /* ---------- 4. 处理器注册与派发 ---------- */

    const handlers = {};      // action → [{fn, priority}]
    const availability = {};  // action → fn() → bool

    function register(action, fn, opts) {
        if (ACTION_IDS.indexOf(action) === -1) {
            console.warn("[aliceADV] 未知动作，注册被忽略:", action);
            return;
        }
        if (typeof fn !== "function") return;
        const prio = (opts && typeof opts.priority === "number") ? opts.priority : 0;
        if (!handlers[action]) handlers[action] = [];
        handlers[action].push({ fn: fn, priority: prio });
        handlers[action].sort((a, b) => b.priority - a.priority);
    }

    function registerAll(map, opts) {
        for (const k in map) register(k, map[k], opts);
    }

    // 「这个动作现在能不能用」——径向菜单据此置灰；缺省为可用。
    function registerAvailability(action, fn) {
        availability[action] = (typeof fn === "function") ? fn : null;
    }

    function available(action) {
        const f = availability[action];
        if (!f) return true;
        try { return !!f(); } catch (e) { return false; }
    }

    /* 派发：走到第一个返回 true 的处理器就停。
     * 约定：处理器返回 true = 「我处理了，别再给别人」；返回 false/undefined = 不归我管。 */
    function dispatch(action, ev) {
        const list = handlers[action];
        if (!list || !list.length) return false;
        for (let i = 0; i < list.length; i++) {
            try {
                if (list[i].fn(ev || {}) === true) return true;
            } catch (e) {
                console.warn("[aliceADV] 动作处理器出错:", action, e);
            }
        }
        return false;
    }

    /* 直接执行一个动作（不经过设备匹配）：径向菜单、工具栏按钮、工程自定义 UI 用。
     * 与按键触发走同一条派发链，因此「能不能用」的判据只有一处。 */
    function fire(action, ev) {
        if (ACTION_IDS.indexOf(action) === -1) return false;
        if (!available(action)) return false;
        return dispatch(action, ev || { synthetic: true, action: action });
    }

    /* ---------- 5. 动作标签（theme.input.actionLabels 可逐项覆盖） ---------- */
    function actionLabel(action, short) {
        const meta = ACTION_MAP[action];
        const cfg = inputCfg().actionLabels;
        const over = (cfg && typeof cfg === "object") ? cfg[action] : null;
        if (over && typeof over === "object") {
            if (short && over.short) return String(over.short);
            if (over.label) return String(over.label);
        } else if (typeof over === "string") {
            return over;
        }
        if (!meta) return action;
        return (short ? (meta.short || meta.label) : meta.label) || action;
    }

    function actions() {
        return ACTIONS.map(a => ({
            id: a.id, label: actionLabel(a.id, false), short: actionLabel(a.id, true),
            hold: !!a.hold, wheelOnly: !!a.wheelOnly, priority: a.priority
        }));
    }

    function onBindingsChange(fn) {
        if (typeof fn !== "function") return function () {};
        changeListeners.push(fn);
        return function () {
            const i = changeListeners.indexOf(fn);
            if (i >= 0) changeListeners.splice(i, 1);
        };
    }
    const changeListeners = [];
    function emitChange() {
        changeListeners.slice().forEach(fn => {
            try { fn(); } catch (e) { /* 单个订阅者出错不阻断其余 */ }
        });
    }

    /* ---------- 6. 设备事件 → 动作 ---------- */

    // 滚轮回看开关（设置项）。关掉后**只**屏蔽滚轮设备的回看绑定，键盘上的同动作绑定照常。
    function wheelReviewOn() {
        const S = global.AliceADVSettings;
        if (!S) return true;
        const v = S.get("wheelReview");
        return (v === undefined) ? true : !!v;
    }

    function eventMatches(b, ev) {
        if (!b) return false;
        if (b.device !== "key") return false;
        if (ev.key == null) return false;
        if (normalizeKeyName(ev.key) !== b.key) return false;
        const m = b.mods || {};
        return !!ev.ctrlKey === !!m.ctrl && !!ev.altKey === !!m.alt
            && !!ev.shiftKey === !!m.shift && !!ev.metaKey === !!m.meta;
    }

    /* 键盘/鼠标/滚轮：收集所有命中的动作，按 priority 降序派发，首个消费即止。
     * opts.repeat=true（长按重复）时跳过「按住生效」以外的动作 —— 否则一直按着回车会连发推进。 */
    function dispatchMatching(matchFn, ev, opts) {
        const table = matchTable();
        const repeat = !!(opts && opts.repeat);
        const hits = [];
        for (let i = 0; i < ACTIONS.length; i++) {
            const a = ACTIONS[i];
            if (repeat && !a.hold) continue;
            const bl = table[a.id] || [];
            for (let j = 0; j < bl.length; j++) {
                const b = bl[j];
                if (!matchFn(b, ev)) continue;
                if (b.device === "wheel" && a.wheelOnly && !wheelReviewOn()) break;
                hits.push({ id: a.id, priority: a.priority, order: i });
                break;
            }
        }
        if (!hits.length) return null;
        hits.sort((x, y) => (y.priority - x.priority) || (x.order - y.order));
        for (let i = 0; i < hits.length; i++) {
            if (!available(hits[i].id)) continue;
            if (dispatch(hits[i].id, ev)) return hits[i].id;
        }
        return null;
    }

    // 事件是否来自需要保留原生行为的区域（表单控件、可滚动列表…）
    function isFormTarget(t) {
        if (!t || !t.closest) return false;
        return !!t.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
    }

    /* 点击类事件的目标过滤：落在可交互控件上的点击不翻译成动作，
     * 交给页面自己的 click 处理器（否则点「保存」会同时推进一句台词）。 */
    const INTERACTIVE_SEL = [
        "button", "a", "select", "input", "textarea", "label",
        ".toolbar", ".choices", ".ingame-overlay", ".popup", ".notify",
        ".radial", ".scroll-area", ".slider", ".seg", ".chip",
        ".slot", ".gallery-item", ".chapter-item", ".branch-item",
        ".page-jumper", ".keymap"
    ].join(",");

    function isInteractiveTarget(t) {
        if (!t || !t.closest) return false;
        return !!t.closest(INTERACTIVE_SEL);
    }

    /* ---------- 7. 快捷轮盘（长按呼出） ----------
     * 触发：在任意位置按住超过设置项 radialHoldMs（默认 500ms）。
     * 松手在原处 / 落在中心 = 无动作（取消）；拖过内圈、进到某个方向的 1/4 圆环 = 执行该方向的动作。
     * 方向装什么、开关、触发时长都是设置项（radialUp/Right/Down/Left/Center、radialEnabled、radialHoldMs）。
     * 外观与半径在 style/pages/radial.css，这里只管判定与派发。
     */
    const RADIAL = {
        node: null,
        open: false,
        x: 0, y: 0, dir: null,
        timer: null,
        swallowUp: false,     // 长按后的那次 pointerup 不再翻译成动作
        downX: 0, downY: 0,
        drag: 10              // 长按前允许的手指抖动（屏幕 px），超过视为拖动、不呼出
    };

    /* 轮盘几何不在 JS 里另写一份：真身是 style/pages/radial.css 里那一串由「外直径 = 画面高度的 30%」
     * 派生出来的半径。呼出时直接**量元素** —— `.radial` 的宽就是 2×外半径、内缘细线的宽就是 2×内半径。
     *
     * 不能改成 parseFloat(getComputedStyle(...).getPropertyValue("--radial-r-out"))：
     * 自定义属性现在是 `calc(var(--radial-d) / 2)` 这种未化简的表达式（Chrome 的原样返回，
     * 不折成 px），parseFloat 只会拿到 NaN 并静默退回兜底值 —— 判定半径与视觉半径又分家，
     * 「看着够到圆环了却没选中」就是这么来的。量元素拿到的是已解析的屏幕 px，
     * 单位是 vh / % / clamp 都无所谓。 */
    const RADIAL_RATIO_IN = 0.55;     // 内半径 / 外半径（与 radial.css 同一口径，仅在量不到时兜底用）
    const RADIAL_SHARE_OUT = 0.15;    // 外半径 / 画面高度（外直径占画面高度的 30%），同上
    /* 贴边内移时在「外半径」之外再留一点。取值要盖住 radial.css 里那层投影往外多占的
     * 部分（偏移 8 + 模糊 22 ≈ 30px）——留 8 的话，贴着屏幕底部按下去时投影会被视口边缘
     * 切掉一条，看着像环缺了个角。改 radial.css 的 drop-shadow 就要回来改这个数。 */
    const RADIAL_MARGIN_SLACK = 24;   // 屏幕 px
    let radialGeom = null;

    function radialSize() {
        if (radialGeom) return radialGeom;
        const g = { rOut: 0, rIn: 0 };
        const node = RADIAL.node;
        if (node) {
            g.rOut = node.offsetWidth / 2;
            const inner = node.querySelector(".radial__edge--in");
            if (inner) g.rIn = inner.offsetWidth / 2;
        }
        // 量不到（元素还没布局 / 被外部样式藏起来）：按同一口径从窗口高度推一个，别让判定区消失
        if (!(g.rIn > 0) || !(g.rOut > g.rIn)) {
            g.rOut = Math.max(40, (global.innerHeight || 720) * RADIAL_SHARE_OUT);
            g.rIn = g.rOut * RADIAL_RATIO_IN;
        }
        radialGeom = g;
        return g;
    }

    function settingNum(key, def) {
        const S = global.AliceADVSettings;
        if (!S) return def;
        const v = S.get(key);
        const n = Number(v);
        return isFinite(n) ? n : def;
    }

    function radialEnabled() {
        const S = global.AliceADVSettings;
        return S ? !!S.get("radialEnabled") : true;
    }

    function radialAction(dir) {
        const S = global.AliceADVSettings;
        const key = "radial" + dir.charAt(0).toUpperCase() + dir.slice(1);
        const v = S ? S.get(key) : null;
        return (typeof v === "string" && v && v !== "none") ? v : "";
    }

    function buildRadial() {
        if (RADIAL.node) return RADIAL.node;
        const wrap = document.createElement("div");
        wrap.className = "radial";
        wrap.id = "aliceadv-radial";
        wrap.setAttribute("aria-hidden", "true");
        const dirs = ["up", "right", "down", "left"];
        dirs.forEach(d => {
            const cell = document.createElement("div");
            cell.className = "radial__item radial__item--" + d;
            cell.setAttribute("data-dir", d);
            cell.appendChild(document.createElement("span")).className = "radial__label";
            wrap.appendChild(cell);
        });
        /* 环的内缘 / 外缘各一圈细线（radial.css 的 .radial__edge）：四个 1/4 圆环之间留了缝，
         * 只靠填充色会看不出这是一个被分成四段的整环。摆在环体之后，压在填充边界上。 */
        ["out", "in"].forEach(k => {
            const edge = document.createElement("div");
            edge.className = "radial__edge radial__edge--" + k;
            wrap.appendChild(edge);
        });
        const center = document.createElement("div");
        center.className = "radial__item radial__item--center";
        center.setAttribute("data-dir", "center");
        center.appendChild(document.createElement("span")).className = "radial__label";
        wrap.appendChild(center);
        document.body.appendChild(wrap);
        RADIAL.node = wrap;
        return wrap;
    }

    // 每次呼出都按当前设置重填标签与可用性（设置改了就立刻反映，不需要重建）
    function fillRadial() {
        const node = RADIAL.node;
        if (!node) return;
        ["up", "right", "down", "left", "center"].forEach(d => {
            const cell = node.querySelector('[data-dir="' + d + '"]');
            if (!cell) return;
            const id = radialAction(d);
            const lab = cell.querySelector(".radial__label");
            if (!id) {
                lab.textContent = d === "center" ? actionLabel("Cancel", true) : "—";
                cell.className = "radial__item radial__item--" + d + " is-disabled";
            } else {
                lab.textContent = actionLabel(id, true);
                cell.className = "radial__item radial__item--" + d + (available(id) ? "" : " is-disabled");
            }
            cell.setAttribute("data-action", id);
        });
    }

    function openRadial(x, y) {
        const node = buildRadial();
        radialGeom = null;                  // 每次呼出重读一次：改了样式或换了窗口尺寸都能跟上
        const g = radialSize();
        /* 呼出点距屏幕边缘的最小距离：贴近边缘长按时把圆心往里挪，保证整圈还在屏幕内、够得着。
         * 挪的是圆心、不是手指位置 —— 方向判定用的也是圆心，两边必须同一个点。 */
        const margin = g.rOut + RADIAL_MARGIN_SLACK;
        const cx = Math.min(Math.max(x, margin), Math.max(margin, window.innerWidth - margin));
        const cy = Math.min(Math.max(y, margin), Math.max(margin, window.innerHeight - margin));
        RADIAL.open = true;
        RADIAL.swallowUp = true;
        RADIAL.x = cx; RADIAL.y = cy; RADIAL.dir = "center";
        node.style.left = cx + "px";
        node.style.top = cy + "px";
        fillRadial();
        highlightRadial("center");
        // 先落到「已在位」再开过渡：否则首帧会从上一处位置滑过来
        node.classList.add("is-open");
    }

    function highlightRadial(dir) {
        RADIAL.dir = dir;
        const node = RADIAL.node;
        if (!node) return;
        node.querySelectorAll(".radial__item").forEach(c => {
            c.classList.toggle("is-hot", c.getAttribute("data-dir") === dir);
        });
    }

    function updateRadial(x, y) {
        const dx = x - RADIAL.x, dy = y - RADIAL.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        /* 判定半径 = 圆环的内半径：指针越过内圈边缘才算「够到」那一格，
         * 与眼睛看到的完全一致（radial.css 里环的内缘就画在这个半径上）。 */
        if (dist < radialSize().rIn) { highlightRadial("center"); return; }
        /* 按对角线分界（|dx| = |dy|）—— 四个 1/4 圆环也正是沿对角线交接的，
         * 两边的分界必须同一个，否则会出现「看着在右环里、判成了上环」。 */
        const dir = Math.abs(dx) >= Math.abs(dy)
            ? (dx > 0 ? "right" : "left")
            : (dy > 0 ? "down" : "up");
        highlightRadial(dir);
    }

    function closeRadial(run) {
        const node = RADIAL.node;
        const dir = RADIAL.dir;
        RADIAL.open = false;
        RADIAL.dir = null;
        if (RADIAL.timer) { clearTimeout(RADIAL.timer); RADIAL.timer = null; }
        if (node) {
            node.classList.remove("is-open");
            node.querySelectorAll(".radial__item").forEach(c => c.classList.remove("is-hot"));
        }
        if (!run) return;
        const id = radialAction(dir);
        // 中心 = 取消：松手即无动作（不开菜单、不推进），与「按住不放再松开」一致
        if (dir === "center" || !id) return;
        /* 置灰的那一格（当前没有对应功能，比如不在剧情里的「快存」）不执行：
         * fillRadial 已经把它画成灰的，再照常触发就自相矛盾了。 */
        if (!available(id)) return;
        fire(id, { synthetic: true, action: id, source: "radial" });
    }

    function onPointerDown(e) {
        RADIAL.downX = e.clientX; RADIAL.downY = e.clientY;   // 拖拽判据：无论如何都要先记下起点
        RADIAL.swallowUp = false;
        if (RADIAL.timer) { clearTimeout(RADIAL.timer); RADIAL.timer = null; }
        if (capture.active) return;             // 捕获中：由捕获逻辑独占
        if (!radialEnabled()) return;
        if (isFormTarget(e.target)) return;
        if (isInteractiveTarget(e.target)) return;   // 按在按钮/滑块上时不呼出，避免打断 UI 操作
        const ms = Math.max(120, settingNum("radialHoldMs", 500));
        RADIAL.timer = setTimeout(function () {
            RADIAL.timer = null;
            openRadial(RADIAL.downX, RADIAL.downY);
        }, ms);
    }

    function onPointerMove(e) {
        if (RADIAL.timer) {
            const dx = e.clientX - RADIAL.downX, dy = e.clientY - RADIAL.downY;
            if (Math.sqrt(dx * dx + dy * dy) > RADIAL.drag) {
                clearTimeout(RADIAL.timer);     // 移动了 = 拖动，不是长按
                RADIAL.timer = null;
            }
        }
        if (RADIAL.open) updateRadial(e.clientX, e.clientY);
    }

    function onPointerUp(e) {
        if (RADIAL.timer) { clearTimeout(RADIAL.timer); RADIAL.timer = null; }
        if (RADIAL.open) {
            updateRadial(e.clientX, e.clientY);
            closeRadial(true);
            return;                              // 这一次 pointerup 归轮盘，不再翻译成动作
        }
        if (RADIAL.swallowUp) { RADIAL.swallowUp = false; return; }
        if (capture.active) return;
        if (isInteractiveTarget(e.target)) return;
        // 拖拽（选中文本 / 拖滑块）不算点击：位移超过阈值就不翻译
        const dx = e.clientX - RADIAL.downX, dy = e.clientY - RADIAL.downY;
        if (Math.sqrt(dx * dx + dy * dy) > 8) return;
        const btn = MOUSE_NAMES[e.button];
        if (!btn) return;
        dispatchMatching(b => b.device === "mouse" && b.button === btn, e);
    }

    function onKeyDown(e) {
        if (capture.active) { captureKey(e); return; }
        // 表单控件里把按键还给控件（下拉框的方向键、输入框的字母），只有 Esc 例外
        if (isFormTarget(e.target) && e.key !== "Escape") return;
        const hit = dispatchMatching(b => eventMatches(b, e), e, { repeat: !!e.repeat });
        if (!hit) return;
        heldKeys.push({ key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey,
                        action: hit, hold: !!ACTION_MAP[hit].hold });
        if (shouldBlockDefault(e)) e.preventDefault();
    }

    const heldKeys = [];   // 按下中的「按住生效」绑定（keyup 时收尾）

    function onKeyUp(e) {
        if (capture.active) return;
        for (let i = heldKeys.length - 1; i >= 0; i--) {
            const h = heldKeys[i];
            if (h.key !== e.key) continue;
            if (!!h.ctrl !== !!e.ctrlKey || !!h.alt !== !!e.altKey
                || !!h.shift !== !!e.shiftKey || !!h.meta !== !!e.metaKey) continue;
            heldKeys.splice(i, 1);
            if (h.hold) fire(h.action, { synthetic: true, action: h.action, phase: "release" });
        }
    }

    /* 哪些按键要拦掉浏览器默认行为：
     * 空格 / 方向键会滚页面，Tab 会切焦点，F5 会刷新 —— 既然作者把它们绑成了动作，
     * 就说明不该走浏览器默认行为。**只有 Esc 例外**：拦截它的 keydown 会让浏览器
     * 收不到「退出全屏」的默认处理，而设置系统依赖玩家按 Esc 退出全屏（见 settings.js）。
     * 本函数只在这次按键**确实命中了一个动作**时才被调用，因此不会误伤未绑定的键。 */
    function shouldBlockDefault(e) {
        if (isFormTarget(e.target)) return false;
        return normalizeKeyName(e.key) !== "escape";
    }

    function onWheel(e) {
        if (capture.active) { e.preventDefault(); return; }
        if (RADIAL.open) { e.preventDefault(); return; }
        // 可滚动区域内的滚动交还给浏览器（历史记录列表、关于页）
        if (e.target && e.target.closest && e.target.closest(".scroll-area, .about-panel, .history-list")) return;
        const dir = e.deltaY < 0 ? "up" : (e.deltaY > 0 ? "down" : (e.deltaX < 0 ? "left" : "right"));
        const hit = dispatchMatching(b => b.device === "wheel" && b.dir === dir, e);
        if (hit) e.preventDefault();                 // 命中才拦，否则保留原生的页面滚动
    }

    function onContextMenu(e) {
        // 右键被绑成了动作（如 OpenMenu）：别弹浏览器菜单
        if (capture.active) { e.preventDefault(); return; }
        const bound = ACTION_IDS.some(id => bindingsFor(id).some(s => s === "mouse:right"));
        if (bound) e.preventDefault();
    }

    /* ---------- 8. 游戏手柄 ----------
     * 轮询 getGamepads()（没有事件可用），只在按下/松开的**边沿**派发 ——
     * 按住不放不会连发。没有接手柄时不启动轮询。 */
    let padPrev = {};
    let padPolling = false;
    let padPresent = false;                 // 是否检测到（任意）手柄连接
    const padListeners = [];                // 手柄「连接 / 断开」状态变化的订阅者
    let padForced = null;                   // 测试注入用：非 null 时强制覆盖轮询探测到的存在状态

    // 手柄存在状态变化时通知订阅者（engine.js 据此启停「焦点框」导航）。
    // 这里的状态只代表「有没有手柄」，不区分哪一只、也不代表某个按键。
    function setPadPresent(v) {
        v = !!v;
        if (v === padPresent) return;
        padPresent = v;
        padListeners.slice().forEach(cb => { try { cb(v); } catch (e) { /* 单个订阅者出错不影响其余 */ } });
    }

    function pollPads() {
        const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
        let any = false;
        for (let i = 0; i < pads.length; i++) {
            const p = pads[i];
            if (!p || p.connected === false) continue;
            any = true;
            const key = p.index;
            const prev = padPrev[key] || [];
            for (let b = 0; b < p.buttons.length; b++) {
                const on = !!(p.buttons[b] && p.buttons[b].pressed);
                if (on && !prev[b]) {
                    const hit = dispatchMatching(x => x.device === "pad" && x.index === b, { button: b, gamepad: p });
                    if (hit && ACTION_MAP[hit] && ACTION_MAP[hit].hold) heldPads.push({ pad: key, button: b, action: hit });
                } else if (!on && prev[b]) {
                    for (let h = heldPads.length - 1; h >= 0; h--) {
                        if (heldPads[h].pad === key && heldPads[h].button === b) {
                            const act = heldPads[h].action;
                            heldPads.splice(h, 1);
                            fire(act, { synthetic: true, action: act, phase: "release" });
                        }
                    }
                }
                prev[b] = on;
            }
            padPrev[key] = prev;
        }
        if (padForced !== null) any = padForced;   // 测试注入：强制覆盖探测结果
        if (!any) padPrev = {};
        setPadPresent(any);
        pollStick(pads);                            // 左摇杆：边沿触发派发方向（见 §8b）
        requestAnimationFrame(pollPads);
    }
    const heldPads = [];

    /* ---------- 8b. 左摇杆（模拟量） ----------
     * 十字键是 4 个按钮（axes 用不上），但多数手柄还有一根**模拟左摇杆**（axes[0]=X、axes[1]=Y，
     * Y 向下为正）。它比十字键多一维自由度：方向是一个**连续角度**。engine.js 的焦点导航据此做
     * 「真正的坐标运算」——按摇杆方向与「当前候选 → 各候选」连线方向的角度差来选按钮，而不是把
     * 摇杆量化成上/下/左/右（见 engine.js 的 Focus.moveVector）。
     *
     * 只在**越过死区的那一下**派发（边沿触发，与按钮「按住不连发」一致）：精确的斜向选择要求
     * 「推一下 → 走一格 → 回中 → 再推」。若按住连发，每次重算的「当前候选」都变了，斜向里反而漂移。*/
    const STICK_DEADZONE = 0.4;          // 死区：滤掉回中时的静置漂移
    let stickEngaged = false;           // 摇杆当前是否已越过死区（边沿检测用）
    let stickForced = null;             // 测试注入：{dx, dy}，非 null 时替代真实 axes
    const stickListeners = [];
    function onStickVector(cb) {
        if (typeof cb !== "function") return function () {};
        stickListeners.push(cb);
        return function () {
            const i = stickListeners.indexOf(cb);
            if (i >= 0) stickListeners.splice(i, 1);
        };
    }
    function emitStick(dx, dy) {
        stickListeners.slice().forEach(fn => {
            try { fn({ dx: dx, dy: dy, synthetic: true }); } catch (e) { /* 单个订阅者出错不影响其余 */ }
        });
    }
    function pollStick(pads) {
        let bx = 0, by = 0, bestMag = 0;
        if (stickForced) {
            bx = stickForced.dx; by = stickForced.dy; bestMag = Math.hypot(bx, by);
        } else {
            // 取当前推得最远的那根摇杆（多手柄时取真正在被操作的那一支）
            for (let i = 0; i < pads.length; i++) {
                const p = pads[i];
                if (!p || p.connected === false || !p.axes || p.axes.length < 2) continue;
                const x = p.axes[0] || 0, y = p.axes[1] || 0;
                const m = Math.hypot(x, y);
                if (m > bestMag) { bestMag = m; bx = x; by = y; }
            }
        }
        if (bestMag <= STICK_DEADZONE) { stickEngaged = false; return; }  // 回中 → 重新武装
        if (stickEngaged) return;                                          // 还按着 → 不连发
        stickEngaged = true;
        emitStick(bx, by);
    }

    function startPadPolling() {
        if (padPolling) return;
        padPolling = true;
        requestAnimationFrame(pollPads);
    }

    /* ---------- 9. 按键捕获（设置页「自定义」用） ----------
     * 进入捕获后，下一个键 / 鼠标中右键 / 滚轮方向就是绑定值；Esc 取消。
     * onCancel 用来让调用方把「请按下按键…」这类临时文案还原。 */
    const capture = { active: false, cb: null, onCancel: null };

    function captureStart(cb, onCancel) {
        if (typeof cb !== "function") return;
        capture.active = true;
        capture.cb = cb;
        capture.onCancel = (typeof onCancel === "function") ? onCancel : null;
        document.body.classList.add("is-capturing-binding");
    }

    function captureCancel() {
        if (!capture.active) return;
        const oc = capture.onCancel;
        capture.active = false;
        capture.cb = null;
        capture.onCancel = null;
        document.body.classList.remove("is-capturing-binding");
        if (oc) { try { oc(); } catch (e) { /* 还原失败不影响捕获状态本身 */ } }
    }

    function isCapturing() { return capture.active; }

    function finishCapture(str) {
        const cb = capture.cb;
        captureCancel();
        if (cb) cb(str);
    }

    function captureKey(e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) { captureCancel(); return; }
        const b = { device: "key", key: normalizeKeyName(e.key), mods: {
            ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, meta: !!e.metaKey } };
        // 单独按下修饰键当作「取消」：否则想绑 Shift+A 会先被 Shift 的 keydown 吃掉
        if (["shift", "control", "alt", "meta"].indexOf(b.key) !== -1) return;
        finishCapture(formatBinding(b));
    }

    function capturePointer(e) {
        if (!capture.active) return;
        const btn = MOUSE_NAMES[e.button];
        // 左键在捕获态里是「点按钮」本身（玩家总要能点取消），不当作绑定；
        // 想绑鼠标按键请按中键 / 右键 / 侧键，或滚轮。
        if (!btn || btn === "left") return;
        e.preventDefault();
        e.stopPropagation();
        finishCapture(formatBinding({ device: "mouse", button: btn, index: MOUSE_NAMES.indexOf(btn) }));
    }

    function captureWheel(e) {
        if (!capture.active) return;
        e.preventDefault();
        e.stopPropagation();
        const dir = e.deltaY < 0 ? "up" : (e.deltaY > 0 ? "down" : (e.deltaX < 0 ? "left" : "right"));
        finishCapture(formatBinding({ device: "wheel", dir: dir }));
    }

    /* ---------- 10. 截图 ----------
     * 浏览器没有「截 DOM」的 API，因此这里**按舞台状态重绘一张 PNG**：
     * 背景 + 立绘 + 对话框（框图/纸底、角色名、当前台词）。它是「这一句的定格」，
     * 不是渲染像素的逐点拷贝 —— 与字体渲染、滤镜、圆角等会有差异。
     * 工程若要精确截图或上传服务器，注册一个 Screenshot 处理器（优先级更高）即可覆盖本实现。
     */
    function stageBox() {
        const stage = document.getElementById("stage");
        const page = document.getElementById("page_stage");
        if (!stage || !page) return null;
        const sr = stage.getBoundingClientRect();
        if (!sr.width) return null;
        const scale = sr.width / (stage.offsetWidth || sr.width);
        return { stage: stage, page: page, rect: sr, scale: scale };
    }

    function relRect(el, box) {
        const r = el.getBoundingClientRect();
        return {
            x: (r.left - box.rect.left) / box.scale,
            y: (r.top - box.rect.top) / box.scale,
            w: r.width / box.scale,
            h: r.height / box.scale
        };
    }

    function cssVar(name, fallback) {
        const v = String(global.getComputedStyle(document.documentElement).getPropertyValue(name) || "").trim();
        return v || fallback;
    }

    function urlFromImageValue(v) {
        const m = String(v || "").match(/url\(["']?([^"')]+)["']?\)/);
        return m ? m[1] : "";
    }

    function loadImage(src) {
        return new Promise(resolve => {
            if (!src) { resolve(null); return; }
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }

    // 把一张图按 CSS 的 cover 规则铺满目标矩形
    function drawCover(ctx, img, r) {
        if (!img || !img.naturalWidth || !r.w || !r.h) return;
        const s = Math.max(r.w / img.naturalWidth, r.h / img.naturalHeight);
        const w = img.naturalWidth * s, h = img.naturalHeight * s;
        ctx.drawImage(img, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
    }

    // 逐字符换行（中日韩无空格断词，按字符推进最稳）
    function drawWrapped(ctx, text, x, y, maxW, lineH, maxLines) {
        let line = "", ly = y, lines = 0;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === "\n") {
                ctx.fillText(line, x, ly); ly += lineH; lines++; line = "";
                if (maxLines && lines >= maxLines) return ly;
                continue;
            }
            if (ctx.measureText(line + ch).width > maxW && line) {
                ctx.fillText(line, x, ly); ly += lineH; lines++; line = "";
                if (maxLines && lines >= maxLines) return ly;
            }
            line += ch;
        }
        if (line) { ctx.fillText(line, x, ly); ly += lineH; }
        return ly;
    }

    async function screenshot() {
        const box = stageBox();
        if (!box) return false;
        const W = box.stage.offsetWidth || 1920, H = box.stage.offsetHeight || 1080;
        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d");
        if (!ctx) return false;

        // 1. 背景（.stage-bg 的最上层图）
        const bgEl = box.page.querySelector(".stage-bg");
        const bgUrl = bgEl ? urlFromImageValue(bgEl.style.backgroundImage) : "";
        ctx.fillStyle = cssVar("--overflow-color", "#000");
        ctx.fillRect(0, 0, W, H);
        if (bgUrl) drawCover(ctx, await loadImage(bgUrl), { x: 0, y: 0, w: W, h: H });

        // 2. 立绘 / 整屏图：按 DOM 里的实际位置贴回去（图片已加载，同步可画）
        box.page.querySelectorAll(".stage-char").forEach(node => {
            const r = relRect(node, box);
            const img = node.naturalWidth ? node : null;
            if (img) ctx.drawImage(img, r.x, r.y, r.w, r.h);
        });

        // 3. NVL 整屏旁白
        const nvl = box.page.querySelector(".stage-nvl");
        if (nvl && nvl.classList.contains("is-active")) {
            const r = relRect(nvl, box);
            const cs = global.getComputedStyle(nvl);
            ctx.fillStyle = cs.color || "#333";
            ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
            ctx.textBaseline = "top";
            let y = r.y;
            const lh = parseFloat(cs.fontSize) * 1.5;
            nvl.querySelectorAll(".stage-nvl__line").forEach(line => {
                y = drawWrapped(ctx, line.textContent || "", r.x, y, r.w || W, lh, 0);
            });
        }

        // 4. 对话框：框图（或纸色）+ 角色名 + 台词
        const tb = box.page.querySelector(".textbox");
        if (tb && tb.classList.contains("is-active") && !box.stage.classList.contains("is-ui-hidden")) {
            const r = relRect(tb, box);
            const tbCs = global.getComputedStyle(tb);
            const frameUrl = urlFromImageValue(tbCs.backgroundImage);
            if (frameUrl) {
                drawCover(ctx, await loadImage(frameUrl), r);
            } else {
                ctx.fillStyle = cssVar("--color-paper", "#FAF8F0");
                ctx.fillRect(r.x, r.y, r.w, r.h);
            }
            const nameEl = tb.querySelector(".textbox__name");
            const textEl = tb.querySelector(".textbox__text");
            ctx.textBaseline = "top";
            if (nameEl && nameEl.textContent && global.getComputedStyle(nameEl).display !== "none") {
                const nr = relRect(nameEl, box);
                const nCs = global.getComputedStyle(nameEl);
                ctx.fillStyle = nCs.color || cssVar("--color-accent", "#3B5988");
                ctx.font = `${nCs.fontWeight || ""} ${nCs.fontSize} ${nCs.fontFamily}`;
                ctx.fillText(nameEl.textContent, nr.x, nr.y + Math.max(0, (nr.h - parseFloat(nCs.fontSize)) / 2));
            }
            if (textEl) {
                const tr = relRect(textEl, box);
                const tCs = global.getComputedStyle(textEl);
                const fs = parseFloat(tCs.fontSize) || 22;
                ctx.fillStyle = tCs.color || cssVar("--color-text", "#402000");
                ctx.font = `${tCs.fontWeight || ""} ${tCs.fontSize} ${tCs.fontFamily}`;
                const full = textEl.dataset.full || textEl.textContent || "";
                drawWrapped(ctx, full, tr.x, tr.y, tr.w || (r.w - 40), fs * 1.6, 0);
            }
        }

        // 5. 导出
        const name = ((theme().info || {}).name || "aliceADV") + "_" + shotStamp();
        const blob = await new Promise(res => {
            if (canvas.toBlob) canvas.toBlob(res, "image/png");
            else res(null);
        });
        if (!blob) return false;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name.replace(/[\\/:*?"<>|]/g, "_") + ".png";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        if (global.AliceADVEngine && global.AliceADVEngine.notify) {
            global.AliceADVEngine.notify("已保存截图 " + a.download);
        }
        return true;
    }

    function pad2(n) { return String(n).padStart(2, "0"); }
    function shotStamp() {
        const d = new Date();
        return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    }

    /* ---------- 11. 初始化 ---------- */
    function init() {
        buildRadial();
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("keyup", onKeyUp, true);
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("pointermove", onPointerMove, true);
        document.addEventListener("pointerup", onPointerUp, true);
        document.addEventListener("pointercancel", onPointerUp, true);
        document.addEventListener("wheel", onWheel, { passive: false });
        document.addEventListener("contextmenu", onContextMenu);
        // 捕获态里用鼠标中/右键或滚轮也能绑（左键留给「点按钮」本身）
        document.addEventListener("pointerdown", capturePointer, true);
        document.addEventListener("wheel", captureWheel, { passive: false });
        startPadPolling();
        // 标准 Gamepad API 的连接 / 断开事件（部分浏览器仅靠上面的轮询也能感知，双保险）。
        // engine.js 订阅 onGamepadPresenceChange 来启停「焦点框」导航。
        window.addEventListener("gamepadconnected", function () { setPadPresent(true); });
        window.addEventListener("gamepaddisconnected", function () {
            const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
            let still = false;
            for (let i = 0; i < pads.length; i++) {
                const p = pads[i];
                if (p && p.connected !== false) { still = true; break; }
            }
            if (!still) setPadPresent(false);
        });
        window.addEventListener("blur", () => { captureCancel(); closeRadial(false); });
        // 默认处理器：截图与全屏是引擎能力，不需要页面各自实现
        register("Screenshot", function () { screenshot(); return true; });
        register("Fullscreen", function () {
            const S = global.AliceADVSettings;
            if (!S || !S.isFullscreenSupported || !S.isFullscreenSupported()) return false;
            S.set("displayMode", S.isFullscreen() ? "window" : "fullscreen");
            return true;
        });
    }

    global.AliceADVInput = {
        init: init,
        // 手柄存在检测（engine.js 的焦点框导航据此启停；验证脚本用 _setGamepadForTest 注入）
        gamepadPresent: function () { return padPresent; },
        onGamepadPresenceChange: function (cb) {
            if (typeof cb !== "function") return function () {};
            padListeners.push(cb);
            return function () {
                const i = padListeners.indexOf(cb);
                if (i >= 0) padListeners.splice(i, 1);
            };
        },
        _setGamepadForTest: function (v) { padForced = (v === null) ? null : !!v; setPadPresent(padForced); },
        // 左摇杆模拟量通道（engine.js 的焦点框导航据此做角度选按钮；验证脚本用 _setStickForTest 注入）
        onStickVector: function (cb) {
            if (typeof cb !== "function") return function () {};
            return onStickVector(cb);
        },
        _setStickForTest: function (dx, dy) {
            if (dx === null || dy === null) { stickForced = null; stickEngaged = false; return; }
            stickForced = { dx: +dx || 0, dy: +dy || 0 };
            pollStick([]);            // 立刻按边沿规则处理一次，测试不必等下一帧
        },
        // 动作与绑定
        actions: actions,
        actionLabel: actionLabel,
        presets: presets,
        defaultPreset: defaultPresetId,
        selection: selection,
        setSelection: setSelection,
        bindingsFor: bindingsFor,
        presetBindings: presetBindings,
        conflicts: conflicts,
        parseBinding: parseBinding,
        formatBinding: formatBinding,
        describeBinding: describeBinding,
        describeBindings: describeBindings,
        onBindingsChange: onBindingsChange,
        refresh: refresh,            // 主题 / 预设变化后重建生效绑定表
        // 处理器
        register: register,
        registerAll: registerAll,
        registerAvailability: registerAvailability,
        available: available,
        fire: fire,
        // 按键捕获
        captureStart: captureStart,
        captureCancel: captureCancel,
        isCapturing: isCapturing,
        // 快捷轮盘
        radial: {
            open: openRadial,
            close: function () { closeRadial(false); },
            isOpen: function () { return RADIAL.open; },
            itemAction: radialAction,
            size: radialSize        // { rOut, rIn }：当前生效的几何（来自 radial.css），验证脚本靠它对齐
        },
        // 截图
        screenshot: screenshot
    };
})(window);
