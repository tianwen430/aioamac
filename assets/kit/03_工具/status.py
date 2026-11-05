# -*- coding: utf-8 -*-
"""
协同流水线状态检查 —— 随时运行，看每个工位是否活着。

用法:
  python tools\\status.py
  python tools\\status.py --stale 10      # 超过 10 分钟无活动视为疑似卡住
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from _workflow_config import load_stations

CONTROL_ROOT = Path(__file__).resolve().parent.parent
POINTER = CONTROL_ROOT / "_ACTIVE_PROJECT.md"

# 这些子目录的写入 = 该工位真的干了活（收件箱不算，别人也会往里写）
ACTIVITY_DIRS = ["已处理", "代码产出", "美工产出", "测试报告", "成果移交",
                 "技术决策库", "部署报告", "发件箱", "产出"]


def parse_pointer() -> tuple[str, Path]:
    if not POINTER.exists():
        raise SystemExit("找不到 _ACTIVE_PROJECT.md")
    name, root = "", ""
    for line in POINTER.read_text(encoding="utf-8").splitlines():
        if line.startswith("project:"):
            name = line.split(":", 1)[1].strip()
        elif line.startswith("root:"):
            root = line.split(":", 1)[1].strip()
    if not root:
        raise SystemExit("指针里没有 root 字段")
    return name, Path(root)


def latest_mtime(paths: list[Path]) -> float:
    newest = 0.0
    for p in paths:
        if not p.exists():
            continue
        if p.is_file():
            try:
                newest = max(newest, p.stat().st_mtime)
            except OSError:
                pass
            continue
        for f in p.rglob("*"):
            try:
                if f.is_file():
                    newest = max(newest, f.stat().st_mtime)
            except OSError:
                continue
    return newest


def count_files(p: Path) -> int:
    if not p.is_dir():
        return 0
    n = 0
    for f in p.iterdir():
        if f.is_file() and not f.name.startswith("."):
            n += 1
    return n


def human(delta: float) -> str:
    if delta <= 0:
        return "-"
    if delta < 60:
        return f"{int(delta)}秒前"
    if delta < 3600:
        return f"{int(delta // 60)}分钟前"
    return f"{int(delta // 3600)}小时前"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stale", type=float, default=8.0, help="分钟阈值")
    args = ap.parse_args()

    name, root = parse_pointer()
    now = time.time()
    print(f"项目：{name}")
    print(f"根目录：{root}")
    print(f"检查时间：{time.strftime('%H:%M:%S')}\n")

    header = f"{'工位':<12}{'积压':>4}  {'最后活动':<12}{'心跳':<10}{'状态'}"
    print(header)
    print("-" * 46)

    alerts = []
    stations = load_stations(CONTROL_ROOT)
    print(f"工位：{len(stations)} 个（{'自定义' if len(stations) != 8 else '标准/自定义'}拓扑）\n")
    for st in stations:
        label = st["label"]
        folder = st["folder"]
        inboxes = st["inboxes"]
        base = root / folder
        inbox_paths = [base / i for i in inboxes]
        backlog = sum(count_files(p) for p in inbox_paths)

        activity = st.get("activity") or ACTIVITY_DIRS
        act_paths = [base / d for d in activity]
        ready = base / "_READY.md"
        if ready.exists():
            act_paths.append(ready)
        offduty = (base / "_OFFDUTY.md").exists()
        last = latest_mtime(act_paths)
        delta = (now - last) if last else 0.0
        mins = delta / 60 if last else 1e9

        if offduty:
            state = "💤 下班（待命）"
        elif backlog > 0 and mins > args.stale:
            state = f"⚠️ 卡住：积压 {backlog} 项，{int(mins)} 分钟无动作"
            alerts.append(f"{label}：{state}")
        elif backlog > 0:
            state = "🔄 运行中"
        elif not last:
            state = "⚪ 未接过活"
        else:
            state = "✅ 空闲（正常）"

        hb = base / "_HEARTBEAT.md"
        hb_txt = human(now - hb.stat().st_mtime) if hb.exists() else "-"
        print(f"{label:<12}{backlog:>4}  {human(delta):<12}{hb_txt:<10}{state}")

    terminal = root / "00_人类总控" / "汇报终端"
    if terminal.is_dir():
        files = sorted((f for f in terminal.iterdir() if f.is_file()),
                       key=lambda f: f.stat().st_mtime, reverse=True)
        if files:
            newest = files[0]
            print(f"\n汇报终端最新：{newest.name}"
                  f"（{human(now - newest.stat().st_mtime)}）")

    if alerts:
        print("\n需要处理：")
        for a in alerts:
            print(" -", a)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    raise SystemExit(main())
