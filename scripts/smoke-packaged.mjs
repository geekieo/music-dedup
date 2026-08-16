// scripts/smoke-packaged.mjs — 打包版冒烟：对 release/win-unpacked/MusicDedup.exe 跑 V2_SMOKE
// 复用入口（npm run smoke:packaged）。需先 build:win 产出 win-unpacked。
// 清理 ELECTRON_RUN_AS_NODE（存在即退化纯 Node），注入 V2_SMOKE=1。
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exe = path.join(__dirname, '..', 'release', 'win-unpacked', 'MusicDedup.exe');
if ('ELECTRON_RUN_AS_NODE' in process.env) delete process.env.ELECTRON_RUN_AS_NODE;
const child = spawn(exe, [], { stdio: 'inherit', env: { ...process.env, V2_SMOKE: '1' } });
child.on('close', (code) => process.exit(code == null ? 1 : code));
