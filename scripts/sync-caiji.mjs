/**
 * 从 hafrey1/LunaTV-config 同步采集站（CMS API），逐个探测可用性后
 * 生成 config/caiji-sites.json，供 build-self.mjs 合并进 output/self.json。
 *
 * 这些站点是标准 maccms 采集接口（api.php/provide/vod），
 * TVBox 里 type 0 = XML，type 1 = JSON，无需 spider/JS 引擎。
 *
 * 过滤规则：
 *   - 跳过 🔞 成人站（需要时可把 INCLUDE_ADULT=1 打开）
 *   - 跳过上游标注「污染/禁止搜索」的站
 *   - 标注「无法搜索/暂不支持搜索/无搜索结果」的站 searchable=0
 *   - 逐个 GET {api}?ac=list 探测，失效的直接剔除
 *
 * 用法：node scripts/sync-caiji.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SOURCE_URL = 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/main/LunaTV-config.json';
const OUT_FILE = path.join(process.cwd(), 'config', 'caiji-sites.json');
const INCLUDE_ADULT = process.env.INCLUDE_ADULT === '1';
const TIMEOUT = 15000;
const CONCURRENCY = 4;

const BAD_COMMENT = /污染|禁止/;
const NO_SEARCH = /无法搜索|暂不支持搜索|无搜索结果/;

// 上游经第三方代理 pz.v88.qzz.io 中转的地址已失效，但源站直连可用，改回直连
const API_OVERRIDE = {
  'bdzy1.com': 'https://api.apibdzy.com/api.php/provide/vod',
  'lovedan.net': 'https://lovedan.net/api.php/provide/vod',
};

// 探测偶发被运营商 RST 但人工复核可用的接口，值为其实际响应类型（1=JSON），强制保留
const FORCE_INCLUDE = {
  'https://api.ffzyapi.com/api.php/provide/vod': 1,
  'https://api.guangsuapi.com/api.php/provide/vod': 1,
  'https://cj.lziapi.com/api.php/provide/vod': 1,
};

function cleanName(raw) {
  return String(raw || '')
    .replace(/[🎬🔞]/g, '')
    .replace(/^-+|-+$/g, '')
    .trim();
}

async function probeOnce(api) {
  const sep = api.includes('?') ? '&' : '?';
  const url = api + sep + 'ac=list';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (TVBox)' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, reason: 'HTTP ' + res.status };
    const text = await res.text();
    if (!/<list|"list"|<rss|<vod|class/i.test(text)) return { ok: false, reason: '响应不像采集接口' };
    // maccms 同一接口有的默认返回 JSON 有的返回 XML，type 必须按实际响应定：
    // type 1 = JSON，type 0 = XML
    const type = /^\s*[{[]/.test(text) ? 1 : 0;
    return { ok: true, type };
  } catch (error) {
    const reason = error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? '超时' : String(error).slice(0, 40);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

// 兜底计时，防止个别请求在 undici 里挂死；失败再重试一次
async function probe(api) {
  const first = await Promise.race([
    probeOnce(api),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: '超时(兜底)' }), TIMEOUT + 3000)),
  ]);
  if (first.ok) return first;
  const retry = await Promise.race([
    probeOnce(api),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: '超时(兜底)' }), TIMEOUT + 3000)),
  ]);
  return retry.ok ? retry : first;
}

// GitHub raw 直连可能不通，按顺序回退镜像（与 worker.js 同策略）
async function fetchSource() {
  const mirrors = [
    SOURCE_URL,
    `https://gh-proxy.com/${SOURCE_URL}`,
    `https://ghfast.top/${SOURCE_URL}`,
    'https://cdn.jsdelivr.net/gh/hafrey1/LunaTV-config@main/LunaTV-config.json',
  ];
  let lastError;
  for (const url of mirrors) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('拉取 LunaTV-config 失败: ' + lastError);
}

const source = JSON.parse(await fetchSource());
const apiSite = source.api_site || {};

const candidates = [];
const skipped = [];
for (const [domain, info] of Object.entries(apiSite)) {
  const name = cleanName(info.name) || domain;
  const comment = String(info._comment || '');
  if (/🔞/.test(info.name || '') && !INCLUDE_ADULT) {
    skipped.push({ name, reason: '成人站(默认排除)' });
    continue;
  }
  if (BAD_COMMENT.test(comment)) {
    skipped.push({ name, reason: comment.trim() });
    continue;
  }
  const api = API_OVERRIDE[domain] || String(info.api || '').trim();
  if (!/^https?:\/\//.test(api)) {
    skipped.push({ name, reason: 'api 无效' });
    continue;
  }
  candidates.push({
    key: 'cj_' + crypto.createHash('md5').update(api).digest('hex').slice(0, 8),
    name: '采集 | ' + name,
    api,
    searchable: NO_SEARCH.test(comment) ? 0 : 1,
    quickSearch: 1,
    filterable: 1,
    changeable: 1,
  });
}

console.log(`候选 ${candidates.length} 个，过滤 ${skipped.length} 个，开始探测…`);

const alive = [];
const dead = [];
let cursor = 0;
async function worker() {
  while (cursor < candidates.length) {
    const i = cursor++;
    const item = candidates[i];
    const result = await probe(item.api);
    if (result.ok) {
      item.type = result.type;
      alive.push(item);
      console.log(`  ✓ ${item.name} (type ${result.type})`);
    } else if (item.api in FORCE_INCLUDE) {
      item.type = FORCE_INCLUDE[item.api];
      alive.push(item);
      console.log(`  ✓ ${item.name} (探测失败但人工复核可用，强制保留 type ${item.type})`);
    } else {
      dead.push({ name: item.name, reason: result.reason });
      console.log(`  ✗ ${item.name} (${result.reason})`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// 保持探测前的原始顺序
const ordered = candidates.filter((c) => alive.includes(c));
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(ordered, null, 2) + '\n', 'utf8');

console.log(`\n可用 ${ordered.length} 个，失效 ${dead.length} 个`);
console.log('输出: config/caiji-sites.json');
