'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const {
  ensureDir,
  isSubPath,
  writeTextAtomic,
  escapeRegExp,
} = require('./util');

const execAsync = promisify(exec);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'release',
  '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv', '.idea',
]);

function normalizeArgs(args) {
  if (!args) return {};
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args;
}

function resolveRealWorkspace(workspace) {
  if (!workspace) throw new Error('还没有选择工作区。请先在对话顶部选择一个文件夹。');
  const abs = path.resolve(workspace);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`工作区不存在或不是文件夹：${abs}`);
  }
  return fs.realpathSync(abs);
}

function resolveInside(workspace, input, { mustExist = false } = {}) {
  const realWorkspace = resolveRealWorkspace(workspace);
  const target = input ? path.resolve(realWorkspace, input) : realWorkspace;
  if (!isSubPath(realWorkspace, target)) {
    throw new Error(`路径越界：只能访问工作区 ${realWorkspace} 内的文件`);
  }
  if (fs.existsSync(target)) {
    const real = fs.realpathSync(target);
    if (!isSubPath(realWorkspace, real)) {
      throw new Error('路径通过符号链接指向工作区外部，已拒绝');
    }
    return real;
  }
  if (mustExist) throw new Error(`文件不存在：${input}`);
  // 新文件：逐级向上检查已存在的父目录，防止通过符号链接目录逃逸
  let parent = path.dirname(target);
  while (parent && parent !== path.dirname(parent)) {
    if (fs.existsSync(parent)) {
      const realParent = fs.realpathSync(parent);
      if (!isSubPath(realWorkspace, realParent)) {
        throw new Error('目标父目录通过符号链接指向工作区外部，已拒绝');
      }
      break;
    }
    parent = path.dirname(parent);
  }
  return target;
}

function relPath(workspace, full) {
  const rel = path.relative(path.resolve(workspace), full);
  return rel.split(path.sep).join('/') || '.';
}

function isBinaryBuffer(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

function readFileText(fullPath, maxBytes = 2 * 1024 * 1024) {
  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) throw new Error('目标不是文件');
  if (stat.size > maxBytes) {
    throw new Error(`文件大小 ${(stat.size / 1024 / 1024).toFixed(1)} MB，超过 2 MB 读取上限`);
  }
  const buf = fs.readFileSync(fullPath);
  if (isBinaryBuffer(buf)) throw new Error('这是二进制文件，无法按文本读取');
  return buf.toString('utf8');
}

function globToRegExp(glob, caseSensitive = false) {
  let g = String(glob || '').replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '^';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i += 1;
        if (g[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const close = g.indexOf('}', i);
      if (close > i) {
        const parts = g.slice(i + 1, close).split(',').map((p) => escapeRegExp(p));
        re += `(?:${parts.join('|')})`;
        i = close;
      } else {
        re += '\\{';
      }
    } else {
      re += escapeRegExp(c);
    }
  }
  re += '$';
  return new RegExp(re, caseSensitive ? '' : 'i');
}

function walkWorkspace(workspace, { maxFiles = 6000, maxDepth = 12 } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) break;
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        if (ent.name.startsWith('.') && ent.name !== '.env' && ent.name !== '.gitignore') continue;
        let stat = null;
        try {
          stat = fs.statSync(full);
        } catch {
          /* ignore */
        }
        out.push({ path: full, name: ent.name, size: stat ? stat.size : 0, mtime: stat ? stat.mtimeMs : 0 });
      }
    }
  };
  walk(path.resolve(workspace), 0);
  return out;
}

function lineCount(text) {
  if (!text) return 1;
  return text.split(/\r\n|\n|\r/).length;
}

function preview(text, max = 700) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}\n…（已截断）` : s;
}

function makeDefinitions({ allowCommands = false } = {}) {
  const defs = [
    {
      name: 'list_directory',
      description: 'List files and folders inside the workspace. Use "." for the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to the workspace. Default "."' },
          depth: { type: 'integer', description: 'Recursion depth, 1-3. Default 1.' },
        },
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the workspace. Returns content and line count. Use offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace' },
          offset: { type: 'integer', description: 'First line to read, 1-based. Default 1.' },
          limit: { type: 'integer', description: 'Maximum lines to read. Default 400, max 2000.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a text file inside the workspace. Parent folders are created automatically. Requires user approval unless auto-write is enabled.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace' },
          content: { type: 'string', description: 'Full UTF-8 content to write' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description: 'Replace an exact string in a text file inside the workspace. Prefer this over write_file for small changes. old_string must match exactly.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the workspace' },
          old_string: { type: 'string', description: 'Exact text to replace' },
          new_string: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'glob',
      description: 'Find files inside the workspace by glob pattern, for example "src/**/*.js" or "*.md". Returns relative paths sorted by modification time.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern' },
          path: { type: 'string', description: 'Base directory relative to workspace. Default "."' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'grep',
      description: 'Search text inside files under a directory. Returns file:line: text. Uses literal matching by default; set regex=true for regular expressions.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Text or regular expression to search' },
          path: { type: 'string', description: 'Directory to search, relative to workspace. Default "."' },
          include: { type: 'string', description: 'Only search files matching this glob, e.g. "*.js"' },
          regex: { type: 'boolean', description: 'Treat pattern as a regular expression. Default false.' },
          case_sensitive: { type: 'boolean', description: 'Case sensitive search. Default false.' },
        },
        required: ['pattern'],
      },
    },
  ];
  if (allowCommands) {
    defs.push({
      name: 'run_command',
      description: 'Run a shell command in the workspace. Requires explicit user approval. Use for builds, tests, git status, etc. Never use it to read files that can be read with read_file.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line to run' },
          cwd: { type: 'string', description: 'Working directory relative to workspace. Default workspace root.' },
          timeout_seconds: { type: 'integer', description: 'Timeout in seconds, default 120, max 300.' },
        },
        required: ['command'],
      },
    });
  }
  return defs;
}

function makeFileTools({ workspace, permissions = 'ask', allowCommands = false, confirm = async () => true, maxReadBytes = 2 * 1024 * 1024 }) {
  const effectiveWorkspace = workspace || '';
  const definitions = makeDefinitions({ allowCommands });

  async function assertWritable(meta) {
    if (permissions === 'readonly') {
      throw new Error('当前是只读模式，已阻止写入。请在对话顶部把文件权限改成“写入需确认”或“自动写入”。');
    }
    if (permissions === 'ask') {
      const ok = await confirm(meta);
      if (!ok) throw new Error('用户拒绝了这次操作');
    }
    return true;
  }

  async function execute(name, rawArgs) {
    const args = normalizeArgs(rawArgs);
    switch (name) {
      case 'list_directory': {
        const dir = resolveInside(effectiveWorkspace, args.path || '.', { mustExist: true });
        if (!fs.statSync(dir).isDirectory()) throw new Error('目标不是目录');
        const depth = Math.max(1, Math.min(3, Number(args.depth) || 1));
        const entries = [];
        const walk = (d, level) => {
          if (entries.length >= 500) return;
          let list = [];
          try {
            list = fs.readdirSync(d, { withFileTypes: true });
          } catch {
            return;
          }
          list.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
          for (const ent of list) {
            if (entries.length >= 500) break;
            if (ent.name === '.git' || ent.name === 'node_modules') continue;
            const full = path.join(d, ent.name);
            let stat = null;
            try {
              stat = fs.statSync(full);
            } catch {
              /* ignore */
            }
            entries.push({
              path: relPath(effectiveWorkspace, full) + (ent.isDirectory() ? '/' : ''),
              type: ent.isDirectory() ? 'dir' : 'file',
              size: ent.isFile() && stat ? stat.size : undefined,
            });
            if (ent.isDirectory() && !SKIP_DIRS.has(ent.name) && level + 1 < depth) walk(full, level + 1);
          }
        };
        walk(dir, 0);
        return JSON.stringify({
          path: relPath(effectiveWorkspace, dir),
          entries,
          truncated: entries.length >= 500,
        }, null, 2);
      }

      case 'read_file': {
        const full = resolveInside(effectiveWorkspace, args.path, { mustExist: true });
        const text = readFileText(full, maxReadBytes);
        const lines = text.split(/\r\n|\n|\r/);
        const total = lines.length;
        const offset = Math.max(1, Number(args.offset) || 1);
        const limit = Math.max(1, Math.min(2000, Number(args.limit) || 400));
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        return JSON.stringify({
          path: relPath(effectiveWorkspace, full),
          total_lines: total,
          start_line: offset,
          end_line: Math.min(total, offset + slice.length - 1),
          content: slice.join('\n'),
          truncated: offset - 1 + slice.length < total,
        }, null, 2);
      }

      case 'write_file': {
        if (typeof args.content !== 'string') throw new Error('content 必须是字符串');
        if (args.content.length > 5 * 1024 * 1024) throw new Error('单次写入不能超过 5 MB');
        const full = resolveInside(effectiveWorkspace, args.path);
        const exists = fs.existsSync(full);
        await assertWritable({
          kind: 'write',
          path: relPath(effectiveWorkspace, full),
          exists,
          bytes: Buffer.byteLength(args.content, 'utf8'),
          lines: lineCount(args.content),
          preview: preview(args.content),
        });
        ensureDir(path.dirname(full));
        writeTextAtomic(full, args.content);
        return JSON.stringify({
          ok: true,
          path: relPath(effectiveWorkspace, full),
          bytes: Buffer.byteLength(args.content, 'utf8'),
          lines: lineCount(args.content),
          action: exists ? 'overwritten' : 'created',
        }, null, 2);
      }

      case 'edit_file': {
        if (!args.old_string) throw new Error('old_string 不能为空');
        if (typeof args.new_string !== 'string') throw new Error('new_string 必须是字符串');
        const full = resolveInside(effectiveWorkspace, args.path, { mustExist: true });
        let text = readFileText(full, maxReadBytes);
        let oldString = args.old_string;
        let newString = args.new_string;
        let count = countOccurrences(text, oldString);
        if (count === 0 && text.includes('\r\n') && oldString.includes('\n')) {
          const altOld = oldString.replace(/\r?\n/g, '\r\n');
          const altNew = newString.replace(/\r?\n/g, '\r\n');
          const altCount = countOccurrences(text, altOld);
          if (altCount > 0) {
            oldString = altOld;
            newString = altNew;
            count = altCount;
          }
        }
        if (count === 0) throw new Error('没有找到 old_string。请先用 read_file 确认原文（注意空格与换行）。');
        if (count > 1 && !args.replace_all) {
          throw new Error(`old_string 在文件中出现了 ${count} 次。请提供更长的上下文，或设置 replace_all=true。`);
        }
        await assertWritable({
          kind: 'edit',
          path: relPath(effectiveWorkspace, full),
          occurrences: args.replace_all ? count : 1,
          oldPreview: preview(oldString, 500),
          newPreview: preview(newString, 500),
        });
        if (args.replace_all) {
          text = text.split(oldString).join(newString);
        } else {
          const idx = text.indexOf(oldString);
          text = text.slice(0, idx) + newString + text.slice(idx + oldString.length);
        }
        writeTextAtomic(full, text);
        return JSON.stringify({
          ok: true,
          path: relPath(effectiveWorkspace, full),
          replacements: args.replace_all ? count : 1,
          lines: lineCount(text),
        }, null, 2);
      }

      case 'glob': {
        if (!args.pattern) throw new Error('pattern 不能为空');
        const base = resolveInside(effectiveWorkspace, args.path || '.', { mustExist: true });
        const re = globToRegExp(args.pattern);
        const reAny = String(args.pattern).includes('/') ? null : globToRegExp(`**/${args.pattern}`);
        const files = walkWorkspace(base).filter((f) => {
          const rel = relPath(effectiveWorkspace, f.path);
          return re.test(rel) || (reAny && reAny.test(rel));
        });
        files.sort((a, b) => b.mtime - a.mtime);
        return JSON.stringify({
          pattern: args.pattern,
          matches: files.slice(0, 300).map((f) => ({
            path: relPath(effectiveWorkspace, f.path),
            size: f.size,
          })),
          total: files.length,
          truncated: files.length > 300,
        }, null, 2);
      }

      case 'grep': {
        if (!args.pattern) throw new Error('pattern 不能为空');
        const base = resolveInside(effectiveWorkspace, args.path || '.', { mustExist: true });
        let re;
        try {
          re = new RegExp(args.regex ? args.pattern : escapeRegExp(args.pattern), args.case_sensitive ? '' : 'i');
        } catch (err) {
          throw new Error(`正则表达式无效：${err.message}`);
        }
        const includeRe = args.include ? globToRegExp(args.include) : null;
        const files = walkWorkspace(base);
        const matches = [];
        for (const f of files) {
          if (matches.length >= 200) break;
          if (f.size > 2 * 1024 * 1024) continue;
          const rel = relPath(effectiveWorkspace, f.path);
          if (includeRe && !includeRe.test(rel) && !includeRe.test(f.name)) continue;
          let buf;
          try {
            buf = fs.readFileSync(f.path);
          } catch {
            continue;
          }
          if (isBinaryBuffer(buf)) continue;
          const text = buf.toString('utf8');
          const lines = text.split(/\r\n|\n|\r/);
          for (let i = 0; i < lines.length; i += 1) {
            if (matches.length >= 200) break;
            if (re.test(lines[i])) {
              matches.push({ path: rel, line: i + 1, text: lines[i].slice(0, 300) });
            }
          }
        }
        return JSON.stringify({
          pattern: args.pattern,
          matches,
          total: matches.length,
          truncated: matches.length >= 200,
        }, null, 2);
      }

      case 'run_command': {
        if (!allowCommands) throw new Error('命令执行未启用');
        const cwd = resolveInside(effectiveWorkspace, args.cwd || '.', { mustExist: true });
        if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd 不是目录');
        const timeout = Math.max(5, Math.min(300, Number(args.timeout_seconds) || 120)) * 1000;
        await assertWritable({
          kind: 'command',
          command: String(args.command || ''),
          cwd: relPath(effectiveWorkspace, cwd),
        });
        try {
          const { stdout, stderr } = await execAsync(String(args.command), {
            cwd,
            timeout,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
            encoding: 'utf8',
          });
          return JSON.stringify({
            ok: true,
            exit_code: 0,
            stdout: String(stdout || '').slice(0, 100000),
            stderr: String(stderr || '').slice(0, 30000),
          }, null, 2);
        } catch (err) {
          return JSON.stringify({
            ok: false,
            exit_code: typeof err.code === 'number' ? err.code : null,
            killed: Boolean(err.killed),
            timed_out: err.killed && err.signal === 'SIGTERM',
            stdout: String(err.stdout || '').slice(0, 100000),
            stderr: String(err.stderr || err.message || '').slice(0, 30000),
          }, null, 2);
        }
      }

      default:
        throw new Error(`未知工具：${name}`);
    }
  }

  return { definitions, execute };
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count += 1;
    idx += needle.length;
  }
  return count;
}

module.exports = {
  makeFileTools,
  makeDefinitions,
  resolveInside,
  resolveRealWorkspace,
  globToRegExp,
  readFileText,
};
