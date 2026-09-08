# 小程序 0.25.15 提交信息

## 版本号

`0.25.15`

## 提交信息

`fix: resolve profile work count display and refresh icons (v0.25.15)`

## 本次修改说明

1. **修复“我的”Tab作品数与统计项显示为0**
   - 修复在登录态下空值合并运算符（`??`）导致云端 0 值覆盖本地有效作品数的问题；统一聚合本地作品与云端作品，确保与“我的作品”列表页完全对齐。
   - 个人中心页面增加全局 `appStore` 订阅，实现作品保存或删除时实时更新。
   - 页面激活（`onShow`）时主动刷新用户 Profile，确保最新的云端作品数与额度及时同步。

2. **首页重新选择图片按钮图标替换**
   - 修复原按钮由于引入带有底色背景的 SVG 并使用 `filter: brightness(0) invert(1)` 导致在微信真机及开发者工具中渲染为实心纯白方块的问题。
   - 新增专用的纯白循环刷新矢量图标 `miniprogram/assets/icons/image-reselect.svg`，移除 CSS filter 滤镜 hack，确保图标在绿色背景上清晰锐利展示。

3. **底部导航栏“作品”Tab 图标替换**
   - 将 `miniprogram/assets/icons/projects.svg`（未选中态 #8A908C）与 `miniprogram/assets/icons/projects-active.svg`（选中态 #12B466）替换为全新的作品收纳包/百宝箱矢量设计，与主导航栏及作品结果页底部导航无缝对齐。

4. **“我的”Tab“隐私设置”菜单图标替换**
   - 新增 `miniprogram/assets/icons/profile-menu-settings.svg` 齿轮设置矢量图标（颜色 #626573，描边 1.8），替换原盾牌图标，与其它个人中心菜单项视觉风格保持一致。

## 影响范围

- 个人中心（`miniprogram/pages/profile`）
- 首页上传状态卡（`miniprogram/components/upload-status-card`）
- 主底部导航栏组件（`miniprogram/components/main-tab-bar`）与结果页底部导航栏（`miniprogram/pages-sub/result`）
- 个人中心页面配置（`miniprogram/config/profile.ts`）

## 验证项

- [x] TypeScript 类型检查通过（`npm run typecheck`）
- [x] 图案生成单元测试通过（`npm run test:pattern`）
- [x] 代码复杂度与过度设计审查完成（`ponytail-review` 审查通过）
- [ ] 微信开发者工具重新编译并预览确认三大图标展示正常
