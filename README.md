# Railway URL 代理服务

零依赖的 Node.js URL 代理，部署在 Railway 上，用法：

```
https://你的域名/?w=https://目标网址
```

例如 `https://proxy.hwxlikemi.top/?w=https://google.com/`

## 本地运行

```bash
node index.js
```

然后访问 `http://localhost:3000/?w=https://example.com`。

## 环境变量（可选）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口（Railway 会自动注入，一般无需设置） |
| `PROXY_TOKEN` | 空 | 设置后访问需带 `?token=<值>`，未带正确 token 返回 401，防止代理被公开滥用 |
| `REQUEST_TIMEOUT` | `15000` | 单个请求总超时（毫秒），超时返回 504 |

## 安全特性

- **SSRF 防护**：自动拦截解析到内网/保留地址的目标（127.x、10.x、172.16-31.x、192.168.x、169.254.x 及 IPv6 内网段等），重定向逐跳重新校验，防止代理被用来探测内网。
- **请求超时**：默认 15 秒无响应即返回 504 并释放连接，避免被挂死。
- **可选鉴权**：设置 `PROXY_TOKEN` 后，未带正确 token 的请求返回 401（建议部署后设置）。
- **错误收敛**：对外只返回通用错误信息，细节写入服务端日志，不泄露内部细节。

## 部署到 Railway

### 1. 把代码推到 GitHub

在本目录初始化 Git 并推送到你的 GitHub 仓库（可设为私有仓库）。

```bash
git init
git add .
git commit -m "url proxy"
git branch -M main
git remote add origin https://github.com/<你的用户名>/railway-proxy.git
git push -u origin main
```

### 2. 在 Railway 创建项目

1. 打开 https://railway.app ，用 GitHub 账号登录（新用户需先注册）。
2. 点击 **New Project** → 选择 **Deploy from GitHub repo**。
3. 授权并选择刚才的 `railway-proxy` 仓库。
4. Railway 会自动检测 Node.js（Nixpacks），开始构建部署，等待 **Deploy** 状态变成 **Healthy**。

### 3. 生成临时域名验证

1. 进入该 Service 的 **Settings** → **Networking**。
2. 点击 **Generate Domain**，会得到一个形如 `xxx.up.railway.app` 的域名。
3. 访问 `https://xxx.up.railway.app/?w=https://example.com`，能返回网页内容即部署成功。

### 4. 绑定自定义域名 proxy.hwxlikemi.top

1. 仍在 **Settings** → **Networking** → **Custom Domains**，点击 **Add Custom Domain**，输入 `proxy.hwxlikemi.top`。
2. Railway 会提示一条 DNS 记录（通常是 CNAME），记录下它给你的 **CNAME 目标值**（形如 `xxx.railway-dns.com` 或 `xxx.up.railway.app`）。
3. 到 `hwxlikemi.top` 的 DNS 托管处（Cloudflare / 阿里云 / 腾讯云等）添加记录：
   - 类型：`CNAME`
   - 主机/名称：`proxy`
   - 目标/指向：Railway 给的那条 CNAME 目标值
   - TTL：自动/默认
4. 若使用 **Cloudflare**：先把该记录设为 **仅 DNS（灰云）**，避免 CDN 与 Railway 的 HTTPS 证书冲突；等域名生效后再按需调整。

### 5. 等待生效并验证

- DNS 生效通常几分钟到几十分钟。
- Railway 会自动签发 HTTPS 证书。
- 验证：`https://proxy.hwxlikemi.top/?w=https://example.com`

## 常见问题

- **返回 502 / 代理错误**：目标网站本身不可达、被对方拒绝，或目标指向内网地址（被 SSRF 防护拦截）。可换一个公网网址测试，具体原因看服务端日志。
- **返回 504 / 请求超时**：目标响应超过 `REQUEST_TIMEOUT`（默认 15 秒），可调大该变量后重试。
- **返回 401 / 未授权访问**：已设置 `PROXY_TOKEN`，访问时需带 `?token=<值>`。
- **页面里的链接点不开**：本代理只做"整页透传"，不会重写页面里的相对链接，点击链接会直接跳到原站。如需完整"镜像式"代理，需要更强的 URL 重写方案。
- **修改代码后**：`git push` 到 GitHub，Railway 会自动重新部署。
