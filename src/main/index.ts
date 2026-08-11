import {
  app,
  shell,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  screen,
  nativeTheme,
  session,
  safeStorage,
  webContents
} from 'electron'
import type { IpcMainInvokeEvent, Rectangle, WebContents } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { execFileSync } from 'child_process'
import { writeFile, mkdir } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  startPty,
  writePty,
  resizePty,
  killPty,
  acknowledgePtyData,
  killAllPtyTrees,
  getCurrentDir,
  getPtyCwd,
  ptyHasRunningProcess,
  getGitInfo,
  getGitBranches,
  getRepoName,
  checkoutGitBranch,
  gitAddWorktree,
  gitHasUncommittedChanges,
  getGitDiffStats,
  gitStash,
  getGitWorktrees,
  gitRemoveWorktree,
  getGitDiff,
  getMergeStatus,
  resolveConflictBySide,
  markConflictResolved,
  getConflictVersions,
  saveConflictResolution,
  abortMergeOp,
  continueMergeOp,
  getFileDiff,
  gitShowFile,
  getCommitLog,
  getCommitDetail,
  gitCommitBranches,
  gitMerge,
  gitRebase,
  gitCreateBranch,
  gitPush,
  gitPull,
  gitDeleteBranch
} from './shell'
import { readSettings, updateSettings, flushSettings } from './settings'
import { readFileSync, existsSync, statSync } from 'fs'
import {
  registerTaskSubscriber,
  loadPersistedTasks,
  listTasks,
  getTaskOutput,
  startTask,
  stopTask,
  restartTask,
  removeTask,
  updateTask,
  createTask,
  writeTask,
  resizeTask,
  killAllTasks,
  removeTasksByCwd
} from './tasks'
import { initAutoUpdater, checkForUpdates, installUpdate } from './updater'
import { detectIdes, openIde, hydrateIdeCache } from './ide'
import {
  registerBrowser,
  unregisterBrowser,
  disposeAllBrowsers,
  getBrowserResourceProxyConfig,
  setBrowserResourceProxyConfig,
  setBrowserResourceProxyOrigin
} from './browser'
import {
  startMcpServers,
  stopMcpServers,
  getBrowserMcpPort,
  getAgentMcpPort,
  getTerminalMcpPort
} from './mcp-server'
import { MCP_ACCESS_TOKEN } from './mcp-config'
import { setSshCommandApprovalHandler, setSshPermissionsChangedHandler } from './ssh-permissions'
import { listAgentSessions } from './agent-sessions'
import { configureShellRuntime, listAvailableShells } from './shell-runtime'
import icon from '../../resources/icon.png?asset'
import type {
  PtyStartOpts,
  Settings,
  WorktreeAddOpts,
  CommitLogOpts,
  SshProfile,
  SshCommandApprovalRequest,
  SshCommandApprovalDecision,
  BrowserResourceProxyConfig
} from '@shared/types'

// macOS 26 (Tahoe) + Electron 39 上,Chromium 的输入法状态机会与 mac IME 频繁
// 不同步,blink.mojom.WidgetHost 每秒抛 100+ 条 `TextInputStateChanged rejected`
// IPC 错误,顶死 mojo pipe 导致 GPU/Network helper 偶发崩重启 —— 表现为启动
// 后输入卡顿、首帧渲染拖慢。下面三个 feature 都和"窗口/焦点状态被 macOS 误判
// 为不可见"链路相关,关掉后错误流消失。必须在 app.whenReady() 之前调用,
// commandLine switches 只在进程启动早期生效。
// 如果将来 Electron 升级修了上游问题(跟踪关键字
// "MacWebContentsOcclusion + TextInputState")可以拆掉这三行。
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,MacWebContentsOcclusion'
)
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

let mainWindow: BrowserWindow | null = null
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

const MIN_WINDOW_WIDTH = 800
const MIN_WINDOW_HEIGHT = 600
const BROWSER_OPEN_GUARD_MS = 1200
const BROWSER_PARTITION = 'persist:troupe-browser'

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

interface BrowserOpenGuard {
  bounds: Rectangle
  expiresAt: number
  token: symbol
  timeout: ReturnType<typeof setTimeout>
}

const browserOpenGuards = new WeakMap<BrowserWindow, BrowserOpenGuard>()

function clearBrowserOpenGuard(win: BrowserWindow): void {
  const guard = browserOpenGuards.get(win)
  if (!guard) return
  clearTimeout(guard.timeout)
  browserOpenGuards.delete(win)
}

function getActiveBrowserOpenGuard(win: BrowserWindow): BrowserOpenGuard | null {
  const guard = browserOpenGuards.get(win)
  if (!guard) return null
  if (Date.now() < guard.expiresAt) return guard
  clearBrowserOpenGuard(win)
  return null
}

function armBrowserOpenGuard(win: BrowserWindow): void {
  if (process.platform !== 'darwin' || win.isDestroyed() || !win.isNormal()) return

  clearBrowserOpenGuard(win)
  const token = Symbol('browser-open-guard')
  const timeout = setTimeout(() => {
    if (browserOpenGuards.get(win)?.token === token) browserOpenGuards.delete(win)
  }, BROWSER_OPEN_GUARD_MS)
  const guard: BrowserOpenGuard = {
    bounds: win.getBounds(),
    expiresAt: Date.now() + BROWSER_OPEN_GUARD_MS,
    token,
    timeout
  }
  browserOpenGuards.set(win, guard)
}

function visibleApprovalText(value: string): string {
  return Array.from(value, (char) => {
    const code = char.codePointAt(0) || 0
    const unsafe =
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    return unsafe ? `\\u${code.toString(16).padStart(4, '0')}` : char
  }).join('')
}

async function openExternalUrl(value: string): Promise<boolean> {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    await shell.openExternal(url.toString())
    return true
  } catch {
    return false
  }
}

function isTrustedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      const devUrl = new URL(process.env['ELECTRON_RENDERER_URL'])
      return url.origin === devUrl.origin
    }
    url.hash = ''
    url.search = ''
    return url.toString() === pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
  } catch {
    return false
  }
}

function isTrustedMainRenderer(contents: WebContents): boolean {
  return (
    !!mainWindow &&
    !mainWindow.isDestroyed() &&
    contents.id === mainWindow.webContents.id &&
    isTrustedRendererUrl(contents.getURL())
  )
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedMainRenderer(event.sender)) throw new Error('拒绝来自非主窗口的 IPC 请求')
}

function mcpEndpointUrl(port: number, transport: 'sse' | 'http'): string {
  const url = new URL(`http://127.0.0.1:${port}/${transport === 'sse' ? 'sse' : 'mcp'}`)
  url.searchParams.set('auth', MCP_ACCESS_TOKEN)
  return url.toString()
}

function clampBoundsToDisplay(b: { x?: number; y?: number; width: number; height: number }): {
  x?: number
  y?: number
  width: number
  height: number
} {
  // If a saved position lands off-screen (display unplugged, resolution change),
  // drop x/y so Electron centers the window on the primary display.
  if (b.x === undefined || b.y === undefined) return b
  const displays = screen.getAllDisplays()
  const onScreen = displays.some((d) => {
    const a = d.workArea
    return b.x! >= a.x && b.y! >= a.y && b.x! < a.x + a.width && b.y! < a.y + a.height
  })
  return onScreen ? b : { width: b.width, height: b.height }
}

function createWindow(): void {
  const settings = readSettings()
  const bounds = clampBoundsToDisplay(settings.windowBounds ?? { width: 1100, height: 720 })

  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    title: 'Troupe',
    autoHideMenuBar: true,
    // macOS gets the system traffic-light buttons; win/linux gets our custom
    // HTML buttons rendered in App.vue.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  win.on('ready-to-show', () => {
    if (settings.windowMaximized) win.maximize()
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    void openExternalUrl(details.url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url)) return
    event.preventDefault()
    void openExternalUrl(url)
  })

  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (params.partition !== BROWSER_PARTITION) {
      event.preventDefault()
      return
    }
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
  })

  // PTY cleanup happens via webContents.once('destroyed') inside startPty —
  // don't touch mainWindow on 'closed' (the BrowserWindow is already destroyed
  // and accessing .webContents throws "Object has been destroyed").

  // HMR for renderer base on electron-vite cli.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Persist window state. Resize/move fire continuously during drag — settings
  // module debounces, so this is safe.
  const persistBounds = (): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return
    const b = win.getBounds()
    updateSettings({ windowBounds: b })
  }
  win.on('will-resize', (event) => {
    if (getActiveBrowserOpenGuard(win)) event.preventDefault()
  })
  win.on('will-move', (event) => {
    if (getActiveBrowserOpenGuard(win)) event.preventDefault()
  })
  win.on('resize', persistBounds)
  win.on('move', persistBounds)
  win.on('maximize', () => {
    const guard = getActiveBrowserOpenGuard(win)
    if (guard) {
      const { bounds } = guard
      clearBrowserOpenGuard(win)
      win.unmaximize()
      win.setBounds(bounds)
      return
    }
    updateSettings({ windowMaximized: true })
    win.webContents.send('window-state-changed', true)
  })
  win.on('unmaximize', () => {
    updateSettings({ windowMaximized: false })
    win.webContents.send('window-state-changed', false)
  })

  mainWindow = win

  // 初始化自动更新。必须在 mainWindow 赋值后调用,updater 需要向
  // renderer 发送状态事件。开发模式下自动跳过。
  initAutoUpdater(win)
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  configureShellRuntime(readSettings().shell)
  electronApp.setAppUserModelId('com.troupe.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 允许 renderer 调用 navigator.clipboard.readText / writeText(粘贴等系统快捷键)。
  // Electron
  //     默认拒绝 'clipboard-read' / 'clipboard-sanitized-write',readText() 抛错
  //     被空 catch 吞掉,表现为 Cmd/Ctrl+V 无反应。
  // 其它权限请求(notifications、geolocation 等)一律拒绝。
  const allowedPermissions = new Set(['clipboard-read', 'clipboard-sanitized-write'])
  const isAllowedMainPermission = (contents: WebContents | null, permission: string): boolean =>
    !!contents && isTrustedMainRenderer(contents) && allowedPermissions.has(permission)
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(isAllowedMainPermission(contents, permission))
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission) =>
    isAllowedMainPermission(contents, permission)
  )

  const browserSession = session.fromPartition(BROWSER_PARTITION)
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  browserSession.setPermissionCheckHandler(() => false)

  // 用上次扫描的 IDE 列表填充 main 的内存 cache,让首个 IdeLauncher mount 时
  // ide-list IPC 直接返回缓存,不必等检测 worker 完整扫描(mac 上 system_profiler
  // 首次可能耗时 10+ 秒)。
  // 必须在注册 `ide-list` ipcMain.handle 之前调用。
  hydrateIdeCache(readSettings().cachedIdes)

  setSshCommandApprovalHandler(
    async (request: SshCommandApprovalRequest): Promise<SshCommandApprovalDecision> => {
      const options = {
        type: 'warning' as const,
        title: request.dangerous ? '危险 SSH 命令审批' : 'SSH 命令审批',
        message: request.dangerous ? 'Agent 请求执行危险 SSH 命令' : 'Agent 请求执行 SSH 命令',
        detail: [
          `来源目录：${visibleApprovalText(request.sourceDirectory)}`,
          `SSH 目标：${visibleApprovalText(request.sshLabel)}`,
          request.reason ? `执行原因：${visibleApprovalText(request.reason)}` : '执行原因：未提供',
          request.dangerous
            ? `风险提示：${visibleApprovalText(request.riskReason || '检测到高风险操作')}`
            : '风险提示：未检测到高风险操作',
          '',
          '完整命令：',
          visibleApprovalText(request.command),
          '',
          request.dangerous
            ? '危险命令即使已开启目录授权，仍会逐次确认。'
            : '“始终允许低风险命令”仅对当前来源目录生效；危险命令仍会逐次确认。'
        ].join('\n'),
        buttons: ['仅本次允许', '始终允许低风险命令', '拒绝'],
        defaultId: 2,
        cancelId: 2,
        noLink: true
      }
      const result =
        mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showMessageBox(mainWindow, options)
          : await dialog.showMessageBox(options)
      if (result.response === 0) return 'allow_once'
      if (result.response === 1) return 'always_allow'
      return 'deny'
    }
  )
  setSshPermissionsChangedHandler(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('ssh-permissions-updated')
    }
  })

  // 启动内置 MCP server —— 浏览器、Agent 协作和终端控制使用独立端点。
  startMcpServers()

  // ----- IPC handlers ------------------------------------------------------
  //
  // 通道命名约定:
  //   - sys-*    系统信息(cwd / platform / app version)
  //   - git-*    git 操作和查询(全部带前缀,无 get- 双前缀)
  //   - pty-*    PTY 终端会话
  //   - task-*   后台任务
  //   - settings-* / theme-* / win-* / ide-*    各自模块名空间
  //   - 其它独立 channel:select-directory / path-exists / read-package-scripts
  //
  // 之前 git 相关 channel 混用了 `get-git-*` 与 `git-*` 两种前缀,统一改为 git-*。
  ipcMain.handle('sys-cwd', () => getCurrentDir())
  ipcMain.handle('sys-platform', () => process.platform)
  ipcMain.handle('sys-app-version', () => app.getVersion())
  ipcMain.handle('sys-open-external', (_event, url: string) => openExternalUrl(url))
  ipcMain.handle('agent-sessions-list', () => listAgentSessions())
  ipcMain.handle('git-info', (_event, cwd: string) => getGitInfo(cwd))
  ipcMain.handle('git-branches', (_event, cwd: string) => getGitBranches(cwd))
  ipcMain.handle('git-repo-name', (_event, cwd: string) => getRepoName(cwd))
  ipcMain.handle('git-diff-stats', (_event, cwd: string) => getGitDiffStats(cwd))
  ipcMain.handle('git-has-changes', (_event, cwd: string) => gitHasUncommittedChanges(cwd))

  ipcMain.handle(
    'git-checkout',
    (_event, cwd: string, branchName: string, isRemote?: boolean, remoteName?: string) => {
      return checkoutGitBranch(cwd, branchName, isRemote, remoteName)
    }
  )

  ipcMain.handle('git-stash', (_event, cwd: string) => gitStash(cwd))
  ipcMain.handle('git-worktrees', (_event, cwd: string) => getGitWorktrees(cwd))
  ipcMain.handle(
    'git-worktree-remove',
    async (event, cwd: string, worktreePath: string, force?: boolean) => {
      assertTrustedIpcSender(event)
      const result = await gitRemoveWorktree(cwd, worktreePath, force)
      if (result.success) {
        // 删除工作树后同步清理该目录下的后台任务
        removeTasksByCwd(worktreePath).catch(() => {})
      }
      return result
    }
  )
  ipcMain.handle('git-diff', (_event, cwd: string) => getGitDiff(cwd))

  // Merge / rebase / cherry-pick / revert conflict state
  ipcMain.handle('git-merge-status', (_event, cwd: string) => getMergeStatus(cwd))
  ipcMain.handle(
    'git-conflict-resolve',
    (_event, cwd: string, file: string, side: 'ours' | 'theirs') =>
      resolveConflictBySide(cwd, file, side)
  )
  ipcMain.handle('git-conflict-mark-resolved', (_event, cwd: string, file: string) =>
    markConflictResolved(cwd, file)
  )
  ipcMain.handle('git-conflict-versions', (_event, cwd: string, file: string) =>
    getConflictVersions(cwd, file)
  )
  ipcMain.handle('git-conflict-save', (_event, cwd: string, file: string, content: string) =>
    saveConflictResolution(cwd, file, content)
  )
  ipcMain.handle(
    'git-merge-abort',
    (_event, cwd: string, kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert') =>
      abortMergeOp(cwd, kind)
  )
  ipcMain.handle(
    'git-merge-continue',
    (_event, cwd: string, kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert') =>
      continueMergeOp(cwd, kind)
  )
  ipcMain.handle('git-file-diff', (_event, cwd: string, file: string) => getFileDiff(cwd, file))
  ipcMain.handle('git-show-file', (_event, cwd: string, ref: string | null, path: string) =>
    gitShowFile(cwd, ref, path)
  )

  // Commit history
  ipcMain.handle('git-log', (_event, cwd: string, opts: CommitLogOpts) =>
    getCommitLog(cwd, opts || {})
  )
  ipcMain.handle('git-commit-detail', (_event, cwd: string, hash: string) =>
    getCommitDetail(cwd, hash)
  )
  ipcMain.handle('git-commit-branches', (_event, cwd: string, hashes: string[]) =>
    gitCommitBranches(cwd, hashes)
  )

  // Branch operations (from the branch context menu)
  ipcMain.handle('git-merge', (_event, cwd: string, ref: string) => gitMerge(cwd, ref))
  ipcMain.handle('git-rebase', (_event, cwd: string, ref: string) => gitRebase(cwd, ref))
  ipcMain.handle('git-branch-create', (_event, cwd: string, name: string, startRef: string) =>
    gitCreateBranch(cwd, name, startRef)
  )
  ipcMain.handle('git-push', (_event, cwd: string, branch: string) => gitPush(cwd, branch))
  ipcMain.handle('git-pull', (_event, cwd: string) => gitPull(cwd))
  ipcMain.handle('git-branch-delete', (_event, cwd: string, branch: string, force?: boolean) =>
    gitDeleteBranch(cwd, branch, force)
  )

  ipcMain.handle('git-worktree-add', (_event, cwd: string, opts: WorktreeAddOpts) => {
    return gitAddWorktree(cwd, opts)
  })

  // 读取剪贴板中的图片。
  //
  // 优先级：
  // 1. 文件引用（Finder/资源管理器复制图片文件）→ 直接返回原始路径
  // 2. 位图数据（截图等）→ 落盘为临时 PNG
  //
  // Electron 原生 clipboard.readImage() 可直接读取 NSPasteboard (macOS) /
  // CF_DIB (Windows) 中的位图,不受 navigator.clipboard 只能读文本的限制。
  // 但 macOS Finder 复制文件时剪贴板存的是 file reference URL
  // (file:///.file/id=...)，readImage() 拿到的是 Finder 生成的类型图标而非
  // 文件内容 —— 所以必须优先走文件路径检测。
  const IMG_EXTS = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'bmp',
    'webp',
    'svg',
    'tiff',
    'ico',
    'heic',
    'heif'
  ])

  ipcMain.handle('clipboard-read-image', async (): Promise<string | null> => {
    // ── macOS: 文件引用 URL ──────────────────────────────────────────
    if (process.platform === 'darwin') {
      try {
        const fileUrl = clipboard.read('public.file-url') as string | null
        if (fileUrl && typeof fileUrl === 'string' && fileUrl.startsWith('file://')) {
          // file:///.file/id=... 是不透明的 macOS file reference URL,需要用
          // osascript 通过 Foundation 解析为真实 POSIX 路径。
          const realPath = execFileSync(
            'osascript',
            ['-e', `get POSIX path of (POSIX file "${fileUrl}")`],
            { encoding: 'utf8', timeout: 3000 }
          ).trim()
          if (realPath && existsSync(realPath)) {
            const ext = realPath.split('.').pop()?.toLowerCase()
            if (ext && IMG_EXTS.has(ext)) return realPath
          }
        }
      } catch {
        // osascript 解析失败或文件不存在,fallthrough 到 readImage
      }
    }

    // ── Windows: CF_HDROP ────────────────────────────────────────────
    if (process.platform === 'win32') {
      try {
        const buf = clipboard.readBuffer('FileNameW')
        if (buf && buf.length > 0) {
          // FileNameW / CF_HDROP: DROPFILES 头部的 pFiles (DWORD, offset 0)
          // 指向文件列表起始偏移。列表是 UTF-16LE null-terminated 字符串,
          // 以双 null 结尾。
          const pFiles = buf.readUInt32LE(0)
          let pos = pFiles
          const paths: string[] = []
          while (pos < buf.length - 1) {
            let end = pos
            while (end < buf.length - 1 && !(buf[end] === 0 && buf[end + 1] === 0)) {
              end += 2
            }
            if (end > pos) {
              paths.push(buf.toString('utf16le', pos, end))
            }
            pos = end + 2
            // 双 null 表示列表结束
            if (pos >= buf.length - 1 || (buf[pos] === 0 && buf[pos + 1] === 0)) break
          }
          for (const p of paths) {
            if (existsSync(p)) {
              const ext = p.split('.').pop()?.toLowerCase()
              if (ext && IMG_EXTS.has(ext)) return p
            }
          }
        }
      } catch {
        // 剪贴板不含 FileNameW 数据,fallthrough 到 readImage
      }
    }

    // ── 位图（截图等）─────────────────────────────────────────────────
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    // macOS 截图进剪贴板是 PNG;Windows 截图一般是 BMP/PNG,统一写 PNG。
    const png = img.toPNG()
    if (!png || png.length === 0) return null
    const dir = join(tmpdir(), 'troupe-paste')
    await mkdir(dir, { recursive: true })
    const name = `troupe-paste-${Date.now()}-${randomBytes(4).toString('hex')}.png`
    const filePath = join(dir, name)
    await writeFile(filePath, png)
    return filePath
  })

  ipcMain.handle('select-directory', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.on('win-minimize', () => mainWindow?.minimize())
  ipcMain.on('win-maximize', () => {
    if (!mainWindow) return
    clearBrowserOpenGuard(mainWindow)
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipcMain.on('win-close', () => mainWindow?.close())
  ipcMain.handle('win-is-maximized', () => mainWindow?.isMaximized() ?? false)

  // Settings IPC
  ipcMain.handle('settings-get', () => readSettings())
  ipcMain.handle('shell-list', () => listAvailableShells())
  ipcMain.handle('settings-set-now', (_event, patch: Partial<Settings>) => {
    updateSettings(patch)
    if (Object.prototype.hasOwnProperty.call(patch, 'shell')) {
      configureShellRuntime(patch.shell)
    }
    flushSettings()
  })
  ipcMain.on('settings-set', (_event, patch: Partial<Settings>) => {
    updateSettings(patch)
    if (Object.prototype.hasOwnProperty.call(patch, 'shell')) {
      configureShellRuntime(patch.shell)
    }
  })

  const sanitizeSshProfile = (profile: SshProfile): SshProfile => ({
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    remoteCwd: profile.remoteCwd,
    hasPassword: !!profile.passwordSecret
  })

  const encryptSshPassword = (password: string): string => {
    if (safeStorage.isEncryptionAvailable()) {
      return `safe:${safeStorage.encryptString(password).toString('base64')}`
    }
    return `plain:${Buffer.from(password, 'utf8').toString('base64')}`
  }

  const normalizeSshProfile = (profile: SshProfile, existing?: SshProfile): SshProfile => {
    const password = typeof profile.password === 'string' ? profile.password : ''
    return {
      id: String(profile.id || `ssh-${Date.now().toString(36)}`),
      name: String(profile.name || profile.host || 'SSH'),
      host: String(profile.host || '').trim(),
      port: Math.max(1, Math.min(65535, Math.round(Number(profile.port) || 22))),
      username: String(profile.username || '').trim(),
      remoteCwd: profile.remoteCwd ? String(profile.remoteCwd).trim() : undefined,
      passwordSecret: password ? encryptSshPassword(password) : existing?.passwordSecret
    }
  }

  ipcMain.handle('ssh-profiles-list', (): SshProfile[] =>
    (readSettings().sshProfiles || []).map(sanitizeSshProfile)
  )
  ipcMain.handle('ssh-profile-save', (_event, profile: SshProfile): SshProfile => {
    const profiles = readSettings().sshProfiles || []
    const incomingId = String(profile.id || '')
    const existing = profiles.findIndex((item) => item.id === incomingId)
    const next = normalizeSshProfile(profile, existing >= 0 ? profiles[existing] : undefined)
    if (!next.host) throw new Error('SSH host 不能为空')
    if (!next.username) throw new Error('SSH username 不能为空')
    const updated =
      existing >= 0
        ? profiles.map((item, index) => (index === existing ? next : item))
        : [...profiles, next]
    const previous = existing >= 0 ? profiles[existing] : undefined
    const targetChanged =
      !!previous &&
      (previous.host !== next.host ||
        previous.port !== next.port ||
        previous.username !== next.username ||
        previous.remoteCwd !== next.remoteCwd)
    updateSettings({
      sshProfiles: updated,
      ...(targetChanged
        ? {
            sshCommandPermissions: (readSettings().sshCommandPermissions || []).filter(
              (rule) => rule.sshProfileId !== next.id
            )
          }
        : {})
    })
    flushSettings()
    return sanitizeSshProfile(next)
  })
  ipcMain.handle('ssh-profile-delete', (_event, profileId: string): void => {
    const profiles = readSettings().sshProfiles || []
    updateSettings({
      sshProfiles: profiles.filter((item) => item.id !== profileId),
      sshCommandPermissions: (readSettings().sshCommandPermissions || []).filter(
        (rule) => rule.sshProfileId !== profileId
      )
    })
    flushSettings()
  })

  // Theme IPC. The renderer owns the CSS-token swap; nativeTheme is the source
  // of truth for "follow system" (and keeps native chrome — dialogs, scrollbars
  // — consistent with the chosen theme).
  const applyThemeSource = (src: unknown): void => {
    nativeTheme.themeSource = src === 'dark' || src === 'light' ? src : 'system'
  }
  applyThemeSource(readSettings().theme)
  ipcMain.on('theme-set-source', (_event, src: 'system' | 'dark' | 'light') => {
    applyThemeSource(src)
  })
  ipcMain.handle('theme-should-use-dark', () => nativeTheme.shouldUseDarkColors)
  // Fires when the OS appearance changes (only meaningful in 'system' mode).
  nativeTheme.on('updated', () => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send('native-theme-updated', nativeTheme.shouldUseDarkColors)
      }
    }
  })

  ipcMain.handle('pty-start', (event, opts: PtyStartOpts) => {
    startPty(event.sender, opts)
  })

  ipcMain.on('pty-write', (_event, paneId: string, data: string) => {
    writePty(paneId, data)
  })

  ipcMain.on('pty-resize', (_event, paneId: string, cols: number, rows: number) => {
    resizePty(paneId, cols, rows)
  })

  ipcMain.on('pty-data-ack', (_event, paneId: string, sessionId: number, sequence: number) => {
    acknowledgePtyData(paneId, sessionId, sequence)
  })

  ipcMain.on('pty-kill', (_event, paneId: string) => {
    killPty(paneId)
  })

  ipcMain.handle('pty-get-cwd', (_event, paneId: string) => getPtyCwd(paneId))

  ipcMain.handle('pty-has-running-process', (_event, paneId: string) =>
    ptyHasRunningProcess(paneId)
  )

  // Background tasks
  loadPersistedTasks()
  ipcMain.handle('task-subscribe', (event) => {
    registerTaskSubscriber(event.sender)
    return listTasks()
  })
  ipcMain.handle('task-list', () => listTasks())
  ipcMain.handle('task-output', (_event, id: string) => getTaskOutput(id))
  ipcMain.handle(
    'task-start',
    (_event, opts: { id?: string; name?: string; command: string; cwd: string }) => {
      return startTask(opts)
    }
  )
  ipcMain.handle('task-create', (_event, opts: { name?: string; command: string; cwd: string }) => {
    return createTask(opts)
  })
  ipcMain.on('task-input', (_event, id: string, data: string) => writeTask(id, data))
  ipcMain.on('task-resize', (_event, id: string, cols: number, rows: number) =>
    resizeTask(id, cols, rows)
  )
  ipcMain.handle('task-stop', (_event, id: string) => stopTask(id))
  ipcMain.handle('task-restart', (_event, id: string) => restartTask(id))
  ipcMain.handle('task-remove', (_event, id: string) => removeTask(id))
  ipcMain.handle(
    'task-update',
    (_event, id: string, patch: { name?: string; command?: string; cwd?: string }) => {
      return updateTask(id, patch)
    }
  )

  // Read `scripts` from a directory's package.json for one-click task chips.
  ipcMain.handle('path-exists', (_event, p: string): boolean => {
    try {
      return !!p && existsSync(p)
    } catch {
      return false
    }
  })

  // IDE detection + launch. Detection scans PATH + a handful of well-known
  // install dirs; the result is cached for the session unless the renderer
  // explicitly forces a re-scan (e.g. after the user installed something new).
  ipcMain.handle('ide-list', (_event, force?: boolean) => detectIdes(!!force))
  ipcMain.handle('ide-open', (_event, ideId: string, cwd: string) => openIde(ideId, cwd))
  ipcMain.handle('open-folder', (_event, cwd: string) => shell.openPath(cwd).then(() => true))

  ipcMain.handle('update-check', () => checkForUpdates())
  ipcMain.on('update-install', () => installUpdate())

  ipcMain.handle('read-package-scripts', (_event, cwd: string): Record<string, string> => {
    try {
      const path = join(cwd, 'package.json')
      // 防御性大小检查 —— 一个 10 MB 的伪 package.json 不会让 main process 拿
      // 整个文件 readFile + JSON.parse,而是直接当成"无 scripts"返回。realistic
      // package.json 远不及 1 MB,大于阈值的多半是攻击或者垃圾文件。
      const size = statSync(path).size
      if (size > 1024 * 1024) return {}
      const raw = readFileSync(path, 'utf8')
      const pkg = JSON.parse(raw)
      return pkg && typeof pkg.scripts === 'object' ? pkg.scripts : {}
    } catch {
      return {}
    }
  })

  // Browser
  ipcMain.on('browser-will-open', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && win === mainWindow) armBrowserOpenGuard(win)
  })
  ipcMain.handle('browser-register', (event, paneId: string, webContentsId: number) => {
    try {
      assertTrustedIpcSender(event)
      const guest = webContents.fromId(webContentsId)
      if (!guest || guest.hostWebContents?.id !== event.sender.id) {
        throw new Error('只能注册当前主窗口持有的 webview')
      }
      if (guest.session !== browserSession) throw new Error('浏览器 webview 未使用隔离 Session')
      registerBrowser(paneId, webContentsId)
    } catch (e) {
      console.error('[browser] register failed:', e)
      throw e
    }
  })
  ipcMain.handle('browser-unregister', (_event, paneId: string) => {
    unregisterBrowser(paneId)
  })
  ipcMain.handle('browser-resource-proxy-get', (_event, paneId: string) => {
    return getBrowserResourceProxyConfig(paneId)
  })
  ipcMain.handle(
    'browser-resource-proxy-set',
    (_event, paneId: string, config: BrowserResourceProxyConfig) => {
      return setBrowserResourceProxyConfig(paneId, config)
    }
  )
  ipcMain.handle('browser-resource-proxy-origin-set', (_event, paneId: string, url: string) => {
    setBrowserResourceProxyOrigin(paneId, url)
  })
  ipcMain.handle('browser-get-mcp-url', (event, transport: 'sse' | 'http' = 'sse') => {
    assertTrustedIpcSender(event)
    return mcpEndpointUrl(getBrowserMcpPort(), transport)
  })
  ipcMain.handle('agent-get-mcp-url', (event, transport: 'sse' | 'http' = 'sse') => {
    assertTrustedIpcSender(event)
    return mcpEndpointUrl(getAgentMcpPort(), transport)
  })
  ipcMain.handle('terminal-get-mcp-url', (event, transport: 'sse' | 'http' = 'sse') => {
    assertTrustedIpcSender(event)
    return mcpEndpointUrl(getTerminalMcpPort(), transport)
  })

  createWindow()
  // 不在启动期自动 detectIdes。首次无缓存只显示系统入口,完整 IDE 扫描由用户
  // 点击"重新检测"触发,避免系统枚举进程与 PTY、git 抢资源。

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// before-quit fires synchronously and Electron tears the process down right
// after we return — but killAllTasks is now async (it has to snapshot the
// descendant tree before each pty.kill()). Defer the actual quit until the
// cleanup resolves; without this the process snapshot helper is killed mid-flight
// and detached survivors (Nx workers, dev servers) are left running.
let cleanupDone = false
let cleanupPromise: Promise<void> | null = null

async function runCleanup(): Promise<void> {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      try {
        // 后台任务 + 每个面板的 PTY 子进程树并行清理。仅依赖
        // webContents.once('destroyed') 兜底是不够的 —— before-quit 期间 main
        // 已在收尾,async killPty 没人 await,killProcessTree 起的快照进程
        // snapshot 会被 main 退出打断,detached 的孙子(Nx workers / vite /
        // dev server)随之逃逸。这里两边一起 await 直到全部杀完。
        await Promise.all([killAllTasks(), killAllPtyTrees(), disposeAllBrowsers()])
        stopMcpServers()
      } finally {
        flushSettings()
        cleanupDone = true
      }
    })()
  }
  return cleanupPromise
}

app.on('before-quit', (event) => {
  if (cleanupDone) return
  event.preventDefault()
  runCleanup().then(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    runCleanup().then(() => app.quit())
  }
})
