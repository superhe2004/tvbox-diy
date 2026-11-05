/**
 * 生成「可用多仓」output/all.json
 *
 * 与 shiguang.json 的区别：
 *   - shiguang.json 是原始上游清单，失效条目也会保留（备用/历史）
 *   - all.json 只保留「实际返回合法 JSON 且含 sites/urls」的上游，
 *     并且第一条固定是本项目自托管的单仓，保证永远至少有一个可用线路。
 *
 * 用法：node scripts/build-all.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, buildUpstreams } from './lib.mjs';

const OUTPUT_FILE = path.join(ROOT, 'output', 'all.json');
const SELF_DOMAIN = (process.env.SELF_BASE || 'https://tvbox.kyovpn.dpdns.org').replace(/\/+$/, '');
const TIMEOUT = 12000;
const CONCURRENCY = 8;

function parseConfig(text) {
  const body = text.replace(/^\uFEFF/, '').trim();
  if (!body.startsWith('{')) return null;
  try {
    const json = JSON.parse(body);
    if (Array.isArray(json.sites) && json.sites.length) return { shape: 'single', count: json.sites.length };
    if (Array.isArray(json.urls) && json.urls.length) return { shape: 'multipan', count: json.urls.length };
    return null;
  } catch {
    return null;
  }
}

async function check(upstream) {
  try {
    const res = await fetch(upstream.url, {
      headers: { 'user-agent': 'TVBox-Config-Builder/1.0' },
      signal: AbortSignal.timeout(TIMEOUT),
      redirect: 'follow',
    });
    if (!res.ok) return { upstream, ok: false, reason: `HTTP ${res.status}` };
    const text = await res.text();
    const parsed = parseConfig(text);
    if (!parsed) return { upstream, ok: false, reason: '不是合法 JSON 配置' };
    return { upstream, ok: true, ...parsed };
  } catch (error) {
    return { upstream, ok: false, reason: String(error && error.message ? error.message : error) };
  }
}

const { upstreams } = buildUpstreams();
const results = [];
let cursor = 0;

async function worker() {
  while (cursor < upstreams.length) {
    const i = cursor++;
    results[i] = await check(upstreams[i]);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const valid = results.filter((r) => r.ok);
const invalid = results.filter((r) => !r.ok);

const urls = [{ name: '【自托管】本项目内站点', url: `${SELF_DOMAIN}/output/self.json` }];
for (const item of valid) {
  const label = item.shape === 'single' ? `单仓 ${item.count} 站点` : `多仓 ${item.count} 条`;
  urls.push({ name: `${item.upstream.name}📚${label}`, url: item.upstream.url });
}

fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ urls }, null, 2) + '\n', 'utf8');

console.log(`上游 ${upstreams.length} 个，合法 ${valid.length} 个，剔除 ${invalid.length} 个`);
for (const item of invalid.slice(0, 8)) {
  console.log(`  剔除 ${item.upstream.name}: ${item.reason}`);
}
console.log(`输出 ${urls.length} 条 -> output/all.json`);
