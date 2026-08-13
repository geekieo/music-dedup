// electron/bootstrap-env.js — 环境注入，必须在 main.js 的其它 import 之前加载。
//
// 为什么需要它：lib/db.js 在模块加载时即解析 DB_PATH（lib/db.js:13），而 ESM
// 静态 import 先于任何语句执行。P1 用"动态 import server.js"绕开这个时序；P2
// 把路由迁到 electron/ipc/*，采用"第一个 import 先行注入"：本文件作为 main.js
// 的首个 import，在 ipc 树（传递依赖 lib/db.js）求值前把 DB 路径放到位。
// userData 固定 %APPDATA%/MusicDedup（与 migrate-data 脚本一致，dev/打包统一）。
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const { app } = require('electron');

app.setPath('userData', path.join(app.getPath('appData'), 'MusicDedup'));
process.env.DB_PATH = path.join(app.getPath('userData'), 'musicdedup.db');
