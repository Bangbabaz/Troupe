import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readdirSync, realpathSync, statSync } from 'fs'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { parentPort, workerData } from 'worker_threads'
import type { IdeInfo } from '@shared/types'
import type {
  IdeDetectionCandidate,
  IdeDetectionWorkerData,
  IdeDetectionWorkerMessage
} from './ide-detection-types'

const execFileP = promisify(execFile)
const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const data = workerData as IdeDetectionWorkerData

interface RegistryEntry {
  DisplayName?: string
  InstallLocation?: string
  DisplayIcon?: string
  Publisher?: string
}

interface MacApp {
  _name?: string
  path?: string
  version?: string
}

function expandWildcard(path: string): string | null {
  if (!path.includes('*')) return existsSync(path) ? path : null
  const separator = path.includes('\\') ? '\\' : '/'
  const starIndex = path.indexOf('*')
  const segmentStart =
    Math.max(path.lastIndexOf('\\', starIndex), path.lastIndexOf('/', starIndex)) + 1
  const separators = [path.indexOf('\\', starIndex), path.indexOf('/', starIndex)].filter(
    (index) => index >= 0
  )
  const segmentEnd = separators.length ? Math.min(...separators) : path.length
  const parent = path.slice(0, Math.max(0, segmentStart - 1))
  const pattern = path.slice(segmentStart, segmentEnd)
  const remainder = path.slice(segmentEnd)
  const wildcardIndex = pattern.indexOf('*')
  const prefix = pattern.slice(0, wildcardIndex)
  const suffix = pattern.slice(wildcardIndex + 1)
  if (!existsSync(parent)) return null

  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return null
  }
  const matches = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix))
    .sort()
  for (let index = matches.length - 1; index >= 0; index--) {
    const resolved = expandWildcard(parent + separator + matches[index] + remainder)
    if (resolved) return resolved
  }
  return null
}

async function findInPath(binary: string): Promise<string | null> {
  try {
    const command = isWindows ? 'where' : 'which'
    const { stdout } = await execFileP(command, [binary], { timeout: 2000, windowsHide: true })
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (!lines.length) return null
    if (!isWindows) return lines[0]

    const runnable = lines.find((line) => /\.(exe|cmd|bat|com)$/i.test(line))
    if (runnable) return runnable
    for (const candidate of lines) {
      for (const extension of ['.cmd', '.exe', '.bat', '.com']) {
        if (existsSync(candidate + extension)) return candidate + extension
      }
    }
    return null
  } catch {
    return null
  }
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

async function readWindowsRegistry(): Promise<RegistryEntry[]> {
  if (!isWindows) return []
  if (data.shellRuntime.kind === 'powershell') {
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
        data.shellRuntime.executable,
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
      )
      const raw = stdout.trim()
      if (raw) {
        const parsed = JSON.parse(raw) as RegistryEntry | RegistryEntry[]
        return Array.isArray(parsed) ? parsed : [parsed]
      }
    } catch {
      // Fall through to the shell-free registry reader.
    }
  }
  return readWindowsRegistryWithReg()
}

function cleanDisplayIcon(raw: string | undefined): string | null {
  if (!raw) return null
  let path = raw.trim().replace(/^"+|"+$/g, '')
  const commaIndex = path.lastIndexOf(',')
  if (commaIndex > 0 && /^-?\d+$/.test(path.slice(commaIndex + 1).trim())) {
    path = path.slice(0, commaIndex)
  }
  return existsSync(path) ? path : null
}

function resolveRegistryHit(entry: RegistryEntry, candidate: IdeDetectionCandidate): string | null {
  const name = (entry.DisplayName || '').trim()
  if (!name || !candidate.registryNames?.some((keyword) => name.includes(keyword))) return null

  const install = (entry.InstallLocation || '').replace(/[\\/]+$/, '').trim()
  const tryRelative = (relative: string | undefined): string | null => {
    if (!install || !relative) return null
    const path = join(install, relative.replace(/\//g, '\\'))
    return existsSync(path) ? path : null
  }
  return (
    tryRelative(candidate.launcherRelPath) ||
    tryRelative(candidate.exeRelPath) ||
    cleanDisplayIcon(entry.DisplayIcon)
  )
}

async function readMacApplications(): Promise<MacApp[]> {
  if (!isMac) return []
  try {
    const { stdout } = await execFileP('system_profiler', ['SPApplicationsDataType', '-json'], {
      timeout: 15_000,
      maxBuffer: 32 * 1024 * 1024
    })
    const parsed = JSON.parse(stdout) as { SPApplicationsDataType?: MacApp[] }
    return parsed.SPApplicationsDataType || []
  } catch {
    return []
  }
}

function resolveMacHit(app: MacApp, candidate: IdeDetectionCandidate): string | null {
  const name = app._name || ''
  if (!candidate.macAppNames?.some((keyword) => name.includes(keyword)) || !app.path) return null
  if (candidate.macLauncherRelPath) {
    const launcher = join(app.path, candidate.macLauncherRelPath)
    if (existsSync(launcher)) return launcher
  }
  return app.path
}

function resolveAppBundle(command: string): string | undefined {
  const extract = (path: string): string | undefined => {
    const index = path.indexOf('.app/')
    if (index >= 0) {
      const bundle = path.slice(0, index + 4)
      return existsSync(bundle) ? bundle : undefined
    }
    if (/\.app\/?$/i.test(path)) {
      const bundle = path.replace(/\/$/, '')
      return existsSync(bundle) ? bundle : undefined
    }
    return undefined
  }
  const direct = extract(command)
  if (direct) return direct
  try {
    return extract(realpathSync(command))
  } catch {
    return undefined
  }
}

async function resolveBundleIcon(bundle: string): Promise<string | undefined> {
  for (const key of ['CFBundleIconFile', 'CFBundleIconName']) {
    try {
      const { stdout } = await execFileP('defaults', ['read', join(bundle, 'Contents/Info'), key], {
        timeout: 2000
      })
      let name = stdout.trim().replace(/^"|"$/g, '')
      if (!name) continue
      if (!/\.icns$/i.test(name)) name += '.icns'
      const path = join(bundle, 'Contents/Resources', name)
      if (existsSync(path)) return path
    } catch {
      // Try the next metadata key.
    }
  }

  try {
    const resources = join(bundle, 'Contents/Resources')
    const icons = readdirSync(resources).filter((file) => /\.icns$/i.test(file))
    let best: string | undefined
    let bestSize = -1
    for (const icon of icons) {
      try {
        const size = statSync(join(resources, icon)).size
        if (size > bestSize) {
          best = icon
          bestSize = size
        }
      } catch {
        // Ignore unreadable icon candidates.
      }
    }
    return best ? join(resources, best) : undefined
  } catch {
    return undefined
  }
}

async function extractMacIcon(
  command: string,
  ideId: string,
  applications: MacApp[]
): Promise<string | undefined> {
  let bundle = resolveAppBundle(command)
  if (!bundle) {
    const candidate = data.candidates.find((item) => item.id === ideId)
    const hit = applications.find((application) => {
      const name = application._name || ''
      return candidate?.macAppNames?.some((keyword) => name.includes(keyword))
    })
    if (hit?.path && existsSync(hit.path)) bundle = hit.path
  }
  if (!bundle) return undefined

  const icon = await resolveBundleIcon(bundle)
  if (!icon) return undefined
  const directory = await mkdtemp(join(tmpdir(), 'troupe-icon-'))
  const png = join(directory, 'icon.png')
  try {
    await execFileP('sips', ['-s', 'format', 'png', '-Z', '96', icon, '--out', png], {
      timeout: 5000
    })
    const contents = await readFile(png)
    return `data:image/png;base64,${contents.toString('base64')}`
  } catch {
    return undefined
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

function systemEntries(): IdeInfo[] {
  const folderName = isMac ? '访达' : isWindows ? '资源管理器' : '文件管理器'
  return [
    { id: 'os-terminal', name: '终端', command: '' },
    { id: 'os-folder', name: folderName, command: '' }
  ]
}

async function detectInstalledIdes(): Promise<IdeInfo[]> {
  const [registryEntries, macApplications] = await Promise.all([
    readWindowsRegistry(),
    readMacApplications()
  ])
  const found: IdeInfo[] = []
  const seenIds = new Set<string>()
  const seenPaths = new Set<string>()

  for (const candidate of data.candidates) {
    let path: string | null = null
    for (const binary of candidate.bins) {
      path = await findInPath(binary)
      if (path) break
    }
    if (!path && isWindows) {
      for (const entry of registryEntries) {
        path = resolveRegistryHit(entry, candidate)
        if (path) break
      }
    } else if (!path && isMac) {
      for (const application of macApplications) {
        path = resolveMacHit(application, candidate)
        if (path) break
      }
    }
    if (!path) {
      for (const probe of candidate.extraPaths) {
        path = expandWildcard(probe)
        if (path) break
      }
    }
    if (!path || seenIds.has(candidate.id)) continue
    const pathKey = path.toLowerCase()
    if (seenPaths.has(pathKey)) continue
    seenIds.add(candidate.id)
    seenPaths.add(pathKey)
    found.push({ id: candidate.id, name: candidate.name, command: path })
  }

  found.push(...systemEntries())
  if (isMac) {
    await Promise.all(
      found.map(async (ide) => {
        const command =
          ide.id === 'os-folder'
            ? '/System/Library/CoreServices/Finder.app'
            : ide.id === 'os-terminal'
              ? '/System/Applications/Utilities/Terminal.app'
              : ide.command
        ide.iconDataUrl = await extractMacIcon(command, ide.id, macApplications)
      })
    )
  }
  return found
}

if (!parentPort) throw new Error('IDE detection worker requires a parent port')
const port = parentPort

void detectInstalledIdes()
  .then((ides) => {
    const message: IdeDetectionWorkerMessage = { type: 'result', ides }
    port.postMessage(message)
  })
  .catch((error) => {
    const message: IdeDetectionWorkerMessage = {
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    }
    port.postMessage(message)
  })
