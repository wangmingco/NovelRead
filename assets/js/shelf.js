/* ═══════════════════════════════════════════════════════════
   shelf.js  书架：书库清单 / 下载 / 继续阅读 / 详情
   ═══════════════════════════════════════════════════════════ */

import { $, escapeHtml, formatWords, formatBytes, relTime, debounce } from './util.js';
import {
  idbAll, idbGet, idbPut, idbRemoveBook, idbAllBy, idbClear, storageInfo, requestPersistence, saveBook,
} from './db.js';
import { loadManifest, downloadBook } from './api.js';
import { toast, openSheet, closeSheet, confirmDialog, coverMarkup, bookPercent, percentLabel, paletteFor } from './ui.js';
import { renderSettingsPanel } from './settings-panel.js';

const els = {};
const state = {
  manifest: { books: [], updatedAt: '' },
  /** id -> 已下载的书籍记录 */
  books: new Map(),
  /** bookId -> 进度 */
  progress: new Map(),
  /** bookId -> 书签数量 */
  markCount: new Map(),
  /** id -> 下载进度 0-1 */
  downloads: new Map(),
  tab: 'all',
  query: '',
  loading: false,
};

/* ── 数据 ───────────────────────────────────────────────── */

async function ensureManifest(force = false) {
  if (state.manifest.books.length && !force) return;
  try {
    state.manifest = await loadManifest();
    await idbPut('kv', { key: 'manifest', value: state.manifest, at: Date.now() });
  } catch (err) {
    const cached = await idbGet('kv', 'manifest');
    if (cached?.value?.books?.length) {
      state.manifest = cached.value;
      toast('离线：正在使用上次的书库清单', { icon: 'i-warn' });
    } else {
      throw err;
    }
  }
}

async function loadLocal() {
  const [books, progress, marks] = await Promise.all([
    idbAll('books'),
    idbAll('progress'),
    idbAll('bookmarks'),
  ]);
  state.books = new Map(books.map((b) => [b.id, b]));
  state.progress = new Map(progress.map((p) => [p.bookId, p]));
  state.markCount = new Map();
  for (const m of marks) state.markCount.set(m.bookId, (state.markCount.get(m.bookId) || 0) + 1);
}

/** 清单 ∪ 本地书（可能包含清单里已删除的书） */
function library() {
  const out = [];
  const seen = new Set();
  for (const item of state.manifest.books) {
    seen.add(item.id);
    out.push({ ...item, record: state.books.get(item.id) || null });
  }
  for (const [id, rec] of state.books) {
    if (seen.has(id)) continue;
    out.push({
      id,
      title: rec.title,
      author: rec.author,
      intro: rec.intro,
      tags: rec.tags || [],
      words: rec.words,
      url: rec.url,
      record: rec,
      orphan: true,
    });
  }
  return out;
}

function getItem(id) {
  return library().find((b) => b.id === id) || null;
}

export function lastRead() {
  let bestId = null;
  let bestAt = -1;
  for (const [id, p] of state.progress) {
    if (!state.books.has(id)) continue;
    if ((p.updatedAt || 0) > bestAt) {
      bestAt = p.updatedAt || 0;
      bestId = id;
    }
  }
  if (!bestId) {
    let bestDl = -1;
    for (const [id, rec] of state.books) {
      if ((rec.downloadedAt || 0) > bestDl) {
        bestDl = rec.downloadedAt || 0;
        bestId = id;
      }
    }
  }
  if (!bestId) return null;
  const item = getItem(bestId);
  if (!item) return null;
  return { item, progress: state.progress.get(bestId) || null };
}

export function isDownloaded(id) {
  return state.books.has(id);
}

/* ── 渲染 ───────────────────────────────────────────────── */

function filtered() {
  let list = library();
  if (state.tab === 'downloaded') list = list.filter((b) => b.record);
  else if (state.tab === 'reading') list = list.filter((b) => state.progress.has(b.id));
  if (state.query) {
    const q = state.query.toLowerCase();
    list = list.filter((b) =>
      [b.title, b.author, (b.tags || []).join(' '), b.intro].join(' ').toLowerCase().includes(q)
    );
  }
  return list;
}

function heroHTML() {
  const last = lastRead();
  if (!last) {
    return `<div class="hero hero--empty">
      <svg class="icon"><use href="#i-book"/></svg>
      <b>书架还是空的</b>
      <p>从下面挑一本，点封面就能下载到浏览器里。<br />下载后离线也能继续读。</p>
    </div>`;
  }
  const { item, progress } = last;
  const count = item.record?.chapterCount || 0;
  const pct = bookPercent(progress, count);
  const chapterLabel = progress
    ? `第 ${(progress.chapterIndex | 0) + 1} 章 · ${percentLabel(pct)}`
    : `共 ${count} 章 · 尚未开始`;
  const p = paletteFor(item.id);

  return `<button class="hero" id="hero-continue" type="button" data-id="${escapeHtml(item.id)}">
    <span class="hero-cover" style="--c1:${p.c1};--c2:${p.c2};--c-fg:${p.fg}"><span>${escapeHtml(item.title)}</span></span>
    <span class="hero-info">
      <span class="hero-kicker">继续阅读</span>
      <span class="hero-title">${escapeHtml(item.title)}</span>
      <span class="hero-sub">${escapeHtml(chapterLabel)}</span>
      <span class="hero-bar"><i style="width:${pct}%"></i></span>
    </span>
    <span class="hero-go"><svg class="icon"><use href="#i-next"/></svg></span>
  </button>`;
}

function cardHTML(item, index) {
  const rec = item.record;
  const progress = state.progress.get(item.id) || null;
  const count = rec?.chapterCount || 0;
  const pct = rec ? bookPercent(progress, count) : 0;
  const dl = state.downloads.get(item.id);
  const dlPct = dl ? Math.round((dl.ratio || 0) * 100) : 0;

  let meta;
  if (dl) {
    meta = `<span>${escapeHtml(dl.label || '下载中')} ${dlPct}%</span>`;
  } else if (rec && progress) {
    meta = `<svg class="icon"><use href="#i-clock"/></svg><span><b>第 ${(progress.chapterIndex | 0) + 1} 章</b> · ${percentLabel(pct)}</span>`;
  } else if (rec) {
    meta = `<span>共 ${count} 章 · 未读</span>`;
  } else {
    const bits = [];
    if (item.chapterCount) bits.push(`${item.chapterCount} 章`);
    if (item.size) bits.push(formatBytes(item.size));
    else if (item.words) bits.push(formatWords(item.words));
    if (item.compress) bits.push(item.compress.toUpperCase());
    meta = `<span>${bits.join(' · ') || '待下载'}</span>`;
  }

  const overlay = dl
    ? `<span class="cover-state"><span><svg class="icon spin"><use href="#i-spinner"/></svg><br>${dlPct}%</span></span>`
    : '';
  const badge = rec
    ? `<button class="cover-badge cover-badge--info" type="button" data-action="info" aria-label="详情"><svg class="icon"><use href="#i-list"/></svg></button>`
    : '';
  const marks = state.markCount.get(item.id) || 0;

  return `<div class="book-card" data-id="${escapeHtml(item.id)}" role="button" tabindex="0"
      aria-label="${escapeHtml(item.title)}" style="animation-delay:${Math.min(index, 11) * 26}ms">
    ${coverMarkup(item, { progress: rec ? pct : null, overlay, badge })}
    <div class="card-foot">
      <div class="card-name">${escapeHtml(item.title)}</div>
      <div class="card-meta ${rec && progress ? 'is-reading' : ''}">${meta}</div>
      ${marks ? `<div class="card-meta"><svg class="icon"><use href="#i-bookmark-fill"/></svg><span>${marks} 个书签</span></div>` : ''}
    </div>
  </div>`;
}

function render() {
  const list = filtered();
  els.grid.innerHTML = list.map(cardHTML).join('');

  els.empty.hidden = list.length > 0;
  if (!list.length) {
    els.empty.querySelector('p').innerHTML = state.query
      ? '没有找到匹配的书。<br />换个关键词试试。'
      : state.tab === 'downloaded'
        ? '还没有下载任何书。<br />在「全部」里点一本书开始下载。'
        : '还没有开始读的书。<br />挑一本翻开就有了。';
  }

  // 计数
  const all = library();
  const counts = {
    all: all.length,
    downloaded: all.filter((b) => b.record).length,
    reading: all.filter((b) => state.progress.has(b.id)).length,
  };
  document.querySelectorAll('[data-count]').forEach((n) => {
    n.textContent = counts[n.dataset.count] ?? '';
  });
}

function renderHero() {
  els.hero.innerHTML = heroHTML();
}

async function renderFoot() {
  const info = await storageInfo();
  const books = state.books.size;
  const words = [...state.books.values()].reduce((s, b) => s + (b.words || 0), 0);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  els.foot.innerHTML = `
    <span class="grow">已下载 <b>${books}</b> 本 · <b>${formatWords(words)}</b>${
      info ? ` · 占用 <b>${formatBytes(info.usage)}</b>${info.quota ? ` / 约 ${formatBytes(info.quota)}` : ''}` : ''
    }</span>
    <span>${persisted ? '浏览器已允许长期保存 ✓' : '存储可能被系统回收'}</span>
    <button class="link-btn" id="btn-clear-all" type="button">清空所有下载</button>
  `;
  $('#btn-clear-all')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '清空所有下载',
      message: '将删除全部已下载的正文、阅读进度与书签。此操作不可撤销。',
      confirmText: '清空',
      danger: true,
    });
    if (!ok) return;
    await Promise.all([
      idbClear('books'), idbClear('chunks'), idbClear('progress'), idbClear('bookmarks'),
    ]);
    state.books.clear();
    state.progress.clear();
    state.markCount.clear();
    await refreshShelf();
    toast('已清空', { icon: 'i-check' });
  });
}

export async function refreshShelf({ forceManifest = false, quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  try {
    await ensureManifest(forceManifest);
    await loadLocal();
    renderHero();
    render();
    renderFoot();
  } catch (err) {
    if (!quiet) toast(err.message || '书库加载失败', { icon: 'i-warn' });
    els.grid.innerHTML = '';
  } finally {
    state.loading = false;
  }
}

/* ── 下载 ───────────────────────────────────────────────── */

async function startDownload(id) {
  if (state.downloads.has(id)) return;
  const item = state.manifest.books.find((b) => b.id === id) || getItem(id);
  if (!item) return;

  state.downloads.set(id, { ratio: 0, label: '下载中' });
  paintDownload(id, state.downloads.get(id));
  requestPersistence();

  const report = (info) => {
    const prev = state.downloads.get(id);
    const next = { ratio: info.ratio ?? prev?.ratio ?? 0, label: info.label || prev?.label || '下载中' };
    state.downloads.set(id, next);
    paintDownload(id, next);
  };

  try {
    const book = await downloadBook(item, report);
    report({ ratio: 1, label: '存入浏览器' });
    await saveBook(book, (ratio) => report({ ratio, label: '存入浏览器' }));
    await idbPut('kv', { key: 'lastDownload', value: { id, at: Date.now() } });

    state.downloads.delete(id);
    state.books.set(id, book.meta);
    await refreshShelf();
    toast(`《${book.meta.title}》已存入浏览器 · ${book.meta.chapterCount} 章`, { icon: 'i-check' });
    requestPersistence();
  } catch (err) {
    state.downloads.delete(id);
    await refreshShelf();
    toast(err.message || '下载失败', { icon: 'i-warn', duration: 4200 });
  }
}

function paintDownload(id, info) {
  const card = els.grid.querySelector(`.book-card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  const pct = Math.round((info.ratio || 0) * 100);
  const cover = card.querySelector('.cover');
  if (cover) {
    let node = cover.querySelector('.cover-state');
    if (!node) {
      node = document.createElement('span');
      node.className = 'cover-state';
      cover.appendChild(node);
    }
    node.innerHTML = `<span><svg class="icon spin"><use href="#i-spinner"/></svg><br>${pct}%</span>`;
  }
  const meta = card.querySelector('.card-meta');
  if (meta) meta.innerHTML = `<span>${info.label} ${pct}%</span>`;
}

/* ── 书籍详情 ───────────────────────────────────────────── */

export async function openBookDetail(id) {
  const item = getItem(id);
  if (!item) return;
  const rec = item.record;
  const progress = state.progress.get(id) || null;
  const marks = await idbAllBy('bookmarks', 'bookId', id);
  const count = rec?.chapterCount || 0;
  const pct = bookPercent(progress, count);

  $('#book-sheet-title').textContent = '书籍详情';

  const body = $('#book-sheet-body');
  body.innerHTML = `
    <div class="book-hero">
      ${coverMarkup(item, { progress: rec ? pct : null })}
      <div class="book-hero-info">
        <h4>${escapeHtml(item.title)}</h4>
        <div class="book-hero-author">${escapeHtml(item.author)}${item.orphan ? ' · 本地' : ''}</div>
        <div class="book-tags">
          ${(item.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          <span class="tag">${escapeHtml(
            rec
              ? `${rec.format.toUpperCase()}${rec.compress ? ` · ${rec.compress.toUpperCase()}` : ''}`
              : (item.compress || item.format || 'txt').toUpperCase()
          )}</span>
        </div>
      </div>
    </div>

    <div class="book-stats">
      <div><b>${rec ? count : '—'}</b>章</div>
      <div><b>${formatWords(rec?.words || item.words)}</b>篇幅</div>
      <div><b>${rec ? percentLabel(pct) : '—'}</b>进度</div>
      <div><b>${marks.length}</b>书签</div>
    </div>

    ${item.intro ? `<p class="book-intro">${escapeHtml(item.intro)}</p>` : ''}

    <div class="book-actions">
      ${
        rec
          ? `<button class="btn btn--primary" data-act="read" type="button">
               <svg class="icon"><use href="#i-book"/></svg>${progress ? '继续阅读' : '开始阅读'}
             </button>
             <button class="btn" data-act="delete" type="button"><svg class="icon"><use href="#i-trash"/></svg>删除</button>`
          : `<button class="btn btn--primary" data-act="download" type="button">
               <svg class="icon"><use href="#i-download"/></svg>下载到浏览器
             </button>`
      }
    </div>

    ${
      rec
        ? `<ul class="book-details-list">
            <li class="row"><div class="row-main"><div class="row-title">最近阅读</div></div>
              <div class="row-sub">${progress ? relTime(progress.updatedAt) : '尚未开始'}</div></li>
            <li class="row"><div class="row-main"><div class="row-title">下载时间</div></div>
              <div class="row-sub">${relTime(rec.downloadedAt)}</div></li>
            <li class="row"><div class="row-main"><div class="row-title">来源</div></div>
              <div class="row-sub">${escapeHtml(item.url || '')}</div></li>
          </ul>`
        : ''
    }
  `;

  body.querySelector('[data-act="read"]')?.addEventListener('click', () => {
    closeSheet();
    location.hash = `#/read/${encodeURIComponent(id)}`;
  });

  body.querySelector('[data-act="download"]')?.addEventListener('click', async () => {
    closeSheet();
    await startDownload(id);
  });

  body.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '删除本书',
      message: `从浏览器中删除《${item.title}》？阅读进度和书签也会一并清除。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    closeSheet();
    await idbRemoveBook(id);
    await refreshShelf();
    toast('已删除', { icon: 'i-check' });
  });

  openSheet('sheet-book');
}

/* ── 交互绑定 ───────────────────────────────────────────── */

function openItem(id) {
  const item = getItem(id);
  if (!item) return;
  if (item.record) {
    if (state.downloads.has(id)) return;
    location.hash = `#/read/${encodeURIComponent(id)}`;
  } else {
    openBookDetail(id);
  }
}

export function initShelf() {
  els.grid = $('#book-grid');
  els.hero = $('#hero-slot');
  els.empty = $('#shelf-empty');
  els.foot = $('#shelf-foot');
  els.scroll = $('#shelf-scroll');

  // 分类
  $('#shelf-tabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    state.tab = tab.dataset.tab;
    document.querySelectorAll('#shelf-tabs .tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    render();
  });

  // 搜索
  const search = $('#shelf-search');
  search?.addEventListener(
    'input',
    debounce(() => {
      state.query = search.value.trim();
      render();
    }, 160)
  );

  // 继续阅读
  els.hero.addEventListener('click', (e) => {
    const hero = e.target.closest('.hero');
    if (!hero || hero.classList.contains('hero--empty')) return;
    openItem(hero.dataset.id);
  });

  // 书卡：点击 / 长按
  let timer = 0;
  let longFired = false;
  let start = null;

  els.grid.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.book-card');
    if (!card) return;
    longFired = false;
    start = { x: e.clientX, y: e.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => {
      longFired = true;
      openBookDetail(card.dataset.id);
    }, 520);
  });

  els.grid.addEventListener('pointermove', (e) => {
    if (!start) return;
    if (Math.abs(e.clientX - start.x) > 12 || Math.abs(e.clientY - start.y) > 12) {
      clearTimeout(timer);
      start = null;
    }
  });

  const cancelPress = () => {
    clearTimeout(timer);
    start = null;
  };
  els.grid.addEventListener('pointercancel', cancelPress);

  els.grid.addEventListener('pointerup', (e) => {
    clearTimeout(timer);
    const card = e.target.closest('.book-card');
    start = null;
    if (!card || longFired) return;
    if (e.target.closest('[data-action="info"]')) {
      openBookDetail(card.dataset.id);
      return;
    }
    openItem(card.dataset.id);
  });

  els.grid.addEventListener('keydown', (e) => {
    const card = e.target.closest('.book-card');
    if (!card) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openItem(card.dataset.id);
    }
  });

  // 顶栏
  $('#btn-refresh')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const icon = btn.querySelector('.icon');
    icon?.classList.add('spin');
    await refreshShelf({ forceManifest: true });
    icon?.classList.remove('spin');
    toast('书库已刷新', { icon: 'i-check' });
  });

  $('#btn-storage')?.addEventListener('click', async () => {
    const info = await storageInfo();
    const persisted = await navigator.storage?.persisted?.().catch(() => false);
    toast(
      info
        ? `已用 ${formatBytes(info.usage)}${info.quota ? ` / 可用 ${formatBytes(info.quota)}` : ''}${persisted ? ' · 已持久化' : ''}`
        : '当前浏览器不支持存储查询',
      { icon: 'i-cloud', duration: 3200 }
    );
  });

  $('#btn-shelf-settings')?.addEventListener('click', () => {
    renderSettingsPanel({});
    openSheet('sheet-settings');
  });
}
