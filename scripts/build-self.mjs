/**
 * 生成单仓配置 output/self.json
 *
 * 依赖全部来自本仓库：
 *   - lib/drpy.js        由 lib/drpy.src.js 生成，import 全部改写为仓库地址
 *   - lib/模板.js          drpy 模板库
 *   - lib/cheerio.min.js   HTML 解析库
 *   - js/*.js              各站点规则（来自 config/self-sites.json）
 *   - spider/pg.jar        爬虫 JAR
 *
 * 用法：node scripts/build-self.mjs
 * 默认基准域名 https://tvbox.kyovpn.dpdns.org（Cloudflare Worker 通用转发），
 * 如需临时换地址：SELF_BASE=https://xxx node scripts/build-self.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SELF_DOMAIN = 'https://tvbox.kyovpn.dpdns.org';
const BASE = (process.env.SELF_BASE || SELF_DOMAIN).replace(/\/+$/, '');

const ROOT = process.cwd();
const JAR_PATH = path.join(ROOT, 'spider', 'pg.jar');
const SITES_FILE = path.join(ROOT, 'config', 'self-sites.json');
const ENGINE_SRC = path.join(ROOT, 'lib', 'drpy.src.js');
const ENGINE_OUT = path.join(ROOT, 'lib', 'drpy.js');
const OUT_DIR = path.join(ROOT, 'output');
const OUT_FILE = path.join(OUT_DIR, 'self.json');

function encodePath(relPath) {
  return relPath.split('/').map(encodeURIComponent).join('/');
}

function fileUrl(relPath) {
  return BASE + '/' + encodePath(relPath);
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

// 1. 改写引擎里的外部 import 为本仓库地址
const engineSource = fs.readFileSync(ENGINE_SRC, 'utf8');
const ENGINE_IMPORT_RE = /https:\/\/ghproxy\.net\/https:\/\/raw\.githubusercontent\.com\/hjdhnx\/dr_py\/main\/(libs|js)\/([^"')\s]+)/g;
const enginePatched = engineSource.replace(ENGINE_IMPORT_RE, (_match, group, rawName) => {
  const name = decodeURIComponent(rawName.split('/').pop());
  const localName = group === 'libs' ? name : name === '模板.js' ? name : null;
  if (!localName) return _match;
  return fileUrl('lib/' + localName);
});
const leftoverImport = enginePatched
  .split(/\r?\n/)
  .filter((line) => /^\s*import\s/.test(line) && /ghproxy|hjdhnx\/dr_py/.test(line));
if (leftoverImport.length) {
  throw new Error('引擎仍有未改写的外部 import: ' + leftoverImport[0].slice(0, 120));
}
fs.writeFileSync(ENGINE_OUT, enginePatched, 'utf8');

// 2. 逐条校验站点规则文件是否存在
const metas = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
const filesOnDisk = new Set(fs.readdirSync(path.join(ROOT, 'js')));
const sites = [];
const missing = [];
const usedKeys = new Set();

for (const meta of metas) {
  const ext = String(meta.ext || '');
  if (!ext.startsWith('js/')) continue;
  const fileName = ext.slice('js/'.length);
  if (!filesOnDisk.has(fileName)) {
    missing.push(ext);
    continue;
  }
  let key = String(meta.key || '');
  if (!key) key = 'js_' + crypto.createHash('md5').update(ext).digest('hex').slice(0, 8);
  let unique = key;
  let n = 2;
  while (usedKeys.has(unique)) unique = key + '_' + n++;
  usedKeys.add(unique);

  const site = {
    key: unique,
    name: String(meta.name || unique),
    type: 3,
    api: fileUrl('lib/drpy.js'),
    ext: fileUrl(ext),
  };
  if (meta.searchable != null) site.searchable = Number(meta.searchable);
  if (meta.quickSearch != null) site.quickSearch = Number(meta.quickSearch);
  if (meta.filterable != null) site.filterable = Number(meta.filterable);
  if (meta.changeable != null) site.changeable = Number(meta.changeable);
  if (meta.indexs != null) site.indexs = Number(meta.indexs);
  sites.push(site);
}

// 3. 输出配置
const config = {
  spider: fileUrl('spider/pg.jar') + ';md5;' + md5(JAR_PATH),
  sites,
  lives: [],
  parses: [],
  flags: [],
  ads: [],
  wallpaper: '',
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');

console.log('基准地址: ' + BASE);
console.log('站点: ' + sites.length + ' 条' + (missing.length ? '，跳过缺失规则 ' + missing.length + ' 条' : ''));
console.log('输出: output/self.json（' + (fs.statSync(OUT_FILE).size / 1024).toFixed(1) + ' KB）');
