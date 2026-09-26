/* ============================================================
   静态一致性检查 —— 没有浏览器也能查出一大类低级错误
     node tests/consistency.test.js

   查四件事：
   1. app.js 里 $('#xxx') 引用的 id，index.html 里必须存在
   2. features.js 里 kit.xxx() 调用的方法，app.js 的 kit 里必须有
   3. features.js 里 getElementById('y')，必须由它自己创建出来
   4. index.html 里用到的 class，style.css 里必须有定义
   ============================================================ */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const html = read('index.html');
const app = read('app.js');
const feats = read('features.js');
const css = read('style.css');
const sw = read('sw.js');

let pass = 0, fail = 0;
const bad = [];

function ok(cond, label, detail) {
  if (cond) { pass++; }
  else { fail++; bad.push(label + (detail ? '\n      ' + detail : '')); }
}

/* ---------- 1. app.js 的选择器 vs index.html ---------- */
const htmlIds = new Set();
(html.match(/\bid="([^"]+)"/g) || []).forEach(m => htmlIds.add(m.slice(4, -1)));

const appSelectors = new Set();
(app.match(/\$\('#([A-Za-z0-9_-]+)'/g) || []).forEach(m => appSelectors.add(m.slice(4, -1)));
(app.match(/getElementById\('([A-Za-z0-9_-]+)'\)/g) || [])
  .forEach(m => appSelectors.add(m.replace(/getElementById\('|'\)/g, '')));

console.log('\n【选择器检查】');
appSelectors.forEach(id => ok(htmlIds.has(id), 'app.js 引用的 #' + id + ' 在 index.html 中存在'));

/* ---------- 2. kit 方法检查 ---------- */
const kitBlock = app.match(/const kit = \{([\s\S]*?)\};/);
ok(!!kitBlock, '找到了 app.js 里的 kit 定义');
const kitKeys = kitBlock
  ? kitBlock[1].split(',').map(s => s.split(':')[0].trim()).filter(Boolean)
  : [];

const usedKit = new Set();
(feats.match(/\bkit\.([A-Za-z_][A-Za-z0-9_]*)/g) || [])
  .forEach(m => usedKit.add(m.slice(4)));

console.log('\n【kit 方法检查】');
usedKit.forEach(k => ok(kitKeys.indexOf(k) >= 0,
  'features.js 用到的 kit.' + k + ' 在 app.js 里已提供',
  'app.js 的 kit 只有：' + kitKeys.join(', ')));

/* ---------- 3. features.js 动态创建的 id ---------- */
const featIds = new Set();
(feats.match(/\bid="([A-Za-z0-9_-]+)"/g) || []).forEach(m => featIds.add(m.slice(4, -1)));
const featLookups = new Set();
(feats.match(/getElementById\('([A-Za-z0-9_-]+)'\)/g) || [])
  .forEach(m => featLookups.add(m.replace(/getElementById\('|'\)/g, '')));

console.log('\n【动态元素 id 检查】');
featLookups.forEach(id => ok(featIds.has(id),
  'features.js 查找的 #' + id + ' 会由它自己创建'));

/* ---------- 4. index.html 的 class vs style.css ---------- */
const cssClasses = new Set();
(css.match(/\.([A-Za-z][A-Za-z0-9_-]*)/g) || []).forEach(m => cssClasses.add(m.slice(1)));

const htmlClasses = new Set();
(html.match(/\bclass="([^"]+)"/g) || []).forEach(m => {
  m.slice(7, -1).split(/\s+/).forEach(c => { if (c) htmlClasses.add(c); });
});

console.log('\n【HTML class 覆盖检查】');
htmlClasses.forEach(c => ok(cssClasses.has(c), 'index.html 的 .' + c + ' 在 style.css 里有定义'));

/* ---------- 5. 脚本都被引进来了 ---------- */
console.log('\n【脚本与缓存检查】');
['ai.js', 'particles.js', 'features.js', 'app.js'].forEach(f => {
  ok(html.indexOf('src="' + f + '"') >= 0, 'index.html 引用了 ' + f);
  ok(sw.indexOf("'./" + f + "'") >= 0 || sw.indexOf('"./' + f + '"') >= 0,
     'sw.js 离线缓存收录了 ' + f);
});

/* ---------- 6. 功能定义完整性 ---------- */
console.log('\n【功能定义检查】');
require(path.join(root, 'features.js'));
const FEATURES = globalThis.FEATURES || [];
ok(FEATURES.length >= 4, '至少定义了 4 个玩法（实际 ' + FEATURES.length + ' 个）');
FEATURES.forEach(f => {
  ok(!!f.id && !!f.name && !!f.cat, '功能 ' + f.id + ' 的 id/name/cat 齐全');
  ok(typeof f.render === 'function', '功能 ' + f.id + ' 有 render 函数');
  ok(Array.isArray(f.tags) && f.tags.length > 0, '功能 ' + f.id + ' 有搜索标签');
  ok(/^<[a-z]/i.test(f.icon || ''), '功能 ' + f.id + ' 的图标是 SVG 片段');
});
const ids = FEATURES.map(f => f.id);
ok(new Set(ids).size === ids.length, '功能 id 没有重复');

/* ---------- 7. 每个 render 都返回清理函数 ---------- */
console.log('\n【资源清理检查】');
FEATURES.forEach(f => {
  const at = feats.indexOf("id: '" + f.id + "'");
  const nextAdd = feats.indexOf('\n  add({', at);
  const seg = feats.slice(at, nextAdd > 0 ? nextAdd : feats.length);
  const hasLoop = /requestAnimationFrame|setInterval/.test(seg);
  const hasCleanup = /return \(\) =>/.test(seg);
  ok(!hasLoop || hasCleanup,
     '功能 ' + f.id + (hasLoop ? ' 用了循环，必须有清理函数' : ' 无循环，无需清理'));
});

/* ---------- 结果 ---------- */
console.log('\n' + '─'.repeat(50));
if (fail) {
  console.log('失败项：');
  bad.forEach(b => console.log('  ✗ ' + b));
}
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
