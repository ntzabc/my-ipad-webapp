/* ============================================================
   vision.js 测试
     node tests/vision.test.js

   图像结构分析是这一版"图片转 3D"的地基。
   线条找错了、区域分错了，后面的 3D 就是错的，所以必须验证。
   用合成图片测：正确答案是我们自己画上去的，可以精确断言。
   ============================================================ */

require('../vision.js');
const V = globalThis.Vision;

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

function makeImg(w, h, fill) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = fill[0]; d[i * 4 + 1] = fill[1]; d[i * 4 + 2] = fill[2]; d[i * 4 + 3] = 255;
  }
  return { data: d, width: w, height: h };
}
function rect(img, x0, y0, x1, y1, c) {
  const w = img.width, h = img.height, d = img.data;
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      const i = (y * w + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
    }
  }
}

/* ============================================================ */
G('灰度与边缘');

(function grayTest() {
  const img = makeImg(16, 16, [255, 255, 255]);
  rect(img, 8, 0, 16, 16, [0, 0, 0]);
  const g = V.toGray(img, 16, 16);
  eq(g.length, 256, '灰度图维度正确');
  eq(g[2], 255, '左侧是白的');
  eq(g[2 + 10], 0, '右侧是黑的');
})();

(function edgeTest() {
  const W = 60, H = 60;
  const img = makeImg(W, H, [245, 245, 245]);
  rect(img, 30, 0, 33, H, [10, 10, 10]);        // 一条竖黑带
  const g = V.toGray(img, W, H);
  const e = V.edgeMap(g, W, H);

  let count = 0;
  let onLeftEdge = 0, stray = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!e[y * W + x]) continue;
      count++;
      // 竖带的两侧才是边缘
      if (x >= 28 && x <= 34) onLeftEdge++;
      else if (x < 20 || x > 42) stray++;
    }
  }
  ok(count > 40, '检测到边缘像素（' + count + ' 个）');
  ok(onLeftEdge / count > 0.55, '大部分边缘集中在竖带两侧（' + Math.round(onLeftEdge / count * 100) + '%）');
  ok(stray < count * 0.12, '平坦区域几乎没有误报（误报 ' + stray + ' 个）');
})();

(function blankTest() {
  const W = 40, H = 40;
  const e = V.edgeMap(V.toGray(makeImg(W, H, [128, 128, 128]), W, H), W, H);
  let n = 0;
  for (let i = 0; i < W * H; i++) if (e[i]) n++;
  ok(n === 0, '纯色图不该有任何边缘（实际 ' + n + ' 个）');
})();

/* ============================================================ */
G('直线检测');

(function houghTest() {
  const W = 120, H = 90;
  const img = makeImg(W, H, [250, 250, 250]);
  // 一条竖线 x=40（竖线在 theta≈0 处出现），一条横线 y=60（在 theta≈90° 处）
  rect(img, 39, 5, 41, H - 5, [0, 0, 0]);
  rect(img, 5, 59, W - 5, 61, [0, 0, 0]);

  const e = V.edgeMap(V.toGray(img, W, H), W, H);
  const lines = V.houghLines(e, W, H, {});

  ok(lines.length >= 2, '检测到至少两条直线（实际 ' + lines.length + ' 条）');

  const deg = l => (l.theta * 180 / Math.PI) % 180;
  let hasVert = false, hasHorz = false;
  lines.forEach(l => {
    const a = deg(l);
    if (a < 12 || a > 168) hasVert = true;
    if (Math.abs(a - 90) < 12) hasHorz = true;
  });
  ok(hasVert, '找到了竖直方向的那条（theta ≈ 0°）');
  ok(hasHorz, '找到了水平方向的那条（theta ≈ 90°）');

  // 线段的长度应该接近真实长度
  const longest = lines[0];
  ok(longest.len > Math.min(W, H) * 0.5 || longest.votes > 80,
     '最长的一条长度合理（' + Math.round(longest.len) + 'px）');

  // 纯色图不该找出线
  const blank = V.houghLines(V.edgeMap(V.toGray(makeImg(W, H, [200, 200, 200]), W, H), W, H), W, H, {});
  eq(blank.length, 0, '纯色图检测不出任何直线');
})();

/* ============================================================ */
G('平面区域分割');

(function regionTest() {
  const W = 120, H = 90;
  // 四个象限涂四种颜色，中间用黑十字隔开
  const img = makeImg(W, H, [255, 255, 255]);
  rect(img, 0, 0, 60, 45, [220, 60, 60]);       // 左上 红
  rect(img, 60, 0, W, 45, [60, 200, 90]);       // 右上 绿
  rect(img, 0, 45, 60, H, [70, 110, 230]);      // 左下 蓝
  rect(img, 60, 45, W, H, [235, 200, 70]);      // 右下 黄
  rect(img, 58, 0, 62, H, [0, 0, 0]);           // 竖黑线
  rect(img, 0, 43, W, 47, [0, 0, 0]);           // 横黑线

  const e = V.edgeMap(V.toGray(img, W, H), W, H);
  const regions = V.findRegions(e, img, W, H, { minArea: 150, eps: 2.5 });

  ok(regions.length >= 4, '黑十字把画面切成至少 4 块（实际 ' + regions.length + ' 块）');

  // 找到四个颜色对应的区域
  const names = ['红', '绿', '蓝', '黄'];
  const wants = [[220, 60, 60], [60, 200, 90], [70, 110, 230], [235, 200, 70]];
  wants.forEach((want, i) => {
    let best = null, bestD = Infinity;
    regions.forEach(r => {
      const d = Math.hypot(r.color[0] - want[0], r.color[1] - want[1], r.color[2] - want[2]);
      if (d < bestD) { bestD = d; best = r; }
    });
    ok(best && bestD < 60, '找到了' + names[i] + '色区域，且颜色接近（偏差 ' + Math.round(bestD) + '）');
  });

  // 红色应该在左上
  const red = regions.reduce((a, b) => {
    const da = Math.hypot(a.color[0] - 220, a.color[1] - 60, a.color[2] - 60);
    const db = Math.hypot(b.color[0] - 220, b.color[1] - 60, b.color[2] - 60);
    return db < da ? b : a;
  });
  ok(red.cx < W / 2 && red.cy < H / 2, '红色区域的重心确实在左上象限');

  // 每个区域都该有多边形，而且顶点数合理
  ok(regions.every(r => r.polygon.length >= 3), '每个区域都得到了至少 3 个顶点的多边形');
  const avgVerts = regions.reduce((s, r) => s + r.polygon.length, 0) / regions.length;
  ok(avgVerts > 3 && avgVerts < 60, '多边形顶点数在合理范围（平均 ' + avgVerts.toFixed(1) + ' 个）');

  // 太小的区域应被过滤
  const strict = V.findRegions(e, img, W, H, { minArea: 5000 });
  ok(strict.length <= regions.length, '提高最小面积阈值后区域数不增加');
})();

/* ============================================================ */
G('轮廓与简化');

(function contourTest() {
  const W = 40, H = 40;
  const mask = new Uint8Array(W * H);
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) mask[y * W + x] = 1;
  const c = V.traceContour(mask, W, H, 10 * W + 10);
  ok(c.length >= 16, '描出了正方形的轮廓（' + (c.length / 2) + ' 个点）');
  let inBounds = true;
  for (let i = 0; i < c.length; i += 2) {
    if (c[i] < 10 || c[i] > 29 || c[i + 1] < 10 || c[i + 1] > 29) inBounds = false;
  }
  ok(inBounds, '轮廓点都在正方形范围内');
})();

(function simplifyTest() {
  // 一条直线上的 50 个点，简化后只剩两个端点
  const line = [];
  for (let i = 0; i < 50; i++) line.push([i, i * 2]);
  const s = V.simplify(line, 1.0);
  eq(s.length, 2, '直线上的稠密点被化简成 2 个端点');

  // 带拐角的折线，拐角必须保留
  const bend = [];
  for (let i = 0; i <= 20; i++) bend.push([i, 0]);
  for (let i = 1; i <= 20; i++) bend.push([20, i]);
  const s2 = V.simplify(bend, 1.0);
  ok(s2.length >= 3 && s2.length <= 5, '带拐角的折线保留了拐点（' + s2.length + ' 个点）');
  ok(s2.some(p => Math.abs(p[0] - 20) < 0.01 && Math.abs(p[1]) < 0.01), '拐角点被保留');

  eq(V.simplify([[0, 0], [1, 1]], 1).length, 2, '少于 3 个点时原样返回');
})();

/* ============================================================ */
G('3D 浮雕生成');

(function reliefTest() {
  const W = 120, H = 90;
  const img = makeImg(W, H, [255, 255, 255]);
  rect(img, 0, 0, 60, 45, [230, 80, 80]);
  rect(img, 60, 0, W, 45, [80, 210, 110]);
  rect(img, 0, 45, 60, H, [90, 130, 240]);
  rect(img, 60, 45, W, H, [240, 210, 90]);
  rect(img, 58, 0, 62, H, [0, 0, 0]);
  rect(img, 0, 43, W, 47, [0, 0, 0]);

  const e = V.edgeMap(V.toGray(img, W, H), W, H);
  const regions = V.findRegions(e, img, W, H, { minArea: 150 });

  ['bright', 'area', 'layer'].forEach(mode => {
    const relief = V.buildRelief(regions, { mode: mode, height: 0.8 });
    ok(relief.faces.length > 0, mode + ' 模式生成了面片（' + relief.faces.length + ' 个）');
    let finite = true, zOk = true;
    relief.faces.forEach(f => {
      f.pts.forEach(p => {
        if (!isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2])) finite = false;
        if (p[2] < -1e-6) zOk = false;
      });
    });
    ok(finite, mode + ' 模式的所有顶点坐标都是有限数');
    ok(zOk, mode + ' 模式的顶点高度都非负');

    const xs = relief.faces.flatMap(f => f.pts.map(p => p[0]));
    const maxAbs = Math.max.apply(null, xs.map(Math.abs));
    ok(maxAbs <= 1.6, mode + ' 模式横向坐标在合理范围（最大 ' + maxAbs.toFixed(2) + '）');
  });

  // 每个区域都应该有顶面 + 一圈侧面
  const relief = V.buildRelief(regions, {});
  const tops = relief.faces.filter(f => f.kind === 'top').length;
  const sides = relief.faces.filter(f => f.kind === 'side').length;
  eq(tops, regions.length, '每个区域都有一个顶面');
  ok(sides >= regions.length * 3, '每个区域都有侧面挤出（共 ' + sides + ' 个）');

  eq(V.buildRelief([], {}).faces.length, 0, '没有区域时安全返回空');
})();

/* ============================================================ */
G('鲁棒性');

(function robust() {
  const W = 32, H = 32;
  ok(V.houghLines(new Uint8Array(W * H), W, H, {}).length === 0, '空边缘图不报错');
  ok(V.findRegions(new Uint8Array(W * H), null, W, H, {}).length === 1,
     '没有边缘时整张图是一块区域');
  const e = V.edgeMap(V.toGray(makeImg(3, 3, [100, 100, 100]), 3, 3), 3, 3);
  eq(e.length, 9, '极小的图也能处理');
})();

console.log('\n' + '─'.repeat(50));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
