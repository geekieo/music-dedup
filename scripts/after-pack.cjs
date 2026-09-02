// scripts/after-pack.cjs — 打包后清理 Chromium 用不到的大件（Electron 体积瘦身）
//
// 应用是纯 DOM（无 WebGL/WebGPU），以下 Chromium 组件不会被使用：
//   dxcompiler.dll + dxil.dll  — DXC（DirectX Shader Compiler，WebGPU/WebGL2 用）
//   vk_swiftshader.dll          — 软件 Vulkan（仅 WebGPU 用）
//   LICENSES.chromium.html      — 20M 纯文本许可页（功能无关）
// 保留：d3dcompiler_47.dll（ANGLE 旧版兜底）、ffmpeg.dll（音频）、libGLESv2（渲染）。
// fpcalc：Windows 打包时把仓库根目录 fpcalc.exe 放进 resources（fpcalc 不提交仓库，
// 本地存在则带上；CI/他人环境没有则跳过 —— CP 声纹是可选项，运行期仍可用自装路径）。
// 注意：electron-builder 用 require 加载 hook，package.json "type":"module" 下必须 .cjs。
const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  const out = context.appOutDir;
  const targets = [
    'LICENSES.chromium.html',
    'dxcompiler.dll',
    'dxil.dll',
    'vk_swiftshader.dll',
  ];
  for (const t of targets) {
    const p = path.join(out, t);
    try {
      fs.rmSync(p);
      console.log('[after-pack] 已删 ' + t);
    } catch {
      // 该版本无此文件则忽略
    }
  }
  if (process.platform === 'win32') {
    const src = path.join(__dirname, '..', 'fpcalc.exe');
    const dst = path.join(out, 'resources', 'fpcalc.exe');
    try {
      fs.copyFileSync(src, dst);
      console.log('[after-pack] 已复制 fpcalc.exe 到 resources');
    } catch {
      // 源不存在（本地未放置）→ 跳过，CP 声纹回退为运行期自检测
    }
  }
};
