# -*- coding: utf-8 -*-
"""
全局暂停开关。

用法:
  python tools\\pause.py on       # 全员暂停
  python tools\\pause.py off      # 全员恢复
  python tools\\pause.py status
"""
from __future__ import annotations

import sys
from pathlib import Path

CONTROL_ROOT = Path(__file__).resolve().parent.parent
POINTER = CONTROL_ROOT / "_ACTIVE_PROJECT.md"


def status_file() -> Path:
    for line in POINTER.read_text(encoding="utf-8").splitlines():
        if line.startswith("root:"):
            return Path(line.split(":", 1)[1].strip()) / "01_总控" / "发件箱" / "_GLOBAL_STATUS.md"
    raise SystemExit("指针里没有 root 字段")


def current(p: Path) -> str:
    if not p.exists():
        return "UNKNOWN"
    for line in p.read_text(encoding="utf-8").splitlines():
        if line.lower().startswith("status:"):
            return line.split(":", 1)[1].strip().upper()
    return "UNKNOWN"


def main() -> int:
    p = status_file()
    if len(sys.argv) < 2:
        print(f"当前状态：{current(p)}")
        return 0
    cmd = sys.argv[1].lower()
    if cmd == "status":
        print(current(p))
        return 0
    if cmd not in ("on", "off"):
        print("用法：pause.py on|off|status")
        return 1
    p.parent.mkdir(parents=True, exist_ok=True)
    value = "PAUSED" if cmd == "on" else "ACTIVE"
    p.write_text(f"status: {value}\n", encoding="utf-8")
    print(f"已写入 {value} -> {p}")
    if value == "PAUSED":
        print("注意：正在处理中的文件不会中断，员工会在下一轮循环开头停下。")
    else:
        print("注意：已停下的窗口需要逐个叫醒（发一句“上班/继续监听”）。")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    raise SystemExit(main())
