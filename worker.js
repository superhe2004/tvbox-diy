/**
 * Cloudflare Worker：TVBOX 订阅代理 + 仓库文件通用转发
 *
 * 作用：用你自己的域名访问本仓库的任何文件，
 * 避免 raw.githubusercontent.com 无法直连时订阅或规则失效。
 *
 * 一、固定路由（兼容原有订阅地址）
 *   /                -> output/all.json（可用多仓，含本项目自托管线路）
 *   /all.json        -> output/all.json
 *   /shiguang.json   -> output/shiguang.json（原始上游清单，含失效项）
 *   /self.json       -> output/self.json（自托管单仓，219 站点）
 *   /health.json     -> output/health.json
 *   /cang.json       -> cang.json
 *
 * 二、通用转发（路径与仓库保持一致）
 *   /output/*  /js/*  /lib/*  /spider/*  /config/*  以及任意仓库文件
 *   例如 https://你的域名/js/1080P.js   -> 仓库 js/1080P.js
 *        https://你的域名/spider/pg.jar -> 仓库 spider/pg.jar
 *        https://你的域名/lib/drpy.js   -> 仓库 lib/drpy.js
 *
 * 取数顺序：GitHub 直连 -> gh-proxy -> ghfast -> jsDelivr，
 * 前一个失败自动换下一个，并用 Cache API 缓存（JAR 缓存 1 小时）。
 */

const OWNER = 'superhe2004';
const REPO = 'tvbox-diy';
const BRANCH = 'main';

// 对外路径 -> 仓库内真实文件路径
const ROUTES = {
  '/': 'output/all.json',
  '/all.json': 'output/all.json',
  '/shiguang.json': 'output/shiguang.json',
  '/self.json': 'output/self.json',
  '/health.json': 'output/health.json',
  '/cang.json': 'cang.json',
};

const CACHE_TTL = 300; // 秒（普通文件）
const JAR_CACHE_TTL = 3600; // 秒（JAR）
const PRIMARY_TIMEOUT = 5000; // 直连超时（毫秒）
const MIRROR_TIMEOUT = 8000; // 镜像超时（毫秒）

const CONTENT_TYPES = {
  json: 'application/json; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  jar: 'application/java-archive',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': '*',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2) + '\n', {
    status,
    headers: {
      ...corsHeaders(),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function contentTypeFor(relPath) {
  const ext = relPath.split('.').pop().toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// 把请求路径解析成仓库内相对路径；非法路径返回 null
function resolveRelPath(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (ROUTES[clean]) return ROUTES[clean];

  const rel = clean.replace(/^\/+/, '');
  if (!rel) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const segments = decoded.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  if (decoded.startsWith('.')) return null;
  return decoded;
}

async function fetchResource(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'TVBox-Worker/1.0' },
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    if (!bytes.byteLength) throw new Error('响应为空');
    return { bytes, upstreamType: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

// 同一个仓库文件对应的四路来源
async function loadResource(relPath) {
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  const raw = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${encoded}`;
  const mirrors = [
    `https://gh-proxy.com/${raw}`,
    `https://ghfast.top/${raw}`,
    `https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@${BRANCH}/${encoded}`,
  ];

  let result;
  try {
    result = await fetchResource(raw, PRIMARY_TIMEOUT);
  } catch {
    result = await Promise.any(mirrors.map((url) => fetchResource(url, MIRROR_TIMEOUT)));
  }

  // 加速站失败时可能返回自己的错误网页，需要拦掉
  if (result.upstreamType.includes('text/html')) throw new Error('上游返回网页而非文件');
  return result;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: '仅支持 GET / HEAD' }, 405);
    }

    const relPath = resolveRelPath(url.pathname);
    if (!relPath) {
      return jsonResponse({ error: '路径不存在', path: url.pathname, routes: Object.keys(ROUTES) }, 404);
    }

    const ttl = /\.jar$/i.test(relPath) ? JAR_CACHE_TTL : CACHE_TTL;
    const type = contentTypeFor(relPath);
    const cacheKey = new Request(`https://${url.hostname}/__cache/${encodeURIComponent(relPath)}`, { method: 'GET' });
    const cache = caches.default;

    const hit = await cache.match(cacheKey);
    if (hit) {
      return new Response(request.method === 'HEAD' ? null : await hit.arrayBuffer(), {
        status: 200,
        headers: {
          ...corsHeaders(),
          'content-type': hit.headers.get('content-type') || type,
          'cache-control': `public, max-age=${ttl}`,
          'x-source': 'cache',
        },
      });
    }

    try {
      const { bytes } = await loadResource(relPath);
      const body = request.method === 'HEAD' ? null : bytes;
      const response = new Response(body, {
        status: 200,
        headers: {
          ...corsHeaders(),
          'content-type': type,
          'content-length': String(bytes.byteLength),
          'cache-control': `public, max-age=${ttl}`,
          'x-source': 'upstream',
        },
      });
      await cache.put(cacheKey, new Response(bytes, {
        headers: {
          'content-type': type,
          'cache-control': `public, max-age=${ttl}`,
        },
      }));
      return response;
    } catch (error) {
      return jsonResponse({
        error: '所有上游都不可用',
        path: relPath,
        detail: String(error && error.message ? error.message : error),
        hint: '可稍后重试，或检查仓库里的文件是否仍然存在',
      }, 502);
    }
  },
};
