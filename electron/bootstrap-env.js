// electron/bootstrap-env.js — 环境注入，必须在 main.js 的其它 import 之前加载：
// lib/db.js 在模块加载时即解析 DB_PATH，本文件作为 main.js 首个 import 先把 userData
// 与 DB 路径放到位，再让 ipc 树（传递依赖 lib/db.js）求值。
// userData：安装版/dev → %APPDATA%/MusicDedup/UserData；便携版 → exe 旁 UserData
//（便携判定见 mode.js：PORTABLE_EXECUTABLE_DIR）。
// MUSICDEDUP_USERDATA 为测试/隔离用覆盖（run-electron.mjs --userdata）：app.getPath('appData')
// 走 known-folder API 不受 APPDATA 环境变量影响，故需要显式开关才能重定向 userData。
// 覆盖值必须解析为绝对路径——app.setPath('userData') 要求绝对路径，相对值会抛
// "path must be absolute"。
import { createRequire } from 'module';
import path from 'path';
import { isPortable } from './mode.js';

const require = createRequire(import.meta.url);
const { app } = require('electron');

const userDataOverride = process.env.MUSICDEDUP_USERDATA;
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
if (userDataOverride) {
  app.setPath('userData', path.resolve(userDataOverride));
} else if (isPortable()) {
  app.setPath('userData', path.join(portableDir || path.dirname(process.execPath), 'UserData'));
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'MusicDedup', 'UserData'));
}
process.env.DB_PATH = path.join(app.getPath('userData'), 'musicdedup.db');
