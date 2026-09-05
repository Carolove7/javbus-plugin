// GET /search?q=<关键词>&page=<n>
// EdgeOne Cloud Function：合并剧集+影视全集（约 173584 条）载入内存，按标题 t 做大小写不敏感子串过滤，
// 返回 JAVBUS 认识的 { items, total }，items 元素为 {i,t,s,d}。
// 数据优先读同目录 _data/ 分片（随代码包部署）；缺失时回退到 jsDelivr 拉取 index/ 分片合并。
//
// 性能优化要点（v2）：
//  0) 加载期一次性预计算小写标题数组 `lowers`，搜索时不再对每个标题反复 toLowerCase()。
//  1) 加载期构建 **bigram(二元组) 倒排索引**：以紧凑 Int32Array 存放所有 (docId) 倒排表，Map 仅存
//     [offset,len]。查询时先对 q 取二元组、求各倒排表的交集得到「候选集」（真匹配的超集），
//     再只对候选做精确 indexOf 校验与位置排序——把每请求的扫描量从全量 17 万降到候选集大小。
//     二元组索引对 len>=2 的查询生效（含 CJK 双字如「速度」）；单字查询回退全扫描。
//  2) 单遍扫描（候选集内）：每个匹配项只算一次 indexOf，写入「容量为所需页窗口」的最大堆，避免全量排序。
//  3) 模块级 query 结果缓存（LRU 上限）：热门/重复搜索直接命中，跳过扫描。
//  4) 索引构建 OOM 安全：失败则自动回退到全扫描模式，不影响服务可用性。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = Math.max(1, Number(process.env.PAGE_SIZE || 50));
const DATA_DIR = path.join(__dirname, '_data');

const REPO = 'Carolove7/javbus-plugin';
const BRANCH = 'master';
const SOURCES = [
  `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}`,
  `https://raw.githubusercontent.com/${REPO}/${BRANCH}`,
];

// 单实例内结果缓存上限，超过则淘汰最旧条目
const QCACHE_MAX = 500;
const queryCache = new Map(); // key: `${q}|${page}` -> { items, total }

let DATA = null; // { items, lowers, index }
let loading = null;

const USE_INDEX = () => process.env.SEARCH_INDEX !== 'off';

// ---- bigram 倒排索引 ----
// 取字符串（已小写）的全部相邻二元组；空/单字返回 []。
function bigramsOf(s) {
  const out = [];
  for (let j = 0; j < s.length - 1; j++) out.push(s.substr(j, 2));
  return out;
}

// 两遍构建：先统计各二元组频次并分配写入偏移，再把 docId 填入单一 Int32Array。
// 返回 { postings: Int32Array, map: Map<string,[off,len]> } 或 null（异常时回退全扫描）。
function buildIndex(lowers) {
  try {
    const N = lowers.length;
    // 第一遍：统计频次
    const counts = new Map();
    for (let i = 0; i < N; i++) {
      const s = lowers[i];
      for (let j = 0; j < s.length - 1; j++) {
        const bg = s.substr(j, 2);
        counts.set(bg, (counts.get(bg) || 0) + 1);
      }
    }
    let total = 0;
    for (const c of counts.values()) total += c;
    // 内存预算护栏：倒排表占 ~total*4 字节；超出预算则放弃建索引，回退全扫描，避免撑爆 CF 内存。
    const MAX_INDEX_MB = Number(process.env.SEARCH_INDEX_MAX_MB || 128);
    if (total * 4 > MAX_INDEX_MB * 1024 * 1024) {
      console.warn(`[index] postings=${total} 预估 ${(total * 4 / 1024 / 1024).toFixed(1)}MB 超过预算 ${MAX_INDEX_MB}MB，跳过索引`);
      return null;
    }
    const postings = new Int32Array(total);
    // 分配每个二元组的写入偏移
    const offsets = new Map();
    let off = 0;
    for (const [bg, c] of counts) {
      offsets.set(bg, off);
      off += c;
    }
    // 第二遍：填充倒排表（docId 递增，列表天然有序，便于后续归并交集）
    const filled = new Map();
    for (let i = 0; i < N; i++) {
      const s = lowers[i];
      for (let j = 0; j < s.length - 1; j++) {
        const bg = s.substr(j, 2);
        const base = offsets.get(bg);
        const f = filled.get(bg) || 0;
        postings[base + f] = i;
        filled.set(bg, f + 1);
      }
    }
    const map = new Map();
    for (const [bg, c] of counts) map.set(bg, [offsets.get(bg), c]);
    console.log(`[index] bigram index built: ${map.size} distinct bigrams, ${total} postings`);
    return { postings, map };
  } catch (e) {
    console.warn('[index] build failed, falling back to full scan:', e && e.message);
    return null;
  }
}

// 求 ql 的各二元组倒排表之交集（有序归并）。返回升序候选 docId 数组；某二元组不存在即无匹配 -> null。
function intersect(index, ql) {
  const { postings, map } = index;
  const seen = new Set();
  const bgs = [];
  for (let j = 0; j < ql.length - 1; j++) {
    const bg = ql.substr(j, 2);
    if (!seen.has(bg)) {
      seen.add(bg);
      if (map.has(bg)) bgs.push(bg);
    }
  }
  if (bgs.length === 0) return null; // 任意二元组都无文档包含 -> 必无匹配
  // 取切片并按长度升序，先与最小列表相交，逐步收窄
  const slices = bgs.map((bg) => {
    const [o, len] = map.get(bg);
    return { off: o, len };
  });
  slices.sort((a, b) => a.len - b.len);
  let result = [];
  const first = slices[0];
  for (let k = 0; k < first.len; k++) result.push(postings[first.off + k]);
  for (let li = 1; li < slices.length; li++) {
    const { off, len } = slices[li];
    const next = [];
    let ri = 0;
    let pi = 0;
    while (ri < result.length && pi < len) {
      const a = result[ri];
      const b = postings[off + pi];
      if (a === b) {
        next.push(a);
        ri++;
        pi++;
      } else if (a < b) {
        ri++;
      } else {
        pi++;
      }
    }
    result = next;
    if (result.length === 0) break;
  }
  // 去重：同一 doc 若在标题中多次出现同一 bigram，会在某条倒排表里重复出现，
  // 经归并交集后产生重复候选 —— 结果已升序，去除相邻重复即可。
  if (result.length <= 1) return result;
  const uniq = [result[0]];
  for (let k = 1; k < result.length; k++) {
    if (result[k] !== result[k - 1]) uniq.push(result[k]);
  }
  return uniq;
}

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

// 载入 items 后统一构建 lowers + 倒排索引
function finalizeData(items) {
  const lowers = new Array(items.length);
  for (let i = 0; i < items.length; i++) lowers[i] = (items[i].t || '').toLowerCase();
  let index = null;
  if (USE_INDEX()) index = buildIndex(lowers);
  return { items, lowers, index };
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
    DATA = finalizeData(items);
    return DATA;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

// 最大堆：保留「最小的 k 个 (pos, idx, item)」，堆顶为当前最大 (pos, idx)。
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

// 全量扫描版（索引不可用 / 单字查询时的回退路径），语义与原实现完全一致。
export function searchScan(data, q, page) {
  const { items, lowers } = data;
  const ql = (q || '').trim().toLowerCase();
  const p = Math.max(1, parseInt(page, 10) || 1);
  const start = (p - 1) * PAGE_SIZE;
  if (!ql) {
    return { items: items.slice(start, start + PAGE_SIZE), total: items.length };
  }
  const need = p * PAGE_SIZE;
  const heap = new BoundedMinHeap(need);
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const pos = lowers[i].indexOf(ql);
    if (pos === -1) continue;
    total++;
    heap.push(pos, i, items[i]);
  }
  const top = heap.drainAsc();
  return { items: top.slice(start, start + PAGE_SIZE).map((x) => x[2]), total };
}

// 索引版：先用 bigram 倒排索引收窄候选集，再对候选做精确 indexOf 校验+位置排序。
export function searchIndexed(data, q, page) {
  const { items, lowers, index } = data;
  const ql = (q || '').trim().toLowerCase();
  const p = Math.max(1, parseInt(page, 10) || 1);
  const start = (p - 1) * PAGE_SIZE;
  if (!ql) {
    return { items: items.slice(start, start + PAGE_SIZE), total: items.length };
  }
  // 单字查询（len<2）或索引缺失 -> 回退全扫描
  if (!index || ql.length < 2) return searchScan(data, ql, p, start);
  const cands = intersect(index, ql);
  if (cands === null) return { items: [], total: 0 };
  const need = p * PAGE_SIZE;
  const heap = new BoundedMinHeap(need);
  let total = 0;
  for (let k = 0; k < cands.length; k++) {
    const ci = cands[k];
    const pos = lowers[ci].indexOf(ql);
    if (pos === -1) continue; // 倒排交集是超集，需精确校验剔除伪命中
    total++;
    heap.push(pos, ci, items[ci]);
  }
  const top = heap.drainAsc();
  return { items: top.slice(start, start + PAGE_SIZE).map((x) => x[2]), total };
}

// 主入口（供 onRequestGet 与基准使用）
export function search(data, q, page) {
  return searchIndexed(data, q, page);
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

// 导出内部构件（供基准/测试复用；detail.js 复用 loadData 以共用同一数据源）
export { buildIndex, intersect, finalizeData, bigramsOf, loadData };
