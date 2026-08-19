<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Bot,
  Ellipsis,
  File,
  FileDiff,
  Folder,
  FolderGit2,
  GitBranchPlus,
  GitMerge,
  Globe,
  GripVertical,
  History,
  Play,
  Plus,
  RotateCw,
  Server,
  Settings2,
  Square
} from 'lucide-vue-next'
import BranchSelector from './toolbar/BranchSelector.vue'
import WorktreePanel from './toolbar/WorktreePanel.vue'
import GitOpsButtons from './toolbar/GitOpsButtons.vue'
import DiffStatsButton from './toolbar/DiffStatsButton.vue'
import TaskRunner from './toolbar/TaskRunner.vue'
import IdeLauncher from './toolbar/IdeLauncher.vue'
import { useTasks } from '../composables/useTasks'
import type { BranchInfo, DiffStats, MergeStatus, TaskMeta } from '@shared/types'

// 工具栏协调器。集中管理 git 状态(branches / currentBranch / diffStats /
// mergeStatus),通过 props 下发到子组件;子组件触发 git 操作后 emit('changed'),
// 由本组件统一刷新。
//
// 改造关键点:
//   1. 非 git 目录也渲染工具栏 —— 仅隐藏 BranchSelector 与 git 菜单项。
//   2. refresh() 节流:Terminal focus 频繁触发,200ms 内合并多次。
//   3. 快速刷新只查分支头 / diff / 冲突；完整刷新才重扫分支列表。

type WorktreePlacement = 'top' | 'bottom' | 'left' | 'right'

const props = defineProps<{
  paneId: string
  cwd: string | undefined
  isRemote?: boolean
  remoteLabel?: string
  sidecarOpen?: boolean
  activeTool?: 'files' | 'file' | 'browser'
}>()

const emit = defineEmits<{
  worktreeCreated: [path: string, placement: WorktreePlacement]
  manageTasks: [cwd?: string, newDraft?: boolean]
  toggleAgentSessions: []
  toggleFiles: []
  toggleBrowser: []
  paneDragStart: []
}>()

// --- Git 状态(从 IPC 拉取的快照,下发给 BranchSelector / WorktreePanel /
//     GitOpsButtons)----------------------------------------------------------
const isRepo = ref(false)
const currentBranch = ref<string | null>(null)
const branches = ref<BranchInfo[]>([])
const diffStats = ref<DiffStats>({ files: 0, added: 0, deleted: 0 })
const mergeStatus = ref<MergeStatus | null>(null)
const { allTasks, selectPaneTask } = useTasks()

const locationName = computed(() => {
  const normalized = (props.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.split('/').filter(Boolean).pop() || 'Terminal'
})

function normalizedPath(path: string | undefined): string {
  if (!path) return ''
  let normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(normalized)) normalized = normalized.toLowerCase()
  return normalized
}

const paneTasks = computed(() => {
  if (props.isRemote) return []
  const cwd = normalizedPath(props.cwd)
  if (!cwd) return []
  return allTasks.value.filter((task) => normalizedPath(task.cwd) === cwd)
})

const runningTasks = computed(() => paneTasks.value.filter((task) => task.status === 'running'))
const mergeStateActive = computed(
  () =>
    !!mergeStatus.value &&
    (!!mergeStatus.value.inProgress || mergeStatus.value.conflicts.length > 0)
)
// switching / 乐观分支显示都留在 BranchSelector 内部 —— 父级不需要参与切换流程,
// 切完只关心 refresh,通过子级 emit('changed') 触发。

// 各字段独立 generation：快速刷新不会取消仍在进行的分支列表刷新，而同一字段
// 的旧请求又不会覆盖新结果。
let infoGen = 0
let branchesGen = 0
let statsGen = 0
let mergeGen = 0

// 200ms throttle:窗口 / focus / cwd 变化连续触发时合并。第一次立即跑,后续 200ms
// 内合并到一次,最末状态最准。
let throttleTimer: ReturnType<typeof setTimeout> | null = null
let throttlePending = false
let pendingMode: 'fast' | 'full' = 'fast'
let lastRunAt = 0
const THROTTLE_MS = 200

const refresh = async (mode: 'fast' | 'full' = 'full'): Promise<void> => {
  if (!props.cwd) return
  if (props.isRemote) {
    isRepo.value = false
    currentBranch.value = null
    branches.value = []
    mergeStatus.value = null
    diffStats.value = { files: 0, added: 0, deleted: 0 }
    return
  }
  const cwd = props.cwd
  const myInfoGen = ++infoGen
  try {
    const info = await window.api.getGitInfo(cwd)
    if (myInfoGen !== infoGen || cwd !== props.cwd) return
    if (!info.isRepo) {
      isRepo.value = false
      currentBranch.value = null
      branches.value = []
      mergeStatus.value = null
      diffStats.value = { files: 0, added: 0, deleted: 0 }
      return
    }
    // 当前分支先落 UI，不再等待 diff / merge / branches 全部完成。
    isRepo.value = true
    currentBranch.value = info.branch

    const myStatsGen = ++statsGen
    const myMergeGen = ++mergeGen
    const jobs: Promise<void>[] = [
      window.api.getGitDiffStats(cwd).then((stats) => {
        if (myStatsGen === statsGen && cwd === props.cwd) diffStats.value = stats
      }),
      window.api.gitMergeStatus(cwd).then((merge) => {
        if (myMergeGen === mergeGen && cwd === props.cwd) mergeStatus.value = merge
      })
    ]

    if (mode === 'full') {
      const myBranchesGen = ++branchesGen
      jobs.push(
        window.api.getGitBranches(cwd).then((list) => {
          if (myBranchesGen === branchesGen && cwd === props.cwd) branches.value = list
        })
      )
    }
    await Promise.allSettled(jobs)
  } catch {
    if (myInfoGen !== infoGen || cwd !== props.cwd) return
    isRepo.value = false
    currentBranch.value = null
    branches.value = []
    mergeStatus.value = null
  }
}

const requestRefresh = (mode: 'fast' | 'full' = 'full'): void => {
  const now = Date.now()
  const elapsed = now - lastRunAt
  if (elapsed >= THROTTLE_MS) {
    lastRunAt = now
    void refresh(mode)
    return
  }
  // 已经在节流窗口内:挂起一次尾随调用,确保最末状态最终落地。
  if (throttlePending) {
    if (mode === 'full') pendingMode = 'full'
    return
  }
  throttlePending = true
  pendingMode = mode
  if (throttleTimer) clearTimeout(throttleTimer)
  throttleTimer = setTimeout(() => {
    throttlePending = false
    throttleTimer = null
    lastRunAt = Date.now()
    const modeToRun = pendingMode
    pendingMode = 'fast'
    void refresh(modeToRun)
  }, THROTTLE_MS - elapsed)
}

const requestFastRefresh = (): void => requestRefresh('fast')

// cwd 改变(用户 cd 或者新建 worktree pane)→ 立即触发一次新状态拉取。
// 通过 requestRefresh 走节流,但 cwd 变化频率不高,实际上等价于立即 refresh。
watch(
  () => [props.cwd, props.isRemote],
  () => requestRefresh(),
  { immediate: true }
)

defineExpose({ refresh: requestRefresh, refreshFast: requestFastRefresh })

// --- Worktree dialog 入口 -----------------------------------------------
// BranchSelector 右键"新工作树"→ 父级转发到 WorktreePanel.openWorktreeDialog。
const worktreePanelRef = ref<InstanceType<typeof WorktreePanel>>()
const gitOpsRef = ref<InstanceType<typeof GitOpsButtons>>()
const diffStatsRef = ref<InstanceType<typeof DiffStatsButton>>()

function onWorktreeFromBranch(prefill: string): void {
  worktreePanelRef.value?.openWorktreeDialog(prefill)
}

function onWorktreeCreated(path: string, placement: WorktreePlacement): void {
  emit('worktreeCreated', path, placement)
}

async function onConflictDetected(): Promise<void> {
  await refresh('fast')
  gitOpsRef.value?.openMergePanel()
}

async function runTask(task: TaskMeta): Promise<void> {
  if (!props.cwd) return
  selectPaneTask(props.paneId, props.cwd, task.id)
  await window.api.taskStart({ id: task.id })
}

async function stopTask(task: TaskMeta): Promise<void> {
  await window.api.taskStop(task.id)
}

async function onToolMenuCommand(command: string): Promise<void> {
  if (command === 'browser') return emit('toggleBrowser')
  if (command === 'agent') return emit('toggleAgentSessions')
  if (command === 'worktree:new') return worktreePanelRef.value?.openWorktreeDialog()
  if (command === 'worktree:manage') return worktreePanelRef.value?.openWtManage()
  if (command === 'git:history') return gitOpsRef.value?.openLogPanel()
  if (command === 'git:merge') return gitOpsRef.value?.openMergePanel()
  if (command === 'git:diff') return diffStatsRef.value?.openDiff()
  if (command === 'task:new') return emit('manageTasks', props.cwd, true)
  if (command === 'task:manage') return emit('manageTasks', props.cwd)

  const runPrefix = 'task:run:'
  const stopPrefix = 'task:stop:'
  if (command.startsWith(runPrefix)) {
    const task = paneTasks.value.find(
      (candidate) => candidate.id === command.slice(runPrefix.length)
    )
    if (task) await runTask(task)
  } else if (command.startsWith(stopPrefix)) {
    const task = runningTasks.value.find(
      (candidate) => candidate.id === command.slice(stopPrefix.length)
    )
    if (task) await stopTask(task)
  }
}
</script>

<template>
  <!-- 工具栏 v-if 仅在 cwd 已知时渲染;非 git 目录也保留文件、工具菜单与 IDE。 -->
  <div
    v-if="props.cwd"
    class="pane-toolbar"
    :class="{ 'is-repo': isRepo, 'is-remote': props.isRemote }"
    @click.stop
  >
    <div class="pane-identity">
      <button
        class="pane-drag-handle"
        title="拖拽以重排面板"
        @mousedown.left.prevent.stop="emit('paneDragStart')"
      >
        <GripVertical :size="13" />
      </button>
      <div class="pane-location" :title="props.cwd">
        <Folder :size="13" class="pane-location-icon" />
        <span class="pane-location-name">{{ locationName }}</span>
      </div>
    </div>

    <div v-if="isRepo" class="pane-toolbar-section pane-git-section">
      <BranchSelector
        :cwd="props.cwd"
        :branches="branches"
        :current-branch="currentBranch"
        @changed="requestRefresh"
        @refresh-branches="requestRefresh"
        @worktree-from-branch="onWorktreeFromBranch"
        @conflict-detected="onConflictDetected"
      />
      <div class="pane-git-overflow-tools">
        <WorktreePanel
          ref="worktreePanelRef"
          :cwd="props.cwd"
          :branches="branches"
          :current-branch="currentBranch"
          @worktree-created="onWorktreeCreated"
          @changed="requestRefresh"
        />
        <GitOpsButtons
          ref="gitOpsRef"
          :cwd="props.cwd"
          :merge-status="mergeStatus"
          @changed="requestRefresh"
        />
      </div>
      <div class="pane-diff-tool">
        <DiffStatsButton ref="diffStatsRef" :cwd="props.cwd" :diff-stats="diffStats" />
      </div>
    </div>

    <div v-if="props.isRemote" class="remote-badge" :title="props.remoteLabel || 'SSH'">
      <Server :size="12" />
      <span>{{ props.remoteLabel || 'SSH' }}</span>
    </div>

    <div v-if="!props.isRemote" class="pane-toolbar-section pane-task-section">
      <TaskRunner
        :pane-id="props.paneId"
        :cwd="props.cwd"
        @manage-tasks="(cwd?: string, nd?: boolean) => emit('manageTasks', cwd, nd)"
      />
    </div>

    <div class="pane-toolbar-spacer" />

    <div class="pane-toolbar-section pane-action-section">
      <button
        v-if="!props.isRemote"
        class="files-btn"
        :class="{ 'is-active': props.sidecarOpen && props.activeTool !== 'browser' }"
        title="文件"
        aria-label="文件"
        @click="emit('toggleFiles')"
      >
        <File :size="14" />
      </button>

      <button
        class="browser-btn"
        :class="{ 'is-active': props.sidecarOpen && props.activeTool === 'browser' }"
        title="内置浏览器"
        aria-label="内置浏览器"
        @click="emit('toggleBrowser')"
      >
        <Globe :size="14" />
      </button>
      <button
        class="session-btn"
        title="Agent 会话"
        aria-label="Agent 会话"
        @click="emit('toggleAgentSessions')"
      >
        <Bot :size="14" />
      </button>

      <el-dropdown
        class="pane-more-menu"
        trigger="click"
        placement="bottom-end"
        popper-class="pane-tools-dropdown"
        @command="onToolMenuCommand"
      >
        <button
          class="more-btn"
          :class="{
            'is-active': props.sidecarOpen && props.activeTool === 'browser',
            'has-running-task': runningTasks.length > 0,
            'has-warning': mergeStateActive
          }"
          title="更多工具"
          aria-label="更多工具"
        >
          <Ellipsis :size="15" />
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="browser">
              <Globe :size="13" />
              <span class="pane-tool-menu-label">内置浏览器</span>
            </el-dropdown-item>
            <el-dropdown-item command="agent">
              <Bot :size="13" />
              <span class="pane-tool-menu-label">Agent 会话</span>
            </el-dropdown-item>

            <template v-if="isRepo">
              <el-dropdown-item divided command="worktree:new">
                <GitBranchPlus :size="13" />
                <span class="pane-tool-menu-label">新建工作树</span>
              </el-dropdown-item>
              <el-dropdown-item command="worktree:manage">
                <FolderGit2 :size="13" />
                <span class="pane-tool-menu-label">管理工作树</span>
              </el-dropdown-item>
              <el-dropdown-item command="git:history">
                <History :size="13" />
                <span class="pane-tool-menu-label">提交历史</span>
              </el-dropdown-item>
              <el-dropdown-item v-if="mergeStateActive" command="git:merge">
                <GitMerge :size="13" />
                <span class="pane-tool-menu-label is-danger">
                  合并 / 冲突 ({{ mergeStatus?.conflicts.length || 0 }})
                </span>
              </el-dropdown-item>
              <el-dropdown-item v-if="diffStats.files" command="git:diff">
                <FileDiff :size="13" />
                <span class="pane-tool-menu-label">
                  改动 +{{ diffStats.added }} -{{ diffStats.deleted }}
                </span>
              </el-dropdown-item>
            </template>

            <template v-if="!props.isRemote">
              <el-dropdown-item divided disabled class="pane-tool-menu-heading">
                运行命令
              </el-dropdown-item>
              <el-dropdown-item v-if="!paneTasks.length" disabled>
                该文件夹暂无命令
              </el-dropdown-item>
              <el-dropdown-item
                v-for="task in paneTasks"
                :key="`run:${task.id}`"
                :command="`task:run:${task.id}`"
              >
                <RotateCw v-if="task.status === 'running'" :size="13" />
                <Play v-else :size="13" />
                <span class="pane-tool-menu-label">{{ task.name || task.command }}</span>
                <span class="pane-tool-task-status" :class="task.status" />
              </el-dropdown-item>
              <el-dropdown-item
                v-for="task in runningTasks"
                :key="`stop:${task.id}`"
                :command="`task:stop:${task.id}`"
              >
                <Square :size="12" class="pane-tool-stop-icon" />
                <span class="pane-tool-menu-label">停止 {{ task.name || task.command }}</span>
              </el-dropdown-item>
              <el-dropdown-item divided command="task:new">
                <Plus :size="13" />
                <span class="pane-tool-menu-label">新建命令</span>
              </el-dropdown-item>
              <el-dropdown-item command="task:manage">
                <Settings2 :size="13" />
                <span class="pane-tool-menu-label">管理命令</span>
              </el-dropdown-item>
            </template>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <IdeLauncher v-if="!props.isRemote" :pane-id="props.paneId" :cwd="props.cwd" />
    </div>
  </div>
</template>

<style scoped lang="scss" src="@renderer/assets/style/components/PaneToolbar.scss"></style>
