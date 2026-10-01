/* ============================================================
   vision.js · 图像结构分析（纯函数，可脱离浏览器测试）
   ------------------------------------------------------------
   回答一个问题：这张图里有哪些线，这些线围出了哪些平面区域？

   流程：
     灰度 → Sobel 梯度 → 非极大值抑制 → 双阈值 + 滞后连接
       → 霍夫变换找直线
       → 以边缘为墙做连通域分割 → 得到"平面区域"
       → 区域轮廓追踪 + 道格拉斯-普克简化 → 多边形

   全部本地计算，几十毫秒量级。
   ============================================================ */

(function (global) {
  'use strict';

  /* ---------------- 灰度 ---------------- */
  function toGray(img, w, h) {
    const d = img.data;
    const g = new Float32Array(w * h);
    for (let i = 0, p = 0; p < w * h; p++, i += 4) {
      g[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    }
    return g;
  }

  /* 3x3 高斯平滑，压掉噪点，边缘检测会干净很多 */
  function blur3(g, w, h) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const wt = (dx === 0 && dy === 0) ? 4 : ((dx === 0 || dy === 0) ? 2 : 1);
            s += g[ny * w + nx] * wt;
            n += wt;
          }
        }
        out[y * w + x] = s / n;
      }
    }
    return out;
  }

  /* ---------------- Sobel ---------------- */
  function sobel(g, w, h) {
    const mag = new Float32Array(w * h);
    const dir = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        const a = g[p - w - 1], b = g[p - w], c = g[p - w + 1];
        const d2 = g[p - 1], f = g[p + 1];
        const g2 = g[p + w - 1], hh = g[p + w], i2 = g[p + w + 1];
        const gx = (c + 2 * f + i2) - (a + 2 * d2 + g2);
        const gy = (g2 + 2 * hh + i2) - (a + 2 * b + c);
        mag[p] = Math.hypot(gx, gy);
        dir[p] = Math.atan2(gy, gx);
      }
    }
    return { mag: mag, dir: dir };
  }

  function percentile(sorted, q) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
    return sorted[idx];
  }

  /**
   * 边缘图：非极大值抑制 + 双阈值 + 滞后连接
   * @returns {Uint8Array} 0 或 1
   */
  function edgeMap(g, w, h, opts) {
    opts = opts || {};
    const sm = blur3(g, w, h);
    const s = sobel(sm, w, h);
    const mag = s.mag, dir = s.dir;

    // 非极大值抑制
    const nms = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        const m = mag[p];
        if (m <= 0) continue;
        let a = 0, ang = dir[p] * 180 / Math.PI;
        if (ang < 0) ang += 180;
        let n1, n2;
        if (ang < 22.5 || ang >= 157.5) { n1 = mag[p - 1]; n2 = mag[p + 1]; }
        else if (ang < 67.5) { n1 = mag[p - w - 1]; n2 = mag[p + w + 1]; }
        else if (ang < 112.5) { n1 = mag[p - w]; n2 = mag[p + w]; }
        else { n1 = mag[p - w + 1]; n2 = mag[p + w - 1]; }
        if (m >= n1 && m >= n2) nms[p] = m;
      }
    }

    // 阈值按"最弱边缘也要留下"的思路定，不能取分位数。
    // 用分位数踩过坑：一张图里如果有一处极强对比（比如黑压黄），
    // 90 分位会被那一处顶到最高值，其它正常边缘会被整片滤掉。
    // 改成相对最大幅值的比例阈值 + 绝对下限。
    let maxN = 0;
    for (let p = 0; p < w * h; p++) if (nms[p] > maxN) maxN = nms[p];
    const hiFrac = opts.hiFrac != null ? opts.hiFrac : 0.22;
    const loFrac = opts.loFrac != null ? opts.loFrac : 0.42;
    const hi = Math.max(opts.minHi != null ? opts.minHi : 11, maxN * hiFrac);
    const lo = Math.max(opts.minLo != null ? opts.minLo : 4.5, hi * loFrac);

    const edge = new Uint8Array(w * h);
    const stack = [];
    for (let p = 0; p < w * h; p++) if (nms[p] >= hi) { edge[p] = 1; stack.push(p); }
    // 滞后连接：只有和强边缘连通的弱边缘才保留
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (!edge[q] && nms[q] >= lo) { edge[q] = 1; stack.push(q); }
        }
      }
    }
    return edge;
  }

  /* ---------------- 霍夫直线 ---------------- */
  /**
   * @returns {Array<{x1,y1,x2,y2,theta,rho,votes,len}>} 按长度×票数排序
   */
  function houghLines(edge, w, h, opts) {
    opts = opts || {};
    const thetaSteps = opts.thetaSteps || 180;
    const rhoStep = opts.rhoStep || 2;
    const diag = Math.ceil(Math.hypot(w, h));
    const rhoBins = Math.ceil(diag * 2 / rhoStep) + 1;

    const cos = new Float32Array(thetaSteps), sin = new Float32Array(thetaSteps);
    for (let t = 0; t < thetaSteps; t++) {
      const a = (t * Math.PI) / thetaSteps;
      cos[t] = Math.cos(a); sin[t] = Math.sin(a);
    }

    // 收集边缘点
    const px = [], py = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (edge[y * w + x]) { px.push(x); py.push(y); }
      }
    }
    if (!px.length) return [];

    const acc = new Int32Array(thetaSteps * rhoBins);
    for (let k = 0; k < px.length; k++) {
      const x = px[k], y = py[k];
      for (let t = 0; t < thetaSteps; t++) {
        const r = x * cos[t] + y * sin[t];
        const bi = Math.round((r + diag) / rhoStep);
        if (bi < 0 || bi >= rhoBins) continue;
        acc[t * rhoBins + bi]++;
      }
    }

    // 找峰值（在累加器里做局部极大值抑制）
    const cand = [];
    const minVotes = opts.minVotes || Math.max(14, Math.round(Math.min(w, h) * 0.10));
    for (let t = 0; t < thetaSteps; t++) {
      for (let b = 0; b < rhoBins; b++) {
        const v = acc[t * rhoBins + b];
        if (v < minVotes) continue;
        let isMax = true;
        for (let dt = -2; dt <= 2 && isMax; dt++) {
          for (let db = -2; db <= 2; db++) {
            const tt = t + dt, bb = b + db;
            if (tt < 0 || bb < 0 || tt >= thetaSteps || bb >= rhoBins) continue;
            if (acc[tt * rhoBins + bb] > v) { isMax = false; break; }
          }
        }
        if (isMax) cand.push({ t: t, b: b, v: v });
      }
    }
    cand.sort((a, b) => b.v - a.v);

    // 把峰值还原成线段：挑出投票给这个峰值的边缘点，取两端
    const out = [];
    const maxLines = opts.maxLines || 28;
    for (let i = 0; i < cand.length && out.length < maxLines; i++) {
      const c = cand[i];
      const theta = (c.t * Math.PI) / thetaSteps;
      const rho = c.b * rhoStep - diag;
      const nx = Math.cos(theta), ny = Math.sin(theta);
      // 直线方向
      const dx = -ny, dy = nx;

      let minT = Infinity, maxT = -Infinity, n = 0;
      for (let k = 0; k < px.length; k++) {
        const x = px[k], y = py[k];
        const r = x * nx + y * ny;
        if (Math.abs(r - rho) > rhoStep * 1.2) continue;
        const tt = x * dx + y * dy;
        if (tt < minT) minT = tt;
        if (tt > maxT) maxT = tt;
        n++;
      }
      if (n < minVotes || !isFinite(minT)) continue;
      const len = maxT - minT;
      if (len < Math.min(w, h) * 0.12) continue;
      // 投影回直角坐标（基准点取直线在原点垂足）
      const ox = rho * nx, oy = rho * ny;
      out.push({
        x1: ox + dx * minT, y1: oy + dy * minT,
        x2: ox + dx * maxT, y2: oy + dy * maxT,
        theta: theta, rho: rho, votes: n, len: len
      });
    }
    out.sort((a, b) => (b.len * b.votes) - (a.len * a.votes));
    return out;
  }

  /* ---------------- 区域分割 ---------------- */
  /* 把边缘当"墙"，剩下的连通块就是被线围出来的平面 */

  function dilate(edge, w, h, r) {
    if (!r) return edge;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!edge[y * w + x]) continue;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            out[ny * w + nx] = 1;
          }
        }
      }
    }
    return out;
  }

  /**
   * @returns {Array<{area,cx,cy,color,contour,bounds}>} 按面积降序
   */
  function findRegions(edge, img, w, h, opts) {
    opts = opts || {};
    const wall = dilate(edge, w, h, opts.dilate != null ? opts.dilate : 1);
    const label = new Int32Array(w * h).fill(-1);
    const stack = new Int32Array(w * h);
    const regions = [];
    const d = img ? img.data : null;
    const minArea = opts.minArea || Math.max(80, (w * h) * 0.004);

    for (let s = 0; s < w * h; s++) {
      if (wall[s] || label[s] >= 0) continue;
      const lab = regions.length;
      let sp = 0;
      stack[sp++] = s;
      label[s] = lab;
      const pixels = [];
      let sumX = 0, sumY = 0, r = 0, g = 0, b = 0;
      let minX = w, maxX = -1, minY = h, maxY = -1;

      while (sp > 0) {
        const p = stack[--sp];
        pixels.push(p);
        const x = p % w, y = (p / w) | 0;
        sumX += x; sumY += y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (d) { const i = p * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        if (x > 0) { const q = p - 1; if (!wall[q] && label[q] < 0) { label[q] = lab; stack[sp++] = q; } }
        if (x < w - 1) { const q = p + 1; if (!wall[q] && label[q] < 0) { label[q] = lab; stack[sp++] = q; } }
        if (y > 0) { const q = p - w; if (!wall[q] && label[q] < 0) { label[q] = lab; stack[sp++] = q; } }
        if (y < h - 1) { const q = p + w; if (!wall[q] && label[q] < 0) { label[q] = lab; stack[sp++] = q; } }
      }

      const n = pixels.length;
      regions.push({
        label: lab,
        area: n,
        cx: sumX / n,
        cy: sumY / n,
        color: d ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [128, 128, 128],
        bounds: { x0: minX, y0: minY, x1: maxX, y1: maxY },
        pixels: pixels
      });
    }

    // 太小的丢掉（噪点）
    let list = regions.filter(r => r.area >= minArea);
    list.sort((a, b) => b.area - a.area);

    // 轮廓
    list.forEach(rg => {
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < rg.pixels.length; i++) mask[rg.pixels[i]] = 1;
      // 从最上、最左的像素开始描边
      let start = -1;
      for (let y = rg.bounds.y0; y <= rg.bounds.y1 && start < 0; y++) {
        for (let x = rg.bounds.x0; x <= rg.bounds.x1; x++) {
          if (mask[y * w + x]) { start = y * w + x; break; }
        }
      }
      rg.contour = start < 0 ? [] : traceContour(mask, w, h, start);
      rg.polygon = simplify(sgToXY(rg.contour, w, h), opts.eps != null ? opts.eps : 2.2);
      delete rg.pixels;
    });

    list = list.filter(rg => rg.polygon.length >= 3);
    const maxR = opts.maxRegions || 26;
    return list.slice(0, maxR);
  }

  function sgToXY(flat, w, h) {
    const out = [];
    for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
    return out;
  }

  /* 摩尔邻域轮廓追踪 */
  function traceContour(mask, w, h, startIdx) {
    const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h) ? mask[y * w + x] : 0;
    let cx = startIdx % w, cy = (startIdx / w) | 0;
    const sx = cx, sy = cy;
    const out = [];
    let dir = 4;                     // 初始回溯方向：西
    const maxSteps = Math.min(w * h, 20000);
    let guard = 0;

    while (guard++ < maxSteps) {
      out.push(cx, cy);
      let found = -1;
      for (let k = 0; k < 8; k++) {
        const dd = (dir + k) % 8;
        const nx = cx + N8[dd][0], ny = cy + N8[dd][1];
        if (at(nx, ny)) { found = dd; break; }
      }
      if (found < 0) break;                       // 孤立像素
      dir = (found + 5) % 8;                      // 下次从"来路"的下一格开始顺时针找
      cx += N8[found][0];
      cy += N8[found][1];
      if (cx === sx && cy === sy && out.length >= 16) break;
    }
    return out;
  }

  /* 道格拉斯-普克简化 */
  function simplify(pts, eps) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = 1; keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const seg = stack.pop();
      const i0 = seg[0], i1 = seg[1];
      if (i1 - i0 < 2) continue;
      const p0 = pts[i0], p1 = pts[i1];
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      const len = Math.hypot(dx, dy) || 1;
      let maxD = -1, maxI = -1;
      for (let i = i0 + 1; i < i1; i++) {
        const p = pts[i];
        const d = Math.abs((p[0] - p0[0]) * dy - (p[1] - p0[1]) * dx) / len;
        if (d > maxD) { maxD = d; maxI = i; }
      }
      if (maxD > eps) {
        keep[maxI] = 1;
        stack.push([i0, maxI]);
        stack.push([maxI, i1]);
      }
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }

  /**
   * 把区域列表变成 3D 浮雕面片
   * 每个区域 = 顶面多边形 + 沿轮廓挤出的一圈侧面
   * @param {Array} regions findRegions 的结果
   * @param {object} opts {mode:'bright'|'area'|'layer', height, eps}
   */
  function buildRelief(regions, opts) {
    opts = opts || {};
    const mode = opts.mode || 'bright';
    const maxH = opts.height != null ? opts.height : 0.85;
    const n = regions.length;
    if (!n) return { faces: [], bbox: { x0: 0, x1: 1, y0: 0, y1: 1 } };

    // 归一化到 [-1,1]
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    regions.forEach(r => {
      r.polygon.forEach(p => {
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      });
    });
    const cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0);
    const scale = 2 / Math.max(cw, ch);
    const ox = (x0 + x1) / 2, oy = (y0 + y1) / 2;

    const heights = regions.map((r, i) => {
      if (mode === 'bright') {
        const lum = (r.color[0] * 0.299 + r.color[1] * 0.587 + r.color[2] * 0.114) / 255;
        return 0.12 + lum * maxH;
      }
      if (mode === 'area') {
        const a = r.area / regions[0].area;
        return maxH * (1 - a) + 0.08;
      }
      // layer：面积越大越靠底层，小的浮在上面，像地形图
      return maxH * (1 - i / Math.max(1, n - 1)) * 0.85 + 0.08;
    });

    const faces = [];
    regions.forEach((r, i) => {
      const z = heights[i];
      const c = r.color;
      const pts = r.polygon.map(p => [
        (p[0] - ox) * scale,
        -(p[1] - oy) * scale,       // 图像 y 向下，世界 y 向上
        z
      ]);
      if (pts.length < 3) return;
      // 顶面：稍微提亮
      faces.push({
        pts: pts,
        color: [Math.min(255, c[0] * 1.15 + 26), Math.min(255, c[1] * 1.15 + 26), Math.min(255, c[2] * 1.15 + 26)],
        z: z, kind: 'top', region: i
      });
      // 侧面
      const base = 0;
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k], b = pts[(k + 1) % pts.length];
        const shade = 0.60;
        faces.push({
          pts: [[a[0], a[1], a[2]], [b[0], b[1], b[2]], [b[0], b[1], base], [a[0], a[1], base]],
          color: [Math.round(c[0] * shade), Math.round(c[1] * shade), Math.round(c[2] * shade)],
          z: z * 0.9, kind: 'side', region: i
        });
      }
    });

    return {
      faces: faces,
      bbox: { x0: (x0 - ox) * scale, x1: (x1 - ox) * scale, y0: -(y1 - oy) * scale, y1: -(y0 - oy) * scale },
      heights: heights
    };
  }

  global.Vision = {
    toGray, blur3, sobel, edgeMap, houghLines,
    findRegions, traceContour, simplify, dilate, buildRelief, percentile
  };

})(typeof window !== 'undefined' ? window : globalThis);
