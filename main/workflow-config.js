'use strict';

const fs = require('fs');
const path = require('path');
const { pathExists, readTextSafe } = require('./util');
const {
  validateDutyPackage,
  legacyDutyPackage,
  TOOL_LABELS,
} = require('./normalize');

const SCHEMA = 'aioa-workflow/1';
const TEMPLATE_SCHEMA = 'aioa-workflow-template/1';
const MAX_CUSTOM_WORKFLOWS = 2;
const MAX_CUSTOM_ROLES = 3;

const FIXED_STATIONS = {
  '01': {
    dir: '01_总控', alias: '总经理', card: '01_总控.md', order: 1, model: '强模型',
    short: '唯一人类接口 · 出策划 · 分配版本 · 最终裁决',
    inboxes: ['收件箱', '来自实施层'], activity: ['已处理', '发件箱'],
    duty: '接需求、出策划、分配版本、最终裁决；本套未启用 08 时自行审校策划稿',
    result: '`[策划]_`、`[发布]_`、`[待人类决策]_`',
  },
  '02': {
    dir: '02_实施布置', alias: '总监', card: '02_实施布置.md', order: 2, model: '强模型',
    short: '把策划切成可验收任务单 · 核准成果',
    inboxes: ['收件箱', '成果接收'], activity: ['已处理', '发件箱'],
    duty: '把策划切成可验收任务单，核准成果；本套未启用 03 时接管技术裁决',
    result: '`[任务]_`、`[汇报]_`、`[决策]_`',
  },
  '03': {
    dir: '03_高级代码', alias: '部门经理', card: '03_高级代码.md', order: 5, model: '中等',
    short: '技术裁决 · 判断升级方向 · 不写代码',
    inboxes: ['收件箱'], activity: ['已处理', '技术决策库'],
    duty: '判断技术问题还是策划冲突，只出决策不写码',
    result: '`[技术裁决]_`、`[架构升级]_`',
  },
  '04': {
    dir: '04_代码员工', alias: '员工', card: '04_代码员工.md', order: 3, model: '强模型',
    short: '按任务单写代码 · 自测 · 提交测试',
    inboxes: ['收件箱'], activity: ['已处理', '代码产出'],
    duty: '按任务单写代码、自测、提交测试；卡住时上报',
    result: '代码、`完成说明.md`、`[待测试]_`',
  },
  '05': {
    dir: '05_Debug', alias: '质检', card: '05_Debug.md', order: 4, model: '中等',
    short: '跑验收标准 · 自动修复 ≤2 轮 · 沉淀经验',
    inboxes: ['收件箱'], activity: ['已处理', '测试报告', '成果移交', '经验库'],
    duty: '按验收标准测试、可自动修复、沉淀经验（永不可撤）',
    result: '测试报告、`[验收通过]_`、`[修复确认]_`',
  },
  '06': {
    dir: '06_美工', alias: '设计', card: '06_美工.md', order: 6, model: '看需求',
    short: '视觉生产 · 效果说明 · 通知代码接入',
    inboxes: ['收件箱'], activity: ['已处理', '美工产出'],
    duty: '视觉生产，写效果说明，通知代码接入',
    result: '美术资源、`效果说明.md`、`[适配]_`',
  },
  '07': {
    dir: '07_部署', alias: '运维', card: '07_部署.md', order: 7, model: '小模型够用',
    short: '只部署总控放行的版本 · 回执或报阻塞',
    inboxes: ['收件箱'], activity: ['已处理', '部署报告'],
    duty: '只部署总控放行的版本，回执或报阻塞',
    result: '部署报告、`[部署回执]_` / `[部署阻塞]_`',
  },
  '08': {
    dir: '08_智囊', alias: '顾问', card: '08_智囊.md', order: 8, model: '与总控不同模型',
    short: '独立审校策划稿 · 只挑错不给方案',
    inboxes: ['收件箱'], activity: ['已处理', '审校库'],
    duty: '独立审校策划稿，只挑错不给方案',
    result: '`[审校意见]_`',
  },
};

const ROLE_TYPE_LABEL = {
  worker: '执行型',
  design: '设计型',
  ops: '运维型',
  docs: '资料&运营型',
};

function stationFromTemplate(id, extra = {}) {
  const t = FIXED_STATIONS[id];
  return {
    id,
    dir: t.dir,
    alias: t.alias,
    label: `${id} ${t.alias}`,
    card: t.card,
    short: t.short,
    model: t.model,
    order: t.order,
    inboxes: t.inboxes.slice(),
    activity: t.activity.slice(),
    duty: t.duty,
    result: t.result,
    custom: false,
    ...extra,
  };
}

function customRoleStations(customRoles = []) {
  return customRoles.slice(0, MAX_CUSTOM_ROLES).map((role, idx) => {
    const code = `A0${idx + 1}`;
    const alias = `角色${['一', '二', '三'][idx] || idx + 1}`;
    const dir = `${code}_${alias}`;
    const type = ROLE_TYPE_LABEL[role.type] ? role.type : 'worker';
    const provided = role.dutyPackage && typeof role.dutyPackage === 'object'
      ? role.dutyPackage
      : null;
    const dutyPackage = provided
      ? validateDutyPackage(provided, { code, alias, type })
      : legacyDutyPackage({ draft: role.draft, code, alias, type });
    return {
      id: code,
      dir,
      alias,
      label: `${code} ${alias}`,
      card: `${dir}.md`,
      short: `${ROLE_TYPE_LABEL[type]}自定义角色 · ${dutyPackage.name}`,
      model: '按任务',
      order: 9 + idx,
      inboxes: ['收件箱'],
      activity: ['已处理', '产出'],
      custom: true,
      roleType: type,
      duty: dutyPackage.name,
      dutyPackage,
      result: `\`[交付]_${code}_\``,
      draft: String(role.draft || '').trim(),
      inputs: [`[任务]_${code}_`],
      outputs: [`[交付]_${code}_`],
    };
  });
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
}

function buildRoutes({ techReview, advisorReview, customStations = [] }) {
  const routes = [];
  const add = (prefix, from, to, result, note = '') => routes.push({ prefix, from, to, result, note });

  add('[需求]_', 'human', '01', advisorReview ? '`[审校]_` 或 `[策划]_`' : '`[策划]_`（01 自审定稿）');
  if (advisorReview) {
    add('[审校]_', '01', '08', '`[审校意见]_`');
    add('[审校意见]_', '08', '01', '定稿 `[策划]_` 或 `[待人类决策]_`');
  }
  add('[策划]_', '01', '02', '`[任务]_`');
  add('[决策]_', '01', '02', '调整排期 / 重发任务单');
  add('[请示]_', '*', '01', '`[决策]_` 或 `[待人类决策]_`');
  add('[汇报]_', '02', '01', '分配版本');
  add('[待命]_', '*', '01', '系统状态，不派活');
  add('就绪_', '*', 'self', '只记录');
  add('[任务]_', '02', '04', '产出 + `[待测试]_`');
  add('[待测试]_', '04', '05', '测试报告 + `[验收通过]_` / `[修复确认]_`');
  add('[验收通过]_', '05', '02', '核准 + `[汇报]_`');
  add('[修复确认]_', '05', '04', '修改 + 重新 `[待测试]_`');
  if (techReview) {
    add('[问题]_', '04', '03', '`[技术裁决]_` / `[架构升级]_`');
    add('[技术裁决]_', '03', '04', '修改 + `[待测试]_`');
    add('[架构升级]_', '03', '02', '授权内裁决或 `[请示]_`');
  } else {
    add('[问题]_', '04', '02', '`[技术裁决]_`（02 接管）', '03 未启用');
    add('[技术裁决]_', '02', '04', '修改 + `[待测试]_`', '03 未启用');
    add('[架构升级]_', '*', '02', '授权内裁决或 `[请示]_`');
  }
  for (const st of customStations) {
    add(st.inputs[0], '02', st.id, `按职责契约执行（${st.alias}）`);
    add(st.outputs[0], st.id, '02', '核准并回到流程');
  }
  add('[发布]_', '01', null, '未启用（自定义模式不带 07 运维）');
  add('[部署回执]_', '07', null, '未启用');
  add('[部署阻塞]_', '07', null, '未启用');
  add('[任务]_ART_', '02', null, '未启用（自定义模式不带 06 设计）');
  add('[交付]_ART_', '06', null, '未启用');
  return routes;
}

function buildCustomConfig({ name, root, techReview = false, advisorReview = true, customRoles = [] } = {}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('请填写自定义工作流名称');
  if (!root || !path.isAbsolute(String(root))) throw new Error('自定义工作流根目录必须是绝对路径');
  if (Array.isArray(customRoles) && customRoles.length > MAX_CUSTOM_ROLES) {
    throw new Error(`自定义角色最多 ${MAX_CUSTOM_ROLES} 个`);
  }

  const stations = [
    stationFromTemplate('01'),
    stationFromTemplate('02'),
    stationFromTemplate('04'),
    stationFromTemplate('05'),
  ];
  if (techReview) stations.push(stationFromTemplate('03'));
  if (advisorReview) stations.push(stationFromTemplate('08'));
  const customs = customRoleStations(customRoles);
  stations.push(...customs);
  stations.sort((a, b) => a.order - b.order);

  const config = {
    schema: SCHEMA,
    mode: 'custom',
    name: cleanName,
    derivedFrom: 'standard@8',
    entry: '01',
    root: path.resolve(String(root)),
    switches: { techReview: Boolean(techReview), advisorReview: Boolean(advisorReview) },
    stations: stations.map((st) => ({ ...st })),
    routes: buildRoutes({
      techReview: Boolean(techReview),
      advisorReview: Boolean(advisorReview),
      customStations: customs,
    }),
    customRoles: customs.map((st) => ({
      code: st.id,
      name: st.alias,
      type: st.roleType,
      draft: st.draft,
      dutyName: st.dutyPackage.name,
      dutyPackage: st.dutyPackage,
      inputs: st.inputs,
      outputs: st.outputs,
    })),
    capabilities: { dispatch: true, plan: true, execute: true, verify: true },
    createdAt: new Date().toISOString(),
  };
  validateConfig(config);
  return config;
}

function configStations(config) {
  return (config.stations || []).map((st) => ({
    ...st,
    num: st.id,
    folder: st.dir,
    label: `${st.id} ${st.alias}`,
    listens: (st.inboxes || []).slice(),
    activity: (st.activity || []).slice(),
  }));
}

function loadConfig(root) {
  if (!root) return null;
  const file = path.join(root, '_AIOA_WORKFLOW.json');
  if (!pathExists(file)) return null;
  try {
    const parsed = JSON.parse(readTextSafe(file) || '{}');
    if (!parsed || parsed.schema !== SCHEMA || !Array.isArray(parsed.stations)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function validateConfig(config) {
  const errors = [];
  const warnings = [];
  const push = (msg) => errors.push(msg);
  if (!config || config.schema !== SCHEMA) push('配置文件 schema 不正确');
  if (!config.name) push('缺少工作流名称');
  if (!config.root || !path.isAbsolute(config.root)) push('根目录必须是绝对路径');

  const stations = Array.isArray(config.stations) ? config.stations : [];
  if (!stations.length) push('没有任何工位');
  const ids = new Set();
  const dirs = new Set();
  for (const st of stations) {
    if (!st.id || !st.dir) push('工位缺少 id 或目录');
    if (ids.has(st.id)) push(`工位 ID 重复：${st.id}`);
    if (dirs.has(st.dir)) push(`工位目录重复：${st.dir}`);
    ids.add(st.id);
    dirs.add(st.dir);
    if (!Array.isArray(st.inboxes) || !st.inboxes.length) push(`工位 ${st.id} 没有收件箱`);
  }
  for (const required of ['01', '02', '04', '05']) {
    if (!ids.has(required)) push(`缺少必需工位：${required}`);
  }
  if (!ids.has('05')) push('质检 05 必须存在，复核不可撤');
  if (ids.has('06') || ids.has('07')) push('自定义工作流不包含 06/07');

  const switches = config.switches || {};
  if (!switches.techReview) {
    const hasDuty = stations.some((s) => s.id === '02');
    if (!hasDuty) push('03 关闭时 02 必须挂载技术裁决职责');
    if (stations.some((s) => s.id === '03')) push('03 开关为关闭，但仍存在 03 工位');
  } else if (!ids.has('03')) {
    push('03 开关为开启，但缺少 03 工位');
  }
  if (!switches.advisorReview) {
    if (!ids.has('01')) push('08 关闭时 01 必须挂载自审清单');
    if (stations.some((s) => s.id === '08')) push('08 开关为关闭，但仍存在 08 工位');
  } else if (!ids.has('08')) {
    push('08 开关为开启，但缺少 08 工位');
  }

  const customs = stations.filter((s) => s.custom);
  if (customs.length > MAX_CUSTOM_ROLES) push(`自定义角色最多 ${MAX_CUSTOM_ROLES} 个`);
  for (const st of customs) {
    if (!/^A0[1-3]$/.test(st.id)) push(`自定义角色代号必须是 A01~A03：${st.id}`);
    if (!String(st.dir).startsWith(`${st.id}_`)) push(`自定义角色目录必须以代号开头：${st.dir}`);
    if (st.dutyPackage) {
      try {
        validateDutyPackage(st.dutyPackage, { code: st.id, alias: st.alias, type: st.roleType });
        if (st.dutyPackage.status === 'legacy') {
          warnings.push(`角色 ${st.id} 的职责包来自旧版草稿，建议在「编辑职责」里重新规范化`);
        }
      } catch (err) {
        const detail = err && err.validation && err.validation.errors
          ? err.validation.errors.join('；')
          : err.message;
        push(`角色 ${st.id} 的职责包不合格：${detail}`);
      }
    } else {
      warnings.push(`角色 ${st.id} 没有职责包（旧版配置），建议重新规范化`);
    }
  }
  if (stations.length > 4 + 2 + MAX_CUSTOM_ROLES) push('工位总数超出上限');

  const routes = Array.isArray(config.routes) ? config.routes : [];
  const targets = new Set([...ids, 'human', '*', 'self']);
  const prefixMap = new Map();
  for (const route of routes) {
    if (!route.prefix) {
      push('路由缺少前缀');
      continue;
    }
    if (route.to !== null && !targets.has(route.to)) push(`路由 ${route.prefix} 指向不存在的工位：${route.to}`);
    if (route.to !== null) {
      const key = route.prefix;
      if (prefixMap.has(key) && prefixMap.get(key) !== route.to) {
        push(`前缀 ${route.prefix} 有多个接收方：${prefixMap.get(key)} / ${route.to}`);
      }
      prefixMap.set(key, route.to);
    }
  }
  for (const st of customs) {
    for (const prefix of [...(st.inputs || []), ...(st.outputs || [])]) {
      const hit = routes.find((r) => r.prefix === prefix && r.to !== null);
      if (!hit) push(`自定义角色 ${st.id} 的前缀未注册：${prefix}`);
    }
  }
  if (!config.capabilities || !config.capabilities.verify) push('缺少必需能力：verify');
  if (errors.length) {
    const err = new Error(errors.join('；'));
    err.validation = { errors, warnings };
    throw err;
  }
  return { errors, warnings, ok: true };
}

function templateFromConfig(config) {
  if (!config || config.mode !== 'custom') throw new Error('只有自定义工作流可以导出模板');
  const roles = (config.customRoles || []).slice(0, MAX_CUSTOM_ROLES).map((role, idx) => {
    const code = `A0${idx + 1}`;
    const alias = `角色${['一', '二', '三'][idx] || idx + 1}`;
    const type = ROLE_TYPE_LABEL[role.type] ? role.type : 'worker';
    const pkg = role.dutyPackage && typeof role.dutyPackage === 'object'
      ? validateDutyPackage(role.dutyPackage, { code, alias, type })
      : legacyDutyPackage({ draft: role.draft, code, alias, type });
    return {
      type,
      draft: String(role.draft || '').trim(),
      dutyPackage: pkg,
    };
  });
  return {
    schema: TEMPLATE_SCHEMA,
    name: String(config.name || '自定义工作流').trim(),
    switches: {
      techReview: Boolean(config.switches && config.switches.techReview),
      advisorReview: !config.switches || config.switches.advisorReview !== false,
    },
    customRoles: roles,
    generator: 'AIOA Workbench',
    createdAt: new Date().toISOString(),
  };
}

function validateTemplate(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('模板必须是一个 JSON 对象');
  }
  if (input.schema !== TEMPLATE_SCHEMA) errors.push(`模板 schema 必须是 ${TEMPLATE_SCHEMA}`);
  const name = String(input.name || '').trim();
  if (!name) errors.push('模板缺少名称');
  if (name.length > 40) errors.push('模板名称过长（最多 40 字）');
  const switches = input.switches || {};
  const techReview = Boolean(switches.techReview);
  const advisorReview = switches.advisorReview !== false;
  const roles = Array.isArray(input.customRoles) ? input.customRoles : [];
  if (roles.length > MAX_CUSTOM_ROLES) errors.push(`模板里的新增角色最多 ${MAX_CUSTOM_ROLES} 个`);
  if (errors.length) throw new Error(errors.join('；'));

  const customRoles = roles.map((role, idx) => {
    const code = `A0${idx + 1}`;
    const alias = `角色${['一', '二', '三'][idx] || idx + 1}`;
    const type = ROLE_TYPE_LABEL[role.type] ? role.type : 'worker';
    if (!role.dutyPackage || typeof role.dutyPackage !== 'object') {
      throw new Error(`模板角色 ${code} 缺少职责包，不能导入`);
    }
    const dutyPackage = validateDutyPackage(role.dutyPackage, { code, alias, type });
    return {
      type,
      draft: String(role.draft || role.dutyPackage.summary || '').trim(),
      dutyPackage,
    };
  });

  return {
    schema: TEMPLATE_SCHEMA,
    name,
    switches: { techReview, advisorReview },
    customRoles,
    generator: String(input.generator || ''),
    createdAt: String(input.createdAt || ''),
  };
}

function assertCustomSlot(list) {
  const count = Array.isArray(list) ? list.length : 0;
  if (count >= MAX_CUSTOM_WORKFLOWS) {
    throw new Error(`自定义工作流最多 ${MAX_CUSTOM_WORKFLOWS} 套，请先移除或导出其中一套（移除不会删除目录）`);
  }
}

function buildProjectTree(config) {
  const set = new Set(['00_人类总控/汇报终端']);
  for (const st of config.stations || []) {
    for (const inbox of st.inboxes || []) set.add(`${st.dir}/${inbox}`);
    for (const act of st.activity || []) set.add(`${st.dir}/${act}`);
    if (st.id === '01') set.add(`${st.dir}/成果区/_待发布`);
  }
  return Array.from(set);
}

function treeText(config) {
  const lines = ['{PROJECT_ROOT}'];
  const entries = buildProjectTree(config);
  const byDir = new Map();
  for (const rel of entries) {
    const [dir, ...rest] = rel.split('/');
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(rest.join('/'));
  }
  for (const [dir, subs] of byDir) {
    lines.push(`├── ${dir}\\{${subs.join(',')}}`);
  }
  lines.push('├── _PROJECT.md');
  lines.push('└── _locks\\');
  return lines.join('\n');
}

function stationDir(config, id) {
  const st = (config.stations || []).find((s) => s.id === id);
  return st ? st.dir : '';
}

function routeTableText(config) {
  const rows = ['| 前缀 | 产出方 | 落点 | 处理方 | 正常结果 |', '|---|---|---|---|---|'];
  const disabled = [];
  for (const route of config.routes || []) {
    if (route.to === null) {
      disabled.push(`\`${route.prefix}\`${route.note ? `（${route.note}）` : ''}`);
      continue;
    }
    const from = route.from === 'human' ? '人类' : route.from === '*' ? '任意工位' : stationDir(config, route.from) || route.from;
    const to = route.to === 'self' ? '对应工位' : route.to === 'human' ? '人类' : route.to === '*' ? '任意工位' : stationDir(config, route.to) || route.to;
    rows.push(`| \`${route.prefix}\` | ${from} | ${route.to === 'self' ? '本工位收件箱' : to === '人类' ? '汇报终端' : to} | ${to} | ${route.result || ''} |`);
  }
  if (disabled.length) rows.push('', `**本套未启用**：${disabled.join('、')}。相关任务不要硬接，写 \`[请示]_\` 报 01。`);
  return rows.join('\n');
}

function generateConfigCard(config) {
  const switches = config.switches || {};
  const roles = config.customRoles || [];
  const roleRows = roles.length
    ? roles.map((r) => {
      const pkg = r.dutyPackage || {};
      return `| ${r.code} | \`${r.inputs ? r.inputs[0] : ''}\` | \`${r.outputs ? r.outputs[0] : ''}\` | ${pkg.name || r.dutyName || r.name} | ${pkg.status === 'ai' ? 'AI 规范化' : pkg.status === 'manual' ? '手动填写' : '旧版草稿'} |`;
    }).join('\n')
    : '| - | - | - | 本套没有新增角色 | - |';
  return `# 01 总经理（总控）· 配置态说明

> 本文件只在「配置工作流」时阅读，不进入运行循环。运行循环请只读 \`00_协议总纲.md\`、\`_GLOBAL_STATUS.md\` 和当前任务文件。

## 这套工作流是什么

- 名称：${config.name}
- 模式：自定义（${(config.stations || []).length} 个工位）
- 03 部门经理（技术裁决）：${switches.techReview ? '启用' : '未启用，04 的 \`[问题]_\` 直接报 02，02 接管裁决'}
- 08 顾问（审校）：${switches.advisorReview ? '启用' : '未启用，01 自审定稿'}
- 06 设计 / 07 运维：自定义模式不带

## 新增角色

| 代号 | 输入前缀 | 输出前缀 | 职责 | 来源 |
|---|---|---|---|---|
${roleRows}

## 可以改什么

- 在「工作流 → 自定义工作流」里切换、移除登记（移除不删目录）；
- 点角色旁的「编辑职责」，改职责契约；写盘前会显示 diff，并自动备份 \`.bak\`；
- 模型可以在对话顶部自由更换，不影响拓扑。

## 不能改什么

- 核心 4 人（01/02/04/05）固定，05 质检永不可撤；
- 03/08 只能通过新建另一套自定义工作流改变，不能在运行中删岗位；
- 路由前缀由系统分配，AI 和人工都不能新增机制；
- 标准 8 工位模板只读，本套与标准工作流互不覆盖。

## 省 Token 的用法

- 监听循环已经程序化写心跳、查收件箱，没有文件时**不会调用模型**；
- 模型被叫醒时只拿到当前文件路径，不需要重新扫描整个收件箱；
- 启动时读一次协议全文，之后只读 \`_GLOBAL_STATUS.md\` + 当前任务；规则变更或异常再重读协议。
`;
}

function generateProtocol(config, standardText) {
  let text = String(standardText || '');
  const count = (config.stations || []).length;
  text = text.replace('# 00_协议总纲\n', `# 00_协议总纲\n\n> 本文件由 AIOA 工作台按自定义拓扑「${config.name}」生成。固定规则不可手改；改拓扑请用工作台的「新建自定义工作流」。\n`);
  text = text.replace(/8 张角色卡/g, `${count} 张角色卡`);

  const roleStart = text.indexOf('| 01 总经理（');
  const roleEnd = text.indexOf('\n\n**边界规则**', roleStart);
  if (roleStart >= 0 && roleEnd > roleStart) {
    const rows = ['| 工位（显示名 / 目录） | 一句话职责 | 主要产出 | 推荐模型 |', '|---|---|---|---|'];
    for (const st of config.stations || []) {
      const t = FIXED_STATIONS[st.id] || {};
      let duty = t.duty || st.short || st.alias;
      if (st.id === '01' && !config.switches.advisorReview) {
        duty = '唯一人类接口；出策划并自审定稿、分配版本、最终裁决';
      }
      if (st.id === '02') {
        duty = config.switches.techReview
          ? '把策划切成可验收任务单；核准成果'
          : '把策划切成可验收任务单；核准成果；技术裁决由 02 接管';
      }
      const display = st.custom ? `${st.id} ${st.alias}` : `${st.id} ${st.alias}（\`${st.dir}\`）`;
      rows.push(`| ${display} | ${duty} | ${t.result || st.result || ''} | ${st.model || '按任务'} |`);
    }
    text = text.slice(0, roleStart) + rows.join('\n') + text.slice(roleEnd);
  }

  const treeStart = text.indexOf('### 3.2 项目目录树');
  const treeCode = text.indexOf('```', treeStart);
  const treeEnd = text.indexOf('```', treeCode + 3);
  if (treeStart >= 0 && treeCode > treeStart && treeEnd > treeCode) {
    text = text.slice(0, treeCode + 3) + '\n' + treeText(config) + '\n' + text.slice(treeEnd);
  }

  const routeStart = text.indexOf('| 前缀 | 产出方 | 落点 | 处理方 | 正常结果 |');
  const routeEnd = text.indexOf('\n\n**汇报类文件', routeStart);
  if (routeStart >= 0 && routeEnd > routeStart) {
    text = text.slice(0, routeStart) + routeTableText(config) + text.slice(routeEnd);
  }

  const secStart = text.indexOf('### 10.1 加新工位必须改五处');
  const secEnd = text.indexOf('### 10.2', secStart);
  if (secStart >= 0 && secEnd > secStart) {
    text = text.slice(0, secStart)
      + '### 10.1 加新工位\n\n本套由工作台按配置生成。新增角色、切换 03/08 请回工作台操作，不要手改本文件、角色卡或路由表。\n\n'
      + text.slice(secEnd);
  }
  return text;
}

function generateRoleCard(station, config) {
  const pkg = station.dutyPackage || null;
  const dutyName = pkg ? pkg.name : (station.duty || station.alias);
  const code = station.id;
  const criteria = pkg && pkg.criteria.length ? pkg.criteria : [
    '产出物路径与任务单一致，文件齐全、可打开；',
    '产出包含完成说明、自测结果、已知限制；',
    '确实只做了职责契约内的事，未修改他人目录；',
    '缺信息时先落 `[问题]_` / `[请示]_`，不猜测、不硬扛。',
  ];
  const escalate = pkg && pkg.escalate.length ? pkg.escalate : [
    '输入缺失、相互冲突或无法判定；',
    '超出职责范围，或需要改架构 / 范围 / 验收基线；',
    '连续两次被 02 退回。',
  ];
  const forbidden = pkg && pkg.forbidden.length ? pkg.forbidden : [
    '不修改 01/02 的职责与路由；',
    '不直接给 04/05 派活或改他们的文件；',
    '不自行分配版本号；',
    '不删除他人文件。',
  ];
  const tools = pkg && pkg.tools.length
    ? pkg.tools.map((t) => TOOL_LABELS[t] || t)
    : ['读取、搜索、写入本工位目录（默认）'];
  const summary = pkg ? pkg.summary : (firstLine(station.draft) || '按本契约执行');
  const draft = String(station.draft || '').trim() || '（未填写补充说明）';
  return `# ${station.alias} — ${dutyName}（自定义角色）

> 本卡由 AIOA 工作台按职责包生成。固定骨架不可手改；「职责契约」段来自职责包，补充说明不可覆盖前两层。

先读 \`{{ROOT}}\\00_协议总纲.md\`。

## 启动自检（强制执行，不得请示人类）

1. 读 \`{{ROOT}}\\_ACTIVE_PROJECT.md\`，取 \`root\` 作为 \`PROJECT_ROOT\`。
2. 读 \`{PROJECT_ROOT}\\_PROJECT.md\`，了解项目目标与代码根。
3. 创建/确认目录：\`{PROJECT_ROOT}\\${station.dir}\\{收件箱,已处理,产出}\`。
4. 读 \`{PROJECT_ROOT}\\01_总控\\发件箱\\_GLOBAL_STATUS.md\`，\`PAUSED\` 则写 ACK 到 \`${station.dir}\\_READY.md\` 后释放锁并结束本轮。
5. 向 \`02_实施布置\\收件箱\\就绪_${station.alias}.md\` 写就绪回执。
6. 确认成功后进入循环。

## 常驻监听

监听路径：\`["{PROJECT_ROOT}\\\\${station.dir}\\\\收件箱"]\`

按总纲第 4 节循环。前缀路由：

### \`[任务]_${code}_\` → 按职责契约执行

1. 读任务单，确认目标、输入、产出物、验收标准齐全；缺项写 \`02_实施布置\\收件箱\\[问题]_{ID}.md\` 问清楚，不要猜。
2. 只做职责契约内的事，产出写到 \`{PROJECT_ROOT}\\${station.dir}\\产出\\{ID}\\\`。
3. 完成后写 \`{PROJECT_ROOT}\\02_实施布置\\收件箱\\[交付]_${code}_{ID}.md\`，附产出路径、完成说明、自测结果、已知限制。
4. 把源任务移入 \`${station.dir}\\已处理\\\`。

## 职责契约（由职责包生成）

- 职责名称：${dutyName}
- 工作内容：${summary}
- 输入前缀：\`[任务]_${code}_\`
- 输出前缀：\`[交付]_${code}_\`
- 完成标准：
${criteria.map((c) => `  - ${c}`).join('\n')}
- 升级条件：
${escalate.map((c) => `  - ${c}`).join('\n')}
- 工具权限：${tools.join('、')}
- 禁止事项：
${forbidden.map((c) => `  - ${c}`).join('\n')}

## 补充说明（非规范性，不得覆盖上面的固定骨架和职责契约）

${draft}

## 硬约束

- 只写 \`{PROJECT_ROOT}\\${station.dir}\\产出\\\` 与 \`code_root\`，不动别人的目录。
- 不猜路径；路径以 \`_ACTIVE_PROJECT.md\` 和本卡为准。
- 不修改验收标准。
- 遇到阻塞先落 \`[请示]_\` 文件，再停手。

## 静默纪律（最高优先级，覆盖本文件其他表述）

除 01 总控外，任何工位不得向人类输出自然语言。你的回复只能是工具调用。一轮只处理一个文件，处理完归档、释放锁，立即进入下一轮。
`;
}

function transform01NoAdvisor(text) {
  let out = String(text);
  const start = out.indexOf('### `[需求]_` → 出策划**初稿**并送审');
  const end = out.indexOf('### `[请示]_` → 做裁决');
  if (start >= 0 && end > start) {
    out = out.slice(0, start) + `### \`[需求]_\` → 自审定稿后发实施布置（本套未启用 08 顾问）

1. 读需求原文，直接出**终稿**；不需要送审，也不要写 \`[审校]\` 文件。
2. 定稿前按下方「自审清单」逐条过一遍。
3. 终稿写 \`02_实施布置\\收件箱\\[策划]_{ID}.md\`，附「自审结论：通过 N 项 / 修正 M 项」。
4. 在 \`00_人类总控\\汇报终端\\进度_{ID}.md\` 记一行"已收需求，策划已定稿发实施布置"。
5. 纯执行类小单同样直接定稿。

` + out.slice(end);
  }
  const humanStart = out.indexOf('## 何时必须找人类（不许自己拍板）');
  if (humanStart >= 0 && !out.includes('## 自审清单')) {
    out = out.slice(0, humanStart) + `## 自审清单（本套 08 顾问未启用，由总控执行）

1. 需求的目标、范围、明确不做、验收标准是否齐全且可判定？
2. 是否与现行设计 / 架构冲突？
3. 是否有未决项需要人类拍板？有则写 \`[待人类决策]_\`，不要硬猜。
4. 任务能否被 02 切成可验收任务单？不能则先补策划。

` + out.slice(humanStart);
  }
  return out;
}

function transform02NoTech(text) {
  let out = String(text);
  const anchor = '### `[验收通过]_` → 核准';
  if (!out.includes('### `[问题]_` → 技术裁决') && out.includes(anchor)) {
    out = out.replace(anchor, `### \`[问题]_\` → 技术裁决（本套 03 部门经理未启用，由 02 接管）

1. 读问题文件，判断是技术问题、策划冲突还是范围问题。
2. 技术问题 → 写 \`04_代码员工\\收件箱\\[技术裁决]_{ID}.md\`，写清结论、理由、边界。
3. 需要改架构 / 范围 / 验收基线 → 写 \`01_总控\\来自实施层\\[请示]_{ID}.md\`，附 2-3 个方案与影响。
4. 所有裁决必须落文件，禁止口头答复。

${anchor}`);
  }
  return out;
}

function transform02NoArt(text) {
  let out = String(text);
  out = out.replace(
    '- 编码类 → `04_代码员工\\收件箱\\[任务]_{ID}.md`\n- 美术类 → `06_美工\\收件箱\\[任务]_{ID}.md`',
    '- 编码类 → `04_代码员工\\收件箱\\[任务]_{ID}.md`\n- 本套未启用 06 设计：不接美术类任务；确需视觉产出时写 `01_总控\\来自实施层\\[请示]_{ID}.md`，由人类决定。'
  );
  const artStart = out.indexOf('### `[交付]_ART_` → 核准美术产出');
  if (artStart >= 0) {
    const next = out.indexOf('### `就绪_`', artStart);
    if (next > artStart) out = out.slice(0, artStart) + out.slice(next);
  }
  return out;
}

function transform04NoTech(text) {
  return String(text)
    .replace(
      '不自作主张扩大范围。写 `03_高级代码\\收件箱\\[问题]_{ID}.md`，必须包含：',
      '不自作主张扩大范围。本套未启用 03，写 `02_实施布置\\收件箱\\[问题]_{ID}.md`，由 02 总监做技术裁决，必须包含：'
    );
}

module.exports = {
  SCHEMA,
  TEMPLATE_SCHEMA,
  MAX_CUSTOM_WORKFLOWS,
  MAX_CUSTOM_ROLES,
  FIXED_STATIONS,
  ROLE_TYPE_LABEL,
  buildCustomConfig,
  configStations,
  loadConfig,
  validateConfig,
  templateFromConfig,
  validateTemplate,
  assertCustomSlot,
  buildProjectTree,
  buildRoutes,
  generateProtocol,
  generateRoleCard,
  generateConfigCard,
  transform01NoAdvisor,
  transform02NoTech,
  transform02NoArt,
  transform04NoTech,
  stationDir,
};
