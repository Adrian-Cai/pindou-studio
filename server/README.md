# 拼豆工作室后端

当前完成阶段 0 至阶段 6 的代码：服务基础、PostgreSQL 结构校验、微信登录、用户资料、文件与作品、收藏、双额度、下载记录、套餐支付，以及 AI 精致生成任务状态机真实支付和生产基础设施验收见 `../docs/backend/operations/PRODUCTION_PAYMENT_AI_ACCEPTANCE.md`

## 环境要求

- Node.js 24 或更高版本
- npm 11 或兼容版本
- 已按 `../docs/backend/database/DATABASE_DESIGN.md` 创建好的 PostgreSQL 数据库

## 本地启动

1. 在 `server/` 中执行 `npm install`
2. 复制 `.env.example` 为 `.env`，填入数据库、微信 AppID/AppSecret 和 `OPENID_HASH_SECRET`不要提交 `.env`
3. 执行 `npm run build`
4. 可先执行 `npm run db:inspect` 查看只读结构校验报告
5. 执行 `npm start`

本地开发服务统一监听 `127.0.0.1:4000`；健康检查地址为 `http://127.0.0.1:4000/health`

可用 Node.js 生成本地 `OPENID_HASH_SECRET`：

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

服务在监听端口前会开启 `READ ONLY` 事务，检查数据库产品、版本、11 张表、字段、索引、外键、CHECK 约束和注释发现任何结构差异时会拒绝启动，不会自动修复数据库

已有数据库部署本版本前，先由 `pindou_*` 表 owner 按编号顺序执行 `sql/001_ai_quota_and_jobs.sql` 至 `sql/007_ai_generation_packages_only.sql`，再执行 `npm run db:inspect`：

```powershell
psql "<由运维安全提供的迁移连接>" -v ON_ERROR_STOP=1 -f sql/006_favorites_soft_delete.sql
psql "<由运维安全提供的迁移连接>" -v ON_ERROR_STOP=1 -f sql/007_ai_generation_packages_only.sql
```

迁移必须按编号顺序执行；`006_favorites_soft_delete.sql` 会回填历史收藏时间，增加收藏软删除字段与有效收藏时间索引，`007_ai_generation_packages_only.sql` 会停用历史下载/无限会员套餐但不修改历史订单快照。部署代码前必须先完成结构迁移，否则结构校验会阻止服务启动。

健康检查：

```http
GET /health
```

成功响应只包含服务、数据库产品/版本和结构状态，不包含连接字符串、用户名或密码

## 阶段 1 接口

### 微信登录

```http
POST /api/auth/login
Content-Type: application/json

{"code":"wx.login 返回的临时 code"}
```

服务端调用微信登录凭证校验接口，只保存 openid 的 HMAC 摘要响应中的 token 是随机 opaque token，数据库只保存其 SHA-256 摘要；openid、session_key、AppSecret 和 token 明文不会写入普通日志

### 当前用户

```http
GET /api/users/me
Authorization: Bearer <登录接口返回的 token>
```

用户归属只从 Bearer token 解析，不接受请求体或查询参数中的 `userId`

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

头像保存在 `AVATAR_STORAGE_DIR`，公开读取地址为 `/api/media/avatars/<随机文件名>`生产环境应把该目录挂载到持久化磁盘，或将 `AvatarStorage` 替换为对象存储实现

## 阶段 2 接口

封面上传使用 `multipart/form-data`，必须携带 `file` 和 `type=cover`；服务端校验真实图片格式、扩展名、大小和可解码性，只保存生成的封面对象及 `pindou_file_assets` 元数据：

```http
POST /api/files/upload
Authorization: Bearer <token>
file=<JPG、PNG 或 WEBP，最大 10 MB>
type=cover
```

作品保存使用 `Idempotency-Key`，请求体只能包含 `title`、`coverFileId`、`status` 和 `pattern``PUT/PATCH /api/works/:id` 支持改名、换封面、修改状态和覆盖保存图案，服务端会重新校验图案和统计数据作品列表不返回完整 `cells`，详情接口返回可独立恢复的 `pattern`；删除采用软删除，不删除额度流水或已支付订单

封面默认使用本地文件系统适配器作为开发环境的对象存储替身，并可从 `GET /api/media/covers/:filename` 读取生产环境应配置 `COVER_STORAGE_DIR` 的持久化目录，并将 `COVER_PUBLIC_BASE_URL` 指向 CDN/对象存储公开地址；如接入云对象存储，替换 `CoverStorage` 实现即可，数据库接口不变

## 阶段 3、4 接口

收藏接口包括 `PATCH /api/works/:id/favorite` 和 `GET /api/favorites`，只允许操作当前登录用户自己的可用作品。收藏关系使用软删除；重复收藏或取消不会刷新时间，重新收藏会更新 `favoritedAt`，收藏列表按该字段倒序返回。

`GET /api/quota/me` 从额度流水汇总当前用户额度，并按 `Asia/Shanghai` 自然日懒创建每日免费额度流水；数据库中的 `created_at` 仍使用 UTC 时间`GET /api/downloads` 只返回下载记录和作品标题快照，不返回文件 URL

标准下载每日免费 9 次；AI 精致生成每日免费 3 次两者分别使用 `standard_download` 和 `ai_generation`，不会互相消耗

客户端成功保存 Canvas 导出的图片后调用：

```http
POST /api/downloads
Authorization: Bearer <token>
Idempotency-Key: <一次导出动作的稳定唯一键>
Content-Type: application/json

{"workId":"work_xxx","fileType":"preview"}
```

服务端在同一事务中校验幂等键和作品归属、锁定当前用户额度、写下载记录并写一笔 `amount = -1` 的额度流水今日免费额度优先，之后使用购买额度；不足时返回 `402 QUOTA_INSUFFICIENT`，且不留下下载记录或负数流水

## 阶段 5 接口

`GET /api/packages` 公开返回数据库中已启用的 AI 生成次数套餐；创建支付订单需要登录和稳定的 `Idempotency-Key`，请求体只允许包含服务端套餐 ID：

```http
POST /api/payments/create
Authorization: Bearer <token>
Idempotency-Key: <一次下单动作的稳定唯一键>
Content-Type: application/json

{"packageId":"ai_generation_80"}
```

服务端从 `pindou_packages` 读取价格和额度、写入订单快照，再调用微信支付 v3 JSAPI/小程序下单客户端只会收到 `wx.requestPayment` 所需字段，不会收到商户私钥、API v3 密钥、AppSecret 或签名原文

`POST /api/payments/notify` 仅使用微信支付请求头和原始请求体完成验签，不读取 Bearer token回调通过平台公钥验签并使用 API v3 密钥解密后，服务端再次校验商户号、AppID、订单号、金额、币种、付款人和支付状态；首次成功在同一事务内把订单改为 `paid` 并写一笔 `purchase_grant`，重复回调只确认成功

支付环境变量见 `.env.example`支付配置全部缺省时，套餐读取仍可用，创建支付与回调返回 `PAYMENT_NOT_CONFIGURED`；部分配置会被视为配置错误并阻止启动已有用户需要重新登录一次，以便服务端在 `openid_ciphertext` 中保存支付所需的加密身份

## 阶段 6 接口

上传 AI 输入图片时复用 `POST /api/files/upload` 并设置 `type=ai_input`随后使用 `Idempotency-Key` 调用 `POST /api/ai/generations`，请求体只包含 `inputFileId`、`style`、`detailLevel` 和 `backgroundMode`；用 `GET /api/ai/generations/:id` 轮询状态

服务端调用千问图像 3.0 异步接口，持久化 Provider 任务 ID，并在输出图片下载、格式校验和文件资产落库成功后才扣除一笔 `ai_generation`Provider 失败、超时或无效输出不伪造成功，也不扣额度

## 可用命令

- `npm run typecheck`：TypeScript 类型检查
- `npm run build`：编译到 `dist/`
- `npm test`：编译并运行配置与健康检查测试
- `npm run db:inspect`：执行只读数据库元数据校验
- `npm start`：启动已编译服务

项目暂未引入独立 lint 工具，以避免增加无必要依赖；`typecheck` 负责当前静态检查

小程序 AppID、AppSecret、HTTPS API 地址和微信 request 合法域名配置见 `../docs/backend/operations/WECHAT_LOGIN_SETUP.md`
