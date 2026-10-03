# 首页生成模式卡片选中态统一

Written against: `561859d9104fa8bbca8125a55e38943cd9e8b8f3`

## Evidence chain

- Surface: 小程序首页“生成方式”双选项卡片，覆盖标准模式和 AI 模式的未选中、选中状态。
- Problem: 用户提供的截图显示 AI 模式已选中，紫色卡片底与勾选清晰；标准模式未选中，卡片为白底但图标仍保留绿色。当前未选中的 AI 卡片还会通过 CSS 保留浅紫背景和描边，因此两种模式的视觉状态不一致。
- Design evidence: `design.md` 规定卡片默认白底（第 63 行）、`--color-primary-soft` 用于轻选中背景（第 103 行），选择控件需有明确选中态（第 288 行）；`docs/frontend/UI_RULES.md` 规定卡片使用现有圆角和阴影体系。用户提供的截图是本次问题的直接视觉证据。
- Owner: `miniprogram/pages/home/index.wxml` 与 `miniprogram/pages/home/index.wxss`。
- Scope and affected surfaces: 仅首页生成方式卡片的图标、卡片底色、描边和勾选状态；不影响示例图片、生成参数、模式选择逻辑或其他页面。
- Uncertainty: 页面已有 AI 浅紫和标准浅绿模式色；本方案保留这些现有色值，仅收敛状态表达。微信小程序对未选中图标灰度滤镜的实际渲染需在开发者工具确认。

## Design decision

用卡片状态表达选择结果：未选中卡片恢复白底且图标降为中性灰；选中卡片保留现有模式色浅背景、强调色外环与勾选。这样彩色强调集中在当前选项，符合卡片默认白底和选择控件明确选中态的规范，不新增颜色 token，也不改变默认选择。

## Reuse

- 复用现有 `.mode-card--active-standard`、`.mode-card--active-ai`、`.mode-card__check` 和首页现有 `--color-primary-soft` / `--color-ai-soft` 色值。
- 复用标准模式图标、AI 模式图标和当前辐射组/选中状态绑定，不新增组件或状态字段。
- Exemplar: `miniprogram/pages/home/index.wxml` 的 `aria-checked` 与勾选显示绑定；`miniprogram/pages/home/index.wxss` 的选中卡片样式。

## Changes

1. `miniprogram/pages/home/index.wxss`
   - Change: 删除仅针对未选中 AI 卡片的紫色底和外环规则；为所有未选中模式卡片设白底；通过现有活动态父级选择器将未选中图标灰度化，选中时恢复原始图标颜色。
   - Preserve: 选中卡片的现有浅色背景、模式强调色外环、标题强调色、勾选、触摸反馈和尺寸；保留 AI “更精致” badge 样式。
   - Verify: 标准和 AI 两种模式轮流选中时，只有当前选项显示对应浅色卡片底、彩色图标和勾选；未选项均为白底、中性图标，无紫色默认外环。

## Scope

- Inherit: 仅首页的两张生成模式卡片。
- Verify: 浅色主题为本次设计验收基准；保留现有暗色 token/主题逻辑，确认状态选择器未覆盖或破坏现有主题样式。
- Exclude: 修改生成模式默认值或业务流程；重画图标；调整卡片布局、文案、badge、间距、尺寸；增加新的品牌色、组件或设计 token；改动全局设计文档。

## Validation

- Product: 在首页切换标准模式与 AI 模式，确认选择结果和生成逻辑不变，且视觉选中态跟随当前选择。
- Interface: 在微信开发者工具检查初始标准模式、切换到 AI 模式两种状态；按 `design.md` 的 320、375、393、414px 视口检查布局和截断，并确认 AI badge 与勾选不重叠。
- System: 确认只复用首页现有 active class 和颜色 token，没有新增平行状态、全局样式或无关页面改动。
- Repository: 微信开发者工具编译并截图对照用户提供的界面；仓库没有可执行的 WXSS/WXML lint 或 mini program build 脚本。若实现仅涉及 WXSS/WXML，则不新增测试。

## Stop conditions

- 若小程序运行时不支持未选中图标灰度滤镜，暂停实现并重新提交资产方案供审查；不得未经审查新增图标变体或色值。
- 若改动需要更改卡片布局、生成模式默认值、其他页面或全局设计规则，暂停并重新确认范围。

## Design documentation

- After acceptance and validation: 无需更新。方案复用已有卡片白底、选中背景和页面色值，不新增全局视觉规则。
