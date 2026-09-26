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
     ============================================================ */
  const SENSE = 6, HIDDEN = 10, ACT = 2;

  class NeuroWorld {
    constructor(opts) {
      opts = opts || {};
      this.W = opts.width || 480;
      this.H = opts.height || 360;
      this.popSize = opts.popSize || 44;
      this.genLength = opts.genLength || 760;
      this.foodCount = opts.foodCount || 14;
      this.rng = makeRng(opts.seed || 7);
      this.walls = [];
      this.reset();
    }

    reset() {
      this.generation = 1;
      this.tickCount = 0;
      this.pop = [];
      for (let i = 0; i < this.popSize; i++) {
        this.pop.push(this._newAgent(new MLP([SENSE, HIDDEN, ACT], this.rng)));
      }
      this.food = [];
      for (let i = 0; i < this.foodCount; i++) this.food.push(this._randSpot());
      this.bestEver = 0;
      this.bestFood = 0;
      this.avgFood = 0;
      this.history = [];
    }

    _newAgent(brain) {
      return {
        x: this.W / 2 + (this.rng() - 0.5) * 60,
        y: this.H / 2 + (this.rng() - 0.5) * 60,
        vx: 0, vy: 0,         a: this.rng() * Math.PI * 2,
        brain: brain,
        food: 0,
        path: 0,
        approach: 0,
        alive: true
      };
    }

    _randSpot() {
      for (let tries = 0; tries < 40; tries++) {
        const x = 18 + this.rng() * (this.W - 36);
        const y = 18 + this.rng() * (this.H - 36);
        let ok = true;
        for (let i = 0; i < this.walls.length && ok; i++) {
          const w = this.walls[i];
          if (x > w.x - 14 && x < w.x + w.w + 14 && y > w.y - 14 && y < w.y + w.h + 14) ok = false;
        }
        if (ok) return { x: x, y: y, r: 4.5 + this.rng() * 2 };
      }
      return { x: this.rng() * this.W, y: this.rng() * this.H, r: 5 };
    }

    addFood(x, y) {
      this.food.push({ x: x, y: y, r: 5 });
      if (this.food.length > this.foodCount + 12) this.food.shift();
    }

    addWall(x, y) {
      this.walls.push({ x: x - 26, y: y - 9, w: 52, h: 18 });
      if (this.walls.length > 14) this.walls.shift();
    }

    clearWalls() { this.walls = []; }

    nearestFood(a) {
      let best = null, bd = Infinity;
      for (let i = 0; i < this.food.length; i++) {
        const f = this.food[i];
        const d = (f.x - a.x) * (f.x - a.x) + (f.y - a.y) * (f.y - a.y);
        if (d < bd) { bd = d; best = f; }
      }
      return { f: best, d: Math.sqrt(bd) };
    }

    _hitWall(x, y) {
      for (let i = 0; i < this.walls.length; i++) {
        const w = this.walls[i];
        if (x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h) return true;
      }
      return false;
    }

    /* 推进一帧 */
    tick() {
      const inp = this._inp || (this._inp = new Float64Array(SENSE));
      const maxD = Math.sqrt(this.W * this.W + this.H * this.H);

      for (let i = 0; i < this.pop.length; i++) {
        const a = this.pop[i];
        const near = this.nearestFood(a);
        const dx = near.f ? (near.f.x - a.x) : 0;
        const dy = near.f ? (near.f.y - a.y) : 0;
        const dist = Math.max(1, near.d);

        inp[0] = dx / dist;                       // 食物方向（单位向量）
        inp[1] = dy / dist;
        inp[2] = 1 - Math.min(1, dist / (maxD * 0.5));  // 接近程度 0..1
        inp[3] = a.vx / 3.2;                      // 当前速度
        inp[4] = a.vy / 3.2;
        inp[5] = 1;                               // 偏置

        // 靠近食物就累积一点"接近分"。
        // 没有这个塑形信号，第一代全员都是 0 分，选择压力只剩"少走路"，
        // 进化会退化成一堆原地不动的虫子（这是进化算法的经典坑）。
        a.approach += 1 / (1 + dist / 80);

        const out = a.brain.predictAll(inp);
        // 输出层是 sigmoid(0..1)，必须映射回 -1..1 才是左右对称的转向。
        // 之前误用 tanh 包了一层，转向恒为正 —— 虫子只会往一边拐。
        const turn = ((out[0] - 0.5) * 2) * 0.30;
        const thrust = Math.max(0, Math.min(1, out[1])) * 0.42;

        a.a += turn;
        a.vx += Math.cos(a.a) * thrust;
        a.vy += Math.sin(a.a) * thrust;
        a.vx *= 0.93; a.vy *= 0.93;

        // 限速
        const sp = Math.hypot(a.vx, a.vy);
        if (sp > 3.4) { a.vx = a.vx / sp * 3.4; a.vy = a.vy / sp * 3.4; }

        const nx = a.x + a.vx;
        const ny = a.y + a.vy;
        const step = Math.hypot(nx - a.x, ny - a.y);
        a.path += step;

        // 撞墙 / 撞障碍：弹回
        if (nx < 6 || nx > this.W - 6 || this._hitWall(nx, a.y)) { a.vx = -a.vx * 0.5; }
        else a.x = nx;
        if (ny < 6 || ny > this.H - 6 || this._hitWall(a.x, ny)) { a.vy = -a.vy * 0.5; }
        else a.y = ny;

        // 吃食物
        for (let k = this.food.length - 1; k >= 0; k--) {
          const f = this.food[k];
          if ((f.x - a.x) * (f.x - a.x) + (f.y - a.y) * (f.y - a.y) < (f.r + 6) * (f.r + 6)) {
            a.food++;
            this.food[k] = this._randSpot();
          }
        }
      }

      this.tickCount++;
      if (this.tickCount >= this.genLength) this.nextGeneration();
    }

    /* 吃到食物是大头，接近食物是塑形信号（保证第一代就有梯度可爬） */
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
      if (this.history.length > 60) this.history.shift();

      // 保留前 25% 直接进下一代（精英保留）
      const eliteN = Math.max(2, Math.round(this.popSize * 0.25));
      const elite = ranked.slice(0, eliteN);
      const next = [];
      for (let i = 0; i < elite.length && next.length < this.popSize; i++) {
        next.push(this._newAgent(elite[i].brain.clone()));
      }
      // 其余由精英交叉 + 变异产生
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
      // 逐权重随机取父本之一
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
      const rate = 0.10, sigma = 0.34, rerollP = 0.02;
      for (let l = 0; l < m.W.length; l++) {
        const w = m.W[l], b = m.b[l];
        for (let i = 0; i < w.length; i++) {
          if (rng() < rerollP) w[i] = (rng() * 2 - 1) * Math.sqrt(1 / m.sizes[l]);
          else if (rng() < rate) w[i] += gauss(rng) * sigma;
        }
        for (let i = 0; i < b.length; i++) {
          if (rng() < rate) b[i] += gauss(rng) * sigma;
        }
      }
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
     5. 反转棋 AI —— minimax + alpha-beta
     棋盘 Int8Array(64)：0 空，1 黑，-1 白
     ============================================================ */
  const DIRS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

  const WEIGHTS = [
    120, -20, 20, 5, 5, 20, -20, 120,
    -20, -40, -5, -5, -5, -5, -40, -20,
    20, -5, 15, 3, 3, 15, -5, 20,
    5, -5, 3, 3, 3, 3, -5, 5,
    5, -5, 3, 3, 3, 3, -5, 5,
    20, -5, 15, 3, 3, 15, -5, 20,
    -20, -40, -5, -5, -5, -5, -40, -20,
    120, -20, 20, 5, 5, 20, -20, 120
  ];

  function newBoard() {
    const b = new Int8Array(64);
    b[27] = -1; b[28] = 1; b[35] = 1; b[36] = -1;   // 白 黑 / 黑 白
    return b;
  }

  const xy = i => [i % 8, (i / 8) | 0];
  const idx = (x, y) => y * 8 + x;

  /* 该位置落子能翻哪些子；不能下返回 null */
  function flipsFor(b, pos, player) {
    if (b[pos] !== 0) return null;
    const [x0, y0] = xy(pos);
    let all = [];
    for (let d = 0; d < 8; d++) {
      const dx = DIRS[d][0], dy = DIRS[d][1];
      let x = x0 + dx, y = y0 + dy;
      const line = [];
      while (x >= 0 && x < 8 && y >= 0 && y < 8 && b[idx(x, y)] === -player) {
        line.push(idx(x, y));
        x += dx; y += dy;
      }
      if (line.length && x >= 0 && x < 8 && y >= 0 && y < 8 && b[idx(x, y)] === player) {
        all = all.concat(line);
      }
    }
    return all.length ? all : null;
  }

  function legalMoves(b, player) {
    const out = [];
    for (let i = 0; i < 64; i++) {
      if (flipsFor(b, i, player)) out.push(i);
    }
    return out;
  }

  function applyMove(b, pos, player) {
    const fl = flipsFor(b, pos, player);
    if (!fl) return null;
    const nb = Int8Array.from(b);
    nb[pos] = player;
    fl.forEach(i => { nb[i] = player; });
    return { board: nb, flipped: fl.length };
  }

  function countDiscs(b) {
    let black = 0, white = 0;
    for (let i = 0; i < 64; i++) {
      if (b[i] === 1) black++;
      else if (b[i] === -1) white++;
    }
    return { black: black, white: white };
  }

  function evaluate(b, me) {
    const opp = -me;
    let posScore = 0;
    for (let i = 0; i < 64; i++) {
      if (b[i] === me) posScore += WEIGHTS[i];
      else if (b[i] === opp) posScore -= WEIGHTS[i];
    }
    const myMob = legalMoves(b, me).length;
    const opMob = legalMoves(b, opp).length;
    const c = countDiscs(b);
    const discDiff = me === 1 ? c.black - c.white : c.white - c.black;
    // 权重：位置 > 机动性 > 子数（中盘阶段子多反而不好，所以子数权重最低）
    return posScore * 1.0 + (myMob - opMob) * 12 + discDiff * 1.5;
  }

  function bestMove(board, player, depth, seed) {
    const rng = makeRng(seed || 99);
    let moves = legalMoves(board, player);
    if (!moves.length) return null;
    if (moves.length === 1) return moves[0];

    let nodes = 0;
    const NODE_CAP = 260000;

    function search(b, me, d, alpha, beta, passed) {
      nodes++;
      if (nodes > NODE_CAP) return evaluate(b, player);
      const lm = legalMoves(b, me);
      if (!lm.length) {
        if (passed) {
          // 双方都无子可下，终局
          const c = countDiscs(b);
          const diff = player === 1 ? c.black - c.white : c.white - c.black;
          return diff * 10000;
        }
        return search(b, -me, d, alpha, beta, true);
      }
      if (d === 0) return evaluate(b, player);

      // 落子排序：翻得多的先搜，剪枝效率高很多
      const ordered = lm.map(m => ({ m: m, f: flipsFor(b, m, me).length }))
                         .sort((p, q) => q.f - p.f);

      if (me === player) {
        let best = -Infinity;
        for (let i = 0; i < ordered.length; i++) {
          const step = applyMove(b, ordered[i].m, me);
          const v = search(step.board, -me, d - 1, alpha, beta, false);
          if (v > best) best = v;
          if (best > alpha) alpha = best;
          if (alpha >= beta) break;
        }
        return best;
      } else {
        let best = Infinity;
        for (let i = 0; i < ordered.length; i++) {
          const step = applyMove(b, ordered[i].m, me);
          const v = search(step.board, -me, d - 1, alpha, beta, false);
          if (v < best) best = v;
          if (best < beta) beta = best;
          if (alpha >= beta) break;
        }
        return best;
      }
    }

    let bestScore = -Infinity, bestList = [];
    const ordered = moves.map(m => ({ m: m, f: flipsFor(board, m, player).length }))
                         .sort((p, q) => q.f - p.f);

    for (let i = 0; i < ordered.length; i++) {
      const step = applyMove(board, ordered[i].m, player);
      const v = search(step.board, -player, depth - 1, -Infinity, Infinity, false);
      if (v > bestScore) { bestScore = v; bestList = [ordered[i].m]; }
      else if (v === bestScore) bestList.push(ordered[i].m);
    }
    return bestList[Math.floor(rng() * bestList.length)];
  }

  /* 带随机性的"简单"档：有一定概率不走最优 */
  function easyMove(board, player, seed) {
    const rng = makeRng(seed || 5);
    const moves = legalMoves(board, player);
    if (!moves.length) return null;
    if (rng() < 0.45) return moves[Math.floor(rng() * moves.length)];
    return bestMove(board, player, 1, seed);
  }

  /* ============================================================
     6. 寻路算法 —— BFS / A* / 贪心最优优先
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
    makeRng, gauss, sigmoid,
    MLP, DATASETS, makeDataset,
    NeuroWorld, SENSE, HIDDEN, ACT,
    RPSMind, MOVES, BEATS, beats, result, EXPERT_NAMES,
    newBoard, flipsFor, legalMoves, applyMove, countDiscs, evaluate, bestMove, easyMove, WEIGHTS, idx, xy,
    solve, manhattan
  };

})(typeof window !== 'undefined' ? window : globalThis);
