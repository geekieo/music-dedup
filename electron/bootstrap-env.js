// electron/bootstrap-env.js — 环境注入，必须在 main.js 的其它 import 之前加载。
//
// 为什么需要它：lib/db.js 在模块加载时即解析 DB_PATH（lib/db.js:13），而 ESM
// 静态 import 先于任何语句执行。P1 用"动态 import server.js"绕开这个时序；P2
// 把路由迁到 electron/ipc/*，采用"第一个 import 先行注入"：本文件作为 main.js
// 的首个 import，在 ipc 树（传递依赖 lib/db.js）求值前把 DB 路径放到位。
// userData 固定 %APPDATA%/MusicDedup（与 migrate-data 脚本一致，dev/打包统一）。
// MUSICDEDUP_USERDATA 为测试/隔离用覆盖（run-electron.mjs --userdata）：app.getPath('appData')
// 走 known-folder API 不受 APPDATA 环境变量影响，故需要显式开关才能重定向 userData。
// 覆盖值解析为绝对路径——app.setPath('userData') 要求绝对路径，相对值会抛
// "path must be absolute"（P5 联调发现）。
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const { app } = require('electron');

const userDataOverride = process.env.MUSICDEDUP_USERDATA;
app.setPath('userData', userDataOverride ? path.resolve(userDataOverride) : path.join(app.getPath('appData'), 'MusicDedup'));
process.env.DB_PATH = path.join(app.getPath('userData'), 'musicdedup.db');
