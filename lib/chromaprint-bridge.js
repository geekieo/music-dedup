// lib/chromaprint-bridge.js — fpcalc wrapper for AcoustID-compatible Chromaprint fingerprints
//
// fpcalc -version prints to STDERR and exits with code 1 on some builds,
// so we must (a) capture stderr, (b) treat non-ENOENT errors as "found".
//
// Install fpcalc: https://acoustid.org/chromaprint  (< 1 MB, MIT-licensed)
//   Windows : place fpcalc.exe in the project root directory
//   macOS   : brew install chromaprint
//   Linux   : apt install libchromaprint-tools

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _fpcalcPath = null;
let _detected   = false;

function execP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

function candidates() {
  const names = process.platform === 'win32' ? ['fpcalc.exe', 'fpcalc'] : ['fpcalc'];
  const root  = path.join(__dirname, '..');
  return [
    ...names.map(n => path.join(root, n)),  // project root (highest priority)
    ...names,                                // PATH fallback
  ];
}

async function tryCmd(cmd) {
  // Skip absolute paths that clearly don't exist
  if (path.isAbsolute(cmd) && !existsSync(cmd)) return false;
  try {
    // fpcalc -version: exits 0 or 1, always writes to stderr
    const { stdout, stderr } = await execP(cmd, ['-version'], { timeout: 5000 });
    return (stdout + stderr).length > 0;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') return false; // truly not found
    // Any other error (including non-zero exit) means the binary IS present
    return (err.stdout || '') + (err.stderr || '') ? true
          : err.code !== 'ENOENT';            // final fallback
  }
}

export async function detectFpcalc() {
  if (_detected) return _fpcalcPath;
  _detected = true;
  for (const cmd of candidates()) {
    if (await tryCmd(cmd)) { _fpcalcPath = cmd; return cmd; }
  }
  return null;
}

/** Returns { fingerprint: string, duration: number } or null */
export async function computeChromaprint(filePath) {
  const fpcalc = await detectFpcalc();
  if (!fpcalc) return null;
  try {
    const { stdout } = await execP(fpcalc, ['-json', filePath], { timeout: 60_000 });
    const data = JSON.parse(stdout.trim());
    return data.fingerprint ? { fingerprint: data.fingerprint, duration: data.duration || 0 } : null;
  } catch { return null; }
}

/** Force re-detection (call after user installs fpcalc while app is running) */
export function resetDetection() { _detected = false; _fpcalcPath = null; }
