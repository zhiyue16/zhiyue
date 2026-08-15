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
let miniWin = null, miniSnapped = null, miniCollapsed = false, miniMoving = false, miniEditorWin = null;
let miniAnimating = false, miniPeek = false, animTimer = null, pendingSnapTimer = null, hideTimer = null, cursorPoll = null, hoverPoll = null;
const MINI_W = 193, MINI_H = 123, MINI_H_MIN = 73; // v1.28.2 整体缩 1/3（mini.html body zoom:.6667）
// QQ 式贴边隐藏（v1.28.3）：20px 触发区 + 300ms 停留防误吸；吸附=滑出屏幕只露 4px 细条；
// 悬停细条滑出完整卡片，离开 500ms 自动收回；拖离 28px 恢复
const EDGE_ZONE = 20, DWELL_MS = 300, SLIVER = 4, UNSNAP = 28;
const ANIM_SNAP = 230, ANIM_PEEK = 200, ANIM_UNSNAP = 180, HIDE_DELAY = 500, POLL_MS = 300;
const EDITOR_W = 250, EDITOR_H = 175; // 时长弹窗独立窗口（含阴影留白）

function sendMiniSnap(){ if(miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('rft:mini:snap', miniSnapped); }
function sendMiniPeek(v){ if(miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('rft:mini:peek', v); }
function clearSnapTimers(){
  if(pendingSnapTimer){ clearTimeout(pendingSnapTimer); pendingSnapTimer = null; }
  if(hideTimer){ clearTimeout(hideTimer); hideTimer = null; }
  if(cursorPoll){ clearInterval(cursorPoll); cursorPoll = null; }
  if(hoverPoll){ clearInterval(hoverPoll); hoverPoll = null; }
}

/* 细条隐藏态的悬停检测（主进程光标轮询）。
   注意：不能依赖渲染进程 mouseenter——浮窗渲染视口恒为 800×600（Chromium 视图未随窗口重排的已知
   假象，见交接文档），细条可见区在视口边缘，OS 级鼠标事件送不到渲染层，必须用 getCursorScreenPoint 轮询 */
function startHoverPoll(){
  if(hoverPoll) return;
  hoverPoll = setInterval(() => {
    if(!miniWin || miniWin.isDestroyed() || !miniSnapped || miniPeek || miniAnimating) return;
    const p = screen.getCursorScreenPoint();
    const b = miniWin.getBounds();
    const wa = screen.getPrimaryDisplay().workArea;
    // 可见细条 + 紧邻屏幕边缘 3px 都算触发区；y 取窗口范围（上下各让 2px）
    const inX = miniSnapped === 'left'
      ? (p.x >= wa.x && p.x <= wa.x + SLIVER + 3)
      : (p.x >= wa.x + wa.width - SLIVER - 3 && p.x <= wa.x + wa.width);
    const inY = p.y >= b.y - 2 && p.y <= b.y + b.height + 2;
    if(inX && inY) peekShow();
  }, POLL_MS);
}

/* 窗口动画：Electron 无窗口动画 API，16ms 定时器逐帧 setBounds + ease-out cubic。
   miniAnimating 防 move 回调重入（沿用 miniMoving 思路）；新动画可打断旧动画 */
function animateBounds(target, ms, done){
  if(!miniWin || miniWin.isDestroyed()) return;
  if(animTimer){ clearInterval(animTimer); animTimer = null; }
  const from = miniWin.getBounds(), t0 = Date.now();
  miniAnimating = true;
  animTimer = setInterval(() => {
    if(!miniWin || miniWin.isDestroyed()){ clearInterval(animTimer); animTimer = null; miniAnimating = false; return; }
    let t = (Date.now() - t0) / ms; if(t > 1) t = 1;
    const e = 1 - Math.pow(1 - t, 3);
    miniWin.setBounds({
      x: Math.round(from.x + (target.x - from.x) * e),
      y: Math.round(from.y + (target.y - from.y) * e),
      width: Math.round(from.width + (target.width - from.width) * e),
      height: Math.round(from.height + (target.height - from.height) * e)
    });
    if(t === 1){ clearInterval(animTimer); animTimer = null; miniAnimating = false; if(done) done(); }
  }, 16);
}

/* 吸附隐藏：宽高不变，只滑出屏幕（左缘露右侧 4px / 右缘露左侧 4px），细条高度=卡片当前高度 */
function snapHide(side, opts){
  if(!miniWin || miniWin.isDestroyed()) return;
  closeMiniEditor(); // 吸附即关弹窗（浮窗位置/形态变化，锚点失效）
  clearSnapTimers();
  const wa = screen.getPrimaryDisplay().workArea; // 已知限制：只适配主屏，多屏不处理
  const b = miniWin.getBounds();
  const h = miniCollapsed ? MINI_H_MIN : MINI_H;
  const target = {
    x: side === 'left' ? wa.x - (MINI_W - SLIVER) : wa.x + wa.width - SLIVER,
    y: Math.max(wa.y, Math.min(b.y, wa.y + wa.height - h)), // 不超出工作区
    width: MINI_W, height: h
  };
  miniSnapped = side;
  miniPeek = false;
  if(opts && opts.animate === false){
    miniMoving = true; miniWin.setBounds(target); miniMoving = false;
    sendMiniSnap();
    startHoverPoll();
  }else{
    animateBounds(target, ANIM_SNAP, () => { sendMiniSnap(); startHoverPoll(); }); // 滑出完成再切细条视图（过程中卡片在滑动）
  }
}

/* 悬停展开：主进程光标轮询发现光标进入细条 → 切回卡片并滑回屏内；换成离开检测轮询负责自动收回 */
function peekShow(){
  if(!miniWin || miniWin.isDestroyed() || !miniSnapped || miniPeek) return;
  miniPeek = true;
  if(hoverPoll){ clearInterval(hoverPoll); hoverPoll = null; }
  const wa = screen.getPrimaryDisplay().workArea;
  const b = miniWin.getBounds();
  const h = miniCollapsed ? MINI_H_MIN : MINI_H;
  const target = {
    x: miniSnapped === 'left' ? wa.x : wa.x + wa.width - MINI_W,
    y: Math.max(wa.y, Math.min(b.y, wa.y + wa.height - h)),
    width: MINI_W, height: h
  };
  sendMiniPeek(true); // 先切回卡片再滑出
  animateBounds(target, ANIM_PEEK);
  cursorPoll = setInterval(() => {
    if(!miniWin || miniWin.isDestroyed() || !miniPeek){ clearSnapTimers(); return; }
    const p = screen.getCursorScreenPoint(), bb = miniWin.getBounds();
    const inside = p.x >= bb.x && p.x < bb.x + bb.width && p.y >= bb.y && p.y < bb.y + bb.height;
    if(inside){ if(hideTimer){ clearTimeout(hideTimer); hideTimer = null; } }
    else if(!hideTimer){ hideTimer = setTimeout(peekHide, HIDE_DELAY); }
  }, POLL_MS);
}

/* 自动收回：滑回细条位后切回细条视图 */
function peekHide(){
  if(!miniPeek) return;
  miniPeek = false;
  clearSnapTimers();
  closeMiniEditor(); // 收回即关弹窗（浮窗位置变化，锚点失效）
  if(!miniWin || miniWin.isDestroyed() || !miniSnapped) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const b = miniWin.getBounds();
  animateBounds({
    x: miniSnapped === 'left' ? wa.x - (MINI_W - SLIVER) : wa.x + wa.width - SLIVER,
    y: b.y, width: MINI_W, height: b.height
  }, ANIM_SNAP, () => { sendMiniPeek(false); startHoverPoll(); });
}

function onMiniMove(){
  if(miniMoving || miniAnimating || !miniWin || miniWin.isDestroyed()) return;
  closeMiniEditor(); // 拖动浮窗即关弹窗（弹窗位置锚定浮窗，拖动后锚点失效）
  const wa = screen.getPrimaryDisplay().workArea;
  const b = miniWin.getBounds();
  if(miniSnapped){ // 吸附/悬停展开中：拖离边缘 >28px 则恢复正常浮窗（位置以拖动点为中心）
    const far = b.x > wa.x + UNSNAP && b.x + b.width < wa.x + wa.width - UNSNAP;
    if(far){
      miniSnapped = null;
      miniPeek = false;
      clearSnapTimers();
      const h = miniCollapsed ? MINI_H_MIN : MINI_H;
      animateBounds({ x: Math.round(b.x + b.width/2 - MINI_W/2), y: b.y, width: MINI_W, height: h }, ANIM_UNSNAP);
      sendMiniSnap();      // null → 渲染层回卡片并清 rft_mini_snap
      sendMiniPeek(false); // 保险：清 peek 态
    }
    return;
  }
  // 未吸附：进 20px 触发区且停留 300ms 才吸附（快速扫过不触发）
  const nearLeft = b.x <= wa.x + EDGE_ZONE, nearRight = b.x + b.width >= wa.x + wa.width - EDGE_ZONE;
  if(nearLeft || nearRight){
    if(!pendingSnapTimer){
      pendingSnapTimer = setTimeout(() => {
        pendingSnapTimer = null;
        if(!miniWin || miniWin.isDestroyed() || miniAnimating || miniMoving || miniSnapped) return;
        const bb = miniWin.getBounds();
        const inL = bb.x <= wa.x + EDGE_ZONE, inR = bb.x + bb.width >= wa.x + wa.width - EDGE_ZONE;
        if(inL || inR) snapHide(inL ? 'left' : 'right');
      }, DWELL_MS);
    }
  }else if(pendingSnapTimer){ clearTimeout(pendingSnapTimer); pendingSnapTimer = null; }
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
  miniWin.once('closed', () => { miniWin = null; miniSnapped = null; miniPeek = false; clearSnapTimers(); closeMiniEditor(); updateTrayMenu(); });
  updateTrayMenu();
}

/* 时长弹窗（v1.28.2）：独立小窗口，天然可显示在浮窗卡片之外（不存在"溢出"问题）。
   锚点：浮窗渲染进程报来时间数字的窗内坐标，主进程换算屏幕坐标；阴影留白 36px 在 mini-editor.html 的 body padding */
function closeMiniEditor(){ if(miniEditorWin && !miniEditorWin.isDestroyed()) miniEditorWin.close(); miniEditorWin = null; }
ipcMain.on('rft:mini:editoropen', (e, anchor) => {
  if(!miniWin || miniWin.isDestroyed() || (miniSnapped && !miniPeek) || !anchor) return; // 细条隐藏态不可开，悬停展开（peek）中可以
  closeMiniEditor();
  const b = miniWin.getBounds();
  const wa = screen.getPrimaryDisplay().workArea;
  const x = Math.max(wa.x, Math.min(b.x + (anchor.dx|0) - 36, wa.x + wa.width - EDITOR_W));
  const y = Math.max(wa.y, Math.min(b.y + (anchor.dy|0) - 36, wa.y + wa.height - EDITOR_H));
  miniEditorWin = new BrowserWindow({
    width: EDITOR_W, height: EDITOR_H, x, y,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    show: false, transparent: true, backgroundThrottling: false,
    icon: path.join(__dirname, '..', 'icon-512.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  const q = `?focus=${anchor.focus|0}&theme=${anchor.theme === 'dark' ? 'dark' : 'light'}&fest=${encodeURIComponent(anchor.fest || '')}`;
  miniEditorWin.loadFile(path.join(__dirname, '..', 'mini-editor.html') , { search: q });
  miniEditorWin.once('ready-to-show', () => { if(miniEditorWin && !miniEditorWin.isDestroyed()){ miniEditorWin.show(); miniEditorWin.focus(); } });
  miniEditorWin.once('closed', () => { miniEditorWin = null; });
});
/* 弹窗结果：commit=钳制后转发主窗口 setFocus（与浮窗同一命令通道）；cancel=直接关 */
ipcMain.on('rft:mini:editorcmd', (e, msg) => {
  if(msg && msg.type === 'commit' && win && !win.isDestroyed()){
    const v = Math.min(180, Math.max(5, msg.value|0));
    win.webContents.send('rft:mini:cmd', { type: 'setFocus', payload: v });
  }
  closeMiniEditor();
});

ipcMain.on('rft:mini:open', createMiniWin);
ipcMain.on('rft:mini:close', () => { if(miniWin) miniWin.close(); });
ipcMain.on('rft:mini:collapse', (e, c) => {
  miniCollapsed = !!c;
  closeMiniEditor(); // 收起/展开即关弹窗（浮窗高度变化，锚点失效）
  // 用 setBounds 而非 setSize：Windows + resizable:false 下 setSize 第二次调用会被忽略（v1.27.1 修复二次收起失效）
  if(miniWin && !miniSnapped){
    const b = miniWin.getBounds();
    miniWin.setBounds({ x: b.x, y: b.y, width: MINI_W, height: miniCollapsed ? MINI_H_MIN : MINI_H });
  }
});
ipcMain.on('rft:mini:snapstate', (e, side) => { if(side && miniWin) snapHide(side, { animate: false }); }); // 浮窗启动时回报记忆的吸附侧（直接到位，无动画）
ipcMain.on('rft:mini:peekshow', () => peekShow()); // 细条悬停 → 展开完整卡片
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
