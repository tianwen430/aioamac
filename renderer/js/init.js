'use strict';

/* ============================== event wiring ============================== */
function onConversationListClick(e) {
  const rename = e.target.closest('[data-rename-conv]');
  if (rename) {
    e.stopPropagation();
    startConversationRename(rename.dataset.renameConv);
    return;
  }
  const del = e.target.closest('[data-delete-conv]');
  if (del) {
    e.stopPropagation();
    deleteConversationById(del.dataset.deleteConv);
    return;
  }
  const item = e.target.closest('[data-conv-id]');
  if (item) loadConversation(item.dataset.convId);
}

function onConversationListDblClick(e) {
  const title = e.target.closest('.conv-title');
  if (!title) return;
  const item = title.closest('[data-conv-id]');
  if (item) startConversationRename(item.dataset.convId);
}

async function onTopbarClick(e) {
  const btn = e.target.closest('[data-top-action]');
  if (!btn) return;
  const action = btn.dataset.topAction;
  if (action === 'new-chat') { await createNewChat(); return; }
  if (action === 'export') { await exportConversation(); return; }
  if (action === 'workspace') { openWorkspaceModal(); return; }
  if (action === 'loop-start') { openLoopModal(); return; }
  if (action === 'loop-stop') { await stopLoop(); return; }
  if (action === 'open-settings-models') { switchView('settings'); return; }
  if (action === 'pause') { await pauseWorkflow(); return; }
  if (action === 'resume') { await resumeWorkflow(); return; }
  if (action === 'refresh-workflow') { await refreshWorkflowState(true); return; }
  if (action === 'open-root') { await openLocalPath(S.workflow && S.workflow.root); return; }
  if (action === 'about') { openAboutModal(); return; }
}

async function onTopbarChange(e) {
  if (e.target.id === 'modelSelect') {
    await selectModelValue(e.target.value);
    return;
  }
  if (e.target.id === 'projectSelect') {
    await switchProject(e.target.value);
    return;
  }
  if (e.target.id === 'permissionSelect') {
    try {
      await saveSettings({ permissions: e.target.value });
      updateComposerHint();
      toast(`文件权限：${PERMISSIONS[e.target.value]}`, 'ok', 1800);
    } catch (err) {
      showError(err, '保存权限失败');
    }
  }
}

function onDocumentClick(e) {
  const link = e.target.closest('a[href]');
  if (link) {
    const href = link.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      window.api.app.openExternal(href).catch(showError);
      return;
    }
  }
  const codeBtn = e.target.closest('[data-code-copy]');
  if (codeBtn) {
    const pre = codeBtn.closest('pre');
    const code = pre && pre.querySelector('code');
    if (code) copyText(code.textContent, '代码已复制');
  }
}

function bindStaticEvents() {
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  $('#newChatBtn').addEventListener('click', createNewChat);
  $('#sendBtn').addEventListener('click', sendMessage);
  $('#stopBtn').addEventListener('click', stopGeneration);
  $('#chatInput').addEventListener('input', autoResizeComposer);
  $('#chatInput').addEventListener('keydown', onComposerKeydown);
  $('#conversationList').addEventListener('click', onConversationListClick);
  $('#conversationList').addEventListener('dblclick', onConversationListDblClick);
  $('#topbar').addEventListener('click', onTopbarClick);
  $('#topbar').addEventListener('change', onTopbarChange);
  $('#workflowContent').addEventListener('click', onWorkflowClick);
  $('#workflowContent').addEventListener('submit', onWorkflowSubmit);
  $('#workflowContent').addEventListener('change', onWorkflowChange);
  $('#workflowContent').addEventListener('input', onWorkflowInput);
  $('#settingsContent').addEventListener('click', onSettingsClick);
  $('#settingsContent').addEventListener('submit', onSettingsSubmit);
  $('#settingsContent').addEventListener('change', onSettingsChange);
  $('#settingsContent').addEventListener('input', onSettingsInput);
  $('#chatMessages').addEventListener('click', onChatMessagesClick);
  $('#aboutLink').addEventListener('click', openAboutModal);

  $$('.suggest-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const input = $('#chatInput');
      if (!input) return;
      input.value = chip.dataset.suggest || '';
      autoResizeComposer();
      input.focus();
    });
  });

  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && String(e.key).toLowerCase() === 'n') {
      e.preventDefault();
      createNewChat();
    }
  });

  window.api.chat.onEvent(onChatEvent);
  window.api.workflow.onProgress((p) => {
    if (!p) return;
    S.installProgress = p.text || '';
    const el = $('#installProgress');
    if (el) el.textContent = S.installProgress;
    const prog = $('#installBtn');
    if (prog) prog.innerHTML = `<span class="spinner"></span> ${esc(p.text || '安装中…')}`;
  });
}

/* ============================== init ============================== */
async function initApp() {
  try {
    applyTheme('light');
    const state = await window.api.app.getState();
    await applyAppState(state);
    renderSidebar();
    renderTopbar();

    const last = S.settings && S.settings.lastConversationId;
    const first = S.conversations && S.conversations[0];
    if (last && S.conversations.some((c) => c.id === last)) {
      await loadConversation(last);
    } else if (first) {
      await loadConversation(first.id);
    } else {
      switchView('chat');
    }
    startRefreshLoop();
  } catch (err) {
    console.error('init failed', err);
    showError(err, '工作台启动失败');
  }
}

window.__AIOA_SMOKE__ = () => ({
  view: S.view,
  providers: Array.isArray(S.providers) ? S.providers.length : 0,
  conversations: Array.isArray(S.conversations) ? S.conversations.length : 0,
  workflowInstalled: Boolean(S.workflow && S.workflow.installed),
  hasSidebar: Boolean($('.sidebar')),
  hasComposer: Boolean($('#chatInput')),
  hasWorkflowView: Boolean($('#view-workflow')),
  text: document.body.innerText.slice(0, 600),
});

window.addEventListener('error', (e) => console.error('window error:', e.message));
window.addEventListener('unhandledrejection', (e) => console.error('unhandled rejection:', e.reason));

document.addEventListener('DOMContentLoaded', () => {
  bindStaticEvents();
  initApp();
});
