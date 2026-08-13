// electron/preload.cjs — 渲染进程 ↔ 主进程 IPC 桥（contextBridge）
// P2：暴露单通道 request(method,url,body)（前端 api.get/post/put/del 桥）+
// scan:progress 事件订阅。P0 回归只读接口保留（verify/samples/streamResult）。
// 命名注意：全局名用 window.bridge 而非 window.api —— 渲染进程 app.js 顶层声明了
// `const api={...}`，而 contextBridge 暴露的全局属性不可配置，同名会把该声明判为
// 重复声明（V8 SyntaxError: Identifier 'api' has already been declared）。
// 最小权限面：不暴露 fs/shell/db 等任意能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  // 统一请求通道（对应 server.js 的 REST 语义，路由表在 electron/ipc/index.js）
  request: (method, url, body) => ipcRenderer.invoke('api', { method, url, body }),
  // 扫描进度事件订阅；返回取消订阅函数
  onScanProgress: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('scan:progress', listener);
    return () => ipcRenderer.removeListener('scan:progress', listener);
  },
  // ── P0 回归用（只读）──
  verify: () => ipcRenderer.invoke('p0:verify'),
  samples: () => ipcRenderer.invoke('p0:samples'),
  streamResult: (r) => ipcRenderer.send('p0:stream-result', r),
});
