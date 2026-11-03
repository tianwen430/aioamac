'use strict';

/* ============================== chat rendering ============================== */
function renderChatView() {
  const container = $('#chatMessages');
  if (!container) return;
  const empty = $('#chatEmpty');
  const messages = (S.activeConv && S.activeConv.messages) || [];
  if (!messages.length) {
    $$('.chat-inner', container).forEach((el) => el.remove());
    $$('.msg.live', container).forEach((el) => el.remove());
    if (empty) empty.classList.remove('hidden');
    updateComposerHint();
    updateRunningUI();
    return;
  }
  if (empty) empty.classList.add('hidden');
  renderChatMessages();
  updateComposerHint();
  updateRunningUI();
}

function renderChatMessages() {
  const container = $('#chatMessages');
  if (!container) return;
  $$('.chat-inner', container).forEach((el) => el.remove());
  $$('.msg.live', container).forEach((el) => el.remove());
  const messages = (S.activeConv && S.activeConv.messages) || [];
  const empty = $('#chatEmpty');
  if (empty) empty.classList.toggle('hidden', messages.length > 0);
  if (!messages.length) return;

  const toolResults = new Map();
  for (const m of messages) {
    if (m.role === 'tool') toolResults.set(m.toolCallId, m);
  }
  const inner = document.createElement('div');
  inner.className = 'chat-inner';
  inner.innerHTML = messages
    .filter((m) => m.role !== 'tool')
    .map((m) => messageHtml(m, toolResults))
    .join('');
  container.appendChild(inner);
  enhanceMarkdown(inner);
  scrollChatToBottom(true);
}

function messageHtml(m, toolResults) {
  if (m.role === 'user') {
    return `
      <div class="msg user" data-message-id="${esc(m.id || '')}">
        <div class="msg-body">
          <div class="msg-meta"><span>你</span><span>·</span><span>${timeHM(m.at)}</span></div>
          <div class="msg-bubble">${esc(m.content || '')}</div>
          <div class="msg-actions">
            <button class="msg-action" data-copy-msg title="复制消息">${icon('copy')} 复制</button>
          </div>
        </div>
      </div>`;
  }
  if (m.role === 'assistant') {
    if (m.error) {
      return `
        <div class="msg assistant error" data-message-id="${esc(m.id || '')}">
          <div class="msg-avatar">A</div>
          <div class="msg-body">
            <div class="msg-meta"><span>AIOA</span><span>·</span><span>${timeHM(m.at)}</span></div>
            <div class="msg-bubble">${icon('alert')} ${esc(m.error)}</div>
            <div class="msg-actions"><button class="msg-action" data-copy-msg>${icon('copy')} 复制</button></div>
          </div>
        </div>`;
    }
    const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    const toolHtml = toolCalls.length
      ? `<div class="tool-stack">${toolCalls.map((tc) => toolCardHtml(tc, toolResults.get(tc.id))).join('')}</div>`
      : '';
    const reasoning = m.reasoning
      ? `<details class="reasoning"><summary>思考过程</summary><div class="reasoning-body">${esc(m.reasoning)}</div></details>`
      : '';
    const content = m.content
      ? `<div class="markdown">${renderMarkdown(m.content)}</div>`
      : (toolCalls.length ? '' : '<div class="markdown muted">（空回复）</div>');
    const aborted = m.aborted ? '<span class="badge amber">已停止</span>' : '';
    return `
      <div class="msg assistant" data-message-id="${esc(m.id || '')}">
        <div class="msg-avatar">A</div>
        <div class="msg-body">
          <div class="msg-meta"><span>AIOA</span><span>·</span><span>${timeHM(m.at)}</span>${aborted}</div>
          ${reasoning}
          ${content}
          ${toolHtml}
          <div class="msg-actions">
            <button class="msg-action" data-copy-msg title="复制回复">${icon('copy')} 复制</button>
          </div>
        </div>
      </div>`;
  }
  return '';
}

function toolSummary(toolCall) {
  let args = {};
  try {
    args = JSON.parse(toolCall.arguments || '{}');
  } catch {
    args = {};
  }
  const pick = args.path || args.pattern || args.command || args.query;
  if (pick) return String(pick);
  const first = Object.keys(args)[0];
  if (first) return `${first}=${String(args[first]).slice(0, 80)}`;
  return toolCall.name || '';
}

function toolCardHtml(toolCall, result, { live = false } = {}) {
  let args = {};
  try {
    args = JSON.parse(toolCall.arguments || '{}');
  } catch {
    args = { _raw: toolCall.arguments || '' };
  }
  const ok = result ? result.ok !== false : null;
  const status = !result ? '执行中' : ok ? '完成' : '失败';
  const statusClass = !result ? '' : ok ? 'ok' : 'err';
  const body = result
    ? `参数\n${JSON.stringify(args, null, 2)}\n\n结果\n${result.content || ''}`
    : `参数\n${JSON.stringify(args, null, 2)}\n\n等待工具返回…`;
  const open = !result || ok === false ? ' open' : '';
  return `
    <div class="tool-card${open}" data-tool-id="${esc(toolCall.id || '')}" data-tool-index="${esc(toolCall.index ?? '')}">
      <div class="tool-head">
        <span class="tool-icon">${icon('tool')}</span>
        <span class="tool-name">${esc(toolCall.name || 'tool')}</span>
        <span class="tool-arg">${esc(toolSummary(toolCall))}</span>
        <span class="tool-status ${statusClass}">${result ? '' : '<span class="spinner"></span>'}${status}</span>
      </div>
      <div class="tool-body"><pre>${esc(body)}</pre></div>
    </div>`;
}

function scrollChatToBottom(force = false) {
  const el = $('#chatMessages');
  if (!el) return;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  if (force || near) el.scrollTop = el.scrollHeight;
}

function ensureChatInner() {
  const container = $('#chatMessages');
  let inner = $('.chat-inner', container);
  if (!inner) {
    inner = document.createElement('div');
    inner.className = 'chat-inner';
    container.appendChild(inner);
  }
  const empty = $('#chatEmpty');
  if (empty) empty.classList.add('hidden');
  return inner;
}

function createLiveCurrent() {
  const inner = ensureChatInner();
  const el = document.createElement('div');
  el.className = 'msg assistant live';
  el.innerHTML = `
    <div class="msg-avatar">A</div>
    <div class="msg-body">
      <div class="msg-meta"><span>AIOA</span><span>·</span><span class="live-status">正在生成</span></div>
      <div class="live-content"></div>
      <div class="live-tools tool-stack"></div>
      <div class="live-typing typing"><i></i><i></i><i></i></div>
    </div>`;
  inner.appendChild(el);
  scrollChatToBottom();
  return {
    messageId: null,
    text: '',
    reasoning: '',
    el,
    contentEl: $('.live-content', el),
    toolsEl: $('.live-tools', el),
    typingEl: $('.live-typing', el),
    reasoningEl: null,
    toolCards: new Map(),
    finished: false,
  };
}

function ensureLiveCurrent() {
  if (!S.live) {
    S.live = { convId: S.activeConvId, runId: '', current: createLiveCurrent() };
  }
  if (!S.live.current) S.live.current = createLiveCurrent();
  return S.live.current;
}

function updateLiveTyping(cur) {
  if (!cur) return;
  if (cur.typingEl) cur.typingEl.style.display = cur.finished ? 'none' : '';
}

function mountLiveReasoning(cur, text) {
  if (!cur.reasoningEl) {
    const details = document.createElement('details');
    details.className = 'reasoning';
    details.innerHTML = '<summary>思考过程</summary><div class="reasoning-body"></div>';
    cur.contentEl.parentNode.insertBefore(details, cur.contentEl);
    cur.reasoningEl = details;
  }
  const body = $('.reasoning-body', cur.reasoningEl);
  body.textContent = text;
}

function scheduleLiveRender(cur) {
  if (!cur._renderPending) {
    cur._renderPending = true;
    chatRenderFrame = requestAnimationFrame(() => {
      cur._renderPending = false;
      mountMarkdown(cur.contentEl, cur.text);
      scrollChatToBottom();
    });
  }
}

async function sendMessage() {
  const input = $('#chatInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (S.activeConv && S.running.has(S.activeConv.id)) return;

  const model = currentModel();
  if (!model) {
    toast('请先配置一个模型服务并选择模型', 'err');
    switchView('settings');
    return;
  }
  const provider = providerById(model.providerId);
  if (!provider) {
    toast('所选模型服务不存在，请重新配置', 'err');
    switchView('settings');
    return;
  }
  if (provider.requiresKey && !provider.keySet) {
    toast(`请先在设置里填写 ${provider.name} 的 API Key`, 'err');
    switchView('settings');
    return;
  }

  try {
    if (!S.activeConv) {
      const conv = await window.api.chat.create({
        model,
        workspace: (S.settings && S.settings.defaultWorkspace) || '',
      });
      S.activeConv = conv;
      S.activeConvId = conv.id;
      S.conversations = await window.api.chat.list();
      await saveSettings({ lastConversationId: conv.id });
    }
    if (!S.activeConv.model) {
      await window.api.chat.update({ id: S.activeConvId, patch: { model } });
      S.activeConv.model = model;
    }
    S.activeConv.messages = Array.isArray(S.activeConv.messages) ? S.activeConv.messages : [];
    S.activeConv.messages.push({
      id: `local_${Date.now()}`, role: 'user', content: text, at: Date.now(),
    });
    input.value = '';
    autoResizeComposer();
    renderChatMessages();
    S.live = { convId: S.activeConvId, runId: '', current: createLiveCurrent() };
    S.running.add(S.activeConvId);
    updateRunningUI();
    renderSidebar();
    renderTopbar();
    scrollChatToBottom(true);
    await window.api.chat.send({ conversationId: S.activeConvId, text });
  } catch (err) {
    if (S.activeConvId) S.running.delete(S.activeConvId);
    updateRunningUI();
    showError(err, '发送失败');
    setTimeout(() => reloadActiveConversation(), 400);
  }
}

async function stopGeneration() {
  if (!S.activeConv) return;
  try {
    const aborted = await window.api.chat.abort(S.activeConv.id);
    toast(aborted ? '正在停止生成…' : '当前没有正在生成的回复', 'info');
  } catch (err) {
    showError(err, '停止失败');
  }
}

async function reloadActiveConversation() {
  const id = S.activeConvId;
  if (!id) return;
  try {
    const conv = await window.api.chat.get(id);
    if (S.activeConvId === id && conv) {
      S.activeConv = conv;
      S.live = null;
      renderChatView();
      renderTopbar();
    }
  } catch {
    /* ignore */
  }
}

async function finishChatRun(ev, { errorMessage = '' } = {}) {
  const convId = ev.conversationId;
  if (!convId) return;
  const key = `${ev.runId || ''}:${convId}`;
  if (S.finishHandled.has(key)) return;
  S.finishHandled.add(key);
  if (S.finishHandled.size > 200) S.finishHandled.clear();
  S.running.delete(convId);
  if (errorMessage) toast(errorMessage, 'err', 5200);
  updateRunningUI();
  await refreshConversations();
  if (S.activeConvId === convId) {
    if (S.live && S.live.current) {
      const cur = S.live.current;
      cur.finished = true;
      updateLiveTyping(cur);
    }
    setTimeout(() => reloadActiveConversation(), 120);
  }
}

function onChatEvent(ev) {
  if (!ev || !ev.type) return;
  if (String(ev.type).startsWith('loop_')) {
    handleLoopEvent(ev);
    return;
  }
  const active = ev.conversationId === S.activeConvId;

  if (ev.type === 'conversation_update' && ev.conversation) {
    const item = ev.conversation;
    const idx = S.conversations.findIndex((c) => c.id === item.id);
    if (idx >= 0) S.conversations[idx] = { ...S.conversations[idx], ...item };
    else S.conversations.unshift(item);
    if (active && S.activeConv) S.activeConv.title = item.title || S.activeConv.title;
    renderSidebar();
    if (active) renderTopbar();
    return;
  }

  if (!active) {
    if (ev.type === 'run_start') {
      S.running.add(ev.conversationId);
      renderSidebar();
    } else if (['done', 'error', 'aborted', 'run_end'].includes(ev.type)) {
      S.running.delete(ev.conversationId);
      renderSidebar();
    }
    return;
  }

  if (ev.type === 'run_start') {
    S.running.add(ev.conversationId);
    if (!S.live) S.live = { convId: ev.conversationId, runId: ev.runId || '', current: createLiveCurrent() };
    else S.live.runId = ev.runId || S.live.runId;
    updateRunningUI();
    return;
  }

  if (ev.type === 'assistant_start') {
    if (!S.live) S.live = { convId: ev.conversationId, runId: ev.runId || '', current: null };
    const cur = S.live.current;
    if (!cur || cur.finished || cur.messageId || cur.text || cur.toolCards.size) {
      S.live.current = createLiveCurrent();
    }
    S.live.current.messageId = ev.messageId || null;
    updateLiveTyping(S.live.current);
    return;
  }

  if (ev.type === 'text') {
    const cur = ensureLiveCurrent();
    cur.text += ev.text || '';
    scheduleLiveRender(cur);
    return;
  }

  if (ev.type === 'reasoning') {
    const cur = ensureLiveCurrent();
    cur.reasoning += ev.text || '';
    mountLiveReasoning(cur, cur.reasoning);
    scrollChatToBottom();
    return;
  }

  if (ev.type === 'tool_call') {
    const cur = ensureLiveCurrent();
    const tc = ev.toolCall;
    if (!tc || !tc.id) return;
    const holder = document.createElement('div');
    holder.innerHTML = toolCardHtml(tc, null, { live: true });
    const card = holder.firstElementChild;
    cur.toolsEl.appendChild(card);
    cur.toolCards.set(tc.id, { tc, card });
    scrollChatToBottom();
    return;
  }

  if (ev.type === 'tool_result') {
    const cur = S.live && S.live.current;
    if (!cur) return;
    const entry = cur.toolCards.get(ev.toolCallId);
    if (entry) {
      const holder = document.createElement('div');
      holder.innerHTML = toolCardHtml(entry.tc, { content: ev.content, ok: ev.ok }, { live: true });
      entry.card.replaceWith(holder.firstElementChild);
      cur.toolCards.set(ev.toolCallId, { tc: entry.tc, card: holder.firstElementChild });
    }
    scrollChatToBottom();
    return;
  }

  if (ev.type === 'assistant_done') {
    const cur = S.live && S.live.current;
    if (cur) {
      cur.finished = true;
      if (ev.messageId) cur.messageId = ev.messageId;
      updateLiveTyping(cur);
    }
    return;
  }

  if (ev.type === 'error') {
    const cur = S.live && S.live.current;
    if (cur) {
      cur.finished = true;
      updateLiveTyping(cur);
    }
    finishChatRun(ev, { errorMessage: ev.message || '模型请求失败' });
    return;
  }

  if (ev.type === 'aborted') {
    toast('已停止生成', 'info');
    finishChatRun(ev);
    return;
  }

  if (ev.type === 'done') {
    finishChatRun(ev);
    return;
  }

  if (ev.type === 'run_end') {
    if (!S.finishHandled.has(`${ev.runId || ''}:${ev.conversationId}`)) {
      S.running.delete(ev.conversationId);
      updateRunningUI();
      if (active) setTimeout(() => reloadActiveConversation(), 300);
    }
  }
}

/* ============================== topbar actions ============================== */
async function selectModelValue(value) {
  const model = parseModelValue(value);
  if (!model) return;
  try {
    if (S.activeConv) {
      await window.api.chat.update({ id: S.activeConv.id, patch: { model } });
      S.activeConv.model = model;
      const item = S.conversations.find((c) => c.id === S.activeConv.id);
      if (item) item.model = model;
    } else {
      await saveSettings({ defaultModel: model });
    }
    renderTopbar();
    toast(`已选择 ${modelLabel(model)}`, 'ok', 1800);
  } catch (err) {
    showError(err, '选择模型失败');
  }
}

async function exportConversation() {
  if (!S.activeConv) return;
  try {
    const file = await window.api.chat.export(S.activeConv.id);
    if (file) toast(`已导出：${file}`, 'ok', 5000);
  } catch (err) {
    showError(err, '导出失败');
  }
}

function openWorkspaceModal() {
  const current = (S.activeConv && S.activeConv.workspace) || (S.settings && S.settings.defaultWorkspace) || '';
  showModal({
    title: '选择工作区',
    subtitle: 'AI 的文件工具只能读写这个目录内的内容',
    body: `
      <div class="settings-row" style="padding-top:0">
        <div class="left">
          <b>当前工作区</b>
          <span class="mono" style="word-break:break-all">${esc(current || '未选择')}</span>
        </div>
      </div>
      <div class="warning-box blue">建议选择你的项目源码目录或项目根目录。工作区之外的路径会被拒绝，即使 AI 尝试访问也不行。</div>
      ${S.activeConv ? '<div class="tiny muted" style="margin-top:9px">修改工作区只影响之后的工具调用；正在生成的本轮不会中途改变。</div>' : ''}
    `,
    footer: `<button class="btn" data-modal-close>取消</button>
             ${current ? '<button class="btn danger" id="clearWorkspaceBtn">清除</button>' : ''}
             <button class="btn primary" id="chooseWorkspaceBtn">${icon('folder')} 选择文件夹</button>`,
    onMount: (root, close) => {
      const apply = async (path) => {
        try {
          if (S.activeConv) {
            await window.api.chat.update({ id: S.activeConv.id, patch: { workspace: path } });
            S.activeConv.workspace = path;
            const item = S.conversations.find((c) => c.id === S.activeConv.id);
            if (item) item.workspace = path;
          } else {
            await saveSettings({ defaultWorkspace: path });
          }
          renderTopbar();
          updateComposerHint();
          toast(path ? `工作区已设为 ${basename(path)}` : '已清除工作区', 'ok');
          close();
        } catch (err) {
          showError(err, '设置工作区失败');
        }
      };
      $('#chooseWorkspaceBtn', root).addEventListener('click', async () => {
        const picked = await window.api.app.chooseDirectory({
          title: '选择 AI 工作区',
          defaultPath: current || undefined,
        });
        if (picked) await apply(picked);
      });
      const clearBtn = $('#clearWorkspaceBtn', root);
      if (clearBtn) clearBtn.addEventListener('click', () => apply(''));
    },
  });
}

function startConversationRename(id) {
  const conv = S.conversations.find((c) => c.id === id)
    || (S.activeConv && S.activeConv.id === id ? S.activeConv : null);
  if (!conv) return;
  const item = Array.from(document.querySelectorAll('.conv-item'))
    .find((el) => el.dataset.convId === id);
  if (!item) return;
  const titleEl = $('.conv-title', item);
  if (!titleEl || $('.conv-title-input', item)) return;
  const input = document.createElement('input');
  input.className = 'conv-title-input';
  input.value = conv.title || '';
  input.maxLength = 120;
  input.spellcheck = false;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const next = input.value.trim().slice(0, 120);
    if (save && next && next !== conv.title) {
      try {
        await window.api.chat.update({ id, patch: { title: next } });
        conv.title = next;
        const listItem = S.conversations.find((c) => c.id === id);
        if (listItem) listItem.title = next;
        if (S.activeConv && S.activeConv.id === id) {
          S.activeConv.title = next;
          renderTopbar();
        }
        toast('对话已重命名', 'ok', 1600);
      } catch (err) {
        showError(err, '重命名失败');
      }
    }
    renderSidebar();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('blur', () => finish(true));
}

function handleLoopEvent(ev) {
  const id = ev.conversationId;
  if (ev.type === 'loop_end') {
    S.loops.delete(id);
    if (id === S.activeConvId) {
      toast(ev.reason === 'error' ? '监听已停止（出现错误）' : '监听已停止', 'info', 2600);
    }
  } else if (ev.loop) {
    S.loops.set(id, ev.loop);
  }
  if (ev.type === 'loop_file' && ev.file) {
    toast(`收到待处理文件：${basename(ev.file)}`, 'info', 3200);
  }
  if (ev.type === 'loop_error' && ev.message) {
    toast(`监听：${ev.message}`, 'err', 5200);
  }
  renderTopbar();
  renderSidebar();
}

function loopStationFolders(num) {
  const stations = S.workflow && Array.isArray(S.workflow.stations) ? S.workflow.stations : [];
  const station = stations.find((s) => s.num === num);
  return station && Array.isArray(station.inboxes) ? station.inboxes : [];
}

function openLoopModal() {
  if (!S.activeConv) {
    toast('请先新建对话并选择模型', 'err');
    return;
  }
  const conv = S.activeConv;
  if (!conv.model && !(S.settings && S.settings.defaultModel)) {
    toast('请先给对话选择一个模型', 'err');
    return;
  }
  const stations = S.workflow && S.workflow.installed && Array.isArray(S.workflow.stations)
    ? S.workflow.stations.filter((s) => Array.isArray(s.inboxes) && s.inboxes.length)
    : [];
  const first = stations[0] || null;
  const workspace = conv.workspace || (S.settings && S.settings.defaultWorkspace) || '';
  const folders = first ? first.inboxes : [];
  showModal({
    title: '循环监听收件箱',
    subtitle: '工作台反复取件；收到文件后自动让 Agent 处理，处理完继续监听。',
    body: `
      <div class="field">
        <label>工位收件箱</label>
        <select class="select" id="loopStation">
          <option value="">自定义目录</option>
          ${stations.map((s) => `<option value="${esc(s.num)}"${first && first.num === s.num ? ' selected' : ''}>${esc(s.label)} · ${s.inboxes.length} 个收件箱</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>监听目录（每行一个）</label>
        <textarea class="textarea" id="loopFolders" rows="5">${esc(folders.join('\n'))}</textarea>
        <div class="hint">必须位于当前对话的工作区内${workspace ? `：<span class="mono">${esc(workspace)}</span>` : '。当前对话没有工作区时，会自动使用工作流根目录。'}</div>
      </div>
      <div class="form-grid">
        <div class="field">
          <label>单次挂起秒数</label>
          <input class="input" id="loopTimeout" type="number" min="5" max="540" value="300">
        </div>
        <div class="field">
          <label>取件方式</label>
          <div class="switch-row" style="padding-top:6px">
            <label class="switch"><input type="checkbox" id="loopUseMcp" checked><span class="slider"></span></label>
            <div class="text"><b>优先使用 MCP</b><span>调用 file-watcher 的 wait_for_files；失败自动切换内置监听</span></div>
          </div>
        </div>
      </div>
      <div class="warning-box blue">监听期间，Agent 每处理一个文件都会在对话里留下记录；点顶部「停止监听」可随时停止。</div>`,
    footer: `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="loopStartBtn">${icon('play')} 开始监听</button>`,
    onMount: (root, close) => {
      const stationSelect = $('#loopStation', root);
      if (stationSelect) {
        stationSelect.addEventListener('change', () => {
          const target = $('#loopFolders', root);
          if (!target) return;
          const list = loopStationFolders(stationSelect.value);
          if (list.length) target.value = list.join('\n');
        });
      }
      $('#loopStartBtn', root).addEventListener('click', async () => {
        const list = String($('#loopFolders', root).value || '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (!list.length) {
          toast('请至少填写一个监听目录', 'err');
          return;
        }
        try {
          const state = await window.api.chat.loopStart({
            conversationId: S.activeConvId,
            folders: list,
            timeoutSeconds: Number($('#loopTimeout', root).value) || 300,
            useMcp: Boolean($('#loopUseMcp', root).checked),
          });
          S.loops.set(S.activeConvId, state);
          try {
            const fresh = await window.api.chat.get(S.activeConvId);
            if (fresh && S.activeConvId === fresh.id) {
              if (S.activeConv) S.activeConv.workspace = fresh.workspace;
            }
          } catch {
            /* ignore */
          }
          close();
          renderTopbar();
          toast('监听已启动。收到文件后 Agent 会自动处理', 'ok', 4000);
        } catch (err) {
          showError(err, '启动监听失败');
        }
      });
    },
  });
}

async function stopLoop() {
  if (!S.activeConv) return;
  try {
    await window.api.chat.loopStop(S.activeConv.id);
    toast('正在停止监听…', 'info', 2200);
  } catch (err) {
    showError(err, '停止监听失败');
  }
}

async function deleteConversationById(id) {
  const conv = S.conversations.find((c) => c.id === id);
  const running = S.running.has(id);
  const ok = await confirmAction({
    title: '删除对话',
    message: `确定删除「${conv ? conv.title : '这个对话'}」？`,
    detail: running ? '这个对话正在生成，删除会先停止生成。' : '对话记录会从本机删除，无法恢复。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    if (running) await window.api.chat.abort(id);
    await window.api.chat.delete(id);
    S.running.delete(id);
    S.conversations = await window.api.chat.list();
    if (S.activeConvId === id) {
      const next = S.conversations[0];
      if (next) await loadConversation(next.id);
      else clearActiveConversation();
    } else {
      renderSidebar();
    }
    toast('对话已删除', 'ok');
  } catch (err) {
    showError(err, '删除失败');
  }
}

/* ============================== chat clicks ============================== */
function onChatMessagesClick(e) {
  const toolHead = e.target.closest('.tool-head');
  if (toolHead) {
    toolHead.closest('.tool-card').classList.toggle('open');
    return;
  }
  const copyBtn = e.target.closest('[data-copy-msg]');
  if (copyBtn) {
    const msg = copyBtn.closest('.msg');
    const md = $('.markdown', msg) || $('.msg-bubble', msg);
    copyText(md ? md.innerText : '', '消息已复制');
  }
}

function autoResizeComposer() {
  const input = $('#chatInput');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

function onComposerKeydown(e) {
  if (e.key !== 'Enter') return;
  if (e.isComposing) return;
  if (e.shiftKey) return;
  e.preventDefault();
  sendMessage();
}
