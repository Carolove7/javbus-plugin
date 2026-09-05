// GET /detail?hash=<infoHash>
// EdgeOne Cloud Function：把某条资源的「完整磁力链 + 文件列表」按 JAVBUS 协议 v1 的 detail endpoint 形式返回，
// 使静态库（ys-plugin.json）也能像 /mg 那样在详情页补全文件列表。
//
// 数据加载复用 search.js 的 fetchItemFull(hash)（按需按 hash 定位并拉取「单个完整分片」index/<cat>/<cat>-N.json，
// 含 files），不再把 550 万条 files 全量载入内存（那会导致 /search 冷启动 OOM/超时 500）。
// 返回对象形状与 search 结果项一致（{i,t,s,d,m,files,...}），可直接被插件 fields 映射复用；
// filesPath=「files」、fileFields 由插件侧配置。
import { fetchItemFull } from './search.js';

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

    const it = await fetchItemFull(hash);
    if (!it) return sendJson({ error: 'not found', hash }, 404);

    // 透传完整条目形状（含 i/t/s/d/m/files/tags/remarks），详情页字段由插件 fields 映射
    return sendJson(it);
  } catch (e) {
    return sendJson({ error: String((e && e.message) || e) }, 500);
  }
}
