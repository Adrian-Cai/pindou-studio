# CODE_RULES.md

# 代码质量规范

## 复用原则

优先级：

1. 已有代码
2. 已有依赖
3. 平台能力
4. 新增代码

---

# 依赖管理

禁止：

无需求新增依赖

---

# TypeScript

要求：

- 类型明确
- 避免any
- 保持类型安全

---

# 数据管理

禁止：

业务数据写入页面

推荐：

data/

config/

services/

---

# 文件大小

限制：

页面：

300行以内

组件：

500行以内

最大：

800行

超过：

必须拆分

---

# 简洁原则

优先：

简单实现

禁止：

过度封装

---

# 提交信息规范

格式：

`<type>(<scope>): <简体中文简述>`

详细白名单与示例见 docs/development/COMMIT_CONVENTION.md

---

# 注释规范

要求：

中文注释，术语保留英文（jobId、token、quota、COS 等）

粒度：

1. 文件头：职责 / 边界 / 调用方 / 关键点
2. 导出的函数、类、常量、类型：JSDoc，1~3 行
3. 行内：复杂分支、魔法值与阈值、状态机迁移、错误码映射、重试与并发控制、坐标换算、SQL 与外部 API 调用

禁止：

废话注释（`// 定义变量`、`i++ // 自增`）

禁止：

为加注释改动逻辑代码，注释提交必须 0 删除行

---

# 注释覆盖范围

已覆盖（P0 / P1 / P2 主链路）：

- P0 AI 生成：小程序 `services/ai-generation-*`、`hunyuan-image-service`、`content-security-service`、`packages/ai-generation`；服务端 `modules/ai/*`、`modules/files/{ai-file-storage,image-validation}`；云函数 `generateImage`
- P1 转换与编辑：`services/pattern-generation/*`、`work-service`、`image-service`、`download-service`、`packages/editor`、`packages/result`、`pages/projects`、`models/pattern`；服务端 `modules/works/*`
- P2 账户支付配额：`store/auth-store`、`services/{auth-service,payment-service}`、`packages/payment/*`、`packages/account/index`、`packages/account/favorites`；服务端 `modules/{payments,users,quota,downloads,auth}`

未覆盖：

上述链路之外的页面、组件与服务端基础设施，按需补
