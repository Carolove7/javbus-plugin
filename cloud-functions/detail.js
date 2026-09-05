// GET /detail?hash=<infoHash>
// EdgeOne Cloud Function：把静态索引 index/ 中某条资源的「完整磁力链 + 文件列表」按 JAVBUS 协议 v1 的
// detail endpoint 形式返回，使静态库（ys-plugin.json）也能像 /mg 那样在详情页补全文件列表。
//
// 数据加载复用 search.js 的 loadData()（同一数据源：本地 _data 分片 → 回退 jsDelivr/raw 远程分片），
// 仅在首次调用时把全部条目按大写 infoHash 建索引 Map，之后命中缓存。
// 返回对象形状与 search 结果项一致（{i,t,s,d,m,files,...}），可直接被插件 fields 映射复用；
// filesPath=「files」、fileFields 由插件侧配置。
import { loadData } from './search.js';

let MAP = null;
let building = null;

async function loadMap() {
  if (MAP) return MAP;
  if (building) return building;
  building = (async () => {
    const { items } = await loadData();
    const m = new Map();
    for (const it of items) {
      if (it && it.i) m.set(String(it.i).toUpperCase(), it);
    }
    console.log(`[detail] hash map built: ${m.size} entries`);
    MAP = m;
    return m;
  })();
  try {
    return await building;
  } finally {
    building = null;
  }
}

function sendJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

export async function onRequestGet(context) {
  try {
    const u = new URL(context.request.url);
    const hash = (u.searchParams.get('hash') || '').trim().toUpperCase();
    if (!hash) return sendJson({ error: 'missing hash' }, 400);

    const map = await loadMap();
    const it = map.get(hash);
    if (!it) return sendJson({ error: 'not found', hash }, 404);

    // 透传原始条目形状（含 i/t/s/d/m/files/tags/remarks），详情页字段由插件 fields 映射
    return sendJson(it);
  } catch (e) {
    return sendJson({ error: String((e && e.message) || e) }, 500);
  }
}
