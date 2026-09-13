// Railway URL 代理 / 镜像站
// 零依赖，基于 Node 18+ 原生 fetch
//
// 两种用法：
//   1) 通用代理：/?w=<url>，透传任意 http/https 页面；页面里指向目标站的链接会被改写，
//      点击后仍停留在代理域名内（目标不是镜像站时改写为 /?w=<完整地址> 形式）。
//   2) 镜像模式：设置 MIRROR_UPSTREAM（如 https://github.com）后，代理域名下的 /path
//      直接映射到上游站 /path，站内链接改写为站内相对路径，全程不出代理域名。
//      例：/?w=https://github.com 页面里的 "Sign in" 链接会变成 https://你的域名/login
//
// 安全：SSRF 防护（拒绝内网/保留地址）、请求超时、可选 Token 鉴权（Cookie 保持）。
const http = require('http');
const dns = require('dns').promises;
const net = require('net');

const port = Number(process.env.PORT) || 3000;
// 可选鉴权：设置 PROXY_TOKEN 后，首次访问用 ?token=<值> 换取 Cookie，之后站内链接无需再带 token
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';
// 单个请求总超时（毫秒）
const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT) || 15000;
// 需要改写（HTML）的响应体上限，超过则返回 502，不做流式透传（避免改写不完整）
const MAX_REWRITE_SIZE = 32 * 1024 * 1024;

// 镜像上游（可选）：如 https://github.com
const MIRROR_UPSTREAM = (process.env.MIRROR_UPSTREAM || '').trim();
let mirrorHost = '';
let mirrorOrigin = '';
if (MIRROR_UPSTREAM) {
  const u = new URL(MIRROR_UPSTREAM);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('MIRROR_UPSTREAM 仅支持 http/https 地址');
  }
  mirrorHost = u.host;
  mirrorOrigin = u.origin;
}

// ---------- SSRF 防护 ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地（含云元数据）
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
    if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试网段
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true; // 未指定 / 回环
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 链路本地
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7)); // IPv4 映射
    return false;
  }
  return true; // 无法识别的地址一律视为不安全
}

// 校验目标主机解析到的所有地址都在公网
async function assertPublicHost(rawUrl) {
  const url = new URL(rawUrl);
  let host = url.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6 字面量去括号

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('内网/保留主机名');
  }

  const resolved = await dns.lookup(host, { all: true });
  for (const { address } of resolved) {
    if (isPrivateIp(address)) throw new Error('内网/保留地址');
  }
}

// ---------- 链接改写 ----------
// 把指向 fromHost 的 URL 改写为代理站自身的地址（baseUrl 用于解析相对地址）
// mode 'clean'：去掉来源站域名只留路径（镜像模式，如 /login）
// mode 'param'：改写为 /?w=<完整地址>（通用代理模式）
function rewriteUrl(urlStr, baseUrl, fromHost, mode) {
  let u;
  try {
    u = new URL(urlStr, baseUrl);
  } catch {
    return urlStr;
  }
  if (u.host !== fromHost) return urlStr; // 其他站点不改写
  if (mode === 'clean') return u.pathname + u.search + u.hash || '/';
  return '/?w=' + encodeURIComponent(u.href);
}

// 改写 HTML 正文里所有指向 fromHost 的链接（href/src/action/文本中的 URL 一并处理）
function rewriteHtml(html, fromHost, mode) {
  const escaped = fromHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`((?:https?:)?//${escaped})([^"'\\s<>]*)`, 'g');
  return html.replace(re, (match, origin, rest) => {
    if (rest && !'/?#'.includes(rest[0])) return match; // 不是路径边界（如 github.com.cn），跳过
    if (mode === 'clean') return rest || '/'; // 只保留路径部分
    const scheme = origin.startsWith('https:') ? 'https:' : 'http:';
    return '/?w=' + encodeURIComponent(scheme + '//' + fromHost + rest);
  });
}

// ---------- 抓取 ----------
// 手动模式：重定向交给浏览器，Location 由 rewriteUrl 改写，逐跳 SSRF 校验由浏览器侧新请求完成
async function fetchSafe(urlStr, req, signal) {
  await assertPublicHost(urlStr);
  return fetch(urlStr, {
    redirect: 'manual',
    signal,
    headers: {
      'User-Agent':
        req.headers['user-agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: req.headers['accept'] || '*/*',
      'Accept-Language': req.headers['accept-language'] || 'zh-CN,zh;q=0.9',
    },
  });
}

// ---------- 鉴权 ----------
function isAuthed(req, queryToken) {
  if (!PROXY_TOKEN) return true;
  if (queryToken === PROXY_TOKEN) return true;
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((part) => part.trim() === `proxy_token=${PROXY_TOKEN}`);
}

// ---------- 响应体读取（带大小上限） ----------
async function readBody(stream, cap) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      throw new Error('响应体过大，无法改写');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// 流式写出，处理背压与客户端断开
async function streamBody(res, stream) {
  const reader = stream.getReader();
  while (!res.destroyed) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(Buffer.from(value))) {
      await new Promise((resolve) => {
        res.once('drain', resolve);
        res.once('close', resolve);
      });
    }
  }
}

const server = http.createServer(async (req, res) => {
  res.on('error', () => {}); // 客户端断开等场景忽略 EPIPE

  const parsed = new URL(req.url, 'http://localhost');
  const target = parsed.searchParams.get('w');
  const queryToken = parsed.searchParams.get('token');

  // 只处理 GET
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('仅支持 GET');
    return;
  }

  // 可选鉴权
  if (!isAuthed(req, queryToken)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('未授权访问');
    return;
  }
  // 用 query token 认证成功后种下 Cookie，之后站内链接无需再带 token
  if (
    PROXY_TOKEN &&
    queryToken === PROXY_TOKEN &&
    !(req.headers.cookie || '').includes('proxy_token=')
  ) {
    res.setHeader(
      'Set-Cookie',
      `proxy_token=${PROXY_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
    );
  }

  // ---- 确定抓取目标与改写模式 ----
  let fetchUrl, baseUrl, fromHost, mode;
  if (target) {
    // 通用代理模式
    let u;
    try {
      u = new URL(target);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('URL 无效，仅支持 http/https');
      return;
    }
    fetchUrl = u.href;
    fromHost = u.host;
    baseUrl = u;
    // 目标正是镜像站时用干净路径，否则用 /?w= 形式
    mode = mirrorHost && u.host === mirrorHost ? 'clean' : 'param';
  } else if (mirrorOrigin) {
    // 镜像模式：/path?query -> {上游}/path?query
    fetchUrl = mirrorOrigin + parsed.pathname + parsed.search;
    fromHost = mirrorHost;
    baseUrl = new URL(fetchUrl);
    mode = 'clean';
  } else {
    // 未设置镜像且无 w 参数：显示用法
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const tokenHint = PROXY_TOKEN ? '&amp;token=你的Token' : '';
    res.end(
      `<h3>URL Proxy is running</h3><p>Usage: <code>/?w=https://example.com${tokenHint}</code></p>` +
        (mirrorOrigin ? '' : '<p>Set <code>MIRROR_UPSTREAM</code> to enable mirror mode.</p>')
    );
    return;
  }

  // 超时 + 客户端断开时取消上游请求
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT);
  res.on('close', () => ac.abort());

  try {
    const response = await fetchSafe(fetchUrl, req, ac.signal);
    const status = response.status;

    const headers = {
      'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
    };
    const disposition = response.headers.get('content-disposition');
    if (disposition) headers['Content-Disposition'] = disposition;

    // 重定向交给浏览器，Location 改写为代理站地址
    if ([301, 302, 303, 307, 308].includes(status)) {
      const loc = response.headers.get('location');
      response.body?.cancel().catch(() => {});
      if (loc) headers.Location = rewriteUrl(loc, baseUrl, fromHost, mode);
      res.writeHead(status, headers);
      res.end();
      console.log(`代理: ${fetchUrl} -> ${status}`);
      return;
    }

    // HTML（UTF-8）缓冲后改写链接；其余内容流式透传
    const ct = headers['Content-Type'] || '';
    const charset = (ct.match(/charset=([\w-]+)/i) || [])[1] || '';
    const rewritable =
      ct.includes('text/html') && (!charset || /^utf-?8$/i.test(charset));

    res.writeHead(status, headers);
    if (rewritable) {
      const buf = await readBody(response.body, MAX_REWRITE_SIZE);
      res.end(rewriteHtml(buf.toString('utf8'), fromHost, mode));
    } else {
      await streamBody(res, response.body);
      if (!res.destroyed) res.end();
    }
    console.log(`代理: ${fetchUrl} -> ${status}`);
  } catch (err) {
    if (res.headersSent || res.destroyed) {
      res.destroy(); // 响应头已发出或连接已断开，无法再返回错误页
    } else {
      const isTimeout = err.name === 'AbortError';
      res.writeHead(isTimeout ? 504 : 502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(isTimeout ? '请求超时' : '代理错误');
    }
    if (err.name !== 'AbortError' || !res.destroyed) {
      console.error(`代理失败: ${fetchUrl} - ${err.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
});

// 启动前校验镜像上游配置可访问
function main() {
  const bootstrap = mirrorOrigin ? assertPublicHost(mirrorOrigin) : Promise.resolve();
  bootstrap
    .then(() => server.listen(port, () => console.log(`Proxy running on http://localhost:${port}`)))
    .catch((e) => {
      console.error(`启动失败: ${e.message}`);
      process.exit(1);
    });
}
main();
