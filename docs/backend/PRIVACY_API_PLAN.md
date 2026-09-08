# 隐私相关子页面 API 方案与开发计划

> 文档状态：后端与小程序第一版已实现，正式法律文本版本为 2026-09-07；仍待产品确认注销后的重新注册策略和上线配置
>
> 适用范围：隐私设置、隐私政策、个人信息收集清单、第三方信息共享清单、账号注销
>
> 方案基线：当前可运行代码、`server/src/db/schema-contract.ts` 和现有 PostgreSQL 结构

## 1. 当前范围与结论

当前小程序只有一个隐私页面：`miniprogram/pages-sub/privacy/index`页面包含：

- 本地保存、云同步、服务通知、个性化推荐四个开关；
- 隐私政策、个人信息收集清单、第三方信息共享清单三个文档入口；
- 注销账号入口

当前状态：

- 四个偏好已增加服务端存储和读写接口，小程序已接入并支持失败回滚；
- 三个文档入口由服务端受控静态内容提供，小程序已接入展示；
- 注销账号后端接口和小程序确认、退出流程均已实现；
- 后端已通过 Bearer 鉴权、用户服务、用户软删除和会话撤销实现本阶段最小闭环；
- 当前作品保存受 `cloudSync` 控制；已有本地作品只在隐私页开启云同步并明确确认后迁移

因此，隐私功能应拆成“文档读取、偏好同步、账号注销”三条链路，不能只新增一个 PATCH 接口

## 2. 推荐的 API 总览

| 能力 | Method | Path | 登录 | 说明 |
|---|---|---|---|---|
| 读取法律文档 | GET | `/api/legal-documents/:key` | 否 | 三个文档统一接口，文档内容由服务端下发 |
| 读取当前用户隐私偏好 | GET | `/api/users/me/privacy` | 是 | 也随 `GET /api/users/me` 的 `privacy` 字段返回 |
| 更新隐私偏好 | PATCH | `/api/users/me/privacy` | 是 | 部分更新，用户身份只从 Bearer Token 获取 |
| 注销账号 | DELETE | `/api/users/me` | 是 | 事务内软删除/停用账号，重复调用保持幂等 |

`GET /api/users/me` 与专用的 `GET /api/users/me/privacy` 返回同一份偏好数据：前者减少登录恢复时的请求，后者方便隐私页单独刷新

## 3. 法律文档接口

### 3.1 文档 Key

第一版只允许以下固定值：

```text
privacy-policy              隐私政策
personal-information        个人信息收集清单
third-party-sharing         第三方信息共享清单
```

不接受任意文件路径、URL 或客户端传入的内容地址

### 3.2 请求

```http
GET /api/legal-documents/privacy-policy
```

该接口不要求登录，使用户在登录前也能阅读隐私政策

### 3.3 响应

```json
{
  "document": {
    "key": "privacy-policy",
    "title": "隐私政策",
    "version": "2026-09-07",
    "effectiveAt": "2026-09-07T00:00:00+08:00",
    "contentType": "rich-text",
    "content": "<p>……经服务端清洗后的可信内容……</p>"
  }
}
```

约束：

- `key` 必须白名单校验，不存在返回 `404 DOCUMENT_NOT_FOUND`；
- 文档内容只能来自服务端受控配置或数据库，不能透传用户输入；
- `content` 若使用 HTML，服务端发布前必须做标签白名单清洗；
- 小程序使用 `<rich-text>` 展示，不拼接用户输入；
- 文档接口可以使用短时公共缓存，用户资料和偏好接口继续使用 `no-store`；
- 第一版不做后台 CMS，文档先由版本化 JSON/Markdown 构建产物提供，后续再替换为内容管理服务

### 3.4 文档接口不负责“同意”

阅读文档与记录用户同意是两件事第一版只做展示，不自动记录“同意”如果后续需要保存注册/登录时的协议同意，应另外设计：

```text
pindou_user_consents
```

至少记录用户、文档 Key、文档版本、同意时间和来源，不能用 `privacyPreferences` 四个开关代替法律同意记录

## 4. 隐私偏好接口

### 4.1 当前用户响应增加 `privacy`

在现有 `GET /api/users/me` 响应中增加：

```json
{
  "privacy": {
    "localOnly": true,
    "cloudSync": false,
    "serviceNotices": true,
    "personalizedRecommendations": false,
    "updatedAt": "2026-09-07T12:00:00.000Z"
  }
}
```

这样登录恢复后，作品保存链路可以直接使用服务端返回的最新偏好

### 4.2 更新请求

```http
PATCH /api/users/me/privacy
Authorization: Bearer <token>
Content-Type: application/json

{
  "cloudSync": true
}
```

允许字段：

```text
localOnly
cloudSync
serviceNotices
personalizedRecommendations
```

规则：

- 请求必须至少包含一个字段；
- 只能包含上述字段，所有值必须是 boolean；
- 不接受 `userId`、`openid`、`updatedAt` 等客户端拥有字段；
- 更新采用绝对值语义，网络重试不会造成重复副作用；
- 服务端以 Token 中的用户 ID 更新，不信任请求体中的用户身份；
- `updatedAt` 由服务端生成；
- 成功返回完整的最新偏好，而不是只返回 PATCH 字段

成功响应：

```json
{
  "privacy": {
    "localOnly": false,
    "cloudSync": true,
    "serviceNotices": true,
    "personalizedRecommendations": false,
    "updatedAt": "2026-09-07T12:00:00.000Z"
  }
}
```

### 4.3 本地保存与云同步的关系

`localOnly` 与 `cloudSync` 在业务上是互斥的第一版服务端在更新时执行以下归一化：

| 用户操作 | 服务端结果 |
|---|---|
| `localOnly=true` | 同时将 `cloudSync` 设为 `false` |
| `cloudSync=true` | 同时将 `localOnly` 设为 `false` |
| 关闭当前开关 | 保留另一个字段的当前值 |

这样可以兼容现有双开关 UI，同时避免两个开关同时为 `true`后续如重新设计 UI，建议将这两个字段收敛为一个 `storageMode: local\|cloud`，但当前不提前改动页面交互

### 4.4 云同步开关不直接上传作品

PATCH 接口只负责保存偏好，不在服务端隐式触发作品上传开启云同步时，小程序执行：

```text
用户点击“同步作品到云端”
  → 登录态校验
  → 二次确认是否上传已有本地作品
  → PATCH /api/users/me/privacy
  → 用户确认后逐个调用现有 POST /api/works
  → 成功作品替换本地关联，失败作品保留本地
```

关闭云同步时：

- 不删除已经存在的云端作品；
- 后续新建/编辑作品保存到本地；
- 不自动把云端作品下载回本地；
- 如需删除云端数据，必须提供单独且明确的删除操作

本次已修改两处现有链路：

- `miniprogram/pages-sub/editor/index.ts`：从“登录即云端保存”改为“登录且 `cloudSync=true` 才云端保存”；
- `miniprogram/pages-sub/services/local-work-sync.ts`：只在用户在隐私设置中确认开启云同步后执行；`auth-store.ts` 登录和恢复链路不得自动调用迁移该服务归属隐私设置分包，避免被错误打入主包

`serviceNotices` 和 `personalizedRecommendations` 第一阶段只保存偏好，不伪造通知或推荐功能；对应功能上线时再读取这两个字段

## 5. 数据库方案

### 5.1 推荐方案：扩展 `pindou_users`

当前只有四个布尔偏好，且它们与用户一一对应，第一版直接扩展用户表最简单：

```sql
ALTER TABLE pindou_users
  ADD COLUMN privacy_local_only boolean NOT NULL DEFAULT true,
  ADD COLUMN privacy_cloud_sync boolean NOT NULL DEFAULT false,
  ADD COLUMN privacy_service_notices boolean NOT NULL DEFAULT true,
  ADD COLUMN privacy_personalized_recommendations boolean NOT NULL DEFAULT false;
```

每个字段都要有数据库注释迁移完成后：

- 同步 `server/src/db/schema-contract.ts`；
- 更新 `docs/backend/database/DATABASE_SCHEMA.md`；
- 增加 `server/sql/004_privacy_preferences.sql`；
- 执行 `npm run db:inspect`；
- 旧用户通过默认值平滑补齐，不允许使用可空字段表达未初始化状态

### 5.2 暂不新增独立偏好表

第一版不新增 `pindou_user_privacy_preferences`，原因是当前字段数量少、没有偏好历史查询需求，也没有必要增加 JOIN 和新的表级迁移约束

如果未来需要偏好变更审计、设备来源、策略版本或多套隐私配置，再拆分独立表，并保留当前 API 契约不变

## 6. 账号注销接口

### 6.1 请求与响应

```http
DELETE /api/users/me
Authorization: Bearer <token>
```

成功：

```http
204 No Content
```

接口必须幂等：账号已经注销时再次请求仍返回成功或等价的已注销结果，不暴露额外用户信息

### 6.2 服务端事务

在一个数据库事务中：

```text
锁定当前用户
  → 标记 users.deleted_at
  → 清空/匿名化昵称、头像和可恢复身份字段
  → 软删除用户作品
  → 清理收藏关系
  → 撤销该用户全部 auth sessions
  → 提交事务
```

保留边界：

- 已支付订单、额度流水等财务/审计记录不能因为注销而被篡改；
- 下载记录保留必要的历史快照，但不再允许继续访问用户作品；
- 头像、封面、AI 输入和 AI 输出对象文件在事务提交后调用对应存储的物理删除；
- 清理失败不能回滚已经成功的账号注销，当前由存储层按幂等删除处理，生产环境仍需配置失败监控和补偿清理任务；
- 不在日志中记录 Token、openid、头像地址或完整用户资料

需要产品先确认一项规则：注销后同一个微信账号是否允许重新注册当前 `openid_hash` 唯一且登录遇到已删除用户会拒绝，因此若要支持重新注册，需要在注销时安全替换/释放身份索引，不能只设置 `deleted_at`

## 7. 错误契约

继续使用现有错误结构：

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "请求参数无效",
    "requestId": "req_xxx",
    "details": {}
  }
}
```

建议新增错误码：

| HTTP | Code | 场景 |
|---:|---|---|
| 400 | `INVALID_ARGUMENT` | 偏好字段非法、文档 Key 非法 |
| 401 | `UNAUTHORIZED` | 未登录或 Token 失效 |
| 404 | `DOCUMENT_NOT_FOUND` | 文档不存在 |
| 409 | `ACCOUNT_STATE_INVALID` | 注销状态与请求冲突 |
| 500 | `INTERNAL_ERROR` | 服务内部错误 |

## 8. 后续开发与上线验收计划

第一版代码已完成阶段 A-E 的接口、页面和主链路实现下面保留原计划作为上线前核对表；带“待确认/待补充”的项目不应在上线前遗漏

### 阶段 A：契约与数据库（接口已完成，产品决策待确认）

1. 确认四个偏好的最终语义，特别是 `localOnly` / `cloudSync` 互斥规则
2. 确认注销后是否允许同一微信账号重新注册
3. 新增数据库迁移、字段注释和 Schema Contract
4. 更新当前 Schema 文档，不改写历史 MVP 设计结论

### 阶段 B：后端偏好接口（已完成）

1. 扩展 `UserProfileService` 的读写能力
2. 增加偏好请求校验和归一化逻辑
3. 在 `GET /api/users/me` 返回 `privacy`
4. 增加 `PATCH /api/users/me/privacy` 路由
5. 添加未登录、非法字段、部分更新、互斥规则和用户隔离测试

### 阶段 C：法律文档读取（主链路已完成，正式文本与缓存策略待补充）

1. 固化三个文档 Key、标题、版本和生效时间
2. 增加 `GET /api/legal-documents/:key`
3. 增加不存在 Key、内容格式和缓存策略测试
4. 小程序增加文档展示页，统一处理加载、空内容、请求失败和返回

### 阶段 D：小程序偏好接入（已完成）

1. 登录恢复时把服务端 `privacy` 写入本地缓存
2. 隐私页面开关采用“请求成功提交，失败回滚”的状态机
3. 开启云同步前增加确认弹窗，确认后才迁移已有本地作品
4. 保存作品读取 `cloudSync`；登录和恢复链路不再自动迁移本地作品
5. 离线时保留最后一次服务端状态，并明确提示本次修改未同步

### 阶段 E：账号注销（主链路和物理文件删除触发已完成，生产存储验收待补充）

1. 先实现数据库事务和会话撤销
2. 已接入头像、封面、AI 输入和 AI 输出文件清理，并在事务提交后执行
3. 小程序增加二次确认、处理中状态、成功退出登录和失败重试
4. 已用服务测试验证四类文件均触发物理删除；仍需用生产实际存储验证注销后旧 Token、旧作品、旧收藏和旧文件访问行为

### 阶段 F：上线前验收

- 新用户默认值正确；
- 多设备读取到同一份偏好；
- 偏好更新失败时 UI 回滚；
- 云同步开启前不会静默上传；
- 关闭云同步不会误删云端作品；
- 文档可以在未登录状态下查看；
- 注销会撤销全部会话；
- 重复注销不会产生异常副作用；
- 财务流水和支付订单不会被错误删除；
- `npm run typecheck`、`server npm run build`、`server npm test` 和 `npm run db:inspect` 均通过

## 9. 本次不纳入

- 隐私文档后台 CMS；
- 用户协议同意记录；
- 偏好变更历史审计页面；
- 云端作品批量删除；
- 通知发送系统；
- 个性化推荐系统；
- 重新下载服务端文件

这些能力可以复用本方案的用户归属和文档版本设计，但不应在本阶段提前实现
