// scripts/render-icons-main.mjs — Electron 主进程：把 assets/icon.svg 渲染成多尺寸 PNG + ICO
// 由 scripts/render-icons.mjs 启动。Blob URL 避免 canvas 被污染（data: URL 有污染风险）。
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require('electron');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SIZES = [16, 32, 48, 64, 128, 256, 512];
const svg = fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');

// ICO 文件（PNG 压缩条目，Vista+ 合法）
function buildIco(entries) {
  const headerLen = 6 + 16 * entries.length;
  let offset = headerLen;
  const dir = Buffer.alloc(headerLen);
  const parts = [];
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(entries.length, 4);
  entries.forEach((e, i) => {
    const o = 6 + 16 * i;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir.writeUInt16LE(1, o + 4);   // planes
    dir.writeUInt16LE(32, o + 6);  // bitcount
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    parts.push(e.png);
    offset += e.png.length;
  });
  return Buffer.concat([dir, ...parts]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 600 });
  await win.loadURL('about:blank');
  const results = await win.webContents.executeJavaScript(`(async () => {
    const blob = new Blob([${JSON.stringify(svg)}], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('svg load failed')); });
    const out = {};
    for (const s of ${JSON.stringify(SIZES)}) {
      const c = document.createElement('canvas');
      c.width = c.height = s;
      c.getContext('2d').drawImage(img, 0, 0, s, s);
      out[s] = c.toDataURL('image/png');
    }
    return out;
  })()`);

  const iconsDir = path.join(ROOT, 'assets', 'icons');
  fs.mkdirSync(iconsDir, { recursive: true });
  const pngOf = (s) => Buffer.from(results[s].split(',')[1], 'base64');
  for (const s of SIZES) fs.writeFileSync(path.join(iconsDir, `icon-${s}.png`), pngOf(s));
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon.ico'), buildIco([16, 32, 48, 256].map((s) => ({ size: s, png: pngOf(s) }))));
  // 托盘图标不在此生成——运行时由渲染进程首启代码生成（见 main.js 'tray:icon'）
  console.log('[render-icons] 完成：assets/icons/*.png + icon.ico（构建期产物，不提交）');
  app.quit();
});
