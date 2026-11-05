'use strict';

/* ============================== helpers ============================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const PERMISSIONS = {
  readonly: '只读',
  ask: '写入需确认',
  auto: '自动写入',
};

const STATION_ORDER = ['01', '02', '04', '05', '03', '06', '07', '08'];

const S = {
  view: 'chat',
  settings: null,
  providers: [],
  conversations: [],
  workflow: null,
  activeConvId: '',
  activeConv: null,
  running: new Set(),
  finishHandled: new Set(),
  loops: new Map(),
  mcpServers: [],
  customWorkflows: [],
  live: null,
  workflowTab: 'overview',
  terminalFilter: 'all',
  settingsProviderId: 'deepseek',
  requirementDraft: {
    title: '', priority: 'P1', baseline: '', codeBaseline: '',
    background: '', goal: '', scope: '', nonGoals: '', acceptance: '', constraints: '',
  },
  workflowBusy: false,
  installProgress: '',
  version: '1.0.0',
  userDataDir: '',
  defaultRoot: '',
  stats: null,
  modalOpen: false,
  modalClose: null,
};

let modalEscHandler = null;
let chatRenderFrame = 0;

/* ============================== formatting ============================== */
function basename(p) {
  if (!p) return '';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function shortPath(p, max = 46) {
  const value = String(p || '');
  if (!value) return '';
  if (value.length <= max) return value;
  return `…${value.slice(-(max - 1))}`;
}

function timeHM(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
  if (diff < 10 * 1000) return '刚刚';
  if (diff < 60 * 1000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function providerById(id) {
  return S.providers.find((p) => p.id === id) || null;
}

function modelLabel(model) {
  if (!model) return '未选择模型';
  const p = providerById(model.providerId);
  return `${p ? p.name : model.providerId} · ${model.model}`;
}

function currentModel() {
  return (S.activeConv && S.activeConv.model) || (S.settings && S.settings.defaultModel) || null;
}

function pickDefaultModel() {
  const provider = S.providers.find((p) => (p.keySet || !p.requiresKey) && p.models && p.models.length);
  if (!provider) return null;
  return { providerId: provider.id, model: provider.models[0] };
}

function modelValue(model) {
  return model ? `${model.providerId}::${model.model}` : '';
}

function parseModelValue(value) {
  const idx = String(value || '').indexOf('::');
  if (idx === -1) return null;
  return { providerId: value.slice(0, idx), model: value.slice(idx + 2) };
}

function providerStatusText(provider) {
  if (!provider) return '';
  if (!provider.requiresKey) return '无需 Key';
  return provider.keySet ? '已配置' : '未配置';
}

function providerBadge(provider) {
  if (!provider) return '<span class="badge gray">未知</span>';
  if (!provider.requiresKey) return '<span class="badge green">无需 Key</span>';
  if (provider.keySet) return '<span class="badge green">已配置</span>';
  return '<span class="badge gray">未配置</span>';
}

function badgeTone(tone) {
  return ['green', 'blue', 'red', 'purple', 'gray'].includes(tone) ? tone : 'gray';
}

function icon(name, cls = 'icon') {
  return `<svg class="${cls}"><use href="#i-${name}"></use></svg>`;
}

/* ============================== toast / copy ============================== */
function toast(message, type = 'info', ms = 3200) {
  const root = $('#toastRoot');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const ic = type === 'err' ? 'alert' : type === 'ok' ? 'check' : 'spark';
  el.innerHTML = `${icon(ic)}<div>${esc(message)}</div>`;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'all .2s';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

async function copyText(text, okMessage = '已复制到剪贴板') {
  try {
    await window.api.app.copyText(String(text || ''));
    toast(okMessage, 'ok');
    return true;
  } catch (err) {
    try {
      await navigator.clipboard.writeText(String(text || ''));
      toast(okMessage, 'ok');
      return true;
    } catch {
      toast(`复制失败：${err.message || err}`, 'err');
      return false;
    }
  }
}

function showError(err, fallback = '操作失败') {
  const message = (err && err.message) || String(err) || fallback;
  toast(message, 'err', 5200);
  if (err && err.detail) console.warn('detail:', err.detail);
}

/* ============================== modal ============================== */
function closeModal() {
  const root = $('#modalRoot');
  if (!root) return;
  const close = S.modalClose;
  S.modalClose = null;
  S.modalOpen = false;
  root.innerHTML = '';
  if (modalEscHandler) {
    document.removeEventListener('keydown', modalEscHandler);
    modalEscHandler = null;
  }
  if (close) close();
}

function showModal({
  title, subtitle = '', body = '', footer = '',
  wide = false, narrow = false, onMount = null, onClose = null,
  closeOnBackdrop = true,
}) {
  closeModal();
  const root = $('#modalRoot');
  const widthClass = wide ? 'wide' : narrow ? 'narrow' : '';
  root.innerHTML = `
    <div class="modal-backdrop" data-backdrop>
      <div class="modal ${widthClass}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h2>${esc(title)}</h2>
            ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
          </div>
          <button class="icon-btn modal-close" data-modal-close title="关闭">${icon('plus')}</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  // 关闭按钮使用旋转的 + 作为 ×，避免额外图标
  const closeBtn = $('.modal-close', root);
  if (closeBtn) closeBtn.style.transform = 'rotate(45deg)';

  const close = () => {
    const cb = S.modalClose;
    S.modalClose = null;
    S.modalOpen = false;
    root.innerHTML = '';
    if (modalEscHandler) {
      document.removeEventListener('keydown', modalEscHandler);
      modalEscHandler = null;
    }
    if (onClose) onClose();
  };
  S.modalClose = close;
  S.modalOpen = true;

  root.querySelectorAll('[data-modal-close]').forEach((btn) => {
    btn.addEventListener('click', close);
  });
  const backdrop = $('[data-backdrop]', root);
  if (closeOnBackdrop) {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
  }
  modalEscHandler = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', modalEscHandler);

  if (onMount) onMount($('.modal', root), close);
  return { root: $('.modal', root), close };
}

function confirmAction({ title, message, detail = '', confirmText = '确认', danger = false, narrow = true }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const m = showModal({
      title,
      body: `
        <div class="settings-row" style="padding-top:0;border:0">
          <div class="left">
            <b style="font-size:13px">${esc(message)}</b>
            ${detail ? `<span style="white-space:pre-wrap">${esc(detail)}</span>` : ''}
          </div>
        </div>`,
      footer: `<button class="btn" data-modal-close>取消</button>
               <button class="btn ${danger ? 'danger' : 'primary'}" id="modalConfirmBtn">${esc(confirmText)}</button>`,
      narrow,
      onClose: () => finish(false),
      onMount: (root, close) => {
        $('#modalConfirmBtn', root).addEventListener('click', () => {
          finish(true);
          close();
        });
      },
    });
    return m;
  });
}

function previewModal(title, content, subtitle = '') {
  showModal({
    title,
    subtitle,
    wide: true,
    body: `<div class="markdown" id="previewMarkdown">${renderMarkdown(content)}</div>`,
    footer: `<button class="btn" data-modal-close>关闭</button>
             <button class="btn primary" id="previewCopyBtn">${icon('copy')} 复制全文</button>`,
    onMount: (root) => {
      $('#previewCopyBtn', root).addEventListener('click', () => copyText(content, '内容已复制'));
      enhanceMarkdown($('#previewMarkdown', root));
    },
  });
}

/* ============================== markdown ============================== */
function renderMarkdown(text) {
  const source = String(text || '');
  if (!source) return '';
  try {
    if (window.marked) {
      const parser = window.marked.parse || (window.marked.default && window.marked.default.parse);
      const html = parser(source, { gfm: true, breaks: true });
      if (window.DOMPurify) {
        return window.DOMPurify.sanitize(html, {
          ADD_TAGS: ['details', 'summary'],
          ADD_ATTR: ['open'],
        });
      }
      return html;
    }
  } catch (err) {
    console.warn('markdown render failed', err);
  }
  return `<pre>${esc(source)}</pre>`;
}

function enhanceMarkdown(container) {
  if (!container) return;
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.dataset.enhanced) return;
    pre.dataset.enhanced = '1';
    const code = pre.querySelector('code');
    if (!code) return;
    const langMatch = String(code.className || '').match(/language-([\w-]+)/);
    if (langMatch) {
      const span = document.createElement('span');
      span.className = 'code-lang';
      span.textContent = langMatch[1];
      pre.appendChild(span);
    }
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.type = 'button';
    btn.dataset.codeCopy = '1';
    btn.textContent = '复制';
    pre.appendChild(btn);
  });
}

function mountMarkdown(el, text) {
  if (!el) return;
  el.innerHTML = renderMarkdown(text);
  el.classList.add('markdown');
  enhanceMarkdown(el);
}

/* ============================== state ============================== */
function applyTheme(theme) {
  const value = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = value;
  document.body.dataset.theme = value;
}

async function saveSettings(patch, { silent = true } = {}) {
  const saved = await window.api.app.saveSettings(patch);
  S.settings = { ...(S.settings || {}), ...(saved || {}) };
  if (patch && patch.theme) applyTheme(patch.theme);
  if (!silent) toast('设置已保存', 'ok');
  return S.settings;
}

async function refreshProviders() {
  S.providers = await window.api.providers.list();
  if (!providerById(S.settingsProviderId)) {
    const first = S.providers.find((p) => p.keySet) || S.providers[0];
    S.settingsProviderId = first ? first.id : 'deepseek';
  }
}

async function refreshConversations() {
  S.conversations = await window.api.chat.list();
  if (S.activeConvId && !S.conversations.some((c) => c.id === S.activeConvId)) {
    S.activeConvId = '';
    S.activeConv = null;
  }
  renderSidebar();
}

async function applyAppState(state) {
  S.settings = state.settings || {};
  S.providers = state.providers || [];
  S.conversations = state.conversations || [];
  S.workflow = state.workflow || null;
  S.version = state.version || '1.0.0';
  S.userDataDir = state.userDataDir || '';
  S.defaultRoot = state.defaultRoot || '';
  S.stats = state.stats || null;
  S.mcpServers = state.mcpServers || [];
  S.customWorkflows = state.customWorkflows || [];
  S.loops = new Map((state.loops || []).map((loop) => [loop.conversationId, loop]));
  applyTheme(S.settings.theme);
  if (!providerById(S.settingsProviderId)) {
    const first = S.providers.find((p) => p.keySet) || S.providers[0];
    S.settingsProviderId = first ? first.id : 'deepseek';
  }
  updateWorkflowAlert();
}

function updateWorkflowAlert() {
  const dot = $('#workflowAlertDot');
  if (!dot) return;
  const w = S.workflow;
  const count = w && w.counts ? (w.counts.decisions || 0) + (w.counts.blockers || 0) + (w.counts.stuck || 0) : 0;
  dot.classList.toggle('hidden', count === 0);
  dot.title = count ? `${count} 项需要关注` : '';
}

async function loadConversation(id) {
  if (!id) return;
  try {
    const conv = await window.api.chat.get(id);
    S.activeConvId = id;
    S.activeConv = conv;
    S.live = null;
    S.view = 'chat';
    await saveSettings({ lastConversationId: id });
    switchView('chat');
    renderSidebar();
    renderTopbar();
    renderChatView();
  } catch (err) {
    showError(err, '打开对话失败');
  }
}

function clearActiveConversation() {
  S.activeConvId = '';
  S.activeConv = null;
  S.live = null;
  saveSettings({ lastConversationId: '' });
  renderSidebar();
  renderTopbar();
  renderChatView();
}

/* ============================== sidebar ============================== */
function renderSidebar() {
  const list = $('#conversationList');
  if (!list) return;
  if (!S.conversations.length) {
    list.innerHTML = '<div class="empty-mini" style="padding:18px 12px;font-size:11px">还没有对话<br>点右上角 + 开始</div>';
    return;
  }
  list.innerHTML = S.conversations.map((conv) => {
    const active = conv.id === S.activeConvId ? 'active' : '';
    const running = S.running.has(conv.id);
    const provider = conv.model ? providerById(conv.model.providerId) : null;
    const sub = conv.model ? `${provider ? provider.name : conv.model.providerId}` : '未选择模型';
    return `
      <div class="conv-item ${active}" data-conv-id="${esc(conv.id)}">
        <div class="conv-title" title="双击重命名">${esc(conv.title || '新对话')}</div>
        <div class="conv-meta">
          ${running ? '<span class="conv-running"></span>' : ''}
          <span>${esc(sub)}</span>
          <span>·</span>
          <span>${relTime(conv.updatedAt)}</span>
        </div>
        <button class="conv-rename" data-rename-conv="${esc(conv.id)}" title="重命名对话">${icon('edit')}</button>
        <button class="conv-delete" data-delete-conv="${esc(conv.id)}" title="删除对话">${icon('trash')}</button>
      </div>`;
  }).join('');
}

/* ============================== topbar ============================== */
function renderTopbar() {
  const bar = $('#topbar');
  if (!bar) return;
  if (S.view === 'chat') renderChatTopbar(bar);
  else if (S.view === 'workflow') renderWorkflowTopbar(bar);
  else renderSettingsTopbar(bar);
}

function chatModelOptions() {
  const current = currentModel();
  const options = [];
  if (!current) options.push('<option value="" selected>选择模型…</option>');
  for (const p of S.providers) {
    if (!p.models || !p.models.length) continue;
    options.push(`<optgroup label="${esc(p.name)}">`);
    for (const m of p.models) {
      const key = `${p.id}::${m}`;
      const disabled = p.requiresKey && !p.keySet ? ' disabled' : '';
      const label = p.requiresKey && !p.keySet ? `${m}（未配置 Key）` : m;
      options.push(`<option value="${esc(key)}"${current && modelValue(current) === key ? ' selected' : ''}${disabled}>${esc(label)}</option>`);
    }
    options.push('</optgroup>');
  }
  if (current && !S.providers.some((p) => p.id === current.providerId && p.models.includes(current.model))) {
    options.unshift(`<option value="${esc(modelValue(current))}" selected>${esc(modelLabel(current))}</option>`);
  }
  return options.join('');
}

function renderChatTopbar(bar) {
  const conv = S.activeConv;
  const model = currentModel();
  const workspace = (conv && conv.workspace) || (S.settings && S.settings.defaultWorkspace) || '';
  const permission = (S.settings && S.settings.permissions) || 'ask';
  const running = conv && S.running.has(conv.id);
  const loop = conv && S.loops instanceof Map ? S.loops.get(conv.id) : null;
  const options = chatModelOptions();
  const configured = Boolean(model) || S.providers.some((p) => p.models && p.models.length && (p.keySet || !p.requiresKey));
  const modelControl = configured
    ? `<label class="top-control select-like" title="选择模型">
         ${icon('model')}
         <select id="modelSelect">${options}</select>
       </label>`
    : `<button class="top-control warn" data-top-action="open-settings-models">${icon('model')}<span class="label">配置模型</span></button>`;
  bar.innerHTML = `
    <div class="topbar-title">
      <h1>${esc(conv ? conv.title : '新对话')}</h1>
      <div class="sub">
        ${model ? esc(modelLabel(model)) : '尚未选择模型'}
        <span>·</span>
        <span>${conv ? `${(conv.messages || []).length} 条消息` : '本地 Agent'}</span>
        ${running ? '<span class="badge blue"><span class="dot"></span>生成中</span>' : ''}
        ${loop ? `<span class="badge amber"><span class="dot"></span>监听中 · ${loop.rounds || 0}</span>` : ''}
      </div>
    </div>
    <div class="topbar-actions">
      ${modelControl}
      <button class="top-control ${workspace ? '' : 'warn'}" data-top-action="workspace" title="${esc(workspace || '选择工作区')}">
        ${icon('folder')}<span class="label">${esc(workspace ? basename(workspace) : '选择工作区')}</span>
      </button>
      <label class="top-control select-like" title="文件写入权限">
        <select id="permissionSelect">
          ${Object.entries(PERMISSIONS).map(([k, v]) => `<option value="${k}"${permission === k ? ' selected' : ''}>${v}</option>`).join('')}
        </select>
      </label>
      ${conv ? (loop
        ? `<button class="top-control warn" data-top-action="loop-stop" title="停止循环监听">${icon('pause')}<span class="label">停止监听</span></button>`
        : `<button class="top-control" data-top-action="loop-start" title="循环监听收件箱">${icon('clock')}<span class="label">监听</span></button>`) : ''}
      ${conv ? `<button class="icon-btn" data-top-action="export" title="导出对话">${icon('copy')}</button>` : ''}
      ${conv && !running && (conv.messages || []).length > 10 ? `<button class="icon-btn" data-top-action="compress" title="压缩历史：把较早消息摘要，保留最近 8 条">${icon('book')}</button>` : ''}
      <button class="icon-btn" data-top-action="new-chat" title="新建对话">${icon('plus')}</button>
    </div>`;
}

function renderWorkflowTopbar(bar) {
  const w = S.workflow;
  const installed = w && w.installed;
  const projectOptions = (w && w.projects ? w.projects : []).map((p) =>
    `<option value="${esc(p.name)}"${p.active ? ' selected' : ''}>${esc(p.name)}${p.title ? ` · ${p.title}` : ''}</option>`
  ).join('');
  bar.innerHTML = `
    <div class="topbar-title">
      <h1>工作流控制台</h1>
      <div class="sub">${installed ? `${esc(w.project)} · 版本 v${w.version}` : '搭建文件系统驱动的多 AI 协同流水线'}</div>
    </div>
    <div class="topbar-actions">
      ${installed && projectOptions ? `<select class="select" id="projectSelect" style="width:220px;height:34px" title="切换活动项目">${projectOptions}</select>` : ''}
      ${installed ? `<span class="badge ${w.globalStatus === 'PAUSED' ? 'amber' : 'green'}"><span class="dot"></span>${w.globalStatus}</span>` : ''}
      ${installed ? `<button class="btn small" data-top-action="pause">${icon('pause')} 暂停全部</button>` : ''}
      ${installed && w.globalStatus === 'PAUSED' ? `<button class="btn small primary" data-top-action="resume">${icon('play')} 恢复全部</button>` : ''}
      <button class="btn small" data-top-action="refresh-workflow">${icon('refresh')} 刷新</button>
      ${installed ? `<button class="btn small" data-top-action="open-root">${icon('folder')} 根目录</button>` : ''}
    </div>`;
}

function renderSettingsTopbar(bar) {
  bar.innerHTML = `
    <div class="topbar-title">
      <h1>设置</h1>
      <div class="sub">模型服务、工作区与本地数据</div>
    </div>
    <div class="topbar-actions">
      <span class="pill">v${escapeVersion(S.version)}</span>
      <button class="btn small" data-top-action="about">${icon('book')} 关于</button>
    </div>`;
}

function escapeVersion(v) {
  return String(v || '').replace(/[^\w.-]/g, '');
}

/* ============================== view switching ============================== */
function switchView(view) {
  S.view = view;
  $$('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
  $('#view-chat').classList.toggle('hidden', view !== 'chat');
  $('#view-workflow').classList.toggle('hidden', view !== 'workflow');
  $('#view-settings').classList.toggle('hidden', view !== 'settings');
  renderTopbar();
  if (view === 'chat') {
    renderChatView();
    setTimeout(() => {
      const input = $('#chatInput');
      if (input && window.innerWidth > 0) input.focus();
    }, 30);
  } else if (view === 'workflow') {
    renderWorkflowView();
  } else {
    renderSettingsView();
  }
}

function updateComposerHint() {
  const hint = $('#composerHint');
  if (!hint) return;
  const conv = S.activeConv;
  const running = conv && S.running.has(conv.id);
  if (running) {
    hint.textContent = '正在生成…可以点击停止，或切换到其他对话';
    return;
  }
  const workspace = (conv && conv.workspace) || (S.settings && S.settings.defaultWorkspace) || '';
  const permission = PERMISSIONS[(S.settings && S.settings.permissions) || 'ask'];
  hint.textContent = workspace
    ? `工作区：${shortPath(basename(workspace), 28)} · 权限：${permission}`
    : '未选择工作区 · 文件工具不可用';
}

function updateRunningUI() {
  const running = Boolean(S.activeConv && S.running.has(S.activeConv.id));
  const stopBtn = $('#stopBtn');
  const sendBtn = $('#sendBtn');
  if (stopBtn) stopBtn.classList.toggle('hidden', !running);
  if (sendBtn) {
    sendBtn.disabled = running;
    sendBtn.innerHTML = running ? `${icon('send')} 生成中` : `${icon('send')} 发送`;
  }
  updateComposerHint();
  renderSidebar();
}

/* ============================== common actions ============================== */
async function createNewChat() {
  try {
    const model = pickDefaultModel() || (S.settings && S.settings.defaultModel) || null;
    const workspace = (S.settings && S.settings.defaultWorkspace) || '';
    const conv = await window.api.chat.create({ model, workspace });
    S.conversations = await window.api.chat.list();
    S.activeConvId = conv.id;
    S.activeConv = conv;
    S.live = null;
    await saveSettings({ lastConversationId: conv.id });
    switchView('chat');
    renderSidebar();
    renderTopbar();
    renderChatView();
  } catch (err) {
    showError(err, '新建对话失败');
  }
}

async function openAboutModal() {
  const stats = S.stats || {};
  showModal({
    title: 'AIOA 协同工作台',
    subtitle: `版本 v${S.version}`,
    body: `
      <div class="about-card" style="padding:0;border:0;box-shadow:none">
        <p>本地运行的 AI Agent 与协同工作流控制台。没有账号系统，没有中转服务器，不收费。所有模型请求由本机直接发往你选择的服务商，API Key 只保存在本机。</p>
        <div class="about-list">
          <div class="about-item"><b>AI 对话</b><span>选择模型，流式对话，可读写工作区文件</span></div>
          <div class="about-item"><b>工作流控制台</b><span>安装 8 工位目录树、投递需求、看汇报终端</span></div>
          <div class="about-item"><b>指令复制</b><span>上班 / 下班 / 继续监听 / 角色卡一键复制</span></div>
          <div class="about-item"><b>本地数据</b><span>${stats.conversations || 0} 个对话 · ${stats.keys || 0} 个 Key 在内存/本机</span></div>
        </div>
        <div class="divider"></div>
        <div class="profile-kv">
          <div class="k">数据目录</div><div class="v mono">${esc(S.userDataDir || '')}</div>
          <div class="k">Key 存储</div><div class="v">${S.settings && S.settings.canEncrypt ? '可选 Windows 系统加密（DPAPI）' : '系统加密不可用，仅保存在内存'}</div>
          <div class="k">运行方式</div><div class="v">本机 Electron 桌面应用</div>
        </div>
        <div class="warning-box blue" style="margin-top:14px">不提供登录、云同步、计费或代充。API 费用由你和服务商直接结算。</div>
      </div>`,
    footer: `<button class="btn" data-modal-close>关闭</button>
             <button class="btn" id="aboutOpenData">${icon('folder')} 打开数据目录</button>`,
    onMount: (root) => {
      $('#aboutOpenData', root).addEventListener('click', () => window.api.app.openUserData().catch(showError));
    },
  });
}

/* ============================== refresh loop ============================== */
let refreshTimer = null;

function startRefreshLoop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    if (S.view !== 'workflow' || !S.workflow || !S.workflow.installed) return;
    if (S.workflowTab !== 'overview' || S.workflowBusy || S.modalOpen) return;
    try {
      const w = await window.api.workflow.getState();
      if (!w) return;
      S.workflow = w;
      updateWorkflowAlert();
      renderTopbar();
      if (S.view === 'workflow' && S.workflowTab === 'overview') renderWorkflowView();
    } catch {
      /* silent */
    }
  }, 9000);
}
