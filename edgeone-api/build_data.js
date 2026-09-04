// 合并 index/ 下 juji + yingshi 分片，输出为「单一逻辑集合，多物理分片」：
//   data/all-meta.json        { total, parts, updatedAt }
//   data/all-1.json ... all-N.json  每片 { items:[...] }
// 分片原因：EdgeOne 函数部署对单个文件大小有限制（实测单文件 ~22MB 可过，33MB 失败），
// 故把合并全集切成每片约 16MB 的多个文件，避免单文件超限。运行时 server.js 载入全部分片拼回一个数组。
// 数据源优先级：本地 index/（存在时） > jsDelivr 镜像 > GitHub raw。
// 用法: node build_data.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // javbus-plugin/
const OUT_DIR = path.join(__dirname, 'data');

const REPO = 'Carolove7/javbus-juji-plugin';
const BRANCH = 'master';
const SOURCES = [
  `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}`,
  `https://raw.githubusercontent.com/${REPO}/${BRANCH}`,
];

// 每片目标大小（字节）。173584 条约 193 字节/条，16MB ≈ 8.4 万条，切成 3 片足够留余量。
const CHUNK_BYTES = 16 * 1024 * 1024;

function localShards(type) {
  const dir = path.join(ROOT, 'index', type);
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${type}-`) && f.endsWith('.json'))
    .sort();
  const items = [];
  for (const f of files) {
    const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    items.push(...(obj.items || []));
  }
  return items;
}

async function fetchShards(type) {
  const items = [];
  let n = 1;
  const MAX = 500; // 安全上限，按序命名遇到 404 即停止
  while (n <= MAX) {
    const rel = `index/${type}/${type}-${n}.json`;
    let got = null;
    for (const base of SOURCES) {
      try {
        const r = await fetch(`${base}/${rel}`, { signal: AbortSignal.timeout(15000) });
        if (r.status === 404) return items; // 该序号不存在 → 已到末尾
        if (!r.ok) continue;
        got = await r.json();
        break;
      } catch {
        // 该源失败，尝试下一个
      }
    }
    if (!got) {
      if (items.length > 0) return items; // 已拿到部分，遇空洞即视为结束
      throw new Error(`无法拉取 ${rel}（所有数据源均失败，可能网络受限）`);
    }
    items.push(...(got.items || []));
    n++;
  }
  return items;
}

async function build(type) {
  const local = localShards(type);
  return local ? local : fetchShards(type);
}

function writeChunks(items, updatedAt) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 清掉旧的 all-* 分片，避免残留
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (/^all(-\d+)?\.json$/.test(f)) fs.unlinkSync(path.join(OUT_DIR, f));
  }
  // 估算每片条数：按当前平均字节/条切，保证单文件不超过 CHUNK_BYTES
  const avg = items.length ? JSON.stringify(items[0]).length || 193 : 193;
  const perChunk = Math.max(1, Math.floor(CHUNK_BYTES / avg));
  const parts = Math.max(1, Math.ceil(items.length / perChunk));
  for (let p = 1; p <= parts; p++) {
    const slice = items.slice((p - 1) * perChunk, p * perChunk);
    fs.writeFileSync(
      path.join(OUT_DIR, `all-${p}.json`),
      JSON.stringify({ items: slice })
    );
  }
  fs.writeFileSync(
    path.join(OUT_DIR, 'all-meta.json'),
    JSON.stringify({ total: items.length, parts, updatedAt })
  );
  return parts;
}

async function main() {
  const [juji, yingshi] = await Promise.all([build('juji'), build('yingshi')]);
  const items = [...juji, ...yingshi];
  const updatedAt = new Date().toISOString();
  const parts = writeChunks(items, updatedAt);
  // 汇总体积日志
  let bytes = 0;
  for (let p = 1; p <= parts; p++) bytes += fs.statSync(path.join(OUT_DIR, `all-${p}.json`)).size;
  console.log(
    `all: ${items.length} items (juji ${juji.length} + yingshi ${yingshi.length}) -> data/all-1..all-${parts}.json (${bytes} bytes, meta.parts=${parts})`
  );
  return parts;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { main as buildAll };
