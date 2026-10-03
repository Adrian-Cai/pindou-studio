# COMMIT_CONVENTION.md

# 提交信息规范

## 格式

```
<type>(<scope>): <简体中文简述>
```

要求：

- 标题一行，结尾不加句号
- 标题长度 50 个汉字或 72 个英文字符以内
- 正文可选，与标题之间空一行，说明「为什么这么改」，每行 100 字符以内
- 一个提交只做一件事

---

# type 白名单

| type | 用途 |
| --- | --- |
| feat | 新功能、新页面、新接口 |
| fix | 修复缺陷 |
| refactor | 重构，不改变外部行为 |
| perf | 性能优化 |
| docs | 文档、方案、代码注释 |
| chore | 构建、依赖、版本号、配置（非 CI） |
| ci | CI 与部署流水线 |
| test | 测试 |
| release | 版本发布（package.json 版本 + CHANGELOG + 提审说明） |

---

# scope 白名单

端：

miniprogram / server / cloudfunctions

业务域：

ai / works / payment / quota / auth / editor / result / account

工程：

ci / git / deps / plan / releases

要求：

- 改动跨多个业务域时优先用「端」（miniprogram / server）
- 改动集中在单一业务域时用业务域（ai / payment / auth 等）
- 选不出合适 scope 可以省略括号，直接 `docs: 简述`
- 禁止自造 scope

---

# 语言

要求：

- 简体中文，术语保留英文（jobId、prepay、quota、contentType、COS、RLS）
- 用「新增 / 修复 / 调整 / 移除 / 优化」等动词开头，描述做了什么

禁止：

- 无意义动词（更新、修改、调整代码）
- 中文英文混写长句

---

# 禁止

- 缺 type 前缀（如「更新」「修复 bug」「wip」「.」）
- 一条提交混入多件事
- 用提交信息承载本次改动的完整说明（应写进 CHANGELOG 或 PR 描述）
- rebase / force-push 改写已推送的提交历史（本仓库会自动推送，改写前必须明确确认）

---

# 示例

推荐：

```
fix(ai): 按真实字节格式识别 AI 输出，修复精致生成必然失败

混元图生图实际返回 JPEG，模型临时地址缺失 content-type，
云函数按 || 'image/png' 回退把 JPEG 误标为 .png，服务端只认 PNG 魔数导致任务恒定失败。
```

```
docs(server): 为鉴权仓储、支付服务与用户资料服务补充模块职责注释
```

```
feat(miniprogram): v0.30.9 编辑器底部面板复用、生成中状态精简与分包规范
```

```
release: v0.30.9 编辑器面板复用与 AI 输出格式修复
```

不推荐：

```
更新
修复 bug
修改了几个文件
docs: update
```

---

# 自动提交场景

本仓库存在自动提交与自动推送机制（编辑文件后 `git status` 通常已 clean，cnb / origin / wechat 三端同步）。

要求：

- 自动提交无法逐条指定信息时，至少保证 type 前缀与中文简述符合本规范
- 需要精确控制提交粒度时，先说明「本次需要手动提交」，再自行执行 git 命令
