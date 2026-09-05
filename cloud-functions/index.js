// GET / — 简易信息页
export async function onRequestGet() {
  return new Response(
    JSON.stringify({
      ok: true,
      service: 'javbus-search-api',
      endpoints: ['GET /search?q=<关键词>&page=<n>', 'GET /health'],
    }),
    {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
}
