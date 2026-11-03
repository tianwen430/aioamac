# 项目档案（每个项目一份，员工启动时读取）

name: P001_第一个项目
title: 待补充
code_root: none
deploy_target: 待定
baseline: none
created: 2026-01-01

## 说明

- `code_root` = 代码实际所在地。既有项目请填真实源码目录，员工一律在它下面作业。
- `code_root: none` 表示纯新建，代码写 `04_代码员工\代码产出\{ID}\`。
- `deploy_target` = 部署目标平台。填 `待定` 时，走到部署环节必然阻塞并上报人类。
- `baseline` = 需求与验收的权威依据文件（放项目根）。

## 示例（改造一个已有项目）

```yaml
name: P002_我的游戏
title: 天机阁 V1
code_root: D:\my-project\src
deploy_target: Cloudflare Pages
baseline: D:\my-project\docs\开发总纲_V1.0.md
```

## 示例（从零开始）

```yaml
name: P001_第一个项目
title: 待补充
code_root: none
deploy_target: 待定
baseline: none
```
