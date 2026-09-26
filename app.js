/* ============================================================
   app.js · 外壳
   标签页 / 搜索 / 详情面板 / 偏好设置 / 粒子背景接线
   ============================================================ */

(function () {
  'use strict';

  const FEATURES = window.FEATURES || [];
  const AI = window.AI;
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const byId = id => FEATURES.find(f => f.id === id);

  const LS = { glass: 'myapp.glass', parts: 'myapp.parts', anim: 'myapp.anim', fav: 'myapp.fav' };
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

  const CAT_ORDER = ['神经网络', 'AI 进化', 'AI 对战', 'AI 算法', '摄像头', '声音'];

  const S = {
    screen: 'screen-home',
    fav: new Set(),
    feature: null,
    cleanup: null
  };
  try { S.fav = new Set(JSON.parse(get(LS.fav, '[]'))); } catch (_) { S.fav = new Set(); }
  const saveFav = () => set(LS.fav, JSON.stringify(Array.from(S.fav)));

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function iconSvg(inner, sw) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 1.75) +
           '" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  const ICON_SEARCH = '<circle cx="11" cy="11" r="6.5"/><path d="M16.2 16.2 20.5 20.5"/>';
  const ICON_STAR   = '<path d="M12 3.6l2.7 5.7 6.2.8-4.5 4.3 1.1 6.1-5.5-2.9-5.5 2.9 1.1-6.1L3.1 10.1l6.2-.8z"/>';

  /* ============================================================
     给功能用的工具箱
     ============================================================ */
  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(() => toastEl.classList.add('is-on'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 1500);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function stat(parent, label, value) {
    const w = el('div', 'stat');
    const v = el('div', 'stat__v', value);
    const k = el('div', 'stat__k', label);
    w.appendChild(v); w.appendChild(k);
    parent.appendChild(w);
    return v;
  }

  /* 自适应画布：按包裹层宽度定尺寸，处理 DPR 与旋转 */
  function makeCanvas(parent, aspect) {
    const wrap = el('div', 'cvwrap');
    const cv = document.createElement('canvas');
    wrap.appendChild(cv);
    parent.appendChild(wrap);

    const ctx = cv.getContext('2d');
    const st = { cv: cv, ctx: ctx, w: 0, h: 0, dpr: 1, listeners: [] };

    function resize() {
      const w = wrap.clientWidth;
      if (!w) return;
      const h = aspect ? Math.round(w * aspect) : wrap.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (st.w === w && st.h === h && st.dpr === dpr) return;
      st.w = w; st.h = h; st.dpr = dpr;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = '100%';
      cv.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      st.listeners.forEach(f => { try { f(); } catch (_) {} });
    }

    if (window.ResizeObserver) new ResizeObserver(resize).observe(wrap);
    window.addEventListener('resize', resize, { passive: true });
    setTimeout(resize, 0);
    setTimeout(resize, 320);
    st.resize = resize;
    st.onResize = f => st.listeners.push(f);
    st.onSize = f => st.listeners.push(f);
    return st;
  }

  const kit = { AI: AI, el: el, stat: stat, makeCanvas: makeCanvas, toast: toast, escapeHtml: escapeHtml };

  /* ============================================================
     搜索
     ============================================================ */
  function score(f, q) {
    const name = f.name.toLowerCase();
    const desc = (f.desc || '').toLowerCase();
    const tags = (f.tags || []).join(' ').toLowerCase();
    const cat = (f.cat || '').toLowerCase();
    if (name === q) return 100;
    if (name.startsWith(q)) return 80;
    if (name.includes(q)) return 62;
    if (tags.split(/\s+/).some(t => t === q)) return 52;
    if (tags.includes(q)) return 36;
    if (cat.includes(q)) return 26;
    if (desc.includes(q)) return 20;
    return 0;
  }
  function searchList(raw) {
    const q = (raw || '').trim().toLowerCase();
    if (!q) return null;
    return FEATURES.map(f => ({ f: f, s: score(f, q) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s || a.f.name.localeCompare(b.f.name, 'zh-CN'))
      .map(x => x.f);
  }

  /* ============================================================
     卡片
     ============================================================ */
  function makeCard(f) {
    const e = el('div', 'fcard');
    e.setAttribute('role', 'button');
    e.setAttribute('tabindex', '0');
    const on = S.fav.has(f.id);
    e.innerHTML =
      '<div class="fcard__glow"></div>' +
      '<div class="fcard__icon">' + iconSvg(f.icon) + '</div>' +
      '<div class="fcard__name">' + f.name + '</div>' +
      '<div class="fcard__desc">' + (f.desc || '') + '</div>' +
      '<button class="fcard__star' + (on ? ' is-on' : '') + '" type="button" aria-label="收藏">' +
        iconSvg(ICON_STAR, 1.6) + '</button>';

    e.addEventListener('click', ev => {
      if (ev.target.closest('.fcard__star')) return;
      openFeature(f.id);
    });
    e.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openFeature(f.id); }
    });
    e.querySelector('.fcard__star').addEventListener('click', ev => {
      ev.stopPropagation();
      toggleFav(f.id);
    });
    return e;
  }

  function toggleFav(id) {
    if (S.fav.has(id)) S.fav.delete(id); else S.fav.add(id);
    saveFav(); renderAll(); syncSheetFav();
  }

  function renderGrid(container, list, emptyHtml) {
    container.innerHTML = '';
    if (!list.length) { container.innerHTML = emptyHtml || ''; return; }
    const groups = new Map();
    list.forEach(f => {
      const c = f.cat || '其他';
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(f);
    });
    Array.from(groups.keys())
      .sort((a, b) => {
        const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      })
      .forEach(k => {
        const sec = el('section', 'group');
        sec.appendChild(el('h2', 'group__title', k));
        const grid = el('div', 'fgrid');
        groups.get(k).forEach(f => grid.appendChild(makeCard(f)));
        sec.appendChild(grid);
        container.appendChild(sec);
      });
  }

  const EMPTY_SEARCH = q =>
    '<div class="empty">' + iconSvg(ICON_SEARCH, 1.6) +
    '<div class="empty__title">没找到「' + escapeHtml(q) + '」</div>' +
    '<div class="empty__desc">换个词试试：「神经网络」「棋」「猜拳」「寻路」</div></div>';

  function renderAll() {
    const q = $('#search').value;
    const res = searchList(q);
    if (res) {
      renderGrid($('#featureList'), res, EMPTY_SEARCH(q));
      $('#topbarCount').textContent = res.length + ' 个结果';
    } else {
      renderGrid($('#featureList'), FEATURES);
      $('#topbarCount').textContent = FEATURES.length + ' 个玩法';
    }
    renderGrid($('#favList'), FEATURES.filter(f => S.fav.has(f.id)),
      '<div class="empty">' + iconSvg(ICON_STAR, 1.6) +
      '<div class="empty__title">还没有收藏</div>' +
      '<div class="empty__desc">点卡片右上角的星星，常玩的会出现在这里</div></div>');
    $('#statCount').textContent = FEATURES.length + ' 个';
    $('#statFav').textContent = S.fav.size + ' 个';
  }

  /* ============================================================
     标签页
     ============================================================ */
  const TITLE = { 'screen-home': 'AI 玩法', 'screen-fav': '收藏', 'screen-settings': '设置' };

  function switchScreen(id, push) {
    const e = document.getElementById(id);
    if (!e) return;
    S.screen = id;
    $$('.screen').forEach(s => s.classList.toggle('is-active', s === e));
    $$('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.target === id));
    $('#topbarTitle').textContent = TITLE[id] || 'AI 玩法';
    const home = id === 'screen-home';
    $('#topbarCount').style.display = home ? '' : 'none';
    $('#searchWrap').style.display = home ? '' : 'none';
    $('#screens').scrollTop = 0;
    $('#topbar').classList.remove('is-scrolled');
    if (push) history.pushState({ screen: id }, '', '#' + id);
  }

  $$('.tab').forEach(t => t.addEventListener('click', () => switchScreen(t.dataset.target, true)));

  /* ============================================================
     搜索交互
     ============================================================ */
  const searchEl = $('#search');
  let sTimer = null;
  searchEl.addEventListener('input', () => {
    $('#searchClear').hidden = !searchEl.value;
    clearTimeout(sTimer);
    sTimer = setTimeout(renderAll, 80);
  });
  searchEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') { searchEl.value = ''; renderAll(); searchEl.blur(); }
  });
  $('#searchClear').addEventListener('click', () => {
    searchEl.value = ''; renderAll(); searchEl.focus();
  });
  $('#screens').addEventListener('scroll', () => {
    $('#topbar').classList.toggle('is-scrolled', $('#screens').scrollTop > 10);
  }, { passive: true });

  /* ============================================================
     详情面板
     ============================================================ */
  const sheet = $('#sheet');

  function openSheet() {
    sheet.hidden = false;
    document.body.classList.add('is-locked');
    if (field) field.setLowPower(true);
    setTimeout(() => sheet.classList.add('is-open'), 16);
  }

  function closeSheet(pop) {
    if (sheet.hidden) return;
    sheet.classList.remove('is-open');
    document.body.classList.remove('is-locked');
    if (field) field.setLowPower(false);
    if (S.cleanup) { try { S.cleanup(); } catch (_) {} S.cleanup = null; }
    S.feature = null;
    setTimeout(() => { sheet.hidden = true; $('#sheetBody').innerHTML = ''; }, 380);
    if (pop && location.hash.indexOf('#f/') === 0) history.back();
  }

  $('#sheetClose').addEventListener('click', () => closeSheet(true));
  $('#sheetScrim').addEventListener('click', () => closeSheet(true));

  /* 面板是全屏固定的，不再支持下拉关闭 ——
     用户要求进入功能后就是全屏，不要靠手势去切。 */

  $('#sheetFav').addEventListener('click', () => { if (S.feature) toggleFav(S.feature); });
  function syncSheetFav() {
    if (!S.feature) return;
    $('#sheetFav').classList.toggle('is-on', S.fav.has(S.feature));
  }

  function openFeature(id, push) {
    const f = byId(id);
    if (!f) return;

    if (S.cleanup) { try { S.cleanup(); } catch (_) {} S.cleanup = null; }

    S.feature = id;
    $('#sheetTitle').textContent = f.name;
    $('#sheetDesc').textContent = f.desc || '';
    $('#sheetIcon').innerHTML = iconSvg(f.icon);
    syncSheetFav();

    const body = $('#sheetBody');
    body.innerHTML = '';
    body.scrollTop = 0;

    try {
      const cleanup = f.render(body, kit);
      S.cleanup = typeof cleanup === 'function' ? cleanup : null;
    } catch (err) {
      body.innerHTML = '<div class="empty"><div class="empty__title">这个功能启动失败</div>' +
        '<div class="empty__desc">' + escapeHtml(err && err.message || String(err)) + '</div></div>';
    }

    openSheet();
    if (push !== false) history.pushState({ screen: S.screen, feature: id }, '', '#f/' + id);
  }

  /* ============================================================
     偏好设置
     ============================================================ */
  let field = null;

  function applyPrefs() {
    const level = get(LS.glass, '1');
    document.body.classList.remove('glass-1', 'glass-2', 'glass-3');
    document.body.classList.add('glass-' + level);
    $$('#glassSeg button').forEach(b => b.classList.toggle('is-active', b.dataset.level === String(level)));

    const parts = get(LS.parts, '1') === '1';
    const anim = get(LS.anim, '1') === '1';
    document.body.classList.toggle('no-anim', !anim);
    $('#swParts').checked = parts;
    $('#swAnim').checked = anim;
    if (field) field.setEnabled(parts);
  }

  $$('#glassSeg button').forEach(b => {
    b.addEventListener('click', () => {
      set(LS.glass, b.dataset.level);
      applyPrefs();
      const names = { '1': '流畅（卡片不做背景模糊）', '2': '标准', '3': '极致（粒子被糊成大片色块）' };
      toast('玻璃质感：' + names[b.dataset.level]);
    });
  });

  $('#swParts').addEventListener('change', e => {
    set(LS.parts, e.target.checked ? '1' : '0');
    if (field) field.setEnabled(e.target.checked);
  });
  $('#swAnim').addEventListener('change', e => {
    set(LS.anim, e.target.checked ? '1' : '0');
    document.body.classList.toggle('no-anim', !e.target.checked);
  });

  $('#btnClearFav').addEventListener('click', () => {
    S.fav.clear(); saveFav(); renderAll(); syncSheetFav(); toast('收藏已清空');
  });

  /* ============================================================
     粒子背景
     ============================================================ */
  function bootParticles() {
    const cv = $('#particles');
    if (!cv || !window.ParticleField) return;
    field = new window.ParticleField(cv, {
      enabled: get(LS.parts, '1') === '1',
      maxParticles: 175,
      minParticles: 55
    });
    field.start();

    setInterval(() => {
      if (!field || S.screen !== 'screen-settings') return;
      $('#pcount').textContent = field.parts.length + ' 个';
      $('#pfps').textContent = field.fps ? field.fps + ' fps' : '—';
    }, 1000);
  }

  /* ============================================================
     运行模式 / 离线缓存
     ============================================================ */
  const standalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  $('#appMode').textContent = standalone ? '独立 App 模式' : '浏览器模式';

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .then(() => { $('#swStatus').textContent = '已启用'; })
        .catch(() => { $('#swStatus').textContent = '未启用'; });
    });
  } else {
    $('#swStatus').textContent = '不适用';
  }

  document.addEventListener('gesturestart', e => e.preventDefault());

  /* ============================================================
     返回键 / 手势
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

  /* ============================================================
     启动
     ============================================================ */
  applyPrefs();
  renderAll();
  bootParticles();

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
