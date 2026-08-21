// electron/ipc/duplicates.js — 重复组域：列表/详情 / resolve / unresolve / purge / trash / keep / retention-list
// 共享 helper（trashFile / computeKeepSet / purgeGroupFiles / LRC_EXTS）单点归属本域。
import { getDB } from '../../lib/db/index.js';
import { getAllSettings } from '../../lib/db/settings.js';
import { setFileDeleted } from '../../lib/db/files.js';
import { getGroups, getGroupDetail, resolveGroup } from '../../lib/db/groups.js';
import { addRetentionList, removeRetentionList, getRetentionList, getRetentionFileIds, getExcludeFileIds } from '../../lib/db/retention.js';
import { tagTracks } from '../../lib/rules.js';
import path from 'path';
import { existsSync, renameSync, unlinkSync } from 'fs';

const db = getDB();
const LRC_EXTS = new Set(['.lrc', '.txt', '.lyric', '.ass', '.srt', '.smi', '.vtt']);

async function trashFile(fp) {
  const results = [];
  const doTrash = (p) => {
    try { renameSync(p, p + '.deleted'); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  };
  results.push({ path: fp, ...doTrash(fp) });
  // 同名的歌词等附属文件一并处理
  const dir = path.dirname(fp);
  const base = path.basename(fp, path.extname(fp));
  for (const ext of LRC_EXTS) {
    const lrcPath = path.join(dir, base + ext);
    if (existsSync(lrcPath)) results.push({ path: lrcPath, ...doTrash(lrcPath) });
  }
  return results;
}

// 组内"应保留"的文件 id 集合（智能冠军 ∪ 保留名单）—— 与 evaluateGroup 的 OR 逻辑
// 保持一致，使 resolve/unresolve/purge 与级联判定结果一致。
function computeKeepSet(tracks) {
  const s = getAllSettings(db);
  const tierOrder = Array.isArray(s.quality_tiers) && s.quality_tiers.length ? s.quality_tiers : null;
  const pickTagOrder = Array.isArray(s.pick_tag_order) && s.pick_tag_order.length ? s.pick_tag_order : null;
  const retentionFileIds = getRetentionFileIds(db);
  const excludeFileIds = getExcludeFileIds(db);
  const annotated = tagTracks(tracks, tierOrder, pickTagOrder, retentionFileIds, excludeFileIds);
  return new Set(annotated.filter((t) => t._keepWinner).map((t) => t.id));
}

function annotatedGroup(g) {
  const s = getAllSettings(db);
  const tierOrder = Array.isArray(s.quality_tiers) && s.quality_tiers.length ? s.quality_tiers : null;
  const pickTagOrder = Array.isArray(s.pick_tag_order) && s.pick_tag_order.length ? s.pick_tag_order : null;
  const retentionFileIds = getRetentionFileIds(db);
  const excludeFileIds = getExcludeFileIds(db);
  return tagTracks(g.tracks, tierOrder, pickTagOrder, retentionFileIds, excludeFileIds);
}

// 彻底删除已处理组的 .deleted 文件 + 清理数据库（无组引用则移除文件及关联表）
function purgeGroupFiles(g) {
  let deleted = 0, failed = 0;
  const purgeIds = [];
  const keepSet = computeKeepSet(g.tracks);
  for (const t of g.tracks.filter((t) => !keepSet.has(t.id))) {
    const delPath = t.path + '.deleted';
    if (existsSync(delPath)) { try { unlinkSync(delPath); deleted++; } catch (e) { failed++; } }
    const dir = path.dirname(t.path);
    const base = path.basename(t.path, path.extname(t.path));
    for (const ext of LRC_EXTS) {
      const lrcDel = path.join(dir, base + ext + '.deleted');
      if (existsSync(lrcDel)) { try { unlinkSync(lrcDel); deleted++; } catch (e) { failed++; } }
    }
    purgeIds.push(t.id);
  }
  for (const fid of purgeIds) {
    db.run('DELETE FROM group_tracks WHERE group_id=? AND file_id=?', [g.id, fid]);
    const refs = db.get('SELECT COUNT(*) n FROM group_tracks WHERE file_id=?', [fid]);
    if (!refs || refs.n === 0) {
      db.run('DELETE FROM files WHERE id=?', [fid]);
      db.run('DELETE FROM write_history WHERE file_id=?', [fid]);
      db.run('DELETE FROM tag_snapshots WHERE file_id=?', [fid]);
      db.run('DELETE FROM scraped_meta WHERE file_id=?', [fid]);
      db.run('DELETE FROM retention_list WHERE file_id=?', [fid]);
    }
  }
  // 剩余 <2 则组不再是重复组 → 整组移除
  const remaining = db.all('SELECT file_id FROM group_tracks WHERE group_id=?', [g.id]);
  const groupRemoved = remaining.length < 2;
  if (groupRemoved) {
    db.run('DELETE FROM group_tracks WHERE group_id=?', [g.id]);
    db.run('DELETE FROM dup_groups WHERE id=?', [g.id]);
  }
  return { deletedCount: deleted, failedCount: failed, groupRemoved };
}

export const routes = [
  // ── 保留名单 ──
  { method: 'GET', path: '/api/retention-list', handler: () => ({ ok: true, data: getRetentionList(db) }) },
  { method: 'DELETE', path: '/api/retention-list/:fileId', handler: (p) => {
    removeRetentionList(db, +p.fileId);
    return { ok: true };
  } },

  // ── 重复组列表 / 详情 ──
  { method: 'GET', path: '/api/duplicates', handler: (_p, query) => {
    const resolved = query.resolved !== undefined ? query.resolved === '1' : undefined;
    return { ok: true, data: getGroups(db, { resolved }) };
  } },
  { method: 'GET', path: '/api/duplicates/:id', handler: (p) => {
    const g = getGroupDetail(db, +p.id);
    if (!g) return { ok: false };
    g.tracks = annotatedGroup(g);
    return { ok: true, data: g };
  } },

  // ── 处理：resolve / resolve-all ──
  { method: 'POST', path: '/api/duplicates/:id/resolve', handler: async (p) => {
    const g = getGroupDetail(db, +p.id);
    if (!g) return { ok: false };
    const keepSet = computeKeepSet(g.tracks);
    const dels = g.tracks.filter((t) => !keepSet.has(t.id));
    if (dels.length === 0) return { ok: false, error: '该组没有需要删除的文件——所有曲目均为保留状态，无需处理。' };
    const results = [];
    const trashedIds = [];
    for (const t of dels) {
      if (!existsSync(t.path)) { results.push({ path: t.path, ok: true, method: 'missing' }); continue; }
      const r = await trashFile(t.path);
      results.push(...r);
      if (r[0]?.ok) trashedIds.push(t.id); // 主文件改名成功 → 标记回收站
    }
    if (trashedIds.length) setFileDeleted(db, trashedIds, 1);
    resolveGroup(db, +p.id);
    return { ok: true, deleted: results };
  } },
  { method: 'POST', path: '/api/duplicates/resolve-all', handler: async (_p, _q, body) => {
    const ids = body?.ids; // 可选：只处理指定组
    const pending = getGroups(db, { resolved: false }).filter((g) => !ids || ids.includes(g.id));
    let del = 0, err = 0;
    const trashedIds = [];
    for (const g of pending) {
      const d = getGroupDetail(db, g.id);
      if (!d) continue;
      const keepSet = computeKeepSet(d.tracks);
      const dels = d.tracks.filter((t) => !keepSet.has(t.id));
      if (dels.length === 0) continue;
      for (const t of dels) {
        if (!existsSync(t.path)) continue;
        const results = await trashFile(t.path);
        for (const r of results) r.ok ? del++ : err++;
        if (results[0]?.ok) trashedIds.push(t.id);
      }
      resolveGroup(db, g.id);
    }
    if (trashedIds.length) setFileDeleted(db, trashedIds, 1);
    return { ok: true, deletedCount: del, errorCount: err, groupsProcessed: pending.length };
  } },

  // ── 撤销：恢复 .deleted 文件，标记组为未处理 ──
  { method: 'POST', path: '/api/duplicates/:id/unresolve', handler: (p) => {
    const g = getGroupDetail(db, +p.id);
    if (!g) return { ok: false };
    const keepSet = computeKeepSet(g.tracks);
    const restored = [], failed = [];
    const restoredIds = [];
    for (const t of g.tracks.filter((t) => !keepSet.has(t.id))) {
      const delPath = t.path + '.deleted';
      let didRestore = false;
      if (existsSync(delPath)) { try { renameSync(delPath, t.path); restored.push(t.path); didRestore = true; } catch (e) { failed.push({ path: t.path, error: e.message }); } }
      const dir = path.dirname(t.path);
      const base = path.basename(t.path, path.extname(t.path));
      for (const ext of LRC_EXTS) {
        const lrcDel = path.join(dir, base + ext + '.deleted');
        if (existsSync(lrcDel)) { try { renameSync(lrcDel, path.join(dir, base + ext)); restored.push(lrcDel); } catch (e) { failed.push({ path: lrcDel, error: e.message }); } }
      }
      if (didRestore) restoredIds.push(t.id); // 主文件恢复成功 → 取消回收站标记
    }
    if (restoredIds.length) setFileDeleted(db, restoredIds, 0);
    db.run('UPDATE dup_groups SET resolved=0,resolved_time=NULL WHERE id=?', [+p.id]);
    return { ok: true, restored, failed };
  } },
  { method: 'POST', path: '/api/duplicates/unresolve-all', handler: (_p, _q, body) => {
    const ids = body?.ids;
    const groups = getGroups(db, { resolved: true }).filter((g) => !ids || ids.includes(g.id));
    let totalRestored = 0, groupsRestored = 0;
    const restoredIds = [];
    for (const g of groups) {
      const d = getGroupDetail(db, g.id);
      if (!d) continue;
      const keepSet = computeKeepSet(d.tracks);
      let restored = [];
      for (const t of d.tracks.filter((t) => !keepSet.has(t.id))) {
        const delPath = t.path + '.deleted';
        let didRestore = false;
        if (existsSync(delPath)) { try { renameSync(delPath, t.path); restored.push(t.path); didRestore = true; } catch (e) {} }
        const dir2 = path.dirname(t.path);
        const base2 = path.basename(t.path, path.extname(t.path));
        for (const ext of LRC_EXTS) {
          const lrcDel = path.join(dir2, base2 + ext + '.deleted');
          if (existsSync(lrcDel)) { try { renameSync(lrcDel, path.join(dir2, base2 + ext)); restored.push(lrcDel); } catch (e) {} }
        }
        if (didRestore) restoredIds.push(t.id);
      }
      db.run('UPDATE dup_groups SET resolved=0,resolved_time=NULL WHERE id=?', [g.id]);
      groupsRestored++;
      totalRestored += restored.length;
    }
    if (restoredIds.length) setFileDeleted(db, restoredIds, 0);
    return { ok: true, restoredCount: totalRestored, groupsRestored };
  } },

  // ── 彻底删除 / 清空回收站 ──
  { method: 'POST', path: '/api/duplicates/:id/purge', handler: (p) => {
    const g = getGroupDetail(db, +p.id);
    if (!g) return { ok: false };
    if (!g.resolved) return { ok: false, error: '该组尚未处理' };
    return { ok: true, ...purgeGroupFiles(g) };
  } },
  { method: 'POST', path: '/api/trash/empty', handler: (_p, _q, body) => {
    const ids = body?.ids;
    const groups = getGroups(db, { resolved: true }).filter((g) => !ids || ids.includes(g.id));
    let totalDeleted = 0, totalFailed = 0, totalRemoved = 0;
    for (const g of groups) {
      const d = getGroupDetail(db, g.id);
      if (!d) continue;
      const r = purgeGroupFiles(d);
      totalDeleted += r.deletedCount;
      totalFailed += r.failedCount;
      if (r.groupRemoved) totalRemoved++;
    }
    return { ok: true, deletedCount: totalDeleted, failedCount: totalFailed, groupsRemoved: totalRemoved, totalGroups: groups.length };
  } },

  // ── 单曲保留切换（手动保留 / 智能冠军 override）──
  { method: 'PUT', path: '/api/duplicates/:id/tracks/:fid/keep', handler: (p, _q, body) => {
    const gid = +p.id, fid = +p.fid;
    const { keep, reason } = body;
    const g = getGroupDetail(db, gid);
    if (!g) return { ok: false };
    if (keep) {
      // 先移除任何 exclude override；若该曲本就是智能冠军则回归智能保留，
      // 否则需要手动保留
      removeRetentionList(db, fid);
      const annotated = annotatedGroup(g);
      const track = annotated.find((t) => t.id === fid);
      if (!track || !track._keepWinner) {
        addRetentionList(db, fid, reason || '手动保留', 1);
      }
    } else {
      // 移除手动保留项，再加 exclude override，使智能冠军也可切到"删除"态
      removeRetentionList(db, fid);
      const annotated = annotatedGroup(g);
      const track = annotated.find((t) => t.id === fid);
      if (track && track._keepWinner) {
        addRetentionList(db, fid, null, 0);
      }
    }
    // 返回重算后的组详情
    const updated = getGroupDetail(db, gid);
    if (updated) updated.tracks = annotatedGroup(updated);
    return { ok: true, data: updated };
  } },
];
