/* =========================================================
 * aliceADV engine — theme loader
 * 读取 theme.json（用户自定义内容），把配置写入 CSS 变量并构造每个页面的 DOM。
 *
 * 设计原则（重要）：
 *   - core/ 是「模板」，本文件/样式都不写死任何游戏默认内容。
 *   - 唯一数据源是 theme.json：用户以后自行在里面改（16:9、按钮、章节…都只是示例数据）。
 *   - 构建机制（build.py）会读取工程的 theme.json + info.json，把相对值(0~1)翻译为百分比 CSS 变量，
 *     生成可直接 file:// 打开的 <工程>/dist/web/ 产物。构建产物会把主题内联为 window.__THEME__。
 *   - 运行时：优先用 window.__THEME__（构建产物）；否则 fetch theme.json（需本地服务器）。
 * ========================================================= */

(function (global) {
    "use strict";

    const THEME_PATH = "theme.json";

    /* UI 文案（i18n，纯界面文字，不是游戏内容）。
     * 注意：这里不再有「help / 帮助文档」；按钮顺序与是否出现完全由 theme.json 决定。 */
    const I18N = {
        start:    "开始游戏",
        continue: "继续游戏",
        load:     "读取存档",
        settings: "设置",
        chapters: "章节选择",
        gallery:  "画廊",
        branches: "剧情分支",
        about:    "关于",
        title:    "回到首页",
        quit:     "退出游戏",
        back:     "返回",
        save:     "保存",
        history:  "历史",
        skip:     "快进",
        auto:     "自动",
        qsave:    "快存",
        qload:    "快读",
        menu:     "菜单"
    };

    /* 按钮 → 导航目标（仅描述「点了这个键去哪」，不含顺序/文案/游戏内容）。
     * 顺序与是否出现由 theme.json 的 pages.title.buttons / sidebar 决定。 */
    const NAV = {
        start:    { page: "stage" },
        continue: { action: "continue" },
        load:     { page: "load" },
        settings: { page: "settings" },
        chapters: { page: "chapters" },
        gallery:  { page: "gallery" },
        branches: { page: "branches" },
        about:    { page: "about" },
        title:    { page: "title" },   // 暂停菜单「回到首页」
        help:     { page: "about" },   // 兼容在主菜单放 Help 按钮的游戏
        save:     { page: "save" },
        history:  { action: "history" },
        back:     { action: "back" },
        quit:     { action: "quit" }
    };

    /* 舞台底部工具栏文案（参考 Ren'Py quick_menu）。顺序由 theme.json 的 stage.toolbar 决定。 */
    const TOOLBAR_LABELS = {
        back:     "返回",
        history:  "History",
        skip:     "快进模式",
        auto:     "自动",
        save:     "保存",
        qsave:    "Q.保存",
        qload:    "Q.读取",
        load:     "读档",
        menu:     "菜单"
    };

    /* 剧本目录（章节/分支/画廊）。原属于 theme.json 的『目录』信息已移交给 story/chapters.json，
     * 引擎从此处读取，theme.json 只负责样式与界面文本。 */
    let CATALOG = {};

    /* 打包引擎版本：由 builder 在构建产物 index.html 内联为 window.__ENGINE__。
     * 来源是 aliceadv 包的 ENGINE_NAME / ENGINE_VERSION，而非工程 info.json。
     * 模板/未构建模式下 window.__ENGINE__ 不存在，ENGINE_LABEL 为空（不展示引擎版本）。 */
    const ENGINE = (global.__ENGINE__ && typeof global.__ENGINE__ === "object") ? global.__ENGINE__ : {};
    const ENGINE_LABEL = (ENGINE.name ? ENGINE.name + " " : "") + (ENGINE.version || "");
    let lastTheme = null; // buildAll 时缓存，供 renderSlots 重新渲染存档/读档页

    /* 游戏内暂停菜单（浮层）。参考定义.md：菜单即暂停，同 ESC 效果，可回首页等。
     * 按钮列表、停靠方向、窗口尺寸由 theme.json 的 panel 控制（见 buildStagePage / build_panel_css）。
     * 列表中的 "back" 是浮层底部的「返回」键（关闭浮层、继续播放），区别于侧边栏的返回（goBack）。 */
    function resolveMenuList(arr, theme) {
        if (!arr) return arr;
        const common = (theme && theme.menusCommon) || [];
        const out = [];
        arr.forEach(k => {
            if (k === "__common__") out.push.apply(out, common);
            else out.push(k);
        });
        return out;
    }
    function getIngameMenuButtons(theme) {
        const panelCfg = (theme.panel || {});
        const keys = resolveMenuList(
            (panelCfg.buttons && panelCfg.buttons.length) ? panelCfg.buttons
                : ["save", "load", "settings", "chapters", "gallery", "about", "title", "back"],
            theme
        );
        return keys.map(key => {
            if (key === "back") {
                return { key: "back", label: I18N.back || "返回", resume: true };
            }
            const def = NAV[key];
            if (!def) return null;
            return { key, label: I18N[key] || key, page: def.page || "", action: def.action || "" };
        }).filter(Boolean);
    }

    /* ---------- 工具：DOM 创建 ---------- */
    function el(tag, attrs, children) {
        const node = document.createElement(tag);
        if (attrs) {
            for (const k in attrs) {
                if (k === "class") node.className = attrs[k];
                else if (k === "html") node.innerHTML = attrs[k];
                else if (k === "text") node.textContent = attrs[k];
                else if (k.startsWith("on") && typeof attrs[k] === "function") {
                    node.addEventListener(k.slice(2), attrs[k]);
                } else if (attrs[k] !== false && attrs[k] != null) {
                    node.setAttribute(k, attrs[k]);
                }
            }
        }
        if (children) {
            (Array.isArray(children) ? children : [children]).forEach(c => {
                if (c == null || c === false) return;
                if (typeof c === "string") node.appendChild(document.createTextNode(c));
                else node.appendChild(c);
            });
        }
        return node;
    }
    function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }

    /* ---------- 相对值 → CSS 单位 ----------
     * 数字(0~1)：相对于对应轴 → 百分比。例如 0.9 → 90%。
     * 字符串：原样透传（如 "3.4em" / "60px"）。
     * 百分比保留 4 位有效数字，避免出现 0.57*100 = 56.99999999999999% 之类浮点误差。
     */
    function roundSig(v, n) {
        if (v === 0) return 0;
        const d = Math.ceil(Math.log10(Math.abs(v)));
        const f = Math.pow(10, n - d);
        return Math.round(v * f) / f;
    }
    function rel(v, fallback) {
        if (v == null) return fallback;
        if (typeof v === "number") return roundSig(v * 100, 4) + "%";
        return v;
    }

    /* ---------- 1. 主题：写入 CSS 变量 ---------- */
    function applyThemeVars(theme) {
        const r = document.documentElement.style;
        const setVar = (k, v) => v != null && (r.setProperty(k, String(v)));

        // 字号：基于设计宽度 1920 的比例（输出为 px，由 #stage transform 整体缩放）
        const sizes = theme.sizes || {};
        for (const k in sizes) {
            setVar(`--size-${k}`, `calc(var(--design-w) * ${sizes[k]} / 1920)`);
        }
        // 颜色
        const colors = theme.colors || {};
        for (const k in colors) setVar(`--color-${camel(k)}`, colors[k]);
        // 字体（支持字符串栈 / 对象形态 {family, src, fallbacks}）
        const fonts = theme.fonts || {};
        for (const k in fonts) {
            const v = fonts[k];
            if (v && typeof v === "object") {
                const fam = v.family;
                if (!fam) continue;
                const fb = v.fallbacks;
                setVar(`--font-${k}`, fb ? `"${fam}", ${fb}` : `"${fam}"`);
            } else {
                setVar(`--font-${k}`, v);
            }
        }
        // 屏幕
        const screen = theme.screen || {};
        if (screen.aspect) setVar("--aspect", screen.aspect.replace(":", " / "));
        if (screen.designWidth) {
            setVar("--design-w", screen.designWidth + "px");
            setVar("--design-w-px", screen.designWidth + "px");
        }
        if (screen.designHeight) {
            setVar("--design-h", screen.designHeight + "px");
            setVar("--design-h-px", screen.designHeight + "px");
        }
        if (screen.overflowColor) {
            document.body.style.background = screen.overflowColor;
            setVar("--overflow-color", screen.overflowColor);
        }
        // 存档槽
        if (theme.slot) {
            setVar("--slot-cols", theme.slot.cols || 3);
            setVar("--slot-aspect", `${theme.slot.width || 414} / ${theme.slot.height || 309}`);
        }
        // notify/skip 位置
        if (theme.notifyYpos != null) setVar("--notify-ypos", theme.notifyYpos);
        if (theme.skipYpos != null)   setVar("--skip-ypos",   theme.skipYpos);

        // 布局自由度（相对值 → 百分比 / em，构建时同规则翻译）
        const L = theme.layout || {};
        const d = L.dialogue || {};
        setVar("--dialogue-left",   rel(d.left,   "5%"));
        setVar("--dialogue-bottom", rel(d.bottom, "5%"));
        setVar("--dialogue-width",  rel(d.width,  "90%"));
        setVar("--dialogue-height", rel(d.height, "28%"));
        const padX = d.padX != null ? d.padX : "3.4em";
        setVar("--dialogue-pad-x",      padX);
        setVar("--dialogue-pad-left",   d.padLeft  != null ? d.padLeft  : padX);
        setVar("--dialogue-pad-right",  d.padRight != null ? d.padRight : padX);
        setVar("--dialogue-pad-top",    d.padTop != null ? d.padTop : (d.padY != null ? d.padY : "2.4em"));
        setVar("--dialogue-pad-bottom", d.padBottom != null ? d.padBottom : (d.padY != null ? d.padY : "2.4em"));
        setVar("--dialogue-justify",    d.justify != null ? d.justify : "center");
        setVar("--dialogue-text-align", d.textAlign != null ? d.textAlign : "left");
        const n = L.name || {};
        setVar("--name-left", rel(n.left, "3%"));
        setVar("--name-top",  rel(n.top,  "-7%"));
        const c = L.choice || {};
        setVar("--choice-left",   rel(c.left,   "10%"));
        setVar("--choice-top",    rel(c.top,    "26%"));
        setVar("--choice-width",  rel(c.width,  "80%"));
        setVar("--choice-gap",    c.gap     != null ? c.gap     : "1.2em");
        setVar("--choice-max-width", c.maxWidth != null ? c.maxWidth : "60%");
        const t = L.toolbar || {};
        setVar("--toolbar-height", t.height != null ? t.height : "6.5em");
        setVar("--toolbar-gap",    t.gap    != null ? t.gap    : "2em");
    }
    function camel(s) { return s.replace(/[-_](.)/g, (_, c) => c.toUpperCase()); }

    /* 继续按钮是否可用：自动存档开启 且 存在自动存档。
     * 任一不满足时，首页「继续」按钮置灰失效（但按用户约定，按钮的「显示/隐藏」由 theme.json 控制，引擎只负责有效性）。 */
    function continueUsable() {
        const S = global.AliceADVScript;
        if (!S || !S.autoSaveEnabled) return false;
        if (!S.autoSaveEnabled()) return false;
        if (!S.getSave) return false;
        return !!S.getSave("auto", 0);
    }

    /* ---------- 2. 开始页 (page_title) ---------- */
    function buildTitlePage(theme) {
        const root = document.getElementById("page_title");
        if (!root) return;
        clearChildren(root);

        const cfg = (theme.pages && theme.pages.title) || {};
        root.setAttribute("data-layout", cfg.layout || "left");

        // 背景图层
        const bg = el("div", { class: "title-bg" });
        if (cfg.background) {
            bg.style.backgroundImage = `url("${resolveAsset(cfg.background)}")`;
        } else {
            bg.style.background = "linear-gradient(135deg, #cfe2ff 0%, #a6c8ff 50%, #6e9be5 100%)";
        }
        // 背景铺满方式：自定义热区模式默认 100% 100%（图片 0~1 坐标与热区 0~1 坐标严格对齐）；
        // 普通布局默认 cover（保持比例、可能裁切，适合纯装饰背景）。可用 backgroundSize 覆盖。
        bg.style.backgroundSize = cfg.backgroundSize
            || (cfg.customButtons && cfg.customButtons.length ? "100% 100%" : "cover");
        root.appendChild(bg);

        if (cfg.overlay) root.appendChild(el("div", { class: "page__overlay" }));

        // 标题信息
        const info = (theme.info || {});
        if (cfg.showName !== false && info.name) {
            const meta = el("div", { class: "title-meta" }, [ el("h1", { text: info.name }) ]);
        if (cfg.showVersion !== false && info.version) {
            meta.appendChild(el("div", { class: "version", text: "v" + info.version }));
        }
        if (cfg.showVersion !== false && ENGINE_LABEL) {
            meta.appendChild(el("div", { class: "version engine", text: ENGINE_LABEL }));
        }
            root.appendChild(meta);
        }

        // 自定义按钮（图片热区）：如果 theme.json 配置了 pages.title.customButtons，
        // 则完全替代默认按钮列表，每个按钮按 left/top/width/height 绝对定位。
        const customButtons = cfg.customButtons;
        if (customButtons && customButtons.length) {
            const firstChapter = (CATALOG.chapters || []).find(c => !c.locked && c.script);
            const trayCls = "title-custom-buttons" + (cfg.debugHotzones ? " title-custom-buttons--debug" : "");
            const tray = el("div", { class: trayCls });
            customButtons.forEach(btn => {
                const key = btn.action;
                const def = NAV[key];
                if (!def && key !== "start") return; // 未知 action 跳过
                const style = [
                    `left:${rel(btn.left, 0)}`,
                    `top:${rel(btn.top, 0)}`,
                    `width:${rel(btn.width, "auto")}`,
                    `height:${rel(btn.height, "auto")}`
                ].join(";");
                const isStart = key === "start";
                const isContinue = key === "continue";
                const cDisabled = isContinue && !continueUsable();
                const children = [];
                if (btn.image) {
                    const img = el("img", { src: resolveAsset(btn.image), alt: btn.label || I18N[key] || key });
                    if (btn.hover) {
                        img.setAttribute("data-idle", btn.image);
                        img.setAttribute("data-hover", btn.hover);
                    }
                    children.push(img);
                } else if (btn.label) {
                    children.push(el("span", { class: "title-custom-btn__label", text: btn.label }));
                }
                const node = el("button", {
                    class: "title-custom-btn" + (cDisabled ? " is-insensible" : ""),
                    style: style,
                    "data-page": (isStart && firstChapter) ? "" : (def.page || ""),
                    "data-script": (isStart && firstChapter) ? firstChapter.script : "",
                    "data-action": def ? (def.action || "") : "",
                    "data-key": key,
                    "disabled": cDisabled || undefined,
                    onmouseenter: btn.hover ? (e => {
                        const img = e.currentTarget.querySelector("img");
                        if (img) img.src = resolveAsset(btn.hover);
                    }) : null,
                    onmouseleave: btn.hover ? (e => {
                        const img = e.currentTarget.querySelector("img");
                        if (img && btn.image) img.src = resolveAsset(btn.image);
                    }) : null
                }, children);
                tray.appendChild(node);
            });
            root.appendChild(tray);
            return;
        }

        // 按钮列表：顺序严格按 theme.json 的 pages.title.buttons（不写死）；
        // "__common__" 展开为 theme.menusCommon 公共列表
        const side = el("div", { class: "title-side" });
        const order = resolveMenuList(
            (cfg.buttons && cfg.buttons.length) ? cfg.buttons
                : ["start", "continue", "load", "settings", "chapters", "gallery", "branches", "about", "quit"],
            theme
        );
        // 开始游戏：绑定第一个可玩章节的剧本文件（由剧本运行时接管）
        const firstChapter = (CATALOG.chapters || []).find(c => !c.locked && c.script);
        order.forEach(key => {
            const def = NAV[key];
            if (!def) return; // 未知键跳过，不报错
            const isContinue = key === "continue";
            const cDisabled = isContinue && !continueUsable();
            side.appendChild(el("button", {
                class: "paper paper-btn" + (cDisabled ? " is-insensible" : ""),
                "data-page": (key === "start" && firstChapter) ? "" : (def.page || ""),
                "data-script": (key === "start" && firstChapter) ? firstChapter.script : "",
                "data-action": def.action || "",
                "data-key": key,
                "disabled": cDisabled || undefined,
                text: I18N[key] || key
            }));
        });
        root.appendChild(side);
    }

    /* ---------- 3. 游戏内页通用壳 (save / load / settings / chapters / branches / gallery) ---------- */
    function buildGameMenuPage(pageId, theme, currentKey) {
        const root = document.getElementById(pageId);
        if (!root) return;
        clearChildren(root);

        const cfg = (theme.pages && theme.pages[pageId.replace("page_", "")]) || {};
        if (cfg.background) {
            root.appendChild(el("div", {
                class: "page__bg",
                style: `background-image:url("${resolveAsset(cfg.background)}");`
            }));
        } else {
            root.appendChild(el("div", { class: "page__bg page__bg--solid" }));
        }

        const menu = el("div", { class: "game-menu" });

        // 侧边栏停靠：依据 theme.sidebarSide（"left" / "right"，默认 "left"）给 .game-menu 加对应类，
        // 由 game-menu.css 决定网格列顺序与分隔线位置。
        const menuSide = ((theme.sidebarSide || "left") + "").toLowerCase();
        menu.classList.add("game-menu--sidebar-" + (menuSide === "right" ? "right" : "left"));

        // 侧边栏按钮顺序按 theme.json 的 sidebar（不写死）；"__common__" 展开为 theme.menusCommon
        const sidebar = el("div", { class: "game-menu__sidebar" });
        const sideOrder = resolveMenuList(
            (theme.sidebar && theme.sidebar.length) ? theme.sidebar
                : ["history", "save", "load", "settings", "chapters", "gallery", "branches", "about", "back"],
            theme
        );
        sideOrder.forEach(key => {
            const def = NAV[key];
            if (!def) return;
            sidebar.appendChild(el("button", {
                class: "paper paper-btn" + (key === "back" ? " back-btn" : "") + (key === currentKey ? " is-current" : ""),
                "data-page": def.page || "",
                "data-action": def.action || "",
                text: I18N[key] || key
            }));
        });
        menu.appendChild(sidebar);

        const main = el("div", { class: "game-menu__main" });
        if (cfg.title)   main.appendChild(el("h2", { class: "game-menu__title", text: cfg.title }));
        if (cfg.titleEn) main.appendChild(el("div", { class: "game-menu__title-en", text: cfg.titleEn }));

        const body = el("div", { class: "game-menu__body flex-col gap-16" });
        fillPageBody(pageId, body, theme, cfg);
        main.appendChild(body);

        menu.appendChild(main);
        root.appendChild(menu);
        root.appendChild(el("div", { class: "game-menu__divider" }));
    }

    /* ---------- 3.1 存档 / 读档 ---------- */
    function fillSlotsGrid(body, theme, cfg, isSave) {
        const cols = cfg.slotCols || theme.slot?.cols || 3;
        const rows = cfg.slotRows || theme.slot?.rows || 2;
        const total = cols * rows;
        const grid = el("div", { class: "slots-grid", style: `--slot-cols:${cols};` });
        const Script = global.AliceADVScript;
        const autoOn  = Script && Script.autoSaveEnabled  ? Script.autoSaveEnabled()  : true;
        const quickOn = Script && Script.quickSaveEnabled ? Script.quickSaveEnabled() : true;

        // 槽位顺序：自动存档 → 快速存档 → 普通手动槽。
        // 关闭的开关对应系统槽从列表移除（关闭后首页「继续」/ 菜单「快读」在逻辑层失效）。
        // 手动槽紧随其后，普通存档只能写入这些槽，无法覆盖系统槽。
        const descs = [];
        if (autoOn)  descs.push({ kind: "auto",  n: 0, system: true, label: "自动存档" });
        if (quickOn) descs.push({ kind: "quick", n: 0, system: true, label: "快速存档" });
        let m = 1;
        while (descs.length < total) { descs.push({ kind: "manual", n: m, system: false, label: "存档 " + m }); m++; }

        descs.forEach(d => {
            const data = (Script && Script.getSave) ? Script.getSave(d.kind, d.n) : null;
            const filled = !!data;
            const slot = el("div", {
                class: "slot" + (filled ? "" : " is-empty") + (d.system ? " slot--system" : ""),
                "data-slot-kind": d.kind,
                "data-slot-index": d.n
            });
            ["tl", "tr", "bl", "br"].forEach(pos => {
                slot.appendChild(el("div", { class: `slot__corner slot__corner--${pos}` }));
            });
            const thumb = el("div", { class: "slot__thumb" });
            if (filled && data.display && data.display.thumb) {
                thumb.style.backgroundImage = `url("${resolveAsset(data.display.thumb)}")`;
            } else {
                thumb.textContent = d.system ? d.label : "Empty slot";
            }
            slot.appendChild(thumb);
            const meta = el("div", { class: "slot__meta" });
            if (filled && data.display) {
                meta.appendChild(el("div", { class: "slot__name", text: data.display.label || "" }));
                meta.appendChild(el("div", { class: "slot__text", text: data.display.text || "" }));
                meta.appendChild(el("div", { class: "slot__time", text: data.timeStr || "" }));
            } else {
                meta.appendChild(el("div", { class: "slot__name", text: d.label }));
            }
            slot.appendChild(meta);
            grid.appendChild(slot);
        });
        body.appendChild(grid);

        const jumper = el("div", { class: "page-jumper" }, [
            el("span", { class: "pj-num", text: "‹" }),
            el("span", { class: "pj-num is-current", text: "A" }),
            el("span", { class: "pj-num", text: "Q" }),
            el("span", { class: "pj-num", text: "1" }),
            el("span", { class: "pj-num", text: "2" }),
            el("span", { class: "pj-num", text: "3" }),
            el("span", { class: "pj-num", text: "4" }),
            el("span", { class: "pj-num", text: "5" }),
            el("span", { class: "pj-num", text: "6" }),
            el("span", { class: "pj-num", text: "7" }),
            el("span", { class: "pj-num", text: "8" }),
            el("span", { class: "pj-num", text: "9" }),
            el("span", { class: "pj-num", text: "›" })
        ]);
        body.appendChild(jumper);
    }

    /* ---------- 3.2 设置 ---------- */
    function fillSettingsGrid(body) {
        const row1 = el("div", { class: "settings-row" });

        const g1 = el("div", { class: "settings-group" }, [
            el("div", { class: "settings-label", text: "显示模式" }),
            el("div", { class: "settings-buttons" }, [
                el("button", { class: "paper paper-btn is-current", text: "窗口" }),
                el("button", { class: "paper paper-btn", text: "全屏幕" })
            ])
        ]);
        const g2 = el("div", { class: "settings-group" }, [
            el("div", { class: "settings-label", text: "Rollback Side" }),
            el("div", { class: "settings-buttons" }, [
                el("button", { class: "paper paper-btn", text: "Disable" }),
                el("button", { class: "paper paper-btn is-current", text: "Left" }),
                el("button", { class: "paper paper-btn", text: "Right" })
            ])
        ]);
        const g3 = el("div", { class: "settings-group" }, [
            el("div", { class: "settings-label", text: "快进模式" }),
            el("div", { class: "settings-buttons" }, [
                el("label", { class: "checkbox" }, [ el("span", { class: "checkbox__box" }), "Unseen Text" ]),
                el("label", { class: "checkbox is-checked" }, [ el("span", { class: "checkbox__box" }), "选项后" ]),
                el("label", { class: "checkbox" }, [ el("span", { class: "checkbox__box" }), "转场特效" ])
            ])
        ]);
        row1.appendChild(g1); row1.appendChild(g2); row1.appendChild(g3);
        body.appendChild(row1);

        const row2 = el("div", { class: "settings-row mt-16" });
        const s1 = el("div", { class: "settings-group" }, [ el("div", { class: "settings-label", text: "文字显示速度" }), slider(0.55) ]);
        const s2 = el("div", { class: "settings-group" }, [ el("div", { class: "settings-label", text: "自动模式等待时间" }), slider(0.3) ]);
        const s3 = el("div", { class: "settings-group" }, [ el("div", { class: "settings-label", text: "音乐音量" }), slider(0.6) ]);
        const s4 = el("div", { class: "settings-group" }, [ el("div", { class: "settings-label", text: "音效音量" }), slider(0.7) ]);
        const s5 = el("div", { class: "settings-group" }, [ el("div", { class: "settings-label", text: "语音音量" }), slider(0.8) ]);
        const s6 = el("div", { class: "settings-group" }, [
            el("div", { class: "settings-label", text: " " }),
            el("div", { class: "settings-buttons" }, [
                el("label", { class: "checkbox" }, [ el("span", { class: "checkbox__box" }), "Mute All" ])
            ])
        ]);
        [s1, s2, s3, s4, s5, s6].forEach(s => row2.appendChild(s));
        body.appendChild(row2);
    }

    function slider(value) {
        const root = el("div", { class: "slider" });
        const track = el("div", { class: "slider__track" });
        const thumb = el("div", { class: "slider__thumb" });
        thumb.style.left = (value * 100) + "%";
        track.appendChild(thumb);
        root.appendChild(track);
        return root;
    }

    /* ---------- 3.3 章节选择 / 分支（数据来自 theme.json） ---------- */
    function fillChapterList(body, theme) {
        const list = el("div", { class: "chapter-list" });
        (CATALOG.chapters || []).forEach(c => {
            list.appendChild(el("div", {
                class: "chapter-item" + (c.locked ? " is-locked" : ""),
                // 有剧本文件的章节 → data-script，点击由剧本运行时接管播放
                "data-script": (!c.locked && c.script) ? c.script : "",
                "data-page": (!c.locked && !c.script) ? "stage" : ""
            }, [
                el("div", { class: "chapter-item__index", text: c.idx }),
                el("div", { class: "chapter-item__title", text: c.title }),
                el("div", { class: "chapter-item__desc", text: c.desc })
            ]));
        });
        body.appendChild(list);
    }
    function fillBranchList(body, theme) {
        const list = el("div", { class: "branch-list" });
        (CATALOG.branches || []).forEach(b => {
            list.appendChild(el("div", {
                class: "branch-item" + (b.locked ? " is-locked" : ""),
                "data-page": b.locked ? "" : "stage"
            }, [
                el("div", { class: "branch-item__index", text: b.idx }),
                el("div", { class: "branch-item__title", text: b.title }),
                el("div", { class: "branch-item__desc", text: b.desc })
            ]));
        });
        body.appendChild(list);
    }

    /* ---------- 3.4 画廊（数据来自 theme.json） ---------- */
    function fillGallery(body, theme) {
        const grid = el("div", { class: "gallery-grid" });
        (CATALOG.gallery || []).forEach(g => {
            const item = el("div", { class: "gallery-item" + (g.locked ? " is-locked" : "") });
            const img = el("div", { class: "gallery-item__img" });
            if (!g.locked) img.style.backgroundImage = `url("${resolveAsset("gui/sample_thumb.png")}")`;
            item.appendChild(img);
            item.appendChild(el("div", { class: "gallery-item__label", text: g.name }));
            grid.appendChild(item);
        });
        body.appendChild(grid);
    }

    /* ---------- 3.5 关于页 ---------- */
    function fillAbout(body, theme) {
        const info = theme.info || {};
        const aboutText = (theme.about || "").trim();
        const c = el("div", { class: "about-content" });
        c.appendChild(el("h2", { text: info.name || "游戏名" }));
        if (info.version) c.appendChild(el("div", { class: "ver", text: "游戏版本 " + info.version }));
        if (ENGINE_LABEL) c.appendChild(el("div", { class: "ver", text: "引擎版本 " + ENGINE_LABEL }));
        c.appendChild(el("p", { text: "由 aliceADV 引擎驱动 (MIT License)" }));
        c.appendChild(el("p", { html: "引擎仓库: <a href='#'>github.com/aliceadv/engine</a>" }));
        if (aboutText) {
            aboutText.split(/\n+/).forEach(line => {
                if (line.trim()) c.appendChild(el("p", { text: line }));
            });
        } else {
            c.appendChild(el("p", { text: "本程序使用了由若干许可证授权的免费软件。" }));
        }
        body.appendChild(c);
    }

    /* ---------- 3.6 入口：fillPageBody ---------- */
    function fillPageBody(pageId, body, theme, cfg) {
        switch (pageId) {
            case "page_save":     return fillSlotsGrid(body, theme, cfg, true);
            case "page_load":     return fillSlotsGrid(body, theme, cfg, false);
            case "page_settings": return fillSettingsGrid(body);
            case "page_chapters": return fillChapterList(body, theme);
            case "page_branches": return fillBranchList(body, theme);
            case "page_gallery":  return fillGallery(body, theme);
            case "page_about":    return fillAbout(body, theme);
        }
    }

    /* ---------- 4. 舞台 page_stage ----------
     * 舞台只搭「骨架」：背景层 / 立绘层 / 章节标题卡 / 文本框 / 选项 / 工具栏 /
     * 游戏内菜单浮层 / 历史记录浮层。具体演出内容由剧本运行时(script.js)驱动。
     */
    function buildStagePage(theme) {
        const root = document.getElementById("page_stage");
        if (!root) return;
        clearChildren(root);
        root.classList.remove("is-empty");

        const cfg = (theme.pages && theme.pages.stage) || {};

        // 背景层（剧本未运行时的兜底背景）
        const bg = el("div", { class: "stage-bg" });
        if (cfg.background) bg.style.backgroundImage = `url("${resolveAsset(cfg.background)}")`;
        root.appendChild(bg);

        // 立绘层（剧本 show/sprite/hide 指令操作这里）
        root.appendChild(el("div", { class: "stage-chars" }));

        // NVL 整屏旁白层（剧本 narrate{mode:"nvl"} 追加、nvlclear 清空）
        root.appendChild(el("div", { class: "stage-nvl" }));

        // 章节标题卡（剧本 title 指令）
        root.appendChild(el("div", { class: "stage-title-card" }, [
            el("div", { class: "stage-title-card__text" })
        ]));

        // 文本框（尺寸/位置由 CSS 变量驱动，变量值来自 theme.json 的 layout）
        root.appendChild(el("div", { class: "textbox paper" }, [
            el("div", { class: "textbox__name" }),
            el("div", { class: "textbox__text" })
        ]));

        // 选项（剧本 decide 判定指令渲染到这里）
        root.appendChild(el("div", { class: "choices" }));

        // 工具栏（顺序来自 theme.json 的 stage.toolbar）
        const tb = el("div", { class: "toolbar" });
        const order = (cfg.toolbar && cfg.toolbar.length) ? cfg.toolbar
                    : ["back", "history", "skip", "auto", "save", "qsave", "qload", "menu"];
        order.forEach(key => {
            const def = NAV[key] || {};
            tb.appendChild(el("button", {
                class: "toolbar__btn",
                "data-tool": key,
                "data-page": def.page || "",
                text: (TOOLBAR_LABELS[key] || I18N[key] || key)
            }));
        });
        root.appendChild(tb);

        // 游戏内菜单浮层（右侧菜单栏 + 底部返回按钮）
        const menuPanel = el("div", { class: "ingame-menu paper" });
        menuPanel.appendChild(el("div", { class: "ingame-menu__title", text: "菜单" }));
        // 按钮列表来自 theme.json 的 panel.buttons（默认见 getIngameMenuButtons）。
        // "back" 渲染为浮层底部「返回」键（data-resume，关闭浮层、继续播放）；
        // 其余键渲染为普通按钮（data-page / data-action）。
        getIngameMenuButtons(theme).forEach(b => {
            if (b.resume) {
                menuPanel.appendChild(el("button", {
                    class: "paper paper-btn ingame-menu__back",
                    "data-resume": "1",
                    text: b.label
                }));
            } else {
                menuPanel.appendChild(el("button", {
                    class: "paper paper-btn ingame-menu__btn",
                    "data-page": b.page || "",
                    "data-action": b.action || "",
                    text: b.label
                }));
            }
        });
        root.appendChild(el("div", { id: "overlay_menu", class: "ingame-overlay" }, [menuPanel]));

        // 历史记录浮层（内容由剧本运行时渲染）
        const histPanel = el("div", { class: "history-panel paper" }, [
            el("h2", { class: "history-panel__title", text: "历史记录" }),
            el("div", { class: "history-list scroll-area" }),
            el("button", { class: "paper paper-btn history-panel__back", "data-resume": "1", text: "返回" })
        ]);
        root.appendChild(el("div", { id: "overlay_history", class: "ingame-overlay" }, [histPanel]));
    }

    /* ---------- 5. 浮层 popup_quitQuery ---------- */
    function buildPopup(theme) {
        const root = document.getElementById("popup_quitQuery");
        if (!root) return;
        clearChildren(root);
        const frame = el("div", { class: "popup__frame paper" }, [
            el("p", { class: "popup__msg", text: "要退出游戏吗？" }),
            el("div", { class: "popup__actions" }, [
                el("button", { class: "paper paper-btn is-primary", "data-popup-confirm": "1", text: "退出" }),
                el("button", { class: "paper paper-btn", "data-popup-cancel": "1", text: "取消" })
            ])
        ]);
        root.appendChild(frame);
    }

    /* ---------- 6. 资源路径解析 ---------- */
    function resolveAsset(p) {
        if (!p) return "";
        if (/^(https?:|data:|\/\/|\/)/.test(p)) return p;
        return p;
    }

    /* ---------- 7. 未加载到主题时的友好提示（非写死默认，仅使用说明） ---------- */
    function showNoThemeNotice() {
        const stage = document.getElementById("stage");
        if (!stage) return;
        const note = el("div", { class: "no-theme-note" }, [
            el("div", { class: "no-theme-note__box paper" }, [
                el("p", { text: "未能加载 theme.json。" }),
                el("p", { class: "small", text: "core/ 是引擎模板，需在你的工程目录里构建后运行：" }),
                el("p", { class: "small", text: "① 用 create.py 创建工程，在工程中编写 theme.json / story 等；" }),
                el("p", { class: "small", text: "② 运行 python3 build.py <工程目录> 生成 <工程>/dist/web/，再打开其中的 index.html；" }),
                el("p", { class: "small", text: "③ 或在工程目录运行 python3 -m http.server 后用 http:// 访问 dist/web/。" })
            ])
        ]);
        stage.appendChild(note);
    }

    /* ---------- 8. 入口 ---------- */
    function buildAll(theme, catalog) {
        CATALOG = catalog || {};
        lastTheme = theme;
        applyThemeVars(theme);
        buildTitlePage(theme);
        buildStagePage(theme);
        ["save", "load", "settings", "chapters", "branches", "gallery", "about"]
            .forEach(k => buildGameMenuPage("page_" + k, theme, k));
        buildPopup(theme);
    }

    /* 重新渲染存档 / 读档页（保存或进入页面时调用，读取 localStorage 最新槽位信息） */
    function renderSlots() {
        if (!lastTheme) return;
        ["save", "load"].forEach(k => buildGameMenuPage("page_" + k, lastTheme, k));
    }

    /* 暴露已加载的主题 / 目录（供 engine.js 的页面预加载 hook 取用）。 */
    function getTheme() { return lastTheme; }
    function getCatalog() { return CATALOG; }

    async function loadTheme() {
        // 构建产物会把主题内联为 window.__THEME__（无需 fetch，file:// 直接可用）
        if (global.__THEME__) return global.__THEME__;

        // 模板模式：运行时 fetch theme.json（需本地服务器）
        try {
            const r = await fetch(THEME_PATH + "?t=" + Date.now());
            if (r.ok) {
                const loaded = await r.json();
                try {
                    const r2 = await fetch("info.json?t=" + Date.now());
                    if (r2.ok) loaded.info = await r2.json();
                } catch (_) {}
                try {
                    const r3 = await fetch("about.txt?t=" + Date.now());
                    if (r3.ok) loaded.about = await r3.text();
                } catch (_) {}
                return loaded;
            }
        } catch (e) {
            console.warn("[aliceADV] 无法通过 fetch 加载 theme.json（请使用构建产物或本地服务器）", e);
        }
        return null;
    }

    /* 加载剧本目录 story/chapters.json（章节/分支/画廊 + 播放顺序）。
     * 构建产物内联为 window.__SCRIPTS__["story/chapters.json"]；模板模式则 fetch。 */
    async function loadCatalog() {
        const inline = global.__SCRIPTS__;
        if (inline && inline["story/chapters.json"] !== undefined) return inline["story/chapters.json"];
        try {
            const r = await fetch("story/chapters.json?t=" + Date.now());
            if (r.ok) return await r.json();
        } catch (e) {
            console.warn("[aliceADV] 无法加载 story/chapters.json", e);
        }
        return {};
    }

    global.AliceADVTheme = { loadTheme, loadCatalog, buildAll, renderSlots, showNoThemeNotice, getTheme, getCatalog, I18N };
})(window);
