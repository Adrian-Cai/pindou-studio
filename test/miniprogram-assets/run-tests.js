/**
 * 小程序本地图片资源守卫的 runner。
 *
 * 职责：用 node:test 跑 `local-image-asset.test.js`。
 * 边界：纯静态文件扫描，不编译 TypeScript、不依赖 wx 运行时，因此无需 tsconfig / build 目录。
 * 关键点：node 的 `--test` 传目录会被当成模块解析并报 MODULE_NOT_FOUND，必须列举具体文件路径。
 */
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const repositoryRoot = path.resolve(__dirname, '..', '..')

const result = spawnSync(
  process.execPath,
  ['--test', path.join(__dirname, 'local-image-asset.test.js')],
  { cwd: repositoryRoot, stdio: 'inherit' }
)

if (result.error) throw result.error
process.exit(result.status ?? 1)
