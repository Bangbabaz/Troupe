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

const { decodeGitPath, splitDiffByFile } = loadTypeScript('src/renderer/src/lib/gitDiffFiles.ts')

assert.equal(decodeGitPath(String.raw`\344\270\255\346\226\207.txt`), '中文.txt')
assert.equal(decodeGitPath(String.raw`file \"quote\".txt`), 'file "quote".txt')
assert.equal(decodeGitPath(String.raw`back\\slash.txt`), String.raw`back\slash.txt`)

const diff = [
  'diff --git a/file with space.txt b/file with space.txt',
  '--- a/file with space.txt',
  '+++ b/file with space.txt',
  '@@ -1 +1 @@',
  '-before',
  '+after',
  'diff --git a/old name.txt b/new name.txt',
  'similarity index 100%',
  'rename from old name.txt',
  'rename to new name.txt',
  String.raw`diff --git "a/\344\270\255\346\226\207.txt" "b/\344\270\255\346\226\207.txt"`,
  String.raw`--- "a/\344\270\255\346\226\207.txt"`,
  String.raw`+++ "b/\344\270\255\346\226\207.txt"`,
  '@@ -1 +1 @@',
  '-旧',
  '+新'
].join('\n')

const files = splitDiffByFile(diff)
assert.equal(files.length, 3)
assert.deepEqual(
  files.map(({ path, status, added, deleted }) => ({ path, status, added, deleted })),
  [
    { path: 'file with space.txt', status: 'modified', added: 1, deleted: 1 },
    { path: 'old name.txt → new name.txt', status: 'renamed', added: 0, deleted: 0 },
    { path: '中文.txt', status: 'modified', added: 1, deleted: 1 }
  ]
)

console.log('Git diff file parsing tests passed')
