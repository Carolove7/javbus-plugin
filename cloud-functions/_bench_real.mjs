// 真实数据基准：加载 _data 分片，对比「全扫描」与「bigram 索引」两种搜索路径的延迟与内存。
// 用法：node _bench_real.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchScan, searchIndexed, finalizeData } from './search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '_data');

function loadData() {
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'all-meta.json'), 'utf8'));
  const items = [];
  for (let n = 1; n <= meta.parts; n++) {
    const obj = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `all-${n}.json`), 'utf8'));
    items.push(...obj.items);
  }
  return items;
}

const items = loadData();
console.log(`数据集：${items.length} 条`);

const data = finalizeData(items);
console.log('索引状态:', data.index ? '已构建' : '未构建(回退全扫描)');
const mem = process.memoryUsage();
console.log(
  `常驻内存 rss=${(mem.rss / 1024 / 1024).toFixed(1)}MB  heapUsed=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB  heapTotal=${(mem.heapTotal / 1024 / 1024).toFixed(1)}MB\n`
);

// 固定代表性查询（覆盖 CJK 双字/三字、英文、罕见长串、单字回退、无匹配）
const queries = [
  ['CJK双字 速度', '速度', '1'],
  ['CJK三字 速度与激情', '速度与激情', '1'],
  ['英文词 love', 'love', '1'],
  ['英文词 SPEED', 'SPEED', '1'],
  ['罕见长串', items[12345].t.slice(0, 8), '1'],
  ['深页 page=20', '速度', '20'],
  ['单字(回退扫描) 速', '速', '1'],
  ['无匹配', 'zzz_no_such_movie_xyz', '1'],
];

function bench(fn, label, q, page, rounds = 40) {
  for (let i = 0; i < 5; i++) fn(q, page); // warmup
  const t0 = process.hrtime.bigint();
  let total = 0;
  let hits = 0;
  for (let i = 0; i < rounds; i++) {
    const r = fn(q, page);
    if (i === 0) { total = r.total; hits = r.items.length; }
  }
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6 / rounds;
  console.log(`  ${label.padEnd(20)} ${ms.toFixed(2).padStart(8)} ms/query   (total=${total}, 首页=${hits}条)`);
  return ms;
}

console.log('全扫描 searchScan：');
const scanMs = {};
for (const [name, q, p] of queries) scanMs[name] = bench((qq, pp) => searchScan(data, qq, pp), name, q, p);

console.log('\nbigram 索引 searchIndexed：');
const idxMs = {};
for (const [name, q, p] of queries) idxMs[name] = bench((qq, pp) => searchIndexed(data, qq, pp), name, q, p);

console.log('\n加速比（扫描/索引，越高越好）：');
for (const [name] of queries) {
  const s = scanMs[name];
  const i = idxMs[name];
  const ratio = i > 0 ? (s / i).toFixed(1) + 'x' : '∞';
  console.log(`  ${name.padEnd(20)} ${ratio}`);
}
