# 微信登录部署配置

## 1. 小程序 API 地址

小程序 API 地址统一维护在 `miniprogram/config/api.ts`：

- `develop`：默认使用 `http://127.0.0.1:3000`，仅供本机微信开发者工具连接本地后端。
- `trial`：填写体验版 HTTPS API 地址。
- `release`：填写正式版 HTTPS API 地址。

体验版和正式版未配置时，请求层会返回明确的 `API_CONFIGURATION_ERROR`，不会静默请求错误地址。

生产示例：

```ts
const API_BASE_URLS = {
  develop: "http://127.0.0.1:3000",
  trial: "https://api.example.com",
  release: "https://api.example.com",
};
```

不要把数据库地址 `120.53.19.24:5432` 当作小程序 API 地址。数据库端口不能直接暴露给小程序。

## 2. 微信 request 合法域名

登录微信公众平台，在“小程序后台 → 开发管理 → 开发设置 → 服务器域名”中，把生产 API Origin 添加为 `request` 合法域名，例如：

```text
https://api.example.com
```

要求：

- 必须使用有效的 HTTPS 证书和完整证书链。
- 域名必须与证书一致，并按微信要求完成备案。
- 不得填写 IP 地址、`localhost`、路径或查询参数。
- 如果域名包含非默认端口，微信后台配置和代码请求必须完全一致。
- 生产环境关闭“不校验合法域名、TLS 版本及 HTTPS 证书”。

`project.private.config.json` 当前只为本地开发者工具关闭域名校验，以便访问 `127.0.0.1:3000`。真机、体验版和正式版仍必须使用已配置的 HTTPS 域名。

## 3. 后端微信配置

小程序 AppID 当前为：

```text
wx78d89d6e64966b18
```

在 `server/.env` 中配置：

```dotenv
WECHAT_APP_ID=wx78d89d6e64966b18
WECHAT_APP_SECRET=<从微信公众平台获取，不得提交 Git>
WECHAT_API_TIMEOUT_MS=8000
OPENID_HASH_SECRET=<至少 32 个随机字符，不得提交 Git>
AUTH_TOKEN_TTL_DAYS=30
WECHAT_CONTENT_SECURITY_TOKEN=<微信消息推送校验 Token>
CONTENT_SECURITY_MEDIA_STORAGE_DIR=./data/content-security
CONTENT_SECURITY_MEDIA_PUBLIC_BASE_URL=https://api.example.com/api/content-security/media
CONTENT_SECURITY_MEDIA_MAX_BYTES=10485760
CONTENT_SECURITY_ASYNC_MEDIA_CHECK_ENABLED=true
AVATAR_STORAGE_DIR=./data/avatars
AVATAR_MAX_BYTES=2097152
COVER_STORAGE_DIR=./data/covers
COVER_PUBLIC_BASE_URL=https://cdn.example.com/covers
COVER_MAX_BYTES=10485760
```

生成 `OPENID_HASH_SECRET`：

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

AppSecret 只能放在后端运行环境中，禁止写入小程序代码、`project.config.json`、前端 Storage、日志或 Git。

内容安全回调地址为：

```text
https://<API域名>/api/wechat/content-security/callback
```

需要在微信公众平台消息推送配置中完成 Token 校验，并确保该地址可接收微信的 `wxa_media_check` 异步审核事件。

`AVATAR_STORAGE_DIR` 必须位于服务端可持久化且不可被任意写入的目录。当前实现通过 `/api/media/avatars/...` 公开读取头像；生产部署需要挂载持久化磁盘，或将服务端 `AvatarStorage` 替换为对象存储实现。头像上传和读取使用与 API 相同的合法 HTTPS 域名。

## 4. HTTPS 部署

生产环境建议由 Nginx、Caddy 或云负载均衡在 443 端口终止 TLS，再反向代理到 Node 服务的 `127.0.0.1:3000`。只对公网开放 HTTPS API 端口，不开放 PostgreSQL 5432。

部署后依次验证：

1. `GET https://<API域名>/health` 返回 `200`。
2. 微信开发者工具重新开启域名校验后，健康检查域名仍可访问。
3. 重新执行后端 `npm run build` 并重启进程，避免旧进程继续返回 404。
4. 点击“微信快捷登录”，`POST /api/auth/login` 返回 token。
5. 小程序携带 Bearer token 请求 `GET /api/users/me` 成功。
6. 清除或篡改本地 token 后，页面恢复游客状态。
