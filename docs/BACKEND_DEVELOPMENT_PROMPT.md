# OrcaTerm AI 后端分阶段开发提示词

下面的提示词用于让 OrcaTerm AI 在当前 `pindou-studio` 仓库内分阶段开发后端。建议一次只执行一个阶段，每个阶段完成并验收后，再继续下一阶段。

```text
你现在是“拼豆工作室”项目的资深后端工程师。请在当前 pindou-studio 仓库内开发后端，不要创建新的 Git 仓库，不要把后端代码放入 miniprogram/。

【项目目录约定】
仓库根目录：当前工作区根目录
小程序代码：miniprogram/
后端代码：server/
API 契约：docs/API_SPEC.md
数据库设计：docs/DATABASE_DESIGN.md
建表提示词：docs/DATABASE_CREATE_PROMPT.md

【最高优先级规则】
1. 先读取并遵守仓库根目录 AGENTS.md，以及 docs/API_SPEC.md、docs/DATABASE_DESIGN.md。
2. API_SPEC.md 是接口行为的唯一来源；DATABASE_DESIGN.md 是数据模型的唯一来源。
3. 所有数据库物理表名必须使用已经创建的 pindou_ 前缀表名。
4. DBeaver 已经创建了 10 张表。开发前先只读检查真实数据库类型、版本、表结构、字段、索引、外键、CHECK 约束和注释。
5. 禁止重新建表、DROP TABLE、TRUNCATE、覆盖已有表或删除业务数据。
6. 如果真实数据库结构与设计文档不一致，先输出差异并停止，等待确认，不要自行修改数据库。
7. 不要实现文档中明确暂缓的功能：generations、服务端下载文件、云同步开关、反馈、作品改名、注销账号、公开分享。
8. 一次只执行当前指定阶段。阶段完成后停止，输出修改文件、接口、测试结果、未解决问题和下一阶段建议，等待下一条指令。
9. 不安装不必要的依赖。新增依赖前先说明用途、版本和替代方案。
10. 不提交密钥、微信 AppSecret、数据库密码或真实 token；使用 .env.example 说明配置名。

【推荐技术边界】
- 如果仓库没有现成后端技术栈，使用 Node.js + TypeScript。
- 选择轻量、稳定、与当前项目匹配的 HTTP 框架和数据库驱动；选择前先检查本机 Node/npm 版本和数据库类型。
- 不为了“架构完整”引入微服务、消息队列、Redis、对象存储 SDK 或异步任务系统。
- 如果需要使用某个框架、ORM、数据库驱动或微信支付 SDK，先读取其当前官方文档，并锁定兼容版本。
- 后端应有清晰的模块边界，但不要为尚未实现的功能创建空模块。

【后端目录建议】
server/
├── src/
│   ├── config/          # 环境变量和运行配置
│   ├── db/              # 数据库连接、查询和事务封装
│   ├── http/            # HTTP 应用、鉴权中间件、错误处理
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── files/
│   │   ├── works/
│   │   ├── favorites/
│   │   ├── quota/
│   │   ├── downloads/
│   │   └── payments/
│   └── shared/          # ID、时间、分页、错误和校验工具
├── test/
├── .env.example
├── package.json
├── tsconfig.json
└── README.md

目录可以根据实际技术栈调整，但要保持模块职责清楚，避免创建一个超过 800 行的单体文件。

【通用接口要求】
- 使用 JSON 请求和响应；上传接口使用 multipart/form-data。
- 需要登录的接口使用 Authorization: Bearer <token>。
- 从 token 识别当前用户，禁止接受请求体或 query 中的 userId 作为数据归属依据。
- 时间由服务端生成，API 返回 ISO 8601 时间，数据库统一保存 UTC。
- 分页使用 page 和 pageSize，默认 page=1、pageSize=20，最大 pageSize=50。
- 错误响应遵循 API_SPEC.md 的 error.code、message、requestId、details 结构。
- 对重复请求使用 Idempotency-Key；重复请求不能重复创建作品、重复扣额度或重复发放支付额度。
- 日志中不得出现 openid、session_key、AppSecret、token 明文、数据库密码和支付签名。

【图案数据要求】
服务端保存的图案必须是：
- schemaVersion
- width
- height
- settings.colorLimit
- settings.brand
- palette：[{ code, color }]
- cells：一维整数数组

cells 按行优先排列，长度必须严格等于 width * height；-1 表示透明格，其他值必须是 palette 的有效下标。

不得保存当前前端 PatternCell[] 对象数组，不得保存 sourceImagePath，不得把原始上传图片当作历史恢复依据。

服务端必须根据图案重新计算 beadCount 和 colorCount，不信任客户端传入的统计值。

【分阶段开发任务】

====================
阶段 0：后端基础和数据库只读校验
====================

目标：建立可运行的 server/ 基础，不实现业务接口。

任务：
1. 检查当前仓库状态和现有 package.json，不覆盖用户未提交的改动。
2. 检查 Node.js、包管理器和实际数据库连接能力。
3. 新增 server/ 基础工程、TypeScript 配置、环境变量模板和启动脚本。
4. 实现配置加载和启动时配置校验；敏感配置只能从环境变量读取。
5. 连接 DBeaver 中已经创建的数据库，执行只读元数据检查。
6. 确认 10 张表都存在且名称分别为：
   pindou_users
   pindou_auth_sessions
   pindou_file_assets
   pindou_works
   pindou_work_patterns
   pindou_favorites
   pindou_download_records
   pindou_quota_transactions
   pindou_packages
   pindou_orders
7. 实现 GET /health，返回服务状态和数据库连接状态，但不得泄露连接字符串。
8. 增加最小启动、配置和健康检查测试。

阶段 0 验收：
- server 可以启动和停止。
- /health 正常返回。
- 10 张表全部通过只读校验。
- 没有执行任何建表、删表、改表或数据修改操作。

完成后停止并报告。

====================
阶段 1：用户登录和鉴权
====================

目标：实现 API_SPEC.md 中的用户基础能力。

接口：
- POST /api/auth/login
- GET /api/users/me

任务：
1. POST /api/auth/login 接收 wx.login() 返回的 code。
2. 服务端使用环境变量中的微信配置向微信换取 openid/session_key。
3. 使用 openid_hash 查找或创建 pindou_users，不把 openid 和 session_key 返回给客户端。
4. nickname 和 avatar_url 初始允许为 null，不要假设微信登录自动返回真实昵称和头像。
5. 创建随机 opaque token；数据库只保存 token_hash 到 pindou_auth_sessions。
6. 实现 Bearer token 鉴权中间件，校验 token_hash、expires_at 和 revoked_at。
7. GET /api/users/me 返回用户资料、作品数、收藏数、下载数和额度摘要。
8. 所有数据库查询使用参数化查询或 ORM 参数绑定，禁止拼接用户输入。
9. 对无效 code、微信服务失败、重复登录、过期 token 返回规范错误。
10. 增加登录成功、登录失败、鉴权成功、鉴权失败测试；测试日志不得打印敏感值。

阶段 1 验收：
- 同一个微信 openid 不会创建重复用户。
- token 能访问 /api/users/me，过期或撤销 token 不能访问。
- nickname/avatar_url 为 null 时响应仍合法。
- API 不接受客户端传入的 userId 作为归属依据。

完成后停止并报告。

====================
阶段 2：封面文件和作品 CRUD
====================

目标：支持保存作品、作品列表、详情恢复和删除。

接口：
- POST /api/files/upload
- POST /api/works
- GET /api/works
- GET /api/works/:id
- DELETE /api/works/:id

任务：
1. POST /api/files/upload 第一版只允许 type=cover。
2. 校验文件真实 MIME、扩展名、大小和图片可解码性；不保存原始图片。
3. 将封面上传到配置好的对象存储；数据库只写入 pindou_file_assets 元数据。
4. POST /api/works 只接受 coverFileId 和 PersistedPattern，不接受任意 coverUrl、sourceImagePath 或客户端统计值。
5. 校验 coverFileId 属于当前用户，校验 PersistedPattern 的 schema、尺寸、palette、cells 和索引范围。
6. 在同一事务中写入 pindou_works 和 pindou_work_patterns。
7. 从图案数据重新计算 bead_count、color_count、width、height。
8. GET /api/works 只返回作品摘要，不加载完整 cells。
9. GET /api/works/:id 返回完整 pattern，使历史作品不依赖原图即可恢复。
10. DELETE /api/works/:id 按当前用户校验归属，优先软删除作品；不得级联删除额度流水和已支付订单。
11. 使用 Idempotency-Key 防止保存作品网络重试产生重复作品。
12. 增加上传、图案校验、作品归属、列表分页、历史恢复、删除和幂等测试。

阶段 2 验收：
- 128×128 图案保存的是 16384 个整数，不是 16384 个对象。
- 删除本地临时图片后，GET /api/works/:id 仍能恢复完整网格。
- 用户 A 不能读取、删除或绑定用户 B 的作品和文件。
- 作品列表响应不携带完整 pattern。

完成后停止并报告。

====================
阶段 3：收藏
====================

目标：实现作品收藏和收藏列表。

接口：
- PATCH /api/works/:id/favorite
- GET /api/favorites

任务：
1. 收藏关系写入 pindou_favorites。
2. 使用 (user_id, work_id) 唯一约束保证重复收藏幂等。
3. 只允许当前用户操作其有权限访问的作品。
4. 收藏列表只返回作品摘要，不返回完整 pattern。
5. 支持 query、page、pageSize，并按最近收藏时间排序。
6. 增加重复收藏、取消收藏、跨用户访问和分页测试。

完成后停止并报告。

====================
阶段 4：下载额度和下载记录
====================

目标：记录客户端导出，并可靠扣除额度。

接口：
- GET /api/quota/me
- GET /api/downloads
- POST /api/downloads

任务：
1. GET /api/quota/me 从 pindou_quota_transactions 汇总今日免费额度、购买额度和剩余额度。
2. 按 Asia/Shanghai 自然日计算 daily_grant 和 usedToday，数据库仍保存 UTC 时间。
3. 默认先消耗今日免费额度，再消耗 purchased 额度。
4. POST /api/downloads 要求 Idempotency-Key。
5. 在同一数据库事务中校验作品归属、锁定额度、写 pindou_download_records、写 amount=-1 的 pindou_quota_transactions。
6. 额度不足返回 402 QUOTA_INSUFFICIENT，不写下载记录和负数流水。
7. GET /api/downloads 只返回记录，不返回 fileUrl；第一版图片由客户端 Canvas 导出。
8. 保留 work_title_snapshot，使作品删除后下载历史仍可读。
9. 并发下载不能把额度扣成负数；根据数据库能力使用事务锁或等价方案。
10. 增加每日免费额度、购买额度、并发扣减、额度不足、重复请求和跨用户访问测试。

完成后停止并报告。

====================
阶段 5：套餐和微信支付
====================

目标：支持套餐读取、创建支付订单和支付回调发放额度。

接口：
- GET /api/packages
- POST /api/payments/create
- POST /api/payments/notify

任务：
1. GET /api/packages 返回 pindou_packages 中 enabled=true 的套餐。
2. POST /api/payments/create 只接收 packageId，价格和额度必须从服务端套餐读取。
3. 创建 pindou_orders，保存套餐名称、金额、额度和会员信息快照。
4. 返回微信支付所需参数，但不得把商户密钥、AppSecret 或签名原文返回客户端。
5. /api/payments/notify 只接受微信支付服务器回调，不使用用户 Bearer token。
6. 验证微信回调签名、商户、应用、订单号、金额和支付状态。
7. 支付成功时在事务中更新订单并写入一笔 purchase_grant 额度流水。
8. 重复支付回调不得重复发放额度；同一订单的 purchase_grant 必须幂等。
9. 不允许客户端通过 URL 参数或支付成功页参数直接增加额度。
10. 增加订单金额篡改、重复回调、支付失败、订单不存在和回调验签失败测试。

支付配置不完整时，可以先实现接口骨架、订单状态机和测试替身，但不能伪造生产支付成功。

完成后停止并报告。

====================
阶段 6：后端整体验收和小程序接入准备
====================

目标：完成后端 MVP 的可交付检查，但不扩展业务范围。

任务：
1. 对照 API_SPEC.md 逐个检查 15 个 MVP 接口的路径、方法、鉴权、请求和响应。
2. 检查所有 pindou_ 表的归属校验、外键、唯一约束、索引和事务边界。
3. 检查所有 API 错误格式和 requestId。
4. 补充集成测试：登录 → 保存封面 → 保存作品 → 查询详情 → 收藏 → 下载扣额 → 支付发放额度。
5. 增加 .env.example、server/README.md 和本地启动说明。
6. 增加 API 调试示例，但不得写入真实密钥、真实 token 或生产地址。
7. 运行 typecheck、lint、unit test、integration test、build；没有配置的命令要明确报告。
8. 输出小程序接入清单：token 保存、请求头、PatternCell 转换、历史作品恢复、封面上传和下载调用顺序。
9. 不在本阶段实现 generations、服务端下载 URL、反馈、云同步、改名、注销和分享。

完成后停止并输出最终验收报告。

【每个阶段的固定报告格式】
1. 阶段名称和完成状态。
2. 修改或新增的文件。
3. 新增或变更的接口。
4. 数据库读写的 pindou_ 表。
5. 已执行的命令及结果。
6. 已覆盖的测试场景。
7. 未解决的问题、需要用户提供的配置或外部依赖。
8. 下一阶段可以开始的前置条件。
```
