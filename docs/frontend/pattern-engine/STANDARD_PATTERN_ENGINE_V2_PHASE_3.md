# Standard Pattern Engine V2 — Phase 3 OKLab 感知颜色匹配

> 上位设计：`docs/frontend/pattern-engine/STANDARD_PATTERN_ENGINE_V2_PLAN.md`
>
> 前置阶段：Phase 0 / Phase 1 / Phase 2 已完成。
>
> 当前目标：在 **不修改 Area Sampling、Median Cut、Palette 来源、Pattern Schema、页面业务流程** 的前提下，将 Standard Engine 的最终最近色匹配从 RGB 欧氏距离升级为 OKLab 感知距离，并建立 Phase 2 → Phase 3 的自动化与微信真实 Canvas A/B 基线。
>
> 本文档是 Phase 3 的实施与验收基线。Phase 3 验收通过前，禁止进入 Phase 4 MARD 真实色卡。

---

## 1. Phase 3 为什么独立成一个阶段

Phase 2 已经解决：

```text
原图直接缩到目标网格
↓
4× 中间 Canvas
↓
Linear RGB Area Sampling
↓
目标 Pattern Cell RGB
```

但 Phase 2 之后，最终颜色匹配仍然使用 Standard V1 的 RGB squared distance：

```text
ΔR² + ΔG² + ΔB²
```

RGB 三通道的数值距离并不等价于人眼感知距离。

这会在以下颜色附近更容易出现“数学上接近、视觉上不自然”的选择：

```text
肤色
棕色
米白
浅灰
粉色
浅黄
低饱和颜色
相近明度但色相不同的颜色
```

Phase 3 只解决一个问题：

> **同一个 Sampled Cell，在同一份 Median Cut Palette 中，哪一个 Palette Color 从视觉感知上更接近。**

本阶段不修改 Palette 本身从哪里来，也不引入真实 MARD 色号。

这样才能单独判断 OKLab 带来的收益。

---

## 2. 当前生产链路

Phase 2 当前生产 Pipeline：

```text
原图
 │
 ▼
Center Crop
 │
 ▼
4× OffscreenCanvas
 │
 ▼
Linear RGB Area Sampling
 │
 ▼
Sampled RGBA Cells
 │
 ├───────────────┐
 │               │
 ▼               │
Opaque Pixels    │
 │               │
 ▼               │
Median Cut       │
 │               │
 ▼               │
RGB Palette      │
 │               │
 └──────┬────────┘
        ▼
RGB Squared Distance
        │
        ▼
Nearest Palette Color
        │
        ▼
C01 / C02 / ...
        │
        ▼
PatternCell[]
```

Phase 3 目标 Pipeline：

```text
原图
 │
 ▼
Center Crop
 │
 ▼
4× OffscreenCanvas
 │
 ▼
Linear RGB Area Sampling
 │
 ▼
Sampled RGBA Cells
 │
 ├──────────────────────────┐
 │                          │
 ▼                          │
Opaque Pixels               │
 │                          │
 ▼                          │
Median Cut                  │
 │                          │
 ▼                          │
RGB Palette                 │
 │                          │
 ▼                          │
Prepare OKLab Palette       │
 │                          │
 └────────────┬─────────────┘
              ▼
       Cell RGB → OKLab
              │
              ▼
      OKLab Distance²
              │
              ▼
     Nearest Palette Color
              │
              ▼
       C01 / C02 / ...
              │
              ▼
        PatternCell[]
```

---

## 3. Phase 3 目标

本阶段必须实现：

1. 在现有 `color-space.ts` 基础上增加标准 OKLab 转换。
2. 保留 Phase 2 的 sRGB → Linear RGB 逻辑，不重复实现另一套 gamma 转换。
3. Median Cut 继续生成 RGB Palette。
4. Palette 在进入 Cell 最近色循环前一次性转换为 OKLab。
5. 每个非透明 Cell 只做一次 RGB → OKLab 转换。
6. 最近色使用 OKLab Euclidean Distance²。
7. Palette 顺序继续决定 Tie 时优先级。
8. `colorCode` 仍然保持 `C01 / C02 / ...`。
9. `colorLimit` 语义保持不变。
10. 建立 Phase 3 自动测试。
11. 建立 Phase 2 → Phase 3 微信真实 OffscreenCanvas A/B 基线。
12. 进行真实人物 / 动漫 / 宠物 / 插画视觉 A/B。
13. `createDraft()`、Pattern Schema、页面、服务器、数据库接口全部保持不变。

---

## 4. 本阶段明确不做

Phase 3 禁止实现：

```text
MARD 真实色卡
品牌 Palette
Palette Selection
Palette Merge
Median Cut 改造
OKLab Median Cut
CIE Lab
CIEDE2000
Delta E 2000
颜色权重调参
肤色特殊规则
人物识别
主体识别
Cleanup
Sobel
Edge Map
Dithering
Renderer 优化
Crop/Fit UI
AI 模式
Pattern Schema V2
Server API 修改
数据库修改
```

如测试中发现这些方向可能有价值，只记录为后续事项。

---

## 5. OKLab 数学定义

### 5.1 输入

生产输入仍为：

```ts
interface RGB {
  r: number // 0 ~ 255
  g: number // 0 ~ 255
  b: number // 0 ~ 255
}
```

新增：

```ts
export interface OKLab {
  l: number
  a: number
  b: number
}
```

---

### 5.2 sRGB → Linear RGB

必须复用 Phase 2 已存在的：

```ts
srgbByteToLinear(channel: number): number
```

禁止重新写第二份略有差异的 sRGB gamma 公式。

RGB byte 输入：

```text
0 ~ 255
```

Linear RGB 输出：

```text
0 ~ 1
```

---

### 5.3 Linear RGB → LMS

使用标准 OKLab 转换矩阵：

```text
l = 0.4122214708R + 0.5363325363G + 0.0514459929B
m = 0.2119034982R + 0.6806995451G + 0.1073969566B
s = 0.0883024619R + 0.2817188376G + 0.6299787005B
```

其中 R/G/B 为 Linear RGB。

---

### 5.4 Cube Root

```text
l_ = cbrt(l)
m_ = cbrt(m)
s_ = cbrt(s)
```

TypeScript / JavaScript 使用：

```ts
Math.cbrt()
```

不要使用 `Math.pow(value, 1 / 3)` 替代，以避免未来处理负数扩展时出现不同语义。

---

### 5.5 LMS → OKLab

```text
L =  0.2104542553l_ + 0.7936177850m_ - 0.0040720468s_
a =  1.9779984951l_ - 2.4285922050m_ + 0.4505937099s_
b =  0.0259040371l_ + 0.7827717662m_ - 0.8086757660s_
```

输出：

```ts
{ l: L, a, b }
```

注意：字段使用小写 `l`，避免与数字 `1` 混淆时可在局部变量中使用 `lightness`，但公共类型保持统一。

---

## 6. OKLab 距离

Phase 3 使用普通 OKLab Euclidean Distance。

为了最近色比较，不需要执行 `Math.sqrt()`。

使用平方距离：

```text
ΔL² + Δa² + Δb²
```

建议接口：

```ts
export function oklabDistanceSquared(
  left: OKLab,
  right: OKLab,
): number
```

不要在 Phase 3 增加人为权重：

```text
L × 2
肤色 bonus
饱和度 penalty
```

这些都会让 Phase 3 无法再单独代表“标准 OKLab 最近色”。

---

## 7. Tie 行为必须保持确定性

Standard Engine 必须保持确定性。

Phase 2 当前 RGB nearest 使用严格：

```ts
if (distance < nearestDistance)
```

Phase 3 OKLab matcher 也必须保持：

```ts
if (distance < nearestDistance)
```

不得使用：

```ts
<=
```

因此 OKLab Distance Tie 时：

> 保留 Palette 中更靠前的颜色。

这可以保持 `Cxx` 编号与 Palette 顺序的稳定语义。

---

## 8. 推荐代码结构

Phase 3 不需要大规模重构。

当前相关目录：

```text
miniprogram/services/pattern-generation/
├── cell-sampler.ts
├── color-space.ts
├── color-utils.ts
├── crop.ts
├── median-cut.ts
└── standard-generator.ts
```

推荐 Phase 3 修改：

```text
color-space.ts
standard-generator.ts
```

推荐新增：

```text
oklab-matcher.ts
```

测试新增：

```text
test/pattern-generation/phase-3-oklab.test.js
miniprogram/tests/pattern-generation/wechat-canvas-phase-3.ts
test/pattern-generation/compare-wechat-phase-3.js
test/pattern-generation/fixtures/wechat-phase-3.json
```

并更新：

```text
test/pattern-generation/run-tests.js
test/pattern-generation/README.md
docs/releases/CHANGELOG.md
```

如果 Codex 根据真实代码判断 `oklab-matcher.ts` 与现有模块边界不合理，可以提出更小调整，但不得借机重构整个 Pattern Engine。

---

## 9. `color-space.ts` 设计

Phase 2 当前已经包含：

```ts
srgbByteToLinear()
linearToSrgbByte()
```

Phase 3 建议扩展：

```ts
import type { RGB } from './color-utils'

export interface LinearRGB {
  r: number
  g: number
  b: number
}

export interface OKLab {
  l: number
  a: number
  b: number
}

export function rgbToLinearRgb(color: RGB): LinearRGB

export function linearRgbToOklab(color: LinearRGB): OKLab

export function rgbToOklab(color: RGB): OKLab

export function oklabDistanceSquared(left: OKLab, right: OKLab): number
```

实现要求：

```text
rgbToOklab
↓
rgbToLinearRgb
↓
linearRgbToOklab
```

不要复制转换公式。

---

## 10. Palette 预计算设计

禁止生产代码这样实现：

```text
for each cell
  for each palette color
    rgbToOklab(paletteColor)
```

以 `128×128 / 64 色` 为例，会造成超过 100 万次重复 Palette 转换。

正确方式：

```text
Median Cut RGB Palette
↓
prepareOklabPalette() 一次
↓
Prepared Palette
```

建议结构：

```ts
export interface PreparedOklabColor {
  rgb: RGB
  oklab: OKLab
}
```

接口：

```ts
export function prepareOklabPalette(
  palette: RGB[],
): PreparedOklabColor[]
```

顺序必须和原 RGB Palette 100% 一致。

禁止排序。

禁止去重。

禁止过滤。

---

## 11. OKLab 最近色匹配设计

建议：

```ts
export function findNearestColorOklab(
  pixel: RGB,
  palette: PreparedOklabColor[],
): RGB
```

执行：

```text
pixel RGB
↓
rgbToOklab() 一次
↓
遍历 Prepared Palette
↓
oklabDistanceSquared
↓
返回 PreparedItem.rgb
```

返回值继续是原 Palette 中的 RGB 对象。

这样现有：

```ts
palette.indexOf(color)
```

仍然能够保持当前行为。

如果实现选择不继续依赖 `indexOf()`，必须证明 Palette index 与 Phase 2 语义一致，不允许因为“优化”改变 `Cxx` 顺序。

---

## 12. `standard-generator.ts` 修改边界

Phase 3 只允许修改最终 color matching 部分。

保持：

```text
4× Canvas
Area Sampling
Alpha weighted Linear RGB
alpha < 32
readOpaquePixels
Median Cut
colorLimit
Center Crop
PatternCell shape
Cxx code format
```

当前：

```text
palette = createMedianCutPalette(...)

for each cell
  findNearestColor(pixel, palette)
```

Phase 3：

```text
palette = createMedianCutPalette(...)
preparedPalette = prepareOklabPalette(palette)

for each opaque cell
  findNearestColorOklab(pixel, preparedPalette)
```

不要改变其它 Pipeline。

---

## 13. 旧 RGB Matcher 如何处理

当前 `color-utils.ts` 中的：

```ts
findNearestColor()
```

属于 V1/Phase 2 Characterization 的一部分。

Phase 3 不建议删除。

原因：

1. 可以继续作为 Phase 2 reference；
2. 可以直接构造 RGB vs OKLab 差异测试；
3. 后续回归问题更容易定位。

生产 Standard Generator 切换到 OKLab matcher 后，旧 RGB matcher 可以保留为测试/reference 工具。

不要为了“无 unused production code”强行删除已有基线能力；export 函数可继续保留。

---

## 14. 自动化测试设计

新增：

```text
test/pattern-generation/phase-3-oklab.test.js
```

至少覆盖以下 Case。

### Case 1：sRGB 基础端点

继续确认：

```text
0 → Linear 0
255 → Linear 1
```

Phase 2 已有测试可以复用，不重复大量同类 Case。

### Case 2：OKLab Black

验证：

```text
RGB(0,0,0)
→ L≈0, a≈0, b≈0
```

使用合理浮点 tolerance，不做字符串全等。

### Case 3：OKLab White

验证：

```text
RGB(255,255,255)
→ L≈1
→ a/b 接近 0
```

### Case 4：已知基础颜色

至少验证一个：

```text
Red / Green / Blue
```

使用标准 OKLab 参考值 + tolerance。

不要只测试函数“返回 number”。

### Case 5：Distance identity

```text
distance(color, color) = 0
```

### Case 6：Distance symmetry

```text
distance(A,B) === distance(B,A)
```

允许浮点 tolerance。

### Case 7：Prepared Palette 顺序

输入：

```text
[A, B, C]
```

输出仍然：

```text
[A, B, C]
```

禁止重排。

### Case 8：OKLab Tie 保留前项

构造两个相同 OKLab / 相同 RGB Palette 项或可控 matcher 输入。

验证严格 `<` 语义。

### Case 9：RGB nearest 与 OKLab nearest 结果不同

这是 Phase 3 最重要的测试之一。

必须找到/固定一组：

```text
Pixel P
Palette [A, B]
```

满足：

```text
RGB nearest(P)   = A
OKLab nearest(P) = B
```

然后验证生产 Phase 3 matcher 选择：

```text
B
```

这个 Case 用来证明 Phase 3 不是“只新增了 OKLab 工具函数，但生产链路仍然走 RGB”。

测试 fixture 一旦确定，写成固定数字，不允许测试运行时随机搜索颜色。

### Case 10：Standard Generator production path

使用现有 wx harness 构造可控 Sampled 输入。

验证：

```text
Median Cut 行为仍存在
Area Sampling 仍存在
最终 nearest 使用 OKLab
```

### Case 11：Alpha 31 / 32

确认 Phase 3 没有破坏 Phase 2：

```text
31 → transparent
32 → opaque
```

### Case 12：colorLimit

确认最终有效颜色数量仍：

```text
<= colorLimit
```

---

## 15. 浮点测试规则

OKLab 使用浮点数学，测试不要使用：

```ts
assert.equal(actual, 0.6279553606)
```

建议统一 helper：

```ts
assertClose(actual, expected, tolerance)
```

建议初始 tolerance：

```text
1e-6 ~ 1e-5
```

具体根据标准参考值精度确定。

禁止设置过大的 tolerance 让错误矩阵也能通过。

---

## 16. Phase 2 → Phase 3 微信真实 Canvas Baseline

新增 runner：

```text
miniprogram/tests/pattern-generation/wechat-canvas-phase-3.ts
```

结构复用 Phase 2 runner。

输出：

```ts
{
  schemaVersion: 1,
  algorithm: 'standard-v2-phase-3',
  runtime: 'wechat-offscreen-canvas',
  sampleScale: 4,
  generatedAt,
  cases: [...]
}
```

保存为：

```text
test/pattern-generation/fixtures/wechat-phase-3.json
```

继续记录：

```text
id
fixture
sourceWidth
sourceHeight
width
height
colorLimit
brand
cellCount
opaqueCellCount
colorCount
matrixHash
paletteHash
generationTimeMs
```

---

## 17. 微信 A/B 比较规则

新增：

```text
test/pattern-generation/compare-wechat-phase-3.js
```

比较：

```text
Phase 2
vs
Phase 3
```

必须严格不变：

```text
id
fixture
sourceWidth
sourceHeight
width
height
colorLimit
brand
cellCount
opaqueCellCount
```

允许变化：

```text
colorCount
matrixHash
paletteHash
```

因为 OKLab nearest 可能改变：

- 某些 Cell 的 Palette 选择；
- 某些 Median Cut 颜色是否最终被使用；
- 根据 Cell 推导的 Palette 顺序/数量。

`generationTimeMs`：

```text
只记录，不作为严格 CI equality
```

原因：微信开发者工具和设备运行时间存在噪声。

---

## 18. Phase 3 不强制所有真实 Fixture Matrix 改变

OKLab 与 RGB 最近色在很多简单结构图片上可能选择相同颜色。

因此真实微信 Baseline 不应该写成：

```text
6/6 Matrix 必须变化
```

也不要人为要求某个简单 Fixture 必须变化。

Phase 3 “生产路径确实使用 OKLab”的确定性证据来自：

```text
Case 9：RGB nearest 与 OKLab nearest 分歧 fixture
+
Case 10：Standard Generator production path
```

真实微信 A/B 用于：

```text
兼容性
性能
真实 Canvas 行为
结构图片变化记录
```

---

## 19. 真实视觉 A/B

Phase 3 仍然需要真实图片视觉测试。

建议至少：

```text
动漫人物 × 2
真人/写实人物 × 2
宠物 × 1
高饱和插画 × 1
低饱和照片 × 1
```

至少使用：

```text
64×64 / 32 色
```

重点图增加：

```text
96×96 / 32 色
```

必须比较：

```text
原图
Phase 2
Phase 3
```

不是只看 Phase 3。

---

## 20. Phase 3 主观评价维度

重点评分：

```text
肤色自然度
头发棕色/黑色层次
粉色/米色稳定性
低饱和区域自然度
主体识别度
轮廓完整度
局部噪声
整体色调偏移
```

每项：

```text
1 ~ 5
```

必须记录退化案例。

如果某类图 Phase 3 明显比 Phase 2 差，不允许只挑好案例宣布 PASS。

---

## 21. 性能设计

Phase 3 性能关键点：

> Palette OKLab 必须一次性预计算。

128×128 / 64 色：

```text
16,384 Cells
64 Palette Colors
```

合理实现：

```text
Palette 转换：64 次
Cell 转换：最多 16,384 次
Distance：约 1,048,576 次简单三维平方差
```

不合理实现：

```text
每次 distance 前重新转换 Palette
```

会产生大量重复 `Math.cbrt()`。

---

## 22. 性能 Gate

继续遵循总方案的绝对性能目标：

```text
64×64   < 500 ms
96×96   < 1000 ms
128×128 < 1500~2000 ms
```

Phase 2 / Phase 3 微信记录中的 `generationTimeMs` 只用于观察。

不直接在 CI assert 固定毫秒值。

如果真实设备出现明显性能回退：

优先检查：

```text
Palette 是否重复 rgbToOklab
Cell 是否重复转换
对象是否在内层循环大量创建
是否重复调用 Median Cut
是否产生无必要 Array copy
```

不要通过减少颜色质量绕过性能问题。

---

## 23. Pattern / 业务兼容约束

Phase 3 必须保持：

```text
createDraft() 接口不变
PatternDraft shape 不变
PatternCell shape 不变
PersistedPattern schema 不变
brand 仍为原设置值
colorCode 仍为 Cxx
页面调用不变
编辑器不变
作品保存不变
下载不变
服务器不变
数据库不变
```

Phase 3 只改变：

> 同一个 Cell 在现有 Median Cut Palette 中最终选择哪一个颜色。

---

## 24. Phase 3 测试命令

完成后至少执行：

```bash
npm run typecheck
npm run test:pattern
```

新增 GitHub Actions 后，这两个命令也必须进入 CI。

如仓库存在 server 改动（本 Phase 原则上不应该有），还必须执行 server 对应检查。

---

## 25. GitHub Actions Gate

Phase 3 开始实施前，仓库将增加 GitHub Actions CI。

Phase 3 PR / push 必须至少通过：

```text
Miniprogram TypeScript Static Check
Pattern Generation Regression Tests
Server TypeScript Static Check
```

Phase 3 不允许以“本地可以运行”为理由忽略 CI 失败。

如果失败属于既有代码问题，必须先说明并区分，不允许直接跳过。

---

## 26. Phase 3 Completion Gate

只有以下全部满足才允许进入 Phase 4。

### Algorithm

```text
[ ] OKLab 标准转换实现完成
[ ] 复用现有 sRGB → Linear RGB
[ ] OKLab Distance² 实现完成
[ ] Palette OKLab 一次性预计算
[ ] 每 Cell 只转换一次 OKLab
[ ] Tie 保持 Palette 前项
[ ] Median Cut 未修改
[ ] Area Sampling 未修改
```

### Automated Tests

```text
[ ] Black / White / 基础色参考值通过
[ ] Distance identity / symmetry 通过
[ ] Palette 顺序测试通过
[ ] OKLab Tie 测试通过
[ ] RGB vs OKLab 分歧 Case 通过
[ ] Production Standard Generator 确认使用 OKLab
[ ] Alpha 31/32 回归通过
[ ] colorLimit 回归通过
[ ] npm run typecheck 通过
[ ] npm run test:pattern 通过
[ ] GitHub Actions CI 通过
```

### Real WeChat Canvas

```text
[ ] Phase 3 runner 已执行
[ ] wechat-phase-3.json 已记录
[ ] Phase 2 / Phase 3 stable fields 一致
[ ] Matrix/Palette 变化已记录
[ ] generationTime 已记录
```

### Visual A/B

```text
[ ] 动漫人物已测试
[ ] 真人/写实人物已测试
[ ] 宠物已测试
[ ] 高饱和插画已测试
[ ] 低饱和图片已测试
[ ] 64×64 / 32 色已覆盖
[ ] 退化案例已记录
[ ] 整体收益达到进入 Phase 4 的标准
```

### Compatibility

```text
[ ] 页面无改动
[ ] Server API 无改动
[ ] Database 无改动
[ ] Pattern Schema 无改动
[ ] AI 模式无改动
[ ] MARD 未提前接入
```

---

## 27. Phase 3 PASS / PARTIAL / FAIL 定义

### PASS

满足全部 Completion Gate，可以进入 Phase 4 MARD。

### PARTIAL

例如：

```text
算法/自动测试通过
但真实微信 Baseline 尚未完成
```

此时不能进入 Phase 4。

### FAIL

以下任一属于 FAIL：

```text
生产链路仍走 RGB nearest
OKLab 数学错误
明显性能退化未解决
Alpha / Crop / Area Sampling 被破坏
Pattern Schema 被修改
真实 A/B 显示明显普遍退化
CI 未通过且无明确解决
```

---

## 28. 建议 Commit 边界

Phase 3 推荐单独 Commit：

```text
feat(pattern): add Phase 3 OKLab color matching
```

如果测试基线需要独立提交，也可以拆成：

```text
test(pattern): add Phase 3 OKLab baseline
feat(pattern): use OKLab perceptual color matching
```

不要和 Phase 4 MARD 混在一个 Commit。

---

## 29. Codex 执行原则

Codex 执行 Phase 3 时必须：

```text
1. 先阅读 AGENTS.md。
2. 阅读 docs/development/CODE_RULES.md。
3. 阅读 STANDARD_PATTERN_ENGINE_V2_PLAN.md。
4. 阅读本文档。
5. 检查当前 Phase 2 真实代码，不从文档猜实现。
6. 只完成 Phase 3。
7. 不修改无关页面/服务。
8. 不新增第三方依赖。
9. 保持 strict TypeScript。
10. 完成后运行全部规定检查。
11. 输出真实测试结果，不伪造微信 DevTools 结果。
12. 如果当前环境不能执行微信真实 runner，明确给出人工执行步骤并将状态标记为 PARTIAL。
```

---

## 30. Phase 3 完成后的下一步

Phase 3 完成后不要自动进入 Phase 4。

先进行：

```text
Code Review
↓
Automated Gate
↓
GitHub Actions CI
↓
WeChat Canvas Baseline
↓
Visual A/B
↓
Phase 3 Review
```

只有明确得到：

```text
Phase 3 = PASS
```

才进入：

```text
Phase 4 — MARD 真实色卡
```

Phase 4 的第一步也不是写代码，而是先确认可信、版本明确、可追踪的 MARD 色卡数据源。

---

## 31. 当前状态

```text
Phase 0：PASS
Phase 1：PASS
Phase 2：PASS
Phase 3：READY FOR IMPLEMENTATION
Phase 4：BLOCKED BY PHASE 3 GATE + MARD DATA SOURCE
Phase 5：NOT STARTED
Phase 6：NOT STARTED
```

下一步：

> 按本文档执行 Phase 3 OKLab 感知颜色匹配，不进入 MARD、Cleanup、Edge 或 AI。
