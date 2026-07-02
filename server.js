// server.js — MusicDedup server
import express from 'express';
import cors from 'cors';
import path from 'path';
import { createReadStream, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

import {
  getDB, statsQuery, getGroups, getGroupDetail, resolveGroup,
  setTrackKeep, getAllSettings, getSetting, setSetting,
  addWhitelist, removeWhitelist, getWhitelist, getFileById,
  queryLibrary, queryLibraryAllForTier, libraryStats, upsertScrapedMeta, getFilesNeedingScrape, getScrapedMeta,
  getTagSnapshots, getAllTagSnapshots, getTagSnapshot, getWriteHistory,
} from './lib/db.js';
import { runEnumerate, runMetadata, runFingerprint } from './lib/scanner.js';
import { runMatcher } from './lib/matcher.js';
import { runScrape, scrapeSingleFile } from './lib/scraper.js';
import { renameFile, readTagsFromFile, writeTagsWithSnapshot, revertFromWriteHistory, buildFilename, getExiftoolStatus } from './lib/tagger.js';
import { detectFpcalc, resetDetection as resetFpcalcDetection } from './lib/chromaprint-bridge.js';
import { computeScrapeTier, tierRank } from './lib/tier.js';
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

async function trashFile(fp) {
  try { const { default: trash } = await import('trash'); await trash(fp); return { ok:true }; }
  catch { try { const { renameSync } = await import('fs'); renameSync(fp, fp+'.deleted'); return { ok:true, method:'renamed' }; }
          catch (e) { return { ok:false, error:e.message }; } }
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

// ── Native folder picker — opens an OS-native "choose folder" dialog on the
// machine running this server (assumed to be the same machine as the browser,
// since this is a local desktop tool) and returns the absolute path chosen.
app.post('/api/browse-folder', async(_,res)=>{
  try { const dir = await pickFolderDialog(); res.json({ ok:true, path: dir||null }); }
  catch(e){ res.json({ ok:false, error:e.message }); }
});

// ── Library ───────────────────────────────────────────────────────────────
app.get('/api/library', (req,res)=>{
  const { search='', sort='title', order='asc', page=1, limit=100, format='', libFilter='all' } = req.query;
  try {
    if (sort === 'scrape_tier') {
      // Tier depends on Traditional/Simplified folding — not expressible in
      // SQL. Fetch the full filtered set, compute tier in JS, sort, paginate.
      const allRows = queryLibraryAllForTier(db, { search, format, libFilter });
      const withTier = allRows.map(f => {
        const scraped = {
          title: f.scraped_title, artist: f.scraped_artist, album: f.scraped_album,
          album_year: f.scraped_album_year || 0, track_number: f.scraped_track_number || 0,
          genre: f.scraped_genre || null, match_basis: f.scrape_match_basis,
          source: f.scrape_source || (f.mb_recording_id ? 'musicbrainz' : 'none'),
        };
        return { ...f, _tier: computeScrapeTier(f, scraped) };
      });
      const dir = order === 'desc' ? -1 : 1;
      withTier.sort((a, b) => dir * (tierRank(a._tier) - tierRank(b._tier)));
      const total = withTier.length;
      const start = (+page - 1) * +limit;
      const rows = withTier.slice(start, start + +limit).map(({ _tier, ...rest }) => rest);
      return res.json({ ok:true, data:{ total, page:+page, limit:+limit, rows } });
    }
    res.json({ ok:true, data: queryLibrary(db,{search,sort,order,page:+page,limit:+limit,format,libFilter}) });
  }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
app.get('/api/library/stats', (_,res)=>{
  try{ res.json({ok:true,data:libraryStats(db)}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// ── Files ─────────────────────────────────────────────────────────────────
app.get('/api/files/:id', (req,res)=>{ const f=getFileById(db,+req.params.id); f?res.json({ok:true,data:f}):res.status(404).json({ok:false,error:'Not found'}); });
app.post('/api/files/:id/reveal', async(req,res)=>{ const f=getFileById(db,+req.params.id); if(!f)return res.status(404).json({ok:false}); await revealInExplorer(f.path); res.json({ok:true}); });

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
    const result = await scrapeSingleFile(db,+req.params.id,s.acoustid_key||'');
    res.json({ok:true,data:result});
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
  const sm = getScrapedMeta(db,+req.params.id);
  res.json({ok:true, data:sm||null});
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

// ── Whitelist ─────────────────────────────────────────────────────────────
app.get('/api/whitelist', (_,res)=>res.json({ok:true,data:getWhitelist(db)}));
app.post('/api/whitelist/:fileId', (req,res)=>{ const f=getFileById(db,+req.params.fileId); if(!f)return res.status(404).json({ok:false}); addWhitelist(db,+req.params.fileId); res.json({ok:true}); });
app.delete('/api/whitelist/:fileId', (req,res)=>{ removeWhitelist(db,+req.params.fileId); res.json({ok:true}); });

// ── Duplicates ────────────────────────────────────────────────────────────
app.get('/api/duplicates', (req,res)=>{
  const resolved = req.query.resolved!==undefined ? req.query.resolved==='1' : undefined;
  res.json({ok:true, data:getGroups(db,{resolved})});
});
app.get('/api/duplicates/:id', (req,res)=>{ const g=getGroupDetail(db,+req.params.id); g?res.json({ok:true,data:g}):res.status(404).json({ok:false}); });
app.post('/api/duplicates/:id/resolve', async(req,res)=>{
  const g=getGroupDetail(db,+req.params.id); if(!g)return res.status(404).json({ok:false});
  const dels=g.tracks.filter(t=>!t.keep); const results=[];
  for(const t of dels){ results.push(existsSync(t.path)?{path:t.path,...await trashFile(t.path)}:{path:t.path,ok:true,method:'missing'}); }
  resolveGroup(db,+req.params.id); res.json({ok:true,deleted:results});
});
app.post('/api/duplicates/resolve-all', async(req,res)=>{
  const pending=getGroups(db,{resolved:false}); let del=0,err=0;
  for(const g of pending){ const d=getGroupDetail(db,g.id); if(!d)continue; for(const t of d.tracks.filter(t=>!t.keep)){if(existsSync(t.path)){const r=await trashFile(t.path);r.ok?del++:err++;}} resolveGroup(db,g.id); }
  res.json({ok:true,deletedCount:del,errorCount:err,groupsProcessed:pending.length});
});
app.put('/api/duplicates/:id/tracks/:fid/keep', (req,res)=>{
  const gid=+req.params.id, fid=+req.params.fid; const {keep,reason}=req.body;
  const g=getGroupDetail(db,gid); if(!g)return res.status(404).json({ok:false});
  if(keep){
    // Only mark the specified track as keep — do NOT touch other tracks' keep state
    setTrackKeep(db,gid,fid,true,reason||'手动指定保留',1);
  } else {
    // Ensure at least one other non-whitelisted track remains as keep
    if(!g.tracks.filter(t=>t.keep&&t.id!==fid&&!t.whitelisted).length)
      return res.status(400).json({ok:false,error:'至少保留一个'});
    setTrackKeep(db,gid,fid,false,'手动指定删除',1);
  }
  res.json({ok:true,data:getGroupDetail(db,gid)});
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
  const qualityTiers=Array.isArray(s.quality_tiers)?s.quality_tiers:null;
  const smartScan=s.smart_scan!==false;
  const steps=req.body?.steps||['enum','meta','fp','match'];
  const force=req.body?.force===true;
  if(steps.includes('enum')&&!dirs.length)return res.status(400).json({ok:false,error:'未配置扫描目录'});
  res.json({ok:true,message:'扫描已启动',steps});
  scanState={running:true,abortFlag:false,paused:false,phase:'starting',pct:0,message:'准备中...',startTime:Date.now()};
  broadcast({type:'start',...scanState});
  const prog=evt=>broadcast({type:'progress',...evt});
  const abort=()=>scanState.abortFlag;
  const pause=waitIfPaused;
  try{
    if(steps.includes('enum')&&!abort()) await runEnumerate(db,{dirs,exclude,onProgress:prog,onAbort:abort,onPause:pause});
    if(steps.includes('meta')&&!abort()) await runMetadata(db,{threads,smartScan:force?false:smartScan,onProgress:prog,onAbort:abort,onPause:pause});
    if(steps.includes('fp')&&!abort())   await runFingerprint(db,{threads,smartScan:force?false:smartScan,fpcalcPath:s.fpcalc_path||'',onProgress:prog,onAbort:abort,onPause:pause});
    // Scrape MUST run before match so mb_recording_id data is available for union logic
    if(steps.includes('scrape')&&!abort()){
      const acoustidKey=s.acoustid_key||'';
      if(acoustidKey) prog({phase:'scrape',pct:0,message:'AcoustID 已配置，将结合 Chromaprint 声纹指纹（fpcalc）进行刮削匹配...'});
      await runScrape(db,{smartScan:force?false:smartScan,acoustidKey,onProgress:prog,onAbort:abort,onPause:pause});
    }
    if(steps.includes('match')&&!abort())await runMatcher(db,{threshold,durationTolerance,qualityTiers,onProgress:prog,onAbort:abort,onPause:pause});
  }catch(e){ prog({phase:'error',pct:0,message:`失败: ${e.message}`}); }
  finally{ scanState.running=false; scanState.paused=false; broadcast({type:'done',...scanState}); }
});
app.post('/api/scan/abort', (_,res)=>{ if(!scanState.running)return res.json({ok:false}); scanState.abortFlag=true; scanState.paused=false; broadcast({type:'progress',...scanState}); res.json({ok:true}); });
app.post('/api/scan/pause', (_,res)=>{ if(!scanState.running||scanState.abortFlag)return res.json({ok:false}); scanState.paused=true; broadcast({type:'progress',...scanState,message:'已暂停 · 点击继续以恢复'}); res.json({ok:true}); });
app.post('/api/scan/resume', (_,res)=>{ if(!scanState.running||!scanState.paused)return res.json({ok:false}); scanState.paused=false; broadcast({type:'progress',...scanState,message:'已恢复'}); res.json({ok:true}); });

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
    // Send a lookup with a minimal valid-format request; AcoustID returns error code 3 for invalid key
    const params = new URLSearchParams({ client: key.trim(), duration: '240', fingerprint: 'AQAAA', meta: 'recordings' });
    const r = await fetch(`https://api.acoustid.org/v2/lookup?${params}`, {
      headers: { 'User-Agent': 'MusicDedup/1.7' }
    });
    const d = await r.json();
    // Error code 3 = invalid API key; code 5 = invalid fingerprint (key itself is valid)
    if (d.status === 'ok' || (d.status === 'error' && d.error?.code !== 3)) {
      res.json({ ok: true });
    } else {
      res.json({ ok: false, error: d.error?.message || '无效的 API Key，请在 acoustid.biz 注册后获取' });
    }
  } catch(e) {
    res.json({ ok: false, error: '网络错误: ' + e.message });
  }
});

app.get('*', (_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, HOST, ()=>{
  console.log(`\n🎵  MusicDedup 已启动`);
  console.log(`   本地访问: http://localhost:${PORT}`);
  console.log(`   数据库:   ${process.env.DB_PATH||'data/musicdedup.db'}`);
  console.log(`   按 Ctrl+C 退出服务\n`);
});
