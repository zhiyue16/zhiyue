// Mini 浮窗七态实拍（对齐参考图）：展开/收起/···菜单/计时中/暂停中/吸附竖条/吸附填充
// CDP 连接常驻开发实例（约定：不杀进程、测试完保持运行，供用户手动验收）
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 连接优先：已有常驻实例（带调试端口）直接用；没有才新起一个（也不杀旧进程）
async function connectOrLaunch() {
  try { return await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' }); } catch (e) {}
  const appLog = fs.openSync(path.join(__dirname, 'electron-app.log'), 'w');
  spawn(ELECTRON, ['--remote-debugging-port=9222', '.'], { cwd: ROOT, stdio: ['ignore', appLog, appLog], detached: true });
  for (let i = 0; i < 15; i++) {
    await sleep(1500);
    try { return await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' }); } catch (e) {}
  }
  throw new Error('无法连接 Electron 调试端口');
}

(async () => {
  const browser = await connectOrLaunch();

  // 关键（v1.28.3 排障结论）：puppeteer connect 会给接管的 target 下发 defaultViewport 800×600 覆盖，
  // 导致渲染视口与 OS 窗口错位、底部输入死区。取到页面一律先 setViewport(null) 清覆盖；
  // 本脚本不再用 setViewport 设尺寸——清覆盖后 CDP 截图天然就是真实窗口内容。
  const adopt = async p => { if (p) { try { await p.setViewport(null); } catch (e) {} } return p; };
  const findMain = async () => adopt((await browser.pages()).find(p => p.url().includes('index.html')));
  const findMini = async () => adopt((await browser.pages()).find(p => p.url().includes('mini.html')));
  let main = await findMain();
  // 重载拿到最新代码（页面改动 reload 即生效，无需重启实例）
  await main.reload({ waitUntil: 'load' });
  await sleep(1200);
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
  const shot = async (name) => {
    await sleep(300);
    await mini.screenshot({ path: path.join(OUT, name) });
    console.log('saved', name);
  };

  // 1. 展开态（无悬停：按钮隐藏）
  await shot('mini-1-expanded.png');
  // 1b. 展开态（悬停：按钮淡入）
  await mini.hover('#card'); await sleep(450);
  await mini.screenshot({ path: path.join(OUT, 'mini-1b-expanded-hover.png') });
  console.log('saved mini-1b-expanded-hover.png');
  // 2. 收起态（悬停）：先收起（真实视口=窗口尺寸，hover 落点天然正确）
  await mini.evaluate(() => document.getElementById('mCollapse').click());
  await sleep(700);
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
  await mini.evaluate(() => document.getElementById('mMore').click());
  await sleep(400);
  await mini.screenshot({ path: path.join(OUT, 'mini-3-menu.png') });
  console.log('saved mini-3-menu.png');
  await mini.evaluate(() => document.body.click()); // 关菜单
  // 3c/3d. 时长弹窗（v1.28.2 独立窗口）：展开态 + 收起态各一张。弹窗是独立 BrowserWindow，
  // 通过页面列表找 mini-editor.html；接管后同样先 setViewport(null) 清默认覆盖
  const shotEditor = async name => {
    await mini.evaluate(() => document.getElementById('mTime').click());
    let ed = null;
    for (let i = 0; i < 10 && !ed; i++) { await sleep(500); ed = (await browser.pages()).find(p => p.url().includes('mini-editor.html')); }
    if (!ed) throw new Error('弹窗窗口未出现');
    await ed.setViewport(null);
    await sleep(400);
    await ed.screenshot({ path: path.join(OUT, name) });
    console.log('saved', name);
    await ed.evaluate(() => document.getElementById('fdCancel').click());
    await sleep(600);
  };
  await shotEditor('mini-3c-editor-expanded.png');
  await mini.evaluate(() => document.getElementById('mCollapse').click()); // 收起
  await sleep(700);
  await shotEditor('mini-3d-editor-collapsed.png');
  await mini.evaluate(() => document.getElementById('mCollapse').click()); // 恢复展开
  await sleep(700);
  // 4. 计时中（改 5 分钟 → 开始）
  await mini.evaluate(() => window.electronAPI.miniCmd('setFocus', 5));
  await sleep(300);
  await mini.evaluate(() => window.electronAPI.miniCmd('start'));
  await sleep(2500);
  await shot('mini-4-timing.png');
  // 5. 暂停中（环内恢复+结束）
  await mini.evaluate(() => window.electronAPI.miniCmd('pause'));
  await sleep(800);
  await shot('mini-5-paused.png');
  // 恢复计时，让进度积累到约 25% 再吸附（填充可见）
  await mini.evaluate(() => window.electronAPI.miniCmd('pause'));
  await sleep(60000); // 真跑 60 秒（5 分钟番茄 ≈ 20%+）
  // 6/7. 贴边隐藏（v1.28.3）：吸附镜头用 OS 屏幕区域截图（winops 走 user32，按真实窗口矩形取图）
  const winops = require('./winops');
  await mini.evaluate(() => window.electronAPI.miniReportSnap('right'));
  await sleep(1500); // 直接到位（无动画路径）
  const [wx, wy, ww, wh] = winops.wa();
  let mr = winops.rect();
  winops.ps('shot', wx + ww - 60, mr[1] - 10, 60, 150, path.join(OUT, 'mini-6-snap-sliver.png'));
  console.log('saved mini-6-snap-sliver.png');
  // 悬停展开（主进程光标轮询触发）
  winops.ps('cursor', wx + ww - 2, mr[1] + 30);
  await sleep(1200);
  mr = winops.rect();
  winops.ps('shot', wx + ww - 240, mr[1] - 10, 240, 150, path.join(OUT, 'mini-7-snap-peek.png'));
  console.log('saved mini-7-snap-peek.png');
  winops.ps('cursor', Math.round(wx + ww / 2), Math.round(wy + wh / 2)); // 光标移开让它收回
  await sleep(1500);

  // 结束计时（把实测起的番茄停掉），断开连接但保持实例运行（用户还要手动验收）
  await mini.evaluate(() => window.electronAPI.miniCmd('stop')).catch(() => {});
  await sleep(800);
  await main.evaluate(() => { // 实拍残留的测试番茄一律丢弃，不进统计
    const mask = document.getElementById('abandonMask');
    if (mask && mask.classList.contains('show')) document.getElementById('abandonOk').click();
  });
  await sleep(500);
  // 解除吸附+恢复展开，把浮窗还原到常规卡片态（不残留 12px 竖条在屏幕上）
  await mini.evaluate(() => {
    localStorage.removeItem('rft_mini_snap');
    localStorage.setItem('rft_mini_collapsed', 'false');
    window.electronAPI.miniClose();
  });
  await sleep(1000);
  await main.evaluate(() => window.electronAPI.miniOpen());
  await sleep(1500);
  browser.disconnect();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
