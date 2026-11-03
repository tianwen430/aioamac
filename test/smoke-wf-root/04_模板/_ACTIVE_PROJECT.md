# 当前项目指针（唯一入口，只有人类改这个文件）

project: P001_第一个项目
root: D:\AIOA\AI协同工作流_可复制套件\05_应用\test\smoke-wf-root\projects\P001_第一个项目
status: ACTIVE
updated: 2026-01-01 00:00

## 用法

- 切项目：改上面 3 行（project / root / status），所有员工下一轮自动跟过去。
- 新建项目：运行 `python D:\AIOA\AI协同工作流_可复制套件\05_应用\test\smoke-wf-root\tools\new_project.py P002_项目名`
- 暂停全部：把 status 改成 `PAUSED`。

## 注意

- `root` 必须是**绝对路径**，且必须指向 `projects\` 下的目录。
- 员工每轮都会重读本文件，改完不需要重启任何窗口。
- `status` 只接受 `ACTIVE` / `PAUSED`，写别的值会被当成 `PAUSED`。
