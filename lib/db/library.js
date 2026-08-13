// lib/db/library.js — 音乐库查询（stats / queryLibrary 三件套 / locate）
import { computeScrapeTier, tierRank, mergeDualScrapeShape } from '../tier.js';

// ── Search normalization (mirrors public/app.js normalizeForSearch) ─────
function normalizeForSearch(s) {
  if (!s) return '';
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

function filterBySearch(rows, search, fields) {
  const q = normalizeForSearch(search);
  if (!q) return rows;
  return rows.filter(row => fields.some(f => {
    const val = row[f] || '';
    return normalizeForSearch(val).includes(q);
  }));
}

// ── Stats ─────────────────────────────────────────────────────────────────
export function statsQuery(db) {
  const total      = (db.get('SELECT COUNT(*) n FROM files')||{n:0}).n;
  const albums     = (db.get("SELECT COUNT(DISTINCT album) n FROM files WHERE album IS NOT NULL AND album!=''")||{n:0}).n;
  const artists    = (db.get("SELECT COUNT(DISTINCT artist) n FROM files WHERE artist IS NOT NULL AND artist!=''")||{n:0}).n;
  const totalBytes = (db.get('SELECT COALESCE(SUM(size),0) s FROM files')||{s:0}).s;
  const formats    = db.all('SELECT format, COUNT(*) n FROM files WHERE format IS NOT NULL GROUP BY format ORDER BY n DESC');
  const withMeta   = (db.get('SELECT COUNT(*) n FROM files WHERE meta_extracted_at IS NOT NULL')||{n:0}).n;
  const withFP     = (db.get('SELECT COUNT(*) n FROM files WHERE fingerprint IS NOT NULL')||{n:0}).n;
  const dupGroups  = (db.get('SELECT COUNT(*) n FROM dup_groups')||{n:0}).n;
  const dupFiles   = (db.get(`SELECT COUNT(*) n FROM group_tracks gt JOIN dup_groups g ON g.id=gt.group_id WHERE gt.file_id != g.smart_keep_file_id`)||{n:0}).n;
  const dupBytes   = (db.get(`SELECT COALESCE(SUM(f.size),0) s FROM group_tracks gt JOIN files f ON f.id=gt.file_id JOIN dup_groups g ON g.id=gt.group_id WHERE gt.file_id != g.smart_keep_file_id`)||{s:0}).s;
  const pendingGroups = (db.get('SELECT COUNT(*) n FROM dup_groups WHERE resolved=0')||{n:0}).n;
  return { total, albums, artists, totalBytes, formats, withMeta, withFP, dupGroups, dupFiles, dupBytes, pendingGroups };
}

// ── Library query variant for scrape-tier sort ─────────────────────────
// Tier sort needs the FULL matching result set (not just one page) because
// tier depends on Traditional/Simplified folding that can't be expressed in
// SQL — see lib/tier.js. Reuses the same WHERE/JOIN logic as queryLibrary.
// 内部 helper：仅 queryLibrary 的 tier 路径调用。
function queryLibraryAllForTier(db, { search='', format='', libFilter='all' }={}) {
  const whereParts = [];
  const params = [];
  if (format) { whereParts.push("f.format=?"); params.push(format.toUpperCase()); }
  if (libFilter==='scraped') whereParts.push("(sm_mb.title IS NOT NULL AND sm_mb.title!='' OR sm_aid.title IS NOT NULL AND sm_aid.title!='')");
  if (libFilter==='dup')     whereParts.push("dt.file_id IS NOT NULL");
  const join = libFilter==='dup'
    ? 'LEFT JOIN group_tracks dt ON dt.file_id=f.id'
    : '';
  const where = whereParts.length ? 'WHERE '+whereParts.join(' AND ') : '';
  const rows = db.all(`
    SELECT f.*,
      CASE WHEN rl.file_id IS NOT NULL AND rl.keep=1 THEN 1 ELSE 0 END AS in_retention_list,
      sm_mb.title AS mb_title, sm_mb.artist AS mb_artist, sm_mb.album AS mb_album,
      sm_mb.album_year AS mb_album_year, sm_mb.track_number AS mb_track_number,
      sm_mb.genre AS mb_genre, sm_mb.mb_recording_id AS mb_recording_id,
      sm_mb.match_basis AS mb_match_basis,
      sm_aid.title AS aid_title, sm_aid.artist AS aid_artist, sm_aid.album AS aid_album,
      sm_aid.album_year AS aid_album_year, sm_aid.track_number AS aid_track_number,
      sm_aid.genre AS aid_genre, sm_aid.mb_recording_id AS aid_recording_id,
      sm_aid.match_basis AS aid_match_basis,
      COALESCE(sm_aid.title, sm_mb.title) AS scraped_title,
      COALESCE(sm_aid.artist, sm_mb.artist) AS scraped_artist,
      COALESCE(sm_aid.album, sm_mb.album) AS scraped_album,
      COALESCE(sm_aid.album_year, sm_mb.album_year) AS scraped_album_year,
      COALESCE(sm_aid.track_number, sm_mb.track_number) AS scraped_track_number,
      COALESCE(sm_aid.genre, sm_mb.genre) AS scraped_genre,
      COALESCE(sm_aid.match_basis, sm_mb.match_basis) AS scrape_match_basis,
      CASE WHEN sm_aid.source IS NOT NULL THEN 'acoustid'
           WHEN sm_mb.source IS NOT NULL THEN 'musicbrainz'
           ELSE NULL END AS scrape_source
    FROM files f
    LEFT JOIN retention_list rl ON rl.file_id=f.id
    LEFT JOIN scraped_meta sm_mb ON sm_mb.file_id = f.id AND sm_mb.source = 'musicbrainz'
    LEFT JOIN scraped_meta sm_aid ON sm_aid.file_id = f.id AND sm_aid.source = 'acoustid'
    ${join}
    ${where}
    ORDER BY f.id`, params);
  return filterBySearch(rows, search, ['title', 'artist', 'album', 'path']);
}

// ── Locate a file's row position under the full (unfiltered) library ──────
// Used by the "点击定位到音乐库" feature: rather than linearly re-fetching
// pages until the target file turns up, the client asks the server for its
// zero-based index under the given sort so it can jump straight to the
// containing page. Ignores search/format/libFilter — locate always targets
// the canonical whole-library view, since that's the one guaranteed to
// contain any given file.
export function locateFileInLibrary(db, fileId, { sort = 'title', order = 'asc' } = {}) {
  const safeSort  = ['title', 'artist', 'album', 'format', 'size', 'duration', 'album_year'].includes(sort) ? sort : 'title';
  const safeOrder = order === 'desc' ? 'DESC' : 'ASC';
  const rows = db.all(`SELECT id FROM files ORDER BY ${safeSort} ${safeOrder} NULLS LAST`);
  return rows.findIndex(r => r.id === fileId); // -1 if the file no longer exists
}

// Shape a library row's scraped_* columns into the {title,artist,album,...}
// object computeScrapeTier()/autoSelectFields() expect. Used by BOTH
// queryLibrary and queryLibraryByTier so there's exactly one place that
// builds this shape — previously each had its own inline version (and the
// browser had a THIRD, incomplete one), which is how 筛选/标注 could show
// different tiers for the same file.
function scrapedShapeFromRow(f, ignoreScript = true) {
  // Build shapes for both sources, compute tier for each independently,
  // then merge: matching fields (title/artist/album) from the better-tier
  // source, recommendable-write fields (year/track/genre) from both.
  // This keeps library filter tiers consistent with the scraping dialog
  // (server.js /api/files/:id/scraped), which merges rather than picking one.
  const aidShape = f.aid_title ? {
    title: f.aid_title, artist: f.aid_artist,
    album: f.aid_album, album_year: f.aid_album_year || 0,
    track_number: f.aid_track_number || 0,
    genre: (f.aid_genre && !/^\d+\.\d+$/.test(String(f.aid_genre))) ? f.aid_genre : null,
    match_basis: f.aid_match_basis, source: 'acoustid',
  } : null;
  const mbShape = f.mb_title ? {
    title: f.mb_title, artist: f.mb_artist,
    album: f.mb_album, album_year: f.mb_album_year || 0,
    track_number: f.mb_track_number || 0,
    genre: (f.mb_genre && !/^\d+\.\d+$/.test(String(f.mb_genre))) ? f.mb_genre : null,
    match_basis: f.mb_match_basis, source: 'musicbrainz',
  } : null;
  return mergeDualScrapeShape(f, mbShape, aidShape, ignoreScript);
}

// Generic JS comparator mirroring the SQL "ORDER BY col ASC/DESC NULLS LAST"
// semantics used by queryLibrary — needed wherever sorting happens in JS
// (i.e. whenever a 刮削分类 filter is active, since tier can't be expressed in SQL).
function cmpLibraryField(a, b, sort, order) {
  const dir = order === 'desc' ? -1 : 1;
  let av = a[sort], bv = b[sort];
  if (av == null && bv == null) return 0;
  if (av == null) return 1;  // NULLS LAST regardless of direction
  if (bv == null) return -1;
  if (typeof av === 'string') av = av.toLowerCase();
  if (typeof bv === 'string') bv = bv.toLowerCase();
  if (av < bv) return -1 * dir;
  if (av > bv) return 1 * dir;
  return 0;
}

// ── Library query（分页、可搜索；刮削分类筛选/按档位排序走 tier 路径）────────
// sort=scrape_tier 或带 scrapeTier 过滤时，tier 无法用 SQL 表达（CJK 繁简折叠在
// JS — 见 lib/tier.js），拉全量匹配集、逐行算 tier、JS 过滤排序后分页。
// （吸收原 queryLibraryByTier：单一查询入口，ipc 层不再需要分支）
// scrapeTier: 'green'|'blue'|'yellow'|'none' (无可用刮削数据) | '' (不过滤，sort=scrape_tier 时仍需)
export function queryLibrary(db, { search='', sort='title', order='asc', page=1, limit=100, format='', libFilter='all', ignoreScript=true, scrapeTier='' }={}) {
  if (sort === 'scrape_tier' || scrapeTier) {
    const safeSort = ['title','artist','album','format','size','duration','album_year'].includes(sort) ? sort : 'title';
    const allRows = queryLibraryAllForTier(db, { search, format, libFilter });
    const withTier = allRows.map(f => ({ ...f, _tier: computeScrapeTier(f, scrapedShapeFromRow(f, ignoreScript), ignoreScript) }));
    const filtered = scrapeTier
      ? withTier.filter(f => scrapeTier === 'none' ? f._tier == null : f._tier === scrapeTier)
      : withTier;
    if (sort === 'scrape_tier') {
      const dir = order === 'desc' ? -1 : 1;
      filtered.sort((a, b) => dir * (tierRank(a._tier) - tierRank(b._tier)));
    } else {
      filtered.sort((a, b) => cmpLibraryField(a, b, safeSort, order));
    }
    const total = filtered.length;
    const start = (+page - 1) * +limit;
    // 把算出的 tier 附到行上：库列表刮削图标与筛选读同一值（单一出处）
    const rows = filtered.slice(start, start + +limit).map(({ _tier, ...rest }) => ({ ...rest, scrape_tier: _tier }));
    return { total, page: +page, limit: +limit, rows };
  }

  const offset = (page-1)*limit;
  const safeSort  = ['title','artist','album','format','size','duration','album_year'].includes(sort) ? sort : 'title';
  const safeOrder = order==='desc'?'DESC':'ASC';
  const whereParts = [];
  const params = [];
  // Search is handled in JS (normalizeForSearch) for accent/punctuation
  // tolerance — SQL LIKE alone can't do NFKD folding.
  if (format) { whereParts.push("f.format=?"); params.push(format.toUpperCase()); }
  if (libFilter==='scraped') whereParts.push("(sm_mb.title IS NOT NULL AND sm_mb.title!='' OR sm_aid.title IS NOT NULL AND sm_aid.title!='')");
  if (libFilter==='dup')     whereParts.push("dt.file_id IS NOT NULL");
  const scrapeJoin = libFilter==='scraped'
    ? 'LEFT JOIN scraped_meta sm_mb ON sm_mb.file_id = f.id AND sm_mb.source = \'musicbrainz\' LEFT JOIN scraped_meta sm_aid ON sm_aid.file_id = f.id AND sm_aid.source = \'acoustid\''
    : '';
  const join = libFilter==='dup'
    ? 'LEFT JOIN group_tracks dt ON dt.file_id=f.id'
    : '';
  const where = whereParts.length ? 'WHERE '+whereParts.join(' AND ') : '';

  // When search is active, fetch all rows and filter/sort/paginate in JS
  // so that normalizeForSearch (NFKD + accent stripping) is applied.
  // This mirrors the client-side filterBySearch in public/app.js.
  if (search) {
    const allRows = db.all(`
      SELECT f.*,
        CASE WHEN rl.file_id IS NOT NULL AND rl.keep=1 THEN 1 ELSE 0 END AS in_retention_list,
        sm_mb.title AS mb_title, sm_mb.artist AS mb_artist, sm_mb.album AS mb_album,
        sm_mb.album_year AS mb_album_year, sm_mb.track_number AS mb_track_number,
        sm_mb.genre AS mb_genre, sm_mb.mb_recording_id AS mb_recording_id,
        sm_mb.match_basis AS mb_match_basis,
        sm_aid.title AS aid_title, sm_aid.artist AS aid_artist, sm_aid.album AS aid_album,
        sm_aid.album_year AS aid_album_year, sm_aid.track_number AS aid_track_number,
        sm_aid.genre AS aid_genre, sm_aid.mb_recording_id AS aid_recording_id,
        sm_aid.match_basis AS aid_match_basis,
        COALESCE(sm_aid.title, sm_mb.title) AS scraped_title,
        COALESCE(sm_aid.artist, sm_mb.artist) AS scraped_artist,
        COALESCE(sm_aid.album, sm_mb.album) AS scraped_album,
        COALESCE(sm_aid.album_year, sm_mb.album_year) AS scraped_album_year,
        COALESCE(sm_aid.track_number, sm_mb.track_number) AS scraped_track_number,
        COALESCE(sm_aid.genre, sm_mb.genre) AS scraped_genre,
        COALESCE(sm_aid.match_basis, sm_mb.match_basis) AS scrape_match_basis,
        CASE WHEN sm_aid.source IS NOT NULL THEN 'acoustid'
             WHEN sm_mb.source IS NOT NULL THEN 'musicbrainz'
             ELSE NULL END AS scrape_source
      FROM files f
      LEFT JOIN retention_list rl ON rl.file_id=f.id
      LEFT JOIN scraped_meta sm_mb ON sm_mb.file_id = f.id AND sm_mb.source = 'musicbrainz'
      LEFT JOIN scraped_meta sm_aid ON sm_aid.file_id = f.id AND sm_aid.source = 'acoustid'
      ${join}
      ${where}`, params);
    const filtered = filterBySearch(allRows, search, ['title', 'artist', 'album', 'path']);
    filtered.sort((a, b) => cmpLibraryField(a, b, safeSort, order));
    const total = filtered.length;
    const rows = filtered.slice(offset, offset + +limit);
    for (const f of rows) f.scrape_tier = computeScrapeTier(f, scrapedShapeFromRow(f, ignoreScript), ignoreScript);
    return { total, page: +page, limit: +limit, rows };
  }

  const total = (db.get(`SELECT COUNT(DISTINCT f.id) n FROM files f ${scrapeJoin} ${join} ${where}`, params)||{n:0}).n;

  const rows = db.all(`
    SELECT f.*,
      CASE WHEN rl.file_id IS NOT NULL AND rl.keep=1 THEN 1 ELSE 0 END AS in_retention_list,
      sm_mb.title AS mb_title, sm_mb.artist AS mb_artist, sm_mb.album AS mb_album,
      sm_mb.album_year AS mb_album_year, sm_mb.track_number AS mb_track_number,
      sm_mb.genre AS mb_genre, sm_mb.mb_recording_id AS mb_recording_id,
      sm_mb.match_basis AS mb_match_basis,
      sm_aid.title AS aid_title, sm_aid.artist AS aid_artist, sm_aid.album AS aid_album,
      sm_aid.album_year AS aid_album_year, sm_aid.track_number AS aid_track_number,
      sm_aid.genre AS aid_genre, sm_aid.mb_recording_id AS aid_recording_id,
      sm_aid.match_basis AS aid_match_basis,
      COALESCE(sm_aid.title, sm_mb.title) AS scraped_title,
      COALESCE(sm_aid.artist, sm_mb.artist) AS scraped_artist,
      COALESCE(sm_aid.album, sm_mb.album) AS scraped_album,
      COALESCE(sm_aid.album_year, sm_mb.album_year) AS scraped_album_year,
      COALESCE(sm_aid.track_number, sm_mb.track_number) AS scraped_track_number,
      COALESCE(sm_aid.genre, sm_mb.genre) AS scraped_genre,
      COALESCE(sm_aid.match_basis, sm_mb.match_basis) AS scrape_match_basis,
      CASE WHEN sm_aid.source IS NOT NULL THEN 'acoustid'
           WHEN sm_mb.source IS NOT NULL THEN 'musicbrainz'
           ELSE NULL END AS scrape_source
    FROM files f
    LEFT JOIN retention_list rl ON rl.file_id=f.id
    LEFT JOIN scraped_meta sm_mb ON sm_mb.file_id = f.id AND sm_mb.source = 'musicbrainz'
    LEFT JOIN scraped_meta sm_aid ON sm_aid.file_id = f.id AND sm_aid.source = 'acoustid'
    ${join}
    ${where}
    ORDER BY f.${safeSort} ${safeOrder} NULLS LAST
    LIMIT ${+limit} OFFSET ${+offset}`, params);
  // Compute scrape_tier server-side — single source of truth for the 刮削 icon.
  for (const f of rows) f.scrape_tier = computeScrapeTier(f, scrapedShapeFromRow(f, ignoreScript), ignoreScript);
  return { total, page:+page, limit:+limit, rows };
}

export function libraryStats(db) {
  const base = db.get(`SELECT
    COUNT(DISTINCT f.id) AS total,
    COUNT(DISTINCT f.album) AS albums,
    COUNT(DISTINCT f.artist) AS artists,
    SUM(f.size) AS totalBytes,
    SUM(CASE WHEN f.fingerprint IS NOT NULL THEN 1 ELSE 0 END) AS withFP
    FROM files f`) || {};
  const scraped = (db.get(`SELECT COUNT(DISTINCT sm.file_id) n FROM scraped_meta sm
    WHERE sm.title IS NOT NULL AND sm.title!='' AND sm.source!='none'`) || {n:0}).n;
  const dupFiles = (db.get(`SELECT COUNT(DISTINCT gt.file_id) n FROM group_tracks gt
    JOIN dup_groups g ON g.id=gt.group_id WHERE g.resolved=0`) || {n:0}).n;
  const dupGroups = (db.get(`SELECT COUNT(*) n FROM dup_groups WHERE resolved=0`) || {n:0}).n;
  // savings_bytes: sum of sizes of files marked keep=0 (non-keep tracks) in unresolved groups
  const dupBytes  = (db.get(`SELECT SUM(f.size) n FROM files f
    JOIN group_tracks gt ON gt.file_id=f.id
    JOIN dup_groups g ON g.id=gt.group_id
    WHERE g.resolved=0 AND gt.file_id != g.smart_keep_file_id`) || {n:0}).n || 0;
  const dupTotalBytes = (db.get(`SELECT SUM(f.size) n FROM files f
    JOIN group_tracks gt ON gt.file_id=f.id
    JOIN dup_groups g ON g.id=gt.group_id WHERE g.resolved=0`) || {n:0}).n || 0;
  const formats = db.all(`SELECT format, COUNT(*) n FROM files GROUP BY format ORDER BY n DESC LIMIT 10`);
  return { ...base, scraped, dupFiles, dupGroups, dupBytes, dupTotalBytes, formats,
    scrapedAlbums: (db.get(`SELECT COUNT(DISTINCT f.album) n FROM files f JOIN scraped_meta sm ON sm.file_id=f.id WHERE sm.title IS NOT NULL AND sm.source!='none'`)||{n:0}).n,
    scrapedArtists: (db.get(`SELECT COUNT(DISTINCT f.artist) n FROM files f JOIN scraped_meta sm ON sm.file_id=f.id WHERE sm.title IS NOT NULL AND sm.source!='none'`)||{n:0}).n,
    dupAlbums: (db.get(`SELECT COUNT(DISTINCT f.album) n FROM files f JOIN group_tracks gt ON gt.file_id=f.id JOIN dup_groups g ON g.id=gt.group_id WHERE g.resolved=0`)||{n:0}).n,
    dupArtists: (db.get(`SELECT COUNT(DISTINCT f.artist) n FROM files f JOIN group_tracks gt ON gt.file_id=f.id JOIN dup_groups g ON g.id=gt.group_id WHERE g.resolved=0`)||{n:0}).n,
  };
}
