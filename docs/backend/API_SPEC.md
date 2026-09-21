# 拼豆工作室后端 API 规格

> 文档状态：MVP 设计稿
>
> 版本：v1.0
>
> 适用范围：小程序云端账号、作品、文件、收藏、双额度、下载记录、AI 精致生成和微信支付
>
> 本文档以 `docs/backend/拼豆工作室 · 小程序后端 API 需求审计.md` 为输入，并对审计中尚未收敛的部分做出第一版约束

## 1. 第一版结论

### 1.1 明确纳入

| 阶段 | 能力 | 接口 |
| --- | --- | --- |
| 1 | 微信登录、当前用户 | `POST /api/auth/login`、`GET/PUT/PATCH /api/users/me`、`POST /api/users/me/avatar` |
| 2 | 封面上传、作品保存与恢复 | `POST /api/files/upload`、`GET /api/media/covers/:filename`、`POST /api/works`、`GET /api/works`、`GET /api/works/:id`、`PUT/PATCH /api/works/:id`、`DELETE /api/works/:id` |
| 3 | 收藏 | `PATCH /api/works/:id/favorite`、`GET /api/favorites` |
| 4 | 额度与下载记录 | `GET /api/quota/me`、`GET /api/downloads`、`POST /api/downloads` |
| 5 | 套餐与支付 | `GET /api/packages`、`GET /api/orders`、`POST /api/payments/create`、`POST /api/payments/notify` |
| 6 | AI 精致生成 | `POST /api/ai/generations`、`GET /api/ai/generations/:id` |
| 7 | 内容安全审核 | `POST /api/content-security/text`、`POST /api/content-security/media`、`GET/POST /api/wechat/content-security/callback` |
| 8 | 隐私设置、法律文档和注销 | `GET/PATCH /api/users/me/privacy`、`GET /api/legal-documents/:key`、`DELETE /api/users/me` |

### 1.2 明确暂不纳入

- 图片量化继续由小程序 `createDraft()` 在客户端完成
- 不开发服务端成品图、施工图或材料清单生成
- 不开发 `GET /api/files/download/:workId/:type`
- 不永久保存原始上传图片；第一版只上传作品封面/预览图
- 意见反馈通过微信小程序客服会话完成，不开发服务端反馈接口

### 1.3 内容安全审核

- 作品名称保存前调用微信 `msgSecCheck`，服务端使用 `openid` 和 `version=2`
- 原图上传先通过同步图片审核，再提交微信 `mediaCheckAsync`；异步结果通过消息推送回调落库
- 审核风险只向用户展示“你发布的内容含违规信息，请修改后重试”，不返回微信标签、关键词或原始错误信息
- 原始审核图片只存放在短期临时存储中，不作为作品资产永久保存

## 2. 关键业务原则

### 2.1 图片与图案生成

```text
用户选择图片
  → 小程序本地量化
  → PatternDraft
  → 用户编辑
  → 客户端生成封面图
  → 上传封面
  → 保存 Work + 压缩后的 Pattern
```

服务器不参与图片量化，也不接受一个临时 `sourceImagePath` 作为可恢复资源`sourceImagePath` 只属于客户端运行时状态，不能写入服务端作为作品数据

### 2.2 登录身份

```text
wx.login()
  → 获得 code
  → POST /api/auth/login
  → 服务端向微信换取 openid/session_key
  → 创建或查询 User
  → 返回本系统 token
```

`nickname` 和 `avatarUrl` 初始允许为 `null`微信登录成功不等于服务端已经拥有用户真实昵称和头像；第一版不通过登录接口臆造或强制补齐这两个字段

### 2.3 数据归属

- 除登录接口外，所有接口通过 `Authorization: Bearer <token>` 识别当前用户
- 请求体、查询参数和路径中不得接受 `userId` 作为数据归属依据
- 作品、收藏、额度、下载记录和订单都必须在服务端校验当前用户归属
- 第一版只支持登录后产生的云端数据；匿名用户继续使用本地状态旧的匿名本地作品是否批量迁移，由后续客户端迁移流程另行决定

### 2.4 下载行为

第一版的“下载”是客户端导出并保存图片，服务器只做额度校验和记录：

```text
客户端 Canvas 渲染
  → wx.canvasToTempFilePath
  → wx.saveImageToPhotosAlbum
  → POST /api/downloads 记录成功下载并扣额度
```

服务器不返回下载 URL，也不生成文件`POST /api/downloads` 使用幂等键，网络重试不得重复扣除额度

第一版约定：每一次成功的导出动作最多消耗 1 次额度；同一次动作的重试使用相同幂等键，不重复扣除是否对同一作品的后续重复导出免扣，留待产品规则确定

## 3. 通用约定

### 3.1 Base URL 与媒体类型

- Base URL 由小程序环境配置提供，本文档只定义 `/api` 后的路径
- JSON 请求和响应使用 `application/json; charset=utf-8`
- 上传接口使用 `multipart/form-data`
- 时间统一使用 ISO 8601 字符串，服务端存储 UTC；额度重置按 `Asia/Shanghai` 的自然日计算

### 3.2 鉴权请求头

```http
Authorization: Bearer <token>
```

登录接口不需要鉴权支付回调不是小程序调用，不使用用户 token，而使用微信支付回调验签

### 3.3 分页

列表接口统一支持：

| 参数 | 类型 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `page` | integer | `1` | 最小 `1` |
| `pageSize` | integer | `20` | `1` 至 `50` |
| `query` | string | 空 | 当前接口允许时按作品标题搜索 |

统一响应形状：

```json
{
  "total": 1,
  "page": 1,
  "pageSize": 20,
  "items": []
}
```

### 3.4 错误响应

```json
{
  "error": {
    "code": "QUOTA_INSUFFICIENT",
    "message": "下载额度不足",
    "requestId": "req_xxx",
    "details": {}
  }
}
```

服务端不得把内部堆栈、`openid`、`session_key` 或支付密钥放入响应

常用状态码：

| HTTP | 错误码示例 | 含义 |
| --- | --- | --- |
| `400` | `INVALID_ARGUMENT` | 请求参数或图案结构不合法 |
| `401` | `UNAUTHORIZED`、`TOKEN_EXPIRED` | 缺少或失效的 token |
| `403` | `FORBIDDEN` | 资源不属于当前用户 |
| `404` | `NOT_FOUND` | 资源不存在 |
| `409` | `IDEMPOTENCY_CONFLICT` | 幂等键重复但请求内容不一致 |
| `413` | `FILE_TOO_LARGE` | 上传文件超过限制 |
| `422` | `UNPROCESSABLE_ENTITY` | 业务校验失败 |
| `402` | `QUOTA_INSUFFICIENT` | 额度不足，需要充值 |
| `402` | `USER_AI_QUOTA_EXHAUSTED` | AI 生成额度不足，需要充值 |
| `429` | `RATE_LIMITED` | 请求过于频繁 |
| `500` | `INTERNAL_ERROR` | 服务端异常 |

## 4. 核心数据结构

### 4.1 PersistedPattern

服务端保存的图案不是当前前端的 `PatternCell[]` 对象数组，而是颜色表加颜色索引：

```json
{
  "schemaVersion": 1,
  "generationMode": "standard",
  "width": 64,
  "height": 64,
  "settings": {
    "colorLimit": 32,
    "brand": "MARD"
  },
  "palette": [
    { "code": "C01", "color": "#f4d7bf" },
    { "code": "C02", "color": "#000000" }
  ],
  "cells": [0, 0, -1, 1, 1, 0]
}
```

约束：

- `generationMode` 只能为 `standard` 或 `ai`；缺失时仅为兼容历史客户端按 `standard` 处理
- `cells` 为行优先的一维数组，索引 `index = row * width + column`
- `cells.length` 必须严格等于 `width * height`
- `-1` 表示透明/空格；`0` 至 `palette.length - 1` 表示对应颜色
- `palette` 中的 `code` 和 `color` 是配对数据，颜色索引不能越界
- `width`、`height` 只允许产品支持的尺寸，当前为 `32/48/64/96/128`；最终以服务端配置为准
- `colorLimit` 和 `brand` 只作为图案设置保存；`colorCount` 由服务端根据实际 `palette` 和 `cells` 校验或重算
- 服务端不接受 `sourceImagePath`、前端 `createdAt`、前端 `id` 作为持久化事实

### 4.2 前端 PatternDraft 与服务端图案的映射

| 前端运行时字段 | 服务端处理 |
| --- | --- |
| `id` | 保存时由服务端生成 `workId`；客户端草稿 id 仅可作为幂等键的一部分 |
| `sourceImagePath` | 不保存；临时文件路径重启后失效 |
| `createdAt` | 不信任；使用服务端时间 |
| `generationMode` | 只允许 `standard` / `ai`；保存到作品摘要，作为恢复和重新生成时的模式事实 |
| `settings.width/height` | 写入 `pattern.width/height` |
| `settings.colorLimit/brand` | 写入 `pattern.settings` |
| `cells[].color/colorCode` | 客户端转换为 `palette` + `cells` |

历史作品恢复时，`GET /api/works/:id` 返回 `pattern`客户端可将它转换成当前编辑器需要的 `PatternDraft`；此时 `sourceImagePath` 应为空值或标记为“历史作品”，不能尝试读取旧临时路径

### 4.3 WorkSummary 与 WorkDetail

作品列表只返回摘要，作品详情返回完整图案：

```json
{
  "id": "work_xxx",
  "title": "未命名作品",
  "coverUrl": "https://cdn.example.com/covers/xxx.png",
  "width": 64,
  "height": 64,
  "beadCount": 3840,
  "colorCount": 12,
  "brand": "MARD",
  "generationMode": "standard",
  "status": "completed",
  "isFavorite": false,
  "createdAt": "2026-08-26T11:00:00Z",
  "updatedAt": "2026-08-26T11:00:00Z"
}
```

详情在上述字段上增加：

```json
{
  "pattern": {
    "schemaVersion": 1,
    "generationMode": "standard",
    "width": 64,
    "height": 64,
    "settings": { "colorLimit": 32, "brand": "MARD" },
    "palette": [],
    "cells": []
  }
}
```

材料清单不单独存表，由客户端根据 `palette` 和 `cells` 聚合生成；如未来需要固定材料版本，再增加服务端派生字段

## 5. API 详细规格

## 阶段 1：用户

### POST `/api/auth/login`

用途：用微信 `wx.login()` 返回的临时 `code` 换取本系统 token，并创建或查询用户

鉴权：不需要

请求：

```json
{ "code": "wx-login-code" }
```

响应 `200`：

```json
{
  "token": "opaque-token",
  "expiresAt": "2026-09-25T11:00:00Z",
  "user": {
    "id": "usr_xxx",
    "nickname": null,
    "avatarUrl": null
  }
}
```

规则：

- `code` 只能使用一次，服务端不得把它当作长期 token
- 服务端通过微信接口得到 `openid`，用 `openid` 找到或创建用户
- `openid` 不返回给小程序；`session_key` 不返回给小程序
- 重复登录可以创建新会话，但不能创建重复用户

### GET `/api/users/me`

用途：获取当前用户资料、基础统计和额度摘要

鉴权：需要

响应 `200`：

```json
{
  "user": {
    "id": "usr_xxx",
    "nickname": null,
    "avatarUrl": null,
    "createdAt": "2026-08-26T11:00:00Z"
  },
  "stats": {
    "workCount": 5,
    "favoriteCount": 2,
    "downloadCount": 3
  },
  "quota": {
    "dailyFree": 3,
    "usedToday": 1,
    "purchased": 0,
    "remaining": 2,
    "resetsAt": "2026-08-27T00:00:00+08:00"
  }
}
```

### PUT/PATCH `/api/users/me`

用途：更新当前用户昵称小程序端使用微信请求 API 支持的 `PUT`，服务端同时兼容 `PATCH`

鉴权：需要

```json
{ "nickname": "拼豆玩家" }
```

昵称去除首尾空白后必须为 1～80 个字符，且不能包含控制字符接口不接受客户端直接提交 `avatarUrl`

### POST `/api/users/me/avatar`

用途：上传并替换当前用户头像，同时保存昵称

鉴权：需要请求使用 `multipart/form-data`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `file` | binary | 真实格式必须为 JPG、PNG 或 WEBP，最大 2 MB |
| `nickname` | string | 1～80 个字符 |

服务端生成随机文件名，不信任客户端文件名，并在资料更新成功后安全清理旧头像响应中的 `avatarUrl` 为 `/api/media/avatars/...` 稳定地址，小程序请求层会基于当前环境 API Origin 转换为完整 URL

### GET `/api/media/avatars/:filename`

用途：公开读取用户头像，供小程序 `<image>` 展示文件名必须符合服务端生成规则；响应使用不可变缓存头

## 阶段 2：文件与作品

### POST `/api/files/upload`

用途：上传作品封面/预览图；第一版不上传原始图片

鉴权：需要

请求：`multipart/form-data`

| 字段 | 类型 | 值 |
| --- | --- | --- |
| `file` | binary | JPG、PNG 或 WEBP |
| `type` | string | 只能为 `cover` |

建议限制：单文件不超过 `10 MB`；服务端校验文件真实 MIME、扩展名和图片可解码性

响应 `201`：

```json
{
  "file": {
    "id": "file_xxx",
    "type": "cover",
    "url": "https://cdn.example.com/covers/xxx.png",
    "contentType": "image/png",
    "size": 182734,
    "createdAt": "2026-08-26T11:00:00Z"
  }
}
```

作品保存时使用 `file.id`，不直接信任客户端传入的任意 URL文件必须归属于当前用户；只有当前用户可以把它绑定到自己的作品

### GET `/api/media/covers/:filename`

用途：公开读取服务端生成的作品封面，供作品列表和详情页展示文件名必须符合服务端生成规则；响应使用不可变缓存头

### POST `/api/works`

用途：创建一份云端作品，保存摘要和完整的压缩图案

鉴权：需要

请求：

```json
{
  "title": "未命名作品",
  "coverFileId": "file_xxx",
  "status": "completed",
  "pattern": {
    "schemaVersion": 1,
    "generationMode": "standard",
    "width": 64,
    "height": 64,
    "settings": {
      "colorLimit": 32,
      "brand": "MARD"
    },
    "palette": [
      { "code": "C01", "color": "#f4d7bf" },
      { "code": "C02", "color": "#000000" }
    ],
    "cells": [0, 0, -1, 1]
  }
}
```

响应 `201`：返回 `WorkSummary`

服务端必须：

- 校验图案结构、尺寸、颜色索引和数组长度
- 校验 `generationMode`；`standard` 只保存标准算法结果，`ai` 只保存 AI 流程结果
- 根据 `cells` 重新计算 `beadCount`、`colorCount`，不信任客户端提交的统计值
- 使用服务端时间写入 `createdAt` 和 `updatedAt`
- 校验 `coverFileId` 属于当前用户且类型为 `cover`
- 使用请求幂等键避免小程序网络重试创建重复作品；推荐使用 `Idempotency-Key` 请求头

### GET `/api/works`

用途：获取当前用户的作品列表，支持历史作品入口

鉴权：需要

查询参数：

```text
?status=completed&page=1&pageSize=20&query=猫
```

允许的 `status`：`draft`、`completed`默认按 `updatedAt DESC` 返回

响应 `200`：分页的 `WorkSummary` 列表列表不返回 `pattern.cells`，避免无意义的大响应

### GET `/api/works/:id`

用途：获取当前用户作品详情，并恢复历史作品图案

鉴权：需要

响应 `200`：`WorkDetail`，包含摘要字段和完整 `pattern`

规则：

- 只允许读取当前用户的作品
- 返回的 `pattern` 必须能独立恢复编辑器网格，不依赖原始图片
- 如果封面文件不可用，作品数据仍应可读取；客户端显示默认占位图

### PUT/PATCH `/api/works/:id`

用途：更新当前用户作品小程序使用 `PUT`，服务端同时兼容标准 `PATCH`

鉴权：需要

请求体可包含 `title`、`coverFileId`、`status`、`pattern` 中的一项或多项，且至少包含一项更新 `pattern` 时服务端必须重新校验完整图案，并重新计算尺寸、豆数、颜色数和品牌；更新封面时必须重新校验文件归属和类型

响应 `200`：返回更新后的 `WorkSummary`

### DELETE `/api/works/:id`

用途：删除当前用户作品

鉴权：需要

响应：`204 No Content`

删除规则：

- 先校验作品归属
- 作品使用 `deleted_at` 软删除；收藏关系保留历史记录，并由收藏列表与统计通过作品的 `deleted_at` 隐藏
- 下载历史是否保留由数据库外键策略确定，建议保留记录但将 `workId` 置空或保留快照字段
- 封面对象可以异步清理，不得因为对象存储暂时失败而让数据库删除返回不确定状态

## 阶段 3：收藏

### PATCH `/api/works/:id/favorite`

用途：收藏或取消收藏当前用户可操作的作品

鉴权：需要

请求：

```json
{ "favorite": true }
```

响应 `200`：

```json
{ "workId": "work_xxx", "isFavorite": true, "favoritedAt": "2026-08-26T11:00:00Z" }
```

操作必须幂等：重复设置同一个值不创建重复收藏，也不刷新当前状态的时间。首次收藏写入关系；取消收藏只写 `deleted_at`；重新收藏复用原关系并刷新 `favorited_at`。收藏操作不修改作品的 `updated_at`。

### GET `/api/favorites`

用途：获取当前用户收藏的作品摘要

鉴权：需要

查询参数：`page`、`pageSize`、`query`，默认按 `favoritedAt DESC`

响应 `200`：分页的 `FavoriteWorkSummary` 列表，`isFavorite` 固定为 `true`，不返回完整 `pattern`。每项在 `WorkSummary` 基础上增加最近一次有效收藏时间 `favoritedAt`；`createdAt`、`updatedAt` 仍分别表示作品创建和最后修改时间。

## 阶段 4：额度与下载记录

### GET `/api/quota/me`

用途：获取当前用户可用下载额度

鉴权：需要

响应 `200`：

```json
{
  "dailyFree": 9,
  "usedToday": 1,
  "purchased": 0,
  "remaining": 8,
  "membershipType": null,
  "membershipExpiresAt": null,
  "resetsAt": "2026-08-27T00:00:00+08:00",
  "aiGeneration": {
    "dailyFree": 3,
    "usedToday": 0,
    "purchased": 80,
    "remaining": 83,
    "resetsAt": "2026-08-27T00:00:00+08:00"
  }
}
```

额度是服务端根据额度流水计算的结果；`remaining` 不能由客户端传入或覆盖默认消耗顺序为“今日免费额度优先，其次为购买额度”

### GET `/api/downloads`

用途：获取当前用户下载记录

鉴权：需要

查询参数：

```text
?fileType=chart&page=1&pageSize=20&query=猫
```

响应 `200`：

```json
{
  "total": 1,
  "page": 1,
  "pageSize": 20,
  "items": [
    {
      "id": "dl_xxx",
      "workId": "work_xxx",
      "title": "未命名作品",
      "fileType": "chart",
      "consumedQuota": true,
      "quotaTransactionId": "qt_xxx",
      "downloadedAt": "2026-08-26T11:00:00Z"
    }
  ]
}
```

不返回 `fileUrl`，因为文件由客户端本地导出和保存

### POST `/api/downloads`

用途：记录一次客户端已经成功完成的导出，并原子地扣除 1 次额度

鉴权：需要

请求头：必须携带 `Idempotency-Key`，由客户端为一次导出动作生成并在重试中复用

请求：

```json
{
  "workId": "work_xxx",
  "fileType": "preview"
}
```

`fileType`：`preview`、`chart`、`materials`、`palette`

响应 `201`：

```json
{
  "downloadRecord": {
    "id": "dl_xxx",
    "workId": "work_xxx",
    "fileType": "preview",
    "consumedQuota": true,
    "quotaTransactionId": "qt_xxx",
    "downloadedAt": "2026-08-26T11:00:00Z"
  },
  "quota": {
    "remaining": 2,
    "usedToday": 1,
    "purchased": 0
  }
}
```

规则：

- 先校验作品属于当前用户，再在同一事务中检查额度、写下载记录和写额度流水
- 额度不足返回 `402 QUOTA_INSUFFICIENT`，不创建下载记录，不写负数额度
- 相同 `Idempotency-Key` 且请求内容相同，返回第一次成功结果，不重复扣除
- 相同 `Idempotency-Key` 但 `workId` 或 `fileType` 不同，返回 `409 IDEMPOTENCY_CONFLICT`
- 客户端保存图片失败时，不应调用本接口；如果已经调用后本地保存失败，第一版不自动退款，后续可增加人工调整或退款流水

## 阶段 5：套餐与支付

### GET `/api/packages`

用途：获取当前可售套餐价格、额度和启用状态由服务端配置，客户端不得以 URL 参数或本地常量作为支付事实

鉴权：可以不需要；如只对登录用户展示，也可要求登录，但不接受客户端价格

响应 `200`：

```json
{
  "items": [
    {
      "id": "ai_generation_80",
      "label": "AI 精致生成 80 次",
      "quotaAmount": 80,
      "quotaKind": "ai_generation",
      "membershipType": null,
      "priceFen": 1990,
      "currency": "CNY",
      "enabled": true
    }
  ]
}
```

### GET `/api/orders`

用途：获取当前用户的 AI 精致生成订单列表

鉴权：需要

查询参数：`page`、`pageSize`，默认 `page=1&pageSize=20`，`page` 最小为 `1`，`pageSize` 范围为 `1` 至 `50`

服务端必须：

- 只使用 Bearer Token 解析出的当前用户 ID，不接受查询参数或请求体中的 `userId`
- 只查询 `pindou_orders.quota_kind_snapshot = 'ai_generation'` 的订单
- 使用订单上的套餐名称、额度类型、额度数量、金额和时间快照，不重新读取当前套餐配置
- 按 `created_at DESC`（同时间再按 `id DESC`）返回
- 不返回 `openid`、支付签名、微信预支付 ID、微信交易号或其他支付敏感字段

响应 `200`：

```json
{
  "total": 1,
  "page": 1,
  "pageSize": 20,
  "items": [
    {
      "id": "order_xxx",
      "packageId": "ai_generation_80",
      "packageLabel": "AI 精致生成 80 次",
      "quotaAmount": 80,
      "quotaKind": "ai_generation",
      "priceFen": 1990,
      "currency": "CNY",
      "status": "paid",
      "createdAt": "2026-09-10T06:30:00.000Z",
      "paidAt": "2026-09-10T06:31:00.000Z"
    }
  ]
}
```

### POST `/api/payments/create`

用途：根据服务端套餐创建微信支付订单

鉴权：需要

请求：

```json
{ "packageId": "ai_generation_80" }
```

响应 `201`：

```json
{
  "orderId": "order_xxx",
  "payment": {
    "timeStamp": "1724660400",
    "nonceStr": "nonce_xxx",
    "package": "prepay_id=wx_xxx",
    "signType": "RSA",
    "paySign": "sign_xxx"
  }
}
```

规则：

- 服务端根据 `packageId` 读取价格和发放额度，忽略客户端传入的金额、额度、套餐名称
- 一个订单保存套餐快照，避免套餐之后改价导致无法对账
- 创建订单不直接增加用户额度；只有验签通过的支付回调可以发放额度
- 重试创建订单应使用幂等键，避免重复生成待支付订单

### POST `/api/payments/notify`

用途：接收微信支付服务器回调

调用方：微信支付服务器；不是小程序前端调用

鉴权：微信支付回调签名、证书和通知内容校验

处理要求：

- 验证签名、商户号、应用标识、订单号、金额和支付状态
- 只有首次确认支付成功时，订单从 `pending` 变为 `paid`，并写入一笔带 `orderId`、`quota_kind=ai_generation` 的 `purchase_grant`
- 重复回调必须返回成功确认，但不得重复增加额度
- 支付失败、关闭或金额不符不得发放额度
- 回调处理完成后返回微信要求的成功响应；内部异步任务失败不能造成重复发放

## 阶段 6：AI 精致生成

先使用 `POST /api/files/upload` 上传 `type=ai_input` 的 JPG、PNG 或 WEBP，然后创建任务：

```http
POST /api/ai/generations
Authorization: Bearer <token>
Idempotency-Key: <稳定唯一键>
Content-Type: application/json
```

```json
{
  "inputFileId": "file_xxx",
  "style": "natural",
  "detailLevel": "medium",
  "backgroundMode": "simplify"
}
```

服务端固定提示词模板并调用腾讯混元 Hy-Image-3.0 接口，不接受客户端 Provider、模型、价格、额度或任意提示词。创建接口先提交 `queued` 任务并返回，Provider 调用不在数据库事务或任务行锁内执行；服务端随后在后台调用同步 Provider，客户端通过 `GET /api/ai/generations/:id` 继续轮询项目任务状态。

当前服务端提示词模板版本为 `v2`。Prompt 根据 `style`、`detailLevel` 和 `backgroundMode` 由服务端组合生成，客户端不能传入任意 Prompt；AI 输出是交给 Standard Pattern Engine 的中间图，不是最终拼豆网格。

任务状态：

- `queued`：任务已落库，等待提交混元。
- `processing`：正在调用混元或下载输出；`provider_request_id` 为空时表示正在提交 Provider，临时失败时仍保持该状态。
- `succeeded`：输出图片已校验、持久化为 `ai_output`，并已完成一次 AI 额度扣减。
- `failed`：Provider、输入文件、输出文件或任务处理失败；失败不扣额度，公开响应只返回标准 `failure` 对象。
- `canceled`：预留状态，当前不提供取消接口。

任务成功时响应包含 `outputFile`。混元返回的临时图片地址只在服务端内部使用，服务端必须立即下载并持久化；输出文件校验、资产写入、任务成功更新和一笔 `usage_debit` 在受控流程中完成，相同任务不重复扣减。

任务公开响应不返回 `provider`、`model`、`promptVersion` 或供应商错误字段。失败对象统一使用 `code`、`message`、`category`、`retryable`、`action`；`AllocationQuota.FreeTierOnly` 等供应商诊断只进入受控结构化日志。

小程序端接入约束：

- 默认提交 `style=natural`、`detailLevel=medium`、`backgroundMode=simplify`，不提交 Prompt、Provider、Model、价格或额度字段。
- 输入图片必须先以 `type=ai_input` 上传成功，再创建 AI 任务；上传失败时不创建任务。
- 首页已经检测过同一张图片时，`type=ai_input` 上传应携带 `securityCheckId`；服务端校验用户、有效期和图片字节一致后复用检测结果，不再次调用微信图片检测。
- 客户端使用本地保存的 `Idempotency-Key` 重试创建请求；已有任务 ID 时只查询原任务，不重新创建。
- 任务成功后只下载服务端持久化的 `ai_output` 地址，再交给本地 Standard Pattern Engine；客户端不访问混元临时地址。
- 任务状态查询由客户端短请求轮询完成，页面隐藏或卸载时停止计时器，重新进入后可继续查询。

AI 安全与生命周期约束：

- `HUNYUAN_IMAGE_API_KEY` 只允许存在服务端环境变量，小程序包、接口响应和日志均不得出现该值。
- AI 输入和输出在服务端按文件真实字节格式重新校验，不信任扩展名或客户端 MIME；默认单文件不超过 10 MiB、宽高不超过 4096、像素数不超过 16 MP。
- AI 上传和任务创建按已认证用户限流，默认 10 分钟最多 5 次；多实例部署还必须在网关或共享存储层施加同等限制。
- 混元输出地址只接受 HTTPS 且主机名位于受信任的 `*.myqcloud.com` 域名下，禁止凭据、端口和跳转；服务端下载后才向任务响应暴露自有持久化媒体地址。
- AI 输入图片只执行一次微信图片内容安全审核；首页已有同图检测结果时由 AI 输入上传校验并复用，旧客户端无检测标识时仍在上传阶段检测。混元生成结果不再调用本项目的微信内容安全接口，由混元服务商负责其生成结果审核。服务端仍校验输出地址、真实图片格式、大小、尺寸及像素数后再持久化。
- AI 输入、输出文件默认保留 24 小时；过期任务、关联资产和未关联的 AI 输入先软删除，再异步物理清理。注销清理由账号删除事务提交后的物理清理继续负责。
- Provider 原始错误、内部堆栈、请求内容和配置不会返回客户端；客户端只接收稳定的业务错误码和用户可理解的提示。

## 6. 不在当前 API 中的接口

以下接口暂不实现，也不应在前端先伪造调用：

| 接口 | 原因 |
| --- | --- |
| `/api/files/download/:workId/:type` | 第一版由客户端 Canvas 导出并保存相册 |
| 意见反馈 | 通过小程序页面的 `<button open-type="contact">` 打开微信客服会话 |
| 公开作品分享接口 | 当前分享路径仍是首页，不支持他人读取作品 |

## 7. 前端接入顺序

1. 增加 HTTP 客户端和 token 存储；`app.ts` 调用 `wx.login()`，成功后获取 `/api/users/me`
2. 保存作品前，客户端将当前 `PatternCell[]` 转成 `PersistedPattern`，先上传客户端生成的封面，再创建作品
3. 作品列表只读摘要；打开历史作品时请求详情并将 `pattern` 还原成编辑器结构
4. 编辑历史作品后重新生成封面，并通过 `PUT /api/works/:id` 覆盖保存完整图案；单独改名只提交 `title`
5. 收藏、额度、下载记录切换到对应接口；本地 Storage 只保留 token、当前临时草稿和必要的离线 UI 状态
6. 接入支付时，套餐和额度均以服务端响应为准；支付成功页只刷新额度，不读取 URL 中的 `quota` 直接加数

## 8. 验收清单

- 未登录时可以继续本地生成和编辑，不调用需要登录的云端接口
- 登录响应中的 `nickname`、`avatarUrl` 可以为 `null`
- 保存作品请求不包含 `sourceImagePath`，且 `cells` 不是对象数组
- `cells.length = width * height`，透明格使用 `-1`，颜色索引不越界
- 历史作品详情只依赖服务端 `pattern`，删除本地临时图片后仍能恢复网格
- 作品列表不返回完整 `cells`，作品详情才返回完整 `pattern`
- 作品编辑、改名和换封面更新后再次读取详情，服务端摘要和完整 `pattern` 均为最新数据
- 删除、收藏、下载、额度和订单均按 token 归属校验
- 下载请求重试不重复扣除额度；额度不足不写下载记录
- 支付回调重复通知不重复发放额度
- 不存在生成任务 API、下载 URL API 或云同步开关 API
