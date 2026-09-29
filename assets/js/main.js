/* ═══════════════════════════════════════════════════════════
   main.js  启动、路由、生命周期
   ═══════════════════════════════════════════════════════════ */

import { $ } from './util.js';
import { applySettings } from './store.js';
import { openDB, requestPersistence } from './db.js';
import { initShelf, refreshShelf } from './shelf.js';
import { initReader, openReader, closeReader, flushProgress } from './reader.js';
import { toast } from './ui.js';

// 尽早应用设置，避免主题闪烁
applySettings();

const viewShelf = $('#view-shelf');
const viewReader = $('#view-reader');

let routeKey = '';

function showShelf() {
  viewReader.hidden = true;
  viewShelf.hidden = false;
  document.body.classList.remove('is-reading');
}

function showReader() {
  viewShelf.hidden = true;
  viewReader.hidden = false;
  document.body.classList.add('is-reading');
}

async function route() {
  const hash = location.hash || '#/';
  const match = hash.match(/^#\/read\/(.+)$/);

  if (match) {
    const id = decodeURIComponent(match[1]);
    if (routeKey === `read:${id}`) return;
    routeKey = `read:${id}`;
    // 必须先让阅读器可见，否则量不到尺寸、分页会算错
    showReader();
    const ok = await openReader(id);
    if (!ok) {
      routeKey = '';
      showShelf();
      if (location.hash !== '#/') location.hash = '#/';
      return;
    }
    return;
  }

  if (routeKey === 'shelf') return;
  if (routeKey.startsWith('read:')) await closeReader();
  routeKey = 'shelf';
  showShelf();
  await refreshShelf();
}

async function boot() {
  initShelf();
  initReader();

  window.addEventListener('hashchange', () => {
    route().catch((err) => toast(err.message || '出错了', { icon: 'i-warn' }));
  });

  // 切到后台 / 关闭页面前，把阅读位置落盘
  const flush = () => {
    flushProgress();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);

  try {
    await openDB();
  } catch (err) {
    toast(err.message || '无法打开本地存储', { icon: 'i-warn', duration: 6000 });
  }

  await route();

  // 申请持久化存储
  setTimeout(() => requestPersistence(), 1500);
}

boot();
