// scripts/release.js — 一键发布（版本号同步 → CHANGELOG 占位 → 推送指引）
//
// 发布链已迁移到 GitHub Actions：推 v* 标签后 CI 自动构建（NSIS + zip 便携）+ 打包版冒烟
// + 创建 GitHub Release 上传全部产物与 latest.yml。本脚本只负责版本号同步与 CHANGELOG
// 占位。
//
// 用法：
//   npm run release            # 交互询问 release 类型 + 确认
//   npm run release patch      # 指定类型（patch|minor|major）
//   npm run release patch -y   # 跳过确认（无头/CI 用）

import { readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import { execSync } from 'child_process';

// npm run always executes from project root
const PKG_PATH = 'package.json';
const PKG_LOCK_PATH = 'package-lock.json';
const CHANGELOG_PATH = 'CHANGELOG.md';
const APP_JS_PATH = 'public/app.js';

// ── helpers ──────────────────────────────────────────────

function bump(version, type) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ask(query) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans.trim()); }));
}

// ── commit log since last tag（供写 CHANGELOG 参考）───────

function git(cmd) {
  // strip stderr to avoid noise on Windows; errors throw with status message
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return '';
  }
}

function getCommitsSinceLastRelease() {
  // 1. 获取本地最新的 v* 标签名
  const lastTag = git('tag --list "v*" --sort=-v:refname')?.split('\n')[0];

  // 2. 获取当前分支最近的 50 条提交
  const allLogs = git('log -50 --oneline --no-merges')?.split('\n').filter(Boolean) || [];
  if (allLogs.length === 0) return [];

  // 如果没有任何标签，直接返回去掉 hash 的纯消息
  if (!lastTag) return allLogs.map(l => l.match(/^\S+\s+(.+)$/)?.[1] || l);

  // 3. 解析标签绑定的短哈希，去掉会引发冲突的 ^{commit}
  const tagHash = git(`rev-parse --short=7 ${lastTag}`);

  // 4. 用 JS 物理切分
  const stopIndex = allLogs.findIndex(line =>
    (tagHash && line.startsWith(tagHash)) || line.includes(`release: ${lastTag}`)
  );

  // 5. 切出新提交并过滤掉哈希前缀
  const targetLogs = stopIndex !== -1 ? allLogs.slice(0, stopIndex) : allLogs;
  return targetLogs.map(line => line.match(/^\S+\s+(.+)$/)?.[1] || line);
}

// ── main ─────────────────────────────────────────────────

async function main() {
  // 1. read current version
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const oldVersion = pkg.version;
  console.log(`Current version: ${oldVersion}\n`);

  // 2. show commits since last release
  const commits = getCommitsSinceLastRelease();
  if (commits.length > 0) {
    console.log(`── Commits since last release (${commits.length}) ──`);
    commits.forEach(c => console.log(`  ${c}`));
    console.log('');
  } else {
    console.log('(no commits since last release)\n');
  }

  // 3. determine release type
  let type = process.argv[2];
  if (!['patch', 'minor', 'major'].includes(type)) {
    type = await ask('Release type? [patch] / minor / major: ');
    if (!type) type = 'patch';
  }
  if (!['patch', 'minor', 'major'].includes(type)) {
    console.error('Invalid release type. Use: patch, minor, or major');
    process.exit(1);
  }

  const newVersion = bump(oldVersion, type);
  const date = today();

  console.log(`\nNew version: ${newVersion} (${type})`);
  const autoYes = process.argv.includes('-y');
  if (!autoYes) {
    const confirm = await ask('\nProceed? [Y/n]: ');
    if (confirm && confirm.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      process.exit(0);
    }
  }

  // 4. update package.json
  pkg.version = newVersion;
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`✓ package.json → ${newVersion}`);

  // 4b. update package-lock.json
  const lock = JSON.parse(readFileSync(PKG_LOCK_PATH, 'utf8'));
  lock.version = newVersion;
  lock.packages[''].version = newVersion;
  writeFileSync(PKG_LOCK_PATH, JSON.stringify(lock, null, 2) + '\n');
  console.log(`✓ package-lock.json → ${newVersion}`);

  // 5. update APP_VERSION in public/app.js
  let appJs = readFileSync(APP_JS_PATH, 'utf8');
  appJs = appJs.replace(/const APP_VERSION='[\d.]+'/, `const APP_VERSION='${newVersion}'`);
  writeFileSync(APP_JS_PATH, appJs);
  console.log(`✓ public/app.js → ${newVersion}`);

  // 6. prepend placeholder to CHANGELOG.md
  let changelog = readFileSync(CHANGELOG_PATH, 'utf8');
  const idx = changelog.indexOf('## [');
  if (idx === -1) {
    console.error('Could not find version header in CHANGELOG.md');
    process.exit(1);
  }

  const placeholder = [
    `## [${newVersion}] — ${date}`,
    '',
    '### Added',
    '',
    '- ',
    '',
    '### Changed',
    '',
    '- ',
    '',
    '### Fixed',
    '',
    '- ',
    '',
    '',
  ].join('\n');

  changelog = changelog.slice(0, idx) + placeholder + changelog.slice(idx);
  writeFileSync(CHANGELOG_PATH, changelog);
  console.log('✓ CHANGELOG.md — placeholder inserted');

  console.log(`\n✓ 版本号就绪：v${newVersion}`);
  console.log('\n👉 剩余步骤（手动，不自动执行）：');
  console.log('  1. 打开 CHANGELOG.md，手动填写本版本具体更新内容。');
  console.log('  2. git add . && git commit -m "release v' + newVersion + '"');
  console.log('  3. git push && git tag v' + newVersion + ' && git push --tags');
  console.log('     （推送 v 标签后，GitHub Actions 自动构建并发布 Release，本地无需再打包上传）');
  console.log('  可选：本地预检打包与冒烟 — npm run build:win && npm run smoke:packaged');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
