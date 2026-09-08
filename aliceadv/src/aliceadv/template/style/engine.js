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

    const DESIGN_W = 1920;
    const DESIGN_H = 1080;

    const state = {
        currentPage: "page_title",
        history: []
    };

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

    function showPage(name) {
        if (!name) return;
        // 兼容 "settings" / "page_settings" 两种入参
        const id = name.startsWith("page_") ? name : "page_" + name;
        if (!PAGES.includes(id)) return;
        const prev = state.currentPage;
        if (id !== state.currentPage) state.history.push(state.currentPage);
        PAGES.forEach(p => {
            const node = document.getElementById(p);
            if (!node) return;
            node.classList.toggle("is-active", p === id);
        });
        state.currentPage = id;

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
        // 离开舞台时收起浮层
        if (prev === "page_stage" && id !== "page_stage") closeOverlays();
    }

    function goBack() {
        if (state.history.length) {
            showPage(state.history.pop());
        }
    }

    function showPopup(id) {
        const p = document.getElementById(id);
        if (p) p.classList.add("is-active");
    }
    function hidePopup(id) {
        const p = document.getElementById(id);
        if (p) p.classList.remove("is-active");
    }
    let saveToastTimer = null;
    function showSaveToast() {
        showPopup("popup_saveToast");
        if (saveToastTimer) clearTimeout(saveToastTimer);
        saveToastTimer = setTimeout(() => hidePopup("popup_saveToast"), 1600);
    }

    /* ---------- 1. 统一按钮事件代理 ---------- */
    function onClick(e) {
        const target = e.target.closest("[data-script], [data-resume], [data-page], [data-action], [data-popup-confirm], [data-popup-cancel], [data-slot-index], .chapter-item, .branch-item, .gallery-item");
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

        // 存档槽
        if (target.dataset.slotIndex != null) {
            const idx = target.dataset.slotIndex;
            const script = global.AliceADVScript;
            if (state.currentPage === "page_save") {
                const ok = script && script.save(idx);
                if (global.AliceADVTheme && global.AliceADVTheme.renderSlots) global.AliceADVTheme.renderSlots();
                if (ok) showSaveToast();
            } else if (state.currentPage === "page_load") {
                if (!target.classList.contains("is-empty") && script) {
                    script.load(idx);
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

    /* ---------- 2. 工具栏（舞台底部 quick menu） ---------- */
    function onToolbarClick(e) {
        const btn = e.target.closest("[data-tool]");
        if (!btn) return;
        const tool = btn.dataset.tool;
        const script = global.AliceADVScript;
        switch (tool) {
            case "menu":
                // 菜单 = 暂停，打开右侧菜单栏（同 ESC）
                document.getElementById("overlay_history").classList.remove("is-active");
                document.getElementById("overlay_menu").classList.toggle("is-active");
                break;
            case "history":
                // 历史记录浮层（播放中的台词实时写入，退出播放即清空）
                openHistory();
                break;
            case "back":
                // 后退一句
                if (script) script.rollback();
                break;
            case "auto":
                if (script) btn.classList.toggle("is-active", script.setAuto(!script.state.auto));
                break;
            case "skip":
                if (script) btn.classList.toggle("is-active", script.setSkip(!script.state.skip));
                break;
            case "save":  showPage("page_save");     break;
            case "load":  showPage("page_load");     break;
            case "qsave": if (script) { const ok = script.save(0); if (ok) showSaveToast(); } break;
            case "qload": if (script) script.load(0); break;
        }
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

    /* ---------- 0. 舞台等比缩放 ----------
     * #stage 固定 1920×1080 设计分辨率，按窗口大小整体缩放，
     * 保持 16:9 比例并居中，溢出区域由 #game-frame 的背景色填充。
     */
    function fitStage() {
        const frame = document.getElementById("game-frame");
        const stage = document.getElementById("stage");
        if (!frame || !stage) return;
        const scale = Math.min(frame.clientWidth / DESIGN_W, frame.clientHeight / DESIGN_H);
        stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
    }

    /* ---------- 5. 初始化 ---------- */
    function init() {
        // 事件代理
        document.addEventListener("click", onClick);
        // 工具栏（独立 listener 因为不通过 data-page）
        document.addEventListener("click", e => {
            if (e.target.closest(".toolbar__btn")) onToolbarClick(e);
        });

        // 舞台点击推进剧本（点击对话框/空白处 = 下一句）
        // 工具栏、选项、浮层内的点击不触发推进。
        const stageEl = document.getElementById("page_stage");
        if (stageEl) {
            stageEl.addEventListener("click", e => {
                if (e.target.closest(".toolbar, .choices, .ingame-overlay, .notify")) return;
                if (global.AliceADVScript) global.AliceADVScript.next();
            });
        }

        // ESC：优先关浮层；播放中 = 打开/关闭菜单（同定义.md）；否则返回上一页
        document.addEventListener("keydown", e => {
            if (e.key !== "Escape") return;
            const popup = document.getElementById("popup_quitQuery");
            if (popup && popup.classList.contains("is-active")) {
                hidePopup("popup_quitQuery");
                return;
            }
            const toast = document.getElementById("popup_saveToast");
            if (toast && toast.classList.contains("is-active")) {
                hidePopup("popup_saveToast");
                return;
            }
            if (anyOverlayOpen()) { closeOverlays(); return; }
            if (state.currentPage === "page_stage" &&
                global.AliceADVScript && global.AliceADVScript.isPlaying()) {
                document.getElementById("overlay_menu").classList.toggle("is-active");
                return;
            }
            if (state.history.length) goBack();
        });

        // 舞台等比缩放：初始化 + 窗口变化时重新计算
        fitStage();
        window.addEventListener("resize", fitStage);
    }

    global.AliceADVEngine = { init, showPage, goBack, showPopup, hidePopup, state };
})(window);
