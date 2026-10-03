# 项目文档导航

本目录按文档职责分类查找资料时先从本页进入，避免在各业务目录中重复维护同一类说明

## 快速入口

| 需要了解 | 优先阅读 |
| --- | --- |
| 项目是什么、用户怎样使用 | [产品流程](product/PRODUCT_FLOW.md) |
| 当前系统怎样运行 | [当前系统架构](architecture/CURRENT_ARCHITECTURE.md) |
| 小程序 UI 与页面实现规则 | [根目录设计规范](../design.md)、[UI 开发规则](frontend/UI_RULES.md) |
| 微信小程序专项要求 | [小程序开发规则](frontend/MINI_PROGRAM_RULES.md) |
| 后端接口与数据结构 | [API 规范](backend/API_SPEC.md)、[OpenAPI 文件](backend/openapi.yaml)、[数据库结构](backend/database/DATABASE_SCHEMA.md) |
| 本地开发与代码约束 | [代码质量规范](development/CODE_RULES.md) |
| 当前版本与历史变更 | [版本记录](releases/CHANGELOG.md) |
| 登录、支付和生产验收 | [微信登录配置](backend/operations/WECHAT_LOGIN_SETUP.md)、[支付与 AI 生产验收](backend/operations/PRODUCTION_PAYMENT_AI_ACCEPTANCE.md) |

## 目录分类

### `product/`：产品与业务

- [PRODUCT_FLOW.md](product/PRODUCT_FLOW.md)：产品定位、页面职责和完整用户流程
- [PRICING_PLAN.md](product/PRICING_PLAN.md)：额度、套餐与定价方案

### `frontend/`：小程序与 UI

- [UI_RULES.md](frontend/UI_RULES.md)：布局、导航栏、安全区、滚动和视觉验收规则
- [MINI_PROGRAM_RULES.md](frontend/MINI_PROGRAM_RULES.md)：微信小程序适配、性能、图片和弱网规范
- [`pattern-engine/`](frontend/pattern-engine/)：Standard Pattern Engine V2 的总体方案和阶段实施记录

UI 设计稿、运行截图和对比资料保存在 [`ui/`](ui/) 与 [`ui-comparisons/`](ui-comparisons/)；全局设计 token 的事实来源仍是根目录 [design.md](../design.md)

### `backend/`：服务端、接口与数据

- [API_SPEC.md](backend/API_SPEC.md)：后端接口范围和请求响应约束
- [openapi.yaml](backend/openapi.yaml)：可导入 Apifox 的 OpenAPI 3.1 机器可读接口规范
- [FAVORITES_BACKEND_DESIGN.md](backend/FAVORITES_BACKEND_DESIGN.md)：收藏软删除、收藏时间语义、接口幂等与迁移设计基线
- [AI_GENERATION_DESIGN.md](backend/AI_GENERATION_DESIGN.md)：Ai 模式的接入设计
- [PRIVACY_API_PLAN.md](backend/PRIVACY_API_PLAN.md)：隐私相关接口规划
- [拼豆工作室 · 小程序后端 API 需求审计.md](backend/拼豆工作室%20·%20小程序后端%20API%20需求审计.md)：后端 API 需求与边界审计
- [`database/`](backend/database/)：数据库设计、当前 Schema 与 ER 图
- [`operations/`](backend/operations/)：微信登录配置及生产环境验收说明

### `architecture/`：系统架构

- [CURRENT_ARCHITECTURE.md](architecture/CURRENT_ARCHITECTURE.md)：当前运行时架构基线
- [README.md](architecture/README.md)：架构可视化快照说明及事实来源边界
- `pindou-runtime.*`：历史架构可视化与视觉检查产物

### `development/`：研发规范与维护记录

- [CODE_RULES.md](development/CODE_RULES.md)：TypeScript、依赖、复用和文件规模规范
- [PONYTAIL_OPTIMIZATION_PLAN.md](development/PONYTAIL_OPTIMIZATION_PLAN.md)：复杂度与过度设计优化记录

### `releases/`：版本与发布

- [CHANGELOG.md](releases/CHANGELOG.md)：统一版本记录
- [MINI_PROGRAM_RELEASE_0.19.0.md](releases/MINI_PROGRAM_RELEASE_0.19.0.md)：0.19.0 提交说明
- [MINI_PROGRAM_RELEASE_0.22.0.md](releases/MINI_PROGRAM_RELEASE_0.22.0.md)：0.22.0 提交说明
- [MINI_PROGRAM_RELEASE_0.24.0.md](releases/MINI_PROGRAM_RELEASE_0.24.0.md)：0.24.0 提交说明
- [MINI_PROGRAM_RELEASE_0.25.0.md](releases/MINI_PROGRAM_RELEASE_0.25.0.md)：0.25.0 提交说明
- [MINI_PROGRAM_RELEASE_0.25.1.md](releases/MINI_PROGRAM_RELEASE_0.25.1.md)：0.25.1 提交说明
- [MINI_PROGRAM_RELEASE_0.25.2.md](releases/MINI_PROGRAM_RELEASE_0.25.2.md)：0.25.2 提交说明
- [MINI_PROGRAM_RELEASE_0.25.3.md](releases/MINI_PROGRAM_RELEASE_0.25.3.md)：0.25.3 提交说明
- [MINI_PROGRAM_RELEASE_0.25.4.md](releases/MINI_PROGRAM_RELEASE_0.25.4.md)：0.25.4 提交说明
- [MINI_PROGRAM_RELEASE_0.25.5.md](releases/MINI_PROGRAM_RELEASE_0.25.5.md)：0.25.5 提交说明
- [MINI_PROGRAM_RELEASE_0.25.6.md](releases/MINI_PROGRAM_RELEASE_0.25.6.md)：0.25.6 提交说明
- [MINI_PROGRAM_RELEASE_0.25.7.md](releases/MINI_PROGRAM_RELEASE_0.25.7.md)：0.25.7 提交说明
- [MINI_PROGRAM_RELEASE_0.25.8.md](releases/MINI_PROGRAM_RELEASE_0.25.8.md)：0.25.8 提交说明
- [MINI_PROGRAM_RELEASE_0.25.9.md](releases/MINI_PROGRAM_RELEASE_0.25.9.md)：0.25.9 提交说明
- [MINI_PROGRAM_RELEASE_0.25.10.md](releases/MINI_PROGRAM_RELEASE_0.25.10.md)：0.25.10 提交说明
- [MINI_PROGRAM_RELEASE_0.25.13.md](releases/MINI_PROGRAM_RELEASE_0.25.13.md)：0.25.13 提交说明
- [MINI_PROGRAM_RELEASE_0.25.14.md](releases/MINI_PROGRAM_RELEASE_0.25.14.md)：0.25.14 提交说明
- [MINI_PROGRAM_RELEASE_0.25.15.md](releases/MINI_PROGRAM_RELEASE_0.25.15.md)：0.25.15 提交说明
- [MINI_PROGRAM_RELEASE_0.25.16.md](releases/MINI_PROGRAM_RELEASE_0.25.16.md)：0.25.16 提交说明
- [MINI_PROGRAM_RELEASE_0.29.0.md](releases/MINI_PROGRAM_RELEASE_0.29.0.md)：0.29.0 提交说明
- [MINI_PROGRAM_RELEASE_0.29.1.md](releases/MINI_PROGRAM_RELEASE_0.29.1.md)：0.29.1 提交说明
- [MINI_PROGRAM_RELEASE_0.29.2.md](releases/MINI_PROGRAM_RELEASE_0.29.2.md)：0.29.2 提交说明
- [MINI_PROGRAM_RELEASE_0.29.3.md](releases/MINI_PROGRAM_RELEASE_0.29.3.md)：0.29.3 提交说明

### 其他资料目录

- [`submission/`](submission/)：比赛、审核或其他对外提交材料
- [`ui/`](ui/)：页面设计稿与验收截图
- [`ui-comparisons/`](ui-comparisons/)：局部 UI 运行对比图

## 维护约定

1. 新文档按职责进入现有分类，不再直接堆放在 `docs/` 根目录
2. 同一主题只保留一个事实来源；阶段记录应链接到上位设计，不复制整份规范
3. 文档移动或重命名时，同步更新 `AGENTS.md`、项目 README、源码提示和文档内部引用
4. 版本变化统一写入 `releases/CHANGELOG.md`，单版本提交说明放在 `releases/`
5. 截图和可视化文件与对应说明放在同一资料目录，并避免进入小程序运行包
