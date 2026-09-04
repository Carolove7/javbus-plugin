// GET /search?q=<关键词>&page=<n>
// EdgeOne Cloud Function：合并剧集+影视全集（约 173584 条）载入内存，按标题 t 做大小写不敏感子串过滤，
// 返回 JAVBUS 认识的 { items, total }，items 元素为 {i,t,s,d}。
// 数据优先读同目录 _data/ 分片（随代码包部署）；缺失时回退到 jsDelivr 拉取 index/ 分片合并。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 50);
const DATA_DIR = path.join(__dirname, '_data');

const REPO = 'Carolove7/javbus-juji-plugin';
const BRANCH = 'master';
const SOURCES = [
  `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}`,
  `https://raw.githubusercontent.com/${REPO}/${BRANCH}`,
];

let ALL = null;
let loading = null;

async function readLocalChunks() {
  const meta = JSON.parse(await readFile(path.join(DATA_DIR, 'all-meta.json'), 'utf8'));
  const items = [];
  for (let n = 1; n <= (meta.parts || 1); n++) {
    const obj = JSON.parse(await readFile(path.join(DATA_DIR, `all-${n}.json`), 'utf8'));
    items.push(...(obj.items || []));
  }
  return items;
}

// 兜底：从远程拉取 index/ 分片合并（按序命名，遇 404 停止）
async function fetchShards(type) {
  const items = [];
  let n = 1;
  const MAX = 500;
  while (n <= MAX) {
    const rel = `index/${type}/${type}-${n}.json`;
    let got = null;
    for (const base of SOURCES) {
      try {
        const r = await fetch(`${base}/${rel}`, { signal: AbortSignal.timeout(15000) });
        if (r.status === 404) return items;
        if (!r.ok) continue;
        got = await r.json();
        break;
      } catch {
        // 该源失败，尝试下一个
      }
    }
    if (!got) {
      if (items.length > 0) return items;
      throw new Error(`无法拉取 ${rel}（数据源均失败，可能网络受限）`);
    }
    items.push(...(got.items || []));
    n++;
  }
  return items;
}

async function loadAll() {
  if (ALL) return ALL;
  if (loading) return loading;
  loading = (async () => {
    try {
      ALL = await readLocalChunks();
      console.log(`[load] all: ${ALL.length} items (local chunks)`);
    } catch (e) {
      console.warn('[load] local chunks missing, fetching from remote:', e.message);
      const [juji, yingshi] = await Promise.all([fetchShards('juji'), fetchShards('yingshi')]);
      ALL = [...juji, ...yingshi];
      console.log(`[load] all: ${ALL.length} items (remote)`);
    }
    return ALL;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

function search(items, q, page) {
  const ql = (q || '').trim().toLowerCase();
  let filtered = items;
  if (ql) {
    filtered = items.filter((it) => (it.t || '').toLowerCase().includes(ql));
    // 相关性排序：关键词在标题中出现位置越靠前越优先（startsWith 排最前）
    filtered = filtered.slice().sort((a, b) => {
      const ia = (a.t || '').toLowerCase().indexOf(ql);
      const ib = (b.t || '').toLowerCase().indexOf(ql);
      return ia - ib;
    });
  }
  const total = filtered.length;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const start = (p - 1) * PAGE_SIZE;
  return { items: filtered.slice(start, start + PAGE_SIZE), total };
}

function sendJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequestGet(context) {
  try {
    const u = new URL(context.request.url);
    const q = u.searchParams.get('q') || '';
    const page = u.searchParams.get('page') || '1';
    const items = await loadAll();
    return sendJson(search(items, q, page));
  } catch (e) {
    return sendJson({ error: String((e && e.message) || e) }, 500);
  }
}
