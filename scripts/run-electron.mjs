// scripts/run-electron.mjs — 启动 v2 客户端（Electron 主进程）
//
// 背景：本机环境存在全局 ELECTRON_RUN_AS_NODE=1，Electron 对该变量的判断是"存在即
// 进入纯 Node 模式"（无论取值），导致 electron.exe 退化为普通 Node 运行——内置
// electron 模块、GUI、自定义协议全部失效（P0 调试时遇到：--version 打印的是 Node
// 版本、require('electron') 拿到的是 npm 包路径字符串）。
// 这里在 spawn 子进程前彻底 delete 该变量（delete 会同步到子进程环境），保证
// npm run electron 在任何环境下都真正启动 Electron。
//
// 参数：--p0 → P0 验证模式（主进程跑回归套件 + P0 渲染页），对应 npm run p0:verify。
//       --p0-samples <dir> → P0 验证的样本目录（P0_SAMPLES_DIR），开源版不硬编码样本路径。
//       --smoke → IPC 链路自测（真实库加载后打关键接口并退出），对应 npm run smoke。
//       --userdata <dir> → 重定向 userData（MUSICDEDUP_USERDATA），隔离测试用
//           （bootstrap-env 的 app.getPath('appData') 不受 APPDATA 环境变量影响）。
//       --migrate <yes|no> → 首启迁移弹窗自动作答（V2_MIGRATE），无头验证用。
// 不用命令行内嵌环境变量赋值（Windows cmd 不兼容），改为在子进程 env 里注入。

import { spawn } from 'child_process';
import { createRequire } from 'module';
import { ensureDevExe } from './patch-dev-exe.mjs';

const require = createRequire(import.meta.url);

if ('ELECTRON_RUN_AS_NODE' in process.env) {
  delete process.env.ELECTRON_RUN_AS_NODE;
  console.log('[electron] 检测到 ELECTRON_RUN_AS_NODE 已清除（避免 electron.exe 退化为纯 Node）');
}

const argv = process.argv.slice(2);
// 兼容 --name value 与 --name=value 两种写法
const opt = (name) => {
  const hit = argv.find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return null;
  return hit === name ? argv[argv.indexOf(hit) + 1] || null : hit.slice(name.length + 1);
};

const args = ['electron/main.js', ...argv];
// dev 用打过分身/图标的 MusicDedup.exe（electron.exe 复制 + rcedit），
// 让 Task Manager/任务栏显示 MusicDedup 而非 Electron；首次或 electron 升级后自动重建。
// 重建失败（如正在运行的实例锁住 exe）时回退 electron.exe，不阻塞启动。
let electronPath = null;
try {
  electronPath = ensureDevExe();
} catch (e) {
  console.warn('[electron] dev-exe 生成失败，回退 electron.exe：' + e.message);
  electronPath = require('electron');
}
const child = spawn(electronPath, args, {
  stdio: 'inherit',
  windowsHide: false,
  env: {
    ...process.env,
    ...(argv.includes('--p0') ? { P0_VERIFY: '1' } : {}),
    ...(opt('--p0-samples') ? { P0_SAMPLES_DIR: opt('--p0-samples') } : {}),
    ...(argv.includes('--smoke') ? { V2_SMOKE: '1' } : {}),
    ...(opt('--userdata') ? { MUSICDEDUP_USERDATA: opt('--userdata') } : {}),
    ...(opt('--migrate') ? { V2_MIGRATE: opt('--migrate') } : {}),
  },
});
child.on('close', (code) => process.exit(code == null ? 1 : code));
