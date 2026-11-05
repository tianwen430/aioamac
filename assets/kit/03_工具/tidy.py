# -*- coding: utf-8 -*-
"""
瘦身工具 —— 归档历史、滚动台账、防止目录无限膨胀。

用法:
  python tools\\tidy.py            # 预览（不实际改动）
  python tools\\tidy.py --apply    # 执行

做四件事:
  1. 各工位 已处理\\ 下的文件按月份移入 已处理\\YYYY-MM\\
  2. 汇报终端 进度_*.md / 系统状态_*.md 按月移入 _archive\\
  3. _READY.md 超过 50 行时，把前面的移到 _archive\\READY_YYYY-MM.md
  4. _HEARTBEAT.md 只保留最近 5 行
不做: 删除任何文件、打包成果区（那是人工决策）
"""
from __future__ import annotations

import shutil
import sys
from datetime import datetime
from pathlib import Path

from _workflow_config import load_stations, entry_folder

CONTROL_ROOT = Path(__file__).resolve().parent.parent
POINTER = CONTROL_ROOT / "_ACTIVE_PROJECT.md"
STATIONS = load_stations(CONTROL_ROOT)

APPLY = "--apply" in sys.argv


def project_root() -> Path:
    for line in POINTER.read_text(encoding="utf-8").splitlines():
        if line.startswith("root:"):
            return Path(line.split(":", 1)[1].strip())
    raise SystemExit("指针里没有 root 字段")


def move(p: Path, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / p.name
    if target.exists():
        target = dest_dir / f"{p.stem}_{int(p.stat().st_mtime)}{p.suffix}"
    if APPLY:
        shutil.move(str(p), str(target))
    print(f"  {'MOVE' if APPLY else 'DRY '} {p.relative_to(ROOT)} -> {target.relative_to(ROOT)}")


def month_of(p: Path) -> str:
    return datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m")


def tidy_done(root: Path) -> None:
    for st in STATIONS:
        folder = st["folder"]
        d = root / folder / "已处理"
        if not d.is_dir():
            continue
        files = [f for f in d.iterdir() if f.is_file()]
        if not files:
            continue
        print(f"[{st['label']}] 已处理 {len(files)} 个文件")
        for f in files:
            move(f, d / month_of(f))


def tidy_terminal(root: Path) -> None:
    d = root / "00_人类总控" / "汇报终端"
    if not d.is_dir():
        return
    arch = d / "_archive"
    for f in d.glob("进度_*.md"):
        move(f, arch / month_of(f))
    for f in d.glob("系统状态_*.md"):
        move(f, arch / month_of(f))


def roll_ready(root: Path) -> None:
    for st in STATIONS:
        folder = st["folder"]
        p = root / folder / "_READY.md"
        if not p.exists():
            continue
        lines = p.read_text(encoding="utf-8").splitlines()
        if len(lines) <= 50:
            continue
        keep, old = lines[-20:], lines[:-20]
        arch = root / folder / "_archive"
        arch.mkdir(parents=True, exist_ok=True)
        af = arch / f"READY_{datetime.now():%Y-%m}.md"
        print(f"[{st['label']}] _READY.md {len(lines)} 行 -> 归档 {len(old)} 行")
        if APPLY:
            with af.open("a", encoding="utf-8") as fh:
                fh.write("\n".join(old) + "\n")
            p.write_text("# 就绪台账\n\n" + "\n".join(keep) + "\n", encoding="utf-8")


def trim_heartbeat(root: Path) -> None:
    for st in STATIONS:
        folder = st["folder"]
        p = root / folder / "_HEARTBEAT.md"
        if not p.exists():
            continue
        lines = [l for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
        if len(lines) <= 5:
            continue
        print(f"[{st['label']}] _HEARTBEAT.md {len(lines)} 行 -> 保留 5 行")
        if APPLY:
            p.write_text("\n".join(lines[-5:]) + "\n", encoding="utf-8")


def report(root: Path) -> None:
    print("\n目录规模：")
    for d in [root / entry_folder() / "成果区", root / "00_人类总控" / "汇报终端"]:
        if d.is_dir():
            n = sum(1 for _ in d.rglob("*") if _.is_file())
            print(f"  {d.relative_to(root)}: {n} 个文件")
    for st in STATIONS:
        folder = st["folder"]
        d = root / folder / "已处理"
        if d.is_dir():
            n = sum(1 for f in d.iterdir() if f.is_file())
            if n:
                print(f"  {folder}\\已处理: {n} 个未归档")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ROOT = project_root()
    print(f"项目：{ROOT}\n模式：{'执行' if APPLY else '预览（加 --apply 才真改）'}\n")
    tidy_done(ROOT)
    tidy_terminal(ROOT)
    roll_ready(ROOT)
    trim_heartbeat(ROOT)
    report(ROOT)
    print("\n完成。")
