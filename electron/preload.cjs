// electron/preload.cjs — 渲染进程 ↔ 主进程 IPC 桥（contextBridge）
// 仅暴露 P0 验证所需的两个只读接口，保持最小权限面。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 主进程缓存的 P0 验证结果（数组：{ key, label, pass, detail }）
  verify: () => ipcRenderer.invoke('p0:verify'),
  // 测试样本文件信息（数组：{ kind, path }）
  samples: () => ipcRenderer.invoke('p0:samples'),
  // 渲染进程完成流式播放自测后回报结果（{ pass, detail }）
  streamResult: (r) => ipcRenderer.send('p0:stream-result', r),
});
