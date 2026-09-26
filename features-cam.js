/* ============================================================
   features-cam.js · 摄像头与声音玩法
   ------------------------------------------------------------
   三种摄像头玩法 + 一个声控玩法。
   全部在设备本地处理，一帧画面都不出设备。

   摄像头在 iOS 上有硬约束，所以每个玩法都准备了降级方案：
   - 必须 HTTPS（已满足）
   - 必须在用户点击里调用 getUserMedia
   - 独立 App（加到主屏幕）模式下历史上有限制，失败就退回 Safari 打开
   - 裸眼 3D 额外支持"手指拖动"和"设备重力感应"两条退路
   ============================================================ */

(function (global) {
  'use strict';

  const F = global.FEATURES || (global.FEATURES = []);
  const S = global.Sense;
  const after = fn => requestAnimationFrame(() => requestAnimationFrame(fn));
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

  /* ---------- 共用的摄像头启动块 ---------- */
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

  /* ---------- 共用的预览窗（带追踪点） ---------- */
  function preview(kit, opts) {
    opts = opts || {};
    const wrap = kit.el('div', 'campreview');
    if (opts.small) wrap.classList.add('campreview--sm');
    const v = document.createElement('video');
    v.setAttribute('playsinline', '');
    v.setAttribute('autoplay', '');
    v.muted = true;
    wrap.appendChild(v);
    const dot = kit.el('div', 'campreview__dot');
    wrap.appendChild(dot);
    const bar = kit.el('div', 'campreview__bar');
    wrap.appendChild(bar);
    return { wrap: wrap, video: v, dot: dot, bar: bar };
  }

  /* ============================================================
     一、裸眼 3D 视窗 —— 前置摄像头追踪头部，驱动 3D 视差
     ============================================================ */
  F.push({
    id: 'glass3d',
    name: '裸眼 3D 视窗',
    cat: '摄像头',
    desc: '前置摄像头追踪你的头，左右一晃，画面像一扇真的窗',
    tags: ['3D', '裸眼3D', '视差', '头部追踪', '摄像头', '交互', '沉浸'],
    icon: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
    render(root, kit) {
      const st = {
        cam: null, on: false, mode: 'touch',
        eye: { x: 0, y: 0 }, target: { x: 0, y: 0 },
        dist: 7.4, tDist: 7.4, sens: 1.7, auto: false, t: 0,
        tracking: false, mass: 0, lastSeen: 0, fps: 0, frames: 0, fAcc: 0, last: 0
      };

      const bar = kit.el('div', 'statusbar');
      root.appendChild(bar);

      const cw = kit.el('div', 'cvlayer');
      const cv = kit.makeCanvas(cw, 0.74);
      root.appendChild(cw);
      const hint = kit.el('p', 'note', '在画面上拖动手指也能移动视角。开启摄像头后，晃动你的头就会产生视差。');
      root.appendChild(hint);

      const pv = preview(kit);
      root.appendChild(pv.wrap);

      const cb = camBlock(kit, '开启头部追踪（前置摄像头）',
        '点击后浏览器会要权限。画面只在你 iPad 内存里算，不上传。');
      root.appendChild(cb.box);

      const row = kit.el('div', 'chiprow');
      const mkChip = (label, on) => {
        const b = kit.el('button', 'chip' + (on ? ' chip--on' : ''), label);
        b.type = 'button';
        row.appendChild(b);
        return b;
      };
      const cAuto = mkChip('自动环绕', false);
      const cReset = mkChip('视角归位', false);
      const cOri = mkChip('用重力感应', false);
      const cStop = mkChip('关闭摄像头', false);
      cStop.style.display = 'none';
      root.appendChild(row);

      const sensRow = kit.el('div', 'penbox');
      sensRow.appendChild(kit.el('span', 'penbox__k', '视差强度'));
      const sSlider = document.createElement('input');
      sSlider.type = 'range';
      sSlider.min = '0.6'; sSlider.max = '3.4'; sSlider.step = '0.1'; sSlider.value = '1.7';
      sSlider.className = 'slider';
      sSlider.addEventListener('input', () => { st.sens = Number(sSlider.value); });
      sensRow.appendChild(sSlider);
      root.appendChild(sensRow);

      /* ---------- 3D 场景 ---------- */
      const scene = buildRoom();

      function project(p, eye, f, cx, cy) {
        const dz = p[2] - eye[2];
        if (dz <= 0.12) return null;
        const k = f / dz;
        return [cx + (p[0] - eye[0]) * k, cy - (p[1] - eye[1]) * k, dz];
      }

      function drawScene() {
        const ctx = cv.ctx, w = cv.w, h = cv.h;
        if (!w) return;
        ctx.clearRect(0, 0, w, h);
        // 背景（走廊尽头的光）
        const grd = ctx.createLinearGradient(0, 0, 0, h);
        grd.addColorStop(0, '#061024');
        grd.addColorStop(1, '#03070F');
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, w, h);

        const eye = { x: st.eye.x, y: st.eye.y, z: 0 };
        const f = h * 0.74;
        const cx = w / 2, cy = h / 2;

        const out = [];
        for (let i = 0; i < scene.length; i++) {
          const q = scene[i];
          const pts = [];
          let ok = true, zs = 0;
          for (let k = 0; k < q.p.length; k++) {
            const pr = project(q.p[k], eye, f, cx, cy);
            if (!pr) { ok = false; break; }
            pts.push(pr);
            zs += pr[2];
          }
          if (!ok) continue;
          out.push({ pts: pts, c: q.c, z: zs / pts.length });
        }
        out.sort((a, b) => b.z - a.z);

        for (let i = 0; i < out.length; i++) {
          const o = out[i];
          // 远处雾化
          const fog = clamp((o.z - 4) / 20, 0, 0.72);
          ctx.beginPath();
          ctx.moveTo(o.pts[0][0], o.pts[0][1]);
          for (let k = 1; k < o.pts.length; k++) ctx.lineTo(o.pts[k][0], o.pts[k][1]);
          ctx.closePath();
          ctx.fillStyle = fog > 0.01
            ? 'rgb(' + Math.round(o.c[0] + (10 - o.c[0]) * fog) + ',' +
                        Math.round(o.c[1] + (22 - o.c[1]) * fog) + ',' +
                        Math.round(o.c[2] + (48 - o.c[2]) * fog) + ')'
            : 'rgb(' + o.c[0] + ',' + o.c[1] + ',' + o.c[2] + ')';
          ctx.fill();
        }

        // 摄像头追踪状态
        ctx.fillStyle = 'rgba(255,255,255,.34)';
        ctx.font = '11px -apple-system, sans-serif';
        const label = st.auto ? '自动环绕中'
          : (st.on ? (st.tracking ? '头部追踪中 · 晃动你的头' : '已开摄像头，把脸对准前置镜头')
                   : '手指拖动 / 重力感应模式');
        ctx.fillText(label, 10, h - 10);
        if (st.fps) ctx.fillText(st.fps + ' fps', w - 52, h - 10);
      }

      /* ---------- 输入 ---------- */
      let dragging = false, lastPt = null;
      cv.cv.style.touchAction = 'none';
      cv.cv.addEventListener('pointerdown', e => {
        st.auto = false;
        cAuto.classList.remove('chip--on');
        dragging = true;
        lastPt = [e.clientX, e.clientY];
      });
      cv.cv.addEventListener('pointermove', e => {
        if (!dragging) return;
        const dx = (e.clientX - lastPt[0]) / (cv.w || 400);
        const dy = (e.clientY - lastPt[1]) / (cv.h || 300);
        st.target.x = clamp(st.target.x - dx * 3.2, -1.7, 1.7);
        st.target.y = clamp(st.target.y + dy * 2.4, -1.3, 1.3);
        lastPt = [e.clientX, e.clientY];
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
        cv.cv.addEventListener(ev, () => { dragging = false; }));

      /* 重力感应（可选，作为摄像头的替代） */
      let oriOn = false;
      function onOri(e) {
        if (e.gamma == null) return;
        st.target.x = clamp((e.gamma / 28) * st.sens, -1.6, 1.6);
        st.target.y = clamp(((e.beta - 45) / 34) * st.sens * 0.8, -1.2, 1.2);
      }
      cOri.addEventListener('click', async () => {
        if (oriOn) {
          global.removeEventListener('deviceorientation', onOri);
          oriOn = false;
          cOri.classList.remove('chip--on');
          kit.toast('已关闭重力感应');
          return;
        }
        const DOE = global.DeviceOrientationEvent;
        try {
          if (DOE && typeof DOE.requestPermission === 'function') {
            const r = await DOE.requestPermission();
            if (r !== 'granted') { kit.toast('重力感应权限被拒绝'); return; }
          }
          global.addEventListener('deviceorientation', onOri);
          oriOn = true;
          cOri.classList.add('chip--on');
          kit.toast('倾斜 iPad 试试');
        } catch (err) {
          kit.toast('这台设备不支持重力感应');
        }
      });

      cAuto.addEventListener('click', () => {
        st.auto = !st.auto;
        cAuto.classList.toggle('chip--on', st.auto);
      });
      cReset.addEventListener('click', () => {
        st.target.x = 0; st.target.y = 0; st.eye.x = 0; st.eye.y = 0;
        kit.toast('视角已归位');
      });

      /* ---------- 摄像头 ---------- */
      async function startCam() {
        cb.btn.disabled = true;
        cb.msg.textContent = '正在申请摄像头…';
        if (!st.cam) st.cam = new S.Camera({ facing: 'user', procW: 160, procH: 120 });
        const r = await st.cam.start(pv.video);
        cb.btn.disabled = false;
        if (!r.ok) {
          st.on = false;
          cb.show('摄像头没打开：' + r.error + '（可以继续用手拖动或重力感应）');
          kit.toast('摄像头不可用，已切到手指模式');
          st.mode = 'touch';
          return;
        }
        st.on = true;
        cb.hide();
        cStop.style.display = '';
        pv.wrap.classList.add('is-on');
        st.mode = 'cam';
        kit.toast('头部追踪已开启');
      }

      cb.btn.addEventListener('click', startCam);
      cStop.addEventListener('click', () => {
        if (st.cam) st.cam.stop();
        st.on = false;
        st.tracking = false;
        pv.wrap.classList.remove('is-on');
        cStop.style.display = 'none';
        cb.show('摄像头已关闭。');
        st.target.x = 0; st.target.y = 0;
      });

      /* ---------- 主循环 ---------- */
      let raf = 0, last = 0, acc = 0, frame = 0;
      function loop(ts) {
        raf = requestAnimationFrame(loop);
        const dt = last ? Math.min(50, ts - last) : 16.7;
        last = ts; acc += dt;
        if (acc < 1000 / 40) return;      // 40fps 足够，留余量给摄像头
        acc = 0;
        frame++;
        st.t += dt;

        if (st.fps === 0) st.fAcc = 0;
        st.fAcc += dt;
        if (frame % 30 === 0) st.fps = Math.round(1000 / (st.fAcc / 30));
        if (frame % 30 === 0) st.fAcc = 0;

        // 自动环绕
        if (st.auto) {
          st.target.x = Math.sin(st.t * 0.00042) * 1.45;
          st.target.y = Math.sin(st.t * 0.00029) * 0.42;
        }

        // 摄像头追踪
        if (st.on && st.cam && st.cam.ready) {
          const img = st.cam.grab();
          if (img) {
            const face = S.skinCentroid(img, { step: 2, minMass: 22 });
            if (face && face.mass > 0.015) {
              st.tracking = true;
              st.mass = face.mass;
              const nx = clamp((face.x - 0.5) * 2 * st.sens, -1.6, 1.6);
              const ny = clamp((0.5 - face.y) * 2 * st.sens, -1.2, 1.2);
              st.target.x = nx;
              st.target.y = ny;
              // 脸越大 = 越近 = 越往里走
              const near = clamp((face.bh - 0.14) / 0.42, 0, 1);
              st.tDist = 8.2 - near * 4.4;
              // 预览是镜像的（scaleX(-1)），所以标记点要水平翻转才对得上
              pv.dot.style.left = ((1 - face.x) * 100) + '%';
              pv.dot.style.top = (face.y * 100) + '%';
              pv.dot.classList.add('is-lock');
              pv.bar.style.width = clamp(face.mass * 340, 0, 100) + '%';
            } else {
              st.tracking = false;
              pv.dot.classList.remove('is-lock');
              pv.bar.style.width = '0%';
            }
          }
        }

        // 平滑跟随（生硬跟随会很抖）
        st.eye.x += (st.target.x - st.eye.x) * 0.13;
        st.eye.y += (st.target.y - st.eye.y) * 0.13;
        st.dist += (st.tDist - st.dist) * 0.08;

        drawScene();
      }

      after(() => { raf = requestAnimationFrame(loop); });
      return () => {
        cancelAnimationFrame(raf);
        global.removeEventListener('deviceorientation', onOri);
        if (st.cam) st.cam.stop();
      };
    }
  });

  /* ---------- 房间几何：地面棋盘 + 墙 + 悬浮方块 ---------- */
  function buildRoom() {
    const quads = [];
    const X = 3.4, Y = 2.3, Z0 = 0.7, Z1 = 20;
    const nx = 8, nz = 18;

    function push(p, c) { quads.push({ p: p, c: c }); }

    // 地面棋盘
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const x0 = -X + 2 * X * i / nx, x1 = -X + 2 * X * (i + 1) / nx;
        const z0 = Z0 + (Z1 - Z0) * j / nz, z1 = Z0 + (Z1 - Z0) * (j + 1) / nz;
        const dark = (i + j) % 2 === 0;
        push([[x0, -Y, z0], [x1, -Y, z0], [x1, -Y, z1], [x0, -Y, z1]],
             dark ? [22, 36, 66] : [34, 54, 96]);
      }
    }
    // 天花板
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j += 2) {
        const x0 = -X + 2 * X * i / nx, x1 = -X + 2 * X * (i + 1) / nx;
        const z0 = Z0 + (Z1 - Z0) * j / nz, z1 = Z0 + (Z1 - Z0) * (j + 2) / nz;
        push([[x0, Y, z0], [x1, Y, z0], [x1, Y, z1], [x0, Y, z1]], [16, 26, 48]);
      }
    }
    // 左右墙
    for (let j = 0; j < nz; j++) {
      const z0 = Z0 + (Z1 - Z0) * j / nz, z1 = Z0 + (Z1 - Z0) * (j + 1) / nz;
      push([[-X, -Y, z0], [-X, Y, z0], [-X, Y, z1], [-X, -Y, z1]], [26, 42, 76]);
      push([[X, -Y, z0], [X, Y, z0], [X, Y, z1], [X, -Y, z1]], [20, 34, 62]);
    }
    // 尽头一堵发光的墙
    push([[-X, -Y, Z1], [X, -Y, Z1], [X, Y, Z1], [-X, Y, Z1]], [58, 96, 168]);

    // 悬浮方块（提供额外的视差参照）
    const LIGHT = [-0.42, 0.78, -0.46];
    function addBox(cx, cy, cz, s, base) {
      const h = s / 2;
      const v = [
        [cx - h, cy - h, cz - h], [cx + h, cy - h, cz - h],
        [cx + h, cy + h, cz - h], [cx - h, cy + h, cz - h],
        [cx - h, cy - h, cz + h], [cx + h, cy - h, cz + h],
        [cx + h, cy + h, cz + h], [cx - h, cy + h, cz + h]
      ];
      const faces = [
        [[4, 5, 6, 7], [0, 0, 1]],
        [[1, 0, 3, 2], [0, 0, -1]],
        [[5, 1, 2, 6], [1, 0, 0]],
        [[0, 4, 7, 3], [-1, 0, 0]],
        [[3, 7, 6, 2], [0, 1, 0]],
        [[0, 1, 5, 4], [0, -1, 0]]
      ];
      faces.forEach(([idxs, n]) => {
        const d = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
        const k = 0.34 + 0.66 * d;
        push(idxs.map(i => v[i]), [
          Math.round(base[0] * k), Math.round(base[1] * k), Math.round(base[2] * k)
        ]);
      });
    }
    addBox(-1.7, -0.7, 3.4, 0.9, [230, 150, 70]);
    addBox(1.9, 0.55, 5.6, 1.15, [90, 190, 255]);
    addBox(-0.4, 1.1, 8.4, 1.3, [150, 120, 235]);
    addBox(2.1, -1.05, 11.5, 1.0, [235, 110, 150]);
    addBox(-2.2, 0.2, 14.6, 1.5, [110, 225, 190]);
    return quads;
  }

  /* ============================================================
     二、实时图像实验室 —— 摄像头 + 逐像素处理
     ============================================================ */
  F.push({
    id: 'camfx',
    name: '实时图像实验室',
    cat: '摄像头',
    desc: '把摄像头画面实时变成边缘、素描、万花筒、热成像',
    tags: ['摄像头', '图像处理', '滤镜', '边缘检测', '万花筒', '热成像', '视觉'],
    icon: '<path d="M4 8.5V6.5A2 2 0 0 1 6 4.5h2M18 4.5h2a2 2 0 0 1 2 2v2M22 15.5v2a2 2 0 0 1-2 2h-2M6 19.5H4a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3.4"/>',
    render(root, kit) {
      const PROC_W = 224, PROC_H = 168;
      const st = {
        cam: null, on: false, mode: 'edge', fps: 0, frames: 0,
        fAcc: 0, last: 0, proc: 0
      };

      const cw = kit.el('div', 'cvlayer');
      const cv = kit.makeCanvas(cw, PROC_H / PROC_W);
      root.appendChild(cw);
      const hint = kit.el('p', 'note', '画面在你这台 iPad 上逐像素实时处理，速度取决于处理强度。');
      root.appendChild(hint);

      const pv = preview(kit, { small: true });
      root.appendChild(pv.wrap);

      const cb = camBlock(kit, '开启摄像头', '点击后浏览器会要权限。画面只在设备内存里处理，不会上传。');
      root.appendChild(cb.box);

      const modeRow = kit.el('div', 'chiprow');
      const MODES = [
        ['edge', '边缘检测'], ['sketch', '素描'], ['kaleido', '万花筒'],
        ['pixel', '像素化'], ['heat', '热成像'], ['binary', '黑白'],
        ['ghost', '运动残影'], ['neon', '负片霓虹'], ['raw', '原图']
      ];
      const modeChips = MODES.map(([k, t]) => {
        const b = kit.el('button', 'chip chip--sm' + (k === st.mode ? ' chip--on' : ''), t);
        b.type = 'button';
        b.addEventListener('click', () => {
          st.mode = k;
          modeChips.forEach((c, i) => c.classList.toggle('chip--on', MODES[i][0] === k));
          st.ghostBuf = null;
        });
        modeRow.appendChild(b);
        return b;
      });
      root.appendChild(modeRow);

      const actRow = kit.el('div', 'chiprow');
      const bShot = kit.el('button', 'chip', '保存这一帧');
      bShot.type = 'button';
      bShot.addEventListener('click', saveShot);
      const bStop = kit.el('button', 'chip', '关闭摄像头');
      bStop.type = 'button';
      bStop.addEventListener('click', () => {
        if (st.cam) st.cam.stop();
        st.on = false;
        pv.wrap.classList.remove('is-on');
        cb.show('摄像头已关闭。');
        kit.toast('摄像头已关闭');
      });
      actRow.appendChild(bShot);
      actRow.appendChild(bStop);
      root.appendChild(actRow);

      /* 处理用的离屏画布 */
      const off = document.createElement('canvas');
      off.width = PROC_W; off.height = PROC_H;
      const offCtx = off.getContext('2d');
      const prevBuf = new Uint8ClampedArray(PROC_W * PROC_H * 3);
      let hasPrev = false;

      function saveShot() {
        try {
          cv.cv.toBlob(function (blob) {
            if (!blob) { kit.toast('保存失败'); return; }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'ai-lab-' + Date.now() + '.png';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            kit.toast('已导出这一帧');
          }, 'image/png');
        } catch (_) { kit.toast('这个浏览器不支持导出'); }
      }

      cb.btn.addEventListener('click', async () => {
        cb.btn.disabled = true;
        cb.msg.textContent = '正在申请摄像头…';
        if (!st.cam) st.cam = new S.Camera({ facing: 'environment', procW: PROC_W, procH: PROC_H });
        const r = await st.cam.start(pv.video);
        cb.btn.disabled = false;
        if (!r.ok) { cb.show('摄像头没打开：' + r.error); return; }
        st.on = true;
        cb.hide();
        pv.wrap.classList.add('is-on');
        kit.toast('摄像头已开启');
      });

      /* ---------- 逐像素处理 ---------- */
      function lum(d, i) { return (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114); }

      function process(src, dst, w, h) {
        const d = src.data, o = dst.data;
        const mode = st.mode;

        if (mode === 'raw') { o.set(d); return; }

        if (mode === 'edge') {
          const g = new Float32Array(w * h);
          for (let i = 0, p = 0; i < d.length; i += 4, p++) g[p] = lum(d, i);
          for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
              const p = y * w + x;
              const gx = g[p - w + 1] + 2 * g[p + 1] + g[p + w + 1] - g[p - w - 1] - 2 * g[p - 1] - g[p + w - 1];
              const gy = g[p + w - 1] + 2 * g[p + w] + g[p + w + 1] - g[p - w - 1] - 2 * g[p - w] - g[p - w + 1];
              const m = Math.min(255, Math.hypot(gx, gy) * 0.62);
              const i = p * 4;
              o[i] = m * 0.42; o[i + 1] = m * 0.92; o[i + 2] = m;
              o[i + 3] = 255;
            }
          }
          return;
        }

        if (mode === 'sketch') {
          const g = new Float32Array(w * h);
          for (let i = 0, p = 0; i < d.length; i += 4, p++) g[p] = lum(d, i);
          const b = new Float32Array(w * h);
          for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
              const p = y * w + x;
              b[p] = (g[p - w - 1] + g[p - w] + g[p - w + 1] + g[p - 1] + g[p] + g[p + 1] +
                      g[p + w - 1] + g[p + w] + g[p + w + 1]) / 9;
            }
          }
          for (let p = 0; p < w * h; p++) {
            const i = p * 4;
            let v = g[p] * 255 / (255 - b[p] + 0.6);
            if (v > 255) v = 255;
            if (v < 0) v = 0;
            v = 255 - v;
            o[i] = o[i + 1] = o[i + 2] = v;
            o[i + 3] = 255;
          }
          return;
        }

        if (mode === 'kaleido') {
          const seg = 8;
          const wedge = Math.PI * 2 / seg;
          const cx = w / 2, cy = h / 2;
          const maxR = Math.hypot(cx, cy);
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const dx = x - cx, dy = y - cy;
              const r = Math.hypot(dx, dy);
              let a = Math.atan2(dy, dx);
              a = ((a % wedge) + wedge) % wedge;
              if (a > wedge / 2) a = wedge - a;
              const rr = Math.min(maxR, r) * 0.62;
              const sx = Math.round(cx + Math.cos(a) * rr);
              const sy = Math.round(cy + Math.sin(a) * rr);
              const si = (clamp(sy, 0, h - 1) * w + clamp(sx, 0, w - 1)) * 4;
              const i = (y * w + x) * 4;
              o[i] = d[si]; o[i + 1] = d[si + 1]; o[i + 2] = d[si + 2]; o[i + 3] = 255;
            }
          }
          return;
        }

        if (mode === 'pixel') {
          const bs = 7;
          for (let by = 0; by < h; by += bs) {
            for (let bx = 0; bx < w; bx += bs) {
              let r = 0, g2 = 0, b2 = 0, n = 0;
              for (let y = by; y < Math.min(h, by + bs); y++) {
                for (let x = bx; x < Math.min(w, bx + bs); x++) {
                  const i = (y * w + x) * 4;
                  r += d[i]; g2 += d[i + 1]; b2 += d[i + 2]; n++;
                }
              }
              r /= n; g2 /= n; b2 /= n;
              for (let y = by; y < Math.min(h, by + bs); y++) {
                for (let x = bx; x < Math.min(w, bx + bs); x++) {
                  const i = (y * w + x) * 4;
                  o[i] = r; o[i + 1] = g2; o[i + 2] = b2; o[i + 3] = 255;
                }
              }
            }
          }
          return;
        }

        if (mode === 'heat') {
          const PAL = [
            [6, 8, 42], [18, 48, 130], [22, 120, 200], [30, 200, 180],
            [150, 230, 60], [250, 190, 30], [250, 90, 20], [255, 255, 240]
          ];
          for (let p = 0; p < w * h; p++) {
            const i = p * 4;
            const v = clamp(lum(d, i) / 255, 0, 1);
            const f = v * (PAL.length - 1);
            const k = Math.min(PAL.length - 2, Math.floor(f));
            const t = f - k;
            o[i]     = PAL[k][0] + (PAL[k + 1][0] - PAL[k][0]) * t;
            o[i + 1] = PAL[k][1] + (PAL[k + 1][1] - PAL[k][1]) * t;
            o[i + 2] = PAL[k][2] + (PAL[k + 1][2] - PAL[k][2]) * t;
            o[i + 3] = 255;
          }
          return;
        }

        if (mode === 'binary') {
          for (let p = 0; p < w * h; p++) {
            const i = p * 4;
            const v = lum(d, i) > 118 ? 255 : 8;
            o[i] = o[i + 1] = o[i + 2] = v;
            o[i + 3] = 255;
          }
          return;
        }

        if (mode === 'neon') {
          for (let p = 0; p < w * h; p++) {
            const i = p * 4;
            o[i] = 255 - d[i + 2];
            o[i + 1] = 255 - d[i];
            o[i + 2] = 255 - d[i + 1];
            o[i + 3] = 255;
          }
          return;
        }

        if (mode === 'ghost') {
          if (!hasPrev) {
            for (let p = 0; p < w * h * 3; p++) prevBuf[p] = d[(p / 3 | 0) * 4 + (p % 3)];
            hasPrev = true;
          }
          for (let p = 0; p < w * h; p++) {
            const i = p * 4, b3 = p * 3;
            for (let c = 0; c < 3; c++) {
              const cur = d[i + c];
              const pv = prevBuf[b3 + c] * 0.86 + cur * 0.14;
              prevBuf[b3 + c] = pv;
              o[i + c] = pv;
            }
            o[i + 3] = 255;
          }
          return;
        }

        o.set(d);
      }

      /* ---------- 主循环 ---------- */
      const dst = offCtx.createImageData(PROC_W, PROC_H);
      let raf = 0, last = 0, acc = 0, frame = 0;

      function loop(ts) {
        raf = requestAnimationFrame(loop);
        const dt = last ? Math.min(50, ts - last) : 16.7;
        last = ts; acc += dt;
        const period = 1000 / Math.max(20, 30);
        if (acc < period) return;
        acc = 0;
        frame++;

        st.fAcc += dt;
        if (frame % 24 === 0) { st.fps = Math.round(24000 / st.fAcc); st.fAcc = 0; }

        const ctx = cv.ctx, w = cv.w, h = cv.h;
        if (!w) return;

        if (!st.on || !st.cam || !st.cam.ready) {
          ctx.clearRect(0, 0, w, h);
          ctx.fillStyle = '#050C1C';
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = 'rgba(255,255,255,.30)';
          ctx.font = '12px -apple-system, sans-serif';
          ctx.fillText('点下面的按钮开启摄像头', 12, h / 2);
          return;
        }

        const img = st.cam.grab();
        if (!img) return;
        const t0 = performance.now();
        process(img, dst, PROC_W, PROC_H);
        st.proc = performance.now() - t0;
        offCtx.putImageData(dst, 0, 0);

        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = st.mode !== 'binary' && st.mode !== 'pixel';
        ctx.drawImage(off, 0, 0, w, h);

        ctx.fillStyle = 'rgba(255,255,255,.32)';
        ctx.font = '10px -apple-system, sans-serif';
        ctx.fillText('逐像素耗时 ' + st.proc.toFixed(1) + ' ms · ' + st.fps + ' fps', 8, h - 8);
      }

      after(() => { raf = requestAnimationFrame(loop); });
      return () => {
        cancelAnimationFrame(raf);
        if (st.cam) st.cam.stop();
      };
    }
  });

  /* ============================================================
     三、光笔涂鸦 —— 追踪亮点/特定颜色，在空中画发光轨迹
     ============================================================ */
  F.push({
    id: 'lightpen',
    name: '光笔涂鸦',
    cat: '摄像头',
    desc: '拿手机屏幕或手电筒在空中写字，摄像头追着亮点画出发光轨迹',
    tags: ['摄像头', '追踪', '涂鸦', '光绘', '光笔', '粒子', '视觉'],
    icon: '<path d="M4 20 8.2 11.6l4.2 4.2z"/><path d="M9.4 10.4 18.2 3.2a1.6 1.6 0 0 1 2.3 2.3l-7.2 8.8"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    render(root, kit) {
      const st = {
        cam: null, on: false, mode: 'bright', // bright | hue
        hue: 0, tol: 26, pen: '#7CFFC8', width: 7,
        draw: 'trail',       // trail | swarm
        fps: 0, frames: 0, fAcc: 0, last: 0,
        px: null, py: null, lost: 0, tracked: 0
      };

      const bar = kit.el('div', 'statusbar');
      root.appendChild(bar);

      const cw = kit.el('div', 'cvlayer');
      const cv = kit.makeCanvas(cw, 0.68);
      root.appendChild(cw);
      const hint = kit.el('p', 'note', '在暗一点的房间里，用手机屏幕、手电筒或任何鲜艳的东西在空中画。');
      root.appendChild(hint);

      const pv = preview(kit, { small: true });
      root.appendChild(pv.wrap);

      const cb = camBlock(kit, '开启摄像头', '摄像头只用来定位亮点的位置，画面不会被保存或上传。');
      root.appendChild(cb.box);

      const trackRow = kit.el('div', 'chiprow');
      const TRACKS = [['bright', '追亮点'], ['hue', '追颜色']];
      const trackChips = TRACKS.map(([k, t]) => {
        const b = kit.el('button', 'chip' + (k === st.mode ? ' chip--on' : ''), t);
        b.type = 'button';
        b.addEventListener('click', () => {
          st.mode = k;
          trackChips.forEach((c, i) => c.classList.toggle('chip--on', TRACKS[i][0] === k));
        });
        trackRow.appendChild(b);
        return b;
      });
      const bPick = kit.el('button', 'chip chip--sm', '对准物体自动取色');
      bPick.type = 'button';
      bPick.addEventListener('click', () => {
        if (!st.on || !st.cam) { kit.toast('先开摄像头'); return; }
        const img = st.cam.grab();
        if (!img) { kit.toast('还没抓到画面'); return; }
        const h = S.autoPickHue(img, {});
        if (h === null) { kit.toast('画面中心没有明显的颜色，试试「追亮点」'); return; }
        st.hue = h;
        st.mode = 'hue';
        trackChips.forEach((c, i) => c.classList.toggle('chip--on', TRACKS[i][0] === 'hue'));
        kit.toast('已锁定颜色（色相 ' + Math.round(h) + '°）');
      });
      trackRow.appendChild(bPick);
      root.appendChild(trackRow);

      const drawRow = kit.el('div', 'chiprow');
      const DRAWS = [['trail', '发光轨迹'], ['swarm', '粒子云']];
      const drawChips = DRAWS.map(([k, t]) => {
        const b = kit.el('button', 'chip' + (k === st.draw ? ' chip--on' : ''), t);
        b.type = 'button';
        b.addEventListener('click', () => {
          st.draw = k;
          drawChips.forEach((c, i) => c.classList.toggle('chip--on', DRAWS[i][0] === k));
          if (k === 'swarm') initSwarm();
        });
        drawRow.appendChild(b);
        return b;
      });
      const bClear = kit.el('button', 'chip chip--sm', '清空画布');
      bClear.type = 'button';
      bClear.addEventListener('click', () => {
        const ctx = cv.ctx;
        if (ctx && cv.w) { ctx.clearRect(0, 0, cv.w, cv.h); ctx.fillStyle = '#050C1C'; ctx.fillRect(0, 0, cv.w, cv.h); }
        st.px = null; st.py = null;
        initSwarm();
        kit.toast('已清空');
      });
      const bSave = kit.el('button', 'chip chip--sm', '保存作品');
      bSave.type = 'button';
      bSave.addEventListener('click', () => {
        try {
          cv.cv.toBlob(function (blob) {
            if (!blob) { kit.toast('保存失败'); return; }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'light-pen-' + Date.now() + '.png';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            kit.toast('已导出');
          }, 'image/png');
        } catch (_) { kit.toast('这个浏览器不支持导出'); }
      });
      drawRow.appendChild(bClear);
      drawRow.appendChild(bSave);
      root.appendChild(drawRow);

      const sensRow = kit.el('div', 'penbox');
      sensRow.appendChild(kit.el('span', 'penbox__k', '追踪容差'));
      const slTol = document.createElement('input');
      slTol.type = 'range'; slTol.min = '8'; slTol.max = '60'; slTol.step = '2'; slTol.value = '26';
      slTol.className = 'slider';
      slTol.addEventListener('input', () => { st.tol = Number(slTol.value); });
      sensRow.appendChild(slTol);
      const bWide = kit.el('button', 'chip chip--sm', '笔粗');
      bWide.type = 'button';
      bWide.addEventListener('click', () => {
        st.width = st.width >= 16 ? 5 : st.width + 4;
        bWide.textContent = '笔粗 ' + st.width;
      });
      sensRow.appendChild(bWide);
      root.appendChild(sensRow);

      /* 颜色选择 */
      const colRow = kit.el('div', 'chiprow');
      const COLORS = ['#7CFFC8', '#7FB4FF', '#FFD678', '#FF8FA8', '#C9A0FF', '#FFFFFF'];
      const colChips = COLORS.map(c => {
        const b = kit.el('button', 'chip chip--sm', '　');
        b.type = 'button';
        b.style.background = c;
        b.style.borderColor = 'rgba(255,255,255,.4)';
        b.style.color = '#08111F';
        b.addEventListener('click', () => {
          st.pen = c;
          colChips.forEach(x => { x.style.outline = ''; });
          b.style.outline = '2px solid rgba(255,255,255,.8)';
        });
        colRow.appendChild(b);
        return b;
      });
      colChips[0].style.outline = '2px solid rgba(255,255,255,.8)';
      root.appendChild(colRow);

      /* 粒子云 */
      let swarm = [];
      function initSwarm() {
        swarm = [];
        for (let i = 0; i < 90; i++) {
          swarm.push({ x: Math.random(), y: Math.random(), vx: 0, vy: 0, s: 0.6 + Math.random() * 1.6 });
        }
      }
      initSwarm();

      cb.btn.addEventListener('click', async () => {
        cb.btn.disabled = true;
        cb.msg.textContent = '正在申请摄像头…';
        if (!st.cam) st.cam = new S.Camera({ facing: 'environment', procW: 176, procH: 132 });
        const r = await st.cam.start(pv.video);
        cb.btn.disabled = false;
        if (!r.ok) { cb.show('摄像头没打开：' + r.error); return; }
        st.on = true;
        cb.hide();
        pv.wrap.classList.add('is-on');
        // 初始化画布底色
        const ctx = cv.ctx;
        if (ctx && cv.w) { ctx.fillStyle = '#050C1C'; ctx.fillRect(0, 0, cv.w, cv.h); }
        kit.toast('开始在空中画吧');
      });

      /* ---------- 主循环 ---------- */
      let raf = 0, last = 0, acc = 0, frame = 0;
      function loop(ts) {
        raf = requestAnimationFrame(loop);
        const dt = last ? Math.min(50, ts - last) : 16.7;
        last = ts; acc += dt;
        if (acc < 1000 / 30) return;
        acc = 0;
        frame++;
        st.fAcc += dt;
        if (frame % 20 === 0) { st.fps = Math.round(20000 / st.fAcc); st.fAcc = 0; }

        const ctx = cv.ctx, w = cv.w, h = cv.h;
        if (!w) return;

        if (!st.on || !st.cam || !st.cam.ready) {
          ctx.fillStyle = '#050C1C';
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = 'rgba(255,255,255,.30)';
          ctx.font = '12px -apple-system, sans-serif';
          ctx.fillText('点下面的按钮开启摄像头', 12, h / 2);
          return;
        }

        const img = st.cam.grab();
        let hit = null;
        if (img) {
          hit = st.mode === 'bright'
            ? S.trackBrightest(img, { step: 2, floor: 0.80, minPeak: 0.55 })
            : S.trackHue(img, st.hue, { step: 2, tol: st.tol, minS: 0.30, minV: 0.26 });
        }

        const px = hit ? hit.x * w : null;
        const py = hit ? hit.y * h : null;
        if (hit) { st.tracked++; st.lost = 0; } else { st.lost++; }

        if (hit) {
          pv.dot.style.left = (hit.x * 100) + '%';
          pv.dot.style.top = (hit.y * 100) + '%';
          pv.dot.classList.add('is-lock');
          pv.bar.style.width = Math.round(Math.min(1, hit.mass * 26) * 100) + '%';
        } else {
          pv.dot.classList.remove('is-lock');
          pv.bar.style.width = '0%';
        }

        if (st.draw === 'trail') {
          // 拖尾：每帧盖一层极淡的底色，旧的轨迹会慢慢淡出
          ctx.globalCompositeOperation = 'source-over';
          ctx.fillStyle = 'rgba(5,12,28,0.045)';
          ctx.fillRect(0, 0, w, h);
          if (px !== null && st.px !== null && st.lost < 12) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.strokeStyle = st.pen;
            ctx.lineWidth = st.width;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(st.px, st.py);
            ctx.lineTo(px, py);
            ctx.stroke();
            ctx.globalCompositeOperation = 'source-over';
          }
        } else {
          // 粒子云
          ctx.fillStyle = 'rgba(5,12,28,0.20)';
          ctx.fillRect(0, 0, w, h);
          if (px !== null) {
            for (let i = 0; i < swarm.length; i++) {
              const p = swarm[i];
              const tx = px / w, ty = py / h;
              const dx = tx - p.x, dy = ty - p.y;
              const d = Math.hypot(dx, dy) + 0.0001;
              const f = 0.0055 / (d * d + 0.02);
              p.vx += (dx / d) * f; p.vy += (dy / d) * f;
              p.vx *= 0.94; p.vy *= 0.94;
              p.x += p.vx; p.y += p.vy;
            }
          } else {
            for (let i = 0; i < swarm.length; i++) {
              const p = swarm[i];
              p.vx *= 0.97; p.vy *= 0.97;
              p.x += p.vx; p.y += p.vy;
            }
          }
          ctx.globalCompositeOperation = 'lighter';
          for (let i = 0; i < swarm.length; i++) {
            const p = swarm[i];
            ctx.fillStyle = st.pen;
            ctx.globalAlpha = 0.55;
            ctx.beginPath();
            ctx.arc(p.x * w, p.y * h, p.s * 1.5, 0, 6.2832);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
        }

        if (px !== null) { st.px = px; st.py = py; } else if (st.lost > 12) { st.px = null; }

        ctx.fillStyle = 'rgba(255,255,255,.30)';
        ctx.font = '10px -apple-system, sans-serif';
        ctx.fillText(hit ? ('锁定中 · ' + st.fps + ' fps') : (st.on ? '没找到目标，把亮点/目标色对准镜头' : ''), 8, h - 8);
      }

      after(() => {
        const ctx = cv.ctx;
        if (ctx && cv.w) { ctx.fillStyle = '#050C1C'; ctx.fillRect(0, 0, cv.w, cv.h); }
        raf = requestAnimationFrame(loop);
      });
      return () => {
        cancelAnimationFrame(raf);
        if (st.cam) st.cam.stop();
      };
    }
  });

  /* ============================================================
     四、声控实验室 —— 频谱 / 音高检测 / 音准挑战 / 拍手计数
     ============================================================ */
  F.push({
    id: 'voice',
    name: '声控实验室',
    cat: '声音',
    desc: '实时频谱、音高检测、音准挑战、拍手计数',
    tags: ['麦克风', '声音', '频谱', '音高', '音准', '拍手', '音频'],
    icon: '<path d="M4 10v4M8 7v10M12 4.5v15M16 8v8M20 11v2"/>',
    render(root, kit) {
      const st = {
        mic: null, on: false, level: 0, pitch: null,
        target: null, hold: 0, streak: 0, best: 0,
        onsets: 0, fps: 0, frames: 0, fAcc: 0, last: 0, peaked: false
      };
      const TARGETS = [60, 62, 64, 67, 69, 72];

      const bar = kit.el('div', 'statusbar');
      root.appendChild(bar);

      const stats = kit.el('div', 'statgrid');
      const sLevel = kit.stat(stats, '音量', '—');
      const sHz = kit.stat(stats, '主频', '—');
      const sNote = kit.stat(stats, '音名', '—');
      const sClap = kit.stat(stats, '拍手', '0');
      root.appendChild(stats);

      const cw = kit.el('div', 'cvlayer');
      const cv = kit.makeCanvas(cw, 0.34);
      root.appendChild(cw);
      root.appendChild(kit.el('p', 'note', '上排是实时频谱，下排是波形。对着麦克风哼一段单音，音名就会出来。'));

      const cb = camBlock(kit, '开启麦克风', '点击后浏览器会要权限。声音只在你设备上做频谱分析，不会录音、不会上传。');
      root.appendChild(cb.box);

      const row = kit.el('div', 'chiprow');
      const bStop = kit.el('button', 'chip', '关闭麦克风');
      bStop.type = 'button';
      bStop.addEventListener('click', () => {
        if (st.mic) st.mic.stop();
        st.on = false;
        cb.show('麦克风已关闭。');
        kit.toast('麦克风已关闭');
      });
      const bClap = kit.el('button', 'chip', '拍手计数归零');
      bClap.type = 'button';
      bClap.addEventListener('click', () => {
        st.onsets = 0;
        if (st.mic) st.mic.onsets = 0;
        sClap.textContent = '0';
      });
      row.appendChild(bStop);
      row.appendChild(bClap);
      root.appendChild(row);

      /* 音准挑战 */
      const chal = kit.el('div', 'challenge');
      root.appendChild(chal);
      const bNew = kit.el('button', 'chip', '换一个目标音');
      bNew.type = 'button';
      bNew.addEventListener('click', pickTarget);
      const chalRow = kit.el('div', 'chiprow');
      chalRow.appendChild(bNew);
      root.appendChild(chalRow);

      function pickTarget() {
        let m;
        do { m = TARGETS[Math.floor(Math.random() * TARGETS.length)]; } while (m === st.target);
        st.target = m;
        st.hold = 0;
        renderChal();
      }

      function renderChal() {
        const n = S.freqToNote(S.midiToFreq(st.target));
        const pct = Math.min(100, Math.round(st.hold / 30 * 100));
        chal.innerHTML =
          '<div class="challenge__t">音准挑战 · 唱准这个音并保持 1 秒</div>' +
          '<div class="challenge__n">' + n.name + n.octave +
            '<span>' + Math.round(S.midiToFreq(st.target)) + ' Hz</span></div>' +
          '<div class="challenge__bar"><i style="width:' + pct + '%"></i></div>' +
          '<div class="challenge__d">连过 ' + st.streak + ' 个 · 最好 ' + st.best + '</div>';
      }

      cb.btn.addEventListener('click', async () => {
        cb.btn.disabled = true;
        cb.msg.textContent = '正在申请麦克风…';
        if (!st.mic) st.mic = new S.Mic();
        const r = await st.mic.start();
        cb.btn.disabled = false;
        if (!r.ok) { cb.show('麦克风没打开：' + r.error); return; }
        st.on = true;
        cb.hide();
        pickTarget();
        kit.toast('开始对着麦克风哼一声');
      });

      /* ---------- 主循环 ---------- */
      let raf = 0, last = 0, acc = 0, frame = 0;
      function loop(ts) {
        raf = requestAnimationFrame(loop);
        const dt = last ? Math.min(50, ts - last) : 16.7;
        last = ts; acc += dt;
        if (acc < 1000 / 30) return;
        acc = 0;
        frame++;
        st.fAcc += dt;
        if (frame % 20 === 0) { st.fps = Math.round(20000 / st.fAcc); st.fAcc = 0; }

        const ctx = cv.ctx, w = cv.w, h = cv.h;
        if (!w) return;

        if (!st.on || !st.mic || !st.mic.ready) {
          ctx.fillStyle = '#050C1C';
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = 'rgba(255,255,255,.30)';
          ctx.font = '12px -apple-system, sans-serif';
          ctx.fillText('点下面的按钮开启麦克风', 12, h / 2);
          bar.innerHTML = '<b>麦克风未开启</b>';
          return;
        }

        const spec = st.mic.readSpectrum();
        st.level = st.mic.level();

        // 拍手计数
        if (st.mic.onset(ts)) {
          st.onsets++;
          sClap.textContent = String(st.onsets);
        }

        // 音高（每 3 帧算一次，自相关挺费 CPU）
        if (frame % 3 === 0) {
          const f = st.mic.pitch();
          st.pitch = f && f > 60 && f < 1200 ? f : null;
        }

        // 音准挑战判定
        if (st.pitch && st.target) {
          const want = S.midiToFreq(st.target);
          const cents = Math.abs(1200 * Math.log2(st.pitch / want));
          if (cents < 55) {
            st.hold++;
            if (st.hold >= 30) {
              st.streak++;
              st.best = Math.max(st.best, st.streak);
              kit.toast('准！连过 ' + st.streak + ' 个');
              pickTarget();
            }
          } else {
            st.hold = Math.max(0, st.hold - 2);
          }
        } else {
          st.hold = Math.max(0, st.hold - 1);
        }
        renderChal();

        const note = st.pitch ? S.freqToNote(st.pitch) : null;
        sLevel.textContent = Math.round(st.level * 100) + '%';
        sHz.textContent = st.pitch ? Math.round(st.pitch) + ' Hz' : '—';
        sNote.textContent = note ? (note.name + note.octave) : '—';

        /* 画频谱 + 波形 */
        ctx.fillStyle = '#050C1C';
        ctx.fillRect(0, 0, w, h);

        const specH = h * 0.62;
        const bins = Math.min(spec.length, 96);
        const bw = w / bins;
        for (let i = 0; i < bins; i++) {
          // 低频拉宽，高频压缩，视觉上更好看
          const srcIdx = Math.floor(Math.pow(i / bins, 1.7) * (spec.length * 0.62));
          const v = spec[srcIdx] / 255;
          const bh = v * specH;
          const hue = 205 - v * 70;
          ctx.fillStyle = 'hsla(' + hue + ',92%,' + (48 + v * 26) + '%,' + (0.35 + v * 0.6) + ')';
          ctx.fillRect(i * bw + 0.4, specH - bh, Math.max(1, bw - 0.8), bh);
        }

        // 波形
        ctx.strokeStyle = 'rgba(140,200,255,.75)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        const t = st.mic.time;
        const baseY = specH + (h - specH) / 2;
        const amp = (h - specH) * 0.45;
        const stepN = Math.floor(t.length / 220);
        for (let i = 0, k = 0; i < t.length; i += stepN, k++) {
          const x = (k / 220) * w;
          const y = baseY - t[i] * amp * 3;
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // 目标音提示线
        if (note) {
          ctx.fillStyle = 'rgba(255,255,255,.5)';
          ctx.font = '10px -apple-system, sans-serif';
          ctx.fillText('主频 ' + Math.round(st.pitch) + ' Hz', 8, 12);
        }
        ctx.fillText(st.fps + ' fps', w - 48, 12);
      }

      after(() => { raf = requestAnimationFrame(loop); });
      return () => {
        cancelAnimationFrame(raf);
        if (st.mic) st.mic.stop();
      };
    }
  });

})(typeof window !== 'undefined' ? window : globalThis);
