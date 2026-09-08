const { existsSync, rmSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const repositoryRoot = path.resolve(__dirname, '..', '..')
const buildDirectory = path.join(repositoryRoot, '.pattern-test-build')
const typeScriptCompiler = require.resolve('typescript/bin/tsc')

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function runOptional(script, fixture) {
  if (!existsSync(path.join(__dirname, 'fixtures', fixture))) {
    console.log(`Skipped ${script}: fixtures/${fixture} is not available.`)
    return
  }
  run(process.execPath, [path.join(__dirname, script)])
}

rmSync(buildDirectory, { recursive: true, force: true })

try {
  run(process.execPath, [
    path.join(__dirname, 'generate-test-assets.js'),
    '--check',
  ])
  run(process.execPath, [
    typeScriptCompiler,
    '--project',
    path.join(__dirname, 'tsconfig.json'),
  ])
  run(process.execPath, [
    '--test',
    path.join(__dirname, 'v1-characterization.test.js'),
    path.join(__dirname, 'phase-2-area-sampling.test.js'),
    path.join(__dirname, 'phase-3-oklab.test.js'),
    path.join(__dirname, 'phase-3-4-color-matching.test.js'),
    path.join(__dirname, 'phase-5-cleanup.test.js'),
    path.join(__dirname, 'phase-6-edge-protection.test.js'),
  ])
  run(process.execPath, [
    path.join(__dirname, 'compare-wechat-phase-2.js'),
  ])
  run(process.execPath, [
    path.join(__dirname, 'compare-wechat-phase-4.js'),
  ])
  runOptional('compare-wechat-phase-3.js', 'wechat-phase-3.json')
  runOptional('compare-wechat-phase-5.js', 'wechat-phase-5.json')
} finally {
  rmSync(buildDirectory, { recursive: true, force: true })
}
