/* ============================================================
   MyApp · 逻辑
   ============================================================ */

(function () {
  'use strict';

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ---------- 1. 标签页切换 ---------- */
  const TITLES = {
    'screen-home': '首页',
    'screen-tools': '功能',
    'screen-settings': '设置'
  };

  function switchTo(screenId, push) {
    const target = document.getElementById(screenId);
    if (!target) return;

    $$('.screen').forEach(s => s.classList.toggle('is-active', s === target));
    $$('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.target === screenId));
    $('#topbarTitle').textContent = TITLES[screenId] || '';

    // 切页时回到顶部，并把标题栏收起来
    $('#screens').scrollTop = 0;
    $('#topbarTitle').parentElement.classList.remove('is-scrolled');

    if (push) {
      history.pushState({ screenId }, '', '#' + screenId);
    }
  }

  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTo(tab.dataset.target, true));
  });

  // 支持 iPad 的返回手势 / 返回键
  window.addEventListener('popstate', e => {
    const id = (e.state && e.state.screenId) || 'screen-home';
    switchTo(id, false);
  });

  /* ---------- 2. 滚动时标题栏收放 ---------- */
  const topbar = $('.topbar');
  $('#screens').addEventListener('scroll', () => {
    topbar.classList.toggle('is-scrolled', $('#screens').scrollTop > 12);
  }, { passive: true });

  /* ---------- 3. 时钟 ---------- */
  const clockEl = $('#clock');
  const pad = n => String(n).padStart(2, '0');

  function tick() {
    const d = new Date();
    clockEl.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  tick();
  // 对齐到整秒，避免秒数跳动时偶尔卡一下
  setTimeout(() => { tick(); setInterval(tick, 1000); }, 1000 - (Date.now() % 1000));

  /* ---------- 4. 外观主题 ---------- */
  const THEME_KEY = 'myapp.theme';

  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === 'auto') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', mode);
    }
    $$('#themeSeg .segmented__item').forEach(b => {
      b.classList.toggle('is-active', b.dataset.theme === mode);
    });
    try { localStorage.setItem(THEME_KEY, mode); } catch (_) {}
  }

  $$('#themeSeg .segmented__item').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });

  let savedTheme = 'auto';
  try { savedTheme = localStorage.getItem(THEME_KEY) || 'auto'; } catch (_) {}
  applyTheme(savedTheme);

  /* ---------- 5. 运行模式检测 ---------- */
  const isStandalone =
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;

  const modeText = isStandalone ? '独立 App 模式' : '浏览器模式';
  $('#appMode').textContent = modeText;

  $('#displayMode').textContent = isStandalone
    ? '已作为独立 App 运行，没有地址栏 —— 这一条说明加到主屏幕成功了'
    : '当前在 Safari 里打开。加到主屏幕后就会变成全屏无地址栏的独立 App。';

  if (isStandalone) {
    $('#engineStatus').textContent = '独立 App 模式运行中';
  }

  /* ---------- 6. 重新加载 ---------- */
  $('#btnRefresh').addEventListener('click', () => {
    location.reload();
  });

  /* ---------- 7. 离屏缓存（让 App 断网也能打开） ---------- */
  const swStatusEl = $('#swStatus');

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .then(() => { swStatusEl.textContent = '已启用（可离线打开）'; })
        .catch(() => { swStatusEl.textContent = '未启用'; });
    });
  } else {
    swStatusEl.textContent = '不适用';
  }

  /* ---------- 8. 初始化路由 ---------- */
  const initial = (location.hash || '').replace('#', '');
  if (TITLES[initial]) {
    switchTo(initial, false);
    history.replaceState({ screenId: initial }, '', '#' + initial);
  } else {
    history.replaceState({ screenId: 'screen-home' }, '', '#screen-home');
  }

  /* ---------- 9. 双指缩放屏蔽（iOS 网页 App 常见糊感来源） ---------- */
  document.addEventListener('gesturestart', e => e.preventDefault());
})();
