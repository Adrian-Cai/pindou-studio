# 小程序 0.30.16 提审说明

> 状态：代码已落地，`tsc --noEmit` 0 报错，虚拟支付用例 13/13、拼豆图生成用例 62/62、本地图片资源守卫 2/2 均通过。
> 本次**含服务端改动**（虚拟支付链路、`session_key` 加密落库、SQL 014），提审前必须先部署后端，否则小程序端拉起支付会拿到空参数。
> 上一轮的部署提醒仍然有效：0.30.11 的 `generateImage` 云函数需在微信云开发重新部署，否则生图角标文案不生效。
> **0.30.10 的真机验收 T1–T20 仍未执行**（历史遗留），正式提审前必须补跑。

## 版本号

`0.30.16`

## 本次提交

主线是支付合规（小程序虚拟支付），另一部分是 OCR 扫描第三轮加固在小程序侧的落地。

| 提交 | 内容 |
| --- | --- |
| `356fd75` | feat(payment): 接入虚拟支付链路，补齐 SQL、签名存储与测试（14 文件 +1791 −328） |
| `b908783` | fix(auth): 调整登录与会话链路（`session_key` 加密落库，4 文件 +34 −7） |
| `455a006` | fix(miniprogram): 修复图纸渲染、列表交互与作品同步问题（13 文件 +223 −14） |
| `e8cb3fa` | fix(miniprogram): 补回候选色数量的非法值守卫（median-cut） |
| `ef8e2f4` | chore(repo): 忽略测试临时产物并回填 Ponytail 优化计划执行状态 |
| `6e3973e` | chore(git): 忽略 `*‑output.txt` 并说明 OCR 扫描原始产物已清理 |
| `4f85353` | feat(payment): 补虚拟支付发货补单的调度配置解析与兜底窗口约束 |
| `e58e8e8` | feat(payment): 补虚拟支付发货补单的调度配置类型 |
| 本次版本提交 | `payment-service.ts` 修正未签发支付参数时的文案；`package.json` / `package-lock.json` 版本号 `0.30.16` |

上一版本基线：v0.30.15（本地图片 WebP 真机不解码的修复）。

**v0.30.15 未单独提审，其内容随本版一并送审**，共两个提交：

| 提交 | 内容 |
| --- | --- |
| `d99d513` | 还原本地图片为 PNG/JPG，修复首页示例图与「我的」页头像在真机上空白（本地 `.webp` 不被解码，见 `MINI_PROGRAM_RELEASE_0.30.15.md`） |
| `c49d330` | 下载记录页封面补 `binderror` 兜底（作品页 / 收藏页早已有，仅此页漏了） |

这两项都在验收重点里列了对应真机检查项，别漏。

## 版本概述

这一版换掉了整个支付通道。**AI 生成次数属于虚拟商品**，官方要求小程序内售卖虚拟商品必须走「小程序虚拟支付」，而且它是 **iOS 端唯一合法通道**——普通 `wx.requestPayment` 在 iOS 上根本无法购买虚拟商品。此前客户端用的是普通微信支付，在 iOS 上属于不合规且走不通的路径。

换通道不只是换一个 API 名：虚拟支付要求客户端原样透传服务端签发的 `signData`（任何一次重新序列化都会让 `paySig` 校验失败）、要求用户态签名 `signature` 用 `session_key` 计算（于是 `session_key` 必须落库并在每次登录时刷新，留旧值会让用户下次支付报 `-15007`）、要求下单前判断宿主是否真的支持（部分宿主有接口但不起作用，只看 `canIUse` 不够）。这三件事分别在客户端、服务端与登录链路里落地。

另一半改动来自第三轮 AI 扫描的加固，共同点是**静默失败**：网格尺寸为 0 时 canvas 既不抛错也不画东西、只表现为「导出了一张空白图」；脏色值让 `getTextColor` 恒定返回白字、白底上完全看不见；`median-cut` 的桶分裂原地排序污染调用方数组、结果悄悄不对。这些都不产生任何报错，只能靠在入口把不合法输入挡住。

## 本次修改说明

### 支付（合规主线）

1. **客户端换用 `wx.requestVirtualPayment`**：`payment-service.ts` 从 `requestWechatPayment` 改为 `requestVirtualPayment`，`signData` 由服务端下发后**原样传给 API**（本地按同样字段重新 `stringify` 都不行——签名输入是那份字符串本身）。运行时要求 `signData` 为 string 而 typings 声明为对象，因此在 `parseSignData` 里还原，并写明「还原成对象不改变任何字段顺序与取值」。

2. **解析失败必须抛明确错误**：带着空对象去拉起支付，微信只会回一句笼统的 `-15001 参数错误`，排查时完全分不清是服务端下发问题还是客户端解析问题。现在 `parseSignData` 解析失败直接抛中文错误。

3. **`canUseVirtualPayment()` 先过版本号再看 `canIUse`**：基础库门槛 2.19.2。`canIUse` 只反映「接口存在与否」，某些宿主（含部分 iOS 微信客户端）存在接口但不起作用，因此两者满足其一才放行。

4. **常见错误码翻译成可行动文案**：`-15002` 订单已存在请重新发起、`-15007` 登录态失效请重新登录、`-15010` 商品暂不可购买、`-15013` 价格异常、`-15014` 商品刚上架请稍等、`-15017` 商家收款受限、`-15020/-15021` 操作过频。用户取消仍以结构化 `errCode === -2` 判定（`errMsg` 会随基础库与系统语言变化，不可靠）。

5. **服务端签名与发货验真**：`virtual-pay-client.ts` 按官方规则算 `paySig = HMAC-SHA256(appKey, "requestVirtualPayment&" + signData)` 与 `signature = HMAC-SHA256(sessionKey, signData)`；`signData` 由 `buildSignData()` 单点生成，既原样下发又作为签名输入，避免第二份序列化实现各自演化。**发货推送无签名，因此发货前强制 `query_order` 反向验真**（fail-closed）。配套 `server/sql/014_virtual_payment_support.sql`。

6. **`session_key` 加密落库并每次登录刷新**：它是虚拟支付用户态签名的密钥，留旧值会让用户下次支付报 `-15007`。登录时一并加密写入、每次登录刷新，取不到时仍完成登录（支付环节再引导重登）。**严禁打进日志或下发客户端**——泄露等于他人可伪造该用户的支付签名。

7. **未签发支付参数时不再谎报「套餐数据无法识别」**（本次版本提交修正）：服务端下单成功但 `virtual` 为 `null`（虚拟支付未启用或降级）时，原先在解析阶段抛通用 `invalidResponse`，文案是「无法识别的套餐数据」，而订单其实已经建好——排查方向会被整个带偏。改为让 `payForAiGenerationPackage` 统一抛「支付参数已失效，请重新发起支付」，并与该场景的测试用例对齐（此前 `test/payment` 该例为红）。

### 小程序端加固

8. **图纸渲染挡住非法网格尺寸**：新增 `requireGridSize` / `requireCanvasHeight`。宽高为 0 会让 `cellWidth` 算成 Infinity、NaN 会污染所有坐标，canvas 拿到非法坐标既不抛错也不画东西，表现为导出空白图。挡在绘制之前，让错误停在离根因最近的地方。

9. **材料统计与落盘用同一套颜色口径**：`summarizeMaterials` 的 key 改为颜色小写归一，与 `models/pattern` 的 `encodePatternCells` 一致。否则 `#FF0000` 与 `#ff0000` 材料表算两种色、调色板只有一项，同一个作品两处给出不同色数。

10. **`getTextColor` 只认 6 位十六进制**：原先只校验长度，`'gggggg'` 长度也是 6 但 `parseInt` 全为 NaN，亮度比较恒为 false → 任何脏色值都返回白字 → 白底白字看不见。

11. **`rgbToHex` 通道收敛到 0~255**：越界分量（负数 / >255 / NaN）会拼出 `-1`、`NaN` 这类不是两位十六进制的串，产出非法颜色；canvas 与 WXML 都不报错，只表现为「这一格不显示」。非有限数落到 0（黑），至少仍是合法颜色。

12. **`median-cut` 复制入桶 + 空桶抛错 + 候选数守卫**：桶分裂前的 `sort` 是原地排序，直接用调用方的 `pixels` 会改掉人家的行优先顺序（不报错、只让结果悄悄不对），改为复制一份入桶；空桶取均值得到 NaN 三元组（`fillStyle` 拿到 NaN 静默不绘制），改为直接抛错——按项目约定不用「合法值」掩盖异常；候选数 `candidateLimit` 补回「必须是 ≥1 的有限整数」的守卫（`e8cb3fa`），否则传 NaN/0 时循环一次不跑、函数「正常返回」单色调色板，整条链路无报错，只看得到「颜色不对」。

13. **作品重命名不再写回陈旧快照**：`await checkTextContent` 期间可能已完成一次云同步（本地作品被换成云端记录、id 都变了），此时把 await 之前的快照写回去，等于把已被替换的旧记录塞回列表——用户看到「重命名成功，但列表里多了一份同名旧作品」。改为 await 后重新取一次，取不到就提示刷新。

14. **云端作品新建拒绝空 id**：新建幂等键由 `draft.id` 派生，id 为空时键退化成 `'create-'`，所有空 id 的新建被服务端当成同一笔去重——用户存两份、云端只留一份，且无报错。改为明确失败。

15. **登录态三个时间字段用同一把尺子**：`createdAt` / `quota.resetsAt` / `aiGeneration.resetsAt` 补 `Date.parse` 有限性校验，挡住「看起来像时间、解析却是 NaN」的脏串（下游倒计时会渲染出 NaN）。

16. **其它**：`download-service` 的 `fileType` 与 `query` 一律 URL 转义；`main-tab-bar` 的 `currentSelected` 默认 `-1`（默认 0 会让「作品」「我的」页先闪一帧首页高亮）；「关于」页缺文案时不弹空内容对话框（空壳弹框看起来像加载失败）。

### 测试

- 新增 `test/payment/`（13 例）：signData 还原与字段顺序、基础库缺失/低版本兜底、`canUseVirtualPayment` 判定、用户取消识别、`session_key` 过期文案、未知错误码保留原信息、未下发参数时拒绝拉起、signData 非法 JSON、缺 signature 拒绝、未登录拒绝。
- 新增 `test/pattern-generation/phase-7-ocr-hardening.test.js`。

## 影响范围

- 小程序主包：`services/payment-service.ts`、`services/auth-service.ts`、`services/download-service.ts`、`services/work-service.ts`、`services/pattern-generation/{color-utils,edge-detector,median-cut}.ts`、`pages/projects/index.ts`、`components/main-tab-bar/index.ts`
- 小程序分包：`packages/result/{services/pattern-render-service.ts,utils.ts}`、`packages/account/about/index.ts`
- 服务端：`modules/payments/{payment-service.ts,virtual-pay-client.ts}`、`modules/auth/{auth-service,auth-repository,wechat-client}.ts`、`config/env.ts`、`db/schema-contract.ts`、`http/{app.ts,request-body.ts}`、`index.ts`、`shared/identity.ts`、`sql/014_virtual_payment_support.sql`
- 测试：`test/payment/`、`test/pattern-generation/`、`server/test/payment-service.test.js`、`server/test/auth.test.js`
- 版本与文档：`package.json`、`package-lock.json`、`docs/releases/CHANGELOG.md`、`docs/releases/MINI_PROGRAM_RELEASE_0.30.16.md`

**不影响范围：**

- 生成算法主干（本次只补输入校验与颜色口径归一，不改算法）
- 云函数（本次无云函数改动）
- 冷启动、分包加载策略

## 已知限制

1. **发货轮询补单：配置与解析已入库，定时任务的改动仍在本地未提交**。官方要求「发货推送分支与发货轮询分支至少实现一个，两者结合更可靠」。本版入库了 `VirtualPayReconcileConfig` 与解析（`e58e8e8` / `4f85353`，含区间约束），但**真正起定时器的那段 `server/src/index.ts` 改动尚未提交**——`reconcilePendingOrders()` 的轮询要等它入库才真正运行。**提审前必须确认该改动已入库并部署**，否则推送丢失或 15 次重试耗尽时，订单仍会永久停在 pending：用户已扣款、次数不到账、系统无告警。
2. **退款链路缺失**：DB 有 `refunded` 状态与 `refund` 额度流水，但服务端没有 `/xpay/refund_order` 与 `xpay_refund_notify` 处理；更糟的是 `app.ts` 的 `DELIVERY_EVENT` 只认 `xpay_goods_deliver_notify`，其余 `xpay_*` 事件（退款、投诉、风控）一律回 `ErrCode=0` 静默吞掉。
3. **iOS 退款问询不应答**：`xpay_subscribe_ios_refund_query_notify` 连续 3 次、3 秒内不应答，平台会向 Apple 返回「不确定」，退款决定权完全交给 Apple。
4. **运行期配置项新增（部署时需一并设置）**：`VIRTUAL_PAY_RECONCILE_INTERVAL_MS`（默认 5 分钟，下限 1 分钟——查单是带 AppKey 签名的上游请求，太密会被限流）、`VIRTUAL_PAY_RECONCILE_GRACE_MS`（默认 3 分钟，给发货推送留出正常到达时间）、`VIRTUAL_PAY_RECONCILE_STALE_AFTER_MS`（默认 30 分钟，超时升级告警）、`VIRTUAL_PAY_RECONCILE_BATCH_SIZE`（默认 100）。都有区间校验与默认值，不配也能起，但告警阈值建议按实际单量调。
5. **运营侧需在 MP 后台确认**：道具/代币在「虚拟支付 → 道具管理」发布到**现网版本**，`pindou_packages.virtual_product_id` 与后台道具 ID、`price_fen` 与后台定价必须一致（不一致客户端报 `-15010` / `-15013`）；iOS 还需已配置**小程序简称**（Apple 支付要求 display name）与微信客户端 8.0.68+。
6. **Windows / 鸿蒙端**：`canUseVirtualPayment()` 只按基础库版本 + `canIUse` 判定，没有平台分支，理论上不拦这两个端，但**未做真机验证**。

## 发布前置条件

1. **部署后端**：虚拟支付链路（含 `virtual-pay-client.ts`、`/api/payments/virtual-notify`）、`session_key_ciphertext` 列、执行 `server/sql/014_virtual_payment_support.sql`。未部署则小程序端下单后拿不到支付参数。**另需确认发货补单轮询的定时器改动已入库**（见「已知限制」第 1 条），否则补单不会真正运行。
2. **MP 后台配置**：虚拟支付道具发布到现网，道具 ID 与定价与 `pindou_packages` 表一致；iOS 端确认小程序简称已配置。
3. **云函数**：`generateImage` 需在微信云开发重新部署（0.30.11 遗留，否则生图角标仍是「AI生成」）。

## 验收重点

**支付必须 iOS 与 Android 各走一次真机小额购买**，这是本版唯一的合规主线，开发者工具里 `requestVirtualPayment` 无法真实拉起。

| 场景 | 预期 |
| --- | --- |
| iOS：充值页选套餐 → 拉起支付 → 完成 | 能拉起虚拟支付（不是普通支付弹窗），成功后次数到账 |
| Android：同上 | 同上 |
| iOS：支付中途取消 | 提示「已取消支付」，不是「请稍后重试」 |
| 长时间未登录后直接支付 | 提示「登录状态已失效，请重新登录后支付」（不是 -15007） |
| 服务端未下发支付参数（虚拟支付开关关闭） | 提示「支付参数已失效，请重新发起支付」，**不是**「无法识别的套餐数据」 |
| 结果页文案 | 刷新/查询失败落「待确认」，不误报「支付失败」 |
| 图纸导出（含 HD 施工图、材料清单、色板） | 正常导出，不出现空白图 |
| 材料清单色数 | 与调色板色数一致（同一颜色大小写不同不会算成两种） |
| 作品重命名（在云同步进行中改名） | 不出现「多出一份同名旧作品」 |
| 底部 tab 切换 | 进入「作品」「我的」时不闪首页高亮 |
| **首页「示例图片」4 张（随 0.30.15 送审）** | 真机能看到 4 张拼豆示例图，不是浅色空白方块（开发者工具里「正常」不构成验收通过——这个 bug 在工具里是隐形的） |
| **「我的」页 / 登录弹层 / 完善资料弹层的头像（随 0.30.15 送审）** | 显示品牌头像，圆角处透出浅绿底色（透明通道生效，不是一块奶白色方图） |
| **下载记录页封面** | 封面地址失效时回退到占位图，不留空白格 |
| 上传真实头像后（走网络地址） | 头像能显示；若空白则是 `downloadFile` 合法域名未配 `https://api.pindou.wiac.xyz`（文档里此前只写了配 `request` 域名） |

回归测试：`npm run typecheck` 0 报错、`npm run test:assets` 2/2、`npm run test:pattern` 62/62、`node test/payment/run-tests.js` 13/13。`test/work-sync/` 未被本次改动触及，未重跑（如需执行先 `npx tsc -p test/work-sync/tsconfig.json`）。

## 检查记录

- `tsc --noEmit`：0 报错
- `test/payment/`（13 例）：全通过（修正 `parseCreatePayment` 后由 12/13 转 13/13）
- `test/pattern-generation/`（62 例）：全通过
- `test/miniprogram-assets/`（2 例）：全通过
- 版本号：`package.json`、`package-lock.json` 均为 `0.30.16`
- 三端推送：cnb / origin / wechat 三个远端均已同步，核对方式 `git ls-remote --heads <remote> master`（不在此处写死 SHA——提审说明属于 release 提交自身，写进去的瞬间就已经落后一个提交）
