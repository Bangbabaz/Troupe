// 所有跨进程共享的类型定义。
//
// main / preload / renderer 三个 bundle 都会引用这里的类型 —— 之前每个 bundle 各自
// 抄一份(SavedLayout、TaskMeta、BranchInfo 全部重复 3 次),改一处要改三处,极易
// 漂移。集中到 src/shared 后,任何字段调整只改一次。
//
// 文件中 **不能** import 任何运行时模块(只能 import type),因为同时被 Node-side
// (main)、preload(沙箱)、renderer(浏览器)消费 —— 任何带运行时副作用的
// import 都会让某一侧炸掉。

// ---------------------------------------------------------------------------
// Pane layout
// ---------------------------------------------------------------------------

/**
 * 持久化到 settings.json 的 layout tree。Pane ID 是运行时生成,每次启动重新分配,
 * 所以序列化形式记录稳定 pane ID + cwd；旧配置没有 id 时 deserialize 会分配新 ID 并把 cwd 注入 paneCwd。
 */
export type SavedLayout =
  | {
      type: 'pane'
      id?: string
      cwd: string
      /** 文件浏览器的稳定根目录；终端 cd 不会改变它。 */
      workspaceRoot?: string
      terminal?: SavedTerminalState
    }
  | {
      type: 'split'
      direction: 'row' | 'column'
      ratio: number
      a: SavedLayout
      b: SavedLayout
    }

export type SavedTerminalState =
  | { kind: 'local' }
  | {
      kind: 'ssh'
      profileId: string
    }

// ---------------------------------------------------------------------------
// File browser
// ---------------------------------------------------------------------------

export type FileBrowserEntryKind = 'file' | 'directory'

export interface FileBrowserEntry {
  name: string
  /** 相对 workspace root 的正斜杠路径。 */
  relativePath: string
  /** 主机平台原生格式的绝对路径。 */
  absolutePath: string
  kind: FileBrowserEntryKind
  isSymlink: boolean
  /** 指向 workspace root 外部的符号链接不可展开或读取。 */
  blocked: boolean
  size: number
  modifiedAt: number
}

export type FileGitStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict'

export interface FileBrowserPreview {
  relativePath: string
  absolutePath: string
  size: number
  modifiedAt: number
  kind: 'text' | 'image' | 'binary' | 'large' | 'external'
  mimeType?: string
  content?: string
  dataUrl?: string
  truncated?: boolean
}

export interface FileBrowserChangePayload {
  paneId: string
  root: string
  paths: string[]
}

// ---------------------------------------------------------------------------
// Background tasks
// ---------------------------------------------------------------------------

export type TaskStatus = 'idle' | 'running' | 'exited' | 'failed'

/** 持久化形式 —— 只存定义,不存运行时状态。 */
export interface TaskDef {
  id: string
  name: string
  command: string
  cwd: string
}

/** main → renderer 推送的全量元信息(定义 + 运行状态)。 */
export interface TaskMeta extends TaskDef {
  status: TaskStatus
  exitCode: number | null
  startedAt: number | null
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface GitInfo {
  isRepo: boolean
  branch: string | null
}

export interface BranchInfo {
  name: string
  /** Exists as a local branch. */
  local: boolean
  /** Exists on at least one remote. A branch can be both local and remote. */
  remote: boolean
  /** 当多个 remote 同名时优先 origin,否则取第一个。Undefined 表示纯本地分支。 */
  remoteName?: string
  /** `git branch` 显示 `+` —— 已在另一 worktree 检出。 */
  worktree?: boolean
}

export interface DiffStats {
  files: number
  added: number
  deleted: number
}

export interface WorktreeInfo {
  path: string
  branch: string | null
  head: string | null
  isMain: boolean
  detached: boolean
  locked: boolean
}

export type MergeOpKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export interface ConflictedFile {
  path: string
  /** 来自 `git status -z --porcelain=v2 -u` unmerged 行的两字符 XY 状态。 */
  status: string
  description: string
}

/** 三方合并编辑器所需的索引版本；缺失的一侧表示新增/删除冲突。 */
export interface ConflictVersions {
  base: string | null
  ours: string | null
  theirs: string | null
  working: string | null
}

export interface MergeStatus {
  /** null = 没有进行中的操作。 */
  inProgress: MergeOpKind | null
  /**
   * merge:被合并的分支或 ref(从 MERGE_MSG 解析)。
   * rebase:源分支(head-name,无 refs/heads/ 前缀)。
   * cherry-pick / revert:正在应用的 commit short hash。
   */
  target: string | null
  /** 仅 rebase 时有值 —— 正在 replay 到的 commit short hash。 */
  onto: string | null
  conflicts: ConflictedFile[]
}

export interface CommitInfo {
  hash: string
  shortHash: string
  author: string
  email: string
  date: string
  parents: string[]
  /** Decoration refs:['HEAD -> main', 'origin/main', 'tag: v1.0'] */
  refs: string[]
  subject: string
  /**
   * 包含该 commit 的所有分支(本地 + 远程)short name 列表,如 ['main', 'origin/main', 'feat/x']。
   * 由 git-commit-branches IPC 在 commits 加载完成后异步注入,首次拿到 CommitInfo
   * 时该字段为 undefined。前端渲染时通常会减去已经在 `refs` 里展示过的分支名,
   * 再把余下分支放进提交详情的"包含于"信息中,避免和 decoration 标签重复。
   */
  branches?: string[]
}

export interface CommitDetail extends CommitInfo {
  body: string
  /** Unified patch(可能很大 —— caller 自己决定怎么渲染)。 */
  diff: string
  /** patch 超出 buffer cap 被截断时为 true。 */
  truncated: boolean
}

export interface DiffPayload {
  diff: string
  truncated: boolean
}

export interface GitResult {
  success: boolean
  error?: string
}

/** push / worktree-add 等可能在主操作成功的同时附带一个 warning。 */
export interface GitResultWithWarning extends GitResult {
  warning?: string
}

export interface WorktreeAddOpts {
  path: string
  newBranch?: string
  fromBranch?: string
}

export interface CommitLogOpts {
  skip?: number
  limit?: number
  /** branch / tag / 任意 ref。空 → HEAD。 */
  ref?: string
  /** `git log --grep`(case-insensitive regex on subject + body) */
  grep?: string
  /** `git log --author`(case-insensitive regex on name + email) */
  author?: string
}

// ---------------------------------------------------------------------------
// IDE
// ---------------------------------------------------------------------------

export interface IdeInfo {
  id: string
  name: string
  command: string
  iconDataUrl?: string
}

// ---------------------------------------------------------------------------
// Agent sessions
// ---------------------------------------------------------------------------

export type AgentSessionProvider = 'claude' | 'codex'

export interface AgentSessionInfo {
  id: string
  provider: AgentSessionProvider
  title: string
  cwd: string | null
  filePath: string
  updatedAt: number
  command: string
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ThemePref = 'system' | 'dark' | 'light'

export interface QuickCommand {
  id: string
  name: string
  command: string
}

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

export interface ShellOption {
  value: string
  label: string
  executable: string
}

export interface Settings {
  windowBounds?: WindowBounds
  windowMaximized?: boolean
  fontSize?: number
  /** 终端 scrollback 缓冲行数。 */
  scrollback?: number
  /** 单个 task 输出缓存上限(KB)。 */
  taskOutputCapKB?: number
  /** null 表示用户在设置面板里清空了 layout(重置)。 */
  paneLayout?: SavedLayout | null
  tasks?: TaskDef[]
  autoOpenTasksOnRun?: boolean
  /** 统一 Agent 会话列表。关闭时只从单个 pane 工具栏打开当前目录会话。 */
  unifiedAgentSessions?: boolean
  tasksDrawerWidth?: number
  /** 浏览器抽屉宽度(px),默认 480。 */
  browserDrawerWidth?: number
  /** 工作区侧栏宽度(px)。未设置时从旧 browserDrawerWidth 迁移。 */
  workspaceDrawerWidth?: number
  theme?: ThemePref
  /** auto 使用平台默认探测，否则为已探测到的 Shell 可执行文件。 */
  shell?: string
  /** 旧版本全局 IDE 选择，仅用于迁移到 paneSelectedIdeIds。 */
  defaultIde?: string
  /** 每个终端面板的 IDE 打开方式，key 为 paneId。 */
  paneSelectedIdeIds?: Record<string, string>
  /** 每个终端面板最后选中的后台任务 ID，key 为 paneId。 */
  paneSelectedTaskIds?: Record<string, string>
  /** 每个终端面板按工作目录保存的后台任务 ID，第一层 key 为 paneId。 */
  paneDirectorySelectedTaskIds?: Record<string, Record<string, string>>
  /**
   * 上一次 detectIdes 的结果(含 iconDataUrl)。启动期 hydrate 进 main 的 cache,
   * 让 IdeLauncher 第一帧就能拿到 IDE 列表 + 真实图标,不需要等异步扫描。
   * 用户点"重新检测"或第一次 dev 启动时由 detectIdes 完整重扫并覆盖。
   */
  cachedIdes?: IdeInfo[]
  /** 非默认快捷键绑定,key = ShortcutAction。 */
  shortcutOverrides?: Record<string, string>
  /** 自动更新开关,默认 true。关闭后不检查也不下载。 */
  autoUpdate?: boolean
  /** 点击后向当前激活终端执行或填入的快捷指令。 */
  quickCommands?: QuickCommand[]
  /** SSH 远程终端连接配置。密码仅在系统安全存储可用时加密保存。 */
  sshProfiles?: SshProfile[]
  /** Terminal MCP 按 SSH 配置保存的默认权限。未配置服务器默认每次询问。 */
  sshServerPermissions?: Record<string, SshServerPolicy>
  /** @deprecated 旧版按本地目录保存的权限，不再参与授权判断。 */
  sshDirectoryPermissions?: Record<string, SshServerPolicy>
  /** 旧版“始终允许”保存的精确命令规则，仅用于兼容已有配置。 */
  sshCommandPermissions?: SshCommandPermission[]
}

// ---------------------------------------------------------------------------
// PTY
// ---------------------------------------------------------------------------

export interface PtyStartOpts {
  paneId: string
  kind?: 'local' | 'ssh'
  cols?: number
  rows?: number
  cwd?: string
  sshProfileId?: string
}

export interface PtyDataPayload {
  paneId: string
  data: string
  sessionId: number
  sequence: number
}

export interface PtyExitPayload {
  paneId: string
  exitCode: number
}

export interface SshProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  /** renderer → main 的临时明文密码。main 保存前会转成 passwordSecret。 */
  password?: string
  /** main 持久化的加密密码，不应在普通 profile list UI 中展示。 */
  passwordSecret?: string
  /** sanitized profile 给 renderer 显示是否已有密码。 */
  hasPassword?: boolean
  remoteCwd?: string
}

export type SshServerPolicy = 'ask' | 'always_allow' | 'deny'

export interface SshCommandPermission {
  id: string
  directory: string
  sshProfileId: string
  sshTarget: string
  sshLabel: string
  command: string
  createdAt: number
}

export interface SshCommandApprovalRequest {
  sourceDirectory: string
  targetPaneId: string
  sshProfileId: string
  sshTarget: string
  sshLabel: string
  command: string
  reason?: string
  /** 主进程风险判定结果，用于审批界面；调用方无需提供。 */
  dangerous?: boolean
  riskReason?: string
}

export type SshCommandApprovalDecision = 'allow_once' | 'always_allow' | 'deny'

// ---------------------------------------------------------------------------
// 流式 task 事件 payload
// ---------------------------------------------------------------------------

export interface TaskDataPayload {
  id: string
  chunk: string
  sequence: number
}

export interface TaskOutputSnapshot {
  output: string
  sequence: number
}

export interface TaskIdPayload {
  id: string
}

// ---------------------------------------------------------------------------
// Browser (内置浏览器面板)
// ---------------------------------------------------------------------------

export interface BrowserNetworkEntry {
  requestId: string
  url: string
  method: string
  status?: number
  statusText?: string
  type: string
  timestamp: number
  duration?: number
  size?: number
  resourceType?: string
}

export interface BrowserResourceProxyPathRule {
  id: string
  pathPrefix: string
  action: 'proxy' | 'bypass'
}

export interface BrowserResourceProxyConfig {
  enabled: boolean
  localPort: number
  defaultAction: 'proxy' | 'bypass'
  fallbackToRemote: boolean
  rules: BrowserResourceProxyPathRule[]
}

// ---------------------------------------------------------------------------
// Auto-update (electron-updater)
// ---------------------------------------------------------------------------

export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }
