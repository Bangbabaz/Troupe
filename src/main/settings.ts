import { app } from 'electron'
import { cpSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Settings, TaskDef, SavedLayout } from '@shared/types'

export type { Settings, TaskDef, SavedLayout }

const DEFAULTS: Settings = {
  windowBounds: { width: 1100, height: 720 },
  windowMaximized: false,
  fontSize: 13,
  scrollback: 10000,
  taskOutputCapKB: 4096,
  autoOpenTasksOnRun: true,
  unifiedAgentSessions: false,
  tasksDrawerWidth: 860,
  browserDrawerWidth: 480,
  theme: 'system',
  shell: 'auto',
  autoUpdate: true,
  quickCommands: [],
  sshProfiles: [],
  sshDirectoryPermissions: {},
  sshCommandPermissions: []
}

let cache: Settings | null = null
let writeTimer: NodeJS.Timeout | null = null

const home = app.getPath('home')
const CONFIG_DIR = '.troupe'
const LEGACY_CONFIG_DIRS = ['.Gittim', '.gittim'] as const

// 配置使用固定的用户目录，而不是 Electron userData。这样产品名变化或重装应用时，
// 布局、任务和偏好仍然位于可预测、便于备份的 ~/.troupe/settings.json。
function settingsDir(): string {
  return join(home, CONFIG_DIR)
}

function settingsPath(): string {
  return join(settingsDir(), 'settings.json')
}

/**
 * 将旧版的 ~/.Gittim 或 ~/.gittim 迁移为 ~/.troupe。
 *
 * 枚举 HOME 下的真实目录名，避免 Windows 将两个仅大小写不同的旧目录误判为
 * 同时存在。若新旧目录并存，则将旧配置合并到新目录；旧配置优先，避免升级时
 * 生成的默认值覆盖用户数据。
 */
function migrateLegacyConfigDirs(): void {
  try {
    const dirs = readdirSync(home, { withFileTypes: true })
    const legacyNames = LEGACY_CONFIG_DIRS.filter((name) =>
      dirs.some((entry) => entry.isDirectory() && entry.name === name)
    )
    if (!legacyNames.length) return

    const newPath = join(home, CONFIG_DIR)
    let hasNew = dirs.some((entry) => entry.isDirectory() && entry.name === CONFIG_DIR)

    for (const legacyName of legacyNames) {
      const oldPath = join(home, legacyName)
      if (hasNew) {
        cpSync(oldPath, newPath, { recursive: true, force: true })
        rmSync(oldPath, { recursive: true, force: true })
        console.info(`[Troupe] 已合并并删除旧配置目录: ${oldPath} → ${newPath}`)
        continue
      }

      const tempPath = join(home, `.troupe-migrate-${process.pid}-${Date.now()}`)
      renameSync(oldPath, tempPath)
      try {
        renameSync(tempPath, newPath)
        hasNew = true
      } catch (err) {
        renameSync(tempPath, oldPath)
        throw err
      }
      console.info(`[Troupe] 配置目录已迁移: ${oldPath} → ${newPath}`)
    }
  } catch (err) {
    console.error('[Troupe] 配置目录迁移失败:', err)
  }
}

migrateLegacyConfigDirs()

export function readSettings(): Settings {
  if (cache) return cache
  try {
    const raw = readFileSync(settingsPath(), 'utf8')
    cache = { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache!
}

function flush(): void {
  if (!cache) return
  try {
    mkdirSync(settingsDir(), { recursive: true })
    // 先写临时文件再重命名，避免异常退出留下半截 JSON。
    const tmp = settingsPath() + '.tmp'
    writeFileSync(tmp, JSON.stringify(cache, null, 2))
    renameSync(tmp, settingsPath())
  } catch {
    // 磁盘已满或无写入权限时保留内存状态，本次运行仍可继续。
  }
}

export function updateSettings(patch: Partial<Settings>): void {
  cache = { ...readSettings(), ...patch }
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(flush, 250)
}

export function flushSettings(): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  flush()
}
