# Standard Pattern Engine V2 — Phase 0 + Phase 1 实施方案

> 上位设计：`docs/STANDARD_PATTERN_ENGINE_V2_PLAN.md`
>
> 当前里程碑：建立 Standard V1 可复现基线，并完成不改变任何生成结果的代码重构。
>
> 本文档是 Phase 0 + Phase 1 的实施与验收基线。后续 Codex 执行本阶段时必须严格以本文档为范围边界，不得提前进入 Area Sampling、OKLab、MARD 真实色卡、Cleanup、Edge Protection 等后续阶段。

---

## 1. 为什么 Phase 0 + Phase 1 必须先做

Standard V2 后续会连续修改：

```text
缩放/采样
颜色距离
Palette 来源
局部结构保护
噪声清理
```

如果没有稳定的 V1 基线，也没有把现有算法职责从 `image-service.ts` 中拆出来，后续会出现两个问题：

1. 无法判断某次效果变化到底来自哪个算法；
2. 一旦效果退化，很难定位和局部回滚。

因此正式优化效果之前，先完成：

```text
Phase 0：知道 V1 现在准确做了什么，并能够重复验证
        ↓
Phase 1：把同一套 V1 算法安全拆到独立模块，但输出一颗豆都不能变化
```

本阶段的成功标准不是“图片变好看”。

本阶段的成功标准是：

> **重构前和重构后，Standard V1 的可观察行为完全一致，同时建立足够可靠的测试和基线，为 Phase 2 之后的算法变化提供参照。**

---

# 2. 当前仓库真实状态

## 2.1 当前标准模式入口

首页标准模式通过：

```ts
const draft = await createDraft(this.data.sourceImagePath, this.data.settings)
```

调用：

```text
miniprogram/services/image-service.ts
```

`createDraft()` 当前负责：

```text
settings 合并
↓
createPatternCells()
↓
组装 PatternDraft
```

本阶段必须保持 `createDraft()` 的公开调用方式不变。

---

## 2.2 当前 `image-service.ts` 的职责

当前文件同时承担：

```text
图片选择
图片取消判断
文件头读取
JPG / PNG / WEBP 校验
Canvas 图片解码
中心裁剪计算
Canvas 缩放
RGBA 读取
透明像素过滤
Median Cut
RGB 最近色计算
HEX 转换
PatternCell 生成
PatternDraft 生成
```

这已经明显超出单一 service 的合理职责。

Phase 1 的核心不是“重新设计算法”，而是把：

```text
图片输入职责
```

与：

```text
Pattern Generation 职责
```

分开。

---

## 2.3 当前 V1 算法语义

当前 Standard V1 的输出行为必须被冻结为兼容基线：

### Crop

```text
sourceRatio > targetRatio
→ 横向中心裁剪

sourceRatio < targetRatio
→ 纵向中心裁剪

sourceRatio === targetRatio
→ 不裁剪
```

### Resize

```text
Canvas drawImage(..., targetWidth, targetHeight)
```

直接由微信 Canvas 将裁剪区域缩放到最终网格尺寸。

### Alpha

```text
alpha < 32
→ transparent
```

透明 Cell：

```ts
{ color: 'transparent', colorCode: '' }
```

### Palette

从所有 `alpha >= 32` 的目标网格像素中执行 Median Cut。

### Median Cut

初始一个 Bucket，持续选择可拆 Bucket：

```text
score = 最大 RGB channel range × bucket.length
```

选择 Bucket 最宽的 RGB channel 排序后从中间切分。

最终每个 Bucket 使用算术平均 RGB 作为 Palette Color。

### Nearest Color

当前使用：

```text
ΔR² + ΔG² + ΔB²
```

### 色号

按照 Palette Array 顺序生成：

```text
C01
C02
C03
...
```

这些行为在 Phase 1 均不得改变。

---

# 3. 本阶段范围

## 3.1 In Scope

本阶段允许：

```text
建立 V1 基准规范
建立固定测试输入/测试矩阵
建立 Characterization Tests
记录真实微信 Canvas 基线
提取 V1 Pattern Generation 模块
提取 Median Cut
提取 RGB 颜色工具
提取中心裁剪计算
让 image-service.ts 回归图片输入与编排职责
增加必要的测试脚本/测试配置
增加测试文档
执行 typecheck
执行新增测试
```

---

## 3.2 Out of Scope

本阶段明确禁止：

```text
Area Sampling
4× Super Sampling
Linear RGB Average
OKLab / LAB
真实 MARD Palette
Palette Selection
Palette Merge
Cleanup
Sobel
Edge Map
Dithering
AI 模式
AI API
主体识别
人脸识别
新的裁剪 UI
新的图片 Fit 模式
Renderer 改造
Pattern Schema 升级
服务器 API 修改
数据库修改
页面 UI 重构
```

如果执行过程中发现上述问题，只记录为后续事项，不实现。

---

# 4. Phase 0：建立 V1 基线

## 4.1 Phase 0 目标

建立两层基线：

```text
A. 纯算法 Characterization Baseline
B. 微信 Canvas 真实图片 Baseline
```

两层缺一不可。

原因：

当前 V1 中有一部分逻辑属于纯 TypeScript：

```text
Crop Geometry
Median Cut
RGB Distance
PatternCell Mapping
```

另一部分行为依赖微信 Canvas：

```text
图片解码
Canvas drawImage 缩放
getImageData
```

Node 环境不能可靠模拟微信 Canvas 的真实插值行为，因此不应该为了“自动化率”引入一个假的 Canvas 实现，然后把假的行为当成生产基线。

---

# 5. Phase 0A：Characterization Baseline

## 5.1 测试目的

Characterization Test 不验证“这个算法是否科学”。

它只验证：

> **当前 V1 实际行为是什么。**

因此即使某个 V1 行为未来准备修改，Phase 0 仍然要先把它锁住。

---

## 5.2 建议测试目录

建议新增：

```text
test/
└── pattern-generation/
    ├── README.md
    ├── fixtures/
    │   └── v1-characterization-cases.json
    └── v1-characterization.test.js
```

如果最终验证 Node + TypeScript 编译方式需要独立配置，可增加：

```text
test/pattern-generation/tsconfig.json
```

但不得引入第三方测试依赖。

优先使用：

```text
Node.js 内置 node:test
Node.js 内置 assert
现有 TypeScript compiler
```

如当前执行环境的 Node 版本无法稳定支持该方案，允许退化为一个普通 Node assertion script，但必须明确记录执行命令。

---

## 5.3 测试运行原则

当前根 `package.json` 只有：

```text
npm run typecheck
```

本阶段如新增自动化测试，可增加：

```text
npm run test:pattern
```

约束：

1. 不新增 npm dependency；
2. Windows/macOS/Linux 尽量均可执行；
3. 不依赖微信开发者工具才能完成纯算法 Characterization Test；
4. 不修改现有 `typecheck` 语义；
5. 测试产生的临时编译目录不得提交仓库。

---

# 6. Phase 0A 必须覆盖的 Characterization Cases

最低覆盖以下 Case。

## Case 1：单色图片

输入：

```text
2 × 2
全部相同 RGB
alpha = 255
colorLimit = 16
```

验证：

```text
Palette 只有一个有效颜色
全部 Cell 使用 C01
HEX 完全一致
```

---

## Case 2：双色均分

输入：

```text
4 × 2
左侧颜色 A
右侧颜色 B
alpha = 255
colorLimit = 2
```

验证：

```text
Median Cut 拆分结果
Palette 顺序
C01 / C02 顺序
Cell 映射
```

这里非常重要：

> Phase 1 不仅颜色集合不能变化，Palette 顺序也不能变化。

否则颜色看起来相同，但 `colorCode` 会变化。

---

## Case 3：colorLimit = 1

验证：

```text
所有不透明 Cell 最终都映射到单一平均色
```

---

## Case 4：透明阈值 31 / 32

构造：

```text
alpha = 31
alpha = 32
```

验证当前边界：

```text
31 → transparent
32 → opaque
```

这个边界在 Phase 1 不得发生 `<=` / `<` 改写错误。

---

## Case 5：全部透明

验证当前兼容行为：

```text
readOpaquePixels → []
createMedianCutPalette([], ...) → white fallback
最终所有 Cell 仍为 transparent
```

不能因为 Palette fallback 是白色就生成白色豆。

---

## Case 6：Palette 色距离 Tie

人为构造一个 Pixel 与两个 Palette Color 距离相同的 Case。

当前 `findNearestColor` 只在：

```text
distance < nearestDistance
```

时更新，因此 Tie 时保留前面的 Palette Color。

Phase 1 必须保持这一顺序语义。

---

## Case 7：Median Cut 最宽 Channel Tie

验证当前：

```text
R range >= G range && R range >= B range
→ R 优先
```

其次：

```text
G range >= B range
→ G
```

否则：

```text
B
```

Phase 1 不得因为“代码更优雅”改变 tie-break 顺序。

---

## Case 8：Bucket Selection Tie

当前：

```text
if (score > selectedScore)
```

意味着相同 score 时保留前面 Bucket。

必须 Characterize。

---

## Case 9：平均值 Round

验证当前：

```ts
Math.round(total / length)
```

而不是：

```text
floor
ceil
trunc
```

---

## Case 10：颜色 HEX

验证：

```text
0 → 00
15 → 0f
16 → 10
255 → ff
```

继续保持当前小写 HEX 输出。

---

# 7. Phase 0A：Crop Geometry 基线

中心裁剪计算必须从 Canvas 操作中抽象为纯计算函数后进行 Characterization。

建议目标接口：

```ts
export interface SourceCropRect {
  sourceX: number
  sourceY: number
  sourceWidth: number
  sourceHeight: number
}

export function calculateCenterCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): SourceCropRect
```

注意：

> 这个函数只是把当前 `image-service.ts` 中已有数学计算原样搬出，不允许顺便优化 Crop 行为。

必须覆盖：

```text
横图 → 正方形
竖图 → 正方形
正方形 → 正方形
16:9 → 4:3
4:3 → 16:9
```

验证：

```text
sourceX
sourceY
sourceWidth
sourceHeight
```

完全符合 V1 当前公式。

---

# 8. Phase 0B：微信 Canvas 真实图片 Baseline

## 8.1 为什么还需要真实图片基线

Characterization Test 无法证明：

```text
微信 Canvas drawImage
```

在重构前后是否收到完全相同的参数。

也无法替代真实设备/开发者工具图片解码和插值行为。

因此必须建立真实图片基线。

---

## 8.2 Fixture 类型

至少准备以下 6 类可合法使用的测试图片：

```text
01-square-flat.png
02-landscape-two-color.png
03-portrait-two-color.png
04-alpha-edge.png
05-gradient.png
06-detail-pattern.png
```

优先使用：

1. 自己程序生成的几何测试图；
2. 项目团队自制图片；
3. 明确允许用于测试的素材。

不要为了测试把来源不清晰的人像、动漫图直接提交仓库。

真实审美 A/B 图片可以保留在本地，不必进入 Git。

---

## 8.3 结构测试图比照片更重要

Phase 0 的主要目标是“判断行为是否变化”，因此应优先使用：

```text
纯色块
左右分色
上下分色
棋盘格
透明边缘
规则渐变
细线
```

这些图片一旦发生一个 Cell 的变化，比复杂照片更容易定位根因。

---

## 8.4 基线测试设置

至少固定：

```text
32 × 32 / 16 colors
64 × 64 / 32 colors
96 × 96 / 32 colors
128 × 128 / 64 colors
```

不是每张图都必须跑全部组合，但测试矩阵必须包含全部支持尺寸边界。

---

## 8.5 基线记录内容

每一个 Fixture + Settings 组合记录：

```text
fixtureId
sourceWidth
sourceHeight
patternWidth
patternHeight
colorLimit
cellCount
opaqueBeadCount
actualColorCount
matrixHash
paletteHash
```

其中：

```text
matrixHash
```

基于：

```text
cell.color + ':' + cell.colorCode
```

按 Cell 顺序计算稳定 Hash。

Hash 算法不要求密码学安全，只要求：

```text
稳定
简单
跨运行一致
```

可以复用项目中已有 FNV-1a 思路，但不要为了测试引入 crypto 依赖。

---

# 9. V1 Baseline Manifest

建议新增：

```text
test/pattern-generation/fixtures/v1-baseline-manifest.json
```

示意：

```json
{
  "schemaVersion": 1,
  "algorithm": "standard-v1",
  "cases": [
    {
      "id": "square-flat-64-32",
      "fixture": "01-square-flat.png",
      "width": 64,
      "height": 64,
      "colorLimit": 32,
      "cellCount": 4096,
      "beadCount": 4096,
      "colorCount": 1,
      "matrixHash": "...",
      "paletteHash": "..."
    }
  ]
}
```

Manifest 中不得保存：

```text
createdAt
Draft ID
临时文件路径
```

因为这些字段本身不确定，不能成为算法基线。

---

# 10. Pattern Snapshot 的比较范围

Phase 1 的“100% 输出一致”指：

```text
settings.width
settings.height
settings.colorLimit
settings.brand
cells.length
每个 cell.color
每个 cell.colorCode
最终 Palette 顺序（从 cells 推导）
```

以下字段不比较：

```text
PatternDraft.id
PatternDraft.createdAt
sourceImagePath 的临时路径
```

原因：这些不是生成算法输出，天然会变化。

---

# 11. Phase 0 验收门

进入 Phase 1 前至少满足：

```text
[ ] 已记录 Standard V1 精确算法语义
[ ] 已确定纯算法 Characterization Cases
[ ] 已确定 Crop Geometry Cases
[ ] 已建立真实微信 Canvas Fixture 方案
[ ] 已建立 V1 Baseline Manifest 格式
[ ] 已有可执行的基线生成/验证方式
[ ] 当前生产生成算法没有被优化
[ ] npm run typecheck 仍然通过
```

如果 Phase 0 不能生成稳定基线，不进入 Phase 1。

---

# 12. Phase 1：无行为变化重构

## 12.1 Phase 1 目标

将：

```text
Pattern Generation Algorithm
```

从：

```text
miniprogram/services/image-service.ts
```

拆到：

```text
miniprogram/services/pattern-generation/
```

但必须保证：

```text
V1 before refactor
===
V1 after refactor
```

一颗 Cell 都不能变化。

---

# 13. Phase 1 推荐最终结构

本阶段只创建真正需要的模块：

```text
miniprogram/
└── services/
    ├── image-service.ts
    │
    └── pattern-generation/
        ├── standard-generator.ts
        ├── median-cut.ts
        └── color-utils.ts
```

如果 Crop 逻辑单独放置后更清晰，可以增加：

```text
crop.ts
```

但不允许为了未来 Phase 提前创建空壳：

```text
image-resampler.ts
cell-sampler.ts
edge-detector.ts
cleanup.ts
palette-selector.ts
mard.ts
```

---

# 14. 文件职责定义

## 14.1 `image-service.ts`

重构后只保留图片输入与业务编排相关职责：

```text
chooseSourceImage()
UnsupportedImageFormatError
图片选择取消判断
文件头读取
JPG / PNG / WEBP 校验
createDraft() 外部入口
```

`createDraft()` 内部调用 Standard Generator。

目标：

```ts
export async function createDraft(
  sourceImagePath: string,
  settings: Partial<PatternSettings>,
): Promise<PatternDraft> {
  const normalizedSettings = ...
  const cells = await generateStandardPatternCells(...)
  ...
}
```

注意：

当前 `Date.now()` 行为保持不变。

---

## 14.2 `standard-generator.ts`

只承载当前 V1 的图像 → PatternCell 生成链路：

```text
OffscreenCanvas 创建
Canvas image load
中心 Crop Rect
Canvas drawImage
getImageData
读取目标像素
调用 Median Cut
调用 nearest RGB
PatternCell[] 映射
```

推荐公开接口：

```ts
export async function generateStandardPatternCells(
  sourceImagePath: string,
  settings: PatternSettings,
): Promise<PatternCell[]>
```

不要返回新的自定义 Pattern Result。

因为 Phase 1 不修改现有 `createDraft()` 数据模型。

---

## 14.3 `median-cut.ts`

只承载当前 V1 Median Cut：

```text
createMedianCutPalette
findBucketToSplit
getWidestChannel
getColorRange
averageColor
```

推荐只公开真正需要的：

```ts
export function createMedianCutPalette(
  pixels: RGB[],
  colorLimit: number,
): RGB[]
```

内部辅助函数不必全部 export。

---

## 14.4 `color-utils.ts`

Phase 1 只放当前 RGB 相关能力：

```ts
export interface RGB {
  r: number
  g: number
  b: number
}

export function findNearestColor(...)
export function rgbToHex(...)
```

如果 `readOpaquePixels()` 更适合 `standard-generator.ts`，保留在那里即可。

不要在 Phase 1 增加：

```text
Linear RGB
OKLab
ΔE
```

这些属于 Phase 2 / Phase 3。

---

# 15. Canvas 行为保持要求

Phase 1 中以下调用参数必须保持语义完全一致：

```ts
wx.createOffscreenCanvas({
  type: '2d',
  width,
  height,
})
```

以及：

```ts
context.drawImage(
  image,
  sourceX,
  sourceY,
  sourceWidth,
  sourceHeight,
  0,
  0,
  width,
  height,
)
```

禁止顺手：

```text
修改 Canvas 尺寸
修改插值方式
增加 imageSmoothing 设置
改变 Crop 算法
增加 intermediate canvas
改变 Alpha 阈值
```

这些都会导致 Phase 1 失去“无行为变化”性质。

---

# 16. Median Cut 行为保持要求

Phase 1 不能为了代码风格修改以下细节：

```text
Bucket score 算法
Bucket tie-break 顺序
Channel tie-break 顺序
Array.sort 比较逻辑
切分 middle 的 Math.floor
Bucket splice 顺序
averageColor 的 Math.round
Palette 顺序
```

尤其禁止把：

```text
bucket.sort(...)
```

改成一个理论上“更稳定”但实际排序结果可能变化的新实现。

Phase 1 的目标不是修算法。

---

# 17. Nearest Color 行为保持要求

当前最近色必须继续使用：

```ts
const red = pixel.r - color.r
const green = pixel.g - color.g
const blue = pixel.b - color.b
const distance = red * red + green * green + blue * blue
```

并继续：

```ts
if (distance < nearestDistance)
```

禁止 Phase 1 改成：

```text
<=
Manhattan Distance
Weighted RGB
LAB
OKLab
```

---

# 18. Phase 1 测试策略

重构完成后运行两类验证。

## A. Characterization Test

所有 Phase 0A Case 必须通过。

## B. Baseline Manifest Comparison

对同一套微信 Fixture：

```text
V1 baseline manifest
VS
Phase 1 actual output
```

要求：

```text
matrixHash 100% 相同
paletteHash 100% 相同
beadCount 100% 相同
colorCount 100% 相同
```

任何一个 Case 不一致：

> Phase 1 验收失败。

不要以肉眼“看起来一样”替代 Hash Comparison。

---

# 19. Phase 1 最低回归测试

除了算法一致性，至少手工回归：

```text
首页上传 JPG
首页上传 PNG
首页上传 WEBP
非法文件格式提示
取消图片选择
标准模式生成
进入编辑器
编辑器显示 Pattern
结果页材料统计
保存作品（本地）
云端保存路径不报结构错误
```

本阶段没有修改这些业务，但由于 `createDraft()` 调用链发生重构，仍需验证主要调用方。

---

# 20. 预计修改文件

最终实际文件以 Codex 检查仓库后为准，但预期主要涉及：

```text
新增：
miniprogram/services/pattern-generation/standard-generator.ts
miniprogram/services/pattern-generation/median-cut.ts
miniprogram/services/pattern-generation/color-utils.ts

可选新增：
miniprogram/services/pattern-generation/crop.ts

test/pattern-generation/README.md
test/pattern-generation/fixtures/v1-characterization-cases.json
test/pattern-generation/fixtures/v1-baseline-manifest.json
test/pattern-generation/v1-characterization.test.js

可能修改：
miniprogram/services/image-service.ts
package.json
.gitignore

文档：
docs/STANDARD_PATTERN_ENGINE_V2_PHASE_0_1.md
docs/CHANGELOG.md（仅在真正完成 Phase 0/1 代码开发后按项目版本规则记录）
```

禁止修改：

```text
miniprogram/pages/home/*（除非发现现有调用无法兼容，必须先停下说明）
miniprogram/pages-sub/editor/*
miniprogram/pages-sub/result/*
server/src/modules/works/*
数据库设计
AI 模式 UI
```

---

# 21. package.json 策略

当前根项目只有：

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

如果 Characterization Test 可以在不增加依赖的情况下稳定执行，允许增加：

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test:pattern": "..."
  }
}
```

要求：

```text
不删除 typecheck
不改变 typecheck 行为
不增加第三方 testing dependency
```

如建立跨平台 Node 测试需要额外 shell 工具，则不要使用依赖 Unix 命令的脚本，例如：

```text
rm -rf
cp
sed
```

优先使用 Node 自身能力，避免 Windows 环境失效。

---

# 22. 类型检查约束

根 `tsconfig.json` 当前：

```text
strict = true
noImplicitAny = true
noUnusedLocals = true
noUnusedParameters = true
include = miniprogram/**/*.ts
```

Phase 1 新增 TS 模块必须继续通过：

```bash
npm run typecheck
```

禁止通过：

```text
any
@ts-ignore
关闭 strict
扩大 skip 检查范围
```

绕过真实类型问题。

---

# 23. Commit 拆分

即使 Phase 0 + Phase 1 在同一个开发周期完成，也必须分 Commit。

建议：

## Commit 1 — Phase 0

```text
test(pattern): establish Standard V1 characterization baseline
```

内容只包含：

```text
测试基线
Fixture/Manifest
测试工具
必要的测试配置
```

如果为了测试必须增加极小的 testing seam，必须确保生产行为不变，并在 Commit 说明中明确。

---

## Commit 2 — Phase 1

```text
refactor(pattern): extract Standard V1 generation engine
```

内容：

```text
算法模块拆分
image-service.ts 减负
无行为变化验证
```

不要和 Phase 2 合并。

---

# 24. Phase 0 + Phase 1 最终验收清单

## Phase 0

```text
[ ] V1 行为规范已经锁定
[ ] Characterization Cases 已实现
[ ] Crop Geometry 已覆盖
[ ] Alpha 31/32 边界已覆盖
[ ] Median Cut tie-break 已覆盖
[ ] Nearest Color tie 已覆盖
[ ] HEX 行为已覆盖
[ ] 真实微信 Fixture 已建立
[ ] Baseline Manifest 已建立
[ ] Matrix Hash 可稳定复现
[ ] Palette Hash 可稳定复现
```

## Phase 1

```text
[ ] createDraft() 对外接口未变化
[ ] PatternDraft 数据结构未变化
[ ] image-service.ts 不再承载 Median Cut 细节
[ ] Standard Generator 已独立
[ ] Median Cut 已独立
[ ] RGB Utils 已独立
[ ] 未实现 OKLab
[ ] 未实现 Area Sampling
[ ] 未实现 MARD 真色卡
[ ] 未实现 Cleanup
[ ] 未实现 Edge
[ ] Characterization Tests 全部通过
[ ] 所有 baseline matrixHash 完全相同
[ ] 所有 baseline paletteHash 完全相同
[ ] npm run typecheck 通过
[ ] 标准模式主流程手工回归通过
```

---

# 25. Stop Conditions

Codex 执行过程中遇到以下情况必须停下来报告，不允许自行扩大范围：

```text
1. 为了测试必须引入第三方依赖。
2. 微信 OffscreenCanvas 行为无法在当前方式下稳定基线化。
3. 重构后某些 Fixture Hash 无法保持一致。
4. 当前源码与本文档描述存在关键差异。
5. createDraft() 无法在不修改页面调用的情况下完成拆分。
6. 必须修改 PersistedPattern Schema 才能继续。
7. 必须修改 server API 才能继续。
8. 发现 V1 本身存在 Bug，但修复 Bug 会改变 Pattern 输出。
```

对于第 8 条：

> Phase 1 仍然先保持 Bug-compatible；Bug 修复单独立项。

因为本阶段目标是建立可比较基线，而不是顺便修正算法。

---

# 26. Codex 执行提示词

后续可以直接把下面任务交给 Codex：

```text
任务：完成 Standard Pattern Engine V2 的 Phase 0 + Phase 1。

开始前必须阅读：
- AGENTS.md
- docs/CODE_RULES.md
- docs/MINI_PROGRAM_RULES.md
- docs/STANDARD_PATTERN_ENGINE_V2_PLAN.md
- docs/STANDARD_PATTERN_ENGINE_V2_PHASE_0_1.md

目标：
1. 建立 Standard V1 可复现 Characterization Baseline。
2. 建立真实微信 Canvas Baseline 的测试/记录机制。
3. 在基线锁定后，把当前 image-service.ts 中的 Standard V1 Pattern Generation 逻辑拆到独立模块。
4. 重构前后 Standard V1 的 Pattern 输出必须 100% 一致。

强约束：
- 本次不优化任何生成效果。
- 不做 Area Sampling。
- 不做 Linear RGB。
- 不做 OKLab/LAB。
- 不接入真实 MARD 色卡。
- 不做 Cleanup。
- 不做 Edge Detection。
- 不做 Dithering。
- 不修改 AI 精致模式。
- 不修改 Pattern Schema。
- 不修改后端 API/数据库。
- 不改变 createDraft() 的页面调用方式。
- 不安装新的 npm dependency。
- 不修改无关页面。

实施顺序：
A. 先检查当前实现并列出 V1 精确行为。
B. 完成 Phase 0 基线和 Characterization Tests。
C. 运行基线，确认可复现。
D. 单独完成 Phase 1 代码拆分。
E. 再运行全部基线，确认 matrixHash / paletteHash 完全一致。
F. 执行 npm run typecheck 和可运行测试。
G. 手工回归标准模式关键流程。

完成后必须输出：
- 修改文件清单；
- 每个文件职责；
- Phase 0 测试 Case 结果；
- Phase 1 前后 Hash Comparison；
- typecheck/test 结果；
- 手工回归结果；
- 未解决问题；
- 是否可以进入 Phase 2。

如果任何 Baseline Hash 不一致，不得宣布 Phase 1 完成，也不得进入 Phase 2。
```

---

# 27. 本阶段完成后的代码边界

理想完成状态：

```text
Home
 │
 ▼
image-service.ts
 │
 ├─ 图片选择/校验
 ├─ settings normalize
 └─ createDraft orchestration
         │
         ▼
pattern-generation/standard-generator.ts
         │
         ├─ Canvas decode/crop/resize
         ├─ RGBA → pixels
         │
         ├────► median-cut.ts
         │
         └────► color-utils.ts
                 │
                 ▼
             PatternCell[]
```

此时 Standard V1 的效果仍然完全不变，但 Phase 2 可以只修改：

```text
standard-generator / 新增 sampling module
```

而不用再触碰图片选择、文件校验、首页交互等外围代码。

---

# 28. Phase 2 进入条件

只有同时满足以下条件才能进入 Phase 2：

```text
Phase 0 PASS
+
Phase 1 PASS
+
所有 Baseline Hash 相同
+
TypeScript PASS
+
标准模式业务回归 PASS
```

Phase 2 才允许第一次故意改变 Pattern Matrix：

```text
Canvas 一步缩放
↓
4× Intermediate + Area Sampling
```

届时任何 Hash 变化都属于“预期变化”，并通过 Phase 0 建立的同一套 Fixture 做正式 A/B。

---

## 当前状态

```text
总方案：已沉淀
Phase 0 + Phase 1 实施方案：已沉淀
Phase 0 代码开发：待开始
Phase 1 代码开发：待 Phase 0 基线通过后开始
Phase 2：禁止提前开发
```
