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

- 固定死高度。
- 大量absolute布局。
- 依赖单一设备尺寸。


---

## 图片处理


图片相关页面：

必须考虑：

- 加载失败
- 加载中
- 图片尺寸变化


---

## 页面导航


必须考虑：

- Tab遮挡。
- 页面返回。
- 状态保持。

# 微信自定义导航栏规范

## 1. 状态栏

使用微信提供的窗口信息获取：

- statusBarHeight
- safeArea
- screenWidth
- windowWidth

不得自行猜测状态栏高度。

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

自定义导航栏必须基于真实胶囊位置计算。

---

## 3. 导航栏高度

统一通过公共 helper / hook / component 计算：

statusBarHeight
+
customNavigationBarHeight

不得在不同页面分别实现计算逻辑。

---

## 4. 必须复用公共组件

如果项目已经存在：

- CustomNavbar
- PageLayout
- SafeArea
- ScrollPage

必须优先复用。

禁止新页面复制一份导航栏实现。

如果当前项目还没有统一组件，应优先抽取统一组件，再迁移相关页面。

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

不得只按照开发者工具某一个模拟器调样式。
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

- PageLayout：统一组织固定导航栏和独立滚动区域。
- CustomNavbar：统一处理状态栏、微信胶囊、标题和返回区域。
- ScrollArea：承载页面业务内容并处理安全区和滚动边界。
- StickyTabs：仅在页面存在 Tab 且设计要求吸顶时启用，吸顶位置必须避开 CustomNavbar。

以下页面后续新增或重构时必须迁移到该结构：

- 作品结果
- 我的作品
- 我的收藏
- 我的下载
- 使用帮助
- 意见反馈
- 隐私设置
- 关于我们

禁止为上述页面创建 PageLayout、CustomNavbar、ScrollArea 或 StickyTabs 的页面专属替代实现。
