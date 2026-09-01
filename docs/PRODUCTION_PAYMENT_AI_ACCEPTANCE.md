# 生产支付与 AI 上线验收

本文区分“代码已具备能力”和“外部生产环境已经验收”。任何一项未留下真实证据时，不得把生产状态标记为完成。

## 当前必须执行的数据库迁移

由 `pindou_*` 表 owner 在目标数据库执行：

```powershell
psql "<由运维安全提供的迁移连接>" -v ON_ERROR_STOP=1 -f server/sql/001_ai_quota_and_jobs.sql
```

随后使用应用账号执行：

```powershell
cd server
npm run build
npm run db:inspect
$env:RUN_DATABASE_INTEGRATION='1'
npm test
```

迁移会加入双额度字段、AI 任务表和三档 AI 套餐：`¥9.9/30`、`¥19.9/80`、`¥29.9/150`。生产执行前先备份，并在预发布库完整演练一次。

## 微信支付小额实付

1. 服务端安全注入 `.env.example` 中全部 `WECHAT_PAY_*` 项；私钥、API v3 Key 和 AppSecret 不进入仓库、日志或客户端。
2. 回调域名使用有效 HTTPS 证书，并在微信商户平台配置同一 AppID/商户号关系。
3. 使用真实测试用户购买 `ai_generation_30`，核对微信侧金额为 `¥9.90`，不要修改生产套餐价格来制造“一分钱成功”。
4. 保存商户订单号、微信交易号、支付时间和脱敏截图；数据库核对订单为 `paid`，且恰好一笔 `quota_kind=ai_generation AND type=purchase_grant`，金额为 30。
5. 重放同一微信通知，确认 HTTP 成功但订单仍只有一笔发放；分别验证错金额、错商户、错 AppID、失败状态、未知订单和错误签名不会发放。
6. 支付成功页只能重新请求 `/api/quota/me`，不得读取 URL 参数增加额度。

## 千问、存储、HTTPS 与监控

- 配置同地域 `QWEN_IMAGE_API_KEY`、`QWEN_IMAGE_BASE_URL` 和 `qwen-image-3.0`；任务保持异步轮询，Provider 输出必须下载并持久化，不能长期引用 24 小时临时 URL。
- `AVATAR_STORAGE_DIR`、`COVER_STORAGE_DIR`、`AI_FILE_STORAGE_DIR` 必须挂载到有备份和恢复能力的生产持久卷；完成恢复演练后才设置 `PERSISTENT_STORAGE_MOUNTED=true`。
- `COVER_PUBLIC_BASE_URL` 与 `AI_FILE_PUBLIC_BASE_URL` 必须为 HTTPS；API HTTPS 由入口网关/负载均衡终止，HTTP 只允许在受信任内网回源。
- 监控至少探测 `/health`，采集 `wechat_payment_notification_rejected`、`wechat_payment_granted`、`ai_generation_failed` 和 `request_failed` 结构化事件，并为连续失败、5xx、数据库不可用和支付回调失败设置告警；完成告警演练后才设置 `MONITORING_ALERTS_CONFIGURED=true`。
- `APP_ENV=production` 时，代码会拒绝缺少微信支付、千问、HTTPS 文件地址、持久存储确认或监控确认的配置。

## 放行门槛

只有迁移审计、真实小额支付、对象/持久存储恢复、HTTPS 证书、监控告警演练以及启用真实数据库测试全部通过，才可以记录“生产验收完成”。本地替身、伪造回调或手工改订单均不算实付证据。
