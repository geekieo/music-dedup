// electron/ipc/settings.js — 设置域：settings / browse-folder（原生对话框）/ fpcalc 探针
// browse-folder 用 Electron dialog.showOpenDialog 替换 server.js 的 powershell/osascript
// spawn 黑客（v2-arch-review 步骤 5 决策 6，删 ~20 行）。
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { dialog } = require('electron');

import { getDB } from '../../lib/db/index.js';
import { getAllSettings, setSetting } from '../../lib/db/settings.js';
import { detectFpcalc, resetDetection } from '../../lib/chromaprint-bridge.js';
import { getPhysicalCores } from '../cpuinfo.js';

const db = getDB();

export const routes = [
  { method: 'GET', path: '/api/settings', handler: () => ({ ok: true, data: getAllSettings(db) }) },
  // 系统环境信息（渲染层"自动并发"显示用）：物理核数
  { method: 'GET', path: '/api/system/info', handler: () => ({ ok: true, data: { physicalCores: getPhysicalCores() } }) },
  { method: 'PUT', path: '/api/settings', handler: (_p, _q, body) => {
    for (const [k, v] of Object.entries(body)) setSetting(db, k, v);
    return { ok: true };
  } },
  { method: 'POST', path: '/api/browse-folder', handler: async (_p, query) => {
    const title = query.title || '选择要添加到音乐库的文件夹';
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'], title });
    return { ok: true, path: r.canceled ? null : (r.filePaths[0] || null) };
  } },
  // ?path=... 允许客户端先测候选路径再保存；不传则回退到已保存配置
  { method: 'GET', path: '/api/system/fpcalc', handler: async (_p, query) => {
    const s = getAllSettings(db);
    const testPath = query.path !== undefined ? query.path : (s.fpcalc_path || '');
    if (query.path !== undefined) resetDetection(); // 现场测试强制重新探测
    const p = await detectFpcalc(testPath);
    return { ok: true, data: {
      available: !!p,
      path: p || null,
      usingCustomPath: !!testPath,
      note: p
        ? `fpcalc 已找到（${p}），Chromaprint 声纹将在下次声纹提取时生成`
        : testPath
          ? `在配置的路径中未找到 fpcalc: ${testPath}`
          : 'fpcalc 未安装。将 fpcalc 可执行文件放入项目根目录，或在下方填写路径',
    } };
  } },
];
