// electron/updater-download-cli.mjs — 更新安装包下载独立进程（sidecar）
//
// 下载在普通 Node 子进程里执行（sidecar，见 ipc/about.js 头注释），大文件网络 IO
// 不占用主进程；打包版经 process.execPath + ELECTRON_RUN_AS_NODE=1 退化为纯 Node。
// 契约：argv[2]=下载 URL；argv[3]=目标文件路径。
//   stdout 逐行输出 JSON：{progress:{percent}}（百分比变化时），结尾 {done:{ok,bytes}} 或 {done:{error}}。
import { createWriteStream, mkdirSync, statSync } from 'fs';
import { Readable } from 'stream';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import path from 'path';

const url = process.argv[2];
const target = process.argv[3];
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let result;
try {
  if (!url || !target) throw new Error('用法: updater-download-cli.mjs <url> <target>');
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  mkdirSync(path.dirname(target), { recursive: true });
  const out = createWriteStream(target);
  // 边下载边按整百分比上报（每变化 1% 至多一行，避免高频 IPC）
  let received = 0;
  let lastPct = -1;
  const tally = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (total > 0) {
        const pct = Math.floor((received / total) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          emit({ progress: { percent: pct } });
        }
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), tally, out);
  const bytes = statSync(target).size;
  if (total && bytes !== total) throw new Error('下载不完整');
  result = { ok: true, bytes };
} catch (e) {
  result = { error: (e && e.message) || String(e) };
}
emit({ done: result });
