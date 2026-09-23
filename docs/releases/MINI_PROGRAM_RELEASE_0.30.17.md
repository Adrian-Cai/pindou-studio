# 小程序 0.30.17 提审说明

> 状态：代码已落地，`npm run typecheck` 0 报错，服务端支付用例 33/33、小程序虚拟支付用例 13/13、拼豆图生成用例 62/62、本地图片资源守卫 2/2 均通过。
> 本次是**纯服务端改动 + CI 配置**，小程序端代码一行未改。提审前必须先部署后端，否则退款推送与 iOS 退款问询不会生效。
> 0.30.16 的两条遗留提醒仍然有效：① 部署后端（虚拟支付链路、SQL 014、`generateImage` 云函数需在微信云开发重新部署）；② **0.30.10 的真机验收 T1–T20 仍未执行**，正式提审前必须补跑。

## 版本号

`0.30.17`

## 本次提交

主线是把 0.30.16 遗留的**退款链路**补上（对应 0.30.16「已知限制」第 2、3 条），另一部分是 CI 运行镜像钉版本。

| 提交 | 内容 |
| --- | --- |
| `6f482cc` | ci(ci): 钉死 `ubuntu-24.04` 运行镜像，避免 CI 随浮动标签静默换系统（2 文件 +6 −3） |
| `3c543c9` | feat(payment): 接入退款推送与 iOS 退款问询，按未消耗额度扣回（3 文件 +504 −8） |
| `a0cb14a` | test(payment): 补 33 例退款扣回与 iOS 退款问询用例（1 文件 +211） |
| 本次版本提交 | `package.json` / `package-lock.json` 版本号 `0.30.17`；新增本说明与 CHANGELOG 条目 |

上一版本基线：v0.30.16（小程序虚拟支付接入）。

## 版本概述

这一版补的是**钱往回走**的那半条链路。0.30.16 把正向支付做完了，但退款侧是空的：DB 里有 `refunded` 状态与 `refund` 额度流水，服务端却没有对应的推送处理。后果很直接——**钱退给用户了，AI 生成次数还留在他手里**。

补这件事的难点在于：**退款不由我们决定是否发生。** iOS 上开发者根本没有主动发起退款的能力（Apple 支付不支持），是用户在 App Store 自助申请、Apple 自行审批；安卓 / 鸿蒙 / Windows 走微信支付，商户可主动退、用户也能走客诉渠道。两条路径退成了都会推同一个事件 `xpay_refund_notify`，我们只能接收结果，不能阻止发生。

iOS 侧还有一层：Apple 会就退款**向我们问询**（`xpay_subscribe_ios_refund_query_notify`），这是唯一一次能举证的机会。它走的是**完全独立的应答协议**（回 `result_code` / `result_info` / `evidence`，不是 `ErrCode`），而且**重复三次、3 秒内不答，平台就向 Apple 返回「不确定」，退款决定权整个交给 Apple**。所以异常分支也必须答——宁可放过，也不能不答；不答等于主动放弃举证。

第三处是此前被静默吞掉的事件：`app.ts` 原来只认 `xpay_goods_deliver_notify`，其余 `xpay_*`（退款、投诉、风控）一律回 `ErrCode=0` 吞掉。商户被管控、用户发起投诉这种事发生时，我们连一行日志都没有。现在改为按事件名分发，未识别事件仍然回成功让平台停止重试，但**必须留下事件名**。

## 本次修改说明

### 退款推送（xpay_refund_notify）

1. **按事件名分发，不再只认发货**：新增 `parseEventName()`，同时支持 JSON 与 XML 两种推送体（微信的 `xpay_*` 推送历史上两种都出现过）。回调入口先取事件名再决定走哪条分支，解析层统一在 `parseJsonRecord()` 里校验格式、失败抛明确错误。

2. **退款只扣回「用户还没用掉的部分」**：`clawBack = min(当前剩余的购买额度 purchased, 该单发放的额度 quota_amount_snapshot)`。两个维度都要看——只看发放额度，用户已经消耗掉的也会被扣成负数；只看剩余额度，多次购买时可能扣到别的单头上。已全额消耗的订单**仍然标记 `refunded`，但不扣任何额度**（测试例 24 锁住这条）。

3. **失败退款不动账**：`retCode !== 0` 表示退款本身失败，此时订单与额度都必须保持原样，只记 `virtual_payment_refund_rejected`。

4. **重复推送幂等**：订单已是 `refunded` 时直接返回，不重复插入扣回流水（`ON CONFLICT DO NOTHING` + `refund:<orderId>` 幂等键双保险）。

5. **定位不到订单要上报，不能丢**：商户单号（我们下单时的 `outTradeNo`）缺失时回退用 `attach` 定位；两者都没有、或查无此单、或付款人对不上，一律打 `virtual_payment_refund_alert` 而不是静默返回。退款这种事静默失败，等于钱和货两头都不见了还查不到。

6. **额度快照不合法时拒绝扣回**：`quota_kind_snapshot !== 'ai_generation'` 或 `quota_amount_snapshot <= 0` 时只告警不扣——快照坏了说明数据有问题，按坏数据扣额度比不扣更危险。

### iOS 退款问询（xpay_subscribe_ios_refund_query_notify）

7. **独立应答协议 + 异常也必须答**：应答体是 `result_code` / `result_info` / `evidence`，不是 `ErrCode`。`evidence` 是**必填项**（用于退款审计），空着等于放弃举证。处理抛异常时仍然返回 `result_code=0`（放过），并写明「服务端未能完成举证」——按官方规则，不答的代价远大于误放过。

8. **只在「确实已发货」时主张拒绝**：`result_code=1` 只在订单状态为 `paid`（已发货）时返回；订单不存在、未发货、无法定位订单三种情况一律 `result_code=0`。判定依据是**我方订单状态**，不是推送里那个 `provide_status`（注释里已写明它仅作参考）。原则：**无法归因的退款一律不拦截**。

### CI

9. **`runs-on` 钉死 `ubuntu-24.04`**：GitHub 自 2026-10-19 起把 `ubuntu-latest` 分批切到 Ubuntu 26.04（11-19 完成），内核 6.17→7.0、systemd 255→259、glibc 一并升级。跟随浮动标签会让流水线在某天无声换掉整个系统镜像、且当天很难归因到「镜像换了」。钉版本后可在自己选的时机验证再切。三个 job（`miniprogram-static-check`、`server-static-check`、`code-review`）一并改。

### 测试

- 新增 33 例（`server/test/payment-service.test.js`）：扣回未消耗额度、已全额消耗不扣、失败退款不动账、重复推送幂等、缺商户单号时回退 `attach`、定位不到订单上报而非丢弃，以及 iOS 问询的已发货拒绝 / 未发货放行 / 订单未知放行 / 无法归因不拦截。

## 影响范围

- 服务端：`http/app.ts`（事件名分发、退款与 iOS 问询解析、未识别事件留痕）、`modules/payments/payment-service.ts`（`handleRefund` / `answerIosRefundQuery`）、`modules/payments/virtual-pay-client.ts`（`RefundNotification` / `IosRefundQueryNotification` / `IosRefundQueryAnswer` 三个类型）
- CI：`.github/workflows/ci.yml`、`.github/workflows/ocr-review.yml`
- 测试：`server/test/payment-service.test.js`
- 版本与文档：`package.json`、`package-lock.json`、`docs/releases/CHANGELOG.md`、`docs/releases/MINI_PROGRAM_RELEASE_0.30.17.md`

**不影响范围：**

- 小程序端（本次未改任何小程序代码）
- 云函数
- 数据库结构（`pindou_orders.status = 'refunded'` 与 `pindou_quota_transactions.type = 'refund'` 在 SQL 014 中已存在，本次只是第一次真正写入）
- 正向支付链路

## 已知限制

1. **退款后不回收已生成的作品**。扣回的是「次数」，用户用这些次数已经生成的拼豆图纸仍然留在他账号里。这是当前的刻意选择（回收作品会造成数据丢失且不可恢复），但意味着「退款 + 已生成内容」的组合是允许的，运营侧需要知道。
2. **部分退款按「不区分」处理**：推送里的 `refundFeeFen` 可能小于订单金额，当前只记录与核对，不作为扣回依据——仍按整单快照扣回未消耗额度。微信侧对虚拟商品的部分退款规则需要实际跑通后确认。
3. **iOS 问询的 `evidence` 内容较粗**：目前是「订单 X 状态为 paid，虚拟商品已交付」这类结构化描述，没有带具体的发货时间戳与消费记录。举证强度有提升空间，但已满足「必填且非空」的底线。
4. **0.30.16 遗留的告警阈值仍需按实际单量调**：`VIRTUAL_PAY_RECONCILE_STALE_AFTER_MS`（默认 30 分钟）等补单轮询参数，本版未调整。
5. **0.30.16 遗留的运营侧确认项仍然有效**：道具 / 代币需在 MP 后台「虚拟支付 → 道具管理」发布到现网，iOS 还需已配置小程序简称与微信客户端 8.0.68+。

## 发布前置条件

1. **部署后端**：本次全部改动都在服务端，未部署则退款推送与 iOS 问询不会生效（表现为「钱退了、次数还在」）。
2. **确认虚拟支付回调地址可接收全部 `xpay_*` 事件**：MP 后台配置的回调 URL 需能收到退款与 iOS 问询推送，不能只配发货。
3. **0.30.16 的前置条件一并确认**：虚拟支付道具发布到现网、`generateImage` 云函数重新部署。

## 验收重点

退款无法在开发者工具里真实触发，必须**真机小额购买后再走退款流程**。

| 场景 | 预期 |
| --- | --- |
| 购买套餐后未消耗，发起退款 | 退款成功后 AI 生成次数被扣回，不再可用 |
| 购买套餐后已全部消耗，发起退款 | 订单标记为已退款，但额度不扣成负数 |
| 同一笔退款推送重复到达 | 只扣回一次（幂等），不出现两条扣回流水 |
| 退款失败（`retCode ≠ 0`） | 订单与额度均保持原样，日志有 `virtual_payment_refund_rejected` |
| 推送缺商户单号 | 用 `attach` 回退定位成功；两者都缺时打 `refund_alert` 而非静默 |
| iOS 退款问询：订单已发货 | 应答 `result_code=1`，带非空 `evidence` |
| iOS 退款问询：订单未知 / 未发货 | 应答 `result_code=0`（不拦截） |
| 服务端处理问询时抛异常 | **仍然应答**（`result_code=0` + 「处理异常，不主张拒绝退款」），不是无响应 |
| 其它 `xpay_*` 事件（投诉 / 风控） | 回 `ErrCode=0` 停止重试，且日志有 `virtual_payment_event_ignored` 带事件名 |
| CI 流水线 | 三个 job 均运行在 `ubuntu-24.04`，不随 GitHub 切换到 26.04 |

回归测试：`npm run typecheck` 0 报错、`npm run test:assets` 2/2、`npm run test:pattern` 62/62、`node test/payment/run-tests.js` 13/13。`test/work-sync/` 未被本次改动触及，未重跑（如需执行先 `npx tsc -p test/work-sync/tsconfig.json`）。

## 检查记录

- `npm run typecheck`：0 报错
- `npx tsc -p server/tsconfig.json --noEmit`：0 报错
- `server/test/payment-service.test.js`（33 例）：全通过
- `test/payment/`（13 例）：全通过
- `test/pattern-generation/`（62 例）：全通过
- `test/miniprogram-assets/`（2 例）：全通过
- 版本号：`package.json`、`package-lock.json` 均为 `0.30.17`
- 三端推送：cnb / origin / wechat 三个远端均已同步，核对方式 `git ls-remote <remote> refs/heads/master`（不在此处写死 SHA——提审说明属于 release 提交自身，写进去的瞬间就已经落后一个提交）
