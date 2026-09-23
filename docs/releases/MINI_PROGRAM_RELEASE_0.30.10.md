# 小程序 0.30.10 提审说明

> 状态：代码已落地，`tsc --noEmit` 0 报错、拼豆图生成用例 57/57 通过。
> **仍未执行真机验收 T1–T20**，正式提审前必须跑完（重点 T3 杀 App 恢复、T4 切后台 5 分钟、T9 旧版本升级迁移）。

## 版本号

`0.30.10`

## 建议提交信息

- `refactor(ai): AI 生成任务化改造，多任务队列替代全局单例`
- `docs(plan): 同步 AI 生成任务化改造实施进度`
- `release: v0.30.10 AI 生成任务化改造`

## 版本概述

本次把 AI 生成从「全局单任务 + 阻塞式等待页」改造为「多任务队列 + 作品占位卡片」：
发起生成后立即返回可交互状态并在作品里落一条占位记录，多个任务各自独立推进互不覆盖，
成功转为真作品、失败留在作品里显示失败原因并可重试。此前「上一轮没跑完，主链路就被卡住、
且最终出的是上一张图的图纸」的问题不再出现。

## 本次修改说明

1. **新增任务持久化 `services/ai-task-store.ts`**：以数组形式持久化 `AiTask[]`（storage key `pindou-ai-tasks-v1`），替代原来只能存一个对象的单例会话；同时删除 `services/ai-generation-session.ts`。任务上限 20 条，终态任务保留 7 天（`pruneAiTasks()` 在冷启动时清理）。
2. **`ai-generation-manager.ts` 改为任务管理器 `AiTaskManager`**：内部持有 `Map<taskId, AiGenerationFlow>`，由单个 tick 调度器（4s）串行驱动轮询，`MAX_CONCURRENT = 2` 控制并发槽位、`QUEUE_MAX = 10` 控制排队上限；对外提供 `subscribeTask(taskId)` / `subscribeAll()`，页面按 `taskId` 绑定任务而不再依赖「全局唯一任务」。
3. **`ai-generation-flow.ts` 去掉自带定时器**：只暴露 `needsPoll()` / `pollOnce()` 由管理器串行调用；长时间等待提示改为按 `processingSince` 现算，避免 N 个任务各起一个 timeout。
4. **首页零阻塞**：发起 AI 生成后立即返回可交互状态，不再强制跳转等待页；可以连续发起多个任务。点生成的那一刻就在作品列表写入一条带原图封面的占位记录。
5. **作品页展示任务真实状态**：`pages/projects` 支持 AI 任务的进行中 / 失败 / 完成三态卡片，提供查看进度、重试、取消（= 删除任务）操作。
6. **AI 生成页改为任务详情页**：沿用 `packages/ai-generation`，通过 `?taskId=` 绑定具体任务，不新建页面。
7. **生命周期自愈**：补齐冷启动自愈、切后台回前台追赶（`app.onShow` → `aiTaskManager.onAppShow()`，因为小程序切后台后 JS 会被挂起、定时器不可靠）、15 分钟超时自动判失败，以及旧会话到任务队列的数据迁移。
8. **任务与作品单向对齐**：所有状态先落到 `AiTask`，再由管理器的 `applyTaskToWorkItem()` 对齐到 `WorkItem`，这是两者唯一的对齐点，避免各自演化。
9. **`AppStore.saveWork` 增加 AI 占位豁免**：`ai_pending` / `ai_failed` 的作品一律以 `syncStatus: 'guest'` 存本机。否则登录态下会进待同步队列，而占位作品没有 draft，`work-sync-service` 必然报「作品图案数据不完整」并把它标成同步失败；只有任务成功才重新落为 `pending`。
10. **输入图永久化 + 孤儿清理**：把 AI 输入图落到小程序永久目录，避免临时文件被清理后封面丢失；`pruneAiTaskImages()` 在冷启动时清理「无任何任务引用且文件名时间戳超 7 天」的孤儿图片，避免永久目录无限膨胀。
11. **限流自动退避重试**：提交阶段收到 `RATE_LIMITED` 不再直接判失败，而是按 15s / 30s / 60s 退避重试且复用同一 `idempotencyKey`（不会重复扣次数），超过 3 次才判失败；网络类错误按 8s / 15s / 30s 退避，重试上限 `MAX_RETRY_COUNT = 3`。

## 影响范围

- 小程序主包：`services/ai-task-store.ts`（新增）、`services/ai-generation-manager.ts`、`services/ai-generation-flow.ts`、`services/ai-generation-service.ts`、`services/image-service.ts`、`models/pattern.ts`、`store/app-store.ts`、`app.ts`
- 小程序页面：`pages/home`、`pages/projects`、`packages/ai-generation`（含各自的 wxml / wxss）
- 删除文件：`services/ai-generation-session.ts`
- 版本号与 CHANGELOG（`0.30.10`）

**不影响范围：**

- 服务端 AI Provider、任务表结构与配额模型（本次**无需服务端改动**，也不必重新部署）
- 后端 AI 生图接口协议与成功返回字段
- 标准模式本地拼豆图生成算法
- 登录、支付、额度与既有后端 API 协议

## 已知限制（需产品/后端确认）

1. 失败态卡片目前只有「查看进度 · 重试 · 删除」，**没有重命名入口**（方案文档的设计说明与表格表述不一致，暂按表格实现）。
2. 客户端 `MAX_CONCURRENT = 2` 为估计值，需与后端 `aiRateLimiter` 阈值确认；已有 `RATE_LIMITED` 退避重试兜底，但阈值本身仍需对齐。
3. 任务记录本期**只存本地**，不支持跨设备同步。
4. 标准模式仍未入队，首页标准模式还是同步 loading 生成（与原方案一致）。
5. 孤儿图片按「7 天 + 无任务引用」清理，不是引用计数即时删除；任务记录被 `pruneAiTasks()` 提前淘汰时，对应图片要等时间戳到期才会被回收。

## 发布前置条件

1. 本地类型检查归零：`tsc --noEmit` ✅（已通过，0 报错）
2. 拼豆图生成测试全部通过：`node test/pattern-generation/run-tests.js` ✅（已通过，57/57）
3. 版本号一致：`package.json`、`package-lock.json` 均为 `0.30.10` ✅
4. 变更已同步推送 `cnb/master`、`origin/master`、`wechat/master`（待执行）
5. 本次不改服务端，**无需部署后端**；如同一批次还包含服务端改动，则按 0.30.9 流程先构建镜像并跑 Jenkins 流水线。
6. 清除微信开发者工具缓存后重新编译，确认小程序版本显示为 `0.30.10`。

## 提审验收重点

1. **零阻塞主链路**：连续发起 3 个 AI 任务都能立即返回首页，首页生成按钮不被锁死。
2. **多任务互不干扰**：任务 A 进行中发起任务 B，两者各自推进；A 完成后出的是 A 的图，不会串成 B（对应原缺陷）。
3. **占位卡片三态**：作品列表即时出现占位记录；生成中显示进行中、失败显示失败原因且可重试、成功后转为真作品。
4. **取消 / 删除任务**：删除占位卡片能真正停掉后台轮询，不会再自动复活。
5. **生命周期恢复**：杀掉小程序冷启动、切后台 5 分钟再回前台，任务都能续上。
6. **旧版本升级**：由 0.30.9 升级后，旧的 `pindou-ai-generation-session-v1` 会话能迁移为任务，不至于丢失进行中的任务。
7. **并发上限**：同时发起 3 个任务时前 2 个执行、第 3 个排队（created 态等待槽位）。
8. **登录态回归**：登录用户下 AI 占位作品不被塞进云同步队列、不报「作品图案数据不完整」。
9. 失败不扣次数（含限流重试复用同一 `idempotencyKey`）；失败文案可读，可切换标准模式继续。
10. 确认日志与接口响应中不含服务端 API Key 或模型返回的原始临时 URL。

## 检查记录

- [x] 根目录类型检查：`tsc --noEmit`（0 报错）
- [x] 根目录拼豆图生成测试：`node test/pattern-generation/run-tests.js`（57/57 通过）
- [x] 服务端类型检查（本次不改服务端，无回归）
- [x] 版本号一致：`package.json` / `package-lock.json` 均为 `0.30.10`
- [x] 待提交 diff 审查：无遗留调试代码、无新增 TODO/FIXME（新增 9 处 `console.*` 均为错误分支日志）
- [ ] 变更已同步推送 `cnb/master`、`origin/master`、`wechat/master`
- [ ] 真机验收 T1–T20（重点 T3 杀 App 恢复、T4 切后台 5 分钟、T9 旧版本升级迁移）
- [ ] iPhone、Android 真机验证（多任务并发、占位卡片三态、任务详情页）
- [ ] 小程序端值与交互验收（首页零阻塞、作品页卡片操作）
