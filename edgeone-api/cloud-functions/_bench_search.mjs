// 性能基准：新实现（预计算 lowers + 堆） vs 旧实现（每请求 toLowerCase + 全量排序）
import { search } from './search.js';

const N = 173584;
const PAGE_SIZE = 50;

// 生成近似真实分布的数据：CJK + 拉丁混合标题
const items = new Array(N);
for (let i = 0; i < N; i++) {
  const kind = i % 7;
  let t;
  if (kind === 0) t = `速度与激情${i} 高清版`;
  else if (kind === 1) t = `The Matrix Resurrections ${i}`;
  else if (kind === 2) t = `你好，星期六 第${i}期`;
  else if (kind === 3) t = `影集第${i}部 速度与激情外传`;
  else if (kind === 4) t = `SPEED TEST ${i} 速度`;
  else if (kind === 5) t = `纪录片${i} 自然之美`;
  else t = `动漫合集${i} SPEED`;
  items[i] = { i: 'h' + i, t, s: '1G', d: '2020' };
}
const lowers = items.map((it) => (it.t || '').toLowerCase());
const data = { items, lowers };

// ---- 旧实现（复刻原 search.js 逻辑）----
function oldSearch(items, q, page) {
  const ql = (q || '').trim().toLowerCase();
  let filtered = items;
  if (ql) {
    filtered = items.filter((it) => (it.t || '').toLowerCase().includes(ql));
    filtered = filtered.slice().sort((a, b) => {
      const ia = (a.t || '').toLowerCase().indexOf(ql);
      const ib = (b.t || '').toLowerCase().indexOf(ql);
      return ia - ib;
    });
  }
  const total = filtered.length;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const start = (p - 1) * PAGE_SIZE;
  return { items: filtered.slice(start, start + PAGE_SIZE), total };
}

function bench(fn, label, q, page, rounds = 30) {
  // warmup
  for (let i = 0; i < 3; i++) fn(q, page);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < rounds; i++) fn(q, page);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6 / rounds;
  console.log(`  ${label.padEnd(22)} ${ms.toFixed(2).padStart(8)} ms/query`);
  return ms;
}

console.log(`数据集：${N} 条，PAGE_SIZE=${PAGE_SIZE}\n`);

const queries = [
  ['罕见词(速度与激情9)', '速度与激情9', '1'],
  ['常见词(速度)', '速度', '1'],
  ['英文(SPEED)', 'speed', '1'],
  ['深页(page=20)', '速度', '20'],
  ['超大匹配集(高频字 速)', '速', '1'],
];

console.log('旧实现（每次 toLowerCase + 全量排序）：');
for (const [name, q, p] of queries) bench((qq, pp) => oldSearch(items, qq, pp), name, q, p);

console.log('\n新实现（预计算 lowers + 堆 + 结果缓存）：');
for (const [name, q, p] of queries) bench((qq, pp) => search(data, qq, pp), name, q, p);

console.log('\n新实现 二次命中（走 queryCache，应接近 0）：');
bench((qq, pp) => search(data, qq, pp), '缓存命中', '速度', '1', 30);
