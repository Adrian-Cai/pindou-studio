# Standard Pattern Generation Baselines

本目录冻结 Standard V1 行为，并记录 Standard V2 Phase 2 的 4× Area Sampling A/B 结果。

## 自动 Characterization

执行：

```bash
npm run test:pattern
```

脚本只使用 Node.js 内置 `node:test` / `assert` 和项目已有 TypeScript compiler：

1. 校验 6 张程序生成 PNG fixture 未被修改；
2. 将当前小程序 TypeScript 编译到根目录 `.pattern-test-build/`；
3. 用可控 `wx.createOffscreenCanvas` 测试替身调用真实 `createDraft()`；
4. 对比冻结的 Cell、Palette 顺序、ColorCode、Alpha、Crop 和 FNV-1a Hash；
5. 验证 4× Canvas、Linear RGB Area Average、Alpha 加权与透明阈值；
6. 比较真实微信 V1 与 Phase 2 的固定字段及 Matrix 变化；
7. 删除临时编译目录。

测试替身不模拟图片解码或 Canvas 插值。它只让纯算法输入保持稳定，所以不能替代下面的真实微信 Canvas 基线。

## 测试覆盖

- 单色；
- 双色与 Palette/C01/C02 顺序；
- `colorLimit = 1`；
- alpha 31/32 边界；
- 全透明与白色 fallback；
- RGB 最近色距离 tie；
- 最宽通道 R 优先、G 次优；
- Bucket score tie 保留前项；
- `Math.round()` 平均值；
- `00` / `0f` / `10` / `ff` 小写 HEX；
- 横图、竖图、同宽高比、16:9→4:3、4:3→16:9 中心裁剪。

## PNG fixture

图片位于 `miniprogram/test-assets/pattern-generation/`，全部由本仓库脚本生成，无外部版权素材。重新生成命令：

```bash
node test/pattern-generation/generate-test-assets.js
```

普通测试使用 `--check` 只校验内容，不覆盖文件。

## 真实微信 OffscreenCanvas Baseline

真实 Canvas runner 位于：

```text
miniprogram/tests/pattern-generation/wechat-canvas-baseline.ts
```

该 V1 runner 仅保留为 Phase 0/1 历史执行入口。Phase 2 启用后，生产 `createDraft()` 已不再生成 V1 结果，不得重新运行它并覆盖冻结的 `wechat-v1-before.json` / `wechat-v1-after.json`。

Phase 0/1 采集时它通过生产 `createDraft()` 覆盖微信真实图片解码、`drawImage()` 缩放和 `getImageData()`。为了不改变产品路由或页面，runner 不会常驻执行。当时的历史步骤如下：

1. 在 Phase 1 重构前，临时在 `miniprogram/app.ts` 顶部导入：

   ```ts
   import { runWechatCanvasBaseline } from './tests/pattern-generation/wechat-canvas-baseline'
   ```

2. 在 `App({ ... })` 的 `onLaunch()` 末尾临时调用：

   ```ts
   void runWechatCanvasBaseline()
   ```

3. 编译并等待控制台输出 `[Standard V1 WeChat Canvas Baseline]`。runner 也会把完整 JSON 写入：

   ```text
   wx.env.USER_DATA_PATH/standard-v1-wechat-canvas-baseline.json
   ```

4. 保存为 `wechat-v1-before.json`，并删除 `app.ts` 的两处临时代码。
5. Phase 1 完成后重复执行，保存为 `wechat-v1-after.json`。
6. 比较：

   ```bash
   node test/pattern-generation/compare-wechat-baselines.js wechat-v1-before.json wechat-v1-after.json
   ```

比较范围包含 Cell/opaque count、Palette count、matrixHash、paletteHash、图片尺寸和全部设置；`generationTimeMs` 只记录、不作为严格 equality 字段。

`fixtures/v1-baseline-manifest.json` 中 `baselineStatus = pending-wechat-devtools` 表示尚未获得真实微信结果。只有真实运行后才能改成 `recorded` 并填写 Hash；禁止用浏览器 Canvas 或 Node Canvas 结果代填。

当前 V1 before/after baseline 已由微信开发者工具 `2.02.2607271` 实际运行，分别记录为 `fixtures/wechat-v1-before.json` 与 `fixtures/wechat-v1-after.json`。Manifest 中 6 项均为 `recorded`，严格比较结果为 PASS；普通 `npm run test:pattern` 也会持续校验这两份真实微信记录。

## Phase 2 Area Sampling

Phase 2 固定采样行为：

- 中间 Canvas 尺寸为最终网格的 `4×`；
- 每个 Cell 对应一个 `4×4` 区域；
- sRGB 通道先转 Linear RGB，区域平均后再转回 sRGB；
- RGB 使用 Alpha 权重，完全透明像素的隐藏 RGB 不参与颜色平均；
- Cell Alpha 使用 16 个样本的算术平均，之后继续应用生产逻辑现有的 `alpha < 32` 透明阈值；
- Median Cut、RGB nearest、Palette 顺序与 `Cxx` 编号逻辑不在 Phase 2 修改。

纯算法测试位于 `phase-2-area-sampling.test.js`，覆盖常量色、黑白 Linear RGB 平均值 `188`、透明 RGB 隔离、行优先顺序、数据尺寸校验、4× Canvas 参数与 Alpha 31/32 边界。

真实微信 runner 位于：

```text
miniprogram/tests/pattern-generation/wechat-canvas-phase-2.ts
```

运行方式与 V1 runner 相同，但应调用：

```ts
runWechatCanvasPhase2()
```

结果写入：

```text
wx.env.USER_DATA_PATH/standard-v2-phase-2-wechat-canvas-baseline.json
```

本次真实结果已由微信开发者工具 `2.02.2607271` 记录为 `fixtures/wechat-phase-2.json`。执行：

```bash
node test/pattern-generation/compare-wechat-phase-2.js
```

会验证所有业务固定字段，并要求至少一个 Matrix Hash 相比 V1 发生预期变化。当前 6 个案例中 5 个 Matrix 变化，纯色案例保持一致；耗时仅记录，不参与严格相等判断。
