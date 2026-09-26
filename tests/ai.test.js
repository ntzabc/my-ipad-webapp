/* ============================================================
   ai.js 的自动化测试
     node tests/ai.test.js
   覆盖：反向传播梯度校验、XOR 收敛、进化确实在进化、
         读心算法确实在学习、棋类 AI 与搜索算法正确性。
   ============================================================ */

require('../ai.js');
const AI = globalThis.AI;

let pass = 0, fail = 0, group = '';

function G(name) { group = name; console.log('\n【' + name + '】'); }
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
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

/* ============================================================
   1. 反向传播正确性 —— 数值梯度 vs 解析梯度
   这是最关键的测试：梯度错了，训练就是在瞎走。
   ============================================================ */
G('反向传播梯度校验');

(function gradientCheck() {
  const m = new AI.MLP([3, 4, 2, 1], AI.makeRng(1234));
  const x = [0.35, -0.62, 0.48];
  const y = 1;

  const bce = p => {
    const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
    return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
  };

  // 解析梯度
  m.zeroGrad();
  m.accumulate(x, y);            // 单样本：累积的梯度就是该样本的梯度

  // 数值梯度
  const eps = 1e-6;
  const allW = [];
  for (let l = 0; l < m.W.length; l++) {
    for (let i = 0; i < m.W[l].length; i++) allW.push([l, 'W', i]);
    for (let i = 0; i < m.b[l].length; i++) allW.push([l, 'b', i]);
  }

  let worst = 0;
  for (let k = 0; k < 12; k++) {
    const [l, kind, i] = allW[k];
    const arr = kind === 'W' ? m.W[l] : m.b[l];
    const orig = arr[i];
    arr[i] = orig + eps; const lp = bce(m.predict(x));
    arr[i] = orig - eps; const lm = bce(m.predict(x));
    arr[i] = orig;
    const num = (lp - lm) / (2 * eps);
    const ana = kind === 'W' ? m.dW[l][i] : m.db[l][i];
    worst = Math.max(worst, Math.abs(num - ana));
  }
  ok(worst < 1e-5, '解析梯度与数值梯度一致（最大偏差 ' + worst.toExponential(2) + '）');
})();

/* ============================================================
   2. 神经网络能真的学会 XOR
   ============================================================ */
G('神经网络收敛');

(function xorLearn() {
  const ds = AI.makeDataset('xor', 240, 42);
  eq(ds.data.length, 240, '数据集大小正确');

  const rng = AI.makeRng(7);
  const net = new AI.MLP([2, 6, 6, 1], rng);
  const acc0 = net.accuracy(ds.data);
  ok(acc0 < 0.85, '未训练时准确率不高（' + (acc0 * 100).toFixed(1) + '%）');

  const order = ds.data.slice();
  const BS = 24;                   // 小批量，比全量批梯度下降收敛好得多
  for (let ep = 0; ep < 700; ep++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    for (let s0 = 0; s0 < order.length; s0 += BS) {
      net.trainBatch(order.slice(s0, s0 + BS), 0.28);
    }
  }
  const acc1 = net.accuracy(ds.data);
  ok(acc1 > 0.9, '训练后 XOR 准确率 > 90%（实际 ' + (acc1 * 100).toFixed(1) + '%）');
})();

(function determinism() {
  const a = new AI.MLP([2, 4, 1], AI.makeRng(99));
  const b = new AI.MLP([2, 4, 1], AI.makeRng(99));
  let same = true;
  for (let i = 0; i < a.W[0].length; i++) if (a.W[0][i] !== b.W[0][i]) same = false;
  ok(same, '同一随机种子 → 完全相同的初始权重');

  const c = new AI.MLP([2, 4, 1], AI.makeRng(100));
  let diff = false;
  for (let i = 0; i < a.W[0].length; i++) if (a.W[0][i] !== c.W[0][i]) diff = true;
  ok(diff, '不同种子 → 不同权重');
})();

(function datasets() {
  ['xor', 'circle', 'spiral', 'moons', 'blobs'].forEach(k => {
    const d = AI.makeDataset(k, 100, 5);
    eq(d.data.length, 100, k + ' 数据量正确');
    const labels = new Set(d.data.map(s => s[1]));
    eq(labels.size, 2, k + ' 是二分类');
    let inRange = true;
    d.data.forEach(s => {
      if (s[0][0] < -1.4 || s[0][0] > 1.4 || s[0][1] < -1.4 || s[0][1] > 1.4) inRange = false;
    });
    ok(inRange, k + ' 坐标都在合理范围内');
  });
})();

/* ============================================================
   3. 神经进化 —— 进化有效性 + 本轮修复的四个问题
   ============================================================ */
G('神经进化 · 基础');

(function basics() {
  const w = new AI.NeuroWorld({ seed: 2024, width: 420, height: 300, popSize: 30, genLength: 300, foodCount: 12 });
  eq(w.pop.length, 30, '种群规模正确');
  eq(w.food.length, 12, '食物数量正确（构造函数会布好食物）');
  eq(w.phase, 'setup', '初始处于布置阶段');
  ok(w.food.every(f => !w.fitsWall(f.x, f.y, 2)), '初始食物没有生成在障碍里');
})();

G('神经进化 · 布置阶段');

(function phaseGating() {
  const w = new AI.NeuroWorld({ seed: 5, width: 420, height: 300, popSize: 20, genLength: 120 });
  const before = JSON.stringify(w.pop.map(a => [a.x, a.y]));
  for (let i = 0; i < 300; i++) w.tick();
  eq(w.tickCount, 0, '布置阶段 tick 完全不推进');
  eq(JSON.stringify(w.pop.map(a => [a.x, a.y])), before, '布置阶段虫子不会动');
  eq(w.phase, 'setup', '阶段保持 setup');

  w.setPhase('running');
  for (let i = 0; i < 10; i++) w.tick();
  eq(w.tickCount, 10, '开始后每帧推进一次');
  eq(w.phase, 'running', '阶段切到 running');
})();

G('神经进化 · 手绘障碍');

(function strokes() {
  const w = new AI.NeuroWorld({ seed: 9, width: 400, height: 300 });
  w.clearStrokes();
  eq(w.strokes.length, 0, '清空后没有笔画');

  w.beginStroke(100, 100);
  w.extendStroke(150, 120);
  w.extendStroke(200, 100);
  w.endStroke();
  eq(w.strokes.length, 1, '一次落笔形成一条笔画');
  eq(w.strokes[0].pts.length, 3, '笔画记录了 3 个点');
  ok(w.strokeLength() > 90, '笔画长度统计正常（' + Math.round(w.strokeLength()) + '）');

  ok(w.hitWall(100, 100), '笔画起点判定为障碍');
  ok(w.hitWall(150, 120), '笔画拐点判定为障碍');
  ok(!w.hitWall(100, 220), '远离笔画的位置不是障碍');

  // 弯曲笔画：画一段弧
  w.beginStroke(60, 220);
  for (let a = 0; a <= Math.PI; a += 0.15) {
    w.extendStroke(60 + Math.cos(a) * 45, 220 + Math.sin(a) * 45);
  }
  w.endStroke();
  ok(w.strokes[1].pts.length > 12, '弯曲笔画的每个点都被记录（' + w.strokes[1].pts.length + ' 个点）');
  ok(w.hitWall(60 + 45, 220 + 45 * 0.01), '弧线上判定为障碍');

  w.undoStroke();
  eq(w.strokes.length, 1, '撤销会移除最后一条笔画');
})();

(function noCap() {
  const w = new AI.NeuroWorld({ seed: 3, width: 400, height: 300 });
  w.clearStrokes();
  for (let i = 0; i < 60; i++) {
    w.beginStroke(10, 10 + i * 4);
    w.extendStroke(200, 10 + i * 4);
    w.endStroke();
  }
  ok(w.strokes.length >= 60, '笔画数量不设上限（旧版本超过 14 块就开始删最早的）');
  for (let i = 0; i < 40; i++) w.tick();
  ok(w.strokes.length >= 60, '推进过程中障碍不会被自动清除');
})();

G('神经进化 · 食物不再消失');

(function foodFix() {
  const w = new AI.NeuroWorld({ seed: 11, width: 420, height: 300, foodCount: 8, popSize: 10, genLength: 100000 });
  const before = w.food.length;
  for (let i = 0; i < 30; i++) w.addFood(60 + i * 8, 200);
  eq(w.food.length, before + 30, '用户投放 30 个食物后一个都没丢（旧版本会被挤掉）');
  ok(w.food.filter(f => f.mine).length === 30, '用户投放的食物带标记');

  // 跑一段，确认食物总数不减少
  w.setPhase('running');
  for (let i = 0; i < 200; i++) w.tick();
  eq(w.food.length, before + 30, '推进 200 帧后食物总数不变（吃掉会换位置而不是凭空消失）');
})();

G('神经进化 · 预设与存档');

(function presets() {
  const keys = Object.keys(AI.PRESETS);
  ok(keys.length >= 5, '至少内置 5 套预设（' + keys.join(' / ') + '）');

  keys.forEach(k => {
    const w = new AI.NeuroWorld({ width: 420, height: 300, preset: k });
    eq(w.presetKey, k, '预设「' + AI.PRESETS[k].name + '」生效');
    ok(!w.fitsWall(w.spawn[0] * 420, w.spawn[1] * 300, 8),
       '预设「' + AI.PRESETS[k].name + '」的出生点不在障碍里');
    ok(w.food.every(f => !w.fitsWall(f.x, f.y, 2)),
       '预设「' + AI.PRESETS[k].name + '」的食物没被生成在障碍里');
  });

  // 非空预设必须真的画了障碍
  ['canyon', 'maze', 'funnel', 'columns'].forEach(k => {
    const w = new AI.NeuroWorld({ width: 420, height: 300, preset: k });
    ok(w.strokes.length > 0 && w.strokeLength() > 50,
       '预设「' + AI.PRESETS[k].name + '」铺了实际存在的障碍');
  });
})();

(function difficulty() {
  const w = new AI.NeuroWorld({ width: 420, height: 300 });
  w.setDifficulty('hard');
  eq(w.popSize, AI.DIFFICULTY.hard.popSize, '严苛档种群规模生效');
  eq(w.genLength, AI.DIFFICULTY.hard.genLength, '严苛档世代长度生效');
  w.setDifficulty('easy');
  ok(w.genLength < AI.DIFFICULTY.hard.genLength, '轻松档一代更短');
})();

(function layoutArchive() {
  const a = new AI.NeuroWorld({ width: 420, height: 300, preset: 'maze' });
  a.beginStroke(30, 260);
  a.extendStroke(120, 260);
  a.endStroke();
  const dump = JSON.parse(JSON.stringify(a.exportLayout()));
  ok(dump.strokes.length === a.strokes.length, '存档包含全部笔画');
  ok(dump.params && dump.params.popSize > 0, '存档包含参数');

  const b = new AI.NeuroWorld({ width: 420, height: 300 });
  ok(b.importLayout(dump), '存档能导入');
  eq(b.strokes.length, a.strokes.length, '导入后笔画数量一致');
  eq(b.presetKey, 'custom', '导入后标记为自定义布局');
  eq(b.popSize, a.popSize, '导入后参数一并恢复');
  ok(b.importLayout(null) === false, '空存档被安全拒绝');
})();

G('神经进化 · 进化有效性');

(function evolution() {
  const cfg = { seed: 2024, width: 460, height: 320, popSize: 34, genLength: 420, foodCount: 14, preset: 'empty' };
  const w1 = new AI.NeuroWorld(cfg);
  const w2 = new AI.NeuroWorld(cfg);

  w1.setPhase('running');
  for (let i = 0; i < 420 * 30; i++) w1.tick();

  ok(w1.history.length >= 25, '记录了进化曲线（' + w1.history.length + ' 代）');
  const early = w1.history.slice(0, 8).map(h => h.best);
  const late = w1.history.slice(-8).map(h => h.best);
  const earlyMax = Math.max.apply(null, early);
  const lateMax = Math.max.apply(null, late);
  ok(lateMax >= earlyMax, '后期最好成绩不低于前期（' + earlyMax + ' → ' + lateMax + '）');
  ok(lateMax >= 3, '进化出的虫子真的学会觅食（最好 ' + lateMax + ' 个）');
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  ok(avg(late) > avg(early), '种群平均觅食能力提升（' + avg(early).toFixed(1) + ' → ' + avg(late).toFixed(1) + '）');

  w2.setPhase('running');
  for (let i = 0; i < 420 * 5; i++) w2.tick();
  eq(JSON.stringify(w2.history), JSON.stringify(w1.history.slice(0, w2.history.length)),
     '相同种子 → 进化过程完全可复现');
})();

(function mutation() {
  const w = new AI.NeuroWorld({ seed: 3, width: 420, height: 300, popSize: 10, genLength: 50 });
  const before = w.pop[0].brain.weightSum();
  const clone = w.pop[0].brain.clone();
  eq(clone.weightSum(), before, '复制体权重与原网络一致');
  w._mutate(clone);
  ok(clone.weightSum() !== before, '变异确实改动了网络权重');
})();

/* ============================================================
   4. AI 读心猜拳 —— 是否真的在学习
   ============================================================ */
G('AI 读心猜拳');

(function basics() {
  eq(AI.MOVES.length, 3, '三种手势');
  // 石头(0) 赢 剪刀(1)
  ok(AI.beats(0, 1), '石头赢剪刀');
  ok(AI.beats(1, 2), '剪刀赢布');
  ok(AI.beats(2, 0), '布赢石头');
  eq(AI.result(0, 1), 1, '玩家石头 vs AI 剪刀 → 玩家赢');
  eq(AI.result(1, 0), -1, '玩家剪刀 vs AI 石头 → 玩家输');
  eq(AI.result(0, 0), 0, '相同 → 平局');
})();

(function learnsCycle() {
  // 玩家按 0,1,2,0,1,2... 循环出拳 —— 这是最容易被学会的模式
  const mind = new AI.RPSMind();
  const N = 120;
  for (let i = 0; i < N; i++) {
    const p = i % 3;
    const d = mind.decide();
    mind.observe(p, d.aiMove);
  }
  const rep = mind.report();
  ok(rep.accuracy > 0.6, '对循环出拳的预测命中率 > 60%（实际 ' +
     (rep.accuracy * 100).toFixed(1) + '%）');
  ok(rep.playerWin < 0.5, '玩家胜率被压到 50% 以下（实际 ' +
     (rep.playerWin * 100).toFixed(1) + '%）');
})();

(function learnsWinStay() {
  // 玩家采用"赢了重复、输了换招"
  const rng = AI.makeRng(88);
  const mind = new AI.RPSMind();
  let lastP = 0, lastR = 0;
  for (let i = 0; i < 200; i++) {
    let p;
    if (lastR > 0) p = lastP;
    else if (lastR < 0) p = AI.BEATS[lastP];
    else p = Math.floor(rng() * 3);
    const d = mind.decide();
    mind.observe(p, d.aiMove);
    lastP = p;
    lastR = AI.result(p, d.aiMove);
  }
  const rep = mind.report();
  ok(rep.accuracy > 0.4, '识别出「赢了重复」的习惯（命中率 ' +
     (rep.accuracy * 100).toFixed(1) + '%）');
  ok(rep.aiWin > rep.playerWin, 'AI 胜率反超玩家（AI ' +
     (rep.aiWin * 100).toFixed(1) + '% vs 玩家 ' + (rep.playerWin * 100).toFixed(1) + '%）');
})();

(function reportShape() {
  const mind = new AI.RPSMind();
  for (let i = 0; i < 30; i++) {
    const d = mind.decide();
    mind.observe(i % 3, d.aiMove);
  }
  const r = mind.report();
  eq(r.total, 30, '报告记录总轮数');
  eq(r.movePct.length, 3, '报告给出三种手势占比');
  ok(Math.abs(r.movePct.reduce((a, b) => a + b, 0) - 1) < 1e-6, '占比之和为 1');
  ok(r.longestStreak >= 1, '统计最长连出（' + r.longestStreak + '）');
  ok(r.afterLoss.length === 3 && r.afterWin.length === 3, '统计输赢之后的出拳分布');
  ok(!r.bestExpert || r.bestExpert.rate >= 0, '能指出最准的专家');
})();

(function expertWeightsAdapt() {
  const mind = new AI.RPSMind();
  for (let i = 0; i < 60; i++) {
    const d = mind.decide();
    mind.observe(i % 3, d.aiMove);
  }
  const ws = mind.experts.map(e => e.weight);
  ok(Math.max.apply(null, ws) > Math.min.apply(null, ws) * 1.5,
     '专家的权重被拉开（差的被降权）');
})();

/* ============================================================
   5. 寻路
   ============================================================ */
G('寻路算法');

(function emptyGrid() {
  const W = 10, H = 10;
  const grid = new Array(W * H).fill(0);
  const bfs = AI.solve(grid, W, H, 0, 99, 'bfs');
  const ast = AI.solve(grid, W, H, 0, 99, 'astar');
  const gre = AI.solve(grid, W, H, 0, 99, 'greedy');

  eq(bfs.path.length, 19, '空场上最短路径节点数 = 19');
  eq(ast.path.length, 19, 'A* 找到同样长度的路径');
  eq(gre.path.length, 19, '贪心在空场上也走最短');
  ok(ast.visited.length <= bfs.visited.length,
     'A* 探索的格子不多于 BFS（' + ast.visited.length + ' ≤ ' + bfs.visited.length + '）');
})();

(function withWall() {
  const W = 12, H = 12;
  const grid = new Array(W * H).fill(0);
  // 竖一堵墙，只在底部留口子
  for (let y = 0; y < H - 3; y++) grid[y * W + 6] = 1;

  const bfs = AI.solve(grid, W, H, 0, W * H - 1, 'bfs');
  const ast = AI.solve(grid, W, H, 0, W * H - 1, 'astar');

  ok(bfs.path.length > 0, 'BFS 能绕过障碍找到路');
  eq(ast.path.length, bfs.path.length, 'A* 与 BFS 路径长度一致（都是最短）');
  ok(ast.visited.length < bfs.visited.length,
     'A* 比 BFS 少探索很多格子（' + ast.visited.length + ' < ' + bfs.visited.length + '）');

  // 路径必须连续且不穿墙
  let contiguous = true;
  for (let i = 1; i < ast.path.length; i++) {
    const a = ast.path[i - 1], b = ast.path[i];
    if (AI.manhattan(a, b, W) !== 1) contiguous = false;
    if (grid[b] === 1) contiguous = false;
  }
  ok(contiguous, '路径每一步相邻且不穿墙');
})();

(function unreachable() {
  const W = 8, H = 8;
  const grid = new Array(W * H).fill(0);
  for (let x = 0; x < W; x++) grid[3 * W + x] = 1;   // 整行封死
  const r = AI.solve(grid, W, H, 0, 63, 'bfs');
  eq(r.path.length, 0, '目标不可达时返回空路径');
})();

/* ============================================================
   结果
   ============================================================ */
console.log('\n' + '─'.repeat(50));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
