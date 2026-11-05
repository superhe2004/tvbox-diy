/**
 * Cloudflare Worker：TVBOX 多仓接口在线编辑器
 *
 * 功能：
 *   1. 通过 URL 或粘贴 JSON 加载多仓配置
 *   2. 增删改、排序、筛选接口
 *   3. 服务端批量测速（状态码 / 延迟 / 体积 / JSON 合法性 / 子接口数）
 *   4. 导出标准 {"urls":[...]} 配置
 *
 * 部署前必须设置环境变量 PASSWORD（Worker → Settings → Variables and Secrets）。
 * 可选环境变量 AUTH_SECRET：用于签发登录 Cookie 的密钥，不设则用 PASSWORD。
 */

const COOKIE_NAME = 'tvbox_editor_auth';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 天（秒）
const DEFAULT_CONFIG_URL = 'https://raw.githubusercontent.com/superhe2004/tvbox-diy/main/output/shiguang.json';
const MIRROR_PREFIXES = ['https://gh-proxy.com/', 'https://ghfast.top/'];
const PROBE_TIMEOUT = 12000;
const MAX_BODY = 4 * 1024 * 1024; // 单次读取上限 4MB

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
  const parts = raw.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(name + '=')) {
      return decodeURIComponent(trimmed.slice(name.length + 1));
    }
  }
  return null;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
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
  const signature = await sign(secret, String(expires));
  return expires + '.' + signature;
}

async function verifyToken(secret, token) {
  if (!token) return false;
  const index = token.indexOf('.');
  if (index < 0) return false;
  const expiresText = token.slice(0, index);
  const signature = token.slice(index + 1);
  const expires = Number(expiresText);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const expected = await sign(secret, expiresText);
  return constantTimeEqual(expected, signature);
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
  if (!response.body) {
    const text = await response.text();
    return { text, truncated: false };
  }
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

// 测速：返回状态码、首字节延迟、总耗时、体积，以及 JSON 是否合法
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
      } catch {
        isJson = false;
      }
    }

    const ok = response.status >= 200 && response.status < 400;
    return {
      ok,
      status: response.status,
      ttfb,
      ms: total,
      bytes: text.length,
      json: isJson,
      count,
      truncated,
      contentType: response.headers.get('content-type') || '',
      error: null,
    };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      ttfb: Date.now() - startedAt,
      ms: Date.now() - startedAt,
      bytes: 0,
      json: false,
      count: null,
      truncated: false,
      contentType: '',
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

// 拉取配置：GitHub 直连失败时自动切换加速镜像
async function fetchConfigText(rawUrl) {
  const candidates = [rawUrl];
  if (/raw\.githubusercontent\.com/i.test(rawUrl)) {
    for (const prefix of MIRROR_PREFIXES) candidates.push(prefix + rawUrl);
  }

  const [primary, ...mirrors] = candidates;
  try {
    return await (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        const response = await fetch(primary, {
          signal: controller.signal,
          redirect: 'follow',
          headers: { 'user-agent': 'TVBox-Editor/1.0' },
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return await response.text();
      } finally {
        clearTimeout(timer);
      }
    })();
  } catch {
    if (!mirrors.length) throw new Error('配置地址不可访问');
    const bodies = mirrors.map(async (url) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
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
    });
    return await Promise.any(bodies);
  }
}

function loginHtml(env) {
  const ready = Boolean(env.PASSWORD);
  const hint = ready ? '' : '<p class="warn">服务端尚未设置 PASSWORD 环境变量，无法登录。</p>';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · TVBOX 接口编辑器</title>' +
    '<style>' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1216;color:#e6e9ef;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
    '.card{width:min(360px,88vw);background:#171c22;border:1px solid #262d36;border-radius:14px;padding:28px}' +
    'h1{font-size:17px;margin:0 0 6px}p.sub{color:#8b95a3;margin:0 0 18px;font-size:13px}' +
    'input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:9px;border:1px solid #2e3742;background:#11161c;color:#e6e9ef;outline:none}' +
    'input:focus{border-color:#3b82f6}' +
    'button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:9px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}' +
    'button:active{background:#2f6fd0}' +
    '.msg{min-height:18px;color:#f87171;font-size:13px;margin-top:10px}' +
    '.warn{color:#fbbf24;font-size:13px;margin:0 0 14px}' +
    '</style></head><body><form class="card" id="f">' +
    '<h1>TVBOX 接口编辑器</h1><p class="sub">请输入访问口令</p>' + hint +
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
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>TVBOX 多仓接口编辑器</title>' +
    '<style>' +
    ':root{--bg:#0f1216;--panel:#171c22;--line:#262d36;--text:#e6e9ef;--muted:#8b95a3;--blue:#3b82f6;--green:#22c55e;--red:#ef4444;--amber:#f59e0b}' +
    '*{box-sizing:border-box}' +
    'body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
    '.wrap{max-width:1180px;margin:0 auto;padding:22px 16px 60px}' +
    'header{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:16px}' +
    'h1{font-size:19px;margin:0}header .sub{color:var(--muted);font-size:13px;margin-right:auto}' +
    '.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}' +
    'input,textarea{background:#11161c;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:9px 11px;outline:none;font:inherit}' +
    'input:focus,textarea:focus{border-color:var(--blue)}' +
    '#srcUrl{flex:1;min-width:240px}' +
    '#filter{flex:1;min-width:180px}' +
    'button{border:1px solid var(--line);background:#1d242c;color:var(--text);border-radius:8px;padding:9px 13px;cursor:pointer;font:inherit}' +
    'button:hover{background:#232b34}' +
    'button.primary{background:var(--blue);border-color:var(--blue);color:#fff;font-weight:600}' +
    'button.primary:hover{background:#2f6fd0}' +
    'button.ghost{background:transparent}' +
    'button:disabled{opacity:.5;cursor:not-allowed}' +
    '.stat{color:var(--muted);font-size:13px;white-space:nowrap}' +
    '.msg{color:var(--muted);font-size:13px;flex:1;text-align:right;min-width:120px}' +
    '.list{display:flex;flex-direction:column;gap:8px;margin-top:12px}' +
    '.row{display:grid;grid-template-columns:150px minmax(0,1fr) 132px 178px;gap:8px;align-items:center;' +
    'background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:9px 11px}' +
    '.row input{width:100%;padding:7px 9px;font-size:13px}' +
    '.row .nm{font-weight:600}' +
    '.row .ul{color:#a9b4c2;font-size:12px}' +
    '.badge{font-size:12px;padding:6px 8px;border-radius:7px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid transparent}' +
    '.badge.idle{color:var(--muted);border-color:var(--line)}' +
    '.badge.good{color:#86efac;background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.35)}' +
    '.badge.warn{color:#fcd34d;background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.35)}' +
    '.badge.bad{color:#fca5a5;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.35)}' +
    '.acts{display:flex;gap:6px;justify-content:flex-end}' +
    '.acts button{padding:6px 9px;font-size:12px}' +
    '.acts .del{color:#fca5a5}' +
    '.empty{padding:40px 0;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:10px}' +
    '#importPanel{display:none;margin-top:12px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}' +
    '#importArea{width:100%;height:180px;font-family:ui-monospace,Consolas,monospace;font-size:12px;resize:vertical}' +
    'footer{margin-top:26px;color:var(--muted);font-size:12px;text-align:center}' +
    '@media(max-width:760px){.row{grid-template-columns:1fr;gap:6px}.acts{justify-content:flex-start}}' +
    '</style></head><body><div class="wrap">' +
    '<header><h1>TVBOX 多仓接口编辑器</h1><span class="sub">加载 · 编辑 · 测速 · 导出</span>' +
    '<button class="ghost" id="logout">退出</button></header>' +

    '<div class="bar"><input id="srcUrl" spellcheck="false" value="' + DEFAULT_CONFIG_URL + '">' +
    '<button class="primary" id="load">加载</button>' +
    '<button id="add">新增接口</button>' +
    '<button id="importBtn">导入 JSON</button>' +
    '<button class="primary" id="testAll">全部测速</button>' +
    '<button id="exportBtn">导出</button></div>' +

    '<div class="bar"><input id="filter" placeholder="按名称或地址筛选">' +
    '<span class="stat" id="stat">共 0 条</span><span class="msg" id="msg"></span></div>' +

    '<div id="list" class="list"></div>' +

    '<div id="importPanel"><textarea id="importArea" spellcheck="false" placeholder=\'粘贴 {"urls":[{"name":"...","url":"..."}]} 或裸数组\'></textarea>' +
    '<div class="bar" style="margin-top:10px"><button class="primary" id="doImport">确认导入</button><button id="cancelImport">取消</button></div></div>' +

    '<footer>服务端已开启口令保护 · 所有测速在 Cloudflare 边缘节点发起</footer></div>' +

    '<script>' +
    'var state={items:[],filter:"",busy:false};' +
    'function el(id){return document.getElementById(id);}' +
    'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
    'function msg(t){el("msg").textContent=t||"";}' +
    'function badge(item){' +
    'if(!item.result)return \'<span class="badge idle">未测</span>\';' +
    'var r=item.result;' +
    'if(!r.ok)return \'<span class="badge bad" title="\'+esc(r.error||"失败")+\'">\'+(r.status?r.status:"失败")+\'</span>\';' +
    'var cls=r.json?"good":"warn";' +
    'var txt=(r.status||200)+" · "+r.ms+"ms"+(r.count!==null?" · "+r.count+"条":"");' +
    'return \'<span class="badge \'+cls+\'">\'+esc(txt)+\'</span>\';' +
    '}' +
    'function render(){' +
    'var kw=state.filter.toLowerCase();var rows=[];var ok=0,fail=0;' +
    'state.items.forEach(function(it,i){' +
    'if(kw&&((it.name||"")+" "+(it.url||"")).toLowerCase().indexOf(kw)<0)return;' +
    'rows.push(\'<div class="row" data-i="\'+i+\'">\'+' +
    '\'<input class="nm" value="\'+esc(it.name)+\'" placeholder="名称">\'+' +
    '\'<input class="ul" value="\'+esc(it.url)+\'" placeholder="接口地址" spellcheck="false">\'+' +
    'badge(it)+' +
    '\'<div class="acts"><button data-act="test">测速</button>\'+(i>0?\'<button data-act="up">↑</button>\':"")+\'<button data-act="down">↓</button><button class="del" data-act="del">删除</button></div></div>\'' +
    ');' +
    '});' +
    'state.items.forEach(function(it){if(it.result){if(it.result.ok)ok++;else fail++;}});' +
    'el("list").innerHTML=rows.length?rows.join(""):\'<div class="empty">暂无接口，点「新增接口」或先加载配置</div>\';' +
    'el("stat").textContent="共 "+state.items.length+" 条 · 可用 "+ok+" · 失败 "+fail;' +
    '}' +
    'function toItems(arr){return arr.map(function(x){return {name:String(x&&x.name||"未命名"),url:String(x&&x.url||"")};});}' +
    'function loadFromUrl(u){' +
    'msg("加载中...");' +
    'fetch("/api/config?url="+encodeURIComponent(u)).then(function(r){return r.json();}).then(function(j){' +
    'if(!j.ok)throw new Error(j.error||"加载失败");' +
    'var d=JSON.parse(j.text);var arr=Array.isArray(d)?d:(d.urls||[]);' +
    'state.items=toItems(arr);render();msg("已加载 "+state.items.length+" 条");' +
    '}).catch(function(e){msg("加载失败："+e.message);});' +
    '}' +
    'function probeIndexes(ids,done){' +
    'var CHUNK=12;var pending=ids.slice();' +
    'function step(){' +
    'if(!pending.length){done();return;}' +
    'var part=pending.splice(0,CHUNK);' +
    'var payload=part.map(function(i){return {i:i,name:state.items[i].name,url:state.items[i].url};});' +
    'fetch("/api/probe",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({urls:payload})})' +
    '.then(function(r){return r.json();}).then(function(j){' +
    '(j.results||[]).forEach(function(r){if(state.items[r.i])state.items[r.i].result=r;});' +
    'render();msg("测速中 "+Math.max(0,ids.length-pending.length)+"/"+ids.length);step();' +
    '}).catch(function(){step();});' +
    '}' +
    'step();' +
    '}' +
    'function setBusy(v){state.busy=v;el("testAll").disabled=v;el("load").disabled=v;}' +
    'el("load").addEventListener("click",function(){var u=el("srcUrl").value.trim();if(!u)return;loadFromUrl(u);});' +
    'el("add").addEventListener("click",function(){state.items.unshift({name:"新接口",url:""});render();});' +
    'el("testAll").addEventListener("click",function(){' +
    'var ids=[];state.items.forEach(function(it,i){if(it.url)ids.push(i);});' +
    'if(!ids.length){msg("没有可测的地址");return;}' +
    'setBusy(true);msg("测速中 0/"+ids.length);' +
    'probeIndexes(ids,function(){setBusy(false);msg("测速完成");});' +
    '});' +
    'el("list").addEventListener("click",function(e){' +
    'var btn=e.target.closest("button[data-act]");if(!btn)return;' +
    'var row=e.target.closest(".row");var i=Number(row.getAttribute("data-i"));var act=btn.getAttribute("data-act");' +
    'if(act==="del"){state.items.splice(i,1);render();return;}' +
    'if(act==="up"&&i>0){var t=state.items[i-1];state.items[i-1]=state.items[i];state.items[i]=t;render();return;}' +
    'if(act==="down"&&i<state.items.length-1){var t2=state.items[i+1];state.items[i+1]=state.items[i];state.items[i]=t2;render();return;}' +
    'if(act==="test"){' +
    'var it=state.items[i];if(!it.url){msg("地址为空");return;}' +
    'btn.disabled=true;msg("测速中...");' +
    'probeIndexes([i],function(){btn.disabled=false;msg("");});' +
    '}' +
    '});' +
    'el("list").addEventListener("input",function(e){' +
    'var row=e.target.closest(".row");if(!row)return;var i=Number(row.getAttribute("data-i"));' +
    'if(e.target.classList.contains("nm"))state.items[i].name=e.target.value;' +
    'if(e.target.classList.contains("ul"))state.items[i].url=e.target.value;' +
    '});' +
    'el("filter").addEventListener("input",function(e){state.filter=e.target.value;render();});' +
    'el("importBtn").addEventListener("click",function(){var p=el("importPanel");p.style.display=p.style.display==="block"?"none":"block";});' +
    'el("cancelImport").addEventListener("click",function(){el("importPanel").style.display="none";});' +
    'el("doImport").addEventListener("click",function(){' +
    'try{var d=JSON.parse(el("importArea").value);var arr=Array.isArray(d)?d:(d.urls||[]);if(!Array.isArray(arr))throw new Error("没有 urls 数组");' +
    'state.items=toItems(arr);render();el("importPanel").style.display="none";msg("已导入 "+state.items.length+" 条");}' +
    'catch(err){msg("JSON 解析失败："+err.message);}' +
    '});' +
    'el("exportBtn").addEventListener("click",function(){' +
    'var urls=state.items.filter(function(x){return x.url;}).map(function(x){return {name:x.name,url:x.url};});' +
    'var text=JSON.stringify({urls:urls},null,2);' +
    'var blob=new Blob([text],{type:"application/json"});var a=document.createElement("a");' +
    'a.href=URL.createObjectURL(blob);a.download="shiguang.json";a.click();' +
    'setTimeout(function(){URL.revokeObjectURL(a.href);},1000);msg("已导出 "+urls.length+" 条");' +
    '});' +
    'el("logout").addEventListener("click",function(){fetch("/api/logout",{method:"POST"}).then(function(){location.href="/";});});' +
    'render();' +
    '</script></body></html>';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // 登录接口不需要鉴权
    if (path === '/api/login' && request.method === 'POST') {
      if (!env.PASSWORD) return jsonResponse({ ok: false, error: '服务端未配置 PASSWORD 环境变量' }, 500);
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: '请求格式错误' }, 400);
      }
      const input = String((body && body.password) || '');
      if (!constantTimeEqual(input, env.PASSWORD)) {
        return jsonResponse({ ok: false, error: '口令错误' }, 401);
      }
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
      if (path.startsWith('/api/')) {
        return jsonResponse({ ok: false, error: '未登录或登录已过期' }, 401);
      }
      return htmlResponse(loginHtml(env), 401);
    }

    if (path === '/') return htmlResponse(editorHtml());

    if (path === '/api/config') {
      if (request.method !== 'GET') return jsonResponse({ ok: false, error: '仅支持 GET' }, 405);
      const target = url.searchParams.get('url') || DEFAULT_CONFIG_URL;
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        return jsonResponse({ ok: false, error: '地址格式不正确' }, 400);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return jsonResponse({ ok: false, error: '仅支持 http/https' }, 400);
      }
      try {
        const text = await fetchConfigText(parsed.toString());
        return jsonResponse({ ok: true, text, source: parsed.toString() });
      } catch (error) {
        return jsonResponse({ ok: false, error: '配置拉取失败：' + String(error && error.message || error) }, 502);
      }
    }

    if (path === '/api/probe') {
      if (request.method !== 'POST') return jsonResponse({ ok: false, error: '仅支持 POST' }, 405);
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: '请求格式错误' }, 400);
      }
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
            error: target ? String(error && error.message || error) : '地址为空',
          };
        }
        return { i: index, name: (item && item.name) || '', url: target, ...result };
      });

      return jsonResponse({ ok: true, results });
    }

    return jsonResponse({ ok: false, error: '接口不存在' }, 404);
  },
};
