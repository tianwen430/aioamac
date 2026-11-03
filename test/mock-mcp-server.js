#!/usr/bin/env node
'use strict';

/**
 * 测试用的最小 MCP stdio 服务：不依赖任何第三方包。
 * 支持 initialize / tools/list / tools/call(echo, wait_for_files)。
 */
const readline = require('readline');

const tools = [
  {
    name: 'echo',
    description: '回显文本',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'wait_for_files',
    description: '测试用取件',
    inputSchema: {
      type: 'object',
      properties: {
        folder_paths: { type: 'array', items: { type: 'string' } },
        timeout_seconds: { type: 'integer' },
        settle_seconds: { type: 'number' },
      },
      required: ['folder_paths'],
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const method = message.method;
  if (method === 'initialize') {
    respond(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-mcp', version: '1.0.0' },
    });
    return;
  }
  if (method === 'tools/list') {
    respond(message.id, { tools });
    return;
  }
  if (method === 'tools/call') {
    const params = message.params || {};
    const args = params.arguments || {};
    if (params.name === 'echo') {
      respond(message.id, { content: [{ type: 'text', text: `echo:${args.text || ''}` }] });
      return;
    }
    if (params.name === 'wait_for_files') {
      const folder = (args.folder_paths || [])[0] || '';
      respond(message.id, { content: [{ type: 'text', text: `BACKLOG: ${folder}/fake.md` }] });
      return;
    }
    respondError(message.id, -32601, `unknown tool: ${params.name}`);
    return;
  }
  if (message.id !== undefined) respondError(message.id, -32601, `unknown method: ${method}`);
});
