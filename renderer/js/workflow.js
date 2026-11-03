'use strict';

/* ============================== workflow rendering ============================== */
function renderWorkflowView() {
  const root = $('#workflowContent');
  if (!root) return;
  const scrollTop = root.scrollTop;
  const w = S.workflow;
  if (!w || !w.installed) {
    renderWorkflowSetup(root);
    return;
  }
  renderWorkflowDashboard(root, w);
  root.scrollTop = scrollTop;
}

function renderWorkflowSetup(root) {
  const w = S.workflow || {};
  const setupRoot = (S.settings && S.settings.workflowRoot) || w.root || S.defaultRoot || 'D:\\ai-workflow';
  root.innerHTML = `
    <div class="setup-card card">
      <span class="badge blue">首次设置</span>
      <h1>搭建你的 AI 协同工作流</h1>
      <p>把 8 个独立 AI 窗口组织成一条文件驱动的流水线：总控 → 实施布置 → 代码/美工 → Debug → 部署。
         工作台负责目录、角色卡、指令复制、需求投递和状态监控；AI 窗口仍由你自行选择模型和客户端。</p>
      <div class="feature-row">
        <div class="feature-mini">${icon('flow')}<b>8 个工位</b><span>目录树、角色卡、心跳、锁、归档</span></div>
        <div class="feature-mini">${icon('copy')}<b>一键指令</b><span>上班 / 下班 / 继续监听 / 角色卡+上班</span></div>
        <div class="feature-mini">${icon('book')}<b>需求与终端</b><span>结构化投递需求，集中查看汇报</span></div>
      </div>
      <div class="warning-box" style="margin-bottom:18px">
        建议使用纯 ASCII、无空格、非同步盘的路径，例如 <b class="mono">D:\\ai-workflow</b>。
        路径中带中文或空格时，部分外部 AI 客户端的 MCP 监听可能出问题。
      </div>
      <form id="setupForm">
        <div class="form-grid">
          <div class="field span-2">
            <label>控制层根目录</label>
            <div class="inline">
              <input class="input" id="setupRoot" name="root" value="${esc(setupRoot)}" placeholder="D:\\ai-workflow" autocomplete="off">
              <button class="btn" type="button" data-wf="setup-browse">${icon('folder')} 选择</button>
            </div>
            <div class="hint">协议、8 张角色卡、tools、MCP 服务和 projects 都会放在这里。</div>
          </div>
          <div class="field">
            <label>首个项目名</label>
            <input class="input" name="project" value="P001_第一个项目" autocomplete="off">
            <div class="hint">会创建 projects\\项目名 下的完整目录树。</div>
          </div>
          <div class="field">
            <label>项目标题（可选）</label>
            <input class="input" name="projectTitle" placeholder="例如：我的第一个产品" autocomplete="off">
          </div>
          <div class="field">
            <label>代码目录 code_root（可选）</label>
            <input class="input" name="codeRoot" placeholder="D:\\my-repo；留空 = none" autocomplete="off">
          </div>
          <div class="field">
            <label>部署目标（可选）</label>
            <input class="input" name="deployTarget" placeholder="例如：Cloudflare Pages；留空 = 待定" autocomplete="off">
          </div>
          <div class="field span-2">
            <label>验收基线文件（可选）</label>
            <input class="input" name="baseline" placeholder="例如：D:\\my-repo\\docs\\开发总纲.md；留空 = none" autocomplete="off">
          </div>
        </div>
        <div class="status-text" id="installProgress" style="margin-top:14px">${esc(S.installProgress || '')}</div>
        <div class="form-actions">
          <button class="btn primary" type="submit" id="installBtn">${icon('play')} 安装并创建项目</button>
          <button class="btn" type="button" data-wf="setup-browse">${icon('folder')} 选择目录</button>
          <span class="tiny muted">已有目录时只补齐缺失文件，不覆盖你改过的角色卡和协议。</span>
        </div>
      </form>
    </div>`;
}

function renderWorkflowDashboard(root, w) {
  const tabs = [
    ['overview', '总览'],
    ['requirement', '投递需求'],
    ['terminal', '汇报终端'],
    ['tools', '项目与工具'],
  ];
  root.innerHTML = `
    <div class="page-inner">
      <div class="workflow-pathline">
        <span class="mono">${esc(w.projectRoot || w.root)}</span>
        <button class="btn tiny" data-wf="refresh">${icon('refresh')} 刷新</button>
      </div>
      ${(w.warnings || []).length ? `<div class="section" style="margin-bottom:14px">${w.warnings.map((text) => `<div class="warning-box" style="margin-bottom:7px">${esc(text)}</div>`).join('')}</div>` : ''}
      <div class="tabs">
        ${tabs.map(([id, label]) => `<button class="tab ${S.workflowTab === id ? 'active' : ''}" data-wf="tab" data-tab="${id}">${label}</button>`).join('')}
      </div>
      <div id="workflowTabContent">
        ${S.workflowTab === 'overview' ? renderWorkflowOverview(w)
          : S.workflowTab === 'requirement' ? renderWorkflowRequirement(w)
            : S.workflowTab === 'terminal' ? renderWorkflowTerminal(w)
              : renderWorkflowTools(w)}
      </div>
    </div>`;
}

function summaryCard(k, v, s, extra = '') {
  return `<div class="card summary-card"><div class="k">${esc(k)}</div><div class="v">${v}${extra}</div><div class="s">${esc(s)}</div></div>`;
}

function renderWorkflowOverview(w) {
  const decisions = w.counts ? w.counts.decisions : 0;
  const blockers = w.counts ? w.counts.blockers : 0;
  const stuck = w.counts ? w.counts.stuck : 0;
  const pendingTotal = (w.stations || []).reduce((n, s) => n + (s.backlog || 0), 0);
  const profileTitle = w.profile && w.profile.title ? w.profile.title : '未填写项目标题';
  return `
    <div class="summary-grid">
      ${summaryCard('活动项目', esc(w.project || '-'), profileTitle)}
      ${summaryCard('全局状态', w.globalStatus === 'PAUSED' ? 'PAUSED' : 'ACTIVE', w.globalStatus === 'PAUSED' ? '工位会在下一轮停下' : '正常轮询')}
      ${summaryCard('当前版本', `v${w.version || 0}`, `${(w.projects || []).length} 个项目`)}
      ${summaryCard('需要关注', String(decisions + blockers), `决策 ${decisions} · 阻塞 ${blockers} · 卡住 ${stuck} · 积压 ${pendingTotal}`)}
    </div>

    <div class="section">
      <div class="section-head">
        <h2>8 个工位</h2>
        <span class="desc">点「角色卡」复制全文，点「上班」复制指令；下班会写入 _OFFDUTY.md</span>
        <div class="actions">
          <button class="btn tiny" data-wf="command" data-command="copy-startup">${icon('copy')} 复制开工清单</button>
        </div>
      </div>
      <div class="station-grid">
        ${(w.stations || []).map(stationCardHtml).join('')}
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <h2>开工顺序</h2>
        <span class="desc">首次开工或窗口重开时，按这个顺序把角色卡贴进窗口</span>
      </div>
      <div class="startup-list">
        ${STATION_ORDER.map((num, idx) => {
          const st = (w.stations || []).find((s) => s.num === num);
          if (!st) return '';
          return `<div class="startup-row">
            <div class="startup-order">${idx + 1}</div>
            <div><div class="startup-name">${esc(st.label)} ${st.num === '08' ? '<span class="badge gray">可选</span>' : ''}</div><div class="startup-desc">${esc(st.short)}</div></div>
            <span class="badge blue">${esc(st.model)}</span>
            <button class="btn tiny" data-wf="station" data-station="${st.num}" data-action="rolecard_start">${icon('copy')} 角色卡+上班</button>
            <button class="btn tiny" data-wf="station" data-station="${st.num}" data-action="rolecard">${icon('book')} 仅角色卡</button>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <h2>快捷指令</h2>
        <span class="desc">复制后到对应的 AI 窗口粘贴</span>
      </div>
      <div class="command-grid">
        ${commandCard('resume', 'refresh', '继续监听', '全局恢复后逐个窗口发送')}
        ${commandCard('restart', 'play', '继续静默循环', '循环断掉时重新进入')}
        ${commandCard('no_question', 'alert', '不要反问', '让 AI 直接按角色卡执行')}
        ${commandCard('path_fix', 'folder', '路径纠正', 'AI 读不到文件时发送')}
        ${commandCard('context_reset', 'clock', '重启前停机', '处理完当前文件再关窗口')}
        ${commandCard('mcp-trust', 'key', 'MCP 信任提示', '复制连接器信任步骤')}
        ${commandCard('self-check', 'check', '运行自检', '检查目录、指针、锁与依赖')}
        ${commandCard('tidy', 'tool', '预览瘦身', '归档已处理文件，不删除')}
      </div>
    </div>`;
}

function stationCardHtml(st) {
  const pending = (st.pending || []).map((f) =>
    `<span class="inbox-chip" title="${esc(f.name)}">${esc(f.name)}</span>`
  ).join('');
  const more = st.pendingTotal > (st.pending || []).length
    ? `<span class="inbox-chip">+${st.pendingTotal - (st.pending || []).length}</span>` : '';
  return `
    <article class="card station-card tone-${badgeTone(st.tone)}">
      <div class="station-top">
        <div style="min-width:0">
          <div class="station-name"><span class="station-num">${esc(st.num)}</span>${esc(st.label.replace(/^\d+\s*/, ''))}</div>
          <div class="station-desc">${esc(st.short)}</div>
        </div>
        <span class="badge ${badgeTone(st.tone)} station-status"><span class="dot"></span>${esc(st.stateLabel)}</span>
      </div>
      <div class="station-meta">
        <span>积压 <b>${st.backlog || 0}</b></span>
        <span>心跳 <b>${esc(st.heartbeatText)}</b></span>
        <span>最后活动 <b>${esc(st.lastActivityText)}</b></span>
        <span>模型 <b>${esc(st.model)}</b></span>
      </div>
      <div class="station-inbox">${pending || '<span class="faint tiny">收件箱为空</span>'}${more}</div>
      <div class="station-actions">
        <button class="btn tiny" data-wf="station" data-station="${st.num}" data-action="rolecard">${icon('book')} 角色卡</button>
        <button class="btn tiny" data-wf="station" data-station="${st.num}" data-action="start">${icon('play')} 上班</button>
        <button class="btn tiny" data-wf="station" data-station="${st.num}" data-action="stop">${icon('pause')} 下班</button>
        <button class="btn tiny" data-wf="station-more" data-station="${st.num}">${icon('more')} 更多</button>
      </div>
    </article>`;
}

function commandCard(id, ic, title, desc) {
  return `<div class="command-card">
    <div class="cmd-icon">${icon(ic)}</div>
    <div><div class="cmd-title">${esc(title)}</div><div class="cmd-desc">${esc(desc)}</div></div>
    <button class="btn tiny" data-wf="command" data-command="${esc(id)}">${icon('copy')} 复制</button>
  </div>`;
}

function renderWorkflowRequirement(w) {
  const d = S.requirementDraft;
  const preview = S.reqPreviewContent
    ? `<div class="field span-2"><label>预览（提交时生成正式 ID）</label><div class="preview-box" id="reqPreview"><pre>${esc(S.reqPreviewContent)}</pre></div></div>`
    : '';
  return `
    <div class="form-card card">
      <div class="card-head">
        <div><h2>投递一个需求</h2><p>生成符合协议的 <span class="mono">[需求]_{ID}.md</span>，直接放进总控收件箱。</p></div>
      </div>
      <div class="warning-box blue" style="margin-bottom:16px">验收标准必须能判定真假。写“体验良好”会被智囊打回，Debug 也无法判定。</div>
      <form id="requirementForm">
        <div class="form-grid">
          <div class="field">
            <label>标题 *</label>
            <input class="input" name="title" value="${esc(d.title)}" placeholder="例如：一键出价按钮" autocomplete="off">
          </div>
          <div class="field">
            <label>优先级</label>
            <select class="select" name="priority">
              ${['P0', 'P1', 'P2'].map((p) => `<option value="${p}"${d.priority === p ? ' selected' : ''}>${p}</option>`).join('')}
            </select>
          </div>
          <div class="field span-2">
            <label>背景</label>
            <textarea class="textarea" name="background" placeholder="现在是什么状态，为什么现在要做。">${esc(d.background)}</textarea>
          </div>
          <div class="field span-2">
            <label>目标 *</label>
            <textarea class="textarea" name="goal" placeholder="一句话说清交付之后什么变了。">${esc(d.goal)}</textarea>
          </div>
          <div class="field span-2">
            <label>范围（必须实现）</label>
            <textarea class="textarea" name="scope" placeholder="逐条列出可判定的要求。">${esc(d.scope)}</textarea>
          </div>
          <div class="field span-2">
            <label>明确不做</label>
            <textarea class="textarea" name="nonGoals" placeholder="防止 AI 顺手扩大范围。">${esc(d.nonGoals)}</textarea>
          </div>
          <div class="field span-2">
            <label>验收标准 *</label>
            <textarea class="textarea" name="acceptance" placeholder="每条都能直接判真假，例如：点击后价格 = 当前价 + 最小加价幅度。">${esc(d.acceptance)}</textarea>
          </div>
          <div class="field span-2">
            <label>约束</label>
            <textarea class="textarea" name="constraints" placeholder="例如：不新增依赖、不改存档格式、预算上限。">${esc(d.constraints)}</textarea>
          </div>
          <div class="field">
            <label>基线（可选）</label>
            <input class="input" name="baseline" value="${esc(d.baseline)}" placeholder="权威依据文件路径" autocomplete="off">
          </div>
          <div class="field">
            <label>代码基线（可选）</label>
            <input class="input" name="codeBaseline" value="${esc(d.codeBaseline)}" placeholder="code_root 与当前版本" autocomplete="off">
          </div>
          ${preview}
        </div>
        <div class="form-actions">
          <button class="btn primary" type="submit">${icon('send')} 生成并投递</button>
          <button class="btn" type="button" data-wf="preview-requirement">${icon('book')} 预览</button>
          <span class="tiny muted">投递后总控窗口会收到文件；你可以继续在汇报终端看进度。</span>
        </div>
      </form>
    </div>`;
}

function terminalTypeIcon(type) {
  if (type === 'decision') return 'alert';
  if (type === 'blocker') return 'alert';
  if (type === 'release') return 'check';
  if (type === 'progress') return 'clock';
  return 'book';
}

function renderWorkflowTerminal(w) {
  const all = w.terminal || [];
  const filters = [
    ['all', '全部'], ['decision', '待决策'], ['blocker', '阻塞'],
    ['progress', '进度'], ['release', '上线'], ['ready', '就绪'],
  ];
  const list = S.terminalFilter === 'all' ? all : all.filter((f) => f.type === S.terminalFilter);
  return `
    <div class="section">
      <div class="section-head">
        <h2>汇报终端</h2>
        <span class="desc">00_人类总控\\汇报终端 · 最近 ${all.length} 个文件</span>
        <div class="actions">
          <button class="btn tiny" data-wf="open-terminal">${icon('folder')} 打开文件夹</button>
          <button class="btn tiny" data-wf="refresh">${icon('refresh')} 刷新</button>
        </div>
      </div>
      <div class="terminal-toolbar">
        ${filters.map(([id, label]) => `<button class="filter-chip ${S.terminalFilter === id ? 'active' : ''}" data-wf="terminal-filter" data-filter="${id}">${label}</button>`).join('')}
      </div>
      <div class="terminal-list">
        ${list.length ? list.map((f, idx) => {
          const index = all.indexOf(f);
          return `<div class="terminal-item" data-wf="terminal" data-index="${index}">
            <div class="terminal-icon ${f.type}">${icon(terminalTypeIcon(f.type))}</div>
            <div style="min-width:0;flex:1"><div class="terminal-name">${esc(f.name)}</div><div class="terminal-sub">${f.type === 'decision' ? '需要你拍板' : f.type === 'blocker' ? '部署或流程阻塞' : f.type === 'release' ? '部署成功' : f.type === 'progress' ? '进度播报' : f.type === 'ready' ? '工位就绪' : '记录'}</div></div>
            <span class="badge ${f.type === 'decision' ? 'amber' : f.type === 'blocker' ? 'red' : f.type === 'release' ? 'green' : 'blue'}">${esc(f.label)}</span>
            <span class="terminal-time">${esc(f.timeText)}</span>
          </div>`;
        }).join('') : '<div class="empty-mini">这个分类下还没有文件</div>'}
      </div>
    </div>`;
}

function renderWorkflowTools(w) {
  const profile = w.profile || {};
  const py = w.python || {};
  return `
    <div class="tool-grid">
      <div class="card tool-panel" style="grid-column:1/-1">
        <div class="card-head">
          <div><h3>活动项目档案</h3><p>对应项目根目录下的 _PROJECT.md。员工启动时会读取它。</p></div>
          <div class="actions"><button class="btn tiny" data-wf="open-root">${icon('folder')} 打开项目根</button></div>
        </div>
        <form id="profileForm">
          <div class="form-grid">
            <div class="field"><label>项目标题</label><input class="input" name="title" value="${esc(profile.title || '')}" autocomplete="off"></div>
            <div class="field"><label>code_root 代码目录</label><input class="input" name="codeRoot" value="${esc(profile.code_root || '')}" placeholder="none 或绝对路径" autocomplete="off"></div>
            <div class="field"><label>deploy_target 部署目标</label><input class="input" name="deployTarget" value="${esc(profile.deploy_target || '')}" placeholder="待定" autocomplete="off"></div>
            <div class="field"><label>baseline 验收基线</label><input class="input" name="baseline" value="${esc(profile.baseline || '')}" placeholder="none" autocomplete="off"></div>
          </div>
          <div class="form-actions"><button class="btn primary" type="submit">${icon('check')} 保存项目档案</button></div>
        </form>
      </div>

      <div class="card tool-panel">
        <h3>项目</h3>
        <p>切换活动项目会改写 _ACTIVE_PROJECT.md，所有窗口下一轮自动跟过去。</p>
        <div class="startup-list">
          ${(w.projects || []).map((p, idx) => `
            <div class="startup-row">
              <div class="startup-order">${p.active ? icon('check', 'icon') : idx + 1}</div>
              <div><div class="startup-name">${esc(p.name)} ${p.active ? '<span class="badge green">当前</span>' : ''}</div><div class="startup-desc">${esc(p.title || '未填写标题')}</div></div>
              ${p.active ? '' : `<button class="btn tiny" data-wf="switch-project" data-index="${idx}">切换</button>`}
            </div>`).join('')}
        </div>
        <div class="form-actions"><button class="btn" data-wf="new-project">${icon('plus')} 新建项目</button></div>
      </div>

      <div class="card tool-panel">
        <h3>维护</h3>
        <p>这些操作只处理归档和台账，不删除任何任务文件。</p>
        <div class="btn-row">
          <button class="btn small" data-wf="self-check">${icon('check')} 运行自检</button>
          <button class="btn small" data-wf="clear-locks">${icon('key')} 清理残留锁</button>
          <button class="btn small" data-wf="tidy">${icon('tool')} 预览瘦身</button>
          <button class="btn small" data-wf="repair">${icon('refresh')} 补齐缺失文件</button>
        </div>
        <div class="divider"></div>
        <div class="profile-kv">
          <div class="k">Python</div><div class="v">${py.found ? `${esc(py.version)} · ${py.hasDeps ? 'mcp/watchdog 已装' : '缺 mcp/watchdog'}` : '未检测到'}</div>
          <div class="k">MCP 配置</div><div class="v mono">${esc(w.mcpConfigPath || '')}</div>
          <div class="k">工作流根</div><div class="v mono">${esc(w.root || '')}</div>
        </div>
        <div class="form-actions">
          <button class="btn tiny" data-wf="python">${icon('key')} 查看 Python 命令</button>
          <button class="btn tiny" data-wf="mcp">${icon('tool')} 查看 MCP 配置</button>
        </div>
      </div>

      <div class="card tool-panel">
        <h3>文档与模板</h3>
        <p>安装时已复制到工作流根目录，可随时查阅。</p>
        <div class="btn-row">
          <button class="btn small" data-wf="docs">${icon('book')} 使用手册</button>
          <button class="btn small" data-wf="templates">${icon('copy')} 消息模板库</button>
          <button class="btn small" data-wf="open-protocol">${icon('book')} 打开协议总纲</button>
        </div>
        <div class="divider"></div>
        <div class="tiny muted">角色卡里提到的 file-watcher MCP 需要在外部 AI 客户端里点「信任」才会生效。工作台本身不需要它也能运行。</div>
      </div>
    </div>`;
}

/* ============================== workflow actions ============================== */
async function refreshWorkflowState(showToast = false) {
  try {
    S.workflow = await window.api.workflow.getState();
    updateWorkflowAlert();
    renderTopbar();
    if (S.view === 'workflow') renderWorkflowView();
    if (showToast) toast('已刷新', 'ok', 1400);
  } catch (err) {
    showError(err, '刷新工作流失败');
  }
}

async function runInstall(form) {
  if (S.workflowBusy) return;
  const data = new FormData(form);
  const root = String(data.get('root') || '').trim();
  if (!root) {
    toast('请填写控制层根目录', 'err');
    return;
  }
  S.workflowBusy = true;
  S.installProgress = '正在准备安装…';
  const progress = $('#installProgress');
  const btn = $('#installBtn');
  if (progress) progress.textContent = S.installProgress;
  if (btn) { btn.disabled = true; btn.innerHTML = `${icon('refresh')} 安装中…`; }
  try {
    const result = await window.api.workflow.install({
      root,
      project: String(data.get('project') || 'P001_第一个项目').trim(),
      projectTitle: String(data.get('projectTitle') || '').trim(),
      codeRoot: String(data.get('codeRoot') || '').trim(),
      deployTarget: String(data.get('deployTarget') || '').trim(),
      baseline: String(data.get('baseline') || '').trim(),
    });
    S.workflow = result;
    S.settings.workflowRoot = result.root;
    if (!S.settings.defaultWorkspace && result.projectRoot) S.settings.defaultWorkspace = result.projectRoot;
    try {
      S.mcpServers = await window.api.mcp.list();
    } catch {
      /* 老版本主进程没有 MCP 时忽略 */
    }
    S.workflowTab = 'overview';
    S.workflowBusy = false;
    updateWorkflowAlert();
    renderTopbar();
    renderWorkflowView();
    showInstallComplete(result.installResult || result);
  } catch (err) {
    S.workflowBusy = false;
    if (progress) progress.textContent = `安装失败：${err.message || err}`;
    if (btn) { btn.disabled = false; btn.innerHTML = `${icon('play')} 安装并创建项目`; }
    showError(err, '安装失败');
  }
}

function showInstallComplete(result) {
  const root = (result && result.root) || (S.workflow && S.workflow.root) || '';
  const py = (result && result.python) || (S.workflow && S.workflow.python) || {};
  showModal({
    title: '工作流已就绪',
    subtitle: root,
    body: `
      <div class="check-list">
        <div class="check-row ok">${icon('check')}<div><b>目录树与角色卡已创建</b><div class="check-detail">8 个工位 + 汇报终端 + tools + MCP 配置</div></div></div>
        <div class="check-row ${py.hasDeps ? 'ok' : 'bad'}">${icon(py.hasDeps ? 'check' : 'alert')}<div><b>${py.hasDeps ? 'Python MCP 依赖已安装' : 'Python MCP 依赖未就绪'}</b><div class="check-detail">${py.hasDeps ? 'file-watcher 可以启动' : '外部窗口需要运行：python -m pip install mcp watchdog（工作台内置监听不需要）'}</div></div></div>
      </div>
      <div class="divider"></div>
      <div class="settings-row" style="padding-top:0">
        <div class="left"><b>下一步</b><span><b>方式 A（推荐）</b>：新建对话 → 顶部「监听」→ 选工位收件箱，工作台自己跑循环并处理文件。<br><b>方式 B</b>：打开外部 AI 客户端，对 file-watcher 点「信任」，按顺序贴 8 张角色卡各发「上班」。<br>无论哪种方式，都从「投递需求」把第一个需求丢进总控收件箱。</span></div>
      </div>
      <div class="warning-box blue">工作台内置 MCP 客户端与循环监听；外部 AI 窗口只是可选方案，不是必需。</div>`,
    footer: `<button class="btn" data-modal-close>稍后</button>
             <button class="btn" id="installOpenRoot">${icon('folder')} 打开根目录</button>
             <button class="btn primary" id="installCopyMcp">${icon('copy')} 复制 MCP 信任提示</button>`,
    onMount: (rootEl) => {
      $('#installOpenRoot', rootEl).addEventListener('click', () => openLocalPath(root));
      $('#installCopyMcp', rootEl).addEventListener('click', () => copyText(
        `打开 WorkBuddy → 连接器管理 → 自定义连接器 → 对 file-watcher 点「信任」。\nMCP 配置：${root}\\_mcp_config.json\n如果缺依赖，运行：${py.executable || 'python'} -m pip install mcp watchdog`,
        'MCP 提示已复制'
      ));
    },
  });
}

async function openLocalPath(target) {
  if (!target) return;
  try {
    await window.api.app.openPath(target);
  } catch (err) {
    showError(err, '打开路径失败');
  }
}

async function performStationAction(stationNum, action) {
  try {
    const result = await window.api.workflow.stationAction({ station: stationNum, action });
    if (result.path) {
      await openLocalPath(result.path);
      return;
    }
    if (result.text) {
      await copyText(result.text, '角色卡已复制，请粘贴到对应 AI 窗口');
      return;
    }
    if (result.command) {
      await copyText(result.command, result.note || '指令已复制，请粘贴到对应 AI 窗口');
      if (action === 'start' || action === 'stop') await refreshWorkflowState();
      return;
    }
    toast('操作完成', 'ok');
  } catch (err) {
    showError(err, '工位操作失败');
  }
}

function openStationMore(stationNum) {
  const st = (S.workflow.stations || []).find((s) => s.num === stationNum);
  if (!st) return;
  const actionBtn = (action, ic, label, desc) =>
    `<button class="btn" style="justify-content:flex-start;height:auto;padding:9px 11px" data-station-action="${action}">
       ${icon(ic)}<span style="text-align:left"><b style="display:block;font-size:12px">${label}</b><span class="tiny muted">${desc}</span></span>
     </button>`;
  showModal({
    title: `${st.label} · 更多操作`,
    subtitle: '所有指令复制后，需要到对应的外部 AI 窗口粘贴。',
    body: `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${actionBtn('rolecard_start', 'copy', '角色卡 + 上班', '首次开窗口或重开时用')}
        ${actionBtn('rolecard', 'book', '仅复制角色卡', '只更新角色卡内容')}
        ${actionBtn('start', 'play', '上班', '移除 _OFFDUTY.md 并复制指令')}
        ${actionBtn('stop', 'pause', '下班', '写入 _OFFDUTY.md 并复制停止指令')}
        ${actionBtn('resume', 'refresh', '继续监听', '全局恢复后使用')}
        ${actionBtn('restart', 'play', '继续静默循环', '循环断掉时使用')}
        ${actionBtn('no_question', 'alert', '不要反问', '让 AI 直接执行角色卡')}
        ${actionBtn('path_fix', 'folder', '路径纠正', '读不到文件时使用')}
        ${actionBtn('context_reset', 'clock', '重启前停机', '处理完当前文件再关窗口')}
        ${actionBtn('open', 'external', '打开工位文件夹', '在资源管理器中查看')}
        ${actionBtn('open_role', 'external', '打开角色卡文件', '用默认编辑器打开')}
      </div>`,
    wide: true,
    footer: '<button class="btn" data-modal-close>关闭</button>',
    onMount: (root, close) => {
      root.querySelectorAll('[data-station-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const action = btn.dataset.stationAction;
          await performStationAction(stationNum, action);
          if (!['open', 'open_role'].includes(action)) close();
          else close();
        });
      });
    },
  });
}

function startupChecklistText() {
  const w = S.workflow;
  if (!w) return '';
  const lines = [
    `AIOA 协同工作流 · 首次开工清单`,
    `控制层：${w.root}`,
    `项目：${w.project}（${w.projectRoot}）`,
    '',
    '顺序：01 → 02 → 04/05 → 03/06/08 → 07',
    '',
  ];
  const order = ['01', '02', '04', '05', '03', '06', '07', '08'];
  order.forEach((num, i) => {
    const st = (w.stations || []).find((s) => s.num === num);
    if (!st) return;
    lines.push(`${i + 1}. ${st.label}：${w.root}\\${st.card}`);
    lines.push('   把角色卡全文贴进新对话，然后发：上班。');
    lines.push('');
  });
  lines.push('MCP：打开外部 AI 客户端 → 连接器管理 → 自定义连接器 → 对 file-watcher 点「信任」。');
  lines.push(`MCP 配置：${w.mcpConfigPath || `${w.root}\\_mcp_config.json`}`);
  return lines.join('\n');
}

async function performWorkflowCommand(id) {
  const w = S.workflow;
  if (!w) return;
  const root = w.root || '';
  const projectRoot = w.projectRoot || '';
  let text = '';
  if (id === 'resume') {
    text = `继续监听。先读 ${root}\\_ACTIVE_PROJECT.md 与 ${projectRoot}\\01_总控\\发件箱\\_GLOBAL_STATUS.md，然后按协议第 4 节静默循环执行。`;
  } else if (id === 'restart') {
    text = `继续静默循环。从读 ${root}\\_ACTIVE_PROJECT.md 开始，按协议第 4 节走。不要输出文字。`;
  } else if (id === 'no_question') {
    text = '不要问，按角色卡执行。第一件事是启动自检，然后进入静默循环。除总控外你不得输出任何文字，你的回复只能是工具调用。';
  } else if (id === 'path_fix') {
    text = `你的工作目录是 ${root}。先读 ${root}\\00_协议总纲.md 和 ${root}\\<你的角色卡>.md，再执行启动自检。不要猜路径。`;
  } else if (id === 'context_reset') {
    text = '处理完当前文件后停下，不要取新件。我会关掉这个窗口重开。';
  } else if (id === 'mcp-trust') {
    text = `打开 WorkBuddy → 连接器管理 → 自定义连接器 → 对 file-watcher 点「信任」。\nMCP 配置：${w.mcpConfigPath || `${root}\\_mcp_config.json`}`;
  } else if (id === 'copy-startup') {
    text = startupChecklistText();
  } else if (id === 'open-terminal') {
    await openLocalPath(`${projectRoot}\\00_人类总控\\汇报终端`);
    return;
  } else if (id === 'open-protocol') {
    await openLocalPath(`${root}\\00_协议总纲.md`);
    return;
  } else if (id === 'open-root') {
    await openLocalPath(root);
    return;
  } else if (id === 'self-check') {
    await openSelfCheckModal();
    return;
  } else if (id === 'tidy') {
    await openTidyModal();
    return;
  } else if (id === 'clear-locks') {
    await runClearLocks();
    return;
  } else if (id === 'mcp') {
    await openMcpModal();
    return;
  } else if (id === 'python') {
    await openPythonModal();
    return;
  } else if (id === 'docs') {
    await openDocsModal();
    return;
  } else if (id === 'templates') {
    await openTemplatesModal();
    return;
  } else if (id === 'repair') {
    await repairInstall();
    return;
  } else if (id === 'new-project') {
    openNewProjectModal();
    return;
  }
  if (text) await copyText(text, '指令已复制，请粘贴到对应窗口');
}

async function onWorkflowClick(e) {
  const tab = e.target.closest('[data-wf="tab"]');
  if (tab) {
    S.workflowTab = tab.dataset.tab;
    S.reqPreviewContent = '';
    renderWorkflowView();
    const root = $('#workflowContent');
    if (root) root.scrollTop = 0;
    return;
  }
  const browse = e.target.closest('[data-wf="setup-browse"]');
  if (browse) {
    const picked = await window.api.app.chooseDirectory({ title: '选择工作流控制层根目录' }).catch(() => '');
    if (picked) {
      const input = $('#setupRoot');
      if (input) input.value = picked;
    }
    return;
  }
  const stationBtn = e.target.closest('[data-wf="station"]');
  if (stationBtn) {
    await performStationAction(stationBtn.dataset.station, stationBtn.dataset.action);
    return;
  }
  const more = e.target.closest('[data-wf="station-more"]');
  if (more) {
    openStationMore(more.dataset.station);
    return;
  }
  const command = e.target.closest('[data-wf="command"]');
  if (command) {
    await performWorkflowCommand(command.dataset.command);
    return;
  }
  const filter = e.target.closest('[data-wf="terminal-filter"]');
  if (filter) {
    S.terminalFilter = filter.dataset.filter;
    renderWorkflowView();
    return;
  }
  const terminal = e.target.closest('[data-wf="terminal"]');
  if (terminal) {
    const idx = Number(terminal.dataset.index);
    const item = (S.workflow.terminal || [])[idx];
    if (item) await openTerminalModal(item);
    return;
  }
  const simple = e.target.closest('[data-wf]');
  if (!simple) return;
  const action = simple.dataset.wf;
  if (action === 'refresh') { await refreshWorkflowState(true); return; }
  if (action === 'open-root') { await openLocalPath(S.workflow.root); return; }
  if (action === 'open-terminal') { await openLocalPath(`${S.workflow.projectRoot}\\00_人类总控\\汇报终端`); return; }
  if (action === 'pause') { await pauseWorkflow(); return; }
  if (action === 'resume') { await resumeWorkflow(); return; }
  if (action === 'preview-requirement') { await previewRequirement(); return; }
  if (action === 'new-project') { openNewProjectModal(); return; }
  if (action === 'switch-project') {
    const p = (S.workflow.projects || [])[Number(simple.dataset.index)];
    if (p) await switchProject(p.name);
    return;
  }
  if (action === 'self-check') { await openSelfCheckModal(); return; }
  if (action === 'clear-locks') { await runClearLocks(); return; }
  if (action === 'tidy') { await openTidyModal(); return; }
  if (action === 'mcp') { await openMcpModal(); return; }
  if (action === 'python') { await openPythonModal(); return; }
  if (action === 'docs') { await openDocsModal(); return; }
  if (action === 'templates') { await openTemplatesModal(); return; }
  if (action === 'repair') { await repairInstall(); return; }
  if (action === 'open-protocol') { await openLocalPath(`${S.workflow.root}\\00_协议总纲.md`); return; }
}

async function onWorkflowSubmit(e) {
  const form = e.target;
  if (form.id === 'setupForm') {
    e.preventDefault();
    await runInstall(form);
    return;
  }
  if (form.id === 'requirementForm') {
    e.preventDefault();
    await submitRequirement(form);
    return;
  }
  if (form.id === 'profileForm') {
    e.preventDefault();
    await saveProfile(form);
  }
}

function onWorkflowChange(e) {
  if (e.target.id === 'projectSelect') {
    switchProject(e.target.value);
  }
}

function onWorkflowInput(e) {
  if (e.target.closest('#requirementForm')) {
    const name = e.target.name;
    if (name && Object.prototype.hasOwnProperty.call(S.requirementDraft, name)) {
      S.requirementDraft[name] = e.target.value;
    }
  }
}

function formDataObject(form) {
  const out = {};
  new FormData(form).forEach((value, key) => { out[key] = String(value); });
  return out;
}

async function previewRequirement() {
  const form = $('#requirementForm');
  if (!form) return;
  try {
    const result = await window.api.workflow.previewRequirement(formDataObject(form));
    S.reqPreviewContent = result.content;
    const box = $('#reqPreview');
    if (box) {
      box.classList.remove('hidden');
      box.innerHTML = `<pre>${esc(result.content)}</pre>`;
    } else {
      renderWorkflowView();
    }
    toast('预览已生成', 'ok', 1400);
  } catch (err) {
    showError(err, '生成预览失败');
  }
}

async function submitRequirement(form) {
  const data = formDataObject(form);
  if (!data.title.trim()) { toast('请填写需求标题', 'err'); return; }
  if (!data.goal.trim()) { toast('请填写目标', 'err'); return; }
  if (!data.acceptance.trim()) { toast('请填写可判定的验收标准', 'err'); return; }
  try {
    const result = await window.api.workflow.createRequirement(data);
    S.reqPreviewContent = '';
    S.requirementDraft = {
      title: '', priority: 'P1', baseline: '', codeBaseline: '',
      background: '', goal: '', scope: '', nonGoals: '', acceptance: '', constraints: '',
    };
    await refreshWorkflowState();
    showModal({
      title: '需求已投递',
      subtitle: result.name,
      body: `<div class="profile-kv"><div class="k">文件</div><div class="v mono">${esc(result.path)}</div></div>
             <div class="divider"></div>
             <div class="markdown" id="reqResultMd">${renderMarkdown(result.content)}</div>`,
      wide: true,
      footer: `<button class="btn" data-modal-close>关闭</button>
               <button class="btn" id="copyReqPath">${icon('copy')} 复制路径</button>
               <button class="btn primary" id="openReqFolder">${icon('folder')} 打开收件箱</button>`,
      onMount: (root) => {
        $('#copyReqPath', root).addEventListener('click', () => copyText(result.path, '路径已复制'));
        $('#openReqFolder', root).addEventListener('click', () => openLocalPath(result.path.replace(/[\\/][^\\/]+$/, '')));
        enhanceMarkdown($('#reqResultMd', root));
      },
    });
  } catch (err) {
    showError(err, '投递需求失败');
  }
}

async function saveProfile(form) {
  const data = formDataObject(form);
  try {
    await window.api.workflow.saveProfile({
      title: data.title,
      codeRoot: data.codeRoot,
      deployTarget: data.deployTarget,
      baseline: data.baseline,
    });
    toast('项目档案已保存', 'ok');
    await refreshWorkflowState();
  } catch (err) {
    showError(err, '保存项目档案失败');
  }
}

async function pauseWorkflow() {
  try {
    S.workflow = await window.api.workflow.pause();
    updateWorkflowAlert();
    renderTopbar();
    renderWorkflowView();
    toast('已暂停全部工位。正在处理的文件会做完，下一轮停下。', 'ok', 4500);
  } catch (err) {
    showError(err, '暂停失败');
  }
}

async function resumeWorkflow() {
  try {
    S.workflow = await window.api.workflow.resume();
    updateWorkflowAlert();
    renderTopbar();
    renderWorkflowView();
    toast('已恢复全局状态。还需要逐个窗口发送「继续监听」。', 'ok', 5000);
  } catch (err) {
    showError(err, '恢复失败');
  }
}

async function switchProject(name) {
  try {
    S.workflow = await window.api.workflow.switchProject(name);
    updateWorkflowAlert();
    renderWorkflowView();
    toast(`已切换到 ${name}`, 'ok');
  } catch (err) {
    showError(err, '切换项目失败');
  }
}

/* ============================== terminal ============================== */
async function openTerminalModal(item) {
  try {
    const file = await window.api.workflow.readTerminal(item.name);
    const decisionBox = item.type === 'decision'
      ? `<div class="divider"></div>
         <div class="field"><label>人类裁决</label><textarea class="textarea" id="decisionInput" placeholder="例如：A. 每日 3 次"></textarea><div class="hint">追加到文件末尾，总控下一轮会读到。</div></div>`
      : '';
    showModal({
      title: item.name,
      subtitle: `${item.timeText} · ${item.size} 字节`,
      wide: true,
      body: `<div class="markdown" id="terminalMd">${renderMarkdown(file.content)}</div>${decisionBox}`,
      footer: `<button class="btn" data-modal-close>关闭</button>
               <button class="btn" id="terminalCopyPath">${icon('copy')} 复制路径</button>
               <button class="btn" id="terminalOpenFolder">${icon('folder')} 打开文件夹</button>
               ${item.type === 'decision' ? '<button class="btn primary" id="appendDecisionBtn">追加裁决</button>' : ''}`,
      onMount: (root, close) => {
        enhanceMarkdown($('#terminalMd', root));
        $('#terminalCopyPath', root).addEventListener('click', () => copyText(file.path, '路径已复制'));
        $('#terminalOpenFolder', root).addEventListener('click', () => openLocalPath(`${S.workflow.projectRoot}\\00_人类总控\\汇报终端`));
        const append = $('#appendDecisionBtn', root);
        if (append) {
          append.addEventListener('click', async () => {
            const text = $('#decisionInput', root).value.trim();
            if (!text) { toast('请填写裁决内容', 'err'); return; }
            try {
              await window.api.workflow.appendDecision({ name: item.name, decision: text });
              toast('裁决已追加，总控下一轮会读到', 'ok');
              close();
              await refreshWorkflowState();
            } catch (err) {
              showError(err, '追加裁决失败');
            }
          });
        }
      },
    });
  } catch (err) {
    showError(err, '读取汇报文件失败');
  }
}

/* ============================== maintenance ============================== */
async function openSelfCheckModal() {
  try {
    const result = await window.api.workflow.selfCheck();
    const rows = result.items.map((it) => `
      <div class="check-row ${it.ok ? 'ok' : 'bad'}">
        ${icon(it.ok ? 'check' : 'alert')}
        <div><b>${esc(it.label)}</b><div class="check-detail">${esc(it.detail || '')}</div></div>
      </div>`).join('');
    showModal({
      title: '工作流自检',
      subtitle: `${result.passed} 通过 / ${result.failed} 失败`,
      body: `<div class="check-list">${rows}</div>`,
      wide: true,
      footer: `<button class="btn" data-modal-close>关闭</button>
               <button class="btn primary" id="selfCheckRefresh">${icon('refresh')} 再跑一次</button>`,
      onMount: (root, close) => {
        $('#selfCheckRefresh', root).addEventListener('click', async () => { close(); await openSelfCheckModal(); });
      },
    });
  } catch (err) {
    showError(err, '自检失败');
  }
}

async function openTidyModal() {
  try {
    const preview = await window.api.workflow.tidy({ apply: false });
    if (!preview.count) {
      toast('没有需要归档的内容', 'ok');
      return;
    }
    const list = preview.items.slice(0, 80).map((it) => `<div class="check-row ok">${icon('check')}<div>${esc(it.label)}</div></div>`).join('');
    showModal({
      title: '瘦身预览',
      subtitle: `共 ${preview.count} 项 · 不删除任何文件`,
      body: `<div class="check-list" style="max-height:48vh;overflow:auto">${list}</div>`,
      wide: true,
      footer: `<button class="btn" data-modal-close>取消</button>
               <button class="btn primary" id="applyTidy">${icon('check')} 执行归档</button>`,
      onMount: (root, close) => {
        $('#applyTidy', root).addEventListener('click', async () => {
          try {
            await window.api.workflow.tidy({ apply: true });
            toast('瘦身完成', 'ok');
            close();
            await refreshWorkflowState();
          } catch (err) {
            showError(err, '瘦身失败');
          }
        });
      },
    });
  } catch (err) {
    showError(err, '瘦身预览失败');
  }
}

async function runClearLocks() {
  try {
    const preview = await window.api.workflow.clearLocks({ apply: false });
    if (!preview.count) {
      toast('没有残留锁', 'ok');
      return;
    }
    const ok = await confirmAction({
      title: '清理残留锁',
      message: `发现 ${preview.count} 个锁文件`,
      detail: `${preview.files.join('\n')}\n\n确认没有窗口正在处理同一工位后再清理。锁会在 15 分钟后自动失效。`,
      confirmText: '清理',
      danger: true,
    });
    if (!ok) return;
    await window.api.workflow.clearLocks({ apply: true });
    toast(`已清理 ${preview.count} 个锁`, 'ok');
    await refreshWorkflowState();
  } catch (err) {
    showError(err, '清理锁失败');
  }
}

async function openMcpModal() {
  try {
    const mcp = await window.api.workflow.getMcp();
    if (!mcp) { toast('还没有生成 MCP 配置', 'err'); return; }
    showModal({
      title: 'MCP 配置',
      subtitle: mcp.path,
      body: `<div class="preview-box"><pre>${esc(mcp.content)}</pre></div>
             <div class="warning-box blue" style="margin-top:12px">把这个 file-watcher 条目合并进你的 AI 客户端 MCP 配置，然后在连接器管理里点「信任」。不点信任，外部窗口会一直返回 NO_FILE。</div>`,
      wide: true,
      footer: `<button class="btn" data-modal-close>关闭</button>
               <button class="btn" id="mcpCopyPath">${icon('copy')} 复制路径</button>
               <button class="btn" id="mcpCopyContent">${icon('copy')} 复制配置</button>
               <button class="btn primary" id="mcpOpen">${icon('folder')} 打开文件</button>`,
      onMount: (root) => {
        $('#mcpCopyPath', root).addEventListener('click', () => copyText(mcp.path, '路径已复制'));
        $('#mcpCopyContent', root).addEventListener('click', () => copyText(mcp.content, 'MCP 配置已复制'));
        $('#mcpOpen', root).addEventListener('click', () => openLocalPath(mcp.path));
      },
    });
  } catch (err) {
    showError(err, '读取 MCP 配置失败');
  }
}

async function openPythonModal() {
  try {
    const py = await window.api.workflow.pythonCommand();
    showModal({
      title: 'Python 与 MCP 依赖',
      subtitle: py.found ? `${py.version} · ${py.executable}` : '未检测到 Python',
      body: `
        <div class="check-list">
          <div class="check-row ${py.found ? 'ok' : 'bad'}">${icon(py.found ? 'check' : 'alert')}<div><b>Python</b><div class="check-detail">${py.found ? esc(py.executable) : '需要 Python 3.10+，并加入 PATH'}</div></div></div>
          <div class="check-row ${py.hasDeps ? 'ok' : 'bad'}">${icon(py.hasDeps ? 'check' : 'alert')}<div><b>mcp / watchdog</b><div class="check-detail">${py.hasDeps ? '已安装' : '未安装'}</div></div></div>
        </div>
        <div class="divider"></div>
        <div class="field"><label>安装命令</label><div class="preview-box"><pre>${esc(py.installHint)}</pre></div></div>`,
      footer: `<button class="btn" data-modal-close>关闭</button>
               <button class="btn primary" id="copyPyCmd">${icon('copy')} 复制命令</button>`,
      onMount: (root) => {
        $('#copyPyCmd', root).addEventListener('click', () => copyText(py.installHint, '命令已复制'));
      },
    });
  } catch (err) {
    showError(err, '检查 Python 失败');
  }
}

async function openTemplatesModal() {
  try {
    const sections = await window.api.workflow.getTemplates();
    if (!sections.length) { toast('没有找到消息模板', 'err'); return; }
    const body = `<div class="terminal-list">${sections.map((s, i) => `
      <div class="terminal-item" style="cursor:default">
        <div class="terminal-icon progress">${icon('book')}</div>
        <div style="min-width:0;flex:1"><div class="terminal-name">${esc(s.title)}</div><div class="terminal-sub">${esc(s.content.split(/\n/)[2] || '消息模板')}</div></div>
        <button class="btn tiny" data-template-full="${i}">复制全文</button>
        <button class="btn tiny" data-template-skeleton="${i}">复制骨架</button>
      </div>`).join('')}</div>`;
    showModal({
      title: '消息模板库',
      subtitle: '来自 04_模板\\消息模板_全前缀.md',
      wide: true,
      body,
      footer: '<button class="btn" data-modal-close>关闭</button>',
      onMount: (root) => {
        root.querySelectorAll('[data-template-full]').forEach((btn) => {
          btn.addEventListener('click', () => copyText(sections[Number(btn.dataset.templateFull)].content, '模板全文已复制'));
        });
        root.querySelectorAll('[data-template-skeleton]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const content = sections[Number(btn.dataset.templateSkeleton)].content;
            const match = content.match(/```(?:markdown)?\n([\s\S]*?)```/);
            copyText(match ? match[1].trim() : content, '模板骨架已复制');
          });
        });
      },
    });
  } catch (err) {
    showError(err, '读取模板失败');
  }
}

async function openDocsModal() {
  try {
    const docs = await window.api.workflow.getDocs();
    if (!docs.length) { toast('没有找到文档', 'err'); return; }
    const body = `<div class="terminal-list">${docs.map((d, i) => `
      <div class="terminal-item" style="cursor:default">
        <div class="terminal-icon progress">${icon('book')}</div>
        <div style="min-width:0;flex:1"><div class="terminal-name">${esc(d.label)}</div><div class="terminal-sub mono">${esc(d.path)}</div></div>
        <button class="btn tiny" data-doc-preview="${i}">预览</button>
        <button class="btn tiny" data-doc-open="${i}">打开</button>
      </div>`).join('')}</div>`;
    showModal({
      title: '使用手册',
      subtitle: '安装目录中的文档',
      wide: true,
      body,
      footer: '<button class="btn" data-modal-close>关闭</button>',
      onMount: (root) => {
        root.querySelectorAll('[data-doc-preview]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const doc = docs[Number(btn.dataset.docPreview)];
            try {
              const file = await window.api.workflow.readDoc(doc.path);
              previewModal(doc.label, file.content, doc.path);
            } catch (err) { showError(err, '读取文档失败'); }
          });
        });
        root.querySelectorAll('[data-doc-open]').forEach((btn) => {
          btn.addEventListener('click', () => openLocalPath(docs[Number(btn.dataset.docOpen)].path));
        });
      },
    });
  } catch (err) {
    showError(err, '读取文档列表失败');
  }
}

async function repairInstall() {
  const w = S.workflow;
  if (!w || !w.root) return;
  const ok = await confirmAction({
    title: '补齐缺失文件',
    message: '重新检查协议、角色卡、工具和模板',
    detail: '只补齐缺失文件，不覆盖你修改过的角色卡和协议。不会重置项目、版本号或汇报终端。',
    confirmText: '开始修复',
  });
  if (!ok) return;
  try {
    S.workflowBusy = true;
    const result = await window.api.workflow.install({
      root: w.root,
      project: w.project || 'P001_第一个项目',
      projectTitle: w.profile ? w.profile.title : '',
      codeRoot: w.profile ? w.profile.code_root : '',
      deployTarget: w.profile ? w.profile.deploy_target : '',
      baseline: w.profile ? w.profile.baseline : '',
    });
    S.workflow = result;
    S.workflowBusy = false;
    toast('补齐完成', 'ok');
    await refreshWorkflowState();
  } catch (err) {
    S.workflowBusy = false;
    showError(err, '修复失败');
  }
}

function openNewProjectModal() {
  showModal({
    title: '新建项目',
    subtitle: '会创建完整目录树，并把活动指针切到新项目',
    body: `<form id="newProjectForm">
      <div class="form-grid">
        <div class="field"><label>项目名 *</label><input class="input" name="name" placeholder="P002_新项目" autocomplete="off"></div>
        <div class="field"><label>项目标题</label><input class="input" name="title" placeholder="可选" autocomplete="off"></div>
        <div class="field"><label>code_root</label><input class="input" name="codeRoot" placeholder="none 或绝对路径" autocomplete="off"></div>
        <div class="field"><label>deploy_target</label><input class="input" name="deployTarget" placeholder="待定" autocomplete="off"></div>
        <div class="field span-2"><label>baseline</label><input class="input" name="baseline" placeholder="none 或文件路径" autocomplete="off"></div>
      </div>
    </form>`,
    footer: `<button class="btn" data-modal-close>取消</button>
             <button class="btn primary" id="createProjectBtn">${icon('plus')} 创建并切换</button>`,
    onMount: (root, close) => {
      $('#createProjectBtn', root).addEventListener('click', async () => {
        const form = $('#newProjectForm', root);
        const data = formDataObject(form);
        if (!data.name.trim()) { toast('请填写项目名', 'err'); return; }
        try {
          S.workflow = await window.api.workflow.createProject(data);
          close();
          toast(`项目 ${data.name} 已创建并切换`, 'ok');
          updateWorkflowAlert();
          renderWorkflowView();
        } catch (err) {
          showError(err, '创建项目失败');
        }
      });
    },
  });
}
