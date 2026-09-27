# ToAPIs 到腾讯 TokenHub 混元 Hy-Image-3.5 迁移需求

## 目标

所有新 AI 生图任务统一调用腾讯 TokenHub Hy-Image-3.5 (`hy-image-v3.5-preview`)，不再将 ToAPIs 用作新任务 Provider。小程序仍只调用项目自己的任务接口，生成状态、结果存储和额度规则保持不变。

迁移期间保留 ToAPIs Provider，仅用于处理数据库中已记录为 `provider=toapis` 的在途任务。待生产队列确认排空后，再删除其实现和凭据配置。CloudBase `hunyuan` 也保留用于兼容已有任务记录。

## 用户故事

- 作为用户，我提交 AI 生图后由腾讯混元生成，无需更换小程序操作流程。
- 作为运维人员，我能在服务端独立配置 TokenHub Key，并确认新请求不再到达 ToAPIs。
- 作为已有任务的用户，升级服务后，在途 ToAPIs 任务仍按其持久化 Provider 继续查询和收口。

## 功能要求

1. 新建任务记录固定保存 `provider=hunyuan-tokenhub-v35`、`model=hy-image-v3.5-preview`，不接受客户端指定 Provider 或模型。
2. 服务端通过 `POST /v1/wand/hunyuan-image/v35-generation` 使用 TokenHub 同步接口；请求包含服务端固定 Prompt、参考图 URL、`size=1024x1024` 和任务 ID 作为 session。
3. 请求不包含可选 `footnote`；项目不主动请求该自定义文字水印。
4. 从 `choices[0].delta.image.url` 读取临时结果，下载到项目存储后才向客户端返回项目文件 URL；临时供应商 URL 不持久暴露。
5. 只有输出下载、图片格式校验、文件持久化和任务成功更新均完成后，才扣一次 AI 额度。
6. 对 422 内容拒绝、429 限流、超时、鉴权失败、无效响应、非可信输出 URL、超大或格式错误图片返回既有稳定错误契约。
7. 保留旧任务 Provider 快照映射；服务重启后不得把旧任务提交给 TokenHub 或其他 Provider。
8. API Key 只从服务端环境读取，不写入日志、接口响应或小程序包。

## 非目标

- 多 Provider 轮询、额度耗尽自动回退或客户端可选模型。
- 修改小程序任务协议、Prompt 业务参数、数据库结构或额度规则。
- 在不能确认旧 ToAPIs 队列排空时删除其在途任务处理代码。

## 验收条件

- 新建任务落库 Provider/model 为 TokenHub Hy-Image-3.5；ToAPIs 不接收新任务。
- TokenHub 请求体不含 `footnote`；响应 URL 被立即下载并写入项目文件存储。
- TokenHub 失败或图片校验失败不扣用户额度；成功任务只扣一次。
- 旧 ToAPIs 快照任务仍通过 ToAPIs 处理器完成。
- `.env.example`、第三方共享清单、运维验收及接口文档说明新供应商和在途兼容期。

## 外部上线前置项

- 配置 TokenHub 生产 Key，并确认账号权限、可用额度、计费、并发限制与预算。
- 预发布使用省略 `footnote` 的真实请求核验图片输出和腾讯服务端是否添加其他标记；本次代码不主张图片一定没有其他服务端标记。
- 发布前只读核对 `pindou_ai_generation_jobs` 中 queued/processing 的 ToAPIs 任务；排空后可单独移除 ToAPIs Provider 与凭据。
