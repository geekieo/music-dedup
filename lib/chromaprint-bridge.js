// lib/chromaprint-bridge.js — fpcalc wrapper for AcoustID-compatible Chromaprint fingerprints
//
// fpcalc -version prints to STDERR and exits with code 1 on some builds,
// so we must (a) capture stderr, (b) treat non-ENOENT errors as "found".
//
// Detection order:
//   1. User-configured custom path (settings.fpcalc_path) — a full path to
//      the executable, OR a directory containing fpcalc/fpcalc.exe.
//   2. Electron resources dir (process.resourcesPath — packaged app).
//   3. Project root directory (musicdedup/fpcalc or fpcalc.exe).
//   4. System PATH (bare "fpcalc" command).
//
// Install fpcalc: https://acoustid.org/chromaprint  (< 1 MB, MIT-licensed)
//   Windows : place fpcalc.exe in the project root directory, or point
//             "fpcalc 可执行文件路径" at it in Settings
//   macOS   : brew install chromaprint   (installs to PATH automatically)
//   Linux   : apt install libchromaprint-tools

import { spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_NAMES = process.platform === 'win32' ? ['fpcalc.exe', 'fpcalc'] : ['fpcalc'];

let _fpcalcPath   = null;
let _detected     = false;
let _customPath   = '';   // last-seen user-configured path, used to know when to re-detect

// ── 子进程执行（killable）───────────────────────────────────────────────
// fpcalc 子进程集合：killActiveFpcalc() 同步终止在跑的 fpcalc，让等待中的
// computeChromaprint 立即 reject、当前批快速结束。worker 线程与主进程各持一份
// 独立模块实例，此处集合只含本线程 spawn 的进程。
const activeFpcalc = new Set();

/** 立即终止所有在跑的 fpcalc 子进程（幂等）。 */
export function killActiveFpcalc() {
  for (const child of activeFpcalc) { try { child.kill(); } catch {} }
}

// 契约：resolve {stdout,stderr}；reject 的 err 携带 .stdout/.stderr（供 tryCmd 的
// "非 ENOENT 即视为已找到"判断，fpcalc -version 退出码 1 也能命中）。
// 用 spawn 以便持有子进程引用、可被 killActiveFpcalc 终止；timeout 用定时器模拟。
function execP(cmd, args, opts = {}) {
  const { timeout } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    activeFpcalc.add(child);
    let stdout = '', stderr = '';
    child.stdout?.setEncoding('utf8'); child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.setEncoding('utf8'); child.stderr?.on('data', (d) => { stderr += d; });
    let timer = null;
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      activeFpcalc.delete(child);
      fn();
    };
    child.on('error', (err) => {
      finish(() => { err.stdout = stdout; err.stderr = stderr; reject(err); });
    });
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else {
          const err = new Error(`${cmd} exited with code ${code}`);
          err.code = code; err.stdout = stdout; err.stderr = stderr;
          reject(err);
        }
      });
    });
    if (timeout) {
      timer = setTimeout(() => {
        const err = new Error(`${cmd} timed out after ${timeout}ms`);
        err.killed = true;
        child.kill();
        finish(() => reject(err));
      }, timeout);
    }
  });
}

// Expand a user-supplied path (file OR directory) into candidate executable paths
function expandCustomPath(customPath) {
  if (!customPath) return [];
  try {
    const st = statSync(customPath);
    if (st.isDirectory()) return BIN_NAMES.map(n => path.join(customPath, n));
    if (st.isFile())      return [customPath];
  } catch { /* doesn't exist on disk — still try it verbatim below */ }
  return [customPath];
}

function candidates(customPath) {
  const root = path.join(__dirname, '..');
  // 打包后 fpcalc.exe 经 electron-builder extraResources 落地 resources/；
  // 项目根候选在 asar 内（execFile 无法从 asar 启动进程），故补充 resourcesPath。
  // 纯 Node 下 process.resourcesPath 为 undefined，带保护不影响。
  return [
    ...expandCustomPath(customPath),      // 1. user-configured (highest priority)
    ...(process.resourcesPath ? BIN_NAMES.map(n => path.join(process.resourcesPath, n)) : []),
    ...BIN_NAMES.map(n => path.join(root, n)), // 3. project root
    ...BIN_NAMES,                          // 4. PATH
  ];
}

async function tryCmd(cmd) {
  if (path.isAbsolute(cmd) && !existsSync(cmd)) return false;
  try {
    const { stdout, stderr } = await execP(cmd, ['-version'], { timeout: 5000 });
    return (stdout + stderr).length > 0;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') return false;
    return ((err.stdout || '') + (err.stderr || '')).length > 0 || err.code !== 'ENOENT';
  }
}

/**
 * Detect fpcalc. `customPath` (optional) is the user-configured path from
 * settings — if provided and different from the last detection, forces a
 * fresh scan (so changing the setting takes effect immediately).
 */
export async function detectFpcalc(customPath = '') {
  if (_detected && customPath === _customPath) return _fpcalcPath;
  _detected = true;
  _customPath = customPath;
  for (const cmd of candidates(customPath)) {
    if (await tryCmd(cmd)) { _fpcalcPath = cmd; return cmd; }
  }
  _fpcalcPath = null;
  return null;
}

/**
 * Returns { fingerprint: string, fingerprintRaw: string|null, duration: number } or null.
 * `fingerprint` is the AcoustID-compatible compressed format (for AcoustID lookups).
 * `fingerprintRaw` is a comma-separated list of the underlying 32-bit integers
 * (for LOCAL duplicate comparison — see lib/fingerprint.js chromaprintSimilarity).
 *
 * Two fpcalc calls per file: one for the compressed fingerprint (AcoustID
 * lookup), one with `-raw` for local Chromaprint comparison. Calling fpcalc
 * twice is slower but guaranteed correct — hand-rolling the compressed→raw
 * conversion is error-prone and unverifiable without test fixtures.
 */
export async function computeChromaprint(filePath, customPath = '') {
  const fpcalc = await detectFpcalc(customPath);
  if (!fpcalc) return null;
  // 单文件两次 fpcalc：一次 compressed（AcoustID 查询）、一次 -raw（本地比对）。
  async function run(p) {
    const { stdout } = await execP(fpcalc, ['-json', p], { timeout: 60_000 });
    const data = JSON.parse(stdout.trim());
    if (!data.fingerprint) return null;
    let fingerprintRaw = null;
    try {
      const rawOut = await execP(fpcalc, ['-raw', '-json', p], { timeout: 60_000 });
      const rawData = JSON.parse(rawOut.stdout.trim());
      // `-raw` output wraps the fingerprint in an ARRAY, not a string.
      if (Array.isArray(rawData.fingerprint)) fingerprintRaw = rawData.fingerprint.join(',');
    } catch { /* local-matching enhancement only — AcoustID lookup still works without it */ }
    return { fingerprint: data.fingerprint, fingerprintRaw, duration: data.duration || 0 };
  }
  try { return await run(filePath); }
  catch (e) {
    // 失败不静默：返回 {error} 标记，调用方（runFingerprint）计数 + 记日志，
    // 否则 Chromaprint 缺失被当"无需更新"，AcoustID 匹配悄悄降级。
    return { error: (e && (e.message || String(e))) || 'fpcalc 调用失败', path: filePath };
  }
}

/** Force re-detection (call after user installs fpcalc or changes the setting) */
export function resetDetection() { _detected = false; _fpcalcPath = null; _customPath = ''; }
