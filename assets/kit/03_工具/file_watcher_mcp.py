# -*- coding: utf-8 -*-
"""
文件监听 MCP 服务 —— WorkBuddy 多员工协同专用

工具:
  wait_for_files(folder_paths, timeout_seconds=300, settle_seconds=1.0) -> str
  list_pending(folder_paths) -> str

返回约定:
  "BACKLOG: <绝对路径>"  收件箱里已有未归档的旧文件（优先返回，保证不丢件）
  "NEW: <绝对路径>"      本次监听到的新文件
  "NO_FILE"              超时无新文件，调用方应重新挂起（轮询）
  "ERROR: ..."           监听异常

重要语义:
  1. 先扫积压再挂起 —— 处理期间到达的文件、以及启动前就在收件箱的文件都不会丢
  2. 调用方处理完必须把文件移出收件箱，否则下次调用还会返回同一个文件（强制归档）
  3. 无限阻塞已改为有超时，避免上层工具超时打断
"""
from __future__ import annotations

import asyncio
import os
import time
from typing import List

try:
    # MCP Python SDK 1.x
    from mcp.server.fastmcp import FastMCP as _MCPServer
except (ImportError, ModuleNotFoundError):
    # MCP Python SDK 2.x（FastMCP 改名为 MCPServer）
    from mcp.server.mcpserver import MCPServer as _MCPServer

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

mcp = _MCPServer("file-watcher")

_IGNORE_PREFIX = (".", "~$", "~")
_IGNORE_SUFFIX = (".tmp", ".part", ".crdownload", ".swp", ".lock")


def _ignorable(name: str) -> bool:
    if not name:
        return True
    if name.startswith(_IGNORE_PREFIX):
        return True
    return name.lower().endswith(_IGNORE_SUFFIX)


def _list_pending(folder_paths: List[str]) -> List[str]:
    """返回所有收件箱中尚未归档的文件，按修改时间升序（先来先处理）。"""
    items = []
    for folder in folder_paths:
        folder = os.path.abspath(os.path.expanduser(folder))
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


class _Handler(FileSystemEventHandler):
    """只负责解除阻塞，真正的取件靠扫描磁盘，因此重复事件无害。"""

    def __init__(self, loop: asyncio.AbstractEventLoop, queue: "asyncio.Queue[str]"):
        self._loop = loop
        self._queue = queue

    def _push(self, path: str) -> None:
        if _ignorable(os.path.basename(path)):
            return
        try:
            self._loop.call_soon_threadsafe(self._queue.put_nowait, path)
        except RuntimeError:
            pass  # 事件循环已关闭，忽略

    def on_created(self, event):
        if not event.is_directory:
            self._push(event.src_path)

    def on_moved(self, event):
        if not event.is_directory:
            self._push(event.dest_path)

    def on_modified(self, event):
        # 某些编辑器/工具是先建占位再写内容，modified 也作为信号
        if not event.is_directory:
            self._push(event.src_path)


@mcp.tool()
async def wait_for_files(
    folder_paths: List[str],
    timeout_seconds: int = 120,
    settle_seconds: float = 1.0,
) -> str:
    """
    监听一个或多个收件箱目录，返回一个待处理文件的绝对路径。

    folder_paths: 收件箱绝对路径列表
    timeout_seconds: 最长挂起秒数，超时返回 NO_FILE（调用方应重新挂起）
    settle_seconds: 捕获到文件后等待的秒数，避免读到正在写入的半成品

    返回: "BACKLOG: path" / "NEW: path" / "NO_FILE" / "ERROR: ..."
    """
    try:
        folders = []
        for folder in folder_paths:
            folder = os.path.abspath(os.path.expanduser(folder))
            os.makedirs(folder, exist_ok=True)  # 目录不存在直接建，不再抛错
            folders.append(folder)

        # 1) 先消化积压
        pending = _list_pending(folders)
        if pending:
            return "BACKLOG: " + pending[0]

        # 2) 挂起监听
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        handler = _Handler(loop, queue)
        observer = Observer()
        for folder in folders:
            try:
                observer.schedule(handler, folder, recursive=False)
            except Exception as exc:  # noqa: BLE001
                return f"ERROR: 无法监听 {folder}: {exc}"
        observer.start()

        try:
            await asyncio.wait_for(queue.get(), timeout=max(5, int(timeout_seconds)))
        except asyncio.TimeoutError:
            return "NO_FILE"
        finally:
            observer.stop()
            observer.join(timeout=5)

        # 3) 等落盘后扫描，拿真实待处理文件
        await asyncio.sleep(max(0.0, float(settle_seconds)))
        pending = _list_pending(folders)
        if pending:
            return "NEW: " + pending[0]
        return "NO_FILE"

    except Exception as exc:  # noqa: BLE001
        return f"ERROR: {type(exc).__name__}: {exc}"


@mcp.tool()
async def list_pending(folder_paths: List[str]) -> str:
    """列出收件箱中所有尚未归档的文件（排查/自检用，不阻塞）。"""
    try:
        folders = [os.path.abspath(os.path.expanduser(p)) for p in folder_paths]
        pending = _list_pending(folders)
        if not pending:
            return "EMPTY"
        return "\n".join(pending)
    except Exception as exc:  # noqa: BLE001
        return f"ERROR: {type(exc).__name__}: {exc}"


if __name__ == "__main__":
    mcp.run()
