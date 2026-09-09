# 小程序 0.25.19 提交信息

## 版本号

`0.25.19`

## 建议提交信息

`fix(miniprogram): remove profile version copy (v0.25.19)`

## 提审版本说明

优化“我的”页面底部展示，移除冗余版本说明文案，避免滚动时与固定底部导航视觉重叠，提升页面阅读体验。

## 本次修改说明

1. 移除“我的”页底部的“拼豆制作工具 · Version 0.25.16”文案与对应样式。
2. 保留固定底部主导航；它不是额外蒙层，继续承担三个一级页面的切换功能。
3. 登录、充值和账号面板打开时的遮罩仍按需显示，未改变弹窗交互或业务流程。

## 影响范围

- 个人中心展示层：`miniprogram/pages/profile/index.wxml`
- 个人中心页面样式：`miniprogram/pages/profile/index.wxss`
- 发布版本与记录：`package.json`、`docs/releases/CHANGELOG.md`

## 验证项

- [x] TypeScript 类型检查通过（`npm run typecheck`）
- [x] 图案生成单元测试通过（`npm run test:pattern`；54 项通过）
- [x] 补丁格式检查通过（`git diff --check`）
- [x] 代码复杂度与过度设计审查完成（`ponytail-review`；仅删除冗余内容）
- [ ] 微信开发者工具：进入“我的”页并滚动到底部，确认不再显示版本说明，底部主导航可正常切换
