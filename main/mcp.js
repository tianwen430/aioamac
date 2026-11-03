'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readTextSafe, safeJsonParse } = require('./util');

const PROTOCOL_VERSION = '2024-11-05';
const INIT_TIMEOUT = 20000;
const DEFAULT_CALL_TIMEOUT = 15 * 60 * 1000; // wait_for_files 可能挂起数分钟

function slug(value, max = 24) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, max) || 'server';
}

function normalizeEnv(input) {
  if (!input) return {};
  if (typeof input === 'object' && !Array.isArray(input)) {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (k && v !== undefined && v !== null) out[String(k)] = String(v);
    }
    return out;
  }
  const out = {};
  for (const line of String(input).split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const idx = text.indexOf('=');
    if (idx <= 0) continue;
    out[text.slice(0, idx).trim()] = text.slice(idx + 1).trim();
  }
  return out;
}

function normalizeArgs(input) {
  if (Array.isArray(input)) return input.map((v) => String(v));
  if (typeof input === 'string') {
    return input.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

function contentToText(result) {
  const parts = [];
  for (const item of (result && result.content) || []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && item.text) parts.push(String(item.text));
    else if (item.type === 'resource' && item.resource) {
      if (typeof item.resource.text === 'string') parts.push(item.resource.text);
      else if (item.resource.uri) parts.push(`[resource] ${item.resource.uri}`);
    } else if (item.type === 'image') {
      parts.push('[图片内容已省略]');
    }
  }
  return parts.join('\n').trim();
}

class McpClient {
  constructor(def, { version = '1.0.0' } = {}) {
    this.def = def;
    this.version = version;
    this.proc = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.tools = [];
    this.status = 'stopped';
    this.error = '';
    this.stderr = '';
    this.startPromise = null;
    this.intentionalStop = false;
  }

  log(line) {
    this.stderr = `${this.stderr}\n${line}`.trim().slice(-8000);
  }

  write(message) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error('MCP 进程未运行');
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} 超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params = {}) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  rejectAll(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  handleLine(line) {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.log(text);
      return;
    }
    if (message.id === undefined || message.id === null) return; // 通知/服务端请求，忽略
    const entry = this.pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(message.error.message || `MCP ${entry.method} 调用失败`));
    } else {
      entry.resolve(message.result || {});
    }
  }

  async start() {
    if (this.status === 'running' && this.proc) return this;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async _start() {
    if (this.proc) this.stop();
    this.intentionalStop = false;
    this.status = 'starting';
    this.error = '';
    this.stderr = '';
    this.buffer = '';
    const def = this.def;
    if (!def.command) throw new Error('MCP 服务缺少启动命令');

    const proc = spawn(def.command, normalizeArgs(def.args), {
      cwd: def.cwd || undefined,
      env: { ...process.env, ...normalizeEnv(def.env) },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.on('error', (err) => {
      this.error = err.message;
      this.status = 'error';
      this.rejectAll(`MCP 进程启动失败：${err.message}`);
    });

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      for (;;) {
        const idx = this.buffer.indexOf('\n');
        if (idx === -1) break;
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.handleLine(line);
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => this.log(String(chunk).trim()));

    proc.on('exit', (code, signal) => {
      const wasRunning = this.status !== 'stopped';
      this.proc = null;
      this.rejectAll(`MCP 进程已退出（${signal || code}）`);
      if (this.intentionalStop) {
        this.status = 'stopped';
      } else if (this.status !== 'error') {
        this.status = 'error';
        this.error = `进程退出：${signal || code}${this.stderr ? `\n${this.stderr.slice(-1200)}` : ''}`;
      }
      if (wasRunning) this.tools = [];
    });

    try {
      const init = await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'aioa-workbench', version: this.version },
      }, INIT_TIMEOUT);
      this.serverInfo = init.serverInfo || {};
      this.notify('notifications/initialized');
      await this.refreshTools();
      this.status = 'running';
      return this;
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      this.stop(true);
      throw err;
    }
  }

  async refreshTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, INIT_TIMEOUT);
      if (Array.isArray(result.tools)) tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    this.tools = tools.filter((t) => t && t.name);
    return this.tools;
  }

  async callTool(name, args = {}) {
    if (this.status !== 'running') await this.start();
    const timeout = Number(this.def.toolTimeoutMs) > 0
      ? Number(this.def.toolTimeoutMs)
      : DEFAULT_CALL_TIMEOUT;
    const result = await this.request('tools/call', { name, arguments: args || {} }, timeout);
    const text = contentToText(result);
    if (result.isError) throw new Error(text || 'MCP 工具返回错误');
    return text;
  }

  stop(silent = false) {
    this.intentionalStop = true;
    this.rejectAll('MCP 服务已停止');
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    if (!silent) {
      this.status = 'stopped';
      this.error = '';
    }
    this.tools = [];
  }
}

class McpManager {
  constructor({ store, version = '1.0.0' }) {
    this.store = store;
    this.version = version;
    this.clients = new Map();
    this.toolIndex = new Map();
    this.toolDefs = [];
    this.toolSignature = '';
  }

  servers() {
    const list = this.store.settings.mcpServers;
    return Array.isArray(list) ? list : [];
  }

  saveServers(list) {
    this.store.settings.mcpServers = list;
    this.store.saveConfig();
  }

  findDef(id) {
    return this.servers().find((s) => s.id === id) || null;
  }

  publicDef(def) {
    const client = this.clients.get(def.id);
    const status = client ? client.status : 'stopped';
    return {
      id: def.id,
      name: def.name || def.id,
      command: def.command || '',
      args: normalizeArgs(def.args),
      cwd: def.cwd || '',
      env: normalizeEnv(def.env),
      enabled: def.enabled !== false,
      status,
      error: client ? client.error : '',
      tools: client && client.status === 'running' ? client.tools.map((t) => t.name) : [],
      stderr: client ? client.stderr : '',
    };
  }

  listPublic() {
    return this.servers().map((def) => this.publicDef(def));
  }

  upsert(payload = {}) {
    const list = this.servers();
    const name = String(payload.name || 'MCP 服务').trim() || 'MCP 服务';
    const base = slug(name);
    const id = payload.id
      ? slug(payload.id)
      : (base === 'server' ? `mcp_${Date.now().toString(36)}` : base);
    const entry = {
      id,
      name,
      command: String(payload.command || '').trim(),
      args: normalizeArgs(payload.args),
      env: normalizeEnv(payload.env),
      cwd: String(payload.cwd || '').trim(),
      enabled: payload.enabled !== false,
    };
    const idx = list.findIndex((s) => s.id === id);
    if (idx >= 0) list[idx] = { ...list[idx], ...entry };
    else list.push(entry);
    this.saveServers(list);
    this.stopClient(id);
    return this.publicDef(this.findDef(id));
  }

  remove(id) {
    this.stopClient(id);
    this.saveServers(this.servers().filter((s) => s.id !== id));
    return this.listPublic();
  }

  async setEnabled(id, enabled) {
    const def = this.findDef(id);
    if (!def) throw new Error('MCP 服务不存在');
    def.enabled = Boolean(enabled);
    this.saveServers(this.servers());
    if (!def.enabled) this.stopClient(id);
  }

  stopClient(id) {
    const client = this.clients.get(id);
    if (client) client.stop();
    this.clients.delete(id);
    this.toolSignature = '';
  }

  clientFor(def) {
    let client = this.clients.get(def.id);
    if (!client) {
      client = new McpClient(def, { version: this.version });
      this.clients.set(def.id, client);
    } else {
      client.def = def;
    }
    return client;
  }

  async start(id) {
    const def = this.findDef(id);
    if (!def) throw new Error('MCP 服务不存在');
    const client = this.clientFor(def);
    await client.start();
    return this.publicDef(def);
  }

  stop(id) {
    this.stopClient(id);
    return this.publicDef(this.findDef(id) || { id });
  }

  async restart(id) {
    this.stopClient(id);
    return this.start(id);
  }

  async agentTools() {
    const enabled = this.servers().filter((s) => s.enabled !== false);
    const signature = JSON.stringify(enabled.map((s) => [s.id, s.command, s.args, s.env, s.cwd]));
    if (this.toolSignature === signature && this.toolDefs.length) {
      return { definitions: this.toolDefs, index: this.toolIndex };
    }
    const definitions = [];
    const index = new Map();
    const used = new Set();
    for (const def of enabled) {
      try {
        const client = this.clientFor(def);
        if (client.status !== 'running') await client.start();
        for (const tool of client.tools) {
          let name = `mcp_${slug(def.id)}_${slug(tool.name, 34)}`.slice(0, 64);
          let n = 2;
          while (used.has(name)) {
            name = `${name.slice(0, 60)}_${n}`;
            n += 1;
          }
          used.add(name);
          definitions.push({
            name,
            description: `[MCP:${def.name || def.id}] ${tool.description || tool.name}`,
            parameters: tool.inputSchema || { type: 'object', properties: {} },
          });
          index.set(name, {
            serverId: def.id,
            serverName: def.name || def.id,
            toolName: tool.name,
          });
        }
      } catch (err) {
        // 单个 MCP 服务启动失败不影响普通文件工具
        this.logStartupError(def, err);
      }
    }
    this.toolSignature = signature;
    this.toolDefs = definitions;
    this.toolIndex = index;
    return { definitions, index };
  }

  logStartupError(def, err) {
    const client = this.clients.get(def.id);
    if (client) {
      client.status = 'error';
      client.error = err.message;
    }
    console.error(`[mcp] ${def.name || def.id}: ${err.message}`);
  }

  async callTool(toolName, args) {
    const info = this.toolIndex.get(toolName);
    if (!info) throw new Error(`未知 MCP 工具：${toolName}`);
    const def = this.findDef(info.serverId);
    if (!def) throw new Error('MCP 服务已删除');
    const client = this.clientFor(def);
    return client.callTool(info.toolName, args);
  }

  findTool(rawName) {
    for (const [name, info] of this.toolIndex) {
      if (info.toolName === rawName) return { name, ...info };
    }
    return null;
  }

  async callToolByName(serverId, toolName, args) {
    const def = this.findDef(serverId);
    if (!def) throw new Error('MCP 服务不存在');
    const client = this.clientFor(def);
    return client.callTool(toolName, args);
  }

  importFromWorkflow(root) {
    const rootPath = String(root || '').trim();
    if (!rootPath) throw new Error('还没有设置工作流根目录');
    const file = path.join(rootPath, '_mcp_config.json');
    if (!fs.existsSync(file)) throw new Error(`没有找到 MCP 配置：${file}`);
    const parsed = safeJsonParse(readTextSafe(file) || '', null);
    if (!parsed || !parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      throw new Error('MCP 配置格式不正确（缺少 mcpServers）');
    }
    const list = this.servers();
    const added = [];
    for (const [name, raw] of Object.entries(parsed.mcpServers)) {
      if (!raw || !raw.command) continue;
      const id = slug(name);
      const entry = {
        id,
        name,
        command: String(raw.command),
        args: normalizeArgs(raw.args),
        env: normalizeEnv(raw.env),
        cwd: String(raw.cwd || rootPath),
        enabled: true,
      };
      const idx = list.findIndex((s) => s.id === id);
      if (idx >= 0) list[idx] = { ...list[idx], ...entry };
      else list.push(entry);
      this.stopClient(id);
      added.push(name);
    }
    this.saveServers(list);
    return { added, servers: this.listPublic() };
  }

  stopAll() {
    for (const [id, client] of this.clients) {
      client.stop();
      this.clients.delete(id);
    }
  }
}

module.exports = {
  McpClient,
  McpManager,
  normalizeArgs,
  normalizeEnv,
  contentToText,
};
