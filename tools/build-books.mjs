#!/usr/bin/env node
/**
 * 把 data/books/ 里的原始小说（GBK/GB18030 或 UTF-8 的 .txt）
 * 处理成前端可以直接读的压缩包，并生成书库清单。
 *
 *   node tools/build-books.mjs
 *
 * 做了四件事：
 *   1. 自动识别编码（UTF-8 / GB18030）并统一转成 UTF-8
 *   2. 切分章节、清掉每行缩进，正文里只留下段落
 *   3. gzip 压缩成 data/books/<id>.json.gz（前端用 DecompressionStream 解压）
 *   4. 写出 data/books.json（含章数、字数、压缩后体积）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitChapters, cleanInline, SHARD_SIZE } from '../assets/js/api.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'data/books');
const MANIFEST = resolve(ROOT, 'data/books.json');

/** 书目配置：想加书就先把它放进 data/books/，再在这里加一条 */
const BOOKS = [
  {
    file: '明朝那些事.txt',
    id: 'mingchao-naxieshi',
    title: '明朝那些事儿',
    author: '当年明月',
    tags: ['历史', '明史', '通俗史'],
    intro:
      '从 1344 年到 1644 年，三百年明史。以正史为骨、小说为笔，把皇帝、文臣、武将、太监写成一个个人，而不是一行行结论。',
  },
  {
    file: '凡人修仙传.txt',
    id: 'fanren-xiuxian-zhuan',
    title: '凡人修仙传',
    author: '忘语',
    tags: ['仙侠', '修真'],
    intro:
      '一个普通的山村穷小子，偶然下进入到当地江湖小门派，成了一名记名弟子。他依靠自身努力和算计，一步步走向修仙之路。',
  },
  {
    file: '官仙.txt',
    id: 'guanxian',
    title: '官仙',
    author: '陈风笑',
    tags: ['仙侠', '官场', '穿越'],
    intro:
      '罗天上仙陈太忠渡劫失败，魂穿到一个三年级小学生身上。曾经高高在上的仙人，如今要重新读书、考试、做人，也要重新学会在这个世界上活着。',
  },
];

/* ── 编码识别 ───────────────────────────────────────────── */

function decode(buffer) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buffer), encoding: 'utf-8 (BOM)' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('gb18030').decode(buffer), encoding: 'gb18030' };
  }
}

/** 去掉每行首尾空白与空行，正文只保留段落 */
function tidy(content) {
  return String(content)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** 清洗 + 丢掉空正文章节（分卷标记、重复标题） */
function prepare(chapters) {
  const cleaned = chapters.map((c) => ({
    title: cleanInline(c.title).replace(/\s+/g, ' ').trim(),
    content: tidy(cleanInline(c.content)),
  }));
  const withBody = cleaned.filter((c) => c.content.length > 0);
  return withBody.length ? withBody : cleaned;
}

/* ── 构建 ───────────────────────────────────────────────── */

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
const manifestBooks = [];
let failed = 0;

console.log(`\n墨读 · 构建书库   (data/books)\n${'═'.repeat(64)}`);

for (const cfg of BOOKS) {
  const src = resolve(DIR, cfg.file);
  const out = resolve(DIR, `${cfg.id}.json.gz`);

  let chapters = null;
  let sourceInfo = '';
  let sourceBytes = 0;

  if (existsSync(src)) {
    const buffer = readFileSync(src);
    const { text, encoding } = decode(buffer);
    chapters = prepare(splitChapters(text));
    sourceBytes = buffer.length;
    sourceInfo = `${cfg.file}  ${mb(buffer.length)}  编码 ${encoding}`;
  } else if (existsSync(out)) {
    // 源文件已经不在了（例如构建完就删掉了原始 txt）：
    // 就基于已有的压缩包重新清洗一遍，效果与从源文件构建一致。
    const prev = JSON.parse(gunzipSync(readFileSync(out)).toString('utf8'));
    chapters = prepare(prev.chapters || []);
    sourceInfo = `${cfg.id}.json.gz（原始 txt 已不在，基于现有压缩包重新清洗）`;
  }

  if (!chapters || !chapters.length) {
    console.log(`\n✗ 跳过《${cfg.title}》：既没有 ${cfg.file}，也没有可用的 ${cfg.id}.json.gz`);
    failed++;
    continue;
  }

  const t0 = Date.now();
  const tSplit = Date.now();

  let words = 0;
  for (const c of chapters) words += c.content.replace(/\s/g, '').length;

  const payload = {
    v: 1,
    title: cfg.title,
    author: cfg.author,
    intro: cfg.intro,
    words,
    chapters,
  };

  const gz = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
  writeFileSync(out, gz);
  const tGzip = Date.now();

  const ratio = sourceBytes ? `（原始 txt 的 ${((gz.length / sourceBytes) * 100).toFixed(1)}%）` : '';
  console.log(`\n《${cfg.title}》  ${cfg.author}`);
  console.log(`  来源      ${sourceInfo}`);
  console.log(`  正文      ${chapters.length.toLocaleString()} 章 · ${words.toLocaleString()} 字`);
  console.log(`  首章      ${JSON.stringify(chapters[0]?.title || '')}`);
  console.log(`  末章      ${JSON.stringify(chapters.at(-1)?.title || '')}`);
  console.log(`  输出      ${cfg.id}.json.gz  ${mb(gz.length)} ${ratio}`);
  console.log(`  分片      ${Math.ceil(chapters.length / SHARD_SIZE)} 片 × ${SHARD_SIZE} 章`);
  console.log(`  耗时      切章 ${tSplit - t0}ms · 压缩 ${tGzip - tSplit}ms`);

  manifestBooks.push({
    id: cfg.id,
    title: cfg.title,
    author: cfg.author,
    intro: cfg.intro,
    tags: cfg.tags,
    format: 'json',
    compress: 'gzip',
    url: `data/books/${cfg.id}.json.gz`,
    words,
    chapterCount: chapters.length,
    size: gz.length,
  });
}

if (manifestBooks.length) {
  writeFileSync(
    MANIFEST,
    `${JSON.stringify(
      {
        name: '墨读 · 书库',
        updatedAt: new Date().toISOString().slice(0, 10),
        books: manifestBooks,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  const totalRaw = manifestBooks.reduce((s, b) => s + b.size, 0);
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`已写出 data/books.json —— ${manifestBooks.length} 本书，压缩后共 ${mb(totalRaw)}`);
}

process.exit(failed && !manifestBooks.length ? 1 : 0);
