/* ============================================================
   particles.js · 可交互粒子背景
   ------------------------------------------------------------
   两个作用：
   1. 填满屏幕，好看、可互动（手指推开粒子、点击产生冲击波）
   2. 给上层的液态玻璃提供"可折射的内容" —— 没有高频细节，
      backdrop-filter 糊出来还是一片纯色，玻璃开关就看不出区别。

   性能要点（都在下面的代码里落实了）：
   - 画布像素比封顶 2，避免 iPad 上生成超大画布
   - 连线按透明度分桶批量描边，减少状态切换
   - 禁用 shadowBlur / filter（这两个在 canvas 上是性能杀手）
   - 帧率自适应：连续掉帧就自动减少粒子数
   - 详情面板打开时降到 30fps（模糊底图不必每帧重采样）
   - 标签页切到后台时暂停
   ============================================================ */

(function (global) {
  'use strict';

  const TAU = Math.PI * 2;

  class ParticleField {
    constructor(canvas, opts) {
      opts = opts || {};
      this.cv = canvas;
      this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
      this.enabled = opts.enabled !== false;
      this.maxParticles = opts.maxParticles || 170;
      this.minParticles = opts.minParticles || 55;
      this.linkDist = opts.linkDist || 118;
      this.pointerRadius = opts.pointerRadius || 150;
      this.fps = 60;
      this._targetFps = 60;
      this._raf = 0;
      this._last = 0;
      this._acc = 0;
      this._frames = 0;
      this._frameAcc = 0;
      this._slowStreak = 0;
      this._fastStreak = 0;
      this._running = false;
      this._visible = true;

      const reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.motion = !reduce;

      this.ptr = { x: -9999, y: -9999, down: false, active: false };
      this.pulses = [];
      this.w = 0; this.h = 0; this.dpr = 1;

      this._bind();
      this.resize(true);
      this.seed();
    }

    /* ---------- 尺寸 ---------- */
    resize(recount) {
      const w = global.innerWidth || 400;
      const h = global.innerHeight || 700;
      // 像素比封顶 2：iPad 的物理分辨率很高，再乘上去画布会变得非常贵
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      if (this.w === w && this.h === h && this.dpr === dpr && !recount) return;
      this.w = w; this.h = h; this.dpr = dpr;
      this.cv.width = Math.round(w * dpr);
      this.cv.height = Math.round(h * dpr);
      this.cv.style.width = w + 'px';
      this.cv.style.height = h + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (recount) this.target = this._targetCount();
      else if (this.parts && this.parts.length !== this.target) this.seed();
    }

    _targetCount() {
      const area = this.w * this.h;
      // 每 ~9000 平方像素一个粒子，再按上限收口
      const n = Math.round(area / 9000);
      return Math.max(this.minParticles, Math.min(this.maxParticles, n));
    }

    /* ---------- 生成粒子 ---------- */
    seed() {
      this.target = this._targetCount();
      const n = this.target;
      const parts = new Array(n);
      for (let i = 0; i < n; i++) parts[i] = this._spawn(true);
      this.parts = parts;
      this.linkDist = Math.max(96, Math.min(150, Math.min(this.w, this.h) * 0.20));
    }

    _spawn(anywhere) {
      const big = Math.random() < 0.16;
      return {
        x: Math.random() * this.w,
        y: anywhere ? Math.random() * this.h : this.h + 10,
        vx: (Math.random() - 0.5) * 0.30,
        vy: (Math.random() - 0.5) * 0.30,
        r: big ? 1.8 + Math.random() * 1.5 : 0.7 + Math.random() * 1.0,
        hue: 200 + Math.random() * 42 - (Math.random() < 0.14 ? 40 : 0),
        a: big ? 0.34 + Math.random() * 0.28 : 0.16 + Math.random() * 0.30,
        glow: big
      };
    }

    /* ---------- 交互 ---------- */
    _bind() {
      const onMove = e => {
        this.ptr.x = e.clientX;
        this.ptr.y = e.clientY;
        this.ptr.active = true;
      };
      global.addEventListener('pointermove', onMove, { passive: true });
      global.addEventListener('pointerdown', e => {
        onMove(e);
        this.ptr.down = true;
        this._pulse(e.clientX, e.clientY);
      }, { passive: true });
      global.addEventListener('pointerup', () => { this.ptr.down = false; }, { passive: true });
      global.addEventListener('pointercancel', () => { this.ptr.down = false; }, { passive: true });
      global.addEventListener('pointerleave', () => { this.ptr.active = false; }, { passive: true });

      global.addEventListener('resize', () => this.resize(), { passive: true });
      global.addEventListener('orientationchange', () => setTimeout(() => this.resize(true), 220));

      document.addEventListener('visibilitychange', () => {
        this._visible = !document.hidden;
        if (this._visible && this.enabled) this.start();
        else this.stop();
      });
    }

    _pulse(x, y) {
      if (!this.motion) return;
      this.pulses.push({ x: x, y: y, r: 2, life: 1 });
      if (this.pulses.length > 4) this.pulses.shift();
    }

    /* 详情面板打开时降帧，省掉不必要的模糊重采样 */
    setLowPower(on) {
      this._targetFps = on ? 30 : 60;
    }

    setEnabled(on) {
      this.enabled = !!on;
      if (this.enabled && this._visible) this.start();
      else this.stop();
    }

    /* ---------- 主循环 ---------- */
    start() {
      if (this._running || !this.enabled) return;
      this._running = true;
      this._last = 0;
      const loop = ts => {
        if (!this._running) return;
        this._raf = requestAnimationFrame(loop);
        const dt = this._last ? Math.min(48, ts - this._last) : 16.7;
        this._last = ts;
        this._acc += dt;
        const period = 1000 / this._targetFps;
        if (this._acc < period) return;
        this._acc = 0;

        this._track(dt);
        if (this.motion) this._step(dt);
        this._draw();
      };
      this._raf = requestAnimationFrame(loop);
    }

    stop() {
      this._running = false;
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = 0;
    }

    /* 帧率监控：掉了就减粒子，恢复了再加回来 */
    _track(dt) {
      this._frames++;
      this._frameAcc += dt;
      if (this._frames < 45) return;
      const avg = this._frameAcc / this._frames;
      this.fps = Math.round(1000 / Math.max(1, avg));
      this._frames = 0;
      this._frameAcc = 0;

      if (avg > 26) {
        this._slowStreak++; this._fastStreak = 0;
      } else if (avg < 15.5) {
        this._fastStreak++; this._slowStreak = 0;
      } else { this._slowStreak = 0; this._fastStreak = 0; }

      if (this._slowStreak >= 3 && this.parts.length > this.minParticles) {
        this._slowStreak = 0;
        this.target = Math.max(this.minParticles, Math.round(this.parts.length * 0.78));
        this.parts.length = this.target;
      } else if (this._fastStreak >= 6 && this.parts.length < this._targetCount()) {
        this._fastStreak = 0;
        this._grow();
      }
    }

    _grow() {
      const want = Math.min(this._targetCount(), this.parts.length + 10);
      while (this.parts.length < want) this.parts.push(this._spawn(true));
    }

    /* ---------- 物理 ---------- */
    _step(dt) {
      const k = dt / 16.7;
      const P = this.parts;
      const pr = this.pointerRadius;
      const pr2 = pr * pr;
      const px = this.ptr.x, py = this.ptr.y;
      const ptrOn = this.ptr.active && (this.ptr.down || this.motion);

      for (let i = 0; i < P.length; i++) {
        const p = P[i];

        // 手指推开
        if (ptrOn) {
          const dx = p.x - px, dy = p.y - py;
          const d2 = dx * dx + dy * dy;
          if (d2 < pr2 && d2 > 0.01) {
            const d = Math.sqrt(d2);
            const f = (1 - d / pr) * (this.ptr.down ? 0.95 : 0.30);
            p.vx += (dx / d) * f * k;
            p.vy += (dy / d) * f * k;
          }
        }

        p.x += p.vx * k;
        p.y += p.vy * k;

        // 阻尼，避免越推越快
        p.vx *= 0.985; p.vy *= 0.985;
        // 保留一点自然漂移
        p.vx += (Math.random() - 0.5) * 0.012;
        p.vy += (Math.random() - 0.5) * 0.012;

        const sp = Math.hypot(p.vx, p.vy);
        if (sp > 3.6) { p.vx = p.vx / sp * 3.6; p.vy = p.vy / sp * 3.6; }

        // 环绕
        if (p.x < -12) p.x = this.w + 12; else if (p.x > this.w + 12) p.x = -12;
        if (p.y < -12) p.y = this.h + 12; else if (p.y > this.h + 12) p.y = -12;
      }

      // 冲击波
      for (let i = this.pulses.length - 1; i >= 0; i--) {
        const pu = this.pulses[i];
        pu.r += 13 * k;
        pu.life -= 0.055 * k;
        if (pu.life <= 0) { this.pulses.splice(i, 1); continue; }
        for (let j = 0; j < P.length; j++) {
          const p = P[j];
          const dx = p.x - pu.x, dy = p.y - pu.y;
          const d = Math.hypot(dx, dy);
          if (d < pu.r + 44 && d > 0.5) {
            const band = Math.abs(d - pu.r);
            if (band < 30) {
              const f = (1 - band / 30) * pu.life * 1.5;
              p.vx += (dx / d) * f * k;
              p.vy += (dy / d) * f * k;
            }
          }
        }
      }
    }

    /* ---------- 绘制 ---------- */
    _draw() {
      const ctx = this.ctx, P = this.parts;
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.globalCompositeOperation = 'lighter';

      // 连线：按透明度分 6 档批量描边，比逐条设置 strokeStyle 快很多
      const LD = this.linkDist, LD2 = LD * LD;
      const BUCKETS = 6;
      const buckets = [];
      for (let b = 0; b < BUCKETS; b++) buckets.push(null);

      const px = this.ptr.x, py = this.ptr.y;
      const ptrOn = this.ptr.active;

      for (let i = 0; i < P.length; i++) {
        const a = P[i];
        for (let j = i + 1; j < P.length; j++) {
          const b = P[j];
          const dx = a.x - b.x;
          if (dx > LD || dx < -LD) continue;
          const dy = a.y - b.y;
          if (dy > LD || dy < -LD) continue;
          const d2 = dx * dx + dy * dy;
          if (d2 > LD2) continue;
          const t = 1 - Math.sqrt(d2) / LD;      // 1 近 → 0 远
          const bi = Math.min(BUCKETS - 1, Math.max(0, (t * BUCKETS) | 0));
          if (!buckets[bi]) buckets[bi] = [];
          buckets[bi].push(a.x, a.y, b.x, b.y);
        }
      }

      ctx.lineWidth = 0.6;
      for (let b = 0; b < BUCKETS; b++) {
        const seg = buckets[b];
        if (!seg) continue;
        ctx.strokeStyle = 'rgba(96,150,255,' + (((b + 1) / BUCKETS) * 0.20).toFixed(3) + ')';
        ctx.beginPath();
        for (let i = 0; i < seg.length; i += 4) {
          ctx.moveTo(seg[i], seg[i + 1]);
          ctx.lineTo(seg[i + 2], seg[i + 3]);
        }
        ctx.stroke();
      }

      // 手指到附近粒子的连线
      if (ptrOn) {
        ctx.strokeStyle = 'rgba(150,200,255,0.30)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        for (let i = 0; i < P.length; i++) {
          const p = P[i];
          const d = Math.hypot(p.x - px, p.y - py);
          if (d < this.pointerRadius * 0.9) {
            ctx.moveTo(px, py);
            ctx.lineTo(p.x, p.y);
          }
        }
        ctx.stroke();
      }

      // 粒子本体
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        if (p.glow) {
          ctx.fillStyle = 'hsla(' + p.hue + ',92%,68%,' + (p.a * 0.24).toFixed(3) + ')';
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 3.2, 0, TAU);
          ctx.fill();
        }
        ctx.fillStyle = 'hsla(' + p.hue + ',95%,' + (p.glow ? 74 : 64) + '%,' + p.a.toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, TAU);
        ctx.fill();
      }

      // 冲击波圆环
      for (let i = 0; i < this.pulses.length; i++) {
        const pu = this.pulses[i];
        ctx.strokeStyle = 'rgba(140,190,255,' + (pu.life * 0.30).toFixed(3) + ')';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(pu.x, pu.y, pu.r, 0, TAU);
        ctx.stroke();
      }

      ctx.globalCompositeOperation = 'source-over';
    }
  }

  global.ParticleField = ParticleField;

})(typeof window !== 'undefined' ? window : globalThis);
