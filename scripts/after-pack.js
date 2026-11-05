'use strict';

const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/**
 * electron-builder afterPack 钩子：翻转 Electron Fuses，做基础加固。
 *
 * 作用（提高篡改/调试门槛）：
 *  - 禁止把 exe 当 Node 运行（RunAsNode）
 *  - 禁止通过 NODE_OPTIONS / --inspect 注入调试
 *  - 只允许从 app.asar 加载应用、并校验 asar 完整性
 *
 * 注意：这不是加密。asar 仍可被专用工具解开，只能挡住"随手拆包"。
 */
exports.default = async function afterPack(context) {
  const productName = context.packager.appInfo.productFilename;
  const isMac = context.electronPlatformName === 'darwin';
  const exePath = isMac
    ? path.join(context.appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName)
    : path.join(context.appOutDir, `${productName}.exe`);
  await flipFuses(exePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  console.log(`[afterPack] Electron fuses applied: ${exePath}`);

  // Apple Silicon 要求可执行文件至少有 ad-hoc 签名。identity 为 null 时
  // electron-builder 会跳过签名，翻转 fuses 后原签名也会失效；这里先做
  // ad-hoc 签名，保证 dmg/zip 里的 .app 能直接启动。配置了正式证书时，
  // electron-builder 会在 afterPack 之后用 Developer ID 重新签名。
  if (isMac) {
    const { execFileSync } = require('child_process');
    const appPath = path.join(context.appOutDir, `${productName}.app`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
      stdio: 'inherit',
    });
    console.log(`[afterPack] macOS ad-hoc signed: ${appPath}`);
  }
};
