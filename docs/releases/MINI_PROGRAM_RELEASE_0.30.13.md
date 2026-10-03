# 小程序 0.30.13 提审说明

> 状态：代码已落地，`tsc --noEmit` 0 报错，拼豆图生成用例 57/57、作品同步用例 19/19 通过。
> **本次无需改动云函数与服务端**，不必重新部署后端。
> 0.30.10 的真机验收 T1–T20**仍未执行**（本次未覆盖），正式提审前必须补跑。

## 版本号

`0.30.13`

## 本次内容

首轮全量 AI 代码扫描（`open-code-review`，269 条发现 / 118 个文件送审）的修复批次。
按业务域拆 6 个提交：

| 提交 | 说明 |
| --- | --- |
| `108b762` | `ci: 集成 OpenCodeReview 到 GitHub Actions PR 评审` — 工作流 + 19 条项目评审规则 |
| `5290734` | `fix(miniprogram): 修复图纸生成的空候选与边缘检测归一化问题` |
| `53088bd` | `fix(ai): 修复 AI 迁移顺序与终态任务 TTL 起算点` |
| `860bc06` | `fix(auth): 恢复持久化头像并保证 quota 字段齐全` |
| `70d3865` | `fix(payment): 幂等键改为按购买意图生成并在重试时复用` |
| `fbb1427` | `fix(miniprogram): 收敛异步异常兜底与页面健壮性问题` |
| `4e8a154` | `test(miniprogram): 跟进 pickNearest 重构并保留 V1 行为基线` |
| `f02eda2` | `chore(git): 忽略测试临时产物并归档首轮 AI 扫描处置清单` |
| `abc2668` | `fix(miniprogram): 修正云端作品读取的调用顺序并补齐所属判定的前置说明` |
| `2345066` | `release: v0.30.13 AI 扫描首轮修复与 OCR CI 集成` |

上一版本基线：`2983731`（0.30.12 提审说明收尾）。

## 本次修改说明

### 1. 图纸生成 · 空候选静默返回 undefined

`color-utils.ts` 的 `findNearestColor` 在调色板为空时，`best` 停在初始值、`forEach` 循环体
一次都不执行，于是函数**返回 `undefined`** —— 而它的类型签名写的是 `RGB`。这种「类型上合法、
运行时是 undefined」的返回值会一路流到绘制或材料清单才崩，崩点离根因极远。

抽出 `pickNearest(items, distance)`，统一规定**候选为空即抛错**，让失败停在最近的地方；
`findNearestColorOklab` / `findNearestColorIndexOklab` 同样补前置校验（返回下标 0 属于
「合法但错误」的值，不能当兜底用）。`palette-selector` 的 `findNearestMardColor` 改为复用。

### 2. Sobel 归一化系数错误

`edge-detector.ts` 原来把梯度除以 4，而两个方向合成的幅值上限是 √32≈5.66 —— 除数比真实上限
小了三成多，稍强一点的边缘统统饱和到 1，输出退化成近乎二值的 0/1，**丢掉了「保护轮廓」所需的
强度层次**。改为 `/√32`。

同步修掉两个相关问题：透明格原先亮度留在 0（“纯黑的不透明格”与“透明格”数值上无法区分），
会让亮画面的透明边界算出巨大梯度、反倒被当成强边缘保护起来，正好与设计目标相反 —— 现在透明格
单独标记 `opaque` 且不参与计算；邻域含透明格时按覆盖率折算，抑制「画面↔无画面」的伪边缘。

### 3. AI 任务迁移顺序错误（会丢任务）

`migrateLegacyAiSession` 原本的顺序是**先打迁移标记 → 再删旧会话 → 最后才建新任务**。
中间任何一步崩掉，结果都是「旧数据没了、新任务没建成、标记还挡着下次重试」——用户的在跑任务
**静默丢失**且永远无法恢复。

改为 **先建新任务 → 再删旧会话 → 最后打标记**；建任务失败时保留原会话、不打标记，下次冷启动
还能再迁一次。

### 4. 终态任务 TTL 起算点错误

过期清理按 `createdAt` 计算。一个很早提交、刚刚才跑完的任务会因为创建时间超期被立刻清掉，
**用户还没来得及看结果卡片就没了**。改为按 `finishedAt` 起算（`createdAt` 兜底）。

### 5. 持久化头像永远被清成 null

`token-storage.ts` 的 `parseUser` 写死 `avatarUrl: null`，从不读 `value.avatarUrl`，
于是冷启动从 storage 恢复的会话会丢掉用户已保存的头像。修复并与 `auth-service` 的解析口径
保持一致。`models/auth.ts` 补文档明确不变式：`CurrentUserProfile` 的 `quota` 与
`quota.aiGeneration` 一定存在且字段齐全，读取侧不必再加可选链。

### 6. 支付幂等键每次调用都重生成（去重失效）

`payForAiGenerationPackage` 原本在函数内部用默认参数现场生成 idempotency key。
同一次点击走到两次（或页面重进入），服务端就看到两个不同的键，判成两笔订单 —— **去重完全失效，
重复下单即重复扣款**。

改为必须由调用方按「一次购买意图」生成并持有：`recharge` 页把键存进页面状态，失败重试复用同一个，
支付成功或用户主动取消才清空。同时补幂等键非空校验。

### 7. 云端作品读取的调用顺序错误（作品会跑到游客区）

`AppStore.setCurrentDraft` 内部靠「`cloudWorks` 里有没有同 id 的云端记录」来判定这份草稿的归属：
有则是云草稿，没有就落到 `persisted.guest`。收藏页原先的顺序是**先 `setCurrentDraft` 再 `saveWork`**——
判定时这份云作品在 `cloudWorks` 里还不存在，于是被当成游客草稿存进游客区。结果是
**用户账号下凭空少一份作品、游客区多一份脏数据，整条链路零报错**。

改为 **先 `saveWork` 落 WorkItem，再 `setCurrentDraft`**，并在 `setCurrentDraft` 上写明这条
前置条件，避免后续调用点重蹈覆辙。编辑器页与作品页的同类调用一并核正。

### 8. 其余健壮性收敛

- `app.ts` 新增 `runStartupSafelyAsync`：原来的 `runStartupSafely` 只接同步抛出，
  fire-and-forget 的启动项 reject 后只剩一条无堆栈的 Unhandled rejection，掩盖真实原因。
- `navigation` / `page-layout` 对 `getWindowInfo`、`getMenuButtonBoundingClientRect` 的返回值做兜底。
- `download-service`、`image-service`、`payment-service` 等补齐空值与日期校验。

## 影响范围

- 小程序主包：`app.ts`、`config/api.ts`、`models/auth.ts`、`store/auth-store.ts`、`utils/navigation.ts`
- 小程序服务层：`ai-generation-*`、`ai-task-store`、`auth-service`、`session-service`、
  `token-storage`、`payment-service`、`download-service`、`image-service`、`pattern-generation/*`
- 小程序分包：`account`、`payment`、`result`、`editor`
- 页面：`pages/profile`
- 测试：`test/pattern-generation/`（3 个用例跟进重构）
- 版本：`package.json`、`package-lock.json` 均为 `0.30.13`
- CI（不影响小程序产物）：`.github/workflows/ocr-review.yml`、`.opencodereview/rule.json`

**不影响范围：**

- 云函数与服务端（本次两端均无改动）
- 云端数据格式与接口契约（本次全为客户端缺陷修复）

## 已知限制

1. **扫描清单的处置结果未逐条回填**：`docs/development/OCR_SCAN_FIX_LOG_2026-09-23.md` 里
   269 条的「处置」列目前仍多为「待定」。本次只修了确认是真缺陷的一类，其余需要结合业务判断
   逐条裁定（误报 / 有意设计 / 降级）。这是下一步的待办，不是本次的遗漏。
2. **`pickNearest` 是行为变更**：候选为空时从「静默返回 undefined」改为「抛错」。调用方若依赖
   旧行为需要显式处理空集合。当前生产调用点的输入均来自内置调色板常量，非空。
3. **Sobel 归一化变更会改变边缘强度数值**：从「饱和到 1」恢复成有层次的小数。下游
   `EDGE_PROTECTION_THRESHOLD`（0.02）按新刻度重新核对过，V1 行为基线与边缘保护用例均通过。
4. 0.30.10 遗留的真机验收 T1–T20 **仍未执行**，本次未覆盖。

## 发布前置条件

1. 本地类型检查归零：`npx tsc --noEmit --pretty false --incremental false` ✅（0 报错）
2. 拼豆图生成测试全部通过：`node test/pattern-generation/run-tests.js` ✅（57/57）
3. 作品同步不变式测试通过：`node test/work-sync/run-tests.js` ✅（19/19）
4. 服务端类型检查 ✅（本次不改服务端，无回归）
5. 版本号一致：`package.json`、`package-lock.json` 均为 `0.30.13` ✅
6. 变更同步推送：`cnb/master`、`origin/master`、`wechat/master` ✅（三端一致）

> 注意：`tsc` 的**增量缓存会给出假阳性**——同一份代码连续三次可能报出不同的错误。
> 判断是否真有错请加 `--incremental false`。

## 提审验收重点

1. **AI 生成完成后结果可见性**：发起 AI 生成并等到完成，结果卡片应停留在作品页足够久，
   不会刚生成完就被清理掉（对应 TTL 起算点修复）。
2. **旧版本升级的任务迁移**：用有在跑 AI 任务的旧版本覆盖安装到 0.30.13，冷启动后任务应
   正常续接，不出现「任务消失且无法恢复」。
3. **头像保留**：登录后设置头像，杀掉小程序重新冷启动，头像应仍在（对应持久化头像修复）。
4. **支付不重复扣款**：进入充值页购买，第一次支付失败后在同一页面重试，服务端不应产生两笔订单。
   这是本次资金安全相关度最高的一条，建议重点验证。
5. **云端作品归属正确**：从收藏页打开一个已同步的云端作品，查看作品页应出现在当前账号下，
   游客区不应多出一份同名作品（对应调用顺序修复）。
6. **图纸生成回归**：拼豆图生成的取色与边缘保护结果应与升级前一致（V1 行为基线 57/57 已覆盖，
   真机上再确认一次观感）。

## 检查记录

- [x] 根目录类型检查：`tsc --noEmit --incremental false`（0 报错）
- [x] 根目录拼豆图生成测试：`node test/pattern-generation/run-tests.js`（57/57 通过）
- [x] 作品同步不变式测试：`node test/work-sync/run-tests.js`（19/19 通过）
- [x] 服务端类型检查（本次不改服务端，无回归）
- [x] 版本号一致：`package.json` / `package-lock.json` 均为 `0.30.13`
- [x] 待提交 diff 审查：无遗留调试代码、无新增 TODO/FIXME
- [x] 临时排查文件已清理，工作区干净
- [x] 变更已同步推送 `cnb/master`、`origin/master`、`wechat/master`（三端一致）
- [ ] 真机验收 T1–T20（0.30.10 遗留，重点 T3 杀 App 恢复、T4 切后台 5 分钟、T9 旧版本升级迁移）
- [ ] 支付幂等专项：同一次购买意图重复重试不应产生两笔订单
- [ ] 云端作品归属专项：收藏页打开云作品不应落到游客区
- [ ] 冷启动头像保留验证
- [ ] iPhone、Android 真机验证（AI 生成结果留存、图纸生成观感）
- [ ] 扫描清单 269 条逐条裁定并回填「处置」列（下一步）
