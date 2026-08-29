# 拼豆工作室

一个把图片转换成拼豆图纸的微信小程序。当前仓库已经完成原生微信小程序 TypeScript 基础框架，UI 参考稿放在 docs/ui/。

## 开始开发

1. 用微信开发者工具导入仓库根目录。
2. 工具会根据 project.config.json 自动读取 miniprogram/。
3. 如需编辑器类型提示，在仓库根目录执行 npm install。
4. 在开发者工具中编译并预览。

## 目录

- miniprogram/components：通用组件
- miniprogram/config：产品常量与设计配置
- miniprogram/models：领域类型
- miniprogram/pages：页面
- miniprogram/services：微信 API 与后端能力封装
- miniprogram/store：全局轻量状态
- miniprogram/utils：无业务副作用的工具函数

主流程为：首页选择图片 → 图案编辑 → 作品结果 → 下载。登录用户的阶段 2 作品数据已接入自建后端，支持封面上传、保存、列表、详情恢复、编辑更新、改名和删除；游客作品继续保存在本地。收藏和下载记录仍使用本地存储。

## UI 稿约定

- 原始稿继续放在 docs/ui/，不要放进小程序包体。
- 页面级切图放在 miniprogram/assets/images/<page>/。
- 多页面复用图标放在 miniprogram/assets/icons/。
- 文件名使用小写英文和短横线，例如 empty-projects.png。

## 当前页面

- 首页制作：pages/home/index
- 图案编辑：pages/editor/index
- 作品结果：pages/result/index
- 我的作品：pages/projects/index
- 我的：pages/profile/index
- 我的收藏：pages/favorites/index
- 下载记录：pages/downloads/index
- 使用帮助：pages/help/index
- 意见反馈：pages/feedback/index
- 隐私设置：pages/privacy/index
- 关于我们：pages/about/index
- 下载次数：pages/recharge/index
- 支付成功展示：pages/payment-success/index

支付、收藏云同步、文件导出和反馈提交仍需要对应服务配置；页面会明确提示待接入，不会伪造成功状态。
