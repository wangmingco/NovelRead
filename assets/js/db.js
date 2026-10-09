/* ═══════════════════════════════════════════════════════════
   db.js  IndexedDB —— 小说正文 / 阅读进度 / 书签 都存在浏览器里
   ═══════════════════════════════════════════════════════════ */

const DB_NAME = 'inkread';
const DB_VERSION = 1;

const SCHEMA = {
  // 书籍元数据 + 章节目录（不含正文，所以很小）
  books: { keyPath: 'id' },
  // 章节正文分片：一本大书拆成很多片，按需载入
  chunks: {
    keyPath: 'id',
    indexes: [{ name: 'bookId', keyPath: 'bookId' }],
  },
  // 阅读进度：每本书一条
  progress: { keyPath: 'bookId' },
  // 书签
  bookmarks: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [{ name: 'bookId', keyPath: 'bookId' }],
  },
  // 键值对：缓存的清单、杂项
  kv: { keyPath: 'key' },
};

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('当前浏览器不支持 IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(SCHEMA)) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, {
          keyPath: def.keyPath,
          autoIncrement: !!def.autoIncrement,
        });
        for (const idx of def.indexes || []) {
          store.createIndex(idx.name, idx.keyPath, idx.options || {});
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('数据库被其它标签页占用，请关闭其它标签页后重试'));
  });
  return dbPromise;
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export async function idbGet(name, key) {
  return reqAsPromise((await store(name)).get(key));
}

export async function idbAll(name) {
  return reqAsPromise((await store(name)).getAll());
}

export async function idbAllBy(name, indexName, key) {
  const s = await store(name);
  return reqAsPromise(s.index(indexName).getAll(key));
}

export async function idbPut(name, value) {
  return reqAsPromise((await store(name, 'readwrite')).put(value));
}

export async function idbDelete(name, key) {
  return reqAsPromise((await store(name, 'readwrite')).delete(key));
}

export async function idbClear(name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    tx.objectStore(name).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 删除一本书及其正文分片、进度、书签 */
export async function idbRemoveBook(bookId) {
  const db = await openDB();
  const [marks, chunks] = await Promise.all([
    idbAllBy('bookmarks', 'bookId', bookId),
    idbAllBy('chunks', 'bookId', bookId),
  ]);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['books', 'chunks', 'progress', 'bookmarks'], 'readwrite');
    tx.objectStore('books').delete(bookId);
    tx.objectStore('progress').delete(bookId);
    for (const c of chunks) tx.objectStore('chunks').delete(c.id);
    for (const m of marks) tx.objectStore('bookmarks').delete(m.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('删除被中止'));
  });
}

/* ── 书籍分片存储 ───────────────────────────────────────── */

const chunkId = (bookId, index) => `${bookId}#${index}`;

export function getChunk(bookId, index) {
  return idbGet('chunks', chunkId(bookId, index));
}

/**
 * 把解析好的书写进 IndexedDB：目录存 books，正文按 shardSize 分片存 chunks。
 * 这样一本 1400 万字的书，打开时只需要读几十 KB。
 *
 * @param {{meta: object, chapters: {title: string, content: string}[]}} book
 * @param {(ratio: number) => void} [onProgress]
 */
export async function saveBook(book, onProgress) {
  const { meta, chapters } = book;
  const size = Math.max(1, Number(meta.shardSize) || 40);
  const shardCount = Math.max(1, Math.ceil(chapters.length / size));

  await idbPut('books', {
    ...meta,
    titles: chapters.map((c) => c.title),
    shardSize: size,
    shardCount,
  });

  for (let i = 0; i < shardCount; i++) {
    const slice = chapters.slice(i * size, (i + 1) * size).map((c) => c.content);
    await idbPut('chunks', { id: chunkId(meta.id, i), bookId: meta.id, index: i, chapters: slice });
    onProgress?.((i + 1) / shardCount);
    // 让出主线程，进度条能动
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
}

/** 申请持久化存储，避免浏览器在空间紧张时清掉我们的书 */
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageInfo() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return null;
    return { usage: est.usage || 0, quota: est.quota || 0 };
  } catch {
    return null;
  }
}
