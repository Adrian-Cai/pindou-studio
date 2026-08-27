# 拼豆工作室后端

当前完成阶段 0、阶段 1 和阶段 2：服务基础、PostgreSQL 结构校验、健康检查、微信登录、Bearer token 鉴权、当前用户查询及头像昵称维护，以及封面上传、作品保存、列表、历史恢复和软删除。

## 环境要求

- Node.js 24 或更高版本
- npm 11 或兼容版本
- 已按 `../docs/DATABASE_DESIGN.md` 创建好的 PostgreSQL 数据库

## 本地启动

1. 在 `server/` 中执行 `npm install`。
2. 复制 `.env.example` 为 `.env`，填入数据库、微信 AppID/AppSecret 和 `OPENID_HASH_SECRET`。不要提交 `.env`。
3. 执行 `npm run build`。
4. 可先执行 `npm run db:inspect` 查看只读结构校验报告。
5. 执行 `npm start`。

可用 Node.js 生成本地 `OPENID_HASH_SECRET`：

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

服务在监听端口前会开启 `READ ONLY` 事务，检查数据库产品、版本、10 张表、字段、索引、外键、CHECK 约束和注释。发现任何结构差异时会拒绝启动，不会自动修复数据库。

健康检查：

```http
GET /health
```

成功响应只包含服务、数据库产品/版本和结构状态，不包含连接字符串、用户名或密码。

## 阶段 1 接口

### 微信登录

```http
POST /api/auth/login
Content-Type: application/json

{"code":"wx.login 返回的临时 code"}
```

服务端调用微信登录凭证校验接口，只保存 openid 的 HMAC 摘要。响应中的 token 是随机 opaque token，数据库只保存其 SHA-256 摘要；openid、session_key、AppSecret 和 token 明文不会写入普通日志。

### 当前用户

```http
GET /api/users/me
Authorization: Bearer <登录接口返回的 token>
```

用户归属只从 Bearer token 解析，不接受请求体或查询参数中的 `userId`。

### 完善头像和昵称

微信小程序不支持以 `PATCH` 作为 `wx.request` 方法，因此小程序更新昵称使用 `PUT`；服务端同时兼容标准的 `PATCH`：

```http
PUT /api/users/me
Authorization: Bearer <token>
Content-Type: application/json

{"nickname":"拼豆玩家"}
```

选择新头像时使用 `wx.uploadFile`，头像和昵称在同一次请求中更新：

```http
POST /api/users/me/avatar
Authorization: Bearer <token>
Content-Type: multipart/form-data

file=<JPG、PNG 或 WEBP，最大 2 MB>
nickname=拼豆玩家
```

头像保存在 `AVATAR_STORAGE_DIR`，公开读取地址为 `/api/media/avatars/<随机文件名>`。生产环境应把该目录挂载到持久化磁盘，或将 `AvatarStorage` 替换为对象存储实现。

## 阶段 2 接口

封面上传使用 `multipart/form-data`，必须携带 `file` 和 `type=cover`；服务端校验真实图片格式、扩展名、大小和可解码性，只保存生成的封面对象及 `pindou_file_assets` 元数据：

```http
POST /api/files/upload
Authorization: Bearer <token>
file=<JPG、PNG 或 WEBP，最大 10 MB>
type=cover
```

作品保存使用 `Idempotency-Key`，请求体只能包含 `title`、`coverFileId`、`status` 和 `pattern`。作品列表不返回完整 `cells`，详情接口返回可独立恢复的 `pattern`；删除采用软删除，不删除额度流水或已支付订单。

封面默认使用本地文件系统适配器作为开发环境的对象存储替身。生产环境应配置 `COVER_STORAGE_DIR` 的持久化目录，并将 `COVER_PUBLIC_BASE_URL` 指向 CDN/对象存储公开地址；如接入云对象存储，替换 `CoverStorage` 实现即可，数据库接口不变。

## 可用命令

- `npm run typecheck`：TypeScript 类型检查。
- `npm run build`：编译到 `dist/`。
- `npm test`：编译并运行配置与健康检查测试。
- `npm run db:inspect`：执行只读数据库元数据校验。
- `npm start`：启动已编译服务。

项目暂未引入独立 lint 工具，以避免增加无必要依赖；`typecheck` 负责当前静态检查。

小程序 AppID、AppSecret、HTTPS API 地址和微信 request 合法域名配置见 `../docs/WECHAT_LOGIN_SETUP.md`。
