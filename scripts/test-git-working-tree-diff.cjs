/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
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

const { getWorkingTreeDiff, getWorkingTreeDiffStats } = loadTypeScript(
  'src/main/git-working-tree-diff.ts'
)

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

function initRepo(cwd) {
  git(cwd, 'init', '--quiet')
  git(cwd, 'config', 'user.name', 'Troupe Test')
  git(cwd, 'config', 'user.email', 'troupe@example.invalid')
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'troupe-git-diff-test-'))
  try {
    const existing = path.join(root, 'existing')
    fs.mkdirSync(existing)
    initRepo(existing)
    fs.writeFileSync(path.join(existing, 'staged.txt'), 'before\n')
    fs.writeFileSync(path.join(existing, 'unstaged.txt'), 'before\n')
    git(existing, 'add', '.')
    git(existing, 'commit', '--quiet', '-m', 'initial')

    fs.writeFileSync(path.join(existing, 'staged.txt'), 'after\n')
    git(existing, 'add', 'staged.txt')
    fs.writeFileSync(path.join(existing, 'unstaged.txt'), 'before\nafter\n')
    fs.writeFileSync(path.join(existing, 'untracked.txt'), 'new\nfile\n')
    fs.writeFileSync(path.join(existing, 'empty.txt'), '')
    fs.writeFileSync(path.join(existing, 'binary.bin'), Buffer.from([0, 1, 2, 3]))

    const statusBefore = git(existing, 'status', '--porcelain=v1')
    const [payload, stats] = await Promise.all([
      getWorkingTreeDiff(existing),
      getWorkingTreeDiffStats(existing)
    ])

    assert.equal(payload.truncated, false)
    assert.match(payload.diff, /a\/staged\.txt b\/staged\.txt/)
    assert.match(payload.diff, /a\/unstaged\.txt b\/unstaged\.txt/)
    assert.match(payload.diff, /a\/untracked\.txt b\/untracked\.txt/)
    assert.match(payload.diff, /a\/empty\.txt b\/empty\.txt/)
    assert.match(payload.diff, /a\/binary\.bin b\/binary\.bin/)
    assert.deepEqual(stats, { files: 5, added: 4, deleted: 1 })
    assert.equal(git(existing, 'status', '--porcelain=v1'), statusBefore)

    const unborn = path.join(root, 'unborn')
    fs.mkdirSync(unborn)
    initRepo(unborn)
    fs.writeFileSync(path.join(unborn, 'first.txt'), 'first\n')

    const unbornPayload = await getWorkingTreeDiff(unborn)
    assert.match(unbornPayload.diff, /a\/first\.txt b\/first\.txt/)
    assert.deepEqual(await getWorkingTreeDiffStats(unborn), {
      files: 1,
      added: 1,
      deleted: 0
    })
    assert.equal(git(unborn, 'status', '--porcelain=v1'), '?? first.txt\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

run()
  .then(() => console.log('git working tree diff tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
