/* ═══════════════════════════════════════════════════════════
   reader.js  阅读器：翻页 / 滚动 / 目录 / 书签 / 进度记忆
   ═══════════════════════════════════════════════════════════ */

import {
  $, escapeHtml, clamp, debounce, nextFrame, hasSelection, isTouchDevice, vibrate, clockText, relTime,
} from './util.js';
import { idbGet, idbPut, idbAllBy, idbDelete, idbRemoveBook, getChunk } from './db.js';
import { toast, openSheet, closeSheet, confirmDialog, bookPercent, percentLabel } from './ui.js';
import { settings, onSettings } from './store.js';
import { renderSettingsPanel, setupSettingsPanel } from './settings-panel.js';

/** 分页时列与列之间的间隔，必须大于左右内边距，否则换页时会露出上一页的尾巴 */
const PGAP = 44;
const SAVE_DELAY = 600;
/** 内存里最多缓存几个分片（每片 40 章） */
const SHARD_CACHE = 4;

const els = {};
const S = {
  book: null,
  titles: [],
  index: 0,
  page: 0,
  pages: 1,
  pageW: 0,
  mode: 'page',
  marks: [],
  shards: new Map(),
  chromeTimer: 0,
  saveTimer: 0,
  badgeTimer: 0,
  dragged: false,
  clockTimer: 0,
};

/* ── 章节按需载入（大书不可能一次性放进内存） ───────────── */

const shardSize = () => S.book?.shardSize || 40;
const shardOf = (i) => Math.floor(i / shardSize());
const chapterCount = () => S.titles.length || S.book?.chapterCount || 0;
const titleOf = (i) => S.titles[i] || `第 ${i + 1} 章`;

async function loadShard(si) {
  const hit = S.shards.get(si);
  if (hit) {
    S.shards.delete(si);
    S.shards.set(si, hit);
    return hit;
  }
  const rec = await getChunk(S.book.id, si);
  const arr = rec?.chapters || [];
  S.shards.set(si, arr);
  while (S.shards.size > SHARD_CACHE) S.shards.delete(S.shards.keys().next().value);
  return arr;
}

async function chapterAt(i) {
  const si = shardOf(i);
  const arr = await loadShard(si);
  return { title: titleOf(i), content: arr[i - si * shardSize()] || '' };
}

/* ══ 打开 / 关闭 ═══════════════════════════════════════════ */

export async function openReader(bookId) {
  const book = await idbGet('books', bookId);
  if (!book || !book.chapterCount) {
    toast('这本书还没有下载', { icon: 'i-warn' });
    return false;
  }

  S.book = book;
  S.titles = Array.isArray(book.titles) ? book.titles : [];
  S.shards.clear();
  S.index = 0;
  S.page = 0;
  S.pages = 1;
  S.dragged = false;

  els.title.textContent = book.title;
  setMode(settings.mode === 'page' ? 'page' : 'scroll', { silent: true });

  const prog = await idbGet('progress', bookId);
  S.index = clamp(Number(prog?.chapterIndex) || 0, 0, chapterCount() - 1);
  const ratio = clamp(Number(prog?.ratio) || 0, 0, 1);

  S.marks = await loadMarks();
  renderMarks();
  renderTOC('');

  await renderChapter({ ratio: prog ? ratio : 0 });
  setChrome(true, true);
  updateClock();
  clearInterval(S.clockTimer);
  S.clockTimer = setInterval(updateClock, 20_000);
  maybeShowHint();
  return true;
}

export async function closeReader() {
  clearTimeout(S.chromeTimer);
  clearTimeout(S.saveTimer);
  clearTimeout(S.badgeTimer);
  clearInterval(S.clockTimer);
  await saveProgress();
  S.book = null;
  S.titles = [];
  S.shards.clear();
}

export function currentBookId() {
  return S.book?.id || null;
}

/** 立即落盘阅读位置（切后台、关闭页面前调用） */
export function flushProgress() {
  return saveProgress();
}

/* ══ 章节渲染 ═════════════════════════════════════════════ */

function navMarkup() {
  const hasPrev = S.index > 0;
  const hasNext = S.index < chapterCount() - 1;
  return `<nav class="chapter-nav">
    <button type="button" data-nav="prev" ${hasPrev ? '' : 'disabled'}>
      <svg class="icon"><use href="#i-back"/></svg>上一章
    </button>
    <button type="button" data-nav="toc">目录</button>
    ${
      hasNext
        ? `<button type="button" data-nav="next">下一章<svg class="icon"><use href="#i-next"/></svg></button>`
        : `<span class="done"><svg class="icon"><use href="#i-check"/></svg>全书完</span>`
    }
  </nav>`;
}

function chapterHTML(ch) {
  const total = chapterCount();
  const paras = String(ch.content || '')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const body = paras.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  return `<h2>${escapeHtml(ch.title)}</h2>
    <p class="chapter-meta">第 ${S.index + 1} / ${total} 章</p>
    ${body}
    ${navMarkup()}`;
}

async function renderChapter({ ratio = 0, smooth = false } = {}) {
  const ch = await chapterAt(S.index);
  els.stream.innerHTML = chapterHTML(ch);
  els.sub.textContent = ch.title;
  await nextFrame();

  if (S.mode === 'page') {
    paginate();
    setPage(Math.round(clamp(ratio, 0, 1) * Math.max(0, S.pages - 1)), smooth);
  } else {
    els.stage.scrollTop = 0;
    jumpScroll(clamp(ratio, 0, 1));
    updateUI();
  }
  highlightCurrentMark();
  markTOCActive();
}

export async function gotoChapter(i, { ratio = 0 } = {}) {
  if (!S.book) return;
  const next = clamp(i, 0, chapterCount() - 1);
  S.index = next;
  await renderChapter({ ratio });
  saveProgress();
}

/* ══ 分页 ═════════════════════════════════════════════════ */

function paginate() {
  const stage = els.stage;
  const stream = els.stream;
  const cs = getComputedStyle(stage);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const w = Math.max(80, Math.round(stage.clientWidth - padX));
  const h = Math.max(80, Math.round(stage.clientHeight - padY));

  stream.style.width = `${w}px`;
  stream.style.height = `${h}px`;
  stream.style.columnWidth = `${w}px`;
  stream.style.columnGap = `${PGAP}px`;
  stream.style.columnFill = 'auto';
  stream.style.columnCount = '';

  S.pageW = w + PGAP;

  // 方法一：滚动容器的可滚动宽度（读取时会强制一次同步布局）
  const overflow = Math.max(0, stage.scrollWidth - stage.clientWidth);
  const byScroll = Math.round(overflow / S.pageW) + 1;

  // 方法二：直接量最后一个元素落在第几栏（更可靠，不依赖 scrollWidth 的实现差异）
  let byRect = 1;
  const last = stream.querySelector('.chapter-nav');
  if (last) {
    const left = stream.getBoundingClientRect().left;
    const contentWidth = last.getBoundingClientRect().right - left;
    byRect = Math.ceil((contentWidth - 1) / S.pageW);
  }

  S.pages = Math.max(1, byScroll, byRect);
  return S.pages;
}

function setPage(n, smooth = false) {
  const target = clamp(n, 0, S.pages - 1);
  S.page = target;
  const left = target * S.pageW;
  if (Math.abs(els.stage.scrollLeft - left) > 1) {
    els.stage.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
  }
  updateUI();
  showBadge();
}

/** 翻页（点击两侧 / 键盘） */
function turn(dir) {
  if (S.mode === 'scroll') {
    const max = els.stage.scrollHeight - els.stage.clientHeight;
    const step = els.stage.clientHeight * 0.86;
    const top = clamp(els.stage.scrollTop + dir * step, 0, Math.max(0, max));
    if (Math.abs(top - els.stage.scrollTop) < 2) {
      if (dir > 0 && S.index < chapterCount() - 1) gotoChapter(S.index + 1);
      else if (dir < 0 && S.index > 0) gotoChapter(S.index - 1, { ratio: 1 });
    } else {
      els.stage.scrollTo({ top, behavior: 'smooth' });
    }
    return;
  }

  const next = S.page + dir;
  if (next >= 0 && next < S.pages) {
    setPage(next, true);
    vibrate(6);
    return;
  }
  if (dir > 0 && S.index < chapterCount() - 1) {
    gotoChapter(S.index + 1);
    vibrate(8);
  } else if (dir < 0 && S.index > 0) {
    gotoChapter(S.index - 1, { ratio: 1 });
    vibrate(8);
  } else {
    toast(dir > 0 ? '已经是最后一页了' : '已经是第一页了');
  }
}

const snapToPage = debounce(() => {
  if (S.mode !== 'page' || !S.pageW) return;
  const n = clamp(Math.round(els.stage.scrollLeft / S.pageW), 0, S.pages - 1);
  const left = n * S.pageW;
  if (Math.abs(els.stage.scrollLeft - left) > 2) {
    els.stage.scrollTo({ left, behavior: 'smooth' });
  }
  if (n !== S.page) {
    S.page = n;
    updateUI();
    showBadge();
    vibrate(5);
  }
}, 150);

/* ══ 进度 ═════════════════════════════════════════════════ */

function currentRatio() {
  if (S.mode === 'page') {
    return S.pages <= 1 ? 1 : clamp(S.page / (S.pages - 1), 0, 1);
  }
  const max = els.stage.scrollHeight - els.stage.clientHeight;
  return max <= 4 ? 1 : clamp(els.stage.scrollTop / max, 0, 1);
}

function jumpScroll(ratio) {
  const max = Math.max(0, els.stage.scrollHeight - els.stage.clientHeight);
  els.stage.scrollTop = clamp(ratio, 0, 1) * max;
}

function scheduleSave() {
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveProgress, SAVE_DELAY);
}

async function saveProgress() {
  if (!S.book) return;
  await idbPut('progress', {
    bookId: S.book.id,
    chapterIndex: S.index,
    chapterTitle: titleOf(S.index),
    ratio: currentRatio(),
    updatedAt: Date.now(),
  });
}

function bookPct() {
  if (!S.book) return 0;
  return bookPercent({ chapterIndex: S.index, ratio: currentRatio() }, chapterCount());
}

/* ══ 界面 ═════════════════════════════════════════════════ */

function updateUI() {
  if (!S.book) return;
  const total = chapterCount();
  const pct = bookPct();

  els.seekChapter.textContent = `第 ${S.index + 1} / ${total} 章`;
  els.seekPercent.textContent = percentLabel(pct);
  els.statusPercent.textContent = `${Math.round(pct)}%`;
  els.statusChapter.textContent = titleOf(S.index);

  els.range.max = String(Math.max(0, total - 1));
  els.range.value = String(S.index);
  els.range.style.setProperty('--p', `${total > 1 ? (S.index / (total - 1)) * 100 : 100}%`);

  els.prev.disabled = S.index === 0;
  els.next.disabled = S.index === total - 1;

  els.badge.textContent = `${S.page + 1} / ${S.pages}`;
}

function updateClock() {
  els.statusClock.textContent = clockText();
}

function showBadge() {
  if (S.mode !== 'page') return;
  els.badge.hidden = false;
  els.badge.classList.add('is-show');
  clearTimeout(S.badgeTimer);
  S.badgeTimer = setTimeout(() => els.badge.classList.remove('is-show'), 900);
}

function setChrome(visible, autoHide = false) {
  els.reader.classList.toggle('is-immersive', !visible);
  clearTimeout(S.chromeTimer);
  if (visible && autoHide) {
    S.chromeTimer = setTimeout(() => setChrome(false, false), 3600);
  }
}

/** 清掉分页时写在行内样式上的多栏布局，避免切回滚动模式后正文仍是分栏 */
function resetStreamLayout() {
  const s = els.stream.style;
  s.width = '';
  s.height = '';
  s.columnWidth = '';
  s.columnGap = '';
  s.columnFill = '';
  s.columnCount = '';
}

function setMode(mode, { silent = false } = {}) {
  S.mode = mode === 'page' ? 'page' : 'scroll';
  els.reader.dataset.mode = S.mode;
  els.stage.scrollTop = 0;
  els.stage.scrollLeft = 0;
  els.badge.hidden = S.mode !== 'page';
  resetStreamLayout();
  void silent;
}

let hintShown = false;
function maybeShowHint() {
  if (hintShown || localStorage.getItem('inkread.hint.seen')) return;
  hintShown = true;
  localStorage.setItem('inkread.hint.seen', '1');
  els.hint.hidden = false;
  els.hint.innerHTML = isTouchDevice()
    ? '轻触屏幕中间可收起菜单<br>左右滑动翻页 · 两侧轻点翻页'
    : '点击屏幕中部收起菜单<br>← → 翻页 · 滚轮滚动';
  setTimeout(() => {
    els.hint.classList.add('is-out');
    setTimeout(() => {
      els.hint.hidden = true;
      els.hint.classList.remove('is-out');
    }, 320);
  }, 4600);
}

/* ══ 目录 ═════════════════════════════════════════════════ */

function renderTOC(filter = '') {
  if (!S.book) return;
  const total = chapterCount();
  const q = filter.trim().toLowerCase();

  if (q) {
    const hits = [];
    for (let i = 0; i < total; i++) {
      if (titleOf(i).toLowerCase().includes(q)) hits.push(i);
    }
    els.tocList.innerHTML = hits.length
      ? hits.map((i) => tocRow(i)).join('')
      : `<p class="empty-list">没有找到章节</p>`;
  } else {
    const rows = new Array(total);
    for (let i = 0; i < total; i++) rows[i] = tocRow(i);
    els.tocList.innerHTML = rows.join('');
  }
  els.tocSub.textContent = `${total} 章`;
}

function tocRow(i) {
  return `<button class="row ${i === S.index ? 'is-current' : ''}" type="button" data-i="${i}">
    <span class="row-num">${i + 1}</span>
    <span class="row-main"><span class="row-title">${escapeHtml(titleOf(i))}</span></span>
  </button>`;
}

function markTOCActive() {
  els.tocList.querySelectorAll('.row.is-current').forEach((r) => r.classList.remove('is-current'));
  const row = els.tocList.querySelector(`.row[data-i="${S.index}"]`);
  if (row) row.classList.add('is-current');
}

function scrollTOCtoCurrent() {
  const row = els.tocList.querySelector('.row.is-current');
  if (row) {
    els.tocList.scrollTop = Math.max(0, row.offsetTop - els.tocList.clientHeight / 2 + row.offsetHeight);
  }
}

/* ══ 书签 ═════════════════════════════════════════════════ */

function loadMarks() {
  return idbAllBy('bookmarks', 'bookId', S.book.id).then((list) =>
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  );
}

function renderMarks() {
  els.marksSub.textContent = S.marks.length ? `${S.marks.length} 条` : '';
  if (!S.marks.length) {
    els.marksList.innerHTML = `<p class="empty-list">还没有书签。<br>读到有意思的地方，点上面的按钮记一下。</p>`;
    return;
  }
  els.marksList.innerHTML = S.marks
    .map(
      (m) => `<div class="mark-item" data-id="${m.id}" data-key="${markKey(m)}">
        <button class="row" type="button" data-jump="${m.id}">
          <span class="row-main">
            <span class="row-title">${escapeHtml(m.chapterTitle || '')}</span>
            ${m.snippet ? `<span class="mark-snippet">${escapeHtml(m.snippet)}</span>` : ''}
            <span class="row-sub">${relTime(m.createdAt)}</span>
          </span>
        </button>
        <button class="mark-del" type="button" data-del="${m.id}" aria-label="删除书签">
          <svg class="icon"><use href="#i-trash"/></svg>
        </button>
      </div>`
    )
    .join('');
  highlightCurrentMark();
}

function markKey(m) {
  return `${m.chapterIndex}|${Math.round((m.ratio || 0) * 40)}`;
}

function highlightCurrentMark() {
  if (!S.book) return;
  const key = `${S.index}|${Math.round(currentRatio() * 40)}`;
  els.marksList.querySelectorAll('.mark-item').forEach((item) => {
    item.querySelector('[data-jump]')?.classList.toggle('is-current', item.dataset.key === key);
  });
}

function currentSnippet() {
  const r = els.stage.getBoundingClientRect();
  const x = r.left + r.width * 0.5;
  const y = r.top + clamp(r.height * 0.34, 96, 280);
  let node = null;
  try {
    node = document.elementFromPoint(x, y);
  } catch {
    node = null;
  }
  const p = node?.closest('p');
  const text = (p?.textContent || titleOf(S.index)).trim().replace(/\s+/g, ' ');
  return text.length > 70 ? `${text.slice(0, 70)}…` : text;
}

async function addBookmark() {
  if (!S.book) return;
  const ratio = currentRatio();
  const key = `${S.index}|${Math.round(ratio * 40)}`;
  if (S.marks.some((m) => markKey(m) === key)) {
    toast('这里已经有书签了', { icon: 'i-warn' });
    return;
  }
  await idbPut('bookmarks', {
    bookId: S.book.id,
    chapterIndex: S.index,
    chapterTitle: titleOf(S.index),
    ratio,
    snippet: currentSnippet(),
    createdAt: Date.now(),
  });
  S.marks = await loadMarks();
  renderMarks();
  vibrate(12);
  toast('已添加书签', { icon: 'i-bookmark-fill' });
}

/* ══ 事件 ═════════════════════════════════════════════════ */

export function initReader() {
  els.reader = $('#reader');
  els.stage = $('#reader-stage');
  els.stream = $('#reader-stream');
  els.title = $('#reader-title');
  els.sub = $('#reader-sub');
  els.range = $('#book-range');
  els.seekChapter = $('#seek-chapter');
  els.seekPercent = $('#seek-percent');
  els.statusChapter = $('#status-chapter');
  els.statusPercent = $('#status-percent');
  els.statusClock = $('#status-clock');
  els.prev = $('#btn-prev-chapter');
  els.next = $('#btn-next-chapter');
  els.badge = $('#page-badge');
  els.hint = $('#reader-hint');
  els.tocList = $('#toc-list');
  els.tocSub = $('#toc-sub');
  els.tocFilter = $('#toc-filter');
  els.marksList = $('#marks-list');
  els.marksSub = $('#marks-sub');
  els.view = $('#view-reader');

  /* 返回 */
  $('#btn-back').addEventListener('click', () => {
    location.hash = '#/';
  });

  /* 中间标题 → 目录 */
  $('#btn-book-info').addEventListener('click', openTOC);
  $('#btn-quick-bookmark').addEventListener('click', addBookmark);

  /* 进度条 */
  els.range.addEventListener('change', () => {
    gotoChapter(Number(els.range.value));
  });
  els.prev.addEventListener('click', () => gotoChapter(S.index - 1));
  els.next.addEventListener('click', () => gotoChapter(S.index + 1));

  /* 工具 */
  document.querySelectorAll('.tool').forEach((tool) => {
    tool.addEventListener('click', () => {
      const name = tool.dataset.tool;
      if (name === 'toc') openTOC();
      else if (name === 'bookmarks') openMarks();
      else if (name === 'settings') openSettings();
    });
  });

  /* 目录 */
  els.tocList.addEventListener('click', (e) => {
    const row = e.target.closest('.row[data-i]');
    if (!row) return;
    closeSheet();
    gotoChapter(Number(row.dataset.i));
    setChrome(false, false);
  });
  els.tocFilter.addEventListener(
    'input',
    debounce(() => renderTOC(els.tocFilter.value), 140)
  );

  /* 书签面板 */
  $('#btn-add-bookmark').addEventListener('click', addBookmark);
  els.marksList.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      await idbDelete('bookmarks', Number(del.dataset.del));
      S.marks = await loadMarks();
      renderMarks();
      toast('已删除书签');
      return;
    }
    const jump = e.target.closest('[data-jump]');
    if (!jump) return;
    const mark = S.marks.find((m) => String(m.id) === jump.dataset.jump);
    if (!mark) return;
    closeSheet();
    gotoChapter(mark.chapterIndex, { ratio: mark.ratio || 0 });
    setChrome(false, false);
  });

  /* 章末导航 */
  els.stream.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nav]');
    if (!btn) return;
    const nav = btn.dataset.nav;
    if (nav === 'prev') gotoChapter(S.index - 1);
    else if (nav === 'next') gotoChapter(S.index + 1);
    else openTOC();
  });

  /* 点击 / 拖动 */
  let px = 0;
  let py = 0;
  els.stage.addEventListener(
    'pointerdown',
    (e) => {
      px = e.clientX;
      py = e.clientY;
      S.dragged = false;
    },
    { passive: true }
  );
  els.stage.addEventListener(
    'pointermove',
    (e) => {
      if (Math.abs(e.clientX - px) > 9 || Math.abs(e.clientY - py) > 9) S.dragged = true;
    },
    { passive: true }
  );

  els.stage.addEventListener('click', (e) => {
    if (S.dragged || hasSelection()) return;
    if (e.target.closest('button, a')) return;
    const r = els.stage.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (S.mode === 'page' && x < 0.3) return turn(-1);
    if (S.mode === 'page' && x > 0.7) return turn(1);
    setChrome(els.reader.classList.contains('is-immersive'));
  });

  /* 滚动 */
  let scrollTick = 0;
  els.stage.addEventListener(
    'scroll',
    () => {
      if (!S.book) return;
      if (S.mode === 'page') {
        if (!S.pageW) return;
        const n = clamp(Math.round(els.stage.scrollLeft / S.pageW), 0, S.pages - 1);
        if (n !== S.page) {
          S.page = n;
          updateUI();
          showBadge();
        }
        snapToPage();
      }
      // 滚动模式的进度保存节流
      const now = Date.now();
      if (now - scrollTick > 400) {
        scrollTick = now;
        scheduleSave();
      }
    },
    { passive: true }
  );

  /* 窗口尺寸 / 旋转：只有分页模式需要重排 */
  const reflow = debounce(async () => {
    if (!S.book || S.mode !== 'page') return;
    const ratio = currentRatio();
    await nextFrame();
    paginate();
    setPage(Math.round(ratio * Math.max(0, S.pages - 1)));
  }, 220);
  window.addEventListener('resize', reflow);
  window.addEventListener('orientationchange', reflow);

  /* 键盘 */
  document.addEventListener('keydown', (e) => {
    if (!S.book || els.view.hidden) return;
    if (document.querySelector('.sheet:not([hidden])')) return;
    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
        e.preventDefault();
        turn(1);
        break;
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        turn(-1);
        break;
      case 'ArrowDown':
        if (S.mode === 'scroll') {
          e.preventDefault();
          els.stage.scrollBy({ top: 140, behavior: 'smooth' });
        }
        break;
      case 'ArrowUp':
        if (S.mode === 'scroll') {
          e.preventDefault();
          els.stage.scrollBy({ top: -140, behavior: 'smooth' });
        }
        break;
      case 'b':
        addBookmark();
        break;
    }
  });

  /* 设置变化 */
  onSettings((patch) => {
    if (!S.book) return;
    const layoutKeys = ['fontSize', 'leading', 'font', 'mode', 'indent', 'justify'];
    if (patch && !Object.keys(patch).some((k) => layoutKeys.includes(k))) return;
    const ratio = currentRatio();
    if (settings.mode !== S.mode) {
      setMode(settings.mode);
      renderChapter({ ratio });
    } else if (S.mode === 'page') {
      paginate();
      setPage(Math.round(ratio * Math.max(0, S.pages - 1)));
    } else {
      jumpScroll(ratio);
    }
  });

  setupSettingsPanel({
    onDeleteBook: async () => {
      if (!S.book) return;
      const id = S.book.id;
      const title = S.book.title;
      closeSheet();
      const ok = await confirmDialog({
        title: '删除本书',
        message: `从浏览器中删除《${title}》？阅读进度和书签也会一并清除。`,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      clearTimeout(S.saveTimer);
      await idbRemoveBook(id);
      S.book = null;
      location.hash = '#/';
      const { refreshShelf } = await import('./shelf.js');
      await refreshShelf();
      toast('已删除', { icon: 'i-check' });
    },
    onClearMarks: async () => {
      if (!S.book) return;
      const ok = await confirmDialog({
        title: '清除书签',
        message: `删除《${S.book.title}》的全部书签？`,
        confirmText: '清除',
        danger: true,
      });
      if (!ok) return;
      const list = await idbAllBy('bookmarks', 'bookId', S.book.id);
      await Promise.all(list.map((m) => idbDelete('bookmarks', m.id)));
      S.marks = [];
      renderMarks();
      toast('书签已清除', { icon: 'i-check' });
    },
  });

  /* 打开抽屉时让工具栏保持可见 */
  document.addEventListener('click', (e) => {
    if (e.target.closest('.tool, #btn-quick-bookmark, #btn-book-info')) setChrome(true, false);
  });
}

function openTOC() {
  els.tocFilter.value = '';
  renderTOC('');
  openSheet('sheet-toc');
  setChrome(true, false);
  setTimeout(scrollTOCtoCurrent, 380);
}

function openMarks() {
  renderMarks();
  openSheet('sheet-marks');
  setChrome(true, false);
}

function openSettings() {
  renderSettingsPanel({ showBook: true, bookTitle: S.book?.title || '' });
  openSheet('sheet-settings');
  setChrome(true, false);
}
