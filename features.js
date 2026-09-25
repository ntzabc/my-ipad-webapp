/* ============================================================
   features.js · 功能定义与计算逻辑
   这里只有数据和纯函数，不碰 DOM —— 所以可以脱离浏览器单独测试。
   ============================================================ */

(function (global) {
  'use strict';

  /* ---------------- 通用数值格式化 ---------------- */
  function fmt(x) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    if (x === 0) return '0';
    const a = Math.abs(x);
    if (a >= 1e15 || (a < 1e-6 && a > 0)) {
      // 极大/极小值用科学计数法，但别太丑
      const e = x.toExponential(4);
      const [m, p] = e.split('e');
      return m.replace(/\.?0+$/, '') + '×10' + String(Number(p)).replace(/-/g, '⁻').replace(/\d/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]);
    }
    let s = a >= 1000
      ? x.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
      // 小于 1000 的取 6 位有效数字，避免 666.6666666667 这种长尾
      : String(Number(x.toPrecision(6)));
    return s;
  }

  function money(x) {
    if (!isFinite(x)) return '—';
    return x.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function n(v, d) {
    const x = Number(v);
    return isFinite(x) ? x : d;
  }

  /* ---------------- 日期工具 ---------------- */
  const WD = ['日', '一', '二', '三', '四', '五', '六'];

  function parseDate(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d) ? null : d;
  }

  function todayStr() {
    const d = new Date();
    const p = x => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function fmtDate(d) {
    if (!d) return '—';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 星期' + WD[d.getDay()];
  }

  function dayDiff(a, b) {
    // 按本地零点计算整天数，绕开夏令时
    const A = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
    const B = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
    return Math.round((B - A) / 86400000);
  }

  /* ---------------- 单位换算数据 ---------------- */
  const LIN = {
    '长度': {
      '毫米 mm': 0.001, '厘米 cm': 0.01, '米 m': 1, '千米 km': 1000,
      '英寸 in': 0.0254, '英尺 ft': 0.3048, '码 yd': 0.9144, '英里 mi': 1609.344, '海里 nmi': 1852
    },
    '重量': {
      '毫克 mg': 1e-6, '克 g': 0.001, '千克 kg': 1, '吨 t': 1000,
      '两': 0.05, '斤': 0.5, '磅 lb': 0.45359237, '盎司 oz': 0.028349523125
    },
    '面积': {
      '平方厘米 cm²': 1e-4, '平方米 m²': 1, '平方千米 km²': 1e6,
      '公顷 ha': 10000, '亩': 2000 / 3, '平方英尺 ft²': 0.09290304, '英亩 ac': 4046.8564224
    },
    '体积': {
      '毫升 mL': 0.001, '升 L': 1, '立方米 m³': 1000, '立方厘米 cm³': 1e-6,
      '加仑 gal': 3.785411784
    },
    '速度': {
      '米/秒 m/s': 1, '千米/小时 km/h': 1 / 3.6, '英里/小时 mph': 0.44704, '节 kn': 1852 / 3600
    },
    '数据': {
      '字节 B': 1, '千字节 KB': 1024, '兆字节 MB': 1048576,
      '吉字节 GB': 1073741824, '太字节 TB': 1099511627776
    },
    '时间': {
      '秒 s': 1, '分钟 min': 60, '小时 h': 3600,
      '天 d': 86400, '周 w': 604800, '年 y': 31536000
    }
  };

  const TEMP = {
    '摄氏度 °C': x => x,
    '华氏度 °F': f => (f - 32) * 5 / 9,
    '开尔文 K': k => k - 273.15
  };
  const TEMP_BACK = {
    '摄氏度 °C': c => c,
    '华氏度 °F': c => c * 9 / 5 + 32,
    '开尔文 K': c => c + 273.15
  };

  /* ---------------- 人民币大写 ---------------- */
  const CN_D = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
  const CN_U = ['', '拾', '佰', '仟'];
  const CN_G = ['', '万', '亿', '万亿'];

  function group4(s) {
    // s: 最多 4 位数字字符串，返回中文（不含"零"压缩）
    let out = '';
    const L = s.length;
    let zero = false;
    for (let i = 0; i < L; i++) {
      const d = Number(s[i]);
      const unit = CN_U[L - 1 - i];
      if (d === 0) {
        zero = true;
      } else {
        if (zero && out) out += CN_D[0];
        zero = false;
        out += CN_D[d] + unit;
      }
    }
    return out;
  }

  function rmbUpper(amount) {
    if (!isFinite(amount)) return '—';
    const neg = amount < 0;
    amount = Math.abs(amount);
    if (amount > 999999999999999.99) return '金额过大';

    amount = Math.round(amount * 100);
    if (amount === 0) return '零元整';

    let intPart = Math.floor(amount / 100);
    const cents = amount % 100;
    const jiao = Math.floor(cents / 10);
    const fen = cents % 10;

    let intStr = '';
    if (intPart > 0) {
      const ds = String(intPart);
      const groups = [];
      for (let i = ds.length; i > 0; i -= 4) {
        groups.unshift(ds.slice(Math.max(0, i - 4), i));
      }
      const parts = [];
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const seg = group4(g);
        const gi = groups.length - 1 - i;
        if (seg) {
          // 这一组不足千位（比如 0030）且前面还有内容时，中间必须補一个"零"：
          // 80800030 → 捌仟零捌拾万「零」叁拾
          if (i > 0 && Number(g) < 1000) parts.push(CN_D[0]);
          parts.push(seg + CN_G[gi]);
        } else if (parts.length && i < groups.length - 1) {
          // 整万/整亿段全零，补一个"零"避免歧义
          parts.push(CN_D[0]);
        }
      }
      intStr = parts.join('').replace(/零+/g, '零').replace(/零$/, '');
    }

    let out = neg ? '负' : '';
    out += intStr ? intStr + '元' : '';

    if (jiao === 0 && fen === 0) {
      out += '整';
    } else if (jiao === 0) {
      out += (intStr ? CN_D[0] : '') + CN_D[fen] + '分';
    } else if (fen === 0) {
      out += CN_D[jiao] + '角整';
    } else {
      out += CN_D[jiao] + '角' + CN_D[fen] + '分';
    }
    return out;
  }

  /* ---------------- 功能列表 ---------------- */
  const FEATURES = [];
  const add = o => { FEATURES.push(o); };

  /* ===== 计算类 ===== */

  add({
    id: 'unit',
    name: '单位换算',
    desc: '长度 · 重量 · 面积 · 温度 · 速度',
    cat: '计算',
    icon: '<path d="M4 8h13l-3.2-3.2M20 16H7l3.2 3.2"/>',
    tags: ['单位', '换算', '长度', '重量', '温度', '面积', '体积', '速度', '存储', '厘米', '英寸', '斤', '公斤', '平方米', '亩'],
    fields: [
      { key: 'value', label: '数值', type: 'number', value: 1, step: 'any' },
      {
        key: 'unit', label: '单位', type: 'select', value: '米 m',
        optgroups: () => {
          const gs = [];
          Object.keys(LIN).forEach(f => {
            gs.push({ label: f, options: Object.keys(LIN[f]).map(u => ({ v: u, t: u })) });
          });
          gs.push({ label: '温度', options: Object.keys(TEMP).map(u => ({ v: u, t: u })) });
          return gs;
        }
      }
    ],
    compute(v) {
      const x = n(v.value, NaN);
      if (!isFinite(x)) return [{ label: '提示', value: '请输入数值' }];

      // 找出这个单位属于哪个族
      let fam = null, isTemp = false;
      if (TEMP[v.unit]) { isTemp = true; }
      else {
        for (const f of Object.keys(LIN)) {
          if (LIN[f][v.unit] !== undefined) { fam = f; break; }
        }
      }
      if (!isTemp && !fam) return [{ label: '提示', value: '请选择单位' }];

      const out = [{ label: '换算结果', value: '', primary: true, section: true }];

      if (isTemp) {
        const c = TEMP[v.unit](x);
        Object.keys(TEMP_BACK).forEach(u => {
          out.push({ label: u, value: fmt(TEMP_BACK[u](c)) });
        });
      } else {
        const base = x * LIN[fam][v.unit];
        Object.keys(LIN[fam]).forEach(u => {
          if (u === v.unit) return;
          out.push({ label: u, value: fmt(base / LIN[fam][u]) });
        });
      }
      return out;
    }
  });

  add({
    id: 'loan',
    name: '房贷月供',
    desc: '等额本息 / 等额本金，含总利息',
    cat: '计算',
    icon: '<path d="M3 10 12 4l9 6"/><path d="M5.5 10.5V19M10 10.5V19M14 10.5V19M18.5 10.5V19"/><path d="M3 19.5h18"/>',
    tags: ['房贷', '贷款', '月供', '利息', '等额本息', '等额本金', '车贷', '计算器'],
    fields: [
      { key: 'amount', label: '贷款金额', type: 'number', value: 100, unit: '万元', step: 'any' },
      { key: 'rate', label: '年利率', type: 'number', value: 3.5, unit: '%', step: 'any' },
      { key: 'years', label: '贷款年限', type: 'number', value: 30, unit: '年', step: 1 },
      { key: 'mode', label: '还款方式', type: 'select', value: 'equal', options: [{ v: 'equal', t: '等额本息' }, { v: 'capital', t: '等额本金' }] }
    ],
    compute(v) {
      const P = n(v.amount, 0) * 10000;
      const y = n(v.years, 0);
      const nMonth = Math.round(y * 12);
      const r = n(v.rate, 0) / 100 / 12;
      if (P <= 0 || nMonth <= 0) return [{ label: '提示', value: '请填写贷款金额和年限' }];

      const out = [];
      if (v.mode === 'capital') {
        const principal = P / nMonth;
        const first = principal + P * r;
        const last = principal + principal * r;
        const totalInterest = P * r * (nMonth + 1) / 2;
        out.push({ label: '首月月供', value: money(first) + ' 元', primary: true });
        out.push({ label: '每月递减', value: money(principal * r) + ' 元' });
        out.push({ label: '末月月供', value: money(last) + ' 元' });
        out.push({ label: '总利息', value: money(totalInterest) + ' 元' });
        out.push({ label: '还款总额', value: money(P + totalInterest) + ' 元' });
      } else {
        let m;
        if (r === 0) m = P / nMonth;
        else m = P * r * Math.pow(1 + r, nMonth) / (Math.pow(1 + r, nMonth) - 1);
        const total = m * nMonth;
        out.push({ label: '每月月供', value: money(m) + ' 元', primary: true });
        out.push({ label: '总利息', value: money(total - P) + ' 元' });
        out.push({ label: '还款总额', value: money(total) + ' 元' });
        out.push({ label: '利息占比', value: fmt((total - P) / total * 100) + ' %' });
      }
      out.push({ label: '还款期数', value: nMonth + ' 期' });
      return out;
    }
  });

  add({
    id: 'tax',
    name: '含税价换算',
    desc: '增值税 · 含税与不含税互算',
    cat: '计算',
    icon: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    tags: ['税', '含税', '不含税', '增值税', '发票', '税率', '报销'],
    fields: [
      { key: 'amount', label: '金额', type: 'number', value: 1000, unit: '元', step: 'any' },
      { key: 'rate', label: '税率', type: 'select', value: 13, options: [
        { v: 13, t: '13%（一般货物）' }, { v: 9, t: '9%（交通运输等）' },
        { v: 6, t: '6%（现代服务）' }, { v: 3, t: '3%（小规模）' },
        { v: 1, t: '1%（小规模优惠）' }, { v: 0, t: '0%（免税）' }
      ] },
      { key: 'dir', label: '这个金额是', type: 'select', value: 'in', options: [
        { v: 'in', t: '含税价 → 求不含税' }, { v: 'ex', t: '不含税价 → 求含税' }
      ] }
    ],
    compute(v) {
      const a = n(v.amount, 0);
      const r = n(v.rate, 0) / 100;
      if (a <= 0) return [{ label: '提示', value: '请输入金额' }];
      let ex, inc;
      if (v.dir === 'in') { inc = a; ex = r === 0 ? a : a / (1 + r); }
      else { ex = a; inc = ex * (1 + r); }
      const t = inc - ex;
      return [
        { label: '不含税金额', value: money(ex) + ' 元', primary: true },
        { label: '税额', value: money(t) + ' 元' },
        { label: '含税金额', value: money(inc) + ' 元' },
        { label: '适用税率', value: fmt(n(v.rate, 0)) + ' %' }
      ];
    }
  });

  add({
    id: 'percent',
    name: '百分比与折扣',
    desc: '占比 · 涨跌 · 打折，一次算清',
    cat: '计算',
    icon: '<path d="M19 5 5 19"/><circle cx="7.5" cy="7.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/>',
    tags: ['百分比', '折扣', '打折', '涨跌', '占比', '优惠', '比例'],
    fields: [
      { key: 'base', label: '基数 A', type: 'number', value: 200, step: 'any' },
      { key: 'other', label: '对比数 B', type: 'number', value: 250, step: 'any' },
      { key: 'pct', label: '百分比', type: 'number', value: 15, unit: '%', step: 'any' },
      { key: 'disc', label: '折扣', type: 'number', value: 8.5, unit: '折', step: 'any' }
    ],
    compute(v) {
      const A = n(v.base, NaN), B = n(v.other, NaN);
      const p = n(v.pct, NaN), d = n(v.disc, NaN);
      const out = [];
      if (isFinite(A) && isFinite(p)) {
        out.push({ label: 'A 的 ' + fmt(p) + '%', value: fmt(A * p / 100), primary: true });
      }
      if (isFinite(A) && isFinite(d)) {
        out.push({ label: 'A 打 ' + fmt(d) + ' 折', value: fmt(A * d / 10) });
        out.push({ label: '　省下', value: fmt(A - A * d / 10) });
      }
      if (isFinite(A) && isFinite(B) && A !== 0) {
        out.push({ section: true, label: 'A 与 B 的关系', value: '' });
        out.push({ label: 'B 是 A 的', value: fmt(B / A * 100) + ' %' });
        const delta = (B - A) / Math.abs(A) * 100;
        out.push({ label: 'B 比 A', value: (delta >= 0 ? '多 ' : '少 ') + fmt(Math.abs(delta)) + ' %' });
        out.push({ label: '绝对差', value: fmt(B - A) });
      }
      if (!out.length) return [{ label: '提示', value: '至少填一个数' }];
      return out;
    }
  });

  add({
    id: 'rmb',
    name: '金额大写',
    desc: '人民币中文大写，报销写单据用',
    cat: '计算',
    icon: '<path d="M7.5 4 12 11l4.5-7"/><path d="M12 11v9"/><path d="M8 14h8M8 17h8"/>',
    tags: ['大写', '人民币', '金额', '报销', '单据', '财务', '中文'],
    fields: [
      { key: 'amount', label: '金额', type: 'number', value: 1234.56, unit: '元', step: '0.01' }
    ],
    compute(v) {
      const a = n(v.amount, NaN);
      if (!isFinite(a)) return [{ label: '提示', value: '请输入金额' }];
      return [
        { label: '中文大写', value: rmbUpper(a), primary: true },
        { label: '小写', value: money(a) + ' 元' }
      ];
    }
  });

  /* ===== 时间类 ===== */

  add({
    id: 'dateadd',
    name: '日期推算',
    desc: '某天往后 / 往前推 N 天、周、月',
    cat: '时间',
    icon: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M12 13v5M9.5 15.5h5"/>',
    tags: ['日期', '推算', '几天后', '前几天', '加天数', '日历', '到期'],
    fields: [
      { key: 'start', label: '起算日期', type: 'date', value: () => todayStr() },
      { key: 'offset', label: '偏移量', type: 'number', value: 30, step: 1, hint: '往前推就填负数' },
      { key: 'unit', label: '单位', type: 'select', value: 'day', options: [
        { v: 'day', t: '天' }, { v: 'week', t: '周' }, { v: 'month', t: '月' }, { v: 'year', t: '年' }
      ] }
    ],
    compute(v) {
      const d = parseDate(v.start);
      if (!d) return [{ label: '提示', value: '请选择起算日期' }];
      const off = n(v.offset, 0);
      const res = new Date(d.getTime());
      if (v.unit === 'day') res.setDate(res.getDate() + off);
      else if (v.unit === 'week') res.setDate(res.getDate() + off * 7);
      else if (v.unit === 'month') res.setMonth(res.getMonth() + off);
      else res.setFullYear(res.getFullYear() + off);

      const today = parseDate(todayStr());
      return [
        { label: '结果日期', value: fmtDate(res), primary: true },
        { label: '标准格式', value: res.getFullYear() + '-' + String(res.getMonth() + 1).padStart(2, '0') + '-' + String(res.getDate()).padStart(2, '0') },
        { label: '距今天', value: dayDiff(today, res) + ' 天' },
        { label: '当年第', value: (Math.floor((res - new Date(res.getFullYear(), 0, 0)) / 86400000)) + ' 天' }
      ];
    }
  });

  add({
    id: 'datediff',
    name: '日期间隔',
    desc: '相差多少天 / 工作日',
    cat: '时间',
    icon: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 15h7M13 12.5 15.5 15 13 17.5"/>',
    tags: ['日期', '相差', '间隔', '天数', '工作日', '倒计时', '距离'],
    fields: [
      { key: 'from', label: '开始日期', type: 'date', value: () => todayStr() },
      { key: 'to', label: '结束日期', type: 'date', value: () => todayStr() }
    ],
    compute(v) {
      const a = parseDate(v.from), b = parseDate(v.to);
      if (!a || !b) return [{ label: '提示', value: '请选择两个日期' }];
      const days = dayDiff(a, b);
      const abs = Math.abs(days);

      // 数工作日（不含周末），按小的日期往前推
      let work = 0;
      const s = days >= 0 ? new Date(a) : new Date(b);
      const e = days >= 0 ? new Date(b) : new Date(a);
      const cur = new Date(s);
      // 结束当天不算，开始当天算
      while (cur < e) {
        const w = cur.getDay();
        if (w !== 0 && w !== 6) work++;
        cur.setDate(cur.getDate() + 1);
      }

      const y = Math.floor(abs / 365);
      const mo = Math.floor((abs % 365) / 30);
      const d = abs % 30;

      return [
        { label: '相差天数', value: abs + ' 天', primary: true },
        { label: days >= 0 ? '结束日在开始日之后' : '结束日在开始日之前', value: '共 ' + abs + ' 天' },
        { label: '折算', value: (y ? y + ' 年 ' : '') + (mo ? mo + ' 个月 ' : '') + d + ' 天' },
        { label: '其中工作日', value: work + ' 天' },
        { label: '合计周数', value: Math.floor(abs / 7) + ' 周零 ' + (abs % 7) + ' 天' },
        { label: '合计小时', value: (abs * 24).toLocaleString('zh-CN') + ' 小时' }
      ];
    }
  });

  add({
    id: 'sleep',
    name: '睡眠时间',
    desc: '按 90 分钟周期算最佳入睡 / 起床',
    cat: '时间',
    icon: '<path d="M20.5 14.8A8.6 8.6 0 0 1 9.2 3.5a8.6 8.6 0 1 0 11.3 11.3z"/>',
    tags: ['睡眠', '睡觉', '起床', '作息', '周期', '熬夜'],
    fields: [
      { key: 'mode', label: '我想', type: 'select', value: 'wake', options: [
        { v: 'wake', t: '在某个时间起床' }, { v: 'now', t: '现在就睡' }
      ] },
      { key: 'time', label: '起床时间', type: 'time', value: '07:00', showIf: v => v.mode === 'wake' }
    ],
    compute(v) {
      const CYCLES = [6, 5, 4, 3, 2];
      const FALL = 15; // 平均入睡耗时
      const out = [];

      if (v.mode === 'now') {
        const base = new Date();
        out.push({ section: true, label: '如果现在立刻躺下', value: '' });
        CYCLES.forEach((c, i) => {
          const t = new Date(base.getTime() + (FALL + c * 90) * 60000);
          out.push({
            label: c + ' 个周期（' + (c * 1.5) + ' 小时）',
            value: String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ' 起床',
            primary: i === 1
          });
        });
      } else {
        const m = /^(\d{1,2}):(\d{2})$/.exec(v.time || '');
        if (!m) return [{ label: '提示', value: '请选择起床时间' }];
        const wake = new Date();
        wake.setHours(Number(m[1]), Number(m[2]), 0, 0);
        if (wake.getTime() < Date.now()) wake.setDate(wake.getDate() + 1);
        out.push({ section: true, label: '想 ' + v.time + ' 起床，应该在这些时间入睡', value: '' });
        CYCLES.forEach((c, i) => {
          const t = new Date(wake.getTime() - (FALL + c * 90) * 60000);
          out.push({
            label: c + ' 个周期（' + (c * 1.5) + ' 小时）',
            value: String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ' 入睡',
            primary: i === 1
          });
        });
      }
      out.push({ label: '说明', value: '已预留 15 分钟入睡时间' });
      return out;
    }
  });

  add({
    id: 'worldclock',
    name: '世界时钟',
    desc: '多城市当地时间对照',
    cat: '时间',
    icon: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.6 2.6 2.6 14.4 0 17-2.6-2.6-2.6-14.4 0-17z"/>',
    tags: ['时区', '时间', '世界', '城市', '国际', '会议', '出差'],
    custom: 'worldclock'
  });

  add({
    id: 'countdown',
    name: '倒数日',
    desc: '记重要日子，自动算天数',
    cat: '时间',
    icon: '<path d="M6 21V3.5"/><path d="M6 4.5h11.5l-2.6 4 2.6 4H6"/>',
    tags: ['倒数', '纪念日', '生日', '倒计时', '重要日子', '提醒'],
    custom: 'countdown'
  });

  /* ===== 文本类 ===== */

  add({
    id: 'text',
    name: '文本工具箱',
    desc: '字数统计 · 去重 · Base64 · 编码',
    cat: '文本',
    icon: '<path d="M6 3h9l4 4v14H6z"/><path d="M14.5 3v4.5H19"/><path d="M9 12.5h6M9 16h4"/>',
    tags: ['文本', '字数', '统计', '去重', 'base64', '编码', 'url', '大小写', '排序'],
    fields: [
      { key: 'text', label: '粘贴文本', type: 'textarea', value: '', placeholder: '把文本粘进来，下面实时统计', rows: 6 },
      { key: 'op', label: '附加处理', type: 'select', value: 'none', options: [
        { v: 'none', t: '不处理' },
        { v: 'dedup', t: '按行去重' },
        { v: 'trim', t: '去掉空行和首尾空格' },
        { v: 'sort', t: '按行排序' },
        { v: 'base64', t: '转 Base64' },
        { v: 'unbase64', t: 'Base64 解码' },
        { v: 'urlenc', t: 'URL 编码' },
        { v: 'urldec', t: 'URL 解码' },
        { v: 'upper', t: '转大写' },
        { v: 'lower', t: '转小写' }
      ] }
    ],
    compute(v) {
      const t = v.text || '';
      const noSpace = t.replace(/\s/g, '');
      const lines = t.length ? t.split(/\r?\n/) : [];
      const nonEmpty = lines.filter(l => l.trim() !== '');
      const words = t.trim() ? t.trim().split(/\s+/).length : 0;
      let bytes = 0;
      try { bytes = new TextEncoder().encode(t).length; } catch (_) { bytes = unescape(encodeURIComponent(t)).length; }

      const out = [
        { label: '字符数（含空格）', value: t.length.toLocaleString('zh-CN'), primary: true },
        { label: '字符数（不含空格）', value: noSpace.length.toLocaleString('zh-CN') },
        { label: '行数 / 非空行', value: lines.length + ' / ' + nonEmpty.length },
        { label: '按空格分词', value: words.toLocaleString('zh-CN') },
        { label: 'UTF-8 字节', value: bytes.toLocaleString('zh-CN') }
      ];

      let res = null;
      try {
        if (v.op === 'dedup') res = Array.from(new Set(lines)).join('\n');
        else if (v.op === 'trim') res = lines.map(l => l.trim()).filter(l => l !== '').join('\n');
        else if (v.op === 'sort') res = lines.slice().sort((a, b) => a.localeCompare(b, 'zh-CN')).join('\n');
        else if (v.op === 'base64') res = btoa(unescape(encodeURIComponent(t)));
        else if (v.op === 'unbase64') res = decodeURIComponent(escape(atob(t.trim())));
        else if (v.op === 'urlenc') res = encodeURIComponent(t);
        else if (v.op === 'urldec') res = decodeURIComponent(t);
        else if (v.op === 'upper') res = t.toUpperCase();
        else if (v.op === 'lower') res = t.toLowerCase();
      } catch (e) {
        res = '处理失败：' + e.message;
      }
      if (res !== null && res !== undefined) {
        out.push({ section: true, label: '处理结果', value: '' });
        out.push({ label: '结果', value: res.length > 400 ? res.slice(0, 400) + '…' : res, mono: true, copy: true });
      }
      return out;
    }
  });

  /* ===== 健康类 ===== */

  add({
    id: 'bmi',
    name: 'BMI 与热量',
    desc: '体重评估 · 基础代谢 · 每日建议',
    cat: '健康',
    icon: '<path d="M3 12h3.5l2-3.2 3 6.4 2-3.2H21"/>',
    tags: ['BMI', '体重', '身高', '健康', '基础代谢', '热量', '卡路里', '减肥', '增肌'],
    fields: [
      { key: 'height', label: '身高', type: 'number', value: 170, unit: 'cm', step: 'any' },
      { key: 'weight', label: '体重', type: 'number', value: 65, unit: 'kg', step: 'any' },
      { key: 'age', label: '年龄', type: 'number', value: 30, unit: '岁', step: 1 },
      { key: 'sex', label: '性别', type: 'select', value: 'm', options: [{ v: 'm', t: '男' }, { v: 'f', t: '女' }] }
    ],
    compute(v) {
      const H = n(v.height, 0) / 100;
      const W = n(v.weight, 0);
      const A = n(v.age, 0);
      if (H <= 0 || W <= 0) return [{ label: '提示', value: '请填写身高体重' }];

      const bmi = W / (H * H);
      let tag = '正常';
      if (bmi < 18.5) tag = '偏瘦';
      else if (bmi < 24) tag = '正常';
      else if (bmi < 28) tag = '超重';
      else tag = '肥胖';

      const lo = 18.5 * H * H, hi = 23.9 * H * H;
      const bmr = 10 * W + 6.25 * n(v.height, 0) - 5 * A + (v.sex === 'm' ? 5 : -161);

      return [
        { label: 'BMI', value: fmt(bmi) + '（' + tag + '）', primary: true },
        { label: '健康体重区间', value: fmt(lo) + ' ~ ' + fmt(hi) + ' kg' },
        { label: '距区间', value: W < lo ? '还差 ' + fmt(lo - W) + ' kg' : (W > hi ? '超出 ' + fmt(W - hi) + ' kg' : '在区间内') },
        { section: true, label: '热量估算（Mifflin-St Jeor）', value: '' },
        { label: '基础代谢 BMR', value: fmt(bmr) + ' 千卡/天' },
        { label: '几乎不动', value: fmt(bmr * 1.2) + ' 千卡' },
        { label: '轻度活动', value: fmt(bmr * 1.375) + ' 千卡' },
        { label: '中度活动', value: fmt(bmr * 1.55) + ' 千卡' },
        { label: '减脂参考', value: fmt(bmr * 1.375 - 400) + ' 千卡' }
      ];
    }
  });

  /* ===== 安全类 ===== */

  add({
    id: 'pwd',
    name: '密码生成',
    desc: '本地生成强密码，不联网',
    cat: '安全',
    icon: '<rect x="4" y="10" width="16" height="10.5" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v2.5"/>',
    tags: ['密码', '随机', '安全', '强密码', '生成'],
    fields: [
      { key: 'len', label: '长度', type: 'number', value: 16, step: 1 },
      { key: 'lower', label: '包含小写字母', type: 'checkbox', value: true },
      { key: 'upper', label: '包含大写字母', type: 'checkbox', value: true },
      { key: 'digit', label: '包含数字', type: 'checkbox', value: true },
      { key: 'symbol', label: '包含符号', type: 'checkbox', value: false },
      { key: 'exclude', label: '排除易混字符（0O1lI）', type: 'checkbox', value: true }
    ],
    actionLabel: '换一个',
    action(v) { v._seed = Math.random(); return v; },
    compute(v) {
      const L = Math.max(4, Math.min(128, Math.round(n(v.len, 16))));
      let pool = '';
      if (v.lower) pool += 'abcdefghijklmnopqrstuvwxyz';
      if (v.upper) pool += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      if (v.digit) pool += '0123456789';
      if (v.symbol) pool += '!@#$%^&*()-_=+[]{};:,.?/';
      if (v.exclude) pool = pool.replace(/[0O1lI]/g, '');
      if (!pool) return [{ label: '提示', value: '至少要选一类字符' }];

      const rnd = new Uint32Array(L);
      let ok = false;
      try {
        if (global.crypto && global.crypto.getRandomValues) { global.crypto.getRandomValues(rnd); ok = true; }
      } catch (_) {}
      let s = '';
      for (let i = 0; i < L; i++) {
        const r = ok ? rnd[i] : Math.floor(Math.random() * 4294967296);
        s += pool[r % pool.length];
      }

      const bits = L * Math.log2(pool.length);
      let level = '偏弱';
      if (bits >= 128) level = '极强';
      else if (bits >= 80) level = '很强';
      else if (bits >= 60) level = '较强';

      return [
        { label: '生成的密码', value: s, primary: true, mono: true, copy: true },
        { label: '强度', value: level + '（约 ' + Math.round(bits) + ' 位熵）' },
        { label: '字符池', value: pool.length + ' 种字符' },
        { label: '暴力破解', value: bits >= 100 ? '实际上不可行' : (bits >= 70 ? '极难' : '建议加长') }
      ];
    }
  });

  /* ===== 随机与决策 ===== */

  add({
    id: 'random',
    name: '随机决策器',
    desc: '抽签 · 随机分组 · 掷骰子',
    cat: '随机',
    icon: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><circle cx="9" cy="9" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    tags: ['随机', '抽签', '分组', '骰子', '决策', '抽奖', '选择'],
    custom: 'random'
  });

  /* ---------------- 导出 ---------------- */
  global.MYAPP_FEATURES = FEATURES;
  global.MYAPP_UTIL = { fmt, money, parseDate, fmtDate, dayDiff, todayStr, rmbUpper, LIN, TEMP };

})(typeof window !== 'undefined' ? window : globalThis);
