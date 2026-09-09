# 小程序 0.25.20 提交信息

## 版本号

`0.25.20`

## 建议提交信息

`release: v0.25.20 优化下载配额动态展示、个人中心设置入口与主导航交互`

## 提审版本说明

1. 优化每日免费下载额度动态化展示，实时同步服务端配额口径，提升数据一致性。
2. 优化“我的”页面功能布局，新增设置二级页面，聚合帮助、反馈、隐私及关于入口，页面更简洁清晰。
3. 优化底部主导航栏层叠交互与深色模式适配，避免页面滚动内容穿透。

## 本次修改说明

1. **下载额度动态化**：
   - “我的”页权益卡、下载记录页（`pages-sub/downloads`）及生成结果页配额条（`download-quota-bar`）解除 9 次硬编码，动态绑定服务端下发的每日配额，离线与未登录时安全回退。
2. **个人中心与设置重构**：
   - 新增分包页面 `pages-sub/settings/index`，收敛使用帮助、意见反馈、隐私设置、关于我们四个二级入口。
   - 个人中心布局重构为 2×2 宫格（我的作品、我的收藏、下载记录、设置），删除废弃的未登录冗余图标与无用统计计算。
3. **主导航栏交互与层叠体验**：
   - 优化 `page-layout` 内嵌 TabBar 逻辑，主 Tab 页面统一由微信系统自定义 TabBar 承载，解决双重底栏重叠问题。
   - 提高 `main-tab-bar` z-index 并提供不透明底色与深色模式适配，防止页面滚动穿透。

## 影响范围

- 个人中心与分包设置页：`miniprogram/pages/profile/`、`miniprogram/pages-sub/settings/`
- 配额组件与展示页：`miniprogram/pages-sub/components/download-quota-bar/`、`miniprogram/pages-sub/downloads/`、`miniprogram/pages-sub/result/`
- 基础布局与导航：`miniprogram/components/main-tab-bar/`、`miniprogram/components/page-layout/`
- 配置与状态管理：`miniprogram/app.json`、`miniprogram/store/app-store.ts`、`package.json`、`project.config.json`

## 验证项

- [x] TypeScript 类型检查通过（`npm run typecheck`）
- [x] 图案生成单元测试通过（`npm run test:pattern`；54 项全过）
- [x] 服务端集成测试通过（`server` 中 `npm test`；116 项通过）
- [x] 代码复杂度与过度设计审查完成（`ponytail-review`；精简冗余代码，无过度设计）
- [ ] 微信开发者工具中验证：
  1. 打开“我的”页面，确认权益卡片与 2×2 宫格展示正常；
  2. 点击“设置”，确认正常跳转二级设置列表，且各项子页面能正常打开；
  3. 切换主 Tab，确认底部导航栏无重叠、无内容穿透。
