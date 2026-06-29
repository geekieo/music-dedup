// lib/chromaprint-bridge.js
//
// AcoustID requires Chromaprint fingerprints, which are produced by the
// Chromaprint library (fpcalc binary). The Chromaprint algorithm uses a set
// of 16 ML-trained classifiers whose weights are embedded in the compiled
// binary — they cannot be reproduced in pure JS without those constants.
//
// This module auto-detects fpcalc and, if found, uses it to generate
// Chromaprint fingerprints stored in the `chromaprint` DB column.
// If fpcalc is not installed, AcoustID lookup is silently skipped while
// the rest of the scraping pipeline (MusicBrainz text search) continues.
//
// Install fpcalc: https://acoustid.org/chromaprint  (< 1 MB, MIT-licensed)
// Windows: download fpcalc.exe and place it anywhere on PATH, or in the
//           project directory.
// macOS:   brew install chromaprint
// Linux:   apt install libchromaprint-tools  or  dnf install chromaprint-tools

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

let _fpcalcPath = null;
let _detected = false;

// Candidate paths to check for fpcalc
function candidates() {
  const bins = process.platform === 'win32' ? ['fpcalc.exe', 'fpcalc'] : ['fpcalc'];
  const localDir = path.join(__dirname, '..');
  const results = [];
  // Local project directory (user can drop the binary here)
  for (const b of bins) results.push(path.join(localDir, b));
  // PATH (system-wide installation)
  for (const b of bins) results.push(b);
  return results;
}

export async function detectFpcalc() {
  if (_detected) return _fpcalcPath;
  _detected = true;
  for (const cmd of candidates()) {
    try {
      // Skip absolute paths that don't exist on disk
      if (cmd.includes(path.sep) && !existsSync(cmd)) continue;
      const { stdout } = await execFileAsync(cmd, ['-version'], { timeout: 4000 });
      if (/chromaprint/i.test(stdout)) { _fpcalcPath = cmd; return cmd; }
    } catch { /* not available at this path */ }
  }
  return null;
}

// Returns { fingerprint: string, duration: number } or null
export async function computeChromaprint(filePath) {
  const fpcalc = await detectFpcalc();
  if (!fpcalc) return null;
  try {
    // -json outputs a clean JSON object with duration + fingerprint fields
    const { stdout } = await execFileAsync(fpcalc, ['-json', filePath], { timeout: 60_000 });
    const data = JSON.parse(stdout.trim());
    if (!data.fingerprint) return null;
    return { fingerprint: data.fingerprint, duration: data.duration || 0 };
  } catch {
    return null;
  }
}

// Reset cache (useful after user installs fpcalc while app is running)
export function resetDetection() { _detected = false; _fpcalcPath = null; }
