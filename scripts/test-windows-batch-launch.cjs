/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')

function loadTypeScript(relativePath) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const loaded = { exports: {} }
  new Function('exports', 'module', compiled)(loaded.exports, loaded)
  return loaded.exports
}

const { buildWindowsBatchLaunch } = loadTypeScript('src/main/windows-batch-launch.ts')

{
  const launch = buildWindowsBatchLaunch(
    'C:\\Windows\\System32\\cmd.exe',
    'D:\\Apps With Spaces\\bin\\editor.cmd',
    'E:\\Work & Tests\\100% ready',
    { PATH: 'test-path' }
  )
  assert.equal(launch.command, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(launch.args, [
    '/d',
    '/v:off',
    '/s',
    '/c',
    '""%TROUPE_IDE_LAUNCHER%" "%TROUPE_IDE_FOLDER%""'
  ])
  assert.equal(launch.env.PATH, 'test-path')
  assert.equal(launch.env.TROUPE_IDE_LAUNCHER, 'D:\\Apps With Spaces\\bin\\editor.cmd')
  assert.equal(launch.env.TROUPE_IDE_FOLDER, 'E:\\Work ^& Tests\\100% ready')
  assert.equal(launch.windowsVerbatimArguments, true)
}

if (process.platform === 'win32') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'troupe batch test '))
  const launcher = path.join(temp, 'test launcher.cmd')
  const folder = 'E:\\Work & Tests\\100% ready ^ now!'
  try {
    fs.writeFileSync(launcher, '@echo off\r\necho [%~1]\r\n')
    const launch = buildWindowsBatchLaunch(
      process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      launcher,
      folder
    )
    const result = spawnSync(launch.command, launch.args, {
      env: launch.env,
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), `[${folder}]`)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

console.log('windows batch launcher tests passed')
