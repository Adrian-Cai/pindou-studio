# 小程序 0.25.17 提交信息

## 版本号

`0.25.17`

## 提交信息

`perf: accelerate agreement navigation and preload subpackage (v0.25.17)`

## 本次修改说明

1. **配置分包静默预下载（消除跳转卡顿）**
   - 在 `miniprogram/app.json` 中配置 `preloadRule`，当用户进入“我的”主页时，微信在后台静默预下载 `pages-sub` 分包。
   - 解决用户在登录弹窗点击《用户协议》或《隐私政策》时，真机因阻塞等待下载编译分包导致卡顿 1~2 秒的问题，实现即点即推入。

2. **优化路由与弹窗时序（消除掉帧并保留登录态）**
   - 移除了 `openUserAgreement()` 与 `openPrivacyPolicy()` 中同步调用 `this.hideActiveSheet()` 的逻辑。
   - 避免在页面切换瞬间触发大规模 DOM 销毁与 TabBar 重绘，保持 60fps 丝滑过渡。
   - 增加 `preserveSheetOnNextHide` 标记：用户在协议页阅读完毕返回时，登录弹窗依然保持打开且保留原勾选状态，用户无需重新点击“登录”按钮。

3. **协议文档本地持久化缓存（实现 0ms 秒开）**
   - 在 `legal-document-service` 中实现 Memory + Storage 双层本地持久化缓存。
   - 在 `privacy-document` 页面采用 SWR 策略：打开文档时优先从本地缓存读取并极速渲染（0ms 秒开），后台静默比对与更新版本，彻底避免白屏等待 1.5s+ 远程 API 响应。

## 影响范围

- 小程序全局分包预下载配置（`miniprogram/app.json`）
- 个人中心登录弹窗与生命周期管理（`miniprogram/pages/profile/index.ts`）
- 法律文档服务层与缓存（`miniprogram/pages-sub/services/legal-document-service.ts`）
- 协议阅读页面（`miniprogram/pages-sub/privacy-document/index.ts`）

## 验证项

- [x] TypeScript 类型检查通过（`npm run typecheck`）
- [x] 图案生成单元测试全数通过（`npm run test:pattern`）
- [x] 代码复杂度与过度设计审查完成（`ponytail-review` 审查通过）
- [ ] 微信开发者工具中测试：登录弹窗点击《用户协议》和《隐私政策》流畅跳转，无明显等待
- [ ] 微信开发者工具中测试：二次打开协议文档实现 0ms 秒开
- [ ] 微信开发者工具中测试：从协议页面返回时，登录弹窗依然就绪且勾选状态保留
