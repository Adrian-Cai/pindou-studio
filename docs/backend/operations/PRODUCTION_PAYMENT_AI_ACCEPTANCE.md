# 生产支付与 AI 上线验收

本文区分“代码已具备能力”和“外部生产环境已经验收”任何一项未留下真实证据时，不得把生产状态标记为完成

## 当前必须执行的数据库迁移

由 `pindou_*` 表 owner（或超级用户）在目标数据库执行。`000_schema_migrations.sql` 会创建迁移记录表，部署脚本会按编号和 SHA-256 只执行未记录的迁移；迁移含 `ALTER TABLE` / `COMMENT ON` / `CREATE INDEX`，PostgreSQL 只允许 owner 改表，仅有表级 `GRANT` 会报 `ERROR: must be owner of table pindou_*`：

```bash
export DB_HOST="<API 实际使用的数据库地址>"
export DB_PORT="5432"
export DB_NAME="<数据库名>"
export DB_USER="<表 owner 或超级用户>"
export DB_PASSWORD="<数据库密码>"
sh deploy/migrate.sh server/sql
unset DB_PASSWORD
```

迁移连接必须是 API 实际使用的那个库（`config/api.env` 中 `DB_HOST` 指向的实例）；Jenkins 会在启动 API 前用宿主机 `psql` 调用 `deploy/migrate.sh`，只执行未记录的迁移，并在启动迁移前校验 `DB_USER` 对全部 `pindou_*` 表的 owner 权限（不满足时直接失败并列出缺权限的表）；手工补跑时同样要对准该实例并使用 owner 账号。完整清单与说明见 `server/README.md`。

随后使用应用账号执行：

```powershell
cd server
npm run build
npm run db:inspect
$env:RUN_DATABASE_INTEGRATION='1'
npm test
```

迁移会加入双额度字段、AI 任务表和三档 AI 套餐：`¥9.9/30`、`¥19.9/80`、`¥29.9/150`；`001` 会停用旧下载套餐和无限会员套餐，生产执行前先备份，并在预发布库完整演练一次

## 微信支付小额实付

1. 服务端安全注入 `.env.example` 中全部 `WECHAT_PAY_*` 项；私钥、API v3 Key 和 AppSecret 不进入仓库、日志或客户端
2. 回调域名使用有效 HTTPS 证书，并在微信商户平台配置同一 AppID/商户号关系
3. 使用真实测试用户购买 `ai_generation_30`，核对微信侧金额为 `¥9.90`，不要修改生产套餐价格来制造“一分钱成功”
4. 保存商户订单号、微信交易号、支付时间和脱敏截图；数据库核对订单为 `paid`，且恰好一笔 `quota_kind=ai_generation AND type=purchase_grant`，金额为 30
5. 重放同一微信通知，确认 HTTP 成功但订单仍只有一笔发放；分别验证错金额、错商户、错 AppID、失败状态、未知订单和错误签名不会发放
6. 支付成功页只能重新请求 `/api/quota/me`，不得读取 URL 参数增加额度

## 千问、存储、HTTPS 与监控

- 配置同地域 `QWEN_IMAGE_API_KEY`、`QWEN_IMAGE_BASE_URL` 和 `qwen-image-3.0`；任务保持异步轮询，Provider 输出必须下载并持久化，不能长期引用 24 小时临时 URL
- `QWEN_IMAGE_API_KEY` 只能注入服务端运行环境；验收客户端包、接口响应和日志均无 API Key、Provider 原始错误或内部堆栈
- 验收 AI 输入/输出真实格式、10 MiB 大小、4096×4096 尺寸及 16 MP 像素限制；验收每用户 10 分钟 5 次的上传/任务创建限流
- 使用恶意或非阿里云输出地址、跨域跳转和非 PNG 输出做回归，确认均不会被服务端下载或持久化
- 用正常、同步命中风险、异步回调命中风险和审核服务不可用样本验收：AI 输出必须先同步通过图片审核才进入 `ai_output`；异步审核回调和过期清理由生产任务验证
- 创建孤立 `ai_input`、过期 queued/processing/succeeded/failed 任务并执行清理，确认数据库资产软删除、物理文件删除且清理失败有监控/补偿
- `AVATAR_STORAGE_DIR`、`COVER_STORAGE_DIR`、`AI_FILE_STORAGE_DIR` 必须挂载到有备份和恢复能力的生产持久卷；完成恢复演练后才设置 `PERSISTENT_STORAGE_MOUNTED=true`
- `COVER_PUBLIC_BASE_URL` 与 `AI_FILE_PUBLIC_BASE_URL` 必须为 HTTPS；API HTTPS 由入口网关/负载均衡终止，HTTP 只允许在受信任内网回源
- 监控至少探测 `/health`，采集 `wechat_payment_notification_rejected`、`wechat_payment_granted`、`ai_generation_failed` 和 `request_failed` 结构化事件，并为连续失败、5xx、数据库不可用和支付回调失败设置告警；完成告警演练后才设置 `MONITORING_ALERTS_CONFIGURED=true`
- `APP_ENV=production` 时，代码会拒绝缺少微信支付、千问、HTTPS 文件地址、持久存储确认或监控确认的配置

## 放行门槛

只有迁移审计、真实小额支付、对象/持久存储恢复、HTTPS 证书、监控告警演练以及启用真实数据库测试全部通过，才可以记录“生产验收完成”本地替身、伪造回调或手工改订单均不算实付证据
