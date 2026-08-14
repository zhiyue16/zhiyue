// 随机提示音专注计时器 · 自动化回归（puppeteer-core + 本机 Chrome）
// 时间扭曲法：evaluateOnNewDocument 覆写 Date.now 注入偏移，IIFE 内部不可访问，全部 DOM 断言
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const path = require('path');

const BASE = 'http://127.0.0.1:8931';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const results = [];
let browser;

function pass(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 新开页面：可选预置 localStorage、URL 查询串（如 ?festdate= 模拟节日）、Electron 环境桩，装可控时钟
async function newPage(seed, query, electron, ctx) {
  const page = await (ctx || browser).newPage();
  await page.evaluateOnNewDocument((seedStr, isElectron) => {
    // 可控时钟：Date.now 加偏移；__warp(ms) 快进
    let offset = 0;
    const real = Date.now.bind(Date);
    Date.now = () => real() + offset;
    window.__warp = ms => { offset += ms; };
    if (isElectron) { // 模拟 electron/preload.js 注入的 electronAPI（含 IPC 行为记录）
      window.__notified = [];
      window.electronAPI = { notify: k => window.__notified.push(k),
        getAutoLaunch: async () => !!window.__autoLaunch,
        setAutoLaunch: async v => { window.__autoLaunch = v; return v; },
        checkUpdate: async () => { window.__updChecks = (window.__updChecks||0)+1; },
        downloadUpdate: async () => { window.__updDownloads = (window.__updDownloads||0)+1; },
        installUpdate: async () => { window.__updInstalls = (window.__updInstalls||0)+1; },
        getVersion: async () => '1.25.0-test',
        onUpdateStatus: cb => { window.__updCb = cb; },
        windowMin: () => { window.__winMin = (window.__winMin||0)+1; },
        windowMaxToggle: () => { window.__winMax = (window.__winMax||0)+1; },
        windowClose: () => { window.__winClose = (window.__winClose||0)+1; },
        windowIsMax: async () => !!window.__winIsMax,
        onMaxChange: cb => { window.__maxCb = cb; } };
    }
    if (seedStr) {
      const seed = JSON.parse(seedStr);
      localStorage.clear();
      for (const k in seed) localStorage.setItem(k, JSON.stringify(seed[k]));
    } else localStorage.clear();
  }, seed ? JSON.stringify(seed) : null, !!electron);
  await page.setRequestInterception(true);
  page.on('request', r => { if (r.url().includes('hm.baidu.com')) r.abort(); else r.continue(); });
  await page.goto(BASE + '/index.html' + (query || ''), { waitUntil: 'load' });
  await sleep(400); // 等初始化 + 几个 worker tick
  return page;
}
const warp = (page, ms) => page.evaluate(m => window.__warp(m), ms).then(() => sleep(450));
const txt = (page, id) => page.$eval('#' + id, el => el.textContent);
const vis = (page, id) => page.$eval('#' + id, el => !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none');
const shown = (page, id) => page.$eval('#' + id, el => el.classList.contains('show'));
const phase = page => txt(page, 'phaseText');
const cfg = (over) => Object.assign({ focus: 90, minInt: 3, maxInt: 5, rest: 20, sound: 'bell', theme: 'light', volume: 100, goal: 4, continuous: false }, over);

async function tMainFlow() {
  const page = await newPage({ rft_cfg: cfg({ focus: 5, sound: 'beep' }) });
  await page.click('#startBtn');
  await sleep(300);
  pass('主流程: 开始后进入专注中', (await phase(page)).includes('专注中'));
  pass('主流程: 暂停按钮可见', await vis(page, 'pauseBtn'));
  await warp(page, 5 * 60000 + 2000); // 快进 5 分钟
  pass('主流程: 5 分钟后专注完成', (await phase(page)).includes('专注完成'));
  pass('主流程: 轮次计 1', (await txt(page, 'statRounds')) === '1');
  pass('主流程: 分钟计 5', (await txt(page, 'statMinutes')) === '5');
  // 开始休息 → 休息结束 → 回准备
  await page.click('#restBtn'); await sleep(300);
  pass('主流程: 进入大休息', (await phase(page)).includes('大休息'));
  await warp(page, 20 * 60000 + 2000);
  pass('主流程: 休息结束', (await phase(page)).includes('休息结束'));
  await page.click('#doneBtn'); await sleep(300);
  pass('主流程: 回到准备', (await phase(page)).includes('准备开始'));
  await page.close();
}

async function tAbandon2min() {
  const page = await newPage({ rft_cfg: cfg({ focus: 90 }) });
  await page.click('#startBtn'); await sleep(300);
  await warp(page, 2 * 60000); // 2 分钟
  await page.click('#stopBtn'); await sleep(300);
  pass('放弃2分钟: 弹确认框', await shown(page, 'abandonMask'));
  pass('放弃2分钟: 文案提示不足5分钟', (await txt(page, 'abandonDesc')).includes('不足 5 分钟'));
  await page.click('#abandonOk'); await sleep(300); // 放弃
  pass('放弃2分钟: 回到准备', (await phase(page)).includes('准备开始'));
  pass('放弃2分钟: 分钟不计', (await txt(page, 'statMinutes')) === '0');
  pass('放弃2分钟: 轮次不计', (await txt(page, 'statRounds')) === '0');
  await page.close();
}

async function tAbandon7min() {
  const page = await newPage({ rft_cfg: cfg({ focus: 90 }) });
  await page.click('#startBtn'); await sleep(300);
  await warp(page, 7 * 60000); // 7 分钟
  await page.click('#stopBtn'); await sleep(300);
  pass('放弃7分钟: 弹确认框', await shown(page, 'abandonMask'));
  pass('放弃7分钟: 文案显示已7分钟', (await txt(page, 'abandonDesc')).includes('7 分钟'));
  await page.click('#abandonSave'); await sleep(300); // 结束并保存
  pass('放弃7分钟: 进完成页', (await phase(page)).includes('专注完成'));
  pass('放弃7分钟: 计1个番茄', (await txt(page, 'statRounds')) === '1');
  pass('放弃7分钟: 分钟计7', (await txt(page, 'statMinutes')) === '7');
  // 7分钟放弃-放弃分支：再来一轮满5分钟后放弃，分钟应回滚
  await page.click('#doneBtn').catch(() => {}); // focusDone 页无 doneBtn，用 skipRest
  await page.click('#skipRestBtn').catch(() => {});
  await sleep(200);
  await page.click('#startBtn'); await sleep(300);
  await warp(page, 7 * 60000);
  await page.click('#stopBtn'); await sleep(300);
  await page.click('#abandonOk'); await sleep(300);
  pass('放弃7分钟: 真放弃后分钟回滚到7', (await txt(page, 'statMinutes')) === '7');
  pass('放弃7分钟: 真放弃后轮次仍是1', (await txt(page, 'statRounds')) === '1');
  await page.close();
}

async function tContinuous() {
  const page = await newPage({ rft_cfg: cfg({ focus: 5, rest: 1, continuous: true }) });
  await page.click('#startBtn'); await sleep(300);
  await warp(page, 5 * 60000 + 2000); // 完成专注
  pass('连续模式: 完成自动进大休息', (await phase(page)).includes('大休息'));
  await warp(page, 1 * 60000 + 2000); // 休息完
  pass('连续模式: 休息完自动下一轮', (await phase(page)).includes('专注中'));
  pass('连续模式: 已计1个番茄', (await txt(page, 'statRounds')) === '1');
  // 连续模式下结束并保存：只存时间回准备，不进循环
  await warp(page, 2 * 60000);
  await page.click('#stopBtn'); await sleep(300);
  await page.click('#abandonSave'); await sleep(300);
  pass('连续模式: 结束保存后回准备', (await phase(page)).includes('准备开始'));
  await page.close();
}

async function tPreviewPostpone() {
  // focus 10 分钟、间隔固定 1 分钟：1 分钟后必响；推迟 2 分钟后剩余 7 分钟，仍满足"最后 5 分钟不排"
  const page = await newPage({ rft_cfg: cfg({ focus: 10, minInt: 1, maxInt: 1 }) });
  await page.click('#startBtn'); await sleep(300);
  await warp(page, 61 * 1000); // 过 1 分钟触发铃声
  pass('预告: 铃响后先出预告条', await shown(page, 'chimePreview'));
  pass('预告: 遮罩尚未弹出', !(await shown(page, 'miniOverlay')));
  await page.click('#postponeBtn'); await sleep(300); // 推迟 2 分钟
  pass('预告: 推迟后预告条消失', !(await shown(page, 'chimePreview')));
  await warp(page, 2 * 60000 + 1000); // 2 分钟后再响
  pass('预告: 2 分钟后再出预告', await shown(page, 'chimePreview'));
  await warp(page, 4000); // 3 秒预告期过
  pass('预告: 预告期过弹闭眼遮罩', await shown(page, 'miniOverlay'));
  pass('预告: 遮罩有引导文案', (await txt(page, 'miniTip')).length > 0);
  await warp(page, 11 * 1000); // 10 秒闭眼结束
  pass('预告: 闭眼结束回专注', (await phase(page)).includes('专注中') && !(await shown(page, 'miniOverlay')));
  pass('预告: 提示音计1次', (await txt(page, 'statChimes')) === '1');
  await page.close();
}

async function tPauseDuringPreview() {
  const page = await newPage({ rft_cfg: cfg({ focus: 6, minInt: 1, maxInt: 1 }) });
  await page.click('#startBtn'); await sleep(300);
  await warp(page, 61 * 1000);
  pass('暂停: 预告已出现', await shown(page, 'chimePreview'));
  await page.click('#pauseBtn'); await sleep(300);
  pass('暂停: 预告条在暂停时隐藏', !(await shown(page, 'chimePreview')));
  await warp(page, 60 * 1000); // 暂停中快进 1 分钟，预告不应消化
  await page.click('#pauseBtn'); await sleep(300); // 继续
  pass('暂停: 继续后预告恢复', await shown(page, 'chimePreview'));
  await warp(page, 4000);
  pass('暂停: 预告剩余期过弹遮罩', await shown(page, 'miniOverlay'));
  await page.close();
}

async function tThemeLock() {
  const page = await newPage();
  await page.click('#themeBtn'); await sleep(500); // v1.25.0 起主题在扩散过半(380ms)时切换，500ms 后断言
  const t1 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  pass('主题: 点击后切到 dark', t1 === 'dark');
  await page.click('#themeBtn'); await sleep(100); // 940ms 锁内的连点应被吞
  const t2 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  pass('主题: 扩散动画期间吞掉连点', t2 === 'dark');
  await sleep(1000); // 等待完整扩散动画（940ms 锁）结束
  await page.click('#themeBtn'); await sleep(500);
  const t3 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  pass('主题: 防抖过后可切回 light', t3 === 'light');
  await page.close();
}

async function tLogsAndGoal() {
  const page = await newPage({ rft_cfg: cfg({ focus: 5, goal: 1 }) });
  await page.click('#startBtn'); await sleep(300);
  await warp(page, 5 * 60000 + 2000);
  const logs = await page.$$eval('#logList .log-item', els => els.map(e => e.textContent));
  pass('日志: 有开始+完成两条', logs.some(l => l.includes('开始专注')) && logs.some(l => l.includes('专注完成')), logs.join(' / '));
  pass('目标: 1 轮即达成目标', (await txt(page, 'goalTxt')).includes('已达成'));
  await page.close();
}

async function tRollover() {
  // 预置"昨天"的存档，启动应清零且历史保留昨天
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yk = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
  const page = await newPage({
    rft_cfg: cfg(), rft_stats: { date: yk, minutes: 30, rounds: 2, chimes: 4 },
    rft_history: { [yk]: { minutes: 30, rounds: 2, chimes: 4 } }
  });
  pass('跨天: 今日计数清零', (await txt(page, 'statMinutes')) === '0' && (await txt(page, 'statRounds')) === '0');
  // 统计页里昨天数据还在
  await page.click('#panelBtn'); await sleep(300);
  await page.click('.seg-btn[data-page="stats"]'); await sleep(300);
  pass('跨天: 统计页昨日数据保留', (await txt(page, 'ovTotalMins')) === '0h30m');
  pass('跨天: 热力图已渲染', (await page.$$eval('#heatGrid .heat-cell', els => els.length)) === 105);
  await page.close();
}

async function tSchemaMigration() {
  const page = await newPage({
    rft_history: { '2026-08-01': { minutes: 10, rounds: 1 } } // 无 chimes 字段、无 rft_schema
  });
  await sleep(300);
  const schema = await page.evaluate(() => JSON.parse(localStorage.getItem('rft_schema')));
  const h = await page.evaluate(() => JSON.parse(localStorage.getItem('rft_history'))['2026-08-01']);
  pass('迁移: rft_schema 写入 1', schema === 1);
  pass('迁移: 旧归档补 chimes=0', h && h.chimes === 0);
  await page.close();
}

async function tFestival() {
  // 春节：横幅 + 红金主题 + 点击收起 + 当天不再弹
  let page = await newPage(null, '?festdate=2026-02-17');
  pass('节日: 春节横幅弹出', await shown(page, 'festBar'));
  pass('节日: 横幅含节日名和祝福', (await txt(page, 'festLines')).includes('春节'));
  pass('节日: 春节应用红金主题', (await page.evaluate(() => document.documentElement.getAttribute('data-fest'))) === 'spring');
  await page.click('#festBar'); await sleep(700); // 点击收起 + 等滑出动画结束
  pass('节日: 点击横幅收起', !(await shown(page, 'festBar')));
  const visAfterClick = await page.evaluate(() => getComputedStyle(document.getElementById('festBar')).visibility);
  pass('节日: 点击收起后容器彻底隐藏无残留', visAfterClick === 'hidden', visAfterClick);
  await page.close();
  // 自动收起：弹出后等 8 秒自动隐藏 + 滑出动画，容器必须无残留
  page = await newPage(null, '?festdate=2026-02-17');
  pass('节日: 自动收起前横幅在', await shown(page, 'festBar'));
  await sleep(9200); // 8s 定时 + 0.4s 滑出 + 余量
  const autoGone = await page.evaluate(() => {
    const el = document.getElementById('festBar');
    return !el.classList.contains('show') && getComputedStyle(el).visibility === 'hidden';
  });
  pass('节日: 8秒自动收起且无残留', autoGone);
  await page.close();
  // 当天已展示过（预置标记）：不再弹，但主题仍应用
  page = await newPage({ rft_fest_shown: '2026-02-17' }, '?festdate=2026-02-17');
  pass('节日: 当天已弹过则不重复弹', !(await shown(page, 'festBar')));
  pass('节日: 主题不受"已弹过"影响', (await page.evaluate(() => document.documentElement.getAttribute('data-fest'))) === 'spring');
  await page.close();
  // 中秋：暖黄主题；元旦：只弹横幅不改配色；普通日：无横幅无主题
  page = await newPage(null, '?festdate=2026-09-25');
  pass('节日: 中秋应用暖黄主题', (await page.evaluate(() => document.documentElement.getAttribute('data-fest'))) === 'midautumn');
  pass('节日: 中秋横幅含祝福', (await txt(page, 'festLines')).includes('月饼'));
  await page.close();
  page = await newPage(null, '?festdate=2026-01-01');
  pass('节日: 元旦只弹横幅', await shown(page, 'festBar'));
  pass('节日: 元旦不改配色', (await page.evaluate(() => document.documentElement.getAttribute('data-fest'))) === null);
  await page.close();
  page = await newPage(null, '?festdate=2026-08-14');
  pass('节日: 普通日无横幅无主题', !(await shown(page, 'festBar')) && (await page.evaluate(() => document.documentElement.getAttribute('data-fest'))) === null);
  const visNormal = await page.evaluate(() => getComputedStyle(document.getElementById('festBar')).visibility);
  pass('节日: 非节日场景容器彻底隐藏', visNormal === 'hidden', visNormal);
  await page.close();
}

async function tMilestones() {
  // 满一周年：历史最早日期距今 ≥365 天
  let page = await newPage({ rft_history: { '2025-08-10': { minutes: 30, rounds: 1, chimes: 0 } } }, '?festdate=2026-08-14');
  pass('里程碑: 满一周年弹横幅', (await txt(page, 'festLines')).includes('一周年'));
  const ms1 = await page.evaluate(() => JSON.parse(localStorage.getItem('rft_milestones')));
  pass('里程碑: year1 标记已写', ms1 && !!ms1.year1);
  await page.close();
  // 累计 100 小时
  page = await newPage({ rft_history: { '2026-08-01': { minutes: 6000, rounds: 60, chimes: 0 } } }, '?festdate=2026-08-14');
  pass('里程碑: 100小时弹横幅', (await txt(page, 'festLines')).includes('100 小时'));
  await page.close();
  // 合并：春节 + 满一周年 → 一条横幅两行
  page = await newPage({ rft_history: { '2025-02-17': { minutes: 30, rounds: 1, chimes: 0 } } }, '?festdate=2026-02-17');
  const lineCount = await page.$$eval('#festLines .fb-line', els => els.length);
  pass('里程碑: 节日+里程碑合并一条横幅', lineCount === 2, lineCount + ' 行');
  pass('里程碑: 合并横幅含两类内容', (await txt(page, 'festLines')).includes('春节') && (await txt(page, 'festLines')).includes('一周年'));
  await page.close();
}

async function tUpdateBar() {
  const checkLayout = async (page, n, themeName) => {
    const lis = await page.$$eval('#updateNotes li', els => els.length);
    const expectLis = Math.min(n, 3) + (n > 3 ? 1 : 0);
    pass(`更新条[${themeName}]: ${n}条更新点渲染为${expectLis}行`, lis === expectLis, lis + ' 行');
    if(n > 3){
      pass(`更新条[${themeName}]: ${n}条折叠出"等N项更新"`, (await txt(page, 'updateNotes')).includes(`等 ${n} 项更新`));
    }
    // 溢出检查：所有内容（标题/每条更新点/按钮）的矩形必须完整落在气泡矩形内，且气泡自身无滚动溢出
    const overflow = await page.evaluate(() => {
      const bar = document.getElementById('updateBar');
      const b = bar.getBoundingClientRect();
      if(bar.scrollHeight > bar.clientHeight + 1 || bar.scrollWidth > bar.clientWidth + 1) return 'bar-scroll';
      const kids = [document.getElementById('updateTitle'),
                    ...document.querySelectorAll('#updateNotes li'),
                    document.getElementById('updateNow'), document.getElementById('updateLater')];
      for(const el of kids){
        const r = el.getBoundingClientRect();
        if(r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5 || r.left < b.left - 0.5 || r.right > b.right + 0.5)
          return 'child-out:' + (el.id || el.textContent);
      }
      return null;
    });
    pass(`更新条[${themeName}]: ${n}条时无溢出`, overflow === null, overflow || '');
  };
  for(const n of [1, 2, 3, 4, 5, 6]){
    let page = await newPage(null, '?updatedemo=' + n);
    pass(`更新条[浅色]: ${n}条弹出`, await shown(page, 'updateBar'));
    await checkLayout(page, n, '浅色');
    // 浅色配色协调：气泡背景是半透明白（与白底卡片风格一致），不得是深色块
    const bg = await page.evaluate(() => getComputedStyle(document.getElementById('updateBar')).backgroundColor);
    const m = bg.match(/[\d.]+/g).map(Number);
    pass(`更新条[浅色]: ${n}条气泡为浅色底`, m[0] > 200 && m[1] > 200 && m[2] > 200, bg);
    await page.close();
    page = await newPage({ rft_cfg: cfg({ theme: 'dark' }) }, '?updatedemo=' + n);
    await checkLayout(page, n, '深色');
    await page.close();
  }
}

async function tDeco() {
  // 装饰元素：宽屏下灯笼/对联可见，元素齐全；非节日全部隐藏；不影响交互层级
  let page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.evaluateOnNewDocument(() => localStorage.clear());
  await page.setRequestInterception(true);
  page.on('request', r => { if (r.url().includes('hm.baidu.com')) r.abort(); else r.continue(); });
  const open = async q => { await page.goto(BASE + '/index.html' + q, { waitUntil: 'load' }); await sleep(500); };
  const decoVis = sel => page.$eval(sel, el => getComputedStyle(el).display !== 'none');

  await open('?festdate=2026-02-17');
  pass('装饰: 春节装饰激活', await decoVis('.deco-spring'));
  pass('装饰: 灯笼两盏且宽屏可见', (await page.$$('.lantern')).length === 2 && await decoVis('.lantern-l'));
  pass('装饰: 对联文案正确', (await page.$eval('.couplet-l', el => el.textContent)) === '专注生百福'
       && (await page.$eval('.couplet-r', el => el.textContent)) === '心静万事兴' && await decoVis('.couplet-l'));
  pass('装饰: 祥云光斑就位', await decoVis('.cloud-a'));
  pass('装饰: 其他节日装饰未激活', !(await decoVis('.deco-national')) && !(await decoVis('.deco-midautumn')));

  await open('?festdate=2026-10-01');
  pass('装饰: 国庆装饰激活', await decoVis('.deco-national'));
  pass('装饰: 五角星 4 颗含 2 颗闪烁', (await page.$$('.star')).length === 4
       && (await page.$$('.star.twinkle, .star.twinkle2')).length === 2);
  pass('装饰: 光芒射线就位', await decoVis('.deco-rays'));

  await open('?festdate=2026-09-25');
  pass('装饰: 中秋装饰激活', await decoVis('.deco-midautumn'));
  pass('装饰: 圆月+桂影+花瓣3片', await decoVis('.moon') && await decoVis('.osmanthus') && (await page.$$('.petal')).length === 3);

  await open('?festdate=2026-08-14');
  pass('装饰: 普通日装饰全隐藏', !(await decoVis('.deco-spring')) && !(await decoVis('.deco-national')) && !(await decoVis('.deco-midautumn')));
  // 装饰不遮挡交互：开始按钮可正常点击（pointer-events 不被拦截）
  await open('?festdate=2026-02-17');
  await page.click('#startBtn'); await sleep(300);
  pass('装饰: 不遮挡开始按钮交互', (await phase(page)).includes('专注中'));
  await page.close();
}

async function tFixesV120() {
  // --- 修1：撞节主题优先级（农历大节 > 公历节日），祝福合并 ---
  let page = await newPage(null, '?festforce=' + encodeURIComponent('中秋,国庆'));
  pass('撞节: 中秋压制国庆主题', (await page.evaluate(() => document.documentElement.getAttribute('data-fest'))) === 'midautumn');
  const colLines = await txt(page, 'festLines');
  pass('撞节: 两条祝福合并一条横幅', colLines.includes('中秋') && colLines.includes('国庆')
       && (await page.$$eval('#festLines .fb-line', els => els.length)) === 2);
  await page.close();
  page = await newPage(null, '?festforce=' + encodeURIComponent('端午,元旦'));
  pass('撞节: 无 theme 节日不改配色', (await page.evaluate(() => document.documentElement.getAttribute('data-fest'))) === null
       && (await page.$$eval('#festLines .fb-line', els => els.length)) === 2);
  await page.close();
  page = await newPage(null, '?festforce=' + encodeURIComponent('国庆'));
  pass('撞节: 公历大节单独命中正常应用主题', (await page.evaluate(() => document.documentElement.getAttribute('data-fest'))) === 'national');
  await page.close();

  // --- 修2：关于区覆盖年份 + 控制台无过期误报 ---
  page = await browser.newPage();
  const warns = [];
  page.on('console', m => { if(m.type() === 'warning' || m.type() === 'warn') warns.push(m.text()); });
  await page.evaluateOnNewDocument(() => localStorage.clear());
  await page.setRequestInterception(true);
  page.on('request', r => { if (r.url().includes('hm.baidu.com')) r.abort(); else r.continue(); });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' }); await sleep(500);
  pass('过期提醒: 关于区显示覆盖年份', (await txt(page, 'lunarCover')) === '农历节日数据覆盖至 2030 年', await txt(page, 'lunarCover'));
  pass('过期提醒: 控制台无过期误报', !warns.some(w => w.includes('农历节日数据已过期')), warns.join(' / ') || '无告警');
  await page.close();

  // --- 修3：早期里程碑（预置 history 触发 + 专注中途触发） ---
  page = await newPage({ rft_history: { '2026-08-01': { minutes: 650, rounds: 6, chimes: 0 } } }, '?festdate=2026-08-14');
  pass('里程碑: 满10小时弹横幅', (await txt(page, 'festLines')).includes('10 小时'));
  let ms = await page.evaluate(() => JSON.parse(localStorage.getItem('rft_milestones')));
  pass('里程碑: hours10 标记、hours50 未标记', !!ms.hours10 && !ms.hours50);
  await page.close();
  page = await newPage({ rft_history: { '2026-08-01': { minutes: 3200, rounds: 30, chimes: 0 } } }, '?festdate=2026-08-14');
  const mLines = await txt(page, 'festLines');
  pass('里程碑: 3200分钟只庆祝最高档(50小时)', mLines.includes('50 小时') && !mLines.includes('10 小时'));
  ms = await page.evaluate(() => JSON.parse(localStorage.getItem('rft_milestones')));
  pass('里程碑: 低档 hours10 一并标记', !!ms.hours10 && !!ms.hours50 && !ms.hours100);
  await page.close();
  page = await newPage({ rft_history: { '2026-08-01': { minutes: 100, rounds: 50, chimes: 0 } } }, '?festdate=2026-08-14');
  pass('里程碑: 满50个番茄弹横幅', (await txt(page, 'festLines')).includes('50 个番茄'));
  await page.close();
  // 中途触发：595 分钟存量 + 专注 5 分钟冲账 → 满 600（10 小时）
  page = await newPage({ rft_cfg: cfg({ focus: 90 }), rft_history: { '2026-08-10': { minutes: 596, rounds: 6, chimes: 0 } } }, '?festdate=2026-08-14');
  pass('里程碑: 启动时未达10小时不弹', !(await shown(page, 'festBar')));
  await page.click('#startBtn'); await sleep(300);
  await warp(page, 4.5 * 60000); // 冲账 4 分钟 → 累计 600
  pass('里程碑: 专注中途达成10小时即时庆祝', await shown(page, 'festBar') && (await txt(page, 'festLines')).includes('10 小时'));
  await page.close();
  // 中途触发：49 个番茄存量 + 完成一轮 → 50
  page = await newPage({ rft_cfg: cfg({ focus: 5 }), rft_history: { '2026-08-10': { minutes: 300, rounds: 49, chimes: 0 } } }, '?festdate=2026-08-14');
  await page.click('#startBtn'); await sleep(300);
  await warp(page, 5 * 60000 + 2000);
  pass('里程碑: 完成第50个番茄即时庆祝', await shown(page, 'festBar') && (await txt(page, 'festLines')).includes('50 个番茄'));
  await page.close();

  // --- 修4：festBar 避让 updateBar ---
  page = await newPage(null, '?updatedemo=3&festdate=2026-02-17');
  pass('避让: 两条同时弹出', await shown(page, 'updateBar') && await shown(page, 'festBar'));
  pass('避让: festBar 带 lower 下移', await page.$eval('#festBar', el => el.classList.contains('lower')));
  const gap = await page.evaluate(() => {
    const u = document.getElementById('updateBar').getBoundingClientRect();
    const f = document.getElementById('festBar').getBoundingClientRect();
    return f.top - u.bottom;
  });
  pass('避让: 两条不重叠', gap >= -1, '间距 ' + gap.toFixed(1) + 'px');
  await page.click('#updateLater'); await sleep(300);
  pass('避让: 更新条关掉后 festBar 回到原位', !(await page.$eval('#festBar', el => el.classList.contains('lower'))));
  await page.close();
}

async function tAchievement() {
  // 里程碑完整链路：音效触发（无头静音，验证无异常）→ sticky 横幅 → 红点 → 成就页 → 红点消除 → 成就墙数据
  const page = await newPage({ rft_history: { '2026-08-01': { minutes: 650, rounds: 6, chimes: 0 } } }, '?festdate=2026-08-14');
  pass('成就: 满10小时弹横幅', (await txt(page, 'festLines')).includes('10 小时'));
  await sleep(9200); // 节日横幅 8 秒会收起，里程碑横幅不应消失
  pass('成就: 里程碑横幅不自动收起', await shown(page, 'festBar'));
  pass('成就: 齿轮出现红点', await page.$eval('#unreadBadge', el => el.classList.contains('show')));
  await page.click('#festBar'); await sleep(400); // 先手动关闭 sticky 横幅（窄视口下它会盖住面板 seg 区，真实用户亦然）
  await page.click('#panelBtn'); await sleep(300);
  await page.click('.seg-btn[data-page="achv"]'); await sleep(300);
  pass('成就: 成就标签页打开', await page.$eval('#pageAchv', el => el.classList.contains('active')));
  pass('成就: 进成就页后红点消除', !(await page.$eval('#unreadBadge', el => el.classList.contains('show'))));
  const items = await page.$$eval('.achv-item', els => els.map(e => ({cls: e.className, text: e.textContent})));
  const hours10 = items.find(i => i.text.includes('初露锋芒'));
  pass('成就: 10小时显示已达成带日期', !!hours10 && hours10.cls.includes('done') && hours10.text.includes('2026-08-14'), hours10 && hours10.text);
  const hours50 = items.find(i => i.text.includes('渐入佳境'));
  pass('成就: 50小时灰色锁定', !!hours50 && hours50.cls.includes('locked') && hours50.text.includes('🔒'));
  pass('成就: 50小时进度正确(650分钟→10/50)', !!hours50 && hours50.text.includes('10/50 小时'), hours50 && hours50.text);
  const year1 = items.find(i => i.text.includes('周年相伴'));
  pass('成就: 周年进度正确(已陪伴13/365天)', !!year1 && year1.text.includes('已陪伴 13/365 天'), year1 && year1.text);
  const rounds = items.find(i => i.text.includes('番茄猎手'));
  pass('成就: 番茄进度正确(6/50)', !!rounds && rounds.text.includes('6/50 个'), rounds && rounds.text);
  await page.close();
  const page2 = await newPage();
  pass('成就: 无成就时无红点', !(await page2.$eval('#unreadBadge', el => el.classList.contains('show'))));
  await page2.close();
}

async function tLayout() {
  // 桌面布局（v1.25.0）：右上药丸 / 面板在药丸正下方右对齐成组 / 装饰位置校对
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() => localStorage.clear());
  await page.setRequestInterception(true);
  page.on('request', r => { if (r.url().includes('hm.baidu.com')) r.abort(); else r.continue(); });
  await page.goto(BASE + '/index.html?festdate=2026-02-17', { waitUntil: 'load' }); await sleep(500);
  const rect = sel => page.$eval(sel, el => { const r = el.getBoundingClientRect(); return {l:r.left, r:r.right, t:r.top, b:r.bottom, w:r.width}; });
  const bar = await rect('.topbar');
  pass('布局: 顶部条为紧凑药丸(宽<430)', bar.w < 430, '宽 ' + Math.round(bar.w) + 'px');
  pass('布局: 药丸右上对齐(右缘≈1344)', Math.abs(bar.r - 1344) < 10, '右缘 ' + Math.round(bar.r) + 'px');
  // 灯笼与药丸：右灯笼在药丸右侧不重叠，左灯笼在药丸左侧不重叠
  const ll = await rect('.lantern-l'), lr = await rect('.lantern-r');
  pass('布局: 右灯笼不压药丸', lr.l >= bar.r - 1, '灯笼左缘 ' + Math.round(lr.l) + ' / 药丸右缘 ' + Math.round(bar.r));
  pass('布局: 左灯笼不压药丸', ll.r <= bar.l + 1, '灯笼右缘 ' + Math.round(ll.r) + ' / 药丸左缘 ' + Math.round(bar.l));
  // 面板展开：与药丸右缘对齐成组、在药丸正下方、不遮挡计时圆环
  await page.click('#panelBtn'); await sleep(400);
  const panel = await rect('#panel');
  pass('布局: 面板与药丸右缘对齐成组', Math.abs(panel.r - bar.r) < 5, '面板右缘 ' + Math.round(panel.r) + ' / 药丸右缘 ' + Math.round(bar.r));
  pass('布局: 面板在药丸正下方', panel.t >= bar.b - 1, '面板顶 ' + Math.round(panel.t) + ' / 药丸底 ' + Math.round(bar.b));
  const ring = await rect('#ringWrap');
  const hit = (a, b) => !(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t);
  pass('布局: 面板不遮挡计时圆环', !hit(panel, ring));
  // 国庆：星星与面板无重叠（1440 + 1280 双视口复核 s4）
  for(const vw of [1440, 1280]){
    await page.setViewport({ width: vw, height: 900 });
    await page.goto(BASE + '/index.html?festdate=2026-10-01', { waitUntil: 'load' }); await sleep(500);
    await page.click('#panelBtn'); await sleep(400);
    const pNat = await rect('#panel');
    let starHit = false;
    for(const s of ['.star.s1', '.star.s2', '.star.s3', '.star.s4']){
      if(hit(await rect(s), pNat)) starHit = s;
    }
    pass(`布局: 星星与面板无重叠(${vw}px)`, starHit === false, starHit || '');
  }
  await page.setViewport({ width: 1440, height: 900 });
  // 中秋：月亮与面板无重叠
  await page.goto(BASE + '/index.html?festdate=2026-09-25', { waitUntil: 'load' }); await sleep(500);
  await page.click('#panelBtn'); await sleep(400);
  pass('布局: 月亮与面板无重叠', !hit(await rect('.moon'), await rect('#panel')));
  await page.goto(BASE + '/index.html?updatedemo=2&festdate=2026-02-17', { waitUntil: 'load' }); await sleep(600);
  const ub = await rect('#updateBar'), fb = await rect('#festBar');
  const bar2 = await rect('.topbar');
  pass('布局: updateBar 与药丸不重叠', !hit(ub, bar2));
  pass('布局: festBar 避让 updateBar', fb.t >= ub.b - 1, 'festBar 顶 ' + Math.round(fb.t) + ' / updateBar 底 ' + Math.round(ub.b));
  await page.close();
}

async function tThemeRipple() {
  // 主题扩散过渡层（v1.25.0）：双向扩散/连点锁定/reduced-motion 无残留/节日变体/刷新持久化
  const rippleState = page => page.evaluate(() => {
    const r = document.getElementById('themeRipple');
    return { grow: r.classList.contains('grow'), fade: r.classList.contains('fade'),
             opacity: getComputedStyle(r).opacity, bg: r.style.background,
             bdf: getComputedStyle(r).backdropFilter };
  });
  const theme = page => page.evaluate(() => document.documentElement.getAttribute('data-theme'));

  // Light → Dark：扩散用深色，动画结束后复位（浏览器把内联背景序列化为 rgb()，断言用 rgb 形式）
  let page = await newPage();
  await page.click('#themeBtn'); await sleep(200);
  let st = await rippleState(page);
  pass('扩散[L→D]: 扩散中(grow+深色)', st.grow && st.bg.includes('rgb(10, 10, 13)'), st.bg.slice(0, 60));
  await sleep(1000);
  st = await rippleState(page);
  pass('扩散[L→D]: 结束后主题正确且圆层复位', (await theme(page)) === 'dark' && !st.grow && !st.fade && st.opacity === '0');
  pass('扩散: 圆层无 backdrop-filter', st.bdf === 'none' || st.bdf === '');
  // 持久化：主题在点击瞬间已落盘（本测试框架每次导航都会清 localStorage，无法 reload 验证，改为断言落盘值）
  pass('扩散[L→D]: 主题已落盘 dark', (await page.evaluate(() => JSON.parse(localStorage.getItem('rft_cfg')).theme)) === 'dark');

  // Dark → Light：扩散用浅色，与 L→D 同一逻辑
  await page.click('#themeBtn'); await sleep(200);
  st = await rippleState(page);
  pass('扩散[D→L]: 扩散中(grow+浅色)', st.grow && st.bg.includes('rgb(244, 244, 247)'), st.bg.slice(0, 60));
  await sleep(1000);
  pass('扩散[D→L]: 结束后主题正确且圆层复位', (await theme(page)) === 'light'
       && !((await rippleState(page)).grow));

  // 快速连点：只翻转一次，无卡死
  await page.click('#themeBtn'); await page.click('#themeBtn'); await page.click('#themeBtn');
  await sleep(1200);
  pass('扩散: 快速连点3次只翻转一次', (await theme(page)) === 'dark');

  // 节日主题：扩散用节日底色，data-fest 不受破坏（导航后默认即 light，无需预置）
  await page.goto(BASE + '/index.html?festdate=2026-02-17', { waitUntil: 'load' }); await sleep(400);
  await page.click('#themeBtn'); await sleep(200);
  st = await rippleState(page);
  pass('扩散[春节]: 用节日深色底色', st.grow && st.bg.includes('rgb(56, 4, 11)'), st.bg.slice(0, 60));
  await sleep(1000);
  pass('扩散[春节]: data-fest 保持 spring', (await page.evaluate(() => document.documentElement.getAttribute('data-fest'))) === 'spring'
       && (await theme(page)) === 'dark');
  await page.close();

  // reduced-motion：无扩散层，主题正确切换，无残留
  page = await newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.click('#themeBtn'); await sleep(200);
  st = await rippleState(page);
  pass('扩散[RM]: reduced-motion 不起扩散层', !st.grow);
  await sleep(500);
  pass('扩散[RM]: 主题正确切换且无残留', (await theme(page)) === 'dark' && !((await rippleState(page)).grow));
  await page.close();
}

async function tElectronShim() {
  // Electron 环境模拟（独立浏览器上下文，隔离其他套件注册的 SW）：
  // SW 跳过 / 检查更新隐藏 / 自启开关显示可用 / 完成事件发原生通知
  const ctx = await browser.createBrowserContext();
  let page = await newPage(null, '', true, ctx);
  await sleep(1500); // 等 SW 注册窗口期（Electron 下应跳过）
  pass('Electron: SW 静默跳过注册', (await page.evaluate(async()=>!!(await navigator.serviceWorker.getRegistration()))) === false);
  pass('Electron: 自启开关显示', await page.$eval('#autoLaunchRow', el => el.style.display !== 'none'));
  await page.click('#panelBtn'); await sleep(300); // 开关在设置面板内，先开面板（真实用户路径）
  await page.click('#cfgAutoLaunch'); await sleep(250);
  pass('Electron: 自启开关切换生效', await page.evaluate(() => window.__autoLaunch === true));
  // --- 客户端检查更新（electron-updater 接管 about 行，v1.25.0） ---
  pass('Electron: 状态行显示当前版本', (await txt(page, 'checkUpdateStatus')).includes('1.25.0-test'), await txt(page, 'checkUpdateStatus'));
  await page.click('#checkUpdate'); await sleep(250);
  pass('Electron: 点击检查更新调 IPC', await page.evaluate(() => window.__updChecks === 1));
  await page.evaluate(() => window.__updCb({ state: 'available', version: '9.9.9-test' })); await sleep(150);
  pass('Electron: 发现新版本按钮变「下载更新」', (await txt(page, 'checkUpdate')) === '下载更新'
       && (await txt(page, 'checkUpdateStatus')).includes('发现新版本 v9.9.9-test'));
  await page.click('#checkUpdate'); await sleep(200);
  pass('Electron: 点击触发后台下载', await page.evaluate(() => window.__updDownloads === 1));
  await page.evaluate(() => window.__updCb({ state: 'ready', version: '1.26.0' })); await sleep(150);
  pass('Electron: 更新就绪按钮变「重启升级」', (await txt(page, 'checkUpdate')) === '重启升级');
  await page.click('#checkUpdate'); await sleep(150);
  pass('Electron: 点击触发重启安装', await page.evaluate(() => window.__updInstalls === 1));
  await page.evaluate(() => window.__updCb({ state: 'error' })); await sleep(100);
  pass('Electron: 更新失败静默降级', (await txt(page, 'checkUpdateStatus')).includes('不影响使用'));
  await page.close();
  page = await newPage({ rft_cfg: cfg({ focus: 5, rest: 1 }) }, '', true, ctx);
  await page.click('#startBtn'); await sleep(300);
  await warp(page, 5 * 60000 + 2000);
  pass('Electron: 专注完成发原生通知', await page.evaluate(() => window.__notified.includes('focus')));
  await page.click('#restBtn'); await sleep(300);
  await warp(page, 60000 + 2000);
  pass('Electron: 休息结束发原生通知', await page.evaluate(() => window.__notified.includes('rest')));
  await page.close();
  await ctx.close();
}

async function tFrameless() {
  // 无边框窗口（v1.26.2）：网页版无侵入；客户端桩验证按钮/拖动区/no-drag/图标切换
  let page = await newPage();
  pass('无边框: 网页版不显示窗口按钮', await page.$eval('#wcBar', el => getComputedStyle(el).display === 'none'));
  pass('无边框: 网页版无拖动区', await page.$eval('#dragStrip', el => getComputedStyle(el).display === 'none'));
  pass('无边框: 网页版无 is-electron 类', await page.evaluate(() => !document.body.classList.contains('is-electron')));
  await page.close();
  const ctx = await browser.createBrowserContext();
  page = await newPage(null, '', true, ctx);
  pass('无边框: 客户端显示窗口按钮', await page.$eval('#wcBar', el => getComputedStyle(el).display === 'flex'));
  // 类名冲突守卫（wc-* 前缀已被统计页柱状图占用，win-ctrl-* 是正确类名）
  pass('无边框: 按钮为 30px 灰圆钮(无类名串扰)', await page.$eval('#wcMin', el => {
    const cs = getComputedStyle(el);
    return cs.width === '30px' && cs.backgroundColor === 'rgba(118, 118, 128, 0.1)';
  }));
  pass('无边框: 拖动区 drag 生效', await page.$eval('#dragStrip', el => getComputedStyle(el).webkitAppRegion === 'drag'));
  pass('无边框: 药丸/双横幅 no-drag', await page.evaluate(() => {
    const g = s => getComputedStyle(document.querySelector(s)).webkitAppRegion;
    return g('.topbar') === 'no-drag' && g('.fest-bar') === 'no-drag' && g('.update-bar') === 'no-drag';
  }));
  pass('无边框: 灯笼装饰不阻断拖动', await page.evaluate(() =>
    getComputedStyle(document.querySelector('.deco-spring .lantern')).pointerEvents === 'none'));
  await page.click('#wcMin'); await sleep(150);
  pass('无边框: 最小化按钮接线', await page.evaluate(() => window.__winMin === 1));
  await page.click('#wcMax'); await sleep(150);
  pass('无边框: 最大化按钮接线', await page.evaluate(() => window.__winMax === 1));
  await page.evaluate(() => window.__maxCb(true)); await sleep(100);
  pass('无边框: 最大化后图标切还原', await page.$eval('#wcMax', el => el.classList.contains('is-max')));
  // 图标可见性断言（v1.26.2 修内联 display:none 压过 CSS 的 bug）
  pass('无边框: 最大化态显示还原图标', await page.evaluate(() => {
    const d = s => getComputedStyle(document.querySelector(s)).display;
    return d('.wc-ic-max') === 'none' && d('.wc-ic-restore') !== 'none';
  }));
  await page.evaluate(() => window.__maxCb(false)); await sleep(100);
  pass('无边框: 还原后图标切回', await page.$eval('#wcMax', el => !el.classList.contains('is-max')));
  pass('无边框: 默认态显示最大化图标', await page.evaluate(() => {
    const d = s => getComputedStyle(document.querySelector(s)).display;
    return d('.wc-ic-max') !== 'none' && d('.wc-ic-restore') === 'none';
  }));
  await page.click('#wcClose'); await sleep(150);
  pass('无边框: 关闭按钮接线(关窗=托盘)', await page.evaluate(() => window.__winClose === 1));
  // 双击拖动区切换最大化：合成双击在测试环境不稳定，直接派发 dblclick 事件验证处理器接线
  await page.evaluate(() => document.getElementById('dragStrip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await sleep(150);
  pass('无边框: 双击拖动区切换最大化', await page.evaluate(() => window.__winMax === 2));
  await page.close();
  await ctx.close();
}

async function tChimeLeftFix() {
  // v1.26.2 修复验证（云 QA 发现的 P1）：暂停恢复后 chimeLeft 残留 → 加时后提示音提前响
  // 场景：focus=6、间隔固定1分钟。暂停→恢复（chimeLeft 被消费应清零）→ 响铃进 mini → mini 结束（剩余<5分钟尾段不再排铃）
  // → +5 分钟 → 若 chimeLeft 残留会被防御行错误重建为 ~30 秒后响（bug）；正确是按调度 ~60 秒后响
  const page = await newPage({ rft_cfg: cfg({ focus: 6, minInt: 1, maxInt: 1 }) });
  await page.click('#startBtn'); await sleep(300);
  await warp(page, 30 * 1000);          // 跑 30 秒
  await page.click('#pauseBtn'); await sleep(300);   // 暂停（chimeLeft=剩余30s快照）
  await page.click('#pauseBtn'); await sleep(300);   // 恢复（chimeAt 重建，chimeLeft 应清零）
  await warp(page, 31 * 1000);          // 过 60s 铃点
  pass('chimeLeft: 响铃出预告条', await shown(page, 'chimePreview'));
  await warp(page, 4000);               // 预告期过 → mini
  pass('chimeLeft: 进入闭眼遮罩', await shown(page, 'miniOverlay'));
  // 顺带核实 P3-2：mini 期间 ±5 按钮不可见不可点（QA 报"可见但无效"，实际应为不可见）
  pass('chimeLeft: mini 期间±5按钮不可见(P3-2核实)', await page.$eval('#minusBtn', el =>
    getComputedStyle(el).pointerEvents === 'none' && getComputedStyle(el).opacity === '0'));
  await warp(page, 11 * 1000);          // mini 结束回 focus（剩余<5分钟尾段，chimeAt=null）
  await page.click('#plusBtn'); await sleep(300);    // +5 分钟
  await warp(page, 35 * 1000);          // bug 情形下 ~30 秒就会响
  pass('chimeLeft: 修复后加时 35 秒内不误响', !(await shown(page, 'chimePreview')));
  await warp(page, 30 * 1000);          // 到 ~65 秒（正确调度 60s 已过）
  pass('chimeLeft: 按正常调度响铃', await shown(page, 'chimePreview'));
  await page.close();
}

async function tSwAndMisc() {
  const page = await newPage();
  await sleep(1500); // 等 SW 注册
  const swOk = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
  pass('PWA: Service Worker 注册成功', swOk);
  pass('备份: 导出/导入按钮存在', !!(await page.$('#exportData')) && !!(await page.$('#importData')));
  const version = await page.evaluate(() => document.body.innerHTML.includes('v1.25.0'));
  pass('版本: 关于区 v1.25.0', version);
  // version.json 可实时拉取（更新提示条的数据源），且不走 SW 缓存
  const vinfo = await page.evaluate(async () => {
    const r = await fetch('./version.json?t=' + Date.now(), {cache:'no-store'});
    return r.ok ? await r.json() : null;
  });
  pass('版本: version.json 拉取成功且含版本号+说明', !!(vinfo && vinfo.version && Array.isArray(vinfo.notes) && vinfo.notes.length),
       vinfo ? vinfo.version + ' / ' + vinfo.notes.length + ' 条' : 'null');
  const vinfoCached = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if(!reg || !reg.active) return 'no-sw';
    const cache = await caches.open('focus-timer-v41');
    return !!(await cache.match('./version.json')) ? 'cached' : 'not-cached';
  });
  pass('版本: version.json 未被 SW 预缓存', vinfoCached === 'not-cached', vinfoCached);
  await page.close();
}

(async () => {
  // 自起静态服务器（后台任务生命周期不可靠，随测随起）
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: 'pipe' });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('serving')) resolve(); });
    server.on('exit', () => reject(new Error('server exited early')));
    setTimeout(() => reject(new Error('server start timeout')), 8000);
  });
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=500,950']
  });
  const suites = [tMainFlow, tAbandon2min, tAbandon7min, tContinuous, tPreviewPostpone,
                  tPauseDuringPreview, tThemeLock, tLogsAndGoal, tRollover, tSchemaMigration,
                  tFestival, tMilestones, tUpdateBar, tDeco, tFixesV120, tAchievement, tLayout,
                  tThemeRipple, tElectronShim, tFrameless, tChimeLeftFix, tSwAndMisc];
  for (const fn of suites) {
    try { await fn(); }
    catch (e) { pass(fn.name + ' 套件异常', false, e.message); }
  }
  await browser.close();
  server.kill();
  const failed = results.filter(r => !r.ok);
  console.log('\n===== ' + (results.length - failed.length) + '/' + results.length + ' 通过 =====');
  process.exit(failed.length ? 1 : 0);
})();
