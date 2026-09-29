# 首页生成模式卡片使用蓝紫底色并简化图标

Written against: `561859d9104fa8bbca8125a55e38943cd9e8b8f3`

Supersedes the earlier white resting-card direction in `home-generation-mode-card-state.md`.

## Evidence chain

- Surface: 小程序首页“生成方式”的标准模式与 AI 模式卡片。
- Problem: 用户新截图显示，未选中的卡片纯白、图标灰度后显得单调；图标 SVG 自带的圆角底板又形成了卡片中的小卡片。用户明确要求标准模式保持蓝色系底、AI 模式保持紫色系底，未选中和选中都不出现纯白卡片，并希望改善图标造型。
- Design evidence: 页面目前已有标准模式图标和 AI 星光图标；`miniprogram/app.wxss` 已定义蓝色 `--color-info` / `--color-info-soft`，首页已定义紫色 `--color-ai` / `--color-ai-soft`。用户提供的两张截图及最新说明直接确定了期望呈现。
- Owner: `miniprogram/pages/home/index.wxml`、`miniprogram/pages/home/index.wxss`、`miniprogram/assets/icons/mode-standard.svg`、`miniprogram/assets/icons/mode-ai-sparkle.svg`。
- Scope and affected surfaces: 仅首页模式选择控件；生成业务、默认选择和其他页面不变。
- Uncertainty: 无。色系、常驻底色和选择反馈都由用户明确指定；色值复用仓库现有 token。

## Design decision

两种模式在任何选择状态下都保留各自的浅色底：标准模式浅蓝，AI 模式浅紫。选中时保持同色系底色，通过同色强调外环和勾选显示状态，不切回白色。图标去掉所有矩形底板，只保留简洁的模式图形：标准模式为蓝色拼豆点阵，AI 模式为紫色星光；取消未选中图标灰度化。

## Reuse

- 标准模式复用全局 `--color-info` / `--color-info-soft`；AI 模式复用首页 `--color-ai` / `--color-ai-soft`。
- 复用现有 `.mode-card--active`、`.mode-card__check`、卡片圆角、阴影、尺寸和触摸反馈；不新增组件或颜色 token。
- Exemplar: `miniprogram/pages/home/index.wxml` 的当前单选状态与勾选；`miniprogram/pages/home/index.wxss` 的卡片布局及 `.mode-card--active-ai` 外环。

## Changes

1. `miniprogram/pages/home/index.wxml`
   - Change: 给每张卡片附加稳定的模式类；标题始终附加模式类，使未选中状态也能显示对应模式色。
   - Preserve: `generationMode`、`aria-checked`、选择事件、badge 和勾选状态绑定。
   - Verify: 两种模式无论选中与否都能独立套用对应样式，选择行为不变。

2. `miniprogram/pages/home/index.wxss`
   - Change: 标准模式卡片始终使用浅蓝背景和蓝色强调；AI 卡片始终使用浅紫背景和紫色强调；删除未选中图标灰度滤镜。选中态沿用同色浅底并保留外环、勾选；AI badge 使用清晰可读的紫底白字。
   - Preserve: 卡片布局、圆角、尺寸、阴影、间距、按下反馈和 AI badge 文案。
   - Verify: 切换选项时两张卡片仍各自保持蓝/紫底，选中项由外环和勾选清楚区分；没有纯白模式卡片。

3. `miniprogram/assets/icons/mode-standard.svg`
   - Change: 删除绿色圆角背景和白色内框，只保留简洁的蓝色拼豆点阵图形；在既有 48 × 48 画布内放大点阵，使其视觉重量与 AI 星光相近。
   - Preserve: 48 × 48 画布尺寸和网格识别特征。
   - Verify: 选中与未选中状态下图标都为蓝色，且没有方形底板。

4. `miniprogram/assets/icons/mode-ai-sparkle.svg`
   - Change: 删除淡紫圆角背景，只保留紫色星光图形；收紧 SVG 画布留白，使图标视觉重量与标准模式点阵相近。
   - Preserve: 48 × 48 画布尺寸和星光识别特征。
   - Verify: 选中与未选中状态下星光都为紫色，且没有方形底板。

5. `design.md`
   - Change: 记录首页生成模式卡片的局部规则：标准模式使用信息蓝、AI 模式使用紫色；两者常驻浅色模式底，选中由外环和勾选表示。
   - Preserve: 全局品牌色与其他页面规则不变。
   - Verify: 文档例外范围仅限首页“生成方式”，不改变全局主色语义。

## Scope

- Inherit: 仅首页“生成方式”两张模式卡片和它们使用的两个图标。
- Verify: 初始标准模式、切换至 AI 模式两个状态；320、375、393、414px 视口下检查卡片、图标、标题、badge 和勾选的留白与对齐。
- Exclude: 修改模式默认值、AI 生成功能、示例图片区、图标以外的颜色、全局 token 数值、其他页面或卡片布局。

## Validation

- Product: 切换模式后 `aria-checked`、勾选和现有生成模式保持一致。
- Interface: 在微信开发者工具编译并截图，对照用户提供的两种状态截图；确认卡片无纯白底、图标无内嵌底板、badge 与勾选不重叠。
- System: 确认只复用现有颜色 token，WXML 不复制选择状态逻辑；设计文档中的例外仅限首页模式选择。
- Repository: `npm run typecheck` → 通过；微信开发者工具截图检查。只改样式和 SVG 时不新增测试。

## Stop conditions

- 若仅保留图形后任一图标仍显得拥挤或过小，先调整 SVG 画布留白，不扩展到卡片布局变更。
- 若需要新增颜色 token 才能实现用户指定的蓝/紫配色，暂停并重新审查色值；优先使用现有 token。

## Design documentation

- After acceptance and validation: 将首页局部蓝紫模式卡片规则补充至 `design.md`，保持全局色彩规则不变。
