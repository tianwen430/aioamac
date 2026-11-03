'use strict';

const { truncateMiddle } = require('./util');

const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresKey: true,
    description: 'DeepSeek 官方 API，OpenAI 兼容',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    docs: 'https://platform.deepseek.com',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    description: 'OpenAI 官方 API',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'o4-mini'],
    docs: 'https://platform.openai.com',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    requiresKey: true,
    description: 'Claude 原生 Messages API（非 OpenAI 兼容）',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    docs: 'https://console.anthropic.com',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    type: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresKey: true,
    description: 'Gemini 的 OpenAI 兼容端点',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    docs: 'https://aistudio.google.com',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    type: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    requiresKey: true,
    description: '智谱开放平台，OpenAI 兼容',
    models: ['glm-4.6', 'glm-4.5-air', 'glm-4-plus'],
    docs: 'https://open.bigmodel.cn',
  },
  {
    id: 'dashscope',
    name: '阿里云百炼',
    type: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    requiresKey: true,
    description: '通义千问 / Qwen，OpenAI 兼容',
    models: ['qwen3-max', 'qwen-plus', 'qwen3-coder-plus'],
    docs: 'https://bailian.console.aliyun.com',
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    type: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    requiresKey: true,
    description: 'Kimi 开放平台，OpenAI 兼容',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-128k'],
    docs: 'https://platform.moonshot.cn',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    type: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    requiresKey: true,
    description: '聚合多种开源模型，OpenAI 兼容',
    models: ['deepseek-ai/DeepSeek-V3.2-Exp', 'Qwen/Qwen3-235B-A22B-Instruct-2507'],
    docs: 'https://siliconflow.cn',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    description: '一个 Key 访问多家模型',
    models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4.1', 'deepseek/deepseek-chat'],
    docs: 'https://openrouter.ai',
  },
  {
    id: 'ollama',
    name: 'Ollama 本地模型',
    type: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    requiresKey: false,
    description: '本机运行的 Ollama，无需 Key',
    models: ['qwen3:8b', 'llama3.1:8b'],
    docs: 'https://ollama.com',
  },
  {
    id: 'custom',
    name: '自定义 OpenAI 兼容服务',
    type: 'openai',
    baseUrl: '',
    requiresKey: true,
    description: '填写任意 OpenAI 兼容接口地址',
    models: [],
    custom: true,
  },
];

function presetById(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id) || null;
}

function normalizeBaseUrl(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  b = b.replace(/\/chat\/completions$/i, '');
  b = b.replace(/\/messages$/i, '');
  return b;
}

function mergeProvider(settings, preset) {
  const override = (settings.providers && settings.providers[preset.id]) || {};
  const models = Array.isArray(override.models) && override.models.length
    ? override.models
    : preset.models || [];
  return {
    ...preset,
    ...override,
    id: preset.id,
    name: override.name || preset.name,
    type: override.type || preset.type,
    baseUrl: normalizeBaseUrl(override.baseUrl || preset.baseUrl),
    models: [...new Set(models.filter(Boolean))],
    configured: Boolean(override.enabled !== false && (preset.requiresKey === false || override.keySet)),
  };
}

function getProviderDefinitions(settings) {
  const list = PROVIDER_PRESETS.map((p) => {
    const merged = mergeProvider(settings, p);
    const override = (settings.providers && settings.providers[p.id]) || {};
    return { ...merged, keySet: Boolean(override.keySet) };
  });
  const custom = Array.isArray(settings.customProviders) ? settings.customProviders : [];
  for (const c of custom) {
    const override = (settings.providers && settings.providers[c.id]) || {};
    const models = Array.isArray(override.models) && override.models.length ? override.models : c.models || [];
    list.push({
      id: c.id,
      name: override.name || c.name || '自定义服务',
      type: override.type || c.type || 'openai',
      baseUrl: normalizeBaseUrl(override.baseUrl || c.baseUrl || ''),
      requiresKey: c.requiresKey !== false,
      description: c.description || '自定义服务',
      models: [...new Set(models.filter(Boolean))],
      keySet: Boolean(override.keySet),
      custom: true,
    });
  }
  return list;
}

function publicProviders(settings, hasKey) {
  return getProviderDefinitions(settings)
    .filter((p) => p.id !== 'custom')
    .map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      requiresKey: p.requiresKey,
      description: p.description,
      docs: p.docs || '',
      models: p.models,
      keySet: hasKey(p.id),
      custom: Boolean(p.custom),
    }));
}

function modelsUrl(provider) {
  const base = normalizeBaseUrl(provider.baseUrl);
  if (provider.type === 'anthropic') return `${base}/models`;
  return `${base}/models`;
}

function chatUrl(provider) {
  const base = normalizeBaseUrl(provider.baseUrl);
  return provider.type === 'anthropic' ? `${base}/messages` : `${base}/chat/completions`;
}

function authHeaders(provider, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.type === 'anthropic') {
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

function friendlyStatus(status) {
  if (status === 400) return '请求参数被服务商拒绝';
  if (status === 401) return 'API Key 无效或已过期';
  if (status === 403) return 'API Key 没有访问该模型的权限';
  if (status === 404) return '接口地址或模型不存在';
  if (status === 408) return '服务商请求超时';
  if (status === 413) return '请求内容过长';
  if (status === 429) return '请求过于频繁，或额度/余额不足';
  if (status >= 500) return '服务商暂时不可用';
  return `请求失败（HTTP ${status}）`;
}

function providerError(status, detail) {
  const raw = String(detail || '');
  let excerpt = raw.replace(/\s+/g, ' ').trim();
  if (status === 401 || status === 403) excerpt = '';
  if (excerpt.length > 400) excerpt = `${excerpt.slice(0, 400)}…`;
  const err = new Error(excerpt ? `${friendlyStatus(status)}：${excerpt}` : friendlyStatus(status));
  err.status = status;
  err.detail = raw.slice(0, 2000);
  return err;
}

async function request(provider, key, url, options = {}, signal) {
  if (provider.requiresKey && !key) {
    throw new Error('还没有填写 API Key');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('请求超时（10 分钟）')), 10 * 60 * 1000);
  let externalAbort = null;
  if (signal) {
    externalAbort = () => ctrl.abort(signal.reason || new Error('已取消'));
    if (signal.aborted) externalAbort();
    else signal.addEventListener('abort', externalAbort, { once: true });
  }
  const headers = authHeaders(provider, key);
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: { ...headers, ...(options.headers || {}) },
      body: options.body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = providerError(res.status, text);
      throw err;
    }
    return res;
  } catch (err) {
    if (err && err.status) throw err;
    if (ctrl.signal.aborted) {
      if (signal && signal.aborted) throw new Error('已取消');
      throw new Error('请求超时或已取消');
    }
    if (String(err.message || '').includes('fetch failed')) {
      throw new Error('无法连接到服务商，请检查网络、接口地址或代理设置');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal && externalAbort) signal.removeEventListener('abort', externalAbort);
  }
}

function pickModels(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : [];
  return list
    .map((m) => (typeof m === 'string' ? m : m.id || m.name || m.model))
    .filter(Boolean)
    .map(String);
}

async function fetchModels(provider, key, signal) {
  const url = modelsUrl(provider);
  const res = await request(provider, key, url, {}, signal);
  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('服务商返回的模型列表不是 JSON，请手动填写模型名');
  }
  const models = pickModels(payload).sort((a, b) => a.localeCompare(b));
  if (!models.length) {
    throw new Error('服务商没有返回模型列表，请手动填写模型名');
  }
  return models;
}

async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines = [];

  const dispatch = () => {
    if (!dataLines.length) {
      eventName = '';
      return;
    }
    const data = dataLines.join('\n');
    const ev = eventName;
    dataLines = [];
    eventName = '';
    onEvent(ev, data);
  };

  const handleLine = (line) => {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      return;
    }
    if (line.startsWith('data:')) {
      const data = line.slice(5).replace(/^ /, '');
      if (!eventName) {
        // OpenAI 风格：没有 event 行，逐条 data 立即处理
        onEvent('', data);
      } else {
        dataLines.push(data);
      }
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const line of buffer.split('\n')) handleLine(line);
  }
  dispatch();
}

function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (!m || m.error) continue;
    if (m.role === 'user') {
      out.push({ role: 'user', content: String(m.content || '') });
    } else if (m.role === 'assistant') {
      const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      if (!String(m.content || '').trim() && !toolCalls.length) continue;
      const msg = { role: 'assistant', content: String(m.content || '') };
      if (toolCalls.length) {
        msg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments || '{}' },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: String(m.content || ''),
      });
    }
  }
  return out;
}

async function streamOpenAI(provider, key, model, system, messages, tools, signal, onEvent) {
  const body = {
    model,
    messages: toOpenAIMessages(system, messages),
    stream: true,
  };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    }));
    body.tool_choice = 'auto';
  }

  const res = await request(provider, key, chatUrl(provider), {
    method: 'POST',
    body: JSON.stringify(body),
  }, signal);

  const contentType = String(res.headers.get('content-type') || '');
  if (!contentType.includes('event-stream')) {
    const text = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`服务商返回了非流式内容：${text.slice(0, 300)}`);
    }
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error(`服务商返回格式异常：${text.slice(0, 300)}`);
    const content = message.content || '';
    const reasoning = message.reasoning_content || message.reasoning || '';
    const toolCalls = (message.tool_calls || []).map((tc) => ({
      id: tc.id || `call_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      name: tc.function?.name || '',
      arguments: tc.function?.arguments || '{}',
    })).filter((tc) => tc.name);
    if (content) onEvent('text', { text: content });
    if (reasoning) onEvent('reasoning', { text: reasoning });
    for (const tc of toolCalls) onEvent('tool_call', { toolCall: tc });
    return { content, reasoning, toolCalls };
  }

  let content = '';
  let reasoning = '';
  let finishReason = '';
  const calls = [];

  await readSSE(res, (event, data) => {
    if (data === '[DONE]') return;
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }
    if (obj.error) {
      throw new Error(obj.error.message || '服务商返回错误');
    }
    const choice = obj.choices && obj.choices[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onEvent('text', { text: delta.content });
    }
    const r = delta.reasoning_content || delta.reasoning;
    if (typeof r === 'string' && r) {
      reasoning += r;
      onEvent('reasoning', { text: r });
    }
    const toolDeltas = delta.tool_calls || [];
    for (const tc of toolDeltas) {
      const idx = Number.isInteger(tc.index) ? tc.index : 0;
      if (!calls[idx]) calls[idx] = { id: '', name: '', arguments: '' };
      const slot = calls[idx];
      if (tc.id && !slot.id) slot.id = tc.id;
      if (tc.function && tc.function.name && !slot.name) {
        slot.name = tc.function.name;
      }
      if (tc.function && typeof tc.function.arguments === 'string') {
        slot.arguments += tc.function.arguments;
        onEvent('tool_call_delta', {
          index: idx,
          id: slot.id,
          name: slot.name,
          argumentsDelta: tc.function.arguments,
          argumentsSoFar: slot.arguments,
        });
      }
    }
    if (delta.function_call && delta.function_call.name && !calls[0]) {
      calls[0] = { id: '', name: delta.function_call.name, arguments: delta.function_call.arguments || '' };
    } else if (delta.function_call && delta.function_call.arguments && calls[0]) {
      calls[0].arguments += delta.function_call.arguments;
    }
    if (obj.usage) onEvent('usage', { usage: obj.usage });
  });

  const toolCalls = calls
    .filter((c) => c && c.name)
    .map((c, i) => ({
      id: c.id || `call_${Date.now()}_${i}`,
      name: c.name,
      arguments: c.arguments || '{}',
    }));
  for (const tc of toolCalls) onEvent('tool_call', { toolCall: tc });
  return { content, reasoning, toolCalls, finishReason };
}

function toAnthropicMessages(messages) {
  const out = [];
  let pendingToolResults = [];
  const flushToolResults = () => {
    if (pendingToolResults.length) {
      out.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };
  for (const m of messages) {
    if (!m || m.error) continue;
    if (m.role === 'user') {
      flushToolResults();
      const text = String(m.content || '');
      if (text) out.push({ role: 'user', content: [{ type: 'text', text }] });
    } else if (m.role === 'assistant') {
      flushToolResults();
      const blocks = [];
      if (String(m.content || '').trim()) blocks.push({ type: 'text', text: String(m.content) });
      for (const tc of m.toolCalls || []) {
        let input = {};
        try {
          input = JSON.parse(tc.arguments || '{}');
        } catch {
          input = { _raw: tc.arguments || '' };
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: String(m.content || ''),
      });
    }
  }
  flushToolResults();
  return out;
}

async function streamAnthropic(provider, key, model, system, messages, tools, signal, onEvent) {
  const body = {
    model,
    max_tokens: 8192,
    messages: toAnthropicMessages(messages),
    stream: true,
  };
  if (system) body.system = system;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters || { type: 'object', properties: {} },
    }));
  }

  const res = await request(provider, key, chatUrl(provider), {
    method: 'POST',
    body: JSON.stringify(body),
  }, signal);

  let content = '';
  let reasoning = '';
  let stopReason = '';
  const blocks = new Map();

  await readSSE(res, (event, data) => {
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }
    if (event === 'error' || obj.type === 'error') {
      throw new Error(obj.error?.message || 'Anthropic 返回错误');
    }
    if (event === 'content_block_start') {
      const idx = obj.index;
      const cb = obj.content_block || {};
      blocks.set(idx, {
        type: cb.type,
        id: cb.id || '',
        name: cb.name || '',
        text: '',
        argsJson: '',
      });
      if (cb.type === 'tool_use') {
        onEvent('tool_call_start', { index: idx, id: cb.id, name: cb.name });
      }
    } else if (event === 'content_block_delta') {
      const idx = obj.index;
      const block = blocks.get(idx);
      if (!block) return;
      const d = obj.delta || {};
      if (d.type === 'text_delta' && d.text) {
        block.text += d.text;
        content += d.text;
        onEvent('text', { text: d.text });
      } else if (d.type === 'thinking_delta' && d.thinking) {
        reasoning += d.thinking;
        onEvent('reasoning', { text: d.thinking });
      } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        block.argsJson += d.partial_json;
        onEvent('tool_call_delta', {
          index: idx,
          id: block.id,
          name: block.name,
          argumentsDelta: d.partial_json,
          argumentsSoFar: block.argsJson,
        });
      }
    } else if (event === 'content_block_stop') {
      const idx = obj.index;
      const block = blocks.get(idx);
      if (block && block.type === 'tool_use') {
        const args = block.argsJson || '{}';
        onEvent('tool_call', {
          toolCall: { id: block.id, name: block.name, arguments: args },
        });
      }
    } else if (event === 'message_delta') {
      if (obj.delta && obj.delta.stop_reason) stopReason = obj.delta.stop_reason;
      if (obj.usage) onEvent('usage', { usage: obj.usage });
    } else if (event === 'message_start') {
      if (obj.message && obj.message.usage) onEvent('usage', { usage: obj.message.usage });
    }
  });

  const toolCalls = [];
  for (const block of blocks.values()) {
    if (block.type === 'tool_use' && block.name) {
      toolCalls.push({
        id: block.id || `toolu_${Date.now()}_${toolCalls.length}`,
        name: block.name,
        arguments: block.argsJson || '{}',
      });
    }
  }
  return { content, reasoning, toolCalls, finishReason: stopReason };
}

async function streamChat({ provider, key, model, system, messages, tools, signal, onEvent }) {
  if (!provider) throw new Error('没有选择模型服务');
  if (!model) throw new Error('没有选择模型');
  if (provider.requiresKey && !key) {
    throw new Error(`请先在设置里填写 ${provider.name} 的 API Key`);
  }
  const handler = provider.type === 'anthropic' ? streamAnthropic : streamOpenAI;
  return handler(provider, key, model, system, messages, tools, signal, onEvent || (() => {}));
}

module.exports = {
  PROVIDER_PRESETS,
  presetById,
  normalizeBaseUrl,
  getProviderDefinitions,
  publicProviders,
  fetchModels,
  streamChat,
  providerError,
  truncateMiddle,
};
