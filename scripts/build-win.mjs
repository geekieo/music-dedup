// scripts/build-win.mjs — v2 打包脚本（Windows NSIS 安装包 + portable 便携版，双产物）
//
// 背景：GitHub 直连被墙（P0 记录），electron-builder 下载 electron 二进制与
// 辅助二进制（NSIS 等）都会失败。本脚本沿用 run-electron.mjs "先设环境变量再
// 执行"的模式，注入 npmmirror 镜像后调 electron-builder 的 build() API。
//
//   ELECTRON_MIRROR                → electron 二进制（npmmirror，P0 已验证链路）
//   ELECTRON_BUILDER_BINARIES_MIRROR → NSIS / winCodeSign 等辅助二进制
//
// 打包配置取 package.json "build"（appId/files/asarUnpack/extraResources/win.target/nsis）。

import { createRequire } from 'module';
import { execSync } from 'child_process';
import { existsSync, rmSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { build, Platform } = require('electron-builder');

process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
  'https://npmmirror.com/mirrors/electron-builder-binaries/';

// 构建期生成应用图标（assets/icon.ico + icons/*.png，不提交；源为 assets/icon.svg）
console.log('[build:win] 生成图标（render-icons）…');
execSync('node scripts/render-icons.mjs', { stdio: 'inherit' });

// 清理上一次构建产物（release/ 是纯构建输出、已 gitignore），避免多版本堆积占磁盘
const releaseDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'release');
if (existsSync(releaseDir)) {
  for (const f of readdirSync(releaseDir)) {
    // 只清构建产物：旧安装包/便携版 exe、*.blockmap、win-unpacked、builder-debug.yml
    if (f.endsWith('.exe') || f.endsWith('.blockmap') || f === 'win-unpacked' || f === 'builder-debug.yml') {
      rmSync(path.join(releaseDir, f), { recursive: true, force: true });
    }
  }
  console.log('[build:win] 已清理旧构建产物（win-unpacked / 旧 exe / *.blockmap / builder-debug.yml）');
}

console.log('[build:win] 目标: Windows NSIS + portable（配置取 package.json "build"）');
try {
  const result = await build({
    // Platform 枚举是 WINDOWS 而非 WIN（--win 只是 CLI 选项名）
    targets: Platform.WINDOWS.createTarget(['nsis', 'portable']),
    publish: 'never',
  });
  console.log('[build:win] 完成:', result);
} catch (e) {
  console.error('[build:win] 失败:', e && e.message ? e.message : e);
  process.exit(1);
}
