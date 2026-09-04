// 临时单元验证：校验 search() 的过滤/排序/分页/空查询行为
import { search } from './search.js';

const items = [
  { i: 'a1', t: '速度与激情9', s: '1G', d: '2021' },
  { i: 'a2', t: '速度与激情', s: '2G', d: '2020' },
  { i: 'a3', t: '速度', s: '3G', d: '2019' },
  { i: 'b1', t: '你好，星期六', s: '4G', d: '2022' },
  { i: 'b2', t: '星期六现场', s: '5G', d: '2023' },
  { i: 'c1', t: 'SPEED Test', s: '6G', d: '2024' },
];
const lowers = items.map((it) => (it.t || '').toLowerCase());
const data = { items, lowers };

let fail = 0;
const eq = (name, got, exp) => {
  const g = JSON.stringify(got);
  const e = JSON.stringify(exp);
  const ok = g === e;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n  got=${g}\n  exp=${e}`}`);
};

// 1) 大小写不敏感子串匹配 + 匹配位置排序；三条均以“速度”开头（pos=0），按原始顺序稳定排列
let r = search(data, '速度', '1');
eq('q=速度 total', r.total, 3);
eq('q=速度 首条(原始序)是“速度与激情9”', r.items[0].i, 'a1');
eq('q=速度 次条(原始序)是“速度与激情”', r.items[1].i, 'a2');
eq('q=速度 末条(原始序)是“速度”', r.items[2].i, 'a3');

// 2) 英文大小写不敏感
r = search(data, 'speed', '1');
eq('q=speed total(忽略大小写)', r.total, 1);
eq('q=speed 命中 SPEED Test', r.items[0].i, 'c1');

// 3) 无匹配
r = search(data, '不存在的片名zzz', '1');
eq('q=无匹配 total', r.total, 0);
eq('q=无匹配 items', r.items.length, 0);

// 4) 空查询：全量分页
r = search(data, '', '1');
eq('空查询 total', r.total, items.length);
eq('空查询 首页条数=PAGE_SIZE(50) 截断到全集', r.items.length, 6);

// 5) 分页：匹配项跨页
r = search(data, '星期六', '1');
eq('q=星期六 total', r.total, 2);
// 位置："你好，星期六" 中“星期六”在位置 4；"星期六现场" 在位置 0 → 后者应排前
eq('q=星期六 首条是“星期六现场”', r.items[0].i, 'b2');

// 6) 大匹配集 + 深页：用堆只保留所需窗口，验证分页正确
const big = [];
for (let i = 0; i < 5000; i++) big.push({ i: 'x' + i, t: `影集第${i}部 速度与激情外传`, s: '1', d: '2020' });
const bigLowers = big.map((it) => it.t.toLowerCase());
const bigData = { items: big, lowers: bigLowers };
r = search(bigData, '速度', '1');
eq('大集 q=速度 total', r.total, 5000);
eq('大集 首页返回 50 条', r.items.length, 50);
// 位置：所有标题“速度”都在相同位置（索引 6），顺序应保持稳定（按原序）
eq('大集 首页首条 i', r.items[0].i, 'x0');
// 取第 3 页（start=100），验证堆窗口正确返回 x100..x149
r = search(bigData, '速度', '3');
eq('大集 第3页首条 i=x100', r.items[0].i, 'x100');
eq('大集 第3页条数', r.items.length, 50);

console.log(fail === 0 ? '\nALL TESTS PASSED' : `\n${fail} TEST(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
