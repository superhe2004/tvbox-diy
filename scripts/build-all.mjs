/**
 * 生成「可用多仓」output/all.json
 *
 * 与 shiguang.json 的区别：
 *   - shiguang.json 是原始上游清单，失效条目也会保留（备用/历史）
 *   - all.json 只保留「实际返回合法 JSON 且含 sites/urls」的上游，
 *     并且第一条固定是本项目自托管的单仓，保证永远至少有一个可用线路。
 *
 * 单仓镜像：
 *   App 在多仓里加载每个单仓时，会同步下载该单仓 spider 字段指向的 JAR，
 *   上游 JAR 往往慢或已失效，于是弹「拉取配置失败」，取消后其实还能用。
 *   这里把每个合法单仓配置和它的 JAR 一起镜像到本仓库：
 *     output/repo/<id>.json   单仓配置（spider 已改写为本域名）
 *     output/jar/<id>.jar     爬虫 JAR
 *   多仓条目直接指向本域名，加载速度与稳定性都由本项目保证。
 *
 * 用法：node scripts/build-all.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, buildUpstreams } from './lib.mjs';

const OUTPUT_FILE = path.join(ROOT, 'output', 'all.json');
const REPO_DIR = path.join(ROOT, 'output', 'repo');
const JAR_DIR = path.join(ROOT, 'output', 'jar');
const SELF_DOMAIN = (process.env.SELF_BASE || 'https://tvbox.kyovpn.dpdns.org').replace(/\/+$/, '');
const TIMEOUT = 15000;
const JAR_TIMEOUT = 60000;
const CONCURRENCY = 6;

function parseConfig(text) {
  const body = text.replace(/^\uFEFF/, '').trim();
  if (!body.startsWith('{')) return null;
  try {
    const json = JSON.parse(body);
    if (Array.isArray(json.sites) && json.sites.length) return { shape: 'single', count: json.sites.length, json };
    if (Array.isArray(json.urls) && json.urls.length) return { shape: 'multipan', count: json.urls.length, json };
    return null;
  } catch {
    return null;
  }
}

function shortId(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 10);
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

async function fetchBuffer(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'TVBox-Config-Builder/1.0' },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// 把单仓的 spider 指向本仓库镜像，返回可写的配置对象
async function mirrorSpider(json, configUrl) {
  const raw = String(json.spider || '').trim();
  if (!raw) return { json, note: '无 spider' };

  const [spiderUrl] = raw.split(';');
  let absolute;
  try {
    absolute = new URL(spiderUrl, configUrl).href;
  } catch {
    return { json, note: 'spider 地址无法解析' };
  }

  try {
    const bytes = await fetchBuffer(absolute, JAR_TIMEOUT);
    if (!bytes.length) throw new Error('JAR 为空');
    const hash = md5(bytes);
    fs.mkdirSync(JAR_DIR, { recursive: true });
    const jarFile = path.join(JAR_DIR, hash + '.jar');
    if (!fs.existsSync(jarFile)) fs.writeFileSync(jarFile, bytes);
    json.spider = `${SELF_DOMAIN}/output/jar/${hash}.jar;md5;${hash}`;
    return { json, note: 'spider 已镜像 ' + (bytes.length / 1024).toFixed(0) + 'KB' };
  } catch (error) {
    // 上游 JAR 已失效时保留原地址只会让 App 一直弹「拉取配置失败」，
    // 去掉后 App 会回退到内置 JAR，至少不会卡在报错上。
    delete json.spider;
    return {
      json,
      note: 'spider 下载失败已移除：' + String(error && error.message ? error.message : error).slice(0, 40),
    };
  }
}

async function check(upstream) {
  try {
    const buffer = await fetchBuffer(upstream.url, TIMEOUT);
    const text = buffer.toString('utf8');
    const parsed = parseConfig(text);
    if (!parsed) return { upstream, ok: false, reason: '不是合法 JSON 配置' };
    return { upstream, ok: true, ...parsed };
  } catch (error) {
    return { upstream, ok: false, reason: String(error && error.message ? error.message : error) };
  }
}

// 处理单个合法单仓：镜像 JAR + 落地配置文件
async function publish(item) {
  if (item.shape !== 'single') return { url: item.upstream.url, note: '多仓，保持原地址' };

  const id = shortId(item.upstream.url);
  const { json, note } = await mirrorSpider(item.json, item.upstream.url);

  fs.mkdirSync(REPO_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPO_DIR, id + '.json'), JSON.stringify(json, null, 2) + '\n', 'utf8');
  return { url: `${SELF_DOMAIN}/output/repo/${id}.json`, note };
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

// 逐条镜像（同样限制并发，避免上游限流）
const published = [];
cursor = 0;
async function publisher() {
  while (cursor < valid.length) {
    const i = cursor++;
    published[i] = await publish(valid[i]);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, 4) }, publisher));

const urls = [{ name: '【自托管】本项目内站点', url: `${SELF_DOMAIN}/output/self.json` }];
valid.forEach((item, i) => {
  const label = item.shape === 'single' ? `单仓 ${item.count} 站点` : `多仓 ${item.count} 条`;
  urls.push({ name: `${item.upstream.name}📚${label}`, url: published[i].url });
});

fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ urls }, null, 2) + '\n', 'utf8');

console.log(`上游 ${upstreams.length} 个，合法 ${valid.length} 个，剔除 ${invalid.length} 个`);
for (const item of invalid.slice(0, 8)) {
  console.log(`  剔除 ${item.upstream.name}: ${item.reason}`);
}
valid.forEach((item, i) => {
  if (item.shape === 'single') console.log(`  镜像 ${item.upstream.name}: ${published[i].note}`);
});
console.log(`输出 ${urls.length} 条 -> output/all.json`);
