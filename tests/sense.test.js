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
G('头部定位');

(function headTrack() {
  const W = 96, H = 72;
  const img = makeImg(W, H, [40, 45, 60]);
  // 在左上角放一个"脸"
  blob(img, 24, 20, 12, [208, 156, 128]);
  const r = S.skinCentroid(img, { step: 1 });
  ok(r !== null, '能检测到肤色块');
  if (r) {
    near(r.x, 0.25, 0.05, '重心 x ≈ 0.25（左）');
    near(r.y, 20 / 72, 0.06, '重心 y ≈ 0.28（上）');
    ok(r.mass > 0.02, '报道了肤色占比 ' + (r.mass * 100).toFixed(1) + '%');
  }

  // 移到右下角
  const img2 = makeImg(W, H, [40, 45, 60]);
  blob(img2, 72, 52, 12, [208, 156, 128]);
  const r2 = S.skinCentroid(img2, { step: 1 });
  ok(r2 !== null && r2.x > 0.6 && r2.y > 0.6, '移动到右下后重心跟着变（x=' +
     (r2 ? r2.x.toFixed(2) : '—') + ', y=' + (r2 ? r2.y.toFixed(2) : '—') + '）');

  // 没有肤色时应返回 null
  const img3 = makeImg(W, H, [30, 60, 120]);
  ok(S.skinCentroid(img3, { step: 1 }) === null, '画面里没有肤色时返回 null');
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
