# -*- coding: utf-8 -*-
"""
新建 / 切换项目（三层七员工协同）

用法:
  python tools\\new_project.py P002_贪吃蛇      # 新建并切换
  python tools\\new_project.py --switch P001_链路冒烟测试
  python tools\\new_project.py --list
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

CONTROL_ROOT = Path(__file__).resolve().parent.parent
PROJECTS = CONTROL_ROOT / "projects"
POINTER = CONTROL_ROOT / "_ACTIVE_PROJECT.md"

TREE = [
    "00_人类总控/汇报终端",
    "01_总控/收件箱", "01_总控/已处理", "01_总控/发件箱",
    "01_总控/来自实施层", "01_总控/成果区/_待发布",
    "02_实施布置/收件箱", "02_实施布置/已处理", "02_实施布置/发件箱", "02_实施布置/成果接收",
    "03_高级代码/收件箱", "03_高级代码/已处理", "03_高级代码/技术决策库",
    "04_代码员工/收件箱", "04_代码员工/已处理", "04_代码员工/代码产出",
    "05_Debug/收件箱", "05_Debug/已处理", "05_Debug/测试报告", "05_Debug/成果移交", "05_Debug/经验库",
    "06_美工/收件箱", "06_美工/已处理", "06_美工/美工产出",
    "07_部署/收件箱", "07_部署/已处理", "07_部署/部署报告",
    "08_智囊/收件箱", "08_智囊/已处理", "08_智囊/审校库",
]

READY_DIRS = ["01_总控", "02_实施布置", "03_高级代码", "04_代码员工",
              "05_Debug", "06_美工", "07_部署", "08_智囊"]


def build(root: Path) -> None:
    for rel in TREE:
        (root / rel).mkdir(parents=True, exist_ok=True)
    # 已存在的开关与版本号不得重置——重装/重复建树会把版本号清零，是事故
    gs = root / "01_总控/发件箱/_GLOBAL_STATUS.md"
    if not gs.exists():
        gs.write_text("status: ACTIVE\n", encoding="utf-8")
    ver = root / "01_总控/发件箱/_VERSION.md"
    if not ver.exists():
        ver.write_text("version: 0\n", encoding="utf-8")
    for d in READY_DIRS:
        f = root / d / "_READY.md"
        if not f.exists():
            f.write_text("# 就绪台账\n", encoding="utf-8")
    guide = root / "02_实施布置/设计总纲.md"
    if not guide.exists():
        guide.write_text(
            "# 设计总纲（占位，待实施布置补充）\n\n"
            "## 技术栈\n待补充\n\n## 模块划分\n待补充\n\n"
            "## 接口约定\n待补充\n\n## 验收基线\n待补充\n",
            encoding="utf-8")
    profile = root / "_PROJECT.md"
    if not profile.exists():
        profile.write_text(
            f"# 项目档案（每个项目一份，员工启动时读取）\n\n"
            f"name: {root.name}\n"
            f"title: 待补充\n"
            f"code_root: none\n"
            f"deploy_target: 待定\n"
            f"baseline: none\n"
            f"created: {datetime.now():%Y-%m-%d}\n\n"
            "## 说明\n\n"
            "- `code_root` = 代码实际所在地。既有项目请填真实源码目录，员工一律在它下面作业。\n"
            "- `code_root: none` 表示纯新建，代码写 `04_代码员工\\代码产出\\{ID}\\`。\n"
            "- `baseline` = 需求与验收的权威依据文件（放项目根）。\n",
            encoding="utf-8")


def write_pointer(name: str, root: Path) -> None:
    POINTER.write_text(
        "# 当前项目指针（唯一入口，只有人类改这个文件）\n\n"
        f"project: {name}\n"
        f"root: {root}\n"
        "status: ACTIVE\n"
        f"updated: {datetime.now():%Y-%m-%d %H:%M}\n\n"
        "## 用法\n\n"
        "- 切项目：改上面 3 行（project / root / status），所有员工下一轮自动跟过去。\n"
        "- 新建项目：运行 `python D:\\workbuddy.ai\\games\\tools\\new_project.py P002_项目名`\n"
        "- 暂停全部：把 status 改成 `PAUSED`。\n",
        encoding="utf-8")


def main() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if args[0] == "--list":
        if not PROJECTS.exists():
            print("（还没有项目）")
            return 0
        for p in sorted(PROJECTS.iterdir()):
            if p.is_dir():
                print(" -", p.name)
        return 0

    switch_only = args[0] == "--switch"
    name = args[1] if switch_only and len(args) > 1 else args[0]
    if not name or name.startswith("-"):
        print("缺少项目名，例如：P002_贪吃蛇")
        return 1

    root = PROJECTS / name
    if switch_only:
        if not root.is_dir():
            print(f"项目不存在：{root}")
            return 1
    else:
        if root.is_dir():
            print(f"项目已存在，仅切换指针：{root}")
        build(root)
        print(f"已建目录树：{root}")

    write_pointer(name, root)
    print(f"已切换当前项目 -> {name}")
    print(f"人类窗口：{root / '00_人类总控' / '汇报终端'}")
    print(f"投需求到：{root / '01_总控' / '收件箱'}  文件名 [需求]_xxx.md")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    raise SystemExit(main())
