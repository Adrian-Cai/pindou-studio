# 小程序 0.30.10 提审说明

> 状态：代码已落地，`tsc --noEmit` 0 报错，拼豆图生成用例 57/57、作品同步用例 12/12 通过。
> **仍未执行真机验收 T1–T20**，正式提审前必须跑完（重点 T3 杀 App 恢复、T4 切后台 5 分钟、T9 旧版本升级迁移）。

## 版本号

`0.30.10`

## 本次提交（HEAD `73a4d02`）

| 提交 | 说明 |
| --- | --- |
| `73a4d02` | `feat(ai): 首页入队反馈改为按钮就地成功态加轻震动` — pages/home 三件套 |
| `ca573e1` | `fix(ai): AI 产物落盘前裁掉平台水印带` — image-service + ai-generation-flow |
| `b4d1231` | `docs(releases): CHANGELOG 补 AI 占位作品同步豁免收口修复` |
| `1e88670` | `test(miniprogram): 补 AI 占位作品不上云的不变式测试` — 新增 test/work-sync/ |
| `f910ee8` | `fix(miniprogram): AI 占位作品上云豁免收口到单一判定` |
| `ce4b2c5` | `release: v0.30.10 AI 生成任务化改造` — 版本号、CHANGELOG、提审说明 |
| `e52fc97` | `docs(plan): 同步 AI 生成任务化改造实施进度` — 方案文档 §15 进度与遗留项 |
| `fa5583c` | `refactor(ai): AI 生成任务化改造，多任务队列替代全局单例` — 全部代码改动 |

上一版本基线：`df0ba59`。三个远端 `cnb/master`、`origin/master`、`wechat/master` 均已同步至 `73a4d02`。

## 版本概述

本次把 AI 生成从「全局单任务 + 阻塞式等待页」改造为「多任务队列 + 作品占位卡片」：
发起生成后立即返回可交互状态并在作品里落一条占位记录，多个任务各自独立推进互不覆盖，
成功转为真作品、失败留在作品里显示失败原因并可重试。此前「上一轮没跑完，主链路就被卡住、
且最终出的是上一张图的图纸」的问题不再出现。

另含三项配套修复：AI 占位作品的云同步豁免收口（原先会被永久钉成同步失败并反复重试）、
裁掉 AI 产物底部平台烙的「AI生成」标识带（否则会被降采样成珠子混进图纸与材料清单）、
首页入队反馈改为按钮就地成功态加轻震动。

## 本次修改说明

1. **新增任务持久化 `services/ai-task-store.ts`**：以数组形式持久化 `AiTask[]`（storage key `pindou-ai-tasks-v1`），替代原来只能存一个对象的单例会话；同时删除 `services/ai-generation-session.ts`。任务上限 20 条，终态任务保留 7 天（`pruneAiTasks()` 在冷启动时清理）。
2. **`ai-generation-manager.ts` 改为任务管理器 `AiTaskManager`**：内部持有 `Map<taskId, AiGenerationFlow>`，由单个 tick 调度器（4s）串行驱动轮询，`MAX_CONCURRENT = 2` 控制并发槽位、`QUEUE_MAX = 10` 控制排队上限；对外提供 `subscribeTask(taskId)` / `subscribeAll()`，页面按 `taskId` 绑定任务而不再依赖「全局唯一任务」。
3. **`ai-generation-flow.ts` 去掉自带定时器**：只暴露 `needsPoll()` / `pollOnce()` 由管理器串行调用；长时间等待提示改为按 `processingSince` 现算，避免 N 个任务各起一个 timeout。
4. **首页零阻塞**：发起 AI 生成后立即返回可交互状态，不再强制跳转等待页；可以连续发起多个任务。点生成的那一刻就在作品列表写入一条带原图封面的占位记录。
5. **作品页展示任务真实状态**：`pages/projects` 支持 AI 任务的进行中 / 失败 / 完成三态卡片，提供查看进度、重试、取消（= 删除任务）操作。
6. **AI 生成页改为任务详情页**：沿用 `packages/ai-generation`，通过 `?taskId=` 绑定具体任务，不新建页面。
7. **生命周期自愈**：补齐冷启动自愈、切后台回前台追赶（`app.onShow` → `aiTaskManager.onAppShow()`，因为小程序切后台后 JS 会被挂起、定时器不可靠）、15 分钟超时自动判失败，以及旧会话到任务队列的数据迁移。
8. **任务与作品单向对齐**：所有状态先落到 `AiTask`，再由管理器的 `applyTaskToWorkItem()` 对齐到 `WorkItem`，这是两者唯一的对齐点，避免各自演化。
9. **AI 占位作品豁免云同步，判定收口到 `resolveSyncFields()`**：`ai_pending` / `ai_failed` 的作品一律以 `syncStatus: 'guest'` 存本机。否则登录态下会进待同步队列，而占位作品没有 draft，`work-sync-service` 必然报「作品图案数据不完整」并把它标成同步失败；只有任务成功才重新落为 `pending`。这条规则的唯一实现处是 `models/pattern.ts` 的 `resolveSyncFields()`，`saveWork` / `adoptGuestWorks` / `markSyncStatus` 三个写入口统一调用，读取侧 `getSyncCandidates()` 再加一道占位过滤兜底。
10. **输入图永久化 + 孤儿清理**：把 AI 输入图落到小程序永久目录，避免临时文件被清理后封面丢失；`pruneAiTaskImages()` 在冷启动时清理「无任何任务引用且文件名时间戳超 7 天」的孤儿图片，避免永久目录无限膨胀。
11. **修复占位作品被永久钉成同步失败**：`markSyncStatus()` 原先没有 AI 豁免，同步服务对缺 draft 的作品回写 `failed` 时会给占位作品盖上 `ownerId`，导致它每次同步都被捞起重试、每次再写回 `failed`，错误文案常驻 UI。现已免疫该回写。
12. **裁掉 AI 产物底部的平台标识带**：混元生图（AR 链路）会在产物底部烙上「AI生成」显式标识（实测文字上沿在距底边约 9.5% 图高处），而拼豆图纸按像素降采样，标识会被采样成一格格珠子混进成品图、施工图与材料清单。新增 `image-service.stripAiWatermarkBand()` 裁掉底部 12% 再落盘，裁切放在**下载那一步**以保证一个任务只裁一次；解码或导出失败一律回退原图，不阻断生成链路。
13. **首页入队反馈改为按钮就地成功态 + 轻震动**：原先只弹居中 toast（`icon: 'none'`、无图标、无触觉），而用户此刻的视线与手指都在底部按钮上，感知很弱；紧随的 `resetUploadState()` 又让页面看起来像操作被撤销。改为震动 + 主按钮原地变成功态，1.8s 后自动复位（成功反馈必须等 `submitting` 复位后再给，否则按钮仍 disabled，样式会被 `.home__submit[disabled]` 压掉）。
11. **限流自动退避重试**：提交阶段收到 `RATE_LIMITED` 不再直接判失败，而是按 15s / 30s / 60s 退避重试且复用同一 `idempotencyKey`（不会重复扣次数），超过 3 次才判失败；网络类错误按 8s / 15s / 30s 退避，重试上限 `MAX_RETRY_COUNT = 3`。

## 影响范围

- 小程序主包：`services/ai-task-store.ts`（新增）、`services/ai-generation-manager.ts`、`services/ai-generation-flow.ts`、`services/ai-generation-service.ts`、`services/image-service.ts`、`models/pattern.ts`、`store/app-store.ts`、`app.ts`
- 小程序页面：`pages/home`、`pages/projects`、`packages/ai-generation`（含各自的 wxml / wxss）
- 删除文件：`services/ai-generation-session.ts`
- 新增测试：`test/work-sync/`（AI 占位作品不上云的不变式测试，12 例，含变异验证）
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
6. **水印裁切会让构图轻微下移**：1024×1024 裁成 1024×901 后，`calculateCenterCrop` 按正方形目标会再左右各丢约 6%，等于画面轻微推近、构图下移一点点。
7. **历史作品不受水印裁切影响**：老草稿的 `cells` 里已经存了标识珠子，只有重新生成才会干净。
8. **法规要求 AI 生成内容带显式标识**，本次只是把平台标识从图纸里挤出去，**未补自有标识**。是否在导出件上补一个自己的「AI生成」标识属产品决策，尚未做。

## 发布前置条件

1. 本地类型检查归零：`tsc --noEmit` ✅（已通过，0 报错）
2. 拼豆图生成测试全部通过：`node test/pattern-generation/run-tests.js` ✅（已通过，57/57）
3. 作品同步不变式测试通过：`node test/work-sync/run-tests.js` ✅（已通过，12/12）
4. 版本号一致：`package.json`、`package-lock.json` 均为 `0.30.10` ✅
5. 变更已同步推送 `cnb/master`、`origin/master`、`wechat/master` ✅（三端 HEAD 均为 `73a4d02`）
6. 本次不改服务端，**无需部署后端**；如同一批次还包含服务端改动，则按 0.30.9 流程先构建镜像并跑 Jenkins 流水线。
7. 清除微信开发者工具缓存后重新编译，确认小程序版本显示为 `0.30.10`。

## 提审验收重点

1. **零阻塞主链路**：连续发起 3 个 AI 任务都能立即返回首页，首页生成按钮不被锁死。
2. **多任务互不干扰**：任务 A 进行中发起任务 B，两者各自推进；A 完成后出的是 A 的图，不会串成 B（对应原缺陷）。
3. **占位卡片三态**：作品列表即时出现占位记录；生成中显示进行中、失败显示失败原因且可重试、成功后转为真作品。
4. **取消 / 删除任务**：删除占位卡片能真正停掉后台轮询，不会再自动复活。
5. **生命周期恢复**：杀掉小程序冷启动、切后台 5 分钟再回前台，任务都能续上。
6. **旧版本升级**：由 0.30.9 升级后，旧的 `pindou-ai-generation-session-v1` 会话能迁移为任务，不至于丢失进行中的任务。
7. **并发上限**：同时发起 3 个任务时前 2 个执行、第 3 个排队（created 态等待槽位）。
8. **登录态回归**：登录用户下 AI 占位作品不被塞进云同步队列、不报「作品图案数据不完整」；**且不会被反复重试**（`markSyncStatus` 的回写不得把它钉成 `failed`，UI 上不残留同步失败文案）。
9. 失败不扣次数（含限流重试复用同一 `idempotencyKey`）；失败文案可读，可切换标准模式继续。
10. **AI 产物无平台标识混进图纸**：成品图、施工图与材料清单里不应出现平台的「AI生成」字样珠子；失败时（解码/导出异常）应回退原图而不是中断生成。
11. **首页入队反馈**：点「开始生成」后主按钮就地变成功态并轻震，1.8s 后复位，不再弹居中 toast；按钮 disabled 期间不得提前显示成功态。
12. 确认日志与接口响应中不含服务端 API Key 或模型返回的原始临时 URL。

## 检查记录

- [x] 根目录类型检查：`tsc --noEmit`（0 报错）
- [x] 根目录拼豆图生成测试：`node test/pattern-generation/run-tests.js`（57/57 通过）
- [x] 作品同步不变式测试：`node test/work-sync/run-tests.js`（12/12 通过，已做变异验证）
- [x] 服务端类型检查（本次不改服务端，无回归）
- [x] 版本号一致：`package.json` / `package-lock.json` 均为 `0.30.10`
- [x] 待提交 diff 审查：无遗留调试代码、无新增 TODO/FIXME（新增 10 处 `console.*` 均为错误分支日志）
- [x] 变更已同步推送 `cnb/master`、`origin/master`、`wechat/master`（三端 HEAD 均为 `73a4d02`）
- [ ] 真机验收 T1–T20（重点 T3 杀 App 恢复、T4 切后台 5 分钟、T9 旧版本升级迁移）
- [ ] iPhone、Android 真机验证（多任务并发、占位卡片三态、任务详情页）
- [ ] 小程序端值与交互验收（首页零阻塞、入队按钮成功态、作品页卡片操作）
- [ ] 真机确认 AI 产物不再混进平台「AI生成」标识，且构图下移在可接受范围
- [ ] 真机确认登录态下 AI 占位作品不被反复重试、UI 无残留同步失败文案
