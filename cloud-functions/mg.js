// GET /mg?q=<词>&page=<n>           —— JAVBUS 搜索桥接
// GET /mg?op=tools                  —— 调试：返回 MCP 服务器暴露的工具列表与入参 schema
//
// 本函数把 JAVBUS 的 GET 搜索请求，转成对 MCP 服务器 (默认 https://magnet.kiteyuan.info/mcp)
// 的 JSON-RPC 调用，再把工具结果归一化为 JAVBUS 认识的 { items:[{i,t,s,d}], total }。
//
// 配置（环境变量，在 EdgeOne 项目「环境变量」中设置，切勿写入仓库 / 公开仓库）：
//   MG_MCP_URL          默认 https://magnet.kiteyuan.info/mcp
//   MG_MCP_TOKEN        鉴权令牌（Bearer）；缺省时返回明确错误
//   MG_MCP_AUTH_HEADER  鉴权头名，默认 Authorization
//   MG_MCP_TOOL         指定搜索工具名；缺省时按名称/描述自动探测（含 search/magnet/query/磁力/搜索…）
//   MG_MCP_QUERY_PARAM  传给工具的查询参数名；缺省时按 schema 自动猜测 (q/query/keyword/name/text…)
//   MG_MCP_PAGE_PARAM   分页参数名；缺省时按 schema 自动猜测 (page/pageNum/p/offset)；猜不到则不传
//   PAGE_SIZE           默认 50
//
// 传输：MCP streamable HTTP。自动处理 SSE(text/event-stream) 与纯 JSON 两种响应，
// 并复用 Mcp-Session-Id；会话失效(404/会话不存在)时自动重新 initialize 重试一次。

const PAGE_SIZE = Math.max(1, Number(process.env.PAGE_SIZE || 50));
const MCP_URL = process.env.MG_MCP_URL || 'https://magnet.kiteyuan.info/mcp';
const MCP_TOKEN = process.env.MG_MCP_TOKEN || '';
const AUTH_HEADER = process.env.MG_MCP_AUTH_HEADER || 'Authorization';
const PROTOCOL = '2024-11-05';

let sessionId = null;
let toolsCache = null;
let toolsCacheAt = 0;

function authHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    [AUTH_HEADER]: `Bearer ${MCP_TOKEN}`,
    ...extra,
  };
}

// 解析 MCP 响应体：兼容 SSE(data: 行) 与纯 JSON
function parseBody(ct, text) {
  if ((ct || '').includes('text/event-stream')) {
    const evs = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        const d = line.slice(5).trim();
        if (d && d !== '[DONE]') {
          try { evs.push(JSON.parse(d)); } catch { /* ignore */ }
        }
      }
    }
    return evs[evs.length - 1] || null;
  }
  return text ? JSON.parse(text) : null;
}

async function rpc(method, params, id, retry = true) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: authHeaders(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    body: JSON.stringify({ jsonrpc: '2.0', id: id ?? 1, method, params: params || {} }),
    signal: AbortSignal.timeout(30000),
  });
  const sid = res.headers.get('Mcp-Session-Id');
  if (sid) sessionId = sid;
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  const data = parseBody(ct, text);
  if (!res.ok) {
    // 会话失效 → 重新初始化后重试一次
    if ((res.status === 404 || /session/i.test(text || '')) && retry && sessionId) {
      sessionId = null;
      await ensureInitialized();
      return rpc(method, params, id, false);
    }
    throw new Error(`MCP ${method} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (data && data.error) throw new Error(`MCP ${method} error: ${JSON.stringify(data.error)}`);
  return data ? data.result : null;
}

async function ensureInitialized() {
  if (sessionId) return;
  await rpc('initialize', {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'mg-bridge', version: '1.0' },
  }, 1, false);
  // notifications/initialized（无响应，fire-and-forget）
  await fetch(MCP_URL, {
    method: 'POST',
    headers: authHeaders(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).catch(() => {});
}

async function listTools() {
  const now = Date.now();
  if (toolsCache && now - toolsCacheAt < 60000) return toolsCache;
  await ensureInitialized();
  const r = await rpc('tools/list', {}, 2);
  toolsCache = (r && r.tools) || [];
  toolsCacheAt = now;
  return toolsCache;
}

function pickTool(tools) {
  if (process.env.MG_MCP_TOOL) return tools.find((t) => t.name === process.env.MG_MCP_TOOL) || null;
  const kw = ['search', 'magnet', 'query', 'find', 'torrent', '资源', '搜索', '磁力', 'bt'];
  for (const k of kw) {
    const hit = tools.find((t) =>
      (t.name || '').toLowerCase().includes(k) || (t.description || '').toLowerCase().includes(k));
    if (hit) return hit;
  }
  return tools[0] || null;
}

function pickQueryParam(tool) {
  if (process.env.MG_MCP_QUERY_PARAM) return process.env.MG_MCP_QUERY_PARAM;
  const names = Object.keys((tool && tool.inputSchema && tool.inputSchema.properties) || {}).map((n) => n.toLowerCase());
  for (const c of ['q', 'query', 'keyword', 'name', 'text', 'search', 'word', 'term', 'key']) {
    if (names.includes(c)) return c;
  }
  return names[0] || 'query';
}

function pickPageParam(tool) {
  if (process.env.MG_MCP_PAGE_PARAM) return process.env.MG_MCP_PAGE_PARAM;
  const names = Object.keys((tool && tool.inputSchema && tool.inputSchema.properties) || {}).map((n) => n.toLowerCase());
  for (const c of ['page', 'pagenum', 'p', 'offset', 'pageindex', 'pageno']) {
    if (names.includes(c)) return c;
  }
  return null;
}

// 兼容多种顶层数组键（不同 MCP 返回结构不同）
function extractArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    for (const k of ['items', 'results', 'result', 'list', 'data', 'magnets', 'records', 'hits', 'torrents', 'resources', 'rows', 'magnetList']) {
      if (Array.isArray(raw[k])) return raw[k];
    }
    for (const v of Object.values(raw)) {
      if (Array.isArray(v)) return v;
    }
  }
  return raw ? [raw] : [];
}

// 从任意值里尽力抽出 btih（标准 urn:btih: 优先，其次 40/32 位 hex）
function extractHash(thing) {
  if (thing == null) return '';
  const str = typeof thing === 'string' ? thing : JSON.stringify(thing);
  let m = str.match(/btih:([a-z0-9]+)/i);
  if (m) return m[1];
  m = str.match(/\b([a-f0-9]{40})\b/i);
  if (m) return m[1];
  m = str.match(/\b([a-f0-9]{32})\b/i);
  if (m) return m[1];
  return '';
}

const HASH_KEYS = ['infoHash', 'infohash', 'info_hash', 'hash', 'btih', 'btihash', 'infoHashV1', 'sha1', 'magnetHash', 'ih'];
const TITLE_KEYS = ['title', 'name', 'text', 't', 'filename', 'fileName', 'subject', 'topic', 'dn'];
const SIZE_KEYS = ['size', 'humanSize', 's', 'length', 'fileSize', 'filesize', 'filesizeText'];
const DATE_KEYS = ['date', 'createdAt', 'pubDate', 'd', 'time', 'publishDate', 'added', 'timestamp', 'publishTime'];

function pick(it, keys) {
  for (const k of keys) {
    const v = it[k];
    if (v != null && String(v).trim() !== '') return v;
  }
  return '';
}

function normalizeItems(raw) {
  const arr = extractArray(raw);
  return arr.map((it) => {
    // 纯文本行：尝试按 magnet 链接切出 hash 与标题
    if (typeof it === 'string') {
      const h = extractHash(it);
      const dn = (it.match(/[?&]dn=([^&]+)/i) || [])[1];
      const t = dn ? decodeURIComponent(dn.replace(/\+/g, ' ')) : it.slice(0, 120);
      return { i: h, t: String(t).trim(), s: '', d: '', m: h ? `magnet:?xt=urn:btih:${h.toUpperCase()}` : '' };
    }
    if (typeof it !== 'object' || it == null) return { i: '', t: String(it || ''), s: '', d: '', m: '' };
    // infoHash：字段名优先，其次从各类 magnet/link 字段抽，最后整条记录兜底
    const i = pick(it, HASH_KEYS)
      || extractHash(it.magnet) || extractHash(it.magnetLink) || extractHash(it.magnet_url)
      || extractHash(it.link) || extractHash(it.url) || extractHash(it);
    const t = pick(it, TITLE_KEYS);
    const s = pick(it, SIZE_KEYS);
    const d = pick(it, DATE_KEYS);
    // 直接可用的 magnet 字段
    let m = it.magnet || it.magnetLink || it.magnet_url || it.link || it.url || '';
    if (!m && i) m = `magnet:?xt=urn:btih:${String(i).toUpperCase()}`;
    else if (m && !/^magnet:/i.test(m) && i) m = `magnet:?xt=urn:btih:${String(i).toUpperCase()}`;
    return { i: String(i), t: String(t), s: String(s), d: String(d), m: String(m) };
  });
}

async function doSearch(q, page) {
  const tools = await listTools();
  const tool = pickTool(tools);
  if (!tool) throw new Error('MCP 服务器未暴露可用工具（tools/list 为空）');
  const qParam = pickQueryParam(tool);
  const pParam = pickPageParam(tool);
  const args = { [qParam]: q };
  if (pParam) args[pParam] = page;
  const r = await rpc('tools/call', { name: tool.name, arguments: args }, 3);
  // r = { content:[{type,text}], isError } 或 { result }
  let text = '';
  if (r && Array.isArray(r.content)) {
    text = r.content.map((c) => c.text || (c.data ? JSON.stringify(c.data) : '')).join('');
  } else if (typeof r === 'string') {
    text = r;
  } else if (r && r.result) {
    text = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
  }
  if (r && r.isError) throw new Error(`MCP tool ${tool.name} returned error: ${text.slice(0, 300)}`);
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  const items = normalizeItems(parsed);
  const total = (parsed && parsed.total != null) ? parsed.total : items.length;
  const start = (page - 1) * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);
  return {
    items: pageItems,
    total: total || pageItems.length,
    raw: parsed,
    tool: tool ? { name: tool.name, inputSchema: tool.inputSchema } : null,
  };
}

function sendJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

function pickDetailTool(tools) {
  const kw = ['detail', 'info', 'metadata', 'resource', '资源', '详情', '信息'];
  for (const k of kw) {
    const hit = tools.find((t) =>
      (t.name || '').toLowerCase().includes(k) || (t.description || '').toLowerCase().includes(k));
    if (hit) return hit;
  }
  return null;
}

// 从详情响应里抽取文件列表（兼容嵌套在对象任意层级的 files/fileList/contents... 数组）
function extractFiles(raw) {
  const KEYS = ['files', 'fileList', 'filelist', 'list', 'data', 'items', 'resources', 'torrents', 'contents', 'children', 'subfiles', 'fileInfos'];
  const findArr = (obj) => {
    if (Array.isArray(obj)) return obj;
    if (obj && typeof obj === 'object') {
      for (const k of KEYS) if (Array.isArray(obj[k])) return obj[k];
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) return v;
        if (v && typeof v === 'object') {
          for (const k of KEYS) if (Array.isArray(v[k])) return v[k];
        }
      }
    }
    return null;
  };
  const arr = findArr(raw);
  if (!arr) return [];
  const NAME_KEYS = ['name', 'title', 'filename', 'fileName', 'path', 'text', 'file'];
  const SIZE_KEYS = ['size', 'length', 'fileSize', 'filesize', 'humanSize', 's', 'bytes'];
  return arr.map((f) => {
    if (typeof f === 'string') return { name: f, size: '' };
    const name = NAME_KEYS.map((k) => f[k]).find((v) => v != null && String(v).trim() !== '') || '';
    const size = SIZE_KEYS.map((k) => f[k]).find((v) => v != null && String(v).trim() !== '') || '';
    return { name: String(name), size: String(size) };
  });
}

// GET /mg?op=detail&hash=<infoHash>  —— 拉取单资源详情（magnet + 文件列表）
async function doDetail(hash) {
  const tools = await listTools();
  const tool = pickDetailTool(tools) || pickTool(tools);
  if (!tool) throw new Error('MCP 服务器未暴露可用工具（tools/list 为空）');
  const lowerNames = Object.keys((tool.inputSchema && tool.inputSchema.properties) || {}).map((n) => n.toLowerCase());
  const hashParam = lowerNames.find((n) => ['infohash', 'hash', 'id', 'btih', 'ih'].includes(n)) || null;
  const args = {};
  if (hashParam) args[hashParam] = hash;
  else args[pickQueryParam(tool)] = hash; // 回退：当 query 搜
  const r = await rpc('tools/call', { name: tool.name, arguments: args }, 4);
  let text = '';
  if (r && Array.isArray(r.content)) text = r.content.map((c) => c.text || (c.data ? JSON.stringify(c.data) : '')).join('');
  else if (typeof r === 'string') text = r;
  else if (r && r.result) text = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
  if (r && r.isError) throw new Error(`MCP tool ${tool.name} returned error: ${text.slice(0, 300)}`);
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  const arr = extractArray(parsed);
  // 第一条原始记录（未归一化），文件列表常嵌套在 item 内部
  const firstRaw = (arr[0] && typeof arr[0] === 'object') ? arr[0] : (parsed && typeof parsed === 'object' ? parsed : {});
  const items = normalizeItems(parsed);
  const item = items[0] || {};
  // 优先从第一条原始记录提取文件列表（含嵌套），回退顶层
  const files = extractFiles(firstRaw).length ? extractFiles(firstRaw) : extractFiles(parsed);
  return {
    infoHash: item.i, title: item.t, magnet: item.m, size: item.s, files,
    raw: parsed, tool: { name: tool.name, inputSchema: tool.inputSchema },
  };
}

export async function onRequestGet(context) {
  try {
    const u = new URL(context.request.url);
    const op = u.searchParams.get('op');
    const dbg = u.searchParams.get('debug');
    if (op === 'tools') {
      if (!MCP_TOKEN) return sendJson({ error: 'MG_MCP_TOKEN 未配置（请在 EdgeOne 项目环境变量中设置）' }, 500);
      const tools = await listTools();
      return sendJson({ url: MCP_URL, toolCount: tools.length, tools });
    }
    if (op === 'detail') {
      if (!MCP_TOKEN) return sendJson({ error: 'MG_MCP_TOKEN 未配置（请在 EdgeOne 项目环境变量中设置）' }, 500);
      const hash = u.searchParams.get('hash') || u.searchParams.get('q') || '';
      const res = await doDetail(hash);
      if (dbg) return sendJson(res);
      const { infoHash, title, magnet, size, files } = res;
      return sendJson({ infoHash, title, magnet, size, files });
    }
    const q = u.searchParams.get('q') || '';
    const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10) || 1);
    if (!MCP_TOKEN) {
      return sendJson({ error: 'MG_MCP_TOKEN 未配置（请在 EdgeOne 项目环境变量中设置）' }, 500);
    }
    const res = await doSearch(q, page);
    if (dbg) return sendJson(res);
    const { items, total } = res;
    return sendJson({ items, total });
  } catch (e) {
    return sendJson({ error: String((e && e.message) || e) }, 500);
  }
}
