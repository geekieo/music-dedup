// Release script — bumps version, updates CHANGELOG, creates git tag
// Usage: node scripts/release.js [patch|minor|major]

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { execSync } from 'child_process';

// npm run always executes from project root
const PKG_PATH = join(process.cwd(), 'package.json');
const CHANGELOG_PATH = join(process.cwd(), 'CHANGELOG.md');

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

function git(cmd) {
  // strip stderr to avoid noise on Windows; errors throw with status message
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return '';
  }
}

// ── commit log since last tag ────────────────────────────

function getCommitsSinceLastRelease() {
  const lastTag = git('describe --tags --abbrev=0');
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  const log = git(`log ${range} --oneline --no-merges`);

  if (!log) return [];
  return log.split('\n').map(line => {
    const m = line.match(/^\S+\s+(.+)$/);
    return m ? m[1] : line;
  });
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
  const tag = `v${newVersion}`;
  const date = today();

  console.log(`\nNew version: ${newVersion} (${type})`);
  const confirm = await ask('\nProceed? [Y/n]: ');
  if (confirm && confirm.toLowerCase() !== 'y') {
    console.log('Cancelled.');
    process.exit(0);
  }

  // 4. update package.json
  pkg.version = newVersion;
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`\n✓ package.json → ${newVersion}`);

  // 5. prepend placeholder to CHANGELOG.md
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

  // 6. git commit + tag
  console.log('');
  execSync('git add package.json CHANGELOG.md', { stdio: 'inherit', windowsHide: true });
  execSync(`git commit -m "chore: release ${tag}"`, { stdio: 'inherit', windowsHide: true });
  execSync(`git tag -a ${tag} -m "${tag}"`, { stdio: 'inherit', windowsHide: true });

  console.log(`\n✓ Released ${tag}`);
  console.log(`  Next: fill in the CHANGELOG placeholder, then:`);
  console.log(`  git push && git push --tags`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
