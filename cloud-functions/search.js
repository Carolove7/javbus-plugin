// GET /search?q=kw&page=n  EdgeOne Cloud Function (ASCII-only comments)
// Merge juji+yingshi+yuanpan (~178852 items) into one case-insensitive substring search.
// Returns { items, total } where items = { i, t, s, d, m }.
// Search text lowers = t + remarks + tags lowercased (combined). Chinese titles live in remarks.
//
// Memory constraint: CF runtime memory limit is far below 2.3GB full or 180MB slim-objects.
// On-demand architecture:
//  1) Cold start downloads only index-slim/search.json (~20MB): all lowers concatenated into one
//     long text + compact locator tables (bounds/cat/shard/itemIdx) + sorted hashes table.
//     Resident memory after parse is ~35MB.
//  2) Search scans the long text with indexOf (native C++, ~10-30ms), maps hit positions to global
//     item indices via binary search over bounds.
//  3) Only the current page results fetch their metadata on demand (index-slim shard, LRU cached).
//  4) /detail fetches a single full shard (index/<cat>/<cat>-N.json, with files) on demand by hash.
// Peak memory stays ~40MB, eliminating OOM/timeout 500s.
//
// Data source pinned to deploy commit SHA (cloud-functions/_ref.json), not @master (avoids CDN lag).
// Fallback to @master when _ref.json is absent (local/unbuilt env).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = Math.max(1, Number(process.env.PAGE_SIZE || 50));
const REPO = 'Carolove7/javbus-plugin';
const BRANCH = 'master';
let REF = BRANCH;
try {
  const refObj = JSON.parse(readFileSync(path.join(__dirname, '_ref.json'), 'utf8'));
  if (refObj && refObj.ref) REF = refObj.ref;
} catch {
  // no _ref.json -> fallback @master
}
const SOURCES = [
  `https://cdn.jsdelivr.net/gh/${REPO}@${REF}`,
  `https://raw.githubusercontent.com/${REPO}/${REF}`,
];

const QCACHE_MAX = 500;
const queryCache = new Map();
const SEP = '\u0000';
const CATS = ['juji', 'yingshi', 'yuanpan'];

let SEARCH = null;
let loading = null;
const shardCache = new Map(); // `${cat}/${n}` -> slim items array
const SHARD_CACHE_MAX = 8;

async function fetchJson(rel) {
  for (const base of SOURCES) {
    try {
      const r = await fetch(`${base}/${rel}`, { signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return null;
      if (!r.ok) continue;
      return await r.json();
    } catch {
      // try next source
    }
  }
  return null;
}

// Fetch raw bytes for a path (tries each source). Returns Buffer or null.
async function fetchBuf(rel) {
  for (const base of SOURCES) {
    try {
      const r = await fetch(`${base}/${rel}`, { signal: AbortSignal.timeout(30000) });
      if (r.status === 404) continue;
      if (!r.ok) continue;
      return Buffer.from(await r.arrayBuffer());
    } catch {
      // try next source
    }
  }
  return null;
}

async function loadSearch() {
  if (SEARCH) return SEARCH;
  if (loading) return loading;
  loading = (async () => {
    const meta = await fetchJson('index-slim/search.meta.json');
    if (!meta) throw new Error('cannot fetch index-slim/search.meta.json (data source failed)');
    // Raw UTF-8 text, split into chunks: jsDelivr returns HTTP 403 for GitHub files larger
    // than ~20MB, so a single 39MB search.text could never be served. Concatenate the chunk
    // BUFFERS first and decode ONCE — decoding per-chunk would corrupt multi-byte CJK chars
    // that straddle a chunk boundary.
    let text = '';
    const nChunks = Number(meta.textChunks || 0);
    if (nChunks > 0) {
      const parts = await Promise.all(
        Array.from({ length: nChunks }, (_, k) => fetchBuf(`index-slim/text-${k + 1}`)),
      );
      if (parts.some((p) => !p)) throw new Error('cannot fetch index-slim/text-N (data source failed)');
      text = Buffer.concat(parts).toString('utf8');
    } else {
      // legacy single-file layout
      const buf = await fetchBuf('index-slim/search.text');
      if (!buf) throw new Error('cannot fetch index-slim/search.text (data source failed)');
      text = buf.toString('utf8');
    }
    const data = {
      text,
      bounds: Int32Array.from(meta.bounds),
      cat: Int32Array.from(meta.cat),
      shard: Int32Array.from(meta.shard),
      itemIdx: Int32Array.from(meta.itemIdx),
      hashStr: meta.hashStr,
      hashItem: Int32Array.from(meta.hashItem),
      total: meta.total,
      catCounts: meta.catCounts || null,
      ref: REF,
    };
    console.log(`[load] search: ${data.total} items, textLen=${data.text.length}, ref=${REF}`);
    SEARCH = data;
    return data;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

// binary search: first item index whose bounds > pos  => item spans [bounds[i-1], bounds[i])
function itemAt(s, pos) {
  const b = s.bounds;
  let lo = 0, hi = b.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (b[mid] > pos) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return ans;
}

async function getMeta(s, k) {
  const cat = CATS[s.cat[k]];
  const n = s.shard[k];
  const ii = s.itemIdx[k];
  const key = `${cat}/${n}`;
  let arr = shardCache.get(key);
  if (!arr) {
    const got = await fetchJson(`index-slim/${cat}/${cat}-${n}.json`);
    if (!got) return null;
    arr = Array.isArray(got) ? got : (got.items || []);
    if (shardCache.size >= SHARD_CACHE_MAX) shardCache.delete(shardCache.keys().next().value);
    shardCache.set(key, arr);
  }
  const it = arr[ii];
  if (!it) return null;
  return { i: it.i, t: it.t, s: it.s, d: it.d, m: it.m };
}

export async function search(data, q, page) {
  const ql = (q || '').trim().toLowerCase().split(SEP).join('');
  const p = Math.max(1, parseInt(page, 10) || 1);
  const start = (p - 1) * PAGE_SIZE;
  if (!ql) {
    const total = data.total;
    const ks = [];
    for (let k = start; k < Math.min(start + PAGE_SIZE, total); k++) ks.push(k);
    const items = (await Promise.all(ks.map((k) => getMeta(data, k)))).filter(Boolean);
    return { items, total };
  }
  const text = data.text;
  const matches = [];
  const MAX = 5000;
  let pos = text.indexOf(ql);
  let guard = 0;
  while (pos !== -1 && matches.length < MAX && guard < MAX * 4) {
    matches.push(itemAt(data, pos));
    pos = text.indexOf(ql, pos + 1);
    guard++;
  }
  const uniq = [];
  for (const k of matches) {
    if (uniq.length === 0 || uniq[uniq.length - 1] !== k) uniq.push(k);
  }
  const total = uniq.length;
  const pageKs = uniq.slice(start, start + PAGE_SIZE);
  const items = (await Promise.all(pageKs.map((k) => getMeta(data, k)))).filter(Boolean);
  return { items, total };
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
    const data = await loadSearch();
    const out = await search(data, q, page);
    if (debug && data.catCounts) out.debug = data.catCounts;
    if (queryCache.size >= QCACHE_MAX) queryCache.delete(queryCache.keys().next().value);
    queryCache.set(key, out);
    return sendJson(out);
  } catch (e) {
    return sendJson({ error: String((e && e.message) || e) }, 500);
  }
}

// /detail: fetch a single FULL shard (with files) on demand by infoHash.
export async function fetchItemFull(hash) {
  const data = await loadSearch();
  const h = String(hash || '').toUpperCase().slice(0, 40).padEnd(40, '0');
  const PW = 40;
  const hs = data.hashStr;
  let lo = 0, hi = data.hashItem.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cur = hs.substr(mid * PW, PW);
    if (cur === h) { found = mid; break; }
    if (cur < h) lo = mid + 1; else hi = mid - 1;
  }
  if (found === -1) return null;
  const k = data.hashItem[found];
  const cat = CATS[data.cat[k]];
  const n = data.shard[k];
  const ii = data.itemIdx[k];
  const got = await fetchJson(`index/${cat}/${cat}-${n}.json`);
  if (!got) return null;
  const items = Array.isArray(got) ? got : (got.items || []);
  return items[ii] || null;
}

export { loadSearch };
