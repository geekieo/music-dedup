// scripts/render-icons.mjs — 统一图标生成器（Electron 栅格化 assets/icon.svg）
// 产出：assets/icons/icon-{16..512}.png + assets/icon.ico（应用图标）+ assets/tray.png/.ico（托盘）
// 用法：node scripts/render-icons.mjs
import { spawn } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

if ('ELECTRON_RUN_AS_NODE' in process.env) {
  delete process.env.ELECTRON_RUN_AS_NODE;
}

const main = path.join(__dirname, 'render-icons-main.mjs');
const child = spawn(electronPath, [main], { stdio: 'inherit', env: process.env });
child.on('close', (code) => process.exit(code == null ? 1 : code));
