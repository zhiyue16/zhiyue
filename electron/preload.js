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
  onUpdateStatus: (cb) => ipcRenderer.on('rft:update:status', (e, s) => cb(s)),
  // 无边框窗口控制（v1.26.0）：自绘按钮 → 主进程
  windowMin: () => ipcRenderer.send('rft:win:min'),
  windowMaxToggle: () => ipcRenderer.send('rft:win:max'),
  windowClose: () => ipcRenderer.send('rft:win:close'),
  windowIsMax: () => ipcRenderer.invoke('rft:win:isMax'),
  onMaxChange: (cb) => ipcRenderer.on('rft:win:max-changed', (e, v) => cb(v)),
  // Mini 浮窗（v1.27.0）：浮窗=遥控器，状态机在主窗口，主进程中转
  miniOpen: () => ipcRenderer.send('rft:mini:open'),
  miniClose: () => ipcRenderer.send('rft:mini:close'),
  miniCollapse: (collapsed) => ipcRenderer.send('rft:mini:collapse', collapsed),
  miniReportSnap: (side) => ipcRenderer.send('rft:mini:snapstate', side),
  miniCmd: (type, payload) => ipcRenderer.send('rft:mini:cmd', { type, payload }),
  onMiniCmd: (cb) => ipcRenderer.on('rft:mini:cmd', (e, c) => cb(c)),
  miniState: (s) => ipcRenderer.send('rft:mini:state', s),
  onMiniState: (cb) => ipcRenderer.on('rft:mini:state', (e, s) => cb(s)),
  onMiniSnap: (cb) => ipcRenderer.on('rft:mini:snap', (e, v) => cb(v)),
  // 贴边隐藏的悬停展开（v1.28.3）：细条 mouseenter 请求展开；peek 广播切换卡片/细条视图
  miniPeekShow: () => ipcRenderer.send('rft:mini:peekshow'),
  onMiniPeek: (cb) => ipcRenderer.on('rft:mini:peek', (e, v) => cb(v)),
  // 时长弹窗独立窗口（v1.28.2）：浮窗发锚点开窗；弹窗页发 commit/cancel 结果
  miniEditorOpen: (anchor) => ipcRenderer.send('rft:mini:editoropen', anchor),
  miniEditorCommit: (v) => ipcRenderer.send('rft:mini:editorcmd', { type: 'commit', value: v }),
  miniEditorCancel: () => ipcRenderer.send('rft:mini:editorcmd', { type: 'cancel' }),
  showMainWindow: () => ipcRenderer.send('rft:win:show')
});
