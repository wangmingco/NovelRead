/* ═══════════════════════════════════════════════════════════
   settings-panel.js  阅读设置面板（书架与阅读器共用）
   ═══════════════════════════════════════════════════════════ */

import { $, clamp } from './util.js';
import { settings, setSettings, THEMES, FONTS, LEADINGS, FONT_SIZE } from './store.js';

const ctx = { onDeleteBook: null, onClearMarks: null };

export function setupSettingsPanel(context) {
  Object.assign(ctx, context);
}

function segHTML(name, items) {
  return `<div class="seg" data-seg="${name}">${items
    .map((it) => `<button data-val="${it.id}" type="button">${it.name}</button>`)
    .join('')}</div>`;
}

export function renderSettingsPanel({ showBook = false, bookTitle = '' } = {}) {
  const body = $('#settings-body');
  if (!body) return;

  body.innerHTML = `
    <div class="set-group">
      <div class="set-label">字号<b id="set-fs-label">${settings.fontSize} px</b></div>
      <div class="stepper">
        <button data-act="fs-down" type="button" aria-label="缩小字号"><svg class="icon"><use href="#i-minus"/></svg></button>
        <div class="stepper-preview" id="set-preview" style="font-size:${settings.fontSize}px">
          字里行间<small>风过纸页 · ${settings.fontSize}px</small>
        </div>
        <button data-act="fs-up" type="button" aria-label="放大字号"><svg class="icon"><use href="#i-plus"/></svg></button>
      </div>
    </div>

    <div class="set-group">
      <div class="set-label">行距</div>
      <div class="set-row">${segHTML('leading', LEADINGS)}</div>
    </div>

    <div class="set-group">
      <div class="set-label">字体</div>
      <div class="set-row">${segHTML('font', FONTS)}</div>
    </div>

    <div class="set-group">
      <div class="set-label">背景</div>
      <div class="themes">
        ${THEMES.map(
          (t) => `<button class="theme-dot" type="button" data-theme-name="${t.id}" data-val="${t.id}"><i></i>${t.name}</button>`
        ).join('')}
      </div>
    </div>

    <div class="set-group">
      <div class="set-label">翻页方式</div>
      <div class="set-row">
        <div class="seg" data-seg="mode">
          <button type="button" data-val="scroll">上下滚动</button>
          <button type="button" data-val="page">左右翻页</button>
        </div>
      </div>
    </div>

    <div class="set-group">
      <div class="switch-row"><span>段首缩进</span><button class="switch" type="button" data-toggle="indent" role="switch"><i></i></button></div>
      <div class="switch-row"><span>两端对齐</span><button class="switch" type="button" data-toggle="justify" role="switch"><i></i></button></div>
    </div>

    ${
      showBook
        ? `<div class="set-group">
      <div class="set-label">本书</div>
      <div class="set-danger">
        <button class="btn" type="button" data-act="clear-marks"><svg class="icon"><use href="#i-bookmark"/></svg>清除书签</button>
        <button class="btn" type="button" data-act="delete-book"><svg class="icon"><use href="#i-trash"/></svg>删除本书</button>
      </div>
      <p class="set-note">「${bookTitle}」的正文、进度与书签都只存在这台设备上，删除后需要重新下载。</p>
    </div>`
        : ''
    }

    <p class="set-note">阅读进度、书签与已下载的正文都保存在本机浏览器中，不会上传到任何服务器。</p>
  `;

  sync();
  wire();
  return body;
}

function sync() {
  const body = $('#settings-body');
  if (!body) return;

  body.querySelectorAll('[data-seg]').forEach((seg) => {
    const key = seg.dataset.seg;
    seg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('is-active', settings[key] === b.dataset.val);
    });
  });

  body.querySelectorAll('.theme-dot').forEach((d) => {
    const on = settings.theme === d.dataset.val;
    d.classList.toggle('is-active', on);
    d.setAttribute('aria-pressed', String(on));
  });

  body.querySelectorAll('[data-toggle]').forEach((sw) => {
    const on = !!settings[sw.dataset.toggle];
    sw.classList.toggle('is-on', on);
    sw.setAttribute('aria-checked', String(on));
  });

  const label = body.querySelector('#set-fs-label');
  const preview = body.querySelector('#set-preview');
  if (label) label.textContent = `${settings.fontSize} px`;
  if (preview) {
    preview.style.fontSize = `${settings.fontSize}px`;
    const small = preview.querySelector('small');
    if (small) small.textContent = `风过纸页 · ${settings.fontSize}px`;
  }
  body.querySelector('[data-act="fs-down"]')?.toggleAttribute('disabled', settings.fontSize <= FONT_SIZE.min);
  body.querySelector('[data-act="fs-up"]')?.toggleAttribute('disabled', settings.fontSize >= FONT_SIZE.max);
}

let wired = false;

function wire() {
  const body = $('#settings-body');
  if (!body || wired) {
    sync();
    return;
  }
  wired = true;

  body.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.dataset.seg) {
      const key = btn.dataset.seg;
      const value = btn.dataset.val;
      if (key === 'mode' && settings.mode !== value) {
        setSettings({ mode: value });
      } else if (key === 'leading') {
        setSettings({ leading: value });
      } else if (key === 'font') {
        setSettings({ font: value });
      }
      sync();
      return;
    }

    if (btn.dataset.themeName) {
      setSettings({ theme: btn.dataset.val });
      sync();
      return;
    }

    if (btn.dataset.toggle) {
      const key = btn.dataset.toggle;
      setSettings({ [key]: !settings[key] });
      sync();
      return;
    }

    switch (btn.dataset.act) {
      case 'fs-down':
        setSettings({ fontSize: clamp(settings.fontSize - FONT_SIZE.step, FONT_SIZE.min, FONT_SIZE.max) });
        sync();
        break;
      case 'fs-up':
        setSettings({ fontSize: clamp(settings.fontSize + FONT_SIZE.step, FONT_SIZE.min, FONT_SIZE.max) });
        sync();
        break;
      case 'clear-marks':
        await ctx.onClearMarks?.();
        break;
      case 'delete-book':
        await ctx.onDeleteBook?.();
        break;
    }
  });
}
