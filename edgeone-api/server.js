// JAVBUS 搜索适配服务 (EdgeOne / Node HTTP)
// 路由:
//   GET /juji?q=<关键词>&page=<n>    剧集库搜索
//   GET /yingshi?q=<关键词>&page=<n> 影视库搜索
//   GET / 或 /health                  健康检查
// 数据来自本地 data/<type>-all.json（启动时载入内存），按标题 t 做大小写不敏感子串过滤。
// 返回 JAVBUS 认识的 { items, total }，items 元素为 {i,t,s,d}。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 50);
const DATA_DIR = path.join(__dirname, 'data');

const DATA = {}; // { juji: [...], yingshi: [...] }
const loading = {}; // in-flight 去重

async function loadSet(name) {
  if (DATA[name]) return DATA[name];
  if (loading[name]) return loading[name];
  loading[name] = (async () => {
    const raw = await readFile(path.join(DATA_DIR, `${name}-all.json`), 'utf8');
    const obj = JSON.parse(raw);
    DATA[name] = obj.items || [];
    console.log(`[load] ${name}: ${DATA[name].length} items`);
    return DATA[name];
  })();
  try {
    return await loading[name];
  } finally {
    delete loading[name];
  }
}

function search(items, q, page) {
  const ql = (q || '').trim().toLowerCase();
  const filtered = ql
    ? items.filter((it) => (it.t || '').toLowerCase().includes(ql))
    : items;
  const total = filtered.length;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const start = (p - 1) * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);
  return { items: slice, total };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const seg = u.pathname.replace(/^\/+|\/+$/g, '');

    if (seg === '' || seg === 'health' || seg === 'ping') {
      return sendJson(res, 200, { ok: true, pageSize: PAGE_SIZE, loaded: Object.keys(DATA) });
    }

    let type = null;
    if (seg === 'juji' || seg.startsWith('juji')) type = 'juji';
    else if (seg === 'yingshi' || seg.startsWith('yingshi')) type = 'yingshi';
    else type = (u.searchParams.get('type') || 'juji').toLowerCase();

    if (type !== 'juji' && type !== 'yingshi') {
      return sendJson(res, 400, { error: 'unknown type, use juji|yingshi' });
    }

    const q = u.searchParams.get('q') || '';
    const page = u.searchParams.get('page') || '1';

    const items = await loadSet(type);
    return sendJson(res, 200, search(items, q, page));
  } catch (e) {
    return sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`javbus-edgeone-api listening on ${PORT} (PAGE_SIZE=${PAGE_SIZE})`);
  // 预载，避免首个请求延迟；失败不致命（首次请求时再按需加载）
  loadSet('juji').catch((e) => console.warn('preload juji failed:', e.message));
  loadSet('yingshi').catch((e) => console.warn('preload yingshi failed:', e.message));
});

export default server;
