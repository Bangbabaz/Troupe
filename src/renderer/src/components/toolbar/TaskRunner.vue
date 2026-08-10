<script setup lang="ts">
import { computed, watch } from 'vue'
import { ChevronsUpDown, Play, RotateCw, Square, Plus, Settings2 } from 'lucide-vue-next'
import { taskDirectoryKey, useTasks } from '../../composables/useTasks'
import type { TaskMeta } from '@shared/types'

// 工具栏的命令运行入口。**不依赖 git** —— 任何 cwd 都能用,所以本组件在
// PaneToolbar 里始终渲染(无论 isRepo)。
//
// 任务定义本身是全局的(跨所有 cwd 的命令都在同一份 allTasks 里),但本组件只
// 展示和控制当前 pane cwd 下的命令。"npm run dev in folder A" 和 "in folder B"
// 各自独立。
//
// 任务数据来自 useTasks() 的全局单例，但选择按 paneId 隔离并持久化。工具栏选择
// 仍会同步给 TasksDrawer 作为当前查看项，不会反向覆盖其他 pane。

const props = defineProps<{
  paneId: string
  cwd: string
}>()

const emit = defineEmits<{
  /** cwd 默认 = 当前 pane;newDraft 表示"为此文件夹新建命令"快捷入口。 */
  manageTasks: [cwd?: string, newDraft?: boolean]
}>()

const { allTasks, paneSelectedIds, paneDirectorySelectedIds, selectPaneTask } = useTasks()

const normPath = (p: string | undefined): string => {
  if (!p) return ''
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(s)) s = s.toLowerCase()
  return s
}
const samePath = (a: string | undefined, b: string | undefined): boolean => {
  const na = normPath(a)
  return na !== '' && na === normPath(b)
}

const paneTasks = computed(() =>
  props.cwd ? allTasks.value.filter((t) => samePath(t.cwd, props.cwd)) : []
)
const selectedId = computed(() => {
  const directory = taskDirectoryKey(props.cwd)
  return (
    paneDirectorySelectedIds.value[props.paneId]?.[directory] ??
    paneSelectedIds.value[props.paneId] ??
    null
  )
})
const selectedTask = computed<TaskMeta | null>(
  () => paneTasks.value.find((t) => t.id === selectedId.value) || null
)
const runningTasks = computed(() => paneTasks.value.filter((t) => t.status === 'running'))

// cwd 变化时恢复该目录上次选择；第一次进入目录则激活第一条命令。
// 同时把旧版仅按 pane 保存的选择迁移到当前目录。
watch(
  paneTasks,
  (tasks) => {
    const directory = taskDirectoryKey(props.cwd)
    const directorySelectedId = paneDirectorySelectedIds.value[props.paneId]?.[directory]
    const activeId = tasks.some((task) => task.id === selectedId.value)
      ? selectedId.value
      : (tasks[0]?.id ?? null)
    if (activeId !== selectedId.value || directorySelectedId !== activeId) {
      selectPaneTask(props.paneId, props.cwd, activeId)
    }
  },
  { immediate: true }
)

const onPickCommand = (id: string | null): void => selectPaneTask(props.paneId, props.cwd, id)

const runSelected = async (): Promise<void> => {
  if (selectedTask.value) await window.api.taskStart({ id: selectedTask.value.id })
}

const stopTask = async (id: string): Promise<void> => {
  await window.api.taskStop(id)
}
</script>

<template>
  <el-select
    :model-value="selectedTask?.id ?? null"
    class="toolbar-select task-select"
    popper-class="task-pick-dropdown"
    size="small"
    placeholder="选择命令"
    :suffix-icon="ChevronsUpDown"
    @update:model-value="onPickCommand"
  >
    <template #prefix>
      <span class="status-dot" :class="selectedTask?.status || 'none'" />
    </template>
    <el-option v-for="t in paneTasks" :key="t.id" :value="t.id" :label="t.name || t.command">
      <span class="task-option">
        <span class="status-dot" :class="t.status" />
        <span class="task-option-label">{{ t.name || t.command }}</span>
      </span>
    </el-option>
    <template #empty>
      <div class="task-select-empty">该文件夹暂无命令</div>
    </template>
    <template #footer>
      <button class="task-select-action" @click.stop="emit('manageTasks', props.cwd, true)">
        <Plus :size="13" />
        新建命令
      </button>
      <button class="task-select-action" @click.stop="emit('manageTasks', props.cwd)">
        <Settings2 :size="13" />
        管理命令
      </button>
    </template>
  </el-select>

  <el-tooltip
    v-if="selectedTask"
    :content="
      selectedTask.status === 'running' ? `重启:${selectedTask.name}` : `运行:${selectedTask.name}`
    "
    placement="bottom"
    :show-after="300"
  >
    <button class="run-btn" @click="runSelected">
      <RotateCw v-if="selectedTask.status === 'running'" :size="13" />
      <Play v-else :size="13" />
    </button>
  </el-tooltip>

  <el-tooltip
    v-if="runningTasks.length === 1"
    :content="`停止:${runningTasks[0].name}`"
    placement="bottom"
    :show-after="300"
  >
    <button class="run-btn stop" @click="stopTask(runningTasks[0].id)">
      <Square :size="12" />
    </button>
  </el-tooltip>
  <el-dropdown
    v-else-if="runningTasks.length > 1"
    trigger="click"
    placement="bottom-start"
    popper-class="task-pick-dropdown"
    @command="stopTask"
  >
    <button class="run-btn stop" title="停止运行中的命令">
      <Square :size="12" />
    </button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item v-for="t in runningTasks" :key="t.id" :command="t.id">
          <span class="status-dot running" />
          <span class="td-label">{{ t.name || t.command }}</span>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style scoped lang="scss" src="@renderer/assets/style/components/toolbar/TaskRunner.scss"></style>
