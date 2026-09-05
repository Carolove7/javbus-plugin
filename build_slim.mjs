// Build index-slim: (1) slim shards from index/ (drop the huge files array), (2) search.json compact index.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'index');
const DST = path.join(__dirname, 'index-slim');
const CATS = ['juji', 'yingshi', 'yuanpan'];
const CATIDX = { juji: 0, yingshi: 1, yuanpan: 2 };
const MAX = 250;
const SEP = '\u0000';

function itemsOf(obj) { return Array.isArray(obj) ? obj : (obj && Array.isArray(obj.items) ? obj.items : []); }

// Step 1: regenerate slim shards from full index/ (drop files to keep them tiny)
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

// Step 2: build search.json from the slim shards
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
const order = hashes.map((h, i) => i).sort((a, b) => (hashes[a] < hashes[b] ? -1 : hashes[a] > hashes[b] ? 1 : 0));
// Store hashes as ONE fixed-width (40) concatenated string to slash per-string overhead (~16MB saved).
const PW = 40;
const hashStr = order.map((i) => hashes[i].slice(0, PW).padEnd(PW, '0')).join('');
const sortedHashItem = order.map((i) => hashItem[i]);

// Split into files to avoid the ~3x JSON parse overhead on the giant text string:
//  - search.meta.json: compact arrays + hash table (parsed as JSON)
//  - text-N: raw UTF-8 text chunks, decoded directly via Buffer (no JSON string escaping overhead)
//
// IMPORTANT: jsDelivr REJECTS GitHub files larger than ~20MB with HTTP 403 (verified: a single
// 39MB search.text got 403). So the text MUST be split into chunks well under that limit;
// search.js concatenates the chunk BUFFERS first and decodes once (never decode chunk-by-chunk,
// or multi-byte CJK chars straddling a boundary would corrupt).
const meta = { total: globalIndex, bounds, cat: catArr, shard: shardArr, itemIdx: itemIdxArr, hashStr, hashItem: sortedHashItem, catCounts };

const TEXT_CHUNK_BYTES = 10 * 1024 * 1024; // 10MB per chunk, safely under jsDelivr's ~20MB cap
const buf = Buffer.from(text, 'utf8');
let nChunks = 0;
for (let off = 0; off < buf.length; off += TEXT_CHUNK_BYTES) {
  nChunks++;
  fs.writeFileSync(path.join(DST, `text-${nChunks}`), buf.subarray(off, off + TEXT_CHUNK_BYTES));
}
meta.textChunks = nChunks;
// remove the legacy single-file text (it exceeded jsDelivr's cap and caused 403 -> /search 500)
const legacy = path.join(DST, 'search.text');
if (fs.existsSync(legacy)) fs.rmSync(legacy);

fs.writeFileSync(path.join(DST, 'search.meta.json'), JSON.stringify(meta));
const metaMB = (fs.statSync(path.join(DST, 'search.meta.json')).size / 1024 / 1024).toFixed(1);
const textMB = (buf.length / 1024 / 1024).toFixed(1);
console.log(`[search] ${globalIndex} items, meta=${metaMB}MB text=${textMB}MB in ${nChunks} chunks, catCounts=${JSON.stringify(catCounts)}`);
