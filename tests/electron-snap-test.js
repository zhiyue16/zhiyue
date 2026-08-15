// 贴边隐藏 OS 级集成测试（v1.28.3）：PowerShell user32 移窗/移光标 + CDP 读渲染态。
// 覆盖：停留吸附 / 快速扫过不误吸 / 悬停展开 / 离开自动收回 / 拖出恢复。
// 连常驻实例（connect-first，不杀进程）；需先手动重启实例加载最新 main.js。
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { ps, rect, wa } = require('./winops');
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passN = 0, failN = 0;
const pass = (name, cond, extra) => {
  if (cond) passN++; else failN++;
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
};


(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
  // 清掉 puppeteer 接管时下发的 defaultViewport 800×600 覆盖（v1.28.3 排障结论：覆盖导致渲染视口错位+输入死区）
  const adopt = async p => { if (p) { try { await p.setViewport(null); } catch (e) {} } return p; };
  const main = await adopt((await browser.pages()).find(p => p.url().includes('index.html')));
  // 确保浮窗开着且处于常规（未吸附、展开）状态，移到屏幕中部
  await main.evaluate(() => window.electronAPI.miniOpen());
  await sleep(2000);
  let mini = await adopt((await browser.pages()).find(p => p.url().includes('mini.html')));
  await mini.evaluate(() => {
    localStorage.removeItem('rft_mini_snap');
    localStorage.setItem('rft_mini_collapsed', 'false');
    document.getElementById('card').classList.remove('collapsed');
    window.electronAPI.miniCollapse(false); // 归一展开态（窗口尺寸与类同步）
  });
  const bodySnapped = () => mini.evaluate(() => document.body.classList.contains('snapped'));
  const lsSnap = () => mini.evaluate(() => localStorage.getItem('rft_mini_snap'));
  let [wax, way, waw, wah] = wa();
  let r = rect();
  ps('move', Math.round(wax + waw / 2), Math.round(way + wah / 2)); // 先挪到屏中（触发一次 move，清掉旧吸附态）
  await sleep(800);
  if (await bodySnapped()) { // 还吸附着则拖出恢复
    ps('move', Math.round(wax + waw / 2), Math.round(way + wah / 2));
    await sleep(800);
  }
  console.log('--- 初始:', ps('rect'), 'wa:', wax, way, waw, wah, '---');

  // 1. 停留吸附：移到距左缘 5px，停 300ms+ → 滑出只露 4px
  const midY = Math.round(way + wah / 2);
  ps('move', wax + 5, midY);
  await sleep(1200); // 300ms 停留 + 230ms 动画 + 余量
  r = rect();
  pass('吸附: 停留后滑出屏幕（x≈wa.x-189）', Math.abs(r[0] - (wax - 189)) <= 3, 'x=' + r[0]);
  pass('吸附: 宽度保持 193（只露4px细条）', r[2] === 193, 'w=' + r[2]);
  pass('吸附: 渲染层切到细条视图', await bodySnapped());
  pass('吸附: 吸附侧已记忆', (await lsSnap()) === '"left"');
  ps('shot', wax, midY - 10, 60, 140, path.join(OUT, 'snap-1-sliver.png'));
  console.log('saved snap-1-sliver.png');

  // 2. 悬停展开：光标移到细条上 → 滑回完整卡片
  ps('cursor', wax + 2, midY + 30);
  await sleep(1200); // mouseenter + 200ms 动画 + 余量
  r = rect();
  pass('悬停: 滑回屏内（x≈wa.x）', Math.abs(r[0] - wax) <= 3, 'x=' + r[0]);
  pass('悬停: 渲染层回卡片视图', !(await bodySnapped()));
  ps('shot', wax, midY - 10, 240, 140, path.join(OUT, 'snap-2-peek.png'));
  console.log('saved snap-2-peek.png');

  // 3. 离开自动收回：光标移到屏幕中央 → 500ms 后收回
  ps('cursor', Math.round(wax + waw / 2), Math.round(way + wah / 2));
  await sleep(1800); // 轮询 300ms + 500ms 延迟 + 230ms 动画 + 余量
  r = rect();
  pass('收回: 离开后自动滑回细条（x≈wa.x-189）', Math.abs(r[0] - (wax - 189)) <= 3, 'x=' + r[0]);
  pass('收回: 渲染层回细条视图', await bodySnapped());

  // 4. 拖出恢复：细条被拖到屏中 → 恢复完整浮窗（位置≈拖动点）
  const dragX = Math.round(wax + waw / 2) - 100, dragY = Math.round(way + wah / 2) - 80;
  ps('move', dragX, dragY);
  await sleep(1000);
  r = rect();
  pass('拖出: 恢复完整浮窗（宽 193）', r[2] === 193, 'w=' + r[2]);
  pass('拖出: 位置≈拖动点（x≈目标±3）', Math.abs(r[0] - dragX) <= 3 && Math.abs(r[1] - dragY) <= 3, 'x=' + r[0] + ' y=' + r[1]);
  pass('拖出: 渲染层回卡片且清除吸附记忆', !(await bodySnapped()) && (await lsSnap()) === 'null');

  // 5. 快速扫过不误吸：进 20px 区 100ms 即移走（sweep 模式在 PS 进程内完成，消除启动延迟）→ 不吸附
  ps('sweep', wax + 8, dragY + 120, dragX, dragY + 120);
  await sleep(700);
  r = rect();
  pass('防误吸: 快速扫过不吸附', !(await bodySnapped()) && r[0] > wax + 100, 'x=' + r[0]);

  // 6. 右缘对称验证：停留吸附 → 悬停展开 → 离开收回 → 拖出
  ps('move', wax + waw - 193 - 5, midY); // 右缘 5px 触发区内
  await sleep(1200);
  r = rect();
  pass('右缘: 吸附后只露 4px（x≈wa 右缘-4）', Math.abs(r[0] - (wax + waw - 4)) <= 3, 'x=' + r[0]);
  pass('右缘: 记忆 right', (await lsSnap()) === '"right"');
  ps('cursor', wax + waw - 2, midY + 30);
  await sleep(1200);
  r = rect();
  pass('右缘: 悬停展开（x≈wa 右缘-193）', Math.abs(r[0] - (wax + waw - 193)) <= 3, 'x=' + r[0]);
  ps('cursor', Math.round(wax + waw / 2), Math.round(way + wah / 2));
  await sleep(1800);
  r = rect();
  pass('右缘: 离开自动收回', Math.abs(r[0] - (wax + waw - 4)) <= 3, 'x=' + r[0]);
  ps('move', dragX, dragY);
  await sleep(1000);
  r = rect();
  pass('右缘: 拖出恢复且清记忆', r[2] === 193 && (await lsSnap()) === 'null', 'w=' + r[2]);

  // 收尾：浮窗留在屏幕中部常规态
  ps('cursor', Math.round(wax + waw / 2), Math.round(way + 200));
  browser.disconnect();
  console.log(`\n===== ${passN}/${passN + failN} 通过 =====`);
  process.exit(failN ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
