// scripts/build-win.mjs — 打包脚本（Windows NSIS 安装包 + 便携版 zip）
//
// 按 target 分次构建（nsis → portable）。portable 构建出单文件自解压 exe（~78MB，体积与
// 安装包相当），随后打成发布用 MusicDedup-Portable.zip（内含单个 MusicDedup.exe，非展开
// 目录）；离线 exe 随即删除。发布时携带安装包 + 该 zip + latest.yml。
// 支持 --publish（CI 用，electron-builder 发布到 GitHub Release）；本地默认不发布，
// latest.yml 仍会照常生成。
//
//   node scripts/build-win.mjs [nsis portable] [--publish]
//
// 镜像注入：沿用 run-electron.mjs "先设环境变量再执行"的模式，注入 npmmirror 镜像
//（下载缓慢/失败的备用渠道）。CI（GitHub Actions runner 直连可靠）跳过。
//
//   ELECTRON_MIRROR                → electron 二进制（npmmirror）
//   ELECTRON_BUILDER_BINARIES_MIRROR → NSIS / winCodeSign 等辅助二进制
//
// 打包配置取 package.json "build"（appId/files/asarUnpack/extraResources/win.target/nsis/portable）。

import { createRequire } from 'module';
import { execSync } from 'child_process';
import { existsSync, rmSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { build, Platform } = require('electron-builder');

const argv = process.argv.slice(2);
const targets = argv.filter((a) => !a.startsWith('--'));
const publish = argv.includes('--publish');

if (!process.env.CI) {
  process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
    'https://npmmirror.com/mirrors/electron-builder-binaries/';
}

// 构建期生成应用图标（assets/icon.ico + icons/*.png，不提交；源为 assets/icon.svg）
console.log('[build:win] 生成图标（render-icons）…');
execSync('node scripts/render-icons.mjs', { stdio: 'inherit' });

// 清理上一次构建产物（release/ 是纯构建输出、已 gitignore），避免多版本堆积占磁盘
const releaseDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'release');
if (existsSync(releaseDir)) {
  for (const f of readdirSync(releaseDir)) {
    // 只清构建产物：旧安装包/便携 zip、*.blockmap、win-unpacked、builder-debug.yml
    if (f.endsWith('.exe') || f.endsWith('.zip') || f.endsWith('.blockmap') || f === 'win-unpacked' || f === 'builder-debug.yml') {
      rmSync(path.join(releaseDir, f), { recursive: true, force: true });
    }
  }
  console.log('[build:win] 已清理旧构建产物（win-unpacked / 旧 exe / 旧 zip / *.blockmap / builder-debug.yml）');
}

const list = targets.length ? targets : ['nsis', 'portable'];
console.log(`[build:win] 目标: ${list.join(' + ')}${publish ? '（发布模式）' : ''}（配置取 package.json "build"）`);
for (const t of list) {
  console.log(`[build:win] ── 构建 ${t} ──`);
  try {
    const result = await build({
      // Platform 枚举是 WINDOWS 而非 WIN（--win 只是 CLI 选项名）
      targets: Platform.WINDOWS.createTarget([t]),
      publish: publish ? 'always' : 'never',
    });
    console.log(`[build:win] ${t} 完成:`, result);
    if (t === 'portable') {
      console.log('[build:win] ── 打包便携 zip ──');
      zipPortableExe();
    }
  } catch (e) {
    console.error(`[build:win] ${t} 失败:`, e && e.message ? e.message : e);
    process.exit(1);
  }
}

// portable 构建产出的单文件 MusicDedup.exe → 打成发布用 MusicDedup-Portable.zip（内容为
// 单个压缩 exe，不是展开目录），随后删除离线的 exe。
function zipPortableExe() {
  const exePath = path.join(releaseDir, 'MusicDedup.exe');
  const zipPath = path.join(releaseDir, 'MusicDedup-Portable.zip');
  if (!existsSync(exePath)) {
    console.error('[build:win] 未找到 portable 产物，跳过 zip 打包');
    process.exit(1);
  }
  const q = (s) => s.replace(/'/g, "''");
  const script =
    `$ErrorActionPreference='Stop'; ` +
    `Compress-Archive -LiteralPath '${q(exePath)}' -DestinationPath '${q(zipPath)}' -Force`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  execSync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`, { stdio: 'inherit' });
  rmSync(exePath, { force: true });
  console.log('[build:win] 便携 zip 完成: ' + zipPath);
}
