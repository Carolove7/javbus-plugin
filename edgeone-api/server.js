// JAVBUS 搜索适配服务 (EdgeOne / Node HTTP)
// 路由:
//   GET /search?q=<关键词>&page=<n>  剧集+影视 合并搜索（单一插件用这个）
//   GET / 或 /health                  健康检查
// 数据来自本地 data/all-1.json ... all-N.json（由 all-meta.json 指示片数，启动时载入内存拼回全集），
// 按标题 t 做大小写不敏感子串过滤。
// 返回 JAVBUS 认识的 { items, total }，items 元素为 {i,t,s,d}。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll } from './build_data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 50);
const DATA_DIR = path.join(__dirname, 'data');

let ALL = null;
let loading = null; // in-flight 去重

// 载入合并全集（data/all-1.json ... all-N.json，由 all-meta.json 指示片数）。
// 缺失时运行时即时构建兜底。
async function loadAll() {
  if (ALL) return ALL;
  if (loading) return loading;
  loading = (async () => {
    try {
      ALL = await readChunks();
      console.log(`[load] all: ${ALL.length} items`);
      return ALL;
    } catch {
      // 数据文件缺失（如 Makers 构建未生成 / 构建期拉取失败）：运行时即时构建兜底
      console.warn('[load] data/all-*.json missing, building on demand...');
      await buildAll();
      ALL = await readChunks();
      console.log(`[load] all: ${ALL.length} items (built on demand)`);
      return ALL;
    }
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

async function readChunks() {
  const metaRaw = await readFile(path.join(DATA_DIR, 'all-meta.json'), 'utf8');
  const meta = JSON.parse(metaRaw);
  const parts = meta.parts || 1;
  const items = [];
  for (let n = 1; n <= parts; n++) {
    const obj = JSON.parse(await readFile(path.join(DATA_DIR, `all-${n}.json`), 'utf8'));
    items.push(...(obj.items || []));
  }
  return items;
}

function search(items, q, page) {
  const ql = (q || '').trim().toLowerCase();
  let filtered = items;
  if (ql) {
    filtered = items.filter((it) => (it.t || '').toLowerCase().includes(ql));
    // 相关性排序：关键词在标题中出现位置越靠前越优先（startsWith 排最前）
    filtered = filtered.slice().sort((a, b) => {
      const ia = (a.t || '').toLowerCase().indexOf(ql);
      const ib = (b.t || '').toLowerCase().indexOf(ql);
      return ia - ib;
    });
  }
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
      return sendJson(res, 200, { ok: true, pageSize: PAGE_SIZE, loaded: !!ALL });
    }

    if (seg !== 'search') {
      return sendJson(res, 404, { error: 'not found, use /search or /health' });
    }

    const q = u.searchParams.get('q') || '';
    const page = u.searchParams.get('page') || '1';

    const items = await loadAll();
    return sendJson(res, 200, search(items, q, page));
  } catch (e) {
    return sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`javbus-edgeone-api listening on ${PORT} (PAGE_SIZE=${PAGE_SIZE})`);
  // 预载，避免首个请求延迟；失败不致命（首次请求时再按需加载）
  loadAll().catch((e) => console.warn('preload all failed:', e.message));
});

export default server;
