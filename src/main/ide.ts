import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join, dirname, basename } from 'path'
import { app, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { updateSettings } from './settings'
import { findExecutable, getShellRuntime, shellConsoleArgs } from './shell-runtime'
import { buildWindowsBatchLaunch } from './windows-batch-launch'
import { executableFromWindowsBatch } from './windows-batch-executable'
import createIdeDetectionWorker from './ide-detection.worker?nodeWorker'
import type {
  IdeDetectionCandidate,
  IdeDetectionWorkerData,
  IdeDetectionWorkerMessage
} from './ide-detection-types'
import type { IdeInfo } from '@shared/types'

export type { IdeInfo }

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

async function extractIcon(command: string, id?: string): Promise<string | undefined> {
  // Synthetic "open in file manager" entry has no command of its own — point
  // at the platform's actual file-manager binary so we get its real icon
  // (explorer.exe glyph on Windows, Finder mark on macOS) instead of the
  // handwritten folder SVG fallback.
  if (id === 'os-folder') {
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
    const target = process.env.TERMINAL ? findExecutable(process.env.TERMINAL) : null
    if (!target) return undefined
    try {
      const img = await app.getFileIcon(target, { size: 'large' })
      return img.isEmpty() ? undefined : img.resize({ width: 48, height: 48 }).toDataURL()
    } catch {
      return undefined
    }
  }

  if (isMac) return undefined

  try {
    const target = isWindows ? executableFromWindowsBatch(command) || exeForShim(command) : command
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

function serializableCandidates(): IdeDetectionCandidate[] {
  return candidates().map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    bins: candidate.bins,
    extraPaths: candidate.extraPaths?.() ?? [],
    registryNames: candidate.registryNames,
    launcherRelPath: candidate.launcherRelPath,
    exeRelPath: candidate.exeRelPath,
    macAppNames: candidate.macAppNames,
    macLauncherRelPath: candidate.macLauncherRelPath
  }))
}

function scanIdesInWorker(): Promise<IdeInfo[]> {
  const input: IdeDetectionWorkerData = {
    candidates: serializableCandidates(),
    shellRuntime: getShellRuntime()
  }
  const worker = createIdeDetectionWorker({ workerData: input })

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }

    worker.once('message', (message: IdeDetectionWorkerMessage) => {
      if (settled) return
      if (message.type === 'error') {
        fail(new Error(message.error))
        return
      }
      settled = true
      resolve(message.ides)
    })
    worker.once('error', fail)
    worker.once('exit', (code) => {
      if (!settled) {
        fail(new Error(`IDE detection worker exited before returning a result (${code})`))
      }
    })
  })
}

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
  scanning = runDetect().finally(() => {
    scanning = null
  })
  return scanning
}

async function runDetect(): Promise<IdeInfo[]> {
  const found = withSystemEntries(await scanIdesInWorker())
  if (!isMac) {
    // Windows/Linux icon extraction relies on Electron's nativeImage-backed
    // app.getFileIcon API, which is main-process-only. The expensive discovery
    // and all macOS icon conversion stay inside the worker.
    await Promise.all(
      found.map(async (ide) => {
        ide.iconDataUrl = await extractIcon(ide.command, ide.id)
      })
    )
  } else {
    const prevIcons = new Map((cache || []).map((i) => [i.id, i.iconDataUrl]))
    for (const ide of found) ide.iconDataUrl ||= prevIcons.get(ide.id)
  }

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
