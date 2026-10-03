# ToAPIs 到腾讯 TokenHub 混元 Hy-Image-3.5 任务清单

## 需求与兼容

- [x] 新任务切换到 TokenHub Hy-Image-3.5，保留 ToAPIs 与 CloudBase Provider 用于旧任务快照收口。
- [x] 新任务模型固定，不由客户端覆盖；不传可选 `footnote`。
- [ ] 发布前核对 TokenHub 账户权限、额度、并发、预算与真实 Key。
- [ ] 发布前只读核对生产 ToAPIs queued/processing 任务数量。

## 服务端

- [x] 增加 TokenHub 同步图生图 Provider、配置解析与生产启动校验。
- [x] 新任务固定选择 TokenHub；保留旧 Provider 注册表映射。
- [x] 立即下载临时图，验证地址、下载大小和图像格式后持久化。
- [x] 补充 TokenHub Provider 请求与错误映射测试，以及新任务路由/额度测试。
- [x] 执行根目录与服务端 typecheck、服务端 test（包含 build）。

## 文档与发布

- [x] 更新接口、运维、第三方共享清单、隐私政策、个人信息清单和服务端配置文档。
- [x] 更新根项目/服务端版本与 CHANGELOG。
- [ ] 预发布真实生成测试：不发送 `footnote`，确认输出、耗时、临时 URL 下载和服务端标记表现。
- [ ] 发布后监控新 TokenHub 调用和旧 ToAPIs 队列。
- [ ] 旧任务排空后，删除 ToAPIs Provider、环境变量、测试和文档引用。
