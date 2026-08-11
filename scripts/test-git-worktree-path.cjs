/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function loadTypeScript(relativePath) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const loaded = { exports: {} }
  new Function('exports', 'require', 'module', compiled)(loaded.exports, require, loaded)
  return loaded.exports
}

const { selectRemovableWorktreePath } = loadTypeScript('src/main/git-worktree-path.ts')
const mainPath = path.resolve('repo')
const featurePath = path.resolve('repo-feature')
const outsidePath = path.resolve('outside')
const worktrees = [
  { path: mainPath, isMain: true },
  { path: featurePath, isMain: false }
]

assert.equal(selectRemovableWorktreePath(worktrees, featurePath), featurePath)
assert.throws(() => selectRemovableWorktreePath(worktrees, mainPath), /不能移除主工作树/)
assert.throws(
  () => selectRemovableWorktreePath(worktrees, path.join(featurePath, '..', 'outside')),
  /不是当前仓库已注册的工作树/
)
assert.throws(
  () => selectRemovableWorktreePath(worktrees, outsidePath),
  /不是当前仓库已注册的工作树/
)

if (process.platform === 'win32' || process.platform === 'darwin') {
  assert.equal(selectRemovableWorktreePath(worktrees, featurePath.toUpperCase()), featurePath)
}

console.log('Git worktree path tests passed')
