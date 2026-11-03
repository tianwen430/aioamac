# -*- coding: utf-8 -*-
"""
工位互斥锁 —— 防止窗口与调度器同时处理同一工位。

用法:
  python tools\\lock.py acquire 01_总控      # 输出 LOCKED 或 BUSY
  python tools\\lock.py release 01_总控
  python tools\\lock.py status
  python tools\\lock.py clear      # 清空所有锁（上班前用）

锁超过 15 分钟自动失效，防止进程崩溃留下死锁。
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

CONTROL_ROOT = Path(__file__).resolve().parent.parent
POINTER = CONTROL_ROOT / "_ACTIVE_PROJECT.md"
STALE_SECONDS = 15 * 60


def project_root() -> Path:
    for line in POINTER.read_text(encoding="utf-8").splitlines():
        if line.startswith("root:"):
            return Path(line.split(":", 1)[1].strip())
    raise SystemExit("指针里没有 root 字段")


def lock_path(station: str) -> Path:
    d = project_root() / "_locks"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{station}.lock"


def acquire(station: str) -> int:
    p = lock_path(station)
    if p.exists():
        try:
            age = time.time() - p.stat().st_mtime
        except OSError:
            age = 0
        if age < STALE_SECONDS:
            print(f"BUSY {int(age)}s")
            return 1
        p.unlink(missing_ok=True)  # 过期锁直接抢
    try:
        fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        print("BUSY 0s")
        return 1
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(f"pid={os.getpid()} at={time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    print("LOCKED")
    return 0


def release(station: str) -> int:
    p = lock_path(station)
    if p.exists():
        p.unlink(missing_ok=True)
        print("RELEASED")
    else:
        print("NO_LOCK")
    return 0


def status() -> int:
    d = project_root() / "_locks"
    if not d.is_dir():
        print("EMPTY")
        return 0
    rows = []
    for f in sorted(d.glob("*.lock")):
        age = int(time.time() - f.stat().st_mtime)
        rows.append(f"{f.stem}\t{age}s")
    print("\n".join(rows) if rows else "EMPTY")
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 0
    cmd = sys.argv[1]
    if cmd == "status":
        return status()
    if cmd == "clear":
        d = project_root() / "_locks"
        n = 0
        if d.is_dir():
            for f in d.glob("*.lock"):
                f.unlink(missing_ok=True)
                n += 1
        print(f"CLEARED {n}")
        return 0
    if len(sys.argv) < 3:
        print("缺少工位名，例如：01_总控")
        return 1
    station = sys.argv[2]
    if cmd == "acquire":
        return acquire(station)
    if cmd == "release":
        return release(station)
    print(f"未知命令：{cmd}")
    return 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    raise SystemExit(main())
