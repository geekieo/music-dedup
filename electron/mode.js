// electron/mode.js — 便携模式判定（只依赖 node 内置模块，供 bootstrap-env / ipc 共用）
//
// 便携版发布形态为单文件自解压 exe（electron-builder portable target），运行时注入
// PORTABLE_EXECUTABLE_DIR（值为 exe 所在目录）；安装版/开发模式无该变量。
export function isPortable() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
}
