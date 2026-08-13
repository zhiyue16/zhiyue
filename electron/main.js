// Electron 主进程：随机提示音专注计时器 · 桌面客户端
// 关键模式参考 Stretchly（github.com/hovancik/stretchly）：
//   单例窗口 + show:false/ready-to-show 防白闪 + window-all-closed 空函数托盘驻留
//   + setAppUserModelId（Windows 通知归属）+ setLoginItemSettings 自启
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, globalShortcut, nativeImage } = require('electron');
const path = require('path');

const APP_ID = 'com.zhiyue.focustimer'; // 必须与 package.json build.appId 一致，否则 Windows 通知丢应用名/图标
app.setAppUserModelId(APP_ID);

let win = null, tray = null, isQuitting = false;

function showWin(){
  if(!win) return;
  if(win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function toggleWin(){ if(!win) return; win.isVisible() ? win.hide() : showWin(); }

// 单实例：第二个实例启动时唤起已有窗口
if(!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', showWin);

function createWin(){
  win = new BrowserWindow({
    width: 1024, height: 800,
    show: false,
    center: true,
    autoHideMenuBar: true,
    backgroundThrottling: false, // 最小化到托盘后计时 Web Worker 不被节流
    backgroundColor: '#f4f4f7',  // 与页面浅色底一致，防启动白闪
    icon: path.join(__dirname, '..', 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });
  win.loadFile(path.join(__dirname, '..', 'index.html')); // 加载本地文件，天然完全离线
  win.once('ready-to-show', () => win.show());
  // 关闭按钮 = 最小化到托盘，真正退出走托盘菜单「退出」
  win.on('close', e => { if(!isQuitting){ e.preventDefault(); win.hide(); } });
  win.once('closed', () => { win = null; });
}

function createTray(){
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'icon-192.png')).resize({ width: 32 });
  tray = new Tray(img);
  tray.setToolTip('随机提示音专注计时器');
  tray.on('click', toggleWin); // 左键单击呼出/隐藏主窗口
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showWin },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]));
}

/* 原生通知：渲染进程经 preload 的 electronAPI.notify(kind) → 此通道。
   点击通知唤起主窗口 */
const NOTIFY_TEXT = {
  focus: { title: '专注完成 🎉', body: '本轮专注已完成，休息一下吧' },
  rest:  { title: '休息结束 ✅', body: '大休息结束，可以开始下一轮专注了' }
};
ipcMain.on('rft:notify', (e, kind) => {
  const t = NOTIFY_TEXT[kind];
  if(!t || !Notification.isSupported()) return;
  const n = new Notification({ title: t.title, body: t.body,
    icon: path.join(__dirname, '..', 'icon-192.png') });
  n.on('click', showWin);
  n.show();
});

// 开机自启（login item；Windows 普通版三行搞定，无需 auto-launch 库）
ipcMain.handle('rft:loginItem:get', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('rft:loginItem:set', (e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled });
  return app.getLoginItemSettings().openAtLogin;
});

app.whenReady().then(() => {
  createWin();
  createTray();
  // 全局快捷键 Ctrl+Alt+F 唤起/隐藏主窗口；被占用时静默降级，不影响启动
  const ok = globalShortcut.register('Control+Alt+F', toggleWin);
  if(!ok) console.warn('全局快捷键 Ctrl+Alt+F 注册失败（可能被占用），已静默跳过');
});

app.on('window-all-closed', () => { /* 托盘驻留：窗口关完也不退出（Stretchly 同款） */ });
app.on('before-quit', () => { isQuitting = true; globalShortcut.unregisterAll(); });
