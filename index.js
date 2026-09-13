// Railway URL 代理：/?w=<url>
// 零依赖，基于 Node 18+ 原生 fetch
// 安全特性：SSRF 防护（拒绝内网/保留地址）、请求超时、可选 Token 鉴权
const http = require('http');
const dns = require('dns').promises;
const net = require('net');

const port = Number(process.env.PORT) || 3000;
// 可选：设置 PROXY_TOKEN 后，访问需带 ?token=<值>，防止公开代理被滥用
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';
// 单个请求总超时（毫秒），默认 15 秒
const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT) || 15000;
const MAX_REDIRECTS = 10;

// ---------- SSRF 防护 ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地（含云元数据 169.254.169.254）
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

// 带 SSRF 校验的抓取：手动跟随重定向，逐跳重新校验目标
async function fetchSafe(urlStr, req, signal, redirectsLeft) {
  await assertPublicHost(urlStr);

  const response = await fetch(urlStr, {
    redirect: 'manual', // 手动跟随，逐跳做 SSRF 校验
    signal,
    headers: {
      'User-Agent':
        req.headers['user-agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: req.headers['accept'] || '*/*',
      'Accept-Language': req.headers['accept-language'] || 'zh-CN,zh;q=0.9',
    },
  });

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    response.body?.cancel().catch(() => {}); // 释放重定向响应的连接
    if (!location) throw new Error('重定向缺少 Location 头');
    const next = new URL(location, urlStr);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new Error('重定向目标协议不受支持');
    }
    if (redirectsLeft <= 0) throw new Error('重定向次数过多');
    return fetchSafe(next.href, req, signal, redirectsLeft - 1);
  }

  return response;
}

const server = http.createServer(async (req, res) => {
  res.on('error', () => {}); // 客户端断开等场景忽略 EPIPE

  const parsed = new URL(req.url, 'http://localhost');
  const target = parsed.searchParams.get('w');

  // 只处理 GET
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('仅支持 GET');
    return;
  }

  // 可选鉴权
  if (PROXY_TOKEN && parsed.searchParams.get('token') !== PROXY_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('未授权访问');
    return;
  }

  // 根路径显示用法
  if (!target) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const tokenHint = PROXY_TOKEN ? '&amp;token=你的Token' : '';
    res.end(
      `<h3>URL Proxy is running</h3><p>Usage: <code>/?w=https://example.com${tokenHint}</code></p>`
    );
    return;
  }

  // 校验目标 URL
  let targetUrl;
  try {
    targetUrl = new URL(target);
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('URL 无效，仅支持 http/https');
    return;
  }

  // 超时 + 客户端断开时取消上游请求
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT);
  res.on('close', () => ac.abort());

  try {
    const response = await fetchSafe(targetUrl.href, req, ac.signal, MAX_REDIRECTS);

    // 透传状态码与关键响应头
    const headers = {
      'Content-Type':
        response.headers.get('content-type') || 'application/octet-stream',
    };
    const disposition = response.headers.get('content-disposition');
    if (disposition) headers['Content-Disposition'] = disposition;

    console.log(`代理: ${target} -> ${response.status}`);
    res.writeHead(response.status, headers);

    // 流式返回，正确处理背压与客户端断开
    if (response.body) {
      const reader = response.body.getReader();
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
    if (!res.destroyed) res.end();
  } catch (err) {
    if (res.headersSent || res.destroyed) {
      // 响应头已发出或连接已断开，无法再返回错误页，直接断开
      res.destroy();
    } else {
      // 对外只返回通用错误，细节写服务端日志，避免泄露内部信息
      const isTimeout = err.name === 'AbortError';
      res.writeHead(isTimeout ? 504 : 502, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end(isTimeout ? '请求超时' : '代理错误');
    }
    if (err.name !== 'AbortError' || !res.destroyed) {
      console.error(`代理失败: ${target} - ${err.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
});

server.listen(port, () => {
  console.log(`Proxy running on http://localhost:${port}`);
});
