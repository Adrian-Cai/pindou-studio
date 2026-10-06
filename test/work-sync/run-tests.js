const { rmSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const repositoryRoot = path.resolve(__dirname, '..', '..')
const buildDirectory = path.join(repositoryRoot, '.work-sync-test-build')
const typeScriptCompiler = require.resolve('typescript/bin/tsc')

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

rmSync(buildDirectory, { recursive: true, force: true })

try {
  run([typeScriptCompiler, '--project', path.join(__dirname, 'tsconfig.json')])
  run(['--test', path.join(__dirname, 'ai-placeholder-sync.test.js')])
  run(['--test', path.join(__dirname, 'original-cover.test.js')])
  run(['--test', path.join(__dirname, 'local-storage-quota.test.js')])
} finally {
  rmSync(buildDirectory, { recursive: true, force: true })
}
