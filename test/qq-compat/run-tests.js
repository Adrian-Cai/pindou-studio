const { rmSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const repositoryRoot = path.resolve(__dirname, '..', '..')
const buildDirectory = path.join(repositoryRoot, '.qq-compat-test-build')
const typeScriptCompiler = require.resolve('typescript/bin/tsc')

rmSync(buildDirectory, { recursive: true, force: true })
try {
  const build = spawnSync(process.execPath, [typeScriptCompiler, '--project', path.join(__dirname, 'tsconfig.json')], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  })
  if (build.error) throw build.error
  if (build.status !== 0) process.exit(build.status ?? 1)
  const tests = spawnSync(process.execPath, ['--test', path.join(__dirname, 'qq-compat.test.js')], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  })
  if (tests.error) throw tests.error
  if (tests.status !== 0) process.exit(tests.status ?? 1)
} finally {
  rmSync(buildDirectory, { recursive: true, force: true })
}
