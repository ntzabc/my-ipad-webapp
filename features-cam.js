/* ============================================================
   features-cam.js · 摄像头与声音玩法
   ------------------------------------------------------------
   五个玩法：

     1. 影像 3D 重建   —— 传一张图片 → 找线条 → 找被线条围出的平面
                          → 搭成可以转动、可以凑近看的 3D 模型；
                          再用前置摄像头追踪头部与视线，驱动视差
     2. 视觉算法显微镜 —— 七种真实的计算机视觉算法（不是滤镜）
     3. 光笔涂鸦       —— 前置摄像头追踪亮点或指定颜色
     4. 实时学习机     —— 现场采样本、现场训练一个小神经网络
     5. 声控实验室     —— 频谱 / 波形 / 音高 / 拍手 / 音准挑战

   所有计算都在设备本地完成，一帧画面、一段声音都不上传。

   iOS 上的硬约束（每个玩法都做了应对）：
     · 必须 HTTPS（已满足）
     · 必须在用户点击里调用 getUserMedia
     · AudioContext 必须在点击里创建并 resume，不能等 await 之后再 resume
     · 独立 App（加到主屏幕）模式对摄像头历史上有限制，失败就退回 Safari
   ============================================================ */

(function (global) {
  'use strict';

  const F = global.FEATURES || (global.FEATURES = []);
  const S = global.Sense;
  const V = global.Vision;
  const AI = global.AI;

  const after = fn => requestAnimationFrame(() => requestAnimationFrame(fn));
  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
  const lum = c => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;

  /* ============================================================
     共用小零件
     ============================================================ */

  /* 摄像头启动块：按钮 + 一行状态文字 */
  function camBlock(kit, label, hint) {
    const box = kit.el('div', 'camstart');
    const btn = kit.el('button', 'btn', label);
    btn.type = 'button';
    const msg = kit.el('p', 'note', hint || '');
    box.appendChild(btn);
    box.appendChild(msg);
    return {
      box: box, btn: btn, msg: msg,
      show(text) { box.style.display = ''; if (text) msg.textContent = text; },
      hide() { box.style.display = 'none'; }
    };
  }

  /* 预览窗。注意：没打开时 CSS 会把它挪到屏幕外，
     千万不能用 display:none —— 隐藏的 video 在 Safari 里不解码帧。 */
  function preview(kit, opts) {
    opts = opts || {};
    const wrap = kit.el('div', 'campreview');
    if (opts.small) wrap.classList.add('campreview--sm');
    const v = document.createElement('video');
    v.setAttribute('playsinline', 'true');
    v.setAttribute('webkit-playsinline', 'true');
    v.setAttribute('autoplay', 'true');
    v.playsInline = true;
    v.muted = true;
    v.defaultMuted = true;
    wrap.appendChild(v);
    const dot = kit.el('div', 'campreview__dot');
    wrap.appendChild(dot);
    const bar = kit.el('div', 'campreview__bar');
    wrap.appendChild(bar);
    return { wrap: wrap, video: v, dot: dot, bar: bar };
  }

  /* 水平方向：前置预览是镜像的，画到画布上要翻回来 */
  function flipX(x) { return 1 - x; }

  /* 画布上的拖动 / 双指缩放 */
  function bindDrag(cvEl, onDelta, onPinch) {
    const pts = new Map();
    let last = null, pinch0 = 0;

    cvEl.style.touchAction = 'none';
    cvEl.addEventListener('pointerdown', e => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      last = { x: e.clientX, y: e.clientY };
      if (pts.size === 2) {
        const a = Array.from(pts.values());
        pinch0 = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
      }
      try { cvEl.setPointerCapture(e.pointerId); } catch (_) {}
    });
    cvEl.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size >= 2) {
        const a = Array.from(pts.values());
        const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
        if (pinch0) onPinch(d / pinch0);
        pinch0 = d;
        return;
      }
      if (last) onDelta(e.clientX - last.x, e.clientY - last.y);
      last = { x: e.clientX, y: e.clientY };
    });
    const up = e => {
      pts.delete(e.pointerId);
      last = null;
      if (pts.size < 2) pinch0 = 0;
    };
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(k => cvEl.addEventListener(k, up));
  }

  /* ============================================================
     简易 3D：透视投影 + 画家算法
     世界坐标：x 向右，y 向上，z 是"抬起来的高度"
     ============================================================ */
  function viewPoint(p, eye, yaw, pitch) {
    const x = p[0] - eye[0], y = p[1] - eye[1], z = p[2] - eye[2];
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const rx = x * cy + z * sy;
    const rz = -x * sy + z * cy;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    return [rx, y * cp - rz * sp, y * sp + rz * cp];
  }
  function viewDir(v, yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const rx = v[0] * cy + v[2] * sy;
    const rz = -v[0] * sy + v[2] * cy;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    return [rx, v[1] * cp - rz * sp, v[1] * sp + rz * cp];
  }
  function projectV(v, dist, focal, cw, ch) {
    const zc = v[2] + dist;
    if (zc < 0.25) return null;
    const f = focal / zc;
    return { x: cw / 2 + v[0] * f, y: ch / 2 - v[1] * f, z: zc };
  }
  /* 视空间里的固定光源方向 */
  const LIGHT = (function () {
    const L = [-0.42, 0.62, 0.66];
    const n = Math.hypot(L[0], L[1], L[2]);
    return [L[0] / n, L[1] / n, L[2] / n];
  })();

  /* ============================================================
     一、影像 3D 重建
     ============================================================ */
  F.push({
    id: 'glass3d',
    name: '影像 3D 重建',
    cat: '摄像头',
    desc: '传一张图，自动找出线条与线条围成的平面，搭成能转的 3D 模型；再用前置摄像头追踪你的头，左右一晃画面像一扇真的窗',
    tags: ['3d', '裸眼3d', '立体', '重建', '建模', '视差', '眼动', '头部追踪', '视线', '线条',
           '直线', '平面', '区域', '图片', '照片', '霍夫', '浮雕', '深度'],
    icon: '<path d="M12 2.8 3.2 7.4v9.2L12 21.2l8.8-4.6V7.4z"/><path d="M3.2 7.4 12 12l8.8-4.6"/><path d="M12 12v9.2"/>',
    render(root, kit) {
      const st = {
        img: null, W: 0, H: 0, gray: null, edge: null,
        lines: [], regions: [], relief: null,
        sens: 0.55, minArea: 0.006, mode: 'bright', height: 0.9,
        yaw: -0.55, pitch: -0.52, dist: 3.6, focal: 700,
        auto: true, everDragged: false,
        eye: [0, 0, 0], parallax: 0.6, look: 0,
        tracking: false, cam: null, tracker: null, face: null,
        fx: 0.5, fy: 0.45, fsize: 0.3, eyeInfo: null, lastEye: 0,
        gyro: false, gyroBtn: null,
        fps: 0, seq: 0, ops: 0, ms: 0
      };

      /* ---------- 说明 ---------- */
      root.appendChild(kit.el('p', 'note',
        '流程：灰度 → 边缘 → 霍夫直线 → 区域分割 → 3D 面片。所有步骤都在这台 iPad 上算。'));

      /* ---------- 选图 ---------- */
      const pickRow = kit.el('div', 'mainrow');
      const bPick = kit.el('button', 'btn', '选一张图片');
      bPick.type = 'button';
      const bShot = kit.el('button', 'chip', '现拍一张');
      bShot.type = 'button';
      const bDemo = kit.el('button', 'chip', '用示例图');
      bDemo.type = 'button';
      pickRow.appendChild(bPick);
      pickRow.appendChild(bShot);
      pickRow.appendChild(bDemo);
      root.appendChild(pickRow);

      const fileIn = document.createElement('input');
      fileIn.type = 'file';
      fileIn.accept = 'image/*';
      fileIn.style.display = 'none';
      const camIn = document.createElement('input');
      camIn.type = 'file';
      camIn.accept = 'image/*';
      camIn.setAttribute('capture', 'environment');
      camIn.style.display = 'none';
      root.appendChild(fileIn);
      root.appendChild(camIn);

      bPick.addEventListener('click', () => fileIn.click());
      bShot.addEventListener('click', () => camIn.click());
      bDemo.addEventListener('click', () => { setSource(makeSample()); kit.toast('示例图已载入'); });
      fileIn.addEventListener('change', e => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (f) loadFile(f);
      });
      camIn.addEventListener('change', e => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (f) loadFile(f);
      });

      /* ---------- 分析步骤条 ---------- */
      const stepBar = kit.el('div', 'stepbar');
      const STEP_NAMES = ['灰度', '边缘', '直线', '区域', '3D'];
      const stepEls = STEP_NAMES.map(n => {
        const e = kit.el('span', 'step', n);
        stepBar.appendChild(e);
        return e;
      });
      const stepInfo = kit.el('span', 'stepbar__info', '还没载入图片');
      stepBar.appendChild(stepInfo);
      root.appendChild(stepBar);

      /* ---------- 3D 画布 ---------- */
      const cvWrap = kit.el('div', 'cvlayer');
      const c3 = kit.makeCanvas(cvWrap, 0.68);
      root.appendChild(cvWrap);
      bindDrag(c3.cv,
        (dx, dy) => {
          if (!st.relief) return;
          st.yaw += dx * 0.009;
          st.pitch = clamp(st.pitch + dy * 0.007, -1.45, 0.35);
          st.everDragged = true;
          st.auto = false;
          syncView();
        },
        ratio => {
          if (!st.relief) return;
          st.dist = clamp(st.dist / ratio, 1.4, 12);
          syncView();
        });

      const viewRow = kit.el('div', 'chiprow');
      const bAuto = kit.el('button', 'chip chip--on', '自动旋转');
      bAuto.type = 'button';
      bAuto.addEventListener('click', () => {
        st.auto = !st.auto;
        bAuto.classList.toggle('chip--on', st.auto);
      });
      const bReset = kit.el('button', 'chip chip--sm', '复位视角');
      bReset.type = 'button';
      bReset.addEventListener('click', () => {
        st.yaw = -0.55; st.pitch = -0.52; st.dist = 3.6;
        st.everDragged = false;
        syncView();
      });
      viewRow.appendChild(bAuto);
      viewRow.appendChild(bReset);
      const bP = kit.el('button', 'chip chip--sm', '换高度方式');
      bP.type = 'button';
      bP.addEventListener('click', () => {
        const order = ['bright', 'area', 'layer'];
        const names = { bright: '明度', area: '面积', layer: '层叠' };
        st.mode = order[(order.indexOf(st.mode) + 1) % order.length];
        bP.textContent = '高度：' + names[st.mode];
        rebuildRelief();
      });
      viewRow.appendChild(bP);
      root.appendChild(viewRow);
      root.appendChild(kit.el('p', 'note', '在画面上拖动可以转，双指捏合缩放。'));

      /* ---------- 参数 ---------- */
      const prm = kit.el('div', 'params');
      let anaTimer = 0;
      function scheduleAnalyze() {
        clearTimeout(anaTimer);
        anaTimer = setTimeout(() => { if (st.img) startAnalyze(); }, 170);
      }
      makeSlider(prm, kit, '边缘灵敏度', 0, 100, st.sens * 100, v => {
        st.sens = v / 100;
        scheduleAnalyze();
      });
      makeSlider(prm, kit, '保留区域', 0, 100, st.minArea * 2000, v => {
        st.minArea = v / 2000;
        scheduleAnalyze();
      });
      makeSlider(prm, kit, '层高', 10, 200, st.height * 100, v => {
        st.height = v / 100;
        rebuildRelief();
      });
      root.appendChild(prm);

      /* ---------- 双视图 ---------- */
      const thumbRow = kit.el('div', 'thumbs');
      const tw1 = kit.el('div', 'thumb');
      tw1.appendChild(kit.el('span', 'thumb__k', '原图'));
      const cSrc = kit.makeCanvas(tw1, 0.72);
      const tw2 = kit.el('div', 'thumb');
      tw2.appendChild(kit.el('span', 'thumb__k', '边缘 + 直线 + 区域'));
      const cEdge = kit.makeCanvas(tw2, 0.72);
      thumbRow.appendChild(tw1);
      thumbRow.appendChild(tw2);
      root.appendChild(thumbRow);

      /* ---------- 统计 ---------- */
      const stats = kit.el('div', 'statgrid');
      const sRegions = kit.stat(stats, '平面区域', '0');
      const sLines = kit.stat(stats, '直线', '0');
      const sFaces = kit.stat(stats, '3D 面片', '0');
      const sFps = kit.stat(stats, '帧率', '—');
      root.appendChild(stats);
      const msNote = kit.el('p', 'note', '');
      root.appendChild(msNote);

      /* ---------- 头部 / 视线追踪 ---------- */
      root.appendChild(kit.el('h3', 'subhead', '头部与视线追踪'));
      root.appendChild(kit.el('p', 'note',
        '用前置摄像头找你的脸，然后左右晃头、凑近凑远。画面会跟着你的位置变，像一扇真的窗。' +
        '打不开也没关系 —— 手指拖动一样能转，效果不会少。'));

      const pv = preview(kit, { small: true });
      root.appendChild(pv.wrap);

      const blk = camBlock(kit, '开始头部追踪',
        '会请求摄像头权限。画面只在本机处理，不录制、不上传。');
      root.appendChild(blk.box);

      const trkRow = kit.el('div', 'chiprow');
      const bGrav = kit.el('button', 'chip chip--sm', '用重力感应代替');
      bGrav.type = 'button';
      trkRow.appendChild(bGrav);
      root.appendChild(trkRow);

      const trkInfo = kit.el('p', 'note', '追踪未开启。');
      root.appendChild(trkInfo);

      const prm2 = kit.el('div', 'params');
      makeSlider(prm2, kit, '视差强度', 0, 150, st.parallax * 100, v => { st.parallax = v / 100; });
      root.appendChild(prm2);

      /* ============================================================
         逻辑
         ============================================================ */

      function makeSlider(parent, kit2, label, min, max, val, onInput) {
        const w = kit2.el('div', 'param');
        w.appendChild(kit2.el('span', 'param__k', label));
        const inp = document.createElement('input');
        inp.type = 'range';
        inp.className = 'slider';
        inp.min = String(min); inp.max = String(max); inp.value = String(val);
        const out = kit2.el('span', 'param__v', '');
        function show() {
          out.textContent = inp.value;
          onInput(Number(inp.value));
        }
        inp.addEventListener('input', show);
        w.appendChild(inp);
        w.appendChild(out);
        parent.appendChild(w);
        out.textContent = inp.value;
        return { input: inp, set(v) { inp.value = String(v); out.textContent = String(v); } };
      }

      /* --- 示例图：一个透视线稿房间，方便立刻看到效果 --- */
      function makeSample() {
        const W = 220, H = 165;
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const g = cv.getContext('2d');
        g.fillStyle = '#2A3550'; g.fillRect(0, 0, W, H);
        g.fillStyle = '#3C4A6B'; g.fillRect(14, 14, W - 28, H * 0.44);          // 后墙
        g.fillStyle = '#232C44'; g.fillRect(14, H * 0.44 + 14, W - 28, H - 14); // 地面
        g.fillStyle = '#4A5B82'; g.fillRect(14, 14, 46, H * 0.44);              // 左墙

        g.strokeStyle = '#0B1020'; g.lineWidth = 3; g.lineCap = 'round';
        const line = (a, b, c, d) => { g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke(); };
        line(14, 14, W - 14, 14);
        line(W - 14, 14, W - 14, H - 14);
        line(W - 14, H - 14, 14, H - 14);
        line(14, H - 14, 14, 14);
        line(60, 14, 60, H - 14);
        line(14, H * 0.44 + 14, W - 14, H * 0.44 + 14);
        line(60, H * 0.30, W * 0.52, H * 0.30);              // 窗口上沿
        line(60, H * 0.62, W * 0.52, H * 0.62);              // 窗口下沿
        line(W * 0.52, H * 0.30, W * 0.52, H * 0.62);
        line(60, H * 0.30, 60, H * 0.62);
        line(120, H * 0.62, 180, H - 14);
        line(178, H * 0.62, 178, H - 14);
        line(120, H * 0.62, 178, H * 0.62);
        return g.getImageData(0, 0, W, H);
      }

      function loadFile(file) {
        if (!file || !/^image\//.test(file.type)) { kit.toast('请选一张图片'); return; }
        const url = URL.createObjectURL(file);
        const im = new Image();
        im.onload = () => {
          try {
            const maxW = 236;
            const sc = Math.min(1, maxW / Math.max(1, im.width));
            const W = Math.max(40, Math.round(im.width * sc));
            const H = Math.max(40, Math.round(im.height * sc));
            const cv = document.createElement('canvas');
            cv.width = W; cv.height = H;
            const g = cv.getContext('2d');
            g.drawImage(im, 0, 0, W, H);
            setSource(g.getImageData(0, 0, W, H));
            kit.toast('已载入 ' + W + '×' + H + ' 的图');
          } catch (_) { kit.toast('这张图读不出来，换一张试试'); }
          URL.revokeObjectURL(url);
        };
        im.onerror = () => { kit.toast('这张图读不出来，换一张试试'); URL.revokeObjectURL(url); };
        im.src = url;
      }

      function setSource(imgData) {
        st.img = imgData;
        st.W = imgData.width;
        st.H = imgData.height;
        st.gray = null; st.edge = null; st.lines = []; st.regions = []; st.relief = null;
        cSrc.cv.style.width = '100%';
        startAnalyze();
      }

      /* --- 分步分析：每步之间让出一帧，界面才画得动 --- */
      function startAnalyze() {
        if (!st.img) return;
        const seq = ++st.seq;
        const W = st.W, H = st.H;
        stepEls.forEach(e => { e.className = 'step'; });
        const t0 = performance.now();

        const jobs = [
          ['灰度', () => { st.gray = V.toGray(st.img, W, H); }],
          ['边缘', () => { st.edge = V.edgeMap(st.gray, W, H, { hiFrac: 0.55 - st.sens * 0.50, loFrac: 0.42 }); }],
          ['直线', () => { st.lines = V.houghLines(st.edge, W, H, { maxLines: 40 }); }],
          ['区域', () => {
            st.regions = V.findRegions(st.edge, st.img, W, H, {
              minArea: 40 + W * H * (0.0015 + st.minArea * 2),
              eps: Math.max(2.2, Math.max(W, H) / 90),
              maxRegions: 32,
              dilate: 1
            });
          }],
          ['3D', () => { st.relief = V.buildRelief(st.regions, { mode: st.mode, height: st.height }); }]
        ];

        let i = 0;
        function step() {
          if (seq !== st.seq) return;
          if (i >= jobs.length) {
            st.ms = Math.round(performance.now() - t0);
            stepInfo.textContent = '分析完成，用了 ' + st.ms + ' ms';
            stepEls.forEach(e => { e.className = 'step is-done'; });
            updateStats();
            drawSrc();
            drawEdge();
            return;
          }
          stepEls[i].className = 'step is-on';
          stepInfo.textContent = '正在算：' + jobs[i][0];
          try { jobs[i][1](); } catch (err) { stepInfo.textContent = '出错：' + (err.message || err); return; }
          i++;
          setTimeout(step, 0);
        }
        step();
      }

      function rebuildRelief() {
        if (!st.regions.length) return;
        st.relief = V.buildRelief(st.regions, { mode: st.mode, height: st.height });
        updateStats();
      }

      function updateStats() {
        sRegions.textContent = String(st.regions.length);
        sLines.textContent = String(st.lines.length);
        sFaces.textContent = st.relief ? String(st.relief.faces.length) : '0';
        msNote.textContent = st.ms
          ? '从像素到 3D 一共 ' + st.ms + ' ms（含全部五步）'
          : '还没分析过。选一张线条清楚的图效果最好，比如房间、家具、纸张涂鸦。';
      }

      /* --- 2D 小图 --- */
      function drawSrc() {
        const ctx = cSrc.ctx, w = cSrc.w, h = cSrc.h;
        if (!w || !h || !st.img) return;
        const off = document.createElement('canvas');
        off.width = st.W; off.height = st.H;
        off.getContext('2d').putImageData(st.img, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#050B18'; ctx.fillRect(0, 0, w, h);
        const s = Math.min(w / st.W, h / st.H);
        const dw = st.W * s, dh = st.H * s;
        ctx.drawImage(off, (w - dw) / 2, (h - dh) / 2, dw, dh);
      }

      function drawEdge() {
        const ctx = cEdge.ctx, w = cEdge.w, h = cEdge.h;
        if (!w || !h || !st.edge) return;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#050B18'; ctx.fillRect(0, 0, w, h);
        const s = Math.min(w / st.W, h / st.H);
        const ox = (w - st.W * s) / 2, oy = (h - st.H * s) / 2;

        // 边缘像素
        ctx.fillStyle = 'rgba(120,175,255,.55)';
        const px = Math.max(1, Math.ceil(s));
        for (let y = 0; y < st.H; y++) {
          for (let x = 0; x < st.W; x++) {
            if (st.edge[y * st.W + x]) ctx.fillRect(ox + x * s, oy + y * s, px, px);
          }
        }
        // 区域轮廓，用区域自己的颜色描出来
        st.regions.forEach(r => {
          if (r.polygon.length < 3) return;
          ctx.beginPath();
          r.polygon.forEach((p, k) => {
            const X = ox + p[0] * s, Y = oy + p[1] * s;
            if (k) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
          });
          ctx.closePath();
          ctx.strokeStyle = 'rgba(' + r.color[0] + ',' + r.color[1] + ',' + r.color[2] + ',.95)';
          ctx.lineWidth = 1.4;
          ctx.stroke();
        });
        // 霍夫直线
        ctx.strokeStyle = 'rgba(255,214,120,.85)';
        ctx.lineWidth = 1.2;
        st.lines.forEach(L => {
          ctx.beginPath();
          ctx.moveTo(ox + L.x1 * s, oy + L.y1 * s);
          ctx.lineTo(ox + L.x2 * s, oy + L.y2 * s);
          ctx.stroke();
        });
      }

      /* --- 3D 主渲染 --- */
      function draw3D() {
        const ctx = c3.ctx, w = c3.w, h = c3.h;
        if (!w || !h) return;
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, '#071228');
        g.addColorStop(1, '#04091A');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);

        const focal = st.focal * (w / 640);
        const eye = st.eye;

        // 地面网格（给空间感，也顺便当比例尺）
        ctx.strokeStyle = 'rgba(90,140,220,.13)';
        ctx.lineWidth = 1;
        for (let i = -4; i <= 4; i++) {
          const t = i * 0.45;
          const a = projectV(viewPoint([t, -1.5, 0], eye, st.yaw, st.pitch), st.dist, focal, w, h);
          const b = projectV(viewPoint([t, 1.5, 0], eye, st.yaw, st.pitch), st.dist, focal, w, h);
          const c = projectV(viewPoint([-1.5, t, 0], eye, st.yaw, st.pitch), st.dist, focal, w, h);
          const d = projectV(viewPoint([1.5, t, 0], eye, st.yaw, st.pitch), st.dist, focal, w, h);
          if (a && b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
          if (c && d) { ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke(); }
        }

        const rel = st.relief;
        if (!rel || !rel.faces.length) {
          ctx.fillStyle = 'rgba(255,255,255,.34)';
          ctx.font = '13px -apple-system, sans-serif';
          ctx.fillText('先选一张图片，或者点「用示例图」', 16, h / 2);
          return;
        }

        // 投影 + 光照，按深度排序后从远到近画
        const list = [];
        for (let i = 0; i < rel.faces.length; i++) {
          const f = rel.faces[i];
          const pts = f.pts;
          const vp = [];
          let ok = true, zsum = 0;
          for (let k = 0; k < pts.length; k++) {
            const v = viewPoint(pts[k], eye, st.yaw, st.pitch);
            const p2 = projectV(v, st.dist, focal, w, h);
            if (!p2) { ok = false; break; }
            vp.push(p2);
            zsum += p2.z;
          }
          if (!ok) continue;

          // 法线（世界坐标算，转到视空间做明暗）
          const a = pts[0], b = pts[1], c = pts[2];
          const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
          const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
          let nx = uy * vz - uz * vy;
          let ny = uz * vx - ux * vz;
          let nz = ux * vy - uy * vx;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl; ny /= nl; nz /= nl;
          if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }        // 单面，朝上为准
          const nv = viewDir([nx, ny, nz], st.yaw, st.pitch);
          const dotL = Math.max(0, nv[0] * LIGHT[0] + nv[1] * LIGHT[1] + nv[2] * LIGHT[2]);
          const shade = 0.34 + 0.78 * dotL;

          list.push({
            vp: vp,
            z: zsum / pts.length,
            col: f.color,
            shade: shade,
            top: f.kind === 'top'
          });
        }
        list.sort((p, q) => q.z - p.z);

        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          const c = it.col, sh = it.shade;
          ctx.fillStyle = 'rgb(' +
            clamp(Math.round(c[0] * sh), 0, 255) + ',' +
            clamp(Math.round(c[1] * sh), 0, 255) + ',' +
            clamp(Math.round(c[2] * sh), 0, 255) + ')';
          ctx.beginPath();
          ctx.moveTo(it.vp[0].x, it.vp[0].y);
          for (let k = 1; k < it.vp.length; k++) ctx.lineTo(it.vp[k].x, it.vp[k].y);
          ctx.closePath();
          ctx.fill();
          if (it.top) {
            ctx.strokeStyle = 'rgba(255,255,255,.16)';
            ctx.lineWidth = 0.8;
            ctx.stroke();
          }
        }

        // 视线焦点
        if (st.tracking && st.eyeInfo) {
          const rx = w / 2 + st.eyeInfo.gazeX * w * 0.06;
          const ry = h / 2 + st.eyeInfo.gazeY * h * 0.05;
          const rg = ctx.createRadialGradient(rx, ry, 2, rx, ry, Math.min(w, h) * 0.24);
          rg.addColorStop(0, 'rgba(140,255,220,.30)');
          rg.addColorStop(1, 'rgba(140,255,220,0)');
          ctx.fillStyle = rg;
          ctx.beginPath();
          ctx.arc(rx, ry, Math.min(w, h) * 0.24, 0, 6.2832);
          ctx.fill();
        }

        // 状态角标
        ctx.fillStyle = 'rgba(255,255,255,.36)';
        ctx.font = '11px -apple-system, sans-serif';
        ctx.fillText(st.fps + ' fps · ' + rel.faces.length + ' 面片' +
          (st.auto ? ' · 自动旋转' : ''), 10, h - 9);
      }

      function syncView() {
        /* 视角只在绘制循环里读，这里只负责在参数变化时刷新一次 */
      }

      /* --- 摄像头追踪 --- */
      async function startTrack() {
        if (!st.cam) st.cam = new S.Camera({ facing: 'user', procW: 160, procH: 120 });
        blk.msg.textContent = '正在请求权限…';
        const r = await st.cam.start(pv.video);
        if (!r.ok) {
          blk.show('摄像头打不开：' + r.error);
          kit.toast('摄像头不可用，用手指拖动一样能转');
          return;
        }
        pv.wrap.classList.add('is-on');
        blk.hide();
        st.tracking = true;
        st.tracker = new S.HeadTracker();
        kit.toast(r.warn ? '已开启，但没拿到画面' : '追踪已开启');
      }

      function stopTrack() {
        st.tracking = false;
        if (st.cam) st.cam.stop();
        pv.wrap.classList.remove('is-on');
        pv.dot.classList.remove('is-lock');
        blk.show('会请求摄像头权限。画面只在本机处理，不录制、不上传。');
        trkInfo.textContent = '追踪已关闭，可以继续用手指拖动。';
      }

      bTrackToggle();
      function bTrackToggle() {
        blk.btn.addEventListener('click', () => {
          if (st.tracking) stopTrack(); else startTrack();
        });
      }

      /* 重力感应退路 */
      function orient(e) {
        if (e.gamma == null || e.beta == null) return;
        st.gyroTilt = { g: clamp(e.gamma || 0, -60, 60), b: clamp((e.beta || 0) - 45, -60, 60) };
      }
      bGrav.addEventListener('click', async () => {
        if (st.gyro) {
          global.removeEventListener('deviceorientation', orient);
          st.gyro = false;
          st.gyroTilt = null;
          bGrav.classList.remove('chip--on');
          trkInfo.textContent = '重力感应已关闭。';
          return;
        }
        const D = global.DeviceOrientationEvent;
        if (!D) { kit.toast('这台设备没有方向传感器'); return; }
        try {
          if (typeof D.requestPermission === 'function') {
            const res = await D.requestPermission();
            if (res !== 'granted') { kit.toast('重力感应权限被拒绝（iOS 要求在弹出的框里点允许）'); return; }
          }
          global.addEventListener('deviceorientation', orient, { passive: true });
          st.gyro = true;
          bGrav.classList.add('chip--on');
          trkInfo.textContent = '重力感应已开启，倾斜 iPad 试试。';
        } catch (_) { kit.toast('这台设备用不了重力感应'); }
      });

      /* --- 主循环 --- */
      let raf = 0, last = 0, frames = 0, fpsT = 0, fpsN = 0;

      function loop(ts) {
        raf = requestAnimationFrame(loop);
        if (!last) last = ts;
        const dt = ts - last;
        last = ts;
        if (dt < 14) return;
        frames++;
        fpsN++;
        if (!fpsT) fpsT = ts;
        if (ts - fpsT > 600) {
          st.fps = Math.round(fpsN * 1000 / (ts - fpsT));
          fpsT = ts; fpsN = 0;
          sFps.textContent = st.fps ? st.fps + '' : '—';
        }

        if (st.auto && !st.everDragged) st.yaw += 0.0055;

        /* 追踪：每帧找脸，每 200ms 估一次眼睛区域（更贵） */
        if (st.tracking && st.cam && st.cam.ready) {
          const frame = st.cam.grab();
          if (frame) {
            const f = st.tracker.update(frame);
            if (f) {
              st.face = f;
              st.fx += (f.x - st.fx) * 0.22;
              st.fy += (f.y - st.fy) * 0.22;
              st.fsize += (f.bh - st.fsize) * 0.16;
              if (ts - st.lastEye > 200) {
                st.lastEye = ts;
                st.eyeInfo = S.eyeRegion(frame, f);
              }
              pv.dot.style.left = (flipX(f.x) * 100) + '%';
              pv.dot.style.top = (f.y * 100) + '%';
              pv.dot.classList.add('is-lock');
              pv.bar.style.width = clamp(f.conf * 100, 0, 100) + '%';
              const e = st.eyeInfo;
              trkInfo.textContent = '已锁定：位置 ' + Math.round(f.x * 100) + '% / ' +
                Math.round(f.y * 100) + '%，置信度 ' + Math.round(f.conf * 100) + '%' +
                (e ? '，视线 ' + (e.gazeX >= 0 ? '偏右' : '偏左') + ' ' + Math.abs(Math.round(e.gazeX * 100)) + '%' : '');
            } else {
              pv.dot.classList.remove('is-lock');
              trkInfo.textContent = '正在找脸…把脸放进取景框，光线别太暗。';
            }
          }
        }

        /* 眼睛位置 → 视差 */
        let ex = 0, ey = 0, ez = 0;
        if (st.tracking && st.face) {
          ex = (st.fx - 0.5) * 2 * st.parallax;
          ey = -(st.fy - 0.5) * 2 * st.parallax * 0.7;
          ez = (0.32 - st.fsize) * 2.6;                 // 脸变小＝人退后，镜头跟着退
        } else if (st.gyro && st.gyroTilt) {
          ex = -(st.gyroTilt.g / 60) * st.parallax * 1.1;
          ey = (st.gyroTilt.b / 60) * st.parallax * 0.8;
        }
        st.eye[0] += (ex - st.eye[0]) * 0.16;
        st.eye[1] += (ey - st.eye[1]) * 0.16;
        st.eye[2] += (ez - st.eye[2]) * 0.10;

        draw3D();
      }

      cSrc.onResize(() => { drawSrc(); drawEdge(); });
      cEdge.onResize(() => { drawSrc(); drawEdge(); });

      after(() => { raf = requestAnimationFrame(loop); });
      updateStats();

      return () => {
        cancelAnimationFrame(raf);
        if (st.cam) st.cam.stop();
        global.removeEventListener('deviceorientation', orient);
      };
    }
  });

  /* ============================================================
     二、视觉算法显微镜 —— 七种真实的计算机视觉算法
     ============================================================ */
  const ALGOS = [
    { k: 'sobel', n: 'Sobel 梯度', d: '一阶导数近似：亮的地方是边缘，色调表示边缘方向。' },
    { k: 'canny', n: 'Canny 边缘', d: '非极大值抑制 + 双阈值 + 滞后连接，最经典的边缘算子。' },
    { k: 'kmeans', n: 'K-means 聚类', d: '把像素按颜色聚成 K 类，反复迭代到中心不再动 —— 无监督学习。' },
    { k: 'conv', n: '卷积核', d: '同一个 3×3 窗口换个系数就是不同算子：锐化、浮雕、拉普拉斯都靠它。' },
    { k: 'flow', n: '运动光流', d: '相邻两帧做差分，估出每个位置的运动方向和强度，画成矢量场。' },
    { k: 'skin', n: '肤色分割', d: 'YCbCr 色度阈值把皮肤从背景里分出来，是最便宜的人体检测。' },
    { k: 'relief', n: '实时 3D 浮雕', d: '对画面跑一遍完整的边缘+区域管线，把围出来的面当场抬起来。' }
  ];
  const KERNELS = {
    '高斯模糊': [1, 2, 1, 2, 4, 2, 1, 2, 1, 16],
    '锐化': [0, -1, 0, -1, 5, -1, 0, -1, 0, 1],
    '浮雕': [-2, -1, 0, -1, 1, 1, 0, 1, 2, 1],
    '拉普拉斯': [0, 1, 0, 1, -4, 1, 0, 1, 0, 1],
    '水平边缘': [-1, -2, -1, 0, 0, 0, 1, 2, 1, 1]
  };

  F.push({
    id: 'camfx',
    name: '视觉算法显微镜',
    cat: '摄像头',
    desc: '把摄像头变成一台计算机视觉实验台：七种真算法逐帧跑，从梯度、边缘到聚类、光流',
    tags: ['计算机视觉', 'cv', '边缘', 'canny', 'sobel', '卷积', 'kmeans', '聚类',
           '光流', '肤色', '分割', '算法', '显微镜', '摄像头'],
    icon: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5 21 21M11 8v6M8 11h6"/>',
    render(root, kit) {
      const PW = 176, PH = 132;
      const st = {
        algo: 'canny', facing: 'environment', running: false, cam: null, ready: false,
        K: 4, kern: '锐化', sens: 0.5, ms: 0, fps: 0,
        centers: null, cenTick: 0, iter: 0,
        prev: null, relief: null, reliefTick: 0,
        out: null, off: null, offCtx: null, frame: null, count: 0
      };

      const pv = preview(kit, { small: true });
      pv.wrap.classList.add('campreview--nomirror');      // 默认后置，不镜像
      root.appendChild(pv.wrap);

      const blk = camBlock(kit, '打开摄像头',
        '会请求摄像头权限。画面只在内存里逐帧处理，不录制、不上传。');
      root.appendChild(blk.box);

      /* 算法选择 */
      const row = kit.el('div', 'chiprow');
      const chips = ALGOS.map(a => {
        const b = kit.el('button', 'chip' + (a.k === st.algo ? ' chip--on' : ''), a.n);
        b.type = 'button';
        b.addEventListener('click', () => {
          st.algo = a.k;
          chips.forEach((c, i) => c.classList.toggle('chip--on', ALGOS[i].k === a.k));
          desc.textContent = a.d;
          paramRow.style.display = (a.k === 'kmeans' || a.k === 'conv' || a.k === 'canny') ? '' : 'none';
          if (a.k === 'kmeans') st.centers = null;
        });
        row.appendChild(b);
        return b;
      });
      root.appendChild(row);

      const desc = kit.el('p', 'note', ALGOS[0].d);
      desc.textContent = ALGOS.find(a => a.k === st.algo).d;
      root.appendChild(desc);

      /* 参数 */
      const paramRow = kit.el('div', 'params');
      const kBox = kit.el('div', 'param');
      kBox.appendChild(kit.el('span', 'param__k', '聚类数 K'));
      const kIn = document.createElement('input');
      kIn.type = 'range'; kIn.className = 'slider'; kIn.min = '2'; kIn.max = '8'; kIn.value = String(st.K);
      const kOut = kit.el('span', 'param__v', String(st.K));
      kIn.addEventListener('input', () => { st.K = Number(kIn.value); kOut.textContent = kIn.value; st.centers = null; });
      kBox.appendChild(kIn); kBox.appendChild(kOut);
      paramRow.appendChild(kBox);

      const cBox = kit.el('div', 'param');
      cBox.appendChild(kit.el('span', 'param__k', '卷积核'));
      const cSel = document.createElement('select');
      cSel.className = 'param__v';
      Object.keys(KERNELS).forEach(k => {
        const o = document.createElement('option');
        o.value = k; o.textContent = k;
        cSel.appendChild(o);
      });
      cSel.value = st.kern;
      cSel.addEventListener('change', () => { st.kern = cSel.value; });
      cBox.appendChild(cSel);
      paramRow.appendChild(cBox);

      const sBox = kit.el('div', 'param');
      sBox.appendChild(kit.el('span', 'param__k', '阈值'));
      const sIn = document.createElement('input');
      sIn.type = 'range'; sIn.className = 'slider'; sIn.min = '10'; sIn.max = '90'; sIn.value = String(st.sens * 100);
      const sOut = kit.el('span', 'param__v', String(Math.round(st.sens * 100)));
      sIn.addEventListener('input', () => { st.sens = Number(sIn.value) / 100; sOut.textContent = sIn.value; });
      sBox.appendChild(sIn); sBox.appendChild(sOut);
      paramRow.appendChild(sBox);
      paramRow.style.display = 'none';
      root.appendChild(paramRow);

      /* 输出画布 */
      const outWrap = kit.el('div', 'cvlayer');
      const cOut = kit.makeCanvas(outWrap, PH / PW);
      root.appendChild(outWrap);
      root.appendChild(kit.el('p', 'note', '上面这块是算法处理后的画面，左上的小窗是原始画面。'));

      /* 操作 */
      const opRow = kit.el('div', 'chiprow');
      const bFlip = kit.el('button', 'chip chip--sm', '切换前后镜头');
      bFlip.type = 'button';
      const bPause = kit.el('button', 'chip chip--sm', '暂停');
      bPause.type = 'button';
      const bFreeze = kit.el('button', 'chip chip--sm', '冻结当前帧');
      bFreeze.type = 'button';
      opRow.appendChild(bFlip); opRow.appendChild(bPause); opRow.appendChild(bFreeze);
      root.appendChild(opRow);

      const stats = kit.el('div', 'statgrid');
      const sMs = kit.stat(stats, '单帧算法', '—');
      const sFps = kit.stat(stats, '帧率', '—');
      const sRes = kit.stat(stats, '处理分辨率', PW + '×' + PH);
      const sIter = kit.stat(stats, 'K-means 迭代', '0');
      root.appendChild(stats);

      /* ---------- 处理核心 ---------- */
      function ensureBuffers() {
        if (!st.off) {
          st.off = document.createElement('canvas');
          st.off.width = PW; st.off.height = PH;
          st.offCtx = st.off.getContext('2d');
          st.out = st.offCtx.createImageData(PW, PH);
        }
      }

      function grayOf(img) {
        const d = img.data, n = img.width * img.height;
        const g = new Float32Array(n);
        for (let i = 0, p = 0; p < n; p++, i += 4) g[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        return g;
      }

      /* K-means：每 K 帧重新跑一次完整迭代，中间帧用最近的中心做归属 */
      function kmeansFit(img, K, iters) {
        const d = img.data, n = img.width * img.height;
        const step = 3;
        const smp = [];
        for (let p = 0; p < n; p += step) { const i = p * 4; smp.push([d[i], d[i + 1], d[i + 2]]); }
        if (!smp.length) return null;
        const cen = [];
        for (let k = 0; k < K; k++) {
          cen.push(smp[Math.min(smp.length - 1, Math.floor(smp.length * (k + 0.5) / K))].slice());
        }
        for (let it = 0; it < iters; it++) {
          const sr = new Float64Array(K), sg = new Float64Array(K), sb = new Float64Array(K);
          const cnt = new Int32Array(K);
          for (let s = 0; s < smp.length; s++) {
            const p = smp[s];
            let bi = 0, bd = Infinity;
            for (let k = 0; k < K; k++) {
              const c = cen[k];
              const dd = (p[0] - c[0]) * (p[0] - c[0]) + (p[1] - c[1]) * (p[1] - c[1]) + (p[2] - c[2]) * (p[2] - c[2]);
              if (dd < bd) { bd = dd; bi = k; }
            }
            sr[bi] += p[0]; sg[bi] += p[1]; sb[bi] += p[2]; cnt[bi]++;
          }
          for (let k = 0; k < K; k++) {
            if (!cnt[k]) { cen[k] = smp[Math.floor(smp.length * Math.random())].slice(); continue; }
            cen[k] = [sr[k] / cnt[k], sg[k] / cnt[k], sb[k] / cnt[k]];
          }
        }
        st.iter += iters;
        return cen;
      }

      function convolve(g, w, h, kern) {
        const out = new Float32Array(w * h);
        const div = kern[9] || 1;
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const p = y * w + x;
            let s = 0;
            s += g[p - w - 1] * kern[0] + g[p - w] * kern[1] + g[p - w + 1] * kern[2];
            s += g[p - 1] * kern[3] + g[p] * kern[4] + g[p + 1] * kern[5];
            s += g[p + w - 1] * kern[6] + g[p + w] * kern[7] + g[p + w + 1] * kern[8];
            out[p] = s / div;
          }
        }
        return out;
      }

      function downsample(img, w2, h2) {
        const cv = document.createElement('canvas');
        cv.width = img.width; cv.height = img.height;
        cv.getContext('2d').putImageData(img, 0, 0);
        const cv2 = document.createElement('canvas');
        cv2.width = w2; cv2.height = h2;
        const g2 = cv2.getContext('2d');
        g2.drawImage(cv, 0, 0, w2, h2);
        return g2.getImageData(0, 0, w2, h2);
      }

      function process(frame) {
        ensureBuffers();
        const d = frame.data, o = st.out.data, n = PW * PH;
        const t0 = performance.now();

        switch (st.algo) {
          case 'sobel': {
            const g = grayOf(frame);
            const sm = V.blur3(g, PW, PH);
            const sb = V.sobel(sm, PW, PH);
            let peak = 1;
            for (let p = 0; p < n; p++) if (sb.mag[p] > peak) peak = sb.mag[p];
            for (let p = 0, i = 0; p < n; p++, i += 4) {
              const v = Math.min(1, sb.mag[p] / peak * 1.6);
              let ang = Math.atan2(sb.dir[p], 1) * 180 / Math.PI;
              if (ang < 0) ang += 180;
              const hh = ang / 180 * 360;
              const c = S.hsv2rgb(hh, 0.85, v);
              o[i] = c[0]; o[i + 1] = c[1]; o[i + 2] = c[2]; o[i + 3] = 255;
            }
            break;
          }
          case 'canny': {
            const g = grayOf(frame);
            const e = V.edgeMap(g, PW, PH, { hiFrac: 0.6 - st.sens * 0.55, loFrac: 0.42 });
            for (let p = 0, i = 0; p < n; p++, i += 4) {
              const v = e[p] ? 255 : Math.round(d[i] * 0.20);
              o[i] = e[p] ? 190 : v; o[i + 1] = e[p] ? 235 : v; o[i + 2] = e[p] ? 255 : v; o[i + 3] = 255;
            }
            break;
          }
          case 'kmeans': {
            // 中心固定住就不会被单帧噪声带偏，但场景换了要能跟上 ——
            // 所以每帧都做归属，隔一阵子重拟合一次。
            if (!st.centers || st.count % 90 === 0) {
              st.centers = kmeansFit(frame, st.K, 3);
              sIter.textContent = String(st.iter);
            }
            const cen = st.centers;
            for (let p = 0, i = 0; p < n; p++, i += 4) {
              let bi = 0, bd = Infinity;
              for (let k = 0; k < cen.length; k++) {
                const c = cen[k];
                const dd = (d[i] - c[0]) * (d[i] - c[0]) + (d[i + 1] - c[1]) * (d[i + 1] - c[1]) + (d[i + 2] - c[2]) * (d[i + 2] - c[2]);
                if (dd < bd) { bd = dd; bi = k; }
              }
              const c = cen[bi];
              o[i] = c[0]; o[i + 1] = c[1]; o[i + 2] = c[2]; o[i + 3] = 255;
            }
            break;
          }
          case 'conv': {
            const g = grayOf(frame);
            const r = convolve(g, PW, PH, KERNELS[st.kern]);
            for (let p = 0, i = 0; p < n; p++, i += 4) {
              const v = clamp(Math.abs(r[p]) * (st.kern === '浮雕' ? 1.4 : 1), 0, 255);
              o[i] = v; o[i + 1] = v; o[i + 2] = v; o[i + 3] = 255;
            }
            break;
          }
          case 'flow': {
            const g = grayOf(frame);
            if (!st.prev || st.prev.length !== n) st.prev = g.slice();
            const prev = st.prev;
            o.fill(0); for (let p = 0; p < n; p++) o[p * 4 + 3] = 255;
            const step = 6;
            for (let y = step; y < PH - step; y += step) {
              for (let x = step; x < PW - step; x += step) {
                const p = y * PW + x;
                let gx = 0, gy = 0;
                for (let dy = -3; dy <= 3; dy += 3) {
                  for (let dx = -3; dx <= 3; dx += 3) {
                    if (!dx && !dy) continue;
                    gx += (prev[p] - prev[p + dy * PW + dx]) * dx;
                    gy += (prev[p] - prev[p + dy * PW + dx]) * dy;
                  }
                }
                const mag = Math.hypot(gx, gy);
                const conf = Math.abs(g[p] - prev[p]);
                if (mag < 1 || conf < 6) continue;
                const len = Math.min(step, mag / 14);
                const ux = gx / mag * len, uy = gy / mag * len;
                const col = clamp(60 + conf * 3, 60, 255);
                const c0 = clamp(Math.round(60 + (ux + step) / (step * 2) * 180), 0, 255);
                drawLine(o, PW, PH, x, y, x + ux, y + uy, c0, 200, col);
              }
            }
            st.prev = g.slice();
            break;
          }
          case 'skin': {
            for (let p = 0, i = 0; p < n; p++, i += 4) {
              const rr = d[i], gg = d[i + 1], bb = d[i + 2];
              const y = 0.299 * rr + 0.587 * gg + 0.114 * bb;
              const cb = 128 - 0.168736 * rr - 0.331264 * gg + 0.5 * bb;
              const cr = 128 + 0.5 * rr - 0.418688 * gg - 0.081312 * bb;
              const skin = S.isSkin(rr, gg, bb);
              if (skin) { o[i] = rr; o[i + 1] = gg; o[i + 2] = bb; }
              else { const v = y * 0.22; o[i] = v; o[i + 1] = v; o[i + 2] = v * 1.3; }
              o[i + 3] = 255;
            }
            break;
          }
          case 'relief': {
            // 完整管线（边缘 + 区域分割 + 建面片）比较重，
            // 每 4 帧重算一次，中间帧沿用上一次的结果重绘 —— 视觉上看不出差别，
            // 但省掉了四分之三的开销。iPad 上这一点很关键。
            if (!st.relief || st.count % 4 === 0) {
              const SW = 104, SH = 78;
              const small = downsample(frame, SW, SH);
              const g = V.toGray(small, SW, SH);
              const e = V.edgeMap(g, SW, SH, { hiFrac: 0.55 - st.sens * 0.5, loFrac: 0.42 });
              const regs = V.findRegions(e, small, SW, SH, { minArea: 90, eps: 2.4, maxRegions: 24 });
              st.relief = V.buildRelief(regs, { mode: 'bright', height: 0.85 });
            }
            o.fill(0);
            for (let p = 0; p < n; p++) { o[p * 4] = 6; o[p * 4 + 1] = 12; o[p * 4 + 2] = 26; o[p * 4 + 3] = 255; }
            const sc = PW / Math.max(1, st.relief.bbox.x1 - st.relief.bbox.x0) * 0.72;
            const yaw = 0.55, pitch = -0.62;
            const eye = [0, 0, 0];
            const list = [];
            for (const f of st.relief.faces) {
              const vp = [];
              let ok = true;
              for (const pt of f.pts) {
                const v = viewPoint([pt[0] * sc, pt[1] * sc, pt[2] * sc], eye, yaw, pitch);
                const p2 = projectV(v, 3.1, 260 * (PW / 176), PW, PH);
                if (!p2) { ok = false; break; }
                vp.push(p2);
              }
              if (!ok) continue;
              const a = f.pts[0], b = f.pts[1], c = f.pts[2];
              const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
              const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
              let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
              const nl = Math.hypot(nx, ny, nz) || 1;
              nx /= nl; ny /= nl; nz /= nl;
              if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
              const nv = viewDir([nx, ny, nz], yaw, pitch);
              const dd = Math.max(0, nv[0] * LIGHT[0] + nv[1] * LIGHT[1] + nv[2] * LIGHT[2]);
              let z = 0;
              for (const p2 of vp) z += p2.z;
              list.push({ vp: vp, z: z / vp.length, col: f.color, sh: 0.34 + 0.8 * dd });
            }
            list.sort((p, q) => q.z - p.z);
            for (const it of list) {
              const c = it.col, sh = it.sh;
              const r = clamp(Math.round(c[0] * sh), 0, 255);
              const gg2 = clamp(Math.round(c[1] * sh), 0, 255);
              const bb2 = clamp(Math.round(c[2] * sh), 0, 255);
              fillPoly(o, PW, PH, it.vp, r, gg2, bb2);
            }
            break;
          }
        }
        st.ms = Math.round(performance.now() - t0);
      }

      function fillPoly(buf, w, h, pts, r, g, b) {
        let minY = Infinity, maxY = -Infinity;
        for (const p of pts) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
        minY = Math.max(0, Math.floor(minY));
        maxY = Math.min(h - 1, Math.ceil(maxY));
        const n = pts.length;
        for (let y = minY; y <= maxY; y++) {
          const xs = [];
          for (let i = 0; i < n; i++) {
            const a = pts[i], c = pts[(i + 1) % n];
            if ((a.y <= y && c.y > y) || (c.y <= y && a.y > y)) {
              xs.push(a.x + (y - a.y) / (c.y - a.y) * (c.x - a.x));
            }
          }
          xs.sort((p, q) => p - q);
          for (let k = 0; k + 1 < xs.length; k += 2) {
            const x0 = Math.max(0, Math.ceil(xs[k]));
            const x1 = Math.min(w - 1, Math.floor(xs[k + 1]));
            for (let x = x0; x <= x1; x++) {
              const i = (y * w + x) * 4;
              buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
            }
          }
        }
      }

      function drawLine(buf, w, h, x0, y0, x1, y1, r, g, b) {
        const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const x = Math.round(x0 + (x1 - x0) * t);
          const y = Math.round(y0 + (y1 - y0) * t);
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const p = (y * w + x) * 4;
          buf[p] = r; buf[p + 1] = g; buf[p + 2] = b; buf[p + 3] = 255;
        }
      }

      /* ---------- 摄像头 ---------- */
      async function startCam() {
        if (!st.cam) st.cam = new S.Camera({ facing: st.facing, procW: PW, procH: PH });
        st.cam.facing = st.facing;
        blk.msg.textContent = '正在请求权限…';
        const r = await st.cam.start(pv.video);
        if (!r.ok) { blk.show('摄像头发不开：' + r.error); return; }
        pv.wrap.classList.add('is-on');
        blk.hide();
        st.ready = true;
        kit.toast(r.warn ? '已授权，但没拿到画面' : '摄像头已就绪');
      }

      blk.btn.addEventListener('click', startCam);

      bFlip.addEventListener('click', async () => {
        st.facing = st.facing === 'user' ? 'environment' : 'user';
        pv.wrap.classList.toggle('campreview--nomirror', st.facing !== 'user');
        st.cam = null;
        st.ready = false;
        pv.wrap.classList.remove('is-on');
        await startCam();
        kit.toast(st.facing === 'user' ? '已切到前置' : '已切到后置');
      });

      let paused = false;
      bPause.addEventListener('click', () => {
        paused = !paused;
        bPause.textContent = paused ? '继续' : '暂停';
        bPause.classList.toggle('chip--on', paused);
      });

      let frozen = null;
      bFreeze.addEventListener('click', () => {
        if (frozen) { frozen = null; bFreeze.classList.remove('chip--on'); kit.toast('已取消冻结'); return; }
        const f = st.cam && st.cam.grab();
        if (!f) { kit.toast('先打开摄像头'); return; }
        frozen = new ImageData(new Uint8ClampedArray(f.data), f.width, f.height);
        bFreeze.classList.add('chip--on');
        kit.toast('已冻结 —— 现在参数变化能看清效果了');
      });

      /* ---------- 主循环 ---------- */
      let raf = 0, last = 0, fpsT = 0, fpsN = 0;

      function loop(ts) {
        raf = requestAnimationFrame(loop);
        if (paused) return;
        if (!last) last = ts;
        if (ts - last < 28) return;          // 上限 ~35fps，把算力留给算法
        last = ts;
        fpsN++;
        if (!fpsT) fpsT = ts;
        if (ts - fpsT > 700) {
          st.fps = Math.round(fpsN * 1000 / (ts - fpsT));
          fpsT = ts; fpsN = 0;
          sFps.textContent = st.fps ? st.fps + '' : '—';
          sMs.textContent = st.ms + ' ms';
          sIter.textContent = String(st.iter);
        }

        const frame = frozen || (st.cam && st.cam.ready ? st.cam.grab() : null);
        if (!frame) return;
        st.count++;

        try { process(frame); } catch (_) { return; }

        // 把小画布放大画到显示画布（putImageData 不吃 transform，所以走 drawImage）
        st.offCtx.putImageData(st.out, 0, 0);
        const ctx = cOut.ctx, w = cOut.w, h = cOut.h;
        if (!w || !h) return;
        ctx.imageSmoothingEnabled = st.algo !== 'kmeans';
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(st.off, 0, 0, w, h);
      }

      after(() => { raf = requestAnimationFrame(loop); });

      return () => {
        cancelAnimationFrame(raf);
        if (st.cam) st.cam.stop();
      };
    }
  });

  /* ============================================================
     三、光笔涂鸦 —— 用前置摄像头追踪亮点或指定颜色
     ============================================================ */
  F.push({
    id: 'lightpen',
    name: '光笔涂鸦',
    cat: '摄像头',
    desc: '前置摄像头追踪画面里最亮的一团或你指定的颜色，用一支笔、一个手电、一截彩色胶带在空中画画',
    tags: ['光绘', '光笔', '涂鸦', '追踪', '亮点', '颜色', '前置', '轨迹', '粒子', '画画'],
    icon: '<path d="M15.2 3.6 20.4 8.8 9.6 19.6 4 21l1.4-5.6z"/><path d="M13.4 5.4 18.6 10.6"/>',
    render(root, kit) {
      const PW = 168, PH = 126;
      const st = {
        mode: 'peak', hue: 30, tol: 26, glow: 1.15, brush: 7, trail: 'line',
        cam: null, ready: false, last: null, mass: 0, conf: 0,
        fading: false, pens: 0, fps: 0
      };

      root.appendChild(kit.el('p', 'note',
        '用前置摄像头。拿一支笔尖、手机手电或亮色胶带在镜头前比划，画布上就会留下发光的轨迹。'));

      const pv = preview(kit, { small: true });
      root.appendChild(pv.wrap);

      const blk = camBlock(kit, '打开前置摄像头',
        '会请求摄像头权限。画面只在内存里处理，不录制、不上传。');
      root.appendChild(blk.box);

      /* 追踪目标 */
      const row = kit.el('div', 'chiprow');
      const MODES = [['peak', '追最亮的地方'], ['hue', '追指定颜色']];
      const mChips = MODES.map(([k, n]) => {
        const b = kit.el('button', 'chip' + (k === st.mode ? ' chip--on' : ''), n);
        b.type = 'button';
        b.addEventListener('click', () => {
          st.mode = k;
          mChips.forEach((c, i) => c.classList.toggle('chip--on', MODES[i][0] === k));
          hueBox.style.display = k === 'hue' ? '' : 'none';
        });
        row.appendChild(b);
        return b;
      });
      const bAuto = kit.el('button', 'chip chip--sm', '对准目标自动取色');
      bAuto.type = 'button';
      bAuto.addEventListener('click', () => {
        const f = st.cam && st.cam.ready ? st.cam.grab() : null;
        if (!f) { kit.toast('先打开摄像头'); return; }
        const h = S.autoPickHue(f);
        if (h == null) { kit.toast('画面里没找到明显的颜色，靠近一点'); return; }
        st.hue = h;
        st.mode = 'hue';
        mChips.forEach((c, i) => c.classList.toggle('chip--on', MODES[i][0] === 'hue'));
        hueBox.style.display = '';
        hueIn.value = String(h);
        hueOut.textContent = h + '°';
        updateSwatch();
        kit.toast('已取到颜色 ' + h + '°');
      });
      row.appendChild(bAuto);
      root.appendChild(row);

      const hueBox = kit.el('div', 'params');
      const hw = kit.el('div', 'param');
      hw.appendChild(kit.el('span', 'param__k', '目标色相'));
      const hueIn = document.createElement('input');
      hueIn.type = 'range'; hueIn.className = 'slider'; hueIn.min = '0'; hueIn.max = '359'; hueIn.value = String(st.hue);
      const hueOut = kit.el('span', 'param__v', st.hue + '°');
      hueIn.addEventListener('input', () => {
        st.hue = Number(hueIn.value);
        hueOut.textContent = st.hue + '°';
        updateSwatch();
      });
      hw.appendChild(hueIn); hw.appendChild(hueOut);
      const swatch = kit.el('span', 'swatch');
      hw.appendChild(swatch);
      hueBox.appendChild(hw);
      hueBox.style.display = 'none';

      const tw = kit.el('div', 'param');
      tw.appendChild(kit.el('span', 'param__k', '容差'));
      const tolIn = document.createElement('input');
      tolIn.type = 'range'; tolIn.className = 'slider'; tolIn.min = '8'; tolIn.max = '70'; tolIn.value = String(st.tol);
      const tolOut = kit.el('span', 'param__v', String(st.tol));
      tolIn.addEventListener('input', () => { st.tol = Number(tolIn.value); tolOut.textContent = tolIn.value; });
      tw.appendChild(tolIn); tw.appendChild(tolOut);
      hueBox.appendChild(tw);
      root.appendChild(hueBox);

      function updateSwatch() {
        const c = S.hsv2rgb(st.hue, 0.9, 1);
        swatch.style.background = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
      }
      updateSwatch();

      /* 画布 */
      const cvWrap = kit.el('div', 'cvlayer');
      const cOut = kit.makeCanvas(cvWrap, 0.72);
      root.appendChild(cvWrap);

      const row2 = kit.el('div', 'chiprow');
      const TRAIL = [['line', '光轨'], ['particles', '粒子云']];
      const tChips = TRAIL.map(([k, n]) => {
        const b = kit.el('button', 'chip' + (k === st.trail ? ' chip--on' : ''), n);
        b.type = 'button';
        b.addEventListener('click', () => {
          st.trail = k;
          tChips.forEach((c, i) => c.classList.toggle('chip--on', TRAIL[i][0] === k));
          if (k === 'particles') initParticles();
        });
        row2.appendChild(b);
        return b;
      });
      const bClear = kit.el('button', 'chip chip--sm', '擦干净');
      bClear.type = 'button';
      bClear.addEventListener('click', () => {
        if (cOut.ctx && cOut.w) cOut.ctx.clearRect(0, 0, cOut.w, cOut.h);
        pens.length = 0;
      });
      const bSave = kit.el('button', 'chip chip--sm', '保存这笔');
      bSave.type = 'button';
      bSave.addEventListener('click', () => {
        if (!cOut.w) return;
        const a = document.createElement('a');
        a.download = 'lightpen-' + Date.now() + '.png';
        a.href = cOut.cv.toDataURL('image/png');
        a.click();
        kit.toast('已保存到「下载」');
      });
      row2.appendChild(bClear);
      row2.appendChild(bSave);
      root.appendChild(row2);

      const stats = kit.el('div', 'statgrid');
      const sMass = kit.stat(stats, '追踪面积', '—');
      const sConf = kit.stat(stats, '置信度', '0%');
      const sPens = kit.stat(stats, '轨迹点', '0');
      const sFps = kit.stat(stats, '帧率', '—');
      root.appendChild(stats);

      /* 粒子云 */
      const pens = [];
      let sPensN = 0;
      function initParticles() {
        pens.length = 0;
        for (let i = 0; i < 70; i++) pens.push({ x: 0, y: 0, vx: 0, vy: 0, h: 200 + Math.random() * 80 });
      }

      /* --- 摄像头 --- */
      async function startCam() {
        if (!st.cam) st.cam = new S.Camera({ facing: 'user', procW: PW, procH: PH });
        blk.msg.textContent = '正在请求权限…';
        const r = await st.cam.start(pv.video);
        if (!r.ok) { blk.show('前置摄像头发不开：' + r.error); return; }
        pv.wrap.classList.add('is-on');
        blk.hide();
        st.ready = true;
        kit.toast(r.warn ? '已授权，但没拿到画面' : '前置摄像头已就绪');
      }
      blk.btn.addEventListener('click', startCam);

      /* --- 主循环 --- */
      let raf = 0, last = 0, fpsT = 0, fpsN = 0, px = 0.5, py = 0.5, have = false;

      function loop(ts) {
        raf = requestAnimationFrame(loop);
        if (!last) last = ts;
        if (ts - last < 26) return;
        last = ts;
        fpsN++;
        if (!fpsT) fpsT = ts;
        if (ts - fpsT > 700) {
          st.fps = Math.round(fpsN * 1000 / (ts - fpsT));
          fpsT = ts; fpsN = 0;
          sFps.textContent = st.fps ? st.fps + '' : '—';
        }

        const f = st.cam && st.cam.ready ? st.cam.grab() : null;
        if (!f) return;

        // 预览标记点
        let hit = null;
        if (st.mode === 'peak') hit = S.trackBrightest(f, { minPeak: 0.55, floor: 0.74 });
        else hit = S.trackHue(f, st.hue, { tol: st.tol, minS: 0.32, minV: 0.24 });

        // 采样被追踪位置的颜色，让笔迹跟着目标变色
        let col = [150, 220, 255];
        if (hit) {
          const hx = Math.floor(flipX(hit.x) * f.width);
          const hy = Math.floor(hit.y * f.height);
          const i = (clamp(hy, 0, f.height - 1) * f.width + clamp(hx, 0, f.width - 1)) * 4;
          col = [f.data[i], f.data[i + 1], f.data[i + 2]];
          const mx = Math.max(col[0], col[1], col[2]) || 1;
          col = [Math.round(col[0] / mx * 255), Math.round(col[1] / mx * 255), Math.round(col[2] / mx * 255)];
          st.mass = hit.mass || st.mass;
          pv.dot.style.left = (flipX(hit.x) * 100) + '%';
          pv.dot.style.top = (hit.y * 100) + '%';
          pv.dot.classList.add('is-lock');
        } else {
          pv.dot.classList.remove('is-lock');
        }
        st.conf += ((hit ? 1 : 0) - st.conf) * 0.12;
        sConf.textContent = Math.round(st.conf * 100) + '%';
        sMass.textContent = hit ? Math.round((st.mass || 0) * 1000) / 10 + '%' : '—';

        const ctx = cOut.ctx, w = cOut.w, h = cOut.h;
        if (!w || !h) return;
        ctx.globalCompositeOperation = 'source-over';

        // 轨迹淡出，形成拖尾
        if (st.trail === 'line') {
          ctx.fillStyle = 'rgba(4,9,26,.16)';
          ctx.fillRect(0, 0, w, h);
        } else {
          ctx.fillStyle = 'rgba(4,9,26,.30)';
          ctx.fillRect(0, 0, w, h);
        }

        if (!hit) { have = false; return; }
        const tx = flipX(hit.x) * w, ty = hit.y * h;

        if (st.trail === 'line') {
          if (have) {
            const d = Math.hypot(tx - px, ty - py);
            if (d < w * 0.35) {
              ctx.strokeStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + clamp(st.glow * 0.55, 0, 1) + ')';
              ctx.lineWidth = st.brush * 2.6;
              ctx.lineCap = 'round';
              ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(tx, ty); ctx.stroke();
              ctx.strokeStyle = 'rgba(255,255,255,.92)';
              ctx.lineWidth = st.brush * 0.9;
              ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(tx, ty); ctx.stroke();
            }
          }
          px = tx; py = ty; have = true;
          sPens.textContent = String(++sPensN);
        } else {
          if (!pens.length) initParticles();
          for (const p of pens) {
            p.vx += (tx - p.x) * 0.012;
            p.vy += (ty - p.y) * 0.012;
            p.vx *= 0.92; p.vy *= 0.92;
            p.x += p.vx; p.y += p.vy;
            const c = S.hsv2rgb((p.h + ts * 0.02) % 360, 0.9, 1);
            ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',.85)';
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2.4, 0, 6.2832);
            ctx.fill();
          }
          sPens.textContent = pens.length + '';
        }
      }

      after(() => { raf = requestAnimationFrame(loop); });

      return () => {
        cancelAnimationFrame(raf);
        if (st.cam) st.cam.stop();
      };
    }
  });

  /* ============================================================
     四、实时学习机 —— 现场采样，现场训练一个小神经网络
     ============================================================ */
  F.push({
    id: 'camlearn',
    name: '实时学习机',
    cat: '神经网络',
    desc: '用摄像头现场采样本、现场训练一个手写的小神经网络，然后举着东西看它实时认出来',
    tags: ['神经网络', '在线学习', '分类', '摄像头', '深度学习', '机器学习', '训练', '样本', 'ai'],
    icon: '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18.5" cy="17" r="2.6"/>',
    render(root, kit) {
      const PW = 168, PH = 126;
      const G = 8;                          // 特征图 8×8 = 64 维
      const NCLASS = 3;
      const NAMES = ['A', 'B', 'C'];
      const COLORS = ['#5B9BFF', '#7CFFC8', '#FFC46B'];

      const st = {
        cam: null, ready: false, feat: null,
        samples: [[], [], []], net: null, learning: true,
        pred: [0, 0, 0], acc: 0, epochs: 0, cap: -1, capCount: [0, 0, 0],
        fps: 0, ms: 0
      };

      root.appendChild(kit.el('p', 'note',
        '拿三样好区分的东西（比如拳头、笔、手掌），分别对着镜头按住「采 ' +
        NAMES.join('/') + '」各采 2 秒，然后看它实时认。整个过程在这台 iPad 上训练，不联网。'));

      const pv = preview(kit, { small: true });
      root.appendChild(pv.wrap);

      const blk = camBlock(kit, '打开摄像头', '会请求摄像头权限。画面只在内存里处理，不录制、不上传。');
      root.appendChild(blk.box);

      /* 采样按钮 */
      const capRow = kit.el('div', 'chiprow');
      const capBtns = NAMES.map((n, i) => {
        const b = kit.el('button', 'chip capbtn', '采 ' + n);
        b.type = 'button';
        b.style.borderColor = COLORS[i] + '88';
        const start = ev => {
          ev.preventDefault();
          if (!st.ready) { kit.toast('先打开摄像头'); return; }
          st.cap = i;
          st.capCount[i] = 0;
          b.classList.add('is-cap');
        };
        const end = () => { if (st.cap === i) { st.cap = -1; b.classList.remove('is-cap'); } };
        b.addEventListener('pointerdown', start);
        b.addEventListener('pointerup', end);
        b.addEventListener('pointercancel', end);
        b.addEventListener('pointerleave', end);
        capRow.appendChild(b);
        return b;
      });
      root.appendChild(capRow);

      /* 开关 */
      const opRow = kit.el('div', 'chiprow');
      const bLearn = kit.el('button', 'chip chip--on', '边玩边学');
      bLearn.type = 'button';
      bLearn.addEventListener('click', () => {
        st.learning = !st.learning;
        bLearn.classList.toggle('chip--on', st.learning);
      });
      const bReset = kit.el('button', 'chip chip--sm', '清空样本重来');
      bReset.type = 'button';
      bReset.addEventListener('click', () => {
        st.samples = [[], [], []];
        st.net = null; st.epochs = 0; st.acc = 0;
        updateStats();
        kit.toast('样本已清空');
      });
      opRow.appendChild(bLearn);
      opRow.appendChild(bReset);
      root.appendChild(opRow);

      /* 预测条 */
      const probBox = kit.el('div', 'probs');
      const probEls = NAMES.map((n, i) => {
        const w = kit.el('div', 'prob');
        const head = kit.el('div', 'prob__head');
        head.appendChild(kit.el('span', 'prob__k', '类别 ' + n));
        const v = kit.el('span', 'prob__v', '0%');
        head.appendChild(v);
        const bar = kit.el('div', 'prob__bar');
        const fill = kit.el('i');
        fill.style.background = COLORS[i];
        bar.appendChild(fill);
        w.appendChild(head); w.appendChild(bar);
        probBox.appendChild(w);
        return { v: v, fill: fill };
      });
      root.appendChild(probBox);

      const verdict = kit.el('div', 'verdict', '还没有样本');
      root.appendChild(verdict);

      const stats = kit.el('div', 'statgrid');
      const sA = kit.stat(stats, 'A 样本', '0');
      const sB = kit.stat(stats, 'B 样本', '0');
      const sC = kit.stat(stats, 'C 样本', '0');
      const sEp = kit.stat(stats, '训练轮数', '0');
      root.appendChild(stats);

      const stats2 = kit.el('div', 'statgrid');
      const sAcc = kit.stat(stats2, '训练集准确率', '—');
      const sMs = kit.stat(stats2, '单帧耗时', '—');
      const sFps = kit.stat(stats2, '帧率', '—');
      const sNet = kit.stat(stats2, '网络结构', '64-20-3');
      root.appendChild(stats2);
      root.appendChild(kit.el('p', 'note',
        '特征是把画面压成 8×8 的灰度图再做亮度归一化，所以对整体明暗变化不敏感。' +
        '想认更多类，只要在代码里把 NCLASS 加到 4、5 就行。'));

      function updateStats() {
        sA.textContent = String(st.samples[0].length);
        sB.textContent = String(st.samples[1].length);
        sC.textContent = String(st.samples[2].length);
      }

      function ensureNet() {
        if (!st.net) {
          st.net = new AI.MLP([G * G, 20, NCLASS], AI.makeRng(20260927));
        }
      }

      async function startCam() {
        if (!st.cam) st.cam = new S.Camera({ facing: 'user', procW: PW, procH: PH });
        blk.msg.textContent = '正在请求权限…';
        const r = await st.cam.start(pv.video);
        if (!r.ok) { blk.show('摄像头发不开：' + r.error); return; }
        pv.wrap.classList.add('is-on');
        blk.hide();
        st.ready = true;
        kit.toast(r.warn ? '已授权，但没拿到画面' : '摄像头已就绪，去采样吧');
      }
      blk.btn.addEventListener('click', startCam);

      let raf = 0, last = 0, fpsT = 0, fpsN = 0, tick = 0;

      function loop(ts) {
        raf = requestAnimationFrame(loop);
        if (!last) last = ts;
        if (ts - last < 33) return;              // 30fps 足够，把算力让给训练
        last = ts;
        tick++;
        fpsN++;
        if (!fpsT) fpsT = ts;
        if (ts - fpsT > 700) {
          st.fps = Math.round(fpsN * 1000 / (ts - fpsT));
          fpsT = ts; fpsN = 0;
          sFps.textContent = st.fps ? st.fps + '' : '—';
          sMs.textContent = st.ms + ' ms';
        }

        const f = st.cam && st.cam.ready ? st.cam.grab() : null;
        if (!f) return;
        const t0 = performance.now();

        /* 特征 */
        const g = S.grayscaleSmall(f, G, G);
        const feat = S.normalizeGray(g);
        st.feat = feat;

        /* 采样：按住按钮期间每帧都收一个样本 */
        if (st.cap >= 0 && tick % 2 === 0) {
          const arr = st.samples[st.cap];
          if (arr.length < 40) {
            arr.push(Array.from(feat));
            st.capCount[st.cap]++;
            updateStats();
          }
        }

        /* 训练 */
        const total = st.samples[0].length + st.samples[1].length + st.samples[2].length;
        if (total >= 6) {
          ensureNet();
          if (st.learning && tick % 3 === 0) {
            // 注意：trainBatch 收的是 [[输入, 目标], ...] 数组对，
            // 不是 {x, y} 对象 —— 传错了会拿 undefined 去前向，整块功能假死。
            const all = [];
            for (let c = 0; c < NCLASS; c++) {
              for (const s of st.samples[c]) all.push([s, c]);
            }
            st.net.trainBatch(all, 0.35);
            st.epochs++;
            if (tick % 30 === 0) {
              let hit = 0;
              for (const d of all) {
                const p = st.net.predictAll(d[0]);
                let bi = 0;
                for (let k = 1; k < p.length; k++) if (p[k] > p[bi]) bi = k;
                if (bi === d[1]) hit++;
              }
              st.acc = all.length ? hit / all.length : 0;
              sAcc.textContent = Math.round(st.acc * 100) + '%';
              sEp.textContent = String(st.epochs);
            }
          }
        }

        /* 预测 */
        if (st.net) {
          const p = st.net.predictAll(feat);
          const sum = p[0] + p[1] + p[2] || 1;
          for (let i = 0; i < NCLASS; i++) {
            const v = p[i] / sum;
            st.pred[i] = v;
            probEls[i].fill.style.width = Math.round(v * 100) + '%';
            probEls[i].v.textContent = Math.round(v * 100) + '%';
          }
          let bi = 0;
          for (let i = 1; i < NCLASS; i++) if (st.pred[i] > st.pred[bi]) bi = i;
          const conf = st.pred[bi];
          verdict.textContent = conf > 0.62
            ? '现在看到的是：' + NAMES[bi] + '（' + Math.round(conf * 100) + '%）'
            : '不太确定（最高才 ' + Math.round(conf * 100) + '%），再多采点样本';
          verdict.style.color = conf > 0.62 ? COLORS[bi] : '';
        } else {
          verdict.textContent = '还没有样本，按住上面的按钮对着镜头采样';
        }

        st.ms = Math.round(performance.now() - t0);
      }

      after(() => { raf = requestAnimationFrame(loop); });

      return () => {
        cancelAnimationFrame(raf);
        if (st.cam) st.cam.stop();
      };
    }
  });

  /* ============================================================
     五、声控实验室
     ============================================================ */
  F.push({
    id: 'voice',
    name: '声控实验室',
    cat: '声音',
    desc: '实时频谱、波形、自相关音高检测、拍手计数，还有一个「唱准这个音并保持住」的音准挑战',
    tags: ['声音', '麦克风', '音频', '频谱', '音高', '音准', '唱歌', '拍手', '节奏', 'fft'],
    icon: '<path d="M4 12h2.5l2-5 3 10 2.5-7 2 4H20"/>',
    render(root, kit) {
      const st = {
        mic: null, ready: false, onsets: 0, claps: 0,
        target: 60, hold: 0, best: 0, score: 0, cents: 0, note: null,
        lastOnsetT: 0, detected: false, fps: 0, sens: 0.5, started: false
      };

      root.appendChild(kit.el('p', 'note',
        '第一次打开时会弹权限框，点「允许」。如果打开后一直没有反应，' +
        '先按下面那个「诊断」按钮 —— 它能告诉你到底是权限、系统静音，还是信号没进来。'));

      const blk = camBlock(kit, '打开麦克风',
        '会请求麦克风权限。声音只在内存里算，不录制、不上传、不落盘。');
      root.appendChild(blk.box);

      /* 电平条 */
      const lvBox = kit.el('div', 'meter');
      const lvFill = kit.el('i');
      lvBox.appendChild(lvFill);
      const lvTick = kit.el('span', 'meter__needle');
      lvBox.appendChild(lvTick);
      root.appendChild(lvBox);
      const lvNote = kit.el('p', 'note', '灰线是当前的起跳判定阈值，白条是实时音量。');
      root.appendChild(lvNote);

      /* 频谱 + 波形 */
      const specWrap = kit.el('div', 'cvlayer');
      const cSpec = kit.makeCanvas(specWrap, 0.30);
      root.appendChild(specWrap);
      const waveWrap = kit.el('div', 'cvlayer');
      const cWave = kit.makeCanvas(waveWrap, 0.18);
      root.appendChild(waveWrap);

      /* 音高 */
      const pitchBox = kit.el('div', 'challenge');
      pitchBox.appendChild(kit.el('div', 'challenge__t', '检测到的音'));
      const pNote = kit.el('div', 'challenge__n');
      const pText = document.createTextNode('—');
      pNote.appendChild(pText);
      const pSub = kit.el('span', '', '');
      pNote.appendChild(pSub);
      pitchBox.appendChild(pNote);
      const pCents = kit.el('div', 'challenge__d', '安静一点，或者对着麦克风哼一声');
      pitchBox.appendChild(pCents);
      root.appendChild(pitchBox);

      /* 音准挑战 */
      const chBox = kit.el('div', 'challenge');
      chBox.appendChild(kit.el('div', 'challenge__t', '音准挑战'));
      const chHead = kit.el('div', 'challenge__n');
      const chText = document.createTextNode('—');
      chHead.appendChild(chText);
      const chSub = kit.el('span', '', '');
      chHead.appendChild(chSub);
      chBox.appendChild(chHead);
      const chBar = kit.el('div', 'challenge__bar');
      const chFill = kit.el('i');
      chBar.appendChild(chFill);
      chBox.appendChild(chBar);
      const chMsg = kit.el('div', 'challenge__d', '唱准上面这个音并稳住 1.5 秒就算过。');
      chBox.appendChild(chMsg);
      const chRow = kit.el('div', 'chiprow');
      const bNew = kit.el('button', 'chip chip--sm', '换一个音');
      bNew.type = 'button';
      bNew.addEventListener('click', () => { pickTarget(); });
      chRow.appendChild(bNew);
      chBox.appendChild(chRow);
      root.appendChild(chBox);

      /* 拍手 */
      const clapBox = kit.el('div', 'challenge');
      clapBox.appendChild(kit.el('div', 'challenge__t', '拍手计数'));
      const clapN = kit.el('div', 'challenge__n');
      const clapText = document.createTextNode('0');
      clapN.appendChild(clapText);
      const clapSub = kit.el('span', '', '次');
      clapN.appendChild(clapSub);
      clapBox.appendChild(clapN);
      const clapRow = kit.el('div', 'chiprow');
      const bClapReset = kit.el('button', 'chip chip--sm', '清零');
      bClapReset.type = 'button';
      bClapReset.addEventListener('click', () => {
        st.claps = 0; st.onsets = 0;
        if (st.mic) { st.mic.onsets = 0; st.mic.peakLevel = 0; }
        clapText.textContent = '0';
      });
      const sensW = kit.el('div', 'penbox');
      sensW.appendChild(kit.el('span', 'penbox__k', '灵敏度'));
      const sensIn = document.createElement('input');
      sensIn.type = 'range'; sensIn.className = 'slider'; sensIn.min = '0'; sensIn.max = '100'; sensIn.value = '50';
      sensIn.addEventListener('input', () => { st.sens = Number(sensIn.value) / 100; });
      sensW.appendChild(sensIn);
      clapRow.appendChild(bClapReset);
      clapRow.appendChild(sensW);
      clapBox.appendChild(clapRow);
      root.appendChild(clapBox);

      /* 诊断 */
      const diagBox = kit.el('div', 'challenge');
      diagBox.appendChild(kit.el('div', 'challenge__t', '信号诊断'));
      const diagPre = kit.el('pre', 'diag');
      diagPre.textContent = '点上面的按钮打开麦克风后，这里会列出每一环的状态。';
      diagBox.appendChild(diagPre);
      const diagRow = kit.el('div', 'chiprow');
      const bDiag = kit.el('button', 'chip chip--sm', '诊断');
      bDiag.type = 'button';
      bDiag.addEventListener('click', runDiag);
      diagRow.appendChild(bDiag);
      diagBox.appendChild(diagRow);
      root.appendChild(diagBox);

      /* ---------- 音准目标 ---------- */
      function pickTarget() {
        st.target = 52 + Math.floor(Math.random() * 16);        // E3 ~ G4 左右，人声舒服区
        const n = S.freqToNote(S.midiToFreq(st.target));
        chText.textContent = n.name + n.octave + ' ';
        chSub.textContent = Math.round(S.midiToFreq(st.target)) + ' Hz';
        st.hold = 0;
        chFill.style.width = '0%';
        chMsg.textContent = '唱准这个音并稳住 1.5 秒就算过。';
        bNew.classList.remove('chip--on');
      }
      pickTarget();

      /* ---------- 诊断 ---------- */
      function runDiag() {
        if (!st.mic || !st.mic.ctx) {
          diagPre.textContent = '还没有创建音频上下文。先点「打开麦克风」。';
          return;
        }
        diagPre.textContent = '采样 2 秒，请对着麦克风说话或拍手…';
        const m = st.mic;
        let n = 0, maxLv = 0, prev = -1, changes = 0;
        const iv = setInterval(() => {
          const lv = m.level();
          if (lv > maxLv) maxLv = lv;
          if (prev >= 0 && Math.abs(lv - prev) > 0.004) changes++;
          prev = lv;
          n++;
          if (n >= 30) {
            clearInterval(iv);
            const s = m.state();
            const lines = [
              'AudioContext    : ' + s.ctx + (s.ctx === 'running' ? '  ✅' : '  ❌ 这一项不对，声音就完全没反应'),
              '采样率          : ' + s.sampleRate + ' Hz',
              'FFT 点数        : ' + s.fftSize + '（' + s.bins + ' 个频点）',
              '2 秒内最大音量  : ' + maxLv.toFixed(3) + (maxLv < 0.02 ? '  ❌ 几乎收不到声音' : '  ✅'),
              '音量变化次数    : ' + changes + (changes < 3 ? '  ❌ 数据是死的' : '  ✅ 数据在动'),
              '当前底噪        : ' + s.floor.toFixed(4),
              '起跳判定阈值    : ' + s.need.toFixed(3),
              '累计起跳        : ' + s.onsets,
              '',
              changes < 3 ? '结论：麦克风没有把数据送过来。检查 iPad 侧边的静音开关、系统音量、' +
                '设置 → 隐私与安全性 → 麦克风 里 Safari 是否被允许；也试试用 Safari 直接打开网址（不要在独立 App 模式里）。'
                : '结论：信号链路正常，界面上的频谱和音量条应该有反应了。'
            ];
            diagPre.textContent = lines.join('\n');
          }
        }, 66);
      }

      /* ---------- 启动 ---------- */
      async function startMic() {
        if (!st.mic) st.mic = new S.Mic({ fftSize: 2048 });
        blk.msg.textContent = '正在请求权限…';
        const r = await st.mic.start();
        if (!r.ok) { blk.show('麦克风打不开：' + r.error); return; }
        blk.hide();
        st.ready = true;
        st.started = true;
        const s = st.mic.state();
        lvNote.textContent = '已连接 · AudioContext ' + s.ctx + ' · ' + s.sampleRate + ' Hz' +
          (r.warn ? ' · ' + r.warn : '');
        kit.toast(r.warn ? '已连接，但收不到声音' : '麦克风已就绪，说句话试试');
        setTimeout(() => { if (st.ready) runDiag(); }, 900);
      }
      blk.btn.addEventListener('click', startMic);

      /* ---------- 主循环 ---------- */
      let raf = 0, last = 0, fpsT = 0, fpsN = 0;

      function loop(ts) {
        raf = requestAnimationFrame(loop);
        if (!last) last = ts;
        if (ts - last < 26) return;
        last = ts;
        fpsN++;
        if (!fpsT) fpsT = ts;
        if (ts - fpsT > 700) { st.fps = Math.round(fpsN * 1000 / (ts - fpsT)); fpsT = ts; fpsN = 0; }

        const m = st.mic;
        if (!m || !m.ready) return;

        /* 电平 */
        const lv = m.level();
        const s = m.state();
        lvFill.style.width = clamp(lv * 120, 0, 100) + '%';
        lvTick.style.left = clamp(s.need * 120, 0, 100) + '%';

        /* 频谱 */
        const freq = m.readSpectrum();
        const ctx = cSpec.ctx, w = cSpec.w, h = cSpec.h;
        if (ctx && w && freq) {
          ctx.clearRect(0, 0, w, h);
          const bars = Math.min(72, freq.length);
          const bw = w / bars;
          for (let i = 0; i < bars; i++) {
            const v = freq[i] / 255;
            const bh = v * (h - 4);
            const hue = 205 - i * 1.6;
            ctx.fillStyle = 'hsla(' + hue + ',90%,62%,.92)';
            ctx.fillRect(i * bw + 0.6, h - bh - 2, Math.max(1, bw - 1.2), bh);
          }
          ctx.fillStyle = 'rgba(255,255,255,.30)';
          ctx.font = '10px -apple-system, sans-serif';
          ctx.fillText(Math.round(m.ctx.sampleRate / 2 / 1000) + ' kHz 上限', 6, 12);
        }

        /* 波形 */
        const wc = cWave.ctx, ww = cWave.w, wh = cWave.h;
        if (wc && ww && m.time) {
          wc.clearRect(0, 0, ww, wh);
          wc.strokeStyle = 'rgba(124,255,200,.9)';
          wc.lineWidth = 1.4;
          wc.beginPath();
          const step = Math.max(1, Math.floor(m.time.length / ww));
          for (let x = 0; x < ww; x++) {
            const v = m.time[x * step] || 0;
            const y = wh / 2 - v * wh * 1.6;
            if (x) wc.lineTo(x, y); else wc.moveTo(x, y);
          }
          wc.stroke();
          wc.strokeStyle = 'rgba(255,255,255,.10)';
          wc.beginPath(); wc.moveTo(0, wh / 2); wc.lineTo(ww, wh / 2); wc.stroke();
        }

        /* 音高 */
        const f0 = m.pitch();
        if (f0) {
          const nf = S.freqToNote(f0);
          pText.textContent = nf.name + nf.octave + ' ';
          pSub.textContent = Math.round(f0) + ' Hz';
          pCents.textContent = '偏差 ' + (nf.cents >= 0 ? '+' : '') + nf.cents + ' 音分' +
            (Math.abs(nf.cents) < 20 ? ' —— 挺准' : '');
          st.note = nf;

          /* 音准挑战 */
          if (nf.midi === st.target && Math.abs(nf.cents) < 55) {
            st.hold += 0.03;
            if (st.hold >= 1.5) {
              st.score++;
              st.hold = 0;
              kit.toast('唱准了！累计 ' + st.score + ' 次');
              pickTarget();
            }
          } else {
            st.hold = Math.max(0, st.hold - 0.02);
          }
          chFill.style.width = clamp(st.hold / 1.5 * 100, 0, 100) + '%';
          if (nf.midi !== st.target && st.hold < 0.05) {
            const t = S.freqToNote(S.midiToFreq(st.target));
            const dir = nf.midi > st.target ? '低一点' : '高一点';
            chMsg.textContent = '还差一点 —— 你现在是 ' + nf.name + nf.octave + '，目标是 ' +
              t.name + t.octave + '，' + dir + '。';
          }
        } else {
          if (st.hold > 0) { st.hold = Math.max(0, st.hold - 0.02); chFill.style.width = clamp(st.hold / 1.5 * 100, 0, 100) + '%'; }
        }

        /* 拍手 */
        const needScale = 1.6 - st.sens * 1.1;
        const raw = m.onset(ts, lv);
        const strong = raw && lv > s.need * needScale;
        if (strong) {
          st.claps++;
          clapText.textContent = String(st.claps);
          clapN.classList.remove('is-pop');
          void clapN.offsetWidth;
          clapN.classList.add('is-pop');
        }
      }

      after(() => { raf = requestAnimationFrame(loop); });

      return () => {
        cancelAnimationFrame(raf);
        if (st.mic) st.mic.stop();
      };
    }
  });

})(typeof window !== 'undefined' ? window : globalThis);
