# Standard Pattern Engine V2 开发方案

> 文档定位：标准模式拼豆图生成引擎 V2 的总设计方案与分阶段实施基线
>
> 适用项目：`pindou-studio`
>
> 目标：在不使用 AI、不引入外部模型成本的前提下，显著提升标准模式生成拼豆图的结构表现、颜色自然度、区域连续性和真实可施工性
>
> 本文档是后续 Phase 0 ~ Phase 8 开发任务的总方案基线后续每次只实现一个明确 Phase，禁止跨阶段提前开发

---

## 1. 背景与当前问题

当前标准模式已经能够完成从用户图片到拼豆 Pattern 的完整生成流程，但核心算法仍然属于基础的“裁剪 + 缩放 + 颜色量化”方案

当前主要生成逻辑位于：

```text
miniprogram/services/image-service.ts
```

当前核心流程：

```text
原始图片
   ↓
按目标比例中心裁剪
   ↓
Canvas 直接缩放到目标网格尺寸
   ↓
读取目标尺寸像素
   ↓
Median Cut 生成临时 Palette
   ↓
RGB 欧氏距离匹配最近颜色
   ↓
生成 C01 / C02 / C03 ...
   ↓
PatternDraft
```

当前默认配置位于：

```text
miniprogram/config/product.ts
```

基础默认配置：

```text
width: 32
height: 32
colorLimit: 24
brand: MARD
```

首页当前运行时默认覆盖为：

```text
64 × 64
32 色
```

并支持：

```text
尺寸：32 / 48 / 64 / 96 / 128
颜色：16 / 32 / 64 / 96
```

当前 `brand: MARD` 仅存在于业务设置中，生成阶段并没有真正映射到 MARD 真实色号目前 Palette 来自 Median Cut 动态生成，`C01 / C02 ...` 也只是临时编号

Standard V1 当前主要问题：

1. 大图直接缩到 32~128 网格，细节容易被混色或抹掉
2. RGB 欧氏距离与人眼感知差异明显，尤其是肤色、棕色、粉色、米白、灰白等区域
3. 颜色量化没有真实拼豆色卡约束
4. 所有区域被同等处理，轮廓、眼睛、头发边缘等结构信息没有受到保护
5. 缺少孤立豆、碎色、毛刺等后处理
6. 颜色越多不一定越好，近似色可能导致施工图复杂但视觉收益有限
7. 当前生成算法、图片输入、格式校验等职责集中在一个文件中，不利于继续演进

---

## 2. V2 产品定位

Standard Engine V2 继续定位为：

> 免费、快速、确定性、无需 AI、真实可施工的拼豆生成引擎

Standard V2 不承担 AI 语义理解，也不尝试“重新设计”图片

目标是：

```text
有限网格
+
有限真实拼豆色号
+
确定性图像算法
+
结构保护
+
噪声控制
=
更自然、更清晰、更可拼的 Pattern Matrix
```

未来产品总架构：

```text
                    Pattern Engine
                         │
          ┌──────────────┴──────────────┐
          │                             │
    Standard Mode                  AI Fine Mode
          │                             │
       原始图片                     原始图片
          │                             │
          │                         AI 简化
          │                             │
          └──────────────┬──────────────┘
                         │
                         ▼
                Standard Engine V2
                         │
                   Area Sampling
                         │
                      OKLab
                         │
                  MARD Palette
                         │
                 Edge Protection
                         │
                     Cleanup
                         │
                         ▼
                  Pattern Matrix
```

Ai 模式未来只负责把原图变成“更适合拼豆转换的中间稿”，之后仍然进入 Standard Engine V2

因此 Standard Engine V2 是未来两种生成模式共同依赖的核心能力

---

## 3. V2 总目标

Standard Engine V2 不以单纯降低像素颜色误差为唯一目标

优先优化：

1. 主体识别度
2. 轮廓完整度
3. 局部结构保留
4. 色彩关系自然度
5. 区域连续性
6. 低噪点、低碎色
7. 实际拼豆可操作性
8. 真实品牌色号可施工性
9. 本地生成性能
10. 输出稳定、可复现

目标 Pipeline：

```text
原图
 │
 ▼
[1] Crop / Fit
 │
 ▼
[2] 高质量中间采样
 │
 ▼
[3] Cell Area Sampling
 │
 ▼
[4] 感知色彩空间 OKLab
 │
 ▼
[5] 候选 Palette 分析
 │
 ▼
[6] 真实拼豆 Palette 选择
 │
 ▼
[7] Cell 色号映射
 │
 ▼
[8] Edge-aware 结构保护
 │
 ▼
[9] Pattern Cleanup
 │
 ▼
Pattern Matrix
 │
 ├─ 编辑器
 ├─ 拼豆预览
 ├─ 施工图
 └─ 材料统计
```

---

## 4. 核心工程原则

### 4.1 保持现有页面业务接口

当前首页标准模式调用：

```ts
const draft = await createDraft(sourceImagePath, settings)
```

V2 主体开发期间保持这一调用方式不变：

```text
Home Page
   ↓
createDraft()
   ↓
Standard Engine V2
```

禁止为了算法改造同时大规模修改：

- 首页交互；
- 编辑器；
- 结果页；
- 下载流程；
- 云端同步；
- 收藏逻辑；
- 作品列表；
- 页面跳转

算法升级必须尽量保持现有业务层无感

### 4.2 前期保持 Pattern 数据结构不变

当前核心结构：

```ts
export interface PatternCell {
  color: string
  colorCode: string
}
```

持久化结构继续使用：

```text
palette[]
cells[]
```

当前结构已经可以承载真实色号，因此不需要为了 V2 立即升级服务器 schema

第一阶段禁止给 `PersistedPattern` 随意增加字段，因为后端当前存在严格字段校验

如后期确实需要保存算法版本，应单独设计 `schemaVersion: 2` 迁移方案

### 4.3 Standard 模式必须确定性

同一张图片，在以下条件一致时：

```text
相同原图
+
相同裁剪区域
+
相同 PatternSettings
+
相同算法版本
```

必须产生完全一致的：

```text
Palette
+
Pattern Matrix
```

Standard 模式禁止引入不可控随机过程

### 4.4 分阶段开发，不允许一次重写

每个 Phase 必须：

1. 单独实现；
2. 单独测试；
3. 单独 A/B；
4. 单独提交 Commit；
5. 验收通过后才能进入下一 Phase

禁止一次性同时修改：

```text
采样
+
OKLab
+
真实色卡
+
Cleanup
+
Edge
+
Renderer
```

### 4.5 不引入无必要重依赖

Standard V2 第一轮实现全部基于：

```text
TypeScript
+
微信小程序 Canvas
+
TypedArray
```

暂不引入：

```text
OpenCV
TensorFlow
大型图像处理 npm 包
WASM 图像库
服务端图片算法依赖
```

### 4.6 任意优化都不能破坏可施工性

最终 Pattern 必须始终满足：

```ts
cells.length === width * height
```

每一个非透明 Cell：

- 必须存在合法颜色；
- 必须存在合法色号；
- 必须属于最终作品 Palette；
- 不允许出现越界 Palette Index；
- 保存、编辑、下载和材料统计必须继续正常工作

---

## 5. 推荐代码结构

当前 `image-service.ts` 同时负责图片输入与核心算法V2 不应继续将所有算法塞入该文件

目标结构：

```text
miniprogram/
├── services/
│   ├── image-service.ts
│   │
│   └── pattern-generation/
│       ├── standard-generator.ts
│       ├── image-resampler.ts
│       ├── cell-sampler.ts
│       ├── color-space.ts
│       ├── median-cut.ts
│       ├── palette-selector.ts
│       ├── color-mapper.ts
│       ├── edge-detector.ts
│       ├── cleanup.ts
│       └── types.ts
│
└── data/
    └── bead-palettes/
        └── mard.ts
```

注意：不允许 Phase 1 一次创建所有未来文件文件应随具体 Phase 逐步增加，避免提前设计未验证抽象

---

## 6. Phase 总览

| Phase | 内容 | 是否改变生成结果 | 风险 | 核心目的 |
|---|---|---:|---:|---|
| Phase 0 | 建立算法基线与测试集 | 否 | 低 | 让后续变化可测量 |
| Phase 1 | 无行为变化代码拆分 | 不应该 | 低 | 建立可演进结构 |
| Phase 2 | 高质量 Area Sampling | 是 | 中 | 改善缩小阶段的信息损失 |
| Phase 3 | OKLab 感知颜色距离 | 是 | 低 | 改善颜色自然度 |
| Phase 4 | MARD 真实色卡 | 是 | 中 | 让输出真正可施工 |
| Phase 5 | 保守型 Cleanup | 是 | 中 | 消除孤立豆、杂色和毛刺 |
| Phase 6 | Edge-aware 结构保护 | 是 | 中高 | 保护轮廓与局部结构 |
| Phase 7 | Palette Optimization | 是 | 高 | 控制近似色与全局 Palette 质量 |
| Phase 8 | Renderer 优化 | Matrix 不变 | 低 | 提升真实拼豆展示效果 |

推荐开发顺序：

```text
Phase 0
  ↓
Phase 1
  ↓
Phase 2
  ↓
A/B
  ↓
Phase 3
  ↓
A/B
  ↓
Phase 4
  ↓
A/B
  ↓
Phase 5
  ↓
A/B
  ↓
Phase 6
  ↓
完整真实图片集评估
  ↓
Standard V2 Release Candidate
```

Phase 7 可根据 Phase 6 实际效果决定是否延后到 V2.1

Phase 8 独立于算法质量，可在 Pattern Matrix 稳定后再做

---

## 7. Phase 0：建立算法基线

### 7.1 目标

在修改任何生成算法之前，先建立可复现的 V1 基线

必须能回答：

> Standard V2 相比 V1 到底哪里变好了、哪里变差了？

没有基线，不进入正式算法改造

### 7.2 固定测试图片集

建议准备至少：

```text
test-assets/pattern-generation/

01-anime-face.png
02-real-person.jpg
03-pet.jpg
04-cartoon.png
05-logo.png
06-landscape.jpg
07-complex-illustration.png
08-flat-pixel-art.png
```

建议额外覆盖：

- 动漫少女头像；
- 人物半身图；
- 宠物头像；
- 简单图标；
- 高饱和插画；
- 低饱和照片；
- 复杂背景图片

版权来源不明确的测试素材不要提交到公共仓库，可使用自制测试素材或本地忽略目录

### 7.3 固定测试参数

每张图片至少测试：

```text
64 × 64 / 32 色
96 × 96 / 32 色
```

重点图片额外测试：

```text
32 × 32 / 16 色
128 × 128 / 64 色
```

### 7.4 保存基准数据

每张测试图记录：

```text
原图标识
尺寸设置
颜色上限
最终颜色数
豆子数
生成耗时
V1 Pattern Matrix Hash
V1 Preview
```

后续每一个 Phase 都使用同一组图片和同一组设置比较

### 7.5 Phase 0 验收标准

必须具备：

1. 固定测试图片集；
2. 固定测试参数；
3. 可重复执行的生成流程；
4. V1 基准输出；
5. 至少能够比较 Cell Matrix 是否变化；
6. 能记录生成耗时；
7. 不修改 Standard V1 实际生成效果

---

## 8. Phase 1：无行为变化代码重构

### 8.1 目标

只拆职责，不改变任何生成结果

当前 `image-service.ts` 中的算法逻辑逐步迁移到：

```text
services/pattern-generation/
```

推荐第一阶段仅拆：

```text
standard-generator.ts
median-cut.ts
color-utils.ts 或 color-space.ts
```

不要提前实现未使用的：

```text
edge-detector.ts
cleanup.ts
palette-selector.ts
mard.ts
```

### 8.2 对外接口保持不变

仍然由：

```ts
createDraft(sourceImagePath, settings)
```

返回：

```ts
PatternDraft
```

页面和编辑器无需感知算法模块拆分

### 8.3 Phase 1 强制验收

对于 Phase 0 测试集：

```text
旧实现 Output
===
新实现 Output
```

要求：

```text
100% cells equality
100% palette equality
100% colorCode equality
```

如果重构后输出发生变化，Phase 1 不通过

---

## 9. Phase 2：高质量 Area Sampling

### 9.1 当前问题

当前流程把原始大图直接缩到最终网格尺寸，例如：

```text
2000 × 2000
↓
64 × 64
```

容易导致：

- 眼睛边缘被混色；
- 发丝与背景被平均；
- 嘴部、鼻部等小结构消失；
- 轮廓边缘产生脏色；
- 高光和阴影层次不稳定

### 9.2 新方案

目标尺寸为 N 时，先生成：

```text
4N × 4N
```

中间图

建议：

```ts
const SAMPLE_SCALE = 4
```

对应：

```text
32  → 128
48  → 192
64  → 256
96  → 384
128 → 512
```

最大中间图仅为 512×512

### 9.3 Cell Area Sampling

最终一个 Pattern Cell 对应中间图的一块区域

例如 64×64：

```text
256 × 256
↓
每个 4×4 区域
↓
1 个 Pattern Cell
```

第一版实现：

```text
Linear RGB Area Average
```

不要直接对 gamma 编码后的 sRGB 做简单平均

### 9.4 SampledCell 设计

Phase 2 第一版：

```ts
interface SampledCell {
  rgb: RGB
}
```

后续如有验证需求再扩展：

```ts
interface SampledCell {
  rgb: RGB
  variance: number
  dominant?: RGB
}
```

### 9.5 性能要求

Area Sampling 不允许对高分辨率中间图构造大量 JS Object

优先：

```text
Uint8ClampedArray
Float32Array
```

### 9.6 Phase 2 验收重点

观察：

- 人物脸部轮廓；
- 头发边缘；
- 眼睛；
- 小型高对比结构；
- Logo 边缘；
- 大面积平滑区域

同时记录 `generationTimeMs`

---

## 10. Phase 3：RGB → OKLab

### 10.1 当前问题

当前最近色匹配使用 RGB 欧氏距离：

```text
(R1-R2)² + (G1-G2)² + (B1-B2)²
```

这种距离不符合人眼感知，在肤色、棕色、粉色、米白、浅灰、浅黄等区域尤其明显

### 10.2 新方案

实现：

```text
sRGB
↓
Linear RGB
↓
OKLab
↓
OKLab Distance
```

建议新增：

```text
pattern-generation/color-space.ts
```

提供：

```ts
interface OKLab {
  l: number
  a: number
  b: number
}

rgbToLinearRgb()
linearRgbToOklab()
rgbToOklab()
oklabDistance()
```

### 10.3 Phase 3 限制

Phase 3 只替换颜色距离

仍然使用当前 Median Cut 生成 Palette

禁止在同一个 Phase 同时接入真实 MARD 色表

### 10.4 验收重点

重点观察：

```text
肤色过渡
棕色头发
灰白衣服
粉色装饰
浅黄色花朵
低饱和照片
```

---

## 11. Phase 4：真实 MARD 色卡

### 11.1 目标

当前：

```text
Median Cut
↓
动态平均色
↓
C01 / C02 / C03
```

V2 目标：

```text
图片色彩分布
↓
候选视觉颜色
↓
MARD 真实色号
↓
作品 Palette
↓
Pattern Matrix
```

### 11.2 色卡数据结构

新增：

```text
miniprogram/data/bead-palettes/mard.ts
```

建议：

```ts
interface BeadColor {
  code: string
  name: string
  hex: string
  oklab: OKLab
}
```

若可预计算 `oklab`，优先静态保存，避免每次生成重复转换整套色卡

### 11.3 MARD 数据质量要求

MARD 色卡属于业务基础数据

禁止：

- 从模糊图片人工猜 RGB；
- 混用不同版本色卡；
- 使用无法确认出处的二手数据；
- 同一个 code 存在多套颜色值而不标注版本

必须具备：

```text
稳定来源
色号唯一
HEX 合法
人工抽样校验
版本可追踪
```

### 11.4 不允许直接全色最近匹配

不能：

```text
每个 Cell
↓
对所有 MARD 色找最近色
```

正确流程：

```text
Sampled Cells
      ↓
Median Cut / 候选颜色分析
      ↓
候选视觉中心
      ↓
映射 MARD
      ↓
去重
      ↓
选择最终作品 Palette
      ↓
所有 Cell 映射到该 Palette
```

Median Cut 从“最终 Palette 生成器”变成 Candidate Color Analyzer

### 11.5 colorLimit 语义

V2 中：

```text
colorLimit
```

表示最终作品允许使用的最大真实拼豆色号数量

必须满足：

```text
finalPalette.length <= colorLimit
```

### 11.6 Phase 4 验收重点

1. 所有输出色号属于真实 MARD 色卡；
2. 最终颜色数不超过 colorLimit；
3. 编辑器正常显示；
4. 材料统计输出真实色号；
5. 云端保存通过现有后端校验；
6. Pattern Schema 暂不变化；
7. 老作品加载不受影响

---

## 12. Phase 5：保守型 Pattern Cleanup

### 12.1 目标

减少：

```text
孤立豆
随机杂色
边缘毛刺
无意义小色块
```

但不能破坏：

```text
眼睛高光
瞳孔
嘴
小花
文字点
高对比装饰
```

### 12.2 第一版策略

新增：

```text
pattern-generation/cleanup.ts
```

使用：

```text
3 × 3 Neighborhood
```

替换中心 Cell 必须同时满足：

```text
邻域高度一致
+
当前 Cell 与邻域主色 OKLab 差异较小
+
当前点不是显著高对比结构
```

### 12.3 禁止粗暴规则

禁止：

```text
只出现 1 次的颜色 → 删除
```

禁止：

```text
邻居多数颜色 → 无条件替换中心
```

### 12.4 迭代次数

默认：

```text
iterations = 1
```

禁止无上限重复 Cleanup

### 12.5 调试指标

可记录：

```text
isolatedCellCountBefore
isolatedCellCountAfter
cellsChangedByCleanup
```

---

## 13. Phase 6：Edge-aware 结构保护

### 13.1 目标

Standard 模式没有 AI，不知道“哪里是眼睛、哪里是头发”，但可以检测强烈亮度/颜色变化，也就是结构边缘

用于保护：

```text
脸部轮廓
眼睛边缘
头发边缘
衣服轮廓
Logo 边缘
物体与背景边界
```

### 13.2 Edge Map

新增：

```text
pattern-generation/edge-detector.ts
```

第一版：

```text
RGB
↓
Luminance
↓
Sobel X
Sobel Y
↓
Gradient Magnitude
↓
0 ~ 1 Edge Strength
```

建议结果使用：

```ts
Float32Array
```

### 13.3 Edge Map 的用途

Edge Map 不直接画轮廓线，而是作为算法权重输入

强边缘区域：

```text
减少颜色平均
提高主色权重
避免两侧大色块被混成中间脏色
优先保留亮暗分界
```

平坦区域继续允许 Area Average 和 Cleanup

### 13.4 第一版范围

第一版优先只影响：

```text
Cell Sampling
或
Cleanup Protection
```

两者先选择一条清晰实现路径

禁止在 Phase 6 一次引入大量未经验证的权重和特殊规则

### 13.5 验收重点

重点测试：

```text
动漫人物眼睛
头发 / 脸边界
宠物耳朵
Logo 字符边缘
深色衣服轮廓
高对比插画
```

同时检查：

- 锯齿是否加重；
- 颜色数是否失控；
- Cleanup 是否与 Edge Protection 冲突

---

## 14. Phase 7：Palette Optimization

### 14.1 定位

这是 Standard V2 最复杂的算法阶段

建议在 Phase 0~6 稳定后再做如果 Phase 6 已达到产品要求，Phase 7 延后到 V2.1

### 14.2 近似色合并

当两个真实拼豆色号视觉差异很小，可考虑：

```text
如果 ΔE < threshold
↓
尝试合并
```

但必须验证局部结构是否被破坏

### 14.3 Palette Selection

最终目标不只是：

```text
Color Error 最小
```

而是综合：

```text
Color Error
+
Edge Preservation
+
Neighbor Consistency
+
Palette Complexity
```

未来可演进为类似：

```text
Cost =
0.60 × colorError
+ 0.20 × edgeError
+ 0.15 × neighborNoise
+ 0.05 × paletteComplexity
```

以上仅为方向性公式，权重必须通过测试集 A/B 调整，不能未经验证直接固化

### 14.4 Dithering 策略

默认：

```text
Dithering = OFF
```

Floyd-Steinberg 等误差扩散容易造成大量零散豆、颜色交错、施工困难

未来如有需要，可探索低强度 Ordered Dithering，且仅用于大面积渐变区域

---

## 15. Phase 8：Renderer 优化

### 15.1 目标

Renderer 解决：

> 同一份 Pattern Matrix 在界面上看起来像不像真实拼豆

必须区分：

```text
Pattern Quality
≠
Rendering Quality
```

### 15.2 当前已有能力

当前 Renderer 已具备：

```text
圆形豆
轻微阴影
白色高光
```

### 15.3 后续可增加

```text
中心豆孔
轻微内阴影
统一豆间距
弱高光
弱塑料质感
```

避免过度 3D、强阴影和强高光导致颜色判断失真

施工图模式保持高可读性，不使用复杂视觉效果

---

## 16. Crop / Fit 策略

当前生成阶段按目标比例中心裁剪，这可能造成：

```text
用户预览看到完整图
但最终 Pattern 被中心裁掉部分内容
```

未来应单独优化输入适配策略，例如：

```text
图片适配：
● 完整保留
○ 居中裁剪
```

或上传后允许用户调整裁剪框

注意：Crop / Fit 属于输入控制，不应与 Standard Engine V2 某一算法 Phase 混在同一次开发任务中，应单独立项

---

## 17. 算法版本管理

开发期可定义内部算法版本：

```ts
type PatternAlgorithmVersion =
  | 'standard-v1'
  | 'standard-v2-p2'
  | 'standard-v2-p3'
  | 'standard-v2-p4'
  | 'standard-v2-p5'
  | 'standard-v2-p6'
  | 'standard-v2'
```

用途：

- Debug；
- A/B 记录；
- 日志；
- 本地测试

第一阶段不要写入当前 `PersistedPattern`

---

## 18. Feature Flag / 阶段开关

开发验证期间可考虑：

```ts
interface StandardEngineFeatures {
  areaSampling: boolean
  oklab: boolean
  realPalette: boolean
  cleanup: boolean
  edgeProtection: boolean
  paletteMerge: boolean
}
```

用途：

```text
V1
V2-P2
V2-P3
V2-P4
...
```

要求：

- 仅用于开发和验证；
- 不为了 Feature Flag 过度抽象；
- 正式版本稳定后收敛默认配置；
- 第一阶段不向用户暴露技术开关

---

## 19. A/B 测试体系

每完成一个 Phase 都必须生成：

```text
原图
V1
当前 V2
```

三图并排比较，禁止依赖记忆判断效果

### 19.1 主观评分

每张图至少评估：

```text
主体识别度       1~5
轮廓完整度       1~5
颜色自然度       1~5
局部噪点控制     1~5
渐变整洁度       1~5
实际拼豆可操作性 1~5
```

建议额外记录：

```text
主要优点
主要退化点
```

### 19.2 客观指标

第一阶段记录：

```text
generationTimeMs
colorCount
beadCount
isolatedCellCount
```

后续可加入：

```text
meanColorError
edgeRetention
paletteMergeCount
cleanupChangedCells
```

不要在第一阶段为了“指标完整”开发大量复杂评估工具

---

## 20. 性能预算

Standard 模式必须继续保持“本地快速生成”

建议目标：

### 64 × 64

```text
< 500 ms
```

### 96 × 96

```text
< 1000 ms
```

### 128 × 128

```text
< 1500 ~ 2000 ms
```

目标设备：普通中端手机，而不是仅在桌面开发者工具测试

如果某 Phase 导致典型生成时间明显超过 2~3 秒，需要重新检查：

- 算法复杂度；
- 重复颜色转换；
- JS Object 数量；
- 多次 Canvas readback；
- 大数组复制；
- 不必要排序

---

## 21. 内存与数据结构

禁止在高分辨率中间图上大量创建：

```ts
{ r, g, b }
```

对象数组

内部优先使用：

```text
Uint8ClampedArray
Float32Array
Uint16Array
Int16Array
```

建议：

```text
原始 RGBA             Uint8ClampedArray
Edge Map              Float32Array
临时 OKLab 数据        Float32Array
Palette Index Matrix  Int16Array
```

界面层最后再转换成当前：

```ts
PatternCell[]
```

以兼容现有编辑器

---

## 22. 错误与兼容策略

V2 任意阶段发生异常时：

- 不允许生成不完整 Pattern；
- 不允许 `cells.length` 不一致；
- 不允许静默产生越界色号；
- 不允许写入损坏云端作品

老作品必须：

```text
可加载
可编辑
可下载
```

V2 新作品在当前 Schema 不变情况下也必须能被现有服务正常保存

---

## 23. 回滚策略

每个 Phase 必须独立 Commit

建议 Commit：

```text
feat(pattern): establish v1 generation baseline
refactor(pattern): extract standard generation engine
feat(pattern): add area sampling
feat(pattern): add OKLab color matching
feat(pattern): add MARD palette mapping
feat(pattern): add conservative cleanup
feat(pattern): add edge-aware sampling
feat(pattern): optimize pattern palette
feat(pattern): improve bead renderer
```

禁止使用一个无法局部回滚的大 Commit 一次重写全部生成算法

---

## 24. 每个 Phase 的 Codex 固定约束

后续针对本方案开发时，每个 Codex 任务必须包含：

```text
1. 本次只完成指定 Phase
2. 修改前读取 AGENTS.md、docs/development/CODE_RULES.md 和本方案
3. 不提前实现下一 Phase
4. 不修改 Ai 模式
5. 不改变页面跳转
6. 不改变编辑器现有交互
7. 不改变作品云同步协议，除非任务明确要求
8. 不安装新增依赖
9. 优先复用 TypeScript 和微信 Canvas 平台能力
10. 单文件不得超过项目既有文件大小限制
11. 新增 TypeScript 必须类型安全，避免 any
12. 完成后执行 npm run typecheck
13. 有可运行测试时必须运行
14. 输出修改文件清单
15. 输出算法前后差异
16. 输出测试结果
17. 明确说明是否存在兼容性影响
18. 不修改无关代码
19. 如发现方案与真实代码不符，先说明差异，不允许自行扩大范围
```

---

## 25. 明确不属于 Standard V2 第一轮的内容

暂不进入：

```text
AI 图片理解
AI 图生图
AI 主体识别
SAM 分割
人脸 Landmark
OpenCV
TensorFlow
服务器图片处理
付费额度
AI Gateway
AI Provider
复杂 Dithering
自动图片分类
自动审美评分
```

原则：

> 先让免费 Standard Engine 本身成为一套成熟、稳定、可施工的图像算法

AI 模式未来在此基础上增加语义重设计能力，而不是用于补救基础算法

---

## 26. Standard V2 成功标准

### 功能

```text
[ ] 所有支持尺寸可生成
[ ] 所有 colorLimit 可正常生效
[ ] Pattern Matrix 长度始终正确
[ ] 编辑器正常
[ ] 结果页正常
[ ] 材料统计正常
[ ] 下载正常
[ ] 云端保存正常
[ ] 老作品正常加载
```

### 图像质量

```text
[ ] 动漫头像结构明显优于 V1
[ ] 真人照片颜色自然度优于 V1
[ ] 宠物轮廓明显优于 V1
[ ] Logo 不出现明显额外毛刺
[ ] 风景图不出现明显大面积脏色
[ ] 孤立豆数量明显减少
[ ] 真实 MARD 色号可施工
```

### 性能

```text
[ ] 64×64 典型生成 < 500 ms
[ ] 96×96 典型生成 < 1000 ms
[ ] 128×128 典型生成 < 2 s
[ ] 无明显页面卡死
[ ] 无明显内存峰值异常
```

### 工程

```text
[ ] npm run typecheck 通过
[ ] 新增测试通过
[ ] 单阶段 Commit 清晰
[ ] 无无关页面改动
[ ] 无无必要新增依赖
```

---

## 27. 推荐实际实施顺序

```text
Phase 0
建立测试基线
      ↓
Phase 1
无行为变化重构
      ↓
Phase 2
Area Sampling
      ↓
停止开发，完成 A/B
      ↓
Phase 3
OKLab
      ↓
停止开发，完成 A/B
      ↓
Phase 4
MARD 真实 Palette
      ↓
停止开发，完成 A/B
      ↓
Phase 5
Conservative Cleanup
      ↓
停止开发，完成 A/B
      ↓
Phase 6
Edge Protection
      ↓
完整真实用户图片评估
      ↓
Standard V2 Release Candidate
```

如果 Phase 6 已经达到上线标准：

```text
Phase 7 → V2.1
```

Renderer 优化可独立排期

---

## 28. 第一项正式开发任务建议

第一项正式开发任务不要直接做 Area Sampling

应先完成：

```text
Phase 0 + Phase 1
```

即：

1. 建立 Standard V1 基线；
2. 建立固定测试集；
3. 建立输出一致性验证；
4. 把 `image-service.ts` 中生成算法职责安全拆出；
5. 保证拆分前后 Pattern 输出 100% 一致；
6. 不改变任何页面和业务流程

完成这一阶段后，后续每一个图像算法改造才能真正做到：

```text
可测
可比较
可回滚
可定位
```

---

## 29. 后续维护规则

本文件作为 Standard Pattern Engine V2 总设计文档

开发过程中若方案调整：

1. 不直接删除原始设计理由；
2. 在对应 Phase 增加设计变更记录；
3. 说明变更原因；
4. 说明基于什么测试结果改变；
5. 大方向变化更新本文档；
6. 小实现细节记录在 Commit / CHANGELOG

设计文档记录“为什么这样设计”，代码记录“具体如何实现”

---

## 30. 当前状态

```text
Standard V1：已存在
Standard V2 总方案：已确定
Phase 0：待开发
Phase 1：待开发
Phase 2：待开发
Phase 3：待开发
Phase 4：待开发
Phase 5：待开发
Phase 6：待开发
Phase 7：待评估
Phase 8：待评估
AI Fine Mode：不属于当前 Standard V2 开发阶段
```

下一步：

> 根据本文档单独拆解 `Phase 0 + Phase 1` 的 Codex 开发任务，在确认范围后开始第一阶段实施
