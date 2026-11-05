import fs from 'node:fs';
import path from 'node:path';
import { ROOT, buildUpstreams, stripProxy } from './lib.mjs';

const HEALTH_FILE = path.join(ROOT, 'output', 'health.json');
const TIMEOUT_MS = 15000;
const CONCURRENCY = 8;

function loadPrevFailCounts() {
  try {
    const data = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    return new Map(
      (data.items || []).map((item) => [String(item.url).toLowerCase(), Number(item.failCount) || 0]),
    );
  } catch {
    return new Map();
  }
}

async function probe(rawUrl) {
  const url = stripProxy(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'TVBox-Config-Checker/1.0',
        Range: 'bytes=0-1023',
        'Cache-Control': 'no-cache',
      },
    });
    const body = await response.text().catch(() => '');
    const ok = response.status >= 200 && response.status < 400 && body.trim().length > 0;
    return {
      ok,
      status: response.status,
      ms: Date.now() - startedAt,
      error: ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      ms: Date.now() - startedAt,
      error: aborted ? 'timeout' : String((error && error.message) || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

// 只有确定性失效才计入剔除阈值：404/410 或域名解析失败。
// 403/401/423、超时等多为反爬或机房 IP 拦截，不能据此判死。
const PERMANENT_STATUS = new Set([404, 410]);

function isPermanentFailure(result) {
  if (result.ok) return false;
  if (PERMANENT_STATUS.has(result.status)) return true;
  return /ENOTFOUND|ERR_NAME_NOT_RESOLVED|EAI_AGAIN/i.test(result.error || '');
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const { upstreams } = buildUpstreams();
  const prevFails = loadPrevFailCounts();

  const items = await runPool(upstreams, CONCURRENCY, async (upstream) => {
    const result = await probe(upstream.url);
    const permanent = isPermanentFailure(result);
    const prevFailCount = prevFails.get(upstream.url.toLowerCase()) || 0;
    const failCount = result.ok ? 0 : permanent ? prevFailCount + 1 : prevFailCount;
    return { name: upstream.name, url: upstream.url, ...result, permanent, failCount };
  });

  items.sort((a, b) => (a.ok === b.ok ? a.name.localeCompare(b.name, 'zh') : a.ok ? -1 : 1));

  const payload = {
    checkedAt: new Date().toISOString(),
    stats: {
      total: items.length,
      ok: items.filter((item) => item.ok).length,
      fail: items.filter((item) => !item.ok).length,
    },
    items,
  };

  fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
  fs.writeFileSync(HEALTH_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  for (const item of items) {
    const flag = item.ok ? 'OK  ' : 'FAIL';
    console.log(`${flag} ${String(item.status).padStart(4)} ${String(item.ms).padStart(6)}ms  ${item.name}${item.ok ? '' : '  ← ' + item.error}`);
  }
  console.log(`\n检测完成：${payload.stats.ok}/${payload.stats.total} 可用，结果写入 ${HEALTH_FILE}`);
}

main().catch((error) => {
  // 检测本身失败不应中断 CI，交给下一次重试
  console.error('检测异常：', error);
});
