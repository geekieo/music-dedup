// server.js — MusicDedup server
import express from 'express';
import cors from 'cors';
import path from 'path';
import { createReadStream, existsSync, statSync, renameSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

import {
  getDB, statsQuery, getGroups, getGroupDetail, resolveGroup,
  getAllSettings, setSetting,
  addRetentionList, removeRetentionList, getRetentionList, getRetentionFileIds, getExcludeFileIds, getFileById,
  queryLibrary, queryLibraryByTier, locateFileInLibrary, libraryStats, getScrapedMeta,
  getTagSnapshots, getWriteHistory, upsertScrapedMeta,
} from './lib/db.js';
import { runEnumerate, runMetadata, runFingerprint } from './lib/scanner.js';
import { runScrapeMatcher, runBasicMatcher, runFpMatcher } from './lib/matcher.js';
import { runScrape, scrapeSingleFile, getMbCandidates, getAcoustidCandidates } from './lib/scraper.js';
import { renameFile, readTagsFromFile, writeTagsWithSnapshot, revertFromWriteHistory, getExiftoolStatus } from './lib/tagger.js';
import { detectFpcalc, resetDetection as resetFpcalcDetection } from './lib/chromaprint-bridge.js';
import { computeScrapeTier } from './lib/tier.js';
import { tagTracks, GROUP_TAG_LABELS, GROUP_TAG_DESCRIPTIONS, GROUP_TAG_COLORS,
  PICK_TAG_LABEL, PICK_TAG_COLOR, DEFAULT_PICK_TAG_ORDER,
  MATCHING_METHOD_KEYS, CHARACTERISTIC_TAGS_ARRAY, MATCH_METHOD_TAGS_ARRAY,
  RTYPE_LABEL, DIMENSION_DEFS, DIMENSION_INFO, mergePickOrder, EXCLUSIVE_TAG_GROUPS,
  DEFAULT_TIER_ORDER, TIER_COLOR, TIER_LABEL, computeScrapeMatch } from './lib/rules.js';
import { parseFile } from 'music-metadata';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = parseInt(process.env.PORT || '3456');
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = getDB();

// ── Scan + Scrape state ───────────────────────────────────────────────────
// `paused` is a soft stop: long-running phases check waitIfPaused() at their
// existing batch/phase checkpoints and block there (still cancellable via
// abortFlag while paused) instead of tearing the whole run down.
let scanState = { running:false, abortFlag:false, paused:false, phase:'idle', pct:0, message:'', startTime:null };
const sseClients = new Set();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitIfPaused() {
  while (scanState.paused && !scanState.abortFlag) await sleep(200);
}

function broadcast(data) {
  Object.assign(scanState, data);
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch {} }
}

const LRC_EXTS = new Set(['.lrc','.txt','.lyric','.ass','.srt','.smi','.vtt']);

async function trashFile(fp) {
  const results=[];
  const doTrash=p=>{
    try{renameSync(p,p+'.deleted');return{ok:true};}
    catch(e){return{ok:false,error:e.message};}
  };
  // Trash the main file
  results.push({path:fp,...doTrash(fp)});
  // Trash matching lyric files (same basename, different ext)
  const dir=path.dirname(fp);
  const base=path.basename(fp,path.extname(fp));
  for(const ext of LRC_EXTS){
    const lrcPath=path.join(dir,base+ext);
    if(existsSync(lrcPath)) results.push({path:lrcPath,...doTrash(lrcPath)});
  }
  return results;
}

function revealInExplorer(fp) {
  return new Promise(resolve => {
    let cmd = process.platform==='win32' ? `explorer /select,"${fp.replace(/\//g,'\\')}"` :
              process.platform==='darwin' ? `open -R "${fp}"` : `xdg-open "${path.dirname(fp)}"`;
    exec(cmd, err => resolve(!err));
  });
}

// ── Native "choose a folder" dialog ─────────────────────────────────────
// This server and the browser hitting it are assumed to be on the same
// machine (a local desktop tool) — so a server-spawned OS-native picker is
// equivalent to a client-native one, with no extra dependency (no Electron).
function pickFolderDialog() {
  return new Promise(resolve => {
    let cmd;
    if (process.platform === 'darwin') {
      cmd = `osascript -e 'POSIX path of (choose folder with prompt "选择要添加到音乐库的文件夹")'`;
    } else if (process.platform === 'win32') {
      cmd = `powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description='选择要添加到音乐库的文件夹'; if($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){Write-Output $f.SelectedPath}"`;
    } else {
      cmd = `zenity --file-selection --directory --title="选择要添加到音乐库的文件夹" 2>/dev/null || kdialog --getexistingdirectory ~ --title "选择要添加到音乐库的文件夹" 2>/dev/null`;
    }
    exec(cmd, { timeout: 5*60*1000 }, (err, stdout) => {
      if (err) { resolve(null); return; } // user cancelled, or no dialog tool available
      const p = stdout.toString().trim();
      resolve(p || null);
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════
app.get('/api/stats', (_,res)=>{ try{res.json({ok:true,data:statsQuery(db)});}catch(e){res.status(500).json({ok:false,error:e.message})}});
app.get('/api/settings', (_,res)=>res.json({ok:true,data:getAllSettings(db)}));
app.put('/api/settings', (req,res)=>{ for(const[k,v] of Object.entries(req.body))setSetting(db,k,v); res.json({ok:true}); });

// Serve tag metadata as JS globals for the client (single source: lib/rules.js)
app.get('/rules-meta.js', (_,res)=>{
  // Serialize DIMENSION_DEFS manually — cell functions can't go through JSON
  const dimItems = DIMENSION_DEFS.map(d =>
    `{key:${JSON.stringify(d.key)},label:${JSON.stringify(d.label)},icon:${JSON.stringify(d.icon)},cell:${d.cell.toString()}}`
  ).join(',');
  res.type('application/javascript');
  res.send([
    `const GROUP_TAG_LABELS=${JSON.stringify(GROUP_TAG_LABELS)};`,
    `const GROUP_TAG_DESCRIPTIONS=${JSON.stringify(GROUP_TAG_DESCRIPTIONS)};`,
    `const GROUP_TAG_COLORS=${JSON.stringify(GROUP_TAG_COLORS)};`,
    `const PICK_TAG_LABEL=${JSON.stringify(PICK_TAG_LABEL)};`,
    `const PICK_TAG_COLOR=${JSON.stringify(PICK_TAG_COLOR)};`,
    `const DEFAULT_PICK_TAG_ORDER=${JSON.stringify(DEFAULT_PICK_TAG_ORDER)};`,
    `const DEFAULT_PICK=DEFAULT_PICK_TAG_ORDER;`,
    `const MATCH_METHOD_TAGS=new Set(${JSON.stringify([...MATCHING_METHOD_KEYS])});`,
    `const MATCH_METHOD_TAGS_ARRAY=${JSON.stringify(MATCH_METHOD_TAGS_ARRAY)};`,
    `const CHARACTERISTIC_TAGS=new Set(${JSON.stringify(CHARACTERISTIC_TAGS_ARRAY)});`,
    `const CHARACTERISTIC_TAGS_ARRAY=${JSON.stringify(CHARACTERISTIC_TAGS_ARRAY)};`,
    `const EXCLUSIVE_TAG_GROUPS=${JSON.stringify(EXCLUSIVE_TAG_GROUPS)};`,
    `const RTYPE_LABEL=${JSON.stringify(RTYPE_LABEL)};`,
    `const DIMENSION_COLUMNS=[${dimItems}];`,
    `const DIMENSION_INFO=${JSON.stringify(DIMENSION_INFO)};`,
    `const mergePickOrder=${mergePickOrder.toString()};`,
    `const DEFAULT_Q=${JSON.stringify(DEFAULT_TIER_ORDER)};`,
    `const TIER_COLOR=${JSON.stringify(TIER_COLOR)};`,
    `const TIER_LABEL=${JSON.stringify(TIER_LABEL)};`,
    `const computeScrapeMatch=${computeScrapeMatch.toString()};`,
  ].join('\n'));
});

// ── Native folder picker — opens an OS-native "choose folder" dialog on the
// machine running this server (assumed to be the same machine as the browser,
// since this is a local desktop tool) and returns the absolute path chosen.
app.post('/api/browse-folder', async(_,res)=>{
  try { const dir = await pickFolderDialog(); res.json({ ok:true, path: dir||null }); }
  catch(e){ res.json({ ok:false, error:e.message }); }
});

// ── Library ───────────────────────────────────────────────────────────────
app.get('/api/library', (req,res)=>{
  const { search='', sort='title', order='asc', page=1, limit=100, format='', libFilter='all', scrapeTier='' } = req.query;
  try {
    // 繁简忽略 (settings.ignore_script_variant, default true) — see lib/tier.js.
    // Read fresh per-request (not cached) so toggling the setting takes
    // effect on the very next fetch, no rescan needed: tier is a pure
    // display computation over already-scraped data, not stored data.
    const ignoreScript = getAllSettings(db).ignore_script_variant !== false;
    // Tier depends on Traditional/Simplified folding — not expressible in
    // SQL. Needed either when sorting BY tier, or when filtering to a
    // specific 刮削分类 — both fetch the full filtered set, compute tier in
    // JS, sort/filter, then paginate (see queryLibraryByTier).
    if (sort === 'scrape_tier' || scrapeTier) {
      return res.json({ ok:true, data: queryLibraryByTier(db,{search,sort,order,page:+page,limit:+limit,format,libFilter,scrapeTier,ignoreScript}) });
    }
    res.json({ ok:true, data: queryLibrary(db,{search,sort,order,page:+page,limit:+limit,format,libFilter,ignoreScript}) });
  }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
app.get('/api/library/stats', (_,res)=>{
  try{ res.json({ok:true,data:libraryStats(db)}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
// Locate a file's zero-based index under the whole (unfiltered) library for
// a given sort/order — lets the client jump straight to the right page
// instead of paging through results looking for it. See public/app.js
// LibraryView's locate handler.
app.get('/api/library/locate/:id', (req,res)=>{
  try {
    const { sort='title', order='asc' } = req.query;
    const index = locateFileInLibrary(db, +req.params.id, { sort, order });
    res.json({ ok:true, index });
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// ── Files ─────────────────────────────────────────────────────────────────
app.get('/api/files/:id', (req,res)=>{ const f=getFileById(db,+req.params.id); f?res.json({ok:true,data:f}):res.status(404).json({ok:false,error:'Not found'}); });
app.post('/api/files/:id/reveal', async(req,res)=>{ const f=getFileById(db,+req.params.id); if(!f)return res.status(404).json({ok:false}); const fp=existsSync(f.path)?f.path:(existsSync(f.path+'.deleted')?f.path+'.deleted':f.path); await revealInExplorer(fp); res.json({ok:true}); });

// Check if a file belongs to any duplicate group (prefers unresolved groups).
app.get('/api/files/:id/in-group', (req,res)=>{
  try{
    const row = db.get(
      `SELECT gt.group_id FROM group_tracks gt
       JOIN dup_groups g ON g.id=gt.group_id
       WHERE gt.file_id=?
       ORDER BY g.resolved ASC, g.id ASC LIMIT 1`,
      [+req.params.id]
    );
    res.json({ok:true, inGroup: !!row, groupId: row ? row.group_id : null});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// Batch check: which of the given file IDs belong to duplicate groups.
app.post('/api/files/in-groups', (req,res)=>{
  try{
    const {ids} = req.body||{};
    if(!Array.isArray(ids)||!ids.length) return res.json({ok:true,data:{}});
    const placeholders = ids.map(()=>'?').join(',');
    const rows = db.all(
      `SELECT gt.file_id, gt.group_id FROM group_tracks gt
       JOIN dup_groups g ON g.id=gt.group_id
       WHERE gt.file_id IN (${placeholders})
       ORDER BY g.resolved ASC, g.id ASC`,
      ids
    );
    const map = {};
    for(const r of rows){ if(!(r.file_id in map)) map[r.file_id] = r.group_id; }
    for(const id of ids){ if(!(id in map)) map[id] = null; }
    res.json({ok:true, data:map});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.get('/api/files/:id/stream', (req,res)=>{
  const f = getFileById(db,+req.params.id);
  if(!f||!existsSync(f.path)) return res.status(404).json({ok:false,error:'Not found'});
  const ext = path.extname(f.path).toLowerCase();
  const mime = {'.mp3':'audio/mpeg','.flac':'audio/flac','.m4a':'audio/mp4','.ogg':'audio/ogg',
    '.wav':'audio/wav','.aiff':'audio/aiff','.opus':'audio/ogg'}[ext]||'audio/mpeg';
  const stat = statSync(f.path);
  const total = stat.size;
  const lastModified = stat.mtime.toUTCString();
  const etag = `"${f.id}-${stat.size}-${stat.mtimeMs}"`;
  // Local files never change under our feet during a session — letting the
  // browser cache the response avoids re-reading the same bytes from disk on
  // every replay/seek/scrub, which was the main source of perceived playback
  // start-up delay (especially for large lossless files).
  res.setHeader('Cache-Control','private, max-age=86400');
  res.setHeader('Last-Modified', lastModified);
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match']===etag) { res.status(304).end(); return; }
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m && m[1] ? parseInt(m[1]) : 0;
    const end   = m && m[2] ? parseInt(m[2]) : total - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${total}`,'Accept-Ranges':'bytes','Content-Length':chunkSize,'Content-Type':mime});
    createReadStream(f.path,{start,end}).pipe(res);
  } else {
    res.writeHead(200,{'Content-Length':total,'Content-Type':mime,'Accept-Ranges':'bytes'});
    createReadStream(f.path).pipe(res);
  }
});

// On-demand cover-art extraction. The bulk metadata scan deliberately skips
// embedded pictures (parseFile(..., {skipCovers:true})) to stay fast across
// a whole library — covers are only ever needed for whichever one track is
// currently playing, so we just re-read that single file's picture here.
app.get('/api/files/:id/cover', async(req,res)=>{
  const f = getFileById(db,+req.params.id);
  if(!f||!existsSync(f.path)) return res.status(404).end();
  try{
    const meta = await parseFile(f.path,{ duration:false, skipCovers:false });
    const pic = meta?.common?.picture?.[0];
    if(!pic) return res.status(404).end();
    res.setHeader('Content-Type', pic.format||'image/jpeg');
    res.setHeader('Cache-Control','private, max-age=86400');
    res.end(Buffer.from(pic.data));
  }catch{ res.status(404).end(); }
});

app.post('/api/files/:id/rename', (req,res)=>{
  const { newName } = req.body;
  if(!newName) return res.status(400).json({ok:false,error:'newName required'});
  res.json(renameFile(db,+req.params.id,newName));
});

// Read actual file tags (from the audio file itself, not the database)
app.get('/api/files/:id/live-tags', async(req,res)=>{
  const f = getFileById(db,+req.params.id);
  if(!f) return res.status(404).json({ok:false,error:'Not found'});
  try{ res.json({ok:true,data:await readTagsFromFile(f.path)}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// On-demand single-file scrape (called from ScrapeDialog)
app.post('/api/files/:id/scrape-single', async(req,res)=>{
  const s = getAllSettings(db);
  try{
    const dual = await scrapeSingleFile(db,+req.params.id,s.acoustid_key||'', { skipMb: req.query.skip_mb==='1' });
    if (!dual) return res.json({ok:true, data:null});
    const f = getFileById(db, +req.params.id);
    const ignoreScript = s.ignore_script_variant !== false;
    // Attach per-source scrape_tier
    const mb  = dual.mb  ? { ...dual.mb,  scrape_tier: f ? computeScrapeTier(f, dual.mb, ignoreScript) : null } : null;
    const aid = dual.acoustid ? { ...dual.acoustid, scrape_tier: f ? computeScrapeTier(f, dual.acoustid, ignoreScript) : null } : null;
    const overallTier = (() => {
      const tiers = [mb?.scrape_tier, aid?.scrape_tier].filter(Boolean);
      if (!tiers.length) return null;
      if (tiers.includes('blue')) return 'blue';
      if (tiers.includes('green')) return 'green';
      if (tiers.includes('yellow')) return 'yellow';
      return 'red';
    })();
    res.json({ok:true, data:{ mb, acoustid: aid, scrape_tier: overallTier }});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// MB search candidates (returns all candidates with scores, no DB save)
app.get('/api/files/:id/mb-candidates', async(req,res)=>{
  const f = getFileById(db,+req.params.id);
  if(!f) return res.status(404).json({ok:false,error:'Not found'});
  try{
    const candidates = await getMbCandidates(f);
    res.json({ok:true, data: candidates});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// AcoustID candidates (returns all fingerprint matches with scores, no DB save)
app.get('/api/files/:id/acoustid-candidates', async(req,res)=>{
  const f = getFileById(db,+req.params.id);
  if(!f) return res.status(404).json({ok:false,error:'Not found'});
  try{
    const s = getAllSettings(db);
    const { candidates, error } = await getAcoustidCandidates(f, s.acoustid_key||'');
    res.json({ok:true, data: candidates, error: error || null});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// Save a selected MB candidate as the scraped result
app.post('/api/files/:id/select-mb', (req,res)=>{
  const f = getFileById(db,+req.params.id);
  if(!f) return res.status(404).json({ok:false,error:'Not found'});
  try{
    const { candidate } = req.body;
    if(!candidate) return res.status(400).json({ok:false,error:'candidate required'});
    upsertScrapedMeta(db, { ...candidate, file_id: f.id, source: 'musicbrainz', scraped_at: Date.now() });
    res.json({ok:true});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// Save a selected AcoustID candidate as the scraped result
app.post('/api/files/:id/select-acoustid', (req,res)=>{
  const f = getFileById(db,+req.params.id);
  if(!f) return res.status(404).json({ok:false,error:'Not found'});
  try{
    const { candidate } = req.body;
    if(!candidate) return res.status(400).json({ok:false,error:'candidate required'});
    upsertScrapedMeta(db, { ...candidate, file_id: f.id, source: 'acoustid', scraped_at: Date.now() });
    res.json({ok:true});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// Safe tag write with snapshot (three-phase: snapshot → write → verify)
app.post('/api/files/:id/write-tags', async(req,res)=>{
  const {fields} = req.body;
  if(!fields||!Object.keys(fields).length) return res.status(400).json({ok:false,error:'fields required'});
  try{ res.json(await writeTagsWithSnapshot(db,+req.params.id,fields)); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// Scrape data CRUD
app.get('/api/files/:id/scraped', (req,res)=>{
  const dual = getScrapedMeta(db,+req.params.id);
  if (!dual.mb && !dual.acoustid) return res.json({ok:true, data:null});
  const f = getFileById(db, +req.params.id);
  const ignoreScript = getAllSettings(db).ignore_script_variant !== false;
  // Compute tier for each source independently, plus overall best tier
  const mb  = dual.mb  ? { ...dual.mb,  scrape_tier: f ? computeScrapeTier(f, dual.mb, ignoreScript) : null } : null;
  const aid = dual.acoustid ? { ...dual.acoustid, scrape_tier: f ? computeScrapeTier(f, dual.acoustid, ignoreScript) : null } : null;
  // Overall tier: blue > green > yellow > red. Null if no tiers at all.
  const overallTier = (() => {
    const tiers = [mb?.scrape_tier, aid?.scrape_tier].filter(Boolean);
    if (!tiers.length) return null;
    if (tiers.includes('blue')) return 'blue';
    if (tiers.includes('green')) return 'green';
    if (tiers.includes('yellow')) return 'yellow';
    return 'red';
  })();
  res.json({ok:true, data:{ mb, acoustid: aid, scrape_tier: overallTier }});
});
app.delete('/api/files/:id/scraped', (req,res)=>{
  try { db.run('DELETE FROM scraped_meta WHERE file_id=?',[+req.params.id]); res.json({ok:true}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// Tag snapshots (write history + revert)
app.get('/api/files/:id/snapshots', (req,res)=>{
  res.json({ok:true,data:getTagSnapshots(db,+req.params.id)});
});
app.get('/api/snapshots', (_,res)=>{
  // Auto-purge entries past their 30-day retention window
  db.run('DELETE FROM write_history WHERE expires_at > 0 AND expires_at < ?', [Date.now()]);
  res.json({ok:true, data: getWriteHistory(db)});
});
app.post('/api/snapshots/:fileId/revert', async(req,res)=>{
  try{ res.json(await revertFromWriteHistory(db, +req.params.fileId)); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
app.delete('/api/snapshots/:fileId', (req,res)=>{
  db.run('DELETE FROM write_history WHERE file_id=?', [+req.params.fileId]);
  res.json({ok:true});
});

// exiftool availability (shown in ScrapeDialog write section)
app.get('/api/system/exiftool', async(_,res)=>{
  res.json({ok:true,data:await getExiftoolStatus()});
});
app.get('/api/system/fpcalc', async(req,res)=>{
  // ?path=... lets the client live-test a candidate path before saving it.
  // Falls back to the saved setting when no query param is given.
  const s = getAllSettings(db);
  const testPath = req.query.path !== undefined ? req.query.path : (s.fpcalc_path || '');
  if (req.query.path !== undefined) resetFpcalcDetection(); // force fresh check for live test
  const p = await detectFpcalc(testPath);
  res.json({ok:true, data:{
    available: !!p,
    path: p || null,
    usingCustomPath: !!testPath,
    note: p
      ? `fpcalc 已找到（${p}），Chromaprint 声纹将在下次声纹提取时生成`
      : testPath
        ? `在配置的路径中未找到 fpcalc: ${testPath}`
        : 'fpcalc 未安装。将 fpcalc 可执行文件放入项目根目录，或在下方填写路径',
  }});
});

// ── Retention list ───────────────────────────────────────────────────────
app.get('/api/retention-list', (_,res)=>res.json({ok:true,data:getRetentionList(db)}));
app.post('/api/retention-list/:fileId', (req,res)=>{ const f=getFileById(db,+req.params.fileId); if(!f)return res.status(404).json({ok:false}); addRetentionList(db,+req.params.fileId); res.json({ok:true}); });
app.delete('/api/retention-list/:fileId', (req,res)=>{ removeRetentionList(db,+req.params.fileId); res.json({ok:true}); });

// ── Duplicates ────────────────────────────────────────────────────────────

// Compute the set of "kept" file IDs for a group (smart winner ∪ retention list).
// Mirrors evaluateGroup's OR logic so resolve/unresolve/purge are consistent.
function computeKeepSet(tracks) {
  const s = getAllSettings(db);
  const tierOrder = Array.isArray(s.quality_tiers) && s.quality_tiers.length ? s.quality_tiers : null;
  const pickTagOrder = Array.isArray(s.pick_tag_order) && s.pick_tag_order.length ? s.pick_tag_order : null;
  const retentionFileIds = getRetentionFileIds(db);
  const excludeFileIds = getExcludeFileIds(db);
  const annotated = tagTracks(tracks, tierOrder, pickTagOrder, retentionFileIds, excludeFileIds);
  return new Set(annotated.filter(t => t._keepWinner).map(t => t.id));
}
app.get('/api/duplicates', (req,res)=>{
  const resolved = req.query.resolved!==undefined ? req.query.resolved==='1' : undefined;
  res.setHeader('Cache-Control','no-store');
  res.json({ok:true, data:getGroups(db,{resolved})});
});
app.get('/api/duplicates/:id', (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const g=getGroupDetail(db,+req.params.id);
  if(!g) return res.status(404).json({ok:false});
  const s=getAllSettings(db);
  const tierOrder=Array.isArray(s.quality_tiers)&&s.quality_tiers.length?s.quality_tiers:null;
  const pickTagOrder=Array.isArray(s.pick_tag_order)&&s.pick_tag_order.length?s.pick_tag_order:null;
  const retentionFileIds=getRetentionFileIds(db);
  const excludeFileIds=getExcludeFileIds(db);
  g.tracks=tagTracks(g.tracks,tierOrder,pickTagOrder,retentionFileIds,excludeFileIds);
  res.json({ok:true,data:g});
});
app.post('/api/duplicates/:id/resolve', async(req,res)=>{
  const g=getGroupDetail(db,+req.params.id); if(!g)return res.status(404).json({ok:false});
  const keepSet=computeKeepSet(g.tracks);
  const dels=g.tracks.filter(t=>!keepSet.has(t.id));
  if(dels.length===0) return res.status(400).json({ok:false,error:'该组没有需要删除的文件——所有曲目均为保留状态，无需处理。'});
  const results=[];
  for(const t of dels){
    if(!existsSync(t.path)){ results.push({path:t.path,ok:true,method:'missing'}); continue; }
    const r=await trashFile(t.path); results.push(...r);
  }
  resolveGroup(db,+req.params.id); res.json({ok:true,deleted:results});
});
app.post('/api/duplicates/resolve-all', async(req,res)=>{
  const ids=req.body?.ids; // optional: only resolve specific group IDs
  const pending=getGroups(db,{resolved:false}).filter(g=>!ids||ids.includes(g.id));
  let del=0,err=0;
  for(const g of pending){
    const d=getGroupDetail(db,g.id); if(!d)continue;
    const keepSet=computeKeepSet(d.tracks);
    const dels=d.tracks.filter(t=>!keepSet.has(t.id));
    if(dels.length===0) continue;
    for(const t of dels){
      if(!existsSync(t.path)) continue;
      const results=await trashFile(t.path);
      for(const r of results) r.ok?del++:err++;
    }
    resolveGroup(db,g.id);
  }
  res.json({ok:true,deletedCount:del,errorCount:err,groupsProcessed:pending.length});
});
// 撤销：恢复 .deleted 文件，标记组为未处理
app.post('/api/duplicates/:id/unresolve', (req,res)=>{
  const g=getGroupDetail(db,+req.params.id); if(!g)return res.status(404).json({ok:false});
  const keepSet=computeKeepSet(g.tracks);
  const restored=[], failed=[];
  for(const t of g.tracks.filter(t=>!keepSet.has(t.id))){
    // Restore main file
    const delPath=t.path+'.deleted';
    if(existsSync(delPath)){ try{renameSync(delPath,t.path);restored.push(t.path);}catch(e){failed.push({path:t.path,error:e.message});} }
    // Restore matching lyric files
    const dir=path.dirname(t.path);
    const base=path.basename(t.path,path.extname(t.path));
    for(const ext of LRC_EXTS){
      const lrcDel=path.join(dir,base+ext+'.deleted');
      if(existsSync(lrcDel)){ try{renameSync(lrcDel,path.join(dir,base+ext));restored.push(lrcDel);}catch(e){failed.push({path:lrcDel,error:e.message});} }
    }
  }
  db.run('UPDATE dup_groups SET resolved=0,resolved_time=NULL WHERE id=?',[+req.params.id]);
  res.json({ok:true,restored,failed});
});
// 批量撤销
app.post('/api/duplicates/unresolve-all', (req,res)=>{
  const ids=req.body?.ids;
  const groups=getGroups(db,{resolved:true}).filter(g=>!ids||ids.includes(g.id));
  let totalRestored=0, groupsRestored=0;
  for(const g of groups){
    const d=getGroupDetail(db,g.id); if(!d)continue;
    const keepSet=computeKeepSet(d.tracks);
    let restored=[];
    for(const t of d.tracks.filter(t=>!keepSet.has(t.id))){
      const delPath=t.path+'.deleted';
      if(existsSync(delPath)){ try{renameSync(delPath,t.path);restored.push(t.path);}catch(e){} }
      const dir2=path.dirname(t.path);
      const base2=path.basename(t.path,path.extname(t.path));
      for(const ext of LRC_EXTS){
        const lrcDel=path.join(dir2,base2+ext+'.deleted');
        if(existsSync(lrcDel)){ try{renameSync(lrcDel,path.join(dir2,base2+ext));restored.push(lrcDel);}catch(e){} }
      }
    }
    db.run('UPDATE dup_groups SET resolved=0,resolved_time=NULL WHERE id=?',[g.id]);
    groupsRestored++;
    totalRestored+=restored.length;
  }
  res.json({ok:true,restoredCount:totalRestored,groupsRestored});
});
// 彻底删除已处理组的 .deleted 文件（单组）
app.post('/api/duplicates/:id/purge', (req,res)=>{
  const g=getGroupDetail(db,+req.params.id); if(!g)return res.status(404).json({ok:false});
  if(!g.resolved)return res.status(400).json({ok:false,error:'该组尚未处理'});
  const result=purgeGroupFiles(db,g);
  res.json({ok:true,...result});
});
// 清空回收站：永久删除所有已处理组的 .deleted 文件 + 清理数据库
app.post('/api/trash/empty', (req,res)=>{
  const ids=req.body?.ids;
  const groups=getGroups(db,{resolved:true}).filter(g=>!ids||ids.includes(g.id));
  let totalDeleted=0, totalFailed=0, totalRemoved=0;
  for(const g of groups){
    const d=getGroupDetail(db,g.id); if(!d)continue;
    const r=purgeGroupFiles(db,d);
    totalDeleted+=r.deletedCount;
    totalFailed+=r.failedCount;
    if(r.groupRemoved) totalRemoved++;
  }
  res.json({ok:true,deletedCount:totalDeleted,failedCount:totalFailed,groupsRemoved:totalRemoved,totalGroups:groups.length});
});

function purgeGroupFiles(db, g) {
  let deleted=0, failed=0;
  const purgeIds=[];
  const keepSet=computeKeepSet(g.tracks);
  for(const t of g.tracks.filter(t=>!keepSet.has(t.id))){
    const delPath=t.path+'.deleted';
    if(existsSync(delPath)){ try{unlinkSync(delPath);deleted++;}catch(e){failed++;} }
    const dir=path.dirname(t.path);
    const base=path.basename(t.path,path.extname(t.path));
    for(const ext of LRC_EXTS){
      const lrcDel=path.join(dir,base+ext+'.deleted');
      if(existsSync(lrcDel)){ try{unlinkSync(lrcDel);deleted++;}catch(e){failed++;} }
    }
    purgeIds.push(t.id);
  }
  // Remove purged tracks from group_tracks; if file has no other group refs, remove from files
  for(const fid of purgeIds){
    db.run('DELETE FROM group_tracks WHERE group_id=? AND file_id=?',[g.id,fid]);
    const refs=db.get('SELECT COUNT(*) n FROM group_tracks WHERE file_id=?',[fid]);
    if(!refs||refs.n===0) db.run('DELETE FROM files WHERE id=?',[fid]);
  }
  // If <2 tracks remain, group is no longer a duplicate → remove entirely
  const remaining=db.all('SELECT file_id FROM group_tracks WHERE group_id=?',[g.id]);
  const groupRemoved=remaining.length<2;
  if(groupRemoved){
    db.run('DELETE FROM group_tracks WHERE group_id=?',[g.id]);
    db.run('DELETE FROM dup_groups WHERE id=?',[g.id]);
  }
  return {deletedCount:deleted,failedCount:failed,groupRemoved};
}
app.put('/api/duplicates/:id/tracks/:fid/keep', (req,res)=>{
  const gid=+req.params.id, fid=+req.params.fid; const {keep,reason}=req.body;
  const g=getGroupDetail(db,gid); if(!g)return res.status(404).json({ok:false});
  if(keep){
    // Remove any existing exclude override first
    removeRetentionList(db,fid);
    // Check whether this track would be a smart winner without any override.
    // If yes, let it revert to smart-retain rather than forcing manual keep.
    const s=getAllSettings(db);
    const tierOrder=Array.isArray(s.quality_tiers)&&s.quality_tiers.length?s.quality_tiers:null;
    const pickTagOrder=Array.isArray(s.pick_tag_order)&&s.pick_tag_order.length?s.pick_tag_order:null;
    const retentionFileIds=getRetentionFileIds(db);
    const excludeFileIds=getExcludeFileIds(db);
    const annotated=tagTracks(g.tracks,tierOrder,pickTagOrder,retentionFileIds,excludeFileIds);
    const track=annotated.find(t=>t.id===fid);
    if(!track||!track._keepWinner){
      // Not a smart winner — needs manual keep
      addRetentionList(db,fid,reason||'手动保留',1);
    }
    // If it IS a smart winner, we're done — just removed the exclude override
  } else {
    // Remove any manual-keep entry, then add an exclude override so
    // smart-winner tracks can also be toggled to "delete" state.
    removeRetentionList(db,fid);
    // Check whether this track would still be a smart winner after removal
    const s=getAllSettings(db);
    const tierOrder=Array.isArray(s.quality_tiers)&&s.quality_tiers.length?s.quality_tiers:null;
    const pickTagOrder=Array.isArray(s.pick_tag_order)&&s.pick_tag_order.length?s.pick_tag_order:null;
    const retentionFileIds=getRetentionFileIds(db);
    const excludeFileIds=getExcludeFileIds(db);
    const annotated=tagTracks(g.tracks,tierOrder,pickTagOrder,retentionFileIds,excludeFileIds);
    const track=annotated.find(t=>t.id===fid);
    if(track&&track._keepWinner){
      // Still a smart winner — add exclude override
      addRetentionList(db,fid,null,0);
    }
  }
  // Return updated group detail with recomputed keep
  const updated=getGroupDetail(db,gid);
  if(updated){
    const s=getAllSettings(db);
    const tierOrder=Array.isArray(s.quality_tiers)&&s.quality_tiers.length?s.quality_tiers:null;
    const pickTagOrder=Array.isArray(s.pick_tag_order)&&s.pick_tag_order.length?s.pick_tag_order:null;
    const retentionFileIds=getRetentionFileIds(db);
    const excludeFileIds=getExcludeFileIds(db);
    updated.tracks=tagTracks(updated.tracks,tierOrder,pickTagOrder,retentionFileIds,excludeFileIds);
  }
  res.json({ok:true,data:updated});
});

// ── SSE ───────────────────────────────────────────────────────────────────
app.get('/api/scan/stream', (req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();
  sseClients.add(res);
  res.write(`data: ${JSON.stringify({...scanState,type:'state'})}\n\n`);
  const ping=setInterval(()=>{ try{res.write(': ping\n\n');}catch{} },15000);
  req.on('close',()=>{ clearInterval(ping); sseClients.delete(res); });
});
app.get('/api/scan/status', (_,res)=>res.json({ok:true,data:scanState}));

// ── Scan start ─────────────────────────────────────────────────────────────
app.post('/api/scan/start', async(req,res)=>{
  if(scanState.running)return res.status(409).json({ok:false,error:'已有扫描进行中'});
  const s=getAllSettings(db);
  const dirs=s.scan_dirs||[], exclude=s.exclude_patterns||[];
  const threads=parseInt(s.threads||'8'), threshold=parseInt(s.threshold||'90');
  const durationTolerance=parseInt(s.duration_tolerance||'5');
  const smartScan=s.smart_scan!==false;
  // 全局 8 步执行流程，详见 lib/matcher.js 顶部注释
  //   步骤1 枚举 → 步骤2 提取属性 → 步骤3 属性匹配 → 步骤4 提取声纹
  //   → 步骤5+6 声纹匹配 → 步骤7 刮削 → 步骤8 刮削匹配

  const steps=req.body?.steps||['enum','meta','basicMatch','fp','fpMatch','scrape','scrapeMatch'];
  const force=req.body?.force===true;
  const retryMissed=req.body?.retryMissed===true;
  if(steps.includes('enum')&&!dirs.length)return res.status(400).json({ok:false,error:'未配置扫描目录'});
  res.json({ok:true,message:'扫描已启动',steps});
  scanState={running:true,abortFlag:false,paused:false,phase:'starting',pct:0,level:'info',message:`[${new Date().toLocaleTimeString([],{hour12:false})}] 准备中...`,startTime:Date.now()};
  broadcast({type:'start',...scanState});
  // Mutate scanState in place and broadcast it — broadcasting evt alone would
  // clobber running/paused/abortFlag since the frontend does a full replace.
  const prog=evt=>{
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    Object.assign(scanState, evt.message ? { ...evt, message: `[${ts}] ${evt.message}` } : evt);
    broadcast({type:'progress',...scanState});
  };
  const abort=()=>scanState.abortFlag;
  const pause=waitIfPaused;
  try{
    // 步骤1: 枚举
    if(steps.includes('enum')&&!abort()) await runEnumerate(db,{dirs,exclude,onProgress:prog,onAbort:abort,onPause:pause});
    // 步骤2: 提取属性
    if(steps.includes('meta')&&!abort()) await runMetadata(db,{threads,smartScan:force?false:smartScan,onProgress:prog,onAbort:abort,onPause:pause});
    // 步骤3: 属性匹配（标题分组 + 元数据确认，不依赖声纹）
    if(steps.includes('basicMatch')&&!abort()) await runBasicMatcher(db,{durationTolerance,onProgress:prog,onAbort:abort,onPause:pause});
    // 步骤4: 提取声纹
    if(steps.includes('fp')&&!abort())   await runFingerprint(db,{threads,smartScan:force?false:smartScan,fpcalcPath:s.fpcalc_path||'',onProgress:prog,onAbort:abort,onPause:pause});
    // 步骤5+6: 声纹匹配（频谱声纹 + CP声纹）
    if(steps.includes('fpMatch')&&!abort()) await runFpMatcher(db,{threshold,onProgress:prog,onAbort:abort,onPause:pause});
    // 步骤7: 刮削
    if(steps.includes('scrape')&&!abort()){
      const acoustidKey=s.acoustid_key||'';
      await runScrape(db,{smartScan:force?false:smartScan,retryMissed,acoustidKey,onProgress:prog,onAbort:abort,onPause:pause});
    }
    // 步骤8: 刮削匹配（recording ID 对比）
    if(steps.includes('scrapeMatch')&&!abort()) await runScrapeMatcher(db,{onProgress:prog,onAbort:abort,onPause:pause});
  }catch(e){ prog({phase:'error',pct:0,level:'err',message:`失败: ${e.message}`}); }
  finally{ scanState.running=false; scanState.paused=false; broadcast({type:'done',...scanState}); }
});
app.post('/api/scan/abort', (_,res)=>{ if(!scanState.running)return res.json({ok:false}); scanState.abortFlag=true; scanState.paused=false; broadcast({type:'progress',...scanState}); res.json({ok:true}); });
app.post('/api/scan/pause', (_,res)=>{ if(!scanState.running||scanState.abortFlag)return res.json({ok:false}); scanState.paused=true; const ts=new Date().toLocaleTimeString([],{hour12:false}); broadcast({type:'progress',...scanState,level:'info',message:`[${ts}] 已暂停 · 点击继续以恢复`}); res.json({ok:true}); });
app.post('/api/scan/resume', (_,res)=>{ if(!scanState.running||!scanState.paused)return res.json({ok:false}); scanState.paused=false; const ts=new Date().toLocaleTimeString([],{hour12:false}); broadcast({type:'progress',...scanState,level:'info',message:`[${ts}] 已恢复`}); res.json({ok:true}); });

// Cover art — extracted from embedded file tags
app.get('/api/files/:id/cover', async(req,res)=>{
  try{
    const file=db.get('SELECT path FROM files WHERE id=?',[+req.params.id]);
    if(!file)return res.status(404).end();
    const {parseFile}=await import('music-metadata');
    const meta=await parseFile(file.path,{skipCovers:false,duration:false});
    const pic=meta.common.picture?.[0];
    if(!pic)return res.status(404).end();
    res.setHeader('Content-Type',pic.format||'image/jpeg');
    res.setHeader('Cache-Control','public, max-age=86400');
    res.send(Buffer.from(pic.data));
  }catch{res.status(404).end();}
});

// AcoustID API key validation
app.post('/api/validate-acoustid', async(req,res)=>{
  const { key } = req.body;
  if (!key || !key.trim()) return res.json({ ok:false, error:'请输入 API Key' });
  try {
    // Send a lookup with a minimal (deliberately invalid) fingerprint —
    // if the KEY itself is fine, AcoustID complains about the fingerprint
    // instead, which confirms the key works without needing a real one.
    const params = new URLSearchParams({ client: key.trim(), duration: '240', fingerprint: 'AQAAA', meta: 'recordings' });
    const r = await fetch(`https://api.acoustid.org/v2/lookup?${params}`, {
      headers: { 'User-Agent': 'MusicDedup/1.8' }
    });
    const d = await r.json();
    // Code 4 (not 3) = invalid API key. Also match on message text since
    // AcoustID may change the code; message text is the documented API contract.
    const msg = (d.error?.message || '').toLowerCase();
    const isKeyInvalid = d.status === 'error' && (d.error?.code === 4 || msg.includes('invalid api key') || msg.includes('invalid client'));
    if (d.status === 'ok' || (d.status === 'error' && !isKeyInvalid)) {
      res.json({ ok: true });
    } else {
      const base = d.error?.message || '无效的 API Key';
      // Very often caused by pasting the personal/user key (acoustid.org/api-key,
      // meant for fingerprint submission) instead of an application/client key
      // (acoustid.org/my-applications, needed for lookups) — the two look
      // identical but only the second one works here.
      res.json({ ok: false, error: `${base}（请确认使用的是 acoustid.org/my-applications 注册应用后获得的 "client" 密钥，而不是 acoustid.org/api-key 页面看到的个人 "user" 密钥）` });
    }
  } catch(e) {
    res.json({ ok: false, error: '网络错误: ' + e.message });
  }
});

app.get('*', (_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, HOST, ()=>{
  console.log(`🎵  MusicDedup 已启动`);
  console.log(`   本地访问: http://localhost:${PORT}`);
  console.log(`   数据库:   ${process.env.DB_PATH||'data/musicdedup.db'}`);
  console.log(`   按 Ctrl+C 退出服务\n`);
});
