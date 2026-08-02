import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname, basename } from 'path'
import { app, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { updateSettings } from './settings'
import { getShellRuntime, shellConsoleArgs } from './shell-runtime'
import { buildWindowsBatchLaunch } from './windows-batch-launch'
import type { IdeInfo } from '@shared/types'

export type { IdeInfo }

const execFileP = promisify(execFile)
const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'

interface IdeCandidate {
  id: string
  name: string
  /** Binary names to try on PATH (in priority order). */
  bins: string[]
  /** Extra absolute paths to probe; supports `*` wildcard segments. */
  extraPaths?: () => string[]
  /**
   * Windows registry DisplayName substring(s). The HKLM/HKCU Uninstall sweep
   * collects InstallLocation + DisplayIcon for any
   * entry whose DisplayName contains one of these strings.
   */
  registryNames?: string[]
  /**
   * Subpath under InstallLocation pointing to the preferred launcher (a
   * `.cmd` shim that accepts a folder arg). When this resolves we prefer
   * it over the raw .exe — the shim handles `<launcher> <folder>` cleanly
   * for VS Code-family editors. Forward slashes only; we join with the OS sep.
   */
  launcherRelPath?: string
  /** Fallback when launcherRelPath isn't found: subpath to the GUI .exe. */
  exeRelPath?: string
  /**
   * macOS .app bundle name keywords. system_profiler's `_name` is matched
   * with `includes` (case-sensitive) against any of these — so 'IntelliJ IDEA'
   * picks up both 'IntelliJ IDEA' (Community) and 'IntelliJ IDEA Ultimate'.
   * Same shape as `registryNames` on Windows.
   */
  macAppNames?: string[]
  /** Subpath inside the .app bundle to the CLI launcher (POSIX-style). */
  macLauncherRelPath?: string
}

const home = (): string => app.getPath('home')
const localAppData = (): string => process.env.LOCALAPPDATA || join(home(), 'AppData', 'Local')
const programFiles = (): string => process.env.ProgramFiles || 'C:\\Program Files'
const programFilesX86 = (): string => process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'

function jetbrainsScriptsDir(): string {
  return join(localAppData(), 'JetBrains', 'Toolbox', 'scripts')
}

function jetbrainsToolboxAppsDir(): string {
  return join(localAppData(), 'JetBrains', 'Toolbox', 'apps')
}

/**
 * Expand a path that contains `*` wildcards in one or more segments. Lists
 * the parent dir, filters entries by literal prefix/suffix, sorts lexicogra-
 * phically (proxy for "newest version"), then recurses on the rest. Returns
 * the first concrete path that actually exists, or null.
 */
function expandWildcard(p: string): string | null {
  if (!p.includes('*')) return existsSync(p) ? p : null
  const sep = p.includes('\\') ? '\\' : '/'
  const starIdx = p.indexOf('*')
  const segStart = Math.max(p.lastIndexOf('\\', starIdx), p.lastIndexOf('/', starIdx)) + 1
  const nextBackslash = p.indexOf('\\', starIdx)
  const nextForward = p.indexOf('/', starIdx)
  const seps = [nextBackslash, nextForward].filter((i) => i >= 0)
  const segEnd = seps.length ? Math.min(...seps) : p.length
  const parentDir = p.slice(0, Math.max(0, segStart - 1))
  const segPattern = p.slice(segStart, segEnd)
  const rest = p.slice(segEnd)
  const wildIn = segPattern.indexOf('*')
  const prefix = segPattern.slice(0, wildIn)
  const suffix = segPattern.slice(wildIn + 1)
  if (!existsSync(parentDir)) return null
  let entries: string[]
  try {
    entries = readdirSync(parentDir)
  } catch {
    return null
  }
  const matches = entries.filter((e) => e.startsWith(prefix) && e.endsWith(suffix)).sort()
  for (let i = matches.length - 1; i >= 0; i--) {
    const candidate = parentDir + sep + matches[i] + rest
    const resolved = expandWildcard(candidate)
    if (resolved) return resolved
  }
  return null
}

function candidates(): IdeCandidate[] {
  return [
    {
      id: 'vscode',
      name: 'Visual Studio Code',
      bins: ['code', 'code.cmd'],
      registryNames: ['Visual Studio Code'],
      launcherRelPath: 'bin/code.cmd',
      exeRelPath: 'Code.exe',
      macAppNames: ['Visual Studio Code'],
      macLauncherRelPath: 'Contents/Resources/app/bin/code',
      extraPaths: () =>
        isWindows
          ? [
              join(localAppData(), 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
              join(programFiles(), 'Microsoft VS Code', 'bin', 'code.cmd'),
              join(programFilesX86(), 'Microsoft VS Code', 'bin', 'code.cmd')
            ]
          : []
    },
    {
      id: 'vscode-insiders',
      name: 'VS Code Insiders',
      bins: ['code-insiders', 'code-insiders.cmd'],
      registryNames: ['Visual Studio Code - Insiders', 'Visual Studio Code Insiders'],
      launcherRelPath: 'bin/code-insiders.cmd',
      exeRelPath: 'Code - Insiders.exe',
      macAppNames: ['Visual Studio Code - Insiders'],
      macLauncherRelPath: 'Contents/Resources/app/bin/code',
      extraPaths: () =>
        isWindows
          ? [
              join(
                localAppData(),
                'Programs',
                'Microsoft VS Code Insiders',
                'bin',
                'code-insiders.cmd'
              )
            ]
          : []
    },
    {
      id: 'cursor',
      name: 'Cursor',
      bins: ['cursor', 'cursor.cmd'],
      registryNames: ['Cursor'],
      launcherRelPath: 'resources/app/bin/cursor.cmd',
      exeRelPath: 'Cursor.exe',
      macAppNames: ['Cursor'],
      macLauncherRelPath: 'Contents/Resources/app/bin/cursor',
      extraPaths: () =>
        isWindows
          ? [
              join(localAppData(), 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd'),
              join(localAppData(), 'Programs', 'Cursor', 'resources', 'app', 'bin', 'cursor.cmd')
            ]
          : []
    },
    {
      id: 'trae',
      name: 'Trae',
      bins: ['trae', 'trae.cmd'],
      registryNames: ['Trae'],
      launcherRelPath: 'resources/app/bin/trae.cmd',
      exeRelPath: 'Trae.exe',
      macAppNames: ['Trae'],
      macLauncherRelPath: 'Contents/Resources/app/bin/trae',
      extraPaths: () =>
        isWindows
          ? [
              join(localAppData(), 'Programs', 'Trae', 'resources', 'app', 'bin', 'trae.cmd'),
              join(localAppData(), 'Programs', 'Trae', 'bin', 'trae.cmd')
            ]
          : []
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      bins: ['windsurf', 'windsurf.cmd'],
      registryNames: ['Windsurf'],
      launcherRelPath: 'resources/app/bin/windsurf.cmd',
      exeRelPath: 'Windsurf.exe',
      macAppNames: ['Windsurf'],
      macLauncherRelPath: 'Contents/Resources/app/bin/windsurf',
      extraPaths: () =>
        isWindows
          ? [
              join(
                localAppData(),
                'Programs',
                'Windsurf',
                'resources',
                'app',
                'bin',
                'windsurf.cmd'
              )
            ]
          : []
    },
    jb(
      'idea',
      'IntelliJ IDEA',
      ['IDEA-U', 'IDEA-C', 'IDEA', 'IntelliJ IDEA', 'idea'],
      ['IntelliJ IDEA Ultimate', 'IntelliJ IDEA Community', 'IntelliJ IDEA']
    ),
    jb('webstorm', 'WebStorm', ['WebStorm', 'webstorm'], ['WebStorm']),
    jb(
      'pycharm',
      'PyCharm',
      ['PyCharm-P', 'PyCharm-C', 'PyCharm', 'pycharm'],
      ['PyCharm Professional', 'PyCharm Community', 'PyCharm']
    ),
    jb('goland', 'GoLand', ['GoLand', 'goland'], ['GoLand']),
    jb('clion', 'CLion', ['CLion', 'clion'], ['CLion']),
    jb('rider', 'JetBrains Rider', ['Rider', 'rider'], ['JetBrains Rider', 'Rider']),
    jb('phpstorm', 'PhpStorm', ['PhpStorm', 'phpstorm'], ['PhpStorm']),
    jb('rubymine', 'RubyMine', ['RubyMine', 'rubymine'], ['RubyMine']),
    jb('datagrip', 'DataGrip', ['DataGrip', 'datagrip'], ['DataGrip']),
    jb('fleet', 'JetBrains Fleet', ['Fleet', 'fleet'], ['Fleet', 'JetBrains Fleet']),
    {
      id: 'subl',
      name: 'Sublime Text',
      bins: ['subl', 'subl.exe', 'sublime_text'],
      registryNames: ['Sublime Text'],
      exeRelPath: 'subl.exe',
      macAppNames: ['Sublime Text'],
      macLauncherRelPath: 'Contents/SharedSupport/bin/subl',
      extraPaths: () =>
        isWindows
          ? [
              join(programFiles(), 'Sublime Text', 'subl.exe'),
              join(programFiles(), 'Sublime Text 3', 'subl.exe')
            ]
          : []
    },
    {
      id: 'zed',
      name: 'Zed',
      bins: ['zed'],
      registryNames: ['Zed'],
      macAppNames: ['Zed'],
      macLauncherRelPath: 'Contents/MacOS/cli'
    }
  ]
}

/** Build a JetBrains-flavoured IdeCandidate. */
function jb(
  id: string,
  name: string,
  productNames: string[],
  registryNames: string[]
): IdeCandidate {
  const stem = productNames[productNames.length - 1]
  return {
    id,
    name,
    bins: [stem, `${stem}64.exe`, `${stem}.cmd`, `${stem}.bat`],
    registryNames,
    launcherRelPath: `bin/${stem}64.exe`, // JetBrains InstallLocation already includes \bin\... only for some; we re-search below
    exeRelPath: `bin/${stem}64.exe`,
    // Reuse the same brand-name keyword list for macOS matching — `_name`
    // in system_profiler often differs by edition ("IntelliJ IDEA" vs
    // "IntelliJ IDEA Ultimate"), and the registryNames already cover those
    // variants with their substring-based semantics.
    macAppNames: registryNames,
    // JetBrains macOS apps put the cli under MacOS/<product> (no folder)
    macLauncherRelPath: `Contents/MacOS/${stem}`,
    extraPaths: () => {
      if (!isWindows) return []
      const paths: string[] = []
      // 1) Toolbox shim
      paths.push(join(jetbrainsScriptsDir(), `${stem}.cmd`))
      paths.push(join(jetbrainsScriptsDir(), `${stem}.bat`))
      // 2) Toolbox apps (wildcard channel + version)
      for (const n of productNames) {
        paths.push(join(jetbrainsToolboxAppsDir(), n, 'ch-*', '*', 'bin', `${stem}64.exe`))
        paths.push(join(jetbrainsToolboxAppsDir(), n, 'bin', `${stem}64.exe`))
      }
      // 3) Standalone in LocalAppData\Programs
      for (const n of productNames) {
        paths.push(join(localAppData(), 'Programs', `${n}*`, 'bin', `${stem}64.exe`))
      }
      // 4) Program Files \ JetBrains
      for (const n of productNames) {
        paths.push(join(programFiles(), 'JetBrains', `${n}*`, 'bin', `${stem}64.exe`))
        paths.push(join(programFilesX86(), 'JetBrains', `${n}*`, 'bin', `${stem}64.exe`))
      }
      return paths
    }
  }
}

async function findInPath(bin: string): Promise<string | null> {
  try {
    const which = isWindows ? 'where' : 'which'
    const { stdout } = await execFileP(which, [bin], { timeout: 2000, windowsHide: true })
    const lines = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (!lines.length) return null
    if (isWindows) {
      // VS Code's `bin\` ships TWO files for the launcher: `code` (POSIX
      // shell script — can't be run by CreateProcess) and `code.cmd` (the
      // Windows batch shim — what we want). Other tools (bun/deno/some
      // global npm packages) may also install an extensionless `code` to
      // their own PATH dir which has NO `.cmd` sibling.
      //
      // Strategies in order:
      //   1. Any returned line already has a runnable extension → pick it.
      //   2. Same directory probe: does `<line>.cmd/.exe/.bat/.com` exist?
      //   3. None of the above → return null so the caller's detection loop
      //      moves on to the next `bin` candidate (e.g. `code.cmd`), which
      //      `where` queries with an explicit extension and reliably resolves.
      //
      // Returning `lines[0]` here used to short-circuit the loop with a
      // POSIX shim CreateProcess can't run — the source of the ENOENT.
      const runnable = lines.find((l) => /\.(exe|cmd|bat|com)$/i.test(l))
      if (runnable) return runnable
      for (const cand of lines) {
        for (const ext of ['.cmd', '.exe', '.bat', '.com']) {
          if (existsSync(cand + ext)) return cand + ext
        }
      }
      return null
    }
    return lines[0]
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Windows: registry-based enumeration
// ---------------------------------------------------------------------------

interface RegistryEntry {
  DisplayName?: string
  InstallLocation?: string
  DisplayIcon?: string
  Publisher?: string
}

let registryCache: RegistryEntry[] | null = null

/**
 * Sweep Windows installer registry keys for IDE-like installations. Replaces
 * the `fetch-installed-software` package (stale + extra dep). PowerShell is
 * used when it is the resolved application shell; reg.exe is the shell-free
 * fallback. Both paths hit all three uninstall-key locations:
 *
 *   - HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall          (64-bit, system)
 *   - HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall (32-bit, system)
 *   - HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall          (per-user)
 *
 * JetBrains Toolbox + most modern installers (VS Code, Cursor, …) write to
 * the per-user (HKCU) hive, which the older PATH-only detection misses
 * entirely. The result is cached for the session, refreshable via the
 * toolbar's "重新检测" entry.
 */
async function readWindowsRegistry(): Promise<RegistryEntry[]> {
  if (registryCache) return registryCache
  if (!isWindows) {
    registryCache = []
    return registryCache
  }
  const commandShell = getShellRuntime()
  if (commandShell.kind === 'powershell') {
    const script =
      '$paths = @(' +
      "'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'" +
      '); ' +
      'Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue | ' +
      'Where-Object { $_.DisplayName } | ' +
      'Select-Object DisplayName, InstallLocation, DisplayIcon, Publisher | ' +
      'ConvertTo-Json -Compress'
    try {
      const { stdout } = await execFileP(
        commandShell.executable,
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
      )
      const raw = stdout.trim()
      if (raw) {
        const parsed: RegistryEntry | RegistryEntry[] = JSON.parse(raw)
        registryCache = Array.isArray(parsed) ? parsed : [parsed]
        return registryCache
      }
    } catch {
      // Fall through to reg.exe. It remains available when PowerShell is
      // missing, blocked by policy, or fails to load on a damaged install.
    }
  }

  registryCache = await readWindowsRegistryWithReg()
  return registryCache
}

const WINDOWS_UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
] as const

function parseRegEntries(output: string): RegistryEntry[] {
  const entries: RegistryEntry[] = []
  let current: RegistryEntry | null = null

  const flush = (): void => {
    if (current?.DisplayName) entries.push(current)
    current = null
  }

  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) {
      flush()
      current = {}
      continue
    }
    if (!current) continue
    const match = line.match(
      /^\s+(DisplayName|InstallLocation|DisplayIcon|Publisher)\s+REG_\w+\s*(.*)$/i
    )
    if (!match) continue
    const key = match[1] as keyof RegistryEntry
    current[key] = match[2].trim()
  }
  flush()
  return entries
}

async function readWindowsRegistryWithReg(): Promise<RegistryEntry[]> {
  const outputs = await Promise.all(
    WINDOWS_UNINSTALL_KEYS.map(async (key) => {
      try {
        const { stdout } = await execFileP('reg.exe', ['query', key, '/s'], {
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024
        })
        return stdout
      } catch {
        return ''
      }
    })
  )
  return outputs.flatMap(parseRegEntries)
}

/**
 * Given a registry entry, decide which IDE candidate it matches (if any) and
 * resolve a concrete launcher path. Prefer InstallLocation + launcherRelPath
 * (the `.cmd` shim that takes a folder arg), fall back to + exeRelPath, then
 * to the DisplayIcon's exe path itself.
 */
function resolveRegistryHit(entry: RegistryEntry, c: IdeCandidate): string | null {
  const name = (entry.DisplayName || '').trim()
  if (!name) return null
  if (!c.registryNames?.some((k) => name.includes(k))) return null

  const install = (entry.InstallLocation || '').replace(/[\\/]+$/, '').trim()
  const tryRel = (rel: string | undefined): string | null => {
    if (!install || !rel) return null
    const p = join(install, rel.replace(/\//g, '\\'))
    return existsSync(p) ? p : null
  }
  return tryRel(c.launcherRelPath) || tryRel(c.exeRelPath) || cleanDisplayIcon(entry.DisplayIcon)
}

/**
 * `DisplayIcon` can be a bare exe path or `exe,0` (icon index suffix); some
 * installers also wrap it in quotes. Strip the cruft and validate the file
 * actually exists before returning.
 */
function cleanDisplayIcon(raw: string | undefined): string | null {
  if (!raw) return null
  let p = raw.trim().replace(/^"+|"+$/g, '')
  const commaIdx = p.lastIndexOf(',')
  if (commaIdx > 0 && /^-?\d+$/.test(p.slice(commaIdx + 1).trim())) {
    p = p.slice(0, commaIdx)
  }
  return existsSync(p) ? p : null
}

// ---------------------------------------------------------------------------
// macOS: system_profiler-based enumeration
// ---------------------------------------------------------------------------

interface MacApp {
  _name?: string
  path?: string
  version?: string
}

let macAppsCache: MacApp[] | null = null

/**
 * List installed macOS applications via system_profiler. Replaces the
 * `get-mac-apps` package (extra dep wrapping the same one-liner) with one
 * inlined call. system_profiler scans /Applications, /System/Applications,
 * and ~/Applications and returns plist; `-json` gives us structured output
 * directly (10.15+).
 *
 * Result is cached for the session.
 */
async function readMacApplications(): Promise<MacApp[]> {
  if (macAppsCache) return macAppsCache
  if (!isMac) {
    macAppsCache = []
    return macAppsCache
  }
  try {
    const { stdout } = await execFileP('system_profiler', ['SPApplicationsDataType', '-json'], {
      timeout: 15_000,
      maxBuffer: 32 * 1024 * 1024
    })
    const parsed = JSON.parse(stdout) as { SPApplicationsDataType?: MacApp[] }
    macAppsCache = parsed.SPApplicationsDataType || []
  } catch {
    macAppsCache = []
  }
  return macAppsCache
}

function resolveMacHit(app: MacApp, c: IdeCandidate): string | null {
  if (!c.macAppNames?.length) return null
  const name = app._name || ''
  // Substring match so 'IntelliJ IDEA' picks up both Community and Ultimate,
  // 'PyCharm' picks up Community/Professional, etc.
  if (!c.macAppNames.some((k) => name.includes(k))) return null
  const bundle = app.path
  if (!bundle) return null
  // Try the CLI launcher inside the bundle first (so we pass a folder arg
  // properly). Fall back to `open -a <appName>` style elsewhere.
  if (c.macLauncherRelPath) {
    const cli = join(bundle, c.macLauncherRelPath)
    if (existsSync(cli)) return cli
  }
  // Return the bundle path itself — openIde() knows to `open -a` for .app.
  return bundle
}

// ---------------------------------------------------------------------------
// Icon extraction
// ---------------------------------------------------------------------------

/**
 * Resolve the .exe whose icon we should extract. .exe inputs pass through;
 * anything else (.cmd / .bat / extensionless POSIX shim like VS Code's
 * `bin\code`) probes a few well-known layouts:
 *   - VS Code family: `bin\<name>` → `..\<AppName>.exe`
 *   - JetBrains:      `bin\<name>.cmd` → `bin\<name>64.exe`
 * Returns null when no sibling exe exists — the renderer will fall back to
 * its hand-drawn SVG icon table.
 *
 * The empty-extension branch matters because `where code` lists the POSIX
 * shell script (`bin\code`, no extension) before the `bin\code.cmd` shim,
 * and we may have stored the former; without this fix, `getFileIcon` would
 * receive a file Windows treats as an unknown type and return the generic
 * "disk drive" icon, not the VS Code mark.
 */
function exeForShim(shim: string): string | null {
  // Already a .exe — getFileIcon handles it directly.
  if (/\.exe$/i.test(shim)) return shim
  const dir = dirname(shim)
  const stem = basename(shim).replace(/\.(cmd|bat)$/i, '')
  const parent = dirname(dir)
  const stemCap = stem.charAt(0).toUpperCase() + stem.slice(1)
  const candidates2: string[] = [
    join(parent, 'Code.exe'),
    join(parent, 'Code - Insiders.exe'),
    join(parent, 'Cursor.exe'),
    join(parent, 'Trae.exe'),
    join(parent, 'Windsurf.exe'),
    join(parent, `${stemCap}.exe`),
    join(dir, `${stem}64.exe`),
    join(dir, `${stem}.exe`)
  ]
  for (const c of candidates2) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * Parse a `.cmd` / `.bat` shim to extract the actual .exe path it delegates to.
 * Handles two common patterns:
 *   - JetBrains Toolbox: `set "IDE_DIR=C:\..."` + `"%IDE_DIR%\bin\<stem>64.exe"`
 *   - Generic: any `"...\xxx.exe"` reference that exists on disk
 */
function exeFromBatchFile(shim: string): string | null {
  try {
    const content = readFileSync(shim, 'utf-8')
    // JetBrains Toolbox: `set "IDE_DIR=<path>"`
    const dirMatch = content.match(/set\s+"IDE_DIR=([^"\r\n]+)"/i)
    if (dirMatch) {
      const stem = basename(shim).replace(/\.(cmd|bat)$/i, '')
      const exe = join(dirMatch[1], 'bin', `${stem}64.exe`)
      if (existsSync(exe)) return exe
    }
    // Generic: any quoted .exe path that exists
    const exeMatch = content.match(/"([^"\r\n]+\.exe)"/i)
    if (exeMatch && existsSync(exeMatch[1])) return exeMatch[1]
    return null
  } catch {
    return null
  }
}

/**
 * Recover an official batch launcher from a cached direct .exe path. Older
 * cache entries may contain Code.exe because detection used to replace the
 * working bin/code.cmd shim with the GUI executable.
 */
function launcherForExe(executable: string, candidateId: string): string | null {
  const c = candidates().find((c) => c.id === candidateId)
  if (!c?.launcherRelPath || !c.exeRelPath) return null
  if (!/\.(cmd|bat)$/i.test(c.launcherRelPath)) return null

  const normalized = executable.replace(/\//g, '\\')
  const exeRel = c.exeRelPath.replace(/\//g, '\\')
  const suffix = '\\' + exeRel
  if (!normalized.toLowerCase().endsWith(suffix.toLowerCase())) return null

  const root = normalized.slice(0, -suffix.length)
  const launcher = join(root, c.launcherRelPath.replace(/\//g, '\\'))
  return existsSync(launcher) ? launcher : null
}

/**
 * Resolve a launcher path back to the enclosing .app bundle root. Inputs we
 * may see on macOS:
 *   - '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
 *   - '/Applications/Visual Studio Code.app'
 *   - '/opt/homebrew/bin/zed'  (brew shim — no bundle, returns undefined)
 */
async function resolveAppBundle(command: string): Promise<string | undefined> {
  const tryExtract = (p: string): string | undefined => {
    const idx = p.indexOf('.app/')
    if (idx >= 0) {
      const bundle = p.slice(0, idx + 4)
      return existsSync(bundle) ? bundle : undefined
    }
    if (/\.app\/?$/i.test(p)) {
      const bundle = p.replace(/\/$/, '')
      return existsSync(bundle) ? bundle : undefined
    }
    return undefined
  }
  const direct = tryExtract(command)
  if (direct) return direct
  // PATH 上拿到的常是 /usr/local/bin/<cli> 这种 symlink
  // (VSCode/Cursor/Trae/Windsurf/CodeFuse 的 "Install <name> command in PATH"、
  // JetBrains Toolbox 都装在这里),原路径里没有 '.app/' 子串。跟过 realpath
  // 之后才能落进真正的 bundle 内部,再匹配出 bundle 根。
  try {
    const real = realpathSync(command)
    if (real !== command) return tryExtract(real)
  } catch {
    // Broken or inaccessible symlink: keep the direct extraction result.
  }
  return undefined
}

/**
 * macOS icon extraction via out-of-process tools.
 *
 * `app.getFileIcon` on a .app bundle traps a V8 worker thread (EXC_BREAKPOINT)
 * on macOS 26 (Tahoe) — the AppKit/IconServices round-trip is the trigger,
 * not signing or JIT. Anything that pulls those frameworks into our isolate
 * (incl. `nativeImage.createFromPath` on a .icns + resize) risks the same
 * crash. So we keep image work entirely outside our process:
 *
 *   1. `defaults read <Info.plist> CFBundleIconFile`  → icon resource name
 *   2. `sips -s format png -Z 96 <icns> --out <png>`  → decode + resize
 *   3. read the PNG, base64-encode it as a data URL
 *
 * Both tools ship with every macOS. Each invocation is a fresh process so
 * failures stay isolated to the IDE that triggered them.
 */
async function extractIconMac(command: string, ideId?: string): Promise<string | undefined> {
  let bundle = await resolveAppBundle(command)
  // 即便走了 realpath,有些 fork 仍可能落不到标准 bundle(自定义 wrapper / 非
  // 标准启动器布局)。最后兜底:用候选定义里的 macAppNames 在 macAppsCache 里
  // substring 匹配 _name,拿到的 path 就是 system_profiler 报告的 bundle 路径。
  if (!bundle && ideId) {
    const c = candidates().find((cand) => cand.id === ideId)
    if (c?.macAppNames?.length && macAppsCache) {
      const hit = macAppsCache.find((app) => {
        const name = app._name || ''
        return c.macAppNames!.some((k) => name.includes(k))
      })
      if (hit?.path && existsSync(hit.path)) bundle = hit.path
    }
  }
  if (!bundle) return undefined

  const icnsPath = await resolveBundleIcns(bundle)
  if (!icnsPath) return undefined

  // mkdtemp + rm rather than a static name so parallel detect calls (the
  // Promise.all in detectIdes) don't clobber each other.
  const dir = await mkdtemp(join(tmpdir(), 'troupe-icon-'))
  const pngPath = join(dir, 'icon.png')
  try {
    await execFileP('sips', ['-s', 'format', 'png', '-Z', '96', icnsPath, '--out', pngPath], {
      timeout: 5000
    })
    const buf = await readFile(pngPath)
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    return undefined
  } finally {
    // Best-effort cleanup — leftover tmp dirs are reaped by the OS anyway.
    rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 解出 bundle 的主 .icns 路径,按优先级三步走:
 *   1) Info.plist CFBundleIconFile —— 经典 key
 *   2) Info.plist CFBundleIconName —— 走 Asset Catalog 的现代 Electron 应用
 *      (蚂蚁 CodeFuse 等)只有这个 key,defaults read CFBundleIconFile 直接报错
 *   3) 扫 Contents/Resources/*.icns 取文件最大者 —— 主图标通常远大于文档类型图标
 */
async function resolveBundleIcns(bundle: string): Promise<string | undefined> {
  for (const key of ['CFBundleIconFile', 'CFBundleIconName']) {
    try {
      const { stdout } = await execFileP('defaults', ['read', join(bundle, 'Contents/Info'), key], {
        timeout: 2000
      })
      let iconName = stdout.trim().replace(/^"|"$/g, '')
      if (!iconName) continue
      if (!/\.icns$/i.test(iconName)) iconName += '.icns'
      const p = join(bundle, 'Contents/Resources', iconName)
      if (existsSync(p)) return p
    } catch {
      // 这个 key 不存在 / defaults 出错,继续试下一个
    }
  }
  try {
    const resDir = join(bundle, 'Contents/Resources')
    if (!existsSync(resDir)) return undefined
    const icns = readdirSync(resDir).filter((f) => /\.icns$/i.test(f))
    if (!icns.length) return undefined
    let best = icns[0]
    let bestSize = -1
    for (const f of icns) {
      try {
        const s = statSync(join(resDir, f))
        if (s.size > bestSize) {
          bestSize = s.size
          best = f
        }
      } catch {
        // Ignore malformed icon filenames and continue with the best match.
      }
    }
    return join(resDir, best)
  } catch {
    return undefined
  }
}

async function extractIcon(command: string, id?: string): Promise<string | undefined> {
  // Synthetic "open in file manager" entry has no command of its own — point
  // at the platform's actual file-manager binary so we get its real icon
  // (explorer.exe glyph on Windows, Finder mark on macOS) instead of the
  // handwritten folder SVG fallback.
  if (id === 'os-folder') {
    if (isMac) return extractIconMac('/System/Library/CoreServices/Finder.app')
    if (isWindows) {
      const explorer = join(process.env.WINDIR || 'C:\\Windows', 'explorer.exe')
      try {
        const img = await app.getFileIcon(explorer, { size: 'large' })
        if (img.isEmpty()) return undefined
        return img.resize({ width: 48, height: 48, quality: 'best' }).toDataURL()
      } catch {
        return undefined
      }
    }
    return undefined
  }

  if (id === 'os-terminal') {
    if (isMac) return extractIconMac('/System/Applications/Utilities/Terminal.app')
    if (isWindows) {
      const target = windowsCmdPath()
      try {
        const img = await app.getFileIcon(target, { size: 'large' })
        if (img.isEmpty()) return undefined
        return img.resize({ width: 48, height: 48, quality: 'best' }).toDataURL()
      } catch {
        return undefined
      }
    }
    const target = process.env.TERMINAL ? await findInPath(process.env.TERMINAL) : null
    if (!target) return undefined
    try {
      const img = await app.getFileIcon(target, { size: 'large' })
      return img.isEmpty() ? undefined : img.resize({ width: 48, height: 48 }).toDataURL()
    } catch {
      return undefined
    }
  }

  if (isMac) return extractIconMac(command, id)

  try {
    const target = isWindows ? exeForShim(command) || exeFromBatchFile(command) : command
    if (!target || !existsSync(target)) return undefined
    // 'large' gives us 48×48 on Windows — better at 2× DPI than the 32×32
    // 'normal' size used previously. The resize below caps payload size.
    const img = await app.getFileIcon(target, { size: 'large' })
    if (img.isEmpty()) return undefined
    const resized = img.resize({ width: 48, height: 48, quality: 'best' })
    return resized.toDataURL()
  } catch {
    return undefined
  }
}

function windowsCmdPath(): string {
  return join(process.env.WINDIR || 'C:\\Windows', 'System32', 'cmd.exe')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let cache: IdeInfo[] | null = null
let scanning: Promise<IdeInfo[]> | null = null

/**
 * 用 settings 中持久化的上次扫描结果填充 main 的 cache,使第一次 `ide-list` IPC
 * 立即返回 —— 不阻塞 UI 等 system_profiler / 注册表扫描。
 *
 * 设计上**没有**自动预扫(prewarm):mac 上 `system_profiler -json` 首次可能跑
 * 10+ 秒,Windows 也要查询注册表并串行执行大量 PATH 查询。启动期没有
 * 缓存时只返回系统入口;完整扫描仅由用户点击"重新检测"触发。
 */
export function hydrateIdeCache(persisted: IdeInfo[] | undefined | null): void {
  if (cache) return
  if (!persisted || !Array.isArray(persisted) || persisted.length === 0) return
  cache = withSystemEntries(persisted)
}

export async function detectIdes(force = false): Promise<IdeInfo[]> {
  if (!force) {
    cache = withSystemEntries(cache ?? [])
    return cache
  }
  // 用户连续触发刷新时复用同一次扫描，避免重复启动系统查询进程。
  if (scanning) return scanning
  registryCache = null
  macAppsCache = null
  scanning = runDetect().finally(() => {
    scanning = null
  })
  return scanning
}

async function runDetect(): Promise<IdeInfo[]> {
  // Fire both platform-wide enumerations in parallel with PATH lookup so the
  // total wall-clock cost is one platform-wide enumeration, not N.
  const [regEntries, macApps] = await Promise.all([readWindowsRegistry(), readMacApplications()])

  const found: IdeInfo[] = []
  const seenIds = new Set<string>()
  const seenPaths = new Set<string>()

  for (const c of candidates()) {
    let path: string | null = null

    // 1) PATH lookup — cheapest, works for users who deliberately exposed
    //    the launcher (Toolbox "Add to PATH", brew install, manual symlink).
    for (const bin of c.bins) {
      const p = await findInPath(bin)
      if (p) {
        // Keep the vendor launcher. VS Code-family shims configure their CLI
        // environment before invoking Electron and can remain usable when
        // launching the GUI executable directly requires elevation.
        path = p
        break
      }
    }

    // 2) Platform-native enumeration. Catches everything installed via the
    //    OS's package mechanism even when the launcher isn't on PATH.
    if (!path) {
      if (isWindows) {
        for (const e of regEntries) {
          const hit = resolveRegistryHit(e, c)
          if (hit) {
            path = hit
            break
          }
        }
      } else if (isMac) {
        for (const a of macApps) {
          const hit = resolveMacHit(a, c)
          if (hit) {
            path = hit
            break
          }
        }
      }
    }

    // 3) Known install dirs — last-resort hard-coded fallback for the cases
    //    that slipped through the registry sweep (very old installers that
    //    didn't write Uninstall keys, portable installs, …).
    if (!path && c.extraPaths) {
      for (const probe of c.extraPaths()) {
        const expanded = expandWildcard(probe)
        if (expanded) {
          path = expanded
          break
        }
      }
    }

    if (!path) continue
    if (seenIds.has(c.id)) continue
    const key = path.toLowerCase()
    if (seenPaths.has(key)) continue
    seenIds.add(c.id)
    seenPaths.add(key)
    found.push({ id: c.id, name: c.name, command: path })
  }

  // Add the OS file manager BEFORE icon extraction so its icon is fetched in
  // the same parallel batch (Finder.app / explorer.exe). Always last in the
  // list so it doesn't outrank a real editor in the picker's default position.
  found.push(osTerminalEntry(), osFolderEntry())

  // Extract icons in parallel — getFileIcon is async per-target and we don't
  // want N serial round-trips to the OS shell.
  //
  // 重新检测时上一轮已经成功提取的图标可能因瞬时失败(sips 偶发超时、
  // macAppsCache 刚 reset 还没回填、Asset Catalog 巨大 bundle 慢读)被无脑覆盖
  // 成 undefined。snapshot 上一轮的 iconDataUrl,只在本轮真的拿到新图标时才更新,
  // 失败时 fallback 到旧值 —— 只有从未成功过的 ide 才会接受 undefined。
  const prevIcons = new Map((cache || []).map((i) => [i.id, i.iconDataUrl]))
  await Promise.all(
    found.map(async (ide) => {
      const fresh = await extractIcon(ide.command, ide.id)
      ide.iconDataUrl = fresh || prevIcons.get(ide.id)
    })
  )

  cache = found
  // 持久化结果到 settings:下次启动 hydrateIdeCache() 直接命中,UI 第一帧就能
  // 显示真实图标 + 列表,不必等本次 ~15s 的完整重扫(macOS Tahoe 上 system_profiler
  // 首次极慢)。updateSettings 内部已有 250ms debounce flush,频繁触发也安全。
  updateSettings({ cachedIdes: found })
  return found
}

/**
 * Synthetic IDE entry for "open in the OS file manager". `command` stays empty
 * because openIde branches on the id before reaching its launcher resolution;
 * `iconDataUrl` is filled in by extractIcon's os-folder branch (real explorer
 * / Finder mark) rather than left undefined.
 */
function osFolderEntry(): IdeInfo {
  const name =
    process.platform === 'darwin'
      ? '访达'
      : process.platform === 'win32'
        ? '资源管理器'
        : '文件管理器'
  return { id: 'os-folder', name, command: '' }
}

function osTerminalEntry(): IdeInfo {
  return { id: 'os-terminal', name: '终端', command: '' }
}

function withSystemEntries(items: IdeInfo[]): IdeInfo[] {
  const terminal = items.find((item) => item.id === 'os-terminal') ?? osTerminalEntry()
  const folder = items.find((item) => item.id === 'os-folder') ?? osFolderEntry()
  const ordinary = items.filter((item) => item.id !== 'os-terminal' && item.id !== 'os-folder')
  return [...ordinary, terminal, folder]
}

function openSystemTerminal(cwd: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const folder = isWindows ? cwd.replace(/\//g, '\\') : cwd
    let settled = false
    const finish = (result: { success: boolean; error?: string }): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const launch = (cmd: string, args: string[], options: { cwd?: string } = {}): void => {
      const proc = spawn(cmd, args, {
        cwd: options.cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      })
      proc.once('error', (err) => finish({ success: false, error: err.message }))
      proc.once('spawn', () => {
        proc.unref()
        finish({ success: true })
      })
    }

    if (isWindows) {
      const commandShell = getShellRuntime()
      const proc = spawn(commandShell.executable, shellConsoleArgs(commandShell), {
        cwd: folder,
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      })
      proc.once('spawn', () => {
        proc.unref()
        finish({ success: true })
      })
      proc.once('error', (err) => finish({ success: false, error: err.message }))
      return
    }
    if (isMac) {
      launch('open', ['-a', 'Terminal', folder])
      return
    }

    const terminal = process.env.TERMINAL?.trim()
    if (terminal) {
      launch(terminal, [], { cwd: folder })
      return
    }
    launch('x-terminal-emulator', [], { cwd: folder })
  })
}

/**
 * Launch the picked IDE on `cwd`. Windows batch launchers go through the
 * guaranteed system command processor; direct GUI executables stay shell-free.
 * macOS .app bundles go through `open -a` so Finder does the right thing.
 * Detached + stdio 'ignore' so closing Troupe doesn't drag the IDE down.
 */
export function openIde(ideId: string, cwd: string): Promise<{ success: boolean; error?: string }> {
  if (ideId === 'os-terminal') return openSystemTerminal(cwd)
  return new Promise((resolve) => {
    // OS file manager doesn't need spawn — Electron's shell.openPath handles
    // the per-platform open command (explorer.exe / Finder / xdg-open) and
    // returns an empty string on success, an error message on failure.
    if (ideId === 'os-folder') {
      shell
        .openPath(cwd)
        .then((err) => {
          if (err) resolve({ success: false, error: err })
          else resolve({ success: true })
        })
        .catch((err) => {
          resolve({ success: false, error: err instanceof Error ? err.message : String(err) })
        })
      return
    }

    const ide = (cache || []).find((i) => i.id === ideId)
    if (!ide) {
      resolve({ success: false, error: '未找到该 IDE，请刷新检测列表' })
      return
    }
    try {
      const preferredCommand =
        isWindows && /\.exe$/i.test(ide.command)
          ? launcherForExe(ide.command, ideId) || ide.command
          : ide.command

      // Surface the resolved launcher even when it doesn't exist anymore
      // (uninstalled / disk renamed between detection and click). Without
      // this check spawn's ENOENT comes back without context.
      if (!existsSync(preferredCommand)) {
        resolve({
          success: false,
          error: `IDE 启动器不存在：${preferredCommand}\n请点「重新检测」刷新列表`
        })
        return
      }

      const lower = preferredCommand.toLowerCase()
      const isBatch = isWindows && (lower.endsWith('.cmd') || lower.endsWith('.bat'))
      const isMacBundle = isMac && lower.endsWith('.app')

      // Normalise the folder arg's separators to the host's native style.
      // OSC 7 emits POSIX paths even on Windows (`D:/foo/bar`) — most CLIs
      // accept both, but native Windows installers / launchers occasionally
      // mishandle forward slashes, so canonicalise to be safe.
      const folderArg = isWindows ? cwd.replace(/\//g, '\\') : cwd

      let cmd: string
      let args: string[]
      let spawnEnv: NodeJS.ProcessEnv | undefined
      let windowsVerbatimArguments = false
      if (isBatch) {
        const batch = buildWindowsBatchLaunch(windowsCmdPath(), preferredCommand, folderArg)
        cmd = batch.command
        args = batch.args
        spawnEnv = batch.env
        windowsVerbatimArguments = batch.windowsVerbatimArguments
      } else if (isMacBundle) {
        // No CLI shim in the bundle — use `open -a` with the .app path.
        cmd = 'open'
        args = ['-a', ide.command, folderArg]
      } else {
        cmd = preferredCommand
        args = [folderArg]
      }

      // `windowsHide: true` translates to STARTF_USESHOWWINDOW + SW_HIDE in
      // the CreateProcess STARTUPINFO. For *console* helpers (cmd.exe, the
      // batch fallback) that's what we want — hide the flashing cmd window.
      // For *GUI* targets (Code.exe, idea64.exe, …) Electron / many other
      // GUI apps respect STARTUPINFO.nCmdShow and start with the main
      // window hidden, which looks exactly like "click did nothing" — the
      // process runs, single-instance IPC fires, but no visible window ever
      // appears. So only set the flag on the shell-mediated paths.
      const isViaShell = isBatch || cmd === 'open'

      // Dev-mode diagnostic: log what we're actually about to spawn. Visible
      // in the terminal running `yarn dev` — invaluable when "nothing
      // happens" because three layers of stdio:'ignore' hide the real cause.
      // Guarded by is.dev so prod builds stay quiet.
      if (is.dev) console.log('[ide] openIde', { ideId, cmd, args, hideWindow: isViaShell })

      const proc = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: isViaShell,
        env: spawnEnv,
        windowsVerbatimArguments
      })
      if (is.dev) console.log('[ide] spawned pid:', proc.pid)
      // Also log the eventual exit. If Code.exe (or whatever) dies within a
      // few ms it usually means single-instance IPC handed the request to an
      // already-running invisible instance — also a windowsHide artefact.
      if (is.dev) {
        proc.once('exit', (code, signal) => {
          console.log('[ide] proc exited', { pid: proc.pid, code, signal })
        })
      }
      let settled = false
      proc.once('error', (err) => {
        if (settled) return
        settled = true
        // Append the launcher path so the renderer's ElMessage shows the
        // exact path that failed — invaluable when detection picks up an
        // unexpected sibling tool (bun/deno/some `code` shim).
        resolve({ success: false, error: `${err.message}\n路径: ${preferredCommand}` })
      })
      proc.once('spawn', () => {
        if (settled) return
        settled = true
        proc.unref()
        resolve({ success: true })
      })
      // Safety net for the rare Windows configs where neither event fires.
      setTimeout(() => {
        if (!settled) {
          settled = true
          proc.unref()
          resolve({ success: true })
        }
      }, 1000)
    } catch (err) {
      resolve({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
