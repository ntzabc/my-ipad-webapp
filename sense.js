/* ============================================================
   sense.js · 传感器层（摄像头 / 麦克风）
   ------------------------------------------------------------
   纯前端，不联网、不上传。画面只在设备内存里处理，一帧都不出设备。

   里面把"能算的"和"要浏览器的"分开了：
   - 纯函数（色相转换、肤色判定、质心计算、音高换算）→ 可脱离浏览器测试
   - Camera / Mic 类 → 需要 getUserMedia，只能在真机上跑
   ============================================================ */

(function (global) {
  'use strict';

  /* ============================================================
     纯函数部分
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
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255)
    };
  }

  /* 色相环上的最短距离 */
  function hueDist(a, b) {
    let d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /* 经典肤色判定（Kovac et al.）+ YCbCr 双重约束，
     用来在前置摄像头里粗略定位人脸。粗糙但对视差效果足够。 */
  function isSkin(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (!(r > 95 && g > 40 && b > 20 && (mx - mn) > 15 && Math.abs(r - g) > 15 && r > g && r > b)) {
      return false;
    }
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    return cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
  }

  /**
   * 找肤色区域的重心与包围盒
   * @returns {{x,y,bw,bh,mass}|null} 除 mass 外均为 0..1 归一化坐标
   */
  function skinCentroid(img, opts) {
    opts = opts || {};
    const d = img.data, w = img.width, h = img.height;
    const step = opts.step || 2;                 // 隔点采样，省一半时间
    let sx = 0, sy = 0, n = 0;
    let minX = w, maxX = -1, minY = h, maxY = -1;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        if (isSkin(d[i], d[i + 1], d[i + 2])) {
          sx += x; sy += y; n++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const minMass = opts.minMass || Math.max(10, (w * h) / (step * step) * 0.012);
    if (n < minMass || maxX < 0) return null;
    return {
      x: (sx / n) / w,
      y: (sy / n) / h,
      bw: (maxX - minX) / w,
      bh: (maxY - minY) / h,
      mass: n / ((w * h) / (step * step))
    };
  }

  /**
   * 追踪指定色相的物体（光笔涂鸦 / 色彩追踪用）
   * @param {number} targetHue 0..360
   */
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
        if (v > bestV) { bestV = v; }
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

  /**
   * 追踪画面里最亮的一团（光笔涂鸦：拿手机屏幕/手电筒在空中画）
   */
  function trackBrightest(img, opts) {
    opts = opts || {};
    const d = img.data, w = img.width, h = img.height;
    const step = opts.step || 2;
    const floor = opts.floor != null ? opts.floor : 0.72;   // 相对最亮点的阈值

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

  /**
   * 自动取色：看画面中心区域，挑出最鲜艳的那种颜色
   */
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

  /* 频率 → 音名 */
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
      try {
        const stream = await global.navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: this.facing,
            width: { ideal: 640 },
            height: { ideal: 480 }
          },
          audio: false
        });
        this.stream = stream;
        const v = videoEl;
        v.setAttribute('playsinline', '');
        v.setAttribute('autoplay', '');
        v.muted = true;
        v.srcObject = stream;
        try { await v.play(); } catch (_) {}
        this.video = v;
        this.ready = true;
        this.error = null;
        return { ok: true };
      } catch (e) {
        const map = {
          NotAllowedError: '摄像头权限被拒绝。去「设置 → Safari → 摄像头」允许，或直接刷新页面重试',
          SecurityError: '权限被安全策略挡住（独立 App 模式下可能受限，试试用 Safari 直接打开）',
          NotFoundError: '这台设备上没有找到摄像头',
          NotReadableError: '摄像头被其他 App 占用了，先关掉再试',
          OverconstrainedError: '摄像头不支持请求的参数',
          AbortError: '摄像头启动被中断，再试一次'
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
    }

    static supported() {
      return !!(global.navigator && global.navigator.mediaDevices &&
                global.navigator.mediaDevices.getUserMedia &&
                (global.AudioContext || global.webkitAudioContext));
    }

    async start() {
      if (!Mic.supported()) {
        this.error = '这个浏览器不支持麦克风';
        return { ok: false, error: this.error };
      }
      try {
        const AC = global.AudioContext || global.webkitAudioContext;
        this.ctx = new AC();
        this.stream = await global.navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
        const src = this.ctx.createMediaStreamSource(this.stream);
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = this.fftSize;
        this.analyser.smoothingTimeConstant = 0.6;
        src.connect(this.analyser);
        this.freq = new Uint8Array(this.analyser.frequencyBinCount);
        this.time = new Float32Array(this.fftSize);
        if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (_) {} }
        this.ready = true;
        this.error = null;
        return { ok: true };
      } catch (e) {
        const map = {
          NotAllowedError: '麦克风权限被拒绝。去「设置 → Safari → 麦克风」允许后刷新',
          NotFoundError: '没找到麦克风',
          NotReadableError: '麦克风被其他 App 占用'
        };
        this.error = map[e.name] || ((e.name || 'Error') + '：' + e.message);
        return { ok: false, error: this.error };
      }
    }

    stop() {
      if (this.stream) { try { this.stream.getTracks().forEach(t => t.stop()); } catch (_) {} }
      if (this.ctx) { try { this.ctx.close(); } catch (_) {} }
      this.stream = null; this.ctx = null; this.analyser = null; this.ready = false;
    }

    /* 频谱（0..255） */
    readSpectrum() {
      if (!this.ready) return null;
      this.analyser.getByteFrequencyData(this.freq);
      return this.freq;
    }

    /* 音量 0..1 */
    level() {
      if (!this.ready) return 0;
      this.analyser.getFloatTimeDomainData(this.time);
      let s = 0;
      for (let i = 0; i < this.time.length; i++) s += this.time[i] * this.time[i];
      const rms = Math.sqrt(s / this.time.length);
      this.smoothLevel += (rms - this.smoothLevel) * 0.35;
      this._avgLevel += (rms - this._avgLevel) * 0.02;
      return Math.min(1, this.smoothLevel * 4);
    }

    /* 主频（自相关，做了抽取降采样保证速度） */
    pitch() {
      if (!this.ready) return null;
      const n0 = this.fftSize;
      const dec = this.decimate;
      const n = Math.floor(n0 / dec);
      if (!this._dec) this._dec = new Float32Array(n);
      const dec2 = this._dec;
      const t = this.time;
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

    /* 攻击检测（拍手、敲桌子） */
    onset(nowMs) {
      const lv = this.level();
      const isOn = lv > Math.max(0.10, this._avgLevel * 4 * 2.4) && lv > 0.10;
      if (isOn && nowMs - this._lastOnset > 170) {
        this._lastOnset = nowMs;
        this.onsets++;
        return true;
      }
      return false;
    }
  }

  global.Sense = {
    rgb2hsv, hsv2rgb, hueDist, isSkin,
    skinCentroid, trackHue, trackBrightest, autoPickHue,
    freqToNote, midiToFreq, NOTE_NAMES,
    Camera, Mic
  };

})(typeof window !== 'undefined' ? window : globalThis);
