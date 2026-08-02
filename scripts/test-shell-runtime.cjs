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
  new Function('require', 'exports', 'module', compiled)(require, loaded.exports, loaded)
  return loaded.exports
}

const {
  classifyShell,
  configureShellRuntime,
  getShellRuntime,
  listAvailableShells,
  resolveShellRuntime,
  shellCommandArgs,
  shellConsoleArgs,
  shellQuoteArgument
} = loadTypeScript('src/main/shell-runtime.ts')

function withExecutables(entries) {
  const calls = []
  return {
    calls,
    locate(command) {
      calls.push(command)
      return entries[command] || null
    }
  }
}

// An explicit user selection takes precedence over environment overrides.
// If it disappears, resolution safely returns to automatic discovery.
{
  const selected = withExecutables({
    '/opt/custom/fish': '/opt/custom/fish',
    '/usr/local/bin/bash': '/usr/local/bin/bash'
  })
  assert.deepEqual(
    resolveShellRuntime(
      'linux',
      { TROUPE_SHELL: '/usr/local/bin/bash' },
      selected.locate,
      '/opt/custom/fish'
    ),
    { executable: '/opt/custom/fish', kind: 'fish' }
  )
  assert.deepEqual(selected.calls, ['/opt/custom/fish'])

  const fallback = withExecutables({ '/bin/bash': '/bin/bash' })
  assert.deepEqual(resolveShellRuntime('linux', {}, fallback.locate, '/missing'), {
    executable: '/bin/bash',
    kind: 'bash'
  })
  assert.deepEqual(fallback.calls, ['/missing', '/bin/bash'])
}

// Windows discovers the PowerShell executable family, not individual
// PowerShell releases. pwsh covers Core 6, 7, and compatible future versions.
{
  const files = withExecutables({
    'pwsh.exe': 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe':
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Windows\\System32\\cmd.exe': 'C:\\Windows\\System32\\cmd.exe'
  })
  assert.deepEqual(
    resolveShellRuntime(
      'win32',
      { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      files.locate
    ),
    { executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', kind: 'powershell' }
  )
  assert.deepEqual(files.calls, ['pwsh.exe'])
}

// Windows PowerShell is the second choice when pwsh is absent.
{
  const legacy = 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  const files = withExecutables({ [legacy]: legacy })
  assert.deepEqual(resolveShellRuntime('win32', { WINDIR: 'D:\\Windows' }, files.locate), {
    executable: legacy,
    kind: 'powershell'
  })
}

// A Windows installation with only its guaranteed command processor never
// attempts to execute PowerShell syntax and resolves directly to ComSpec.
{
  const cmd = 'C:\\Windows\\System32\\cmd.exe'
  const files = withExecutables({ [cmd]: cmd })
  assert.deepEqual(resolveShellRuntime('win32', { ComSpec: cmd }, files.locate), {
    executable: cmd,
    kind: 'cmd'
  })
  assert.deepEqual(shellCommandArgs({ executable: cmd, kind: 'cmd' }, 'echo ok'), [
    '/d',
    '/s',
    '/c',
    'echo ok'
  ])
}

// macOS and Linux use a valid inherited system shell, then their native
// fallbacks. These tests run on any host because target-platform paths are
// handled explicitly by shell-runtime.ts.
{
  const zsh = withExecutables({ '/opt/homebrew/bin/zsh': '/opt/homebrew/bin/zsh' })
  assert.deepEqual(resolveShellRuntime('darwin', { SHELL: '/opt/homebrew/bin/zsh' }, zsh.locate), {
    executable: '/opt/homebrew/bin/zsh',
    kind: 'zsh'
  })

  const macFallback = withExecutables({ '/bin/zsh': '/bin/zsh' })
  assert.deepEqual(resolveShellRuntime('darwin', { SHELL: '/missing/shell' }, macFallback.locate), {
    executable: '/bin/zsh',
    kind: 'zsh'
  })

  const fish = withExecutables({ '/usr/bin/fish': '/usr/bin/fish' })
  assert.deepEqual(resolveShellRuntime('linux', { SHELL: '/usr/bin/fish' }, fish.locate), {
    executable: '/usr/bin/fish',
    kind: 'fish'
  })

  const linuxFallback = withExecutables({ '/bin/sh': '/bin/sh' })
  assert.deepEqual(resolveShellRuntime('linux', {}, linuxFallback.locate), {
    executable: '/bin/sh',
    kind: 'posix'
  })
}

// Existing environment overrides remain global and are ignored if invalid.
{
  const custom = withExecutables({ '/usr/local/bin/bash': '/usr/local/bin/bash' })
  assert.deepEqual(
    resolveShellRuntime('linux', { TROUPE_SHELL: '/usr/local/bin/bash' }, custom.locate),
    { executable: '/usr/local/bin/bash', kind: 'bash' }
  )

  const fallback = withExecutables({ '/bin/bash': '/bin/bash' })
  assert.deepEqual(
    resolveShellRuntime('linux', { TROUPE_SHELL: '/missing', SHELL: '/missing' }, fallback.locate),
    { executable: '/bin/bash', kind: 'bash' }
  )
}

// Candidate discovery returns installed shell families without enumerating
// product versions or exposing duplicate paths.
{
  const pwsh = 'C:\\Tools\\pwsh.exe'
  const legacy = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  const cmd = 'C:\\Windows\\System32\\cmd.exe'
  const windows = withExecutables({
    'C:\\TOOLS\\PWSH.EXE': pwsh,
    'pwsh.exe': 'c:\\tools\\PWSH.EXE',
    [legacy]: legacy,
    [cmd]: cmd
  })
  assert.deepEqual(
    listAvailableShells(
      'win32',
      {
        TROUPE_SHELL: 'C:\\TOOLS\\PWSH.EXE',
        SystemRoot: 'C:\\Windows',
        ComSpec: cmd
      },
      windows.locate
    ),
    [
      { value: pwsh, label: 'PowerShell', executable: pwsh },
      { value: legacy, label: 'Windows PowerShell', executable: legacy },
      { value: cmd, label: '命令提示符', executable: cmd }
    ]
  )

  const mac = withExecutables({
    '/bin/zsh': '/bin/zsh',
    '/bin/bash': '/bin/bash',
    fish: '/opt/homebrew/bin/fish',
    sh: '/bin/sh'
  })
  assert.deepEqual(listAvailableShells('darwin', { SHELL: '/bin/zsh' }, mac.locate), [
    { value: '/bin/zsh', label: 'Zsh', executable: '/bin/zsh' },
    { value: '/bin/bash', label: 'Bash', executable: '/bin/bash' },
    { value: '/opt/homebrew/bin/fish', label: 'Fish', executable: '/opt/homebrew/bin/fish' },
    { value: '/bin/sh', label: 'Sh', executable: '/bin/sh' }
  ])

  const linux = withExecutables({
    bash: '/usr/bin/bash',
    zsh: '/usr/bin/zsh',
    pwsh: '/usr/bin/pwsh',
    sh: '/usr/bin/sh'
  })
  assert.deepEqual(listAvailableShells('linux', {}, linux.locate), [
    { value: '/usr/bin/bash', label: 'Bash', executable: '/usr/bin/bash' },
    { value: '/usr/bin/zsh', label: 'Zsh', executable: '/usr/bin/zsh' },
    { value: '/usr/bin/pwsh', label: 'PowerShell', executable: '/usr/bin/pwsh' },
    { value: '/usr/bin/sh', label: 'Sh', executable: '/usr/bin/sh' }
  ])
}

// Reconfiguration invalidates the process-wide cache used by terminals,
// tasks, and other shell-backed helpers.
{
  configureShellRuntime('auto')
  const first = getShellRuntime()
  configureShellRuntime(first.executable)
  const second = getShellRuntime()
  assert.deepEqual(second, first)
  assert.notStrictEqual(second, first)
  configureShellRuntime('auto')
}

assert.equal(classifyShell('C:\\Program Files\\PowerShell\\6\\pwsh.exe'), 'powershell')
assert.equal(classifyShell('/opt/microsoft/powershell/7/pwsh'), 'powershell')
assert.equal(classifyShell('/bin/dash'), 'posix')
assert.deepEqual(shellCommandArgs({ executable: '/bin/zsh', kind: 'zsh' }, 'npm test'), [
  '-l',
  '-i',
  '-c',
  'npm test'
])
assert.deepEqual(shellConsoleArgs({ executable: 'pwsh.exe', kind: 'powershell' }), [
  '-NoLogo',
  '-NoExit'
])
assert.equal(
  shellQuoteArgument({ executable: 'powershell.exe', kind: 'powershell' }, "a'b"),
  "'a''b'"
)
assert.equal(shellQuoteArgument({ executable: 'cmd.exe', kind: 'cmd' }, 'a"b'), '"a""b"')
assert.equal(shellQuoteArgument({ executable: '/bin/bash', kind: 'bash' }, "a'b"), "'a'\\''b'")

console.log('shell runtime tests passed')
