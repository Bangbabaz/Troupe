<script setup lang="ts">
import { ref, shallowRef, watch, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { enableWebglRenderer, waitForTerminalFonts } from '../utils/xtermRenderer'
import { TerminalInputHandler } from '../utils/terminalKeyboard'
import { ElMessageBox } from 'element-plus'
import {
  Play,
  Square,
  RotateCw,
  Pencil,
  Trash2,
  Search,
  X,
  FolderOpen,
  Terminal as TerminalIcon,
  ChevronDown,
  ChevronRight,
  Activity
} from 'lucide-vue-next'
import SearchOverlay from './SearchOverlay.vue'
import { useTheme } from '../composables/useTheme'
import { useTasks } from '../composables/useTasks'
import type { TaskDataPayload, TaskMeta } from '@shared/types'
import '@xterm/xterm/css/xterm.css'

const { xtermTheme } = useTheme()
const platform =
  (window.electron as unknown as { process?: { platform?: string } }).process?.platform ?? ''
const terminalInput = new TerminalInputHandler(platform)

const props = defineProps<{
  modelValue: boolean
  width: number
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'editTask', id: string, cwd: string): void
  (e: 'widthChange', width: number): void
}>()

// el-drawer (Element Plus 2.14) drag-to-resize: it emits the final px size on
// resize-end; App owns the value, clamps + persists it, and feeds it back via
// the `width` prop.
function onResizeEnd(_e: MouseEvent, size: number): void {
  emit('widthChange', size)
}

// 任务列表 + 选中状态来自全局 useTasks() —— 跨 TaskRunner / TasksDrawer 共享
// 一份 reactive ref。selectedId 变化时 watch 自动 bindLog。
const { allTasks: tasks, ready: tasksReady, selectedId, selectTask: setSelectedId } = useTasks()

const selectedTask = computed(() => tasks.value.find((t) => t.id === selectedId.value) || null)
const runningTaskCount = computed(
  () => tasks.value.filter((task) => task.status === 'running').length
)

// --- 任务按 cwd 分组 -----------------------------------------------------
// TasksDrawer 是"统一管理"入口 —— 全部任务都在这里。按 cwd 分组让用户一眼区分
// 同名命令在不同项目里(`npm run dev` in projectA vs projectB)。分组头只显示
// 文件夹尾段名,完整路径放 title;task row 内部不再重复显示 cwd,避免文本拥挤。
interface TaskGroup {
  key: string // normalize 过的 cwd,空 = 未指定
  display: string // 尾段文件夹名,展示用
  fullPath: string // hover title
  tasks: TaskMeta[]
}

const normPath = (p: string | undefined | null): string => {
  if (!p) return ''
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(s)) s = s.toLowerCase()
  return s
}

const lastSegment = (p: string): string => {
  const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

const taskGroups = computed<TaskGroup[]>(() => {
  const map = new Map<string, TaskGroup>()
  for (const t of tasks.value) {
    const k = normPath(t.cwd)
    let g = map.get(k)
    if (!g) {
      g = {
        key: k,
        display: k ? lastSegment(t.cwd) : '未指定工作目录',
        fullPath: t.cwd || '未指定工作目录',
        tasks: []
      }
      map.set(k, g)
    }
    g.tasks.push(t)
  }
  const out = Array.from(map.values())
  // 排序:尾段文件夹名字典序;未指定 cwd 的分组排最末
  out.sort((a, b) => {
    if (a.key === '' && b.key !== '') return 1
    if (b.key === '' && a.key !== '') return -1
    return a.display.localeCompare(b.display)
  })
  return out
})

// 折叠集合 —— normalize 过的 cwd 作 key,集合内即折叠。默认全部展开。
// 当前 selected task 所在分组不允许折叠(否则用户看不见选中行)。
const collapsedGroups = ref<Set<string>>(new Set())

function toggleGroup(g: TaskGroup): void {
  const next = new Set(collapsedGroups.value)
  if (next.has(g.key)) next.delete(g.key)
  else next.add(g.key)
  collapsedGroups.value = next
}

function isGroupCollapsed(g: TaskGroup): boolean {
  if (selectedTask.value && normPath(selectedTask.value.cwd) === g.key) return false
  return collapsedGroups.value.has(g.key)
}

const statusText: Record<TaskMeta['status'], string> = {
  idle: '未运行',
  running: '运行中',
  exited: '已退出',
  failed: '失败'
}

// --- Log viewer (one shared xterm, re-bound on selection) -----------------
const logRef = ref<HTMLDivElement>()
let term: Terminal | null = null
let termTextarea: HTMLTextAreaElement | null = null
let fit: FitAddon | null = null
let logResizeObserver: ResizeObserver | null = null
let bindGeneration = 0
let renderedSequence = 0
let loadingSnapshot: { id: string; generation: number; pending: TaskDataPayload[] } | null = null

// Log search overlay. The box, query, count and highlight logic live in the
// shared SearchOverlay; here we only own the visibility and the addon ref it
// drives (shallow — it's a class instance, no deep reactivity wanted).
const showLogSearch = ref(false)
const searchAddon = shallowRef<SearchAddon | null>(null)

// Push the viewer's grid size to the selected *running* task's PTY so
// full-screen TUIs (Next.js overlay, vite menu, prompts) render aligned.
function syncTaskSize(): void {
  if (!term) return
  const id = selectedId.value
  if (!id) return
  const t = tasks.value.find((x) => x.id === id)
  if (t && t.status === 'running' && term.cols > 0 && term.rows > 0) {
    window.api.taskResize(id, term.cols, term.rows)
  }
}

function focusTerm(): void {
  term?.focus()
}

function writeSelectedTaskInput(data: string): void {
  const id = selectedId.value
  const task = tasks.value.find((x) => x.id === id)
  if (id && task?.status === 'running') window.api.taskInput(id, data)
}

function onTaskBeforeInput(event: Event): void {
  const e = event as InputEvent
  const action = terminalInput.handleBeforeInput(e)
  if (action === null) return
  e.preventDefault()
  if (termTextarea) termTextarea.value = ''
  if (action.data !== null) writeSelectedTaskInput(action.data)
}

function onTaskInput(event: Event): void {
  const e = event as InputEvent
  const action = terminalInput.handleInput(e)
  if (action === null) return
  if (termTextarea) termTextarea.value = ''
  if (action.data !== null) writeSelectedTaskInput(action.data)
}

const onTaskCompositionStart = (): void => terminalInput.compositionStart()
const onTaskInputBlur = (): void => terminalInput.reset()

function scheduleTaskNativeInputFallback(fallbackId: number): void {
  setTimeout(() => {
    const data = terminalInput.takeNativeInputFallback(fallbackId)
    if (data) writeSelectedTaskInput(data)
  }, 30)
}

function onTaskCompositionEnd(): void {
  terminalInput.compositionEnd()
}

function ensureTerm(): void {
  if (term || !logRef.value) return
  term = new Terminal({
    fontSize: 12,
    lineHeight: 1.2,
    fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Menlo, Consolas, monospace",
    cursorBlink: false,
    convertEol: true,
    // Required for SearchAddon match decorations (the highlight background)
    // to render — same as the terminal panes.
    allowProposedApi: true,
    theme: xtermTheme.value
  })
  fit = new FitAddon()
  const sa = new SearchAddon({ highlightLimit: 200 })
  searchAddon.value = sa
  term.loadAddon(fit)
  term.loadAddon(sa)
  term.open(logRef.value)
  termTextarea = term.textarea ?? null
  termTextarea?.addEventListener('beforeinput', onTaskBeforeInput)
  termTextarea?.addEventListener('input', onTaskInput)
  termTextarea?.addEventListener('compositionstart', onTaskCompositionStart)
  termTextarea?.addEventListener('compositionend', onTaskCompositionEnd)
  termTextarea?.addEventListener('blur', onTaskInputBlur)
  enableWebglRenderer(term)
  void waitForTerminalFonts().then(() => {
    if (!term || !logRef.value?.isConnected) return
    try {
      fit?.fit()
    } catch {
      return
    }
    term.refresh(0, term.rows - 1)
    syncTaskSize()
  })
  // Interactive: forward keystrokes/paste to whichever task is selected AND
  // running. The one terminal is reused across tasks, so resolve the target
  // at call time; idle/exited tasks are no-ops (backend guards too).
  term.attachCustomKeyEventHandler((e) => {
    const inputAction = terminalInput.handleKeyEvent(e)
    if (inputAction?.kind === 'write') {
      e.preventDefault()
      writeSelectedTaskInput(inputAction.data)
      return false
    }
    if (inputAction?.kind === 'native-input') {
      if (inputAction.fallbackId !== undefined) {
        scheduleTaskNativeInputFallback(inputAction.fallbackId)
      }
      return false
    }
    return true
  })
  term.onData((d) => {
    terminalInput.observeData(d)
    writeSelectedTaskInput(d)
  })
  logResizeObserver = new ResizeObserver(() => {
    try {
      fit?.fit()
    } catch {
      return // element hidden / detached
    }
    syncTaskSize()
  })
  logResizeObserver.observe(logRef.value)
}

async function bindLog(id: string | null): Promise<void> {
  ensureTerm()
  if (!term) return
  const generation = ++bindGeneration
  term.reset()
  renderedSequence = 0
  loadingSnapshot = id ? { id, generation, pending: [] } : null
  if (!id) return
  const snapshot = await window.api.taskOutput(id)
  if (selectedId.value !== id || generation !== bindGeneration) return
  if (snapshot.output) term.write(snapshot.output)
  renderedSequence = snapshot.sequence
  const pending = loadingSnapshot?.generation === generation ? loadingSnapshot.pending : []
  loadingSnapshot = null
  for (const event of pending) {
    if (event.sequence <= renderedSequence) continue
    term.write(event.chunk)
    renderedSequence = event.sequence
  }
  await nextTick()
  try {
    fit?.fit()
  } catch {
    // ignore
  }
  syncTaskSize()
}

// 选择任务并绑定日志。TasksDrawer 独有日志绑定行为,不放在 composable 里。
function selectAndBind(id: string): void {
  setSelectedId(id)
  bindLog(id)
}

// Fired after the drawer's open transition finishes (so the log element has
// real dimensions). Element Plus's focus trap auto-focuses a header button on
// every open and nothing else ever moves focus into the xterm, so on the
// 2nd+ open the terminal stayed unfocused and keystrokes never reached the
// task. Refit to the now-correct size and explicitly focus the terminal so it
// is interactive immediately, every open.
function onDrawerOpened(): void {
  ensureTerm()
  if (!term) return
  try {
    fit?.fit()
  } catch {
    // element not measurable yet — harmless
  }
  syncTaskSize()
  term.focus()
}

// 任务列表的 fetch + upsert + remove 都由 useTasks 集中做。这里只订阅 drawer
// 自己关心的"副作用"流:
//   - onTaskData    流式输出 → 写当前选中的 log viewer
//   - onTaskStatus  仅用来在选中 task 切换到 running 时同步 PTY 网格尺寸
//   - onTaskCleared 重置 log viewer(re-run 后老 buffer 不该残留在屏上)
//   - onTaskRemoved 只清 drawer 私有的 selectedId / log 绑定;列表 filter 在
//                   useTasks 内,这里不重复
let unsubData: (() => void) | null = null
let unsubStatus: (() => void) | null = null
let unsubCleared: (() => void) | null = null
let unsubRemoved: (() => void) | null = null

onMounted(() => {
  unsubData = window.api.onTaskData((payload) => {
    if (payload.id !== selectedId.value || !term) return
    if (loadingSnapshot?.id === payload.id) {
      loadingSnapshot.pending.push(payload)
      return
    }
    if (payload.sequence <= renderedSequence) return
    term.write(payload.chunk)
    renderedSequence = payload.sequence
  })
  unsubStatus = window.api.onTaskStatus((meta) => {
    // A task we're viewing just started — match its PTY to the viewer size.
    if (meta.id === selectedId.value && meta.status === 'running') syncTaskSize()
  })
  unsubCleared = window.api.onTaskCleared(({ id }) => {
    if (id === selectedId.value && term) term.reset()
  })
  unsubRemoved = window.api.onTaskRemoved(({ id }) => {
    // selectedId 清理由 composable 的 watch(allTasks) 负责。
    // 这里只负责清 xterm 显示,避免残留已删除任务的日志。
    if (selectedId.value === id) {
      bindLog(null)
    }
  })
})

onUnmounted(() => {
  unsubData?.()
  unsubStatus?.()
  unsubCleared?.()
  unsubRemoved?.()
  logResizeObserver?.disconnect()
  termTextarea?.removeEventListener('beforeinput', onTaskBeforeInput)
  termTextarea?.removeEventListener('input', onTaskInput)
  termTextarea?.removeEventListener('compositionstart', onTaskCompositionStart)
  termTextarea?.removeEventListener('compositionend', onTaskCompositionEnd)
  termTextarea?.removeEventListener('blur', onTaskInputBlur)
  terminalInput.reset()
  termTextarea = null
  term?.dispose()
})

// Drawer opened → 等 useTasks ready、init term、fit、bind log if selected。
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) {
      terminalInput.reset()
      return
    }
    await tasksReady
    await nextTick()
    ensureTerm()
    if (selectedId.value) {
      bindLog(selectedId.value)
    }
    try {
      fit?.fit()
    } catch {
      // ignore
    }
    syncTaskSize()
  }
)

// 当选中任务在 drawer 打开期间变化时,自动绑定日志。关闭时不触发(节省 IO)。
watch(selectedId, (id) => {
  if (props.modelValue) bindLog(id)
})

// Re-theme the shared log terminal when the app theme changes.
watch(xtermTheme, (t) => {
  if (term) term.options.theme = t
})

// Command CRUD lives in the manager dialog (App-owned). The drawer just
// surfaces entry points and per-row run/stop controls.
function editTask(t: TaskMeta): void {
  emit('editTask', t.id, t.cwd)
}

async function toggleTask(t: TaskMeta): Promise<void> {
  if (t.status === 'running') {
    await window.api.taskStop(t.id)
  } else {
    await window.api.taskStart({ id: t.id })
    selectAndBind(t.id)
  }
}

async function restartTask(t: TaskMeta): Promise<void> {
  await window.api.taskRestart(t.id)
  selectAndBind(t.id)
}

async function removeTask(t: TaskMeta): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除任务 "${t.name}"？运行中的进程会被结束。`, '删除任务', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  await window.api.taskRemove(t.id)
}

function clearLog(): void {
  term?.reset()
}

// --- Log search -----------------------------------------------------------
// SearchOverlay owns query/count/highlight; it clears its decorations on
// unmount, so close is just a visibility toggle.
function openLogSearch(): void {
  showLogSearch.value = true
}

function closeLogSearch(): void {
  showLogSearch.value = false
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    direction="rtl"
    :size="width"
    resizable
    :with-header="false"
    class="tasks-drawer"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @opened="onDrawerOpened"
    @resize-end="onResizeEnd"
  >
    <div class="tasks-shell">
      <!-- Top header bar — kept visually consistent with the app title bar
           (shared $titlebar-h + --bg-titlebar token). `no-drag` so the area
           that overlaps the OS title-bar strip stays clickable. -->
      <header class="tasks-header">
        <div class="tasks-header-brand">
          <span class="tasks-header-icon"><Activity :size="15" /></span>
          <div>
            <div class="tasks-header-title">任务控制</div>
            <div class="tasks-header-subtitle">
              {{ tasks.length }} 个任务 · {{ runningTaskCount }} 个运行中
            </div>
          </div>
        </div>
        <div class="tasks-header-ops">
          <button class="hdr-btn" title="关闭" @click="emit('update:modelValue', false)">
            <X :size="15" />
          </button>
        </div>
      </header>

      <div class="tasks-layout">
        <!-- Left: task list -->
        <aside class="tasks-side">
          <div class="task-list">
            <div v-if="!tasks.length" class="task-empty">
              还没有命令，打开任意面板的命令选择器新建
            </div>
            <template v-for="g in taskGroups" :key="g.key">
              <!-- 分组头:只展示尾段文件夹名;hover 看完整路径。可折叠/展开。 -->
              <div class="task-group-head" :title="g.fullPath" @click="toggleGroup(g)">
                <component
                  :is="isGroupCollapsed(g) ? ChevronRight : ChevronDown"
                  :size="12"
                  class="task-group-caret"
                />
                <FolderOpen :size="12" class="task-group-folder" />
                <span class="task-group-name">{{ g.display }}</span>
                <span class="task-group-count">{{ g.tasks.length }}</span>
              </div>
              <template v-if="!isGroupCollapsed(g)">
                <div
                  v-for="t in g.tasks"
                  :key="t.id"
                  class="task-row"
                  :class="{ active: t.id === selectedId }"
                  @click="selectAndBind(t.id)"
                >
                  <span class="status-dot" :class="t.status" :title="statusText[t.status]" />
                  <div class="task-meta">
                    <div class="task-name">{{ t.name }}</div>
                    <div class="task-cmd">{{ t.command }}</div>
                  </div>
                  <div class="task-ops" @click.stop>
                    <button
                      class="op-btn"
                      :class="t.status === 'running' ? 'stop' : 'run'"
                      :title="t.status === 'running' ? '停止' : '运行'"
                      @click="toggleTask(t)"
                    >
                      <Square v-if="t.status === 'running'" :size="13" />
                      <Play v-else :size="13" />
                    </button>
                    <button
                      v-if="t.status === 'running'"
                      class="op-btn run"
                      title="重新运行"
                      @click="restartTask(t)"
                    >
                      <RotateCw :size="13" />
                    </button>
                    <button class="op-btn edit" title="编辑" @click="editTask(t)">
                      <Pencil :size="13" />
                    </button>
                    <button class="op-btn danger" title="删除" @click="removeTask(t)">
                      <Trash2 :size="13" />
                    </button>
                  </div>
                </div>
              </template>
            </template>
          </div>
        </aside>

        <!-- Right: log viewer -->
        <section class="tasks-log">
          <div class="log-head">
            <TerminalIcon :size="14" class="log-head-icon" />
            <span class="log-head-title">
              {{ selectedTask ? selectedTask.name : '选择任务查看日志' }}
            </span>
            <span v-if="selectedTask" class="log-head-status" :class="selectedTask.status">
              {{ statusText[selectedTask.status]
              }}{{
                selectedTask.status === 'failed' && selectedTask.exitCode !== null
                  ? ` (${selectedTask.exitCode})`
                  : ''
              }}
            </span>
            <span
              v-if="selectedTask"
              class="log-head-cwd"
              :title="selectedTask.cwd || '未指定工作目录'"
            >
              <FolderOpen :size="12" class="log-head-cwd-icon" />
              <span class="log-head-cwd-text"
                ><bdi>{{ selectedTask.cwd || '未指定工作目录' }}</bdi></span
              >
            </span>
            <div class="log-head-ops">
              <button class="op-btn" title="搜索" @click="openLogSearch">
                <Search :size="13" />
              </button>
              <button class="op-btn" title="清空显示" @click="clearLog">清空</button>
            </div>
          </div>
          <div class="log-wrap">
            <div v-if="showLogSearch && searchAddon" class="log-search-pos">
              <SearchOverlay
                :search-addon="searchAddon"
                :result-limit="200"
                @close="closeLogSearch"
              />
            </div>
            <div ref="logRef" class="log-body" @click="focusTerm"></div>
          </div>
        </section>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped lang="scss">
.tasks-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  @include ui-font;
  /* The drawer overlaps the OS title-bar strip; without no-drag the buttons
     under that strip get hijacked by the window-drag region. */
  -webkit-app-region: no-drag;
}

/* The task control header is deliberately taller than the app chrome so the
   drawer reads as a focused operational surface instead of another toolbar. */
.tasks-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 52px;
  flex-shrink: 0;
  padding: 0 10px 0 14px;
  background: var(--el-bg-color-page);
  border-bottom: 1px solid var(--el-border-color);
  user-select: none;
  -webkit-app-region: drag;
}

.tasks-header-brand {
  display: flex;
  align-items: center;
  gap: 9px;
}

.tasks-header-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid color-mix(in srgb, var(--el-color-success) 35%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--el-color-success) 10%, transparent);
  color: var(--el-color-success);
}

.tasks-header-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.tasks-header-subtitle {
  margin-top: 1px;
  color: var(--el-text-color-placeholder);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.tasks-header-ops {
  display: flex;
  gap: 2px;
}

.hdr-btn {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 22px;
  color: var(--el-text-color-secondary);
  border-radius: $radius;
  -webkit-app-region: no-drag;

  &:hover {
    background: color-mix(in srgb, var(--el-color-danger) 12%, transparent);
    color: var(--el-color-danger);
  }
}

.tasks-layout {
  flex: 1;
  min-height: 0;
  display: flex;
}

.tasks-side {
  width: 330px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color-page);
  border-right: 1px solid var(--el-border-color);
}

.task-list {
  flex: 1;
  overflow-y: auto;
  padding: 10px 8px;
}

.task-empty {
  color: var(--el-text-color-placeholder);
  font-size: 12px;
  text-align: center;
  padding: 24px 0;
}

.task-row {
  display: flex;
  align-items: center;
  gap: 8px;
  // 多一点左 padding,让 row 内容相对分组头的 caret + folder icon 有视觉缩进
  min-height: 48px;
  margin-bottom: 3px;
  padding: 7px 8px 7px 22px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--el-bg-color);
  cursor: pointer;

  &:hover {
    border-color: var(--el-border-color-dark);
    background: var(--el-bg-color-overlay);
  }

  &.active {
    border-color: color-mix(in srgb, var(--el-color-primary) 45%, transparent);
    background: color-mix(in srgb, var(--el-color-primary) 8%, var(--el-bg-color));
    box-shadow: inset 3px 0 0 var(--el-color-primary);
  }

  &:hover .task-ops,
  &.active .task-ops {
    opacity: 1;
  }
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--el-text-color-placeholder);

  &.running {
    background: var(--el-color-success);
    box-shadow: 0 0 4px color-mix(in srgb, var(--el-color-success) 53%, transparent);
  }

  &.failed {
    background: var(--el-color-danger);
  }

  &.exited {
    background: var(--el-text-color-placeholder);
  }
}

.task-meta {
  flex: 1;
  min-width: 0;
}

.task-name {
  font-size: 12.5px;
  color: var(--el-text-color-primary);
  @include ellipsis;
}

.task-cmd {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  @include ellipsis;
  @include mono-font;
}

/* 分组头:可点击折叠/展开。caret + folder icon + 尾段文件夹名 + 数量。
   完整 cwd 作 element title,用户 hover 看完整路径,平时只展示文件夹名。 */
.task-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 6px;
  margin-top: 5px;
  cursor: pointer;
  user-select: none;
  color: var(--el-text-color-secondary);
  font-size: 10px;
  font-weight: 700;

  &:first-child {
    margin-top: 0;
  }

  &:hover {
    color: var(--el-text-color-primary);
  }
}

.task-group-caret,
.task-group-folder {
  flex-shrink: 0;
}

.task-group-name {
  flex: 1;
  min-width: 0;
  @include mono-font;
  @include ellipsis;
}

.task-group-count {
  flex-shrink: 0;
  color: var(--el-text-color-placeholder);
}

.task-ops {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.1s;

  /* Keep row actions quiet until hover; semantic variants use tinted surfaces
     so four adjacent controls do not turn into a row of solid colour. */
  .op-btn {
    @include neutral-outlined-btn;

    &:hover {
      color: var(--el-text-color-primary);
    }

    &.run {
      border-color: color-mix(in srgb, var(--el-color-success) 24%, transparent);
      background: color-mix(in srgb, var(--el-color-success) 9%, transparent);
      color: var(--el-color-success);

      &:hover {
        border-color: color-mix(in srgb, var(--el-color-success) 42%, transparent);
        background: color-mix(in srgb, var(--el-color-success) 15%, transparent);
      }
    }

    &.stop,
    &.danger {
      border-color: color-mix(in srgb, var(--el-color-danger) 24%, transparent);
      background: color-mix(in srgb, var(--el-color-danger) 9%, transparent);
      color: var(--el-color-danger);

      &:hover {
        border-color: color-mix(in srgb, var(--el-color-danger) 42%, transparent);
        background: color-mix(in srgb, var(--el-color-danger) 15%, transparent);
      }
    }
  }
}

.op-btn {
  @include btn-reset;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 5px;
  color: var(--el-text-color-regular);
  border-radius: $radius-sm;
  font-size: 11px;

  &:hover {
    background: color-mix(in srgb, var(--el-text-color-primary) 10%, transparent);
    color: var(--el-text-color-primary);
  }

  &.danger:hover {
    background: color-mix(in srgb, var(--el-color-danger) 27%, transparent);
    color: var(--el-color-danger);
  }
}

.tasks-log {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
}

.log-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 46px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--el-border-color);
  background: var(--el-bg-color-page);
}

.log-head-icon {
  color: var(--el-text-color-secondary);
}

.log-head-title {
  font-size: 12.5px;
  color: var(--el-text-color-primary);
  flex-shrink: 0;
}

.log-head-status {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: $radius-sm;
  background: color-mix(in srgb, var(--el-text-color-placeholder) 20%, transparent);
  color: var(--el-text-color-secondary);

  &.running {
    background: color-mix(in srgb, var(--el-color-success) 13%, transparent);
    color: var(--el-color-success);
  }

  &.failed {
    background: color-mix(in srgb, var(--el-color-danger) 13%, transparent);
    color: var(--el-color-danger);
  }
}

.log-head-cwd {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  @include mono-font;
}

.log-head-cwd-icon {
  flex-shrink: 0;
}

// Left-truncate the path so the folder name (path tail) stays visible.
// See .task-cwd-text for the direction:rtl + bdi trick.
.log-head-cwd-text {
  flex: 1;
  min-width: 0;
  direction: rtl;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  > * {
    direction: ltr;
    unicode-bidi: bidi-override;
  }
}

.log-head-ops {
  margin-left: auto;
  display: flex;
  gap: 2px;
}

.log-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.log-body {
  flex: 1;
  min-height: 0;
  padding: 8px 10px;
}

.log-search-pos {
  position: absolute;
  top: 8px;
  right: 14px;
  z-index: 5;
}
</style>
