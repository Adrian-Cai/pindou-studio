# AI 图片生成接口文档

## 1. 文档范围

本文档描述当前代码实际实现的 AI 图片生成链路，供小程序、后端和本地联调使用。

链路包含三类接口：

1. 项目文件接口：上传 AI 输入图片。
2. 项目 AI 接口：创建生成任务、查询任务状态。
3. 服务端上游接口：后端调用阿里云百炼通义千问图像异步接口。

小程序只允许调用项目自己的接口，不能直接调用千问接口，也不能接触 `QWEN_IMAGE_API_KEY`。

当前实现对应：

- Provider：`qwen`
- 模型：`qwen-image-3.0`，也支持服务端配置为 `qwen-image-3.0-pro`
- Prompt 模板版本：`v2`
- 输入/输出文件默认保留：24 小时
- 默认本地服务地址：`http://127.0.0.1:4000`

## 2. 总体参数流转

```text
小程序选择图片
    │
    ├─ POST /api/files/upload
    │    multipart: file + type=ai_input
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
              ├─ 转成 data:image/...;base64,...
              ├─ 根据三个业务参数生成固定 Prompt
              ├─ POST 千问图像异步接口
              ├─ 保存千问 task_id 为 provider_request_id
              │
              └─ GET /api/ai/generations/{id}
                   ├─ 查询千问任务状态
                   ├─ 成功后下载千问临时 PNG 地址
                   ├─ 校验、内容安全审核并保存为 ai_output
                   ├─ 成功完成额度扣减
                   └─ 返回项目自己的 outputFile.url
```

参数对应关系：

| 来源参数 | 服务端处理 | 下游参数/结果 |
| --- | --- | --- |
| 上传文件二进制 | 校验真实图片格式、大小、尺寸并保存 | `pindou_file_assets.id`，即 `inputFileId` |
| `inputFileId` | 查询当前用户的 `ai_input` 文件并读取字节 | 千问 `input.messages[0].content[0].image` |
| `style` | 选择风格 Prompt 片段 | 固定 Prompt |
| `detailLevel` | 选择细节 Prompt 片段 | 固定 Prompt |
| `backgroundMode` | 选择背景 Prompt 片段 | 固定 Prompt |
| 服务端 `QWEN_IMAGE_MODEL` | 客户端不可覆盖 | 千问 `model` |
| 服务端固定 Prompt | 客户端不可传入 | 千问 `input.messages[0].content[1].text` |
| 千问 `output.task_id` | 保存到任务记录 | 后续查询千问任务 |
| 千问临时图片 URL | 服务端下载，不向客户端透传 | 项目 `ai_output` 文件 |
| 项目 `outputFile.url` | 客户端下载并进入本地拼豆算法 | 最终 AI 中间图 |

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

`requestId` 用于服务端日志定位。服务端不会向客户端返回千问原始错误、API Key 或内部堆栈。

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

表单字段必须只有以下两个：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file` | 文件 | 是 | JPG、PNG 或 WEBP 图片 |
| `type` | 字符串 | 是 | 固定值 `ai_input` |

示例：

```bash
curl -X POST "http://127.0.0.1:4000/api/files/upload" \
  -H "Authorization: Bearer <token>" \
  -F "file=@./input.png;type=image/png" \
  -F "type=ai_input"
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

后续创建任务只使用 `file.id`，即上例中的 `inputFileId`。客户端不需要把 `url` 转成千问地址。

### 4.3 常见失败

| HTTP | `error.code` | 原因 |
| ---: | --- | --- |
| 400 | `INVALID_ARGUMENT` | 表单字段不完整、`type` 不是 `ai_input` 或图片格式无效 |
| 400 | `CONTENT_RISKY` | 输入图片未通过内容安全检查 |
| 401 | `UNAUTHORIZED` | Token 缺失、无效或过期 |
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
| `style` | string | 是 | `natural` / `cartoon` / `minimal` | 自然写实 / 卡通 / 极简插画 |
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
  "provider": "qwen",
  "model": "qwen-image-3.0",
  "promptVersion": "v2",
  "style": "natural",
  "detailLevel": "medium",
  "backgroundMode": "simplify",
  "errorCode": null,
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
| 402 | `QUOTA_INSUFFICIENT` | 可用 AI 生成额度不足 |
| 404 | `NOT_FOUND` | `inputFileId` 不存在、不属于当前用户或已失效 |
| 409 | `IDEMPOTENCY_CONFLICT` | 相同幂等键对应了不同输入或不同生成参数 |
| 429 | `RATE_LIMITED` | AI 创建频率超过限制 |
| 503 | `AI_PROVIDER_NOT_CONFIGURED` | 千问 Key 或 Base URL 未配置 |

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
  "provider": "qwen",
  "model": "qwen-image-3.0",
  "promptVersion": "v2",
  "style": "natural",
  "detailLevel": "medium",
  "backgroundMode": "simplify",
  "errorCode": null,
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
  "provider": "qwen",
  "model": "qwen-image-3.0",
  "promptVersion": "v2",
  "style": "natural",
  "detailLevel": "medium",
  "backgroundMode": "simplify",
  "errorCode": null,
  "createdAt": "2026-09-12T08:00:00.000Z",
  "updatedAt": "2026-09-12T08:00:18.000Z",
  "completedAt": "2026-09-12T08:00:18.000Z"
}
```

客户端使用 `outputFile.url` 下载图片。千问返回的临时 URL 不会出现在项目响应中。

### 6.4 失败响应

任务处理失败仍返回 HTTP `200`，通过任务字段表示失败：

```json
{
  "id": "aijob_01JXXXXXXXXXXXX",
  "status": "failed",
  "inputFileId": "file_01JXXXXXXXXXXXX",
  "outputFile": null,
  "provider": "qwen",
  "model": "qwen-image-3.0",
  "promptVersion": "v2",
  "style": "natural",
  "detailLevel": "medium",
  "backgroundMode": "simplify",
  "errorCode": "AI_PROVIDER_TASK_FAILED",
  "createdAt": "2026-09-12T08:00:00.000Z",
  "updatedAt": "2026-09-12T08:00:20.000Z",
  "completedAt": "2026-09-12T08:00:20.000Z"
}
```

任务状态：

| `status` | 含义 | 客户端动作 |
| --- | --- | --- |
| `queued` | 任务已落库，尚未完成上游提交 | 继续查询 |
| `processing` | 正在提交或查询千问 | 继续查询 |
| `succeeded` | 图片已下载、校验、持久化并完成额度扣减 | 下载 `outputFile.url` |
| `failed` | 输入、Provider、输出、安全审核或额度完成阶段失败 | 展示错误并允许新建任务 |
| `canceled` | 预留状态，当前没有取消接口 | 按失败处理 |

失败任务的 `errorCode` 可能包括：

`AI_INPUT_FILE_UNAVAILABLE`、`AI_SUBMISSION_TIMEOUT`、`AI_TASK_EXPIRED`、`AI_PROVIDER_TASK_FAILED`、`AI_PROVIDER_ERROR`、`AI_PROVIDER_TIMEOUT`、`AI_PROVIDER_UNAVAILABLE`、`AI_PROVIDER_OUTPUT_INVALID`、`AI_PROVIDER_OUTPUT_TOO_LARGE`、`AI_OUTPUT_CONTENT_RISKY`、`AI_QUOTA_UNAVAILABLE_AT_COMPLETION`。

### 6.5 查询接口的 HTTP 错误

| HTTP | `error.code` | 原因 |
| ---: | --- | --- |
| 401 | `UNAUTHORIZED` | Token 缺失、无效或过期 |
| 404 | `NOT_FOUND` | 任务不存在或不属于当前用户 |

Provider 查询、输出下载或后处理失败，会被记录到任务的 `errorCode`，而不是把千问原始错误直接返回给客户端。

## 7. 输出媒体接口

任务成功后使用返回的 `outputFile.url`：

```http
GET /api/media/ai/ai_output_<32位小写十六进制>.png
```

响应为 PNG 二进制，服务端返回 `Cache-Control: private, no-store`。客户端禁止拼接或替换成千问临时图片地址。

## 8. 服务端调用千问接口

以下接口只允许由服务端调用，不能放到小程序代码中。

### 8.1 创建千问异步任务

当前本地环境的 Base URL 为 `QWEN_IMAGE_BASE_URL`，实际路径为：

```http
POST {QWEN_IMAGE_BASE_URL}/api/v1/services/aigc/image-generation/generation
Authorization: Bearer {QWEN_IMAGE_API_KEY}
X-DashScope-Async: enable
Content-Type: application/json
```

当前 `.env` 配置下的完整地址是：

```text
https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation
```

服务端发送的请求结构为：

```json
{
  "model": "qwen-image-3.0",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "image": "data:image/png;base64,<输入图片Base64>"
          },
          {
            "text": "<服务端根据业务参数生成的固定Prompt>"
          }
        ]
      }
    ]
  },
  "parameters": {
    "prompt_extend": true,
    "prompt_extend_mode": "direct",
    "enable_thinking": true,
    "n": 1,
    "watermark": false
  }
}
```

上游成功创建时，服务端读取：

```json
{
  "output": {
    "task_id": "<千问任务ID>"
  }
}
```

### 8.2 查询千问任务

```http
GET {QWEN_IMAGE_BASE_URL}/api/v1/tasks/{千问任务ID}
Authorization: Bearer {QWEN_IMAGE_API_KEY}
```

服务端读取 `output.task_status`：

| 千问状态 | 项目状态 |
| --- | --- |
| `PENDING`、`RUNNING` | `processing` |
| `SUCCEEDED` | 继续下载并持久化输出 |
| `FAILED`、`CANCELED`、`UNKNOWN` | `failed` |

千问成功结果中的图片地址位于：

```json
{
  "output": {
    "task_status": "SUCCEEDED",
    "choices": [
      {
        "message": {
          "content": [
            {
              "image": "https://<aliyuncs域名>/<临时图片路径>"
            }
          ]
        }
      }
    ]
  }
}
```

该临时地址只在服务端内部使用。服务端要求其为 HTTPS 的受信任 `*.aliyuncs.com` 地址，下载后校验为 PNG，再写入项目自己的 AI 文件存储。

## 9. 额度与幂等规则

1. 创建任务前，服务端检查当前用户的 AI 额度和活动任务数量。
2. 相同 `Idempotency-Key`、相同参数重复请求，不创建新任务。
3. 相同 `Idempotency-Key` 但输入文件或参数不同，返回 `409 IDEMPOTENCY_CONFLICT`。
4. Provider 提交失败、查询失败、输出无效或内容安全不通过，不扣 AI 生成额度。
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

后端启动依赖 PostgreSQL、文件存储目录、内容安全配置和千问环境变量。千问配置项为：

```text
QWEN_IMAGE_API_KEY=<仅服务端配置>
QWEN_IMAGE_BASE_URL=https://dashscope.aliyuncs.com
QWEN_IMAGE_MODEL=qwen-image-3.0
QWEN_IMAGE_TIMEOUT_MS=30000
QWEN_IMAGE_MAX_OUTPUT_BYTES=10485760
```

### 10.2 小程序本地请求

将 `miniprogram/config/api.ts` 中 `develop` 环境临时指向：

```ts
develop: 'http://127.0.0.1:4000',
```

然后按以下顺序调用：

```text
微信登录 → 上传 ai_input → 创建任务 → 轮询任务 → 下载 outputFile.url
```

禁止跳过上传直接传本地文件路径，也禁止让小程序直接调用千问接口。

## 11. 代码对应位置

| 内容 | 文件 |
| --- | --- |
| 项目 HTTP 路由 | `server/src/http/app.ts` |
| 请求字段校验 | `server/src/http/request-validation.ts` |
| 千问 Provider | `server/src/modules/ai/qwen-image-provider.ts` |
| AI 任务状态机 | `server/src/modules/ai/ai-generation-service.ts` |
| 固定 Prompt 模板 | `server/src/modules/ai/prompt-template.ts` |
| 小程序 AI 请求封装 | `miniprogram/services/ai-generation-service.ts` |
| 后端环境变量解析 | `server/src/config/env.ts` |
