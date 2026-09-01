// electron/app-state.js — 主进程共享可变状态
// forceQuit：自动更新安装等需要绕过「扫描中关窗确认」直接退出的路径置 true
//（main.js 的关窗拦截以它为准，about.js 安装前置位）。
export const appState = { forceQuit: false };
