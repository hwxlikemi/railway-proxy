// Railway URL 代理：/?w=<url>
// 零依赖，基于 Node 18+ 原生 fetch
const http = require('http');

const port = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  // 只处理 GET
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('仅支持 GET');
    return;
  }

  const parsed = new URL(req.url, 'http://localhost');
  const target = parsed.searchParams.get('w');

  // 根路径访问时显示用法
  if (!target) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<h3>URL Proxy is running</h3><p>Usage: <code>/?w=https://example.com</code></p>'
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
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('URL 无效，仅支持 http/https');
    return;
  }

  try {
    const response = await fetch(target, {
      redirect: 'follow', // 自动跟随重定向
      headers: {
        'User-Agent':
          req.headers['user-agent'] ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: req.headers['accept'] || '*/*',
        'Accept-Language': req.headers['accept-language'] || 'zh-CN,zh;q=0.9',
      },
    });

    // 透传状态码与 Content-Type
    const headers = {
      'Content-Type':
        response.headers.get('content-type') || 'application/octet-stream',
    };
    res.writeHead(response.status, headers);

    // 流式返回响应体
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('代理错误: ' + e.message);
  }
});

server.listen(port, () => {
  console.log(`Proxy running on http://localhost:${port}`);
});
