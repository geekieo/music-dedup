// electron/migration.js — P5 交互式数据迁移 UX
//
// 依赖 scripts/migrate-data.mjs 的纯逻辑（probeSourceDb / migrateLegacyData），
// 在此叠加主进程原生对话框。本模块刻意不 import lib/db —— 自身绝不打开目标库，
// 使"迁移决策先于任何 DB 打开"可成立（main.js 启动顺序的关键前提，见主进程注释）。
//
// 场景（v2_plan §三.2"宁可多问一步也不要静默覆盖"）：
//   目标库不存在（首启/全新 userData）+ 检测到旧数据 → 询问是否迁移；
//   目标已存在（已迁移/已有库）→ 永不打扰。
import { createRequire } from 'module';
import { existsSync } from 'fs';

const require = createRequire(import.meta.url);
const { dialog } = require('electron');

import { probeSourceDb, migrateLegacyData } from '../scripts/migrate-data.mjs';

function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

/**
 * 首启数据迁移决策。返回结构同 migrateLegacyData（migrated / reason / source / target）。
 * - interactive=false（smoke 非交互）→ 静默自动迁移（有效默认源才迁，绝不覆盖）。
 * - interactive=true（客户端）→ 目标缺失时弹原生对话框询问；
 *   V2_MIGRATE=yes|no 环境变量自动作答（测试/无头用，先例 P0_AUTORUN）。
 */
export async function runMigrationUX({ interactive, targetDb = process.env.DB_PATH }) {
  // 1. 目标已存在（已迁移/已有库）→ 永不打扰（幂等安全契约）
  if (existsSync(targetDb)) return { migrated: false, reason: 'target-exists', target: targetDb };

  const def = probeSourceDb();

  // 2. 非交互（smoke）：沿用 v1 自动迁移语义（现在顺序正确，真正生效）
  if (!interactive) {
    if (!def.valid) return { migrated: false, reason: 'no-legacy-source' };
    return migrateLegacyData({ targetDb });
  }

  // 3. 测试自动作答：yes→迁移默认源；no→全新开始
  if (process.env.V2_MIGRATE === 'yes') {
    if (!def.valid) return { migrated: false, reason: 'no-legacy-source' };
    return migrateLegacyData({ targetDb });
  }
  if (process.env.V2_MIGRATE === 'no') return { migrated: false, reason: 'skipped' };

  // 4. 交互：原生弹窗（窗口创建前，无 owner 窗口合法；Windows 下靠任务栏定位，可接受）
  const buttons = def.valid
    ? ['迁移到新位置（推荐）', '选择其他位置…', '全新开始（不迁移）']
    : ['选择其他位置…', '全新开始（不迁移）'];
  const freshIdx = buttons.length - 1; // 全新开始 恒为最后一项
  const { response } = await dialog.showMessageBox({
    type: 'info',
    buttons,
    defaultId: def.valid ? 0 : freshIdx,
    cancelId: freshIdx, // Esc/关闭 → 全新开始（非破坏）
    title: 'MusicDedup 数据迁移',
    message: def.valid ? '检测到旧版 MusicDedup 数据' : '是否导入旧版 MusicDedup 数据？',
    detail: def.valid
      ? `来源：${def.sourceDb}（${fmtSize(def.size)}）\n目标：${targetDb}\n\n迁移只复制旧数据，绝不覆盖或删除原文件；迁移后原数据保留为备份。`
      : `未在默认位置找到旧版数据。\n若此前使用过 MusicDedup v1，请选择其数据文件夹（需包含 musicdedup.db）导入；否则全新开始即可。\n\n目标：${targetDb}`,
  });

  const CHOOSE = def.valid ? 1 : 0;
  if (def.valid && response === 0) return migrateLegacyData({ targetDb });
  if (response === CHOOSE) {
    const picked = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择旧版 MusicDedup 数据文件夹（需包含 musicdedup.db）',
    });
    const dir = picked.canceled || !picked.filePaths.length ? null : picked.filePaths[0];
    if (!dir) return { migrated: false, reason: 'cancelled' };
    const src = probeSourceDb({ sourceDir: dir });
    if (!src.valid) {
      const again = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['重新选择', '全新开始（不迁移）'],
        defaultId: 0,
        cancelId: 1,
        title: '未找到有效数据',
        message: '所选文件夹中没有可用的 musicdedup.db（或数据库无效）。',
        detail: `${dir}\n\n请确认选择的是旧版 MusicDedup 的数据文件夹。`,
      });
      if (again.response === 1) return { migrated: false, reason: 'skipped' };
      return runMigrationUX({ interactive, targetDb }); // 重新选择（单层递归，天然终止于取消）
    }
    return migrateLegacyData({ sourceDir: dir, targetDb });
  }
  return { migrated: false, reason: 'skipped' };
}
