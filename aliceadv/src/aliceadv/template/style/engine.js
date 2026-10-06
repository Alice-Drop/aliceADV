/* =========================================================
 * aliceADV engine — runtime controller
 * 负责：页面切换、按钮交互、舞台缩放、工具栏、游戏内菜单/历史浮层
 * 剧本播放由 script.js (AliceADVScript) 负责，本文件只做调度。
 * ========================================================= */

(function (global) {
    "use strict";

    const PAGES = [
        "page_title", "page_save", "page_load",
        "page_settings", "page_chapters", "page_branches",
        "page_stage", "page_gallery", "page_about"
    ];

    /* 菜单页组：保存 / 读取 / 设置 / 章节 / 分支 / 画廊 / 关于。
     * 这些页共享同一套侧边栏，内部标签切换**不构成「导航历史」**——
     * 菜单内的「返回」应当一次性关闭整个菜单、回到进入菜单前的那一页（首页或舞台），
     * 而不是在标签页之间挨个回退（那是之前的 bug）。标题页与舞台不属于菜单组。 */
    const MENU_PAGES = [
        "page_save", "page_load", "page_settings",
        "page_chapters", "page_branches", "page_gallery", "page_about"
    ];

    /* 设计分辨率**不在这里写死**：它来自 theme.json 的 screen.designWidth / designHeight，
     * 由 theme.js 写入 CSS 变量 --design-w / --design-h，并作用在 #stage 的 width/height 上。
     * fitStage() 直接量 #stage 的布局尺寸即可，这样设计分辨率只有一份来源。 */

    const state = {
        currentPage: "page_title",
        history: [],
        // 进入菜单组前的那一页（首页或舞台）。从菜单组**外**跳进某个菜单页时记下，
        // 离开菜单组时清空；组内部标签切换不改它。供「返回」键一次性关闭整个菜单。
        menuOrigin: null
    };

    /* ---------- 手柄焦点框导航 ----------
     * 仅在识别到手柄（input.js 的 gamepad 存在事件）时启用。开始界面 / 菜单页的按钮
     * 会被圈住一个候选框，方向键 / 左摇杆切换，按 A（Confirm）点击当前选中项，
     * 否则手柄用户进不了游戏。舞台播放期间（page_stage）与浮层 / 选项列表打开时自动停用。
     * 设计要点：presence（手柄是否连着）与可见（当前能不能画框）分开——
     * 手柄连着但正处于舞台 / 浮层时只是「不画框」，连接状态仍保留，回到菜单页自动续上。 */
    const Focus = (function () {
        const FOCUSABLE = "[data-script], [data-resume], [data-page], [data-action], .title-custom-btn, .paper-btn";
        let active = false;     // 手柄已连接：焦点导航可用
        let target = null;      // 当前被圈住的按钮
        let items = [];         // 当前页可聚焦元素
        let customMode = false; // 当前页是否「热区 / 自定义按钮」模式（其余一律按声明顺序直下）

        // 是否允许在当前状态画焦点框 / 响应导航
        function canFocus() {
            if (state.currentPage === "page_stage") return false;
            if (anyOverlayOpen()) return false;
            const ch = document.querySelector(".choices");
            if (ch && ch.offsetParent) return false;   // 舞台上的选项列表由 MenuUp/Down 处理
            return true;
        }
        function pageEl() { return document.getElementById(state.currentPage); }
        function collect() {
            const root = pageEl();
            items = [];
            if (!root) return;
            items = Array.prototype.slice.call(root.querySelectorAll(FOCUSABLE)).filter(el => {
                if (el.classList.contains("is-insensible")) return false;
                if (el.disabled) return false;
                if (!el.offsetParent) return false;            // 隐藏元素不可聚焦
                return true;
            });
            // 判定模式：若当前页所有可聚焦元素都是 .title-custom-btn（热区 / 自定义按钮），
            // 走「声明坐标几何」导航；否则（按钮列表 / 侧栏）走「声明顺序直下」。
            customMode = items.length > 0 && items.every(el => el.classList.contains("title-custom-btn"));
            if (customMode) {
                // 加载时把每个按钮的声明坐标（left/top/width/height，0~1 相对页面、构建期翻成百分比）
                // 解析成中心，作为几何移动的稳定依据（不随渲染抖动）。
                items.forEach(el => { const c = centerFromDecl(el); el._focusCx = c.cx; el._focusCy = c.cy; });
            }
        }
        // 从内联样式取声明坐标中心（百分比，0~100，相对全屏容器）。
        // 宽高给了百分比就直接算；给了 auto 则回落到渲染中心。
        function centerFromDecl(el) {
            const pct = s => { const v = parseFloat(el.style[s]); return isNaN(v) ? null : v; };
            const left = pct("left") || 0, top = pct("top") || 0;
            const w = pct("width"), h = pct("height");
            if (w != null && h != null) return { cx: left + w / 2, cy: top + h / 2 };
            const r = el.getBoundingClientRect();
            return {
                cx: (r.left + r.width / 2) / window.innerWidth * 100,
                cy: (r.top + r.height / 2) / window.innerHeight * 100
            };
        }
        function clearFrame() { if (target) { target.classList.remove("is-focus"); target = null; } }
        function setTarget(el) {
            if (target === el) return;
            if (target) target.classList.remove("is-focus");
            target = el || null;
            if (target) target.classList.add("is-focus");
        }
        // 刷新可见性：根据 active + canFocus 决定画不画框
        function refresh() {
            if (!active) { clearFrame(); document.body.classList.remove("is-gamepad-focus"); return; }
            document.body.classList.add("is-gamepad-focus");
            if (!canFocus()) { clearFrame(); return; }
            collect();
            if (!items.length) { clearFrame(); return; }
            if (!target || items.indexOf(target) < 0) setTarget(items[0]);
        }
        function activate() { active = true; refresh(); }
        function deactivate() { active = false; refresh(); }
        function onPageChange() { if (!active) return; refresh(); }
        function move(dir) {
            if (!active || !canFocus()) return false;
            if (!items.length) return false;
            if (!target || items.indexOf(target) < 0) { setTarget(items[0]); return !!target; }
            const idx = items.indexOf(target);
            if (customMode) return moveCustom(dir, idx);   // 热区 / 自定义按钮：声明坐标几何移动
            // 普通模式：按按钮声明顺序一路往下（down / right = +1，up / left = -1），不绕回
            let next = -1;
            if (dir === "down" || dir === "right") next = idx + 1;
            else if (dir === "up" || dir === "left") next = idx - 1;
            if (next >= 0 && next < items.length) { setTarget(items[next]); return true; }
            return false;
        }
        // 热区 / 自定义按钮模式：用加载时算好的声明坐标中心做几何移动，
        // 选出该方向上主轴距离最近、跨轴偏移最小的那个按钮。
        function moveCustom(dir, idx) {
            const t = items[idx];
            const x0 = t._focusCx, y0 = t._focusCy;
            let best = null, bestScore = Infinity;
            for (let i = 0; i < items.length; i++) {
                if (i === idx) continue;
                const el = items[i];
                const dx = el._focusCx - x0, dy = el._focusCy - y0;
                let ok = false, primary = 0, secondary = 0;
                if (dir === "down")       { ok = dy > 0.5;  primary = dy;  secondary = Math.abs(dx); }
                else if (dir === "up")    { ok = dy < -0.5; primary = -dy; secondary = Math.abs(dx); }
                else if (dir === "right") { ok = dx > 0.5;  primary = dx;  secondary = Math.abs(dy); }
                else if (dir === "left")  { ok = dx < -0.5; primary = -dx; secondary = Math.abs(dy); }
                if (!ok) continue;
                const score = primary + secondary * 2;   // 主轴距离 + 跨轴惩罚，选出最贴合方向的按钮
                if (score < bestScore) { bestScore = score; best = el; }
            }
            if (best) { setTarget(best); return true; }
            return false;
        }
        function confirm() {
            if (!active || !canFocus()) return false;
            if (!target) return false;
            target.click();   // 走统一的 onClick 代理（data-script / data-page / data-action …）
            return true;
        }
        /* 摇杆导航：按「摇杆方向」与「当前候选 → 各候选连线方向」的夹角选按钮。
         * 摇杆比十字键多一维自由度（连续角度），所以不再量化成四向，而是真做坐标运算：
         * 例如从 start 往右下 45° 推，preference 的连线方向与摇杆方向只差 ~30°，
         * 而 load 差了 >45°，于是落到 preference —— 这是十字键（只有四向）做不到的。
         * 两种页面模式统一按「屏幕像素坐标」算连线方向：普通模式是纵向列表，
         * 上下推自然落到相邻项；热区模式是散点布局，按角度就近。 */
        function moveVector(dx, dy) {
            if (!active || !canFocus()) return false;
            if (!items.length) return false;
            if (!target || items.indexOf(target) < 0) { setTarget(items[0]); return !!target; }
            if (Math.hypot(dx, dy) < 1e-6) return false;
            const stickAng = Math.atan2(dy, dx);              // 摇杆方向（屏幕坐标，y 向下）
            const r0 = target.getBoundingClientRect();
            const x0 = r0.left + r0.width / 2, cy0 = r0.top + r0.height / 2;
            // 收集「大致在摇杆那一侧」的候选（夹角 ≤ 90°，正后方的不选）
            const cands = [];
            for (const el of items) {
                if (el === target) continue;
                const r = el.getBoundingClientRect();
                const vx = r.left + r.width / 2 - x0, vy = r.top + r.height / 2 - cy0;
                const dist = Math.hypot(vx, vy);
                if (dist < 1e-6) continue;
                // 连线方向与摇杆方向的夹角，规约到 [0, π]
                let ang = Math.abs(Math.atan2(vy, vx) - stickAng);
                if (ang > Math.PI) ang = Math.PI * 2 - ang;
                if (ang > Math.PI / 2) continue;
                cands.push({ el, ang, dist });
            }
            if (!cands.length) return false;
            // 择一：角度小者胜；角度几乎相同（±4°，视为同一射线上的前后两个）则距离近者胜
            let best = cands[0];
            for (let i = 1; i < cands.length; i++) {
                const c = cands[i], d = c.ang - best.ang;
                if (Math.abs(d) < 0.07 ? c.dist < best.dist : d < 0) best = c;
            }
            setTarget(best.el);
            return true;
        }
        return { activate, deactivate, onPageChange, move, moveVector, confirm,
            isActive: () => active, target: () => target, items: () => items.slice() };
    })();

    /* ---------- 游戏内浮层（菜单 / 历史） ---------- */
    function openOverlay(id) {
        const n = document.getElementById(id);
        if (n) n.classList.add("is-active");
    }
    function closeOverlays() {
        document.querySelectorAll(".ingame-overlay").forEach(n => n.classList.remove("is-active"));
    }
    function anyOverlayOpen() {
        return !!document.querySelector(".ingame-overlay.is-active");
    }
    function openHistory() {
        // 关闭其它浮层（尤其是游戏内菜单栏），避免叠层
        closeOverlays();
        if (global.AliceADVScript) global.AliceADVScript.renderHistory();
        openOverlay("overlay_history");
    }

    function showPage(name, opts) {
        if (!name) return;
        // 兼容 "settings" / "page_settings" 两种入参
        const id = name.startsWith("page_") ? name : "page_" + name;
        if (!PAGES.includes(id)) return;
        const prev = state.currentPage;
        if (!(opts && opts.noPush) && id !== state.currentPage) state.history.push(state.currentPage);
        PAGES.forEach(p => {
            const node = document.getElementById(p);
            if (!node) return;
            node.classList.toggle("is-active", p === id);
        });
        state.currentPage = id;
        // 切页后刷新焦点框（手柄连着时自动把框移到新页的候选按钮）
        Focus.onPageChange();
        // 「隐藏 UI」是舞台上的临时视图状态，不是跨页偏好：离开舞台就复位（见 toggleUI）
        if (id !== "page_stage") resetUI();

        // 记录菜单组入口：从菜单组**外**进入某菜单页时记下入口页（首页 / 舞台），
        // 离开菜单组时清空；组内部标签页切换不改它。供「返回」一次性关闭整个菜单。
        const prevWasMenu = MENU_PAGES.includes(prev);
        const idIsMenu = MENU_PAGES.includes(id);
        if (idIsMenu && !prevWasMenu) state.menuOrigin = prev;
        else if (!idIsMenu && prevWasMenu) state.menuOrigin = null;

        // 运行时预加载：切换页面后台预载目标页背景（info.json preload.runtime 含 "page" 时生效，不阻塞切换）
        if (global.AliceADVPreload && global.AliceADVTheme) {
            global.AliceADVPreload.hookPage(id, global.AliceADVTheme.getTheme(), global.AliceADVTheme.getCatalog());
        }

        // 进入存档 / 读档页时刷新槽位内容（读取 localStorage 最新状态）
        if ((id === "page_save" || id === "page_load") && global.AliceADVTheme && global.AliceADVTheme.renderSlots) {
            global.AliceADVTheme.renderSlots();
        }

        // 退出播放（离开舞台回到首页/章节选择）→ 清空历史记录
        if (prev === "page_stage" && (id === "page_title" || id === "page_chapters")) {
            if (global.AliceADVScript && global.AliceADVScript.isPlaying()) {
                global.AliceADVScript.exit();
            }
        }
        // 离开舞台时收起浮层与通知条
        // （通知条本来 1.6s 后自己消失；若这期间又回到舞台，会看到上一条消息的残影）
        if (prev === "page_stage" && id !== "page_stage") {
            closeOverlays();
            clearNotify();
        }
    }

    function goBack() {
        // 菜单页内的「返回」= 关闭整个菜单，回到进入菜单前的那一页（首页或舞台），
        // 而不是在标签页之间挨个后退。
        // 做法：从 history 末尾往前跳过所有菜单页，落到第一个非菜单页；若 history 里已无
        // （极少，菜单被当作初始页打开），回退到记录的入口或首页。这样无论组内访问过多少
        // 个标签，一次返回都直接出菜单。
        if (MENU_PAGES.includes(state.currentPage)) {
            let entry = null;
            while (state.history.length) {
                const top = state.history.pop();
                if (!MENU_PAGES.includes(top)) { entry = top; break; }
            }
            state.menuOrigin = null;
            showPage(entry || state.menuOrigin || "page_title", { noPush: true });
            return;
        }
        if (state.history.length) {
            showPage(state.history.pop(), { noPush: true });
        }
    }

    function showPopup(id) {
        const p = document.getElementById(id);
        if (p) p.classList.add("is-active");
        Focus.onPageChange();   // 浮层打开时收起焦点框，关闭后再续上
    }
    function hidePopup(id) {
        const p = document.getElementById(id);
        if (p) p.classList.remove("is-active");
        Focus.onPageChange();
    }
    let saveToastTimer = null;
    function showSaveToast() {
        showPopup("popup_saveToast");
        if (saveToastTimer) clearTimeout(saveToastTimer);
        saveToastTimer = setTimeout(() => hidePopup("popup_saveToast"), 1600);
    }

    /* ---------- 通知条 / 快进指示条（对应 Ren'Py notify / skip_indicator） ----------
     * 这两个元素由 theme.js 的 buildStagePage() 随舞台骨架建好，这里**不创建 DOM**：
     * 舞台重建（换主题 / 重新 buildAll）会清空 #page_stage，自建的节点留不下来；
     * 骨架每次重建都会带上它们，所以只在既有节点上切 .is-active 与文字最稳。
     * 纵向位置由 theme.json 的 notifyYpos / skipYpos 决定（CSS 读 --notify-ypos / --skip-ypos）。
     */
    let notifyTimer = null;

    /* 弹一条会在 ms（默认 1600）后自动消失的通知。循环调用时以最后一次为准（不排队）。 */
    function notify(text, ms) {
        const host = document.querySelector("#page_stage .notify");
        const inner = host && host.querySelector(".notify__inner");
        const msg = (text == null) ? "" : String(text);
        if (!inner || !msg) return false;   // 无元素（舞台尚未搭好）或空文案 → 不显示空衬底
        inner.textContent = msg;
        host.classList.add("is-active");
        if (notifyTimer) clearTimeout(notifyTimer);
        notifyTimer = setTimeout(
            () => host.classList.remove("is-active"),
            (typeof ms === "number" && ms > 0) ? ms : 1600
        );
        return true;
    }

    function clearNotify() {
        if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }
        const host = document.querySelector("#page_stage .notify");
        if (host) host.classList.remove("is-active");
    }

    /* 快进指示条的显隐是 state.skip 的纯函数。唯一调用方是 script.js 的
     * syncPlaybackMode()（setSkip / setAuto / stopPlayback 都汇到那里），
     * 因此这里不判断播放状态、也不自己维护标志位。 */
    function setSkipIndicator(on) {
        const host = document.querySelector("#page_stage .skip-indicator");
        if (!host) return false;
        host.classList.toggle("is-active", !!on);
        return true;
    }

    /* ---------- 1. 统一按钮事件代理 ---------- */
    function onClick(e) {
        const target = e.target.closest("[data-script], [data-resume], [data-page], [data-action], [data-popup-confirm], [data-popup-cancel], [data-slot-kind], .chapter-item, .branch-item, .gallery-item");
        if (!target) return;

        // 剧本播放（章节条目 / 开始游戏按钮绑定了 data-script）
        if (target.dataset.script && !target.classList.contains("is-locked")) {
            if (global.AliceADVScript) global.AliceADVScript.start(target.dataset.script);
            return;
        }

        // 游戏内菜单/历史浮层的返回按钮：退出浮层，继续在舞台播放
        if (target.dataset.resume) {
            closeOverlays();
            return;
        }

        // 页面跳转
        if (target.dataset.page) {
            showPage(target.dataset.page);
            return;
        }

        // 自定义动作
        if (target.dataset.action === "history") {
            openHistory();
            return;
        }
        if (target.dataset.action === "quit") {
            showPopup("popup_quitQuery");
            return;
        }
        if (target.dataset.action === "continue") {
            // 首页「继续」：从自动存档恢复进度（自动存档关闭或无存档时按钮已置灰、点击无效）
            const S = global.AliceADVScript;
            if (S && S.loadAuto) S.loadAuto();
            return;
        }
        if (target.dataset.action === "back") {
            // 侧边栏「返回」：在菜单页内 = 一次性关闭整个菜单，回到进入菜单前的那一页
            // （首页或舞台）；非菜单页时退回上一页（goBack 已按当前页区分）。
            goBack();
            return;
        }

        // 浮层确认
        if (target.dataset.popupConfirm != null) {
            hidePopup("popup_quitQuery");
            console.info("[aliceADV] quit confirmed");
            return;
        }
        if (target.dataset.popupCancel != null) {
            hidePopup("popup_quitQuery");
            return;
        }
        // 保存成功提示
        if (target.dataset.popupSaveOk != null) {
            hidePopup("popup_saveToast");
            return;
        }

        // 存档槽（系统槽 auto / quick 不参与手动覆盖，普通槽按 kind+index 存取）
        if (target.dataset.slotKind != null) {
            const kind = target.dataset.slotKind;
            const idx = target.dataset.slotIndex != null ? Number(target.dataset.slotIndex) : 0;
            const script = global.AliceADVScript;
            if (state.currentPage === "page_save") {
                // 自动 / 快速槽为系统管理，手动保存不可覆盖（点击忽略）
                if (kind === "auto" || kind === "quick") return;
                const ok = script && script.saveManual(idx);
                if (global.AliceADVTheme && global.AliceADVTheme.renderSlots) global.AliceADVTheme.renderSlots();
                if (ok) showSaveToast();
            } else if (state.currentPage === "page_load") {
                const data = (script && script.getSave) ? script.getSave(kind, idx) : null;
                // load() 是 async，返回是否真的读成功 —— 只有成功才给通知。
                // 若无条件通知，则「关掉自动存档后点空槽」这类失败也会弹一条成功提示。
                if (data && script) {
                    script.load(kind, idx).then(ok => { if (ok) notify("已读取存档"); });
                }
            }
            return;
        }

        // 章节 / 分支（无剧本文件时退回旧行为：直接进舞台）
        if (target.classList.contains("chapter-item") || target.classList.contains("branch-item")) {
            if (target.classList.contains("is-locked")) return;
            showPage("page_stage");
            return;
        }

        // 画廊
        if (target.classList.contains("gallery-item")) {
            if (target.classList.contains("is-locked")) return;
            return;
        }
    }

    /* ---------- 2. 工具栏（舞台底部 quick menu） ----------
     * 工具栏只是动作的**第二个入口**：按钮 → 动作 → 处理器，与按键 / 手柄 / 轮盘走同一条链。
     * 于是「快存」按钮与 F5 的行为永远同源，不存在两套实现（以前是两套：这里一套、
     * 键盘那套根本不存在）。按钮顺序仍由 theme.json 的 pages.stage.toolbar 决定。 */
    const TOOL_ACTIONS = {
        menu: "OpenMenu", history: "History", back: "Rollback",
        auto: "Auto", skip: "SkipRead",
        save: "OpenSave", load: "OpenLoad", qsave: "QuickSave", qload: "QuickLoad"
    };

    function onToolbarClick(e) {
        const btn = e.target.closest("[data-tool]");
        if (!btn) return;
        const I = global.AliceADVInput;
        const act = TOOL_ACTIONS[btn.dataset.tool];
        if (act && I) I.fire(act);
    }

    function el(tag, attrs, children) {
        const node = document.createElement(tag);
        if (attrs) for (const k in attrs) {
            if (k === "class") node.className = attrs[k];
            else if (k === "text") node.textContent = attrs[k];
            else node.setAttribute(k, attrs[k]);
        }
        if (children) (Array.isArray(children) ? children : [children]).forEach(c => {
            if (c == null) return;
            if (typeof c === "string") node.appendChild(document.createTextNode(c));
            else node.appendChild(c);
        });
        return node;
    }

    /* ---------- 隐藏 / 显示 UI（动作 HideUI） ----------
     * 只加一个类，#stage 上的显示/隐藏细则写在 pages/stage.css。
     * 状态**不持久化**：它是「看一眼立绘」的临时动作，不是偏好；离开舞台即复位。
     * 与 Ren'Py 的 hide_windows 一致：再按一次才恢复，点击画面不会自动恢复。 */
    function toggleUI() {
        const stage = document.getElementById("stage");
        if (!stage) return false;
        stage.classList.toggle("is-ui-hidden");
        return true;
    }
    function resetUI() {
        const stage = document.getElementById("stage");
        if (stage) stage.classList.remove("is-ui-hidden");
    }
    function isUIHidden() {
        const stage = document.getElementById("stage");
        return !!(stage && stage.classList.contains("is-ui-hidden"));
    }

    /* 工具栏按钮的选中态是「自动 / 跳过」的纯视图。唯一调用方是剧本运行时的
     * syncPlaybackMode()（setAuto / setSkip / setSkipRead / setSkipAll / stopPlayback
     * 都汇到那里），因此这里不判断播放状态、也不自己维护标志位 —— 与 setSkipIndicator 同理。 */
    function syncToolbar() {
        const S = global.AliceADVScript;
        const root = document.getElementById("page_stage");
        if (!root || !S) return false;
        const paint = function (tool, on) {
            const b = root.querySelector('.toolbar__btn[data-tool="' + tool + '"]');
            if (b) b.classList.toggle("is-active", !!on);
        };
        paint("skip", !!S.state.skip);
        paint("auto", !!S.state.auto);
        return true;
    }

    /* ---------- 0. 舞台等比缩放 ----------
     * #stage 的宽高就是 theme.json 的 screen.designWidth × designHeight
     * （theme.js 写 --design-w / --design-h，base.css 里 #stage 用这两个变量定尺寸）。
     * 这里量它的布局尺寸作为缩放基准，不再各存一份 1920×1080 常量——
     * 否则作者把 designWidth 改成 1280 时，CSS 侧按 1280 排、这里却按 1920 缩，画面会整体放大并被裁掉。
     * offsetWidth/offsetHeight 取的是布局尺寸（不含 transform），正是我们要的基准。
     */
    function fitStage() {
        const frame = document.getElementById("game-frame");
        const stage = document.getElementById("stage");
        if (!frame || !stage) return;
        const w = stage.offsetWidth || 1920;   // 兜底：主题未就绪时用引擎默认设计宽度
        const h = stage.offsetHeight || 1080;
        const scale = Math.min(frame.clientWidth / w, frame.clientHeight / h);
        stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
    }

    /* ---------- 3. 输入动作接线（input.js） ----------
     * 页面级动作：菜单 / 存档 / 读档 / 设置 / 画廊 / 历史 / 隐藏 UI / 取消 / 确认。
     * 剧情级动作（下一句 / 回退 / 快进 / 选项导航…）由 script.js 注册，两边合起来才是全集。
     *
     * 为什么「点击画面推进」不再单独挂 click 监听：那是鼠标左键 = Advance 这个默认绑定的
     * 一种表现。两处都做的话，同一次点击会推进两次 —— 事件翻译只留输入系统一处。
     */
    function confirmPopup() {
        /* 「有没有东西可确认」的判据是浮层**开着**（.is-active），不是 DOM 里存不存在那个按钮。
         * theme.js 的 buildPopup() 会在启动时就把退出确认框建好、常驻页面（只是不加 .is-active），
         * 因此 `#popup_quitQuery [data-popup-confirm]` 永远查得到。若照着点下去，回车/空格就会
         * 「确认」一个根本没打开的框：本处理器返回 true 把事件吃掉，而 Advance 优先级更低、
         * 排在它后面，永远轮不到 —— 表现为回车完全无法推进剧情。 */
        const popups = document.querySelectorAll(".popup.is-active");
        for (let i = 0; i < popups.length; i++) {
            const btn = popups[i].querySelector("[data-popup-confirm]");
            if (!btn) continue;
            btn.click();
            return true;
        }
        return false;
    }

    function openHistoryForPlay() {
        const S = global.AliceADVScript;
        if (!S || !S.isPlaying()) return false;
        openHistory();
        return true;
    }

    function bindInputActions() {
        const I = global.AliceADVInput;
        if (!I) {
            console.warn("[aliceADV] 输入系统未加载（style/input.js），按键与工具栏动作不可用");
            return;
        }
        I.registerAll({
            /* 返回 / 取消（默认绑定 Esc，手柄 B）：优先级最高的一类。
             * 顺序：轮盘 → 弹窗 → 通知 → 浮层 →（菜单页等）上一页。
             * 舞台上**没有可取消的东西就返回 false**：Esc 会落到同绑的 OpenMenu（开菜单浮层），
             * 手柄 B 会落到 HideUI（隐藏 UI）—— 靠优先级分层，一个键在「有东西可退」时是返回、
             * 在舞台上是各自的舞台功能。此前这里在舞台里 toggle 菜单浮层，导致手柄 B 一按就弹菜单。 */
            Cancel: function () {
                if (I.radial.isOpen()) { I.radial.close(); return true; }
                const popup = document.getElementById("popup_quitQuery");
                if (popup && popup.classList.contains("is-active")) { hidePopup("popup_quitQuery"); return true; }
                const toast = document.getElementById("popup_saveToast");
                if (toast && toast.classList.contains("is-active")) { hidePopup("popup_saveToast"); return true; }
                if (anyOverlayOpen()) { closeOverlays(); return true; }
                if (state.currentPage === "page_stage") return false;
                if (state.history.length) { goBack(); return true; }
                return false;
            },
            // 确认：只在「确实有可确认的东西」时消费 —— 队列确认框。
            // 返回 false 时回车会落到「下一句」（选项的确认由 script.js 的处理器负责）。
            Confirm: function () { return confirmPopup(); },
            OpenMenu: function () {
                if (state.currentPage !== "page_stage") return false;
                const S = global.AliceADVScript;
                if (!S || !S.isPlaying()) return false;
                const hist = document.getElementById("overlay_history");
                if (hist) hist.classList.remove("is-active");
                const m = document.getElementById("overlay_menu");
                if (!m) return false;
                m.classList.toggle("is-active");
                return true;
            },
            History: openHistoryForPlay,
            OpenLog: openHistoryForPlay,
            OpenSave:     function () { showPage("page_save"); return true; },
            OpenLoad:     function () { showPage("page_load"); return true; },
            OpenSettings: function () { showPage("page_settings"); return true; },
            OpenGallery:  function () { showPage("page_gallery"); return true; },
            QuickSave: function () {
                const S = global.AliceADVScript;
                if (!S || !S.isPlaying()) { notify("不在剧情中，无法快速保存"); return true; }
                if (S.saveQuick()) showSaveToast();
                else notify("快速保存失败（功能已关闭或无进度）");
                return true;
            },
            QuickLoad: function () {
                const S = global.AliceADVScript;
                if (!S) return false;
                S.loadQuick().then(ok => notify(ok ? "已读取快速存档" : "没有可读取的快速存档"));
                return true;
            },
            HideUI: function () {
                if (state.currentPage !== "page_stage") return false;
                return toggleUI();
            },
            // 手柄方向键 / 左摇杆：移动焦点框。焦点未启用（没连手柄 / 在舞台 / 浮层开着）时返回假值，
            // 把方向输入放行给 MenuUp/Down（列表导航）或 Auto / History / 快存快读（舞台功能）。
            NavUp:    function () { return Focus.move("up"); },
            NavDown:  function () { return Focus.move("down"); },
            NavLeft:  function () { return Focus.move("left"); },
            NavRight: function () { return Focus.move("right"); }
        });

        // 焦点确认：手柄 A（Confirm）在焦点框启用时点击当前选中项，优先级高于 confirmPopup，
        // 否则回车 / A 会落到「下一句」或队列确认框。焦点未启用时返回假值放行。
        I.register("Confirm", function () { return Focus.confirm(); }, { priority: 100 });

        // 可用性：径向菜单据此置灰；同时也是「这个动作现在有没有意义」的唯一判据
        const S = () => global.AliceADVScript;
        I.registerAvailability("OpenMenu", () => state.currentPage === "page_stage" && !!(S() && S().isPlaying()));
        I.registerAvailability("History", () => !!(S() && S().isPlaying()));
        I.registerAvailability("OpenLog", () => !!(S() && S().isPlaying()));
        I.registerAvailability("HideUI", () => state.currentPage === "page_stage");
        I.registerAvailability("QuickSave", () => !!(S() && S().isPlaying() && (!S().quickSaveEnabled || S().quickSaveEnabled())));
        I.registerAvailability("QuickLoad", () => !!(S() && (!S().quickSaveEnabled || S().quickSaveEnabled())
            && S().getSave && S().getSave("quick", 0)));
    }

    /* ---------- 5. 初始化 ---------- */
    function init() {
        // 事件代理
        document.addEventListener("click", onClick);
        // 工具栏（独立 listener 因为不通过 data-page）
        document.addEventListener("click", e => {
            if (e.target.closest(".toolbar__btn")) onToolbarClick(e);
        });

        // 舞台等比缩放：初始化 + 窗口变化时重新计算
        fitStage();
        window.addEventListener("resize", fitStage);
        resetUI();

        /* 「点击画面推进」与「Esc 返回」都改由输入系统分发（input.js 的鼠标/键盘绑定），
         * 这里不再挂 stage click / document keydown 监听 —— 见 bindInputActions 的说明。 */
        bindInputActions();

        // 手柄连接 / 断开 → 启停焦点框导航（input.js 在 gamepad 存在状态变化时回调）
        const I2 = global.AliceADVInput;
        if (I2 && I2.onGamepadPresenceChange) {
            I2.onGamepadPresenceChange(present => { if (present) Focus.activate(); else Focus.deactivate(); });
        }
        // 左摇杆 → 焦点框导航（input.js 越过死区的那一下回调，带连续方向向量）
        if (I2 && I2.onStickVector) {
            I2.onStickVector(v => { Focus.moveVector(v.dx, v.dy); });
        }
    }

    global.AliceADVEngine = {
        init, showPage, goBack, showPopup, hidePopup, state,
        // 浮层控制：供输入系统与工程自定义 UI 使用（此前是模块内部函数）
        openOverlay, closeOverlays, anyOverlayOpen, openHistory,
        // 通知条（Ren'Py renpy.notify 的对应物）：公开给剧本 / 工程自定义 UI 调用。
        // 位置由 theme.json 的 notifyYpos 决定。
        notify, clearNotify,
        // 快进指示条：由 script.js 的 syncPlaybackMode() 按 state.skip 驱动，
        // 工程一般不必直接调用（避免出现第二个真值源）。
        setSkipIndicator,
        // 工具栏选中态：同上，由 syncPlaybackMode() 统一同步
        syncToolbar,
        // 隐藏 / 显示 UI（动作 HideUI 的实现；工程自定义 UI 也可调用）
        toggleUI, resetUI, isUIHidden,
        // 手柄焦点框导航（验证脚本据此注入手柄状态 / 检查选中项）
        focus: Focus
    };
})(window);
