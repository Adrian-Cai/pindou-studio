# 小程序 0.25.17 提交信息

## 版本号

`0.25.17`

## 提交信息

- `6184168` `perf: accelerate agreement navigation and preload subpackage (v0.25.17)`（已推送）
- 本版本补充修正（待提交，建议信息）：`fix(miniprogram): harden agreement navigation and document cache (v0.25.17)`

## 本次修改说明

1. **配置分包预下载（降低首次跳转等待）**
   - 在 `miniprogram/app.json` 中为 `pages/profile/index` 配置 `preloadRule`，用户进入“我的”页面后，微信在后台异步预下载 `pages-sub` 分包（源码约 218KB / 63 文件）。
   - 解决此前真机上该版本内首次进入任意分包页面时，需要现场下载并注入分包导致的明显等待。
   - 已知边界：预下载在页面渲染之后才发起，用户进入“我的”后立刻点击时分包可能仍在下载中；它只作用于“该版本内首次进入分包页面”，已进过编辑器/收藏等页面的用户本就没有下载等待。`network` 设为 `all`，蜂窝网络下同样预下载，因为编辑器属于核心流程。

2. **优化路由与弹窗时序（保留登录流程）**
   - 移除 `openUserAgreement()` 与 `openPrivacyPolicy()` 中跳转前同步调用 `this.hideActiveSheet()` 的逻辑。
   - 增加 `preserveSheetOnNextHide` 标记（在 `onHide` 中一次性消费）：用户从协议页返回时，登录弹窗仍保持打开且协议勾选状态不变，无需重新点开登录。
   - 实际收益是避免弹窗销毁与 TabBar 唤回出现在推入动画期间造成的视觉闪回，并保证登录闭环不被打断。
   - `wx.navigateTo` 增加 `fail` 回调复位该标记：跳转失败时 `onHide` 不会触发，若不复位，下一次真正的页面隐藏（切后台、切 Tab）会跳过关闭逻辑，导致弹窗与隐藏态 TabBar 悬挂。
   - 两个入口统一转调 `openLegalDocument(key)`；wxml 的 `catchtap` 绑定关系不变。

3. **协议文档本地缓存（缓存优先 + 后台校验）**
   - 在 `legal-document-service` 中增加内存 + 本地存储双层缓存，`privacy-document` 页面采用 stale-while-revalidate：命中缓存时先渲染本地内容，随后仍会请求接口。
   - 网络返回后仅当 `version` 或 `content` 与当前已渲染内容不同时才重渲染，避免整段富文本二次重排与滚动位置跳动。`version` 与 `effectiveAt` 元数据定义于 `server/src/modules/legal/legal-document-service.ts`，正文定义于 `server/src/modules/legal/legal-document-content.ts`；文档内容变更时约定同步更新版本元数据。比较 `content` 用于兜住漏改版本的情况。
   - 生效日期不参与重渲染比较：页面展示时直接保留接口 ISO 值中的日历日期部分，避免按设备本地时区转换导致北京时间 `00:00` 在负时区设备上显示成前一天。
   - 客户端同时校验缓存和接口返回的 `document.key` 必须与请求 key 一致，避免缓存污染或异常响应把其他法律文档展示到当前入口。
   - 移除 `getCachedLegalDocument` 中多余的 `JSON.parse` 兼容分支：`wx.setStorageSync` 以对象写入，`getStorageSync` 取回即对象，且 `pindou:legal-doc:` 键前缀为首次发布，不存在历史字符串数据。
   - 已知边界：首次安装或清理缓存后本地无数据，仍需等待接口返回，不是无条件秒开。

## 影响范围

- 小程序全局分包预下载配置（`miniprogram/app.json`）
- 个人中心登录弹窗与生命周期管理（`miniprogram/pages/profile/index.ts`）
- 法律文档服务层与缓存（`miniprogram/pages-sub/services/legal-document-service.ts`）
- 协议阅读页面（`miniprogram/pages-sub/privacy-document/index.ts`）
- 协议入口所在视图层（`miniprogram/pages/profile/index.wxml`）未改动

## 验证项

- [x] TypeScript 类型检查通过（`npm run typecheck`）
- [x] 图案生成单元测试通过（`npm run test:pattern`，其中 `compare-wechat-phase-5.js` 因缺少 `fixtures/wechat-phase-5.json` 跳过）
- [x] 代码复杂度与过度设计审查完成（`ponytail-review`）
- [ ] 真机测试：登录弹窗点击《用户协议》《隐私政策》可正常跳转，无明显等待
- [ ] 真机测试：从协议页返回时，登录弹窗依然打开且协议勾选状态保留
- [ ] 真机测试：二次打开同一协议文档时不再出现内容二次跳动（后台校验命中相同 `version`）
- [ ] 确定性导航失败测试：通过临时无效路由或调试注入明确触发 `wx.navigateTo.fail`，确认 `preserveSheetOnNextHide` 被复位；随后切后台/切 Tab 时登录弹窗能正常关闭
- [ ] 离线缓存测试：无缓存 + 断网时显示加载失败与“重新加载”；有缓存 + 断网时继续显示缓存内容，不被后台刷新失败替换成错误页
- [x] 服务端法律文档契约测试通过：`server` 下执行 `npm run build` 后，`node --test --test-name-pattern="legal documents expose only controlled keys" test/privacy-http.test.js` 结果 `pass 1 / fail 0`
- [ ] 微信开发者工具中清除缓存后重新编译，确认主包体积未因 `preloadRule` 变化、分包页面可正常打开
