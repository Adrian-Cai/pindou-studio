# 微信小程序支付接入

项目当前采用微信支付 API v3 的普通商户小程序支付链路：小程序请求服务端创建订单，服务端调用 `/v3/pay/transactions/jsapi` 获取 `prepay_id`，小程序再调用 `wx.requestPayment`；支付结果以微信回调验签和服务端额度流水为准。

## 1. 微信侧准备

1. 完成小程序认证。
2. 申请或准备微信支付商户号，并在商户平台开通 JSAPI/小程序支付权限。
3. 将当前小程序 AppID `wx78d89d6e64966b18` 与商户号绑定。
4. 在商户平台获取并妥善保存：商户号、商户 API 证书序列号、商户 API 私钥、API v3 密钥。
5. 下载微信支付平台公钥，并记录平台公钥证书序列号。
6. 准备公网可访问的 HTTPS 回调地址：

   ```text
   https://<API域名>/api/payments/notify
   ```

微信官方要求小程序完成认证后才能申请支付权限；交易类小程序还需要按平台要求配置订单发货管理能力。详见[开发接入准备](https://pay.wechatpay.cn/doc/v3/merchant/4015459512)和[小程序调起支付](https://pay.wechatpay.cn/doc/v3/merchant/4012791898)。

## 2. 服务端配置

复制 `server/.env.example` 为 `server/.env`，或在生产环境的 `/opt/pindou/config/api.env` 中配置下面全部支付变量：

```dotenv
WECHAT_PAY_MERCHANT_ID=商户号
WECHAT_PAY_MERCHANT_SERIAL_NUMBER=商户API证书序列号
WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH=./certs/apiclient_key.pem
WECHAT_PAY_API_V3_KEY=32字节APIv3密钥
WECHAT_PAY_PLATFORM_SERIAL_NUMBER=微信支付平台公钥序列号
WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH=./certs/wechatpay_public_key.pem
WECHAT_PAY_NOTIFY_URL=https://<API域名>/api/payments/notify
WECHAT_PAY_TIMEOUT_MS=8000
WECHAT_PAY_CALLBACK_TOLERANCE_SECONDS=300
```

私钥、API v3 密钥和 AppSecret 只能放在服务端密钥管理或运行环境中，不能进入小程序包、接口响应、日志或 Git。支付配置只要填写了其中一项，服务端就会要求其余项全部有效；全部不填时，服务端保持安全关闭，创建支付返回 `PAYMENT_NOT_CONFIGURED`。

## 3. 数据库和服务发布

使用生产 API 实际连接的数据库，并用表 owner 或超级用户执行迁移：

```bash
export DB_HOST="<API实际使用的数据库地址>"
export DB_PORT="5432"
export DB_NAME="<数据库名>"
export DB_USER="<表owner或超级用户>"
export DB_PASSWORD="<数据库密码>"
sh deploy/migrate.sh server/sql
unset DB_PASSWORD
```

然后重新构建并重启 API：

```bash
cd server
npm run build
npm run db:inspect
npm test
```

确认 `GET /health` 返回 200 后，再发布包含支付前端调用的小程序版本。

## 4. 测试专用新人福利

迁移 `012_add_new_user_ai_generation_test_package.sql` 会新增 `ai_generation_new_user_5`：售价 ¥0.10，到账 5 次 AI 生成额度。它只用于支付联调，不属于正式套餐。

服务端将“新人”定义为从未成功购买过 AI 生成次数的账号，并限制每个账号只能成功购买一次。资格校验在服务端完成，客户端不能提交自定义金额或额度。测试完成后可执行下面的停用语句：

```sql
UPDATE pindou_packages
   SET enabled = FALSE,
       updated_at = NOW()
 WHERE id = 'ai_generation_new_user_5';
```

## 5. 小程序支付流程

客户端已经按以下顺序实现：

```text
选择套餐
→ POST /api/payments/create（只提交 packageId + Idempotency-Key）
→ wx.requestPayment（使用服务端返回的 5 个调起参数）
→ 支付成功后带 orderId 进入支付结果页
→ 从服务端订单接口读取套餐快照，从 /api/quota/me 刷新 AI 额度
```

服务端会从数据库读取真实价格和额度，客户端不会提交金额；创建订单不会直接增加额度，只有微信支付回调验签、订单金额/商户/AppID/付款人校验全部通过后，才写入一笔 `purchase_grant`。支付页前端回调只用于用户体验，不能作为到账事实。

## 6. 上线前验收

先使用从未购买过 AI 次数的测试用户购买 `ai_generation_new_user_5`，核对微信收银台金额为 `¥0.10`、到账 5 次；再使用正式套餐 `ai_generation_30` 做常规验收，并检查：

- 订单状态变为 `paid`，额度只增加 30 次；
- 重放同一回调不会重复发放；
- 错金额、错商户号、错 AppID、错付款人、错误签名和失败状态都不会发放额度；
- 小程序后台已添加 API HTTPS 域名为 `request` 合法域名；
- 私钥、API v3 密钥、AppSecret 不出现在小程序包、响应和日志中。

完整放行标准见 [`PRODUCTION_PAYMENT_AI_ACCEPTANCE.md`](./PRODUCTION_PAYMENT_AI_ACCEPTANCE.md)。
