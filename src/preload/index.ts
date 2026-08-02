import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { release } from 'node:os'
import type {
  TaskMeta,
  Settings,
  GitInfo,
  GitResult,
  GitResultWithWarning,
  BranchInfo,
  WorktreeInfo,
  WorktreeAddOpts,
  MergeStatus,
  MergeOpKind,
  ConflictVersions,
  CommitInfo,
  CommitDetail,
  CommitLogOpts,
  DiffPayload,
  DiffStats,
  PtyStartOpts,
  PtyDataPayload,
  PtyExitPayload,
  TaskDataPayload,
  TaskIdPayload,
  TaskOutputSnapshot,
  IdeInfo,
  UpdateStatus,
  AgentSessionInfo,
  SshProfile,
  BrowserResourceProxyConfig
} from '@shared/types'

// API 暴露给 renderer 的桥接对象。每个方法对应 main 里的 ipcMain.handle / send。
// 通道命名见 main/index.ts 顶部注释:
//   sys-* / git-* / pty-* / task-* / settings-* / theme-* / win-* / ide-*
// 之前 git 系列混用 `get-git-*` 与 `git-*`,已统一为 git-*。
const windowsBuild =
  process.platform === 'win32' ? Number.parseInt(release().split('.')[2] ?? '', 10) : undefined

const api = {
  systemInfo: {
    platform: process.platform,
    windowsBuild: Number.isFinite(windowsBuild) ? windowsBuild : undefined
  },
  // ---- 系统信息 -----------------------------------------------------------
  getCwd: () => ipcRenderer.invoke('sys-cwd') as Promise<string>,
  getPlatform: () => ipcRenderer.invoke('sys-platform') as Promise<NodeJS.Platform>,
  getAppVersion: () => ipcRenderer.invoke('sys-app-version') as Promise<string>,
  openExternal: (url: string) => ipcRenderer.invoke('sys-open-external', url) as Promise<boolean>,
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  agentSessionsList: () => ipcRenderer.invoke('agent-sessions-list') as Promise<AgentSessionInfo[]>,

  /** 从剪贴板读取图片(PNG)。无图片时返回 null。 */
  clipboardReadImage: () => ipcRenderer.invoke('clipboard-read-image') as Promise<string | null>,

  // ---- Git ---------------------------------------------------------------
  getGitInfo: (cwd: string) => ipcRenderer.invoke('git-info', cwd) as Promise<GitInfo>,
  getGitBranches: (cwd: string) => ipcRenderer.invoke('git-branches', cwd) as Promise<BranchInfo[]>,
  getRepoName: (cwd: string) => ipcRenderer.invoke('git-repo-name', cwd) as Promise<string | null>,
  getGitDiffStats: (cwd: string) => ipcRenderer.invoke('git-diff-stats', cwd) as Promise<DiffStats>,
  gitHasChanges: (cwd: string) => ipcRenderer.invoke('git-has-changes', cwd) as Promise<boolean>,
  gitCheckout: (cwd: string, branchName: string, isRemote?: boolean, remoteName?: string) =>
    ipcRenderer.invoke('git-checkout', cwd, branchName, isRemote, remoteName) as Promise<GitResult>,
  gitStash: (cwd: string) => ipcRenderer.invoke('git-stash', cwd) as Promise<GitResult>,
  gitWorktrees: (cwd: string) =>
    ipcRenderer.invoke('git-worktrees', cwd) as Promise<WorktreeInfo[]>,
  gitWorktreeRemove: (cwd: string, worktreePath: string, force?: boolean) =>
    ipcRenderer.invoke('git-worktree-remove', cwd, worktreePath, force) as Promise<GitResult>,
  gitDiff: (cwd: string) => ipcRenderer.invoke('git-diff', cwd) as Promise<DiffPayload>,
  gitFileDiff: (cwd: string, file: string) =>
    ipcRenderer.invoke('git-file-diff', cwd, file) as Promise<DiffPayload>,
  gitShowFile: (cwd: string, ref: string | null, path: string) =>
    ipcRenderer.invoke('git-show-file', cwd, ref, path) as Promise<string | null>,
  gitMergeStatus: (cwd: string) =>
    ipcRenderer.invoke('git-merge-status', cwd) as Promise<MergeStatus>,
  gitConflictResolve: (cwd: string, file: string, side: 'ours' | 'theirs') =>
    ipcRenderer.invoke('git-conflict-resolve', cwd, file, side) as Promise<GitResult>,
  gitConflictMarkResolved: (cwd: string, file: string) =>
    ipcRenderer.invoke('git-conflict-mark-resolved', cwd, file) as Promise<GitResult>,
  gitConflictVersions: (cwd: string, file: string) =>
    ipcRenderer.invoke('git-conflict-versions', cwd, file) as Promise<ConflictVersions>,
  gitConflictSave: (cwd: string, file: string, content: string) =>
    ipcRenderer.invoke('git-conflict-save', cwd, file, content) as Promise<GitResult>,
  gitMergeAbort: (cwd: string, kind: MergeOpKind) =>
    ipcRenderer.invoke('git-merge-abort', cwd, kind) as Promise<GitResult>,
  gitMergeContinue: (cwd: string, kind: MergeOpKind) =>
    ipcRenderer.invoke('git-merge-continue', cwd, kind) as Promise<GitResult>,
  gitLog: (cwd: string, opts: CommitLogOpts) =>
    ipcRenderer.invoke('git-log', cwd, opts) as Promise<CommitInfo[]>,
  gitCommitDetail: (cwd: string, hash: string) =>
    ipcRenderer.invoke('git-commit-detail', cwd, hash) as Promise<CommitDetail | null>,
  gitCommitBranches: (cwd: string, hashes: string[]) =>
    ipcRenderer.invoke('git-commit-branches', cwd, hashes) as Promise<Record<string, string[]>>,
  gitMerge: (cwd: string, ref: string) =>
    ipcRenderer.invoke('git-merge', cwd, ref) as Promise<GitResult>,
  gitRebase: (cwd: string, ref: string) =>
    ipcRenderer.invoke('git-rebase', cwd, ref) as Promise<GitResult>,
  gitBranchCreate: (cwd: string, name: string, startRef: string) =>
    ipcRenderer.invoke('git-branch-create', cwd, name, startRef) as Promise<GitResult>,
  gitPush: (cwd: string, branch: string) =>
    ipcRenderer.invoke('git-push', cwd, branch) as Promise<GitResult>,
  gitPull: (cwd: string) => ipcRenderer.invoke('git-pull', cwd) as Promise<GitResult>,
  gitBranchDelete: (cwd: string, branch: string, force?: boolean) =>
    ipcRenderer.invoke('git-branch-delete', cwd, branch, force) as Promise<GitResult>,
  gitWorktreeAdd: (cwd: string, opts: WorktreeAddOpts) =>
    ipcRenderer.invoke('git-worktree-add', cwd, opts) as Promise<GitResultWithWarning>,

  // ---- Window controls / dialogs -----------------------------------------
  selectDirectory: () => ipcRenderer.invoke('select-directory') as Promise<string | null>,
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose: () => ipcRenderer.send('win-close'),
  winIsMaximized: () => ipcRenderer.invoke('win-is-maximized') as Promise<boolean>,
  onWindowStateChanged: (cb: (maximized: boolean) => void) => {
    const listener = (_event: IpcRendererEvent, maximized: boolean): void => cb(maximized)
    ipcRenderer.on('window-state-changed', listener)
    return () => ipcRenderer.removeListener('window-state-changed', listener)
  },

  // ---- Settings + Theme --------------------------------------------------
  settingsGet: () => ipcRenderer.invoke('settings-get') as Promise<Settings>,
  settingsSet: (patch: Partial<Settings>) => ipcRenderer.send('settings-set', patch),
  settingsSetNow: (patch: Partial<Settings>) =>
    ipcRenderer.invoke('settings-set-now', patch) as Promise<void>,
  sshProfilesList: () => ipcRenderer.invoke('ssh-profiles-list') as Promise<SshProfile[]>,
  sshProfileSave: (profile: SshProfile) =>
    ipcRenderer.invoke('ssh-profile-save', profile) as Promise<SshProfile>,
  sshProfileDelete: (profileId: string) =>
    ipcRenderer.invoke('ssh-profile-delete', profileId) as Promise<void>,
  onSshPermissionsUpdated: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('ssh-permissions-updated', listener)
    return () => ipcRenderer.removeListener('ssh-permissions-updated', listener)
  },
  themeSetSource: (src: 'system' | 'dark' | 'light') => ipcRenderer.send('theme-set-source', src),
  themeShouldUseDark: () => ipcRenderer.invoke('theme-should-use-dark') as Promise<boolean>,
  onNativeThemeUpdated: (cb: (shouldUseDark: boolean) => void) => {
    const listener = (_e: IpcRendererEvent, shouldUseDark: boolean): void => cb(shouldUseDark)
    ipcRenderer.on('native-theme-updated', listener)
    return () => ipcRenderer.removeListener('native-theme-updated', listener)
  },

  // ---- PTY ---------------------------------------------------------------
  ptyStart: (opts: PtyStartOpts) => ipcRenderer.invoke('pty-start', opts) as Promise<void>,
  ptyWrite: (paneId: string, data: string) => ipcRenderer.send('pty-write', paneId, data),
  ptyResize: (paneId: string, cols: number, rows: number) =>
    ipcRenderer.send('pty-resize', paneId, cols, rows),
  ptyKill: (paneId: string) => ipcRenderer.send('pty-kill', paneId),
  ptyGetCwd: (paneId: string) =>
    ipcRenderer.invoke('pty-get-cwd', paneId) as Promise<string | null>,
  ptyHasRunningProcess: (paneId: string) =>
    ipcRenderer.invoke('pty-has-running-process', paneId) as Promise<boolean>,
  onPtyData: (paneId: string, cb: (data: string, acknowledge: () => void) => void) => {
    const listener = (_event: IpcRendererEvent, payload: PtyDataPayload): void => {
      if (payload && payload.paneId === paneId) {
        let acknowledged = false
        cb(payload.data, () => {
          if (acknowledged) return
          acknowledged = true
          ipcRenderer.send('pty-data-ack', paneId, payload.sessionId, payload.sequence)
        })
      }
    }
    ipcRenderer.on('pty-data', listener)
    return () => ipcRenderer.removeListener('pty-data', listener)
  },
  onPtyExit: (paneId: string, cb: (exitCode: number) => void) => {
    const listener = (_event: IpcRendererEvent, payload: PtyExitPayload): void => {
      if (payload && payload.paneId === paneId) cb(payload.exitCode)
    }
    ipcRenderer.on('pty-exit', listener)
    return () => ipcRenderer.removeListener('pty-exit', listener)
  },
  onTerminalMcpInput: (
    cb: (payload: { paneId: string; action: 'paste-and-submit'; text: string }) => void
  ) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { paneId: string; action: 'paste-and-submit'; text: string }
    ): void => cb(payload)
    ipcRenderer.on('terminal-mcp-input', listener)
    return () => ipcRenderer.removeListener('terminal-mcp-input', listener)
  },

  // ---- Background tasks --------------------------------------------------
  taskSubscribe: () => ipcRenderer.invoke('task-subscribe') as Promise<TaskMeta[]>,
  taskList: () => ipcRenderer.invoke('task-list') as Promise<TaskMeta[]>,
  taskOutput: (id: string) => ipcRenderer.invoke('task-output', id) as Promise<TaskOutputSnapshot>,
  taskStart: (opts: { id?: string; name?: string; command?: string; cwd?: string }) =>
    ipcRenderer.invoke('task-start', opts) as Promise<TaskMeta>,
  taskCreate: (opts: { name?: string; command: string; cwd: string }) =>
    ipcRenderer.invoke('task-create', opts) as Promise<TaskMeta>,
  taskStop: (id: string) => ipcRenderer.invoke('task-stop', id) as Promise<void>,
  taskInput: (id: string, data: string) => ipcRenderer.send('task-input', id, data),
  taskResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('task-resize', id, cols, rows),
  taskRestart: (id: string) => ipcRenderer.invoke('task-restart', id) as Promise<TaskMeta | null>,
  taskRemove: (id: string) => ipcRenderer.invoke('task-remove', id) as Promise<void>,
  taskUpdate: (id: string, patch: { name?: string; command?: string; cwd?: string }) =>
    ipcRenderer.invoke('task-update', id, patch) as Promise<TaskMeta | null>,
  readPackageScripts: (cwd: string) =>
    ipcRenderer.invoke('read-package-scripts', cwd) as Promise<Record<string, string>>,
  onTaskData: (cb: (payload: TaskDataPayload) => void) => {
    const listener = (_e: IpcRendererEvent, p: TaskDataPayload): void => cb(p)
    ipcRenderer.on('task-data', listener)
    return () => ipcRenderer.removeListener('task-data', listener)
  },
  onTaskStatus: (cb: (meta: TaskMeta) => void) => {
    const listener = (_e: IpcRendererEvent, meta: TaskMeta): void => cb(meta)
    ipcRenderer.on('task-status', listener)
    return () => ipcRenderer.removeListener('task-status', listener)
  },
  onTaskCleared: (cb: (payload: TaskIdPayload) => void) => {
    const listener = (_e: IpcRendererEvent, p: TaskIdPayload): void => cb(p)
    ipcRenderer.on('task-cleared', listener)
    return () => ipcRenderer.removeListener('task-cleared', listener)
  },
  onTaskRemoved: (cb: (payload: TaskIdPayload) => void) => {
    const listener = (_e: IpcRendererEvent, p: TaskIdPayload): void => cb(p)
    ipcRenderer.on('task-removed', listener)
    return () => ipcRenderer.removeListener('task-removed', listener)
  },

  // ---- IDE + file manager ------------------------------------------------
  ideList: (force?: boolean) => ipcRenderer.invoke('ide-list', force) as Promise<IdeInfo[]>,
  ideOpen: (ideId: string, cwd: string) =>
    ipcRenderer.invoke('ide-open', ideId, cwd) as Promise<GitResult>,
  openFolder: (cwd: string) => ipcRenderer.invoke('open-folder', cwd) as Promise<boolean>,
  pathExists: (p: string) => ipcRenderer.invoke('path-exists', p) as Promise<boolean>,

  // ---- Browser ------------------------------------------------------------
  browserRegister: (paneId: string, webContentsId: number) =>
    ipcRenderer.invoke('browser-register', paneId, webContentsId) as Promise<void>,
  browserUnregister: (paneId: string) =>
    ipcRenderer.invoke('browser-unregister', paneId) as Promise<void>,
  browserGetResourceProxy: (paneId: string) =>
    ipcRenderer.invoke('browser-resource-proxy-get', paneId) as Promise<BrowserResourceProxyConfig>,
  browserSetResourceProxy: (paneId: string, config: BrowserResourceProxyConfig) =>
    ipcRenderer.invoke(
      'browser-resource-proxy-set',
      paneId,
      config
    ) as Promise<BrowserResourceProxyConfig>,
  browserSetResourceProxyOrigin: (paneId: string, url: string) =>
    ipcRenderer.invoke('browser-resource-proxy-origin-set', paneId, url) as Promise<void>,
  browserGetMcpUrl: (paneId: string) =>
    ipcRenderer.invoke('browser-get-mcp-url', paneId) as Promise<string>,
  agentGetMcpUrl: () => ipcRenderer.invoke('agent-get-mcp-url') as Promise<string>,
  terminalGetMcpUrl: () => ipcRenderer.invoke('terminal-get-mcp-url') as Promise<string>,
  onBrowserActivate: (cb: (paneId: string) => void) => {
    const listener = (_e: IpcRendererEvent, p: string): void => cb(p)
    ipcRenderer.on('browser-activate', listener)
    return () => ipcRenderer.removeListener('browser-activate', listener)
  },

  // ---- Auto-update --------------------------------------------------------
  /** 手动检查更新（启动时自动检查,此方法供 UI 按钮/菜单调用）。 */
  updateCheck: () => ipcRenderer.invoke('update-check'),
  /** 立即退出并安装已下载的更新。 */
  updateInstall: () => ipcRenderer.send('update-install'),
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => {
    const listener = (_e: IpcRendererEvent, s: UpdateStatus): void => cb(s)
    ipcRenderer.on('update-status', listener)
    return () => ipcRenderer.removeListener('update-status', listener)
  }
}

export type Api = typeof api

// SavedLayout / TaskMeta 等也通过 contextBridge 自动跟着 api 一起类型化(index.d.ts
// 直接 import @shared/types,无需再复制)。
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
