'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { Workflow, STATIONS } = require('../main/workflow');
const { makeFileTools, resolveInside } = require('../main/filetools');
const { Store } = require('../main/store');
const { publicProviders, getProviderDefinitions, normalizeBaseUrl } = require('../main/providers');
const { McpClient, McpManager } = require('../main/mcp');
const { WorkflowListener, waitForFiles } = require('../main/listener');

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
    const pointer = workflow.parsePointer(root);
    assert(pointer && pointer.valid);
    assert.strictEqual(pointer.project, 'P001_测试项目');
    const state = workflow.getState(root, 8);
    assert(state.installed);
    assert.strictEqual(state.stations.length, 8);
    assert.strictEqual(state.version, 0);
    assert.strictEqual(state.globalStatus, 'ACTIVE');
    for (const s of STATIONS) {
      assert(fs.existsSync(path.join(pointer.root, s.folder, '_READY.md')), `${s.folder} READY`);
    }
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

  await testAsync('workflow listener processes a file then stops', async () => {
    const folder = path.join(tmp, 'loop-inbox');
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
    listener.stop('c_loop');
    for (let i = 0; i < 60 && !ended; i += 1) await new Promise((r) => setTimeout(r, 100));
    assert(ended, 'loop_end should be emitted');
    assert.strictEqual(ended.reason, 'stopped');
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
