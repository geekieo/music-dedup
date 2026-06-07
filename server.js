// server.js — MusicDedup Express server
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { exec } from 'child_process';

import {
  getDB, statsQuery, getGroups, getGroupDetail, resolveGroup,
  setTrackKeep, getAllSettings, getSetting, setSetting,
  addWhitelist, removeWhitelist, getWhitelist, getFileById,
} from './lib/db.js';
import { runEnumerate, runMetadata, runFingerprint } from './lib/scanner.js';
import { runMatcher } from './lib/matcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = parseInt(process.env.PORT || '3456');
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = getDB();

// ── Scan state ────────────────────────────────────────────────────────────
let scanState = { running:false, abortFlag:false, phase:'idle', pct:0, message:'', startTime:null };
const sseClients = new Set();

function broadcast(data) {
  Object.assign(scanState, data);
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch {} }
}

// ── Trash helper ──────────────────────────────────────────────────────────
async function trashFile(filePath) {
  try {
    const { default: trash } = await import('trash');
    await trash(filePath);
    return { ok: true };
  } catch {
    try {
      const { renameSync } = await import('fs');
      renameSync(filePath, filePath + '.deleted');
      return { ok: true, method: 'renamed' };
    } catch (e) { return { ok: false, error: e.message }; }
  }
}

// ── Open in file manager ──────────────────────────────────────────────────
function revealInExplorer(filePath) {
  return new Promise(resolve => {
    let cmd;
    if (process.platform === 'win32')
      cmd = `explorer /select,"${filePath.replace(/\//g,'\\')}"`;
    else if (process.platform === 'darwin')
      cmd = `open -R "${filePath}"`;
    else
      cmd = `xdg-open "${path.dirname(filePath)}"`;
    exec(cmd, err => resolve(!err));
  });
}

// ═════════════════════════════════════════════════════════════════════════
// API Routes
// ═════════════════════════════════════════════════════════════════════════

// Stats
app.get('/api/stats', (_req, res) => {
  try { res.json({ ok:true, data: statsQuery(db) }); }
  catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});

// Settings
app.get('/api/settings', (_req, res) => res.json({ ok:true, data: getAllSettings(db) }));
app.put('/api/settings', (req, res) => {
  for (const [k,v] of Object.entries(req.body)) setSetting(db, k, v);
  res.json({ ok:true });
});

// ── Duplicate groups ──────────────────────────────────────────────────────
app.get('/api/duplicates', (req, res) => {
  const resolved = req.query.resolved !== undefined ? req.query.resolved === '1' : undefined;
  res.json({ ok:true, data: getGroups(db, { resolved }) });
});

app.get('/api/duplicates/:id', (req, res) => {
  const g = getGroupDetail(db, parseInt(req.params.id));
  if (!g) return res.status(404).json({ ok:false, error:'Not found' });
  res.json({ ok:true, data: g });
});

app.post('/api/duplicates/:id/resolve', async (req, res) => {
  const g = getGroupDetail(db, parseInt(req.params.id));
  if (!g) return res.status(404).json({ ok:false, error:'Not found' });
  const dels = g.tracks.filter(t => !t.keep);
  const results = [];
  for (const t of dels) {
    if (existsSync(t.path)) results.push({ path:t.path, ...(await trashFile(t.path)) });
    else results.push({ path:t.path, ok:true, method:'already_missing' });
  }
  resolveGroup(db, parseInt(req.params.id));
  res.json({ ok:true, deleted: results });
});

app.post('/api/duplicates/resolve-all', async (req, res) => {
  const pending = getGroups(db, { resolved: false });
  let deletedCount = 0, errorCount = 0;
  for (const g of pending) {
    const detail = getGroupDetail(db, g.id);
    if (!detail) continue;
    for (const t of detail.tracks.filter(t => !t.keep)) {
      if (existsSync(t.path)) { const r = await trashFile(t.path); r.ok ? deletedCount++ : errorCount++; }
    }
    resolveGroup(db, g.id);
  }
  res.json({ ok:true, deletedCount, errorCount, groupsProcessed: pending.length });
});

app.put('/api/duplicates/:id/tracks/:fileId/keep', (req, res) => {
  const groupId = parseInt(req.params.id);
  const fileId  = parseInt(req.params.fileId);
  const { keep, reason } = req.body;
  const group = getGroupDetail(db, groupId);
  if (!group) return res.status(404).json({ ok:false, error:'Not found' });
  if (keep) {
    for (const t of group.tracks)
      setTrackKeep(db, groupId, t.id, t.id===fileId, t.id===fileId?(reason||'手动指定保留'):'手动指定删除', 1);
  } else {
    const keepCount = group.tracks.filter(t => t.keep && t.id !== fileId).length;
    if (keepCount === 0) return res.status(400).json({ ok:false, error:'至少保留一个版本' });
    setTrackKeep(db, groupId, fileId, false, '手动指定删除', 1);
  }
  res.json({ ok:true, data: getGroupDetail(db, groupId) });
});

// ── File operations ───────────────────────────────────────────────────────
app.get('/api/files/:id', (req, res) => {
  const f = getFileById(db, parseInt(req.params.id));
  if (!f) return res.status(404).json({ ok:false, error:'Not found' });
  res.json({ ok:true, data: f });
});

app.post('/api/files/:id/reveal', async (req, res) => {
  const f = getFileById(db, parseInt(req.params.id));
  if (!f) return res.status(404).json({ ok:false, error:'Not found' });
  await revealInExplorer(f.path);
  res.json({ ok:true });
});

// ── Whitelist ─────────────────────────────────────────────────────────────
app.get('/api/whitelist', (_req, res) => res.json({ ok:true, data: getWhitelist(db) }));

app.post('/api/whitelist/:fileId', (req, res) => {
  const fileId = parseInt(req.params.fileId);
  const f = getFileById(db, fileId);
  if (!f) return res.status(404).json({ ok:false, error:'Not found' });
  addWhitelist(db, fileId);
  res.json({ ok:true });
});

app.delete('/api/whitelist/:fileId', (req, res) => {
  removeWhitelist(db, parseInt(req.params.fileId));
  res.json({ ok:true });
});

// ── SSE ───────────────────────────────────────────────────────────────────
app.get('/api/scan/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ ...scanState, type:'state' })}\n\n`);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

app.get('/api/scan/status', (_req, res) => res.json({ ok:true, data: scanState }));

// ── Scan start — accepts { steps: ['enum','meta','fp','match'], force: bool } ─
app.post('/api/scan/start', async (req, res) => {
  if (scanState.running) return res.status(409).json({ ok:false, error:'已有扫描进行中' });

  const settings   = getAllSettings(db);
  const dirs       = settings.scan_dirs      || [];
  const exclude    = settings.exclude_patterns || [];
  const threads    = parseInt(settings.threads  || '8');
  const threshold  = parseInt(settings.threshold || '95');
  const smartScan  = settings.smart_scan !== false;

  const steps   = req.body?.steps || ['enum','meta','fp','match'];
  const force   = req.body?.force === true;  // force full re-extraction

  if (steps.includes('enum') && !dirs.length)
    return res.status(400).json({ ok:false, error:'未配置扫描目录' });

  res.json({ ok:true, message:'扫描已启动', steps });

  scanState = { running:true, abortFlag:false, phase:'starting', pct:0, message:'准备中...', startTime:Date.now() };
  broadcast({ type:'start', ...scanState });

  const prog = evt => broadcast({ type:'progress', ...evt });
  const abort = () => scanState.abortFlag;

  try {
    if (steps.includes('enum') && !abort())
      await runEnumerate(db, { dirs, exclude, onProgress:prog, onAbort:abort });

    if (steps.includes('meta') && !abort())
      await runMetadata(db, { threads, smartScan: force ? false : smartScan, onProgress:prog, onAbort:abort });

    if (steps.includes('fp') && !abort())
      await runFingerprint(db, { threads, smartScan: force ? false : smartScan, onProgress:prog, onAbort:abort });

    if (steps.includes('match') && !abort())
      await runMatcher(db, { threshold, onProgress:prog, onAbort:abort });

  } catch (err) {
    prog({ phase:'error', pct:0, message:`扫描失败: ${err.message}` });
  } finally {
    scanState.running = false;
    broadcast({ type:'done', ...scanState });
  }
});

app.post('/api/scan/abort', (_req, res) => {
  if (!scanState.running) return res.json({ ok:false, error:'无扫描进行中' });
  scanState.abortFlag = true;
  res.json({ ok:true });
});

// Serve SPA
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, HOST, () => {
  console.log(`\n🎵  MusicDedup 已启动`);
  console.log(`   本地访问: http://localhost:${PORT}`);
  console.log(`   数据库:   ${process.env.DB_PATH || 'data/musicdedup.db'}\n`);
});
