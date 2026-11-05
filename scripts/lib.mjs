import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 常见 GitHub 加速前缀，用于把「带代理的地址」还原成上游原始地址
const PROXY_PREFIXES = [
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://ghproxy.net/',
  'https://gh.jasonzeng.dev/',
  'https://ghproxy.com/',
];

export function stripProxy(input) {
  const url = String(input).trim();
  for (const prefix of PROXY_PREFIXES) {
    if (url.startsWith(prefix)) {
      const rest = url.slice(prefix.length);
      return /^https?:\/\//i.test(rest) ? rest : 'https://' + rest;
    }
  }
  return url;
}

export function isGithubRaw(url) {
  return /^https:\/\/raw\.githubusercontent\.com\//i.test(url);
}

// 源清单里的名字可能自带「📚在线」后缀，统一去掉，避免重复拼接
export function cleanName(name) {
  return String(name)
    .replace(/📚在线$/u, '')
    .replace(/📚$/u, '')
    .trim() || '未命名';
}

export function loadConfig() {
  const file = path.join(ROOT, 'config', 'apis.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const mirrors = (Array.isArray(data.githubMirrors) && data.githubMirrors.length
    ? data.githubMirrors
    : ['https://gh-proxy.com/']
  ).slice(0, 2);
  return { mirrors, apis: Array.isArray(data.apis) ? data.apis : [] };
}

/**
 * 按「上游真实地址」去重后返回唯一接口。
 * 例如 SVIP 的直连地址与 gh-proxy 备用地址会被合并成一个上游。
 */
export function buildUpstreams() {
  const { mirrors, apis } = loadConfig();
  const groups = new Map();
  for (const item of apis) {
    if (!item || !item.url) continue;
    const url = stripProxy(item.url);
    const key = url.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, { name: cleanName(item.name), url, github: isGithubRaw(url) });
    }
  }
  return { mirrors, upstreams: [...groups.values()] };
}
