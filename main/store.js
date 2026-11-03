'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureDir, readTextSafe, writeTextAtomic, pathExists, safeJsonParse } = require('./util');

const DEFAULT_SETTINGS = {
  version: 1,
  workflowRoot: '',
  defaultWorkspace: '',
  theme: 'light',
  rememberKeys: false,
  permissions: 'ask', // readonly | ask | auto
  allowCommands: false,
  staleMinutes: 8,
  defaultModel: null, // { providerId, model }
  providers: {}, // overrides only, never plaintext keys
  customProviders: [],
  mcpServers: [],
  mcpAutoApprove: true,
  lastConversationId: '',
  windowBounds: null,
};

class Store {
  constructor({ userDataDir, safeStorage, canEncrypt }) {
    this.dir = userDataDir;
    this.safeStorage = safeStorage;
    // 加密能力由主进程在启动时异步探测一次后传入；
    // 未传入时回退到旧的同步接口（供离线测试的 mock 使用）
    this.canEncrypt = typeof canEncrypt === 'boolean'
      ? canEncrypt
      : Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
    this.configPath = path.join(userDataDir, 'config.json');
    this.secretsPath = path.join(userDataDir, 'secrets.json');
    this.conversationsPath = path.join(userDataDir, 'conversations.json');
    this.keys = new Map();
    this.settings = { ...DEFAULT_SETTINGS };
    this.conversationData = { version: 1, conversations: [] };
    ensureDir(this.dir);
    this.load();
  }

  load() {
    const raw = readTextSafe(this.configPath);
    if (raw) {
      const parsed = safeJsonParse(raw, null);
      if (parsed && typeof parsed === 'object') {
        this.settings = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          providers: parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {},
          customProviders: Array.isArray(parsed.customProviders) ? parsed.customProviders : [],
        };
      } else {
        this.backupBroken(this.configPath);
      }
    }
    const convRaw = readTextSafe(this.conversationsPath);
    if (convRaw) {
      const parsed = safeJsonParse(convRaw, null);
      if (parsed && Array.isArray(parsed.conversations)) {
        this.conversationData = parsed;
      } else {
        this.backupBroken(this.conversationsPath);
      }
    }
    if (this.settings.rememberKeys) {
      this.loadSecrets();
    } else {
      this.clearSecretsFile();
    }
  }

  backupBroken(file) {
    try {
      const dest = `${file}.broken-${Date.now()}`;
      fs.copyFileSync(file, dest);
    } catch {
      /* ignore */
    }
  }

  loadSecrets() {
    const raw = readTextSafe(this.secretsPath);
    if (!raw) return;
    const parsed = safeJsonParse(raw, null);
    if (!parsed || typeof parsed.keys !== 'object') return;
    if (!this.safeStorage || !this.canEncrypt) return;
    for (const [id, enc] of Object.entries(parsed.keys)) {
      try {
        const dec = this.safeStorage.decryptString(Buffer.from(enc, 'base64'));
        if (dec) this.keys.set(id, dec);
      } catch {
        /* ignore broken entry */
      }
    }
  }

  clearSecretsFile() {
    try {
      if (fs.existsSync(this.secretsPath)) fs.unlinkSync(this.secretsPath);
    } catch {
      /* ignore */
    }
  }

  saveSecrets() {
    if (!this.settings.rememberKeys) {
      this.clearSecretsFile();
      return;
    }
    if (!this.safeStorage || !this.canEncrypt) {
      return;
    }
    const keys = {};
    for (const [id, value] of this.keys.entries()) {
      if (!value) continue;
      try {
        keys[id] = this.safeStorage.encryptString(value).toString('base64');
      } catch {
        /* ignore */
      }
    }
    writeTextAtomic(this.secretsPath, JSON.stringify({ version: 1, keys }, null, 2));
  }

  publicSettings() {
    return {
      ...this.settings,
      providers: undefined,
      customProviders: this.settings.customProviders,
      hasStoredSecrets: pathExists(this.secretsPath),
      canEncrypt: Boolean(this.safeStorage && this.canEncrypt),
    };
  }

  saveSettings(patch = {}) {
    const allowed = [
      'workflowRoot',
      'defaultWorkspace',
      'theme',
      'rememberKeys',
      'permissions',
      'allowCommands',
      'staleMinutes',
      'defaultModel',
      'mcpServers',
      'mcpAutoApprove',
      'lastConversationId',
      'windowBounds',
    ];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        this.settings[key] = patch[key];
      }
    }
    if (patch.rememberKeys === false) {
      this.clearSecretsFile();
    }
    if (patch.rememberKeys === true) {
      this.saveSecrets();
    }
    this.saveConfig();
    return this.publicSettings();
  }

  saveConfig() {
    const out = { ...this.settings };
    writeTextAtomic(this.configPath, JSON.stringify(out, null, 2));
  }

  getProviderOverride(id) {
    return this.settings.providers[id] || {};
  }

  saveProviderOverride(id, patch = {}) {
    const current = this.settings.providers[id] || {};
    this.settings.providers[id] = { ...current, ...patch };
    this.saveConfig();
    return this.settings.providers[id];
  }

  addCustomProvider(def) {
    const id = def.id || `custom_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
    const item = {
      id,
      name: def.name || '自定义服务',
      baseUrl: def.baseUrl || '',
      type: def.type === 'anthropic' ? 'anthropic' : 'openai',
      requiresKey: def.requiresKey !== false,
      models: Array.isArray(def.models) ? def.models : [],
      description: def.description || '自定义服务',
    };
    const exists = this.settings.customProviders.find((p) => p.id === id);
    if (exists) Object.assign(exists, item);
    else this.settings.customProviders.push(item);
    this.saveConfig();
    return item;
  }

  removeCustomProvider(id) {
    this.settings.customProviders = this.settings.customProviders.filter((p) => p.id !== id);
    delete this.settings.providers[id];
    this.keys.delete(id);
    this.saveSecrets();
    this.saveConfig();
  }

  setKey(providerId, value, remember) {
    if (value) {
      this.keys.set(providerId, value);
      this.settings.providers[providerId] = {
        ...(this.settings.providers[providerId] || {}),
        keySet: true,
      };
    } else {
      this.keys.delete(providerId);
      this.settings.providers[providerId] = {
        ...(this.settings.providers[providerId] || {}),
        keySet: false,
      };
    }
    if (remember) {
      this.settings.rememberKeys = true;
      this.saveSecrets();
    } else {
      this.clearSecretsFile();
    }
    this.saveConfig();
  }

  clearKey(providerId) {
    this.keys.delete(providerId);
    this.settings.providers[providerId] = {
      ...(this.settings.providers[providerId] || {}),
      keySet: false,
    };
    this.saveSecrets();
    this.saveConfig();
  }

  getKey(providerId) {
    return this.keys.get(providerId) || '';
  }

  hasKey(providerId) {
    return Boolean(this.keys.get(providerId));
  }

  clearAllKeys() {
    this.keys.clear();
    for (const id of Object.keys(this.settings.providers)) {
      this.settings.providers[id].keySet = false;
    }
    this.clearSecretsFile();
    this.saveConfig();
  }

  // ---------- conversations ----------

  listConversations() {
    return this.conversationData.conversations
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        model: c.model || null,
        workspace: c.workspace || '',
        messageCount: (c.messages || []).length,
      }));
  }

  getConversation(id) {
    return this.conversationData.conversations.find((c) => c.id === id) || null;
  }

  createConversation({ model = null, workspace = '', title = '新对话' } = {}) {
    const now = Date.now();
    const conv = {
      id: `c_${now}_${crypto.randomBytes(3).toString('hex')}`,
      title,
      createdAt: now,
      updatedAt: now,
      model,
      workspace,
      messages: [],
    };
    this.conversationData.conversations.push(conv);
    this.settings.lastConversationId = conv.id;
    this.saveConversations();
    this.saveConfig();
    return conv;
  }

  updateConversation(id, patch = {}) {
    const conv = this.getConversation(id);
    if (!conv) throw new Error('对话不存在');
    for (const key of ['title', 'model', 'workspace', 'messages']) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) conv[key] = patch[key];
    }
    conv.updatedAt = Date.now();
    this.saveConversations();
    return conv;
  }

  deleteConversation(id) {
    this.conversationData.conversations = this.conversationData.conversations.filter((c) => c.id !== id);
    if (this.settings.lastConversationId === id) {
      this.settings.lastConversationId = '';
      this.saveConfig();
    }
    this.saveConversations();
  }

  clearConversations() {
    this.conversationData.conversations = [];
    this.settings.lastConversationId = '';
    this.saveConfig();
    this.saveConversations();
  }

  saveConversations() {
    // 最多保留 200 个对话，防止数据文件无限膨胀
    if (this.conversationData.conversations.length > 200) {
      this.conversationData.conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      this.conversationData.conversations = this.conversationData.conversations.slice(0, 200);
    }
    writeTextAtomic(this.conversationsPath, JSON.stringify(this.conversationData, null, 2));
  }

  exportConversationMarkdown(id) {
    const conv = this.getConversation(id);
    if (!conv) throw new Error('对话不存在');
    const lines = [`# ${conv.title}`, ''];
    lines.push(`- 导出时间：${new Date().toISOString()}`);
    if (conv.model) lines.push(`- 模型：${conv.model.providerId} / ${conv.model.model}`);
    if (conv.workspace) lines.push(`- 工作区：${conv.workspace}`);
    lines.push('');
    for (const m of conv.messages || []) {
      if (m.role === 'user') {
        lines.push('## 用户', '', m.content || '', '');
      } else if (m.role === 'assistant') {
        lines.push('## 助手', '', m.content || '', '');
        for (const tc of m.toolCalls || []) {
          lines.push(`### 工具调用：${tc.name}`, '', '```json', tc.arguments || '{}', '```', '');
        }
      } else if (m.role === 'tool') {
        lines.push(`### 工具结果：${m.name || m.toolCallId || ''}`, '', '```', String(m.content || '').slice(0, 20000), '```', '');
      }
    }
    return lines.join('\n');
  }

  stats() {
    return {
      conversations: this.conversationData.conversations.length,
      keys: this.keys.size,
      userDataDir: this.dir,
    };
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
