# -*- coding: utf-8 -*-
"""
一键安装 —— 把本套件部署成一台新机器上的可运行协同工作流。

用法（在本文件所在目录执行）:

  python install.py --target D:\\ai-workflow
  python install.py --target D:\\ai-workflow --project P001_第一个项目
  python install.py --target D:\\ai-workflow --write-mcp

它会做六件事:
  1. 建控制层根目录
  2. 复制协议总纲 + 8 张角色卡，并把 D:\AIOA\AI协同工作流_可复制套件\05_应用\test\smoke-wf-root 替换成真实路径
  3. 复制 tools/ 与根目录批处理
  4. 建第一个项目目录树（调 new_project.py）
  5. 生成 MCP 配置片段 _mcp_config.json
  6. 打印剩余的人工步骤

不做: 不装 Python 包、不改你已有的 mcp.json（除非显式 --write-mcp）
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent  # 套件根
PLACEHOLDER = "D:\AIOA\AI协同工作流_可复制套件\05_应用\test\smoke-wf-root"

PY_FILES = ["lock.py", "wait_files.py", "new_project.py", "pause.py",
            "status.py", "tidy.py", "smoke_test.py"]
ROOT_PY_FILES = ["file_watcher_mcp.py"]
BAT_FILES = ["开机检查.bat", "暂停全部.bat", "恢复全部.bat", "状态.bat"]


def log(msg: str) -> None:
    print(msg)


def replace_root(text: str, root: Path) -> str:
    return text.replace(PLACEHOLDER, str(root))


def write_doc(src: Path, dst: Path, root: Path, force: bool) -> str:
    """写入前检查是否已存在——已存在的自定义版本不覆盖。"""
    if dst.exists() and not force:
        old = dst.read_text(encoding="utf-8", errors="ignore")
        if PLACEHOLDER not in old:
            return "skip"
    dst.write_text(replace_root(src.read_text(encoding="utf-8"), root), encoding="utf-8")
    return "write"


def copy_docs(root: Path, force: bool) -> None:
    src = KIT / "02_协议总纲.md"
    dst = root / "00_协议总纲.md"
    act = write_doc(src, dst, root, force)
    log(f"  [协议] {dst.name}" + ("（已存在，保留原文件）" if act == "skip" else ""))

    skipped = 0
    cards = sorted((KIT / "02_角色卡").glob("*.md"))
    for c in cards:
        out = root / c.name
        if write_doc(c, out, root, force) == "skip":
            skipped += 1
    log(f"  [角色] {len(cards) - skipped} 张已写入"
        + (f"，{skipped} 张已存在保留原样（加 --force 覆盖）" if skipped else ""))


def copy_tools(root: Path) -> None:
    tdir = root / "tools"
    tdir.mkdir(parents=True, exist_ok=True)
    for name in PY_FILES:
        src = KIT / "03_工具" / name
        if src.exists():
            shutil.copy2(src, tdir / name)
    log(f"  [工具] {tdir} ({len(PY_FILES)} 个脚本)")

    for name in ROOT_PY_FILES:
        src = KIT / "03_工具" / name
        if src.exists():
            shutil.copy2(src, root / name)
    log(f"  [MCP 服务] {root / 'file_watcher_mcp.py'}")

    for name in BAT_FILES:
        src = KIT / "03_工具" / name
        if src.exists():
            shutil.copy2(src, root / name)
    log(f"  [批处理] 已放到根目录（双击可用）")


def build_project(root: Path, project: str) -> None:
    # 已有有效指针时不要切项目——重装不该把正在跑的项目切走
    pointer = root / "_ACTIVE_PROJECT.md"
    if pointer.exists():
        for line in pointer.read_text(encoding="utf-8").splitlines():
            if line.startswith("root:"):
                cur = Path(line.split(":", 1)[1].strip())
                if cur.is_dir():
                    log(f"  [项目] 已存在有效指针，保持不变：{cur.name}")
                    return
    np = root / "tools" / "new_project.py"
    r = subprocess.run([sys.executable, str(np), project],
                       capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        log("  [项目] 建树失败：" + (r.stderr or r.stdout).strip())
        return
    log(f"  [项目] {project} 目录树已建，指针已指向它")


def write_mcp(root: Path) -> Path:
    cfg = {
        "mcpServers": {
            "file-watcher": {
                "command": sys.executable,
                "args": ["-u", str(root / "file_watcher_mcp.py")],
                "env": {"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
            }
        }
    }
    out = root / "_mcp_config.json"
    out.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"  [MCP] 片段已生成：{out}")
    return out


def merge_mcp(root: Path) -> None:
    """把 file-watcher 合并进 ~/.workbuddy-ai/mcp.json，保留其它 server。"""
    home = Path.home() / ".workbuddy-ai" / "mcp.json"
    cfg = json.loads((root / "_mcp_config.json").read_text(encoding="utf-8"))
    existing = {"mcpServers": {}}
    if home.exists():
        try:
            existing = json.loads(home.read_text(encoding="utf-8"))
        except Exception:
            backup = home.with_suffix(".json.bak")
            shutil.copy2(home, backup)
            log(f"  [MCP] 原文件无法解析，已备份到 {backup.name}")
    existing.setdefault("mcpServers", {}).update(cfg["mcpServers"])
    home.parent.mkdir(parents=True, exist_ok=True)
    home.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"  [MCP] 已合并写入 {home}")


def check_env(root: Path) -> None:
    log("\n环境自检：")
    log(f"  Python : {sys.version.split()[0]}  ({sys.executable})")
    missing = []
    for mod in ("mcp", "watchdog"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        log(f"  缺包   : {', '.join(missing)}")
        log(f"  修复   : {sys.executable} -m pip install " + " ".join(missing))
    else:
        log("  依赖   : mcp / watchdog 已装")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True, help="控制层根目录，例如 D:\\ai-workflow")
    ap.add_argument("--project", default="P001_第一个项目", help="首个项目名")
    ap.add_argument("--write-mcp", action="store_true", help="直接合并写入 ~/.workbuddy-ai/mcp.json")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的协议与角色卡（默认保留你改过的）")
    args = ap.parse_args()

    root = Path(args.target).expanduser().resolve()
    log(f"安装到：{root}\n")

    root.mkdir(parents=True, exist_ok=True)
    copy_docs(root, args.force)
    copy_tools(root)
    build_project(root, args.project)
    write_mcp(root)
    if args.write_mcp:
        merge_mcp(root)
    check_env(root)

    log("\n" + "=" * 60)
    log("安装完成。剩下三步必须人工做：")
    log("=" * 60)
    log("1) 装依赖（若上面报缺包）：")
    log(f"   {sys.executable} -m pip install mcp watchdog")
    log("2) 注册 MCP 服务器：")
    if args.write_mcp:
        log("   已自动写入。打开 WorkBuddy → 连接器管理 → 右上角自定义连接器 → 对 file-watcher 点「信任」。")
    else:
        log(f"   把 {root / '_mcp_config.json'} 的内容合并进 ~/.workbuddy-ai/mcp.json，")
        log("   然后在连接器管理右上角对 file-watcher 点「信任」。")
    log("3) 开 8 个对话窗口，各贴一张角色卡：")
    for c in sorted((KIT / "02_角色卡").glob("*.md")):
        log(f"   {c.name}  →  {root / c.name}")
    log("   顺序：01 → 02 → 04/05 → 03/06/08 → 07（总控先起，否则没人建目录树）")
    log("\n验证：python tools\\smoke_test.py --root " + str(root))
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    raise SystemExit(main())
