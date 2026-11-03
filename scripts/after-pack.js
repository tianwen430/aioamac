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
  const exePath = context.electronPlatformName === 'darwin'
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
};
