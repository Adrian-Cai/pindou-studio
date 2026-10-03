# ToAPIs 生图 Provider 迁移实施任务

状态：首轮开发完成，待预发布/生产灰度验收。

## 0. 发布前决策

- [x] 0.1 按配置建议采用首发模型 `gpt-image-2.5-sunburst`。
  - _Requirement: Provider 与配置_
- [x] 0.2 按配置建议采用 `https://api.toapis.cn`；生产 Key 由部署环境注入，结果 hostname 白名单由 `TOAPIS_IMAGE_OUTPUT_HOSTS` 注入。
  - _Requirement: 可靠性与安全_
- [x] 0.3 灰度期间保留混元配置和实现，按任务记录 provider 兼容历史任务。
  - _Requirement: 迁移与发布_

## 1. 需求与合同

- [x] 1.1 将 Provider 公共接口、错误类型和输出格式识别逻辑从混元文件拆到共享模块。
  - _Requirement: Provider 与配置_
- [x] 1.2 定义 `createTask` / `getTask` / `downloadOutput` 的异步任务合同，保持项目 HTTP 响应和小程序状态契约不变。
  - _Requirement: 任务流程_
- [x] 1.3 增加 ToAPIs 配置类型、环境变量示例、启动校验和生产约束。
  - _Requirement: Provider 与配置_

## 2. ToAPIs Provider

- [x] 2.1 实现 ToAPIs 创建任务：Bearer 认证、完整模型 ID、固定生成参数、参考图 URL、`client_business_id`。
  - _Requirement: 任务流程_
- [x] 2.2 实现 ToAPIs 状态查询：pending/queued/in_progress、completed、failed 的严格映射。
  - _Requirement: 任务流程_
- [x] 2.3 实现 429/503/401/403/超时/未知响应的错误归一化和 `Retry-After` 解析。
  - _Requirement: 可靠性与安全_
- [x] 2.4 实现输出 URL 白名单、禁止跳转、大小限制、真实格式校验和下载。
  - _Requirement: 可靠性与安全_

## 3. 任务状态机与输入 URL

- [x] 3.1 给 AI 任务增加 `provider_next_poll_at` 数据库字段和迁移脚本，补齐 schema contract。
  - _Requirement: 任务流程_
- [x] 3.2 改造 AI 任务推进逻辑：提交后轮询任务，完成后下载并收口，轮询失败不重复创建 Provider 任务。
  - _Requirement: 任务流程_
- [x] 3.3 给 AI 文件存储增加安全的 `publicUrl(objectKey)`，让 ToAPIs 获取项目输入图；生产校验 HTTPS 和公网可达性。
  - _Requirement: Provider 与配置_
- [x] 3.4 加入 provider registry/resolver，按任务行的 provider 快照处理混元存量任务，默认只创建 ToAPIs 新任务。
  - _Requirement: 迁移与发布_

## 4. 测试与验证

- [x] 4.1 编写 ToAPIs Provider 单元测试：提交请求体、鉴权、任务状态、响应结构和错误映射。
  - _Requirement: Provider 与配置_
- [x] 4.2 编写安全测试：不受信任输出 URL、非 HTTPS、重定向、超大图片、错误魔数和过期 URL。
  - _Requirement: 可靠性与安全_
- [x] 4.3 编写任务服务测试：pending → completed、pending → failed、429 后重试、重启恢复、额度只扣一次。
  - _Requirement: 任务流程_
- [x] 4.4 执行根类型检查、服务端类型检查、服务端全量测试和 AI 失败契约测试。
  - _Requirement: 迁移与发布_
- [ ] 4.5 使用真实 ToAPIs 测试 Key 完成至少一条参考图生成和一条失败链路验收；禁止把 Key 写入仓库或日志。
  - _Requirement: 迁移与发布_

## 5. 灰度与清理

- [ ] 5.1 在预发布环境验证 ToAPIs 输入图公网可达、任务查询频率、结果下载和无水印完整性。
  - _Requirement: 迁移与发布_
- [ ] 5.2 生产切换新任务到 ToAPIs，保留混元存量任务兼容，观察成功率、延迟、429/503和积压。
  - _Requirement: 迁移与发布_
- [ ] 5.3 排空混元任务后，删除 `HUNYUAN_IMAGE_*` 配置、混元 Provider、旧云函数依赖、旧测试和旧文档。
  - _Requirement: 迁移与发布_
- [ ] 5.4 更新 CHANGELOG、提审说明和运维验收记录，记录实际 ToAPIs 模型、Base URL、灰度结果和回滚点。
  - _Requirement: 迁移与发布_
