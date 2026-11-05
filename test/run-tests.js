'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const { Workflow, STATIONS } = require('../main/workflow');
const { makeFileTools, resolveInside } = require('../main/filetools');
const { Store } = require('../main/store');
const { publicProviders, getProviderDefinitions, normalizeBaseUrl } = require('../main/providers');
const { McpClient, McpManager } = require('../main/mcp');
const { WorkflowListener, waitForFiles, buildPrompt } = require('../main/listener');
const { compressionSlice, compressionTranscript } = require('../main/agent');
const {
  buildCustomConfig, validateConfig, assertCustomSlot,
  TEMPLATE_SCHEMA, templateFromConfig, validateTemplate,
} = require('../main/workflow-config');
const {
  normalizeDraft, validateDutyPackage, manualDutyPackage, parseDutyJson,
} = require('../main/normalize');

const kitRoot = path.join(__dirname, '..', 'assets', 'kit');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[OK]   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`[FAIL] ${name}`);
    console.error(err.stack || err.message);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`[OK]   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`[FAIL] ${name}`);
    console.error(err.stack || err.message);
  }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aioa-test-'));
  const root = path.join(tmp, 'ai-workflow');
  const workflow = new Workflow({ kitRoot, defaultRoot: root });

  test('kit has protocol and 8 cards', () => {
    assert(fs.existsSync(path.join(kitRoot, '02_协议总纲.md')));
    assert.strictEqual(fs.readdirSync(path.join(kitRoot, '02_角色卡')).filter((n) => n.endsWith('.md')).length, 8);
  });

  test('normalize base url', () => {
    assert.strictEqual(normalizeBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
    assert.strictEqual(normalizeBaseUrl('https://x/v1/chat/completions'), 'https://x/v1');
    assert.strictEqual(normalizeBaseUrl('https://x/v1/messages'), 'https://x/v1');
  });

  await testAsync('install creates complete workflow', async () => {
    const result = workflow.install({ root, project: 'P001_测试项目', projectTitle: '测试项目' });
    assert.strictEqual(result.root, path.resolve(root));
    assert(fs.existsSync(path.join(root, '00_协议总纲.md')));
    assert(fs.existsSync(path.join(root, '01_总控.md')));
    assert(fs.existsSync(path.join(root, 'tools', 'wait_files.py')));
    assert(fs.existsSync(path.join(root, 'file_watcher_mcp.py')));
    assert(fs.existsSync(path.join(root, '_mcp_config.json')));
    const protocol = fs.readFileSync(path.join(root, '00_协议总纲.md'), 'utf8');
    assert(!protocol.includes('{{ROOT}}'));
    assert(protocol.includes('01 总经理（'));
    assert(protocol.includes('02 总监（'));
    assert(protocol.includes('启动时完整读一次'));
    assert(protocol.includes('之后每轮循环只读'));
    const std01 = fs.readFileSync(path.join(root, '01_总控.md'), 'utf8');
    assert(std01.includes('# 01 总经理 —'));
    assert(std01.includes('使用工作台内置监听时，心跳由程序写'));
    const pointer = workflow.parsePointer(root);
    assert(pointer && pointer.valid);
    assert.strictEqual(pointer.project, 'P001_测试项目');
    const state = workflow.getState(root, 8);
    assert(state.installed);
    assert.strictEqual(state.stations.length, 8);
    assert.strictEqual(state.stations[0].label, '01 总经理');
    assert.strictEqual(state.version, 0);
    assert.strictEqual(state.globalStatus, 'ACTIVE');
    for (const s of STATIONS) {
      assert(fs.existsSync(path.join(pointer.root, s.folder, '_READY.md')), `${s.folder} READY`);
    }
  });

  await testAsync('custom workflow: 5-person with 08, 03 off, A01 role', async () => {
    const croot = path.join(tmp, 'custom-5p');
    const cfg = buildCustomConfig({
      name: '五人组',
      root: croot,
      techReview: false,
      advisorReview: true,
      customRoles: [{ type: 'docs', draft: '整理项目资料并输出索引' }],
    });
    const result = workflow.install({ root: croot, customConfig: cfg, project: 'P001_自定义' });
    assert(result.custom);
    const state = workflow.getState(croot, 8);
    assert(state.isCustom);
    assert.deepStrictEqual(state.stations.map((s) => s.num).sort(), ['01', '02', '04', '05', '08', 'A01'].sort());
    assert(fs.existsSync(path.join(result.projectRoot, '08_智囊', '收件箱')));
    assert(!fs.existsSync(path.join(result.projectRoot, '03_高级代码')));
    assert(fs.existsSync(path.join(result.projectRoot, 'A01_角色一', '收件箱')));
    assert(!fs.existsSync(path.join(croot, '03_高级代码.md')));
    assert(fs.existsSync(path.join(croot, '_AIOA_WORKFLOW.json')));
    assert(fs.existsSync(path.join(croot, '01_总控_配置态.md')));
    assert(fs.readFileSync(path.join(croot, '01_总控_配置态.md'), 'utf8').includes('配置态说明'));
    const c02 = fs.readFileSync(path.join(croot, '02_实施布置.md'), 'utf8');
    assert(c02.includes('技术裁决（本套 03 部门经理未启用'));
    assert(c02.includes('本套未启用 06 设计'));
    const c04 = fs.readFileSync(path.join(croot, '04_代码员工.md'), 'utf8');
    assert(c04.includes('02_实施布置\\收件箱\\[问题]'));
    const customCard = fs.readFileSync(path.join(croot, 'A01_角色一.md'), 'utf8');
    assert(customCard.includes('[任务]_A01_'));
    assert(customCard.includes('职责契约'));
    const protocol = fs.readFileSync(path.join(croot, '00_协议总纲.md'), 'utf8');
    assert(protocol.includes('自定义拓扑'));
    assert(protocol.includes('A01_角色一'));
    assert(protocol.includes('[审校]_'));
    assert(!protocol.includes('8 张角色卡'));
    const repaired = workflow.install({ root: croot, customConfig: workflow.configFor(croot), repair: true });
    assert(repaired.custom, 'custom workflow should be repairable in place');
  });

  await testAsync('CLI status follows custom topology', async () => {
    const croot = path.join(tmp, 'custom-5p');
    const py = spawnSync('python', [path.join(croot, 'tools', 'status.py'), '--stale', '8'], {
      encoding: 'utf8',
    });
    if (py.error && py.error.code === 'ENOENT') return; // 没装 Python 的环境跳过
    assert.strictEqual(py.status, 0, py.stderr || py.stdout);
    assert(py.stdout.includes('6 个'), py.stdout);
    assert(py.stdout.includes('A01 角色一'), py.stdout);
    assert(!py.stdout.includes('06 设计'), py.stdout);
    assert(!py.stdout.includes('07 运维'), py.stdout);
  });

  await testAsync('custom workflow: 4-person switches both off', async () => {
    const croot = path.join(tmp, 'custom-4p');
    const cfg = buildCustomConfig({
      name: '四人小队',
      root: croot,
      techReview: false,
      advisorReview: false,
    });
    const result = workflow.install({ root: croot, customConfig: cfg, project: 'P001_最小' });
    const state = workflow.getState(croot, 8);
    assert.deepStrictEqual(state.stations.map((s) => s.num).sort(), ['01', '02', '04', '05'].sort());
    assert(!fs.existsSync(path.join(result.projectRoot, '03_高级代码')));
    assert(!fs.existsSync(path.join(result.projectRoot, '08_智囊')));
    const c01 = fs.readFileSync(path.join(croot, '01_总控.md'), 'utf8');
    assert(c01.includes('自审清单'));
    assert(c01.includes('自审定稿'));
    assert(!fs.existsSync(path.join(croot, '08_智囊.md')));
    const protocol = fs.readFileSync(path.join(croot, '00_协议总纲.md'), 'utf8');
    assert(!protocol.includes('08_智囊'));
    assert(protocol.includes('02 总监（'));
    assert(!protocol.includes('03 部门经理（'));
    assert(!protocol.includes('08 顾问（'));
    assert(protocol.includes('[技术裁决]_'));
    assert(protocol.includes('（02 接管）'));
  });

  await testAsync('duty normalization: JSON, retry and vague-word rejection', async () => {
    const draft = '负责整理竞品资料，输出对比表并给结论';
    const valid = {
      name: '竞品调研',
      summary: '长期负责竞品资料收集、对比表维护与结论输出，不承担代码实现。',
      criteria: [
        '每个竞品必须包含来源链接与采集日期；',
        '对比表至少覆盖价格、功能、渠道三项，缺项必须标注；',
        '交付前检查表格内不得出现空白单元格。',
      ],
      escalate: ['竞品资料无法公开获取；', '对比口径需要改变。'],
      tools: ['read', 'search', 'write'],
      forbidden: ['不得修改代码文件；', '不得直接给 04 派活。'],
    };
    const ok = await normalizeDraft({
      draft, code: 'A01', alias: '角色一', type: 'docs',
      callModel: async () => JSON.stringify(valid),
    });
    assert.strictEqual(ok.dutyPackage.name, '竞品调研');
    assert.strictEqual(ok.attempts, 1);
    assert.strictEqual(ok.dutyPackage.status, 'ai');

    let calls = 0;
    const retried = await normalizeDraft({
      draft, code: 'A01', alias: '角色一', type: 'docs',
      callModel: async () => {
        calls += 1;
        return calls === 1 ? '这不是 JSON' : `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``;
      },
    });
    assert.strictEqual(retried.attempts, 2);
    assert.strictEqual(calls, 2);

    const vague = { ...valid, criteria: [...valid.criteria.slice(0, 2), '尽量把对比表做得好看'] };
    await assert.rejects(
      () => normalizeDraft({
        draft, code: 'A01', alias: '角色一', type: 'docs',
        callModel: async () => JSON.stringify(vague),
      }),
      /规范化失败/
    );
    assert.strictEqual(parseDutyJson(`说明文字\n${JSON.stringify(valid)}\n结束`).name, '竞品调研');
  });

  test('manual duty package validation and defaults', () => {
    const pkg = manualDutyPackage({
      name: '资料维护',
      summary: '长期维护项目文档索引与会议纪要，确保版本可追溯。',
      criteria: ['每次会议结束后必须新增纪要文件；', '索引中的链接必须全部可打开。'],
      escalate: ['会议结论与项目基线冲突。'],
      forbidden: ['不得删除历史版本。'],
      tools: ['read', 'search', 'bogus'],
    }, { code: 'A01', alias: '角色一', type: 'docs' });
    assert.strictEqual(pkg.status, 'manual');
    assert.deepStrictEqual(pkg.tools, ['read', 'search']);
    assert.throws(() => validateDutyPackage({ name: 'x' }), /职责包不合格/);
    assert.throws(
      () => manualDutyPackage({
        name: '资料维护',
        summary: '长期维护项目文档索引与会议纪要。',
        criteria: ['随便做一下就行', '看着办'],
        escalate: ['有冲突上报'],
        forbidden: ['不得删除'],
      }),
      /职责包不合格/
    );
  });

  await testAsync('update role duty rewrites card and config with backups', async () => {
    const croot = path.join(tmp, 'custom-duty');
    const first = {
      name: '资料维护',
      summary: '长期维护项目文档索引与会议纪要，确保版本可追溯。',
      criteria: ['每次会议结束后必须新增纪要文件；', '索引中的链接必须全部可打开。'],
      escalate: ['会议结论与项目基线冲突。'],
      forbidden: ['不得删除历史版本。'],
      tools: ['read', 'search', 'write'],
    };
    const cfg = buildCustomConfig({
      name: '职责测试',
      root: croot,
      techReview: false,
      advisorReview: false,
      customRoles: [{ type: 'docs', draft: '维护文档索引', dutyPackage: first }],
    });
    const installed = workflow.install({ root: croot, customConfig: cfg, project: 'P001_职责' });
    const cardPath = path.join(croot, 'A01_角色一.md');
    const configPath = path.join(croot, '_AIOA_WORKFLOW.json');
    assert(fs.readFileSync(cardPath, 'utf8').includes('资料维护'));

    const second = {
      ...first,
      name: '知识库运营',
      criteria: ['每周至少更新一次索引；', '所有文档必须包含负责人和更新日期。'],
    };
    const result = workflow.updateRoleDuty(croot, 'A01', second, { draft: '维护知识库' });
    assert.strictEqual(result.dutyPackage.name, '知识库运营');
    const card = fs.readFileSync(cardPath, 'utf8');
    assert(card.includes('知识库运营'));
    assert(card.includes('每周至少更新一次索引'));
    assert(!card.includes('每次会议结束后必须新增纪要文件'));
    assert(fs.existsSync(`${cardPath}.bak`));
    assert(fs.readFileSync(`${cardPath}.bak`, 'utf8').includes('资料维护'));
    assert(fs.existsSync(`${configPath}.bak`));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(config.customRoles[0].dutyPackage.name, '知识库运营');
    assert.strictEqual(config.customRoles[0].draft, '维护知识库');
    assert.strictEqual(config.stations.find((s) => s.id === 'A01').dutyPackage.name, '知识库运营');
    const protocol = fs.readFileSync(path.join(croot, '00_协议总纲.md'), 'utf8');
    assert(protocol.includes('知识库运营'), 'protocol role index should follow the duty name');
    const configCard = fs.readFileSync(path.join(croot, '01_总控_配置态.md'), 'utf8');
    assert(configCard.includes('知识库运营'));
    const state = workflow.getState(croot, 8);
    assert.strictEqual(state.custom.customRoles[0].dutyName, '知识库运营');
    assert(installed.projectRoot);
  });

  test('workflow template export/import strips root and validates packages', () => {
    const pkg = {
      name: '资料维护',
      summary: '长期维护项目文档索引与会议纪要，确保版本可追溯。',
      criteria: ['每次会议结束后必须新增纪要文件；', '索引中的链接必须全部可打开。'],
      escalate: ['会议结论与项目基线冲突。'],
      forbidden: ['不得删除历史版本。'],
      tools: ['read', 'search', 'write'],
    };
    const cfg = buildCustomConfig({
      name: '模板源',
      root: path.join(tmp, 'template-source'),
      techReview: true,
      advisorReview: false,
      customRoles: [{ type: 'docs', draft: '维护文档索引', dutyPackage: pkg }],
    });
    const tpl = templateFromConfig(cfg);
    assert.strictEqual(tpl.schema, TEMPLATE_SCHEMA);
    assert.strictEqual(tpl.root, undefined);
    assert.strictEqual(tpl.stations, undefined);
    assert.strictEqual(tpl.routes, undefined);
    assert.strictEqual(tpl.customRoles.length, 1);
    assert.strictEqual(tpl.switches.techReview, true);
    assert.strictEqual(tpl.switches.advisorReview, false);

    const imported = validateTemplate(JSON.parse(JSON.stringify(tpl)));
    assert.strictEqual(imported.name, '模板源');
    assert.strictEqual(imported.customRoles[0].dutyPackage.name, '资料维护');
    assert.deepStrictEqual(imported.switches, { techReview: true, advisorReview: false });

    assert.throws(() => validateTemplate({ ...tpl, schema: 'wrong' }), /schema/);
    assert.throws(
      () => validateTemplate({ ...tpl, customRoles: [1, 2, 3, 4].map(() => tpl.customRoles[0]) }),
      /最多 3/
    );
    assert.throws(
      () => validateTemplate({ ...tpl, customRoles: [{ type: 'docs', draft: '只有草稿' }] }),
      /缺少职责包/
    );
    assert.throws(
      () => validateTemplate({ ...tpl, customRoles: [{ ...tpl.customRoles[0], dutyPackage: { ...pkg, criteria: ['尽量做好'] } }] }),
      /职责包不合格/
    );
  });

  test('custom workflow limit is two', () => {
    assert.doesNotThrow(() => assertCustomSlot([]));
    assert.doesNotThrow(() => assertCustomSlot([{ id: 'one' }]));
    assert.throws(() => assertCustomSlot([{ id: 'one' }, { id: 'two' }]), /最多 2 套/);
  });

  test('custom config validation catches unsafe topologies', () => {
    const base = buildCustomConfig({
      name: '校验样本',
      root: path.join(tmp, 'custom-val'),
      techReview: false,
      advisorReview: false,
      customRoles: [{ type: 'docs', draft: '测试角色' }],
    });
    const noVerify = { ...base, stations: base.stations.filter((s) => s.id !== '05') };
    assert.throws(() => validateConfig(noVerify), /05/);

    const extraRole = JSON.parse(JSON.stringify(base));
    const custom = extraRole.stations.find((s) => s.custom);
    extraRole.stations.push({ ...custom, id: 'A04', dir: 'A04_角色四', inboxes: ['收件箱'] });
    assert.throws(() => validateConfig(extraRole), /A01~A03/);

    const dup = JSON.parse(JSON.stringify(base));
    dup.routes.push({ prefix: '[需求]_', from: 'human', to: '02', result: 'x' });
    assert.throws(() => validateConfig(dup), /多个接收方/);

    const switchMismatch = JSON.parse(JSON.stringify(base));
    switchMismatch.switches.techReview = true;
    assert.throws(() => validateConfig(switchMismatch), /03/);
  });

  test('custom and standard roots cannot overwrite each other', () => {
    const customRoot = path.join(tmp, 'custom-5p');
    assert.throws(
      () => workflow.install({ root: customRoot, project: 'X' }),
      /自定义工作流/
    );
    assert.throws(
      () => workflow.install({
        root,
        project: 'Y',
        customConfig: buildCustomConfig({
          name: '冲突', root, techReview: false, advisorReview: false,
        }),
      }),
      /标准工作流/
    );
  });

  test('role card and station actions', () => {
    const pointer = workflow.parsePointer(root);
    const station = STATIONS[0];
    const card = workflow.getRoleCard(root, station);
    assert(card.includes('总控'));
    assert(card.includes(root));
    const started = workflow.stationAction(root, pointer.root, station, 'start');
    assert(started.command.includes('上班'));
    const stopped = workflow.stationAction(root, pointer.root, station, 'stop');
    assert(stopped.command.includes('下班'));
    assert(fs.existsSync(path.join(pointer.root, station.folder, '_OFFDUTY.md')));
    workflow.stationAction(root, pointer.root, station, 'start');
    assert(!fs.existsSync(path.join(pointer.root, station.folder, '_OFFDUTY.md')));
  });

  test('create requirement writes correct prefix and id', () => {
    const pointer = workflow.parsePointer(root);
    const req = workflow.createRequirement(pointer.root, {
      title: '测试需求', priority: 'P0', goal: '完成测试',
      acceptance: '1. 能通过', background: '背景', scope: '范围', nonGoals: '不做', constraints: '无',
    });
    assert(req.name.startsWith('[需求]_'));
    assert(fs.existsSync(req.path));
    const text = fs.readFileSync(req.path, 'utf8');
    assert(text.includes('# [需求] 测试需求'));
    assert(text.includes('优先级：P0'));
    assert(text.includes('## 五、验收标准'));
  });

  test('terminal, decision append, profile, tidy, locks, selfcheck', () => {
    const pointer = workflow.parsePointer(root);
    const terminal = path.join(pointer.root, '00_人类总控', '汇报终端');
    fs.mkdirSync(terminal, { recursive: true });
    fs.writeFileSync(path.join(terminal, '[待人类决策]_20260101-0900-01.md'), '# 待决策\n\nA 还是 B？', 'utf8');
    const files = workflow.terminalFiles(pointer.root);
    assert(files.some((f) => f.type === 'decision'));
    workflow.appendHumanDecision(pointer.root, '[待人类决策]_20260101-0900-01.md', 'A');
    assert(fs.readFileSync(path.join(terminal, '[待人类决策]_20260101-0900-01.md'), 'utf8').includes('人类裁决'));
    const profile = workflow.readProjectProfile(pointer.root);
    assert.strictEqual(profile.title, '测试项目');
    workflow.writeProjectProfile(pointer.root, { title: '改过的标题', codeRoot: 'D:\\repo' });
    const changed = workflow.readProjectProfile(pointer.root);
    assert.strictEqual(changed.title, '改过的标题');
    assert.strictEqual(changed.code_root, 'D:\\repo');
    const lockDir = path.join(pointer.root, '_locks');
    fs.writeFileSync(path.join(lockDir, '01_总控.lock'), 'x', 'utf8');
    const cleared = workflow.clearLocks(pointer.root, { apply: true });
    assert.strictEqual(cleared.count, 1);
    const check = workflow.selfCheck(root);
    assert(check.items.length >= 8);
    assert(check.passed >= 8, JSON.stringify(check));
  });

  await testAsync('file tools sandbox and edits', async () => {
    const ws = path.join(tmp, 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    const tools = makeFileTools({ workspace: ws, permissions: 'auto', allowCommands: false, confirm: async () => true });
    const write = await tools.execute('write_file', { path: 'src/a.txt', content: 'hello world\nsecond line\n' });
    assert(write.includes('created'));
    const read = await tools.execute('read_file', { path: 'src/a.txt' });
    assert(read.includes('hello world'));
    const edit = await tools.execute('edit_file', { path: 'src/a.txt', old_string: 'world', new_string: 'AIOA' });
    assert(edit.includes('replacements'));
    assert(fs.readFileSync(path.join(ws, 'src', 'a.txt'), 'utf8').includes('hello AIOA'));
    const glob = await tools.execute('glob', { pattern: '**/*.txt' });
    assert(glob.includes('src/a.txt'));
    const grep = await tools.execute('grep', { pattern: 'AIOA', path: '.' });
    assert(grep.includes('src/a.txt'));
    let blocked = false;
    try {
      resolveInside(ws, '../outside.txt');
    } catch {
      blocked = true;
    }
    assert(blocked, 'path escape should be blocked');
    let denied = false;
    try {
      await tools.execute('write_file', { path: '../escape.txt', content: 'x' });
    } catch {
      denied = true;
    }
    assert(denied, 'write outside should be denied');
  });

  await testAsync('read-only mode blocks writes', async () => {
    const ws = path.join(tmp, 'workspace2');
    fs.mkdirSync(ws, { recursive: true });
    const tools = makeFileTools({ workspace: ws, permissions: 'readonly', confirm: async () => true });
    let blocked = false;
    try {
      await tools.execute('write_file', { path: 'x.txt', content: 'x' });
    } catch (err) {
      blocked = /只读/.test(err.message);
    }
    assert(blocked);
  });

  await testAsync('mcp stdio handshake, tools and call', async () => {
    const client = new McpClient({
      id: 'mock',
      name: 'mock',
      command: process.execPath,
      args: [path.join(__dirname, 'mock-mcp-server.js')],
    });
    try {
      await client.start();
      assert.strictEqual(client.status, 'running');
      assert(client.tools.some((t) => t.name === 'echo'));
      const text = await client.callTool('echo', { text: '你好' });
      assert.strictEqual(text, 'echo:你好');
      const pending = await client.callTool('wait_for_files', { folder_paths: ['C:\\tmp'] });
      assert(/^BACKLOG: .*fake\.md$/.test(pending));
    } finally {
      client.stop();
    }
  });

  await testAsync('mcp manager exposes namespaced tools', async () => {
    const fakeStore = {
      settings: {
        mcpServers: [{
          id: 'mock',
          name: 'mock',
          command: process.execPath,
          args: [path.join(__dirname, 'mock-mcp-server.js')],
          env: {},
          enabled: true,
        }],
      },
      saveConfig() {},
    };
    const manager = new McpManager({ store: fakeStore });
    try {
      const tools = await manager.agentTools();
      const def = tools.definitions.find((d) => d.name.startsWith('mcp_mock_'));
      assert(def, 'namespaced MCP tool should exist');
      assert(def.parameters && def.parameters.type === 'object');
      const info = manager.findTool('echo');
      assert(info);
      const text = await manager.callTool(info.name, { text: 'ok' });
      assert.strictEqual(text, 'echo:ok');
    } finally {
      manager.stopAll();
    }
  });

  await testAsync('native wait_for_files backlog and timeout', async () => {
    const folder = path.join(tmp, 'listen');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, '需求.md');
    fs.writeFileSync(file, 'x');
    const backlog = await waitForFiles({ folders: [folder], timeoutSeconds: 5, settleSeconds: 0.01 });
    assert(/^BACKLOG: .*需求\.md$/.test(backlog), backlog);
    fs.unlinkSync(file);
    const none = await waitForFiles({ folders: [folder], timeoutSeconds: 1, settleSeconds: 0 });
    assert.strictEqual(none, 'NO_FILE');
  });

  test('listener prompt is tiered and heartbeat is programmatic', () => {
    const folders = [path.join(tmp, 'tier-project', '01_总控', '收件箱')];
    const first = buildPrompt(path.join(folders[0], '任务.md'), folders, { first: true });
    const next = buildPrompt(path.join(folders[0], '任务.md'), folders, { first: false });
    assert(first.includes('第一次处理文件'));
    assert(first.includes('先读一次《00_协议总纲.md》第 4 节'));
    assert(next.includes('不要重读'));
    assert(!next.includes('第一次处理文件'));
    assert(first.includes('_GLOBAL_STATUS.md'));
    assert(first.includes('心跳由工作台监听程序写'));
    assert(next.length < first.length, 'later rounds should carry a smaller prompt');
  });

  await testAsync('workflow listener processes a file then stops', async () => {
    const stationDir = path.join(tmp, 'loop-project', '01_总控');
    const folder = path.join(stationDir, '收件箱');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, '任务.md');
    fs.writeFileSync(file, '做点什么');
    const calls = [];
    const agent = {
      async send(id, text) {
        calls.push(text);
        try {
          fs.unlinkSync(file);
        } catch {
          /* ignore */
        }
        return { ok: true, failure: '' };
      },
      abort() {},
    };
    const listener = new WorkflowListener({ agent, mcp: null });
    let ended = null;
    await listener.start({
      conversationId: 'c_loop',
      folders: [folder],
      timeoutSeconds: 1,
      useMcp: false,
      emit: (ev) => {
        if (ev.type === 'loop_end') ended = ev;
      },
    });
    for (let i = 0; i < 60 && !calls.length; i += 1) await new Promise((r) => setTimeout(r, 100));
    assert(calls.length >= 1, 'agent should receive the pending file');
    assert(calls[0].includes('任务.md'), calls[0]);
    const heartbeat = fs.readFileSync(path.join(stationDir, '_HEARTBEAT.md'), 'utf8');
    assert(heartbeat.includes('处理 任务.md'), heartbeat);
    listener.stop('c_loop');
    for (let i = 0; i < 60 && !ended; i += 1) await new Promise((r) => setTimeout(r, 100));
    assert(ended, 'loop_end should be emitted');
    assert.strictEqual(ended.reason, 'stopped');
  });

  await testAsync('listener: no-file costs no model call, configuring pauses and resumes', async () => {
    const stationDir = path.join(tmp, 'pause-project', '02_实施布置');
    const folder = path.join(stationDir, '收件箱');
    fs.mkdirSync(folder, { recursive: true });
    const calls = [];
    const file = path.join(folder, '任务.md');
    const agent = {
      async send(id, text) {
        calls.push(text);
        try { fs.unlinkSync(file); } catch { /* ignore */ }
        return { ok: true, failure: '' };
      },
      abort() {},
    };
    const listener = new WorkflowListener({ agent, mcp: null });
    await listener.start({
      conversationId: 'c_pause',
      folders: [folder],
      timeoutSeconds: 1,
      useMcp: false,
      emit: () => {},
    });
    // 空目录跑满一轮（NO_FILE）：不应产生模型调用，但心跳应更新
    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(calls.length, 0, 'NO_FILE must not call the model');
    assert(fs.existsSync(path.join(stationDir, '_HEARTBEAT.md')), 'heartbeat written by listener');

    listener.setConfiguring(true);
    fs.writeFileSync(file, '配置暂停期间不应处理');
    await new Promise((r) => setTimeout(r, 1300));
    assert.strictEqual(calls.length, 0, 'configuring must pause processing');
    const paused = listener.get('c_pause');
    assert(paused && paused.status === 'configuring', paused && paused.status);

    listener.setConfiguring(false);
    for (let i = 0; i < 40 && !calls.length; i += 1) await new Promise((r) => setTimeout(r, 100));
    assert(calls.length >= 1, 'loop should resume after configuring');
    listener.stop('c_pause');
    await new Promise((r) => setTimeout(r, 200));
  });

  test('history compression keeps recent messages and skips isolated tools', () => {
    const messages = [];
    for (let i = 0; i < 14; i += 1) {
      messages.push({ role: i % 2 ? 'assistant' : 'user', content: `消息 ${i}` });
    }
    messages.push({ role: 'assistant', content: '调用工具', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] });
    messages.push({ role: 'tool', toolCallId: 'c1', content: '工具结果' });
    const slice = compressionSlice(messages, 8);
    assert(slice);
    assert(slice.old.length > 0);
    assert(slice.recent.length >= 2);
    assert.notStrictEqual(slice.recent[0].role, 'tool');
    assert.strictEqual(slice.old.length + slice.recent.length, messages.length);

    const transcript = compressionTranscript(slice.old);
    assert(transcript.includes('[用户]'));
    assert(transcript.includes('[助手]'));
    assert(transcript.length <= 16000);

    const isolated = [];
    for (let i = 0; i < 6; i += 1) isolated.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
    for (let i = 0; i < 8; i += 1) isolated.push({ role: 'tool', content: `t${i}`, toolCallId: `t${i}` });
    assert.strictEqual(compressionSlice(isolated, 8), null);
  });

  test('store conversations and provider config', () => {
    const userData = path.join(tmp, 'userdata');
    const mockSafeStorage = { isEncryptionAvailable: () => false };
    const store = new Store({ userDataDir: userData, safeStorage: mockSafeStorage });
    const conv = store.createConversation({ model: { providerId: 'deepseek', model: 'deepseek-chat' }, workspace: 'D:\\ws' });
    store.updateConversation(conv.id, { title: '测试对话' });
    assert.strictEqual(store.listConversations().length, 1);
    assert.strictEqual(store.getConversation(conv.id).title, '测试对话');
    store.setKey('deepseek', 'sk-test', false);
    assert(store.hasKey('deepseek'));
    store.saveProviderOverride('deepseek', { baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat'] });
    const providers = publicProviders(store.settings, (id) => store.hasKey(id));
    const ds = providers.find((p) => p.id === 'deepseek');
    assert(ds);
    assert(ds.keySet);
    const defs = getProviderDefinitions(store.settings);
    assert(defs.some((p) => p.id === 'deepseek' && p.type === 'openai'));
    store.deleteConversation(conv.id);
    assert.strictEqual(store.listConversations().length, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
