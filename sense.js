/* ============================================================
   sense.js · 传感器层（摄像头 / 麦克风 / 头部追踪）
   ------------------------------------------------------------
   纯前端，不联网、不上传。画面与声音只在设备内存里处理。

   分两半：
   - 纯函数（色相转换、肤色判定、连通域分割、音高换算）→ 可脱离浏览器测试
   - Camera / Mic / HeadTracker 类 → 需要真机
   ============================================================ */

(function (global) {
  'use strict';

  /* ============================================================
     颜色与判定（纯函数）
     ============================================================ */

  function rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const d = mx - mn;
    let h = 0;
    if (d !== 0) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = mx === 0 ? 0 : d / mx;
    return { h: h, s: s, v: mx };
  }

  function hsv2rgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
  }

  function hueDist(a, b) {
    let d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /* RGB ↔ YCbCr（肤色判定在 CbCr 空间更稳） */
  function toCbCr(r, g, b) {
    return {
      cb: 128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
      cr: 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
    };
  }

  /* 通用肤色判定（Kovac et al. + YCbCr 收紧） */
  function isSkin(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (!(r > 95 && g > 40 && b > 20 && (mx - mn) > 15 && Math.abs(r - g) > 15 && r > g && r > b)) {
      return false;
    }
    const c = toCbCr(r, g, b);
    return c.cb >= 77 && c.cb <= 127 && c.cr >= 133 && c.cr <= 173;
  }

  /**
   * 肤色连通域分割 —— 这是"头部跟不住"的核心修复。
   *
   * 旧做法是把全画面所有肤色像素求一个重心，背景里任何一点木色、手、
   * 墙纸都会把重心拽偏。这里改成：
   *   1. 粗略分格 → 每格判断是否肤色 → 连通域标记
   *   2. 只保留最大（且形状合理）的那一块
   *   3. 支持"自适应肤色模型"：锁定之后学习这个人真实的 CbCr 分布
   *   4. 支持搜索窗：只在上一帧附近找，丢失时自动放大窗口
   *
   * @param {object} img {data,width,height}
   * @param {object} opts {cell, sample, model, window:{x,y,r}, minCells, wantAll}
   * @returns {Array} 块列表，按像素数降序；坐标已归一化到 0..1
   */
  function skinBlobs(img, opts) {
    opts = opts || {};
    const d = img.data, w = img.width, h = img.height;
    const cell = opts.cell || 4;
    const sample = opts.sample || 2;
    const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
    const nCell = gw * gh;

    const cellHit = new Uint16Array(nCell);
    const cellTot = new Uint16Array(nCell);
    const win = opts.window || null;

    // 每个格子里抽样判断
    for (let cy = 0; cy < gh; cy++) {
      for (let cx = 0; cx < gw; cx++) {
        const x0 = cx * cell, y0 = cy * cell;
        const x1 = Math.min(w, x0 + cell), y1 = Math.min(h, y0 + cell);
        // 搜索窗：把窗口外的格子整体跳过（省掉大部分采样开销）
        if (win) {
          const nx = (x0 + cell / 2) / w, ny = (y0 + cell / 2) / h;
          if (Math.hypot(nx - win.x, ny - win.y) > win.r) continue;
        }
        let hit = 0, tot = 0;
        for (let y = y0; y < y1; y += sample) {
          for (let x = x0; x < x1; x += sample) {
            const i = (y * w + x) * 4;
            const r = d[i], g = d[i + 1], b = d[i + 2];
            tot++;
            if (matchSkin(r, g, b, opts.model)) hit++;
          }
        }
        const idx = cy * gw + cx;
        cellHit[idx] = hit;
        cellTot[idx] = tot;
      }
    }

    // 标记为肤色的格子
    const label = new Int32Array(nCell).fill(-1);
    const okCell = new Uint8Array(nCell);
    for (let i = 0; i < nCell; i++) {
      if (cellTot[i] > 0 && cellHit[i] / cellTot[i] >= 0.34) okCell[i] = 1;
    }

    // 连通域（4 邻域，用显式栈避免递归爆栈）
    const stack = new Int32Array(nCell);
    const blobs = [];
    let nextLabel = 0;
    for (let s = 0; s < nCell; s++) {
      if (!okCell[s] || label[s] >= 0) continue;
      const lab = nextLabel++;
      let sp = 0;
      stack[sp++] = s;
      label[s] = lab;
      const cells = [];
      while (sp > 0) {
        const cur = stack[--sp];
        cells.push(cur);
        const cx = cur % gw, cy = (cur / gw) | 0;
        if (cx > 0) { const n = cur - 1; if (okCell[n] && label[n] < 0) { label[n] = lab; stack[sp++] = n; } }
        if (cx < gw - 1) { const n = cur + 1; if (okCell[n] && label[n] < 0) { label[n] = lab; stack[sp++] = n; } }
        if (cy > 0) { const n = cur - gw; if (okCell[n] && label[n] < 0) { label[n] = lab; stack[sp++] = n; } }
        if (cy < gh - 1) { const n = cur + gw; if (okCell[n] && label[n] < 0) { label[n] = lab; stack[sp++] = n; } }
      }
      // 统计这一块的像素
      let sx = 0, sy = 0, n = 0;
      let minX = w, maxX = -1, minY = h, maxY = -1;
      let cbSum = 0, crSum = 0, cb2 = 0, cr2 = 0;
      for (let k = 0; k < cells.length; k++) {
        const ci = cells[k];
        const cx = (ci % gw) * cell, cy = ((ci / gw) | 0) * cell;
        const x0 = cx, y0 = cy;
        const x1 = Math.min(w, cx + cell), y1 = Math.min(h, cy + cell);
        for (let y = y0; y < y1; y += sample) {
          for (let x = x0; x < x1; x += sample) {
            const i = (y * w + x) * 4;
            const r = d[i], g = d[i + 1], b = d[i + 2];
            if (!matchSkin(r, g, b, opts.model)) continue;
            sx += x; sy += y; n++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            const c = toCbCr(r, g, b);
            cbSum += c.cb; crSum += c.cr; cb2 += c.cb * c.cb; cr2 += c.cr * c.cr;
          }
        }
      }
      if (n < 4) continue;
      const mx = cbSum / n, my = crSum / n;
      blobs.push({
        x: sx / n / w,
        y: sy / n / h,
        bw: (maxX - minX + 1) / w,
        bh: (maxY - minY + 1) / h,
        mass: n / ((w / sample) * (h / sample)),
        count: n,
        cb: mx, cr: my,
        cbSd: Math.sqrt(Math.max(1, cb2 / n - mx * mx)),
        crSd: Math.sqrt(Math.max(1, cr2 / n - my * my)),
        cells: cells.length
      });
    }

    const minCells = opts.minCells || 3;
    let list = blobs.filter(b => b.count >= 12 && (opts.wantAll ? true : b.cells >= minCells));
    list.sort((a, b) => b.count - a.count);
    return list;
  }

  /* 自适应模型：有了它之后，只认"这个人"的肤色，背景同色物体被排除 */
  function matchSkin(r, g, b, model) {
    if (!model) return isSkin(r, g, b);
    const c = toCbCr(r, g, b);
    const db = (c.cb - model.cb) / model.cbSd;
    const dr = (c.cr - model.cr) / model.crSd;
    if (db * db + dr * dr > 9) return false;      // 3 倍标准差
    // 再用宽松的通用规则兜一层，避免模型漂移到非人脸区域
    return r > 60 && r > b;
  }

  /* ============================================================
     头部追踪器：带搜索窗 + 自适应肤色模型 + 匀速预测
     ============================================================ */
  class HeadTracker {
    constructor(opts) {
      opts = opts || {};
      this.x = 0.5; this.y = 0.45; this.size = 0.3;
      this.vx = 0; this.vy = 0;
      this.model = null;
      this.conf = 0;
      this.lost = 999;          // 首次锁定要直接吸附，不能从默认位置慢慢挪
      this.winR = 0.42;
      this.hold = opts.hold || 10;         // 丢失多少帧之后退回全图搜索
    }

    reset() {
      this.model = null; this.conf = 0; this.lost = 99;
      this.x = 0.5; this.y = 0.45; this.vx = 0; this.vy = 0;
      this.winR = 0.42;
    }

    /**
     * @returns {{x,y,bw,bh,conf}|null} 归一化坐标
     */
    update(img) {
      // 用速度预测下一帧位置，降低高速移动时的滞后
      const px = Math.min(1.2, Math.max(-0.2, this.x + this.vx));
      const py = Math.min(1.2, Math.max(-0.2, this.y + this.vy));
      const useWin = this.lost <= this.hold;

      let blobs = skinBlobs(img, {
        cell: 4, sample: 2,
        model: this.model,
        window: useWin ? { x: px, y: py, r: this.winR } : null
      });

      // 窗口里找不到就放开搜索
      if (!blobs.length && useWin) {
        blobs = skinBlobs(img, { cell: 4, sample: 2, model: this.model, window: null });
      }

      // 挑形状最像脑袋的一块（宽高比合理 + 够大）
      let best = null, bestScore = 0;
      for (let i = 0; i < blobs.length; i++) {
        const b = blobs[i];
        const ar = b.bw / Math.max(1e-3, b.bh);
        if (ar < 0.42 || ar > 1.9) continue;
        if (b.mass < 0.012) continue;
        let score = b.count;
        if (useWin) {
          const dd = Math.hypot(b.x - px, b.y - py);
          score *= Math.max(0.25, 1 - dd * 1.6);     // 离预测位置越近越可信
        }
        if (best === null || score > bestScore) { best = b; bestScore = score; }
      }

      if (!best) {
        this.lost++;
        this.conf = Math.max(0, this.conf - 0.12);
        this.winR = Math.min(0.75, this.winR + 0.06);   // 越丢越扩大搜索
        if (this.lost > this.hold * 2) this.model = null;  // 久找不到就重置模型
        this.vx *= 0.6; this.vy *= 0.6;
        return null;
      }

      // 自适应更新肤色模型（只低速率吸收，避免被背景带跑）
      if (!this.model) {
        this.model = { cb: best.cb, cr: best.cr, cbSd: Math.max(5, best.cbSd), crSd: Math.max(5, best.crSd) };
      } else {
        const a = 0.06;
        this.model.cb += (best.cb - this.model.cb) * a;
        this.model.cr += (best.cr - this.model.cr) * a;
        this.model.cbSd += (Math.max(5, best.cbSd) - this.model.cbSd) * a;
        this.model.crSd += (Math.max(5, best.crSd) - this.model.crSd) * a;
      }

      // 匀速预测 + 平滑（既跟得上又不抖）。
      // 但"刚重新捕获"这一帧必须直接吸附 —— 否则会从上一个位置慢慢挪过去，
      // 用户第一眼看到的位置是错的。
      const mx = best.x, my = best.y;
      if (this.lost > this.hold) {
        this.x = mx; this.y = my;
        this.vx = 0; this.vy = 0;
      } else {
        const k = 0.42;
        const nx = px + (mx - px) * k;
        const ny = py + (my - py) * k;
        this.vx = (nx - this.x) * 0.55 + this.vx * 0.45;
        this.vy = (ny - this.y) * 0.55 + this.vy * 0.45;
        this.x = nx; this.y = ny;
      }
      this.size = best.bh;

      this.lost = 0;
      this.conf = Math.min(1, this.conf + 0.18);
      this.winR = Math.max(0.30, this.winR - 0.02);

      return { x: this.x, y: this.y, bw: best.bw, bh: best.bh, conf: this.conf };
    }
  }

  /**
   * 眼部区域估计：在脸框内找最暗的两团（眉毛/眼睛），估算视线水平偏移。
   * 说清楚：160×120 的前置画面上做不了真正的瞳孔追踪，
   * 这是"眼睛所在区域"的粗略估计，用于让人机交互更灵敏，不是精确视线。
   */
  function eyeRegion(img, box) {
    const d = img.data, w = img.width, h = img.height;
    if (!box) return null;

    // 只在脸框内侧找。旧版本取了整个上半部，
    // 结果脸圆之外的深色背景被当成"眼睛"，重心直接跑到画面外面去。
    const fullX0 = (box.x - box.bw / 2) * w;
    const fullX1 = (box.x + box.bw / 2) * w;
    const inset = (fullX1 - fullX0) * 0.18;
    const x0 = Math.max(0, Math.floor(fullX0 + inset));
    const x1 = Math.min(w, Math.ceil(fullX1 - inset));
    const y0 = Math.max(0, Math.floor((box.y - box.bh * 0.36) * h));
    const y1 = Math.min(h, Math.ceil((box.y - box.bh * 0.10) * h));
    const ww = x1 - x0, hh = y1 - y0;
    if (ww < 8 || hh < 4) return null;

    // 取这段区域里最暗的一小撮当"眼睛"，比按均值切更稳
    const g = new Float32Array(ww * hh);
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < ww; x++) {
        const i = ((y + y0) * w + (x + x0)) * 4;
        g[y * ww + x] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      }
    }
    const sorted = Float32Array.from(g).sort();
    const thr = sorted[Math.max(0, Math.floor(sorted.length * 0.14))];

    let lx = 0, ly = 0, ln = 0, rx = 0, ry = 0, rn = 0;
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < ww; x++) {
        const v = g[y * ww + x];
        if (v > thr) continue;
        const wt = thr - v + 1;
        if (x < ww / 2) { lx += x * wt; ly += y * wt; ln += wt; }
        else { rx += x * wt; ry += y * wt; rn += wt; }
      }
    }
    if (ln <= 0 || rn <= 0) return null;

    const eyeMidX = ((lx / ln) + (rx / rn)) / 2 / ww;   // 0..1，相对脸框内侧
    const eyeMidY = ((ly / ln) + (ry / rn)) / 2 / hh;
    return {
      x: (x0 + eyeMidX * ww) / w,
      y: (y0 + eyeMidY * hh) / h,
      // 视线水平/垂直偏移：-1 偏左/偏上，+1 偏右/偏下
      gazeX: Math.max(-1, Math.min(1, (eyeMidX - 0.5) * 3.4)),
      gazeY: Math.max(-1, Math.min(1, (eyeMidY - 0.5) * 3.0))
    };
  }

  /* ============================================================
     色相追踪 / 亮点追踪（光笔用）
     ============================================================ */
  function trackHue(img, targetHue, opts) {
    opts = opts || {};
    const d = img.data, w = img.width, h = img.height;
    const tol = opts.tol != null ? opts.tol : 26;
    const minS = opts.minS != null ? opts.minS : 0.35;
    const minV = opts.minV != null ? opts.minV : 0.30;
    const step = opts.step || 2;

    let sx = 0, sy = 0, n = 0, bestV = 0, bx = 0, by = 0, best = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const v = mx / 255;
        if (v < minV) continue;
        const s = mx === 0 ? 0 : (mx - mn) / mx;
        if (s < minS) continue;
        let hh = 0;
        const dd = mx - mn;
        if (dd !== 0) {
          if (mx === r) hh = ((g - b) / dd) % 6;
          else if (mx === g) hh = (b - r) / dd + 2;
          else hh = (r - g) / dd + 4;
          hh *= 60;
          if (hh < 0) hh += 360;
        }
        if (hueDist(hh, targetHue) > tol) continue;
        const weight = s * v;
        sx += x * weight; sy += y * weight; n += weight;
        if (v > bestV) bestV = v;
        const vig = v * s;
        if (vig > best) { best = vig; bx = x; by = y; }
      }
    }
    const minMass = opts.minMass || 6;
    if (n < minMass) return null;
    return {
      x: (sx / n) / w,
      y: (sy / n) / h,
      peak: { x: bx / w, y: by / h, v: bestV },
      mass: n / ((w * h) / (step * step))
    };
  }

  function trackBrightest(img, opts) {
    opts = opts || {};
    const d = img.data, w = img.width, h = img.height;
    const step = opts.step || 2;
    const floor = opts.floor != null ? opts.floor : 0.72;

    let maxV = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
        if (v > maxV) maxV = v;
      }
    }
    if (maxV < (opts.minPeak != null ? opts.minPeak : 0.62)) return null;

    const cut = maxV * floor;
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
        if (v < cut) continue;
        sx += x * v; sy += y * v; n += v;
      }
    }
    if (n < 1) return null;
    return { x: (sx / n) / w, y: (sy / n) / h, brightness: maxV, mass: n / ((w * h) / (step * step)) };
  }

  function autoPickHue(img, opts) {
    opts = opts || {};
    const d = img.data, w = img.width, h = img.height;
    const x0 = Math.floor(w * 0.25), x1 = Math.floor(w * 0.75);
    const y0 = Math.floor(h * 0.25), y1 = Math.floor(h * 0.75);
    const bins = new Float64Array(36);
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = (y * w + x) * 4;
        const c = rgb2hsv(d[i], d[i + 1], d[i + 2]);
        if (c.s < 0.35 || c.v < 0.25) continue;
        bins[Math.floor(c.h / 10) % 36] += c.s * c.v;
      }
    }
    let best = -1, bi = -1;
    for (let i = 0; i < 36; i++) if (bins[i] > best) { best = bins[i]; bi = i; }
    if (bi < 0 || best <= 0) return null;
    return bi * 10 + 5;
  }

  /* 把整帧降采样成小灰度图 —— 给"摄像头分类器"当神经网络输入 */
  function grayscaleSmall(img, gw, gh) {
    const d = img.data, w = img.width, h = img.height;
    const out = new Float32Array(gw * gh);
    const bx = w / gw, by = h / gh;
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let sum = 0, n = 0;
        const x0 = Math.floor(gx * bx), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * bx));
        const y0 = Math.floor(gy * by), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * by));
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
            n++;
          }
        }
        out[gy * gw + gx] = n ? (sum / n) / 255 : 0;
      }
    }
    return out;
  }

  /* 亮度均衡：抵消环境光变化，分类器才不会被"灯变亮了"骗到 */
  function normalizeGray(v) {
    let mean = 0;
    for (let i = 0; i < v.length; i++) mean += v[i];
    mean /= v.length;
    let sd = 0;
    for (let i = 0; i < v.length; i++) sd += (v[i] - mean) * (v[i] - mean);
    sd = Math.sqrt(sd / v.length) || 1;
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = Math.min(1, Math.max(0, (v[i] - mean) / (sd * 2) * 0.5 + 0.5));
    return out;
  }

  /* ============================================================
     音高
     ============================================================ */
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function freqToNote(f) {
    if (!f || f <= 0) return null;
    const midi = Math.round(69 + 12 * Math.log2(f / 440));
    const exact = 69 + 12 * Math.log2(f / 440);
    return {
      midi: midi,
      name: NOTE_NAMES[((midi % 12) + 12) % 12],
      octave: Math.floor(midi / 12) - 1,
      cents: Math.round((exact - midi) * 100)
    };
  }
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  /* ============================================================
     Camera
     ============================================================ */
  class Camera {
    constructor(opts) {
      opts = opts || {};
      this.facing = opts.facing || 'user';
      this.procW = opts.procW || 192;
      this.procH = opts.procH || 144;
      this.ready = false;
      this.stream = null;
      this.video = null;
      this.error = null;
      this.warn = null;
      this.frameAge = 0;
      this._cv = null;
      this._cx = null;
    }

    static supported() {
      return !!(global.navigator && global.navigator.mediaDevices &&
                global.navigator.mediaDevices.getUserMedia);
    }

    /* 必须在用户点击里调用（iOS 强制要求） */
    async start(videoEl) {
      if (!Camera.supported()) {
        this.error = '这个浏览器不支持调用摄像头';
        return { ok: false, error: this.error };
      }
      const v = videoEl;
      try {
        const stream = await global.navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: this.facing }, width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false
        });
        this.stream = stream;

        // 顺序很重要：先设属性再挂流，muted 必须在 play() 之前就为 true
        v.setAttribute('playsinline', 'true');
        v.setAttribute('webkit-playsinline', 'true');
        v.setAttribute('autoplay', 'true');
        v.muted = true;
        v.defaultMuted = true;
        v.controls = false;
        v.srcObject = stream;

        // 等真正的图像数据到位。旧版本把 play() 的错误吞掉，
        // 结果 play 失败时 grab() 一直返回 null，界面就是一片空白。
        const gotFrame = await waitForFrame(v, 4000);
        if (!gotFrame) {
          this.warn = '摄像头已授权，但一直没拿到画面。';
          this.error = null;
          this.video = v;
          this.ready = true;              // 允许继续尝试 grab
          return { ok: true, warn: this.warn };
        }

        this.video = v;
        this.ready = true;
        this.error = null;
        return { ok: true };
      } catch (e) {
        const map = {
          NotAllowedError: '摄像头权限被拒绝。到「设置 → Safari → 摄像头」允许，然后刷新页面',
          SecurityError: '被安全策略挡住（独立 App 模式下可能受限，改用 Safari 直接打开网址试试）',
          NotFoundError: '没有找到摄像头',
          NotReadableError: '摄像头被其他 App 占用了，先关掉再试',
          OverconstrainedError: '摄像头不支持请求的参数',
          AbortError: '启动被中断，再试一次'
        };
        this.error = map[e.name] || ((e.name || 'Error') + '：' + e.message);
        return { ok: false, error: this.error };
      }
    }

    stop() {
      if (this.stream) {
        try { this.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      }
      if (this.video) { try { this.video.srcObject = null; } catch (_) {} }
      this.stream = null;
      this.ready = false;
    }

    /* 画面真的在走吗（给界面显示"已连上/卡住"用） */
    tick() {
      if (!this.video) return 0;
      const t = this.video.currentTime || 0;
      const alive = t !== this._lastTime;
      this._lastTime = t;
      this.frameAge = alive ? 0 : this.frameAge + 1;
      return this.frameAge;
    }

    /* 抓一帧到小画布，按比例居中裁剪（避免拉变形导致追踪坐标偏移） */
    grab() {
      if (!this.ready || !this.video) return null;
      const v = this.video;
      if (!v.videoWidth || !v.videoHeight) return null;
      if (!this._cv) {
        this._cv = document.createElement('canvas');
        this._cv.width = this.procW;
        this._cv.height = this.procH;
        this._cx = this._cv.getContext('2d', { willReadFrequently: true });
      }
      const vw = v.videoWidth, vh = v.videoHeight;
      const tar = this.procW / this.procH;
      let sw = vw, sh = vh, sx = 0, sy = 0;
      if (vw / vh > tar) { sw = vh * tar; sx = (vw - sw) / 2; }
      else { sh = vw / tar; sy = (vh - sh) / 2; }
      try {
        this._cx.drawImage(v, sx, sy, sw, sh, 0, 0, this.procW, this.procH);
        return this._cx.getImageData(0, 0, this.procW, this.procH);
      } catch (_) { return null; }
    }
  }

  function waitForFrame(video, timeout) {
    if (video.readyState >= 2 && video.videoWidth) return Promise.resolve(true);
    return new Promise(resolve => {
      let done = false;
      const finish = ok => { if (!done) { done = true; cleanup(); resolve(ok); } };
      const onData = () => { if (video.videoWidth) finish(true); };
      const cleanup = () => {
        video.removeEventListener('loadeddata', onData);
        video.removeEventListener('canplay', onData);
        video.removeEventListener('playing', onData);
        clearTimeout(timer);
      };
      video.addEventListener('loadeddata', onData);
      video.addEventListener('canplay', onData);
      video.addEventListener('playing', onData);
      const timer = setTimeout(() => finish(false), timeout);
      // 主动尝试播放；失败也不静默吞掉，交给上面的超时判断
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    });
  }

  /* ============================================================
     Mic
     ============================================================ */
  class Mic {
    constructor(opts) {
      opts = opts || {};
      this.fftSize = opts.fftSize || 2048;
      this.decimate = opts.decimate || 4;
      this.ready = false;
      this.error = null;
      this.ctx = null;
      this.stream = null;
      this.analyser = null;
      this.freq = null;
      this.time = null;
      this.smoothLevel = 0;
      this._avgLevel = 0.02;
      this._lastOnset = 0;
      this.onsets = 0;
      this.peakLevel = 0;
      this.silentFrames = 0;
      this.lastRms = 0;
      this._lastLv = 0;
      this.lastNeed = 0;
      this.lastOnsetLevel = 0;
    }

    static supported() {
      return !!(global.navigator && global.navigator.mediaDevices &&
                global.navigator.mediaDevices.getUserMedia &&
                (global.AudioContext || global.webkitAudioContext));
    }

    /**
     * 关键：AudioContext 必须在用户手势里创建并 resume，
     * 不能等到 await getUserMedia 之后再 resume —— iOS 会拒绝，
     * 上下文一直是 suspended，analyser 全返回 0，
     * 表现就是"授权了但频谱/音量全是死的"。
     */
    async start() {
      if (!Mic.supported()) {
        this.error = '这个浏览器不支持麦克风';
        return { ok: false, error: this.error };
      }
      const AC = global.AudioContext || global.webkitAudioContext;
      try {
        // ① 同步创建 + 立刻 resume（仍在手势上下文里）
        if (!this.ctx) this.ctx = new AC();
        let resumeP = Promise.resolve();
        if (this.ctx.state === 'suspended') resumeP = this.ctx.resume();

        // ② 再申请权限
        let stream = null;
        try {
          stream = await global.navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          });
        } catch (e1) {
          // 有些设备不接受这些约束，退回最简要求
          if (e1 && (e1.name === 'OverconstrainedError' || e1.name === 'TypeError')) {
            stream = await global.navigator.mediaDevices.getUserMedia({ audio: true });
          } else throw e1;
        }
        this.stream = stream;

        await resumeP;

        // ③ 再接线
        const src = this.ctx.createMediaStreamSource(this.stream);
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = this.fftSize;
        this.analyser.smoothingTimeConstant = 0.55;
        src.connect(this.analyser);
        this.freq = new Uint8Array(this.analyser.frequencyBinCount);
        this.time = new Float32Array(this.fftSize);

        // ④ 再确认一次状态；有些设备创建后又会挂起
        if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (_) {} }

        // ⑤ 真正测一下有没有数据流过来 —— 不再"看起来成功"
        const alive = await this._probe();
        this.ready = true;
        this.error = null;
        return { ok: true, warn: alive ? null : '麦克风已连接，但收不到任何声音信号。检查系统静音键、音量，或换个 App 先确认麦克风本身是好的。', state: this.ctx.state };
      } catch (e) {
        const map = {
          NotAllowedError: '麦克风权限被拒绝。到「设置 → Safari → 麦克风」允许后刷新',
          SecurityError: '被安全策略挡住（独立 App 模式可能受限，用 Safari 直接打开试试）',
          NotFoundError: '没找到麦克风',
          NotReadableError: '麦克风被其他 App 占用'
        };
        this.error = map[e.name] || ((e.name || 'Error') + '：' + e.message);
        return { ok: false, error: this.error };
      }
    }

    /* 采样 400ms，看数据到底有没有在变 */
    _probe() {
      return new Promise(resolve => {
        let n = 0, maxV = 0, changes = 0, prev = -1;
        const iv = setInterval(() => {
          if (!this.analyser) { clearInterval(iv); resolve(false); return; }
          this.analyser.getByteFrequencyData(this.freq);
          let m = 0;
          for (let i = 0; i < this.freq.length; i += 8) if (this.freq[i] > m) m = this.freq[i];
          if (m > maxV) maxV = m;
          if (prev >= 0 && m !== prev) changes++;
          prev = m;
          n++;
          if (n >= 12) {
            clearInterval(iv);
            resolve(this.ctx.state === 'running' && changes > 0);
          }
        }, 34);
      });
    }

    stop() {
      if (this.stream) { try { this.stream.getTracks().forEach(t => t.stop()); } catch (_) {} }
      if (this.ctx) { try { this.ctx.close(); } catch (_) {} }
      this.stream = null; this.ctx = null; this.analyser = null; this.ready = false;
    }

    readSpectrum() {
      if (!this.ready) return null;
      this.analyser.getByteFrequencyData(this.freq);
      return this.freq;
    }

    level() {
      if (!this.ready) return 0;
      let rms = 0;
      if (this.analyser.getFloatTimeDomainData) {
        this.analyser.getFloatTimeDomainData(this.time);
        let s = 0;
        for (let i = 0; i < this.time.length; i++) s += this.time[i] * this.time[i];
        rms = Math.sqrt(s / this.time.length);
      } else {
        // 老 Safari 没有 getFloatTimeDomainData，用频域估个能量
        this.analyser.getByteFrequencyData(this.freq);
        let s = 0;
        for (let i = 0; i < this.freq.length; i++) s += this.freq[i];
        rms = (s / this.freq.length) / 900;
      }
      this.smoothLevel += (rms - this.smoothLevel) * 0.35;
      this.lastRms = rms;
      // 底噪只吸收"不像瞬态"的样本。
      // 旧版是无条件吸收，拍一次手就把阈值自己顶高一次，
      // 连拍几下之后再也检测不到 —— 表现就是"拍手功能完全没用"。
      this._floorGuard = this._floorGuard || 0;
      if (rms < this._avgLevel * 3 + 0.02) {
        this._avgLevel += (rms - this._avgLevel) * 0.02;
      }
      if (this.smoothLevel > this.peakLevel) this.peakLevel = this.smoothLevel;
      if (this.smoothLevel < 0.0015) this.silentFrames++; else this.silentFrames = 0;
      return Math.min(1, this.smoothLevel * 4);
    }

    pitch() {
      if (!this.ready || !this.time) return null;
      const n0 = this.fftSize;
      const dec = this.decimate;
      const n = Math.floor(n0 / dec);
      if (!this._dec) this._dec = new Float32Array(n);
      const dec2 = this._dec;
      const t = this.time;
      if (!this.analyser.getFloatTimeDomainData) return null;
      for (let i = 0; i < n; i++) dec2[i] = t[i * dec];
      const sr = this.ctx.sampleRate / dec;

      let rms = 0;
      for (let i = 0; i < n; i++) rms += dec2[i] * dec2[i];
      rms = Math.sqrt(rms / n);
      if (rms < 0.012) return null;

      const minLag = Math.max(2, Math.floor(sr / 1100));
      const maxLag = Math.min(n - 2, Math.floor(sr / 70));
      let bestLag = -1, best = 0;
      for (let lag = minLag; lag <= maxLag; lag++) {
        let c = 0;
        for (let i = 0; i < n - lag; i++) c += dec2[i] * dec2[i + lag];
        c /= (n - lag);
        if (c > best) { best = c; bestLag = lag; }
      }
      if (bestLag < 0 || best < rms * rms * 0.35) return null;
      return sr / bestLag;
    }

    /**
     * 检测一次瞬态起跳（拍手/敲桌/弹指）。
     * 阈值跟着底噪走，所以安静房间和嘈杂房间都能用；
     * 同时要求"明显高于上一帧"，避免持续的大噪声被当成连续拍手。
     * @returns {boolean} 这一帧是否判定为一次起跳
     */
    onset(nowMs, lvIn) {
      // lvIn：界面那一帧已经算过的电平。复用它可以避免同一帧里
      // 对平滑量做两次迭代（会让响应忽快忽慢）。
      const lv = lvIn != null ? lvIn : this.level();
      const floor = this._avgLevel;
      const need = Math.max(0.055, Math.min(0.45, floor * 7 + 0.03));
      const rising = lv > (this._lastLv || 0) + 0.035;
      this._lastLv = lv;
      this.lastNeed = need;
      if (lv > need && rising && nowMs - this._lastOnset > 130) {
        this._lastOnset = nowMs;
        this.onsets++;
        this.lastOnsetLevel = lv;
        return true;
      }
      return false;
    }

    /* 一次性诊断，用来判断"到底哪一环没通" */
    state() {
      return {
        ready: this.ready,
        ctx: this.ctx ? this.ctx.state : '未创建',
        sampleRate: this.ctx ? this.ctx.sampleRate : 0,
        fftSize: this.fftSize,
        bins: this.freq ? this.freq.length : 0,
        rms: this.lastRms || 0,
        level: this.smoothLevel,
        floor: this._avgLevel,
        need: this.lastNeed || 0,
        peak: this.peakLevel,
        onsets: this.onsets,
        silent: this.silentFrames
      };
    }
  }

  global.Sense = {
    rgb2hsv, hsv2rgb, hueDist, toCbCr, isSkin, matchSkin,
    skinBlobs, HeadTracker, eyeRegion,
    trackHue, trackBrightest, autoPickHue,
    grayscaleSmall, normalizeGray,
    freqToNote, midiToFreq, NOTE_NAMES,
    Camera, Mic
  };

})(typeof window !== 'undefined' ? window : globalThis);
