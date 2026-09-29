/* ═══════════════════════════════════════════════════════════
   api.js  书库清单 + 小说下载 + 解压缩 + 章节解析
   ───────────────────────────────────────────────────────────
   清单格式 data/books.json：
   { "books": [ { id, title, author, intro, tags, format, url, compress } ] }

   正文格式：
     · txt / json              纯文本或 JSON
     · compress: "gzip"        由 tools/build-books.mjs 生成，前端用
                               DecompressionStream 解压
   压缩包一律是 UTF-8，源文件的 GBK/GB18030 在构建时已转换。
   ═══════════════════════════════════════════════════════════ */

import { safeJson, nextFrame } from './util.js';

export const MANIFEST_URL = 'data/books.json';

/** 章节在浏览器里的分片大小：一次只解压/载入这么多章 */
export const SHARD_SIZE = 40;

/* ── 章节标题识别 ───────────────────────────────────────── */
const NUM = '[0-9零〇一二三四五六七八九十百千万两]{1,8}';
const SEP = '\\s*[·、.．:：\\-—－]?\\s*';
// 回/部/集 加负向先行，避免把「第一回合…」「第三部分…」误判成章节
const UNIT = '(?:章|节|回(?!合)|卷|篇|集(?!合)|部(?!分)|幕|折)';
const FRONT = '序章|序言|序|楔子|引子|前言|后记|尾声|终章|尾章|结局|番外|外传|附录|自序|代序';

const HEAD_PATTERNS = [
  // 第一章 / 第十二回 / 卷三
  new RegExp(`^第\\s*${NUM}\\s*${UNIT}(?:${SEP}.{0,30})?$`),
  // 卷三 少年时（卷 + 数字）
  new RegExp(`^卷\\s*${NUM}(?:[ \\u3000].{0,30})?$`),
  // 序 / 楔子 / 引子 / 尾声 / 番外……
  new RegExp(`^(?:${FRONT})(?:${SEP}.{0,30})?$`),
  // Chapter 12 / Part 3
  /^Chapter\s*\d{1,4}(?:\s*[·、.．:：\-—－]?\s*.{0,30})?$/i,
  /^Part\s*\d{1,3}(?:\s*[·、.．:：\-—－]?\s*.{0,30})?$/i,
  // 分卷名 + 第X章（例如「洪武大帝 第一章 童年」）
  new RegExp(`^\\S{2,10}[ \\u3000]+第\\s*${NUM}\\s*${UNIT}(?:${SEP}.{0,30})?$`),
  // 分卷名 + 引子 / 楔子 / 尾声……
  new RegExp(`^\\S{2,10}[ \\u3000]+(?:${FRONT})$`),
];

const MAX_HEAD_LEN = 36;
const FALLBACK_CHUNK = 2600;

/** 卷首里的盗版声明等样板文字，直接丢掉 */
const BOILERPLATE = /声明|声明[:：]|www\.|https?:|仅供|版权归|请支持正版|全集|作者[:：]|书友群|最新章节|全集下载/i;

/**
 * 判断一行是否是章节标题。
 * 先按长度快速排除（正文段落通常很长），再用句读排除（标题里不会出现句号）。
 */
export function isHeading(line) {
  const t = line.trim();
  if (!t || t.length > MAX_HEAD_LEN) return false;
  if (/[。；！？!?…]/.test(t)) return false;
  for (const re of HEAD_PATTERNS) if (re.test(t)) return true;
  return false;
}

/* ── 纯文本 → 章节数组 ──────────────────────────────────── */

function normalizeText(raw) {
  return String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** 清掉正文里混进来的 HTML（盗版站常塞广告脚本和 <br>） */
export function cleanInline(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|center|font|span|strong|b|em|i|u|h[1-6])[^>]*>/gi, '\n')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,6});/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]{1,5});/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, '&');
}

/** 按句子边界把过长的文本切成若干片 */
function sliceLong(text, size) {
  const out = [];
  let rest = text.trim();
  const marks = ['。', '！', '？', '…', '」', '．', '.', '!', '?', '\n'];
  while (rest.length > size) {
    let cut = -1;
    for (const m of marks) {
      const i = rest.lastIndexOf(m, size);
      if (i > cut) cut = i;
    }
    if (cut < size * 0.5) cut = size - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function splitByLength(text) {
  const paras = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let buf = [];
  let size = 0;
  const flush = () => {
    if (buf.length) chunks.push(buf.join('\n\n'));
    buf = [];
    size = 0;
  };

  for (const p of paras) {
    if (p.length >= FALLBACK_CHUNK) {
      flush();
      chunks.push(...sliceLong(p, FALLBACK_CHUNK));
      continue;
    }
    buf.push(p);
    size += p.length;
    if (size >= FALLBACK_CHUNK) flush();
  }
  flush();

  return chunks.map((content, i) => ({ title: `第 ${i + 1} 节`, content }));
}

/** 卷首那一段是不是可以丢掉的样板文字 */
function isBoilerplate(text) {
  const t = text.trim();
  if (!t) return true;
  if (BOILERPLATE.test(t)) return true;
  // 太短、又几乎没有句子 → 不是正经序言
  const ends = (t.match(/[。！？]/g) || []).length;
  return t.length < 400 && ends <= 2;
}

export function splitChapters(raw) {
  const text = normalizeText(raw);
  const lines = text.split('\n');
  const chapters = [];
  let current = null;

  for (const line of lines) {
    if (isHeading(line)) {
      current = { title: line.trim(), lines: [] };
      chapters.push(current);
    } else {
      if (!current) {
        current = { title: '', lines: [] };
        chapters.push(current);
      }
      current.lines.push(line);
    }
  }

  const out = chapters
    .map((c) => ({
      title: cleanInline(c.title).replace(/\s+/g, ' ').trim(),
      content: cleanInline(c.lines.join('\n')).trim(),
    }))
    .filter((c) => c.title || c.content.length > 0);

  // 标题前的零碎内容：样板文字直接丢，其余留作「卷首」
  const first = out[0];
  if (first && !first.title) {
    if (isBoilerplate(first.content)) out.shift();
    else first.title = '卷首';
  }

  // 丢掉「有标题但没正文」的：多半是分卷标记、重复标题
  const withBody = out.filter((c) => c.content.length > 0);
  const list = withBody.length ? withBody : out;

  const realHeads = list.filter((c) => c.title).length;
  if (realHeads < 2) return splitByLength(cleanInline(text));
  return list.map((c) => ({ title: c.title || '正文', content: c.content }));
}

/* ── 解析为书籍记录 ─────────────────────────────────────── */

function normalizeChapters(list) {
  const out = [];
  for (const raw of list) {
    if (raw == null) continue;
    if (typeof raw === 'string') {
      out.push({ title: `第 ${out.length + 1} 章`, content: cleanInline(raw).trim() });
      continue;
    }
    const title = cleanInline(String(raw.title ?? raw.name ?? raw.chapterName ?? `第 ${out.length + 1} 章`))
      .replace(/\s+/g, ' ')
      .trim();
    let content = raw.content ?? raw.text ?? raw.body ?? raw.paragraphs ?? '';
    if (Array.isArray(content)) content = content.join('\n\n');
    content = cleanInline(String(content).replace(/\r\n?/g, '\n')).trim();
    if (!title && !content) continue;
    out.push({ title: title || `第 ${out.length + 1} 章`, content });
  }
  return out;
}

/**
 * @param {string} text  解压后的正文（UTF-8）
 * @param {object} item  清单条目
 * @returns {{meta: object, chapters: {title: string, content: string}[]}}
 */
export function parseBook(text, item = {}) {
  const trimmed = normalizeText(text);
  let data = null;
  const looksJson = /^[\s\uFEFF]*[{[]/.test(trimmed);

  if (item.format === 'json' || (!item.format && looksJson)) {
    data = safeJson(trimmed);
  }

  let chapters = [];
  let title = item.title || '';
  let author = item.author || '';
  let intro = item.intro || '';

  if (data) {
    const src = Array.isArray(data) ? data : data.chapters || data.list || data.sections || [];
    chapters = normalizeChapters(src);
    title = item.title || data.title || data.name || title;
    author = item.author || data.author || data.writer || author;
    intro = item.intro || data.intro || data.description || data.summary || intro;
  } else {
    chapters = splitChapters(trimmed);
  }

  if (!chapters.length) chapters = splitByLength(trimmed);

  // 有标题却没正文的（分卷标记等）直接丢掉
  const withBody = chapters.filter((c) => c.content.length > 0);
  if (withBody.length) chapters = withBody;

  // 构建好的 .json.gz 里已经带上了字数，省掉一次全量扫描
  let words = Number(data?.words) || 0;
  if (!words) {
    for (const c of chapters) words += c.content.replace(/\s/g, '').length;
  }

  return {
    meta: {
      id: item.id || `book-${Date.now()}`,
      title: title || '未命名',
      author: author || '佚名',
      intro: intro ? String(intro).trim() : '',
      tags: Array.isArray(item.tags) ? item.tags : [],
      cover: item.cover || null,
      url: item.url || '',
      compress: item.compress || '',
      format: data ? 'json' : 'txt',
      chapterCount: chapters.length,
      words,
      shardSize: SHARD_SIZE,
      downloadedAt: Date.now(),
    },
    chapters,
  };
}

/* ── 解压 ───────────────────────────────────────────────── */

/** gzip 魔数 */
const isGzip = (b) => b[0] === 0x1f && b[1] === 0x8b;
const isZip = (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

function pipeThrough(bytes, format) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('这个浏览器不支持流式解压，请升级后重试');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Response(stream).text();
}

export function gunzip(bytes) {
  return pipeThrough(bytes, 'gzip');
}

/** 极简 zip 读取：挑出体积最大的文本文件解出来（无需任何第三方库） */
export async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o) => view.getUint32(o, true);
  const u16 = (o) => view.getUint16(o, true);

  // End of central directory
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');

  const count = u16(eocd + 10);
  let off = u32(eocd + 16);
  let best = null;

  for (let n = 0; n < count; n++) {
    if (u32(off) !== 0x02014b50) break;
    const method = u16(off + 10);
    const compSize = u32(off + 20);
    const size = u32(off + 24);
    const nameLen = u16(off + 28);
    const extraLen = u16(off + 30);
    const commentLen = u16(off + 32);
    const localOff = u32(off + 42);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(off + 46, off + 46 + nameLen));
    if (!name.endsWith('/') && /\.(txt|json|md)$/i.test(name) && (!best || size > best.size)) {
      best = { name, method, compSize, size, localOff };
    }
    off += 46 + nameLen + extraLen + commentLen;
  }

  if (!best) throw new Error('zip 里没有找到文本文件');

  const lo = best.localOff;
  if (u32(lo) !== 0x04034b50) throw new Error('zip 数据结构损坏');
  const dataStart = lo + 30 + u16(lo + 26) + u16(lo + 28);
  const data = bytes.subarray(dataStart, dataStart + best.compSize);

  if (best.method === 0) return new TextDecoder('utf-8').decode(data);
  if (best.method !== 8) throw new Error(`zip 用了不支持的压缩方式（${best.method}）`);
  return pipeThrough(data, 'deflate-raw');
}

/**
 * 把拿到的字节变成正文文本。
 * 依次识别 gzip / zip；如果服务器已经帮我们解过压（Content-Encoding），
 * 拿到的就是纯文本，直接按 UTF-8 解码。
 */
export async function bytesToText(bytes) {
  if (isGzip(bytes)) return gunzip(bytes);
  if (isZip(bytes)) return unzip(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

/* ── 下载 ───────────────────────────────────────────────── */

/**
 * @param {string} url
 * @param {(info: {ratio: number, received: number, total: number}) => void} [onProgress]
 * @returns {Promise<Uint8Array>} 原始字节（可能还是压缩状态）
 */
export async function fetchBytes(url, onProgress) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);

  const total = Number(res.headers.get('content-length')) || 0;

  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.({ ratio: 1, received: buf.length, total: buf.length });
    return buf;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const ratio = total ? received / total : Math.min(0.95, received / (received + 1_500_000));
    onProgress?.({
      // 服务器可能已经帮我们解过压（Content-Encoding），这时 content-length 偏小
      ratio: Math.min(1, ratio),
      received,
      total: total || received,
    });
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  onProgress?.({ ratio: 1, received, total: total || received });
  return out;
}

/**
 * 清单里的 url 是相对「站点根目录」写的（例如 data/books/xxx.json.gz）。
 * 关键：不能拿清单文件自身的地址当 base —— 否则 /data/books.json 会被当成目录，
 * 解析出 /data/data/books/xxx.json.gz 这种 404 地址。
 */
export function resolveBookUrl(item, manifestUrl = MANIFEST_URL) {
  const raw = String(item.url || '');
  const out = [];
  const push = (u) => {
    if (u && !out.includes(u)) out.push(u);
  };

  // 1) 相对站点根目录（本项目的约定）
  try {
    push(new URL(raw, document.baseURI).href);
  } catch {
    /* ignore */
  }
  // 2) 兼容「相对清单文件」的写法
  try {
    const manifestHref = new URL(manifestUrl, document.baseURI).href;
    push(new URL(raw, new URL('./', manifestHref)).href);
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * 下载并解析一本书。
 * @param {object} item 清单条目
 * @param {(info: {ratio: number, label: string}) => void} [onProgress]
 * @returns {Promise<{meta: object, chapters: {title: string, content: string}[]}>}
 */
export async function downloadBook(item, onProgress) {
  const urls = resolveBookUrl(item);
  if (!urls.length) throw new Error('这本书没有配置下载地址');

  let bytes = null;
  let lastError = null;
  for (const url of urls) {
    try {
      bytes = await fetchBytes(url, ({ ratio }) => onProgress?.({ ratio, label: '下载中' }));
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!bytes) throw lastError || new Error('下载失败');

  const compressed = isGzip(bytes) || isZip(bytes);
  if (compressed) {
    onProgress?.({ ratio: 1, label: '解压中' });
    await nextFrame();
  }

  const text = await bytesToText(bytes);

  onProgress?.({ ratio: 1, label: '解析章节' });
  await nextFrame();

  const book = parseBook(text, item);
  if (!book.chapters.length) throw new Error('这个文件里没有找到任何正文');
  return book;
}

/* ── 清单 ───────────────────────────────────────────────── */

export function normalizeManifest(raw) {
  const books = Array.isArray(raw) ? raw : raw?.books || raw?.list || [];
  return books
    .filter((b) => b && b.id && b.url !== undefined)
    .map((b) => ({
      id: String(b.id),
      title: String(b.title || b.name || '未命名'),
      author: String(b.author || b.writer || '佚名'),
      intro: String(b.intro || b.description || '').trim(),
      tags: Array.isArray(b.tags) ? b.tags.map(String) : [],
      cover: b.cover || null,
      format: b.format || '',
      compress: b.compress || '',
      url: b.url || `data/books/${b.id}.json`,
      words: Number(b.words) || 0,
      chapterCount: Number(b.chapterCount) || 0,
      size: Number(b.size) || 0,
    }));
}

export async function loadManifest(url = MANIFEST_URL) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`无法读取书库清单（HTTP ${res.status}）`);
  const raw = await res.json();
  return { books: normalizeManifest(raw), updatedAt: String(raw.updatedAt || '') };
}
