// 截图脚本：node shots.js before|after
// before → 线上 https://zhiyue-zeta.vercel.app（修改前现状）；after → 本地 :8931（修改后）
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MODE = process.argv[2] || 'after';
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SHOTS = MODE === 'before'
  ? [ ['spring-light', 'https://zhiyue-zeta.vercel.app/?festdate=2026-02-17', null],
      ['spring-dark',  'https://zhiyue-zeta.vercel.app/?festdate=2026-02-17', 'dark'] ]
  : MODE === 'deco'
  ? [ ['spring-wide', 'http://127.0.0.1:8931/index.html?festdate=2026-02-17', null],
      ['national-wide','http://127.0.0.1:8931/index.html?festdate=2026-10-01', null],
      ['midautumn-wide','http://127.0.0.1:8931/index.html?festdate=2026-09-25', null] ]
  : MODE === 'layout'
  ? [ ['closed', 'http://127.0.0.1:8931/index.html?festdate=2026-02-17', null, false],
      ['open',   'http://127.0.0.1:8931/index.html?festdate=2026-02-17', null, true] ]
  : MODE === 'ripple'
  ? [ ['mid-l2d',   'http://127.0.0.1:8931/index.html', null, 'ripple-mid'],
      ['final-l2d', 'http://127.0.0.1:8931/index.html', null, 'ripple-final'],
      ['mid-d2l',   'http://127.0.0.1:8931/index.html', 'dark', 'ripple-mid'],
      ['final-d2l', 'http://127.0.0.1:8931/index.html', 'dark', 'ripple-final'] ]
  : [ ['spring-light', 'http://127.0.0.1:8931/index.html?festdate=2026-02-17', null],
      ['spring-dark',  'http://127.0.0.1:8931/index.html?festdate=2026-02-17', 'dark'],
      ['national-light','http://127.0.0.1:8931/index.html?festdate=2026-10-01', null],
      ['midautumn-light','http://127.0.0.1:8931/index.html?festdate=2026-09-25', null] ];
const VW = (MODE === 'deco' || MODE === 'layout') ? 1440 : 480, VH = (MODE === 'deco' || MODE === 'layout') ? 900 : 860;

(async () => {
  let server;
  if (MODE !== 'before') {
    server = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: 'pipe' });
    await new Promise(res => server.stdout.on('data', d => { if (String(d).includes('serving')) res(); }));
  }
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--force-device-scale-factor=1']
  });
  for (const [name, url, theme, openPanel] of SHOTS) {
    const page = await browser.newPage();
    await page.setViewport({ width: VW, height: VH });
    await page.evaluateOnNewDocument(t => {
      localStorage.clear();
      localStorage.setItem('rft_fest_shown', JSON.stringify('2099-01-01')); // 不弹横幅，看纯主题
      if (t) localStorage.setItem('rft_cfg', JSON.stringify({ theme: t }));
    }, theme);
    await page.setRequestInterception(true);
    page.on('request', r => { if (r.url().includes('hm.baidu.com')) r.abort(); else r.continue(); });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 }).catch(e => console.log(name, 'goto warn:', e.message));
    await sleep(1200);
    if (openPanel === true) { await page.click('#panelBtn'); await sleep(500); }
    if (openPanel === 'ripple-mid') { await page.click('#themeBtn'); await sleep(320); }
    if (openPanel === 'ripple-final') { await page.click('#themeBtn'); await sleep(1100); }
    const file = path.join(OUT, `${MODE}-${name}.png`);
    await page.screenshot({ path: file });
    console.log('saved', file);
    await page.close();
  }
  await browser.close();
  if (server) server.kill();
})();
