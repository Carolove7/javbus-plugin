// JAVBUS 适配服务（本地 Node 版，用于同机调试或 JAVBUS 跑在同一台机器）
// 用法:  node javbus-adapter-local.mjs [剧集-index.json]
// 默认监听 http://localhost:8787  ，JAVBUS 插件 baseUrl 填 http://<本机IP>:8787
//
// 注意：手机上的 JAVBUS 访问 localhost 不通，需填电脑局域网 IP；
// 跨设备/长期用请改用 Cloudflare Worker 版。

import http from 'node:http';
import fs from 'node:fs';

const PAGE_SIZE = 20;
const FILE = process.argv[2] || '剧集-index.json';

let cache = null;
function load() {
  if (!cache) cache = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  return cache;
}

http
  .createServer((req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      const q = (u.searchParams.get('q') || '').trim().toLowerCase();
      const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10));
      const all = load().items || [];
      const filtered = q
        ? all.filter(
            (it) =>
              (it.title || '').toLowerCase().includes(q) ||
              (it.remarks || '').toLowerCase().includes(q)
          )
        : all;
      const start = (page - 1) * PAGE_SIZE;
      const slice = filtered.slice(start, start + PAGE_SIZE);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ items: slice, total: filtered.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e) }));
    }
  })
  .listen(8787, () => console.log('JAVBUS adapter on http://localhost:8787'));
