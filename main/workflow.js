'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ensureDir,
  pathExists,
  readTextSafe,
  writeTextAtomic,
  moveFileAtomic,
  humanAge,
  formatDateTime,
  uniqueId,
  listFiles,
  countPending,
  listPending,
  latestMtime,
  parseKeyValue,
  isSubPath,
  truncateMiddle,
} = require('./util');
const {
  loadConfig,
  configStations,
  buildProjectTree,
  buildCustomConfig,
  generateProtocol,
  generateRoleCard,
  generateConfigCard,
  transform01NoAdvisor,
  transform02NoTech,
  transform02NoArt,
  transform04NoTech,
  validateConfig,
} = require('./workflow-config');
const { validateDutyPackage } = require('./normalize');

const STATIONS = [
  {
    num: '01', folder: '01_总控', label: '01 总经理', card: '01_总控.md',
    short: '唯一人类接口 · 出策划 · 分配版本 · 最终裁决',
    listens: ['收件箱', '来自实施层'], activity: ['已处理', '发件箱'],
    model: '强模型', order: 1,
  },
  {
    num: '02', folder: '02_实施布置', label: '02 总监', card: '02_实施布置.md',
    short: '把策划切成可验收任务单 · 核准成果',
    listens: ['收件箱', '成果接收'], activity: ['已处理', '发件箱'],
    model: '强模型', order: 2,
  },
  {
    num: '03', folder: '03_高级代码', label: '03 部门经理', card: '03_高级代码.md',
    short: '技术裁决 · 判断升级方向 · 不写代码',
    listens: ['收件箱'], activity: ['已处理', '技术决策库'],
    model: '中等', order: 5,
  },
  {
    num: '04', folder: '04_代码员工', label: '04 员工', card: '04_代码员工.md',
    short: '按任务单写代码 · 自测 · 提交测试',
    listens: ['收件箱'], activity: ['已处理', '代码产出'],
    model: '强模型', order: 3,
  },
  {
    num: '05', folder: '05_Debug', label: '05 质检', card: '05_Debug.md',
    short: '跑验收标准 · 自动修复 ≤2 轮 · 沉淀经验',
    listens: ['收件箱'], activity: ['已处理', '测试报告', '成果移交'],
    model: '中等', order: 4,
  },
  {
    num: '06', folder: '06_美工', label: '06 设计', card: '06_美工.md',
    short: '视觉生产 · 效果说明 · 通知代码接入',
    listens: ['收件箱'], activity: ['已处理', '美工产出'],
    model: '看需求', order: 6,
  },
  {
    num: '07', folder: '07_部署', label: '07 运维', card: '07_部署.md',
    short: '只部署总控放行的版本 · 回执或报阻塞',
    listens: ['收件箱'], activity: ['已处理', '部署报告'],
    model: '小模型够用', order: 7,
  },
  {
    num: '08', folder: '08_智囊', label: '08 顾问', card: '08_智囊.md',
    short: '可选 · 独立审校策划稿 · 只挑错不给方案',
    listens: ['收件箱'], activity: ['已处理', '审校库'],
    model: '与总控不同模型', order: 8,
  },
];

const TREE = [
  '00_人类总控/汇报终端',
  '01_总控/收件箱', '01_总控/已处理', '01_总控/发件箱',
  '01_总控/来自实施层', '01_总控/成果区/_待发布',
  '02_实施布置/收件箱', '02_实施布置/已处理', '02_实施布置/发件箱', '02_实施布置/成果接收',
  '03_高级代码/收件箱', '03_高级代码/已处理', '03_高级代码/技术决策库',
  '04_代码员工/收件箱', '04_代码员工/已处理', '04_代码员工/代码产出',
  '05_Debug/收件箱', '05_Debug/已处理', '05_Debug/测试报告', '05_Debug/成果移交', '05_Debug/经验库',
  '06_美工/收件箱', '06_美工/已处理', '06_美工/美工产出',
  '07_部署/收件箱', '07_部署/已处理', '07_部署/部署报告',
  '08_智囊/收件箱', '08_智囊/已处理', '08_智囊/审校库',
];

const READY_DIRS = STATIONS.map((s) => s.folder);
const MESSAGE_PREFIXES = [
  '需求', '审校', '审校意见', '策划', '决策', '请示', '汇报', '部署回执',
  '部署阻塞', '待命', '就绪', '任务', '问题', '技术裁决', '架构升级', '适配',
  '待测试', '验收通过', '交付', '发布', '修复确认', '待人类决策', '阻塞',
];

function nowText() {
  return formatDateTime();
}

class Workflow {
  constructor({ kitRoot, defaultRoot }) {
    this.kitRoot = kitRoot;
    this.defaultRoot = defaultRoot || this.guessDefaultRoot();
    this.pythonCache = null;
  }

  configFor(controlRoot) {
    return loadConfig(controlRoot);
  }

  stationsFor(controlRoot) {
    const config = loadConfig(controlRoot);
    return config ? configStations(config) : STATIONS;
  }

  stationByNum(controlRoot, num) {
    return this.stationsFor(controlRoot).find((s) => s.num === String(num)) || null;
  }

  controlRootForProject(projectRoot) {
    const parent = path.dirname(path.resolve(projectRoot || ''));
    if (path.basename(parent) !== 'projects') return '';
    return path.dirname(parent);
  }

  guessDefaultRoot() {
    if (process.platform !== 'win32') return path.join(require('os').homedir(), 'ai-workflow');
    if (fs.existsSync('D:\\')) return 'D:\\ai-workflow';
    return 'C:\\ai-workflow';
  }

  normalizeRoot(input) {
    const raw = String(input || '').trim().replace(/^["']|["']$/g, '');
    if (!raw) throw new Error('请填写控制层根目录');
    if (!path.isAbsolute(raw)) {
      throw new Error(process.platform === 'win32'
        ? '控制层根目录必须是绝对路径，例如 D:\\ai-workflow'
        : '控制层根目录必须是绝对路径，例如 /Users/you/ai-workflow');
    }
    return path.resolve(raw);
  }

  parsePointer(controlRoot) {
    const file = path.join(controlRoot, '_ACTIVE_PROJECT.md');
    if (!pathExists(file)) return null;
    const text = readTextSafe(file) || '';
    const kv = parseKeyValue(text);
    const project = kv.project || '';
    let root = kv.root || '';
    if (root && !path.isAbsolute(root)) root = path.resolve(controlRoot, root);
    let valid = false;
    try {
      valid = Boolean(project && root && pathExists(root) && fs.statSync(root).isDirectory());
    } catch {
      valid = false;
    }
    return {
      file,
      project,
      root: root || '',
      status: (kv.status || 'UNKNOWN').toUpperCase(),
      updated: kv.updated || '',
      valid,
      text,
    };
  }

  writePointer(controlRoot, project, projectRoot, status = 'ACTIVE') {
    const text = `# 当前项目指针（唯一入口，只有人类改这个文件）\n\n`
      + `project: ${project}\n`
      + `root: ${projectRoot}\n`
      + `status: ${status}\n`
      + `updated: ${nowText()}\n\n`
      + `## 用法\n\n`
      + `- 切项目：改上面 4 行，所有员工下一轮自动跟过去。\n`
      + `- 新建项目：使用 AIOA 工作台的「新建项目」。\n`
      + `- 暂停全部：把 \`_GLOBAL_STATUS.md\` 改成 \`PAUSED\`。\n`;
    writeTextAtomic(path.join(controlRoot, '_ACTIVE_PROJECT.md'), text);
  }

  ensureProjectTree(projectRoot, controlRoot = '') {
    const root = controlRoot || this.controlRootForProject(projectRoot);
    const config = root ? loadConfig(root) : null;
    const tree = config ? buildProjectTree(config) : TREE;
    const readyDirs = config ? configStations(config).map((s) => s.folder) : READY_DIRS;
    for (const rel of tree) ensureDir(path.join(projectRoot, rel));
    ensureDir(path.join(projectRoot, '_locks'));
    const gs = path.join(projectRoot, '01_总控', '发件箱', '_GLOBAL_STATUS.md');
    if (!pathExists(gs)) writeTextAtomic(gs, 'status: ACTIVE\n');
    const ver = path.join(projectRoot, '01_总控', '发件箱', '_VERSION.md');
    if (!pathExists(ver)) writeTextAtomic(ver, 'version: 0\n');
    for (const dir of readyDirs) {
      const f = path.join(projectRoot, dir, '_READY.md');
      if (!pathExists(f)) writeTextAtomic(f, '# 就绪台账\n');
    }
    const guide = path.join(projectRoot, '02_实施布置', '设计总纲.md');
    if (!pathExists(guide)) {
      writeTextAtomic(guide, '# 设计总纲（占位，待实施布置补充）\n\n'
        + '## 技术栈\n待补充\n\n## 模块划分\n待补充\n\n'
        + '## 接口约定\n待补充\n\n## 验收基线\n待补充\n');
    }
  }

  writeProjectProfile(projectRoot, data = {}) {
    const existingPath = path.join(projectRoot, '_PROJECT.md');
    let existing = readTextSafe(existingPath) || '';
    if (!existing) {
      existing = `# 项目档案（每个项目一份，员工启动时读取）\n\n`
        + `name: ${path.basename(projectRoot)}\n`
        + `title: 待补充\n`
        + `code_root: none\n`
        + `deploy_target: 待定\n`
        + `baseline: none\n`
        + `created: ${formatDateTime().slice(0, 10)}\n\n`
        + `## 说明\n\n`
        + `- \`code_root\` = 代码实际所在地。既有项目请填真实源码目录，员工一律在它下面作业。\n`
        + '- `code_root: none` 表示纯新建，代码写 `04_代码员工/代码产出/{ID}/`。\n'
        + `- \`baseline\` = 需求与验收的权威依据文件（放项目根）。\n`;
    }
    const fields = {
      title: data.title,
      code_root: data.codeRoot,
      deploy_target: data.deployTarget,
      baseline: data.baseline,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      const val = String(value).trim();
      const re = new RegExp(`^${key}:.*$`, 'm');
      if (re.test(existing)) {
        existing = existing.replace(re, `${key}: ${val}`);
      } else {
        existing = existing.replace(/\n## 说明/, `\n${key}: ${val}\n\n## 说明`);
      }
    }
    writeTextAtomic(existingPath, existing);
    return existing;
  }

  readProjectProfile(projectRoot) {
    const text = readTextSafe(path.join(projectRoot, '_PROJECT.md')) || '';
    const kv = parseKeyValue(text);
    return {
      raw: text,
      name: kv.name || path.basename(projectRoot),
      title: kv.title || '',
      code_root: kv.code_root || '',
      deploy_target: kv.deploy_target || '',
      baseline: kv.baseline || '',
      created: kv.created || '',
    };
  }

  createProject({ controlRoot, name, title, codeRoot, deployTarget, baseline, switchTo = true }) {
    const root = this.normalizeRoot(controlRoot);
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('请填写项目名');
    if (/[\\/:*?"<>|]/.test(cleanName)) throw new Error('项目名不能包含 \\ / : * ? " < > |');
    const projectRoot = path.join(root, 'projects', cleanName);
    this.ensureProjectTree(projectRoot, root);
    const profilePath = path.join(projectRoot, '_PROJECT.md');
    if (!pathExists(profilePath)) {
      this.writeProjectProfile(projectRoot, {
        title: title || '待补充',
        codeRoot: codeRoot || 'none',
        deployTarget: deployTarget || '待定',
        baseline: baseline || 'none',
      });
    } else if (title || codeRoot || deployTarget || baseline) {
      this.writeProjectProfile(projectRoot, {
        title: title || undefined,
        codeRoot: codeRoot || undefined,
        deployTarget: deployTarget || undefined,
        baseline: baseline || undefined,
      });
    }
    if (switchTo) this.writePointer(root, cleanName, projectRoot, 'ACTIVE');
    return { project: cleanName, root: projectRoot };
  }

  switchProject(controlRoot, name) {
    const root = this.normalizeRoot(controlRoot);
    const projectRoot = path.join(root, 'projects', name);
    if (!pathExists(projectRoot)) throw new Error(`项目不存在：${projectRoot}`);
    this.writePointer(root, name, projectRoot, 'ACTIVE');
    return { project: name, root: projectRoot };
  }

  listProjects(controlRoot) {
    if (!controlRoot) return [];
    const dir = path.join(controlRoot, 'projects');
    if (!pathExists(dir)) return [];
    const pointer = this.parsePointer(controlRoot);
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const projectRoot = path.join(dir, e.name);
        const profile = this.readProjectProfile(projectRoot);
        return {
          name: e.name,
          path: projectRoot,
          title: profile.title,
          active: Boolean(pointer && pointer.project === e.name),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  detectPython() {
    if (this.pythonCache && Date.now() - this.pythonCache.at < 60 * 1000) return this.pythonCache.value;
    const candidates = process.platform === 'win32'
      ? [
          { cmd: 'python', args: ['-c', 'import sys;print(sys.executable);print(sys.version.split()[0])'] },
          { cmd: 'py', args: ['-3', '-c', 'import sys;print(sys.executable);print(sys.version.split()[0])'] },
        ]
      : [
          { cmd: 'python3', args: ['-c', 'import sys;print(sys.executable);print(sys.version.split()[0])'] },
          { cmd: 'python', args: ['-c', 'import sys;print(sys.executable);print(sys.version.split()[0])'] },
        ];
    let result = { found: false, command: 'python', executable: '', version: '', hasDeps: false };
    for (const c of candidates) {
      try {
        const r = spawnSync(c.cmd, c.args, { encoding: 'utf8', windowsHide: true, timeout: 8000 });
        if (r.status === 0 && r.stdout) {
          const lines = r.stdout.trim().split(/\r?\n/);
          result = {
            found: true,
            command: c.cmd === 'py' ? 'py -3' : c.cmd,
            executable: lines[0] || '',
            version: lines[1] || '',
            hasDeps: false,
          };
          break;
        }
      } catch {
        /* try next */
      }
    }
    if (result.found && result.executable) {
      try {
        const r = spawnSync(result.executable, ['-c', 'import mcp, watchdog; print("ok")'], {
          encoding: 'utf8', windowsHide: true, timeout: 10000,
        });
        result.hasDeps = r.status === 0;
      } catch {
        result.hasDeps = false;
      }
    }
    this.pythonCache = { at: Date.now(), value: result };
    return result;
  }

  copyTextFile(src, dest, root, { force = false, replaceRoot = true } = {}) {
    let text = fs.readFileSync(src, 'utf8');
    if (replaceRoot) text = text.split('{{ROOT}}').join(root);
    text = this.adaptPaths(text);
    if (pathExists(dest) && !force) {
      const old = readTextSafe(dest) || '';
      if (!old.includes('{{ROOT}}')) return 'skip';
    }
    writeTextAtomic(dest, text);
    return 'write';
  }

  adaptPaths(text) {
    if (process.platform === 'win32') return text;
    // 角色卡/协议中的路径写成 `{PROJECT_ROOT}\\目录\\文件`，在 macOS/Linux 上转成 /
    return String(text).replace(
      /((?:\{PROJECT_ROOT\}|\{ROOT\}|[A-Za-z]:))((?:\\\\[^\s"'`，。；、)）\]]+)+)/g,
      (_, prefix, tail) => prefix + tail.replace(/\\\\/g, '/')
    );
  }

  writeUnixHelpers(root, python) {
    const py = python && python.found && python.executable ? python.executable : 'python3';
    const scripts = [
      ['开机检查.command', `"${py}" tools/lock.py clear\n"${py}" tools/pause.py status\n"${py}" tools/status.py\n`],
      ['恢复全部.command', `"${py}" tools/pause.py off\n`],
      ['暂停全部.command', `"${py}" tools/pause.py on\n`],
      ['状态.command', `"${py}" tools/status.py "$@"\n`],
    ];
    for (const [name, body] of scripts) {
      const file = path.join(root, name);
      writeTextAtomic(file, `#!/bin/bash\ncd "$(dirname "$0")"\n\n${body}\necho\necho "完成。按任意键关闭…"\nread -n 1 -s -r\n`);
      try {
        fs.chmodSync(file, 0o755);
      } catch {
        /* ignore */
      }
    }
  }

  copyBinaryFile(src, dest, { force = false } = {}) {
    if (pathExists(dest) && !force) return 'skip';
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
    return 'write';
  }

  writeMcpConfig(controlRoot, python) {
    const command = python && python.found && python.executable
      ? python.executable
      : (python && python.command === 'py -3' ? 'py' : 'python');
    const args = command === 'py'
      ? ['-3', '-u', path.join(controlRoot, 'file_watcher_mcp.py')]
      : ['-u', path.join(controlRoot, 'file_watcher_mcp.py')];
    const cfg = {
      mcpServers: {
        'file-watcher': {
          command,
          args,
          env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        },
      },
    };
    const out = path.join(controlRoot, '_mcp_config.json');
    writeTextAtomic(out, JSON.stringify(cfg, null, 2));
    return { path: out, config: cfg };
  }

  install({
    root: inputRoot, project = 'P001_第一个项目', projectTitle = '', codeRoot = '',
    deployTarget = '', baseline = '', force = false, customConfig = null, repair = false, onProgress = () => {},
  }) {
    const root = this.normalizeRoot(inputRoot);
    ensureDir(root);
    onProgress({ step: 'root', text: `准备控制层根目录：${root}` });

    const existingConfig = loadConfig(root);
    if (customConfig) {
      validateConfig(customConfig);
      if (existingConfig && !repair) throw new Error('这个目录已经是一套自定义工作流，不能重复创建');
      const markerFile = path.join(root, '_AIOA_WORKBENCH.json');
      if (pathExists(markerFile)) {
        let old = {};
        try {
          old = JSON.parse(readTextSafe(markerFile) || '{}');
        } catch {
          old = {};
        }
        if (old.mode !== 'custom') throw new Error('这个目录是标准工作流，自定义工作流请换一个根目录');
      }
    } else if (existingConfig) {
      throw new Error('这个目录属于自定义工作流，请从「自定义工作流」入口管理');
    }

    const kit = this.kitRoot;
    const protocolSrc = path.join(kit, '02_协议总纲.md');
    if (!fs.existsSync(protocolSrc)) throw new Error('安装资源缺失：02_协议总纲.md');
    const cardDir = path.join(kit, '02_角色卡');

    if (customConfig) {
      const protocolText = generateProtocol(customConfig, fs.readFileSync(protocolSrc, 'utf8'))
        .split('{{ROOT}}').join(root);
      writeTextAtomic(path.join(root, '00_协议总纲.md'), this.adaptPaths(protocolText));
      onProgress({ step: 'protocol', text: '自定义协议总纲已生成' });

      const stations = configStations(customConfig);
      for (const st of stations) {
        const dest = path.join(root, st.card);
        if (pathExists(dest) && !force) continue;
        let content = '';
        if (st.custom) {
          content = generateRoleCard(st, customConfig);
        } else {
          content = fs.readFileSync(path.join(cardDir, st.card), 'utf8');
          if (st.num === '01' && !customConfig.switches.advisorReview) content = transform01NoAdvisor(content);
          if (st.num === '02') {
            if (!customConfig.switches.techReview) content = transform02NoTech(content);
            content = transform02NoArt(content);
          }
          if (st.num === '04' && !customConfig.switches.techReview) content = transform04NoTech(content);
        }
        content = content.split('{{ROOT}}').join(root);
        writeTextAtomic(dest, this.adaptPaths(content));
      }
      writeTextAtomic(path.join(root, '_AIOA_WORKFLOW.json'), JSON.stringify(customConfig, null, 2));
      writeTextAtomic(path.join(root, '01_总控_配置态.md'), generateConfigCard(customConfig));
      onProgress({ step: 'cards', text: `${stations.length} 张角色卡已生成（自定义拓扑）` });
    } else {
      this.copyTextFile(protocolSrc, path.join(root, '00_协议总纲.md'), root, { force });
      onProgress({ step: 'protocol', text: '协议总纲已就绪' });

      const cards = fs.readdirSync(cardDir).filter((n) => n.endsWith('.md'));
      for (const name of cards) {
        this.copyTextFile(path.join(cardDir, name), path.join(root, name), root, { force });
      }
      onProgress({ step: 'cards', text: `${cards.length} 张角色卡已就绪` });
    }

    const toolDir = path.join(kit, '03_工具');
    ensureDir(path.join(root, 'tools'));
    const toolFiles = fs.readdirSync(toolDir, { withFileTypes: true });
    for (const ent of toolFiles) {
      if (!ent.isFile()) continue;
      const src = path.join(toolDir, ent.name);
      if (ent.name.endsWith('.py')) {
        if (ent.name === 'file_watcher_mcp.py') {
          this.copyTextFile(src, path.join(root, ent.name), root, { force });
        } else {
          this.copyTextFile(src, path.join(root, 'tools', ent.name), root, { force });
        }
      } else if (ent.name.endsWith('.bat') && process.platform === 'win32') {
        this.copyBinaryFile(src, path.join(root, ent.name), { force });
      }
    }
    onProgress({ step: 'tools', text: '工具脚本与批处理已复制' });

    // 附带文档与模板，便于在安装目录里直接查阅
    const readme = path.join(kit, '00_从这里开始.md');
    if (fs.existsSync(readme)) this.copyTextFile(readme, path.join(root, '00_从这里开始.md'), root, { force });
    const manualDir = path.join(kit, '01_操作手册');
    if (fs.existsSync(manualDir)) {
      ensureDir(path.join(root, '01_操作手册'));
      for (const name of fs.readdirSync(manualDir).filter((n) => n.endsWith('.md'))) {
        this.copyTextFile(path.join(manualDir, name), path.join(root, '01_操作手册', name), root, { force });
      }
    }
    const templateDir = path.join(kit, '04_模板');
    if (fs.existsSync(templateDir)) {
      ensureDir(path.join(root, '04_模板'));
      for (const name of fs.readdirSync(templateDir).filter((n) => n.endsWith('.md'))) {
        this.copyTextFile(path.join(templateDir, name), path.join(root, '04_模板', name), root, { force });
      }
    }

    const python = this.detectPython();
    const mcp = this.writeMcpConfig(root, python);
    if (process.platform !== 'win32') this.writeUnixHelpers(root, python);
    onProgress({ step: 'mcp', text: `MCP 配置已生成（Python：${python.found ? python.version : '未检测到'}）` });

    const marker = {
      app: 'AIOA Workbench',
      version: '2.0.0',
      mode: customConfig ? 'custom' : 'standard',
      name: customConfig ? customConfig.name : '标准 8 工位',
      installedAt: new Date().toISOString(),
      root,
    };
    writeTextAtomic(path.join(root, '_AIOA_WORKBENCH.json'), JSON.stringify(marker, null, 2));

    let pointer = this.parsePointer(root);
    let createdProject = null;
    if (!pointer || !pointer.valid) {
      const name = String(project || 'P001_第一个项目').trim() || 'P001_第一个项目';
      createdProject = this.createProject({
        controlRoot: root,
        name,
        title: projectTitle || '待补充',
        codeRoot: codeRoot || 'none',
        deployTarget: deployTarget || '待定',
        baseline: baseline || 'none',
        switchTo: true,
      });
      pointer = this.parsePointer(root);
      onProgress({ step: 'project', text: `项目 ${name} 已创建` });
    } else {
      onProgress({ step: 'project', text: `检测到已有项目指针：${pointer.project}，保持不变` });
    }

    return {
      root,
      project: pointer?.project || '',
      projectRoot: pointer?.root || '',
      mcp: mcp.path,
      python,
      createdProject,
      custom: customConfig
        ? { name: customConfig.name, switches: customConfig.switches, stations: configStations(customConfig).length }
        : null,
      warnings: this.rootWarnings(root),
    };
  }


  rootWarnings(root) {
    const warnings = [];
    if (/[^\x00-\x7F]/.test(root)) warnings.push(`根目录包含中文或非 ASCII 字符，个别 MCP 客户端可能出现编码问题；建议使用 ${process.platform === 'win32' ? 'D:\\ai-workflow' : '~/ai-workflow'}。`);
    if (/\s/.test(root)) warnings.push('根目录包含空格，部分命令行工具可能出错；建议使用无空格路径。');
    if (/(onedrive|dropbox|nutstore|坚果云|百度网盘)/i.test(root)) warnings.push('根目录位于同步盘中，文件监听可能出现半写或抖动。');
    if (/program files/i.test(root)) warnings.push('不建议放在 Program Files 下，权限可能不足。');
    return warnings;
  }

  readGlobalStatus(projectRoot) {
    if (!projectRoot) return 'UNKNOWN';
    const file = path.join(projectRoot, '01_总控', '发件箱', '_GLOBAL_STATUS.md');
    const text = readTextSafe(file) || '';
    for (const line of text.split(/\r?\n/)) {
      if (line.toLowerCase().startsWith('status:')) return line.split(':', 2)[1].trim().toUpperCase();
    }
    return 'UNKNOWN';
  }

  setGlobalStatus(projectRoot, status) {
    const file = path.join(projectRoot, '01_总控', '发件箱', '_GLOBAL_STATUS.md');
    writeTextAtomic(file, `status: ${status === 'PAUSED' ? 'PAUSED' : 'ACTIVE'}\n`);
    return status;
  }

  readVersion(projectRoot) {
    if (!projectRoot) return 0;
    const file = path.join(projectRoot, '01_总控', '发件箱', '_VERSION.md');
    const text = readTextSafe(file) || '';
    for (const line of text.split(/\r?\n/)) {
      if (line.toLowerCase().startsWith('version:')) {
        const n = Number(line.split(':', 2)[1].trim());
        return Number.isFinite(n) ? n : 0;
      }
    }
    return 0;
  }

  stationState(projectRoot, station, staleMinutes) {
    const base = path.join(projectRoot, station.folder);
    const inboxPaths = station.listens.map((d) => path.join(base, d));
    let backlog = 0;
    const pending = [];
    for (const inbox of inboxPaths) {
      backlog += countPending(inbox);
      for (const f of listPending(inbox)) {
        pending.push({ ...f, inbox: path.basename(inbox) });
      }
    }
    pending.sort((a, b) => a.mtime - b.mtime);
    const activityPaths = station.activity.map((d) => path.join(base, d));
    const ready = path.join(base, '_READY.md');
    if (pathExists(ready)) activityPaths.push(ready);
    const last = latestMtime(activityPaths);
    const heartbeatFile = path.join(base, '_HEARTBEAT.md');
    let heartbeat = 0;
    if (pathExists(heartbeatFile)) {
      try {
        heartbeat = fs.statSync(heartbeatFile).mtimeMs;
      } catch {
        /* ignore */
      }
    }
    const offduty = pathExists(path.join(base, '_OFFDUTY.md'));
    const now = Date.now();
    const age = last ? now - last : 0;
    const mins = last ? age / 60000 : 1e9;
    let state = 'empty';
    let stateLabel = '未接过活';
    let tone = 'gray';
    if (offduty) {
      state = 'offduty'; stateLabel = '下班（待命）'; tone = 'purple';
    } else if (backlog > 0 && mins > staleMinutes) {
      state = 'stuck'; stateLabel = `卡住 · ${backlog} 项积压`; tone = 'red';
    } else if (backlog > 0) {
      state = 'running'; stateLabel = '运行中'; tone = 'blue';
    } else if (!last) {
      state = 'empty'; stateLabel = '未接过活'; tone = 'gray';
    } else {
      state = 'idle'; stateLabel = '空闲（正常）'; tone = 'green';
    }
    return {
      ...station,
      base,
      inboxes: inboxPaths,
      backlog,
      pending: pending.slice(0, 8),
      pendingTotal: pending.length,
      lastActivity: last,
      lastActivityText: last ? humanAge(age) : '-',
      heartbeat,
      heartbeatText: heartbeat ? humanAge(now - heartbeat) : '-',
      offduty,
      state,
      stateLabel,
      tone,
      ready,
    };
  }

  terminalFiles(projectRoot) {
    const dir = path.join(projectRoot, '00_人类总控', '汇报终端');
    if (!pathExists(dir)) return [];
    const files = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      let type = 'other';
      let label = '记录';
      if (ent.name.startsWith('[待人类决策]')) { type = 'decision'; label = '待决策'; }
      else if (ent.name.startsWith('[阻塞]') || ent.name.startsWith('[部署阻塞]')) { type = 'blocker'; label = '阻塞'; }
      else if (ent.name.startsWith('上线_')) { type = 'release'; label = '上线'; }
      else if (ent.name.startsWith('进度_')) { type = 'progress'; label = '进度'; }
      else if (ent.name.startsWith('就绪_')) { type = 'ready'; label = '就绪'; }
      else if (ent.name === '系统状态.md') { type = 'system'; label = '系统'; }
      files.push({
        name: ent.name,
        path: full,
        type,
        label,
        size: stat.size,
        mtime: stat.mtimeMs,
        timeText: humanAge(Date.now() - stat.mtimeMs),
      });
    }
    return files.sort((a, b) => b.mtime - a.mtime).slice(0, 60);
  }

  getState(controlRoot, staleMinutes = 8) {
    const root = controlRoot ? path.resolve(controlRoot) : '';
    const result = {
      installed: false,
      root,
      defaultRoot: this.defaultRoot,
      pointer: null,
      projectRoot: '',
      project: '',
      profile: null,
      globalStatus: 'UNKNOWN',
      version: 0,
      stations: [],
      terminal: [],
      projects: [],
      counts: { decisions: 0, blockers: 0, stuck: 0, pending: 0 },
      warnings: [],
      python: this.detectPython(),
      mcpConfigPath: root ? path.join(root, '_mcp_config.json') : '',
      appMarker: null,
      isCustom: false,
      custom: null,
    };
    if (!root || !pathExists(root)) return result;
    const pointer = this.parsePointer(root);
    result.pointer = pointer;
    result.projects = this.listProjects(root);
    const markerPath = path.join(root, '_AIOA_WORKBENCH.json');
    if (pathExists(markerPath)) {
      try {
        result.appMarker = JSON.parse(readTextSafe(markerPath) || '{}');
      } catch {
        /* ignore */
      }
    }
    if (!pointer) return result;
    result.installed = true;
    result.project = pointer.project;
    result.projectRoot = pointer.root;
    if (!pointer.valid) {
      result.warnings.push(`项目指针指向的目录不存在：${pointer.root || '(空)'}`);
      result.warnings.push(...this.rootWarnings(root));
      return result;
    }
    result.globalStatus = this.readGlobalStatus(pointer.root);
    result.version = this.readVersion(pointer.root);
    result.profile = this.readProjectProfile(pointer.root);
    const config = loadConfig(root);
    const stations = config ? configStations(config) : STATIONS;
    result.isCustom = Boolean(config);
    result.custom = config
      ? {
        name: config.name,
        switches: config.switches,
        customRoles: config.customRoles || [],
        schema: config.schema,
        entry: config.entry || '01',
        routes: config.routes || [],
      }
      : null;
    const stale = Number(staleMinutes) > 0 ? Number(staleMinutes) : 8;
    result.stations = stations.map((s) => this.stationState(pointer.root, s, stale));
    result.terminal = this.terminalFiles(pointer.root);
    result.counts.decisions = result.terminal.filter((f) => f.type === 'decision').length;
    result.counts.blockers = result.terminal.filter((f) => f.type === 'blocker').length;
    result.counts.stuck = result.stations.filter((s) => s.state === 'stuck').length;
    result.counts.pending = result.stations.reduce((n, s) => n + s.backlog, 0);
    result.warnings.push(...this.rootWarnings(root));
    if (result.globalStatus === 'PAUSED') result.warnings.push('全局状态是 PAUSED，所有工位会在下一轮循环开头停下。');
    if (!result.python.found) result.warnings.push('未检测到 Python：MCP 服务不可用，但工作台内置监听可以直接使用。');
    else if (!result.python.hasDeps) result.warnings.push('Python 缺少 mcp / watchdog 依赖：MCP 服务暂不可用，工作台内置监听会自动兜底。');
    const missingCards = stations.filter((s) => !pathExists(path.join(root, s.card))).map((s) => s.card);
    if (missingCards.length) result.warnings.push(`角色卡缺失：${missingCards.join('、')}`);
    return result;
  }

  roleCardPath(controlRoot, station) {
    return path.join(controlRoot, station.card);
  }

  getRoleCard(controlRoot, station) {
    const installed = this.roleCardPath(controlRoot, station);
    if (pathExists(installed)) {
      return (readTextSafe(installed) || '').split('{{ROOT}}').join(controlRoot);
    }
    const bundled = path.join(this.kitRoot, '02_角色卡', station.card);
    if (pathExists(bundled)) {
      return (readTextSafe(bundled) || '').split('{{ROOT}}').join(controlRoot);
    }
    throw new Error(`角色卡不存在：${station.card}`);
  }

  /**
   * 只改自定义角色的「职责契约」层：重新生成该角色卡，配置同步，
   * 写盘前备份 .bak，卡与配置文件都走原子替换。
   */
  updateRoleDuty(controlRoot, code, dutyPackage, { draft } = {}) {
    const root = this.normalizeRoot(controlRoot);
    const config = loadConfig(root);
    if (!config) throw new Error('当前目录不是自定义工作流');
    const station = (config.stations || []).find((s) => s.id === code && s.custom);
    if (!station) throw new Error(`找不到自定义角色：${code}`);
    const pkg = validateDutyPackage(
      { ...dutyPackage, status: dutyPackage.status || 'manual' },
      { code, alias: station.alias, type: station.roleType }
    );

    const role = (config.customRoles || []).find((r) => r.code === code);
    station.dutyPackage = pkg;
    station.duty = pkg.name;
    station.short = pkg.name;
    if (draft !== undefined) station.draft = String(draft || '').trim();
    if (role) {
      role.dutyPackage = pkg;
      role.dutyName = pkg.name;
      if (draft !== undefined) role.draft = String(draft || '').trim();
    }
    validateConfig(config);

    const cardPath = path.join(root, station.card);
    const configPath = path.join(root, '_AIOA_WORKFLOW.json');
    if (pathExists(cardPath)) fs.copyFileSync(cardPath, `${cardPath}.bak`);
    if (pathExists(configPath)) fs.copyFileSync(configPath, `${configPath}.bak`);

    const view = configStations(config).find((s) => s.id === code);
    const content = generateRoleCard(view, config).split('{{ROOT}}').join(root);
    writeTextAtomic(cardPath, this.adaptPaths(content));
    writeTextAtomic(configPath, JSON.stringify(config, null, 2));
    writeTextAtomic(path.join(root, '01_总控_配置态.md'), generateConfigCard(config));

    // 协议角色索引也随职责名更新（协议本来就是系统生成的）
    const protocolSrc = path.join(this.kitRoot, '02_协议总纲.md');
    if (pathExists(protocolSrc)) {
      const protocolText = generateProtocol(config, fs.readFileSync(protocolSrc, 'utf8'))
        .split('{{ROOT}}').join(root);
      writeTextAtomic(path.join(root, '00_协议总纲.md'), this.adaptPaths(protocolText));
    }
    return { cardPath, configPath, dutyPackage: pkg };
  }

  appendSystemStatus(projectRoot, line) {
    const file = path.join(projectRoot, '00_人类总控', '汇报终端', '系统状态.md');
    let text = readTextSafe(file) || '';
    if (!text) text = '# 系统状态\n\n';
    text += `- ${nowText()} ${line}\n`;
    writeTextAtomic(file, text);
  }

  stationAction(controlRoot, projectRoot, station, action) {
    const base = path.join(projectRoot, station.folder);
    const offdutyFile = path.join(base, '_OFFDUTY.md');
    if (action === 'start') {
      if (pathExists(offdutyFile)) {
        try {
          fs.unlinkSync(offdutyFile);
        } catch {
          /* ignore */
        }
      }
      this.appendSystemStatus(projectRoot, `${station.label} 已上班（工作台操作）`);
      return {
        command: '上班。请按角色卡执行启动自检，然后进入静默循环。',
        note: '已移除下班标记，并把「上班」指令复制到剪贴板。',
      };
    }
    if (action === 'stop') {
      const text = `# 下班\n\n- 工位：${station.folder}\n- 时间：${nowText()}\n- 原因：人类指令（AIOA 工作台）\n`;
      writeTextAtomic(offdutyFile, text);
      this.appendSystemStatus(projectRoot, `${station.label} 已标记下班（工作台操作）`);
      return {
        command: '下班。处理完当前文件后停止循环，不要取新件。_OFFDUTY.md 已由工作台写入。',
        note: '已写入下班标记，并把「下班」指令复制到剪贴板。粘贴到窗口后生效。',
      };
    }
    if (action === 'rolecard') {
      return { text: this.getRoleCard(controlRoot, station) };
    }
    if (action === 'rolecard_start') {
      return {
        text: `${this.getRoleCard(controlRoot, station)}\n\n---\n\n上班。请按角色卡执行启动自检，然后进入静默循环。`,
      };
    }
    if (action === 'resume') {
      return {
        command: `继续监听。先读 ${path.join(controlRoot, '_ACTIVE_PROJECT.md')} 与 ${path.join(projectRoot, '01_总控', '发件箱', '_GLOBAL_STATUS.md')}，然后按协议第 4 节静默循环执行。`,
      };
    }
    if (action === 'restart') {
      return {
        command: `继续静默循环。从读 ${path.join(controlRoot, '_ACTIVE_PROJECT.md')} 开始，按协议第 4 节走。不要输出文字。`,
      };
    }
    if (action === 'no_question') {
      return {
        command: `不要问，按角色卡执行。第一件事是启动自检，然后进入静默循环。除总控外你不得输出任何文字，你的回复只能是工具调用。`,
      };
    }
    if (action === 'path_fix') {
      return {
        command: `你的工作目录是 ${controlRoot}。先读 ${path.join(controlRoot, '00_协议总纲.md')} 和 ${path.join(controlRoot, station.card)}，再执行启动自检。不要猜路径。`,
      };
    }
    if (action === 'context_reset') {
      return {
        command: '处理完当前文件后停下，不要取新件。我会关掉这个窗口重开。',
      };
    }
    if (action === 'open') return { path: base };
    if (action === 'open_role') return { path: path.join(controlRoot, station.card) };
    throw new Error(`未知工位操作：${action}`);
  }

  buildRequirementContent(data = {}, id = '预览') {
    const title = String(data.title || '').trim() || '未命名需求';
    const priority = String(data.priority || 'P1').trim();
    const baseline = String(data.baseline || 'none').trim();
    const codeBaseline = String(data.codeBaseline || 'none').trim();
    const background = String(data.background || '').trim() || '待补充';
    const goal = String(data.goal || '').trim() || '待补充';
    const scope = String(data.scope || '').trim() || '待补充';
    const nonGoals = String(data.nonGoals || '').trim() || '无';
    const acceptance = String(data.acceptance || '').trim() || '待补充（必须能判定真假）';
    const constraints = String(data.constraints || '').trim() || '无';
    return `# [需求] ${title}\n\n`
      + `- 需求编号：REQ-${id}\n`
      + `- 提出：人类\n`
      + `- 优先级：${priority}\n`
      + `- 基线：${baseline}\n`
      + `- 代码基线：${codeBaseline}\n`
      + `- 投递时间：${nowText()}\n\n`
      + `## 一、背景\n${background}\n\n`
      + `## 二、目标\n${goal}\n\n`
      + `## 三、范围（必须实现）\n${scope}\n\n`
      + `## 四、明确不做\n${nonGoals}\n\n`
      + `## 五、验收标准\n${acceptance}\n\n`
      + `## 六、约束\n${constraints}\n`;
  }

  previewRequirement(data = {}) {
    return {
      id: '提交时生成',
      name: '[需求]_YYYYMMDD-HHmm-01.md',
      content: this.buildRequirementContent(data, 'YYYYMMDD-HHmm-01'),
    };
  }

  createRequirement(projectRoot, data = {}) {
    if (!projectRoot) throw new Error('还没有活动项目');
    const inbox = path.join(projectRoot, '01_总控', '收件箱');
    ensureDir(inbox);
    const id = uniqueId(inbox, '[需求]_');
    const name = `[需求]_${id}.md`;
    const file = path.join(inbox, name);
    const content = this.buildRequirementContent(data, id);
    writeTextAtomic(file, content);
    return { id, name, path: file, content };
  }

  readProjectFile(projectRoot, relPath) {
    const full = path.resolve(projectRoot, relPath);
    if (!isSubPath(projectRoot, full)) throw new Error('路径越界');
    if (!pathExists(full) || !fs.statSync(full).isFile()) throw new Error('文件不存在');
    const stat = fs.statSync(full);
    if (stat.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MB，无法预览');
    return { path: full, content: readTextSafe(full) || '' };
  }

  readTerminalFile(projectRoot, name) {
    const safeName = path.basename(name);
    return this.readProjectFile(projectRoot, path.join('00_人类总控', '汇报终端', safeName));
  }

  appendHumanDecision(projectRoot, name, decision) {
    const safeName = path.basename(name);
    const full = path.join(projectRoot, '00_人类总控', '汇报终端', safeName);
    if (!pathExists(full)) throw new Error('文件不存在');
    if (!safeName.startsWith('[待人类决策]')) throw new Error('只有 [待人类决策] 文件可以追加裁决');
    const text = readTextSafe(full) || '';
    const addition = `\n\n---\n\n**人类裁决（${nowText()}）：** ${String(decision || '').trim()}\n`;
    writeTextAtomic(full, text + addition);
    return { path: full };
  }

  getTemplates(controlRoot) {
    const candidates = [
      controlRoot ? path.join(controlRoot, '04_模板', '消息模板_全前缀.md') : '',
      path.join(this.kitRoot, '04_模板', '消息模板_全前缀.md'),
    ].filter(Boolean);
    const file = candidates.find((p) => pathExists(p));
    if (!file) return [];
    const text = readTextSafe(file) || '';
    const sections = [];
    const parts = text.split(/\n(?=## )/);
    for (const part of parts) {
      const m = part.match(/^##\s+(.+)/);
      if (!m) continue;
      sections.push({ title: m[1].trim(), content: part.trim() });
    }
    return sections;
  }

  tidy(projectRoot, { apply = false, controlRoot = '' } = {}) {
    const plan = [];
    const stations = this.stationsFor(controlRoot || this.controlRootForProject(projectRoot));
    const archiveByMonth = (station) => {
      const dir = path.join(projectRoot, station.folder, '已处理');
      if (!pathExists(dir)) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isFile()) continue;
        if (ent.name.startsWith('.')) continue;
        const full = path.join(dir, ent.name);
        let stat = null;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        const d = new Date(stat.mtimeMs);
        const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const dest = path.join(dir, month, ent.name);
        plan.push({ type: 'archive', from: full, to: dest, label: `${station.folder}/已处理/${ent.name} → ${month}/` });
        if (apply) moveFileAtomic(full, dest);
      }
    };
    for (const s of stations) archiveByMonth(s);

    const terminal = path.join(projectRoot, '00_人类总控', '汇报终端');
    if (pathExists(terminal)) {
      const archive = path.join(terminal, '_archive');
      for (const ent of fs.readdirSync(terminal, { withFileTypes: true })) {
        if (!ent.isFile() || !ent.name.startsWith('进度_')) continue;
        const from = path.join(terminal, ent.name);
        const to = path.join(archive, ent.name);
        plan.push({ type: 'archive', from, to, label: `汇报终端/${ent.name} → _archive/` });
        if (apply) moveFileAtomic(from, to);
      }
    }

    for (const s of stations) {
      const base = path.join(projectRoot, s.folder);
      const ready = path.join(base, '_READY.md');
      if (pathExists(ready)) {
        const lines = (readTextSafe(ready) || '').split(/\r?\n/);
        if (lines.length > 50) {
          const keep = lines.slice(-50);
          const old = lines.slice(0, -50);
          const archive = path.join(base, '_archive', `_READY_${Date.now()}.md`);
          plan.push({ type: 'trim', from: ready, to: archive, label: `${s.folder}/_READY.md 前 ${old.length} 行 → _archive/` });
          if (apply) {
            moveFileAtomic(ready, archive);
            writeTextAtomic(ready, keep.join('\n'));
          }
        }
      }
      const hb = path.join(base, '_HEARTBEAT.md');
      if (pathExists(hb)) {
        const lines = (readTextSafe(hb) || '').split(/\r?\n/);
        if (lines.length > 5) {
          plan.push({ type: 'trim', from: hb, to: '', label: `${s.folder}/_HEARTBEAT.md 只保留最近 5 行` });
          if (apply) writeTextAtomic(hb, lines.slice(-5).join('\n'));
        }
      }
    }
    return { apply, count: plan.length, items: plan };
  }

  clearLocks(projectRoot, { apply = false } = {}) {
    const dir = path.join(projectRoot, '_locks');
    if (!pathExists(dir)) return { count: 0, files: [] };
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.lock'));
    if (apply) {
      for (const name of files) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          /* ignore */
        }
      }
    }
    return { count: files.length, files };
  }

  selfCheck(controlRoot) {
    const items = [];
    const check = (ok, label, detail = '') => items.push({ ok: Boolean(ok), label, detail });
    const root = controlRoot ? path.resolve(controlRoot) : '';
    if (!root || !pathExists(root)) {
      check(false, '控制层根目录存在', root || '未配置');
      return { items, passed: 0, failed: 1, ok: false };
    }
    const stations = this.stationsFor(root);
    const need = ['00_协议总纲.md', '_ACTIVE_PROJECT.md', 'file_watcher_mcp.py',
      ...stations.map((s) => s.card)];
    const missing = need.filter((n) => !pathExists(path.join(root, n)));
    check(!missing.length, '控制层文件齐全', missing.length ? `缺：${missing.join('、')}` : `${need.length} 个文件`);

    const dirty = [];
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      const text = readTextSafe(path.join(root, ent.name)) || '';
      if (text.includes('{{ROOT}}')) dirty.push(ent.name);
    }
    check(!dirty.length, '路径占位符已替换', dirty.length ? `未替换：${dirty.join('、')}` : '无残留');

    const pointer = this.parsePointer(root);
    check(Boolean(pointer && pointer.valid), '项目指针可解析',
      pointer ? `project=${pointer.project || '-'} status=${pointer.status}` : '缺 _ACTIVE_PROJECT.md');
    if (pointer && pointer.valid) {
      const missingDirs = [];
      for (const s of stations) {
        for (const sub of s.listens) {
          if (!pathExists(path.join(pointer.root, s.folder, sub))) missingDirs.push(`${s.folder}/${sub}`);
        }
      }
      if (!pathExists(path.join(pointer.root, '00_人类总控', '汇报终端'))) missingDirs.push('00_人类总控/汇报终端');
      check(!missingDirs.length, '项目目录树完整', missingDirs.length ? `缺：${missingDirs.slice(0, 6).join('、')}` : `${stations.length} 工位 + 汇报终端`);
      const gs = path.join(pointer.root, '01_总控', '发件箱', '_GLOBAL_STATUS.md');
      check(pathExists(gs), '全局开关存在', pathExists(gs) ? (readTextSafe(gs) || '').trim() : '不存在');
      const ver = path.join(pointer.root, '01_总控', '发件箱', '_VERSION.md');
      check(pathExists(ver), '版本号存在', pathExists(ver) ? (readTextSafe(ver) || '').trim() : '不存在');
      try {
        const lockDir = path.join(pointer.root, '_locks');
        ensureDir(lockDir);
        const probe = path.join(lockDir, `_selfcheck_${Date.now()}.lock`);
        fs.writeFileSync(probe, 'probe', 'utf8');
        const ok = fs.existsSync(probe);
        fs.unlinkSync(probe);
        check(ok, '锁目录可写', '_locks');
      } catch (err) {
        check(false, '锁目录可写', err.message);
      }
    } else {
      check(false, '项目目录树完整', '项目指针无效');
      check(false, '全局开关存在', '项目指针无效');
      check(false, '版本号存在', '项目指针无效');
      check(false, '锁目录可写', '项目指针无效');
    }

    const py = this.detectPython();
    check(py.found, 'Python 可用', py.found ? `${py.version} (${py.executable})` : '未检测到 python / py');
    check(py.found && py.hasDeps, 'MCP 依赖已安装', py.found && py.hasDeps ? 'mcp / watchdog OK' : '运行 python -m pip install mcp watchdog');

    const wait = path.join(root, 'tools', 'wait_files.py');
    check(pathExists(wait), '文件监听 CLI 存在', pathExists(wait) ? 'tools/wait_files.py' : '缺失');
    const mcp = path.join(root, '_mcp_config.json');
    check(pathExists(mcp), 'MCP 配置已生成', pathExists(mcp) ? mcp : '缺失');

    const failed = items.filter((i) => !i.ok).length;
    return { items, passed: items.length - failed, failed, ok: failed === 0 };
  }

  readMcpConfig(controlRoot) {
    const file = path.join(controlRoot, '_mcp_config.json');
    if (!pathExists(file)) return null;
    return { path: file, content: readTextSafe(file) || '' };
  }

  listDocs(controlRoot) {
    const docs = [];
    const add = (dir, label) => {
      if (!pathExists(dir)) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isFile() && ent.name.endsWith('.md')) {
          docs.push({ label: `${label}/${ent.name}`, path: path.join(dir, ent.name) });
        }
      }
    };
    if (controlRoot) {
      add(path.join(controlRoot, '01_操作手册'), '操作手册');
      const readme = path.join(controlRoot, '00_从这里开始.md');
      if (pathExists(readme)) docs.unshift({ label: '00_从这里开始.md', path: readme });
      const configCard = path.join(controlRoot, '01_总控_配置态.md');
      if (pathExists(configCard)) docs.unshift({ label: '01_总控_配置态.md', path: configCard });
    }
    return docs;
  }

  openCommandHint(controlRoot) {
    return `打开 WorkBuddy → 连接器管理 → 自定义连接器 → 对 file-watcher 点「信任」。\nMCP 配置：${path.join(controlRoot, '_mcp_config.json')}`;
  }
}

module.exports = { Workflow, STATIONS, TREE, READY_DIRS, MESSAGE_PREFIXES };
