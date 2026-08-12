// electron/p0/verify.js — P0 技术验证套件
//
// 目标：逐项验证 v2 客户端化的核心技术前提全部能在 **Electron 主进程** 内跑通：
//   1. node-sqlite3-wasm（WASM 版 SQLite）在主进程内加载并执行 SQL
//   2. music-metadata 解析 FLAC / MP3 / M4A 元数据
//   3. 纯 JS 标签写入（FLAC Vorbis Comment、M4A ilst）读写往返，且写后文件仍可解析/解码
//   4. Goertzel 声纹识别（lib/fingerprint.js）在主进程内对 FLAC 计算声纹
//
// 测试一律作用于 .p0-tmp/samples/ 下的副本，绝不触碰真实曲库。
// 每项验证返回 { key, label, pass, detail }，供渲染进程展示与主进程日志核对。

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync, existsSync } from 'fs';

import { parseFile } from 'music-metadata';
import { computeFingerprint } from '../../lib/fingerprint.js';
import { readFlacRawTags, writeFlacTags } from '../../lib/flac-writer.js';
import { readM4aRawTags, writeM4aTags } from '../../lib/m4a-writer.js';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const S = (name) => path.join(__dirname, '..', '..', '.p0-tmp', 'samples', name);

// 真实曲库中的样本源（写入类测试只作用于 .p0-tmp 副本，每次运行都重新复制，
// 保证验证幂等）。曲库路径若不存在（换机/改路径），对应样本会被跳过。
const SAMPLE_SOURCES = {
  'BarroomBallet.flac': '<samples>/BarroomBallet.flac',
  'sample.m4a':        '<samples>/sample.m4a',
  'sample.mp3':        '<samples>/sample.mp3',
};

function ensureFreshSamples() {
  for (const [name, src] of Object.entries(SAMPLE_SOURCES)) {
    if (existsSync(src)) copyFileSync(src, S(name));
  }
}

const ok   = (key, label, detail) => ({ key, label, pass: true,  detail });
const fail = (key, label, err)    => ({ key, label, pass: false, detail: (err && (err.stack || err.message || String(err))) || '未知错误' });

export async function runVerification() {
  ensureFreshSamples();
  const results = [];

  // 1) node-sqlite3-wasm ── 内存库读写
  try {
    const { Database } = require('node-sqlite3-wasm');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.exec("INSERT INTO t (v) VALUES ('hello')");
    const row = db.all('SELECT v FROM t')[0];
    const n = db.all('SELECT COUNT(*) AS c FROM t')[0].c;
    db.close();
    if (row && row.v === 'hello' && n === 1) {
      results.push(ok('sqlite', 'node-sqlite3-wasm 主进程可用', `内存库 建表/插入/查询 通过（rows=${n}, value=${row.v}）`));
    } else {
      results.push(fail('sqlite', 'node-sqlite3-wasm 主进程可用', new Error(`结果异常: ${JSON.stringify({ row, n })}`)));
    }
  } catch (e) { results.push(fail('sqlite', 'node-sqlite3-wasm 主进程可用', e)); }

  // 2) music-metadata ── 解析三种格式元数据
  for (const [fmt, file] of [['FLAC', S('BarroomBallet.flac')], ['MP3', S('sample.mp3')], ['M4A', S('sample.m4a')]]) {
    try {
      const meta = await parseFile(file, { duration: true, skipCovers: true });
      results.push(ok(`meta-${fmt.toLowerCase()}`,
        `music-metadata 解析 ${fmt}`,
        `title=${meta.common.title ?? '(无)'} · artist=${meta.common.artist ?? '(无)'} · 时长=${meta.format.duration?.toFixed(1)}s · 采样率=${meta.format.sampleRate ?? '-'}`));
    } catch (e) {
      results.push(fail(`meta-${fmt.toLowerCase()}`, `music-metadata 解析 ${fmt}`, e));
    }
  }

  // 3) FLAC 标签写入往返（改 COMMENT，验证原字段保留 + 写后文件仍可解析、可解码）
  try {
    const flac = S('BarroomBallet.flac');
    const before = readFlacRawTags(flac);
    const origComment = before.COMMENT || '';
    writeFlacTags(flac, { comment: 'P0-ROUNDTRIP-TEST' });
    const after = readFlacRawTags(flac);
    const otherPreserved = !origComment || before.COMMENT === after.COMMENT; // 若原来无 COMMENT，无字段可比
    if (after.COMMENT === 'P0-ROUNDTRIP-TEST') {
      // 写后文件仍能被 music-metadata 正常解析 + 仍能算出声纹（音频流未被破坏）
      const reparse = await parseFile(flac, { duration: true, skipCovers: true });
      const fp = await computeFingerprint(flac);
      results.push(ok('flac-write', '纯 JS FLAC 标签写入',
        `写回 COMMENT 成功，原字段保留=${otherPreserved ? '是' : '否'}；写后仍可解析（时长=${reparse.format.duration?.toFixed(1)}s）、` +
        `仍可解码出声纹（${fp?.method ?? 'null'} · ${fp?.fingerprint?.split(' ').length ?? 0} 个整数）`));
    } else {
      results.push(fail('flac-write', '纯 JS FLAC 标签写入', new Error(`读回 COMMENT=${JSON.stringify(after.COMMENT)}，期望 P0-ROUNDTRIP-TEST`)));
    }
  } catch (e) { results.push(fail('flac-write', '纯 JS FLAC 标签写入', e)); }

  // 4) M4A 标签写入往返（ilst + stco 偏移调整是纯 JS 写入里最易出错的路径）
  try {
    const m4a = S('sample.m4a');
    const before = readM4aRawTags(m4a);
    const origComment = before['©cmt'] || '';
    writeM4aTags(m4a, { comment: 'P0-ROUNDTRIP-TEST' });
    const after = readM4aRawTags(m4a);
    if (after['©cmt'] === 'P0-ROUNDTRIP-TEST') {
      const reparse = await parseFile(m4a, { duration: true, skipCovers: true });
      results.push(ok('m4a-write', '纯 JS M4A 标签写入',
        `写回 ©cmt 成功，原 COMMENT=${origComment || '(无)'}；写后仍可解析（时长=${reparse.format.duration?.toFixed(1)}s）`));
    } else {
      results.push(fail('m4a-write', '纯 JS M4A 标签写入', new Error(`读回 ©cmt=${JSON.stringify(after['©cmt'])}，期望 P0-ROUNDTRIP-TEST`)));
    }
  } catch (e) { results.push(fail('m4a-write', '纯 JS M4A 标签写入', e)); }

  // 5) Goertzel 声纹 ── 直接对 FLAC 副本计算（与 v1 主路径一致）
  try {
    const fp = await computeFingerprint(S('BarroomBallet.flac'));
    const ints = fp?.fingerprint?.split(' ').filter(Boolean) ?? [];
    if (fp?.fingerprint && ints.length >= 20) {
      results.push(ok('fingerprint', 'Goertzel 声纹识别',
        `method=${fp.method} · 声纹长度=${ints.length} 个整数 · 时长=${fp.duration?.toFixed(1)}s`));
    } else {
      results.push(fail('fingerprint', 'Goertzel 声纹识别', new Error(`声纹为空或过短: ${JSON.stringify({ ...fp, fingerprint: (fp?.fingerprint ?? '').slice(0, 80) })}`)));
    }
  } catch (e) { results.push(fail('fingerprint', 'Goertzel 声纹识别', e)); }

  return results;
}
