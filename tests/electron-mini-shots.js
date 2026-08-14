// Mini 浮窗七态实拍（对齐参考图）：展开/收起/···菜单/计时中/暂停中/吸附竖条/吸附填充
// CDP 连真实客户端；浅色主题拍摄；吸附走主进程真实 snapMiniTo('right')
const puppeteer = require('puppeteer-core');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  try { execSync('taskkill /F /T /IM electron.exe 2>nul'); } catch (e) {}
  await sleep(1200);
  const appLog = fs.openSync(path.join(__dirname, 'electron-app.log'), 'w');
  spawn(ELECTRON, ['--remote-debugging-port=9222', '.'], { cwd: ROOT, stdio: ['ignore', appLog, appLog], detached: true });
  let browser = null;
  for (let i = 0; i < 15 && !browser; i++) {
    await sleep(1500);
    try { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' }); } catch (e) {}
  }
  if (!browser) throw new Error('无法连接 Electron 调试端口');

  const findMain = async () => (await browser.pages()).find(p => p.url().includes('index.html'));
  const findMini = async () => (await browser.pages()).find(p => p.url().includes('mini.html'));
  let main = await findMain();
  // 统一浅色主题拍摄（清掉之前残留的 dark 设置）
  await main.evaluate(() => {
    const c = JSON.parse(localStorage.getItem('rft_cfg') || '{}');
    c.theme = 'light';
    localStorage.setItem('rft_cfg', JSON.stringify(c));
    location.reload();
  });
  await sleep(2000);
  main = await findMain();

  // 0. 齿轮小菜单
  await main.click('#panelBtn');
  await sleep(400);
  await main.screenshot({ path: path.join(OUT, 'mini-0-gearmenu.png') });
  console.log('saved mini-0-gearmenu.png');

  // 打开浮窗
  await main.evaluate(() => window.electronAPI.miniOpen());
  let mini = null;
  for (let i = 0; i < 10 && !mini; i++) { await sleep(800); mini = await findMini(); }
  if (!mini) throw new Error('mini 窗口未出现');
  // 归一初始状态：清掉本地残留的收起/吸附记忆后重载浮窗页（否则卡片类与窗口尺寸互相错位）
  await mini.evaluate(() => {
    localStorage.setItem('rft_mini_collapsed', 'false');
    localStorage.removeItem('rft_mini_snap');
    location.reload();
  });
  await sleep(1500);
  mini = await findMini();
  await sleep(800);
  const shot = async (name, w, h) => {
    await mini.setViewport({ width: w, height: h });
    await sleep(400);
    await mini.screenshot({ path: path.join(OUT, name) });
    console.log('saved', name);
  };

  // 1. 展开态（无悬停：按钮隐藏）
  await shot('mini-1-expanded.png', 290, 185);
  // 1b. 展开态（悬停：按钮淡入）
  await mini.hover('#card'); await sleep(450);
  await mini.screenshot({ path: path.join(OUT, 'mini-1b-expanded-hover.png') });
  console.log('saved mini-1b-expanded-hover.png');
  // 2. 收起态（悬停）：先收起 → 先设 156 高视口再悬停（否则鼠标落点在窗外，hover 不生效）
  await mini.evaluate(() => document.getElementById('mCollapse').click());
  await sleep(700);
  await mini.setViewport({ width: 290, height: 110 });
  await sleep(300);
  await mini.hover('#card'); await sleep(450);
  await mini.screenshot({ path: path.join(OUT, 'mini-2-collapsed-hover.png') });
  console.log('saved mini-2-collapsed-hover.png');
  // 2b. 收起态（无悬停：内联强制 opacity 0 模拟鼠标移出后的最终态）
  await mini.evaluate(() => document.querySelector('.m-actions').style.setProperty('opacity', '0', 'important'));
  await sleep(300);
  await mini.screenshot({ path: path.join(OUT, 'mini-2-collapsed.png') });
  console.log('saved mini-2-collapsed.png');
  await mini.evaluate(() => document.querySelector('.m-actions').style.removeProperty('opacity'));
  // 3. ···菜单（展开态下打开）
  await mini.evaluate(() => document.getElementById('mCollapse').click());
  await sleep(700);
  await mini.setViewport({ width: 290, height: 185 });
  await mini.evaluate(() => document.getElementById('mMore').click());
  await sleep(400);
  await mini.screenshot({ path: path.join(OUT, 'mini-3-menu.png') });
  console.log('saved mini-3-menu.png');
  await mini.evaluate(() => document.body.click()); // 关菜单
  // 4. 计时中（改 5 分钟 → 开始）
  await mini.evaluate(() => window.electronAPI.miniCmd('setFocus', 5));
  await sleep(300);
  await mini.evaluate(() => window.electronAPI.miniCmd('start'));
  await sleep(2500);
  await shot('mini-4-timing.png', 290, 185);
  // 5. 暂停中（环内恢复+结束）
  await mini.evaluate(() => window.electronAPI.miniCmd('pause'));
  await sleep(800);
  await shot('mini-5-paused.png', 290, 185);
  // 恢复计时，让进度积累到约 25% 再吸附（填充可见）
  await mini.evaluate(() => window.electronAPI.miniCmd('pause'));
  await sleep(60000); // 真跑 60 秒（5 分钟番茄 ≈ 20%+）
  // 6/7. 右缘吸附竖条 + 填充
  await mini.evaluate(() => window.electronAPI.miniReportSnap('right'));
  await sleep(1200);
  await shot('mini-6-snap.png', 12, 360);
  await shot('mini-7-snap-fill.png', 40, 360); // 加宽视口拍填充细节（窗口本体仍 12px，此处只为看清）

  browser.disconnect();
  try { execSync('taskkill /F /T /IM electron.exe 2>nul'); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); try { execSync('taskkill /F /T /IM electron.exe 2>nul'); } catch (e2) {} process.exit(1); });
