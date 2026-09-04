// 合并 index/ 下的分片为 data/<type>-all.json（{"items":[...]}），供 EdgeOne 服务在启动时载入。
// 用法: node build_data.js   （在 edgeone-api/ 目录下运行）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // javbus-plugin/
const OUT_DIR = path.join(__dirname, 'data');

async function build(type) {
  const dir = path.join(ROOT, 'index', type);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${type}-`) && f.endsWith('.json'))
    .sort();
  const items = [];
  for (const f of files) {
    const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    items.push(...(obj.items || []));
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = { items };
  fs.writeFileSync(
    path.join(OUT_DIR, `${type}-all.json`),
    JSON.stringify(out, null, 0) // 紧凑；中文原样（Ensure-ASCII 默认 false）
  );
  console.log(`${type}: ${items.length} items -> data/${type}-all.json (${fs.statSync(path.join(OUT_DIR, `${type}-all.json`)).size} bytes)`);
}

for (const t of ['juji', 'yingshi']) build(t);
