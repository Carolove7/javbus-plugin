// 合并 index/ 下的分片为 data/<type>-all.json（{"items":[...]}），供 EdgeOne 服务启动时载入。
// 数据源优先级：本地 index/（存在时，开发/本地用）  >  jsDelivr 镜像  >  GitHub raw。
// 这样在 EdgeOne Makers 构建环境无本地 index/ 时，也能在 build 阶段从 GitHub 拉取并合并，
// 部署包无需携带 33MB 数据，规避上传/构建体积上限，且数据源始终与仓库一致、自动最新。
// 用法: node build_data.js   （在 edgeone-api/ 目录下运行；被 server.js import 时不会自动执行）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // javbus-plugin/
const OUT_DIR = path.join(__dirname, 'data');

const REPO = 'Carolove7/javbus-juji-plugin';
const BRANCH = 'master';
// jsDelivr 在国内构建环境可达性更好，作为首选；GitHub raw 兜底。
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
      if (items.length > 0) return items; // 已拿到部分，遇到空洞即视为结束
      throw new Error(`无法拉取 ${rel}（所有数据源均失败，可能网络受限）`);
    }
    items.push(...(got.items || []));
    n++;
  }
  return items;
}

async function build(type) {
  let items = localShards(type);
  let from = 'local';
  if (!items) {
    items = await fetchShards(type);
    from = 'remote(jsdelivr/github)';
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${type}-all.json`), JSON.stringify({ items }));
  const size = fs.statSync(path.join(OUT_DIR, `${type}-all.json`)).size;
  console.log(`${type}: ${items.length} items (${from}) -> data/${type}-all.json (${size} bytes)`);
}

export async function buildAll() {
  await build('juji');
  await build('yingshi');
}

// 仅当作为 CLI 直接运行（而非被 server.js import）时才自动构建
if (import.meta.url === `file://${process.argv[1]}`) {
  buildAll().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
