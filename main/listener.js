'use strict';

const fs = require('fs');
const path = require('path');

const STOP = Symbol('stop');
const IGNORE_SUFFIX = /\.(tmp|part|crdownload|swp|lock)$/i;

function ignorable(name) {
  return !name || name.startsWith('.') || name.startsWith('~') || IGNORE_SUFFIX.test(name);
}

function listPending(folders) {
  const items = [];
  for (const folder of folders) {
    let names = [];
    try {
      names = fs.readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      if (ignorable(name)) continue;
      const full = path.join(folder, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile()) items.push({ path: full, mtime: stat.mtimeMs });
      } catch {
        /* ignore */
      }
    }
  }
  items.sort((a, b) => a.mtime - b.mtime);
  return items.map((it) => it.path);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    if (signal) {
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
    }
  });
}

/**
 * 心跳由监听程序写，不消耗模型调用。
 * 只处理形如 `.../<工位>/收件箱` 的目录，写到工位根目录 `_HEARTBEAT.md`。
 */
function writeHeartbeats(folders, note) {
  const stamp = new Date().toISOString();
  for (const folder of folders || []) {
    if (path.basename(String(folder)) !== '收件箱') continue;
    const file = path.join(path.dirname(String(folder)), '_HEARTBEAT.md');
    try {
      const prev = fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-4)
        : [];
      prev.push(`- ${stamp} ${note}`);
      fs.writeFileSync(file, `${prev.join('\n')}\n`, 'utf8');
    } catch {
      /* 心跳失败不影响监听 */
    }
  }
}

/**
 * 原生文件监听：不依赖 Python / MCP，用于工作台自己的循环监听兜底。
 * 语义与 file_watcher_mcp.py 保持一致：先扫积压，再轮询等待新文件。
 */
async function waitForFiles({ folders, timeoutSeconds = 300, settleSeconds = 1, signal } = {}) {
  const list = (folders || []).map((f) => String(f || '').trim()).filter(Boolean);
  for (const folder of list) {
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  const started = Date.now();
  const timeout = Math.max(1, Number(timeoutSeconds) || 300) * 1000;
  for (;;) {
    if (signal && signal.aborted) return null;
    const pending = listPending(list);
    if (pending.length) {
      if (settleSeconds > 0) await sleep(settleSeconds * 1000, signal);
      if (signal && signal.aborted) return null;
      const confirmed = listPending(list);
      return `BACKLOG: ${confirmed[0] || pending[0]}`;
    }
    const remain = timeout - (Date.now() - started);
    if (remain <= 0) return 'NO_FILE';
    await sleep(Math.min(1000, remain), signal);
  }
}

function globalStatusPath(folders) {
  for (const folder of folders || []) {
    if (path.basename(String(folder)) !== '收件箱') continue;
    const station = path.dirname(String(folder));
    const project = path.dirname(station);
    return path.join(project, '01_总控', '发件箱', '_GLOBAL_STATUS.md');
  }
  return '';
}

function buildPrompt(file, folders, { first = false } = {}) {
  const status = globalStatusPath(folders);
  const lines = [
    '【自动监听】收件箱发现待处理文件：',
    file,
    '',
    '监听目录：',
    ...folders.map((f) => `- ${f}`),
    '',
  ];
  if (first) {
    lines.push(
      '这是本对话第一次处理文件：先读一次《00_协议总纲.md》第 4 节，记住路由与归档规则；之后不要重复通读协议。'
    );
  } else {
    lines.push('协议规则已在本对话上下文中，本轮不要重读《00_协议总纲.md》，只读下面两项：');
  }
  lines.push(
    status ? `1. 全局状态：${status}（PAUSED 则停手）` : '1. 全局状态：{PROJECT_ROOT}\\01_总控\\发件箱\\_GLOBAL_STATUS.md（PAUSED 则停手）',
    '2. 当前文件（只读这一个）',
    '',
    '处理要求：',
    '- 按前缀路由，把产出写到协议要求的目录；',
    '- 处理完把源文件移出收件箱，归档到本工位「已处理」；',
    '- 用一句话汇报结果即可；',
    '- 心跳由工作台监听程序写，不需要你写 `_HEARTBEAT.md`；',
    '- 不要调用 wait_for_files 等待下一个文件——工作台会自动继续监听。'
  );
  return lines.join('\n');
}

function publicState(loop) {
  return {
    conversationId: loop.conversationId,
    folders: loop.folders.slice(),
    status: loop.status,
    rounds: loop.rounds,
    startedAt: loop.startedAt,
    lastFile: loop.lastFile,
    lastError: loop.lastError,
    lastHeartbeatAt: loop.lastHeartbeatAt || 0,
    configuring: Boolean(loop.configuring),
    useMcp: loop.useMcp,
  };
}

class WorkflowListener {
  constructor({ agent, mcp }) {
    this.agent = agent;
    this.mcp = mcp;
    this.loops = new Map();
    this.configuring = false;
  }

  setConfiguring(flag) {
    this.configuring = Boolean(flag);
    for (const loop of this.loops.values()) {
      loop.configuring = this.configuring;
      if (this.configuring) {
        loop.status = 'configuring';
        this.emitLoop(loop, 'loop_status');
      }
    }
  }

  async pauseWhileConfiguring(loop) {
    if (!this.configuring) {
      loop.configuring = false;
      return;
    }
    loop.configuring = true;
    while (this.configuring && !loop.stopped) {
      if (loop.status !== 'configuring') this.setStatus(loop, 'configuring');
      await sleep(500, loop.signal);
    }
    loop.configuring = false;
  }

  get(conversationId) {
    const loop = this.loops.get(conversationId);
    return loop ? publicState(loop) : null;
  }

  list() {
    return Array.from(this.loops.values()).map(publicState);
  }

  emitLoop(loop, type, extra = {}) {
    try {
      loop.emit({ conversationId: loop.conversationId, type, loop: publicState(loop), ...extra });
    } catch {
      /* window closed */
    }
  }

  setStatus(loop, status) {
    loop.status = status;
    this.emitLoop(loop, 'loop_status');
  }

  async start({ conversationId, folders, timeoutSeconds = 300, useMcp = true, emit }) {
    const id = String(conversationId || '');
    if (!id) throw new Error('缺少对话 ID');
    if (this.loops.has(id)) throw new Error('这个对话已经在监听');
    const list = (folders || []).map((f) => String(f || '').trim()).filter(Boolean);
    if (!list.length) throw new Error('请至少选择一个监听目录');
    for (const folder of list) {
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        throw new Error(`监听目录不存在：${folder}`);
      }
    }

    const controller = new AbortController();
    const loop = {
      conversationId: id,
      folders: list,
      timeoutSeconds: Math.max(5, Math.min(540, Number(timeoutSeconds) || 300)),
      useMcp: Boolean(useMcp),
      emit,
      signal: controller.signal,
      controller,
      status: 'starting',
      rounds: 0,
      startedAt: Date.now(),
      lastFile: '',
      lastError: '',
      stopped: false,
      reason: '',
      stopPromise: null,
      stopResolve: null,
    };
    loop.stopPromise = new Promise((resolve) => {
      loop.stopResolve = resolve;
    });
    this.loops.set(id, loop);
    this.emitLoop(loop, 'loop_start');
    this.run(loop)
      .catch((err) => {
        loop.reason = 'error';
        loop.lastError = err.message || String(err);
        this.emitLoop(loop, 'loop_error', { message: loop.lastError });
      })
      .finally(() => {
        this.loops.delete(id);
        loop.status = 'stopped';
        this.emitLoop(loop, 'loop_end', { reason: loop.reason || 'stopped' });
      });
    return publicState(loop);
  }

  async resolveWaitTool() {
    if (!this.mcp) return null;
    try {
      await this.mcp.agentTools();
      return this.mcp.findTool('wait_for_files');
    } catch {
      return null;
    }
  }

  async waitForFile(loop) {
    if (loop.useMcp) {
      const tool = await this.resolveWaitTool();
      if (tool) {
        try {
          const call = this.mcp.callToolByName(tool.serverId, tool.toolName, {
            folder_paths: loop.folders,
            timeout_seconds: loop.timeoutSeconds,
            settle_seconds: 1,
          });
          const result = await Promise.race([call, loop.stopPromise]);
          if (result === STOP) return null;
          return result;
        } catch (err) {
          if (loop.stopped) return null;
          loop.useMcp = false;
          loop.lastError = `MCP 监听失败，已切到本机监听：${err.message}`;
          this.emitLoop(loop, 'loop_error', { message: loop.lastError });
        }
      }
    }
    return waitForFiles({
      folders: loop.folders,
      timeoutSeconds: loop.timeoutSeconds,
      settleSeconds: 1,
      signal: loop.signal,
    });
  }

  async run(loop) {
    let errors = 0;
    while (!loop.stopped) {
      await this.pauseWhileConfiguring(loop);
      if (loop.stopped) break;
      this.setStatus(loop, 'waiting');
      this.touchHeartbeat(loop, '等待文件');
      let result;
      try {
        result = await this.waitForFile(loop);
      } catch (err) {
        if (loop.stopped) break;
        loop.lastError = err.message || String(err);
        this.emitLoop(loop, 'loop_error', { message: loop.lastError });
        await sleep(3000, loop.signal);
        continue;
      }
      if (loop.stopped || result === null) break;
      const text = String(result || '').trim();
      if (!text || text === 'NO_FILE') {
        this.touchHeartbeat(loop, '无文件');
        continue;
      }
      const match = /^(BACKLOG|NEW):\s*(.+)$/.exec(text);
      if (!match) {
        errors += 1;
        loop.lastError = text.startsWith('ERROR') ? text : `无法识别的监听结果：${text.slice(0, 200)}`;
        this.emitLoop(loop, 'loop_error', { message: loop.lastError });
        if (errors >= 3) {
          loop.reason = 'error';
          break;
        }
        await sleep(60000, loop.signal);
        continue;
      }
      errors = 0;
      const file = match[2].trim();
      await this.pauseWhileConfiguring(loop);
      if (loop.stopped) break;
      const firstFile = loop.rounds === 0;
      loop.rounds += 1;
      loop.lastFile = file;
      this.setStatus(loop, 'processing');
      this.touchHeartbeat(loop, `处理 ${path.basename(file)}`);
      this.emitLoop(loop, 'loop_file', { file });
      try {
        const res = await this.agent.send(loop.conversationId, buildPrompt(file, loop.folders, { first: firstFile }), loop.emit);
        if (!res.ok) {
          loop.lastError = res.failure || '';
          if (res.failure === '已取消' || loop.stopped) break;
          await sleep(3000, loop.signal);
        }
      } catch (err) {
        loop.lastError = err.message || String(err);
        this.emitLoop(loop, 'loop_error', { message: loop.lastError });
        if (/对话不存在/.test(loop.lastError)) {
          loop.reason = 'error';
          break;
        }
        await sleep(3000, loop.signal);
      }
    }
    loop.reason = loop.reason || (loop.stopped ? 'stopped' : 'error');
  }

  touchHeartbeat(loop, note) {
    loop.lastHeartbeatAt = Date.now();
    writeHeartbeats(loop.folders, note);
  }

  stop(conversationId) {
    const loop = this.loops.get(conversationId);
    if (!loop) return false;
    loop.stopped = true;
    loop.reason = 'stopped';
    loop.status = 'stopped';
    try {
      loop.stopResolve(STOP);
    } catch {
      /* ignore */
    }
    try {
      this.agent.abort(conversationId);
    } catch {
      /* ignore */
    }
    this.emitLoop(loop, 'loop_stopping');
    return true;
  }

  stopAll() {
    for (const id of Array.from(this.loops.keys())) this.stop(id);
  }
}

module.exports = {
  WorkflowListener,
  waitForFiles,
  listPending,
  buildPrompt,
};
