/* ============================================================
   sense.js 纯函数测试
     node tests/sense.test.js

   摄像头本身在 Node 里跑不了，但"算的部分"必须先证明是对的 ——
   不然真机上调追踪会完全不知道是算法错了还是环境问题。
   ============================================================ */

require('../sense.js');
const S = globalThis.Sense;

let pass = 0, fail = 0;
function G(n) { console.log('\n【' + n + '】'); }
function ok(c, label, extra) {
  if (c) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '\n      ' + extra : '')); }
}
function eq(a, b, label) {
  if (a === b) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '\n      期望 ' + b + '，实际 ' + a); }
}
function near(a, b, tol, label) {
  if (Math.abs(a - b) <= tol) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '\n      期望 ' + b + ' ± ' + tol + '，实际 ' + a); }
}

/* 造一张假图，模拟 ImageData */
function makeImg(w, h, fill) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = fill[0]; d[i * 4 + 1] = fill[1]; d[i * 4 + 2] = fill[2]; d[i * 4 + 3] = 255;
  }
  return { data: d, width: w, height: h };
}
function blob(img, cx, cy, r, color) {
  const w = img.width, h = img.height, d = img.data;
  for (let y = Math.max(0, cy - r); y < Math.min(h, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x < Math.min(w, cx + r); x++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > r * r) continue;
      const i = (y * w + x) * 4;
      d[i] = color[0]; d[i + 1] = color[1]; d[i + 2] = color[2];
    }
  }
}

/* ============================================================ */
G('颜色空间');

(function hsv() {
  const red = S.rgb2hsv(255, 0, 0);
  near(red.h, 0, 1, '纯红色相 = 0');
  near(red.s, 1, 0.01, '纯红饱和度 = 1');
  near(red.v, 1, 0.01, '纯红明度 = 1');

  near(S.rgb2hsv(0, 255, 0).h, 120, 1, '纯绿色相 = 120');
  near(S.rgb2hsv(0, 0, 255).h, 240, 1, '纯蓝色相 = 240');
  near(S.rgb2hsv(128, 128, 128).s, 0, 0.01, '灰色饱和度为 0');

  // 往返转换
  let maxErr = 0;
  for (const c of [[255, 0, 0], [12, 200, 90], [200, 200, 40], [30, 30, 30], [250, 250, 250]]) {
    const hsv = S.rgb2hsv(c[0], c[1], c[2]);
    const back = S.hsv2rgb(hsv.h, hsv.s, hsv.v);
    maxErr = Math.max(maxErr, Math.abs(back.r - c[0]), Math.abs(back.g - c[1]), Math.abs(back.b - c[2]));
  }
  ok(maxErr <= 1, 'HSV 往返转换误差 ≤ 1（实际 ' + maxErr + '）');

  near(S.hueDist(350, 10), 20, 0.01, '色相环跨越 0° 时距离正确');
  near(S.hueDist(10, 200), 170, 0.01, '色相环对向距离正确');
})();

/* ============================================================ */
G('肤色判定');

(function skin() {
  ok(S.isSkin(205, 155, 125), '常见肤色判为皮肤');
  ok(S.isSkin(240, 200, 190), '偏白肤色判为皮肤');
  ok(!S.isSkin(128, 128, 128), '灰色不是皮肤');
  ok(!S.isSkin(255, 0, 0), '纯红不是皮肤');
  ok(!S.isSkin(0, 0, 255), '纯蓝不是皮肤');
  ok(!S.isSkin(255, 165, 0), '橙色不是皮肤');
  ok(!S.isSkin(0, 0, 0), '纯黑不是皮肤');
  ok(!S.isSkin(255, 255, 255), '纯白不是皮肤');
})();

/* ============================================================ */
G('肤色连通域');

(function blobs() {
  const W = 96, H = 72;
  const img = makeImg(W, H, [40, 45, 60]);
  blob(img, 24, 20, 12, [208, 156, 128]);

  const list = S.skinBlobs(img, { cell: 4, sample: 2 });
  ok(list.length === 1, '画面里只有一块肤色时返回 1 个连通域');
  if (list.length) {
    near(list[0].x, 0.25, 0.05, '连通域重心 x ≈ 0.25');
    near(list[0].y, 20 / 72, 0.07, '连通域重心 y ≈ 0.28');
    ok(list[0].bw > 0.15 && list[0].bh > 0.15, '包围盒尺寸合理');
    ok(list[0].cb > 60 && list[0].cb < 140, '回报了 Cb 均值 ' + list[0].cb.toFixed(1));
  }

  // 两块肤色：应按像素数排序，最大的在前
  const img2 = makeImg(W, H, [40, 45, 60]);
  blob(img2, 20, 18, 14, [208, 156, 128]);
  blob(img2, 78, 56, 7, [200, 150, 125]);
  const l2 = S.skinBlobs(img2, { cell: 4, sample: 2 });
  ok(l2.length >= 2, '两块肤色被分成两个连通域（实际 ' + l2.length + ' 个）');
  if (l2.length >= 2) {
    ok(l2[0].count > l2[1].count, '按像素数从大到小排序');
    ok(Math.abs(l2[0].x - 20 / 96) < 0.08, '最大的一块是左边那个大的');
  }

  // 没有肤色
  ok(S.skinBlobs(makeImg(W, H, [30, 60, 120]), { cell: 4, sample: 2 }).length === 0,
     '没有肤色时返回空数组');

  // 搜索窗能把远处的干扰排除掉
  const l3 = S.skinBlobs(img2, { cell: 4, sample: 2, window: { x: 0.2, y: 0.25, r: 0.25 } });
  ok(l3.length === 1, '限定搜索窗后只剩脸那一块（干扰被排除）');
})();

/* ============================================================ */
G('头部追踪器');

(function trackerLock() {
  const W = 96, H = 72;
  const t = new S.HeadTracker();

  // 第一帧：脸在左上
  const f1 = makeImg(W, H, [40, 45, 60]);
  blob(f1, 30, 24, 13, [208, 156, 128]);
  const r1 = t.update(f1);
  ok(r1 !== null, '第一帧就能锁定');
  if (r1) {
    near(r1.x, 30 / 96, 0.09, '锁定位置 x 正确');
    ok(r1.conf > 0, '置信度开始累积（' + r1.conf.toFixed(2) + '）');
  }

  // 连续移动，追踪器应该跟上去
  let last = r1;
  for (let k = 1; k <= 8; k++) {
    const f = makeImg(W, H, [40, 45, 60]);
    blob(f, 30 + k * 4, 24 + k * 2, 13, [208, 156, 128]);
    last = t.update(f);
    if (!last) break;
  }
  ok(last !== null, '移动过程中没有跟丢');
  if (last) {
    near(last.x, (30 + 8 * 4) / 96, 0.14, '跟到了新位置 x');
    ok(last.conf > 0.3, '持续锁定时置信度上升（' + last.conf.toFixed(2) + '）');
  }
})();

(function trackerRejectsDistractor() {
  const W = 96, H = 72;
  const t = new S.HeadTracker();

  // 先在中间锁定一张脸
  for (let i = 0; i < 6; i++) {
    const f = makeImg(W, H, [40, 45, 60]);
    blob(f, 48, 34, 13, [208, 156, 128]);
    t.update(f);
  }
  const before = { x: t.x, y: t.y };

  // 右下角突然出现一块很大的"肤色"干扰（比如木桌、手）
  const f2 = makeImg(W, H, [40, 45, 60]);
  blob(f2, 48, 34, 13, [208, 156, 128]);
  blob(f2, 84, 62, 16, [206, 152, 126]);
  const r = t.update(f2);

  ok(r !== null, '有干扰时依然锁定着目标');
  if (r) {
    near(r.x, before.x, 0.10, '重心没有被右下角的干扰拽走（x 保持）');
    near(r.y, before.y, 0.12, '重心没有被拽走（y 保持）');
    ok(r.x < 0.7, '没有跳到干扰所在的位置');
  }
})();

(function trackerSelfHeal() {
  const W = 96, H = 72;
  const t = new S.HeadTracker();
  // 一开始没有脸
  const empty = makeImg(W, H, [40, 45, 60]);
  for (let i = 0; i < 5; i++) ok(t.update(empty) === null, i === 0 ? '没有脸时返回 null' : '仍然返回 null');
  ok(t.lost > 0, '记录了丢失帧数');

  // 脸出现后应该能重新锁定
  const f = makeImg(W, H, [40, 45, 60]);
  blob(f, 60, 40, 13, [208, 156, 128]);
  const r = t.update(f);
  ok(r !== null, '脸出现后能重新锁定');
  ok(t.lost === 0, '丢失计数被清零');
})();

(function eyeRegionTest() {
  const W = 96, H = 72;
  const img = makeImg(W, H, [40, 45, 60]);
  blob(img, 48, 34, 14, [208, 156, 128]);
  // 在脸框上半部画两个暗点当眼睛
  blob(img, 43, 27, 2, [40, 32, 28]);
  blob(img, 53, 27, 2, [40, 32, 28]);

  const box = { x: 48 / 96, y: 34 / 72, bw: 28 / 96, bh: 28 / 72 };
  const e = S.eyeRegion(img, box);
  ok(e !== null, '能估计出眼睛区域');
  if (e) {
    near(e.y, 27 / 72, 0.10, '眼睛行位置正确');
    ok(Math.abs(e.gazeX) < 1.01 && Math.abs(e.gazeY) < 1.01, '视线偏移归一化在 -1..1 内');
  }
  ok(S.eyeRegion(img, null) === null, '没有脸框时返回 null');
})();

/* ============================================================ */
G('神经网络输入预处理');

(function graySmall() {
  const W = 32, H = 32;
  const img = makeImg(W, H, [0, 0, 0]);
  blob(img, 16, 16, 8, [255, 255, 255]);
  const g = S.grayscaleSmall(img, 8, 8);
  eq(g.length, 64, '降采样到 8x8 = 64 维');
  let allIn = true;
  for (let i = 0; i < g.length; i++) if (g[i] < 0 || g[i] > 1) allIn = false;
  ok(allIn, '所有取值都在 0..1');
  const center = g[3 * 8 + 3] + g[3 * 8 + 4] + g[4 * 8 + 3] + g[4 * 8 + 4];
  const corner = g[0] + g[7] + g[56] + g[63];
  ok(center > corner, '中间亮块比四角亮');

  const n = S.normalizeGray(g);
  eq(n.length, 64, '亮度均衡后维度不变');
  let sum = 0;
  for (let i = 0; i < n.length; i++) sum += n[i];
  ok(sum / n.length > 0.2 && sum / n.length < 0.8, '均衡后均值落在中间区间');
})();

/* ============================================================ */
G('色相追踪');

(function hueTrack() {
  const W = 96, H = 72;
  const img = makeImg(W, H, [45, 48, 62]);
  blob(img, 70, 50, 9, [220, 40, 40]);          // 红色物体
  const r = S.trackHue(img, 0, { step: 1 });
  ok(r !== null, '能追踪到红色物体');
  if (r) {
    near(r.x, 70 / 96, 0.06, '追踪位置 x 正确');
    near(r.y, 50 / 72, 0.08, '追踪位置 y 正确');
  }

  // 目标换成绿色，就该找不到
  ok(S.trackHue(img, 120, { step: 1 }) === null, '找绿色时红色物体不干扰');

  const img2 = makeImg(W, H, [45, 48, 62]);
  blob(img2, 30, 24, 9, [30, 210, 60]);         // 绿色物体
  const g = S.trackHue(img2, 120, { step: 1 });
  ok(g !== null && Math.abs(g.x - 30 / 96) < 0.06, '换成绿色物体后按绿色能追到');
})();

/* ============================================================ */
G('亮点追踪');

(function bright() {
  const W = 96, H = 72;
  const img = makeImg(W, H, [20, 22, 30]);
  blob(img, 60, 18, 5, [255, 255, 255]);        // 一个亮斑
  const r = S.trackBrightest(img, { step: 1 });
  ok(r !== null, '能追踪到亮点');
  if (r) {
    near(r.x, 60 / 96, 0.07, '亮点位置 x 正确');
    near(r.y, 18 / 72, 0.09, '亮点位置 y 正确');
    ok(r.brightness > 0.9, '报到亮度 ' + r.brightness.toFixed(2));
  }

  const dark = makeImg(W, H, [25, 26, 30]);
  ok(S.trackBrightest(dark, { step: 1 }) === null, '全暗画面不会误报亮点');
})();

/* ============================================================ */
G('自动取色');

(function autoHue() {
  const W = 120, H = 90;
  const img = makeImg(W, H, [120, 120, 120]);
  blob(img, 60, 45, 22, [200, 180, 30]);        // 黄色物体
  const h = S.autoPickHue(img);
  ok(h !== null, '能从中心区域取到颜色');
  ok(h !== null && S.hueDist(h, 50) < 22, '取到的是黄色系（hue=' + h + '）');

  const gray = makeImg(W, H, [128, 128, 128]);
  ok(S.autoPickHue(gray) === null, '全灰画面取不到颜色（返回 null）');
})();

/* ============================================================ */
G('音高换算');

(function pitch() {
  const a4 = S.freqToNote(440);
  ok(a4 && a4.name === 'A' && a4.octave === 4, '440Hz → A4');
  const c4 = S.freqToNote(261.6256);
  ok(c4 && c4.name === 'C' && c4.octave === 4, '261.63Hz → C4');
  const a3 = S.freqToNote(220);
  ok(a3 && a3.name === 'A' && a3.octave === 3, '220Hz → A3');
  ok(S.freqToNote(0) === null, '0Hz 返回 null');

  near(S.midiToFreq(69), 440, 0.01, 'midi 69 → 440Hz');
  near(S.midiToFreq(60), 261.6256, 0.01, 'midi 60 → 261.63Hz');

  const sharp = S.freqToNote(466.16);
  ok(sharp && sharp.name === 'A#' && Math.abs(sharp.cents) <= 5, '466.16Hz → 升 A');
})();

/* ============================================================ */
G('环境能力探测');

(function caps() {
  ok(typeof S.Camera.supported() === 'boolean', 'Camera.supported() 可安全调用');
  ok(typeof S.Mic.supported() === 'boolean', 'Mic.supported() 可安全调用');
  const c = new S.Camera();
  ok(c.ready === false, '新建摄像头对象默认未就绪');
  ok(c.grab() === null, '未启动时 grab() 返回 null 而不是抛异常');
  c.stop();
  ok(true, 'stop() 在未启动时调用不报错');
})();

console.log('\n' + '─'.repeat(50));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
