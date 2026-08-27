# OrcaTerm AI 建表提示词

下面的提示词可以直接复制给 OrcaTerm AI。它要求先识别数据库类型、检查现有表，再生成并执行迁移，避免误删已有数据。

```text
你是“拼豆工作室”项目的资深数据库工程师。请根据下面的规则，为第一版微信小程序后端创建数据库表和迁移脚本。

【参考文档】
- docs/API_SPEC.md
- docs/DATABASE_DESIGN.md

如果你能访问项目文件，请先读取以上两个文件；如果不能读取，请以本提示词为准。不要自行扩展业务表。

【硬性命名规则】
1. 所有物理表名必须以 pindou_ 开头。
2. 必须创建以下 10 张表：
   - pindou_users
   - pindou_auth_sessions
   - pindou_file_assets
   - pindou_works
   - pindou_work_patterns
   - pindou_favorites
   - pindou_download_records
   - pindou_quota_transactions
   - pindou_packages
   - pindou_orders
3. 禁止创建 users、works、orders、packages 等没有 pindou_ 前缀的同名表。
4. 字段名使用 snake_case。
5. 主键使用应用层生成的 varchar(32) ID，格式示例：usr_xxx、ses_xxx、file_xxx、work_xxx、dl_xxx、qt_xxx、order_xxx。

【表用途说明】
请把下面的用途写入数据库表注释，并在最终数据字典中再次说明：
- pindou_users：用户主表，保存微信用户与本系统用户的对应关系、昵称和头像。
- pindou_auth_sessions：登录会话表，保存 token 摘要、有效期和失效状态。
- pindou_file_assets：文件资产表，保存对象存储中的作品封面地址和文件元数据。
- pindou_works：作品主表，保存作品归属、标题、封面、尺寸和统计摘要。
- pindou_work_patterns：作品图案表，保存完整的颜色表和网格颜色索引，用于历史作品恢复。
- pindou_favorites：收藏关系表，记录哪个用户收藏了哪个作品。
- pindou_download_records：下载记录表，记录用户导出了哪个作品、哪种类型以及是否扣额度。
- pindou_quota_transactions：额度流水表，记录免费发放、购买、下载扣减、退款和人工调整。
- pindou_packages：充值套餐表，保存可购买套餐的名称、价格、额度和会员配置。
- pindou_orders：支付订单表，保存微信支付订单、金额、状态和支付回调信息。

【数据库注释要求】
1. 每张表都必须有表注释，说明“这是什么表”和“主要用于什么业务”。
2. 每个字段都必须有字段注释，使用中文说明字段含义、取值来源、是否允许为空，以及它和哪个业务流程有关。
3. PostgreSQL 使用 COMMENT ON TABLE / COMMENT ON COLUMN；MySQL 使用 CREATE TABLE 的 COMMENT 和字段 COMMENT；其他数据库使用等价的原生注释能力。
4. 如果当前数据库不支持数据库注释，必须在迁移输出中单独生成一份 Markdown 数据字典，不要静默跳过注释。
5. 注释不能只写“用户 ID”“状态”这类无上下文描述；例如 user_id 应说明“关联 pindou_users.id，用于校验数据归属”。
6. 迁移执行完成后，逐张表、逐字段检查注释是否存在，并输出缺失项。

【执行前必须检查】
1. 识别当前数据库产品和版本，例如 PostgreSQL、MySQL 或其他数据库。
2. 只读检查上述表、无前缀同名表、索引、外键和约束是否已经存在。
3. 如果发现已有业务数据、结构冲突或无法安全迁移，先输出冲突清单并停止；禁止 DROP、TRUNCATE、覆盖表或删除数据。
4. 如果数据库不支持 JSON/JSONB、CHECK 约束、部分索引或某个字段类型，说明替代方案和影响，等待确认后再执行，不要静默改写。

【表结构】

一、pindou_users
- id varchar(32) primary key：用户主表的唯一 ID，由应用层生成，例如 usr_xxx。
- openid_hash varchar(128) not null unique：微信 openid 的不可逆摘要，用于登录时查找用户；不直接对外返回。
- openid_ciphertext text nullable：经过加密保存的微信 openid 原值，可选；加密密钥不能存入数据库。
- nickname varchar(80) nullable：用户昵称；微信登录成功后不保证立即拥有，允许为空。
- avatar_url text nullable：用户头像地址；允许为空，不能假设登录后一定存在。
- created_at timestamp not null：用户记录创建时间，由服务端或数据库生成，统一保存 UTC。
- updated_at timestamp not null：用户记录最近更新时间，用于数据变更追踪。
- deleted_at timestamp nullable：用户软删除时间；第一版未开放注销接口，暂作为预留字段。

二、pindou_auth_sessions
- id varchar(32) primary key：登录会话的唯一 ID，由应用层生成，例如 ses_xxx。
- user_id varchar(32) not null，外键引用 pindou_users.id：会话所属用户，用于把 token 绑定到用户。
- token_hash varchar(128) not null unique：本系统访问 token 的摘要；数据库不保存明文 token。
- expires_at timestamp not null：token 失效时间，用于拒绝过期请求和清理旧会话。
- revoked_at timestamp nullable：会话被主动注销或强制失效的时间；为空表示未主动失效。
- created_at timestamp not null：会话创建时间，用于审计登录记录。
- last_used_at timestamp nullable：最近一次使用会话的时间，可用于安全审计和清理长期不用的会话。

三、pindou_file_assets
- id varchar(32) primary key：文件资产的唯一 ID，由应用层生成，例如 file_xxx。
- user_id varchar(32) not null，外键引用 pindou_users.id：文件所有者，用于校验谁可以绑定和读取该文件。
- file_type varchar(20) not null，第一版只能是 cover：文件业务类型；第一版仅保存作品封面/预览图。
- object_key varchar(512) not null unique：对象存储中的唯一路径，不应暴露本地文件系统路径。
- public_url text not null：客户端读取封面时使用的 CDN 或对象存储访问地址。
- content_type varchar(100) not null：文件真实 MIME 类型，例如 image/png；用于文件安全校验。
- byte_size bigint not null：文件大小，单位为字节，用于限制上传大小和存储统计。
- width integer nullable：图片像素宽度；读取失败时可为空，不影响文件资产本身保存。
- height integer nullable：图片像素高度；读取失败时可为空，不影响文件资产本身保存。
- created_at timestamp not null：文件上传并校验成功的时间。
- deleted_at timestamp nullable：文件资产标记删除的时间，用于异步清理对象存储文件。

四、pindou_works
- id varchar(32) primary key：作品的唯一 ID，由应用层生成，例如 work_xxx。
- user_id varchar(32) not null，外键引用 pindou_users.id：作品所有者，所有作品查询和修改都必须按此字段校验归属。
- title varchar(120) not null：作品名称；第一版默认“未命名作品”。
- cover_file_id varchar(32) not null，外键引用 pindou_file_assets.id：作品封面文件，必须属于同一个 user_id。
- width smallint not null：拼豆图案宽度，单位为格；必须与 pindou_work_patterns.width 一致。
- height smallint not null：拼豆图案高度，单位为格；必须与 pindou_work_patterns.height 一致。
- bead_count integer not null：非透明格数量，由服务端根据 cells_json 重算，不能信任客户端传值。
- color_count smallint not null：实际使用的颜色数量，由服务端根据 palette_json 和 cells_json 重算。
- brand varchar(40) not null：拼豆品牌或色号体系，例如 MARD；来源于图案设置。
- status varchar(20) not null，只能是 draft 或 completed：作品状态，用于区分草稿和已完成作品。
- created_at timestamp not null：作品首次保存时间，由服务端生成。
- updated_at timestamp not null：作品最近保存或更新的时间，用于作品列表排序。
- deleted_at timestamp nullable：作品软删除时间；删除后默认不再出现在普通作品列表。

五、pindou_work_patterns
- work_id varchar(32) primary key，外键引用 pindou_works.id：对应作品 ID；一份作品只能有一份当前图案数据。
- schema_version smallint not null，当前为 1：图案 JSON 结构版本，未来升级结构时用于兼容历史作品。
- width smallint not null：图案网格宽度，单位为格；必须与 cells_json 长度校验逻辑一致。
- height smallint not null：图案网格高度，单位为格；必须与 cells_json 长度校验逻辑一致。
- color_limit smallint not null：生成图案时允许使用的最大颜色数，是原始设置快照。
- brand varchar(40) not null：生成图案时使用的拼豆品牌或色号体系。
- palette_json JSON/JSONB not null：颜色表数组，每项包含 code 和 color，避免每个格子重复保存颜色对象。
- cells_json JSON/JSONB not null：按行优先排列的一维颜色索引数组；-1 表示透明格，其他整数指向 palette_json 下标。
- created_at timestamp not null：图案数据首次保存时间。
- updated_at timestamp not null：图案数据最近更新时间。

图案数据规则：
- palette_json 示例：[ {"code":"C01", "color":"#f4d7bf"} ]
- cells_json 是按行优先排列的一维整数数组。
- -1 表示透明格；0 到 palette_json 长度减 1 表示颜色索引。
- cells_json 长度必须严格等于 width * height。
- 最大尺寸为 128 * 128。
- 禁止创建每个格子一行的 cells 明细表。

六、pindou_favorites
- user_id varchar(32) not null，外键引用 pindou_users.id：执行收藏操作的用户。
- work_id varchar(32) not null，外键引用 pindou_works.id：被收藏的作品。
- created_at timestamp not null：收藏关系建立时间，用于“最近收藏”排序。
- primary key (user_id, work_id)

七、pindou_download_records
- id varchar(32) primary key：下载记录的唯一 ID，由应用层生成，例如 dl_xxx。
- user_id varchar(32) not null，外键引用 pindou_users.id：执行导出的用户。
- work_id varchar(32) nullable，外键引用 pindou_works.id：被导出的作品；作品删除后允许置空以保留下载历史。
- work_title_snapshot varchar(120) not null：导出时的作品名称快照，避免作品改名或删除后历史记录失去可读名称。
- file_type varchar(20) not null，只能是 preview、chart、materials：客户端导出的文件类型，分别表示成品图、施工图和材料清单。
- consumed_quota boolean not null：本次导出是否实际扣除额度；第一版由服务端决定，客户端不能直接传入覆盖。
- quota_transaction_id varchar(32) nullable，外键引用 pindou_quota_transactions.id：对应的额度扣减流水。
- idempotency_key varchar(128) not null unique：一次客户端导出动作的幂等键，网络重试时复用，防止重复扣费。
- downloaded_at timestamp not null：服务端确认下载记录的时间。
- 禁止创建 file_url 字段；第一版没有服务端下载文件。

八、pindou_quota_transactions
- id varchar(32) primary key：额度流水的唯一 ID，由应用层生成，例如 qt_xxx。
- user_id varchar(32) not null，外键引用 pindou_users.id：额度变化所属用户。
- type varchar(30) not null，只能是 daily_grant、download_debit、purchase_grant、refund、adjustment：额度变化的业务动作类型。
- amount integer not null，正数增加，负数消耗：本次额度变化数量；禁止通过修改旧流水纠正余额。
- source varchar(40) not null：额度变化来源，例如 daily_free、download、payment、support。
- bucket varchar(20) not null，只能是 daily_free、purchased、membership：本次额度属于免费额度、购买额度还是会员权益。
- quota_date date nullable：免费额度对应的 Asia/Shanghai 自然日；购买额度和其他流水可以为空。
- order_id varchar(32) nullable，外键引用 pindou_orders.id：支付发放或退款关联的订单；purchase_grant 必须关联已支付订单。
- download_record_id varchar(32) nullable，外键引用 pindou_download_records.id：下载扣减关联的下载记录。
- idempotency_key varchar(128) nullable：支付回调或下载扣减的幂等键。
- note varchar(255) nullable：人工调整、退款或异常处理的业务说明。
- created_at timestamp not null：额度流水写入时间；流水写入后不可覆盖或删除。

九、pindou_packages
- id varchar(40) primary key：充值套餐的稳定业务 ID，例如 starter；客户端下单时只提交此 ID。
- label varchar(80) not null：面向用户展示的套餐名称。
- quota_amount integer not null：购买后增加的下载次数；会员套餐可以为 0。
- membership_type varchar(30) nullable：会员权益类型，例如 monthly_unlimited；普通次数套餐为空。
- membership_days integer nullable：会员有效天数；非会员套餐为空。
- price_fen integer not null：人民币金额，单位为分；支付金额以服务端字段为准。
- currency varchar(3) not null，默认 CNY：货币代码，当前产品使用 CNY。
- enabled boolean not null，默认 true：套餐当前是否允许购买。
- sort_order integer not null，默认 0：套餐在充值页面的展示顺序。
- created_at timestamp not null：套餐配置创建时间。
- updated_at timestamp not null：套餐配置最近更新时间。

十、pindou_orders
- id varchar(32) primary key：支付订单的唯一 ID，由应用层生成，例如 order_xxx。
- user_id varchar(32) not null，外键引用 pindou_users.id：下单用户，用于把支付结果和额度发放绑定到用户。
- package_id varchar(40) nullable，外键引用 pindou_packages.id：下单时选择的套餐；套餐删除或调整后仍依赖快照字段对账。
- package_label_snapshot varchar(80) not null：下单时的套餐名称快照，用于订单展示和审计。
- quota_amount_snapshot integer not null：下单时应发放的下载次数快照，不能在支付回调时重新读取客户端值。
- membership_type_snapshot varchar(30) nullable：下单时的会员类型快照。
- price_fen integer not null：下单时的实际支付金额，单位为分；微信回调必须校验金额一致。
- status varchar(20) not null，只能是 pending、paid、failed、closed、refunded：订单生命周期状态。
- wx_prepay_id varchar(128) nullable：微信支付统一下单返回的预支付 ID。
- wx_transaction_id varchar(128) nullable unique：微信支付成功后的交易单号，用于回调幂等和对账。
- paid_at timestamp nullable：微信确认支付成功的时间；未支付订单为空。
- created_at timestamp not null：订单创建时间。
- updated_at timestamp not null：订单状态或支付信息最近更新时间。

【关系和删除策略】
- 所有 user_id、work_id、order_id、file_id 等关联字段必须有外键。
- pindou_work_patterns.work_id 与 pindou_works.id 一对一。
- pindou_favorites 的 (user_id, work_id) 必须唯一。
- pindou_works、pindou_download_records、pindou_quota_transactions、pindou_orders 不得因普通删除发生危险级联。
- 作品删除采用 deleted_at 软删除；下载记录保留 work_title_snapshot，work_id 可以置空。
- 已生效的额度流水和已支付订单禁止删除或覆盖。

【必须创建的索引和约束】
- pindou_users(openid_hash) unique
- pindou_auth_sessions(token_hash) unique
- pindou_auth_sessions(user_id)
- pindou_auth_sessions(expires_at)
- pindou_file_assets(object_key) unique
- pindou_file_assets(user_id, file_type, created_at)
- pindou_works(user_id, updated_at)
- pindou_works(user_id, status, updated_at)
- pindou_favorites(user_id, work_id) primary key / unique
- pindou_favorites(user_id, created_at)
- pindou_download_records(idempotency_key) unique
- pindou_download_records(user_id, downloaded_at)
- pindou_download_records(user_id, file_type, downloaded_at)
- pindou_quota_transactions(user_id, created_at)
- pindou_quota_transactions 的 purchase_grant 类型按 order_id 建立唯一约束（支付发放额度时必须保证一个订单只发放一次；不要把所有类型的 order_id 做成全局唯一，以便未来记录退款或人工调整）
- pindou_quota_transactions(download_record_id) unique（一次下载只允许一笔扣减流水）
- pindou_orders(wx_transaction_id) unique
- daily_grant 按数据库能力增加 user_id + type + quota_date 唯一约束，防止同一用户同一天重复发放免费额度。

【额度模型】
- 不要创建 purchased_quota、download_quota 或 used_today_quota 作为唯一额度事实。
- 每日免费额度示例：pindou_quota_transactions 写入 amount = +3、type = daily_grant、source = daily_free、bucket = daily_free。
- 下载扣减示例：写入 amount = -1、type = download_debit、source = download，并关联 download_record_id。
- 支付成功示例：写入 amount > 0、type = purchase_grant、source = payment、bucket = purchased，并关联 order_id。
- 额度余额必须可以从 pindou_quota_transactions 重建。

【迁移执行顺序】
1. 先创建 pindou_users、pindou_packages。
2. 再创建 pindou_auth_sessions、pindou_file_assets、pindou_works、pindou_orders。
3. 再创建 pindou_work_patterns、pindou_favorites、pindou_download_records、pindou_quota_transactions。
4. 如外键存在循环依赖，先建表，再用 ALTER TABLE 补充外键。
5. 在数据库支持时，整个 up migration 放在事务中执行。
6. 生成 up migration 和 down migration；默认只执行 up migration，不执行 down migration。
7. down migration 也必须只操作 pindou_ 前缀表，并按外键依赖逆序删除；执行前必须二次确认。

【执行后校验】
- 输出实际数据库类型和版本。
- 输出已创建的 10 张表，确认全部以 pindou_ 开头。
- 输出所有字段、索引、唯一约束、CHECK 约束和外键。
- 确认不存在无前缀同名表。
- 确认不存在 generations、download_files、feedbacks、public_work_shares 等未批准业务表。
- 输出迁移文件名、执行结果和任何未解决风险。
- 输出完整数据字典：物理表名、表用途、字段名、字段含义、类型、是否为空、默认值、索引、外键和枚举取值。
- 输出数据库注释检查结果：10 张表的表注释数量、字段注释数量、缺失注释清单；有任何缺失都标记为未完成。
```
