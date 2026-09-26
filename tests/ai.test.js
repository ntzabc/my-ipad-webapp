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
   3. 神经进化 —— 进化确实在改善
   ============================================================ */
G('神经进化');

(function evolution() {
  const w1 = new AI.NeuroWorld({ seed: 2024, popSize: 30, genLength: 400, foodCount: 12 });
  const w2 = new AI.NeuroWorld({ seed: 2024, popSize: 30, genLength: 400, foodCount: 12 });

  eq(w1.pop.length, 30, '种群规模正确');
  eq(w1.food.length, 12, '食物数量正确');

  // 跑一代
  const gen0 = w1.generation;
  for (let i = 0; i < 400; i++) w1.tick();
  eq(w1.generation, gen0 + 1, '跑满一代后世代 +1');

  // 跑 30 代
  for (let i = 0; i < 400 * 29; i++) w1.tick();
  ok(w1.history.length >= 25, '记录了进化曲线（' + w1.history.length + ' 代）');

  const early = w1.history.slice(0, 8).map(h => h.best);
  const late = w1.history.slice(-8).map(h => h.best);
  const earlyMax = Math.max.apply(null, early);
  const lateMax = Math.max.apply(null, late);
  ok(lateMax >= earlyMax, '后期最好成绩不低于前期（' + earlyMax + ' → ' + lateMax + '）');
  ok(lateMax >= 3, '进化出的智能体真的学会觅食（最好 ' + lateMax + ' 个）');
  const earlyAvg = early.reduce((a,b)=>a+b,0) / early.length;
  const lateAvg = late.reduce((a,b)=>a+b,0) / late.length;
  ok(lateAvg > earlyAvg, '种群平均觅食能力提升（' + earlyAvg.toFixed(1) + ' → ' + lateAvg.toFixed(1) + '）');

  // 确定性
  for (let i = 0; i < 400 * 5; i++) w2.tick();
  ok(JSON.stringify(w2.history) ===
     JSON.stringify(w1.history.slice(0, w2.history.length)),
     '相同种子 → 进化过程完全可复现');
})();

(function mutation() {
  const w = new AI.NeuroWorld({ seed: 3, popSize: 10, genLength: 50 });
  const before = w.pop[0].brain.weightSum();
  const clone = w.pop[0].brain.clone();
  eq(clone.weightSum(), before, '复制体权重与原网络一致');
  w._mutate(clone);
  ok(clone.weightSum() !== before, '变异确实改动了网络权重');
})();

(function interactivity() {
  const w = new AI.NeuroWorld({ seed: 11, popSize: 8, genLength: 100, foodCount: 5 });
  const n0 = w.food.length;
  w.addFood(50, 50);
  eq(w.food.length, n0 + 1, '点击可以加食物');
  w.addWall(100, 100);
  eq(w.walls.length, 1, '可以加障碍');
  w.clearWalls();
  eq(w.walls.length, 0, '可以清空障碍');
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
   5. 反转棋
   ============================================================ */
G('反转棋');

(function setup() {
  const b = AI.newBoard();
  const c = AI.countDiscs(b);
  eq(c.black, 2, '开局黑 2 子');
  eq(c.white, 2, '开局白 2 子');
  eq(AI.legalMoves(b, 1).length, 4, '黑棋开局有 4 个合法落点');
  eq(AI.legalMoves(b, -1).length, 4, '白棋开局有 4 个合法落点');
})();

(function flipping() {
  const b = AI.newBoard();
  // 黑棋下 d3（索引 19 = x3,y2）翻 d4
  const step = AI.applyMove(b, 19, 1);
  ok(step !== null, '合法落点可以下');
  eq(step.flipped, 1, '翻掉 1 颗子');
  eq(step.board[19], 1, '落点变成黑子');
  eq(step.board[27], 1, '被夹住的子翻成黑子');
  eq(AI.flipsFor(b, 18, 1), null, '非法落点返回 null');

  const c = AI.countDiscs(step.board);
  eq(c.black, 4, '下完后黑 4 子');
  eq(c.white, 1, '下完后白 1 子');
})();

(function corner() {
  // 构造一个局面：角 (0,0) 是黑棋的合法落点
  const b = new Int8Array(64);
  b[AI.idx(2, 2)] = 1;    // 黑
  b[AI.idx(1, 1)] = -1;   // 白
  b[AI.idx(2, 0)] = 1;    // 黑
  b[AI.idx(1, 0)] = -1;   // 白

  const fl = AI.flipsFor(b, AI.idx(0, 0), 1);
  ok(fl !== null && fl.length === 2, '角上是合法落点，能翻 2 子');
  ok(AI.legalMoves(b, 1).length > 1, '同时还有其他合法落点（可比较）');

  const mv = AI.bestMove(b, 1, 3, 1);
  eq(mv, AI.idx(0, 0), 'AI 会选择吃角（位置权重最高的那手）');
})();

(function search() {
  const b = AI.newBoard();
  const mv = AI.bestMove(b, 1, 4, 2);
  ok(AI.legalMoves(b, 1).indexOf(mv) >= 0, 'AI 返回的是合法落点');

  const e1 = AI.easyMove(b, 1, 1);
  ok(e1 === null || AI.legalMoves(b, 1).indexOf(e1) >= 0, '简单档也返回合法落点');

  // 无子可下时返回 null
  const empty = new Int8Array(64);
  empty[0] = 1;
  eq(AI.bestMove(empty, -1, 2, 1), null, '白棋无处可下时返回 null');

  // 全盘下完的终局评估不崩
  const full = new Int8Array(64).fill(1);
  ok(isFinite(AI.evaluate(full, 1)), '终局评估返回有限数值');
})();

(function playout() {
  // 让 AI 自战一整局，确保不崩、不出现非法落点
  let b = AI.newBoard();
  let player = 1;
  let plies = 0, passes = 0;
  const seed = AI.makeRng(4);
  while (plies < 70 && passes < 2) {
    const mv = AI.bestMove(b, player, 3, Math.floor(seed() * 1e6));
    if (mv === null) { passes++; player = -player; continue; }
    passes = 0;
    const step = AI.applyMove(b, mv, player);
    if (!step) { ok(false, '自战出现非法落点'); return; }
    b = step.board;
    player = -player;
    plies++;
  }
  ok(plies > 20, 'AI 自战能走满一局（' + plies + ' 手）');
  const c = AI.countDiscs(b);
  eq(c.black + c.white + b.filter(x => x === 0).length, 64, '棋盘状态自洽');
})();

/* ============================================================
   6. 寻路
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
