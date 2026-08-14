// Electron 主进程：随机提示音专注计时器 · 桌面客户端
// 关键模式参考 Stretchly（github.com/hovancik/stretchly）：
//   单例窗口 + show:false/ready-to-show 防白闪 + window-all-closed 空函数托盘驻留
//   + setAppUserModelId（Windows 通知归属）+ setLoginItemSettings 自启
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, globalShortcut, nativeImage, screen } = require('electron');
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
    minWidth: 420, minHeight: 620,
    frame: false,                // 无边框（不用 transparent:true：Win 上有最大化动画缺失/显卡兼容坑）
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
  // 最大化状态同步渲染进程（自绘按钮切换"最大化/还原"图标）
  win.on('maximize', () => win && !win.isDestroyed() && win.webContents.send('rft:win:max-changed', true));
  win.on('unmaximize', () => win && !win.isDestroyed() && win.webContents.send('rft:win:max-changed', false));
}

/* 无边框窗口控制 IPC（v1.26.0）：渲染进程自绘按钮 → 主进程。
   close 走 win.close() → close 事件拦截为最小化到托盘，行为与系统关闭按钮一致 */
ipcMain.on('rft:win:min', () => { if(win) win.minimize(); });
ipcMain.on('rft:win:max', () => { if(win) win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('rft:win:close', () => { if(win) win.close(); });
ipcMain.handle('rft:win:isMax', () => win ? win.isMaximized() : false);

function updateTrayMenu(){
  if(!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showWin },
    { label: 'Mini 浮窗', type: 'checkbox', checked: !!miniWin,
      click: () => miniWin ? miniWin.close() : createMiniWin() },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]));
}

function createTray(){
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'icon-192.png')).resize({ width: 32 });
  tray = new Tray(img);
  tray.setToolTip('随机提示音专注计时器');
  tray.on('click', toggleWin); // 左键单击呼出/隐藏主窗口
  updateTrayMenu();
}

/* ================= Mini 浮窗（v1.27.0） =================
   遥控器架构：计时状态机只在主窗口渲染进程；浮窗是独立无边框 BrowserWindow，
   状态/命令都由主进程中转（rft:mini:state 下行 / rft:mini:cmd 上行） */
let miniWin = null, miniSnapped = null, miniCollapsed = false, miniMoving = false;
const MINI_W = 290, MINI_H = 185, MINI_H_MIN = 110, SNAP_W = 12; // 实测滴答清单尺寸；收起=仅隐藏底部统计栏(75px)，倒计时区域不动

function sendMiniSnap(){ if(miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('rft:mini:snap', miniSnapped); }

function snapMiniTo(side){
  if(!miniWin) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const b = miniWin.getBounds();
  const h = Math.round(wa.height / 3);
  miniSnapped = side;
  miniMoving = true;
  miniWin.setBounds({ // 贴边竖条：宽 12px、高约屏幕 1/3、垂直方向以拖动点为中心
    x: side === 'left' ? wa.x : wa.x + wa.width - SNAP_W,
    y: Math.max(wa.y, Math.min(Math.round(b.y + b.height/2 - h/2), wa.y + wa.height - h)),
    width: SNAP_W, height: h
  });
  miniMoving = false;
  sendMiniSnap();
}

function onMiniMove(){
  if(miniMoving || !miniWin || miniWin.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const b = miniWin.getBounds();
  const SNAP = 8, UNSNAP = 28;
  if(miniSnapped){ // 吸附中：拖离边缘则恢复正常浮窗
    const nearLeft = b.x <= wa.x + UNSNAP, nearRight = b.x + b.width >= wa.x + wa.width - UNSNAP;
    if(!nearLeft && !nearRight){
      miniSnapped = null;
      const w = MINI_W, h = miniCollapsed ? MINI_H_MIN : MINI_H;
      miniMoving = true;
      miniWin.setBounds({ x: Math.round(b.x + b.width/2 - w/2), y: b.y, width: w, height: h });
      miniMoving = false;
      sendMiniSnap();
    }
    return;
  }
  if(b.x <= wa.x + SNAP) snapMiniTo('left');
  else if(b.x + b.width >= wa.x + wa.width - SNAP) snapMiniTo('right');
}

function createMiniWin(){
  if(miniWin && !miniWin.isDestroyed()){ miniWin.show(); return; }
  miniWin = new BrowserWindow({
    width: MINI_W, height: MINI_H,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    show: false,
    backgroundThrottling: false,
    backgroundColor: '#f4f4f7',
    icon: path.join(__dirname, '..', 'icon-512.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  miniWin.loadFile(path.join(__dirname, '..', 'mini.html'));
  miniWin.once('ready-to-show', () => { miniWin.show(); sendMiniSnap(); });
  miniWin.on('move', onMiniMove);
  miniWin.once('closed', () => { miniWin = null; miniSnapped = null; updateTrayMenu(); });
  updateTrayMenu();
}

ipcMain.on('rft:mini:open', createMiniWin);
ipcMain.on('rft:mini:close', () => { if(miniWin) miniWin.close(); });
ipcMain.on('rft:mini:collapse', (e, c) => {
  miniCollapsed = !!c;
  // 用 setBounds 而非 setSize：Windows + resizable:false 下 setSize 第二次调用会被忽略（v1.27.1 修复二次收起失效）
  if(miniWin && !miniSnapped){
    const b = miniWin.getBounds();
    miniWin.setBounds({ x: b.x, y: b.y, width: MINI_W, height: miniCollapsed ? MINI_H_MIN : MINI_H });
  }
});
ipcMain.on('rft:mini:snapstate', (e, side) => { if(side && miniWin) snapMiniTo(side); }); // 浮窗启动时回报记忆的吸附侧
ipcMain.on('rft:mini:cmd', (e, cmd) => { if(win && !win.isDestroyed()) win.webContents.send('rft:mini:cmd', cmd); });
ipcMain.on('rft:mini:state', (e, s) => { if(miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('rft:mini:state', s); });
ipcMain.on('rft:win:show', showWin);

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

/* ================= 自动更新（electron-updater + GitHub Releases，v1.25.0） =================
   数据源：GitHub 仓库 zhiyue16/zhiyue 最新 Release 里的 latest.yml（package.json build.publish 配置）。
   断网/GitHub 不可达/dev 环境一律静默降级，不影响应用正常使用 */
let autoUpdater = null;
try{ autoUpdater = require('electron-updater').autoUpdater; }
catch(e){ console.warn('electron-updater 不可用（静默降级）', e.message); }
function sendUpd(state, extra){ if(win && !win.isDestroyed()) win.webContents.send('rft:update:status', Object.assign({state}, extra)); }
if(autoUpdater){
  autoUpdater.autoDownload = false; // 用户确认后再下载
  autoUpdater.on('checking-for-update', () => sendUpd('checking'));
  autoUpdater.on('update-available', info => {
    sendUpd('available', { version: info.version });
    const n = new Notification({ title: `发现新版本 v${info.version}`, body: '点击开始后台下载更新',
      icon: path.join(__dirname, '..', 'icon-192.png') });
    n.on('click', () => autoUpdater.downloadUpdate());
    n.show();
  });
  autoUpdater.on('update-not-available', () => sendUpd('latest'));
  autoUpdater.on('download-progress', p => sendUpd('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => {
    sendUpd('ready', { version: info.version });
    const n = new Notification({ title: '更新已就绪', body: '点击重启应用完成升级',
      icon: path.join(__dirname, '..', 'icon-192.png') });
    n.on('click', () => { isQuitting = true; autoUpdater.quitAndInstall(); });
    n.show();
  });
  autoUpdater.on('error', err => { console.warn('自动更新失败（静默降级）', err.message); sendUpd('error'); });
}
ipcMain.handle('rft:update:check', async () => {
  if(!autoUpdater){ sendUpd('error'); return; }
  if(!app.isPackaged){ sendUpd('dev'); return; } // dev 模式无 app-update.yml，autoUpdater 不可用
  try{ await autoUpdater.checkForUpdates(); }catch(e){ /* error 事件已统一处理 */ }
});
ipcMain.handle('rft:update:download', () => { if(autoUpdater) autoUpdater.downloadUpdate(); });
ipcMain.handle('rft:update:install', () => { isQuitting = true; if(autoUpdater) autoUpdater.quitAndInstall(); });
ipcMain.handle('rft:version', () => app.getVersion());

app.whenReady().then(() => {
  createWin();
  createTray();
  // 全局快捷键 Ctrl+Alt+F 唤起/隐藏主窗口；被占用时静默降级，不影响启动
  const ok = globalShortcut.register('Control+Alt+F', toggleWin);
  if(!ok) console.warn('全局快捷键 Ctrl+Alt+F 注册失败（可能被占用），已静默跳过');
  // 启动时静默检查更新（仅打包版；失败走 error 静默降级）
  if(autoUpdater && app.isPackaged) autoUpdater.checkForUpdates().catch(()=>{});
});

app.on('window-all-closed', () => { /* 托盘驻留：窗口关完也不退出（Stretchly 同款） */ });
app.on('before-quit', () => { isQuitting = true; globalShortcut.unregisterAll(); });
