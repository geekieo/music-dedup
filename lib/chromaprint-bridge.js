// lib/chromaprint-bridge.js — fpcalc wrapper for AcoustID-compatible Chromaprint fingerprints
//
// fpcalc -version prints to STDERR and exits with code 1 on some builds,
// so we must (a) capture stderr, (b) treat non-ENOENT errors as "found".
//
// Detection order:
//   1. User-configured custom path (settings.fpcalc_path) — a full path to
//      the executable, OR a directory containing fpcalc/fpcalc.exe.
//   2. Project root directory (musicdedup/fpcalc or fpcalc.exe).
//   3. System PATH (bare "fpcalc" command).
//
// Install fpcalc: https://acoustid.org/chromaprint  (< 1 MB, MIT-licensed)
//   Windows : place fpcalc.exe in the project root directory, or point
//             "fpcalc 可执行文件路径" at it in Settings
//   macOS   : brew install chromaprint   (installs to PATH automatically)
//   Linux   : apt install libchromaprint-tools

import { execFile } from 'child_process';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_NAMES = process.platform === 'win32' ? ['fpcalc.exe', 'fpcalc'] : ['fpcalc'];

let _fpcalcPath   = null;
let _detected     = false;
let _customPath   = '';   // last-seen user-configured path, used to know when to re-detect

function execP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
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
  return [
    ...expandCustomPath(customPath),      // 1. user-configured (highest priority)
    ...BIN_NAMES.map(n => path.join(root, n)), // 2. project root
    ...BIN_NAMES,                          // 3. PATH
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
 * F9: these need a second fpcalc call (`-raw`) rather than deriving one from
 * the other locally — decoding/re-encoding Chromaprint's compressed bit-
 * packing format is a fiddly algorithm that's easy to get subtly wrong, and
 * there's no fpcalc binary or audio fixture available in this environment to
 * verify a hand-rolled implementation against. Two fpcalc calls per file is
 * slower but guaranteed correct; fpcalc itself is fast (a fraction of a
 * second per file), so this roughly doubles just the Chromaprint step, not
 * the whole scan.
 */
export async function computeChromaprint(filePath, customPath = '') {
  const fpcalc = await detectFpcalc(customPath);
  if (!fpcalc) return null;
  try {
    const { stdout } = await execP(fpcalc, ['-json', filePath], { timeout: 60_000 });
    const data = JSON.parse(stdout.trim());
    if (!data.fingerprint) return null;
    let fingerprintRaw = null;
    try {
      const rawOut = await execP(fpcalc, ['-raw', '-json', filePath], { timeout: 60_000 });
      const rawData = JSON.parse(rawOut.stdout.trim());
      // F9 bugfix: with `-raw`, fpcalc's own JSON output wraps the
      // fingerprint in an ARRAY — `"fingerprint": [123, -456, ...]` — not a
      // string (that's only true for the default compressed format). The
      // previous `typeof rawData.fingerprint === 'string'` check was
      // therefore never true, so fingerprintRaw silently stayed null on
      // EVERY file — which is why 阶段5 always reported "跳过：无
      // Chromaprint 声纹" even when AcoustID lookups (using the OTHER,
      // correctly-captured compressed fingerprint) were clearly succeeding.
      if (Array.isArray(rawData.fingerprint)) fingerprintRaw = rawData.fingerprint.join(',');
    } catch { /* local-matching enhancement only — AcoustID lookup still works without it */ }
    return { fingerprint: data.fingerprint, fingerprintRaw, duration: data.duration || 0 };
  } catch { return null; }
}

/** Force re-detection (call after user installs fpcalc or changes the setting) */
export function resetDetection() { _detected = false; _fpcalcPath = null; _customPath = ''; }
