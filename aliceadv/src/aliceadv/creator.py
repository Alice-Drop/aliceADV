# =========================================================
# aliceADV creator — 工程创建器
#
# 把引擎模板（aliceadv/template/）复制到一个新的「用户工程目录」。
# 用户不修改模板，而是在自己的工程目录里编写 theme.json / story 等。
#
# 两种用法：
#   1) 命令行：   aliceadv create <工程目录> [--name 游戏名]
#   2) 函数调用： create_project(path, info={...}, interactive=False)
#      - 可传入 info（游戏名/版本等），复制完成后写入 info.json。
#      - 函数调用默认不做二次确认（interactive=False）。
#
# 注意：引擎标记 .aliceadv_engine 与引擎运行时（index.html / style/）
#       不会复制进工程——前者属于模板本身，后者由 build 时装配进 dist/web/。
# =========================================================
import json
import os
import shutil

from . import ENGINE_MARKER, template_path

# 从模板复制到工程的模板项（只有「内容」：素材 / 剧本 / 配置 / 文档）。
# 网页外壳 index.html 与引擎运行时 style/ **不进工程目录**——
# 由 builder 在构建时装配进 dist/web/。这样升级引擎后重新 build 即生效，
# 工程目录始终只保存内容。
TEMPLATE_ITEMS = [
    "gui",
    "images",
    "audio",
    "story",
    "theme.json",
    "info.json",
    "about.txt",
    "documents",
]


def create_project(project_dir, info=None, interactive=True):
    """在 project_dir 创建一个 aliceADV 工程（复制引擎模板）。

    :param project_dir: 目标工程文件夹路径
    :param info:        可选 dict（如 {"name": "我的游戏"}），复制完成后写入 info.json
    :param interactive: True=交互模式（非空目录需二次确认）；函数调用建议 False
    :return:            是否成功创建
    """
    project_dir = os.path.abspath(project_dir)
    os.makedirs(project_dir, exist_ok=True)

    existing = os.listdir(project_dir)
    if existing and interactive and not info:
        print("目标文件夹非空，包含：")
        for f in existing:
            print("  " + f)
        ans = input("确认覆盖并继续创建工程？(y/N) ").strip().lower()
        if ans != "y":
            print("已取消。")
            return False

    # 复制模板
    tpl = template_path()
    for item in TEMPLATE_ITEMS:
        src = os.path.join(tpl, item)
        dst = os.path.join(project_dir, item)
        if not os.path.exists(src):
            continue
        if os.path.isdir(src):
            if os.path.exists(dst):
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)

    # 注：工程目录不含 index.html / style/（那是引擎运行时），
    # 因此这里无需做 CSS 路径重写——重写统一由 builder 在 dist/web/ 中完成。

    # 写入 info.json（函数调用 / 带 info 时使用；不覆盖用户已手动设定的非空字段）
    if info:
        ip = os.path.join(project_dir, "info.json")
        base = {}
        if os.path.isfile(ip):
            try:
                base = json.load(open(ip, "r", encoding="utf-8"))
            except Exception:
                base = {}
        for k, v in info.items():
            if v is not None:
                base[k] = v
        with open(ip, "w", encoding="utf-8") as f:
            json.dump(base, f, ensure_ascii=False, indent=2)

    print("✓ 已创建/更新工程：" + project_dir)
    print("  下一步: 修改 theme.json / story/ 后运行  aliceadv build " + project_dir)
    return True
