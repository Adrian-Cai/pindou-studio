# 小程序 0.30.11 提审说明

> 状态：代码已落地，`tsc --noEmit` 0 报错，拼豆图生成用例 57/57、作品同步用例 12/12 通过。
> **本次含云函数改动**：`cloudfunctions/generateImage` 必须在微信云开发重新部署，否则水印文案不生效。
> **0.30.10 的真机验收 T1–T20 仍未执行**（本次未覆盖），正式提审前必须补跑。

## 版本号

`0.30.11`

## 本次提交（HEAD `27617fb`）

| 提交 | 说明 |
| --- | --- |
| `d685802` | `release: v0.30.11 生图角标改为品牌名、首页入队横条与启动容错` — 版本号、CHANGELOG、提审说明 |
| `27617fb` | `docs(releases): 归档 0.25 / 0.28 历史提审说明` |
| `6f7abdd` | `fix(miniprogram): 启动项逐项容错,避免单点异常中断后续初始化` — app.ts |
| `90b476d` | `feat(ai): 用顶部横条通知替换首页生成中胶囊` — pages/home 三件套 + ai-generation-manager |
| `da175a6` | `feat(cloudfunctions): 生图角标文案改为「小露拼豆」` — generateImage 云函数 |

上一版本基线：`753582a`（0.30.10 提审说明收尾）。

## 版本概述

本次三件事：把 AI 产物右下角的角标从平台默认的「AI生成」换成自家小程序名「小露拼豆」；
把首页常驻的「生成中 N 个」胶囊换成入队成功后滑出、4 秒自动收起的顶部横条；
顺手修掉启动期一个隐患——`hydrate()` 或 AI 任务调度初始化一旦抛错，后面所有启动项都不会执行。

另归档了一批历史提审说明（`docs/releases` 只留 0.29 及以后），这些文件仍在 git 历史里。

## 本次修改说明

1. **生图角标文案改为「小露拼豆」**：`cloudfunctions/generateImage/index.js` 新增常量 `IMAGE_FOOTNOTE`，在 `generateImage()` 里传 `footnote`。平台默认在产物右下角烙「AI生成」且**不支持关闭**——CloudBase 社区 issue #1317 中官方明确：按法规要求显式 + 隐式两个标识都必须加，SDK 只开放 `footnote`（自定义水印文案，上限 16 字符）。所以只能换文案，不能去掉。`footnote` 由服务端在生图时同步写入，不增加额外耗时。要改回含「AI 生成」字样（合规上更稳妥）只需改 `IMAGE_FOOTNOTE` 一个常量。
2. **首页入队提示改为顶部横条通知**：原胶囊是常驻计数，需要 `aiTaskManager.subscribeAll()` 订阅全量任务并在每次任务变化时刷新，入队后长期挂在页面上占位置。改为入队成功后从导航栏下方滑入的横条（`top` 由 ts 注入实测的导航栏高度，不硬编码顶部高度；`fixed` 定位，页面滚到哪都停在视口顶部），`QUEUE_TIP_DURATION = 4000` 后自动收起，点击跳「作品」页看进度。与主按钮就地成功态互补：按钮给指尖即时确认，横条告诉用户去哪看。首页不再订阅全量任务刷新计数；随之移除已无调用者的 `aiTaskManager.getActiveCount()`。`subscribeAll()` 保留——作品页仍用它刷新任务卡片。
3. **启动项逐项容错**：`onLaunch` 里原先只有 `initCloud()` 包了 `try/catch`，`appStore.hydrate()` 与 `aiTaskManager.init()` 任一抛错都会中断后续步骤——连 `wx.onNetworkStatusChange` 都注册不上，网络恢复后不再补同步。而 `onLaunch` 里同步抛错在真机上的表现跟网络故障完全一致、极难定位。现抽出 `runStartupSafely()` 逐项包裹，单项失败只降级该能力、不再牵连其他项。
4. **归档历史提审说明**：移出 `docs/releases` 下 0.25.7–0.25.21、0.28.0–0.28.2 共 19 个历史文件，只保留 0.29 及以后的提审说明与 CHANGELOG，避免历史版本说明与现行版本混列。

## 影响范围

- 云函数：`cloudfunctions/generateImage/index.js`
- 小程序主包：`app.ts`、`services/ai-generation-manager.ts`
- 小程序页面：`pages/home`（index.ts / index.wxml / index.wxss）
- 文档：`docs/releases/`（归档 19 个历史说明）、`docs/releases/CHANGELOG.md`
- 版本号：`package.json`、`package-lock.json` 均为 `0.30.11`

**不影响范围：**

- 服务端 AI Provider、任务表结构与配额模型（本次**无需服务端改动**，不必重新部署后端）
- 后端 AI 生图接口协议与返回字段
- 标准模式本地拼豆图生成算法、登录、支付与额度逻辑

## 已知限制（需产品/后端确认）

1. **角标文案不含「AI 生成」字样**：法规要求显式标识能体现 AI 生成属性，当前「小露拼豆」只是品牌名，严格说不达标。要稳妥可改为 `小露拼豆 AI生成`（9 字符，仍在 16 以内），改 `IMAGE_FOOTNOTE` 一个常量即可。若小程序界面已有 AI 声明，则属产品权衡。
2. **水印裁切仍开启**（0.30.10 引入的底部 12%），所以角标会被一起裁掉：图纸与材料清单干净，但成品图上也看不到品牌名。想让品牌名露出来，把 `miniprogram/services/image-service.ts` 的 `AI_WATERMARK_BAND_RATIO` 改成 `0` 即可（取 0 时走原图直通）。
3. **历史作品不受水印裁切影响**：老草稿的 `cells` 里已经存了标识珠子，只有重新生成才会干净。
4. 0.30.10 遗留的真机验收 T1–T20**仍未执行**，本次未覆盖（重点 T3 杀 App 恢复、T4 切后台 5 分钟、T9 旧版本升级迁移）。
5. 客户端 `MAX_CONCURRENT = 2` 仍为估计值，需与后端 `aiRateLimiter` 阈值对齐。
6. 失败态卡片仍无「重命名」入口（方案文档内表述不一致，待产品确认）。

## 发布前置条件

1. 本地类型检查归零：`tsc --noEmit` ✅（已通过，0 报错）
2. 拼豆图生成测试全部通过：`node test/pattern-generation/run-tests.js` ✅（已通过，57/57）
3. 作品同步不变式测试通过：`node test/work-sync/run-tests.js` ✅（已通过，12/12）
4. 版本号一致：`package.json`、`package-lock.json` 均为 `0.30.11` ✅
5. ⚠️ **在微信云开发重新部署 `cloudfunctions/generateImage` 云函数**（含依赖），否则角标仍是「AI生成」
6. 变更同步推送：`cnb/master`、`origin/master`、`wechat/master` ✅（三端均为 `e8067c1`）
7. 清除微信开发者工具缓存后重新编译，确认小程序版本显示为 `0.30.11`。

## 提审验收重点

1. **角标文案**：重新部署云函数后新生成的图，右下角角标应为「小露拼豆」而非「AI生成」；未重新部署则仍是旧的——这是本次最容易漏的一步。
2. **图纸无标识珠子**：成品图、施工图与材料清单里都不应出现任何角标文字珠子；生成失败（解码/导出异常）时应回退原图而不是中断生成。
3. **首页入队横条**：点「开始生成」后主按钮就地变成功态 + 轻震，同时顶部横条从导航栏下方滑入，4 秒后自动收起；点横条跳「作品」页；页面不再常驻「生成中 N 个」胶囊，也不再出现订阅不到导致计数不刷新的情况。
4. **启动健壮性**：本地作品数据恢复失败、或 AI 任务调度初始化失败时，小程序仍能正常起、首页可交互，且网络恢复后仍会补同步（确认 `onNetworkStatusChange` 已注册）。
5. **多任务回归**：连续发起 3 个任务仍互不串图，作品页占位卡片三态正常（移除 `getActiveCount` 不应影响任务本身推进）。
6. 确认日志与接口响应中不含服务端 API Key 或模型返回的原始临时 URL。

## 检查记录

- [x] 根目录类型检查：`tsc --noEmit`（0 报错）
- [x] 根目录拼豆图生成测试：`node test/pattern-generation/run-tests.js`（57/57 通过）
- [x] 作品同步不变式测试：`node test/work-sync/run-tests.js`（12/12 通过）
- [x] 服务端类型检查（本次不改服务端，无回归）
- [x] 版本号一致：`package.json` / `package-lock.json` 均为 `0.30.11`
- [x] 待提交 diff 审查：无遗留调试代码、无新增 TODO/FIXME
- [x] 变更已同步推送 `cnb/master`、`origin/master`、`wechat/master`（三端均为 `e8067c1`）
- [ ] **在微信云开发重新部署 `generateImage` 云函数**
- [ ] 真机验收 T1–T20（0.30.10 遗留，重点 T3 杀 App 恢复、T4 切后台 5 分钟、T9 旧版本升级迁移）
- [ ] iPhone、Android 真机验证（首页入队横条、角标文案、启动容错）
- [ ] 真机确认新生成的图纸里不再出现角标文字珠子
