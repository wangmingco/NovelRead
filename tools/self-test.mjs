#!/usr/bin/env node
/**
 * 自检：验证清单、压缩包、章节解析与标题识别。
 * 用法： node tools/self-test.mjs
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeManifest, parseBook, splitChapters, isHeading, SHARD_SIZE } from '../assets/js/api.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const failures = [];
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '[ok]  ' : '[FAIL]'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!cond) {
    failed++;
    failures.push(label);
  }
};

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

/* ── 1. 标题识别规则 ───────────────────────────────────── */
console.log('\n标题识别');
const shouldMatch = [
  '第一章 山边小村',
  '第一章山边小村',
  '第1章超强作弊高手',
  '第574章性格（大结局）',
  '第两千四百四十六章飞升仙界(大结局)',
  '第十一卷真仙降临第两千四百四十六章飞升仙界',
  '楔子那一场风花雪月的穿越',
  '引子史上最倒霉穿越者',
  '洪武大帝 引子',
  '洪武大帝 第一章 童年',
  '大结局 第二十一章 结束了',
  'Chapter 12 The End',
  '尾声',
  '番外 · 十年后',
  '卷一 少年时',
];
const shouldNotMatch = [
  '    第一回合就此结束。杨廷和先生胜出',
  '第二回合，嘉靖胜',
  '这已经是他第三次回到这里了。',
  '第一章的内容我们已经讲完了。',
  '他第一章就读不下去了',
  '这是一个很长很长的句子，长到不可能是一个章节标题，因为它超过了三十六个字符。',
];
shouldMatch.forEach((s) => ok(isHeading(s), `识别为标题: ${JSON.stringify(s.slice(0, 30))}`));
shouldNotMatch.forEach((s) => ok(!isHeading(s), `不识别: ${JSON.stringify(s.slice(0, 26))}`));

/* ── 2. 纯文本切章 + 兜底 ───────────────────────────────── */
console.log('\n纯文本切分');
const sample = `书名\n\n作者：某人\n\n声明:本书由某某网收集整理,仅供交流学习使用,请支持正版!\n\n第一章 起风\n\n正文一。\n\n正文二。\n\n第二章 落雨\n\n正文三。\n\n第三章 天晴\n\n正文四。`;
const sc = splitChapters(sample);
ok(sc.length === 3, `切出 ${sc.length} 章（盗版声明卷首已丢弃）`);
ok(sc[0].title === '第一章 起风', `首章标题：${JSON.stringify(sc[0].title)}`);

const plain = splitChapters('没有章节标题的一段文字。\n'.repeat(400));
ok(plain.length >= 2, `无标题文本按长度切分为 ${plain.length} 节`);
ok(
  plain.every((c) => c.content.replace(/\n/g, '').length <= 2700),
  '每节长度受控（不含段落分隔符）'
);

const oneLine = splitChapters('甲'.repeat(9000));
ok(oneLine.length >= 3, `单行超长文本切分为 ${oneLine.length} 节`);

// 连续两个标题 → 前一个没有正文，应当被丢掉
const consecutive = splitChapters('第一章 空的\n\n第二章 有内容\n\n正文在这里。');
ok(consecutive.length === 1 && consecutive[0].title === '第二章 有内容', '丢掉有标题没正文的章节');

// 盗版站塞进来的广告脚本 / HTML 必须清掉
const dirty = splitChapters('第一章 广告\n\n正文前。<script src=http://x.com/a.js></script><br>正文后。\n\n第二章 继续\n\n还有。<\/center>');
ok(!/<[a-z/]/i.test(dirty[0].content), '注入的 HTML/script 已被清除', JSON.stringify(dirty[0].content));
ok(dirty[0].content.includes('正文前。') && dirty[0].content.includes('正文后。'), '清理不会吃掉正文');

/* ── 3. JSON 解析的兼容写法 ─────────────────────────────── */
console.log('\nJSON 正文兼容');
const arr = parseBook(JSON.stringify({ chapters: ['第一段', '第二段'] }), { id: 'y', title: 'Y' });
ok(arr.chapters.length === 2 && arr.chapters[0].title === '第 1 章', '字符串数组形式的章节');
const paras = parseBook(JSON.stringify({ chapters: [{ title: 'A', content: ['一', '二'] }] }), { id: 'z' });
ok(paras.chapters[0].content === '一\n\n二', '段落数组会合并成多行');
const pre = parseBook(JSON.stringify({ words: 999, chapters: [{ title: 'A', content: '一二三' }] }), { id: 'w' });
ok(pre.meta.words === 999, '带 words 字段时直接采用，不做全量扫描');

/* ── 4. 真实书库 ────────────────────────────────────────── */
console.log('\n真实书库');
const manifestRaw = JSON.parse(readFileSync(resolve(ROOT, 'data/books.json'), 'utf8'));
const manifest = normalizeManifest(manifestRaw);
ok(manifest.length === 3, `清单列出 ${manifest.length} 本书`);
ok(
  manifest.every((b) => b.id && b.title && b.url && b.compress === 'gzip'),
  '每本书都标注了 gzip 压缩'
);
ok(new Set(manifest.map((b) => b.id)).size === manifest.length, 'id 无重复');

let rawTotal = 0;
let gzTotal = 0;

for (const item of manifest) {
  const file = resolve(ROOT, item.url);
  const gzBuf = await readFile(file);
  const json = gunzipSync(gzBuf).toString('utf8');
  const payload = JSON.parse(json);
  rawTotal += Buffer.byteLength(json);
  gzTotal += gzBuf.length;

  console.log(`\n《${item.title}》 ${item.author}`);
  console.log(
    `  压缩包 ${item.url.split('/').pop()}  ${mb(gzBuf.length)} → 解压 ${mb(Buffer.byteLength(json))}`
  );

  ok(/^[\s\uFEFF]*\{/.test(json), '解压出来是 JSON');
  ok(payload.v === 1, '格式版本正确');
  ok(payload.chapters.length === item.chapterCount, `章数与清单一致（${payload.chapters.length}）`);
  ok(payload.words === item.words, `字数与清单一致（${item.words.toLocaleString()}）`);
  ok(
    payload.chapters.every((c) => c.title && c.content.length > 0),
    '每章都有标题与正文'
  );
  ok(
    payload.chapters.every((c) => !/<[a-zA-Z/][^>]*>/.test(c.content)),
    '正文没有完整的 HTML 标签'
  );
  ok(
    payload.chapters.every((c) => !/^\s|\s$/.test(c.content)),
    '正文首尾没有多余空白'
  );
  const badChars = payload.chapters.reduce((n, c) => n + (c.content.match(/\uFFFD/g) || []).length, 0);
  const totalChars = payload.chapters.reduce((n, c) => n + c.content.length, 0);
  ok(
    badChars / totalChars < 1e-5,
    `几乎没有乱码（${badChars} 个替换字符 / ${totalChars.toLocaleString()} 字）`
  );
  ok(
    /[\u4e00-\u9fa5]/.test(payload.chapters[0].content),
    '正文是正常中文'
  );
  ok(
    Math.ceil(payload.chapters.length / SHARD_SIZE) <= 200,
    `分成 ${Math.ceil(payload.chapters.length / SHARD_SIZE)} 片存储`
  );

  console.log(`  首章 ${JSON.stringify(payload.chapters[0].title)}`);
  console.log(`  末章 ${JSON.stringify(payload.chapters.at(-1).title)}`);
  console.log(`  正文节选：${payload.chapters[0].content.slice(0, 48).replace(/\n/g, ' ')}…`);
}

console.log(
  `\n合计：压缩包 ${mb(gzTotal)}，解压后 ${mb(rawTotal)}，压缩率 ${((gzTotal / rawTotal) * 100).toFixed(1)}%`
);
/* ── 5. 前端解析同一份数据 ──────────────────────────────── */
console.log('\n前端解析同一份数据');
{
  const item = manifest[2] ?? manifest[0];
  const json = gunzipSync(await readFile(resolve(ROOT, item.url))).toString('utf8');
  const t0 = Date.now();
  const parsed = parseBook(json, item);
  const dt = Date.now() - t0;
  ok(parsed.meta.chapterCount === item.chapterCount, `parseBook 得到 ${parsed.meta.chapterCount} 章`);
  ok(parsed.meta.words === item.words, '字数一致');
  ok(dt < 8000, `解析耗时 ${dt}ms`);
}

console.log(
  failed
    ? `\n[FAILED] ${failed} 项未通过：\n${failures.map((f) => `  - ${f}`).join('\n')}\n`
    : '\n[PASSED] 全部通过\n'
);
process.exit(failed ? 1 : 0);
