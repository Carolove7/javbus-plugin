// JAVBUS 适配服务 (Cloudflare Worker)
// 接收 JAVBUS 的 ?q=关键词&page=N，对拍平后的 剧集-index.json 做
// 过滤 + 分页，返回 JAVBUS 认识的 { items, total }。
//
// 部署 (wrangler):
//   1. npm i -g wrangler && wrangler login
//   2. 在 wrangler.toml 里配置变量（见底部）
//   3. wrangler deploy
//
// 变量 (dashboard / wrangler.toml [vars]):
//   INDEX_URL    拍平后的 剧集-index.json 的可公开 GET 地址
//                （建议托管在 OpenList 公开分享 / R2 / GitHub Raw）
//   INDEX_TOKEN  （可选）若 OpenList 需鉴权，填 Authorization 头的值
//
// 注意：免费版 Worker 内存 128MB，若 剧集-index.json 过大（>30MB），
// 建议放到 R2 并改为分页读取；或把本 Worker 换成读 KV 里预切好的分片。

const PAGE_SIZE = 20;

let _cache = { ts: 0, data: null };
const CACHE_TTL = 10 * 60 * 1000; // 10 分钟

async function getIndex(env) {
  const now = Date.now();
  if (_cache.data && now - _cache.ts < CACHE_TTL) return _cache.data;
  const headers = {};
  if (env.INDEX_TOKEN) headers.Authorization = env.INDEX_TOKEN;
  const r = await fetch(env.INDEX_URL, { headers });
  if (!r.ok) throw new Error('fetch index failed: ' + r.status);
  const data = await r.json();
  _cache = { ts: now, data };
  return data;
}

export default {
  async fetch(request, env) {
    try {
      const u = new URL(request.url);
      const q = (u.searchParams.get('q') || '').trim().toLowerCase();
      const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10));

      const idx = await getIndex(env);
      const all = idx.items || [];
      const filtered = q
        ? all.filter(
            (it) =>
              (it.title || '').toLowerCase().includes(q) ||
              (it.remarks || '').toLowerCase().includes(q)
          )
        : all;

      const total = filtered.length;
      const start = (page - 1) * PAGE_SIZE;
      const slice = filtered.slice(start, start + PAGE_SIZE);

      return new Response(JSON.stringify({ items: slice, total }), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
  },
};

/*
wrangler.toml 示例:
name = "javbus-juji-adapter"
main = "javbus-adapter-worker.js"
compatibility_date = "2024-09-23"

[vars]
INDEX_URL = "https://op.147771.xyz/d/file/%E5%89%A7%E9%9B%86-index.json"
# INDEX_TOKEN = "Bearer xxxx"   # 仅当 OpenList 需鉴权时填
*/
