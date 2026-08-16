// scripts/patch-dev-exe.mjs — 生成 dev 专用的 MusicDedup.exe（打身份 + 图标）
//
// 背景：Windows 任务管理器/任务栏的进程名与图标取自「进程 exe 的名称与资源」。
//   dev 模式直接跑 node_modules/electron/dist/electron.exe，Task Manager 里必然
//   显示「Electron (4)」+ 默认原子图标（运行时无法改，P5 已确认）。
// 做法（与 electron-builder 打包原理相同）：把 electron.exe 复制为同目录的
//   MusicDedup.exe，再用 rcedit 写图标 + 版本资源（FileDescription/ProductName/
//   FileVersion 等）。Electron 允许重命名 exe——资源（dll/pak/locales/snapshot）
//   按「exe 所在目录」解析，同目录复制即可，无需搬整个 dist。
// 收益：dev 的 Task Manager 进程名 = MusicDedup、图标 = 应用图标；配合 main.js
//   的 BrowserWindow icon，任务栏/Alt-Tab/托盘全部一致。不再需要 Start Menu
//   快捷方式来撑任务栏身份 → dev 不再污染 Start Menu。
// 幂等：dest 存在且不旧于源则跳过（electron 升级后自动重建）。
//
// 已知坑（本机实测）：
//   - fs.cpSync(recursive) 静默崩溃（Node24/本机 Windows）→ 单文件复制用
//     fs.copyFileSync（非递归）。
//   - electron-winstaller 的 rcedit.exe 是 ANSI 版：目标/图标路径含中文（含中文的
//     绝对路径）会 "Unable to load file"，且不支持 --set-product-name 等
//     便捷 flag（报 "Unexpected trailing arguments"）。→ 在 ASCII 临时目录暂存
//     exe+icon 再 rcedit（仅用 --set-version-string / --set-file-version /
//     --set-product-version / --set-icon），再拷回 dist。
//
// 用法：import { ensureDevExe } from './patch-dev-exe.mjs'（run-electron.mjs 调用），
//   或命令行直接跑（生成后退出）：node scripts/patch-dev-exe.mjs

import { copyFileSync, existsSync, mkdirSync, statSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const electronExe = require('electron'); // electron npm 包 exports = electron.exe 绝对路径
const distDir = path.dirname(electronExe);
const srcExe = path.join(distDir, 'electron.exe');
const devExe = path.join(distDir, 'MusicDedup.exe');

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rcedit = path.join(projectRoot, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
const iconPath = path.join(projectRoot, 'assets', 'icon.ico');

// ASCII 暂存目录（os.tmpdir 在本机为 ASCII；rcedit ANSI 版不能碰中文路径）
const stagingDir = path.join(os.tmpdir(), 'md-patch-exe');

// 版本资源（与 package.json version 同步；改动版本号时更新这里）
const APP_VERSION = '2.0.0';

export function ensureDevExe() {
  // 已生成且不旧于源 electron.exe → 复用（electron 重装/升级后 mtime 更新触发重建）
  if (existsSync(devExe)) {
    try {
      if (statSync(devExe).mtimeMs >= statSync(srcExe).mtimeMs) return devExe;
    } catch { /* 源缺失等情况继续走重建 */ }
  }
  for (const [label, p] of [['electron.exe', srcExe], ['rcedit.exe', rcedit], ['icon.ico', iconPath]]) {
    if (!existsSync(p)) throw new Error(`[dev-exe] 找不到 ${label}: ${p}`);
  }

  // 1) 暂存 exe + icon 到 ASCII 目录
  mkdirSync(stagingDir, { recursive: true });
  const stagedExe = path.join(stagingDir, 'MusicDedup.exe');
  const stagedIcon = path.join(stagingDir, 'icon.ico');
  copyFileSync(srcExe, stagedExe);
  copyFileSync(iconPath, stagedIcon);

  // 2) rcedit（仅支持 --set-version-string / --set-file-version / --set-product-version / --set-icon）
  execFileSync(rcedit, [
    stagedExe,
    '--set-version-string', 'FileDescription', 'MusicDedup',
    '--set-version-string', 'ProductName', 'MusicDedup',
    '--set-version-string', 'CompanyName', 'Geekieo',
    '--set-version-string', 'OriginalFilename', 'MusicDedup.exe',
    '--set-version-string', 'LegalCopyright', 'MIT (c) 2026 Geekieo',
    '--set-file-version', APP_VERSION,
    '--set-product-version', APP_VERSION,
    '--set-icon', stagedIcon,
  ], { stdio: 'inherit' });

  // 3) 拷回 dist（与 electron.exe 同目录，资源按 exe 所在目录解析）
  copyFileSync(stagedExe, devExe);

  // 4) 清理暂存
  try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

  console.log('[dev-exe] 已生成 MusicDedup.exe（Task Manager/任务栏显示 MusicDedup + 应用图标）');
  return devExe;
}

// 命令行直接运行：仅生成，不启动
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    ensureDevExe();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
