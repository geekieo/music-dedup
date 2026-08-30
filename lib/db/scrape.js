// lib/db/scrape.js — scraped_meta 表（MB/AcoustID 双源刮削结果）+ 刮削待处理队列
export function upsertScrapedMeta(db, m) {
  db.run(`INSERT OR REPLACE INTO scraped_meta
    (file_id,source,mb_recording_id,mb_release_id,title,artist,album,album_year,track_number,genre,duration,confidence,match_basis,scraped_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [m.file_id,m.source,m.mb_recording_id||null,m.mb_release_id||null,
     m.title,m.artist,m.album,m.album_year||0,m.track_number||0,m.genre||null,m.duration||null,m.confidence||0,
     m.match_basis||'fuzzy',m.scraped_at||Date.now()]);
}

// MusicBrainz 刮削是默认刮削通道，与 AcoustID 互相独立。
// MB 使用 `files.mb_checked_at` 跟踪自己的处理状态（类似 acoustid_checked_at），
// 不依赖其他刮削器的状态。
// - smartScan=true, retryMissed=false（增量执行）：仅选取 mb_checked_at 为空或
//   文件修改时间晚于上次检查的文件
// - smartScan=true, retryMissed=true（未命中重新执行）：未检查 + 之前 MB 未命中的
//   文件（source='none'），但跳过 MB 已确认命中的（source='musicbrainz'）
// - smartScan=false（强制重扫）：所有有标题的文件
// AcoustID 已命中的文件仍然允许 MB 刮削（两者独立），但 scraper.js Phase B
// 写保护确保不会覆盖 AcoustID 的声纹验证结果。
export function getFilesNeedingScrape(db, { smartScan=true, retryMissed=false } = {}) {

  if (!smartScan) {
    return db.all(`SELECT * FROM files f WHERE title IS NOT NULL AND title!='' ORDER BY f.id`);
  }

  if (retryMissed) {
    // Unchecked + previously missed by MB, skip MB-already-matched.
    // JOIN on source='musicbrainz': if a row exists, MB already matched → exclude.
    return db.all(`SELECT f.* FROM files f
      LEFT JOIN scraped_meta sm_mb ON sm_mb.file_id = f.id AND sm_mb.source = 'musicbrainz'
      WHERE f.title IS NOT NULL AND f.title!=''
      AND sm_mb.file_id IS NULL
      ORDER BY f.id`);
  }

  // Smart: only files not yet checked by MB (or modified since last check)
  return db.all(`SELECT * FROM files f WHERE
    title IS NOT NULL AND title!=''
    AND (mb_checked_at IS NULL OR (file_mtime IS NOT NULL AND mb_checked_at < file_mtime))
    ORDER BY f.id`);
}

// AcoustID 刮削是独立于 MusicBrainz 刮削的可选通道，两者各自跟踪自己的状态。
// AcoustID 使用 `files.acoustid_checked_at` 判断是否已尝试过（类似 fp_extracted_at），
// 不依赖 `scraped_meta` 表，确保 AcoustID 和 MB 互不干扰。
// - smartScan=true, retryMissed=false（增量执行）：仅选取 acoustid_checked_at 为空或
//   文件修改时间晚于上次检查的文件
// - smartScan=true, retryMissed=true（未命中重新执行）：未检查 + 之前未命中的文件，
//   但跳过 AcoustID 已确认命中的（source='acoustid'），避免重复请求已匹配的曲目
// - smartScan=false（强制重扫）：所有有 Chromaprint 的文件，包括已命中的
export function getFilesNeedingAcoustidScrape(db, { smartScan=true, retryMissed=false } = {}) {
  if (!smartScan) {
    return db.all("SELECT * FROM files WHERE chromaprint IS NOT NULL AND title IS NOT NULL AND title!='' ORDER BY id");
  }
  if (retryMissed) {
    // Retry unchecked + previously missed, but skip files AcoustID already matched.
    // Uses scraped_meta read-only to check AcoustID's own past results.
    return db.all(`SELECT f.* FROM files f
      LEFT JOIN scraped_meta sm ON sm.file_id = f.id AND sm.source = 'acoustid'
      WHERE f.chromaprint IS NOT NULL
      AND f.title IS NOT NULL AND f.title!=''
      AND sm.file_id IS NULL
      ORDER BY f.id`);
  }
  return db.all(`SELECT * FROM files f WHERE
    chromaprint IS NOT NULL
    AND title IS NOT NULL AND title!=''
    AND (acoustid_checked_at IS NULL OR (file_mtime IS NOT NULL AND acoustid_checked_at < file_mtime))
    ORDER BY f.id`);
}

export function getScrapedMeta(db, fileId) {
  const rows = db.all('SELECT * FROM scraped_meta WHERE file_id=?', [fileId]);
  const result = { mb: null, acoustid: null };
  for (const r of rows) {
    // Strip numeric-string genre values (they look like stored AcoustID scores).
    if (r.genre && /^\d+\.\d+$/.test(String(r.genre))) r.genre = null;
    if (r.source === 'musicbrainz') result.mb = r;
    else if (r.source === 'acoustid') result.acoustid = r;
  }
  return result;
}
