// scripts/build-mac.mjs — macOS 打包（dmg + zip，x64 + arm64）
//
// 仅能在 macOS 上运行：先栅格化 assets/icon.svg → assets/icons/*.png，再经系统 iconutil
// 组装成 assets/icon.icns（构建期产物，不提交），随后 electron-builder 一次性产出
// x64 + arm64 的 dmg 与 zip（latest-mac.yml 含两种架构）。默认不发布，产物在 release/。
//
//   node scripts/build-mac.mjs [--publish]
import { spawnSync } from 'child_process';
import { cpSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const publish = process.argv.includes('--publish');

if (process.platform !== 'darwin') {
  console.error('[build:mac] 仅能在 macOS 上打包（需系统 iconutil 与 macOS 架构产物）');
  process.exit(1);
}

console.log('[build:mac] 生成图标（render-icons + iconutil → assets/icon.icns）…');
spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'render-icons.mjs')], { cwd: ROOT, stdio: 'inherit' });

const iconset = path.join(tmpdir(), `MusicDedup.iconset-${Date.now()}`);
mkdirSync(iconset, { recursive: true });
const png = (s) => path.join(ROOT, 'assets', 'icons', `icon-${s}.png`);
// iconutil 需要的图标名：基础尺寸 + @2x（必须精确等于 2 倍基础尺寸）。icon-512 已是最
// 大可用（512@2x 的 1024 不生成，缺失的表示由系统按需放大）。
const map = {
  'icon_16x16.png': png(16), 'icon_16x16@2x.png': png(32),
  'icon_32x32.png': png(32), 'icon_32x32@2x.png': png(64),
  'icon_128x128.png': png(128), 'icon_128x128@2x.png': png(256),
  'icon_256x256.png': png(256), 'icon_256x256@2x.png': png(512),
  'icon_512x512.png': png(512),
};
for (const [name, src] of Object.entries(map)) cpSync(src, path.join(iconset, name));
const iconutil = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ROOT, 'assets', 'icon.icns')], { stdio: 'inherit' });
rmSync(iconset, { recursive: true, force: true });
if (iconutil.status !== 0) process.exit(iconutil.status || 1);

console.log(`[build:mac] electron-builder：dmg + zip（x64 + arm64）${publish ? '（发布模式）' : ''}`);
const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const args = ['--mac', 'dmg', 'zip', '--x64', '--arm64', '--publish', publish ? 'always' : 'never'];
const r = spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
