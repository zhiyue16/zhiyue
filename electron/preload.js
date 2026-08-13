// Electron 预加载脚本：contextIsolation 下向渲染进程暴露最小 API。
// window.electronAPI 的存在本身即"Electron 环境"标志（网页版浏览器里为 undefined）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 渲染进程 → 主进程：发送原生系统通知（kind: 'focus' | 'rest'）
  notify: (kind) => ipcRenderer.send('rft:notify', kind),
  // 开机自启动：读取 / 设置（login item）
  getAutoLaunch: () => ipcRenderer.invoke('rft:loginItem:get'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('rft:loginItem:set', enabled),
  // 自动更新（v1.25.0，electron-updater + GitHub Releases）
  checkUpdate: () => ipcRenderer.invoke('rft:update:check'),
  downloadUpdate: () => ipcRenderer.invoke('rft:update:download'),
  installUpdate: () => ipcRenderer.invoke('rft:update:install'),
  getVersion: () => ipcRenderer.invoke('rft:version'),
  onUpdateStatus: (cb) => ipcRenderer.on('rft:update:status', (e, s) => cb(s))
});
