/**
 * Cloudflare Worker：TVBOX 接口地址配置编辑器
 *
 * 按截图实现的表单式单仓配置编辑器：
 *   - 八个分区：点播源 / 直播源 / 解析地址 / VIP解析标识 / IJK配置 / 解析广告过滤 / 壁纸 / 自定义爬虫
 *   - 每个分区支持 Item 增删，字段 Key / Name / Type / Api / PlayUrl 等
 *   - 可视（表单）/ 编辑（原始 JSON）/ 清空 / 保存（浏览器 localStorage）
 *   - 测速：对点播源 Api、直播源 Url、解析地址 Url 逐条检测
 *
 * 部署前必须设置环境变量 PASSWORD（Worker → Settings → Variables and Secrets）。
 * 可选 AUTH_SECRET：登录 Cookie 的签名密钥，不设则用 PASSWORD。
 */

const COOKIE_NAME = 'tvbox_editor_auth';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
const DEFAULT_CONFIG_URL = 'https://tvbox.kyovpn.dpdns.org/';
const MIRROR_PREFIXES = ['https://gh-proxy.com/', 'https://ghfast.top/'];
const PROBE_TIMEOUT = 12000;
const MAX_BODY = 4 * 1024 * 1024;

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data) + '\n', {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function getCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(name + '=')) return decodeURIComponent(trimmed.slice(name.length + 1));
  }
  return null;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sign(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function createToken(secret) {
  const expires = Date.now() + COOKIE_MAX_AGE * 1000;
  return expires + '.' + (await sign(secret, String(expires)));
}

async function verifyToken(secret, token) {
  if (!token) return false;
  const index = token.indexOf('.');
  if (index < 0) return false;
  const expiresText = token.slice(0, index);
  const signature = token.slice(index + 1);
  const expires = Number(expiresText);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  return constantTimeEqual(await sign(secret, expiresText), signature);
}

function authSecret(env) {
  return env.AUTH_SECRET || env.PASSWORD || '';
}

async function isAuthorized(request, env) {
  const secret = authSecret(env);
  if (!secret) return false;
  return verifyToken(secret, getCookie(request, COOKIE_NAME));
}

async function readLimited(response, limit) {
  if (!response.body) return { text: await response.text(), truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= limit) {
      truncated = true;
      try { await reader.cancel(); } catch { /* 忽略 */ }
      break;
    }
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

async function probeOne(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'TVBox-Editor/1.0' },
      cf: { cacheTtl: 0 },
    });
    const ttfb = Date.now() - startedAt;
    const { text, truncated } = await readLimited(response, MAX_BODY);
    const total = Date.now() - startedAt;

    let isJson = false;
    let count = null;
    if (!truncated) {
      try {
        const parsed = JSON.parse(text);
        isJson = true;
        if (parsed && Array.isArray(parsed.urls)) count = parsed.urls.length;
        else if (parsed && Array.isArray(parsed.sites)) count = parsed.sites.length;
      } catch { isJson = false; }
    }

    const ok = response.status >= 200 && response.status < 400;
    return {
      ok, status: response.status, ttfb, ms: total, bytes: text.length,
      json: isJson, count, truncated,
      contentType: response.headers.get('content-type') || '',
      error: null,
    };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    return {
      ok: false, status: 0, ttfb: Date.now() - startedAt, ms: Date.now() - startedAt,
      bytes: 0, json: false, count: null, truncated: false, contentType: '',
      error: aborted ? '超时' : String((error && error.message) || error),
    };
  } finally {
    clearTimeout(timer);
  }
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

async function fetchConfigText(rawUrl) {
  const candidates = [rawUrl];
  if (/raw\.githubusercontent\.com/i.test(rawUrl)) {
    for (const prefix of MIRROR_PREFIXES) candidates.push(prefix + rawUrl);
  }
  const [primary, ...mirrors] = candidates;

  const tryFetch = async (url, timeout) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'TVBox-Editor/1.0' },
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await tryFetch(primary, 6000);
  } catch {
    if (!mirrors.length) throw new Error('配置地址不可访问');
    return await Promise.any(mirrors.map((url) => tryFetch(url, 8000)));
  }
}

function loginHtml(env) {
  const ready = Boolean(env.PASSWORD);
  const hint = ready ? '' : '<p class="warn">服务端尚未设置 PASSWORD 环境变量，无法登录。</p>';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · TVBOX 配置编辑器</title>' +
    '<style>' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f6f8;color:#333;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
    '.card{width:min(360px,88vw);background:#fff;border:1px solid #e3e6eb;border-radius:10px;padding:28px;box-shadow:0 6px 24px rgba(0,0,0,.06)}' +
    'h1{font-size:17px;margin:0 0 6px}p.sub{color:#8b95a3;margin:0 0 18px;font-size:13px}' +
    'input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:6px;border:1px solid #d5dae1;background:#fbfbfc;color:#333;outline:none}' +
    'input:focus{border-color:#1e88e5;background:#fff}' +
    'button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:6px;background:#1e88e5;color:#fff;font-weight:600;cursor:pointer}' +
    'button:active{background:#1872c2}' +
    '.msg{min-height:18px;color:#e53935;font-size:13px;margin-top:10px}' +
    '.warn{color:#f59e0b;font-size:13px;margin:0 0 14px}' +
    '</style></head><body><form class="card" id="f">' +
    '<h1>TVBOX 配置编辑器</h1><p class="sub">请输入访问口令</p>' + hint +
    '<input id="pw" type="password" placeholder="访问口令" autocomplete="current-password" autofocus>' +
    '<button type="submit">进入</button><div class="msg" id="msg"></div></form>' +
    '<script>' +
    'document.getElementById("f").addEventListener("submit",function(e){' +
    'e.preventDefault();var m=document.getElementById("msg");m.textContent="验证中...";' +
    'fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:document.getElementById("pw").value})})' +
    '.then(function(r){return r.json();})' +
    '.then(function(j){if(j.ok){location.href="/";}else{m.textContent=j.error||"口令错误";}})' +
    '.catch(function(){m.textContent="请求失败，请重试";});' +
    '});' +
    '</script></body></html>';
}

function editorHtml() {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>TVBOX接口地址配置编辑器</title>' +
    '<style>' +
    '*{box-sizing:border-box}' +
    'body{margin:0;background:#f5f6f8;color:#333;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
    '.page{max-width:820px;margin:0 auto;padding:22px 18px 60px}' +
    'h1{font-size:22px;margin:0 0 4px;color:#1f2937}' +
    '.sub{color:#8b95a3;font-size:13px;margin:0 0 10px}' +
    '.link{color:#1e88e5;text-decoration:none;font-size:14px;font-weight:600}' +
    '.link:hover{text-decoration:underline}' +
    '.head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px}' +
    '.head-acts{display:flex;gap:8px}' +
    '.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:14px 0 6px}' +
    '.toolbar .spacer{flex:1}' +
    'button{font:inherit;cursor:pointer;border-radius:4px;border:1px solid #d5dae1;background:#fff;color:#3c4858;padding:8px 16px}' +
    'button:hover{background:#f2f4f7}' +
    'button:disabled{opacity:.55;cursor:not-allowed}' +
    '.btn-primary{background:#1e88e5;border-color:#1e88e5;color:#fff}' +
    '.btn-primary:hover{background:#1872c2}' +
    '.btn-add{background:#4caf50;border-color:#4caf50;color:#fff}' +
    '.btn-add:hover{background:#439a46}' +
    '.btn-del{background:#f44336;border-color:#f44336;color:#fff}' +
    '.btn-del:hover{background:#d9362b}' +
    '.tabs{display:flex;flex-wrap:wrap;gap:22px;border-bottom:1px solid #e3e6eb;margin:8px 0 18px}' +
    '.tabs button{background:none;border:0;border-bottom:2px solid transparent;border-radius:0;padding:10px 2px;color:#7a8699;font-weight:500}' +
    '.tabs button.active{color:#1e88e5;border-bottom-color:#1e88e5}' +
    '.tabs button:hover{background:none;color:#1e88e5}' +
    '.sec-head{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}' +
    '.sec-title{font-size:17px;font-weight:600;color:#1f2937}' +
    '.sec-count{color:#9aa4b2;font-size:13px;margin-right:auto}' +
    'label{display:block;font-size:13px;color:#5b6777;margin:14px 0 6px}' +
    'input,select,textarea{width:100%;padding:9px 11px;border:1px solid #d5dae1;border-radius:4px;background:#fbfbfc;color:#333;font:inherit;outline:none}' +
    'input:focus,select:focus,textarea:focus{border-color:#1e88e5;background:#fff;box-shadow:0 0 0 3px rgba(30,136,229,.12)}' +
    'textarea{resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px}' +
    '.card{background:#fff;border:1px solid #e3e6eb;border-radius:8px;padding:14px 16px;margin-bottom:14px;box-shadow:0 1px 2px rgba(16,24,40,.04)}' +
    '.item-head{display:flex;align-items:center;gap:8px;padding-bottom:6px;border-bottom:1px dashed #edf0f3}' +
    '.item-title{font-weight:600;color:#3c4858}' +
    '.item-acts{margin-left:auto;display:flex;align-items:center;gap:8px}' +
    '.item-acts button{padding:5px 11px;font-size:12px}' +
    '.badge{font-size:12px;padding:4px 9px;border-radius:20px;white-space:nowrap;border:1px solid transparent}' +
    '.badge.idle{color:#98a2b3;background:#f2f4f7;border-color:#e4e7ec}' +
    '.badge.good{color:#15803d;background:#e8f7ee;border-color:#bbe5cb}' +
    '.badge.warn{color:#b45309;background:#fff7e6;border-color:#fcd9a0}' +
    '.badge.bad{color:#b91c1c;background:#fdecec;border-color:#f6c3c3}' +
    '.empty{padding:40px 0;text-align:center;color:#98a2b3;border:1px dashed #d5dae1;border-radius:8px;background:#fafbfc}' +
    '.hint{color:#8b95a3;font-size:12px;margin-top:10px;min-height:18px}' +
    '.import-box{display:none;margin-top:14px;background:#fff;border:1px solid #e3e6eb;border-radius:8px;padding:14px 16px}' +
    '.inline{display:flex;gap:8px;align-items:center}' +
    '.inline input{flex:1}' +
    '.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#1f2937;color:#fff;padding:10px 18px;border-radius:6px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .2s}' +
    '.toast.show{opacity:1}' +
    '.raw-area{width:100%;height:calc(100vh - 330px);min-height:360px}' +
    '@media(max-width:640px){.tabs{gap:14px}.head{flex-direction:column}}' +
    '</style></head><body><div class="page">' +

    '<div class="head"><div>' +
    '<h1>TVBOX接口地址配置编辑器</h1>' +
    '<p class="sub">本地记录依赖浏览器缓存，清空缓存将丢失记录</p>' +
    '<a class="link" href="' + DEFAULT_CONFIG_URL + '" target="_blank" rel="noopener">&gt;&gt;&gt; 【TVBOX最新接口获取】</a>' +
    '</div><div class="head-acts">' +
    '<button data-act="import">导入</button><button data-act="export">导出</button>' +
    '</div></div>' +

    '<div class="toolbar">' +
    '<button class="btn-primary" data-act="mode-form">可视</button>' +
    '<button class="btn-primary" data-act="mode-raw">编辑</button>' +
    '<button class="btn-primary" data-act="clear">清空</button>' +
    '<button class="btn-primary" data-act="save">保存</button>' +
    '<span class="spacer"></span>' +
    '<button data-act="test-all">测速全部</button>' +
    '</div>' +

    '<div class="tabs" id="tabs"></div>' +
    '<div class="panel" id="panel"></div>' +
    '<div class="hint" id="hint"></div>' +

    '<div class="import-box" id="importBox">' +
    '<label>从链接导入（支持 GitHub raw 与加速镜像）</label>' +
    '<div class="inline"><input id="importUrl" spellcheck="false" value="' + DEFAULT_CONFIG_URL + '">' +
    '<button data-act="import-url">读取</button></div>' +
    '<label>或粘贴 JSON（支持单仓配置或 {"urls":[...]} 多仓）</label>' +
    '<textarea id="importText" rows="8" spellcheck="false"></textarea>' +
    '<div class="inline" style="margin-top:10px"><button class="btn-primary" data-act="import-text">导入文本</button>' +
    '<button data-act="close-import">取消</button></div>' +
    '</div>' +

    '</div><div class="toast" id="toast"></div>' +

    '<script>' +
    'var LS_KEY="tvbox_editor_config_v1";' +
    'var SECTIONS=[' +
    '{id:"sites",label:"点播源",kind:"list",testable:true,fields:[' +
    '{k:"key",label:"Key",ph:"数据源标识，不可重复"},' +
    '{k:"name",label:"Name",ph:"数据源名称"},' +
    '{k:"type",label:"Type",kind:"select",options:[[0,"0-xml"],[1,"1-json"],[2,"2-爬虫源"],[3,"3-自定义爬虫"],[4,"4-服务器爬虫"]]},' +
    '{k:"api",label:"Api",ph:"数据源Api地址",test:true},' +
    '{k:"playUrl",label:"PlayUrl",ph:"站点播放地址"},' +
    '{k:"searchable",label:"可搜索",kind:"select",options:[[0,"0-不可以"],[1,"1-可以"]]},' +
    '{k:"quickSearch",label:"快速搜索",kind:"select",options:[[0,"0-不可以"],[1,"1-可以"]]},' +
    '{k:"filterable",label:"可筛选",kind:"select",options:[[0,"0-不可以"],[1,"1-可以"]]},' +
    '{k:"ext",label:"Ext",kind:"textarea",ph:"扩展参数，可留空"}' +
    ']},' +
    '{id:"lives",label:"直播源",kind:"list",testable:true,fields:[' +
    '{k:"name",label:"Name",ph:"直播源名称"},' +
    '{k:"url",label:"Url",ph:"m3u / txt 地址",test:true},' +
    '{k:"type",label:"Type",kind:"select",options:[[0,"0-m3u"],[1,"1-txt"]]},' +
    '{k:"ua",label:"User-Agent",ph:"可留空"},' +
    '{k:"ext",label:"Ext",ph:"可留空"}' +
    ']},' +
    '{id:"parses",label:"解析地址",kind:"list",testable:true,fields:[' +
    '{k:"name",label:"Name",ph:"解析名称"},' +
    '{k:"type",label:"Type",kind:"select",options:[[0,"0-默认"],[1,"1-扩展"],[2,"2-聚合"]]},' +
    '{k:"url",label:"Url",ph:"解析接口地址",test:true},' +
    '{k:"ext",label:"Ext",ph:"可留空"},' +
    '{k:"flag",label:"标识",ph:"解析标识，可留空"}' +
    ']},' +
    '{id:"flags",label:"VIP解析标识",kind:"strings",ph:"标识，例如 youku"},' +
    '{id:"ijk",label:"IJK配置",kind:"ijk"},' +
    '{id:"ads",label:"解析广告过滤",kind:"strings",ph:"过滤规则，例如 0x0a|0x0b"},' +
    '{id:"wallpaper",label:"壁纸",kind:"text",ph:"壁纸图片地址"},' +
    '{id:"spider",label:"自定义爬虫",kind:"text",ph:"爬虫 JAR 地址"}' +
    '];' +
    'var state={tab:"sites",mode:"form",data:emptyData()};' +
    'function emptyData(){return {sites:[],lives:[],parses:[],flags:[],ijk:[],ads:[],wallpaper:"",spider:""};}' +
    'function $(id){return document.getElementById(id);}' +
    'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
    'function findSec(id){for(var i=0;i<SECTIONS.length;i++){if(SECTIONS[i].id===id)return SECTIONS[i];}return null;}' +
    'function toast(t){var b=$("toast");b.textContent=t;b.className="toast show";clearTimeout(b._t);b._t=setTimeout(function(){b.className="toast";},1800);}' +
    'function hint(t){$("hint").textContent=t||"";}' +
    'function newItem(sec){' +
    'if(sec.kind==="strings")return "";' +
    'if(sec.kind==="ijk")return {group:"",options:"[]"};' +
    'var o={};sec.fields.forEach(function(f){o[f.k]=f.kind==="select"?f.options[0][0]:"";});return o;' +
    '}' +
    'function fieldHtml(sec,idx,f,val){' +
    'var attrs=" data-sec=\\""+sec+"\\" data-idx=\\""+idx+"\\" data-k=\\""+f.k+"\\"";' +
    'var out="<label>"+esc(f.label)+"</label>";' +
    'if(f.kind==="select"){' +
    'var opts="";f.options.forEach(function(o){opts+="<option value=\\""+o[0]+"\\""+(String(val)===String(o[0])?" selected":"")+">"+esc(o[1])+"</option>";});' +
    'out+="<select"+attrs+">"+opts+"</select>";' +
    '}else if(f.kind==="textarea"){' +
    'out+="<textarea"+attrs+" rows=\\"3\\" placeholder=\\""+esc(f.ph||"")+"\\">"+esc(val)+"</textarea>";' +
    '}else{' +
    'out+="<input type=\\"text\\""+attrs+" value=\\""+esc(val)+"\\" placeholder=\\""+esc(f.ph||"")+"\\" spellcheck=\\"false\\">";' +
    '}' +
    'return out;' +
    '}' +
    'function badgeHtml(secId,idx){' +
    'var it=state.data[secId][idx];var r=it&&it.__result;' +
    'if(!r)return "<span class=\\"badge idle\\" id=\\"badge-"+secId+"-"+idx+"\\">未测</span>";' +
    'var cls="good";var txt=r.status+" · "+r.ms+"ms";' +
    'if(!r.ok){cls="bad";txt=r.status?("HTTP "+r.status):"失败";}' +
    'else if(!r.json)cls="warn";' +
    'return "<span class=\\"badge "+cls+"\\" id=\\"badge-"+secId+"-"+idx+"\\" title=\\""+esc(r.error||"")+"\\">"+esc(txt)+"</span>";' +
    '}' +
    'function itemHead(sec,idx){' +
    'var acts="";' +
    'if(sec.testable)acts+="<button data-act=\\"test\\" data-sec=\\""+sec.id+"\\" data-idx=\\""+idx+"\\">测速</button>"+badgeHtml(sec.id,idx);' +
    'acts+="<button class=\\"btn-del\\" data-act=\\"del\\" data-sec=\\""+sec.id+"\\" data-idx=\\""+idx+"\\">删除</button>";' +
    'return "<div class=\\"item-head\\"><span class=\\"item-title\\">Item "+(idx+1)+"</span><div class=\\"item-acts\\">"+acts+"</div></div>";' +
    '}' +
    'function listCards(sec){' +
    'var list=state.data[sec.id];' +
    'if(!list.length)return "<div class=\\"empty\\">还没有条目，点「添加」新建一条</div>";' +
    'return list.map(function(item,i){' +
    'var body=sec.fields.map(function(f){return fieldHtml(sec.id,i,f,item[f.k]);}).join("");' +
    'return "<div class=\\"card\\">"+itemHead(sec,i)+body+"</div>";' +
    '}).join("");' +
    '}' +
    'function stringsList(sec){' +
    'var list=state.data[sec.id];' +
    'if(!list.length)return "<div class=\\"empty\\">还没有条目，点「添加」新建一条</div>";' +
    'return list.map(function(v,i){' +
    'return "<div class=\\"card\\">"+itemHead(sec,i)+"<label>内容</label>"+' +
    '"<input type=\\"text\\" data-sec=\\""+sec.id+"\\" data-idx=\\""+i+"\\" data-k=\\"_\\" value=\\""+esc(v)+"\\" placeholder=\\""+esc(sec.ph||"")+"\\" spellcheck=\\"false\\">"+"</div>";' +
    '}).join("");' +
    '}' +
    'function ijkList(sec){' +
    'var list=state.data[sec.id];' +
    'if(!list.length)return "<div class=\\"empty\\">还没有条目，点「添加」新建一条</div>";' +
    'return list.map(function(item,i){' +
    'return "<div class=\\"card\\">"+itemHead(sec,i)+' +
    '"<label>group</label><input type=\\"text\\" data-sec=\\""+sec.id+"\\" data-idx=\\""+i+"\\" data-k=\\"group\\" value=\\""+esc(item.group)+"\\" placeholder=\\"例如 软解码\\">"+' +
    '"<label>options（JSON 数组）</label><textarea data-sec=\\""+sec.id+"\\" data-idx=\\""+i+"\\" data-k=\\"options\\" rows=\\"4\\" spellcheck=\\"false\\">"+esc(item.options)+"</textarea>"+"</div>";' +
    '}).join("");' +
    '}' +
    'function textCard(sec){' +
    'var v=state.data[sec.id]||"";' +
    'return "<div class=\\"card\\"><label>"+esc(sec.label)+"</label>"+' +
    '"<input type=\\"text\\" data-sec=\\""+sec.id+"\\" data-k=\\"_\\" value=\\""+esc(v)+"\\" placeholder=\\""+esc(sec.ph||"")+"\\" spellcheck=\\"false\\"></div>";' +
    '}' +
    'function renderTabs(){' +
    'var h="";SECTIONS.forEach(function(s){h+="<button data-act=\\"tab\\" data-sec=\\""+s.id+"\\" class=\\""+(state.tab===s.id?"active":"")+"\\">"+esc(s.label)+"</button>";});' +
    '$("tabs").innerHTML=h;' +
    '}' +
    'function countOf(sec){var d=state.data[sec.id];return sec.kind==="list"||sec.kind==="strings"||sec.kind==="ijk"?d.length:(String(d||"").trim()?1:0);}' +
    'function renderForm(){' +
    'var sec=findSec(state.tab);var head="<div class=\\"sec-head\\"><span class=\\"sec-title\\">"+esc(sec.label)+"</span>"+' +
    '"<span class=\\"sec-count\\">共 "+countOf(sec)+" 项</span>";' +
    'if(sec.kind!=="text")head+="<button class=\\"btn-add\\" data-act=\\"add\\" data-sec=\\""+sec.id+"\\">添加</button>";' +
    'if(sec.testable)head+="<button data-act=\\"test-all\\" data-sec=\\""+sec.id+"\\">测速全部</button>";' +
    'head+="</div>";' +
    'var body="";' +
    'if(sec.kind==="text")body=textCard(sec);' +
    'else if(sec.kind==="strings")body=stringsList(sec);' +
    'else if(sec.kind==="ijk")body=ijkList(sec);' +
    'else body=listCards(sec);' +
    'return head+body;' +
    '}' +
    'function renderRaw(){' +
    'return "<textarea class=\\"raw-area\\" id=\\"rawArea\\" spellcheck=\\"false\\">"+esc(JSON.stringify(toConfig(),null,2))+"</textarea>"+' +
    '"<div class=\\"toolbar\\"><button class=\\"btn-primary\\" data-act=\\"apply-raw\\">应用到表单</button>"+' +
    '"<button data-act=\\"format-raw\\">格式化</button><button data-act=\\"copy-raw\\">复制</button></div>";' +
    '}' +
    'function render(){renderTabs();$("panel").innerHTML=(state.mode==="raw")?renderRaw():renderForm();}' +
    'function persist(){try{localStorage.setItem(LS_KEY,JSON.stringify(state.data));}catch(e){}}' +
    'var saveTimer=null;' +
    'function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(persist,400);}' +
    'function loadLocal(){' +
    'try{var raw=localStorage.getItem(LS_KEY);if(!raw)return;var d=JSON.parse(raw);state.data=normalize(d);}catch(e){}' +
    '}' +
    'function normalize(d){' +
    'var out=emptyData();if(!d||typeof d!=="object")return out;' +
    'SECTIONS.forEach(function(sec){' +
    'var v=d[sec.id];' +
    'if(sec.kind==="list"){out[sec.id]=Array.isArray(v)?v.map(function(it){return fillItem(sec,it);}):[];}' +
    'else if(sec.kind==="strings"){out[sec.id]=Array.isArray(v)?v.map(function(x){return String(x==null?"":x);}):[];}' +
    'else if(sec.kind==="ijk"){out[sec.id]=Array.isArray(v)?v.map(function(it){return {group:String(it&&it.group||""),options:JSON.stringify(Array.isArray(it&&it.options)?it.options:[])};}):[];}' +
    'else{out[sec.id]=String(v==null?"":v);}' +
    '});' +
    'return out;' +
    '}' +
    'function fillItem(sec,it){' +
    'var o={};sec.fields.forEach(function(f){var v=it?it[f.k]:"";if(v==null)v="";o[f.k]=(f.kind==="select"&&v!=="")?v:v;});return o;' +
    '}' +
    'function numKeys(secId){if(secId==="sites")return ["type","searchable","quickSearch","filterable"];if(secId==="lives"||secId==="parses")return ["type"];return [];}' +
    'function compact(secId,item){' +
    'var keys=numKeys(secId);var o={};' +
    'Object.keys(item).forEach(function(k){' +
    'if(k.indexOf("__")===0)return;' +
    'var v=item[k];if(v===""||v==null)return;' +
    'if(keys.indexOf(k)>=0){o[k]=Number(v);}else{o[k]=v;}' +
    '});' +
    'return o;' +
    '}' +
    'function toConfig(){' +
    'var d=state.data;var out={};' +
    'out.sites=d.sites.map(function(it){return compact("sites",it);});' +
    'out.lives=d.lives.map(function(it){return compact("lives",it);});' +
    'out.parses=d.parses.map(function(it){return compact("parses",it);});' +
    'if(d.flags.length)out.flags=d.flags.filter(function(x){return String(x).trim();});' +
    'if(d.ads.length)out.ads=d.ads.filter(function(x){return String(x).trim();});' +
    'if(d.ijk.length){' +
    'out.ijk=d.ijk.map(function(it){var opts=[];try{opts=JSON.parse(it.options||"[]");}catch(e){opts=[];}return {group:it.group||"",options:opts};});' +
    '}' +
    'if(String(d.wallpaper).trim())out.wallpaper=d.wallpaper;' +
    'if(String(d.spider).trim())out.spider=d.spider;' +
    'return out;' +
    '}' +
    'function fromConfig(cfg){' +
    'if(cfg&&Array.isArray(cfg.urls)){' +
    'toast("检测到多仓配置，已导入 "+cfg.urls.length+" 条；多仓请在 JSON 模式下查看");return false;' +
    '}' +
    'state.data=normalize(cfg);return true;' +
    '}' +
    'function addItem(secId){' +
    'var sec=findSec(secId);if(!sec||sec.kind==="text")return;' +
    'state.data[secId].push(newItem(sec));persist();render();' +
    '}' +
    'function delItem(secId,idx){' +
    'state.data[secId].splice(idx,1);persist();render();' +
    '}' +
    'function urlFieldOf(sec){for(var i=0;i<sec.fields.length;i++){if(sec.fields[i].test)return sec.fields[i];}return null;}' +
    'function probe(secId,ids,done){' +
    'var sec=findSec(secId);var f=urlFieldOf(sec);if(!f){done();return;}' +
    'var CHUNK=12;var pending=ids.slice();' +
    'function step(){' +
    'if(!pending.length){done();return;}' +
    'var part=pending.splice(0,CHUNK);' +
    'var payload=part.map(function(i){return {i:i,name:state.data[secId][i][f.k]||("Item "+(i+1)),url:state.data[secId][i][f.k]||""};});' +
    'fetch("/api/probe",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({urls:payload})})' +
    '.then(function(r){return r.json();}).then(function(j){' +
    '(j.results||[]).forEach(function(res){' +
    'var item=state.data[secId][res.i];if(!item)return;item.__result=res;' +
    'var b=document.getElementById("badge-"+secId+"-"+res.i);if(b){' +
    'var cls="good";var txt=res.status+" · "+res.ms+"ms";' +
    'if(!res.ok){cls="bad";txt=res.status?("HTTP "+res.status):"失败";}else if(!res.json){cls="warn";}' +
    'b.className="badge "+cls;b.textContent=txt;if(res.error)b.title=res.error;' +
    '}' +
    '});' +
    'toast("测速 "+Math.min(ids.length,pending.length+part.length)+"/"+ids.length);step();' +
    '}).catch(function(e){toast("测速请求失败");step();});' +
    '}' +
    'step();' +
    '}' +
    'function testAll(secId){' +
    'var sec=findSec(secId||state.tab);if(!sec||!sec.testable){toast("当前分区不支持测速");return;}' +
    'var f=urlFieldOf(sec);var ids=[];' +
    'state.data[sec.id].forEach(function(it,i){if(String(it[f.k]||"").trim())ids.push(i);});' +
    'if(!ids.length){toast("没有可测的地址");return;}' +
    'toast("测速中...");probe(sec.id,ids,function(){toast("测速完成");});' +
    '}' +
    'function download(){' +
    'var text=JSON.stringify(toConfig(),null,2);' +
    'var blob=new Blob([text],{type:"application/json"});var a=document.createElement("a");' +
    'a.href=URL.createObjectURL(blob);a.download="tvbox-config.json";a.click();' +
    'setTimeout(function(){URL.revokeObjectURL(a.href);},1000);toast("已导出");' +
    '}' +
    'function applyRaw(){' +
    'try{var cfg=JSON.parse($("rawArea").value);if(!fromConfig(cfg))return;state.mode="form";persist();render();toast("已应用到表单");}' +
    'catch(e){toast("JSON 解析失败："+e.message);}' +
    '}' +
    'document.addEventListener("click",function(e){' +
    'var btn=e.target.closest("[data-act]");if(!btn)return;' +
    'var act=btn.getAttribute("data-act");var secId=btn.getAttribute("data-sec");var idx=btn.getAttribute("data-idx");' +
    'if(act==="tab"){state.tab=secId;state.mode="form";render();return;}' +
    'if(act==="mode-form"){state.mode="form";render();return;}' +
    'if(act==="mode-raw"){state.mode="raw";render();return;}' +
    'if(act==="save"){persist();toast("已保存到浏览器缓存");return;}' +
    'if(act==="clear"){if(confirm("确定清空全部配置？此操作不可恢复。")){state.data=emptyData();persist();render();toast("已清空");}return;}' +
    'if(act==="export"){download();return;}' +
    'if(act==="import"){var box=$("importBox");box.style.display=box.style.display==="block"?"none":"block";return;}' +
    'if(act==="close-import"){$("importBox").style.display="none";return;}' +
    'if(act==="import-text"){' +
    'try{var cfg=JSON.parse($("importText").value);if(fromConfig(cfg)){state.mode="form";persist();render();toast("已导入");$("importBox").style.display="none";}}catch(err){toast("JSON 解析失败："+err.message);}return;' +
    '}' +
    'if(act==="import-url"){' +
    'var u=$("importUrl").value.trim();if(!u)return;toast("读取中...");' +
    'fetch("/api/config?url="+encodeURIComponent(u)).then(function(r){return r.json();}).then(function(j){' +
    'if(!j.ok)throw new Error(j.error||"读取失败");' +
    'var cfg=JSON.parse(j.text);if(fromConfig(cfg)){state.mode="form";persist();render();toast("已从链接导入");$("importBox").style.display="none";}' +
    '}).catch(function(err){toast(err.message);});return;' +
    '}' +
    'if(act==="add"){addItem(secId);return;}' +
    'if(act==="del"){delItem(secId,Number(idx));return;}' +
    'if(act==="test"){var it=state.data[secId][Number(idx)];var sec=findSec(secId);var f=urlFieldOf(sec);' +
    'if(!f||!String(it[f.k]||"").trim()){toast("该条目地址为空");return;}probe(secId,[Number(idx)],function(){});return;}' +
    'if(act==="test-all"){testAll(secId);return;}' +
    'if(act==="apply-raw"){applyRaw();return;}' +
    'if(act==="format-raw"){try{$("rawArea").value=JSON.stringify(JSON.parse($("rawArea").value),null,2);}catch(err){toast("无法格式化："+err.message);}return;}' +
    'if(act==="copy-raw"){try{navigator.clipboard.writeText($("rawArea").value);toast("已复制");}catch(err){toast("复制失败，请手动选择");}return;}' +
    '});' +
    'document.addEventListener("input",function(e){' +
    'var t=e.target;var secId=t.getAttribute("data-sec");if(!secId)return;' +
    'var sec=findSec(secId);if(!sec)return;' +
    'var k=t.getAttribute("data-k");var idx=t.getAttribute("data-idx");' +
    'if(sec.kind==="text"){state.data[secId]=t.value;}' +
    'else if(sec.kind==="strings"){state.data[secId][Number(idx)]=t.value;}' +
    'else{state.data[secId][Number(idx)][k]=t.value;}' +
    'scheduleSave();' +
    '});' +
    'document.addEventListener("change",function(e){' +
    'if(e.target.tagName==="SELECT"){e.target.dispatchEvent(new Event("input",{bubbles:true}));}' +
    '});' +
    'loadLocal();render();' +
    '</script></body></html>';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/api/login' && request.method === 'POST') {
      if (!env.PASSWORD) return jsonResponse({ ok: false, error: '服务端未配置 PASSWORD 环境变量' }, 500);
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: '请求格式错误' }, 400); }
      const input = String((body && body.password) || '');
      if (!constantTimeEqual(input, env.PASSWORD)) return jsonResponse({ ok: false, error: '口令错误' }, 401);
      const token = await createToken(authSecret(env));
      return jsonResponse({ ok: true }, 200, {
        'set-cookie': COOKIE_NAME + '=' + encodeURIComponent(token) +
          '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + COOKIE_MAX_AGE,
      });
    }

    if (path === '/api/logout' && request.method === 'POST') {
      return jsonResponse({ ok: true }, 200, {
        'set-cookie': COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      });
    }

    if (!(await isAuthorized(request, env))) {
      if (path.startsWith('/api/')) return jsonResponse({ ok: false, error: '未登录或登录已过期' }, 401);
      return htmlResponse(loginHtml(env), 401);
    }

    if (path === '/') return htmlResponse(editorHtml());

    if (path === '/api/config') {
      if (request.method !== 'GET') return jsonResponse({ ok: false, error: '仅支持 GET' }, 405);
      const target = url.searchParams.get('url') || DEFAULT_CONFIG_URL;
      let parsed;
      try { parsed = new URL(target); } catch { return jsonResponse({ ok: false, error: '地址格式不正确' }, 400); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return jsonResponse({ ok: false, error: '仅支持 http/https' }, 400);
      }
      try {
        const text = await fetchConfigText(parsed.toString());
        return jsonResponse({ ok: true, text, source: parsed.toString() });
      } catch (error) {
        return jsonResponse({ ok: false, error: '配置拉取失败：' + String((error && error.message) || error) }, 502);
      }
    }

    if (path === '/api/probe') {
      if (request.method !== 'POST') return jsonResponse({ ok: false, error: '仅支持 POST' }, 405);
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: '请求格式错误' }, 400); }
      const list = Array.isArray(body && body.urls) ? body.urls : [];
      if (!list.length) return jsonResponse({ ok: true, results: [] });
      if (list.length > 20) return jsonResponse({ ok: false, error: '单次最多测 20 条' }, 400);

      const results = await runPool(list, 6, async (item) => {
        const index = item && item.i;
        const target = String((item && item.url) || '').trim();
        let result;
        try {
          const parsed = new URL(target);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 http/https');
          result = await probeOne(parsed.toString(), PROBE_TIMEOUT);
        } catch (error) {
          result = {
            ok: false, status: 0, ttfb: 0, ms: 0, bytes: 0, json: false,
            count: null, truncated: false, contentType: '',
            error: target ? String((error && error.message) || error) : '地址为空',
          };
        }
        return { i: index, name: (item && item.name) || '', url: target, ...result };
      });

      return jsonResponse({ ok: true, results });
    }

    return jsonResponse({ ok: false, error: '接口不存在' }, 404);
  },
};
