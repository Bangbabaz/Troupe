/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function loadTypeScript(relativePath) {
  const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(require, module, module.exports)
  return module.exports
}

const { executableFromWindowsBatch, resolveWindowsBatchExecutable } = loadTypeScript(
  'src/main/windows-batch-executable.ts'
)

const currentToolboxTarget = 'D:\\toolbox\\apps\\WebStorm\\bin\\webstorm64.exe'
const currentToolboxScript = `
@echo off
start "" %waitarg% ${currentToolboxTarget} %intellij_args%
`
assert.equal(
  resolveWindowsBatchExecutable(
    currentToolboxScript,
    'webstorm.cmd',
    (candidate) => candidate === currentToolboxTarget
  ),
  currentToolboxTarget
)

const spacedTarget = 'C:\\Program Files\\JetBrains\\WebStorm\\bin\\webstorm64.exe'
assert.equal(
  resolveWindowsBatchExecutable(
    `start "" "${spacedTarget}" %*`,
    'webstorm.cmd',
    (candidate) => candidate === spacedTarget
  ),
  spacedTarget
)

const legacyTarget = 'C:\\JetBrains\\WebStorm\\bin\\webstorm64.exe'
assert.equal(
  resolveWindowsBatchExecutable(
    'set "IDE_DIR=C:\\JetBrains\\WebStorm"\r\n"%IDE_DIR%\\bin\\webstorm64.exe" %*',
    'webstorm.cmd',
    (candidate) => candidate === legacyTarget
  ),
  legacyTarget
)

console.log('windows batch executable tests passed (3 cases)')

if (process.argv[2]) {
  const resolved = executableFromWindowsBatch(process.argv[2])
  assert.ok(resolved, `no executable resolved from ${process.argv[2]}`)
  console.log(`resolved launcher target: ${resolved}`)
}
