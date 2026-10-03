# AI 图片生成接口文档

## 1. 文档范围

本文档描述当前代码实际实现的 AI 图片生成链路，供小程序、后端和本地联调使用。

链路包含三类接口：

1. 项目文件接口：上传 AI 输入图片。
2. 项目 AI 接口：创建生成任务、查询任务状态。
3. 服务端上游接口：后端调用 CloudBase `generateImage` 云函数，由云函数调用混元图像模型。

小程序只允许调用项目自己的接口，不能直接调用 CloudBase AI，也不能接触任何模型服务凭据。

当前实现对应：

- Provider：`hunyuan`
- 模型：`HY-Image-v3.0-I2I-ToB-v1.0.1`
- 云函数文字标识：`AI生成`
- Prompt 模板版本：`v3`
- 输入/输出文件默认保留：24 小时
- 默认本地服务地址：`http://127.0.0.1:4000`

TokenHub Provider 仅按数据库中既有任务快照处理在途任务；切换前创建的 CloudBase `hunyuan` 任务继续由同一 Provider 收尾。ToAPIs 凭据配置已移除，既有 ToAPIs 任务无法再访问上游，会在推进时失败关闭。

## 2. 总体参数流转

```text
小程序选择图片
    │
    ├─ POST /api/files/upload
    │    multipart: file + type=ai_input + securityCheckId（已有检测时）
    │
    └─ 返回 file.id
         │
         ├─ POST /api/ai/generations
         │    inputFileId + style + detailLevel + backgroundMode
         │    Idempotency-Key + Bearer Token
         │
         └─ 返回项目任务 id，通常为 queued
              │
              ├─ 服务端读取 inputFileId 对应的文件字节
              ├─ 根据三个业务参数生成固定 Prompt
              ├─ 调用 CloudBase generateImage 云函数
              │    └─ 云函数将 Prompt 和参考图交给混元 I2I 模型
              ├─ 云函数将产物保存到 CloudBase，返回 fileID
              │
              └─ GET /api/ai/generations/{id}
                   ├─ 从 CloudBase 下载生成图片
                   ├─ 校验并保存为 ai_output
                   ├─ 成功完成额度扣减
                   └─ 返回项目自己的 outputFile.url
```

参数对应关系：

| 来源参数 | 服务端处理 | 下游参数/结果 |
| --- | --- | --- |
| 上传文件二进制 | 校验真实图片格式、大小、尺寸并保存 | `pindou_file_assets.id`，即 `inputFileId` |
| `inputFileId` | 校验当前用户的 `ai_input` 文件并读取图片字节 | CloudBase 云函数 `imageDataUrl` |
| `style` | 选择风格 Prompt 片段 | 固定 Prompt |
| `detailLevel` | 选择细节 Prompt 片段 | 固定 Prompt |
| `backgroundMode` | 选择背景 Prompt 片段 | 固定 Prompt |
| 服务端固定模型 `HY-Image-v3.0-I2I-ToB-v1.0.1` | 客户端不可覆盖 | 混元 `model` |
| 服务端固定 Prompt | 客户端不可传入 | 混元 `prompt` |
| 混元 `request_id` | 保存到任务记录 | 服务端日志定位 |
| CloudBase `fileID` | 服务端下载，不向客户端透传 | 项目 `ai_output` 文件 |
| 项目 `outputFile.url` | 客户端下载并进入本地拼豆算法 | 最终 AI 中间图 |

安全审核边界：AI 输入图片只执行一次项目配置的微信内容安全审核。首页已检测过同一图片时，`POST /api/files/upload` 通过 `securityCheckId` 复用结果；旧客户端未携带标识时仍在 AI 输入上传阶段检测。混元生成结果的安全审核由模型服务商负责。服务端从 CloudBase 下载产物后仍会校验真实图片格式、大小、尺寸和像素数，再将结果保存为 `ai_output`。

## 3. 公共约定

### 3.1 认证

除输出媒体读取外，项目业务接口均需要：

```http
Authorization: Bearer <登录后的 token>
```

Token 由微信登录接口获得：

```http
POST /api/auth/login
Content-Type: application/json

{"code":"<wx.login 返回的 code>"}
```

### 3.2 错误响应

项目接口错误统一返回：

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "请求参数不合法",
    "requestId": "req_xxx",
    "details": {}
  }
}
```

`requestId` 用于服务端日志定位。AI 错误还会返回稳定的 `category`、`retryable` 和 `action`；服务端不会向客户端返回混元原始错误、API Key 或内部堆栈。

AI 公开错误结构为：

```json
{
  "error": {
    "code": "AI_SERVICE_UNAVAILABLE",
    "message": "AI 生成暂时不可用",
    "category": "PROVIDER",
    "retryable": false,
    "action": "USE_STANDARD_MODE",
    "requestId": "req_xxx",
    "details": {}
  }
}
```

`action` 只允许 `VIEW_BENEFITS`、`SELECT_IMAGE`、`USE_STANDARD_MODE`、`RETRY`。小程序必须先校验白名单，再决定按钮和跳转。

### 3.3 文件限制

当前默认配置如下，最终以服务端环境变量为准：

| 项目 | 默认值 |
| --- | ---: |
| 输入/输出文件大小 | 10 MiB |
| 图片最大宽度 | 4096 px |
| 图片最大高度 | 4096 px |
| 图片最大像素数 | 16,777,216 px |
| 支持输入格式 | JPG、PNG、WEBP |
| 输出格式 | PNG |

## 4. 接口一：上传 AI 输入图片

### 4.1 请求

```http
POST /api/files/upload
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

表单字段如下：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file` | 文件 | 是 | JPG、PNG 或 WEBP 图片 |
| `type` | 字符串 | 是 | 固定值 `ai_input` |
| `securityCheckId` | 字符串 | 否 | 首页已完成同一张图片的内容安全检测时传入；服务端核对用户、有效期和图片字节后复用该结果，不重复检测 |

示例：

```bash
curl -X POST "http://127.0.0.1:4000/api/files/upload" \
  -H "Authorization: Bearer <token>" \
  -F "file=@./input.png;type=image/png" \
  -F "type=ai_input" \
  -F "securityCheckId=sec_xxx"
```

### 4.2 成功响应

HTTP 状态码：`201 Created`

```json
{
  "file": {
    "id": "file_01JXXXXXXXXXXXX",
    "type": "ai_input",
    "url": "/api/media/ai/ai_input_0123456789abcdef0123456789abcdef.png",
    "contentType": "image/png",
    "size": 245678,
    "createdAt": "2026-09-12T08:00:00.000Z"
  }
}
```

后续创建任务只使用 `file.id`，即上例中的 `inputFileId`。客户端不需要把 `url` 转成混元地址。

### 4.3 常见失败

| HTTP | `error.code` | 原因 |
| ---: | --- | --- |
| 400 | `INVALID_ARGUMENT` | 表单字段不完整、`type` 不是 `ai_input` 或图片格式无效 |
| 400 | `CONTENT_RISKY` | 输入图片未通过内容安全检查 |
| 401 | `UNAUTHORIZED` | Token 缺失、无效或过期 |
| 409 | `CONTENT_SECURITY_CHECK_INVALID` | 检测标识已失效、用户不匹配或图片内容与已检测图片不一致 |
| 413 | `PAYLOAD_TOO_LARGE` | 文件超过大小限制 |
| 413 | `AI_IMAGE_DIMENSIONS_TOO_LARGE` | 图片宽高或像素数超过限制 |
| 429 | `RATE_LIMITED` | AI 上传频率超过限制 |
| 503 | `AI_STORAGE_NOT_CONFIGURED` | 服务端 AI 文件存储未配置 |

## 5. 接口二：创建 AI 生成任务

### 5.1 请求

```http
POST /api/ai/generations
Authorization: Bearer <token>
Idempotency-Key: <稳定且唯一的请求键>
Content-Type: application/json
```

`Idempotency-Key` 必须满足：

- 长度 1～128 个字符。
- 只能使用可打印 ASCII 字符。
- 同一次业务操作重试时必须复用相同值。
- 换了一张图片或任一生成参数后必须使用新的值。

该接口只服务 `generationMode = ai`。标准模式不上传 `ai_input`、不创建 AI 任务、不检查或扣减 AI 额度。

请求体必须严格只包含以下四个字段，不允许添加 `prompt`、`provider`、`model`、`quota` 或其他字段：

```json
{
  "inputFileId": "file_01JXXXXXXXXXXXX",
  "style": "natural",
  "detailLevel": "medium",
  "backgroundMode": "simplify"
}
```

字段定义：

| 字段 | 类型 | 必填 | 可选值 | 说明 |
| --- | --- | --- | --- | --- |
| `inputFileId` | string | 是 | 已上传的文件 ID | 必须属于当前用户，且类型为 `ai_input` |
| `style` | string | 是 | `kawaii` / `natural` / `cartoon` / `minimal` | Q 版 / 自然写实 / 卡通 / 极简插画 |
| `detailLevel` | string | 是 | `low` / `medium` / `high` | 低 / 中 / 高细节 |
| `backgroundMode` | string | 是 | `keep` / `simplify` / `remove` | 保留 / 简化 / 移除背景 |

### 5.2 成功响应

HTTP 状态码：`201 Created`

新任务通常先返回 `queued`。如果使用了已经存在的幂等键，接口返回该幂等键对应的原任务状态。

```json
{
  "id": "aijob_01JXXXXXXXXXXXX",
  "status": "queued",
  "inputFileId": "file_01JXXXXXXXXXXXX",
  "outputFile": null,
  "style": "natural",
  "detailLevel": "medium",
  "backgroundMode": "simplify",
  "generationMode": "ai",
  "failure": null,
  "createdAt": "2026-09-12T08:00:00.000Z",
  "updatedAt": "2026-09-12T08:00:00.000Z",
  "completedAt": null
}
```

注意：HTTP `201` 只表示项目任务创建成功，不表示图片已经生成成功。必须继续查询任务。

### 5.3 创建阶段的失败响应

| HTTP | `error.code` | 原因 |
| ---: | --- | --- |
| 400 | `INVALID_ARGUMENT` | 请求体字段不完整、枚举值无效或包含额外字段 |
| 401 | `UNAUTHORIZED` | Token 缺失、无效或过期 |
| 402 | `USER_AI_QUOTA_EXHAUSTED` | 可用 AI 生成额度不足 |
| 404 | `NOT_FOUND` | `inputFileId` 不存在、不属于当前用户或已失效 |
| 409 | `IDEMPOTENCY_CONFLICT` | 相同幂等键对应了不同输入或不同生成参数 |
| 429 | `RATE_LIMITED` | AI 创建频率超过限制 |
| 503 | `AI_SERVICE_UNAVAILABLE` | AI 生成服务暂时不可用 |

## 6. 接口三：查询 AI 任务

### 6.1 请求

```http
GET /api/ai/generations/{id}
Authorization: Bearer <token>
```

`id` 是创建接口返回的项目任务 ID，例如 `aijob_01JXXXXXXXXXXXX`。

客户端应每隔约 2～3 秒查询一次；页面隐藏或卸载时停止轮询，重新进入后继续查询同一个任务 ID。

### 6.2 处理中响应

HTTP 状态码：`200 OK`

```json
{
  "id": "aijob_01JXXXXXXXXXXXX",
  "status": "processing",
  "inputFileId": "file_01JXXXXXXXXXXXX",
  "outputFile": null,
  "style": "natural",
  "detailLevel": "medium",
  "backgroundMode": "simplify",
  "generationMode": "ai",
  "failure": null,
  "createdAt": "2026-09-12T08:00:00.000Z",
  "updatedAt": "2026-09-12T08:00:03.000Z",
  "completedAt": null
}
```

### 6.3 成功响应

HTTP 状态码：`200 OK`

```json
{
  "id": "aijob_01JXXXXXXXXXXXX",
  "status": "succeeded",
  "inputFileId": "file_01JXXXXXXXXXXXX",
  "outputFile": {
    "id": "file_01JYYYYYYYYYYYY",
    "url": "/api/media/ai/ai_output_abcdef0123456789abcdef0123456789.png",
    "contentType": "image/png",
    "size": 512345
  },
  "style": "natural",
  "detailLevel": "medium",
  "backgroundMode": "simplify",
  "generationMode": "ai",
  "failure": null,
  "createdAt": "2026-09-12T08:00:00.000Z",
  "updatedAt": "2026-09-12T08:00:18.000Z",
  "completedAt": "2026-09-12T08:00:18.000Z"
}
```

客户端使用 `outputFile.url` 下载图片。混元返回的临时 URL 不会出现在项目响应中。

### 6.4 失败响应

任务处理失败仍返回 HTTP `200`，通过任务字段表示失败：

```json
{
  "id": "aijob_01JXXXXXXXXXXXX",
  "status": "failed",
  "inputFileId": "file_01JXXXXXXXXXXXX",
  "outputFile": null,
  "style": "natural",
  "detailLevel": "medium",
  "backgroundMode": "simplify",
  "generationMode": "ai",
  "failure": {
    "code": "AI_GENERATION_FAILED",
    "message": "AI 生成失败，请稍后重试",
    "category": "INTERNAL",
    "retryable": true,
    "action": "RETRY"
  },
  "createdAt": "2026-09-12T08:00:00.000Z",
  "updatedAt": "2026-09-12T08:00:20.000Z",
  "completedAt": "2026-09-12T08:00:20.000Z"
}
```

任务状态：

| `status` | 含义 | 客户端动作 |
| --- | --- | --- |
| `queued` | 任务已落库，尚未完成上游提交 | 继续查询 |
| `processing` | 正在调用或下载混元结果 | 继续查询 |
| `succeeded` | 图片已下载、校验、持久化并完成额度扣减 | 下载 `outputFile.url` |
| `failed` | 输入、Provider、输出校验、文件存储或额度完成阶段失败 | 展示错误并允许新建任务 |
| `canceled` | 预留状态，当前没有取消接口 | 按失败处理 |

失败任务只返回公开错误模型中的以下错误码：

`USER_AI_QUOTA_EXHAUSTED`、`INVALID_IMAGE`、`AI_INPUT_FILE_UNAVAILABLE`、`CONTENT_REJECTED`、`AI_SERVICE_UNAVAILABLE`、`AI_SERVICE_BUSY`、`AI_TIMEOUT`、`AI_RESULT_INVALID`、`AI_GENERATION_FAILED`。

Provider 原始错误（例如 `AllocationQuota.FreeTierOnly`）只保存在结构化后端日志中，不能出现在任务字段、API message 或小程序日志中。

### 6.5 查询接口的 HTTP 错误

| HTTP | `error.code` | 原因 |
| ---: | --- | --- |
| 401 | `UNAUTHORIZED` | Token 缺失、无效或过期 |
| 404 | `NOT_FOUND` | 任务不存在或不属于当前用户 |

Provider 调用或输出下载阶段的临时网络、429、502 或 503 不会立即将任务置为 `failed`，服务端保持 `processing`，小程序按轮询退避策略继续查询。只有 Provider 明确失败、任务过期或结果确认无效时才进入终态失败。服务端不会把混元原始错误直接返回给客户端。

## 7. 输出媒体接口

任务成功后使用返回的 `outputFile.url`：

```http
GET /api/media/ai/ai_output_<32位小写十六进制>.png
```

响应为 PNG 二进制，服务端返回 `Cache-Control: private, no-store`。客户端禁止拼接或替换成混元临时图片地址。

## 8. 服务端调用 CloudBase 混元

项目后端用 `@cloudbase/node-sdk` 调用 `generateImage` 云函数；模型调用和 CloudBase 访问凭据均保留在服务端：

```ts
await app.callFunction({
  name: "generateImage",
  data: { prompt, imageDataUrl, size: "1024x1024" },
});
```

云函数用 `cloud.ai().createImageModel("hunyuan-image")` 调用固定模型 `HY-Image-v3.0-I2I-ToB-v1.0.1`，并设置 `footnote: "AI生成"`。函数将生成图片保存到 CloudBase 存储并返回 `fileID`、文件类型、字节数和请求 ID。服务端通过 `downloadFile` 读取字节，按真实文件内容校验后持久化到项目 AI 文件存储；CloudBase 临时 `fileID` 不会返回给小程序。

项目自己的任务接口仍保留 `queued -> processing -> succeeded/failed` 状态，避免小程序等待长 HTTP 请求。输出图持久化且任务成功更新后，才扣一次额度。

部署过渡期间，数据库中既有的 TokenHub 和 CloudBase 任务都按各自 Provider 快照收尾；ToAPIs 凭据配置已移除，旧 ToAPIs 任务不会改路由到其他模型。

## 9. 额度与幂等规则

1. 创建任务前，服务端检查当前用户的 AI 额度和活动任务数量。
2. 相同 `Idempotency-Key`、相同参数重复请求，不创建新任务。
3. 相同 `Idempotency-Key` 但输入文件或参数不同，返回 `409 IDEMPOTENCY_CONFLICT`。
4. Provider 提交失败、查询失败、输出无效或文件存储失败，不扣 AI 生成额度。
5. 只有输出文件成功保存、任务成功更新后，才扣除一次 `ai_generation` 额度。
6. 任务和 AI 文件默认 24 小时后清理；过期任务不能继续使用。

## 10. 本地联调顺序

### 10.1 启动后端

```powershell
cd D:\AllProject\pindou-studio\server
npm run build
npm start
```

健康检查：

```text
GET http://127.0.0.1:4000/health
```

后端启动依赖 PostgreSQL、文件存储目录、内容安全配置和 CloudBase 混元配置。新任务生图配置项为：

```text
HUNYUAN_IMAGE_API_KEY=<仅服务端配置>
HUNYUAN_IMAGE_BASE_URL=https://<env-id>.api.tcloudbasegateway.com/v1/ai/cloudbase
HUNYUAN_IMAGE_MODEL=HY-Image-v3.0-I2I-ToB-v1.0.1
HUNYUAN_IMAGE_TIMEOUT_MS=150000
HUNYUAN_IMAGE_MAX_OUTPUT_BYTES=10485760
```

TokenHub 与 CloudBase Provider 均暂时保留，用于按任务快照完成切换前已创建的任务。ToAPIs 环境变量与配置解析已删除；历史 ToAPIs 任务不会调用其他 Provider。

### 10.2 小程序本地请求

将 `miniprogram/config/api.ts` 中 `develop` 环境临时指向：

```ts
develop: 'http://127.0.0.1:4000',
```

然后按以下顺序调用：

```text
微信登录 → 上传 ai_input → 创建任务 → 轮询任务 → 下载 outputFile.url
```

禁止跳过上传直接传本地文件路径，也禁止让小程序直接调用混元接口。

## 11. 代码对应位置

| 内容 | 文件 |
| --- | --- |
| 项目 HTTP 路由 | `server/src/http/app.ts` |
| 请求字段校验 | `server/src/http/request-validation.ts` |
| CloudBase 混元 Provider | `server/src/modules/ai/hunyuan-image-provider.ts` |
| AI 任务状态机 | `server/src/modules/ai/ai-generation-service.ts` |
| 固定 Prompt 模板 | `server/src/modules/ai/prompt-template.ts` |
| 小程序 AI 请求封装 | `miniprogram/services/ai-generation-service.ts` |
| 后端环境变量解析 | `server/src/config/env.ts` |

## 12. 文生图参考图

文生图走独立的持久化任务表，复用服务端登录态、微信文本安全检查、CloudBase 混元、AI 输出文件校验和 AI 额度账本。固定模型为 `HY-Image-3.0-Plus-4090-Tob-v1.0`；小程序不直接调用 CloudBase。

### 12.1 创建任务

```http
POST /api/ai/text-generations
Authorization: Bearer <token>
Idempotency-Key: <1-128 个可见 ASCII 字符>
Content-Type: application/json

{"prompt":"一只坐在草地上的橘猫，旁边有小花"}
```

`prompt` 必须为 1–500 个 Unicode 字符。服务端会先检查内容安全，再按当前用户和幂等键创建任务；模型、Provider、额度和系统参数不接受客户端覆盖。响应包含 `id`、`prompt`、`status`、`outputFile`、`errorCode` 和时间戳。

### 12.2 查询与恢复

```http
GET /api/ai/text-generations/{id}
GET /api/ai/text-generations?active=true
POST /api/ai/text-generations/{id}/consume
DELETE /api/ai/text-generations/{id}
```

查询、恢复、消费和删除均要求 Bearer Token 并校验任务归属。恢复列表包含未消费、未过期的排队中、处理中、成功和失败任务。仅失败任务可删除；删除会清理任务和临时输出文件，不修改额度流水。失败任务也可使用新的幂等键提交相同描述重试。

### 12.3 状态、额度与作品保存

```text
queued → processing → succeeded / failed
```

生成参考图并通过服务端格式、大小、尺寸校验后才扣 1 次 `ai_generation` 额度；失败不扣。成功后客户端调用下列接口，服务端将原图复制到长期封面文件存储并标记任务已消费。作品保存失败时不标记任务已消费，客户端可重试；每个任务至多创建一条作品。未保存任务及中间输出默认保留 24 小时。

```http
POST /api/works/text-images
Authorization: Bearer <token>
Content-Type: application/json

{"sourceJobId":"txtjob_..."}

GET /api/works/text-images?page=1&pageSize=20
GET /api/works/text-images/{workId}
DELETE /api/works/text-images/{workId}
```

文生图作品只保存原图和描述，不含拼豆网格；作品列表「文生图」筛选仅返回这些记录，「全部」也包含这些记录。删除作品会软删除记录并清理持久图片。小程序从文生图作品详情生成拼豆草稿后，拼豆图仍走既有标准引擎与普通作品保存流程，不再消费或重建文生图作品。

### 12.4 尺寸配置与 AI 灵感

```http
GET /api/ai/text-generation-options   # 返回 { sizes, defaultSize, cost }
GET /api/ai/text-inspirations         # 返回 { items: [{ title, prompt } x3] }
```

`text-generation-options` 只返回服务端白名单尺寸与单次扣费次数，客户端不自建尺寸白名单。`text-inspirations` 复用登录态、`aiRateLimiter`（默认 5 次 / 10 分钟，key `{userId}:text-inspiration`）和文本内容安全检查，**不扣用户 AI 额度**。

灵感由 `generateImage` 云函数走 CloudBase `cloudbase/hy3` 文本模型生成（服务端持有密钥，客户端不接触）。这是全链路唯一「不扣用户额度、却真实消耗 token」的调用，成本口径：

- 单次调用：输入约 90–120 token（固定提示词 + 3 条输出的格式约束），输出约 240–360 token（3 组 title + 30–100 字 prompt 的 JSON），合计约 330–480 token。
- 按 Hy3 定价（输入 1 元 / 百万 token、输出 4 元 / 百万 token），单次约 ¥0.001–0.0015；1 万次约 ¥10–15。
- 真正的成本风险来自**调用频次**而非单价，因此小程序侧按用户缓存灵感结果 6 小时并只在点「换一换」时强制刷新，`/api/ai/text-inspirations` 的连点由 3 秒冷却 + 服务端限流兜底。
- 云函数每次调用输出一条 `[generateImage] inspirations usage` 日志（`inputTokens` / `outputTokens` / `totalTokens`），可直接在云开发日志里按次核对真实用量；字段缺失时记 `null` 而不是 0。

### 12.5 数据库迁移

部署前按顺序确认 `server/sql/019_text_image_generation.sql`、`server/sql/022_text_image_size.sql` 和 `server/sql/023_text_image_works.sql` 已执行。`023` 新增 `pindou_text_image_works`，独立保存长期文生图原图。任务提示词不进入日志；未保存的过期任务清理时连同中间输出一起删除。
