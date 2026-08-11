/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require('node:child_process')
const { readdirSync } = require('node:fs')
const { join } = require('node:path')

const tests = readdirSync(__dirname)
  .filter((name) => /^test-.*\.cjs$/.test(name))
  .sort()

let failed = false
for (const test of tests) {
  console.log(`[test] ${test}`)
  const result = spawnSync(process.execPath, [join(__dirname, test)], { stdio: 'inherit' })
  if (result.status !== 0) failed = true
}

if (failed) process.exitCode = 1
else console.log(`[test] ${tests.length} test files passed`)
