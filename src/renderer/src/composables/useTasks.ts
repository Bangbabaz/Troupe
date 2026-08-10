import { ref, computed, watch, type Ref, type ComputedRef } from 'vue'
import type { TaskMeta } from '@shared/types'

// 全局后台任务列表 + 分层选中状态。任务数据跨所有 pane 共享；TasksDrawer 使用
// 一个全局查看项，各 TaskRunner 则按 paneId 保存自己的选择。
//
// 改造前每个 TaskRunner 各自 fetch + 维护 allTasks ref + 订阅 onTaskStatus /
// onTaskRemoved。N 个 pane 就触发 N 次 upsert + N 次响应式更新,task 状态变化
// 时整个 renderer 被重复广播打到。这里集中到模块级单例:
//
//   - allTasks   单例 ref,所有消费者订阅同一引用 (Vue reactive 共享 → 一次更新
//                自动驱动所有依赖它的组件)
//   - selectedId 单例 ref,仅表示 TasksDrawer 当前查看的任务
//   - paneSelectedIds 按 paneId 保存每个 TaskRunner 的独立选择，并持久化到 settings
//   - init()     幂等,第一次调用时 subscribe + fetch,后续调用复用同一 promise
//   - 消费者     `const { allTasks, selectedId } = useTasks()`,无需关心订阅生命周期
//
// 为什么用 taskSubscribe 而不是 taskList:main 端 broadcast (`task-status` /
// `task-removed`) 只发给已 register 的 webContents (subscribers Set)。本 renderer
// 不调 taskSubscribe 一次,所有 onTaskStatus listener 都收不到事件。原来这步
// 由 TasksDrawer 兼任 — 现在抽出来,即使 TasksDrawer 还没 mount,TaskRunner 也
// 能正常收到事件。
//
// 注:onTaskData / onTaskCleared 这两个流事件是 TasksDrawer 的 log viewer 私有
// 关心点(逐字 chunk 写 xterm),不在这里管理。

const allTasks = ref<TaskMeta[]>([])
const selectedId = ref<string | null>(null)
const paneSelectedIds = ref<Record<string, string>>({})
const paneDirectorySelectedIds = ref<Record<string, Record<string, string>>>({})

export function taskDirectoryKey(path: string | undefined): string {
  if (!path) return ''
  let normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(normalized)) normalized = normalized.toLowerCase()
  return normalized
}

// 当已选中的任务从全局列表消失(被删除)时,自动清空选中。
// 放在模块顶层 —— 只注册一次,不需等 init()。
watch(allTasks, (tasks) => {
  if (selectedId.value && !tasks.some((t) => t.id === selectedId.value)) {
    selectedId.value = null
  }
  const validIds = new Set(tasks.map((task) => task.id))
  const next = Object.fromEntries(
    Object.entries(paneSelectedIds.value).filter(([, taskId]) => validIds.has(taskId))
  )
  if (Object.keys(next).length !== Object.keys(paneSelectedIds.value).length) {
    paneSelectedIds.value = next
    window.api.settingsSet({ paneSelectedTaskIds: next })
  }

  let directorySelectionsChanged = false
  const nextDirectorySelections: Record<string, Record<string, string>> = {}
  for (const [paneId, selections] of Object.entries(paneDirectorySelectedIds.value)) {
    const validSelections = Object.fromEntries(
      Object.entries(selections).filter(([, taskId]) => validIds.has(taskId))
    )
    if (Object.keys(validSelections).length) nextDirectorySelections[paneId] = validSelections
    if (Object.keys(validSelections).length !== Object.keys(selections).length) {
      directorySelectionsChanged = true
    }
  }
  if (directorySelectionsChanged) {
    paneDirectorySelectedIds.value = nextDirectorySelections
    window.api.settingsSet({ paneDirectorySelectedTaskIds: nextDirectorySelections })
  }
})

let initPromise: Promise<void> | null = null

function upsertTask(m: TaskMeta): void {
  const i = allTasks.value.findIndex((t) => t.id === m.id)
  if (i >= 0) allTasks.value[i] = m
  else allTasks.value.push(m)
}

function init(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    // taskSubscribe 同步在 main 端把 webContents 加入 subscribers Set,并返回当前
    // 列表;之后的 task-status / task-removed 广播才会发到本 renderer。
    const [tasks, settings] = await Promise.all([
      window.api.taskSubscribe(),
      window.api.settingsGet()
    ])
    paneSelectedIds.value = { ...(settings.paneSelectedTaskIds ?? {}) }
    paneDirectorySelectedIds.value = { ...(settings.paneDirectorySelectedTaskIds ?? {}) }
    allTasks.value = tasks
    window.api.onTaskStatus(upsertTask)
    window.api.onTaskRemoved(({ id }) => {
      allTasks.value = allTasks.value.filter((t) => t.id !== id)
    })
    // 不保存 unsubscribe 句柄:整个 app 生命周期都需要这两个 listener,renderer
    // 退出时 ipcRenderer 自己清理。重复 init 由 initPromise 守护。
  })()
  return initPromise
}

function selectTask(id: string | null): void {
  selectedId.value = id
}

function selectPaneTask(paneId: string, cwd: string, id: string | null): void {
  const next = { ...paneSelectedIds.value }
  if (id) next[paneId] = id
  else delete next[paneId]
  paneSelectedIds.value = next

  const directory = taskDirectoryKey(cwd)
  const paneSelections = { ...(paneDirectorySelectedIds.value[paneId] ?? {}) }
  if (directory) {
    if (id) paneSelections[directory] = id
    else delete paneSelections[directory]
  }
  const nextDirectorySelections = { ...paneDirectorySelectedIds.value }
  if (Object.keys(paneSelections).length) nextDirectorySelections[paneId] = paneSelections
  else delete nextDirectorySelections[paneId]
  paneDirectorySelectedIds.value = nextDirectorySelections

  void window.api.settingsSetNow({
    paneSelectedTaskIds: next,
    paneDirectorySelectedTaskIds: nextDirectorySelections
  })
  // 工具栏选中的任务同时成为任务抽屉当前项，但不会影响其他 pane 的工具栏。
  selectedId.value = id
}

const selectedTask = computed<TaskMeta | null>(
  () => allTasks.value.find((t) => t.id === selectedId.value) ?? null
)

export interface UseTasksReturn {
  /** 共享的全局任务列表。所有消费者读同一引用。 */
  allTasks: Ref<TaskMeta[]>
  /** TasksDrawer 当前查看的任务 ID。TaskRunner 选择时会同步更新它。 */
  selectedId: Ref<string | null>
  /** 当前选中的 TaskMeta(从 allTasks + selectedId 派生)。 */
  selectedTask: ComputedRef<TaskMeta | null>
  /** 各 pane 独立的最后选择，key 为 paneId。 */
  paneSelectedIds: Ref<Record<string, string>>
  /** 各 pane 在不同工作目录下的最后选择。 */
  paneDirectorySelectedIds: Ref<Record<string, Record<string, string>>>
  /** 更新全局选中。可在任何组件内调用。 */
  selectTask: (id: string | null) => void
  /** 更新并持久化某个 pane 的任务选择。 */
  selectPaneTask: (paneId: string, cwd: string, id: string | null) => void
  /**
   * 首次 subscribe + fetch 完成的 promise。需要"已经拿到列表"再 select 的场景
   * (如 TasksDrawer 想自动定位某个 task)await 它。日常列表展示可以不 await,
   * 数据准备好后响应式会自动驱动 UI。
   */
  ready: Promise<void>
}

export function useTasks(): UseTasksReturn {
  return {
    allTasks,
    selectedId,
    selectedTask,
    paneSelectedIds,
    paneDirectorySelectedIds,
    selectTask,
    selectPaneTask,
    ready: init()
  }
}
