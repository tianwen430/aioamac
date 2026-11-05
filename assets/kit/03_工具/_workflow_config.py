# -*- coding: utf-8 -*-
"""读取自定义工作流拓扑的共享 helper。

标准 8 工位安装（没有 _AIOA_WORKFLOW.json）自动回落到旧清单；
自定义工作流按配置里的 stations 输出，CLI 与应用状态保持一致。
"""
from __future__ import annotations

import json
from pathlib import Path

SCHEMA = "aioa-workflow/1"

STANDARD_STATIONS = [
    {"id": "01", "label": "01 总经理", "folder": "01_总控",
     "inboxes": ["收件箱", "来自实施层"], "activity": ["已处理", "发件箱"],
     "card": "01_总控.md", "order": 1, "custom": False},
    {"id": "02", "label": "02 总监", "folder": "02_实施布置",
     "inboxes": ["收件箱", "成果接收"], "activity": ["已处理", "发件箱"],
     "card": "02_实施布置.md", "order": 2, "custom": False},
    {"id": "03", "label": "03 部门经理", "folder": "03_高级代码",
     "inboxes": ["收件箱"], "activity": ["已处理", "技术决策库"],
     "card": "03_高级代码.md", "order": 5, "custom": False},
    {"id": "04", "label": "04 员工", "folder": "04_代码员工",
     "inboxes": ["收件箱"], "activity": ["已处理", "代码产出"],
     "card": "04_代码员工.md", "order": 3, "custom": False},
    {"id": "05", "label": "05 质检", "folder": "05_Debug",
     "inboxes": ["收件箱"], "activity": ["已处理", "测试报告", "成果移交", "经验库"],
     "card": "05_Debug.md", "order": 4, "custom": False},
    {"id": "06", "label": "06 设计", "folder": "06_美工",
     "inboxes": ["收件箱"], "activity": ["已处理", "美工产出"],
     "card": "06_美工.md", "order": 6, "custom": False},
    {"id": "07", "label": "07 运维", "folder": "07_部署",
     "inboxes": ["收件箱"], "activity": ["已处理", "部署报告"],
     "card": "07_部署.md", "order": 7, "custom": False},
    {"id": "08", "label": "08 顾问", "folder": "08_智囊",
     "inboxes": ["收件箱"], "activity": ["已处理", "审校库"],
     "card": "08_智囊.md", "order": 8, "custom": False},
]


def control_root(root: str | Path | None = None) -> Path:
    if root:
        return Path(root).resolve()
    return Path(__file__).resolve().parent.parent


def load_config(root: str | Path | None = None) -> dict | None:
    file = control_root(root) / "_AIOA_WORKFLOW.json"
    if not file.exists():
        return None
    try:
        data = json.loads(file.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        return None
    if not isinstance(data.get("stations"), list):
        return None
    return data


def load_stations(root: str | Path | None = None) -> list[dict]:
    config = load_config(root)
    if not config:
        return [dict(item) for item in STANDARD_STATIONS]
    out = []
    for st in config.get("stations", []):
        if not isinstance(st, dict) or not st.get("id") or not st.get("dir"):
            continue
        out.append({
            "id": str(st.get("id")),
            "label": f"{st.get('id')} {st.get('alias') or st.get('dir')}",
            "folder": str(st.get("dir")),
            "inboxes": list(st.get("inboxes") or ["收件箱"]),
            "activity": list(st.get("activity") or ["已处理"]),
            "card": str(st.get("card") or f"{st.get('dir')}.md"),
            "order": st.get("order", 99),
            "custom": bool(st.get("custom")),
        })
    out.sort(key=lambda item: item.get("order", 99))
    return out


def is_custom(root: str | Path | None = None) -> bool:
    return load_config(root) is not None


def entry_folder(root: str | Path | None = None) -> str:
    """入口工位（01 总经理）的目录名，默认 01_总控。"""
    for st in load_stations(root):
        if st.get("id") == "01":
            return st["folder"]
    return "01_总控"
