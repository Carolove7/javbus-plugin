// GET /search?q=<关键词>&page=<n>
// EdgeOne Cloud Function：合并剧集+影视+原盘全集（约 178852 条）载入内存，按 `t`+`remarks`+`tags` 拼接文本做大小写不敏感子串过滤（中文片名在 remarks，必须纳入否则原盘搜不到），
// 返回 JAVBUS 认识的 { items, total }，items 元素为 {i,t,s,d}。
// 数据始终从远程拉取最新提交的 index-slim/ 分片合并（juji/yingshi/yuanpan 各分类目录下是 JSON 数组 [{...}]）。
// 说明：全量 index/ 约 1.57GB（含 550 万条 files，解析后占 2.3GB 内存）远超 Cloud Function 内存/超时上限，
// 直接全量加载会 OOM/超时导致 500。故搜索只用「精简数据集」index-slim/（仅 {i,t,s,d,m,remarks,tags}，约 73MB，
// 解析后约 200MB），文件列表 files 不在内存，改由 /detail 端点按需按 hash 拉取单个完整分片（见 fetchItemFull）。
// 解析统一走 itemsOf() 兼容数组/ {items:[]}。
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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = Math.max(1, Number(process.env.PAGE_SIZE || 50));
const DATA_DIR = path.join(__dirname, '_data');

const REPO = 'Carolove7/javbus-plugin';
const BRANCH = 'master';
// 数据源固定到「部署时写入的 commit SHA」(cloud-functions/_ref.json)，而非 @master。
// 原因：jsDelivr 对 @master 存在 CDN 滞后，曾观测到线上函数读到新旧混合/滞后的分片
//（如 yingshi 远程 62618 而本地 63443），导致某些分类搜不到。固定到部署 commit 可保证
// 函数永远读到与代码同版本的新鲜数据；_ref.json 缺失时回退 @master（本地/未构建环境）。
// 搜索加载 index-slim/ 分片（精简数据集），详情按需加载 index/ 完整分片。
let REF = BRANCH;
try {
  const refObj = JSON.parse(readFileSync(path.join(__dirname, '_ref.json'), 'utf8'));
  if (refObj && refObj.ref) REF = refObj.ref;
} catch {
  // 无 _ref.json -> 回退 @master
}
const SOURCES = [
  `https://cdn.jsdelivr.net/gh/${REPO}@${REF}`,
  `https://raw.githubusercontent.com/${REPO}/${REF}`,
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

// 说明：不再优先读本地 _data 合并分片——构建产物可能过期、漏掉新增分类（如 yuanpan），
// 导致 /search 搜不到原盘。改为始终从远程拉取最新提交的 index/ 分片合并（见 loadData）。
// 分片格式兼容：index/ 分片是 JSON 数组 [{...}]，而历史合并产物 _data/all-*.json 是 { items:[...] }。
// 统一用 itemsOf 解析，避免 obj.items 为 undefined 时静默取 0 条（这是「搜不到 yuanpan」的根因）。
function itemsOf(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj && Array.isArray(obj.items)) return obj.items;
  return [];
}
// 兜底：并行批量从远程拉取分片合并（分片连续编号，整批 404 即到末尾）。
// slim=true 读 index-slim/ 精简分片（搜索用，内存小）；slim=false 读 index/ 完整分片（详情用，含 files）。
async function fetchOne(type, n, slim = true) {
  const dir = slim ? 'index-slim' : 'index';
  const rel = `${dir}/${type}/${type}-${n}.json`;
  for (const base of SOURCES) {
    try {
      const r = await fetch(`${base}/${rel}`, { signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return null;
      if (!r.ok) continue;
      const obj = await r.json();
      return itemsOf(obj);
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
  const hashToShard = new Map(); // infoHash(大写) -> [cat, n]，供 /detail 按需定位完整分片
  let consecutiveNull = 0;
  for (let start = 1; start <= MAX; start += BATCH) {
    const nums = [];
    for (let n = start; n < start + BATCH && n <= MAX; n++) nums.push(n);
    const results = await Promise.all(nums.map((n) => fetchOne(type, n, true)));
    let batchGot = false;
    for (let bi = 0; bi < results.length; bi++) {
      const items = results[bi];
      if (items === null) continue;
      batchGot = true;
      const n = nums[bi];
      for (const it of items) {
        all.push(it);
        if (it && it.i) hashToShard.set(String(it.i).toUpperCase(), [type, n]);
      }
    }
    consecutiveNull = batchGot ? 0 : consecutiveNull + BATCH;
    if (consecutiveNull >= BATCH && all.length > 0) break; // 连续整批缺失 = 已到末尾
  }
  if (all.length === 0) throw new Error(`无法拉取 index-slim/${type}/（数据源均失败，可能网络受限）`);
  return { all, hashToShard };
}

// 载入 items 后统一构建 lowers + 倒排索引，并把内存中搜索条目压成最小集。
// 搜索文本 lowers = 标题 t + 备注 remarks + 标签 tags 的拼接小写（combined）。
// 关键：原盘(yuanpan) 标题 t 是英文 BluRay 发行名（A.Taxi.Driver.2017...），中文片名只在 remarks
// （出租车司机 택시 운전사 (2017)）。必须把 remarks/tags 纳入 lowers，中文查询才能命中原盘——
// 这正是用户体感「原盘搜不到」的根因。倒排索引建在 combined lowers 上，确保 remarks 匹配也是候选。
// 代价：combined 索引约 37.6M postings（~144MB）可能超过函数内存预算（SEARCH_INDEX_MAX_MB 默认 128），
// 此时 buildIndex 自动回退 null，searchIndexed 转全扫描（结果仍正确，仅稍慢）。小内存函数安全回退，
// 大内存函数则享受快速倒排。两处回退（索引缺失 / 倒排无候选）都走 searchScan，保证不漏匹配。
//
// 内存优化：构建 lowers 后，内存条目仅保留搜索返回/定位所需字段 {i,t,s,d,m}。
// remarks/tags 已并入 lowers 用于检索，无需再占内存；files 本就不在精简数据集（/detail 按需取）。
// 这把冷启动内存从全量 2.3GB 压到约 250-300MB，避免 Cloud Function OOM/超时。
function finalizeData(items) {
  const lowers = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const tags = Array.isArray(it.tags) ? it.tags.join(' ') : '';
    lowers[i] = `${it.t || ''} ${it.remarks || ''} ${tags}`.toLowerCase();
  }
  const slim = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    slim[i] = { i: it.i, t: it.t, s: it.s, d: it.d, m: it.m };
  }
  let index = null;
  if (USE_INDEX()) index = buildIndex(lowers);
  return { items: slim, lowers, index };
}

async function loadData() {
  if (DATA) return DATA;
  if (loading) return loading;
  loading = (async () => {
    // 始终从远程拉取最新提交的 index-slim/ 分片合并（含 juji/yingshi/yuanpan 各分类），
    // 精简数据集仅 ~73MB，避免把 1.57GB 全量（含 550 万 files）载入内存导致 OOM/超时。
    const [juji, yingshi, yuanpan] = await Promise.all([
      fetchShards('juji'),
      fetchShards('yingshi'),
      fetchShards('yuanpan'),
    ]);
    const items = [...juji.all, ...yingshi.all, ...yuanpan.all];
    const hashToShard = new Map([...juji.hashToShard, ...yingshi.hashToShard, ...yuanpan.hashToShard]);
    console.log(`[load] all: ${items.length} items (slim, ref=${REF}) juji=${juji.all.length} yingshi=${yingshi.all.length} yuanpan=${yuanpan.all.length} hashIndex=${hashToShard.size}`);
    DATA = finalizeData(items);
    DATA.catCounts = { juji: juji.all.length, yingshi: yingshi.all.length, yuanpan: yuanpan.all.length, ref: REF };
    DATA.hashToShard = hashToShard;
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
  // 倒排无候选：标题里没有该查询的任何二元组（典型如纯中文、仅出现在 remarks 的原盘条目），
  // 回退全扫描（基于 combined lowers，含 remarks/tags）以保证不漏匹配。
  if (cands === null) return searchScan(data, ql, p, start);
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
    const debug = u.searchParams.get('debug') === '1';
    const key = `${q}|${page}`;

    const hit = queryCache.get(key);
    if (hit) return sendJson(hit, 200, true);

    const data = await loadData();
    const out = search(data, q, page);
    if (debug && data.catCounts) out.debug = data.catCounts;

    if (queryCache.size >= QCACHE_MAX) queryCache.delete(queryCache.keys().next().value);
    queryCache.set(key, out);

    return sendJson(out);
  } catch (e) {
    return sendJson({ error: String((e && e.message) || e) }, 500);
  }
}

// 按 infoHash 按需拉取「单个完整分片」并返回含 files 的完整条目（/detail 用，避免全量 files 进内存）。
// 定位：先用 loadData 建立好的 hashToShard（infoHash -> [cat, n]），只下载该分片（平均 ~8MB，最大 ~42MB），
// 远小于全量 1.57GB。未命中返回 null。
export async function fetchItemFull(hash) {
  const data = await loadData();
  const h = String(hash || '').toUpperCase();
  const loc = data.hashToShard && data.hashToShard.get(h);
  if (!loc) return null;
  const [cat, n] = loc;
  const items = await fetchOne(cat, n, false); // 完整分片（含 files）
  if (!items) return null;
  return items.find((it) => it && it.i && String(it.i).toUpperCase() === h) || null;
}

// 导出内部构件（供基准/测试复用；detail.js 用 fetchItemFull 按需取完整条目）
export { buildIndex, intersect, finalizeData, bigramsOf, loadData };
