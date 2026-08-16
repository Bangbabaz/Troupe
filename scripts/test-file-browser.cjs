/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
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
  new Function('exports', 'module', 'require', compiled)(loaded.exports, loaded, require)
  return loaded.exports
}

const {
  isPathInsideRoot,
  listFileBrowserDirectory,
  parseGitStatusOutput,
  readFileBrowserPreview,
  relativeFileBrowserPath,
  searchFileBrowser,
  shouldNotifyFileChange
} = loadTypeScript('src/main/file-browser.ts')

async function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'troupe-file-browser-test-'))
  const root = path.join(temp, 'workspace')
  const outside = path.join(temp, 'outside')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)

  try {
    fs.mkdirSync(path.join(root, 'src'))
    fs.mkdirSync(path.join(root, '.git'))
    fs.mkdirSync(path.join(root, 'node_modules'))
    fs.writeFileSync(path.join(root, 'README.md'), '# Workspace\n')
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export const value = 1\n')
    fs.writeFileSync(path.join(root, '.git', 'config'), 'hidden')
    fs.writeFileSync(path.join(root, 'node_modules', 'ignored-match.ts'), 'ignored')
    fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([1, 0, 2, 3]))
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside')

    assert.equal(isPathInsideRoot(root, root), true)
    assert.equal(isPathInsideRoot(root, path.join(root, 'src', 'main.ts')), true)
    assert.equal(isPathInsideRoot(root, outside), false)
    assert.equal(shouldNotifyFileChange(null), false)
    assert.equal(shouldNotifyFileChange(''), false)
    assert.equal(shouldNotifyFileChange('.git/index'), false)
    assert.equal(shouldNotifyFileChange('.GIT\\index.lock'), false)
    assert.equal(shouldNotifyFileChange('packages/example/.git/HEAD'), false)
    assert.equal(shouldNotifyFileChange('src/main.ts'), true)

    const rootEntries = await listFileBrowserDirectory(root)
    assert.deepEqual(
      rootEntries.map((entry) => entry.name),
      ['node_modules', 'src', 'binary.bin', 'README.md']
    )
    assert.equal(
      rootEntries.some((entry) => entry.name === '.git'),
      false
    )
    await assert.rejects(() => listFileBrowserDirectory(root, '../outside'), /超出工作区根目录/)

    const results = await searchFileBrowser(root, 'main')
    assert.deepEqual(
      results.map((entry) => entry.relativePath),
      ['src/main.ts']
    )
    assert.deepEqual(await searchFileBrowser(root, 'ignored-match'), [])

    const textPreview = await readFileBrowserPreview(root, 'src/main.ts')
    assert.equal(textPreview.kind, 'text')
    assert.match(textPreview.content, /value = 1/)
    const binaryPreview = await readFileBrowserPreview(root, 'binary.bin')
    assert.equal(binaryPreview.kind, 'binary')
    assert.equal(
      await relativeFileBrowserPath(root, 'README.md', path.join(root, 'src')),
      path.join('..', 'README.md')
    )

    try {
      const link = path.join(root, 'outside-link')
      fs.symlinkSync(outside, link, 'dir')
      const linkedEntry = (await listFileBrowserDirectory(root)).find(
        (entry) => entry.name === 'outside-link'
      )
      assert.equal(linkedEntry?.blocked, true)
      await assert.rejects(
        () => listFileBrowserDirectory(root, 'outside-link'),
        /符号链接指向工作区根目录之外/
      )
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error?.code)) throw error
    }

    const status = parseGitStatusOutput(
      [
        ' M src/main.ts',
        '?? src/new.ts',
        'UU src/conflict.ts',
        'R  src/renamed.ts',
        'src/original.ts',
        ''
      ].join('\0'),
      root,
      root
    )
    assert.equal(status['src/main.ts'], 'modified')
    assert.equal(status['src/new.ts'], 'untracked')
    assert.equal(status['src/conflict.ts'], 'conflict')
    assert.equal(status['src/renamed.ts'], 'renamed')
    assert.equal(status.src, 'conflict')
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

run()
  .then(() => console.log('file browser tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
