# 小程序 0.30.20 提审说明

> 状态：代码已落地，小程序虚拟支付用例 `test/payment` 13/13 通过，变异验证确认用例锁定修复；
> 服务端用例、拼豆图生成用例、本地图片资源守卫均不受本版影响（本版未改任何服务端代码）。
> **本版是 0.30.16 之后第一次改动小程序端代码**，必须重新上传小程序提审才会生效。
> 0.30.19 及之前四个版本的小程序包与 0.30.16 完全一致，那个包里带着 signData 的缺陷，支付拉不起来。

## 版本号

`0.30.20`

## 本次提交

| 提交 | 内容 |
| --- | --- |
| `127db79` | fix(miniprogram): 原样透传 signData 字符串修复虚拟支付报错（2 文件 +35 −13） |
| `8f833da` | chore(server): 新增虚拟支付道具 ID 绑定 SQL（1 文件 +37） |
| 本次版本提交 | `package.json` / `package-lock.json` 版本号 `0.30.20`；新增本说明与 CHANGELOG 条目 |

上一版本基线：v0.30.19（虚拟支付联调收口，纯服务端）。

## 版本概述

0.30.16–0.30.19 连续四个版本都在补虚拟支付链路，但**全部是服务端改动，小程序端自 0.30.16 起一行未改**。
结果就是：服务端正向支付、退款、iOS 问询、推送握手全齐了，但真机一拉起支付就直接报错——

```
支付未完成 requestVirtualPayment:fail parametererror: parameter.signData should be String instead of Object
```

根因在客户端：`wx.requestVirtualPayment` 的 `signData` 运行时要求传**字符串**，而 `miniprogram-api-typings`
把它的类型声明成了对象，客户端照着声明 `JSON.parse` 成对象再传进去，微信在参数校验阶段就拒了，
支付一步都走不出去。且 `signData` 是 HMAC-SHA256 签名输入，即便按同样字段重新 `stringify` 也会因为
空格 / 顺序差异导致 `paySig` 验不过——所以正确做法只能是**原样透传服务端下发的那串字符串**。

本版只动客户端这一处：把 `signData` 原样透传，仅做一次 `JSON.parse` 用于字段校验（结果丢弃）。
配套 `test/payment` 新增 / 改写两条用例，断言传给微信的就是服务端那份原始字符串、且字段顺序未变。
变异验证：把透传改回对象后，恰好这两条用例转红、其余 11 条不变，证明用例没有锁错东西。

## 本次修改说明

1. **signData 原样透传**：`miniprogram/services/payment-service.ts` 的 `requestVirtualPayment` 不再把
   `payload.signData` 解析成对象，直接透传字符串；`parseSignData` 仅保留为「校验它是合法 JSON」的辅助函数，
   返回值不再用于传参。

2. **道具绑定 SQL**：`server/sql/015_virtual_product_ids.sql` 把 MP 后台已发布的三个道具 ID 关联到
   `ai_generation_new_user_5` / `ai_generation_30` / `ai_generation_80`。SQL 里道具 ID 是占位符，
   **必须替换成 MP 后台「虚拟支付 → 道具管理」里实际已发布道具的 ID** 后在数据库执行。未绑定或绑定错道具，
   下单会报 `-15010`（道具未发布）/ `-15013`（价格不符）。

## 测试

- `test/payment/`（13 例）：全通过。其中两条专门锁 signData 透传约束，变异验证确认其有效性。
- 服务端、拼豆图生成、本地图片资源守卫：本版未触及，沿用既有结果。

## 影响范围

- 小程序端：`miniprogram/services/payment-service.ts`、`test/payment/virtual-payment.test.js`
- 数据库：`server/sql/015_virtual_product_ids.sql`（执行后才绑定道具；不执行则三个套餐仍 `virtual_product_id` 为空）

**不影响范围：**

- 服务端（本版未改任何服务端代码，0.30.16–0.30.19 的服务端能力照常）
- 云函数
- 数据库结构（仅数据更新，无 DDL）

## 已知限制

1. **必须重新上传小程序提审**：本版改了客户端，0.30.19 及之前的包仍带缺陷。不上传，修复到不了用户。
2. **道具 ID 未绑定 = 仍然无法支付**：`015` SQL 里的占位符不替换、或道具未在 MP 后台「发布到现网」，
   下单会报 `-15010` / `-15013`。服务端 `ensurePayablePackage` 会在 `virtual_product_id` 为空时拦截，
   连微信都走不到。
3. **新人限购开关**：`PAYMENT_NEW_USER_GATE_ENABLED` 仍默认 `true`，0.1 元新人套餐每人限购一次；
   联调用完务必恢复默认（详见 0.30.19 说明）。

## 发布前置条件

1. **重新上传小程序提审**：客户端自 0.30.16 首次变更，必须走一遍微信审核。
2. **执行道具绑定 SQL**：把 `015` 里三个占位符换成 MP 后台实际已发布道具 ID，在数据库执行并提交。
3. **后端环境变量已配齐**：`VIRTUAL_PAY_OFFER_ID` / `VIRTUAL_PAY_APP_KEY`（现网）/ `VIRTUAL_PAY_PUSH_TOKEN` /
   `VIRTUAL_PAY_ENCODING_AES_KEY`、`PAYMENT_NEW_USER_GATE_ENABLED=true`（沿用 0.30.16–0.30.19）。
4. **MP 后台回调与事件订阅**：URL 指向 `/api/payments/virtual-notify`，订阅发货 / 退款 / iOS 问询三类事件。
5. **联调开关保持默认**：`PAYMENT_NEW_USER_GATE_ENABLED` 置回 `true`（或删变量，默认即 `true`）。

## 验收重点

客户端变了，推送链路又只能在真机触发，**真机小额购买是必跑项**：

| 场景 | 预期 |
| --- | --- |
| 真机拉起支付（三个套餐各一次） | 不再报 `signData should be String instead of Object`，能正常进入微信支付 |
| 真机购买 → 发货推送 | 次数到账（配合 0.30.16 补单轮询兜底） |
| 真机退款 | 次数按未消耗额度扣回（配合 0.30.17） |
| 同一账号二次购买新人套餐 | 开关默认时被 `NEW_USER_PACKAGE_NOT_ELIGIBLE` 挡住 |
| 改坏 signData 透传（开发自测） | 微信立即报 `parameter.signData should be String instead of Object`——这正是本版修掉的现象 |

## 检查记录

- `test/payment/`（13 例）：全通过
- 版本号：`package.json`、`package-lock.json` 均为 `0.30.20`
- 三端推送：cnb / origin / wechat 三个远端均已同步，核对方式 `git ls-remote <remote> refs/heads/master`
- `015` SQL 执行（部署后）：三个套餐 `virtual_product_id` 非空
