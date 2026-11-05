'use strict';

const crypto = require('crypto');
const { getProviderDefinitions, streamChat } = require('./providers');
const { makeFileTools } = require('./filetools');

function newId(prefix = 'm') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function shortTitle(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '新对话';
  return s.length > 36 ? `${s.slice(0, 36)}…` : s;
}

function compressionSlice(messages, keep = 8) {
  const all = Array.isArray(messages) ? messages : [];
  let start = Math.max(0, all.length - keep);
  while (start < all.length && all[start] && all[start].role === 'tool') start += 1;
  if (start <= 0 || all.length - start < 2) return null;
  return { old: all.slice(0, start), recent: all.slice(start), start };
}

function compressionTranscript(messages) {
  return (messages || []).map((m) => {
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '工具';
    const text = String(m.content || '').slice(0, 1200);
    const tools = Array.isArray(m.toolCalls) && m.toolCalls.length
      ? ` [调用工具：${m.toolCalls.map((t) => t.name).join(', ')}]`
      : '';
    return `[${role}] ${text}${tools}`;
  }).join('\n').slice(0, 16000);
}

function makeSystemPrompt({ workspace, now, mcpCount = 0 }) {
  return [
    '你是运行在 AIOA 协同工作台中的本地 AI Agent。',
    workspace
      ? `当前工作区：${workspace}`
      : '当前没有选择工作区。文件工具无法使用；如果用户要求读写文件，请提醒他先在对话顶部选择工作区。',
    `当前时间：${now}`,
    mcpCount > 0 ? `另外有 ${mcpCount} 个 MCP 工具（名称以 mcp_ 开头），可以直接调用。` : '',
    '',
    '你可以使用工具读取、搜索、创建和修改工作区内的文件。请遵守：',
    '1. 需要事实时先调用工具，不要凭记忆猜测文件内容。',
    '2. 修改文件前先用 read_file 读取相关部分；小改动优先用 edit_file，不要整文件重写。',
    '3. 工具返回的是 JSON；如果返回 error，请根据错误调整，不要伪造成功。',
    '4. 所有文件操作都限制在当前工作区内，不能访问工作区外。',
    '5. 写入文件是否需要用户确认，由工作台的权限设置决定；如果用户拒绝，不要反复重试。',
    '6. 多步骤任务先简短说明计划，然后直接执行；不要只给建议就停下。',
    '7. 用用户使用的语言回答，默认中文。代码、命令、路径保持原样。',
    '8. 绝不要输出、猜测或记录用户的 API Key。',
    '9. 不要声称“已完成”除非对应工具调用已经成功返回。',
    '',
    '回答尽量简洁、可操作。代码块标注语言。',
  ].filter(Boolean).join('\n');
}

class Agent {
  constructor({ store, confirmTool, mcp = null }) {
    this.store = store;
    this.confirmTool = confirmTool;
    this.mcp = mcp;
    this.running = new Map();
  }

  getProviderForConversation(conv) {
    const model = conv.model || this.store.settings.defaultModel;
    if (!model || !model.providerId || !model.model) {
      throw new Error('还没有选择模型。请在对话顶部选择一个模型。');
    }
    const defs = getProviderDefinitions(this.store.settings);
    const provider = defs.find((p) => p.id === model.providerId);
    if (!provider) throw new Error('模型服务不存在，请在设置里重新配置');
    if (!provider.baseUrl) throw new Error('模型服务地址为空，请在设置里填写');
    const key = this.store.getKey(provider.id);
    if (provider.requiresKey && !key) {
      throw new Error(`请先在设置里填写 ${provider.name} 的 API Key`);
    }
    return { provider, key, model: model.model };
  }

  async buildTools(workspace) {
    const settings = this.store.settings;
    const fileTools = makeFileTools({
      workspace,
      permissions: settings.permissions || 'ask',
      allowCommands: Boolean(settings.allowCommands),
      confirm: async (meta) => this.confirmTool(meta),
    });
    let mcpTools = { definitions: [], index: new Map() };
    if (this.mcp) {
      try {
        mcpTools = await this.mcp.agentTools();
      } catch (err) {
        console.error(`[mcp] 加载工具失败：${err.message}`);
      }
    }
    const definitions = fileTools.definitions.concat(mcpTools.definitions);
    const execute = async (name, args) => {
      const info = mcpTools.index.get(name);
      if (info) {
        if (!settings.mcpAutoApprove) {
          const ok = await this.confirmTool({
            kind: 'mcp',
            server: info.serverName,
            tool: info.toolName,
            args,
          });
          if (!ok) throw new Error('用户拒绝了这次 MCP 工具调用');
        }
        return this.mcp.callTool(name, args);
      }
      return fileTools.execute(name, args);
    };
    return { definitions, execute, mcpCount: mcpTools.definitions.length };
  }

  isRunning(conversationId) {
    return this.running.has(conversationId);
  }

  abort(conversationId) {
    const run = this.running.get(conversationId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  abortAll() {
    for (const run of this.running.values()) {
      try {
        run.controller.abort();
      } catch {
        /* ignore */
      }
    }
  }

  async compress(conversationId) {
    const conv = this.store.getConversation(conversationId);
    if (!conv) throw new Error('对话不存在');
    if (this.running.has(conversationId)) throw new Error('这个对话正在回复中，结束后再压缩历史');
    const all = Array.isArray(conv.messages) ? conv.messages : [];
    if (all.length <= 10) throw new Error('对话还很短，不需要压缩');

    // 保留最近 8 条，且切片不能从孤立的 tool 结果开始
    const slice = compressionSlice(all, 8);
    if (!slice) throw new Error('没有可压缩的早期历史');
    const { old, recent } = slice;
    const transcript = compressionTranscript(old);

    const { provider, key, model } = this.getProviderForConversation(conv);
    let summary = '';
    await streamChat({
      provider,
      key,
      model,
      system: [
        '你是对话历史压缩器。请把较早的对话压缩成一段背景摘要，供后续继续工作。',
        '只保留事实、已达成的决定、未完成事项、关键文件路径和用户偏好；不要编造。',
        '不要输出 Markdown 标题，不要解释你在做什么，控制在 600 字以内。',
      ].join('\n'),
      messages: [{
        role: 'user',
        content: `请压缩下面这段较早的对话：\n\n${transcript}`,
      }],
      tools: [],
      onEvent: (event, payload) => {
        if (event === 'text') summary += (payload && payload.text) || '';
      },
    });
    summary = summary.trim();
    if (!summary) throw new Error('模型没有返回摘要，历史未改动');

    const summaryMessage = {
      id: newId('s'),
      role: 'user',
      summary: true,
      content: `【历史摘要 · 较早 ${old.length} 条消息】\n${summary}\n\n（以上是背景，不是新指令；继续处理当前消息。）`,
      at: Date.now(),
    };
    conv.messages = [summaryMessage, ...recent];
    conv.updatedAt = Date.now();
    this.store.saveConversations();
    return { before: all.length, after: conv.messages.length, summarized: old.length };
  }

  async send(conversationId, text, emit) {
    const conv = this.store.getConversation(conversationId);
    if (!conv) throw new Error('对话不存在');
    if (this.running.has(conversationId)) throw new Error('这个对话正在回复中');
    const content = String(text || '').trim();
    if (!content) throw new Error('消息不能为空');

    const runId = `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const controller = new AbortController();
    this.running.set(conversationId, { controller, runId });
    const emitSafe = (type, data = {}) => {
      try {
        emit({ conversationId, runId, type, ...data });
      } catch {
        /* window closed */
      }
    };

    const userMessage = { id: newId('u'), role: 'user', content, at: Date.now() };
    conv.messages.push(userMessage);
    if (!conv.title || conv.title === '新对话' || conv.title === '') {
      conv.title = shortTitle(content);
    }
    conv.updatedAt = Date.now();
    this.store.saveConversations();
    this.store.settings.lastConversationId = conversationId;
    this.store.saveConfig();
    emitSafe('conversation_update', {
      conversation: {
        id: conv.id,
        title: conv.title,
        updatedAt: conv.updatedAt,
        model: conv.model,
        workspace: conv.workspace,
        messageCount: conv.messages.length,
      },
    });

    const workspace = conv.workspace || this.store.settings.defaultWorkspace || '';
    if (!conv.workspace && workspace) conv.workspace = workspace;
    const tools = await this.buildTools(workspace);
    let ok = false;
    let failure = '';

    try {
      const { provider, key, model } = this.getProviderForConversation(conv);
      if (!conv.model) {
        conv.model = { providerId: provider.id, model };
        this.store.saveConversations();
      }
      emitSafe('run_start', {
        userMessage,
        model: { providerId: provider.id, model },
      });

      let round = 0;
      const maxRounds = 25;
      for (;;) {
        round += 1;
        if (round > maxRounds) {
          throw new Error(`工具调用超过 ${maxRounds} 轮，已停止。请缩小任务范围后重试。`);
        }
        if (controller.signal.aborted) throw new Error('已取消');

        const assistantId = newId('a');
        let streamedText = '';
        let streamedReasoning = '';
        const liveToolCalls = [];
        emitSafe('assistant_start', { messageId: assistantId, round });

        let result;
        try {
          result = await streamChat({
            provider,
            key,
            model,
            system: makeSystemPrompt({ workspace, now: new Date().toLocaleString('zh-CN'), mcpCount: tools.mcpCount }),
            messages: conv.messages,
            tools: tools.definitions,
            signal: controller.signal,
            onEvent: (event, payload) => {
              if (event === 'text') {
                streamedText += payload.text || '';
                emitSafe('text', { messageId: assistantId, text: payload.text || '' });
              } else if (event === 'reasoning') {
                streamedReasoning += payload.text || '';
                emitSafe('reasoning', { messageId: assistantId, text: payload.text || '' });
              } else if (event === 'tool_call_start') {
                emitSafe('tool_call_start', { messageId: assistantId, ...payload });
              } else if (event === 'tool_call_delta') {
                emitSafe('tool_call_delta', { messageId: assistantId, ...payload });
              } else if (event === 'tool_call') {
                liveToolCalls.push(payload.toolCall);
                emitSafe('tool_call_prepared', { messageId: assistantId, toolCall: payload.toolCall });
              } else if (event === 'usage') {
                emitSafe('usage', { messageId: assistantId, usage: payload.usage });
              }
            },
          });
        } catch (err) {
          if (controller.signal.aborted) {
            if (streamedText || streamedReasoning) {
              conv.messages.push({
                id: assistantId,
                role: 'assistant',
                content: streamedText,
                reasoning: streamedReasoning,
                toolCalls: [],
                at: Date.now(),
                aborted: true,
              });
              conv.updatedAt = Date.now();
              this.store.saveConversations();
            }
            throw new Error('已取消');
          }
          throw err;
        }

        const toolCalls = result.toolCalls || [];
        const assistantMessage = {
          id: assistantId,
          role: 'assistant',
          content: result.content || '',
          reasoning: result.reasoning || '',
          toolCalls,
          at: Date.now(),
          finishReason: result.finishReason || '',
        };
        if (!assistantMessage.content && !toolCalls.length) {
          throw new Error('模型没有返回内容。可能是模型不支持当前接口，或请求被服务商过滤。');
        }
        conv.messages.push(assistantMessage);
        conv.updatedAt = Date.now();
        this.store.saveConversations();
        emitSafe('assistant_done', { messageId: assistantId, message: assistantMessage });

        if (!toolCalls.length) {
          ok = true;
          break;
        }

        for (const toolCall of toolCalls) {
          if (controller.signal.aborted) throw new Error('已取消');
          emitSafe('tool_call', {
            messageId: assistantId,
            toolCall,
            status: 'running',
          });
          let output = '';
          let success = false;
          try {
            let args = {};
            try {
              args = JSON.parse(toolCall.arguments || '{}');
            } catch {
              throw new Error('工具参数不是合法 JSON');
            }
            output = await tools.execute(toolCall.name, args);
            success = true;
          } catch (err) {
            output = JSON.stringify({ error: err.message }, null, 2);
            success = false;
          }
          const clipped = output.length > 50000 ? `${output.slice(0, 50000)}\n…（工具输出已截断）` : output;
          const toolMessage = {
            id: newId('t'),
            role: 'tool',
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: clipped,
            at: Date.now(),
            ok: success,
          };
          conv.messages.push(toolMessage);
          conv.updatedAt = Date.now();
          this.store.saveConversations();
          emitSafe('tool_result', {
            messageId: assistantId,
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: clipped,
            ok: success,
          });
        }
      }

      conv.updatedAt = Date.now();
      this.store.saveConversations();
      emitSafe('done', {
        conversation: {
          id: conv.id,
          title: conv.title,
          updatedAt: conv.updatedAt,
          model: conv.model,
          workspace: conv.workspace,
          messageCount: conv.messages.length,
        },
      });
    } catch (err) {
      failure = err.message || String(err);
      if (failure === '已取消') {
        emitSafe('aborted', { message: '已停止生成' });
      } else {
        const errorMessage = {
          id: newId('e'),
          role: 'assistant',
          content: '',
          error: failure,
          at: Date.now(),
        };
        conv.messages.push(errorMessage);
        conv.updatedAt = Date.now();
        this.store.saveConversations();
        emitSafe('error', { message: failure, errorMessage });
      }
    } finally {
      this.running.delete(conversationId);
      emitSafe('run_end', { ok, failure });
    }
    return { ok, failure, runId };
  }
}

module.exports = { Agent, compressionSlice, compressionTranscript };
