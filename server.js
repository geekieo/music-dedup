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
  queryLibrary, upsertScrapedMeta, getFilesNeedingScrape, getScrapedMeta,
} from './lib/db.js';
import { runEnumerate, runMetadata, runFingerprint } from './lib/scanner.js';
import { runMatcher } from './lib/matcher.js';
import { runScrape } from './lib/scraper.js';
import { renameFile, applyScrapedToFile, buildFilename } from './lib/tagger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = parseInt(process.env.PORT || '3456');
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = getDB();

// ── Scan + Scrape state ───────────────────────────────────────────────────
let scanState = { running:false, abortFlag:false, phase:'idle', pct:0, message:'', startTime:null };
const sseClients = new Set();

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

// ═════════════════════════════════════════════════════════════════════════
app.get('/api/stats', (_,res)=>{ try{res.json({ok:true,data:statsQuery(db)});}catch(e){res.status(500).json({ok:false,error:e.message})}});
app.get('/api/settings', (_,res)=>res.json({ok:true,data:getAllSettings(db)}));
app.put('/api/settings', (req,res)=>{ for(const[k,v] of Object.entries(req.body))setSetting(db,k,v); res.json({ok:true}); });

// ── Library ───────────────────────────────────────────────────────────────
app.get('/api/library', (req,res)=>{
  const { search='', sort='title', order='asc', page=1, limit=100, format='' } = req.query;
  try { res.json({ ok:true, data: queryLibrary(db,{search,sort,order,page:+page,limit:+limit,format}) }); }
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

app.post('/api/files/:id/rename', (req,res)=>{
  const { newName } = req.body;
  if(!newName) return res.status(400).json({ok:false,error:'newName required'});
  res.json(renameFile(db,+req.params.id,newName));
});

app.post('/api/files/:id/apply-scraped', (req,res)=>{ res.json(applyScrapedToFile(db,+req.params.id)); });

app.get('/api/files/:id/scraped', (req,res)=>{
  const sm = getScrapedMeta(db,+req.params.id);
  res.json({ok:true, data:sm||null});
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
  if(keep){ for(const t of g.tracks)setTrackKeep(db,gid,t.id,t.id===fid,t.id===fid?(reason||'手动指定保留'):'手动指定删除',1); }
  else{ if(!g.tracks.filter(t=>t.keep&&t.id!==fid).length)return res.status(400).json({ok:false,error:'至少保留一个'}); setTrackKeep(db,gid,fid,false,'手动指定删除',1); }
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
  scanState={running:true,abortFlag:false,phase:'starting',pct:0,message:'准备中...',startTime:Date.now()};
  broadcast({type:'start',...scanState});
  const prog=evt=>broadcast({type:'progress',...evt});
  const abort=()=>scanState.abortFlag;
  try{
    if(steps.includes('enum')&&!abort()) await runEnumerate(db,{dirs,exclude,onProgress:prog,onAbort:abort});
    if(steps.includes('meta')&&!abort()) await runMetadata(db,{threads,smartScan:force?false:smartScan,onProgress:prog,onAbort:abort});
    if(steps.includes('fp')&&!abort())   await runFingerprint(db,{threads,smartScan:force?false:smartScan,onProgress:prog,onAbort:abort});
    if(steps.includes('match')&&!abort())await runMatcher(db,{threshold,durationTolerance,qualityTiers,onProgress:prog,onAbort:abort});
    if(steps.includes('scrape')&&!abort()){
      const acoustidKey=s.acoustid_key||'';
      await runScrape(db,{smartScan:force?false:smartScan,acoustidKey,onProgress:prog,onAbort:abort});
    }
  }catch(e){ prog({phase:'error',pct:0,message:`失败: ${e.message}`}); }
  finally{ scanState.running=false; broadcast({type:'done',...scanState}); }
});
app.post('/api/scan/abort', (_,res)=>{ if(!scanState.running)return res.json({ok:false}); scanState.abortFlag=true; res.json({ok:true}); });

app.get('*', (_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, HOST, ()=>{
  console.log(`\n🎵  MusicDedup 已启动`);
  console.log(`   本地访问: http://localhost:${PORT}`);
  console.log(`   数据库:   ${process.env.DB_PATH||'data/musicdedup.db'}`);
  console.log(`   按 Ctrl+C 退出服务\n`);
});
