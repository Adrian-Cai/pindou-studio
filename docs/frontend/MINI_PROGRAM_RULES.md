# MINI_PROGRAM_RULES.md


# 小程序开发规范


开发必须考虑：

## 设备适配

支持：

- 不同屏幕尺寸
- 安全区域
- 刘海屏


---

## 页面体验


必须处理：

- 加载状态
- 空状态
- 错误状态
- 弱网络


---

## 页面布局


禁止：

- 固定死高度
- 大量absolute布局
- 依赖单一设备尺寸


---

## 图片处理


图片相关页面：

必须考虑：

- 加载失败
- 加载中
- 图片尺寸变化

### 包内静态图片禁止使用 WebP

**规则**：`miniprogram/assets/` 下的本地图片只允许 `svg` / `png` / `jpg`，禁止 `.webp`（`project.config.json`、云存储、服务端上传链路不受此限制）。

**原因**：微信官方文档中 `image` 组件的 `webp` 属性写明「默认不解析 webP 格式，只支持网络资源」，且该属性是 **WebView 特有属性**（`renderer: skyline` 下不存在）。也就是说包内 `.webp` 在开发者工具里能显示（模拟器是 Chromium webview，原生支持 webp），但真机上是一片空白——**工具里看不见问题，只有真机才暴露**。即便显式加上 `webp="true"`，社区到 2025-09 仍有 Android 机型（含透明通道 webp）不生效的反馈，因此不作为项目方案。

**血泪教训**：v0.16.0「图片资源转 WebP」把 5 张本地图（4 张首页示例图 + 默认头像）转成 webp，导致首页示例图与「我的」页头像在真机上长期空白，直到 v0.30.15 才还原。真要省包体，请用「降分辨率 + JPEG/Png 质量」（如 512×512 → 384×384）而不是换格式。

**排查口径**：图片空白时先看 CSS 里该 `<image>` 有没有 `background`——有背景色说明 `image` 元素本身渲染正常、只是资源没解出来，此时优先怀疑格式与路径，而不是布局。


---

## 页面导航


必须考虑：

- Tab遮挡
- 页面返回
- 状态保持

# 微信自定义导航栏规范

## 1. 状态栏

使用微信提供的窗口信息获取：

- statusBarHeight
- safeArea
- screenWidth
- windowWidth

不得自行猜测状态栏高度

---

## 2. 微信胶囊

统一通过：

wx.getMenuButtonBoundingClientRect()

获取胶囊：

- top
- bottom
- left
- right
- width
- height

自定义导航栏必须基于真实胶囊位置计算

---

## 3. 导航栏高度

统一通过公共 helper / hook / component 计算：

statusBarHeight
+
customNavigationBarHeight

不得在不同页面分别实现计算逻辑

---

## 4. 必须复用公共组件

如果项目已经存在：

- CustomNavbar
- PageLayout
- SafeArea
- ScrollPage

必须优先复用

禁止新页面复制一份导航栏实现

如果当前项目还没有统一组件，应优先抽取统一组件，再迁移相关页面

---

## 5. navigationStyle: custom

使用：

navigationStyle: "custom"

的页面必须检查：

- iPhone 刘海屏
- Dynamic Island / 灵动岛设备
- 普通 iPhone
- Android
- 不同微信胶囊高度

不得只按照开发者工具某一个模拟器调样式
---

## 6. 统一页面布局架构

项目页面统一采用：

```text
                PageLayout
                     │
         ┌───────────┴───────────┐
         │                       │
   CustomNavbar             ScrollArea
         │                       │
 状态栏 / 胶囊计算           页面业务内容
                                 │
                      ┌──────────┴──────────┐
                      │                     │
                   普通内容              StickyTabs
```

组件职责：

- PageLayout：统一组织固定导航栏和独立滚动区域
- CustomNavbar：统一处理状态栏、微信胶囊、标题和返回区域
- ScrollArea：承载页面业务内容并处理安全区和滚动边界
- StickyTabs：仅在页面存在 Tab 且设计要求吸顶时启用，吸顶位置必须避开 CustomNavbar

以下页面后续新增或重构时必须迁移到该结构：

- 作品结果
- 我的作品
- 我的收藏
- 我的下载
- 使用帮助
- 意见反馈
- 隐私设置
- 关于我们

禁止为上述页面创建 PageLayout、CustomNavbar、ScrollArea 或 StickyTabs 的页面专属替代实现
---

## 7. 分包与主包依赖规范

### 7.1 分包范围

`miniprogram/packages/*` 全部是分包，以 `app.json` 的 `subPackages` 为准：

- editor
- ai-generation
- result
- account
- payment
- download

除上述 root 之外的目录均属于主包，包括：

- `app.ts`
- `pages/*`
- `services/*`
- `store/*`
- `components/*`
- `custom-tab-bar/*`

### 7.2 强制约束

禁止：

- 主包代码 import / require 任何 `packages/` 下的模块（`.ts` / `.wxs` / 组件 / 资源）
- 主包页面 `usingComponents` 指向 `packages/` 下的组件
- 分包 A 静态 import / require 分包 B 的模块（各分包独立打包，静态引用在对方分包未下载时必崩）

允许：

- 分包 import 主包模块（单向依赖，如分包页面 `import { ... } from '../../services/xxx'`）
- 同一分包内部互相引用
- 分包 A 通过 `require.async`（分包异步化，基础库 ≥ 2.17.3）异步引用分包 B 的 JS 模块；仅限「主包不使用、无法上提主包」的共享逻辑（见 7.4），组件不走这条路（见 7.6）

### 7.3 原因

分包代码不会打进主包 bundle。主包引用分包模块在编译期不报错，运行时才抛：

```text
module 'packages/xxx/services/xxx.js' is not defined, require args is '../packages/xxx/services/xxx'
```

若该引用出现在 `app.ts` 的加载链上（如 `app.ts -> services/*`），会在小程序启动阶段直接崩溃白屏，
并连带产生 `Component is not found in path "wx://not-found"` 之类的次生报错，容易误判为组件路径问题。

### 7.4 新增模块时先判断归属

被以下任一位置引用，就必须放在主包目录：

- `app.ts`
- 主包页面（`pages/*`）
- 主包服务（`services/*`）
- 主包公共组件（`components/*`）

例如 `ai-generation-flow.ts` 被主包 `services/ai-generation-manager.ts`（`app.ts` 引用）使用，
必须放在 `miniprogram/services/`，不能放在 `miniprogram/packages/ai-generation/services/`。

跨分包共用、且主包自己也会用到的逻辑才上提到主包，不要为了"就近"放进某个分包。

只被分包使用（主包零引用）的共享逻辑**不要**上提主包：主包内没有任何主包代码引用的 JS 会触发
代码质量扫描「主包内不应存在主包未使用的 JS 文件」告警，还白占主包体积。这类逻辑保持单一来源，
放进其中一个分包，其他分包用 `require.async` 异步引用；不要复制成多份，绘制风格这类会调参的
常量复制后必然改一处漏一处。

例如 `pattern-renderer.ts`（拼豆圆点绘制）只有 editor 与 ai-generation 两个分包使用，
已迁入 `packages/editor/services/pattern-renderer.ts`；ai-generation 页绘制预览前
`require.async('../editor/services/pattern-renderer.js')` 按需加载，失败走页面内 `patternRenderError` 兜底。

### 7.5 排查方法

检索主包代码里指向 `packages/` 的相对引用：

```bash
grep -rn "from '\(\.\./\)*packages/" miniprogram --include=*.ts
```

主包侧任何命中都是违规引用，需将目标模块上提到主包后再改引用路径。

### 7.6 跨分包共用组件的落地方式

- 被多个分包（或分包与主包）共用的组件必须放在主包 `components/`。放进某个分包内会让其他分包引用它，同样违反 7.2。
- 组件需要复用 `app.wxss` 的全局类（如 `.button-primary`、`.button-secondary`）时，必须在其 `options` 中声明 `styleIsolation: 'apply-shared'`；默认 `isolated` 下 app.wxss 与页面样式对组件无效，按钮会掉样式。
- 组件 wxss 内不能使用标签名、ID、属性选择器。页面里常见的 `.xxx image { width: 32rpx; }` 抽进组件后必须改成给节点加 class 再写类选择器，否则不生效。
- 页面级 CSS 变量（`page { --token: ... }`）会继承进组件，可直接引用；只在个别页面定义的 token（如编辑器页的 `--tool-active-*`）在组件内必须写 fallback 值。

参考实现：`components/editor-control-panel/`（编辑器页与 AI 生成页共用）。
