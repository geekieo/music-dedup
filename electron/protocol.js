// electron/protocol.js — musicdedup:// 自定义协议（应用本体承载）
//
// host 路由：
//   musicdedup://app/...      → 应用本体：静态资源 + /rules-meta.js（生成）+ /cover/<id>
//   musicdedup://stream/...   → 音频流（id 优先，非数字段回退为绝对路径直读）
// app 与 stream 分属不同 host，但 cover 挂 app host 下保证与页面同源（fetch 无需 CORS）。
// 唯一不能走 IPC 的接口是 /rules-meta.js：它是生成的可执行 JS（.toString() 序列化），
// 由 lib/rules.js 运行时生成，保持单一出处。
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { protocol } = require('electron');

import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { getDB } from '../lib/db/index.js';
import { getFileById } from '../lib/db/files.js';
import * as rules from '../lib/rules.js';
import * as rulesUi from '../lib/rules-ui.js';
import { TIER_COLOR, TIER_LABEL, TIER_DESC } from '../lib/tier.js';
import { parseFile } from 'music-metadata';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '..', 'public');
const db = getDB();

const MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.aiff': 'audio/aiff', '.opus': 'audio/ogg',
};
const STATIC_MIME = {
  '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2',
};

// /rules-meta.js 生成（自 server.js 原样移植）—— DIMENSION_DEFS.cell 是函数不能过 JSON。
// 展示常量（GROUP_TAG_*/PICK_TAG_COLOR/DIMENSION_*/TIER_*）来自 lib/rules-ui.js，
// 核心函数（mergePickOrder/computeScrapeMatch/DEFAULT_*）来自 lib/rules.js。
function rulesMetaJs() {
  const dimItems = rulesUi.DIMENSION_DEFS.map((d) =>
    `{key:${JSON.stringify(d.key)},label:${JSON.stringify(d.label)},icon:${JSON.stringify(d.icon)},cell:${d.cell.toString()}}`
  ).join(',');
  return [
    `const GROUP_TAG_LABELS=${JSON.stringify(rulesUi.GROUP_TAG_LABELS)};`,
    `const GROUP_TAG_DESCRIPTIONS=${JSON.stringify(rulesUi.GROUP_TAG_DESCRIPTIONS)};`,
    `const GROUP_TAG_COLORS=${JSON.stringify(rulesUi.GROUP_TAG_COLORS)};`,
    `const PICK_TAG_LABEL=${JSON.stringify(rules.PICK_TAG_LABEL)};`,
    `const PICK_TAG_COLOR=${JSON.stringify(rulesUi.PICK_TAG_COLOR)};`,
    `const DEFAULT_PICK_TAG_ORDER=${JSON.stringify(rules.DEFAULT_PICK_TAG_ORDER)};`,
    `const DEFAULT_PICK=DEFAULT_PICK_TAG_ORDER;`,
    `const MATCH_METHOD_TAGS=new Set(${JSON.stringify([...rules.MATCHING_METHOD_KEYS])});`,
    `const MATCH_METHOD_TAGS_ARRAY=${JSON.stringify(rulesUi.MATCH_METHOD_TAGS_ARRAY)};`,
    `const CHARACTERISTIC_TAGS=new Set(${JSON.stringify(rulesUi.CHARACTERISTIC_TAGS_ARRAY)});`,
    `const CHARACTERISTIC_TAGS_ARRAY=${JSON.stringify(rulesUi.CHARACTERISTIC_TAGS_ARRAY)};`,
    `const EXCLUSIVE_TAG_GROUPS=${JSON.stringify(rulesUi.EXCLUSIVE_TAG_GROUPS)};`,
    `const RTYPE_LABEL=${JSON.stringify(rulesUi.RTYPE_LABEL)};`,
    `const DIMENSION_COLUMNS=[${dimItems}];`,
    `const DIMENSION_INFO=${JSON.stringify(rulesUi.DIMENSION_INFO)};`,
    `const mergePickOrder=${rules.mergePickOrder.toString()};`,
    `const DEFAULT_Q=${JSON.stringify(rules.DEFAULT_TIER_ORDER)};`,
    `const TIER_COLOR=${JSON.stringify(TIER_COLOR)};`,
    `const TIER_LABEL=${JSON.stringify(TIER_LABEL)};`,
    `const TIER_DESC=${JSON.stringify(TIER_DESC)};`,
    `const computeScrapeMatch=${rules.computeScrapeMatch.toString()};`,
  ].join('\n');
}

// 音频流：id 优先（真实曲库），非数字段回退为绝对路径（非库内文件不在 db 中）。
// 路径型 URL 用正斜杠编码（URL 解析器会把自定义 scheme 路径里的反斜杠吃掉——
// 实测 %5C 会被剥离），此处换回平台分隔符。
async function handleStream(request, url) {
  const seg = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const asId = /^\d+$/.test(seg) ? +seg : null;
  let fp = null;
  if (asId) {
    const f = getFileById(db, asId);
    if (f) fp = f.path;
  } else {
    const winPath = seg.replace(/\//g, path.sep);
    if (fs.existsSync(winPath)) fp = winPath;
  }
  if (!fp || !fs.existsSync(fp)) return new Response('Not found', { status: 404 });

  const ext = path.extname(fp).toLowerCase();
  const mime = MIME[ext] || 'audio/mpeg';
  const stat = fs.statSync(fp);
  const total = stat.size;
  const lastModified = stat.mtime.toUTCString();
  // ETag 只用 size+mtime：本地文件在同一会话内不变，足够做 304 校验；
  // 不能用 id 或路径作组成部分——路径含非 Latin-1 字符会触发
  // Response 构造的 ByteString 编码异常（实测 TypeError）。
  const etag = `"${stat.size}-${stat.mtimeMs}"`;
  // 本地文件在会话内不会变——允许缓存可避免每次 seek/重播从磁盘重读同一批字节
  const headers = { 'Cache-Control': 'private, max-age=86400', 'Last-Modified': lastModified, 'ETag': etag };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304 });

  const range = request.headers.get('range');
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    const chunkSize = end - start + 1;
    return new Response(Readable.toWeb(fs.createReadStream(fp, { start, end })), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${total}`, 'Accept-Ranges': 'bytes', 'Content-Length': String(chunkSize), 'Content-Type': mime, ...headers },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(fp)), {
    status: 200,
    headers: { 'Content-Length': String(total), 'Accept-Ranges': 'bytes', 'Content-Type': mime, ...headers },
  });
}

// 封面：按需从文件内嵌标签提取（批量扫描 skipCovers 保持快，封面只服务当前播放曲）
async function handleCover(url) {
  const id = +decodeURIComponent(url.pathname.replace(/^\/cover\//, ''));
  const f = getFileById(db, id);
  if (!f || !fs.existsSync(f.path)) return new Response(null, { status: 404 });
  try {
    const meta = await parseFile(f.path, { duration: false, skipCovers: false });
    const pic = meta?.common?.picture?.[0];
    if (!pic) return new Response(null, { status: 404 });
    return new Response(Buffer.from(pic.data), {
      headers: { 'Content-Type': pic.format || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

// 静态资源 + SPA 回退（index.html 的绝对路径 /app.js 等在 musicdedup://app 源下解析到 /app 路径）
function handleStatic(url) {
  const pathname = decodeURIComponent(url.pathname);
  let fp;
  if (pathname === '/' || pathname === '') {
    fp = path.join(PUBLIC, 'index.html');
  } else {
    fp = path.resolve(PUBLIC, '.' + pathname);
    // 防路径穿越：解析后必须仍在 PUBLIC 内
    if (!fp.startsWith(PUBLIC + path.sep) && fp !== PUBLIC) return new Response('Forbidden', { status: 403 });
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(PUBLIC, 'index.html'); // SPA 回退
  }
  const ext = path.extname(fp).toLowerCase();
  const mime = STATIC_MIME[ext] || 'application/octet-stream';
  return new Response(fs.readFileSync(fp), { headers: { 'Content-Type': mime } });
}

export function registerProtocol() {
  protocol.handle('musicdedup', async (request) => {
    const url = new URL(request.url);
    if (url.host === 'stream') return handleStream(request, url);
    if (url.host === 'app') {
      if (url.pathname === '/rules-meta.js') return new Response(rulesMetaJs(), { headers: { 'Content-Type': 'application/javascript' } });
      if (url.pathname.startsWith('/cover/')) return handleCover(url);
      return handleStatic(url);
    }
    return new Response('Not found', { status: 404 });
  });
}
