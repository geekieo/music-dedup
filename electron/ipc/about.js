// electron/ipc/about.js — 关于域：版本 / 更新检查 / 安装包下载与自动升级 / 外链打开
//
// 更新检查：GET /api/update/check?current=<版本> —— 对比 GitHub release 最新发布版。
// 下载安装：POST /api/update/download {url, version} —— sidecar 子进程流式下载（网络 IO
//   不占主进程，主进程只 await 子进程退出），成功后静默安装（Setup /S）并退出应用；
//   安装器覆盖运行中的 exe，须先退出；安装完成后由 PowerShell 包装器删除安装包。
//   退出前置 appState.forceQuit，绕过「扫描中关窗确认」。
// 外链：POST /api/external/open {url} —— 校验 https 后 shell.openExternal。
import { createRequire } from 'module';
import { spawn } from 'node:child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { app, shell } = require('electron');

import { appState } from '../app-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'geekieo/music-dedup';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

function parseVersion(v) {
  const parts = String(v || '').replace(/^v/i, '').split('.');
  return [0, 1, 2].map(i => parseInt(parts[i], 10) || 0);
}
function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

async function fetchLatestRelease() {
  const res = await fetch(RELEASE_API, {
    headers: { 'User-Agent': 'MusicDedup', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 404) return null; // 仓库尚无发布版本
  if (!res.ok) throw new Error('GitHub API ' + res.status);
  const d = await res.json();
  const setup = (d.assets || []).find(a => /Setup/i.test(a.name) && /\.exe$/i.test(a.name)) || null;
  return {
    version: String(d.tag_name || '').replace(/^v/i, ''),
    name: d.name || '',
    publishedAt: d.published_at || '',
    htmlUrl: d.html_url || '',
    body: d.body || '',
    setupAsset: setup ? { name: setup.name, url: setup.browser_download_url, size: setup.size || 0 } : null,
  };
}

// sidecar 下载：process.execPath + ELECTRON_RUN_AS_NODE=1 退化为纯 Node 跑 CLI
//（与 fp-decode-pool.mjs 同一模式）。stdout 可能混有调试日志，JSON 取末行解析。
function downloadTo(target, url) {
  return new Promise((resolve) => {
    const cliPath = path.join(__dirname, '..', 'updater-download-cli.mjs');
    const child = spawn(process.execPath, [cliPath, url, target], {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) { resolve({ ok: false, error: err.message }); return; }
      const lines = out.trim().split(/\r?\n/);
      let parsed = null;
      try { parsed = JSON.parse(lines[lines.length - 1]); } catch { /* fall through */ }
      if (parsed && parsed.ok) resolve({ ok: true, bytes: parsed.bytes });
      else resolve({ ok: false, error: (parsed && parsed.error) || `下载进程异常退出：${lines[lines.length - 1] || ''}` });
    };
    child.on('error', (e) => finish(e));
    child.on('close', (code) => finish(code === 0 ? null : new Error('下载进程退出 code=' + code)));
  });
}

// 安装包装器：等 3s 让应用完全退出，再静默运行安装器（/S），结束后删除安装包。
// detached + unref 脱离主进程存活（主进程随后 app.quit()）。
function spawnInstallAndCleanup(setupPath) {
  // PS 单引号串内 '' 转义单引号，防用户名含撇号时路径截断
  const psPath = setupPath.replace(/'/g, "''");
  const ps = `Start-Sleep -Seconds 3; Start-Process -FilePath '${psPath}' -ArgumentList '/S' -Wait; Remove-Item -LiteralPath '${psPath}' -Force -ErrorAction SilentlyContinue`;
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', ps], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}

export const routes = [
  { method: 'GET', path: '/api/update/check', handler: async (_p, query) => {
    const current = String(query.current || '').trim();
    const latest = await fetchLatestRelease();
    if (!latest) return { ok: true, data: { current, hasUpdate: false, latest: null } };
    const hasUpdate = cmpVersion(parseVersion(latest.version), parseVersion(current)) > 0;
    return { ok: true, data: { current, hasUpdate, latest } };
  } },
  { method: 'POST', path: '/api/update/download', handler: async (_p, _q, body) => {
    const url = body && body.url;
    const version = String((body && body.version) || '').trim();
    if (!/^https:\/\//.test(url || '')) return { ok: false, error: '无效的下载地址' };
    if (!/^\d+\.\d+\.\d+$/.test(version)) return { ok: false, error: '版本号格式无效' };
    const target = path.join(app.getPath('temp'), 'MusicDedup', `MusicDedup Setup ${version}.exe`);
    const result = await downloadTo(target, url);
    if (!result.ok) return result;
    // 自动升级：仅 Windows（NSIS Setup /S）。安装需退出应用，绕过扫描中关窗确认；
    // 非 Windows 只完成下载，不自动安装。
    if (process.platform === 'win32') {
      appState.forceQuit = true;
      spawnInstallAndCleanup(target);
      setTimeout(() => { try { app.quit(); } catch { /* 退出失败不阻塞 */ } }, 1500);
    }
    return { ok: true, version };
  } },
  { method: 'POST', path: '/api/external/open', handler: async (_p, _q, body) => {
    const url = body && body.url;
    if (!/^https:\/\//.test(url || '')) return { ok: false, error: '仅支持 https 链接' };
    try { await shell.openExternal(url); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  } },
];
