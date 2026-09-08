# 小程序 0.25.16 提交信息

## 版本号

`0.25.16`

## 提交信息

`fix: resolve profile work count, network retry and optimize assets (v0.25.16)`

## 本次修改说明

1. **修复“我的”Tab作品数与统计项显示为 0**
   - 修复在登录态下空值合并运算符（`??`）导致云端 0 值覆盖本地有效作品数的问题；统一聚合本地作品与云端作品，确保与“我的作品”列表页完全对齐。
   - 个人中心页面增加全局 `appStore` 订阅，实现作品保存或删除时实时响应。
   - 页面激活（`onShow`）时主动刷新用户 Profile，确保最新的云端作品数与额度及时同步。

2. **修复图片安全检测与弱网上传**
   - 送审图片统一进行规格缩放与体积压缩（最长边 1024px，质量 0.8 JPEG），解决大图（3MB~15MB）直接上传导致网络传输超时与连接中断的问题。
   - Canvas 缩放异常时增加 `wx.compressImage` 自动降级保护。
   - 在 `http-client` 的 `apiUploadFile` 中保留微信原生 `err.errMsg` 并在 `ApiError.details` 中透传，便于排查底层原因。
   - 在 `content-security-service` 中针对纯网络断连（`NETWORK_ERROR`）增加 500ms 快速自动重试 1 次，大幅提升弱网环境下的成功率。
   - 本地作品同步（`syncLocalWorksToCloud`）中统一应用送审图片规格处理。

3. **图标与交互优化**
   - 首页重新选择图片按钮图标替换为纯白循环刷新矢量图标 `image-reselect.svg`，解决原 SVG 在小程序内渲染为纯白方块的问题。
   - 底部导航栏“作品”Tab 图标替换为全新作品收纳包矢量设计（`projects.svg` / `projects-active.svg`）。
   - “我的”Tab“隐私设置”菜单图标替换为齿轮设置矢量图标（`profile-menu-settings.svg`）。

## 影响范围

- 个人中心（`miniprogram/pages/profile`）
- 内容安全检测与图片服务（`miniprogram/services/content-security-service.ts`、`image-service.ts`、`http-client.ts`）
- 本地作品同步服务（`miniprogram/pages-sub/services/local-work-sync.ts`）
- 首页上传状态卡（`miniprogram/components/upload-status-card`）
- 主底部导航栏组件（`miniprogram/components/main-tab-bar`）与结果页底部导航栏（`miniprogram/pages-sub/result`）
- 个人中心页面配置（`miniprogram/config/profile.ts`）

## 验证项

- [x] TypeScript 类型检查通过（`npm run typecheck`）
- [x] 图案生成单元测试通过（`npm run test:pattern`）
- [x] 代码复杂度与过度设计审查完成（`ponytail-review` 审查通过）
- [ ] 微信开发者工具中测试：已有作品时进入“我的”Tab，作品数正确显示为 1
- [ ] 微信开发者工具中测试：大图上传检测成功率与重试体验
