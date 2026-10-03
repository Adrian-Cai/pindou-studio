# 小程序 0.33.0 提审说明

## 版本

- 小程序：`0.33.0`
- 服务端：`0.18.0`
- 服务端代码提交：`068b30a`（TokenHub 切换）、`af30562`（订单索引校验修复）
- 建议提交信息：`release(releases): 准备小程序 0.33.0 提审`

## 微信审核版本说明

优化 AI 精致生成功能。用户主动使用 AI 生图时，新任务由腾讯云 TokenHub 混元 Hy-Image-3.5 处理；输入图片和生成所需信息会提交给模型服务商。服务端校验并保存生成结果后再扣除额度。本次同步更新隐私政策和第三方信息共享清单，小程序继续使用原有任务接口，端上功能逻辑无变化。

## 本次更新

### AI 精致生成

- 新任务固定使用 `hy-image-v3.5-preview`，不发送可选 `footnote` 字段。
- 服务端立即下载 TokenHub 临时图片，校验可信地址、文件大小和图片格式后保存到项目文件存储；任务成功后才扣除一次额度。
- 迁移前的 ToAPIs 与 CloudBase 混元任务仍由原 Provider 收口；队列排空前需保留对应服务端配置和密钥。
- 小程序请求协议、标准模式图案生成和支付流程没有变化。

### 关于页

- 页面展示的版本号由 `0.30.1` 对齐到 `0.33.0`；该文案此前长期未跟随版本更新。
- 这是本次小程序端唯一的代码改动，不含任何功能或交互调整。

## 发布前置条件

1. 生产库已确认存在 `public.idx_pindou_orders_active_expiry`。此前启动失败是 PostgreSQL 把 `varchar` 谓词显示为 `((status)::text = 'pending'::text)`，旧 Schema Contract 未识别该表达式；部署包含本次校验修复的服务端 `0.18.0` 后确认 `/health` 通过，无需重建索引。
2. 在服务端生产环境配置 `TOKENHUB_HUNYUAN_IMAGE_API_KEY`；确认服务端启动和 `/health` 检查通过。
3. 用真实生产/预发布 Key 完成端到端生图验收：不发送 `footnote`、参考图可访问、输出能下载并持久化、额度只扣一次；同时检查内容拒绝、限流和超时处理。
4. 只读核对 `pindou_ai_generation_jobs` 中 `provider='toapis'` 且状态为 `queued` 或 `processing` 的任务数量；任务排空前保留 ToAPIs 与 CloudBase 混元配置。
5. 确认 TokenHub 服务商告知和更新后的隐私政策、第三方信息共享清单已按实际上线计划生效。
6. 服务端健康后，在微信开发者工具上传小程序 `0.33.0`，完成真实账号验收再提交审核。
7. 服务端部署链路已变更（`Jenkinsfile` + `deploy/deploy.sh`）：Jenkins 改为按 commit sha 拉取镜像，先试完整 sha、回退短 sha，因此不适合再用 `latest`；健康等待或健康检查失败会自动回滚到上一个成功版本，也可在服务器上用 `sh /opt/pindou/deploy/rollback.sh` 手动回退。首次按新流程部署 `0.18.0` 时留意 Jenkins 控制台输出。

## 检查记录

- [x] 根目录 TypeScript 类型检查通过（`npm run typecheck`）
- [x] 服务端构建及测试通过（248 项通过、0 项失败；`*database-integration*` 需真实库，未纳入）
- [x] 根目录 `test:pattern`（62）、`test:assets`（2）、`test:ai-failure`（24）、`test:auth-store-logout`（5）通过
- [x] Ponytail 复杂度审查通过
- [x] CI 已加质量门禁：`.cnb.yml` 在构建镜像前跑同一套检查，失败则不产镜像
- [ ] TokenHub 真实接口验收完成
- [ ] Schema Contract 校验修复部署和服务端健康检查完成
- [ ] 旧 Provider 在途任务数量核对完成
- [ ] 小程序真机/真实账号验收和微信审核提交完成
