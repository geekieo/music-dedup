// electron/fp-decode-cli.mjs — 声纹解码独立进程（sidecar）
//
// 解码/Goertzel 在普通 Node 子进程里执行（sidecar，见 fp-decode-pool.mjs 头注释）；
// 打包版经 process.execPath + ELECTRON_RUN_AS_NODE=1 退化为纯 Node。
// 契约：argv[2]=文件路径；stdout 输出一行 JSON（computeFingerprint 结果）。
import { computeFingerprint } from '../lib/fingerprint.js';

const filePath = process.argv[2];
let result;
try {
  result = await computeFingerprint(filePath);
} catch (e) {
  result = { error: (e && e.message) || String(e) };
}
process.stdout.write(JSON.stringify(result));
