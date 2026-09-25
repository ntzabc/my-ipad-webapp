/* ============================================================
   app.js · 界面渲染与交互
   ============================================================ */

(function () {
  'use strict';

  const FEATURES = window.MYAPP_FEATURES || [];
  const U = window.MYAPP_UTIL;
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const byId = id => FEATURES.find(f => f.id === id);

  const LS = {
    fav: 'myapp.fav',
    ultra: 'myapp.ultra',
    anim: 'myapp.anim',
    cd: 'myapp.countdown'
  };
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

  const CAT_ORDER = ['计算', '时间', '文本', '健康', '安全', '随机'];

  /* ============================================================
     状态
     ============================================================ */
  const S = {
    screen: 'screen-home',
    fav: new Set(),
    values: {},
    feature: null,
    timers: []
  };

  try { S.fav = new Set(JSON.parse(lsGet(LS.fav, '[]'))); } catch (_) { S.fav = new Set(); }

  function saveFav() { lsSet(LS.fav, JSON.stringify(Array.from(S.fav))); }

  function iconSvg(inner, sw) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 1.8) +
           '" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }

  const ICON_SEARCH = '<circle cx="11" cy="11" r="6.5"/><path d="M16.2 16.2 20.5 20.5"/>';
  const ICON_STAR   = '<path d="M12 3.6l2.7 5.7 6.2.8-4.5 4.3 1.1 6.1-5.5-2.9-5.5 2.9 1.1-6.1L3.1 10.1l6.2-.8z"/>';
  const ICON_TRASH  = '<path d="M5 7h14M10 7V4.8h4V7M6.5 7l.8 12.2h9.4L17.5 7"/>';
  const ICON_PLUS   = '<path d="M12 5.5v13M5.5 12h13"/>';

  /* ============================================================
     搜索
     ============================================================ */
  function score(f, q) {
    if (!q) return 1;
    const name = f.name.toLowerCase();
    const desc = (f.desc || '').toLowerCase();
    const tags = (f.tags || []).join(' ').toLowerCase();
    const cat = (f.cat || '').toLowerCase();
    if (name === q) return 100;
    if (name.startsWith(q)) return 80;
    if (name.includes(q)) return 60;
    if (tags.split(/\s+/).some(t => t === q)) return 50;
    if (tags.includes(q)) return 35;
    if (cat.includes(q)) return 25;
    if (desc.includes(q)) return 20;
    return 0;
  }

  function searchList(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return null;
    return FEATURES
      .map(f => ({ f, s: score(f, q) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s || a.f.name.localeCompare(b.f.name, 'zh-CN'))
      .map(x => x.f);
  }

  /* ============================================================
     功能卡片
     ============================================================ */
  function makeCard(f) {
    const el = document.createElement('div');
    el.className = 'fcard';
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.dataset.id = f.id;

    const on = S.fav.has(f.id);
    el.innerHTML =
      '<div class="fcard__icon">' + iconSvg(f.icon) + '</div>' +
      '<div class="fcard__name">' + f.name + '</div>' +
      '<div class="fcard__desc">' + (f.desc || '') + '</div>' +
      '<button class="fcard__star' + (on ? ' is-on' : '') + '" type="button" aria-label="收藏">' +
        iconSvg(ICON_STAR, 1.6) +
      '</button>';

    el.addEventListener('click', e => {
      if (e.target.closest('.fcard__star')) return;
      openFeature(f.id);
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFeature(f.id); }
    });
    el.querySelector('.fcard__star').addEventListener('click', e => {
      e.stopPropagation();
      toggleFav(f.id);
    });
    return el;
  }

  function toggleFav(id) {
    if (S.fav.has(id)) S.fav.delete(id); else S.fav.add(id);
    saveFav();
    renderAll();
    syncSheetFav();
  }

  /* ============================================================
     列表渲染
     ============================================================ */
  function renderGrid(container, list, emptyHtml) {
    container.innerHTML = '';
    if (!list.length) {
      container.innerHTML = emptyHtml || '';
      return;
    }
    const groups = new Map();
    list.forEach(f => {
      const c = f.cat || '其他';
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(f);
    });
    const keys = Array.from(groups.keys()).sort((a, b) => {
      const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    keys.forEach(k => {
      const sec = document.createElement('section');
      sec.className = 'group';
      const h = document.createElement('h2');
      h.className = 'group__title';
      h.textContent = k;
      const grid = document.createElement('div');
      grid.className = 'fgrid';
      groups.get(k).forEach(f => grid.appendChild(makeCard(f)));
      sec.appendChild(h);
      sec.appendChild(grid);
      container.appendChild(sec);
    });
  }

  function renderAll() {
    const q = $('#search').value;
    const results = searchList(q);

    if (results) {
      renderGrid($('#featureList'), results,
        '<div class="empty">' + iconSvg(ICON_SEARCH, 1.6) +
        '<div class="empty__title">没找到「' + escapeHtml(q) + '」</div>' +
        '<div class="empty__desc">换个词试试，比如「房贷」「大写」「时区」「密码」</div></div>');
      $('#topbarCount').textContent = results.length + ' 个结果';
    } else {
      renderGrid($('#featureList'), FEATURES);
      $('#topbarCount').textContent = FEATURES.length + ' 个功能';
    }

    const favList = FEATURES.filter(f => S.fav.has(f.id));
    renderGrid($('#favList'), favList,
      '<div class="empty">' + iconSvg(ICON_STAR, 1.6) +
      '<div class="empty__title">还没有收藏</div>' +
      '<div class="empty__desc">点功能卡片右上角的星星，常用的就会出现在这里</div></div>');

    $('#statCount').textContent = FEATURES.length + ' 个';
    $('#statFav').textContent = S.fav.size + ' 个';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ============================================================
     标签页
     ============================================================ */
  const TITLE = { 'screen-home': '功能', 'screen-fav': '收藏', 'screen-settings': '设置' };

  function switchScreen(id, push) {
    const el = document.getElementById(id);
    if (!el) return;
    S.screen = id;
    $$('.screen').forEach(s => s.classList.toggle('is-active', s === el));
    $$('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.target === id));
    $('#topbarTitle').textContent = TITLE[id] || '功能';
    $('#topbarCount').style.display = id === 'screen-home' ? '' : 'none';
    $('#searchWrap').style.display = id === 'screen-home' ? '' : 'none';
    $('#screens').scrollTop = 0;
    $('#topbar').classList.remove('is-scrolled');
    if (push) history.pushState({ screen: id }, '', '#' + id);
  }

  $$('.tab').forEach(t => t.addEventListener('click', () => switchScreen(t.dataset.target, true)));

  /* ============================================================
     搜索交互
     ============================================================ */
  const searchEl = $('#search');
  let searchTimer = null;

  searchEl.addEventListener('input', () => {
    $('#searchClear').hidden = !searchEl.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const res = searchList(searchEl.value);
      if (res) {
        renderGrid($('#featureList'), res,
          '<div class="empty">' + iconSvg(ICON_SEARCH, 1.6) +
          '<div class="empty__title">没找到「' + escapeHtml(searchEl.value) + '」</div>' +
          '<div class="empty__desc">换个词试试，比如「房贷」「大写」「时区」「密码」</div></div>');
        $('#topbarCount').textContent = res.length + ' 个结果';
      } else {
        renderGrid($('#featureList'), FEATURES);
        $('#topbarCount').textContent = FEATURES.length + ' 个功能';
      }
    }, 90);
  });

  searchEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') { searchEl.value = ''; searchEl.dispatchEvent(new Event('input')); searchEl.blur(); }
  });

  $('#searchClear').addEventListener('click', () => {
    searchEl.value = '';
    searchEl.dispatchEvent(new Event('input'));
    searchEl.focus();
  });

  /* 滚动时标题栏收缩 */
  $('#screens').addEventListener('scroll', () => {
    $('#topbar').classList.toggle('is-scrolled', $('#screens').scrollTop > 10);
  }, { passive: true });

  /* ============================================================
     详情面板
     ============================================================ */
  const sheet = $('#sheet');
  const sheetBody = $('#sheetBody');

  function openSheet() {
    sheet.hidden = false;
    document.body.classList.add('is-locked');
    setTimeout(() => sheet.classList.add('is-open'), 16);
  }

  function closeSheet(pop) {
    if (sheet.hidden) return;
    sheet.classList.remove('is-open');
    document.body.classList.remove('is-locked');
    stopTimers();
    setTimeout(() => { sheet.hidden = true; }, 380);
    if (pop && location.hash.indexOf('#f/') === 0) history.back();
  }

  $('#sheetClose').addEventListener('click', () => closeSheet(true));
  $('#sheetScrim').addEventListener('click', () => closeSheet(true));

  /* 下拉关闭 */
  (function dragClose() {
    const handle = $('#sheetGrabber');
    const panel = $('#sheetPanel');
    let y0 = null;
    handle.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; }, { passive: true });
    handle.addEventListener('touchmove', e => {
      if (y0 === null) return;
      const dy = Math.max(0, e.touches[0].clientY - y0);
      panel.style.transition = 'none';
      panel.style.transform = 'translate(-50%, ' + dy + 'px)';
    }, { passive: true });
    handle.addEventListener('touchend', e => {
      const dy = Math.max(0, (e.changedTouches[0] || {}).clientY - y0);
      panel.style.transition = '';
      panel.style.transform = '';
      y0 = null;
      if (dy > 110) closeSheet(true);
    });
  })();

  $('#sheetFav').addEventListener('click', () => { if (S.feature) toggleFav(S.feature); });

  function syncSheetFav() {
    if (!S.feature) return;
    $('#sheetFav').classList.toggle('is-on', S.fav.has(S.feature));
  }

  function stopTimers() {
    S.timers.forEach(t => { clearInterval(t); clearTimeout(t); });
    S.timers = [];
  }

  /* ============================================================
     打开某个功能
     ============================================================ */
  function openFeature(id, push) {
    const f = byId(id);
    if (!f) return;

    stopTimers();
    S.feature = id;
    S.values = {};
    (f.fields || []).forEach(fl => {
      S.values[fl.key] = typeof fl.value === 'function' ? fl.value() : fl.value;
    });

    $('#sheetTitle').textContent = f.name;
    $('#sheetDesc').textContent = f.desc || '';
    $('#sheetIcon').innerHTML = iconSvg(f.icon);
    syncSheetFav();

    sheetBody.innerHTML = '';
    sheetBody.scrollTop = 0;

    if (f.custom) {
      renderCustom(f, sheetBody);
    } else {
      renderForm(f, sheetBody);
    }

    openSheet();
    if (push !== false) history.pushState({ screen: S.screen, feature: id }, '', '#f/' + id);
  }

  /* ============================================================
     通用表单渲染（由字段声明驱动）
     ============================================================ */
  function renderForm(f, root) {
    const formWrap = document.createElement('div');
    const resWrap = document.createElement('div');
    formWrap.className = 'form';
    resWrap.className = 'result';
    root.appendChild(formWrap);
    root.appendChild(resWrap);

    let textTimer = null;

    function visibleFields() {
      return f.fields.filter(fl => !fl.showIf || fl.showIf(S.values));
    }

    function build() {
      formWrap.innerHTML = '';
      visibleFields().forEach(fl => formWrap.appendChild(buildField(f, fl, rebuild, () => {
        clearTimeout(textTimer);
        textTimer = setTimeout(recompute, 260);
      }, recompute)));
    }

    function recompute() {
      let rows;
      try {
        rows = f.compute(S.values);
      } catch (err) {
        rows = [{ label: '计算出错', value: String(err && err.message || err) }];
      }
      renderRows(resWrap, rows || []);
    }

    function rebuild() { build(); recompute(); }

    build();
    recompute();

    if (f.actionLabel && f.action) {
      const row = document.createElement('div');
      row.className = 'tools-row';
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = f.actionLabel;
      b.addEventListener('click', () => { S.values = f.action(S.values); recompute(); });
      row.appendChild(b);
      root.insertBefore(row, resWrap);
    }
  }

  function buildField(f, fl, rebuild, onText, onChange) {
    const wrap = document.createElement('div');

    if (fl.type === 'textarea') {
      wrap.className = 'field field--stack';
      const lab = document.createElement('div');
      lab.className = 'field__label';
      lab.textContent = fl.label;
      const ta = document.createElement('textarea');
      ta.rows = fl.rows || 5;
      ta.placeholder = fl.placeholder || '';
      ta.value = S.values[fl.key] == null ? '' : S.values[fl.key];
      ta.addEventListener('input', () => { S.values[fl.key] = ta.value; onText(); });
      wrap.appendChild(lab);
      wrap.appendChild(ta);
      return wrap;
    }

    if (fl.type === 'checkbox') {
      wrap.className = 'field';
      const lab = document.createElement('div');
      lab.className = 'field__label';
      lab.textContent = fl.label;
      const tg = document.createElement('label');
      tg.className = 'toggle';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!S.values[fl.key];
      const dot = document.createElement('span');
      dot.className = 'toggle__dot';
      tg.appendChild(cb);
      tg.appendChild(dot);
      cb.addEventListener('change', () => { S.values[fl.key] = cb.checked; onChange(); });
      wrap.appendChild(lab);
      wrap.appendChild(tg);
      return wrap;
    }

    wrap.className = 'field';
    const lab = document.createElement('div');
    lab.className = 'field__label';
    lab.textContent = fl.label;
    if (fl.hint) {
      const h = document.createElement('small');
      h.className = 'field__hint';
      h.textContent = fl.hint;
      lab.appendChild(h);
    }

    const box = document.createElement('div');
    box.className = 'field__box' + (fl.type === 'select' ? ' field__box--sel' : '');

    let input;
    if (fl.type === 'select') {
      input = document.createElement('select');
      if (fl.optgroups) {
        fl.optgroups().forEach(g => {
          const og = document.createElement('optgroup');
          og.label = g.label;
          g.options.forEach(o => {
            const op = document.createElement('option');
            op.value = o.v; op.textContent = o.t;
            og.appendChild(op);
          });
          input.appendChild(og);
        });
      } else {
        (fl.options || []).forEach(o => {
          const op = document.createElement('option');
          op.value = o.v; op.textContent = o.t;
          input.appendChild(op);
        });
      }
      input.value = S.values[fl.key];
      input.addEventListener('change', () => { S.values[fl.key] = input.value; rebuild(); });
    } else {
      input = document.createElement('input');
      input.type = fl.type === 'date' ? 'date'
                 : fl.type === 'time' ? 'time'
                 : fl.type === 'number' ? 'number' : 'text';
      if (fl.type === 'number') { input.step = fl.step || 'any'; input.inputMode = 'decimal'; }
      input.value = S.values[fl.key] == null ? '' : S.values[fl.key];
      const handler = () => {
        S.values[fl.key] = fl.type === 'number'
          ? (input.value === '' ? '' : Number(input.value))
          : input.value;
        // 只有下拉框才重建表单（它可能控制其它字段的显隐）；
        // 日期/时间/数字重建会打断正在用的选择器，所以只重算结果。
        if (fl.type === 'select' && visibleFieldsChanged(f)) rebuild(); else onChange();
      };
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    }

    box.appendChild(input);
    if (fl.unit) {
      const u = document.createElement('span');
      u.className = 'field__unit';
      u.textContent = fl.unit;
      box.appendChild(u);
    }
    wrap.appendChild(lab);
    wrap.appendChild(box);
    return wrap;
  }

  // 字段的显示/隐藏是否依赖当前值（比如"起床时间"只在某个模式下显示）
  function visibleFieldsChanged(f) {
    return (f.fields || []).some(fl => typeof fl.showIf === 'function');
  }

  /* ============================================================
     结果渲染
     ============================================================ */
  function renderRows(container, rows) {
    container.innerHTML = '';
    rows.forEach(r => {
      const el = document.createElement('div');
      let cls = 'res';
      if (r.primary) cls += ' res--primary';
      if (r.section) cls += ' res--section';
      if (r.mono) cls += ' res--mono';
      if (r.copy) cls += ' res--copy';
      el.className = cls;

      const l = document.createElement('div');
      l.className = 'res__label';
      l.textContent = r.label;

      const v = document.createElement('div');
      v.className = 'res__value';
      v.textContent = r.value;

      if (r.copy && r.value) {
        v.title = '点一下复制';
        v.addEventListener('click', () => copyText(String(r.value)));
      }

      el.appendChild(l);
      el.appendChild(v);
      container.appendChild(el);
    });
  }

  function copyText(t) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t);
      } else {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      toast('已复制');
    } catch (_) { toast('复制失败，手动选中吧'); }
  }

  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText =
        'position:fixed;left:50%;bottom:calc(var(--tabbar-h) + var(--safe-bottom) + 24px);' +
        'transform:translate(-50%,16px);padding:10px 18px;border-radius:14px;' +
        'background:rgba(20,32,58,.92);border:.5px solid rgba(255,255,255,.16);' +
        'color:#EAF1FF;font-size:14px;z-index:99;opacity:0;pointer-events:none;' +
        'transition:opacity .2s ease,transform .2s ease;' +
        '-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(() => {
      toastEl.style.opacity = '1';
      toastEl.style.transform = 'translate(-50%,0)';
    });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.style.opacity = '0';
      toastEl.style.transform = 'translate(-50%,16px)';
    }, 1400);
  }

  /* ============================================================
     自定义功能 1：世界时钟
     ============================================================ */
  const CITIES = [
    ['北京', 'Asia/Shanghai'], ['东京', 'Asia/Tokyo'], ['首尔', 'Asia/Seoul'],
    ['新加坡', 'Asia/Singapore'], ['迪拜', 'Asia/Dubai'], ['莫斯科', 'Europe/Moscow'],
    ['伦敦', 'Europe/London'], ['巴黎', 'Europe/Paris'], ['纽约', 'America/New_York'],
    ['洛杉矶', 'America/Los_Angeles'], ['圣保罗', 'America/Sao_Paulo'], ['悉尼', 'Australia/Sydney']
  ];

  function tzInfo(tz, d) {
    let p = {};
    try {
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).formatToParts(d).forEach(x => { if (x.type !== 'literal') p[x.type] = x.value; });
    } catch (_) { return null; }
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    const localUTC = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
    return {
      hh: p.hour.padStart(2, '0'),
      mm: p.minute.padStart(2, '0'),
      ss: p.second.padStart(2, '0'),
      offsetMin: Math.round((asUTC - localUTC) / 60000),
      ymd: p.year + '-' + p.month + '-' + p.day
    };
  }

  function offsetLabel(min) {
    if (min === 0) return '同本地';
    const h = Math.round(Math.abs(min) / 6) / 10;   // 保留一位小数的小时数
    return (min > 0 ? '+' : '−') + h + 'h';
  }

  function renderCustom(f, root) {
    if (f.custom === 'worldclock') return renderWorldClock(f, root);
    if (f.custom === 'countdown') return renderCountdown(f, root);
    if (f.custom === 'random') return renderRandom(f, root);
  }

  function renderWorldClock(f, root) {
    const box = document.createElement('div');
    box.className = 'result';
    root.innerHTML = '';
    root.appendChild(box);

    // 第一行固定是本地
    const localRow = document.createElement('div');
    localRow.className = 'res res--primary';
    localRow.innerHTML = '<div class="res__label">本地时间</div><div class="res__value" id="wcLocal">--:--:--</div>';
    box.appendChild(localRow);

    const rows = CITIES.map(([name, tz]) => {
      const el = document.createElement('div');
      el.className = 'res';
      el.innerHTML = '<div class="res__label">' + name + '</div>' +
                     '<div class="res__value">' +
                       '<span data-t="' + tz + '">--:--</span>' +
                       '<span style="color:var(--text-3);font-size:12px" data-o="' + tz + '"></span>' +
                     '</div>';
      box.appendChild(el);
      return el;
    });

    const note = document.createElement('div');
    note.className = 'footnote';
    note.style.marginTop = '14px';
    note.textContent = '时间以你 iPad 的系统时区为基准换算，标注的是与你的时差。';
    root.appendChild(note);

    function upd() {
      const d = new Date();
      const p = x => String(x).padStart(2, '0');
      $('#wcLocal').textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      rows.forEach(el => {
        const t = el.querySelector('[data-t]');
        const o = el.querySelector('[data-o]');
        const info = tzInfo(t.dataset.t, d);
        if (!info) { t.textContent = '—'; o.textContent = ''; return; }
        t.textContent = info.hh + ':' + info.mm;
        o.textContent = '  ' + offsetLabel(info.offsetMin);
      });
    }
    upd();
    S.timers.push(setInterval(upd, 1000));
  }

  /* ============================================================
     自定义功能 2：倒数日
     ============================================================ */
  function loadCd() {
    try { return JSON.parse(lsGet(LS.cd, '[]')) || []; } catch (_) { return []; }
  }
  function saveCd(list) { lsSet(LS.cd, JSON.stringify(list)); }

  function renderCountdown(f, root) {
    root.innerHTML = '';

    const addCard = document.createElement('div');
    addCard.className = 'result';
    addCard.style.padding = '12px 14px';
    addCard.innerHTML =
      '<div class="field" style="border-top:none">' +
        '<div class="field__box" style="flex:1">' +
          '<input id="cdName" type="text" placeholder="事件名称" style="text-align:left">' +
        '</div>' +
        '<div class="field__box" style="min-width:148px">' +
          '<input id="cdDate" type="date">' +
        '</div>' +
      '</div>';
    root.appendChild(addCard);

    const btnRow = document.createElement('div');
    btnRow.className = 'tools-row';
    const addBtn = document.createElement('button');
    addBtn.className = 'chip chip--on';
    addBtn.type = 'button';
    addBtn.textContent = '添加';
    addBtn.addEventListener('click', () => {
      const name = ($('#cdName').value || '').trim();
      const date = $('#cdDate').value;
      if (!date) { toast('先选个日期'); return; }
      const list = loadCd();
      list.push({ id: String(Date.now()), name: name || '未命名', date });
      saveCd(list);
      $('#cdName').value = '';
      renderList();
      toast('已添加');
    });
    btnRow.appendChild(addBtn);
    root.appendChild(btnRow);

    const listBox = document.createElement('div');
    listBox.className = 'result';
    listBox.style.marginTop = '14px';
    root.appendChild(listBox);

    const today = new Date();
    const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    function renderList() {
      const list = loadCd();
      listBox.innerHTML = '';
      if (!list.length) {
        listBox.innerHTML = '<div class="res"><div class="res__label">还没有记录</div>' +
          '<div class="res__value" style="color:var(--text-3);font-size:13px">上面加一个试试</div></div>';
        return;
      }
      list.map(it => {
        const d = U.parseDate(it.date) || new Date(it.date);
        const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t0) / 86400000);
        return { it, d, diff };
      }).sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff)).forEach(({ it, d, diff }) => {
        const row = document.createElement('div');
        row.className = 'cd-row';
        const isPast = diff < 0;
        row.innerHTML =
          '<div class="cd-row__main">' +
            '<div class="cd-row__name">' + escapeHtml(it.name) + '</div>' +
            '<div class="cd-row__date">' + d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() +
              '日 · 星期' + ['日', '一', '二', '三', '四', '五', '六'][d.getDay()] + '</div>' +
          '</div>' +
          '<div class="cd-row__days">' +
            '<div class="cd-row__num">' + Math.abs(diff) + '</div>' +
            '<div class="cd-row__sub">' + (diff === 0 ? '就是今天' : (isPast ? '天前' : '天后')) + '</div>' +
          '</div>' +
          '<button class="cd-row__del" type="button" aria-label="删除">' + iconSvg(ICON_TRASH, 1.7) + '</button>';
        row.querySelector('.cd-row__del').addEventListener('click', () => {
          saveCd(loadCd().filter(x => x.id !== it.id));
          renderList();
        });
        listBox.appendChild(row);
      });
    }

    const hint = document.createElement('p');
    hint.className = 'footnote';
    hint.style.marginTop = '14px';
    hint.textContent = '记录存在这台 iPad 的浏览器里，不会上传。清空浏览器数据会丢。';
    root.appendChild(hint);

    renderList();
  }

  /* ============================================================
     自定义功能 3：随机决策器
     ============================================================ */
  function renderRandom(f, root) {
    root.innerHTML = '';
    let mode = 'pick';

    const chipRow = document.createElement('div');
    chipRow.className = 'tools-row';
    chipRow.style.marginTop = '0';
    const modes = [['pick', '抽签'], ['group', '随机分组'], ['dice', '掷骰子']];
    const chips = modes.map(([k, t]) => {
      const b = document.createElement('button');
      b.className = 'chip' + (k === mode ? ' chip--on' : '');
      b.type = 'button';
      b.textContent = t;
      b.addEventListener('click', () => {
        mode = k;
        chips.forEach((c, i) => c.classList.toggle('chip--on', modes[i][0] === k));
        renderBody();
      });
      chipRow.appendChild(b);
      return b;
    });
    root.appendChild(chipRow);

    const body = document.createElement('div');
    root.appendChild(body);

    function renderBody() {
      body.innerHTML = '';
      if (mode === 'pick') body.appendChild(buildPick());
      else if (mode === 'group') body.appendChild(buildGroup());
      else body.appendChild(buildDice());
    }

    const inputBox = txt => {
      const ta = document.createElement('textarea');
      ta.rows = 5;
      ta.placeholder = txt;
      ta.value = '';
      return ta;
    };

    function buildPick() {
      const wrap = document.createElement('div');
      const ta = inputBox('每行一个选项，或用逗号分隔\n比如：火锅\n烧烤\n寿司');
      wrap.appendChild(ta);

      const out = document.createElement('div');
      out.className = 'pick-result';
      out.textContent = '等你点一下';
      wrap.appendChild(out);

      const row = document.createElement('div');
      row.className = 'tools-row';
      const btn = document.createElement('button');
      btn.className = 'chip chip--on';
      btn.type = 'button';
      btn.textContent = '抽一个';
      btn.addEventListener('click', () => {
        const items = ta.value.split(/[\n,，、|]/).map(s => s.trim()).filter(Boolean);
        if (!items.length) { out.classList.remove('is-rolling'); out.textContent = '先写几个选项'; return; }
        let i = 0;
        out.classList.add('is-rolling');
        const iv = setInterval(() => {
          out.textContent = items[Math.floor(Math.random() * items.length)];
          if (++i > 9) {
            clearInterval(iv);
            out.classList.remove('is-rolling');
            out.textContent = items[Math.floor(Math.random() * items.length)];
          }
        }, 70);
        S.timers.push(iv);
      });
      row.appendChild(btn);
      wrap.appendChild(row);
      return wrap;
    }

    function buildGroup() {
      const wrap = document.createElement('div');
      const ta = inputBox('每行一个名字');
      wrap.appendChild(ta);

      const ctrl = document.createElement('div');
      ctrl.className = 'field';
      ctrl.innerHTML = '<div class="field__label">分成几组</div>' +
        '<div class="field__box" style="max-width:96px"><input id="grpN" type="number" value="2" min="2" max="12" step="1"></div>';
      wrap.appendChild(ctrl);

      const out = document.createElement('div');
      out.className = 'result';
      out.style.marginTop = '14px';
      wrap.appendChild(out);

      const row = document.createElement('div');
      row.className = 'tools-row';
      const btn = document.createElement('button');
      btn.className = 'chip chip--on';
      btn.type = 'button';
      btn.textContent = '随机分组';
      btn.addEventListener('click', () => {
        const names = ta.value.split(/[\n,，、|]/).map(s => s.trim()).filter(Boolean);
        const k = Math.max(2, Math.min(12, Math.round(Number($('#grpN').value) || 2)));
        if (names.length < 2) { out.innerHTML = '<div class="res"><div class="res__label">至少写两个名字</div><div class="res__value"></div></div>'; return; }

        // Fisher-Yates 洗牌
        for (let i = names.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [names[i], names[j]] = [names[j], names[i]];
        }
        const groups = Array.from({ length: k }, () => []);
        names.forEach((nm, i) => groups[i % k].push(nm));

        out.innerHTML = '';
        groups.forEach((g, i) => {
          const t = document.createElement('div');
          t.className = 'grp-title';
          t.textContent = '第 ' + (i + 1) + ' 组 · ' + g.length + ' 人';
          const m = document.createElement('div');
          m.className = 'grp-members';
          g.forEach(nm => {
            const b = document.createElement('span');
            b.className = 'mini-badge';
            b.textContent = nm;
            m.appendChild(b);
          });
          out.appendChild(t);
          out.appendChild(m);
        });
      });
      row.appendChild(btn);
      wrap.appendChild(row);
      return wrap;
    }

    function buildDice() {
      const wrap = document.createElement('div');
      const ctrl = document.createElement('div');
      ctrl.style.cssText = 'display:flex;gap:10px';
      ctrl.innerHTML =
        '<div class="field" style="flex:1;border-top:none;padding-top:0">' +
          '<div class="field__label">几个骰子</div>' +
          '<div class="field__box" style="max-width:88px"><input id="dzN" type="number" value="2" min="1" max="12" step="1"></div>' +
        '</div>' +
        '<div class="field" style="flex:1;border-top:none;padding-top:0">' +
          '<div class="field__label">几面</div>' +
          '<div class="field__box" style="max-width:88px"><input id="dzS" type="number" value="6" min="2" max="100" step="1"></div>' +
        '</div>';
      wrap.appendChild(ctrl);

      const out = document.createElement('div');
      out.className = 'result';
      out.style.marginTop = '12px';
      wrap.appendChild(out);

      const row = document.createElement('div');
      row.className = 'tools-row';
      const btn = document.createElement('button');
      btn.className = 'chip chip--on';
      btn.type = 'button';
      btn.textContent = '掷';
      btn.addEventListener('click', () => {
        const n = Math.max(1, Math.min(12, Math.round(Number($('#dzN').value) || 1)));
        const s = Math.max(2, Math.min(100, Math.round(Number($('#dzS').value) || 6)));
        const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * s));
        const sum = rolls.reduce((a, b) => a + b, 0);
        out.innerHTML = '';
        out.appendChild(mkRes('点数', rolls.join('  +  '), true));
        out.appendChild(mkRes('合计', String(sum)));
        out.appendChild(mkRes('单次范围', '1 ~ ' + s + ' 点'));
      });
      row.appendChild(btn);
      wrap.appendChild(row);
      return wrap;
    }

    function mkRes(label, value, primary) {
      const el = document.createElement('div');
      el.className = 'res' + (primary ? ' res--primary' : '');
      el.innerHTML = '<div class="res__label"></div><div class="res__value"></div>';
      el.querySelector('.res__label').textContent = label;
      el.querySelector('.res__value').textContent = value;
      return el;
    }

    renderBody();
  }

  /* ============================================================
     设置
     ============================================================ */
  function applyPrefs() {
    const ultra = lsGet(LS.ultra, '0') === '1';
    const anim = lsGet(LS.anim, '1') === '1';
    document.body.classList.toggle('ultra', ultra);
    document.body.classList.toggle('no-anim', !anim);
    $('#ultraGlass').checked = ultra;
    $('#auroraAnim').checked = anim;
  }

  $('#ultraGlass').addEventListener('change', e => {
    lsSet(LS.ultra, e.target.checked ? '1' : '0');
    document.body.classList.toggle('ultra', e.target.checked);
    toast(e.target.checked ? '已开极致玻璃' : '已恢复流畅模式');
  });

  $('#auroraAnim').addEventListener('change', e => {
    lsSet(LS.anim, e.target.checked ? '1' : '0');
    document.body.classList.toggle('no-anim', !e.target.checked);
  });

  $('#btnClearFav').addEventListener('click', () => {
    S.fav.clear();
    saveFav();
    renderAll();
    syncSheetFav();
    toast('收藏已清空');
  });

  /* ============================================================
     运行模式 / 离线缓存
     ============================================================ */
  const standalone = window.navigator.standalone === true ||
                     window.matchMedia('(display-mode: standalone)').matches;
  $('#appMode').textContent = standalone ? '独立 App 模式' : '浏览器模式（加到主屏幕更好）';

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .then(() => { $('#swStatus').textContent = '已启用'; })
        .catch(() => { $('#swStatus').textContent = '未启用'; });
    });
  } else {
    $('#swStatus').textContent = '不适用';
  }

  /* 全局手势 */
  document.addEventListener('gesturestart', e => e.preventDefault());

  /* ============================================================
     启动
     ============================================================ */
  window.addEventListener('popstate', e => {
    const st = e.state || {};
    if (!sheet.hidden) {
      closeSheet(false);
      if (st.screen && st.screen !== S.screen) switchScreen(st.screen, false);
      return;
    }
    if (st.screen) switchScreen(st.screen, false);
  });

  applyPrefs();
  renderAll();

  (function boot() {
    const h = location.hash || '';
    if (h.indexOf('#f/') === 0) {
      const id = h.slice(3);
      switchScreen('screen-home', false);
      history.replaceState({ screen: 'screen-home' }, '', '#screen-home');
      if (byId(id)) openFeature(id, true);
    } else if (TITLE[h.slice(1)]) {
      switchScreen(h.slice(1), false);
      history.replaceState({ screen: h.slice(1) }, '', h);
    } else {
      history.replaceState({ screen: 'screen-home' }, '', '#screen-home');
    }
  })();

})();
