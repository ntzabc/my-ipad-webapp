/* ============================================================
   ai.js · 算法层
   ------------------------------------------------------------
   全部是从零手写的纯 JS，不依赖任何第三方库、不联网。
   这里只有算法和数据结构，不碰 DOM —— 所以能脱离浏览器单独测试。
   跑测试：node tests/ai.test.js
   ============================================================ */

(function (global) {
  'use strict';

  /* ============================================================
     0. 可复现随机数（测试要确定性）
     ============================================================ */
  function makeRng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 高斯噪声（Box-Muller）
  function gauss(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  const sigmoid = z => 1 / (1 + Math.exp(-z));

  /* ============================================================
     1. 多层感知机 —— 手写前向 + 反向传播
     ============================================================ */
  class MLP {
    /**
     * @param {number[]} sizes 每层神经元数，如 [2,8,8,1]
     * @param {function} rand 随机源
     */
    constructor(sizes, rand) {
      this.sizes = sizes.slice();
      this.rand = rand || Math.random;
      const L = sizes.length;

      this.W = [];   // W[l][j*nin + i] 表示第 l 层第 i 个 → 第 l+1 层第 j 个
      this.b = [];
      for (let l = 1; l < L; l++) {
        const nin = sizes[l - 1], nout = sizes[l];
        const w = new Float64Array(nin * nout);
        const scale = Math.sqrt(1 / nin);       // Xavier，配 tanh
        for (let i = 0; i < w.length; i++) w[i] = (this.rand() * 2 - 1) * scale;
        this.W.push(w);
        this.b.push(new Float64Array(nout));
      }

      // 复用缓冲，避免每帧产生垃圾（这是不掉帧的关键）
      const maxN = Math.max.apply(null, sizes);
      this.acts = sizes.map(s => new Float64Array(s));
      this.dW = this.W.map(w => new Float64Array(w.length));
      this.db = this.b.map(b => new Float64Array(b.length));
      this.delta = new Float64Array(maxN);
      this.dPrev = new Float64Array(maxN);
    }

    /* 前向：结果写进 this.acts，返回输出层 */
    _fwd(x) {
      const A = this.acts, W = this.W, b = this.b, S = this.sizes;
      const L = W.length;
      const a0 = A[0];
      for (let i = 0; i < a0.length; i++) a0[i] = x[i];

      for (let l = 0; l < L; l++) {
        const nin = S[l], nout = S[l + 1];
        const w = W[l], bb = b[l], a = A[l], z = A[l + 1];
        for (let j = 0; j < nout; j++) {
          let s = bb[j];
          const o = j * nin;
          for (let i = 0; i < nin; i++) s += w[o + i] * a[i];
          z[j] = s;
        }
        if (l === L - 1) {
          for (let j = 0; j < nout; j++) z[j] = sigmoid(z[j]);   // 输出层 sigmoid
        } else {
          for (let j = 0; j < nout; j++) z[j] = Math.tanh(z[j]); // 隐层 tanh
        }
      }
      return A[L];
    }

    predict(x) { return this._fwd(x)[0]; }

    /* 输出整个向量（多分类/多输出用） */
    predictAll(x) {
      const out = this._fwd(x);
      return Array.prototype.slice.call(out);
    }

    zeroGrad() {
      for (let l = 0; l < this.dW.length; l++) {
        this.dW[l].fill(0);
        this.db[l].fill(0);
      }
    }

    /* 累积一个样本的梯度，返回该样本的损失 */
    accumulate(x, y) {
      const A = this.acts, W = this.W, S = this.sizes;
      const L = W.length;
      const out = this._fwd(x);
      const nout = S[L];

      // 目标是标量或向量
      const ys = (typeof y === 'number') ? [y] : y;

      let loss = 0;
      for (let j = 0; j < nout; j++) {
        const t = ys.length === 1 ? ys[0] : ys[j];
        const p = Math.min(1 - 1e-9, Math.max(1e-9, out[j]));
        loss -= t * Math.log(p) + (1 - t) * Math.log(1 - p);
      }

      // 输出层误差：BCE + sigmoid 的导数正好是 (a - y)
      let d = this.delta;
      for (let j = 0; j < nout; j++) {
        d[j] = out[j] - (ys.length === 1 ? ys[0] : ys[j]);
      }
      // 记录一下，供外部取用
      this.lastLoss = loss / nout;

      for (let l = L - 1; l >= 0; l--) {
        const nin = S[l], noutL = S[l + 1];
        const w = W[l], a = A[l], dw = this.dW[l], db = this.db[l];

        for (let j = 0; j < noutL; j++) {
          const dj = d[j];
          db[j] += dj;
          const o = j * nin;
          for (let i = 0; i < nin; i++) dw[o + i] += dj * a[i];
        }

        if (l > 0) {
          const nd = this.dPrev;
          for (let i = 0; i < nin; i++) {
            let s = 0;
            for (let j = 0; j < noutL; j++) s += w[j * nin + i] * d[j];
            nd[i] = s * (1 - a[i] * a[i]);      // tanh' = 1 - a²
          }
          // 交换缓冲
          this.dPrev = d;
          this.delta = nd;
          d = nd;
        }
      }
      return loss / nout;
    }

    /* 把累积的梯度应用到权重上 */
    applyGrad(lr, count) {
      const inv = 1 / Math.max(1, count);
      for (let l = 0; l < this.W.length; l++) {
        const w = this.W[l], dw = this.dW[l], b = this.b[l], db = this.db[l];
        for (let i = 0; i < w.length; i++) w[i] -= lr * dw[i] * inv;
        for (let i = 0; i < b.length; i++) b[i] -= lr * db[i] * inv;
      }
    }

    /**
     * 在一个 batch 上训练一步
     * @param {Array} samples [[input[], target], ...]
     * @returns {number} 平均损失
     */
    trainBatch(samples, lr) {
      this.zeroGrad();
      let loss = 0;
      for (let i = 0; i < samples.length; i++) {
        loss += this.accumulate(samples[i][0], samples[i][1]);
      }
      this.applyGrad(lr, samples.length);
      return loss / Math.max(1, samples.length);
    }

    /* 准确率（二分类，阈值 0.5） */
    accuracy(samples) {
      let ok = 0;
      for (let i = 0; i < samples.length; i++) {
        const p = this.predict(samples[i][0]);
        const t = typeof samples[i][1] === 'number' ? samples[i][1] : samples[i][1][0];
        if ((p >= 0.5 ? 1 : 0) === (t >= 0.5 ? 1 : 0)) ok++;
      }
      return samples.length ? ok / samples.length : 0;
    }

    /* 序列化权重，用于遗传算法复制/变异 */
    clone() {
      const m = Object.create(MLP.prototype);
      m.sizes = this.sizes.slice();
      m.rand = this.rand;
      m.W = this.W.map(w => Float64Array.from(w));
      m.b = this.b.map(b => Float64Array.from(b));
      const maxN = Math.max.apply(null, m.sizes);
      m.acts = m.sizes.map(s => new Float64Array(s));
      m.dW = m.W.map(w => new Float64Array(w.length));
      m.db = m.b.map(b => new Float64Array(b.length));
      m.delta = new Float64Array(maxN);
      m.dPrev = new Float64Array(maxN);
      return m;
    }

    /* 统计权重绝对值之和 —— 用来测"变异确实改变了网络" */
    weightSum() {
      let s = 0;
      for (let l = 0; l < this.W.length; l++) {
        const w = this.W[l], b = this.b[l];
        for (let i = 0; i < w.length; i++) s += Math.abs(w[i]);
        for (let i = 0; i < b.length; i++) s += Math.abs(b[i]);
      }
      return s;
    }
  }

  /* ============================================================
     2. 二维分类数据集（给神经网络实验室用）
     ============================================================ */
  const DATASETS = {
    xor: {
      name: '异或 XOR', hint: '最经典的非线性问题：一条直线分不开',
      gen(rng, n) {
        const d = [];
        for (let i = 0; i < n; i++) {
          const x = (rng() * 2 - 1) * 0.85;
          const y = (rng() * 2 - 1) * 0.85;
          d.push([[x, y], (x > 0) !== (y > 0) ? 1 : 0]);
        }
        return d;
      }
    },
    circle: {
      name: '同心圆', hint: '内圈一类、外圈一类',
      gen(rng, n) {
        const d = [];
        for (let i = 0; i < n; i++) {
          const a = rng() * Math.PI * 2;
          const inner = i % 2 === 0;
          const r = inner ? rng() * 0.42 : 0.6 + rng() * 0.36;
          d.push([[Math.cos(a) * r, Math.sin(a) * r], inner ? 1 : 0]);
        }
        return d;
      }
    },
    spiral: {
      name: '双螺旋', hint: '需要足够多的隐层神经元',
      gen(rng, n) {
        const d = [];
        const half = Math.floor(n / 2);
        for (let k = 0; k < 2; k++) {
          for (let i = 0; i < half; i++) {
            const t = (i / half) * 2.6 + 0.15;
            const r = 0.12 + t * 0.32;
            const a = t * 2.1 + k * Math.PI + (rng() - 0.5) * 0.25;
            d.push([[Math.cos(a) * r, Math.sin(a) * r], k]);
          }
        }
        return d;
      }
    },
    moons: {
      name: '双月牙', hint: '两个交错的上弦月',
      gen(rng, n) {
        const d = [];
        for (let i = 0; i < n; i++) {
          const upper = i % 2 === 0;
          const a = rng() * Math.PI;
          if (upper) {
            d.push([[Math.cos(a) * 0.7 - 0.18, Math.sin(a) * 0.7 - 0.16 + (rng() - 0.5) * 0.06], 1]);
          } else {
            d.push([[Math.cos(a) * 0.7 + 0.18, -Math.sin(a) * 0.7 + 0.16 + (rng() - 0.5) * 0.06], 0]);
          }
        }
        return d;
      }
    },
    blobs: {
      name: '高斯团', hint: '线性可分的入门题',
      gen(rng, n) {
        const d = [];
        for (let i = 0; i < n; i++) {
          const c = i % 2 === 0 ? [-0.42, -0.42] : [0.42, 0.42];
          d.push([[c[0] + gauss(rng) * 0.24, c[1] + gauss(rng) * 0.24], i % 2 === 0 ? 1 : 0]);
        }
        return d;
      }
    }
  };

  function makeDataset(kind, n, seed) {
    const spec = DATASETS[kind] || DATASETS.xor;
    const rng = makeRng(seed || 12345);
    const data = spec.gen(rng, n);
    return { name: spec.name, hint: spec.hint, data };
  }

  /* ============================================================
     3. 神经进化 —— 神经网络大脑 + 遗传算法
     ------------------------------------------------------------
     障碍用"笔画"表示：一串折线点。可以画出任意弯曲的线，
     长度和数量都不设上限（旧版本用方块、还超过 14 块就删最早的，
     两个问题都改掉了）。
     碰撞用粗网格加速，查询是 O(1)，几百个智能体也跑得动。
     ============================================================ */
  const SENSE = 6, HIDDEN = 10, ACT = 2;
  const CELL = 14;                       // 碰撞网格单元尺寸

  /* 点到线段距离 */
  function distSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const qx = x1 + t * dx, qy = y1 + t * dy;
    return Math.hypot(px - qx, py - qy);
  }

  /* 预设：布局 + 参数一起定义，换布局就是换一局 */
  const PRESETS = {
    empty: {
      name: '空旷平原',
      desc: '没有障碍，先看它们会不会学',
      params: { popSize: 44, genLength: 760, foodCount: 16, mutation: 0.10 },
      spawn: [0.5, 0.5],
      build() { return []; }
    },
    canyon: {
      name: '峡谷',
      desc: '一道横墙只留中间缺口，必须学会找路口',
      params: { popSize: 44, genLength: 900, foodCount: 16, mutation: 0.10 },
      spawn: [0.5, 0.22],
      build(W, H) {
        const y = H * 0.55, gap = H * 0.30, cx = W * 0.5;
        return [
          { w: 7, pts: [[0, y], [cx - gap / 2, y]] },
          { w: 7, pts: [[cx + gap / 2, y], [W, y]] }
        ];
      }
    },
    maze: {
      name: '迷宫走廊',
      desc: '三道错位竖墙，考验绕路能力',
      params: { popSize: 52, genLength: 1000, foodCount: 18, mutation: 0.12 },
      spawn: [0.10, 0.5],
      build(W, H) {
        const out = [];
        for (let i = 1; i <= 3; i++) {
          const x = W * i / 4;
          const cy = H * (i % 2 === 0 ? 0.72 : 0.28);
          const gap = H * 0.30;
          out.push({ w: 7, pts: [[x, 0], [x, Math.max(0, cy - gap / 2)]] });
          out.push({ w: 7, pts: [[x, Math.min(H, cy + gap / 2)], [x, H]] });
        }
        return out;
      }
    },
    funnel: {
      name: '漏斗',
      desc: '两边收窄到一个小口，撞墙代价很高',
      params: { popSize: 52, genLength: 900, foodCount: 18, mutation: 0.12 },
      spawn: [0.5, 0.14],
      build(W, H) {
        return [
          { w: 7, pts: [[0, 0], [W * 0.42, H * 0.44]] },
          { w: 7, pts: [[W, 0], [W * 0.58, H * 0.44]] },
          { w: 7, pts: [[W * 0.42, H * 0.56], [0, H]] },
          { w: 7, pts: [[W * 0.58, H * 0.56], [W, H]] }
        ];
      }
    },
    columns: {
      name: '立柱阵',
      desc: '一片短墙柱子，绕行路线很多',
      params: { popSize: 48, genLength: 860, foodCount: 16, mutation: 0.11 },
      spawn: [0.5, 0.5],
      build(W, H) {
        const out = [];
        for (let i = 1; i <= 4; i++) {
          for (let j = 1; j <= 2; j++) {
            const x = W * i / 5, y = H * j / 3;
            out.push({ w: 8, pts: [[x, y - H * 0.12], [x, y + H * 0.12]] });
          }
        }
        return out;
      }
    }
  };

  const DIFFICULTY = {
    easy:   { name: '轻松', genLength: 620,  foodCount: 20, popSize: 44, mutation: 0.16 },
    normal: { name: '标准', genLength: 820,  foodCount: 16, popSize: 48, mutation: 0.11 },
    hard:   { name: '严苛', genLength: 1100, foodCount: 12, popSize: 56, mutation: 0.08 }
  };

  class NeuroWorld {
    constructor(opts) {
      opts = opts || {};
      this.W = opts.width || 520;
      this.H = opts.height || 340;
      this.rng = makeRng(opts.seed || 7);

      this.strokes = [];          // [{ w: 线宽, pts: [[x,y], ...] }]
      this._grid = null;
      this.penWidth = opts.penWidth || 7;

      this.presetKey = opts.preset || 'empty';
      this.difficulty = opts.difficulty || 'normal';

      const base = DIFFICULTY[this.difficulty] || DIFFICULTY.normal;
      const pre = PRESETS[this.presetKey] || PRESETS.empty;
      const p = pre.params || {};
      this.popSize    = opts.popSize    || p.popSize    || base.popSize;
      this.genLength  = opts.genLength  || p.genLength  || base.genLength;
      this.foodCount  = opts.foodCount  || p.foodCount  || base.foodCount;
      this.mutation   = opts.mutation   != null ? opts.mutation : (p.mutation || base.mutation);

      this.spawn = (pre.spawn || [0.5, 0.5]).slice();
      this.strokes = this._buildPreset(this.presetKey);

      this.phase = 'setup';       // setup（布置障碍） / running（进化中）
      this.pop = [];
      this.food = [];
      this.generation = 1;
      this.tickCount = 0;
      this.history = [];
      this.bestEver = 0;
      this.bestFood = 0;
      this.avgFood = 0;
      this.eatenTotal = 0;
      this._preparePopulation();
      this._placeFood();
    }

    /* ---------- 布局 ---------- */
    _buildPreset(key) {
      const pre = PRESETS[key] || PRESETS.empty;
      let raw = [];
      try { raw = pre.build(this.W, this.H) || []; } catch (_) { raw = []; }
      this.spawn = (pre.spawn || [0.5, 0.5]).slice();
      return raw.map(s => ({ w: s.w || 7, pts: s.pts.map(pt => [pt[0], pt[1]]) }));
    }

    applyPreset(key) {
      key = PRESETS[key] ? key : 'empty';
      this.presetKey = key;
      this.strokes = this._buildPreset(key);
      const p = (PRESETS[key].params) || {};
      if (p.popSize) this.popSize = p.popSize;
      if (p.genLength) this.genLength = p.genLength;
      if (p.foodCount) this.foodCount = p.foodCount;
      if (p.mutation != null) this.mutation = p.mutation;
      this.phase = 'setup';
      this._preparePopulation();
      this._placeFood();
    }

    setDifficulty(d) {
      if (!DIFFICULTY[d]) return;
      this.difficulty = d;
      const base = DIFFICULTY[d];
      this.popSize = base.popSize;
      this.genLength = base.genLength;
      this.foodCount = base.foodCount;
      this.mutation = base.mutation;
      this._preparePopulation();
      this._placeFood();
    }

    /* ---------- 笔画障碍 ---------- */
    beginStroke(x, y) {
      this.strokes.push({ w: this.penWidth, pts: [[x, y]] });
      this._grid = null;
    }
    extendStroke(x, y) {
      const s = this.strokes[this.strokes.length - 1];
      if (!s) return;
      const last = s.pts[s.pts.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) < 3.5) return;   // 抽稀，别存太密的点
      s.pts.push([x, y]);
      this._grid = null;
    }
    endStroke() { this._grid = null; }
    clearStrokes() { this.strokes = []; this._grid = null; }
    undoStroke() { this.strokes.pop(); this._grid = null; }

    /* 笔画总长度，用来做统计展示 */
    strokeLength() {
      let total = 0;
      for (const s of this.strokes) {
        for (let i = 1; i < s.pts.length; i++) {
          total += Math.hypot(s.pts[i][0] - s.pts[i - 1][0], s.pts[i][1] - s.pts[i - 1][1]);
        }
      }
      return total;
    }

    /* 把笔画栅格化成粗网格，碰撞查询变成 O(1) */
    _buildGrid() {
      const gw = Math.max(1, Math.ceil(this.W / CELL));
      const gh = Math.max(1, Math.ceil(this.H / CELL));
      const g = new Uint8Array(gw * gh);
      for (const s of this.strokes) {
        const half = (s.w || 7) / 2;
        const reach = half + CELL * 0.71;
        for (let i = 1; i < s.pts.length; i++) {
          const x1 = s.pts[i - 1][0], y1 = s.pts[i - 1][1];
          const x2 = s.pts[i][0], y2 = s.pts[i][1];
          const minx = Math.max(0, Math.floor((Math.min(x1, x2) - reach) / CELL));
          const maxx = Math.min(gw - 1, Math.floor((Math.max(x1, x2) + reach) / CELL));
          const miny = Math.max(0, Math.floor((Math.min(y1, y2) - reach) / CELL));
          const maxy = Math.min(gh - 1, Math.floor((Math.max(y1, y2) + reach) / CELL));
          for (let cy = miny; cy <= maxy; cy++) {
            for (let cx = minx; cx <= maxx; cx++) {
              if (g[cy * gw + cx]) continue;
              const px = cx * CELL + CELL / 2, py = cy * CELL + CELL / 2;
              if (distSeg(px, py, x1, y1, x2, y2) <= reach) g[cy * gw + cx] = 1;
            }
          }
        }
        // 只点了一下没拖动
        if (s.pts.length === 1) {
          const [px, py] = s.pts[0];
          const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL);
          if (cx >= 0 && cy >= 0 && cx < gw && cy < gh) g[cy * gw + cx] = 1;
        }
      }
      this._grid = g; this._gw = gw; this._gh = gh;
    }

    hitWall(x, y) {
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) return true;
      if (!this._grid) this._buildGrid();
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      if (cx < 0 || cy < 0 || cx >= this._gw || cy >= this._gh) return false;
      return this._grid[cy * this._gw + cx] === 1;
    }

    /* 只做几何判断，不建网格（放置时用） */
    fitsWall(x, y, radius) {
      radius = radius || 0;
      for (const s of this.strokes) {
        const half = (s.w || 7) / 2 + radius;
        for (let i = 1; i < s.pts.length; i++) {
          if (distSeg(x, y, s.pts[i - 1][0], s.pts[i - 1][1], s.pts[i][0], s.pts[i][1]) < half) return true;
        }
        if (s.pts.length === 1 && Math.hypot(x - s.pts[0][0], y - s.pts[0][1]) < half) return true;
      }
      return false;
    }

    /* ---------- 食物 ---------- */
    _randSpot() {
      const spawnPx = this.spawn[0] * this.W, spawnPy = this.spawn[1] * this.H;
      for (let tries = 0; tries < 80; tries++) {
        const x = 20 + this.rng() * Math.max(1, this.W - 40);
        const y = 20 + this.rng() * Math.max(1, this.H - 40);
        if (this.fitsWall(x, y, 10)) continue;
        // 别放在出生点上，不然第一帧就被白吃
        if (Math.hypot(x - spawnPx, y - spawnPy) < 60) continue;
        return { x: x, y: y, r: 4.5 + this.rng() * 2, pulse: this.rng() * 6.283 };
      }
      return { x: this.W * 0.8, y: this.H * 0.2, r: 5, pulse: 0 };
    }

    _placeFood() {
      this.food = [];
      for (let i = 0; i < this.foodCount; i++) this.food.push(this._randSpot());
    }

    /* 只重铺"自然食物"，用户亲手摆的一个都不动。
       开局时如果整表重建，用户布置好的食物就会被冲掉 —— 那又是一次"食物突然消失"。 */
    _refreshNaturalFood() {
      const mine = this.food.filter(f => f.mine);
      this.food = [];
      for (let i = 0; i < this.foodCount; i++) this.food.push(this._randSpot());
      for (let i = 0; i < mine.length; i++) this.food.push(mine[i]);
    }

    /* 用户投放的食物不会被挤掉（旧版本超过上限就删最早的，这就是"食物突然消失"的原因） */
    addFood(x, y) {
      this.food.push({ x: x, y: y, r: 5.5, pulse: 0, mine: true });
    }

    removeFoodNear(x, y, radius) {
      radius = radius || 18;
      for (let i = this.food.length - 1; i >= 0; i--) {
        const f = this.food[i];
        if (Math.hypot(f.x - x, f.y - y) < radius) { this.food.splice(i, 1); return true; }
      }
      return false;
    }

    /* ---------- 种群 ---------- */
    _preparePopulation() {
      this.pop = [];
      for (let i = 0; i < this.popSize; i++) {
        this.pop.push(this._newAgent(new MLP([SENSE, HIDDEN, ACT], this.rng)));
      }
    }

    _newAgent(brain) {
      const sx = this.spawn[0] * this.W, sy = this.spawn[1] * this.H;
      let x = sx, y = sy;
      for (let t = 0; t < 40; t++) {
        const tx = sx + (this.rng() - 0.5) * 70;
        const ty = sy + (this.rng() - 0.5) * 70;
        if (!this.fitsWall(tx, ty, 6)) { x = tx; y = ty; break; }
      }
      return {
        x: x, y: y, vx: 0, vy: 0, a: this.rng() * Math.PI * 2,
        brain: brain, food: 0, path: 0, approach: 0, stuck: 0
      };
    }

    /* ---------- 阶段控制 ---------- */
    setPhase(p) {
      if (p === 'running' && this.phase !== 'running') {
        this.generation = 1;
        this.tickCount = 0;
        this.history = [];
        this.bestEver = 0; this.bestFood = 0; this.avgFood = 0; this.eatenTotal = 0;
        this._preparePopulation();
        this._refreshNaturalFood();       // 保留用户摆的食物
      }
      this.phase = p;
    }

    resetAll() {
      this.phase = 'setup';
      this.clearStrokes();
      this.generation = 1; this.tickCount = 0; this.history = [];
      this.bestEver = 0; this.bestFood = 0; this.avgFood = 0; this.eatenTotal = 0;
      this._preparePopulation();
      this._placeFood();
    }

    /* ---------- 每帧推进 ---------- */
    tick() {
      if (this.phase !== 'running') return false;

      const inp = this._inp || (this._inp = new Float64Array(SENSE));
      const maxD = Math.sqrt(this.W * this.W + this.H * this.H);

      for (let i = 0; i < this.pop.length; i++) {
        const a = this.pop[i];
        const near = this.nearestFood(a);
        const dx = near.f ? (near.f.x - a.x) : 0;
        const dy = near.f ? (near.f.y - a.y) : 0;
        const dist = Math.max(1, near.d);

        inp[0] = dx / dist;
        inp[1] = dy / dist;
        inp[2] = 1 - Math.min(1, dist / (maxD * 0.5));
        inp[3] = a.vx / 3.2;
        inp[4] = a.vy / 3.2;
        inp[5] = 1;

        // 接近度塑形：没有它，第一代全员 0 分，选择压力只剩"少走路"，
        // 进化会退化成一堆原地不动的虫子（遗传算法的经典陷阱）
        a.approach += 1 / (1 + dist / 80);

        const out = a.brain.predictAll(inp);
        // 输出层是 sigmoid(0..1)，必须映射回 -1..1 才是左右对称的转向
        const turn = ((out[0] - 0.5) * 2) * 0.30;
        const thrust = Math.max(0, Math.min(1, out[1])) * 0.42;

        a.a += turn;
        a.vx += Math.cos(a.a) * thrust;
        a.vy += Math.sin(a.a) * thrust;
        a.vx *= 0.93; a.vy *= 0.93;

        const sp = Math.hypot(a.vx, a.vy);
        if (sp > 3.4) { a.vx = a.vx / sp * 3.4; a.vy = a.vy / sp * 3.4; }

        const nx = a.x + a.vx;
        const ny = a.y + a.vy;
        a.path += Math.hypot(nx - a.x, ny - a.y);

        let bounced = false;
        if (this.hitWall(nx, a.y)) { a.vx = -a.vx * 0.55; bounced = true; }
        else a.x = nx;
        if (this.hitWall(a.x, ny)) { a.vy = -a.vy * 0.55; bounced = true; }
        else a.y = ny;

        a.stuck = bounced ? a.stuck + 1 : Math.max(0, a.stuck - 1);
        if (a.stuck > 90) {                 // 卡墙里太久就送它回出生点，避免分数被无意义地耗掉
          const na = this._newAgent(a.brain);
          na.food = a.food; na.approach = a.approach; na.path = a.path;
          this.pop[i] = na;
        }

        // 吃食物：吃掉后原地换一个位置重新生成，食物总数保持不变
        for (let k = 0; k < this.food.length; k++) {
          const f = this.food[k];
          const rr = f.r + 6;
          if ((f.x - a.x) * (f.x - a.x) + (f.y - a.y) * (f.y - a.y) < rr * rr) {
            a.food++;
            this.eatenTotal++;
            if (f.mine) {
              f.mine = false;
              f.x = this._randSpot().x; f.y = this._randSpot().y;   // 用户放的吃完也换位置
            } else {
              const ns = this._randSpot();
              f.x = ns.x; f.y = ns.y; f.r = ns.r;
            }
          }
        }
      }

      this.tickCount++;
      if (this.tickCount >= this.genLength) this.nextGeneration();
      return true;
    }

    nearestFood(a) {
      let best = null, bd = Infinity;
      for (let i = 0; i < this.food.length; i++) {
        const f = this.food[i];
        const d = (f.x - a.x) * (f.x - a.x) + (f.y - a.y) * (f.y - a.y);
        if (d < bd) { bd = d; best = f; }
      }
      return { f: best, d: Math.sqrt(bd) };
    }

    /* 吃到食物是大头，接近食物是塑形信号 */
    fitness(a) { return a.food * 100 + a.approach * 0.05; }

    nextGeneration() {
      const ranked = this.pop.slice().sort((p, q) => this.fitness(q) - this.fitness(p));
      const best = ranked[0];
      this.bestEver = Math.max(this.bestEver, Math.round(best.food));
      this.bestFood = best.food;
      let sum = 0;
      for (let i = 0; i < ranked.length; i++) sum += ranked[i].food;
      this.avgFood = sum / ranked.length;
      this.history.push({ gen: this.generation, best: best.food, avg: this.avgFood });
      if (this.history.length > 80) this.history.shift();

      const eliteN = Math.max(2, Math.round(this.popSize * 0.25));
      const elite = ranked.slice(0, eliteN);
      const next = [];
      for (let i = 0; i < elite.length && next.length < this.popSize; i++) {
        next.push(this._newAgent(elite[i].brain.clone()));
      }
      while (next.length < this.popSize) {
        const p1 = elite[Math.floor(this.rng() * elite.length)];
        const p2 = elite[Math.floor(this.rng() * elite.length)];
        const child = this._crossover(p1.brain, p2.brain);
        this._mutate(child);
        next.push(this._newAgent(child));
      }
      this.pop = next;
      this.generation++;
      this.tickCount = 0;
    }

    _crossover(b1, b2) {
      const child = b1.clone();
      const rng = this.rng;
      for (let l = 0; l < child.W.length; l++) {
        const cw = child.W[l], w2 = b2.W[l];
        for (let i = 0; i < cw.length; i++) if (rng() < 0.5) cw[i] = w2[i];
        const cb = child.b[l], b2b = b2.b[l];
        for (let i = 0; i < cb.length; i++) if (rng() < 0.5) cb[i] = b2b[i];
      }
      return child;
    }

    _mutate(m) {
      const rng = this.rng;
      const sigma = 0.34, rerollP = 0.02;
      for (let l = 0; l < m.W.length; l++) {
        const w = m.W[l], b = m.b[l];
        for (let i = 0; i < w.length; i++) {
          if (rng() < rerollP) w[i] = (rng() * 2 - 1) * Math.sqrt(1 / m.sizes[l]);
          else if (rng() < this.mutation) w[i] += gauss(rng) * sigma;
        }
        for (let i = 0; i < b.length; i++) {
          if (rng() < this.mutation) b[i] += gauss(rng) * sigma;
        }
      }
    }

    /* ---------- 存档：把布局存下来下次接着用 ---------- */
    exportLayout() {
      return {
        v: 1,
        preset: this.presetKey,
        spawn: this.spawn.slice(),
        params: { popSize: this.popSize, genLength: this.genLength, foodCount: this.foodCount, mutation: this.mutation },
        strokes: this.strokes.map(s => ({ w: s.w, pts: s.pts.map(pt => [Math.round(pt[0]), Math.round(pt[1])]) }))
      };
    }

    importLayout(data) {
      if (!data || !data.strokes) return false;
      this.presetKey = 'custom';
      this.spawn = (data.spawn || [0.5, 0.5]).slice();
      this.strokes = data.strokes.map(s => ({ w: s.w || 7, pts: s.pts.map(pt => [pt[0], pt[1]]) }));
      if (data.params) {
        if (data.params.popSize) this.popSize = data.params.popSize;
        if (data.params.genLength) this.genLength = data.params.genLength;
        if (data.params.foodCount) this.foodCount = data.params.foodCount;
        if (data.params.mutation != null) this.mutation = data.params.mutation;
      }
      this._grid = null;
      this.phase = 'setup';
      this._preparePopulation();
      this._placeFood();
      return true;
    }
  }

  /* ============================================================
     4. AI 读心猜拳 —— 在线学习（指数加权专家集成）
     0=石头 1=剪刀 2=布
     ============================================================ */
  const MOVES = ['石头', '剪刀', '布'];
  const BEATS = [2, 0, 1];   // 打败 x 的是 BEATS[x]：石头被布打败…

  function beats(a, b) { return BEATS[b] === a; }   // a 是否赢 b
  function result(p, ai) {                          // 从玩家视角：1 赢 / 0 平 / -1 输
    if (p === ai) return 0;
    return BEATS[ai] === p ? 1 : -1;
  }

  class RPSMind {
    constructor(eta) {
      this.eta = eta || 0.22;
      // 6 个专家，各自是一个"下一步玩家会出什么"的预测器
      this.experts = ['global', 'markov1', 'markov2', 'afterAI', 'winStay', 'counterSelf'].map(id => ({
        id: id, weight: 1, hits: 0, tries: 0
      }));
      this.counts = [1, 1, 1];          // 拉普拉斯平滑
      this.afterSelf = [{}, {}, {}];    // [玩家上一手][玩家下一手] = 次数
      this.afterTwo = {};               // "01" -> {next: count}
      this.afterAI = [{}, {}, {}];
      this.history = [];                // {p, ai, r}
      this.predicted = null;
      this.hits = 0;
      this.rounds = 0;
    }

    _argmax(counts) {
      let best = 0;
      for (let i = 1; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
      return best;
    }

    _argmaxObj(obj, fallback) {
      let best = null, bc = -1;
      for (const k in obj) if (obj[k] > bc) { bc = obj[k]; best = Number(k); }
      return best === null ? fallback : best;
    }

    /* 每个专家对"玩家下一步"的预测 */
    _expertPredictions() {
      const h = this.history;
      const last = h.length ? h[h.length - 1] : null;
      const prev = h.length > 1 ? h[h.length - 2] : null;
      const g = this._argmax(this.counts);

      const e = {};
      e.global = g;

      e.markov1 = last ? this._argmaxObj(this.afterSelf[last.p], g) : g;

      if (last && prev) {
        const key = prev.p + '' + last.p;
        const row = this.afterTwo[key];
        e.markov2 = row ? this._argmaxObj(row, g) : g;
      } else e.markov2 = g;

      e.afterAI = last ? this._argmaxObj(this.afterAI[last.ai], g) : g;

      // 赢了就重复、输了就换成能赢 AI 上一手的
      if (last) {
        if (last.r > 0) e.winStay = last.p;
        else if (last.r < 0) e.winStay = BEATS[last.ai];
        else e.winStay = (last.p + 1) % 3;
      } else e.winStay = g;

      // 人倾向于"升级"：打出能赢自己上一手的那一手
      e.counterSelf = last ? BEATS[last.p] : g;

      return e;
    }

    /* AI 出拳前的推理：返回 {aiMove, predictedMove, confidence, contributions} */
    decide() {
      const preds = this._expertPredictions();
      const votes = [0, 0, 0];
      const contrib = [];
      let total = 0;
      this.experts.forEach(ex => {
        const m = preds[ex.id];
        votes[m] += ex.weight;
        total += ex.weight;
        contrib.push({ id: ex.id, move: m, weight: ex.weight });
      });
      const predicted = this._argmax(votes);
      const confidence = total > 0 ? votes[predicted] / total : 1 / 3;
      const aiMove = BEATS[predicted];   // 打你预测要出的那一手
      this.predicted = predicted;
      this.lastContrib = contrib;
      return { aiMove: aiMove, predictedMove: predicted, confidence: confidence, contributions: contrib };
    }

    /* 玩家出完之后更新模型 */
    observe(playerMove, aiMoveUsed) {
      const p = playerMove, ai = aiMoveUsed;
      // 1. 先结算上一个预测，给专家加减权（Hedge：错的降权）
      if (this.predicted !== null) {
        const preds = this.lastPreds || {};
        this.experts.forEach(ex => {
          if (preds[ex.id] === undefined) return;
          ex.tries++;
          const correct = preds[ex.id] === p;
          if (correct) ex.hits++;
          // 预测错 → 权重乘以 exp(-eta)；对 → 保持
          ex.weight *= Math.exp(correct ? 0 : -this.eta);
        });
        // 归一化，避免数值下溢
        let s = 0;
        this.experts.forEach(ex => s += ex.weight);
        if (s > 0) this.experts.forEach(ex => { ex.weight = ex.weight / s * this.experts.length; });
        if (this.predicted === p) this.hits++;
        this.rounds++;
      }

      // 2. 记录统计
      this.counts[p]++;
      const last = this.history.length ? this.history[this.history.length - 1] : null;
      if (last) {
        this.afterSelf[last.p][p] = (this.afterSelf[last.p][p] || 0) + 1;
        const key = (this.history.length > 1 ? this.history[this.history.length - 2].p : 0) + '' + last.p;
        this.afterTwo[key] = this.afterTwo[key] || {};
        this.afterTwo[key][p] = (this.afterTwo[key][p] || 0) + 1;
      }
      this.afterAI[ai][p] = (this.afterAI[ai][p] || 0) + 1;

      this.history.push({ p: p, ai: ai, r: result(p, ai) });
      if (this.history.length > 400) this.history.shift();

      // 3. 为下一轮预先算好专家预测并缓存
      this.lastPreds = this._expertPredictions();
    }

    /* 习惯分析报告 */
    report() {
      const h = this.history;
      const total = h.length;
      const out = { total: total, movePct: [0, 0, 0], accuracy: 0, examples: [] };
      if (!total) return out;

      const c = [0, 0, 0];
      h.forEach(x => c[x.p]++);
      out.movePct = c.map(v => v / total);

      out.accuracy = this.rounds ? this.hits / this.rounds : 0;

      // 输了之后下一手出什么
      const afterLoss = [0, 0, 0], afterWin = [0, 0, 0];
      for (let i = 0; i < h.length - 1; i++) {
        if (h[i].r < 0) afterLoss[h[i + 1].p]++;
        else if (h[i].r > 0) afterWin[h[i + 1].p]++;
      }
      const pctOf = arr => {
        const s = arr[0] + arr[1] + arr[2];
        return s ? arr.map(v => v / s) : [0, 0, 0];
      };
      out.afterLoss = pctOf(afterLoss);
      out.afterWin = pctOf(afterWin);
      out.afterLossN = afterLoss[0] + afterLoss[1] + afterLoss[2];
      out.afterWinN = afterWin[0] + afterWin[1] + afterWin[2];

      // 最长连出同一手
      let streak = 1, best = 1;
      for (let i = 1; i < h.length; i++) {
        if (h[i].p === h[i - 1].p) { streak++; best = Math.max(best, streak); }
        else streak = 1;
      }
      out.longestStreak = best;

      // 哪个专家最准
      const ranked = this.experts.slice()
        .filter(e => e.tries >= 5)
        .sort((a, b) => (b.hits / b.tries) - (a.hits / a.tries));
      out.bestExpert = ranked.length ? {
        id: ranked[0].id,
        rate: ranked[0].hits / ranked[0].tries,
        tries: ranked[0].tries
      } : null;

      // 玩家胜率
      const wins = h.filter(x => x.r > 0).length;
      const draws = h.filter(x => x.r === 0).length;
      out.playerWin = wins / total;
      out.aiWin = (total - wins - draws) / total;
      out.draw = draws / total;

      return out;
    }
  }

  const EXPERT_NAMES = {
    global: '出得最多的那一手',
    markov1: '上一手的习惯跟随',
    markov2: '最近两手的组合习惯',
    afterAI: '被压之后的反击习惯',
    winStay: '赢了重复、输了换招',
    counterSelf: '自我升级倾向'
  };

  /* ============================================================
     5. 寻路算法 —— BFS / A* / 贪心最优优先
     ============================================================ */
  function gridNeighbors(grid, w, h, i) {
    const x = i % w, y = (i / w) | 0;
    const out = [];
    const push = (nx, ny) => {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
      const j = ny * w + nx;
      if (grid[j] === 1) return;
      out.push(j);
    };
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
    return out;
  }

  const manhattan = (a, b, w) => {
    const ax = a % w, ay = (a / w) | 0, bx = b % w, by = (b / w) | 0;
    return Math.abs(ax - bx) + Math.abs(ay - by);
  };

  /**
   * @param {Int8Array|number[]} grid 0 可走 1 障碍
   * @param {'bfs'|'astar'|'greedy'} mode
   * @returns {{path:number[], visited:number[], order:number[]}}
   */
  function solve(grid, w, h, start, goal, mode) {
    const visited = new Array(w * h).fill(false);
    const parent = new Int32Array(w * h).fill(-1);
    const order = [];
    const gScore = new Float64Array(w * h).fill(Infinity);

    if (grid[start] === 1 || grid[goal] === 1) return { path: [], visited: [], order: [] };

    // 用数组当优先队列（格子数不多，线性取最小足够快）
    const open = [start];
    const inOpen = new Array(w * h).fill(false);
    inOpen[start] = true;
    gScore[start] = 0;

    while (open.length) {
      let bi = 0;
      if (mode === 'bfs') {
        bi = 0;                       // BFS：先进先出
      } else {
        let bestF = Infinity;
        for (let k = 0; k < open.length; k++) {
          const n = open[k];
          const f = mode === 'astar'
            ? gScore[n] + manhattan(n, goal, w)
            : manhattan(n, goal, w);  // 贪心只看启发值
          if (f < bestF) { bestF = f; bi = k; }
        }
      }

      const cur = open.splice(bi, 1)[0];
      inOpen[cur] = false;
      if (visited[cur]) continue;
      visited[cur] = true;
      order.push(cur);

      if (cur === goal) break;

      const nb = gridNeighbors(grid, w, h, cur);
      for (let i = 0; i < nb.length; i++) {
        const n = nb[i];
        if (visited[n]) continue;
        const tentative = gScore[cur] + 1;
        if (tentative < gScore[n]) {
          gScore[n] = tentative;
          parent[n] = cur;
          if (!inOpen[n]) { open.push(n); inOpen[n] = true; }
        }
      }
    }

    let path = [];
    if (visited[goal]) {
      let c = goal;
      let guard = w * h + 5;
      while (c !== -1 && guard-- > 0) {
        path.push(c);
        if (c === start) break;
        c = parent[c];
      }
      path.reverse();
    }
    return {
      path: path,
      visited: visited.map((v, i) => v ? i : -1).filter(i => i >= 0),
      order: order
    };
  }

  /* ============================================================
     导出
     ============================================================ */
  global.AI = {
    makeRng, gauss, sigmoid, distSeg,
    MLP, DATASETS, makeDataset,
    NeuroWorld, PRESETS, DIFFICULTY, SENSE, HIDDEN, ACT,
    RPSMind, MOVES, BEATS, beats, result, EXPERT_NAMES,
    solve, manhattan
  };

})(typeof window !== 'undefined' ? window : globalThis);
