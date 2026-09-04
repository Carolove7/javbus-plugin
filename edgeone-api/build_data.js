// 合并 index/ 下 juji + yingshi 分片为单个 data/all.json（{ items, total, updatedAt }）。
// 数据源优先级：本地 index/（存在时） > jsDelivr 镜像 > GitHub raw。
// 这样在 EdgeOne Makers 构建环境无本地 index/ 时，也能在 build 阶段从远程拉取并合并，
// 部署包无需携带 33MB 数据。
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

async function main() {
  const [juji, yingshi] = await Promise.all([build('juji'), build('yingshi')]);
  const items = [...juji, ...yingshi];
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'all.json'),
    JSON.stringify({ items, total: items.length, updatedAt: new Date().toISOString() })
  );
  const size = fs.statSync(path.join(OUT_DIR, 'all.json')).size;
  console.log(
    `all: ${items.length} items (juji ${juji.length} + yingshi ${yingshi.length}) -> data/all.json (${size} bytes)`
  );
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { main as buildAll };
