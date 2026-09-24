# 小程序 0.30.22 提审说明

> 状态：代码已落地。`test:ai-failure` 21/21、`test/payment` 13/13、
> 服务端全量 203 例（198 通过 / 5 跳过 / 0 失败，其中本次新增 8 例查单协议用例），
> 根 `tsc --noEmit` 0 报错。变异验证：去掉查单的 `access_token` 后对应用例转红。
> 本版**小程序端与服务端都改了**：小程序必须重新上传提审、服务端必须重新部署，
> 缺任何一半，付款不到账的问题就不会消失。

## 版本号

`0.30.22`

## 本次提交

| 提交 | 内容 |
| --- | --- |
| `6b8a7e8` | fix(payment): 修复虚拟支付查单缺 `access_token` 导致付款不到账（服务端） |
| `17f48c7` | refactor(miniprogram): AI 生成全过程收敛到单页面原地切换（小程序端） |
| 本次版本提交 | 提审说明、CHANGELOG 条目 |

上一版本基线：v0.30.21（AI 失败原因可见与入队导航）。

## 版本概述

两条线，一条是**生产故障**，一条是**生成体验**。

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

**用户可见变化**：生成页顶部不再展示原图预览与「尺寸 · 色数 · 提交时间」元信息条，
中间区只留状态卡片——这是本次改版的有意取舍，若验收时认为需要保留原图预览请提出。

## 测试

- `npm run test:ai-failure`：21/21（失败码契约 8 例 + 生成导航 13 例）。
- `node test/payment/run-tests.js`：13/13。
- 服务端全量 203 例（198 通过 / 5 跳过 / 0 失败），比 0.30.21 多 8 例（本次新增
  `server/test/virtual-pay-client.test.js`，锁定查单请求形状与响应解析）。
  变异验证：把 `access_token` 从 URL 上去掉 → 对应用例转红。
- 根 `tsc --noEmit` 0 报错。

## 影响范围

- 小程序端：`packages/ai-generation/*`、`components/generating-preview-card/*`、`components/editor-control-panel/index.wxml`
- 服务端：`src/modules/payments/virtual-pay-client.ts`、`src/index.ts`、`test/virtual-pay-client.test.js`

**不影响范围：**

- 数据库结构与数据（无 SQL 变更）、云函数
- 支付的下单与拉起链路（只改服务端验真调用与响应解析）
- AI 生成本身的调用时序（只改状态呈现）

## 已知限制

1. **两端都要更新**：小程序不重新上传 = 用户仍走旧的失败页跳转；服务端不重新部署 =
   查单继续返回 41001，付了钱还是不到账。
2. **历史积压订单靠补单自动恢复**：部署后那 9 笔 pending 订单会在下一个补单周期（5 分钟内、
   每轮最多 100 笔）自动补发，日志出现 `virtual_payment_delivery_recovered` + `payment_granted`；
   超过 30 分钟仍查不到支付的会进 `stalled` 告警，需要人工介入。
3. 0.30.10 的真机验收 T1–T20 仍待补跑。

## 发布前置条件

1. **服务端重新部署**（必须先于或同步于提审）：master 构建出新镜像后，在服务器改
   `deploy/compose.yaml` 的 `IMAGE_TAG`（本次为 `17f48c7`），再 `docker compose pull && up -d`
   （compose 不自动追 `latest`）。
2. **重新上传小程序并提审**（客户端自 0.30.21 之后再次变更）。
3. 沿用 0.30.20 起的支付前置条件：道具 ID 绑定、回调 URL 与三类 `xpay_*` 事件订阅、
   `PAYMENT_NEW_USER_GATE_ENABLED=true`。

## 验收重点

| 场景 | 预期 |
| --- | --- |
| 付款成功（任意套餐） | 5 分钟内次数到账；服务端日志有 `payment_granted`，不再出现 41001 |
| 积压的旧 pending 订单 | 部署后下一轮补单自动补发，日志 `virtual_payment_delivery_recovered` |
| AI 生成排队中 | 生成页展示排队卡片 + 禁用态编辑面板，按钮位置不跳动 |
| AI 生成中 | 紫色加载卡片带进度与「取消生成 / 返回首页」，下方面板全禁用 |
| AI 生成失败 | **同一页面原地**切换为失败卡片，主按钮按类型给出重新生成 / 购买次数 / 切标准模式 / 重新选图 |
| AI 生成成功 | 正常进编辑器，面板恢复可点（不受本版影响） |

## 检查记录

- `test:ai-failure` 21/21、`test/payment` 13/13、服务端全量 198 通过 / 5 跳过 / 0 失败
- 版本号：`package.json` 与 `package-lock.json` 均为 `0.30.22`
- 三端推送：cnb / origin / wechat 三个远端均已同步，核对方式 `git ls-remote <remote> refs/heads/master`
