// electron/bootstrap-env.js — 环境注入，必须在 main.js 的其它 import 之前加载：
// lib/db.js 在模块加载时即解析 DB_PATH，本文件作为 main.js 首个 import 先把 userData
// 与 DB 路径放到位，再让 ipc 树（传递依赖 lib/db.js）求值。
// userData 固定 %APPDATA%/MusicDedup（与 migrate-data 脚本一致，dev/打包统一）。
// portable（便携版）例外：electron-builder 的便携壳会注入 PORTABLE_EXECUTABLE_DIR
// 环境变量（值为 exe 所在目录），此时数据放 exe 旁的 MusicDedup-data/，不在宿主留数据。
// MUSICDEDUP_USERDATA 为测试/隔离用覆盖（run-electron.mjs --userdata）：app.getPath('appData')
// 走 known-folder API 不受 APPDATA 环境变量影响，故需要显式开关才能重定向 userData。
// 覆盖值必须解析为绝对路径——app.setPath('userData') 要求绝对路径，相对值会抛
// "path must be absolute"。
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const { app } = require('electron');

const userDataOverride = process.env.MUSICDEDUP_USERDATA;
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
if (userDataOverride) {
  app.setPath('userData', path.resolve(userDataOverride));
} else if (portableDir) {
  app.setPath('userData', path.join(portableDir, 'MusicDedup-data'));
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'MusicDedup'));
}
process.env.DB_PATH = path.join(app.getPath('userData'), 'musicdedup.db');
