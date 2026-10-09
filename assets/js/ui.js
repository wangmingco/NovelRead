/* ═══════════════════════════════════════════════════════════
   ui.js  提示条 / 抽屉 / 封面 / 确认框
   ═══════════════════════════════════════════════════════════ */

import { $, $$, escapeHtml, hash, clamp } from './util.js';

/* ── 提示条 ─────────────────────────────────────────────── */
const toastRoot = $('#toast-root');

export function toast(message, { icon = '', duration = 2400 } = {}) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.innerHTML = `${icon ? `<svg class="icon"><use href="#${icon}"/></svg>` : ''}<span>${escapeHtml(message)}</span>`;
  toastRoot.appendChild(node);
  setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 260);
  }, duration);
  return node;
}

/* ── 抽屉 ───────────────────────────────────────────────── */
const backdrop = $('#backdrop');
let openEl = null;
let closing = false;

export function openSheet(target) {
  const sheet = typeof target === 'string' ? document.getElementById(target) : target;
  if (!sheet || sheet === openEl) return sheet;

  if (openEl) {
    const prev = openEl;
    prev.classList.remove('is-open');
    openEl = null;
    setTimeout(() => {
      if (prev !== openEl) prev.hidden = true;
    }, 360);
  }

  openEl = sheet;
  closing = false;
  sheet.hidden = false;
  backdrop.hidden = false;
  // 强制回流，保证过渡动画生效
  void sheet.offsetHeight;
  requestAnimationFrame(() => {
    backdrop.classList.add('is-open');
    sheet.classList.add('is-open');
  });
  return sheet;
}

export function closeSheet() {
  if (!openEl || closing) return;
  const sheet = openEl;
  openEl = null;
  closing = true;
  sheet.classList.remove('is-open');
  backdrop.classList.remove('is-open');
  setTimeout(() => {
    // 关闭动画期间可能又打开了别的抽屉：别把新抽屉的背景一起收掉
    if (openEl !== sheet) sheet.hidden = true;
    if (!openEl) backdrop.hidden = true;
    closing = false;
  }, 380);
}

backdrop?.addEventListener('click', closeSheet);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});

$$('.sheet').forEach((sheet) => {
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) closeSheet();
  });
  sheet.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', closeSheet));

  // 顶部下拉关闭
  const handle = sheet.querySelector('.sheet-head, .grab');
  const panel = sheet.querySelector('.sheet-panel');
  if (!handle || !panel) return;
  let startY = 0;
  let dy = 0;
  let dragging = false;

  handle.addEventListener(
    'touchstart',
    (e) => {
      startY = e.touches[0].clientY;
      dy = 0;
      dragging = true;
      panel.style.transition = 'none';
    },
    { passive: true }
  );
  handle.addEventListener(
    'touchmove',
    (e) => {
      if (!dragging) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      panel.style.transform = `translateY(${dy}px)`;
    },
    { passive: true }
  );
  handle.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = '';
    panel.style.transform = '';
    if (dy > 88) closeSheet();
  });
});

/* ── 确认框 ─────────────────────────────────────────────── */
export function confirmDialog({ title = '确认', message = '', confirmText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const sheet = document.createElement('section');
    sheet.className = 'sheet';
    sheet.hidden = true;
    sheet.innerHTML = `
      <div class="sheet-panel">
        <div class="grab"></div>
        <header class="sheet-head"><h3>${escapeHtml(title)}</h3><span class="sheet-sub"></span></header>
        <div class="sheet-body">
          <p class="book-intro" style="padding-top:14px">${escapeHtml(message)}</p>
        </div>
        <div class="set-danger" style="padding-bottom:14px">
          <button class="btn" data-act="cancel">${escapeHtml(cancelText)}</button>
          <button class="btn btn--primary" data-act="ok" ${danger ? 'style="background:var(--accent)"' : ''}>${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(sheet);

    const finish = (value) => {
      resolve(value);
      setTimeout(() => sheet.remove(), 200);
    };
    sheet.querySelector('[data-act="ok"]').addEventListener('click', () => {
      closeSheet();
      finish(true);
    });
    sheet.querySelector('[data-act="cancel"]').addEventListener('click', () => {
      closeSheet();
      finish(false);
    });
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet) {
        closeSheet();
        finish(false);
      }
    });
    openSheet(sheet);
  });
}

/* ── 封面配色与标记 ─────────────────────────────────────── */
const PALETTES = [
  { c1: '#3b5a6b', c2: '#27404f', c3: '#1b2c36', fg: '#e9eef0' },
  { c1: '#8c4a2f', c2: '#6a3620', c3: '#462315', fg: '#f6e7d8' },
  { c1: '#4c6b52', c2: '#334b39', c3: '#223426', fg: '#e7eee2' },
  { c1: '#6b4a52', c2: '#4d3339', c3: '#332126', fg: '#f0e2e6' },
  { c1: '#3a4f7a', c2: '#28375a', c3: '#1a2540', fg: '#e2e8f5' },
  { c1: '#7a6244', c2: '#584431', c3: '#3a2c20', fg: '#f3ead9' },
  { c1: '#3d6a70', c2: '#2a4b50', c3: '#1c3336', fg: '#ddecee' },
  { c1: '#8a5a3a', c2: '#65402a', c3: '#43291b', fg: '#f7ead9' },
  { c1: '#556066', c2: '#3a3d42', c3: '#24262a', fg: '#eaeaeb' },
  { c1: '#8a7a3a', c2: '#63582a', c3: '#423c1c', fg: '#f5efdc' },
  { c1: '#5c4a72', c2: '#413253', c3: '#2b2138', fg: '#eee6f6' },
  { c1: '#7a3f4a', c2: '#582b34', c3: '#3b1d24', fg: '#f8e3e6' },
];

export function paletteFor(id) {
  return PALETTES[hash(id) % PALETTES.length];
}

function sealChar(title) {
  const clean = String(title || '书').replace(/[《》〈〉\s·,.，。]/g, '');
  return clean.charAt(0) || '书';
}

/**
 * @param {object} book
 * @param {object} [opts] { progress: 0-100, overlay: html, badge: html, compact }
 */
export function coverMarkup(book, opts = {}) {
  const p = paletteFor(book.id || book.title);
  const { progress = null, overlay = '', badge = '' } = opts;
  return `<div class="cover" style="--c1:${p.c1};--c2:${p.c2};--c3:${p.c3};--c-fg:${p.fg}">
    <span class="cover-frame"></span>
    <div class="cover-text">
      <span class="cover-title">${escapeHtml(book.title)}</span>
      ${book.author ? `<span class="cover-author">${escapeHtml(book.author)}</span>` : ''}
    </div>
    <span class="cover-seal">${escapeHtml(sealChar(book.title))}</span>
    ${progress != null && progress > 0 ? `<span class="cover-progress"><i style="width:${clamp(progress, 0, 100)}%"></i></span>` : ''}
    ${badge}
    ${overlay}
  </div>`;
}

/** 全书进度：0 - 100 */
export function bookPercent(progress, chapterCount) {
  if (!progress || !chapterCount) return 0;
  const inChapter = clamp(Number(progress.ratio) || 0, 0, 1);
  const done = (Number(progress.chapterIndex) || 0) + inChapter;
  return clamp((done / chapterCount) * 100, 0, 100);
}

export function percentLabel(p) {
  if (p <= 0) return '未读';
  if (p >= 99.5) return '已读完';
  return `${p < 1 ? p.toFixed(1) : Math.round(p)}%`;
}
