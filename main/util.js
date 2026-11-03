'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function pathExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function readText(file, maxBytes = 4 * 1024 * 1024) {
  const stat = fs.statSync(file);
  if (stat.size > maxBytes) {
    throw new Error(`文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），超过读取上限`);
  }
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) {
    throw new Error('这是一个二进制文件，无法按文本读取');
  }
  return buf.toString('utf8');
}

function readTextSafe(file, maxBytes = 4 * 1024 * 1024) {
  try {
    return readText(file, maxBytes);
  } catch {
    return null;
  }
}

function writeTextAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    // Windows 上目标被占用时 rename 可能失败，退化为直接写入
    fs.writeFileSync(file, content, 'utf8');
  }
}

function moveFileAtomic(src, dest) {
  ensureDir(path.dirname(dest));
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
      return;
    }
    if (fs.existsSync(dest)) {
      const ext = path.extname(dest);
      const base = dest.slice(0, dest.length - ext.length);
      let i = 2;
      let candidate = `${base}_${i}${ext}`;
      while (fs.existsSync(candidate)) {
        i += 1;
        candidate = `${base}_${i}${ext}`;
      }
      fs.renameSync(src, candidate);
      return;
    }
    throw err;
  }
}

function isSubPath(parent, child) {
  const p = path.resolve(parent).toLowerCase().replace(/[\\/]+$/, '');
  const c = path.resolve(child).toLowerCase().replace(/[\\/]+$/, '');
  return c === p || c.startsWith(p + path.sep) || c.startsWith(p + '/');
}

function assertInside(parent, child) {
  if (!isSubPath(parent, child)) {
    throw new Error(`路径越界：${child} 不在工作区 ${parent} 内`);
  }
  return path.resolve(child);
}

function humanAge(ms) {
  if (!ms || ms < 0) return '-';
  const sec = Math.floor(ms / 1000);
  if (sec < 10) return '刚刚';
  if (sec < 60) return `${sec}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  return `${Math.floor(hr / 24)}天前`;
}

function formatDateTime(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatClock(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function fileStamp(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function uniqueId(dir, prefix = '') {
  const base = formatClock();
  if (!dir) return `${base}-01`;
  let i = 1;
  // 先找同分钟已有文件，避免重名
  for (; i < 100; i += 1) {
    const name = `${prefix}${base}-${String(i).padStart(2, '0')}.md`;
    if (!fs.existsSync(path.join(dir, name))) return `${base}-${String(i).padStart(2, '0')}`;
  }
  return `${base}-${String(Date.now()).slice(-3)}`;
}

function listFiles(dir, { recursive = false, limit = 500 } = {}) {
  const out = [];
  if (!pathExists(dir)) return out;
  const walk = (d, depth) => {
    if (out.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= limit) break;
      if (ent.name.startsWith('.') || ent.name.startsWith('~$')) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (recursive && depth < 8) walk(full, depth + 1);
      } else if (ent.isFile()) {
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
  walk(dir, 0);
  return out;
}

function countPending(dir) {
  if (!pathExists(dir)) return 0;
  let n = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (ent.name.startsWith('.') || ent.name.startsWith('~$')) continue;
    if (/\.(tmp|part|crdownload|swp|lock)$/i.test(ent.name)) continue;
    n += 1;
  }
  return n;
}

function listPending(dir) {
  if (!pathExists(dir)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.startsWith('~$') && !/\.(tmp|part|crdownload|swp|lock)$/i.test(e.name))
    .map((e) => {
      const full = path.join(dir, e.name);
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch {
        /* ignore */
      }
      return { name: e.name, path: full, size: stat ? stat.size : 0, mtime: stat ? stat.mtimeMs : 0 };
    })
    .sort((a, b) => a.mtime - b.mtime);
}

function latestMtime(paths) {
  let newest = 0;
  for (const p of paths) {
    if (!p || !pathExists(p)) continue;
    let stat = null;
    try {
      stat = fs.statSync(p);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      newest = Math.max(newest, stat.mtimeMs);
    } else if (stat.isDirectory()) {
      const files = listFiles(p, { recursive: true, limit: 3000 });
      for (const f of files) newest = Math.max(newest, f.mtime);
    }
  }
  return newest;
}

function parseKeyValue(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncateMiddle(s, max = 120) {
  const str = String(s || '');
  if (str.length <= max) return str;
  return `${str.slice(0, Math.floor(max / 2))}…${str.slice(-Math.floor(max / 2))}`;
}

function safeJsonParse(s, fallback = null) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHome() {
  return os.homedir();
}

module.exports = {
  ensureDir,
  pathExists,
  readText,
  readTextSafe,
  writeTextAtomic,
  moveFileAtomic,
  isSubPath,
  assertInside,
  humanAge,
  formatDateTime,
  formatClock,
  fileStamp,
  uniqueId,
  listFiles,
  countPending,
  listPending,
  latestMtime,
  parseKeyValue,
  escapeRegExp,
  truncateMiddle,
  safeJsonParse,
  sleep,
  getHome,
};
