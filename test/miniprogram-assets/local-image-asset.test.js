/**
 * 小程序本地图片资源守卫
 *
 * 职责：静态校验 `miniprogram/` 内「包内静态图片」的可用性，锁住两类只在真机上暴露的事故：
 *   1. `assets/` 下出现 `.webp`。`image` 组件的 `webp` 属性写明「默认不解析 webP 格式，只支持网络资源」，
 *      且它是 WebView 特有属性。开发者工具模拟器是 Chromium、原生支持 webp，所以**工具里一切正常、真机全白**。
 *      v0.16.0 把 5 张本地图转成 webp，首页示例图与「我的」页头像因此空白到 v0.30.15 才还原。
 *   2. 源码引用了不存在的 `/assets/...` 路径。图片改名/挪目录时漏改引用，运行时同样只表现为空白，不报错。
 *
 * 边界：只扫 `miniprogram/` 下 `ts` / `js` / `wxml` / `wxss` / `json` 文件里的**字面量**路径。
 *   data 绑定的动态路径（如 `src="{{item.icon}}"`）与网络地址、云文件 ID 不在本文件校验范围。
 *
 * 调用方：`test/miniprogram-assets/run-tests.js`，CI 的 `Miniprogram Asset Check` 步骤。
 *
 * 关键点：`/assets/...` 的语义根是 `miniprogram/`（小程序根目录），不是仓库根、也不是磁盘根。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const repositoryRoot = path.resolve(__dirname, '..', '..')
const miniprogramRoot = path.join(repositoryRoot, 'miniprogram')

/** 包内静态图片允许的扩展名。要加新格式必须同时确认真机兼容性，不能只看开发者工具。 */
const ALLOWED_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg']

/** 显式禁止的格式：本地 webp 在真机上不会被解码（见文件头说明）。 */
const FORBIDDEN_EXTENSIONS = ['.webp']

/** 需要扫描引用的源码文件类型。 */
const SCANNED_EXTENSIONS = ['.ts', '.js', '.wxml', '.wxss', '.json']

/** 匹配源码里的字面量资源路径，如 `'/assets/icons/a.svg'`、`url("/assets/a.png")`。 */
const ASSET_REFERENCE_PATTERN = /["'(\s](\/assets\/[A-Za-z0-9_\-/]+\.(?:svg|png|jpg|jpeg|gif|webp))/g

function listFiles(directory, collected = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) listFiles(absolutePath, collected)
    else collected.push(absolutePath)
  }
  return collected
}

/** 收集源码里引用到的全部本地资源路径，保持「路径 -> 引用方文件」的映射便于定位。 */
function collectAssetReferences() {
  const references = new Map()
  const sourceFiles = listFiles(miniprogramRoot).filter((file) =>
    SCANNED_EXTENSIONS.includes(path.extname(file).toLowerCase())
  )

  for (const file of sourceFiles) {
    const content = fs.readFileSync(file, 'utf8')
    ASSET_REFERENCE_PATTERN.lastIndex = 0
    let match = ASSET_REFERENCE_PATTERN.exec(content)
    while (match) {
      const assetPath = match[1]
      if (!references.has(assetPath)) references.set(assetPath, [])
      references.get(assetPath).push(path.relative(repositoryRoot, file).split(path.sep).join('/'))
      match = ASSET_REFERENCE_PATTERN.exec(content)
    }
  }

  return references
}

test('包内 assets 不得包含 webp：本地 webp 在真机上不会被解码', () => {
  const assetsRoot = path.join(miniprogramRoot, 'assets')
  assert.ok(fs.existsSync(assetsRoot), '未找到 miniprogram/assets 目录')

  const offenders = listFiles(assetsRoot).filter((file) =>
    FORBIDDEN_EXTENSIONS.includes(path.extname(file).toLowerCase())
  )

  assert.deepEqual(
    offenders.map((file) => path.relative(repositoryRoot, file).split(path.sep).join('/')),
    [],
    '本地图片禁止使用 webp：开发者工具能显示、真机空白。请改用 svg/png/jpg（要省体积就降分辨率）。'
  )
})

test('源码引用的本地图片必须真实存在，且格式在白名单内', () => {
  const references = collectAssetReferences()
  assert.ok(references.size > 0, '未扫描到任何 /assets 引用，检查正则或扫描范围是否失效')

  const missing = []
  const illegalFormat = []

  for (const [assetPath, owners] of references) {
    const relativePath = assetPath.replace(/^\//, '')
    const extension = path.extname(assetPath).toLowerCase()

    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      illegalFormat.push(`${assetPath}（${owners.join(', ')}）`)
    }

    if (!fs.existsSync(path.join(miniprogramRoot, relativePath))) {
      missing.push(`${assetPath}（${owners.join(', ')}）`)
    }
  }

  assert.deepEqual(missing, [], '以下本地图片被引用但文件不存在，真机上只表现为空白')
  assert.deepEqual(illegalFormat, [], `本地图片扩展名必须是 ${ALLOWED_EXTENSIONS.join(' / ')}`)
})
