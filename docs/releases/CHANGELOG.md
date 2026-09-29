# CHANGELOG

## 0.36.0

- 首页顶部横幅更新为“小露拼豆”品牌文案，并提升图片清晰度。
- 首页图片创作新增 Q 版、卡通插画和极简插画选择，默认 Q 版；效果示例随风格切换，标准模式仍显示原标准示例。
- AI 图片创作和文字灵感创作要求用户先登录，避免未登录游客消耗 AI 额度。
- 新增独立 `kawaii` AI 风格，客户端任务、服务端 API、提示词和数据库 CHECK 全链路传递；任务恢复与重试保留所选风格，历史 `natural` 数据继续兼容。
- Prompt 模板升级到 `v3`，区分 Q 版大头小身与保持常规比例的卡通插画；新增数据库迁移 `020_ai_kawaii_style.sql`。
- **版本**：根项目升级至 `0.36.0`，服务端升级至 `0.21.0`。

## Server 0.21.0

- 新增 `kawaii` AI 风格及 Prompt v3；数据库迁移扩展风格约束并保留既有值。
- 版本升级至 `0.21.0`；根项目版本为 `0.36.0`。

## 0.35.0

- **新增文字灵感创作**：首页提供图片/想法双入口；文生图任务经服务端内容安全检查、混元生成、AI 额度扣减和任务恢复，成功参考图继续使用标准拼豆引擎转换。
- **首页入口调整**：以灵感工坊页面作为首页，图片和想法入口分别进入对应创作流程。
- **作品来源可追溯**：保存文字创作来源和原始描述，作品页可查看描述；旧作品默认图片来源，原有图生图流程保持兼容。
- **版本**：根项目升级至 `0.35.0`，服务端升级至 `0.20.0`；数据库需先执行 `019_text_image_generation.sql`。

## Server 0.20.0

- **新增文生图任务 API**：增加登录态文生图任务创建、查询、恢复与过期清理；复用 CloudBase 混元和 AI 文件校验，成功才扣 1 次额度，失败不扣。
- **扩展作品来源字段**：新增 `creation_source`、`source_prompt`，作品图案和来源在现有事务内保存。
- **版本**：服务端升级至 `0.20.0`；根项目版本为 `0.35.0`。

## 0.34.2

- **首页标准模式效果对比**：用原图与标准拼豆图展示转换效果，帮助用户理解标准模式输出。
- **修复 AI 生成页预览加载**：拼豆图渲染器迁入 editor 分包作为唯一来源；ai-generation 页按需异步加载，失败继续展示原有兜底状态。
- **版本**：根项目升级至 `0.34.2`，服务端接口兼容 `0.19.0`。

## 0.34.1

- **首页生成方式体验优化**：标准模式常驻浅蓝卡片、AI 模式常驻浅紫卡片，选中态以描边和勾选区分；简化两种模式图标，并收窄问号说明入口的点击范围。仅调整首页视觉与说明交互，不改变生成流程。
- **图片安全检测卡片改版**：将图片改为纵向大图展示，检测提示收纳在下方单行状态栏内轮播；新增右上角移除入口，清空图片与检测结果后返回上传态。仅调整小程序首页，不修改服务端接口。
- **版本**：根项目升级至 `0.34.1`，服务端保持 `0.18.1`。

## Server 0.19.0

- **过期订单状态核实**：打开或刷新订单列表时触发当前用户的过期订单对账；后台对账异常写入日志，微信状态未知时继续保留待核实。
- **订单 5 分钟硬截止**：订单过期后，微信确认未支付/已关闭即关闭支付尝试和本地订单；不再等待一小时，也不允许继续支付原订单。一个订单只保留一个支付尝试，尝试已关闭时需重新下单。微信状态未知时继续核实，迟到的已支付仍补发权益。
- **修复过期支付尝试无法更新**：为对账状态 SQL 的重复参数显式指定 `varchar` 类型，避免 PostgreSQL 参数类型冲突导致订单长期停留在“支付状态确认中”。
- **AI 生图默认服务切换回 CloudBase 混元**：新任务默认使用 `HY-Image-v3.0-I2I-ToB-v1.0.1`；TokenHub 保留用于处理已有在途任务，ToAPIs 配置已移除。
- **生成标识与信息披露**：沿用云函数品牌标识“小露拼豆”，同步接口、运维和隐私说明。
- **版本**：服务端升级至 `0.19.0`；根项目版本为 `0.34.2`。

## 0.34.0

- **订单页继续支付与取消**：「我的订单」对待支付订单提供「继续支付」（复用原订单重新拉起微信支付）与「取消」（服务端先查微信，确认未支付才关单）。新增全部/待支付/已支付/已关闭筛选与待支付数量展示。
- **待支付倒计时**：按服务端下发的 `serverTime` 校准本机时钟偏差后倒计时；超时但服务端未核实前显示「支付状态确认中」且不展示支付按钮，避免重复付款。
- **充值页套餐预选与上限引导**：从订单页「重新购买」进入时预选对应套餐；待支付订单达到服务端上限时提示原因并可直达「我的订单」。
- **版本**：根项目升级至 `0.34.0`，服务端升级至 `0.18.1`。

## Server 0.18.1

- **恢复超时订单本地关单**：订单过期、查单确认未支付且超过 `VIRTUAL_PAY_RECONCILE_CLOSE_AFTER_MS`（默认 1 小时）后置为 `closed`，释放未完成订单名额；查询失败或状态不明仍保留待核实。微信没有主动关单接口，因此收到迟到的已支付推送时仍会查单验真并补发权益。
- **订单页继续支付与取消**：新增 `POST /api/payments/:orderId/continue` 与 `POST /api/payments/:orderId/cancel`，按 orderId 复用原订单而不是新建订单。两者都先查微信再动作：继续支付沿用原商户单号重发参数（已关单则签发新尝试），取消时已支付不许关单、查询失败不关单。`GET /api/orders` 同时下发 `expiresAt`（支付截止时间）、`pendingCount`（未完成订单数）与 `serverTime`（校准倒计时）。

## 0.33.1

- **修复 AI 生成失败提示**：失败卡片展示任务的实际错误原因，避免 `AI_RESULT_INVALID` 误显示为“AI 生成服务繁忙”。
- **版本**：根项目升级至 `0.33.1`；服务端无变更。

## 0.33.0

- **生图服务切换至腾讯 TokenHub 混元 Hy-Image-3.5**：新任务固定使用 `hy-image-v3.5-preview`，不发送可选 `footnote`，立即下载并持久化临时生成图片后再扣额度。
- **在途任务兼容**：保留 ToAPIs 和 CloudBase 混元 Provider 处理迁移前任务快照；新任务不再路由至 ToAPIs，生产队列排空后可删除兼容代码和密钥。
- **隐私与运维文档**：同步第三方共享清单、个人信息清单、隐私政策、接口说明和 TokenHub 上线验收项。
- **修复订单索引结构误报**：PostgreSQL 将 `varchar` 条件显示为带 `::text` 的索引定义；Schema Contract 已按实际定义校验，避免数据库已有索引时 API 被误拒启动。
- **版本**：根项目升级至 `0.33.0`，服务端升级至 `0.18.0`。

## 0.32.0

- **服务端会话登出**：新增当前会话与全设备会话吊销接口，沿用 `revoked_at` 软失效，无数据库迁移；重复登出按鉴权契约返回 `401`。
- **小程序安全登出**：退出时先清凭证和本地 UI，再尽力吊销服务端会话；保护在途恢复结果不覆盖登出状态，并清除内存安全会话。提供全设备吊销 store 能力，图形入口后续补充。
- **版本**：根项目升级至 `0.32.0`，服务端升级至 `0.17.0`。

## 0.31.0

- **支付订单闭环**：持久化用户幂等键与 5 分钟有效期，在用户级事务锁内执行最多 5 个未完成订单的校验；新增支付尝试与回调事件表，支付尝试号永久保留，回调先查微信事实后再发放或扣回额度。
- **未知状态安全处理**：过期订单只有在微信明确返回 `CLOSED` 后才本地关闭；微信仍返回未支付或查询失败时记为 `UNKNOWN`、保留订单名额并进入补单告警，避免把超时当失败。
- **虚拟支付推送验签**：缺少 Token 或签名时拒绝回调；加密推送必须使用覆盖密文的 `msg_signature`。小程序取消后保留同一业务幂等键，并在服务端确认已支付时进入结果页。
- **支付状态与文档同步**：创建接口规范改为虚拟支付参数，补充订单错误码和生命周期说明；版本升级至根项目 `0.31.0`、服务端 `0.16.0`。
- **运行边界**：当前虚拟支付网关没有可用的主动关单实现；因此过期但仍显示未支付的单不会自动释放名额，需等微信明确返回关闭或人工排查。为兼容微信商户单号不可复用，本实现允许同一业务订单保留多个不可变尝试，仅在微信确认旧尝试关闭后追加新尝试。

## 0.30.34

- **修复 ToAPIs 生图结果无法落库**：补充 `files.toapis.cn` 输出域名白名单，兼容模型返回的多种图片地址结构，并增加提交、轮询、下载阶段的失败诊断日志。生产环境需配置 `TOAPIS_IMAGE_OUTPUT_HOSTS=files.toapis.cn,files.toapis.com`。
- **修复 AI 结果预览与保存**：AI 生成结果改用拼豆图画布预览，编辑器与生成页共用渲染逻辑；云端登录状态下优先保存到云端，网络失败时保留本机作品并排队同步。
- **补充 ToAPIs 适配测试**：覆盖顶层结果 URL、任务失败码及供应商错误信息保留。

## 0.30.33

- **处理 BSD-ZERO（0BSD）许可证合规项，将 tslib 收敛到 2.8.1**：扫描上报
  `tslib@1.14.1`（0BSD）存在于 `cloudfunctions/generateImage` 依赖树中。0BSD 本身
  是宽松许可（允许商用、分发、修改、私有使用，仅禁止 Liability / Warranty 主张，
  无传染性），**不构成本次需要规避的许可风险**；这里按依赖卫生口径把它升到当前
  稳定版 `2.8.1`（许可证同为 0BSD），避免低版本长期滞留。
- **根因**：`tslib` 并非本项目直接依赖，而是 `wx-server-sdk@4.0.2` 的 manifest
  声明带进来的（`tslib: ^1.9.3`）。该 SDK 的实际产物里已把用到的 helper 内联，
  打包产物 `index.js` 与源码中均无任何 `require('tslib')`，属 manifest 级死依赖，
  只能从依赖版本口径处理。
- **改动**：`cloudfunctions/generateImage/package.json` 新增 `overrides.tslib: "2.8.1"`，
  并同步 `package-lock.json` 中的 tslib 条目（`1.14.1` → `2.8.1`，integrity 为
  2.8.1 官方 tarball 值）。未降级、未改用更低的候选版本。
- **验证**：`npm ci` 通过，安装树只解析出一份 `tslib@2.8.1`（无嵌套副本）；
  `wx-server-sdk` 声明 `^1.9.3`，而 tslib 2.x 的 CJS 入口是 1.x 导出面的严格超集
  （1.14.1 的 23 个导出在 2.8.1 中全部保留，另有 9 个新增），且项目源码不 require
  tslib，无行为影响；`cloudfunctions/generateImage/index.js` 在升级后可正常加载。
- **新增 0BSD 许可证守卫**：`server/test/dependency-tslib-license.test.js` 直接校验
  lock 中 tslib 的版本与 `license` 字段，并断言 `overrides.tslib` 存在；
  已接入 CI 的 Server Static Check。变异验证：移除 `overrides.tslib` 时第二例转红，
  lock 回退到 `1.14.1` 时第一例转红，确认能拦住回退。

## 0.30.32

- **复核 axios fetch 适配器 `maxBodyLength` 绕过漏洞 CVE-2026-67317（MEDIUM，CVSS 7.5）**：
  该 CVE 影响 `axios@1.16.0`，推荐修复版本 `1.18.0`。`server` 与 `cloudfunctions/generateImage`
  均声明直接依赖 `axios@1.20.0` 并用 `overrides` 固定，安装树里只存在一份 `axios@1.20.0`，
  **高于推荐修复版本，本次未改版本、未降级**。
- **漏洞机理**：`1.16.0` 的 fetch 适配器只在派发前用 `resolveBodyLength()` 校验 `maxBodyLength`，
  而活体 `ReadableStream` 请求体无法预先确定大小，该校验被显式跳过（上游注释
  `Skip when the body length cannot be determined`），流式路径也没有逐块计数，
  于是 `adapter: "fetch"` + `maxBodyLength` 会被整体绕过；HTTP 适配器不受影响。
  `1.18.0` 起改为对 `ReadableStream` / Node `Stream` 用 `trackStream` 逐块累加，
  超限抛受控 `AxiosError`（`ERR_BAD_REQUEST` / `Request body larger than maxBodyLength limit`）。
- **新增 fetch maxBodyLength 守卫**：`server/test/dependency-axios-fetch-max-body-length.test.js`
  起本地 HTTP server，用 20KB 未知大小流配合 `maxBodyLength: 1000` 断言抛受控错误，
  不产生外网流量；已接入 CI 的 Server Static Check。
  变异验证：同一用例在 `axios@1.16.0` 下转红（无错误返回、流被整体发出），
  在 `1.20.0` 下转绿，确认能拦住回退。
- **核实 axios 已满足 CVE-2026-67315 修复要求（代理绕过，MEDIUM / CVSS 7.5）**：
  该 CVE 影响 `axios >= 1.1.0 < 1.18.0`——`shouldBypassProxy` 的回环判断只认
  `127.0.0.0/8` 与 `localhost`，`0.0.0.0` 不被视为回环，因而在设置了 `HTTP_PROXY`
  且 `NO_PROXY` 覆盖本地流量时，发往 `http://0.0.0.0:<port>/` 的请求会绕开 `NO_PROXY`
  被送去代理；请求目标可控（如重定向）时可借此中继到只监听本机的服务，构成 SSRF。
  推荐修复版本 `1.18.0` 已在 master 落地并收敛到 `axios@1.20.0`：`server` 与
  `cloudfunctions/generateImage` 均直接依赖 `axios@1.20.0` 并用 `overrides` 固定，
  安装树里只有一份 `axios@1.20.0`，**高于推荐修复版本，本次未改版本、未降级**。
  扫描器上报的 `1.16.0` 为历史（旧）快照。
- **源码级验证**：`axios@1.20.0` 的 `lib/helpers/shouldBypassProxy.js` 已引入
  `LOOPBACK_HOSTNAMES = new Set(['localhost', '0.0.0.0'])`，并把 IPv4 七/八/十六进制等
  非规范写法归一化后再比对、解析失败时按「不绕过」失败关闭；
  `lib/adapters/http.js` 的 `setProxy()` 仅在 `shouldBypassProxy(location) === false` 时才应用代理。
- **新增 NO_PROXY 代理绕过守卫**：`server/test/dependency-axios-noproxy.test.js`
  起一个只应答 `PROXY` 的假代理 + 一个应答 `LOCAL` 的本地服务，断言
  `NO_PROXY=localhost,127.0.0.1,::1` 时请求 `http://0.0.0.0:<port>/` 命中本地而非代理，
  并断言代理命中次数为 0；已接入 CI 的 Server Static Check。
  变异验证：同一用例在 `axios@1.16.0` 下拿到 `PROXY` 并转红，确认能拦住回退。
- **核实 axios 未受 HTTP/2 流式请求 maxBodyLength 绕过漏洞 CVE-2026-67318 影响（MEDIUM，CVSS 5.3）**：
  该 CVE 影响 `>=1.13.0 <1.18.0`，推荐修复版本 `1.18.0`。安全扫描上报的 `1.16.0`
  为历史（旧）快照：`server` 与 `cloudfunctions/generateImage` 均声明直接依赖
  `axios@1.20.0` 并用 `overrides` 固定，两份 `package-lock.json` 重装后都只解析出
  `axios@1.20.0`，**高于推荐修复版本，本次未改版本、未降级**。
- **源码级验证**：`axios@1.20.0` 的 `lib/adapters/http.js` 已对 HTTP/2、原生 http/https
  及自定义 transport 显式补齐 `maxBodyLength` 字节计数管道（`transportEnforcesMaxBodyLength`
  之外的传输统一走 `stream.pipeline` 计数），HTTP/2 流式上传不再绕过上限。
- **可达性评估**：本仓库源码（`server/src`、`cloudfunctions`、`miniprogram`）无任何
  `httpVersion` / `maxBodyLength` 用法，该 CVE 的两个受影响条件在本项目均不可达，
  属仅依赖版本口径的合规修复。
- **新增 HTTP/2 流式上传守卫**：`server/test/dependency-axios-maxbodylength-http2.test.js`
  起本地 HTTP/2 服务，用 `httpVersion: 2` + 4MB 流 + `maxBodyLength: 1024` 断言上传被
  拦截且服务端实收字节不超过上限，并保留一条未超限正常发送用例；已接入 CI 的 Server Static Check。
  变异验证：同一用例在 `axios@1.16.0` 下转红（服务端实收 4MB，限制被绕过），确认能拦住回退。

## 0.30.31

- **核实 axios 未受 CVE-2026-67312 影响**：该 CVE（`formDataToJSON` 对字段名中的嵌套括号片段
  无深度限制，攻击者可控字段名可耗尽调用栈导致 DoS）影响 `1.16.0`，推荐修复版本 `1.18.0`。
  master 已钉在 `axios@1.20.0`，高于推荐修复版本，依赖声明无需改动，**未做任何降级**，
  未复用漏洞库中的较低候选。
  源码级确认 `axios/lib/helpers/formDataToJSON.js` 已内置 `MAX_DEPTH`（默认 100）守卫：
  字段名嵌套 101 层即抛出受控 `AxiosError`（`ERR_FORM_DATA_DEPTH_EXCEEDED`），
  实测 5000 层同样被拦截，进程不崩溃。
  校验方式：两处 `package-lock.json` 均只解析出一份 `axios@1.20.0`，`npm ci` 重装后
  `npm ls axios` 为 `1.20.0 overridden`（`@cloudbase/node-sdk` 硬声明的 `0.27.2`
  被 `overrides` 去重），既有守卫用例 `server/test/dependency-axios-version.test.js` 通过。
  - **复核 axios 不受控递归漏洞 CVE-2026-67313（MEDIUM，CVSS 7.5）**：该 CVE 影响
    `axios.formToJSON()` / 命名导出 `formToJSON` / `application/json` 请求体默认转换器底层的
    `formDataToJSON`——按 `a[x][x][x]...` 字段名**无深度上限**递归构树，攻击者可控的字段名
    即可耗尽调用栈抛 `RangeError: Maximum call stack size exceeded`。
    推荐修复版本 `1.18.0` 已在 master 落地（`fix/deps-axios-cve-2026-67316`）并随后续升级收敛到
    `axios@1.20.0`：`server` 与 `cloudfunctions/generateImage` 均声明直接依赖 `axios@1.20.0`
    并用 `overrides` 固定，安装树里只存在一份 `axios@1.20.0`，**高于推荐修复版本，
    本次未改版本、未降级**。
  - **源码级验证**：`axios@1.18.0` / `1.20.0` 的 `lib/helpers/formDataToJSON.js` 已引入
    `throwIfDepthExceeded`，复用 `toFormData` 的 `DEFAULT_FORM_DATA_MAX_DEPTH = 100` 上限，
    超限抛受控 `AxiosError ERR_FORM_DATA_DEPTH_EXCEEDED`。
    实测 20000 层嵌套字段名在 `1.20.0` 抛受控错误，在受影响的 `1.16.0` 抛 `RangeError`。
  - **新增 FormData 深度守卫**：`server/test/dependency-axios-formdata-depth.test.js`
    用公开 API `axios.formToJSON()` 断言恶意深度字段名抛受控错误而非栈溢出，
    并保留一条正常转换用例；已接入 CI 的 Server Static Check。
    变异验证：同一用例在 `axios@1.16.0` 下转红（RangeError），确认能拦住回退。

## 0.30.30

- **核实 axios 未受 CVE-2026-67321 影响**：该 CVE 为 `toFormData.js` 深度限制不完整绕过
  （顶层键以 `{}` 结尾时 `JSON.stringify` 溢出 `RangeError` 导致 DoS），推荐修复版本 `1.18.0`。
  安全扫描上报的 `1.16.0` 与受影响范围 `1.16.0` 均为历史（旧）快照：`server` 与
  `cloudfunctions/generateImage` 已在 0.30.28 用 `overrides` 将 axios 统一钉在 `1.20.0`（本次实测解析结果），
  高于推荐修复版本，依赖声明无需改动，**未做任何降级**。
  校验方式：两处 `package-lock.json` 重装后均解析为 `1.20.0`、无旧版本残留；
  源码级确认 `axios/lib/helpers/toFormData.js` 已内置 `maxDepth`（默认 100）限制，
  以「顶层键 `{}` 结尾 + 1000/4000/60000 层嵌套值」复现 CVE 场景时抛出受控
  `AxiosError`（`ERR_FORM_DATA_DEPTH_EXCEEDED`），进程存活；同一场景在修复前的 `1.14.0`
  上仍抛非受控 `RangeError`，可确认修复已生效。

- **修复 lodash.set 原型污染漏洞 CVE-2020-8203**：该 CVE 由 lodash 4.17.19 修复，
  但独立子包 `lodash.set` 的最后一个版本就是 `4.3.2`（2016-08 发布，早已停更），
  扫描器给出的「推荐修复版本」为空 —— **不存在高于 4.3.2 的安全版本，也无法降级**。
  受影响链路：`server` 与 `cloudfunctions/generateImage` 经
  `@cloudbase/node-sdk` → `@cloudbase/database@1.4.3` 间接依赖 `lodash.set@4.3.2`。
  处理方式：用 `overrides` 把 `lodash.set` 替换为随包内置的安全实现
  `file:./vendor/lodash.set-safe`（`_.set` 语义对齐 lodash 4.17.21，
  路径中出现 `__proto__` / `constructor` / `prototype` 时放弃写入），
  两处 `package-lock.json` 已不再解析 registry 上的 `lodash.set@4.3.2`，**未降级任何依赖**。
  校验：两处 `npm ci` 通过；`node -e "require('lodash.set')..."` 确认正常写入生效、
  `__proto__.x` 不再污染 `Object.prototype`；与 lodash 4.17.21 的 `_.set` 做 4 万次随机路径对比无差异；
  `server` typecheck/build/222 例测试（217 通过 / 5 跳过 / 0 失败）通过。

- **合并 master 解决依赖冲突**：master 新增 `lodash.unset@4.18.0` 覆写（CVE-2025-13465），与本次的
  `lodash.set` 本地安全实现覆写落在同一段 `overrides`。合并后两处 `package.json` 同时保留
  `axios@1.20.0`、`lodash.unset@4.18.0` 与 `lodash.set` 的 `file:./vendor/lodash.set-safe` 三项覆写，
  两份 `package-lock.json` 均保留两处修复结果，**未回退任何一方的修复**。

- **复核 axios 漏洞 CVE-2026-67319（原型链污染导致请求篡改，MEDIUM）**：推荐修复版本
  `1.18.0` 在 master 上已由 `fix/deps-axios-cve-2026-67316` 落地，并随后续依赖升级
  收敛到 `axios@1.20.0`：`server` 与 `cloudfunctions/generateImage` 均声明直接依赖
  `axios@1.20.0` 并用 `overrides` 固定，安装树里只存在一份 `axios@1.20.0`，
  高于推荐修复版本，**无需再改版本，也未降级**。
  扫描器仍报 `0.27.2` 属**误报**：该字符串来自 `@cloudbase/node-sdk` 已发布 manifest 里
  硬声明的 `axios: 0.27.2`（截至 4.1.0 仍未改），并非实际安装版本。
  已用「删掉 overrides 会重新装出 `node_modules/@cloudbase/node-sdk/node_modules/axios@0.27.2`」
  验证：`overrides` 是这棵树的唯一收敛点。
- **新增 axios 版本守卫**：`server/test/dependency-axios-version.test.js` 直接校验
  `package-lock.json` 中所有 axios 条目均为 `1.20.0`（master 当前版本），
  并在 CI 的 Server Static Check 中执行。
  变异验证：移除 `overrides` 后该用例转红，确认能拦住回退。
- **修复 axios NO_PROXY 绕过漏洞 CVE-2026-42043**：该 CVE 影响 `axios <1.15.1`（推荐修复版本 1.15.1），
  请求目标 URL 可控时可用 `127.0.0.0/8` 内任意地址绕过 `NO_PROXY` 保护。
  master 已用 `overrides` 把 axios 钉在 `1.20.0`，高于推荐修复版本，依赖声明无需改动，**未降级**。
- **合并 master 解决 axios 版本冲突**：本 PR 原先把 axios 从 `1.16.0` 提到 `1.18.0`，master 已收敛到 `1.20.0`。
  冲突以 master 的 `1.20.0` 为准：两处 `package.json`（`dependencies` 与 `overrides`）与两份
  `package-lock.json` 均解析为 `1.20.0`，安装树中只保留一份 axios，与 `dependency-axios-version` 守卫一致。

## 0.30.29

- **核实 axios 未受 CVE-2026-42039 影响**：该 CVE（GHSA-62hf-57xw-28j9，
  `toFormData` 递归无深度限制导致 DoS）影响 `>=1.0.0 <1.15.1` 与 `<0.31.1`，
  推荐修复版本为 `1.15.1`。安全扫描上报的 `0.27.2` 为历史（旧）快照，
  当前 `server` 与 `cloudfunctions/generateImage` 已用 `overrides` 将 axios 统一钉在
  `1.20.0`，高于推荐修复版本，依赖声明无需改动，**未做任何降级**。
  校验方式：两处 `package-lock.json` 均解析为 `1.20.0`、无 `0.27.2` 残留；
  源码级确认 `axios/lib/helpers/toFormData.js` 已内置 `maxDepth`（默认 100）限制，
  传入 20000 层嵌套对象时抛出受控 `AxiosError` 而非崩溃进程。

## 0.30.28

- **修复 axios 原型污染漏洞 CVE-2026-42033**：该 CVE 影响 `axios <1.15.1`（推荐修复版本 1.15.1）。
  `server` 与 `cloudfunctions/generateImage` 以 `overrides` 钉住的 `1.20.0`，
  高于推荐修复版本且同时满足此前 CVE-2023-45857 / CVE-2026-44496 / CVE-2025-62718 的修复要求，
  本次无需改动依赖声明，未降级；两个 `package-lock.json` 合并后仍解析为 `1.20.0`。

## 0.30.27

- **修复 axios 代理绕过漏洞 CVE-2025-62718**：该 CVE 影响 `axios <1.15.0`（推荐修复版本 1.15.0），
  曾被 `@cloudbase/node-sdk` / `wx-server-sdk` 间接引入的 `0.27.2` 受影响。
  `server` 与 `cloudfunctions/generateImage` 已用 `overrides` 将 axios 统一钉在 `1.18.0`，
  高于推荐修复版本，本次无需改动依赖声明；重装校验两处均解析为 `1.18.0`，无降级。

## 0.30.26

- **修复 axios 安全漏洞 CVE-2023-45857**：`axios` 为 `@cloudbase/node-sdk` / `wx-server-sdk` 间接依赖，
  曾被锁定在受影响的 `0.27.2`（该 CVE 影响 `>=1.0.0 <1.6.0`）。已统一到 `1.15.1`：
  `server` 与 `cloudfunctions/generateImage` 均声明直接依赖 `axios@1.15.1` 并以 `overrides` 固定，
  `package-lock.json` 重生成；`0.27.2 → 1.15.1` 为升级，未降级。

## 0.30.25

- **接入 ToAPIs 异步生图**：新任务默认使用 `gpt-image-2.5-sunburst`，通过公开输入图地址提交异步任务，并按任务状态节流查询、校验输出地址和图片真实格式后落库；生产配置从 `TOAPIS_IMAGE_*` 读取，Key 不进入仓库。
- **保留混元历史任务兼容**：任务记录按自身 provider 选择混元或 ToAPIs，迁移期间不影响已提交的混元任务；新增 `provider_next_poll_at` 支持重启后的轮询恢复。

## 0.30.24

- **优化 AI 次数充值页**：重构当前可用次数、每日免费次数与套餐选择展示，补充新用户/深度创作套餐说明、选中价格、支付方式和在线客服入口；个人页同步简化次数说明。
- **清理千问生图遗留配置**：移除仓库中的 `QWEN_IMAGE_*` 环境变量示例，并更新生图产物来源校验说明；当前生图链路不再依赖千问配置。
- **修复 AI 生成「撞一次限流就失败」的残留路径**：0.30.22 已把混元限流码 `EXCEED_REQUEST_LIMIT`
  从「立刻判死」改成退避重试 3 次（1.5s / 3s），真机上却仍能看到 `AI_SERVICE_BUSY` 失败卡片 ——
  退避重试有两个结构性问题：① 等待压在一次 HTTP 请求里，而小程序侧请求超时是 **10s**，
  等得越久越容易被判成网络失败；② 限流是**账号维度**的，N 个任务各自退避后继续撞，
  等于每个轮询请求都往墙上撞一次，把限流窗口越拖越长，最后整批一起耗尽重试。
  现改成「全局冷却 + 任务停在 queued」：撞到限流即开启冷却并把任务退回排队
  （清掉半截的 provider 引用、保留 `started_at`），冷却期内推进**不调 provider、请求立即返回**，
  冷却结束后由下一轮轮询自然重试；单个任务累计撞墙 6 次才判失败（对外仍是
  `AI_SERVICE_BUSY` / 可重试），`started_at` 超过 15 分钟则兜底判超时
  （内存计数在进程重启时会清零，靠它兜住「provider 长时间不可用 → 无限排队」）。
  冷却**随撞墙次数指数增长、60s 封顶**（8s → 16s → 32s → 60s）：线上实测
  （2026-09-25，`aijob_OXQaQOagUkQnzzoQJyt4`）1.5s 与 3.3s 两次退避**全部撞墙**，
  说明这一波窗口明显长于 5s —— 固定 8s 很可能同样不够，必须逐次加长；
  封顶是为了不让用户在「排队中」无限等下去。
  新增 `ai_provider_rate_limited` 日志（带 attempt / cooldownMs）便于线上核对：
  线上出现 `ai_provider_submit_retry_scheduled` 即说明 0.30.22 已部署（本次失败属「重试耗尽」，
  而非旧镜像「撞限流立刻判死」）。
  用例：「限流后停在 queued，冷却过后出图」「耗尽后才失败」「冷却逐次翻倍并封顶」；
  变异验证：冷却改 0、去掉限流专用分支、去掉指数增长，对应用例分别转红。
- **AI 服务繁忙不再弹失败卡片，改为自动排队重投**（小程序端）：服务端瞬时故障
  （`AI_SERVICE_BUSY` / `AI_TIMEOUT`）占了真机 AI 失败的绝大多数，而它唯一的解法就是
  「等一会儿再试一次」——弹一张卡片等于让用户替程序点按钮。现这类失败原地排队重投最多两次
  （退避 15s / 30s，卡片显示「AI 服务繁忙，N 秒后自动重试」），期间任务回到排队态。
  重投必须清 `jobId` + **换幂等键**：沿用旧键会命中服务端那个已 failed 的任务，
  每次都拿回同一个失败结果（正是 0.30.22 里「重试按钮形同虚设」的成因）。
  失败任务不扣次数（扣次数只在服务端成功收口时发生），换键重投不会让用户多花一次。
  `AI_SERVICE_UNAVAILABLE`（provider 未配置 / 额度耗尽）不在此列：重投必然再失败，
  应引导去用标准模式。新增 `test/ai-failure/transient-retry.test.js` 3 例；
  变异验证：把 `AI_SERVICE_BUSY` 移出瞬时码集合后 2 例转红。
- **移除 AI 产物底部固定裁切 12% 的水印带逻辑**：底部 12% 的硬编码裁切是 0.30.10
  为混元生图（AR 链路）底部「AI生成」标识加的规避——图案引擎按像素降采样，不裁会被
  采样成珠子混进图纸与材料清单。标识的位置和高度绑定具体生图模型，换模型后这个固定
  比例要么误裁正常画面、要么裁不干净，留着仍是隐患；现删除 `stripAiWatermarkBand()`
  与常量 `AI_WATERMARK_BAND_RATIO`，AI 链路下载产物后直接持久化原图。
  影响：AI 产物不再被裁掉底部一条，成品图与图纸按原始出图完整保留；
  后续若新模型仍带标识，按其真实规格另行处理。

## 0.30.23

- **AI 生成状态继续收敛到单页面**：生成失败固定在当前页原地切换为「AI 生成失败」卡片，保留「重新生成 / 返回首页」横向操作；生成成功后不再自动跳转编辑器，而是在当前页展示结果预览并启用缩放、工具、色板和「重新生成 / 保存作品」操作。
- 保留 AI 生成页的 `100%` 缩放、尺寸、颜色与颗数信息；生成中和失败态编辑面板继续保持禁用态。

## 0.30.22

主线有两条：**修掉虚拟支付「付了钱、次数却永远到账不了」**，以及**把 AI 生成的全过程收敛到单一页面**。
前者在生产上真实发生过：0.1 元新人套餐付款成功后权益没有发放，日志里只剩一句
「虚拟支付订单查询失败（41001）」，看不出是协议用错了。

- **修复查单请求形状**（`6b8a7e8`）：查单接口 `xpay/query_order` 的
  `access_token` 与 `pay_sig` 必须放在 **query string** 上、请求体只有 `openid`/`env`/`order_id`，
  而此前 `pay_sig` 被塞进请求体且完全没带 `access_token`，接口对**每一笔**订单稳定返回
  `errcode 41001`。结果是发货推送到了（日志有 `virtual_payment_callback_rejected`）、
  补单轮询也扫到了，两条支路却卡在同一个验真调用上，用户付完钱永远拿不到次数。
  同时修正响应解析：订单信息在返回体的 `order` 对象里、状态是数字枚举
  （2 已支付待发货 / 3 发货中 / 4 已发货 / 7 退款失败），此前按顶层 `pay_state` / `actual_price`
  取值恒判未支付——即使补上 token，不改这两处照样不到账。新增
  `server/test/virtual-pay-client.test.js` 8 例锁定请求形状与响应解析
  （变异验证：去掉 access_token 后对应用例转红）。**服务端必须重新部署才会生效**；
  部署后积压的 pending 订单会在下一个补单周期（5 分钟内）自动补发，无需手工补数据。
- **AI 生成全过程收敛到单页面**（`17f48c7`）：排队 / 生成中 / 失败 / 完成四种状态改为在
  同一页面框架内原地替换中间主内容卡片，不再跳独立失败页；生成中与失败态下方常驻
  **禁用态编辑面板**（缩放、尺寸/颜色/颗数、工具栏、色板保留占位但不可选，图案就绪后自动恢复），
  失败时紫色卡片原地切换为失败态并按失败类型分发主操作（重新生成 / 购买次数 /
  切标准模式 / 重新选图）。同步移除生成页顶部的原图预览与「尺寸 · 色数 · 提交时间」元信息条，
  中间区只留状态卡片。产品流程文档 `docs/product/PRODUCT_FLOW.md` 已同步。
- **未付款订单超时自动关单**：用户下单后放弃付款的单会永远停在 `pending`，而 `pending` 正是
  补单轮询的扫描条件 —— 每一轮都被判成 `stalled` 并记一条「需要人工介入」的告警
  （线上实测 7 笔未付款订单 ≈ 每小时 84 条告警，真实漏发货会被彻底淹没）。
  现查单明确未支付且超过关单窗口即置 `closed` 并停止扫描，窗口由
  `VIRTUAL_PAY_RECONCILE_CLOSE_AFTER_MS` 控制（默认 **1 小时**，校验下限为告警窗口 30 分钟）。
  关单不可逆（closed 之后迟到的发货推送只会得到 `ORDER_NOT_PAYABLE`），故窗口明显大于告警窗口：
  先告警一阵、再关单，中间留给人发现「其实付了钱但查单异常」的余地。
  `UPDATE ... WHERE id = $1 AND status = 'pending'` 带状态条件，避免并发下把刚置为 paid 的单改回 closed。
  新增 3 例用例（关单 / 关单 SQL 必须带 pending 条件 / 未过窗口绝不改状态），
  变异验证：关掉关单分支后 2 例转红。
- **修复虚拟支付「重复拉起支付必然失败」（-15012 ORDER_CLOSED）**：此前 signData 里的
  `outTradeNo` 直接取订单号，而订单号由「用户 + 幂等键」推导 —— 幂等键的语义恰恰是
  **失败重试时必须复用**，于是「复用幂等键 ⇒ 订单号不变 ⇒ 商户单号不变」，
  第二次拉起支付必然撞上微信 -15012（订单号只能用一次）。叠加客户端只在识别成
  「用户主动取消」时才清幂等键，非取消类失败会**永久卡死**：之后每次点购买都撞同一个
  已关闭的单号。现订单号继续做我方主键，另发一个每次都新的商户单号
  （`vpay_` + 20 位随机，25 字符，符合微信 8-32 位与字符集要求）存进新增列
  `pindou_orders.virtual_out_trade_no`，下单时无论新建还是命中既有 pending 订单都换新号
  （`UPDATE ... AND status = 'pending'` 防覆盖已支付订单）；发货推送、退款推送、
  iOS 退款问询、补单查单四条回路一律先按商户单号回查订单
  （`WHERE virtual_out_trade_no = $1 OR id = $1`，保留 `id` 兜底以覆盖迁移未执行的窗口）。
  客户端把 -15012 / -15002 归一成「订单已失效，请重新发起支付」，并提供
  `isWechatPaymentOrderClosed()` 让充值页据此丢弃当前幂等键。
  **需手工执行迁移 `server/sql/016_virtual_out_trade_no.sql`**（回填历史订单为订单号本身），
  未执行时存量在途订单靠 `id` 兜底仍可收尾。新增服务端 6 例 + 客户端 2 例，
  变异验证：把商户单号改回订单号后 3 例转红。
- **修复 AI 生成「一撞限流就永久失败」**：线上任务在 **1 秒内**返回 `AI_SERVICE_BUSY`
  （`createdAt` → `completedAt` 约 950ms），真实原因是混元账号维度限流码 `EXCEED_REQUEST_LIMIT`
  被**立刻** `markFailed` —— 限流属于「等一会儿就好」，却被当成永久失败处理。
  叠加第二个缺陷后更糟：客户端「重新生成」对已有 `jobId` 的任务沿用旧 `jobId` + 旧幂等键，
  服务端命中同幂等键的 failed 任务原样返回，于是**重试按钮每次都拿回同一个失败结果**，
  用户侧根本没有可用的重试路径。现服务端提交侧做三件事：同一任务 in-flight 去重
  （轮询与后台推进不再重复调 provider，那等于自己造限流）、全局提交最小间隔 800ms 主动降速、
  限流/超时/瞬时不可用最多退避重试 3 次（1.5s / 3s + ≤25% 抖动，重试期间任务停在 `processing`，
  前端轮询自然等到结果），耗尽才判失败；另外 `failed` 任务被同一幂等键再次命中且过 10 秒冷却后
  会重新排队（清错误码、延长保留期），作为旧版客户端沿用旧键的兜底；客户端重试改为
  换新幂等键并清 `jobId`。新增 3 例（限流退避后出图 / 重试耗尽才失败 / 失败任务同键重排队），
  变异验证：把重试次数改回 1 后「退避后出图」转红。
  **注意**：`EXCEED_REQUEST_LIMIT` 是账号维度限流，进程内降速只对单副本有效，
  多副本部署仍要考虑分布式闸门或提配额。
- **消除图片目录已存在的告警噪音**（小程序端）：`mkdirSync` 在目录已存在时仍抛
  `file already exists`（`recursive: true` 也拦不住），改为先 `accessSync` 判存在，
  只有真正的建目录失败（权限/磁盘）才告警。

> 已知限制：本版**小程序端与服务端都改了** —— 小程序必须重新上传提审、服务端必须重新部署，
> 缺任何一半都只有一半生效；0.30.10 的真机验收 T1–T20 仍待补跑。

## 0.30.21

主线是**让 AI 生成的失败看得懂**，顺带把入队之后的导航理顺。真机上两个 AI 任务失败，
作品列表一律显示「AI 生成失败，请稍后重试」——**这句不是任何一个具体原因，它是兜底**：
真·内部错误、未登记的码、客户端兜底，四种情况最后都汇到这一句，用户和排查的人一起被挡在真相外面。

- **修复失败原因被兜底文案吞掉**（`0bcc37d` `c0810e0`）：客户端有 8 个「文案表里有、失败定义里没有」的码（限流、图片过大、检测结果失效、网络、登录失效…），`aiGenerationFailure` 返回 `null` 后一律兜底。更关键的是作品列表正文用落库的 `task.failure` 取文案，而 `aiGenerationFailure` 只认 `{ failure: {...} }` 包装与 ApiError，**对裸对象所有码都返回兜底**——不补这一条，登记再多定义也照不出来。
- **服务端补登记两个内部码**（`05e5470`）：`AI_PROVIDER_QUOTA_EXHAUSTED`（混元额度耗尽 / 429）与 `AI_STORAGE_NOT_CONFIGURED` 原先不在 `error-contract` 映射表里，被静默兜底成 AI_GENERATION_FAILED，还顺手给了一个必然失败的重试按钮。现映射为「AI 生成暂时不可用」，未命中映射时补 `ai_failure_code_unmapped` 日志——以后再漏登记会留下痕迹而不是无声吃掉。
- **失败动作收敛到单一来源，失败路径留痕**（`15949a7`）：manager 的重试动作 switch 与 service 的 `failureDefinition.action` 是两张表，`IMAGE_TOO_LARGE` 曾一边判「可重试」一边判「应换图」；现统一走 `aiFailureAction(code)`。同时给失败路径补控制台日志，带错误码 / HTTP 状态 / requestId——界面上只剩一句中文文案时，真机排查靠它才能对上服务端。
- **恢复 AI 生成页入口**（`081ad92`）：首页创建 AI 任务后携带任务 ID 进入既有生成页，显示进度与动效；移除「入队悬浮提示 + 清空选图」的交互，失败时保留重试、返回首页等操作。
- **任务完成后不再抢走当前页面**（`75ada53`）：AI 任务可以在后台跑完，生成页原先一收到 succeeded 就跳编辑器，用户此刻可能已返回首页。改为按页面可见性判断，且写入本地草稿（异步）后再复查一次。
- **保持首页与两种模式独立**：返回首页保留选图、参数与模式，不再用旧草稿覆盖首页模式；提交使用点击时的输入快照；标准模式仍独立生成。
- **回归覆盖**（`135b2a9`）：新增 `test/ai-failure/`，21 例（失败码契约 8 例 + 生成导航 13 例），`npm run test:ai-failure`；新增 `server/test/ai-error-contract.test.js` 5 例守「provider 新码必须登记」。两类变异（删映射、改文案）都验证过能让对应用例转红。

> 已知限制：本版同时改了**客户端与服务端**，小程序必须重新上传提审、服务端必须重新部署，
> 缺任何一半，失败文案仍会显示兜底那一句；0.30.10 的真机验收 T1–T20 仍待补跑。

## 0.30.20

主线是**修掉虚拟支付在小程序端被彻底卡死的一个客户端缺陷**，并补齐让支付真正能跑通的道具绑定。0.30.16–0.30.19 连着四个版本客户端一行未改，本版是 0.30.16 之后第一次动小程序代码——不重新上传提审，这个修复到不了用户手上。

- **修复 signData 参数类型错误**：`wx.requestVirtualPayment` 的 `signData` 运行时必须是字符串，客户端原先 `JSON.parse` 成对象传入，微信直接报 `parameter.signData should be String instead of Object`，支付一步都走不出去（`127db79`）。改为原样透传服务端下发的字符串，仅做 JSON 解析校验。配套 `test/payment` 13/13 用例锁定该约束（变异验证：把透传改回对象后仅两条用例转红）。
- **新增虚拟支付道具 ID 绑定 SQL**：`server/sql/015_virtual_product_ids.sql` 将 MP 后台已发布道具 ID 关联到三个 AI 生成套餐（`ai_generation_new_user_5` / `ai_generation_30` / `ai_generation_80`）。道具 ID 为占位符，需替换成 MP 后台实际已发布道具 ID 后执行（`8f833da`）。

> 已知限制：本版必须重新上传小程序提审才能生效；道具 ID 未填、或道具未「发布到现网」前，下单仍会报 -15010 / -15013。

## 0.30.19

主线是把**虚拟支付联调的最后一道障碍清掉**，并把 0.30.16–0.30.18 这条链路收口成可提审的基线。那三版连着补的都是服务端（正向支付 / 退款与 iOS 问询 / 推送握手解密），但联调本身卡住了：0.1 元的新人测试套餐「每人限购一次」，走完一次真实支付后同一账号就再也无法下单，而这条链路恰恰需要反复验证。本版仍是**纯服务端改动**，小程序端自 0.30.16 起一行未改——**本版上传的小程序包与 0.30.16 完全一致**。

- **新人测试套餐限购改为可开关**：新增 `PAYMENT_NEW_USER_GATE_ENABLED`（**默认 `true`，限购照旧生效**），置 `false` 可让同一账号反复下单；限购判定变为「新人套餐**且**开关开启」才拦截。默认必须开启——这个套餐只卖 0.1 元，关掉又忘了开回来等于对外无限量卖 5 次生成。联调结束后应恢复默认（或直接下架该套餐，SQL 012 已注明）。
- **补 AppKey 现网 / 沙箱的区分说明**：`.env.example` 明确 `VIRTUAL_PAY_APP_KEY` 必须填**现网**那套，沙箱联调需**同时**把 `env` 改为 `1`。此前未提示这一点——只换沙箱 AppKey 会让 `paySig` 验不过，且表现为「签名算法有问题」，排查时极易走错方向。
- **CHANGELOG 补记官方 action 升级**：`actions/checkout` / `setup-node` → v7、`github-script` → v9（node24 运行时）。该改动在 0.30.17 之前就已合入，但 CHANGELOG 只记了同批的 `runs-on` 钉 `ubuntu-24.04`、漏了这条，容易让后人误判「升级还没做」。
- 测试：新增 1 例，断言的是**「限购查询根本没执行」**而不是「有没有抛错」——只断言错误文案的话，任何别的分支先抛错都会让用例假绿。变异验证：去掉 `&& newUserPackageGateEnabled` 后仅本例转红。服务端全量 189 → 190 例。

> 已知限制：`PAYMENT_NEW_USER_GATE_ENABLED` 是联调专用开关，**正式环境必须保持 `true`**；**小程序包与 0.30.16 完全一致**，本版提审不带来新的客户端变更；0.30.10 的真机验收 T1–T20 仍待补跑（已挂四个版本）。

## 0.30.18

主线是把虚拟支付**入站推送**这条链路真正打通，并修掉一条让前两版白做的 bug：回调入口原先拒绝一切带查询参数的请求，而微信推送必然带 `signature` / `timestamp` / `nonce`——0.30.16 的发货、0.30.17 的退款与 iOS 问询，**此前一条都进不来**，服务端日志里只有一串 400。本版是纯服务端改动，小程序端代码未改。

- **修掉「推送全被 400」**：`/api/payments/virtual-notify` 的 POST 分支原写着「查询参数非空即拒绝」。微信无论明文还是安全模式，POST 推送时一定在 URL 上带签名参数，等于每一条推送都在进门之前被挡掉。改为取出 `signature` / `msg_signature` / `timestamp` / `nonce` 做校验，验不过才拒绝。
- **MP 后台 GET 握手回显 `echostr`**：后台保存推送配置时先对 URL 发一次 GET，服务端需按 `SHA1(token, timestamp, nonce)` 校验并**原样回显 `echostr`**，否则后台判定 URL 不可用、配置存都存不进去。未配 Token 时直接 503 `VIRTUAL_PAY_PUSH_NOT_CONFIGURED`——宁可明着失败，也不要假装配好了却一条都收不到。
- **安全模式解密**：新增 `modules/payments/virtual-pay-push.ts`。`EncodingAESKey` 固定 43 字符，补一个 `=` 正好解出 32 字节密钥；明文结构是「16 字节随机串 + 4 字节大端长度 + 正文 + AppId」，解密后核对 AppId 确认消息确实投给本小程序。未配 AESKey 时按明文模式处理（硬解只会把明文当密文炸掉）。
- **验签 / 解密失败回 `ErrCode=1` 而不是 4xx**：这类故障根因在配置，重试多少次结果都一样；回 4xx 会被平台当成网络失败重试 15 次，把真正需要人看的告警淹没在噪音里。统一回 200 + `ErrCode=1` 并打 `virtual_payment_push_rejected`（只记错误码，不记原始报文）。
- **配置错误在启动阶段挡住**：`EncodingAESKey` 必须 43 个字符（长度不对会在解密那一刻才炸，且表现为「所有推送都解密失败」这种极难归因的故障）；配了 AESKey 必须同时配 Token；生产环境启用虚拟支付必须配 Token——没有同一个 Token，后台握手永远验不过，三条推送全断，而且**失败得极其安静**（服务照常起来、下单照常走通，很久之后才以客诉形式冒出来）。
- **测试**：新增 `server/test/virtual-pay-push.test.js`（握手、安全模式验签、解密与 AppId 核对）；`server/test/config.test.js` 补推送凭据解析与区间校验；修正 `server/test/wechat-client.test.js`——0.30.16 起 `exchangeCode` 会一并返回 `sessionKey`（虚拟支付用户态签名要用），该用例仍断言「只返回 openid」，是本次全量里唯一一条红的。

> 已知限制：明文模式下不做来源加密保护（推荐后台选安全模式）；**推送仍然不被信任**——发货与扣回依旧以 `query_order` 反向验真为准（fail-closed），本版只负责让消息进得来。

## 0.30.17

主线是**把退款那半条链路补上**。0.30.16 做完了正向支付，但退款侧是空的——DB 里有 `refunded` 状态与 `refund` 额度流水，服务端却没有任何推送处理，后果是**钱退给用户了、AI 生成次数还留在他手里**。补这件事的前提是认清：**退款不由我们决定是否发生**，iOS 上开发者根本无法主动发起退款（Apple 支付不支持），只能接收结果。另一部分是 CI 运行镜像钉版本。本版是纯服务端改动，小程序端代码一行未改。

- **退款推送 `xpay_refund_notify` 接入**：新增 `handleRefund()`。核心口径是**只扣回用户还没用掉的部分**——`clawBack = min(当前剩余购买额度, 该单发放额度)`，两个维度都要看：只看发放额度会把已消耗掉的扣成负数，只看剩余额度在多次购买时可能扣到别的单头上。已全额消耗的订单仍标记 `refunded` 但不扣额度。
- **失败退款不动账、重复推送幂等**：`retCode !== 0` 表示退款本身失败，订单与额度均保持原样，只记 `virtual_payment_refund_rejected`；订单已是 `refunded` 时直接返回，配合 `refund:<orderId>` 幂等键与 `ON CONFLICT DO NOTHING` 保证重复推送只扣一次。
- **定位不到订单要上报，不能丢**：商户单号缺失时回退用 `attach` 定位；两者都没有、查无此单、付款人对不上、额度快照非法（不是 `ai_generation` 或数量 ≤ 0）四种情况一律打 `virtual_payment_refund_alert`。退款静默失败等于钱和货两头都不见还查不到。
- **iOS 退款问询应答**：`xpay_subscribe_ios_refund_query_notify` 走**独立应答协议**（`result_code` / `result_info` / `evidence`，不是 `ErrCode`），且 Apple 会重复三次问询、**3 秒内不答平台就向 Apple 回「不确定」、退款决定权整个交出去**。因此异常分支也必须答——宁可放过也不放弃举证；`evidence` 是必填项，空着等于放弃举证机会。
- **只在「确实已发货」时主张拒绝**：`result_code=1` 仅在订单状态为 `paid` 时返回；订单不存在、未发货、无法定位一律 `result_code=0`。判定依据是**我方订单状态**，不是推送里那个仅作参考的 `provide_status`。原则是无法归因的退款一律不拦截。
- **按事件名分发，未识别事件不再静默吞掉**：此前 `app.ts` 只认 `xpay_goods_deliver_notify`，其余 `xpay_*`（退款、投诉、风控）一律回 `ErrCode=0` 吞掉——商户被管控、用户投诉时我们连一行日志都没有。现在先取事件名再分发（同时支持 JSON 与 XML 两种推送体），未识别事件仍回成功让平台停止重试，但**必须留下事件名**。
- **CI `runs-on` 钉死 `ubuntu-24.04`**：GitHub 自 2026-10-19 起把 `ubuntu-latest` 分批切到 Ubuntu 26.04（11-19 完成），内核 6.17→7.0、systemd 255→259、glibc 一并升级。跟随浮动标签会让流水线在某天无声换掉整个系统镜像且很难归因。三个 job 一并改。
- **新人测试套餐限购改为可开关**：0.1 元 / 5 次的套餐原本每人限购一次，联调时走完一次真实支付就被 `NEW_USER_PACKAGE_NOT_ELIGIBLE` 挡住没法二测。新增 `PAYMENT_NEW_USER_GATE_ENABLED`（**默认 `true` 限购生效**），置 `false` 可让同一账号反复下单。默认是开启的——这个套餐只卖 0.1 元，关掉又忘了开回来等于对外无限量卖 5 次生成。
- 测试：新增 34 例（`server/test/payment-service.test.js`），覆盖扣回未消耗额度、已全额消耗不扣、失败退款不动账、重复推送幂等、`attach` 回退定位、定位不到上报，以及 iOS 问询的已发货拒绝 / 未发货放行 / 订单未知放行 / 无法归因不拦截。

> 已知限制：退款后**不回收已生成的作品**（只扣次数，已生成的图纸仍留在用户账号里，是刻意选择）；部分退款按「不区分」处理，`refundFeeFen` 只记录核对、不作为扣回依据。

## 0.30.16

主线是**支付合规**：AI 生成次数属于虚拟商品，官方要求小程序内售卖虚拟商品必须走「小程序虚拟支付」，它也是 **iOS 端唯一合法通道**（普通 `wx.requestPayment` 在 iOS 上无法购买虚拟商品）。本版把客户端从 `wx.requestPayment` 换成 `wx.requestVirtualPayment`，服务端补齐签名客户端、发货推送验真与 `session_key` 加密落库。另一部分是 OCR 扫描第三轮加固在小程序侧的落地，集中在**静默失败**——既不报错、现象又完全看不出根因的那些地方。

- **小程序虚拟支付接入**：`payment-service.ts` 改为调 `wx.requestVirtualPayment`，并补三道前置：`signData` 必须原样透传（本地哪怕按同样字段重新 `stringify`，一个空格差异都会让 `paySig` 校验失败）；`parseSignData` 解析失败抛明确错误（否则微信只回一句笼统的 -15001，排查时看不出是服务端下发问题还是客户端解析问题）；`canUseVirtualPayment()` **先过基础库 2.19.2 门槛再看 `canIUse`**（部分宿主存在接口却不起作用，只看 `canIUse` 不够）。
- **虚拟支付错误码翻译成可行动文案**：新增常见错误码映射（`-15007` 登录态失效请重新登录、`-15010` 商品暂不可购买、`-15013` 价格异常、`-15021` 下单过于集中等），不再让用户对着 raw code 发呆。用户取消仍以结构化的 `errCode === -2` 判定，不依赖会随版本与语言变化的 `errMsg`。
- **服务端虚拟支付签名与发货验真**：`virtual-pay-client.ts` 按官方规则算 `paySig = HMAC-SHA256(appKey, "requestVirtualPayment&" + signData)` 与 `signature = HMAC-SHA256(sessionKey, signData)`；`signData` 由 `buildSignData()` 单点生成，既原样下发又作为签名输入，避免第二份序列化实现各自演化。**发货推送不带签名，因此发货前强制 `query_order` 反向验真**（fail-closed）。配套 SQL `014_virtual_payment_support.sql`。
- **`session_key` 加密落库并每次登录刷新**：它是虚拟支付用户态签名 `signature` 的计算密钥，留旧值会让用户下次支付报 `-15007`。现在登录时一并加密写入、每次登录刷新；**严禁打进日志或下发客户端**——泄露意味着他人可以伪造该用户的支付签名。
- **服务端未签发支付参数时不再谎报「套餐数据无法识别」**：下单成功但 `virtual` 为 `null`（虚拟支付未启用或服务端降级）时，原先在解析阶段就抛通用 `invalidResponse`，文案是「无法识别的套餐数据」，而订单其实已经建好——会把排查方向整个带偏。改为让 `payForAiGenerationPackage` 统一抛「支付参数已失效，请重新发起支付」。
- **图纸渲染挡住非法网格尺寸**：新增 `requireGridSize` / `requireCanvasHeight` 在绘制前校验。宽高为 0 会让 `cellWidth` 算成 Infinity、NaN 会污染所有坐标，而 canvas 拿到非法坐标**既不抛错也不画东西**，表现只是「导出了一张空白图」，从现象完全追不回网格尺寸坏了。
- **材料统计与落盘用同一把尺子量颜色**：`summarizeMaterials` 的 key 改为颜色小写归一，与 `models/pattern` 的 `encodePatternCells` 同口径。否则 `#FF0000` 与 `#ff0000` 在材料表里算两种色（出现两行同样的红）、落盘编码时却合并成一种——同一个作品在两处给出不同的色数。
- **`getTextColor` 只认 6 位十六进制**：原来只校验长度，而 `'gggggg'` 长度也是 6，`parseInt` 全部得到 NaN，亮度比较恒为 false，于是**任何**脏色值都会返回白字——白底上的白字等于看不见。进不了合法色值域就走深色兜底。
- **`rgbToHex` 通道收敛到 0~255**：越界分量（负数、>255、NaN）会拼出 `-1`、`NaN` 这种不是两位十六进制的串，得到的 `#xxxxxx` 根本不是合法颜色；canvas 和 WXML 都不会报错，只表现为「这一格不显示」。非有限数落到 0（黑），至少保证产出仍是合法颜色。
- **`median-cut` 不再污染调用方的数组**：桶分裂前的 `sort` 是原地排序，直接用调用方的 `pixels` 会把人家的行优先顺序改掉，这种污染不报错、只会让结果悄悄不对；改为复制一份入桶。空桶取均值会得到 NaN 三元组（`fillStyle` 拿到 NaN 静默不绘制），改为直接抛错——按项目约定不用「合法值」掩盖异常。
- **作品重命名不再写回陈旧快照**：`await checkTextContent` 期间可能已完成一次云同步，本地作品被换成云端记录（id 都变了），此时再把 await 之前那份快照写回去，等于把已被替换掉的旧记录塞回列表——用户看到的是「重命名成功，但列表里多了一份同名旧作品」。改为 await 后重新取一次，取不到就提示刷新后重试。
- **云端作品新建拒绝空 id**：新建的幂等键由 `draft.id` 派生，id 为空时键退化成 `'create-'`，所有空 id 的新建会被服务端当成同一笔去重——用户存了两份作品、云端只留下一份，且全程无任何报错。改为明确失败。
- **登录态三个时间字段用同一把尺子**：`createdAt` / `quota.resetsAt` / `aiGeneration.resetsAt` 补 `Date.parse` 有限性校验。只判 `typeof string` 会放过「看起来像时间、解析却是 NaN」的脏串，下游拿去做倒计时就渲染出 NaN。
- **其它健壮性**：`download-service` 的 `fileType` 与 `query` 一律做 URL 转义（原先只有 `query` 转义，两处口径不一致，将来往这里传外部输入就会漏编码）；`main-tab-bar` 的 `currentSelected` 默认 `-1`（默认 `0` 会让「作品」「我的」页在计算出应高亮项之前先闪一帧首页高亮）；「关于」页缺少文案时不弹空内容对话框（只有标题没有内容的弹框看起来像加载失败）。
- **测试**：新增 `test/payment/`（13 例，覆盖 signData 透传、基础库兜底、取消判定、错误码翻译、缺签名拒绝拉起等）与 `test/pattern-generation/phase-7-ocr-hardening.test.js`；拼豆图生成用例 62/62。

## 0.30.15

修复首页示例图与「我的」页头像在真机上长期空白，并补上防止复发的静态守卫。

- **本地 WebP 真机不解码（14 个版本没人发现）**：`image` 组件的 `webp` 属性官方说明是「默认不解析 webP 格式，只支持网络资源」，且属于 **WebView 特有属性**——包内 `.webp` 在开发者工具里正常显示（模拟器是 Chromium，原生支持 webp），真机上则整张空白且不报错。v0.16.0「图片资源转 WebP」把 `brand-avatar` 与 4 张 `home-sample-*` 转成 webp，此后首页「示例图片」与「我的」页头像一直是 CSS 背景色的空方块。
- **还原 5 张图片为转格式前的原始文件**：`brand-avatar.png`（256×256 RGBA，同时恢复了被 webp 丢掉的透明通道）、`home-sample-standard-1/2.jpg`、`home-sample-ai-1/2.jpg`（512×512，同时也恢复了 webp 转换时被降到 240×240 的分辨率）。7 处引用（`pages/home/index.ts`、`pages/profile/index.wxml`、`pages/profile/index.ts`、`packages/account/index.ts`、`packages/account/profile-edit/index.ts`）同步改回 `.png` / `.jpg`。
- **新增 `test/miniprogram-assets/`（2 例，已做变异验证）+ CI `Miniprogram local image asset check`**：① `assets/` 下禁止出现 `.webp`；② 源码里字面量引用的 `/assets/...` 必须真实存在且扩展名在白名单内。这两条恰好是本次事故的两个条件（格式不被解码 + 断链引用），而它们在工具里都是隐形的，以前只能靠真机肉眼发现。
- **`docs/frontend/MINI_PROGRAM_RULES.md` 补规则与排查口径**：「包内静态图片禁止使用 WebP」；图片空白时先看该 `<image>` 有没有 CSS `background`——有背景色说明元素本身渲染正常、只是资源没解出来，优先怀疑格式与路径而不是布局。
- **下载记录页封面补上加载失败兜底**：作品页与收藏页的封面都有 `binderror` 兜底到 `image-upload.svg` 占位图，下载记录页是唯一漏掉的一处——封面地址失效时列表里会留一个空白格且没有任何提示。补 `handleCoverError` 与 `coverPath || COVER_FALLBACK_PATH`，与另两页同一套口径。
- 包体影响：主包 629KB → 1.09MB（图片 113KB → 603KB），2MB 上限内余量充足。若要继续压体积，应走「降分辨率 + JPEG 质量」，不要用换格式的方式省。的方式省。

## 0.30.14

第二轮 AI 扫描修复批次，聚焦「同一件事两套口径」导致的隐性错误，共 6 个文件。

- **失败码归一化收口（同一个错会给两句矛盾文案）**：服务端可能返回别名（`QUOTA_INSUFFICIENT`、`AI_PROVIDER_TIMEOUT`、`PAYLOAD_TOO_LARGE` 等），而 `aiGenerationErrorMessage` 里把这些别名和归一化后的码**并列写成多个 case**——同一个错误走「failure 对象」还是走「裸 ApiError」两条路径，会落到不同分支上，用户看到互相矛盾的提示。改为入口统一先过 `normalizeFailureCode`，映射表只写归一化后的码；`aiGenerationFailure` 把服务端给的码也一并归一化（它同样可能吐别名），保证 `failure.code` 只有一个取值空间，下游不必再猜这份码规整过没有。同时给三个文案各有意义、不应被合并进通用类目的码（`UNSUPPORTED_IMAGE` / `IMAGE_DECODE_ERROR` / `AI_TASK_EXPIRED`）保留独立文案并注明理由。
- **`retryActionFor` 跟进同一套口径**：卡片操作按钮原先还认旧别名（`QUOTA_INSUFFICIENT`、`AI_QUOTA_UNAVAILABLE_AT_COMPLETION`），且漏了 `IMAGE_TOO_LARGE` / `RATE_LIMITED` / `AI_TASK_EXPIRED`——这些失败会落到默认操作上。改为只认归一化码并补齐分支，函数注释写明入参契约（必须已归一化），避免以后再有人重复归一化。
- **`AiGenerationFailure` 契约被违反**：`aiGenerationFailure` 在 `category` / `action` 齐全但 `retryable` 缺失（`undefined`）时，会产出 retryable 不是布尔的对象，违反该接口的类型契约。补上真正的布尔判定。
- **支付幂等键改用 CSPRNG**：原来用 `Math.random()` 生成随机分量，而这是一笔钱的去重凭据——同一毫秒内连点两次撞键的后果是用户付两次钱。改用 `wx.getRandomValues`（小程序环境没有 Web 的 crypto 全局），拿不到时降级并打 warning，不让配置异常直接崩在支付入口。
- **微信支付失败对象归一成 ApiError**：`wx.requestPayment` 的 fail 回调给的是 `{ errMsg, errCode }` 裸对象，既非 Error 也非 ApiError；原先直接 reject，导致 `paymentErrorMessage`（只看 Error 实例）永远走兜底文案——用户明明自己取消支付，却看到「请稍后重试」。改为统一收成带 code 的 ApiError；取消判定从**子串匹配 errMsg**改为优先看结构化的 `errCode === -2`，因为 errMsg 会随基础库版本与系统语言变化。
- **套餐解析不再卡死服务端内部字段**：`parsePackage` 原先连 `quotaKind === 'ai_generation'`、`membershipType === null`、`currency === 'CNY'`、`enabled === true` 一并校验并写死期望值——服务端一旦新增套餐种类，`parsePackages` 整份 map 抛错，用户界面上一个套餐都不剩，报错还是「无法识别的套餐数据」这种看不出所以然的文案。改为只校验真正要渲染的字段（id / label / quotaAmount / priceFen），其余属服务端内部约定，不该成为客户端能否渲染的前提。
- **下载记录 id 补随机分量**：原先是 `download_<id>_<type>_<时间戳>`，同毫秒内连点两次「保存」会算出同一个 id，第二次被 `addDownloadRecord` 视为同一条记录覆盖掉——用户点了两次只记一次，本地下载记录与实际行为对不上。
- **WeChat Canvas 基线不再因单个素材失败全轮中断**：原先任一素材读不到就整轮抛错，什么都不产出；缺一张图的排查成本远高于少一条记录。改为逐用例收集 `failures` 数组，其余继续跑；同时抽出 `TEST_ASSETS_DIR` 常量，换环境只改一处。

## 0.30.13

首轮全量 AI 代码扫描（`open-code-review`）的修复批次，共 269 条发现、118 个文件送审。
合并以下 6 类真实缺陷，其余判定为误报或有意设计，记录在 `docs/development/OCR_SCAN_FIX_LOG_2026-09-23.md`。

- **图纸生成 · 空候选静默返回 undefined**：`findNearestColor` 在调色板为空时 `best` 停在初始值、循环体一次都不执行，返回 `undefined` 而类型上却写着具名返回值——下游拿到直接在很远处崩溃。抽出 `pickNearest(items, distance)` 统一规定**候选为空即抛错**，让失败停在离根因最近的地方；`findNearestColorOklab` / `findNearestColorIndexOklab` 同样补上前置校验（返回下标 0 是「合法但错误」的值）。
- **Sobel 归一化系数错误**：原来除以 4，而双方向合成的幅值上限是 √32≈5.66，比真实上限小三成多，稍强的边缘统统饱和到 1，输出退化成近乎二值的 0/1，丢掉了「保护轮廓」所需的强度层次。改为 `/√32`；同步补上 alpha 处理（透明格乘 alpha 并标记 `opaque`，不再把「画面↔无画面」的落差当成真实轮廓）与邻域覆盖率折算。
- **AI 任务迁移顺序错误（会丢任务）**：`migrateLegacyAiSession` 原本先打迁移标记、再删旧会话，最后才建新任务——中间崩一步就是「旧数据没了、新任务没建成、标记还挡着下次重试」，用户的在跑任务静默丢失。改为**先建新任务 → 再删旧会话 → 最后打标记**，且建任务失败时保留原会话等待重试。
- **终态任务 TTL 起算点错误**：过期清理按 `createdAt` 算，一个很早提交、刚刚才跑完的任务会因创建时间超期被立刻清掉，用户还没看到结果卡片就没了。改为按 `finishedAt` 起算（`createdAt` 兜底）。
- **持久化头像永远被清成 null**：`token-storage` 的 `parseUser` 写死 `avatarUrl: null`，冷启动恢复的会话会丢掉已保存的头像。修复并与 `auth-service` 的解析口径对齐；`CurrentUserProfile` 补文档明确 `quota` 字段由解析器保证齐全。
- **支付幂等键每次调用都重生成（去重失效）**：`payForAiGenerationPackage` 原来在函数内部用默认参数现造 idempotency key，同一次点击走到两次就被服务端当成两笔订单。改为必须由调用方按「一次购买意图」生成并持有——`recharge` 页把它存进页面状态，失败重试复用同一个键，支付成功或用户主动取消才清空。
- **云端作品读取的调用顺序错误（作品会跑到游客区）**：`setCurrentDraft` 内部靠 `cloudWorks` 里是否存在同 id 记录来判定归属，若找到就是云草稿、否则落到 `persisted.guest`。收藏页原先先 `setCurrentDraft` 再 `saveWork`，于是这份云作品在该判定眼里还不存在，被当成游客草稿存进游客区——用户账号下凭空少一份作品、游客区多一份脏数据，且全程无任何报错。改为**先 `saveWork` 落 WorkItem，再 `setCurrentDraft`**，并在 `AppStore.setCurrentDraft` 上写明这条前置条件。编辑器页与作品页的同类调用一并核正。
- 其余健壮性收敛：`app.ts` 补 `runStartupSafelyAsync` 接住 fire-and-forget 启动项的 Promise 拒绝（否则控制台只有无堆栈的 Unhandled rejection）；`navigation` / `page-layout` 对 `getWindowInfo`、`getMenuButtonBoundingClientRect` 返回值做兜底；`download-service`、`image-service`、`payment-service` 等补齐空值与日期校验。
- 测试跟进 `pickNearest` 重构：三个用例改用新函数并保留 V1 行为基线，**57/57 通过**。
- ci：新增 OpenCodeReview GitHub Actions 工作流与项目专属评审规则（19 条），详见 `docs/development/OCR_CODE_REVIEW.md`。

## 0.30.12

- 修复本机存储空间写满后全面报错：`AppStore` 把游客与所有账号的工作区存在单个 storage key 里，配额仅 10MB，而草稿的逐格对象是绝对大头且从不回收，攒二三十份就写满，之后每次 `setStorage` 都失败——作品页会把「本机写不进」谎报成「读取云端作品失败」，AI 已经生成好的图纸也因为落不了库被判失败。落盘改为「调色板 + 下标」压缩（40×40 图纸 160KB → 约 15KB），读取时按 `cells` 首元素类型自动兼容新旧格式、旧数据免迁移，格式损坏则整份丢弃（不降级成空网格——空画布是合法值，编辑器会照常打开并让用户保存回去覆盖现场）。
- 新增两道容量闸与写满自救：草稿落盘上限 50 份、下载记录 60 条，超出丢最旧的；`persist()` 在配额写满时先自救（草稿裁到 8 份、记录裁到 10 条）再重写一次，仍失败才抛 `LocalStorageError`。自救裁的是**运行态**而非只裁落盘快照，避免页面还能打开一份重启即消失的草稿。
- 合并本机与云端两份网格压缩实现：抽出 `models/pattern.ts` 的 `encodePatternCells` / `decodePatternCells`，`work-service` 的 `draftToPersistedPattern` / `cloudDetailToDraft` 改为复用，不再各自演化。
- 作品页 `refreshWorks` 拆开网络失败与本机落盘失败两个 `catch`，各自给准确提示；loading 复位与重渲染收敛为单点出口。
- 新增 `test/work-sync/local-storage-quota.test.js`（7 例，harness 用 JSON 长度近似配额并支持动态收紧），已做变异验证。

## 0.30.11

- 生图角标文案改为「小露拼豆」：`generateImage` 云函数在 `generateImage()` 里传 `footnote`，覆盖平台默认烙的「AI生成」。平台标识**不支持关闭**（CloudBase 社区 issue #1317 中官方明确显式 + 隐式两个标识都必须加），SDK 只开放 `footnote` 自定义文案（上限 16 字符），因此只能换文案。**本次含云函数改动，需在微信云开发重新部署 `generateImage` 才生效。**
- 首页入队提示改为顶部横条通知：入队成功后从导航栏下方滑入（`top` 取实测导航栏高度，不硬编码），4 秒后自动收起，并给出「去作品页查看进度」的入口；与主按钮就地成功态互补（按钮给指尖即时确认，横条告诉用户去哪看）。替换掉原先常驻的「生成中 N 个」胶囊，首页不再订阅全量任务刷新计数；随之移除已无调用者的 `aiTaskManager.getActiveCount()`（`subscribeAll()` 保留，作品页仍在用）。
- 修复启动项单点异常会中断后续初始化：`onLaunch` 里原先只有 `initCloud()` 包了 `try/catch`，`appStore.hydrate()` 与 `aiTaskManager.init()` 任一抛错都会中断后续步骤（连 `wx.onNetworkStatusChange` 都注册不上）；而启动期同步抛错在真机上的表现与网络故障完全一致、极难定位。现改为 `runStartupSafely()` 逐项包裹，单项失败只降级该能力、不再牵连其他项。
- 归档历史提审说明：`docs/releases` 只保留 0.29 及以后的提审说明与 CHANGELOG，移出 0.25 / 0.28 共 19 个历史文件（仍在 git 历史里，需要时 `git show <sha>:docs/releases/<文件名>` 取回）。

## 0.30.10

- AI 生成任务化改造（P0/P1/P2）：把 AI 生成从「全局单任务 + 阻塞式等待页」改为「多任务队列 + 作品占位卡片」。新增 `services/ai-task-store.ts` 以数组持久化任务（替代原单例会话 `ai-generation-session.ts`，已删除），`services/ai-generation-manager.ts` 由单例执行器改为 `AiTaskManager`（`Map<taskId, AiGenerationFlow>` + 单 tick 调度 + `MAX_CONCURRENT = 2` 并发槽位），`ai-generation-flow.ts` 不再自带定时器、只暴露 `needsPoll()` / `pollOnce()`。
- 首页零阻塞：发起 AI 生成后立即返回可交互状态并即时在作品列表写入带封面的占位记录，可连续发起多个任务，不再强制跳转等待页。
- 作品页展示任务真实状态：`ai_pending` / `ai_failed` 卡片支持查看进度、重试、取消；AI 生成页改为按 `?taskId=` 绑定的任务详情页。
- 生命周期自愈：补齐冷启动自愈、`app.onShow` 追赶（`onAppShow` catch-up）、超时判失败与旧会话到任务队列的数据迁移。
- 任务与作品单向对齐：状态先落 `AiTask`，再由 `applyTaskToWorkItem()` 对齐到 `WorkItem`；AI 占位作品豁免云同步，只存本机。
- 修复 AI 产物底部平台「AI生成」标识被采样进图纸：混元生图（AR 链路）会在产物底部烙显式标识，而拼豆图纸按像素降采样，标识会被采样成一格格珠子混进成品图、施工图与材料清单。新增 `image-service.stripAiWatermarkBand()` 在**下载那一步**裁掉底部 12% 再落盘，保证一个任务只裁一次；解码或导出失败一律回退原图，不阻断生成链路。
- 首页入队反馈优化：发起 AI 生成后由居中 toast 改为**主按钮就地成功态 + 轻震动**（1.8s 后复位）。原 toast 感知弱，且用户视线与手指都在底部按钮上，紧随的 `resetUploadState()` 又让页面看起来像操作被撤销。
- 修复 AI 占位作品被永久钉成同步失败：「占位作品不上云」原本在 `saveWork` 与 `adoptGuestWorks` 各判一次，而 `markSyncStatus` 完全没判——同步服务对缺 draft 的作品回写 `failed` 时会给占位作品盖上 `ownerId`，导致它每次同步都被捞起重试、每次再写回 `failed`，错误文案常驻 UI。现收口为 `models/pattern.ts` 的 `resolveSyncFields()` 单一判定，并在读取侧 `getSyncCandidates()` 加占位过滤兜底（一并覆盖旧版本遗留的脏 `syncStatus`）。新增 `test/work-sync/` 不变式测试 12 例，已做变异验证。
- 新增提交信息规范：`<type>(<scope>): <中文简述>`，白名单见 `docs/development/COMMIT_CONVENTION.md`，`AGENTS.md` 第 12 节列为强制要求。

## 0.30.9

- 抽出编辑器底部控制面板为公共组件 `components/editor-control-panel`（缩放、图案信息、工具栏、调色板、重新生成/保存作品），编辑器页与 AI 生成页共用同一套分组与样式，不再各写一份。
- AI 生成页生成中状态补上该面板的禁用态：尺寸/颜色取本次任务设置、颗粒数按满格上限预估，调色板以占位色块保持高度稳定；生成完成跳转编辑器后同一面板变为可操作，解决生成等待期底部大片空白。
- 修复禁用态按钮不生效的问题：面板内 `.button-primary[disabled]` 之前会被启用态配色覆盖，现在保存作品/重新生成在未就绪时明确置灰。
- 精简 AI 生成页「生成中」中间状态：生成过程中不再展示待生成的原图预览，同时隐藏「返回首页」按钮和底部合规说明文案，只保留顶部 AI 生成提示、生成中动画卡片与禁用态面板。
- 明确分包依赖边界：将 `ai-generation-flow` 上提到主包 `miniprogram/services/`，并新增「分包与主包依赖规范」（`docs/frontend/MINI_PROGRAM_RULES.md` 第 7 节），禁止主包引用 `packages/` 下的模块与组件，避免启动期 `module ... is not defined` 崩溃。
- 修复 AI 精致生成必然失败的问题：混元图生图实际返回 JPEG，而模型临时地址缺失 `content-type` 响应头，云函数按 `|| 'image/png'` 回退把 JPEG 误标为 `.png`；服务端 `isPng()` 只认 PNG 魔数，导致任务恒定以 `AI_PROVIDER_OUTPUT_INVALID` 失败，小程序显示「AI 生成结果不可用，请重新生成」。
- AI 输出改为按真实字节魔数识别格式：云函数按下载内容判定 `contentType` 与文件名后缀；服务端 `HunyuanImageProvider` 接受 PNG / JPEG / WEBP，`ai-generation-service` 按实际格式命名与标注 MIME，`ai-file-storage` 移除「AI 输出必须是 PNG」限制，小程序 `AiOutputFile.contentType` 同步支持三种格式。
- 为 P0（AI 生成主链路）、P1（图纸转换与编辑、结果展示）、P2（登录账户、支付与额度）三条主链路补充中文注释：文件头写明职责/边界/调用方/关键点，导出成员加 JSDoc，行内只注释复杂分支、阈值、状态机、幂等与并发控制、SQL 与外部 API 调用，全部为纯注释改动（仅 5 处删除行，均为注释改写与 BOM 位移后原样补回的 import）。注释规范写入 `docs/development/CODE_RULES.md`。
- 新增提交信息规范 `docs/development/COMMIT_CONVENTION.md`：统一 `<type>(<scope>): <中文简述>` 前缀，给出 type / scope 白名单与正反示例，并在 `AGENTS.md` 新增「12. 提交信息规范」设为强制要求。

## 0.30.8

- 修复首页生成按钮在离开 AI 生成页后持续提示“正在生成”的问题：在首页 `onShow` 与 `startAiCreating` `finally` 中严格重置 `generating` 状态，恢复主链路操作。
- 移除首页标准模式创建流程中的 `clearAiGenerationSession` 调用，确保使用标准模式时不会误删除后台运行的 AI 任务。
- 新增全局单例 `aiGenerationManager`，支持离开 AI 生成页后在小程序后台继续维持轮询与结果获取，并在完成后自动生成草稿作品存入本地作品集。
- 增强「我的作品」页面：正在后台生成或失败的 AI 任务将置顶展示在作品列表中，点击可返回 AI 生成页查看进度，支持取消任务，生成完成后自动刷新展示为草稿作品。
- 增强本地多草稿恢复：在作品页打开未设置为主草稿的本地作品时，自动读取本地草稿池并无缝加载至编辑器。
- 新增 AI 输出格式诊断埋点（仅日志，不改变输出校验判定）：`generateImage` 云函数记录落盘文件的 `headerContentType`、真实字节格式与签名；服务端 `HunyuanImageProvider` 在输出校验失败、云存储回下载失败时记录文件引用后缀、字节数、魔数签名与大小阈值，用于区分「非 PNG 格式」与「空内容」。
- 恢复 AI 生成页「生成中」动画：启用此前未被任何页面引用的 `generating-preview-card` 组件，生成中状态展示调色盘呼吸动画与按阶段推进的近似进度（上传 12% → 提交 28% → 排队 45% → 处理 68% → 下载 86% → 转换 94%），底部提示胶囊优先展示网络重试、长时间等待等实时状态；加载态与失败态仍使用原状态卡片。

## 0.30.7

- 修复 `generateImage` 云函数 AI 请求超时：恢复 `cloud.init` 的 `timeout: 600000`，避免 SDK 默认 15 秒中断耗时较长的混元生图调用。
- 修复云函数环境解析：固定使用 `cloud.DYNAMIC_CURRENT_ENV`，不再读取可能被注入为其他环境的 `TCB_ENV`，避免生图结果写入错误的云存储环境。
- 增强 HTTP 触发入参解析：支持 base64 编码请求体与已解析的对象请求体，解析失败时记录日志并返回独立的 `INVALID_BODY`，不再误报为缺少提示词。
- 增强失败诊断：错误日志补充当前环境、上游状态码与厂商错误码，读取微信上下文失败时不再影响错误响应本身。

## 0.30.6

- AI 生图任务改为由服务端调用 `generateImage` 云函数，再由云函数内置的 `wx-server-sdk` 调用混元图生图模型。
- 保留现有登录、AI 额度、任务轮询、结果校验和项目文件持久化链路；小程序不直接接触模型凭据或云函数输出文件。

## 0.30.5

- 将服务端 AI 图生图切换为腾讯云 CloudBase `@cloudbase/node-sdk`，使用 `hunyuan-image` Provider 和 `HY-Image-v3.0-I2I-ToB-v1.0.1`。
- 按 CloudBase I2I 协议传入服务端生成的参考图 Base64，保留现有任务、用户额度、结果下载和持久化链路。
- 真实联调已确认 SDK 鉴权和模型调用链可达；当前环境返回 HTTP 429，未生成图片，符合控制台“生图额度 0 次”的现状。

## 0.30.3

- 新增 `generateImage` 微信云函数：通过内置 `wx-server-sdk` 调用混元生图模型，将模型临时图片下载后持久化到云存储 `ai-images/` 目录。
- 新增小程序云开发初始化和生图调用服务，客户端只接收云存储 `fileID` 并换取临时访问地址，不保存模型的临时 URL。
- 云函数固定使用 `wx-server-sdk` `4.0.2`，提示词限制为 500 字，支持四种预设图片尺寸。

## 0.30.2

- 将 AI 精致生成的上游模型从千问切换为腾讯云 TokenHub 的混元 Hy-Image-3.0 图生图模型（`HY-Image-v3.0-I2I-ToB-v1.0.1`）。
- 正式开放首页 AI 模式入口，用户可以进入 AI 生成流程。
- 保留小程序现有任务接口和轮询流程；服务端改为调用混元同步接口，立即下载并持久化临时 PNG 输出。
- 新增 `HUNYUAN_IMAGE_*` 服务端配置和 `provider_output_url` 任务字段；成功持久化后清空临时地址，不向客户端暴露上游凭据或临时 URL。
- 更新 Provider 测试、数据库迁移、生产验收说明、接口文档和隐私/第三方共享文案。

## 0.30.1

- 暂时关闭首页 AI 模式的用户选择：保留入口并标记“暂未开放”，点击不会进入 AI 生成；标准模式流程不受影响，后续只需打开首页 AI 模式开关即可恢复。
- 优化「我的」页面 AI 生成权益卡：清晰区分当前可用、今日免费和已购买次数，补充额度说明弹层及购买入口，改善额度理解与购买引导。
- 重构「购买 AI 生成次数」弹窗：压缩顶部额度信息层级，统一套餐卡片布局，突出当前选中项，并让主按钮动态展示本次支付金额；不改变套餐数据、支付流程和原有点击事件。
- 优化 AI 额度展示：拆分“今日免费剩余”“已购买”和“当前总可用”，避免把购买额度误认为次日会重置。
- 新增微信支付联调专用新人福利套餐：¥0.10 购买 5 次 AI 生成额度，每个从未成功购买 AI 次数的账号限购一次；测试完成后可停用。
- 优化标准模式进入「编辑拼豆图」页面时的首帧体验：Canvas 首次绘制完成前展示明确的准备状态，完成后平滑揭示图纸，并在准备期间禁用编辑、缩放和保存，避免短暂出现可操作的空白画布。
- 优化「我的」页面功能入口图标配色：收藏、下载记录和设置使用柔和的粉色、蓝色和紫色线性图标，保持与作品入口一致的 Iconsax 风格。
- 优化小程序生产包：排除测试代码与测试图片，清理 28 个未引用 SVG，并压缩默认头像与首页示例图，减少上传体积。
- 移除进入「我的」页面时对整个 `pages-sub` 分包的预加载，改为首次进入分包页面时按需加载，减少无效网络请求和首屏负担。
- 将原单一 `pages-sub` 拆分为编辑器、结果、账户支付三个普通分包，按功能隔离页面和私有代码，避免进入某一功能时加载无关页面。
- 进一步拆分为编辑器、AI 生成、结果、账户、支付和下载六个功能分包；AI 生成等待流程、账户支付页面和下载记录按需加载，编辑器只保留图案编辑职责。

## 0.30.0

- 接入小程序微信支付闭环：选择套餐后由服务端创建订单，小程序调用 `wx.requestPayment`，支付结果页通过服务端订单和 AI 额度确认到账状态。
- 增加微信支付生产接入说明，明确商户号绑定、API v3 密钥、HTTPS 回调、数据库迁移和上线验收要求。

## 0.29.12

- 下架购买 AI 生成次数页面的“AI 精致生成 150 次”套餐：新增 `server/sql/011_remove_ai_generation_150.sql` 将新旧环境中的该记录设为不可购买；历史订单和已发放额度保持不变。
- 新增 `pindou_schema_migrations` 迁移记录表与可选的 `deploy/migrate.sh` 手工迁移脚本，按迁移编号和 SHA-256 记录迁移状态；Jenkins 保持只部署 API，不自动连接生产数据库执行 SQL。
- 统一 AI 生成异常协议：Provider 原始错误仅保留在受控后端日志，403 `AllocationQuota.FreeTierOnly` 等错误不再透传到小程序。
- AI 任务公开响应改为标准 `failure` 对象，包含稳定错误码、分类、是否可重试和白名单操作；移除 `provider`、`model`、`promptVersion` 公共字段。
- Provider 轮询、临时输出下载失败保持任务 `processing`，由后续轮询继续恢复；成功任务仍只写入一条 `usage_debit`，失败任务不扣 AI 额度。
- 小程序按 `action` 展示重试、查看权益、重新选图或切换标准模式，并保留原图和 AI 会话用于恢复。

## 0.29.11

- 优化「编辑拼豆图」页面的 AI 生成中布局：Loading 卡片移出图片编辑画布的固定高度容器，减少上下无意义留白。
- AI 生成未完成前仅展示导航栏与 Loading 卡片，隐藏缩放、尺寸、颜色、颗数和编辑工具；生成完成后再切换到实际图片编辑区域。
- 保留现有 Loading 卡片的紫色视觉风格、进度条和主要文案，不改变 AI 生成流程及生成完成后的编辑能力。

## 0.29.10

- 修复选择「标准模式」后进入编辑页错误触发 AI 额度不足提示的问题。
- 根因：临时 `PatternDraft` 没有保存生成模式，编辑页会无条件读取并恢复本地 AI 会话；标准草稿可能被历史 AI 会话覆盖，进而进入 AI 额度和 AI 服务分支。
- 统一使用 `GenerationMode = 'standard' | 'ai'`，标准模式直接执行标准拼豆图算法；AI 额度检查、AI 服务调用和购买入口均仅在 `generationMode === 'ai'` 时执行。
- 作品摘要、持久化图案、AI 会话和编辑页重新生成均保存并恢复生成模式；新增数据库迁移 `server/sql/010_generation_mode.sql`，历史作品默认标准模式，AI 任务固定为 AI 模式。
- 新增标准模式额度为 0 / 大于 0、AI 模式额度边界、模式保持和持久化恢复回归测试；小程序类型检查、模式测试和后端测试全部通过。

## 0.29.9

- 修复「编辑拼豆图」页面 AI 生成次数不足时，点击「购买 AI 生成次数」按钮无跳转的问题。
- 根因：后端实际返回错误码为 `USER_AI_QUOTA_EXHAUSTED`，而前端 `showPurchase` 条件仅检查 `QUOTA_INSUFFICIENT`，导致购买按钮的 `wx:if="{{aiShowPurchase}}"` 始终为 `false`，按钮不渲染，页面只显示「重新生成」。
- 修复 `aiGenerationErrorMessage()` 中缺失 `USER_AI_QUOTA_EXHAUSTED` 的分支映射，补充 `case 'USER_AI_QUOTA_EXHAUSTED'`，文案与 `QUOTA_INSUFFICIENT` 一致。
- 修复 `ai-generation-flow.ts` 的 `handleGeneration()` 和 `retryGeneration()` 中 `showPurchase` 判断条件，将 `QUOTA_INSUFFICIENT` 单条件扩展为同时支持 `USER_AI_QUOTA_EXHAUSTED`。
- 编辑页 `onShow()` 新增购买返回后刷新逻辑：当页面处于 `aiShowPurchase` 错误状态时，返回编辑页会自动调用 `authStore.refreshAiQuota()`，次数充足后清除错误状态（`aiFailed: false, aiShowPurchase: false`），页面恢复可生成状态，不再继续显示「AI 生成次数不足」。
- 跳转目标为现有 `/pages-sub/recharge/index` 页面，已注册于 `app.json` 分包，无新增页面。
- 影响范围：`miniprogram/services/ai-generation-service.ts`、`miniprogram/pages-sub/services/ai-generation-flow.ts`、`miniprogram/pages-sub/editor/index.ts`；不改变任何 UI 视觉效果、其他 AI 错误处理流程和已有业务逻辑。

## 0.29.8

- 优化 AI 图片生成失败状态：当供应商返回 403-AllocationQuota.FreeTierOnly 时，后端统一映射为业务错误码 `AI_SERVICE_UNAVAILABLE`，不将供应商、额度不足、FreeTierOnly 等内部信息暴露给前端。
- 失败页面 UI：`AI_SERVICE_UNAVAILABLE` 错误标题改为「AI 生成暂时不可用」，说明文案为「当前暂时无法完成 AI 生成，请稍后再试，本次不会消耗生成次数」。
- 按钮逻辑：`AI_SERVICE_UNAVAILABLE` 等 `retryable=false` 系统错误只展示主要按钮「返回首页」，不展示「重新生成」，避免重复调用必然失败的 AI 服务；`AI_PROVIDER_TIMEOUT`、`AI_PROVIDER_ERROR` 等可重试错误仍展示「重新生成」。
- 次数扣减机制确认：当前实现为 AI 成功后才执行 `debitBucket()` 扣次数，失败路径不扣次数，已天然满足「系统原因失败不消耗生成次数」要求，无需修改。
- 影响范围：`server/src/modules/ai/qwen-image-provider.ts`、`server/src/modules/ai/ai-generation-service.ts`、`miniprogram/services/ai-generation-service.ts`、`miniprogram/pages-sub/services/ai-generation-flow.ts`、`miniprogram/pages-sub/ai-generation/index.ts`、`miniprogram/pages-sub/ai-generation/index.wxml`；不改变 AI 生成成功流程和页面样式。

## 0.29.7

- 修复开发者工具警告「组件 wxss 中不允许使用标签名、ID 和属性选择器」：`upload-status-card` 内 `[disabled]` 及两处 `image` 标签选择器改为普通类选择器（`--disabled`、`__preview-placeholder-icon`、`__reselect-icon`），样式效果逐条等价迁移，视觉与交互不变。
- 全量复查其余组件 wxss，无其他禁用选择器残留；`generating-preview-card` 的 `:host` 为组件合法用法。
- 模拟器中 `__dev__/WAServiceMainContext.js` 的 link preload 提示来自开发者工具内部脚本，与项目代码无关，无需处理。

## 0.29.6

- 修复代码质量扫描「图片和音频资源大小应不超过 200K」告警：删除无任何引用的 `assets/animations/ai-generation-loading.gif`（835KB），主包体积减少约 835KB。
- 该 GIF 为旧版 AI 加载动画遗留资源；现行加载态由 `generating-preview-card` 的 CSS 动效与内联 SVG 实现，不依赖该文件。
- 复核包内全部图片/音频资源，除该 GIF 外无超过 200KB 的文件；`typecheck` 通过。

## 0.29.5

- 修复微信小程序代码质量扫描「主包内不应存在主包未使用的 JS 文件」问题：`config/profile.js`、`services/ai-generation-flow.js`、`services/order-service.js` 均只被分包页面使用，已迁移出主包。
- `services/ai-generation-flow.ts` 与 `services/order-service.ts` 迁移至 `pages-sub/services/`，仅调整 import 路径；其依赖的 `image-service`、`ai-generation-service`、`ai-generation-session`、`token-storage`、`http-client` 仍被主包页面使用，保留在主包。
- 拆分 `config/profile.ts`：`HELP_QUESTIONS` 迁移为 `pages-sub/config/help.ts`；删除无任何引用的死代码 `PROFILE_MENU_ITEMS`（我的页菜单为 WXML 硬编码）。
- 本次为分包结构调整，不改变 AI 生成流程、订单列表和使用帮助页的功能与业务流程；`typecheck` 与 54 项 pattern 测试全部通过。

## 0.29.4

- 修复首页图片已经通过安全检测后，切换 Ai 模式并点击生成时，AI 输入上传仍触发第二次内容安全检测的问题。
- 首次图片检测结果新增可复用标识；AI 输入上传会校验用户、有效期和图片内容一致性，通过后复用原检测结果，同时保留无标识客户端的一次检测兼容路径。
- 新增数据库迁移 `server/sql/009_content_security_reuse.sql`，保存审核图片哈希；临时审核图片仍按原规则在回调或过期后清理。
- 补充检测结果跨用户、图片不一致及 AI 上传复用的回归测试，并同步更新接口契约。

## 0.29.3

- 调整 AI 图片安全边界：保留 AI 输入图片上传阶段的微信内容安全审核，移除千问生成结果的本项目二次微信审核。
- 千问输出仍需经过服务端真实格式、大小、尺寸、来源地址和持久化校验；生成结果安全审核由千问服务商负责。
- 同步更新 AI 接口、隐私政策、第三方共享清单、客户端提示和回归测试。

## 0.29.2

- 新增后端 OpenAPI 3.1 接口契约 `docs/backend/openapi.yaml`，覆盖 AI 生成相关接口并支持导入 Apifox。
- 更新后端文档索引，补充机器可读接口规范入口。
- 新增可复用的 Apifox 接口、目录和正向测试用例定义，覆盖 `POST /api/ai/generations` 的请求、鉴权和响应断言。
- 本次为接口文档与联调测试资产补充，不改变小程序用户侧页面、交互和核心业务流程。

## 0.29.1

- 新增独立 UI 组件 `generating-preview-card`：以浅紫色柔和渐变与微光氛围层实现图片预览区的 AI 生成中加载态，包含调色盘与灵感星星矢量图标、轻微呼吸浮动动效、居中标题与副标题、高精度进度条与右侧对齐百分比文字，以及底部半透明磨砂白提示胶囊。
- 将 `generating-preview-card` 接入「编辑拼豆图」页面（`pages-sub/editor`），替换旧版临时 GIF 加载层；在 AI 生成期间优雅呈现生成进度与状态，支持动态绑定 `aiProgress`。
- 编辑页支持 `preview=generating` 查询参数，便于在无真实后端 AI 任务时直接进行前端视觉验收与调试。
- 移除编辑页不再使用的旧版 ad-hoc loading 样式代码，精简代码体积。
- 补充完整的 AI 生成接口字段与状态流转文档 [`docs/backend/AI_GENERATION_API.md`](../backend/AI_GENERATION_API.md)。

## 0.29.0

- 修复图片已通过检测后启动 Ai 模式时上传状态卡重复显示“正在上传图片”的问题；图片检测结果保持成功，AI 输入准备改由生成按钮忙碌态反馈。
- 修复 AI 模式进入“编辑拼豆图”后原生画布遮挡加载动画、仅显示空白工作区的问题；等待和失败阶段不再渲染画布，并以编辑器锁定状态稳定展示蓝紫柔光 GIF 加载反馈。
- Ai 模式调整为上传 AI 输入图片后立即进入“编辑拼豆图”，在图片工作区展示 AI 优化与拼豆图生成状态；任务创建、结果轮询和完成后的标准图案转换均在编辑器内进行，完成后原位替换临时草稿，期间禁用编辑、缩放和保存，并保留后台恢复与分阶段重试。
- 首页“生成方式”说明改为标题后的可展开 tips，集中展示快速模式和 AI 模式说明，移除 AI 模式下方的重复提示条；不改变模式选择与生成流程。
- 完成小程序端 AI 模式 Phase 3：上传 `ai_input`、幂等创建任务、任务状态轮询、后台恢复、AI 输出下载和本地 `createDraft()` 转换。
- 新增 AI 任务本地会话与失败重试策略，下载失败和本地转换失败不会重复创建 AI 任务或重复消耗额度。
- 新增 AI 处理中页面，复用公共 `page-layout`，补充额度不足、网络退避、任务过期和服务响应异常等用户提示。
- AI 输出继续进入现有编辑器、结果页、作品保存和下载流程；同步更新产品流程、AI 设计和 API 契约文档。
- 补齐 AI 安全边界：API Key 仅服务端环境变量、图片真实格式/大小/尺寸校验、按用户限流、阿里云输出域名校验、临时地址立即下载持久化、客户端错误脱敏和 AI 输入/输出过期清理。
- AI 输出进入 `ai_output` 前再次执行微信图片内容安全同步检测，并在 AI 页面持续展示“当前生成结果由人工智能生成”。

## 0.28.20

- 完成 AI 精致生成后端 Phase 2：抽离服务端 Prompt 模板，升级至 `v2`，支持风格、细节和背景参数组合，并增加拼豆化前处理约束及固定输出限制。
- 增加 27 种 Prompt 参数组合、服务端 Prompt 透传和千问 I2I 请求约束测试；客户端仍不能提交任意 Prompt。

## 0.28.19

- 完成 AI 精致生成后端 Phase 1：AI 任务创建先落库返回 `queued`，千问 Provider 调用移出数据库事务，支持异步提交、任务状态推进、输出图片持久化和成功后单次 AI 额度扣减。
- 补充 Provider 请求、任务失败、输出下载/存储失败、幂等扣减和事务边界测试，并同步更新 AI 接口状态说明。

## 0.28.18

- 修复《付费服务协议》在小程序中打开后提示文档不存在的问题：补齐服务端 `paid-service` 文档注册，并增加接口回归校验。
- 充值页协议说明支持点击查看，关于页同步提供协议入口；支付能力仍未正式接入，不改变现有支付占位流程。

## 0.28.17

- 将意见反馈页接入微信小程序客服：移除未接入服务端的反馈表单、截图选择和假成功弹窗，改为通过原生 `<button open-type="contact">` 直接打开客服会话。
- 同步更新反馈、客服消息和图片权限相关的后端审计、API、数据库设计及隐私文档；本次不新增服务端接口、数据库表或文件存储。
- 修复首页四张示例图片在开发者工具预览或上传包中因动态资源引用未被打包而出现 404 的问题，显式将 `assets/samples` 纳入小程序包。

## 0.28.16

- 完善《付费服务协议》：新增服务端法律文档、版本与生效时间，充值页协议入口改为可点击并复用现有法律文档阅读页；关于页同步提供协议入口。
- 协议正文明确当前支付尚未正式接入、套餐与价格以订单页为准、支付确认后发放次数、异常与退款处理、AI 生成结果限制及未成年人保护，不改变现有支付占位流程。

## 0.28.15

- 统一小程序第三批高频图标：底部 Tab、“我的”入口、作品摘要、作品卡片、收藏卡片和结果页收藏按钮改用统一的 Iconsax 线性 SVG；移除相关 Unicode / CSS 手绘图标，不调整业务流程与数据接口。

## 0.28.14

- 修复点击收藏时 PostgreSQL 参数类型推断不明确导致接口返回 500 的问题；收藏写入 SQL 现在显式声明作品、用户和时间参数类型，并补充回归断言。

## 0.28.13

- 调整 Jenkins 健康检查流程：Compose 先启动 API，再由独立健康检查确认服务状态；检查失败时自动输出容器状态和最近 100 行 API 日志。
- 明确 Jenkins 不使用 `--remove-orphans`，避免清理与 API 项目无关的数据库容器。

## 0.28.12

- 调整 Jenkins 部署流程：Jenkins 不再按 Git 提交短 SHA 选择镜像，改为在 `162.14.123.*` 上直接拉取 `docker.cnb.cool/imacaiy/pindou-studio:latest` 并重启 API 容器。
- Jenkins 不管理数据库，也不执行 SQL 迁移；`config/api.env` 仅作为 API 容器的运行时配置，数据库仍位于 `120.53.19.*`。
- Jenkins 任务改为固定使用 `master` 节点上的 `production-docker` 标签，并增加 Docker、Compose 和 Docker Daemon 的部署前检查。
- CNB 的 `master` 推送构建改为串行执行，避免多个构建同时更新 `latest` 时出现旧镜像覆盖新镜像。

## 0.28.11

- 修复 CNB 流水线生产部署失败（日志 `BEGIN` 后紧跟 `psql:...001_ai_quota_and_jobs.sql:5: ERROR: must be owner of table pindou_quota_transactions`，Stage「SSH 部署到生产服务器」返回码 3，健康检查被跳过）：根因是**迁移账号不是被改表的 owner**。`001` 起的所有迁移都包含 `ALTER TABLE` / `COMMENT ON` / `CREATE INDEX`，PostgreSQL 要求执行者是被改表的 owner 或超级用户，只有表级 `GRANT` 不够；`config/api.env` 里的 `DB_USER` 没有 `pindou_quota_transactions` 的 owner 权限，于是执行到 `001` 第 5 行第一条 `ALTER TABLE ... ADD COLUMN` 就被拒绝。
- 修复方式：不修改生产库权限，而是让流水线在**启动迁移前先探测 owner 并失败**。新增 `psql_run` 封装连接参数，随后查询 `pg_tables` 找出 `pindou_*` 中 `tableowner <> current_user` 的表，命中则打印表名及其真实 owner 并退出，提示把 `DB_USER` 换成 owner 或用 owner 账号手工补跑。`.cnb.yml`（master push 与 `tag_deploy.production`）与 `Jenkinsfile` 三处同步实现。
- 之所以必须前置探测：`psql -f` 是逐句执行而非整体事务，旧流程即使 `001` 头部带 `BEGIN` 被回滚，后续脚本（`003` 无事务且是 `CREATE TABLE`）仍会落库，最终留下**半套 schema**；提前失败可保证「要么不开始、要么跑完整轮」，也让报错直接指向需要修改的账号而不是留在几百行日志中间。
- 单个迁移脚本失败时立即 `exit 1` 中断部署，不再继续执行后续编号脚本造成误导性报错。
- 同步更新 `server/README.md` 与 `docs/backend/operations/PRODUCTION_PAYMENT_AI_ACCEPTANCE.md` 的迁移前置说明：明确迁移必须由 `pindou_*` 表 owner（或超级用户）执行。
- 本次为部署流水线与文档修复，不涉及小程序页面与后端业务代码。

## 0.28.10

- 修复 CNB 流水线生产部署失败（日志 `BEGIN` 紧接 `ERROR: relation "pindou_orders" does not exist`，Stage「SSH 部署到生产服务器」返回码 3，健康检查被跳过）：根因是**迁移打错了库**。生产库是 `config/api.env` 中 `DB_HOST`（内网 IP）指向的独立 PostgreSQL 实例，而部署脚本用 `docker compose exec -T postgres sh -c 'psql ...'` 进容器执行，psql 连的是 compose 内那个**从未存过业务数据的空库**，`008_orders_user_created_index.sql` 第一句就在空库上建 `pindou_orders` 索引，必然报错；那批基础表由外部工具直接建在 `DB_HOST` 实例上，仓库只保存 001 之后的增量迁移，与本次故障无关。
- 修复方式：迁移改为在**服务器宿主机上用 `psql` 直连 `api.env` 的 `DB_HOST/DB_PORT/DB_NAME/DB_USER`** 执行，`.cnb.yml` 与 `Jenkinsfile` 两处同步修正；宿主机缺少 `psql` 或 `api.env` 缺少连接变量时直接报错退出，不再静默打到空库。
- 迁移范围从「只执行 `008`」改回「按编号执行 `server/sql` 下全部 `0NN_*.sql`」，脚本统一上传到 `/opt/pindou/deploy/sql/`；仍是先迁移、再启动 API，避免 API 因 Schema Contract 不一致反复重启。
- `deploy/compose.yaml` 删除无人使用的 `postgres` 服务（生产库是外部实例），`.cnb.yml` 同步去掉 postgres 镜像的公网拉取与搬运，少一次外部依赖。
- `001_ai_quota_and_jobs.sql` 补齐三档 AI 套餐插入（`ON CONFLICT DO NOTHING`）并把 AI 扣减幂等索引改为先删后建，`007_ai_generation_packages_only.sql` 的套餐停用逻辑并入 `001` 后删除，仓库由 8 个脚本收敛为 7 个。
- 同步更新 `server/README.md`、`docs/backend/operations/PRODUCTION_PAYMENT_AI_ACCEPTANCE.md`、`docs/releases/MINI_PROGRAM_RELEASE_0.28.0.md` 的迁移清单与前置说明。
- 本次为部署流水线、数据库迁移脚本与文档修复，不涉及小程序页面与后端业务代码。

## 0.28.9

- 修复 CNB 流水线「健康检查」阶段永久失败（`健康检查失败，查看最近日志：` + 60 次 `尝试 N/60: HTTP 000000` + `docker compose logs --tail 50 api` 只出现 `The "DB_NAME" variable is not set. Defaulting to a blank string.` 无关 env 告警）：根因是 `.cnb.yml` 健康检查 `ssh ... 'bash -s' <<'REMOTE'` 把远端命令用引号包成**单个参数**。CNB Runner 用 sh 执行脚本，sh 把 `ssh ... 'bash -s' <<'REMOTE'` 解析为「远端命令在 quoting 层、heredoc 在命令层」，于是 heredoc 正文被喂给**本地** sh 而不是远端。远端只收到 EOF 空脚本，立刻成功退出；本地 sh 则把远端脚本按脚本语言执行——日志里每次尝试打印两遍 `HTTP 000000`（`%{http_code}` 输出 `000`，再被 `|| echo 000` 追加）正是本地 sh 回显（远端只回一次）导致的，平台日志渲染把双份压成了一个。修复：远端命令不再加引号，并显式声明解释器 `bash -s <<'REMOTE'`；heredoc 正文与结束标识 `REMOTE` 顶格对齐。
- 同类问题一并加固：部署阶段 `ssh ... sh -s --` 改显式为 `bash -s --`（远端脚本含 `set -eu` 与 `for ... do`，不应依赖远端登录 shell 的解析行为）。
- 本次为部署流水线修复，不涉及小程序页面与后端业务代码。

## 0.28.8

- 修复 CNB 流水线生产部署失败（`archive/tar: invalid tar header`，Stage「SSH 部署到生产服务器」）：根因是搬运 postgres 镜像时写成 `docker pull -q postgres:17-bookworm && docker save postgres:17-bookworm` 并把整个命令组重定向进 `ssh ... docker load`，`docker pull -q` 也会向 stdout 打印 `Loaded image: postgres:17-bookworm`，该文本被混进 save 产生的 tar 流前部，远端 `docker load` 以 `archive/tar: invalid tar header` 失败。项目镜像那条 `docker save` 是纯 tar 输出，所以先 load 成功，日志中 `Loaded image: ...pindou-studio:latest` 之后的报错即来自 postgres 那条。
- 修复方式：`docker pull -q postgres:17-bookworm` 独立成行执行，仅把 `docker save postgres:17-bookworm` 的 stdout 重定向到 ssh 管道，stdout 只保留 tar 内容。master push 与 web 端「部署 production」（`tag_deploy.production`）两处同步修正。
- 本次为部署流水线修复，不涉及小程序页面与后端业务代码。

## 0.28.7

- 修复生产部署在已有数据库缺少 `idx_pindou_orders_user_created` 时持续健康检查失败的问题：部署流程现在先等待 PostgreSQL 健康，再执行幂等订单索引迁移，最后启动并等待 API，避免 API 因 Schema Contract 不一致反复重启。
- CNB master push、CNB `tag_deploy.production` 和 Jenkins 部署流程同步修正；数据库数据仍使用原有持久化挂载，不删除或重建数据卷。
- 修复 CNB 流水线生产部署失败（`error from registry: Blocked By Network Policy. 网络策略拦截。`）：根因是生产服务器出网被网络策略拦截，无法访问 `docker.cnb.cool`（也无法访问公共 Docker Hub）。此前部署依赖服务器执行 `docker compose pull`，一旦服务器本地没有待部署镜像就会联网并被拦截，整条部署流水线失败。历史上个别构建「看似成功」只是因为服务器本地已缓存了该镜像 Tag（如 `latest` 未变），并非真的拉取成功。
- 修复方式：不再让服务器联网拉取。改为在构建容器内 `docker save` 镜像，通过 ssh 管道直接 `docker load` 到服务器（构建容器可正常访问制品库），随后由远端 `docker compose up -d` 直接使用本地镜像。这是覆盖 0.28.6「改用仓库部署令牌让服务器自行拉取」的替代方案：0.28.6 仍需服务器出网，未解决网络策略拦截本身。
- `deploy/compose.yaml` 中的 `postgres:17-bookworm` 是公网镜像，服务器同样拉不到，因此在部署阶段一并从构建容器搬运到服务器。
- 移除已无用的制品库凭证注入逻辑（`REGISTRY_AUTH` / `CNB_REGISTRY_DEPLOY_TOKEN` / `/root/.docker/config.json`）：镜像已由 ssh 管道送入，服务器不再需要任何 registry 凭据，少一条会随 Token 失效的凭据链路。
- 远端拉取前的 `docker compose pull` 改为 `docker image inspect` 断言，镜像未就位时立即失败并给出明确原因，避免部署到旧镜像。
- master push 与 web 端「部署 production」（`tag_deploy.production`）两处部署脚本同步修正。
- 本次为部署流水线修复，不涉及小程序页面与后端业务代码。

## 0.28.6

- 修复 CNB 流水线生产部署失败（`docker.cnb.cool/imacaiy/pindou-studio:latest Error error from registry: Blocked By Network Policy. 网络策略拦截。`）：根因是流水线内置 `CNB_TOKEN` 只在 CNB 构建网络内有效（0.28.3 已确认该令牌出构建容器无效，但当时仅改了凭证传输方式，传出去的仍是同一枚内置令牌），外部服务器携带它请求制品库会被网关以网络策略拦截，而凭证格式错误只报 `unauthorized`，故判定为令牌使用范围的网络策略问题，非 JSON 格式或 compose 配置问题。
- 修复方式：外部服务器拉取镜像改用**仓库部署令牌**（只读、可撤销、官方文档指定的站外拉取凭证，用户名固定 `cnb`），令牌经 `envs.yml` 以 `CNB_REGISTRY_DEPLOY_TOKEN` 导入，缺失时立即报错；master push 与 web 端「部署 production」（`tag_deploy.production`）两处部署脚本同步修正。
- `docker compose pull` 补上 `--env-file /opt/pindou/config/api.env`（此前 pull 不带 env-file，日志出现 `The "DB_NAME" variable is not set` 等干扰性警告；api.env 已在 pull 前校验存在，无新增风险）。
- 本次为部署流水线修复，不涉及小程序页面与后端业务代码。

## 0.28.5

- 修复 CNB 流水线生产部署失败（`unable to get image ':': Error response from daemon: invalid reference format`）：根因是上一版把部署脚本改为 `ssh ... sh -s -- <参数> <<'REMOTE'` heredoc 传参时，远端只写了 `IMAGE_REPO="$3"`、`IMAGE_TAG="$4"`，没有 `export`。远端 `docker compose` 读不到这两个非导出变量，`deploy/compose.yaml` 的 `${IMAGE_REPO}:${IMAGE_TAG}` 插值成空串，compose 以空镜像名直接失败（日志同时出现 `The "IMAGE_REPO" variable is not set`、`The "IMAGE_TAG" variable is not set`）。
- 修复方式：远端改为 `export IMAGE_REPO="$3"`、`export IMAGE_TAG="$4"`，镜像地址与 Tag 显式进入远端环境，供 compose 插值；master push 与 web 端「部署 production」（`tag_deploy.production`）两处部署脚本同步修正。
- 同时让 `docker compose pull` 显式加载 `/opt/pindou/config/api.env`，确保 `DB_*` 与镜像变量在拉取阶段都能完成插值，避免再次出现空镜像引用。
- 本次为部署流水线修复，不涉及小程序页面与后端业务代码。

## 0.28.4

- 修复 CNB 流水线生产部署失败（`Conflict. The container name "/pindou-postgres" is already in use`）：根因是 `deploy/compose.yaml` 使用固定 `container_name`，而服务器上已存在的同名容器由历史手工 `docker run` 或其它 compose 项目创建，不带本项目 compose 标签，`docker compose up -d` 无法接管，直接以退出码 1 失败。修复为 `up -d` 前显式 `docker rm -f pindou-postgres pindou-api`（数据在 bind mount `/opt/pindou/data/*`，删除容器不影响数据）。
- 修复 `/root/.docker/config.json` 解析告警（`invalid character 'a' looking for beginning of object key string`）：根因是创作库凭证时用多层 ssh 双引号 + 单引号混拼 JSON，引号在传递过程中被 shell 吞掉。改为 `ssh ... sh -s -- <参数> <<'REMOTE'` 传远端脚本，凭证用 `printf '{"auths":{"%s":{"auth":"%s"}}}'` 由参数注入，不再拼字符串。
- `api.env` 校验从「文件可读」升级为逐项检查 `DB_NAME`/`DB_USER`/`DB_PASSWORD` 是否存在，避免 postgres 以空密码初始化（此前日志出现 `The "DB_NAME" variable is not set. Defaulting to a blank string.`）。
- 同步修正 web 端「部署 production」（`tag_deploy.production`）与 master push 两处部署脚本。
- 本次为部署流水线修复，不涉及小程序页面与后端业务代码。

## 0.28.3

- 修复 CNB 流水线生产部署失败（`Error response from daemon: Get "https://docker.cnb.cool/v2/": unauthorized`）：根因是流水线内置 `CNB_TOKEN` 只在构建容器内有效，把它透传到服务器后由服务器执行 `docker login`，服务器 sidecar 无法用该凭证换取仓库授权，登录失败后 `docker compose pull` 拉取私有镜像返回 unauthorized。
- 改为在流水线侧生成制品库 Basic 凭证（`base64(cnb:CNB_TOKEN)`），随 SSH 传到服务器写入 `/root/.docker/config.json`（docker/compose 原生读取的配置路径），`docker compose pull` 成功后立即删除该文件，不再在服务器上执行 `docker login`/`docker logout`。
- `docker compose pull` 改为显式判断：拉取失败时清理凭证并以非 0 退出，避免继续 `up -d` 把旧镜像当成部署成功。
- 同步修正 web 端「部署 production」（`tag_deploy.production`）与 master push 两处部署脚本。
- 本次为部署流水线修复，不涉及小程序页面与后端业务代码。

## 0.28.2

- 修复 CNB 流水线 SSH 部署失败（`cd: /opt/pindou/deploy: No such file or directory`）：此前假设服务器已初始化部署目录，现改为部署前远程 `mkdir -p` 并用 `scp` 上传 `deploy/compose.yaml`，首次部署不再依赖手工初始化。
- 部署前校验 `/opt/pindou/config/api.env` 存在，`docker compose up -d` 显式加 `--env-file`，与 Jenkinsfile 行为一致，避免 postgres 容器因 `DB_*` 变量未插值以空密码建库。
- 服务器拉取私有镜像前使用流水线内置 `CNB_TOKEN` 登录 `docker.cnb.cool`（用户名 `cnb`），部署完成后登出，对齐 Jenkinsfile 的镜像拉取认证方式。
- 修复 tag 部署（`tag_deploy.production`）引用未定义变量 `IMAGE_TAG` 的问题：改用内置变量 `CNB_BRANCH`（tag 名），与 tag_push 构建镜像使用的标签一致。
- 本次为部署流水线修复，不涉及小程序页面与后端业务代码。

## 0.28.1

- 修复生产部署流水线 SSH 认证失败（`Permission denied (publickey)`）：脚本此前固定写入 `id_rsa`，而流水线环境变量 `SSH_IDENTITY_FILE` 指向 `id_ed25519`，私钥文件名与服务器仅接受的公钥类型不匹配。
- 私钥统一写入 `~/.ssh/id_ed25519`，未显式声明身份文件时依赖 ssh 按密钥类型自动匹配；已声明时自动补全 ed25519 身份文件。
- 部署前新增密钥完整性校验：`SSH_PRIVATE_KEY`、`SSH_USER`、`SSH_HOST`、`SSH_PORT` 缺失或私钥非法时立即失败并输出明确原因，避免以 `Permission denied` 掩盖真实问题。
- master push 部署后新增「健康检查」Stage，沿用同一 ed25519 身份与校验风格，通过 SSH 在服务器本机轮询 `/health`（最多 60 次 ×2s），失败时输出最近 50 行 api 日志，避免部署后静默挂掉。

## 0.28.0

- 新增“我的订单”二级页面，从“我的”Tab 的权益卡下方直接进入，不新增底部 Tab，也不归入“账号与登录”。
- 新增 `GET /api/orders`，按当前 Bearer Token 查询 AI 生成次数订单，使用订单套餐快照并隐藏支付敏感字段。
- 新增订单用户与创建时间索引、分页/状态/金额/时间校验及订单归属、倒序、空列表和非 AI 商品过滤测试。
- 小程序额度接口解析标准下载与 AI 生成两个额度桶；支付成功页仅刷新 AI 额度，避免覆盖下载额度。
- 个人页和充值页改为读取 `/api/packages` 的服务端 AI 套餐；新增迁移停用历史 `starter`、`value`、`unlimited` 套餐并保留历史订单快照。

## 0.27.2

- 统一商品类型为 AI 生成次数：前端套餐与后端 `ai_generation` 配置一致，提供 ¥9.9/30 次、¥19.9/80 次、¥29.9/150 次，移除无限下载会员。
- 个人页、充值页和支付成功页改为展示 AI 生成额度；标准下载额度继续独立用于下载流程。
- 用户资料接口补充 `quota.aiGeneration`，避免购买入口文案与实际额度来源不一致。
- 修复作品与收藏列表封面图片地址异常：统一规范化历史本地回环地址和相对封面路径，并在图片加载失败时回退到现有占位图。

## 0.27.1

- 修复首页「开始生成」按钮与底部 TabBar 遮挡及留白问题：
  - 定位根因：自定义 TabBar 在微信小程序中为 `fixed` 悬浮于屏幕底部（高度 `128rpx + env(safe-area-inset-bottom)`），`page-layout` 独立滚动区域延伸至屏幕底部；此前首页容器类名与全局 `.page`（`min-height: 100vh`）冲突撑出了 80~100px 的冗余空白，但在直接缩减 padding 为 `24rpx` 后未计算 TabBar 自身高度，导致「开始生成」按钮被固定 TabBar 覆盖无法滑动查看。
  - 精确计算底部留白：在解耦首页容器（`.home-page` 设置 `min-height: auto` 消除多余撑满）的基础上，将 `.page-layout__content--main-tab` 底部内边距修正为 `calc(152rpx + env(safe-area-inset-bottom))`（即 TabBar 高度 128rpx + 视觉间距 24rpx + 安全区）；滑动触底时按钮刚好位于 TabBar 上方 24rpx（约 12px），既能完整展示并点击，又消除了多余占位。
- 修复未登录状态点击收藏提示错误与会话隔离：
  - 隔离内容安全审核的临时微信会话，使用独立的内存级变量进行缓存，不再调用 `saveAuthSession` 写入主用户本地存储 Key（`pindou-auth-session-v1`），避免游客被误判为拥有云端会话。
  - 在 `authStore` 中增加 `isLoggedIn()` 判定，统一收敛“是否存在有效登录用户”规则。
  - 结果页（`pages-sub/result`）收藏逻辑重构：未登录状态下点击收藏统一提示“收藏失败，请先登录”；仅在用户已登录且数据恢复同步中或作品待上传（`pending`）时提示“作品正在同步，请稍后重试”。
- 重构拼豆生成结果页面（`pages-sub/result`）：
  - 复用公共组件：移除页面自建的 `.result-nav` 导航栏，复用已有公共组件 `<main-tab-bar selected="{{1}}" />`，遵守公共布局强约束规范。
  - 抽离离屏 Canvas 渲染服务（`services/pattern-render-service.ts`）：解耦缩略图、成品图、编号施工图、高清施工图、材料清单图及色板参考图的绘制与导出逻辑。
  - 抽离页面子组件：
    - `work-summary`：独立作品信息头卡片与重命名、收藏交互。
    - `materials-panel`：独立材料清单展示与自闭环折叠/展开逻辑。
    - `palette-panel`：独立色板参考展示与自闭环折叠/展开逻辑。
  - 瘦身效果显著：`result/index.ts` 代码量从 976 行大幅缩减至 600 行以内，各子组件与服务均控制在 40~300 行内，消除了单文件超 800 行的架构违规。
  - 保持现有所有业务逻辑、视觉样式、暗黑模式适配及下载流程 100% 不变。

## 0.27.0

- 登录用户保存作品时默认写入云端；仅网络错误时才可靠降级为本机待同步，恢复网络后按作品创建幂等键自动补传。
- 本地状态升级为 v2：游客作品、按账号隔离的待同步作品与运行期云端缓存分开保存；退出登录会清空云端缓存但保留对应账号的待同步数据。
- 历史游客作品在登录成功后自动迁移至云端；迁移成功后同步补写收藏关联并更新本地关联 ID。
- 保存、游客迁移与退出登录等待关键本地写入完成；写入失败或容量不足会明确提示，不再把未落盘状态显示为已保存。
- 移除隐私页中未实际驱动功能的本地保存、云同步、服务通知和个性化推荐开关，改为真实的自动备份说明；服务端已有隐私字段保持兼容但客户端不再读取或写入。

## 0.26.0

- 收藏关系改为软删除状态机：首次收藏保留 `created_at`，当前收藏时间使用 `favorited_at`，取消收藏写入 `deleted_at`，重新收藏复用原记录。
- 收藏、取消收藏保持幂等，重复请求不刷新排序时间；收藏操作不修改作品 `updated_at`。
- 作品列表、详情、收藏列表和用户收藏统计统一排除软删除收藏；收藏列表增加 `favoritedAt` 并按该字段倒序。
- 新增 `006_favorites_soft_delete.sql` 数据库迁移和 Schema Contract 校验，补齐服务、HTTP 与真实数据库回归用例。
- 小程序接入云端收藏读写和本地收藏迁移，收藏页展示、最近筛选与排序统一使用收藏时间。

## 0.25.24

- 优化首页图片检测结果卡片（upload-status-card）的 UI 文案展示与垂直布局层级：
  - 删除“图片已通过检测”标题下方紧挨着的重复说明文案（“可以继续选择生成方式”），视觉上保持主标题简洁清晰。
  - 保留绿色勾选圆形图标与“图片已通过检测”状态标题。
  - 将检测结果说明移至“重新选择图片”按钮正上方，采用两行灰色次级文本（“图片符合要求，可继续使用”、“可用于生成拼豆图纸”），形成更自然的上下关系。
  - 优化右侧内容区垂直布局，建立清晰的“状态标题 -> 检测说明 -> 操作按钮”垂直层级。
  - 保持缩略图在左、内容区在右的基本卡片结构及品牌绿、圆角和阴影规范不变，不改动任何业务和检测接口逻辑。

## 0.25.23

- 重构「账号与登录」子页面：从半屏弹窗（Bottom Sheet）升级为标准独立二级页面：
  - 新增分包独立子页面 `pages-sub/account/index`，遵循微信小程序二级页面规范，使用标准顶部导航栏（包含返回箭头与居中标题），支持胶囊避让。
  - 实现极浅薄荷绿账号信息卡，展示用户头像、昵称、已登录小胶囊标签、微信云端同步辅助说明以及微克制拼豆点阵水印。
  - 实现标准白底卡片「资料管理」分组（编辑个人资料、刷新账号数据）与「账号操作」分组（优雅红字+红色图标退出登录）。
  - 接入 `authStore` 响应式数据流，支持刷新操作与 Toast 提示、退出登录原生模态弹窗（`wx.showModal`）二次确认保护。
  - 新增「编辑个人资料」独立子页面 `pages-sub/profile-edit/index`，支持昵称修改与保存。
  - 清理「我的」Tab 主页面中废弃的半屏账号弹窗结构（`account-sheet`）及相关冗余逻辑与样式。

## 0.25.22

- 优化「我的」Tab 已登录页面视觉比例与组件尺寸，对齐设计稿呼吸感：
  - 用户信息卡：高度提升至约 96px（192rpx），头像放大至 58px（116rpx，圆角 28rpx），昵称调整为 18px（36rpx Semibold），间距拉开至 15px（30rpx），内边距调整为 19px（38rpx），右侧箭头垂直居中。
  - 我的权益卡：高度提升至约 124px（248rpx），恢复上下层级结构；顶部为绿宝石图标与“我的权益”标题，下方左侧为“今日剩余”与 30px 绿色突出大字“9 / 9 次”，下方右侧恢复轻量白色胶囊按钮“获取更多次数 ›”（高度 36px，极轻阴影），强化视觉焦点顺序。
  - 2×2 功能卡片：单卡高度恢复至约 112px（224rpx），图标放大至 28px（56rpx）并位于左上角，标题调整为 17px（34rpx Semibold）并与图标保持 14px（28rpx）纵向间距，右侧箭头垂直居中，宫格间距调整为 11px（22rpx）。
  - 图标视觉重量：统一提高 4 个入口图标视觉重量，“我的作品”采用实体绿色圆角风景、“我的收藏”采用实体黄色五角星、“下载记录”采用加粗 2.5px 蓝色下载、“设置”新增实体灰色齿轮，保持四项重量均衡。
  - 卡片质感：统一大圆角 19px（38rpx），采用极轻柔和阴影，移除多余硬边框。
  - 页面流式布局：保持顶部自然排列与底部 TabBar 固定，长屏自然留白，不强制撑满或拉伸。
  - 保持现有所有业务逻辑、跳转、状态、API 及 Store 数据结构完全不变。

## 0.25.21

- 移除"我的"页未登录状态下的两处冗余文案：
  - 移除主标题下方副标题"同步作品、收藏和下载记录"
  - 移除页面底部"用户协议 · 隐私政策"链接行

## 0.25.20

- 修复前端页面将每日免费下载上限硬编码为 9 次的问题：
  - “我的”页面权益卡片展示从写死 `{{downloadQuota}} / 9 次` 改为动态绑定 `{{downloadQuota}} / {{dailyFreeDownloadQuota}} 次`，优先使用服务端返回的 `quota.dailyFree`，未登录或离线时安全回退至本地默认配置。
  - 同步优化“下载记录”页面（`pages-sub/downloads`）中的“剩余免费次数”展示，由写死 `/ 9` 改为绑定 `{{dailyFreeDownloadQuota}}`。
  - 同步优化生成结果页下载配额提示条组件（`download-quota-bar`），免费下载说明由固定“每日可免费成功保存 9 个文件”改为动态支持属性 `dailyFreeQuota`。
  - 导出 `app-store.ts` 中的 `DAILY_FREE_DOWNLOAD_QUOTA` 常量，统一多处前端降级回退口径。服务端后续调整环境变量 `STANDARD_DOWNLOAD_DAILY_FREE` 时，小程序前端 UI 自动同步生效，无需修改前端代码。
- 优化“我的”页面布局与设置入口：
  - 新增分包设置页（`pages-sub/settings/index`），收敛“使用帮助”、“意见反馈”、“隐私设置”、“关于我们”二级入口，简化个人中心主视觉。
  - 重构个人中心为 2×2 功能宫格（我的作品、我的收藏、下载记录、设置），清理个人中心未使用的冗余计数计算与未使用的样式。
  - 优化未登录引导界面及登录弹窗样式，移除冗余图标。
- 修复底部主导航栏（`main-tab-bar`）与页面布局层叠问题：
  - 优化 `page-layout` 嵌入式 TabBar 渲染判断，主 Tab 页面统一由微信系统自定义 TabBar 承载，避免嵌入式 TabBar 产生双重叠加。
  - 提高 `main-tab-bar` 的 z-index 并提供不透明背景底色与深色模式适配，避免滚动内容穿透。

## 0.25.19

- 移除“我的”页底部的“拼豆制作工具 · Version 0.25.16”展示文案及其样式，避免页面滚动时该非必要文案进入固定底部主导航的覆盖区域。
- 保留底部主导航与登录、充值等弹窗的按需遮罩行为，不改动账号、下载、导航或其他业务流程。

## 0.25.18

- 在首页选择 AI 生成方式后，于“生成方式”模块下方直接展示“✨ 当前生成结果由人工智能生成”合规提示；切回标准模式时自动隐藏。
- 提示采用浅黄色背景、金色边框和完整单行文案，并适配深色模式；不改动图片生成接口、AI 额度、尺寸、颜色或现有业务逻辑。

## 0.25.17

- 解决点击《用户协议》与《隐私政策》时跳转缓慢与白屏加载的问题：
  - 在 `app.json` 中为 `pages/profile/index` 配置 `preloadRule`，进入“我的”页面后异步预下载 `pages-sub` 分包（源码约 218KB），降低该版本内首次进入任意分包页面时的下载等待；预下载在页面渲染之后才发起，不保证用户点击时已就绪
  - 优化登录弹窗与路由时序：跳转协议前不再调用 `this.hideActiveSheet()` 销毁弹窗，避免 TabBar 在页面推入动画期间闪回；用户从协议页返回时，登录弹窗与协议勾选状态保持不变，登录流程连贯
  - 在 `legal-document-service` 与 `privacy-document` 中引入内存 + 本地存储双层缓存与 stale-while-revalidate 策略：命中缓存时先渲染本地内容，网络返回后仅当 `version` 或 `content` 变化时才重渲染，避免长文档二次重排与滚动位置跳动；首次安装无缓存时仍需等待接口响应
  - `wx.navigateTo` 增加 `fail` 回调复位 `preserveSheetOnNextHide`，避免跳转失败后标志残留、导致下一次页面隐藏时不关闭登录弹窗
  - 移除 `getCachedLegalDocument` 中多余的 `JSON.parse` 兼容分支：`wx.setStorageSync` 存对象后 `getStorageSync` 返回对象，且该缓存键前缀为首次发布，无历史字符串数据
  - 法律文档生效日期改为保留接口 ISO 值中的日历日期，避免设备时区导致北京时间生效日期显示成前一天；缓存与接口响应同时校验 `document.key` 必须与请求 key 一致

## 0.25.16

- 修复图片内容安全检测频繁出现 `NETWORK_ERROR (statusCode: 0)` 的问题：
  - 送审图片统一进行规格缩放与体积压缩（最长边 1024px，质量 0.8 JPEG），解决原图（3MB~15MB）直接上传导致网络传输超时与连接中断的问题
  - 在 Canvas 缩放异常时增加 `wx.compressImage` 自动降级保护
  - 在 `http-client` 的 `apiUploadFile` 中保留微信原生 `err.errMsg` 并在 `ApiError.details` 中透传，避免丢失底层错误原因
  - 在 `content-security-service` 中针对纯网络断连（`NETWORK_ERROR`）增加 500ms 快速自动重试 1 次，大幅提升弱网环境下的成功率
  - 本地作品同步（`syncLocalWorksToCloud`）中统一应用送审图片规格处理

## 0.25.15

- 修复“我的”Tab 作品数与统计项显示为 0 的问题：解决空值合并运算符（`??`）导致云端 0 值覆盖本地有效作品数的问题；统一聚合本地与云端作品总数；支持对全局 `appStore` 的订阅监听及页面激活时用户 Profile 数据的刷新
- 替换首页“重新选择图片”按钮图标：解决之前使用带有底色 SVG 及 `filter: brightness(0) invert(1)` 导致在微信小程序内渲染为纯白实心方块的问题，替换为简洁清晰的白色循环刷新矢量图标 `image-reselect.svg`
- 替换底部导航栏“作品”Tab 图标：更新 `projects.svg` 与 `projects-active.svg` 为全新作品箱/收纳包矢量设计，同步支持未选中（#8A908C）与选中（#12B466）状态
- 替换“我的”页“隐私设置”菜单图标：新增 `profile-menu-settings.svg` 齿轮设置矢量图标，与其它菜单项保持一致的描边与色彩风格（#626573），替换原盾牌图标

## 0.25.14

- 修复首页“开始生成”按钮在微信小程序中由于基础库默认样式导致左右留白过大的问题：显式设置宽度为 100%，与页面上方的卡片和设置项完美对齐
- 重构首页上传状态卡（upload-status-card）：支持图片上传实时进度条与百分比展示，优化检测中、检测未通过与读取失败状态的图标和重新选择操作交互
- 更新品牌头像图标资源

## 0.25.13

- 修复账号注销后同一微信无法再次登录的问题：注销事务现在清除旧账号的微信标识，下一次登录会创建独立的新账号，不继承旧账号的数据、作品、下载记录、额度或订单
- 新增数据库迁移 `server/sql/005_release_deleted_account_openid.sql`，使已注销账号释放微信标识，并同步更新数据库契约与隐私说明

## 0.25.12

- 优化“我的”页登录半屏弹窗：三个登录权益图标替换为 cloud-plus、refresh-square 和 gift SVG，统一使用 #08C76A 描边，并保持原有三栏文案、布局与图标规格
- 修复微信一键登录按钮在小程序中回退为内容宽度的问题：按钮现在占满弹窗内容区，左右保留既有 56rpx 安全边距；不改变按钮样式、协议、动画或登录业务逻辑

## 0.25.11

- 优化“我的收藏”作品卡片操作区：移除已收藏入口、独立查看按钮、三点菜单及其底部操作面板，改为与“我的作品”一致的查看作品、下载、取消收藏三项内联操作；保留原有查看、下载和取消收藏逻辑，并在取消后即时刷新列表与收藏统计

## 0.25.10

- 修复“我的作品”卡片底部操作区在小屏下仅显示重命名、下载和删除被挤出可视范围的问题：三个操作项改为普通可点击视图并等分右侧内容区，保留重命名、下载、删除事件、图标和按压反馈

## 0.25.9

- 优化作品结果页标题编辑按钮布局：将标题与 Pencil 编辑按钮置于同一个 flex 容器，编辑按钮紧跟标题右侧并保持 6px 间距，按钮尺寸调整为 24×24px（图标 14×14px），默认透明无边框、hover/active 时展示轻微灰色背景，长标题自动省略且保证编辑按钮不被挤压，右侧保留收藏 Heart 按钮安全间距
- 优化“我的作品”卡片布局与结构：作品信息区域（标题、规格色数、更新时间）聚合在左侧，状态标签调整至右上角；卡片底部操作栏按两端分布展示重命名、下载、删除内联操作，操作图标微调为 28×28px，字号 24rpx，改善卡片垂直空间利用率与视觉平衡

## 0.25.8

- 新增无依赖 API 健康监控工具，并行检查健康、套餐和隐私政策等只读接口，输出状态码、耗时和失败原因
- 支持通过配置文件维护监控地址与预期响应，失败时返回非零退出码，可接入服务器定时任务和告警系统
- 本次为部署与运维能力更新，不改变小程序页面、登录、上传、生成、支付或用户数据流程

## 0.25.7

- 重构“我的”页现有登录半屏弹窗：按参考稿调整白色面板、品牌图、权益 SVG、微信按钮、协议勾选、安全区和进出动画；未勾选协议时提示并阻止登录，保留现有授权和账号更新流程
- 新增《小露拼豆用户协议》正文，通过现有公共文档接口和阅读页面提供未登录访问；登录弹窗增加协议入口，隐私政策沿用原页面跳转
- Standard Pattern Engine V2 增加基于采样 RGBA 网格的 luminance + Sobel X/Y + gradient magnitude Edge Protection
- Edge Protection 在 Cleanup 阶段保护高对比结构附近的孤立色，不改变 Pattern Schema、MARD 数据、色板选择或页面业务流程
- 新增确定性 Node 测试，覆盖平坦图、亮暗边界、透明/尺寸边界、生产链路接入、colorLimit 和 Matrix 长度
- 本阶段未采集或伪造微信 Canvas Gate，仍需在微信开发者工具/真机完成真实图片视觉验收

## 0.25.6

- 将“我的作品”卡片的重命名、下载和删除操作改为卡片内联按钮，减少打开底部操作面板的额外步骤
- 保留作品重命名、下载、删除和草稿继续编辑流程，操作按钮直接使用当前作品 ID 处理目标作品
- 调整小屏作品卡片的操作区、重命名弹窗和按压反馈样式，改善操作可发现性与布局稳定性
- 注销账号在事务提交后按资产类型物理删除头像、作品封面和 AI 输入/输出文件，并补充删除后不可读的回归验证

## 0.25.5

- 新增版本化的《小露拼豆隐私政策》《个人信息收集清单》《第三方信息共享清单》和隐私发布检查清单，三份法律文档 API 统一使用 2026-09-07 版本
- 将法律正文从 `legal-document-service.ts` 移至独立内容模块，并补充未登录访问、版本、生效时间、非空内容和危险标签回归校验
- 修复登录/恢复链路在云同步开启时自动迁移本地作品的问题；本地作品仅在用户于隐私设置中明确确认后迁移
- 统一小程序用户可见品牌名称为“小露拼豆”，支付订单描述同步更新

## 0.25.4

- 登录弹窗中的《隐私政策》改为可点击入口，复用现有隐私文档页面
- 优化“我的作品”卡片标题、状态标签和更多操作的布局，改善小屏下的对齐与可用空间
- 固定微信开发者工具关闭 SWC 转译，降低当前小程序构建链路的兼容性差异
- 补充 Standard Pattern Engine V2 Phase 3 的微信 OffscreenCanvas 真实回归 fixture
- 修复 Jenkins 拉取 CNB 镜像时使用 Secret text 凭据的流水线配置

## 0.25.3

- 修复作品名称保存和改名在内容安全服务缺失时可能静默放行的问题；服务端现在对标题安全校验采用失败关闭策略，并为高置信度违规短语增加本地兜底，审核失败或命中风险时不会写入作品
- 清理主包遗留的微信 Canvas 基线测试入口和测试 fixture，并将法律文档服务迁移至 `pages-sub` 分包，减少主包无关代码
- 优化“我的作品”卡片和改名弹窗布局，统一项目标识为 `pindou_studio`

## 0.25.2

- 首页主标题“把图片变成拼豆图”增加局部字间距，缓解中文标题拥挤；不改变全局 H1 token 和业务流程

## 0.25.1

- 优化全局正文与标题排版，统一字体、字号、行高和字距 token
- 补充首页、顶部栏和结果页 Tab 的交互反馈；开发环境 Canvas 基线采集仅在 develop 环境运行，不影响体验版和正式版启动

## 0.25.0

- Standard Pattern Engine V2 补齐 Phase 3 OKLab 专项回归与 Phase 5 保守清理：固定 RGB/OKLab 分歧、Alpha 31/32、严格 tie、`colorLimit`、孤立近色斑点清理和生产 `createDraft()` 链路均有测试覆盖；真实微信 Canvas fixture 缺失时测试脚本会明确跳过，不伪造 Canvas Gate 结果
- 小程序统一使用每日 9 次标准下载额度文案和本地默认值，与服务端额度配置保持一致
- 完成 UI 设计系统第四阶段首轮暗色模式适配，统一背景、表面、文本、分隔线、状态色、卡片和按钮反馈，覆盖首页、结果页、编辑器及共享组件
- 补充 Phase 3/5 微信 Canvas runner、比较器和发布前回归说明；Phase 3/5 的真实微信 fixture 仍需在微信开发者工具中采集后才能完成对应 Canvas Gate

## 0.24.0

- 补齐 Standard Pattern Engine V2 Phase 3 OKLab 专项回归：Green/Blue 参考值、原始 RGB 引用与严格 tie、真实 `createDraft()` RGB/OKLab 分歧、Alpha 31/32 和 `colorLimit`；新增历史 Phase 3 微信 Canvas runner 与 Phase 2→Phase 3 比较器，真实微信 fixture 仍需开发者工具采集后才能完成 Canvas Gate
- 完成隐私设置接口和小程序接入：支持本地保存、云同步、服务通知、个性化推荐四项偏好读取与更新，并保持本地/云同步互斥
- 新增隐私政策、个人信息收集清单和第三方信息共享清单读取页面
- 新增账号注销确认流程：服务端事务内软删除账号、撤销会话、停用云端作品并保留财务审计记录
- 云同步开启前增加迁移确认，接口失败时回滚客户端开关状态；注销后的同微信账号重新注册策略和正式法律文本仍待产品确认

## 0.23.2

- 新增 UI 设计规范：统一排版层级、字体回退、色彩语义、Ghost/Glass 按钮、卡片阴影、4px 间距系统、分隔线、点击反馈和暗黑模式适配要求
- 完成阶段 2 共享组件统一：`.card`、`.ui-card` 和下载相关卡片改用无边框多层阴影；共享次级按钮、顶部更多操作和下载操作统一圆角、内嵌高光、按压缩放与 150ms 过渡
- 完成阶段 3 页面级迁移第一批：首页、作品、个人中心、收藏、下载、帮助、反馈、充值和支付成功页面的专属卡片与按钮接入统一圆角、阴影、Ghost/Glass 样式和点击反馈
- 完成阶段 4 暗黑模式第一轮：新增系统主题驱动的深色语义 token，统一背景、表面、文本、辅助文本、分隔线、状态色和阴影，并覆盖首页、结果页、编辑器及共享弹层组件

## 0.23.1

- 修复本地开发环境图片上传因 `mediaCheckAsync` 依赖 localhost 公网地址而失败的问题：先执行同步图片审核，开发环境跳过异步审核并清理临时文件，生产环境继续执行完整异步审核与回调
- 按 `ApiError.code` 区分图片格式、图片解码、网络、登录和内容安全错误，避免后端错误被误提示为图片无法读取

## 0.23.0

- 接入微信文本内容安全检测和图片内容安全检测
- 图片上传采用同步拦截并提交 `mediaCheckAsync`，新增异步审核回调和临时媒体清理
- 作品保存、改名和本地作品云同步统一执行文本安全校验；首次内容操作自动建立微信登录会话

## 0.22.0

- 标准下载免费额度改为每日 9 次，新增独立的每日 3 次 `ai_generation` 额度；额度流水、套餐和订单快照均显式保存 `quota_kind`
- 新增 AI 输入/输出文件、千问图像 3.0 异步 Provider、AI 任务表和 `queued -> processing -> succeeded/failed` 状态机；仅在输出校验和资产落库成功后幂等扣除 AI 额度
- 支付套餐与回调改为发放 `ai_generation`，录入 `¥9.9/30`、`¥19.9/80`、`¥29.9/150` 三档套餐，继续保持服务端金额快照、微信验签和重复回调幂等
- 新增生产配置硬门槛、健康能力状态、支付/AI 结构化监控事件、数据库迁移脚本和阶段 6 数据库回归替身；真实商户实付、生产持久卷、HTTPS 和外部告警仍必须按验收文档留证完成

## 0.21.2

- 将 `palette` 纳入云端下载闭环：登录用户成功保存色板参考后调用 `POST /api/downloads`，按标准下载额度扣减并写入下载记录
- 服务端、数据库约束、客户端响应解析和下载历史查询统一支持 `preview`、`chart`、`materials`、`palette` 四种下载类型

## 0.21.1

- Phase 4 默认施工色卡收敛为 MARD 经典 221 个不透明色号（A–H、M 系列），排除夜光、透明、珠光等特殊效果色；完整 291 色固定源数据继续保留，不复制色表
- Median Cut 最终色板选择前按 `colorLimit × 4` 过采样候选色并封顶 128 色，同时保留每个 Bucket 代表的像素权重
- 最终 MARD 色板改为确定性的加权贪心选择：以主候选色建立首个施工色，再按加权 OKLab 误差下降逐色补充，综合色偏与色阶覆盖共同参与选择，最终色数继续不超过 `colorLimit`
- 新增经典色卡范围、221 色数量、候选权重守恒、主色优先、限色与生产链路测试；真实微信 OffscreenCanvas 重新记录 6 个基线，最大 `128×128 / 64 色` 案例耗时 124 ms
- 使用同一组 6 张人物/动漫图片重跑视觉 A/B：经典色号合规率 100%，平均实际色数由 19.9 提升至 29.4（+48.2%）；受经典色卡色域收窄影响，平均 OKLab 误差比旧 291 色方案增加 3.3%，作为可施工性优先的已知取舍保留

## 0.21.0

- 完成 Standard Pattern Engine V2 Phase 3：最终最近色匹配从 RGB 欧氏距离升级为标准 OKLab 感知距离，Palette 与每个非透明 Cell 均只转换一次，tie 继续保留 Palette 前项
- 完成 Standard Pattern Engine V2 Phase 4：Median Cut 改为候选颜色分析，候选色映射到固定版本的 MARD 291 真实色卡并按色号去重，最终作品颜色数不超过 `colorLimit`
- 生成结果的 `color` 与 `colorCode` 现在直接使用真实 MARD 屏幕参考色和色号；Pattern Schema、页面、编辑器、作品保存、服务端与数据库接口保持不变
- MARD 数据固定到 `maxcleme/beadcolors@f97ff428`，记录 291 个唯一色号、来源 URL、提交版本与 MIT 许可；HEX 仅表示屏幕近似色，实物仍可能受批次、材质和光线影响
- 新增 OKLab 标准参考值、距离性质、tie、RGB/OKLab 分歧、MARD 数据完整性、候选色去重、`colorLimit` 与生产链路真实色号输出测试；历史 V1 基线继续由冻结 reference 独立验证
- 使用微信开发者工具真实 OffscreenCanvas 记录 6 个 Phase 4 结构化基线，Phase 2 / Phase 4 的尺寸、设置、Cell 数与透明格数保持一致，Matrix/Palette Hash 变化进入持续回归

## 0.20.1

- 优化“我的收藏”卡片布局：改为单列全宽，采用左侧正方形预览图、右侧作品信息与底部操作区；收藏状态移至标题右上角，长标题支持省略

## 0.20.0

- 新增 `GET /api/packages`、`POST /api/payments/create` 和 `POST /api/payments/notify`；套餐价格与额度完全从服务端读取，订单保存套餐名称、金额、额度和会员类型快照
- 接入微信支付 v3 小程序下单安全边界：商户请求签名、微信响应验签、回调原始报文验签、5 分钟防重放与 AES-256-GCM 通知解密；支付配置缺省时安全禁用，不伪造生产成功
- 支付回调校验商户号、AppID、订单号、金额、币种、付款人和成功状态，在同一 PostgreSQL 事务内更新订单并写入唯一的 `purchase_grant` 额度流水，重复回调不重复发放
- 登录时将支付所需 openid 以服务端 AES-GCM 密文写入现有 `openid_ciphertext`，API 和日志不暴露 openid、AppSecret、商户密钥或签名原文
- 支付成功页不再读取 URL 中的套餐、金额或额度参数，额度展示改为服务端刷新结果或已有账户缓存，客户端参数不能直接增加额度
- 补充服务端套餐快照、金额篡改、失败状态、订单不存在、回调验签失败、重复回调、微信 v3 验签解密及真实 PostgreSQL 联调测试

## 0.19.0

- 新增 `GET /api/quota/me`，按 `Asia/Shanghai` 自然日懒发放并汇总每日免费额度、今日使用量、购买额度、剩余额度和下次重置时间，数据库时间继续保存为 UTC
- 新增 `GET /api/downloads` 与 `POST /api/downloads`；下载历史保留作品标题快照且不返回 `fileUrl`，客户端成功导出后以 `Idempotency-Key` 记录一次下载
- 下载扣减在同一 PostgreSQL 事务中完成幂等校验、用户额度锁定、作品归属校验、下载记录和 `amount = -1` 流水写入，优先消耗今日免费额度，再消耗购买额度
- 额度不足返回 `402 QUOTA_INSUFFICIENT` 并完整回滚；同用户并发扣减通过用户行锁串行化，不会产生负额度
- 补充额度跨日、购买额度、免费优先、并发扣减、额度不足、重复请求、跨用户访问、标题快照和无下载 URL 的单元、HTTP 与真实 PostgreSQL 联调测试
- 小程序登录用户接入云端额度查询、下载成功上报和下载历史查询；服务端失败时保留本地缓存兜底，并使用幂等键支持上报重试

## 0.18.0

- 登录或恢复登录后自动将本地作品迁移到云端，成功后用云端记录替换本地记录，并刷新个人作品统计，保持作品列表与“我的”页面数据一致
- 为本地作品持久化完整图案草稿，支持多份本地作品逐个上传、幂等重试；上传失败或数据不可恢复时保留本地记录，不丢失用户数据
- 本地作品迁移时保留收藏和下载记录，并同步替换关联的作品 ID
- 修复登录用户下载成功后“我的”页面仍显示旧下载次数和免费额度的问题，成功下载后同步更新本地登录资料缓存

## 0.17.0

- 完成 Standard Pattern Engine V2 Phase 2：原图中心裁剪后先缩放至目标网格的 4× 中间 Canvas，再对每个 4×4 区域执行 Linear RGB Area Average，改善直接缩小造成的信息损失
- 采样 RGB 使用 Alpha 权重，透明像素的隐藏 RGB 不污染边缘颜色；Cell Alpha 使用区域平均并继续遵循现有 `alpha < 32` 透明阈值
- 新增 Phase 2 纯算法与编排测试，覆盖 sRGB/Linear RGB 边界、常量色、黑白平均、透明像素、行优先顺序、4× Canvas 参数和采样后 Alpha 31/32 边界
- 使用微信开发者工具真实 OffscreenCanvas 对 6 张结构化 Fixture 完成 V1/Phase 2 A/B：5 个案例产生预期 Matrix/Palette 变化，纯色案例保持一致，尺寸、设置、Cell 数量与业务接口不变
- `createDraft()`、Pattern Schema、Median Cut、RGB nearest、Palette/ColorCode、页面、服务器与数据库均保持现有接口和语义；本阶段未进入 OKLab、MARD、Cleanup、Edge 或 AI

## 0.16.0

- 修复编辑器工具栏“撤销、重做、画笔、吸管、填充”及封面生成、放大镜兜底文案的中文乱码，不改变工具行为或页面布局
- 建立 Standard V1 可重复执行的 Characterization Baseline，覆盖 Alpha 31/32、Median Cut tie-break、RGB 最近色 tie、Palette/ColorCode 顺序、HEX 与中心裁剪几何
- 新增 6 张程序生成的结构化 PNG fixture、微信开发者工具真实 OffscreenCanvas before/after baseline，以及稳定的 Cell Matrix / Palette FNV-1a Hash 比较；不引入第三方测试依赖
- 将 Standard V1 图片生成职责从 `image-service.ts` 原样拆分到 Standard Generator、Median Cut、RGB Color Utils 与 Crop 模块，`createDraft()`、Pattern Schema 和生成结果保持不变
- 将 10 个二级页面（editor/result/downloads/favorites/help/about/privacy/feedback/recharge/payment-success）从主包迁移至分包 `pages-sub`，主包仅保留 home/projects/profile 三个 Tab 页，显著降低主包体积
- `app.json` 新增 `subPackages` 配置，路由路径统一更新为 `pages-sub/xxx/index`
- 同步修复 profile、projects、home 中跳转二级页面的 `navigateTo` 路径（`pages/` → `pages-sub/`）
- 示例图片全部从 JPG 转为 WebP（home-sample-standard-1/2、home-sample-ai-1/2），brand-avatar 同步转 WebP，图片体积大幅缩减
- 删除旧版 JPG 资源（home-sample-*.jpg、home-bead-*.jpg）及设计参考图 home-reference.png，清理冗余静态资源
- 首页 `index.wxml` 仅做缩进格式化，无功能变化
- 作品结果页拆分混合类型导入为独立 `import type` 语句，消除一致类型导入导包告警

## 0.15.0

- 作品结果页补齐 4 个 Tab（成品图、材料清单、施工图、色板参考）统一下载半屏交互组件（`download-bottom-sheet`）
- 统一下载交互支持确认态（`confirm`）、处理态（`processing`）与成功态（`success`）状态机，由数据字典 `DOWNLOAD_CONFIGS` 驱动各 Tab 的文件格式、描述、标题与预览文案
- 下载确认半屏（DownloadConfirmSheet）还原 UI 稿：自适应内容高度、顶部拖拽手柄、卡片式文件说明与右侧勾选、保存位置/本次消耗/今日剩余明细、紫色渐变 CTA 按钮及取消操作
- 下载成功半屏（DownloadSuccessSheet）还原 UI 稿：绿色光圈勾选图标、对应 Tab 保存成功提示、扣除后的真实剩余次数标签条（绿色高亮）、主按钮支持查看图片/查看施工图/查看色板、完成按钮关闭弹层并保留当前 Tab
- 强化下载额度与安全机制：仅在文件成功写入设备相册（`saveImageToAlbum` 成功）后扣除 1 次额度并生成下载记录；取消、权限拒绝或生成失败均不扣次；确认后禁用按钮防重复点击与连续扣次；额度耗尽提供会员拦截与引导
- 拆分结果页数据计算与格式化工具函数至 `miniprogram/pages/result/utils.ts`，优化样式规则，所有代码文件严格控制在 800 行限制以内

## 0.14.0

- 首页新增「生成方式」区块，一行两张卡片：左侧「标准模式」（绿色体系，默认选中）、右侧「Ai 模式」（紫色体系）
- 生成方式数据驱动渲染（GENERATION_MODES 常量 + wx:for），两张卡片共用同一组件结构，互斥单选，视觉即时更新
- 页面新增 `generationMode` 状态（`'standard' | 'ai'`），`startCreating` 可读取当前模式；AI 模式暂未上线，点击开始生成展示明确 toast 提示，不伪执行标准流程
- 示例图片重组：前两张柯基、卡通女孩（标准模式 Demo）、后两张萌宠兔子、粉色公主（Ai 模式 Demo），移除雪山/红帽角色旧图引用；四张始终全部显示
- 示例图片底部新增轻量模式标签（标准绿色 / AI 浅紫色）
- 示例图改用明确的响应式方形尺寸，避免小程序渲染器忽略 `aspect-ratio` 后将缩略图拉伸成长条
- 修复示例图片一排四张尺寸不一致：四个 item 改为 `flex: 1 1 0` + `min-width: 0` 等分（不再依赖 `calc((100% - 48rpx) / 4)` 与百分比 flex-basis），图片高度、标签高度、圆角统一收敛到 `--sample-media-height` / `--sample-label-height` 两个变量，标准模式与 Ai 模式只保留配色差异；同时移除小屏媒体查询里被高优先级 `--standard/--ai` 选择器覆盖、导致图片比容器矮 8rpx 的尺寸冲突
- 「生成方式」卡片下方新增轻量「模式说明」区块（小圆点 + 模式名着色，标准绿色 / AI 紫色），说明文案由 `GENERATION_MODES` 的 `note` 字段驱动，仅展示、不参与任何模式切换与生成逻辑
- 四张示例图整体替换为 `docs/ui/ui-comparisons/home` 下的新图，统一导出为 512×512 JPG（84–132KB，合计 438KB），文件更名为 `home-sample-standard-1/2.jpg`、`home-sample-ai-1/2.jpg`；新图主体占框 90%–100%（旧 AI 图仅 87%），四张视觉尺寸差异收敛旧图备份在 `docs/ui/ui-comparisons/home/_replaced/`
- Section 标题统一升级为带绿色竖线样式（`section-label::before`）
- Hero 文案按 UI 稿更新为「把图片变成拼豆图 / 上传图片，自动生成拼豆图案」
- 上传区域按确认稿调整为外层白色卡片与内层绿色虚线框，保留原有选择、预览、删除和重新选择逻辑
- 新增首页本地 AI 紫色 token（`--color-ai`、`--color-ai-soft`、`--color-ai-border`、`--color-ai-text`），不影响全局
- 320px 小屏新增适配：卡片 gap、padding、icon 尺寸、字号均缩减，保证两列不折行

## 0.13.0

- 首页示例图片改用设计参考图中柯基、女孩、雪山湖泊和红帽角色对应的固定拼豆成品缩略图，移除整页截图放大裁切造成的模糊，并统一等比裁切、尺寸与圆角
- 编辑拼豆图最大缩放提升至 300%，缩放按钮改为每次 20%，双指继续支持连续锚点缩放与平移
- 画笔、吸管、填充、橡皮擦统一改为“按住选格、滑动微调、松手生效”，禁止 `touchstart` 直接修改网格，避免填充工具误触大片区域
- 新增固定线宽的蓝色目标格高亮，以及直接读取逻辑 grid 重绘的 7×7 精准放大镜，实时显示从 1 开始的行列坐标与当前色号
- 所有精准选格反馈复用 viewport、scale、translate 的正反向坐标映射；跨入相邻格时按能力提供节流的轻震反馈
- 主画布改为在固定 viewport Canvas 内按视图变换仅重绘可见 grid，避免微信原生 Canvas 高倍缩放时穿透工作区；封面继续通过屏幕外完整画布导出

## 0.12.0

- 将编辑拼豆图画布改为固定 viewport + 内部完整拼豆图模型；100% 按 viewport 与网格比例完整适配，移除固定 280px 小画布和大面积紫灰工作台背景
- 缩放范围统一为 100%～180%，Canvas 只绘制 100% 基础图，视觉缩放仅由 `scale / translateX / translateY` 驱动，避免绘制层与 CSS 双重缩放
- 双指缩放改为以双指中心锚定并同步支持双指平移；放大后支持单指有界 pan，四角 cell 可移动到工作区中心且图片不能无限移出
- 所有编辑工具统一通过 viewport、平移和缩放的逆变换映射 `grid[row][column]`；单指移动超过 10px 后只平移，tap 才执行画笔、吸管、填充或橡皮擦，双指操作不触发编辑

## 0.11.0

- 重构“编辑拼豆图”画布交互为可平移工作区（Workspace），支持双指平移拖动画布与双指 Pinch 缩放（以双指中心为基准），单指/双指手势互斥且互不干扰绘制
- 编辑器最大缩放比例由 140% 提高至 180%，支持 64×64 / 96×96 细节精细编辑，缩放控制按钮超限自动禁用，并新增“适应”按钮一键恢复居中与 100% 比例
- 强化画笔、吸管、填充、橡皮擦工具选中态（紫色背景 `#F1ECFF`、紫色描边 `#7C5CFF` 与独立紫色高亮图标），提升操作状态辨识度
- 作品结果页施工图新增高清图生成与点击全屏大图预览能力，支持手势缩放清晰查看每格色号编号

## 0.10.1

- 统一作品结果页四个 Tab 的整行下载按钮，新增免费下载次数气泡说明与“开通会员享无限下载”入口，并补齐成品图、材料清单、施工图、色板参考的本地图片保存能力
- 下载额度改为仅在图片成功保存到相册后原子扣减并写入对应类型的下载记录；保存中禁用重复触发，失败、取消或权限拒绝不扣次数，本地免费额度按自然日 00:00 恢复

## 0.10.0

- 新增作品收藏与取消收藏接口，使用 `pindou_favorites` 的 `(user_id, work_id)` 唯一约束保证重复操作幂等，并限制为当前用户自己的可用云端作品
- 新增按最近收藏时间排序的收藏摘要列表，支持标题查询和分页，且不读取或返回完整图案数据
- 补充收藏请求校验、重复收藏、重复取消、跨用户访问、分页排序及真实 PostgreSQL 联调测试

## 0.9.2

- 将作品结果页色板参考改为默认展示前 5 色与“全部”的单行摘要，移除重复展开 CTA，可展开复用完整四列色板并随时收起，同时补充安全计算的真实颗数占比与小屏适配

## 0.9.1

- 优化“我的作品”卡片操作：卡片直达详情、草稿直接提供继续编辑，并将重命名、下载、危险删除收敛到带作品信息的紧凑底部菜单
- 将作品结果页色板参考重构为四列正方形色块网格，移除单色大卡片与主视图中的 HEX 信息，并补齐列表后的色板下载入口
- 修复作品结果页施工图被固定高度内层滚动区域截断的问题，改为离屏导出后按原始比例完整展示，并提升作品信息、页签及施工图标题说明的文字可读性
- 移除作品结果页标题旁重复实现的“更多”菜单及胶囊样式，保留微信原生右上角系统胶囊，并恢复标题相对屏幕水平居中
- 作品结果页新增作品名称编辑入口；云端作品改名持久化到后端并同步“我的作品”列表，游客作品写入本地持久化状态
- 材料清单恢复“颜色、数量、占比”三列结构并显示一位小数百分比；默认仅展示用量最高的 5 种颜色，可展开或收起全部颜色，下载入口紧跟列表展示
- 修复首页上传卡片点击未触发图片选择的问题，改由原生按钮承载选择动作并增加忙碌态防重复点击
- 将包内品牌头像按实际展示场景压缩到 200 KB 以下，修复微信开发者工具图片和音频资源代码质量检查失败
- 修复编辑页自定义导航栏未使用真实胶囊高度，导致返回按钮和标题在刘海屏上对齐偏移
- 将编辑拼豆图页面的返回按钮定位到左侧 32rpx，并扩展为 88rpx 方形点击热区，保持标题相对屏幕居中
- 统一所有子页面返回按钮的左对齐位置，并修复关于页右侧状态文案被箭头样式放大的问题
- 将作品结果页成品大图改为离屏画布导出后的普通图片，修复滚动漂移；切换结果类型时不再重绘顶部图片
- 修复取消图片选择时将微信返回的普通错误对象误判为读取失败的问题，用户主动取消后不再弹出提示

## 0.9.0

- 修复 Windows 微信开发者工具临时图片路径导致的误报：选择图片后优先交给图片组件解码，并通过加载事件获取尺寸，不再把本地 `getImageInfo` 失败误判为上传接口失败
- 小程序完整接入阶段 2 云端链路：封面上传、作品创建、分页列表、详情恢复、改名、编辑覆盖保存和删除；游客流程继续使用本地存储
- 新增 `PUT/PATCH /api/works/:id`，支持标题、状态、封面和完整图案更新，服务端重新校验归属与图案并计算摘要数据
- 新增封面公开读取接口，修复上传成功后服务端返回的封面地址无法展示的问题
- 编辑器补齐填充、橡皮擦、吸管、撤销和重做操作，编辑后的网格可真实持久化到后端
- 新增真实 PostgreSQL 阶段 2 联调测试，覆盖上传、创建、列表、详情、更新、封面读取、删除及测试数据清理

## 0.8.0

- 新增封面文件上传与对象存储元数据写入，校验真实 MIME、扩展名、大小和图片可解码性，不保存原始图片
- 新增作品保存、分页列表、详情历史恢复和软删除接口；服务端校验 PersistedPattern 并重算尺寸、豆数和颜色数
- 作品保存使用幂等键避免网络重试重复创建，并补充归属、事务、分页、恢复、删除和上传测试

## 0.7.1

- 停止小程序端头像上传和远程头像读取，资料保存改为仅更新昵称并继续使用本地品牌默认头像
- 保存昵称后直接更新本地账号缓存，避免头像请求失败或资料刷新失败导致登录态被清除

## 0.7.0

- 将“我的”页面游客态、登录弹层和个人资料编辑器的默认头像替换为新的拼豆女孩品牌图片，并生成 512×512 优化资源控制小程序包体
- 登录成功且头像或昵称为空时，自动打开“完善个人资料”弹层；账号管理弹层支持再次编辑资料
- 接入微信 `chooseAvatar` 与 `input type="nickname"`，支持头像预览、昵称校验、保存中、失败和取消状态
- 新增用户昵称更新、头像上传和公开头像读取接口；头像限制为 2 MB 的 JPG、PNG 或 WEBP，并校验真实文件头
- 新增服务端头像持久化目录与旧头像安全清理，数据库保存稳定头像地址，AuthStore 更新后同步页面与 Token 缓存

## 0.6.0

- 新增小程序 HTTP 请求、API 错误解析、微信登录服务和安全 Token 存储模块
- 新增独立 AuthStore，支持启动恢复、登录、刷新、弱网缓存、Token 过期和本地退出状态
- “我的”页面接入真实 `wx.login()`、`POST /api/auth/login` 和 `GET /api/users/me`，并同步账号统计与下载额度
- 新增开发、体验、正式环境 API 地址配置，以及微信合法域名、HTTPS、AppID/AppSecret 部署说明

## 0.5.0

- 新增 `POST /api/auth/login`，通过微信登录凭证换取用户身份，并以 `openid_hash` 幂等创建用户
- 新增随机 opaque token 会话，数据库只保存 `token_hash`，支持过期、撤销和 Bearer 鉴权校验
- 新增 `GET /api/users/me`，返回允许为空的用户资料、作品/收藏/下载统计与额度摘要
- 补充登录失败、重复 openid、有效/无效/过期/撤销 token、数据归属和敏感信息保护测试
- 未实现作品、文件、收藏、下载额度写入或支付等后续阶段接口

## 0.4.0

- 新增 `server/` Node.js + TypeScript 后端基础工程，不改变现有小程序业务流程
- 新增启动配置校验、PostgreSQL 连接池和只读数据库契约检查，覆盖 10 张 `pindou_` 表的字段、索引、外键、CHECK 与注释
- 新增 `GET /health`、统一 requestId 错误响应、优雅停止和最小配置/健康检查测试
- 未实现登录、作品、收藏、额度、下载或支付等后续阶段业务接口

## 0.3.4

- 优化「获取下载次数」底部弹窗的套餐图标、价格和选择状态对齐
- 使用统一套餐图标容器与 CSS Radio，移除支付方式前的错误 Unicode 黑点
- 不改变套餐数据、选择逻辑、支付逻辑、弹窗结构和按钮文案

## 0.3.3

- 修复「我的作品」与「我的」页面统计卡片和功能列表图标，统一使用本地 SVG 线性图标资产
- 还原 gallery、download-to-tray、star、question-circle、message-square、shield 和 info-circle 图标，并统一尺寸、线宽与对齐方式
- 「我的」页面新增权益状态徽章图标；不改变页面业务逻辑、数字数据、菜单文案和底部 TabBar

## 0.3.2

- 新增 `docs/backend/API_SPEC.md`，收敛第一版后端接口范围、鉴权、历史作品恢复、客户端导出下载和支付回调边界
- 新增 `docs/backend/database/DATABASE_DESIGN.md`，确定 `Work`、压缩图案、封面文件、额度流水、下载记录和支付订单的数据模型
- 明确第一版不迁移图片量化到服务端，不开发生成任务 API、服务端下载文件 API 和云同步开关
- 统一数据库物理表名使用 `pindou_` 前缀，并新增可交给 OrcaTerm AI 执行的 `docs/DATABASE_CREATE_PROMPT.md`
- 补充数据库表用途总览、字段注释要求和建表后的数据字典校验要求
- 新增 `docs/BACKEND_DEVELOPMENT_PROMPT.md`，提供在当前仓库内分阶段开发后端的 OrcaTerm AI 提示词

## 0.3.1

- 修复首页上传图片后预览区域仍保留原上传框浅色背景和固定尺寸的问题
- 上传图片后使用 `wx.getImageInfo` 读取原图真实宽高，按最大宽度（670rpx）和最大高度（480rpx）约束计算预览尺寸，保持原图比例，不裁剪、不拉伸
- 引入 `upload__preview-wrap` 容器，宽高通过 JS 动态注入 inline style，图片铺满容器（`mode="scaleToFill"`）
- 已上传状态下隐藏上传框边框和浅色背景，容器跟随图片比例自然伸缩
- 删除按钮改为相对于实际图片预览容器定位，不再依赖原上传框宽度

## 0.3.0

- 修复公共导航返回图标在点击区域内未左对齐的问题
- 修复编辑拼豆图等子页面的公共导航标题偏移问题，标题始终按页面水平中心展示
- 新增统一 PageLayout、独立 ScrollArea 和复用型主导航组件，完成子页面导航栏、安全区与底部遮挡治理
- 按 `docs/ui` 完成我的、我的作品、我的收藏、下载记录、使用帮助、意见反馈、隐私设置、关于我们和下载次数页面
- 新增支付成功展示页，并保留微信支付、云同步、历史作品详情、文件导出和反馈提交等外部服务的待接入边界
- 补齐作品搜索筛选、收藏切换、作品删除确认、反馈截图选择、隐私偏好持久化和下载记录模型
- 统一全局绿色品牌 token、卡片、按钮、输入框、Tab 和底部导航视觉，并完成微信开发者工具截图验收

## 0.2.5

- 统一页面布局目标为 PageLayout、CustomNavbar、ScrollArea 和可选 StickyTabs，并明确后续迁移页面范围

## 0.2.4

- 强化公共页面布局复用约束，禁止为单页创建导航栏、安全区、Tab 或滚动逻辑的专属替代实现

## 0.2.3

- 补充微信自定义导航栏的窗口信息、胶囊位置、公共高度计算、组件复用和多设备验收规范

## 0.2.2

- 补充自定义导航栏固定范围、独立滚动区域、Tab 吸顶和顶部高度计算规范

## 0.2.1

- 将项目规则文件规范化为 AGENTS.md，并压缩多余空行
- 新增微信小程序自定义导航栏、安全区和滚动结构规则

## 0.2.0

新增：

- 根据上传图片生成真实拼豆网格，并按照目标颜色数量完成自动量化
- 重构拼豆编辑器，增加成品预览、缩放、工具栏、色板选择和实际豆数统计
- 完成作品结果页，提供成品图、材料清单、编号施工图和色板参考
- 增加作品摘要、收藏状态、下载额度入口、异常提示和结果页底部导航
- 建立统一 UI 设计规范，并将首页、编辑器和作品结果页统一为紫色品牌视觉
- 完成关键页面的小屏适配、空状态和逐模块截图验收



## 0.1.0

初始化项目


## 0.1.1

新增：

- 工程开发规范
- UI开发规则
- 代码质量要求


## 0.1.2

新增：

- 小程序开发规范
- 产品流程管理
