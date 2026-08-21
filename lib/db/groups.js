// lib/db/groups.js — dup_groups / group_tracks 表查询与维护
import { injectFpDiff, MATCHING_METHOD_KEYS } from '../rules.js';
import { runTx } from './index.js';

export function clearGroups(db) {
  db.exec('DELETE FROM group_tracks; DELETE FROM dup_groups;');
}

// force 模式前置清理：从所有重复组中移除指定通道的匹配方法标签。
// 移除后若无任何匹配方法标签残留 → 整组删除（脏数据清理）。
// 保留特征标签（format_diff 等），仅清理匹配方法标签。
export function forceStripLaneTags(db, laneTagKeys) {
  const targetTags = new Set(laneTagKeys);
  const groups = db.all('SELECT id, group_tags FROM dup_groups');
  let deletedGroups = 0, updatedGroups = 0;
  runTx(db, () => {
    for (const g of groups) {
      const allTags = (g.group_tags || '').split(',').filter(Boolean);
      const methodTags = allTags.filter(t => MATCHING_METHOD_KEYS.has(t));
      const otherTags = allTags.filter(t => !MATCHING_METHOD_KEYS.has(t));
      const remaining = methodTags.filter(t => !targetTags.has(t));
      if (remaining.length === 0) {
        db.run('DELETE FROM group_tracks WHERE group_id=?', [g.id]);
        db.run('DELETE FROM dup_groups WHERE id=?', [g.id]);
        deletedGroups++;
      } else if (remaining.length !== methodTags.length) {
        const newTags = [...remaining, ...otherTags].join(',');
        db.run('UPDATE dup_groups SET group_tags=? WHERE id=?', [newTags, g.id]);
        updatedGroups++;
      }
    }
  });
  return { deletedGroups, updatedGroups };
}

export function insertGroup(db, { similarity, type, group_tags='', created_time }) {
  db.run('INSERT INTO dup_groups (similarity,type,group_tags,created_time) VALUES (?,?,?,?)', [similarity, type, group_tags||'', created_time]);
  return db.get('SELECT last_insert_rowid() AS id').id;
}

export function insertGroupTrack(db, { group_id, file_id }) {
  db.run('INSERT OR REPLACE INTO group_tracks (group_id,file_id) VALUES (?,?)',
    [group_id, file_id]);
}

export function getGroups(db, { resolved, limit=100000, offset=0 }={}) {
  const where = resolved===undefined ? '' : `WHERE g.resolved=${resolved?1:0}`;
  const groups = db.all(`
    SELECT g.*,
      COUNT(gt.file_id) AS track_count,
      COALESCE(SUM(CASE WHEN gt.file_id != COALESCE(g.smart_keep_file_id, (SELECT gt3.file_id FROM group_tracks gt3 JOIN files f3 ON f3.id=gt3.file_id WHERE gt3.group_id=g.id ORDER BY f3.bitrate DESC LIMIT 1)) THEN f.size END),0) AS savings_bytes,
      COALESCE(
        (SELECT f2.title  FROM files f2 WHERE f2.id=g.smart_keep_file_id),
        (SELECT f4.title  FROM group_tracks gt4 JOIN files f4 ON f4.id=gt4.file_id WHERE gt4.group_id=g.id ORDER BY f4.bitrate DESC LIMIT 1)
      ) AS keep_title,
      COALESCE(
        (SELECT f2.artist FROM files f2 WHERE f2.id=g.smart_keep_file_id),
        (SELECT f4.artist FROM group_tracks gt4 JOIN files f4 ON f4.id=gt4.file_id WHERE gt4.group_id=g.id ORDER BY f4.bitrate DESC LIMIT 1)
      ) AS keep_artist,
      COALESCE(
        (SELECT f2.album FROM files f2 WHERE f2.id=g.smart_keep_file_id),
        (SELECT f4.album FROM group_tracks gt4 JOIN files f4 ON f4.id=gt4.file_id WHERE gt4.group_id=g.id ORDER BY f4.bitrate DESC LIMIT 1)
      ) AS keep_album,
      (SELECT GROUP_CONCAT(f5.path, '|') FROM group_tracks gt5 JOIN files f5 ON f5.id=gt5.file_id WHERE gt5.group_id=g.id) AS paths
    FROM dup_groups g
    JOIN group_tracks gt ON gt.group_id=g.id
    JOIN files f ON f.id=gt.file_id
    ${where} GROUP BY g.id ORDER BY savings_bytes DESC
    LIMIT ${+limit} OFFSET ${+offset}`);
  for (const g of groups) injectFpDiff(g);
  return groups;
}

export function getGroupDetail(db, groupId) {
  const group = db.get('SELECT * FROM dup_groups WHERE id=?', [groupId]);
  if (!group) return null;
  const tracks = db.all(`
    SELECT f.*,
      CASE WHEN rl.file_id IS NOT NULL AND rl.keep=1 THEN 1 ELSE 0 END AS in_retention_list,
      sm_mb.match_basis AS scrape_match_basis,
      sm_mb.title AS scrape_title,
      sm_mb.artist AS scrape_artist,
      sm_mb.album AS scrape_album,
      sm_mb.album_year AS scrape_album_year,
      sm_mb.track_number AS scrape_track_number,
      sm_mb.genre AS scrape_genre,
      sm_mb.duration AS scrape_duration,
      sm_mb.mb_recording_id AS mb_recording_id,
      sm_aid.match_basis AS aid_match_basis,
      sm_aid.title AS aid_title,
      sm_aid.artist AS aid_artist,
      sm_aid.album AS aid_album,
      sm_aid.album_year AS aid_album_year,
      sm_aid.track_number AS aid_track_number,
      sm_aid.genre AS aid_genre,
      sm_aid.duration AS aid_duration
    FROM group_tracks gt JOIN files f ON f.id=gt.file_id
    LEFT JOIN retention_list rl ON rl.file_id=f.id
    LEFT JOIN scraped_meta sm_mb ON sm_mb.file_id = f.id AND sm_mb.source = 'musicbrainz'
    LEFT JOIN scraped_meta sm_aid ON sm_aid.file_id = f.id AND sm_aid.source = 'acoustid'
    WHERE gt.group_id=? ORDER BY f.bitrate DESC`, [groupId]);
  injectFpDiff(group);
  return { ...group, tracks };
}

export function resolveGroup(db, groupId) {
  db.run('UPDATE dup_groups SET resolved=1,resolved_time=? WHERE id=?', [Date.now(), groupId]);
}

export function setGroupSmartKeep(db, groupId, fileId) {
  db.run('UPDATE dup_groups SET smart_keep_file_id=? WHERE id=?', [fileId || null, groupId]);
}
