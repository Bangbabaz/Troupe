import { accessSync, constants } from 'fs'
import { posix, win32 } from 'path'
import type { ShellOption } from '@shared/types'

export type ShellKind = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'posix' | 'other'

export interface ShellRuntime {
  executable: string
  kind: ShellKind
}

export type ShellEnvironment = Record<string, string | undefined>
export type ExecutableLocator = (command: string) => string | null

function envValue(env: ShellEnvironment, ...names: string[]): string | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  for (const [key, value] of Object.entries(env)) {
    if (wanted.has(key.toLowerCase()) && value?.trim()) return value.trim()
  }
  return undefined
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function executableVariants(
  command: string,
  platform: NodeJS.Platform,
  env: ShellEnvironment
): string[] {
  const pathApi = platform === 'win32' ? win32 : posix
  if (platform !== 'win32' || pathApi.extname(command)) return [command]
  const pathExt = envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD'
  return [
    command,
    ...pathExt
      .split(';')
      .filter(Boolean)
      .map((ext) => command + ext.toLowerCase())
  ]
}

function isRunnable(path: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Locate an executable without invoking a shell. */
export function findExecutable(
  command: string,
  env: ShellEnvironment = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  const value = unquote(command)
  if (!value) return null

  const pathApi = platform === 'win32' ? win32 : posix
  const hasPath = pathApi.isAbsolute(value) || value.includes('/') || value.includes('\\')
  if (hasPath) {
    for (const candidate of executableVariants(value, platform, env)) {
      if (isRunnable(candidate, platform)) return candidate
    }
    return null
  }

  const pathValue = envValue(env, 'PATH') || ''
  for (const rawDir of pathValue.split(pathApi.delimiter)) {
    const dir = unquote(rawDir)
    if (!dir) continue
    for (const name of executableVariants(value, platform, env)) {
      const candidate = pathApi.join(dir, name)
      if (isRunnable(candidate, platform)) return candidate
    }
  }
  return null
}

export function classifyShell(executable: string): ShellKind {
  const name = executable
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '')

  if (name === 'powershell' || name === 'pwsh' || name === 'pwsh-preview') return 'powershell'
  if (name === 'cmd') return 'cmd'
  if (name === 'bash') return 'bash'
  if (name === 'zsh') return 'zsh'
  if (name === 'fish') return 'fish'
  if (name === 'sh' || name === 'dash' || name === 'ash' || name === 'ksh') return 'posix'
  return 'other'
}

function runtime(executable: string): ShellRuntime {
  return { executable, kind: classifyShell(executable) }
}

/**
 * Resolve the one shell used by every shell-backed feature. Discovery itself
 * never runs shell syntax: callers can safely reach the cmd.exe or /bin/sh
 * fallback even when PowerShell or the user's configured shell is absent.
 */
export function resolveShellRuntime(
  platform: NodeJS.Platform = process.platform,
  env: ShellEnvironment = process.env,
  locator: ExecutableLocator = (command) => findExecutable(command, env, platform),
  preference: unknown = 'auto'
): ShellRuntime {
  const explicit = typeof preference === 'string' ? preference.trim() : ''
  if (explicit && explicit !== 'auto') {
    const found = locator(explicit)
    if (found) return runtime(found)
  }

  // Preserve the existing environment override for scripted/portable setups.
  const override = envValue(env, 'TROUPE_SHELL', 'GITTIM_SHELL')
  if (override) {
    const found = locator(override)
    if (found) return runtime(found)
  }

  if (platform === 'win32') {
    // pwsh is the stable executable name for PowerShell Core 6+; no version
    // enumeration is needed. Windows PowerShell and cmd are system fallbacks.
    const core = locator('pwsh.exe')
    if (core) return runtime(core)

    const pathApi = win32
    const windowsDir = envValue(env, 'SystemRoot', 'WINDIR') || 'C:\\Windows'
    const systemPowerShell = pathApi.join(
      windowsDir,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    const legacy = locator(systemPowerShell) || locator('powershell.exe')
    if (legacy) return runtime(legacy)

    const comspec = envValue(env, 'ComSpec') || pathApi.join(windowsDir, 'System32', 'cmd.exe')
    return runtime(locator(comspec) || locator('cmd.exe') || comspec)
  }

  const inherited = envValue(env, 'SHELL')
  if (inherited) {
    const found = locator(inherited)
    if (found) return runtime(found)
  }

  const fallbacks =
    platform === 'darwin' ? ['/bin/zsh', '/bin/bash', '/bin/sh'] : ['/bin/bash', '/bin/sh']
  for (const candidate of fallbacks) {
    const found = locator(candidate)
    if (found) return runtime(found)
  }
  return runtime('/bin/sh')
}

let cachedRuntime: ShellRuntime | null = null
let shellPreference = 'auto'

export function configureShellRuntime(preference?: unknown): void {
  shellPreference = typeof preference === 'string' ? preference.trim() || 'auto' : 'auto'
  cachedRuntime = null
}

export function getShellRuntime(): ShellRuntime {
  cachedRuntime ||= resolveShellRuntime(process.platform, process.env, undefined, shellPreference)
  return cachedRuntime
}

interface ShellCandidateGroup {
  commands: string[]
  label?: string
}

function shellLabel(executable: string, platform: NodeJS.Platform): string {
  const name = executable
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '')

  if (name === 'pwsh-preview') return 'PowerShell Preview'
  if (name === 'pwsh') return 'PowerShell'
  if (name === 'powershell') return platform === 'win32' ? 'Windows PowerShell' : 'PowerShell'
  if (name === 'cmd') return '命令提示符'
  if (name === 'zsh') return 'Zsh'
  if (name === 'bash') return 'Bash'
  if (name === 'fish') return 'Fish'
  if (name === 'sh') return 'Sh'
  return name || executable
}

/** List one installed executable per supported shell family. */
export function listAvailableShells(
  platform: NodeJS.Platform = process.platform,
  env: ShellEnvironment = process.env,
  locator: ExecutableLocator = (command) => findExecutable(command, env, platform)
): ShellOption[] {
  const groups: ShellCandidateGroup[] = []
  const add = (commands: Array<string | undefined>, label?: string): void => {
    const values = commands.filter((command): command is string => !!command?.trim())
    if (values.length) groups.push({ commands: values, label })
  }

  add([envValue(env, 'TROUPE_SHELL', 'GITTIM_SHELL')])

  if (platform === 'win32') {
    const windowsDir = envValue(env, 'SystemRoot', 'WINDIR') || 'C:\\Windows'
    add(['pwsh.exe', 'pwsh'], 'PowerShell')
    add(['pwsh-preview.exe', 'pwsh-preview'], 'PowerShell Preview')
    add(
      [
        win32.join(windowsDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        'powershell.exe',
        'powershell'
      ],
      'Windows PowerShell'
    )
    add(
      [envValue(env, 'ComSpec'), win32.join(windowsDir, 'System32', 'cmd.exe'), 'cmd.exe', 'cmd'],
      '命令提示符'
    )
    add(['bash.exe', 'bash'], 'Bash')
    add(['zsh.exe', 'zsh'], 'Zsh')
    add(['fish.exe', 'fish'], 'Fish')
  } else {
    add([envValue(env, 'SHELL')])
    const common =
      platform === 'darwin'
        ? [
            { commands: ['/bin/zsh', 'zsh', '/usr/bin/zsh'], label: 'Zsh' },
            { commands: ['/bin/bash', 'bash', '/usr/bin/bash'], label: 'Bash' }
          ]
        : [
            { commands: ['bash', '/bin/bash', '/usr/bin/bash'], label: 'Bash' },
            { commands: ['zsh', '/bin/zsh', '/usr/bin/zsh'], label: 'Zsh' }
          ]
    groups.push(...common)
    add(['fish', '/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'], 'Fish')
    add(['pwsh', '/usr/local/bin/pwsh', '/usr/bin/pwsh'], 'PowerShell')
    add(['sh', '/bin/sh', '/usr/bin/sh'], 'Sh')
  }

  const seen = new Set<string>()
  const options: ShellOption[] = []
  for (const group of groups) {
    let executable: string | null = null
    for (const command of group.commands) {
      executable = locator(command)
      if (executable) break
    }
    if (!executable) continue

    const key = platform === 'win32' ? executable.toLowerCase() : executable
    if (seen.has(key)) continue
    seen.add(key)
    options.push({
      value: executable,
      label: group.label || shellLabel(executable, platform),
      executable
    })
  }
  return options
}

/** Build arguments for running a complete command through the resolved shell. */
export function shellCommandArgs(shell: ShellRuntime, command: string): string[] {
  if (shell.kind === 'cmd') return ['/d', '/s', '/c', command]
  if (shell.kind === 'powershell') return ['-NoLogo', '-Command', command]
  if (shell.kind === 'bash' || shell.kind === 'zsh' || shell.kind === 'fish') {
    return ['-l', '-i', '-c', command]
  }
  return ['-c', command]
}

/** Arguments used when opening the resolved shell in its own OS console. */
export function shellConsoleArgs(shell: ShellRuntime): string[] {
  if (shell.kind === 'cmd') return ['/k']
  if (shell.kind === 'powershell') return ['-NoLogo', '-NoExit']
  if (shell.kind === 'bash' || shell.kind === 'zsh' || shell.kind === 'fish') return ['-l']
  return []
}

/** Quote one argument for a command string that will be pasted into the shell. */
export function shellQuoteArgument(shell: ShellRuntime, value: string): string {
  if (shell.kind === 'cmd') return `"${value.replace(/"/g, '""')}"`
  if (shell.kind === 'powershell') return `'${value.replace(/'/g, "''")}'`
  return `'${value.replace(/'/g, `'\\''`)}'`
}
