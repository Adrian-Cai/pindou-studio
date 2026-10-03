# 小程序 0.30.22 提审说明

> 状态：代码已落地。`test:ai-failure` 21/21、`test/payment` 15/15、
> 服务端全量 214 例（209 通过 / 5 跳过 / 0 失败），根 `tsc --noEmit` 0 报错。
> 变异验证：去掉查单的 `access_token` 后对应用例转红；把商户单号改回订单号后 3 例转红；
> 把 AI 提交重试次数改回 1 后「限流退避后出图」转红。
> 本版**小程序端与服务端都改了**：小程序必须重新上传提审、服务端必须重新部署，
> 缺任何一半，付款不到账与「一撞限流就失败」的问题就不会消失。

## 版本号

`0.30.22`

## 本次提交

| 提交 | 内容 |
| --- | --- |
| `6b8a7e8` | fix(payment): 修复虚拟支付查单缺 `access_token` 导致付款不到账（服务端） |
| `17f48c7` | refactor(miniprogram): AI 生成全过程收敛到单页面原地切换（小程序端） |
| `d84586e` | fix(payment): 商户单号与订单号解耦，修复重复拉起支付必失败（-15012） |
| `ecb5911` | fix(ai): 混元限流改为退避重试，并修复「重新生成」按钮无效 |
| `d296f10` | fix(miniprogram): 图片目录已存在时不再打创建失败告警 |
| 本次版本提交 | 提审说明、CHANGELOG 条目 |

上一版本基线：v0.30.21（AI 失败原因可见与入队导航）。

## 版本概述

三条线，一条是**生产故障**，一条是**生成体验**，还有一条是**AI 生成的可用性**。

**故障这条线**：0.1 元新人套餐付款成功后，5 次 AI 生成次数迟迟不到账。链路上的现象很反直觉——
发货推送**收到了**（日志有 `xpay_goods_deliver_notify`），补单轮询**也在跑**（每轮扫到 8~9 笔 pending），
但每一笔都停在 `虚拟支付订单查询失败（41001）`。41001 是「缺少 access_token」：
`xpay/query_order` 要求 `access_token` 与 `pay_sig` 都放在 **query string** 上、请求体只有
`openid`/`env`/`order_id`，而我们此前把 `pay_sig` 塞进了请求体、压根没带 token。
两条发货支路（推送 + 轮询）最后都要过这个验真调用，于是**一起卡死**，用户付完钱永远拿不到权益。

顺带还有第二处：响应解析在顶层找 `pay_state` / `actual_price`，而官方把订单信息放在 `order` 对象里、
状态是数字枚举（2 已支付待发货 / 3 发货中 / 4 已发货 / 7 退款失败）。**只补 token 不改这两处照样不到账**。

**体验这条线**：AI 生成的四种状态（排队 / 生成中 / 失败 / 完成）此前分散在不同呈现里，
失败还要额外跳一次。现在整个生成过程只用一个页面：页面框架不动，只按状态原地替换中间的主内容卡片；
生成中与失败态下方常驻**禁用态编辑面板**（尺寸/颜色/颗数、工具栏、色板保留占位但不可选，
图案就绪后自动恢复可点），失败时紫色卡片原地切换为失败态，主按钮按失败类型分发
（重新生成 / 购买次数 / 切标准模式 / 重新选图）。

**可用性这条线**：AI 生成任务会在 **1 秒内**失败并提示「AI 生成服务繁忙」。真实原因是混元的
账号维度限流（`EXCEED_REQUEST_LIMIT`），而程序把它当成永久性错误立刻判死 —— 限流其实是
「等一会儿就好」的错误。更要命的是第二个缺陷：用户点「重新生成」时，客户端沿用旧的
`jobId` + 旧幂等键，服务端命中同一个 failed 任务原样返回，于是**每次重试都拿回同一个失败结果**。
两个缺陷叠加的效果是：看起来只是「服务繁忙」，实际上用户没有任何可用的重试路径。

## 本次修改说明

1. **查单请求形状修正**（`6b8a7e8`，服务端）：`access_token` + `pay_sig` 走 query string；
   请求体严格 `openid` / `env` / `order_id`；`pay_sig` 仍按 `HMAC-SHA256(appKey, "/xpay/query_order&" + 请求体原文)` 签。
2. **access_token 缓存与失效重试**（同上）：进程内缓存、提前 5 分钟过期、并发去重；
   遇到 42001 一类 token 失效码**换 token 重试一次**再判失败——这类码不代表「没付款」，
   直接判失败会把一次可自愈的调用打成告警。不新增环境变量，复用现有 `WECHAT_APP_SECRET`。
3. **响应解析修正**（同上）：改从 `order` 对象取值（实付 `paid_fee`、交易号 `wxpay_order_id`、
   商户单号 `channel_order_id`、支付时间 `paid_time`），状态枚举 2/3/4/7 判已付，其余一律 fail-closed。
4. **单页面状态流转**（`17f48c7`，小程序端）：`packages/ai-generation` 页面改为
   排队 / 生成中 / 失败 / 完成四态在同一框架内原地切换，移除独立失败页跳转。
5. **生成卡片支持失败态**（同上）：`generating-preview-card` 新增 `failed` / `showActions` /
   `primaryText` 等属性与 `retry` / `backhome` 事件，失败时去掉进度条与提示胶囊、原地变失败卡片。
6. **编辑面板禁用态注释与语义补齐**（同上）：`editor-control-panel` 明确「生成中保留占位但不可选」。
7. **产品流程同步**：`docs/product/PRODUCT_FLOW.md` 更新为「失败时同一页面原地切换为失败卡片，不跳转独立失败页」。
8. **AI 提交不再一撞限流就判死**（`ecb5911`，服务端）：同一任务 in-flight 去重
   （轮询与后台推进不再重复调 provider —— 那等于自己制造限流）、全局提交最小间隔 800ms 主动降速、
   限流/超时/瞬时不可用**最多退避重试 3 次**（1.5s / 3s + ≤25% 抖动）。重试期间任务停在
   `processing`，前端轮询会自然等到结果，用户无感知；只有 3 次都失败才真的判失败。
   新增日志 `ai_provider_submit_retry_scheduled`（带 attempt / delayMs / internalCode）便于观测。
9. **「重新生成」按钮真正可用**（同上，小程序端 + 服务端）：客户端重试改为换新幂等键并清 `jobId`；
   服务端对同一幂等键命中的 `failed` 任务、过 10 秒冷却后重新排队（清错误码、延长保留期），
   作为旧版客户端沿用旧键的兜底。冷却期是为了避免连点把限流刷得更狠。
10. **图片目录告警噪音**（`d296f10`，小程序端）：`mkdirSync` 在目录已存在时仍抛
    `file already exists`（`recursive: true` 也拦不住），改为先 `accessSync` 判存在，
    只有真正建目录失败（权限/磁盘）才告警。

**用户可见变化**：生成页顶部不再展示原图预览与「尺寸 · 色数 · 提交时间」元信息条，
中间区只留状态卡片——这是本次改版的有意取舍，若验收时认为需要保留原图预览请提出。

## 测试

- `npm run test:ai-failure`：21/21（失败码契约 8 例 + 生成导航 13 例）。
- `node test/payment/run-tests.js`：15/15（本次新增 2 例，覆盖 -15012 / -15002 归一）。
- 服务端全量 214 例（209 通过 / 5 跳过 / 0 失败），比 0.30.21 多 19 例：
  本次新增查单协议 8 例（`server/test/virtual-pay-client.test.js`）、商户单号 6 例、
  AI 提交重试 3 例、限流码登记 1 例、目录告警 1 例。
  变异验证：把 `access_token` 从 URL 上去掉 → 对应用例转红；
  把商户单号改回订单号 → 3 例转红；把 AI 提交重试次数改回 1 → 「限流退避后出图」转红。
- 根 `tsc --noEmit` 0 报错。

## 影响范围

- 小程序端：`packages/ai-generation/*`、`components/generating-preview-card/*`、`components/editor-control-panel/index.wxml`、
  `services/ai-generation-manager.ts`（重试换幂等键）、`services/payment-service.ts`、`packages/payment/recharge/index.ts`、
  `services/image-service.ts`（目录告警）
- 服务端：`src/modules/payments/virtual-pay-client.ts`、`src/modules/payments/payment-service.ts`、
  `src/shared/identity.ts`（`createVirtualOutTradeNo`）、`src/db/schema-contract.ts`、`src/index.ts`、
  `src/modules/ai/ai-generation-service.ts`（提交去重 + 退避重试 + 失败任务重排队）、
  `test/virtual-pay-client.test.js`、`test/payment-service.test.js`、`test/ai-generation-service.test.js`
- 数据库：`server/sql/016_virtual_out_trade_no.sql`（新增列 + 部分唯一索引 + 历史回填，需手工执行）

**不影响范围：**

- 云函数
- 支付的下单与拉起参数本身（只改商户单号的签发与回查方式）
- AI 生成的提示词与产出格式判定（只改提交节奏与失败处理）

## 已知限制

1. **两端都要更新**：小程序不重新上传 = 用户仍走旧的失败页跳转；服务端不重新部署 =
   查单继续返回 41001，付了钱还是不到账。
2. **未付款订单 1 小时后自动关单**：查单确认未支付且创建超过 `VIRTUAL_PAY_RECONCILE_CLOSE_AFTER_MS`
   （默认 1 小时）的 pending 订单会被置为 `closed` 并停止扫描，日志为 `virtual_payment_order_closed`。
   这是为了止住「未付款订单每 5 分钟刷一条 stalled 告警」的噪音；关单后即便迟到的发货推送
   也只会得到 `ORDER_NOT_PAYABLE`，如需人工发货得先改回 `pending`。
4. **限流仍是外部约束**（`EXCEED_REQUEST_LIMIT` 是混元账号维度限流）：进程内降速只对单副本有效，
   多副本部署时每个副本各自降速，并发高峰仍可能撞限流——这时任务会重试 3 次后才失败，
   比现在好但仍需提配额或加分布式闸门才能根治。
5. 0.30.10 的真机验收 T1–T20 仍待补跑。

## 发布前置条件

0. **执行生产数据库迁移 `server/sql/016_virtual_out_trade_no.sql`**（由数据库 owner 手工执行）：
   新增 `pindou_orders.virtual_out_trade_no` 列及其部分唯一索引，并把历史订单回填为订单号本身。
   不执行的后果：新代码查不到商户单号，只能靠 `id = $1` 兜底命中 —— 存量在途订单仍可收尾，
   但**新订单会写不进该列**（列不存在即 SQL 报错），下单直接失败。
1. **服务端重新部署**（必须先于或同步于提审）：master 构建出新镜像后，在服务器改
   `deploy/compose.yaml` 的 `IMAGE_TAG`（本次为 `d296f10`），再 `docker compose pull && up -d`
   （compose 不自动追 `latest`）。
2. **重新上传小程序并提审**（客户端自 0.30.21 之后再次变更）。
3. 沿用 0.30.20 起的支付前置条件：道具 ID 绑定、回调 URL 与三类 `xpay_*` 事件订阅、
   `PAYMENT_NEW_USER_GATE_ENABLED=true`。

## 验收重点

| 场景 | 预期 |
| --- | --- |
| 付款成功（任意套餐） | 5 分钟内次数到账；服务端日志有 `payment_granted`，不再出现 41001 |
| 拉起支付后取消，再点一次购买 | 能正常拉起第二次支付，不再出现 `ORDER_CLOSED`（-15012） |
| 积压的旧 pending 订单 | 部署后下一轮补单自动补发，日志 `virtual_payment_delivery_recovered` |
| AI 生成排队中 | 生成页展示排队卡片 + 禁用态编辑面板，按钮位置不跳动 |
| AI 生成中 | 紫色加载卡片带进度与「取消生成 / 返回首页」，下方面板全禁用 |
| AI 生成失败 | **同一页面原地**切换为失败卡片，主按钮按类型给出重新生成 / 购买次数 / 切标准模式 / 重新选图 |
| AI 生成失败后点「重新生成」 | 真的重新跑一次（任务状态回到排队→生成中），**不再**瞬间弹回同一个失败结果 |
| 高峰期撞混元限流 | 任务不再 1 秒内判失败：等待数秒后自动重试并出图；服务端日志有 `ai_provider_submit_retry_scheduled` |
| AI 生成成功 | 正常进编辑器，面板恢复可点（不受本版影响） |

## 检查记录

- `test:ai-failure` 21/21、`test/payment` 15/15、服务端全量 209 通过 / 5 跳过 / 0 失败
- 版本号：`package.json` 与 `package-lock.json` 均为 `0.30.22`
- 三端推送：cnb / origin / wechat 三个远端均已同步至 `d296f10`，
  核对方式 `git ls-remote <remote> refs/heads/master`
