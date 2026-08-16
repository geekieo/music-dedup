// scripts/after-pack.cjs — 打包后清理 Chromium 用不到的大件（Electron 体积瘦身）
//
// 应用是纯 DOM（无 WebGL/WebGPU），以下 Chromium 组件不会被使用：
//   dxcompiler.dll + dxil.dll  — DXC（DirectX Shader Compiler，WebGPU/WebGL2 用）
//   vk_swiftshader.dll          — 软件 Vulkan（仅 WebGPU 用）
//   LICENSES.chromium.html      — 20M 纯文本许可页（功能无关）
// 保留：d3dcompiler_47.dll（ANGLE 旧版兜底）、ffmpeg.dll（音频）、libGLESv2（渲染）。
// 打包版冒烟验证（2026-08-16）：删除后 UI 渲染 + 音频播放均正常，12/12。
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
};
