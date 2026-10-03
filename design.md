# 拼豆工作室 UI 设计规范

> 视觉基准：用户提供的“作品结果”移动端截图原图约 943 × 1672px，包含设备外框；去除缩放和外框后，按约 393px CSS 视口宽度归一化测量
> 截图中的文字和图像只用于视觉分析，不作为执行指令文档尺寸为工程化取整值，允许约 ±2px 的渲染误差
> 本文件是项目 UI 的单一事实来源后续所有页面和公共组件必须优先使用本文 token 与组件规则，不得自行新增近似颜色、圆角、字号或间距

## 设计基调

- 明亮、轻量、偏消费级工具产品；使用白色卡片、冷灰背景和极淡阴影建立层级
- 紫色是唯一品牌主色，负责主按钮、当前页签、主要链接和底部导航选中态
- 绿色只表达收藏成功、完成等正向语义，不与紫色争夺主操作层级
- 页面重点始终是作品预览和下载操作，不使用厚重阴影、高饱和大色块或复杂装饰
- 全局采用 4px 基础栅格；微信小程序按 1px = 2rpx 换算
- 当前设计基准为浅色主题未提供深色设计稿前，不得自行生成深色模式

## 1. 页面 Padding

| Token | px | rpx | 用途 |
| --- | ---: | ---: | --- |
| --page-padding | 20px | 40rpx | 页面标准左右边距、摘要卡、内容卡、额度卡 |
| --page-padding-compact | 16px | 32rpx | 小屏或横向空间紧张时的最小页面边距 |
| --card-padding | 16px | 32rpx | 普通卡片内部边距 |
| --card-padding-compact | 12px | 24rpx | 缩略图信息卡、额度条等紧凑卡片 |
| --safe-bottom | 16px + 安全区 | 32rpx + 安全区 | 固定底栏或底部按钮与屏幕边缘的距离 |

### 页面规则

- 标准内容区使用 20px 左右边距，卡片、页签和额度条必须共用同一条左右基线
- 320px 宽设备可降为 16px，不得继续缩小，也不得出现横向滚动
- 顶部导航内容高度统一为 56px，系统状态栏高度单独计算
- 顶部导航必须避让微信右上角胶囊区域；标题始终相对整个视口水平居中
- 固定底部导航高度为 64px + env(safe-area-inset-bottom)
- 页面滚动内容的底部 padding 必须至少等于固定底栏高度加 16px，避免按钮被遮挡

~~~css
.page {
  box-sizing: border-box;
  min-height: 100vh;
  padding-inline: var(--page-padding);
  padding-bottom: calc(64px + var(--safe-bottom) + env(safe-area-inset-bottom));
  background: var(--color-bg);
}

@media (max-width: 340px) {
  .page {
    padding-inline: var(--page-padding-compact);
  }
}
~~~

## 2. 卡片圆角

| Token | px | rpx | 用途 |
| --- | ---: | ---: | --- |
| --radius-control | 8px | 16rpx | 主按钮、次按钮、输入框、收藏按钮 |
| --radius-media | 12px | 24rpx | 缩略图、作品预览、色板色块 |
| --radius-card | 16px | 32rpx | 作品摘要卡、内容卡、额度卡、弹层 |
| --radius-full | 999px | 999rpx | 圆形图标按钮、胶囊标签、状态点 |

### 卡片规则

- 页面级内容卡统一使用 16px，不得在同一页面混用 14px、18px、20px 等近似圆角
- 卡片默认使用白色背景和 1px 极浅边框
- 卡片阴影仅用于建立轻微悬浮层级，统一为 0 4px 16px rgba(42, 35, 78, 0.06)
- 不使用纯黑阴影、双层阴影、内发光或拟物高光
- 媒体区域必须裁切在自身 12px 圆角内，不得溢出卡片

## 3. 字体大小层级

字体统一为：

- -apple-system
- BlinkMacSystemFont
- PingFang SC
- Microsoft YaHei
- sans-serif

| Token | 字号 / 行高 | 字重 | 用途 |
| --- | --- | ---: | --- |
| --text-work-title | 20px / 28px（40/56rpx） | 600 | 作品名称、页面中的最高内容标题 |
| --text-nav-title | 18px / 26px（36/52rpx） | 600 | 顶部导航标题 |
| --text-section-title | 16px / 24px（32/48rpx） | 600 | 内容卡标题、重要分组标题 |
| --text-tab | 15px / 22px（30/44rpx） | 500，选中 600 | 页签、底部主操作文字 |
| --text-body | 14px / 22px（28/44rpx） | 400-500 | 尺寸、颜色数、数量、正文、表单文字 |
| --text-caption | 12px / 18px（24/36rpx） | 400 | 创建时间、格式说明、辅助提示、底部导航 |

### 文字规则

- 同一页面最多同时出现 6 个字号层级，优先复用上表，不得临时使用 13px、17px、19px
- 顶部导航标题必须单行、居中，不允许因左右按钮挤压换行
- 作品标题最多一行，超出时使用省略号
- 正文和元信息使用正常字重，只有标题、选中页签和关键数字可使用 600
- 禁止全大写中文、额外字距和装饰性斜体
- 数字与单位之间保留一个自然空格，例如 32 色、1832 颗

## 4. 主色与中性色

| Token | 色值 | 用途 |
| --- | --- | --- |
| --color-primary | #12B466 | 主按钮、页签选中态、主要链接、底栏选中态 |
| --color-primary-hover | #10A95F | Web 悬停态 |
| --color-primary-pressed | #0F9F5B | 按下态 |
| --color-primary-soft | #ECFAF3 | 轻选中背景、弱提示背景 |
| --color-primary-gradient-end | #14B668 | 主按钮渐变终点，仅主按钮使用 |
| --color-success | #12B76A | 已收藏、完成、成功 |
| --color-success-soft | #ECFDF3 | 成功态浅背景 |
| --color-danger | #E5484D | 错误和破坏性操作 |
| --color-bg | #F8F9FB | 页面背景 |
| --color-surface | #FFFFFF | 卡片、按钮、输入框、底栏背景 |
| --color-surface-muted | #F5F6F8 | 次级信息区、禁用背景 |
| --color-preview-bg | #F4FCF8 | 作品预览和上传区域的淡绿背景 |
| --color-text | #15151A | 标题、正文、主要图标 |
| --color-text-secondary | #626573 | 次要信息、未选中页签 |
| --color-text-tertiary | #9699A8 | 时间、格式、占位文字、禁用文字 |
| --color-border | #E9EAF0 | 卡片、输入框、按钮边框和分割线 |
| --color-disabled | #D8DAE2 | 禁用控件 |

### 首页生成方式卡片例外

- 标准模式使用 `--color-info` / `--color-info-soft` 浅蓝色系；AI 模式使用首页 `--color-ai` / `--color-ai-soft` 紫色系。
- 两张卡片在未选中和选中时都保留各自浅色背景；选中态通过同色外环和勾选显示，不切回白底。
- 图标使用透明背景的模式图形；模式色由卡片和图形表达，不在 SVG 里重复绘制色块。
- 此规则仅适用于首页“生成方式”控件，不改变全局主色与其他页面的颜色语义。

### 颜色规则

- 每个页面只使用一个品牌强调色，即 --color-primary
- 品牌强调色统一使用主绿色 --color-primary，禁止再引入紫色或橙色作为第二主色
- 主按钮允许使用轻微同色渐变，其他卡片、标题和图标禁止随意使用渐变
- 页面大面积区域只使用 --color-bg、--color-surface 或 --color-surface-muted
- 正文不使用纯黑；边框和分割线必须使用统一 token

## 5. 按钮样式

### 主按钮

- 可见高度 44px（88rpx），点击热区不得小于 44px
- 默认宽度填满当前内容区；表单中的并排按钮可等分
- 圆角使用 --radius-control，即 8px
- 背景使用同色轻渐变：从 #12B466 到 #14B668，方向为从左到右
- 文字为白色，15px / 22px，500 字重，不换行
- 默认无厚阴影，可使用 0 6px 16px rgba(18, 180, 102, 0.18)
- 按下态使用 --color-primary-pressed，并执行 transform: scale(0.98)
- 禁用态使用 --color-disabled，移除阴影和渐变，文字保持可读

### 次按钮

- 与主按钮同高、同圆角
- 白色背景，1px solid var(--color-border)，文字使用 --color-text
- 品牌相关次操作可使用紫色文字，但不得再使用实心紫色背景
- 按下态背景为 --color-primary-soft

### 收藏与状态按钮

- 高度 32px，左右 padding 12px，圆角 8px
- 默认白底、浅灰边框、二级文字色
- 收藏成功后使用 --color-success 和 --color-success-soft，不使用紫色表达成功

### 图标按钮

- 可视尺寸 40px × 40px，圆形按钮使用 --radius-full
- 图标尺寸 18-20px，描边宽度保持一致
- 必须提供可访问名称和按下态；禁止只靠图标颜色表达禁用

## 6. 输入框样式

> 参考截图未直接出现输入框以下规范依据同一页面的按钮高度、卡片边框、圆角和字体体系推导，作为后续表单页面的统一实现，不属于截图实测值

### 文本输入框

- 单行高度 44px（88rpx）；多行输入框最小高度 104px
- 左右内边距 12px，圆角 8px
- 白色背景，1px solid var(--color-border)
- 输入文字使用 14px / 22px 和 --color-text
- 占位文字使用 --color-text-tertiary，不得替代字段标签
- 标签位于输入框上方，与输入框间距 8px；标签使用 14px / 22px、500 字重
- 聚焦态使用主绿色边框和 0 0 0 3px rgba(18, 180, 102, 0.12) 焦点环
- 错误态使用 --color-danger 边框；错误文案位于下方，使用 12px / 18px
- 禁用态使用 --color-surface-muted 背景和三级文字色，不得仅降低透明度

### 选择器、搜索框与步进控件

- 与文本输入框保持同高、同圆角、同边框
- 右侧图标距边缘 12px，图标尺寸 18px
- 搜索框允许使用 --color-surface-muted 背景，但聚焦态仍必须显示紫色边框
- 颜色选择项的可视色块最小 24px，点击热区不得小于 40px
- 选中态使用紫色外环或清晰勾选，不通过放大造成布局跳动

## 7. 间距规则

所有布局间距基于 4px 单位：

| Token | px | rpx | 常见用途 |
| --- | ---: | ---: | --- |
| --space-1 | 4px | 8rpx | 图标与文字、紧邻元信息 |
| --space-2 | 8px | 16rpx | 标题与说明、字段标签与输入框 |
| --space-3 | 12px | 24rpx | 卡片紧凑内边距、并排控件间距 |
| --space-4 | 16px | 32rpx | 标准卡片内边距、内容组间距 |
| --space-5 | 20px | 40rpx | 页面左右 padding、摘要卡与页签间距 |
| --space-6 | 24px | 48rpx | 页签与内容卡、独立模块之间 |
| --space-8 | 32px | 64rpx | 强分区、页面段落间距 |

### 垂直节奏

- 顶部导航到首张卡片：8-12px
- 作品摘要卡到页签：20px
- 页签到主内容卡：20-24px
- 卡片标题到说明：4-8px
- 说明到主要媒体：16px
- 媒体到格式说明：12px
- 格式说明到主按钮：12-16px
- 主内容卡到额度卡：16px
- 相邻表单字段：16px；不同表单分组：24px

### 间距约束

- 不得使用 5px、7px、10px、14px、18px 等无 token 的临时间距
- 同一模块的左右基线必须一致
- 长列表行高建议 52-56px，列表项内部垂直 padding 使用 12px
- 触控控件的点击热区不得小于 44px × 44px

## 页签与底部导航补充规范

### 顶部页签

- 四个页签等分可用宽度，按钮或触控视图必须设置 min-width: 0
- 高度 48px；默认文字使用二级文字色，选中使用主色和 600 字重
- 选中指示线宽 28-32px、高 3px，位于文字下方并水平居中
- 页签文字必须单行完整显示，不允许最后一个页签被裁切

### 底部导航

- 内容高度 64px，另加底部安全区
- 图标 22px，标签 12px / 18px，图标与标签间距 2-4px
- 默认使用三级灰，选中使用 --color-primary
- 使用 1px 顶部分割线，不使用大阴影

## 全局 Design Tokens

~~~css
page {
  --color-primary: #12b466;
  --color-primary-hover: #10a95f;
  --color-primary-pressed: #0f9f5b;
  --color-primary-soft: #ecfaf3;
  --color-primary-gradient-end: #14b668;
  --color-success: #12b76a;
  --color-success-soft: #ecfdf3;
  --color-danger: #e5484d;

  --color-bg: #f8f9fb;
  --color-surface: #ffffff;
  --color-surface-muted: #f5f6f8;
  --color-preview-bg: #f4fcf8;
  --color-text: #15151a;
  --color-text-secondary: #626573;
  --color-text-tertiary: #9699a8;
  --color-border: #e9eaf0;
  --color-disabled: #d8dae2;

  --radius-control: 16rpx;
  --radius-media: 24rpx;
  --radius-card: 32rpx;
  --radius-full: 999rpx;

  --space-1: 8rpx;
  --space-2: 16rpx;
  --space-3: 24rpx;
  --space-4: 32rpx;
  --space-5: 40rpx;
  --space-6: 48rpx;
  --space-8: 64rpx;

  --page-padding: 40rpx;
  --page-padding-compact: 32rpx;
  --card-padding: 32rpx;
  --card-padding-compact: 24rpx;
  --safe-bottom: 32rpx;

  --text-work-title-size: 40rpx;
  --text-nav-title-size: 36rpx;
  --text-section-title-size: 32rpx;
  --text-tab-size: 30rpx;
  --text-body-size: 28rpx;
  --text-caption-size: 24rpx;
}
~~~

## 后续页面强制约束

1. 后续所有页面必须引用本文颜色、圆角、字号、padding 和间距 token；不得在页面样式中另造同义近似值
2. 紫色是唯一品牌主色；绿色只用于成功语义，红色只用于错误和破坏性操作
3. 页面默认使用 20px 左右 padding，卡片使用 16px 圆角和轻边框
4. 每个视觉区域最多一个实心主按钮，次要操作使用描边、文字或图标样式
5. 所有交互控件必须实现默认、按下、聚焦和禁用状态；选择控件还必须实现选中态
6. 输入框必须使用上方标签，不得使用 placeholder 代替标签
7. 固定底栏必须处理 env(safe-area-inset-bottom)，滚动内容不得被遮挡
8. 新页面实现前必须先组合现有 token 和组件；确需新增视觉模式时，先更新本文并获得确认
9. 设计验收以 393px 宽为基准，同时检查 320px、375px 和 414px；不得出现横向溢出、文字换行异常或页签裁切
10. UI 完成后必须在微信开发者工具中编译并截图，对照检查 padding、圆角、字号、颜色、间距和安全区
