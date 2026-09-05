// 从 index/ 全量分片生成「精简搜索数据集」index-slim/：
// 仅保留搜索与返回所需字段 {i,t,s,d,m,remarks,tags}，丢弃庞大的 files 数组
// （550 万条文件，占全量 2.3GB 内存的绝大部分）。
// 这样 /search 运行时只需加载 ~73MB（而非 1.57GB 解析出 2.3GB），避免 Cloud Function OOM/超时 500。
// 注意：每当重建 index/ 分片后，必须同步重新运行本脚本，否则 index-slim/ 会滞后于 index/。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'index');
const DST = path.join(__dirname, 'index-slim');
const cats = ['yingshi', 'juji', 'yuanpan'];
const MAX = 250;

function itemsOf(obj) { return Array.isArray(obj) ? obj : (obj && Array.isArray(obj.items) ? obj.items : []); }

let total = 0, totalBytes = 0;
const t0 = Date.now();
for (const cat of cats) {
  const sdir = path.join(SRC, cat);
  const ddir = path.join(DST, cat);
  fs.mkdirSync(ddir, { recursive: true });
  for (let n = 1; n <= MAX; n++) {
    const sf = path.join(sdir, `${cat}-${n}.json`);
    if (!fs.existsSync(sf)) { if (n === 1) console.log(`[warn] ${cat} 无分片`); break; }
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
    const out = JSON.stringify(slim);
    fs.writeFileSync(path.join(ddir, `${cat}-${n}.json`), out);
    total += slim.length;
    totalBytes += out.length;
  }
}
const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[slim] 生成完成: ${total} 条, 体积 ${(totalBytes / 1024 / 1024).toFixed(1)}MB, 用时 ${sec}s`);

// 校验：与 index/ 总数一致
let srcTotal = 0;
for (const cat of cats) for (let n = 1; n <= MAX; n++) { const sf = path.join(SRC, cat, `${cat}-${n}.json`); if (!fs.existsSync(sf)) break; srcTotal += itemsOf(JSON.parse(fs.readFileSync(sf, 'utf8'))).length; }
console.log(`[check] index/ 总数=${srcTotal}  index-slim/ 总数=${total}  → ${srcTotal === total ? '一致 OK' : '不一致 !!!'}`);
