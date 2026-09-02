// electron/ipc/about.js — 关于域：版本 / 更新检查 / 更新下载与安装 / 外链打开
//
// 更新按运行形态分两条路径（判定见 mode.js）：
//   安装版（打包 + 无 PORTABLE_EXECUTABLE_DIR）→ electron-updater：检查 latest.yml 元数据、
//     后台下载，用户确认后 quitAndInstall（NSIS 安装器自动运行并重启，不走 Setup /S 自装）。
//   便携版（PORTABLE_EXECUTABLE_DIR 注入）→ 自定义 GitHub 检查 + 下载 MusicDedup-Portable.zip
//     + SHA256 校验 + 解压 staging + PowerShell 等旧进程退出后用新 exe 覆盖原便携 exe
//     （数据目录在 exe 旁，不触碰）。
//   开发模式（未打包）→ 检查返回 GitHub 信息，下载/安装返回明确错误。
// 下载完成把版本写入设置 pending_update_version：用户「稍后」时保留，下次启动命中同一
// 版本则命中缓存/staging 不重新下载（前端据此再次提示安装）；安装时清除。
import { createRequire } from 'module';
import { spawn } from 'node:child_process';
import { existsSync, createReadStream, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { app, shell } = require('electron');

import { appState } from '../app-state.js';
import { isPortable } from '../mode.js';
import { getDB } from '../../lib/db/index.js';
import { setSetting } from '../../lib/db/settings.js';

const db = getDB();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'geekieo/music-dedup';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const PORTABLE_ASSET = 'MusicDedup-Portable.zip';
// 运行形态：安装版 / 便携版 / 开发模式（模块加载时即定，smoke 不触碰更新路由无副作用）
const MODE = isPortable() ? 'portable' : app.isPackaged ? 'installer' : 'dev';

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

// ── 便携版：GitHub 检查 + zip 下载/替换 ─────────────────────────────

function portableZipPath(version) {
  return path.join(app.getPath('temp'), 'MusicDedup', `MusicDedup-Portable-${version}.zip`);
}
function portableStageDir(version) {
  return path.join(app.getPath('temp'), 'MusicDedup', `portable-update-${version}`);
}

async function fetchLatestRelease() {
  const res = await fetch(RELEASE_API, {
    headers: { 'User-Agent': 'MusicDedup', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 404) return null; // 仓库尚无发布版本
  if (!res.ok) throw new Error('GitHub API ' + res.status);
  const d = await res.json();
  // 资产名由 CI 固定为 MusicDedup-Portable.zip（不解析文件名猜测更新包）
  const asset = (d.assets || []).find(a => a.name === PORTABLE_ASSET) || null;
  return {
    version: String(d.tag_name || '').replace(/^v/i, ''),
    name: d.name || '',
    publishedAt: d.published_at || '',
    htmlUrl: d.html_url || '',
    body: d.body || '',
    asset: asset
      ? { name: asset.name, url: asset.browser_download_url, size: asset.size || 0, digest: asset.digest || '' }
      : null,
  };
}

async function checkPortable(current) {
  const latest = await fetchLatestRelease();
  if (!latest) return { hasUpdate: false, latest: null };
  return { hasUpdate: cmpVersion(parseVersion(latest.version), parseVersion(current)) > 0, latest };
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

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(p);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// 一次性的 PowerShell 调用（解压），等待其退出；脚本经 -EncodedCommand 传递避免引号转义
function runPowerShell(script) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function unzipTo(zipPath, stage) {
  const q = (s) => s.replace(/'/g, "''");
  return runPowerShell(
    `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${q(zipPath)}' -DestinationPath '${q(stage)}' -Force`
  );
}

// 便携版下载：zip 已下好（staging 存在）则直接复用 → 解压 staging → 记录 pending
async function downloadPortable(body, version) {
  const stage = portableStageDir(version);
  if (existsSync(path.join(stage, 'MusicDedup.exe'))) {
    setSetting(db, 'pending_update_version', version);
    return { ok: true, version };
  }
  const url = body && body.url;
  if (!/^https:\/\//.test(url || '')) return { ok: false, error: '无效的下载地址' };
  const zipPath = portableZipPath(version);
  const result = await downloadTo(zipPath, url);
  if (!result.ok) return result;
  const digest = body && body.digest;
  if (digest && digest.startsWith('sha256:')) {
    const hex = await sha256File(zipPath);
    if (hex.toLowerCase() !== digest.slice(7).toLowerCase()) {
      try { rmSync(zipPath, { force: true }); } catch { /* 删除失败不阻塞 */ }
      return { ok: false, error: '安装包校验失败（SHA256 不匹配），请重试' };
    }
  }
  const ok = await unzipTo(zipPath, stage);
  if (!ok) return { ok: false, error: '解压失败，请重试' };
  setSetting(db, 'pending_update_version', version);
  return { ok: true, version };
}

// 便携替换 sidecar（detached 存活到主进程退出后）：等应用退出 → 用 staging 的新 exe 覆盖
// 原便携 exe（数据目录在 exe 旁，不触碰）→ 清 staging+zip → 重启新版本。
function spawnPortableSwap(stage, targetExe, zipPath, pid) {
  const q = (s) => s.replace(/'/g, "''");
  const script = [
    `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue;`,
    `$src = '${q(path.join(stage, 'MusicDedup.exe'))}';`,
    `$dst = '${q(targetExe)}';`,
    `$ok = $false;`,
    // 进程退出后 exe 可能仍被短暂占用（杀软扫描等），重试覆盖
    `for ($i = 0; $i -lt 5; $i++) {`,
    `  try { Copy-Item -LiteralPath $src -Destination $dst -Force; $ok = $true; break } catch { Start-Sleep -Milliseconds 800 }`,
    `}`,
    `Remove-Item -LiteralPath '${q(stage)}' -Recurse -Force -ErrorAction SilentlyContinue;`,
    `Remove-Item -LiteralPath '${q(zipPath)}' -Force -ErrorAction SilentlyContinue;`,
    `if ($ok) { Start-Process -FilePath '${q(targetExe)}'; exit 0 } else { exit 1 }`,
  ].join(' ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}

async function installPortable(version) {
  const stage = portableStageDir(version);
  if (!existsSync(path.join(stage, 'MusicDedup.exe'))) {
    return { ok: false, error: '更新文件不存在，请重新下载更新' };
  }
  const targetExe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!targetExe || !existsSync(targetExe)) {
    return { ok: false, error: '无法定位便携版可执行文件' };
  }
  setSetting(db, 'pending_update_version', '');
  appState.forceQuit = true;
  spawnPortableSwap(stage, targetExe, portableZipPath(version), process.pid);
  setTimeout(() => { try { app.quit(); } catch { /* 退出失败不阻塞 */ } }, 1200);
  return { ok: true, version };
}

// ── 安装版：electron-updater ─────────────────────────────────────────

let updaterDownloadedVersion = null;
let _updater = null;
function getUpdater() {
  if (!_updater) {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false; // 下载由前端显式触发（自动下载也走同一入口）
    autoUpdater.autoInstallOnAppQuit = false; // 安装只在用户确认后 quitAndInstall
    autoUpdater.on('update-downloaded', (info) => {
      updaterDownloadedVersion = (info && info.version) || null;
    });
    _updater = autoUpdater;
  }
  return _updater;
}

function releaseNotesText(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) return notes.map((n) => (n && n.note) || '').filter(Boolean).join('\n\n');
  if (typeof notes === 'object') return String(notes.note || notes.releaseNotes || '');
  return '';
}

async function checkInstaller(current) {
  const result = await getUpdater().checkForUpdates();
  const info = result && result.updateInfo;
  if (!info || !info.version) return { hasUpdate: false, latest: null };
  const version = String(info.version).replace(/^v/i, '');
  const hasUpdate = cmpVersion(parseVersion(version), parseVersion(current)) > 0;
  if (!hasUpdate) return { hasUpdate: false, latest: null };
  return {
    hasUpdate: true,
    latest: {
      version,
      name: '',
      publishedAt: null,
      htmlUrl: `https://github.com/${REPO}/releases/tag/v${version}`,
      body: releaseNotesText(info.releaseNotes),
      asset: null,
    },
  };
}

export const routes = [
  { method: 'GET', path: '/api/update/check', handler: async (_p, query) => {
    const current = String(query.current || '').trim();
    const r = MODE === 'installer' ? await checkInstaller(current) : await checkPortable(current);
    return { ok: true, data: { current, ...r } };
  } },
  // 下载只下载不安装：安装/替换由 /api/update/install 在用户确认后触发。
  { method: 'POST', path: '/api/update/download', handler: async (_p, _q, body) => {
    const version = String((body && body.version) || '').trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) return { ok: false, error: '版本号格式无效' };
    if (MODE === 'installer') {
      // 已下载过则命中 electron-updater 缓存，不重复下载
      await getUpdater().downloadUpdate();
      setSetting(db, 'pending_update_version', version);
      return { ok: true, version };
    }
    if (MODE === 'portable') {
      return downloadPortable(body, version);
    }
    return { ok: false, error: '开发模式不支持安装更新' };
  } },
  { method: 'POST', path: '/api/update/install', handler: async (_p, _q, body) => {
    const version = String((body && body.version) || '').trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) return { ok: false, error: '版本号格式无效' };
    if (MODE === 'installer') {
      setSetting(db, 'pending_update_version', '');
      // 兜底：本次会话尚未确认下载完成时先下载（已缓存则秒回）
      if (updaterDownloadedVersion !== version) {
        try { await getUpdater().downloadUpdate(); }
        catch (e) { return { ok: false, error: '更新包未就绪：' + ((e && e.message) || e) }; }
      }
      appState.forceQuit = true;
      getUpdater().quitAndInstall();
      return { ok: true, version };
    }
    if (MODE === 'portable') {
      return installPortable(version);
    }
    return { ok: false, error: '开发模式不支持安装更新' };
  } },
  { method: 'POST', path: '/api/external/open', handler: async (_p, _q, body) => {
    const url = body && body.url;
    if (!/^https:\/\//.test(url || '')) return { ok: false, error: '仅支持 https 链接' };
    try { await shell.openExternal(url); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  } },
];
