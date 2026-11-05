# -*- coding: utf-8 -*-
"""
链路冒烟测试 —— 装完立刻跑，确认这套东西真的能转。

用法:
  python tools\\smoke_test.py
  python tools\\smoke_test.py --root D:\\ai-workflow

检查 8 项，全绿才算装好。不改动任何真实工位数据。
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

from _workflow_config import load_stations, load_config, entry_folder

PASS, FAIL = "PASS", "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((PASS if ok else FAIL, name, detail))


def parse_pointer(root: Path) -> dict:
    p = root / "_ACTIVE_PROJECT.md"
    if not p.exists():
        return {}
    out = {}
    for line in p.read_text(encoding="utf-8").splitlines():
        if ":" in line and not line.startswith("#"):
            k, v = line.split(":", 1)
            if k.strip() in ("project", "root", "status"):
                out[k.strip()] = v.strip()
    return out


def station_subdirs(st: dict) -> list[str]:
    out = []
    for name in list(st.get("inboxes") or []) + list(st.get("activity") or []):
        if name not in out:
            out.append(name)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=None)
    args = ap.parse_args()

    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parent.parent
    stations = load_stations(root)
    config = load_config(root)
    mode = f"自定义 {len(stations)} 工位" if config else f"标准 {len(stations)} 工位"
    print(f"冒烟测试：{root}\n模式：{mode}\n")

    # 1 控制层文件齐全
    need = ["00_协议总纲.md", "_ACTIVE_PROJECT.md", "file_watcher_mcp.py"]
    need += [st["card"] for st in stations]
    missing = [n for n in need if not (root / n).exists()]
    check("控制层文件齐全", not missing, "缺：" + ", ".join(missing) if missing else f"{len(need)} 个文件")

    # 2 占位符已替换
    dirty = []
    for f in root.glob("*.md"):
        try:
            if "{{ROOT}}" in f.read_text(encoding="utf-8"):
                dirty.append(f.name)
        except Exception:
            pass
    check("路径占位符已替换", not dirty, "未替换：" + ", ".join(dirty) if dirty else "无残留 {{ROOT}}")

    # 3 指针可解析
    ptr = parse_pointer(root)
    ok = bool(ptr.get("root")) and bool(ptr.get("status"))
    check("指针 _ACTIVE_PROJECT.md 可解析", ok,
          f"project={ptr.get('project')} status={ptr.get('status')}" if ok else "缺 root/status")

    proot = Path(ptr.get("root", "")) if ok else None

    # 4 项目目录树完整
    if proot and proot.is_dir():
        miss = []
        for st in stations:
            for sub in station_subdirs(st):
                if not (proot / st["folder"] / sub).is_dir():
                    miss.append(f"{st['folder']}/{sub}")
        if not (proot / "00_人类总控" / "汇报终端").is_dir():
            miss.append("00_人类总控/汇报终端")
        check("项目目录树完整", not miss,
              "缺：" + ", ".join(miss[:6]) if miss else f"{len(stations)} 工位 + 汇报终端")
    else:
        check("项目目录树完整", False, "指针指向的项目根不存在")

    # 5 全局开关与版本号
    entry = entry_folder(root)
    if proot and proot.is_dir():
        gs = proot / entry / "发件箱" / "_GLOBAL_STATUS.md"
        ver = proot / entry / "发件箱" / "_VERSION.md"
        ok = gs.exists() and "status" in gs.read_text(encoding="utf-8").lower()
        check("全局开关 _GLOBAL_STATUS.md", ok, gs.read_text(encoding="utf-8").strip() if gs.exists() else "不存在")
        check("版本号 _VERSION.md", ver.exists(), ver.read_text(encoding="utf-8").strip() if ver.exists() else "不存在")
    else:
        check("全局开关 _GLOBAL_STATUS.md", False, "跳过")
        check("版本号 _VERSION.md", False, "跳过")

    # 6 互斥锁可用
    lock = root / "tools" / "lock.py"
    if lock.exists() and proot and proot.is_dir():
        a = subprocess.run([sys.executable, str(lock), "acquire", "_smoke"],
                           capture_output=True, text=True, encoding="utf-8")
        r = subprocess.run([sys.executable, str(lock), "release", "_smoke"],
                           capture_output=True, text=True, encoding="utf-8")
        ok = "LOCKED" in a.stdout and "RELEASED" in r.stdout
        check("互斥锁 acquire/release", ok, (a.stdout + r.stdout).replace("\n", " ").strip())
    else:
        check("互斥锁 acquire/release", False, "lock.py 或项目根缺失")

    # 7 文件监听语义（临时目录，零污染）
    wf = root / "tools" / "wait_files.py"
    if wf.exists():
        with tempfile.TemporaryDirectory() as td:
            inbox = Path(td) / "inbox"
            inbox.mkdir()
            (inbox / "_smoke_probe.md").write_text("probe", encoding="utf-8")
            r = subprocess.run([sys.executable, str(wf), "--timeout", "3", str(inbox)],
                               capture_output=True, text=True, encoding="utf-8")
            ok = r.stdout.strip().startswith("BACKLOG:")
            check("文件监听返回 BACKLOG", ok, r.stdout.strip()[:80])

            r2 = subprocess.run([sys.executable, str(wf), "--timeout", "1", str(Path(td) / "empty")],
                                capture_output=True, text=True, encoding="utf-8")
            ok2 = r2.stdout.strip() == "NO_FILE"
            check("文件监听超时返回 NO_FILE", ok2, r2.stdout.strip()[:80])
    else:
        check("文件监听返回 BACKLOG", False, "wait_files.py 缺失")
        check("文件监听超时返回 NO_FILE", False, "跳过")

    # 8 MCP 依赖
    miss = []
    for mod in ("mcp", "watchdog"):
        try:
            __import__(mod)
        except ImportError:
            miss.append(mod)
    check("MCP 依赖已安装", not miss,
          "缺：" + ", ".join(miss) + "（pip install mcp watchdog）" if miss else "mcp / watchdog OK")

    # 汇总
    width = max(len(n) for _, n, _ in results) + 2
    print(f"{'结果':<6}{'检查项':<{width}}说明")
    print("-" * (64 + width))
    for st, name, detail in results:
        mark = "[OK]  " if st == PASS else "[FAIL]"
        print(f"{mark}{name:<{width}}{detail}")
    failed = sum(1 for st, _, _ in results if st == FAIL)
    print("-" * (64 + width))
    print(f"{len(results) - failed} 通过 / {failed} 失败")
    if failed == 0:
        order = " → ".join(st["id"] for st in stations)
        print(f"\n全绿。可以开窗口了：{order}")
    else:
        print("\n有失败项，先修再开窗口。")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    raise SystemExit(main())
