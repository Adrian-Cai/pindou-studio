# 一起拼豆吧 · Ai 模式接入设计

> 状态：预研设计，不代表当前已上线能力
>
> 当前标准模式继续使用本地 Standard Pattern EngineAi 模式作为独立上游图像处理能力接入，不替换现有 Pattern Schema

## 1. 目标

Ai 模式解决的问题不是“让模型直接输出最终拼豆格子”，而是：

```text
用户原图
→ AI 生成更适合拼豆化的中间图
→ Standard Pattern Engine
→ PatternDraft
→ 编辑器
→ 成品图 / 材料清单 / 施工图 / 色板
```

这样可以保持最终网格、颜色、材料统计和施工图的确定性，也便于未来替换 AI 模型

## 2. 模型选择

### 首版建议：Qwen Image 3.0 / 3.0 Pro

适合原因：

- 支持图像生成与图像编辑，可基于用户上传图做 image-to-image
- 支持参考图片和指令控制，适合“保留主体、减少细节、加强轮廓、控制背景”等拼豆前处理
- 国内云服务区域接入更适合微信小程序生产环境
- 后端可以直接调用，不需要让小程序直连模型厂商

首版建议默认使用标准档模型，质量不够时再切 Pro，不建议一开始把高成本模型作为唯一模型

### Benchmark / 备用：OpenAI GPT-Image-2

用途：

- 作为图像质量和指令遵循 benchmark
- 用于内部 A/B 测试不同 provider 的拼豆转换效果
- 如果未来具备稳定网络、成本和合规条件，可作为备用 Provider

### 首版实现原则

首版只有 Qwen 一个生产实现时，直接使用一个小的 `qwen-image-provider.ts` 模块即可，不提前定义单实现接口、Factory、Plugin Registry 或多层 Adapter

只有第二个生产 Provider 真正接入时，再抽取统一 Provider 接口

## 3. AI Prompt 目标

AI 的输出应该针对后续 Pattern Engine，而不是追求摄影级细节

建议固定系统模板控制：

- 保留主体身份、姿态和主要构图
- 简化细碎纹理
- 减少背景噪声
- 强化主体与背景色块差异
- 保持明显轮廓
- 控制颜色数量和渐变复杂度
- 避免生成文字、水印和额外物体
- 输出方形或与目标拼豆网格匹配的构图

用户首版不需要看到自由 Prompt 输入框产品只暴露少量可控参数，例如：

- 风格：自然 / 卡通 / 极简
- 细节：低 / 中 / 高
- 背景：保留 / 简化 / 去除

服务端根据这些参数组装版本化 Prompt

## 4. 推荐架构

```mermaid
flowchart LR
    U[用户上传原图]
    MP[微信小程序]
    API[Node API]
    JOB[AI Generation Service]
    PROVIDER[Qwen Image Provider]
    FS[文件存储]
    PG[(PostgreSQL)]
    ENGINE[Standard Pattern Engine V2]
    EDITOR[现有编辑器]

    U --> MP
    MP -->|上传 AI 输入图| API
    API --> FS
    API -->|创建任务| JOB
    JOB --> PG
    JOB --> PROVIDER
    PROVIDER -->|生成结果| JOB
    JOB --> FS
    JOB --> PG
    MP -->|查询任务| API
    API --> PG
    API -->|返回 AI 中间图| MP
    MP --> ENGINE
    ENGINE --> EDITOR
```

## 5. 同步还是异步

首版建议从 API 语义上按“任务”设计，即使所选模型当前可以同步返回

原因：

- 图片生成延迟明显高于普通 API
- 模型供应商可能超时、排队或限流
- 后续切换异步模型时无需修改客户端业务协议
- 用户退出页面后仍可以恢复任务状态

小程序不应保持一个很长的 HTTP 请求等待生成完成

## 6. 数据库改动

### 6.1 现有表需要调整

#### `pindou_file_assets`

当前 `file_type` 主要面向 `cover`AI 模式需要至少增加：

- `ai_input`：用户上传、提供给模型的输入图片
- `ai_output`：模型生成的中间图片

AI 输入图建议设置有限保留期，不建议永久保存所有原图

### 6.2 新增 `pindou_ai_generation_jobs`

首版只增加一张任务表，不拆 request/result/provider 多张表

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(32) PK | `aij_` 前缀 |
| `user_id` | varchar(32) FK | 用户 |
| `input_file_id` | varchar(32) FK | AI 输入文件 |
| `output_file_id` | varchar(32) FK NULL | AI 生成结果 |
| `provider` | varchar(30) | 例如 `qwen` |
| `model` | varchar(80) | 实际模型 ID |
| `status` | varchar(20) | queued / processing / succeeded / failed / canceled |
| `prompt_version` | varchar(30) | Prompt 模板版本 |
| `style` | varchar(30) | 产品风格参数 |
| `detail_level` | varchar(20) | 细节级别 |
| `background_mode` | varchar(20) | 背景策略 |
| `provider_request_id` | varchar(128) NULL | 厂商请求 ID |
| `error_code` | varchar(60) NULL | 失败分类，不直接保存敏感厂商原始报错 |
| `created_at` | timestamptz | 创建时间 |
| `started_at` | timestamptz NULL | 开始处理 |
| `completed_at` | timestamptz NULL | 完成时间 |
| `expires_at` | timestamptz NULL | 输入/输出文件清理时间 |

暂时不新增单独的 `ai_generation_results` 表，因为首版一个任务只需要一个最终候选图如果未来确定支持“一次生成 4 张让用户选择”，再新增结果表

### 6.3 AI 次数 / 付费额度

不要直接把 AI 次数与现有“下载次数”混成同一个余额

推荐先把额度模型升级成显式资源类型，例如给 `pindou_quota_transactions` 增加：

```text
quota_kind = download | ai_generation
```

然后同一流水模型继续支持：

- 每日免费 AI 次数
- 购买 AI 次数
- AI 生成成功扣减
- 失败不扣减 / 自动返还

如果短期尚未收费，也可以先不改额度表，只给 AI 任务建立免费限流；正式上线每日免费 3–5 次和付费能力前，再落地 `quota_kind`

## 7. API 增量设计

### 7.1 上传 AI 输入图

推荐继续复用文件上传入口：

```http
POST /api/files/upload
Content-Type: multipart/form-data
Authorization: Bearer ...

type=ai_input
file=<image>
```

不新增一个重复的 `/api/ai/upload`

### 7.2 创建生成任务

```http
POST /api/ai/generations
Authorization: Bearer ...
Idempotency-Key: ...
Content-Type: application/json
```

请求：

```json
{
  "inputFileId": "file_xxx",
  "style": "natural",
  "detailLevel": "medium",
  "backgroundMode": "simplify"
}
```

返回：

```json
{
  "id": "aij_xxx",
  "status": "queued"
}
```

客户端不能提交 provider、model、system prompt 或任意厂商参数；这些全部由服务端配置

### 7.3 查询任务

```http
GET /api/ai/generations/{id}
```

处理中：

```json
{
  "id": "aij_xxx",
  "status": "processing"
}
```

成功：

```json
{
  "id": "aij_xxx",
  "status": "succeeded",
  "output": {
    "fileId": "file_xxx",
    "url": "https://..."
  }
}
```

失败：

```json
{
  "id": "aij_xxx",
  "status": "failed",
  "error": {
    "code": "AI_GENERATION_FAILED"
  }
}
```

### 7.4 可选：取消任务

只有实际 Provider 支持取消且产品确实需要时再增加：

```http
POST /api/ai/generations/{id}/cancel
```

不要为了完整 REST 形式提前实现无效取消

## 8. 前端改动

首页已有 `standard | ai` 生成模式，可以继续复用现有状态

AI 模式流程建议：

```text
选择 Ai 模式
→ 选图
→ 上传 ai_input
→ POST /api/ai/generations
→ 展示 AI 处理中页面 / 状态
→ GET generation 状态
→ 成功后下载/读取 AI output
→ 交给现有 Standard Pattern Engine
→ 进入编辑器
```

这样编辑器、结果页、作品保存、Pattern Schema、材料清单和下载链路都不需要因为 AI 模式复制一套

## 9. 服务端模块建议

新增：

```text
server/src/modules/ai/
  ai-generation-service.ts
  qwen-image-provider.ts
```

首版不要新增：

- Provider interface
- BaseAiProvider
- ProviderFactory
- ProviderRegistry
- QueueFactory
- StrategyFactory
- 多层 repository abstraction

真正出现第二个 Provider 或独立 Worker 后再演进

## 10. 可靠性与成本

必须记录：

- Provider
- Model
- Prompt version
- 请求开始/完成时间
- 成功/失败状态
- Provider request ID

建议统计但不一定第一版入库：

- 单次生成成本
- 平均生成时长
- 成功率
- 用户从 AI 图进入编辑器的转化率
- AI 图最终保存为作品的比例

关键原则：

- AI API Key 只能放后端
- AI 输入图必须校验真实文件类型、大小和尺寸
- Provider 超时不能生成“假成功”
- 只有真正得到可用 AI 输出后才扣 AI 额度
- 重试必须结合 Idempotency-Key，避免用户被重复扣次

## 11. 实施阶段

### Phase A：技术验证

- 用 30–50 张典型图片测试 Qwen Image
- 固定 2–3 个 Prompt 模板
- 对比 Standard 原图直转与 AI 中间图再转的最终拼豆质量
- 记录生成时间和单图成本

### Phase B：后端 MVP

- 扩展 `file_type`
- 新增 `pindou_ai_generation_jobs`
- 新增 AI Provider 与 Service
- 新增创建 / 查询任务 API
- 不接支付

### Phase C：小程序接入

- 打通 AI 模式真实流程
- AI 输出继续复用 Standard Pattern Engine 和现有编辑器
- 加失败、重试、超时 UI

### Phase D：商业化

- 增加 `quota_kind=ai_generation`
- 每日免费 3–5 次
- 购买次数
- 成功扣减、失败不扣
- 增加运营和成本监控

## 12. 不需要因为 AI 改动的现有核心结构

以下结构原则上保持不变：

- `PatternDraft`
- `PersistedPattern`
- `pindou_works`
- `pindou_work_patterns`
- 编辑器工具系统
- 成品图 / 材料 / 施工图 / 色板逻辑
- 标准模式

AI 只是标准生成链路前增加一个可选的“图像预处理阶段”
