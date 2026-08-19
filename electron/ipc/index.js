// electron/ipc/index.js — IPC 路由器（P2 核心）
//
// 把 server.js 的 Express 路由逐条迁到主进程 ipcMain.handle('api')。设计决策见
// v2-arch-review.md "步骤 5 记录" 决策 2（URL 桥）：
//   - 单一 IPC 通道 'api'，payload = { method, url, body }
//   - 各域模块（library/files/tags/scrape/duplicates/scan/settings）导出 routes，
//     本文件持唯一路由表，把 method+url 解码成 { params, query } 后分发
//   - handler 形态 (params, query, body) → result，与 server.js 的 Express handler
//     逐行对应；throw 由本层兜底为 { ok:false, error }，等价原 res.status(500).json(...)
//   - URL 字符串是刻意的过渡抽象（保证前端 62 处 api.get/post/put/del 调用零改动）；
//     named-method 形态留 P3 可选优化，handler 本身不依赖 URL 形态
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

import * as library from './library.js';
import * as settings from './settings.js';
import * as files from './files.js';
import * as tags from './tags.js';
import * as scrape from './scrape.js';
import * as duplicates from './duplicates.js';
import * as scan from './scan.js';

const ROUTES = [
  ...library.routes,
  ...settings.routes,
  ...files.routes,
  ...tags.routes,
  ...scrape.routes,
  ...duplicates.routes,
  ...scan.routes,
];

// Express-lite 参数匹配：/api/files/:id → { id }（无参数时返回 {}）
function matchRoute(pattern, pathname) {
  if (pattern === pathname) return {};
  const pp = pattern.split('/');
  const ap = pathname.split('/');
  if (pp.length !== ap.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(ap[i]);
    else if (pp[i] !== ap[i]) return null;
  }
  return params;
}

export function dispatch(method, url, body) {
  const [pathname, search = ''] = url.split('?');
  const query = Object.fromEntries(new URLSearchParams(search));
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const params = matchRoute(r.path, pathname);
    if (params) return r.handler(params, query, body);
  }
  return { ok: false, error: 'Not found' };
}

// 主进程接线入口：main.js 在窗口创建后调用（send 绑定到该窗口的 webContents）。
export function registerApi({ send }) {
  scan.setSend(send);
  ipcMain.handle('api', async (_event, { method, url, body }) => {
    try {
      // await：异步 handler 的 rejection 也兜底为 {ok:false,error}（不传给渲染层变未处理异常）
      return await dispatch(method, url, body);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}
