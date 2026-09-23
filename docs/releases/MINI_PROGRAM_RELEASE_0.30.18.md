# 小程序 0.30.18 提审说明

> 状态：代码已落地，`npm run typecheck` 0 报错，服务端用例 189 例（184 通过 / 5 skip / 0 失败）、小程序虚拟支付用例 13/13、拼豆图生成用例 62/62、本地图片资源守卫 2/2 均通过。
> 本次是**纯服务端改动**，小程序端代码一行未改。提审前必须先部署后端并配好环境变量，否则推送仍然收不到。
> **本版修掉的是一条会让前面两版白做的 bug**：回调入口原先拒绝一切带查询参数的请求，而微信推送必然带 `signature` / `timestamp` / `nonce`——0.30.16 的发货、0.30.17 的退款与 iOS 问询，此前**一条都进不来**。
> 0.30.16 的两条遗留提醒仍然有效：① 部署后端（虚拟支付链路、SQL 014、`generateImage` 云函数需在微信云开发重新部署）；② **0.30.10 的真机验收 T1–T20 仍未执行**，正式提审前必须补跑。

## 版本号

`0.30.18`

## 本次提交

主线是把虚拟支付**入站推送**这条链路真正打通（握手校验 + 验签 + 安全模式解密），并修掉上面那条「推送全被 400」的致命 bug。

| 提交 | 内容 |
| --- | --- |
| `193fe54` | test(auth): 修正 `wechat-client` 用例对 `sessionKey` 的断言（1 文件 +7 −2） |
| `4c34d59` | feat(payment): 接入虚拟支付消息推送握手与解密（7 文件 +608 −2） |
| 本次版本提交 | `package.json` / `package-lock.json` 版本号 `0.30.18`；新增本说明与 CHANGELOG 条目 |

上一版本基线：v0.30.17（退款链路闭环与 iOS 退款问询应答）。

## 版本概述

前面两版把「正向支付」和「退款处理」都写完了，但都建立在一个前提上——**推送能进得来**。这个前提此前并不成立：`/api/payments/virtual-notify` 的入口写着「不接受查询参数，带了就 400」，而微信无论明文还是安全模式，POST 推送时**一定**在 URL 上带 `signature` / `timestamp` / `nonce`（安全模式还带 `msg_signature`、`encrypt_type`）。于是每一条推送都在进门之前被 400 掉：发货没到账、退款没扣回、iOS 问询没应答——而且服务端日志里只有一串 400，看不出是协议理解错了。

除了这一条，入站链路本身也缺一半：MP 后台点「保存」推送配置时会先对 URL 发一次 **GET 握手**，服务端必须按 `SHA1(token, timestamp, nonce)` 校验并**原样回显 `echostr`**，否则后台直接判定 URL 不可用、配置存都存不进去；后台选安全模式时，POST 过来的又是 AES 密文，不解密连事件名都取不到。这两件事都属于协议编解码，本版单独成文件 `virtual-pay-push.ts`，不塞进 `payment-service`。

需要强调：**本版只是让消息能收进来，并没有让推送变得可信。** 发货与扣回仍然以 `query_order` 反向验真为准（fail-closed），推送只作为触发信号。

## 本次修改说明

### 修掉致命 bug

1. **POST 不再拒绝查询参数，改为校验**：原实现 `if (url.searchParams.size > 0) throw invalidArgument(...)` 会把全部推送挡在门外。现在取出 `signature` / `msg_signature` / `timestamp` / `nonce` 做校验，验不过才拒绝。

### 握手与解密

2. **GET 握手回显 `echostr`**：MP 后台保存配置或「模拟推送」时发的是 GET，校验通过后必须原样回显 `echostr`，否则后台判定 URL 不可用。未配置 Token 时直接 **503 `VIRTUAL_PAY_PUSH_NOT_CONFIGURED`**——宁可让配置明着失败，也不要假装配好了却一条推送都收不到。

3. **明文 / 安全模式两套验签**：明文模式校验 `signature`（`SHA1(token, timestamp, nonce)` 字典序**无分隔符**拼接）；安全模式校验 `msg_signature`，它把密文也算进签名，换一封密文重放会验不过，比明文更严。

4. **安全模式解密**：`EncodingAESKey` 固定 43 个 base64 字符，补一个 `=` 后正好解出 32 字节密钥；明文结构是「16 字节随机串 + 4 字节大端长度 + 正文 + AppId」，解密后核对尾部 AppId 确认这条消息确实投给本小程序。没配 `EncodingAESKey` 就按明文模式处理（硬解只会把明文当密文炸掉）。

5. **验签 / 解密失败回 `ErrCode=1` 而不是 4xx**：这类故障的根因在配置，重试多少次结果都一样；回 4xx 会被平台当成网络失败**重试 15 次**，把真正需要人看的告警淹没在噪音里。统一回 200 + `ErrCode=1`，同时打 `virtual_payment_push_rejected` 日志（只记错误码，不记原始报文）。

### 配置校验（启动阶段挡住）

6. **`EncodingAESKey` 必须是 43 个字符**：它不是自由文本，微信生成时长度固定；长度不对会在解密那一刻才炸，表现为「所有推送都解密失败」这种极难归因的故障，不如启动就挡住。
7. **配了 `EncodingAESKey` 就必须配 Token**：否则解开了密文却不知道是谁发的。
8. **生产环境启用虚拟支付必须配 `VIRTUAL_PAY_PUSH_TOKEN`**：没有同一个 Token，MP 后台的 URL 握手永远验不过，配置存不下来，发货 / 退款 / iOS 问询三条推送全断。这项判死是因为它**失败得极其安静**——服务照常起来、下单照常走通，只有「付了钱收不到次数」和「退款了额度没扣回」会在很久之后以客诉形式冒出来。

### 测试

- 新增 `server/test/virtual-pay-push.test.js`：握手校验、安全模式验签、解密与 AppId 核对等。
- `server/test/config.test.js` 补 38 行：推送凭据的解析与区间校验。
- 修正 `server/test/wechat-client.test.js`：0.30.16 起 `exchangeCode` 会一并返回 `sessionKey`（虚拟支付用户态签名要用），该用例仍断言「只返回 openid」，是本次全量跑测试时唯一一条红的，已对齐为 `{ openid, sessionKey }` 并更新用例名。

## 影响范围

- 服务端：`modules/payments/virtual-pay-push.ts`（新增 164 行）、`http/app.ts`（GET 握手分支、POST 验签解密与失败回执）、`config/env.ts`（`VirtualPayPushConfig` 与启动校验）、`index.ts`（注入凭据）、`.env.example`
- 测试：`server/test/virtual-pay-push.test.js`（新增 266 行）、`server/test/config.test.js`、`server/test/wechat-client.test.js`
- 版本与文档：`package.json`、`package-lock.json`、`docs/releases/CHANGELOG.md`、`docs/releases/MINI_PROGRAM_RELEASE_0.30.18.md`

**不影响范围：**

- 小程序端（本次未改任何小程序代码）
- 云函数
- 数据库结构
- 发货 / 退款 / iOS 问询的**业务判定逻辑**（0.30.16 / 0.30.17 已落地，本次只负责让消息进得来）

## 已知限制

1. **明文模式下不做来源加密保护**：不配 `EncodingAESKey` 时只能校验 `signature`，报文是明文传输。推荐后台选安全模式并配齐两个值。
2. **推送仍不被信任**：发货与退款扣回依旧以 `query_order` 验真为准（fail-closed），本次没有改变这一口径。
3. **未识别事件仍回成功**：沿用 0.30.17 的口径——回 `ErrCode=0` 让平台停止重试，但**必须留下事件名**。
4. **0.30.16 / 0.30.17 的遗留项仍然有效**：补单轮询告警阈值需按实际单量调；运营侧需在 MP 后台把道具发布到现网，iOS 还需已配置小程序简称与微信客户端 8.0.68+。

## 发布前置条件

1. **部署后端**：本次全部改动在服务端。
2. **配环境变量**：`VIRTUAL_PAY_PUSH_TOKEN`、`VIRTUAL_PAY_ENCODING_AES_KEY`（43 字符，MP 后台点「随机生成」即可），必须与 MP 后台「消息推送配置」里填的**完全一致**。
3. **MP 后台配置回调 URL 并订阅事件**：URL 指向 `/api/payments/virtual-notify`，订阅发货 / 退款 / iOS 退款问询三类事件（不能只配发货）。
4. **0.30.16 的前置条件一并确认**：虚拟支付道具发布到现网、`generateImage` 云函数重新部署。

## 验收重点

推送链路无法在开发者工具里真实触发，必须**真机小额购买**，并用 MP 后台的「模拟推送」验证握手与解密。

| 场景 | 预期 |
| --- | --- |
| MP 后台保存推送配置 | 握手通过、配置能存住（不是「URL 不可用」） |
| 未配 Token 时后台发起握手 | 503 `VIRTUAL_PAY_PUSH_NOT_CONFIGURED`，明着失败 |
| 安全模式模拟推送 | 能解密并取到事件名，按事件分发 |
| 篡改签名的推送 | 回 200 + `ErrCode=1`，日志有 `virtual_payment_push_rejected`，**不被重试 15 次** |
| 真机购买套餐 → 发货推送 | 次数到账（配合 0.30.16 的补单轮询兜底） |
| 真机退款 | 次数按未消耗额度扣回（配合 0.30.17） |
| `EncodingAESKey` 配成非 43 字符 | 启动即报错，不是运行到解密才炸 |

回归测试：`npm run typecheck` 0 报错、`npm run test:assets` 2/2、`npm run test:pattern` 62/62、`node test/payment/run-tests.js` 13/13，服务端 `npx tsc -p server/tsconfig.json --noEmit` 0 报错 + `node --test server/test/*.test.js` 189 例 0 失败。`test/work-sync/` 未被本次改动触及，未重跑（如需执行先 `npx tsc -p test/work-sync/tsconfig.json`）。

## 检查记录

- `npm run typecheck`：0 报错
- `npx tsc -p server/tsconfig.json --noEmit`：0 报错
- 服务端测试（189 例）：184 通过 / 5 skip / **0 失败**
- `test/payment/`（13 例）：全通过
- `test/pattern-generation/`（62 例）：全通过
- `test/miniprogram-assets/`（2 例）：全通过
- 版本号：`package.json`、`package-lock.json` 均为 `0.30.18`
- 三端推送：cnb / origin / wechat 三个远端均已同步，核对方式 `git ls-remote <remote> refs/heads/master`（不在此处写死 SHA——提审说明属于 release 提交自身，写进去的瞬间就已经落后一个提交）
