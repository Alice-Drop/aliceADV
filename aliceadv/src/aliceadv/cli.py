# =========================================================
# aliceADV cli — `aliceadv` 命令行入口
#
# 子命令：
#   aliceadv create  <工程目录> [--name 游戏名] [--force]   创建工程（复制引擎模板）
#   aliceadv build   <工程目录>                             构建工程 → dist/web/
#   aliceadv rpy2adv <script.rpy> <images_dir> <out_dir>    Ren'Py 剧本 → story/ JSON
#   aliceadv gui2theme <gui.rpy> <theme.json> [--apply]     Ren'Py 布局 → theme.json
#
# 环境变量：
#   ALICEADV_TEMPLATE  覆盖引擎模板目录（默认包内 aliceadv/template/）。
#                      供将来其他语言实现的编译器复用同一份模板。
# =========================================================
import argparse
import sys


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="aliceadv",
        description="aliceADV 引擎命令行工具：创建工程模板、构建 web 产物、Ren'Py 资源迁移。")
    parser.add_argument("--version", action="store_true", help="显示版本号")
    sub = parser.add_subparsers(dest="cmd")

    sp = sub.add_parser("create", help="创建工程：复制引擎模板到目标目录")
    sp.add_argument("dir", nargs="?", help="目标工程目录（缺省交互输入）")
    sp.add_argument("--name", help="写入 info.json 的游戏名")
    sp.add_argument("--force", action="store_true", help="目标目录非空时跳过二次确认")

    bp = sub.add_parser("build", help="构建工程 → <工程>/dist/web/")
    bp.add_argument("dir", nargs="?", help="工程目录（缺省交互输入）")

    rp = sub.add_parser("rpy2adv", help="Ren'Py 剧本(.rpy) → aliceADV story/ JSON")
    rp.add_argument("rpy", help="Ren'Py script.rpy 路径")
    rp.add_argument("images_dir", help="Ren'Py images/ 目录")
    rp.add_argument("out_dir", help="输出的 story/ 目录")

    gp = sub.add_parser("gui2theme", help="Ren'Py gui.rpy 布局 → theme.json（换算 + 写入）")
    gp.add_argument("gui_rpy", help="Ren'Py gui.rpy 路径")
    gp.add_argument("theme_json", help="工程 theme.json 路径")
    gp.add_argument("--apply", action="store_true", help="写入 theme.json（缺省只预览）")

    args = parser.parse_args(argv)

    from . import ENGINE_VERSION, __version__
    if args.version:
        print(f"aliceADV {__version__} (engine {ENGINE_VERSION})")
        return 0
    if not args.cmd:
        parser.print_help()
        return 2

    if args.cmd == "create":
        from .creator import create_project
        target = args.dir or input("请输入工程文件夹路径：").strip()
        if not target:
            print("✗ 未提供路径。用法: aliceadv create <工程目录>")
            return 2
        info = {"name": args.name} if args.name else None
        ok = create_project(target, info=info,
                            interactive=not args.force and not info)
        return 0 if ok else 1

    if args.cmd == "build":
        from .builder import build_project
        target = args.dir or input("请输入要构建的工程目录路径：").strip()
        if not target:
            print("✗ 未提供路径。用法: aliceadv build <工程目录>")
            return 2
        return 0 if build_project(target) else 1

    if args.cmd == "rpy2adv":
        from .tools import rpy2adv
        return rpy2adv.main([args.rpy, args.images_dir, args.out_dir])

    if args.cmd == "gui2theme":
        from .tools import gui2theme
        tool_args = [args.gui_rpy, args.theme_json]
        if args.apply:
            tool_args.append("--apply")
        return gui2theme.main(tool_args)

    return 2


if __name__ == "__main__":
    sys.exit(main())
