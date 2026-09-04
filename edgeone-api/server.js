// JAVBUS 搜索适配服务 (EdgeOne / Node HTTP)
// 路由:
//   GET /search?q=<关键词>&page=<n>  剧集+影视 合并搜索（单一插件用这个）
//   GET /juji?q=<关键词>&page=<n>    剧集库搜索
//   GET /yingshi?q=<关键词>&page=<n> 影视库搜索
//   GET / 或 /health                  健康检查
// 数据来自本地 data/<type>-all.json（启动时载入内存），按标题 t 做大小写不敏感子串过滤。
// 返回 JAVBUS 认识的 { items, total }，items 元素为 {i,t,s,d}。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll } from './build_data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 50);
const DATA_DIR = path.join(__dirname, 'data');

const DATA = {}; // { juji: [...], yingshi: [...] }
const loading = {}; // in-flight 去重

async function loadSet(name) {
  if (DATA[name]) return DATA[name];
  if (loading[name]) return loading[name];
  loading[name] = (async () => {
    try {
      const raw = await readFile(path.join(DATA_DIR, `${name}-all.json`), 'utf8');
      const obj = JSON.parse(raw);
      DATA[name] = obj.items || [];
      console.log(`[load] ${name}: ${DATA[name].length} items`);
      return DATA[name];
    } catch {
      // 数据文件缺失（如 Makers 构建未生成 / 构建期拉取失败）：运行时即时构建兜底
      console.warn(`[load] ${name} data missing, building on demand...`);
      await buildAll();
      const raw = await readFile(path.join(DATA_DIR, `${name}-all.json`), 'utf8');
      const obj = JSON.parse(raw);
      DATA[name] = obj.items || [];
      console.log(`[load] ${name}: ${DATA[name].length} items (built on demand)`);
      return DATA[name];
    }
  })();
  try {
    return await loading[name];
  } finally {
    delete loading[name];
  }
}

// 合并搜索：剧集 + 影视 合并为一个数据集（缓存于 DATA.all）
async function loadCombined() {
  if (DATA.all) return DATA.all;
  if (loading.all) return loading.all;
  loading.all = (async () => {
    const [juji, yingshi] = await Promise.all([loadSet('juji'), loadSet('yingshi')]);
    DATA.all = [...juji, ...yingshi];
    console.log(`[load] all: ${DATA.all.length} items (juji ${juji.length} + yingshi ${yingshi.length})`);
    return DATA.all;
  })();
  try {
    return await loading.all;
  } finally {
    delete loading.all;
  }
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
      return sendJson(res, 200, { ok: true, pageSize: PAGE_SIZE, loaded: Object.keys(DATA) });
    }

    let type = null;
    if (seg === 'search' || seg === 'all' || seg.startsWith('search')) type = 'all';
    else if (seg === 'juji' || seg.startsWith('juji')) type = 'juji';
    else if (seg === 'yingshi' || seg.startsWith('yingshi')) type = 'yingshi';
    else type = (u.searchParams.get('type') || 'juji').toLowerCase();

    if (type !== 'all' && type !== 'juji' && type !== 'yingshi') {
      return sendJson(res, 400, { error: 'unknown type, use search|juji|yingshi' });
    }

    const q = u.searchParams.get('q') || '';
    const page = u.searchParams.get('page') || '1';

    const items = type === 'all' ? await loadCombined() : await loadSet(type);
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
  loadCombined().catch((e) => console.warn('preload all failed:', e.message));
});

export default server;
