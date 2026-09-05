// 索引等价性验证：在小数据集上构建 bigram 索引，断言 searchIndexed 与 searchScan 结果完全一致
// （total、返回顺序、分页、空查询、单字回退、含重复 bigram 的标题）。
import { searchScan, searchIndexed, finalizeData } from './search.js';

const items = [
  { i: 'a1', t: '速度与激情9', s: '1G', d: '2021' },
  { i: 'a2', t: '速度与激情', s: '2G', d: '2020' },
  { i: 'a3', t: '速度', s: '3G', d: '2019' },
  { i: 'b1', t: '你好，星期六', s: '4G', d: '2022' },
  { i: 'b2', t: '星期六现场', s: '5G', d: '2023' },
  { i: 'c1', t: 'SPEED Test', s: '6G', d: '2024' },
  // 重复 bigram：Love Me Love Me —— "lo"/"ov"/"ve"/"me" 均出现两次
  { i: 'd1', t: 'Love Me Love Me 2026', s: '7G', d: '2026' },
  { i: 'd2', t: 'Love Love Love 2025', s: '8G', d: '2025' },
  { i: 'e1', t: '速度与激情外传 速度之外', s: '9G', d: '2020' },
];
const data = finalizeData(items);

let fail = 0;
const eq = (name, got, exp) => {
  const g = JSON.stringify(got);
  const e = JSON.stringify(exp);
  const ok = g === e;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n  got=${g}\n  exp=${e}`}`);
};

// 对比 searchScan 与 searchIndexed 在所有查询上是否一致
const queries = ['', '速度', '速度与激情', 'speed', 'love', 'me', '速', '星期六', '不存在zzz'];
for (const q of queries) {
  for (const page of ['1', '2', '3']) {
    const s = searchScan(data, q, page);
    const ix = searchIndexed(data, q, page);
    eq(`q="${q}" page=${page}: total一致`, ix.total, s.total);
    eq(`q="${q}" page=${page}: 条目一致`, ix.items, s.items);
  }
}

// 重复 bigram 标题不应产生重复条目（total 不虚高、首页无 dup）
const love = searchIndexed(data, 'love', '1');
eq('love 无重复条目(total=2)', love.total, 2);
const ids = love.items.map((x) => x.i).sort();
eq('love 命中 d1,d2', ids, ['d1', 'd2']);

// 首页去重校验：把返回条目转 set，长度应与数组一致
eq('love 首页条目唯一', new Set(love.items.map((x) => x.i)).size, love.items.length);

console.log(fail === 0 ? '\nALL INDEX TESTS PASSED' : `\n${fail} TEST(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
