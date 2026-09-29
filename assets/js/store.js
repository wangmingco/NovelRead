/* ═══════════════════════════════════════════════════════════
   store.js  阅读设置（localStorage，读取即生效，避免闪烁）
   ═══════════════════════════════════════════════════════════ */

import { isTouchDevice, clamp } from './util.js';

const KEY = 'inkread.settings.v1';

export const THEMES = [
  { id: 'paper', name: '纸' },
  { id: 'green', name: '护眼' },
  { id: 'night', name: '夜' },
  { id: 'ink', name: '纯黑' },
];

export const FONTS = [
  { id: 'song', name: '宋体', css: 'var(--font-song)' },
  { id: 'hei', name: '黑体', css: 'var(--font-ui)' },
  { id: 'kai', name: '楷体', css: 'var(--font-kai)' },
];

export const LEADINGS = [
  { id: 'tight', name: '紧凑', value: 1.55 },
  { id: 'normal', name: '适中', value: 1.85 },
  { id: 'loose', name: '宽松', value: 2.25 },
];

export const FONT_SIZE = { min: 14, max: 28, step: 1 };

const THEME_COLORS = {
  paper: '#f1e9dc',
  green: '#cdddc4',
  night: '#131315',
  ink: '#000000',
};

function defaults() {
  return {
    theme: 'paper',
    font: 'song',
    fontSize: 18,
    leading: 'normal',
    mode: isTouchDevice() ? 'page' : 'scroll',
    indent: true,
    justify: true,
  };
}

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    return { ...defaults(), ...JSON.parse(raw) };
  } catch {
    return defaults();
  }
}

export const settings = read();

const bus = new EventTarget();

export function onSettings(fn) {
  bus.addEventListener('change', (e) => fn(e.detail));
}

export function leadingValue() {
  return (LEADINGS.find((l) => l.id === settings.leading) || LEADINGS[1]).value;
}

export function fontFamily() {
  return (FONTS.find((f) => f.id === settings.font) || FONTS[0]).css;
}

/** 把设置写成 CSS 变量，全局即时生效 */
export function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.style.setProperty('--read-size', `${clamp(settings.fontSize, FONT_SIZE.min, FONT_SIZE.max)}px`);
  root.style.setProperty('--read-leading', String(leadingValue()));
  root.style.setProperty('--read-family', fontFamily());
  root.style.setProperty('--read-indent', settings.indent ? '2' : '0');
  root.style.setProperty('--read-align', settings.justify ? 'justify' : 'left');

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[settings.theme] || THEME_COLORS.paper);
}

export function setSettings(patch, { silent = false } = {}) {
  Object.assign(settings, patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* 隐私模式下可能写不进去，忽略 */
  }
  applySettings();
  if (!silent) bus.dispatchEvent(new CustomEvent('change', { detail: patch }));
}

export function resetSettings() {
  const d = defaults();
  d.theme = settings.theme;
  d.mode = settings.mode;
  setSettings(d);
}
