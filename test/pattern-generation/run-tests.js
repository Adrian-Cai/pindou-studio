const { rmSync } = require('node:fs')
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
  ])
} finally {
  rmSync(buildDirectory, { recursive: true, force: true })
}
