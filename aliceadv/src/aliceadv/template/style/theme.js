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
        load:     "读取",
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
        menu:     "菜单",
        // 非导航键：快进指示条的文案（对应 Ren'Py skip_indicator 的 _("Skipping")）。
        // 放在这里是为了让界面文案只有一处来源，与上面 NAV / TOOLBAR_LABELS 的约定一致。
        skipIndicator: "快进中"
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
        load:     "读取",
        menu:     "菜单"
    };

    /* 关于页两层衬底的颜色**不在这里给默认值**：默认值唯一来源是模板 theme.json 的
     * pages.about.backgroundColor / panelColor（构建时 _deep_merge(模板, 工程) 合并进 window.__THEME__，
     * 工程没写就用模板的值）。这里只负责「配置里有就写进内联样式」，写死常量会造成第二处真值源，
     * 还会让工程里显式写 null（＝不要衬底）被兜回来。 */

    /* 剧本目录（章节/分支/画廊）。原属于 theme.json 的『目录』信息已移交给 story/chapters.json，
     * 引擎从此处读取，theme.json 只负责样式与界面文本。 */
    let CATALOG = {};

    /* 打包引擎版本：由 builder 在构建产物 index.html 内联为 window.__ENGINE__。
     * 来源是 aliceadv 包的 ENGINE_NAME / ENGINE_VERSION，而非工程 info.json。
     * 模板/未构建模式下 window.__ENGINE__ 不存在，ENGINE_LABEL 为空（不展示引擎版本）。 */
    const ENGINE = (global.__ENGINE__ && typeof global.__ENGINE__ === "object") ? global.__ENGINE__ : {};
    const ENGINE_LABEL = (ENGINE.name ? ENGINE.name + " " : "") + (ENGINE.version || "");
    /* 引擎仓库地址：由 builder 随 __ENGINE__ 一起内联（唯一来源是 aliceadv/__init__.py 的
     * ENGINE_REPO）。这里的兜底字面量只服务一种场景——**直接打开模板目录**（未构建）时
     * window.__ENGINE__ 整体不存在，ENGINE_LABEL 也为空、引擎版本行不显示，
     * 兜底只是保证链接在任何情况下都不会变成空 href。 */
    const ENGINE_REPO = ENGINE.repo || "https://github.com/Alice-Drop/aliceADV";

    /* 版本号的显示文本：统一加 "v" 前缀。
     * 标题页与关于页共用这一处（此前标题页写 `"v" + info.version`、关于页写 `info.version`
     * 两个版本号一个带 v 一个不带，用户报的「游戏版本那里少了一个 v」就是它）。
     * 配置里已经写成 "v0.2.2" 的不再加一个 v。 */
    function verLabel(v) {
        const s = (v === undefined || v === null) ? "" : String(v).trim();
        if (!s) return "";
        return /^v/i.test(s) ? s : "v" + s;
    }

    let lastTheme = null; // buildAll 时缓存，供 renderSlots 重新渲染存档/读档页

    /* 关于页正文。**不是 theme.json 的字段**——正文属于游戏内容，唯一位置是工程根
     *  about.txt，两个入口读同一个文件：
     *    - 构建产物：builder 读 about.txt 内联为 window.__ABOUT__（file:// 也能用）；
     *    - 模板模式：loadTheme() 运行时 fetch about.txt（需本地服务器）。
     *  二者只写这一个变量，fillAbout 只读它，值不会来自第二处。 */
    let ABOUT_TEXT = "";

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
        if (v == null) return fallback;   // 不传 fallback 时返回 undefined，setVar 会跳过（＝不写这个变量）
        if (typeof v === "number") return roundSig(v * 100, 4) + "%";
        return v;
    }

    /* 字段名 → CSS 变量名：统一 kebab-case。
     * CSS 侧的既有约定就是 kebab（--color-accent-deep / --size-page-heading），
     * 若按 camelCase 拼名字（--color-accentDeep），就会出现「JS 写一个名、CSS 读另一个名」的错位：
     * theme.json 里那些驼峰键（accentDeep / idleSmall / pageHeading / sectionHeading）
     * 会静默失效，页面上吃到的是 base.css 的兜底字面值。 */
    function cssName(s) {
        return String(s).replace(/_/g, "-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    }

    /* ---------- 1. 主题：写入 CSS 变量 ---------- */
    function applyThemeVars(theme) {
        const r = document.documentElement.style;
        const setVar = (k, v) => v != null && (r.setProperty(k, String(v)));

        // 字号：基于设计宽度 1920 的比例（输出为 px，由 #stage transform 整体缩放）
        const sizes = theme.sizes || {};
        for (const k in sizes) {
            if (k.startsWith("_")) continue;
            setVar(`--size-${cssName(k)}`, `calc(var(--design-w) * ${sizes[k]} / 1920)`);
        }
        // 颜色
        const colors = theme.colors || {};
        for (const k in colors) {
            if (k.startsWith("_")) continue;   // _comment 之类的说明键不是颜色
            setVar(`--color-${cssName(k)}`, colors[k]);
        }
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
        // 宽高比：不参与布局计算（#stage 的尺寸由 --design-w/--design-h 决定，
        // 两者的比值本身就是宽高比），仅作为可供自行引用的信息变量写出。
        if (screen.aspect) setVar("--aspect", screen.aspect.replace(":", " / "));
        // 设计分辨率：engine.js 的 fitStage() 直接量 #stage 的布局尺寸，读的就是这两个值。
        if (screen.designWidth)  setVar("--design-w", screen.designWidth + "px");
        if (screen.designHeight) setVar("--design-h", screen.designHeight + "px");
        if (screen.overflowColor) {
            document.body.style.background = screen.overflowColor;
            setVar("--overflow-color", screen.overflowColor);
        }
        // 存档槽
        if (theme.slot) {
            setVar("--slot-cols", theme.slot.cols);
            if (theme.slot.width != null && theme.slot.height != null) {
                setVar("--slot-aspect", `${theme.slot.width} / ${theme.slot.height}`);
            }
        }
        // notify/skip 位置
        if (theme.notifyYpos != null) setVar("--notify-ypos", theme.notifyYpos);
        if (theme.skipYpos != null)   setVar("--skip-ypos",   theme.skipYpos);

        // 手柄焦点框（识别到手柄时圈住候选按钮）。与 builder.build_css_vars 同名同源。
        const f = theme.focus;
        if (f) {
            if (f.frameWidth != null)         setVar("--focus-frame-width", f.frameWidth);
            if (f.frameColor != null)         setVar("--focus-frame-color", f.frameColor);
            if (f.frameColorActive != null)   setVar("--focus-frame-color-active", f.frameColorActive);
            if (f.glow != null)               setVar("--focus-glow", f.glow);
            if (f.radius != null)             setVar("--focus-radius", f.radius);
            if (f.transition != null)         setVar("--focus-transition", f.transition);
        }

        /* 布局自由度（相对值 → 百分比 / em）。
         * 这里**只写 theme.json 里配了的值**，不再各带一份字面兜底默认值：
         *   默认值的唯一来源是模板 theme.json（构建时 _deep_merge(模板, 工程) 已合并进来），
         *   最后一道兜底写在 CSS 的 var(--x, 默认) 里（见 pages/stage.css）。
         * 在渲染流程里再写一份 "5%" / "3.4em" 这类字面量＝同一份默认值有第三处副本，
         * 改了模板却漏改这里就会出现「模板改了、页面没变」的假象。 */
        const L = theme.layout || {};
        const d = L.dialogue || {};
        setVar("--dialogue-left",   rel(d.left));
        setVar("--dialogue-bottom", rel(d.bottom));
        setVar("--dialogue-width",  rel(d.width));
        setVar("--dialogue-height", rel(d.height));
        // padX / padY 是「派生基准」（左右取 padX、上下取 padY），属于配置内部的继承关系，不是默认值
        const padX = d.padX;
        setVar("--dialogue-pad-x",      padX);
        setVar("--dialogue-pad-left",   d.padLeft  != null ? d.padLeft  : padX);
        setVar("--dialogue-pad-right",  d.padRight != null ? d.padRight : padX);
        setVar("--dialogue-pad-top",    d.padTop    != null ? d.padTop    : d.padY);
        setVar("--dialogue-pad-bottom", d.padBottom != null ? d.padBottom : d.padY);
        setVar("--dialogue-justify",    d.justify);
        setVar("--dialogue-text-align", d.textAlign);
        const n = L.name || {};
        setVar("--name-left", rel(n.left));
        setVar("--name-top",  rel(n.top));
        // 名字框锚点（0~1），与 builder.build_css_vars 同名同源，两边都写才不会
        // 出现「构建产物生效、模板模式失效」——数值原样透传，不给兜底。
        if (n.anchor != null) setVar("--name-anchor", n.anchor);
        // 立绘与 NVL：与 builder.build_css_vars 保持同名同源（此前只有 builder 写，
        // 模板模式（运行时 fetch theme.json）下 layout.sprite / layout.nvl 会被完全忽略）
        const sp = L.sprite || {};
        setVar("--sprite-bottom", rel(sp.bottom));
        setVar("--sprite-height", rel(sp.height));
        const nv = L.nvl || {};
        setVar("--nvl-left",       rel(nv.left));
        setVar("--nvl-width",      rel(nv.width));
        setVar("--nvl-line-gap",   nv.lineGap);
        setVar("--nvl-justify",    nv.justify);
        setVar("--nvl-text-align", nv.textAlign);
        const c = L.choice || {};
        setVar("--choice-left",   rel(c.left));
        setVar("--choice-top",    rel(c.top));
        setVar("--choice-width",  rel(c.width));
        setVar("--choice-gap",    c.gap);
        setVar("--choice-max-width", c.maxWidth);
        const t = L.toolbar || {};
        setVar("--toolbar-height", t.height);
        setVar("--toolbar-gap",    t.gap);

        // UI 图片（数据驱动）：对话框 / 面板边框 / 按钮背景 / 画廊占位图统一由 theme.json 决定，
        // 不再硬编码在 CSS 的 url(...) 里。CSS 侧用 var(--gui-*) 引用，此处写入实际路径；
        // 预加载器 preload.js 也读同一批字段（collectChrome），从此不存在「CSS 有图、预加载看不见」的盲区。
        const imgVar = (p) => { const u = assetUrl(p); return u ? `url("${u}")` : null; };
        const dlg = theme.dialog || {};
        setVar("--gui-textbox", imgVar(dlg.background));
        const fr = theme.frame || {};
        setVar("--gui-frame", imgVar(fr.background));
        const btn = theme.button || {};
        setVar("--gui-button-idle",  imgVar(btn.idle));
        setVar("--gui-button-hover", imgVar(btn.hover));
        const ch = theme.choice || {};
        setVar("--gui-choice-idle",  imgVar(ch.idle));
        setVar("--gui-choice-hover", imgVar(ch.hover));
        // thumb.placeholder 不写 CSS 变量：它是「每个槽位各自的图」，由本文件与 preload.js
        // 直接读 theme.thumb.placeholder 内联到对应元素上，CSS 侧没有任何 var(--gui-thumb) 消费者。
    }
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

        // 背景图层。未配置 background 时代码不写任何内联背景——
        // 兜底底纹由 CSS（#page_title .title-bg）用主题色给，见 pages/title.css。
        const bg = el("div", { class: "title-bg" });
        if (cfg.background) {
            bg.style.backgroundImage = `url("${resolveAsset(cfg.background)}")`;
        }
        // 背景铺满方式：自定义热区模式默认 100% 100%（图片 0~1 坐标与热区 0~1 坐标严格对齐）；
        // 普通布局默认 cover（保持比例、可能裁切，适合纯装饰背景）。可用 backgroundSize 覆盖。
        // 这两个值描述的是「铺满策略」而非主题配色，且 CSS 侧 .page__bg 已写 cover，故保留在此。
        bg.style.backgroundSize = cfg.backgroundSize
            || (cfg.customButtons && cfg.customButtons.length ? "100% 100%" : "");
        root.appendChild(bg);

        if (cfg.overlay) root.appendChild(el("div", { class: "page__overlay" }));

        // 标题信息
        const info = (theme.info || {});
        if (cfg.showName !== false && info.name) {
            const meta = el("div", { class: "title-meta" }, [ el("h1", { text: info.name }) ]);
        if (cfg.showVersion !== false && info.version) {
            meta.appendChild(el("div", { class: "version", text: verLabel(info.version) }));
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

        const pageKey = pageId.replace("page_", "");
        const cfg = (theme.pages && theme.pages[pageKey]) || {};
        // 菜单页共享外观：整页衬底 + 主内容面板底色 + 侧栏按钮底色。默认值唯一来源 = 模板
        // theme.json 的 gameMenu（构建时 _deep_merge(模板, 工程) 合并，工程没写就用模板的）；
        // 单页可用 pages.<页>.backgroundColor / panelColor / sidebarButtonColor 覆盖，
        // 显式 null 表示不要该层。
        // panelColor 只服务主内容那一整块面板；侧栏本身透明、按钮底色走 sidebarButtonColor
        // （见 game-menu.css）。
        const shared = theme.gameMenu || {};
        const pickCfg = k => (cfg[k] !== undefined ? cfg[k] : shared[k]);
        const tintColor  = pickCfg("backgroundColor");
        const panelColor = pickCfg("panelColor");
        const sideBtnColor = pickCfg("sidebarButtonColor");

        if (cfg.background) {
            root.appendChild(el("div", {
                class: "page__bg",
                style: `background-image:url("${resolveAsset(cfg.background)}");`
            }));
        } else {
            root.appendChild(el("div", { class: "page__bg page__bg--solid" }));
        }

        // ① 整页衬底：压在背景图之上、内容之下的一层（半透明）纯色，用于「背景图太花，正文直接贴上去不好读」。
        //    颜色来自 gameMenu.backgroundColor（或单页覆盖），支持 rgba()；为 null 就不铺这一层。
        if (tintColor) {
            root.appendChild(el("div", {
                class: "page__tint",
                style: `background:${tintColor};`
            }));
        }
        // ② 面板底色：写成 CSS 变量，由 game-menu.css 用到 .game-menu__main（唯一消费者）。
        //    侧栏本身不用它 —— 侧栏透明。
        root.style.setProperty("--game-menu-panel", panelColor || "transparent");
        // ③ 侧栏按钮底色：写成 CSS 变量，由 .game-menu__sidebar .paper-btn 消费。
        //    默认「纯白、完全不透明」（模板 theme.json 的 gameMenu.sidebarButtonColor）；
        //    写 null 则按钮也透明（范围只剩 colors.muted 描边）。
        root.style.setProperty("--game-menu-sidebar-btn", sideBtnColor || "transparent");

        const menu = el("div", { class: "game-menu" });

        // 侧边栏停靠：依据 theme.sidebarSide（"left" / "right"，默认 "left"）给 .game-menu 加对应类，
        // 由 game-menu.css 决定网格列顺序与分隔线位置。
        const menuSide = ((theme.sidebarSide || "left") + "").toLowerCase();
        menu.classList.add("game-menu--sidebar-" + (menuSide === "right" ? "right" : "left"));

        // 侧边栏按钮顺序按 theme.json 的 sidebar（不写死）；"__common__" 展开为 theme.menusCommon
        const sidebar = el("div", { class: "game-menu__sidebar" });
        const sideOrder = resolveMenuList(
            (theme.sidebar && theme.sidebar.length) ? theme.sidebar
                : ["save", "load", "settings", "chapters", "gallery", "branches", "about", "back"],
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
                // 空槽只在缩略图区放一个居中标签；底部 meta 区不再重复写同一份文字
                //（此前「快速存档」上下出现两次、且绝对定位的 meta 会被底边裁切）。
                thumb.textContent = d.system ? d.label : "Empty slot";
            }
            slot.appendChild(thumb);
            if (filled && data.display) {
                const meta = el("div", { class: "slot__meta" });
                meta.appendChild(el("div", { class: "slot__name", text: data.display.label || "" }));
                meta.appendChild(el("div", { class: "slot__text", text: data.display.text || "" }));
                meta.appendChild(el("div", { class: "slot__time", text: data.timeStr || "" }));
                slot.appendChild(meta);
            }
            // 悬停操作提示：保存页是「写入」（空槽=保存到这里，已占用=覆盖保存），
            // 读档页只有已占用的槽能读。由 CSS 控制 hover 时浮现。
            if (isSave) {
                slot.appendChild(el("div", { class: "slot__hint", text: filled ? "覆盖保存" : "保存到这里" }));
            } else if (filled) {
                slot.appendChild(el("div", { class: "slot__hint", text: "读取此档" }));
            }
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

    /* ---------- 3.2 设置 ----------
     * **渲染什么、什么顺序，由 theme.json 的 pages.settings.sections 决定**（不写死在本文件）：
     *   "sections": [ { "title": "显示", "items": [ item… ] }, … ]
     *
     * item 的三种形态：
     *   1) 取值型控件   { "key": "textSpeed", "label": "文字显示速度", "hint": "…", "full": true }
     *      取什么控件由 settings.js 的 SPECS[key].type 决定（bool→开关 / unit→滑块 /
     *      int→带上下限的滑块 / enum→分段按钮 / action→动作下拉框）。
     *      enum 项的选项文案写在这里：{ "options": [ {"value":"window","label":"窗口"} ] }。
     *   2) 按键映射区块 { "type": "keymap", "title": "按键", "hint": "…" }
     *   3) 未知 key —— 跳过并告警（页面配置与 SPECS 不许各说各话）。
     *
     * 每一项都从 AliceADVSettings（localStorage 持久化）读当前值渲染选中态，改动写回 set()，
     * 并订阅变更保持界面同步。设置模块缺失时退化为「按默认值渲染、不可交互」。
     */
    function fillSettingsGrid(body, theme, cfg) {
        const S = global.AliceADVSettings;
        const wrap = el("div", { class: "settings" });
        const sections = (cfg && Array.isArray(cfg.sections) && cfg.sections.length)
            ? cfg.sections
            : fallbackSettingsSections();

        // 「全部静音」这类「打开即锁死其它项」的关系来自 SPECS 的 mutes，不写在页面上：
        // 页面只负责把被锁的项渲染出来，锁不锁由规格说了算。
        const muted = {};
        if (S) S.keys().forEach(k => {
            const sp = S.spec(k);
            if (sp && sp.mutes && S.get(k)) sp.mutes.forEach(m => { muted[m] = true; });
        });

        sections.forEach(sec => {
            if (!sec || !Array.isArray(sec.items)) return;
            const fields = [];
            sec.items.forEach(item => {
                const node = settingsItem(item, theme, muted);
                if (node) fields.push(node);
            });
            if (fields.length) wrap.appendChild(settingsSection(sec.title || "", fields));
        });

        body.appendChild(wrap);
    }

    /* 没配 pages.settings.sections 时的兜底：把 SPECS 里登记过的项按登记顺序铺成一页。
     * 真正的默认版面写在模板 theme.json（默认值的唯一来源），这里只为「配置缺失时页面不空白」。 */
    function fallbackSettingsSections() {
        const S = global.AliceADVSettings;
        if (!S) return [];
        return [{ title: "设置", items: S.keys().map(k => ({ key: k })) }];
    }

    // 一条 item → 一个字段节点（含控件与说明）；无法渲染时返回 null
    function settingsItem(item, theme, muted) {
        if (!item || typeof item !== "object") return null;
        if (item.type === "keymap") return keymapBlock(item, theme);
        if (!item.key) return null;
        const S = global.AliceADVSettings;
        const spec = S ? S.spec(item.key) : null;
        if (!spec) {
            console.warn("[aliceADV] 设置页引用了未登记的设置项，已跳过:", item.key);
            return null;
        }
        const label = item.label || item.key;
        let control = null;
        let field = null;
        switch (spec.type) {
            case "bool":
                // 开关类：文案就写在开关上，不再重复一行标签
                control = chipRow([chip(item.key, item.chipLabel || label)]);
                field = settingsField(null, control, item.hint, item.full);
                break;
            case "unit":
            case "int":
                control = settingSlider(item.key, spec);
                break;
            case "enum": {
                const opts = (Array.isArray(item.options) && item.options.length)
                    ? item.options
                    : spec.options.map(v => ({ value: v, label: v }));
                const disable = enumDisable(item.key);
                control = segmented(item.key, opts.map(o => ({
                    value: o.value,
                    label: o.label || o.value,
                    disabled: !!(disable && disable[o.value] && disable[o.value]())
                })));
                break;
            }
            case "action":
                control = actionSelect(item.key);
                break;
            default:
                return null;
        }
        if (!field) field = settingsField(label, control, item.hint, item.full);
        if (muted && muted[item.key]) field.classList.add("is-muted");
        return field;
    }

    /* 某些枚举值在特定环境下不可用（当前只有「全屏幕」）。这是**引擎能力判断**，
     * 不是文案，因此留在这里而不是 theme.json。 */
    function enumDisable(key) {
        const S = global.AliceADVSettings;
        if (key === "displayMode") {
            return { fullscreen: function () { return !(S && S.isFullscreenSupported && S.isFullscreenSupported()); } };
        }
        return null;
    }

    /* 分区容器：标题 + 两列字段网格 */
    function settingsSection(title, fields) {
        const sec = el("section", { class: "settings-section" });
        sec.appendChild(el("h3", { class: "settings-section__title", text: title }));
        const grid = el("div", { class: "settings-grid" });
        (fields || []).forEach(f => { if (f) grid.appendChild(f); });
        sec.appendChild(grid);
        return sec;
    }

    /* 单个字段：标签 + 控件 + 可选说明。full = 独占整行；
     * 不给 labelText 时不渲染标签行（开关类把文案写在开关上）。 */
    function settingsField(labelText, control, hint, full) {
        const f = el("div", { class: "settings-field" + (full ? " settings-field--full" : "") });
        if (labelText) f.appendChild(el("div", { class: "settings-label", text: labelText }));
        if (control) f.appendChild(control);
        if (hint) f.appendChild(el("div", { class: "settings-hint", text: hint }));
        return f;
    }

    /* 分段按钮：一组互斥选项，选中项高亮 */
    function segmented(key, options) {
        const S = global.AliceADVSettings;
        const group = el("div", { class: "seg", role: "group" });
        const items = [];
        options.forEach(opt => {
            const b = el("button", {
                type: "button", class: "seg__btn", text: opt.label,
                "data-setting": key, "data-value": opt.value
            });
            if (opt.disabled) { b.disabled = true; b.classList.add("is-disabled"); }
            b.addEventListener("click", function () {
                if (S) S.set(key, opt.value);
            });
            items.push({ node: b, value: opt.value });
            group.appendChild(b);
        });
        const sync = function () {
            const cur = S ? S.get(key) : options[0].value;
            items.forEach(it => it.node.classList.toggle("is-on", it.value === cur));
        };
        sync();
        if (S) S.onChange(function (k) { if (k === key) sync(); });
        return group;
    }

    /* 开关按钮：布尔项，带勾选标记 */
    function chip(key, label) {
        const S = global.AliceADVSettings;
        const b = el("button", { type: "button", class: "chip", "data-setting": key });
        b.appendChild(el("span", { class: "chip__mark" }));
        b.appendChild(el("span", { class: "chip__text", text: label }));
        const sync = function () { b.classList.toggle("is-on", !!(S ? S.get(key) : false)); };
        b.addEventListener("click", function () {
            if (S) S.set(key, !S.get(key));
        });
        sync();
        if (S) S.onChange(function (k) { if (k === key) sync(); });
        return b;
    }
    function chipRow(chips) {
        return el("div", { class: "chip-row" }, chips);
    }

    /* 数值滑块：
     *   unit 类型（速度 / 音量）—— 值域 0~1，右侧读百分比
     *   int 类型（毫秒）—— 值域取 SPECS 的 min~max、按 step 吸附，右侧读原值 + 单位
     * 上下限与步长都来自 settings.js 的 SPECS，不在这里再写一份，也不写进 theme.json。 */
    function settingSlider(key, spec) {
        const S = global.AliceADVSettings;
        const isInt = !!(spec && spec.type === "int");
        const lo = (isInt && spec.min != null) ? spec.min : 0;
        const hi = (isInt && spec.max != null) ? spec.max : 1;
        const step = (isInt && spec.step) ? spec.step : 0;
        const toRatio = v => (hi === lo) ? 0 : Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
        const fromRatio = r => {
            let v = lo + (hi - lo) * r;
            if (step) v = Math.round(v / step) * step;
            v = Math.min(hi, Math.max(lo, v));
            return isInt ? Math.round(v) : v;
        };
        const read = v => isInt ? (String(v) + (spec.unit || "")) : (Math.round(v * 100) + "%");

        const row = el("div", { class: "slider-row" });
        const root = el("div", { class: "slider", "data-setting": key });
        const track = el("div", { class: "slider__track" });
        const fill = el("div", { class: "slider__fill" });
        const thumb = el("div", { class: "slider__thumb" });
        track.appendChild(fill); track.appendChild(thumb);
        root.appendChild(track);
        const readout = el("span", { class: "slider__value" });
        row.appendChild(root); row.appendChild(readout);

        const paint = function (v) {
            const pct = Math.round(toRatio(v) * 100);
            thumb.style.left = pct + "%";
            fill.style.width = pct + "%";
            readout.textContent = read(v);
        };
        const sync = function () { paint(S ? S.get(key) : spec.def); };
        // 舞台是整体 scale() 缩放的，用 getBoundingClientRect 取到的就是屏幕实际坐标，
        // 因此按 clientX 换算比例天然正确，不需要再除缩放系数。
        const ratioAt = function (clientX) {
            const r = track.getBoundingClientRect();
            if (!r.width) return 0;
            return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
        };
        root.addEventListener("pointerdown", function (e) {
            if (!S) return;
            e.preventDefault();
            if (root.setPointerCapture) { try { root.setPointerCapture(e.pointerId); } catch (err) {} }
            S.set(key, fromRatio(ratioAt(e.clientX)));
            const move = function (ev) { S.set(key, fromRatio(ratioAt(ev.clientX))); };
            const up = function () {
                root.removeEventListener("pointermove", move);
                root.removeEventListener("pointerup", up);
                root.removeEventListener("pointercancel", up);
            };
            root.addEventListener("pointermove", move);
            root.addEventListener("pointerup", up);
            root.addEventListener("pointercancel", up);
        });
        sync();
        if (S) S.onChange(function (k) { if (k === key) sync(); });
        return row;
    }

    /* 动作下拉框（值域 = input.js 的动作表）：给「快捷轮盘」的五个方向选动作。
     * 「无」= 该方向不装动作。动作列表不在这里写死，新增动作不必改本文件。 */
    function actionSelect(key) {
        const S = global.AliceADVSettings;
        const I = global.AliceADVInput;
        const sel = el("select", { class: "sel", "data-setting": key });
        sel.appendChild(el("option", { value: "none", text: "无" }));
        if (I) I.actions().forEach(a => sel.appendChild(el("option", { value: a.id, text: a.label })));
        const sync = function () { sel.value = S ? String(S.get(key)) : "none"; };
        sel.addEventListener("change", function () { if (S) S.set(key, sel.value); });
        sync();
        if (S) S.onChange(function (k) { if (k === key) sync(); });
        return sel;
    }

    /* ---------- 3.2.1 按键映射区块 ----------
     * 每个动作一行：动作名 / 推荐方案下拉框 / 当前生效的键位。
     * 下拉框的选项 = 开发者写在 theme.json input.presets 里的**推荐方案**（名字由作者定）
     *   + 「自定义」。选推荐方案 = 跟随作者给的默认映射（且日后作者改了推荐，玩家自动跟着变）；
     *   选自定义 = 玩家自己按下按键，存进 localStorage（aliceadv.bindings.<游戏名>）。
     * 这是「推荐」而非「强绑」：玩家随时可以逐动作改，改动只落本地、不改产物。
     */
    function keymapBlock(item, theme) {
        const I = global.AliceADVInput;
        const wrap = el("div", { class: "keymap" });
        if (item.title) wrap.appendChild(el("div", { class: "keymap__title", text: item.title }));
        if (item.hint) wrap.appendChild(el("div", { class: "settings-hint", text: item.hint }));
        if (!I) {
            wrap.appendChild(el("div", { class: "settings-hint",
                text: "输入系统未加载（style/input.js 缺失），本页无法修改按键映射。" }));
            return wrap;
        }
        const presets = I.presets();
        if (!presets.length) {
            wrap.appendChild(el("div", { class: "settings-hint",
                text: "本作未提供推荐按键方案（theme.json 的 input.presets 为空），所有动作都需自行设定。" }));
        }
        const list = el("div", { class: "keymap__list" });
        I.actions().forEach(a => list.appendChild(keymapRow(a, presets)));
        wrap.appendChild(list);
        return wrap;
    }

    function keymapRow(a, presets) {
        const I = global.AliceADVInput;
        const row = el("div", { class: "keymap__row", "data-action": a.id });

        function render() {
            clearChildren(row);
            row.appendChild(el("div", { class: "keymap__action", text: a.label }));

            // ① 推荐方案 / 自定义
            const sel = el("select", { class: "keymap__select" });
            presets.forEach(p => {
                const desc = I.describeBindings(I.presetBindings(p.id, a.id)) || "未绑定";
                sel.appendChild(el("option", { value: "p:" + p.id, text: p.label + "：" + desc }));
            });
            sel.appendChild(el("option", { value: "custom", text: "自定义" }));
            const chosen = I.selection(a.id);
            sel.value = (chosen.custom || !chosen.preset || !presets.length) ? "custom" : "p:" + chosen.preset;
            // 玩家选过的推荐方案已被作者删掉：value 落空 → 回落自定义，不静默错位
            if (!sel.value) sel.value = "custom";
            sel.addEventListener("change", function () {
                if (sel.value === "custom") {
                    const c = I.selection(a.id);
                    I.setSelection(a.id, { custom: (c.custom || []).slice() });
                    render();
                    beginCapture();          // 选「自定义」即进入捕获，少点一次
                } else {
                    I.setSelection(a.id, { preset: sel.value.slice(2) });
                    render();
                }
            });
            row.appendChild(sel);

            // ② 当前生效的键位（自定义时可直接删/加）
            const now = I.selection(a.id);
            const custom = !!now.custom;
            const keys = custom ? now.custom : I.bindingsFor(a.id);
            const box = el("div", { class: "keymap__keys" });
            if (keys.length) {
                keys.forEach(b => {
                    const tag = el("span", { class: "keytag" });
                    tag.appendChild(el("span", { class: "keytag__text", text: I.describeBinding(b) }));
                    if (custom) {
                        const del = el("button", { type: "button", class: "keytag__del", text: "×" });
                        del.setAttribute("title", "移除这个按键");
                        del.addEventListener("click", function () {
                            I.setSelection(a.id, { custom: keys.filter(x => x !== b) });
                            render();
                        });
                        tag.appendChild(del);
                    }
                    box.appendChild(tag);
                });
            } else {
                box.appendChild(el("span", { class: "keymap__empty", text: "未绑定" }));
            }
            if (custom) {
                const add = el("button", { type: "button", class: "keymap__add", text: "＋ 添加按键" });
                add.addEventListener("click", beginCapture);
                box.appendChild(add);
                const clear = el("button", { type: "button", class: "keymap__clear", text: "清空" });
                clear.addEventListener("click", function () {
                    I.setSelection(a.id, { custom: [] });
                    render();
                });
                box.appendChild(clear);
            }
            row.appendChild(box);

            // ③ 撞键提示：同一个键被两个动作用，玩家的预期就不成立了，这里如实说出来
            const conf = I.conflicts(a.id);
            if (conf.length) {
                row.appendChild(el("div", { class: "keymap__warn",
                    text: "与「" + conf.map(id => I.actionLabel(id)).join("、") + "」使用了相同的按键，"
                         + "按下时按优先级只触发其中一个。" }));
            }

            /* 捕获期间把「＋ 添加按键」变成提示语，取消或完成都要还原 ——
             * 因此渲染要能被 beginCapture 反过来调用，且取消走 input 的 onCancel。 */
            function beginCapture() {
                const addBtn = box.querySelector(".keymap__add");
                if (addBtn) addBtn.textContent = "请按下要绑定的按键…（Esc 取消）";
                I.captureStart(function (binding) {
                    const cur = I.selection(a.id).custom || [];
                    if (cur.indexOf(binding) === -1) cur.push(binding);
                    I.setSelection(a.id, { custom: cur });
                    render();
                }, render);
            }
        }

        render();
        return row;
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
            const thumbImg = (theme.thumb && theme.thumb.placeholder) || "";
            if (!g.locked && thumbImg) img.style.backgroundImage = `url("${assetUrl(thumbImg)}")`;
            item.appendChild(img);
            item.appendChild(el("div", { class: "gallery-item__label", text: g.name }));
            grid.appendChild(item);
        });
        body.appendChild(grid);
    }

    /* ---------- 3.5 关于页 ----------
     * 衬底分两层，通用机制铺整页那一层（见 buildGameMenuPage：.page__tint 用
     * gameMenu.backgroundColor）；**白纸那一层由本页自己承担**（.about-panel，
     * 见 about.css）：关于页的正文排成**定宽的一栏**，白底（纸）只包住这一栏并水平居中，
     * 纸的左右两侧直接透出整页衬底，所以主内容区 .game-menu__main 在本页被去掉背景/投影/内边距。
     * 正文来自工程根 about.txt（见 ABOUT_TEXT 的说明），空行分段。
     *
     * 版本行：两个版本号合成**一行**、放一个圆角框里（.about-meta，样式在 about.css）。
     * 「引擎名 + 版本号」**整体是一个链接**（指向引擎仓库，URL 来自 __ENGINE__.repo，唯一来源
     * __init__.py 的 ENGINE_REPO），链接不带下划线、只靠 hover 变色。
     * 原先另起两段的「由 aliceADV 引擎驱动 (MIT License)」与「引擎仓库: …」已按要求移除
     * —— 仓库地址改为由这一处链接承担，不再重复出现。 */
    function fillAbout(body, theme, cfg) {
        const info = theme.info || {};
        const aboutText = (ABOUT_TEXT || "").trim();
        // 白纸由 .about-panel 承担（about.css：纸宽包住正文栏 + 居中 + 纸内滚动，底色 --game-menu-panel）；
        // 这里只搭「纸 + 正文」这层结构，不写内联样式。
        const panel = el("div", { class: "about-panel" });
        const c = el("div", { class: "about-content" });
        c.appendChild(el("h2", { text: info.name || "游戏名" }));

        // 版本行：同框同行，中间一条细竖线分隔
        const meta = el("div", { class: "about-meta" });
        if (info.version) {
            meta.appendChild(el("span", { class: "about-meta__item",
                                         text: "游戏版本 " + verLabel(info.version) }));
        }
        if (ENGINE_LABEL) {
            if (info.version) meta.appendChild(el("span", { class: "about-meta__sep" }));
            const eng = el("span", { class: "about-meta__item" }, "引擎 ");
            // 链接圈住「引擎名 + 版本号」**整体**。文案直接用 ENGINE_LABEL（它本来就是这两截拼好的），
            // 不要在这里再拼一次——两处拼接迟早会不一致。
            eng.appendChild(el("a", {
                class: "about-meta__link",
                href: ENGINE_REPO,
                target: "_blank",
                rel: "noopener noreferrer",
                text: ENGINE_LABEL
            }));
            meta.appendChild(eng);
        }
        if (meta.childNodes.length) c.appendChild(meta);

        // 没有 about.txt（或内容为空）就不出正文：游戏名与版本行是引擎自带的，与作者正文是两回事。
        //
        // 空行按「真实行高」逐行还原（2026-09-29 第三次修正）：
        //   第一版 split(/\n+/) 一刀切、空一行/空两行无法区分；第二版 pre-wrap，但空行没有内容、
        //   行盒高度塌缩到接近 0，空行仍没占住一行文字高度（用户报「空行也要真实还原文字的高度」）。
        //   终版：按 \n 切成一行一个块 —— 非空行 = 一行文字（长行仍按栏宽折行，折几行就多高）；
        //   空行 = .about-blank，高度显式等于一行文字高度（line-height）。于是「空一行 = 一行文字高度、
        //   空两行 = 两行高度」逐行还原，且这个高度就是正文真正的一行高度，不是数值硬凑的段距。
        //   用 textContent 写入：正文是作者自由文本，不会被当 HTML 解析。
        if (aboutText) {
            const body = el("div", { class: "about-body" });
            aboutText.split("\n").forEach(line => {
                const d = el("div", { class: "about-line" + (line.trim() ? "" : " about-blank") });
                d.textContent = line;
                body.appendChild(d);
            });
            c.appendChild(body);
        }
        panel.appendChild(c);
        body.appendChild(panel);
    }

    /* ---------- 3.6 入口：fillPageBody ---------- */
    function fillPageBody(pageId, body, theme, cfg) {
        switch (pageId) {
            case "page_save":     return fillSlotsGrid(body, theme, cfg, true);
            case "page_load":     return fillSlotsGrid(body, theme, cfg, false);
            case "page_settings": return fillSettingsGrid(body, theme, cfg);
            case "page_chapters": return fillChapterList(body, theme);
            case "page_branches": return fillBranchList(body, theme);
            case "page_gallery":  return fillGallery(body, theme);
            case "page_about":    return fillAbout(body, theme, cfg);
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
        // 记下「开场兜底背景」：舞台复位（script.js 的 resetStage）把它还原回来，
        // 这样重新开始时的画面与刚打开页面时完全一致，而不是空成 CSS 的渐变天空。
        bg.dataset.fallbackBg = cfg.background ? `url("${resolveAsset(cfg.background)}")` : "";
        root.appendChild(bg);

        // 转场幕布：bg{transition:"fade"} 的「落下→换图→升起」由它实现（script.js 控制 is-on）。
        // 必须紧跟背景层：与之同为 z-index 0，靠 DOM 顺序压在背景之上、立绘层(z-index 1)之下。
        // 时长/颜色的默认值写在 stage.css，这里只在 theme.json 显式给出时覆盖。
        if (cfg.fadeColor) root.style.setProperty("--stage-fade-color", cfg.fadeColor);
        if (cfg.fadeMs != null) {
            root.style.setProperty("--stage-fade-ms", typeof cfg.fadeMs === "number" ? cfg.fadeMs + "ms" : cfg.fadeMs);
        }
        root.appendChild(el("div", { class: "stage-fade" }));

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

        // 通知条 / 快进指示条（对应 Ren'Py 的 notify 与 skip_indicator）。
        // 位置由 theme.json 的 notifyYpos / skipYpos 决定，外观在 stage.css。
        // 骨架只在这里建一次：运行时（engine.js 的 notify / script.js 的 syncPlaybackMode）
        // 仅切换 .is-active 与文字 —— 舞台重建（换主题 / 重新 buildAll）后元素仍在，不会丢。
        root.appendChild(el("div", { class: "notify" }, [
            el("div", { class: "notify__inner" })
        ]));

        const skipInner = el("div", { class: "skip-indicator__inner" }, [
            el("span", { class: "skip-indicator__label", text: I18N.skipIndicator })
        ]);
        // 三个三角依次闪烁（阶段号与 CSS 的 nth-child 对齐：1=文案，2/3/4=三角）
        for (let i = 0; i < 3; i++) {
            skipInner.appendChild(el("span", { class: "skip-indicator__arrow", text: "▸" }));
        }
        root.appendChild(el("div", { class: "skip-indicator" }, [skipInner]));

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

    /* 资源路径 → 绝对 URL（基于 document.baseURI，即 index.html 所在目录）。
     * 为什么必须转绝对：CSS 变量里的 url() 由「使用该变量的样式表」解析（base.css 在 style/、
     * stage.css 在 style/pages/，层级不同），内联样式则由「文档」解析——同一个相对路径会得出
     * 不同结果。统一转成绝对 URL 后，无论在哪层样式表里消费都指向同一张图。 */
    function assetUrl(p) {
        const r = resolveAsset(p);
        if (!r) return "";
        if (/^(data:|blob:)/.test(r)) return r;
        try { return new URL(r, document.baseURI).href; } catch (e) { return r; }
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
        // 容器类名兜底：style/pages/*.css 的页面级规则以 .page_<名> 作作用域，
        // 外壳 HTML 少写该类名时整页样式会静默失效（踩过：save/load/about 差异化样式全没生效），
        // 这里按 id 统一补齐。
        document.querySelectorAll(".page[id^='page_']").forEach(n => n.classList.add(n.id));
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
        // 构建产物会把主题内联为 window.__THEME__（无需 fetch，file:// 直接可用）；
        // 关于页正文同理内联为 window.__ABOUT__（见 builder.py 的 resolve_about）。
        if (global.__THEME__) {
            ABOUT_TEXT = (typeof global.__ABOUT__ === "string") ? global.__ABOUT__ : "";
            return global.__THEME__;
        }

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
                    // 空文件不算「有正文」：不能让它把兼容值清成空串，
                    // 否则关于页的正文会随「文件在不在」而非「内容写没写」时有时无。
                    if (r3.ok) {
                        const t = await r3.text();
                        if (t.trim()) ABOUT_TEXT = t;
                    }
                } catch (_) {}
                // 兼容：旧工程把正文写在 theme.json 的 about 里（已废弃，构建时会提示迁移）
                if (!ABOUT_TEXT && typeof loaded.about === "string") ABOUT_TEXT = loaded.about;
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
