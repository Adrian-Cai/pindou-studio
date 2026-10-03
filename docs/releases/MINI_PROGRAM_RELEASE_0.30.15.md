# 小程序 0.30.15 提审说明

> 状态：代码已落地，`tsc --noEmit` 0 报错，本地图片资源守卫 2/2 通过（已做变异验证），拼豆图生成用例 57/57 通过。
> 本次为**纯小程序端改动**（静态资源 + 引用路径 + 规则文档 + 测试），无需重新部署云函数或服务端。
> 上一轮的部署提醒仍然有效：0.30.11 的 `generateImage` 云函数需在微信云开发重新部署，否则生图角标文案不生效。
> **0.30.10 的真机验收 T1–T20 仍未执行**（历史遗留），正式提审前必须补跑。

## 版本号

`0.30.15`

## 本次提交

修复首页「示例图片」与「我的」页头像在真机上空白，并把这次事故的两个成因固化成静态守卫。

涉及文件（19 个）：

| 文件 | 改动性质 |
| --- | --- |
| `miniprogram/assets/icons/brand-avatar.png` | 还原（替换 `.webp`） |
| `miniprogram/assets/samples/home-sample-standard-1/2.jpg` | 还原（替换 `.webp`） |
| `miniprogram/assets/samples/home-sample-ai-1/2.jpg` | 还原（替换 `.webp`） |
| `miniprogram/pages/home/index.ts` | 4 处示例图路径改回 `.jpg` |
| `miniprogram/pages/profile/index.wxml` | 2 处默认头像路径改回 `.png` |
| `miniprogram/pages/profile/index.ts` | `DEFAULT_AVATAR_PATH` 改回 `.png` |
| `miniprogram/packages/account/index.ts` | `DEFAULT_AVATAR_PATH` 改回 `.png` |
| `miniprogram/packages/account/profile-edit/index.ts` | `DEFAULT_AVATAR_PATH` 改回 `.png` |
| `test/miniprogram-assets/` | 新增本地图片资源守卫（2 例） |
| `.github/workflows/ci.yml` | 新增 `Miniprogram local image asset check` 步骤 |
| `docs/frontend/MINI_PROGRAM_RULES.md` | 新增「包内静态图片禁止使用 WebP」规则 |
| `miniprogram/packages/download/index.wxml` | 封面 `binderror` 兜底 |
| `miniprogram/packages/download/index.ts` | `handleCoverError` + 占位图常量 |
| `package.json` / `package-lock.json` | 版本号 `0.30.15` |

上一版本基线：v0.30.14（第二轮 AI 扫描修复批次）。

## 版本概述

这一版修的是一个**在开发者工具里看不见的 bug**：包内 `.webp` 图片真机不解码。

`image` 组件的 `webp` 属性官方说明是「默认不解析 webP 格式，只支持网络资源」，而且它是 **WebView 特有属性**（`renderer: skyline` 下根本不存在）。开发者工具的模拟器是 Chromium，原生支持 webp，所以工具里一切正常；真机上图片整张空白，且**不报错、不打日志**，`image` 元素本身照常占据布局——页面上只剩 CSS `background` 那一片浅色方块。

v0.16.0 的「图片资源转 WebP」把 5 张本地图从 PNG/JPG 转成了 webp，于是首页 4 张示例图与「我的」页默认头像从那一版起就一直空着，直到本次还原。中间隔了 14 个版本、若干次真机提审，没有人发现——因为这个 bug 只在真机出现，而真机验收的注意力通常在交互链路（上传、生成、支付、同步）上，不会去核对一张装饰性图片是否渲染。

## 本次修改说明

1. **5 张图片还原为转格式前的原始文件**（`git show 785751d^:<路径>` 取回原字节，不做二次编码）：
   - `brand-avatar.png`：256×256 **RGBA**。原 PNG 带透明通道，转 webp 时用了有损 VP8（无 alpha 通道），背景被烤进像素里；还原后透明通道一并恢复，卡片下层的 `--color-primary-soft` 能正常透出来。
   - 4 张 `home-sample-*.jpg`：512×512。webp 转换时同时被降到 240×240，示例图卡片在 3x 屏上约占 232px，等于用 1x 素材填 3x 像素，本身就偏软；还原后恢复清晰度。

2. **7 处引用同步改回 `.png` / `.jpg`**：改路径而不是保留 webp 文件名，是为了让「格式」这件事在代码里一眼可见——文件名叫 `.webp` 却塞 JPEG 字节，会把下一个排查的人带偏。改完用脚本全量复核：`miniprogram/` 下 74 条 `/assets/...` 字面量引用全部命中真实文件，`assets/` 下 webp 文件数为 0。

3. **新增静态守卫 `test/miniprogram-assets/`（2 例，已做变异验证）**：
   - `assets/` 下禁止出现 `.webp`；
   - 源码里字面量引用的 `/assets/...` 必须真实存在，且扩展名在白名单（`svg` / `png` / `jpg` / `jpeg`）内。
   
   这两条恰好对应本次事故的两个条件（格式不被解码、引用断链），它们**在开发者工具里都是隐形的**，因此必须交给 CI。变异验证：塞入一个 `.webp` → 用例 1 转红；移走 `brand-avatar.png` → 用例 2 转红；复原 → 回到绿色。守卫只扫字面量路径，`src="{{item.icon}}"` 这类动态绑定与网络/云文件地址不在校验范围（写进了文件头注释的边界说明）。

4. **`docs/frontend/MINI_PROGRAM_RULES.md`「图片处理」补规则**：包内静态图片禁止 WebP（含原因、血泪教训、替代方案），并补一条排查口径——**图片空白时先看该 `<image>` 有没有 CSS `background`**：有背景色说明元素本身渲染正常、只是资源没解出来，此时优先怀疑格式与路径，而不是布局。这条口径能把本次的排查路径从「翻布局样式」直接拉回「核对资源」。

5. **下载记录页封面补上加载失败兜底**：顺带做了全量图片引用核查（160 个 `<image>`、其中 21 个动态 src），三个列表页里作品页与收藏页都有 `binderror` 兜底到 `image-upload.svg`，下载记录页是唯一漏的一处——封面地址失效时列表里留一个空白格且无提示。补 `handleCoverError` 与 `coverPath || COVER_FALLBACK_PATH`，与另两页同一套口径。**核查结果：字面量 `/assets` 引用 74 条全部命中真实文件，5 张位图全部可解码，全项目已无 webp**；69 个 svg 里仅 `project-empty.svg` 用了内部 `clipPath` 引用（WebView 下正常，切 Skyline 才失效），不构成当前问题。

6. **没有采用 `webp="true"`**：官方文档写了该属性，但社区到 2025-09 仍有 Android 机型（尤其带透明通道的 webp）设置后依旧不显示的反馈，且它是 WebView 特有属性、未来切 Skyline 渲染会整段失效。省包体 490KB 不值得把「真机能不能显示」押在一个逐标签、逐机型都要验的属性上。

## 影响范围

- 小程序主包：`pages/home/index.ts`、`pages/profile/index.ts`、`pages/profile/index.wxml`、`assets/`
- 小程序分包：`packages/account/index.ts`、`packages/account/profile-edit/index.ts`
- 构建配置：`project.config.json`（未改动，`packOptions` 已包含 `assets/samples`）
- 测试与 CI：`test/miniprogram-assets/`、`package.json`（新增 `test:assets`）、`.github/workflows/ci.yml`
- 文档：`docs/releases/CHANGELOG.md`、`docs/releases/MINI_PROGRAM_RELEASE_0.30.15.md`、`docs/frontend/MINI_PROGRAM_RULES.md`
- 版本号：`package.json`、`package-lock.json` 均为 `0.30.15`

**不影响范围：**

- 云函数与服务端接口（本次**无需后端与云函数改动**）
- 生成算法、任务状态机、支付链路
- 已上传到云存储的用户头像（走网络地址，webp 可用）
- 冷启动、分包加载策略（仅图片体积变化，主包 629KB → 1.09MB）

## 验收重点

**本次必须走真机。** 开发者工具对这个 bug 是隐形的——修好之前它在工具里也显示正常，所以工具里「看起来没问题」不构成验收通过。

| 场景 | 预期 |
| --- | --- |
| 首页「示例图片」4 张 | 真机上能看到 4 张拼豆示例图，卡片内无空白方块 |
| 「我的」页用户卡头像（未登录 / 已登录） | 显示品牌头像，边缘圆角处透出浅绿底色（透明通道生效，不是一块奶白色方图） |
| 登录弹层头像、完善资料弹层头像 | 同上 |
| 「账号」子页头像（走 `packages/account`） | 同上 |
| 首页示例图清晰度 | 512×512 素材，3x 屏上不应有旧的糊感 |

回归测试：本次已跑 `npm run typecheck`（0 报错）、`npm run test:assets`（2/2，含变异验证）、`npm run test:pattern`（57/57）。`test/work-sync/` 与 `test/payment/` 未被本次改动触及，未重跑；如需全量回归按各自 runner 执行（`test/work-sync/` 需先 `npx tsc -p test/work-sync/tsconfig.json`）。
