/* ============================================================
   features.js · 功能定义与界面
   ------------------------------------------------------------
   每个功能的 render(root, kit) 必须返回一个"清理函数"，
   面板关闭时会被调用，用来停掉 rAF / interval。
   不清理的话后台会一直算，iPad 会烫、会掉电。
   ============================================================ */

(function (global) {
  'use strict';

  const FEATURES = [];
  const add = o => FEATURES.push(o);

  /* 小工具：等一段 DOM 布局完成再量尺寸 */
  function later(fn) { setTimeout(fn, 60); }

  /* ============================================================
     1. 神经网络实验室
     ============================================================ */
  add({
    id: 'nn',
    name: '神经网络实验室',
    cat: '神经网络',
    desc: '手写多层感知机 + 反向传播，实时看它把决策边界学出来',
    tags: ['神经网络', '深度学习', '机器学习', '反向传播', 'MLP', '训练', 'AI'],
    icon: '<circle cx="5" cy="7.5" r="1.5"/><circle cx="5" cy="16.5" r="1.5"/><circle cx="12" cy="6" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="18" r="1.5"/><circle cx="19" cy="12" r="1.5"/><path d="M6.3 7.9 10.7 6.3M6.3 9.4 10.7 11.2M6.3 15.6 10.7 12.8M6.3 16.9 10.7 17.7M13.3 6.8 17.7 11.3M13.3 11.3 17.7 11.7M13.3 12.7 17.7 12.3M13.3 17.2 17.7 12.7"/>',
    render(root, kit) {
      const AI = kit.AI;
      const st = {
        kind: 'xor', hidden: 2, neurons: 8, lr: 0.28,
        net: null, ds: null, epoch: 0, loss: 0, acc: 0,
        running: true, probe: [0.6, 0.6], seed: 4321, frames: 0
      };

      /* --- 数据集选择 --- */
      const dsRow = kit.el('div', 'chiprow');
      const dsChips = Object.keys(AI.DATASETS).map(k => {
        const b = kit.el('button', 'chip' + (k === st.kind ? ' chip--on' : ''), AI.DATASETS[k].name);
        b.type = 'button';
        b.addEventListener('click', () => {
          st.kind = k;
          dsChips.forEach((c, i) => c.classList.toggle('chip--on', Object.keys(AI.DATASETS)[i] === k));
          hintEl.textContent = AI.DATASETS[k].hint;
          reset();
        });
        dsRow.appendChild(b);
        return b;
      });
      root.appendChild(dsRow);

      const hintEl = kit.el('p', 'note', AI.DATASETS.xor.hint);
      root.appendChild(hintEl);

      /* --- 超参数 --- */
      const params = kit.el('div', 'params');
      function sel(label, opts, get, set) {
        const w = kit.el('div', 'param');
        w.appendChild(kit.el('span', 'param__k', label));
        const s = kit.el('select', 'param__v');
        opts.forEach(([v, t]) => {
          const o = document.createElement('option');
          o.value = v; o.textContent = t; s.appendChild(o);
        });
        s.value = get();
        s.addEventListener('change', () => { set(s.value); s.blur(); });
        w.appendChild(s);
        params.appendChild(w);
        return s;
      }
      sel('隐层', [[1, '1 层'], [2, '2 层']], () => st.hidden, v => { st.hidden = +v; reset(); });
      sel('每层神经元', [[4, '4 个'], [6, '6 个'], [8, '8 个'], [12, '12 个']], () => st.neurons, v => { st.neurons = +v; reset(); });
      sel('学习率', [[0.06, '0.06 慢'], [0.28, '0.28 中'], [0.7, '0.7 快']], () => st.lr, v => { st.lr = +v; });
      root.appendChild(params);

      /* --- 状态数字 --- */
      const stats = kit.el('div', 'statgrid');
      const sEpoch = kit.stat(stats, '训练轮数', '0');
      const sLoss = kit.stat(stats, '损失', '—');
      const sAcc = kit.stat(stats, '准确率', '—');
      const sNodes = kit.stat(stats, '参数量', '—');
      root.appendChild(stats);

      /* --- 画布 --- */
      const boundWrap = kit.el('div', 'cvlayer');
      const cBound = kit.makeCanvas(boundWrap, 0.62);
      const p = kit.el('div', 'cvhint', '在画布上滑动 → 网络结构图会亮起对应的激活');
      boundWrap.appendChild(p);
      root.appendChild(boundWrap);

      const netWrap = kit.el('div', 'cvlayer');
      const cNet = kit.makeCanvas(netWrap, 0.30);
      root.appendChild(netWrap);

      /* --- 按钮 --- */
      const btnRow = kit.el('div', 'chiprow');
      const bPause = kit.el('button', 'chip chip--on', '暂停');
      bPause.type = 'button';
      bPause.addEventListener('click', () => {
        st.running = !st.running;
        bPause.textContent = st.running ? '暂停' : '继续';
        bPause.classList.toggle('chip--on', st.running);
      });
      const bReset = kit.el('button', 'chip', '重新训练');
      bReset.type = 'button';
      bReset.addEventListener('click', reset);
      const bNew = kit.el('button', 'chip', '换一批数据');
      bNew.type = 'button';
      bNew.addEventListener('click', () => { st.seed = (st.seed * 7919 + 13) % 99991; reset(); });
      btnRow.appendChild(bPause); btnRow.appendChild(bReset); btnRow.appendChild(bNew);
      root.appendChild(btnRow);

      /* --- 逻辑 --- */
      function arch() {
        const s = [2];
        for (let i = 0; i < st.hidden; i++) s.push(st.neurons);
        s.push(1);
        return s;
      }

      function reset() {
        st.ds = AI.makeDataset(st.kind, 280, st.seed);
        st.net = new AI.MLP(arch(), AI.makeRng(st.seed));
        st.epoch = 0; st.loss = 0; st.acc = net0Acc();
        let n = 0;
        st.net.W.forEach(w => n += w.length);
        st.net.b.forEach(b => n += b.length);
        sNodes.textContent = String(n);
        drawNet();
      }

      function net0Acc() { return st.net.accuracy(st.ds.data); }

      /* 决策边界：算一张低分辨率贴图再放大，比逐像素画快得多 */
      const BW = 62, BH = 40;
      let off = null, offCtx = null, img = null;
      function buildBoundary() {
        if (!off) {
          off = document.createElement('canvas');
          off.width = BW; off.height = BH;
          offCtx = off.getContext('2d');
          img = offCtx.createImageData(BW, BH);
        }
        const d = img.data;
        for (let y = 0; y < BH; y++) {
          const fy = 1 - (y / (BH - 1)) * 2;
          for (let x = 0; x < BW; x++) {
            const fx = (x / (BW - 1)) * 2 - 1;
            const v = st.net.predict([fx, fy]);
            const t = (v - 0.5) * 2;              // -1..1
            const conf = Math.min(1, Math.abs(t) * 1.35);
            const i = (y * BW + x) * 4;
            if (t > 0) {                            // 类别 1：暖色
              d[i] = 245; d[i + 1] = 150 + 60 * conf; d[i + 2] = 70;
              d[i + 3] = 34 + 105 * conf;
            } else {                                // 类别 0：冷色
              d[i] = 46; d[i + 1] = 110 + 40 * conf; d[i + 2] = 215;
              d[i + 3] = 30 + 90 * conf;
            }
          }
        }
        offCtx.putImageData(img, 0, 0);
      }

      function drawBoundary() {
        const ctx = cBound.ctx, w = cBound.w, h = cBound.h;
        if (!w) return;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#060D1E';
        ctx.fillRect(0, 0, w, h);

        buildBoundary();
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.globalAlpha = 0.92;
        ctx.drawImage(off, 0, 0, w, h);
        ctx.restore();

        // 坐标网格
        ctx.strokeStyle = 'rgba(255,255,255,.06)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        for (let i = 1; i < 4; i++) {
          const gx = (w / 4) * i, gy = (h / 4) * i;
          ctx.moveTo(gx, 0); ctx.lineTo(gx, h);
          ctx.moveTo(0, gy); ctx.lineTo(w, gy);
        }
        ctx.stroke();

        // 数据点
        const d = st.ds.data;
        for (let i = 0; i < d.length; i++) {
          const x = (d[i][0][0] + 1) / 2 * w;
          const y = (1 - (d[i][0][1] + 1) / 2) * h;
          const one = d[i][1] === 1;
          ctx.fillStyle = one ? '#FFC46B' : '#6FC4FF';
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, 6.2832);
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,.45)';
          ctx.lineWidth = 0.7;
          ctx.stroke();
        }

        // 探针
        const px = (st.probe[0] + 1) / 2 * w;
        const py = (1 - (st.probe[1] + 1) / 2) * h;
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, 6.2832);
        ctx.stroke();
      }

      function drawNet() {
        const ctx = cNet.ctx, w = cNet.w, h = cNet.h;
        if (!w || !st.net) return;
        ctx.clearRect(0, 0, w, h);

        st.net.predictAll(st.probe);          // 前向一次，拿各层激活值
        const A = st.net.acts, S = st.net.sizes;
        const padX = 22, padY = 14;
        const cols = S.length;
        const xs = [];
        for (let l = 0; l < cols; l++) {
          xs.push(cols === 1 ? w / 2 : padX + (w - padX * 2) * (l / (cols - 1)));
        }
        const pos = S.map((n, l) => {
          const out = [];
          for (let i = 0; i < n; i++) {
            const y = n === 1 ? h / 2 : padY + (h - padY * 2) * (i / (n - 1));
            out.push([xs[l], y]);
          }
          return out;
        });

        // 连线：颜色表示正负，粗细表示大小
        for (let l = 0; l < st.net.W.length; l++) {
          const W = st.net.W[l], nin = S[l], nout = S[l + 1];
          for (let j = 0; j < nout; j++) {
            for (let i = 0; i < nin; i++) {
              const wt = W[j * nin + i];
              const mag = Math.min(1, Math.abs(wt) * 1.6);
              if (mag < 0.04) continue;
              ctx.strokeStyle = wt > 0
                ? 'rgba(96,170,255,' + (mag * 0.55).toFixed(3) + ')'
                : 'rgba(255,130,120,' + (mag * 0.55).toFixed(3) + ')';
              ctx.lineWidth = 0.4 + mag * 1.5;
              ctx.beginPath();
              ctx.moveTo(pos[l][i][0], pos[l][i][1]);
              ctx.lineTo(pos[l + 1][j][0], pos[l + 1][j][1]);
              ctx.stroke();
            }
          }
        }

        // 节点：亮度表示激活
        for (let l = 0; l < cols; l++) {
          for (let i = 0; i < S[l]; i++) {
            const a = A[l][i];
            const mag = Math.min(1, Math.abs(a));
            ctx.beginPath();
            ctx.arc(pos[l][i][0], pos[l][i][1], 4.6, 0, 6.2832);
            ctx.fillStyle = a >= 0
              ? 'rgba(90,170,255,' + (0.18 + mag * 0.82).toFixed(3) + ')'
              : 'rgba(255,140,110,' + (0.18 + mag * 0.82).toFixed(3) + ')';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,.30)';
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }

        ctx.fillStyle = 'rgba(255,255,255,.35)';
        ctx.font = '10px -apple-system, sans-serif';
        ctx.fillText('输入 2', 4, h - 3);
        ctx.fillText('输出 1', w - 40, h - 3);
      }

      /* 指针 → 探针 */
      function probeFrom(e) {
        const r = cBound.cv.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
        st.probe = [x * 2 - 1, 1 - y * 2];
      }
      cBound.cv.style.touchAction = 'none';
      cBound.cv.addEventListener('pointerdown', probeFrom);
      cBound.cv.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'touch') probeFrom(e); });

      /* 主循环 */
      let raf = 0, last = 0, acc = 0;
      function loop(ts) {
        raf = requestAnimationFrame(loop);
        const dt = last ? Math.min(50, ts - last) : 16.7;
        last = ts;
        acc += dt;
        if (acc < 1000 / 60) return;
        acc = 0;
        st.frames++;

        if (st.running) {
          const BS = 20;
          for (let s = 0; s < 3; s++) {
            const batch = [];
            const d = st.ds.data;
            for (let i = 0; i < BS; i++) batch.push(d[(Math.random() * d.length) | 0]);
            st.loss = st.net.trainBatch(batch, st.lr);
          }
          st.epoch += 3;
        }

        if (st.frames % 6 === 0) {
          drawBoundary();
          drawNet();
          if (st.frames % 24 === 0) st.acc = st.net.accuracy(st.ds.data);
          sEpoch.textContent = String(st.epoch);
          sLoss.textContent = st.loss.toFixed(4);
          sAcc.textContent = (st.acc * 100).toFixed(1) + '%';
        }
      }

      reset();
      later(() => { drawBoundary(); drawNet(); });
      afterPaint(() => { raf = requestAnimationFrame(loop); });

      return () => cancelAnimationFrame(raf);
    }
  });

  /* 让 rAF 在下一帧开始，避免和面板动画抢 */
  function afterPaint(fn) { requestAnimationFrame(() => requestAnimationFrame(fn)); }

  /* ============================================================
     2. 神经进化模拟
     ------------------------------------------------------------
     流程分两阶段，这是关键：
       布置阶段 → 画障碍、摆食物，随便改，虫子不动
       进化阶段 → 障碍锁死，只能放/擦食物，虫子开始跑
     障碍是手绘笔画（可任意弯曲），数量和长度都不设上限。
     ============================================================ */
  add({
    id: 'neuro',
    name: '神经进化模拟',
    cat: 'AI 进化',
    desc: '神经网络大脑 + 遗传算法。先自己画好障碍，再放它们进去学找吃的',
    tags: ['进化', '遗传算法', '神经进化', '仿真', '人工生命', '人工智能', '虫子', '迷宫'],
    icon: '<circle cx="7" cy="12" r="2.4"/><circle cx="16" cy="7" r="2"/><circle cx="17" cy="15" r="2"/><path d="M9.2 11 14 7.7M9.3 13 15 14.6"/>',
    render(root, kit) {
      const AI = kit.AI;
      const SAVE_KEY = 'myapp.neuroLayout';

      let world = null;
      let mode = 'wall';
      let penW = 9;
      let paused = false;

      /* ---------- 阶段提示条 ---------- */
      const banner = kit.el('div', 'phasebar');
      root.appendChild(banner);

      /* ---------- 画布 ---------- */
      const wrap = kit.el('div', 'cvlayer');
      const cv = kit.makeCanvas(wrap, 0.62);
      root.appendChild(wrap);

      const tip = kit.el('p', 'note');
      root.appendChild(tip);

      /* ---------- 工具 ---------- */
      const toolRow = kit.el('div', 'chiprow');
      const TOOLS = [['wall', '画障碍'], ['food', '放食物'], ['erase', '擦食物']];
      const toolChips = TOOLS.map(([k, t]) => {
        const b = kit.el('button', 'chip' + (k === mode ? ' chip--on' : ''), t);
        b.type = 'button';
        b.addEventListener('click', () => { mode = k; syncTools(); });
        toolRow.appendChild(b);
        return b;
      });

      const penBox = kit.el('div', 'penbox');
      const PEN = [[5, '细'], [9, '中'], [16, '粗']];
      const penChips = PEN.map(([w, t]) => {
        const b = kit.el('button', 'chip chip--sm' + (w === penW ? ' chip--on' : ''), t);
        b.type = 'button';
        b.addEventListener('click', () => {
          penW = w;
          penChips.forEach((c, i) => c.classList.toggle('chip--on', PEN[i][0] === w));
          if (world) world.penWidth = w;
        });
        penBox.appendChild(b);
        return b;
      });
      penBox.insertBefore(kit.el('span', 'penbox__k', '笔宽'), penBox.firstChild);
      toolRow.appendChild(penBox);
      root.appendChild(toolRow);

      /* ---------- 预设布局 ---------- */
      const preRow = kit.el('div', 'chiprow');
      preRow.appendChild(kit.el('span', 'rowlabel', '场地'));
      const preKeys = Object.keys(AI.PRESETS);
      const preChips = preKeys.map(k => {
        const b = kit.el('button', 'chip', AI.PRESETS[k].name);
        b.type = 'button';
        b.title = AI.PRESETS[k].desc;
        b.addEventListener('click', () => {
          if (!ensure()) return;
          world.applyPreset(k);
          world.penWidth = penW;
          paused = false;
          syncAll();
          kit.toast('已换成「' + AI.PRESETS[k].name + '」，可以开始进化了');
        });
        preRow.appendChild(b);
        return b;
      });
      root.appendChild(preRow);

      /* ---------- 难度 ---------- */
      const difRow = kit.el('div', 'chiprow');
      difRow.appendChild(kit.el('span', 'rowlabel', '难度'));
      const difKeys = Object.keys(AI.DIFFICULTY);
      const difChips = difKeys.map(k => {
        const b = kit.el('button', 'chip' + (k === 'normal' ? ' chip--on' : ''), AI.DIFFICULTY[k].name);
        b.type = 'button';
        b.addEventListener('click', () => {
          if (!ensure()) return;
          world.setDifficulty(k);
          difChips.forEach((c, i) => c.classList.toggle('chip--on', difKeys[i] === k));
          syncAll();
          kit.toast('难度：' + AI.DIFFICULTY[k].name + '（一代 ' + AI.DIFFICULTY[k].genLength + ' 帧）');
        });
        difRow.appendChild(b);
        return b;
      });
      root.appendChild(difRow);

      /* ---------- 主控按钮 ---------- */
      const mainRow = kit.el('div', 'mainrow');
      const btnStart = kit.el('button', 'btn', '开始进化');
      btnStart.type = 'button';
      btnStart.addEventListener('click', () => {
        if (!ensure()) return;
        if (world.phase === 'setup') {
          world.penWidth = penW;
          world.setPhase('running');
          paused = false;
          syncAll();
          kit.toast('开跑，障碍已锁定');
        } else {
          paused = !paused;
          syncAll();
        }
      });
      const btnSetup = kit.el('button', 'chip', '重新布置');
      btnSetup.type = 'button';
      btnSetup.addEventListener('click', () => {
        if (!ensure()) return;
        world.setPhase('setup');
        paused = false;
        syncAll();
      });
      mainRow.appendChild(btnStart);
      mainRow.appendChild(btnSetup);
      root.appendChild(mainRow);

      /* ---------- 辅助操作 ---------- */
      const utilRow = kit.el('div', 'chiprow');
      const mkUtil = (label, fn) => {
        const b = kit.el('button', 'chip chip--sm', label);
        b.type = 'button';
        b.addEventListener('click', () => { if (ensure()) { fn(); syncAll(); } });
        utilRow.appendChild(b);
        return b;
      };
      mkUtil('撤销一笔', () => { world.undoStroke(); });
      mkUtil('清空障碍', () => { world.clearStrokes(); kit.toast('障碍已清空'); });
      mkUtil('保存布局', () => {
        try {
          localStorage.setItem(SAVE_KEY, JSON.stringify(world.exportLayout()));
          kit.toast('布局 + 参数已存到这台 iPad');
        } catch (_) { kit.toast('存不下（存储空间不足）'); }
      });
      mkUtil('读取布局', () => {
        let raw = null;
        try { raw = localStorage.getItem(SAVE_KEY); } catch (_) {}
        if (!raw) { kit.toast('还没有保存过布局'); return; }
        try {
          if (world.importLayout(JSON.parse(raw))) kit.toast('已恢复上次保存的布局');
        } catch (_) { kit.toast('存档坏了，读取失败'); }
      });
      mkUtil('清空食物', () => { world.food.length = 0; world._placeFood(); });
      root.appendChild(utilRow);

      /* ---------- 数据 ---------- */
      const stats = kit.el('div', 'statgrid');
      const sGen = kit.stat(stats, '世代', '1');
      const sLeft = kit.stat(stats, '本代剩余', '—');
      const sBest = kit.stat(stats, '本代最佳', '0');
      const sEaten = kit.stat(stats, '累计吃到', '0');
      root.appendChild(stats);

      const chartWrap = kit.el('div', 'cvlayer');
      const cChart = kit.makeCanvas(chartWrap, 0.19);
      root.appendChild(chartWrap);
      root.appendChild(kit.el('p', 'note', '进化曲线：蓝柱＝那一代最好的虫子吃了几个，青色横线＝全群平均'));

      /* ---------- 同步界面状态 ---------- */
      function syncTools() {
        toolChips.forEach((c, i) => c.classList.toggle('chip--on', TOOLS[i][0] === mode));
        const locked = world && world.phase === 'running';
        if (mode === 'wall' && locked) {
          tip.textContent = '进化进行中，障碍已锁定。想改障碍请先点「重新布置」。';
        } else if (mode === 'wall') {
          tip.textContent = '用手指在画布上画出任意弯曲的障碍线，画多少都行。';
        } else if (mode === 'food') {
          tip.textContent = '点一下就是一颗食物。你摆的食物不会被系统清掉。';
        } else {
          tip.textContent = '点食物把它擦掉。';
        }
      }

      function syncAll() {
        if (!world) return;
        const running = world.phase === 'running';
        banner.className = 'phasebar ' + (running ? 'is-run' : 'is-setup');
        banner.innerHTML = running
          ? '<b>进化中</b><span>第 ' + world.generation + ' 代 · 障碍已锁定 · 还能放食物</span>'
          : '<b>布置阶段</b><span>先画障碍、摆食物，好了点下面的「开始进化」</span>';
        btnStart.textContent = running ? (paused ? '继续' : '暂停') : '开始进化';
        btnStart.className = 'btn' + (running ? ' btn--pause' : '') + (paused ? ' is-paused' : '');
        btnSetup.style.display = running ? '' : 'none';
        preChips.forEach((c, i) => c.classList.toggle('chip--on', preKeys[i] === world.presetKey));
        syncTools();
      }

      /* ---------- 世界与尺寸 ---------- */
      function resizeWorld(nw, nh) {
        if (!world) return;
        const sx = nw / world.W, sy = nh / world.H;
        world.strokes.forEach(s => s.pts.forEach(pt => { pt[0] *= sx; pt[1] *= sy; }));
        world.pop.forEach(a => { a.x *= sx; a.y *= sy; });
        world.food.forEach(f => { f.x *= sx; f.y *= sy; });
        world.W = nw; world.H = nh;
        world._grid = null;
      }

      function ensure() {
        const w = cv.w, h = cv.h;
        if (!w || !h) return false;
        if (!world) {
          world = new AI.NeuroWorld({
            width: w, height: h, preset: 'empty', difficulty: 'normal', seed: 20260926
          });
          world.penWidth = penW;
          syncAll();
        } else if (Math.abs(world.W - w) > 4 || Math.abs(world.H - h) > 4) {
          resizeWorld(w, h);      // 旋转屏幕时按比例搬过去，不丢布局
        }
        return true;
      }

      /* ---------- 触摸交互 ---------- */
      cv.cv.style.touchAction = 'none';
      let drawing = false;

      function local(e) {
        const r = cv.cv.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      }

      cv.cv.addEventListener('pointerdown', e => {
        if (!ensure()) return;
        const pt = local(e);
        cv.cv.setPointerCapture && cv.cv.setPointerCapture(e.pointerId);

        if (mode === 'food') { world.addFood(pt.x, pt.y); return; }
        if (mode === 'erase') { world.removeFoodNear(pt.x, pt.y, 22); return; }

        if (world.phase === 'running') { kit.toast('障碍已锁定，先「重新布置」'); return; }
        drawing = true;
        world.penWidth = penW;
        world.beginStroke(pt.x, pt.y);
      });

      cv.cv.addEventListener('pointermove', e => {
        if (!drawing || !world) return;
        const pt = local(e);
        if (mode === 'erase') { world.removeFoodNear(pt.x, pt.y, 22); return; }
        world.extendStroke(pt.x, pt.y);
      });

      ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
        cv.cv.addEventListener(ev, () => {
          if (drawing && world) world.endStroke();
          drawing = false;
        }));

      /* ---------- 绘制 ---------- */
      let t = 0;
      function draw() {
        if (!world) return;
        const ctx = cv.ctx, w = cv.w, h = cv.h;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#050C1C';
        ctx.fillRect(0, 0, w, h);

        // 障碍笔画
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const locked = world.phase === 'running';
        for (let i = 0; i < world.strokes.length; i++) {
          const s = world.strokes[i];
          if (!s.pts.length) continue;
          ctx.strokeStyle = locked ? 'rgba(120,160,230,.30)' : 'rgba(140,185,255,.42)';
          ctx.lineWidth = (s.w || 7) + 6;
          strokePath(ctx, s.pts);
          ctx.strokeStyle = locked ? 'rgba(150,190,255,.72)' : 'rgba(190,220,255,.92)';
          ctx.lineWidth = s.w || 7;
          strokePath(ctx, s.pts);
        }

        // 出生点
        const sx = world.spawn[0] * w, sy = world.spawn[1] * h;
        ctx.strokeStyle = 'rgba(150,200,255,.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.arc(sx, sy, 15, 0, 6.2832); ctx.stroke();
        ctx.setLineDash([]);

        // 食物（会呼吸）
        for (const f of world.food) {
          const pulse = 1 + Math.sin(t * 0.05 + (f.pulse || 0)) * 0.18;
          ctx.fillStyle = f.mine ? 'rgba(255,214,120,.20)' : 'rgba(120,255,200,.15)';
          ctx.beginPath(); ctx.arc(f.x, f.y, f.r * 3.4 * pulse, 0, 6.2832); ctx.fill();
          ctx.fillStyle = f.mine ? '#FFD678' : '#7CFFC8';
          ctx.beginPath(); ctx.arc(f.x, f.y, f.r * pulse, 0, 6.2832); ctx.fill();
        }

        // 虫子
        let bestF = 0;
        for (const a of world.pop) if (a.food > bestF) bestF = a.food;
        for (const a of world.pop) {
          const isBest = a.food === bestF && bestF > 0;
          const hue = 205 - Math.min(60, a.food * 14);
          ctx.save();
          ctx.translate(a.x, a.y);
          ctx.rotate(a.a);
          ctx.fillStyle = 'hsla(' + hue + ',92%,' + (isBest ? 74 : 60) + '%,' + (isBest ? 0.96 : 0.62) + ')';
          ctx.beginPath();
          ctx.moveTo(6.5, 0); ctx.lineTo(-4.2, 3.8); ctx.lineTo(-4.2, -3.8);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          if (isBest) {
            ctx.strokeStyle = 'rgba(255,255,255,.5)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(a.x, a.y, 8.5, 0, 6.2832); ctx.stroke();
          }
        }

        if (world.phase === 'setup') {
          ctx.fillStyle = 'rgba(255,255,255,.30)';
          ctx.font = '12px -apple-system, sans-serif';
          ctx.fillText('布置阶段 · 虫子待命中，先画好障碍', 10, h - 10);
        }
      }

      function strokePath(ctx, pts) {
        ctx.beginPath();
        if (pts.length === 1) {
          ctx.moveTo(pts[0][0], pts[0][1]);
          ctx.lineTo(pts[0][0] + 0.1, pts[0][1]);
        } else {
          ctx.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        }
        ctx.stroke();
      }

      function drawChart() {
        const ctx = cChart.ctx, w = cChart.w, h = cChart.h;
        if (!w || !world) return;
        ctx.clearRect(0, 0, w, h);
        const hist = world.history;
        if (hist.length < 2) {
          ctx.fillStyle = 'rgba(255,255,255,.28)';
          ctx.font = '11px -apple-system, sans-serif';
          ctx.fillText('跑完一代之后这里会出现进化曲线…', 6, h / 2 + 4);
          return;
        }
        const maxV = Math.max(1, ...hist.map(x => x.best));
        const bw = w / hist.length;
        for (let i = 0; i < hist.length; i++) {
          const bh = (hist[i].best / maxV) * (h - 12);
          const x = i * bw;
          ctx.fillStyle = 'rgba(90,170,255,.55)';
          ctx.fillRect(x + 1, h - bh - 2, Math.max(1.5, bw - 2), bh);
          const ah = (hist[i].avg / maxV) * (h - 12);
          ctx.fillStyle = 'rgba(140,255,220,.35)';
          ctx.fillRect(x + 1, h - ah - 2, Math.max(1.5, bw - 2), 1.6);
        }
        ctx.fillStyle = 'rgba(255,255,255,.35)';
        ctx.font = '10px -apple-system, sans-serif';
        ctx.fillText('峰值 ' + maxV, 4, 11);
      }

      /* ---------- 主循环 ---------- */
      let raf = 0, last = 0, acc = 0, frames = 0;
      function loop(ts) {
        raf = requestAnimationFrame(loop);
        const dt = last ? Math.min(50, ts - last) : 16.7;
        last = ts; acc += dt;
        if (acc < 1000 / 60) return;
        acc = 0;
        frames++;
        t++;

        if (!ensure()) return;
        if (world.phase === 'running' && !paused) { world.tick(); world.tick(); }

        sGen.textContent = String(world.generation);
        sLeft.textContent = world.phase === 'running'
          ? Math.max(0, world.genLength - world.tickCount) + ''
          : world.genLength + '';
        sBest.textContent = String(world.bestFood);
        sEaten.textContent = String(world.eatenTotal);

        draw();
        if (frames % 18 === 0) drawChart();
      }

      afterPaint(() => { raf = requestAnimationFrame(loop); });
      return () => {
        cancelAnimationFrame(raf);
        if (world) world.phase = 'setup';
      };
    }
  });

  /* ============================================================
     3. AI 读心猜拳
     ============================================================ */
  add({
    id: 'rps',
    name: 'AI 读心猜拳',
    cat: 'AI 对战',
    desc: '它会一边玩一边摸你的出拳规律，还会把发现告诉你',
    tags: ['猜拳', '石头剪刀布', '读心', '对战', 'PK', '在线学习', '模式识别'],
    icon: '<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10.5V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14 11V7a1.5 1.5 0 0 1 3 0v6.5a6 6 0 0 1-6 6h-1a5 5 0 0 1-5-5v-4a1.5 1.5 0 0 1 3 0"/>',
    render(root, kit) {
      const AI = kit.AI;
      const mind = new AI.RPSMind();
      let score = { p: 0, a: 0, d: 0 };

      const scoreRow = kit.el('div', 'vsrow');
      const sP = kit.stat(scoreRow, '你赢', '0');
      const sA = kit.stat(scoreRow, 'AI 赢', '0');
      const sD = kit.stat(scoreRow, '平局', '0');
      root.appendChild(scoreRow);

      const arena = kit.el('div', 'arena');
      const youEl = kit.el('div', 'arena__side');
      youEl.innerHTML = '<div class="arena__label">你</div><div class="arena__move" id="mvYou">—</div>';
      const vsEl = kit.el('div', 'arena__vs', 'VS');
      const aiEl = kit.el('div', 'arena__side');
      aiEl.innerHTML = '<div class="arena__label">AI</div><div class="arena__move" id="mvAI">—</div>';
      arena.appendChild(youEl); arena.appendChild(vsEl); arena.appendChild(aiEl);
      root.appendChild(arena);

      const verdict = kit.el('div', 'verdict', '出拳吧');
      root.appendChild(verdict);

      const think = kit.el('div', 'think');
      root.appendChild(think);

      const btnRow = kit.el('div', 'rpsrow');
      const ICONS = ['✊', '✌️', '✋'];
      const btns = AI.MOVES.map((name, i) => {
        const b = kit.el('button', 'rpsbtn');
        b.type = 'button';
        b.innerHTML = '<span class="rpsbtn__ico">' + ICONS[i] + '</span><span class="rpsbtn__name">' + name + '</span>';
        b.addEventListener('click', () => play(i));
        btnRow.appendChild(b);
        return b;
      });
      root.appendChild(btnRow);

      const repBtnRow = kit.el('div', 'chiprow');
      const bRep = kit.el('button', 'chip chip--on', '看它的分析报告');
      bRep.type = 'button';
      bRep.addEventListener('click', () => {
        rep.classList.toggle('is-open');
        bRep.classList.toggle('chip--on', !rep.classList.contains('is-open'));
        bRep.textContent = rep.classList.contains('is-open') ? '收起报告' : '看它的分析报告';
        if (rep.classList.contains('is-open')) renderReport();
      });
      const bReset = kit.el('button', 'chip', '清空重来');
      bReset.type = 'button';
      bReset.addEventListener('click', () => {
        mind.history.length = 0;
        mind.counts = [1, 1, 1];
        mind.afterSelf = [{}, {}, {}];
        mind.afterTwo = {};
        mind.afterAI = [{}, {}, {}];
        mind.experts.forEach(e => { e.weight = 1; e.hits = 0; e.tries = 0; });
        mind.predicted = null; mind.hits = 0; mind.rounds = 0;
        score = { p: 0, a: 0, d: 0 };
        sP.textContent = sA.textContent = sD.textContent = '0';
        verdict.textContent = '出拳吧';
        verdict.className = 'verdict';
        think.innerHTML = '';
        renderReport();
      });
      repBtnRow.appendChild(bRep); repBtnRow.appendChild(bReset);
      root.appendChild(repBtnRow);

      const rep = kit.el('div', 'report');
      root.appendChild(rep);

      function renderThink(d) {
        const conf = Math.round(d.confidence * 100);
        think.innerHTML =
          '<div class="think__head">AI 的推理：我猜你会出 <b>' + AI.MOVES[d.predictedMove] + '</b>' +
          '<span class="think__conf">把握 ' + conf + '%</span></div>' +
          '<div class="bars"></div>';
        const bars = think.querySelector('.bars');
        const total = d.contributions.reduce((s, c) => s + c.weight, 0) || 1;
        d.contributions.slice().sort((a, b) => b.weight - a.weight).forEach(c => {
          const row = kit.el('div', 'bar');
          row.innerHTML = '<span class="bar__k">' + (AI.EXPERT_NAMES[c.id] || c.id) + '</span>' +
                          '<span class="bar__t"><i style="width:' + (c.weight / total * 100).toFixed(1) + '%"></i></span>' +
                          '<span class="bar__v">猜 ' + AI.MOVES[c.move] + '</span>';
          bars.appendChild(row);
        });
      }

      function renderReport() {
        const r = mind.report();
        if (!r.total) {
          rep.innerHTML = '<p class="note">还没开始玩，打完几局这里会给出你的出拳习惯分析。</p>';
          return;
        }
        const pct = x => (x * 100).toFixed(0) + '%';
        const pctBar = arr => arr.map((v, i) =>
          '<div class="bar"><span class="bar__k">' + AI.MOVES[i] + '</span>' +
          '<span class="bar__t"><i style="width:' + (v * 100).toFixed(1) + '%"></i></span>' +
          '<span class="bar__v">' + pct(v) + '</span></div>').join('');

        let lossLine = '样本还不够，再打几局。';
        if (r.afterLossN >= 4) {
          const mx = r.afterLoss.indexOf(Math.max(...r.afterLoss));
          lossLine = '你输掉之后，下一手有 <b>' + pct(r.afterLoss[mx]) + '</b> 会出 <b>' + AI.MOVES[mx] + '</b>';
        }
        let winLine = '样本还不够。';
        if (r.afterWinN >= 4) {
          const mx = r.afterWin.indexOf(Math.max(...r.afterWin));
          winLine = '你赢过之后，下一手有 <b>' + pct(r.afterWin[mx]) + '</b> 会出 <b>' + AI.MOVES[mx] + '</b>';
        }

        rep.innerHTML =
          '<div class="rep__block"><div class="rep__t">我的预测命中率</div>' +
            '<div class="rep__big">' + pct(r.accuracy) + '</div>' +
            '<div class="rep__d">一共 ' + r.total + ' 局，猜中 ' + mind.hits + ' 次</div></div>' +

          '<div class="rep__block"><div class="rep__t">你的出拳分布</div>' + pctBar(r.movePct) + '</div>' +

          '<div class="rep__block"><div class="rep__t">习惯发现</div>' +
            '<div class="rep__li">' + lossLine + '</div>' +
            '<div class="rep__li">' + winLine + '</div>' +
            '<div class="rep__li">最长连出同一手 <b>' + r.longestStreak + '</b> 次</div>' +
            (r.bestExpert
              ? '<div class="rep__li">目前最灵验的规律：<b>' + (AI.EXPERT_NAMES[r.bestExpert.id] || r.bestExpert.id) +
                '</b>（命中 ' + pct(r.bestExpert.rate) + '）</div>'
              : '') +
          '</div>' +

          '<div class="rep__block"><div class="rep__t">战绩</div>' +
            '<div class="rep__li">你赢 ' + pct(r.playerWin) + ' · AI 赢 ' + pct(r.aiWin) + ' · 平 ' + pct(r.draw) + '</div>' +
          '</div>';

        if (r.accuracy > 0.55 && r.total >= 25) {
          rep.innerHTML += '<p class="note">AI 已经在猜你的套路了 —— 试试故意打乱自己的习惯，看命中率掉不掉。</p>';
        }
      }

      function play(p) {
        const d = mind.decide();
        mind.observe(p, d.aiMove);

        const r = AI.result(p, d.aiMove);
        document.getElementById('mvYou').textContent = ICONS[p];
        document.getElementById('mvAI').textContent = ICONS[d.aiMove];

        if (r > 0) {
          score.p++; verdict.textContent = '你赢了这一局';
          verdict.className = 'verdict verdict--win';
        } else if (r < 0) {
          score.a++; verdict.textContent = 'AI 赢了这一局';
          verdict.className = 'verdict verdict--lose';
        } else {
          score.d++; verdict.textContent = '平局';
          verdict.className = 'verdict';
        }
        sP.textContent = String(score.p);
        sA.textContent = String(score.a);
        sD.textContent = String(score.d);

        renderThink(d);
        if (rep.classList.contains('is-open')) renderReport();
      }

      return () => {};
    }
  });

  /* ============================================================
     4. AI 寻路竞技场
     ============================================================ */
  add({
    id: 'path',
    name: 'AI 寻路竞技场',
    cat: 'AI 算法',
    desc: 'BFS / A* / 贪心三种算法同场竞技，看谁探得少走得快',
    tags: ['寻路', 'A星', 'A*', 'BFS', '算法', '搜索', '迷宫', '路径规划'],
    icon: '<rect x="3" y="3" width="18" height="18" rx="3.5"/><path d="M7 7h3v3H7zM14 14h3v3h-3z"/><path d="M10 8.5h4v7"/>',
    render(root, kit) {
      const AI = kit.AI;
      const COLS = 26, ROWS = 16;
      const N = COLS * ROWS;
      let grid = new Array(N).fill(0);
      let results = null;
      let anim = null;
      let mode = 'wall';
      let algo = 'astar';

      // 注意：不能用 AI.idx —— 那个函数按 8 列写死，是给 8x8 棋盘用的
      const SIDX = (x, y) => y * COLS + x;
      const START = SIDX(1, 8);
      const GOAL = SIDX(COLS - 2, 8);

      const chips = kit.el('div', 'chiprow');
      const MODES = [['wall', '画墙'], ['erase', '擦除']];
      const modeChips = MODES.map(([k, t]) => {
        const b = kit.el('button', 'chip' + (k === mode ? ' chip--on' : ''), t);
        b.type = 'button';
        b.addEventListener('click', () => {
          mode = k;
          modeChips.forEach((c, i) => c.classList.toggle('chip--on', MODES[i][0] === k));
        });
        chips.appendChild(b);
        return b;
      });
      root.appendChild(chips);

      const wrap = kit.el('div', 'cvlayer');
      const cv = kit.makeCanvas(wrap, ROWS / COLS);
      root.appendChild(wrap);
      const hint = kit.el('p', 'note', '在格子上拖动可以画墙或擦除，然后点「跑一次」');
      root.appendChild(hint);

      const algoRow = kit.el('div', 'chiprow');
      const ALGOS = [['bfs', 'BFS 广度优先'], ['astar', 'A* 启发式'], ['greedy', '贪心最优优先']];
      const algoChips = ALGOS.map(([k, t]) => {
        const b = kit.el('button', 'chip' + (k === algo ? ' chip--on' : ''), t);
        b.type = 'button';
        b.addEventListener('click', () => {
          algo = k;
          algoChips.forEach((c, i) => c.classList.toggle('chip--on', ALGOS[i][0] === k));
        });
        algoRow.appendChild(b);
        return b;
      });
      root.appendChild(algoRow);

      const btnRow = kit.el('div', 'chiprow');
      const bRun = kit.el('button', 'chip chip--on', '跑一次');
      bRun.type = 'button';
      bRun.addEventListener('click', runAll);
      const bMaze = kit.el('button', 'chip', '随机迷宫');
      bMaze.type = 'button';
      bMaze.addEventListener('click', randomMaze);
      const bClear = kit.el('button', 'chip', '清空');
      bClear.type = 'button';
      bClear.addEventListener('click', () => { grid = new Array(N).fill(0); results = null; anim = null; draw(); table.innerHTML = ''; });
      btnRow.appendChild(bRun); btnRow.appendChild(bMaze); btnRow.appendChild(bClear);
      root.appendChild(btnRow);

      const table = kit.el('div', 'algo-table');
      root.appendChild(table);

      function randomMaze() {
        grid = new Array(N).fill(0);
        for (let i = 0; i < N; i++) {
          if (Math.random() < 0.26) grid[i] = 1;
        }
        // 起点终点周围留空
        [START, GOAL, START + 1, GOAL - 1, START + COLS, GOAL - COLS].forEach(i => {
          if (i >= 0 && i < N) grid[i] = 0;
        });
        results = null; anim = null;
        draw(); table.innerHTML = '';
      }

      function runAll() {
        results = {
          bfs: AI.solve(grid, COLS, ROWS, START, GOAL, 'bfs'),
          astar: AI.solve(grid, COLS, ROWS, START, GOAL, 'astar'),
          greedy: AI.solve(grid, COLS, ROWS, START, GOAL, 'greedy')
        };
        renderTable();
        const r = results[algo];
        anim = { order: r.order, path: r.path, i: 0, phase: 'explore' };
      }

      function renderTable() {
        const rows = ALGOS.map(([k, t]) => {
          const r = results[k];
          const isA = k === algo;
          return '<div class="algo-row' + (isA ? ' is-active' : '') + '">' +
            '<span class="algo-row__n">' + t + '</span>' +
            '<span class="algo-row__c">' + (r.path.length ? r.path.length + ' 步' : '走不通') + '</span>' +
            '<span class="algo-row__c">探 ' + r.visited.length + ' 格</span>' +
            '</div>';
        }).join('');
        let extra = '';
        if (results.bfs.path.length && results.astar.path.length) {
          const same = results.bfs.path.length === results.astar.path.length;
          const saved = results.bfs.visited.length - results.astar.visited.length;
          extra = '<p class="note">' + (same ? 'A* 和 BFS 找到的路径一样短' : '两者路径长度不同') +
            (saved > 0 ? '，但 A* 少探了 <b>' + saved + '</b> 个格子（少走 ' +
              (saved / results.bfs.visited.length * 100).toFixed(0) + '% 的冤枉路）。' : '。') +
            '贪心看着快，但不保证最短。</p>';
        }
        table.innerHTML = rows + extra;
      }

      function draw() {
        const ctx = cv.ctx, w = cv.w, h = cv.h;
        if (!w) return;
        const cw = w / COLS, ch = h / ROWS;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#050C1C';
        ctx.fillRect(0, 0, w, h);

        // 探索过的格子（动画推进）
        if (anim) {
          const upto = anim.phase === 'explore' ? Math.min(anim.i, anim.order.length) : anim.order.length;
          ctx.fillStyle = 'rgba(70,130,255,.34)';
          for (let k = 0; k < upto; k++) {
            const c = anim.order[k];
            ctx.fillRect((c % COLS) * cw + 0.5, ((c / COLS) | 0) * ch + 0.5, cw - 1, ch - 1);
          }
        } else if (results) {
          ctx.fillStyle = 'rgba(70,130,255,.20)';
          results[algo].visited.forEach(c => {
            ctx.fillRect((c % COLS) * cw + 0.5, ((c / COLS) | 0) * ch + 0.5, cw - 1, ch - 1);
          });
        }

        // 墙
        ctx.fillStyle = 'rgba(10,20,44,.95)';
        ctx.strokeStyle = 'rgba(130,175,255,.30)';
        ctx.lineWidth = 0.8;
        for (let i = 0; i < N; i++) {
          if (!grid[i]) continue;
          const x = (i % COLS) * cw, y = ((i / COLS) | 0) * ch;
          ctx.fillRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
          ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
        }

        // 路径
        const showPath = results && (anim ? anim.phase === 'path' : true);
        if (showPath && results[algo].path.length) {
          const path = results[algo].path;
          ctx.strokeStyle = '#7CFFC8';
          ctx.lineWidth = Math.max(2, cw * 0.30);
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.beginPath();
          path.forEach((c, i) => {
            const x = (c % COLS) * cw + cw / 2, y = ((c / COLS) | 0) * ch + ch / 2;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.stroke();
        }

        // 起点终点
        dot(ctx, START, cw, ch, '#6FE3A0', 'S');
        dot(ctx, GOAL, cw, ch, '#FF9F6B', 'G');
      }

      function dot(ctx, i, cw, ch, color, label) {
        const x = (i % COLS) * cw + cw / 2, y = ((i / COLS) | 0) * ch + ch / 2;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, Math.min(cw, ch) * 0.34, 0, 6.2832);
        ctx.fill();
        ctx.fillStyle = '#05101F';
        ctx.font = '600 ' + Math.max(8, Math.min(cw, ch) * 0.5).toFixed(0) + 'px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x, y + 0.5);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      }

      /* 在格子上拖动 */
      let dragging = false, paint = 1;
      cv.cv.style.touchAction = 'none';
      function cellAt(e) {
        const r = cv.cv.getBoundingClientRect();
        const x = Math.floor((e.clientX - r.left) / (r.width / COLS));
        const y = Math.floor((e.clientY - r.top) / (r.height / ROWS));
        if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return -1;
        return y * COLS + x;
      }
      cv.cv.addEventListener('pointerdown', e => {
        const i = cellAt(e);
        if (i < 0 || i === START || i === GOAL) return;
        dragging = true;
        paint = mode === 'wall' ? 1 : 0;
        grid[i] = paint;
        results = null; anim = null; table.innerHTML = '';
        draw();
      });
      cv.cv.addEventListener('pointermove', e => {
        if (!dragging) return;
        const i = cellAt(e);
        if (i < 0 || i === START || i === GOAL) return;
        if (grid[i] !== paint) { grid[i] = paint; draw(); }
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
        cv.cv.addEventListener(ev, () => { dragging = false; }));

      let raf = 0, acc = 0, last = 0;
      function loop(ts) {
        raf = requestAnimationFrame(loop);
        const dt = last ? Math.min(50, ts - last) : 16.7;
        last = ts; acc += dt;
        if (acc < 1000 / 60) return;
        acc = 0;
        if (!anim) return;
        if (anim.phase === 'explore') {
          anim.i += 8;
          if (anim.i >= anim.order.length) { anim.i = anim.order.length; anim.phase = 'path'; }
          draw();
        } else {
          anim = null;
          draw();
        }
      }

      later(() => draw());
      afterPaint(() => { raf = requestAnimationFrame(loop); });
      return () => cancelAnimationFrame(raf);
    }
  });

  /* ============================================================
     圆角矩形辅助
     ============================================================ */
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  global.FEATURES = FEATURES;
  global.roundRect = roundRect;

})(typeof window !== 'undefined' ? window : globalThis);
