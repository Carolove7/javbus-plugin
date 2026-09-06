// GET /search?q=kw&page=n  EdgeOne Pages Function (ASCII-only comments)
// Merge juji+yingshi+yuanpan (~178852 items) into one case-insensitive substring search.
// Returns { items, total } where items = { i, t, s, d, m }.
// Searchable text per item = (t + remarks + tags).toLowerCase() — Chinese titles live in remarks.
//
// !! RUNTIME CONSTRAINT !!
// This runs on the EdgeOne Pages Functions V8 EDGE RUNTIME, NOT full Node.js. Confirmed by
// production: using `Buffer` crashed the function with "ReferenceError" (500/503), while
// mg.js — which only uses fetch/Response/process.env — works fine.
// => DO NOT use: Buffer, node:fs, node:path, node:url, require, __dirname, __filename.
// => Allowed: fetch, Response/Request, TextDecoder, DecompressionStream, AbortController,
//    setTimeout, process.env, JSON, Int32Array.
//
// On-demand architecture (keeps cold start tiny and memory ~60MB):
//  1) Cold start downloads only index-slim/meta.z + index-slim/text.z (~4MB gzipped).
//  2) Search scans one long text with indexOf (native), maps hit offsets -> item index via
//     binary search over `bounds`.
//  3) Only the current page fetches its metadata (index-slim/<cat>/<cat>-N.json, LRU cached).
//  4) /detail loads index-slim/hash.z lazily, then a single FULL shard by infoHash.
//
// Data source is pinned to the deploy commit SHA (cloud-functions/_ref.js) to dodge jsDelivr's
// @master cache lag; falls back to @master when _ref.js is unavailable.
const PAGE_SIZE = Math.max(1, Number((typeof process !== 'undefined' && process.env ? process.env.PAGE_SIZE : 0) || 50));
const REPO = 'Carolove7/javbus-plugin';
const DEFAULT_REF = 'master';
const TIMEOUT_MS = 30000;

const GZ = typeof DecompressionStream !== 'undefined';
const TD = new TextDecoder();

const QCACHE_MAX = 500;
const queryCache = new Map();
const SEP = '\u0000';
const CATS = ['juji', 'yingshi', 'yuanpan'];

let SEARCH = null;
let loading = null;
let SRC = null;
const shardCache = new Map(); // `${cat}/${n}` -> slim items array
const SHARD_CACHE_MAX = 8;
let HASH = null;

// ------------------------------------------------------------------ data source plumbing
async function getRef() {
  try {
    const m = await import('./_ref.js');
    if (m && typeof m.DATA_REF === 'string' && /^[0-9a-f]{7,40}$/.test(m.DATA_REF)) return m.DATA_REF;
  } catch {
    // _ref.js absent or unbundled -> fall back to @master
  }
  return DEFAULT_REF;
}

async function getSources() {
  if (SRC) return SRC;
  const r = await getRef();
  const list = [`https://cdn.jsdelivr.net/gh/${REPO}@${r}`];
  if (r !== DEFAULT_REF) list.push(`https://cdn.jsdelivr.net/gh/${REPO}@${DEFAULT_REF}`);
  list.push(`https://raw.githubusercontent.com/${REPO}/${r}`);
  SRC = list;
  return list;
}

function isGz(b) { return b && b.length > 2 && b[0] === 0x1f && b[1] === 0x8b; }

async function gunzipToString(b) {
  const rs = new ReadableStream({ start(c) { c.enqueue(b); c.close(); } });
  return await new Response(rs.pipeThrough(new DecompressionStream('gzip'))).text();
}

// Fetch raw bytes for a repo-relative path across all sources. Returns Uint8Array or null.
async function fetchBytes(rel) {
  for (const base of await getSources()) {
    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort(); } catch {} }, TIMEOUT_MS);
    try {
      const r = await fetch(`${base}/${rel}`, { signal: ac.signal });
      if (!r.ok) continue; // 404 -> try next source
      return new Uint8Array(await r.arrayBuffer());
    } catch {
      // try next source
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Fetch text, preferring the gzipped variant. Falls back to the plain file when the runtime
// lacks DecompressionStream. jsDelivr may transparently gunzip, so sniff the magic bytes
// instead of trusting the file name.
async function fetchText(relGz, relPlain) {
  if (GZ) {
    const b = await fetchBytes(relGz);
    if (b) return isGz(b) ? await gunzipToString(b) : TD.decode(b);
  }
  const p = await fetchBytes(relPlain);
  return p ? TD.decode(p) : null;
}

async function fetchJsonSmart(relGz, relPlain) {
  const t = await fetchText(relGz, relPlain);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ cold start
async function loadSearch() {
  if (SEARCH) return SEARCH;
  if (loading) return loading;
  loading = (async () => {
    let meta = await fetchJsonSmart('index-slim/meta.z', 'index-slim/search.meta.json');
    if (!meta) throw new Error('cannot fetch index-slim meta (data source failed)');

    let text;
    if (GZ) {
      const b = await fetchBytes('index-slim/text.z');
      if (b) text = isGz(b) ? await gunzipToString(b) : TD.decode(b);
    }
    if (text == null) {
      // no DecompressionStream (or gz missing) -> stitch the raw UTF-8 chunks
      const n = Number(meta.textPlainChunks || 0);
      if (!n) throw new Error('cannot fetch index-slim text (data source failed)');
      const parts = [];
      for (let i = 1; i <= n; i++) {
        const b = await fetchBytes(`index-slim/plain-${i}`);
        if (!b) throw new Error(`cannot fetch index-slim/plain-${i} (data source failed)`);
        parts.push(TD.decode(b));
      }
      text = parts.join('');
    }

    const data = {
      text,
      bounds: Int32Array.from(meta.bounds),
      cat: Int32Array.from(meta.cat),
      shard: Int32Array.from(meta.shard),
      itemIdx: Int32Array.from(meta.itemIdx),
      total: meta.total,
      catCounts: meta.catCounts || null,
    };
    console.log(`[load] ${data.total} items, textLen=${data.text.length}, gz=${GZ}`);
    SEARCH = data;
    return data;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

// binary search: first item index whose bounds > pos => item spans [bounds[i-1], bounds[i])
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
    const got = await fetchJsonSmart(`index-slim/${cat}/${cat}-${n}.json`, `index-slim/${cat}/${cat}-${n}.json`);
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
    if (debug) out.debug = Object.assign({ gz: GZ, textLen: data.text.length, ref: (SRC && SRC[0]) || '' }, data.catCounts || {});
    if (queryCache.size >= QCACHE_MAX) queryCache.delete(queryCache.keys().next().value);
    queryCache.set(key, out);
    return sendJson(out);
  } catch (e) {
    return sendJson({ error: String((e && e.message) || e) }, 500);
  }
}

// ------------------------------------------------------------------ /detail
async function getHashTable() {
  if (HASH) return HASH;
  const o = await fetchJsonSmart('index-slim/hash.z', 'index-slim/hash.json');
  if (!o || !o.hashStr) return null;
  HASH = { hashStr: o.hashStr, w: o.w || 40, hashItem: Int32Array.from(o.hashItem) };
  return HASH;
}

// Fetch a single FULL shard (with files) on demand by infoHash.
export async function fetchItemFull(hash) {
  const data = await loadSearch();
  const hs = await getHashTable();
  if (!hs) throw new Error('cannot fetch index-slim/hash (data source failed)');
  const PW = hs.w;
  const h = String(hash || '').toUpperCase().slice(0, PW).padEnd(PW, '0');
  const str = hs.hashStr;
  let lo = 0, hi = hs.hashItem.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cur = str.substr(mid * PW, PW);
    if (cur === h) { found = mid; break; }
    if (cur < h) lo = mid + 1; else hi = mid - 1;
  }
  if (found === -1) return null;
  const k = hs.hashItem[found];
  const cat = CATS[data.cat[k]];
  const n = data.shard[k];
  const ii = data.itemIdx[k];
  const got = await fetchJsonSmart(`index/${cat}/${cat}-${n}.json`, `index/${cat}/${cat}-${n}.json`);
  if (!got) return null;
  const items = Array.isArray(got) ? got : (got.items || []);
  return items[ii] || null;
}

export { loadSearch };
