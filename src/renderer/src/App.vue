<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import {
  Settings as SettingsIcon,
  Type,
  Layout,
  Info,
  RotateCcw,
  Keyboard,
  Mic,
  Globe,
  Copy,
  Check,
  FolderOpen,
  ListChecks,
  Zap,
  PanelLeft,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
  FolderGit2
} from 'lucide-vue-next'
import { ElMessage } from 'element-plus'
import TerminalView from './components/Terminal.vue'
import TasksDrawer from './components/TasksDrawer.vue'
import AgentSessionsDrawer from './components/AgentSessionsDrawer.vue'
import TaskManagerDialog from './components/TaskManagerDialog.vue'
import QuickCommandMenu from './components/QuickCommandMenu.vue'
import QuickCommandsSettings from './components/QuickCommandsSettings.vue'
import { useTheme, type ThemePref } from './composables/useTheme'
import { useLayout } from './composables/useLayout'
import { useTasks } from './composables/useTasks'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFS,
  eventToShortcut,
  runtimePlatform,
  shortcutDisplayParts
} from './shortcuts'
import type {
  AgentSessionInfo,
  QuickCommand,
  SshCommandPermission,
  SshDirectoryPolicy,
  SshProfile
} from '@shared/types'

// App.vue 作为"屋顶":标题栏 + 设置抽屉 + 任务抽屉 / 管理对话框 + Layout 渲染。
// 布局算法、pane tree、divider 拖拽、pane 拖拽都搬到 useLayout —— App 这里只
// 负责"持久化时机"和"把 Terminal 事件接回 useLayout"。

const containerRef = ref<HTMLDivElement>()
const containerSize = ref({ width: 0, height: 0 })
const cwd = ref<string | null>(null)
const isMaximized = ref(false)
// 同步取 platform,首次 paint 就用对应的 title-bar layout —— 异步的
// getPlatform() 会让 mac 上短暂闪过 win 风格 traffic light。
const isMac = ref(runtimePlatform === 'darwin')

const DEFAULT_FONT_SIZE = 13
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 32
const appFontSize = ref(DEFAULT_FONT_SIZE)

const DEFAULT_SCROLLBACK = 10000
const MIN_SCROLLBACK = 1000
const MAX_SCROLLBACK = 200000
const appScrollback = ref(DEFAULT_SCROLLBACK)

const showSettings = ref(false)
const settingsTab = ref<'general' | 'commands' | 'mcp' | 'ssh' | 'shortcuts' | 'about'>('general')
const electronVersion = ref('')
const appVersion = ref('')
const quickCommands = ref<QuickCommand[]>([])
const sshProfiles = ref<SshProfile[]>([])
const sshDirectoryPermissions = ref<Record<string, SshDirectoryPolicy>>({})
const sshCommandPermissions = ref<SshCommandPermission[]>([])
const showSshDialog = ref(false)
const sshConnecting = ref(false)
const sshDraft = ref<SshProfile>({
  id: '',
  name: '',
  host: '',
  port: 22,
  username: '',
  password: '',
  remoteCwd: ''
})

// Tasks drawer + manager dialog
const showTasks = ref(false)
const showAgentSessions = ref(false)
const showTaskMgr = ref(false)
const taskMgrFocusId = ref<string | null>(null)
// 任务管理对话框不再"作用域到单一文件夹",现在按 cwd 分组渲染全部任务。
// scopeCwd 仅作为"打开时滚到这个分组"的提示。
const taskMgrScopeCwd = ref<string | null>(null)
const taskMgrNewDraft = ref(false)
const autoOpenTasksOnRun = ref(true)
const unifiedAgentSessions = ref(false)
const autoUpdate = ref(true)
const { selectTask } = useTasks()

// 用户覆盖的快捷键(仅非默认值落盘)。下发给每个 Terminal,在 key handler 内
// 与 DEFAULT_SHORTCUTS 合并。
const shortcutOverrides = ref<Record<string, string>>({})
const recordingAction = ref<string | null>(null)
const effectiveShortcuts = computed(() => ({
  ...DEFAULT_SHORTCUTS,
  ...shortcutOverrides.value
}))

// ---- 语音输入设置 ---------------------------------------------------------
const sttLanguage = ref('zh')
const sttDeviceId = ref('')
const voiceShortcut = ref('F2')
const audioInputDevices = ref<MediaDeviceInfo[]>([])
const recordingVoice = ref(false)
// 手动更新检查
const updateChecking = ref(false)
const updateResult = ref<string | null>(null)
const updateProgress = ref<number | null>(null)
// 后台自动下载完成后显示按钮
const updateReady = ref<string | null>(null)
let unsubscribeUpdateStatus: (() => void) | null = null

const displayShortcutParts = (combo: string): string[] =>
  shortcutDisplayParts(combo, runtimePlatform)

const startRecording = (action: string): void => {
  recordingAction.value = action
}

const resetShortcut = (action: string): void => {
  const next = { ...shortcutOverrides.value }
  delete next[action]
  shortcutOverrides.value = next
  window.api.settingsSet({ shortcutOverrides: next })
}

// ---- 语音输入设置 handlers ------------------------------------------------
const onSttLanguageChange = (v: string): void => {
  sttLanguage.value = v
  window.api.settingsSet({ sttLanguage: v })
}

const refreshAudioDevices = async (): Promise<void> => {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    audioInputDevices.value = all.filter((d) => d.kind === 'audioinput')
  } catch {
    audioInputDevices.value = []
  }
}

const onSttDeviceIdChange = (v: string): void => {
  // sentinel '__default__' 表示系统默认，落盘存空字符串方便 getUserMedia 判断。
  const id = v === '__default__' ? '' : v
  sttDeviceId.value = id
  window.api.settingsSet({ sttDeviceId: id })
}

const onVoiceShortcutChange = (v: string): void => {
  voiceShortcut.value = v
  window.api.settingsSet({ voiceShortcut: v })
}

const startVoiceRecording = (): void => {
  recordingVoice.value = true
}

const onVoiceRecordingKeydown = (e: KeyboardEvent): void => {
  if (!recordingVoice.value) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    recordingVoice.value = false
    return
  }
  // 语音快捷键允许无修饰键(F1-F12 等),与常规快捷键不同。
  const shortcut = eventToShortcut(e)
  recordingVoice.value = false
  onVoiceShortcutChange(shortcut)
}

const watchVoiceRecording = (): void => {
  if (recordingVoice.value) {
    window.addEventListener('keydown', onVoiceRecordingKeydown, true)
  } else {
    window.removeEventListener('keydown', onVoiceRecordingKeydown, true)
  }
}

watch(recordingVoice, watchVoiceRecording)

const refreshSshPermissions = async (): Promise<void> => {
  const settings = await window.api.settingsGet()
  sshDirectoryPermissions.value = { ...(settings.sshDirectoryPermissions || {}) }
  sshCommandPermissions.value = Array.isArray(settings.sshCommandPermissions)
    ? settings.sshCommandPermissions
    : []
}

const onRecordingKeydown = (e: KeyboardEvent): void => {
  if (!recordingAction.value) return
  e.preventDefault()
  e.stopPropagation()

  if (e.key === 'Escape') {
    recordingAction.value = null
    return
  }

  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return

  // macOS 的 Cmd 会被规范化为兼容旧设置的 Ctrl token。
  if (!e.ctrlKey && !e.metaKey && !e.altKey) return

  const shortcut = eventToShortcut(e)
  const targetAction = recordingAction.value
  recordingAction.value = null

  const conflict = SHORTCUT_DEFS.find(
    (d) => d.action !== targetAction && effectiveShortcuts.value[d.action] === shortcut
  )

  const next = { ...shortcutOverrides.value }
  if (conflict) {
    next[conflict.action] = effectiveShortcuts.value[targetAction]
  }
  if (shortcut === DEFAULT_SHORTCUTS[targetAction]) {
    delete next[targetAction]
  } else {
    next[targetAction] = shortcut
  }
  for (const a of Object.keys(next)) {
    if (next[a] === DEFAULT_SHORTCUTS[a]) delete next[a]
  }

  shortcutOverrides.value = next
  window.api.settingsSet({ shortcutOverrides: next })
}

const watchRecording = (): void => {
  if (recordingAction.value) {
    window.addEventListener('keydown', onRecordingKeydown, true)
  } else {
    window.removeEventListener('keydown', onRecordingKeydown, true)
  }
}

watch(showSettings, (open) => {
  if (open) {
    void refreshAudioDevices()
    void refreshSshPermissions()
  } else {
    recordingAction.value = null
    recordingVoice.value = false
  }
})

watch(recordingAction, watchRecording)
watch(settingsTab, (tab) => {
  if (tab === 'ssh') void refreshSshPermissions()
})

// 浏览器自动化、Agent 协作与终端控制使用独立 MCP，避免无关工具进入同一个上下文。
const BROWSER_MCP_SSE_URL = 'http://127.0.0.1:9876/sse'
const AGENT_MCP_SSE_URL = 'http://127.0.0.1:9877/sse'
const TERMINAL_MCP_SSE_URL = 'http://127.0.0.1:9878/sse'
const BROWSER_MCP_HTTP_URL = 'http://127.0.0.1:9876/mcp'
const AGENT_MCP_HTTP_URL = 'http://127.0.0.1:9877/mcp'
const TERMINAL_MCP_HTTP_URL = 'http://127.0.0.1:9878/mcp'
const MCP_CONFIGS = {
  browserClaude: `claude mcp add -s user -t sse troupe-browser ${BROWSER_MCP_SSE_URL}`,
  browserCodex: `codex mcp add troupe-browser --url ${BROWSER_MCP_HTTP_URL}`,
  agentClaude: `claude mcp add -s user -t sse troupe-agent ${AGENT_MCP_SSE_URL}`,
  agentCodex: `codex mcp add troupe-agent --url ${AGENT_MCP_HTTP_URL}`,
  terminalClaude: `claude mcp add -s user -t sse troupe-terminal ${TERMINAL_MCP_SSE_URL}`,
  terminalCodex: `codex mcp add troupe-terminal --url ${TERMINAL_MCP_HTTP_URL}`
} as const
type McpCopyTarget = keyof typeof MCP_CONFIGS
const mcpCopied = ref<McpCopyTarget | null>(null)

async function copyMcpConfig(which: McpCopyTarget): Promise<void> {
  const content = MCP_CONFIGS[which]
  try {
    await navigator.clipboard.writeText(content)
    mcpCopied.value = which
    setTimeout(() => {
      if (mcpCopied.value === which) mcpCopied.value = null
    }, 2000)
  } catch {
    // ignore
  }
}

// Tasks drawer 宽度
const DEFAULT_TASKS_DRAWER_WIDTH = 860
const MIN_TASKS_DRAWER_WIDTH = 480
const MAX_TASKS_DRAWER_WIDTH = 2000
const tasksDrawerWidth = ref(DEFAULT_TASKS_DRAWER_WIDTH)

const clampDrawerWidth = (w: number): number =>
  Math.round(Math.max(MIN_TASKS_DRAWER_WIDTH, Math.min(MAX_TASKS_DRAWER_WIDTH, w)))

const onTasksDrawerWidthChange = (w: number): void => {
  const clamped = clampDrawerWidth(w)
  if (tasksDrawerWidth.value === clamped) return
  tasksDrawerWidth.value = clamped
  window.api.settingsSet({ tasksDrawerWidth: clamped })
}

// 主题
const { preference: themePref, setPreference: setThemePref, init: initTheme } = useTheme()
const onThemeChange = (v: ThemePref): void => {
  setThemePref(v)
}

// ----------- Layout(全部委托给 useLayout)-----------
// containerRef 在 App.vue 持有,模板 `ref="containerRef"` 把它绑到真正的 DOM;
// useLayout 接收同一个 ref —— pane 拖拽的鼠标坐标计算依赖它指向真实容器。
const {
  layout,
  activeId,
  paneCwd,
  paneTerminalState,
  layoutResult,
  dragState,
  paneDrag,
  draggedRect,
  dropIndicatorRect,
  onSplit,
  onClose,
  onCreateWorktree,
  setActive,
  onCwdChange,
  focusNeighbor,
  onDividerDown,
  onDividerDoubleClick,
  onPaneDragStart,
  serializeLayout,
  restoreFromSaved
} = useLayout({
  containerSize,
  containerRef,
  defaultCwd: cwd
})

const makeSshProfileId = (): string => `ssh-${Date.now().toString(36)}`

const makeSshDraft = (): SshProfile => ({
  id: makeSshProfileId(),
  name: '',
  host: '',
  port: 22,
  username: '',
  password: '',
  remoteCwd: ''
})

const sshProfileById = (id: string | undefined): SshProfile | null =>
  id ? sshProfiles.value.find((profile) => profile.id === id) || null : null

const sshProfileLabel = (id: string | undefined): string => {
  const profile = sshProfileById(id)
  if (!profile) return 'SSH'
  return profile.name || `${profile.username}@${profile.host}`
}

const paneSshProfileId = (paneId: string): string => {
  const terminal = paneTerminalState.value[paneId]
  return terminal?.kind === 'ssh' ? terminal.profileId : ''
}

const openSshDialog = (): void => {
  const activeProfile = activeId.value ? sshProfileById(paneSshProfileId(activeId.value)) : null
  const selected = activeProfile || sshProfiles.value[0]
  sshDraft.value = selected ? { ...selected, password: '' } : makeSshDraft()
  showSshDialog.value = true
}

const createSshProfile = (): void => {
  sshDraft.value = makeSshDraft()
}

const useSshProfile = (profile: SshProfile): void => {
  sshDraft.value = { ...profile, password: '' }
}

const connectSsh = async (): Promise<void> => {
  if (sshConnecting.value) return
  sshConnecting.value = true
  try {
    const draft = {
      ...sshDraft.value,
      id: sshDraft.value.id || makeSshProfileId(),
      port: Number(sshDraft.value.port) || 22,
      name:
        sshDraft.value.name.trim() ||
        `${sshDraft.value.username.trim()}@${sshDraft.value.host.trim()}`
    }
    const saved = await window.api.sshProfileSave(draft)
    sshProfiles.value = await window.api.sshProfilesList()

    const from = activeId.value || layoutResult.value.panes[0]?.id || null
    if (!from) return
    const newId =
      onSplit(from, 'row', paneCwdFor(from)) || onSplit(from, 'column', paneCwdFor(from))
    if (!newId) {
      ElMessage.warning('当前面板空间不足，连接信息已保存')
      return
    }
    paneTerminalState.value = {
      ...paneTerminalState.value,
      [newId]: { kind: 'ssh', profileId: saved.id }
    }
    setActive(newId)
    showSshDialog.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    sshConnecting.value = false
  }
}

const deleteSshProfile = async (profileId: string): Promise<void> => {
  await window.api.sshProfileDelete(profileId)
  sshProfiles.value = await window.api.sshProfilesList()
  if (sshDraft.value.id === profileId) {
    const next = sshProfiles.value[0]
    sshDraft.value = next ? { ...next, password: '' } : makeSshDraft()
  }
}

const activeCwd = computed(() => {
  const id = activeId.value
  return (id && paneCwd.value[id]) || cwd.value || ''
})

type TerminalViewInstance = InstanceType<typeof TerminalView>
const terminalRefs = new Map<string, TerminalViewInstance>()

const setTerminalRef = (paneId: string, instance: unknown): void => {
  if (instance) terminalRefs.set(paneId, instance as TerminalViewInstance)
  else terminalRefs.delete(paneId)
}

const runQuickCommand = (command: QuickCommand, execute: boolean): void => {
  if (!command.command.trim()) return
  const id = activeId.value
  if (!id) return
  terminalRefs.get(id)?.runQuickCommand(command.command, execute)
}

const normPath = (p: string | null | undefined): string => {
  if (!p) return ''
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(s)) s = s.toLowerCase()
  return s
}

const activeWorkspaceLabel = computed(() => {
  const normalized = activeCwd.value.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).pop() || '未打开目录'
})

const paneCwdFor = (paneId: string): string => paneCwd.value[paneId] || cwd.value || ''

const openedLocalDirectories = computed(() => {
  const unique = new Map<string, string>()
  for (const pane of layoutResult.value.panes) {
    if (paneTerminalState.value[pane.id]?.kind === 'ssh') continue
    const directory = paneCwdFor(pane.id)
    const key = normPath(directory)
    if (key && !unique.has(key)) unique.set(key, directory)
  }
  return Array.from(unique.values())
})

const sshDirectoryPolicy = (directory: string): SshDirectoryPolicy => {
  const key = normPath(directory)
  const entry = Object.entries(sshDirectoryPermissions.value).find(
    ([configured]) => normPath(configured) === key
  )
  return entry?.[1] || 'ask'
}

const sshRulesForDirectory = (directory: string): SshCommandPermission[] => {
  const key = normPath(directory)
  return sshCommandPermissions.value.filter((rule) => normPath(rule.directory) === key)
}

const onSshDirectoryPolicyChange = async (
  directory: string,
  policy: SshDirectoryPolicy
): Promise<void> => {
  const next = { ...sshDirectoryPermissions.value }
  for (const configured of Object.keys(next)) {
    if (normPath(configured) === normPath(directory)) delete next[configured]
  }
  if (policy !== 'ask') next[directory] = policy
  sshDirectoryPermissions.value = next
  await window.api.settingsSetNow({ sshDirectoryPermissions: next })
}

const removeSshCommandPermission = async (id: string): Promise<void> => {
  const next = sshCommandPermissions.value.filter((rule) => rule.id !== id)
  sshCommandPermissions.value = next
  await window.api.settingsSetNow({ sshCommandPermissions: next })
}

const waitForTerminalRef = async (paneId: string): Promise<TerminalViewInstance | null> => {
  for (let i = 0; i < 20; i++) {
    const ref = terminalRefs.get(paneId)
    if (ref) return ref
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

const runCommandInPane = async (paneId: string, command: string): Promise<void> => {
  setActive(paneId)
  const terminal = await waitForTerminalRef(paneId)
  terminal?.runQuickCommand(command, true)
}

const openUnifiedAgentSessions = (): void => {
  showAgentSessions.value = !showAgentSessions.value
}

const openAgentSession = async (session: AgentSessionInfo): Promise<void> => {
  const targetCwd = normPath(session.cwd)
  const panes = layoutResult.value.panes
  const candidates = targetCwd
    ? panes.filter((pane) => normPath(paneCwdFor(pane.id)) === targetCwd)
    : []

  for (const pane of candidates) {
    const busy = await window.api.ptyHasRunningProcess(pane.id)
    if (!busy) {
      await runCommandInPane(pane.id, session.command)
      return
    }
  }

  const splitFrom = candidates[0]?.id || activeId.value || panes[0]?.id || null
  if (!splitFrom) return
  const splitCwd = session.cwd || paneCwdFor(splitFrom)
  const newPaneId = onSplit(splitFrom, 'row', splitCwd) || onSplit(splitFrom, 'column', splitCwd)
  if (newPaneId) {
    await runCommandInPane(newPaneId, session.command)
  } else {
    await runCommandInPane(splitFrom, session.command)
  }
}

const normalizeQuickCommands = (commands: QuickCommand[]): QuickCommand[] =>
  commands.map((item) => ({
    id: String(item.id),
    name: String(item.name ?? ''),
    command: String(item.command ?? '')
  }))

const updateQuickCommands = async (commands: QuickCommand[]): Promise<void> => {
  const next = normalizeQuickCommands(commands)
  quickCommands.value = next
  try {
    await window.api.settingsSetNow({ quickCommands: next })
  } catch (err) {
    console.error('[quick-commands] save failed:', err)
  }
}

const openQuickCommandSettings = (): void => {
  settingsTab.value = 'commands'
  showSettings.value = true
}

// ----------- 字号 / 滚动行数 -----------
const onFontSizeChange = (size: number): void => {
  const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size))
  if (appFontSize.value === clamped) return
  appFontSize.value = clamped
  window.api.settingsSet({ fontSize: clamped })
}

const decreaseFontSize = (): void => onFontSizeChange(appFontSize.value - 1)
const increaseFontSize = (): void => onFontSizeChange(appFontSize.value + 1)
const resetFontSize = (): void => onFontSizeChange(DEFAULT_FONT_SIZE)

const onScrollbackChange = (size: number | undefined): void => {
  const n = typeof size === 'number' && !Number.isNaN(size) ? size : DEFAULT_SCROLLBACK
  const clamped = Math.max(MIN_SCROLLBACK, Math.min(MAX_SCROLLBACK, Math.round(n)))
  if (appScrollback.value === clamped) return
  appScrollback.value = clamped
  window.api.settingsSet({ scrollback: clamped })
}

async function checkForUpdate(): Promise<void> {
  if (updateChecking.value || updateProgress.value !== null) return
  updateChecking.value = true
  updateResult.value = null
  try {
    await window.api.updateCheck()
  } catch (e: unknown) {
    updateResult.value = e instanceof Error ? e.message : String(e)
    updateChecking.value = false
  }
}

function installUpdate(): void {
  window.api.updateInstall()
}

const onToggleAutoOpenTasks = (val: boolean): void => {
  autoOpenTasksOnRun.value = val
  window.api.settingsSet({ autoOpenTasksOnRun: val })
}

const onToggleUnifiedAgentSessions = (val: boolean): void => {
  unifiedAgentSessions.value = val
  window.api.settingsSet({ unifiedAgentSessions: val })
}

const onToggleAutoUpdate = (val: boolean): void => {
  autoUpdate.value = val
  window.api.settingsSet({ autoUpdate: val })
}

const openTasksDrawer = (): void => {
  showTasks.value = true
}

const openTaskManager = (
  focusId: string | null = null,
  scopeCwd: string | null = null,
  newDraft = false
): void => {
  taskMgrFocusId.value = focusId
  taskMgrScopeCwd.value = scopeCwd
  taskMgrNewDraft.value = newDraft
  showTaskMgr.value = true
}

// ----------- 标题栏 -----------
function winMinimize(): void {
  window.api.winMinimize()
}
function winMaximize(): void {
  window.api.winMaximize()
}
function winClose(): void {
  window.api.winClose()
}

async function onOpenDirectory(): Promise<void> {
  const dir = await window.api.selectDirectory()
  if (dir && activeId.value) {
    onSplit(activeId.value, 'row', dir)
  }
}

const rectStyle = (rect: {
  left: number
  top: number
  width: number
  height: number
}): Record<string, string> => ({
  left: rect.left + 'px',
  top: rect.top + 'px',
  width: rect.width + 'px',
  height: rect.height + 'px'
})

// ----------- 持久化 -----------
let resizeObserver: ResizeObserver | null = null
let unsubscribeWinState: (() => void) | null = null
let unsubscribeTaskStatus: (() => void) | null = null
let unsubscribeSshPermissions: (() => void) | null = null

let saveTimer: ReturnType<typeof setTimeout> | null = null
const flushSave = (): void => {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const saved = serializeLayout()
  if (saved) window.api.settingsSet({ paneLayout: saved })
}
const scheduleSave = (): void => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, 500)
}
const flushSaveOnUnload = (): void => flushSave()

onMounted(async () => {
  initTheme()
  cwd.value = await window.api.getCwd()
  isMaximized.value = await window.api.winIsMaximized()
  appVersion.value = await window.api.getAppVersion()
  unsubscribeWinState = window.api.onWindowStateChanged((maximized) => {
    isMaximized.value = maximized
  })

  const versions = (
    window.electron as unknown as { process?: { versions?: Record<string, string> } }
  ).process?.versions
  if (versions?.electron) electronVersion.value = versions.electron

  const settings = await window.api.settingsGet()
  if (typeof settings.fontSize === 'number') appFontSize.value = settings.fontSize
  if (typeof settings.scrollback === 'number') appScrollback.value = settings.scrollback
  if (typeof settings.autoOpenTasksOnRun === 'boolean')
    autoOpenTasksOnRun.value = settings.autoOpenTasksOnRun
  if (typeof settings.unifiedAgentSessions === 'boolean')
    unifiedAgentSessions.value = settings.unifiedAgentSessions
  if (typeof settings.autoUpdate === 'boolean') autoUpdate.value = settings.autoUpdate
  if (typeof settings.tasksDrawerWidth === 'number')
    tasksDrawerWidth.value = clampDrawerWidth(settings.tasksDrawerWidth)
  if (settings.shortcutOverrides && typeof settings.shortcutOverrides === 'object') {
    shortcutOverrides.value = settings.shortcutOverrides as Record<string, string>
  }
  if (typeof settings.sttLanguage === 'string') sttLanguage.value = settings.sttLanguage
  if (typeof settings.sttDeviceId === 'string') sttDeviceId.value = settings.sttDeviceId
  if (typeof settings.voiceShortcut === 'string') voiceShortcut.value = settings.voiceShortcut
  if (Array.isArray(settings.quickCommands)) {
    quickCommands.value = settings.quickCommands.filter(
      (item): item is QuickCommand =>
        !!item &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.command === 'string'
    )
  }
  sshDirectoryPermissions.value = { ...(settings.sshDirectoryPermissions || {}) }
  sshCommandPermissions.value = Array.isArray(settings.sshCommandPermissions)
    ? settings.sshCommandPermissions
    : []
  sshProfiles.value = await window.api.sshProfilesList()
  unsubscribeSshPermissions = window.api.onSshPermissionsUpdated(() => {
    void refreshSshPermissions()
  })

  restoreFromSaved(settings.paneLayout)

  watch([layout, paneCwd, paneTerminalState], scheduleSave, { deep: true })

  unsubscribeTaskStatus = window.api.onTaskStatus((meta) => {
    if (meta.status === 'running' && autoOpenTasksOnRun.value) {
      selectTask(meta.id)
      showTasks.value = true
    }
  })

  // 自动检查和手动检查共用同一条持续状态流，下载进度同步显示在标题栏和关于页。
  unsubscribeUpdateStatus = window.api.onUpdateStatus((status) => {
    switch (status.state) {
      case 'checking':
        updateChecking.value = true
        updateResult.value = null
        break
      case 'available':
        updateChecking.value = false
        updateProgress.value = 0
        updateResult.value = `发现新版本 ${status.version}`
        break
      case 'downloading':
        updateChecking.value = false
        updateProgress.value = status.percent
        updateResult.value = null
        break
      case 'not-available':
        updateChecking.value = false
        updateProgress.value = null
        updateResult.value = '已是最新版本'
        break
      case 'downloaded':
        updateChecking.value = false
        updateProgress.value = null
        updateReady.value = status.version || null
        updateResult.value = `新版本 ${status.version} 已就绪，重启以安装`
        break
      case 'error':
        updateChecking.value = false
        updateProgress.value = null
        updateResult.value = status.message || '检查失败'
        break
    }
  })

  window.addEventListener('beforeunload', flushSaveOnUnload)

  if (containerRef.value) {
    const update = (): void => {
      const el = containerRef.value
      if (!el) return
      containerSize.value = { width: el.clientWidth, height: el.clientHeight }
    }
    update()
    resizeObserver = new ResizeObserver(update)
    resizeObserver.observe(containerRef.value)
  }
})

onUnmounted(() => {
  flushSave()
  unsubscribeWinState?.()
  unsubscribeTaskStatus?.()
  unsubscribeUpdateStatus?.()
  unsubscribeSshPermissions?.()
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', onRecordingKeydown, true)
  window.removeEventListener('keydown', onVoiceRecordingKeydown, true)
  window.removeEventListener('beforeunload', flushSaveOnUnload)
})
</script>

<template>
  <div class="title-bar" :class="{ mac: isMac }">
    <div class="title-bar-heading">
      <div class="title-brand">
        <span class="title-bar-text">Troupe</span>
      </div>
      <div v-if="cwd !== null" class="title-workspace" :title="activeCwd">
        <FolderGit2 :size="13" />
        <span class="title-workspace-name">{{ activeWorkspaceLabel }}</span>
      </div>
      <span v-if="updateProgress !== null" class="title-update-progress">
        下载中 {{ updateProgress }}%
      </span>
      <button
        v-else-if="updateReady"
        class="title-install-update"
        title="重启并安装新版本"
        @click="installUpdate"
      >
        安装新版本
      </button>
    </div>
    <div class="title-bar-right">
      <div class="title-action-group">
        <QuickCommandMenu
          :commands="quickCommands"
          :disabled="!activeId"
          @run="runQuickCommand"
          @manage="openQuickCommandSettings"
        />
        <button class="tb-btn" title="查看任务" @click="openTasksDrawer">
          <ListChecks :size="14" />
        </button>
      </div>
      <div class="title-action-group">
        <button class="tb-btn" title="SSH 远程终端" @click="openSshDialog">
          <Server :size="14" />
        </button>
        <button class="tb-btn tb-folder" title="打开目录为新面板" @click="onOpenDirectory">
          <FolderOpen :size="14" />
        </button>
      </div>
      <div class="title-action-group">
        <button
          v-if="unifiedAgentSessions"
          class="tb-btn"
          title="Agent 会话"
          @click="openUnifiedAgentSessions"
        >
          <PanelLeft :size="14" />
        </button>
        <button class="tb-btn tb-settings" title="设置" @click="showSettings = true">
          <SettingsIcon :size="14" />
        </button>
      </div>
      <div v-if="!isMac" class="title-bar-controls">
        <button class="tb-btn tb-min" title="最小化" @click="winMinimize">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect y="4" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button class="tb-btn tb-max" title="最大化" @click="winMaximize">
          <svg v-if="!isMaximized" width="10" height="10" viewBox="0 0 10 10">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
          </svg>
          <svg v-else width="10" height="10" viewBox="0 0 10 10">
            <rect x="2" y="0" width="8" height="8" fill="none" stroke="currentColor" />
            <rect
              x="0"
              y="3"
              width="8"
              height="7"
              fill="var(--el-bg-color)"
              stroke="currentColor"
            />
          </svg>
        </button>
        <button class="tb-btn tb-close" title="关闭" @click="winClose">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </button>
      </div>
    </div>
  </div>
  <el-drawer
    v-model="showSettings"
    direction="rtl"
    size="min(680px, 92vw)"
    :with-header="false"
    class="settings-drawer"
  >
    <div class="settings-layout">
      <aside class="settings-sidebar">
        <div class="settings-sidebar-title">设置</div>
        <nav class="settings-nav">
          <button
            class="settings-nav-item"
            :class="{ active: settingsTab === 'general' }"
            @click="settingsTab = 'general'"
          >
            <Layout :size="14" class="settings-nav-icon" />
            <span>通用</span>
          </button>
          <button
            class="settings-nav-item"
            :class="{ active: settingsTab === 'commands' }"
            @click="settingsTab = 'commands'"
          >
            <Zap :size="14" class="settings-nav-icon" />
            <span>快捷指令</span>
          </button>
          <button
            class="settings-nav-item"
            :class="{ active: settingsTab === 'mcp' }"
            @click="settingsTab = 'mcp'"
          >
            <Globe :size="14" class="settings-nav-icon" />
            <span>MCP</span>
          </button>
          <button
            class="settings-nav-item"
            :class="{ active: settingsTab === 'ssh' }"
            @click="settingsTab = 'ssh'"
          >
            <ShieldCheck :size="14" class="settings-nav-icon" />
            <span>SSH 权限</span>
          </button>
          <button
            class="settings-nav-item"
            :class="{ active: settingsTab === 'shortcuts' }"
            @click="settingsTab = 'shortcuts'"
          >
            <Keyboard :size="14" class="settings-nav-icon" />
            <span>快捷键</span>
          </button>
          <button
            class="settings-nav-item"
            :class="{ active: settingsTab === 'about' }"
            @click="settingsTab = 'about'"
          >
            <Info :size="14" class="settings-nav-icon" />
            <span>关于</span>
          </button>
        </nav>
      </aside>

      <div class="settings-panel">
        <template v-if="settingsTab === 'general'">
          <section class="settings-section">
            <header class="settings-section-header">
              <Type :size="14" class="settings-section-icon" />
              <h3 class="settings-section-title">外观</h3>
            </header>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">字号</label>
                <div class="font-size-control">
                  <button
                    class="fs-btn"
                    :disabled="appFontSize <= MIN_FONT_SIZE"
                    @click="decreaseFontSize"
                  >
                    −
                  </button>
                  <span class="fs-value">{{ appFontSize }}</span>
                  <button
                    class="fs-btn"
                    :disabled="appFontSize >= MAX_FONT_SIZE"
                    @click="increaseFontSize"
                  >
                    +
                  </button>
                  <button
                    v-if="appFontSize !== DEFAULT_FONT_SIZE"
                    class="fs-reset"
                    title="重置为默认"
                    @click="resetFontSize"
                  >
                    <RotateCcw :size="12" />
                  </button>
                </div>
              </div>
              <p class="settings-item-desc">
                终端字体大小,{{ MIN_FONT_SIZE }}–{{ MAX_FONT_SIZE }}。也可以用 Ctrl+= / Ctrl+-
                调整。
              </p>
            </div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">回滚行数</label>
                <el-input-number
                  :model-value="appScrollback"
                  :min="MIN_SCROLLBACK"
                  :max="MAX_SCROLLBACK"
                  :step="1000"
                  size="small"
                  controls-position="right"
                  @change="(v: number | undefined) => onScrollbackChange(v)"
                />
              </div>
              <p class="settings-item-desc">
                终端保留的历史输出行数({{ MIN_SCROLLBACK }}–{{
                  MAX_SCROLLBACK
                }})。调大可向上翻看更多构建/日志输出,过大略增内存占用。
              </p>
            </div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">主题</label>
                <el-select
                  :model-value="themePref"
                  size="small"
                  popper-class="settings-select-popper"
                  style="width: 140px"
                  @update:model-value="(v: ThemePref) => onThemeChange(v)"
                >
                  <el-option label="跟随系统" value="system" />
                  <el-option label="黑色" value="dark" />
                  <el-option label="白色" value="light" />
                </el-select>
              </div>
              <p class="settings-item-desc">
                选择界面主题。"跟随系统"会随操作系统的浅色 / 深色外观自动切换。
              </p>
            </div>
          </section>

          <section class="settings-section">
            <header class="settings-section-header">
              <Layout :size="14" class="settings-section-icon" />
              <h3 class="settings-section-title">会话</h3>
            </header>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">运行任务时自动打开任务面板</label>
                <el-switch
                  :model-value="autoOpenTasksOnRun"
                  size="small"
                  @update:model-value="(v: string | number | boolean) => onToggleAutoOpenTasks(!!v)"
                />
              </div>
              <p class="settings-item-desc">
                关闭后,后台任务启动时不会自动弹出任务抽屉,需手动点工具栏的查看按钮。
              </p>
            </div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">统一会话</label>
                <el-switch
                  :model-value="unifiedAgentSessions"
                  size="small"
                  @update:model-value="
                    (v: string | number | boolean) => onToggleUnifiedAgentSessions(!!v)
                  "
                />
              </div>
              <p class="settings-item-desc">
                开启后,顶部显示统一 Agent 会话列表；关闭时从每个终端工具栏打开当前目录会话。
              </p>
            </div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">自动检查更新</label>
                <el-switch
                  :model-value="autoUpdate"
                  size="small"
                  @update:model-value="(v: string | number | boolean) => onToggleAutoUpdate(!!v)"
                />
              </div>
              <p class="settings-item-desc">
                开启后启动时自动检查并下载新版本。关闭后不再检查更新，但可手动在"关于"页检测。
              </p>
            </div>
          </section>

          <section class="settings-section">
            <header class="settings-section-header">
              <Mic :size="14" class="settings-section-icon" />
              <h3 class="settings-section-title">语音输入</h3>
            </header>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">识别语言</label>
                <el-select
                  :model-value="sttLanguage"
                  size="small"
                  popper-class="settings-select-popper"
                  style="width: 140px"
                  @update:model-value="onSttLanguageChange"
                >
                  <el-option label="中文" value="zh" />
                  <el-option label="英文" value="en" />
                  <el-option label="自动检测" value="auto" />
                </el-select>
              </div>
              <p class="settings-item-desc">语音识别目标语言。"自动检测"让模型自动判断语种。</p>
            </div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">麦克风</label>
                <el-select
                  :model-value="sttDeviceId || '__default__'"
                  size="small"
                  popper-class="settings-select-popper"
                  style="width: 180px"
                  @update:model-value="onSttDeviceIdChange"
                  @visible-change="(v: boolean) => v && refreshAudioDevices()"
                >
                  <el-option label="系统默认" value="__default__" />
                  <el-option
                    v-for="d in audioInputDevices"
                    :key="d.deviceId"
                    :label="d.label || `设备 ${d.deviceId.slice(0, 8)}`"
                    :value="d.deviceId"
                  />
                </el-select>
              </div>
              <p class="settings-item-desc">
                用于语音输入的录音设备,可在耳机、内置麦克风等之间切换。
              </p>
            </div>
          </section>
        </template>

        <QuickCommandsSettings
          v-else-if="settingsTab === 'commands'"
          :model-value="quickCommands"
          @update:model-value="updateQuickCommands"
        />

        <template v-else-if="settingsTab === 'mcp'">
          <section class="settings-section">
            <header class="settings-section-header">
              <Globe :size="14" class="settings-section-icon" />
              <h3 class="settings-section-title">MCP</h3>
            </header>
            <p class="settings-item-desc" style="margin-bottom: 10px">
              浏览器自动化、Agent 协作和终端控制使用独立服务，可按需注册。
            </p>
            <div class="settings-item-label" style="margin-bottom: 6px">浏览器 MCP · 9876</div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">Claude Code</label>
                <button
                  class="settings-copy-btn"
                  title="复制注册命令"
                  @click="copyMcpConfig('browserClaude')"
                >
                  <Check v-if="mcpCopied === 'browserClaude'" :size="12" />
                  <Copy v-else :size="12" />
                </button>
              </div>
              <p class="settings-item-desc">
                <code class="settings-cmd">{{ MCP_CONFIGS.browserClaude }}</code>
              </p>
            </div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">Codex</label>
                <button
                  class="settings-copy-btn"
                  title="复制注册命令"
                  @click="copyMcpConfig('browserCodex')"
                >
                  <Check v-if="mcpCopied === 'browserCodex'" :size="12" />
                  <Copy v-else :size="12" />
                </button>
              </div>
              <p class="settings-item-desc">
                <code class="settings-cmd">{{ MCP_CONFIGS.browserCodex }}</code>
              </p>
            </div>
            <div class="settings-item-label" style="margin: 12px 0 6px">Agent 协作 MCP · 9877</div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">Claude Code</label>
                <button
                  class="settings-copy-btn"
                  title="复制注册命令"
                  @click="copyMcpConfig('agentClaude')"
                >
                  <Check v-if="mcpCopied === 'agentClaude'" :size="12" />
                  <Copy v-else :size="12" />
                </button>
              </div>
              <p class="settings-item-desc">
                <code class="settings-cmd">{{ MCP_CONFIGS.agentClaude }}</code>
              </p>
            </div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">Codex</label>
                <button
                  class="settings-copy-btn"
                  title="复制注册命令"
                  @click="copyMcpConfig('agentCodex')"
                >
                  <Check v-if="mcpCopied === 'agentCodex'" :size="12" />
                  <Copy v-else :size="12" />
                </button>
              </div>
              <p class="settings-item-desc">
                <code class="settings-cmd">{{ MCP_CONFIGS.agentCodex }}</code>
              </p>
            </div>
            <p class="settings-item-desc">
              注册完成后，请重新启动或刷新 Agent，使其重新加载 MCP 工具列表。Agent 先从环境变量
              TROUPE_PANE_ID 读取当前面板 ID，并调用 agent_register({ name, paneId })
              注册名称；之后用 agent_list、agent_send 和 agent_reply 协作，消息会直接唤醒目标
              Agent。
            </p>
            <div class="settings-item-label" style="margin: 12px 0 6px">Terminal MCP · 9878</div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">Claude Code</label>
                <button
                  class="settings-copy-btn"
                  title="复制注册命令"
                  @click="copyMcpConfig('terminalClaude')"
                >
                  <Check v-if="mcpCopied === 'terminalClaude'" :size="12" />
                  <Copy v-else :size="12" />
                </button>
              </div>
              <p class="settings-item-desc">
                <code class="settings-cmd">{{ MCP_CONFIGS.terminalClaude }}</code>
              </p>
            </div>
            <div class="settings-item">
              <div class="settings-item-row">
                <label class="settings-item-label">Codex</label>
                <button
                  class="settings-copy-btn"
                  title="复制注册命令"
                  @click="copyMcpConfig('terminalCodex')"
                >
                  <Check v-if="mcpCopied === 'terminalCodex'" :size="12" />
                  <Copy v-else :size="12" />
                </button>
              </div>
              <p class="settings-item-desc">
                <code class="settings-cmd">{{ MCP_CONFIGS.terminalCodex }}</code>
              </p>
            </div>
          </section>
        </template>

        <template v-else-if="settingsTab === 'ssh'">
          <section class="settings-section">
            <header class="settings-section-header">
              <ShieldCheck :size="14" class="settings-section-icon" />
              <h3 class="settings-section-title">SSH 权限</h3>
            </header>
            <div v-if="!openedLocalDirectories.length" class="ssh-permission-empty">
              当前没有打开的本地目录
            </div>
            <div
              v-for="directory in openedLocalDirectories"
              :key="normPath(directory)"
              class="ssh-permission-directory"
            >
              <div class="ssh-permission-heading">
                <code class="ssh-permission-path" :title="directory">{{ directory }}</code>
                <el-select
                  :model-value="sshDirectoryPolicy(directory)"
                  size="small"
                  popper-class="settings-select-popper"
                  style="width: 130px"
                  @update:model-value="
                    (value: SshDirectoryPolicy) => onSshDirectoryPolicyChange(directory, value)
                  "
                >
                  <el-option label="每次确认" value="ask" />
                  <el-option label="始终允许" value="always_allow" />
                  <el-option label="拒绝" value="deny" />
                </el-select>
              </div>
              <div v-if="sshRulesForDirectory(directory).length" class="ssh-command-rules">
                <div
                  v-for="rule in sshRulesForDirectory(directory)"
                  :key="rule.id"
                  class="ssh-command-rule"
                >
                  <div class="ssh-command-rule-body">
                    <code class="ssh-command-text" :title="rule.command">{{ rule.command }}</code>
                    <span class="ssh-command-target">{{
                      rule.sshLabel || sshProfileLabel(rule.sshProfileId)
                    }}</span>
                  </div>
                  <button
                    class="ssh-command-delete"
                    title="删除始终允许规则"
                    @click="removeSshCommandPermission(rule.id)"
                  >
                    <Trash2 :size="13" />
                  </button>
                </div>
              </div>
            </div>
          </section>
        </template>

        <template v-else-if="settingsTab === 'shortcuts'">
          <section class="settings-section">
            <header class="settings-section-header">
              <Keyboard :size="14" class="settings-section-icon" />
              <h3 class="settings-section-title">快捷键</h3>
            </header>
            <p class="settings-item-desc" style="margin-top: -8px">
              点击快捷键进入录制模式,按下组合键即可更改。录制时按 Esc 取消。
            </p>
            <div class="shortcut-list">
              <div v-for="def in SHORTCUT_DEFS" :key="def.action" class="shortcut-row">
                <span class="shortcut-label">{{ def.label }}</span>
                <div class="shortcut-keys">
                  <template v-if="recordingAction === def.action">
                    <span class="shortcut-recording">按下组合键...</span>
                  </template>
                  <template v-else>
                    <span
                      class="shortcut-kbd"
                      :class="{
                        modified: effectiveShortcuts[def.action] !== def.defaultKeys
                      }"
                      @click="startRecording(def.action)"
                    >
                      <span
                        v-for="(part, i) in displayShortcutParts(effectiveShortcuts[def.action])"
                        :key="i"
                        class="shortcut-key-chip"
                      >
                        {{ part }}
                      </span>
                    </span>
                  </template>
                  <button
                    v-if="effectiveShortcuts[def.action] !== def.defaultKeys"
                    class="shortcut-reset"
                    title="恢复默认"
                    @click="resetShortcut(def.action)"
                  >
                    <RotateCcw :size="12" />
                  </button>
                </div>
              </div>
            </div>

            <header class="settings-section-header" style="margin-top: 20px">
              <Mic :size="14" class="settings-section-icon" />
              <h3 class="settings-section-title">语音输入</h3>
            </header>
            <p class="settings-item-desc" style="margin-top: -8px">
              按住该键说话,松开后自动识别并粘贴文本。建议设置为 F2-F12 等不与终端交互冲突的按键。
            </p>
            <div class="shortcut-list">
              <div class="shortcut-row">
                <span class="shortcut-label">按下说话</span>
                <div class="shortcut-keys">
                  <template v-if="recordingVoice">
                    <span class="shortcut-recording">按下按键...</span>
                  </template>
                  <template v-else>
                    <span
                      class="shortcut-kbd"
                      :class="{ modified: voiceShortcut !== 'F2' }"
                      @click="startVoiceRecording"
                    >
                      <span
                        v-for="(part, i) in displayShortcutParts(voiceShortcut)"
                        :key="i"
                        class="shortcut-key-chip"
                      >
                        {{ part }}
                      </span>
                    </span>
                    <button
                      v-if="voiceShortcut !== 'F2'"
                      class="shortcut-reset"
                      title="恢复默认"
                      @click="onVoiceShortcutChange('F2')"
                    >
                      <RotateCcw :size="12" />
                    </button>
                  </template>
                </div>
              </div>
            </div>
          </section>
        </template>

        <template v-else>
          <section class="settings-section">
            <header class="settings-section-header">
              <Info :size="14" class="settings-section-icon" />
              <h3 class="settings-section-title">关于</h3>
            </header>
            <div class="about-block">
              <div class="about-logo">Troupe</div>
              <div class="about-tagline">Git + tmux 风格的终端模拟器</div>
            </div>
            <dl class="about-list">
              <div class="about-row">
                <dt>版本</dt>
                <dd>{{ appVersion ? `v${appVersion}` : '—' }}</dd>
              </div>
              <div class="about-row">
                <dt>Electron</dt>
                <dd>{{ electronVersion || '—' }}</dd>
              </div>
              <div class="about-row">
                <dt>配置文件</dt>
                <dd class="mono">~/.troupe/settings.json</dd>
              </div>
            </dl>
            <div class="about-update">
              <button
                class="about-update-btn"
                :disabled="updateChecking || updateProgress !== null"
                @click="updateReady ? installUpdate() : checkForUpdate()"
              >
                {{ updateReady ? '安装新版本' : updateChecking ? '检查中…' : '检查更新' }}
              </button>
              <span v-if="updateProgress !== null" class="about-update-progress">
                下载中 {{ updateProgress }}%
              </span>
              <span v-if="updateResult" class="about-update-result">{{ updateResult }}</span>
            </div>
          </section>
        </template>
      </div>
    </div>
  </el-drawer>
  <TasksDrawer
    v-model="showTasks"
    :width="tasksDrawerWidth"
    @width-change="onTasksDrawerWidthChange"
    @edit-task="(id: string, cwd?: string) => openTaskManager(id, cwd ?? null)"
  />
  <TaskManagerDialog
    v-model="showTaskMgr"
    :focus-id="taskMgrFocusId"
    :default-cwd="activeCwd"
    :scope-cwd="taskMgrScopeCwd"
    :new-draft="taskMgrNewDraft"
  />
  <el-dialog v-model="showSshDialog" title="SSH 远程终端" width="680px" class="ssh-dialog">
    <div class="ssh-dialog-content">
      <aside class="ssh-profile-panel">
        <div class="ssh-profile-heading">
          <span>已保存连接</span>
          <button class="ssh-profile-create" title="新建连接" @click="createSshProfile">
            <Plus :size="14" />
          </button>
        </div>
        <div class="ssh-profile-list">
          <button
            v-for="profile in sshProfiles"
            :key="profile.id"
            class="ssh-profile-item"
            :class="{ active: sshDraft.id === profile.id }"
            @click="useSshProfile(profile)"
          >
            <Server :size="14" />
            <span class="ssh-profile-details">
              <strong>{{ profile.name || `${profile.username}@${profile.host}` }}</strong>
              <small>{{ profile.username }}@{{ profile.host }}:{{ profile.port }}</small>
            </span>
          </button>
          <div v-if="!sshProfiles.length" class="ssh-profile-empty">暂无已保存连接</div>
        </div>
      </aside>
      <div class="ssh-profile-editor">
        <div class="ssh-profile-editor-heading">
          <span>{{
            sshProfiles.some((profile) => profile.id === sshDraft.id) ? '编辑连接' : '新建连接'
          }}</span>
          <button
            v-if="sshProfiles.some((profile) => profile.id === sshDraft.id)"
            class="ssh-profile-delete"
            title="删除当前连接"
            @click="deleteSshProfile(sshDraft.id)"
          >
            <Trash2 :size="14" />
          </button>
        </div>
        <el-form label-position="top" class="ssh-form" @submit.prevent>
          <el-form-item label="名称">
            <el-input v-model="sshDraft.name" placeholder="生产机 / 测试机" />
          </el-form-item>
          <div class="ssh-form-grid">
            <el-form-item label="Host">
              <el-input v-model="sshDraft.host" placeholder="example.com" />
            </el-form-item>
            <el-form-item label="Port">
              <el-input-number
                v-model="sshDraft.port"
                :min="1"
                :max="65535"
                controls-position="right"
              />
            </el-form-item>
          </div>
          <div class="ssh-form-grid ssh-credentials-grid">
            <el-form-item label="Username">
              <el-input v-model="sshDraft.username" placeholder="root / ubuntu / deploy" />
            </el-form-item>
            <el-form-item label="Password">
              <el-input
                v-model="sshDraft.password"
                type="password"
                show-password
                :placeholder="sshDraft.hasPassword ? '使用已保存密码' : '可选'"
              />
            </el-form-item>
          </div>
          <el-form-item label="远程目录">
            <el-input v-model="sshDraft.remoteCwd" placeholder="可选，如 /srv/app" />
          </el-form-item>
        </el-form>
      </div>
    </div>
    <template #footer>
      <div class="ssh-dialog-actions">
        <button class="dialog-secondary-btn" @click="showSshDialog = false">取消</button>
        <button
          class="dialog-primary-btn"
          :disabled="sshConnecting || !sshDraft.host.trim() || !sshDraft.username.trim()"
          @click="connectSsh"
        >
          {{ sshConnecting ? '连接中...' : '连接' }}
        </button>
      </div>
    </template>
  </el-dialog>
  <div class="workbench-root">
    <AgentSessionsDrawer
      v-if="unifiedAgentSessions"
      v-model="showAgentSessions"
      @open-session="openAgentSession"
    />
    <div
      ref="containerRef"
      class="layout-root"
      :class="{ dragging: !!dragState, 'pane-dragging': !!paneDrag }"
    >
      <template v-if="cwd !== null && layout">
        <div
          v-for="pane in layoutResult.panes"
          :key="pane.id"
          class="pane-slot"
          :class="{ active: pane.id === activeId }"
          :style="rectStyle(pane.rect)"
        >
          <TerminalView
            :ref="(instance: unknown) => setTerminalRef(pane.id, instance)"
            :pane-id="pane.id"
            :cwd="paneCwd[pane.id] ?? cwd"
            :ssh-profile-id="paneSshProfileId(pane.id)"
            :ssh-profile-name="sshProfileLabel(paneSshProfileId(pane.id))"
            :font-size="appFontSize"
            :scrollback="appScrollback"
            :shortcuts="shortcutOverrides"
            :stt-language="sttLanguage"
            :stt-device-id="sttDeviceId"
            :voice-shortcut="voiceShortcut"
            :is-active="pane.id === activeId"
            @focus="setActive"
            @split="onSplit"
            @close="onClose"
            @pane-drag-start="onPaneDragStart"
            @focus-neighbor="focusNeighbor"
            @create-worktree="onCreateWorktree"
            @cwd-change="onCwdChange"
            @font-size-change="onFontSizeChange"
            @open-settings="showSettings = true"
            @manage-tasks="(cwd?: string, nd?: boolean) => openTaskManager(null, cwd ?? null, !!nd)"
            @open-agent-session="openAgentSession"
          />
        </div>
        <div
          v-for="(d, i) in layoutResult.dividers"
          :key="`divider-${i}`"
          class="divider"
          :class="d.direction"
          :style="rectStyle(d.rect)"
          @mousedown="(e) => onDividerDown(e, i)"
          @dblclick="(e) => onDividerDoubleClick(e, i)"
        ></div>
        <template v-if="paneDrag">
          <div v-if="draggedRect" class="pane-drag-source" :style="rectStyle(draggedRect)"></div>
          <div
            v-if="dropIndicatorRect"
            class="pane-drop-indicator"
            :style="rectStyle(dropIndicatorRect)"
          ></div>
        </template>
      </template>
    </div>
  </div>
</template>

<style lang="scss">
.title-bar {
  height: $titlebar-h;
  background: var(--el-bg-color-page);
  border-bottom: 1px solid var(--el-border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 6px 0 10px;
  -webkit-app-region: drag;
  user-select: none;

  &.mac {
    padding-left: 78px;
  }
}

.title-bar-text {
  color: var(--el-text-color-primary);
  font-size: 13px;
  font-weight: 700;
  @include ui-font;
}

.title-bar-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.title-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.title-workspace {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: min(360px, 32vw);
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 7px;
  background: var(--el-bg-color);
  color: var(--el-text-color-secondary);
  font-size: 11px;
  -webkit-app-region: no-drag;
  @include ui-font;
}

.title-workspace-name {
  min-width: 0;
  overflow: hidden;
  color: var(--el-text-color-regular);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.title-update-progress,
.about-update-progress {
  color: var(--el-color-primary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  @include ui-font;
}

.title-install-update {
  @include btn-reset;
  height: 22px;
  padding: 0 9px;
  border: 1px solid color-mix(in srgb, var(--el-color-success) 55%, transparent);
  border-radius: $radius;
  background: color-mix(in srgb, var(--el-color-success) 10%, transparent);
  color: var(--el-color-success);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  -webkit-app-region: no-drag;
  @include ui-font;

  &:hover {
    background: color-mix(in srgb, var(--el-color-success) 18%, transparent);
  }
}

.title-bar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  -webkit-app-region: no-drag;
}

.title-action-group {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  height: 30px;
  padding: 1px 2px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 7px;
  background: var(--el-bg-color);
}

.title-bar-controls {
  display: flex;
  margin-left: 0;
  padding-left: 0;
  border-left: 0;
}

.tb-folder,
.tb-settings {
  color: var(--el-text-color-secondary);

  &:hover {
    color: var(--el-text-color-primary);
  }
}

.tb-btn {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 26px;
  color: var(--el-text-color-secondary);
  border-radius: 5px;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;

  &:hover {
    background: var(--el-fill-color);
    color: var(--el-text-color-primary);
  }

  &:active {
    background: color-mix(in srgb, var(--el-text-color-primary) 13%, transparent);
  }
}

.tb-close:hover {
  background: var(--el-color-danger);
  color: #fff;
}

.workbench-root {
  display: flex;
  width: 100%;
  height: calc(100vh - #{$titlebar-h});
  background: var(--el-bg-color-page);
  overflow: hidden;
}

.layout-root {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 100%;
  background: var(--el-bg-color-page);

  &.dragging {
    user-select: none;
    cursor: inherit;
  }

  &.pane-dragging,
  &.pane-dragging * {
    cursor: grabbing !important;
    user-select: none;
  }
}

.pane-drag-source {
  position: absolute;
  z-index: 2;
  background: var(--el-bg-color);
  opacity: 0.45;
  pointer-events: none;
}

.pane-drop-indicator {
  position: absolute;
  z-index: 3;
  background: color-mix(in srgb, var(--el-color-primary) 28%, transparent);
  border: 2px solid var(--el-color-primary);
  border-radius: $radius;
  pointer-events: none;
  transition:
    left 0.08s,
    top 0.08s,
    width 0.08s,
    height 0.08s;
}

.pane-slot {
  position: absolute;
  overflow: clip;
  box-sizing: border-box;
  background: var(--el-bg-color);
  border-radius: 3px;
  box-shadow: inset 0 0 0 1px var(--el-border-color);
  transition: box-shadow 0.14s ease;

  &.active {
    box-shadow:
      inset 0 0 0 1px var(--el-color-primary),
      0 0 0 1px color-mix(in srgb, var(--el-color-primary) 18%, transparent);

    .pane-toolbar {
      background: color-mix(in srgb, var(--el-color-primary) 7%, var(--el-bg-color-overlay));
      box-shadow: inset 0 -1px 0 var(--el-border-color);
    }

    .pane-location-name {
      color: var(--el-text-color-primary);
    }

    .pane-location {
      border-color: color-mix(in srgb, var(--el-color-primary) 44%, var(--el-border-color));
    }
  }
}

.divider {
  position: absolute;
  background: var(--el-bg-color-page);
  z-index: 1;
  transition: background-color 0.14s ease;

  &:hover {
    background: color-mix(in srgb, var(--el-color-primary) 75%, var(--el-bg-color-page));
  }

  .dragging & {
    background: var(--el-color-primary);
  }

  &.row {
    cursor: col-resize;
  }

  &.column {
    cursor: row-resize;
  }
}

@media (max-width: 860px) {
  .title-workspace {
    max-width: 180px;
  }
}

@media (max-width: 700px) {
  .title-workspace {
    display: none;
  }

  .title-bar-right {
    gap: 3px;
  }
}

/* --- Update check (关于页) ----------------------------------------------- */

.about-update {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}

.about-update-btn {
  @include btn-reset;
  padding: 4px 14px;
  font-size: 12px;
  border-radius: $radius;
  color: var(--el-color-primary);
  border: 1px solid var(--el-color-primary);
  background: transparent;
  cursor: pointer;
  transition: background 0.1s;

  &:hover:not(:disabled) {
    background: color-mix(in srgb, var(--el-color-primary) 8%, transparent);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.about-update-result {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* --- Settings drawer ----------------------------------------------------- */

.settings-drawer {
  &.el-drawer {
    background: var(--el-bg-color);
  }

  .el-drawer__body {
    padding: 0;
    background: var(--el-bg-color);
  }
}

.settings-layout {
  display: flex;
  height: 100%;
  @include ui-font;
}

.settings-sidebar {
  width: 196px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--el-bg-color-overlay) 74%, var(--el-bg-color-page));
  border-right: 1px solid var(--el-border-color-light);
  padding: 18px 0;
}

.settings-sidebar-title {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--el-text-color-secondary);
  padding: 0 18px 16px;
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 6px;
}

.settings-nav-item {
  @include btn-reset;
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  width: 100%;
  min-height: 36px;
  padding: 7px 12px;
  color: var(--el-text-color-regular);
  font-size: 12px;
  border-radius: 7px;

  &:hover {
    background: var(--el-fill-color);
  }

  &.active {
    background: color-mix(in srgb, var(--el-color-primary) 12%, transparent);
    color: var(--el-color-primary);
    box-shadow: inset 2px 0 0 var(--el-color-primary);
  }
}

.settings-nav-icon {
  flex-shrink: 0;
  opacity: 0.85;
}

.settings-panel {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 30px 34px;
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.settings-section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 9px;
  border-bottom: 1px solid var(--el-border-color-light);
}

.settings-section-icon {
  color: var(--el-text-color-secondary);
}

.settings-section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--el-text-color-secondary);
}

.settings-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.settings-item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 32px;

  /* 设置面板下拉框:统一小号字体、紧凑间距 */
  .el-select {
    --el-font-size-base: 12px;

    .el-input__inner {
      font-size: 12px;
      height: 26px;
      line-height: 26px;
    }
  }
}

.settings-item-label {
  font-size: 13px;
  color: var(--el-text-color-primary);
}

.settings-item-desc {
  margin: 0;
  font-size: 11.5px;
  color: var(--el-text-color-secondary);
  line-height: 1.55;
}

.settings-copy-btn {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: $radius-sm;
  color: var(--el-text-color-secondary);
  flex-shrink: 0;

  &:hover {
    background: var(--el-fill-color);
    color: var(--el-color-primary);
  }
}

.settings-cmd {
  @include mono-font;
  display: block;
  margin-top: 2px;
  padding: 6px 8px;
  background: var(--el-fill-color-lighter);
  border-radius: $radius-sm;
  font-size: 11px;
  color: var(--el-text-color-regular);
  word-break: break-all;
  line-height: 1.5;
  user-select: all;
}

.ssh-permission-empty {
  padding: 18px 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  text-align: center;
}

.ssh-permission-directory {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 0 14px;
  border-bottom: 1px solid var(--el-border-color-lighter);

  &:last-child {
    padding-bottom: 0;
    border-bottom: 0;
  }
}

.ssh-permission-heading {
  display: flex;
  align-items: center;
  gap: 12px;

  .el-select {
    flex: 0 0 130px;
  }
}

.ssh-permission-path {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--el-text-color-primary);
  font-size: 11.5px;
  @include mono-font;
}

.ssh-command-rules {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--el-border-color-lighter);
}

.ssh-command-rule {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 6px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);

  &:last-child {
    border-bottom: 0;
  }
}

.ssh-command-rule-body {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ssh-command-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--el-text-color-regular);
  font-size: 11px;
  @include mono-font;
}

.ssh-command-target {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--el-text-color-secondary);
  font-size: 10.5px;
}

.ssh-command-delete {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  border-radius: $radius-sm;
  color: var(--el-text-color-secondary);

  &:hover {
    color: var(--el-color-danger);
    background: color-mix(in srgb, var(--el-color-danger) 8%, transparent);
  }
}

/* 下拉选项 popper(el-select 默认 append-to-body,必须全局命中) */
.el-popper.settings-select-popper .el-select-dropdown__item {
  font-size: 12px;
  padding: 4px 12px;
  height: auto;
  line-height: 1.5;
}

.font-size-control {
  display: flex;
  align-items: center;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color);
  border-radius: $radius;
  padding: 2px;
  gap: 2px;
}

.fs-btn {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  color: var(--el-text-color-primary);
  font-size: 14px;
  border-radius: $radius-sm;

  &:hover:not(:disabled) {
    background: var(--el-fill-color);
  }

  &:disabled {
    color: var(--el-text-color-disabled);
    cursor: not-allowed;
  }
}

.fs-value {
  min-width: 28px;
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}

.fs-reset {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  color: var(--el-text-color-secondary);
  border-radius: $radius-sm;
  margin-left: 4px;

  &:hover {
    background: var(--el-fill-color);
    color: var(--el-text-color-primary);
  }
}

.about-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: 8px;
}

.about-logo {
  font-size: 22px;
  color: var(--el-text-color-primary);
  font-weight: 600;
  letter-spacing: 0;
}

.about-tagline {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.about-list {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.about-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 12px;
  margin: 0;

  dt {
    color: var(--el-text-color-primary);
    font-weight: normal;
  }

  dd {
    margin: 0;
    color: var(--el-text-color-secondary);
  }

  .mono {
    @include mono-font;
    font-size: 11px;
  }
}

/* Shortcut list */
.shortcut-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.shortcut-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  min-height: 32px;

  & + & {
    border-top: 1px solid var(--el-border-color-light);
  }
}

.shortcut-label {
  font-size: 13px;
  color: var(--el-text-color-primary);
  flex-shrink: 0;
}

.shortcut-keys {
  display: flex;
  align-items: center;
  gap: 6px;
}

.shortcut-kbd {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  padding: 2px 3px;
  border-radius: $radius;
  border: 1px solid transparent;
  transition:
    border-color 0.12s,
    background 0.12s;

  &:hover {
    border-color: var(--el-border-color);
    background: var(--el-fill-color);
  }

  &.modified .shortcut-key-chip {
    border-color: var(--el-color-primary);
  }
}

.shortcut-key-chip {
  display: inline-block;
  font-size: 11px;
  @include mono-font;
  background: var(--el-fill-color);
  border: 1px solid var(--el-border-color);
  border-radius: $radius-sm;
  padding: 1px 6px;
  color: var(--el-text-color-primary);
}

.shortcut-recording {
  font-size: 12px;
  color: var(--el-color-primary);
  animation: shortcut-pulse 1.2s ease-in-out infinite;
}

@keyframes shortcut-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

.shortcut-reset {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  color: var(--el-text-color-secondary);
  border-radius: $radius-sm;
  flex-shrink: 0;

  &:hover {
    background: var(--el-fill-color);
    color: var(--el-text-color-primary);
  }
}

.ssh-dialog {
  &.el-dialog {
    border: 1px solid var(--el-border-color);
    border-radius: 8px;
  }

  .el-dialog__body {
    padding: 0;
  }
}

.ssh-dialog-content {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  min-height: 370px;
  border-top: 1px solid var(--el-border-color-light);
  border-bottom: 1px solid var(--el-border-color-light);
}

.ssh-profile-panel {
  min-width: 0;
  padding: 16px 10px;
  border-right: 1px solid var(--el-border-color-light);
  background: var(--el-fill-color-lighter);
}

.ssh-profile-heading,
.ssh-profile-editor-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  color: var(--el-text-color-secondary);
  font-size: 11px;
  font-weight: 600;
  @include ui-font;
}

.ssh-profile-heading {
  padding: 0 6px 8px;
}

.ssh-profile-create,
.ssh-profile-delete {
  @include btn-reset;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: $radius;
  color: var(--el-text-color-secondary);
  cursor: pointer;
}

.ssh-profile-create:hover {
  color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 8%, transparent);
}

.ssh-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.ssh-profile-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 330px;
  overflow-y: auto;
}

.ssh-profile-item,
.dialog-secondary-btn,
.dialog-primary-btn {
  @include btn-reset;
}

.ssh-profile-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 48px;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: $radius;
  color: var(--el-text-color-primary);
  background: transparent;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  @include ui-font;

  &:hover,
  &.active {
    border-color: var(--el-color-primary);
    background: color-mix(in srgb, var(--el-color-primary) 8%, transparent);
  }

  &.active > svg {
    color: var(--el-color-primary);
  }
}

.ssh-profile-details {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;

  strong,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    font-size: 12px;
    font-weight: 600;
  }

  small {
    color: var(--el-text-color-secondary);
    font-size: 10px;
  }
}

.ssh-profile-empty {
  padding: 18px 6px;
  color: var(--el-text-color-placeholder);
  font-size: 11px;
  text-align: center;
  @include ui-font;
}

.ssh-profile-editor {
  min-width: 0;
  padding: 16px 22px 6px;
}

.ssh-profile-editor-heading {
  margin-bottom: 10px;

  .ssh-profile-delete:hover {
    color: var(--el-color-danger);
    background: color-mix(in srgb, var(--el-color-danger) 8%, transparent);
  }
}

.ssh-form {
  .el-form-item {
    margin-bottom: 18px;
  }

  .el-form-item__label {
    height: auto;
    margin-bottom: 6px;
    color: var(--el-text-color-secondary);
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
  }
}

.ssh-form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 118px;
  gap: 14px;
}

.ssh-credentials-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.dialog-secondary-btn,
.dialog-primary-btn {
  min-width: 76px;
  height: 32px;
  padding: 0 16px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  @include ui-font;
}

.dialog-secondary-btn {
  color: var(--el-text-color-primary);
  border: 1px solid var(--el-border-color);
  background: var(--el-bg-color);

  &:hover {
    background: var(--el-fill-color-dark);
    border-color: var(--el-border-color-dark);
  }
}

.dialog-primary-btn {
  border: 1px solid var(--el-color-primary);
  color: var(--el-bg-color-page);
  background: var(--el-color-primary);

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}
</style>
