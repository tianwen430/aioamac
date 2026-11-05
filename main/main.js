'use strict';

const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard, safeStorage, nativeTheme,
} = require('electron');

const { Store } = require('./store');
const { Workflow } = require('./workflow');
const { publicProviders, fetchModels, getProviderDefinitions, streamChat } = require('./providers');
const { Agent } = require('./agent');
const { McpManager } = require('./mcp');
const { WorkflowListener } = require('./listener');
const {
  buildCustomConfig, assertCustomSlot, ROLE_TYPE_LABEL,
  templateFromConfig, validateTemplate,
} = require('./workflow-config');
const { normalizeDraft, manualDutyPackage, dutyDiff } = require('./normalize');
const { isSubPath } = require('./util');

const isDev = process.argv.includes('--dev');
const isSmoke = process.argv.includes('--smoke');

if (isSmoke) {
  const smokeData = app.isPackaged
    ? path.join(require('os').tmpdir(), 'aioa-smoke-userdata')
    : path.join(__dirname, '..', 'test', 'smoke-userdata');
  fs.mkdirSync(smokeData, { recursive: true });
  app.setPath('userData', smokeData);
}

let mainWindow = null;
let store = null;
let workflow = null;
let agent = null;
let mcp = null;
let listener = null;
let quitting = false;

function kitRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'kit');
  return path.join(__dirname, '..', 'assets', 'kit');
}

function defaultWorkflowRoot() {
  if (process.platform !== 'win32') return path.join(app.getPath('home'), 'ai-workflow');
  try {
    if (fs.existsSync('D:\\')) return 'D:\\ai-workflow';
  } catch {
    /* ignore */
  }
  return 'C:\\ai-workflow';
}

function logLine(message) {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'app.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

function sendEvent(data) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:event', data);
  } catch {
    /* window closed */
  }
}

function register(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await fn(event, ...args);
      return { ok: true, data };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      logLine(`IPC ${channel} failed: ${message}`);
      return { ok: false, error: message, detail: err && err.detail ? err.detail : '' };
    }
  });
}

function providersPublic() {
  return publicProviders(store.settings, (id) => store.hasKey(id));
}

function workflowState() {
  return workflow.getState(
    store.settings.workflowRoot || defaultWorkflowRoot(),
    store.settings.staleMinutes || 8
  );
}

function normalizationModel() {
  const choice = store.settings.defaultModel;
  if (!choice || !choice.providerId || !choice.model) {
    throw new Error('还没有选择模型。请先在对话顶部选一个模型（免费推荐：智谱 GLM-4.7-Flash），再回来规范化。');
  }
  const provider = getProviderDefinitions(store.settings).find((p) => p.id === choice.providerId);
  if (!provider) throw new Error('默认模型的服务已不存在，请到设置里重新选择');
  if (!provider.baseUrl) throw new Error('默认模型的服务地址为空，请到设置里补全');
  const key = store.getKey(provider.id);
  if (provider.requiresKey && !key) {
    throw new Error(`默认模型 ${provider.name} 还没有 API Key，请先到设置里填写`);
  }
  return { provider, key, model: choice.model };
}

function refreshTheme() {
  const theme = store.settings.theme === 'dark' ? 'dark' : 'light';
  nativeTheme.themeSource = theme;
}

function createWindow() {
  const bounds = store.settings.windowBounds || {};
  const width = Number(bounds.width) >= 1060 ? Number(bounds.width) : 1360;
  const height = Number(bounds.height) >= 700 ? Number(bounds.height) : 880;
  mainWindow = new BrowserWindow({
    width,
    height,
    x: Number.isFinite(bounds.x) ? bounds.x : undefined,
    y: Number.isFinite(bounds.y) ? bounds.y : undefined,
    minWidth: 1060,
    minHeight: 700,
    show: false,
    title: 'AIOA 协同工作台',
    backgroundColor: store.settings.theme === 'dark' ? '#0b1120' : '#f5f7fb',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });

  Menu.setApplicationMenu(null);

  mainWindow.once('ready-to-show', () => {
    if (!isSmoke) mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('console-message', (event) => {
    if (isDev || isSmoke) console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });

  mainWindow.on('close', () => {
    if (!mainWindow.isDestroyed() && !mainWindow.isMaximized()) {
      try {
        const b = mainWindow.getBounds();
        store.saveSettings({ windowBounds: b });
      } catch {
        /* ignore */
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (isDev && !isSmoke) mainWindow.webContents.openDevTools({ mode: 'detach' });

  if (isSmoke) runSmokeTest();
}

async function runSmokeTest() {
  const smokeRoot = app.isPackaged
    ? path.join(require('os').tmpdir(), 'aioa-smoke-wf-root')
    : path.join(__dirname, '..', 'test', 'smoke-wf-root');
  const smokeCustomRoot = app.isPackaged
    ? path.join(require('os').tmpdir(), 'aioa-smoke-custom-wf-root')
    : path.join(__dirname, '..', 'test', 'smoke-custom-wf-root');
  fs.rmSync(smokeRoot, { recursive: true, force: true });
  fs.rmSync(smokeCustomRoot, { recursive: true, force: true });
  store.saveSettings({ customWorkflows: [], workflowRoot: smokeRoot, defaultModel: null });
  const errors = [];
  mainWindow.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message);
  });
  mainWindow.webContents.once('did-finish-load', async () => {
    setTimeout(async () => {
      try {
        // 打包态 __dirname 在 app.asar 内无法写入，改用系统临时目录
        const outDir = app.isPackaged
          ? path.join(require('os').tmpdir(), 'aioa-smoke-out')
          : path.join(__dirname, '..', 'test');
        fs.mkdirSync(outDir, { recursive: true });
        const shot = async (name) => {
          const image = await mainWindow.webContents.capturePage();
          fs.writeFileSync(path.join(outDir, name), image.toPNG());
        };
        await shot('smoke-chat.png');
        await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-view="workflow"]').click(); true`);
        await new Promise((r) => setTimeout(r, 900));
        await shot('smoke-workflow.png');

        // 通过真实 UI 安装到临时目录，验证完整链路
        await mainWindow.webContents.executeJavaScript(`
          (() => {
            const input = document.querySelector('#setupRoot');
            if (input) input.value = ${JSON.stringify(smokeRoot)};
            const form = document.querySelector('#setupForm');
            if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return true;
          })()
        `);
        for (let i = 0; i < 30; i += 1) {
          await new Promise((r) => setTimeout(r, 500));
          const installed = await mainWindow.webContents.executeJavaScript(
            'Boolean(window.__AIOA_SMOKE__ && window.__AIOA_SMOKE__().workflowInstalled)'
          );
          if (installed) break;
        }
        await new Promise((r) => setTimeout(r, 900));
        await mainWindow.webContents.executeJavaScript(`
          (() => {
            const close = document.querySelector('.modal [data-modal-close]');
            if (close) close.click();
            return true;
          })()
        `);
        await new Promise((r) => setTimeout(r, 700));
        await shot('smoke-workflow-dashboard.png');

        // 自定义工作流向导 + 创建 4 人拓扑（03/08 全关 + A01 角色）
        const customCheck = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const out = {};
            S.customWorkflows = await window.api.workflow.listCustom();
            const btn = document.querySelector('[data-wf="custom-new"]');
            out.hasNewButton = Boolean(btn);
            if (btn) btn.click();
            await new Promise((r) => setTimeout(r, 350));
            out.hasWizard = Boolean(document.querySelector('#customWfForm'));
            const rootInput = document.querySelector('#customWfRoot');
            out.defaultRoot = rootInput ? rootInput.value : '';
            const advisor = document.querySelector('[name="advisorReview"]');
            const tech = document.querySelector('[name="techReview"]');
            out.advisorDefault = Boolean(advisor && advisor.checked);
            out.techDefault = Boolean(tech && tech.checked);
            out.roleBlocks = document.querySelectorAll('[name^="roleDraft"]').length;
            out.defaultRootHasCustom = String(out.defaultRoot).includes('-custom-1');
            out.hasImportTemplate = Boolean(document.querySelector('[data-wf="import-template"]'));

            const card = document.querySelector('[data-role="1"]');
            out.hasNormalizeBtn = Boolean(card && card.querySelector('[data-role-normalize="1"]'));
            const editor = card && card.querySelector('[data-role-editor="1"]');
            out.dutyEditorHidden = Boolean(editor && editor.hidden);
            const draftEl = card && card.querySelector('[data-role-draft="1"]');
            const hiddenDuty = card && card.querySelector('[name="roleDuty1"]');
            const presetEl = card && card.querySelector('[data-role-preset="1"]');
            out.hasPreset = Boolean(presetEl);
            if (presetEl) {
              presetEl.value = 'docs';
              presetEl.dispatchEvent(new Event('change', { bubbles: true }));
              await new Promise((r) => setTimeout(r, 250));
              out.presetDutyReady = Boolean(hiddenDuty && hiddenDuty.value);
              out.presetDraftFilled = Boolean(draftEl && draftEl.value.includes('文档索引'));
            }
            if (draftEl) {
              draftEl.value = '维护文档索引与会议纪要';
              draftEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (card) {
              card.querySelector('[data-role-normalize="1"]').click();
              await new Promise((r) => setTimeout(r, 700));
              out.noModelGuide = document.body.textContent.includes('智谱 GLM-4.7-Flash');
              out.aiNormalizeFailed = (card.querySelector('[data-role-status="1"]').textContent || '').includes('规范化失败');
              out.aiOpenedEditor = Boolean(editor && !editor.hidden);
            }
            card.querySelector('[data-role-manual="1"]').click();
            const setField = (name, value) => {
              const el = card.querySelector('[name="' + name + '"]');
              if (el) el.value = value;
            };
            setField('role1Name', '资料运营');
            setField('role1Summary', '长期维护项目文档索引与会议纪要，确保版本可追溯。');
            setField('role1Criteria', '每次会议结束后必须新增纪要文件；\\n索引中的链接必须全部可打开。');
            setField('role1Escalate', '会议结论与项目基线冲突。');
            setField('role1Forbidden', '不得删除历史版本。');
            card.querySelector('[data-role-apply="1"]').click();
            await new Promise((r) => setTimeout(r, 450));
            out.manualDutyReady = Boolean(hiddenDuty && hiddenDuty.value);
            out.manualDraftMatched = Boolean(hiddenDuty && hiddenDuty.dataset.draft === '维护文档索引与会议纪要');
            out.previewVisible = Boolean(card.querySelector('[data-role-preview="1"] .duty-preview'));
            closeModal();

            const duty = await window.api.workflow.validateDuty({
              name: '资料运营',
              summary: '长期维护项目文档索引与会议纪要，确保版本可追溯。',
              criteria: ['每次会议结束后必须新增纪要文件；', '索引中的链接必须全部可打开。'],
              escalate: ['会议结论与项目基线冲突。'],
              forbidden: ['不得删除历史版本。'],
              code: 'A01',
              alias: '角色一',
              type: 'docs',
              draft: '维护文档索引与会议纪要',
            });
            const state = await window.api.workflow.createCustom({
              name: '冒烟自定义',
              root: ${JSON.stringify(smokeCustomRoot)},
              techReview: false,
              advisorReview: false,
              customRoles: [{ type: 'docs', draft: '维护文档索引与会议纪要', dutyPackage: duty.dutyPackage }],
            });
            S.workflow = state;
            S.customWorkflows = state.customWorkflows || [];
            S.settings.workflowRoot = state.root;
            S.workflowTab = 'overview';
            renderTopbar();
            renderWorkflowView();
            await new Promise((r) => setTimeout(r, 350));
            out.isCustom = Boolean(state.isCustom);
            out.stationNums = (state.stations || []).map((s) => s.num);
            out.stationCount = (state.stations || []).length;
            out.customRows = document.querySelectorAll('[data-wf="custom-switch"], [data-wf="custom-remove"]').length;
            out.hasExportTemplate = Boolean(document.querySelector('[data-wf="export-template"]'));
            out.hasA01Text = document.body.textContent.includes('A01 角色一');
            out.hasRouteMap = Boolean(document.querySelector('.route-map'));
            out.routeNodes = document.querySelectorAll('.route-node').length;
            out.routeHasDisabledNote = document.body.textContent.includes('03 未启用');
            out.routeHasCustomRole = document.body.textContent.includes('自定义角色');
            const chip = document.querySelector('[data-wf="edit-duty"][data-code="A01"]');
            out.hasDutyChip = Boolean(chip);
            if (chip) {
              chip.click();
              await new Promise((r) => setTimeout(r, 400));
              out.dutyModal = Boolean(document.querySelector('#dutyEditForm'));
              out.dutySaveDisabled = Boolean(document.querySelector('#dutySaveBtn') && document.querySelector('#dutySaveBtn').disabled);
              closeModal();
            }
            return out;
          })()
        `);
        customCheck.files = {
          config: fs.existsSync(path.join(smokeCustomRoot, '_AIOA_WORKFLOW.json')),
          hasA01Card: fs.existsSync(path.join(smokeCustomRoot, 'A01_角色一.md')),
          no03Card: !fs.existsSync(path.join(smokeCustomRoot, '03_高级代码.md')),
          no08Card: !fs.existsSync(path.join(smokeCustomRoot, '08_智囊.md')),
          selfReview: fs.existsSync(path.join(smokeCustomRoot, '01_总控.md'))
            ? fs.readFileSync(path.join(smokeCustomRoot, '01_总控.md'), 'utf8').includes('自审清单')
            : false,
        };
        try {
          const smokeConfig = JSON.parse(fs.readFileSync(path.join(smokeCustomRoot, '_AIOA_WORKFLOW.json'), 'utf8'));
          customCheck.files.dutyInConfig = Boolean(
            smokeConfig.customRoles && smokeConfig.customRoles[0]
            && smokeConfig.customRoles[0].dutyPackage
            && smokeConfig.customRoles[0].dutyPackage.name === '资料运营'
          );
          customCheck.files.dutyInCard = fs.readFileSync(path.join(smokeCustomRoot, 'A01_角色一.md'), 'utf8')
            .includes('每次会议结束后必须新增纪要文件');
        } catch {
          customCheck.files.dutyInConfig = false;
          customCheck.files.dutyInCard = false;
        }
        await new Promise((r) => setTimeout(r, 300));
        await shot('smoke-custom.png');

        const templatePrefill = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const pkg = {
              name: '资料运营',
              summary: '长期维护项目文档索引与会议纪要，确保版本可追溯。',
              criteria: ['每次会议结束后必须新增纪要文件；', '索引中的链接必须全部可打开。'],
              escalate: ['会议结论与项目基线冲突。'],
              forbidden: ['不得删除历史版本。'],
              tools: ['read', 'search', 'write'],
            };
            openCustomWorkflowModal({
              schema: 'aioa-workflow-template/1',
              name: '模板导入冒烟',
              switches: { techReview: true, advisorReview: false },
              customRoles: [{ type: 'docs', draft: '维护文档索引', dutyPackage: pkg }],
            });
            await new Promise((r) => setTimeout(r, 350));
            const out = {
              title: (document.querySelector('.modal-head h2') || {}).textContent || '',
              name: (document.querySelector('[name="name"]') || {}).value || '',
              tech: Boolean(document.querySelector('[name="techReview"]') && document.querySelector('[name="techReview"]').checked),
              advisor: Boolean(document.querySelector('[name="advisorReview"]') && document.querySelector('[name="advisorReview"]').checked),
              dutyReady: Boolean(document.querySelector('[name="roleDuty1"]') && document.querySelector('[name="roleDuty1"]').value),
              preview: Boolean(document.querySelector('[data-role-preview="1"] .duty-preview')),
              draft: (document.querySelector('[data-role-draft="1"]') || {}).value || '',
            };
            closeModal();
            return out;
          })()
        `);
        customCheck.templatePrefill = templatePrefill;

        const standardSwitch = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const btn = document.querySelector('[data-wf="switch-standard"]');
            if (!btn) return { ok: false, step: 'button-missing' };
            btn.click();
            await new Promise((r) => setTimeout(r, 900));
            return {
              ok: !S.workflow.isCustom && (S.workflow.stations || []).length === 8,
              stations: (S.workflow.stations || []).length,
              hasCustomRow: Boolean(document.querySelector('[data-wf="custom-switch"]')),
              hasRouteMap: Boolean(document.querySelector('.route-map')),
              routeNodes: document.querySelectorAll('.route-node').length,
              routeNoDisabledNote: !document.body.textContent.includes('03 未启用'),
            };
          })()
        `);
        customCheck.standardSwitch = standardSwitch;
        await new Promise((r) => setTimeout(r, 250));
        await shot('smoke-route.png');

        await mainWindow.webContents.executeJavaScript(`
          (() => {
            const tab = document.querySelector('[data-wf="tab"][data-tab="requirement"]');
            if (tab) tab.click();
            return true;
          })()
        `);
        await new Promise((r) => setTimeout(r, 500));
        await shot('smoke-workflow-requirement.png');

        await mainWindow.webContents.executeJavaScript(`
          (() => {
            const tab = document.querySelector('[data-wf="tab"][data-tab="tools"]');
            if (tab) tab.click();
            return true;
          })()
        `);
        await new Promise((r) => setTimeout(r, 500));
        await shot('smoke-workflow-tools.png');

        await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-view="settings"]').click(); true`);
        await new Promise((r) => setTimeout(r, 700));
        await shot('smoke-settings.png');

        // 设置页 MCP 区块 + 对话监听按钮渲染检查
        await mainWindow.webContents.executeJavaScript(`
          (() => {
            const section = document.querySelector('#settingsMcpAuto')?.closest('.settings-section');
            if (section && section.scrollIntoView) section.scrollIntoView({ block: 'start' });
            return true;
          })()
        `);
        await new Promise((r) => setTimeout(r, 400));
        await shot('smoke-mcp.png');
        const uiCheck = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const conv = await window.api.chat.create({ title: '监听UI测试' });
            await loadConversation(conv.id);
            const out = {
              hasMcpSection: Boolean(document.querySelector('#settingsMcpAuto')),
              hasMcpImport: Boolean(document.querySelector('[data-settings-action="mcp-import"]')),
              hasLoopButton: Boolean(document.querySelector('[data-top-action="loop-start"]')),
              mcpServers: Array.isArray(S.mcpServers) ? S.mcpServers.length : -1,
            };
            await window.api.chat.delete(conv.id);
            S.conversations = await window.api.chat.list();
            renderSidebar();
            switchView('settings');
            return out;
          })()
        `);
        await new Promise((r) => setTimeout(r, 300));

        // 验证对话重命名：创建 → 双击标题 → 输入 → 回车 → 落盘
        const renameTest = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const conv = await window.api.chat.create({ title: '重命名测试' });
            S.conversations = await window.api.chat.list();
            renderSidebar();
            const item = Array.from(document.querySelectorAll('.conv-item')).find((el) => el.dataset.convId === conv.id);
            if (!item) return { ok: false, step: 'item-missing' };
            const title = item.querySelector('.conv-title');
            if (!title) return { ok: false, step: 'title-missing' };
            title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            const input = item.querySelector('.conv-title-input');
            if (!input) return { ok: false, step: 'input-missing' };
            input.value = '改名后的对话';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise((r) => setTimeout(r, 600));
            const saved = await window.api.chat.get(conv.id);
            const titleNow = document.querySelector('.conv-item[data-conv-id="' + conv.id + '"] .conv-title');
            const out = {
              ok: saved.title === '改名后的对话' && Boolean(titleNow) && titleNow.textContent === '改名后的对话',
              savedTitle: saved.title,
              sidebarTitle: titleNow ? titleNow.textContent : '',
            };
            await window.api.chat.delete(conv.id);
            S.conversations = await window.api.chat.list();
            renderSidebar();
            return out;
          })()
        `);

        const result = await mainWindow.webContents.executeJavaScript(
          'window.__AIOA_SMOKE__ ? window.__AIOA_SMOKE__() : ({error:"smoke hook missing"})'
        );
        result.renameTest = renameTest;
        result.uiCheck = uiCheck;
        result.customCheck = customCheck;
        result.nav = await mainWindow.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('.nav-item')).map(b => ({ view: b.dataset.view, active: b.classList.contains('active'), cls: b.className, bg: getComputedStyle(b).backgroundColor, color: getComputedStyle(b).color }))`
        );
        const report = { result, errors };
        fs.writeFileSync(path.join(outDir, 'smoke-result.json'), JSON.stringify(report, null, 2));
        console.log('SMOKE_RESULT', JSON.stringify(report, null, 2));
        app.exit(errors.length ? 1 : 0);
      } catch (err) {
        console.error('SMOKE_FAILED', err);
        app.exit(1);
      }
    }, 1800);
  });
}

async function confirmTool(meta) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const settings = store.settings;
  if (meta.kind !== 'mcp') {
    if (settings.permissions === 'readonly') return false;
    if (settings.permissions === 'auto') return true;
  }
  let title = '确认文件操作';
  let message = 'AI 想修改工作区中的文件';
  let detail = '';
  if (meta.kind === 'mcp') {
    title = '确认 MCP 工具调用';
    message = `${meta.server} · ${meta.tool}`;
    detail = JSON.stringify(meta.args || {}, null, 2).slice(0, 4000);
  } else if (meta.kind === 'write') {
    title = meta.exists ? '确认覆盖文件' : '确认创建文件';
    message = `${meta.exists ? '覆盖' : '创建'}：${meta.path}\n${meta.lines} 行 · ${meta.bytes} 字节`;
    detail = meta.preview || '';
  } else if (meta.kind === 'edit') {
    title = '确认修改文件';
    message = `修改：${meta.path}\n替换 ${meta.occurrences} 处`;
    detail = `【原内容】\n${meta.oldPreview || ''}\n\n【新内容】\n${meta.newPreview || ''}`;
  } else if (meta.kind === 'command') {
    title = '确认执行命令';
    message = `在 ${meta.cwd} 执行命令`;
    detail = meta.command;
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['允许这次操作', '拒绝'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title,
    message,
    detail,
  });
  return response === 0;
}

function setupIpc() {
  register('app:getState', async () => ({
    settings: store.publicSettings(),
    providers: providersPublic(),
    conversations: store.listConversations(),
    workflow: workflowState(),
    version: app.getVersion(),
    userDataDir: store.dir,
    platform: process.platform,
    defaultRoot: defaultWorkflowRoot(),
    stats: store.stats(),
    mcpServers: mcp ? mcp.listPublic() : [],
    loops: listener ? listener.list() : [],
    customWorkflows: store.settings.customWorkflows || [],
  }));

  register('app:saveSettings', async (event, patch) => {
    const saved = store.saveSettings(patch || {});
    if (patch && patch.theme) refreshTheme();
    if (patch && patch.workflowRoot !== undefined) {
      store.saveConfig();
    }
    return saved;
  });

  register('app:chooseDirectory', async (event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || '选择文件夹',
      defaultPath: options.defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return '';
    return result.filePaths[0];
  });

  register('app:chooseFile', async (event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || '选择文件',
      defaultPath: options.defaultPath || undefined,
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return '';
    return result.filePaths[0];
  });

  register('app:copyText', async (event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  register('app:openExternal', async (event, url) => {
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('只允许打开 http/https 链接');
    await shell.openExternal(url);
    return true;
  });

  register('app:openPath', async (event, target) => {
    if (!target || !fs.existsSync(target)) throw new Error(`路径不存在：${target}`);
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
    return true;
  });

  register('app:showItemInFolder', async (event, target) => {
    if (!target || !fs.existsSync(target)) throw new Error(`路径不存在：${target}`);
    shell.showItemInFolder(target);
    return true;
  });

  register('app:openUserData', async () => {
    const err = await shell.openPath(store.dir);
    if (err) throw new Error(err);
    return true;
  });

  // ---------- providers ----------

  register('providers:list', async () => providersPublic());

  register('providers:save', async (event, payload = {}) => {
    let id = String(payload.id || '').trim();
    if (!id) throw new Error('缺少服务商 ID');
    if (id === 'custom' || payload.isNewCustom) {
      const created = store.addCustomProvider({
        id: id.startsWith('custom_') ? id : undefined,
        name: payload.name || '自定义服务',
        baseUrl: payload.baseUrl || '',
        type: payload.type || 'openai',
        requiresKey: payload.requiresKey !== false,
        models: payload.models || [],
        description: '自定义服务',
      });
      id = created.id;
    }
    const patch = {};
    if (payload.baseUrl !== undefined) patch.baseUrl = String(payload.baseUrl || '').trim();
    if (payload.type !== undefined) patch.type = payload.type === 'anthropic' ? 'anthropic' : 'openai';
    if (payload.name !== undefined && String(payload.name).trim()) patch.name = String(payload.name).trim();
    if (payload.models !== undefined) {
      patch.models = Array.isArray(payload.models)
        ? payload.models.map((m) => String(m).trim()).filter(Boolean)
        : String(payload.models).split(/[\n,]/).map((m) => m.trim()).filter(Boolean);
    }
    store.saveProviderOverride(id, patch);
    if (payload.clearKey) {
      store.clearKey(id);
    } else if (payload.apiKey !== undefined && String(payload.apiKey).trim()) {
      const canEncrypt = Boolean(store.canEncrypt);
      const remember = canEncrypt && (payload.remember !== undefined ? Boolean(payload.remember) : store.settings.rememberKeys);
      store.settings.rememberKeys = remember;
      store.setKey(id, String(payload.apiKey).trim(), remember);
    }
    return providersPublic();
  });

  register('providers:clearKey', async (event, id) => {
    store.clearKey(String(id));
    return providersPublic();
  });

  register('providers:removeCustom', async (event, id) => {
    store.removeCustomProvider(String(id));
    return providersPublic();
  });

  register('providers:clearAllKeys', async () => {
    store.clearAllKeys();
    return providersPublic();
  });

  register('providers:fetchModels', async (event, payload = {}) => {
    const id = String(payload.id || '');
    const defs = getProviderDefinitions(store.settings);
    let provider = defs.find((p) => p.id === id);
    if (!provider && payload.baseUrl) {
      provider = {
        id,
        name: payload.name || '临时服务',
        type: payload.type === 'anthropic' ? 'anthropic' : 'openai',
        baseUrl: payload.baseUrl,
        requiresKey: payload.requiresKey !== false,
      };
    }
    if (!provider) throw new Error('服务商不存在');
    const key = String(payload.apiKey || '').trim() || store.getKey(id);
    if (provider.requiresKey && !key) throw new Error('请先填写 API Key');
    const models = await fetchModels(provider, key);
    return { models };
  });

  // ---------- conversations ----------

  register('chat:list', async () => store.listConversations());

  register('chat:get', async (event, id) => {
    const conv = store.getConversation(String(id));
    if (!conv) throw new Error('对话不存在');
    return conv;
  });

  register('chat:create', async (event, payload = {}) => {
    const conv = store.createConversation({
      model: payload.model || store.settings.defaultModel || null,
      workspace: payload.workspace !== undefined ? payload.workspace : (store.settings.defaultWorkspace || ''),
      title: payload.title || '新对话',
    });
    return conv;
  });

  register('chat:update', async (event, payload = {}) => {
    const id = String(payload.id || '');
    const patch = payload.patch || {};
    const allowed = {};
    if (patch.title !== undefined) allowed.title = String(patch.title).slice(0, 120);
    if (patch.model !== undefined) allowed.model = patch.model;
    if (patch.workspace !== undefined) allowed.workspace = String(patch.workspace || '');
    const conv = store.updateConversation(id, allowed);
    return {
      id: conv.id,
      title: conv.title,
      updatedAt: conv.updatedAt,
      model: conv.model,
      workspace: conv.workspace,
      messageCount: conv.messages.length,
    };
  });

  register('chat:delete', async (event, id) => {
    if (listener) listener.stop(String(id));
    store.deleteConversation(String(id));
    return true;
  });

  register('chat:clear', async () => {
    store.clearConversations();
    return true;
  });

  register('chat:send', async (event, payload = {}) => {
    const conversationId = String(payload.conversationId || '');
    const text = String(payload.text || '');
    const conv = store.getConversation(conversationId);
    if (!conv) throw new Error('对话不存在');
    if (!text.trim()) throw new Error('消息不能为空');
    agent.getProviderForConversation(conv);
    const win = event.sender;
    const emit = (data) => {
      if (!win.isDestroyed()) win.send('chat:event', data);
    };
    agent.send(conversationId, text, emit).catch((err) => {
      logLine(`agent uncaught: ${err.message}`);
    });
    return { started: true };
  });

  register('chat:abort', async (event, id) => agent.abort(String(id)));

  register('chat:compress', async (event, id) => agent.compress(String(id)));

  register('chat:export', async (event, id) => {
    const conv = store.getConversation(String(id));
    if (!conv) throw new Error('对话不存在');
    const markdown = store.exportConversationMarkdown(String(id));
    const safeTitle = String(conv.title || 'conversation').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出对话',
      defaultPath: path.join(app.getPath('documents'), `${safeTitle}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return '';
    fs.writeFileSync(result.filePath, markdown, 'utf8');
    return result.filePath;
  });

  // ---------- mcp ----------

  register('mcp:list', async () => (mcp ? mcp.listPublic() : []));

  register('mcp:save', async (event, payload = {}) => {
    if (!mcp) throw new Error('MCP 模块未初始化');
    const saved = mcp.upsert(payload);
    return { saved, servers: mcp.listPublic() };
  });

  register('mcp:remove', async (event, id) => {
    if (!mcp) throw new Error('MCP 模块未初始化');
    return mcp.remove(String(id));
  });

  register('mcp:start', async (event, id) => {
    if (!mcp) throw new Error('MCP 模块未初始化');
    const info = await mcp.start(String(id));
    return { info, servers: mcp.listPublic() };
  });

  register('mcp:stop', async (event, id) => {
    if (!mcp) throw new Error('MCP 模块未初始化');
    return mcp.stop(String(id));
  });

  register('mcp:restart', async (event, id) => {
    if (!mcp) throw new Error('MCP 模块未初始化');
    const info = await mcp.restart(String(id));
    return { info, servers: mcp.listPublic() };
  });

  register('mcp:tools', async (event, id) => {
    if (!mcp) throw new Error('MCP 模块未初始化');
    await mcp.start(String(id));
    const info = mcp.listPublic().find((s) => s.id === String(id));
    return info || null;
  });

  register('mcp:importWorkflow', async () => {
    if (!mcp) throw new Error('MCP 模块未初始化');
    const root = store.settings.workflowRoot;
    return mcp.importFromWorkflow(root);
  });

  // ---------- 循环监听 ----------

  register('chat:loopStart', async (event, payload = {}) => {
    if (!listener) throw new Error('监听模块未初始化');
    const conversationId = String(payload.conversationId || '');
    const conv = store.getConversation(conversationId);
    if (!conv) throw new Error('对话不存在');
    agent.getProviderForConversation(conv);
    const folders = (Array.isArray(payload.folders) ? payload.folders : [])
      .map((f) => String(f || '').trim())
      .filter(Boolean);
    if (!folders.length) throw new Error('请至少选择一个监听目录');
    let workspace = conv.workspace || store.settings.defaultWorkspace || '';
    const root = store.settings.workflowRoot;
    if (!workspace && root && folders.every((f) => isSubPath(root, f))) {
      workspace = root;
      store.updateConversation(conversationId, { workspace });
    }
    if (!workspace) throw new Error('请先给这个对话选择工作区（需包含监听目录）');
    for (const folder of folders) {
      if (!fs.existsSync(folder)) throw new Error(`监听目录不存在：${folder}`);
      if (!isSubPath(workspace, folder)) throw new Error(`监听目录必须位于工作区内：${folder}`);
    }
    return listener.start({
      conversationId,
      folders,
      timeoutSeconds: payload.timeoutSeconds,
      useMcp: payload.useMcp !== false,
      emit: sendEvent,
    });
  });

  register('chat:loopStop', async (event, id) => (listener ? listener.stop(String(id)) : false));

  register('chat:loopState', async () => (listener ? listener.list() : []));

  // ---------- workflow ----------

  register('workflow:getState', async () => workflowState());

  register('workflow:install', async (event, payload = {}) => {
    const root = payload.root || store.settings.workflowRoot || defaultWorkflowRoot();
    const win = event.sender;
    const repair = Boolean(payload.repair);
    if (listener) listener.setConfiguring(true);
    let result;
    try {
      result = await workflow.install({
        root,
        project: payload.project || 'P001_第一个项目',
        projectTitle: payload.projectTitle || '',
        codeRoot: payload.codeRoot || '',
        deployTarget: payload.deployTarget || '',
        baseline: payload.baseline || '',
        force: Boolean(payload.force),
        customConfig: repair ? workflow.configFor(root) : null,
        repair,
        onProgress: (p) => {
          if (!win.isDestroyed()) win.send('workflow:progress', p);
        },
      });
    } finally {
      if (listener) listener.setConfiguring(false);
    }
    const patch = { workflowRoot: result.root };
    if (!result.custom) patch.standardRoot = result.root;
    if (!store.settings.defaultWorkspace && result.projectRoot) patch.defaultWorkspace = result.projectRoot;
    store.saveSettings(patch);
    if (mcp) {
      try {
        mcp.importFromWorkflow(result.root);
      } catch (err) {
        logLine(`mcp import after install failed: ${err.message}`);
      }
    }
    return { ...workflowState(), installResult: result };
  });

  register('workflow:listCustom', async () => {
    const list = Array.isArray(store.settings.customWorkflows) ? store.settings.customWorkflows : [];
    const activeRoot = String(store.settings.workflowRoot || '').toLowerCase();
    return list.map((item) => ({
      ...item,
      exists: fs.existsSync(item.root),
      active: String(item.root || '').toLowerCase() === activeRoot,
    }));
  });

  register('workflow:exportTemplate', async (event, payload = {}) => {
    const list = Array.isArray(store.settings.customWorkflows) ? store.settings.customWorkflows : [];
    const item = payload.id
      ? list.find((it) => it.id === payload.id)
      : list.find((it) => String(it.root).toLowerCase() === String(store.settings.workflowRoot || '').toLowerCase());
    if (!item) throw new Error('找不到要导出的自定义工作流');
    const config = workflow.configFor(item.root);
    if (!config) throw new Error('目录里的自定义配置不存在或已损坏');
    const template = templateFromConfig(config);
    const safe = template.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '自定义工作流';
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出工作流模板',
      defaultPath: path.join(app.getPath('documents'), `AIOA-模板-${safe}.json`),
      filters: [{ name: 'AIOA 模板', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(template, null, 2), 'utf8');
    return { canceled: false, path: result.filePath, name: template.name };
  });

  register('workflow:importTemplate', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入工作流模板',
      properties: ['openFile'],
      filters: [{ name: 'AIOA 模板', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const file = result.filePaths[0];
    const stat = fs.statSync(file);
    if (stat.size > 1024 * 1024) throw new Error('模板文件过大（超过 1 MB）');
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`模板不是合法 JSON：${err.message}`);
    }
    const template = validateTemplate(parsed);
    return { canceled: false, path: file, template };
  });

  register('workflow:normalizeDuty', async (event, payload = {}) => {
    const { provider, key, model } = normalizationModel();
    const type = ROLE_TYPE_LABEL[payload.type] ? payload.type : 'worker';
    const result = await normalizeDraft({
      draft: payload.draft,
      code: String(payload.code || ''),
      alias: String(payload.alias || ''),
      type,
      typeLabel: ROLE_TYPE_LABEL[type],
      model: `${provider.id}/${model}`,
      callModel: async ({ system, user }) => {
        let text = '';
        await streamChat({
          provider,
          key,
          model,
          system,
          messages: [{ role: 'user', content: user }],
          tools: [],
          onEvent: (name, data) => {
            if (name === 'text') text += (data && data.text) || '';
          },
        });
        return text;
      },
    });
    result.diff = dutyDiff(payload.draft, result.dutyPackage);
    return result;
  });

  register('workflow:validateDuty', async (event, payload = {}) => {
    const type = ROLE_TYPE_LABEL[payload.type] ? payload.type : 'worker';
    const dutyPackage = manualDutyPackage({
      name: payload.name,
      summary: payload.summary,
      criteria: payload.criteria,
      escalate: payload.escalate,
      tools: payload.tools,
      forbidden: payload.forbidden,
    }, {
      code: String(payload.code || ''),
      alias: String(payload.alias || ''),
      type,
    });
    return { dutyPackage, diff: dutyDiff(payload.draft, dutyPackage) };
  });

  register('workflow:updateRoleDuty', async (event, payload = {}) => {
    const root = workflow.normalizeRoot(payload.root || store.settings.workflowRoot || defaultWorkflowRoot());
    const result = workflow.updateRoleDuty(root, String(payload.code || ''), payload.dutyPackage, {
      draft: payload.draft,
    });
    return {
      ...workflowState(),
      updated: { code: payload.code, cardPath: result.cardPath },
      customWorkflows: Array.isArray(store.settings.customWorkflows) ? store.settings.customWorkflows : [],
    };
  });

  register('workflow:createCustom', async (event, payload = {}) => {
    const list = Array.isArray(store.settings.customWorkflows) ? store.settings.customWorkflows : [];
    assertCustomSlot(list);
    const root = workflow.normalizeRoot(payload.root);
    if (list.some((item) => path.resolve(item.root).toLowerCase() === root.toLowerCase())) {
      throw new Error('这个根目录已经登记为自定义工作流');
    }
    const config = buildCustomConfig({
      name: payload.name,
      root,
      techReview: Boolean(payload.techReview),
      advisorReview: payload.advisorReview !== false,
      customRoles: Array.isArray(payload.customRoles) ? payload.customRoles : [],
    });
    const win = event.sender;
    if (listener) listener.setConfiguring(true);
    let result;
    try {
      result = await workflow.install({
        root,
        customConfig: config,
        project: payload.project || 'P001_第一个项目',
        projectTitle: payload.projectTitle || '',
        codeRoot: payload.codeRoot || '',
        deployTarget: payload.deployTarget || '',
        baseline: payload.baseline || '',
        onProgress: (p) => {
          if (!win.isDestroyed()) win.send('workflow:progress', p);
        },
      });
    } finally {
      if (listener) listener.setConfiguring(false);
    }
    const entry = {
      id: `custom_${Date.now().toString(36)}`,
      name: config.name,
      root,
      switches: config.switches,
      stations: config.stations.length,
      createdAt: new Date().toISOString(),
    };
    const next = [...list, entry];
    const patch = { customWorkflows: next, workflowRoot: root };
    const currentRoot = store.settings.workflowRoot;
    if (currentRoot && !workflow.configFor(currentRoot)) patch.standardRoot = currentRoot;
    if (!store.settings.defaultWorkspace && result.projectRoot) patch.defaultWorkspace = result.projectRoot;
    store.saveSettings(patch);
    if (mcp) {
      try {
        mcp.importFromWorkflow(root);
      } catch (err) {
        logLine(`mcp import after custom install failed: ${err.message}`);
      }
    }
    return { ...workflowState(), installResult: result, customWorkflows: next };
  });

  register('workflow:switchCustom', async (event, id) => {
    const list = Array.isArray(store.settings.customWorkflows) ? store.settings.customWorkflows : [];
    const item = list.find((entry) => entry.id === String(id));
    if (!item) throw new Error('自定义工作流不存在');
    if (!fs.existsSync(item.root)) throw new Error(`目录不存在：${item.root}`);
    if (!workflow.configFor(item.root)) throw new Error('目录里没有 _AIOA_WORKFLOW.json，可能已被移动或删除');
    store.saveSettings({ workflowRoot: item.root });
    return { ...workflowState(), customWorkflows: list };
  });

  register('workflow:removeCustom', async (event, id) => {
    const list = Array.isArray(store.settings.customWorkflows) ? store.settings.customWorkflows : [];
    const item = list.find((entry) => entry.id === String(id));
    const next = list.filter((entry) => entry.id !== String(id));
    const patch = { customWorkflows: next };
    const activeRoot = String(store.settings.workflowRoot || '').toLowerCase();
    if (item && activeRoot === String(item.root).toLowerCase()) {
      patch.workflowRoot = next[0] ? next[0].root : '';
    }
    store.saveSettings(patch);
    return { ...workflowState(), customWorkflows: next };
  });

  register('workflow:switchStandard', async () => {
    const standardRoot = store.settings.standardRoot;
    if (!standardRoot) throw new Error('还没有记录标准工作流目录');
    if (!fs.existsSync(standardRoot)) throw new Error(`标准工作流目录不存在：${standardRoot}`);
    if (workflow.configFor(standardRoot)) throw new Error('记录的标准目录实际是自定义工作流');
    store.saveSettings({ workflowRoot: standardRoot });
    return workflowState();
  });

  register('workflow:createProject', async (event, payload = {}) => {
    const root = store.settings.workflowRoot;
    if (!root) throw new Error('还没有安装工作流');
    const result = workflow.createProject({
      controlRoot: root,
      name: payload.name,
      title: payload.title,
      codeRoot: payload.codeRoot,
      deployTarget: payload.deployTarget,
      baseline: payload.baseline,
      switchTo: payload.switchTo !== false,
    });
    return { ...workflowState(), created: result };
  });

  register('workflow:switchProject', async (event, name) => {
    const root = store.settings.workflowRoot;
    if (!root) throw new Error('还没有安装工作流');
    workflow.switchProject(root, String(name));
    return workflowState();
  });

  register('workflow:saveProfile', async (event, data = {}) => {
    const state = workflowState();
    if (!state.projectRoot) throw new Error('没有活动项目');
    workflow.writeProjectProfile(state.projectRoot, data);
    return workflow.readProjectProfile(state.projectRoot);
  });

  register('workflow:getProfile', async () => {
    const state = workflowState();
    if (!state.projectRoot) throw new Error('没有活动项目');
    return workflow.readProjectProfile(state.projectRoot);
  });

  register('workflow:previewRequirement', async (event, data = {}) => workflow.previewRequirement(data));

  register('workflow:createRequirement', async (event, data = {}) => {
    const state = workflowState();
    if (!state.projectRoot) throw new Error('没有活动项目');
    return workflow.createRequirement(state.projectRoot, data);
  });

  register('workflow:listTerminal', async () => {
    const state = workflowState();
    if (!state.projectRoot) return [];
    return workflow.terminalFiles(state.projectRoot);
  });

  register('workflow:readTerminal', async (event, name) => {
    const state = workflowState();
    if (!state.projectRoot) throw new Error('没有活动项目');
    return workflow.readTerminalFile(state.projectRoot, String(name));
  });

  register('workflow:appendDecision', async (event, payload = {}) => {
    const state = workflowState();
    if (!state.projectRoot) throw new Error('没有活动项目');
    return workflow.appendHumanDecision(state.projectRoot, payload.name, payload.decision);
  });

  register('workflow:stationAction', async (event, payload = {}) => {
    const state = workflowState();
    if (!state.projectRoot) throw new Error('没有活动项目');
    const station = workflow.stationByNum(state.root, payload.station);
    if (!station) throw new Error('未知工位');
    return workflow.stationAction(state.root, state.projectRoot, station, String(payload.action));
  });

  register('workflow:pause', async () => {
    const state = workflowState();
    if (!state.projectRoot) throw new Error('没有活动项目');
    workflow.setGlobalStatus(state.projectRoot, 'PAUSED');
    workflow.appendSystemStatus(state.projectRoot, '全局暂停（工作台操作）');
    return workflowState();
  });

  register('workflow:resume', async () => {
    const state = workflowState();
    if (!state.projectRoot) throw new Error('没有活动项目');
    workflow.setGlobalStatus(state.projectRoot, 'ACTIVE');
    workflow.appendSystemStatus(state.projectRoot, '全局恢复（工作台操作）');
    return workflowState();
  });

  register('workflow:tidy', async (event, payload = {}) => {
    const state = workflowState();
    if (!state.projectRoot) throw new Error('没有活动项目');
    return workflow.tidy(state.projectRoot, { apply: Boolean(payload.apply), controlRoot: state.root });
  });

  register('workflow:clearLocks', async (event, payload = {}) => {
    const state = workflowState();
    if (!state.projectRoot) throw new Error('没有活动项目');
    return workflow.clearLocks(state.projectRoot, { apply: Boolean(payload.apply) });
  });

  register('workflow:selfCheck', async () => {
    const state = workflowState();
    return workflow.selfCheck(state.root);
  });

  register('workflow:getTemplates', async () => {
    const state = workflowState();
    return workflow.getTemplates(state.root);
  });

  register('workflow:getDocs', async () => {
    const state = workflowState();
    return workflow.listDocs(state.root);
  });

  register('workflow:readDoc', async (event, filePath) => {
    const state = workflowState();
    if (!state.root) throw new Error('还没有安装工作流');
    const full = path.resolve(String(filePath || ''));
    const rel = path.relative(path.resolve(state.root), full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径越界');
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error('文件不存在');
    return { path: full, content: fs.readFileSync(full, 'utf8') };
  });

  register('workflow:getMcp', async () => {
    const state = workflowState();
    if (!state.root) return null;
    return workflow.readMcpConfig(state.root);
  });

  register('workflow:pythonCommand', async () => {
    const py = workflow.detectPython();
    return {
      ...py,
      installHint: py.found ? `${py.executable} -m pip install mcp watchdog` : '请先安装 Python 3.10+',
    };
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.aioa.workbench');
    // 异步探测一次加密能力（避免已弃用的同步 isEncryptionAvailable）
    let canEncrypt = false;
    try {
      canEncrypt = safeStorage && typeof safeStorage.isAsyncEncryptionAvailable === 'function'
        ? await safeStorage.isAsyncEncryptionAvailable()
        : Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    } catch {
      canEncrypt = false;
    }
    store = new Store({ userDataDir: app.getPath('userData'), safeStorage, canEncrypt: Boolean(canEncrypt) });
    if (!store.settings.workflowRoot) {
      const guess = defaultWorkflowRoot();
      if (fs.existsSync(path.join(guess, '_ACTIVE_PROJECT.md'))) {
        store.saveSettings({ workflowRoot: guess });
      } else {
        store.settings.workflowRoot = guess;
        store.saveConfig();
      }
    }
    refreshTheme();
    workflow = new Workflow({ kitRoot: kitRoot(), defaultRoot: defaultWorkflowRoot() });
    mcp = new McpManager({ store, version: app.getVersion() });
    agent = new Agent({ store, confirmTool, mcp });
    listener = new WorkflowListener({ agent, mcp });
    setupIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (listener) listener.stopAll();
    if (mcp) mcp.stopAll();
    if (agent) agent.abortAll();
  });
}

process.on('uncaughtException', (err) => {
  logLine(`uncaughtException: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (err) => {
  logLine(`unhandledRejection: ${err && (err.stack || err.message)}`);
});
