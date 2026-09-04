// GET /search?q=<关键词>&page=<n>
// EdgeOne Cloud Function：合并剧集+影视全集（约 173584 条）载入内存，按标题 t 做大小写不敏感子串过滤，
// 返回 JAVBUS 认识的 { items, total }，items 元素为 {i,t,s,d}。
// 数据优先读同目录 _data/ 分片（随代码包部署）；缺失时回退到 jsDelivr 拉取 index/ 分片合并。
//
// 性能优化要点：
//  1) 载入时一次性预计算小写标题数组 `lowers`，搜索时不再对每个标题反复 toLowerCase()（原实现每请求对 17 万条标题 toLowerCase 2~3 次）。
//  2) 单遍扫描：每个匹配项只算一次 indexOf，写入「容量为所需页窗口」的最大堆，避免对超大匹配集做全量排序。
//  3) 模块级 query 结果缓存（LRU 上限）：热门/重复搜索直接命中，跳过扫描。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = Math.max(1, Number(process.env.PAGE_SIZE || 50));
const DATA_DIR = path.join(__dirname, '_data');

const REPO = 'Carolove7/javbus-juji-plugin';
const BRANCH = 'master';
const SOURCES = [
  `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}`,
  `https://raw.githubusercontent.com/${REPO}/${BRANCH}`,
];

// 单实例内结果缓存上限，超过则淘汰最旧条目
const QCACHE_MAX = 500;
const queryCache = new Map(); // key: `${q}|${page}` -> { items, total }

let DATA = null; // { items, lowers }
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

// 兜底：并行批量从远程拉取 index/ 分片合并（分片连续编号，整批 404 即到末尾）
async function fetchOne(type, n) {
  const rel = `index/${type}/${type}-${n}.json`;
  for (const base of SOURCES) {
    try {
      const r = await fetch(`${base}/${rel}`, { signal: AbortSignal.timeout(15000) });
      if (r.status === 404) return null;
      if (!r.ok) continue;
      const obj = await r.json();
      return obj.items || [];
    } catch {
      // 该源失败，尝试下一个
    }
  }
  return null;
}

async function fetchShards(type) {
  const MAX = 250;
  const BATCH = 40;
  const all = [];
  let consecutiveNull = 0;
  for (let start = 1; start <= MAX; start += BATCH) {
    const nums = [];
    for (let n = start; n < start + BATCH && n <= MAX; n++) nums.push(n);
    const results = await Promise.all(nums.map((n) => fetchOne(type, n)));
    let batchGot = false;
    for (const items of results) {
      if (items === null) continue;
      batchGot = true;
      all.push(...items);
    }
    consecutiveNull = batchGot ? 0 : consecutiveNull + BATCH;
    if (consecutiveNull >= BATCH && all.length > 0) break; // 连续整批缺失 = 已到末尾
  }
  if (all.length === 0) throw new Error(`无法拉取 index/${type}/（数据源均失败，可能网络受限）`);
  return all;
}

async function loadData() {
  if (DATA) return DATA;
  if (loading) return loading;
  loading = (async () => {
    let items;
    try {
      items = await readLocalChunks();
      console.log(`[load] all: ${items.length} items (local chunks)`);
    } catch (e) {
      console.warn('[load] local chunks missing, fetching from remote:', e.message);
      const [juji, yingshi] = await Promise.all([fetchShards('juji'), fetchShards('yingshi')]);
      items = [...juji, ...yingshi];
      console.log(`[load] all: ${items.length} items (remote)`);
    }
    // 预计算小写标题，搜索全程复用，避免每请求对每个标题反复 toLowerCase()
    const lowers = new Array(items.length);
    for (let i = 0; i < items.length; i++) lowers[i] = (items[i].t || '').toLowerCase();
    DATA = { items, lowers };
    return DATA;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

// 最大堆：保留「最小的 k 个 (pos, idx, item)」，堆顶为当前最大 (pos, idx)。
// 用于只保留排名前 k（= 所需页窗口）的最靠前匹配，避免对超大匹配集全量排序。
// 以 (pos, 原始下标) 为键，使同位置匹配按原始顺序稳定排列（与原全量稳定排序语义一致）。
class BoundedMinHeap {
  constructor(k) {
    this.k = Math.max(1, k);
    this.pos = [];
    this.idx = [];
    this.val = [];
  }
  static gt(a0, a1, b0, b1) {
    return a0 > b0 || (a0 === b0 && a1 > b1);
  }
  push(pos, idx, val) {
    const { pos: ps, idx: is, val: vs, k } = this;
    if (ps.length < k) {
      ps.push(pos);
      is.push(idx);
      vs.push(val);
      this._up(ps.length - 1);
    } else if (BoundedMinHeap.gt(ps[0], is[0], pos, idx)) {
      // 新项比堆顶（当前最大）更小 → 替换堆顶，维持堆内始终为最小的 k 个
      ps[0] = pos;
      is[0] = idx;
      vs[0] = val;
      this._down(0);
    }
  }
  _up(i) {
    const { pos: ps, idx: is, val: vs } = this;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!BoundedMinHeap.gt(ps[i], is[i], ps[p], is[p])) break;
      const tp = ps[p]; ps[p] = ps[i]; ps[i] = tp;
      const ti = is[p]; is[p] = is[i]; is[i] = ti;
      const tv = vs[p]; vs[p] = vs[i]; vs[i] = tv;
      i = p;
    }
  }
  _down(i) {
    const { pos: ps, idx: is, val: vs } = this;
    const n = ps.length;
    for (;;) {
      let l = 2 * i + 1, r = 2 * i + 2, m = i;
      if (l < n && BoundedMinHeap.gt(ps[l], is[l], ps[m], is[m])) m = l;
      if (r < n && BoundedMinHeap.gt(ps[r], is[r], ps[m], is[m])) m = r;
      if (m === i) break;
      const tp = ps[m]; ps[m] = ps[i]; ps[i] = tp;
      const ti = is[m]; is[m] = is[i]; is[i] = ti;
      const tv = vs[m]; vs[m] = vs[i]; vs[i] = tv;
      i = m;
    }
  }
  // 返回升序排列的 [pos, idx, item]（仅含堆内保留的 k 个最小 (pos,idx)）
  drainAsc() {
    const { pos: ps, idx: is, val: vs } = this;
    const out = [];
    for (let i = 0; i < ps.length; i++) out.push([ps[i], is[i], vs[i]]);
    out.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    return out;
  }
}

export function search(data, q, page) {
  const { items, lowers } = data;
  const ql = (q || '').trim().toLowerCase();
  const p = Math.max(1, parseInt(page, 10) || 1);
  const start = (p - 1) * PAGE_SIZE;

  if (!ql) {
    // 空查询：全量按页浏览，无需扫描/排序
    return { items: items.slice(start, start + PAGE_SIZE), total: items.length };
  }

  // 只需「前 p*PAGE_SIZE 个最靠前匹配」即可拼出目标页，堆容量据此限定，
  // 匹配总数极大（如高频单字）时也能把排序开销限制在页窗口量级。
  const need = p * PAGE_SIZE;
  const heap = new BoundedMinHeap(need);
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const pos = lowers[i].indexOf(ql);
    if (pos === -1) continue;
    total++;
    heap.push(pos, i, items[i]);
  }
  const top = heap.drainAsc(); // 升序：匹配位置越靠前越优先
  const pageItems = top.slice(start, start + PAGE_SIZE).map((x) => x[2]);
  return { items: pageItems, total };
}

function sendJson(obj, status = 200, cached = false) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'X-Cache': cached ? 'HIT' : 'MISS',
    },
  });
}

export async function onRequestGet(context) {
  try {
    const u = new URL(context.request.url);
    const q = u.searchParams.get('q') || '';
    const page = u.searchParams.get('page') || '1';
    const key = `${q}|${page}`;

    const hit = queryCache.get(key);
    if (hit) return sendJson(hit, 200, true);

    const data = await loadData();
    const out = search(data, q, page);

    if (queryCache.size >= QCACHE_MAX) queryCache.delete(queryCache.keys().next().value);
    queryCache.set(key, out);

    return sendJson(out);
  } catch (e) {
    return sendJson({ error: String((e && e.message) || e) }, 500);
  }
}
