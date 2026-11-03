'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const { Store } = require('../main/store');
const { Agent } = require('../main/agent');

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function anthropicEvent(name, obj) {
  return `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
}

function startMockServer() {
  const state = { openaiCalls: 0, anthropicCalls: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        return;
      }
      if (req.url.endsWith('/chat/completions')) {
        state.openaiCalls += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const hasTool = (payload.messages || []).some((m) => m.role === 'tool');
        if (!hasTool) {
          res.write(sseChunk({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '' } }] }, finish_reason: null }] }));
          res.write(sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: 'hello.txt', content: 'hello from mock' }) } }] }, finish_reason: null }] }));
          res.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
        } else {
          res.write(sseChunk({ choices: [{ delta: { role: 'assistant', content: '文件已经创建。' }, finish_reason: null }] }));
          res.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (req.url.endsWith('/messages')) {
        state.anthropicCalls += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const hasToolResult = (payload.messages || []).some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
        res.write(anthropicEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 10 } } }));
        if (!hasToolResult) {
          res.write(anthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_file' } }));
          res.write(anthropicEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'claude.txt', content: 'hello from claude' }) } }));
          res.write(anthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
          res.write(anthropicEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }));
        } else {
          res.write(anthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
          res.write(anthropicEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude 也完成了。' } }));
          res.write(anthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
          res.write(anthropicEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
        }
        res.write(anthropicEvent('message_stop', { type: 'message_stop' }));
        res.end();
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, state });
    });
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aioa-agent-'));
  const userData = path.join(tmp, 'user');
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const store = new Store({ userDataDir: userData, safeStorage: { isEncryptionAvailable: () => false } });
  store.settings.permissions = 'auto';
  store.settings.allowCommands = false;
  const mock = await startMockServer();
  const base = `http://127.0.0.1:${mock.port}/v1`;

  const agent = new Agent({ store, confirmTool: async () => true });

  try {
    // OpenAI compatible + tool call
    const provider = store.addCustomProvider({
      id: 'mock-openai', name: 'Mock OpenAI', baseUrl: base, type: 'openai',
      requiresKey: false, models: ['mock-model'],
    });
    store.saveProviderOverride(provider.id, { baseUrl: base, models: ['mock-model'] });
    const conv = store.createConversation({
      model: { providerId: provider.id, model: 'mock-model' },
      workspace,
    });
    const events = [];
    const result = await agent.send(conv.id, '请在 hello.txt 里写入内容', (ev) => events.push(ev));
    assert(result.ok, `run should succeed: ${result.failure}`);
    assert(fs.existsSync(path.join(workspace, 'hello.txt')), 'file should be written');
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8'), 'hello from mock');
    assert(events.some((e) => e.type === 'tool_result' && e.ok), 'tool result event');
    assert(events.some((e) => e.type === 'done'), 'done event');
    const saved = store.getConversation(conv.id);
    assert(saved.messages.some((m) => m.role === 'assistant' && m.content.includes('文件已经创建')));
    assert(saved.messages.some((m) => m.role === 'tool' && m.name === 'write_file' && m.ok));
    console.log('[OK]   OpenAI compatible streaming + tool call');

    // Anthropic native + tool use
    const provider2 = store.addCustomProvider({
      id: 'mock-anthropic', name: 'Mock Claude', baseUrl: base, type: 'anthropic',
      requiresKey: false, models: ['claude-mock'],
    });
    store.saveProviderOverride(provider2.id, { baseUrl: base, models: ['claude-mock'] });
    const conv2 = store.createConversation({
      model: { providerId: provider2.id, model: 'claude-mock' },
      workspace,
    });
    const events2 = [];
    const result2 = await agent.send(conv2.id, '请用 Claude 写 claude.txt', (ev) => events2.push(ev));
    assert(result2.ok, `anthropic run should succeed: ${result2.failure}`);
    assert(fs.existsSync(path.join(workspace, 'claude.txt')), 'claude file should be written');
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'claude.txt'), 'utf8'), 'hello from claude');
    assert(events2.some((e) => e.type === 'tool_result' && e.ok), 'anthropic tool result');
    console.log('[OK]   Anthropic native streaming + tool use');
    console.log('\nagent tests passed');
  } catch (err) {
    console.error('[FAIL]');
    console.error(err.stack || err);
    process.exitCode = 1;
  } finally {
    mock.server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})();
