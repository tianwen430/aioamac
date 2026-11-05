# 打包、体积与 Mac 版说明

更新日期：2026-11-05  
对应版本：v2.4.1

---

## 0. 先看结论

| 问题 | 结论 |
|---|---|
| Windows 版怎么发？ | 直接发 `release\AIOA-Workbench-2.4.1-portable.exe`，约 **98 MB**，双击即用。 |
| Mac 版为什么容易“损坏”？ | 多半不是 GitHub 把文件弄坏，而是把 `.app` 当普通文件传仓库/用 Windows 压缩，导致符号链接和可执行权限丢失；再加上 macOS 的隔离标记。 |
| Mac 版怎么打包最稳？ | **不要本地上传 .app**。把源码传到 GitHub，用仓库里的 `build-mac` Actions 在 macOS 机器上打包，按芯片下载 dmg/zip。 |
| 500 多 MB 是一个安装包吗？ | 通常不是。Mac 的 `.app` 解包后约 250–320 MB，x64 + arm64 两套、再加 dmg/zip，整个 `release` 目录很容易到 500 MB。单个 dmg 一般在 100–150 MB。 |
| 能做到“几十 MB”吗？ | Electron 做不到。要几十 MB 只能换 Tauri（Rust + 系统 WebView）或 Wails，等于重写后端。详见第 6 节。 |
| Rust 和 GPU 是什么意思？ | Rust 是换桌面外壳的技术；GPU 是显卡，只影响“本地跑模型”的速度，不会让安装包变小。两者不是一回事。 |
| 有没有一键把 Electron 转成 Mac 的软件？ | 没有可靠的一键转换。Mac 包必须在 macOS 上构建；源码可以复用，后端要按目标技术重写。 |

---

## 1. 体积到底花在哪

以 v2.4.1 的 Windows 目录版为例：

| 组成 | 大小 | 说明 |
|---|---:|---|
| `AIOA Workbench.exe` | 238.2 MB | Electron 主程序，内含 Chromium + Node 运行时 |
| `dxcompiler.dll` | 24.6 MB | DirectX/WebGPU 着色器编译 |
| `resources.pak` | 12.8 MB | Chromium 界面资源 |
| `icudtl.dat` | 10.3 MB | 国际化数据 |
| `LICENSES.chromium.html` | 5.4 MB | 开源许可证 |
| `vk_swiftshader.dll` | 5.2 MB | 无显卡时的软件渲染兜底 |
| 其他 dll / pak / 资源 | 约 12 MB | |
| `resources\app.asar` | 3.4 MB | **我们自己的代码和界面，只有 3.4 MB** |
| **解包合计** | **312.7 MB** | |
| **portable 单文件** | **98.4 MB** | 7z 自解压压缩后 |

关键点：**大的是 Electron 运行时，不是我们的业务代码。**  
这次已经做了两项安全瘦身：

1. 只保留 `zh-CN`、`en-US` 两个语言包（原来 55 个语言包共 48.8 MB，现在 2 个共 1.1 MB）；
2. 压缩级别从 `normal` 改成 `maximum`。

效果：

- 目录版：360.4 MB → **312.7 MB**
- portable：105.9 MB → **98.4 MB**

再往下砍就要动 Electron 的显示/渲染组件了，可能让老显卡或远程桌面环境出问题，不建议为了十几 MB 冒这个险。

---

## 2. Windows 版交付

### 2.1 发哪个文件

| 形态 | 文件 | 适用 |
|---|---|---|
| 单文件版（推荐） | `05_应用_v2\release\AIOA-Workbench-2.4.1-portable.exe` | 发给别人，双击即用 |
| 目录版 | `05_应用_v2\release\win-unpacked\AIOA Workbench.exe` | 本机长期使用；整个 `win-unpacked` 文件夹一起拷走 |

不要只发目录版里的 exe，它依赖同级的 `resources`、dll 和 `locales`。

### 2.2 首次运行提示

- Windows SmartScreen 可能提示“未知发布者”：点 **更多信息 → 仍要运行**。
- 杀毒软件可能误报 Electron 自解压：加入信任即可。
- 程序不联网校验、不登录、不中转；只有你主动调用模型时才会连你填的服务商。

### 2.3 校验文件是否完整

在 PowerShell 里：

```powershell
Get-FileHash "release\AIOA-Workbench-2.4.1-portable.exe" -Algorithm SHA256
```

把结果和交付清单里的 SHA256 对比即可。如果下载后大小明显小于 98 MB，说明传输被截断，重新拷贝。

---

## 3. Mac 版：推荐流程（不需要你有 Mac）

### 3.1 为什么不能把 `.app` 直接传 GitHub

`.app` 在 macOS 里不是一个文件，而是一个**目录**，里面包含：

- 可执行文件（需要可执行权限）；
- `Frameworks` 里的符号链接（symlink）；
- 签名信息（`_CodeSignature`）。

常见损坏原因：

1. **GitHub 仓库单文件限制 100 MB**。500 MB 的包直接传仓库会失败或被截断；Git LFS 也要额外配置。
2. **用 Windows 压缩/解压 `.app`**。Windows 不保留 symlink 和 Unix 权限，Mac 上就会报“已损坏”。
3. **浏览器下载加隔离标记**。未签名 App 会触发 Gatekeeper。
4. **只上传了 `.app` 里的部分文件**，或者上传的是 `release` 整个目录但下载不完整。

正确做法：**源码进仓库，安装包让 macOS 机器现场构建，产物用 Actions Artifacts 或 Releases 下载。**

### 3.2 上传源码

只上传 `05_应用_v2` 这一层（`package.json` 在根目录）。不要上传：

- `node_modules/`
- `release/`
- `test/smoke-*`
- 任何 `.app`、`.dmg`、`.zip`

仓库里的 `.gitignore` 已经忽略了 `node_modules/` 和 `release/`。

用 GitHub Desktop 最省事：

1. 安装 GitHub Desktop，登录账号；
2. **File → Add local repository**，选 `05_应用_v2`；
3. 如果提示不是仓库，点 **create a repository**；
4. 提交（Commit）→ **Publish repository**；
5. 私有仓库也可以，Actions 照样能跑。

### 3.3 跑 macOS 打包

1. 打开仓库页面 → **Actions**；
2. 左侧选 **build-mac**；
3. 右侧 **Run workflow** → **Run workflow**；
4. 等 10–20 分钟；
5. 运行完成后，页面底部 **Artifacts** 会出现两个包：
   - `AIOA-Workbench-mac-arm64`：Apple Silicon（M1/M2/M3/M4）
   - `AIOA-Workbench-mac-x64`：Intel Mac
6. 只下载对应芯片的那个 Artifact，不要两个都下。

> 公开仓库的 macOS Actions 免费；私有仓库会消耗额度（macOS 按较高倍率计费）。
> 工作流只构建，不自动发布 Release。

### 3.4 在 Mac 上安装

先确认芯片：苹果菜单 → **关于本机**：

- 芯片写着 `Apple M...` → 下 **arm64**
- 处理器写着 `Intel` → 下 **x64**
- 或者在终端运行 `uname -m`：`arm64` 或 `x86_64`

下载后：

**如果是 zip：**

```bash
cd ~/Downloads
ditto -x -k AIOA-Workbench-2.4.1-mac-arm64.zip aioa-mac
# 把解压出来的 AIOA Workbench.app 拖进“应用程序”
```

**如果是 dmg：**

双击 dmg，把 `AIOA Workbench` 拖到 `Applications`。

然后清除隔离标记：

```bash
xattr -dr com.apple.quarantine "/Applications/AIOA Workbench.app"
open "/Applications/AIOA Workbench.app"
```

如果仍提示“已损坏”或“无法验证开发者”，运行仓库里的修复脚本：

```bash
bash scripts/verify-mac.sh "/Applications/AIOA Workbench.app"
```

它会做三件事：

1. 清除隔离属性；
2. 检查签名；
3. 签名不完整时做 ad-hoc 重签。

也可以手动执行：

```bash
xattr -cr "/Applications/AIOA Workbench.app"
codesign --force --deep --sign - "/Applications/AIOA Workbench.app"
```

> macOS 15/26 起，右键“打开”不一定能绕过 Gatekeeper。  
> 如果仍被拦：**系统设置 → 隐私与安全性 → 仍要打开**。

### 3.5 校验下载是否完整

Artifact 里带 `SHA256SUMS-mac.txt`。在 Mac 上：

```bash
cd ~/Downloads
shasum -a 256 -c SHA256SUMS-mac.txt
```

看到 `OK` 再安装。校验失败就重新下载，不要继续装。

---

## 4. Mac 版：有 Mac 时本地打包

如果朋友有 Mac，可以直接在 Mac 上构建：

```bash
cd 05_应用_v2
npm ci
npm run build:mac          # x64 + arm64
npm run build:mac:arm64    # 只打 Apple Silicon
npm run build:mac:x64      # 只打 Intel
```

产物在 `release/`：

- `AIOA-Workbench-2.4.1-mac-arm64.dmg`
- `AIOA-Workbench-2.4.1-mac-x64.dmg`
- 对应的 `.zip`

注意：

- 必须在 macOS 上跑；Windows 上 electron-builder 会直接报
  `Build for macOS is supported only on macOS`。
- 第一次构建要下载 Electron 的 macOS 二进制，约几百 MB，属正常。
- 构建机最好和运行机同架构；Intel 机器打 arm64 包也能打，但测试要在 Apple Silicon 上做。

---

## 5. 正式分发：签名与公证（可选）

不做签名也能用，但用户要手动绕过 Gatekeeper。对外正式分发建议做：

1. 加入 **Apple Developer Program**（约 99 美元/年）；
2. 申请 **Developer ID Application** 证书；
3. 在 GitHub Actions 里配置 Secrets：
   - `CSC_LINK`：证书 `.p12` 的 base64 或地址
   - `CSC_KEY_PASSWORD`：证书密码
   - `APPLE_ID`：Apple ID
   - `APPLE_APP_SPECIFIC_PASSWORD`：App 专用密码
   - `APPLE_TEAM_ID`：团队 ID
4. 在 `package.json` 的 `build.mac` 里去掉 `"identity": null`，改成你的证书名，或交给 electron-builder 自动发现；
5. 开启公证（electron-builder 26 支持 `mac.notarize`）。

签名+公证后，用户双击就能开，不会再看到“已损坏”。

---

## 6. “Rust + GPU”和“几十 MB”到底是什么意思

### 6.1 Rust / Tauri

Electron 的做法是：**每个应用自带一整套 Chromium 浏览器 + Node.js**，所以最小也是 80–100 MB。

Tauri 的做法是：**用操作系统自带的 WebView**（Windows 用 WebView2，macOS 用 WKWebView），
外面套一个 Rust 写的小外壳。安装包通常 **3–15 MB**，装完约 10–40 MB。

代价：

- 界面（`renderer/` 里的 HTML/CSS/JS）基本可以复用；
- 但现在的 Node 后端要重写：文件工具、MCP stdio、模型流式请求（OpenAI/Anthropic）、
  工作流引擎、配置、监听、IPC 都要换成 Rust；
- 还要重新做 Windows/macOS 双平台测试。

按这个项目的体量，做到功能对齐大约 **3–6 周**，不是“转一下格式”那么简单。
网上没有可靠的 Electron → Tauri 一键转换器；`tauri migrate` 只辅助部分前端配置，不转换 Node 后端。

### 6.2 GPU

GPU 是显卡。它影响的是：

- 本地跑大模型（Ollama / llama.cpp / LM Studio）时的速度；
- 图像、视频处理的速度。

它**不会**让安装包变小。  
朋友说的“Rust + GPU”可能是两件事拼在一起：Rust 换外壳减小体积，GPU 加速本地模型。
这两件事都可以做，但都不是当前这版 Windows 交付的前置条件。

### 6.3 建议

- **现在**：Windows 继续用 Electron 版，98 MB，功能完整、稳定；
- **Mac**：用 GitHub Actions 出对应架构的 dmg/zip；
- **如果“几十 MB”是硬指标**：先做一个小型 Tauri 验证版（只做“选模型 + 对话 + 读文件”），
  估算工作量和风险，再决定要不要整体迁移。不要一上来重写全部。

---

## 7. 你需要动手的部分（ checklist ）

### Windows

- [ ] 拿 `release\AIOA-Workbench-2.4.1-portable.exe`
- [ ] 双击运行；SmartScreen 选“更多信息 → 仍要运行”
- [ ] 设置里填自己的 API Key，选模型

### Mac（没有 Mac 也能做）

- [ ] 注册/登录 GitHub
- [ ] 用 GitHub Desktop 把 `05_应用_v2` 源码发布成仓库（不要带 `release/`、`node_modules/`）
- [ ] Actions → build-mac → Run workflow
- [ ] 按芯片下载 `arm64` 或 `x64` 的 Artifact
- [ ] 在 Mac 上解压/拖入 Applications
- [ ] 运行 `xattr -dr com.apple.quarantine "/Applications/AIOA Workbench.app"`
- [ ] 打不开时运行 `bash scripts/verify-mac.sh "/Applications/AIOA Workbench.app"`

### 可选

- [ ] 如果要正式对外发 Mac 版：购买 Apple Developer，做签名+公证
- [ ] 如果一定要几十 MB：立项做 Tauri 验证版（先小范围，不整体重写）

---

## 8. 常见问题

**Q：Mac 版 500 多 MB，是不是包做坏了？**  
A：先看是不是把 x64、arm64、dmg、zip、解包目录加在一起算了。单个 dmg 通常 100–150 MB；
`.app` 解包后 250–320 MB 是 Electron 的正常体积。只有单个 dmg 超过 200 MB 才需要查构建配置。

**Q：GitHub 会把文件弄坏吗？**  
A：GitHub 本身不会。常见问题是：超过仓库 100 MB 单文件限制、用 Windows 压缩 `.app` 丢权限、
下载不完整、macOS 隔离标记。用 Actions 产物 + SHA256 校验可以避开。

**Q：能不能把 Windows 的 exe 直接转成 Mac 的 dmg？**  
A：不能。Mac 包必须在 macOS 上构建，而且需要 Mach-O 格式的 Electron 二进制和 `.app` 目录结构。

**Q：Mac 版是通用的吗？**  
A：不是 universal 包，x64 和 arm64 分开构建。按芯片下载对应版本即可。

**Q：为什么不做一个 500 MB 的 universal 包省事？**  
A：universal 会把两套二进制塞进一个包，体积接近两倍，而且构建更慢。分开发更小、更稳。

**Q：98 MB 的 Windows 包算大吗？**  
A：在 Electron 应用里算正常偏小。VS Code 安装包约 100 MB，Discord 约 90 MB。
要几十 MB 只能换 Tauri/Wails 这类使用系统 WebView 的方案。

---

## 9. 相关文件

| 文件 | 用途 |
|---|---|
| `package.json` | 版本、Electron 构建配置、语言包、压缩级别 |
| `.github/workflows/build-mac.yml` | GitHub Actions 的 macOS 打包流程 |
| `scripts/verify-mac.sh` | Mac 首次打开修复脚本 |
| `scripts/after-pack.js` | Electron fuses 加固 |
| `使用说明.md` | 用户使用说明（含 Mac 简版步骤） |
| `docs/角色与流程配置方案.md` | 角色与工作流设计 |
