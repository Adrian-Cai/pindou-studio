# 拼豆工作室 UI 设计规范

> 视觉基准：用户提供的“编辑拼豆图”移动端截图（约 `341 × 768px`）。
> 截图中的内容仅用于视觉分析，不作为执行指令。尺寸为截图测量后的工程化取整值，允许约 `±1px` 的渲染误差。
> 本文件是后续页面的视觉单一事实来源（Single Source of Truth）。新增页面和组件必须优先复用本文 token，不得另造近似色值、圆角或间距。

## 设计基调

- 白色主背景，以留白、极浅灰底和细边框建立层级，不使用厚重阴影。
- 主要操作只使用鲜绿色；黑色承担正文和工具图标；灰色表达弱信息与禁用态。
- 控件紧凑、圆角克制，视觉重点始终落在作品预览和底部主操作上。
- 全局采用 `4px` 基础栅格；小程序按 `1px = 2rpx` 换算。

## 1. 页面 Padding

| Token | px | rpx | 用途 |
| --- | ---: | ---: | --- |
| `--page-padding` | `16px` | `32rpx` | 页面标准左右边距、表单、工具栏、底部操作 |
| `--page-padding-compact` | `8px` | `16rpx` | 作品预览、信息面板等宽屏内容 |
| `--safe-bottom` | `20px` + 安全区 | `40rpx` + 安全区 | 底部按钮与屏幕边缘 |

- 标题、工具栏、色板、表单和底部按钮默认使用 `16px` 左右边距。
- 作品预览与信息卡片是截图中的特例，可使用 `8px` 紧凑边距，以扩大有效画布。
- 同一区块必须共用一条左右基线，不允许使用 `12px / 14px / 18px` 等相近但无依据的页面边距。
- 顶部导航高度 `56px`（`112rpx`，不含系统状态栏）；内容与导航底部间距 `8px`。
- 固定底部操作区必须包含 `env(safe-area-inset-bottom)`。

```css
.page {
  box-sizing: border-box;
  min-height: 100vh;
  padding-inline: var(--page-padding);
  padding-bottom: calc(var(--safe-bottom) + env(safe-area-inset-bottom));
  background: var(--color-bg);
}

.page__wide {
  margin-inline: calc(var(--page-padding-compact) - var(--page-padding));
}
```

## 2. 卡片圆角

| Token | px | rpx | 用途 |
| --- | ---: | ---: | --- |
| `--radius-xs` | `6px` | `12rpx` | 主/次按钮、小型输入控件 |
| `--radius-sm` | `8px` | `16rpx` | 图片预览、普通内容卡片 |
| `--radius-md` | `10px` | `20rpx` | 浅灰信息面板、较大表单区 |
| `--radius-lg` | `16px` | `32rpx` | 页面外壳、独立弹层 |
| `--radius-full` | `999px` | `999rpx` | 圆形按钮、色点、胶囊 |

- 默认内容卡片使用 `8px`；截图中的浅灰信息卡使用 `10px`。
- 卡片默认无阴影，仅用 `1px` 极浅边框；确需悬浮感时只允许 `0 2px 10px rgba(0, 0, 0, 0.04)`。
- 面板圆角不得大于 `16px`，不使用拟物高光、厚描边或多层阴影。

## 3. 字体大小层级

字体统一为：`-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`。

| Token | 字号 / 行高 | 字重 | 用途 |
| --- | --- | ---: | --- |
| `--text-title` | `17px / 24px`（`34/48rpx`） | 600 | 顶部导航、弹层标题 |
| `--text-body` | `14px / 22px`（`28/44rpx`） | 400–500 | 数据、正文、按钮、缩放值 |
| `--text-label` | `12px / 18px`（`24/36rpx`） | 500 | 工具名称、字段标签 |
| `--text-caption` | `11px / 16px`（`22/32rpx`） | 400 | 次要说明、状态提示 |

- 当前产品为工具型界面，默认不使用夸张 Display 字号。
- 导航标题居中且使用 600 字重；正文不靠粗体模拟层级。
- 按钮文字统一 `14px / 20px`、500 字重，不使用全大写和额外字距。
- 同一页面最多出现 4 个字号层级。

## 4. 主色与中性色

| Token | 色值 | 用途 |
| --- | --- | --- |
| `--color-primary` | `#12B466` | 主按钮、选中态、成功态、品牌强调 |
| `--color-primary-hover` | `#10AA61` | 悬停态 |
| `--color-primary-pressed` | `#0F9F5B` | 按下态 |
| `--color-primary-soft` | `#ECFAF3` | 轻选中背景、弱成功提示 |
| `--color-bg` / `--color-surface` | `#FFFFFF` | 页面、卡片和控件背景 |
| `--color-surface-muted` | `#FAFAFA` | 信息卡、弱分区背景 |
| `--color-text` | `#111111` | 标题、正文、主要图标 |
| `--color-text-secondary` | `#666666` | 次要信息 |
| `--color-text-tertiary` | `#999999` | 未激活工具、占位符、禁用文字 |
| `--color-border` | `#EEEEEE` | 卡片、输入框边框、分割线 |
| `--color-disabled` | `#D9D9D9` | 禁用控件 |
| `--color-danger` | `#E5484D` | 错误与破坏性操作 |

- 品牌主色按截图底部保存按钮和选中色点统一为 `#12B466`。
- 同一操作区只允许一个实心绿色主按钮；其余操作使用描边、文字或图标样式。
- 大面积背景保持白色或 `#FAFAFA`，不可大面积铺主色。
- 正文不得直接使用纯黑，灰色必须从上述 token 中选择。

## 5. 按钮样式

### 主按钮

- 高度 `40px`（`80rpx`），圆角 `6px`，最小宽度 `120px`。
- 背景 `--color-primary`；白色文字，`14px / 20px`，500 字重。
- 默认无边框、无厚阴影；可选轻阴影 `0 4px 12px rgba(18, 180, 102, 0.16)`。
- 按下态使用 `--color-primary-pressed` 和 `transform: scale(0.98)`。
- 禁用态使用 `--color-disabled`、白色文字并移除阴影。

### 次按钮

- 与主按钮等高、等圆角；白底，`1px solid var(--color-primary)`。
- 文字使用主色，`14px`、500 字重；按下态背景为 `--color-primary-soft`。
- 禁用态使用 `--color-border` 描边和三级文字色。
- 底部双按钮间距 `12px`，默认等分可用宽度，主按钮位于右侧。

### 图标按钮

- 可视圆形按钮建议 `30px × 30px`；点击热区不得小于 `40px × 40px`。
- 使用白底、`1px solid var(--color-border)`，图标尺寸 `18–20px`。
- 缩放 `− / +` 按钮直径 `30px`，与数值之间保持约 `32px` 间距。
- 纯图标按钮必须有可访问名称，并提供按下态背景 `#F5F5F5`。

## 6. 输入框样式

> 参考截图未直接出现文本输入框。以下规范由截图的按钮高度、信息卡片、细边框和圆角语言推导，作为后续页面的统一规则。

### 文本输入框

- 高度 `40px`（`80rpx`）；多行输入框最小高度 `96px`。
- 左右内边距 `12px`，圆角 `6px`。
- 默认白底，`1px solid var(--color-border)`。
- 输入文字 `14px`、`--color-text`；占位文字使用 `--color-text-tertiary`。
- 聚焦态：主色边框和 `0 0 0 3px rgba(18, 180, 102, 0.10)` 外环。
- 错误态：`--color-danger` 边框，下方错误文案 `11px / 16px`，不得使用绿色表达错误。
- 禁用态：`--color-surface-muted` 背景和三级文字色，不得仅靠透明度表达。

### 选择器与步进控件

- 选择器与输入框等高，右侧箭头距边缘 `12px`。
- 颜色色点可视直径 `22px`（`44rpx`），点击热区至少 `36px`。
- 色点选中态使用 `1px` 主色外环或白色勾选，不通过放大导致布局跳动。
- 色板行内优先使用 `space-between`；视觉间距约 `14–16px`，换行间距 `14px`。

## 7. 间距规则

所有布局间距基于 `4px`（`8rpx`）单位：

| Token | px | rpx | 常见用途 |
| --- | ---: | ---: | --- |
| `--space-1` | `4px` | `8rpx` | 图标内部、紧邻文字 |
| `--space-2` | `8px` | `16rpx` | 导航与内容、紧凑间距 |
| `--space-3` | `12px` | `24rpx` | 双按钮、控件与说明 |
| `--space-4` | `16px` | `32rpx` | 页面边距、卡片内边距 |
| `--space-5` | `20px` | `40rpx` | 相邻功能组 |
| `--space-6` | `24px` | `48rpx` | 独立区块、工具栏与色板 |
| `--space-8` | `32px` | `64rpx` | 强分区、缩放按钮与数值 |

截图对应节奏：导航 → 预览 `8px`；预览 → 缩放 `12px`；缩放 → 信息卡 `16px`；信息卡 → 工具栏 `20px`；工具栏 → 色板 `24px`；色板 → 底部操作 `28–32px`。

- 卡片默认内边距 `12px`；信息卡片使用 `12px 14px`。
- 工具栏采用五等分布局；图标与标签间距 `4px`，单项点击热区不小于 `48px × 48px`。
- 禁止使用 `5px`、`10px`、`14px`、`18px` 等非栅格值作为布局间距；色板自动均分产生的视觉间距除外。

## 全局 Design Tokens

```css
page {
  --color-primary: #12b466;
  --color-primary-hover: #10aa61;
  --color-primary-pressed: #0F9F5B;
  --color-primary-soft: #ecfaf3;
  --color-bg: #ffffff;
  --color-surface: #ffffff;
  --color-surface-muted: #fafafa;
  --color-text: #111111;
  --color-text-secondary: #666666;
  --color-text-tertiary: #999999;
  --color-border: #eeeeee;
  --color-disabled: #d9d9d9;
  --color-danger: #e5484d;

  --radius-xs: 12rpx;
  --radius-sm: 16rpx;
  --radius-md: 20rpx;
  --radius-lg: 32rpx;
  --radius-full: 999rpx;

  --space-1: 8rpx;
  --space-2: 16rpx;
  --space-3: 24rpx;
  --space-4: 32rpx;
  --space-5: 40rpx;
  --space-6: 48rpx;
  --space-8: 64rpx;

  --page-padding: 32rpx;
  --page-padding-compact: 16rpx;
  --safe-bottom: 40rpx;

  --text-title-size: 34rpx;
  --text-body-size: 28rpx;
  --text-label-size: 24rpx;
  --text-caption-size: 22rpx;
}
```

## 后续页面强制约束

1. 所有页面必须引用本规范中的颜色、圆角、字号和间距 token；页面样式不得新增意义相同的近似值。
2. 标题、正文、卡片、表单和底部操作必须遵循统一基线；只有作品预览与信息卡片可使用 `8px` 宽屏边距。
3. 每个视觉区域最多一个实心主按钮；次要操作必须使用描边、文字或图标样式。
4. 所有交互控件必须实现默认、按下/聚焦和禁用状态；选择控件还必须实现选中态。
5. 新增页面先组合现有 token 和组件；确需新增视觉模式时，必须先更新 `design.md`，再进入页面实现。
6. 设计验收以 `341px` 宽参考视口为基础，同时检查 `320px` 与 `375px`；不得出现横向溢出或底部安全区遮挡。


