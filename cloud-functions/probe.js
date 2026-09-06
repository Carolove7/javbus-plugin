// Runtime capability probe for the EdgeOne Pages Functions V8 edge runtime.
// Temporary diagnostic endpoint (GET /probe) - remove once the runtime contract is confirmed.
// Note: node builtin specifiers are built at runtime (string concat) so a bundler never tries to
// resolve them at build time; every check is guarded so this endpoint can never 500.
const g = (n) => (typeof globalThis[n] !== 'undefined' ? globalThis[n] : undefined);

async function tryImport(spec) {
  try {
    await import(spec);
    return 'ok';
  } catch (e) {
    return 'FAIL: ' + String((e && e.message) || e).slice(0, 120);
  }
}

export async function onRequestGet() {
  const out = {
    hasBuffer: typeof g('Buffer'),
    hasProcess: typeof g('process'),
    hasProcessEnv: !!g('process') && !!g('process').env,
    hasFetch: typeof g('fetch'),
    hasDecompressionStream: typeof g('DecompressionStream'),
    hasTextDecoder: typeof g('TextDecoder'),
    hasAtob: typeof g('atob'),
    hasAbortSignalTimeout: !!g('AbortSignal') && typeof g('AbortSignal').timeout,
    hasSetTimeout: typeof g('setTimeout'),
    hasReadableStream: typeof g('ReadableStream'),
    hasInt32Array: typeof g('Int32Array'),
    nodeFs: await tryImport('node:' + 'fs'),
    nodeUrl: await tryImport('node:' + 'url'),
    nodePath: await tryImport('node:' + 'path'),
  };
  try {
    const fs = await import('node:' + 'fs');
    out.readRefJson = String(fs.readFileSync('./cloud-functions/_ref.json', 'utf8')).slice(0, 80);
  } catch (e) {
    out.readRefJson = 'FAIL: ' + String((e && e.message) || e).slice(0, 120);
  }
  try {
    const m = await import('./_ref.js');
    out.dataRefModule = m && m.DATA_REF ? m.DATA_REF : 'loaded-but-empty';
  } catch (e) {
    out.dataRefModule = 'FAIL: ' + String((e && e.message) || e).slice(0, 120);
  }
  return new Response(JSON.stringify(out, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
