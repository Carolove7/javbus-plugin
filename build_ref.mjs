// 构建期写入「部署 commit SHA」到 cloud-functions/_ref.json，
// 供 search.js 把 jsDelivr 数据源固定到该 SHA，避免 @master 的 CDN 滞后导致读到新旧混合分片。
// 无网络依赖、不会失败；git 不可用时回退 master。该文件被 .gitignore 忽略（不入库，避免陈旧 SHA）。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let ref = 'master';
try {
  ref = execSync('git rev-parse HEAD', { cwd: __dirname, encoding: 'utf8' }).trim();
} catch {
  // 无 git 环境 -> 回退 master
}
const out = path.join(__dirname, 'cloud-functions', '_ref.json');
fs.writeFileSync(out, JSON.stringify({ ref, branch: 'master' }));
console.log(`[build_ref] wrote ${out} ref=${ref}`);
