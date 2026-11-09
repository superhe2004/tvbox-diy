/**
 * 把自托管单仓拆成多个「小单仓」，加快 App 拉取与站点列表加载
 *
 * 背景：output/self.json 里 253 条 JS 规则站共享同一个 drpy 引擎文件，
 * App 加载时每条都要初始化一次引擎实例；单仓塞 300 多个站点会导致
 * 拉取慢、搜索卡、低配设备内存不足重启。这里按类型切成若干小仓。
 *
 * 分片规则（每个仓都自带网盘线路 + 解析 + spider JAR，任意选一个仓都能完整用）：
 *   part-01..NN  JS 规则站按每仓 JS_PER_PART 条（默认 35）轮切 + 网盘站 + 解析
 *   part-caiji   采集站（type 0/1，纯 HTTP，轻量）+ 网盘站 + 解析
 *
 * 输出：
 *   output/split/part-*.json   各单仓
 *   output/split.json          多仓，含全量仓 + 全部分片仓 + 精简仓 + 原有上游线路
 *
 * 用法：node scripts/build-self.mjs && node scripts/build-split.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SELF_FILE = path.join(ROOT, 'output', 'self.json');
const SPLIT_DIR = path.join(ROOT, 'output', 'split');
const SPLIT_INDEX = path.join(ROOT, 'output', 'split.json');
const ALL_FILE = path.join(ROOT, 'output', 'all.json');
const BASE = (process.env.SELF_BASE || 'https://tvbox.kyovpn.dpdns.org').replace(/\/+$/, '');
const JS_PER_PART = Number(process.env.JS_PER_PART || 35);

if (!fs.existsSync(SELF_FILE)) throw new Error('缺少 output/self.json，请先运行 node scripts/build-self.mjs');
const self = JSON.parse(fs.readFileSync(SELF_FILE, 'utf8'));
const sites = self.sites || [];
const parses = self.parses || [];
const spider = self.spider || '';

// 分类：本地 JS 规则站 / 采集站 / 网盘等需要 JAR 的站点
const jsSites = [];
const caijiSites = [];
const panSites = [];
for (const s of sites) {
  const api = String(s.api || '');
  if (s.type === 0 || s.type === 1) caijiSites.push(s);
  else if (api.includes('/lib/drpy.js')) jsSites.push(s);
  else panSites.push(s);
}

function writeConfig(relName, partSites) {
  const config = { sites: partSites, lives: [], parses, flags: [], ads: [], wallpaper: '' };
  if (spider) config.spider = spider;
  const file = path.join(SPLIT_DIR, relName);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return { file, size: fs.statSync(file).size, count: partSites.length };
}

fs.mkdirSync(SPLIT_DIR, { recursive: true });
// 旧分片清掉，避免上次分片数更多时残留死链
for (const f of fs.readdirSync(SPLIT_DIR)) {
  if (/^part-.*\.json$/.test(f)) fs.unlinkSync(path.join(SPLIT_DIR, f));
}

const parts = [];
const chunkCount = Math.ceil(jsSites.length / JS_PER_PART);
for (let i = 0; i < chunkCount; i++) {
  const chunk = jsSites.slice(i * JS_PER_PART, (i + 1) * JS_PER_PART);
  const name = 'part-' + String(i + 1).padStart(2, '0') + '.json';
  const info = writeConfig(name, [...chunk, ...panSites]);
  parts.push({ name: '线路' + (i + 1) + ' 影视' + chunk.length + '站+网盘', url: `${BASE}/output/split/${name}`, ...info, kind: 'js' });
}

const caijiInfo = writeConfig('part-caiji.json', [...caijiSites, ...panSites]);
parts.push({ name: '采集专线 ' + caijiSites.length + '站+网盘', url: `${BASE}/output/split/part-caiji.json`, ...caijiInfo, kind: 'caiji' });

// 多仓索引：全量 → 各分片 → 精简 → 原有上游线路
const existing = fs.existsSync(ALL_FILE) ? JSON.parse(fs.readFileSync(ALL_FILE, 'utf8')) : { urls: [] };
const upstreamUrls = (existing.urls || []).filter((u) => !String(u.url).includes('/output/split/') && !/\/self(-lite)?\.json$/.test(String(u.url)));

const urls = [
  { name: `【全量】${sites.length}站 一次加载`, url: `${BASE}/output/self.json` },
  ...parts.map((p) => ({ name: p.name, url: p.url })),
  { name: '【精简】纯采集 免引擎', url: `${BASE}/output/self-lite.json` },
  ...upstreamUrls,
];
fs.writeFileSync(SPLIT_INDEX, JSON.stringify({ urls }, null, 2) + '\n', 'utf8');

console.log('JS 规则站 ' + jsSites.length + ' 条 → ' + chunkCount + ' 个分片（每片 ' + JS_PER_PART + '）');
console.log('采集站 ' + caijiSites.length + ' 条 → 1 个专线');
console.log('网盘站 ' + panSites.length + ' 条 → 每个分片都附带');
for (const p of parts) console.log(`  ${path.basename(p.file)}  ${p.count} 站  ${(p.size / 1024).toFixed(1)} KB`);
console.log('输出: output/split.json（' + urls.length + ' 条线路，' + (fs.statSync(SPLIT_INDEX).size / 1024).toFixed(1) + ' KB）');
