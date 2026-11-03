# -*- coding: utf-8 -*-
"""
文件监听 CLI —— 与 file_watcher_mcp.py 同语义，供无法加载 MCP 的会话使用。

用法:
  python tools\wait_files.py --timeout 60 "D:\...\01_总控\收件箱" "D:\...\01_总控\来自实施层"

返回（stdout 单行）:
  BACKLOG: <路径>   启动时收件箱已有未归档文件
  NEW: <路径>       等待期间新出现
  NO_FILE           超时无文件
  ERROR: ...        异常
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from typing import List

_IGNORE_PREFIX = (".", "~$", "~")
_IGNORE_SUFFIX = (".tmp", ".part", ".crdownload", ".swp", ".lock")


def _ignorable(name: str) -> bool:
    if not name:
        return True
    if name.startswith(_IGNORE_PREFIX):
        return True
    return name.lower().endswith(_IGNORE_SUFFIX)


def _list_pending(folders: List[str]) -> List[str]:
    items = []
    for folder in folders:
        if not os.path.isdir(folder):
            continue
        try:
            names = os.listdir(folder)
        except OSError:
            continue
        for name in names:
            if _ignorable(name):
                continue
            full = os.path.join(folder, name)
            if os.path.isfile(full):
                try:
                    items.append((os.path.getmtime(full), full))
                except OSError:
                    continue
    items.sort(key=lambda x: x[0])
    return [p for _, p in items]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--settle", type=float, default=1.0)
    args = ap.parse_args()

    try:
        folders = [os.path.abspath(os.path.expanduser(p)) for p in args.paths]
        for folder in folders:
            os.makedirs(folder, exist_ok=True)

        pending = _list_pending(folders)
        if pending:
            print("BACKLOG: " + pending[0])
            return 0

        deadline = time.monotonic() + max(1.0, args.timeout)
        while time.monotonic() < deadline:
            time.sleep(0.5)
            pending = _list_pending(folders)
            if pending:
                time.sleep(max(0.0, args.settle))
                pending = _list_pending(folders)
                if pending:
                    print("NEW: " + pending[0])
                    return 0
        print("NO_FILE")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
