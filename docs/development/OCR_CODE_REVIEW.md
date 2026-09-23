# OpenCodeReview CI 集成

本文说明本仓库的 AI 代码评审流水线如何工作、如何配置，以及日常该怎么用。

相关文件：

- `.github/workflows/ocr-review.yml` — GitHub Actions 工作流
- `.opencodereview/rule.json` — 项目专属评审规则

---

## 它做什么

在 Pull Request 上自动做 AI 评审，并把发现以内联评论的形式回贴到 PR：

1. PR 事件（opened / synchronize / reopened）自动触发，**草稿 PR 跳过**，避免半成品还没成型就烧 token。
2. 在 PR 上评论 `/open-code-review` 或 `@open-code-review` 可按需重跑。
3. 评论仅限 **MEMBER / OWNER / COLLABORATOR** 触发，外部贡献者无法借此消耗 LLM 额度。

评审本身由上游的复合 Action `alibaba/open-code-review` 完成：它 checkout 可信的 base 分支，
抓取 PR head 的 Git 对象取 diff，跑 `ocr review`，再把结果通过 GitHub Pull Request Review API
贴回 PR。**整个过程不执行 PR 分支里的任何代码。**

---

## 首次配置

在 GitHub 仓库 Settings → Secrets and variables → Actions 下设置：

| 名称 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `OCR_LLM_URL` | Secret | 是 | LLM API 端点，如 `https://api.openai.com/v1/chat/completions` |
| `OCR_LLM_AUTH_TOKEN` | Secret | 是 | LLM API 的认证 token |
| `OCR_LLM_MODEL` | Variable | 是 | 模型名。**无默认值，必须显式设置** |
| `OCR_LLM_USE_ANTHROPIC` | Variable | 否 | 使用 Anthropic Claude 时设为 `true`；不设则走 OpenAI 兼容协议 |

`GITHUB_TOKEN` 由 Actions 自动注入，不需要手动配置；工作流已声明 `pull-requests: write`
以便张贴评审评论。

> 注意变量名容易踩的坑：CI 侧是 `OCR_LLM_AUTH_TOKEN`，而 OCR CLI 自己的环境变量叫
> `OCR_LLM_TOKEN`。上游 Action 会做映射，不要混用。

---

## 版本固定策略

**两处都必须固定**，缺一不可：

```yaml
uses: alibaba/open-code-review@5f8e5ab328e1449ba4d5f14d2a7542117543d753  # action 的 commit SHA
with:
  ocr_version: '1.12.9'                                                  # OCR CLI 的 npm 版本
```

- 只固定 SHA：Action 脚本不会再漂移，但它仍可能在运行时安装到**新的** OCR CLI。
- 只固定 npm 版本：CLI 版本锁住了，但 Action 的执行脚本会随上游 main 变化。

升级时需要同时改这两处。上游新版本发布后，建议先在单个 PR 上验证再合并。

不使用浮动的 `@main`——第三方 Action 指向可变分支意味着上游任何一次提交都能在我们的
CI runner 上执行代码，这是供应链风险。

---

## 评论发布策略

工作流启用了三个开关，共同解决「长生命周期 PR 每次 push 都重复刷评论」的问题：

| 开关 | 作用 |
| --- | --- |
| `sticky_summary: 'true'` | 摘要评论原地更新，而不是每次运行新增一条 |
| `incremental: 'true'` | 只张贴与已有 bot 评论不重叠的内联评论（永不删历史） |
| `checkpoint_range: 'true'` | 跨 push 增量：记录上次覆盖到的 head，下次只评审新增的那段 commit |

`checkpoint_range` 是**失败即全量**的设计：摘要缺失、作者身份不符、标记损坏、base 移动、
配置变化、无法证明 checkpoint 是 head 的祖先——任一条成立就自动退回全量评审，并在
`range_summary` 输出里写明原因。所以它只会省 token，不会漏评审。

> `sticky_summary` / `incremental` / `checkpoint_range` 的值必须写成带引号的字符串。
> Action 内部按字符串比较，写成 YAML 布尔值（`true` 而非 `'true'`）不会生效。

**因此 `background` 保持静态文本，不要拼接 PR 标题**：PR 标题一旦改动就会被判为
`config_changed`，导致每次都退回全量评审，把增量优化抵消掉。

---

## 并发组的坑（重要）

GitHub Actions **在求值 job 级 `if` 之前**就先求值 `concurrency`。

如果并发组写成扁平的 `ocr-<pr_number>`，那么 PR 上**任何一条评论**——哪怕只是一条随后会被
`if` 跳过的普通回复——都会进入同一个组。由于 `cancel-in-progress: true`，它会取消正在进行的
评审。表现就是：有人在 PR 上随便说句话，正在跑的评审就没了，Actions 页面出现「两个运行、一个被取消」。

工作流里用的是**条件式并发组**：命中的事件共享 `ocr-<PR号>` 组（新评审取消同一 PR 上过期的一次），
未命中的评论落进唯一的 `noop-<run_id>` 组，后者永远不可能与真实评审碰撞，会被立刻跳过而不干扰任何东西。

**修改触发条件时，`concurrency.group` 的表达式和 job 的 `if` 必须同步改**，两边逻辑要保持一致。

---

## 项目评审规则

`.opencodereview/rule.json` 是本项目最值得维护的部分——它把团队的经验固化下来，而不是指望模型每次自己猜。

### include 的作用不只是「白名单」

`.wxml` 和 `.wxss` **不在 OCR 默认支持的文件类型白名单里**（白名单见上游
`supported_file_types.json`，主要是常见 Web / 后端语言）。所以要让模板和样式也被评审，
必须显式写进 `include`——`include` 会绕过 `unsupported_ext` 这道过滤门。

```json
"include": ["miniprogram/**/*.{ts,js,json,wxml,wxss}", ...]
```

它**不是**白名单：不匹配任何 `include` 模式的文件仍会走常规的扩展名与默认路径检查，
可能照样被评审。`include` 只是「强制保留」的机制。

### exclude

排除 `package-lock.json`（巨大且无评审价值）、`docs/**`、`miniprogram/assets/**`、
`miniprogram/test-assets/**`。锁文件和文档变更量大但风险低，排除它们是省 token 最直接的手段。

### 规则条目

按项目实际风险点编排，与 `docs/frontend/MINI_PROGRAM_RULES.md`、`AGENTS.md` 的约定对齐：

- **分包边界**：主包禁止引用 `packages/` 下模块，否则小程序启动即崩
- **AI 生成任务**：状态机死局、配额扣减与任务结果不一致
- **支付**：浮点金额、回调幂等、签名校验不可绕过
- **数据同步**：失败时误标记为已同步、多端冲突
- **数据模型**：不要把「损坏/缺失」降级成空数组、空字符串这类合法值
- **CI YAML**：PR 可控值不得直接插值进 `run:`（见下文）

新增规则时用 `ocr rules check <文件路径>` 确认它真的命中了目标，命令会打印命中的是哪一层、哪个模式。

---

## 安全边界

### 为什么用 `pull_request_target`

`pull_request` 事件下 fork 提交的 PR 拿不到 secret；`pull_request_target` 可以。
代价是它在 base 分支的上下文里运行并且**持有 secret**，因此必须确保不执行 PR 分支的代码。

上游 Action 的做法是 checkout 可信的 base 分支，再单独抓取 PR head 的 Git 对象来取 diff，
不检出也不运行 PR 的代码。这一点不能破坏——**不要为了「方便」改成在 PR head 上跑
`npm install` 或 `npm run xxx`**，那等于把 fork PR 变成了远程代码执行。

### ${{ }} 注入

这是写 CI 时的通用红线：**PR 可控的值必须先放进 `env:` 再传给 shell**。

GitHub 在 shell 解析该行**之前**就完成了 `${{ }}` 的文本替换，所以 PR 标题或分支名里的
shell 元字符会直接在 runner 上被执行。本工作流的 `background` 是静态文本、未使用插值，
因此没有这个风险；将来如果要传 PR 标题，务必走 `env:`。

### 最小权限

只声明了 `contents: read` 和 `pull-requests: write`。若将来启用 `resolve_outdated: 'true'`
（自动关闭过期的 bot 评论线程），还需要额外 `contents: write`——GitHub 对该变更的权限校验
走的是仓库写权限而非 PR scope。

---

## 故障排查

| 症状 | 原因 / 修复 |
| --- | --- |
| `Cannot find merge-base` | checkout 用了浅克隆。区间模式评审需要完整历史，确认 `fetch-depth: 0` 没被改掉 |
| `Failed to parse OCR output` | `OCR_LLM_URL` 或 `OCR_LLM_AUTH_TOKEN` 缺失或错误，复查 Actions Secrets 的值 |
| 评审评论落到错误行 | 评审开始到张贴之间 diff 发生了偏移，脚本会回退为普通 issue 评论，无需处理 |
| 工作流没触发 | 检查 PR 是否为草稿（草稿会被跳过），或 secrets 是否配置齐全 |
| 每次 push 都全量重评审 | 检查 `range_summary` 输出里的原因；常见触发是改动了 `background` 等配置导致 `config_changed` |

工作流会把原始评审 JSON 写到 `/tmp/ocr-result.json`、stderr 写到 `/tmp/ocr-stderr.log`，
并作为 artifact 上传，可在 Actions 运行详情页下载排查。

> `OCR_DEBUG` 环境变量目前在 OCR 中**尚未实现**，设了没有任何效果。要看详细输出请查上述文件。
