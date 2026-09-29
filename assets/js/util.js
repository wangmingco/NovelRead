/* ═══════════════════════════════════════════════════════════
   util.js  通用小工具
   ═══════════════════════════════════════════════════════════ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function on(el, type, fn, opts) {
  el.addEventListener(type, fn, opts);
  return () => el.removeEventListener(type, fn, opts);
}

export function debounce(fn, wait = 200) {
  let t = 0;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

export function clamp(n, min, max) {
  return n < min ? min : n > max ? max : n;
}

export function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

export const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** FNV-1a，用于稳定地给每本书分配配色 */
export function hash(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function formatWords(n) {
  if (!n) return '—';
  if (n < 10000) return `${Math.round(n / 100) / 10}千字`.replace('.0', '');
  return `${(n / 10000).toFixed(1)}万字`;
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 2 * 86_400_000) return '昨天';
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function clockText(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function isTouchDevice() {
  return (
    (typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches) ||
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0
  );
}

/** 元素是否处于「正在滚动/拖拽」状态 */
export function hasSelection() {
  const s = window.getSelection?.();
  return !!s && s.toString().trim().length > 0;
}

export function vibrate(ms = 8) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* noop */
  }
}

export function safeJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
