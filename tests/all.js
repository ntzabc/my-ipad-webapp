/* ============================================================
   一次跑完全部测试
     node tests/all.js        （或 npm test）

   分开跑是因为 smoke 那套需要 jsdom，没装的时候要能优雅跳过；
   而且它自己会 process.exit，放在同一个进程里会打断后面的套件。
   ============================================================ */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SUITES = [
  ['ai.test.js', '算法层：手写神经网络 / 反向传播 / 遗传算法 / 读心 / 寻路'],
  ['sense.test.js', '传感器算法：肤色分割 / 头部追踪 / 眼部区域 / 图像预处理 / 音高'],
  ['vision.test.js', '图像分析：边缘 / 霍夫直线 / 区域分割 / 3D 面片'],
  ['consistency.test.js', '静态一致性：选择器 / kit 方法 / CSS 类 / 清理函数 / 分类'],
  ['smoke.test.js', '浏览器环境冒烟：真的开一遍每个玩法（需要 jsdom）']
];

const root = __dirname;
const total = { pass: 0, fail: 0, skipped: 0 };

console.log('');
console.log('  AI Lab · 全部测试');
console.log('  ' + '='.repeat(58));

SUITES.forEach((pair, i) => {
  const file = pair[0];
  const desc = pair[1];
  console.log('');
  console.log('  [' + (i + 1) + '/' + SUITES.length + '] ' + file);
  console.log('        ' + desc);

  if (!fs.existsSync(path.join(root, file))) {
    console.log('        → 文件不存在，跳过');
    total.skipped++;
    return;
  }

  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(root, file)], {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }

  const hits = out.match(/通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项/g) || [];
  const last = hits[hits.length - 1] || '';
  const m = last.match(/通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项/);

  if (/跳过：没装 jsdom/.test(out)) {
    console.log('        → 没装 jsdom，跳过（npm install jsdom 后即可运行）');
    total.skipped++;
    return;
  }
  if (!m) {
    console.log('        → 没有解析出结果，原样输出：');
    console.log(out.split('\n').slice(-14).map(l => '          ' + l).join('\n'));
    total.fail++;
    return;
  }

  const p = parseInt(m[1], 10), f = parseInt(m[2], 10);
  total.pass += p;
  total.fail += f;
  console.log('        → 通过 ' + p + ' 项，失败 ' + f + ' 项' + (f ? '   ✗' : '   ✓'));

  if (f) {
    const bad = out.split('\n').filter(l => /^\s+✗/.test(l));
    bad.slice(0, 10).forEach(l => console.log('          ' + l.trim()));
  }
});

console.log('');
console.log('  ' + '='.repeat(58));
console.log('  合计：通过 ' + total.pass + ' 项，失败 ' + total.fail + ' 项' +
  (total.skipped ? '（' + total.skipped + ' 套跳过）' : ''));
console.log('');

process.exit(total.fail ? 1 : 0);
