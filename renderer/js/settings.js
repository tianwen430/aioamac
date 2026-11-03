'use strict';

/* ============================== settings rendering ============================== */
function renderSettingsView() {
  const root = $('#settingsContent');
  if (!root) return;
  const provider = providerById(S.settingsProviderId) || S.providers[0] || null;
  const stats = S.stats || {};
  root.innerHTML = `
    <div class="settings-inner">
      <div class="settings-section">
        <h2>模型服务</h2>
        <p>API Key 只保存在本机；默认仅本次运行有效，可选择用 Windows 系统加密记住。所有请求由本机直接发往服务商，不经过中转服务器。</p>
        <div class="provider-layout">
          <div class="card card-pad" style="padding:10px">
            <div class="provider-list">
              ${S.providers.map((p) => `
                <button class="provider-pill ${provider && p.id === provider.id ? 'active' : ''}" data-settings-action="select-provider" data-provider="${esc(p.id)}">
                  <span class="provider-logo">${esc((p.name || '?').slice(0, 1))}</span>
                  <span style="min-width:0;flex:1"><span class="provider-name">${esc(p.name)}</span><span class="provider-sub">${p.models.length} 个模型${p.custom ? ' · 自定义' : ''}</span></span>
                  ${providerBadge(p)}
                </button>`).join('')}
            </div>
            <div class="divider" style="margin:10px 0"></div>
            <button class="btn small btn-block" data-settings-action="new-custom">${icon('plus')} 新增自定义服务</button>
          </div>
          <div class="card provider-form" id="providerFormWrap">
            ${provider ? renderProviderForm(provider) : '<div class="empty-mini">还没有可配置的服务</div>'}
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h2>默认模型与对话行为</h2>
        <p>新对话默认使用这里的模型；每个对话顶部仍可单独切换。文件权限对 Agent 的所有工具调用生效。</p>
        <div class="card card-pad">
          <div class="settings-row">
            <div class="left"><b>默认模型</b><span>新对话的初始模型</span></div>
            <div class="right">
              <select class="select" id="defaultModelSelect">${defaultModelOptions()}</select>
            </div>
          </div>
          <div class="settings-row">
            <div class="left"><b>默认工作区</b><span>没有为对话单独选择工作区时使用</span></div>
            <div class="right">
              <div class="inline">
                <input class="input" id="defaultWorkspaceInput" value="${esc(S.settings.defaultWorkspace || '')}" placeholder="未选择" readonly>
                <button class="btn small" data-settings-action="choose-workspace">${icon('folder')} 选择</button>
                <button class="btn small ghost" data-settings-action="clear-workspace">清除</button>
              </div>
            </div>
          </div>
          <div class="settings-row">
            <div class="left"><b>文件写入权限</b><span>只读会阻止所有写文件/执行命令；写入需确认会弹出系统确认框</span></div>
            <div class="right">
              <select class="select" id="settingsPermission">
                ${Object.entries(PERMISSIONS).map(([k, v]) => `<option value="${k}"${S.settings.permissions === k ? ' selected' : ''}>${v}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="settings-row">
            <div class="left"><b>允许执行命令</b><span>启用 run_command 工具；默认关闭。开启后仍受文件权限和确认框约束</span></div>
            <div class="right">
              <label class="switch"><input type="checkbox" id="settingsAllowCommands"${S.settings.allowCommands ? ' checked' : ''}><span class="slider"></span></label>
            </div>
          </div>
          <div class="settings-row">
            <div class="left"><b>卡住判定阈值</b><span>工位有积压且超过这个分钟数没有活动，标记为「卡住」</span></div>
            <div class="right">
              <div class="inline"><input class="input" id="settingsStale" type="number" min="1" max="240" value="${Number(S.settings.staleMinutes) || 8}" style="width:100px"><span class="small muted">分钟</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h2>MCP 服务</h2>
        <p>连接本机的 stdio MCP 服务；启用后它的工具会并入对话 Agent（名称以 mcp_ 开头）。工作流里的 file-watcher 就在这里接入，监听循环可以直接调用它。</p>
        <div class="card card-pad">
          <div class="settings-row">
            <div class="left"><b>MCP 工具自动执行</b><span>监听循环必须开启；关闭后每次调用都会弹确认框。MCP 服务由你配置，具有本机权限。</span></div>
            <div class="right">
              <label class="switch"><input type="checkbox" id="settingsMcpAuto"${S.settings.mcpAutoApprove !== false ? ' checked' : ''}><span class="slider"></span></label>
            </div>
          </div>
          <div class="divider" style="margin:4px 0 10px"></div>
          <div class="mcp-list">
            ${(S.mcpServers || []).length
              ? S.mcpServers.map((s) => mcpRowHtml(s)).join('')
              : '<div class="empty-mini" style="padding:8px 2px">还没有 MCP 服务。安装工作流后点「从工作流导入」，或手动添加。</div>'}
          </div>
          <div class="inline" style="margin-top:12px">
            <button class="btn small" data-settings-action="mcp-import">${icon('refresh')} 从工作流导入</button>
            <button class="btn small" data-settings-action="mcp-add">${icon('plus')} 添加服务</button>
          </div>
          <div class="hint" style="margin-top:8px">file-watcher 需要 Python 3.10+ 与 <span class="mono">mcp watchdog</span>；不可用时，监听循环会自动改用工作台内置监听（无需 Python）。</div>
        </div>
      </div>

      <div class="settings-section">
        <h2>外观</h2>
        <div class="card card-pad">
          <div class="settings-row">
            <div class="left"><b>主题</b><span>只影响工作台界面</span></div>
            <div class="right">
              <select class="select" id="settingsTheme">
                <option value="light"${S.settings.theme !== 'dark' ? ' selected' : ''}>浅色</option>
                <option value="dark"${S.settings.theme === 'dark' ? ' selected' : ''}>深色</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h2>本地数据</h2>
        <div class="card card-pad">
          <div class="settings-row">
            <div class="left"><b>数据目录</b><span class="mono">${esc(S.userDataDir)}</span></div>
            <div class="right"><button class="btn small" data-settings-action="open-data">${icon('folder')} 打开</button></div>
          </div>
          <div class="settings-row">
            <div class="left"><b>对话记录</b><span>${stats.conversations || S.conversations.length} 个对话</span></div>
            <div class="right"><button class="btn small danger" data-settings-action="clear-conversations">${icon('trash')} 清空所有对话</button></div>
          </div>
          <div class="settings-row">
            <div class="left"><b>API Key</b><span>${S.providers.filter((p) => p.keySet).length} 个 Key 当前可用 · ${S.settings.rememberKeys ? '已开启系统加密记忆' : '仅本次运行有效'}</span></div>
            <div class="right"><button class="btn small danger" data-settings-action="clear-keys">${icon('key')} 清除所有 Key</button></div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h2>关于</h2>
        <div class="card about-card">
          <h2>AIOA 协同工作台 <span class="badge blue">v${escapeVersion(S.version)}</span></h2>
          <p>一个本地 AI Agent 与文件协同工作流控制台。没有登录、没有云同步、没有计费，也不代收费用。</p>
          <div class="about-list">
            <div class="about-item"><b>直连模型</b><span>请求从你的电脑直接发往服务商</span></div>
            <div class="about-item"><b>Key 本机保存</b><span>可选 Windows DPAPI 加密，服务端不接触</span></div>
            <div class="about-item"><b>文件沙箱</b><span>Agent 只能访问你选择的工作区</span></div>
            <div class="about-item"><b>工作流控制</b><span>目录、角色卡、指令复制、需求投递</span></div>
          </div>
          <div class="form-actions"><button class="btn" data-settings-action="about">${icon('book')} 更多信息</button></div>
        </div>
      </div>
    </div>`;
}

function defaultModelOptions() {
  const current = S.settings.defaultModel;
  const parts = [];
  for (const p of S.providers) {
    if (!p.models || !p.models.length) continue;
    parts.push(`<optgroup label="${esc(p.name)}">`);
    for (const m of p.models) {
      const key = `${p.id}::${m}`;
      const suffix = p.requiresKey && !p.keySet ? '（未配置 Key）' : '';
      parts.push(`<option value="${esc(key)}"${current && modelValue(current) === key ? ' selected' : ''}>${esc(m + suffix)}</option>`);
    }
    parts.push('</optgroup>');
  }
  if (!parts.length) return '<option value="">（还没有模型）</option>';
  if (current && !S.providers.some((p) => p.id === current.providerId && p.models.includes(current.model))) {
    parts.unshift(`<option value="${esc(modelValue(current))}" selected>${esc(modelLabel(current))}</option>`);
  }
  return parts.join('');
}

function renderProviderForm(provider) {
  const remember = Boolean(S.settings.rememberKeys);
  const canEncrypt = Boolean(S.settings.canEncrypt);
  const keyStatus = provider.keySet
    ? `API Key 已配置${remember ? '，已用系统加密保存' : '，仅本次运行有效'}`
    : '尚未配置 API Key';
  return `
    <form id="providerForm">
      <div class="card-head">
        <div>
          <h3>${esc(provider.name)} ${provider.custom ? '<span class="badge purple">自定义</span>' : ''}</h3>
          <div class="desc">${esc(provider.description || '')} ${provider.docs ? `<a href="${esc(provider.docs)}">官方控制台</a>` : ''}</div>
        </div>
        <div class="actions" style="margin-left:auto">${providerBadge(provider)}</div>
      </div>
      <div class="form-grid">
        ${provider.custom ? `<div class="field"><label>服务名</label><input class="input" name="name" value="${esc(provider.name)}" autocomplete="off"></div>` : ''}
        <div class="field ${provider.custom ? '' : 'span-2'}">
          <label>接口地址 Base URL</label>
          <input class="input" name="baseUrl" value="${esc(provider.baseUrl)}" placeholder="https://api.example.com/v1" autocomplete="off">
          <div class="hint">OpenAI 兼容填到 /v1；Anthropic 填到 /v1。程序会自动拼接 /chat/completions 或 /messages。</div>
        </div>
        <div class="field">
          <label>接口类型</label>
          <select class="select" name="type">
            <option value="openai"${provider.type === 'anthropic' ? '' : ' selected'}>OpenAI 兼容</option>
            <option value="anthropic"${provider.type === 'anthropic' ? ' selected' : ''}>Anthropic Messages</option>
          </select>
        </div>
        <div class="field span-2">
          <label>API Key</label>
          <div class="key-row">
            <input class="input" name="apiKey" id="providerKeyInput" type="password" placeholder="${provider.keySet ? '已保存，留空保持不变' : (provider.requiresKey ? 'sk-...' : '无需 Key')}" autocomplete="off" ${provider.requiresKey ? '' : 'disabled'}>
            <button class="btn" type="button" data-settings-action="toggle-key">显示</button>
          </div>
          <div class="hint" id="providerKeyStatus">${esc(keyStatus)}</div>
        </div>
        <div class="field span-2">
          <label>模型列表</label>
          <textarea class="textarea" name="models" rows="4" placeholder="每行一个模型名，也可以逗号分隔">${esc((provider.models || []).join('\n'))}</textarea>
          <div class="hint">可以直接手填，也可以点「获取模型」从服务商 /models 拉取。以服务商实际返回为准。</div>
        </div>
      </div>
      <div class="switch-row">
        <label class="switch"><input type="checkbox" name="remember"${remember ? ' checked' : ''}${canEncrypt ? '' : ' disabled'}><span class="slider"></span></label>
        <div class="text"><b>在本机记住 API Key</b><span>${canEncrypt ? '使用 Windows 系统加密（DPAPI）。不开启则只在本次运行期间保存在内存。' : '当前系统加密不可用，Key 只会保存在内存中。'}</span></div>
      </div>
      ${canEncrypt ? '' : '<div class="warning-box" style="margin:10px 0">系统加密不可用，无法安全保存 Key。关闭应用后需要重新输入。</div>'}
      <div class="form-actions">
        <button class="btn primary" type="submit">${icon('check')} 保存配置</button>
        <button class="btn" type="button" data-settings-action="fetch-models">${icon('refresh')} 获取模型</button>
        ${provider.keySet ? `<button class="btn" type="button" data-settings-action="clear-key">${icon('key')} 清除 Key</button>` : ''}
        ${provider.custom ? `<button class="btn danger" type="button" data-settings-action="remove-custom">${icon('trash')} 删除服务</button>` : ''}
        <span class="status-text" id="providerStatus"></span>
      </div>
    </form>`;
}

function mcpRowHtml(s) {
  const tone = s.status === 'running' ? 'green' : s.status === 'error' ? 'red' : 'gray';
  const label = s.status === 'running' ? '运行中' : s.status === 'error' ? '错误' : '已停止';
  const cmd = [s.command].concat(s.args || []).join(' ');
  return `
    <div class="mcp-row">
      <div class="mcp-main">
        <div class="mcp-name">${esc(s.name)} <span class="badge ${tone}">${label}</span> <span class="badge gray">${(s.tools || []).length} 个工具</span></div>
        <div class="mcp-cmd mono" title="${esc(cmd)}">${esc(shortPath(cmd, 90))}</div>
        ${s.error ? `<div class="mcp-error">${esc(String(s.error).slice(0, 260))}</div>` : ''}
      </div>
      <div class="mcp-actions">
        <button class="btn tiny" data-settings-action="mcp-toggle" data-id="${esc(s.id)}" data-running="${s.status === 'running' ? '1' : '0'}">${s.status === 'running' ? '停止' : '启动'}</button>
        <button class="btn tiny" data-settings-action="mcp-tools" data-id="${esc(s.id)}">工具</button>
        <button class="btn tiny" data-settings-action="mcp-edit" data-id="${esc(s.id)}">编辑</button>
        <button class="btn tiny danger" data-settings-action="mcp-remove" data-id="${esc(s.id)}">删除</button>
      </div>
    </div>`;
}

async function refreshMcpServers() {
  try {
    S.mcpServers = await window.api.mcp.list();
    renderSettingsView();
  } catch (err) {
    showError(err, '刷新 MCP 服务失败');
  }
}

async function importWorkflowMcp() {
  try {
    const result = await window.api.mcp.importWorkflow();
    S.mcpServers = result.servers || [];
    renderSettingsView();
    if (result.added && result.added.length) toast(`已导入：${result.added.join('、')}`, 'ok', 4000);
    else toast('没有可导入的 MCP 服务', 'info');
  } catch (err) {
    showError(err, '导入失败');
  }
}

async function toggleMcpServer(id, running) {
  try {
    if (running) await window.api.mcp.stop(id);
    else await window.api.mcp.start(id);
    await refreshMcpServers();
    toast(running ? 'MCP 服务已停止' : 'MCP 服务已启动', 'ok', 1800);
  } catch (err) {
    await refreshMcpServers();
    showError(err, '操作 MCP 服务失败');
  }
}

async function showMcpTools(id) {
  try {
    const info = await window.api.mcp.tools(id);
    const tools = (info && info.tools) || [];
    showModal({
      title: `MCP 工具 · ${info ? info.name : id}`,
      subtitle: info ? [info.command].concat(info.args || []).join(' ') : '',
      body: `
        ${tools.length
          ? `<div class="tool-list">${tools.map((t) => `<div class="tool-list-item"><b class="mono">${esc(t)}</b></div>`).join('')}</div>`
          : '<div class="empty-mini">这个服务没有提供工具</div>'}
        ${info && info.error ? `<div class="warning-box" style="margin-top:10px">${esc(info.error)}</div>` : ''}
        <div class="hint" style="margin-top:10px">这些工具会以 <span class="mono">mcp_服务名_工具名</span> 的形式出现在对话 Agent 里。</div>`,
      footer: '<button class="btn" data-modal-close>关闭</button>',
    });
  } catch (err) {
    showError(err, '启动 MCP 服务失败');
    await refreshMcpServers();
  }
}

function openMcpEditor(id) {
  const server = (S.mcpServers || []).find((s) => s.id === id) || null;
  const args = server ? (server.args || []).join('\n') : '';
  const env = server ? Object.entries(server.env || {}).map(([k, v]) => `${k}=${v}`).join('\n') : '';
  showModal({
    title: server ? `编辑 MCP 服务 · ${server.name}` : '添加 MCP 服务',
    subtitle: '本地 stdio 服务。命令和参数按你系统里的实际路径填写。',
    wide: true,
    body: `
      <form id="mcpForm">
        <div class="form-grid">
          <div class="field"><label>名称</label><input class="input" name="name" value="${esc(server ? server.name : '')}" placeholder="file-watcher" autocomplete="off"></div>
          <div class="field"><label>启动命令</label><input class="input" name="command" value="${esc(server ? server.command : '')}" placeholder="python" autocomplete="off"></div>
          <div class="field span-2"><label>参数（每行一个）</label><textarea class="textarea" name="args" rows="3" placeholder="-u&#10;D:\\ai-workflow\\file_watcher_mcp.py">${esc(args)}</textarea></div>
          <div class="field span-2"><label>工作目录（可选）</label><input class="input" name="cwd" value="${esc(server ? server.cwd : '')}" placeholder="D:\\ai-workflow" autocomplete="off"></div>
          <div class="field span-2"><label>环境变量（每行一个 KEY=VALUE）</label><textarea class="textarea" name="env" rows="3" placeholder="PYTHONUTF8=1&#10;PYTHONIOENCODING=utf-8">${esc(env)}</textarea></div>
        </div>
      </form>`,
    footer: `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="mcpSaveBtn">${icon('check')} 保存</button>`,
    onMount: (root, close) => {
      const save = async () => {
        const form = $('#mcpForm', root);
        const data = formDataObject(form);
        try {
          const result = await window.api.mcp.save({
            id: server ? server.id : undefined,
            name: data.name,
            command: data.command,
            args: data.args,
            cwd: data.cwd,
            env: data.env,
            enabled: true,
          });
          S.mcpServers = result.servers || [];
          close();
          renderSettingsView();
          toast('MCP 服务已保存', 'ok');
        } catch (err) {
          showError(err, '保存 MCP 服务失败');
        }
      };
      $('#mcpSaveBtn', root).addEventListener('click', save);
      $('#mcpForm', root).addEventListener('submit', (e) => {
        e.preventDefault();
        save();
      });
    },
  });
}

async function removeMcpServer(id) {
  const server = (S.mcpServers || []).find((s) => s.id === id);
  const ok = await confirmAction({
    title: '删除 MCP 服务',
    message: `确定删除「${server ? server.name : id}」？`,
    detail: '只删除工作台里的连接配置，不会删除服务脚本本身。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    S.mcpServers = await window.api.mcp.remove(id);
    renderSettingsView();
    toast('MCP 服务已删除', 'ok');
  } catch (err) {
    showError(err, '删除 MCP 服务失败');
  }
}

/* ============================== settings actions ============================== */
async function newCustomProvider() {
  try {
    const before = new Set(S.providers.map((p) => p.id));
    const list = await window.api.providers.save({
      id: 'custom',
      isNewCustom: true,
      name: '自定义服务',
      baseUrl: '',
      type: 'openai',
      models: [],
      requiresKey: true,
    });
    S.providers = list;
    const created = S.providers.find((p) => p.custom && !before.has(p.id));
    if (created) S.settingsProviderId = created.id;
    renderSettingsView();
    renderTopbar();
    toast('已添加自定义服务，请填写接口地址和 Key', 'ok');
  } catch (err) {
    showError(err, '添加自定义服务失败');
  }
}

async function saveProviderForm(form) {
  const data = formDataObject(form);
  const provider = providerById(S.settingsProviderId);
  if (!provider) return;
  const models = String(data.models || '').split(/[\n,]/).map((m) => m.trim()).filter(Boolean);
  const remember = Boolean(data.remember) && Boolean(S.settings.canEncrypt);
  const payload = {
    id: provider.id,
    baseUrl: String(data.baseUrl || '').trim(),
    type: data.type === 'anthropic' ? 'anthropic' : 'openai',
    models,
    remember,
  };
  if (provider.custom) payload.name = String(data.name || provider.name).trim();
  if (String(data.apiKey || '').trim()) payload.apiKey = String(data.apiKey).trim();
  try {
    S.providers = await window.api.providers.save(payload);
    S.settings.rememberKeys = remember;
    if (remember && !S.settings.canEncrypt) toast('系统加密不可用，Key 只会保留在内存', 'err', 4500);
    else toast('模型服务已保存', 'ok');
    renderSettingsView();
    renderTopbar();
  } catch (err) {
    showError(err, '保存模型服务失败');
  }
}

async function fetchProviderModels() {
  const form = $('#providerForm');
  if (!form) return;
  const data = formDataObject(form);
  const provider = providerById(S.settingsProviderId);
  if (!provider) return;
  const status = $('#providerStatus');
  if (status) { status.className = 'status-text'; status.textContent = '正在连接服务商…'; }
  try {
    const result = await window.api.providers.fetchModels({
      id: provider.id,
      apiKey: String(data.apiKey || '').trim(),
      baseUrl: String(data.baseUrl || '').trim(),
      type: data.type,
      name: data.name || provider.name,
      requiresKey: provider.requiresKey,
    });
    const textarea = $('[name="models"]', form);
    if (textarea) textarea.value = result.models.join('\n');
    if (status) {
      status.className = 'status-text ok';
      status.textContent = `获取到 ${result.models.length} 个模型。点「保存配置」后生效。`;
    }
    toast(`获取到 ${result.models.length} 个模型`, 'ok');
  } catch (err) {
    if (status) {
      status.className = 'status-text err';
      status.textContent = `获取失败：${err.message || err}`;
    }
    showError(err, '获取模型失败');
  }
}

async function clearProviderKey() {
  const provider = providerById(S.settingsProviderId);
  if (!provider) return;
  const ok = await confirmAction({
    title: '清除 API Key',
    message: `确定清除 ${provider.name} 的 API Key？`,
    detail: '已加密保存的 Key 会从本机删除，当前内存中的 Key 也会清除。',
    confirmText: '清除',
    danger: true,
  });
  if (!ok) return;
  try {
    S.providers = await window.api.providers.clearKey(provider.id);
    renderSettingsView();
    renderTopbar();
    toast('Key 已清除', 'ok');
  } catch (err) {
    showError(err, '清除 Key 失败');
  }
}

async function removeCustomProvider() {
  const provider = providerById(S.settingsProviderId);
  if (!provider || !provider.custom) return;
  const ok = await confirmAction({
    title: '删除自定义服务',
    message: `确定删除 ${provider.name}？`,
    detail: '服务配置和 Key 会从本机删除，不会影响其他服务。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    S.providers = await window.api.providers.removeCustom(provider.id);
    const next = S.providers.find((p) => p.keySet) || S.providers[0];
    S.settingsProviderId = next ? next.id : 'deepseek';
    renderSettingsView();
    renderTopbar();
    toast('自定义服务已删除', 'ok');
  } catch (err) {
    showError(err, '删除服务失败');
  }
}

async function chooseDefaultWorkspace() {
  try {
    const picked = await window.api.app.chooseDirectory({
      title: '选择默认工作区',
      defaultPath: S.settings.defaultWorkspace || undefined,
    });
    if (!picked) return;
    await saveSettings({ defaultWorkspace: picked });
    const input = $('#defaultWorkspaceInput');
    if (input) input.value = picked;
    updateComposerHint();
    renderTopbar();
    toast('默认工作区已保存', 'ok');
  } catch (err) {
    showError(err, '选择工作区失败');
  }
}

async function clearDefaultWorkspace() {
  await saveSettings({ defaultWorkspace: '' });
  const input = $('#defaultWorkspaceInput');
  if (input) input.value = '';
  updateComposerHint();
  renderTopbar();
  toast('默认工作区已清除', 'ok');
}

async function clearAllConversations() {
  const ok = await confirmAction({
    title: '清空所有对话',
    message: '确定删除本机保存的所有对话记录？',
    detail: '这会删除消息、工具调用记录和对话标题，无法恢复。API Key 和工作流文件不受影响。',
    confirmText: '清空',
    danger: true,
  });
  if (!ok) return;
  try {
    await window.api.chat.clear();
    S.conversations = [];
    S.activeConv = null;
    S.activeConvId = '';
    S.live = null;
    S.stats = { ...(S.stats || {}), conversations: 0 };
    renderSidebar();
    renderTopbar();
    renderChatView();
    renderSettingsView();
    toast('所有对话已清空', 'ok');
  } catch (err) {
    showError(err, '清空对话失败');
  }
}

async function clearAllKeys() {
  const ok = await confirmAction({
    title: '清除所有 API Key',
    message: '确定清除本机保存的所有 Key？',
    detail: '内存中的 Key 和加密文件里的 Key 都会被删除。之后需要重新填写。',
    confirmText: '全部清除',
    danger: true,
  });
  if (!ok) return;
  try {
    S.providers = await window.api.providers.clearAllKeys();
    S.stats = { ...(S.stats || {}), keys: 0 };
    renderSettingsView();
    renderTopbar();
    toast('所有 Key 已清除', 'ok');
  } catch (err) {
    showError(err, '清除 Key 失败');
  }
}

async function onSettingsClick(e) {
  const action = e.target.closest('[data-settings-action]');
  if (!action) return;
  const name = action.dataset.settingsAction;
  if (name === 'select-provider') {
    S.settingsProviderId = action.dataset.provider;
    renderSettingsView();
    return;
  }
  if (name === 'new-custom') { await newCustomProvider(); return; }
  if (name === 'fetch-models') { await fetchProviderModels(); return; }
  if (name === 'clear-key') { await clearProviderKey(); return; }
  if (name === 'remove-custom') { await removeCustomProvider(); return; }
  if (name === 'toggle-key') {
    const input = $('#providerKeyInput');
    if (input) {
      input.type = input.type === 'password' ? 'text' : 'password';
      action.textContent = input.type === 'password' ? '显示' : '隐藏';
    }
    return;
  }
  if (name === 'choose-workspace') { await chooseDefaultWorkspace(); return; }
  if (name === 'clear-workspace') { await clearDefaultWorkspace(); return; }
  if (name === 'clear-conversations') { await clearAllConversations(); return; }
  if (name === 'clear-keys') { await clearAllKeys(); return; }
  if (name === 'open-data') { await window.api.app.openUserData().catch(showError); return; }
  if (name === 'about') { openAboutModal(); return; }
  if (name === 'mcp-import') { await importWorkflowMcp(); return; }
  if (name === 'mcp-add') { openMcpEditor(null); return; }
  if (name === 'mcp-edit') { openMcpEditor(action.dataset.id); return; }
  if (name === 'mcp-toggle') { await toggleMcpServer(action.dataset.id, action.dataset.running === '1'); return; }
  if (name === 'mcp-tools') { await showMcpTools(action.dataset.id); return; }
  if (name === 'mcp-remove') { await removeMcpServer(action.dataset.id); return; }
}

async function onSettingsSubmit(e) {
  if (e.target.id === 'providerForm') {
    e.preventDefault();
    await saveProviderForm(e.target);
  }
}

async function onSettingsChange(e) {
  const id = e.target.id;
  if (id === 'defaultModelSelect') {
    const model = parseModelValue(e.target.value);
    if (!model) return;
    try {
      await saveSettings({ defaultModel: model });
      toast(`默认模型已设为 ${modelLabel(model)}`, 'ok', 2000);
      renderTopbar();
    } catch (err) { showError(err, '保存默认模型失败'); }
    return;
  }
  if (id === 'settingsPermission') {
    await saveSettings({ permissions: e.target.value });
    updateComposerHint();
    toast(`文件权限：${PERMISSIONS[e.target.value]}`, 'ok', 1800);
    return;
  }
  if (id === 'settingsAllowCommands') {
    await saveSettings({ allowCommands: e.target.checked });
    toast(e.target.checked ? '已允许执行命令（仍需确认）' : '已关闭命令执行', 'ok', 2200);
    return;
  }
  if (id === 'settingsMcpAuto') {
    await saveSettings({ mcpAutoApprove: e.target.checked });
    toast(e.target.checked ? 'MCP 工具将自动执行' : 'MCP 工具调用将需要确认', 'ok', 2200);
    return;
  }
  if (id === 'settingsTheme') {
    await saveSettings({ theme: e.target.value });
    applyTheme(e.target.value);
    return;
  }
  if (id === 'settingsStale') {
    const n = Math.max(1, Math.min(240, Number(e.target.value) || 8));
    e.target.value = n;
    await saveSettings({ staleMinutes: n });
    toast(`卡住阈值：${n} 分钟`, 'ok', 1800);
    return;
  }
  if (e.target.name === 'remember') {
    const remember = e.target.checked;
    await saveSettings({ rememberKeys: remember });
    if (!remember) toast('已关闭 Key 记忆，本机加密文件已清除；当前内存中的 Key 仍可用', 'info', 5000);
    else toast('已开启 Key 记忆（系统加密）', 'ok');
  }
}

function onSettingsInput() {
  // 目前所有设置都在 change 时保存，保留占位以便后续扩展
}
