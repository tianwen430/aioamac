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

function buildPrompt(file, folders) {
  return [
    '【自动监听】收件箱发现待处理文件：',
    file,
    '',
    '监听目录：',
    ...folders.map((f) => `- ${f}`),
    '',
    '请按《00_协议总纲.md》第 4 节处理这一个文件：',
    '1. 只读取这个文件；',
    '2. 按前缀路由，把产出写到协议要求的目录；',
    '3. 处理完把源文件移出收件箱，归档到本工位「已处理」；',
    '4. 用一句话汇报结果即可。不要调用 wait_for_files 等待下一个文件——工作台会自动继续监听。',
  ].join('\n');
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
    useMcp: loop.useMcp,
  };
}

class WorkflowListener {
  constructor({ agent, mcp }) {
    this.agent = agent;
    this.mcp = mcp;
    this.loops = new Map();
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
      this.setStatus(loop, 'waiting');
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
      if (!text || text === 'NO_FILE') continue;
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
      loop.rounds += 1;
      loop.lastFile = file;
      this.setStatus(loop, 'processing');
      this.emitLoop(loop, 'loop_file', { file });
      try {
        const res = await this.agent.send(loop.conversationId, buildPrompt(file, loop.folders), loop.emit);
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
