import fs from 'node:fs';
import path from 'node:path';
import { ROOT, buildUpstreams } from './lib.mjs';

const HEALTH_FILE = path.join(ROOT, 'output', 'health.json');
const OUTPUT_FILE = path.join(ROOT, 'output', 'shiguang.json');

// 连续「确定性失效」达到该次数才剔除，避免一次网络抖动误杀可用接口
const MAX_FAILS = 3;

function loadFailCounts() {
  try {
    const data = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    return new Map(
      (data.items || []).map((item) => [String(item.url).toLowerCase(), Number(item.failCount) || 0]),
    );
  } catch {
    return new Map();
  }
}

const { mirrors, upstreams } = buildUpstreams();
const fails = loadFailCounts();

const urls = [];
const skipped = [];

for (const upstream of upstreams) {
  const failCount = fails.get(upstream.url.toLowerCase()) || 0;
  if (failCount >= MAX_FAILS) {
    skipped.push(upstream);
    continue;
  }

  urls.push({ name: `${upstream.name}📚在线`, url: upstream.url });

  // GitHub raw 地址额外生成加速镜像，降低直连失败概率
  if (upstream.github) {
    for (const mirror of mirrors) {
      urls.push({ name: `${upstream.name}📚备用`, url: mirror + upstream.url });
    }
  }
}

fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ urls }, null, 2) + '\n', 'utf8');

console.log(`上游接口 ${upstreams.length} 个 → 输出条目 ${urls.length} 条`);
if (skipped.length) {
  console.log(`已剔除连续失效接口 ${skipped.length} 个：${skipped.map((s) => s.name).join('、')}`);
}
console.log(`输出文件：${OUTPUT_FILE}`);
