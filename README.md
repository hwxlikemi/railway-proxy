# Railway URL 代理 / 镜像站

零依赖的 Node.js 代理，部署在 Railway 上，支持两种用法：

## 1. 通用代理

```
https://你的域名/?w=https://目标网址
```

例如 `https://proxy.hwxlikemi.top/?w=https://google.com/`

页面里指向目标站的链接会被自动改写为代理地址，点击后不会跳出代理域名（改写为 `/?w=<完整地址>` 形式）。

## 2. 镜像模式（推荐）

在 Railway 的 Variables 里设置：

```
MIRROR_UPSTREAM=https://github.com
```

之后代理域名下的路径直接映射到上游站：

```
https://proxy.hwxlikemi.top/       ->  https://github.com/
https://proxy.hwxlikemi.top/login  ->  https://github.com/login
```

页面里的绝对链接会被改写为站内路径，**点击站内链接全程留在你的域名下**。例如访问 `https://proxy.hwxlikemi.top/?w=https://github.com` 后，点击 "Sign in" 会变成 `https://proxy.hwxlikemi.top/login`，而非跳到 github.com。

## 本地运行

```bash
node index.js
```

然后访问 `http://localhost:3000/?w=https://example.com`。

启用镜像模式本地试跑：

```powershell
$env:MIRROR_UPSTREAM='https://github.com'; node index.js
```

## 环境变量（可选）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口（Railway 会自动注入，一般无需设置） |
| `MIRROR_UPSTREAM` | 空 | 镜像上游站点（如 `https://github.com`），设置后启用镜像模式 |
| `PROXY_TOKEN` | 空 | 设置后首次访问需带 `?token=<值>`（换取 Cookie），未授权返回 401 |
| `REQUEST_TIMEOUT` | `15000` | 单个请求总超时（毫秒），超时返回 504 |

## 安全特性

- **SSRF 防护**：自动拦截解析到内网/保留地址的目标（127.x、10.x、172.16-31.x、192.168.x、169.254.x 及 IPv6 内网段等），重定向目标由浏览器侧新请求重新校验。
- **请求超时**：默认 15 秒无响应即返回 504 并释放连接。
- **可选鉴权**：设置 `PROXY_TOKEN` 后，未带正确 token 的请求返回 401。首次用 `?token=` 访问会种下 Cookie，之后站内链接无需再带 token。
- **错误收敛**：对外只返回通用错误信息，细节写入服务端日志。

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
- **返回 401 / 未授权访问**：已设置 `PROXY_TOKEN`，需先访问 `/?token=<值>` 换取 Cookie。
- **登录/登录态不能用**：上游站点的 Cookie 归属其域名，代理域名无法复用，所以登录、购物车这类依赖会话的功能通常不可用；本镜像适合浏览内容（代码、文档、仓库页等）。
- **部分页面里的链接点不开**：JS 动态生成的链接、非 UTF-8 编码页面（GBK 等）不会改写；指向**其他域名**的链接也会保持原样跳出代理。
- **超大页面报 502**：HTML 响应超过 32MB 时不做改写，直接返回错误（正常页面远小于此）。
- **修改代码后**：`git push` 到 GitHub，Railway 会自动重新部署。
