/**
 * 从 yszzq.com（影视站长圈）同步资源：
 *   1. /ziyuan/jiexi/ 免费解析接口 -> config/jiexi.json（供 build-self 输出 parses）
 *   2. /ziyuan/api/   采集接口详情页 -> 提取 maccms API，探测后并入 config/caiji-sites.json
 *
 * 与 sync-caiji.mjs 的关系：caiji-sites.json 是两路来源的合并结果，
 * 本脚本追加新接口时按 host 去重，已有的（含 LunaTV 同步来的）不重复加入。
 *
 * 用法：node scripts/sync-yszzq.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const CAIJI_FILE = path.join(ROOT, 'config', 'caiji-sites.json');
const JIEXI_FILE = path.join(ROOT, 'config', 'jiexi.json');
const TIMEOUT = 15000;
const CONCURRENCY = 4;
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// 并发池
async function pool(items, size, fn) {
  let cursor = 0;
  const out = new Array(items.length);
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: size }, worker));
  return out;
}

/* ---------------- 一、解析接口 ---------------- */

async function syncJiexi() {
  // 免费筛选分页：第 1 页 21_1_0_0_0.html，之后 21_1_0_0_1.html …
  const pageUrls = ['https://www.yszzq.com/ziyuan/jiexi/21_1_0_0_0.html'];
  for (let n = 1; n <= 9; n++) pageUrls.push(`https://www.yszzq.com/ziyuan/jiexi/21_1_0_0_${n}.html`);

  const pages = await pool(pageUrls, 3, async (u) => {
    try {
      return await fetchText(u);
    } catch {
      return '';
    }
  });

  const items = [];
  const seen = new Set();
  for (const html of pages) {
    const articles = html.match(/<article[\s\S]*?<\/article>/g) || [];
    for (const a of articles) {
      if (/>失效</.test(a)) continue;
      const urlM = a.match(/<p>(https?:\/\/[^<]+)<\/p>/);
      const nameM = a.match(/<h2>([\s\S]*?)<\/h2>/);
      const ps = [...a.matchAll(/<p>([^<]+)<\/p>/g)].map((x) => x[1].trim());
      if (!urlM || !nameM) continue;
      const name = nameM[1].replace(/<[^>]+>/g, '').replace(/赞助/g, '').trim();
      const url = urlM[1].trim();
      const format = ps[2] || '';
      if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
      seen.add(url);
      items.push({ name, url, format });
    }
  }
  console.log(`解析接口：抓取 ${items.length} 条（已去失效），开始探测…`);

  // 探测：解析接口没有真实视频地址可验，只做活性检查（DNS/连接/HTTP 层面）
  const alive = await pool(items, CONCURRENCY, async (it) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(it.url.replace(/(\?url=).*$/, '$1'), {
          headers: UA,
          signal: AbortSignal.timeout(TIMEOUT),
          redirect: 'follow',
        });
        if (res.status < 500) return { ...it, ok: true };
      } catch { /* retry */ }
    }
    console.log(`  ✗ ${it.name} ${it.url}`);
    return { ...it, ok: false };
  });

  const good = alive.filter((x) => x.ok).map(({ name, url, format }) => ({ name, url, format }));
  fs.mkdirSync(path.dirname(JIEXI_FILE), { recursive: true });
  fs.writeFileSync(JIEXI_FILE, JSON.stringify(good, null, 2) + '\n', 'utf8');
  console.log(`解析接口：可用 ${good.length} 条 -> config/jiexi.json`);
}

/* ---------------- 二、采集接口 ---------------- */

function cleanApiName(raw) {
  return String(raw || '')
    .replace(/赞助|失效/g, '')
    .replace(/(资源站|资源网|资源)?(苹果CMS)?(采集接口大全|采集接口地址|采集规则地址|采集地址|采集接口|采集)$/g, '')
    .trim();
}

async function probeCaiji(api) {
  const url = api + '?ac=list';
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const res = await fetch(url, { headers: UA, signal: controller.signal, redirect: 'follow' });
      if (!res.ok) return { ok: false, reason: 'HTTP ' + res.status };
      const text = await res.text();
      if (!/<list|"list"|<rss|<vod|class/i.test(text)) return { ok: false, reason: '响应不像采集接口' };
      return { ok: true, type: /^\s*[{[]/.test(text) ? 1 : 0 };
    } catch (error) {
      // 重试一次
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: '超时/连接失败' };
}

async function syncCaiji() {
  const listPages = ['https://www.yszzq.com/ziyuan/api/'];
  for (let n = 2; n <= 8; n++) listPages.push(`https://www.yszzq.com/ziyuan/api/index_${n}.html`);

  const listHtml = await pool(listPages, 3, async (u) => {
    try {
      return await fetchText(u);
    } catch {
      return '';
    }
  });

  // 列表页 -> 详情页 {id, name}
  const details = new Map();
  for (const html of listHtml) {
    const articles = html.match(/<article[\s\S]*?<\/article>/g) || [];
    for (const a of articles) {
      const linkM = a.match(/\/ziyuan\/api\/(\d+)\.html/);
      const nameM = a.match(/<h2>([\s\S]*?)<\/h2>/);
      if (!linkM || !nameM) continue;
      if (/>失效</.test(a)) continue;
      const name = cleanApiName(nameM[1].replace(/<[^>]+>/g, ''));
      if (!details.has(linkM[1])) details.set(linkM[1], name);
    }
  }
  console.log(`采集接口：${details.size} 个详情页，开始抓取…`);

  // 详情页 -> 提取 /provide/vod 形式的 maccms 接口
  const found = await pool([...details.entries()], CONCURRENCY, async ([id, name]) => {
    try {
      const html = await fetchText(`https://www.yszzq.com/ziyuan/api/${id}.html`);
      const urls = new Set();
      for (const m of html.matchAll(/https?:\/\/[^\s"'<>)\]]+?\/provide\/vod[^\s"'<>)\]]*/g)) {
        // 归一化：截到 /provide/vod 为止（去掉 /at/xml/ 等后缀，探测时自动判定格式）
        const base = m[0].replace(/^(https?:\/\/[^\s"'<>)\]]+?\/provide\/vod).*$/, '$1');
        if (/^https?:\/\//.test(base)) urls.add(base);
      }
      return { name, urls: [...urls] };
    } catch {
      return { name, urls: [] };
    }
  });

  // 合并去重（按 URL），并排除已在 caiji-sites.json 里的（按 host 判重）
  const existing = JSON.parse(fs.readFileSync(CAIJI_FILE, 'utf8'));
  const existingHosts = new Set(
    existing.map((s) => {
      try {
        return new URL(s.api).host;
      } catch {
        return '';
      }
    }),
  );
  const seenUrl = new Set();
  const candidates = [];
  for (const { name, urls } of found) {
    for (const api of urls) {
      if (seenUrl.has(api)) continue;
      seenUrl.add(api);
      let host = '';
      try {
        host = new URL(api).host;
      } catch {
        continue;
      }
      if (existingHosts.has(host)) continue;
      candidates.push({
        key: 'cj_' + crypto.createHash('md5').update(api).digest('hex').slice(0, 8),
        name: '采集 | ' + (name || host),
        api,
        searchable: 1,
        quickSearch: 1,
        filterable: 1,
        changeable: 1,
      });
    }
  }
  console.log(`采集接口：新候选 ${candidates.length} 个（已排除现有 ${existing.length} 个同 host），开始探测…`);

  const probed = await pool(candidates, CONCURRENCY, async (item) => {
    const r = await probeCaiji(item.api);
    if (r.ok) {
      return { ...item, type: r.type, ok: true };
    }
    console.log(`  ✗ ${item.name} ${item.api} (${r.reason})`);
    return { ...item, ok: false };
  });

  const added = probed.filter((x) => x.ok).map(({ ok, ...rest }) => rest);
  const merged = existing.concat(added);
  fs.writeFileSync(CAIJI_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  console.log(`采集接口：新增 ${added.length} 个，合计 ${merged.length} 个 -> config/caiji-sites.json`);
}

await syncJiexi();
await syncCaiji();
