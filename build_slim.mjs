// Build index-slim from index/: (1) slim shards (drop the huge files array),
// (2) a compact search index (single concatenated search text + locator arrays).
//
// Runtime (cloud-functions/search.js) is an EdgeOne Pages Function = V8 EDGE RUNTIME, not full
// Node: no Buffer, no node:fs. Everything it downloads must therefore be plain Web-API friendly.
//
// Two hard constraints drive the layout:
//  A) jsDelivr returns HTTP 403 for GitHub files larger than ~20MB -> every stored file <20MB.
//  B) Cold start must download as little as possible (49MB took ~18s and made /search time out).
//
// The search text is extremely repetitive (items of the same work repeat remarks+tags), so gzip
// shrinks it ~20x (35.8MB -> ~2MB). Layout:
//   meta.z            = gzip(JSON meta)          <- PRIMARY (tiny)
//   search.meta.json  = plain JSON meta          <- fallback if DecompressionStream is missing
//   text.z            = gzip(whole search text)  <- PRIMARY (~2MB)
//   plain-N           = raw UTF-8 text chunks    <- fallback (needs splitting, jsDelivr 20MB cap)
//   hash.z / hash.json= infoHash lookup table for /detail only (loaded lazily, never at cold start)
//   <cat>/<cat>-N.json= slim per-shard metadata, fetched on demand for the current page only
//
// NEVER `rm -rf` the output dir here (files are git-tracked by another session).
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'index');
const DST = path.join(__dirname, 'index-slim');
const CATS = ['juji', 'yingshi', 'yuanpan'];
const CATIDX = { juji: 0, yingshi: 1, yuanpan: 2 };
const MAX = 250;
const SEP = '\u0000';
const PLAIN_CHUNK_BYTES = 10 * 1024 * 1024; // fallback chunks, well under jsDelivr's ~20MB cap

function itemsOf(obj) { return Array.isArray(obj) ? obj : (obj && Array.isArray(obj.items) ? obj.items : []); }
const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';
function writeGz(rel, buf) {
  const gz = zlib.gzipSync(buf, { level: 6 });
  fs.writeFileSync(path.join(DST, rel), gz);
  return gz.length;
}

// ---------------------------------------------------------------- step 1: slim shards
for (const cat of CATS) {
  const sdir = path.join(SRC, cat);
  const ddir = path.join(DST, cat);
  fs.mkdirSync(ddir, { recursive: true });
  for (let n = 1; n <= MAX; n++) {
    const sf = path.join(sdir, `${cat}-${n}.json`);
    if (!fs.existsSync(sf)) break;
    const arr = itemsOf(JSON.parse(fs.readFileSync(sf, 'utf8')));
    const slim = arr.map((it) => ({
      i: it.i,
      t: it.t,
      s: it.s,
      d: it.d,
      m: it.m || '',
      remarks: it.remarks || '',
      tags: Array.isArray(it.tags) ? it.tags : [],
    }));
    fs.writeFileSync(path.join(ddir, `${cat}-${n}.json`), JSON.stringify(slim));
  }
}
console.log('[slim] shards regenerated');

// ---------------------------------------------------------------- step 2: search index
function shardFiles(cat) {
  const dir = path.join(DST, cat);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => {
    const na = parseInt(a.match(/-(\d+)\.json$/)[1], 10);
    const nb = parseInt(b.match(/-(\d+)\.json$/)[1], 10);
    return na - nb;
  });
}

const textParts = [];
const bounds = [];
const catArr = [];
const shardArr = [];
const itemIdxArr = [];
const hashes = [];
const hashItem = [];
const catCounts = { juji: 0, yingshi: 0, yuanpan: 0 };
let offset = 0;
let globalIndex = 0;

for (const cat of CATS) {
  for (const f of shardFiles(cat)) {
    const n = parseInt(f.match(/-(\d+)\.json$/)[1], 10);
    const arr = itemsOf(JSON.parse(fs.readFileSync(path.join(DST, cat, f), 'utf8')));
    arr.forEach((it, idx) => {
      const tags = Array.isArray(it.tags) ? it.tags.join(' ').slice(0, 40) : '';
      const rem = String(it.remarks || '').slice(0, 80);
      const t = String(it.t || '').slice(0, 120);
      // Chinese titles live in remarks (yuanpan's `t` is an English BluRay release name),
      // so the indexed text MUST be t + remarks + tags, not just t.
      const lower = `${t} ${rem} ${tags}`.toLowerCase();
      textParts.push(lower);
      offset += lower.length + 1;
      bounds.push(offset);
      catArr.push(CATIDX[cat]);
      shardArr.push(n);
      itemIdxArr.push(idx);
      hashes.push(String(it.i || '').toUpperCase());
      hashItem.push(globalIndex);
      catCounts[cat]++;
      globalIndex++;
    });
  }
}

const text = textParts.join(SEP);

// Hashes stored as ONE fixed-width concatenated string (slashes per-string overhead).
// Only /detail needs it -> written to its own file, never downloaded at cold start.
const PW = 40;
const order = hashes.map((h, i) => i).sort((a, b) => (hashes[a] < hashes[b] ? -1 : hashes[a] > hashes[b] ? 1 : 0));
const hashStr = order.map((i) => hashes[i].slice(0, PW).padEnd(PW, '0')).join('');
const sortedHashItem = order.map((i) => hashItem[i]);

const meta = {
  total: globalIndex,
  bounds,
  cat: catArr,
  shard: shardArr,
  itemIdx: itemIdxArr,
  catCounts,
  textPlainChunks: 0,
};

// ---------------------------------------------------------------- step 3: write outputs
// --- hash table (/detail only)
const hashBuf = Buffer.from(JSON.stringify({ hashStr, hashItem: sortedHashItem, w: PW }), 'utf8');
fs.writeFileSync(path.join(DST, 'hash.json'), hashBuf);
const hashGz = writeGz('hash.z', hashBuf);

// --- meta
const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');
fs.writeFileSync(path.join(DST, 'search.meta.json'), metaBuf);

// --- search text: gzip of the whole text (primary) + raw chunks (fallback)
const textBuf = Buffer.from(text, 'utf8');
const textGz = writeGz('text.z', textBuf);

// fallback chunks must be cut on UTF-8 CHARACTER BOUNDARIES so each chunk decodes standalone
// (0b10xxxxxx = continuation byte, never a valid cut point).
let nChunks = 0;
let start = 0;
while (start < textBuf.length) {
  let end = Math.min(start + PLAIN_CHUNK_BYTES, textBuf.length);
  if (end < textBuf.length) {
    while (end > start && (textBuf[end] & 0xC0) === 0x80) end--;
    if (end === start) end = Math.min(start + PLAIN_CHUNK_BYTES, textBuf.length);
  }
  nChunks++;
  fs.writeFileSync(path.join(DST, `plain-${nChunks}`), textBuf.subarray(start, end));
  start = end;
}
meta.textPlainChunks = nChunks;
const metaGz = writeGz('meta.z', Buffer.from(JSON.stringify(meta), 'utf8'));

// remove files from the previous (pre-gzip) layout: text-1..N have no extension and would
// otherwise linger in git forever. Pattern is anchored and numeric-only.
for (const f of fs.readdirSync(DST)) {
  if (/^text-\d+$/.test(f)) fs.rmSync(path.join(DST, f));
}

console.log(`[search] ${globalIndex} items, catCounts=${JSON.stringify(catCounts)}`);
console.log(`[search] text=${mb(textBuf.length)} gz=${mb(textGz)} (${((textGz / textBuf.length) * 100).toFixed(1)}%), plain chunks=${nChunks}`);
console.log(`[search] meta=${mb(metaBuf.length)} gz=${mb(metaGz)}`);
console.log(`[search] hash=${mb(hashBuf.length)} gz=${mb(hashGz)}  (cold start downloads only meta.z + text.z = ${mb(metaGz + textGz)})`);
