// GET /health — 健康检查
export async function onRequestGet() {
  return new Response(JSON.stringify({ ok: true, service: 'javbus-search-api' }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
