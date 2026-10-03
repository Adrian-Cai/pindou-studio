# 小程序 0.30.14 提审说明

> 状态：代码已落地，`tsc --noEmit` 0 报错，拼豆图生成用例 57/57、作品同步用例 19/19 通过。
> 本次为**纯小程序端改动**，无需重新部署云函数或服务端。
> 上一轮的部署提醒仍然有效：0.30.11 的 `generateImage` 云函数需在微信云开发重新部署，否则生图角标文案不生效。
> **0.30.10 的真机验收 T1–T20 仍未执行**（历史遗留），正式提审前必须补跑。

## 版本号

`0.30.14`

## 本次提交

本批次为第二轮 AI 扫描（`open-code-review`）发现处的后续修复，聚焦「同一件事存在两套口径」造成的隐性错误。

涉及文件（6 个）：

| 文件 | 改动性质 |
| --- | --- |
| `miniprogram/services/ai-generation-service.ts` | 失败码归一化收口 |
| `miniprogram/services/ai-generation-manager.ts` | 重试动作跟进同一套口径 |
| `miniprogram/services/payment-service.ts` | 幂等键随机源、支付失败归一、套餐解析放宽 |
| `miniprogram/packages/result/services/result-download-service.ts` | 下载记录 id 去重 |
| `miniprogram/tests/pattern-generation/wechat-canvas-baseline.ts` | 基线逐用例容错 |
| `docs/development/OCR_SCAN_FIX_LOG_2026-09-23.md` | 处置记录 |

上一版本基线：v0.30.13（首轮扫描修复批次，269 条发现 / 118 个文件送审）。

## 版本概述

这一版的主题是**消除同一件事的两套判定口径**。AI 扫描第一轮修的多是「明显会崩」的问题，第二轮暴露的是一类更隐蔽的情况：同一个概念在代码里有两个取值空间，走不同入口会得到不同结果，而且都不报错。

最典型的是 AI 失败码。服务端会返回别名，`aiGenerationErrorMessage` 把这些别名跟归一化后的码并列写成多个 case，于是同一个错误会因为走了「failure 对象」还是「裸 ApiError」两条路径，落到不同分支上——用户看到两句互相矛盾的提示。这类问题不会崩溃、不打日志，只会让用户困惑。

支付侧同批修了三处，其中幂等键的随机源是真实的资金风险（详见下条 4）。

## 本次修改说明

1. **失败码归一化收口**：服务端可能返回 `QUOTA_INSUFFICIENT`、`AI_PROVIDER_TIMEOUT`、`PAYLOAD_TOO_LARGE` 这类别名。原先 `aiGenerationErrorMessage` 把别名与归一化后的码**并列**写成多个 case，导致同一错误两条入口两个结果。现在入口统一先过 `normalizeFailureCode`，映射表只写归一化后的码；`aiGenerationFailure` 也把服务端给的码一并归一化，`failure.code` 因此只有一个取值空间。有意保留了三个码的独立文案（`UNSUPPORTED_IMAGE` / `IMAGE_DECODE_ERROR` / `AI_TASK_EXPIRED`）——它们对用户各有不同含义，合并进通用类目会把「格式不支持」和「文件读不出来」说成同一句话，已在代码注释写明。

2. **重试动作跟进同一套口径**：`retryActionFor` 原先还认旧别名，且漏了 `IMAGE_TOO_LARGE` / `RATE_LIMITED` / `AI_TASK_EXPIRED`，这些失败会静默落到默认操作上。已补齐，并在注释里写明入参必须是已归一化的码，避免以后重复归一化。

3. **`AiGenerationFailure` 契约被违反**：`category` / `action` 齐全但 `retryable` 缺失（`undefined`）时，函数会产出违反该接口类型契约的对象。补上真正的布尔判定。

4. **支付幂等键改用 CSPRNG（真实资金风险）**：原先随机分量用 `Math.random()`，而这是防重复扣款的去重凭据——同一毫秒内连点两次撞键，后果是用户付两次钱。`Math.random()` 不保证不可预测，拿它挡重复扣款不合格。改用 `wx.getRandomValues`（小程序环境没有 Web 的 `crypto` 全局），取不到时降级为弱随机并打 warning，避免发布端配置异常直接崩在支付入口。

5. **微信支付失败对象归一成 ApiError**：`wx.requestPayment` 的 fail 回调给的是 `{ errMsg, errCode }` 裸对象，既不是 Error 也不是 ApiError；原先直接 reject，`paymentErrorMessage`（只看 Error 实例）永远走兜底文案——**用户明明自己取消了支付，却看到「请稍后重试」**。改为统一收成带 code 的 ApiError。顺带把取消判定从子串匹配 `errMsg` 改为优先看结构化的 `errCode === -2`，因为 errMsg 会随基础库版本与系统语言变化，拿文案当判据不可靠。

6. **套餐解析不再卡死服务端内部字段**：`parsePackage` 原先连 `quotaKind === 'ai_generation'`、`membershipType === null`、`currency === 'CNY'`、`enabled === true` 一并校验并写死期望值。服务端一旦新增套餐种类（比如会员套餐），`parsePackages` 整份 map 抛错，**用户界面上一个套餐都不剩**，而报错是「无法识别的套餐数据」这种看不出所以然的文案。改为只校验真正要渲染的字段（id / label / quotaAmount / priceFen）——其余属服务端内部约定，不该成为客户端能否渲染的前提。

7. **下载记录 id 补随机分量**：原先格式为 `download_<id>_<type>_<时间戳>`，同毫秒内连点两次「保存」算出同一个 id，第二次被 `addDownloadRecord` 视为同一条记录覆盖掉——用户点了两次却只记一次，本地下载记录与实际行为对不上。

8. **WeChat Canvas 基线逐用例容错**：原先任一素材读不到就整轮抛错、什么都不产出。改为收集 `failures` 数组让其余用例继续跑——缺一张图的排查成本远高于少一条记录。同时抽出 `TEST_ASSETS_DIR` 常量，换环境只改一处。

## 影响范围

- 小程序主包：`services/ai-generation-service.ts`、`services/ai-generation-manager.ts`、`services/payment-service.ts`
- 小程序分包：`packages/result/services/result-download-service.ts`
- 测试：`tests/pattern-generation/wechat-canvas-baseline.ts`
- 文档：`docs/releases/CHANGELOG.md`、`docs/releases/MINI_PROGRAM_RELEASE_0.30.14.md`、`docs/development/OCR_SCAN_FIX_LOG_2026-09-23.md`
- 版本号：`package.json`、`package-lock.json` 均为 `0.30.14`

**不影响范围：**

- 云函数与服务端接口（本次**无需后端与云函数改动**）
- AI 生成主链路的任务状态机与调度策略
- 图纸生成算法（Golden Masters 基线未改动，57/57 结果一致）

## 验收重点

本批次改动集中在**错误文案与失败判定**，静态检查与单元测试覆盖不到实际观感，建议按以下路径走一遍真机：

| 场景 | 预期 |
| --- | --- |
| AI 生成失败（各错误码） | 同一错误不论从哪条入口进入，文案一致且符合该错误的实际含义 |
| 支付中途主动取消 | 提示「已取消支付」，**不应**出现「请稍后重试」 |
| 同一套餐快速连点两次购买 | 不应产生两笔订单（幂等去重生效） |
| 连续两次点「保存」下载 | 本地下载记录应有两条，而非被覆盖成一条 |
| AI 套餐列表 | 正常展示全部套餐（服务端后续新增种类时不应整份消失） |

回归测试：`npm run test:pattern`（57/57）、`test/work-sync/`（19/19）、`npm run typecheck`（0 报错）。
