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
  // P4 无边框：平台标识 + 窗口控制（Linux 自绘按钮用；Win/mac 走原生控件）
  platform: process.platform,
  // 关闭确认：主进程发 app:confirm-close → 渲染层弹窗；确认后调 confirmClose()，
  // 主进程等任务中止归位后退出。
  onConfirmClose: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('app:confirm-close', listener);
    return () => ipcRenderer.removeListener('app:confirm-close', listener);
  },
  confirmClose: () => ipcRenderer.invoke('app:confirm-close'),
  // 隔离测试模式：--userdata 指向非默认目录时置 true，渲染进程 header 显示「隔离测试」徽标，
  // 与生产环境区分（类似 develop/test/product 环境标记）。
  isTest: !!process.env.MUSICDEDUP_USERDATA,
  winControls: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    onMaximized: (cb) => {
      const listener = (_event, v) => cb(v);
      ipcRenderer.on('win:maximized', listener);
      return () => ipcRenderer.removeListener('win:maximized', listener);
    },
  },
  // P4 统一图标：托盘/窗口图标同源（渲染进程栅格化 favicon SVG → PNG data URL）
  readyTrayIcon: (dataUrl) => ipcRenderer.send('tray:icon', dataUrl),
  readyWindowIcon: (dataUrl) => ipcRenderer.send('win:icon', dataUrl),
  // ── P0 回归用（只读）──
  verify: () => ipcRenderer.invoke('p0:verify'),
  samples: () => ipcRenderer.invoke('p0:samples'),
  streamResult: (r) => ipcRenderer.send('p0:stream-result', r),
});
