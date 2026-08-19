/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { isProxy, reactive } = require('vue')

function loadTypeScript(relativePath) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const loaded = { exports: {} }
  new Function('exports', 'module', compiled)(loaded.exports, loaded)
  return loaded.exports
}

const { toPlainPaneDirectoryTaskSelections } = loadTypeScript(
  'src/renderer/src/utils/taskSelectionSettings.ts'
)

const selections = reactive({
  'pane-one': { 'e:/project/one': 'task-one' },
  'pane-two': { 'e:/project/two': 'task-two' }
})

assert.equal(isProxy(selections), true)
assert.equal(isProxy(selections['pane-one']), true)
assert.throws(() => structuredClone({ paneDirectorySelectedTaskIds: { ...selections } }))

const plainSelections = toPlainPaneDirectoryTaskSelections(selections)
assert.equal(isProxy(plainSelections), false)
assert.equal(isProxy(plainSelections['pane-one']), false)
assert.deepEqual(structuredClone(plainSelections), {
  'pane-one': { 'e:/project/one': 'task-one' },
  'pane-two': { 'e:/project/two': 'task-two' }
})

selections['pane-one']['e:/project/one'] = 'changed-task'
assert.equal(plainSelections['pane-one']['e:/project/one'], 'task-one')

console.log('task selection settings tests passed')
