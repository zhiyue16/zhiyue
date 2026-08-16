(function(){
"use strict";
const $ = id => document.getElementById(id);
const clampNum = (v,a,b) => Math.min(b, Math.max(a, v));
const pad = n => String(n).padStart(2,'0');
const LS = { get(k,d){ try{ const v=JSON.parse(localStorage.getItem(k)); return v==null?d:v; }catch(e){ return d; } },
             set(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} } };
// 请求持久化存储：降低浏览器在磁盘压力下清除用户累计专注记录的概率
if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{});
/* [优化4] HTML 转义工具：renderLogs 用 innerHTML 拼接日志文本，
   虽然当前文本均由程序生成，但日志内容含数字/用户可改的配置，转义可杜绝潜在 XSS */
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/* [优化5] 高频渲染元素缓存：render() 每 250ms 执行一次，原先每次都调用近 20 次 getElementById，
   缓存后避免重复 DOM 查询，降低主线程开销（视觉与功能完全不变） */
const dom = {};
['phaseLabel','phaseText','ringWrap','ringFg','timeText','timeRange','timeSub',
 'miniOverlay','miniCount','chimePreview','startBtn','pauseBtn','stopBtn','restBtn',
 'skipRestBtn','doneBtn','statMinutes','statRounds','statChimes'].forEach(id => dom[id] = $(id));
/* ================= 设置（含边界校验） ================= */
const cfg = Object.assign({focus:90, minInt:3, maxInt:5, rest:20, sound:'bell', theme:'light', volume:100, goal:4, continuous:false, pomo:false}, LS.get('rft_cfg',{}));
if(cfg.goal==null) cfg.goal = 4; // 兼容旧存档
if(cfg.continuous==null) cfg.continuous = false; // 兼容旧存档
if(cfg.pomo==null) cfg.pomo = false; // 兼容旧存档
function readSettings(){
  let warn = '';
  // num(v, min, max, dflt)：解析失败(空/非数字)用默认值，否则按边界钳制（0 会被钳到下限而非误判为空）
  const num = (v,min,max,dflt)=>{ const n = parseInt(v,10); return Number.isNaN(n) ? dflt : clampNum(n,min,max); };
  let focus = num($('cfgFocus').value, 5, 180, 90);
  let minI  = num($('cfgMinInt').value, 1, 30, 3);
  let maxI  = num($('cfgMaxInt').value, 1, 30, 5);
  let rest  = num($('cfgRest').value, 1, 120, 20);
  if (minI > maxI){ maxI = minI; warn = '提示音间隔下限不能大于上限，已自动调整'; }
  $('cfgFocus').value = focus; $('cfgMinInt').value = minI;
  $('cfgMaxInt').value = maxI;  $('cfgRest').value  = rest;
  $('warnText').textContent = warn;
  Object.assign(cfg, {focus, minInt:minI, maxInt:maxI, rest});
  LS.set('rft_cfg', cfg);
}
['cfgFocus','cfgMinInt','cfgMaxInt','cfgRest'].forEach(id=>{
  $(id).value = cfg[{cfgFocus:'focus',cfgMinInt:'minInt',cfgMaxInt:'maxInt',cfgRest:'rest'}[id]];
  $(id).addEventListener('change', ()=>{ readSettings(); if(mode==='idle') render(); });
});
/* 开关：连续专注 / 番茄钟模式（v1.28.3）。focus/mini 阶段锁定由 renderSwitchLocks 加 .locked 类实现 */
[['cfgContinuous','continuous'], ['cfgPomo','pomo']].forEach(([id, key])=>{
  const sw = $(id);
  function renderSwitch(){ sw.classList.toggle('on', !!cfg[key]); sw.setAttribute('aria-checked', String(!!cfg[key])); }
  sw.addEventListener('click', ()=>{ cfg[key] = !cfg[key]; LS.set('rft_cfg', cfg); renderSwitch(); });
  renderSwitch();
});
function renderSwitchLocks(){ // 专注/闭眼阶段禁切（替代中途切换逻辑），回到其他状态自动恢复
  const lock = mode==='focus' || mode==='mini';
  $('cfgContinuous').classList.toggle('locked', lock);
  $('cfgPomo').classList.toggle('locked', lock);
}
/* ================= 主题 ================= */
function applyTheme(){
  document.documentElement.setAttribute('data-theme', cfg.theme);
  // [优化6] 同步 <meta name="theme-color">：深色模式下移动端浏览器状态栏由蓝色变为深色，与页面融为一体
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if(metaTheme) metaTheme.setAttribute('content', cfg.theme==='dark' ? '#0a0a0d' : '#007aff');
}
// 主题切换：SVG 图标随 data-theme 自动做"太阳⇄月亮"形变，
// 整页颜色由 :root / [data-theme] 上的 transition 平滑过渡，无需 JS 动画帧。
// 按钮给个轻旋反馈即可；连点安全（切换是幂等的，CSS 过渡自动衔接）。
/* 主题扩散过渡层（v1.23.0）：以主题按钮为圆心扩散软边圆层，扩散过半时在圆层遮盖下切 data-theme，
   再淡出圆层——"夜色从按钮蔓延到整页"，而非瞬间变黑。Light/Dark 两方向走同一函数仅颜色不同。
   颜色表含节日变体：data-fest 激活时用节日底色，普通日用 light/dark 底色的纯色核 */
const RIPPLE_BG = { light:'#f4f4f7', dark:'#0a0a0d',
  spring:{light:'#b01e2c', dark:'#38040b'}, national:{light:'#ce1526', dark:'#420710'},
  midautumn:{light:'#3a4a7d', dark:'#0d1330'} };
function rippleStart(nextTheme){
  const r = $('themeRipple'), btn = $('themeBtn').getBoundingClientRect();
  const cx = btn.left + btn.width/2, cy = btn.top + btn.height/2;
  const dist = Math.ceil(Math.max( // 圆心到四个角的最远距离，决定覆盖整屏所需缩放
    Math.hypot(cx, cy), Math.hypot(innerWidth-cx, cy),
    Math.hypot(cx, innerHeight-cy), Math.hypot(innerWidth-cx, innerHeight-cy)));
  const fest = document.documentElement.getAttribute('data-fest');
  const color = (fest && RIPPLE_BG[fest]) ? RIPPLE_BG[fest][nextTheme] : RIPPLE_BG[nextTheme];
  r.style.left = (cx-50) + 'px'; r.style.top = (cy-50) + 'px';
  r.style.background = `radial-gradient(circle, ${color} 60%, transparent 78%)`;
  r.style.setProperty('--ripple-scale', (dist*2/100 + 2).toFixed(1));
  void r.offsetWidth; // 强制 reflow，确保从 scale(0) 起播
  r.classList.add('grow');
}
function rippleFade(){ $('themeRipple').classList.add('fade'); }
function rippleReset(){ const r = $('themeRipple'); r.classList.remove('grow','fade'); r.style.opacity = 0; }
let themeBusy = false;
$('themeBtn').addEventListener('click', ()=>{
  if(themeBusy) return; // 动画期间忽略连点，杜绝"半路反向"造成的卡滞感
  themeBusy = true;
  const next = cfg.theme==='dark' ? 'light' : 'dark';
  cfg.theme = next; LS.set('rft_cfg', cfg); // 状态立即落盘：动画中途刷新主题也正确
  if(matchMedia('(prefers-reduced-motion: reduce)').matches){ // 减少动效：无扩散层，走原路径
    applyTheme(); applyFest();
    setTimeout(()=>{ themeBusy = false; }, 460); return;
  }
  rippleStart(next);                                   // 扩散圆层从按钮中心起播
  setTimeout(()=>{ applyTheme(); applyFest(); }, 380); // 扩散过半时在圆层遮盖下切换主题（节日色由 applyFest 重刷）
  setTimeout(rippleFade, 660);                         // 全屏覆盖后淡出
  setTimeout(()=>{ rippleReset(); themeBusy = false; }, 940); // 复位并解锁（防连点时长覆盖完整动画）
});
applyTheme();
/* ================= 二级面板（设置 / 记录） ================= */
function openPanel(){ $('panel').classList.add('show'); $('scrim').classList.add('show'); $('panelBtn').classList.add('active','spin'); }
function closePanel(){ $('panel').classList.remove('show'); $('scrim').classList.remove('show'); $('panelBtn').classList.remove('active','spin'); }
/* 齿轮小菜单（v1.27.0）：点击齿轮先弹菜单（设置与统计 / Mini 模式仅客户端），点外/Esc 关闭 */
function openGearMenu(){
  const r = $('panelBtn').getBoundingClientRect();
  const m = $('gearMenu');
  m.style.top = (r.bottom + 8) + 'px';
  m.style.left = (r.right - m.offsetWidth) + 'px'; // 右缘对齐齿轮
  m.classList.add('show');
  $('panelBtn').classList.add('active','spin');
}
function closeGearMenu(){
  $('gearMenu').classList.remove('show');
  if(!$('panel').classList.contains('show')) $('panelBtn').classList.remove('active','spin');
}
$('panelBtn').addEventListener('click', e=>{ e.stopPropagation();
  $('gearMenu').classList.contains('show') ? closeGearMenu() : openGearMenu(); });
$('gmPanel').addEventListener('click', ()=>{ closeGearMenu(); openPanel(); });
$('gmMini').addEventListener('click', ()=>{ closeGearMenu(); if(isElectron) window.electronAPI.miniOpen(); }); // isElectron 在文件后段定义，点击时已是运行时，安全
document.addEventListener('click', e=>{ if($('gearMenu').classList.contains('show') && !$('gearMenu').contains(e.target) && e.target.id!=='panelBtn') closeGearMenu(); });
$('scrim').addEventListener('click', closePanel);
const PAGE_IDS = {settings:'pageSettings', stats:'pageStats', logs:'pageLogs', achv:'pageAchv'};
document.querySelectorAll('.seg-btn').forEach(b=>{
  b.addEventListener('click', ()=>{
    document.querySelectorAll('.seg-btn').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.panel-page').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    const pid = PAGE_IDS[b.dataset.page] || 'pageSettings';
    $(pid).classList.add('active');
    if(pid==='pageStats') renderStats(); // 切到统计页时即时刷新
    if(pid==='pageAchv'){ renderAchv(); markAchvSeen(); } // 进成就页：刷新成就墙并消除红点
  });
});
/* ================= Web Audio 合成提示音 ================= */
let actx = null, masterGain = null;
function ac(){
  if(!actx) actx = new (window.AudioContext||window.webkitAudioContext)();
  if(actx.state==='suspended') actx.resume();
  return actx;
}
function master(){ // 主音量总线：所有提示音统一经过它输出
  const a = ac();
  if(!masterGain){
    masterGain = a.createGain();
    masterGain.gain.value = (cfg.volume==null?100:cfg.volume)/100;
    masterGain.connect(a.destination);
  }
  return masterGain;
}
const synth = {
  bell(t){ // 铃声：E6 小三度泛音结构，清晰穿透（经典闹铃/计时铃）
    const a = ac(), f = 1318.5; // E6
    [[1,.6],[1.19,.25],[1.5,.12],[2.01,.07]].forEach(([m,g])=>{
      const o=a.createOscillator(), gn=a.createGain();
      o.type='sine'; o.frequency.value=f*m;
      gn.gain.setValueAtTime(0.0001,t);
      gn.gain.linearRampToValueAtTime(.5*g, t+.006);
      gn.gain.exponentialRampToValueAtTime(.0001, t+2.2);
      o.connect(gn); gn.connect(master());
      o.start(t); o.stop(t+2.3);
    });
  },
  ding(t){ // 叮：A6 唱钵/风铃式纯净长音（正念/番茄钟提示音）
    const a = ac(), f = 1760; // A6
    [[1,.55],[2.76,.1],[5.4,.04]].forEach(([m,g])=>{
      const o=a.createOscillator(), gn=a.createGain();
      o.type='sine'; o.frequency.value=f*m;
      gn.gain.setValueAtTime(0.0001,t);
      gn.gain.linearRampToValueAtTime(.5*g, t+.004);
      gn.gain.exponentialRampToValueAtTime(.0001, t+3.2);
      o.connect(gn); gn.connect(master());
      o.start(t); o.stop(t+3.3);
    });
  },
  chime(t){ // 报时：sol-do 上行纯五度双音（系统提醒/番茄钟结束常用）
    const a = ac();
    [[783.99,0],[1046.5,.2]].forEach(([f,dt])=>{ // G5 -> C6
      const o=a.createOscillator(), g=a.createGain();
      o.type='sine'; o.frequency.value=f;
      g.gain.setValueAtTime(0.0001,t+dt);
      g.gain.linearRampToValueAtTime(.55,t+dt+.01);
      g.gain.exponentialRampToValueAtTime(.0001,t+dt+1.1);
      o.connect(g); g.connect(master()); o.start(t+dt); o.stop(t+dt+1.2);
    });
  },
  wood(t){ // 木鱼：E5 音头快速下坠 + 木质噪声敲击（更脆更实）
    const a = ac();
    const o=a.createOscillator(), g=a.createGain();
    o.type='sine';
    o.frequency.setValueAtTime(659,t); // E5
    o.frequency.exponentialRampToValueAtTime(440,t+.05); // 快速下坠到 A4
    g.gain.setValueAtTime(1,t);
    g.gain.exponentialRampToValueAtTime(.0001,t+.12);
    o.connect(g); g.connect(master()); o.start(t); o.stop(t+.14);
    const len=a.sampleRate*.025, buf=a.createBuffer(1,len,a.sampleRate), d=buf.getChannelData(0);
    for(let i=0;i<len;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/len,3);
    const n=a.createBufferSource(); n.buffer=buf;
    const ng=a.createGain(); ng.gain.setValueAtTime(.4,t); ng.gain.exponentialRampToValueAtTime(.0001,t+.025);
    const bp=a.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=2000; bp.Q.value=1.2;
    n.connect(bp); bp.connect(ng); ng.connect(master()); n.start(t);
  },
  xylo(t){ // 木琴：C6 木质敲击 + 高泛音（厨房/运动计时器常用）
    const a = ac(), f = 1046.5; // C6
    [[1,.75],[4.2,.22],[10.6,.06]].forEach(([m,g])=>{
      const o=a.createOscillator(), gn=a.createGain();
      o.type='sine'; o.frequency.value=f*m;
      gn.gain.setValueAtTime(0.0001,t);
      gn.gain.linearRampToValueAtTime(.55*g, t+.003);
      gn.gain.exponentialRampToValueAtTime(.0001, t+.45);
      o.connect(gn); gn.connect(master());
      o.start(t); o.stop(t+.5);
    });
  },
  beep(t){ // 电子音：A5 双连正弦哔哔，柔和不刺耳（微波炉/电子表提醒）
    const a = ac();
    [[880,0],[880,.25]].forEach(([f,dt])=>{ // A5 两声
      const o=a.createOscillator(), g=a.createGain();
      o.type='sine'; o.frequency.value=f;
      g.gain.setValueAtTime(0.0001,t+dt);
      g.gain.exponentialRampToValueAtTime(.3,t+dt+.01);
      g.gain.setValueAtTime(.3,t+dt+.12);
      g.gain.exponentialRampToValueAtTime(.0001,t+dt+.16);
      o.connect(g); g.connect(master()); o.start(t+dt); o.stop(t+dt+.2);
    });
  }
};
const SOUND_GAP = {bell:1.6, wood:.4, beep:.55, ding:2, chime:1.4, xylo:.6};
function playChime(times){
  try{
    const a = ac(), t0 = a.currentTime + .03;
    for(let i=0;i<times;i++) synth[cfg.sound](t0 + i*SOUND_GAP[cfg.sound]);
  }catch(e){ console.warn('音频播放失败', e); }
}
// 番茄钟结束专用：三声逐级升调的清脆"叮-叮-叮"（类似滴答清单番茄钟）
function playFinish(){
  try{
    const a = ac(), t0 = a.currentTime + .03;
    [1318.5, 1568, 2093].forEach((f, i)=>{ // E6 -> G6 -> C7 逐级上扬
      const t = t0 + i * .38;
      const o = a.createOscillator(), g = a.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(.5, t+.008);
      g.gain.exponentialRampToValueAtTime(.0001, t+.55);
      o.connect(g); g.connect(master());
      o.start(t); o.stop(t+.6);
    });
  }catch(e){ console.warn('音频播放失败', e); }
}
// 每日目标达成专属：明亮欢快的上行琶音 + 尾音高八度点睛（区别于结束铃的三升调）
function playGoalDone(){  try{
    const a = ac(), t0 = a.currentTime + .03;
    // C5-E5-G5-C6 快速琶音，再叠一个 E6 长音收尾，庆祝感更强
    const seq = [[523.25,0],[659.25,.1],[783.99,.2],[1046.5,.3],[1318.5,.46]];
    seq.forEach(([f,dt],i)=>{
      const t = t0 + dt;
      const o = a.createOscillator(), g = a.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const last = i===seq.length-1;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(last?.45:.4, t+.008);
      g.gain.exponentialRampToValueAtTime(.0001, t + (last?1.4:.5));
      o.connect(g); g.connect(master());
      o.start(t); o.stop(t + (last?1.5:.55));
    });
  }catch(e){ console.warn('音频播放失败', e); }
}
// 里程碑达成专属（v1.21.0）：小号式上行四音 + 终止式长音和弦，比目标琶音更隆重
function playMilestone(){
  try{
    const a = ac(), t0 = a.currentTime + .03;
    [[392,0],[523.25,.12],[659.25,.24],[783.99,.36]].forEach(([f,dt])=>{ // G4→C5→E5→G5 上行
      const t = t0+dt, o=a.createOscillator(), g=a.createGain();
      o.type='sine'; o.frequency.value=f;
      g.gain.setValueAtTime(0.0001,t); g.gain.linearRampToValueAtTime(.4,t+.01);
      g.gain.exponentialRampToValueAtTime(.0001,t+.5);
      o.connect(g); g.connect(master()); o.start(t); o.stop(t+.55);
    });
    [1046.5,1318.5,1568].forEach(f=>{ // C6+E6+G6 终止式长音和弦
      const t = t0+.56, o=a.createOscillator(), g=a.createGain();
      o.type='sine'; o.frequency.value=f;
      g.gain.setValueAtTime(0.0001,t); g.gain.linearRampToValueAtTime(.32,t+.015);
      g.gain.exponentialRampToValueAtTime(.0001,t+1.7);
      o.connect(g); g.connect(master()); o.start(t); o.stop(t+1.8);
    });
  }catch(e){ console.warn('音频播放失败', e); }
}
document.querySelectorAll('.sound-chip').forEach(chip=>{
  chip.addEventListener('click', ()=>{
    const wasActive = chip.classList.contains('active');
    document.querySelectorAll('.sound-chip').forEach(c=>c.classList.remove('active'));
    chip.classList.add('active');
    cfg.sound = chip.dataset.sound;
    LS.set('rft_cfg', cfg);
    playChime(wasActive ? 2 : 1); // 已选中的再点一次：连播两遍，更清楚区分"重听"与"切换"
  });
  // [优化8] 音色 chip 为 div[role=button]，补充键盘可达性：Enter/Space 触发选择
  chip.addEventListener('keydown', ev=>{
    if(ev.key==='Enter' || ev.key===' '){ ev.preventDefault(); chip.click(); }
  });
  if(chip.dataset.sound===cfg.sound){
    document.querySelectorAll('.sound-chip').forEach(c=>c.classList.remove('active'));
    chip.classList.add('active');
  }
});
/* ================= 音量 ================= */
let lastVol = 100; // 静音前的音量，用于取消静音时恢复
function applyVolume(){
  const v = clampNum(cfg.volume==null?100:cfg.volume, 0, 100);
  cfg.volume = v;
  $('cfgVol').value = v;
  $('cfgVol').style.setProperty('--fill', v+'%');
  $('volVal').textContent = v+'%';
  $('volMute').textContent = v===0 ? '🔇' : (v<50 ? '🔉' : '🔊');
  if(masterGain) masterGain.gain.value = v/100;
}
$('cfgVol').addEventListener('input', ()=>{
  cfg.volume = parseInt($('cfgVol').value, 10) || 0;
  applyVolume();
  LS.set('rft_cfg', cfg);
});
$('cfgVol').addEventListener('change', ()=>{
  if(cfg.volume>0) playChime(1); // 松手试听当前音量
});
// [优化8] 静音图标为 span[role=button]，支持键盘操作
$('volMute').addEventListener('click', ()=>{
  if(cfg.volume > 0){ lastVol = cfg.volume; cfg.volume = 0; }
  else cfg.volume = lastVol > 0 ? lastVol : 100;
  applyVolume();
  LS.set('rft_cfg', cfg);
});
$('volMute').addEventListener('keydown', ev=>{
  if(ev.key==='Enter' || ev.key===' '){ ev.preventDefault(); $('volMute').click(); }
});
applyVolume();
/* ================= 统计 & 日志（localStorage） ================= */
// [优化9] 用本地时区手动拼 YYYY-MM-DD，替代 toLocaleDateString('sv')：
// 后者依赖运行环境内置 sv 语言包，极少数精简环境会回退到其他格式导致跨天判断失效
const todayKey = () => {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
};
/* localStorage 结构版本（v1.15.0 引入）：以后变更数据结构时按 v<2、v<3… 追加阶梯迁移，
   老用户存档逐级升级，不会因结构演进而损坏 */
const SCHEMA_VERSION = 1;
(function migrateSchema(){
  const v = LS.get('rft_schema', 0);
  if(v >= SCHEMA_VERSION) return;
  if(v < 1){ // v0→v1：早期历史归档没有 chimes 字段，补 0
    const h = LS.get('rft_history', {});
    let dirty = false;
    for(const k in h){ if(h[k] && h[k].chimes==null){ h[k].chimes = 0; dirty = true; } }
    if(dirty) LS.set('rft_history', h);
  }
  LS.set('rft_schema', SCHEMA_VERSION);
})();
let stats = LS.get('rft_stats', null);
if(!stats || stats.date !== todayKey()) stats = {date: todayKey(), minutes:0, rounds:0, chimes:0};
if(stats.chimes==null) stats.chimes = 0; // 兼容 v1.5 及更早的存档
/* 历史归档：每天一条 {minutes, rounds, chimes}，供统计页算总番茄/总时长/趋势。
   当天数据在每次 saveStats 时同步写入，跨天时旧数据天然留存，不会随 stats 清零而丢失 */
let history = LS.get('rft_history', {});
function syncHistory(){ history[stats.date] = {minutes:stats.minutes, rounds:stats.rounds, chimes:stats.chimes}; LS.set('rft_history', history); }
/* 历史裁剪：只保留最近 730 天（2 年），更早的归档删除。
   无此裁剪，rft_history 会随使用天数无限增长；730 条对趋势/统计已绰绰有余 */
const HISTORY_KEEP_DAYS = 730;
function pruneHistory(){
  const keys = Object.keys(history).sort(); // YYYY-MM-DD 字典序即时间序
  if(keys.length <= HISTORY_KEEP_DAYS) return;
  const cut = keys.length - HISTORY_KEEP_DAYS;
  for(let i=0; i<cut; i++) delete history[keys[i]];
  LS.set('rft_history', history);
}
pruneHistory(); // 启动时裁剪一次
let logs = LS.get('rft_logs', []);
/* 跨天自动归档：页面挂机跨过零点时，把旧日期的累计留在旧日期名下、今日计数清零重新开始。
   原实现是 saveStats 直接把 stats.date 改成新日期，导致昨天已累计的分钟/轮次被算进今天 */
function checkDayRollover(){
  const tk = todayKey();
  if(stats.date === tk) return;
  const hadActivity = stats.minutes>0 || stats.rounds>0 || stats.chimes>0;
  syncHistory(); // stats.date 仍是旧日期：先把旧数据归档到旧日期名下
  stats = {date: tk, minutes:0, rounds:0, chimes:0};
  // 进行中的本轮：跨天前已冲账的分钟已随旧日期归档，基线归零，此后只向新的一天累计
  roundBaseMins = 0;
  LS.set('rft_stats', stats);
  if(hadActivity) addLog('info', '已跨天：昨日数据归入统计，今日重新开始');
  applyFest();         // 新的一天可能是节日：刷新限定配色
  checkCelebrations(); // 并检查新一天的节日横幅
}
function saveStats(){
  checkDayRollover();
  LS.set('rft_stats', stats); syncHistory();
  if($('pageStats').classList.contains('active')) renderStats();
}
saveStats(); // 启动即落盘+归档：既保证今日键存在，也把"跨天清零"后的 stats 写回（否则旧日期存档残留，下次启动重复清零）
function addLog(type, text){
  const t = new Date();
  // [优化10] 每条日志带上日期，供 renderLogs 过滤“今日”记录
  logs.unshift({date: todayKey(), time: pad(t.getHours())+':'+pad(t.getMinutes())+':'+pad(t.getSeconds()), type, text});
  if(logs.length>100) logs.length = 100;
  LS.set('rft_logs', logs);
  renderLogs();
}
function renderLogs(){
  const el = $('logList');
  // [优化10] 只展示今天的日志（原实现把历史所有日志都显示在“今日记录”下，属逻辑缺陷）；
  // 同时对文本做 HTML 转义，杜绝 innerHTML 注入风险
  const today = todayKey();
  const todays = logs.filter(l => (l.date || '') === today);
  if(!todays.length){ el.innerHTML = '<div class="log-empty">暂无记录，开始一轮专注吧</div>'; return; }
  el.innerHTML = todays.map(l =>
    `<div class="log-item log-${escHtml(l.type)}"><span class="log-dot"></span><span class="log-time">${escHtml(l.time)}</span><span>${escHtml(l.text)}</span></div>`
  ).join('');
}
/* ================= 统计页渲染 ================= */
const fmtHM = m => Math.floor(m/60) + 'h' + (m%60) + 'm';
const dateKeyOf = d => d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
function renderStats(){
  const today = todayKey();
  const t = history[today] || {minutes:0, rounds:0, chimes:0};
  const y = new Date(); y.setDate(y.getDate()-1);
  const yd = history[dateKeyOf(y)] || {minutes:0, rounds:0, chimes:0};
  // 全部累计
  let totM=0, totR=0, totC=0, days=0, bestM=0, bestK='';
  for(const k in history){
    const h = history[k];
    totM += h.minutes; totR += h.rounds; totC += (h.chimes||0);
    if(h.minutes>0 || h.rounds>0) days++;
    if(h.minutes > bestM){ bestM = h.minutes; bestK = k; }
  }
  // 概览四宫格
  $('ovTodayRounds').textContent = t.rounds;
  $('ovTotalRounds').textContent = totR;
  $('ovTodayMins').textContent = fmtHM(t.minutes);
  $('ovTotalMins').textContent = fmtHM(totM);
  // 与前一天的对比（番茄数 / 时长）
  const delta = (cur, prev, unit, fmtV) => {
    const el = $(unit==='r' ? 'ovTodayRoundsDelta' : 'ovTodayMinsDelta');
    const d = cur - prev;
    if(d===0){ el.textContent = '与前一天持平'; el.className = 'sc-delta'; }
    else if(d>0){ el.textContent = `比前一天多 ${fmtV(d)}`; el.className = 'sc-delta up'; }
    else{ el.textContent = `比前一天少 ${fmtV(-d)}`; el.className = 'sc-delta down'; }
  };
  delta(t.rounds, yd.rounds, 'r', v=>v+' 个');
  delta(t.minutes, yd.minutes, 'm', v=>fmtHM(v));
  // 近 7 天柱状图
  const week = [];
  for(let i=6; i>=0; i--){
    const d = new Date(); d.setDate(d.getDate()-i);
    const k = dateKeyOf(d);
    week.push({k, m:(history[k]||{minutes:0}).minutes,
      label: i===0 ? '今天' : (d.getMonth()+1)+'/'+d.getDate(),
      today: i===0});
  }
  const maxM = Math.max(1, ...week.map(w=>w.m));
  $('weekChart').innerHTML = week.map(w=>
    `<div class="wc-col${w.today?' today':''}"><div class="wc-val">${w.m||''}</div>`+
    `<div class="wc-barwrap"><div class="wc-bar" style="height:${Math.max(3, Math.round(w.m/maxM*100))}%"></div></div>`+
    `<div class="wc-day">${escHtml(w.label)}</div></div>`
  ).join('');
  // 近 15 周热力图（v1.15.0，GitHub 风格：颜色越深专注越久；阈值 30/60/120 分钟分档）
  const HEAT_DAYS = 15*7, heatCells = [];
  for(let i=HEAT_DAYS-1; i>=0; i--){
    const d = new Date(); d.setDate(d.getDate()-i);
    const k = dateKeyOf(d);
    const m = (history[k]||{minutes:0}).minutes;
    const lv = m<=0 ? 0 : m<30 ? 1 : m<60 ? 2 : m<120 ? 3 : 4;
    heatCells.push(`<div class="heat-cell${lv?' h'+lv:''}" title="${k} · ${m} 分钟"></div>`);
  }
  $('heatGrid').innerHTML = heatCells.join('');
  // 更多数据
  let streak = 0;
  for(let i=0; ; i++){
    const d = new Date(); d.setDate(d.getDate()-i);
    const h = history[dateKeyOf(d)];
    if(h && (h.minutes>0 || h.rounds>0)) streak++;
    else { if(i===0) continue; break; } // 今天还没专注不算断签
  }
  $('srDays').textContent = days + ' 天';
  $('srStreak').textContent = streak + ' 天';
  $('srAvg').textContent = totR>0 ? Math.round(totM/totR) + ' 分钟' : '—';
  if(bestK){
    const bd = bestK.slice(5).replace('-','/'); // MM-DD -> MM/DD
    $('srBest').textContent = `${bd} · ${fmtHM(bestM)}`;
  }else $('srBest').textContent = '—';
  $('srChimes').textContent = `${totC} 次 / ${totC*10} 秒`;
}
/* ================= 计时状态机（基于时间戳，防后台漂移） ================= */
// idle -> focus <-> mini -> focusDone -> rest -> restDone -> idle
let mode = 'idle';
let paused = false;
let endAt = 0, leftMs = 0, totalMs = 0, startAt = 0; // 当前阶段（focus / rest）
let miniEndAt = 0, miniLeft = 0;                      // 10 秒闭眼休息
let previewEndAt = 0, previewLeft = 0;                // 提示音预告（铃响后 3 秒再弹遮罩）
let chimeAt = null, chimeLeft = null;                 // 下一次随机提示音
let sessionChimes = 0;
let sumMs = 0, sumChimes = 0;                          // 本轮小结快照（专注完成时生成）
let focusAccMs = 0, lastTick = Date.now();            // 专注分钟累计
let roundBaseMins = 0;                                // 本轮开始时 stats.minutes 基线（用于算本轮已专注）
const MINI_MS = 10000, NO_CHIME_TAIL = 5*60000;
const PREVIEW_MS = 3000,        // 铃响后先预告 3 秒再弹闭眼遮罩
      POSTPONE_MS = 2*60000;    // 预告期可推迟 2 分钟
const ABANDON_CONFIRM_MS = 30000,   // 超过30秒提前结束需弹确认
      RECORD_MIN_MS = 5*60000;      // 仅用于弹窗文案区分（提示是否满5分钟）
// 本轮到目前为止已实际专注的毫秒数（= 已 flush 进 stats 的分钟 + focusAccMs 零头）
function elapsedFocusMs(){
  const now = Date.now();
  let acc = (stats.minutes - roundBaseMins)*60000 + focusAccMs;
  if(!paused && (mode==='focus'||mode==='mini')) acc += now - lastTick;
  return acc;
}
function scheduleChime(now, remainingMs){
  if(cfg.pomo){ chimeAt = null; return; } // 番茄钟模式（v1.28.3）：专注全程不排铃；mini 唯一入口是 chimeAt→预告→startMini，不排铃即全程不打扰
  const lo = cfg.minInt*60, hi = cfg.maxInt*60;
  const randSec = lo + Math.floor(Math.random()*(hi-lo+1)); // 秒级随机
  if (remainingMs - randSec*1000 >= NO_CHIME_TAIL){ chimeAt = now + randSec*1000; }
  else chimeAt = null; // 最后 5 分钟内不再安排
}
function flushFocusMinutes(){
  let did = false;
  while(focusAccMs >= 60000){ focusAccMs -= 60000; stats.minutes++; saveStats(); did = true; }
  if(did) checkCelebrations(); // 分钟进账后检查"累计 100 小时"里程碑是否达成
}
function startFocus(){
  readSettings();
  ac(); // 借用户手势激活 AudioContext
  const now = Date.now();
  mode='focus'; paused=false;
  totalMs = cfg.focus*60000; endAt = now + totalMs; startAt = now;
  sessionChimes = 0; focusAccMs = 0; roundBaseMins = stats.minutes;
  previewEndAt = 0; previewLeft = 0; // 清掉上一轮可能残留的预告状态
  scheduleChime(now, totalMs);
  setInputsEnabled(false);
  addLog('focus', `开始专注 ${cfg.focus} 分钟`);
  render();
}
// 闭眼遮罩里随机展示的引导文案（Safe Eyes / Stretchly 式微休息引导）
const MINI_TIPS = ['闭上眼，深呼吸三次','转动眼球，上下左右各看一圈','远眺 6 米外，放松睫状肌','放松肩膀，缓慢转动颈部','闭目养神，什么都不用想','轻轻按揉太阳穴'];
function startMini(now){
  mode='mini'; miniEndAt = now + MINI_MS; chimeAt = null;
  sessionChimes++;
  stats.chimes++; saveStats(); // 累计提示音同步进统计
  $('miniTip').textContent = MINI_TIPS[Math.floor(Math.random()*MINI_TIPS.length)];
  addLog('chime', `第 ${sessionChimes} 次提示音响起，闭眼休息 10 秒`);
}
function endMini(now){
  const left = endAt - now; // endAt 未冻结，10 秒已计入专注时间
  mode='focus';
  playChime(1);
  addLog('chime', '休息结束，继续专注');
  if(left <= 0){ focusComplete(); return; }
  scheduleChime(now, left);
}
// 轮次+1，并在"刚好达成今日目标"的瞬间播放专属庆祝音效
function bumpRound(){
  const goal = Math.max(1, cfg.goal||4);
  const was = stats.rounds;
  stats.rounds++; saveStats();
  if(was < goal && stats.rounds >= goal) playGoalDone(); // 恰好跨过目标线才响，避免每次完成都重复
  checkCelebrations(); // 轮次进账后即时检查"累计 50 个番茄"等里程碑（v1.20.0）
}
function focusComplete(){
  flushFocusMinutes();
  bumpRound();
  previewEndAt = 0; previewLeft = 0; // 防止预告残留到完成页
  sumMs = totalMs; sumChimes = sessionChimes; // 生成本轮小结快照
  playFinish(); // 番茄钟式三声升调结束铃
  nativeNotify('focus'); // Electron 客户端同时发系统通知（浏览器为空操作）
  addLog('focus', `专注完成 ${fmt(sumMs)}，提示音 ${sumChimes} 次，闭眼休息 ${sumChimes*10} 秒`);
  if(cfg.continuous){ // 连续模式：响铃后直接进大休息，不停留完成页
    celebrate();
    startRest();
    return;
  }
  mode='focusDone'; paused=false; chimeAt=null;
  celebrate();
  render();
}
function celebrate(){ // 完成瞬间圆环弹跳一下（重播需先移除再触发 reflow）
  const w = dom.ringWrap; // [优化5] 使用缓存元素
  w.classList.remove('celebrate'); void w.offsetWidth; w.classList.add('celebrate');
}
function startRest(){
  const now = Date.now();
  mode='rest'; paused=false;
  totalMs = cfg.rest*60000; endAt = now + totalMs; startAt = now;
  chimeAt = null; chimeLeft = null; // 清掉可能残留的提示音计划（连续模式下沿用上一轮 endAt 的 chimeAt 已无意义）
  addLog('rest', `开始大休息 ${cfg.rest} 分钟`);
  render();
}
function restComplete(){
  playFinish(); // 番茄钟式三声升调结束铃
  nativeNotify('rest'); // Electron 客户端同时发系统通知（浏览器为空操作）
  if(cfg.continuous){ // 连续模式：休息完直接开下一轮，一直循环直到手动结束
    addLog('rest', '大休息结束，自动开始下一轮');
    startFocus();
    return;
  }
  mode='restDone'; paused=false;
  addLog('rest', '大休息结束');
  render();
}
function toIdle(msg){
  flushFocusMinutes(); focusAccMs = 0;
  mode='idle'; paused=false; chimeAt=null; chimeLeft=null;
  setInputsEnabled(true);
  if(msg) addLog('info', msg);
  render();
}
/* ================= 提前结束本轮（结束按钮 / −减到0 共用） ================= */
// 结算并回到准备页。countRound：true=按完成处理计轮次（结束并保存）；false=放弃，永不计轮次
function settleAbandon(countRound){
  const elapsed = elapsedFocusMs();
  const mins = Math.floor(elapsed/60000);
  if(countRound && cfg.continuous){
    // 连续模式下的"结束并保存"：只把已专注时间存下来，直接回准备页（不计番茄、不进循环）
    const totalMins = Math.max(1, mins);
    const flushed = stats.minutes - roundBaseMins;
    const add = Math.max(0, totalMins - flushed);
    if(add > 0){ stats.minutes += add; saveStats(); }
    focusAccMs = 0;
    addLog('focus', `结束并保存本轮 ${fmt(elapsed)}，已退出连续专注`);
    toIdle();
    return;
  }
  if(countRound){
    // 结束并保存：分钟据实计 + 计 1 个番茄轮次，并给完成反馈（铃+小结+庆祝）
    const totalMins = Math.max(1, mins);                  // 至少记 1 分钟
    const flushed = stats.minutes - roundBaseMins;        // 已实时 flush 的分钟
    const add = Math.max(0, totalMins - flushed);         // 只补零头
    stats.minutes += add; bumpRound();
    focusAccMs = 0;
    sumMs = elapsed; sumChimes = sessionChimes;           // 复用完成页小结
    playFinish(); celebrate();
    addLog('focus', `提前结束并保存 ${fmt(elapsed)}，计 1 个番茄，提示音 ${sumChimes} 次`);
    mode = 'focusDone'; paused = false; chimeAt = null;
    setInputsEnabled(true);
    render();
  }else{
    // 放弃：无论是否满5分钟，本轮一律不保存——回退已 flush 的分钟，分钟/轮次都不计
    const flushed = stats.minutes - roundBaseMins;
    if(flushed > 0){ stats.minutes -= flushed; saveStats(); }
    focusAccMs = 0;
    addLog('info', `放弃本轮，已专注 ${mins} 分钟，未保存`);
    toIdle();
  }
}
// 请求提前结束：>30秒弹三选一确认框，否则按"放弃"直接清除
// 弹窗期间冻结计时：把剩余时间存入 leftMs 并置 paused，避免 tick 在弹窗开着时触发 focusComplete 导致轮次重复计
let abandonWasPaused = false; // 弹窗前是否本就暂停（取消时恢复原状态）
function requestAbandon(){
  if(mode!=='focus' && mode!=='mini') return;
  const elapsed = elapsedFocusMs();
  if(elapsed > ABANDON_CONFIRM_MS){
    const mins = Math.floor(elapsed/60000);
    if(cfg.continuous){
      $('abandonDesc').textContent = '正在连续专注中。「结束并保存」会把本次时间存下并停止循环；「放弃」将不保存任何记录。';
      $('abandonSave').textContent = '结束并保存';
    }else{
      $('abandonDesc').textContent = elapsed >= RECORD_MIN_MS
        ? `本次专注已 ${mins} 分钟。「结束并保存」计 1 个番茄；「放弃」将不保存任何记录。`
        : '本次专注不足 5 分钟。「结束并保存」计 1 个番茄；「放弃」将不保存任何记录。';
      $('abandonSave').textContent = '结束并保存';
    }
    // 冻结计时（若未在暂停态）：保存当前剩余，置 paused
    abandonWasPaused = paused;
    if(!paused){
      const now = Date.now();
      focusAccMs += now - lastTick; flushFocusMinutes(); lastTick = now; // 冻结前先把零头冲账，放弃结算不少算（v1.26.2）
      leftMs = endAt - now; // mode 只会是 focus/mini（rest 已在函数开头拦截）
      if(mode==='mini') miniLeft = miniEndAt - now;
      chimeLeft = chimeAt ? chimeAt - now : null;
      previewEndAt = 0; previewLeft = 0; // 预告在放弃弹窗打开时作废（3 秒窗口的边缘场景，取消后不重播）
      paused = true; render();
    }
    $('abandonMask').classList.add('show');
  }else{
    settleAbandon(false);
  }
}
// 取消/关闭：若刚才是被弹窗冻结的，恢复计时
function closeAbandon(){
  $('abandonMask').classList.remove('show');
  if(paused && !abandonWasPaused && (mode==='focus'||mode==='mini')){
    const now = Date.now();
    endAt = now + leftMs;
    if(mode==='mini') miniEndAt = now + miniLeft;
    chimeAt = chimeLeft!=null ? now + chimeLeft : null;
    chimeLeft = null; // 快照消费后清零：否则 adjust(+5) 的防御重建会用残留旧值让提示音提前响（v1.26.2 修）
    paused = false; lastTick = now; render();
  }
}
$('abandonSave').addEventListener('click', ()=>{ $('abandonMask').classList.remove('show'); settleAbandon(true); });
$('abandonOk').addEventListener('click', ()=>{ $('abandonMask').classList.remove('show'); settleAbandon(false); });
$('abandonCancel').addEventListener('click', closeAbandon);
$('abandonX').addEventListener('click', closeAbandon);
$('abandonMask').addEventListener('click', e=>{ if(e.target===e.currentTarget) closeAbandon(); });
function togglePause(){
  if(!['focus','mini','rest'].includes(mode)) return;
  const now = Date.now();
  if(!paused){
    paused = true;
    if(mode==='focus'){ leftMs = endAt - now; chimeLeft = chimeAt ? chimeAt - now : null; previewLeft = previewEndAt ? previewEndAt - now : 0; previewEndAt = 0; }
    if(mode==='mini'){ miniLeft = miniEndAt - now; leftMs = endAt - now; }
    if(mode==='rest'){ leftMs = endAt - now; }
    addLog('info', '已暂停');
  }else{
    paused = false;
    if(mode==='focus'){ endAt = now + leftMs; chimeAt = chimeLeft!=null ? now + chimeLeft : null; chimeLeft = null; previewEndAt = previewLeft ? now + previewLeft : 0; previewLeft = 0; }
    if(mode==='mini'){ miniEndAt = now + miniLeft; endAt = now + leftMs; }
    if(mode==='rest'){ endAt = now + leftMs; }
    addLog('info', '继续');
    lastTick = now;
  }
  render();
}
function adjust(deltaMin){ // 运行中 ±5 分钟
  if(mode!=='focus' && mode!=='rest') return;
  const d = deltaMin*60000, now = Date.now();
  const curLeft = paused ? leftMs : endAt - now;
  if(deltaMin > 0 && curLeft + d > 180*60000) return; // 剩余时长不得超过 180 分钟上限，超出则忽略
  const newLeft = Math.max(0, curLeft + d);
  if(paused) leftMs = newLeft; else endAt = now + newLeft;
  totalMs = Math.max(60000, totalMs + d);
  const left = newLeft;
  if(left <= 0){
    // 减完视为放弃本轮：不计轮次、不响铃、直接回初始页。
    // 走统一放弃流程（按已专注时长决定弹窗与统计），绝不倒扣 stats.minutes。
    if(mode==='focus'){
      requestAbandon();
    }else{ // rest 减到 0：直接结束休息，无需确认/统计
      toIdle('休息时间已减完');
    }
    return;
  }
  if(mode==='focus'){
    const cLeft = paused ? chimeLeft : (chimeAt ? chimeAt - now : null);
    if(cLeft!=null && left - cLeft < NO_CHIME_TAIL){ chimeAt = chimeLeft = null; } // 落入最后 5 分钟则取消
    if(chimeAt==null && chimeLeft==null && deltaMin>0) scheduleChime(now, left); // 加时间后尝试重新安排
    if(paused && chimeLeft==null && chimeAt!=null) chimeLeft = chimeAt - now; // 保持暂停态快照一致
    if(!paused && chimeAt==null && chimeLeft!=null) chimeAt = now + chimeLeft;
  }
  addLog('info', `时间${deltaMin>0?'增加':'减少'} 5 分钟`);
  render();
}
/* 本周专注分钟（近 7 天含今天，供 Mini 浮窗"本周专注"展示） */
function weekFocusMins(){
  let s = 0;
  for(let i=0; i<7; i++){
    const d = new Date(); d.setDate(d.getDate()-i);
    const h = history[dateKeyOf(d)];
    if(h) s += h.minutes || 0;
  }
  return s;
}
/* ================= 主循环 ================= */
function tick(){
  const now = Date.now();
  checkDayRollover(); // 挂机跨天时及时归档清零，不必等刷新页面
  if(!paused){
    if(mode==='focus'){
      const left = endAt - now;
      focusAccMs += now - lastTick; flushFocusMinutes();
      if(chimeAt && now >= chimeAt && left > 0){
        // 铃响 → 先出预告条（可推迟 2 分钟），3 秒后再弹闭眼遮罩
        chimeAt = null; previewEndAt = now + PREVIEW_MS; playChime(1);
      }else if(previewEndAt && now >= previewEndAt){
        previewEndAt = 0; startMini(now);
      }else if(left <= 0) focusComplete();
    }else if(mode==='mini'){
      focusAccMs += now - lastTick; flushFocusMinutes(); // 闭眼休息计入专注时间
      if(now >= miniEndAt) endMini(now);
    }else if(mode==='rest'){
      if(now >= endAt) restComplete();
    }
  }
  lastTick = now;
  if(isElectron){ // Mini 浮窗状态广播（主进程中转；浏览器环境跳过）——isElectron 在文件后段定义，tick 运行时已初始化
    window.electronAPI.miniState({
      mode, paused,
      leftMs: Math.max(0, paused ? leftMs : endAt - now),
      totalMs, minutes: stats.minutes, weekMins: weekFocusMins(),
      theme: cfg.theme, fest: document.documentElement.getAttribute('data-fest') || '', focus: cfg.focus
    });
  }
  render();
}
/* 计时驱动放 Web Worker（v1.15.0）：后台标签页里主线程 setInterval 会被浏览器节流（最低到 1 分钟一次），
   Worker 定时器不受同等节流，提示音/遮罩/完成在挂机时也能及时触发；不支持 Worker 时回退主线程 */
if(window.Worker){
  try{
    const tickWorker = new Worker(URL.createObjectURL(new Blob(
      ['setInterval(function(){ postMessage(0); }, 250)'], {type:'text/javascript'})));
    tickWorker.onmessage = ()=>tick();
  }catch(e){ setInterval(tick, 250); }
}else setInterval(tick, 250);
// 标签页从后台切回时立即按真实时间校准（后台期间 setInterval 会被浏览器节流，时间戳计时本身不丢）
// 校准前先把"上次 tick 到此刻"这段被节流跳过的时间补进专注累计，避免统计分钟漏计
function recalibrate(){
  const now = Date.now();
  if(!paused && (mode==='focus'||mode==='mini')) focusAccMs += now - lastTick;
  lastTick = now;
  tick();
}
document.addEventListener('visibilitychange', ()=>{
  if(document.hidden) return;
  recalibrate();
  // iOS 切后台会把 AudioContext 重新挂起：回前台时恢复，否则后续提示音无声
  if(actx && actx.state==='suspended') actx.resume();
});
window.addEventListener('focus', recalibrate);
/* ================= 渲染 ================= */
const CIRC = 2*Math.PI*132;
dom.ringFg.style.strokeDasharray = CIRC; // [优化5] 使用缓存元素
function fmt(ms){ const s = Math.max(0, Math.ceil(ms/1000)); return pad(Math.floor(s/60))+':'+pad(s%60); }
function setInputsEnabled(en){ ['cfgFocus','cfgMinInt','cfgMaxInt','cfgRest'].forEach(id=>$(id).disabled=!en); }
function render(){
  const now = Date.now();
  let displayMs, sub='', phase='', ringClass='', progress=0, title='随机提示音专注计时器';
  const leftMsNow = paused ? leftMs : endAt - now;
  switch(mode){
    case 'idle':
      displayMs = cfg.focus*60000; phase='准备开始'; sub='点击开始，进入专注'; progress=0;
      break;
    case 'focus':
      displayMs = leftMsNow; phase='专注中'; ringClass='focus';
      progress = totalMs ? 1 - leftMsNow/totalMs : 0;
      sub = paused ? '已暂停' : '';
      title = `${fmt(displayMs)} 专注中`;
      break;
    case 'mini':
      displayMs = leftMsNow; phase='专注中 · 闭眼休息'; ringClass='focus';
      progress = totalMs ? 1 - leftMsNow/totalMs : 0;
      sub = '';
      title = '闭眼休息 10 秒';
      break;
    case 'focusDone':
      displayMs = sumMs; phase='专注完成'; ringClass='focus'; progress=1;
      sub = sumChimes>0 ? `提示音 ${sumChimes} 次 · 闭眼休息 ${sumChimes*10} 秒` : '全程无提示音打扰';
      title='🎉 专注完成';
      break;
    case 'rest':
      displayMs = leftMsNow; phase='大休息中'; ringClass='rest';
      progress = totalMs ? 1 - leftMsNow/totalMs : 0;
      sub = paused ? '已暂停' : (cfg.continuous ? '休息完自动开始下一轮' : '放松一下吧');
      title = `${fmt(displayMs)} 休息中`;
      break;
    case 'restDone':
      displayMs = 0; phase='休息结束'; ringClass='rest'; progress=1;
      sub = sumMs>0 ? `本轮专注 ${fmt(sumMs)}${sumChimes>0 ? ` · 提示音 ${sumChimes} 次` : ''} · 不会自动开始下一轮` : '本轮完成，不会自动开始下一轮';
      title='✅ 休息结束';
      break;
  }
  // 仅倒计时进行中（focus/rest，含暂停）悬停才显示 ± 按钮与时刻范围
  const adjusting = ['focus','rest'].includes(mode);
  dom.ringWrap.classList.toggle('adjusting', adjusting); // [优化5] 以下均使用缓存元素
  if(adjusting){
    const d1 = new Date(startAt), d2 = new Date(paused ? now + leftMs : endAt);
    dom.timeRange.textContent = pad(d1.getHours())+':'+pad(d1.getMinutes()) + ' - ' + pad(d2.getHours())+':'+pad(d2.getMinutes());
  } else {
    dom.timeRange.textContent = '';
  }
  dom.timeText.textContent = fmt(displayMs);
  dom.timeText.classList.toggle('clickable', mode==='idle'); // idle 时可点击设置时长，其他状态禁用
  dom.timeSub.textContent = sub;
  dom.phaseText.textContent = phase + (paused ? '（已暂停）' : '');
  dom.phaseLabel.className = 'phase-label ' + (ringClass==='rest' ? 'phase-rest' : ringClass==='focus' ? 'phase-focus' : '');
  const ring = dom.ringFg;
  ring.setAttribute('class', 'ring-fg ' + ringClass); // SVG 元素的 className 只读，须用 setAttribute
  ring.style.strokeDashoffset = CIRC * (1 - Math.min(1, Math.max(0, progress)));
  // 提示音预告条（暂停时 previewEndAt 已清零，天然隐藏）
  dom.chimePreview.classList.toggle('show', mode==='focus' && previewEndAt > now);
  // 闭眼休息遮罩
  const showMini = mode==='mini';
  dom.miniOverlay.classList.toggle('show', showMini);
  if(showMini){
    const ms = paused ? miniLeft : miniEndAt - now;
    dom.miniCount.textContent = Math.max(0, Math.ceil(ms/1000));
  }
  // 按钮可见性
  const vis = {
    startBtn:   mode==='idle',
    pauseBtn:   ['focus','mini','rest'].includes(mode),
    stopBtn:    ['focus','mini'].includes(mode),
    restBtn:    mode==='focusDone',
    skipRestBtn:mode==='focusDone',
    doneBtn:    mode==='restDone' || mode==='rest',
  }; // ± 按钮由 adjusting 悬停样式控制，不做 display 切换
  for(const id in vis) dom[id].classList.toggle('hidden', !vis[id]);
  dom.pauseBtn.textContent = paused ? '继续' : '暂停';
  dom.doneBtn.textContent = mode==='rest' ? '提前结束休息' : '完成，回到准备';
  renderSwitchLocks(); // 专注/闭眼阶段锁定两个模式开关
  // 统计
  dom.statMinutes.textContent = stats.minutes;
  dom.statRounds.textContent = stats.rounds;
  dom.statChimes.textContent = sessionChimes;
  renderGoal();
  // [优化12] 仅在标题变化时写入 document.title，避免每 250ms 触发一次无谓的标题解析
  const fullTitle = (mode==='idle' ? '' : title + ' · ') + '随机提示音专注计时器';
  if(document.title !== fullTitle) document.title = fullTitle;
}
/* ================= 每日目标 ================= */
function renderGoal(){
  const pill = $('goalPill'), txt = $('goalTxt'), edit = $('goalEdit');
  if(!pill) return;
  const cur = stats.rounds, goal = Math.max(1, cfg.goal||4);
  const idle = (mode==='idle');
  const done = cur >= goal && goal > 0;
  txt.textContent = done ? `今日目标已达成 ${cur}/${goal}` : `今日目标 ${cur}/${goal}`;
  pill.classList.toggle('done', done);
  pill.classList.toggle('readonly', !idle);
  edit.textContent = idle ? '点击设置' : '';
}
let goalDraft = 4;
function openGoal(){
  if(mode!=='idle') return; // 计时中只读
  goalDraft = Math.max(1, cfg.goal||4);
  $('goalNum').textContent = goalDraft;
  $('goalMask').classList.add('show');
}
function closeGoal(){ $('goalMask').classList.remove('show'); }
$('goalPill').addEventListener('click', openGoal);
$('goalMinus').addEventListener('click', ()=>{ goalDraft=Math.max(1,goalDraft-1); $('goalNum').textContent=goalDraft; });
$('goalPlus').addEventListener('click', ()=>{ goalDraft=Math.min(50,goalDraft+1); $('goalNum').textContent=goalDraft; });
$('goalCancel').addEventListener('click', closeGoal);
$('goalMask').addEventListener('click', e=>{ if(e.target===e.currentTarget) closeGoal(); });
$('goalSave').addEventListener('click', ()=>{
  cfg.goal = goalDraft; LS.set('rft_cfg', cfg);
  closeGoal(); renderGoal();
  addLog('info', `每日目标设为 ${goalDraft} 个番茄`);
});
/* ================= 节日庆祝 & 个人里程碑（v1.17.0） ================= */
/* 节日表：公历节日按 MM-DD 固定；农历节日不用第三方库，手动维护 2026-2030 公历日期，
   每年底顺手把下一年的日期补进对应 dates 数组即可。theme 值对应 CSS 里 html[data-fest="..."] 的限定配色 */
const SOLAR_FESTIVALS = {
  '01-01': {name:'元旦',   wish:'新岁启新程，愿你的每一次专注都有收获'},
  '02-14': {name:'情人节', wish:'愿爱与被爱都如期而至'},
  '05-01': {name:'劳动节', wish:'致敬每一份认真，也别忘了好好休息'},
  '06-01': {name:'儿童节', wish:'愿你永远保有好奇与热忱'},
  '10-01': {name:'国庆节', wish:'山河远阔，国泰民安，假期愉快', theme:'national'},
  '12-25': {name:'圣诞节', wish:'圣诞快乐，愿温暖与专注常伴'}
};
const LUNAR_FESTIVALS = {
  '春节':  {wish:'新春大吉，愿新的一年专注有所成、休息有所乐', theme:'spring',    dates:['2026-02-17','2027-02-06','2028-01-26','2029-02-13','2030-02-03']},
  '元宵':  {wish:'花好月圆，愿灯火可亲、诸事圆满',                              dates:['2026-03-03','2027-02-20','2028-02-09','2029-02-27','2030-02-17']},
  '端午':  {wish:'端午安康，愿生活有滋有味',                                    dates:['2026-06-19','2027-06-09','2028-05-28','2029-06-16','2030-06-05']},
  '七夕':  {wish:'愿有情人终成眷属，愿你不负热爱',                              dates:['2026-08-19','2027-08-08','2028-08-26','2029-08-16','2030-08-05']},
  '中秋':  {wish:'祝你团圆安康，专注之余记得吃月饼', theme:'midautumn',          dates:['2026-09-25','2027-09-15','2028-10-03','2029-09-22','2030-09-12']},
  '重阳':  {wish:'登高望远，愿步步皆稳、岁岁安康',                              dates:['2026-10-18','2027-10-08','2028-10-26','2029-10-16','2030-10-05']}
};
// 测试钩子：URL 加 ?festdate=YYYY-MM-DD 模拟"今天是某天"，仅影响节日/主题/里程碑判定，不动计时
// 测试钩子2：?festforce=中秋,国庆 强制命中指定节日（撞节优先级测试用）
const FEST_DEBUG_DATE = new URLSearchParams(location.search).get('festdate');
const FEST_FORCE = new URLSearchParams(location.search).get('festforce');
const festToday = () => FEST_DEBUG_DATE || todayKey();
/* 农历表覆盖年份（自动从 dates 推算）：当前年份超出覆盖范围说明日期表过期——
   控制台告警提醒补充，并在设置-关于区常驻显示覆盖年份（v1.20.0） */
const LUNAR_MAX_YEAR = Math.max(...Object.values(LUNAR_FESTIVALS).flatMap(f => f.dates.map(d => +d.slice(0,4))));
if(new Date().getFullYear() > LUNAR_MAX_YEAR)
  console.warn('农历节日数据已过期，请补充日期表（当前覆盖至 ' + LUNAR_MAX_YEAR + ' 年）');
/* 返回当天命中的节日数组（0~2 个）。撞节主题优先级（v1.20.0，勿随意改动）：
   带 theme 的农历大节 > 带 theme 的公历节日 > 无 theme 节日；
   主题只应用优先级最高者，但所有命中节日的祝福都合并进同一条横幅 */
function todayFestivals(){
  const out = [];
  if(FEST_FORCE){
    FEST_FORCE.split(',').forEach(n=>{
      if(LUNAR_FESTIVALS[n]) out.push(Object.assign({name:n, lunar:true}, LUNAR_FESTIVALS[n]));
      else { const md = Object.keys(SOLAR_FESTIVALS).find(k => { const nm = SOLAR_FESTIVALS[k].name; return nm===n || nm===n+'节'; }); if(md) out.push(SOLAR_FESTIVALS[md]); }
    });
  }else{
    const tk = festToday(), md = tk.slice(5);
    for(const name in LUNAR_FESTIVALS){
      const f = LUNAR_FESTIVALS[name];
      if(f.dates.includes(tk)) out.push(Object.assign({name, lunar:true}, f));
    }
    if(SOLAR_FESTIVALS[md]) out.push(SOLAR_FESTIVALS[md]);
  }
  out.sort((a,b) => ((b.theme?2:0)+(b.lunar?1:0)) - ((a.theme?2:0)+(a.lunar?1:0)));
  return out;
}
// 节日限定配色：命中带 theme 的大节就在 <html> 上挂 data-fest，节日过后自动摘除恢复
const FEST_META = {spring:'#7d1020', national:'#a10e1e', midautumn:'#1c2547'}; // 移动端状态栏跟随节日氛围
function applyFest(){
  const f = todayFestivals()[0];
  if(f && f.theme) document.documentElement.setAttribute('data-fest', f.theme);
  else document.documentElement.removeAttribute('data-fest');
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if(metaTheme) metaTheme.setAttribute('content',
    (f && f.theme) ? FEST_META[f.theme] : (cfg.theme==='dark' ? '#0a0a0d' : '#007aff'));
}
let festBarTimer = null;
function hideFestBar(){ $('festBar').classList.remove('show'); clearTimeout(festBarTimer); }
/* 避让 updateBar（v1.20.0）：更新提示条显示期间节日横幅下移，防止两条顶部叠放互相遮挡 */
function syncFestBarPos(){ $('festBar').classList.toggle('lower', $('updateBar').classList.contains('show')); }
function showFestBar(lines, sticky){
  $('festLines').innerHTML = lines.map(l => `<div class="fb-line">${escHtml(l)}</div>`).join('');
  $('festBar').classList.add('show');
  syncFestBarPos();
  clearTimeout(festBarTimer);
  // 节日横幅 8 秒自动收起；里程碑横幅（sticky）须用户手动点击才关闭（v1.21.0）
  if(!sticky) festBarTimer = setTimeout(hideFestBar, 8000);
}
$('festBar').addEventListener('click', hideFestBar);
const parseKey = k => { const p = k.split('-'); return new Date(+p[0], +p[1]-1, +p[2]); }; // 本地时区解析 YYYY-MM-DD
/* 里程碑统计源：累计分钟/轮次/陪伴天数，从 rft_history 实时计算（不新增存储键） */
function milestoneStats(){
  let m = 0, r = 0;
  for(const k in history){ m += history[k].minutes || 0; r += history[k].rounds || 0; }
  const days = Object.keys(history).sort();
  const d = days.length ? Math.max(0, Math.floor((parseKey(festToday()) - parseKey(days[0]))/86400000)) : 0;
  return {m, r, d};
}
/* 里程碑统一定义表（v1.21.0）：id/图标/名称/描述/庆祝文案/判定 test/进度 progress，
   checkCelebrations 与成就墙共用这一份，勿在别处另写判定逻辑。
   test/progress 入参 s={m:累计分钟, r:累计轮次, d:陪伴天数}；progress 返回 [0~1 比例, 进度文案]。
   rft_milestones 的值：达成日期字符串（老数据为 true，视同已达成但无日期） */
const MILESTONES = [
  {id:'hours10',  icon:'🌱', name:'初露锋芒', desc:'累计专注满 10 小时',  cheer:'🏆 累计专注满 10 小时，好习惯正在养成',
   test:s=>s.m>=600,   progress:s=>[Math.min(s.m/600,1),  Math.floor(Math.min(s.m,600)/60)+'/10 小时']},
  {id:'hours50',  icon:'💪', name:'渐入佳境', desc:'累计专注满 50 小时',  cheer:'🏆 累计专注满 50 小时，坚持就是实力',
   test:s=>s.m>=3000,  progress:s=>[Math.min(s.m/3000,1), Math.floor(Math.min(s.m,3000)/60)+'/50 小时']},
  {id:'hours100', icon:'👑', name:'百时宗师', desc:'累计专注满 100 小时', cheer:'🏆 累计专注满 100 小时，了不起的坚持',
   test:s=>s.m>=6000,  progress:s=>[Math.min(s.m/6000,1), Math.floor(Math.min(s.m,6000)/60)+'/100 小时']},
  {id:'rounds50', icon:'🍅', name:'番茄猎手', desc:'累计完成 50 个番茄',  cheer:'🍅 累计完成 50 个番茄，行动力满格',
   test:s=>s.r>=50,    progress:s=>[Math.min(s.r/50,1),    Math.min(s.r,50)+'/50 个']},
  {id:'year1',    icon:'🎂', name:'周年相伴', desc:'使用满一周年',        cheer:'🎉 你使用本计时器已满一周年，感谢一路相伴',
   test:s=>s.d>=365,   progress:s=>[Math.min(s.d/365,1),   '已陪伴 '+Math.min(s.d,365)+'/365 天']}
];
/* 齿轮红点：有"已达成但未查看"的里程碑时显示，进成就页查看后消除（seen 记在 rft_milestones._seen） */
function updateBadge(){
  const ms = LS.get('rft_milestones', {});
  const seen = ms._seen || [];
  const has = MILESTONES.some(d => ms[d.id] && !seen.includes(d.id));
  $('unreadBadge').classList.toggle('show', has);
}
function markAchvSeen(){
  const ms = LS.get('rft_milestones', {});
  ms._seen = MILESTONES.filter(d => ms[d.id]).map(d => d.id);
  LS.set('rft_milestones', ms);
  updateBadge();
}
/* 成就墙渲染：已达成亮色+达成日期（老数据无日期显示"已达成"）；未达成灰色锁定+实时进度条 */
function renderAchv(){
  const ms = LS.get('rft_milestones', {});
  const s = milestoneStats();
  $('achvList').innerHTML = MILESTONES.map(d => {
    const got = ms[d.id];
    const pr = d.progress(s);
    const status = got
      ? `<div class="av-status got">${typeof got==='string' ? escHtml(got)+' 达成' : '已达成'}</div>`
      : `<div class="av-status">${escHtml(pr[1])}</div><div class="av-bar"><div class="av-fill" style="width:${Math.round(pr[0]*100)}%"></div></div>`;
    return `<div class="achv-item ${got?'done':'locked'}"><div class="av-ic">${got?d.icon:'🔒'}</div>`+
      `<div class="av-main"><div class="av-name">${escHtml(d.name)}</div><div class="av-desc">${escHtml(d.desc)}</div>${status}</div></div>`;
  }).join('');
}
/* 检查并弹出庆祝横幅：节日（每天一次）+ 里程碑（每个只一次），命中多条合并成一条横幅。
   调用时机：启动、跨天（checkDayRollover）、分钟冲账（flushFocusMinutes）、轮次进账（bumpRound），
   保证专注中途达成里程碑也能即时触发 */
function checkCelebrations(){
  const tk = festToday();
  const lines = [];
  const fests = todayFestivals();
  if(fests.length && LS.get('rft_fest_shown','') !== tk){
    fests.forEach(f => lines.push(`🎊 今天是${f.name}，${f.wish}`)); // 撞节时多条祝福合并展示
    LS.set('rft_fest_shown', tk);
  }
  const ms = LS.get('rft_milestones', {});
  let msDirty = false, celebrated = false;
  const s = milestoneStats();
  /* 时长类里程碑（10/50/100 小时）：一次只庆祝新达成的最高档，已达成的低档一并标记——
     老用户升级后不会连续炸出三条横幅 */
  const hourDefs = MILESTONES.filter(d => d.id[0]==='h');
  const hourHit = hourDefs.filter(d => d.test(s));
  const hourNew = hourHit.filter(d => !ms[d.id]);
  if(hourNew.length){
    lines.push(hourNew[hourNew.length-1].cheer); celebrated = true;
    hourHit.forEach(d => { if(!ms[d.id]){ ms[d.id] = tk; msDirty = true; } });
  }
  MILESTONES.filter(d => d.id[0]!=='h').forEach(d => { // rounds50 / year1
    if(!ms[d.id] && d.test(s)){ lines.push(d.cheer); ms[d.id] = tk; msDirty = true; celebrated = true; }
  });
  if(msDirty){ LS.set('rft_milestones', ms); updateBadge(); }
  if(lines.length){
    showFestBar(lines, celebrated);
    if(celebrated) playMilestone(); // 里程碑专属成就音（区别于节日横幅，仅里程碑触发）
  }
}
$('lunarCover').textContent = '农历节日数据覆盖至 ' + LUNAR_MAX_YEAR + ' 年';
updateBadge(); // 启动即刷新红点（有未查看的已达成里程碑时显示）
applyFest();          // 启动即应用节日限定配色（非节日则摘除）
checkCelebrations();  // 启动即检查横幅
/* ================= 专注时长弹窗（仅 idle 可开） ================= */
function openFocusDur(){
  if(mode!=='idle') return; // 计时中点击无效
  const inp = $('focusDurInput');
  inp.value = cfg.focus;
  // 定位到时间数字正下方，与参考图一致
  const r = $('timeText').getBoundingClientRect();
  const mask = $('focusDurMask');
  mask.style.left = (r.left + r.width/2) + 'px';
  mask.style.top = (r.bottom + 10) + 'px';
  mask.style.transform = 'translateX(-50%)';
  $('focusDurMask').classList.add('show');
  setTimeout(()=>{ inp.focus(); inp.select(); }, 50); // 等弹窗动画起再聚焦选中，避免闪烁
}
function closeFocusDur(){ $('focusDurMask').classList.remove('show'); }
function saveFocusDur(){
  const raw = $('focusDurInput').value.trim();
  let v = parseInt(raw, 10);
  if(Number.isNaN(v)) v = cfg.focus; // 空/无效 → 保持原值
  cfg.focus = Math.min(180, Math.max(5, v));
  LS.set('rft_cfg', cfg);
  $('cfgFocus').value = cfg.focus; // 同步设置面板里的数字输入框
  closeFocusDur(); render();
  addLog('info', `专注时长设为 ${cfg.focus} 分钟`);
}
$('timeText').addEventListener('click', openFocusDur);
$('timeText').addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openFocusDur(); } });
$('focusDurOk').addEventListener('click', saveFocusDur);
$('focusDurCancel').addEventListener('click', closeFocusDur);
$('focusDurMask').addEventListener('click', e=>{ if(e.target===e.currentTarget) closeFocusDur(); });
/* ================= 数据备份（导出 / 导入，v1.15.0） ================= */
// 浏览器存储是"借来的"：导出 JSON 是纯前端唯一的数据保险；导入后整页刷新走完整启动+迁移流程
$('exportData').addEventListener('click', ()=>{
  const data = {app:'random-focus-timer', version:'v1.15.0', exportedAt:new Date().toISOString(),
    rft_cfg:LS.get('rft_cfg',null), rft_stats:LS.get('rft_stats',null),
    rft_history:LS.get('rft_history',{}), rft_logs:LS.get('rft_logs',[]), rft_schema:LS.get('rft_schema',SCHEMA_VERSION),
    rft_fest_shown:LS.get('rft_fest_shown',null), rft_milestones:LS.get('rft_milestones',null)};
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)], {type:'application/json'}));
  a.download = 'focus-timer-backup-' + todayKey() + '.json';
  a.click(); URL.revokeObjectURL(a.href);
  addLog('info', '已导出数据备份');
});
$('importData').addEventListener('click', ()=>$('importFile').click());
$('importFile').addEventListener('change', e=>{
  const f = e.target.files[0]; e.target.value = ''; // 清空以便重复选同一文件
  if(!f) return;
  const rd = new FileReader();
  rd.onload = ()=>{
    try{
      const d = JSON.parse(rd.result);
      if(!d || typeof d!=='object' || d.app!=='random-focus-timer') throw new Error('bad file');
      ['rft_cfg','rft_stats','rft_history','rft_logs','rft_schema','rft_fest_shown','rft_milestones'].forEach(k=>{ if(d[k]!=null) LS.set(k, d[k]); });
      location.reload();
    }catch(err){ alert('导入失败：文件格式不正确'); }
  };
  rd.readAsText(f);
});
/* ================= 事件绑定 ================= */
$('startBtn').addEventListener('click', startFocus);
$('pauseBtn').addEventListener('click', togglePause);
$('stopBtn').addEventListener('click', requestAbandon);
$('restBtn').addEventListener('click', startRest);
$('skipRestBtn').addEventListener('click', ()=>toIdle('跳过大休息'));
$('doneBtn').addEventListener('click', ()=>{ if(mode==='rest') addLog('rest','提前结束大休息'); toIdle(); });
$('minusBtn').addEventListener('click', ()=>adjust(-5));
$('plusBtn').addEventListener('click', ()=>adjust(5));
// 预告期「推迟 2 分钟」：取消本次预告，2 分钟后再响（落入最后 5 分钟则不再安排）
$('postponeBtn').addEventListener('click', ()=>{
  previewEndAt = 0; previewLeft = 0;
  const now = Date.now(), left = endAt - now;
  if(mode==='focus' && left - POSTPONE_MS >= NO_CHIME_TAIL){ chimeAt = now + POSTPONE_MS; addLog('info', '已推迟 2 分钟'); }
  else addLog('info', '剩余时间不足，本次提示音已取消');
  render();
});
// 点击后移除按钮焦点，避免空格键误触发按钮
document.querySelectorAll('button').forEach(b=>b.addEventListener('click', function(){ this.blur(); }));
document.addEventListener('keydown', e=>{
  if(e.code==='Escape'){ if($('focusDurMask').classList.contains('show')) closeFocusDur(); else if($('goalMask').classList.contains('show')) closeGoal(); else if($('abandonMask').classList.contains('show')) closeAbandon(); else if($('gearMenu').classList.contains('show')) closeGearMenu(); else closePanel(); return; }
  if(e.key==='Enter' && $('focusDurMask').classList.contains('show')){ e.preventDefault(); saveFocusDur(); return; }
});
renderLogs();
render();
/* ================= Electron 桌面客户端适配（v1.24.0） ================= */
// window.electronAPI 由 electron/preload.js 注入；浏览器版为 undefined。
// 以下全部为特性检测，浏览器环境行为完全不变。
const isElectron = typeof window.electronAPI !== 'undefined';
if(isElectron){
  $('gmMini').style.display = ''; // 齿轮菜单显示「Mini 模式」（网页版保持隐藏）
  // 开源仓库链接：客户端走主进程 shell.openExternal（系统浏览器），不允许 target=_blank 开裸窗口
  $('repoLink').addEventListener('click', e => {
    e.preventDefault();
    window.electronAPI.openExternal('https://github.com/zhiyue16/zhiyue');
  });
  /* Mini 浮窗命令执行（v1.27.0）：全部走主窗口同一批函数，浮窗只是遥控器，不跑第二套计时 */
  window.electronAPI.onMiniCmd(c => {
    if(!c || !c.type) return;
    if(c.type==='start'){ if(mode==='idle') startFocus(); }
    else if(c.type==='pause'){ togglePause(); }
    else if(c.type==='stop'){
      if(mode==='focus' || mode==='mini'){
        if(elapsedFocusMs() > ABANDON_CONFIRM_MS) window.electronAPI.showMainWindow(); // 确认框在主窗口弹出，先唤起
        requestAbandon();
      }
    }
    else if(c.type==='rest'){ if(mode==='focusDone') startRest(); }
    else if(c.type==='idle'){ if(mode==='restDone') toIdle(); }
    else if(c.type==='setFocus'){
      const v = parseInt(c.payload, 10);
      if(!Number.isNaN(v) && mode==='idle'){
        cfg.focus = Math.min(180, Math.max(5, v)); // 与主窗口 saveFocusDur 同一钳制
        LS.set('rft_cfg', cfg); $('cfgFocus').value = cfg.focus; render();
        addLog('info', `专注时长设为 ${cfg.focus} 分钟（Mini 浮窗）`);
      }
    }
  });
  document.body.classList.add('is-electron'); // 开启拖动区与无边框样式（网页版不受影响）
  /* 无边框窗口控制（v1.26.0）：自绘按钮 → 主进程 IPC；关闭维持"最小化到托盘" */
  $('wcBar').style.display = 'flex';
  $('wcMin').addEventListener('click', () => window.electronAPI.windowMin());
  $('wcMax').addEventListener('click', () => window.electronAPI.windowMaxToggle());
  $('wcClose').addEventListener('click', () => window.electronAPI.windowClose());
  window.electronAPI.onMaxChange(m => $('wcMax').classList.toggle('is-max', m)); // 最大化⇄还原图标
  $('dragStrip').addEventListener('dblclick', () => window.electronAPI.windowMaxToggle()); // 双击顶部空白切换最大化
  // 开机自启动开关（仅桌面客户端显示，状态由主进程 login item 管理，不进 rft_cfg）
  const alRow = $('autoLaunchRow'), alSw = $('cfgAutoLaunch');
  alRow.style.display = '';
  const renderAl = v => { alSw.classList.toggle('on', !!v); alSw.setAttribute('aria-checked', String(!!v)); };
  window.electronAPI.getAutoLaunch().then(renderAl).catch(()=>{});
  alSw.addEventListener('click', ()=>{
    const next = !alSw.classList.contains('on');
    window.electronAPI.setAutoLaunch(next).then(renderAl).catch(()=>{});
  });
  /* 检查更新行：网页版走 SW 机制（见文件尾部 IIFE，Electron 下不绑定）；
     客户端接管为 electron-updater：状态事件驱动按钮与状态文案（v1.25.0） */
  const auBtn = $('checkUpdate'), auStatus = $('checkUpdateStatus');
  const setAu = (txt, cls) => { auStatus.textContent = txt; auStatus.className = 'au-status' + (cls ? ' '+cls : ''); };
  let auState = 'idle';
  window.electronAPI.getVersion().then(v => setAu('当前 v' + v + ' · 桌面客户端')).catch(()=>{});
  window.electronAPI.onUpdateStatus(s => {
    auState = s.state;
    if(s.state==='checking'){ auBtn.disabled = true; auBtn.textContent = '检查中…'; setAu('检查中…'); }
    else if(s.state==='latest'){ auBtn.disabled = false; auBtn.textContent = '检查更新'; setAu('已是最新版本', 'ok'); }
    else if(s.state==='available'){ auBtn.disabled = false; auBtn.textContent = '下载更新'; setAu('发现新版本 v' + s.version, 'new'); }
    else if(s.state==='downloading'){ auBtn.disabled = true; auBtn.textContent = '下载中 ' + s.percent + '%'; setAu('新版本下载中…', 'new'); }
    else if(s.state==='ready'){ auBtn.disabled = false; auBtn.textContent = '重启升级'; setAu('更新已就绪，重启完成升级', 'new'); }
    else if(s.state==='error'){ auBtn.disabled = false; auBtn.textContent = '检查更新'; setAu('检查失败，不影响使用'); }
    else if(s.state==='dev'){ auBtn.disabled = false; auBtn.textContent = '检查更新'; setAu('开发环境不支持自动更新'); }
  });
  auBtn.addEventListener('click', () => {
    if(auState==='available') window.electronAPI.downloadUpdate();
    else if(auState==='ready') window.electronAPI.installUpdate();
    else window.electronAPI.checkUpdate();
  });
}
// 完成事件 → 主进程原生通知（focus=专注完成 / rest=大休息结束）
function nativeNotify(kind){ if(isElectron){ try{ window.electronAPI.notify(kind); }catch(e){} } }
// 注册 Service Worker（PWA 离线缓存 + 新版本更新提醒）
// Electron 下本地加载天然离线，SW 无意义：静默跳过，不得报错刷屏
let swReg = null; // 提升作用域：手动"检查更新"也要用
const UPDATE_NOTES_MAX = 3; // 更新点最多显示 3 条，超出折叠为"等 N 项更新"
async function showUpdateBar(demoNotes){
  $('updateBar').classList.add('show');
  syncFestBarPos(); // 更新条出现 → 节日横幅下移避让（无横幅时无副作用）
  // 拉取新版本的版本号与更新说明（version.json 不走 SW 缓存）。旧页面不可能内置未来版本的说明，
  // 必须在弹出时实时获取；离线/拉取失败则保持默认文案，不影响原有更新流程
  try{
    const info = demoNotes ? {version:'v9.9.9', notes:demoNotes}
      : await (async()=>{ const r = await fetch('./version.json?t=' + Date.now(), {cache:'no-store'});
          if(!r.ok) throw new Error('http ' + r.status); return r.json(); })();
    if(info && info.version){
      $('updateTitle').textContent = '🎉 新版本 ' + info.version;
      const ul = $('updateNotes');
      if(Array.isArray(info.notes) && info.notes.length){
        const items = info.notes.slice(0, UPDATE_NOTES_MAX).map(n => `<li>${escHtml(n)}</li>`);
        if(info.notes.length > UPDATE_NOTES_MAX) items.push(`<li class="ub-more">等 ${info.notes.length} 项更新</li>`);
        ul.innerHTML = items.join('');
        ul.hidden = false;
      }
    }
  }catch(e){ /* 降级：只显示"发现新版本"，按钮流程不受影响 */ }
}
// 测试钩子：?updatedemo=N 强制弹出更新条并渲染 N 条示例更新点（验证气泡布局/折叠，不影响真实更新流程）
(function(){
  const n = parseInt(new URLSearchParams(location.search).get('updatedemo'), 10);
  if(n > 0) showUpdateBar(Array.from({length:Math.min(n,20)}, (_,i)=>'示例更新点：这是第 '+(i+1)+' 条用于验证气泡圆角边界的更新说明文案'));
})();
function notifyUpdate(){
  // 有等待中的新 SW 且当前页面受旧 SW 控制（说明是更新而非首次安装）才提示
  if(swReg && swReg.waiting && navigator.serviceWorker.controller) showUpdateBar();
}
if('serviceWorker' in navigator && !isElectron){
  let reloading = false;
  // 新 SW 激活接管后刷新页面（用户点"立即更新"触发）
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{
    if(reloading) return; reloading = true; location.reload();
  });
  $('updateNow').addEventListener('click', ()=>{
    if(swReg && swReg.waiting) swReg.waiting.postMessage({type:'SKIP_WAITING'});
  });
  $('updateLater').addEventListener('click', ()=>{ $('updateBar').classList.remove('show'); syncFestBarPos(); });
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').then(reg=>{
      swReg = reg;
      notifyUpdate(); // 打开页面时已有等待中的新版（之前点过"稍后"）→ 直接提示
      // 检测到新版本下载完成 → 提示
      reg.addEventListener('updatefound', ()=>{
        const nw = reg.installing;
        nw.addEventListener('statechange', ()=>{ if(nw.state==='installed') notifyUpdate(); });
      });
      // 长时间挂机时定时检查更新（每次打开页面浏览器也会自动查一次）
      setInterval(()=>reg.update(), 30*60000);
    }).catch(e=>console.warn('SW 注册失败', e));
  });
}
// 关于区 · 手动检查更新（仅网页版 SW 机制；Electron 客户端由上方适配块接管，不绑定此逻辑）
if(!isElectron) (function(){
  const btn = $('checkUpdate'), status = $('checkUpdateStatus');
  let busy = false;
  const setStatus = (txt, cls)=>{ status.textContent = txt; status.className = 'au-status' + (cls ? ' '+cls : ''); };
  const finish = (txt, cls)=>{ setStatus(txt, cls); busy = false; btn.disabled = false; };
  btn.addEventListener('click', async ()=>{
    if(busy) return;
    if(!('serviceWorker' in navigator)){ setStatus('当前环境不支持'); return; }
    busy = true; btn.disabled = true; setStatus('检查中…');
    try{
      const reg = swReg || await navigator.serviceWorker.getRegistration();
      if(!reg){ finish('请刷新页面后重试'); return; }
      await reg.update(); // 让浏览器重新拉取 sw.js 比对
      if(reg.waiting && navigator.serviceWorker.controller){ finish('发现新版本','new'); showUpdateBar(); return; }
      if(reg.installing){
        // 有 SW 正在下载：页面受旧 SW 控制才算"发现新版本"（否则是首次安装缓存）
        const isUpdate = !!navigator.serviceWorker.controller;
        setStatus(isUpdate ? '发现新版本，下载中…' : '正在初始化缓存…', isUpdate ? 'new' : '');
        const nw = reg.installing;
        const to = setTimeout(()=>finish(isUpdate ? '下载完成后会提示' : '已是最新版本', isUpdate ? 'new' : 'ok'), 8000);
        nw.addEventListener('statechange', ()=>{
          if(nw.state==='installed'){
            clearTimeout(to);
            if(isUpdate){ finish('发现新版本','new'); showUpdateBar(); }
            else finish('已是最新版本','ok');
          }
        });
        return;
      }
      finish('已是最新版本','ok');
    }catch(e){ finish('检查失败，请检查网络'); }
  });
})();
})();
