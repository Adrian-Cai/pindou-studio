# Standard V1 Pattern Generation Baseline

本目录冻结 Standard V1 的当前行为，不评价算法质量，也不包含 Phase 2 之后的图片优化。

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
5. 删除临时编译目录。

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

它调用生产 `createDraft()`，因此覆盖微信真实图片解码、`drawImage()` 缩放和 `getImageData()`。为了不改变产品路由或页面，runner 不会常驻执行。请在微信开发者工具中按下面步骤运行：

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

当前 V1 before baseline 已由微信开发者工具 `2.02.2607271` 实际运行并记录为 `fixtures/wechat-v1-before.json`，Manifest 中 6 项均为 `recorded`。Phase 1 后仍须用同一工具、同一 runner 生成 after 文件并执行严格比较。
