// scripts/build-win.mjs — v2 打包脚本（Windows portable 便携版）
//
// 背景：GitHub 直连被墙（P0 记录），electron-builder 下载 electron 二进制与
// 辅助二进制（NSIS 等）都会失败。本脚本沿用 run-electron.mjs "先设环境变量再
// 执行"的模式，注入 npmmirror 镜像后调 electron-builder 的 build() API。
//
//   ELECTRON_MIRROR                → electron 二进制（npmmirror，P0 已验证链路）
//   ELECTRON_BUILDER_BINARIES_MIRROR → NSIS / winCodeSign 等辅助二进制
//
// 打包配置取 package.json "build"（appId/files/asarUnpack/extraResources/win.target）。

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { build, Platform } = require('electron-builder');

process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
  'https://npmmirror.com/mirrors/electron-builder-binaries/';

console.log('[build:win] 目标: Windows portable（配置取 package.json "build"）');
try {
  const result = await build({
    // Platform 枚举是 WINDOWS 而非 WIN（--win 只是 CLI 选项名）
    targets: Platform.WINDOWS.createTarget(['portable']),
    publish: 'never',
  });
  console.log('[build:win] 完成:', result);
} catch (e) {
  console.error('[build:win] 失败:', e && e.message ? e.message : e);
  process.exit(1);
}
