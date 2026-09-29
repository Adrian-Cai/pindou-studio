# 首页 UI 还原核对

final result: blocked

## 本轮验收（2026-09-29）

### 对照目标与状态

- Source visual: `C:\Users\ImAca\AppData\Local\Temp\codex-clipboard-0ddb4e12-abf2-4c51-ab1d-149c0368b075.png`（415 × 736 像素）。
- Intended state: 首页未滚动，展示 banner、图片/想法入口、流程卡、开始创作按钮和底部 Tab。
- Implementation: `miniprogram/pages/home/index`。
- Simulator screenshot: `C:\Users\ImAca\AppData\Local\Temp\pindou-home-after.png`（461 × 996 像素）；截图显示模拟器设备框和空白页面，没有小程序内容。
- CSS viewport、device pixel ratio 与归一化：无法取得；空白截图不构成有效页面证据。
- State: `wechatide simulator_open_page` 返回首页打开成功；`simulator_screenshot` 有一次返回空白截图，后续及运行时信息调用超时。控制台无运行时错误，只有系统信息和 App.onLaunch 耗时警告。

### 本轮修改与证据

- 将 UI 稿 banner 区域（裁切 `(0, 68, 415, 329)`）用作首页 banner 素材。
- 从 UI 稿裁出流程区三个圆形 icon（各 86 × 75 像素），改为首页流程区 PNG 素材。
- 两张入口卡片改用明确的中文无衬线字体回退；副标题字重设为 500。
- 流程卡按三等分对齐 icon，箭头放在列间。
- Source 与实现截图曾在同一对照输入中打开；实现截图为空白，视口和页面状态不匹配，不能做有效全屏对照。
- 局部裁切预览：`C:\Users\ImAca\AppData\Local\Temp\pindou-home-crops-preview\hero.png`、`step-inspiration.png`、`step-reference.png`、`step-pattern.png`。裁切确认没有包含状态栏、icon 标签或箭头；当前没有有效实现截图用于局部对照。

### Findings

- [P1] 首页运行态视觉无法验收
  - Location: `miniprogram/pages/home/index`。
  - Evidence: 小程序模拟器截图为空白，后续截图与运行时查询超时。
  - Impact: 无法确认新 banner、icon、字体和布局在实际小程序里的呈现。
  - Fix: 在模拟器能正常渲染首页时，按相同 CSS 视口重新截图并完成全屏与 icon/文字局部对照。

### Checks

- [x] `wechatide compile_wxml` 首页模板编译。
- [x] `wechatide compile_wxss` 首页样式编译。
- [x] `npm run typecheck`。
- [x] `npm run test:assets`。
- [x] 检查模拟器控制台；没有运行时错误。
- [ ] 首页有效运行截图及设计对照（模拟器截图为空白，自动化接口超时）。
- [ ] lint/build（根 `package.json` 未配置对应脚本）。

## 上一轮记录（历史）

- Earlier source visual: `C:\Users\ImAca\AppData\Local\Temp\codex-clipboard-58ed89d4-cfec-41fd-82a0-0a06fed96e7d.png`（936 × 1664 像素）。
- Earlier issue: 当时环境未发现微信开发者工具或 CLI，未捕获实现截图，因此同样无法完成有效视觉对照。
- Earlier checks: `npm run typecheck`、`test:pattern`、`test:assets`、`test:ai-failure`、`test:auth-store-logout`。
- Earlier implementation status remains superseded by the current首页 iteration above.
