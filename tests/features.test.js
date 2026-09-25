/* 功能计算逻辑的自动化测试 —— 用 Node 直接跑：
     node tests/features.test.js
   这些都是算错会出事的逻辑（钱、日期、大写），必须验证。
*/

require('../features.js');

const F = globalThis.MYAPP_FEATURES;
const U = globalThis.MYAPP_UTIL;

let pass = 0, fail = 0;

function eq(actual, expected, label) {
  const a = String(actual), e = String(expected);
  if (a === e) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '\n      期望: ' + e + '\n      实际: ' + a); }
}

function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}

function get(id) { return F.find(f => f.id === id); }
function run(id, values) {
  const f = get(id);
  const v = {};
  f.fields.forEach(fl => { v[fl.key] = typeof fl.value === 'function' ? fl.value() : fl.value; });
  Object.assign(v, values);
  return f.compute(v);
}
function find(rows, label) { const r = rows.find(x => x.label === label); return r ? r.value : undefined; }

/* ---------------- 人民币大写 ---------------- */
console.log('\n【人民币大写】');
eq(U.rmbUpper(0), '零元整', '0');
eq(U.rmbUpper(1234.56), '壹仟贰佰叁拾肆元伍角陆分', '1234.56');
eq(U.rmbUpper(100), '壹佰元整', '100');
eq(U.rmbUpper(1.5), '壹元伍角整', '1.5');
eq(U.rmbUpper(0.01), '壹分', '0.01');
eq(U.rmbUpper(0.1), '壹角整', '0.1');
eq(U.rmbUpper(1000.05), '壹仟元零伍分', '1000.05');
eq(U.rmbUpper(10000), '壹万元整', '10000');
eq(U.rmbUpper(1000000), '壹佰万元整', '1000000');
eq(U.rmbUpper(100000000), '壹亿元整', '100000000');
eq(U.rmbUpper(105), '壹佰零伍元整', '105');
eq(U.rmbUpper(1005), '壹仟零伍元整', '1005');
eq(U.rmbUpper(20.5), '贰拾元伍角整', '20.5');
eq(U.rmbUpper(-50), '负伍拾元整', '-50');
eq(U.rmbUpper(80800030.4), '捌仟零捌拾万零叁拾元肆角整', '80800030.4（万位与个位之间补零）');
eq(U.rmbUpper(100000005), '壹亿零伍元整', '100000005（整亿段补零）');
eq(U.rmbUpper(20000000.5), '贰仟万元伍角整', '20000000.5（整万不带零）');
eq(U.rmbUpper(100000000000), '壹仟亿元整', '1 千亿');
eq(U.rmbUpper(3456.78), '叁仟肆佰伍拾陆元柒角捌分', '3456.78');
eq(U.rmbUpper(100.1), '壹佰元壹角整', '100.1（零分不写）');
eq(U.rmbUpper(1100000), '壹佰壹拾万元整', '1100000');

/* ---------------- 单位换算 ---------------- */
console.log('\n【单位换算】');
const u1 = run('unit', { value: 1, unit: '米 m' });
eq(find(u1, '厘米 cm'), '100', '1 米 = 100 厘米');
eq(find(u1, '毫米 mm'), '1,000', '1 米 = 1000 毫米');
const u2 = run('unit', { value: 100, unit: '摄氏度 °C' });
eq(find(u2, '华氏度 °F'), '212', '100°C = 212°F');
eq(find(u2, '开尔文 K'), '373.15', '100°C = 373.15K');
const u3 = run('unit', { value: 1, unit: '斤' });
eq(find(u3, '克 g'), '500', '1 斤 = 500 克');
const u4 = run('unit', { value: 1, unit: '吉字节 GB' });
eq(find(u4, '兆字节 MB'), '1,024', '1 GB = 1024 MB');
const u5 = run('unit', { value: 1, unit: '亩' });
eq(find(u5, '平方米 m²'), '666.667', '1 亩 ≈ 666.667 m²');
const u6 = run('unit', { value: 1, unit: '英里 mi' });
eq(find(u6, '米 m'), '1,609.344', '1 英里 = 1609.344 米');

/* ---------------- 房贷 ---------------- */
console.log('\n【房贷月供】');
const l1 = run('loan', { amount: 100, rate: 3.5, years: 30, mode: 'equal' });
eq(find(l1, '每月月供'), '4,490.45 元', '100万/3.5%/30年 等额本息');
eq(find(l1, '总利息'), '616,560.88 元', '100万/3.5%/30年 总利息');
const l2 = run('loan', { amount: 100, rate: 3.5, years: 30, mode: 'capital' });
eq(find(l2, '首月月供'), '5,694.44 元', '100万/3.5%/30年 等额本金首月');
const l3 = run('loan', { amount: 100, rate: 0, years: 10, mode: 'equal' });
eq(find(l3, '每月月供'), '8,333.33 元', '零利率 100万/10年 = 8333.33');
const l4 = run('loan', { amount: 100, rate: 3.5, years: 30, mode: 'capital' });
ok(/^[\d,]+\.\d\d 元$/.test(find(l4, '总利息')), '等额本金总利息格式正确');

/* ---------------- 含税价 ---------------- */
console.log('\n【含税价换算】');
const t1 = run('tax', { amount: 1000, rate: 13, dir: 'in' });
eq(find(t1, '不含税金额'), '884.96 元', '1000 含税 13% → 884.96');
eq(find(t1, '税额'), '115.04 元', '税额 115.04');
const t2 = run('tax', { amount: 1000, rate: 13, dir: 'ex' });
eq(find(t2, '含税金额'), '1,130.00 元', '1000 不含税 13% → 1130');

/* ---------------- 百分比 ---------------- */
console.log('\n【百分比与折扣】');
const p1 = run('percent', { base: 200, other: 250, pct: 15, disc: 8.5 });
eq(find(p1, 'A 的 15%'), '30', '200 的 15% = 30');
eq(find(p1, 'B 是 A 的'), '125 %', '250 是 200 的 125%');
eq(find(p1, 'B 比 A'), '多 25 %', '250 比 200 多 25%');
eq(find(p1, 'A 打 8.5 折'), '170', '200 打 8.5 折 = 170');

/* ---------------- 日期 ---------------- */
console.log('\n【日期推算 / 间隔】');
const d1 = run('dateadd', { start: '2026-09-25', offset: 30, unit: 'day' });
eq(find(d1, '标准格式'), '2026-10-25', '2026-09-25 + 30 天');
const d2 = run('dateadd', { start: '2026-09-25', offset: -30, unit: 'day' });
eq(find(d2, '标准格式'), '2026-08-26', '2026-09-25 − 30 天');
const d3 = run('dateadd', { start: '2026-01-31', offset: 1, unit: 'month' });
eq(find(d3, '标准格式'), '2026-03-03', '1月31日 + 1 月（JS 溢出行为）');
const d4 = run('datediff', { from: '2026-01-01', to: '2026-12-31' });
eq(find(d4, '相差天数'), '364 天', '2026 年 1/1 到 12/31 = 364 天');
const d5 = run('datediff', { from: '2026-09-25', to: '2026-09-25' });
eq(find(d5, '相差天数'), '0 天', '同一天 = 0');
const d6 = run('datediff', { from: '2026-09-19', to: '2026-09-25' });
eq(find(d6, '其中工作日'), '4 天', '9/19(六)~9/25(五) 工作日 = 4');
const d7 = run('datediff', { from: '2026-09-25', to: '2026-09-19' });
eq(find(d7, '相差天数'), '6 天', '反向也取绝对值');

/* ---------------- 睡眠 ---------------- */
console.log('\n【睡眠时间】');
const s1 = run('sleep', { mode: 'wake', time: '07:00' });
ok(s1.some(r => /入睡$/.test(String(r.value))), '起床模式返回入睡时间');
const s2 = run('sleep', { mode: 'now' });
ok(s2.some(r => /起床$/.test(String(r.value))), '现在睡模式返回起床时间');

/* ---------------- 健康 ---------------- */
console.log('\n【BMI 与热量】');
const b1 = run('bmi', { height: 170, weight: 65, age: 30, sex: 'm' });
eq(find(b1, 'BMI'), '22.4913（正常）', '170cm/65kg BMI');
eq(find(b1, '基础代谢 BMR'), '1,567.5 千卡/天', '男性 BMR');
const b2 = run('bmi', { height: 160, weight: 80, age: 40, sex: 'f' });
ok(find(b2, 'BMI').includes('肥胖'), '160cm/80kg 应判为肥胖');

/* ---------------- 密码 ---------------- */
console.log('\n【密码生成】');
const w1 = run('pwd', { len: 20, lower: true, upper: true, digit: true, symbol: true, exclude: false });
const pw = find(w1, '生成的密码');
eq(pw.length, 20, '长度 20');
ok(/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw), '包含大小写和数字');
const w2 = run('pwd', { len: 24, lower: true, upper: true, digit: true, symbol: false, exclude: true });
ok(!/[0O1lI]/.test(find(w2, '生成的密码')), '排除易混字符生效');
const w3 = run('pwd', { len: 16, lower: false, upper: false, digit: false, symbol: false, exclude: true });
eq(find(w3, '提示'), '至少要选一类字符', '全不选时给出提示');

/* ---------------- 文本 ---------------- */
console.log('\n【文本工具箱】');
const x1 = run('text', { text: 'hello world\n你好 世界\nhello world', op: 'none' });
eq(find(x1, '字符数（含空格）'), '29', '字符数');
eq(find(x1, '行数 / 非空行'), '3 / 3', '行数统计');
const x2 = run('text', { text: 'a\nb\na\nc\nb', op: 'dedup' });
eq(find(x2, '结果'), 'a\nb\nc', '按行去重');
const x3 = run('text', { text: '你好', op: 'base64' });
eq(find(x3, '结果'), '5L2g5aW9', 'Base64 编码中文');
const x4 = run('text', { text: '5L2g5aW9', op: 'unbase64' });
eq(find(x4, '结果'), '你好', 'Base64 解码回中文');
const x5 = run('text', { text: '你好', op: 'none' });
eq(find(x5, 'UTF-8 字节'), '6', '中文 6 字节');

/* ---------------- 结果 ---------------- */
console.log('\n' + '─'.repeat(46));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
