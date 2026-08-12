// scripts/run-electron.mjs — 启动 v2 客户端（Electron 主进程）
//
// 背景：本机环境存在全局 ELECTRON_RUN_AS_NODE=1，Electron 对该变量的判断是"存在即
// 进入纯 Node 模式"（无论取值），导致 electron.exe 退化为普通 Node 运行——内置
// electron 模块、GUI、自定义协议全部失效（P0 调试时遇到：--version 打印的是 Node
// 版本、require('electron') 拿到的是 npm 包路径字符串）。
// 这里在 spawn 子进程前彻底 delete 该变量（delete 会同步到子进程环境），保证
// npm run electron 在任何环境下都真正启动 Electron。
//
// 参数：--p0 → 以 P0 验证模式启动（主进程跑回归套件 + P0 渲染页），对应 npm run p0:verify。
// 不用命令行内嵌环境变量赋值（Windows cmd 不兼容），改为在子进程 env 里注入。

import { spawn } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// electron npm 包的 module.exports 即 electron.exe 的绝对路径
const electronPath = require('electron');

if ('ELECTRON_RUN_AS_NODE' in process.env) {
  delete process.env.ELECTRON_RUN_AS_NODE;
  console.log('[electron] 检测到 ELECTRON_RUN_AS_NODE 已清除（避免 electron.exe 退化为纯 Node）');
}

const args = ['electron/main.js', ...process.argv.slice(2)];
const child = spawn(electronPath, args, {
  stdio: 'inherit',
  windowsHide: false,
  env: { ...process.env, ...(process.argv.includes('--p0') ? { P0_VERIFY: '1' } : {}) },
});
child.on('close', (code) => process.exit(code == null ? 1 : code));
