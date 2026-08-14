// 真实 Electron 客户端三态截图：常规 / 最大化 / 最小化到托盘后呼出
// 原理：--remote-debugging-port 启动客户端，puppeteer.connect 接管页面；
// 呼出 = 关窗入托盘后再起一个实例，单例锁触发 second-instance → showWin()（零产品代码污染）
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
  // 连接优先：已有常驻实例（带调试端口）直接用；没有才新起一个（约定：不杀进程、测试完保持运行）
  let browser = null;
  try { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' }); } catch (e) {}
  if (!browser) {
    const appLog = fs.openSync(path.join(__dirname, 'electron-app.log'), 'w');
    spawn(ELECTRON, ['--remote-debugging-port=9222', '.'], { cwd: ROOT, stdio: ['ignore', appLog, appLog], detached: true });
    for (let i = 0; i < 15 && !browser; i++) {
      await sleep(1500);
      try { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' }); } catch (e) { /* 还没起 */ }
    }
  }
  if (!browser) throw new Error('无法连接 Electron 调试端口（详见 electron-app.log）');
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('index.html')) || pages[0];
  await page.reload({ waitUntil: 'load' }); // 重载拿到最新代码
  await sleep(2500); // 等页面完全稳定再截图（避免捕获到启动过渡态）
  await page.screenshot({ path: path.join(OUT, 'frameless-normal.png') });
  console.log('saved frameless-normal.png');

  // 最大化
  await page.evaluate(() => window.electronAPI.windowMaxToggle());
  await sleep(900);
  await page.screenshot({ path: path.join(OUT, 'frameless-max.png') });
  console.log('saved frameless-max.png');

  // 关窗 → 托盘；再起一个实例触发 second-instance 呼出
  await page.evaluate(() => window.electronAPI.windowClose());
  await sleep(900);
  const app2 = spawn(ELECTRON, ['.'], { cwd: ROOT, stdio: 'ignore', detached: true });
  await sleep(2500);
  await page.screenshot({ path: path.join(OUT, 'frameless-recall.png') });
  console.log('saved frameless-recall.png');

  browser.disconnect();
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
