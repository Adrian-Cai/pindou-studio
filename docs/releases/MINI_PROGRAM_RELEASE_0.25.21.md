# 小程序 0.25.21 提交信息

## 版本号

`0.25.21`

## 建议提交信息

`release: v0.25.21 重构「我的」页面信息架构与视觉层级`

## 提审版本说明

1. 重构「我的」页面，明确区分未登录和已登录两种状态，大幅简化页面信息层级，提升体验一致性。
2. 已登录状态新增 2×2 功能宫格（我的作品、我的收藏、下载记录、设置），取代旧版统计卡与长列表菜单。
3. 新增设置二级聚合页，收敛使用帮助、意见反馈、隐私设置、关于我们四个入口。
4. 精简未登录状态页面，仅保留登录核心 CTA，移除冗余说明文案。

## 本次修改说明

1. **未登录状态重构**：
   - 新设计仅展示品牌插画、主标题（"登录后使用更多功能"）、微信登录按钮和协议 inline checkbox，大量留白。
   - 移除旧版未登录状态下展示的副标题、底部协议文字链、权益卡、统计区域及功能菜单。
   - 保留协议同意（`loginAgreementAccepted`）、登录 loading/error 状态、登录状态恢复等全部业务逻辑。

2. **已登录状态重构**：
   - 用户卡精简为「头像 + 昵称 + 右箭头」单行，点击进入账号面板（含编辑资料、刷新账号、退出登录）。
   - 权益卡重构为紧凑单行：左侧展示今日剩余次数（真实 `downloadQuota` / `dailyFreeDownloadQuota`），右侧「获取更多次数」按钮触发充值面板。
   - 替代旧版统计卡（作品数 / 下载数 / 收藏数）和五项长菜单列表，改为 2×2 功能宫格。

3. **设置聚合页新增**：
   - 新增 `pages-sub/settings/index`，聚合使用帮助、意见反馈、隐私设置、关于我们四个子页入口。
   - 各子页页面（`help` / `feedback` / `privacy` / `about`）保留不变，仅新增导航入口。

4. **旧代码清理**：
   - 删除 `index.ts` 中 `menuItems`、`workCount`、`favoriteCount`、`downloadCount` 等仅服务于旧 UI 的 data 字段和计算逻辑。
   - 删除 `index.wxss` 中 `profile-stats`、`profile-menu`、`benefit-card__beads` 等废弃 CSS（约 50 行）。
   - 删除 `login-sheet.wxss` 中 `.login-benefits` / `.login-benefit` 相关 4 行死代码。

## 影响范围

- 个人中心主页面：`miniprogram/pages/profile/`（index.ts / index.wxml / index.wxss / login-sheet.wxss）
- 新增设置聚合页：`miniprogram/pages-sub/settings/`（index.ts / index.wxml / index.wxss / index.json）
- 路由注册：`miniprogram/app.json`
- 版本号：`package.json`

**不影响范围**：
- 所有子页面（downloads / favorites / help / feedback / privacy / about）
- auth-store / app-store / services / models
- 后端接口与业务逻辑

## 验证项

- [x] TypeScript 类型检查通过（`npm run typecheck`，exit 0）
- [x] 代码复杂度与过度设计审查完成（`ponytail-review`；无过度设计，Lean）
- [ ] 微信开发者工具中验证：
  1. **未登录**：页面仅展示插画 + 标题 + 协议 checkbox + 微信登录按钮，不展示权益/作品/收藏/下载记录；
  2. **已登录**：用户卡正常展示昵称，点击进入账号面板；权益卡展示真实剩余次数，非硬编码；2×2 宫格各入口跳转正常；
  3. **设置**：点击「设置」正常跳转 `pages-sub/settings`，四个子入口全部可访问；
  4. **充值面板**：点击「获取更多次数」打开充值 Sheet，充值逻辑完整；
  5. **协议合规**：未登录状态下，未勾选协议点击登录时出现 toast 提示；
  6. **TabBar**：Sheet 打开时 TabBar 隐藏，关闭后恢复。
