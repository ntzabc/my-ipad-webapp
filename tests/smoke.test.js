/* ============================================================
   浏览器环境冒烟测试
     node tests/smoke.test.js        （需要先 npm install jsdom）

   为什么需要它：
     前面几套测试只能证明"纯函数是对的"。而真正的坑几乎都在
     界面层 —— 选择器写错、方法名写错、闭包里引用了还不存在的
     变量、忘了返回清理函数。这些光靠读代码看不出来。这个项目
     已经吃过一次亏：所有算法测试全绿，但摄像头和麦克风在真机
     上"能授权、用不了"。

   两段测试：
     第一段 · 设备被拒绝
       摄像头和麦克风都抛 NotAllowedError。验证界面给得出人能
       看懂的原因，而不是静默失败或者白屏。
     第二段 · 设备可用
       给假的摄像头帧和假的音频数据，把整条链路真的跑起来：
       肤色定位头部 → 估计眼部区域 → 驱动视差；逐像素跑七种
       视觉算法；采样 → 训练 → 预测；频谱 → 音高 → 拍手。

   做法：
     用 jsdom 搭一个真的 DOM，把 index.html 和全部脚本按脚本
     标签的顺序跑起来，然后点开每一个玩法，并手动推进 rAF 队列
     若干帧。任何异常都会被抓住。
   ============================================================ */

const fs = require('fs');
const path = require('path');

let JSDOM;
try { JSDOM = require('jsdom').JSDOM; }
catch (_) {
  console.log('\n跳过：没装 jsdom。装一下即可运行：');
  console.log('  npm install jsdom\n');
  process.exit(0);
}

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let pass = 0, fail = 0;
const bad = [];
function ok(cond, label, detail) {
  if (cond) pass++;
  else { fail++; bad.push(label + (detail ? '\n      ' + detail : '')); }
}

/* ============================================================
   合成的测试图
   ============================================================ */
let synthCalls = 0;

/* 文档图：四个色块 + 十字黑线，区域分割应该正好找出 4 块 */
function synthDoc(w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const d = new Uint8ClampedArray(w * h * 4);
  const quads = [[220, 60, 60], [60, 200, 90], [70, 110, 230], [235, 200, 70]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let c = quads[(y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1)];
      if (Math.abs(x - w / 2) < Math.max(1, w * 0.008) ||
          Math.abs(y - h / 2) < Math.max(1, h * 0.008)) c = [8, 10, 16];
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
  }
  return { data: d, width: w, height: h };
}

/* 摄像头帧：一张像样的"人脸" —— 肤色椭圆 + 两个深色眼睛，
   再配一个高亮白斑（给光笔用）和一块高饱和红（给按色相追踪用） */
function synthFrame(w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const d = new Uint8ClampedArray(w * h * 4);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  };
  const phase = (synthCalls % 5) * 0.05;        // 让脸随时间缓慢移动，别是一张死图

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) set(x, y, [40, 45, 60]);
  }
  // 高亮白斑（光笔追踪目标）
  const bx = w * (0.18 + phase), by = h * 0.76;
  for (let y = -h * 0.12; y <= h * 0.12; y++) {
    for (let x = -w * 0.10; x <= w * 0.10; x++) {
      const t = 1 - Math.hypot(x / (w * 0.10), y / (h * 0.12));
      if (t > 0) set(Math.round(bx + x), Math.round(by + y), [255, 255, 255]);
    }
  }
  // 高饱和红块（按色相追踪目标）
  for (let y = h * 0.80; y < h * 0.95; y++) {
    for (let x = w * 0.80; x < w * 0.96; x++) set(Math.round(x), Math.round(y), [235, 30, 30]);
  }
  // 肤色椭圆（脸）
  const cx = w * (0.50 + phase), cy = h * 0.36;
  const rx = w * 0.17, ry = h * 0.23;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) set(x, y, [208, 156, 128]);
    }
  }
  // 两只深色的"眼睛"，画在脸内部偏上的位置
  [[-0.42, -0.30], [0.42, -0.30]].forEach(o => {
    const ex = cx + rx * o[0], ey = cy + ry * o[1];
    for (let y = -h * 0.035; y <= h * 0.035; y++) {
      for (let x = -w * 0.035; x <= w * 0.035; x++) {
        if (Math.hypot(x / (w * 0.035), y / (h * 0.035)) <= 1) {
          set(Math.round(ex + x), Math.round(ey + y), [40, 32, 28]);
        }
      }
    }
  });
  return { data: d, width: w, height: h };
}

/* 摄像头是按固定分辨率取帧的，按尺寸路由到"人脸帧" */
const PROC_SIZES = { '160x120': 1, '168x126': 1, '176x132': 1, '192x144': 1 };
function synthImageData(w, h) {
  synthCalls++;
  const key = Math.round(w) + 'x' + Math.round(h);
  return PROC_SIZES[key] ? synthFrame(w, h) : synthDoc(w, h);
}

/* ============================================================
   搭环境
   ============================================================ */
const html = read('index.html');
const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'https://ntzabc.github.io/my-ipad-webapp/'
});
const w = dom.window;

const errors = [];
w.addEventListener('error', e => errors.push(String((e && e.message) || e)));
w.addEventListener('unhandledrejection', e => errors.push('未处理的 Promise 拒绝: ' + e.reason));

/* ---------- 画布 ---------- */
const noop = () => {};
function makeCtx(canvas) {
  return {
    canvas: canvas,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif',
    lineCap: 'butt', lineJoin: 'miter', globalAlpha: 1, globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true, filter: 'none', textAlign: 'start', textBaseline: 'alphabetic',
    shadowBlur: 0, shadowColor: '#000',
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop, transform: noop,
    setTransform: noop, resetTransform: noop, clip: noop, drawFocusIfNeeded: noop,
    clearRect: noop, fillRect: noop, strokeRect: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, arcTo: noop,
    ellipse: noop, rect: noop, roundRect: noop,
    bezierCurveTo: noop, quadraticCurveTo: noop,
    fill: noop, stroke: noop, setLineDash: noop, getLineDash: () => [],
    fillText: noop, strokeText: noop, measureText: () => ({ width: 12 }),
    drawImage: noop, putImageData: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createConicGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    isPointInPath: () => false,
    getImageData: (x, y, ww, hh) => synthImageData(ww, hh),
    createImageData: (ww, hh) => synthImageData(ww, hh)
  };
}
w.HTMLCanvasElement.prototype.getContext = function () { return makeCtx(this); };
w.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,AAAA'; };

/* ---------- 让元素有尺寸，否则所有绘制都会提前 return ---------- */
Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return 420; }, configurable: true });
Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get() { return 300; }, configurable: true });
w.HTMLElement.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 0, left: 0, right: 420, bottom: 300, width: 420, height: 300 };
};

if (!w.ImageData) {
  w.ImageData = function (data, width, height) { return { data: data, width: width, height: height }; };
}

/* ---------- rAF：手动推进，并且真的支持取消 ----------
   如果 cancelAnimationFrame 写成空函数，功能调用清理之后循环
   还会自己重新注册，就永远测不出"清理到底有没有生效"。 */
let rafSeq = 1;
let rafMap = new Map();
w.requestAnimationFrame = fn => { const id = rafSeq++; rafMap.set(id, fn); return id; };
w.cancelAnimationFrame = id => { rafMap.delete(id); };

let clock = 1000;
function pump(frames) {
  for (let i = 0; i < frames; i++) {
    const q = Array.from(rafMap.entries());
    rafMap.clear();
    for (let k = 0; k < q.length; k++) {
      try { q[k][1](clock); }
      catch (e) { errors.push('rAF 回调抛错：' + ((e && e.stack) || e)); }
    }
    clock += 33;
  }
}

/* ---------- 其他浏览器 API ---------- */
w.ResizeObserver = function (cb) {
  this.observe = () => { setTimeout(() => { try { cb([]); } catch (e) { errors.push('ResizeObserver: ' + e.message); } }, 0); };
  this.unobserve = noop;
  this.disconnect = noop;
};
w.matchMedia = () => ({
  matches: false, media: '',
  addListener: noop, removeListener: noop,
  addEventListener: noop, removeEventListener: noop
});

/* ---------- 摄像头：先拒绝，第二段再放行 ---------- */
const DENIED = () => Promise.reject(Object.assign(new Error('用户拒绝'), { name: 'NotAllowedError' }));
let deviceMode = 'denied';
Object.defineProperty(w.navigator, 'mediaDevices', {
  configurable: true,
  value: { getUserMedia: () => (deviceMode === 'ok' ? Promise.resolve(fakeStream()) : DENIED()) }
});
function fakeStream() {
  return { getTracks: () => [{ stop: noop, kind: 'video' }], getVideoTracks: () => [{ stop: noop }] };
}

/* 视频元素：只要有尺寸和 readyState，Camera.waitForFrame 就会认为"画面到了" */
Object.defineProperty(w.HTMLVideoElement.prototype, 'videoWidth', { get() { return 640; }, configurable: true });
Object.defineProperty(w.HTMLVideoElement.prototype, 'videoHeight', { get() { return 480; }, configurable: true });
Object.defineProperty(w.HTMLVideoElement.prototype, 'readyState', { get() { return 4; }, configurable: true });
w.HTMLVideoElement.prototype.play = () => Promise.resolve();

/* 音频上下文：给一段会呼吸的假信号，让频谱/音量/音高都有真实的数 */
let audioAnalysers = 0;
w.AudioContext = function () {
  this.state = 'suspended';
  this.sampleRate = 48000;
  this.currentTime = 0;
};
w.AudioContext.prototype.resume = function () { this.state = 'running'; return Promise.resolve(); };
w.AudioContext.prototype.close = function () { this.state = 'closed'; return Promise.resolve(); };
w.AudioContext.prototype.createMediaStreamSource = function () {
  return { connect: noop, disconnect: noop };
};
w.AudioContext.prototype.createAnalyser = function () {
  audioAnalysers++;
  const t0 = Date.now();
  return {
    fftSize: 2048,
    frequencyBinCount: 1024,
    smoothingTimeConstant: 0,
    getByteFrequencyData(a) {
      const k = (Date.now() - t0) / 90;
      for (let i = 0; i < a.length; i++) {
        a[i] = Math.round(Math.abs(Math.sin(k + i * 0.07)) * 200);
      }
    },
    getFloatTimeDomainData(a) {
      const k = (Date.now() - t0) / 1000;
      for (let i = 0; i < a.length; i++) {
        // 叠加一点拍手式的瞬态，音高检测和起跳检测都能有东西可测
        a[i] = Math.sin(i * 0.05 + k * 2) * 0.26 + Math.sin(i * 0.13) * 0.06;
      }
    }
  };
};
w.webkitAudioContext = w.AudioContext;

/* ============================================================
   载入全部脚本
   ============================================================ */
const SCRIPTS = ['ai.js', 'sense.js', 'vision.js', 'particles.js', 'features.js', 'features-cam.js', 'app.js'];
console.log('\n【脚本载入】');
SCRIPTS.forEach(f => {
  try {
    w.eval(read(f));
    ok(true, f + ' 载入成功');
  } catch (e) {
    ok(false, f + ' 载入成功', (e && e.stack) || String(e));
  }
});

const FEATURES = w.FEATURES || [];

/* ============================================================
   小工具
   ============================================================ */
const sheetBody = w.document.getElementById('sheetBody');
const sheetClose = w.document.getElementById('sheetClose');
const cards = Array.prototype.slice.call(w.document.querySelectorAll('.fcard'));

function click(el) {
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function hold(el, type) {
  el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true }));
}
function btnsInBody() {
  return Array.prototype.slice.call(sheetBody.querySelectorAll('button'));
}
function byText(txt) {
  return btnsInBody().filter(b => (b.textContent || '').trim() === txt)[0];
}
function statValues() {
  return Array.prototype.slice.call(sheetBody.querySelectorAll('.stat .stat__v'))
    .map(e => e.textContent);
}
function statEls() {
  return Array.prototype.slice.call(sheetBody.querySelectorAll('.stat'));
}
function statByLabel(label) {
  const hit = statEls().filter(s => {
    const k = s.querySelector('.stat__k');
    return k && (k.textContent || '').trim() === label;
  })[0];
  return hit ? hit.querySelector('.stat__v').textContent : null;
}
function cardByName(name) {
  return cards.filter(c => c.querySelector('.fcard__name').textContent === name)[0];
}
function tick(ms) { return new Promise(r => setTimeout(r, ms == null ? 8 : ms)); }

async function openByName(name) {
  const c = cardByName(name);
  if (!c) return null;
  click(c);
  pump(6);
  return sheetBody;
}
async function closeSheet() {
  click(sheetClose);
  await tick(430);        // closeSheet 里有个 380ms 的清理定时器，必须等它过去
  pump(3);
}

/* ============================================================
   第一段：设备被拒绝
   ============================================================ */
async function phaseDenied() {
  console.log('\n【第一段 · 设备被拒绝】');
  deviceMode = 'denied';

  for (let i = 0; i < cards.length; i++) {
    const name = cards[i].querySelector('.fcard__name').textContent;
    const before = errors.length;

    click(cards[i]);
    pump(10);

    ok(sheetBody.innerHTML.indexOf('启动失败') < 0,
       '「' + name + '」能正常打开',
       (sheetBody.querySelector('.empty__desc') || {}).textContent || '');
    ok(sheetBody.children.length > 0, '「' + name + '」面板里有内容');
    ok(errors.length === before, '「' + name + '」打开过程中没有抛异常',
       errors.slice(before).join('\n      '));

    const camBtn = byText('打开摄像头') || byText('打开前置摄像头') ||
                   byText('开始头部追踪') || byText('打开麦克风');
    if (camBtn) {
      const e0 = errors.length;
      const label = camBtn.textContent.trim();
      click(camBtn);
      await tick(30);
      pump(6);
      const box = sheetBody.querySelector('.camstart');
      const txt = box ? (box.textContent || '') : '';
      ok(box && box.style.display !== 'none' && /权限|拒绝|不支持|打不开/.test(txt),
         '「' + name + '」点了「' + label + '」被拒绝后给了人能看懂的原因',
         '实际文案：' + txt.slice(0, 90));
      ok(errors.length === e0, '「' + name + '」设备失败路径没有抛异常',
         errors.slice(e0).join('\n      '));
    }

    pump(20);
    await closeSheet();
  }
}

/* ============================================================
   第二段：设备可用 —— 把整条链路真的跑一遍
   ============================================================ */
async function phaseLive() {
  console.log('\n【第二段 · 设备可用】');
  deviceMode = 'ok';

  /* ---------- 影像 3D 重建：图片 → 3D + 头部追踪 ---------- */
  await openByName('影像 3D 重建');
  ok(!!byText('用示例图'), '3D 玩法有「用示例图」按钮（不用拍照就能先看效果）');
  if (byText('用示例图')) {
    const e0 = errors.length;
    click(byText('用示例图'));
    for (let i = 0; i < 8; i++) await tick(30);

    const regions = parseInt(statByLabel('平面区域'), 10);
    const lines = parseInt(statByLabel('直线'), 10);
    const faces = parseInt(statByLabel('3D 面片'), 10);
    ok(regions >= 4, '从合成图里分割出了 4 个平面区域（实际 ' + regions + '）');
    ok(lines >= 2, '霍夫直线至少找到 2 条（实际 ' + lines + '）');
    ok(faces > regions, '每个区域都被抬成了 3D 面片：' + faces + ' 面片 / ' + regions + ' 区域');

    const stepTxt = (sheetBody.querySelector('.stepbar__info') || {}).textContent || '';
    ok(/分析完成/.test(stepTxt), '步骤条报告分析完成', '实际：' + stepTxt);

    pump(20);
    ok(errors.length === e0, '3D 渲染循环没有抛异常', errors.slice(e0).join('\n      '));

    const modeBtn = byText('换高度方式') || byText('高度：明度') ||
                    byText('高度：面积') || byText('高度：层叠');
    if (modeBtn) {
      click(modeBtn);
      pump(4);
      ok(parseInt(statByLabel('3D 面片'), 10) > 0, '切换高度方式后仍然有面片');
    }
  }

  /* 头部追踪：合成帧里有一张脸，应该能锁上 */
  const trk = byText('开始头部追踪');
  ok(!!trk, '3D 玩法有「开始头部追踪」按钮');
  if (trk) {
    const e0 = errors.length;
    click(trk);
    await tick(60);
    pump(30);
    const info = [].slice.call(sheetBody.querySelectorAll('.note'))
      .map(e => e.textContent).filter(t => /锁定|找脸|追踪/.test(t)).join(' | ');
    ok(/已锁定/.test(info), '头部追踪锁上了合成人脸', '实际：' + info.slice(0, 120));
    const dot = sheetBody.querySelector('.campreview__dot');
    ok(dot && dot.classList.contains('is-lock'), '预览窗上的追踪点被标成"已锁定"');
    ok(/偏左|偏右/.test(info), '估出了视线方向（眼动追踪在跑）', '实际：' + info.slice(0, 140));
    ok(errors.length === e0, '头部追踪循环没有抛异常', errors.slice(e0).join('\n      '));
  }
  await closeSheet();

  /* ---------- 视觉算法显微镜：七种算法逐个真跑 ---------- */
  await openByName('视觉算法显微镜');
  const camBtn = byText('打开摄像头');
  ok(!!camBtn, '显微镜有「打开摄像头」按钮');
  if (camBtn) {
    const e0 = errors.length;
    click(camBtn);
    await tick(40);
    pump(30);                   // 帧率/耗时统计每 700ms 刷一次，要推够帧数
    const box = sheetBody.querySelector('.camstart');
    ok(box && box.style.display === 'none', '摄像头成功后启动块收起');
    ok(/ms/.test(statByLabel('单帧算法') || ''), '统计里报出了单帧耗时（' + statByLabel('单帧算法') + '）');

    const algoBtns = btnsInBody().filter(b => /Sobel|Canny|K-means|卷积核|光流|肤色|浮雕/.test(b.textContent || ''));
    ok(algoBtns.length === 7, '列出了 7 种算法（实际 ' + algoBtns.length + ' 种）');
    algoBtns.forEach(b => {
      const e1 = errors.length;
      click(b);
      pump(6);
      ok(errors.length === e1, '算法「' + b.textContent.trim() + '」在真实帧上没抛异常',
         errors.slice(e1).join('\n      '));
    });
    ok(errors.length === e0, '七种算法跑完没有累积异常', errors.slice(e0).join('\n      '));

    // 冻结当前帧：参数变化要能看出来，而不是只能看实时画面
    if (byText('冻结当前帧')) {
      click(byText('冻结当前帧'));
      pump(6);
      ok(byText('冻结当前帧').classList.contains('chip--on'), '冻结当前帧生效');
    }
  }
  await closeSheet();

  /* ---------- 光笔涂鸦：前置 + 亮点追踪 ---------- */
  await openByName('光笔涂鸦');
  const lp = byText('打开前置摄像头');
  ok(!!lp, '光笔用的是前置摄像头');
  if (lp) {
    const e0 = errors.length;
    click(lp);
    await tick(40);
    pump(20);
    const conf = parseFloat(statByLabel('置信度'));
    ok(conf > 0, '亮点被追踪到了（置信度 ' + statByLabel('置信度') + '）');
    if (byText('追指定颜色')) {
      click(byText('追指定颜色'));
      pump(8);
      ok(errors.length === e0, '切到按颜色追踪后没抛异常', errors.slice(e0).join('\n      '));
    }
    if (byText('粒子云')) {
      click(byText('粒子云'));
      pump(10);
      ok(errors.length === e0, '粒子云模式没抛异常', errors.slice(e0).join('\n      '));
    }
  }
  await closeSheet();

  /* ---------- 实时学习机：采样 → 训练 → 预测 ---------- */
  await openByName('实时学习机');
  const cl = byText('打开摄像头');
  ok(!!cl, '学习机有「打开摄像头」按钮');
  if (cl) {
    const e0 = errors.length;
    click(cl);
    await tick(40);
    pump(6);

    const capA = byText('采 A'), capB = byText('采 B');
    ok(!!capA && !!capB, '有 A / B 两个采样按钮');
    if (capA && capB) {
      hold(capA, 'pointerdown');
      pump(30);
      hold(capA, 'pointerup');
      hold(capB, 'pointerdown');
      pump(30);
      hold(capB, 'pointerup');
      pump(20);

      const na = parseInt(statByLabel('A 样本'), 10);
      const nb = parseInt(statByLabel('B 样本'), 10);
      ok(na > 5, '按住「采 A」真的收到了样本（' + na + ' 个）');
      ok(nb > 5, '按住「采 B」真的收到了样本（' + nb + ' 个）');
      ok(parseInt(statByLabel('训练轮数'), 10) > 0,
         '采到样本后网络真的开始训练了（' + statByLabel('训练轮数') + ' 轮）');
      const acc = statByLabel('训练集准确率');
      ok(/%/.test(acc || ''), '报出了训练集准确率（' + acc + '）');

      const fills = Array.prototype.slice.call(sheetBody.querySelectorAll('.prob__bar i'));
      ok(fills.length === 3 && fills.some(f => parseFloat(f.style.width) > 0),
         '三类的预测概率条都更新了（' + fills.map(f => f.style.width).join(' / ') + '）');
    }
    ok(errors.length === e0, '学习机整轮没有抛异常', errors.slice(e0).join('\n      '));
  }
  await closeSheet();

  /* ---------- 声控实验室：麦克风 → 频谱 → 音高 → 拍手 ---------- */
  await openByName('声控实验室');
  const micBtn = byText('打开麦克风');
  ok(!!micBtn, '声控实验室有「打开麦克风」按钮');
  if (micBtn) {
    const e0 = errors.length;
    click(micBtn);
    await tick(700);            // Mic._probe 要采样 12 次 × 34ms
    pump(10);

    const box = sheetBody.querySelector('.camstart');
    ok(box && box.style.display === 'none', '麦克风连接成功后启动块收起');
    const noteTxt = [].slice.call(sheetBody.querySelectorAll('.note')).map(e => e.textContent).join(' ');
    ok(/已连接/.test(noteTxt), '状态栏报告已连接', '实际：' + noteTxt.slice(0, 100));
    ok(/running/.test(noteTxt), 'AudioContext 处于 running 状态（不是被 iOS 挂起的 suspended）',
       '实际：' + noteTxt.slice(0, 120));

    const meter = sheetBody.querySelector('.meter i');
    pump(6);
    ok(meter && parseFloat(meter.style.width) > 0,
       '电平条有反应（宽度 ' + (meter ? meter.style.width : '—') + '）');

    const noteEl = sheetBody.querySelectorAll('.challenge__n');
    const noteTxt2 = noteEl[0] ? noteEl[0].textContent : '';
    ok(/[A-G]#?-?\d/.test(noteTxt2), '音高检测出了音名（' + noteTxt2.trim() + '）');

    if (byText('诊断')) {
      click(byText('诊断'));
      await tick(2400);
      const diag = sheetBody.querySelector('.diag');
      const dt = diag ? diag.textContent : '';
      ok(/AudioContext/.test(dt), '诊断输出了每一项状态');
      ok(/✅/.test(dt), '诊断判定信号链路正常', '实际：' + dt.slice(0, 200));
    }
    ok(errors.length === e0, '声控实验室整轮没有抛异常', errors.slice(e0).join('\n      '));
  }
  await closeSheet();
}

/* ============================================================
   主流程
   ============================================================ */
async function main() {
  console.log('\n【页面结构】');
  ok(!!w.AI, 'window.AI 已就绪');
  ok(!!w.Sense, 'window.Sense 已就绪');
  ok(!!w.Vision, 'window.Vision 已就绪');
  ok(FEATURES.length >= 9, '注册了至少 9 个玩法（实际 ' + FEATURES.length + ' 个）');
  ok(cards.length === FEATURES.length,
     '每个玩法都渲染出了卡片（' + cards.length + ' / ' + FEATURES.length + '）');
  pump(6);

  await phaseDenied();
  await phaseLive();

  /* ---------- 快速开关面板 ----------
     关面板有一段 380ms 的退场动画，动画结束才真正清空内容。
     如果用户在这 380ms 内就点开了下一个玩法，而清理逻辑没做
     失效判断，新面板会被上一个的定时器清成一片空白。 */
  console.log('\n【快速开关面板】');
  {
    const sheetEl = w.document.getElementById('sheet');
    const a = cardByName('神经网络实验室');
    const b = cardByName('AI 读心猜拳');
    ok(!!a && !!b, '找到了用来做快速切换测试的两个玩法');
    if (a && b) {
      click(a);
      pump(4);
      click(sheetClose);            // 关掉，但不等退场动画走完
      click(b);                     // 立刻打开另一个
      pump(4);
      await tick(500);              // 让上一个的清理定时器过去
      pump(4);
      ok(!sheetEl.hidden, '快速切换时新面板没有被上一个的清理定时器关掉');
      ok(sheetBody.children.length > 0, '快速切换后新面板里的内容还在');
      ok(sheetBody.innerHTML.indexOf('启动失败') < 0, '快速切换后新面板正常渲染');
      await closeSheet();
    }
  }

  /* ---------- 清理 ---------- */
  console.log('\n【资源清理】');
  await tick(60);
  pump(2);
  ok(rafMap.size <= 2,
     '面板都关掉后只剩粒子背景在跑（当前 rAF 队列 ' + rafMap.size + ' 个）');

  /* ---------- 汇总 ---------- */
  console.log('\n【运行期异常汇总】');
  ok(errors.length === 0, '整轮测试没有任何运行期异常',
     errors.slice(0, 6).join('\n      '));

  console.log('\n' + '─'.repeat(50));
  if (fail) {
    console.log('失败项：');
    bad.forEach(b => console.log('  ✗ ' + b));
  }
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.log('\n测试本身崩了：' + ((e && e.stack) || e));
  process.exit(1);
});
