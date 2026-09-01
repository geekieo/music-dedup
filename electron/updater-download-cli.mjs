// electron/updater-download-cli.mjs — 更新安装包下载独立进程（sidecar）
//
// 下载在普通 Node 子进程里执行（sidecar，见 ipc/about.js 头注释），大文件网络 IO
// 不占用主进程；打包版经 process.execPath + ELECTRON_RUN_AS_NODE=1 退化为纯 Node。
// 契约：argv[2]=下载 URL；argv[3]=目标文件路径；stdout 输出一行 JSON（{ok,bytes} 或 {error}）。
import { createWriteStream, mkdirSync, statSync } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import path from 'path';

const url = process.argv[2];
const target = process.argv[3];
let result;
try {
  if (!url || !target) throw new Error('用法: updater-download-cli.mjs <url> <target>');
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  mkdirSync(path.dirname(target), { recursive: true });
  const out = createWriteStream(target);
  await pipeline(Readable.fromWeb(res.body), out);
  const bytes = statSync(target).size;
  if (total && bytes !== total) throw new Error('下载不完整');
  result = { ok: true, bytes };
} catch (e) {
  result = { error: (e && e.message) || String(e) };
}
process.stdout.write(JSON.stringify(result));
