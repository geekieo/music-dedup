// electron/cpuinfo.js — 物理核数（解码并发自动值的依据）
// os.cpus().length 是逻辑核（SMT 机型 = 物理核 × 2，非 SMT 机型 = 物理核）；解码并发
// 需要物理核数（每路解码单线程）。Windows 查 Win32_Processor.NumberOfCores（多插槽求和），
// 查询失败回退逻辑核/2（SMT 估算，非 SMT 会低估——保守方向）。
import { execFileSync } from 'node:child_process';
import os from 'os';

let _physical = null;

export function getPhysicalCores() {
  if (_physical) return _physical;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe',
        ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum'],
        { encoding: 'utf8', timeout: 15000 });
      const n = parseInt(out.trim(), 10);
      if (Number.isFinite(n) && n > 0) return (_physical = n);
    }
  } catch { /* 查询失败走回退 */ }
  return (_physical = Math.round(os.cpus().length / 2));
}
