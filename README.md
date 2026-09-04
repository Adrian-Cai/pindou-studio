# 一起拼豆吧（Pindou Studio）

一个面向拼豆爱好者的微信小程序：上传图片后，将图片转换为可编辑的拼豆图案，并进一步生成成品图、材料清单、施工图和色板参考，帮助用户从「一张图片」完成到「可以实际照着制作的拼豆方案」。

当前项目版本：`0.23.0`

## 项目定位

项目当前围绕两条生成路线设计：

- **标准模式**：本地图片算法生成拼豆图，当前主要可用能力。
- **AI 精致模式**：后端已具备千问图像异步任务、文件和独立额度状态机；小程序调用接线和真实生产配置仍需按上线验收文档完成。

核心目标不是单纯做图片像素化，而是形成完整的拼豆制作流程：

`上传图片 -> 生成图案 -> 编辑调整 -> 生成结果 -> 查看材料/施工图/色板 -> 保存作品 -> 下载使用`

## 当前已实现能力

### 1. 图片生成与拼豆算法

- 支持从相册选择图片并生成拼豆图案。
- Standard Pattern Engine 已进入 V2 Phase 2。
- 图片先进行中心裁剪，再缩放到目标网格的 4× 中间 Canvas。
- 使用 Linear RGB Area Average 对每个区域采样，降低直接缩小造成的信息损失。
- 透明像素使用 Alpha 权重处理，并保留透明阈值规则。
- 保持现有 Pattern Schema、Palette、ColorCode 和业务接口稳定。

### 2. 拼豆图编辑器

- 支持画笔、吸管、填充、橡皮擦。
- 支持撤销、重做。
- 支持双指缩放和平移。
- 最大缩放支持到 300%。
- 支持精准选格、目标格高亮和 7×7 放大镜辅助编辑。
- 编辑工具统一基于逻辑 Grid 工作，缩放和平移不会改变底层图案数据。

### 3. 作品结果

结果页当前包含四类结果：

- 成品图
- 材料清单
- 施工图
- 色板参考

四个 Tab 使用统一下载交互，并包含确认、处理中、成功等状态。

下载成功写入设备后才会消耗下载额度；取消、权限拒绝或生成失败不会扣减。

### 4. 账号与作品数据

- 游客作品可保存在本地。
- 登录用户作品接入自建后端。
- 支持作品封面上传、保存、列表、详情恢复、编辑更新、改名和删除。
- 用户登录或恢复登录后，可自动将本地作品迁移到云端。
- 迁移失败时保留本地数据，避免作品丢失。
- 本地作品迁移后会同步修正收藏和下载记录关联的作品 ID。

### 5. 内容安全审核

- 首次上传图片或本地作品改名时自动建立微信登录会话。
- 图片上传经过同步图片安全拦截，并提交微信 `mediaCheckAsync` 接收异步审核结果。
- 作品名称在客户端和服务端保存前均经过微信文本内容安全检测。
- 原始审核图片只在服务端临时保存，审核完成或过期后清理。

### 6. 下载额度与下载记录

后端已提供：

- `GET /api/quota/me`：获取每日免费额度、今日使用量、购买额度、剩余额度和下次重置时间。
- `GET /api/downloads`：获取下载历史。
- `POST /api/downloads`：记录一次成功下载并执行额度扣减。

下载额度按 `Asia/Shanghai` 自然日计算，数据库时间统一保存为 UTC。

扣减过程在 PostgreSQL 事务中完成，并包含：

- 幂等校验
- 用户额度行锁
- 作品归属校验
- 下载记录写入
- 额度流水写入
- 免费额度优先消耗
- 购买额度兜底
- 额度不足完整回滚

### 6. 小程序包体优化

当前主包只保留三个核心 Tab 页面：

- 首页
- 我的作品
- 我的

编辑器、结果页、收藏、下载记录、帮助、反馈、隐私、关于、充值等二级页面已经迁移到分包，降低主包体积。

## 页面结构

### 主包

- `pages/home/index`：首页 / 上传图片 / 生成方式选择
- `pages/projects/index`：我的作品
- `pages/profile/index`：我的

### 分包 `pages-sub`

- `pages-sub/editor/index`：拼豆图编辑器
- `pages-sub/result/index`：作品结果
- `pages-sub/favorites/index`：我的收藏
- `pages-sub/downloads/index`：下载记录
- `pages-sub/help/index`：使用帮助
- `pages-sub/feedback/index`：意见反馈
- `pages-sub/privacy/index`：隐私设置
- `pages-sub/about/index`：关于我们
- `pages-sub/recharge/index`：下载次数 / 额度相关页面
- `pages-sub/payment-success/index`：支付成功展示

## 技术架构

### 微信小程序

- 原生微信小程序
- TypeScript
- 微信原生 Canvas / OffscreenCanvas
- 自定义组件
- 主包 + 分包结构
- 本地状态与本地持久化

根目录主要开发依赖：

- TypeScript `5.9.x`
- `miniprogram-api-typings`

### 后端

后端位于 `server/`：

- Node.js `>= 24`
- TypeScript
- PostgreSQL
- `pg`
- `busboy`
- Node.js 原生 Test Runner

后端主要负责：

- 登录用户作品数据
- 作品封面上传
- 本地作品云端迁移
- 用户下载额度
- 下载记录
- 幂等与并发扣减

## 目录结构

```text
pindou-studio/
├── miniprogram/             # 微信小程序主体
│   ├── assets/              # 运行时图片和图标
│   ├── components/          # 通用组件
│   ├── config/              # 产品常量与设计配置
│   ├── models/              # 领域类型
│   ├── pages/               # 主包页面
│   ├── pages-sub/           # 分包页面
│   ├── services/            # 微信 API / 后端接口封装
│   ├── store/               # 全局轻量状态
│   └── utils/               # 工具函数
├── server/                  # 自建后端
├── test/                    # 图案算法等测试
├── docs/                    # 产品、UI、开发规范与变更记录
├── AGENTS.md                # Agent 开发规则
├── project.config.json      # 微信开发者工具配置
└── package.json
```

完整文档分类与阅读入口见 [`docs/README.md`](docs/README.md)。

## 本地开发

### 小程序

1. 使用微信开发者工具导入仓库根目录。
2. `project.config.json` 会指向 `miniprogram/`。
3. 安装开发依赖：

```bash
npm install
```

4. 执行 TypeScript 检查：

```bash
npm run typecheck
```

5. 执行 Pattern Engine 测试：

```bash
npm run test:pattern
```

6. 在微信开发者工具中编译、预览和真机验证。

### 后端

进入 `server/` 后安装依赖并执行：

```bash
npm install
npm run typecheck
npm test
npm run build
```

## 开发规范

开始修改代码前必须先阅读：

- `AGENTS.md`：仓库级 Agent 与开发流程规则
- `docs/development/CODE_RULES.md`：代码规范
- `docs/frontend/UI_RULES.md`：UI、导航栏、安全区与滚动规范
- `docs/frontend/MINI_PROGRAM_RULES.md`：微信小程序专项规范
- `docs/product/PRODUCT_FLOW.md`：产品业务流程
- `docs/releases/CHANGELOG.md`：版本变更记录

核心原则：

- 设计稿优先，不允许 AI 自行重新设计页面。
- 优先复用已有组件、services、utils 和设计 token。
- 不为了未来需求提前抽象。
- 不修改无关代码。
- TypeScript 必须通过类型检查。
- 任何代码文件不得超过 800 行。
- Bug 修复必须定位根因并检查调用方。

## 提交前检查

项目要求每次最终提交代码前执行完整检查：

`代码修改完成 -> lint/test/build/typecheck -> 正常正确性审查 -> ponytail-review -> 修复问题 -> 必要时再次 ponytail-review -> 最终提交`

`ponytail-review` skill 位于：

```text
.agents/skills/ponytail-review/SKILL.md
```

它主要用于发现过度设计、无必要抽象、重复造轮子、可以使用标准库或平台原生能力替代的代码，以及可以直接删除或缩短的实现。

## 当前仍在推进

以下能力仍属于后续阶段，不应在当前代码中伪造已完成状态：

- AI 精致模式的真实 AI 图像生成链路
- 支付 / 购买额度完整闭环
- 收藏数据云端同步
- 意见反馈服务端提交闭环
- Standard Pattern Engine 后续算法阶段与质量优化

具体进展以 `docs/releases/CHANGELOG.md` 和实际代码为准。

## UI 资源约定

- 原始设计稿和对比资料放在 `docs/ui/`，不进入小程序运行包体。
- 页面级图片放在 `miniprogram/assets/images/<page>/`。
- 多页面复用图标放在 `miniprogram/assets/icons/`。
- 文件名使用小写英文和短横线，例如 `empty-projects.webp`。

## Version

当前仓库版本：`0.19.0`
