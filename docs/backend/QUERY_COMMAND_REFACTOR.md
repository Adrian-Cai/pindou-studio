# 查询与业务动作分离：四项改造记录

日期：2026-09-30。当前工作区版本：小程序 0.37.0，服务端 0.22.0。
本说明范围为后端职责及回归测试改造；本次开发不部署服务端或执行生产迁移。

## 完成范围

| 接口 | 改造结果 | 兼容与边界 |
| --- | --- | --- |
| GET /api/ai/generations/:id | 只读取状态；启动时及每 5 秒后台扫描推进任务 | 请求与响应结构保持兼容；保留限流退避与成功扣次事务 |
| GET /api/orders | 仅查询持久化订单状态 | 回调及已有后台对账仍发货、关单；状态可能等待下一轮对账 |
| GET /api/quota/me | 不锁定用户或发放额度，只读计算预览 | 未发放时使用配置，已发放时使用流水；实际操作事务内懒发放 |
| POST /api/users/me/avatar | 仅更新头像 | file 必填；旧 nickname 字段允许传入但忽略，昵称走独立资料接口 |

用户资料摘要复用账本查询，避免额度入口与“我的”计算不一致。
头像资料提交后的旧文件清理失败只记录日志；数据库更新失败才删除本次未提交的新文件。
AI 服务按模型映射、状态推进、事务持久化拆分，相关代码文件均未超过 800 行。

## 恢复与一致性

- 排队任务、已保存的 Provider 请求 ID（供应商支持查询时）或输出地址由后台恢复，不依赖打开页面。
- 提交结果未知且达到提交超时的任务失败收口，不自动重新提交付费请求。
- 单进程内后台批次不重叠，同一任务推进去重；行锁和原有幂等流水保证成功只扣一次。
- 限流重试保留首次提交时间；失败任务重新排队的 updated_at 使用实际更新时间，避免后台排序被未来到期时间影响。
- 输出下载瞬时失败使用已有轮询退避，避免失败任务持续占据扫描批次。
- 多副本的 Provider 全局限流仍沿用原有单进程限制，不声称具备分布式任务租约。
- 下载、支付到账、AI 完成仍保留必要跨表事务；本次不新增数据库表或迁移。

## 验证

- 根项目 npm run typecheck：通过。
- 服务端 npm run typecheck 与 npm test（包含 build）：通过，282 项通过、5 项跳过、0 项失败。
- 根项目 test:pattern / test:assets / test:ai-failure / test:auth-store-logout：分别 62 / 2 / 31 / 6 项通过。
- 图案测试另有 Phase 5 样本比较因样本文件缺失未运行。
- git diff --check：通过；换行提示属于现有 Windows Git 设置。
- 没有配置 lint 脚本，未安装额外工具。
- 未启用 RUN_DATABASE_INTEGRATION=1，五项真实数据库集成测试未执行；已更新阶段 4 的只读额度/配置变化断言与阶段 6 的后台推进方式。
- 单元测试验证只读 GET、后台重启恢复、重复扫描只扣一次、过期及未知提交不重复收费、头像兼容和失败清理。
- 未执行真实 AI、微信支付、生产数据库联调。本次不改 UI，无视觉实现变更。

## 审查

正常审查检查调用方、事务、归属校验、额度计算、后台恢复和文件清理。
已按 .agents/skills/ponytail-review/SKILL.md 执行本次全部改造 diff 的复杂度审查：

- ai-generation-service.ts: shrink: 两层提交/输出去重与完整任务去重重复；删除两层 Map 和包裹方法，复用完整任务去重。
- 修复后重新执行 ponytail-review：Lean already. Ship.

## 修改文件

- `server/src/index.ts`
- `server/src/http/app.ts`
- `server/src/http/app-helpers.ts`
- `server/src/modules/ai/ai-generation-service.ts`
- `server/src/modules/ai/ai-generation-model.ts`
- `server/src/modules/ai/ai-generation-persistence.ts`
- `server/src/modules/payments/payment-service.ts`
- `server/src/modules/quota/quota-ledger.ts`
- `server/src/modules/downloads/quota-download-service.ts`
- `server/src/modules/users/user-profile-service.ts`
- `server/test/ai-generation-service.test.js`
- `server/test/auth-http.test.js`
- `server/test/orders-http.test.js`
- `server/test/privacy-http.test.js`
- `server/test/quota-download-service.test.js`
- `server/test/users.test.js`
- `server/test/stage4-database-integration.test.js`
- `server/test/stage6-ai-database-integration.test.js`
- `docs/backend/API_SPEC.md`
- `docs/architecture/CURRENT_ARCHITECTURE.md`
- `docs/releases/CHANGELOG.md`
- `server/README.md`
- `docs/backend/QUERY_COMMAND_REFACTOR.md`（本记录）
