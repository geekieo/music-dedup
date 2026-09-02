// scripts/smoke-packaged.mjs — 打包版冒烟：对 release/win-unpacked/MusicDedup.exe 跑 V2_SMOKE
// 复用入口（npm run smoke:packaged）。需先 build:win 产出 win-unpacked。
// 清理 ELECTRON_RUN_AS_NODE（存在即退化纯 Node），注入 V2_SMOKE=1。
// 注入 MUSICDEDUP_USERDATA 到独立临时目录：win-unpacked 无 PORTABLE_EXECUTABLE_DIR（单文件
// 便携运行时才注入）会被判安装版、数据落到真实 %APPDATA%，覆盖后冒烟走确定性数据目录。
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exe = path.join(__dirname, '..', 'release', 'win-unpacked', 'MusicDedup.exe');
const smokeData = mkdtempSync(path.join(tmpdir(), 'musicdedup-smoke-'));
if ('ELECTRON_RUN_AS_NODE' in process.env) delete process.env.ELECTRON_RUN_AS_NODE;
const child = spawn(exe, [], {
  stdio: 'inherit',
  env: { ...process.env, V2_SMOKE: '1', SMOKE_SEED: '1', MUSICDEDUP_USERDATA: smokeData },
});
child.on('close', (code) => process.exit(code == null ? 1 : code));
