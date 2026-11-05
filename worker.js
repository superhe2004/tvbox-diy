/**
 * Cloudflare Worker：TVBOX 订阅反向代理（单文件版）
 *
 * 作用：用你自己的域名访问本仓库的订阅文件，
 * 避免 raw.githubusercontent.com 无法直连时订阅失效。
 *
 * 默认路由（部署后可访问的地址）：
 *   https://你的域名/                 -> output/shiguang.json
 *   https://你的域名/shiguang.json    -> output/shiguang.json
 *   https://你的域名/health.json      -> output/health.json
 *   https://你的域名/cang.json        -> cang.json
 *   https://你的域名/bdjh.json        -> bdhj.json
 *
 * 取数顺序：GitHub 直连 -> gh-proxy -> ghfast -> jsDelivr，
 * 前一个失败自动换下一个，并用 Cache API 缓存 5 分钟减轻压力。
 */

const OWNER = 'superhe2004';
const REPO = 'tvbox-diy';
const BRANCH = 'main';

// 对外路径 -> 仓库内真实文件路径
const ROUTES = {
  '/': 'output/shiguang.json',
  '/shiguang.json': 'output/shiguang.json',
  '/health.json': 'output/health.json',
  '/cang.json': 'cang.json',
  '/bdjh.json': 'bdjh.json',
};

const CACHE_TTL = 300; // 秒
const PRIMARY_TIMEOUT = 5000; // 直连超时（毫秒）
const MIRROR_TIMEOUT = 8000; // 镜像超时（毫秒）

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

// 同一个仓库文件对应的四路来源
function buildSources(relPath) {
  const raw = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${relPath}`;
  return {
    primary: raw,
    mirrors: [
      `https://gh-proxy.com/${raw}`,
      `https://ghfast.top/${raw}`,
      `https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@${BRANCH}/${relPath}`,
    ],
  };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'TVBox-Worker/1.0' },
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (!body.trim()) throw new Error('响应为空');
    // 简单校验，避免把加速站错误页当配置返回
    if (!body.trimStart().startsWith('{')) throw new Error('返回内容不是 JSON');
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function loadConfig(relPath) {
  const { primary, mirrors } = buildSources(relPath);

  // 先尝试 GitHub 直连，最快也最新
  try {
    return await fetchWithTimeout(primary, PRIMARY_TIMEOUT);
  } catch {
    // 直连失败时并发尝试三个镜像，取最先成功的
    return await Promise.any(mirrors.map((url) => fetchWithTimeout(url, MIRROR_TIMEOUT)));
  }
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

    const path = url.pathname.replace(/\/+$/, '') || '/';
    const relPath = ROUTES[path];
    if (!relPath) {
      return jsonResponse({ error: '路径不存在', path, available: Object.keys(ROUTES) }, 404);
    }

    const cacheKey = new Request(`https://${url.hostname}/__cache/${relPath}`, { method: 'GET' });
    const cache = caches.default;

    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.text();
      return new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers: {
          ...corsHeaders(),
          'content-type': 'application/json; charset=utf-8',
          'cache-control': `public, max-age=${CACHE_TTL}`,
          'x-source': 'cache',
        },
      });
    }

    try {
      const body = await loadConfig(relPath);
      const response = new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers: {
          ...corsHeaders(),
          'content-type': 'application/json; charset=utf-8',
          'cache-control': `public, max-age=${CACHE_TTL}`,
          'x-source': 'upstream',
        },
      });
      // 写入边缘缓存，后续直接命中
      await cache.put(cacheKey, new Response(body, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': `public, max-age=${CACHE_TTL}`,
        },
      }));
      return response;
    } catch (error) {
      return jsonResponse({
        error: '所有上游都不可用',
        detail: String(error && error.message ? error.message : error),
        hint: '可稍后重试，或检查仓库里的文件是否仍然存在',
      }, 502);
    }
  },
};
